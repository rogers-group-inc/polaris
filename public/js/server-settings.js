/**
 * public/js/server-settings.js — Server Settings page (NTP + Web Server + Database).
 * Note: the "Web Server" tab keeps the internal key `certificates` (data-tab,
 * loadCertificates) from before it was renamed — only its label changed. The
 * "Repository" tab (firmware) has the same split: key `firmware`, label
 * "Repository", body in its own module (server-settings-firmware.js).
 *
 * This is the CORE of the page: tab visibility, the tab dispatch, and the
 * state the Identification / MIB / profile files share. Each tab's body lives
 * in its own plain browser script (CQ-F051), loaded right AFTER this one by
 * server-settings.html, in this order:
 *   server-settings-ntp-web.js         Time & NTP, Web Server
 *   server-settings-maintenance.js     Maintenance, Retention, backups, updates
 *   server-settings-customization.js   Customization
 *   server-settings-identification.js  Identification (tags, DNS, OUI, icons, types)
 *   server-settings-mibs.js            MIB Database card + MIB Browse modal
 *   server-settings-credentials.js     Credentials + credential usage
 *   server-settings-api-tokens.js      API Tokens + API docs access
 *   server-settings-profiles.js        Manufacturer Profiles
 * They share globals with no module system, so a top-level statement that
 * RUNS at load may only reference what an earlier script defined.
 * tests/unit/serverSettingsSplit.test.ts holds the page, the order and the
 * function inventory.
 */

/**
 * Which tabs this operator may see. Backend guards are the source of truth —
 * this is the UX hide. Admin sees every tab; a non-admin sees the Credentials
 * tab (the MIB Database card, and the credential list at credentials=write)
 * and, on the `firmware` key alone, the Repository tab (business rule 87).
 * A pure decider so the rule is testable and so the firmware tab never rides
 * the legacy isAdmin() check.
 */
function _settingsTabVisible(key) {
  if (key === "firmware") return typeof permAtLeast === "function" && permAtLeast("firmware", "read");
  if (typeof isAdmin === "function" && !isAdmin()) return key === "credentials";
  return true;
}

