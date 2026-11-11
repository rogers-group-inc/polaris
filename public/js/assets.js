/**
 * public/js/assets.js — Asset management page
 */

var _assetsPageSize = 15;
var _assetsPage = 1;
// _assetsData holds ONLY the current page of rows (server-side pagination).
// The assets page runs TableSF in server-side mode — filter/sort/page state is
// translated into API params by _buildAssetsQuery() and only one page is
// fetched, mirroring the Events page. _assetsTotal is the server's full
// matching count, used to render the pagination controls.
var _assetsData = [];
var _assetsTotal = 0;
var _assetsSF = null;
var _assetsLayout = null;
var _assetsSelected = new Set();

// Business rule 141 (e): the per-device verbs read the server's per-row
// verdict (`canEdit` / `canQuarantine`) through app.js's canEditAsset /
// canQuarantineAsset. The shims fall back to the role-level helpers when
// app.js is not loaded (the DOM test harnesses eval this file alone), the
// same `typeof … === "function"` posture the rest of the file takes.
function _canEditAsset(a) {
  if (typeof canEditAsset === "function") return canEditAsset(a);
  return typeof canManageAssets === "function" && canManageAssets();
}
function _canQuarantineAsset(a) {
  if (typeof canQuarantineAsset === "function") return canQuarantineAsset(a);
  return typeof canQuarantineAssets === "function" && canQuarantineAssets();
}
function _canMaintainAsset(a) {
  if (typeof canMaintainAsset === "function") return canMaintainAsset(a);
  return typeof canManageMaintenance === "function" && canManageMaintenance();
}
// Selection can span pages, but _assetsData only holds the current page, so we
// remember a little metadata (status, assetType) for every selected asset to
// drive the bulk-bar button visibility even after the operator pages away.
var _assetsSelectedMeta = {};

// Monitor-state palette — green=up, red=down, orange=warning/partial. Shared by
// every chart/legend/status-dot builder that renders a monitor or SD-WAN
// up/down/partial state on this page. These are deliberately distinct from the
// CSS --color-* theme variables (which differ per light/dark and per semantic
// context); do NOT remap onto var(--color-*). Extracting these into one place
// only deduplicates the literals — the rendered values are unchanged.
var MONITOR_STATE_COLORS = { up: "#2a9d8f", down: "#d32f2f", warning: "#f4a261" };

function _saveAssetsPrefs() {
  PolarisPrefs.save("assets", currentUsername, Object.assign(
    { pageSize: _assetsPageSize, layout: _assetsLayout ? _assetsLayout.getPrefs() : null },
    _assetsSF ? _assetsSF.getPrefs() : {},
  ));
}

function _restoreAssetsPrefs() {
  var p = PolarisPrefs.load("assets", currentUsername);
  if (!p) return;
  if (p.pageSize) {
    _assetsPageSize = p.pageSize;
    var psSel = document.getElementById("filter-pagesize");
    if (psSel) psSel.value = String(p.pageSize);
  }
  if (_assetsSF) _assetsSF.setPrefs(p);
  if (_assetsLayout && p.layout) _assetsLayout.setPrefs(p.layout);
}

// Per-asset-type table-layout key for asset-detail tables (Interfaces, Storage,
// Hardware Sensors, LLDP, Wireless Stations, SD-WAN). These tables differ in
// shape by device class — a FortiGate's interface list looks nothing like a
// switch's, a firewall's sensor set differs from an AP's — so operators want
// column widths/visibility persisted independently per class, not one shared
// view. applyTableLayout() already namespaces by username; this adds the
// asset-type dimension to the typeKey. `assetType` is the registry string;
// null/empty falls back to "other". The Events tab deliberately opts OUT (its
// columns are type-invariant) and keeps a single shared "asset-events" key.
function _assetTableTypeKey(base, asset) {
  return base + "-" + ((asset && asset.assetType) || "other");
}

// Per-chart-type "last selected range" persistence (per-user via localStorage,
// matching the polaris-prefs-<scope>-<username> convention used elsewhere).
// One JSON map per user keyed by chart id (e.g. "assetMonitor", "assetSystem")
// so adding a new chart never collides with existing prefs blobs. "custom"
// ranges are intentionally not persisted — the from/to inputs reset on reopen,
// so restoring "custom" would land on an empty panel.
function _getChartRangePref(key, fallback) {
  if (!currentUsername) return fallback;
  try {
    var raw = localStorage.getItem("polaris-prefs-charts-" + currentUsername);
    var p = raw ? JSON.parse(raw) : null;
    var v = p && p[key];
    return v || fallback;
  } catch (_) { return fallback; }
}
function _setChartRangePref(key, range) {
  if (!currentUsername || !range || range === "custom") return;
  try {
    var raw = localStorage.getItem("polaris-prefs-charts-" + currentUsername);
    var p = raw ? (JSON.parse(raw) || {}) : {};
    p[key] = range;
    localStorage.setItem("polaris-prefs-charts-" + currentUsername, JSON.stringify(p));
  } catch (_) {}
}

document.addEventListener("DOMContentLoaded", async function () {
  // Guard: this file is also loaded on map.html so the Device Map can reuse
  // the canonical asset details slide-in. The page-init below assumes the
  // Assets-page DOM (assets-tbody, btn-add-asset, etc.); skip it elsewhere.
  // openViewModal() + _ensureAssetPanelDOM() and friends are page-agnostic
  // (they append to document.body) so the panel still works without this
  // init having run.
  if (!document.getElementById("assets-tbody")) return;
  // Server-side mode: never call sf.apply(). Any filter/sort change resets to
  // page 1 and re-fetches with the new state translated into API params.
  _assetsSF = new TableSF("assets-tbody", assetsApplyFilterState);
  // Tags is a finite set, so its filter is a pick menu of every tag in use
  // (data-sf-filter="pick"). Fetched on first open, refreshed when stale.
  _assetsSF.setColumnSuggestions("tags", async function () {
    var r = await api.assets.tags();
    return (r && r.tags) || [];
  });
  // ...shown as the same grouped colour-chip picker the asset edit form uses,
  // in a dialog, instead of TableSF's checkbox list.
  _assetsSF.setPickOpener("tags", openAssetTagFilterModal);
  var assetsTable = document.querySelector("#assets-tbody").closest("table");
  // Widths + hidden columns persist per browser in the prefs blob; the column
  // ORDER additionally rides the active view tab (assets-tabs.js), so the
  // arrangement follows the view rather than the screen.
  _assetsLayout = setupColumnLayout(assetsTable, {
    onChange: function () {
      _saveAssetsPrefs();
      if (window.PolarisAssetTabs) window.PolarisAssetTabs.syncColumnsFromTable();
    },
  });
  // Frozen header + pagination: the wrapper carries .table-wrapper-sticky and
  // is viewport-bounded by the shared sizeStickyTableWrappers() in app.js
  // (hooked into renderPageControls / clearPageControls + window resize).
  // (The MAC-remove click handler is wired at load, below
  // _handleMacDeleteClick — not here, because this init never runs when the
  // asset panel opens on another page through global search.)
  document.getElementById("assets-bulk-delete-btn").addEventListener("click", bulkDeleteAssets);
  var bEdit = document.getElementById("assets-bulk-edit-btn");
  if (bEdit) bEdit.addEventListener("click", bulkEditSelectedAsset);
  var bCompare = document.getElementById("assets-bulk-compare-btn");
  if (bCompare) bCompare.addEventListener("click", openCompareModal);
  var bMerge = document.getElementById("assets-bulk-merge-btn");
  if (bMerge) bMerge.addEventListener("click", bulkMergeSelectedAssets);
  var bAgent = document.getElementById("assets-bulk-agent-btn");
  if (bAgent) bAgent.addEventListener("click", openBulkAgentDeployModal);
  var bMaint = document.getElementById("assets-bulk-maint-btn");
  if (bMaint) bMaint.addEventListener("click", bulkMaintenanceSelectedAssets);
  var bTags = document.getElementById("assets-bulk-tags-btn");
  if (bTags) bTags.addEventListener("click", openBulkTagsModal);
  _wireBulkBarDropdowns();
  var bQuarantine   = document.getElementById("assets-bulk-quarantine-btn");
  var bUnquarantine = document.getElementById("assets-bulk-unquarantine-btn");
  if (bQuarantine)   bQuarantine.addEventListener("click", bulkQuarantineAssets);
  if (bUnquarantine) bUnquarantine.addEventListener("click", bulkUnquarantineAssets);
  var bDeselect = document.getElementById("assets-bulk-deselect-btn");
  if (bDeselect) bDeselect.addEventListener("click", function () {
    _assetsSelected.clear();
    _assetsSelectedMeta = {};
    document.querySelectorAll("#assets-tbody input.row-cb").forEach(function (cb) { cb.checked = false; });
    _assetsUpdateSelectAll();
    _assetsUpdateBulkBar();
  });
  // The merged "Settings" modal (Asset Lifecycle + Manual Monitoring +
  // Class Overrides) — the standalone Asset Settings modal was folded in.
  var monsetBtn = document.getElementById("btn-monitoring-settings");
  if (monsetBtn) monsetBtn.addEventListener("click", openMonitoringSettingsModal);
  // Warm the server-clock skew once per page load. The status-pill maintenance
  // popover paints synchronously and prefills an "until" time the SERVER reads
  // in its own zone, so the value has to be in server time before the operator
  // sees it — an unwarmed cache falls back to the browser clock, which on a
  // UTC-clocked host produces a window that is already over.
  if (typeof window.maintLoadServerClock === "function") {
    window.maintLoadServerClock().catch(function () { /* best-effort */ });
  }
  // Maintenance modal lives in assets-maintenance.js (loaded after this file).
  var maintBtn = document.getElementById("btn-maintenance");
  if (maintBtn) maintBtn.addEventListener("click", function () {
    if (typeof openMaintenanceModal === "function") openMaintenanceModal();
  });
  // Kicked off before the userReady await so the registry fetch overlaps it,
  // and awaited before the prefs/hash restore so a saved or deep-linked custom
  // type has its checkbox to land on (setColumnOptions drops filter values with
  // no matching option, and the hash guard tests ASSET_TYPE_LABELS).
  var assetTypesReady = _loadAssetTypeOptions();
  await userReady;
  await assetTypesReady;
  _restoreAssetsPrefs();
  _applyAssetsHashFilters();
  // View tabs own the filter/sort state once they exist, so the active tab is
  // applied BEFORE the first fetch — awaited so the page loads once, not once
  // per state source. A deep-link hash filter (#type=firewall) wins over the
  // tab's stored filters for this load and is folded into the active tab, which
  // is the pre-tabs behavior (the link used to overwrite the saved prefs blob).
  if (window.PolarisAssetTabs) {
    await window.PolarisAssetTabs.init({ hashSeeded: _assetsHashFiltersApplied });
  }
  loadAssets();
  document.getElementById("assets-select-all").addEventListener("change", function () {
    var cbs = document.querySelectorAll("#assets-tbody input.row-cb");
    var chk = this.checked;
    cbs.forEach(function (cb) {
      cb.checked = chk;
      var id = cb.getAttribute("data-id");
      if (chk) { _assetsSelected.add(id); _assetsRememberSelection(id); }
      else { _assetsSelected.delete(id); delete _assetsSelectedMeta[id]; }
    });
    syncSelectedRows(document.getElementById("assets-tbody"));
    _assetsUpdateBulkBar();
  });
  // A plain click or drag replaces the selection (app.js → row selection). The
  // rows on this page are cleared through their own change events; this drops
  // the picks made on other pages, which have no row to clear.
  document.getElementById("assets-tbody").addEventListener("polaris:rowselect-clear", function () {
    var onPage = {};
    _assetsData.forEach(function (a) { onPage[a.id] = true; });
    Array.from(_assetsSelected).forEach(function (id) {
      if (!onPage[id]) { _assetsSelected.delete(id); delete _assetsSelectedMeta[id]; }
    });
    _assetsUpdateBulkBar();
  });
  document.getElementById("assets-tbody").addEventListener("change", function (e) {
    var cb = e.target;
    if (!cb.classList.contains("row-cb")) return;
    var id = cb.getAttribute("data-id");
    if (cb.checked) { _assetsSelected.add(id); _assetsRememberSelection(id); }
    else { _assetsSelected.delete(id); delete _assetsSelectedMeta[id]; }
    _assetsUpdateSelectAll();
    _assetsUpdateBulkBar();
  });
  // The row's verbs live behind the hostname (polaris-ui-canon → "Row context
  // menu"). Built from the row RECORD in _assetsData, not the trigger's
  // data-* attributes, because the quarantine verbs depend on the asset's MAC,
  // status and type. A right click anywhere on the row lands here too (the
  // <tr> carries data-row-menu-row); on a row that is part of a multi-row
  // selection it offers the bulk bar's verbs instead, for the whole selection.
  document.getElementById("assets-tbody").addEventListener("click", function (e) {
    var trigger = e.target.closest(".asset-menu");
    if (!trigger) return;
    e.preventDefault();
    var id = trigger.getAttribute("data-asset-id");
    var gesture = typeof rowMenuGesture === "function" ? rowMenuGesture() : null;
    var bar = document.getElementById("assets-bulk-bar");
    if (gesture && _assetsSelected.size > 1 && _assetsSelected.has(id)) {
      var bulkItems = _assetsBulkMenuItems(bar, trigger, gesture, false);
      if (bulkItems.length) {
        showRowMenu(trigger, bulkItems, { label: "Actions for " + _assetsSelected.size + " selected assets" });
        return;
      }
    }
    var a = (_assetsData || []).find(function (x) { return String(x.id) === id; });
    if (!a) return;
    // The selection verbs join a single row's menu only on a right click, which
    // has just made this row the selection (_rowSelectForMenu in app.js) — the
    // bar's handlers act on the selection. A left click runs Open regardless.
    var extra = gesture && _assetsSelected.size === 1 && _assetsSelected.has(id)
      ? _assetsBulkMenuItems(bar, trigger, gesture, true) : [];
    showRowMenu(trigger, _assetMenuItems(a, extra), { label: "Actions for " + (a.hostname || "asset") });
  });
  // Favorites-first ordering is resolved server-side, so toggling a star must
  // re-fetch to re-order the page.
  wireFavoriteClicks("assets-tbody", function () { fetchAssetsPage(); });

  // "+ Add Asset(s)" is a menu, not a single action — the two things behind it
  // (an asset form, a network Discovery) are governed by DIFFERENT function
  // keys, which is also why the button carries data-perm-any rather than
  // data-manage-assets. Items come from the pure _addAssetMenuItems() so the
  // per-row gating is unit-testable.
  var addBtn = document.getElementById("btn-add-asset");
  if (addBtn) addBtn.addEventListener("click", function () {
    var items = _addAssetMenuItems();
    // Belt-and-braces: the button is already hidden when nothing is
    // reachable, but a cached-then-refreshed role can only ever HIDE (see
    // hideAdminOnlyElements), so never pop an empty menu.
    if (!items.length) return;
    showRowMenu(addBtn, items, { label: "Add asset menu", align: "end" });
  });
  // ── Import items (the Import icon's menu) ──
  // The menus' toggle / outside-close / stopPropagation wiring lives with
  // the export items (module-level IIFE below); this block only wires the
  // two import entries to their hidden file inputs.
  (function () {
    var menu = document.getElementById("import-menu");
    var csvBtn   = document.getElementById("btn-import-csv");
    var csvInput = document.getElementById("import-csv-input");
    var pdfBtn   = document.getElementById("btn-import-pdf");
    var pdfInput = document.getElementById("import-pdf-input");
    if (csvBtn && csvInput) {
      csvBtn.addEventListener("click", function () { menu && menu.classList.remove("open"); csvInput.value = ""; csvInput.click(); });
      csvInput.addEventListener("change", function () { if (this.files[0]) openImportCsvModal(this.files[0]); });
    }
    if (pdfBtn && pdfInput) {
      pdfBtn.addEventListener("click", function () { menu && menu.classList.remove("open"); pdfInput.value = ""; pdfInput.click(); });
      pdfInput.addEventListener("change", function () { if (this.files[0]) openImportPdfModal(this.files[0]); });
    }
  })();
  var clearFiltersBtn = document.getElementById("btn-clear-filters");
  if (clearFiltersBtn) clearFiltersBtn.addEventListener("click", function () {
    if (_assetsSF) { _assetsSF.clearFilters(); }
    assetsApplyFilterState();
  });
  // Page-size selector is now rendered inside the pagination row by
  // renderPageControls (onSizeChange) — no standalone #filter-pagesize.
});

// Short labels for table cells / pills. Seeded with the built-in registry rows;
// _loadAssetTypeOptions() adds an entry for every operator-added custom type it
// doesn't already carry (existing keys are never overwritten, so the compact
// "AP" rendering survives the registry's longer "Access Point" label).
var ASSET_TYPE_LABELS = {
  server: "Server",
  switch: "Switch",
  router: "Router",
  firewall: "Firewall",
  workstation: "Workstation",
  printer: "Printer",
  access_point: "AP",
  other: "Other",
  hypervisor: "Hypervisor",
};

// The full asset-type list ({value, label}) used by option lists — the Type
// column's multi-select filter and the create/edit form's Type select. Seeded
// with the built-ins so both surfaces work before /asset-types answers (and if
// it fails); replaced wholesale by the live AssetTypeDef registry, which is
// what makes operator-added custom types selectable.
var ASSET_TYPE_OPTIONS = [
  { value: "server",       label: "Server" },
  { value: "switch",       label: "Switch" },
  { value: "router",       label: "Router" },
  { value: "firewall",     label: "Firewall" },
  { value: "workstation",  label: "Workstation" },
  { value: "printer",      label: "Printer" },
  { value: "access_point", label: "Access Point" },
  { value: "hypervisor",   label: "Hypervisor" },
  { value: "other",        label: "Other" },
];

// Pull the registry and fold it into both maps. Never throws — a failed fetch
// (401 on a logged-out page, offline) leaves the built-in seed in place.
async function _loadAssetTypeOptions() {
  var rows;
  try {
    var res = await api.assetTypes.list();
    rows = Array.isArray(res) ? res : (res && res.types) || [];
  } catch (err) {
    return;
  }
  if (!Array.isArray(rows) || !rows.length) return;
  ASSET_TYPE_OPTIONS = rows
    .filter(function (t) { return t && t.name; })
    .map(function (t) { return { value: String(t.name), label: String(t.label || t.name) }; });
  ASSET_TYPE_OPTIONS.forEach(function (o) {
    if (!ASSET_TYPE_LABELS.hasOwnProperty(o.value)) ASSET_TYPE_LABELS[o.value] = o.label;
  });
  if (_assetsSF) _assetsSF.setColumnOptions("assetType", ASSET_TYPE_OPTIONS);
  // The bulk bar is wired before this resolves — repaint it with the real list.
  if (typeof _renderBulkTypeMenu === "function") _renderBulkTypeMenu();
}

// <option> list for a Type select, built from the registry. `current` is kept
// as an option even when the registry no longer carries it (a retired type
// still stamped on an old row), so opening the form can't silently retype the
// asset; empty/unknown falls back to "other" the way the form always has.
function assetTypeOptionsHTML(current) {
  var value = current || "other";
  var known = ASSET_TYPE_OPTIONS.some(function (o) { return o.value === value; });
  var opts = ASSET_TYPE_OPTIONS.slice();
  if (!known) opts.push({ value: value, label: ASSET_TYPE_LABELS[value] || value });
  return opts.map(function (o) {
    return '<option value="' + escapeHtml(o.value) + '"' +
      (o.value === value ? " selected" : "") + '>' + escapeHtml(o.label) + '</option>';
  }).join("");
}

// Bulk-bar State dropdown options. quarantined is intentionally omitted —
// quarantine is set/cleared via the dedicated /assets/bulk-quarantine
// endpoint, not the regular asset PUT.
var ASSET_STATUS_LABELS = {
  active: "Active",
  maintenance: "Maintenance",
  storage: "Storage",
  disabled: "Disabled",
  decommissioned: "Decommissioned",
};

// The single "the filter/sort state changed" entry point: back to page 1,
// re-fetch server-side, persist the per-user prefs blob, and mirror the new
// state into the active view tab. Wired as TableSF's onChange (operator edits a
// header control) AND called directly after a PROGRAMMATIC change (Clear
// filters, loading a saved preset) — assets-filters.js / assets-tabs.js, both
// loaded after this file.
//
// assets-tabs.js guards its own re-entrancy: applying a tab's state calls back
// through here, and syncFromTable() ignores changes it caused itself.
function assetsApplyFilterState() {
  _assetsPage = 1;
  fetchAssetsPage();
  _saveAssetsPrefs();
  if (window.PolarisAssetTabs) window.PolarisAssetTabs.syncFromTable();
}

// Reads dashboard / global-search deep-link hash params and seeds the
// TableSF filters BEFORE the first loadAssets call so the initial render is
// already narrowed.
//
// Supported hash forms (extends the legacy #view=asset:<id> handled by
// app.js processSearchHash):
//   #type=<assetType>         — pre-filters the Type column to a single value
//   #search=<hostname>        — pre-filters the Hostname column substring
//
// Both forms can co-occur. The values land in TableSF._filters so the smart
// filter UI shows them as if the operator had typed them in.
// True when the deep link actually seeded a filter — assets-tabs.js reads it to
// keep the link's narrowing instead of overwriting it with the active tab's.
var _assetsHashFiltersApplied = false;

