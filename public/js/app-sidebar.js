/**
 * public/js/app-sidebar.js — The sidebar's account and status surfaces: the user badge and account
 * menu, the Help link, branding, the operations panel (live firmware
 * flashes), the dismissible notices (role review, failed integrations, the
 * FortiManager proxy advisory, agent code signing, platform advisories),
 * in-app update progress and the capacity-critical alert.
 *
 * Part of the app.js shell (CQ-F051): plain browser scripts sharing page
 * globals, loaded on every app page in APP_FILES order (app.js first,
 * app-boot.js last). See tests/unit/appSplit.test.ts.
 */

function renderUserBadge() {
  if (!currentUsername) return;
  var header = document.querySelector(".page-header-actions");
  if (!header) {
    var pageHeader = document.querySelector(".page-header");
    if (!pageHeader) return;
    header = document.createElement("div");
    header.className = "page-header-actions";
    pageHeader.appendChild(header);
  }

  // Idempotent: drop any previously-rendered badge. renderNav (and hence this)
  // can fire more than once per page load (cache-warm-then-server path in
  // app.js; page-specific DOMContentLoaded handlers like map.js that re-run
  // renderNav after their own fetchCurrentUser).
  var existing = header.querySelectorAll(".user-badge");
  for (var i = 0; i < existing.length; i++) {
    // An open account menu is body-mounted and fixed, so it would outlive the
    // badge it hangs off. Close it here rather than leaving it anchored to a
    // detached node — scoped to THIS badge so a re-render can't shut a row
    // menu somewhere else on the page.
    if (_rowMenuTeardown && _rowMenuTeardown.anchor === existing[i]) closeRowMenu({ silent: true });
    existing[i].remove();
  }

  var initials = _getUserInitials(currentUsername);
  var color = _getInitialsColor(currentUsername);

  var roleLabel = _getRoleLabel(currentUserRole);
  // Prefer the role's stored color (survives renames + works for custom roles);
  // fall back to the legacy name-keyed badge class when no color is set.
  var roleColorStyle = roleBadgeStyleFromColor(currentUserRoleColor);
  var roleBadgeAttrs = roleColorStyle
    ? 'class="badge hue-pill" style="font-size:0.7rem;padding:1px 6px;' + roleColorStyle + '"'
    : 'class="badge ' + _getRoleBadgeClass(currentUserRole) + '" style="font-size:0.7rem;padding:1px 6px"';

  // The badge is the account menu's trigger — theme, notification preference
  // and logout hang off it rather than off the sidebar bottom, so per-account
  // actions sit with the account identity instead of with the navigation.
  var badge = document.createElement("button");
  badge.type = "button";
  badge.className = "user-badge user-menu-trigger";
  badge.setAttribute("aria-haspopup", "menu");
  badge.setAttribute("aria-expanded", "false");
  badge.innerHTML =
    '<div class="user-badge-avatar" style="background:' + color + '">' + escapeHtml(initials) + '</div>' +
    '<span class="user-badge-name">' + escapeHtml(currentUsername) + '</span>' +
    (roleLabel ? '<span ' + roleBadgeAttrs + '>' + escapeHtml(roleLabel) + '</span>' : '') +
    '<svg class="user-badge-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
  badge.title = currentUsername + ' (' + roleLabel + ')';
  badge.addEventListener("click", function () { openUserMenu(badge); });
  header.appendChild(badge);
  if (typeof _renderHelpButton === "function") _renderHelpButton(header, badge);
}

// The operator documentation, on the upstream project's GitHub wiki. It is a
// LINK OUT rather than a page Polaris serves, so it is not available on an
// air-gapped install — which is why every page's own behaviour is still
// discoverable in the UI and nothing here is load-bearing. The wiki's source
// lives in this repo under docs/wiki/ and is published from there; a fork
// serving its own documentation changes this one constant.
var WIKI_URL = "https://github.com/rogers-group-inc/polaris/wiki";

// Which wiki page documents the page the operator is on: the page file, then
// (for a tabbed page) the open tab, falling back to the wiki's Home. Page
// names are docs/wiki/*.md without the extension — a renamed wiki page must
// be renamed here too (check:wiki does not see this table).
var WIKI_PAGE_FOR = {
  "index": "Dashboard", "": "Dashboard",
  "ipam": "IPAM", "blocks": "IPAM", "subnets": "IPAM",
  "assets": "Assets",
  "map": "Device-Map",
  "appmap": "Application-Map",
  "path-monitor": "Path-Monitor",
  "events": "Events",
  "automations": "Automations",
  "integrations": "Integrations",
  "users": "Users-Roles-and-Permissions",
  "server-settings": "Server-Settings",
};
var WIKI_PAGE_FOR_TAB = {
  "automations": { delivery: "Delivery-Channels", scripts: "Automation-Scripts", contacts: "Address-Book" },
  "events": { calendar: "Maintenance-Windows" },
  "integrations": { agents: "Polaris-Agent" },
};

function _currentWikiPage() {
  var file = (location.pathname.split("/").pop() || "").replace(/\.html$/, "");
  var tabs = WIKI_PAGE_FOR_TAB[file];
  if (tabs) {
    var active = document.querySelector(".table-head-row .page-tab.active");
    var key = active && active.getAttribute("data-tab");
    if (key && tabs[key]) return tabs[key];
  }
  return WIKI_PAGE_FOR[file] || "";
}