document.addEventListener("DOMContentLoaded", function () {
  var isAssetsAdminOnly = (typeof isAdmin === "function" && !isAdmin());
  document.querySelectorAll("#settings-tabs .page-tab").forEach(function (t) {
    if (!_settingsTabVisible(t.getAttribute("data-tab"))) t.style.display = "none";
  });
  document.querySelectorAll(".page-tab-panel").forEach(function (p) {
    if (!_settingsTabVisible(p.id.replace(/^tab-/, ""))) p.style.display = "none";
  });
  if (isAssetsAdminOnly) {
    // The HTML defaults the active tab to Identification — flip the active
    // class so a non-admin lands on the first tab they can see. Credentials
    // when they may see it; otherwise (a firmware-only role) the Repository.
    document.querySelectorAll("#settings-tabs .page-tab").forEach(function (t) { t.classList.remove("active"); });
    document.querySelectorAll(".page-tab-panel").forEach(function (p) { p.classList.remove("active"); });
    var firstKey = _settingsTabVisible("credentials") ? "credentials" : (_settingsTabVisible("firmware") ? "firmware" : "credentials");
    var firstTab = document.querySelector('#settings-tabs .page-tab[data-tab="' + firstKey + '"]');
    var firstPanel = document.getElementById("tab-" + firstKey);
    if (firstTab) firstTab.classList.add("active");
    if (firstPanel) firstPanel.classList.add("active");
  }

  // Tab switching
  document.querySelectorAll("#settings-tabs .page-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      var target = tab.getAttribute("data-tab");
      document.querySelectorAll("#settings-tabs .page-tab").forEach(function (t) { t.classList.remove("active"); });
      document.querySelectorAll(".page-tab-panel").forEach(function (p) { p.classList.remove("active"); });
      tab.classList.add("active");
      document.getElementById("tab-" + target).classList.add("active");
      // Persist the active tab in the URL so a page refresh restores it
      // (read back via the ?tab= handler below on load). replaceState keeps
      // it out of the back/forward history.
      try {
        var u = new URL(window.location.href);
        u.searchParams.set("tab", target);
        window.history.replaceState(null, "", u);
      } catch (e) { /* non-fatal: tab still switches */ }
      // Lazy-load tabs on first click
      if (target === "ntp" && !_ntpLoaded) loadNtpSettings();
      if (target === "certificates" && !_certsLoaded) loadCertificates();
      if (target === "maintenance" && !_dbLoaded) loadDatabaseInfo();
      if (target === "identification" && !_tagsLoaded) loadIdentificationTab();
      if (target === "customization" && !_brandingLoaded) loadCustomizationTab();
      if (target === "credentials" && !_credsLoaded) loadCredentialsTab();
      if (target === "retention" && !_retentionLoaded) loadRetentionTab();
      if (target === "api-tokens" && !_apiTokensLoaded) loadApiTokensTab();
      // The firmware Repository lives in its own module
      // (server-settings-firmware.js); it guards its own once-per-page load.
      if (target === "firmware" && window.PolarisFirmwareTab) window.PolarisFirmwareTab.load();
      // High Availability lives in its own module (server-settings-ha.js):
      // the tab is a build procedure with its own state machine, and it
      // polls while visible because a node registering arrives from
      // another machine. It reloads on every activation rather than once,
      // so returning to it shows current cluster state.
      if (target === "ha" && window.PolarisHaTab) window.PolarisHaTab.load();
    });
  });

  // Check for ?tab= query parameter to open a specific tab
  var urlParams = new URLSearchParams(window.location.search);
  var requestedTab = urlParams.get("tab");
  // Back-compat: ?tab=database now maps to the renamed Maintenance tab.
  if (requestedTab === "database") requestedTab = "maintenance";
  if (requestedTab) {
    var tabBtn = document.querySelector('#settings-tabs .page-tab[data-tab="' + requestedTab + '"]');
    // A hidden button is a tab this role may not see: fall through to the
    // default landing rather than activating an empty panel.
    if (tabBtn && tabBtn.style.display !== "none") {
      tabBtn.click();
      return;
    }
  }

  // A non-admin starts on the first tab they can see (Credentials, or the
  // Repository for a firmware-only role); admin starts on Identification per
  // the HTML default.
  if (isAssetsAdminOnly) {
    if (_settingsTabVisible("credentials")) loadCredentialsTab();
    else if (window.PolarisFirmwareTab) window.PolarisFirmwareTab.load();
  } else {
    loadIdentificationTab();
  }
});

// ─── Shared tab state (Identification, MIB Database, Manufacturer Profiles) ───
// Read by server-settings-identification.js, server-settings-mibs.js and
// server-settings-profiles.js, so it lives here in the core, loaded first.

