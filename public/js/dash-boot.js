/**
 * public/js/dash-boot.js — slim app.js replacement for the Dash wallboard.
 *
 * dash.html loads this INSTEAD of app.js. The full app.js drags in the
 * sidebar nav (links to session-gated pages), logout, global search, and
 * several polling loops against endpoints the Dash listener doesn't mount.
 * This file provides exactly the globals the dashboard stack consumes
 * (dashboard.js, widgets/*, favorites.js, widget-library.js), each mirroring
 * its app.js original — keep behavior in lockstep when editing either side:
 *
 *   theme init                → app.js top-of-file IIFE
 *   theme band (corner)       → app.js advanceTheme / _setTheme / _advanceThemeBands
 *   currentUsername/role/perm → app.js fetchCurrentUser()
 *   userReady promise         → app.js
 *   permLevel/permAtLeast     → app.js
 *   isAdmin                   → app.js (always false here — no welcome modal)
 *   showToast                 → app.js (simplified: no copy button)
 *   timeAgo                   → app.js
 */

// ─── Theme (same key as the main app, so the wallboard follows the browser's
//     last-chosen Polaris theme) ─────────────────────────────────────────────
// A wallboard browser has usually never chosen a theme, so with nothing saved
// follow the OS ("morning" for a light preference, "nightfall" otherwise) —
// same rule as js/theme-init.js and app.js. A retired id (the old
// "dark"/"light") names no token block, so it falls back the same way.
(function () {
  var KNOWN = ["morning", "noon", "nightfall"];
  var saved = null;
  try { saved = localStorage.getItem("polaris-theme"); } catch (e) {}
  if (saved && KNOWN.indexOf(saved) === -1) saved = null;
  if (!saved) {
    var light = false;
    try { light = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches; } catch (e) {}
    saved = light ? "morning" : "nightfall";
  }
  document.documentElement.setAttribute("data-theme", saved);
})();

// The widgets the dash hosts share code with the dashboard's, which asks for
// the current theme's FAMILY. app.js is not loaded here, so supply the same
// accessor — afternoon included, since the corner band fades through it.
function isLightTheme(id) {
  var t = id || document.documentElement.getAttribute("data-theme");
  return t === "morning" || t === "noon" || t === "afternoon";
}
window.isLightTheme = isLightTheme;

// ─── Theme band (the ribbon across the bottom-left corner of dash.html) ─────
// The sidebar's band, minus the sidebar: one click steps morning → noon →
// nightfall, the strip travels forward to the new theme's hour and noon →
// nightfall fades through the afternoon waypoint. MIRRORS the band engine in
// app.js (THEMES / TRANSIT_THEMES / THEME_BAND_POS / _advanceThemeBands /
// advanceTheme / _setTheme) — the reasoning for every step lives there, and
// tests/unit/themeBandParity.test.ts holds the shared numbers equal. The one
// deliberate difference: the band here is ROTATED 45°, and getBoundingClientRect
// answers a rotated element's axis-aligned box, so this copy measures layout
// widths (getComputedStyle) instead.
var THEMES = ["morning", "noon", "nightfall"];
var TRANSIT_THEMES = ["afternoon"];
var THEME_BAND_POS = { noon: 0.056, afternoon: 0.306, nightfall: 0.556, morning: 0.806 };
var THEME_BAND_LABELS = { morning: "Morning", noon: "Noon", afternoon: "Afternoon", nightfall: "Nightfall" };
var THEME_FADE_MS = 800;
var THEME_LEG_MS = { morning: 1600 };
var GLOW_MS = 2000;
function _themeLegMs(id) { return THEME_LEG_MS[id] || THEME_FADE_MS; }

var _bandPos = null;
var _bandSeamTimer = null;
var _themeFadeTimer = null;
var _glowTurnTimer = null;
var _themeDest = null;
var _themeChainTimer = null;

function _layoutWidth(el) { return parseFloat(getComputedStyle(el).width) || 0; }

function _paintThemeBands(animate) {
  var tracks = document.querySelectorAll(".theme-band-track");
  for (var i = 0; i < tracks.length; i++) {
    var track = tracks[i];
    var copy = track.firstElementChild;
    var win = track.parentElement;
    if (!copy || !win) continue;
    var stripW = _layoutWidth(copy);
    if (!stripW) {
      if (!copy.complete) {
        copy.addEventListener("load", function () { _paintThemeBands(false); }, { once: true });
      }
      continue;
    }
    var x = _layoutWidth(win) / 2 - (_bandPos + 1) * stripW;
    if (animate) {
      track.style.transform = "translateX(" + x + "px)";
    } else {
      var prev = track.style.transition;
      track.style.transition = "none";
      track.style.transform = "translateX(" + x + "px)";
      void track.offsetWidth;
      track.style.transition = prev;
    }
  }
}

