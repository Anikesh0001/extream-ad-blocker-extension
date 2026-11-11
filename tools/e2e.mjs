import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath } from "node:url";
const EXT=path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))),"dist","adsweep");
const CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";const PORT=9343;
const PROFILE=fs.mkdtempSync(path.join(os.tmpdir(),"adsweep-e2e-"));const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const getJSON=p=>fetch(`http://127.0.0.1:${PORT}${p}`).then(r=>r.json());
function cdp(ws){const s=new WebSocket(ws);let id=0;const p=new Map();const ready=new Promise(r=>s.onopen=()=>r());s.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}};return{ready,send:(method,params={})=>new Promise(r=>{const i=++id;p.set(i,r);s.send(JSON.stringify({id:i,method,params}));})};}
const val=async(c,e)=>{const r=await c.send("Runtime.evaluate",{expression:e,awaitPromise:true,returnByValue:true});return r.result?.exceptionDetails?("ERR:"+(r.result.exceptionDetails.exception?.description||"")):r.result?.result?.value;};
const connect=async pred=>{for(let i=0;i<40;i++){const t=await getJSON("/json");const x=t.find(pred);if(x&&x.webSocketDebuggerUrl){const c=cdp(x.webSocketDebuggerUrl);await c.ready;await c.send("Runtime.enable");return c;}await sleep(300);}return null;};
const ch=spawn(CHROME,["--headless=new","--disable-gpu","--no-first-run","--enable-unsafe-extension-debugging",`--remote-debugging-port=${PORT}`,`--user-data-dir=${PROFILE}`,"about:blank"],{stdio:"ignore"});
let code=1;
try{
  let ver;for(let i=0;i<40;i++){try{ver=await getJSON("/json/version");break;}catch{await sleep(300);}}
  const b=cdp(ver.webSocketDebuggerUrl);await b.ready;const lu=await b.send("Extensions.loadUnpacked",{path:EXT});
  if(lu.error){console.log("LOAD ERROR:",JSON.stringify(lu.error));throw 0;}
  const id=lu.result.id;console.log("loaded id:",id);
  const sw=await connect(x=>x.type==="service_worker"&&x.url.includes(id));await sleep(2500);
  console.log("enabled rulesets:",await val(sw,"chrome.declarativeNetRequest.getEnabledRulesets().then(r=>r.length)"));
  // drive the options page to save custom filters (real user path, different context)
  await b.send("Target.createTarget",{url:`chrome-extension://${id}/options/options.html`});
  const opt=await connect(x=>x.url.includes("options.html"));await sleep(1500);
  await val(opt,`document.getElementById("customFilters").value="example.com##+js(set-constant, __adsweepProof, true)\\nexample.com##h1\\n||iana.org^";document.getElementById("saveCustom").click();"clicked"`);
  await sleep(1500);
  console.log("custom dynamic rules after save:",await val(sw,"chrome.declarativeNetRequest.getDynamicRules().then(r=>r.filter(x=>x.id>=2000000).length)"));
  // open example.com
  await b.send("Target.createTarget",{url:"http://example.com/"});
  const pg=await connect(x=>x.type==="page"&&x.url.includes("example.com"));await sleep(3000);
  console.log("  example.com title:",await val(pg,"document.title"));
  console.log("  scriptlet set-constant ran (__adsweepProof===true):",await val(pg,"window.__adsweepProof===true"));
  console.log("  custom cosmetic hid <h1>:",await val(pg,"(()=>{const h=document.querySelector('h1');return h?getComputedStyle(h).display==='none':'no-h1';})()"));
  // test the picker by injecting it like the popup does
  const tabs=await getJSON("/json");const tgt=tabs.find(x=>x.type==="page"&&x.url.includes("example.com"));
  const tabId=await val(sw,`(async()=>{const t=await chrome.tabs.query({});const m=t.find(x=>x.url&&x.url.includes("example.com"));return m?m.id:-1;})()`);
  await val(sw,`chrome.scripting.insertCSS({target:{tabId:${tabId}},files:["src/picker.css"]}).then(()=>chrome.scripting.executeScript({target:{tabId:${tabId}},files:["src/picker.js"]})).then(()=>"ok").catch(e=>"ERR:"+e.message)`);
  await sleep(800);
  console.log("  picker bar appeared:",await val(pg,"!!document.getElementById('adsweep-bar')"));
  code=0;
}catch(e){if(e)console.log("err",e?.message||e);}finally{ch.kill("SIGKILL");try{fs.rmSync(PROFILE,{recursive:true,force:true});}catch{}process.exit(code);}
