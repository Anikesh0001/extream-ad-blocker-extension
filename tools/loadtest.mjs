// Load AdSweep via the DevTools Extensions.loadUnpacked command (the way modern Chrome
// supports loading unpacked extensions for automation), then verify DNR is live.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9334;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "adsweep-test-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (p) => fetch(`http://127.0.0.1:${PORT}${p}`).then((r) => r.json());

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map();
  const ready = new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = rej; });
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  return { ready, send: (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); }), close: () => ws.close() };
}
const val = async (c, expr) => {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  return r.result?.exceptionDetails ? { error: r.result.exceptionDetails.exception?.description } : r.result?.result?.value;
};

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--enable-unsafe-extension-debugging", "--enable-unsafe-swiftshader",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
let stderr = ""; chrome.stderr.on("data", (d) => (stderr += d));

let code = 1;
try {
  let ver = null;
  for (let i = 0; i < 40; i++) { try { ver = await getJSON("/json/version"); break; } catch { await sleep(300); } }
  const browser = cdp(ver.webSocketDebuggerUrl);
  await browser.ready;

  const loaded = await browser.send("Extensions.loadUnpacked", { path: EXT });
  if (loaded.error) { console.log("✗ Extensions.loadUnpacked failed:", JSON.stringify(loaded.error)); throw 0; }
  const extId = loaded.result?.id;
  console.log("✓ loaded via CDP, extension id:", extId);

  // find our SW
  let sw = null;
  for (let i = 0; i < 30 && !sw; i++) {
    const targets = await getJSON("/json");
    sw = targets.find((t) => t.type === "service_worker" && t.url.includes(extId));
    if (!sw) { try { await browser.send("Extensions.getStorageItems", {}); } catch {} await sleep(400); }
  }
  if (!sw) { console.log("✗ SW target not found after load.\n" + stderr.slice(-800)); throw 0; }

  const c = cdp(sw.webSocketDebuggerUrl);
  await c.ready; await c.send("Runtime.enable");
  await sleep(3000); // let init() enable rulesets within budget

  console.log("  name:", await val(c, "chrome.runtime.getManifest().name"));
  console.log("  DNR api:", await val(c, "typeof chrome.declarativeNetRequest"));
  const enabled = await val(c, "chrome.declarativeNetRequest.getEnabledRulesets().then(r=>r.join(','))");
  const avail = await val(c, "chrome.declarativeNetRequest.getAvailableStaticRuleCount().then(String)");
  const dyn = await val(c, "chrome.declarativeNetRequest.getDynamicRules().then(r=>String(r.length))");
  const enabledCount = await val(c, `(async()=>{const e=await chrome.declarativeNetRequest.getEnabledRulesets();const m=await fetch(chrome.runtime.getURL('rules/lists.json')).then(r=>r.json());return String(e.reduce((n,id)=>n+(m.find(x=>x.id===id)?.rules||0),0));})()`);
  console.log("  enabled rulesets:", enabled);
  console.log("  enabled rule count:", enabledCount);
  console.log("  static budget left:", avail);
  console.log("  dynamic rules:", dyn);

  // simulate what-would-happen for a known ad URL
  const match = await val(c, `chrome.declarativeNetRequest.isRegexSupported?('n/a'):'n/a'`);
  const test = await val(c, `chrome.declarativeNetRequest.testMatchOutcome?chrome.declarativeNetRequest.testMatchOutcome({url:'https://www.google-analytics.com/analytics.js',type:'script',initiator:'https://example.com'}).then(r=>JSON.stringify(r.matchedRules?.map(x=>x.rulesetId))):'no testMatchOutcome'`);
  console.log("  testMatch google-analytics:", test);

  if (typeof enabled === "string" && enabled.length && !String(avail).includes("error")) {
    console.log("\n✓ LOAD TEST PASSED — extension loads, DNR active, rulesets enabled.");
    code = 0;
  } else console.log("\n✗ DNR not active as expected.");
  c.close(); browser.close();
} catch (e) { if (e) console.log("error:", e?.message || e); }
finally { chrome.kill("SIGKILL"); try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {} process.exit(code); }
