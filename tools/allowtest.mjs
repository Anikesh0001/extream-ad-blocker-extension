import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath } from "node:url";
const EXT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));const CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";const PORT=9336;
const PROFILE=fs.mkdtempSync(path.join(os.tmpdir(),"adsweep-a-"));const sleep=ms=>new Promise(r=>setTimeout(r,ms));const getJSON=p=>fetch(`http://127.0.0.1:${PORT}${p}`).then(r=>r.json());
function cdp(ws){const s=new WebSocket(ws);let id=0;const p=new Map();const ready=new Promise(r=>s.onopen=()=>r());s.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}};return{ready,send:(method,params={})=>new Promise(r=>{const i=++id;p.set(i,r);s.send(JSON.stringify({id:i,method,params}));}),close:()=>s.close()};}
const val=async(c,e)=>{const r=await c.send("Runtime.evaluate",{expression:e,awaitPromise:true,returnByValue:true});return r.result?.exceptionDetails?{error:r.result.exceptionDetails.exception?.description}:r.result?.result?.value;};
const chrome=spawn(CHROME,["--headless=new","--disable-gpu","--no-first-run","--enable-unsafe-extension-debugging",`--remote-debugging-port=${PORT}`,`--user-data-dir=${PROFILE}`,"about:blank"],{stdio:["ignore","ignore","ignore"]});
let code=1;
try{
  let ver;for(let i=0;i<40;i++){try{ver=await getJSON("/json/version");break;}catch{await sleep(300);}}
  const b=cdp(ver.webSocketDebuggerUrl);await b.ready;const {result}=await b.send("Extensions.loadUnpacked",{path:EXT});const id=result.id;
  let sw;for(let i=0;i<30&&!sw;i++){const t=await getJSON("/json");sw=t.find(x=>x.type==="service_worker"&&x.url.includes(id));if(!sw)await sleep(400);}
  const c=cdp(sw.webSocketDebuggerUrl);await c.ready;await c.send("Runtime.enable");await sleep(2500);
  // add the exact allowlist rule shape the SW uses, then test a request on that domain
  const add=await val(c,`chrome.declarativeNetRequest.updateDynamicRules({addRules:[{id:1000001,priority:10000,action:{type:"allowAllRequests"},condition:{requestDomains:["doubleclick.net"],resourceTypes:["main_frame","sub_frame"]}}],removeRuleIds:[1000001]}).then(()=>"ok").catch(e=>"ERR:"+e.message)`);
  console.log("  add allowAllRequests rule:",add);
  const dyn=await val(c,`chrome.declarativeNetRequest.getDynamicRules().then(r=>JSON.stringify(r))`);
  console.log("  dynamic rules now:",dyn);
  // a sub_frame request to a doubleclick page should now be allow-listed (allowAllRequests on main/sub frame)
  const outcome=await val(c,`chrome.declarativeNetRequest.testMatchOutcome({url:"https://doubleclick.net/somepage",type:"sub_frame",initiator:"https://doubleclick.net"}).then(o=>JSON.stringify(o.matchedRules))`);
  console.log("  frame on doubleclick.net:",outcome);
  code = add==="ok"?0:1;
  c.close();b.close();
}catch(e){console.log("err",e?.message||e);}finally{chrome.kill("SIGKILL");try{fs.rmSync(PROFILE,{recursive:true,force:true});}catch{}process.exit(code);}
