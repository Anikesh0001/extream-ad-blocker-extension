// Download filter lists, convert to MV3 DNR rulesets + cosmetic data, and wire them into
// the manifest. Run: node tools/build.mjs   (uses ./.cache for downloaded lists)
import { convertList } from "./convert.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CACHE = path.join(ROOT, ".cache");
const RULES = path.join(ROOT, "rules");
const COSMETIC = path.join(ROOT, "src", "cosmetic");
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(RULES, { recursive: true });
fs.mkdirSync(COSMETIC, { recursive: true });

// safe  = enabled in the manifest (must stay well under the 30k guaranteed static-rule budget)
// rec   = recommended default; the service worker enables these at runtime with budget checks
// cosmetic = contribute element-hiding selectors (bundled regardless of whether DNR is enabled)
const LISTS = [
  { id: "ads",        title: "EasyList — ads",              url: "https://easylist.to/easylist/easylist.txt",                 safe: false, rec: true,  cosmetic: true,  desc: "The core ad-blocking list." },
  { id: "privacy",    title: "EasyPrivacy — trackers",      url: "https://easylist.to/easylist/easyprivacy.txt",              safe: false, rec: true,  cosmetic: true,  desc: "Blocks tracking and analytics." },
  { id: "adguard",    title: "AdGuard Base",                url: "https://filters.adtidy.org/extension/chromium/filters/2.txt", safe: false, rec: false, cosmetic: true, desc: "Extra ad rules (overlaps EasyList)." },
  { id: "cookies",    title: "Cookie notices",              url: "https://secure.fanboy.co.nz/fanboy-cookiemonster.txt",      safe: true,  rec: true,  cosmetic: true,  desc: "Hides cookie-consent banners." },
  { id: "annoyances", title: "Annoyances — popups, widgets",url: "https://secure.fanboy.co.nz/fanboy-annoyance.txt",          safe: false, rec: false, cosmetic: true,  desc: "In-page popups, overlays, nags." },
  { id: "social",     title: "Social widgets",              url: "https://secure.fanboy.co.nz/fanboy-social.txt",             safe: false, rec: false, cosmetic: true,  desc: "Facebook/X/etc. share buttons." },
  { id: "badware",    title: "Badware & scam sites",        url: "https://ublockorigin.pages.dev/filters/badware.txt",        safe: true,  rec: true,  cosmetic: false, desc: "Known malware and scam hosts." },
  { id: "privacyubo", title: "uBlock — privacy",            url: "https://ublockorigin.pages.dev/filters/privacy.txt",        safe: true,  rec: true,  cosmetic: true,  desc: "Extra privacy protections." },
  { id: "resource",   title: "uBlock — resource abuse",     url: "https://ublockorigin.pages.dev/filters/resource-abuse.txt", safe: true,  rec: true,  cosmetic: false, desc: "Stops cryptominers & abuse." },
  { id: "anticv",     title: "Anti-adblock defuser",        url: "https://easylist-downloads.adblockplus.org/abp-filters-anti-cv.txt", safe: true, rec: true, cosmetic: true, desc: "Beats \"disable your ad blocker\" walls." },
  { id: "quickfixes", title: "uBlock — quick fixes",        url: "https://ublockorigin.pages.dev/filters/quick-fixes.txt",    safe: true,  rec: true,  cosmetic: true,  desc: "Fast site-breakage & anti-adblock fixes." },
  { id: "unbreak",    title: "uBlock — unbreak",            url: "https://ublockorigin.pages.dev/filters/unbreak.txt",        safe: true,  rec: true,  cosmetic: true,  desc: "Un-breaks sites over-blocked by filters." },
];

function fetchList(l) {
  const f = path.join(CACHE, l.id + ".txt");
  if (fs.existsSync(f) && fs.statSync(f).size > 1000 && !process.env.REFRESH) return fs.readFileSync(f, "utf8");
  process.stdout.write(`  downloading ${l.title} … `);
  try {
    execFileSync("curl", ["-sSL", "--max-time", "60", "-A", "Mozilla/5.0 AdSweep", "-o", f, l.url], { stdio: ["ignore", "ignore", "inherit"] });
    const t = fs.readFileSync(f, "utf8");
    console.log(`${(t.length / 1024 / 1024).toFixed(1)} MB`);
    return t;
  } catch (e) {
    console.log("FAILED (skipping)");
    return "";
  }
}