// The Help button, left of the account badge: the wiki page for this page
// (and tab), in a new tab. It always renders — the wiki documents every page,
// and a reader who cannot find a feature is exactly who needs it.
function _renderHelpButton(header, badge) {
  var old = header.querySelector(".page-help-btn");
  if (old) old.remove();
  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn-secondary btn-icon-only page-help-btn";
  btn.title = "Help for this page (opens the Polaris wiki in a new tab)";
  btn.innerHTML = ICONS.help + "Help";
  btn.addEventListener("click", function () {
    var page = _currentWikiPage();
    // noopener: the wiki is a third-party origin and must not get a handle on
    // this window.
    window.open(WIKI_URL + (page ? "/" + page : ""), "_blank", "noopener");
  });
  header.insertBefore(btn, badge);
}

/**
 * The account menu behind the page-header user badge: notification
 * preference, timezone, page layout, credentials, help, logout. Items are built per open so
 * the preference / 2FA rows reflect current state without anything to keep
 * repainted. The theme
 * toggle lives at the bottom of the sidebar, not here — it is a display
 * preference rather than an account action, and an always-visible control
 * beats one behind a menu for something operators flip often.
 */
function openUserMenu(anchor) {
  if (typeof showRowMenu !== "function") return;

  var items = [];

  var pref = _notifPrefMenuItem(anchor);
  if (pref) items.push(pref);

  var tz = _tzMenuItem();
  if (tz) items.push(tz);

  var layout = _layoutMenuItem(anchor);
  if (layout) items.push(layout);

  // Credentials group: password first, then the second factor on it.
  var pw = _changePasswordMenuItem();
  if (pw) items.push(pw);

  var totp = _totpMenuItem();
  if (totp) items.push(totp);

  var passkeys = _passkeyMenuItem();
  if (passkeys) items.push(passkeys);

  // Help is no longer here: it is its own button left of this badge
  // (_renderHelpButton), opening the wiki page for the page it is on.

  // Only separate Logout from something — with no preference or 2FA row the
  // menu is Logout alone, and a leading rule would be a divider above nothing.
  if (items.length) items.push({ separator: true });
  items.push({
    label: "Logout",
    icon: ICONS.logout,
    danger: true,
    onSelect: function () {
      // Raw fetch on purpose (CQ-F026): api.js's request() sends a 401 to /login.html,
      // and an already-expired session must still finish logging out and land here.
      fetch("/api/v1/auth/logout", { method: "POST", headers: _csrfHeaders() })
        .catch(function () { /* log out locally regardless */ })
        .then(function () { window.location.href = "/signed-out.html"; });
    },
  });

  showRowMenu(anchor, items, { label: "Account menu", align: "end" });
}

// ─── Branding ──────────────────────────────────────────────────────────────

var _branding = null;

function applyBranding(b, skipCache) {
  if (!b) return;
  _branding = b;
  if (!skipCache) {
    try { localStorage.setItem("polaris-branding", JSON.stringify(b)); } catch (_) {}
  }
  // Hardware-sensor display unit rides the branding payload — hand it to the
  // converter now so a changed preference (or a first load with no cached
  // branding) takes effect on this page without a reload.
  if (window.PolarisTempUnit) window.PolarisTempUnit.setFromBranding(b);

  // Update sidebar logo + name. Which mark (operator's logo vs the shipped
  // Polaris art for the current theme) and whether the name is text at all are
  // PolarisBrandLogo's call — see public/js/brand-logo.js.
  var sidebarLogo = document.querySelector(".sidebar-logo");
  var placement = window.PolarisBrandLogo
    ? PolarisBrandLogo.applyTo(sidebarLogo, b, "sidebar")
    : { showName: true, showSubtitle: Boolean(b.subtitle) };
  if (sidebarLogo) sidebarLogo.style.visibility = "";
  var sidebarName = document.querySelector(".sidebar-brand h1");
  if (sidebarName) {
    sidebarName.textContent = b.appName || "Polaris";
    sidebarName.style.display = placement.showName ? "" : "none";
    sidebarName.style.visibility = "";
  }
  var sidebarSub = document.querySelector(".sidebar-brand p");
  if (sidebarSub) {
    sidebarSub.textContent = b.subtitle || "";
    sidebarSub.style.display = placement.showSubtitle ? "" : "none";
    sidebarSub.style.visibility = "";
  }

  // Update page title
  var titleEl = document.querySelector("title");
  if (titleEl) {
    var current = titleEl.textContent;
    // Replace "Polaris — X" or "AppName — X" pattern
    var dashIdx = current.indexOf(" \u2014 ");
    if (dashIdx === -1) dashIdx = current.indexOf(" — ");
    if (dashIdx !== -1) {
      titleEl.textContent = (b.appName || "Polaris") + current.substring(dashIdx);
    } else {
      titleEl.textContent = b.appName || "Polaris";
    }
  }

  // Favicon follows an operator's UPLOAD only. The `customLogo` check is
  // load-bearing: the shipped default logoUrl is now the light-inked symbol
  // (for the PWA icon's dark canvas), so swapping it in unconditionally — as
  // this did while the default was the same file the page already declared —
  // would force light ink onto light browser chrome and make the icon vanish.
  // setFavicon updates BOTH declared links; see brand-logo.js.
  if (b.customLogo && b.logoUrl && window.PolarisBrandLogo) {
    PolarisBrandLogo.setFavicon(b.logoUrl);
  }

  // Update version in sidebar
  var versionEl = document.getElementById("sidebar-version");
  if (versionEl && b.version) {
    versionEl.textContent = "v" + b.version;
  }

  // Check for available updates (admin only)
  if (isAdmin()) checkSidebarUpdate();
}

// Swap the sidebar mark when the theme flips (the toggle, or the OS changing
// under a user who never picked one) — the Polaris art is theme-specific and
// the wrong variant is near-invisible. Logo only: applyBranding also kicks an
// update check, which has nothing to do with a color scheme.
if (window.PolarisBrandLogo) {
  PolarisBrandLogo.onThemeChange(function () {
    if (_branding) PolarisBrandLogo.applyTo(document.querySelector(".sidebar-logo"), _branding, "sidebar");
  });
}

