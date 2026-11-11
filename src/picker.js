// AdSweep element picker. Injected on demand. Hover to highlight, click to pick, confirm to hide.
(() => {
  if (window.__adsweepPicker) { window.__adsweepPicker.restart(); return; }

  const host = location.hostname;
  const zapMode = !!window.__adsweepZap;
  const hl = document.createElement("div");
  hl.id = "adsweep-hl";
  const bar = document.createElement("div");
  bar.id = "adsweep-bar";
  const hint = zapMode ? "Click an element to remove it once · <b>Esc</b> to cancel" : "Click an element to hide it · <b>Esc</b> to cancel";
  const actionLabel = zapMode ? "Remove" : "Hide it";
  bar.innerHTML = `<span id="adsweep-msg">${hint}</span>
    <code id="adsweep-sel"></code>
    <span id="adsweep-actions" hidden><button id="adsweep-hide">${actionLabel}</button><button id="adsweep-cancel">Cancel</button></span>`;
  let picked = null;
  let frozen = false;

  function add() { document.documentElement.append(hl, bar); }
  add();

  // reject dynamic/obfuscated classes so a picked selector survives reloads
  function isGoodClass(c) {
    if (!c || c.length < 2 || c.length > 30) return false;
    if (/^(is-|has-|js-|ng-|css-|sc-|jsx-|svelte-|_)/.test(c)) return false;
    if (/\d{2,}/.test(c)) return false;                         // 2+ digits -> likely hashed
    if (/adb|adblock|detect/i.test(c)) return false;            // ad-block detector classes
    if (!/^[a-zA-Z_-][\w-]*$/.test(c)) return false;
    if (/([A-Za-z]\d|\d[A-Za-z])/.test(c) && c.length >= 6) return false; // mixed hash-ish
    const vowels = (c.match(/[aeiouAEIOU]/g) || []).length;
    if (c.length >= 5 && vowels === 0) return false;            // hhhhppp
    return true;
  }
  function stableId(id) { return id && /^[a-zA-Z_-][\w-]*$/.test(id) && !/\d{3,}/.test(id) && !/adb|adblock/i.test(id); }
  function tagClasses(el) {
    const cls = [...el.classList].filter(isGoodClass).slice(0, 2);
    return cls.length ? el.tagName.toLowerCase() + cls.map((c) => "." + CSS.escape(c)).join("") : null;
  }

  function selectorFor(el) {
    if (!el || el === document.body || el === document.documentElement) return "body";
    if (el.id && stableId(el.id)) return "#" + CSS.escape(el.id);
    const own = tagClasses(el);
    if (own && document.querySelectorAll(own).length <= 20) return own;
    // climb to a stable ancestor and build a short descendant selector (no html, no nth-child spam)
    const path = [own || el.tagName.toLowerCase()];
    let node = el;
    for (let d = 0; d < 3 && node.parentElement && node.parentElement !== document.body && node.parentElement !== document.documentElement; d++) {
      node = node.parentElement;
      if (node.id && stableId(node.id)) { path.unshift("#" + CSS.escape(node.id)); return path.join(" "); }
      const tc = tagClasses(node);
      if (tc && document.querySelectorAll(tc).length <= 10) { path.unshift(tc); return path.join(" "); }
    }
    return path.join(" ");
  }

  function highlight(el) {
    if (!el) { hl.style.display = "none"; return; }
    const r = el.getBoundingClientRect();
    hl.style.display = "block";
    hl.style.top = r.top + "px";
    hl.style.left = r.left + "px";
    hl.style.width = r.width + "px";
    hl.style.height = r.height + "px";
  }

  function onMove(e) {
    if (frozen) return;
    hl.style.display = "none";
    const el = document.elementFromPoint(e.clientX, e.clientY);
    hl.style.display = "block";
    if (!el || el.id === "adsweep-bar" || bar.contains(el)) return;
    picked = el;
    highlight(el);
    document.getElementById("adsweep-sel").textContent = selectorFor(el);
  }

  function freeze(e) {
    if (frozen) return;
    if (bar.contains(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    frozen = true;
    hl.classList.add("picked");
    document.getElementById("adsweep-msg").textContent = "Hide this element?";
    document.getElementById("adsweep-actions").hidden = false;
  }

  function cleanup() {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", freeze, true);
    document.removeEventListener("keydown", onKey, true);
    hl.remove(); bar.remove();
    window.__adsweepPicker = null;
  }

  function onKey(e) { if (e.key === "Escape") cleanup(); }

  bar.addEventListener("click", (e) => {
    if (e.target.id === "adsweep-cancel") { frozen = false; hl.classList.remove("picked"); document.getElementById("adsweep-actions").hidden = true; document.getElementById("adsweep-msg").textContent = "Click an element to hide it · Esc to cancel"; }
    if (e.target.id === "adsweep-hide" && picked) {
      if (zapMode) {
        try { picked.remove(); } catch (err) {}
        window.__adsweepZap = false;
      } else {
        const sel = selectorFor(picked);
        try { picked.style.setProperty("display", "none", "important"); } catch (err) {}
        chrome.runtime.sendMessage({ type: "addFilter", line: `${host}##${sel}` });
      }
      cleanup();
    }
  });

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", freeze, true);
  document.addEventListener("keydown", onKey, true);

  window.__adsweepPicker = { restart() { frozen = false; add(); } };
})();