var _tagsLoaded = false;
var _tagsData = [];
var _emptyCategories = [];
var _tagSettings = { enforce: false };
var _ouiOverrides = [];
var _placeholderMac = null;
var _mibsData = [];
var _mibFacets = { manufacturers: [], modelsByManufacturer: {} };
var _manufacturerAliases = [];
var _deviceIcons = [];
// Device Types card: the AssetTypeDef registry with its usage counts, plus the
// matching vocabulary + authoritative-source catalogue the server publishes so
// this file doesn't carry a second copy that drifts from the resolver.
var _assetTypes = [];
// `condition` is the shared condition-builder catalog (fields + operators +
// group operators + labels + depth cap), in the same shape scopeConditionMeta
// publishes for the automations device filter — see _dtConditionMeta.
var _assetTypeMatchSchema = { fields: [], ops: [], contexts: [], condition: null, authoritativeSources: [] };
var _mibFilter = { manufacturer: "", model: "", scope: "all" };
// Slice 6b — editable Manufacturer Profile (DB-backed) state.
// _mfgProfiles is the summary list shown in the card; _mfgProfileTransforms
// is the static transform registry (shipped alongside the summary). Per-
// profile detail (metrics + overrides + widgets) is loaded on-demand into
// _mfgProfileDetail when the operator expands a row.
var _mfgProfiles = [];
var _mfgProfileTransforms = [];
// Binary combiners (CombinerKind on the backend). Populated from the same
// /manufacturer-profiles GET that delivers _mfgProfileTransforms. The
// Transform select swaps option list between transforms and combiners
// based on the row's current Type (double_scalar → combiners; everything
// else → unary transforms).
var _mfgProfileCombiners = [];
// metricKey → the unary transform kinds a SCALAR metric row of that key may
// carry (METRIC_ROW_TRANSFORMS on the backend). _mfgProfileTransforms is the
// custom-widget list; a metric row offers only this subset, and renders no
// Transform select at all when its metric has none — a transform no
// collector applies must not be offered.
var _mfgMetricTransforms = {};
var _mfgProfileDetail = {};         // profileId → full profile (lazy)
var _mfgProfileExpanded = {};       // profileId → bool
var _mfgProfileMetricEdit = {};     // composite key "id:metricKey" → bool (edit-in-progress)
var _mfgProfileOverrideEdit = {};   // overrideId → bool (edit-in-progress on a per-model override row)
var _mfgOverrideAddOpen = {};       // composite key "id:metricKey" → bool (add-override form shown)
// Typeahead values for the "+ Add Manufacturer" box. Lazy — fetched on first
// focus of the input rather than with the tab payload, since the card renders
// on two tabs and most visits never touch the add box. Invalidated after a
// create so the new profile drops out of its own suggestion list.
var _mfgSuggestions = null;         // [{ value, sources[], assetCount }] | null
var _mfgSuggestionsPromise = null;  // in-flight fetch (coalesces rapid focus)
// MIB symbol cache for the chained MIB → Symbol pickers. Lazily populated
// by `_ensureMibSymbols(mibId)` when an operator selects a MIB; results
// are kept across re-renders so the symbol dropdown is instant on second
// open. Cleared when an admin uploads / deletes a MIB elsewhere.
var _mfgMibSymbolsCache = {};       // mibId → { loading: bool, names: string[] }
// Mid-edit MIB selections — when the operator changes a MIB dropdown, the
// new value is parked here so the next re-render can show the symbol
// picker driven by the freshly-selected MIB before the form is saved.
// Cleared when the row exits edit mode (save / cancel).
var _mfgEditMibSelections = {};     // key → mibId (key shape: "metric:{pid}:{mk}" | "override:{oid}" | "new:{pid}:{mk}")
function _mfgEditMibId(profileId, metricKey) {
  return _mfgEditMibSelections["metric:" + profileId + ":" + metricKey];
}
function _mfgOverrideEditMibId(overrideId) {
  return _mfgEditMibSelections["override:" + overrideId];
}
function _mfgNewOverrideMibId(profileId, metricKey) {
  return _mfgEditMibSelections["new:" + profileId + ":" + metricKey];
}

// Mid-edit Type selections — generalized to support `double_scalar`
// alongside the existing scalar / table. Drives the per-row Symbol cell
// (1 or 2 pickers) AND the Transform select's option list (unary
// transforms vs binary combiners). Cleared on save / cancel.
var _mfgEditTypeSelections = {};    // key → "scalar" | "double_scalar" | "table"
function _mfgEditTypeFor(key, fallback) {
  if (key in _mfgEditTypeSelections) return _mfgEditTypeSelections[key];
  return fallback || "scalar";
}

