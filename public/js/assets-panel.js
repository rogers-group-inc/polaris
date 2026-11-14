/**
 * public/js/assets-panel.js — the asset slide-over itself: auto-refresh timers, the back / forward
 * page history, openViewModal and its header, the Details rows (addresses,
 * the primary-address pin, address confidence, upstream devices, location,
 * FortiLink, HA), management access (Open HTTPS / SSH / RDP) and the tab order.
 *
 * Part of the Assets page script (CQ-F050): plain browser scripts sharing
 * page globals, loaded right after assets.js on every page that carries it
 * and in app-panels.js's asset bundle, in ASSETS_FILES order. Nothing here
 * runs at load beyond listener wiring. See tests/unit/assetsSplit.test.ts.
 */

// ─── Asset details panel auto-refresh ──────────────────────────────────────
//
// Three independent self-rescheduling setTimeout chains keep the panel's
// charts current without polling when nothing is visible:
//   • Response-time chart (Monitoring tab)  — response-time cadence
//   • System tab (CPU/Mem, temps, ifaces, storage) — telemetry cadence
//   • Per-interface slide-over charts        — response-time cadence
// Each tick checks that the relevant overlay is still open before fetching
// and defers (re-checks in 30 s) when the browser tab is hidden so we don't
// hammer the API for a panel the user can't see. Custom date ranges on the
// Monitoring tab opt out of refresh entirely (the user picked a fixed window).

var _assetMonitorRefreshTimer = null;
var _assetSystemRefreshTimer  = null;
// Most-recent /system-info payload for the open asset details modal. Reused
// by chart-only re-renders (range-button click on the CPU & Memory chart) so
// they don't have to re-fetch system-info just to repaint the chart's stale
// banner and the latest-reading rows in the summary. Cleared whenever the
// modal closes or switches assets via _resetAssetSystemRefresh.
var _assetSystemSiCache       = null;
var _ifaceRefreshTimer        = null;
var _sensorRefreshTimer       = null;
// Severity tiers for the open sensor chart, keyed "<assetId>|<sensorName>" so a
// range change or silent tick reuses them and switching sensors re-asks.
var _sensorSevTiers           = { key: null, tiers: [] };
var _ipsecRefreshTimer        = null;
var _monitorSettingsCache     = null;  // global monitor settings, fetched once per session
var _currentAssetForRefresh   = null;  // asset object cached so refresh schedulers can read its per-asset intervals
// Per-asset cache of /effective-monitor-settings's `resolved` block. Both
// _populateAssetMonitorTierBadges and _updateStreamSourceBadgesFromEffective
// write here on success so the stale-banner slot has access to the truly-
// resolved cadence (covers class / integration / manual tiers) without a
// third fetch. Keyed by assetId; never invalidated within a session — the
// modal lifecycle is short enough that staleness isn't a concern.
var _effectiveResolvedByAssetId = new Map();

function _refreshIntervalMs(perAssetSec, globalSec, defaultSec) {
  var s = (typeof perAssetSec === "number" && perAssetSec > 0) ? perAssetSec
        : (typeof globalSec   === "number" && globalSec   > 0) ? globalSec
        : defaultSec;
  return Math.max(15, Math.floor(s)) * 1000;
}

function _isOverlayOpen(id) {
  var el = document.getElementById(id);
  return !!(el && el.classList.contains("open"));
}

function _clearAssetRefreshTimers() {
  if (_assetMonitorRefreshTimer) { clearTimeout(_assetMonitorRefreshTimer); _assetMonitorRefreshTimer = null; }
  if (_assetSystemRefreshTimer)  { clearTimeout(_assetSystemRefreshTimer);  _assetSystemRefreshTimer  = null; }
  if (_ifaceRefreshTimer)        { clearTimeout(_ifaceRefreshTimer);        _ifaceRefreshTimer        = null; }
  if (_sensorRefreshTimer)       { clearTimeout(_sensorRefreshTimer);       _sensorRefreshTimer       = null; }
  if (_ipsecRefreshTimer)        { clearTimeout(_ipsecRefreshTimer);        _ipsecRefreshTimer        = null; }
  _assetSystemSiCache = null;
}

function _clearIfaceRefreshTimer() {
  if (_ifaceRefreshTimer) { clearTimeout(_ifaceRefreshTimer); _ifaceRefreshTimer = null; }
}

function _isCurrentAsset(assetId) {
  return !!(_currentAssetForRefresh && _currentAssetForRefresh.id === assetId);
}

function _scheduleAssetMonitorRefresh(assetId, ms) {
  if (_assetMonitorRefreshTimer) clearTimeout(_assetMonitorRefreshTimer);
  _assetMonitorRefreshTimer = setTimeout(function tick() {
    if (!_isOverlayOpen("asset-panel-overlay") || !_isCurrentAsset(assetId)) { _assetMonitorRefreshTimer = null; return; }
    // Paused, like a hidden tab, while one of its interfaces is on screen.
    if (document.hidden || _isIfaceViewOpen()) { _assetMonitorRefreshTimer = setTimeout(tick, 30000); return; }
    _loadMonitorHistoryFor(assetId, _currentMonitorSelection(), { silent: true });
  }, ms);
}

function _scheduleAssetSystemRefresh(assetId, asset, ms) {
  if (_assetSystemRefreshTimer) clearTimeout(_assetSystemRefreshTimer);
  _assetSystemRefreshTimer = setTimeout(function tick() {
    if (!_isOverlayOpen("asset-panel-overlay") || !_isCurrentAsset(assetId)) { _assetSystemRefreshTimer = null; return; }
    if (document.hidden || _isIfaceViewOpen()) { _assetSystemRefreshTimer = setTimeout(tick, 30000); return; }
    _loadSystemTabFor(assetId, _currentSystemTabRange(), asset, { silent: true });
  }, ms);
}

function _scheduleIfaceRefresh(assetId, ifName, ms) {
  if (_ifaceRefreshTimer) clearTimeout(_ifaceRefreshTimer);
  _ifaceRefreshTimer = setTimeout(function tick() {
    // The interface page belongs to the current asset; if either is gone we drop the chain.
    if (!_isIfaceViewOpen() || !_isCurrentAsset(assetId)) { _ifaceRefreshTimer = null; return; }
    if (document.hidden) { _ifaceRefreshTimer = setTimeout(tick, 30000); return; }
    _loadInterfaceHistoryFor(assetId, ifName, _currentIfaceRange(), { silent: true });
  }, ms);
}

function _scheduleSensorRefresh(assetId, sensorName, ms) {
  if (_sensorRefreshTimer) clearTimeout(_sensorRefreshTimer);
  _sensorRefreshTimer = setTimeout(function tick() {
    if (!_isOverlayOpen("sensor-panel-overlay") || !_isCurrentAsset(assetId)) { _sensorRefreshTimer = null; return; }
    if (document.hidden) { _sensorRefreshTimer = setTimeout(tick, 30000); return; }
    _loadSensorHistoryFor(assetId, sensorName, _currentSensorRange(), { silent: true });
  }, ms);
}

function _scheduleIpsecRefresh(assetId, tunnelName, ms) {
  if (_ipsecRefreshTimer) clearTimeout(_ipsecRefreshTimer);
  _ipsecRefreshTimer = setTimeout(function tick() {
    if (!_isOverlayOpen("ipsec-panel-overlay") || !_isCurrentAsset(assetId)) { _ipsecRefreshTimer = null; return; }
    if (document.hidden) { _ipsecRefreshTimer = setTimeout(tick, 30000); return; }
    _loadIpsecHistoryFor(assetId, tunnelName, _currentIpsecRange(), { silent: true });
  }, ms);
}

// Auto-refresh ticks must not yank the user back to the top of the panel.
// Showing "Loading…" placeholders collapses the slideover body's scrollHeight,
// which clamps scrollTop. Silent callers skip the placeholders and capture +
// restore scrollTop around the swap (see the silent branches in
// _loadSystemTabFor / _loadMonitorHistoryFor / _loadInterfaceHistoryFor).

function _currentIfaceRange() {
  var btn = document.querySelector(".iface-range-btn.btn-primary");
  return (btn && btn.getAttribute("data-range")) || "1h";
}

function _currentSensorRange() {
  var btn = document.querySelector(".sensor-range-btn.btn-primary");
  return (btn && btn.getAttribute("data-range")) || "1h";
}

function _currentIpsecRange() {
  var btn = document.querySelector(".ipsec-range-btn.btn-primary");
  return (btn && btn.getAttribute("data-range")) || "1h";
}

// --- Asset panel back/forward history ---------------------------------------
// The slide-over is walkable: a dependency-tree row, an HA peer, an LLDP
// neighbour, a MAC-table match and the Application Map rail all pivot the OPEN
// panel to another asset (openViewModal swaps the body in place rather than
// stacking a second panel). Before this there was no way back — the operator
// lost the device they started from and had to find it in the table again — so
// the panel keeps a browser-style history of the assets visited since it
// opened, walked by the header's ‹ / › buttons or Alt+Left / Alt+Right.
//
// The stack lives for ONE panel session (closeAssetPanel resets it): back means
// back to the device I came from, not to something looked at an hour ago.
var _assetPanelHistory    = { entries: [], idx: -1 };
var _assetPanelWalkDelta  = 0;       // -1/+1 while a back/forward press is re-opening; consumed synchronously by openViewModal
var ASSET_HISTORY_MAX     = 50;

// Pure: what the history becomes when `id` is opened. `fresh` = no session yet
// (the panel was closed), so that asset becomes the only entry. Re-opening the
// CURRENT asset is a REFRESH — the footer Refresh button, every post-save
// re-render and the monitor-pill flip all call openViewModal(sameId) — and must
// not push a duplicate, or a refreshed panel would need two ‹ presses to escape.
function _assetHistoryOpen(state, id, fresh) {
  if (fresh) return { entries: [{ id: id, label: null }], idx: 0 };
  var cur = state.entries[state.idx];
  // From the asset's own interface page, opening that asset is a visit (the
  // LLDP neighbour that resolves back to the device itself), not a refresh.
  if (cur && cur.id === id && !cur.iface) return state;
  // Opening from mid-history drops whatever was ahead of it, like a browser.
  var entries = state.entries.slice(0, state.idx + 1);
  entries.push({ id: id, label: null });
  if (entries.length > ASSET_HISTORY_MAX) entries = entries.slice(entries.length - ASSET_HISTORY_MAX);
  return { entries: entries, idx: entries.length - 1 };
}

// Pure: the entry a back/forward press lands on, or null when that direction is
// spent (which is what disables the button).
function _assetHistoryTarget(state, delta) {
  var i = state.idx + delta;
  if (i < 0 || i >= state.entries.length) return null;
  return { idx: i, entry: state.entries[i] };
}

// Pure: what the history becomes when one of the CURRENT asset's interfaces is
// opened. The interface page loads inside this panel rather than stacking a
// nested slide-over, so it is an entry of its own — ‹ returns to the asset.
// Re-opening the interface already on screen is a refresh, as for an asset.
function _assetHistoryOpenIface(state, id, ifName, row) {
  var cur = state.entries[state.idx];
  if (cur && cur.id === id && cur.iface && cur.iface.ifName === ifName) {
    cur.iface.row = row || cur.iface.row;
    return state;
  }
  var entries = state.entries.slice(0, state.idx + 1);
  entries.push({ id: id, label: cur && cur.id === id ? cur.label : null, iface: { ifName: ifName, row: row || null } });
  if (entries.length > ASSET_HISTORY_MAX) entries = entries.slice(entries.length - ASSET_HISTORY_MAX);
  return { entries: entries, idx: entries.length - 1 };
}

// What a header tooltip calls an entry: the asset, or "port1 on <asset>".
function _assetHistoryEntryName(entry) {
  if (!entry) return "the previous asset";
  if (entry.iface) return entry.iface.ifName + " on " + (entry.label || "this asset");
  return entry.label || "the previous asset";
}

// Pure: label every entry for this asset once its hostname is known, so the
// tooltips name the device instead of an opaque id. One id can hold several
// entries (walked away and back), hence the sweep.
function _assetHistoryLabel(state, id, label) {
  for (var i = 0; i < state.entries.length; i++) {
    if (state.entries[i].id === id) state.entries[i].label = label || null;
  }
  return state;
}

// Paint the header pair from the current stack. Hidden entirely until there is
// somewhere to go, so a panel opened once and never walked doesn't grow two
// permanently-dead buttons.
function _renderAssetPanelNav() {
  var wrap = document.getElementById("asset-panel-nav");
  if (!wrap) return;
  wrap.hidden = _assetPanelHistory.entries.length < 2;
  var specs = [
    { el: document.getElementById("asset-panel-back"), delta: -1, verb: "Back", keys: "Alt+Left" },
    { el: document.getElementById("asset-panel-fwd"),  delta:  1, verb: "Forward", keys: "Alt+Right" },
  ];
  for (var i = 0; i < specs.length; i++) {
    var s = specs[i];
    if (!s.el) continue;
    var t = _assetHistoryTarget(_assetPanelHistory, s.delta);
    s.el.disabled = !t;
    s.el.title = t
      ? s.verb + " to " + _assetHistoryEntryName(t.entry) + " (" + s.keys + ")"
      : "No " + s.verb.toLowerCase() + " history";
  }
}

// Walk the stack. The index moves here and openViewModal is told to leave the
// stack alone — otherwise stepping back would itself push an entry and the
// operator could never reach the start.
// Keep the keyboard on the pair while walking: openViewModal otherwise
// focuses the panel, so a second press would need the mouse again. When the
// direction just ran out, hand focus to the opposite button rather than to a
// disabled one.
function _focusAssetPanelNav(delta) {
  var mine  = document.getElementById(delta < 0 ? "asset-panel-back" : "asset-panel-fwd");
  var other = document.getElementById(delta < 0 ? "asset-panel-fwd"  : "asset-panel-back");
  var pick = mine && !mine.disabled ? mine : (other && !other.disabled ? other : null);
  if (pick) { try { pick.focus(); } catch (_) { /* detached */ } }
}

// An interface entry, or a step from an interface page back to its own
// asset, is a VIEW switch when that asset is the one already loaded: the asset
// page stays in the DOM (hidden) while its interface shows, so ‹ lands on the
// tab and scroll position the operator left, without a refetch.
function _assetPanelGo(delta) {
  var t = _assetHistoryTarget(_assetPanelHistory, delta);
  if (!t) return;
  _assetPanelHistory.idx = t.idx;
  var e = t.entry;
  var loaded = _currentAssetForRefresh && _currentAssetForRefresh.id === e.id ? _currentAssetForRefresh : null;
  if (loaded) {
    if (e.iface) {
      openInterfaceDetailPanel(loaded, e.iface.ifName, e.iface.row, { walk: delta });
    } else {
      _showAssetPanelView("asset");
      _renderAssetPanelNav();
      _focusAssetPanelNav(delta);
    }
    return;
  }
  _assetPanelWalkDelta = delta;
  var opened = openViewModal(e.id);
  if (!e.iface) return;
  // A walk onto another asset's interface page loads the asset first, then
  // its interface — unless the operator has moved on while it loaded.
  Promise.resolve(opened).then(function () {
    var now = _assetPanelHistory.entries[_assetPanelHistory.idx];
    if (now !== e || !_currentAssetForRefresh || _currentAssetForRefresh.id !== e.id) return;
    openInterfaceDetailPanel(_currentAssetForRefresh, e.iface.ifName, e.iface.row, { walk: delta });
  });
}

// The asset panel holds two pages: the asset's tabs, and one interface of it
// (openInterfaceDetailPanel). CSS on #asset-panel[data-view] shows one set of
// header / body / footer elements and hides the other.
function _showAssetPanelView(view) {
  var panel = document.getElementById("asset-panel");
  if (!panel) return;
  if (view === "iface") {
    panel.setAttribute("data-view", "iface");
    panel.setAttribute("aria-labelledby", "iface-panel-title");
  } else {
    panel.removeAttribute("data-view");
    panel.setAttribute("aria-labelledby", "asset-panel-title");
    _clearIfaceRefreshTimer();
  }
}

function _isIfaceViewOpen() {
  var panel = document.getElementById("asset-panel");
  return _isOverlayOpen("asset-panel-overlay") && !!panel && panel.getAttribute("data-view") === "iface";
}

// Escape on an interface page steps back to its asset — what closing the old
// nested interface slide-over did — and closes the panel everywhere else.
function _assetPanelEscape() {
  var cur = _assetPanelHistory.entries[_assetPanelHistory.idx];
  var back = _assetHistoryTarget(_assetPanelHistory, -1);
  if (_isIfaceViewOpen() && cur && cur.iface && back && back.entry.id === cur.id) {
    _assetPanelGo(-1);
    return;
  }
  closeAssetPanel();
}

function _ensureAssetPanelDOM() {
  if (document.getElementById("asset-panel-overlay")) return;
  var overlay = document.createElement("div");
  overlay.id = "asset-panel-overlay";
  overlay.className = "slideover-overlay";
  overlay.innerHTML =
    '<div class="slideover" id="asset-panel" role="dialog" aria-labelledby="asset-panel-title" tabindex="-1">' +
      '<div class="slideover-resize-handle"></div>' +
      '<div class="slideover-header">' +
        '<div class="slideover-header-top">' +
          '<div class="slideover-header-lead">' +
            '<div class="slideover-nav" id="asset-panel-nav" hidden>' +
              '<button type="button" class="slideover-nav-btn" id="asset-panel-back" aria-label="Back to the previously viewed asset" disabled>&lsaquo;</button>' +
              '<button type="button" class="slideover-nav-btn" id="asset-panel-fwd" aria-label="Forward to the next viewed asset" disabled>&rsaquo;</button>' +
            '</div>' +
            // The interface page's title, shown in place of the asset's
            // (_showAssetPanelView). Before it, so the verbs stay beside the
            // asset title.
            '<h3 id="iface-panel-title" class="asset-panel-iface-only">Interface</h3>' +
            '<h3 id="asset-panel-title" class="asset-panel-asset-only">Asset Details</h3>' +
            // The device verbs — Discover Now, then Reboot — right of the
            // hostname, so they sit with the device they act on on every tab
            // rather than only on the System tab's Status row. Populated per
            // open by openViewModal (_assetHeaderVerbsHTML); the reboot slot
            // inside is filled async by _loadAssetRebootControl.
            '<span class="slideover-header-verbs asset-panel-asset-only" id="asset-panel-verbs"></span>' +
          '</div>' +
          // Per-asset actions (Screenshot + PDF | Export / Refresh / Open
          // HTTPS / Open SSH) live in the header, right-aligned, LEFT of the
          // lock button _ensureLockButton injects in front of the X — see
          // .slideover-header-actions in styles.css for how the two share the
          // header's free space. Populated per open by openViewModal.
          '<div class="slideover-header-actions asset-panel-asset-only" id="asset-panel-actions"></div>' +
          '<button class="btn-icon" id="asset-panel-close" title="Close" aria-label="Close asset details">&times;</button>' +
        '</div>' +
        '<div class="slideover-meta asset-panel-iface-only" id="iface-panel-meta"></div>' +
        '<div class="slideover-meta asset-panel-asset-only" id="asset-panel-meta"></div>' +
        // The tab strip is rendered into the body by tabbedBodyHTML and then
        // moved here by openViewModal, so it stays frozen in the header while
        // the tab content scrolls. Every reader finds it by id
        // (#asset-view-tabs), never by container, so the move is invisible
        // to them.
        '<div class="slideover-tabs asset-panel-asset-only" id="asset-panel-tabs"></div>' +
      '</div>' +
      '<div class="slideover-body asset-panel-asset-only" id="asset-panel-body"><p class="empty-state">Loading...</p></div>' +
      // The interface page (openInterfaceDetailPanel): one of this asset's
      // interfaces, opened from the System tab, shown in place of the tabs.
      '<div class="slideover-body asset-panel-iface-only" id="iface-panel-body"></div>' +
      '<div class="slideover-footer asset-panel-asset-only" id="asset-panel-footer"></div>' +
      '<div class="slideover-footer asset-panel-iface-only" id="iface-panel-footer"></div>' +
    '</div>';
  document.body.appendChild(overlay);

  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) closeAssetPanel();
  });
  document.getElementById("asset-panel-close").addEventListener("click", closeAssetPanel);
  document.getElementById("asset-panel-back").addEventListener("click", function () { _assetPanelGo(-1); });
  document.getElementById("asset-panel-fwd").addEventListener("click", function () { _assetPanelGo(1); });

  // The System-tab status pill is rendered by assetMonitorBadge with the
  // same data-monitor-toggle attributes as the table pills — delegate the
  // same click handler here so it's actually actionable in the slide-over
  // (toggle monitoring / enter or end maintenance).
  document.getElementById("asset-panel-body").addEventListener("click", _handleMonitorPillClick);

  // Escape closes the panel — but only when it's the topmost layer. Nested
  // drilldowns (interface / storage / sensor / IPsec slide-overs) install their
  // own capture-phase Escape handlers that close themselves first; this guard
  // keeps Escape from closing the whole asset panel out from under an open
  // nested panel. Not a hard focus trap: the asset panel is a resizable side
  // panel meant to coexist with the page, so role="dialog" without aria-modal.
  // wireSlideoverEscape (app.js) gates on isTopmostSlideover, which covers
  // both the nested drilldowns and a network or block slide-over opened from
  // inside this panel: every slide-over stacks by DOM order (raiseSlideover),
  // so whichever was opened last owns the key.
  wireSlideoverEscape(overlay, _assetPanelEscape);

  // Alt+Left / Alt+Right walk the panel history, mirroring the browser chord.
  // Gated exactly like Escape above: only while the asset panel is the topmost
  // layer, so an open drilldown or a stacked modal keeps the keys for itself.
  document.addEventListener("keydown", function (e) {
    if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    if (!isTopmostSlideover(overlay)) return;
    e.preventDefault();
    _assetPanelGo(e.key === "ArrowLeft" ? -1 : 1);
  });

  // The mouse's back / forward side buttons (button 3 / 4) walk it too, under
  // the same gate. Left alone they navigate the whole PAGE away from the open
  // panel. Browsers fire the navigation on mouseup and honour preventDefault
  // there; mousedown and auxclick are swallowed as well so no engine acts on
  // an earlier event. The walk itself runs once, on mouseup.
  ["mousedown", "mouseup", "auxclick"].forEach(function (type) {
    document.addEventListener(type, function (e) {
      if (e.button !== 3 && e.button !== 4) return;
      if (!isTopmostSlideover(overlay)) return;
      e.preventDefault();
      if (type === "mouseup") _assetPanelGo(e.button === 3 ? -1 : 1);
    });
  });

  initSlideoverResize(document.getElementById("asset-panel"), "polaris.panel.width.asset");
}

