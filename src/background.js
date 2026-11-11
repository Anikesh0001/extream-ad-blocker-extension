// AdSweep service worker (MV3).
// - enables the recommended filter rulesets at runtime, within Chrome's static-rule budget
// - keeps a per-site allowlist via dynamic DNR allow rules
// - tracks blocked-request stats and drives the toolbar badge
// - answers cosmetic-filter lookups from content scripts

import { scriptletRunner } from "./scriptlets.js";
import { convertList } from "./converter.js";

const DNR = chrome.declarativeNetRequest;
const ALLOW_RULE_BASE = 1_000_000;   // dynamic allowlist rule ids
const CUSTOM_RULE_BASE = 2_000_000;  // custom user network rules
const SUB_RULE_BASE = 3_000_000;     // subscribed-list rules (base + index*100000)
const PARAM_RULE_BASE = 9_000_000;   // tracking-param stripping rules

// common tracking query params to strip when the user enables it
const TRACKING_PARAMS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id", "utm_name",
  "utm_reader", "utm_social", "utm_brand", "fbclid", "gclid", "gclsrc", "dclid", "wbraid", "gbraid",
  "msclkid", "mc_eid", "mc_cid", "yclid", "_openstat", "igshid", "twclid", "ttclid", "oly_anon_id",
  "oly_enc_id", "__s", "vero_id", "vero_conv", "spm", "scm", "ref_src", "ref_url", "fb_action_ids",
  "fb_action_types", "fb_ref", "fb_source", "s_cid", "mkt_tok", "pk_campaign", "pk_kwd", "piwik_campaign",
];

let listsMeta = null;        // from rules/lists.json
let specificCosmetic = null; // hostname -> [selectors]   (lazy)
let unhideCosmetic = null;   // hostname -> [selectors]   (lazy)
let scriptletData = null;    // hostname -> [{t,a}]       (lazy)
let customParsed = null;     // { net:[], cosmetic:{host:[]}, scriptlets:{host:[]}, allow:[] }

// ---------- storage helpers ----------
const store = {
  async get(def) {
    const d = await chrome.storage.local.get(["enabledLists", "allowlist", "stats", "paused", "cosmeticOn", "customFilters"]);
    return {
      enabledLists: d.enabledLists ?? null,
      allowlist: d.allowlist ?? {},
      stats: d.stats ?? { total: 0, today: 0, day: todayKey() },
      paused: d.paused ?? 0,
      cosmeticOn: d.cosmeticOn ?? true,
      customFilters: d.customFilters ?? "",
      ...def,
    };
  },
  set(obj) { return chrome.storage.local.set(obj); },
};

function todayKey() { return new Date().toISOString().slice(0, 10); }

async function loadLists() {
  if (listsMeta) return listsMeta;
  const res = await fetch(chrome.runtime.getURL("rules/lists.json"));
  listsMeta = await res.json();
  return listsMeta;
}

// ---------- ruleset enabling with budget awareness ----------
async function applyEnabledLists(desiredIds) {
  const meta = await loadLists();
  const byId = Object.fromEntries(meta.map((m) => [m.id, m]));
  const current = new Set(await DNR.getEnabledRulesets());
  const desired = desiredIds.filter((id) => byId[id]);

  // disable anything no longer wanted
  const toDisable = [...current].filter((id) => !desired.includes(id));
  if (toDisable.length) {
    try { await DNR.updateEnabledRulesets({ disableRulesetIds: toDisable }); } catch (e) {}
  }

  // enable desired, biggest last, stopping if we run out of budget
  const applied = [];
  const skipped = [];
  const ordered = desired.filter((id) => !current.has(id)).sort((a, b) => (byId[a].rules) - (byId[b].rules));
  for (const id of ordered) {
    try {
      const budget = await DNR.getAvailableStaticRuleCount();
      if (byId[id].rules > budget) { skipped.push(id); continue; }
      await DNR.updateEnabledRulesets({ enableRulesetIds: [id] });
      applied.push(id);
    } catch (e) {
      skipped.push(id);
    }
  }
  const finalEnabled = await DNR.getEnabledRulesets();
  await store.set({ enabledLists: desired, skippedLists: skipped });
  return { enabled: finalEnabled, skipped };
}