async function fetchBranding() {
  try {
    var cached = JSON.parse(localStorage.getItem("polaris-branding") || "null");
    // Skipped when the early rail render (_renderNavFromCache) already put it
    // on the page: each apply kicks an admin update check.
    if (cached && !_branding) applyBranding(cached, true);
  } catch (_) {}
  try {
    var b = await api.serverSettings.getBranding();
    applyBranding(b);
  } catch (_) {
    if (!_branding) applyBranding({ appName: "Polaris", subtitle: "Network Management Tool", logoUrl: "/img/brand/polaris-symbol-dark.png", version: "" });
  }
}

async function checkSidebarUpdate() {
  try {
    var status = await api.serverSettings.getUpdateStatus();
    var versionEl = document.getElementById("sidebar-version");
    if (!versionEl) return;

    // Remove any existing update badge
    var existing = document.getElementById("sidebar-update-badge");
    if (existing) existing.remove();

    if (status.state === "available") {
      var badge = document.createElement("div");
      badge.id = "sidebar-update-badge";
      badge.innerHTML =
        '<a href="/server-settings.html?tab=database" class="sidebar-update-link">' +
          '<span class="sidebar-update-dot"></span>' +
          'Update available: v' + escapeHtml(status.latestVersion) +
        '</a>';
      versionEl.parentNode.insertBefore(badge, versionEl.nextSibling);
    }
  } catch (_) {}
}

function renderQueryStatus() {
  var container = document.getElementById("query-status");
  if (!container) return;

  var serverDiscoveries = (window._getServerDiscoveries && window._getServerDiscoveries()) || [];
  var firmwareRuns = (window._getFirmwareRuns && window._getFirmwareRuns()) || [];
  var totalCount = activeQueries.length + serverDiscoveries.length + firmwareRuns.length;

  if (!totalCount) {
    container.style.display = "none";
    container.innerHTML = "";
    return;
  }

  var queryCount = activeQueries.length;
  var discoveryCount = serverDiscoveries.length;
  var firmwareCount = firmwareRuns.length;
  var kinds = (queryCount > 0 ? 1 : 0) + (discoveryCount > 0 ? 1 : 0) + (firmwareCount > 0 ? 1 : 0);
  var labelText;
  if (kinds > 1) {
    labelText = totalCount + ' operation' + (totalCount === 1 ? '' : 's') + ' running';
  } else if (firmwareCount > 0) {
    labelText = firmwareCount + ' firmware upgrade' + (firmwareCount === 1 ? '' : 's') + ' running';
  } else if (discoveryCount > 0) {
    labelText = discoveryCount + ' discover' + (discoveryCount === 1 ? 'y' : 'ies') + ' running';
  } else {
    labelText = queryCount + ' quer' + (queryCount === 1 ? 'y' : 'ies') + ' running';
  }
  var canAbortFirmware = permAtLeast("assets", "write");

  container.style.display = "block";
  container.innerHTML =
    '<div class="query-status-header">' +
      '<span class="query-spinner"></span>' +
      '<span class="query-status-label">' + labelText + '</span>' +
    '</div>' +
    '<ul class="query-status-list">' +
      activeQueries.map(function (q) {
        return '<li>' +
          '<span class="query-status-name">' + escapeHtml(q.label) + '</span>' +
          '<button class="query-abort-btn" data-qid="' + q.id + '" title="Abort">&#x2715;</button>' +
        '</li>';
      }).join("") +
      serverDiscoveries.map(function (d) {
        var slowSet = {};
        if (d.slowDevices) d.slowDevices.forEach(function (name) { slowSet[name] = true; });
        var nameClass = d.slow ? 'query-status-name query-status-name-slow' : 'query-status-name';
        var nameTitle = d.slow ? ' title="This discovery is running longer than normal"' : '';
        // FMG-only progress summary: "N/M complete · K offline · J unread".
        // Standalone FortiGate discoveries are a single device — counts add
        // no information there. Each skip count is shown only when non-zero so
        // the common case stays compact.
        //
        // The two are NOT interchangeable and must never be summed into one
        // "skipped" figure again. Offline is routine on a Fortinet estate — a
        // staged gate awaiting deployment sits offline in FMG for weeks and
        // discovery deliberately pulls its cached CMDB config instead. UNREAD
        // means discovery never reached the device at all: it silently keeps
        // the data from whenever it was last read, while monitoring dials its
        // IP and reports it healthy. Rolling the two together is what let an
        // 1801F HA pair sit on stale firmware unnoticed (prod 2026-09).
        var progressLine = '';
        if (d.type === 'fortimanager' && d.totalDevices != null) {
          var done = d.completedCount || 0;
          var skipOff = d.skippedOfflineCount || 0;
          var skipErr = d.skippedErrorCount || 0;
          var parts = [done + '/' + d.totalDevices + ' complete'];
          if (skipOff > 0) parts.push(skipOff + ' offline');
          if (skipErr > 0) parts.push(skipErr + ' unread');
          progressLine = '<span class="query-status-progress">' + escapeHtml(parts.join(' · ')) + '</span>';
        }
        return '<li><div style="min-width:0;flex:1">' +
          '<span class="' + nameClass + '"' + nameTitle + '>Discovering ' + escapeHtml(d.name) + (d.slow ? ' — slow' : '') + '</span>' +
          progressLine +
          (d.activeDevices && d.activeDevices.length ? d.activeDevices.map(function (dev) {
            var cls = 'query-status-device query-status-device-link' + (slowSet[dev] ? ' query-status-device-slow' : '');
            var t = slowSet[dev]
              ? ' title="This FortiGate is taking longer than normal — click to open asset details"'
              : ' title="Open asset details"';
            return '<span class="' + cls + '"' + t +
              ' role="button" tabindex="0" data-device-name="' + escapeHtml(dev) + '">' +
              escapeHtml(dev) + '</span>';
          }).join('') : '') +
          '</div>' +
          '<button class="query-abort-btn" data-discovery-id="' + escapeHtml(d.id) + '" data-discovery-name="' + escapeHtml(d.name) + '" title="Abort">&#x2715;</button>' +
          '</li>';
      }).join("") +
      firmwareRuns.map(function (r) {
        var aborting = !!r.abortRequestedBy || !!_firmwareAborting[r.id];
        var parts = ['by ' + r.startedBy, aborting ? 'aborting…' : firmwareStageLabel(r.stage)];
        var pct = !aborting && firmwareFlashPercent(r.progress);
        if (pct) parts.push(pct);
        return '<li><div style="min-width:0;flex:1">' +
          '<span class="query-status-name">Upgrading ' +
            '<span class="query-status-device-link" role="button" tabindex="0" data-fw-asset-id="' + escapeHtml(r.assetId) + '" title="Open asset details">' + escapeHtml(r.assetName) + '</span>' +
            ' → ' + escapeHtml(r.toVersion) +
          '</span>' +
          '<span class="query-status-progress">' + escapeHtml(parts.join(' · ')) + '</span>' +
          '</div>' +
          (canAbortFirmware && !aborting
            ? '<button class="query-abort-btn" data-fw-run-id="' + escapeHtml(r.id) + '" title="Abort the firmware upgrade">&#x2715;</button>'
            : '') +
          '</li>';
      }).join("") +
    '</ul>' +
    (activeQueries.length > 1
      ? '<button class="query-abort-all-btn" id="abort-all-btn">Abort All</button>'
      : '');

  container.querySelectorAll(".query-abort-btn").forEach(function (btn) {
    btn.addEventListener("click", async function () {
      var discoveryId = btn.getAttribute("data-discovery-id");
      if (discoveryId) {
        var discoveryName = btn.getAttribute("data-discovery-name") || "discovery";
        var ok = await showConfirm('Abort discovery of "' + discoveryName + '"?');
        if (!ok) return;
        try { await api.integrations.abortDiscover(discoveryId); } catch (_) {}
        return;
      }
      var fwRunId = btn.getAttribute("data-fw-run-id");
      if (fwRunId) {
        var run = firmwareRuns.find(function (x) { return x.id === fwRunId; });
        if (run) await abortFirmwareRunFromPanel(run);
        return;
      }
      var qid = parseFloat(btn.getAttribute("data-qid"));
      var q = activeQueries.find(function (x) { return x.id === qid; });
      if (!q) return;
      var ok = await showConfirm('Abort "' + q.label + '"?');
      if (!ok) return;
      q.controller.abort();
      _unregisterQuery(qid);
    });
  });

  var abortAllBtn = document.getElementById("abort-all-btn");
  if (abortAllBtn) {
    abortAllBtn.addEventListener("click", async function () {
      var ok = await showConfirm("Abort all running operations?");
      if (ok) abortAllQueries();
    });
  }

  // Clicking (or Enter/Space on) a FortiGate name in the discovery popup opens
  // that firewall's asset slide-over.
  // A firmware row's asset name carries the asset id, so it opens directly.
  container.querySelectorAll(".query-status-device-link").forEach(function (el) {
    var open = function () {
      var assetId = el.getAttribute("data-fw-asset-id");
      if (assetId) openAssetById(assetId);
      else openDiscoveryDevice(el.getAttribute("data-device-name"));
    };
    el.addEventListener("click", open);
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
  });
}

