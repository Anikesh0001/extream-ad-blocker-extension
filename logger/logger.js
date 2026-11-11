const $ = (id) => document.getElementById(id);
const send = (m) => chrome.runtime.sendMessage(m);
let currentTab = null;
let timer = null;

async function loadTabs() {
  const tabs = await chrome.tabs.query({});
  const sel = $("tabSelect");
  const prev = currentTab;
  sel.innerHTML = "";
  for (const t of tabs.filter((t) => t.url && t.url.startsWith("http"))) {
    const o = document.createElement("option");
    o.value = t.id;
    o.textContent = (t.title || t.url).slice(0, 60);
    sel.appendChild(o);
  }
  // default to the active tab
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  currentTab = prev ?? (active ? active.id : (tabs[0] && tabs[0].id));
  if (currentTab) sel.value = currentTab;
}

function typeLabel(t) { return (t || "other").replace("xmlhttprequest", "xhr").replace("sub_frame", "frame").replace("main_frame", "doc"); }

async function render() {
  if (!currentTab) return;
  const { log, blocked } = await send({ type: "getLog", tabId: Number(currentTab) });
  const q = $("filter").value.toLowerCase();
  const rows = (log || []).filter((e) => !q || e.url.toLowerCase().includes(q) || typeLabel(e.type).includes(q) || (e.list || "").includes(q));
  $("summary").textContent = `${blocked || 0} requests blocked on this tab · showing ${rows.length}`;
  $("empty").style.display = rows.length ? "none" : "block";
  $("rows").innerHTML = rows.map((e) => `
    <tr>
      <td>${new Date(e.t).toLocaleTimeString()}</td>
      <td><span class="type">${typeLabel(e.type)}</span></td>
      <td class="url">${escapeHtml(e.url)}</td>
      <td class="list">${e.list === "_dynamic" ? "custom" : e.list}</td>
    </tr>`).join("");
}

function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

$("tabSelect").addEventListener("change", (e) => { currentTab = e.target.value; render(); });
$("filter").addEventListener("input", render);
$("clear").addEventListener("click", async () => { await send({ type: "clearLog", tabId: Number(currentTab) }); render(); });
$("auto").addEventListener("change", (e) => { if (e.target.checked) start(); else stop(); });

function start() { stop(); timer = setInterval(render, 1000); }
function stop() { if (timer) clearInterval(timer); timer = null; }

(async () => { await loadTabs(); render(); start(); })();
