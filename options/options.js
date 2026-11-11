const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

if (new URLSearchParams(location.search).get("welcome")) $("welcome").hidden = false;
try { $("ver").textContent = chrome.runtime.getManifest().version; } catch (e) {}

async function refresh() {
  const info = await send({ type: "getLists" });
  const status = await send({ type: "status", host: "", tabId: -1 });
  renderStats(status, info);
  renderLists(info);
  renderAllowlist(status);
  $("cosmetic").checked = status.cosmeticOn !== false;
}

function renderStats(status, info) {
  $("total").textContent = (status.stats?.total ?? 0).toLocaleString();
  $("today").textContent = (status.stats?.today ?? 0).toLocaleString();
  $("budget").textContent = (info.available ?? 0).toLocaleString();
}

function renderLists(info) {
  const enabled = new Set(info.actuallyEnabled || []);
  const desired = new Set(info.enabledLists || []);
  const skipped = new Set((info.enabledLists || []).filter((id) => desired.has(id) && !enabled.has(id)));
  const box = $("lists");
  box.innerHTML = "";
  for (const m of info.meta) {
    const on = desired.has(m.id);
    const couldNotFit = on && !enabled.has(m.id);
    const el = document.createElement("div");
    el.className = "list-item";
    el.innerHTML = `
      <div class="info">
        <div class="title">${m.title}
          ${m.rec ? '<span class="badge rec">recommended</span>' : ""}
          ${couldNotFit ? '<span class="badge skip">no budget</span>' : ""}
        </div>
        <div class="meta">${m.desc} · ${m.rules.toLocaleString()} rules${m.cosmetic ? " · + element hiding" : ""}</div>
      </div>
      <label class="switch"><input type="checkbox" ${on ? "checked" : ""} data-id="${m.id}"><span class="slider"></span></label>`;
    box.appendChild(el);
  }
  box.querySelectorAll("input[data-id]").forEach((cb) => {
    cb.addEventListener("change", async () => {
      const ids = [...box.querySelectorAll("input[data-id]")].filter((c) => c.checked).map((c) => c.dataset.id);
      cb.disabled = true;
      const r = await send({ type: "setLists", ids });
      await refresh();
      if (r.skipped && r.skipped.length) {
        alert("Chrome's rule budget is full, so these lists couldn't be enabled: " +
          r.skipped.join(", ") + ".\nTurn off a larger list (e.g. AdGuard Base or EasyList) to make room.");
      }
    });
  });
}

function renderAllowlist(status) {
  // we need the raw allowlist; ask storage directly
  chrome.storage.local.get("allowlist", ({ allowlist }) => {
    allowlist = allowlist || {};
    const domains = Object.keys(allowlist);
    const box = $("allowlist");
    if (!domains.length) { box.innerHTML = '<p class="hint">None — AdSweep is active everywhere.</p>'; return; }
    box.innerHTML = "";
    for (const d of domains) {
      const row = document.createElement("div");
      row.className = "ai";
      row.innerHTML = `<span>${d}</span><button data-d="${d}">Re-enable</button>`;
      box.appendChild(row);
    }
    box.querySelectorAll("button[data-d]").forEach((b) => b.addEventListener("click", async () => {
      await send({ type: "toggleSite", domain: b.dataset.d, allow: false });
      refresh();
    }));
  });
}

$("cosmetic").addEventListener("change", (e) => send({ type: "setCosmetic", on: e.target.checked }));
$("resetStats").addEventListener("click", async () => { await send({ type: "resetStats" }); refresh(); });

$("enableAll").addEventListener("click", async () => {
  const info = await send({ type: "getLists" });
  const r = await send({ type: "setLists", ids: info.meta.map((m) => m.id) });
  await refresh();
  if (r.skipped && r.skipped.length) {
    alert("Chrome's rule budget is full, so these couldn't be enabled: " + r.skipped.join(", ") +
      ".\nThis usually means another ad blocker is also installed and using the shared budget — remove it and try again.");
  } else {
    alert("All filter lists are on. You're at maximum protection.");
  }
});
$("recommended").addEventListener("click", async () => {
  const info = await send({ type: "getLists" });
  await send({ type: "setLists", ids: info.meta.filter((m) => m.rec).map((m) => m.id) });
  refresh();
});