function _applyAssetsHashFilters() {
  if (!_assetsSF) return;
  var hash = (window.location.hash || "").replace(/^#/, "");
  if (!hash) return;
  var params = {};
  hash.split("&").forEach(function (kv) {
    var p = kv.split("=");
    if (p.length === 2) params[decodeURIComponent(p[0])] = decodeURIComponent(p[1]);
  });
  if (params.type && ASSET_TYPE_LABELS.hasOwnProperty(params.type)) {
    _assetsSF._filters.assetType = [params.type];
  }
  if (params.search) {
    _assetsSF._filters.hostname = params.search;
  }
  if (_assetsSF._filters.assetType || _assetsSF._filters.hostname) {
    _assetsHashFiltersApplied = true;
    if (typeof _assetsSF.restoreFilterUI === "function") _assetsSF.restoreFilterUI();
    if (typeof _assetsSF._updateIcons === "function") _assetsSF._updateIcons();
  }
}

// Translate the live TableSF filter + sort state + pagination + favorites into
// query params for GET /api/v1/assets (server-side mode). Mirrors the Events
// page's _buildEventsQuery. The saved-filter localStorage prefs are unchanged —
// they still live in _assetsSF._filters / _sortKey / _sortDir; this just maps
// that same state onto the wire instead of applying it client-side.
function _buildAssetsQuery() {
  var filters = _assetsSF ? (_assetsSF._filters || {}) : {};
  var params = {
    limit: _assetsPageSize,
    offset: (_assetsPage - 1) * _assetsPageSize,
  };

  // Multi-select enum columns → CSV.
  if (Array.isArray(filters.status) && filters.status.length) params.status = filters.status.join(",");
  if (Array.isArray(filters.assetType) && filters.assetType.length) params.assetType = filters.assetType.join(",");
  if (Array.isArray(filters._monitor) && filters._monitor.length) params.monitor = filters._monitor.join(",");

  // Operator-aware text columns. Param name == column key, except _server→server.
  var textCols = ["hostname", "ipAddress", "serialNumber", "assetTag", "manufacturer",
    "model", "os", "macAddress", "assignedTo", "purchaseOrder", "dnsName", "description", "tags"];
  textCols.forEach(function (key) { _pushAssetText(params, key, filters[key]); });
  _pushAssetText(params, "server", filters._server);

  // lastSeen date-range column.
  if (filters.lastSeen && filters.lastSeen.type === "date") {
    if (filters.lastSeen.from) params.lastSeenFrom = filters.lastSeen.from;
    if (filters.lastSeen.to)   params.lastSeenTo = filters.lastSeen.to;
  }

  // Favorites-first ordering: send the operator's starred ids so they float to
  // the top of the whole result set (not just the current page).
  if (typeof getFavorites === "function") {
    var favs = getFavorites("assets");
    if (favs && favs.size) params.favoriteIds = Array.from(favs).join(",");
  }

  // Sort whitelist.
  if (_assetsSF && _assetsSF._sortKey) {
    params.sortBy = _assetsSF._sortKey;
    params.sortDir = _assetsSF._sortDir === "asc" ? "asc" : "desc";
  }
  return params;
}

// Discovery's breadcrumb tags (a device's former Entra / AD object id) — kept
// on the asset for the matcher, never something an operator filters by. The
// filter leaves them out unless a stored pick already names one.
var TAG_FILTER_HIDDEN_PREFIXES = ["prev-entra:", "prev-ad:"];
function _isTagFilterHidden(name) {
  var n = String(name == null ? "" : name).toLowerCase();
  return TAG_FILTER_HIDDEN_PREFIXES.some(function (p) { return n.indexOf(p) === 0; });
}

// The Tags column filter's picker: the edit form's grouped colour chips
// (registry categories, the same _tagChipHTML chips), laid out in full rather
// than in the form's 200px scroll box. It reads the catalogue itself rather
// than _tagCache, because the cache drops the Arc-owned `azure:` rows (the
// EDIT picker must never offer them) and a FILTER must: they appear under
// their own registry category in their own colours, as Server Settings → Tags
// shows them. Tags in use with no registry row land in "Other tags in use";
// the prev-entra: / prev-ad: breadcrumbs are left out. Any / All and
// "Include untagged" sit above the chips; nothing filters until OK.
// `current` is the stored { op: "pick", … } or null; `done` is TableSF's.
async function openAssetTagFilterModal(current, done) {
  var inUse = [];
  var catalog = [];
  var catalogFailed = false;
  var both = await Promise.all([
    api.serverSettings.tagCatalog().catch(function () { catalogFailed = true; return null; }),
    api.assets.tags().catch(function () { return null; }),
  ]);
  catalog = ((both[0] && both[0].tags) || []).filter(function (t) { return t && t.name; });
  inUse = (both[1] && both[1].tags) || [];

  // A fresh filter starts on All: each extra tag narrows the list, which is
  // what picking a second tag reads as. A stored filter keeps its own mode.
  var cur = current || { mode: "all", values: [], none: false };
  var selected = (cur.values || []).slice();
  var mode = cur.mode === "any" ? "any" : "all";

  var cats = {};
  var registered = {};
  catalog.forEach(function (t) {
    if (_isTagFilterHidden(t.name) && selected.indexOf(t.name) < 0) return;
    var cat = t.category || "General";
    (cats[cat] = cats[cat] || []).push(t);
    registered[t.name] = true;
  });
  var others = [];
  inUse.concat(selected).forEach(function (name) {
    if (!name || registered[name] || others.indexOf(name) >= 0) return;
    if (_isTagFilterHidden(name) && selected.indexOf(name) < 0) return;
    others.push(name);
  });
  others.sort(function (a, b) { return a.localeCompare(b); });

  var chips = "";
  Object.keys(cats).sort().forEach(function (cat) {
    chips += '<div class="tag-picker-category"><span class="tag-picker-cat-label">' + escapeHtml(cat) + '</span>';
    cats[cat].forEach(function (t) { chips += _tagChipHTML(t.name, t.color, selected.indexOf(t.name) >= 0); });
    chips += '</div>';
  });
  if (others.length) {
    chips += '<div class="tag-picker-category"><span class="tag-picker-cat-label">Other tags in use</span>';
    others.forEach(function (name) { chips += _tagChipHTML(name, "", selected.indexOf(name) >= 0); });
    chips += '</div>';
  }
  if (!chips) {
    chips = '<p class="hint" style="margin:0">' +
      (catalogFailed ? "Could not load the tag list." : "No tags in use yet.") + '</p>';
  }

  var body =
    '<div class="tag-filter-head">' +
      '<div class="sf-pick-mode" role="radiogroup" aria-label="Match">' +
        '<button type="button" class="sf-pick-mode-btn" data-mode="any" title="Assets carrying ANY selected tag">Any</button>' +
        '<button type="button" class="sf-pick-mode-btn" data-mode="all" title="Assets carrying EVERY selected tag">All</button>' +
      '</div>' +
      '<label class="tag-filter-none"><input type="checkbox" id="tag-filter-none"' + (cur.none ? " checked" : "") + '> Include untagged assets</label>' +
    '</div>' +
    '<div class="tag-picker tag-filter-picker" id="tag-filter-picker">' + chips + '</div>';
  var footer =
    '<button type="button" class="btn btn-secondary" id="tag-filter-clear" style="margin-right:auto">Clear</button>' +
    '<span class="tag-filter-count" id="tag-filter-count"></span>' +
    '<button type="button" class="btn btn-secondary" id="tag-filter-cancel">Cancel</button>' +
    '<button type="button" class="btn btn-primary" id="tag-filter-ok">OK</button>';
  openModal("Filter by tags", body, footer, { wide: true });

  var picker = document.getElementById("tag-filter-picker");
  var noneBox = document.getElementById("tag-filter-none");
  var countEl = document.getElementById("tag-filter-count");
  // _tagChipHTML names its boxes f-tags-cb, and getTagFieldValue (the edit
  // form's save) reads every f-tags-cb in the DOCUMENT — this dialog's body
  // lingers hidden after it closes, so its ticks must not answer to that name.
  picker.querySelectorAll('input[name="f-tags-cb"]').forEach(function (cb) { cb.name = "tag-filter-cb"; });
  // Not _wireChipListeners: it re-reads each chip's colour from _tagCache,
  // which has no azure: rows, so their chips would never brighten when
  // picked. The chip already knows whether it is coloured.
  picker.querySelectorAll(".tag-picker-chip input").forEach(function (cb) {
    cb.addEventListener("change", function () {
      var label = cb.parentElement;
      label.classList.toggle("selected", cb.checked);
      if (label.classList.contains("hue-pill")) {
        label.classList.toggle("hue-strong", cb.checked);
        label.classList.toggle("hue-off", !cb.checked);
      }
    });
  });

  function ticked() {
    return Array.prototype.map.call(picker.querySelectorAll('input[type="checkbox"]:checked'), function (cb) { return cb.value; });
  }
  function refresh() {
    document.querySelectorAll("#modal-overlay .sf-pick-mode-btn").forEach(function (b) {
      var on = b.getAttribute("data-mode") === mode;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    });
    // A row cannot be untagged and carry every tag, so All turns it off.
    noneBox.disabled = mode === "all";
    noneBox.parentElement.classList.toggle("sf-pick-disabled", mode === "all");
    var n = ticked().length + (noneBox.checked && mode !== "all" ? 1 : 0);
    countEl.textContent = n ? n + " selected" : "";
  }

  document.querySelectorAll("#modal-overlay .sf-pick-mode-btn").forEach(function (b) {
    b.addEventListener("click", function () { mode = b.getAttribute("data-mode") === "all" ? "all" : "any"; refresh(); });
  });
  picker.addEventListener("change", refresh);
  noneBox.addEventListener("change", refresh);
  document.getElementById("tag-filter-clear").addEventListener("click", function () {
    picker.querySelectorAll('input[type="checkbox"]:checked').forEach(function (cb) {
      cb.checked = false;
      cb.dispatchEvent(new Event("change", { bubbles: true }));
    });
    noneBox.checked = false;
    refresh();
  });
  document.getElementById("tag-filter-cancel").addEventListener("click", closeModal);
  document.getElementById("tag-filter-ok").addEventListener("click", function () {
    var values = ticked();
    var none = noneBox.checked && mode !== "all";
    closeModal();
    done(values.length || none ? { op: "pick", mode: mode, values: values, none: none } : null);
  });
  refresh();
}

// Map one TableSF text-filter value onto <param> / <param>Op. Handles the
// plain-string contains form, the "!"-prefix negation, and the object forms
// ({op:"not-contains",q}, {op:"empty"}, {op:"notempty"}) that table-sf stores.
function _pushAssetText(params, paramKey, raw) {
  if (raw == null) return;
  if (typeof raw === "string") {
    var v = raw.trim();
    if (!v) return;
    if (v.charAt(0) === "!") {
      var rest = v.slice(1).trim();
      if (!rest) return;
      params[paramKey] = rest;
      params[paramKey + "Op"] = "not_contains";
    } else {
      params[paramKey] = v; // op defaults to contains server-side
    }
  } else if (typeof raw === "object") {
    if (raw.op === "empty") {
      params[paramKey + "Op"] = "empty";
    } else if (raw.op === "notempty") {
      params[paramKey + "Op"] = "is_not_empty";
    } else if (raw.op === "not-contains") {
      var q = (raw.q || "").trim();
      if (!q) return;
      params[paramKey] = q;
      params[paramKey + "Op"] = "not_contains";
    } else if (raw.op === "pick") {
      // Tags column pick menu: exact names as a JSON array (a tag may hold a
      // comma), any_of / all_of, plus the "(No tags)" row on any_of.
      var vals = (raw.values || []).filter(function (v) { return typeof v === "string" && v; });
      var none = !!raw.none && raw.mode !== "all";
      if (!vals.length && !none) return;
      if (!vals.length) { params[paramKey + "Op"] = "empty"; return; }
      params[paramKey] = JSON.stringify(vals);
      params[paramKey + "Op"] = raw.mode === "all" ? "all_of" : "any_of";
      if (none) params[paramKey + "Untagged"] = "1";
    } else if (raw.op === "in-networks") {
      // IP Address column: any-of IPv4 prefixes / CIDRs (TableSF ipnet filter).
      var terms = (raw.terms || []).map(function (t) { return String(t).trim(); }).filter(Boolean);
      if (!terms.length) return;
      params[paramKey] = terms.join(",");
      params[paramKey + "Op"] = "in_networks";
    }
  }
}

// Fetch + render the current page. Preserves the cross-page selection set —
// callers that want a clean slate (post-mutation refresh, Refresh button) go
// through loadAssets() instead, which clears the selection first.
async function fetchAssetsPage() {
  var tbody = document.getElementById("assets-tbody");
  // This file is loaded by every page that carries the asset slide-over —
  // index.html, map.html, appmap.html, automations.html — not just the Assets
  // page, and `loadAssets()` is the post-write refresh every mutating surface
  // calls. Off the Assets page there is no table to repaint: the fetch was
  // wasted and the render then threw "Cannot set properties of null" into an
  // unhandled rejection (silent — the write it followed had already
  // succeeded). Reachable since the Active Maintenance widget let the
  // Maintenance modal be opened, and a schedule created or disabled, from the
  // dashboard.
  if (!tbody) return;
  try {
    var data = await api.assets.list(_buildAssetsQuery());
    var all = data.assets || [];
    _assetsTotal = (typeof data.total === "number") ? data.total : all.length;
    // Paged past the end (e.g. after deletions or a narrowing filter while on a
    // high page) → clamp to the last page and refetch once.
    var lastPage = Math.max(1, Math.ceil(_assetsTotal / _assetsPageSize));
    if (all.length === 0 && _assetsTotal > 0 && _assetsPage > lastPage) {
      _assetsPage = lastPage;
      return fetchAssetsPage();
    }
    function _mapAsset(a) {
      a._server = a.location || a.learnedLocation || "";
      // Array so a single row can satisfy multiple filter selections —
      // e.g. a monitored Up asset matches both "Monitored" and "Up". The
      // patched multi-filter in table-sf.js checks membership when the
      // row value is an array.
      if (!a.monitored) {
        a._monitor = ["Unmonitored"];
      } else if (a.dependencySuppressed) {
        // Dependency-suppressed outranks the five-state label, matching the
        // Status pill in assetMonitorBadge: the chip is "Dep. Down" whether
        // or not the asset's own probe is also failing.
        a._monitor = ["Monitored", "Dep. Down"];
      } else if (a.monitorStatus === "up") {
        a._monitor = ["Monitored", "Up"];
      } else if (a.monitorStatus === "warning") {
        // Chip label is "Missed" — see POLARIS_MONITOR_STATUS_LABELS in api.js.
        // The server still accepts the legacy "Warning" chip so saved presets
        // and view tabs that stored it keep filtering (monitorClause).
        a._monitor = ["Monitored", "Missed"];
      } else if (a.monitorStatus === "down") {
        a._monitor = ["Monitored", "Down"];
      } else if (a.monitorStatus === "recovering") {
        a._monitor = ["Monitored", "Recovering"];
      } else if (a.monitorStatus === "passive") {
        a._monitor = ["Monitored", "Passive"];
      } else {
        // "unknown" (never probed) and any unrecognized value fall through
        // here. Filter chip is "Pending" — operators read it as "we don't
        // know yet" rather than the directional "Recovering".
        a._monitor = ["Monitored", "Pending"];
      }
      return a;
    }
    _assetsData = all.map(_mapAsset);
    renderAssetsPage();
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="24" class="empty-state">Error: ' + escapeHtml(err.message) + '</td></tr>';
  }
}

// Full reload: drop the selection and fetch the current page fresh. Used by the
// Refresh button and by every post-mutation refresh (create / edit / delete /
// bulk / quarantine / import). Page navigation + filter/sort changes call
// fetchAssetsPage() directly so they keep the selection.
async function loadAssets() {
  _assetsSelected.clear();
  _assetsSelectedMeta = {};
  _assetsUpdateBulkBar();
  await fetchAssetsPage();
}

function _copyableCell(value) {
  if (!value) return '-';
  return '<span class="copy-cell" title="Click to copy" data-copy="' + escapeHtml(value) + '">' + escapeHtml(value) + '</span>';
}

// Latitude / Longitude cell: up to 5 decimal places (~1 m of precision),
// trailing zeros trimmed. 0 is a valid coordinate, so the null check is
// explicit rather than truthiness (String(0) is "0", which _copyableCell keeps).
function _coordCell(v) {
  if (v == null || typeof v !== "number" || !isFinite(v)) return "-";
  return _copyableCell(String(Math.round(v * 1e5) / 1e5));
}

var _macTooltipTimer = null;
var _macTooltipShowTimer = null;
var _MAC_TOOLTIP_SHOW_DELAY = 300;

function _showMacTooltip(trigger) {
  clearTimeout(_macTooltipTimer);
  // Hide any other visible tooltip first
  document.querySelectorAll('.mac-tooltip-visible').forEach(function (t) {
    t.classList.remove('mac-tooltip-visible');
  });
  // On first show, lift the tooltip out of its inline parent into <body>.
  // Ancestors like .modal use transform/overflow, which would otherwise
  // reparent position:fixed onto the modal and clip the tooltip.
  var tooltip = trigger._tooltip || trigger.querySelector('.mac-tooltip');
  if (!tooltip) return;
  if (tooltip.parentNode !== document.body) {
    document.body.appendChild(tooltip);
    trigger._tooltip = tooltip;
  }
  // Measure offscreen
  tooltip.style.visibility = 'hidden';
  tooltip.style.display = 'block';
  var triggerRect = trigger.getBoundingClientRect();
  var tipH = tooltip.offsetHeight;
  var tipW = tooltip.offsetWidth;
  tooltip.style.display = '';
  tooltip.style.visibility = '';
  // Position: prefer above, flip below if not enough room
  var above = triggerRect.top - tipH - 8;
  if (above < 8) {
    tooltip.style.top = (triggerRect.bottom + 8) + 'px';
  } else {
    tooltip.style.top = above + 'px';
  }
  // Left-aligned to the trigger, pulled back inside the viewport when that
  // would run off the right edge (a trigger near a slide-over's right side).
  tooltip.style.left = Math.max(8, Math.min(triggerRect.left, window.innerWidth - tipW - 8)) + 'px';
  tooltip.classList.add('mac-tooltip-visible');

  // Wire mouseleave on tooltip itself (once)
  if (!tooltip._wired) {
    tooltip._wired = true;
    tooltip.addEventListener('mouseenter', function () { clearTimeout(_macTooltipTimer); });
    tooltip.addEventListener('mouseleave', function () { _scheduleMacHide(tooltip); });
  }
}

function _scheduleMacHide(tooltip) {
  _macTooltipTimer = setTimeout(function () {
    tooltip.classList.remove('mac-tooltip-visible');
  }, 100);
}

function _macTriggerEnter(trigger) {
  clearTimeout(_macTooltipShowTimer);
  _macTooltipShowTimer = setTimeout(function () {
    _showMacTooltip(trigger);
  }, _MAC_TOOLTIP_SHOW_DELAY);
}

function _macTriggerLeave(trigger) {
  clearTimeout(_macTooltipShowTimer);
  var tooltip = trigger._tooltip || trigger.querySelector('.mac-tooltip');
  if (tooltip) _scheduleMacHide(tooltip);
}

// The hover pills are delegated from their container (the Assets list's tbody,
// the asset panel's body), not bound per pill on every paint (CQ-F042).
// mouseenter / mouseleave do not bubble, so the pair below rebuilds them from
// mouseover / mouseout: a `.mac-hover-trigger` is entered or left when the
// pointer crosses its edge — the event's target is inside it and the
// relatedTarget is not. Every trigger crossed is reported, outermost first on
// the way in and innermost first on the way out, as the native events order
// nested ones. Bound with these named functions, so adding them to the same
// container again is a no-op.
function _macTriggersCrossed(e) {
  var crossed = [];
  var rel = e.relatedTarget;
  for (var n = e.target; n && n !== e.currentTarget && n.nodeType === 1; n = n.parentNode) {
    if (n.classList.contains('mac-hover-trigger') && !(rel && n.contains(rel))) crossed.push(n);
  }
  return crossed;
}

function _handleMacOver(e) {
  _macTriggersCrossed(e).reverse().forEach(_macTriggerEnter);
}

function _handleMacOut(e) {
  _macTriggersCrossed(e).forEach(_macTriggerLeave);
}

function _handleCopyClick(e) {
  var el = e.target.closest('.copy-cell');
  if (!el) return;
  var text = el.getAttribute('data-copy');
  if (!text) return;
  copyTextToClipboard(text).then(function (ok) {
    if (!ok) return;
    el.classList.add('copy-cell-flash');
    setTimeout(function () { el.classList.remove('copy-cell-flash'); }, 600);
  });
}

// Singleton dropdown element used by the clickable Type pill. Created lazily
// on first open, appended to document.body so it floats over the table
// without being clipped by row overflow, repositioned per-click. One global
// instance keeps the DOM clean even when an operator clicks rapidly across
// rows.
var _typeDropdown = null;
var _typeDropdownOutsideHandler = null;

function _closeTypeDropdown() {
  if (!_typeDropdown) return;
  if (_typeDropdownOutsideHandler) {
    document.removeEventListener("mousedown", _typeDropdownOutsideHandler, true);
    _typeDropdownOutsideHandler = null;
  }
  _typeDropdown.classList.remove("open");
  _typeDropdown.style.display = "none";
}

function _ensureTypeDropdown() {
  if (_typeDropdown) return _typeDropdown;
  var el = document.createElement("div");
  el.className = "btn-dropdown-menu type-pill-dropdown";
  el.style.position = "absolute";
  el.style.display = "none";
  el.style.minWidth = "140px";
  document.body.appendChild(el);
  _typeDropdown = el;
  return el;
}

// Delegated click handler for the Type column pill. Opens a dropdown of the
// 8 AssetType values; clicking an option PUTs the change inline with the same
// optimistic / rollback pattern as the Status pill.
async function _handleTypePillClick(e) {
  var pill = e.target.closest('[data-asset-type-toggle]');
  if (!pill) return;
  e.preventDefault();
  e.stopPropagation();
  if (typeof canManageAssets === "function" && !canManageAssets()) return;
  var assetId    = pill.getAttribute('data-asset-type-toggle');
  var currentType = pill.getAttribute('data-asset-type') || "other";

  var dd = _ensureTypeDropdown();
  // Build dropdown content fresh each open — the registry list is short and the
  // active highlight changes per asset. Read ASSET_TYPE_OPTIONS, not
  // ASSET_TYPE_LABELS: the labels map only ever GAINS keys, so a type retired
  // from the registry stayed selectable here. The asset's own type is kept as an
  // option when the registry no longer carries it (assetTypeOptionsHTML's rule),
  // so opening the menu can never hide what the row currently is.
  var typeOpts = ASSET_TYPE_OPTIONS.slice();
  if (!typeOpts.some(function (o) { return o.value === currentType; })) {
    typeOpts.push({ value: currentType, label: ASSET_TYPE_LABELS[currentType] || currentType });
  }
  var html = ['<div class="dropdown-heading">Asset type</div>'];
  typeOpts.forEach(function (o) {
    var active = o.value === currentType ? ' style="font-weight:600;"' : '';
    html.push('<button type="button" data-type-option="' + escapeHtml(o.value) + '"' + active + '>' + escapeHtml(o.label) + (o.value === currentType ? ' ✓' : '') + '</button>');
  });
  dd.innerHTML = html.join("");

  // Position below the pill, aligned to its left edge. Document scroll
  // offsets matter when the table is scrolled; getBoundingClientRect returns
  // viewport coords, so add window.scrollX/Y to land in document coords.
  var rect = pill.getBoundingClientRect();
  dd.style.left = (rect.left + window.scrollX) + "px";
  dd.style.top  = (rect.bottom + window.scrollY + 4) + "px";
  dd.style.right = "auto";
  dd.style.display = "block";
  dd.classList.add("open");

  // Close on outside click. Capture phase so it fires before the inner
  // option-button click bubbles back here.
  if (_typeDropdownOutsideHandler) {
    document.removeEventListener("mousedown", _typeDropdownOutsideHandler, true);
  }
  _typeDropdownOutsideHandler = function (ev) {
    if (!dd.contains(ev.target)) _closeTypeDropdown();
  };
  // Defer attaching the outside handler one tick so the click that opened
  // us doesn't immediately close us.
  setTimeout(function () {
    document.addEventListener("mousedown", _typeDropdownOutsideHandler, true);
  }, 0);

  // Wire option buttons. Reattach each open since innerHTML replaced them.
  dd.querySelectorAll('button[data-type-option]').forEach(function (btn) {
    btn.addEventListener("click", async function (evt) {
      evt.preventDefault();
      evt.stopPropagation();
      var nextType = btn.getAttribute("data-type-option");
      _closeTypeDropdown();
      if (!nextType || nextType === currentType) return;
      await _setAssetType(assetId, nextType);
    });
  });
}

async function _setAssetType(assetId, nextType) {
  var idx = (_assetsData || []).findIndex(function (a) { return a.id === assetId; });
  if (idx === -1) return;
  var prevType = _assetsData[idx].assetType;
  // Optimistic flip + re-render; rollback below if the PUT fails.
  _assetsData[idx].assetType = nextType;
  renderAssetsPage();
  try {
    await api.assets.update(assetId, { assetType: nextType });
    showToast("Type changed to " + (ASSET_TYPE_LABELS[nextType] || nextType));
  } catch (err) {
    _assetsData[idx].assetType = prevType;
    renderAssetsPage();
    showToast((err && err.message) || "Failed to update type", "error");
  }
}

// Delegated click handler for the Status column pill. Toggles the asset's
// `monitored` flag through PUT /assets/:id; the route then recomputes
// `monitorOverride` against the discovering integration's per-class
// `addAsMonitored` so the System tab's Asset Override badge stays current.
//
// Disabling monitoring opens a small inline confirm popover anchored to
// the pill — operators were tripping the toggle accidentally while
// scanning the column. Re-enabling stays a one-click action since it's
// low-risk (worst case the asset starts probing and is flipped off again).
function _handleMonitorPillClick(e) {
  var pill = e.target.closest('[data-monitor-toggle]');
  if (!pill) return;
  e.preventDefault();
  e.stopPropagation();
  if (typeof canManageAssets === "function" && !canManageAssets()) return;
  var assetId = pill.getAttribute('data-monitor-toggle');
  var currentlyMonitored = pill.getAttribute('data-monitored') === "true";

  // In a maintenance window: the pill offers "end maintenance now" instead
  // of the monitoring toggle (monitoring is paused by the window itself).
  if (pill.getAttribute("data-maintenance") === "true") {
    _showMaintenanceEndConfirm(pill, assetId, pill.getAttribute("data-return-status") || "active");
    return;
  }

  // Enabling a currently-unmonitored asset opens the edit modal on the
  // Monitoring tab (where the operator sets the polling method / credential)
  // rather than flipping it blind — from both the table pill and the asset
  // details System-tab pill.
  if (!currentlyMonitored) {
    openEditModal(assetId, { tab: "monitoring" });
    return;
  }

  // Disabling still confirms inline (fast, low-risk toggle) — no need to
  // detour through the edit modal.
  _showMonitorDisableConfirm(pill, function () { _flipAssetMonitor(assetId, false); }, {
    assetId: assetId,
    hostname: pill.getAttribute("data-hostname") || "",
  });
}

// Shared pill popover shell: builds, positions (viewport coordinates so the
// parent <td>'s overflow:hidden doesn't clip it), and wires outside-click /
// Escape dismissal. Returns { popover, close }.
function _showPillPopover(anchorEl, ariaLabel, innerHtml) {
  // Drop any earlier popover first — clicking another pill while one is
  // open should swap, not stack.
  var existing = document.querySelector(".monitor-confirm-popover");
  if (existing) existing.remove();

  var popover = document.createElement("div");
  popover.className = "monitor-confirm-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", ariaLabel);
  popover.innerHTML = innerHtml;
  document.body.appendChild(popover);

  // Position: prefer below the pill; fall back to above if it would clip
  // the bottom edge. Horizontal alignment defaults to the pill's left
  // edge; nudge left if it would overrun the right viewport edge.
  var anchor = anchorEl.getBoundingClientRect();
  var pop = popover.getBoundingClientRect();
  var top = anchor.bottom + 6;
  if (top + pop.height > window.innerHeight - 8) top = anchor.top - pop.height - 6;
  var left = anchor.left;
  if (left + pop.width > window.innerWidth - 8) left = window.innerWidth - pop.width - 8;
  if (left < 8) left = 8;
  popover.style.top  = top  + "px";
  popover.style.left = left + "px";

  function close() {
    popover.remove();
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown",   onKey,     true);
  }
  function onOutside(ev) {
    if (popover.contains(ev.target)) return;
    close();
  }
  function onKey(ev) {
    if (ev.key === "Escape") { ev.preventDefault(); close(); }
  }
  document.addEventListener("mousedown", onOutside, true);
  document.addEventListener("keydown",   onKey,     true);

  return { popover: popover, close: close };
}

