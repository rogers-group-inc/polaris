/**
 * public/js/app-boot.js — Boot — LOADS LAST of the app-*.js files: admin-only UI, client-side
 * auto-logout, the DOMContentLoaded init, and the cached nav render that runs
 * at load (before first paint), which calls into every file above.
 *
 * Part of the app.js shell (CQ-F051): plain browser scripts sharing page
 * globals, loaded on every app page in APP_FILES order (app.js first,
 * app-boot.js last). See tests/unit/appSplit.test.ts.
 */

// ─── Admin-only UI ───────────────────────────────────────────────────────────

function hideAdminOnlyElements() {
  document.querySelectorAll("[data-admin-only]").forEach(function (el) {
    if (!isAdmin()) el.style.display = "none";
  });
  document.querySelectorAll("[data-manage-networks]").forEach(function (el) {
    if (!canManageNetworks()) el.style.display = "none";
  });
  document.querySelectorAll("[data-manage-blocks]").forEach(function (el) {
    if (!canManageBlocks()) el.style.display = "none";
  });
  document.querySelectorAll("[data-create-networks]").forEach(function (el) {
    if (!canCreateNetworks()) el.style.display = "none";
  });
  document.querySelectorAll("[data-manage-assets]").forEach(function (el) {
    if (!canManageAssets()) el.style.display = "none";
  });
  // Tagging is the Tags key's grant, not asset editing's (rule 141): the
  // bulk Tags button must not ride data-manage-assets.
  document.querySelectorAll("[data-manage-tags]").forEach(function (el) {
    if (!canManageTags()) el.style.display = "none";
  });
  // Separate from data-manage-assets for the same reason quarantine is:
  // deploying the Polaris Agent is its own key (`agentDeploy`), so a control
  // that pushes an installer onto a host must not ride the asset-editing
  // gate (an assets:write role would see a button that can only 403).
  document.querySelectorAll("[data-deploy-agent]").forEach(function (el) {
    if (!canDeployAgent()) el.style.display = "none";
  });
  // Separate from data-manage-assets: quarantine is its own function key, so a
  // control that pushes a MAC block must not ride the asset-editing gate.
  document.querySelectorAll("[data-quarantine-assets]").forEach(function (el) {
    if (!canQuarantineAssets()) el.style.display = "none";
  });
  document.querySelectorAll("[data-maintenance-mgmt]").forEach(function (el) {
    if (!canManageMaintenance()) el.style.display = "none";
  });
  document.querySelectorAll("[data-review-conflicts]").forEach(function (el) {
    if (!canReviewConflicts()) el.style.display = "none";
  });
  // Generic multi-key gate: `data-perm-any="assets:write,networkScan:read"`
  // hides the element unless AT LEAST ONE pair holds — the element-level twin
  // of the sidebar's `anyPerm` (see NAV_ITEMS). The single-key attributes
  // above stay as they are: each names one capability. This one exists for a
  // control that fronts two SEPARATELY gated things and so can't be expressed
  // by any of them — the Assets page's "+ Add Asset(s)" menu, whose two rows
  // are an asset form (`assets`) and a network Discovery (`networkScan`).
  document.querySelectorAll("[data-perm-any]").forEach(function (el) {
    var ok = (el.getAttribute("data-perm-any") || "").split(",").some(function (spec) {
      var parts = spec.trim().split(":");
      return parts.length === 2 && permAtLeast(parts[0].trim(), parts[1].trim());
    });
    if (!ok) el.style.display = "none";
  });
}

// ─── Client-side Auto-Logout ──────────────────────────────────────────────

var _autoLogoutTimer = null;
var _autoLogoutMs = 0;

function initAutoLogout() {
  api.auth.azureConfig().then(function (cfg) {
    if (!cfg || !cfg.autoLogoutMinutes || cfg.autoLogoutMinutes <= 0) return;
    _autoLogoutMs = cfg.autoLogoutMinutes * 60 * 1000;
    _resetAutoLogoutTimer();
    // Reset timer on user activity
    ["mousemove", "keydown", "click", "scroll", "touchstart"].forEach(function (evt) {
      document.addEventListener(evt, _resetAutoLogoutTimer, { passive: true });
    });
  }).catch(function () {});
}