var _assetPanelReturnFocus = null;  // element refocused when the asset panel closes

function closeAssetPanel() {
  var overlay = document.getElementById("asset-panel-overlay");
  if (overlay) overlay.classList.remove("open");
  _showAssetPanelView("asset");
  _clearAssetRefreshTimers();
  _currentAssetForRefresh = null;
  // History is per panel session — reopening from the table starts over.
  _assetPanelHistory = { entries: [], idx: -1 };
  _assetPanelWalkDelta = 0;
  _renderAssetPanelNav();
  if (_assetPanelReturnFocus && typeof _assetPanelReturnFocus.focus === "function") {
    try { _assetPanelReturnFocus.focus(); } catch (_) { /* element gone */ }
  }
  _assetPanelReturnFocus = null;
}

// Open the asset details modal by serial number — used by HA peer links on
// the General tab to pivot between cluster members. Falls back to a no-op
// (with a console hint) when no match is found so the link doesn't appear
// broken if discovery hasn't recorded the standby yet.
window.openAssetBySerial = async function (serial) {
  if (!serial) return;
  try {
    var rows = await api.assets.list({ search: serial, limit: 25 });
    var list = Array.isArray(rows) ? rows : (rows && rows.assets) || [];
    var match = list.find(function (a) { return a.serialNumber === serial; });
    if (match) {
      await openViewModal(match.id);
    } else {
      console.warn("No asset with serial", serial);
    }
  } catch (err) {
    console.warn("openAssetBySerial failed", err);
  }
};

// opts.tab — the data-tab key of the slide-over tab to land on (e.g.
// "notifications" for Alerts). An alert entry is a prompt to look at THAT
// alert, so the Active Alerts widget asks for the Alerts tab instead of
// leaving the operator on General to find it. A tab the viewer isn't shown
// (permission-gated, or type-specific) falls back to General silently.
async function openViewModal(id, opts) {
  opts = opts || {};
  _ensureAssetPanelDOM();
  // Back/forward bookkeeping. The walk direction is consumed SYNCHRONOUSLY
  // here, before any await, so a walk can't leak into whatever opens next.
  // "Fresh" is an empty stack rather than a closed overlay: the overlay only
  // gains .open on the next frame, so two fast opens would otherwise read as
  // two separate sessions.
  var _walk  = _assetPanelWalkDelta;
  _assetPanelWalkDelta = 0;
  var _fresh = _assetPanelHistory.entries.length === 0;
  if (!_walk) _assetPanelHistory = _assetHistoryOpen(_assetPanelHistory, id, _fresh);
  _renderAssetPanelNav();
  if (_walk) _focusAssetPanelNav(_walk);
  // Remember the trigger (table row action, search hit, etc.) so closing the
  // panel returns focus there. Only the FIRST open of a session sets it: every
  // later open is a pivot or a walk whose activeElement is a control inside the
  // panel, and returning focus to a hidden button loses it to <body>.
  if (_fresh) _assetPanelReturnFocus = document.activeElement;
  _showAssetPanelView("asset");
  var titleEl  = document.getElementById("asset-panel-title");
  var metaEl   = document.getElementById("asset-panel-meta");
  var bodyEl   = document.getElementById("asset-panel-body");
  var footerEl = document.getElementById("asset-panel-footer");
  var actionsEl = document.getElementById("asset-panel-actions");
  titleEl.textContent = "Asset Details";
  metaEl.innerHTML = "";
  // Cleared with the body so a walk to another asset doesn't leave the
  // previous device's tabs on screen over its loading state.
  var tabsSlot = document.getElementById("asset-panel-tabs");
  if (tabsSlot) tabsSlot.innerHTML = "";
  bodyEl.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">Loading...</p>';
  footerEl.innerHTML = "";
  // Cleared alongside the footer so a walk to another asset can't leave the
  // previous device's Open HTTPS / Open SSH buttons on screen while it loads.
  if (actionsEl) actionsEl.innerHTML = "";
  // Same for the previous device's Discover Now / Reboot.
  var verbsEl = document.getElementById("asset-panel-verbs");
  if (verbsEl) verbsEl.innerHTML = "";
  // A closed panel re-opened from inside another slide-over (an IP row in the
  // network panel) has to paint over it — DOM order is stacking order.
  raiseSlideover(document.getElementById("asset-panel-overlay"));
  requestAnimationFrame(function () {
    var ov = document.getElementById("asset-panel-overlay");
    ov.classList.add("open");
    var panel = document.getElementById("asset-panel");
    if (panel && !_walk) panel.focus();
  });

  try {
    // ---- Single parallel fetch wave ------------------------------------
    // Everything that needs only the asset ID goes out at once alongside the
    // asset row itself, and the two calls that need the asset's *shape*
    // (custom widgets keys off manufacturer, SD-WAN off type + integration)
    // chain off the asset promise so they overlap the wave instead of forming
    // a round trip behind it. Before 2026-08 this was four sequential
    // Promise.all barriers — asset, then aux, then SD-WAN, then credentials —
    // and the panel body painted nothing but "Loading..." until the last one
    // resolved, which is four RTTs on a WAN link. Failures everywhere fall
    // through to empty-state so the rest of the modal still works.
    var assetP = api.assets.get(id);

    // Per-open memo for GET /assets/:id/effective-monitor-settings. Three
    // consumers want it on every open (the SNMP Walk tab gate below, the
    // intermittency bar, the stream-source badges) and it used to be fetched
    // three times per open. Deliberately scoped to this call rather than a
    // module cache: the sub-panel refreshes (interface / sensor / IPsec /
    // SD-WAN detail) must keep re-reading it live after a settings change.
    var _effP = null;
    function effSettings() {
      if (!_effP) _effP = api.assets.effectiveMonitorSettings(id);
      return _effP;
    }

    // Custom MIB widgets — manufacturer-scoped (no manufacturer means no
    // ManufacturerProfile and therefore no widgets). Prefetched so the tab is
    // present + pre-populated on first paint and never flashes-then-vanishes.
    // A Generic API integration can define widgets for the assets it lists
    // (rule 100(i)); the sync tags every such asset `genericapi`.
    var customWidgetsP = assetP.then(function (asset) {
      if (!asset.manufacturer && (asset.tags || []).indexOf("genericapi") === -1) return null;
      return api.assets.customWidgets(asset.id).catch(function (err) { console.warn("Failed to load custom widgets", err); return null; });
    });

    // Firmware upgrade availability (business rule 87) — switches and access
    // points only. The card is part of the asset, so it is read at
    // assets:read like the rest of the slide-over (flashing is assets:write);
    // the Repository key only decides whether the card links to the tab.
    // Errors become a card line rather than a failed wave.
    var firmwareP = assetP.then(function (asset) {
      if (!_assetFirmwareEligible(asset)) return null;
      if (!(typeof permAtLeast === "function" && permAtLeast("assets", "read"))) return null;
      return api.assets.firmwareUpgrade(asset.id).catch(function (err) { return { error: (err && err.message) || "request failed" }; });
    });

    // SD-WAN trio — FortiGate firewalls discovered via FortiManager/FortiGate
    // with the pullSdwan toggle on. Prefetched for the same reason as Custom
    // MIB: the tab only shows when the device actually reported data.
    var sdwanP = assetP.then(function (asset) {
      var sk = (asset.discoveredByIntegration && asset.discoveredByIntegration.type) || "manual";
      if (!(asset.monitored && asset.assetType === "firewall" && (sk === "fortimanager" || sk === "fortigate"))) {
        return { rules: [], links: [], members: [], meta: {} };
      }
      return Promise.all([
        api.assets.sdwanRules(asset.id).catch(function (err) { console.warn("Failed to load SD-WAN rules", err); return { rules: [] }; }),
        api.assets.perfSlaLinks(asset.id).catch(function (err) { console.warn("Failed to load SD-WAN perf-SLA links", err); return { links: [] }; }),
        api.assets.sdwanMembers(asset.id).catch(function (err) { console.warn("Failed to load SD-WAN members", err); return { members: [] }; }),
      ]).then(function (r) {
        return {
          rules:   (r[0] && r[0].rules)   || [],
          links:   (r[1] && r[1].links)   || [],
          members: (r[2] && r[2].members) || [],
          // Per-table scrape stamp + cadence, for the section freshness strips.
          // Each table states its OWN age: the rules table and the perf-SLA
          // stream are separate writes on the same pass, and one can land
          // without the other.
          meta: {
            rulesAt:      (r[0] && r[0].collectedAt) || null,
            rulesPollSec: (r[0] && r[0].pollIntervalSec) || null,
            membersAt:      (r[2] && r[2].collectedAt) || null,
            membersPollSec: (r[2] && r[2].pollIntervalSec) || null,
          },
        };
      });
    });

    // IPsec — Fortinet-discovered firewalls. Prefetched like SD-WAN so the
    // tab only appears on a gate that actually reported tunnels or peers.
    var ipsecP = assetP.then(function (asset) {
      var sk = (asset.discoveredByIntegration && asset.discoveredByIntegration.type) || "manual";
      if (!(asset.assetType === "firewall" && (sk === "fortimanager" || sk === "fortigate"))) return null;
      return api.assets.ipsec(asset.id).catch(function (err) { console.warn("Failed to load IPsec", err); return null; });
    });
    // A FortiGate's managed FortiAP / FortiSwitch counts — decide whether its
    // Wireless and MAC Table tabs (the children's clients and forwarding
    // databases) are drawn. Awaited beside the wave rather than given a slot
    // in it: every wave index is read positionally.
    var childCountsP = assetP.then(function (asset) {
      if (asset.assetType !== "firewall") return null;
      return api.assets.childCounts(asset.id).catch(function () { return null; });
    });
    // Fibre Channel (business rule 159) — whether the tab is drawn, and its
    // content. Beside the wave for the same reason: wave slots are positional.
    var fcP = api.assets.fibreChannel(id).catch(function () { return null; });

    var wave = await Promise.all([
      assetP,
      // One-shot manual-tier read used as a generic auto-refresh cadence
      // fallback, cached module-wide after the first open.
      _monitorSettingsCache ? Promise.resolve(null) : api.monitorSettings.getManual().catch(function () { return null; }),
      // Maintenance windows for the chart band overlays — fetched once per
      // panel open (90-day lookback covers every chart range incl. 30d +
      // custom), awaited here so every later chart render can read the cache
      // synchronously. Best-effort: a failure just means no bands.
      _loadMaintWindowsCache(id),
      api.assets.getSources(id).catch(function (err) { console.warn("Failed to load asset sources", err); return []; }),
      api.assets.getDependencies(id).catch(function (err) { console.warn("Failed to load asset dependencies", err); return null; }),
      api.assets.agent(id).catch(function (err) { console.warn("Failed to load managed agent", err); return null; }),
      api.assets.getSightings(id).catch(function (err) { console.warn("Failed to load asset sightings", err); return []; }),
      api.assets.getIpHistory(id).catch(function (err) { console.warn("Failed to load asset IP history", err); return []; }),
      // Effective monitor settings — needed pre-paint only to decide whether
      // the SNMP Walk tab shows, so callers who can't reach that tab skip it
      // here; the post-paint consumers still share one fetch through
      // effSettings(). Keyed on canProbeAssets(), the tab's own gate — it was
      // isAdmin(), which starved the tab of both this and the credential
      // cache for every custom role holding `assetsProbe`.
      canProbeAssets()
        ? effSettings().catch(function (err) { console.warn("Failed to load effective monitor settings", err); return null; })
        : Promise.resolve(null),
      // Credentials — the SNMP Walk tab's picker renders from this cache, so
      // it has to be warm before that tab's HTML is built. Module-cached, so
      // this is a no-op after the first open of the session.
      canProbeAssets() ? _ensureCredentials() : Promise.resolve(null),
      customWidgetsP,
      sdwanP,
      firmwareP,
      // Path checks this host runs — prefetched so the tab is present
      // on first paint or absent, never flashing in and out.
      api.assets.pathChecks(id).catch(function () { return null; }),
      ipsecP,
      // Whether the Services / Software tabs have anything to show — they
      // are drawn only when something is pulling that information in. A
      // failed read shows both (the behaviour before the gate). Keep this the
      // LAST slot: every index above is read positionally.
      api.assets.inventoryPresence(id).catch(function () { return { services: true, software: true }; }),
    ]);

    var a = wave[0];
    var firmwareAvail = wave[12];
    if (wave[1]) _monitorSettingsCache = wave[1];
    var sources             = wave[3] || [];
    var dependencies        = wave[4];
    var managedAgent        = wave[5];
    var sightings           = Array.isArray(wave[6]) ? wave[6] : (wave[6] && wave[6].sightings) || [];
    var ipHistory           = wave[7] || [];
    var effMonitorSettings  = wave[8];
    var customWidgetPayload = wave[10];
    var sdwanRules   = wave[11].rules;
    var sdwanLinks   = wave[11].links;
    var sdwanMembers = wave[11].members;
    var sdwanMeta    = wave[11].meta || {};
    var pathPayload  = wave[13];
    var ipsecPayload = wave[14];
    var inventoryPresence = wave[15] || { services: true, software: true };
    var childCounts = await childCountsP;
    var fcPayload = await fcP;

    _currentAssetForRefresh = a;
    // Name the entry now that the hostname is known, so the tooltips read
    // "Back to HARBOR-61F-1" instead of a uuid.
    _assetHistoryLabel(_assetPanelHistory, a.id, a.hostname || a.dnsName || a.ipAddress || null);
    _renderAssetPanelNav();
    var generalHTML = _assetGeneralTabHTML(a, sources);

    var monitoringHTML = assetMonitoringViewHTML(a);
    var agentSubpanelHTML = assetAgentSubpanelHTML(a, managedAgent);
    var agentMountHTML = '<div data-shot-section="agent" data-shot-label="Polaris Agent"><div id="asset-agent-panel-mount"></div></div>';
    // The Firmware card sits directly under the Polaris Agent card: the same
    // "Polaris acts on this device and shows polled progress" surface. Only a
    // switch / access point gets the mount at all.
    var firmwareMountHTML = _assetFirmwareEligible(a)
      ? '<div data-shot-section="firmware" data-shot-label="Firmware"><div id="asset-firmware-panel-mount"></div></div>'
      : '';
    var systemHTML     = a.monitored
      ? monitoringHTML +
        '<hr style="margin:1.5rem 0;border:none;border-top:1px solid var(--color-border)">' +
        agentMountHTML +
        firmwareMountHTML +
        assetSystemViewHTML(a)
      : monitoringHTML +
        agentMountHTML + // unmonitored assets still see the panel when an agent is mid-install
        firmwareMountHTML;
    var tabs = [
      { key: "general", label: "General", html: generalHTML },
      { key: "system",  label: "System",  html: systemHTML },
    ];
    // A hypervisor's VMs / containers — their own tab, filled by the same
    // virtualization fetch as the General tab's host section.
    if (_hostWorkloadsTabEligible(a)) {
      tabs.push({ key: "workloads", label: _hostWorkloadsTabLabel(a), html: _hostWorkloadsTabHTML(a) });
    }
    // Wireless tab — every monitored FortiAP, whether or not it currently
    // has clients: the tab now leads with the AP's radios and the SSIDs they
    // broadcast, which are worth reading on an AP nobody is connected to.
    // The content is loaded async from /system-info so initial render is a
    // placeholder; _loadSystemTabFor() reuses the same endpoint, so when the
    // operator clicks the tab the data is already in cache from the System
    // tab's first fetch.
    if (a.assetType === "access_point" && a.monitored) {
      tabs.push({ key: "stations", label: "Wireless", html: _assetStationsTabHTML(a) });
    }
    // A FortiGate's Wireless tab — the clients of every FortiAP it controls,
    // grouped by AP. Only when it controls at least one; lazy-loaded.
    if (a.assetType === "firewall" && childCounts && childCounts.accessPoints > 0) {
      tabs.push({ key: "childwireless", label: "Wireless", html: _assetChildMountHTML("childwireless", a.id) });
    }
    // SD-WAN tab — shown only when the device actually reported SD-WAN data
    // (rules or health-check links exist); the trio was prefetched in the wave
    // above so the tab is present + pre-populated on first paint.
    if (sdwanRules.length || sdwanLinks.length || sdwanMembers.length) {
      tabs.push({ key: "sdwan", label: "SD-WAN", html: _assetSdwanTabHTML(a, sdwanRules, sdwanLinks, sdwanMembers, sdwanMeta) });
    }
    // IPsec tab — the gate's tunnels and who is connected through them
    // (ADVPN spokes / shortcuts, dial-up peers, FortiClient users).
    var showIpsecTab = _ipsecTabEligible(ipsecPayload);
    if (showIpsecTab) {
      tabs.push({ key: "ipsec", label: "IPsec", html: _assetIpsecTabHTML(a.id) });
    }
    // Paths tab — agent-run path checks this host runs.
    if (_pathTabEligible(pathPayload)) {
      tabs.push({ key: "pathCheck", label: "Paths", html: _assetPathCheckTabHTML(a, pathPayload) });
    }
    // MAC Table tab — the switch's layer-2 forwarding database. Switch-class
    // only, mirroring where the collector spends the walk; lazy-loaded on
    // first click since it can carry a few thousand rows.
    if (a.assetType === "switch") {
      tabs.push({ key: "mactable", label: "MAC Table", html: _assetMacTableTabHTML(a.id) });
    }
    // Fibre Channel — an FC switch's ports and logins, or a server's HBA
    // links as the switches see them. Only when either side has rows.
    if (_fcTabEligible(fcPayload)) {
      tabs.push({ key: "fibrechannel", label: "Fibre Channel", html: _assetFcTabHTML(a.id) });
    }
    // A FortiGate's MAC Table tab — the forwarding database of every
    // FortiSwitch it controls, grouped by switch. Only when it controls one.
    if (a.assetType === "firewall" && childCounts && childCounts.switches > 0) {
      tabs.push({ key: "childmactable", label: "MAC Table", html: _assetChildMountHTML("childmactable", a.id) });
    }
    // ARP Table tab — the FortiGate's layer-3 neighbour cache, the L3 sibling
    // of MAC Table. Firewall-class only, mirroring where discovery reads it;
    // lazy-loaded on first click since a gate fronting a large site carries
    // hundreds of rows.
    if (a.assetType === "firewall") {
      tabs.push({ key: "arptable", label: "ARP Table", html: _assetArpTableTabHTML(a.id) });
    }
    // Services tab — merged unit + process inventory. Shows systemd units /
    // Windows services by default; an "Include processes" checkbox folds the
    // current-state process inventory into the same table. Lazy-loaded on first
    // click (see _wireAssetServicesTab). Not shown on Fortinet infrastructure
    // (firewall/switch/access_point) — those appliances report neither a unit
    // list nor a host process table — nor on "other", the catch-all type an
    // asset lands in when nothing identified it as a host (cameras, PDUs,
    // sensors), which likewise reports no inventory.
    var isInfraProc = a.assetType === "firewall" || a.assetType === "switch" || a.assetType === "access_point" || a.assetType === "other";
    // Both tabs also need something actually pulling the information in
    // (GET /assets/:id/inventory-presence): a host with no agent, no
    // agentless process polling and no Intune / Arc software read would
    // otherwise carry two tabs that can never fill.
    var showServicesTab = !isInfraProc && inventoryPresence.services;
    var showSoftwareTab = !isInfraProc && inventoryPresence.software;
    if (showServicesTab) {
      tabs.push({ key: "services", label: "Services", html: _assetServicesTabHTML(a.id) });
    }
    if (showSoftwareTab) {
      // Software tab — installed programs + versions, from whichever sources
      // hold a list (agent, Intune detected apps, Azure Change Tracking).
      // Lazy-loaded on first click.
      tabs.push({ key: "software", label: "Software", html: _assetSoftwareTabHTML() });
    }
    // Quarantine tab — assets-admin only, shown for any asset that has MACs or is quarantined.
    // Infrastructure assets (firewall/switch/access_point) only get the tab if they're
    // already quarantined (so Release stays reachable); they can't be newly quarantined.
    // Ordered right after Processes.
    var isInfraQ = a.assetType === "firewall" || a.assetType === "switch" || a.assetType === "access_point";
    var hasMac = !!(a.macAddress || (a.macAddresses && a.macAddresses.length));
    // Gated on assetsQuarantine, NOT assets — see canQuarantineAssets() in
    // app.js. A role may hold either key without the other, and every route the
    // tab calls checks the quarantine key.
    // ...and only offered on a not-yet-quarantined asset when quarantine push
    // is enabled somewhere (_quarantinePushAvailable); an already-quarantined
    // asset keeps the tab regardless so Release + the push targets stay visible.
    if (_canQuarantineAsset(a) && (a.status === "quarantined" || (hasMac && !isInfraQ && _quarantinePushAvailable()))) {
      tabs.push({ key: "quarantine", label: a.status === "quarantined" ? "Quarantine ⚠" : "Quarantine", html: _assetQuarantineTabHTML(a) });
    }
    // Events tab — audit history about this asset (assetId=a.id: its own
    // rows plus its alerts' fire / clear). Lazy-loaded on first tab click (see _wireAssetEventsTab)
    // so the modal doesn't fire an extra /events query on every open. Gated on
    // events-read to mirror the GET /events backend permission.
    if (permAtLeast("events", "read")) {
      tabs.push({ key: "events", label: "Events", html: _assetEventsTabHTML(a.id) });
    }
    // Alerts tab — active alerts for this asset + the automations whose scope
    // matches it. Loaded eagerly after render (one cheap query). Gated on
    // alerts-read to mirror the Automations page's Alerts-tab gate.
    if (permAtLeast("alerts", "read")) {
      tabs.push({ key: "notifications", label: "Alerts", html: _assetNotificationsTabHTML() });
    }
    // Custom MIB tab — shown only when the asset's manufacturer actually has
    // at least one ManufacturerCustomWidget defined under its
    // ManufacturerProfile. The widget payload is fetched up front in the
    // parallel fetch wave (above), so the tab is present + pre-populated
    // on first paint and never flashes-then-vanishes for manufacturers with
    // no custom widgets. Mirrors the SD-WAN tab's prefetch-then-conditional
    // pattern.
    if (customWidgetPayload && customWidgetPayload.widgets && customWidgetPayload.widgets.length) {
      // "Custom MIB" while every widget is a manufacturer's; "Widgets" once a
      // Generic API integration contributes one (its values are not MIB reads).
      var anyFeedWidget = customWidgetPayload.widgets.some(function (w) { return w.source && w.source.kind === "genericapi"; });
      tabs.push({ key: "customMib", label: anyFeedWidget ? "Widgets" : "Custom MIB", html: _customMibTabHTML(customWidgetPayload) });
    }
    // SNMP Walk tab — `assetsProbe=read`, mirrors the backend gate (that key
    // is read-only by nature since 2026-09-04, business rule 43; it was
    // isAdmin() here, which hid the tab from every custom role holding the
    // grant). Additionally
    // hidden when no monitoring stream resolves to SNMP for this asset
    // (effective settings prefetched in the wave above, so the tab never
    // flashes-then-vanishes — same idiom as Custom MIB). Credentials for the
    // picker rode the same wave, so the cache is warm here — do NOT re-add an
    // await, it was the fourth serial barrier in front of first paint.
    var showSnmpWalkTab = canProbeAssets() && _assetUsesSnmpPolling(a, effMonitorSettings);
    // API Query — a read-only FortiOS REST console aimed at this gate through
    // its own integration (FortiManager proxy / direct, or standalone
    // FortiGate). Gated on integrations=write, the gate of the
    // /integrations/:id/query endpoint it calls.
    var apiQueryTransport = _assetApiQueryTransport(a);
    // Device Query tab — SNMP Walk and API Query as sub-tabs. The strip shows
    // even with one sub-tab so the panel says which query it is.
    var deviceQueryTabs = [];
    if (showSnmpWalkTab) {
      deviceQueryTabs.push({ key: "snmp", label: "SNMP Walk", html: assetSnmpWalkViewHTML(a, effMonitorSettings) });
    }
    if (apiQueryTransport) {
      deviceQueryTabs.push({ key: "api", label: "API Query", html: _assetApiQueryHTML(a, apiQueryTransport) });
    }
    if (deviceQueryTabs.length) {
      tabs.push({ key: "devicequery", label: "Device Query", html: tabbedBodyHTML("asset-dq", deviceQueryTabs) });
    }
    // Sources tab — discovery-source provenance lives last.
    tabs.push({ key: "sources", label: "Sources", html: _assetSourcesTabHTML(sources, a.id, sightings, ipHistory, a.discoveredByIntegrationId, a) });
    // The strip's order is decided here, not by push order (operator decision
    // 2026-11-04): General, System, SD-WAN, IPsec, ARP Table, MAC Table,
    // Wireless, Events, Alerts, Sources. The tabs that list does not name
    // keep their place between those neighbours. A key missing from the list
    // sorts just before Sources, so a new tab is never silently dropped.
    tabs = _orderAssetViewTabs(tabs);
    var tabsHTML = tabbedBodyHTML("asset-view", tabs);
    bodyEl.innerHTML = '<div class="asset-panel-content">' + tabsHTML + '</div>';
    _loadAssetTlsPins(bodyEl);
    _loadAssetHostPins(bodyEl);
    // Lift the strip into the header slot so it doesn't scroll away with the
    // tab content. tabbedBodyHTML stamps an inline margin-bottom meant for a
    // strip sitting above its panels; in the header the header's own border
    // is the divider.
    var tabBar = bodyEl.querySelector("#asset-view-tabs");
    if (tabsSlot && tabBar) {
      tabBar.style.marginBottom = "0";
      tabsSlot.appendChild(tabBar);
    }

    titleEl.innerHTML = 'Asset Details' + (a.hostname
      ? ' <span style="color:var(--color-text-secondary);font-weight:400;margin-left:6px">— ' + escapeHtml(a.hostname) + '</span>'
      : '');
    if (verbsEl) verbsEl.innerHTML = _assetHeaderVerbsHTML(a);

    // IP history + firewall sightings now live in the Sources tab (no longer a
    // standalone modal). See _assetSourcesTabHTML.
    // Screenshot (camera — copies the tab as a PNG) and PDF (download tray —
    // saves the same capture as a PDF) are glyph buttons. On the Events tab
    // both give way to an Export dropdown (same page/all × CSV/PDF shape as
    // the Events page export, scoped to this asset). All are rendered up
    // front; _syncAssetFooterButtons flips visibility on tab clicks. The menu
    // drops DOWN (the default) since this group lives in the panel HEADER, and
    // right-anchors (also the default) so it stays inside the slide-over — the
    // group sits at the header's right edge, left of the lock + close pair.
    // Share copies this device's surface-neutral link (public/js/share-link.js)
    // — it opens the desktop panel or the phone sheet, whichever the
    // recipient opens it on.
    var copyBtns =
      (window.PolarisShare ? '<button type="button" class="btn btn-glyph btn-glyph-share btn-sm btn-secondary" id="btn-asset-share" title="Share — copy a link to this device for another Polaris user">Share</button>' : '') +
      '<button type="button" class="btn btn-glyph btn-glyph-camera btn-sm btn-secondary" id="btn-asset-screenshot" title="Screenshot — copy this tab as an image">Screenshot</button>' +
      '<button type="button" class="btn btn-glyph btn-glyph-download btn-sm btn-secondary" id="btn-asset-pdf" title="Export this tab to PDF">Export PDF</button>' +
      '<span class="btn-dropdown-wrap" id="asset-export-wrap" style="display:none">' +
        '<button type="button" class="btn btn-glyph btn-glyph-download btn-sm btn-secondary" id="btn-asset-export" title="Export">Export</button>' +
        '<div class="btn-dropdown-menu" id="asset-export-menu">' +
          '<div class="dropdown-heading">PDF</div>' +
          '<button data-export="page" data-fmt="pdf">Current page</button>' +
          '<button data-export="all" data-fmt="pdf">All events for this asset</button>' +
          '<div class="dropdown-divider"></div>' +
          '<div class="dropdown-heading">CSV</div>' +
          '<button data-export="page" data-fmt="csv">Current page</button>' +
          '<button data-export="all" data-fmt="csv">All events for this asset</button>' +
        '</div>' +
      '</span>' +
      // Re-fetches the asset and re-renders the whole slide-over in place
      // (fresh probes, discovery writes, tag/notes edits from elsewhere),
      // preserving the active tab. Sits between Screenshot / PDF and the
      // management-access (Open HTTPS / Open SSH) buttons.
      '<button type="button" class="btn btn-glyph btn-glyph-refresh btn-sm btn-secondary" id="btn-asset-refresh" title="Reload this asset\'s details">Refresh</button>';
    // The action group (Screenshot + PDF | Export / Refresh / management
    // access) lives in the HEADER, right-aligned and left of the lock + close
    // pair; the footer keeps only the dismiss pair (Close / Edit). Both are
    // wired the same way either side of the move — every handler below finds
    // its button by id, not by container.
    var actionBtns = copyBtns + _managementAccessButtonsHTML(a);
    var dismissBtns = '<button class="btn btn-sm btn-secondary" id="btn-asset-panel-close-btn">Close</button>' +
      (_canEditAsset(a) ? '<button class="btn btn-sm btn-primary" id="btn-asset-panel-edit-btn">Edit</button>' : '');
    if (actionsEl) actionsEl.innerHTML = actionBtns;
    footerEl.innerHTML = dismissBtns;

    wireModalTabs("asset-view");
    // Footer button swap (Screenshot ↔ Export) rides on every tab click;
    // wireModalTabs has no change hook, so a delegated listener on the tab
    // bar does it. The immediate call covers the initial (General) state.
    var assetTabBar = document.getElementById("asset-view-tabs");
    if (assetTabBar) {
      assetTabBar.addEventListener("click", function (e) {
        if (e.target.closest(".page-tab")) _syncAssetFooterButtons();
      });
    }
    _syncAssetFooterButtons();
    if (opts.tab) {
      var wantTab = document.querySelector('#asset-view-tabs .page-tab[data-tab="' + opts.tab + '"]');
      if (wantTab) wantTab.click();
    }
    if (opts.openBooking) _openBookingFromCalendar(a, opts.openBooking);
    if (deviceQueryTabs.length) wireModalTabs("asset-dq");
    if (showSnmpWalkTab) _wireSnmpWalkTab(a);
    if (apiQueryTransport) _wireAssetApiQuery(a, apiQueryTransport);
    if (_canQuarantineAsset(a)) _wireQuarantineTab(a);
    if (sdwanRules.length || sdwanLinks.length || sdwanMembers.length) _wireSdwanTab(a, sdwanRules, sdwanLinks, sdwanMembers);
    if (_pathTabEligible(pathPayload)) _wireAssetPathCheckTab(a, pathPayload);
    if (a.assetType === "switch") _wireAssetMacTableTab(a.id);
    if (_fcTabEligible(fcPayload)) _renderAssetFc(a.id, fcPayload);
    if (a.assetType === "firewall") _wireAssetArpTableTab(a.id);
    if (a.assetType === "firewall") _wireAssetChildTabs(a.id);
    if (showIpsecTab) _renderAssetIpsec(a.id, ipsecPayload, a);
    if (showServicesTab) _wireAssetServicesTab(a);
    if (showSoftwareTab) _wireAssetSoftwareTab(a);
    if (permAtLeast("events", "read")) _wireAssetEventsTab(a.id);
    if (permAtLeast("alerts", "read")) _loadAssetNotificationsTab(a.id);
    _mountAssetViewAsyncSections(a, dependencies, sources, sightings, managedAgent, agentSubpanelHTML, firmwareAvail);
    _wireHoverTriggersIn(bodyEl);
    bodyEl.addEventListener("click", _handleCopyClick);
    var shareBtn = document.getElementById("btn-asset-share");
    if (shareBtn) shareBtn.addEventListener("click", function () {
      window.PolarisShare.share("asset", a.id, { title: a.hostname || a.dnsName || a.ipAddress || "Device" });
    });
    document.getElementById("btn-asset-screenshot").addEventListener("click", function () {
      _openScreenshotOptions(a);
    });
    document.getElementById("btn-asset-pdf").addEventListener("click", function () {
      _openScreenshotOptions(a, "pdf");
    });
    _wireAssetRefreshExport(a);
    _wireManagementAccessButtons(a);
    document.getElementById("btn-asset-panel-close-btn").addEventListener("click", closeAssetPanel);
    var editBtn = document.getElementById("btn-asset-panel-edit-btn");
    if (editBtn) {
      editBtn.addEventListener("click", function () {
        // The slide-over stays open — the edit modal stacks over it
        // (openModal's .above-slideover), same as the monitoring-pill path.
        // Cancelling the modal lands back on the panel; the save handler
        // refreshes the panel behind it so it can't show pre-save values.
        openEditModal(a.id);
      });
    }
    if (a.monitored) _loadMonitorHistoryFor(a.id, _getChartRangePref("assetMonitor", "24h"));
    if (a.monitored) _loadSystemTabFor(a.id, _getChartRangePref("assetSystem", "1h"), a);
    // Both share this open's single effective-monitor-settings fetch (see
    // effSettings above) rather than issuing one apiece.
    if (a.monitored) _renderIntermittencyBar(a.id, effSettings());
    if (a.monitored) _updateStreamSourceBadgesFromEffective(a.id, a, effSettings());
    _wireAssetMonitorActions(a);
    _wireAssetDiscoverNow(a);
    _loadAssetRebootControl(a);
    _wireAssetChartRangeControls(a);
  } catch (err) {
    showToast(err.message, "error");
    closeAssetPanel();
  }
}

