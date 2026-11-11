const $ = (id) => document.getElementById(id);
const send = (m) => chrome.runtime.sendMessage(m);
try { $("ver").textContent = chrome.runtime.getManifest().version; } catch (e) {}

function domainOf(h) { const p = h.split("."); return p.length <= 2 ? h : p.slice(-2).join("."); }

async function load() {
  const params = new URLSearchParams(location.search);
  let tabId = Number(params.get("tab"));
  let host = params.get("host");
  if (!tabId || !host) {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (t) { tabId = t.id; try { host = new URL(t.url).hostname; } catch {} }
  }
  if (!host) { $("host").textContent = "No site"; return; }

  const r = await send({ type: "siteReport", host, tabId });
  $("host").textContent = domainOf(host);
  $("status").textContent = r.allowed ? "Protection off" : "Protected";
  $("status").classList.toggle("off", r.allowed);
  $("blocked").textContent = (r.blocked || 0).toLocaleString();
  $("cosmetic").textContent = (r.cosmeticCount || 0).toLocaleString();
  $("scripts").textContent = (r.scriptlets || []).length;
  $("lists").textContent = (r.enabledLists || []).length;

  const dbox = $("domains");
  if (r.domains && r.domains.length) {
    dbox.innerHTML = r.domains.map(([d, n]) => `<div class="d"><span>${d}</span><span class="n">${n}</span></div>`).join("");
  } else {
    dbox.innerHTML = '<p class="empty">Nothing blocked yet. Reload the page to capture requests from the start.</p>';
  }

  if (r.scriptlets && r.scriptlets.length) {
    $("scriptCard").hidden = false;
    $("scriptList").innerHTML = r.scriptlets.map((t) => `<span class="chip">${t}</span>`).join("");
  }
}

$("refresh").addEventListener("click", load);
load();