function _resetAutoLogoutTimer() {
  if (_autoLogoutTimer) clearTimeout(_autoLogoutTimer);
  if (_autoLogoutMs <= 0) return;
  _autoLogoutTimer = setTimeout(function () {
    // Session expired client-side — logout
    // Raw fetch on purpose (CQ-F026): api.js's request() sends a 401 to /login.html,
    // and an already-expired session must still finish logging out and land here.
    fetch("/api/v1/auth/logout", { method: "POST", headers: _csrfHeaders() }).catch(function () {});
    window.location.href = "/signed-out.html?reason=inactivity";
  }, _autoLogoutMs);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

// Render nav immediately from cache so the sidebar doesn't flash on navigation.
// Restore the permission matrix + regions alongside the role NAME so the
// first `hideAdminOnlyElements()` call gates correctly — without this, every
// permission-gated element (Conflicts button, etc.) would be hidden until
// the post-fetch re-render and the change-detection branch below skipped
// re-rendering when only the matrix shifted. Returns what it rendered from,
// for the DOMContentLoaded handler's change detection; null on a cold cache.
function _renderNavFromCache() {
  try {
    var cachedUser = JSON.parse(localStorage.getItem("polaris-user") || "null");
    if (cachedUser && cachedUser.role) {
      currentUserRole = cachedUser.role;
      currentUserRoleColor = cachedUser.roleColor || null;
      currentUsername = cachedUser.username;
      currentRolePermissions = cachedUser.permissions || {};
      currentEffectiveRegions = Array.isArray(cachedUser.regions) ? cachedUser.regions : [];
      renderNav();
      hideAdminOnlyElements();
      // The cached logo and name too: renderNav paints them hidden until
      // branding arrives, so without this the rail would blink its brand
      // out and back on every page change.
      try {
        var cachedBranding = JSON.parse(localStorage.getItem("polaris-branding") || "null");
        if (cachedBranding) applyBranding(cachedBranding, true);
      } catch (_) {}
      return { role: cachedUser.role, perms: JSON.stringify(currentRolePermissions) };
    }
  } catch (_) {}
  return null;
}
var _navFromCache = null;

document.addEventListener("DOMContentLoaded", async function () {
  // Normally already done — at the end of this file, before first paint (see
  // the bottom). Here for a page whose #sidebar was not in the DOM yet then.
  if (!_navFromCache) _navFromCache = _renderNavFromCache();
  var roleBeforeFetch = _navFromCache ? _navFromCache.role : null;
  var permsBeforeFetch = _navFromCache ? _navFromCache.perms : null;

  // Wires the observer + backdrop guard and loads the preference under whatever
  // username the cache gave us (possibly none).
  if (typeof initPanelLock === "function") initPanelLock({ user: currentUsername });

  await fetchCurrentUser();

  // Re-key to the authoritative username, reload and re-sync the buttons. This
  // is why initPanelLock has to be idempotent rather than run-once.
  if (typeof initPanelLock === "function") initPanelLock({ user: currentUsername });

  // Re-render if the cache was cold OR the role name changed OR the matrix
  // shifted (an admin edited the role since the last cached snapshot).
  // Comparing the JSON-serialized matrix is cheap and avoids any
  // gated element staying hidden when the cold-path snapshot was stale.
  var permsAfterFetch = JSON.stringify(currentRolePermissions || {});
  if (!roleBeforeFetch || currentUserRole !== roleBeforeFetch || permsBeforeFetch !== permsAfterFetch) {
    renderNav();
    hideAdminOnlyElements();
  }
  // Page scripts that gate a control on permAtLeast() at DOMContentLoaded read
  // the CACHED snapshot (empty on a first login, stale after a role edit);
  // this is their cue to re-check against the authoritative one.
  // dashboard-saved.js's Dashboards ▾ menu was dead until it listened.
  document.dispatchEvent(new CustomEvent("polaris:user-loaded"));

  fetchBranding();
  initAutoLogout();
  checkCapacity();
  _bootAssistant();

  // Let each page's own DOMContentLoaded handler finish first, then consume
  // any #view=<type>:<id> or #ip=... hash a search click-through left us.
  setTimeout(processSearchHash, 0);
});

// ─── Build the rail before first paint ────────────────────────────────────────
// app.js loads at the end of <body>, so #sidebar is already in the DOM when this
// runs and everything above is defined. Building the rail from the cached user
// and branding HERE, rather than at DOMContentLoaded, puts a finished rail in
// the page's first paint. That is what the cross-document view transition
// (@view-transition in styles.css) snapshots: the sidebar is a named element
// that holds still across a page change, and a rail painted empty and filled
// a moment later would crossfade to blank and pop back in. Each page also
// holds its first paint until the parser reaches #polaris-nav-ready, the
// marker right after this script (<link rel="expect" blocking="render"> in
// its <head>), so the snapshot cannot be taken before this has run.
if (document.getElementById("sidebar")) _navFromCache = _renderNavFromCache();
// The AI assistant, drawn from cache in the same pre-paint pass so the
// page-change crossfade keeps it in place (assistant.js loads before app.js;
// _bootAssistant confirms or removes it once the user is fetched).
if (document.getElementById("sidebar") && window.PolarisAssistant) {
  try { window.PolarisAssistant.earlyMount(); } catch (_) { /* never block the page over it */ }
}
