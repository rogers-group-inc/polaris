// public/js/brand-logo.js — which mark to paint, and in which theme.
//
// Two rules, one place, because they have to agree on the desktop login, the
// mobile login and the sidebar:
//
//   1. The shipped Polaris art is THEME-AWARE. The wordmark is light blue on
//      the dark variant and near-black on the light one, so painting the wrong
//      file on the wrong background makes the logo disappear. Horizontal art
//      for the login card, vertical for the sidebar column. Which variant is
//      chosen by theme FAMILY, not id — morning and noon both take the light
//      art, with no third asset.
//   2. An operator's own logo REPLACES it — per surface (Server Settings →
//      Customization has a checkbox for each), optionally with the Polaris
//      symbol composited onto its corner (rendered server-side, see
//      services/brandLogoService.ts). The Application Name is text that only
//      makes sense NEXT TO a custom logo: the Polaris art already spells the
//      name out, so a caption under it would just say it twice.
//
// Theme changes are picked up from the `themechange` event app.js fires AND by
// observing data-theme on <html>, rather than by hooking each surface's theme
// setter — the desktop picker, the mobile toggle and the OS-preference listener
// below all end at that attribute, and the surfaces that have no app.js (login,
// mobile, dash) only ever see the attribute move.

(function (global) {
  "use strict";

  // Where the shipped art lives, derived from THIS FILE's own URL (…/js/ → …/).
  // Computed rather than read off a global: a page can evaluate this script
  // more than once, and a fresh evaluation would reset a global the page had
  // set. It also means the assets resolve correctly if Polaris is ever served
  // from a subdirectory. Falls back to the site root, which is where every
  // current mount serves them from.
  var BASE = (function () {
    try {
      var el = document.currentScript ||
        document.querySelector('script[src*="brand-logo.js"]');
      var src = el && el.getAttribute("src");
      if (src) return src.replace(/js\/brand-logo\.js.*$/, "");
    } catch (e) { /* fall through to the site root */ }
    return "/";
  })();

  var ASSETS = {
    // Login card — wide art, wordmark beside the star.
    login: {
      dark:  BASE + "img/brand/polaris-horiz-dark.png",
      light: BASE + "img/brand/polaris-horiz-light.png",
    },
    // Sidebar — stacked art, star above the wordmark, for a narrow column.
    sidebar: {
      dark:  BASE + "img/brand/polaris-vert-dark.png",
      light: BASE + "img/brand/polaris-vert-light.png",
    },
  };

  var ACCENT_PATH = "/server-settings/branding/logo-accent.png";
  // Shipped defaults, current first. "/logo.png" was retired in 2026-08 but is
  // still the stored value on any install seeded before then, and this list is
  // only consulted on a payload cached before the server started sending
  // `customLogo` — mistaking that legacy value for an upload would paint a 404.
  // Mirrors DEFAULT_LOGO_URLS in src/services/brandingService.ts. Compared
  // against a STORED branding value, so these stay the literal paths the server
  // records — never BASE-prefixed.
  var DEFAULT_LOGOS = ["/img/brand/polaris-symbol-dark.png", "/logo.png"];

  // The daylight themes. Duplicated from app.js's THEMES rather than imported
  // because this file loads BEFORE app.js and also runs on surfaces that never
  // load it at all (login.html, the mobile SPA, the dash wallboard). Where
  // app.js is present it is the authority, so defer to its isLightTheme.
  var LIGHT_THEMES = ["morning", "noon"];
  // The theme id to hand the OS-preference path per family. `light` picks
  // morning (the softer of the two) to match theme-init.js.
  var FAMILY_DEFAULT = { light: "morning", dark: "nightfall" };

  /**
   * The current theme's FAMILY ("light" | "dark") — which is also the key the
   * ASSETS table and the server-side accent renderer are indexed by, so this
   * keeps its name and its return values across the three-theme cutover.
   */
  function currentTheme() {
    if (typeof global.isLightTheme === "function") return global.isLightTheme() ? "light" : "dark";
    var id = document.documentElement.getAttribute("data-theme");
    return LIGHT_THEMES.indexOf(id) === -1 ? "dark" : "light";
  }

  /** The OS preference's family, used only when the operator has never picked
   *  a theme. Returns a family, not an id — see preferredThemeId. */
  function preferredTheme() {
    try {
      if (global.matchMedia && global.matchMedia("(prefers-color-scheme: light)").matches) return "light";
    } catch (e) { /* matchMedia missing — fall through to the historical default */ }
    return "dark";
  }

  /** The concrete theme id to apply for the OS preference. */
  function preferredThemeId() {
    return FAMILY_DEFAULT[preferredTheme()];
  }

  function savedTheme() {
    try { return localStorage.getItem("polaris-theme"); } catch (e) { return null; }
  }

  // Dash and mobile run against their own API mounts.
  function apiBase() {
    return global.__polarisApiBase || "/api/v1";
  }

  /**
   * Does this branding payload carry a custom logo? `customLogo` is computed
   * server-side; the fallback covers a payload cached in localStorage before
   * this field existed.
   */
  function isCustom(b) {
    if (!b) return false;
    if (typeof b.customLogo === "boolean") return b.customLogo;
    return Boolean(b.logoUrl) && DEFAULT_LOGOS.indexOf(b.logoUrl) === -1;
  }

  /**
   * Is the custom logo wanted on this surface? The placement flags default ON
   * — an older cached payload has neither, and "show the logo I uploaded" is
   * the behavior that install already had.
   */
  function customOn(b, surface) {
    if (!isCustom(b)) return false;
    if (surface === "login")   return b.logoOnLogin   !== false;
    if (surface === "sidebar") return b.logoOnSidebar !== false;
    return true;
  }

  /**
   * Resolve everything a surface needs to render its brand block:
   *   { src, custom, showName, showSubtitle }
   * `showName` is false for the Polaris art on purpose (rule 2 above); the
   * operator's subtitle is their own line of copy and rides along either way.
   */
  function resolve(b, surface) {
    var assets = ASSETS[surface] || ASSETS.login;
    if (customOn(b, surface)) {
      // The logo's version (server-derived from the upload's mtime + size),
      // so the URL changes when the file does and the image routes can serve
      // it immutable. Without it a fixed-filename upload was `no-cache`, and
      // every page change asked again — the sidebar painting with no logo and
      // popping it in. A payload cached before the field existed has none and
      // gets the old revalidating behaviour.
      var v = b.logoVersion ? "v=" + encodeURIComponent(b.logoVersion) : "";
      return {
        // The accent symbol is theme-paired too, so the composite is requested
        // per theme — which also makes the URL change on a theme flip, so the
        // <img> re-fetches without any cache-busting of its own.
        src: b.logoAccent
          ? apiBase() + ACCENT_PATH + "?theme=" + currentTheme() + (v ? "&" + v : "")
          : b.logoUrl + (v ? (b.logoUrl.indexOf("?") === -1 ? "?" : "&") + v : ""),
        custom: true,
        showName: Boolean((b.appName || "").trim()),
        showSubtitle: Boolean((b.subtitle || "").trim()),
      };
    }
    return {
      // The shipped art carries the running version (the payload's `version`)
      // as ?v=, which the server answers immutable (src/app.ts, /img/brand):
      // a page change paints it from cache instead of revalidating first.
      src: assets[currentTheme()] + (b && b.version ? "?v=" + encodeURIComponent(b.version) : ""),
      custom: false,
      showName: false,
      showSubtitle: Boolean(b && (b.subtitle || "").trim()),
    };
  }

  /**
   * Point an <img> at the right mark and tag it so CSS can size the two cases
   * differently — the Polaris art is a fixed-aspect wordmark, an operator's
   * upload is any shape at all.
   */
  function applyTo(img, b, surface, opts) {
    var r = resolve(b, surface);
    if (img) {
      // The accent URL is fixed (the upload route reuses one filename), so a
      // just-saved change is the same URL with different bytes — `bust` is how
      // the Customization tab forces the live sidebar to re-fetch it. Every
      // other surface picks the change up on its next load, since the route
      // answers no-cache and revalidates.
      if (opts && opts.bust) r.src = r.src + (r.src.indexOf("?") === -1 ? "?" : "&") + "t=" + Date.now();
      if (img.getAttribute("src") !== r.src) img.src = r.src;
      img.classList.toggle("brand-mark", !r.custom);
      img.classList.toggle("brand-mark-" + surface, !r.custom);
      img.alt = r.custom ? ((b && b.appName) || "") : "Polaris";
    }
    return r;
  }

  /**
   * Re-run `cb` whenever the effective theme changes — the in-app toggle
   * (which writes data-theme) or, for a user who has never chosen one, the OS
   * flipping light/dark.
   */
  function onThemeChange(cb) {
    var last = currentTheme();
    var fire = function () {
      var now = currentTheme();
      if (now === last) return;   // morning → noon is one family: no re-fetch
      last = now;
      cb(now);
    };
    // The `themechange` event _setTheme fires is the direct signal; the
    // observer additionally covers a theme set by other means (theme-init.js's
    // pre-CSS boot, the OS-preference listener above, another tab syncing).
    document.addEventListener("themechange", fire);
    try {
      new MutationObserver(fire).observe(document.documentElement, {
        attributes: true, attributeFilter: ["data-theme"],
      });
    } catch (e) { /* no MutationObserver — the event path still covers the picker */ }
  }

  /**
   * Follow the OS while the operator has no saved preference. Deliberately
   * does NOT write localStorage: staying unsaved is what keeps them tracking
   * the system, and the first use of the in-app toggle opts them out for good.
   */
  function followSystemTheme() {
    var mq;
    try { mq = global.matchMedia && global.matchMedia("(prefers-color-scheme: light)"); } catch (e) { return; }
    if (!mq) return;
    var handler = function () {
      if (savedTheme()) return;
      // A THEME ID, not the family — data-theme names a theme, and the
      // retired `light`/`dark` ids match no token block any more.
      document.documentElement.setAttribute("data-theme", preferredThemeId());
    };
    if (mq.addEventListener) mq.addEventListener("change", handler);
    else if (mq.addListener) mq.addListener(handler);
  }

  followSystemTheme();

  /**
   * Point the page's favicon at an operator's uploaded logo.
   *
   * Every page declares TWO icon links — an unconditional light-inked one and a
   * `media="(prefers-color-scheme: dark)"` light-inked override — because the
   * favicon renders in browser chrome, which follows the OS rather than
   * Polaris's own data-theme. That makes a `querySelector` swap wrong: it
   * updates only the first link, and on dark chrome the media link still wins,
   * so the custom logo silently wouldn't apply. Update ALL of them and drop the
   * `media` attribute, since one uploaded image serves both.
   *
   * No-op without a URL — never clear a working icon.
   */
  function setFavicon(url) {
    if (!url) return;
    var links = document.querySelectorAll('link[rel="icon"]');
    for (var i = 0; i < links.length; i++) {
      links[i].removeAttribute("media");
      links[i].href = url;
    }
  }

  global.PolarisBrandLogo = {
    ASSETS: ASSETS,
    setFavicon: setFavicon,
    currentTheme: currentTheme,
    preferredTheme: preferredTheme,
    preferredThemeId: preferredThemeId,
    savedTheme: savedTheme,
    isCustom: isCustom,
    customOn: customOn,
    resolve: resolve,
    applyTo: applyTo,
    onThemeChange: onThemeChange,
  };
})(window);