// Inline confirmation popover for the "disable monitoring" direction, plus
// (for maintenanceManagement holders) the ad-hoc "enter maintenance mode
// until…" action — creates a one-shot single-asset schedule that takes
// effect immediately.
function _showMonitorDisableConfirm(anchorEl, onConfirm, maintOpts) {
  var offerMaintenance = !!(maintOpts && maintOpts.assetId &&
    typeof window.maintCreateAdhoc === "function" &&
    typeof canManageMaintenance === "function" && canManageMaintenance());

  var maintHtml = "";
  if (offerMaintenance) {
    // The end time is read by the server as ITS wall clock, so prefill from the
    // server's clock and name the zone — a browser-clock "+2h" on a UTC-clocked
    // host is already in the server's past and the window closes on the next
    // reconcile. maintServerNow falls back to the browser clock until the skew
    // read lands, which is why the read is kicked off before the popover paints.
    var maintNowMs = typeof window.maintServerNow === "function"
      ? window.maintServerNow().getTime() : Date.now();
    var defaultUntil = typeof window.maintLocalIso === "function"
      ? window.maintLocalIso(new Date(maintNowMs + 2 * 60 * 60 * 1000))
      : "";
    var tzLabel = typeof window.maintServerClockLabel === "function"
      ? window.maintServerClockLabel() : "";
    maintHtml =
      '<div class="mcp-message" style="margin-top:8px;border-top:1px solid var(--color-border);padding-top:8px">Or enter maintenance mode until:</div>' +
      '<div class="mcp-actions" style="align-items:center;gap:6px">' +
        '<input type="datetime-local" class="mcp-maint-until" value="' + escapeHtml(defaultUntil) + '" style="font-size:0.82rem">' +
        '<button type="button" class="mcp-confirm mcp-maint-enter">Enter</button>' +
      '</div>' +
      (tzLabel
        ? '<div class="mcp-message" style="font-size:0.78rem">Server time: ' + escapeHtml(tzLabel) + '</div>'
        : "") +
      '<label class="mcp-message" style="display:flex;align-items:center;gap:6px;cursor:pointer;margin-top:6px" title="Devices behind this asset go into dependency suppression (notifications paused) for the window. Uncheck when they stay reachable and should keep alerting.">' +
        '<input type="checkbox" class="mcp-maint-suppress" checked style="width:auto"> Mark dependent devices as down' +
      '</label>';
  }

  var ctl = _showPillPopover(anchorEl, "Disable monitoring",
    '<div class="mcp-message">Disable monitoring on this asset?</div>' +
    '<div class="mcp-actions">' +
      '<button type="button" class="mcp-cancel">Cancel</button>' +
      '<button type="button" class="mcp-confirm">Disable</button>' +
    '</div>' + maintHtml);

  ctl.popover.querySelector(".mcp-cancel").addEventListener("click", ctl.close);
  ctl.popover.querySelector(".mcp-confirm").addEventListener("click", function () {
    ctl.close();
    onConfirm();
  });
  if (offerMaintenance) {
    ctl.popover.querySelector(".mcp-maint-enter").addEventListener("click", async function () {
      // Omit nowMs so the validator uses the server clock (see its header).
      var check = window.maintValidateAdhocEnd(ctl.popover.querySelector(".mcp-maint-until").value);
      if (!check.ok) { showToast(check.error, "error"); return; }
      var suppressCb = ctl.popover.querySelector(".mcp-maint-suppress");
      var suppress = !suppressCb || suppressCb.checked;
      ctl.close();
      try {
        await window.maintCreateAdhoc(maintOpts.assetId, maintOpts.hostname, check.value, { suppressChildren: suppress });
        showToast("Maintenance mode active — schedule created");
        if (typeof loadAssets === "function") loadAssets();
      } catch (err) {
        showToast((err && err.message) || "Failed to enter maintenance mode", "error");
      }
    });
  }
  // Focus Cancel by default — accidental Enter shouldn't disable monitoring.
  setTimeout(function () { ctl.popover.querySelector(".mcp-cancel").focus(); }, 0);
}

// Popover for a pill already in a maintenance window: end it early. The PUT
// closes the open windows server-side (operator wins; the scheduler won't
// re-enter this occurrence) and restores the pre-window status.
function _showMaintenanceEndConfirm(anchorEl, assetId, returnStatus) {
  if (typeof canManageMaintenance !== "function" || !canManageMaintenance()) return;
  var ctl = _showPillPopover(anchorEl, "End maintenance",
    '<div class="mcp-message">End maintenance mode now? Monitoring and notifications resume immediately.</div>' +
    '<div class="mcp-actions">' +
      '<button type="button" class="mcp-cancel">Cancel</button>' +
      '<button type="button" class="mcp-confirm">End Maintenance</button>' +
    '</div>');
  ctl.popover.querySelector(".mcp-cancel").addEventListener("click", ctl.close);
  ctl.popover.querySelector(".mcp-confirm").addEventListener("click", async function () {
    ctl.close();
    try {
      await api.assets.update(assetId, { status: returnStatus || "active" });
      showToast("Maintenance ended");
      if (typeof loadAssets === "function") loadAssets();
    } catch (err) {
      showToast((err && err.message) || "Failed to end maintenance", "error");
    }
  });
  setTimeout(function () { ctl.popover.querySelector(".mcp-cancel").focus(); }, 0);
}

// Optimistic-update helper extracted from the click handler so the
// confirmed-disable and immediate-enable paths share a single network +
// rollback flow.
async function _flipAssetMonitor(assetId, nextMonitored) {
  var idx = (_assetsData || []).findIndex(function (a) { return a.id === assetId; });
  if (idx === -1) {
    // Pill lives outside the current table page (slide-over System tab):
    // no optimistic row to mutate — write through and re-render the panel.
    try {
      await api.assets.update(assetId, { monitored: nextMonitored });
      showToast(nextMonitored ? "Monitoring enabled" : "Monitoring disabled");
      if (document.getElementById("asset-panel-overlay") &&
          document.getElementById("asset-panel-overlay").classList.contains("open")) {
        openViewModal(assetId);
      }
    } catch (err) {
      showToast((err && err.message) || "Failed to update monitoring", "error");
    }
    return;
  }
  var prevSnapshot = Object.assign({}, _assetsData[idx]);
  _assetsData[idx].monitored = nextMonitored;
  if (!nextMonitored) {
    _assetsData[idx].monitorStatus = null;
    _assetsData[idx].lastResponseTimeMs = null;
  } else {
    _assetsData[idx].monitorStatus = "recovering";
    _assetsData[idx].consecutiveFailures = 0;
    _assetsData[idx].consecutiveSuccesses = 0;
  }
  renderAssetsPage();
  try {
    await api.assets.update(assetId, { monitored: nextMonitored });
    showToast(nextMonitored ? "Monitoring enabled" : "Monitoring disabled");
  } catch (err) {
    _assetsData[idx].monitored          = prevSnapshot.monitored;
    _assetsData[idx].monitorStatus      = prevSnapshot.monitorStatus;
    _assetsData[idx].lastResponseTimeMs = prevSnapshot.lastResponseTimeMs;
    renderAssetsPage();
    showToast((err && err.message) || "Failed to update monitoring", "error");
  }
}

async function _handleMacDeleteClick(e) {
  var btn = e.target.closest('.mac-tooltip-delete');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  var assetId = btn.getAttribute('data-asset-id');
  var mac = btn.getAttribute('data-mac');
  if (!assetId || !mac) return;
  // A range row (an interface scrape's folded port block) takes every MAC in
  // the block with it — say so, rather than asking about the one address the
  // button happens to sit next to.
  var macEnd = btn.getAttribute('data-mac-end');
  var what = macEnd
    ? macEntryCount({ mac: mac, macEnd: macEnd }) + ' MACs (' + mac + ' – ' + macEnd + ')'
    : 'MAC ' + mac;
  // Names the one-shot semantics: the endpoint deletes the row, it does not
  // suppress the address, so a MAC the network still reports against this
  // asset comes back on the next discovery run.
  var ok = await showConfirm(
    'Remove ' + what + ' from this asset?\n\n' +
    'The IP addresses discovery recorded under it are removed too, and a primary address pinned to it is released. ' +
    'If the network reports this address against the asset again, discovery will re-add it.'
  );
  if (!ok) return;
  btn.disabled = true;
  try {
    await api.assets.removeMac(assetId, mac);
    showToast('MAC removed');
    // Repaint whichever surface the click came from. The slide-over holds its
    // own copy of the asset, so refreshing the table behind it would leave the
    // removed MAC on screen in the panel the operator is still looking at.
    if (_isCurrentAsset(assetId)) {
      var activeTab = document.querySelector('#asset-view-tabs .page-tab.active');
      var activeKey = activeTab ? activeTab.getAttribute('data-tab') : null;
      await openViewModal(assetId);
      if (activeKey) {
        var tabBtn = document.querySelector('#asset-view-tabs .page-tab[data-tab="' + activeKey + '"]');
        if (tabBtn) tabBtn.click();
      }
    }
    // Only the Assets page has a table to refresh.
    if (document.getElementById("assets-tbody")) loadAssets();
  } catch (err) {
    btn.disabled = false;
    showToast(err.message, 'error');
  }
}
// Wired at load, not in the Assets page's init: that init returns early on
// every other page, but the asset panel opens on any page through global
// search (PolarisPanels), and its × was drawn with nothing listening. MAC
// tooltips are promoted to <body>, hence document-level delegation. Guarded
// because assets.js can be evaluated twice.
if (!window.__polarisMacDeleteWired) {
  window.__polarisMacDeleteWired = true;
  document.addEventListener("click", _handleMacDeleteClick);
}
// Click-to-copy inside a tooltip that _showMacTooltip promoted to <body>: the
// table body and the asset panel delegate copy clicks, and neither is an
// ancestor any more. Only promoted tooltips, so an in-place one never copies
// twice.
if (!window.__polarisTooltipCopyWired) {
  window.__polarisTooltipCopyWired = true;
  document.addEventListener("click", function (e) {
    var tip = e.target.closest && e.target.closest('.mac-tooltip');
    if (tip && tip.parentNode === document.body) _handleCopyClick(e);
  });
}

// Render the list-controls row: page navigation, the "Show N" page-size
// selector and the Refresh / Clear Filters buttons. Called on EVERY render,
// including the zero-row ones — a filter matching nothing used to
// clearPageControls() and take the whole row with it, which removed Clear
// Filters in exactly the state that needs it (empty table, no way back but a
// reload) along with the page size the operator had chosen.
function _renderAssetsPageControls() {
  // The active view tab may pin a saved filter as its BASE — the view it
  // returns to — in which case this row offers a way BACK to that view rather
  // than a way to nothing. Read per render: switching tabs changes the answer,
  // and assets-tabs.js repaints this row when a base is set or removed.
  // Feature-tested, not assumed: a browser holding a cached pre-base
  // assets-tabs.js must still get a controls row rather than a TypeError.
  var _tabs = window.PolarisAssetTabs;
  var _base = (_tabs && typeof _tabs.activeDefault === "function") ? _tabs.activeDefault() : null;
  // Nothing matched: there's no page to be on, so report page 1 rather than
  // whatever high page the operator filtered down from — fetchAssetsPage's
  // clamp only fires while the total is non-zero, so a stale page number would
  // leave "Prev" enabled and paging backwards through empty results.
  if (_assetsTotal === 0) _assetsPage = 1;
  renderPageControls("pagination", _assetsTotal, _assetsPageSize, _assetsPage, function (p) {
    _assetsPage = p;
    fetchAssetsPage();
  }, function (size) {
    _assetsPageSize = size;
    _assetsPage = 1;
    fetchAssetsPage();
    _saveAssetsPrefs();
  }, {
    // The top row shares a line with the view tabs (.table-head-row), so it
    // carries only Clear / Refresh / Show N — page buttons are below.
    topNav: false,
    actionButtons: [
      {
        label: _base ? "Reset Filter" : "Clear Filters",
        title: _base
          ? 'Back to this tab\'s base filter "' + (_base.name || "base") +
            '" — clear it from Filters \u25be'
          : "Clear every column filter on this view",
        onClick: function () {
          // resetToDefault drives the table through assetsApplyFilterState, so
          // the tab is mirrored either way — which the older inline
          // fetch+saveprefs pair here did not do, leaving a cleared table and a
          // tab still holding the filters a reload would bring back.
          if (_base && _tabs.resetToDefault()) return;
          if (_assetsSF) _assetsSF.clearFilters();
          assetsApplyFilterState();
        },
      },
      {
        label: "Refresh",
        className: "btn-glyph btn-glyph-refresh",
        title: "Refresh",
        onClick: loadAssets,
      },
      // + Add Asset(s), right of Refresh: the page's own button, moved in.
      { el: document.getElementById("btn-add-asset") },
    ].filter(function (b) { return !("el" in b) || b.el; }),
  });
}