// ─── Live firmware flashes in the operations panel (business rule 138) ─────

// Runs this tab has asked to abort and is waiting on — the row says
// "aborting…" at once instead of after the next poll.
var _firmwareAborting = {};

var FIRMWARE_STAGE_LABELS = {
  preflight: "checking the device",
  staging: "uploading the image",
  compat: "checking compatibility",
  deploying: "flashing",
  rebooting: "rebooting",
  verifying: "verifying the new version",
  recovering: "waiting for monitoring",
};

function firmwareStageLabel(stage) {
  return FIRMWARE_STAGE_LABELS[stage] || (stage ? stage : "starting");
}

// The flash's own percent (a FortiSwitch reports erase / write / verify /
// restart), naming the latest phase that has moved; "" when it reports none.
function firmwareFlashPercent(progress) {
  if (!progress) return "";
  var order = ["restart", "verify", "write", "erase"];
  for (var i = 0; i < order.length; i++) {
    var v = progress[order[i]];
    if (typeof v === "number" && v > 0) return order[i] + " " + Math.round(v) + "%";
  }
  return "";
}

// Stages after which the device has been told to flash and carries on by
// itself — the confirm says so rather than promising the device is untouched.
var FIRMWARE_FLASHING_STAGES = { deploying: true, rebooting: true, verifying: true, recovering: true };

async function abortFirmwareRunFromPanel(run) {
  var name = run.assetName;
  var msg;
  if (FIRMWARE_FLASHING_STAGES[run.stage]) {
    msg = name + " has already been told to flash. Aborting stops Polaris following it and ends its maintenance window, " +
      "but the device keeps flashing and reboots on its own, and alerts may fire while it does.\n\n" +
      "Verify its version afterwards. Abort the firmware upgrade anyway?";
  } else if (run.stage === "staging") {
    msg = "Abort the firmware upgrade of " + name + "?\n\n" +
      "The image is still uploading. A FortiSwitch is left on its current firmware. A FortiGate or FortiAP starts flashing " +
      "as soon as the whole image has arrived, so if the upload has just finished it may already be flashing.";
  } else {
    msg = "Abort the firmware upgrade of " + name + "?\n\nThe device has not been flashed and keeps its current firmware.";
  }
  if (!await showConfirm(msg)) return;
  _firmwareAborting[run.id] = true;
  renderQueryStatus();
  try {
    var res = await api.assets.abortFirmwareRun(run.assetId, run.id);
    var ended = res && res.run;
    showToast(ended && ended.status === "failed" ? "Firmware upgrade of " + name + " aborted" : "Abort sent — the upgrade of " + name + " is stopping", "success");
  } catch (err) {
    showToast("Couldn't abort the upgrade of " + name + ": " + ((err && err.message) || "request failed"), "error");
  } finally {
    delete _firmwareAborting[run.id];
    if (typeof window._pollFirmwareRuns === "function") await window._pollFirmwareRuns();
  }
}

