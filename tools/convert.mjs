// Convert Adblock Plus / uBlock filter syntax into Manifest V3 declarativeNetRequest
// rules + cosmetic (element-hiding) data. Deliberately covers the high-value, well-defined
// subset of the syntax and skips the exotic bits (regex-only rules, redirect/csp/removeparam,
// scriptlets) so every rule we emit is one Chrome's DNR engine accepts.

const RESOURCE_TYPES = new Set([
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font",
  "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "other",
]);

// Adblock option -> DNR resourceType
const TYPE_MAP = {
  script: "script",
  image: "image",
  stylesheet: "stylesheet",
  object: "object",
  "object-subrequest": "other",
  xmlhttprequest: "xmlhttprequest",
  subdocument: "sub_frame",
  ping: "ping",
  websocket: "websocket",
  media: "media",
  font: "font",
  other: "other",
  document: "main_frame",
  // webrtc, popup, etc. have no DNR equivalent -> rule skipped
};

const UNSUPPORTED_OPTS = new Set([
  "popup", "popunder", "genericblock", "generichide", "elemhide", "csp",
  "redirect", "redirect-rule", "removeparam", "removeheader", "replace",
  "webrtc", "inline-script", "inline-font", "empty", "mp4", "cname",
  "stylesheet-with-side-effects", "all", "badfilter", "method", "header",
  "to", "ipaddress", "from", "strict1p", "strict3p", "permissions",
]);

function isComment(line) {
  return line === "" || line[0] === "!" || line[0] === "[" || line.startsWith("# ");
}

// A DNR initiatorDomain must be a plain hostname (no wildcards, ascii).
function validDomain(d) {
  return /^[a-z0-9.-]+$/.test(d) && d.length > 1 && !d.startsWith(".") && !d.endsWith(".");
}