function renderAssetsPage() {
  var tbody = document.getElementById("assets-tbody");
  tbody.removeEventListener("click", _handleCopyClick);
  tbody.addEventListener("click", _handleCopyClick);
  tbody.removeEventListener("click", _handleMonitorPillClick);
  tbody.addEventListener("click", _handleMonitorPillClick);
  tbody.removeEventListener("click", _handleTypePillClick);
  tbody.addEventListener("click", _handleTypePillClick);
  // Server-side mode: _assetsData is already the filtered, sorted, favorites-
  // first current page. Don't re-filter / re-sort / re-slice it client-side.
  if (_assetsData.length === 0) {
    var hasFilters = _assetsSF && _assetsSF._filters && Object.keys(_assetsSF._filters).length > 0;
    tbody.innerHTML = hasFilters
      ? '<tr><td colspan="24" class="empty-state">No results match the current filters.</td></tr>'
      : '<tr><td colspan="24" class="empty-state">No assets found. Add one to get started.</td></tr>';
    _renderAssetsPageControls();
    _assetsUpdateSelectAll();
    return;
  }
  var page = _assetsData;
  tbody.innerHTML = page.map(function (a) {
    var checked = _assetsSelected.has(a.id) ? ' checked' : '';
    if (checked) _assetsRememberSelection(a.id);
    return '<tr data-row-menu-row>' +
      '<td class="cb-col"><input type="checkbox" class="row-cb"' + checked + ' data-id="' + a.id + '"></td>' +
      starCellHTML("assets", a.id) +
      '<td><button type="button" class="row-menu-trigger asset-menu" data-asset-id="' + a.id + '" ' +
        'aria-haspopup="menu" aria-expanded="false" title="Actions for this asset">' +
        '<strong>' + escapeHtml(a.hostname || "-") + '</strong></button>' +
        // Outside the button, not inside it: the trigger's accessible name is
        // the hostname, and folding an alert count into it would make every
        // alerted row announce itself differently to a screen reader.
        assetAlertDotHTML(a) +
        hostnameOriginalLineHTML(a) +
        (a.assetTag ? '<br><span class="asset-tag-label">' + escapeHtml(a.assetTag) + '</span>' : '') +
      '</td>' +
      '<td class="mono">' + ipCellHTML(a) + '</td>' +
      '<td>' + assetNetworkCellHTML(a) + '</td>' +
      '<td>' + _copyableCell(a.serialNumber) + '</td>' +
      '<td>' + assetTypeBadge(a.assetType, a) + '</td>' +
      '<td>' + assetStatusBadge(a) + '</td>' +
      '<td>' + assetMonitorBadge(a) + '</td>' +
      '<td>' + assetMonitoredViaCell(a) + '</td>' +
      '<td>' + escapeHtml(a.location || a.learnedLocation || "-") + '</td>' +
      '<td>' + escapeHtml(a.description || "-") + '</td>' +
      '<td>' + escapeHtml((a.tags || []).join(", ") || "-") + '</td>' +
      '<td>' + _copyableCell(a.assetTag) + '</td>' +
      '<td>' + escapeHtml(a.manufacturer || "-") + '</td>' +
      '<td>' + escapeHtml(a.model || "-") + '</td>' +
      '<td>' + escapeHtml([a.os, a.osVersion].filter(Boolean).join(" ") || "-") + '</td>' +
      '<td>' + macCellHTML(a) + '</td>' +
      '<td>' + escapeHtml(a.assignedTo || "-") + '</td>' +
      '<td>' + _copyableCell(a.purchaseOrder) + '</td>' +
      '<td>' + _copyableCell(a.dnsName) + '</td>' +
      '<td class="mono">' + _coordCell(a.latitude) + '</td>' +
      '<td class="mono">' + _coordCell(a.longitude) + '</td>' +
      '<td>' + (a.lastSeen ? formatDate(a.lastSeen) : "-") + '</td>' +
      '</tr>';
  }).join("");
  _wireHoverTriggersIn(tbody);
  _assetsUpdateSelectAll();
  _renderAssetsPageControls();
}

// Capture lightweight metadata for a selected asset from the current page, so
// the bulk bar's quarantine/release button logic still works after the operator
// pages away from the row (selection spans pages; _assetsData does not).
function _assetsRememberSelection(id) {
  var a = _assetsData.find(function (x) { return x.id === id; });
  if (a) _assetsSelectedMeta[id] = { status: a.status, assetType: a.assetType };
}

function _assetsUpdateSelectAll() {
  // Pair the bulk bar's count with WHICH rows it means. Here rather than at
  // each call site because this already runs after a render, a deselect-all
  // and a single-row change.
  syncSelectedRows(document.getElementById("assets-tbody"));
  var allCbs = document.querySelectorAll("#assets-tbody input.row-cb");
  var checked = Array.from(allCbs).filter(function (cb) { return cb.checked; }).length;
  var sa = document.getElementById("assets-select-all");
  if (!sa) return;
  sa.checked = allCbs.length > 0 && checked === allCbs.length;
  sa.indeterminate = checked > 0 && checked < allCbs.length;
}

function _assetsUpdateBulkBar() {
  var bar = document.getElementById("assets-bulk-bar");
  if (!bar) return;
  var count = _assetsSelected.size;
  // Always visible; neutral (idle) until something is selected, accent outline
  // once it is. Action buttons are disabled while idle. (Matches Notifications.)
  bar.classList.toggle("bulk-bar-idle", count === 0);
  var el = bar.querySelector(".bulk-bar-count");
  if (el) el.textContent = count === 0 ? "No assets selected" : (count + " selected");
  // Disable every bulk action while nothing is selected.
  ["assets-bulk-deselect-btn", "assets-bulk-type-btn", "assets-bulk-state-btn",
   "assets-bulk-monitor-btn", "assets-bulk-tags-btn", "assets-bulk-delete-btn",
   "assets-bulk-merge-btn", "assets-bulk-agent-btn",
   "assets-bulk-maint-btn",
   "assets-bulk-quarantine-btn", "assets-bulk-unquarantine-btn"
  ].forEach(function (id) { var b = document.getElementById(id); if (b) b.disabled = count === 0; });
  // Rule 141 (e): a bulk edit refuses the whole selection when one row is out
  // of this caller's reach, so the verbs grey out with the reason instead of
  // 403ing after the click. Full Read-Write never greys here.
  if (count > 0 && !permAtLeast("assets", "fullwrite")) {
    var outOfScope = 0, outOfQScope = 0, outOfMScope = 0;
    _assetsData.forEach(function (r) {
      if (!_assetsSelected.has(r.id)) return;
      if (r.canEdit === false) outOfScope++;
      if (r.canQuarantine === false) outOfQScope++;
      if (r.canMaintain === false) outOfMScope++;
    });
    var reason = function (n) { return n + " of the selected device" + (n === 1 ? " is" : "s are") + " not yours to change (not added by you, and carrying none of your tags)"; };
    [["assets-bulk-type-btn", outOfScope], ["assets-bulk-state-btn", outOfScope], ["assets-bulk-monitor-btn", outOfScope],
     ["assets-bulk-tags-btn", outOfScope], ["assets-bulk-delete-btn", outOfScope], ["assets-bulk-edit-btn", outOfScope],
     ["assets-bulk-quarantine-btn", outOfQScope], ["assets-bulk-unquarantine-btn", outOfQScope], ["assets-bulk-maint-btn", outOfMScope]]
      .forEach(function (pair) {
        var b = document.getElementById(pair[0]);
        if (!b || !pair[1]) return;
        b.disabled = true;
        b.title = reason(pair[1]);
      });
  }

  // Compare needs at least two assets to overlay, so it stays VISIBLE and greys
  // out below two — a button that only appears once the right number of rows is
  // ticked is a verb nobody discovers. Available to any role that can view
  // assets — comparing telemetry is read-only. Above _CMP_MAX_ASSETS it greys
  // out too, but dim YELLOW rather than plain grey, so "too many" reads apart
  // from "not enough" (red is taken by Delete).
  var bCompare = document.getElementById("assets-bulk-compare-btn");
  if (bCompare) {
    var cmpMax = typeof _CMP_MAX_ASSETS === "number" ? _CMP_MAX_ASSETS : 10;
    var overCap = count > cmpMax;
    bCompare.disabled = count < 2 || overCap;
    bCompare.classList.toggle("btn-warning", overCap);
    bCompare.classList.toggle("btn-secondary", !overCap);
    bCompare.title = count < 2
      ? "Select two or more assets to compare their telemetry"
      : overCap
        ? "Compare supports up to " + cmpMax + " assets — " + count + " selected"
        : "Compare telemetry of the selected assets";
  }

  // Edit opens the single-asset edit modal, so it stays visible but greys out
  // unless exactly one asset is selected (data-manage-assets already hides it
  // for roles that can't edit).
  var bEdit = document.getElementById("assets-bulk-edit-btn");
  if (bEdit) {
    bEdit.disabled = count !== 1;
    bEdit.title = count > 1
      ? "Select a single asset to edit"
      : "Edit the selected asset";
  }

  // Upgrade (group firmware upgrade, rule 122) owns its rule in
  // assets-firmware-group.js: grey for a non-Fortinet selection, RED when the
  // selection spans more than one controlling FortiGate (a server read,
  // debounced), normal when it is one FortiGate's fleet.
  if (window.PolarisFirmwareGroup) window.PolarisFirmwareGroup.syncButton();

  // Merge is pairwise — show only when exactly two assets are selected, and
  // only to admins (same gate as the Sources-tab "Merge asset..." button).
  var bMerge = document.getElementById("assets-bulk-merge-btn");
  if (bMerge) bMerge.style.display = count === 2 && canMergeAssets() ? "" : "none";

  // Show quarantine/release buttons only to roles holding assetsQuarantine —
  // its own function key, NOT `assets` (see canQuarantineAssets() in app.js).
  // Determine which buttons are relevant based on the statuses of the selected
  // assets. Infrastructure types (firewall/switch/access_point) are excluded
  // from the Quarantine button — they can't be quarantined — but stay eligible
  // for Release in case one was quarantined before this guard was added.
  //
  // This `if` is load-bearing: without the key the block never runs, so the
  // buttons keep the display:none that the data-quarantine-assets applier set
  // at page load. Removing the guard would let a selection re-show them.
  if (canQuarantineAssets()) {
    // Use the remembered selection metadata (not _assetsData, which is only the
    // current page) so the buttons stay correct across paged-away selections.
    var selected = Object.keys(_assetsSelectedMeta)
      .filter(function (id) { return _assetsSelected.has(id); })
      .map(function (id) { return _assetsSelectedMeta[id]; });
    var hasQuarantineable = selected.some(function (a) {
      return a.status !== "quarantined"
        && a.assetType !== "firewall"
        && a.assetType !== "switch"
        && a.assetType !== "access_point";
    });
    var hasQuarantined = selected.some(function (a) { return a.status === "quarantined"; });
    var bQ  = document.getElementById("assets-bulk-quarantine-btn");
    var bUQ = document.getElementById("assets-bulk-unquarantine-btn");
    // Quarantine (but not Release) additionally needs push enabled on some
    // integration — see _quarantinePushAvailable().
    if (bQ)  bQ.style.display  = count > 0 && hasQuarantineable && _quarantinePushAvailable() ? "" : "none";
    if (bUQ) bUQ.style.display = count > 0 && hasQuarantined    ? "" : "none";
  }
}

// The selection's verbs for the row menu, read off the (never shown) bulk bar
// rather than re-derived, so the menu can never offer what the bar's rules
// hide (a role gate, Merge outside a pair, Quarantine with nothing
// quarantineable) or enable what they grey out (Compare under two, Upgrade on
// a non-Fortinet pick) — _assetsUpdateBulkBar, hideAdminOnlyElements and
// PolarisFirmwareGroup.syncButton stay the one decider. Each item clicks its
// bar button, so the verb runs its own handler over _assetsSelected. A
// dropdown (Type / State / Monitoring) becomes a menu that opens a menu at the
// same point.
//
// `single`: the verbs a ONE-row menu adds beside its own. Dropped there: what
// needs several rows (Compare, Merge), what the row menu already has (Edit,
// Quarantine / Release, Delete — its own copies act on the row), clearing a
// one-row selection, and any verb the bar has greyed out (Upgrade on a
// non-Fortinet asset is not a verb for that asset at all). The several-row
// menu is the bar entire in three groups — the verbs, then quarantine and
// delete, then Clear selection — greyed ones kept with the bar's reason as
// their title.
var _ASSETS_BULK_MENU = {
  "assets-bulk-compare-btn": { label: "Compare", multiOnly: true },
  "assets-bulk-merge-btn": { label: "Merge", multiOnly: true },
  "assets-bulk-type-btn": { label: "Change type" },
  "assets-bulk-state-btn": { label: "Change state" },
  "assets-bulk-monitor-btn": { label: "Monitoring" },
  "assets-bulk-tags-btn": { label: "Tags" },
  "assets-bulk-edit-btn": { skip: true },
  "assets-bulk-agent-btn": { label: "Deploy agent" },
  "assets-bulk-maint-btn": { label: "Maintenance" },
  "assets-bulk-firmware-btn": { label: "Upgrade firmware" },
  "assets-bulk-quarantine-btn": { label: "Quarantine", group: 1, danger: true, multiOnly: true },
  "assets-bulk-unquarantine-btn": { label: "Release quarantine", group: 1, multiOnly: true },
  "assets-bulk-delete-btn": { label: "Delete", group: 1, danger: true, multiOnly: true },
  "assets-bulk-deselect-btn": { label: "Clear selection", group: 2, multiOnly: true },
};
function _assetsBulkMenuItems(bar, anchor, at, single) {
  if (!bar) return [];
  function shown(el) {
    for (var n = el; n && n !== bar; n = n.parentElement) {
      if (n.hidden || (n.style && n.style.display === "none")) return false;
    }
    return true;
  }
  function label(btn) { return (btn.textContent || "").replace(/\s*▾\s*$/, "").trim(); }
  var groups = [[], [], []];
  Array.prototype.forEach.call(bar.querySelectorAll("button.btn"), function (btn) {
    var spec = _ASSETS_BULK_MENU[btn.id];
    if (!spec || spec.skip || !shown(btn)) return;
    if (single && (spec.multiOnly || btn.disabled)) return;
    var item = { label: spec.label, title: btn.title || undefined, disabled: !!btn.disabled };
    if (spec.danger && !item.disabled) item.danger = true;
    var wrap = btn.parentElement && btn.parentElement.classList.contains("btn-dropdown-wrap") ? btn.parentElement : null;
    var menu = wrap ? wrap.querySelector(".btn-dropdown-menu") : null;
    if (menu) {
      item.onSelect = function () {
        var sub = [];
        Array.prototype.forEach.call(menu.children, function (c) {
          if (c.classList.contains("dropdown-heading")) { sub.push({ heading: c.textContent }); return; }
          if (c.tagName !== "BUTTON" || !shown(c)) return;
          sub.push({ label: label(c), disabled: !!c.disabled, onSelect: function () { c.click(); } });
        });
        showRowMenu(anchor, sub, { label: spec.label, menuAt: at });
      };
    } else {
      item.onSelect = function () { btn.click(); };
    }
    groups[spec.group || 0].push(item);
  });
  var items = [];
  groups.forEach(function (g) {
    if (!g.length) return;
    if (items.length) items.push({ separator: true });
    items = items.concat(g);
  });
  if (items.length && !single) items.unshift({ heading: _assetsSelected.size + " selected" });
  return items;
}

// View Lease cell. Renders a button that opens a lightweight reservation
// slide-over right on the Assets page — the user gets the lease details for
// this one IP without losing their place in the asset list. The footer's
// "Open in Networks" button is the escape hatch when they want the full
// subnet IP table. Hidden when the asset has no IP or no non-deprecated
// containing subnet — there is nothing to look at.
// Network column (hidden by default): the IPAM network the primary IP sits in
// — the same most-specific containing subnet ipContext resolves for View
// Lease. Name first, CIDR on hover; a network with no name shows its CIDR.
function assetNetworkCellHTML(a) {
  var ctx = a && a.ipContext;
  if (!ctx || !ctx.subnetCidr) return "-";
  var name = (ctx.subnetName || "").trim();
  return '<span title="' + escapeHtml(ctx.subnetCidr) + '">' + escapeHtml(name || ctx.subnetCidr) + '</span>';
}

function viewAssetLease(id) {
  var a = (_assetsData || []).find(function (x) { return x.id === id; });
  // Fall back to the asset currently shown in the details slide-over — it
  // carries a fresh ipContext and covers the case where the asset was opened
  // via deep-link rather than the table (so it isn't in _assetsData).
  if ((!a || !a.ipContext) && _currentAssetForRefresh && _currentAssetForRefresh.id === id) {
    a = _currentAssetForRefresh;
  }
  if (!a || !a.ipAddress || !a.ipContext || !a.ipContext.subnetId) return;
  openLeasePanel(a);
}

// ─── Lightweight reservation slide-over (Assets page) ─────────────────────
//
// Shows just the lease details for one IP — no full subnet table. Used by
// the "View Lease" row action. Reuses the asset details slide-over CSS.
// When the asset has no active reservation we still open the panel and tell
// the user the IP is unreserved; the footer link to Networks is always
// present for operators who need the full panel.

function _ensureLeasePanelDOM() {
  if (document.getElementById("lease-panel-overlay")) return;
  // Skeleton + backdrop / close / Escape / resize wiring: buildSlideover (app.js).
  buildSlideover({
    id: "lease-panel",
    title: "Lease",
    bodyHTML: '<p class="empty-state" style="padding:1rem 1.25rem">Loading…</p>',
    footer: true,
    close: closeLeasePanel,
    resizeKey: "polaris.panel.width.lease",
  });
}

function closeLeasePanel() {
  var ov = document.getElementById("lease-panel-overlay");
  if (ov) ov.classList.remove("open");
}

async function openLeasePanel(asset) {
  _ensureLeasePanelDOM();
  var titleEl  = document.getElementById("lease-panel-title");
  var metaEl   = document.getElementById("lease-panel-meta");
  var bodyEl   = document.getElementById("lease-panel-body");
  var footerEl = document.getElementById("lease-panel-footer");
  var ctx = asset.ipContext || {};

  titleEl.textContent = "Lease — " + asset.ipAddress;
  metaEl.textContent = (asset.hostname || asset.assetTag || asset.id) + (ctx.subnetCidr ? "  ·  " + ctx.subnetCidr : "");
  bodyEl.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">Loading…</p>';
  var openInNetworks =
    '<button class="btn btn-sm btn-secondary" id="btn-lease-open-networks">Open in Networks</button>';
  footerEl.innerHTML =
    openInNetworks +
    ' <button class="btn btn-sm btn-secondary" id="btn-lease-close">Close</button>';
  raiseSlideover(document.getElementById("lease-panel-overlay"));   // DOM order is stacking order
  revealOverlay(document.getElementById("lease-panel-overlay"));
  document.getElementById("btn-lease-close").addEventListener("click", closeLeasePanel);
  // The network slide-over, in place and scrolled to this address
  // (PolarisPanels loads ip-panel.js here on demand).
  document.getElementById("btn-lease-open-networks").addEventListener("click", function () {
    PolarisPanels.openNetwork(ctx.subnetId, { focusIp: asset.ipAddress, subnetCidr: ctx.subnetCidr || undefined });
  });

  if (!ctx.reservation || !ctx.reservation.id) {
    bodyEl.innerHTML =
      '<div style="padding:1rem 1.25rem">' +
        '<p style="margin:0 0 0.5rem 0">No active reservation for <code>' + escapeHtml(asset.ipAddress) + '</code>.</p>' +
        '<p class="empty-state" style="margin:0">This IP sits inside <strong>' + escapeHtml(ctx.subnetCidr || 'its subnet') + '</strong> but has no Polaris reservation. Use <em>Open in Networks</em> to reserve it.</p>' +
      '</div>';
    return;
  }

  try {
    var r = await api.reservations.get(ctx.reservation.id);
    bodyEl.innerHTML = _renderLeaseBody(r, ctx);
  } catch (err) {
    bodyEl.innerHTML =
      '<div style="padding:1rem 1.25rem">' +
        '<p class="empty-state" style="margin:0">Failed to load reservation: ' + escapeHtml(err && err.message ? err.message : String(err)) + '</p>' +
      '</div>';
  }
}

function _renderLeaseBody(r, ctx) {
  function row(label, value) {
    if (value === null || value === undefined || value === '') return '';
    return '<div style="display:grid;grid-template-columns:140px 1fr;gap:0.5rem;padding:0.35rem 0;border-bottom:1px solid var(--color-border)">' +
             '<div style="color:var(--color-text-secondary);font-size:0.85rem">' + escapeHtml(label) + '</div>' +
             '<div>' + value + '</div>' +
           '</div>';
  }
  var pushBadge = '';
  if (r.pushStatus) {
    var cls = r.pushStatus === 'synced' ? 'badge-success' : (r.pushStatus === 'drift' ? 'badge-warning' : 'badge-secondary');
    pushBadge = '<span class="badge ' + cls + '">' + escapeHtml(r.pushStatus) + '</span>';
  }
  return '<div style="padding:1rem 1.25rem">' +
    row('IP Address',   '<code>' + escapeHtml(r.ipAddress || '') + '</code>') +
    row('Status',       statusBadge(r.status)) +
    row('Source',       '<span class="badge">' + escapeHtml(r.sourceType || 'manual') + '</span>') +
    row('Hostname',     r.hostname     ? escapeHtml(r.hostname)     : '<span class="empty-state">—</span>') +
    row('MAC Address',  r.macAddress   ? '<code>' + escapeHtml(r.macAddress) + '</code>' : '<span class="empty-state">—</span>') +
    row('Owner',        r.owner        ? escapeHtml(r.owner)        : '<span class="empty-state">—</span>') +
    row('Project Ref',  r.projectRef   ? escapeHtml(r.projectRef)   : '') +
    row('Expires',      r.expiresAt    ? formatDate(r.expiresAt)    : '<span class="empty-state">never</span>') +
    row('Created By',   r.createdBy    ? escapeHtml(r.createdBy)    : '') +
    row('Subnet',       escapeHtml(ctx.subnetCidr || '')) +
    (pushBadge ? row('FortiGate Push', pushBadge + (r.pushedAt ? ' <span style="color:var(--color-text-secondary);font-size:0.8rem">' + formatDate(r.pushedAt) + '</span>' : '')) : '') +
    row('Notes',        r.notes        ? '<div style="white-space:pre-wrap">' + escapeHtml(r.notes) + '</div>' : '') +
  '</div>';
}

// ─── Quarantine push availability ───────────────────────────────────────────
//
// Quarantine push is per-integration (`config.pushQuarantine`, the DHCP-Push-
// style toggle on the Quarantine Push tab of the FortiManager / FortiGate
// integration) and OFF by default. With it off, quarantineAsset() skips every
// sighting's integration, lands on zero targets and throws a 502 reading
// "0/0 FortiGate(s) accepted the push" — a device-shaped failure for what is
// really an unconfigured feature. So the verbs are hidden instead of offered:
// GET /assets/quarantine-availability answers whether ANY enabled Fortinet
// integration carries the toggle.
//
// `null` means "not answered yet or the probe failed" and reads as AVAILABLE:
// fail-open, because the fetch resolves in the first moment of the page while
// the affordances are only built on a click/panel-open, and hiding a verb an
// operator needs on a transient error is worse than surfacing the push's own
// error. Release is never gated — releaseQuarantine unpushes from the targets
// recorded on the asset without consulting the toggle, so an asset quarantined
// before push was switched off must stay releasable.
var _qtnPushEnabled = null;