function openAssetById(assetId) {
  // PolarisPanels loads the asset bundle when this page has not (yet) — the
  // dashboard and maps prefetch it (CQ-F041) — and falls back to the deep link.
  if (typeof openViewModal === "function") openViewModal(assetId);
  else PolarisPanels.openAsset(assetId);
}

// Resolve a discovery "currently querying" FortiGate name to its Asset and open
// the asset details slide-over. The popup surfaces FortiGate device names, which
// equal the firewall Asset's hostname (see connectionPathService's hostname
// lookup). On the Assets page we open the slide-over in place; elsewhere we
// route through the same #view=asset: hash the global search uses, so
// processSearchHash opens it after navigation. No match (the transient FMG
// self-entry, or a FortiGate not yet inventoried) surfaces a toast rather than
// failing silently.
async function openDiscoveryDevice(name) {
  if (!name) return;
  var list;
  try {
    var rows = await api.assets.list({ search: name, limit: 25 });
    list = Array.isArray(rows) ? rows : (rows && rows.assets) || [];
  } catch (_) {
    showToast("Couldn't look up " + name, "error");
    return;
  }
  var lower = name.toLowerCase();
  var match =
    list.find(function (a) { return (a.hostname || "").toLowerCase() === lower && a.assetType === "firewall"; }) ||
    list.find(function (a) { return (a.hostname || "").toLowerCase() === lower; }) ||
    list.find(function (a) { return (a.dnsName || "").toLowerCase() === lower; });
  if (!match) {
    showToast("No matching asset for " + name, "error");
    return;
  }
  openAssetById(match.id);
}

// ─── New-user role-review notifications ────────────────────────────────────
// Renders the admin-only "new user — review role" panel in the sidebar.
// Reads from the closure-scoped _roleReviewUsers array populated by
// pollRoleReviewNotifications above. Each row has a per-user dismiss button
// that hits DELETE /users/:id/role-review (global dismiss).

function renderRoleReviewStatus() {
  var container = document.getElementById("role-review-status");
  if (!container) return;
  var users = (window._getRoleReviewUsers && window._getRoleReviewUsers()) || [];
  if (!users.length) {
    container.style.display = "none";
    container.innerHTML = "";
    return;
  }
  container.style.display = "block";
  var label = users.length === 1 ? "new user logged in" : "new users logged in";
  container.innerHTML =
    '<div class="query-status-header role-review-header">' +
      '<span class="role-review-icon">&#x2728;</span>' +
      '<span class="query-status-label">' + users.length + ' ' + label + '</span>' +
    '</div>' +
    '<ul class="query-status-list">' +
      users.map(function (u) {
        var who = u.displayName ? (u.displayName + ' (' + u.username + ')') : u.username;
        var roleName = (u.role && typeof u.role === 'object') ? (u.role.name || 'readonly')
          : (typeof u.role === 'string' ? u.role : 'readonly');
        var sub = 'Role: ' + roleName + (u.authProvider === 'azure' ? ' · SSO' : '');
        return '<li><div style="min-width:0;flex:1">' +
          '<span class="query-status-name" title="' + escapeHtml(who) + '">' + escapeHtml(who) + '</span>' +
          '<span class="query-status-progress">' + escapeHtml(sub) + ' — may need role change</span>' +
          '</div>' +
          '<button class="query-abort-btn role-review-dismiss" data-user-id="' + escapeHtml(u.id) + '" title="Dismiss">&#x2715;</button>' +
          '</li>';
      }).join("") +
    '</ul>';

  container.querySelectorAll(".role-review-dismiss").forEach(function (btn) {
    btn.addEventListener("click", async function () {
      var uid = btn.getAttribute("data-user-id");
      if (!uid) return;
      btn.disabled = true;
      try {
        await api.users.dismissRoleReview(uid);
      } catch (_) {
        btn.disabled = false;
        return;
      }
      if (typeof window._pollRoleReviewNotifications === "function") {
        window._pollRoleReviewNotifications();
      }
    });
  });
}

// ─── Failed-integration notice ──────────────────────────────────────────────
// Renders the sidebar panel listing integrations whose latest credential test
// failed. Reads from the closure-scoped _failedIntegrations array populated by
// pollFailedIntegrations above. Clicking the panel navigates to
// /integrations.html so the operator can inspect and re-test.