// --- openViewModal phases (split 2026-08 --- render-HTML / async-mount /
// wire-events helpers extracted verbatim from the 697-line orchestrator;
// each closes over nothing beyond its params + module globals) ---

// General-tab HTML (details grid + virtualization mount + dependency-tree mount).
function _assetGeneralTabHTML(a, sources) {
    // Dependency tree block (General tab) — populated asynchronously after
    // openViewModal awaits api.assets.getDependencies(id) below. Rendered
    // beneath the details table so the at-a-glance facts (hostname / IP /
    // status) come first.
    var dependencyTreeMountHTML = '<div data-shot-section="depTree" data-shot-label="Dependency Tree"><div id="asset-dep-tree-mount-' + escapeHtml(a.id) + '"></div></div>';

    // Identity rows (Hostname / Address / DNS Name); the rest of the grid
    // follows. Every other IP and MAC sits behind the Address row's pills.
    var hostnameRowHTML = a.ipAddress && !a.hostname
        ? '<div class="detail-row"><span class="detail-label">Hostname</span><span class="detail-value">- <button class="btn btn-sm btn-secondary" onclick="singleDnsLookup(' + jsArg(a.id) + ')" title="Reverse DNS lookup (PTR record)">PTR Lookup</button></span></div>'
        : (a.hostnameOverride
          ? '<div class="detail-row"><span class="detail-label">Hostname</span><span class="detail-value"><span class="copy-cell" title="Click to copy" data-copy="' + escapeHtml(a.hostname || "") + '">' + escapeHtml(a.hostname || "-") + '</span><span class="badge hue-pill" style="--hue:#6b7280;margin-left:6px" title="Hostname manually overridden — discovery will not change it. Clear the Hostname field in Edit to resume the discovered value.">overridden</span>' + hostnameOriginalLineHTML(a) + '</span></div>'
          : viewRow("Hostname", a.hostname, false, false, true));
    var identityHTML = hostnameRowHTML +
      ipViewRow(a) +
      // Firewall VIP / virtual-server rows — async-fetched (needs
      // reservations:read), and absent for the overwhelming majority of assets
      // that aren't published through one. Mounted directly under the address
      // they qualify: "this device answers on 203.0.113.10, via that gate".
      '<div id="asset-vip-mount-' + escapeHtml(a.id) + '" style="display:contents"></div>' +
      viewRow("DNS Name", a.dnsName, false, false, true);

    var generalHTML = '<div data-shot-section="details" data-shot-label="Details">' +
      _managementAccessNoticeHTML(a) +
      '<div class="asset-view-grid">' +
      identityHTML +
      viewRow("Asset Tag", a.assetTag) +
      viewRow("Serial Number", a.serialNumber, false, false, true) +
      (a.macAddress && !a.manufacturer
        ? '<div class="detail-row"><span class="detail-label">Manufacturer</span><span class="detail-value">- <button class="btn btn-sm btn-secondary" onclick="singleOuiLookup(' + jsArg(a.id) + ')" title="OUI manufacturer lookup from MAC address">OUI Lookup</button></span></div>'
        : viewRow("Manufacturer", a.manufacturer)) +
      viewRow("Model", a.model) +
      viewRow("Type", ASSET_TYPE_LABELS[a.assetType] || a.assetType) +
      viewRow("Status", a.status ? a.status.charAt(0).toUpperCase() + a.status.slice(1) : "-") +
      authorizationRowHTML(a) +
      fortilinkRowHTML(a) +
      apProfileRowHTML(a) +
      viewRow("Location", a.location || a.learnedLocation) +
      coordinatesRowHTML(a, sources) +
      geocodedAddressRowHTML(a, sources, "address-metavar") +
      geocodedAddressRowHTML(a, sources, "snmp") +
      viewRow("Department", a.department) +
      viewRow("Assigned To", a.assignedTo) +
      // Same os + osVersion join the table column uses (and the mobile sheet).
      // This row previously showed osVersion ALONE, which on a Windows client
      // read as a bare "10.0.22631.7219" with the edition dropped; on Fortinet
      // infra (os null, osVersion "7.4.4") the join is identical to before.
      viewRow("OS / Firmware", [a.os, a.osVersion].filter(Boolean).join(" ")) +
      // What the device calls itself, when it says so. Rendered next to the
      // type it produced rather than folded into it: "Network Camera" is the
      // vendor's phrase, and the Type field is the operator's bucket.
      (a.productType ? viewRow("Product type", a.productType) : "") +
      haTopologyHTML(a) +
      // Upstream-sighting rows name what the asset is connected BEHIND, so they
      // say nothing about a firewall — a FortiGate is the thing doing the
      // sighting, not the thing sighted. Hidden entirely for assetType
      // "firewall" rather than left showing three "-" rows.
      (a.assetType === "firewall"
        ? ""
        : _upstreamRowHTML("Last Seen Switch", "asset-last-sw-" + a.id, a.lastSeenSwitch) +
          _upstreamRowHTML("Last Seen AP", "asset-last-ap-" + a.id, a.lastSeenAp) +
          _upstreamRowHTML("Last Seen Firewall", "asset-last-fw-" + a.id, null)) +
      '<div id="asset-mclag-mount-' + escapeHtml(a.id) + '" style="display:contents"></div>' +
      '<div id="asset-contacts-mount-' + escapeHtml(a.id) + '" style="display:contents"></div>' +
      associatedUsersViewHTML(a.associatedUsers) +
      lastSeenRowHTML(a) +
      '<div id="asset-dir-activity-mount-' + escapeHtml(a.id) + '" style="display:contents"></div>' +
      viewRow("Acquired", (a.acquiredAt || a.createdAt) ? formatDate(a.acquiredAt || a.createdAt) : null) +
      viewRow("Warranty Expires", a.warrantyExpiry ? formatDate(a.warrantyExpiry) : null) +
      viewRow("Purchase Order", a.purchaseOrder) +
      viewRow("Tags", (a.tags || []).join(", ") || null, false, true) +
      viewRow("Description", a.description
        ? a.description + (a.descriptionSync && a.descriptionSync.status === "failed"
            ? " ⚠ (device sync failed)"
            : (a.descriptionSync && a.descriptionSync.status === "conflict"
                ? " ⚠ (sync conflict — device also edited; edit to resolve)"
                : (a.descriptionSync && a.descriptionSync.status === "synced" ? " (synced to device)" : "")))
        : null, false, true) +
      viewRow("Notes", a.notes, false, true) +
      viewRow("Created", formatDate(a.createdAt)) +
      viewRow("Updated", formatDate(a.updatedAt)) +
    '</div></div>' +
    // Virtualization section (vCenter VMs + ESXi hosts) — async-fetched;
    // stays empty for assets without vCenter data.
    (a.virtualization
      ? '<div data-shot-section="virtualization" data-shot-label="Virtualization"><div id="asset-virt-mount-' + escapeHtml(a.id) + '"></div></div>'
      : '') +
    dependencyTreeMountHTML;
    return generalHTML;
}

