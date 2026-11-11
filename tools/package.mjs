import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT=path.join(ROOT,"dist","adsweep");
fs.rmSync(path.join(ROOT,"dist"),{recursive:true,force:true});
fs.mkdirSync(OUT,{recursive:true});
const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,"manifest.json")));
const keep=new Set(["manifest.json"]);
manifest.declarative_net_request.rule_resources.forEach(r=>keep.add(r.path));
keep.add("rules/lists.json");
keep.add(manifest.background.service_worker);
keep.add(manifest.action.default_popup); keep.add(manifest.options_page);
manifest.content_scripts.forEach(cs=>cs.js.forEach(j=>keep.add(j)));
manifest.web_accessible_resources.forEach(w=>w.resources.forEach(r=>keep.add(r)));
Object.values(manifest.icons).forEach(i=>keep.add(i));
// cosmetic data the SW fetches at runtime
["src/cosmetic/specific.json","src/cosmetic/unhide.json"].forEach(f=>keep.add(f));
// follow every HTML page and pull in the scripts/styles it references, so nothing is missed
function addHtmlDeps(htmlRel){
  const dir=path.dirname(htmlRel);
  const html=fs.readFileSync(path.join(ROOT,htmlRel),"utf8");
  const re=/(?:src|href)\s*=\s*["']([^"']+)["']/g; let m;
  while((m=re.exec(html))){
    const ref=m[1];
    if(/^(https?:|data:|#|chrome)/.test(ref)) continue;
    const rel=path.normalize(path.join(dir,ref));
    if(fs.existsSync(path.join(ROOT,rel))){ keep.add(rel); if(rel.endsWith(".js")||rel.endsWith(".mjs")) addJsDeps(rel); }
  }
}
// follow JS files: ES imports, runtime getURL(), and executeScript/insertCSS file refs
function addJsDeps(jsRel){
  const dir=path.dirname(jsRel);
  let src; try{ src=fs.readFileSync(path.join(ROOT,jsRel),"utf8"); }catch{ return; }
  const pats=[/import\s[^"']*["']([^"']+)["']/g, /getURL\(\s*[`"']([^`"'$?]+)/g, /files:\s*\[([^\]]+)\]/g];
  const refs=[];
  let m;
  while((m=pats[0].exec(src))) refs.push({base:dir,ref:m[1]});
  while((m=pats[1].exec(src))) refs.push({base:ROOT,ref:m[1]});   // getURL is extension-root relative
  while((m=pats[2].exec(src))) m[1].split(",").forEach(s=>{const r=s.trim().replace(/^["']|["']$/g,""); if(r) refs.push({base:ROOT,ref:r});});
  for(const {base,ref} of refs){
    if(/^(https?:|data:|chrome|#)/.test(ref)) continue;
    const rel=path.normalize(path.relative(ROOT, path.resolve(base, ref)));
    if(fs.existsSync(path.join(ROOT,rel)) && !keep.has(rel)){ keep.add(rel); if(rel.endsWith(".js")||rel.endsWith(".mjs")) addJsDeps(rel); if(rel.endsWith(".html")) addHtmlDeps(rel); }
  }
}
// seed from manifest HTML pages and JS entrypoints
[manifest.action.default_popup, manifest.options_page].forEach(addHtmlDeps);
[manifest.background.service_worker, ...manifest.content_scripts.flatMap(c=>c.js)].forEach(addJsDeps);
// explicit runtime-only assets Chrome loads lazily
["src/picker.js","rules/scriptlets.json"].forEach(f=>{ if(fs.existsSync(path.join(ROOT,f))) keep.add(f); });
for(const rel of keep){
  const src=path.join(ROOT,rel), dst=path.join(OUT,rel);
  fs.mkdirSync(path.dirname(dst),{recursive:true});
  fs.copyFileSync(src,dst);
}
// size report
let bytes=0,files=0;
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).forEach(e=>{const p=path.join(d,e.name);e.isDirectory()?walk(p):(bytes+=fs.statSync(p).size,files++);});
walk(OUT);
console.log(`packaged ${files} files, ${(bytes/1024/1024).toFixed(2)} MB -> dist/adsweep/`);
