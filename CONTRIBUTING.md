# Contributing to AdSweep

Thanks for helping make the web quieter! 🧹

## Ways to help
- **Report a broken site or an ad that slips through** — open an issue with the URL and a screenshot.
- **Add a site fix** — a cosmetic or scriptlet rule in `tools/build.mjs`'s lists, or share it in an issue.
- **New scriptlets** — add to `src/scriptlets.js` (keep them self-contained; they run in the page's MAIN world).
- **UI / performance** — the popup, options, logger and report pages live in their own folders.

## Dev loop
```bash
npm run build       # fetch lists + generate rules/ and cosmetic data
npm run validate    # verify every DNR rule and manifest reference
npm test            # load in real Chrome via DevTools and assert blocking works
npm run package     # build a clean dist/adsweep/ folder to load unpacked
```

## Rules of thumb
- Every `declarativeNetRequest` rule must pass `npm run validate` (one bad rule voids a whole ruleset in Chrome).
- Keep the extension **local** — no analytics, no accounts, no network calls except user-added filter lists.
- Run `npm test` before opening a PR.

By contributing you agree your work is licensed under GPL-3.0.