function _quarantinePushAvailable() { return _qtnPushEnabled !== false; }

if (typeof userReady !== "undefined" && userReady && typeof userReady.then === "function") {
  userReady.then(function () {
    // Only roles that can act on it ask — the route is read-gated on the same
    // key, so a viewer without it would just collect a 403 per page load.
    if (!canQuarantineAssets()) return null;
    return api.assets.quarantineAvailability().then(function (r) {
      _qtnPushEnabled = !!(r && r.pushEnabled);
    });
  }).catch(function () { _qtnPushEnabled = null; });
}

/**
 * Quarantine verbs for one asset row, as row-context-menu items (0 or 1 of them).
 *
 * Gated on `assetsQuarantine`, NOT `assets` — quarantine is its own function key
 * and every /assets/:id/quarantine* route checks it, so gating on
 * canManageAssets() here would offer the verb to operators whose click can only
 * 403. (The pre-menu version of this function did exactly that; it was never
 * wired up, so the mismatch never shipped.)
 *
 * The rest of the conditions are unchanged:
 *  - No MAC → nothing to block, so no FortiGate target to push to.
 *  - Already quarantined → offer Release, whatever the asset type, so a
 *    misclassified quarantine can always be undone.
 *  - Fortinet infrastructure (firewall / switch / access point) can never be
 *    quarantined: blocking the device that enforces the block would lock the
 *    operator out of their own network.
 *  - No enabled Fortinet integration has quarantine push turned on → nothing
 *    to push to, so no verb (_quarantinePushAvailable).
 */
/**
 * Every verb offered for one asset row, in menu order:
 *   Open · Edit · — · Quarantine|Release · — · Delete
 *
 * Open is unconditional (it is what clicking the hostname always did), so the
 * menu is never empty and a read-only viewer still gets a working affordance.
 * Edit and Delete ride `assets:write`; the quarantine pair rides its own
 * `assetsQuarantine` key, so a role holding one and not the other sees exactly
 * the verbs it can actually use. Separators are pushed only immediately before
 * a group that has items, so no divider can ever render with nothing after it.
 */
/**
 * The "+ Add Asset(s)" menu's rows.
 *
 * Each row is gated by the key ITS OWN routes check, per polaris-ui-canon -> "Row
 * context menu": the hand-typed form is `assets:write` (POST /assets), while a
 * Discovery is the separate `networkScan` key (an active sweep of
 * operator-supplied ranges is a capability an admin may want to withhold from
 * someone who may still edit inventory).
 *
 * A row the role can never reach is OMITTED rather than rendered disabled.
 * That template's disabled-with-a-reason rule is for a verb that can't apply
 * *right now*; a missing grant is not a transient state, and a permanently
 * greyed row only advertises something the operator cannot be given.
 *
 * Pure: reads the permission matrix and nothing else, so the three interesting
 * shapes are unit-testable without the DOM.
 */
function _addAssetMenuItems() {
  var items = [];
  if (canManageAssets()) {
    items.push({
      label: "Single asset",
      title: "Add one asset by hand",
      onSelect: function () { openCreateModal(); },
    });
  }
  var D = window.PolarisAssetDiscovery;
  if (D && permAtLeast("networkScan", "write")) {
    items.push({
      label: "New discovery",
      title: "Scan IP ranges for devices that answer, then choose what to add",
      onSelect: function () { D.open(); },
    });
  }
  if (D && permAtLeast("networkScan", "read")) {
    items.push({
      label: "Saved discoveries",
      title: "Re-run, edit or export a saved Discovery",
      onSelect: function () { D.openList(); },
    });
  }
  return items;
}

/**
 * The row menu's remote-access verbs — the same Open HTTPS / Open RDP / Open
 * SSH the asset slide-over header carries (`_managementAccessButtonsHTML`), so
 * an operator can reach a device's management surface without opening it first.
 *
 * Gated identically to the slide-over, through the ONE shared
 * `_assetMgmtAccess`: a Fortinet device offers only the protocols its captured
 * `allowaccess` permits (both optimistically when the list could not be read —
 * the best-effort switch path, `protocols == null`), and a server offers RDP +
 * SSH off its TYPE, nothing having ever read a Windows or Linux host's access
 * config. A row with no management surface — every endpoint, every asset from
 * a non-Fortinet discovery with no inferable type — contributes nothing, so
 * its menu is unchanged.
 *
 * RDP and SSH are ONE item each here, not the header's split buttons: a row
 * menu is a flat list with no room for a caret, so each performs the
 * operator's stored default (`_sshAction()` / `_rdpAction()`) and leaves the
 * delivery and default-user choices on the slide-over that owns them.
 */
function _managementAccessMenuItems(a) {
  var info = _assetMgmtAccess(a);
  if (!info) return [];
  var items = [];
  if (info.showHttps) {
    items.push({
      label: "Open HTTPS",
      title: "Open https://" + info.mgmtIp + " in a new tab",
      onSelect: function () { window.open("https://" + info.mgmtIp, "_blank", "noopener"); },
    });
  }
  if (info.showRdp) {
    items.push({
      label: "Open RDP",
      title: _rdpAction() === "copy"
        ? "Copy an mstsc command for " + info.mgmtIp
        : "Open a Remote Desktop session to " + info.mgmtIp,
      onSelect: function () { _doRdpLaunch(info.mgmtIp, _rdpAction()); },
    });
  }
  if (info.showSsh) {
    items.push({
      label: "Open SSH",
      title: _sshAction() === "copy"
        ? "Copy an ssh command for " + info.mgmtIp
        : "Open an SSH session to " + info.mgmtIp,
      onSelect: function () { _doSshLaunch(info.mgmtIp, _sshAction()); },
    });
  }
  return items;
}

// `extra`: the selection verbs (_assetsBulkMenuItems, single mode) a right
// click adds as their own group after the remote-access verbs.
function _assetMenuItems(a, extra) {
  var items = [{ label: "Open", primary: true, onSelect: function () { openViewModal(a.id); } }];
  // Rule 141 (e): Edit / Delete only where this caller's click succeeds.
  if (_canEditAsset(a)) {
    items.push({ label: "Edit", onSelect: function () { openEditModal(a.id); } });
  }
  var mgmt = _managementAccessMenuItems(a);
  if (mgmt.length) {
    items.push({ separator: true });
    mgmt.forEach(function (m) { items.push(m); });
  }
  if (extra && extra.length) {
    items.push({ separator: true });
    extra.forEach(function (x) { items.push(x); });
  }
  var quarantine = _quarantineMenuItems(a);
  if (quarantine.length) {
    items.push({ separator: true });
    quarantine.forEach(function (q) { items.push(q); });
  }
  if (_canEditAsset(a)) {
    items.push({ separator: true });
    items.push({
      label: "Delete",
      danger: true,
      onSelect: function () { confirmDelete(a.id, a.hostname || "-"); },
    });
  }
  return items;
}

function _quarantineMenuItems(a) {
  if (!canQuarantineAssets()) return [];
  if (!a.macAddress && (!a.macAddresses || !a.macAddresses.length)) return [];
  if (a.status === 'quarantined') {
    return [{
      label: "Release quarantine",
      title: "Removes the MAC block from the FortiGate(s) it was pushed to",
      onSelect: function () { releaseAssetQuarantine(a.id); },
    }];
  }
  if (a.assetType === 'firewall' || a.assetType === 'switch' || a.assetType === 'access_point') return [];
  // No enabled integration has quarantine push turned on — the verb can only
  // 502 with "0/0 FortiGate(s) accepted the push".
  if (!_quarantinePushAvailable()) return [];
  return [{
    label: "Quarantine",
    danger: true,
    title: "Pushes a MAC block to the FortiGate(s) that have seen this asset",
    onSelect: function () { quarantineAssetRow(a.id); },
  }];
}

/**
 * The one definition of the quarantine-reason dialog, shared by the three
 * desktop paths that can start a quarantine — the row menu, the bulk bar, and
 * the asset-details Quarantine tab. They each carried their own `window.prompt`
 * with slightly different wording; centralising it keeps the warning, the
 * character cap and the cancel contract identical wherever an operator lands.
 *
 * Resolves to the reason, `""` when left blank (the field is optional), or
 * `null` if cancelled — the same null-vs-empty distinction `window.prompt` had,
 * which every caller branches on to decide whether to push at all.
 *
 * showPrompt rather than window.prompt because the browser dialog is unstyled,
 * unavailable in the mobile PWA, and suppressed outright by some browsers — for
 * a containment action that means the operator silently cannot act.
 */
function _promptQuarantineReason(assetCount) {
  var many = assetCount > 1;
  return showPrompt(
    many
      ? "This pushes a MAC block for " + assetCount + " assets to every FortiGate that has seen each one, cutting them off the network."
      : "This pushes a MAC block to every FortiGate that has seen this asset, cutting it off the network.",
    {
      title: many ? "Quarantine " + assetCount + " assets" : "Quarantine asset",
      label: "Reason (optional)",
      placeholder: "e.g. malware alert from SIEM",
      okLabel: many ? "Quarantine " + assetCount : "Quarantine",
      danger: true,
      multiline: true,
      maxLength: 500, // matches the route's z.string().max(500)
      help: "Recorded on the audit Event so the next operator knows why.",
    },
  );
}

async function quarantineAssetRow(id) {
  var reason = await _promptQuarantineReason(1);
  if (reason === null) return; // cancelled
  try {
    var result = await api.assets.quarantine(id, reason || undefined);
    showToast(result.message || 'Asset quarantined');
    loadAssets();
  } catch (err) {
    showToast(err.message || 'Quarantine failed', 'error');
  }
}

async function releaseAssetQuarantine(id) {
  var ok = await showConfirm('Release quarantine on this asset?');
  if (!ok) return;
  try {
    var result = await api.assets.unquarantine(id);
    showToast(result.message || 'Quarantine released');
    loadAssets();
  } catch (err) {
    showToast(err.message || 'Release failed', 'error');
  }
}

// Admin-only Dependency Test simulation. Backend route is gated; we duplicate
// the gate here for UX so non-admins never see the trigger button. Default
// duration matches the backend default (30 min); the prompt accepts 1..240.
async function startDependencyTestPrompt(id) {
  if (typeof canSimulateDependencyDown !== "function" || !canSimulateDependencyDown()) return;
  var raw = window.prompt(
    "Simulate this asset going DOWN for how many minutes? (1–240)\n\n" +
    "Children with this asset in their dependency chain will be marked Dep. Suppressed " +
    "as if it had really failed. Real probes against this asset keep running. The " +
    "simulation auto-expires at the deadline.",
    "30"
  );
  if (raw === null) return; // cancelled
  var minutes = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) {
    showToast("Duration must be a whole number between 1 and 240 minutes", "error");
    return;
  }
  try {
    await api.assets.startDependencyTest(id, minutes);
    showToast("Dependency Test started — auto-clears in " + minutes + " min");
    // Refresh both the list (Status pill flips) and the open details panel
    // (the Dep Test button flips to "Clear" + the dep-tree block reflects).
    await loadAssets();
    await openViewModal(id);
  } catch (err) {
    showToast(err.message || "Failed to start Dependency Test", "error");
  }
}

async function clearDependencyTestNow(id) {
  if (typeof canSimulateDependencyDown !== "function" || !canSimulateDependencyDown()) return;
  var ok = await showConfirm("Clear the Dependency Test on this asset now? Children will resume normal monitoring within ~60 seconds.");
  if (!ok) return;
  try {
    await api.assets.clearDependencyTest(id);
    showToast("Dependency Test cleared");
    await loadAssets();
    await openViewModal(id);
  } catch (err) {
    showToast(err.message || "Failed to clear Dependency Test", "error");
  }
}

// Phase 3a recovery action — admin-only Split button on each Sources card.
// Detaches the chosen source onto a freshly-created asset; downstream FKs
// (monitoring, IP history, sightings, quarantine) stay on the original.
async function splitAssetSource(assetId, sourceId, sourceLabel) {
  var ok = await showConfirm(
    'Split "' + sourceLabel + '" off onto a new asset?\n\n' +
    'A new asset will be created with this source\'s data only. ' +
    'Monitoring, IP history, sightings, and quarantine settings stay on the current asset.\n\n' +
    'Use this to undo a bad merge — the new asset starts clean.'
  );
  if (!ok) return;
  try {
    var result = await api.assets.splitSource(assetId, sourceId);
    showToast('Source split — new asset created');
    // Refresh the assets table and re-open the asset details modal so the
    // operator can verify the moved source landed on the new row.
    await loadAssets();
    if (result && result.newAssetId) {
      window.location.hash = 'view=asset:' + result.newAssetId;
      openViewModal(result.newAssetId);
    }
  } catch (err) {
    showToast(err.message || 'Split failed', 'error');
  }
}

// ─── Asset merge (admin) ────────────────────────────────────────────────────
// The merge modal moved to public/js/asset-merge-modal.js so the Conflicts
// slide-over on the Events page can open it too (events.html does not load
// this file). `openAssetMergeModal` is global from there; the bulk-bar entry
// points below stay here because they read this page's selection state.

// This page's `onMerged` — the absorbed row no longer exists, so it leaves the
// selection, the list reloads, and the survivor re-opens so the operator sees
// the combined record. The Conflicts panel supplies a different one.
function openAssetMergeFromAssetsPage(assetId, preselectOtherId) {
  openAssetMergeModal(assetId, preselectOtherId, {
    onMerged: async function (result) {
      _assetsSelected.delete(result.absorbedId);
      delete _assetsSelectedMeta[result.absorbedId];
      _assetsUpdateBulkBar();
      await loadAssets();
      window.location.hash = 'view=asset:' + result.survivorId;
      openViewModal(result.survivorId);
    }
  });
}

// Bulk-bar Merge — pairwise merge of the two selected assets. Reuses the
// Sources-tab merge modal with the target pre-selected, so the search step is
// skipped and the comparison renders immediately. The button only shows when
// exactly two assets are selected (see _assetsUpdateBulkBar).
function bulkMergeSelectedAssets() {
  if (!canMergeAssets()) return;
  var ids = Array.from(_assetsSelected);
  if (ids.length !== 2) {
    showToast("Select exactly two assets to merge", "error");
    return;
  }
  openAssetMergeFromAssetsPage(ids[0], ids[1]);
}

// ─── Bulk maintenance — schedule a window over the selected assets ──────────
// Opens the same Maintenance modal the toolbar button opens, with the
// selection pinned as the schedule's explicit assetIds. Nothing is created
// until the operator saves, so this is the named/recurring counterpart to the
// status pill's single-asset ad-hoc window.
//
// MAINT_ASSET_IDS_MAX mirrors the server's `assetIds` cap in
// src/api/routes/maintenanceSchedules.ts — refuse here with the number rather
// than let the save 400 after the operator has filled the whole form in.
var MAINT_ASSET_IDS_MAX = 500;

function bulkMaintenanceSelectedAssets() {
  if (typeof canManageMaintenance !== "function" || !canManageMaintenance()) return;
  if (typeof openMaintenanceModal !== "function") return;
  var ids = Array.from(_assetsSelected);
  if (!ids.length) return;
  if (ids.length > MAINT_ASSET_IDS_MAX) {
    showToast("A schedule can pin at most " + MAINT_ASSET_IDS_MAX + " devices (" + ids.length +
      " selected) — narrow the selection, or target them with filter rules instead.", "error");
    return;
  }
  openMaintenanceModal({ assetIds: ids });
}

// ─── Bulk agent deploy — install the Polaris Agent on every selected asset ──
// One modal collects the SSH / WinRM credentials + arch; the server resolves
// OS platform + transport per asset (Windows → WinRM with SSH fallback,
// everything else → SSH) and reports ineligible assets back as skips
// (agent in any state but "failed", hypervisor, Fortinet source, unreachable,
// no matching credential). An asset whose agent install FAILED is retried in
// place with this batch's credentials — the per-asset Retry, folded into the
// bulk verb. Backend: POST /assets/bulk-agent-install (agentInstallService.
// bulkInstallAgents) — installs run in a bounded server-side pool; progress
// shows per-asset on each System tab exactly like a manual install.
function openBulkAgentDeployModal() {
  // assets=fullwrite, not assets=write — see canDeployAgent() in app.js.
  if (!canDeployAgent()) return;
  var ids = Array.from(_assetsSelected);
  if (!ids.length) return;

  Promise.all([_ensureCredentials(), _ensureAgentInstallScripts()]).then(function () {
    var sshOpts   = (_credentialCache.list || []).filter(function (c) { return c.type === "ssh"; });
    var winrmOpts = (_credentialCache.list || []).filter(function (c) { return c.type === "winrm"; });
    function credOptions(list, noneLabel) {
      if (list.length === 0) return '<option value="">— No credentials of this type —</option>';
      return '<option value="">' + noneLabel + '</option>' +
        list.map(function (c) {
          return '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(c.name) + '</option>';
        }).join("");
    }

    // Per-OS install-method picker — only shown for OSes that actually have
    // more than one vetted variant (keeps the common single-variant case
    // clutter-free). The submit handler reads whichever selects are present.
    var osLabels = { linux: "Linux", darwin: "macOS", windows: "Windows" };
    var scriptRows = ["linux", "darwin", "windows"].filter(_agentScriptHasChoicesFor).map(function (os) {
      return '<div class="form-group">' +
        '<label for="bulk-agent-script-' + os + '">Install method — ' + osLabels[os] + '</label>' +
        '<select id="bulk-agent-script-' + os + '" data-os="' + os + '">' + _agentScriptOptionsFor(os) + '</select>' +
        '</div>';
    }).join("");

    var body =
      '<p style="color:var(--color-text-secondary)">Install the Polaris Agent on the <strong>' + ids.length +
        '</strong> selected asset' + (ids.length === 1 ? '' : 's') + '. Each asset\'s OS is inferred from its ' +
        'discovered OS field: Windows hosts use the WinRM credential (SSH as fallback), everything else uses the SSH credential. ' +
        'An asset whose last agent install <strong>failed</strong> is retried with the credentials chosen here. ' +
        'Assets with an agent in any other state, hypervisors, Fortinet-discovered devices, and assets with no reachable address are skipped automatically.</p>' +
      '<div class="form-group" style="margin-top:0.75rem">' +
        '<label for="bulk-agent-cred-ssh">SSH credential (Linux / macOS, Windows fallback)</label>' +
        '<select id="bulk-agent-cred-ssh">' + credOptions(sshOpts, "— None (skip SSH-only hosts) —") + '</select>' +
      '</div>' +
      '<div class="form-group">' +
        '<label for="bulk-agent-cred-winrm">WinRM credential (Windows)</label>' +
        '<select id="bulk-agent-cred-winrm">' + credOptions(winrmOpts, "— None (Windows hosts use SSH fallback) —") + '</select>' +
        '<p class="hint">Credentials need admin rights on the target hosts — the installer registers a system service.</p>' +
      '</div>' +
      '<div class="form-group">' +
        '<label for="bulk-agent-arch">CPU architecture</label>' +
        '<select id="bulk-agent-arch">' +
          '<option value="amd64" selected>amd64 (x86_64)</option>' +
          '<option value="arm64">arm64</option>' +
        '</select>' +
        '<p class="hint">Applies to every asset in this batch. Pick arm64 only for actually-ARM hosts; a wrong guess fails safely at enrollment.</p>' +
      '</div>' +
      scriptRows +
      // Privilege tier — applies to Linux hosts in the batch only (Windows
      // agents run as LocalSystem; macOS LaunchDaemons run as root).
      '<div class="form-group">' +
        '<label style="display:flex;align-items:center;gap:0.5rem;font-weight:normal;cursor:pointer">' +
          '<input type="checkbox" id="bulk-agent-run-as-root"> Grant CAP_SYS_PTRACE + CAP_DAC_READ_SEARCH on Linux hosts (for Application Map connection mapping)' +
        '</label>' +
        '<p class="hint" style="color:var(--color-warning)">Leave unchecked to run the agent fully unprivileged (recommended). Checking this grants <strong>CAP_SYS_PTRACE + CAP_DAC_READ_SEARCH</strong> on every Linux host in this batch — the pair the agent needs to attribute network connections to processes, without full root. Note: these capabilities also let the agent read any process’s memory and any file on the host (a credential-theft risk). Windows hosts are unaffected.</p>' +
      '</div>' +
      _agentRebootOptInHTML("bulk-agent-allow-reboot", true);

    var footer =
      '<button class="btn btn-secondary" id="bulk-agent-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="bulk-agent-go">Deploy Agent</button>';

    openModal("Deploy Polaris Agent to " + ids.length + " Asset" + (ids.length === 1 ? "" : "s"), body, footer);

    document.getElementById("bulk-agent-cancel").onclick = closeModal;
    document.getElementById("bulk-agent-go").onclick = async function () {
      var ssh   = document.getElementById("bulk-agent-cred-ssh").value;
      var winrm = document.getElementById("bulk-agent-cred-winrm").value;
      var arch  = document.getElementById("bulk-agent-arch").value;
      var rootCb = document.getElementById("bulk-agent-run-as-root");
      var wantPtrace = !!(rootCb && rootCb.checked);
      if (!ssh && !winrm) {
        showToast("Pick at least one credential first", "error");
        return; // keep modal open
      }
      if (wantPtrace) {
        var ok = await showConfirm(
          "Grant the Polaris Agent CAP_SYS_PTRACE + CAP_DAC_READ_SEARCH on the Linux hosts in this batch?\n\n" +
          "This capability pair lets those agents attribute network connections to processes for the Application Map — without full root. Note that it also lets the agent read any process's memory and any file on the host (a credential-theft risk). Windows hosts are unaffected (they always run as LocalSystem)."
        );
        if (!ok) return; // keep modal open
      }
      var btn = document.getElementById("bulk-agent-go");
      btn.disabled = true;
      var payload = { ids: ids, arch: arch };
      if (ssh)   payload.sshCredentialId = ssh;
      if (winrm) payload.winrmCredentialId = winrm;
      if (wantPtrace) payload.privilegeTier = "ptrace";
      var bulkRebootCb = document.getElementById("bulk-agent-allow-reboot");
      if (bulkRebootCb && bulkRebootCb.checked) payload.allowReboot = true;
      // Collect any per-OS install-method choices that were rendered.
      var scriptIds = {};
      Array.prototype.forEach.call(document.querySelectorAll("[id^='bulk-agent-script-']"), function (sel) {
        if (sel.value) scriptIds[sel.getAttribute("data-os")] = sel.value;
      });
      if (Object.keys(scriptIds).length) payload.scriptIds = scriptIds;
      api.assets.bulkInstallAgents(payload).then(function (r) {
        _renderBulkAgentDeployResult(r);
        loadAssets();
      }).catch(function (err) {
        btn.disabled = false;
        showToast("Deploy failed: " + err.message, "error");
      });
    };
  });
}