// ---------- allowlist (per-site disable) via dynamic allowAllRequests ----------
function domainRuleId(domain) {
  // stable-ish id from domain hash, offset into the dynamic range
  let h = 0;
  for (let i = 0; i < domain.length; i++) h = (h * 31 + domain.charCodeAt(i)) >>> 0;
  return ALLOW_RULE_BASE + (h % 900_000);
}

async function syncAllowlistRules() {
  const { allowlist } = await store.get();
  const domains = Object.keys(allowlist).filter((d) => allowlist[d]);
  const existing = await DNR.getDynamicRules();
  const removeIds = existing.map((r) => r.id);
  const addRules = domains.map((d) => ({
    id: domainRuleId(d),
    priority: 10000,
    action: { type: "allowAllRequests" },
    condition: { requestDomains: [d], resourceTypes: ["main_frame", "sub_frame"] },
  }));
  // de-dupe ids
  const seen = new Set();
  const unique = addRules.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  await DNR.updateDynamicRules({ removeRuleIds: removeIds, addRules: unique });
}

async function setSiteAllowed(domain, allowed) {
  const { allowlist } = await store.get();
  if (allowed) allowlist[domain] = true; else delete allowlist[domain];
  await store.set({ allowlist });
  await syncAllowlistRules();
}

async function isAllowed(host) {
  const { allowlist, paused } = await store.get();
  if (paused && Date.now() < paused) return true;
  if (!host) return false;
  // match host or any parent domain
  const parts = host.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const d = parts.slice(i).join(".");
    if (allowlist[d]) return true;
  }
  return false;
}

// ---------- cosmetic lookup ----------
async function loadCosmetic() {
  if (specificCosmetic) return;
  const [s, u] = await Promise.all([
    fetch(chrome.runtime.getURL("src/cosmetic/specific.json")).then((r) => r.json()),
    fetch(chrome.runtime.getURL("src/cosmetic/unhide.json")).then((r) => r.json()),
  ]);
  specificCosmetic = s;
  unhideCosmetic = u;
}

async function cosmeticFor(host) {
  const { cosmeticOn } = await store.get();
  if (!cosmeticOn || await isAllowed(host)) return { enabled: false, generic: false, selectors: [] };
  await loadCosmetic();
  await ensureCustom();
  await loadSubData();
  const selectors = new Set();
  const unhide = new Set();
  for (const d of hostChain(host)) {
    (specificCosmetic[d] || []).forEach((s) => selectors.add(s));
    (unhideCosmetic[d] || []).forEach((s) => unhide.add(s));
    (customParsed.cosmetic[d] || []).forEach((s) => selectors.add(s));
    (subCosmetic[d] || []).forEach((s) => selectors.add(s));
  }
  (customParsed.cosmetic["*"] || []).forEach((s) => selectors.add(s));
  for (const u of unhide) selectors.delete(u);
  return { enabled: true, generic: true, selectors: [...selectors] };
}

// ---------- scriptlets (anti-adblock / ad neutralizers) ----------
async function loadScriptlets() {
  if (scriptletData) return;
  try { scriptletData = await fetch(chrome.runtime.getURL("rules/scriptlets.json")).then((r) => r.json()); }
  catch (e) { scriptletData = {}; }
}

function hostChain(host) {
  const parts = host.split(".");
  const out = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join("."));
  return out;
}

async function scriptletsFor(host) {
  await loadScriptlets();
  await ensureCustom();
  await loadSubData();
  const reqs = [];
  const seen = new Set();
  const push = (s) => { const k = s.t + "|" + JSON.stringify(s.a); if (!seen.has(k)) { seen.add(k); reqs.push(s); } };
  for (const d of hostChain(host)) {
    (scriptletData[d] || []).forEach(push);
    (customParsed.scriptlets[d] || []).forEach(push);
    (subScriptlets[d] || []).forEach(push);
  }
  return reqs;
}