function _seatThemeBands() {
  if (_bandPos === null) _bandPos = THEME_BAND_POS[document.documentElement.getAttribute("data-theme")];
  if (_bandPos === undefined) _bandPos = THEME_BAND_POS.nightfall;
  _paintThemeBands(false);
}

function _advanceThemeBands(id, prevId) {
  var target = THEME_BAND_POS[id];
  if (target === undefined) return;
  if (_bandSeamTimer) {
    clearTimeout(_bandSeamTimer);
    _bandSeamTimer = null;
    if (_bandPos !== null && _bandPos >= 1) { _bandPos -= 1; _paintThemeBands(false); }
  }
  if (_bandPos === null) {
    var seat = THEME_BAND_POS[prevId];
    _bandPos = seat === undefined ? target : seat;
    _paintThemeBands(false);
    if (seat === undefined) return;
  }
  var forward = target - _bandPos;
  while (forward <= 0) forward += 1;
  _bandPos += forward;
  _paintThemeBands(true);
  if (_bandPos >= 1) {
    _bandSeamTimer = setTimeout(function () {
      _bandSeamTimer = null;
      _bandPos -= 1;
      _paintThemeBands(false);
    }, _themeLegMs(id));
  }
}

window.addEventListener("resize", function () {
  if (_bandPos !== null) _paintThemeBands(false);
});

function _markGlowTurn(fromId, toId) {
  var root = document.documentElement;
  root.setAttribute("data-glow-turn", fromId + "-" + toId);
  if (_glowTurnTimer) clearTimeout(_glowTurnTimer);
  _glowTurnTimer = setTimeout(function () {
    root.removeAttribute("data-glow-turn");
    _glowTurnTimer = null;
  }, GLOW_MS + 80);
}