function renderIntegrationFailedStatus() {
  var container = document.getElementById("integration-failed-status");
  if (!container) return;
  var failed = (window._getFailedIntegrations && window._getFailedIntegrations()) || [];
  if (!failed.length) {
    container.style.display = "none";
    container.innerHTML = "";
    return;
  }
  container.style.display = "block";
  var label = failed.length === 1 ? "integration not reachable" : "integrations not reachable";
  function typeLabel(t) {
    if (t === "fortimanager") return "FortiManager";
    if (t === "fortigate") return "FortiGate";
    if (t === "windowsserver") return "Windows Server";
    if (t === "entraid") return "Entra ID";
    if (t === "activedirectory") return "Active Directory";
    if (t === "vcenter") return "vCenter";
    if (t === "azurearc") return "Azure Arc";
    if (t === "unraid") return "Unraid";
    if (t === "truenas") return "TrueNAS SCALE";
    if (t === "proxmox") return "Proxmox VE";
    if (t === "genericapi") return "Generic API";
    if (t === "llm") return "AI Assistant";
    return t || "";
  }
  container.innerHTML =
    '<div class="query-status-header integration-failed-header">' +
      '<span class="integration-failed-icon" aria-hidden="true">&#9888;</span>' +
      '<span class="query-status-label">' + failed.length + ' ' + label + '</span>' +
    '</div>' +
    '<ul class="query-status-list">' +
      failed.map(function (i) {
        var sub = typeLabel(i.type);
        if (i.lastTestAt) {
          var when = new Date(i.lastTestAt);
          if (!isNaN(when.getTime())) sub += ' · last test ' + formatDateTime(when);
        } else {
          sub += ' · never tested';
        }
        return '<li><div style="min-width:0;flex:1">' +
          '<span class="query-status-name integration-failed-name" title="' + escapeHtml(i.name) + '">' + escapeHtml(i.name) + '</span>' +
          '<span class="query-status-progress">' + escapeHtml(sub) + '</span>' +
          '</div></li>';
      }).join("") +
    '</ul>';

  // Whole panel clicks through to the integrations page. Skip clicks that
  // originated on a button (defensive — there are none today, but parity with
  // the role-review panel pattern).
  container.style.cursor = "pointer";
  container.onclick = function (e) {
    if (e.target && e.target.tagName === "BUTTON") return;
    window.location.href = "/integrations.html";
  };
}

// ─── FortiManager proxy-transport advisory ──────────────────────────────────
// A FortiManager integration on the proxy transport funnels every per-device
// live query through /sys/proxy/json, which FMG serializes at concurrency 1 —
// so poll time grows linearly with the managed-gate count. Past the server's
// threshold that is the wrong transport, and the operator should know without
// having to open the integration modal to read the hint inside it.
//
// Deliberately about THROUGHPUT, not capability. Proxy mode's inability to
// collect a FortiGate's REST streams is a separate (and fixable) matter; if
// this copy claimed "proxy can't monitor", it would read as wrong the moment
// that lands.
//
// Dismissible, unlike the capacity banner: this is advice, and an operator who
// has consciously chosen proxy mode should be able to silence it. Dismissal is
// per-user and keyed on the integration id + gate count, so adding gates to an
// already-dismissed integration re-raises it.
function _fmgProxyAdviceDismissKey() {
  return "polaris.fmg-proxy-advice.dismissed." + (currentUsername || "anon");
}

function renderFmgProxyAdvice() {
  var container = document.getElementById("fmg-proxy-advice");
  if (!container) return;
  var advice = (window._getFmgProxyAdvice && window._getFmgProxyAdvice()) || [];

  // Signature changes when a gate is added/removed, so the advisory returns
  // after the fleet grows rather than staying silenced forever.
  var signature = advice.map(function (a) { return a.id + ":" + a.managedFortigates; }).join(",");
  var dismissed = null;
  try { dismissed = localStorage.getItem(_fmgProxyAdviceDismissKey()); } catch (_) {}

  if (!advice.length || dismissed === signature) {
    container.style.display = "none";
    container.innerHTML = "";
    container.onclick = null;
    return;
  }

  container.style.display = "block";
  container.innerHTML =
    '<div class="query-status-header fmg-proxy-advice-header">' +
      '<span class="fmg-proxy-advice-icon" aria-hidden="true">&#9888;</span>' +
      '<span class="query-status-label">Consider bypassing the FortiManager proxy</span>' +
      '<button class="query-abort-btn fmg-proxy-advice-dismiss" title="Dismiss (re-appears as the fleet grows)">&#x2715;</button>' +
    '</div>' +
    '<ul class="query-status-list">' +
      advice.map(function (a) {
        return '<li><div style="min-width:0;flex:1">' +
          '<span class="query-status-name" title="' + escapeHtml(a.name) + '">' + escapeHtml(a.name) + '</span>' +
          '<span class="query-status-progress">' + a.managedFortigates + ' FortiGates · proxy polls them one at a time</span>' +
          '</div></li>';
      }).join("") +
    '</ul>';

  var dismissBtn = container.querySelector(".fmg-proxy-advice-dismiss");
  if (dismissBtn) {
    dismissBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      try { localStorage.setItem(_fmgProxyAdviceDismissKey(), signature); } catch (_) {}
      renderFmgProxyAdvice();
    });
  }

  container.style.cursor = "pointer";
  container.onclick = function (e) {
    if (e.target && e.target.tagName === "BUTTON") return;
    window.location.href = "/integrations.html";
  };
}

// ─── Agent code-signing failure alert ───────────────────────────────────────
// Renders the dismissable sidebar alert when the last agent build shipped
// unsigned Windows binaries (fail-open signing). Reads the closure-scoped
// _signingFailure populated by pollSigningAlert. Dismissal is per-user +
// per-failure via localStorage: the key stores the failure's `at` stamp, so
// dismissing hides THIS failure across reloads while a new failure (different
// stamp) re-surfaces the panel. Clicking through opens the Polaris Agents card.

function _signingAlertDismissKey() {
  return "polaris.signing-alert.dismissed." + (currentUsername || "anon");
}

