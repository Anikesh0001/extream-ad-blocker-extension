// AdSweep YouTube helper: skip and remove video ads that network/cosmetic filters alone miss.
// Fully local, no network. Honors the allowlist/pause via the service worker.
(() => {
  if (window.__adsweepYT) return;
  window.__adsweepYT = true;

  let active = true;
  chrome.runtime.sendMessage({ type: "status", host: location.hostname }, (res) => {
    if (!chrome.runtime.lastError && res) active = !res.allowed && !res.pausedActive;
  });

  const AD_HIDE = [
    ".ytp-ad-overlay-slot",
    ".ytp-ad-image-overlay",
    "ytd-ad-slot-renderer",
    "ytd-in-feed-ad-layout-renderer",
    "ytd-banner-promo-renderer",
    "ytd-statement-banner-renderer",
    "ytd-display-ad-renderer",
    "#masthead-ad",
    "ytd-promoted-sparkles-web-renderer",
    "ytmusic-mealbar-promo-renderer",
    ".ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-ads']",
  ];

  function hideStatic() {
    const style = document.createElement("style");
    style.textContent = AD_HIDE.join(",") + "{display:none!important}";
    (document.head || document.documentElement).appendChild(style);
  }

  function skipVideoAd() {
    if (!active) return;
    const player = document.querySelector(".html5-video-player");
    const showingAd = player && player.classList.contains("ad-showing");
    if (showingAd) {
      // jump to the end of the ad, then click skip if present
      const video = document.querySelector("video.html5-main-video, video");
      if (video && isFinite(video.duration) && video.duration > 0) {
        video.currentTime = video.duration;
        video.muted = true;
      }
      const skip = document.querySelector(
        ".ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-container button",
      );
      if (skip) skip.click();
      // dismiss "are you still watching" / survey overlays
      document.querySelector(".ytp-ad-overlay-close-button")?.click();
    }
  }

  function start() {
    hideStatic();
    // poll fast enough to cut ads before they play
    setInterval(skipVideoAd, 250);
    const mo = new MutationObserver(() => skipVideoAd());
    const attach = () => mo.observe(document.documentElement, { childList: true, subtree: true });
    if (document.documentElement) attach();
    else document.addEventListener("readystatechange", attach, { once: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