async function loadCustom() {
  const { customFilters } = await send({ type: "getCustom" });
  $("customFilters").value = customFilters || "";
}
$("saveCustom").addEventListener("click", async () => {
  await send({ type: "setCustom", text: $("customFilters").value });
  $("customSaved").textContent = "Saved ✓";
  setTimeout(() => ($("customSaved").textContent = ""), 2000);
});
loadCustom();

// ---- tracking-param toggle
(async () => { const { on } = await send({ type: "getTracking" }); $("tracking").checked = on !== false; })();
$("tracking").addEventListener("change", (e) => send({ type: "setTracking", on: e.target.checked }));

// ---- subscriptions
async function loadSubs() {
  const { subs } = await send({ type: "getSubs" });
  const box = $("subs");
  box.innerHTML = (subs && subs.length) ? "" : '<p class="hint">No extra lists yet.</p>';
  (subs || []).forEach((s) => {
    const el = document.createElement("div");
    el.className = "sub-item";
    const upd = s.lastUpdated ? new Date(s.lastUpdated).toLocaleDateString() : "—";
    el.innerHTML = `<label class="switch"><input type="checkbox" ${s.enabled ? "checked" : ""} data-u="${s.url}"><span class="slider"></span></label>
      <div class="info"><div class="title">${s.title || s.url}</div><div class="u">${s.url}</div>
      <div class="hint">${s.rules} rules · updated ${upd}${s.error ? " · ⚠ " + s.error : ""}</div></div>
      <button data-rm="${s.url}">Remove</button>`;
    box.appendChild(el);
  });
  box.querySelectorAll("input[data-u]").forEach((cb) => cb.addEventListener("change", async () => {
    await send({ type: "toggleSub", url: cb.dataset.u, enabled: cb.checked }); refresh();
  }));
  box.querySelectorAll("button[data-rm]").forEach((b) => b.addEventListener("click", async () => {
    b.textContent = "…"; await send({ type: "removeSub", url: b.dataset.rm }); loadSubs(); refresh();
  }));
}
$("addSub").addEventListener("click", async () => {
  const url = $("subUrl").value.trim();
  if (!url) return;
  $("addSub").textContent = "Adding…"; $("addSub").disabled = true;
  const r = await send({ type: "addSub", url });
  $("addSub").textContent = "Add list"; $("addSub").disabled = false;
  if (r.ok) { $("subUrl").value = ""; loadSubs(); refresh(); }
  else alert("Couldn't add list: " + (r.error || "unknown"));
});
$("updateSubs").addEventListener("click", async () => {
  $("updateSubs").textContent = "Updating…"; $("updateSubs").disabled = true;
  await send({ type: "updateSubsNow" });
  $("updateSubs").textContent = "Update now"; $("updateSubs").disabled = false;
  $("subMsg").textContent = "Updated ✓"; setTimeout(() => ($("subMsg").textContent = ""), 2000);
  loadSubs();
});
loadSubs();

// ---- top domains
async function loadTopDomains() {
  const { top } = await send({ type: "getTopDomains" });
  const box = $("topDomains");
  if (!top || !top.length) { box.innerHTML = '<p class="hint">Nothing yet — browse a bit and come back.</p>'; return; }
  box.innerHTML = top.map(([d, n]) => `<div class="td"><span>${d}</span><span class="n">${n.toLocaleString()}</span></div>`).join("");
}
loadTopDomains();

// ---- backup
$("exportBtn").addEventListener("click", async () => {
  const { config } = await send({ type: "exportConfig" });
  const blob = new Blob([config], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "adsweep-settings.json";
  a.click();
  URL.revokeObjectURL(a.href);
});
$("importBtn").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const r = await send({ type: "importConfig", config: text });
  $("backupMsg").textContent = r.ok ? "Imported ✓" : ("Failed: " + (r.error || ""));
  if (r.ok) setTimeout(() => location.reload(), 800);
});

refresh();