async function injectScriptlets(tabId, frameId, url) {
  let host;
  try { host = new URL(url).hostname; } catch { return; }
  if (!host || await isAllowed(host)) return;
  const { paused } = await store.get();
  if (paused && Date.now() < paused) return;
  const reqs = await scriptletsFor(host);
  if (!reqs.length) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: "MAIN",
      injectImmediately: true,
      func: scriptletRunner,
      args: [reqs],
    });
  } catch (e) {}
}

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.url && (d.url.startsWith("http") || d.url.startsWith("about:blank"))) injectScriptlets(d.tabId, d.frameId, d.url);
});

// ---------- custom filters ----------
function parseCustom(text) {
  const net = [];      // DNR block rules
  const allow = [];    // DNR allow rules (exceptions)
  const cosmetic = {}; // host -> [sel]
  const scriptlets = {}; // host -> [{t,a}]
  let id = CUSTOM_RULE_BASE;
  for (let raw of (text || "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("!") || line.startsWith("#")) continue;
    if (line.includes("##") || line.includes("#@#") || line.includes("+js(")) {
      // cosmetic/scriptlet: host##sel  OR  host##+js(token,args)
      const i = line.indexOf("##");
      if (i === -1) continue;
      const host = line.slice(0, i) || "*";
      const body = line.slice(i + 2);
      if (body.startsWith("+js(")) {
        const inner = body.replace(/^\+js\(|\)$/g, "");
        const parts = inner.split(",").map((s) => s.trim());
        (scriptlets[host] ||= []).push({ t: parts[0], a: parts.slice(1) });
      } else {
        (cosmetic[host] ||= []).push(body);
      }
      continue;
    }
    // network rule
    let f = line, isAllow = false;
    if (f.startsWith("@@")) { isAllow = true; f = f.slice(2); }
    f = f.split("$")[0];
    if (!/^[\x20-\x7E]+$/.test(f) || /[#\s]/.test(f)) continue;
    const rule = { id: id++, priority: isAllow ? 3 : 2, action: { type: isAllow ? "allow" : "block" }, condition: { urlFilter: f } };
    (isAllow ? allow : net).push(rule);
  }
  return { net: net.concat(allow), cosmetic, scriptlets };
}

async function ensureCustom() {
  if (customParsed) return;
  const { customFilters } = await store.get();
  customParsed = parseCustom(customFilters);
}

async function applyCustomRules() {
  const { customFilters } = await store.get();
  customParsed = parseCustom(customFilters);
  const existing = (await DNR.getDynamicRules()).filter((r) => r.id >= CUSTOM_RULE_BASE).map((r) => r.id);
  try {
    await DNR.updateDynamicRules({ removeRuleIds: existing, addRules: customParsed.net });
  } catch (e) {}
}

async function addCustomFilter(line) {
  const { customFilters } = await store.get();
  const text = (customFilters ? customFilters.replace(/\s+$/, "") + "\n" : "") + line + "\n";
  await store.set({ customFilters: text });
  await applyCustomRules();
  return text;
}

// ---------- tracking-parameter stripping ----------
async function applyParamRules() {
  const { stripTracking } = await chrome.storage.local.get("stripTracking");
  const on = stripTracking !== false; // default on
  const existing = (await DNR.getDynamicRules()).filter((r) => r.id >= PARAM_RULE_BASE && r.id < PARAM_RULE_BASE + 1000).map((r) => r.id);
  const addRules = on ? [{
    id: PARAM_RULE_BASE,
    priority: 1,
    action: { type: "redirect", redirect: { transform: { queryTransform: { removeParams: TRACKING_PARAMS } } } },
    condition: { resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest"] },
  }] : [];
  try { await DNR.updateDynamicRules({ removeRuleIds: existing, addRules }); } catch (e) {}
}

// ---------- custom filter-list subscriptions (by URL) ----------
async function getSubs() {
  const { subscriptions } = await chrome.storage.local.get("subscriptions");
  return subscriptions || []; // [{url, title, enabled, rules, cosmeticHosts, scriptletHosts, addedAt, error}]
}
async function setSubs(subs) { await chrome.storage.local.set({ subscriptions: subs }); }

let subCosmetic = null;   // host -> [sel]   (merged from enabled subs)
let subScriptlets = null; // host -> [{t,a}]

async function loadSubData() {
  if (subCosmetic && subScriptlets) return;
  subCosmetic = {}; subScriptlets = {};
  const subs = await getSubs();
  for (let i = 0; i < subs.length; i++) {
    if (!subs[i].enabled) continue;
    const { [`sub_cos_${i}`]: cos, [`sub_scr_${i}`]: scr } = await chrome.storage.local.get([`sub_cos_${i}`, `sub_scr_${i}`]);
    for (const [h, sels] of Object.entries(cos || {})) (subCosmetic[h] ||= []).push(...sels);
    for (const [h, arr] of Object.entries(scr || {})) (subScriptlets[h] ||= []).push(...arr);
  }
}

async function subscribeList(url) {
  const subs = await getSubs();
  if (subs.find((s) => s.url === url)) return { ok: false, error: "Already added" };
  const idx = subs.length;
  let text;
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    text = await res.text();
  } catch (e) { return { ok: false, error: "Couldn't fetch: " + e.message }; }
  const { dnr, cosmetic, scriptlets } = convertList(text, { startId: 1, maxRegex: 0 });
  // dynamic rules share the 30k safe-rule budget; cap each subscribed list
  const base = SUB_RULE_BASE + idx * 100_000;
  const capped = dnr.slice(0, 20_000).map((r, i) => ({ ...r, id: base + i }));
  try {
    await DNR.updateDynamicRules({ addRules: capped });
  } catch (e) { return { ok: false, error: "Rule budget full (" + e.message + ")" }; }
  const title = (text.match(/!\s*Title:\s*(.+)/i) || [])[1]?.trim() || new URL(url).hostname;
  // store cosmetic/scriptlet maps for this sub
  await chrome.storage.local.set({
    [`sub_cos_${idx}`]: cosmetic.specific,
    [`sub_scr_${idx}`]: scriptlets,
  });
  subs.push({ url, title, enabled: true, rules: capped.length, cosmeticHosts: Object.keys(cosmetic.specific).length, scriptletHosts: Object.keys(scriptlets).length, addedAt: Date.now(), lastUpdated: Date.now() });
  await setSubs(subs);
  subCosmetic = null; subScriptlets = null;
  return { ok: true, title, rules: capped.length };
}

async function removeSub(url) {
  const subs = await getSubs();
  const idx = subs.findIndex((s) => s.url === url);
  if (idx === -1) return { ok: false };
  const base = SUB_RULE_BASE + idx * 100_000;
  const ids = (await DNR.getDynamicRules()).filter((r) => r.id >= base && r.id < base + 100_000).map((r) => r.id);
  try { await DNR.updateDynamicRules({ removeRuleIds: ids }); } catch (e) {}
  await chrome.storage.local.remove([`sub_cos_${idx}`, `sub_scr_${idx}`]);
  // note: we keep indices stable by leaving a tombstone-free re-index. Rebuild all to keep ids aligned.
  subs.splice(idx, 1);
  await setSubs(subs);
  await reindexSubs();
  subCosmetic = null; subScriptlets = null;
  return { ok: true };
}

// re-apply all subs so their id ranges match their new indices (after a removal)
async function reindexSubs() {
  const subs = await getSubs();
  // clear all sub rules
  const all = (await DNR.getDynamicRules()).filter((r) => r.id >= SUB_RULE_BASE && r.id < PARAM_RULE_BASE).map((r) => r.id);
  if (all.length) { try { await DNR.updateDynamicRules({ removeRuleIds: all }); } catch (e) {} }
  // re-fetch is costly; instead just re-add from stored cosmetic? we didn't store dnr. Simplest: refetch enabled.
  for (let i = 0; i < subs.length; i++) {
    const s = subs[i];
    if (!s.enabled) continue;
    try {
      const text = await (await fetch(s.url, { cache: "no-cache" })).text();
      const { dnr, cosmetic, scriptlets } = convertList(text, { startId: 1, maxRegex: 0 });
      const base = SUB_RULE_BASE + i * 100_000;
      const capped = dnr.slice(0, 20_000).map((r, k) => ({ ...r, id: base + k }));
      await DNR.updateDynamicRules({ addRules: capped });
      await chrome.storage.local.set({ [`sub_cos_${i}`]: cosmetic.specific, [`sub_scr_${i}`]: scriptlets });
      subs[i].rules = capped.length;
      subs[i].lastUpdated = Date.now();
      delete subs[i].error;
    } catch (e) { subs[i].error = String(e.message || e); }
  }
  await setSubs(subs);
}

// ---------- stats + badge ----------
async function bumpStats(n = 1) {
  const { stats } = await store.get();
  if (stats.day !== todayKey()) { stats.day = todayKey(); stats.today = 0; }
  stats.total += n;
  stats.today += n;
  await store.set({ stats });
}

// per-tab blocked counts + a network logger (ring buffer), via debug matches (unpacked)
const tabBlocked = new Map();
const tabLog = new Map();   // tabId -> [{url, type, list, t}]
const tabDomains = new Map(); // tabId -> Map(domain -> count)
const LOG_MAX = 300;

function domainFromUrl(u) { try { return new URL(u).hostname; } catch { return ""; } }

if (DNR.onRuleMatchedDebug) {
  DNR.onRuleMatchedDebug.addListener((info) => {
    const tabId = info.request.tabId;
    const list = info.rule.rulesetId;
    bumpStats(1);
    if (tabId < 0) return;
    tabBlocked.set(tabId, (tabBlocked.get(tabId) || 0) + 1);
    const log = tabLog.get(tabId) || [];
    log.push({ url: info.request.url, type: info.request.type, list, t: Date.now() });
    if (log.length > LOG_MAX) log.shift();
    tabLog.set(tabId, log);
    const dm = tabDomains.get(tabId) || new Map();
    const d = domainFromUrl(info.request.url);
    if (d) dm.set(d, (dm.get(d) || 0) + 1);
    tabDomains.set(tabId, dm);
    // all-time top domains
    bumpTopDomain(d);
  });
}
chrome.tabs.onRemoved.addListener((id) => { tabBlocked.delete(id); tabLog.delete(id); tabDomains.delete(id); });
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.status === "loading" && info.url) { tabBlocked.set(id, 0); tabLog.set(id, []); tabDomains.set(id, new Map()); }
});