// Async section mounts on the General/System tabs: dependency tree, directory
// activity, last-seen firewall, MCLAG peers, virtualization, agent sub-panel.
function _mountAssetViewAsyncSections(a, dependencies, sources, sightings, managedAgent, agentSubpanelHTML, firmwareAvail) {
    // Mount the dependency tree into its placeholder div on the General tab.
    var depMount = document.getElementById("asset-dep-tree-mount-" + a.id);
    if (depMount) {
      depMount.innerHTML = renderDependencyTreeBlock(dependencies, a.id);
      _wireDependencyTreeLinks(depMount);
    }
    // Last Directory Activity row (General tab) — freshest entra/intune/ad
    // AssetSource lastSeen. Deliberately separate from Last Seen: directory
    // activity (an Intune sync, an AD logon) proves the device is alive, not
    // that it's on the network. Hidden when the asset has no directory source.
    var dirMount = document.getElementById("asset-dir-activity-mount-" + a.id);
    if (dirMount) {
      var dirActivityMs = 0;
      (sources || []).forEach(function (s) {
        if ((s.sourceKind === "entra" || s.sourceKind === "intune" || s.sourceKind === "ad") && s.lastSeen) {
          var t = new Date(s.lastSeen).getTime();
          if (t > dirActivityMs) dirActivityMs = t;
        }
      });
      if (dirActivityMs > 0) {
        dirMount.innerHTML = viewRow("Last Directory Activity", formatDate(new Date(dirActivityMs).toISOString()));
      }
    }
    // Last Seen Firewall row (General tab) — the FortiGate device from the
    // most-recent AssetFortigateSighting. Mirrors lastSeenSwitch/lastSeenAp
    // (which name the upstream switch/AP from discovery); this names the
    // upstream firewall. The exact timestamp + every firewall that has seen
    // the asset live in the Sources tab's sightings table. Left as "-" when no
    // firewall has ever sighted the asset.
    // A managed FortiSwitch / FortiAP is answered by its controller gate (the
    // one holding its FortiLink session / CAPWAP tunnel), never by sightings —
    // a statically-addressed AP has only the sightings its REPLACED gate left
    // behind. Paint that name now; the upstream call below adds the verbs.
    var fwCell = document.getElementById("asset-last-fw-" + a.id);
    var ctlTopo = (a.assetType === "access_point" || a.assetType === "switch") ? (a.fortinetTopology || null) : null;
    var ctlName = ctlTopo && (ctlTopo.controllerFortigate || ctlTopo.controllerSerial);
    if (fwCell && ctlName) {
      fwCell.textContent = ctlName;
    } else if (fwCell) {
      var bestFw = null, bestMs = -1;
      (sightings || []).forEach(function (s) {
        if (!s.fortigateDevice) return;
        var t = s.lastSeen ? new Date(s.lastSeen).getTime() : 0;
        if (t >= bestMs) { bestMs = t; bestFw = s.fortigateDevice; }
      });
      if (bestFw) fwCell.textContent = bestFw;
    }
    // Upstream verbs (General tab) — the three rows above name a device by
    // string; this resolves each to the asset behind it (server-side, through
    // the same serial/FMG-device-name/hostname precedence dependency
    // suppression uses) and upgrades the value into a row menu carrying Open
    // asset + the device's own Open HTTPS / Open SSH. Progressive: the plain
    // text painted above is the fallback, so a 403, a failure or a name that
    // resolves to nothing all leave the row exactly as it was.
    if (a.assetType !== "firewall") {
      api.assets.upstream(a.id).then(function (res) {
        _upgradeUpstreamRow("asset-last-sw-" + a.id, res && res.switch, "switch");
        _upgradeUpstreamRow("asset-last-ap-" + a.id, res && res.ap, "access point");
        _upgradeUpstreamRow("asset-last-fw-" + a.id, res && res.firewall, "firewall");
      }).catch(function (err) { console.warn("Failed to resolve upstream devices", err); });
    }
    // MCLAG Peer row (General tab) — FortiSwitch ICL peers, current-state from
    // the switch-controller CMDB. Switch-only, async-fetched, and the row is
    // only rendered when the switch is actually in an MCLAG pair (most aren't).
    // One row per distinct peer switch; each lists the ICL port pair(s) and
    // links to the peer's asset detail when discovered.
    var mclagMount = document.getElementById("asset-mclag-mount-" + a.id);
    if (mclagMount && a.assetType === "switch") {
      api.assets.mclagPeers(a.id).then(function (res) {
        var peers = (res && res.peers) || [];
        if (!peers.length) return;
        // Group ICL legs by peer switch (a multi-link ICL has several legs).
        var byPeer = {};
        peers.forEach(function (p) {
          var key = (p.matchedAsset && p.matchedAsset.id) || p.peerSn;
          if (!byPeer[key]) byPeer[key] = { name: (p.matchedAsset && p.matchedAsset.hostname) || p.peerName || p.peerSn, id: p.matchedAsset && p.matchedAsset.id, legs: [] };
          byPeer[key].legs.push((p.localPort || "?") + " ↔ " + (p.peerPort || "?"));
        });
        var html = Object.keys(byPeer).map(function (key) {
          var g = byPeer[key];
          var nameHtml = g.id
            ? '<a href="#" class="dep-tree-link" data-asset-id="' + escapeHtml(g.id) + '">' + escapeHtml(g.name) + '</a>'
            : escapeHtml(g.name);
          return '<div class="detail-row"><span class="detail-label">MCLAG Peer</span><span class="detail-value">' +
            nameHtml + ' <span style="color:var(--color-text-secondary)">(' + escapeHtml(g.legs.join(", ")) + ')</span></span></div>';
        }).join("");
        mclagMount.innerHTML = html;
        _wireDependencyTreeLinks(mclagMount);
      }).catch(function (err) { console.warn("Failed to load MCLAG peers", err); });
    }
    // VIP rows (General tab) — the firewall VIPs / virtual servers that publish
    // this device, so the external address it answers on and the gate holding
    // that VIP are on the same screen as the internal address. Needs
    // reservations:read on top of assets:read (the facts are stamped on IPAM
    // reservations), so a 403 — or an asset behind no VIP, which is nearly all
    // of them — just leaves the rows off.
    var vipMount = document.getElementById("asset-vip-mount-" + a.id);
    if (vipMount && permAtLeast("reservations", "read")) {
      api.assets.vips(a.id).then(function (res) {
        var vips = (res && res.vips) || [];
        if (!vips.length) return;
        vipMount.innerHTML = assetVipRowsHTML(vips);
        _wireDependencyTreeLinks(vipMount);
      }).catch(function (err) { console.warn("Failed to load asset VIPs", err); });
    }
    // Contacts row (General tab) — the address-book entries responsible for
    // this device, so an operator can see who an automation would email without
    // opening the Address Book and re-deriving the filters. Read-only, and the
    // row stays absent when nobody owns the device (most won't). Needs
    // contacts:read on top of assets:read, so a 403 just leaves it off.
    var contactsMount = document.getElementById("asset-contacts-mount-" + a.id);
    if (contactsMount && permAtLeast("contacts", "read")) {
      api.assets.contacts(a.id).then(function (res) {
        var cs = (res && res.contacts) || [];
        if (!cs.length) return;
        contactsMount.innerHTML = cs.map(function (c) {
          var label = c.name ? c.name + " <" + c.email + ">" : c.email;
          // "pinned" vs "filter" — an operator chasing an unexpected recipient
          // needs to know whether someone chose this device or a rule matched it.
          var via = c.via === "pinned" ? "pinned" : "matched by filter";
          return '<div class="detail-row"><span class="detail-label">Contact</span><span class="detail-value">' +
            '<a href="mailto:' + escapeHtml(c.email) + '">' + escapeHtml(label) + "</a>" +
            ' <span style="color:var(--color-text-secondary)">(' + escapeHtml(via) + ")</span>" +
            (c.description ? '<br><span style="color:var(--color-text-tertiary);font-size:0.85em">' + escapeHtml(c.description) + "</span>" : "") +
            "</span></div>";
        }).join("");
      }).catch(function (err) { console.warn("Failed to load asset contacts", err); });
    }
    // Virtualization section (General tab) — vCenter VMs show their running
    // host (clickable), cluster, power state, Tools status, vCPU/RAM,
    // virtual disks (with datastore + backing array) and guest filesystems;
    // ESXi hosts show cluster/state, mounted datastores, and the VMs
    // currently placed on them. Async-fetched from /assets/:id/virtualization.
    // A hypervisor's workloads tab and its Storage table's extra columns come
    // out of the same response.
    var virtMount = document.getElementById("asset-virt-mount-" + a.id);
    var workloadsMount = document.getElementById("asset-workloads-mount-" + a.id);
    if (_assetStorageDetails && _assetStorageDetails.assetId !== a.id) _assetStorageDetails = null;
    if ((virtMount || workloadsMount) && a.virtualization) {
      api.assets.virtualization(a.id).then(function (res) {
        if (!res || !res.virtualization) {
          if (workloadsMount) workloadsMount.innerHTML = '<p class="empty-state">No virtualization data.</p>';
          return;
        }
        if (virtMount) {
          virtMount.innerHTML = _assetVirtualizationHTML(res);
          _wireDependencyTreeLinks(virtMount);
          _wireWorkloadActions(virtMount, a, res);
        }
        if (workloadsMount) {
          workloadsMount.innerHTML = _hostWorkloadsBodyHTML(res);
          _wireDependencyTreeLinks(workloadsMount);
        }
        _setStorageDetailsFromVirtualization(a.id, res);
        var storageEl = document.getElementById("asset-system-storage");
        if (storageEl && _storageDetailsFor(a) && _assetSystemSiCache) _renderStorageTable(storageEl, _assetSystemSiCache, a);
      }).catch(function (err) {
        console.warn("Failed to load virtualization info", err);
        if (workloadsMount) workloadsMount.innerHTML = '<p class="empty-state">' + escapeHtml((err && err.message) || "Failed to load") + '</p>';
      });
    }
    // Mount the Polaris Agent panel into the System tab placeholder + wire
    // its buttons. The wiring helper also starts the install-progress
    // polling loop when the agent is in a transient state.
    var agentMount = document.getElementById("asset-agent-panel-mount");
    if (agentMount) {
      agentMount.innerHTML = agentSubpanelHTML;
      _wireAgentSubpanel(a, managedAgent);
    }
    // Firmware card (switch / AP only; the mount exists only for those).
    _rerenderFirmwarePanel(a, firmwareAvail);
}

// Footer Refresh button + the Events-tab Export dropdown.
function _wireAssetRefreshExport(a) {
    // Refresh: re-fetch + re-render the whole slide-over, then restore the
    // tab the operator was on (openViewModal rebuilds the DOM with General
    // active; clicking the saved tab also re-fires _syncAssetFooterButtons
    // via the delegated tab-bar listener).
    document.getElementById("btn-asset-refresh").addEventListener("click", async function () {
      var btn = this;
      var activeTab = document.querySelector("#asset-view-tabs .page-tab.active");
      var activeKey = activeTab ? activeTab.getAttribute("data-tab") : null;
      btn.disabled = true;
      btn.textContent = "Refreshing…";
      try {
        await openViewModal(a.id);
        if (activeKey) {
          var tabBtn = document.querySelector('#asset-view-tabs .page-tab[data-tab="' + activeKey + '"]');
          if (tabBtn) tabBtn.click();
        }
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Refresh";
        showToast("Refresh failed — " + (err && err.message ? err.message : "unknown error"), "error");
      }
    });
    // Export dropdown (Events tab) — same open/close mechanics as the Events
    // page export menu. The document-level closer is registered once per
    // page load (module guard), not once per modal open.
    var exportBtn = document.getElementById("btn-asset-export");
    var exportMenu = document.getElementById("asset-export-menu");
    if (exportBtn && exportMenu) {
      exportBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        exportMenu.classList.toggle("open");
      });
      exportMenu.addEventListener("click", function (e) { e.stopPropagation(); });
      exportMenu.querySelectorAll("button[data-export]").forEach(function (b) {
        b.addEventListener("click", function () {
          exportMenu.classList.remove("open");
          _handleAssetEventExport(b.getAttribute("data-export"), b.getAttribute("data-fmt"), a);
        });
      });
      if (!_assetExportCloserWired) {
        _assetExportCloserWired = true;
        document.addEventListener("click", function () {
          var m = document.getElementById("asset-export-menu");
          if (m) m.classList.remove("open");
        });
      }
    }
}

// System-tab monitor actions: override reset. (Discover Now is a header verb
// now — see _wireAssetDiscoverNow. No UI calls probe-now any more: the
// mobile asset sheet's refresh became a plain re-read on 2026-10-07, so
// on-demand polling is API-only.)
function _wireAssetMonitorActions(a) {
    var monitorResetBtn = document.getElementById("btn-asset-monitor-reset");
    if (monitorResetBtn) {
      monitorResetBtn.addEventListener("click", async function () {
        monitorResetBtn.disabled = true;
        monitorResetBtn.textContent = "Resetting…";
        try {
          var updated = await api.assets.resetMonitorOverride(a.id);
          showToast(
            updated.monitored
              ? "Override cleared — discovery will auto-monitor this asset"
              : "Override cleared — asset follows the integration default (not monitored)",
            "success",
          );
          // Re-open the panel so the System tab re-renders from the fresh asset
          // (monitored/override state, charts, and the badge all change).
          openViewModal(a.id);
        } catch (err) {
          showToast("Failed to reset override: " + (err && err.message ? err.message : "unknown"), "error");
          monitorResetBtn.disabled = false;
          monitorResetBtn.textContent = "Reset to integration default";
        }
      });
    }
}

// "Discover Now" button + the appear-then-disappear run watch.
function _wireAssetDiscoverNow(a) {
    var discoverBtn = document.getElementById("btn-asset-discover-now");
    if (discoverBtn && !discoverBtn.disabled) {
      discoverBtn.addEventListener("click", async function () {
        discoverBtn.disabled = true;
        discoverBtn.textContent = "Discovering…";
        var restore = function () {
          if (!document.getElementById("btn-asset-discover-now")) return; // panel re-rendered/closed
          discoverBtn.disabled = false;
          discoverBtn.textContent = "Discover Now";
        };
        try {
          var resp = await api.assets.rediscover(a.id);
          // A FortiSwitch/FortiAP is refreshed by running its CONTROLLER gate.
          // Say so — a run against a device the operator didn't click is
          // surprising unless it's named.
          if (resp.viaController && resp.deviceName) {
            showToast("Discovering via controller " + resp.deviceName + "…", "info");
          }
          if (window._pollDiscoveries) window._pollDiscoveries();
          // Watch the shared discoveries poll for the run to appear then
          // finish. /discoveries only lists ACTIVE runs (no terminal status),
          // so completion reads as appear→disappear; anomalies surface on the
          // asset's Events tab. Roles without integrations:write can't read
          // /discoveries at all (the poll silently returns []) — for them the
          // run never "appears" and the 12s branch below resets the button
          // with an informational toast instead of watching.
          var integId = resp.integrationId;
          var seen = false;
          var startedAt = Date.now();
          var watch = setInterval(function () {
            var active = ((window._getServerDiscoveries && window._getServerDiscoveries()) || [])
              .some(function (d) { return d.id === integId; });
            if (active) { seen = true; return; }
            if (seen) {
              // Appeared, now gone → the run finished. Refresh the asset.
              clearInterval(watch);
              showToast("Discovery finished — refreshing asset", "success");
              api.assets.get(a.id).then(function (fresh) {
                if (fresh && _isCurrentAsset(a.id)) {
                  Object.assign(a, fresh);
                  var pillWrap = document.getElementById("asset-status-pill-wrap");
                  if (pillWrap) pillWrap.innerHTML = assetMonitorBadge(a) + _assetOverrideBadge(a);
                }
              }).catch(function () {});
              restore();
              return;
            }
            if (Date.now() - startedAt > 12000) {
              // Never appeared: either the viewer can't read /discoveries or
              // the run finished inside one poll gap. Stop watching.
              clearInterval(watch);
              showToast("Discovery started — asset data will refresh within a few minutes", "info");
              restore();
            }
          }, 2000);
          // Hard cap so an abandoned watch can't spin forever (e.g. a run
          // that outlives the 15-minute ceiling or a wedged poll).
          setTimeout(function () { clearInterval(watch); restore(); }, 15 * 60 * 1000);
        } catch (err) {
          showToast(err.message || "Discovery failed to start", "error");
          restore();
        }
      });
    }
}

// Chart range buttons + custom-range panels + drag-select, for both the
// monitor (response-time) chart and the System-tab charts.
function _wireAssetChartRangeControls(a) {
    document.querySelectorAll(".asset-system-range-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        var range = b.getAttribute("data-range");
        var panel = document.getElementById("asset-system-custom-panel");
        if (range === "custom") {
          if (!panel) return;
          var willOpen = panel.style.display === "none";
          panel.style.display = willOpen ? "flex" : "none";
          if (willOpen) {
            var toInput = document.getElementById("asset-system-to");
            var fromInput = document.getElementById("asset-system-from");
            if (toInput && !toInput.value) toInput.value = _toLocalDatetimeInput(new Date());
            if (fromInput && !fromInput.value) fromInput.value = _toLocalDatetimeInput(new Date(Date.now() - 24 * 3600 * 1000));
          }
          return;
        }
        if (panel) panel.style.display = "none";
        document.querySelectorAll(".asset-system-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
        b.classList.remove("btn-secondary"); b.classList.add("btn-primary");
        _setChartRangePref("assetSystem", range);
        _loadSystemTabFor(a.id, range, a, { chartOnly: true });
      });
    });
    var sysApplyBtn = document.getElementById("btn-asset-system-custom-apply");
    if (sysApplyBtn) {
      sysApplyBtn.addEventListener("click", function () {
        var fromInput = document.getElementById("asset-system-from");
        var toInput   = document.getElementById("asset-system-to");
        if (!fromInput.value || !toInput.value) { showToast("Enter both From and To", "error"); return; }
        var fromIso = new Date(fromInput.value).toISOString();
        var toIso   = new Date(toInput.value).toISOString();
        if (new Date(fromIso) >= new Date(toIso)) { showToast("From must be before To", "error"); return; }
        document.querySelectorAll(".asset-system-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
        var customBtn = document.getElementById("btn-asset-system-custom");
        if (customBtn) { customBtn.classList.remove("btn-secondary"); customBtn.classList.add("btn-primary"); }
        _loadSystemTabFor(a.id, { from: fromIso, to: toIso }, a, { chartOnly: true });
      });
    }
    document.querySelectorAll(".asset-sessions-range-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        var range = b.getAttribute("data-range");
        var panel = document.getElementById("asset-sessions-custom-panel");
        if (range === "custom") {
          if (!panel) return;
          var willOpen = panel.style.display === "none";
          panel.style.display = willOpen ? "flex" : "none";
          if (willOpen) {
            var toInput = document.getElementById("asset-sessions-to");
            var fromInput = document.getElementById("asset-sessions-from");
            if (toInput && !toInput.value) toInput.value = _toLocalDatetimeInput(new Date());
            if (fromInput && !fromInput.value) fromInput.value = _toLocalDatetimeInput(new Date(Date.now() - 24 * 3600 * 1000));
          }
          return;
        }
        if (panel) panel.style.display = "none";
        document.querySelectorAll(".asset-sessions-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
        b.classList.remove("btn-secondary"); b.classList.add("btn-primary");
        _setChartRangePref("assetSessions", range);
        _loadSessionsChartFor(a.id, range, a);
      });
    });
    var sessionsApplyBtn = document.getElementById("btn-asset-sessions-custom-apply");
    if (sessionsApplyBtn) {
      sessionsApplyBtn.addEventListener("click", function () {
        var fromInput = document.getElementById("asset-sessions-from");
        var toInput   = document.getElementById("asset-sessions-to");
        if (!fromInput.value || !toInput.value) { showToast("Enter both From and To", "error"); return; }
        var fromIso = new Date(fromInput.value).toISOString();
        var toIso   = new Date(toInput.value).toISOString();
        if (new Date(fromIso) >= new Date(toIso)) { showToast("From must be before To", "error"); return; }
        document.querySelectorAll(".asset-sessions-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
        var customBtn = document.getElementById("btn-asset-sessions-custom");
        if (customBtn) { customBtn.classList.remove("btn-secondary"); customBtn.classList.add("btn-primary"); }
        _loadSessionsChartFor(a.id, { from: fromIso, to: toIso }, a);
      });
    }
    document.querySelectorAll(".asset-monitor-range-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        var range = b.getAttribute("data-range");
        var panel = document.getElementById("asset-monitor-custom-panel");
        if (range === "custom") {
          if (!panel) return;
          var willOpen = panel.style.display === "none";
          panel.style.display = willOpen ? "flex" : "none";
          if (willOpen) {
            var toInput = document.getElementById("asset-monitor-to");
            var fromInput = document.getElementById("asset-monitor-from");
            if (toInput && !toInput.value) toInput.value = _toLocalDatetimeInput(new Date());
            if (fromInput && !fromInput.value) fromInput.value = _toLocalDatetimeInput(new Date(Date.now() - 24 * 3600 * 1000));
          }
          return;
        }
        if (panel) panel.style.display = "none";
        document.querySelectorAll(".asset-monitor-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
        b.classList.remove("btn-secondary"); b.classList.add("btn-primary");
        _setChartRangePref("assetMonitor", range);
        _loadMonitorHistoryFor(a.id, range);
      });
    });
    var applyBtn = document.getElementById("btn-asset-monitor-custom-apply");
    if (applyBtn) {
      applyBtn.addEventListener("click", function () {
        var fromInput = document.getElementById("asset-monitor-from");
        var toInput   = document.getElementById("asset-monitor-to");
        if (!fromInput.value || !toInput.value) { showToast("Enter both From and To", "error"); return; }
        var fromIso = new Date(fromInput.value).toISOString();
        var toIso   = new Date(toInput.value).toISOString();
        if (new Date(fromIso) >= new Date(toIso)) { showToast("From must be before To", "error"); return; }
        document.querySelectorAll(".asset-monitor-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
        var customBtn = document.getElementById("btn-asset-monitor-custom");
        if (customBtn) { customBtn.classList.remove("btn-secondary"); customBtn.classList.add("btn-primary"); }
        _loadMonitorHistoryFor(a.id, { from: fromIso, to: toIso });
      });
    }
    // Click-drag on a chart selects a time window and applies it as that
    // chart's custom range (the custom panel opens pre-filled so the
    // selection is visible and tweakable).
    _wireChartDragSelect(document.getElementById("asset-monitor-chart"), function (fromIso, toIso) {
      _applyCustomRangeSelection({
        btnClass: "asset-monitor-range-btn", customBtnId: "btn-asset-monitor-custom",
        panelId: "asset-monitor-custom-panel", fromId: "asset-monitor-from", toId: "asset-monitor-to",
      }, fromIso, toIso);
      _loadMonitorHistoryFor(a.id, { from: fromIso, to: toIso });
    });
    var systemDragApply = function (fromIso, toIso) {
      _applyCustomRangeSelection({
        btnClass: "asset-system-range-btn", customBtnId: "btn-asset-system-custom",
        panelId: "asset-system-custom-panel", fromId: "asset-system-from", toId: "asset-system-to",
      }, fromIso, toIso);
      _loadSystemTabFor(a.id, { from: fromIso, to: toIso }, a, { chartOnly: true });
    };
    // Split section: both charts drive the SAME window, so a drag on either
    // applies to both. Combined section: only the one container exists, and
    // _wireChartDragSelect no-ops on the nulls.
    _wireChartDragSelect(document.getElementById("asset-cpu-chart"), systemDragApply);
    _wireChartDragSelect(document.getElementById("asset-memory-chart"), systemDragApply);
    _wireChartDragSelect(document.getElementById("asset-system-chart"), systemDragApply);
    _wireChartDragSelect(document.getElementById("asset-system-sessions-chart"), function (fromIso, toIso) {
      _applyCustomRangeSelection({
        btnClass: "asset-sessions-range-btn", customBtnId: "btn-asset-sessions-custom",
        panelId: "asset-sessions-custom-panel", fromId: "asset-sessions-from", toId: "asset-sessions-to",
      }, fromIso, toIso);
      _loadSessionsChartFor(a.id, { from: fromIso, to: toIso }, a);
    });
}