function renderSigningFailureAlert() {
  var container = document.getElementById("signing-failure-alert");
  if (!container) return;
  var failure = (window._getSigningFailure && window._getSigningFailure()) || null;

  var dismissedAt = null;
  try { dismissedAt = localStorage.getItem(_signingAlertDismissKey()); } catch (_) {}

  if (!failure || dismissedAt === failure.at) {
    container.style.display = "none";
    container.innerHTML = "";
    container.onclick = null;
    return;
  }

  var when = new Date(failure.at);
  var sub = "v" + (failure.version || "?");
  if (!isNaN(when.getTime())) sub += " · " + formatDateTime(when);
  container.style.display = "block";
  container.innerHTML =
    '<div class="query-status-header signing-failure-header">' +
      '<span class="signing-failure-icon" aria-hidden="true">&#9888;</span>' +
      '<span class="query-status-label">Agent code signing failed</span>' +
      '<button class="query-abort-btn signing-failure-dismiss" title="Dismiss (re-appears on a new failure)">&#x2715;</button>' +
    '</div>' +
    '<ul class="query-status-list">' +
      '<li><div style="min-width:0;flex:1">' +
        '<span class="query-status-name">Windows agent binaries shipped UNSIGNED</span>' +
        '<span class="query-status-progress" title="' + escapeHtml(failure.error || "") + '">' + escapeHtml(sub) + '</span>' +
      '</div></li>' +
    '</ul>';

  var dismissBtn = container.querySelector(".signing-failure-dismiss");
  if (dismissBtn) {
    dismissBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      try { localStorage.setItem(_signingAlertDismissKey(), failure.at); } catch (_) {}
      renderSigningFailureAlert();
    });
  }

  // Click-through to the Polaris Agents card (Integrations → Polaris Agents),
  // where the Code signing pane names the specific problem.
  container.style.cursor = "pointer";
  container.onclick = function (e) {
    if (e.target && e.target.tagName === "BUTTON") return;
    window.location.href = "/integrations.html";
  };
}

// ─── Open security advisories (platform) ────────────────────────────────────
// Renders one dismissable sidebar alert PER installed component with an open
// security advisory, into the #platform-advisory-alert wrapper. Reads the
// closure-scoped _platformAdvisories populated by pollPlatformAdvisories.
//
// Dismissal is per-user and per-ADVISORY: localStorage holds the
// "<component>:<CVE>" pairs the user has dismissed, and a component's alert
// returns only when one of ITS pairs is outside that set. Dismissing Node
// leaves PostgreSQL's alert alone, and upgrading within a line while the same
// CVEs stay open is not news. An exact-match signature (the FortiManager
// advice's shape) would get both wrong.
//
// Coloured by the vendor's worst CVE rating alone — high/critical red, medium
// amber, low blue — NOT by the card's grade, which adds a step for a
// network-exposed component. The sidebar answers "how bad are these CVEs".

var _ADVISORY_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

function _platformAdvisoryDismissKey() {
  return "polaris.platform-advisories.dismissed." + (currentUsername || "anon");
}

function _platformAdvisoryPairs(c) {
  return (c.grade.securityFloor.advisories || []).map(function (a) { return c.id + ":" + a.id; });
}

function _platformAdvisoryTint(rating) {
  if (rating === "critical" || rating === "high") return "red";
  if (rating === "medium") return "amber";
  return "watch";
}

function _worstAdvisoryRating(advisories) {
  var worst = null;
  (advisories || []).forEach(function (a) {
    if (worst === null || (_ADVISORY_RANK[a.severity] ?? -1) > (_ADVISORY_RANK[worst] ?? -1)) worst = a.severity;
  });
  return worst;
}

function renderPlatformAdvisoryAlert() {
  var container = document.getElementById("platform-advisory-alert");
  if (!container) return;
  var components = (window._getPlatformAdvisories && window._getPlatformAdvisories()) || [];

  var dismissed = [];
  try { dismissed = JSON.parse(localStorage.getItem(_platformAdvisoryDismissKey()) || "[]"); } catch (_) {}
  if (!Array.isArray(dismissed)) dismissed = [];

  var shown = components.filter(function (c) {
    return _platformAdvisoryPairs(c).some(function (p) { return dismissed.indexOf(p) === -1; });
  });

  if (!shown.length) {
    container.style.display = "none";
    container.innerHTML = "";
    return;
  }

  container.style.display = "block";
  container.innerHTML = shown.map(function (c, i) {
    var sf = c.grade.securityFloor;
    var n = (sf.advisories || []).length;
    var rating = _worstAdvisoryRating(sf.advisories);
    var ids = (sf.advisories || []).map(function (a) { return a.id + " (" + a.severity + ")"; }).join(", ");
    return '<div class="query-status platform-advisory-alert platform-advisory-' + _platformAdvisoryTint(rating) +
        '" data-index="' + i + '" title="' + escapeHtml(ids) + '">' +
      '<div class="query-status-header platform-advisory-header">' +
        // Same triangle, same 14px box, as the capacity alert below it.
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="platform-advisory-icon" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' +
        '<span class="query-status-label">' + escapeHtml(c.label) + ' security update</span>' +
        '<button class="query-abort-btn platform-advisory-dismiss" title="Dismiss (re-appears when a new advisory opens)">&#x2715;</button>' +
      '</div>' +
      '<ul class="query-status-list">' +
        '<li><div style="min-width:0;flex:1">' +
          '<span class="query-status-name">' +
            escapeHtml(c.observedVersion || "") + " · " + n + " CVE" + (n === 1 ? "" : "s") +
            (rating ? " · " + escapeHtml(rating) : "") +
          '</span>' +
          '<span class="query-status-progress">update to ' + escapeHtml(sf.version) + '</span>' +
        '</div></li>' +
      '</ul>' +
    '</div>';
  }).join("");

  container.querySelectorAll(".platform-advisory-alert").forEach(function (panel) {
    var c = shown[Number(panel.getAttribute("data-index"))];
    panel.querySelector(".platform-advisory-dismiss").addEventListener("click", function (e) {
      e.stopPropagation();
      // Keep only pairs still open (so the list cannot grow forever), plus
      // this component's.
      var open = [];
      components.forEach(function (x) { open = open.concat(_platformAdvisoryPairs(x)); });
      var next = dismissed.filter(function (p) { return open.indexOf(p) !== -1; });
      _platformAdvisoryPairs(c).forEach(function (p) { if (next.indexOf(p) === -1) next.push(p); });
      try { localStorage.setItem(_platformAdvisoryDismissKey(), JSON.stringify(next)); } catch (_) {}
      renderPlatformAdvisoryAlert();
    });
    // Click-through to the Platform Lifecycle card on the Maintenance tab.
    panel.style.cursor = "pointer";
    panel.addEventListener("click", function (e) {
      if (e.target && e.target.closest && e.target.closest("button")) return;
      window.location.href = "/server-settings.html?tab=maintenance";
    });
  });
}