// Replace the deploy modal's content with the outcome summary: how many
// installs kicked off (naming how many of those were retries of a failed
// install) + a per-asset table of skips with the server's reason.
function _renderBulkAgentDeployResult(r) {
  var retried = r.retried || 0;
  var retriedNote = retried > 0
    ? ' (' + retried + ' of them ' + (retried === 1 ? 'a retry' : 'retries') + ' of a failed install)'
    : '';
  var kickedLine = r.kicked > 0
    ? '<p style="margin:0 0 0.75rem"><strong>' + r.kicked + '</strong> install' + (r.kicked === 1 ? '' : 's') +
      ' started' + retriedNote + ' — progress shows on each asset\'s System tab as the pool works through them.</p>'
    : '<p style="margin:0 0 0.75rem">No installs were started.</p>';
  var skippedHTML = '';
  if (r.skipped && r.skipped.length) {
    skippedHTML =
      '<div class="section-label" style="margin-bottom:0.4rem">Skipped (' + r.skipped.length + ')</div>' +
      '<div style="max-height:300px;overflow:auto">' +
        '<table style="width:100%;font-size:0.85rem;border-collapse:collapse">' +
          '<thead><tr>' +
            '<th style="text-align:left;padding:0 0.6rem 0.35rem 0">Asset</th>' +
            '<th style="text-align:left;padding:0 0 0.35rem">Reason</th>' +
          '</tr></thead><tbody>' +
          r.skipped.map(function (s) {
            return '<tr>' +
              '<td style="padding:0.25rem 0.6rem 0.25rem 0;vertical-align:top;white-space:nowrap">' + escapeHtml(s.hostname || s.assetId) + '</td>' +
              '<td style="padding:0.25rem 0;vertical-align:top;word-break:break-word;color:var(--color-text-secondary)">' + escapeHtml(s.reason) + '</td>' +
            '</tr>';
          }).join("") +
        '</tbody></table>' +
      '</div>';
  }
  openModal("Agent Deploy Started", kickedLine + skippedHTML,
    '<button class="btn btn-primary" onclick="closeModal()">Close</button>');
}

async function bulkQuarantineAssets() {
  var ids = Array.from(_assetsSelected);
  if (!ids.length) return;
  var reason = await _promptQuarantineReason(ids.length);
  if (reason === null) return;
  try {
    var r = await api.assets.bulkQuarantine(ids, reason || undefined);
    var ok = r.results.filter(function (x) { return x.ok; }).length;
    var fail = r.results.length - ok;
    showToast('Quarantined ' + ok + ' asset(s)' + (fail ? '; ' + fail + ' failed' : ''), fail ? 'warning' : 'success');
    _assetsSelected.clear();
    loadAssets();
  } catch (err) {
    showToast(err.message || 'Bulk quarantine failed', 'error');
  }
}

async function bulkUnquarantineAssets() {
  var ids = Array.from(_assetsSelected);
  if (!ids.length) return;
  var ok2 = await showConfirm('Release quarantine on ' + ids.length + ' asset(s)?');
  if (!ok2) return;
  try {
    var r = await api.assets.bulkUnquarantine(ids);
    var ok = r.results.filter(function (x) { return x.ok; }).length;
    var fail = r.results.length - ok;
    showToast('Released ' + ok + ' quarantine(s)' + (fail ? '; ' + fail + ' failed' : ''), fail ? 'warning' : 'success');
    _assetsSelected.clear();
    loadAssets();
  } catch (err) {
    showToast(err.message || 'Bulk release failed', 'error');
  }
}

// The standalone "Asset Settings" modal was folded into the merged
// "Settings" modal (openMonitoringSettingsModal) — its two lifecycle fields
// render as the Asset Lifecycle section there (_monsetLifecycleSectionHTML).

// Bulk-bar dropdown wiring. Three dropdowns share one "only-one-open" model
// + outside-click-closes pattern: opening one closes the others, and a
// document-level mousedown handler closes the active menu when the click
// lands outside it. The Type and State menus are populated from the label
// maps so the option list isn't duplicated in HTML.
var _bulkBarOpenMenu = null;
var _bulkBarOutsideHandler = null;

function _closeBulkBarMenu() {
  if (_bulkBarOpenMenu) {
    _bulkBarOpenMenu.classList.remove("open");
    _bulkBarOpenMenu = null;
  }
  if (_bulkBarOutsideHandler) {
    document.removeEventListener("mousedown", _bulkBarOutsideHandler, true);
    _bulkBarOutsideHandler = null;
  }
}

function _openBulkBarMenu(menu) {
  _closeBulkBarMenu();
  menu.classList.add("open");
  _bulkBarOpenMenu = menu;
  _bulkBarOutsideHandler = function (ev) {
    if (!menu.contains(ev.target) && !menu.previousElementSibling.contains(ev.target)) {
      _closeBulkBarMenu();
    }
  };
  setTimeout(function () {
    document.addEventListener("mousedown", _bulkBarOutsideHandler, true);
  }, 0);
}

// Populate the bulk-bar Type menu from ASSET_TYPE_OPTIONS — the registry list,
// not ASSET_TYPE_LABELS, so operator-added custom types are offered and the
// registry's own label + ordering is what an operator reads. Its own function
// because wiring runs before _loadAssetTypeOptions() resolves, so this is
// called AGAIN once the registry answers; without that second call the menu
// carried the built-in seed forever and a custom type was unreachable from the
// bulk bar (it was already selectable in the edit form and the row menu, both
// of which build after load).
function _renderBulkTypeMenu() {
  var typeMenu = document.getElementById("assets-bulk-type-menu");
  if (!typeMenu) return;
  var typeHtml = ['<div class="dropdown-heading">Change type</div>'];
  ASSET_TYPE_OPTIONS.forEach(function (o) {
    typeHtml.push('<button type="button" data-bulk-type="' + escapeHtml(o.value) + '">' + escapeHtml(o.label) + '</button>');
  });
  typeMenu.innerHTML = typeHtml.join("");
  typeMenu.querySelectorAll('button[data-bulk-type]').forEach(function (btn) {
    btn.addEventListener("click", function () {
      var key = btn.getAttribute("data-bulk-type");
      _closeBulkBarMenu();
      bulkChangeType(key);
    });
  });
}

function _wireBulkBarDropdowns() {
  _renderBulkTypeMenu();

  // Populate State menu from ASSET_STATUS_LABELS.
  var stateMenu = document.getElementById("assets-bulk-state-menu");
  if (stateMenu) {
    var stateHtml = ['<div class="dropdown-heading">Change state</div>'];
    Object.keys(ASSET_STATUS_LABELS).forEach(function (key) {
      stateHtml.push('<button type="button" data-bulk-state="' + escapeHtml(key) + '">' + escapeHtml(ASSET_STATUS_LABELS[key]) + '</button>');
    });
    stateMenu.innerHTML = stateHtml.join("");
    stateMenu.querySelectorAll('button[data-bulk-state]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.getAttribute("data-bulk-state");
        _closeBulkBarMenu();
        bulkChangeState(key);
      });
    });
  }

  // Monitoring menu options are static HTML; just wire the click handlers.
  var monOn  = document.getElementById("assets-bulk-monitor-on");
  var monOff = document.getElementById("assets-bulk-monitor-off");
  if (monOn)  monOn.addEventListener("click",  function () { _closeBulkBarMenu(); bulkSetMonitoring(true);  });
  if (monOff) monOff.addEventListener("click", function () { _closeBulkBarMenu(); bulkSetMonitoring(false); });

  // Open/close on trigger click. Toggling the same trigger closes the menu.
  [
    ["assets-bulk-type-btn", "assets-bulk-type-menu"],
    ["assets-bulk-state-btn", "assets-bulk-state-menu"],
    ["assets-bulk-monitor-btn", "assets-bulk-monitor-menu"],
  ].forEach(function (pair) {
    var trigger = document.getElementById(pair[0]);
    var menu    = document.getElementById(pair[1]);
    if (!trigger || !menu) return;
    trigger.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (_bulkBarOpenMenu === menu) {
        _closeBulkBarMenu();
      } else {
        _openBulkBarMenu(menu);
      }
    });
  });
}

// Bounded-concurrency fan-out for the bulk paths that have no bulk endpoint
// (type and state; bulkDelete has one). A strictly serial loop held the button
// disabled for the whole selection — which spans pages, so realistically
// hundreds of assets — and at a typical RTT that is tens of seconds of dead
// UI. Eight in flight cuts the wall time by ~8x without stampeding the server
// the way an unbounded Promise.all over 500 ids would. Never rejects: each
// task's outcome is counted, exactly as the per-item try/catch did. Writes are
// independent per asset, so losing the serial order costs nothing.
async function _bulkApply(ids, apply, limit) {
  var next = 0;
  var successCount = 0;
  var errorCount = 0;
  async function worker() {
    for (;;) {
      var i = next++;
      if (i >= ids.length) return;
      try { await apply(ids[i]); successCount++; }
      catch (_e) { errorCount++; }
    }
  }
  var workers = [];
  var lanes = Math.min(limit || 8, ids.length);
  for (var w = 0; w < lanes; w++) workers.push(worker());
  await Promise.all(workers);
  return { successCount: successCount, errorCount: errorCount };
}

// Bulk type change. No bulk endpoint exists — fan out per-asset PUTs, same
// call as the legacy "Edit Type & Tags" modal's submit path.
async function bulkChangeType(nextType) {
  var ids = Array.from(_assetsSelected);
  if (!ids.length || !nextType) return;
  var label = ASSET_TYPE_LABELS[nextType] || nextType;
  var ok = await showConfirm("Change type to " + label + " for " + ids.length + " asset" + (ids.length !== 1 ? "s" : "") + "?");
  if (!ok) return;
  var btn = document.getElementById("assets-bulk-type-btn");
  if (btn) btn.disabled = true;
  var counts = await _bulkApply(ids, function (id) {
    return api.assets.update(id, { assetType: nextType });
  });
  var successCount = counts.successCount;
  var errorCount = counts.errorCount;
  if (btn) btn.disabled = false;
  if (errorCount === 0) {
    showToast("Changed type to " + label + " on " + successCount + " asset" + (successCount !== 1 ? "s" : ""));
  } else {
    showToast("Updated " + successCount + ", " + errorCount + " failed", errorCount === ids.length ? "error" : "");
  }
  _assetsSelected.clear();
  loadAssets();
}

// Business rule 123: decommissioning an agent host archives the SSH host key /
// WinRM TLS certificate Polaris pinned for its addresses (and reactivating it
// puts them back). The confirm names them before the change is made.
// `previews` is POST /assets/decommission-preview's `assets` — agent hosts only.
function _hostPinLine(p) {
  var what = p.kind === "ssh" ? "SSH host key" : "TLS certificate";
  var detail = p.kind === "ssh" ? (p.keyType ? p.keyType + " " : "") + p.fingerprint : "SHA-256 " + p.fingerprint;
  return "  • " + what + " " + p.host + ":" + p.port + " — " + detail;
}
function _decommissionPinNotice(previews) {
  if (!previews || !previews.length) return "";
  var lines = [];
  if (previews.length === 1) {
    var one = previews[0];
    lines.push((one.hostname ? '"' + one.hostname + '"' : "This asset") + " has the Polaris Agent installed.");
    if (one.pins.length) {
      lines.push("Its pinned SSH thumbprint" + (one.pins.length !== 1 ? "s" : "") + " will be decommissioned as well — archived, so its address no longer refuses another machine:");
      one.pins.forEach(function (p) { lines.push(_hostPinLine(p)); });
    } else {
      lines.push("No SSH thumbprint or TLS certificate is pinned for it right now, so nothing is archived.");
    }
  } else {
    var total = previews.reduce(function (n, a) { return n + a.pins.length; }, 0);
    lines.push(previews.length + " of these assets have the Polaris Agent installed. Their " + total +
      " pinned SSH thumbprint" + (total !== 1 ? "s" : "") + " / TLS certificate" + (total !== 1 ? "s" : "") +
      " will be decommissioned as well — archived, so the addresses no longer refuse another machine:");
    previews.slice(0, 10).forEach(function (a) {
      lines.push("  " + (a.hostname || a.assetId) + ": " + (a.pins.length ? a.pins.length + " pinned" : "none pinned"));
    });
    if (previews.length > 10) lines.push("  …and " + (previews.length - 10) + " more");
  }
  lines.push("");
  lines.push("They are reinstated if the asset is set back to an active status. If an agent checks in while its asset is decommissioned, a conflict asks whether to reactivate it and reinstate the thumbprint.");
  return lines.join("\n");
}
// Resolves to the notice text ("" when none of the ids is an agent host). A
// failed preview must not block a decommission — the server archives anyway.
async function _fetchDecommissionPinNotice(ids) {
  try {
    var r = await api.assets.decommissionPreview(ids);
    return _decommissionPinNotice(r && r.assets);
  } catch (_) {
    return "";
  }
}

// Bulk state change. The Prisma extension at src/db.ts handles the
// "decommissioned/disabled → monitored=false" cascade, so no special-casing
// here. quarantined is intentionally not in ASSET_STATUS_LABELS.
async function bulkChangeState(nextStatus) {
  var ids = Array.from(_assetsSelected);
  if (!ids.length || !nextStatus) return;
  var label = ASSET_STATUS_LABELS[nextStatus] || nextStatus;
  var pinNotice = nextStatus === "decommissioned" ? await _fetchDecommissionPinNotice(ids) : "";
  var ok = await showConfirm("Change state to " + label + " for " + ids.length + " asset" + (ids.length !== 1 ? "s" : "") + "?" +
    (pinNotice ? "\n\n" + pinNotice : ""));
  if (!ok) return;
  var btn = document.getElementById("assets-bulk-state-btn");
  if (btn) btn.disabled = true;
  var counts = await _bulkApply(ids, function (id) {
    return api.assets.update(id, { status: nextStatus });
  });
  var successCount = counts.successCount;
  var errorCount = counts.errorCount;
  if (btn) btn.disabled = false;
  if (errorCount === 0) {
    showToast("Changed state to " + label + " on " + successCount + " asset" + (successCount !== 1 ? "s" : ""));
  } else {
    showToast("Updated " + successCount + ", " + errorCount + " failed", errorCount === ids.length ? "error" : "");
  }
  _assetsSelected.clear();
  loadAssets();
}

// Bulk-bar Tags: pick tags from the registry picker (the edit form's
// tagFieldHTML) and one of three modes. Add is the default because a
// selection usually mixes assets whose tags differ. The work happens server-
// side (POST /assets/bulk-tags) — the selection spans pages, so the browser
// doesn't hold most rows' current tags. Replace keeps region: and discovery
// breadcrumb tags; the hint says so (assetBulkTagService).
var BULK_TAG_MODE_HINTS = {
  add:     "The selected tags are added to every asset. Tags an asset already has are kept.",
  remove:  "The selected tags are removed from every asset that has them. Other tags are kept.",
  replace: "Every asset ends up with exactly the selected tags — all other tags are removed, except Device Map region tags and discovery breadcrumbs (prev-entra:, prev-ad:). Selecting no tags clears them.",
};

async function openBulkTagsModal() {
  var ids = Array.from(_assetsSelected);
  if (!ids.length) return;
  await _ensureTagCache();
  var n = ids.length + " asset" + (ids.length === 1 ? "" : "s");

  function modeRadio(value, label, checked) {
    return '<label style="display:flex;align-items:center;gap:0.35rem;font-weight:normal;cursor:pointer">' +
      '<input type="radio" name="bulk-tags-mode" value="' + value + '"' + (checked ? " checked" : "") + '> ' + label +
    '</label>';
  }
  var body =
    '<div class="form-group">' +
      '<label>Action</label>' +
      '<div style="display:flex;gap:1rem;align-items:center;padding:0.25rem 0">' +
        modeRadio("add", "Add tags", true) +
        modeRadio("remove", "Remove tags", false) +
        modeRadio("replace", "Replace all tags", false) +
      '</div>' +
      '<p class="hint" id="bulk-tags-mode-hint">' + escapeHtml(BULK_TAG_MODE_HINTS.add) + '</p>' +
    '</div>' +
    tagFieldHTML([]);
  var footer =
    '<button class="btn btn-secondary" id="bulk-tags-cancel">Cancel</button>' +
    '<button class="btn btn-primary" id="bulk-tags-go">Add Tags</button>';
  openModal("Tags — " + n, body, footer);
  wireTagPicker();

  var goLabels = { add: "Add Tags", remove: "Remove Tags", replace: "Replace Tags" };
  function currentMode() {
    var r = document.querySelector('input[name="bulk-tags-mode"]:checked');
    return r ? r.value : "add";
  }
  document.querySelectorAll('input[name="bulk-tags-mode"]').forEach(function (r) {
    r.addEventListener("change", function () {
      var mode = currentMode();
      document.getElementById("bulk-tags-mode-hint").textContent = BULK_TAG_MODE_HINTS[mode];
      document.getElementById("bulk-tags-go").textContent = goLabels[mode];
      // Creating a registry tag to then remove it from assets makes no sense.
      var addRow = document.getElementById("f-tags-add-row");
      if (addRow) addRow.style.display = mode === "remove" ? "none" : "flex";
    });
  });
  document.getElementById("bulk-tags-cancel").onclick = closeModal;
  document.getElementById("bulk-tags-go").onclick = async function () {
    var mode = currentMode();
    var tags = getTagFieldValue();
    if (!tags.length && mode !== "replace") {
      showToast("Select at least one tag", "error");
      return;
    }
    if (mode === "replace") {
      var what = tags.length ? "exactly " + tags.join(", ") : "no tags";
      var ok = await showConfirm("Replace the tags on " + n + " with " + what + "? Their other tags are removed (region tags and discovery breadcrumbs are kept).");
      if (!ok) return;
    }
    var btn = document.getElementById("bulk-tags-go");
    btn.disabled = true;
    try {
      var r = await api.assets.bulkTags(ids, mode, tags);
      var msg = (mode === "add" ? "Added tags to " : mode === "remove" ? "Removed tags from " : "Replaced tags on ") +
        r.updated + " asset" + (r.updated === 1 ? "" : "s");
      if (r.unchanged) msg += " (" + r.unchanged + " already matched)";
      showToast(msg);
      closeModal();
      _assetsSelected.clear();
      loadAssets();
    } catch (e) {
      showToast((e && e.message) || "Tag update failed", "error");
      btn.disabled = false;
    }
  };
}

async function bulkDeleteAssets() {
  var ids = Array.from(_assetsSelected);
  if (!ids.length) return;
  // Rule 163: warns, and offers an uninstall first, when any of them has the
  // Polaris Agent. It may hand back fewer ids than it was given ("delete the
  // others only").
  ids = await confirmAssetDeletion(ids, "Delete " + ids.length + " asset" + (ids.length !== 1 ? "s" : "") + "? This cannot be undone.");
  if (!ids || !ids.length) return;
  var btn = document.getElementById("assets-bulk-delete-btn");
  if (btn) btn.disabled = true;
  try {
    var result = await api.assets.bulkDelete(ids);
    _assetsSelected.clear();
    showToast("Deleted " + (result.deleted || ids.length) + " asset" + (ids.length !== 1 ? "s" : ""));
  } catch (e) {
    showToast("Deletion failed", "error");
  } finally {
    if (btn) btn.disabled = false;
  }
  loadAssets();
}

// Bulk-bar Edit: the edit modal is single-asset, so this only acts when exactly
// one row is selected (the button hides otherwise). Multi-asset tag edits go
// through the bulk bar's Tags button (openBulkTagsModal) instead.
function bulkEditSelectedAsset() {
  var ids = Array.from(_assetsSelected);
  if (ids.length !== 1) return;
  openEditModal(ids[0]);
}

function assetTypeBadge(type, asset) {
  var label = ASSET_TYPE_LABELS[type] || type || "-";
  // Clickable for admin/assetsadmin — opens a dropdown of the 8 AssetType
  // values; selecting one PUTs the change inline. Same data-attribute pattern
  // as the Status pill so the delegated handler can dispatch without lookups.
  var canToggle = _canEditAsset(asset) && asset && asset.id;
  if (!canToggle) {
    return '<span class="badge badge-asset-type">' + escapeHtml(label) + '</span>';
  }
  if (isAssetTypeLocked(asset)) {
    return '<span class="badge badge-asset-type" title="Locked — discovered as ' + escapeHtml(label) + ' by an integration">' + escapeHtml(label) + '</span>';
  }
  return '<span class="badge badge-asset-type badge-clickable"' +
    ' data-asset-type-toggle="' + escapeHtml(asset.id) + '"' +
    ' data-asset-type="' + escapeHtml(type || "other") + '"' +
    ' role="button" tabindex="0"' +
    ' title="Click to change type">' +
    escapeHtml(label) + ' ▾</span>';
}