function _prefersReducedMotion() {
  try {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch (e) { return false; }
}

function _themeViewTransitions() {
  try {
    return typeof document.startViewTransition === "function" &&
      typeof ViewTransition !== "undefined" && "types" in ViewTransition.prototype;
  } catch (e) { return false; }
}

function _beginThemeFade(phase, ms, viaViewTransition) {
  if (_prefersReducedMotion()) return;
  var root = document.documentElement;
  root.setAttribute("data-theme-fading", phase || "solo");
  if (viaViewTransition) root.removeAttribute("data-theme-xfade");
  else root.setAttribute("data-theme-xfade", "");
  if (_themeFadeTimer) clearTimeout(_themeFadeTimer);
  _themeFadeTimer = setTimeout(function () {
    root.removeAttribute("data-theme-fading");
    root.removeAttribute("data-theme-xfade");
    _themeFadeTimer = null;
  }, (ms || THEME_FADE_MS) + 80);
}

function _applyTheme(id, prevId) {
  document.documentElement.setAttribute("data-theme", id);
  // Waypoints are never saved: a reload mid-turn must land on a real theme.
  if (TRANSIT_THEMES.indexOf(id) === -1) { try { localStorage.setItem("polaris-theme", id); } catch (e) {} }
  _advanceThemeBands(id, prevId);
  var bands = document.querySelectorAll(".theme-band");
  for (var i = 0; i < bands.length; i++) {
    bands[i].setAttribute("aria-label", "Time of day: " + THEME_BAND_LABELS[id] + ". Move through the day.");
  }
  document.dispatchEvent(new CustomEvent("themechange", {
    detail: { theme: id, family: isLightTheme(id) ? "light" : "dark" },
  }));
}

function _setTheme(id, phase) {
  var prevId = document.documentElement.getAttribute("data-theme") || "nightfall";
  var change = id !== prevId;
  var legMs = _themeLegMs(id);
  var viaVT = change && !_prefersReducedMotion() && _themeViewTransitions();
  if (change) { _beginThemeFade(phase, legMs, viaVT); _markGlowTurn(prevId, id); }
  if (viaVT) {
    document.startViewTransition({
      update: function () { _applyTheme(id, prevId); },
      types: ["polaris-theme", "polaris-theme-" + (phase || "solo"),
              legMs > THEME_FADE_MS ? "polaris-theme-slow" : "polaris-theme-std"],
    });
  } else {
    _applyTheme(id, prevId);
  }
}

function _bandForwardGap(a, b) { return ((b - a) % 1 + 1) % 1; }

function advanceTheme() {
  if (_themeChainTimer) { clearTimeout(_themeChainTimer); _themeChainTimer = null; }
  var from = _themeDest || document.documentElement.getAttribute("data-theme");
  var i = THEMES.indexOf(from);
  var dest = THEMES[(i + 1) % THEMES.length];

  var a = THEME_BAND_POS[from] || 0;
  var span = _bandForwardGap(a, THEME_BAND_POS[dest] || 0) || 1;
  var stops = TRANSIT_THEMES
    .filter(function (t) {
      var d = _bandForwardGap(a, THEME_BAND_POS[t] || 0);
      return d > 0 && d < span;
    })
    .sort(function (x, y) {
      return _bandForwardGap(a, THEME_BAND_POS[x] || 0) - _bandForwardGap(a, THEME_BAND_POS[y] || 0);
    });

  _themeDest = dest;
  var queue = stops.concat([dest]);
  var legs = queue.length;
  var n = 0;
  (function step() {
    var phase = legs === 1 ? "solo" : (n === 0 ? "in" : (n === legs - 1 ? "out" : "mid"));
    n++;
    var leg = queue.shift();
    _setTheme(leg, phase);
    if (!queue.length) { _themeDest = null; return; }
    _themeChainTimer = setTimeout(step, _themeLegMs(leg));
  })();
}

// Delegated, as in app.js — the band is static markup in dash.html.
document.addEventListener("click", function (e) {
  if (e.target && e.target.closest && e.target.closest(".theme-band")) advanceTheme();
});
document.addEventListener("DOMContentLoaded", function () {
  var label = THEME_BAND_LABELS[document.documentElement.getAttribute("data-theme")];
  var bands = document.querySelectorAll(".theme-band");
  for (var i = 0; i < bands.length; i++) {
    bands[i].setAttribute("aria-label", "Time of day: " + label + ". Move through the day.");
  }
  _seatThemeBands();
});

// ─── Identity globals (populated from the Dash listener's synthetic
//     /auth/me, which answers as the built-in readonly role) ────────────────
var currentUserRole = null;
var currentRolePermissions = {};
var currentEffectiveRegions = [];
var currentUsername = null;
var _userReadyResolve = null;
var userReady = new Promise(function (resolve) { _userReadyResolve = resolve; });

async function fetchCurrentUser() {
  try {
    var base = window.__polarisApiBase || "/api/v1";
    var data = await fetch(base + "/auth/me").then(function (r) { return r.json(); });
    if (data.authenticated) {
      currentUserRole = (data.role && data.role.name) || null;
      currentRolePermissions = (data.role && data.role.permissions) || {};
      currentUsername = data.username;
      currentEffectiveRegions = (data.regionTags && data.regionTags.effective) || [];
    }
  } catch (_) {}
  if (_userReadyResolve) { _userReadyResolve(); _userReadyResolve = null; }
  return currentUserRole;
}

var _PERM_RANK = { none: 0, read: 1, write: 2, fullwrite: 3 };
function permLevel(key) { return currentRolePermissions[key] || "none"; }
function permAtLeast(key, level) {
  return (_PERM_RANK[permLevel(key)] || 0) >= (_PERM_RANK[level] || 0);
}
function isAdmin() { return false; }

// ─── Toasts + timeAgo ───────────────────────────────────────────────────────
// Both come from api.js (loaded before this file on dash.html) since the
// 2026-08 audit — the "simplified copy" forks that lived here had already
// drifted (6s hard remove, no copy button, class-based container lookup).

// ─── Branding (title, header text, and favicon follow the operator's
//     branding — favicon swap mirrors applyBranding in app.js) ───────────────
async function applyDashBranding() {
  try {
    var b = await api.serverSettings.getBranding();
    // The wallboard has no user identity, so the install-wide branding payload is
    // also how the temperature widget learns whether to render °C or °F.
    if (window.PolarisTempUnit) window.PolarisTempUnit.setFromBranding(b);
    var name = (b && b.appName) || "Polaris";
    document.title = name + " — Dash";
    var h = document.getElementById("dash-title");
    if (h) h.textContent = name + " Dashboard";
    // Inlined rather than calling PolarisBrandLogo.setFavicon: dash.html
    // deliberately loads a slim script set and not brand-logo.js. Two things
    // must hold anyway — swap only for an operator UPLOAD (the shipped default
    // is the light-inked symbol, which would vanish on light browser chrome),
    // and update BOTH declared links or the prefers-color-scheme override
    // still wins on dark chrome.
    if (b && b.customLogo && b.logoUrl) {
      var icons = document.querySelectorAll('link[rel="icon"]');
      for (var i = 0; i < icons.length; i++) {
        icons[i].removeAttribute("media");
        icons[i].href = b.logoUrl;
      }
    }
  } catch (_) {}
}

fetchCurrentUser();
document.addEventListener("DOMContentLoaded", applyDashBranding);
