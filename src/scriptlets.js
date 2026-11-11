// AdSweep scriptlet runner. This whole function is serialized and injected into a page's MAIN
// world at document_start, so it must be fully self-contained (no outside references).
// It implements the common uBO/AdGuard "scriptlets" that neutralize ad and anti-adblock scripts.
// `requests` is an array of { t: token, a: [args] }.
export function scriptletRunner(requests) {
  // a lone unwall (the "clear wall now" button) may re-run; the bulk auto-injection runs once
  const onlyUnwall = requests.length === 1 && requests[0] && requests[0].t === "unwall";
  if (window.__adsweepScriptletsRan && !onlyUnwall) return;
  if (!onlyUnwall) window.__adsweepScriptletsRan = true;
  const W = window;
  const safe = (fn) => { try { return fn(); } catch (e) {} };
  const rnd = () => Math.random().toString(36).slice(2);

  function parseValue(s) {
    switch (s) {
      case undefined: return undefined;
      case "true": return true;
      case "false": return false;
      case "null": return null;
      case "undefined": return undefined;
      case "": case "''": case '""': return "";
      case "noopFunc": case "noopFn": return function () {};
      case "trueFunc": return function () { return true; };
      case "falseFunc": return function () { return false; };
      case "emptyArr": return [];
      case "emptyObj": return {};
      case "noopPromiseResolve": return function () { return Promise.resolve(); };
    }
    if (/^-?\d+$/.test(s)) return parseInt(s, 10);
    if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
    return s;
  }

  // regex from a filter arg: /re/ or plain substring
  function toRe(s) {
    if (!s) return null;
    if (s.length > 1 && s[0] === "/" && s.lastIndexOf("/") > 0) {
      const i = s.lastIndexOf("/");
      try { return new RegExp(s.slice(1, i), s.slice(i + 1)); } catch (e) {}
    }
    try { return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); } catch (e) { return null; }
  }

  const S = {
    "set-constant": (prop, valueStr) => {
      const value = parseValue(valueStr);
      const parts = String(prop).split(".");
      function define(obj, i) {
        const key = parts[i];
        if (!obj) return;
        if (i === parts.length - 1) {
          safe(() => Object.defineProperty(obj, key, { configurable: false, get: () => value, set: () => {} }));
          return;
        }
        let o = obj[key];
        if (o === undefined || o === null) {
          o = {};
          safe(() => Object.defineProperty(obj, key, { configurable: true, enumerable: false, get: () => o, set: (v) => { o = v; } }));
        }
        if (typeof o === "object" || typeof o === "function") define(o, i + 1);
      }
      define(W, 0);
    },

    aopr: (prop) => abortOnProp(prop, false),
    aopw: (prop) => abortOnProp(prop, true),

    acs: (target, needle) => {
      const re = toRe(needle) || { test: () => true };
      const parts = String(target).split(".");
      const magic = rnd();
      function hook(obj, i) {
        if (!obj) return;
        const key = parts[i];
        if (i === parts.length - 1) {
          let val = obj[key];
          safe(() => Object.defineProperty(obj, key, {
            get() {
              const cs = document.currentScript;
              if (cs && cs.textContent && re.test(cs.textContent)) throw new ReferenceError(magic);
              return val;
            },
            set(v) { val = v; },
          }));
          return;
        }
        if (obj[key]) hook(obj[key], i + 1);
      }
      hook(W, 0);
      suppress(magic);
    },

    nosiif: (needle, delayArg) => timerDefuser("setInterval", needle, delayArg),
    nostif: (needle, delayArg) => timerDefuser("setTimeout", needle, delayArg),

    "nano-sib": (needle, delayArg, boostArg) => timerBooster("setInterval", needle, delayArg, boostArg),
    "nano-stb": (needle, delayArg, boostArg) => timerBooster("setTimeout", needle, delayArg, boostArg),

    nowoif: (needle) => {
      const re = needle ? toRe(needle) : null;
      const orig = W.open;
      W.open = function (url) {
        if (!re || (url && re.test(String(url)))) {
          return { closed: false, close() {}, focus() {}, blur() {}, postMessage() {}, document: { write() {}, writeln() {} } };
        }
        return orig.apply(this, arguments);
      };
    },

    "prevent-fab": () => {
      const Noop = function () {};
      const fab = {
        check: Noop, clearEvent: Noop, emitEvent() { return this; }, on(d, fn) { if (!d && typeof fn === "function") safe(fn); return this; },
        onDetected() { return this; }, onNotDetected(fn) { if (typeof fn === "function") safe(fn); return this; },
        setOption() { return this; }, options: {}, detected: false,
      };
      const Ctor = function () { return fab; };
      Ctor.prototype = fab;
      ["FuckAdBlock", "BlockAdBlock", "SadBlock", "sadblock"].forEach((n) => { safe(() => Object.defineProperty(W, n, { value: Ctor, writable: true, configurable: true })); });
      ["fuckAdBlock", "blockAdBlock", "sadblock"].forEach((n) => { safe(() => Object.defineProperty(W, n, { value: fab, writable: true, configurable: true })); });
    },

    "prevent-bab": () => {
      // neutralize BlockAdBlock's bait (strings eval'd / timed)
      const origSetTimeout = W.setTimeout;
      W.setTimeout = function (fn) {
        const s = String(fn);
        if (/\.bab_|babasbmsgx|blockadblock|\bbab\b/i.test(s)) return 0;
        return origSetTimeout.apply(this, arguments);
      };
      const origAdd = W.EventTarget && W.EventTarget.prototype.addEventListener;
      safe(() => { W.eval = new Proxy(W.eval, { apply(t, thiz, args) { const s = String(args[0] || ""); if (/babasbmsgx|blockadblock/i.test(s)) return undefined; return Reflect.apply(t, thiz, args); } }); });
    },

    "remove-attr": (attr, selector, ...rest) => mutate(() => {
      (document.querySelectorAll(selector || "*") || []).forEach((el) => { String(attr).split(/[|,]/).forEach((a) => el.removeAttribute(a.trim())); });
    }),
    "remove-class": (cls, selector) => mutate(() => {
      const classes = String(cls).split(/[|,]/).map((c) => c.trim());
      (document.querySelectorAll(selector || "." + classes.join(",.")) || []).forEach((el) => classes.forEach((c) => el.classList.remove(c)));
    }),
    rmnt: (sel, needle) => {
      const re = toRe(needle);
      mutate(() => (document.querySelectorAll(sel || "*") || []).forEach((el) => { if (!re || re.test(el.textContent)) el.remove(); }));
    },

    "json-prune": (propsArg) => {
      const props = String(propsArg || "").split(/\s+/).filter(Boolean);
      if (!props.length) return;
      const prune = (o) => { if (o && typeof o === "object") props.forEach((p) => { try { deleteByPath(o, p); } catch (e) {} }); return o; };
      const oj = JSON.parse;
      W.JSON.parse = function () { return prune(oj.apply(this, arguments)); };
      if (W.Response && W.Response.prototype.json) {
        const or = W.Response.prototype.json;
        W.Response.prototype.json = function () { return or.apply(this, arguments).then(prune); };
      }
    },

    "noeval-if": (needle) => {
      const re = needle ? toRe(needle) : null;
      const oe = W.eval;
      W.eval = function (s) { if (!re || re.test(String(s))) return undefined; return oe.apply(this, arguments); };
    },

    aeld: (typeArg, needleArg) => {
      const typeRe = typeArg ? toRe(typeArg) : null;
      const needleRe = needleArg ? toRe(needleArg) : null;
      const orig = W.EventTarget.prototype.addEventListener;
      W.EventTarget.prototype.addEventListener = function (type, listener) {
        const ls = safe(() => String(listener)) || "";
        if ((!typeRe || typeRe.test(String(type))) && (!needleRe || needleRe.test(ls))) return;
        return orig.apply(this, arguments);
      };
    },

    "set-ls": (key, value) => safe(() => localStorage.setItem(key, String(parseValue(value)))),
    "set-ss": (key, value) => safe(() => sessionStorage.setItem(key, String(parseValue(value)))),

    // AdSweep extra: strip "disable your ad blocker" walls — remove big fixed/absolute dark or
    // high-z overlays, and force the page scrollable again. Opt-in per site (##+js(unwall)).
    unwall: () => {
      const fix = () => {
        safe(() => {
          const de = document.documentElement, b = document.body;
          de.style.setProperty("overflow", "auto", "important");
          de.style.setProperty("filter", "none", "important");
          if (b) {
            b.style.setProperty("overflow", "auto", "important");
            b.style.setProperty("position", "static", "important");
            b.style.setProperty("filter", "none", "important");
          }
          const vw = innerWidth, vh = innerHeight;
          const nodes = document.querySelectorAll("body *");
          let i = 0;
          for (const el of nodes) {
            if (++i > 6000) break;
            const s = safe(() => getComputedStyle(el));
            if (!s) continue;
            // sites blur/disable the whole page when they detect a blocker — clear that everywhere
            if (s.filter && s.filter !== "none" && /blur|grayscale|brightness\(0/.test(s.filter)) el.style.setProperty("filter", "none", "important");
            if (s.pointerEvents === "none" && el.getBoundingClientRect().width > innerWidth * 0.5) el.style.setProperty("pointer-events", "auto", "important");
            if (s.userSelect === "none") el.style.setProperty("user-select", "auto", "important");
            if (s.position !== "fixed" && s.position !== "absolute") continue;
            const r = el.getBoundingClientRect();
            if (r.width < 40 || r.height < 40) continue;
            const big = r.width >= vw * 0.8 && r.height >= vh * 0.8;
            const z = parseInt(s.zIndex) || 0;
            const bg = s.backgroundColor || "";
            const dark = /rgba\(0,\s*0,\s*0|rgba\([^)]*0?\.[4-9]\d*\)/.test(bg) || s.backdropFilter !== "none";
            const kw = /ad\s?block|disable.*(ad|blocker)|whitelist|turn off|using an adblocker/i.test(el.textContent || "");
            // a full-screen dark/elevated backdrop, or any elevated box that is the "disable adblock" wall
            if ((big && (z >= 1000 || dark)) || (kw && (z >= 100 || big))) {
              el.style.setProperty("display", "none", "important");
            }
          }
        });
      };
      fix();
      let n = 0;
      const iv = setInterval(() => { fix(); if (++n > 40) clearInterval(iv); }, 250);
      mutate(fix);
    },
  };

  // ---- helpers ----
  function suppress(magic) {
    const prev = W.onerror;
    W.onerror = function (msg) { if (typeof msg === "string" && msg.includes(magic)) return true; return prev ? prev.apply(this, arguments) : false; };
    W.addEventListener("error", (e) => { if (e && e.error && String(e.error.message || "").includes(magic)) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  }
  function abortOnProp(prop, write) {
    const parts = String(prop).split(".");
    const magic = rnd();
    function apply(obj, i) {
      if (!obj) return;
      const key = parts[i];
      if (i === parts.length - 1) {
        let val = obj[key];
        safe(() => Object.defineProperty(obj, key, {
          get() { if (!write) throw new ReferenceError(magic); return val; },
          set(v) { if (write) throw new ReferenceError(magic); val = v; },
        }));
        return;
      }
      if (obj[key]) apply(obj[key], i + 1);
    }
    apply(W, 0);
    suppress(magic);
  }
  function timerDefuser(kind, needle, delayArg) {
    const re = needle ? toRe(needle) : null;
    const wantDelay = delayArg !== undefined && delayArg !== "" ? parseInt(String(delayArg).replace("!", ""), 10) : null;
    const negate = String(delayArg || "").includes("!");
    const orig = W[kind];
    W[kind] = function (fn, delay) {
      const s = safe(() => String(fn)) || "";
      let match = !re || re.test(s);
      if (match && wantDelay !== null) { const dm = (delay === wantDelay); match = negate ? !dm : dm; }
      if (match && re) return 0;
      return orig.apply(this, arguments);
    };
  }
  function timerBooster(kind, needle, delayArg, boostArg) {
    const re = needle ? toRe(needle) : null;
    const wantDelay = delayArg && delayArg !== "*" ? parseInt(delayArg, 10) : null;
    let boost = parseFloat(boostArg);
    if (!isFinite(boost) || boost <= 0) boost = 0.05;
    boost = Math.min(Math.max(boost, 0.001), 50);
    const orig = W[kind];
    W[kind] = function (fn, delay) {
      const s = safe(() => String(fn)) || "";
      if ((!re || re.test(s)) && (wantDelay === null || delay === wantDelay)) {
        arguments[1] = (delay || 0) * boost;
      }
      return orig.apply(this, arguments);
    };
  }
  function deleteByPath(obj, path) {
    const parts = path.split(".");
    for (let i = 0; i < parts.length - 1; i++) { obj = obj[parts[i]]; if (!obj) return; }
    delete obj[parts[parts.length - 1]];
  }
  let mutObserver = null;
  const mutFns = [];
  function mutate(fn) {
    safe(fn);
    mutFns.push(fn);
    if (!mutObserver) {
      const run = () => { if (run._q) return; run._q = true; requestAnimationFrame(() => { run._q = false; mutFns.forEach((f) => safe(f)); }); };
      mutObserver = new MutationObserver(run);
      const start = () => mutObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      if (document.documentElement) start(); else document.addEventListener("readystatechange", start, { once: true });
    }
  }

  for (const r of requests) {
    const fn = S[r.t];
    if (fn) safe(() => fn(...(r.a || [])));
  }
}