// Delegated (see _macTriggersCrossed): covers every hover pill the container
// holds now or is repainted with later. Safe to call on every paint.
function _wireHoverTriggersIn(container) {
  if (!container) return;
  container.addEventListener('mouseover', _handleMacOver);
  container.addEventListener('mouseout', _handleMacOut);
}

function ipViewRow(asset) {
  var ips = Array.isArray(asset.associatedIps) ? asset.associatedIps : [];
  var blankPin = asset.ipBlankPinned
    ? '<span style="font-size:0.75rem;color:var(--color-warning,#ffc107);margin-left:8px" title="Manually cleared — discovery will not put an address back; one it reports raises a conflict. Edit the asset to set one, or Revert to discovered IP.">cleared</span>'
    : '';
  // Every IP and MAC the asset carries, behind hover pills under the primary
  // (business rule 102) — replaced the separate Addresses list.
  var pills = addressPillsHTML(asset);
  if (!asset.ipAddress && ips.length === 0) {
    // A blank pin is a decision, not a gap: no IP Lookup offer (discovery-
    // style writes are dropped while it holds).
    if (blankPin) {
      return _addressRowHTML(asset, '-' + blankPin, pills);
    }
    var noIpInner = asset.hostname
      ? '- <button class="btn btn-sm btn-secondary" onclick="singleForwardLookup(' + jsArg(asset.id) + ')" title="Forward DNS lookup (A/AAAA record)">IP Lookup</button>'
      : '-';
    return _addressRowHTML(asset, noIpInner, pills);
  }
  // The pinned pair names its own provenance; "pinned" as a source label
  // beside the pinned marker would say it twice.
  var src = asset.ipSource && !asset.primaryAddressIp
    ? '<span style="font-size:0.75rem;color:var(--color-text-tertiary);margin-left:8px">' + escapeHtml(asset.ipSource) + '</span>'
    : '';
  // Operator IP pin marker (Asset.ipOverride) — mirrors the hostname
  // override marker. The pin releases itself when discovery reports the
  // same address; a differing discovery raises a conflict.
  var pin = asset.ipOverride
    ? '<span style="font-size:0.75rem;color:var(--color-warning,#ffc107);margin-left:8px" title="Manually overridden — discovery reporting this address releases the pin; a different address raises a conflict">overridden</span>'
    : '';
  var primaryPin = primaryAddressPinHTML(asset);
  // The primary ADDRESS is a pair (business rule 102): the IP monitoring
  // probes and the card it is on. The pills below carry every other address,
  // so the +N hover the table cell carries would only repeat them here.
  var ipHTML = asset.ipAddress
    ? '<span class="copy-cell" title="Click to copy" data-copy="' + escapeHtml(asset.ipAddress) + '">' + escapeHtml(asset.ipAddress) + '</span>' +
      addressConfidenceChipHTML(asset, asset.ipAddress)
    : ipCellHTML(asset);
  return _addressRowHTML(asset, ipHTML + src + pin + blankPin + primaryPin, pills);
}

// The Address row: the IPv4 (what monitoring dials) and — only while IPv6 is
// on for the install (business rule 128) — the primary IPv6 on its own line,
// each labelled; the IP / MAC pills underneath. With IPv6 off the row is the
// single unlabelled IPv4 it always was.
function _addressRowHTML(asset, v4Inner, pills) {
  var v6On = typeof polarisIpv6Enabled !== "undefined" && polarisIpv6Enabled === true;
  if (!v6On) {
    return '<div class="detail-row"><span class="detail-label">Address</span>' +
      '<span class="detail-value mono">' + v4Inner + pills + '</span></div>';
  }
  return '<div class="detail-row"><span class="detail-label">Address</span>' +
    '<span class="detail-value mono">' +
      '<span class="address-family-line"><span class="address-family-tag">IPv4</span>' + v4Inner + '</span>' +
      '<span class="address-family-line"><span class="address-family-tag">IPv6</span>' + _ipv6LineHTML(asset) + '</span>' +
      pills +
    '</span></div>';
}

// The primary IPv6 (business rule 128): the address, whether an operator
// pinned it or Polaris chose it, and the unpin control on a pin. An asset with
// no IPv4 is polled on this address, and the line says so.
function _ipv6LineHTML(asset) {
  var v6 = asset.ipv6Address || '';
  if (!v6) return '<span title="No IPv6 address is known for this asset">-</span>';
  var html = '<span class="copy-cell" title="Click to copy" data-copy="' + escapeHtml(v6) + '">' + escapeHtml(v6) + '</span>';
  if (asset.ipv6Pinned) {
    html += '<span style="font-size:0.75rem;color:var(--color-warning,#ffc107);margin-left:8px" title="Pinned by ' +
      escapeHtml(asset.ipv6PinnedBy || 'an operator') + ' — Polaris will not change it until the pin is removed">pinned</span>';
    if (canManageAssets()) {
      html += '<button type="button" class="btn btn-sm btn-secondary primary-ipv6-unpin" style="margin-left:6px" data-asset-id="' +
        escapeHtml(asset.id) + '" title="Remove the pin; Polaris picks the primary IPv6 again">Unpin</button>';
    }
  } else {
    html += '<span style="font-size:0.75rem;color:var(--color-text-tertiary);margin-left:8px" title="Chosen automatically from the addresses this asset reports — the one with the strongest evidence">auto</span>';
  }
  if (!asset.ipAddress) {
    var dialable = typeof polarisIpv6Dialable !== "undefined" && polarisIpv6Dialable === true;
    html += dialable
      ? '<span style="font-size:0.75rem;color:var(--color-text-tertiary);margin-left:8px" title="This asset has no IPv4 address, so monitoring polls it on its IPv6">monitored</span>'
      : '<span style="font-size:0.75rem;color:var(--color-warning,#ffc107);margin-left:8px" title="This asset has no IPv4 address, and this Polaris server cannot reach IPv6 — see Server Settings → Web Server → IPv6">not polled</span>';
  }
  return html;
}

// ─── Per-MAC address list + the primary-address pin (business rule 102) ─────
// An asset's addresses are its associatedIps rows, each bound to a MAC — one
// MAC can carry several (secondary addresses). The primary is the pair whose IP
// is Asset.ipAddress: the operator's pin when set, otherwise what discovery
// chose (rule 101).

var _PIN_STALE_MS = 24 * 60 * 60 * 1000; // mirrors PIN_FOLLOW_STALE_MS (src/utils/assetInvariants.ts)

function _assetAddressRows(asset) {
  var rows = Array.isArray(asset.associatedIps) ? asset.associatedIps : [];
  // With IPv6 off for the install nothing IPv6 is shown (business rule 128),
  // including rows recorded before it was switched off.
  if (typeof polarisIpv6Enabled === "undefined" || polarisIpv6Enabled !== true) {
    rows = rows.filter(function (r) { return String(r.ip || '').indexOf(':') === -1; });
  }
  return rows;
}

// Colon-uppercase, the MAC list's spelling. Interface-scrape rows written
// before the server normalized them can carry lowercase or dashed MACs, and an
// exact-string match split one card into two groups — the copy without the
// remove button looked like a MAC that would not go away.
function _addressMacKey(mac) {
  return String(mac || '').toUpperCase().replace(/-/g, ':');
}

// The MAC the primary IP is on: the pin's, else the address row holding the
// primary IP, else the identity MAC.
function primaryAddressMac(asset) {
  if (asset.primaryAddressMac) return asset.primaryAddressMac;
  if (!asset.ipAddress) return null;
  var row = _assetAddressRows(asset).find(function (r) { return r.ip === asset.ipAddress && r.mac; });
  if (row) return row.mac;
  return asset.macAddress || null;
}

// Fortinet infrastructure is monitored on its management IP; the server
// refuses a pin there, so the browser doesn't offer one.
function _assetAddressPinnable(asset) {
  var infra = asset.assetType === "firewall" || asset.assetType === "switch" || asset.assetType === "access_point";
  return !(infra && asset.fortinetTopology);
}

function primaryAddressPinHTML(asset) {
  if (!asset.primaryAddressIp) return '';
  var who = asset.primaryAddressPinnedBy ? ' by ' + asset.primaryAddressPinnedBy : '';
  var when = asset.primaryAddressPinnedAt ? ' on ' + formatDate(asset.primaryAddressPinnedAt) : '';
  var html = '<span style="font-size:0.75rem;color:var(--color-warning,#ffc107);margin-left:8px" title="' +
    escapeHtml('Pinned to ' + asset.primaryAddressIp + ' on ' + asset.primaryAddressMac + who + when +
      '. Discovery will not change it; if this card renumbers to a single new address, the pin follows.') +
    '">pinned</span>';
  // A pin that has gone quiet is held on purpose (the asset should show down),
  // so it is surfaced rather than silently moved.
  var row = _assetAddressRows(asset).find(function (r) { return r.ip === asset.primaryAddressIp && r.mac === asset.primaryAddressMac; });
  var lastMs = row && row.lastSeen ? Date.parse(row.lastSeen) : NaN;
  if (!row || (isFinite(lastMs) && Date.now() - lastMs > _PIN_STALE_MS)) {
    html += '<span style="font-size:0.75rem;color:var(--color-danger,#ef4444);margin-left:8px" title="' +
      escapeHtml(row ? 'No gate has reported this pinned address since ' + formatDate(row.lastSeen) : 'This pinned address is no longer on the asset\'s address list') +
      '">&#9888; not seen' + (row ? ' since ' + escapeHtml(formatDate(row.lastSeen)) : '') + '</span>';
  }
  if (canManageAssets()) {
    html += ' <button type="button" class="btn btn-sm btn-secondary primary-address-unpin" style="margin-left:6px;padding:1px 6px;font-size:0.72rem" ' +
      'data-asset-id="' + escapeHtml(asset.id) + '" title="Release the pin — the asset moves to its best-backed listed address">Unpin</button>';
  }
  return html;
}

function formatAddressSource(source) {
  switch (source) {
    case "device-inventory":    return "Detected device";
    case "dhcp-lease":          return "DHCP lease";
    case "dhcp-reservation":    return "DHCP reservation";
    case "arp":                 return "ARP";
    case "monitor-system-info": return "Interface";
    case "agent-interface":     return "Agent";
    case "manual":              return "Manual";
    default: return source || "";
  }
}

// ─── Address confidence (business rule 103) ────────────────────────────────
// The server scores every address (src/utils/addressConfidence.ts) and ships
// it on the asset as `addressConfidence[ip]`: the detail endpoint with the
// breakdown (parts / penalties), the list endpoint as { score, band } only.
// Informational — nothing here decides anything except whether to ask first.

var _CONF_BAND_LABEL = { "high": "high", "medium": "medium", "low": "low", "very-low": "very low" };

function _confAge(iso) {
  var ms = Date.now() - Date.parse(iso || "");
  if (!isFinite(ms)) return "";
  if (ms < 90 * 1000) return "just now";
  var min = Math.round(ms / 60000);
  if (min < 90) return min + " min ago";
  var h = Math.round(min / 60);
  if (h < 48) return h + " h ago";
  return Math.round(h / 24) + " d ago";
}

function _confHours(h) {
  if (!(h > 0)) return "";
  if (h < 1) return Math.max(1, Math.round(h * 60)) + " min";
  if (h < 48) return (Math.round(h * 10) / 10) + " h";
  var d = Math.floor(h / 24);
  return d + " d " + Math.round(h - d * 24) + " h";
}

function _addressConfidence(asset, ip) {
  var m = asset && asset.addressConfidence;
  return m && ip && m[ip] ? m[ip] : null;
}

// The breakdown as tooltip rows — what each piece of evidence contributed.
function _confidenceBreakdownHTML(c) {
  var rows = (c.parts || []).map(function (p) {
    var bits = [escapeHtml(p.label)];
    if (p.device) bits.push(escapeHtml(p.device));
    if (p.kind === "polling" && p.hours != null) bits.push(_confHours(p.hours));
    else if (p.seenAt) bits.push(_confAge(p.seenAt));
    return '<div class="mac-tooltip-row"><span class="mac-tooltip-meta"><span class="mac-tooltip-source">' +
      bits.join(' &middot; ') + '</span></span><span class="mono" style="margin-left:auto">' +
      Number(p.value).toFixed(2) + '</span></div>';
  }).join('');
  (c.penalties || []).forEach(function (p) {
    rows += '<div class="mac-tooltip-row addr-conf-penalty">&#9888; ' + escapeHtml(p.detail) +
      ' <span class="mono" style="margin-left:auto">&times;' + p.factor + '</span></div>';
  });
  if (c.sustained) {
    rows += '<div class="mac-tooltip-row"><span class="mac-tooltip-source">Polling is answering here, so this evidence is not aged</span></div>';
  }
  if (c.parts && c.evidenceScore != null && c.evidenceScore !== c.score) {
    rows += '<div class="mac-tooltip-row"><span class="mac-tooltip-source">Network evidence alone: ' + c.evidenceScore + '</span></div>';
  }
  if (!c.parts) {
    rows += '<div class="mac-tooltip-row"><span class="mac-tooltip-source">Open the asset for what the score is made of</span></div>';
  }
  return rows;
}

// A score chip that opens the breakdown on hover (detail panel), or a plain
// chip whose title names the score (inside another tooltip, where hovers
// can't nest).
function addressConfidenceChipHTML(asset, ip, opts) {
  var c = _addressConfidence(asset, ip);
  if (!c) return '';
  var band = c.band || "very-low";
  var label = 'Confidence ' + c.score + ' (' + (_CONF_BAND_LABEL[band] || band) + ')';
  var chip = '<span class="addr-conf addr-conf-' + escapeHtml(band) + '"' +
    (opts && opts.plain ? ' title="' + escapeHtml(label) + '"' : '') + '>' + c.score + '</span>';
  if (opts && opts.plain) return chip;
  return '<span class="mac-hover-trigger addr-conf-trigger">' + chip +
    '<div class="mac-tooltip"><div class="mac-tooltip-header">' + escapeHtml(ip) + ' — ' + escapeHtml(label) + '</div>' +
    _confidenceBreakdownHTML(c) + '</div></span>';
}

/**
 * Before applying a pin or a typed address: score the candidate and, below the
 * warn line, ask — naming the evidence (or its absence) and, for a typed
 * address, whether it answered a ping just now. Resolves true to go ahead. A
 * failed check never blocks the write: it is advice, not a gate.
 */
async function _confirmAddressConfidence(assetId, ip, opts) {
  var probe = !!(opts && opts.probe);
  var check = opts && opts.check;
  if (!check) {
    try {
      check = await api.assets.addressCheck(assetId, ip, probe);
    } catch (err) {
      return true;
    }
  }
  if (!check || !check.warn) return true;
  var lines = [];
  lines.push(ip + ' has ' + (_CONF_BAND_LABEL[check.evidenceBand] || check.evidenceBand) +
    ' confidence (' + check.evidenceScore + ', below ' + check.warnBelow + ').');
  if (!check.parts || !check.parts.length) {
    lines.push('Polaris has never seen this address on this device.');
  } else {
    lines.push('What Polaris has: ' + check.parts.map(function (p) {
      var where = p.device ? ' on ' + p.device : '';
      var when = p.kind === "polling" ? ' for ' + _confHours(p.hours) : (p.seenAt ? ', ' + _confAge(p.seenAt) : '');
      return p.label + where + when;
    }).join('; ') + '.');
  }
  (check.penalties || []).forEach(function (p) { lines.push(p.detail + '.'); });
  if (check.probe) {
    lines.push(check.probe.answered
      ? 'It answered a ping from this server just now (that shows something is there, not that it is this device).'
      : 'It did not answer a ping from this server' + (check.probe.error ? ' (' + check.probe.error + ')' : '') + '.');
  }
  lines.push('', 'Use it anyway?');
  return showConfirm(lines.join('\n'));
}

var _MAC_ROW_IPS_VISIBLE = 3;
var _ADDRESS_PRIMARY_BADGE = '<span class="address-primary-badge" title="The address monitoring probes">&#9733; Primary</span>';
var _ADDRESS_PRIMARY_IPV6_BADGE = '<span class="address-primary-badge" title="The asset&#39;s primary IPv6 — polled only when the asset has no IPv4">&#9733; Primary IPv6</span>';

// The IPAM network the address sits in (server-resolved, gate-aware), as a
// chip beside the score: "VLAN n", or the CIDR when the network has no VLAN.
// Its title names the network in full. Plain title, not a hover — hovers
// can't nest inside the IPs hover.
function _addressNetworkChipHTML(net) {
  if (!net || !(net.name || net.cidr)) return '';
  var hasVlan = net.vlan != null;
  var label = hasVlan ? 'VLAN ' + String(net.vlan) : (net.cidr || net.name);
  var title = [net.name, net.cidr, hasVlan ? 'VLAN ' + String(net.vlan) : null]
    .filter(function (s) { return s; }).join(' · ');
  return '<span class="addr-net-chip" title="' + escapeHtml(title) + '">' + escapeHtml(label) + '</span>';
}

// One address in the IPs hover: the IP, its score chip (plain — hovers can't
// nest), its network chip, the MAC it is on, provenance, and the star or
// "Set as primary".
function _addressTooltipRowHTML(asset, r, isPrimary, pinnable) {
  var bits = [];
  bits.push(r.mac
    ? 'on <span class="mono copy-cell" title="Click to copy" data-copy="' + escapeHtml(r.mac) + '">' + escapeHtml(r.mac) + '</span>'
    : 'no MAC');
  var label = formatAddressSource(r.source);
  if (label) bits.push(escapeHtml(label));
  var netChip = _addressNetworkChipHTML(r.network);
  if (r.device) bits.push(escapeHtml(r.device));
  // The interface's primary address gets a pill; its secondary addresses get
  // none (FortiOS names them; other collectors leave the role unknown).
  if (r.interfaceName) {
    bits.push(escapeHtml(r.interfaceName) + (r.interfaceRole === "primary"
      ? '<span class="badge badge-type address-iface-role" title="The primary address of ' + escapeHtml(r.interfaceName) + '; any others on it are secondary addresses">primary</span>'
      : ''));
  }
  if (r.medium) bits.push(r.medium === "wired" ? "wired" : r.medium === "wireless" ? "wireless" : escapeHtml(r.medium));
  if (r.lastSeen) bits.push(formatDate(r.lastSeen));
  // An IPv6 row carries the primary-IPv6 marker or its own pin button
  // (business rule 128) — never the IPv4 pin, which is what monitoring dials.
  if (String(r.ip || '').indexOf(':') !== -1) {
    var v6Star = r.ip === asset.ipv6Address
      ? _ADDRESS_PRIMARY_IPV6_BADGE
      : (canManageAssets()
        ? '<button type="button" class="btn btn-sm btn-secondary primary-ipv6-set" ' +
            'data-asset-id="' + escapeHtml(asset.id) + '" data-ip="' + escapeHtml(r.ip) + '" ' +
            'title="Make ' + escapeHtml(r.ip) + ' this asset&#39;s primary IPv6">Set as primary IPv6</button>'
        : '');
    return '<div class="mac-tooltip-row">' +
      '<span class="mono copy-cell" title="Click to copy" data-copy="' + escapeHtml(r.ip) + '">' + escapeHtml(r.ip) + '</span>' +
      netChip +
      '<span class="mac-tooltip-meta"><span class="mac-tooltip-source">' + bits.join(' &middot; ') + '</span></span>' +
      v6Star +
    '</div>';
  }
  var star = isPrimary
    ? _ADDRESS_PRIMARY_BADGE
    : (r.mac && pinnable
      ? '<button type="button" class="btn btn-sm btn-secondary primary-address-set" ' +
          'data-asset-id="' + escapeHtml(asset.id) + '" data-mac="' + escapeHtml(r.mac) + '" data-ip="' + escapeHtml(r.ip) + '" ' +
          'title="Monitor this asset on ' + escapeHtml(r.ip) + '">Set as primary</button>'
      : '');
  return '<div class="mac-tooltip-row">' +
    '<span class="mono copy-cell" title="Click to copy" data-copy="' + escapeHtml(r.ip) + '">' + escapeHtml(r.ip) + '</span>' +
    addressConfidenceChipHTML(asset, r.ip, { plain: true }) +
    netChip +
    '<span class="mac-tooltip-meta"><span class="mac-tooltip-source">' + bits.join(' &middot; ') + '</span></span>' +
    star +
  '</div>';
}