// Fortinet infrastructure (firewall/switch/access_point) discovered via an
// integration is not reclassifiable — the next discovery cycle would revert
// any change. Mirrored on the backend in PUT /assets/:id.
function isAssetTypeLocked(asset) {
  if (!asset || !asset.discoveredByIntegrationId) return false;
  var t = asset.assetType;
  return t === "firewall" || t === "switch" || t === "access_point";
}

function assetStatusBadge(asset) {
  var status = typeof asset === "string" ? asset : (asset.status || "");
  var cls = "badge-" + status;
  var label = status.charAt(0).toUpperCase() + status.slice(1);
  var title = "";
  if (typeof asset === "object" && asset) {
    var parts = [];
    if (asset.statusChangedBy) parts.push("Changed by: " + asset.statusChangedBy);
    if (asset.statusChangedAt) {
      var d = new Date(asset.statusChangedAt);
      parts.push(d.toLocaleString(undefined, Object.assign({ month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }, timeZoneOpts())));
    }
    if (parts.length) title = ' title="' + parts.join("\n") + '"';
  }
  return '<span class="badge ' + cls + '"' + title + '>' + escapeHtml(label) + '</span>';
}

// Five-state monitoring pill. "Monitored" is never shown directly — when an
// asset is being monitored we surface the actual probe outcome so operators
// don't have to drill in to discover the state.
//   monitored=false                          → grey   "Unmonitored"
//   monitored=true, status="up"              → green  "Up"
//   monitored=true, status="warning"         → amber  "Missed"      (was up, currently failing but below threshold)
//   monitored=true, status="recovering"      → blue   "Recovering"  (was down, now succeeding; below threshold)
//   monitored=true, status="down"            → red    "Down"
//   monitored=true, status="unknown"/null    → blue   "Pending"     (never probed — same blue treatment as "Recovering" but a different label)
//   monitored=true, dependencySuppressed     → slate  "Dep. Down"   (upstream parent down; outranks all five states — own probe state in the tooltip)
//
// For admin/assetsadmin callers the pill is clickable: a single click
// toggles monitored. The server recomputes `monitorOverride` against the
// discovering integration's per-class `addAsMonitored` after the write —
// override goes true when the operator's new choice diverges from the
// integration default, clears when they re-converge. The pill carries
// `data-monitor-toggle="<asset-id>"` and `data-monitored="true|false"` so
// the delegated handler in `_handleMonitorPillClick` can flip it without
// re-querying.
// Normalized HA-cluster info for a Fortinet firewall asset. The assets LIST
// endpoint ships the compact `ha` projection ({mode, role, memberStatus,
// clusterIp}); the detail endpoint ships the full fortinetTopology blob —
// accept either so the pill/IP helpers work from both data sources.
function assetHaInfo(asset) {
  if (!asset) return null;
  if (asset.ha && typeof asset.ha === "object" && asset.ha.role) return asset.ha;
  var topo = asset.fortinetTopology;
  if (topo && typeof topo === "object" && topo.haMode && topo.haMode !== "standalone" && topo.haRole) {
    return { mode: topo.haMode, role: topo.haRole, memberStatus: topo.haMemberStatus, clusterIp: topo.haClusterIp };
  }
  return null;
}

// Human labels for the raw polling-method keys the server sends in
// `monitoringMethods`. Mirrors _POLLING_LABELS in integrations.js (not loaded
// on this page) so the Assets table stays self-contained.
var _MONITORED_VIA_LABELS = {
  agent:    "Agent",
  snmp:     "SNMP",
  ssh:      "SSH",
  winrm:    "WinRM",
  rest_api: "REST API",
  icmp:     "ICMP",
  vcenter:  "vCenter",
  fortimanager: "FortiManager",
  unraid:   "Unraid",
  truenas:  "TrueNAS",
  proxmox:  "Proxmox",
  genericapi: "Generic API",
};

// "Monitored Via" cell — renders how the asset is actually monitored from the
// server-reduced `monitoringMethods` array (see computeMonitoringMethods in
// the assets route). Empty → em dash (unmonitored / nothing resolved); one
// method → its label; several → "Multiple" with the full list in the tooltip.
function assetMonitoredViaCell(asset) {
  var methods = (asset && asset.monitoringMethods) || [];
  if (!methods.length) return '<span class="text-tertiary">—</span>';
  if (methods.length === 1) {
    var m = methods[0];
    return '<span class="badge badge-neutral">' + escapeHtml(_MONITORED_VIA_LABELS[m] || m) + '</span>';
  }
  var labels = methods.map(function (k) { return _MONITORED_VIA_LABELS[k] || k; });
  return '<span class="badge badge-neutral" title="' + escapeHtml(labels.join(", ")) + '">Multiple</span>';
}

// The four lifecycle statuses that cannot carry monitoring (business rule 10 —
// UNMONITORABLE_STATUSES server-side). Mirrored here so the pill and the edit
// form don't offer a toggle the API refuses: decommissioned/disabled are out of
// service, a storage asset is on a shelf, and a quarantined one is isolated at
// the FortiGate, where every probe fails by design.
var UNMONITORABLE_STATUSES = ["decommissioned", "disabled", "storage", "quarantined"];

function statusAllowsMonitoring(status) {
  return UNMONITORABLE_STATUSES.indexOf(String(status || "")) === -1;
}

function assetMonitorBadge(asset) {
  var monitorable = statusAllowsMonitoring(asset && asset.status);
  var canToggle = _canEditAsset(asset) && asset && asset.id && monitorable;
  var toggleAttrs = canToggle
    ? ' data-monitor-toggle="' + escapeHtml(asset.id) + '" data-monitored="' + (asset.monitored ? "true" : "false") + '"' +
      (asset.hostname ? ' data-hostname="' + escapeHtml(asset.hostname) + '"' : "") + ' role="button" tabindex="0"'
    : "";
  if (!asset || asset.monitored === false || asset.monitored == null) {
    // HA standby FortiGate: not probe-monitored by design (the cluster IP
    // routes only to the active member — a probe would measure the primary),
    // so "Unmonitored" undersells it. Health rides the HA roster read on
    // every discovery cycle: present/synced → "Standby", roster reports the
    // member failed → "Standby Down". Operator opt-in monitoring (per the
    // fan-out design) keeps the normal five-state pill below.
    var haInfo = assetHaInfo(asset);
    if (haInfo && haInfo.role === "secondary") {
      if (haInfo.memberStatus === "down") {
        var sdBits = ["HA standby member reported DOWN in the cluster's HA roster"];
        if (canToggle) sdBits.push("Click to enable monitoring");
        return '<span class="badge badge-monitor-down' + (canToggle ? " badge-clickable" : "") + '" title="' +
          escapeHtml(sdBits.join("\n")) + '"' + toggleAttrs + '>Standby Down</span>';
      }
      var sbBits = ["HA standby member — the cluster IP routes to the active member"];
      sbBits.push(haInfo.memberStatus === "up"
        ? "HA roster reports this member up (checked each discovery cycle)"
        : "Health tracked via the HA roster on each discovery cycle");
      if (canToggle) sbBits.push("Click to enable monitoring");
      return '<span class="badge badge-monitor-standby' + (canToggle ? " badge-clickable" : "") + '" title="' +
        escapeHtml(sbBits.join("\n")) + '"' + toggleAttrs + '>Standby</span>';
    }
    var unmonTitle = canToggle
      ? ' title="Click to enable monitoring"'
      : (!monitorable && asset && asset.status
          ? ' title="' + escapeHtml("A " + asset.status + " asset is not polled — change the status to enable monitoring") + '"'
          : "");
    return '<span class="badge badge-unmonitored' + (canToggle ? " badge-clickable" : "") + '"' + unmonTitle + toggleAttrs + '>Unmonitored</span>';
  }
  var s = asset.monitorStatus || "unknown";
  var bits = [];
  if (asset.responseTimePolling) bits.push("Method: " + asset.responseTimePolling);
  if (typeof asset.lastResponseTimeMs === "number") bits.push("Last RTT: " + asset.lastResponseTimeMs + " ms");
  if (asset.lastMonitorAt) bits.push("Last poll: " + formatDateTime(asset.lastMonitorAt));
  if (canToggle) bits.push("Click to disable monitoring");
  var clickCls = canToggle ? " badge-clickable" : "";
  // Maintenance window outranks everything, including the dep-test overlay —
  // while status="maintenance" the scheduler has paused ALL polling and
  // notifications, so no live probe state exists to display. Ending the
  // window early is offered via the pill popover (maintenanceManagement).
  if (asset.status === "maintenance") {
    var mBits = ["In a maintenance window — monitoring and notifications paused"];
    if (asset.maintenanceReturnStatus) mBits.push("Returns to: " + asset.maintenanceReturnStatus);
    if (canToggle) mBits.push("Click for options");
    var mTitle = ' title="' + escapeHtml(mBits.join("\n")) + '"';
    var mAttrs = toggleAttrs + ' data-maintenance="true"' +
      (asset.maintenanceReturnStatus ? ' data-return-status="' + escapeHtml(asset.maintenanceReturnStatus) + '"' : "");
    return '<span class="badge badge-maintenance' + clickCls + '"' + mTitle + mAttrs + '>Maintenance</span>';
  }
  // Admin-only "Dependency Test" overlay takes priority over every other
  // pill state — the operator explicitly asked us to simulate this device
  // going down, so show the simulation label even when the real probe is
  // succeeding underneath. The expiration timestamp goes in the tooltip
  // so admins can see how long is left without opening the asset.
  var depTestUntil = asset.dependencyTestUntil ? new Date(asset.dependencyTestUntil) : null;
  if (depTestUntil && depTestUntil.getTime() > Date.now()) {
    var dtBits = ["Simulated as DOWN by an admin (real probes still running)"];
    dtBits.push("Auto-clears: " + formatDateTime(depTestUntil));
    if (asset.dependencyTestStartedBy) dtBits.push("Started by: " + asset.dependencyTestStartedBy);
    var dtTitle = ' title="' + escapeHtml(dtBits.join("\n")) + '"';
    return '<span class="badge badge-monitor-dep-test"' + dtTitle + '>Dependency Test</span>';
  }
  // Dependency-suppressed takes precedence over the five-state machine
  // label: when the upstream parent is down the pill reads "Dep. Down"
  // whether the asset's own probe is failing (the usual case) or still
  // succeeding through a redundant L3 path / out-of-band management —
  // that's why monitorStatus AND dependencySuppressed are separate
  // columns. The underlying probe state goes in the tooltip so it stays
  // discoverable.
  if (asset.dependencySuppressed) {
    var depBits = bits.slice();
    depBits.unshift("Own probe: " + monitorStatusLabel(s));
    if (asset.dependencyLayer != null) depBits.unshift("Level " + asset.dependencyLayer + " — upstream parent is down");
    else                                depBits.unshift("Upstream dependency is down");
    var depTitle = ' title="' + escapeHtml(depBits.join("\n")) + '"';
    return '<span class="badge badge-monitor-dep-down' + clickCls + '"' + depTitle + toggleAttrs + '>Dep. Down</span>';
  }
  var title = bits.length ? ' title="' + escapeHtml(bits.join("\n")) + '"' : "";
  if (s === "up")         return '<span class="badge badge-monitored'        + clickCls + '"' + title + toggleAttrs + '>Up</span>';
  // "Missed", not "Warning": the alert severities are named warning/serious/
  // critical too, so this pill read as "an alert fired" when all it means is
  // that a poll was missed and the down count has started. Class name and
  // stored monitorStatus are unchanged.
  if (s === "warning")    return '<span class="badge badge-monitor-warning'  + clickCls + '"' + title + toggleAttrs + '>' + monitorStatusLabel("warning") + '</span>';
  if (s === "down")       return '<span class="badge badge-monitor-down'     + clickCls + '"' + title + toggleAttrs + '>Down</span>';
  if (s === "recovering") return '<span class="badge badge-monitor-recovering' + clickCls + '"' + title + toggleAttrs + '>Recovering</span>';
  // No down-detection automation covers this device, so Polaris renders no
  // verdict about it (business rule 36). Deliberately NOT folded into Pending:
  // this device is being polled perfectly well, and "Pending" says the opposite.
  // The tooltip separates answering from dark using consecutiveFailures, which
  // keeps advancing while passive precisely so this stays answerable.
  if (s === "passive") {
    var pBits = ["Passive — no down-detection automation covers this device",
                 "Polling continues and samples are recorded",
                 "Polaris will not declare Missed or Down"];
    pBits.push((asset.consecutiveFailures || 0) === 0
      ? "Its last poll succeeded"
      : "Its last " + asset.consecutiveFailures + " poll(s) failed");
    if (clickCls) pBits.push("Click for options");
    var pTitle = ' title="' + escapeHtml(pBits.join("\n")) + '"';
    return '<span class="badge badge-monitor-passive' + clickCls + '"' + pTitle + toggleAttrs + '>Passive</span>';
  }
  // unknown / null / unrecognized → Pending. Same blue treatment as
  // Recovering (different label).
  return '<span class="badge badge-monitor-recovering' + clickCls + '"' + title + toggleAttrs + '>Pending</span>';
}

// val() is the app.js canonical (2026-08 audit — five identical top-level copies shadowed each other on co-loaded pages).

/* ─── DNS Lookup ─────────────────────────────────────────────────────────── */

async function singleDnsLookup(id, name) {
  try {
    var result = await api.assets.dnsLookup(id);
    if (result.ok) {
      showToast(result.message, "success");
      loadAssets();
      if (_currentAssetForRefresh && _currentAssetForRefresh.id === id) openViewModal(id);
    } else {
      showToast(result.message, "error");
    }
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function singleForwardLookup(id, name) {
  try {
    var result = await api.assets.forwardLookup(id);
    if (result.ok) {
      showToast(result.message, "success");
      loadAssets();
      if (_currentAssetForRefresh && _currentAssetForRefresh.id === id) openViewModal(id);
    } else {
      showToast(result.message, "error");
    }
  } catch (err) {
    showToast(err.message, "error");
  }
}

/* ─── OUI Lookup ────────────────────────────────────────────────────────── */

async function singleOuiLookup(id, mac) {
  try {
    var result = await api.assets.ouiLookup(id);
    if (result.ok) {
      showToast(result.message, "success");
      loadAssets();
      if (_currentAssetForRefresh && _currentAssetForRefresh.id === id) openViewModal(id);
    } else {
      showToast(result.message, "error");
    }
  } catch (err) {
    showToast(err.message, "error");
  }
}

/* ─── Export (PDF / CSV) ──────────────────────────────────────────────────── */

(function () {
  // The Import and Export icons (the icon pair the other list pages carry),
  // each with its own menu. This IIFE owns both menus' toggle + outside-
  // close + stopPropagation; opening one closes the other. The import items
  // are wired separately in the DOMContentLoaded init.
  var pairs = [
    [document.getElementById("btn-import"), document.getElementById("import-menu")],
    [document.getElementById("btn-export"), document.getElementById("export-menu")],
  ].filter(function (p) { return p[0] && p[1]; });
  pairs.forEach(function (p) {
    p[0].addEventListener("click", function (e) {
      e.stopPropagation();
      pairs.forEach(function (q) { if (q !== p) q[1].classList.remove("open"); });
      p[1].classList.toggle("open");
    });
    p[1].addEventListener("click", function (e) { e.stopPropagation(); });
  });
  document.addEventListener("click", function () {
    pairs.forEach(function (p) { p[1].classList.remove("open"); });
  });

  var menu = document.getElementById("export-menu");
  if (!menu) return;

  menu.querySelectorAll("button[data-export]").forEach(function (item) {
    item.addEventListener("click", async function () {
      menu.classList.remove("open");
      var mode = this.getAttribute("data-export");
      var fmt  = this.getAttribute("data-fmt");
      await handleAssetExport(mode, fmt);
    });
  });
})();

/* ─── Edit mode (the pencil / Done tick at the tab row's right end) ───────── */
// The dashboard's Customize / Done pair, on the Assets tab row. Edit mode
// shows the Filters ▾ menu (saved filter presets) and the + that adds a view
// tab, as the dashboard's + shows only while customizing; outside it both
// are gone. Per page view, not saved: every visit opens out of edit mode.
(function () {
  var editBtn = document.getElementById("assets-edit");
  var doneBtn = document.getElementById("assets-done");
  var filters = document.getElementById("assets-filters-cluster");
  var addTab  = document.getElementById("assets-tab-add");
  if (!editBtn || !doneBtn) return;
  function setAssetsEditing(on) {
    editBtn.hidden = on;
    doneBtn.hidden = !on;
    if (filters) {
      filters.hidden = !on;
      var menu = filters.querySelector(".btn-dropdown-menu");
      if (!on && menu) menu.classList.remove("open");
    }
    if (addTab) addTab.hidden = !on;
    document.body.classList.toggle("assets-editing", on);
  }
  editBtn.addEventListener("click", function () { setAssetsEditing(true); });
  doneBtn.addEventListener("click", function () { setAssetsEditing(false); });
  setAssetsEditing(false);
})();

// Page through GET /assets in 10k-row chunks (the route's max limit) up to a
// hard ceiling, for the "filtered" / "all" export modes. Server-side paging
// means the browser no longer holds the whole table, so export re-fetches.
async function _fetchAssetsForExport(baseParams, signal) {
  var CHUNK = 10000;
  var CEILING = 100000;
  var params = Object.assign({}, baseParams);
  delete params.favoriteIds; // ordering is irrelevant for an export
  params.limit = CHUNK;
  var out = [];
  var total = Infinity;
  while (out.length < total && out.length < CEILING) {
    if (signal && signal.aborted) break;
    params.offset = out.length;
    var data = await request("GET", "/assets" + toQuery(params), undefined, signal);
    var rows = data.assets || [];
    total = (typeof data.total === "number") ? data.total : rows.length;
    if (!rows.length) break;
    out = out.concat(rows);
  }
  return { assets: out, total: total };
}

async function handleAssetExport(mode, fmt) {
  var assets, label, ok;

  if (mode === "page") {
    // _assetsData is already exactly the current page under server-side paging.
    assets = _assetsData;
    label = "page " + _assetsPage;
  } else if (mode === "filtered") {
    // Probe the total for the current filter set before committing to export.
    var probe = await api.assets.list(Object.assign(_buildAssetsQuery(), { limit: 1, offset: 0 }));
    var filteredTotal = probe.total || 0;
    if (filteredTotal === 0) { showToast("No assets to export", "error"); return; }
    label = filteredTotal + " filtered assets";
    if (filteredTotal > 100) {
      ok = await showConfirm("This will export " + filteredTotal + " assets. Continue?");
      if (!ok) return;
    }
  } else if (mode === "all") {
    ok = await showConfirm("Export the entire asset list? This may take a moment.");
    if (!ok) return;
  }

  await trackedPdfExport("Exporting assets " + fmt.toUpperCase(), async function (signal) {
    if (mode === "filtered") {
      var fr = await _fetchAssetsForExport(_buildAssetsQuery(), signal);
      assets = fr.assets;
      label = assets.length + " filtered assets";
    } else if (mode === "all") {
      var ar = await _fetchAssetsForExport({}, signal);
      assets = ar.assets;
      label = "all " + assets.length + " assets";
    }
    if (signal.aborted) return;
    if (!assets || assets.length === 0) { showToast("No assets to export", "error"); return; }
    if (fmt === "csv") generateAssetCsv(assets);
    else generateAssetPdf(assets, label);
  });
}

function generateAssetPdf(assets, label) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error("PDF library not loaded. Check your internet connection and reload the page.");
  }
  var jsPDF = window.jspdf.jsPDF;
  var doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });

  var now = new Date();
  var timestamp = now.toLocaleDateString(undefined, timeZoneOpts()) + " " + now.toLocaleTimeString(undefined, timeZoneOpts());

  // Title
  doc.setFontSize(16);
  doc.setTextColor(40, 40, 40);
  doc.text((_branding ? _branding.appName : "Polaris") + " \u2014 Asset Report", 40, 36);
  doc.setFontSize(9);
  doc.setTextColor(120, 120, 120);
  doc.text("Generated: " + timestamp + "  |  Scope: " + label + "  |  Count: " + assets.length, 40, 52);

  var head = [["Hostname", "IP Address", "MAC Address", "DNS Name", "Type", "Status", "Location", "Last Seen"]];
  var body = assets.map(function (a) {
    return [
      a.hostname || "-",
      a.ipAddress || "-",
      a.macAddress || "-",
      a.dnsName || "-",
      ASSET_TYPE_LABELS[a.assetType] || a.assetType || "-",
      a.status ? a.status.charAt(0).toUpperCase() + a.status.slice(1) : "-",
      a.location || a.learnedLocation || "-",
      a.lastSeen ? formatDate(a.lastSeen) : "-",
    ];
  });

  doc.autoTable({
    startY: 64,
    head: head,
    body: body,
    theme: "grid",
    styles: { fontSize: 8, cellPadding: 4, overflow: "linebreak" },
    headStyles: { fillColor: [30, 30, 54], textColor: [230, 230, 230], fontStyle: "bold" },
    alternateRowStyles: { fillColor: [245, 245, 250] },
    margin: { left: 40, right: 40 },
    didDrawPage: function (data) {
      // Footer on each page
      var pageNum = doc.internal.getNumberOfPages();
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text(
        "Page " + data.pageNumber + " of " + pageNum + "  |  " + (_branding ? _branding.appName : "Polaris") + " Asset Report",
        doc.internal.pageSize.getWidth() / 2,
        doc.internal.pageSize.getHeight() - 20,
        { align: "center" }
      );
    },
  });

  var filename = "polaris-assets-" + now.toISOString().slice(0, 10) + ".pdf";
  doc.save(filename);
  showToast("Exported " + assets.length + " assets to " + filename);
}

