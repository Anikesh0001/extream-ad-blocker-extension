const $ = (id) => document.getElementById(id);

let tab = null;
let host = "";
let baseDomain = "";

function domainOf(hostname) {
  // naive eTLD+1: take last two labels (good enough for the toggle; multi-part TLDs still work per-host)
  const parts = hostname.split(".");
  if (parts.length <= 2) return hostname;
  return parts.slice(-2).join(".");
}

async function load() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = t;
  try { host = new URL(t.url).hostname; } catch { host = ""; }
  baseDomain = domainOf(host);

  if (!host || t.url.startsWith("chrome")) {
    $("siteHost").textContent = "Browser page";
    $("siteState").textContent = "Nothing to block here";
    $("siteToggle").disabled = true;
    $("hero").classList.add("off");
  } else {
    $("siteHost").textContent = baseDomain;
  }

  const res = await chrome.runtime.sendMessage({ type: "status", host, tabId: t.id });
  render(res);
}

function render(res) {
  if (!res) return;
  const on = !res.allowed;
  $("tabCount").textContent = res.tabBlocked ?? 0;
  if (!on) $("hero").classList.add("off"); else $("hero").classList.remove("off");
  $("siteToggle").checked = on;
  $("siteState").textContent = res.pausedActive ? "Paused everywhere" : on ? "Protection on" : "Protection off here";
  $("siteState").classList.toggle("off", !on);
  $("statToday").textContent = (res.stats?.today ?? 0).toLocaleString();
  $("statTotal").textContent = (res.stats?.total ?? 0).toLocaleString();
  $("statLists").textContent = res.enabledLists?.length ?? 0;
  $("cosmeticToggle").checked = res.cosmeticOn !== false;
  $("paused").hidden = !res.pausedActive;
}

$("siteToggle").addEventListener("change", async (e) => {
  await chrome.runtime.sendMessage({ type: "toggleSite", domain: baseDomain, allow: !e.target.checked });
  if (tab) chrome.tabs.reload(tab.id);
  const res = await chrome.runtime.sendMessage({ type: "status", host, tabId: tab.id });
  render(res);
});

$("pauseBtn").addEventListener("click", async () => {
  const until = Date.now() + 30 * 60 * 1000;
  await chrome.runtime.sendMessage({ type: "pause", until });
  if (tab) chrome.tabs.reload(tab.id);
  const res = await chrome.runtime.sendMessage({ type: "status", host, tabId: tab.id });
  render(res);
});

$("resume").addEventListener("click", async (e) => {
  e.preventDefault();
  await chrome.runtime.sendMessage({ type: "pause", until: 0 });
  if (tab) chrome.tabs.reload(tab.id);
  const res = await chrome.runtime.sendMessage({ type: "status", host, tabId: tab.id });
  render(res);
});

$("cosmeticToggle").addEventListener("change", async (e) => {
  await chrome.runtime.sendMessage({ type: "setCosmetic", on: e.target.checked });
  if (tab) chrome.tabs.reload(tab.id);
});

$("pickBtn").addEventListener("click", async () => {
  if (!tab) return;
  await chrome.runtime.sendMessage({ type: "startPicker", tabId: tab.id });
  window.close();
});

$("unwallBtn").addEventListener("click", async () => {
  if (!host) return;
  // add a persistent unwall rule for this site, and run it immediately on the open tab
  await chrome.runtime.sendMessage({ type: "addFilter", line: `${baseDomain}##+js(unwall)` });
  await chrome.runtime.sendMessage({ type: "runUnwall", tabId: tab.id });
  window.close();
});

$("zapBtn").addEventListener("click", async () => {
  if (!tab) return;
  await chrome.runtime.sendMessage({ type: "zap", tabId: tab.id });
  window.close();
});

$("logBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("logger/logger.html") });
  window.close();
});

$("reportBtn").addEventListener("click", () => {
  const u = chrome.runtime.getURL(`report/report.html?tab=${tab ? tab.id : ""}&host=${encodeURIComponent(host)}`);
  chrome.tabs.create({ url: u });
  window.close();
});

$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());

load();