// One MAC in the MACs hover: the MAC, the IPs bound to it, provenance, the
// star when it carries the primary, and the remove ×. A MAC only address rows
// carry (an interface-scrape port inside a collapsed range, or a MAC removed
// from the list whose interface / manual addresses stay) has no MAC row to
// remove, so it gets no ×; "Not on MAC list" says the missing button is
// deliberate rather than broken.
function _macTooltipRowHTML(asset, m, ips, isPrimary) {
  var bits = [];
  // A firewall card can carry a dozen interface addresses; the IPs hover has
  // them all, so this line names the first few.
  var shownIps = ips.slice(0, _MAC_ROW_IPS_VISIBLE);
  bits.push(ips.length
    ? shownIps.map(function (r) {
        return '<span class="mono copy-cell" title="Click to copy" data-copy="' + escapeHtml(r.ip) + '">' + escapeHtml(r.ip) + '</span>';
      }).join(', ') + (ips.length > shownIps.length ? ' +' + (ips.length - shownIps.length) + ' more' : '')
    : 'no address');
  if (m.source) bits.push(escapeHtml(formatMacSource(m.source)));
  else if (m.addressOnly) {
    bits.push('<span title="Only the addresses on this card name this MAC — they come from the device\'s own interface table or were entered by hand, so there is no MAC entry to remove">Not on MAC list</span>');
  }
  if (m.lastSeen) bits.push(formatDate(m.lastSeen));
  return '<div class="mac-tooltip-row">' +
    '<span class="mono copy-cell" title="Click to copy" data-copy="' + escapeHtml(m.mac) + '">' + escapeHtml(m.mac) + '</span>' +
    '<span class="mac-tooltip-meta"><span class="mac-tooltip-source">' + bits.join(' &middot; ') + '</span></span>' +
    (isPrimary ? _ADDRESS_PRIMARY_BADGE : '') +
    (m.source ? macDeleteButtonHTML(asset.id, m) : '') +
  '</div>';
}