function generateAssetCsv(assets) {
  var headers = ["Hostname", "IP Address", "MAC Address", "DNS Name", "Type", "Status", "Location", "Last Seen", "Serial Number", "Manufacturer", "Model", "OS", "Asset Tag"];
  var rows = assets.map(function (a) {
    return [
      a.hostname || "", a.ipAddress || "", a.macAddress || "", a.dnsName || "",
      ASSET_TYPE_LABELS[a.assetType] || a.assetType || "", a.status || "",
      a.location || a.learnedLocation || "", (a.lastSeen ? formatDate(a.lastSeen) : ""), a.serialNumber || "",
      a.manufacturer || "", a.model || "", a.osVersion || a.os || "", a.assetTag || "",
    ];
  });
  var filename = "polaris-assets-" + new Date().toISOString().slice(0, 10) + ".csv";
  downloadCsv(headers, rows, filename);
  showToast("Exported " + assets.length + " assets to " + filename);
}

/* ─── CSV Import ──────────────────────────────────────────────────────────── */

function _parseCsv(text) {
  var lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  return lines.filter(function (l) { return l.trim(); }).map(function (line) {
    var fields = [];
    var cur = "";
    var inQuote = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === "," && !inQuote) { fields.push(cur.trim()); cur = ""; }
      else { cur += ch; }
    }
    fields.push(cur.trim());
    return fields;
  });
}

function _autoDetectCol(headers, patterns) {
  for (var i = 0; i < headers.length; i++) {
    var h = headers[i].toLowerCase().replace(/[\s_\-]+/g, "");
    for (var j = 0; j < patterns.length; j++) {
      if (h.includes(patterns[j])) return i;
    }
  }
  return -1;
}

async function openImportCsvModal(file) {
  var text = await file.text();
  var parsed = _parseCsv(text);
  if (parsed.length < 2) { showToast("CSV appears empty or has only a header row", "error"); return; }

  var headers = parsed[0];
  var dataRows = parsed.slice(1);

  var serialIdx = _autoDetectCol(headers, ["serial", "sn", "serialnum", "serialnumber"]);
  var dateIdx   = _autoDetectCol(headers, ["regdate", "registration", "purchasedate", "acquired", "date", "warranty"]);

  function colOptions(selected) {
    return headers.map(function (h, i) {
      return '<option value="' + i + '"' + (i === selected ? " selected" : "") + '>' + escapeHtml(h) + '</option>';
    }).join("");
  }

  var previewHtml = '<table class="data-table" style="font-size:0.82rem"><thead><tr>' +
    headers.map(function (h) { return '<th>' + escapeHtml(h) + '</th>'; }).join("") +
    '</tr></thead><tbody>' +
    dataRows.slice(0, 5).map(function (r) {
      return '<tr>' + r.map(function (c) { return '<td>' + escapeHtml(c) + '</td>'; }).join("") + '</tr>';
    }).join("") +
    '</tbody></table>';

  var body =
    '<p style="color:var(--color-text-secondary);margin-bottom:1rem">' +
      dataRows.length + ' data row(s) in <strong>' + escapeHtml(file.name) + '</strong>. ' +
      'Map the columns below, then click Preview to see which assets will be updated.' +
    '</p>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:1rem">' +
      '<div class="form-group"><label>Serial Number column</label>' +
        '<select id="import-col-serial">' + colOptions(serialIdx) + '</select></div>' +
      '<div class="form-group"><label>Registration Date column</label>' +
        '<select id="import-col-date">' + colOptions(dateIdx) + '</select></div>' +
    '</div>' +
    '<details style="margin-bottom:1rem"><summary style="cursor:pointer;color:var(--color-text-secondary);font-size:0.85rem">Preview first 5 rows</summary>' +
      '<div style="overflow-x:auto;margin-top:0.5rem">' + previewHtml + '</div>' +
    '</details>' +
    '<div id="import-preview-area"></div>';

  var footer =
    '<button class="btn btn-secondary" id="import-preview-btn">Preview Changes</button>' +
    '<button class="btn btn-primary" id="import-apply-btn" style="display:none">Apply Changes</button>' +
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>';

  openModal("Import CSV", body, footer, { wide: true });

  var pendingRows = null;

  document.getElementById("import-preview-btn").addEventListener("click", async function () {
    var sIdx = parseInt(document.getElementById("import-col-serial").value, 10);
    var dIdx = parseInt(document.getElementById("import-col-date").value, 10);

    var rows = dataRows.map(function (r) {
      return { serialNumber: r[sIdx] || "", date: r[dIdx] || "" };
    }).filter(function (r) { return r.serialNumber && r.date; });

    if (!rows.length) { showToast("No valid rows after column mapping", "error"); return; }

    var btn = document.getElementById("import-preview-btn");
    btn.disabled = true;
    btn.textContent = "Loading…";

    try {
      var result = await api.assets.import(rows, true);
      pendingRows = rows;

      var updateRows = result.preview.filter(function (r) { return r.willUpdate; });
      var skipRows   = result.preview.filter(function (r) { return !r.willUpdate; });

      var html = "";
      if (result.notFound > 0) {
        html += '<p style="color:var(--color-text-secondary);font-size:0.85rem;margin-bottom:0.5rem">' +
          result.notFound + ' serial number(s) not found in assets.</p>';
      }
      if (!updateRows.length) {
        html += '<p style="color:var(--color-success)">No updates needed — all matched assets already have an earlier or equal first-seen date.</p>';
        document.getElementById("import-apply-btn").style.display = "none";
      } else {
        html += '<p style="margin-bottom:0.5rem"><strong>' + updateRows.length + '</strong> asset(s) will have their first-seen date updated' +
          (skipRows.length ? '; <strong>' + skipRows.length + '</strong> already have an earlier date and will be skipped' : '') + '.</p>' +
          '<div style="overflow-x:auto"><table class="data-table" style="font-size:0.82rem"><thead><tr>' +
          '<th>Serial</th><th>Hostname</th><th>Current First Seen</th><th>New First Seen</th>' +
          '</tr></thead><tbody>' +
          updateRows.map(function (r) {
            return '<tr><td class="mono">' + escapeHtml(r.serialNumber) + '</td>' +
              '<td>' + escapeHtml(r.hostname || "-") + '</td>' +
              '<td>' + formatDate(r.currentFirstSeen) + '</td>' +
              '<td style="color:var(--color-success)">' + formatDate(r.importDate) + '</td></tr>';
          }).join("") +
          '</tbody></table></div>';
        document.getElementById("import-apply-btn").style.display = "";
      }
      document.getElementById("import-preview-area").innerHTML = html;
    } catch (e) {
      showToast("Preview failed: " + e.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Preview Changes";
    }
  });

  document.getElementById("import-apply-btn").addEventListener("click", async function () {
    if (!pendingRows) return;
    var btn = this;
    btn.disabled = true;
    btn.textContent = "Applying…";
    try {
      var result = await api.assets.import(pendingRows, false);
      closeModal();
      showToast("Updated first-seen date for " + result.updated + " asset(s)");
      loadAssets();
    } catch (e) {
      showToast("Import failed: " + e.message, "error");
      btn.disabled = false;
      btn.textContent = "Apply Changes";
    }
  });
}

/* ─── PDF Invoice Import ──────────────────────────────────────────────────── */

var _pdfJsLoaded = false;

var _PDFJS_VERSION = "3.11.174";
var _PDFJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/" + _PDFJS_VERSION;

async function _loadPdfJs() {
  if (_pdfJsLoaded) return;
  return new Promise(function (resolve, reject) {
    var umd = document.createElement("script");
    umd.src = _PDFJS_CDN + "/pdf.min.js";
    umd.onload = function () {
      if (window.pdfjsLib) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = _PDFJS_CDN + "/pdf.worker.min.js";
        _pdfJsLoaded = true;
        resolve();
      } else {
        reject(new Error("PDF.js did not load correctly"));
      }
    };
    umd.onerror = function () { reject(new Error("Failed to load PDF.js from CDN")); };
    document.head.appendChild(umd);
  });
}

async function _extractPdfPages(file) {
  await _loadPdfJs();
  var arrayBuffer = await file.arrayBuffer();
  var pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  var pages = [];
  for (var i = 1; i <= pdf.numPages; i++) {
    var page = await pdf.getPage(i);
    var content = await page.getTextContent();
    var text = content.items.map(function (item) { return item.str; }).join(" ");
    pages.push(text.replace(/\s{3,}/g, "\n").trim());
  }
  return pages;
}

var PDF_ASSET_FIELDS = [
  { key: "hostname",      label: "Hostname" },
  { key: "serialNumber",  label: "Serial Number" },
  { key: "manufacturer",  label: "Manufacturer" },
  { key: "model",         label: "Model" },
  { key: "ipAddress",     label: "IP Address" },
  { key: "macAddress",    label: "MAC Address" },
  { key: "assetTag",      label: "Asset Tag" },
  { key: "assignedTo",    label: "Assigned To" },
  { key: "location",      label: "Location" },
  { key: "notes",         label: "Notes" },
];

async function openImportPdfModal(file) {
  var loadingBody = '<div style="padding:2rem;text-align:center;color:var(--color-text-secondary)">Extracting PDF text…</div>';
  openModal("Import PDF Invoice", loadingBody, "", { xl: true });

  var pages;
  try {
    pages = await _extractPdfPages(file);
  } catch (err) {
    document.querySelector("#modal-overlay .modal-body").innerHTML =
      '<div style="padding:2rem;color:var(--color-danger)">Failed to read PDF: ' + escapeHtml(err.message) + '</div>';
    return;
  }

  if (!pages.length || pages.every(function (p) { return !p.trim(); })) {
    document.querySelector("#modal-overlay .modal-body").innerHTML =
      '<div style="padding:2rem;color:var(--color-text-secondary)">No readable text found in this PDF. It may be a scanned image — try OCR first.</div>';
    return;
  }

  var currentPage = 0;
  var assetList = [];

  function _getSelectedText() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return "";
    var text = sel.toString().trim();
    // Only allow selection from within our text area
    var textArea = document.getElementById("pdf-text-area");
    if (!textArea) return "";
    var range = sel.getRangeAt(0);
    if (!textArea.contains(range.commonAncestorContainer)) return "";
    return text;
  }

  function _renderForm() {
    return PDF_ASSET_FIELDS.map(function (f) {
      var isTextarea = f.key === "notes";
      var inputEl = isTextarea
        ? '<textarea id="pdf-field-' + f.key + '" rows="2" style="font-size:0.82rem;padding:4px 8px;resize:vertical"></textarea>'
        : '<input type="text" id="pdf-field-' + f.key + '" autocomplete="off">';
      return '<div class="form-row">' +
        '<div><label>' + escapeHtml(f.label) + '</label>' + inputEl + '</div>' +
        '<button class="btn btn-secondary btn-use" data-field="' + f.key + '" title="Paste selected text from PDF">&#8599; Use</button>' +
      '</div>';
    }).join("") +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:0.5rem">' +
      '<div><label style="font-size:0.78rem;color:var(--color-text-secondary)">Type</label>' +
        '<select id="pdf-field-assetType" style="font-size:0.82rem;padding:4px 8px;height:30px">' +
          assetTypeOptionsHTML("other") +
        '</select></div>' +
      '<div><label style="font-size:0.78rem;color:var(--color-text-secondary)">Status</label>' +
        '<select id="pdf-field-status" style="font-size:0.82rem;padding:4px 8px;height:30px">' +
          '<option value="active">Active</option>' +
          '<option value="storage">Storage</option>' +
          '<option value="maintenance">Maintenance</option>' +
          '<option value="decommissioned">Decommissioned</option>' +
          '<option value="disabled">Disabled</option>' +
        '</select></div>' +
    '</div>';
  }

  function _currentFields() {
    var obj = {};
    PDF_ASSET_FIELDS.forEach(function (f) {
      var el = document.getElementById("pdf-field-" + f.key);
      if (el && el.value.trim()) obj[f.key] = el.value.trim();
    });
    var typeEl   = document.getElementById("pdf-field-assetType");
    var statusEl = document.getElementById("pdf-field-status");
    if (typeEl)   obj.assetType = typeEl.value;
    if (statusEl) obj.status    = statusEl.value;
    return obj;
  }

  function _clearForm() {
    PDF_ASSET_FIELDS.forEach(function (f) {
      var el = document.getElementById("pdf-field-" + f.key);
      if (el) el.value = "";
    });
    var typeEl   = document.getElementById("pdf-field-assetType");
    var statusEl = document.getElementById("pdf-field-status");
    if (typeEl)   typeEl.value   = "other";
    if (statusEl) statusEl.value = "active";
  }

  function _renderAssetListTable() {
    var listEl = document.getElementById("pdf-asset-list");
    if (!listEl) return;
    if (!assetList.length) {
      listEl.innerHTML = '<p style="padding:0.5rem 1rem;font-size:0.8rem;color:var(--color-text-secondary)">No assets added yet.</p>';
      return;
    }
    listEl.innerHTML =
      '<table class="pdf-asset-list-table"><thead><tr>' +
        '<th>Serial</th><th>Hostname</th><th>Manufacturer</th><th>Model</th><th>Type</th><th></th>' +
      '</tr></thead><tbody>' +
      assetList.map(function (a, i) {
        return '<tr>' +
          '<td class="mono">' + escapeHtml(a.serialNumber || "-") + '</td>' +
          '<td>' + escapeHtml(a.hostname || "-") + '</td>' +
          '<td>' + escapeHtml(a.manufacturer || "-") + '</td>' +
          '<td>' + escapeHtml(a.model || "-") + '</td>' +
          '<td>' + escapeHtml(a.assetType || "-") + '</td>' +
          '<td><button class="btn btn-sm btn-danger" data-remove-idx="' + i + '" style="padding:1px 6px;font-size:0.72rem">✕</button></td>' +
        '</tr>';
      }).join("") +
      '</tbody></table>';
    listEl.querySelectorAll("[data-remove-idx]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var idx = parseInt(this.getAttribute("data-remove-idx"), 10);
        assetList.splice(idx, 1);
        _renderAssetListTable();
        _updateApplyBtn();
      });
    });
  }

  function _updateApplyBtn() {
    var applyBtn = document.getElementById("pdf-apply-btn");
    if (applyBtn) {
      applyBtn.disabled = assetList.length === 0;
      applyBtn.textContent = assetList.length
        ? "Preview & Apply (" + assetList.length + ")"
        : "Preview & Apply";
    }
  }

  function _renderPageText() {
    var textArea = document.getElementById("pdf-text-area");
    var pageInfo = document.getElementById("pdf-page-info");
    if (textArea) textArea.textContent = pages[currentPage] || "(empty page)";
    if (pageInfo) pageInfo.textContent = "Page " + (currentPage + 1) + " of " + pages.length;
    var prevBtn = document.getElementById("pdf-prev-page");
    var nextBtn = document.getElementById("pdf-next-page");
    if (prevBtn) prevBtn.disabled = currentPage === 0;
    if (nextBtn) nextBtn.disabled = currentPage === pages.length - 1;
  }

  var body =
    '<div class="pdf-import-pane">' +
      '<div class="pdf-import-left">' +
        '<div class="pdf-import-toolbar">' +
          '<strong style="color:var(--color-text-primary);font-size:0.82rem">' + escapeHtml(file.name) + '</strong>' +
          '<span id="pdf-page-info" style="margin-left:auto"></span>' +
          (pages.length > 1
            ? '<button class="btn btn-sm btn-secondary" id="pdf-prev-page">&#8592;</button>' +
              '<button class="btn btn-sm btn-secondary" id="pdf-next-page">&#8594;</button>'
            : '') +
        '</div>' +
        '<div class="pdf-import-text-area" id="pdf-text-area" title="Select text then click ↗ Use next to a field"></div>' +
      '</div>' +
      '<div class="pdf-import-right">' +
        '<div class="pdf-import-toolbar" style="justify-content:space-between">' +
          '<span style="font-size:0.8rem;color:var(--color-text-secondary)">Fill fields &rarr; Add Asset &rarr; repeat</span>' +
          '<button class="btn btn-sm btn-secondary" id="pdf-clear-btn">Clear</button>' +
        '</div>' +
        '<div class="pdf-import-form" id="pdf-form-area">' + _renderForm() + '</div>' +
        '<div style="padding:0.5rem 1rem;border-top:1px solid var(--color-border);flex-shrink:0">' +
          '<button class="btn btn-secondary" id="pdf-add-btn" style="width:100%">+ Add Asset to List</button>' +
        '</div>' +
        '<div class="pdf-asset-list" id="pdf-asset-list">' +
          '<p style="padding:0.5rem 1rem;font-size:0.8rem;color:var(--color-text-secondary)">No assets added yet.</p>' +
        '</div>' +
      '</div>' +
    '</div>';

  var footer =
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="pdf-apply-btn" disabled>Preview & Apply</button>';

  openModal("Import PDF Invoice", body, footer, { xl: true });

  _renderPageText();

  document.getElementById("pdf-prev-page") && document.getElementById("pdf-prev-page").addEventListener("click", function () {
    if (currentPage > 0) { currentPage--; _renderPageText(); }
  });
  document.getElementById("pdf-next-page") && document.getElementById("pdf-next-page").addEventListener("click", function () {
    if (currentPage < pages.length - 1) { currentPage++; _renderPageText(); }
  });

  document.getElementById("pdf-clear-btn").addEventListener("click", _clearForm);

  document.getElementById("pdf-form-area").addEventListener("click", function (e) {
    var btn = e.target.closest("[data-field]");
    if (!btn) return;
    var field = btn.getAttribute("data-field");
    var sel = _getSelectedText();
    if (!sel) { showToast("Select some text in the PDF viewer first", "error"); return; }
    var input = document.getElementById("pdf-field-" + field);
    if (input) { input.value = sel; input.focus(); }
  });

  document.getElementById("pdf-add-btn").addEventListener("click", function () {
    var fields = _currentFields();
    if (!fields.hostname && !fields.serialNumber && !fields.ipAddress && !fields.macAddress) {
      showToast("Enter at least one identifying field (hostname, serial, IP, or MAC)", "error");
      return;
    }
    assetList.push(fields);
    _renderAssetListTable();
    _updateApplyBtn();
    _clearForm();
    showToast("Asset added to list", "success");
  });

  document.getElementById("pdf-apply-btn").addEventListener("click", async function () {
    if (!assetList.length) return;
    var btn = this;
    btn.disabled = true;
    btn.textContent = "Previewing…";

    try {
      var result = await api.assets.importPdf(assetList, true);
      var creates = result.preview.filter(function (r) { return r.action === "create"; });
      var updates = result.preview.filter(function (r) { return r.action === "update"; });

      var previewHtml =
        '<p style="margin-bottom:0.75rem">' +
          (creates.length ? '<strong>' + creates.length + '</strong> will be <span style="color:var(--color-success)">created</span>' : '') +
          (creates.length && updates.length ? ' · ' : '') +
          (updates.length ? '<strong>' + updates.length + '</strong> will be <span style="color:var(--color-accent)">updated</span> (matched by serial number)' : '') +
        '</p>' +
        '<div style="overflow-x:auto"><table class="data-table" style="font-size:0.8rem"><thead><tr>' +
          '<th>Action</th><th>Serial</th><th>Hostname</th><th>Manufacturer</th><th>Model</th><th>Type</th>' +
        '</tr></thead><tbody>' +
        result.preview.map(function (r) {
          var actionBadge = r.action === "create"
            ? '<span style="color:var(--color-success)">Create</span>'
            : '<span style="color:var(--color-accent)">Update</span>';
          return '<tr>' +
            '<td>' + actionBadge + '</td>' +
            '<td class="mono">' + escapeHtml(r.serialNumber || "-") + '</td>' +
            '<td>' + escapeHtml(r.hostname || "-") + '</td>' +
            '<td>' + escapeHtml(r.fields.manufacturer || "-") + '</td>' +
            '<td>' + escapeHtml(r.fields.model || "-") + '</td>' +
            '<td>' + escapeHtml(r.fields.assetType || "-") + '</td>' +
          '</tr>';
        }).join("") +
        '</tbody></table></div>';

      var prevBody =
        '<div style="padding:1.25rem">' +
          '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:1rem">Review the changes below, then confirm to apply.</p>' +
          previewHtml +
        '</div>';

      var prevFooter =
        '<button class="btn btn-secondary" id="pdf-preview-back">Back</button>' +
        '<button class="btn btn-primary" id="pdf-preview-confirm">Apply Changes</button>';

      openModal("PDF Import — Preview", prevBody, prevFooter, { wide: true });

      document.getElementById("pdf-preview-back").addEventListener("click", function () {
        openImportPdfModal._reopen && openImportPdfModal._reopen();
      });

      document.getElementById("pdf-preview-confirm").addEventListener("click", async function () {
        var confirmBtn = this;
        confirmBtn.disabled = true;
        confirmBtn.textContent = "Applying…";
        try {
          var applyResult = await api.assets.importPdf(assetList, false);
          closeModal();
          showToast("Created " + applyResult.created + ", updated " + applyResult.updated + " asset(s)", "success");
          loadAssets();
        } catch (e) {
          showToast("Apply failed: " + e.message, "error");
          confirmBtn.disabled = false;
          confirmBtn.textContent = "Apply Changes";
        }
      });

    } catch (e) {
      showToast("Preview failed: " + e.message, "error");
      btn.disabled = false;
      btn.textContent = "Preview & Apply (" + assetList.length + ")";
    }
  });
}