let topDomainsCache = null;
let topDomainsDirty = false;
async function bumpTopDomain(d) {
  if (!d) return;
  if (!topDomainsCache) { const { topDomains } = await chrome.storage.local.get("topDomains"); topDomainsCache = topDomains || {}; }
  topDomainsCache[d] = (topDomainsCache[d] || 0) + 1;
  topDomainsDirty = true;
}
setInterval(async () => {
  if (topDomainsDirty && topDomainsCache) {
    // keep only the top 200 to bound storage
    const entries = Object.entries(topDomainsCache).sort((a, b) => b[1] - a[1]).slice(0, 200);
    topDomainsCache = Object.fromEntries(entries);
    await chrome.storage.local.set({ topDomains: topDomainsCache });
    topDomainsDirty = false;
  }
}, 15000);

// ---------- messaging ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "cosmetic": {
        const host = msg.host || (sender.tab && new URL(sender.tab.url).hostname);
        sendResponse(await cosmeticFor(host));
        break;
      }
      case "status": {
        const { allowlist, stats, paused, cosmeticOn, enabledLists } = await store.get();
        const host = msg.host;
        const allowed = await isAllowed(host);
        sendResponse({
          allowed, stats, paused, cosmeticOn,
          enabledLists: enabledLists || [],
          tabBlocked: tabBlocked.get(msg.tabId) || 0,
          pausedActive: paused && Date.now() < paused,
        });
        break;
      }
      case "toggleSite": {
        await setSiteAllowed(msg.domain, msg.allow);
        sendResponse({ ok: true });
        break;
      }
      case "pause": {
        await store.set({ paused: msg.until || 0 });
        await syncAllowlistRules();
        sendResponse({ ok: true });
        break;
      }
      case "setCosmetic": {
        await store.set({ cosmeticOn: !!msg.on });
        sendResponse({ ok: true });
        break;
      }
      case "getLists": {
        const meta = await loadLists();
        const { enabledLists } = await store.get();
        const enabled = await DNR.getEnabledRulesets();
        sendResponse({ meta, enabledLists: enabledLists || [], actuallyEnabled: enabled, available: await DNR.getAvailableStaticRuleCount() });
        break;
      }
      case "setLists": {
        const r = await applyEnabledLists(msg.ids);
        sendResponse(r);
        break;
      }
      case "resetStats": {
        await store.set({ stats: { total: 0, today: 0, day: todayKey() } });
        sendResponse({ ok: true });
        break;
      }
      case "getLog": {
        sendResponse({ log: (tabLog.get(msg.tabId) || []).slice().reverse(), blocked: tabBlocked.get(msg.tabId) || 0 });
        break;
      }
      case "clearLog": {
        tabLog.set(msg.tabId, []); tabDomains.set(msg.tabId, new Map());
        sendResponse({ ok: true });
        break;
      }
      case "getTopDomains": {
        if (!topDomainsCache) { const { topDomains } = await chrome.storage.local.get("topDomains"); topDomainsCache = topDomains || {}; }
        const top = Object.entries(topDomainsCache).sort((a, b) => b[1] - a[1]).slice(0, 25);
        sendResponse({ top });
        break;
      }
      case "recentDomains": {
        const dm = tabDomains.get(msg.tabId) || new Map();
        sendResponse({ domains: [...dm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8) });
        break;
      }
      case "exportConfig": {
        const d = await chrome.storage.local.get(null);
        // drop large derived caches; keep user settings + subs maps
        delete d.topDomains;
        sendResponse({ config: JSON.stringify({ app: "AdSweep", version: chrome.runtime.getManifest().version, data: d }, null, 2) });
        break;
      }
      case "importConfig": {
        try {
          const parsed = JSON.parse(msg.config);
          if (parsed.app !== "AdSweep") throw new Error("Not an AdSweep backup");
          await chrome.storage.local.clear();
          await chrome.storage.local.set(parsed.data || {});
          customParsed = null; subCosmetic = null; subScriptlets = null;
          await init();
          sendResponse({ ok: true });
        } catch (e) { sendResponse({ ok: false, error: String(e.message || e) }); }
        break;
      }
      case "setTracking": {
        await chrome.storage.local.set({ stripTracking: !!msg.on });
        await applyParamRules();
        sendResponse({ ok: true });
        break;
      }
      case "getTracking": {
        const { stripTracking } = await chrome.storage.local.get("stripTracking");
        sendResponse({ on: stripTracking !== false });
        break;
      }
      case "getSubs": {
        sendResponse({ subs: await getSubs() });
        break;
      }
      case "addSub": {
        const r = await subscribeList(msg.url);
        sendResponse(r);
        break;
      }
      case "removeSub": {
        sendResponse(await removeSub(msg.url));
        break;
      }
      case "toggleSub": {
        const subs = await getSubs();
        const s = subs.find((x) => x.url === msg.url);
        if (s) { s.enabled = !!msg.enabled; await setSubs(subs); await reindexSubs(); subCosmetic = null; subScriptlets = null; }
        sendResponse({ ok: true });
        break;
      }
      case "zap": {
        const tabId = msg.tabId ?? (sender.tab && sender.tab.id);
        try {
          await chrome.scripting.executeScript({ target: { tabId }, func: () => { window.__adsweepZap = true; } });
          await chrome.scripting.insertCSS({ target: { tabId }, files: ["src/picker.css"] });
          await chrome.scripting.executeScript({ target: { tabId }, files: ["src/picker.js"] });
          sendResponse({ ok: true });
        } catch (e) { sendResponse({ ok: false }); }
        break;
      }
      case "siteReport": {
        const host = msg.host;
        const allowed = await isAllowed(host);
        const cos = await cosmeticFor(host);
        const scr = await scriptletsFor(host);
        const dm = tabDomains.get(msg.tabId) || new Map();
        sendResponse({
          host,
          allowed,
          blocked: tabBlocked.get(msg.tabId) || 0,
          domains: [...dm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
          cosmeticCount: cos.enabled ? cos.selectors.length : 0,
          scriptlets: [...new Set(scr.map((s) => s.t))],
          enabledLists: await DNR.getEnabledRulesets(),
        });
        break;
      }
      case "updateSubsNow": {
        await reindexSubs();
        sendResponse({ ok: true, subs: await getSubs() });
        break;
      }
      case "runUnwall": {
        const tabId = msg.tabId ?? (sender.tab && sender.tab.id);
        try {
          await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            world: "MAIN",
            func: scriptletRunner,
            args: [[{ t: "unwall", a: [] }]],
          });
          sendResponse({ ok: true });
        } catch (e) { sendResponse({ ok: false, error: String(e) }); }
        break;
      }
      case "startPicker": {
        const tabId = msg.tabId ?? (sender.tab && sender.tab.id);
        try {
          await chrome.scripting.insertCSS({ target: { tabId }, files: ["src/picker.css"] });
          await chrome.scripting.executeScript({ target: { tabId }, files: ["src/picker.js"] });
          sendResponse({ ok: true });
        } catch (e) { sendResponse({ ok: false, error: String(e) }); }
        break;
      }
      case "addFilter": {
        const text = await addCustomFilter(msg.line);
        // tell the tab to hide it right away if cosmetic
        sendResponse({ ok: true, customFilters: text });
        break;
      }
      case "getCustom": {
        const { customFilters } = await store.get();
        sendResponse({ customFilters });
        break;
      }
      case "setCustom": {
        await store.set({ customFilters: msg.text || "" });
        await applyCustomRules();
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ error: "unknown" });
    }
  })();
  return true; // async
});