function _addressPillHTML(label, header, rows, title) {
  return '<span class="mac-hover-trigger">' +
    '<span class="mac-badge-count" style="margin-left:0"' + (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' + label + '</span>' +
    '<div class="mac-tooltip"><div class="mac-tooltip-header">' + header + '</div>' + rows + '</div>' +
  '</span>';
}

/**
 * The pills under the Address row: "N IPs" and "N MACs", each a hover listing
 * every one (click any IP or MAC to copy), plus the collapsed port-MAC ranges.
 * The IPs hover keeps "Set as primary"; the MACs hover keeps the remove ×.
 * Empty string when the asset carries no MAC and no address.
 */
function addressPillsHTML(asset) {
  var macs = Array.isArray(asset.macAddresses) ? asset.macAddresses : [];
  var rows = _assetAddressRows(asset);
  if (macs.length === 0 && rows.length === 0) return '';

  var primaryIp = asset.ipAddress || null;
  var pinMacKey = asset.primaryAddressMac ? _addressMacKey(asset.primaryAddressMac) : null;
  var primaryMacKey = primaryIp ? _addressMacKey(primaryAddressMac(asset)) : null;
  var singles = macs.filter(function (m) { return !m.macEnd; });
  var ranges = macs.filter(function (m) { return !!m.macEnd; });
  var pinnable = _canEditAsset(asset) && _assetAddressPinnable(asset);
  function isPrimaryRow(r) {
    return r.ip === primaryIp && (!pinMacKey || (!!r.mac && _addressMacKey(r.mac) === pinMacKey));
  }
  function fresher(a, b) {
    return (Date.parse(b.lastSeen || 0) || 0) - (Date.parse(a.lastSeen || 0) || 0);
  }

  var pills = '';

  if (rows.length) {
    // The primary first, then freshest.
    var sorted = rows.slice().sort(function (a, b) {
      var ap = isPrimaryRow(a) ? 1 : 0, bp = isPrimaryRow(b) ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return fresher(a, b);
    });
    var ipRows = sorted.map(function (r) { return _addressTooltipRowHTML(asset, r, isPrimaryRow(r), pinnable); }).join('');
    var ipWord = rows.length + ' IP' + (rows.length === 1 ? '' : 's');
    pills += _addressPillHTML(ipWord, ipWord, ipRows);
  }

  // Group address rows by MAC, whatever the MAC's case or separator. A MAC
  // that only address rows name still gets its own entry so no card is hidden.
  var byMac = {};
  rows.forEach(function (r) {
    if (!r.mac) return;
    var key = _addressMacKey(r.mac);
    (byMac[key] = byMac[key] || []).push(r);
  });
  var listed = {};
  var groups = singles.map(function (m) {
    var key = _addressMacKey(m.mac);
    listed[key] = true;
    return { m: m, key: key, ips: byMac[key] || [] };
  });
  Object.keys(byMac).forEach(function (key) {
    if (!listed[key]) groups.push({ m: { mac: key, addressOnly: true }, key: key, ips: byMac[key] });
  });
  if (groups.length) {
    // The card holding the primary first, then those with addresses, then
    // freshest MAC.
    groups.sort(function (a, b) {
      var ap = a.key === primaryMacKey ? 1 : 0, bp = b.key === primaryMacKey ? 1 : 0;
      if (ap !== bp) return bp - ap;
      if (!!a.ips.length !== !!b.ips.length) return b.ips.length ? 1 : -1;
      return fresher(a.m, b.m);
    });
    var macRows = groups.map(function (g) {
      return _macTooltipRowHTML(asset, g.m, g.ips.slice().sort(fresher), g.key === primaryMacKey);
    }).join('');
    var macWord = groups.length + ' MAC' + (groups.length === 1 ? '' : 's');
    pills += _addressPillHTML(macWord, macWord, macRows);
  }

  if (ranges.length) {
    var total = macEntriesTotal(ranges);
    var rangeRows = ranges.map(function (m) {
      return '<div class="mac-tooltip-row">' +
        '<span class="mono copy-cell" title="Click to copy" data-copy="' + escapeHtml(macEntryText(m)) + '">' + escapeHtml(macEntryText(m)) + '</span>' +
        '<span class="mac-tooltip-meta"><span class="mac-tooltip-source">' + macEntryCount(m) + ' MACs &middot; ' +
          escapeHtml(formatMacSource(m.source)) + (m.lastSeen ? ' &middot; ' + formatDate(m.lastSeen) : '') + '</span></span>' +
        macDeleteButtonHTML(asset.id, m) +
      '</div>';
    }).join('');
    pills += _addressPillHTML(total + ' port MAC' + (total === 1 ? '' : 's'), 'Port MAC ranges', rangeRows,
      'Port MACs from the interface table — never a primary address');
  }

  return pills ? '<div class="address-pills">' + pills + '</div>' : '';
}

async function _handlePrimaryAddressClick(e) {
  // The primary IPv6 pin (business rule 128) — its own endpoint, no
  // confidence pre-check: it is not the address monitoring dials unless the
  // asset has no IPv4.
  var v6Btn = e.target.closest('.primary-ipv6-set, .primary-ipv6-unpin');
  if (v6Btn) {
    e.preventDefault();
    e.stopPropagation();
    var v6Asset = v6Btn.getAttribute('data-asset-id');
    if (!v6Asset) return;
    var setting = v6Btn.classList.contains('primary-ipv6-set');
    var v6Ip = v6Btn.getAttribute('data-ip');
    var v6Ok = await showConfirm(setting
      ? 'Make ' + v6Ip + ' this asset’s primary IPv6?\n\nPolaris stops choosing it automatically until you remove the pin.'
      : 'Remove the primary IPv6 pin?\n\nPolaris picks the primary IPv6 from the addresses the asset reports.');
    if (!v6Ok) return;
    v6Btn.disabled = true;
    try {
      if (setting) {
        await api.assets.pinPrimaryIpv6(v6Asset, v6Ip);
        showToast('Primary IPv6 pinned to ' + v6Ip);
      } else {
        await api.assets.unpinPrimaryIpv6(v6Asset);
        showToast('Primary IPv6 pin removed');
      }
    } catch (err) {
      v6Btn.disabled = false;
      showToast(err.message, 'error');
      return;
    }
    if (_isCurrentAsset(v6Asset)) await openViewModal(v6Asset);
    return;
  }
  var setBtn = e.target.closest('.primary-address-set');
  var unpinBtn = setBtn ? null : e.target.closest('.primary-address-unpin');
  var btn = setBtn || unpinBtn;
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  var assetId = btn.getAttribute('data-asset-id');
  if (!assetId) return;
  var ok;
  if (setBtn) {
    var mac = setBtn.getAttribute('data-mac');
    var ip = setBtn.getAttribute('data-ip');
    // Rule 103: a low-confidence pair asks first, naming its evidence. Above
    // the line, the ordinary confirm.
    btn.disabled = true;
    var confident;
    try {
      var check = await api.assets.addressCheck(assetId, ip, false).catch(function () { return null; });
      confident = !check || !check.warn;
      ok = confident
        ? await showConfirm(
            'Monitor this asset on ' + ip + ' (' + mac + ')?\n\n' +
            'The address is pinned: discovery will not change it, and it replaces any address typed in Edit. ' +
            'If this card renumbers to a single new address, the pin follows it.')
        : await _confirmAddressConfidence(assetId, ip, { check: check });
    } finally {
      btn.disabled = false;
    }
    if (!ok) return;
    btn.disabled = true;
    try {
      await api.assets.pinPrimaryAddress(assetId, mac, ip);
      showToast('Primary address pinned to ' + ip);
    } catch (err) {
      btn.disabled = false;
      showToast(err.message, 'error');
      return;
    }
  } else {
    ok = await showConfirm('Release the pinned primary address?\n\nThe asset moves to the listed address with the highest confidence; discovery manages it from then on.');
    if (!ok) return;
    btn.disabled = true;
    try {
      await api.assets.unpinPrimaryAddress(assetId);
      showToast('Primary address pin released');
    } catch (err) {
      btn.disabled = false;
      showToast(err.message, 'error');
      return;
    }
  }
  if (_isCurrentAsset(assetId)) await openViewModal(assetId);
  if (typeof loadAssets === "function" && document.getElementById("assets-tbody")) loadAssets();
}
// Wired at load, not in the Assets page's init: the slide-over opens on any
// page through PolarisPanels, and assets.js can be evaluated twice.
if (!window.__polarisPrimaryAddressWired) {
  window.__polarisPrimaryAddressWired = true;
  document.addEventListener("click", _handlePrimaryAddressClick);
}

// ─── Management access (allowaccess) — Open HTTPS / Open SSH + AP warning ──────
// Asset.managementAccess is read during FMG/FortiGate discovery (Phase 13.6).
// Shape: { source, interfaceName, profileName, mgmtIp, protocols, https, ssh,
// snmp, checkedAt }. protocols === null means the access list could not be read
// (best-effort switch path) — we then render buttons optimistically.
// A SERVER's verbs come from its TYPE, not from a captured access list: no
// discovery source reads a Windows or Linux host's management surface, so
// there is no allowaccess to consult and never will be. RDP + SSH are
// therefore offered optimistically — the same "unknown is not denied" posture
// the best-effort FortiSwitch path (`protocols == null`) already takes, and
// the same `unverified` note in the options menu. Deliberately NOT extended to
// `workstation`: an operator reaches a server from inventory, and every
// endpoint row growing two dead verbs is how a row menu stops being read.
function _assetMgmtAccess(asset) {
  if (!asset) return null;
  var ma = (asset.managementAccess && typeof asset.managementAccess === "object") ? asset.managementAccess : null;
  // { rdp, ssh } for the types whose access is inferred; null for the rest.
  var byType = asset.assetType === "server" ? { rdp: true, ssh: true } : null;
  if (!ma && !byType) return null;
  var mgmtIp = (ma && ma.mgmtIp) || asset.ipAddress || null;
  if (!mgmtIp) return null;
  // null/undefined → couldn't read (switch); no blob at all → never readable (server).
  var unknown = !ma || ma.protocols == null;
  return {
    ma: ma,
    mgmtIp: mgmtIp,
    showHttps: !!(ma && (ma.https || unknown)),
    showRdp: !!(byType && byType.rdp),
    showSsh: !!(ma ? (ma.ssh || unknown) : byType.ssh),
    unknown: unknown,
  };
}

// AP-only warning banner: surfaces management protocols disabled in the AP's
// wtp-profile, emphasizing SNMP since it gates monitoring. Rendered at the top
// of the General tab. Returns "" for non-APs or when the profile couldn't be read.
function _managementAccessNoticeHTML(asset) {
  if (!asset || asset.assetType !== "access_point") return "";
  var ma = asset.managementAccess;
  if (!ma || typeof ma !== "object" || ma.protocols == null) return "";
  var disabled = [];
  if (!ma.snmp)  disabled.push("SNMP");
  if (!ma.https) disabled.push("HTTPS");
  if (!ma.ssh)   disabled.push("SSH");
  if (disabled.length === 0) return "";
  var profile = ma.profileName ? ' (profile "' + escapeHtml(ma.profileName) + '")' : "";
  var msg = !ma.snmp
    ? "SNMP is not enabled in this access point's profile" + profile +
      " — SNMP-based monitoring will not work. Disabled: " + disabled.join(", ") + "."
    : "Management access disabled in this access point's profile" + profile + ": " + disabled.join(", ") + ".";
  return '<div style="margin-bottom:0.75rem;padding:0.5rem 0.75rem;background:rgba(245,127,23,0.08);' +
    'border:1px solid rgba(245,127,23,0.3);border-radius:6px;font-size:0.8rem;color:var(--color-warning)">' +
    '&#9888; ' + msg + '</div>';
}

// Footer action buttons: Open HTTPS + an Open SSH split-button (caret menu for
// ssh:// vs copy-command vs set-default-user). Returns "" when there's no
// management surface to act on.
function _managementAccessButtonsHTML(asset) {
  var info = _assetMgmtAccess(asset);
  if (!info) return "";
  var html = "";
  if (info.showHttps) {
    html += '<button type="button" class="btn btn-sm btn-secondary" id="btn-asset-https" ' +
      'title="Open https://' + escapeHtml(info.mgmtIp) + ' in a new tab">Open HTTPS</button>';
  }
  var hint = info.unknown
    ? '<div class="dropdown-heading">Access state unverified for this device</div>'
    : "";
  if (info.showRdp) {
    html += '<span class="btn-dropdown-wrap" id="asset-rdp-wrap">' +
      '<button type="button" class="btn btn-sm btn-secondary" id="btn-asset-rdp" ' +
        'title="Open a Remote Desktop session to ' + escapeHtml(info.mgmtIp) + '">Open RDP</button>' +
      '<button type="button" class="btn btn-sm btn-secondary" id="btn-asset-rdp-caret" ' +
        'title="RDP options" style="padding-left:6px;padding-right:6px">&#9662;</button>' +
      '<div class="btn-dropdown-menu" id="asset-rdp-menu">' +
        hint +
        '<button data-rdp="file">Download .rdp file</button>' +
        '<button data-rdp="uri">Open rdp:// link</button>' +
        '<button data-rdp="copy">Copy mstsc command</button>' +
        '<div class="dropdown-divider"></div>' +
        '<button data-rdp="setuser">Set default RDP user&hellip;</button>' +
      '</div>' +
    '</span>';
  }
  if (info.showSsh) {
    html += '<span class="btn-dropdown-wrap" id="asset-ssh-wrap">' +
      '<button type="button" class="btn btn-sm btn-secondary" id="btn-asset-ssh" ' +
        'title="Open an SSH session to ' + escapeHtml(info.mgmtIp) + '">Open SSH</button>' +
      '<button type="button" class="btn btn-sm btn-secondary" id="btn-asset-ssh-caret" ' +
        'title="SSH options" style="padding-left:6px;padding-right:6px">&#9662;</button>' +
      // Drops DOWN (the default): this group renders in the slide-over
      // HEADER, not the footer it used to sit in.
      '<div class="btn-dropdown-menu" id="asset-ssh-menu">' +
        hint +
        '<button data-ssh="uri">Open ssh:// link</button>' +
        '<button data-ssh="copy">Copy ssh command</button>' +
        '<div class="dropdown-divider"></div>' +
        '<button data-ssh="setuser">Set default SSH user&hellip;</button>' +
      '</div>' +
    '</span>';
  }
  return html;
}

// Per-user SSH preferences live in localStorage (no backend) — same model as
// other per-user UI prefs. Keys follow the standard "polaris-" dash convention
// (the only dot-separated stragglers were renamed 2026-08; readers migrate the
// legacy keys on first touch). `polaris-ssh-action` ∈ {uri, copy};
// `polaris-ssh-user` is an optional default username prepended to ssh://
// links + copied commands.
function _sshPref(key, legacyKey) {
  try {
    var v = localStorage.getItem(key);
    if (v === null) {
      v = localStorage.getItem(legacyKey);
      if (v !== null) {
        localStorage.setItem(key, v);
        localStorage.removeItem(legacyKey);
      }
    }
    return v;
  } catch (e) { return null; }
}
function _sshUser() {
  return (_sshPref("polaris-ssh-user", "polaris.ssh.user") || "").trim();
}
function _sshAction() {
  return _sshPref("polaris-ssh-action", "polaris.ssh.action") === "copy" ? "copy" : "uri";
}
// What may be put into a generated connection: an ssh:// link, a copy-and-paste
// command line, an .rdp file. A host is an address or hostname; a username is the
// usual account spellings. Anything else (a line break that would add lines to
// the .rdp file, a `;` that would add a command to a pasted line) is refused, not
// stripped — a silently altered target is worse than a refused one. Rule 107.
function _connectHostOk(h) { return typeof h === "string" && /^[A-Za-z0-9._:%\[\]-]+$/.test(h); }
function _connectUserOk(u) { return !u || /^[A-Za-z0-9._@\\-]+$/.test(u); }
function _connectRefused(what) {
  showToast("That " + what + " contains characters that cannot be used in a connection, so nothing was launched.", "error");
}
function _sshTarget(mgmtIp) {
  var user = _sshUser();
  return (user ? user + "@" : "") + mgmtIp;
}
function _doSshLaunch(mgmtIp, action) {
  if (!_connectHostOk(mgmtIp)) { _connectRefused("address"); return; }
  if (!_connectUserOk(_sshUser())) { _connectRefused("username"); return; }
  var target = _sshTarget(mgmtIp);
  if (action === "copy") {
    var cmd = "ssh " + target;
    copyTextToClipboard(cmd).then(function (ok) {
      showToast(ok ? "Copied: " + cmd : "Copy failed — " + cmd, ok ? "success" : "error");
    });
  } else {
    // Browsers are sandboxed: this hands ssh://user@host to whatever app the OS
    // has registered for the ssh:// scheme (PuTTY, Windows Terminal, Konsole…).
    window.location.href = "ssh://" + target;
  }
}
// RDP prefs mirror the SSH pair above: `polaris-rdp-action` ∈ {file, uri,
// copy} and `polaris-rdp-user` an optional default username stamped into the
// generated file / URI.
//
// The default is the .rdp FILE, not a URI, because mstsc.exe — the client on
// every Windows box — registers no URL scheme at all: `rdp://` is honored only
// by the Microsoft Remote Desktop app family (Store / macOS / iOS / Android),
// whereas the `.rdp` file association is mstsc's and always has been. So the
// default reaches a session wherever an RDP client exists, and the URI stays
// available for the operators whose client handles it.
function _rdpUser() {
  try { return (localStorage.getItem("polaris-rdp-user") || "").trim(); } catch (e) { return ""; }
}
function _rdpAction() {
  var v = null;
  try { v = localStorage.getItem("polaris-rdp-action"); } catch (e) {}
  return (v === "uri" || v === "copy") ? v : "file";
}
/**
 * Minimal .rdp descriptor — the address, a maximized window, the optional
 * username. CRLF-joined and CRLF-terminated because the consumer is a Windows
 * client. No credential is ever written: `prompt for credentials` leaves the
 * password prompt to the client, so nothing sensitive lands in the download.
 */
function _rdpFileBody(host, user) {
  var lines = ["full address:s:" + host, "screen mode id:i:2", "prompt for credentials:i:1"];
  if (user) lines.push("username:s:" + user);
  return lines.join("\r\n") + "\r\n";
}
/** Microsoft's RDP URI scheme: .rdp keys, & separated, value types inline. */
function _rdpUri(host, user) {
  var uri = "rdp://full%20address=s:" + encodeURIComponent(host) + ":3389";
  if (user) uri += "&username=s:" + encodeURIComponent(user);
  return uri;
}
function _doRdpLaunch(mgmtIp, action) {
  var user = _rdpUser();
  if (!_connectHostOk(mgmtIp)) { _connectRefused("address"); return; }
  if (!_connectUserOk(user)) { _connectRefused("username"); return; }
  if (action === "copy") {
    // mstsc takes no username flag, so the user pref is a file/URI-only field.
    var cmd = "mstsc /v:" + mgmtIp;
    copyTextToClipboard(cmd).then(function (ok) {
      showToast(ok ? "Copied: " + cmd : "Copy failed — " + cmd, ok ? "success" : "error");
    });
    return;
  }
  if (action === "uri") {
    window.location.href = _rdpUri(mgmtIp, user);
    return;
  }
  var name = mgmtIp.replace(/[^A-Za-z0-9._-]/g, "_") + ".rdp";
  var blob = new Blob([_rdpFileBody(mgmtIp, user)], { type: "application/x-rdp" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast("Downloaded " + name + " — open it to start the session");
}

/**
 * Wire ONE remote-access split button: the primary button performs the
 * operator's stored default, the caret toggles the options menu, and picking
 * an action both performs it and becomes the new default. The SSH and RDP
 * groups are structurally identical (same markup, same toggle/close dance,
 * same "setuser" escape hatch), so they share this wiring rather than each
 * carrying a copy that can drift.
 */
function _wireRemoteAccessMenu(cfg) {
  var btn = document.getElementById("btn-asset-" + cfg.kind);
  if (btn) btn.addEventListener("click", function () { cfg.launch(cfg.action()); });
  var caret = document.getElementById("btn-asset-" + cfg.kind + "-caret");
  var menu = document.getElementById("asset-" + cfg.kind + "-menu");
  if (!caret || !menu) return;
  caret.addEventListener("click", function (e) { e.stopPropagation(); menu.classList.toggle("open"); });
  menu.addEventListener("click", function (e) { e.stopPropagation(); });
  menu.querySelectorAll("button[data-" + cfg.kind + "]").forEach(function (b) {
    b.addEventListener("click", function () {
      menu.classList.remove("open");
      var act = b.getAttribute("data-" + cfg.kind);
      if (act === "setuser") { cfg.setUser(); return; }
      // Otherwise: remember as the new default, then perform it now.
      try { localStorage.setItem(cfg.actionKey, act); } catch (e) {}
      cfg.launch(act);
    });
  });
}

function _wireManagementAccessButtons(asset) {
  var info = _assetMgmtAccess(asset);
  if (!info) return;
  var httpsBtn = document.getElementById("btn-asset-https");
  if (httpsBtn) {
    httpsBtn.addEventListener("click", function () {
      window.open("https://" + info.mgmtIp, "_blank", "noopener");
    });
  }
  _wireRemoteAccessMenu({
    kind: "ssh",
    actionKey: "polaris-ssh-action",
    action: _sshAction,
    launch: function (act) { _doSshLaunch(info.mgmtIp, act); },
    setUser: function () {
      var v = window.prompt("Default SSH username for ssh:// links and copied commands (leave blank for none):", _sshUser());
      if (v === null) return;
      try { localStorage.setItem("polaris-ssh-user", v.trim()); } catch (e) {}
      showToast(v.trim() ? "SSH user set to " + v.trim() : "SSH user cleared");
    },
  });
  _wireRemoteAccessMenu({
    kind: "rdp",
    actionKey: "polaris-rdp-action",
    action: _rdpAction,
    launch: function (act) { _doRdpLaunch(info.mgmtIp, act); },
    setUser: function () {
      var v = window.prompt("Default RDP username for generated .rdp files and rdp:// links — DOMAIN\\user or user@domain (leave blank for none):", _rdpUser());
      if (v === null) return;
      try { localStorage.setItem("polaris-rdp-user", v.trim()); } catch (e) {}
      showToast(v.trim() ? "RDP user set to " + v.trim() : "RDP user cleared");
    },
  });
  if (!_assetRemoteMenuCloserWired) {
    _assetRemoteMenuCloserWired = true;
    document.addEventListener("click", function () {
      ["asset-ssh-menu", "asset-rdp-menu"].forEach(function (id) {
        var m = document.getElementById(id);
        if (m) m.classList.remove("open");
      });
    });
  }
}

// ─── Upstream devices (Last Seen Switch / AP / Firewall) ─────────────────────
// These three General-tab rows name the device an asset is connected BEHIND.
// They were dead text until 2026-09: an operator who wanted the switch an
// endpoint hangs off had to read the name, go back to the Assets list and find
// it again — and the switch's own Open HTTPS / Open SSH lived two clicks
// further on. Each row now carries the same row menu the Assets list puts
// behind a hostname (polaris-ui-canon → "Row context menu"): Open asset, then the
// device's remote-access verbs from the ONE shared gate `_assetMgmtAccess`, so
// a FortiSwitch offers exactly what its controller's local-access policy
// permits and never a verb that would land on a closed port.
//
// Rendered in two passes on purpose. The value paints as plain text from the
// asset row itself, then GET /assets/:id/upstream upgrades the ones that
// resolved to an asset. A name that resolves to nothing (an unadopted switch, a
// gate another integration hasn't discovered yet, a decommissioned AP) is a
// legitimate state, not an error — it just stays text.

/** A detail row whose VALUE cell is addressable, so the async pass can upgrade
 *  it in place. Same markup as viewRow, minus the copy/mono options none of
 *  the three upstream rows use. */
function _upstreamRowHTML(label, cellId, value) {
  return '<div class="detail-row"><span class="detail-label">' + escapeHtml(label) + '</span>' +
    '<span class="detail-value" id="' + escapeHtml(cellId) + '">' + escapeHtml(value || "-") + '</span></div>';
}

/**
 * The menu behind one upstream row. "Open asset" first (the reason the row is
 * clickable at all), then the resolved device's own remote-access verbs —
 * reused wholesale from `_managementAccessMenuItems`, which reads only
 * assetType / ipAddress / managementAccess and therefore takes the endpoint's
 * stub as happily as a full asset row. Nothing to offer ⇒ no menu, and the
 * caller leaves the row as text.
 */
function _upstreamMenuItems(ref) {
  if (!ref || !ref.id) return [];
  var items = [{
    label: "Open asset",
    primary: true,
    title: "Open this device's details",
    onSelect: function () { openViewModal(ref.id); },
  }];
  var mgmt = _managementAccessMenuItems(ref);
  if (mgmt.length) {
    items.push({ separator: true });
    mgmt.forEach(function (m) { items.push(m); });
  }
  return items;
}

/**
 * Upgrade one already-painted upstream row into a row-menu trigger.
 *
 * The device NAME is the trigger; a switch's port half stays outside it as
 * plain text ("port15" is not a thing you can open), which also keeps the
 * trigger's accessible name the device rather than "SW-01/port15".
 */
function _upgradeUpstreamRow(cellId, entry, kindLabel) {
  var cell = document.getElementById(cellId);
  if (!cell || !entry || !entry.name) return;
  var items = _upstreamMenuItems(entry.asset);
  // Keep the name the server reports even when nothing resolved — for the
  // firewall row that IS the fill (the sightings pass above may not have run
  // for a caller without assetsQuarantine:read).
  // "Last Seen Firewall" can be answered three ways and they are not the same
  // claim: source "controller" is the gate managing a FortiSwitch / FortiAP
  // (direct, current — no note), a sighting is a gate reporting the device,
  // source "subnet" is the gate that owns the network its address is in — an
  // inference used only when no gate Polaris still holds has sighted it. The
  // row says when it is the inference, so it never reads as evidence it isn't.
  var derived = entry.source === "subnet"
    ? " (owns " + (entry.subnetCidr || "this network") + ")"
    : "";
  if (!items.length) {
    cell.textContent = entry.name + (entry.port ? "/" + entry.port : "") + derived;
    return;
  }
  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "row-menu-trigger";
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  // A switch is often STORED as its serial, so the tooltip carries the
  // resolved hostname when it differs — the operator gets to know which switch
  // "S248EPTF9000123" is without the displayed value changing under them.
  var alt = entry.asset && entry.asset.hostname && entry.asset.hostname !== entry.name
    ? " (" + entry.asset.hostname + ")" : "";
  btn.title = "Actions for this " + kindLabel + alt;
  btn.textContent = entry.name;
  btn.addEventListener("click", function () {
    showRowMenu(btn, _upstreamMenuItems(entry.asset), { label: "Actions for " + entry.name });
  });
  cell.textContent = "";
  cell.appendChild(btn);
  if (entry.port) cell.appendChild(document.createTextNode("/" + entry.port));
  if (derived) {
    var note = document.createElement("span");
    note.style.color = "var(--color-text-secondary)";
    note.title = "No FortiGate has reported this device. This is the gate that owns the network its IP address sits in.";
    note.textContent = derived;
    cell.appendChild(note);
  }
}

// Operator-facing labels for Asset.lastSeenSource — the evidence that
// produced the current Last Seen value (stamped by the backend's
// bumpLastSeen). Unknown values render verbatim so new backend sources
// degrade gracefully.
var LAST_SEEN_SOURCE_LABELS = {
  "dhcp-lease":       "DHCP lease",
  "device-inventory": "FortiGate inventory",
  "discovery":        "discovery",
  "agent":            "agent heartbeat",
  "probe":            "monitor probe",
  "ping":             "ping",
  "conflict-accept":  "conflict resolution",
  "conflict-reject":  "conflict resolution",
};

// Build the General-tab "Last Seen" detail row. The date renders as plain
// text; the provenance label ("via DHCP lease" etc.) becomes a link into the
// lease slide-over when the asset's IP resolves to a containing subnet — the
// same gate (and target) the table's "View Lease" row action uses. With no
// resolvable network context the label stays plain text.
function lastSeenRowHTML(a) {
  var valueInner;
  if (!a.lastSeen) {
    valueInner = "-";
  } else {
    valueInner = escapeHtml(formatDate(a.lastSeen));
    if (a.lastSeenSource) {
      var srcLabel = LAST_SEEN_SOURCE_LABELS[a.lastSeenSource] || a.lastSeenSource;
      var ctx = a.ipContext;
      if (ctx && ctx.subnetId) {
        var title = "View this IP in " + (ctx.subnetCidr || "its network");
        valueInner += ' · via <a href="#" class="last-seen-source-link" ' +
          'onclick="viewAssetLease(' + jsArg(a.id) + ');return false;" ' +
          'title="' + escapeHtml(title) + '">' + escapeHtml(srcLabel) + '</a>';
      } else {
        valueInner += " · via " + escapeHtml(srcLabel);
      }
    }
  }
  return '<div class="detail-row"><span class="detail-label">Last Seen</span>' +
    '<span class="detail-value">' + valueInner + '</span></div>';
}

// Render the General-tab VIP / Virtual Server rows from GET /assets/:id/vips —
// one per firewall VIP publishing this device: the EXTERNAL address it answers
// on, the VIP object's name, and the gate the VIP is configured on. Before
// this, the external address of a published server was only discoverable by
// finding its reservation in Networks and reading the badge tooltip.
//
// The gate is rendered by the name the VIP config carries (FortiManager's
// device name) whether or not it resolved to an asset — the same posture the
// upstream rows take, since an unresolved gate is a legitimate state and the
// name is useful without a row. When it DID resolve, the name becomes a link
// to that asset (wired by _wireDependencyTreeLinks, the MCLAG-peer precedent).
//
// The trailing note names the side the ASSET sits on, so the row reads
// correctly whichever address of a multi-homed server matched.
function assetVipRowsHTML(vips) {
  if (!Array.isArray(vips) || vips.length === 0) return "";
  return vips.map(function (v) {
    var label = v.isVirtualServer ? "Virtual Server" : "VIP";
    var extHTML = v.extip
      ? '<span class="copy-cell" style="font-family:var(--font-mono)" title="External address — click to copy" data-copy="' +
        escapeHtml(v.extip) + '">' + escapeHtml(v.extip) + '</span>'
      : '<span style="color:var(--color-text-tertiary)">no external IP</span>';
    var deviceText = escapeHtml(v.device || "-");
    var gateHTML = deviceText;
    if (v.asset && v.asset.id) {
      // The asset's own hostname can differ from FortiManager's device name —
      // show it in the tooltip rather than swapping the displayed value.
      var tip = (v.asset.hostname && v.asset.hostname !== v.device)
        ? ' title="' + escapeHtml(v.asset.hostname) + '"' : '';
      gateHTML = '<a href="#" class="dep-tree-link" data-asset-id="' + escapeHtml(v.asset.id) + '"' + tip + '>' +
        deviceText + '</a>';
    }
    var note = v.role === "external"
      ? "this address is the external side"
      : (v.role === "realserver" ? "pool member " + v.ip : "maps to " + v.ip);
    return '<div class="detail-row"><span class="detail-label">' + label + '</span>' +
      '<span class="detail-value">' + extHTML +
      ' · ' + escapeHtml(v.name || "") + ' on ' + gateHTML +
      ' <span style="color:var(--color-text-tertiary);font-size:0.85em">(' + escapeHtml(note) + ')</span>' +
      '</span></div>';
  }).join("");
}

function viewRow(label, value, mono, alignRight, copy) {
  var style = alignRight ? ' style="text-align:right"' : '';
  var inner = escapeHtml(value || "-");
  if (copy && value) {
    inner = '<span class="copy-cell" title="Click to copy" data-copy="' + escapeHtml(value) + '">' + inner + '</span>';
  }
  return '<div class="detail-row"><span class="detail-label">' + escapeHtml(label) + '</span>' +
    '<span class="detail-value' + (mono ? ' mono' : '') + '"' + style + '>' + inner + '</span></div>';
}

// A failed location lookup on the asset details General tab. The
// fortigate-firewall source's observed.geocodeFailure is rewritten every
// discovery run, so a later hit clears it. The flag sits on the row that holds
// the address that was looked up (SNMP Location for an sysLocation lookup,
// Address for the FortiManager address metavariable): the pin then comes from a
// lower-priority source, often a stale pair the FortiGate still carries, and
// nothing else on the tab says that address is not what placed it. A manual pin
// is exempt, because the lookup never moves it.
var GEOCODE_FAILURE_TEXT = {
  no_match: "lookup failed — address not recognised",
  unreachable: "lookup failed — geocoder unreachable",
  disabled: "lookup off on this server",
};
function geocodeFailureFor(asset, sources) {
  if (!asset || asset.coordSource === "manual") return null;
  var fail = null;
  (sources || []).forEach(function (s) {
    var g = s && s.sourceKind === "fortigate-firewall" && s.observed && s.observed.geocodeFailure;
    if (g && typeof g.query === "string" && GEOCODE_FAILURE_TEXT[g.reason]) fail = g;
  });
  return fail;
}
// The value of the row the failed lookup read: Address for the metavariable,
// SNMP Location otherwise. Empty when that row is not on the tab.
function _geocodeFailureRowValue(asset, fail) {
  return fail.source === "address-metavar" ? asset.learnedAddress : asset.snmpLocation;
}
function geocodeFailureFlagHTML(asset, fail) {
  var has = asset.latitude != null && asset.longitude != null;
  var what = fail.source === "address-metavar" ? "address metavariable" : "SNMP location";
  var tip = "The " + what + " \"" + fail.query + "\" could not be placed on the map, so " +
    (has ? "the coordinates come from the FortiGate's other settings (Latitude/Longitude metavariables or its GUI coordinates)."
         : "this asset has no coordinates.") +
    " The asset's Events tab has the details.";
  return ' <span class="geocode-failure" style="color:var(--color-warning);font-family:var(--font-sans, inherit)" title="' +
    escapeHtml(tip) + '">⚠ ' + escapeHtml(GEOCODE_FAILURE_TEXT[fail.reason]) + '</span>';
}
// Render the SNMP Location or Address row, carrying the failure flag when the
// failed lookup read this row's address.
function geocodedAddressRowHTML(asset, sources, source) {
  var value = source === "address-metavar" ? asset.learnedAddress : asset.snmpLocation;
  if (!value) return "";
  var label = source === "address-metavar" ? "Address" : "SNMP Location";
  var fail = geocodeFailureFor(asset, sources);
  var flag = fail && fail.source === source ? geocodeFailureFlagHTML(asset, fail) : "";
  return '<div class="detail-row"><span class="detail-label">' + label + '</span>' +
    '<span class="detail-value">' + escapeHtml(value) + flag + '</span></div>';
}
// Render the Coordinates row. The failure flag lives on the address row; it
// falls back here only when that row is not on the tab. The row also renders
// with no coordinates at all when a lookup failed, so the failure is not hidden
// by the absence it caused.
function coordinatesRowHTML(asset, sources) {
  var has = asset.latitude != null && asset.longitude != null;
  var manual = asset.coordSource === "manual";
  var fail = geocodeFailureFor(asset, sources);
  if (!has && !fail) return "";
  var value = has
    ? escapeHtml(asset.latitude.toFixed(4) + ", " + asset.longitude.toFixed(4) + (manual ? " (manual)" : ""))
    : "-";
  if (fail && !_geocodeFailureRowValue(asset, fail)) value += geocodeFailureFlagHTML(asset, fail);
  return '<div class="detail-row"><span class="detail-label">Coordinates</span>' +
    '<span class="detail-value mono">' + value + '</span></div>';
}

// Render the Authorization row on the asset details General tab — the
// controller admission state discovery stamps onto fortinetTopology.state
// for managed FortiSwitches ("Authorized" / "Unauthorized") and FortiAPs
// ("authorized" / "discovered" / ...). Distinct from connectivity status:
// a device can be authorized-but-offline or discovered-but-connected.
// Renders nothing for other asset types or when discovery hasn't stamped
// the field (pre-feature discoveries self-heal on the next cycle).
function authorizationRowHTML(asset) {
  if (!asset || (asset.assetType !== "switch" && asset.assetType !== "access_point")) return "";
  var topo = asset.fortinetTopology;
  var state = topo && typeof topo === "object" ? topo.state : null;
  if (!state || typeof state !== "string") return "";
  var lower = state.toLowerCase();
  var label = state.charAt(0).toUpperCase() + state.slice(1);
  var color = lower === "authorized" ? "var(--color-success,#10b981)"
            : lower === "unauthorized" ? "var(--color-danger,#ef4444)"
            : "var(--color-warning,#fbbf24)";
  var badge = '<span class="badge hue-pill" style="--hue:' +
    color + '">' + escapeHtml(label) + '</span>';
  return '<div class="detail-row"><span class="detail-label">Authorization</span><span class="detail-value">' + badge + '</span></div>';
}

// Render the Controller Link row on the asset details General tab — what the
// parent FortiGate says about its OWN session to this managed device
// (business rule 59): the FortiLink session for a FortiSwitch, the CAPWAP
// tunnel for a FortiAP. Swept every 60s by sweepFortinetLinkState, straight
// off Asset.fortilinkStatus.
//
// Deliberately NOT the same thing as the Monitoring pill above it, and the two
// are allowed to disagree loudly. The pill is what Polaris sees on the
// operator's chosen transport; this is what the controller sees. A switch
// reading "Up" on the pill and "Down" here is answering ICMP with a dead
// FortiLink session — the exact fault this row exists to surface, and one the
// monitor loop is structurally unable to find because it is asking the switch.
//
// Renders nothing for other asset types, and nothing on a device the sweep has
// never spoken about (not FortiGate-managed, or a pre-feature row awaiting its
// first tick — those self-heal within a minute).
function fortilinkRowHTML(asset) {
  if (!asset || (asset.assetType !== "switch" && asset.assetType !== "access_point")) return "";
  var state = asset.fortilinkStatus;
  if (state !== "up" && state !== "down" && state !== "unknown") return "";
  // FortiOS calls it FortiLink on a switch and a CAPWAP tunnel on an AP.
  // Naming the row after what the operator sees in FortiOS beats one generic
  // label that matches neither screen.
  var label = asset.assetType === "switch" ? "FortiLink" : "Controller Link";
  var color = state === "up" ? "var(--color-success,#10b981)"
            : state === "down" ? "var(--color-danger,#ef4444)"
            : "var(--color-warning,#fbbf24)";
  var text = state === "up" ? "Up" : state === "down" ? "Down" : "Unknown";
  // "Unknown" means the controller answered and this device was not in its
  // table — worth spelling out, because it reads as a missing reading and is
  // actually a positive statement about the controller's inventory.
  var tip = state === "unknown"
    ? "The controller answered but did not list this device — it has aged out of the managed table."
    : (asset.assetType === "switch"
        ? "The controller FortiGate's view of its FortiLink session to this switch."
        : "The controller FortiGate's view of its CAPWAP tunnel to this AP.");
  if (asset.fortilinkStatusRaw && String(asset.fortilinkStatusRaw).toLowerCase() !== text.toLowerCase()) {
    tip += '\nController reports: "' + asset.fortilinkStatusRaw + '"';
  }
  var badge = '<span class="badge hue-pill" style="--hue:' +
    color + '">' + escapeHtml(text) + '</span>';
  var suffix = "";
  // How long it has been in this state — the first thing asked about a link
  // that is down. changedAt holds still across confirmations, so this is the
  // outage length and not the age of the last sweep.
  if (asset.fortilinkChangedAt) {
    var since = _fortilinkElapsed(asset.fortilinkChangedAt);
    if (since) suffix += ' <span style="color:var(--text-muted);font-size:0.8rem">for ' + escapeHtml(since) + '</span>';
  }
  // A checkedAt that has stopped advancing means the CONTROLLER is unreadable,
  // not that the link changed — the sweep refuses to write in that case. Say
  // so rather than presenting a stale value as current. Threshold is 5x the
  // 60s sweep, loose enough to absorb one slow FMG pass.
  if (asset.fortilinkCheckedAt) {
    var ageMs = Date.now() - new Date(asset.fortilinkCheckedAt).getTime();
    if (ageMs > 5 * 60 * 1000) {
      suffix += ' <span style="color:var(--color-warning,#fbbf24);font-size:0.8rem" title="The sweep has not been able to read this device\'s controller since then, so this value is the last one it reported.">· last confirmed ' +
        escapeHtml(formatDateTime(asset.fortilinkCheckedAt)) + '</span>';
    }
  }
  return '<div class="detail-row"><span class="detail-label" title="' + escapeHtml(tip) + '">' + escapeHtml(label) +
    '</span><span class="detail-value">' + badge + suffix + '</span></div>';
}

// Coarse "2h 13m" elapsed label. Deliberately coarse: the sweep resolves to
// 60s, so rendering seconds would promise a precision the data does not have.
function _fortilinkElapsed(iso) {
  var then = new Date(iso).getTime();
  if (isNaN(then)) return "";
  var sec = Math.floor((Date.now() - then) / 1000);
  if (sec < 60) return "under a minute";
  var min = Math.floor(sec / 60);
  if (min < 60) return min + "m";
  var hr = Math.floor(min / 60);
  if (hr < 24) return hr + "h " + (min % 60) + "m";
  var day = Math.floor(hr / 24);
  return day + "d " + (hr % 24) + "h";
}

// Render the AP Profile row on the asset details General tab — the FortiOS
// wtp-profile the controller has this AP bound to, stamped onto
// fortinetTopology.profile by FMG/FortiGate discovery. That object decides the
// AP's radios, SSIDs and power, so it's the first thing to check when one AP
// in a site behaves unlike its neighbours. Renders nothing for other asset
// types or before a discovery cycle has stamped it (pre-feature discoveries
// self-heal on the next run).
function apProfileRowHTML(asset) {
  if (!asset || asset.assetType !== "access_point") return "";
  var topo = asset.fortinetTopology;
  var profile = topo && typeof topo === "object" ? topo.profile : null;
  if (!profile || typeof profile !== "string") return "";
  return viewRow("AP Profile", profile);
}

// Render HA cluster topology on the asset details General tab. Three rows
// (Mode / Role / Peer) appear only when the asset is a Fortinet firewall
// whose `fortinetTopology` carries HA fields. Standalone gates render
// nothing. The peer is shown as a clickable serial — clicking pivots the
// asset details modal to the peer Asset (matched by serialNumber) via the
// same window.openAssetById helper the topology graph and dependency tree
// use.
function haTopologyHTML(asset) {
  var topo = asset && asset.fortinetTopology;
  if (!topo || typeof topo !== "object") return "";
  var mode = topo.haMode;
  var role = topo.haRole;
  var peerSerial = topo.haPeerSerial;
  if (!mode || mode === "standalone" || !role) return "";
  var modeLabel = mode === "a-p" ? "Active / Passive (a-p)"
                : mode === "a-a" ? "Active / Active (a-a)"
                : mode;
  var roleLabel = role === "primary" ? "Primary (active)"
                : role === "secondary" ? "Secondary (standby)"
                : role;
  var roleColor = role === "primary" ? "var(--color-success,#10b981)" : "var(--color-warning,#fbbf24)";
  var roleBadge = '<span class="badge hue-pill" style="--hue:' +
    roleColor + '">' + escapeHtml(roleLabel) + '</span>';
  var peerHTML = '-';
  if (peerSerial) {
    var serialEsc = escapeHtml(peerSerial);
    // The serial is device-reported. In the handler it goes through jsArg, not
    // escapeHtml: the entity for ' is decoded before the handler compiles.
    peerHTML = '<a href="#" onclick="event.preventDefault(); window.openAssetBySerial && window.openAssetBySerial(' +
      jsArg(peerSerial) + '); return false" class="mono" title="Open peer asset">' + serialEsc + '</a>';
  }
  // Roster-reported member health (fortinetTopology.haMemberStatus, stamped
  // each discovery cycle from FMG ha_slave[].status / FortiOS ha-peer
  // presence). Rendered only when discovery captured a signal — the standby's
  // only live health source, since probes route to the active member.
  var healthHTML = '';
  var memberStatus = topo.haMemberStatus;
  if (memberStatus === "up" || memberStatus === "down") {
    var healthColor = memberStatus === "up" ? "var(--color-success,#10b981)" : "var(--color-danger,#ef4444)";
    var healthLabel = memberStatus === "up" ? "In cluster (up)" : "Reported down";
    var healthBadge = '<span class="badge hue-pill" style="--hue:' +
      healthColor + '" title="From the cluster\'s HA roster, read each discovery cycle">' +
      healthLabel + '</span>';
    healthHTML = '<div class="detail-row"><span class="detail-label">HA Member Health</span><span class="detail-value">' + healthBadge + '</span></div>';
  }
  // Display-only cluster IP on the standby (Asset.ipAddress stays null there
  // by design — the IP routes to the active member).
  var clusterIpHTML = '';
  if (role === "secondary" && topo.haClusterIp && typeof topo.haClusterIp === "string") {
    clusterIpHTML = '<div class="detail-row"><span class="detail-label">Cluster IP</span><span class="detail-value mono">' +
      '<span class="copy-cell" title="Routes to the active (primary) member. Click to copy" data-copy="' +
      escapeHtml(topo.haClusterIp) + '">' + escapeHtml(topo.haClusterIp) + '</span>' +
      ' <span style="color:var(--color-text-secondary);font-size:0.8em">(routes to active member)</span></span></div>';
  }
  return '<div class="detail-row"><span class="detail-label">HA Mode</span><span class="detail-value">' +
    escapeHtml(modeLabel) + '</span></div>' +
    '<div class="detail-row"><span class="detail-label">HA Role</span><span class="detail-value">' + roleBadge + '</span></div>' +
    healthHTML +
    clusterIpHTML +
    '<div class="detail-row"><span class="detail-label">HA Peer</span><span class="detail-value mono">' + peerHTML + '</span></div>';
}

// The former "Disabled In" detail row was removed: a directory-disabled
// account now lands the asset in status="decommissioned" (see the Entra/AD
// syncs in discoveryEngine.ts), so the Status pill already tells the story.
// The `ad-disabled` / `entra-disabled` tags are still written and remain
// filterable on the Assets table for anyone who needs the source breakdown.

function formatMacSource(source) {
  switch (source) {
    case "intune-ethernet": return "Intune — Ethernet";
    case "intune-wifi":     return "Intune — Wi-Fi";
    case "dhcp_reservation":return "DHCP reservation";
    case "dhcp_lease":      return "DHCP lease";
    case "device-inventory":return "Device inventory";
    case "fmg-discovery":   return "FortiManager discovery";
    case "monitor-interface":return "Interface scrape";
    default: return source || "";
  }
}

// An interface-scrape entry may be a contiguous RANGE of MACs (macEnd set —
// e.g. a switch's 48 sequential port MACs folded to one row) rather than a
// single address.
function macEntryText(m) {
  return m.macEnd ? (m.mac + ' – ' + m.macEnd) : m.mac;
}
function macEntryCount(m) {
  if (!m.macEnd) return 1;
  var s = parseInt(String(m.mac).replace(/:/g, ''), 16);
  var e = parseInt(String(m.macEnd).replace(/:/g, ''), 16);
  return (isFinite(s) && isFinite(e) && e >= s) ? (e - s + 1) : 1;
}
function macEntriesTotal(macAddresses) {
  var total = 0;
  for (var i = 0; i < macAddresses.length; i++) total += macEntryCount(macAddresses[i]);
  return total;
}

// Render one "remove this MAC" button, or '' when the viewer can't. Shared by
// the visible rows and the "+N" overflow tooltips so a MAC is no less
// removable for having sorted past the fold. The click is caught by the
// document-level _handleMacDeleteClick, so nothing here needs wiring.
function macDeleteButtonHTML(assetId, m) {
  if (!assetId || !canManageAssets()) return '';
  return '<button type="button" class="mac-tooltip-delete" title="Remove this MAC from the asset" data-asset-id="' +
    escapeHtml(assetId) + '" data-mac="' + escapeHtml(m.mac) + '"' +
    (m.macEnd ? ' data-mac-end="' + escapeHtml(m.macEnd) + '"' : '') +
    '>&times;</button>';
}

// Who reported a user sighting (business rule 186). An unknown source shows
// as stored, so an older row's label still reads.
var _USER_SOURCE_LABELS = {
  "intune": "Intune",
  "fortigate-auth": "FortiGate authentication",
  "device-inventory": "FortiGate device inventory",
};

function _associatedUserLineHTML(u) {
  var display = u.domain ? escapeHtml(u.domain) + '\\' + escapeHtml(u.user) : escapeHtml(u.user);
  var source = u.source ? (_USER_SOURCE_LABELS[u.source] || u.source) : '';
  return '<div style="display:flex;gap:12px;align-items:center;padding:3px 0">' +
    '<span style="font-size:0.85rem">' + display + '</span>' +
    '<span style="font-size:0.75rem;color:var(--color-text-tertiary)">' +
      escapeHtml(source) +
      (u.lastSeen ? (source ? ' &middot; ' : '') + formatDate(u.lastSeen) : '') +
    '</span>' +
  '</div>';
}

function _userSeenMs(u) {
  var t = u && u.lastSeen ? Date.parse(u.lastSeen) : NaN;
  return isFinite(t) ? t : 0;
}

// The last logged-on user is the NEWEST sighting from any source (business
// rule 186) — Intune's last logon, a FortiGate auth session, or the gate's
// device inventory — so the row reads the same whichever integration saw it.
function associatedUsersViewHTML(users) {
  if (!users || users.length === 0) return '';
  var sorted = users.filter(function (u) { return u && u.user; }).slice().sort(function (a, b) { return _userSeenMs(b) - _userSeenMs(a); });
  if (sorted.length === 0) return '';
  return '<div class="detail-row"><span class="detail-label">Last Logged-On User</span>' +
      '<span class="detail-value">' + _associatedUserLineHTML(sorted[0]) + '</span></div>' +
    '<div class="detail-row"><span class="detail-label">Associated Users (' + sorted.length + ')</span>' +
      '<span class="detail-value">' + sorted.map(_associatedUserLineHTML).join("") + '</span></div>';
}

// ─── Deleting an asset that has the Polaris Agent (business rule 163) ────────
// The agent's record goes with the asset, and with it the token, the Agent
// card and its Uninstall button — but nothing on the host changes: the agent
// keeps running there, refused by Polaris, with no way left to remove it from
// here. So every delete path asks first. If any of the assets has an agent the
// operator is told, offered an uninstall attempt, and — when an uninstall
// fails — told why and asked whether to delete anyway. One function, three
// callers (the row menu, the edit modal, the bulk delete), so the three cannot
// drift.

/** How often the uninstall is polled, and how long before it counts as failed. */
var _AGENT_UNINSTALL_POLL_MS = 3000;
var _AGENT_UNINSTALL_TIMEOUT_MS = 180000;
/** Uninstalls started at once on a bulk delete. */
var _AGENT_UNINSTALL_CONCURRENCY = 4;

function _agentHostCount(n) { return n + " " + (n === 1 ? "device" : "devices"); }

/**
 * Start the uninstall on one host and wait for it to finish. Resolves
 * `{ ok: true }` when the agent record is gone, else `{ ok: false, reason }`.
 * Never rejects: a refused request is a failed uninstall, with its message.
 */
async function _uninstallAgentAndWait(assetId) {
  try {
    await api.assets.deleteAgent(assetId, { force: false });
  } catch (err) {
    return { ok: false, reason: (err && err.message) || "The uninstall could not be started" };
  }
  var deadline = Date.now() + _AGENT_UNINSTALL_TIMEOUT_MS;
  for (;;) {
    var card = null;
    try { card = await api.assets.agent(assetId); } catch (_err) { card = undefined; }
    if (card === null) return { ok: true };
    if (card && card.installStatus === "uninstall_failed") {
      return { ok: false, reason: card.installError || "The uninstall failed on the host" };
    }
    if (Date.now() >= deadline) {
      return { ok: false, reason: "The uninstall did not finish in " + Math.round(_AGENT_UNINSTALL_TIMEOUT_MS / 60000) + " minutes" };
    }
    await new Promise(function (r) { setTimeout(r, _AGENT_UNINSTALL_POLL_MS); });
  }
}

/** Uninstall on every host, a few at a time; `onProgress(done, total)`. */
async function _uninstallAgentsOn(hosts, onProgress) {
  var results = new Array(hosts.length);
  var next = 0, done = 0;
  async function worker() {
    while (next < hosts.length) {
      var i = next++;
      results[i] = await _uninstallAgentAndWait(hosts[i].assetId);
      done++;
      if (onProgress) onProgress(done, hosts.length);
    }
  }
  var workers = [];
  for (var w = 0; w < Math.min(_AGENT_UNINSTALL_CONCURRENCY, hosts.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/**
 * Confirm a delete of `ids`. Resolves the ids to delete — all of them, or only
 * the ones whose agent was removed when the operator chose that — or `null`
 * when it was cancelled. With no agent among them it is the plain confirm the
 * delete always had (`plainMessage`).
 */
async function confirmAssetDeletion(ids, plainMessage) {
  var hosts = [];
  try { hosts = ((await api.assets.agentHosts(ids)) || {}).hosts || []; } catch (_err) { /* the check is a courtesy */ }
  if (!hosts.length) return (await showConfirm(plainMessage)) ? ids : null;

  var total = ids.length;
  var one = total === 1;
  return new Promise(function (resolve) {
    var settled = false;
    var layer = null;
    // Closing a layer fires its onClose (the X, Escape, an off-click all mean
    // "cancel"). `swapping` is set while WE close one — to move to the next
    // stage, or because the answer is already in — so that is not a cancel.
    var swapping = false;
    function closeLayer(l) { swapping = true; try { l.close(); } finally { swapping = false; } }
    function finish(value) {
      if (settled) return;
      settled = true;
      if (layer) closeLayer(layer);
      resolve(value);
    }
    function show(title, body, footer, wire) {
      var prev = layer;
      layer = buildOverlay(1300, title, body, footer, function () { if (!swapping) finish(null); });
      if (prev) closeLayer(prev);
      wire(layer.overlay);
    }
    var names = hosts.slice(0, 8).map(function (h) { return "<li>" + escapeHtml(h.name) + "</li>"; }).join("") +
      (hosts.length > 8 ? "<li>… and " + (hosts.length - 8) + " more</li>" : "");
    var mayUninstall = typeof canDeployAgent === "function" && canDeployAgent();

    // ── 1. The warning ──
    show(one ? "Delete asset" : "Delete " + total + " assets",
      '<p style="margin:0 0 0.6rem"><strong>' + (one
        ? escapeHtml(hosts[0].name) + " has the Polaris Agent installed."
        : _agentHostCount(hosts.length) + " of these " + total + " have the Polaris Agent installed.") + "</strong></p>" +
      (one ? "" : '<ul style="margin:0 0 0.6rem;padding-left:1.1rem;font-size:0.85rem">' + names + "</ul>") +
      '<p style="margin:0;font-size:0.85rem;color:var(--color-text-secondary);line-height:1.5">Deleting the record does not remove the agent. It keeps running on the host, ' +
        "Polaris stops accepting it, and the Uninstall button goes with the record — so it can only be removed on the host itself. " +
        "Uninstall it first, and the delete follows when the agent is gone." +
        (mayUninstall ? "" : " <strong>Uninstalling needs the Agent Deploy permission, which you do not have.</strong>") + "</p>",
      '<button class="btn btn-secondary" data-act="cancel">Cancel</button>' +
      '<button class="btn btn-danger" data-act="anyway">Delete anyway</button>' +
      '<button class="btn btn-primary" data-act="uninstall"' + (mayUninstall ? "" : " disabled") + ">Uninstall, then delete</button>",
      function (el) {
        el.querySelector('[data-act="cancel"]').addEventListener("click", function () { finish(null); });
        el.querySelector('[data-act="anyway"]').addEventListener("click", function () { finish(ids); });
        el.querySelector('[data-act="uninstall"]').addEventListener("click", runUninstall);
      });

    // ── 2. The attempt ──
    async function runUninstall() {
      show("Uninstalling the Polaris Agent",
        '<p style="margin:0" id="adel-progress">Uninstalling on ' + _agentHostCount(hosts.length) + "…</p>" +
        '<p class="hint" style="margin:0.5rem 0 0">This can take a minute or two per host. Nothing is deleted until it finishes.</p>',
        '<button class="btn btn-secondary" data-act="cancel">Cancel</button>',
        function (el) { el.querySelector('[data-act="cancel"]').addEventListener("click", function () { finish(null); }); });
      var results = await _uninstallAgentsOn(hosts, function (done, n) {
        var p = document.getElementById("adel-progress");
        if (p) p.textContent = "Uninstalling… " + done + " of " + n + " finished";
      });
      if (settled) return; // cancelled while waiting; the uninstalls carry on
      var failed = hosts.map(function (h, i) { return { host: h, reason: results[i].reason }; }).filter(function (_f, i) { return !results[i].ok; });
      if (!failed.length) { finish(ids); return; }
      showFailures(failed);
    }

    // ── 3. What failed, and the question ──
    function showFailures(failed) {
      var failedIds = {};
      failed.forEach(function (f) { failedIds[f.host.assetId] = true; });
      var others = ids.filter(function (id) { return !failedIds[id]; });
      var rows = failed.slice(0, 12).map(function (f) {
        return "<li><strong>" + escapeHtml(f.host.name) + "</strong> — " + escapeHtml(f.reason) + "</li>";
      }).join("") + (failed.length > 12 ? "<li>… and " + (failed.length - 12) + " more</li>" : "");
      show("The agent could not be uninstalled",
        '<p style="margin:0 0 0.6rem">' + (failed.length === 1 && one
          ? "The Polaris Agent could not be removed from <strong>" + escapeHtml(failed[0].host.name) + "</strong>."
          : "The Polaris Agent could not be removed from " + _agentHostCount(failed.length) + ".") + "</p>" +
        '<ul style="margin:0 0 0.6rem;padding-left:1.1rem;font-size:0.85rem;line-height:1.5">' + rows + "</ul>" +
        '<p style="margin:0;font-size:0.85rem;color:var(--color-text-secondary);line-height:1.5">' +
          "Nothing has been deleted. If you delete " + (failed.length === 1 ? "this record" : "these records") +
          " anyway, the agent stays on the host and has to be removed there; Polaris writes an Event naming each one.</p>",
        '<button class="btn btn-secondary" data-act="cancel">Cancel</button>' +
        (others.length && !one ? '<button class="btn btn-secondary" data-act="others">Delete the other ' + others.length + " only</button>" : "") +
        '<button class="btn btn-danger" data-act="anyway">Delete anyway</button>',
        function (el) {
          el.querySelector('[data-act="cancel"]').addEventListener("click", function () { finish(null); });
          el.querySelector('[data-act="anyway"]').addEventListener("click", function () { finish(ids); });
          var o = el.querySelector('[data-act="others"]');
          if (o) o.addEventListener("click", function () { finish(others); });
        });
    }
  });
}

async function confirmDelete(id, name) {
  var go = await confirmAssetDeletion([id], 'Delete asset "' + name + '"? This cannot be undone.');
  if (!go || !go.length) return;
  try {
    await api.assets.delete(id);
    showToast("Asset deleted");
    loadAssets();
  } catch (err) {
    showToast(err.message, "error");
  }
}

/**
 * The YYYY-MM-DD an <input type="date"> wants.
 *
 * Reads back in UTC, and MUST keep doing so — this is the only formatter in
 * the app that deliberately ignores the display-timezone preference. acquiredAt
 * and warrantyExpiry are date-ONLY facts stored in a DateTime column: the save
 * path above writes `new Date("2026-01-15").toISOString()`, i.e. UTC midnight,
 * so UTC is the zone the stored instant actually means. Rendering it in a zone
 * behind UTC would show 2026-01-14, and saving the untouched form would then
 * walk the date one day earlier on every edit.
 *
 * The pairing is what matters: change this only together with the write half.
 */
function dateInputVal(isoStr) {
  if (!isoStr) return "";
  return new Date(isoStr).toISOString().split("T")[0];
}

// ─── Asset slide-over tab order ────────────────────────────────────────────
//
// The order the asset slide-over's tab strip reads in. The operator's list
// (2026-11-04) is General, System, SD-WAN, IPsec, ARP Table, MAC Table,
// Wireless, Events, Alerts, Sources; the conditional tabs it does not name
// sit between the neighbours they belong with. A FortiGate's MAC Table and
// Wireless (childmactable / childwireless) are the same tabs drawn from its
// switches and APs, so they share their own-device siblings' slots.
var _ASSET_VIEW_TAB_ORDER = [
  "general", "system", "workloads",
  "sdwan", "ipsec",
  "arptable", "mactable", "childmactable", "fibrechannel",
  "stations", "childwireless",
  "pathCheck", "services", "software", "quarantine",
  "events", "notifications",
  "customMib", "devicequery",
  "sources",
];

function _orderAssetViewTabs(tabs) {
  var unknownRank = _ASSET_VIEW_TAB_ORDER.indexOf("sources") - 0.5;
  function rank(t) {
    var i = _ASSET_VIEW_TAB_ORDER.indexOf(t.key);
    return i === -1 ? unknownRank : i;
  }
  // Array.prototype.sort is stable, so two unknown keys keep push order.
  return tabs.slice().sort(function (x, y) { return rank(x) - rank(y); });
}