// Per-widget edit state. Key shape: "widget:" + widgetId. Edit mode opens
// when the operator clicks Edit on a widget card; cleared on save / cancel.
var _mfgWidgetEdit = {};
// Per-profile add-widget state. Key shape: profileId. true = the "+ Add
// widget" card below the list is expanded into a form.
var _mfgAddingWidget = {};
// Widget-edit shadow stores (mirror the metric-row shadow pattern). Same
// key-shape convention so the dropdown change handlers can re-render the
// dependent pickers (Symbol depends on MIB + Type; the gauge/line/table
// display options block depends on widgetType). Cleared on save / cancel.
//   _mfgWidgetEditMib[key]        — currently selected MIB (split via splitMibSelection on save)
//   _mfgWidgetEditType[key]       — scalar | table (drives Symbol picker)
//   _mfgWidgetEditWidgetType[key] — gauge | line | table (drives displayOptions sub-editor)
// Key shape: "widget:" + widgetId | "new-widget:" + profileId
var _mfgWidgetEditMib        = {};
var _mfgWidgetEditType       = {};
var _mfgWidgetEditWidgetType = {};
function _mfgWidgetMibFor(key, fallback) {
  if (key in _mfgWidgetEditMib) return _mfgWidgetEditMib[key];
  return fallback || "";
}
function _mfgWidgetTypeFor(key, fallback) {
  if (key in _mfgWidgetEditType) return _mfgWidgetEditType[key];
  return fallback || "scalar";
}
function _mfgWidgetWidgetTypeFor(key, fallback) {
  if (key in _mfgWidgetEditWidgetType) return _mfgWidgetEditWidgetType[key];
  return fallback || "gauge";
}
function _mfgWidgetClearShadow(key) {
  delete _mfgWidgetEditMib[key];
  delete _mfgWidgetEditType[key];
  delete _mfgWidgetEditWidgetType[key];
}
// Type-column labels for the operator-facing dropdown. `double_scalar` is
// the bytes-form pair (two OIDs combined by a binary combiner — replaces
// the memory-only "composition" feature).
var _MFG_TYPE_LABELS = {
  scalar:        "scalar",
  double_scalar: "double scalar",
  table:         "table",
};
// Generic Type select used by every metric row + override. `kinds` controls
// which options are rendered — pass `["scalar","double_scalar","table"]` for
// metric rows, or `["scalar","table"]` for the custom-widget form (widgets
// don't support double_scalar because the resolver wouldn't know how to
// combine the two readings inside the widget render path).
function _typeSelectHTML(cls, current, kinds) {
  var ks = kinds || ["scalar", "double_scalar", "table"];
  var v = current || ks[0];
  var html = '<select class="' + cls + '" style="font-size:0.78rem">';
  ks.forEach(function (k) {
    html += '<option value="' + k + '"' + (v === k ? " selected" : "") + '>' +
      escapeHtml(_MFG_TYPE_LABELS[k] || k) + '</option>';
  });
  html += '</select>';
  return html;
}
// View-mode rendering of the Symbol cell. One OID for scalar/table, two
// stacked labelled OIDs ("A:" + "B:") for double_scalar.
function _symbolCellViewHTML(type, symbol, symbolB) {
  if (type === "double_scalar" && (symbol || symbolB)) {
    return '<div style="display:flex;flex-direction:column;gap:2px">' +
      '<span><code style="font-size:0.85rem">A: ' + escapeHtml(symbol  || "") + '</code></span>' +
      '<span><code style="font-size:0.85rem">B: ' + escapeHtml(symbolB || "") + '</code></span>' +
    '</div>';
  }
  return symbol
    ? '<code style="font-size:0.85rem">' + escapeHtml(symbol) + '</code>'
    : '<span style="color:var(--color-text-tertiary);font-style:italic">(built-in seed)</span>';
}
// Edit-mode rendering of the Symbol cell — 1 picker for scalar/table, 2
// stacked pickers ("A:" + "B:") for double_scalar. Picker classes carry
// the suffix so the save handler can pull them by role.
//   cls + "-a"  — symbol A (also serves the single-symbol scalar/table case)
//   cls + "-b"  — symbol B (double_scalar only)
function _symbolCellEditHTML(type, mibId, symbol, symbolB, cls) {
  function row(label, suffix, val) {
    return '<div style="display:flex;align-items:center;gap:6px;font-size:0.78rem">' +
      '<span style="color:var(--color-text-tertiary);flex:0 0 24px">' + escapeHtml(label) + '</span>' +
      renderSymbolPicker(val, mibId, cls + "-" + suffix) +
    '</div>';
  }
  if (type === "double_scalar") {
    return '<div style="display:flex;flex-direction:column;gap:4px">' +
      row("A:", "a", symbol  || "") +
      row("B:", "b", symbolB || "") +
    '</div>';
  }
  // scalar / table — single picker. The class still carries the "-a" suffix
  // so the save handler can read it uniformly.
  return renderSymbolPicker(symbol || "", mibId, cls + "-a", type);
}
// Pull `{symbol, symbolB}` from an edit-mode <tr>. Returns symbolB=null on
// scalar / table; caller validates required-symbol on the row's type.
function _readSymbolPair(tr, clsBase, type) {
  var a = (tr.querySelector("." + clsBase + "-a") || {}).value || "";
  if (type === "double_scalar") {
    var b = (tr.querySelector("." + clsBase + "-b") || {}).value || "";
    return { symbol: a.trim(), symbolB: b.trim() };
  }
  return { symbol: a.trim(), symbolB: null };
}

