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
 *   theme init + band engine  → SHARED, js/theme-core.js (this file is only
 *                               the corner band's host: measure + label)
 *   currentUsername/role/perm → app.js fetchCurrentUser() — deliberately NOT
 *                               shared: a synthetic readonly identity from
 *                               the Dash listener's /auth/me, no session
 *   userReady promise         → app.js
 *   permLevel/permAtLeast     → app.js
 *   isAdmin                   → app.js (always false here — no welcome modal)
 *   showToast                 → app.js (simplified: no copy button)
 *   timeAgo                   → app.js
 */

// ─── Theme ──────────────────────────────────────────────────────────────────
// The engine is js/theme-core.js, loaded right before this file — the same
// one the sidebar (app.js) and the phone (mobile/app.js) run, so the
// wallboard reads the same clock: same positions, same leg lengths, same
// forward-only travel and seam, same waypoint sweep. Same `polaris-theme`
// key, so the wallboard follows the browser's last-chosen Polaris theme; a
// wallboard browser has usually never chosen one, so with nothing saved it
// follows the OS. isLightTheme (which the hosted widgets ask) comes from
// theme-core.js too.
_applySavedTheme();

// ─── Theme band (the ribbon across the bottom-left corner of dash.html) ─────
// The sidebar's band, minus the sidebar. The one deliberate difference from
// app.js's host: the ribbon is ROTATED 45°, and getBoundingClientRect answers
// a rotated element's axis-aligned box, so this engine measures LAYOUT widths
// (getComputedStyle) instead — handed to the engine as `measure`.
function _layoutWidth(el) { return parseFloat(getComputedStyle(el).width) || 0; }

function _labelThemeBands(t) {
  var bands = document.querySelectorAll(".theme-band");
  for (var i = 0; i < bands.length; i++) {
    bands[i].setAttribute("aria-label", "Time of day: " + t.label + ". Move through the day.");
  }
}

var _themeEngine = createThemeEngine({
  track: ".theme-band-track",
  control: ".theme-band",
  measure: _layoutWidth,
  onApply: _labelThemeBands,
});

// The band is static markup in dash.html: name the theme showing and seat it
// once the markup exists. The click is delegated by the engine.
document.addEventListener("DOMContentLoaded", function () {
  _labelThemeBands(_getTheme(_getCurrentTheme()));
  _themeEngine.seat();
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
    // Raw fetch on purpose (CQ-F026): the wallboard has no app.js session and
    // calls its own base (/dash/api/v1); there is no login to redirect to.
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