// Validate a DNR urlFilter the way Chrome does, so one bad rule never voids a ruleset:
//  - ASCII only
//  - not empty / not just wildcards or separators
//  - `|` only as a leading `||`, leading single `|`, or trailing `|` (never mid-pattern)
function validUrlFilter(f) {
  if (!/^[\x00-\x7F]*$/.test(f)) return false;
  if (f.length === 0) return false;
  if (/^[\*\^|]+$/.test(f)) return false; // only anchors/wildcards -> too broad / invalid
  // DNR forbids a wildcard immediately after the domain anchor.
  if (f.startsWith("||*") || f.startsWith("|*")) return false;
  // these never belong in a network pattern (cosmetic/scriptlet leakage, option residue, spaces)
  if (/[#\s,"'(){}]/.test(f)) return false;
  // strip a leading || or | and a trailing |, then no | may remain
  let body = f;
  if (body.startsWith("||")) body = body.slice(2);
  else if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);
  if (body.includes("|")) return false;
  if (body.length === 0) return false;
  return true;
}

// Matches any Adblock/AdGuard cosmetic or scriptlet separator: ## #@# #?# #$# #%# and @ variants.
const COSMETIC_MARKER = /#[@?$%]*#/;

// Parse a network filter line into a DNR condition/action, or null to skip.
function parseNetworkRule(line) {
  let isException = false;
  let filter = line;
  if (filter.startsWith("@@")) {
    isException = true;
    filter = filter.slice(2);
  }

  // split off options after the last unescaped $
  let options = "";
  const dollar = filter.lastIndexOf("$");
  if (dollar !== -1 && !filter.slice(dollar).includes("/")) {
    // heuristic: real option sections don't contain '/'
    options = filter.slice(dollar + 1);
    filter = filter.slice(0, dollar);
  } else if (dollar !== -1) {
    // could still be options with a domain= containing no slash; try strict parse
    const maybe = filter.slice(dollar + 1);
    if (/^[a-z~0-9,=|.*_\-]+$/i.test(maybe)) {
      options = maybe;
      filter = filter.slice(0, dollar);
    }
  }

  // pure regex rules: /pattern/ -> use regexFilter (capped by caller); skip here, handled separately
  if (filter.length > 1 && filter.startsWith("/") && filter.endsWith("/")) {
    return { regex: filter.slice(1, -1), isException, condition: {}, action: {} };
  }

  const condition = {};
  const resourceTypes = new Set();
  const excludedResourceTypes = new Set();
  let domainType = null;
  const initiatorDomains = [];
  const excludedInitiatorDomains = [];

  if (options) {
    for (let opt of options.split(",")) {
      let negate = false;
      if (opt.startsWith("~")) { negate = true; opt = opt.slice(1); }
      const eq = opt.indexOf("=");
      const key = eq === -1 ? opt : opt.slice(0, eq);
      const val = eq === -1 ? "" : opt.slice(eq + 1);

      if (key === "third-party" || key === "3p") {
        domainType = negate ? "firstParty" : "thirdParty";
      } else if (key === "first-party" || key === "1p") {
        domainType = negate ? "thirdParty" : "firstParty";
      } else if (key === "domain") {
        for (const d of val.split("|")) {
          if (!d) continue;
          if (d.startsWith("~")) excludedInitiatorDomains.push(d.slice(1).toLowerCase());
          else initiatorDomains.push(d.toLowerCase());
        }
      } else if (TYPE_MAP[key]) {
        if (negate) excludedResourceTypes.add(TYPE_MAP[key]);
        else resourceTypes.add(TYPE_MAP[key]);
      } else if (UNSUPPORTED_OPTS.has(key)) {
        return null; // can't represent faithfully -> drop
      } else {
        return null; // unknown option -> drop to stay safe
      }
    }
  }

  // urlFilter: ABP anchors (||, ^, *, |) are valid DNR urlFilter syntax as-is.
  let urlFilter = filter;
  if (!validUrlFilter(urlFilter)) return null;
  condition.urlFilter = urlFilter;

  if (domainType) condition.domainType = domainType;
  if (resourceTypes.size) condition.resourceTypes = [...resourceTypes];
  if (excludedResourceTypes.size) condition.excludedResourceTypes = [...excludedResourceTypes];
  if (initiatorDomains.length) {
    if (!initiatorDomains.every(validDomain)) return null;
    condition.initiatorDomains = initiatorDomains;
  }
  if (excludedInitiatorDomains.length) {
    if (!excludedInitiatorDomains.every(validDomain)) return null;
    condition.excludedInitiatorDomains = excludedInitiatorDomains;
  }

  const action = isException ? { type: "allow" } : { type: "block" };
  return { condition, action, isException, regex: null };
}

// Parse a cosmetic (element hiding) line: domains##selector or ##selector (generic).
// Exceptions (#@#) and scriptlets (##+js, #%#, #$#) are reported separately.
function parseCosmeticRule(line) {
  // order matters: check exception/scriptlet markers
  let idx = line.indexOf("##");
  let unhide = false;
  let marker = "##";
  if (idx === -1) {
    const ex = line.indexOf("#@#");
    if (ex !== -1) { idx = ex; unhide = true; marker = "#@#"; }
  }
  if (idx === -1) return null;
  const domainsPart = line.slice(0, idx);
  let selector = line.slice(idx + marker.length);
  if (!selector) return null;
  // skip scriptlets we handle elsewhere
  if (selector.startsWith("+js(") || selector.startsWith("script:")) return null;
  // :style() and :remove() are supported by our content script; keep them.
  // drop the procedural pseudo-classes we can't evaluate as CSS.
  if (/:-abp-|:xpath\(|:upward\(|:matches-path\(|:min-text-length\(|:watch-attr\(|:matches-css-before|:matches-css-after/.test(selector)) return null;
  if (selector.includes(":has-text(") || selector.includes(":contains(")) return null;

  const domains = [];
  const excluded = [];
  if (domainsPart) {
    for (const d of domainsPart.split(",")) {
      if (!d) continue;
      if (d.startsWith("~")) excluded.push(d.slice(1).toLowerCase());
      else domains.push(d.toLowerCase());
    }
  }
  return { selector: selector.trim(), domains, excluded, unhide, generic: domains.length === 0 };
}

// --- scriptlet parsing -------------------------------------------------------
// uBO:     domains##+js(token, arg1, arg2)
// AdGuard: domains#%#//scriptlet('token', 'arg1', 'arg2')
// Normalize a token to a canonical name our runtime library implements.
const SCRIPTLET_ALIASES = {
  "set-constant.js": "set-constant", "set": "set-constant", "set-constant": "set-constant",
  "abort-on-property-read.js": "aopr", "aopr": "aopr", "abort-on-property-read": "aopr",
  "abort-on-property-write.js": "aopw", "aopw": "aopw", "abort-on-property-write": "aopw",
  "abort-current-script.js": "acs", "acs": "acs", "acis": "acs",
  "abort-current-inline-script.js": "acs", "abort-current-inline-script": "acs", "abort-current-script": "acs",
  "no-setInterval-if.js": "nosiif", "nosiif": "nosiif", "no-setInterval-if": "nosiif", "setInterval-defuser.js": "nosiif",
  "no-setTimeout-if.js": "nostif", "nostif": "nostif", "no-setTimeout-if": "nostif", "setTimeout-defuser.js": "nostif",
  "prevent-fab-3.2.0.js": "prevent-fab", "fuckadblock.js-3.2.0.js": "prevent-fab", "nofab.js": "prevent-fab",
  "prevent-fab": "prevent-fab", "fuckadblock": "prevent-fab",
  "bab-defuser.js": "prevent-bab", "prevent-bab": "prevent-bab", "nobab.js": "prevent-bab", "nobab2.js": "prevent-bab",
  "window.open-defuser.js": "nowoif", "nowoif": "nowoif", "no-window-open-if": "nowoif", "window.open-defuser": "nowoif",
  "remove-attr.js": "remove-attr", "ra": "remove-attr", "remove-attr": "remove-attr",
  "remove-class.js": "remove-class", "rc": "remove-class", "remove-class": "remove-class",
  "json-prune.js": "json-prune", "json-prune": "json-prune",
  "noeval-if.js": "noeval-if", "noeval.js": "noeval-if", "noeval-if": "noeval-if", "silent-noeval.js": "noeval-if",
  "nano-setInterval-booster.js": "nano-sib", "nano-sib": "nano-sib", "adjust-setInterval": "nano-sib",
  "nano-setTimeout-booster.js": "nano-stb", "nano-stb": "nano-stb", "adjust-setTimeout": "nano-stb",
  "addEventListener-defuser.js": "aeld", "aeld": "aeld", "prevent-addEventListener": "aeld",
  "remove-node-text.js": "rmnt", "rmnt": "rmnt", "remove-node-text": "rmnt",
  "set-local-storage-item.js": "set-ls", "set-local-storage-item": "set-ls",
  "set-session-storage-item.js": "set-ss", "set-session-storage-item": "set-ss",
};

function splitArgs(str) {
  const out = [];
  let cur = "", q = null, esc = false;
  for (const ch of str) {
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === "\\") { esc = true; cur += ch; continue; }
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === "'" || ch === '"') { q = ch; continue; }
    if (ch === ",") { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseScriptletRule(line) {
  let marker, inner, unhide = false;
  let i = line.indexOf("##+js(");
  if (i !== -1) { marker = "##+js("; }
  else if ((i = line.indexOf("#@#+js(")) !== -1) { marker = "#@#+js("; unhide = true; }
  else if ((i = line.indexOf("#%#//scriptlet(")) !== -1) { marker = "#%#//scriptlet("; }
  else if ((i = line.indexOf("#@%#//scriptlet(")) !== -1) { marker = "#@%#//scriptlet("; unhide = true; }
  else return null;

  const domainsPart = line.slice(0, i);
  let rest = line.slice(i + marker.length);
  if (rest.endsWith(")")) rest = rest.slice(0, -1);
  const args = splitArgs(rest);
  if (!args.length) return null;
  const rawToken = args[0].replace(/^['"]|['"]$/g, "");
  const token = SCRIPTLET_ALIASES[rawToken] || SCRIPTLET_ALIASES[rawToken + ".js"] || null;
  if (!token) return null; // scriptlet we don't implement -> skip
  const callArgs = args.slice(1);
  const domains = [];
  const excluded = [];
  for (const d of domainsPart.split(",")) {
    if (!d) continue;
    if (d.startsWith("~")) excluded.push(d.slice(1).toLowerCase());
    else domains.push(d.toLowerCase());
  }
  return { domains, excluded, token, args: callArgs, unhide, generic: domains.length === 0 };
}

// Convert a whole filter list text into { dnr, cosmetic, scriptlets, stats }
export function convertList(text, { startId = 1, maxRegex = 0 } = {}) {
  const dnrBlock = [];
  const dnrAllow = [];
  const regexRules = [];
  const genericHide = new Set();
  const specificHide = {}; // hostname -> [selectors]
  const unhide = {}; // hostname -> [selectors]
  const scriptlets = {}; // hostname -> [{t, a}]
  let skipped = 0;
  let scriptletCount = 0;

  for (let raw of text.split("\n")) {
    const line = raw.trim();
    if (isComment(line)) continue;

    // scriptlet line? (##+js(...) or #%#//scriptlet(...))
    if (line.includes("+js(") || line.includes("//scriptlet(")) {
      const s = parseScriptletRule(line);
      if (s && !s.unhide && !s.generic && !s.excluded.length) {
        for (const d of s.domains) {
          (scriptlets[d] ||= []).push({ t: s.token, a: s.args });
          scriptletCount++;
        }
      } else if (!s) skipped++;
      continue;
    }

    // cosmetic line? (## #@# #?# #$# #%# and @ variants) — never fall through to network
    if (COSMETIC_MARKER.test(line)) {
      const c = parseCosmeticRule(line); // only plain ## / #@# CSS converts; the rest are skipped
      if (c) {
        if (c.generic && !c.unhide) {
          genericHide.add(c.selector);
        } else if (c.unhide) {
          for (const d of c.domains) (unhide[d] ||= []).push(c.selector);
        } else {
          for (const d of c.domains) {
            if (c.excluded.length) continue; // rare, skip exclusions for specific
            (specificHide[d] ||= []).push(c.selector);
          }
        }
      } else {
        skipped++;
      }
      continue;
    }

    // network rule
    const r = parseNetworkRule(line);
    if (!r) { skipped++; continue; }
    if (r.regex) {
      if (regexRules.length < maxRegex) regexRules.push(r);
      else skipped++;
      continue;
    }
    if (r.isException) dnrAllow.push(r);
    else dnrBlock.push(r);
  }

  // assign ids + priorities. allow > block so exceptions win.
  const dnr = [];
  let id = startId;
  for (const r of dnrBlock) dnr.push({ id: id++, priority: 1, action: r.action, condition: r.condition });
  for (const r of dnrAllow) dnr.push({ id: id++, priority: 2, action: r.action, condition: r.condition });
  for (const r of regexRules) {
    dnr.push({ id: id++, priority: r.isException ? 2 : 1, action: r.isException ? { type: "allow" } : { type: "block" }, condition: { regexFilter: r.regex } });
  }

  return {
    dnr,
    nextId: id,
    cosmetic: {
      generic: [...genericHide],
      specific: specificHide,
      unhide,
    },
    scriptlets,
    stats: { block: dnrBlock.length, allow: dnrAllow.length, regex: regexRules.length, skipped, generic: genericHide.size, specificDomains: Object.keys(specificHide).length, scriptlets: scriptletCount, scriptletHosts: Object.keys(scriptlets).length },
  };
}

export { validUrlFilter, validDomain };