// ─── In-app update progress ─────────────────────────────────────────────────
// Renders the sidebar panel shown while an in-app update is being applied.
// Reads the closure-scoped _updateStatus populated by pollUpdateProgress.
// Only visible while state is "applying" or "restarting" — the "available"
// badge near the version (checkSidebarUpdate) handles the not-yet-started
// case, and complete/failed are surfaced on the Maintenance card. Shows just
// the step the pipeline is currently on (not the full checklist — that lives
// on the Maintenance card). The whole panel clicks through there for detail.

function renderUpdateStatus() {
  var container = document.getElementById("update-status");
  if (!container) return;
  var status = (window._getUpdateStatus && window._getUpdateStatus()) || null;
  var active = status && (status.state === "applying" || status.state === "restarting");
  if (!active) {
    container.style.display = "none";
    container.innerHTML = "";
    container.onclick = null;
    return;
  }

  var label = status.state === "restarting" ? "Update — restarting" : "Applying update";
  var steps = Array.isArray(status.steps) ? status.steps : [];
  var current = steps.find(function (st) { return st.status === "running"; });
  // Between steps (or in the restart phase) nothing is mid-flight — fall back
  // to the coarse status.step string, then to a sensible default.
  var currentName = (current && current.name) || status.step ||
    (status.state === "restarting" ? "Restarting service" : "");
  var currentMsg = current && current.message;

  container.style.display = "block";
  container.innerHTML =
    '<div class="query-status-header update-status-header">' +
      '<span class="query-spinner"></span>' +
      '<span class="query-status-label">' + escapeHtml(label) + '</span>' +
    '</div>' +
    (currentName
      ? '<ul class="query-status-list"><li><div style="min-width:0;flex:1">' +
          '<span class="query-status-name">' + escapeHtml(currentName) + '</span>' +
          (currentMsg ? '<span class="query-status-progress">' + escapeHtml(currentMsg) + '</span>' : '') +
          '</div></li></ul>'
      : "");

  // The click-through lands on the Maintenance card, which only
  // serverSettingsSystem readers can open — everyone else gets the panel
  // without a link that would bounce them.
  if (permAtLeast("serverSettingsSystem", "read")) {
    container.style.cursor = "pointer";
    container.onclick = function () {
      window.location.href = "/server-settings.html?tab=database";
    };
  } else {
    container.style.cursor = "";
    container.onclick = null;
  }
}

// ─── Capacity Critical Alert (sidebar) ────────────────────────────────────────

// Renders the non-dismissible critical alert when capacity.severity is
// "critical". Critical is a capacity emergency (disk near full, autovacuum
// stalled, projected DB size > 8x host RAM) and must not be silenceable
// from the UI. Warning and Watch reasons live on the Database card under
// Server Settings → Maintenance. Accepts the legacy "red" string for one
// release cycle so a stale browser tab on an old build doesn't suppress
// the banner after server-side rollout.
function renderCapacityCriticalAlert(capacity) {
  var el = document.getElementById("capacity-critical-alert");
  if (!el) return;

  var sev = capacity ? capacity.severity : null;
  var isCritical = sev === "critical" || sev === "red";
  if (!isCritical) {
    el.style.display = "none";
    return;
  }

  var criticalReasons = (capacity.reasons || []).filter(function (r) {
    return r.severity === "critical" || r.severity === "red";
  });
  if (criticalReasons.length === 0) {
    el.style.display = "none";
    return;
  }

  // Show the topmost reason; the Maintenance tab lists them all.
  var top = criticalReasons[0];
  var moreCount = criticalReasons.length - 1;

  el.innerHTML =
    '<div class="pg-tuning-header">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="pg-tuning-icon"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' +
      '<span>Capacity — Immediate Attention</span>' +
    '</div>' +
    '<div class="pg-tuning-body">' +
      '<p class="pg-tuning-text">' + escapeHtml(top.message) + '</p>' +
      (moreCount > 0
        ? '<p class="pg-tuning-text" style="opacity:0.75;font-style:italic">+ ' + moreCount + ' more critical issue' + (moreCount > 1 ? 's' : '') + '</p>'
        : '') +
    '</div>' +
    '<div class="pg-tuning-actions">' +
      '<a href="/server-settings.html?tab=maintenance" class="btn btn-sm btn-secondary">View capacity &rarr;</a>' +
    '</div>';
  el.style.display = "block";
}

// Polls /pg-tuning at page load to feed the capacity critical alert. Amber and
// watch reasons (pg_tuning_needed, db_io_pressure, db_pool_undersized, …)
// surface on the Database card; only red drives this sidebar alert.
function checkCapacity() {
  if (!isAdmin()) return;
  api.serverSettings.getPgTuning().then(function (data) {
    renderCapacityCriticalAlert(data && data.capacity);
  }).catch(function () {
    // Silently ignore — non-critical check
  });
}