const genericSet = new Set();
const specific = {};   // hostname -> Set(selectors)
const unhide = {};      // hostname -> Set(selectors)
const scriptletMap = {}; // hostname -> [{t,a}]
const ruleResources = [];
const listMeta = [];
let totalRules = 0;

console.log("Building AdSweep rulesets:\n");
for (const l of LISTS) {
  const text = fetchList(l);
  if (!text) continue;
  // regexFilter uses RE2; EasyList regexes can use features RE2 rejects, which would void a
  // whole ruleset. Dropping them (a tiny minority) keeps every ruleset guaranteed-valid.
  const { dnr, cosmetic, scriptlets, stats } = convertList(text, { startId: 1, maxRegex: 0 });
  // DNR static ruleset: cap to keep well inside Chrome limits
  const capped = dnr.slice(0, 150000);
  fs.writeFileSync(path.join(RULES, l.id + ".json"), JSON.stringify(capped));
  ruleResources.push({ id: l.id, enabled: !!l.safe, path: `rules/${l.id}.json` });
  listMeta.push({ id: l.id, title: l.title, desc: l.desc, rec: !!l.rec, safe: !!l.safe, cosmetic: !!l.cosmetic, rules: capped.length, url: l.url });
  totalRules += l.rec ? capped.length : 0;

  if (l.cosmetic) {
    for (const s of cosmetic.generic) genericSet.add(s);
    for (const [host, sels] of Object.entries(cosmetic.specific)) {
      (specific[host] ||= new Set()); for (const s of sels) specific[host].add(s);
    }
    for (const [host, sels] of Object.entries(cosmetic.unhide)) {
      (unhide[host] ||= new Set()); for (const s of sels) unhide[host].add(s);
    }
  }
  // scriptlets from every list (independent of DNR enablement)
  for (const [host, arr] of Object.entries(scriptlets)) {
    (scriptletMap[host] ||= []).push(...arr);
  }
  console.log(`  ✓ ${l.title}: ${capped.length} net rules${l.rec ? " (on)" : " (off)"}, +${stats.generic} generic / ${stats.specificDomains} site cosmetic, ${stats.scriptlets} scriptlets/${stats.scriptletHosts} hosts, ${stats.skipped} skipped`);
}

// --- cosmetic output
// generic hiding stylesheet (one big rule), chunked to stay under selector-length limits
const genericArr = [...genericSet].filter((s) => s && s.length < 200);
const CHUNK = 4000;
let css = "";
for (let i = 0; i < genericArr.length; i += CHUNK) {
  css += genericArr.slice(i, i + CHUNK).join(",\n") + "{display:none!important}\n";
}
fs.writeFileSync(path.join(COSMETIC, "generic.css"), css);

const specificOut = {};
for (const [host, set] of Object.entries(specific)) specificOut[host] = [...set];
const unhideOut = {};
for (const [host, set] of Object.entries(unhide)) unhideOut[host] = [...set];
fs.writeFileSync(path.join(COSMETIC, "specific.json"), JSON.stringify(specificOut));
fs.writeFileSync(path.join(COSMETIC, "unhide.json"), JSON.stringify(unhideOut));

// dedupe scriptlets per host
const scriptletOut = {};
for (const [host, arr] of Object.entries(scriptletMap)) {
  const seen = new Set();
  scriptletOut[host] = arr.filter((s) => { const k = s.t + "|" + JSON.stringify(s.a); return seen.has(k) ? false : (seen.add(k), true); });
}
fs.writeFileSync(path.join(RULES, "scriptlets.json"), JSON.stringify(scriptletOut));

fs.writeFileSync(path.join(RULES, "lists.json"), JSON.stringify(listMeta, null, 2));
fs.writeFileSync(path.join(RULES, "_fragment.json"), JSON.stringify({ rule_resources: ruleResources }, null, 2));

console.log(`\nSummary:`);
console.log(`  ${ruleResources.length} rulesets, ${totalRules} rules in the recommended default set`);
console.log(`  manifest-enabled (safe core): ${ruleResources.filter(r => r.enabled).reduce((n, r) => n + (listMeta.find(m => m.id === r.id)?.rules || 0), 0)} rules`);
console.log(`  generic cosmetic selectors: ${genericArr.length} (${(css.length / 1024 / 1024).toFixed(2)} MB css)`);
console.log(`  site-specific cosmetic hosts: ${Object.keys(specificOut).length}`);
console.log(`  scriptlet hosts: ${Object.keys(scriptletOut).length}`);
console.log(`\nNow run: node tools/patch-manifest.mjs`);
