import { validUrlFilter, validDomain } from "./convert.mjs";
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ACTIONS = new Set(["block","allow","allowAllRequests","upgradeScheme","redirect","modifyHeaders"]);
const RTYPES = new Set(["main_frame","sub_frame","stylesheet","script","image","font","object","xmlhttprequest","ping","csp_report","media","websocket","other"]);
let errors = 0, totalRules = 0;

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT,"manifest.json")));
// 1. manifest references exist
const refs = [];
manifest.declarative_net_request.rule_resources.forEach(r=>refs.push(r.path));
refs.push(manifest.background.service_worker, manifest.action.default_popup, manifest.options_page);
manifest.content_scripts.forEach(cs=>cs.js.forEach(j=>refs.push(j)));
manifest.web_accessible_resources.forEach(w=>w.resources.forEach(r=>refs.push(r)));
Object.values(manifest.icons).forEach(i=>refs.push(i));
for (const r of refs) if (!fs.existsSync(path.join(ROOT,r))) { console.log("MISSING FILE:", r); errors++; }

// 2. every DNR rule valid
for (const rr of manifest.declarative_net_request.rule_resources) {
  const rules = JSON.parse(fs.readFileSync(path.join(ROOT, rr.path)));
  const ids = new Set();
  let bad = 0;
  for (const rule of rules) {
    totalRules++;
    if (!Number.isInteger(rule.id) || rule.id < 1) { bad++; continue; }
    if (ids.has(rule.id)) { bad++; continue; } ids.add(rule.id);
    if (!Number.isInteger(rule.priority) || rule.priority < 1) { bad++; continue; }
    if (!rule.action || !ACTIONS.has(rule.action.type)) { bad++; continue; }
    const c = rule.condition || {};
    if (!c.urlFilter && !c.regexFilter) { bad++; continue; }
    if (c.urlFilter && !validUrlFilter(c.urlFilter)) { bad++; continue; }
    if (c.domainType && !["firstParty","thirdParty"].includes(c.domainType)) { bad++; continue; }
    for (const k of ["resourceTypes","excludedResourceTypes"]) if (c[k] && !c[k].every(t=>RTYPES.has(t))) { bad++; break; }
    for (const k of ["initiatorDomains","excludedInitiatorDomains"]) if (c[k] && !c[k].every(validDomain)) { bad++; break; }
  }
  if (bad) { console.log(`  ✗ ${rr.id}: ${bad} invalid / ${rules.length}`); errors += bad; }
  else console.log(`  ✓ ${rr.id}: ${rules.length} rules valid`);
}

// 3. cosmetic JSON parses
for (const f of ["src/cosmetic/specific.json","src/cosmetic/unhide.json"]) {
  try { JSON.parse(fs.readFileSync(path.join(ROOT,f))); console.log("  ✓",f,"parses"); }
  catch(e){ console.log("  ✗",f,e.message); errors++; }
}
if (!fs.existsSync(path.join(ROOT,"src/cosmetic/generic.css"))) { console.log("MISSING generic.css"); errors++; }

console.log(`\n${totalRules} rules checked, ${errors} errors`);
process.exit(errors?1:0);