// ---------- lifecycle ----------
async function init() {
  try { await DNR.setExtensionActionOptions({ displayActionCountAsBadgeText: true }); } catch (e) {}
  try { await chrome.action.setBadgeBackgroundColor({ color: "#2f6df6" }); } catch (e) {}
  const meta = await loadLists();
  const { enabledLists } = await store.get();
  const desired = enabledLists || meta.filter((m) => m.rec).map((m) => m.id);
  await applyEnabledLists(desired);
  await syncAllowlistRules();
  await applyCustomRules();
  await applyParamRules();
  try { chrome.alarms.create("updateSubs", { periodInMinutes: 72 * 60, delayInMinutes: 72 * 60 }); } catch (e) {}
}

chrome.alarms?.onAlarm.addListener(async (a) => {
  if (a.name === "updateSubs") {
    const subs = await getSubs();
    if (subs.some((s) => s.enabled)) await reindexSubs();
  }
});

// keyboard shortcuts
chrome.commands?.onCommand.addListener(async (cmd) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    if (cmd === "pick" || cmd === "zap") {
      if (cmd === "zap") await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { window.__adsweepZap = true; } });
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["src/picker.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/picker.js"] });
    } else if (cmd === "unwall") {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, world: "MAIN", func: scriptletRunner, args: [[{ t: "unwall", a: [] }]] });
    }
  } catch (e) {}
});

function setupContextMenu() {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({ id: "adsweep-pick", title: "Block this element with AdSweep", contexts: ["page", "image", "video", "frame", "link"] });
    });
  } catch (e) {}
}
chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "adsweep-pick" && tab) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["src/picker.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/picker.js"] });
    } catch (e) {}
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await init();
  setupContextMenu();
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html?welcome=1") });
  }
});
chrome.runtime.onStartup.addListener(init);
// also run once when the SW spins up
init();
