// AdSweep cosmetic filtering: hide ad/annoyance elements the network layer can't touch.
// Runs at document_start in every frame. Asks the service worker which selectors apply to
// this hostname, then injects a generic stylesheet (as a <link>) plus the site-specific rules.
(() => {
  if (window.__adsweepCosmetic) return;
  window.__adsweepCosmetic = true;

  const host = location.hostname;
  if (!host) return;

  let styleEl = null;
  let linkEl = null;

  function injectGeneric() {
    if (linkEl) return;
    linkEl = document.createElement("link");
    linkEl.rel = "stylesheet";
    linkEl.href = chrome.runtime.getURL("src/cosmetic/generic.css");
    linkEl.id = "adsweep-generic";
    (document.head || document.documentElement).appendChild(linkEl);
  }

  function injectSpecific(selectors) {
    if (!selectors.length) return;
    // split into plain-hide, :style(...) and :remove() procedural cosmetics (uBO-style)
    const hide = [];
    const styles = []; // "selector { declarations }"
    const removes = [];
    for (const sel of selectors) {
      const mStyle = sel.match(/^(.*):style\((.+)\)\s*$/);
      const mRemove = sel.match(/^(.*):remove\(\s*\)\s*$/);
      if (mStyle) styles.push(`${mStyle[1]}{${mStyle[2]}}`);
      else if (mRemove) removes.push(mRemove[1]);
      else hide.push(sel);
    }
    styleEl = document.createElement("style");
    styleEl.id = "adsweep-specific";
    const CHUNK = 2000;
    let css = "";
    for (let i = 0; i < hide.length; i += CHUNK) {
      css += hide.slice(i, i + CHUNK).join(",") + "{display:none!important}";
    }
    css += styles.join("");
    styleEl.textContent = css;
    (document.head || document.documentElement).appendChild(styleEl);
    observe(hide, removes);
  }

  let observer = null;
  function observe(hideSelectors, removeSelectors = []) {
    if (observer) return;
    const sel = hideSelectors.join(",");
    const rem = removeSelectors.join(",");
    const sweep = () => {
      if (sel) {
        try { for (const n of document.querySelectorAll(sel)) { if (n.style.display !== "none") n.style.setProperty("display", "none", "important"); } } catch {}
      }
      if (rem) {
        try { for (const n of document.querySelectorAll(rem)) n.remove(); } catch {}
      }
    };
    observer = new MutationObserver(() => {
      // throttle with rAF
      if (observer._q) return;
      observer._q = true;
      requestAnimationFrame(() => { observer._q = false; sweep(); });
    });
    const start = () => observer.observe(document.documentElement, { childList: true, subtree: true });
    if (document.documentElement) start();
    else document.addEventListener("readystatechange", start, { once: true });
  }

  chrome.runtime.sendMessage({ type: "cosmetic", host }, (res) => {
    if (chrome.runtime.lastError || !res || !res.enabled) return;
    if (res.generic) injectGeneric();
    if (res.selectors && res.selectors.length) injectSpecific(res.selectors);
  });
})();
