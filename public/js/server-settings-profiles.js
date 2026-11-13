/**
 * public/js/server-settings-profiles.js — the editable Manufacturer Profile
 * card (Identification tab): metric rows and per-model overrides, custom
 * widgets and state probes, scope and readiness, the delegated Symbol
 * combobox, the manufacturer typeaheads, profile export / import, and
 * "Enable on these devices" (business rule 130).
 *
 * Split out of server-settings.js (CQ-F051) as a byte-for-byte move. A plain
 * browser script: its functions and `var`s are page globals; it registers
 * the Symbol combobox's document-level listeners at load. Loads AFTER
 * server-settings.js — tests/unit/serverSettingsSplit.test.ts holds the order.
 */

// ────────────────────────────────────────────────────────────────────────
// Slice 6b — Editable Manufacturer Profile card.
// Renders a per-profile expandable list under Identification. Click the
// caret to load + show the full profile (metrics + per-model overrides);
// inline-edit defaults + add/edit/delete overrides. Custom-widget editor
// lives in Slice 7 (where the asset-details Custom MIB tab consumes it);
// for now we just surface the widget count per profile.
// ────────────────────────────────────────────────────────────────────────

// Keys mirror METRIC_KEYS in src/services/manufacturerProfileService.ts. The
// ORDER rows render in comes from the server (it sorts by that list, which
// follows the asset details slide-over: identity first, then the System tab's
// sections, then the tabs); this map only supplies labels.
var METRIC_KEY_LABELS = {
  model:             "Model identity",
  serial:            "Serial number",
  cpu:               "CPU",
  memory:            "Memory",
  temperature:       "Hardware Sensors",
  interfaces:        "Interfaces",
  lldp:              "LLDP",
  storage:           "Storage",
  wirelessStations:  "Wireless stations",
};

function manufacturerProfilesCardHTML() {
  var html = '<div class="settings-card">' +
    '<h4>Manufacturer Profiles</h4>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.75rem">' +
      'Per-manufacturer SNMP telemetry profile — pick which MIB symbol Polaris walks ' +
      'for each System-tab metric, with optional per-model exceptions. Seeded from the ' +
      'built-in vendor profiles on first boot. Each row’s MIB cell says where its symbol ' +
      'resolves from — or what to upload when it does not: Polaris ships the standard MIBs, ' +
      'a vendor’s MIBs come from you.' +
    '</p>';

  if (_mfgProfiles.length === 0) {
    html += '<p class="empty-state" style="margin-bottom:0.75rem">No manufacturer profiles yet — the seeding job creates one per built-in vendor on first boot.</p>';
  } else {
    html += '<div id="mfg-profiles-list" style="margin-bottom:0.75rem">';
    _mfgProfiles.forEach(function (p) {
      html += renderProfileRow(p);
    });
    html += '</div>';
  }

  // Free-text box with a suggestion dropdown (the .aw-combo idiom, not a
  // <datalist> — most browsers won't open one on click). Any custom name is
  // still accepted; the list only steers toward spellings Polaris already
  // uses, so a new profile actually resolves for the assets that carry it.
  html += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
    '<span class="aw-combo aw-combo-dim" style="flex:1;max-width:280px">' +
      '<input type="text" id="f-mfg-profile-add-name" autocomplete="off" placeholder="Manufacturer (e.g. Aruba)">' +
      '<div class="aw-suggest" id="mfg-profile-add-suggest"></div>' +
    '</span>' +
    '<button class="btn btn-primary" id="btn-add-mfg-profile">+ Add Manufacturer</button>' +
    '<button class="btn btn-secondary" id="btn-import-mfg-profile" title="Import a profile exported from Polaris, choosing which parts to bring in">Import…</button>' +
    '<input type="file" id="f-import-mfg-profile" accept=".json,application/json" style="display:none">' +
  '</div>';

  // Manufacturers of SNMP-answering devices with no profile (business rule
  // 172) — filled after render by _loadUnprofiledManufacturers.
  html += '<div id="mfg-unprofiled" style="margin-top:0.85rem"></div>';

  html += '</div>';
  return html;
}

// ─── Manufacturers without a profile (business rule 172) ─────────────────
// Never created automatically: an empty profile named after a manufacturer
// would take its devices from another profile's "Also applies when" (rule
// 131). Listed instead, one click to create; the rows of a new profile show
// the standard reading until a row is set.
var _mfgUnprofiled = null;   // null = not loaded; [] = none

function _mfgUnprofiledHTML(list) {
  if (!list || !list.length) return "";
  var canWrite = permAtLeast("manufacturerProfiles", "write");
  var html = '<div style="font-size:0.78rem;font-weight:600;color:var(--color-text-secondary);margin-bottom:4px">Manufacturers without a profile</div>' +
    '<p style="font-size:0.76rem;color:var(--color-text-tertiary);margin:0 0 6px">Devices that answer SNMP and are read with the standard MIBs only. ' +
      'Create a profile to point a metric, a model or serial row or a custom widget at a vendor MIB.</p>' +
    '<table class="ip-table" style="margin-bottom:0"><thead><tr><th>Manufacturer</th><th style="width:90px">Devices</th><th>Covered by</th><th style="width:110px"></th></tr></thead><tbody>';
  list.forEach(function (m) {
    html += '<tr data-manufacturer="' + escapeHtml(m.manufacturer) + '">' +
      '<td><b>' + escapeHtml(m.manufacturer) + '</b></td>' +
      '<td>' + m.assetCount + '</td>' +
      '<td style="font-size:0.78rem;color:var(--color-text-secondary)">' +
        (m.coveredBy
          ? escapeHtml(m.coveredBy.manufacturer) + ' <span title="That profile\'s &quot;Also applies when&quot; pattern matches this name. A profile named after this manufacturer would take these devices from it.">(Also applies when) ⚠</span>'
          : '—') +
      '</td>' +
      '<td>' + (canWrite
        ? '<button type="button" class="btn btn-sm btn-primary mfg-unprofiled-create" data-manufacturer="' + escapeHtml(m.manufacturer) + '"' +
            (m.coveredBy ? ' title="Creates a ' + escapeHtml(m.manufacturer) + ' profile. Its devices then leave the ' + escapeHtml(m.coveredBy.manufacturer) + ' profile."' : '') + '>Create profile</button>'
        : '') + '</td>' +
    '</tr>';
  });
  return html + '</tbody></table>';
}

function _loadUnprofiledManufacturers() {
  var mount = document.getElementById("mfg-unprofiled");
  if (!mount) return;
  if (_mfgUnprofiled !== null) { mount.innerHTML = _mfgUnprofiledHTML(_mfgUnprofiled); return; }
  api.serverSettings.listUnprofiledManufacturers().then(function (resp) {
    _mfgUnprofiled = (resp && resp.manufacturers) || [];
    var m = document.getElementById("mfg-unprofiled");
    if (m) m.innerHTML = _mfgUnprofiledHTML(_mfgUnprofiled);
  }).catch(function () { /* the list is a convenience; the card works without it */ });
}

// What an EMPTY row reads (no symbol set): the standard MIB, named so the
// operator sees what is in use and only types over what they mean to change.
// Not copied into the row — a release that improves a default reaches every
// row left empty (rule 68).
var _MFG_STANDARD_READING = {
  model:            "ENTITY-MIB entPhysicalModelName (or a vendor sysDescr)",
  serial:           "ENTITY-MIB entPhysicalSerialNum (or a vendor sysDescr)",
  cpu:              "HOST-RESOURCES-MIB hrProcessorLoad (average)",
  memory:           "HOST-RESOURCES-MIB hrStorage (RAM row)",
  temperature:      "ENTITY-SENSOR-MIB entPhySensorValue",
  interfaces:       "IF-MIB ifTable + ifXTable",
  storage:          "HOST-RESOURCES-MIB hrStorage (disk rows)",
  lldp:             "LLDP-MIB lldpRemTable",
  wirelessStations: "FortiAP station table (fapSta…)",
};
function _mfgStandardReadingHTML(metricKey) {
  var std = _MFG_STANDARD_READING[metricKey];
  if (!std) return '<span style="color:var(--color-text-tertiary);font-style:italic">(built-in seed)</span>';
  return '<span style="color:var(--color-text-tertiary);font-style:italic" title="No symbol set on this row: the standard MIB answers. Edit the row to override it.">Standard: ' + escapeHtml(std) + '</span>';
}

function renderProfileRow(p) {
  var isOpen = !!_mfgProfileExpanded[p.id];
  var caret = isOpen ? "▼" : "▶";
  var html = '<div class="mfg-profile-row" data-profile-id="' + escapeHtml(p.id) + '" style="border:1px solid var(--color-border);border-radius:4px;margin-bottom:6px;background:var(--color-bg-secondary,rgba(0,0,0,0.04))">' +
    '<div class="mfg-profile-header" style="display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer">' +
      '<span class="mfg-profile-caret" style="font-family:var(--font-mono);font-size:0.75rem;width:14px">' + caret + '</span>' +
      '<span style="font-weight:600;flex:1">' + escapeHtml(p.manufacturer) + _mfgReadinessPillHTML(p) + '</span>' +
      '<span style="font-size:0.74rem;color:var(--color-text-secondary)">' +
        p.metricCount + ' metric' + (p.metricCount === 1 ? '' : 's') + ' · ' +
        p.overrideCount + ' override' + (p.overrideCount === 1 ? '' : 's') + ' · ' +
        p.widgetCount + ' widget' + (p.widgetCount === 1 ? '' : 's') + ' · ' +
        p.scopedMibCount + ' MIB' + (p.scopedMibCount === 1 ? '' : 's') +
      '</span>' +
      '<button class="btn btn-sm mfg-profile-code" data-id="' + escapeHtml(p.id) + '" title="View, edit, save or export this profile as JSON">View Code</button>' +
      '<button class="btn btn-sm btn-danger mfg-profile-del" data-id="' + escapeHtml(p.id) + '" title="Delete profile">Del</button>' +
    '</div>' +
    '<div class="mfg-profile-body" id="mfg-profile-body-' + escapeHtml(p.id) + '" style="' + (isOpen ? '' : 'display:none') + '">' +
      (isOpen && _mfgProfileDetail[p.id] ? renderProfileDetail(_mfgProfileDetail[p.id]) : (isOpen ? '<p class="empty-state" style="padding:0.75rem">Loading…</p>' : '')) +
    '</div>' +
  '</div>';
  return html;
}

function renderProfileDetail(detail) {
  var html = '<div style="padding:8px 12px 12px;border-top:1px solid var(--color-border)">';
  html += '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-bottom:6px">' +
    'Each row is one System-tab metric. The <b>Default</b> column is what Polaris walks for ' +
    'every asset under this profile; a device type narrows that, and a model regex narrows it again.' +
  '</div>';
  html += _mfgMatchPatternHTML(detail);
  html += '<table class="ip-table" style="margin-bottom:8px"><thead><tr>' +
    '<th style="width:8%">Metric</th>' +
    '<th style="width:10%">Device type</th>' +
    '<th style="width:11%">Model</th>' +
    '<th style="width:16%">MIB</th>' +
    '<th style="width:9%">Type</th>' +
    '<th>Symbol</th>' +
    '<th style="width:11%">Transform</th>' +
    '<th style="width:140px">Action</th>' +
  '</tr></thead><tbody>';

  detail.metrics.forEach(function (m) {
    var editKey = detail.id + ":" + m.metricKey;
    var editing = !!_mfgProfileMetricEdit[editKey];
    html += '<tr data-profile-id="' + escapeHtml(detail.id) + '" data-metric-key="' + escapeHtml(m.metricKey) + '">' +
      '<td><b>' + escapeHtml(METRIC_KEY_LABELS[m.metricKey] || m.metricKey) + '</b></td>' +
      // DEVICE TYPE + MODEL columns for the profile-wide default row: the
      // entry the resolver falls back to when no device-type default and no
      // per-model exception matches, so both halves of its scope read "any".
      // Scoped rows fill these columns with their own device type / pattern.
      '<td>' + _mfgScopeBadge("ANY") + '</td>' +
      '<td>' + _mfgScopeBadge("DEFAULT") + '</td>';
    if (editing) {
      // Use the row's current MIB selection (if the operator has changed
      // it during this edit session it lives in the shadow store via the
      // change handler that also pre-warms `_mfgMibSymbolsCache`). For
      // first render fall back to the persisted defaultMibId /
      // defaultMibStdKey (joined into a single combined dropdown value).
      // Check `=== undefined` rather than truthiness so an explicit `""`
      // (operator picked "Built-in seed" to reset) is preserved instead of
      // being clobbered by the persisted value on re-render.
      var storedEditMib = _mfgEditMibId(detail.id, m.metricKey);
      var editMibId = (storedEditMib === undefined)
        ? joinMibSelection(m.defaultMibId, m.defaultMibStdKey)
        : storedEditMib;
      // Column order: MIB · Type · Symbol · Transform. Type picks first so
      // the Symbol cell renders 1 or 2 pickers and the Transform list
      // swaps between unary transforms and binary combiners.
      var editType = _mfgEditTypeFor("metric:" + detail.id + ":" + m.metricKey, m.defaultType);
      html +=
        '<td>' + renderMibSelect(editMibId, "mfg-edit-mib", detail.manufacturer) + '</td>' +
        '<td>' + renderTypeSelect(editType, "mfg-edit-type") + '</td>' +
        '<td>' + _symbolCellEditHTML(editType, editMibId, m.defaultSymbol, m.defaultSymbolB, "mfg-edit-sym") +
          _mfgExtraEditHTML(m.metricKey, "mfg-edit", { aggregate: m.defaultAggregate, label: m.defaultLabel, parsePattern: m.defaultParsePattern, parseTemplate: m.defaultParseTemplate, sensorColumns: m.defaultSensorColumns }) + '</td>' +
        '<td>' + renderTransformSelect(m.defaultTransform, "mfg-edit-transform", editType, m.metricKey) + '</td>' +
        '<td><button class="btn btn-sm btn-primary mfg-metric-save">Save</button> ' +
          '<button class="btn btn-sm btn-secondary mfg-metric-cancel">Cancel</button></td>';
    } else {
      var defaultDisplay = (!m.defaultSymbol && !m.defaultSymbolB)
        ? _mfgStandardReadingHTML(m.metricKey)
        : _symbolCellViewHTML(m.defaultType, m.defaultSymbol, m.defaultSymbolB);
      // The MIB cell is PROVENANCE, not the operator's pick: where the row's
      // symbol actually resolves from at this manufacturer's scope (module +
      // layer), or what to upload when it does not. The pinned MIB / std hint
      // is what the operator chose; the server's readiness is what is true.
      var mibDisplay = _mfgMibCellHTML(m.readiness, m.defaultMibId, m.defaultMibStdKey);
      var typeLabel = _MFG_TYPE_LABELS[m.defaultType] || m.defaultType;
      html +=
        '<td>' + mibDisplay + '</td>' +
        '<td><span style="font-size:0.78rem">' + escapeHtml(typeLabel) + '</span></td>' +
        '<td>' + defaultDisplay + _mfgExtraViewHTML(m.metricKey, { aggregate: m.defaultAggregate, label: m.defaultLabel, parsePattern: m.defaultParsePattern, parseTemplate: m.defaultParseTemplate, sensorColumns: m.defaultSensorColumns }) + '</td>' +
        '<td><span style="font-size:0.78rem;color:var(--color-text-secondary)">' + (m.defaultTransform ? escapeHtml(transformLabel(m.defaultTransform)) : "—") + '</span></td>' +
        '<td style="white-space:nowrap"><button class="btn btn-sm btn-secondary mfg-metric-edit">Edit</button> ' +
          '<button class="btn btn-sm btn-primary mfg-override-add-open" title="Add a device-type default or model exception for this metric">Add</button></td>';
    }
    html += '</tr>';

    // Scoped rows hang under the metric row, grouped so the hierarchy reads
    // top-down: each device type's default followed by that type's model
    // exceptions, then the model exceptions that apply to any device type.
    _mfgGroupOverrides(m.overrides).forEach(function (o) {
      html += renderOverrideRow(detail.id, m.metricKey, o, detail.manufacturer);
    });
    // Add-override form — single inline row (Model · Symbol · MIB · Type ·
    // Transform · Add) sized so wrap is rare on the typical Identification
    // tab width. Each cell of the parent table gets its own field so the
    // columns line up vertically with the metric row above. Drawn only after
    // the metric row's Add button opens it, so the table reads as a list.
    if (!_mfgOverrideAddOpen[editKey]) return;
    var newMibId = _mfgNewOverrideMibId(detail.id, m.metricKey) || null;
    // Add-override row layout matches the override view + edit rows:
    //   METRIC (blank) · MODEL (↳ add label + pattern input) · MIB · TYPE · SYMBOL · TRANSFORM · ACTION
    // A device type with no pattern adds that type's DEFAULT; a pattern with
    // no device type adds a model exception for every type; both together
    // add a model exception under that type.
    var newTypeCell = '<td>' + _mfgDeviceTypeSelect(null, "mfg-new-override-assettype") + '</td>';
    var newPatternCell =
      '<td style="padding-left:20px"><div style="display:flex;align-items:center;gap:4px">' +
        '<span style="color:var(--color-text-tertiary);font-size:0.74rem">↳ add</span>' +
        '<input type="text" class="mfg-new-override-pattern" placeholder="Model regex (optional)" style="flex:1;font-size:0.78rem">' +
      '</div></td>';
    var newType = _mfgEditTypeFor("new:" + detail.id + ":" + m.metricKey, "scalar");
    html += '<tr class="mfg-add-override-row" data-profile-id="' + escapeHtml(detail.id) + '" data-metric-key="' + escapeHtml(m.metricKey) + '" style="background:var(--color-bg-primary)">' +
      '<td></td>' +
      newTypeCell +
      newPatternCell +
      '<td>' + renderMibSelect(newMibId, "mfg-new-override-mib", detail.manufacturer, true) + '</td>' +
      '<td>' + renderTypeSelect(newType, "mfg-new-override-type") + '</td>' +
      '<td>' + _symbolCellEditHTML(newType, newMibId, "", "", "mfg-new-override-sym") +
        _mfgExtraEditHTML(m.metricKey, "mfg-new-override", {}) + '</td>' +
      '<td>' + renderTransformSelect(null, "mfg-new-override-transform", newType, m.metricKey) + '</td>' +
      '<td style="white-space:nowrap"><button class="btn btn-sm btn-primary mfg-override-add">Add</button> ' +
        '<button class="btn btn-sm btn-secondary mfg-override-add-cancel">Cancel</button></td>' +
    '</tr>';
  });
  html += '</tbody></table>';
  // ─── Custom widgets section ──────────────────────────────────────────
  // Each widget here renders on the asset details Custom MIB tab for every
  // asset whose alias-normalized manufacturer matches this profile (and
  // whose model satisfies the optional per-widget gate). Polaris probes
  // each widget on the telemetry cadence; the asset tab reads the latest
  // sample from AssetCustomWidgetSample.
  html += renderWidgetSection(detail);
  html += '</div>';
  return html;
}

// ─── Widget section + per-widget card renderers ────────────────────────
// Cards layout — one per widget — instead of a wide table. The metric
// table already eats most of the horizontal real estate; cramming 8-10
// fields per row here would force wrapping that breaks scan-ability.
// Each card has a compact view mode and an inline-expanded edit mode.

var WIDGET_TYPE_LABELS = {
  gauge: "Gauge", line: "Line chart", value: "Value", table: "Table",
  state: "State (0/1)", http: "HTTP check",
};
var WIDGET_TYPE_ORDER  = ["gauge", "line", "value", "table", "state", "http"];

// ─── State probes (widgetType "state") ──────────────────────────────────
// A status-shaped OID rather than a gauge: an alarm bit, a PSU present flag, a
// fan-tray OK register. The operator declares how a reading becomes true so
// Polaris never has to guess a vendor's polarity (SNMPv2 TruthValue is
// true(1)/false(2), plenty of enums use 2 for the bad state, some agents answer
// strings). Mirrors STATE_MAP_MODES in src/utils/stateProbes.ts — keep in step.
var STATE_MODE_LABELS = {
  nonzero:   "value is not 0  (plain alarm bit)",
  zero:      "value is 0  (inverted / health register)",
  equals:    "value is one of…",
  notEquals: "value is anything EXCEPT…",
  gte:       "value is ≥ …",
  lte:       "value is ≤ …",
};
var STATE_MODE_ORDER = ["nonzero", "zero", "equals", "notEquals", "gte", "lte"];
var STATE_MODES_WITH_VALUES = ["equals", "notEquals", "gte", "lte"];

// The widget list: by Order, then NEWEST FIRST, so a widget just added lands
// at the top where the operator is looking rather than wherever its name
// sorts (2026-11-13). Name breaks a tie between rows with no creation time.
function _mfgWidgetListOrder(widgets) {
  return (widgets || []).slice().sort(function (a, b) {
    if ((a.order || 0) !== (b.order || 0)) return (a.order || 0) - (b.order || 0);
    var ta = a.createdAt || "", tb = b.createdAt || "";
    if (ta !== tb) return ta < tb ? 1 : -1;
    return (a.name || "").localeCompare(b.name || "");
  });
}

function renderWidgetSection(detail) {
  var widgets = _mfgWidgetListOrder(detail.widgets);
  var html = '<div style="margin-top:18px">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">' +
      '<h5 style="margin:0;font-size:0.9rem;font-weight:600">Custom widgets</h5>' +
      (_mfgAddingWidget[detail.id]
        ? '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">New widget…</span>'
        : '<button class="btn btn-sm mfg-widget-add-toggle" data-profile-id="' + escapeHtml(detail.id) + '">+ Add Widget</button>') +
    '</div>' +
    '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-bottom:8px">' +
      'Widgets render on the asset details <b>Custom MIB</b> tab for every asset whose manufacturer matches ' +
      'this profile. Each widget walks its symbol against the chosen MIB on the telemetry cadence.' +
    '</div>';
  if (widgets.length === 0 && !_mfgAddingWidget[detail.id]) {
    html += '<p class="empty-state" style="padding:0.5rem 0;margin:0;font-size:0.82rem">No widgets defined yet.</p>';
  }
  if (_mfgAddingWidget[detail.id]) {
    html += renderAddWidgetCard(detail.id, detail.manufacturer);
  }
  widgets.forEach(function (w) {
    html += renderWidgetCard(detail.id, w, detail.manufacturer);
  });
  html += '</div>';
  return html;
}

function renderWidgetCard(profileId, w, manufacturer) {
  if (_mfgWidgetEdit[w.id]) return renderWidgetEditCard(profileId, w, manufacturer);
  // View mode — single compact card.
  var mibLabel = w.mibId
    ? _mfgLookupMibLabel(w.mibId)
    : '<span style="color:var(--color-text-tertiary);font-style:italic">(no MIB)</span>';
  var modelLabel = w.modelPattern
    ? '<code style="font-size:0.78rem">' + escapeHtml(w.modelPattern) + '</code>'
    : '<span style="color:var(--color-text-tertiary)">any model</span>';
  var transformLabel_ = w.transform ? escapeHtml(transformLabel(w.transform)) : "—";
  var optsLabel = _widgetOptionsSummary(w);
  return '<div class="mfg-widget-card" data-profile-id="' + escapeHtml(profileId) + '" data-widget-id="' + escapeHtml(w.id) + '" style="border:1px solid var(--color-border);border-radius:6px;padding:8px 10px;margin-bottom:6px;background:var(--color-bg-primary)">' +
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">' +
      '<span style="font-weight:600">' + escapeHtml(w.name) + '</span>' +
      '<span style="font-size:0.72rem;color:var(--color-text-tertiary);text-transform:uppercase;letter-spacing:0.04em">' + escapeHtml(WIDGET_TYPE_LABELS[w.widgetType] || w.widgetType) + '</span>' +
      '<span style="flex:1"></span>' +
      // Which assets poll this widget (business rule 130). Needs assets write
      // on top of the profile key, like the server route.
      (permAtLeast("assets", "write") ? '<button class="btn btn-sm mfg-widget-devices" title="Choose which devices poll this widget">Devices…</button> ' : '') +
      '<button class="btn btn-sm mfg-widget-edit">Edit</button>' +
      ' <button class="btn btn-sm btn-danger mfg-widget-del">Del</button>' +
    '</div>' +
    '<div style="font-size:0.78rem;color:var(--color-text-secondary);display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:4px 12px">' +
      '<span><b>MIB:</b> ' + mibLabel + '</span>' +
      '<span><b>Symbol:</b> <code style="font-size:0.78rem">' + escapeHtml(w.symbol) + '</code> <span style="color:var(--color-text-tertiary)">(' + escapeHtml(w.type) + ')</span></span>' +
      '<span><b>Model:</b> ' + modelLabel + '</span>' +
      '<span><b>Transform:</b> ' + transformLabel_ + '</span>' +
      (w.widgetType === "state"
        ? '<span style="grid-column:1/-1"><b>State:</b> ' + escapeHtml(_stateMapSummary(w.stateMap)) +
          (w.labelSymbol ? ' · rows named by <code style="font-size:0.78rem">' + escapeHtml(w.labelSymbol) + '</code>' : '') + '</span>'
        : (optsLabel ? '<span style="grid-column:1/-1"><b>Display:</b> ' + optsLabel + '</span>' : '')) +
    '</div>' +
  '</div>';
}

/** Plain-English mapping summary for the probe card. The modes are the ones
 *  evaluateStateMap in src/utils/stateProbes.ts reads; tested in
 *  tests/unit/serverSettingsProfiles.stateMapSummary.test.ts. */
function _stateMapSummary(m) {
  if (!m) return "no mapping";
  var t = m.trueLabel || "Alarm";
  var f = m.falseLabel || "OK";
  var vals = Array.isArray(m.values) ? m.values.join(", ") : "";
  switch (m.mode) {
    case "zero":      return t + " when the value is 0, " + f + " otherwise";
    case "equals":    return t + " when the value is " + vals + ", " + f + " otherwise";
    case "notEquals": return f + " when the value is " + vals + ", " + t + " otherwise";
    case "gte":       return t + " when the value is " + vals + " or more, " + f + " below that";
    case "lte":       return t + " when the value is " + vals + " or less, " + f + " above that";
    default:          return t + " when the value is not 0, " + f + " when it is 0";
  }
}

function renderWidgetEditCard(profileId, w, manufacturer) {
  var key = "widget:" + w.id;
  var storedMib = _mfgWidgetMibFor(key, joinMibSelection(w.mibId, null));
  var storedType = _mfgWidgetTypeFor(key, w.type);
  var storedWidgetType = _mfgWidgetWidgetTypeFor(key, w.widgetType);
  return _renderWidgetFormCard({
    profileId:        profileId,
    formClass:        "mfg-widget-edit-card",
    dataAttrs:        ' data-widget-id="' + escapeHtml(w.id) + '"',
    title:            "Edit widget",
    nameValue:        w.name,
    modelValue:       w.modelPattern || "",
    orderValue:       (w.order != null) ? w.order : 0,
    mibSelected:      storedMib,
    typeSelected:     storedType,
    widgetTypeSelected: storedWidgetType,
    symbolValue:      w.symbol || "",
    transformValue:   w.transform,
    displayOptions:   w.displayOptions || {},
    stateMap:         w.stateMap || null,
    labelSymbol:      w.labelSymbol || "",
    httpCheck:        w.httpCheck || null,
    credentialId:     w.credentialId || "",
    manufacturer:     manufacturer,
    saveBtnClass:     "mfg-widget-save",
    cancelBtnClass:   "mfg-widget-cancel",
    saveBtnLabel:     "Save",
  });
}

function renderAddWidgetCard(profileId, manufacturer) {
  var key = "new-widget:" + profileId;
  var storedMib = _mfgWidgetMibFor(key, "");
  var storedType = _mfgWidgetTypeFor(key, "scalar");
  var storedWidgetType = _mfgWidgetWidgetTypeFor(key, "gauge");
  return _renderWidgetFormCard({
    profileId:        profileId,
    formClass:        "mfg-widget-add-card",
    dataAttrs:        '',
    title:            "New widget",
    nameValue:        "",
    modelValue:       "",
    orderValue:       0,
    mibSelected:      storedMib,
    typeSelected:     storedType,
    widgetTypeSelected: storedWidgetType,
    symbolValue:      "",
    transformValue:   null,
    displayOptions:   {},
    stateMap:         null,
    labelSymbol:      "",
    httpCheck:        null,
    credentialId:     "",
    manufacturer:     manufacturer,
    saveBtnClass:     "mfg-widget-add-save",
    cancelBtnClass:   "mfg-widget-add-cancel",
    saveBtnLabel:     "Add widget",
  });
}

// Shared form renderer for both Edit and Add. Field IDs/classes are the
// same in both modes — the save handler dispatches off the form's outer
// class (mfg-widget-edit-card vs mfg-widget-add-card) instead of unique
// per-field selectors.
function _renderWidgetFormCard(o) {
  var snmpHidden = o.widgetTypeSelected === "http";
  var html = '<div class="' + o.formClass + '" data-profile-id="' + escapeHtml(o.profileId) + '"' + o.dataAttrs + ' style="border:1px solid var(--color-primary,#4fc3f7);border-radius:6px;padding:10px 12px;margin-bottom:6px;background:var(--color-bg-secondary,rgba(127,127,127,0.04))">' +
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
      '<span style="font-weight:600;font-size:0.85rem">' + escapeHtml(o.title) + '</span>' +
      '<span style="flex:1"></span>' +
      '<button class="btn btn-sm btn-primary ' + o.saveBtnClass + '">' + escapeHtml(o.saveBtnLabel) + '</button>' +
      ' <button class="btn btn-sm ' + o.cancelBtnClass + '">Cancel</button>' +
    '</div>' +
    // Field grid — name + widget-type + MIB + symbol-type + symbol + transform + model + order
    '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px">' +
      _widgetFormField("Name *",
        '<input type="text" class="mfg-widget-name" value="' + escapeHtml(o.nameValue) + '" placeholder="e.g. Connected wireless clients" style="width:100%;font-size:0.82rem">') +
      _widgetFormField("Widget type",
        _widgetTypeSelectHTML("mfg-widget-widgettype", o.widgetTypeSelected)) +
      // The SNMP quartet is hidden (not removed) on an http widget: the check
      // names a request, not an OID. Hidden rather than removed so a
      // typed-then-reconsidered symbol survives flipping the type back and
      // forth before save — the same reasoning as the monitor-settings rows.
      _widgetFormField("MIB *",
        renderMibSelect(o.mibSelected, "mfg-widget-mib", o.manufacturer, true), snmpHidden) +
      _widgetFormField("Symbol type",
        renderWidgetTypeSelect(o.typeSelected, "mfg-widget-type"), snmpHidden) +
      _widgetFormField("Symbol *",
        renderSymbolPicker(o.symbolValue, o.mibSelected, "mfg-widget-symbol", o.typeSelected), snmpHidden) +
      _widgetFormField("Transform",
        renderTransformSelect(o.transformValue, "mfg-widget-transform"), snmpHidden) +
      _widgetFormField("Model regex (optional)",
        '<input type="text" class="mfg-widget-model" value="' + escapeHtml(o.modelValue) + '" placeholder="e.g. FortiAP-231F" style="width:100%;font-size:0.82rem">') +
      _widgetFormField("Order",
        '<input type="number" class="mfg-widget-order" value="' + escapeHtml(String(o.orderValue)) + '" min="0" step="1" style="width:100%;font-size:0.82rem">') +
    '</div>' +
    // A state probe's second block is its true/false mapping, not display
    // options — the mapping is what makes the probe alertable, so it takes the
    // prominent slot rather than hiding behind a gauge's min/max.
    '<div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--color-border)">' +
      (o.widgetTypeSelected === "http"
        ? '<div style="font-size:0.78rem;font-weight:600;margin-bottom:6px">HTTP check</div>' +
          _widgetHttpCheckForm(o.httpCheck, o.credentialId)
        : o.widgetTypeSelected === "state"
        ? '<div style="font-size:0.78rem;font-weight:600;margin-bottom:6px">State mapping</div>' +
          _widgetStateOptionsForm(o.stateMap, o.labelSymbol, o.typeSelected)
        : '<div style="font-size:0.78rem;font-weight:600;margin-bottom:6px">Display options</div>' +
          _widgetDisplayOptionsForm(o.widgetTypeSelected, o.displayOptions)) +
    '</div>' +
  '</div>';
  return html;
}

/**
 * The state-probe mapping sub-form. Everything here is operator-declared because
 * no part of it can be inferred from the MIB: which raw values mean "bad", what
 * to call the two states, which side is the interesting one, and (for a table)
 * which sibling column names the rows.
 */
function _widgetStateOptionsForm(stateMap, labelSymbol, symbolType) {
  var m = stateMap || {};
  var mode = m.mode || "nonzero";
  var values = Array.isArray(m.values) ? m.values.join(", ") : "";
  var needsValues = STATE_MODES_WITH_VALUES.indexOf(mode) !== -1;
  var modeOpts = STATE_MODE_ORDER.map(function (k) {
    return '<option value="' + k + '"' + (mode === k ? " selected" : "") + '>' + escapeHtml(STATE_MODE_LABELS[k]) + '</option>';
  }).join("");
  return '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px">' +
    _widgetFormField("True when",
      '<select class="mfg-widget-statemode" style="width:100%;font-size:0.82rem">' + modeOpts + '</select>') +
    _widgetFormField("Comparison value(s)",
      '<input type="text" class="mfg-widget-statevalues" value="' + escapeHtml(values) + '" placeholder="comma-separated, e.g. 2, alarm" style="width:100%;font-size:0.82rem"' +
        (needsValues ? "" : " disabled") + '>') +
    _widgetFormField("Label for the true state",
      '<input type="text" class="mfg-widget-statetrue" value="' + escapeHtml(m.trueLabel || "Alarm") + '" maxlength="32" placeholder="Alarm" style="width:100%;font-size:0.82rem">') +
    _widgetFormField("Label for the false state",
      '<input type="text" class="mfg-widget-statefalse" value="' + escapeHtml(m.falseLabel || "OK") + '" maxlength="32" placeholder="OK" style="width:100%;font-size:0.82rem">') +
    _widgetFormField("Row-name symbol (optional, tables)",
      '<input type="text" class="mfg-widget-labelsymbol" value="' + escapeHtml(labelSymbol || "") + '" placeholder="e.g. fgHwSensorEntName" style="width:100%;font-size:0.82rem"' +
        (symbolType === "table" ? "" : " disabled") + '>') +
    '<label style="display:flex;align-items:center;gap:6px;font-size:0.74rem;color:var(--color-text-secondary)">' +
      '<input type="checkbox" class="mfg-widget-stateproblem"' + (m.trueIsProblem === false ? "" : " checked") + '>' +
      '<span>The true state is the problem</span>' +
    '</label>' +
  '</div>' +
  '<p style="font-size:0.74rem;color:var(--color-text-tertiary);margin:8px 0 0">' +
    'Readings are stored as 0/1 using this mapping, so an automation can alert on the state directly. ' +
    'A table probe produces one independent flag per row — give it a row-name symbol from the same table ' +
    '(joined on the OID index) or rows will only be identifiable by index, which differs per model. ' +
    'A value the mapping can\'t compare is recorded as no reading rather than as healthy.' +
  '</p>';
}

function _widgetFormField(label, controlHTML, hidden) {
  // `hidden` keeps a field in the DOM but out of sight — used for the SNMP
  // quartet on an http widget, which names a request rather than an OID.
  // Hidden rather than omitted so the shadow store still finds the inputs and a
  // typed-then-reconsidered symbol survives flipping the type back and forth
  // before save (the monitor-settings precedent).
  var style = 'display:flex;flex-direction:column;gap:2px;font-size:0.74rem;color:var(--color-text-secondary)';
  if (hidden) style = 'display:none';
  return '<label style="' + style + '">' +
    '<span>' + escapeHtml(label) + '</span>' +
    controlHTML +
  '</label>';
}

/**
 * The HTTP-check sub-form — the check definition that used to live on an `http`
 * credential. It sits on the manufacturer profile because a check varies by
 * vendor AND MODEL (every Axis camera answers the same VAPIX path) while a
 * login varies by vendor or site; keeping both on a credential meant a second
 * path needed a second copy of the same password.
 *
 * "Applies to" is the existing `modelPattern` field in the grid above — blank
 * means every asset of this manufacturer, which is the common case and is why
 * the hint says so rather than leaving an empty box to interpret.
 */
function _widgetHttpCheckForm(check, credentialId) {
  var c = check || {};
  var creds = (_credentialCache.list || []).filter(function (x) { return x.type === "http"; });
  var opts = '<option value="">None — unauthenticated</option>';
  creds.forEach(function (x) {
    opts += '<option value="' + escapeHtml(x.id) + '"' + (credentialId === x.id ? " selected" : "") + '>' + escapeHtml(x.name) + '</option>';
  });
  var mode = c.matchMode === "regex" ? "regex" : "contains";
  return '' +
    '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px">' +
      _widgetFormField("Credential",
        '<select class="mfg-http-cred" style="width:100%;font-size:0.82rem">' + opts + '</select>') +
      _widgetFormField("Path",
        '<input type="text" class="mfg-http-path" value="' + escapeHtml(c.path || "") + '" placeholder="/healthz" style="width:100%;font-size:0.82rem">') +
      // Same opt-in shape as the Test Connection modal: the scheme implies a
      // port, so the field is disabled until an operator says otherwise. A
      // stored port IS a custom port, which is what pre-ticks the box.
      _widgetFormField("Port",
        '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:0.8rem;margin-bottom:3px">' +
          '<input type="checkbox" class="mfg-http-customport"' + (c.port ? " checked" : "") + '><span>Custom port</span>' +
        '</label>' +
        '<input type="number" class="mfg-http-port" value="' + escapeHtml(c.port ? String(c.port) : "") + '" min="1" max="65535" ' +
          'placeholder="default (' + (c.useHttps === true ? "443" : "80") + ')" style="width:100%;font-size:0.82rem"' +
          (c.port ? "" : " disabled") + '>') +
      _widgetFormField("Expected status",
        '<input type="number" class="mfg-http-status" value="' + escapeHtml(c.expectStatus ? String(c.expectStatus) : "") + '" min="100" max="599" placeholder="any 2xx" style="width:100%;font-size:0.82rem">') +
      _widgetFormField("Match",
        '<select class="mfg-http-matchmode" style="width:100%;font-size:0.82rem">' +
          '<option value="contains"' + (mode === "contains" ? " selected" : "") + '>Contains</option>' +
          '<option value="regex"' + (mode === "regex" ? " selected" : "") + '>Regex</option>' +
        '</select>' +
        '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:0.8rem;margin-top:4px">' +
          '<input type="checkbox" class="mfg-http-casesensitive"' + (c.caseSensitive === true ? " checked" : "") + '>' +
          '<span>Case sensitive</span>' +
        '</label>') +
      _widgetFormField("Expected content",
        '<input type="text" class="mfg-http-body" value="' + escapeHtml(c.expectBody || "") + '" placeholder="e.g. OK" style="width:100%;font-size:0.82rem">') +
    '</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:8px;font-size:0.8rem">' +
      '<label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" class="mfg-http-https"' + (c.useHttps === true ? " checked" : "") + '><span>Use HTTPS</span></label>' +
      '<label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" class="mfg-http-verifytls"' + (c.verifyTls === true ? " checked" : "") + '><span>Verify TLS</span></label>' +
    '</div>' +
    '<p class="hint" style="margin-top:8px">Records a pass/fail 0/1 (alertable as <strong>Custom state value</strong>) plus the response time — a wrong status code or missing content is recorded as a failure, and it is an <strong>automation</strong> that decides whether that means the device is down. Leave <strong>Model regex</strong> above blank to check every ' + '' + 'device of this manufacturer. Dial the check in against a real device from <strong>Credentials → Test Connection</strong> first.</p>';
}

/** Collect the HTTP-check sub-form. Blank numbers mean "use the default". */
function _readWidgetHttpCheck(scope) {
  function val(cls) { var el = scope.querySelector(cls); return el ? el.value : ""; }
  function chk(cls) { var el = scope.querySelector(cls); return !!(el && el.checked); }
  function numOrNull(cls) { var v = (val(cls) || "").trim(); return v ? Number(v) : null; }
  return {
    useHttps:       chk(".mfg-http-https"),
    // Un-ticked Custom port sends null, so clearing the override actually
    // returns the check to the scheme default.
    port:           chk(".mfg-http-customport") ? numOrNull(".mfg-http-port") : null,
    path:           (val(".mfg-http-path") || "").trim(),
    expectStatus:   numOrNull(".mfg-http-status"),
    expectBody:     val(".mfg-http-body"),
    matchMode:      val(".mfg-http-matchmode") || "contains",
    caseSensitive:  chk(".mfg-http-casesensitive"),
    verifyTls:      chk(".mfg-http-verifytls"),
  };
}

function _widgetTypeSelectHTML(cls, current) {
  var v = current || "gauge";
  var html = '<select class="' + cls + '" style="width:100%;font-size:0.82rem">';
  WIDGET_TYPE_ORDER.forEach(function (k) {
    html += '<option value="' + k + '"' + (v === k ? " selected" : "") + '>' + escapeHtml(WIDGET_TYPE_LABELS[k]) + '</option>';
  });
  html += '</select>';
  return html;
}

// Per-widgetType displayOptions sub-form. Fields match what the asset
// Custom MIB tab consumes today:
//   gauge → min, max, unit, warningAt + criticalAt + warningWhen
//   line  → unit, warningAt + criticalAt + warningWhen
//   value → unit, warningAt + criticalAt + warningWhen
//   table → no operator-tunable options; the renderer derives columns
//           from the latest sample.
// warningAt / criticalAt / warningWhen are the widget's own LEVELS (business
// rule 180): they colour the card (_customWidgetWarning in assets-snmp.js) and
// are what a "Custom widget level" automation alerts on, so one automation
// covers every widget at that widget's own thresholds. warningWhen gives the
// direction of both.
//
// How a single-value widget's number reads (the asset tab's _cwDisplay):
// "" = a plain number with its unit; a duration format reads it as seconds or
// SNMP TimeTicks (hundredths of a second) and shows "1 h 23 m".
var WIDGET_VALUE_FORMATS = [
  ["", "Number"],
  ["duration_s", "Duration (from seconds)"],
  ["duration_ticks", "Duration (from TimeTicks)"],
];
var WIDGET_UNIT_HINT = '<div class="hint" style="grid-column:1/-1;margin:0;font-size:0.74rem">' +
  'Set the unit to <b>°C</b> or <b>°F</b> for a temperature: it is shown in the install\'s temperature unit, converted when they differ.' +
'</div>';

function _widgetFormatSelectHTML(current) {
  return '<select class="mfg-widget-opt-format" style="width:100%;font-size:0.82rem">' +
    WIDGET_VALUE_FORMATS.map(function (f) {
      return '<option value="' + f[0] + '"' + ((current || "") === f[0] ? " selected" : "") + '>' + f[1] + '</option>';
    }).join("") +
  '</select>';
}

function _widgetDisplayOptionsForm(widgetType, opts) {
  var o = opts || {};
  function num(v) { return (v === null || v === undefined) ? "" : String(v); }
  function warnFields() {
    var below = o.warningWhen === "below";
    return _widgetFormField("Warning at", '<input type="number" class="mfg-widget-opt-warning" value="' + escapeHtml(num(o.warningAt)) + '" step="any" placeholder="none" style="width:100%;font-size:0.82rem">') +
      _widgetFormField("Critical at", '<input type="number" class="mfg-widget-opt-critical" value="' + escapeHtml(num(o.criticalAt)) + '" step="any" placeholder="none" style="width:100%;font-size:0.82rem">') +
      _widgetFormField("Warn when", '<select class="mfg-widget-opt-warning-when" style="width:100%;font-size:0.82rem">' +
        '<option value="above"' + (below ? "" : " selected") + '>at or above</option>' +
        '<option value="below"' + (below ? " selected" : "") + '>at or below</option>' +
      '</select>');
  }
  if (widgetType === "gauge") {
    return '<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px 10px">' +
      _widgetFormField("Min", '<input type="number" class="mfg-widget-opt-min" value="' + escapeHtml(num(o.min)) + '" step="any" style="width:100%;font-size:0.82rem">') +
      _widgetFormField("Max", '<input type="number" class="mfg-widget-opt-max" value="' + escapeHtml(num(o.max)) + '" step="any" style="width:100%;font-size:0.82rem">') +
      _widgetFormField("Unit", '<input type="text"   class="mfg-widget-opt-unit" value="' + escapeHtml(o.unit || "") + '" placeholder="e.g. %, °C or clients" style="width:100%;font-size:0.82rem">') +
      warnFields() +
      _widgetFormField("Show as", _widgetFormatSelectHTML(o.format)) +
      WIDGET_UNIT_HINT +
    '</div>';
  }
  if (widgetType === "line") {
    return '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 10px">' +
      _widgetFormField("Unit", '<input type="text" class="mfg-widget-opt-unit" value="' + escapeHtml(o.unit || "") + '" placeholder="e.g. bps, % or °C" style="width:100%;font-size:0.82rem">') +
      _widgetFormField("Show as", _widgetFormatSelectHTML(o.format)) +
      warnFields() +
      WIDGET_UNIT_HINT +
    '</div>';
  }
  // A Value widget is the reading as text; its levels colour that text and
  // are what a "Custom widget level" automation alerts on (rule 180).
  if (widgetType === "value") {
    return '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 10px">' +
      _widgetFormField("Unit", '<input type="text" class="mfg-widget-opt-unit" value="' + escapeHtml(o.unit || "") + '" placeholder="e.g. bps, % or °C" style="width:100%;font-size:0.82rem">') +
      _widgetFormField("Show as", _widgetFormatSelectHTML(o.format)) +
      warnFields() +
      WIDGET_UNIT_HINT +
    '</div>';
  }
  // table — no editable options
  return '<div style="font-size:0.78rem;color:var(--color-text-tertiary)">Table widgets render every column from the latest sample. No display options to configure.</div>';
}

// Compact one-line summary of displayOptions for the view card.
function _widgetOptionsSummary(w) {
  var o = w.displayOptions || {};
  var parts = [];
  if (w.widgetType === "gauge") {
    if (o.min != null) parts.push("min " + o.min);
    if (o.max != null) parts.push("max " + o.max);
    if (o.unit)        parts.push("unit " + o.unit);
    _widgetLevelSummary(o, parts);
  } else if (w.widgetType === "line" || w.widgetType === "value") {
    if (o.unit) parts.push("unit " + o.unit);
    _widgetLevelSummary(o, parts);
  }
  if (o.format) {
    var f = WIDGET_VALUE_FORMATS.find(function (x) { return x[0] === o.format; });
    if (f) parts.push(f[1].toLowerCase());
  }
  return parts.length ? escapeHtml(parts.join(" · ")) : "";
}

/** "warn ≥ 16 · critical ≥ 18" for the view card (rule 180). */
function _widgetLevelSummary(o, parts) {
  var cmp = o.warningWhen === "below" ? "≤ " : "≥ ";
  if (o.warningAt != null) parts.push("warn " + cmp + o.warningAt);
  if (o.criticalAt != null) parts.push("critical " + cmp + o.criticalAt);
}

// Read displayOptions back from a form scope (an edit card or add card).
// Empty / non-numeric values are dropped so the stored JSON stays tight.
function _readWidgetDisplayOptions(scope, widgetType) {
  function numOrNull(input) {
    if (!input) return null;
    var s = (input.value || "").trim();
    if (s === "") return null;
    var n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  function strOrNull(input) {
    if (!input) return null;
    var s = (input.value || "").trim();
    return s === "" ? null : s;
  }
  var out = {};
  // The direction is stored only beside a threshold, and only when it is the
  // non-default "below" — absent means "above".
  function readWarn() {
    var warn = numOrNull(scope.querySelector(".mfg-widget-opt-warning"));
    var crit = numOrNull(scope.querySelector(".mfg-widget-opt-critical"));
    if (warn == null && crit == null) return;
    if (warn != null) out.warningAt = warn;
    if (crit != null) out.criticalAt = crit;
    var when = scope.querySelector(".mfg-widget-opt-warning-when");
    if (when && when.value === "below") out.warningWhen = "below";
  }
  if (widgetType === "gauge") {
    var min  = numOrNull(scope.querySelector(".mfg-widget-opt-min"));
    var max  = numOrNull(scope.querySelector(".mfg-widget-opt-max"));
    var unit = strOrNull(scope.querySelector(".mfg-widget-opt-unit"));
    if (min != null)  out.min = min;
    if (max != null)  out.max = max;
    if (unit)         out.unit = unit;
    readWarn();
  } else if (widgetType === "line" || widgetType === "value") {
    var unitL = strOrNull(scope.querySelector(".mfg-widget-opt-unit"));
    if (unitL) out.unit = unitL;
    readWarn();
  }
  if (widgetType === "gauge" || widgetType === "line" || widgetType === "value") {
    var fmt = strOrNull(scope.querySelector(".mfg-widget-opt-format"));
    if (fmt) out.format = fmt;
  }
  return out;
}

function renderOverrideRow(profileId, metricKey, o, manufacturer) {
  var editing = !!_mfgProfileOverrideEdit[o.id];
  // Override rows leave the METRIC column blank (the default row above
  // already names the metric). The MODEL column carries the override's
  // identity — the regex literal in view mode, a Model regex input in
  // edit mode. The leading ↳ visually nests the row under its default.
  var head = '<tr class="mfg-override-row" data-profile-id="' + escapeHtml(profileId) +
    '" data-metric-key="' + escapeHtml(metricKey) +
    '" data-override-id="' + escapeHtml(o.id) + '" style="background:var(--color-bg-primary)">' +
    '<td></td>';
  if (editing) {
    var oMibId = _mfgOverrideEditMibId(o.id);
    if (oMibId === undefined) oMibId = joinMibSelection(o.mibId, o.mibStdKey); // first render: persisted value
    // Column order matches the metric default row above:
    //   METRIC (blank) · DEVICE TYPE (select) · MODEL (↳ pattern input) ·
    //   MIB · TYPE · SYMBOL · TRANSFORM · ACTION
    // Clearing the pattern on a type-scoped row promotes it to that type's
    // default; clearing it on an any-type row is refused by the server,
    // since the row would then match nothing.
    var scopeTypeCell = '<td>' + _mfgDeviceTypeSelect(o.assetType || null, "mfg-edit-override-assettype") + '</td>';
    var patternCell =
      '<td style="padding-left:20px"><div style="display:flex;align-items:center;gap:4px">' +
        '<span style="color:var(--color-text-tertiary);font-size:0.78rem">↳</span>' +
        '<input type="text" class="mfg-edit-override-pattern" value="' + escapeHtml(o.modelPattern || "") + '" placeholder="Model regex (optional)" style="flex:1;font-size:0.78rem">' +
      '</div></td>';
    var oEditType = _mfgEditTypeFor("override:" + o.id, o.type);
    return head +
      scopeTypeCell +
      patternCell +
      '<td>' + renderMibSelect(oMibId, "mfg-edit-override-mib", manufacturer) + '</td>' +
      '<td>' + renderTypeSelect(oEditType, "mfg-edit-override-type") + '</td>' +
      '<td>' + _symbolCellEditHTML(oEditType, oMibId, o.symbol, o.symbolB, "mfg-edit-override-sym") +
        _mfgExtraEditHTML(metricKey, "mfg-edit-override", { aggregate: o.aggregate, label: o.label, parsePattern: o.parsePattern, parseTemplate: o.parseTemplate, sensorColumns: o.sensorColumns }) + '</td>' +
      '<td>' + renderTransformSelect(o.transform, "mfg-edit-override-transform", oEditType, metricKey) + '</td>' +
      '<td><button class="btn btn-sm btn-primary mfg-override-save">Save</button> ' +
        '<button class="btn btn-sm btn-secondary mfg-override-cancel">Cancel</button></td>' +
    '</tr>';
  }
  var mibLabel = _mfgMibCellHTML(o.readiness, o.mibId, o.mibStdKey);
  // DEVICE TYPE + MODEL columns carry the row's scope, indented to show its
  // tier: a device-type default sits one level under the profile default, a
  // model exception one level under the type it belongs to.
  var isTypeDefault = !!o.assetType && !o.modelPattern;
  var deviceCell = o.assetType
    ? '<td style="padding-left:' + (isTypeDefault ? 20 : 32) + 'px">' +
        '<span style="color:var(--color-text-tertiary);font-size:0.78rem">↳</span> ' +
        '<span style="font-size:0.78rem;font-weight:600">' + escapeHtml(_dtLabelFor(o.assetType)) + '</span>' +
      '</td>'
    : '<td>' + _mfgScopeBadge("ANY") + '</td>';
  var modelCell = o.modelPattern
    ? '<td style="padding-left:' + (o.assetType ? 32 : 20) + 'px">' +
        '<span style="color:var(--color-text-tertiary);font-size:0.78rem">↳</span> ' +
        '<code style="font-size:0.8rem">' + escapeHtml(o.modelPattern) + '</code>' +
      '</td>'
    : '<td style="padding-left:20px">' + _mfgScopeBadge("DEFAULT") + '</td>';
  var typeLabelO = _MFG_TYPE_LABELS[o.type] || o.type;
  return head +
    deviceCell +
    modelCell +
    '<td><span style="font-size:0.78rem">' + mibLabel + '</span></td>' +
    '<td><span style="font-size:0.78rem">' + escapeHtml(typeLabelO) + '</span></td>' +
    '<td>' + _symbolCellViewHTML(o.type, o.symbol, o.symbolB) +
      _mfgExtraViewHTML(metricKey, { aggregate: o.aggregate, label: o.label, parsePattern: o.parsePattern, parseTemplate: o.parseTemplate, sensorColumns: o.sensorColumns }) + '</td>' +
    '<td><span style="font-size:0.78rem;color:var(--color-text-secondary)">' + (o.transform ? escapeHtml(transformLabel(o.transform)) : "—") + '</span></td>' +
    '<td><button class="btn btn-sm btn-secondary mfg-override-edit">Edit</button> ' +
      '<button class="btn btn-sm btn-danger mfg-override-del">Del</button></td>' +
  '</tr>';
}

// Standard MIB hints the operator can pin on a metric row or override.
// Keys mirror `_SNMP_STANDARD_MIBS` in `public/js/assets.js` (the SNMP Walk
// dropdown) and the `STD_MIB_KEYS` set in `manufacturerProfileService.ts`.
// `std:fortinet` deliberately omitted — vendor MIBs belong in the Uploaded
// MIBs section, not the Standard MIBs optgroup.
var STD_MIB_LABELS = {
  "std:system":         "System (SNMPv2-MIB, RFC 3418)",
  "std:interfaces":     "Interfaces — ifTable (IF-MIB, RFC 2863)",
  "std:if-ext":         "Interfaces — ifXTable, 64-bit counters (IF-MIB, RFC 2863)",
  "std:host-resources": "Host Resources (HOST-RESOURCES-MIB, RFC 2790)",
  "std:entity":         "Entity (ENTITY-MIB, RFC 4133)",
  "std:entity-sensor":  "Entity Sensors (ENTITY-SENSOR-MIB, RFC 3433)",
  "std:lldp":           "LLDP (LLDP-MIB, IEEE 802.1AB)",
  "std:poe":            "PoE (POWER-ETHERNET-MIB, RFC 3621)",
  "std:bridge":         "Bridge — MAC forwarding + STP (BRIDGE-MIB, RFC 4188)",
  "std:q-bridge":       "Bridge — VLAN-aware forwarding (Q-BRIDGE-MIB, RFC 4363)",
  "std:rstp":           "Rapid Spanning Tree (RSTP-MIB, RFC 4318)",
  "std:ip":             "IP — addresses + neighbour cache (IP-MIB, RFC 4293)",
};
var STD_MIB_ORDER = ["std:system", "std:interfaces", "std:if-ext", "std:host-resources", "std:entity", "std:entity-sensor", "std:lldp", "std:poe", "std:bridge", "std:q-bridge", "std:rstp", "std:ip"];

// Splits a single dropdown value into the {mibId, mibStdKey} pair the
// backend expects. The dropdown carries one combined string ("" = built-in
// seed, "std:*" = standard MIB hint, otherwise a UUID = uploaded MIB) so
// the operator only has to pick once.
function splitMibSelection(value) {
  if (!value) return { mibId: null, mibStdKey: null };
  if (value.indexOf("std:") === 0) return { mibId: null, mibStdKey: value };
  return { mibId: value, mibStdKey: null };
}

// Inverse of splitMibSelection — turns the persisted pair into the single
// string the dropdown's <option value=…> expects. Std key wins when both
// are non-null (defensive — the backend rejects that combination).
function joinMibSelection(mibId, mibStdKey) {
  if (mibStdKey) return mibStdKey;
  if (mibId)     return mibId;
  return "";
}

// ─── "Also applies when" (the profile's match pattern) ─────────────────
//
// A profile is normally found by its CANONICAL manufacturer, and that is the
// only lookup for an asset whose manufacturer the alias map already folds
// into this profile's name. `matchPattern` is the second chance, consulted
// ONLY when no profile is keyed by the asset's manufacturer, and tested
// case-insensitively against `manufacturer os pinnedMibModuleName` — so it
// covers the three cases the hardcoded vendor constant's regex covered:
//   · an alias spelling the seed did not key ("Aruba", "HPE" → the HP profile)
//   · OS-only identity (SNMP reports "Cisco IOS" and no manufacturer)
//   · a MIB-pin redirect (the asset's pinned MIB module names the vendor)
// Empty is the normal state for an operator-made profile; the seeded ones
// carry the constant's alternations, backfilled by the Phase 4 migration.
function _mfgMatchPatternHTML(detail) {
  var v = detail.matchPattern || "";
  return '<div class="mfg-profile-scope" data-profile-id="' + escapeHtml(detail.id) + '" ' +
      'style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px">' +
    '<span style="font-size:0.78rem;color:var(--color-text-secondary);white-space:nowrap">Also applies when</span>' +
    '<input type="text" class="mfg-matchpattern" value="' + escapeHtml(v) + '" ' +
      'placeholder="Manufacturer / OS regex, e.g. aruba|hpe|procurve" ' +
      'title="Case-insensitive regex tested against the asset\'s manufacturer, OS and pinned MIB module — used only when no profile is keyed by its manufacturer" ' +
      'style="flex:1;min-width:200px;font-size:0.78rem">' +
    '<button class="btn btn-sm mfg-matchpattern-save">Save</button>' +
    '<span style="font-size:0.72rem;color:var(--color-text-tertiary)">' +
      'Only consulted when no profile matches the asset\'s manufacturer. Leave blank for none.' +
    '</span>' +
  '</div>';
}

async function saveMatchPattern(el) {
  var box = el.closest(".mfg-profile-scope");
  if (!box) return;
  var profileId = box.getAttribute("data-profile-id");
  var input = box.querySelector(".mfg-matchpattern");
  var value = ((input || {}).value || "").trim();
  try {
    // Null clears it — an empty string would store a regex that matches
    // everything, which is the opposite of "no second chance".
    var resp = await api.serverSettings.updateManufacturerProfile(profileId, { matchPattern: value || null });
    // Same refresh shape as every other write on this card: fold the returned
    // profile into the detail cache, then re-render from it.
    if (resp && resp.profile) _mfgProfileDetail[profileId] = resp.profile;
    showToast(value ? "Match pattern saved" : "Match pattern cleared");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Save match pattern failed", "error");
  }
}

// ─── Scope helpers (device type + model pattern) ───────────────────────
//
// A scoped row under a metric carries (assetType, modelPattern) and at least
// one of the two. The three shapes render as three tiers:
//   assetType only   → that DEVICE TYPE'S DEFAULT, one indent in
//   both             → a model exception under that type, two indents in
//   modelPattern only→ a model exception for any device type
// Identical wording lives in manufacturerProfileService's MetricOverrideRow.

// The small uppercase marker the DEFAULT / ANY cells use, so the profile-wide
// row and the device-type rows read as the same kind of thing.
function _mfgScopeBadge(text) {
  return '<span style="font-size:0.74rem;font-weight:600;letter-spacing:0.04em;color:var(--color-text-tertiary)">' +
    escapeHtml(text) + '</span>';
}

// Order the scoped rows into the hierarchy the table draws: per device type
// (alphabetical by the label the operator sees), that type's default first
// and its model exceptions after, then the any-type model exceptions last.
// Within a tier the server's `order` is preserved — it decides which regex
// wins at probe time, so the page must not show a different sequence.
function _mfgGroupOverrides(overrides) {
  var rows = (overrides || []).slice();
  var types = [];
  rows.forEach(function (o) {
    if (o.assetType && types.indexOf(o.assetType) === -1) types.push(o.assetType);
  });
  types.sort(function (a, b) { return _dtLabelFor(a).localeCompare(_dtLabelFor(b)); });
  var out = [];
  types.forEach(function (t) {
    rows.forEach(function (o) { if (o.assetType === t && !o.modelPattern) out.push(o); });
    rows.forEach(function (o) { if (o.assetType === t && o.modelPattern) out.push(o); });
  });
  rows.forEach(function (o) { if (!o.assetType) out.push(o); });
  return out;
}

// Device-type picker, drawn from the asset-type REGISTRY (`_assetTypes`, the
// same list the Device Types card edits) rather than a hardcoded four, so a
// custom type an operator added can carry a default too. "Any device type"
// is the empty value.
function _mfgDeviceTypeSelect(selected, cls) {
  var types = (_assetTypes || []).slice().sort(function (a, b) {
    return (a.label || a.name || "").localeCompare(b.label || b.name || "");
  });
  var html = '<select class="' + cls + '" style="width:100%;font-size:0.78rem">' +
    '<option value=""' + (selected ? '' : ' selected') + '>Any device type</option>';
  var known = false;
  types.forEach(function (t) {
    if (t.name === selected) known = true;
    html += '<option value="' + escapeHtml(t.name) + '"' + (t.name === selected ? ' selected' : '') + '>' +
      escapeHtml(t.label || t.name) + '</option>';
  });
  // A stored type the registry no longer carries (renamed or deleted) must
  // still be selectable, or opening the editor would silently rewrite the
  // row's scope to "any" on the next save.
  if (selected && !known) {
    html += '<option value="' + escapeHtml(selected) + '" selected>' + escapeHtml(selected) + ' (unknown)</option>';
  }
  return html + '</select>';
}

// ─── The row facts the hardcoded profile used to own ───────────────────
//
// Three metric-specific extras live under the Symbol cell, keyed by metric:
//   cpu / memory          → aggregate: how a walked subtree collapses
//                           (none | avg | sum) — Cisco pools are summed,
//                           Juniper buffers averaged.
//   storage / temperature → label: the sample row's name ("flash" for a
//                           FortiSwitch's storage; "System" for a FortiAP's
//                           one temperature).
//   model                 → parse pattern + template turning the raw vendor
//                           scalar into Asset.model ("FortiSwitch $1").
// Every input carries an `mfg-<prefix>-…` class, which is what the
// form-preserve snapshot keys on, so nothing typed here is lost to a chained
// re-render.

var _MFG_AGGREGATE_LABELS = { none: "as read", avg: "average rows", sum: "sum rows" };

// Hardware Sensors (temperature) carries the label for a scalar row AND, for a
// `table` row, the sensor table's sibling columns (business rule 132): the row's
// Symbol is the VALUE column; these name the row-name column, an alarm column
// and how its reading maps to alarm / ok, an optional fixed class and a scale.
// The server keeps the columns on a table row only and clears them otherwise.
var _MFG_SENSOR_CLASSES = ["temperature", "fan", "voltage", "current", "optical", "poe", "power", "disk", "other"];
var _MFG_ALARM_MODES = { nonzero: "not 0", zero: "is 0", equals: "is one of", notEquals: "is not one of", gte: "at least", lte: "at most" };

function _mfgExtrasFor(metricKey) {
  if (metricKey === "cpu" || metricKey === "memory") return "aggregate";
  if (metricKey === "storage") return "label";
  if (metricKey === "temperature") return "sensor";
  if (metricKey === "model") return "parse";
  return null;
}

function _mfgSensorColumnsEditHTML(prefix, cols, small) {
  cols = cols || {};
  var map = cols.alarmMap || {};
  var mode = map.mode || "nonzero";
  var html = '<div style="margin-top:4px;font-size:0.7rem;color:var(--color-text-secondary)" title="Used when Type is table: the Symbol above is the value column">Table columns (Type = table):</div>' +
    '<input type="text" class="' + prefix + '-sensorname" value="' + escapeHtml(cols.nameSymbol || "") + '" placeholder="Name column (e.g. fgHwSensorEntName)" ' + small + '>' +
    '<input type="text" class="' + prefix + '-sensoralarm" value="' + escapeHtml(cols.alarmSymbol || "") + '" placeholder="Alarm column (optional)" ' + small + '>' +
    '<div style="display:flex;gap:4px">' +
      '<select class="' + prefix + '-sensoralarmmode" ' + small + ' title="Alarm when the alarm column\'s value…">';
  Object.keys(_MFG_ALARM_MODES).forEach(function (k) {
    html += '<option value="' + k + '"' + (mode === k ? ' selected' : '') + '>alarm: ' + _MFG_ALARM_MODES[k] + '</option>';
  });
  html += '</select>' +
      '<input type="text" class="' + prefix + '-sensoralarmvalues" value="' + escapeHtml((map.values || []).join(", ")) + '" placeholder="values, e.g. 2, 3" ' + small + '>' +
    '</div>' +
    '<div style="display:flex;gap:4px">' +
      '<select class="' + prefix + '-sensorclass" ' + small + ' title="Every row\'s class, for a table whose row names don\'t say">' +
        '<option value="">class: from row name</option>';
  _MFG_SENSOR_CLASSES.forEach(function (c) {
    html += '<option value="' + c + '"' + (cols.sensorClass === c ? ' selected' : '') + '>class: ' + c + '</option>';
  });
  html += '</select>' +
      '<select class="' + prefix + '-sensorscale" ' + small + '>' +
        '<option value="">scale: as read</option>' +
        '<option value="tenths_to_units"' + (cols.transform === "tenths_to_units" ? ' selected' : '') + '>scale: tenths → units</option>' +
      '</select>' +
    '</div>';
  return html;
}

// The columns a row's controls describe, or null when none are set.
function _mfgReadSensorColumns(tr, prefix) {
  var val = function (suffix) { var el = tr.querySelector("." + prefix + "-" + suffix); return el ? (el.value || "").trim() : ""; };
  var nameSymbol  = val("sensorname");
  var alarmSymbol = val("sensoralarm");
  var sensorClass = val("sensorclass");
  var transform   = val("sensorscale");
  if (!nameSymbol && !alarmSymbol && !sensorClass && !transform) return null;
  var values = val("sensoralarmvalues").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  return {
    nameSymbol:  nameSymbol || null,
    alarmSymbol: alarmSymbol || null,
    alarmMap:    alarmSymbol ? { mode: val("sensoralarmmode") || "nonzero", values: values } : null,
    sensorClass: sensorClass || null,
    transform:   transform || null,
  };
}

function _mfgExtraEditHTML(metricKey, prefix, vals) {
  var kind = _mfgExtrasFor(metricKey);
  vals = vals || {};
  var small = 'style="width:100%;font-size:0.74rem;margin-top:3px"';
  if (kind === "aggregate") {
    var cur = vals.aggregate || "none";
    var html = '<select class="' + prefix + '-aggregate" ' + small + ' title="How a walked subtree collapses to one reading">';
    ["none", "avg", "sum"].forEach(function (k) {
      html += '<option value="' + k + '"' + (cur === k ? ' selected' : '') + '>walk: ' + _MFG_AGGREGATE_LABELS[k] + '</option>';
    });
    return html + '</select>';
  }
  if (kind === "label") {
    return '<input type="text" class="' + prefix + '-label" value="' + escapeHtml(vals.label || "") + '" placeholder="Row label (e.g. flash, System)" ' + small + '>';
  }
  if (kind === "sensor") {
    return '<input type="text" class="' + prefix + '-label" value="' + escapeHtml(vals.label || "") + '" placeholder="Row label for a scalar (e.g. System)" ' + small + '>' +
      _mfgSensorColumnsEditHTML(prefix, vals.sensorColumns, small);
  }
  if (kind === "parse") {
    return '<input type="text" class="' + prefix + '-parsepattern" value="' + escapeHtml(vals.parsePattern || "") + '" placeholder="Parse regex with (capture), e.g. ^(\\S+?)-v\\d" ' + small + '>' +
      '<input type="text" class="' + prefix + '-parsetemplate" value="' + escapeHtml(vals.parseTemplate || "") + '" placeholder="Template with $1, e.g. FortiSwitch $1" ' + small + '>';
  }
  return "";
}

function _mfgExtraViewHTML(metricKey, vals) {
  var kind = _mfgExtrasFor(metricKey);
  vals = vals || {};
  var chip = 'style="display:inline-block;margin-top:3px;font-size:0.7rem;color:var(--color-text-secondary)"';
  if (kind === "aggregate" && vals.aggregate && vals.aggregate !== "none") {
    return '<div ' + chip + '>walk: ' + escapeHtml(_MFG_AGGREGATE_LABELS[vals.aggregate] || vals.aggregate) + '</div>';
  }
  if (kind === "label" && vals.label) {
    return '<div ' + chip + '>label: ' + escapeHtml(vals.label) + '</div>';
  }
  if (kind === "sensor") {
    var c = vals.sensorColumns;
    if (c) {
      var parts = [];
      if (c.nameSymbol) parts.push("name " + c.nameSymbol);
      if (c.alarmSymbol) {
        var m = c.alarmMap || {};
        parts.push("alarm " + c.alarmSymbol + " " + (_MFG_ALARM_MODES[m.mode] || m.mode || "not 0") +
          (m.values && m.values.length ? " " + m.values.join(", ") : ""));
      }
      if (c.sensorClass) parts.push("class " + c.sensorClass);
      if (c.transform === "tenths_to_units") parts.push("tenths → units");
      return '<div ' + chip + '>columns: ' + escapeHtml(parts.join(" · ")) + '</div>';
    }
    if (vals.label) return '<div ' + chip + '>label: ' + escapeHtml(vals.label) + '</div>';
  }
  if (kind === "parse" && (vals.parsePattern || vals.parseTemplate)) {
    return '<div ' + chip + '>parse: <code>' + escapeHtml(vals.parsePattern || "") + '</code>' +
      (vals.parseTemplate ? ' → <code>' + escapeHtml(vals.parseTemplate) + '</code>' : '') + '</div>';
  }
  return "";
}

// Read the extras back out of a row for the save payload. Absent controls
// (a metric with no extras) come back null / "none", which the server treats
// as "leave as is" on the fields it does not own.
function _mfgReadExtras(tr, prefix, metricKey) {
  var kind = _mfgExtrasFor(metricKey);
  var val = function (suffix) { var el = tr.querySelector("." + prefix + "-" + suffix); return el ? (el.value || "").trim() : ""; };
  return {
    aggregate:     kind === "aggregate" ? (val("aggregate") || "none") : "none",
    label:         (kind === "label" || kind === "sensor") ? (val("label") || null) : null,
    parsePattern:  kind === "parse"     ? (val("parsepattern") || null) : null,
    parseTemplate: kind === "parse"     ? (val("parsetemplate") || null) : null,
    sensorColumns: kind === "sensor"    ? _mfgReadSensorColumns(tr, prefix) : null,
  };
}

// ─── Readiness rendering ────────────────────────────────────────────────
//
// The server stamps every configured profile row with `readiness` — did the
// symbol resolve at this manufacturer's scope, via which module and layer,
// and if not, what to upload (`hint.kind === "imports"` names the module the
// pinned MIB is missing; `"no-module"` means nothing loaded defines it). The
// MIB cell renders THAT, so the page can never claim a row works when it
// does not. An unconfigured row (no symbol) has no readiness and shows the
// operator's pin as before.

var _MFG_SCOPE_LABELS = {
  device:   "device MIB",
  vendor:   "vendor MIB",
  generic:  "generic MIB",
  standard: "shipped standard",
  seed:     "built-in seed",
};

function _mfgReadinessHint(r) {
  if (!r || r.resolved) return "";
  if (r.hint && r.hint.kind === "imports") {
    var mods = [];
    (r.hint.roots || []).forEach(function (x) {
      var m = x.module || x.symbol;
      if (mods.indexOf(m) === -1) mods.push(m);
    });
    return escapeHtml(r.hint.mibModuleName) + " is missing " + mods.map(escapeHtml).join(", ") + " — upload it too";
  }
  return "no uploaded MIB defines " + escapeHtml(r.symbol) + " — upload the vendor’s MIB";
}

// One MIB cell. `readiness` is `{ a, b }` (b for the second symbol of a
// double_scalar row) or null/undefined for an unconfigured row.
function _mfgMibCellHTML(readiness, mibId, mibStdKey) {
  if (!readiness) {
    // Unconfigured: show the pin the operator made, or that the built-in
    // seed answers.
    var stdLabel = mibStdKey ? STD_MIB_LABELS[mibStdKey] : null;
    if (mibId)    return '<span style="font-size:0.78rem">' + escapeHtml(_mfgLookupMibLabel(mibId)) + '</span>';
    if (stdLabel) return '<span style="font-size:0.78rem">' + escapeHtml(stdLabel) + '</span>';
    return '<span style="font-size:0.78rem;color:var(--color-text-tertiary);font-style:italic">seed</span>';
  }
  var parts = [readiness.a];
  if (readiness.b) parts.push(readiness.b);
  var bad = parts.filter(function (r) { return r && !r.resolved; });
  if (bad.length === 0) {
    var r0 = readiness.a;
    var mod = r0.fromModuleName || (r0.fromScope === "seed" ? "built-in seed" : "(resolved)");
    var scope = _MFG_SCOPE_LABELS[r0.fromScope] || r0.fromScope || "";
    // Both symbols of a pair normally come from one module; say so once, and
    // name the second only when it differs.
    var second = readiness.b && readiness.b.fromModuleName && readiness.b.fromModuleName !== r0.fromModuleName
      ? ' <span style="color:var(--color-text-tertiary)">+ ' + escapeHtml(readiness.b.fromModuleName) + '</span>' : '';
    return '<span style="font-size:0.78rem" title="' + escapeHtml(r0.oid || "") + '">' +
      escapeHtml(mod) + second +
      (scope ? ' <span style="color:var(--color-text-tertiary);font-size:0.72rem">(' + escapeHtml(scope) + ')</span>' : '') +
    '</span>';
  }
  var hints = [];
  bad.forEach(function (r) { var h = _mfgReadinessHint(r); if (h && hints.indexOf(h) === -1) hints.push(h); });
  return '<span style="font-size:0.78rem;color:var(--color-danger)" title="' + hints.join("\n") + '">' +
    '⚠ unresolved' +
    '<span style="display:block;font-size:0.72rem;color:var(--color-text-secondary)">' + hints.join("<br>") + '</span>' +
  '</span>';
}

// Collapsed-header pill: green "ready" when every configured symbol resolves,
// amber with a count otherwise. Nothing when the profile configures no
// symbols at all (a fresh, empty profile is neither).
function _mfgReadinessPillHTML(p) {
  if (!p || (!p.ready && !p.partial && !(p.unresolvedCount > 0))) return "";
  if (p.ready) {
    return ' <span style="font-size:0.7rem;font-weight:600;letter-spacing:0.04em;color:var(--color-success);margin-left:6px" title="Every configured symbol resolves">READY</span>';
  }
  var n = p.unresolvedCount || 0;
  var tip = (p.unresolvedSymbols || []).join(", ");
  return ' <span style="font-size:0.7rem;font-weight:600;letter-spacing:0.04em;color:var(--color-warning,#d97706);margin-left:6px" title="' + escapeHtml(tip) + '">' +
    n + ' UNRESOLVED</span>';
}

// The upload form's inline result: stored + usable, or stored + what to add.
function _mibUploadResultHTML(created) {
  if (!created || typeof created.symbolCount !== "number") return "";
  var total = created.symbolCount;
  var bad = created.unresolvedCount || 0;
  if (bad === 0) {
    return '<span style="color:var(--color-success)">' + escapeHtml(created.moduleName) + ': ' + total + ' symbol' + (total === 1 ? '' : 's') + ', all resolve.</span>';
  }
  var roots = Array.isArray(created.unresolvedRoots) ? created.unresolvedRoots : [];
  var mods = [];
  roots.forEach(function (r) { var m = r.module || r.symbol; if (mods.indexOf(m) === -1) mods.push(m); });
  return '<span style="color:var(--color-warning,#d97706)">' + escapeHtml(created.moduleName) + ': ' + bad + ' of ' + total + ' symbol' + (total === 1 ? '' : 's') + ' unresolved' +
    (mods.length > 0 ? ' — needs <b>' + mods.map(escapeHtml).join("</b>, <b>") + '</b>; upload ' + (mods.length === 1 ? 'it' : 'them') + ' too.' : '.') +
  '</span>';
}

// Toast every warning a write came back with. The write SUCCEEDED — these
// say the row names a symbol nothing resolves yet.
function _mfgToastWarnings(resp) {
  var w = resp && Array.isArray(resp.warnings) ? resp.warnings : [];
  w.forEach(function (msg) { showToast(msg, "warning"); });
}

// Map a MibFile.id back to its module name (or a short fallback) for the
// MIB column. Reads the same `_mibsData` cache the dropdown is populated
// from, so a freshly uploaded MIB shows up immediately on next render.
function _mfgLookupMibLabel(mibId) {
  for (var i = 0; i < _mibsData.length; i++) {
    if (_mibsData[i].id === mibId) {
      return _mibsData[i].moduleName || _mibsData[i].filename || "(MIB)";
    }
  }
  return "(deleted MIB)";
}

// Metric-row Type select: scalar | double_scalar | table.
function renderTypeSelect(current, cls) {
  return _typeSelectHTML(cls, current, ["scalar", "double_scalar", "table"]);
}
// Custom-widget Symbol-Type select: scalar | table only (widget renderer
// has no combiner support).
function renderWidgetTypeSelect(current, cls) {
  return _typeSelectHTML(cls, current, ["scalar", "table"]);
}

// Transform / Combiner select. `type` decides which list to render:
//   "double_scalar" → binary combiners (CombinerKind on the backend)
//   anything else   → unary transforms (TransformKind)
// `metricKey` is passed by metric rows and overrides, never by widgets: it
// narrows the unary list to what that metric's collector applies
// (_mfgMetricTransforms), and a metric with nothing applicable gets a plain
// "—" instead of a select. With no select in the row the save handlers read
// an empty value, so saving also clears a stale transform.
function renderTransformSelect(current, cls, type, metricKey) {
  var list = type === "double_scalar" ? _mfgProfileCombiners : _mfgProfileTransforms;
  if (metricKey && type !== "double_scalar") {
    var allowed = type === "scalar" ? (_mfgMetricTransforms[metricKey] || []) : [];
    list = list.filter(function (t) { return allowed.indexOf(t.kind) !== -1; });
    if (!list.length) {
      return '<span class="' + cls + '-none" style="font-size:0.78rem;color:var(--color-text-tertiary)">—</span>';
    }
  }
  var html = '<select class="' + cls + '" style="font-size:0.78rem">' +
    '<option value="">— none —</option>';
  list.forEach(function (t) {
    html += '<option value="' + escapeHtml(t.kind) + '"' + (current === t.kind ? " selected" : "") + '>' + escapeHtml(t.label) + '</option>';
  });
  html += '</select>';
  return html;
}

// Symbol picker that depends on the MIB selection. When mibId is empty
// (= "Built-in seed"), Polaris doesn't have a symbol list to draw from
// — every seeded symbol lives in oidRegistry without an enumerable
// directory. So we fall through to a free-text input the operator types
// into. When mibId is set AND the structure has been fetched + cached,
// we render a `<select>` populated with that MIB's readable symbol
// names. While the structure is in flight we render a disabled select
// with "Loading…" so the operator sees the chain react.
function renderSymbolPicker(currentSymbol, mibId, cls, type) {
  // Only "Built-in seed" (empty) falls back to free text — the seed is a
  // handful of SMI root arcs with no directory to list. A standard MIB pick
  // (std:*) enumerates like an upload does, through GET /mibs/std/:key/
  // structure, which returns the same shape as the uploaded variant.
  if (!mibId) {
    return '<input type="text" class="' + cls + '" value="' + escapeHtml(currentSymbol || "") +
      '" placeholder="Symbol (e.g. fgSysCpuUsage)" style="width:100%;font-size:0.78rem">';
  }
  var entry = _mfgMibSymbolsCache[mibId];
  if (!entry || entry.loading) {
    // Fire the fetch (idempotent) and render a placeholder. The change
    // listener that triggered this re-render kicks off the load; once
    // it completes the helper re-renders the tab and the dropdown
    // populates.
    _ensureMibSymbols(mibId);
    return '<select class="' + cls + '" disabled style="width:100%;font-size:0.78rem">' +
      '<option>Loading symbols…</option>' +
    '</select>';
  }
  // Pick which side of the split to surface. `type === "table"` shows the
  // table-row OIDs (each one walks to a 2D result); anything else (scalar
  // is the default) shows the scalar/leaf symbols. Memory's multi-OID
  // picker still passes no type and gets the scalars list, matching its
  // pre-split behaviour.
  var names = (type === "table") ? (entry.tables || []) : (entry.scalars || []);
  // A type-to-filter combobox rather than a <select>: a vendor MIB carries
  // hundreds to thousands of symbols (PowerNet-MIB alone is ~3 MB), too many
  // to scroll. The list lives in _mfgMibSymbolsCache, so the markup carries
  // only the MIB id + side; the delegated handlers below filter it. The
  // saved symbol rides along as data-initial so a value not in the chosen
  // list (a table symbol after flipping Type to scalar) still round-trips
  // while the operator decides — what the old "(not a scalar)" option did.
  var side = type === "table" ? "table" : "scalar";
  var unknown = currentSymbol && names.indexOf(currentSymbol) === -1 && !_symRowInMib(mibId, currentSymbol);
  return '<span class="aw-combo aw-combo-dim">' +
    '<input type="text" class="' + cls + ' mib-sym-combo" autocomplete="off" spellcheck="false"' +
      ' data-mib-id="' + escapeHtml(mibId) + '" data-sym-side="' + side + '"' +
      ' data-initial="' + escapeHtml(currentSymbol || "") + '"' +
      ' value="' + escapeHtml(currentSymbol || "") + '"' +
      ' placeholder="Type to filter ' + names.length + ' ' + side + ' symbol' + (names.length === 1 ? "" : "s") + '"' +
      (unknown ? ' title="Not a ' + side + ' in this MIB"' : '') +
      ' style="width:100%;font-size:0.78rem' + (unknown ? ';border-color:var(--color-danger)' : '') + '">' +
    '<div class="aw-suggest"></div>' +
  '</span>';
}

// ─── Symbol combobox (delegated) ───────────────────────────────────────────
// One set of document-level handlers serves every Symbol picker the
// Manufacturer Profiles card renders (metric rows, overrides, widgets), so the
// card's many re-renders never need to re-wire anything.

var _SYM_COMBO_LIMIT = 200;

function _symComboNames(input) {
  var entry = _mfgMibSymbolsCache[input.getAttribute("data-mib-id")];
  if (!entry || entry.loading) return null;
  return input.getAttribute("data-sym-side") === "table" ? (entry.tables || []) : (entry.scalars || []);
}

/** True when `value` is one this picker would accept on its own: a symbol in
 *  its list, or the saved value it was rendered with. A restore after a MIB or
 *  Type swap drops anything else — what a <select> did by itself. */
function _symComboAccepts(input, value) {
  if (!value) return true;
  if (value === input.getAttribute("data-initial")) return true;
  var names = _symComboNames(input);
  return !!names && (names.indexOf(value) !== -1 || _symComboRowOk(input, value));
}

/** `<column>.<row…>` — one row of a table (`rPDU2PhaseStatusPower.2`), read
 *  by the server as that exact instance — is fine when the column itself is
 *  in this MIB, on either side of the scalar / table split. */
function _symComboRowOk(input, value) {
  return _symRowInMib(input.getAttribute("data-mib-id"), value);
}

function _symRowInMib(mibId, value) {
  var m = /^([A-Za-z][\w-]*)((?:\.\d+)+)$/.exec(value || "");
  if (!m) return false;
  var entry = _mfgMibSymbolsCache[mibId];
  if (!entry || entry.loading) return false;
  return (entry.scalars || []).indexOf(m[1]) !== -1 || (entry.tables || []).indexOf(m[1]) !== -1;
}

function _symComboMarkUnknown(input) {
  var v = (input.value || "").trim();
  var names = _symComboNames(input);
  var bad = !!(v && names && names.indexOf(v) === -1 && !_symComboRowOk(input, v));
  input.style.borderColor = bad ? "var(--color-danger)" : "";
  input.title = bad ? "Not a " + input.getAttribute("data-sym-side") + " in this MIB" : "";
}

function _renderSymCombo(input) {
  var box = input.nextElementSibling;
  var names = _symComboNames(input);
  if (!box || !names) return;
  var q = (input.value || "").trim().toLowerCase();
  // Prefix matches first (an exact match among them, leading), then interior.
  // The exact match stays listed so a complete, correct name reads as found
  // rather than as "no symbol matches".
  var prefix = [], interior = [];
  names.forEach(function (n) {
    var v = n.toLowerCase();
    if (q && v === q) { prefix.unshift(n); return; }
    var at = q ? v.indexOf(q) : 0;
    if (at === 0) prefix.push(n);
    else if (at > 0) interior.push(n);
  });
  var matches = prefix.concat(interior);
  if (!matches.length) {
    box.innerHTML = '<div class="aw-suggest-empty">' +
      (q ? "No symbol in this MIB matches." : "This MIB has no symbols of this type.") + '</div>';
  } else {
    box.innerHTML = matches.slice(0, _SYM_COMBO_LIMIT).map(function (n) {
      return '<div class="aw-suggest-item" data-val="' + escapeHtml(n) + '">' + escapeHtml(n) + '</div>';
    }).join("") +
      (matches.length > _SYM_COMBO_LIMIT
        ? '<div class="aw-suggest-empty">' + (matches.length - _SYM_COMBO_LIMIT) + ' more — keep typing to narrow</div>'
        : "");
  }
  box.classList.add("open");
}

function _pickSymCombo(input, value) {
  input.value = value;
  _closeMfgSuggest(input.nextElementSibling);
  _symComboMarkUnknown(input);
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

document.addEventListener("focusin", function (e) {
  if (e.target.classList && e.target.classList.contains("mib-sym-combo")) _renderSymCombo(e.target);
});
document.addEventListener("click", function (e) {
  if (e.target.classList && e.target.classList.contains("mib-sym-combo")) _renderSymCombo(e.target);
});
document.addEventListener("input", function (e) {
  if (!e.target.classList || !e.target.classList.contains("mib-sym-combo")) return;
  _renderSymCombo(e.target);
  _symComboMarkUnknown(e.target);
});
document.addEventListener("focusout", function (e) {
  var input = e.target;
  if (!input.classList || !input.classList.contains("mib-sym-combo")) return;
  // Delay so a mousedown on an item (which fires before blur completes) lands.
  setTimeout(function () { _closeMfgSuggest(input.nextElementSibling); }, 150);
});
document.addEventListener("mousedown", function (e) {
  var item = e.target.closest && e.target.closest(".aw-suggest-item");
  var input = item && item.parentElement && item.parentElement.previousElementSibling;
  if (!input || !input.classList.contains("mib-sym-combo")) return;
  e.preventDefault(); // keep focus on the input
  _pickSymCombo(input, item.getAttribute("data-val"));
});
document.addEventListener("keydown", function (e) {
  var input = e.target;
  if (!input.classList || !input.classList.contains("mib-sym-combo")) return;
  var box = input.nextElementSibling;
  if (!box || !box.classList.contains("open")) return;
  if (e.key === "Escape") { _closeMfgSuggest(box); e.stopPropagation(); return; }
  var items = Array.prototype.slice.call(box.querySelectorAll(".aw-suggest-item"));
  var idx = items.findIndex(function (i) { return i.classList.contains("active"); });
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!items.length) return;
    e.preventDefault();
    var next = e.key === "ArrowDown" ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
    items.forEach(function (i) { i.classList.remove("active"); });
    items[next].classList.add("active");
    if (items[next].scrollIntoView) items[next].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    // Enter never submits the row from here: a highlighted (or the only)
    // match completes the box, and the Save button stays the one way to save.
    e.preventDefault();
    var pick = idx >= 0 ? items[idx] : (items.length === 1 ? items[0] : null);
    if (pick) _pickSymCombo(input, pick.getAttribute("data-val"));
  }
});

// Lazy-fetch + cache one MIB's symbol list, split into `tables` vs
// `scalars` so the per-row Symbol picker can populate from whichever
// list matches the operator's chosen Type. Mirrors the Browse modal's
// split: tables come from `struct.tables[]`, scalars are every other
// symbol that isn't a table column, table row, or table name.
// Re-render happens once the fetch resolves so the disabled "Loading…"
// state in the picker swaps to the populated dropdown.
function _ensureMibSymbols(mibId) {
  if (!mibId) return;
  if (_mfgMibSymbolsCache[mibId] && !_mfgMibSymbolsCache[mibId].loading) return;
  if (_mfgMibSymbolsCache[mibId] && _mfgMibSymbolsCache[mibId].loading) return; // already in flight
  _mfgMibSymbolsCache[mibId] = { loading: true, scalars: [], tables: [] };
  // A std:* key has no MibFile row; its structure comes from the bundled
  // module via the std route. Same response shape, same split below.
  var isStd = typeof mibId === "string" && mibId.indexOf("std:") === 0;
  var fetchStructure = isStd
    ? api.serverSettings.getStdMibStructure(mibId)
    : api.serverSettings.getMibStructure(mibId);
  fetchStructure.then(function (struct) {
    var tables = (struct.tables || []).map(function (t) { return t.name; }).filter(Boolean);
    // Build "everything that isn't a table-related symbol" for the scalar list.
    var tableColumns = new Set();
    var tableRows    = new Set();
    var tableNames   = new Set(tables);
    (struct.tables || []).forEach(function (t) {
      if (t.rowSymbol) tableRows.add(t.rowSymbol);
      (t.columns || []).forEach(function (c) { tableColumns.add(c); });
    });
    var scalars = (struct.symbols || [])
      .map(function (s) { return s.name; })
      .filter(function (n) {
        return n && !tableColumns.has(n) && !tableRows.has(n) && !tableNames.has(n);
      });
    // A table row walks either the whole table or one of its columns — the
    // sensor-column shape (fgHwSensorEntValue beside fgHwSensorEntName) names
    // the value column — so both belong on the Table side, or a correct column
    // pick is flagged "Not a table in this MIB".
    tables = tables.concat(Array.from(tableColumns));
    // De-dupe + sort so both dropdowns are predictable.
    tables  = Array.from(new Set(tables)).sort(function (a, b) { return a.localeCompare(b); });
    scalars = Array.from(new Set(scalars)).sort(function (a, b) { return a.localeCompare(b); });
    _mfgMibSymbolsCache[mibId] = { loading: false, scalars: scalars, tables: tables };
    // Preserving, not bare: this lands after the picking handler's own restore,
    // so a bare re-render re-erases everything the operator typed.
    _mfgRerenderPreservingAll();
  }).catch(function (err) {
    _mfgMibSymbolsCache[mibId] = { loading: false, scalars: [], tables: [] };
    showToast(err.message || "Failed to load MIB symbols", "error");
    _mfgRerenderPreservingAll();
  });
}

// Dropdown of MIBs available to symbol resolution at this manufacturer's
// scope. Three groups, in order:
//   1) Standard MIBs (RFC / IEEE specs Polaris ships seeded OIDs for) — the
//      `std:*` keys. Display-only at probe time; the value persists into
//      `defaultMibStdKey` so the MIB column shows a meaningful label.
//   2) Vendor MIBs — uploaded MIBs whose `manufacturer` matches this profile
//      (case-insensitive). Mirrors `oidRegistry`'s vendor-scope pass.
//   3) Generic MIBs — uploaded MIBs with `manufacturer = null`. The
//      resolver consults these at the generic tier for every vendor.
//
// `currentSelection` is the combined dropdown value (see joinMibSelection):
// "" = built-in seed, "std:*" = standard MIB key, UUID = uploaded MIB.
// `omitSeed=true` hides the "Built-in seed" placeholder so the add-row
// dropdown shows only real options (an empty-on-submit value still
// round-trips to mibId=null on the server side).
function renderMibSelect(currentSelection, cls, manufacturer, omitSeed) {
  var current = currentSelection || "";
  var mfg = (manufacturer || "").toLowerCase();
  var vendorScoped = (_mibsData || []).filter(function (m) {
    return (m.manufacturer || "").toLowerCase() === mfg;
  });
  var generic = (_mibsData || []).filter(function (m) {
    return !m.manufacturer;
  });
  var html = '<select class="' + cls + '" style="font-size:0.78rem">';
  if (omitSeed) {
    if (!current) {
      html += '<option value="" selected disabled>— select MIB —</option>';
    }
  } else {
    html += '<option value=""' + (!current ? " selected" : "") + '>Built-in seed</option>';
  }
  // Standard MIBs optgroup
  html += '<optgroup label="Standard MIBs">';
  STD_MIB_ORDER.forEach(function (key) {
    html += '<option value="' + escapeHtml(key) + '"' +
      (current === key ? " selected" : "") + '>' +
      escapeHtml(STD_MIB_LABELS[key]) +
    '</option>';
  });
  html += '</optgroup>';
  // Vendor MIBs optgroup (only when this profile has any vendor-scoped uploads)
  if (vendorScoped.length) {
    html += '<optgroup label="Vendor MIBs">';
    vendorScoped.forEach(function (m) {
      var label = m.moduleName || m.filename || m.id;
      if (m.model) label += " (" + m.model + ")";
      html += '<option value="' + escapeHtml(m.id) + '"' +
        (current === m.id ? " selected" : "") + '>' +
        escapeHtml(label) +
      '</option>';
    });
    html += '</optgroup>';
  }
  // Generic MIBs optgroup (only when at least one uploaded MIB has no manufacturer)
  if (generic.length) {
    html += '<optgroup label="Generic MIBs">';
    generic.forEach(function (m) {
      var label = m.moduleName || m.filename || m.id;
      html += '<option value="' + escapeHtml(m.id) + '"' +
        (current === m.id ? " selected" : "") + '>' +
        escapeHtml(label) +
      '</option>';
    });
    html += '</optgroup>';
  }
  html += '</select>';
  return html;
}

function transformLabel(kind) {
  for (var i = 0; i < _mfgProfileTransforms.length; i++) {
    if (_mfgProfileTransforms[i].kind === kind) return _mfgProfileTransforms[i].label;
  }
  // Fall through to combiners (double_scalar) — same lookup pattern; same
  // result if the kind isn't a recognized combiner either.
  for (var j = 0; j < _mfgProfileCombiners.length; j++) {
    if (_mfgProfileCombiners[j].kind === kind) return _mfgProfileCombiners[j].label;
  }
  return kind;
}

function wireManufacturerProfileControls() {
  var addBtn = document.getElementById("btn-add-mfg-profile");
  if (addBtn) addBtn.addEventListener("click", addManufacturerProfile);
  var importBtn = document.getElementById("btn-import-mfg-profile");
  var importFile = document.getElementById("f-import-mfg-profile");
  if (importBtn && importFile) {
    importBtn.addEventListener("click", function () { importFile.value = ""; importFile.click(); });
    importFile.addEventListener("change", function () {
      if (importFile.files && importFile.files[0]) openProfileImportModal(importFile.files[0]);
    });
  }

  wireManufacturerSuggestCombo();

  _loadUnprofiledManufacturers();
  var unprofiled = document.getElementById("mfg-unprofiled");
  if (unprofiled) unprofiled.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest(".mfg-unprofiled-create") : null;
    if (btn) addManufacturerProfile(btn.getAttribute("data-manufacturer"));
  });

  var list = document.getElementById("mfg-profiles-list");
  if (!list) return;

  // Delegated click handler — one listener covers every row, every edit
  // button, every save/cancel, override add/delete, profile delete.
  list.addEventListener("click", function (e) {
    var target = e.target;
    if (!(target instanceof Element)) return;

    var delBtn = target.closest(".mfg-profile-del");
    if (delBtn) { e.stopPropagation(); return deleteManufacturerProfile(delBtn.getAttribute("data-id")); }
    var codeBtn = target.closest(".mfg-profile-code");
    if (codeBtn) { e.stopPropagation(); return openProfileCodeModal(codeBtn.getAttribute("data-id")); }

    var header = target.closest(".mfg-profile-header");
    if (header) return toggleProfileExpand(header.parentElement.getAttribute("data-profile-id"));

    var matchSaveBtn = target.closest(".mfg-matchpattern-save");
    if (matchSaveBtn) return saveMatchPattern(matchSaveBtn);

    var editBtn = target.closest(".mfg-metric-edit");
    if (editBtn) return beginMetricEdit(editBtn.closest("tr"));

    var saveBtn = target.closest(".mfg-metric-save");
    if (saveBtn) return saveMetricEdit(saveBtn.closest("tr"));

    var cancelBtn = target.closest(".mfg-metric-cancel");
    if (cancelBtn) return cancelMetricEdit(cancelBtn.closest("tr"));

    var addOpenBtn = target.closest(".mfg-override-add-open");
    if (addOpenBtn) return toggleOverrideAdd(addOpenBtn.closest("tr"), true);

    var addCancelBtn = target.closest(".mfg-override-add-cancel");
    if (addCancelBtn) return toggleOverrideAdd(addCancelBtn.closest("tr"), false);

    var addOverBtn = target.closest(".mfg-override-add");
    if (addOverBtn) return addOverride(addOverBtn.closest("tr"));

    var delOverBtn = target.closest(".mfg-override-del");
    if (delOverBtn) return deleteOverride(delOverBtn.closest("tr"));

    var editOverBtn = target.closest(".mfg-override-edit");
    if (editOverBtn) return beginOverrideEdit(editOverBtn.closest("tr"));

    var saveOverBtn = target.closest(".mfg-override-save");
    if (saveOverBtn) return saveOverrideEdit(saveOverBtn.closest("tr"));

    var cancelOverBtn = target.closest(".mfg-override-cancel");
    if (cancelOverBtn) return cancelOverrideEdit(cancelOverBtn.closest("tr"));

    // ─── Widget click handlers ─────────────────────────────────────────
    var addWidgetToggleBtn = target.closest(".mfg-widget-add-toggle");
    if (addWidgetToggleBtn) {
      var pidAdd = addWidgetToggleBtn.getAttribute("data-profile-id");
      _mfgAddingWidget[pidAdd] = true;
      renderIdentificationTab();
      return;
    }
    var widgetEditBtn = target.closest(".mfg-widget-edit");
    if (widgetEditBtn) {
      var cardEdit = widgetEditBtn.closest(".mfg-widget-card");
      if (cardEdit) {
        _mfgWidgetEdit[cardEdit.getAttribute("data-widget-id")] = true;
        renderIdentificationTab();
      }
      return;
    }
    var widgetSaveBtn = target.closest(".mfg-widget-save");
    if (widgetSaveBtn) return saveWidgetEdit(widgetSaveBtn.closest(".mfg-widget-edit-card"));
    var widgetCancelBtn = target.closest(".mfg-widget-cancel");
    if (widgetCancelBtn) {
      var cardC = widgetCancelBtn.closest(".mfg-widget-edit-card");
      if (cardC) {
        var wid = cardC.getAttribute("data-widget-id");
        delete _mfgWidgetEdit[wid];
        _mfgWidgetClearShadow("widget:" + wid);
        renderIdentificationTab();
      }
      return;
    }
    var widgetAddSaveBtn = target.closest(".mfg-widget-add-save");
    if (widgetAddSaveBtn) return saveNewWidget(widgetAddSaveBtn.closest(".mfg-widget-add-card"));
    var widgetAddCancelBtn = target.closest(".mfg-widget-add-cancel");
    if (widgetAddCancelBtn) {
      var cardAC = widgetAddCancelBtn.closest(".mfg-widget-add-card");
      if (cardAC) {
        var pidAC = cardAC.getAttribute("data-profile-id");
        delete _mfgAddingWidget[pidAC];
        _mfgWidgetClearShadow("new-widget:" + pidAC);
        renderIdentificationTab();
      }
      return;
    }
    var widgetDevBtn = target.closest(".mfg-widget-devices");
    if (widgetDevBtn) {
      var cardDev = widgetDevBtn.closest(".mfg-widget-card");
      if (!cardDev) return;
      var pidDev = cardDev.getAttribute("data-profile-id");
      var widDev = cardDev.getAttribute("data-widget-id");
      var prof = (_mfgProfileDetail && _mfgProfileDetail[pidDev]) || null;
      var wDef = prof && (prof.widgets || []).find(function (x) { return x.id === widDev; });
      return openWidgetDevicesModal(pidDev, wDef || { id: widDev, name: "widget" }, false);
    }
    var widgetDelBtn = target.closest(".mfg-widget-del");
    if (widgetDelBtn) {
      var cardDel = widgetDelBtn.closest(".mfg-widget-card");
      if (cardDel) return deleteWidget(cardDel.getAttribute("data-profile-id"), cardDel.getAttribute("data-widget-id"));
      return;
    }
  });

  // The chained MIB → Symbol pickers need a `change` listener separate
  // from the click delegation above. When the operator changes any of
  // the three MIB selects in this card, stash the new value into the
  // edit-state map and re-render so the symbol picker swaps from text
  // input (seed) to dropdown (MIB-driven), or to a different MIB's symbol
  // list. _ensureMibSymbols pre-warms the cache so the dropdown is ready.
  list.addEventListener("change", function (e) {
    var target = e.target;
    if (!(target instanceof Element)) return;

    if (target.classList.contains("mfg-edit-mib")) {
      var tr = target.closest("tr");
      if (!tr) return;
      var key = "metric:" + tr.getAttribute("data-profile-id") + ":" + tr.getAttribute("data-metric-key");
      _mfgEditMibSelections[key] = target.value || "";
      if (target.value) _ensureMibSymbols(target.value);
      _mfgRerenderPreserving(target);
      return;
    }
    if (target.classList.contains("mfg-edit-override-mib")) {
      var tr2 = target.closest("tr");
      if (!tr2) return;
      _mfgEditMibSelections["override:" + tr2.getAttribute("data-override-id")] = target.value || "";
      if (target.value) _ensureMibSymbols(target.value);
      _mfgRerenderPreserving(target);
      return;
    }
    if (target.classList.contains("mfg-new-override-mib")) {
      var tr3 = target.closest("tr");
      if (!tr3) return;
      _mfgEditMibSelections["new:" + tr3.getAttribute("data-profile-id") + ":" + tr3.getAttribute("data-metric-key")] = target.value || "";
      if (target.value) _ensureMibSymbols(target.value);
      _mfgRerenderPreserving(target);
      return;
    }
    // Type selectors — flipping scalar / double_scalar / table re-renders
    // both the Symbol cell (1 or 2 pickers) AND the Transform select (unary
    // transforms vs binary combiners). Three flavours: metric-row edit,
    // override-row edit, add-override row.
    if (target.classList.contains("mfg-edit-type")) {
      var trType = target.closest("tr");
      if (!trType) return;
      _mfgEditTypeSelections["metric:" + trType.getAttribute("data-profile-id") + ":" + trType.getAttribute("data-metric-key")] = target.value;
      _mfgRerenderPreserving(target);
      return;
    }
    if (target.classList.contains("mfg-edit-override-type")) {
      var trTypeOv = target.closest("tr");
      if (!trTypeOv) return;
      _mfgEditTypeSelections["override:" + trTypeOv.getAttribute("data-override-id")] = target.value;
      _mfgRerenderPreserving(target);
      return;
    }
    if (target.classList.contains("mfg-new-override-type")) {
      var trTypeNew = target.closest("tr");
      if (!trTypeNew) return;
      _mfgEditTypeSelections["new:" + trTypeNew.getAttribute("data-profile-id") + ":" + trTypeNew.getAttribute("data-metric-key")] = target.value;
      _mfgRerenderPreserving(target);
      return;
    }
    // ─── Widget MIB / Type / WidgetType selects ───────────────────────
    // The widget card hosts THREE chained selects (MIB → symbol Type →
    // Symbol picker; plus a parallel WidgetType select that drives the
    // displayOptions sub-form). They share these class names with the
    // metric-row controls, so first resolve which card they live in
    // before falling through to the metric handlers above… actually
    // the widget-card classes are unique (mfg-widget-mib etc.) so this
    // is straight-through.
    // State-probe mode: only some modes take comparison values. Toggled IN PLACE
    // rather than through renderIdentificationTab() — a re-render rebuilds the
    // card from the stored widget, which would discard whatever the operator has
    // typed into the other mapping fields.
    if (target.classList.contains("mfg-widget-statemode")) {
      var cardSM = target.closest(".mfg-widget-edit-card, .mfg-widget-add-card");
      if (!cardSM) return;
      var valsEl = cardSM.querySelector(".mfg-widget-statevalues");
      if (valsEl) valsEl.disabled = STATE_MODES_WITH_VALUES.indexOf(target.value) === -1;
      return;
    }
    if (target.classList.contains("mfg-widget-mib")) {
      var cardWM = target.closest(".mfg-widget-edit-card, .mfg-widget-add-card");
      if (!cardWM) return;
      var keyWM = _widgetCardKey(cardWM);
      _mfgWidgetEditMib[keyWM] = target.value || "";
      if (target.value) _ensureMibSymbols(target.value);
      _mfgRerenderPreserving(target);
      return;
    }
    if (target.classList.contains("mfg-widget-type")) {
      var cardWT = target.closest(".mfg-widget-edit-card, .mfg-widget-add-card");
      if (!cardWT) return;
      _mfgWidgetEditType[_widgetCardKey(cardWT)] = target.value;
      _mfgRerenderPreserving(target);
      return;
    }
    // Port controls on an http widget. Handled here rather than by a re-render
    // because nothing about the payload changes — only whether the field is
    // editable and which default its placeholder names.
    if (target.classList.contains("mfg-http-customport") || target.classList.contains("mfg-http-https")) {
      var cardHP = target.closest(".mfg-widget-edit-card, .mfg-widget-add-card");
      if (!cardHP) return;
      var cpBox = cardHP.querySelector(".mfg-http-customport");
      var tlsBox = cardHP.querySelector(".mfg-http-https");
      var pInput = cardHP.querySelector(".mfg-http-port");
      if (cpBox && pInput) {
        pInput.disabled = !cpBox.checked;
        pInput.style.opacity = cpBox.checked ? "" : "0.5";
        pInput.placeholder = "default (" + (tlsBox && tlsBox.checked ? "443" : "80") + ")";
      }
      return;
    }
    if (target.classList.contains("mfg-widget-widgettype")) {
      var cardWWT = target.closest(".mfg-widget-edit-card, .mfg-widget-add-card");
      if (!cardWWT) return;
      _mfgWidgetEditWidgetType[_widgetCardKey(cardWWT)] = target.value;
      _mfgRerenderPreserving(target);
      return;
    }
  });
}

// Derive the widget-shadow-store key from an edit or add card element.
function _widgetCardKey(cardEl) {
  if (!cardEl) return "";
  if (cardEl.classList.contains("mfg-widget-edit-card")) {
    return "widget:" + cardEl.getAttribute("data-widget-id");
  }
  return "new-widget:" + cardEl.getAttribute("data-profile-id");
}

// ─── Preserving typed input across a chained-select re-render ───────────────
//
// The MIB / symbol-type / widget-type selects are chained: changing one changes
// what the dependent controls offer (Symbol comes from the MIB, the sub-form
// from the widget type), so each handler re-renders. But the re-render rebuilds
// every row and card from STORED state, and the only things carried across were
// the three selects themselves — so an operator who typed a Name and then
// picked a MIB watched the Name vanish. Every field was affected, on the metric
// rows and override rows as much as the widget card.
//
// Rather than a shadow store per field (nine handlers × a growing set of
// fields), snapshot the editing container's live control values, re-render, then
// write them back. Keyed on the same identity the handlers already use, so the
// values can't land in a different row. A `<select>` whose options changed drops
// a value the new list doesn't offer — which is what should happen to a Symbol
// after its MIB is swapped.

/** The editing container an element belongs to (widget card or table row). */
function _mfgEditContainerOf(el) {
  if (!el || !el.closest) return null;
  return el.closest(".mfg-widget-edit-card, .mfg-widget-add-card, .mfg-profile-scope, tr");
}

/** Stable identity for a container, matching the handlers' shadow-store keys so
 *  a snapshot is restored into the same row it came from. */
function _mfgEditContainerKey(container) {
  if (!container) return "";
  if (container.classList.contains("mfg-widget-edit-card") ||
      container.classList.contains("mfg-widget-add-card")) {
    return _widgetCardKey(container);
  }
  // The profile's "also applies when" box is a per-profile editor with no
  // metric key — an unsaved pattern must survive a re-render kicked off by
  // any row below it, so it gets its own container identity.
  if (container.classList.contains("mfg-profile-scope")) {
    return "profile:" + container.getAttribute("data-profile-id");
  }
  var ovr = container.getAttribute("data-override-id");
  if (ovr) return "override:" + ovr;
  var pid = container.getAttribute("data-profile-id");
  var mk = container.getAttribute("data-metric-key");
  if (!pid || !mk) return "";
  // A metric row and the "add override" row beneath it share profile+metricKey;
  // the controls each one owns are what tell them apart.
  var isNew = !!container.querySelector(".mfg-new-override-mib, .mfg-new-override-type, .mfg-new-override-symbol");
  return (isNew ? "new:" : "metric:") + pid + ":" + mk;
}

/** The field's snapshot key — its own `mfg-*` class, which is unique per
 *  control within a container. */
function _mfgFieldKey(el) {
  var cls = (el.className || "").split(/\s+/);
  for (var i = 0; i < cls.length; i++) {
    if (cls[i].indexOf("mfg-") === 0) return cls[i];
  }
  return "";
}

function _mfgSnapshotFields(container) {
  var vals = {};
  if (!container) return vals;
  container.querySelectorAll("input, select, textarea").forEach(function (el) {
    var key = _mfgFieldKey(el);
    if (!key) return;
    vals[key] = (el.type === "checkbox" || el.type === "radio") ? el.checked : el.value;
  });
  return vals;
}

/**
 * Re-render the Identification tab without losing what the operator has typed
 * into the row/card that triggered it. Use this instead of a bare
 * renderIdentificationTab() from any chained-control handler.
 */
function _mfgRerenderPreserving(el) {
  var container = _mfgEditContainerOf(el);
  var key = _mfgEditContainerKey(container);
  var vals = _mfgSnapshotFields(container);
  renderIdentificationTab();
  if (!key || !Object.keys(vals).length) return;
  var snap = {};
  snap[key] = vals;
  _mfgRestoreEditors(snap);
}

/** Every open editing container's live values, keyed by container identity. */
function _mfgSnapshotAllEditors() {
  var snap = {};
  document.querySelectorAll(".mfg-widget-edit-card, .mfg-widget-add-card, .mfg-profile-scope, tr[data-metric-key], tr[data-override-id]")
    .forEach(function (c) {
      var key = _mfgEditContainerKey(c);
      if (!key) return;
      var vals = _mfgSnapshotFields(c);
      if (Object.keys(vals).length) snap[key] = vals;
    });
  return snap;
}

/** Write a snapshot back into whichever containers now carry those keys. */
function _mfgRestoreEditors(snap) {
  if (!snap) return;
  document.querySelectorAll(".mfg-widget-edit-card, .mfg-widget-add-card, .mfg-profile-scope, tr[data-metric-key], tr[data-override-id]")
    .forEach(function (c) {
      var vals = snap[_mfgEditContainerKey(c)];
      if (!vals) return;
      c.querySelectorAll("input, select, textarea").forEach(function (field) {
        var fk = _mfgFieldKey(field);
        if (!fk || !(fk in vals)) return;
        if (field.type === "checkbox" || field.type === "radio") { field.checked = !!vals[fk]; return; }
        // A <select> whose options changed drops a value the new list doesn't
        // offer — which is what should happen to a Symbol after a MIB swap.
        // The Symbol combobox is a text box, so it is told to do the same.
        if (field.classList.contains("mib-sym-combo") && !_symComboAccepts(field, vals[fk])) return;
        field.value = vals[fk];
        if (field.classList.contains("mib-sym-combo")) _symComboMarkUnknown(field);
      });
    });
}

/**
 * Re-render preserving EVERY open editor, for a re-render with no triggering
 * element to key from — specifically the ASYNCHRONOUS one.
 *
 * `_mfgRerenderPreserving` above fixes the re-render a chained select performs
 * synchronously, but picking a MIB also kicks off `_ensureMibSymbols`, whose
 * fetch re-renders again when it resolves. That second render lands AFTER the
 * restore, from a callback that never saw the element, so on a cache miss — i.e.
 * every first pick of a MIB, the reported case — the operator watched the Name
 * come back and then vanish again a few hundred ms later. Snapshotting all open
 * editors is what lets a callback with no context put them back.
 */
function _mfgRerenderPreservingAll() {
  var snap = _mfgSnapshotAllEditors();
  renderIdentificationTab();
  _mfgRestoreEditors(snap);
}

// ─── "+ Add Manufacturer" typeahead ────────────────────────────────────────
// The box stays free text — any custom vendor is accepted. The dropdown only
// offers what Polaris already knows (asset manufacturers + the alias/OUI
// canonicals from MAC & Vendor Identification) so a profile is far likelier to
// be spelled the way `getProfileFor` resolves it. Same open-on-click combobox
// the automations wizard uses; `<datalist>` is deliberately avoided (most
// browsers won't open one on click).

var _MFG_SUGGEST_SOURCE_LABELS = { asset: "in inventory", alias: "alias", oui: "OUI override" };

function _mfgSuggestEls() {
  var input = document.getElementById("f-mfg-profile-add-name");
  var box = document.getElementById("mfg-profile-add-suggest");
  return input && box ? { input: input, box: box } : null;
}

function _closeMfgSuggest(box) {
  if (box) { box.classList.remove("open"); box.innerHTML = ""; }
}

// Fetch-once, coalesced. A failure closes the dropdown silently — suggestions
// are an aid, and the operator can always type the name.
function _ensureMfgSuggestions() {
  if (_mfgSuggestions) return Promise.resolve(_mfgSuggestions);
  if (!_mfgSuggestionsPromise) {
    _mfgSuggestionsPromise = api.serverSettings.listManufacturerSuggestions()
      .then(function (resp) {
        _mfgSuggestions = (resp && resp.suggestions) || [];
        return _mfgSuggestions;
      })
      .catch(function () { _mfgSuggestions = []; return _mfgSuggestions; })
      .finally(function () { _mfgSuggestionsPromise = null; });
  }
  return _mfgSuggestionsPromise;
}

function _renderMfgSuggest(input, box, rows) {
  var q = (input.value || "").trim().toLowerCase();
  // Prefix matches first, then interior — typing "ar" should offer "Aruba"
  // before "Hikari". An exact match is kept, and leads: dropping it made a
  // correct name ("APC", carried by 8 devices) read as "No known manufacturer
  // matches".
  var matches = _filterSuggestRows(rows, q);
  matches = matches.slice(0, 50);
  if (!matches.length) {
    // Suggestions leave out manufacturers that already have a profile, so a
    // name with no match may be one of those — say so rather than invite an
    // Add that 409s.
    var taken = q && (_mfgProfiles || []).some(function (p) { return (p.manufacturer || "").toLowerCase() === q; });
    box.innerHTML = '<div class="aw-suggest-empty">' +
      (taken ? "A profile for this manufacturer already exists — open it above."
         : q ? "No known manufacturer matches — press Add to create it anyway."
         : "No suggestions yet — every known manufacturer already has a profile.") +
      '</div>';
    box.classList.add("open");
    return;
  }
  box.innerHTML = matches.map(function (r) {
    var hints = (r.sources || []).map(function (s) {
      return s === "asset" && r.assetCount
        ? _mfgDeviceCountLabel(r.assetCount)
        : (_MFG_SUGGEST_SOURCE_LABELS[s] || s);
    });
    return _mfgSuggestItemHTML(r.value, hints);
  }).join("");
  box.classList.add("open");
}

/** Both manufacturer pickers' filter: rows containing `q` (lowercased), the
 *  exact match first, then prefix matches, then interior ones. The sort is
 *  stable, so the caller's order (device count) holds within each band. */
function _filterSuggestRows(rows, q) {
  var matches = rows.filter(function (r) { return !q || r.value.toLowerCase().indexOf(q) !== -1; });
  if (!q) return matches;
  function rank(r) {
    var v = r.value.toLowerCase();
    return v === q ? 0 : v.indexOf(q) === 0 ? 1 : 2;
  }
  return matches.sort(function (a, b) { return rank(a) - rank(b); });
}

// Shared by both manufacturer pickers so "· 8 devices" reads the same on each.
function _mfgDeviceCountLabel(n) {
  return n + " device" + (n === 1 ? "" : "s");
}

function _mfgSuggestItemHTML(value, hints) {
  return '<div class="aw-suggest-item" data-val="' + escapeHtml(value) + '">' +
    escapeHtml(value) +
    (hints.length ? ' <span style="color:var(--color-text-tertiary)">· ' + escapeHtml(hints.join(" · ")) + '</span>' : "") +
  '</div>';
}

function _openMfgSuggest() {
  var els = _mfgSuggestEls();
  if (!els) return;
  _ensureMfgSuggestions().then(function (rows) {
    // The card re-renders freely; bail if this input is no longer the live one.
    var live = _mfgSuggestEls();
    if (!live || live.input !== els.input || document.activeElement !== live.input) return;
    _renderMfgSuggest(live.input, live.box, rows);
  });
}

function wireManufacturerSuggestCombo() {
  var els = _mfgSuggestEls();
  if (!els) return;
  var input = els.input, box = els.box;

  input.addEventListener("focus", _openMfgSuggest);
  input.addEventListener("click", _openMfgSuggest);
  input.addEventListener("input", function () {
    if (_mfgSuggestions) _renderMfgSuggest(input, box, _mfgSuggestions);
    else _openMfgSuggest();
  });
  input.addEventListener("blur", function () {
    // Delay so a mousedown on an item (which fires before blur completes) lands.
    setTimeout(function () { _closeMfgSuggest(box); }, 150);
  });
  box.addEventListener("mousedown", function (e) {
    var item = e.target.closest && e.target.closest(".aw-suggest-item");
    if (!item) return;
    e.preventDefault(); // keep focus on the input
    input.value = item.getAttribute("data-val");
    _closeMfgSuggest(box);
  });
  input.addEventListener("keydown", function (e) {
    var open = box.classList.contains("open");
    if (e.key === "Escape") { if (open) { _closeMfgSuggest(box); e.stopPropagation(); } return; }
    if (e.key === "Enter" && !open) { addManufacturerProfile(); return; }
    if (!open) return;
    var items = Array.prototype.slice.call(box.querySelectorAll(".aw-suggest-item"));
    var idx = items.findIndex(function (i) { return i.classList.contains("active"); });
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!items.length) return;
      e.preventDefault();
      var next = e.key === "ArrowDown" ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
      items.forEach(function (i) { i.classList.remove("active"); });
      items[next].classList.add("active");
      if (items[next].scrollIntoView) items[next].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      // A highlighted suggestion completes the box; otherwise Enter submits
      // whatever was typed, so a custom name never needs a mouse.
      if (idx >= 0) { input.value = items[idx].getAttribute("data-val"); _closeMfgSuggest(box); }
      else { _closeMfgSuggest(box); addManufacturerProfile(); }
    }
  });
}

// ─── Manufacturer-with-device-count typeahead ──────────────────────────────
// Shared by the MIB upload form and the Device Icons card. A vendor MIB (or
// icon) only applies to assets whose manufacturer matches the name it is saved
// under, so the picker leads with the manufacturers actually in inventory —
// most devices first, each with its count — and follows with names only an
// earlier MIB / alias / icon carries. Free text is still accepted. Counts come
// from `_mibFacets.assetCounts`, already loaded with the tab; no extra fetch.

/** De-duplicated (case-insensitive, first spelling wins) rows with their
 *  device counts, most devices first, then alphabetical. */
function _manufacturerCountRows(names) {
  var counts = (_mibFacets && _mibFacets.assetCounts) || {};
  var byKey = {};
  var rows = [];
  (names || []).forEach(function (n) {
    var v = (n || "").trim();
    var k = v.toLowerCase();
    if (!v || byKey[k]) return;
    byKey[k] = { value: v, assetCount: 0 };
    rows.push(byKey[k]);
  });
  // A count keyed by a different casing still lands on its row.
  Object.keys(counts).forEach(function (m) {
    var row = byKey[m.trim().toLowerCase()];
    if (row) row.assetCount += counts[m];
  });
  return rows.sort(function (a, b) { return b.assetCount - a.assetCount || a.value.localeCompare(b.value); });
}

function _mibUploadMfrRows() {
  return _manufacturerCountRows((_mibFacets && _mibFacets.manufacturers) || []);
}

function _renderManufacturerCountSuggest(input, box, rows) {
  var q = (input.value || "").trim().toLowerCase();
  var matches = _filterSuggestRows(rows, q).slice(0, 50);
  if (!matches.length) {
    box.innerHTML = '<div class="aw-suggest-empty">' +
      (q ? "No known manufacturer matches — the name is used as typed."
         : "No manufacturers in inventory yet — type the vendor name.") +
      '</div>';
    box.classList.add("open");
    return;
  }
  box.innerHTML = matches.map(function (r) {
    return _mfgSuggestItemHTML(r.value, r.assetCount ? [_mfgDeviceCountLabel(r.assetCount)] : []);
  }).join("");
  box.classList.add("open");
}

function wireMibUploadManufacturerCombo() {
  _wireManufacturerCountCombo("f-mib-up-mfr", "mib-up-mfr-suggest", _mibUploadMfrRows);
}

function _wireManufacturerCountCombo(inputId, boxId, rowsFn) {
  var input = document.getElementById(inputId);
  var box = document.getElementById(boxId);
  if (!input || !box) return;
  function open() { _renderManufacturerCountSuggest(input, box, rowsFn()); }

  input.addEventListener("focus", open);
  input.addEventListener("click", open);
  input.addEventListener("input", open);
  input.addEventListener("blur", function () {
    // Delay so a mousedown on an item (which fires before blur completes) lands.
    setTimeout(function () { _closeMfgSuggest(box); }, 150);
  });
  box.addEventListener("mousedown", function (e) {
    var item = e.target.closest && e.target.closest(".aw-suggest-item");
    if (!item) return;
    e.preventDefault(); // keep focus on the input
    input.value = item.getAttribute("data-val");
    _closeMfgSuggest(box);
  });
  input.addEventListener("keydown", function (e) {
    if (!box.classList.contains("open")) return;
    if (e.key === "Escape") { _closeMfgSuggest(box); e.stopPropagation(); return; }
    var items = Array.prototype.slice.call(box.querySelectorAll(".aw-suggest-item"));
    var idx = items.findIndex(function (i) { return i.classList.contains("active"); });
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!items.length) return;
      e.preventDefault();
      var next = e.key === "ArrowDown" ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
      items.forEach(function (i) { i.classList.remove("active"); });
      items[next].classList.add("active");
      if (items[next].scrollIntoView) items[next].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && idx >= 0) {
      e.preventDefault();
      input.value = items[idx].getAttribute("data-val");
      _closeMfgSuggest(box);
    }
  });
}

// ─── Export / import a profile ─────────────────────────────────────────────
// The file names MIBs and credentials by NAME (no ids, no secrets) and carries
// no per-asset widget switches. Import previews every item — create or
// replace, and any MIB this install lacks — and brings in only what is ticked.
// A widget whose MIB is missing cannot be imported and is offered disabled
// until the MIB is uploaded.

/** The portable form of a View Code body: the same JSON minus every row id. */
function _profileForExport(code) {
  var file = JSON.parse(JSON.stringify(code));
  (file.widgets || []).forEach(function (w) { delete w.id; });
  (file.metrics || []).forEach(function (m) { (m.overrides || []).forEach(function (o) { delete o.id; }); });
  file.exportedAt = new Date().toISOString();
  return file;
}

function _downloadProfileFile(file) {
  var name = String(file.manufacturer || "profile").replace(/[^A-Za-z0-9._-]+/g, "_") + ".manufacturer-profile.json";
  var blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  var mibs = (file.mibs || []).map(function (m) { return m.moduleName; });
  showToast("Exported " + file.manufacturer + (mibs.length ? " — it needs " + mibs.join(", ") + " uploaded where it is imported" : ""), "success");
}

/**
 * What a View Code save would REMOVE — deleted widgets (their per-device
 * switches go with them), deleted per-type / per-model rows, and metric rows
 * cleared back to the built-in seed — for the confirm before saving.
 */
function _profileCodeRemovals(original, edited) {
  var out = [];
  var keptWidgets = {};
  (edited.widgets || []).forEach(function (w) { if (w.id) keptWidgets[w.id] = 1; });
  (original.widgets || []).forEach(function (w) { if (!keptWidgets[w.id]) out.push("delete widget \"" + w.name + "\" (and its per-device switches)"); });
  (original.metrics || []).forEach(function (m) {
    var e = (edited.metrics || []).find(function (x) { return x.metricKey === m.metricKey; });
    if (!e && (m.symbol || m.symbolB)) out.push("clear the " + m.metricKey + " row back to the built-in default");
    var kept = {};
    ((e && e.overrides) || []).forEach(function (o) { if (o.id) kept[o.id] = 1; });
    (m.overrides || []).forEach(function (o) {
      if (!kept[o.id]) out.push("delete the " + m.metricKey + " row for " + (o.assetType || "") + (o.assetType && o.modelPattern ? " / " : "") + (o.modelPattern || ""));
    });
  });
  return out;
}

// View Code — the automations idiom (PolarisAutomationPortability.openCodeModal):
// the profile as editable JSON, with Copy, Export (the portable file, ids
// stripped) and Save changes (a FULL replace — rows left out are cleared or
// deleted, confirmed first).
async function openProfileCodeModal(id) {
  var code;
  try {
    code = await api.serverSettings.getManufacturerProfileCode(id);
  } catch (err) {
    showToast(err.message || "Could not load the profile", "error");
    return;
  }
  var canSave = permAtLeast("manufacturerProfiles", "write");
  var text = JSON.stringify(code, null, 2);
  var note =
    '<p style="font-size:0.85rem;color:var(--color-text-tertiary);margin:0 0 0.5rem">' +
      'This is the <b>' + escapeHtml(code.manufacturer) + '</b> profile as it is stored. ' +
      (canSave
        ? '<strong>Saving replaces the whole profile</strong>: a metric row you remove goes back to the built-in default, and a per-type / per-model row or widget you remove is deleted. ' +
          'Rows keep their <code>id</code> so an edit updates them in place; a row without one is added. MIBs and credentials are named — the names must exist on this install.'
        : 'You do not have permission to change it.') +
    '</p>' +
    '<p style="font-size:0.8rem;color:var(--color-text-tertiary);margin:0 0 0.75rem">' +
      '<strong>Copy</strong> gives you exactly what is shown; <strong>Export</strong> downloads the portable file instead (the same, minus row ids), which another install can import.' +
    '</p>';
  var body = note +
    '<textarea id="pcode-text" rows="24" spellcheck="false" ' + (canSave ? "" : "readonly ") +
      'style="width:100%;font-family:var(--font-mono);font-size:0.8rem;line-height:1.45">' + escapeHtml(text) + '</textarea>' +
    '<div id="pcode-err" class="form-error" style="display:none;margin-top:0.5rem;white-space:pre-wrap"></div>';
  var footer =
    '<button class="btn btn-secondary" id="pcode-export" type="button" title="Download this profile as a portable file">Export</button>' +
    '<button class="btn btn-secondary" id="pcode-copy" type="button">Copy</button>' +
    '<button class="btn btn-secondary" id="pcode-cancel" type="button">' + (canSave ? "Cancel" : "Close") + '</button>' +
    (canSave ? '<button class="btn btn-primary" id="pcode-save" type="button">Save changes</button>' : "");
  var ov = buildOverlay(1300, code.manufacturer + " — profile code", body, footer, null, true);
  var ta = ov.overlay.querySelector("#pcode-text");
  var errBox = ov.overlay.querySelector("#pcode-err");
  function showErr(msg) { errBox.textContent = msg; errBox.style.display = ""; }

  /** The textarea as a profile object, or null with the error shown. Export and
   *  Save share it, so an unparseable edit is never exported off the last good
   *  version without saying so. */
  function readEdited() {
    errBox.style.display = "none";
    var parsed;
    try { parsed = JSON.parse(ta.value); } catch (err) {
      showErr("Invalid JSON: " + ((err && err.message) || "could not be parsed"));
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { showErr("The profile must be a JSON object."); return null; }
    return parsed;
  }

  ov.overlay.querySelector("#pcode-cancel").addEventListener("click", function () { ov.close(); });
  ov.overlay.querySelector("#pcode-export").addEventListener("click", function () {
    var parsed = readEdited();
    if (parsed) _downloadProfileFile(_profileForExport(parsed));
  });
  ov.overlay.querySelector("#pcode-copy").addEventListener("click", function () {
    var btn = this;
    function done(ok) { btn.textContent = ok ? "Copied" : "Copy failed"; setTimeout(function () { btn.textContent = "Copy"; }, 1500); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ta.value).then(function () { done(true); }, function () { done(false); });
    } else {
      try { ta.select(); document.execCommand("copy"); done(true); } catch (_e) { done(false); }
    }
  });
  if (canSave) {
    ov.overlay.querySelector("#pcode-save").addEventListener("click", async function () {
      var btn = this;
      var parsed = readEdited();
      if (!parsed) return;
      if (JSON.stringify(parsed) === JSON.stringify(code)) { ov.close(); return; }
      var removals = _profileCodeRemovals(code, parsed);
      if (removals.length) {
        var ok = await showConfirm("Save these changes? Saving will also:\n\n" + removals.map(function (r) { return "- " + r; }).join("\n"));
        if (!ok) return;
      }
      btn.disabled = true;
      try {
        await api.serverSettings.saveManufacturerProfileCode(id, parsed);
        ov.close();
        showToast("Profile saved", "success");
        var listResp = await api.serverSettings.listManufacturerProfiles();
        _mfgProfiles = (listResp && listResp.profiles) || _mfgProfiles;
        var detail = await api.serverSettings.getManufacturerProfile(id);
        _mfgProfileDetail[id] = detail && detail.profile;
        renderIdentificationTab();
      } catch (err) {
        btn.disabled = false;
        showErr((err && err.message) || "Save failed");
      }
    });
  }
}

var PROFILE_IMPORT_MAX_BYTES = 1024 * 1024;
var PROFILE_IMPORT_GROUPS = [
  ["settings", "Profile"], ["metric", "Metric rows"], ["override", "Per-type / per-model rows"],
  ["widget", "Custom widgets"], ["layout", "Custom MIB tab"],
];

async function openProfileImportModal(fileObj) {
  if (fileObj.size > PROFILE_IMPORT_MAX_BYTES) { showToast("That file is too large to be a manufacturer profile", "error"); return; }
  var file;
  try {
    file = JSON.parse(await fileObj.text());
  } catch (_) {
    showToast("That file is not JSON", "error");
    return;
  }
  var preview;
  try {
    preview = await api.serverSettings.previewManufacturerProfileImport(file);
  } catch (err) {
    showToast(err.message || "Could not read that profile", "error");
    return;
  }
  var items = preview.items || [];
  var missing = (preview.mibs || []).filter(function (m) { return !m.present; });
  var mibName = function (m) { return m.moduleName + (m.manufacturer ? " (" + m.manufacturer + (m.model ? " " + m.model : "") + ")" : ""); };

  var body =
    '<p style="margin:0 0 0.6rem;font-size:0.85rem">' +
      (preview.targetProfileId
        ? 'Imports into the existing <b>' + escapeHtml(preview.manufacturer) + '</b> profile. Items marked <b>replaces</b> overwrite what is there.'
        : 'Creates a new <b>' + escapeHtml(preview.manufacturer) + '</b> profile.') +
    '</p>' +
    (missing.length
      ? '<div style="margin:0 0 0.6rem;padding:8px 10px;border:1px solid var(--color-warning,#d97706);border-radius:4px;font-size:0.82rem">' +
          '<b style="color:var(--color-warning,#d97706)">Missing MIB' + (missing.length === 1 ? '' : 's') + ':</b> ' +
          missing.map(function (m) { return '<code>' + escapeHtml(mibName(m)) + '</code>'; }).join(", ") +
          '. Upload ' + (missing.length === 1 ? 'it' : 'them') + ' at MIB Database, then import again. ' +
          'Widgets that need a missing MIB can\'t be imported until then; metric rows import but won\'t resolve.' +
        '</div>'
      : '') +
    '<div style="display:flex;gap:10px;margin-bottom:0.4rem;font-size:0.8rem">' +
      '<a href="#" id="pimp-all">Select all</a><a href="#" id="pimp-none">Select none</a>' +
    '</div>' +
    '<div style="max-height:50vh;overflow:auto;border:1px solid var(--color-border);border-radius:4px;padding:6px 10px">' +
    PROFILE_IMPORT_GROUPS.map(function (g) {
      var group = items.filter(function (it) { return it.kind === g[0]; });
      if (!group.length) return "";
      return '<div style="font-size:0.74rem;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--color-text-tertiary);margin:8px 0 4px">' + escapeHtml(g[1]) + '</div>' +
        group.map(function (it) {
          var notes = [];
          if (it.action === "replace") notes.push('<span style="color:var(--color-warning,#d97706)">replaces existing</span>');
          if (it.missingMibs && it.missingMibs.length) notes.push('<span style="color:var(--color-warning,#d97706)">MIB missing: ' + escapeHtml(it.missingMibs.map(function (m) { return m.moduleName; }).join(", ")) + '</span>');
          if (it.missingCredential) notes.push('<span style="color:var(--color-warning,#d97706)">no credential named "' + escapeHtml(it.missingCredential) + '" — imports unauthenticated</span>');
          if (it.blocked) notes.push('<span style="color:var(--color-danger)">' + escapeHtml(it.blocked) + '</span>');
          return '<label style="display:flex;gap:8px;align-items:flex-start;padding:3px 0;font-size:0.84rem' + (it.blocked ? ';opacity:0.6' : '') + '">' +
            '<input type="checkbox" class="pimp-item" value="' + escapeHtml(it.id) + '"' + (it.blocked ? ' disabled' : ' checked') + ' style="margin-top:3px">' +
            '<span>' + escapeHtml(it.label) + (notes.length ? '<br><span style="font-size:0.76rem">' + notes.join(" · ") + '</span>' : '') + '</span>' +
          '</label>';
        }).join("");
    }).join("") +
    '</div>';
  openModal("Import manufacturer profile", body,
    '<button class="btn btn-secondary" id="pimp-cancel">Cancel</button><button class="btn btn-primary" id="pimp-go">Import</button>');

  var boxes = Array.prototype.slice.call(document.querySelectorAll("#modal-overlay .pimp-item"));
  var go = document.getElementById("pimp-go");
  function refresh() {
    var n = boxes.filter(function (b) { return b.checked; }).length;
    go.textContent = n ? "Import " + n + " item" + (n === 1 ? "" : "s") : "Import";
    go.disabled = n === 0;
  }
  boxes.forEach(function (b) { b.addEventListener("change", refresh); });
  document.getElementById("pimp-all").addEventListener("click", function (e) { e.preventDefault(); boxes.forEach(function (b) { if (!b.disabled) b.checked = true; }); refresh(); });
  document.getElementById("pimp-none").addEventListener("click", function (e) { e.preventDefault(); boxes.forEach(function (b) { b.checked = false; }); refresh(); });
  document.getElementById("pimp-cancel").addEventListener("click", closeModal);
  go.addEventListener("click", async function () {
    var picked = boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
    go.disabled = true;
    try {
      var res = await api.serverSettings.applyManufacturerProfileImport(file, picked);
      var failed = (res.results || []).filter(function (r) { return !r.ok; });
      closeModal();
      if (failed.length) {
        showToast((res.results.length - failed.length) + " imported, " + failed.length + " failed: " +
          failed.map(function (r) { return r.id + " — " + r.error; }).join("; "), "error");
      } else {
        showToast("Imported " + res.results.length + " item" + (res.results.length === 1 ? "" : "s") + " into " + preview.manufacturer, "success");
      }
      // Fresh list (counts, a new profile) and no stale detail for the target.
      var listResp = await api.serverSettings.listManufacturerProfiles();
      _mfgProfiles = (listResp && listResp.profiles) || _mfgProfiles;
      var detail = await api.serverSettings.getManufacturerProfile(res.profileId);
      _mfgProfileDetail[res.profileId] = detail && detail.profile;
      _mfgProfileExpanded[res.profileId] = true;
      _mfgSuggestions = null;
      _mfgUnprofiled = null;
      renderIdentificationTab();
    } catch (err) {
      go.disabled = false;
      showToast(err.message || "Import failed", "error");
    }
  });
  refresh();
}

async function addManufacturerProfile(nameArg) {
  var input = document.getElementById("f-mfg-profile-add-name");
  var name = typeof nameArg === "string" && nameArg ? nameArg.trim() : (input && input.value ? input.value.trim() : "");
  if (!name) { showToast("Manufacturer is required", "error"); return; }
  try {
    var resp = await api.serverSettings.createManufacturerProfile({ manufacturer: name });
    if (resp && resp.profile) {
      _mfgProfiles.unshift({
        id:             resp.profile.id,
        manufacturer:   resp.profile.manufacturer,
        metricCount:    resp.profile.metrics.length,
        overrideCount:  0,
        widgetCount:    0,
        scopedMibCount: 0,
        createdAt:      resp.profile.createdAt,
        updatedAt:      resp.profile.updatedAt,
      });
      _mfgProfileDetail[resp.profile.id] = resp.profile;
      _mfgProfileExpanded[resp.profile.id] = true;
    }
    if (input && typeof nameArg !== "string") input.value = "";
    // The name just used now has a profile, so it must drop out of the lists.
    _mfgSuggestions = null;
    _mfgUnprofiled = null;
    showToast("Manufacturer profile added");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Create failed", "error");
  }
}

async function deleteManufacturerProfile(id) {
  var profile = _mfgProfiles.find(function (p) { return p.id === id; });
  if (!profile) return;
  var ok = await showConfirm('Delete the "' + profile.manufacturer + '" profile?', "Delete");
  if (!ok) return;
  try {
    await api.serverSettings.deleteManufacturerProfile(id);
    _mfgProfiles = _mfgProfiles.filter(function (p) { return p.id !== id; });
    delete _mfgProfileDetail[id];
    delete _mfgProfileExpanded[id];
    // Freed up — the manufacturer is suggestable again.
    _mfgSuggestions = null;
    _mfgUnprofiled = null;
    showToast("Profile deleted");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Delete failed", "error");
  }
}

async function toggleProfileExpand(id) {
  if (!id) return;
  if (_mfgProfileExpanded[id]) {
    _mfgProfileExpanded[id] = false;
    renderIdentificationTab();
    return;
  }
  _mfgProfileExpanded[id] = true;
  if (!_mfgProfileDetail[id]) {
    renderIdentificationTab();
    try {
      var resp = await api.serverSettings.getManufacturerProfile(id);
      _mfgProfileDetail[id] = resp.profile;
      renderIdentificationTab();
    } catch (err) {
      showToast(err.message || "Load failed", "error");
    }
  } else {
    renderIdentificationTab();
  }
}

function beginMetricEdit(tr) {
  if (!tr) return;
  _mfgProfileMetricEdit[tr.getAttribute("data-profile-id") + ":" + tr.getAttribute("data-metric-key")] = true;
  renderIdentificationTab();
}

function cancelMetricEdit(tr) {
  if (!tr) return;
  var pid = tr.getAttribute("data-profile-id");
  var mk  = tr.getAttribute("data-metric-key");
  delete _mfgProfileMetricEdit[pid + ":" + mk];
  delete _mfgEditMibSelections["metric:" + pid + ":" + mk];
  delete _mfgEditTypeSelections["metric:" + pid + ":" + mk];
  renderIdentificationTab();
}

async function saveMetricEdit(tr) {
  if (!tr) return;
  var profileId = tr.getAttribute("data-profile-id");
  var metricKey = tr.getAttribute("data-metric-key");
  var transform = (tr.querySelector(".mfg-edit-transform") || {}).value || "";
  var mibSel    = (tr.querySelector(".mfg-edit-mib")       || {}).value || "";
  var type      = (tr.querySelector(".mfg-edit-type")      || {}).value || "scalar";
  // Single dropdown value carries either a UUID, a std:* key, or "" — split
  // into the per-column shape the backend persists.
  var mibSplit = splitMibSelection(mibSel);
  var pair     = _readSymbolPair(tr, "mfg-edit-sym", type);
  if (type === "double_scalar" && (!pair.symbol || !pair.symbolB)) {
    showToast("Both Symbol A and Symbol B are required for double scalar", "error");
    return;
  }
  var extras = _mfgReadExtras(tr, "mfg-edit", metricKey);
  var payload = {
    defaultSymbol:    pair.symbol || null,
    defaultSymbolB:   type === "double_scalar" ? (pair.symbolB || null) : null,
    defaultMibId:     mibSplit.mibId,
    defaultMibStdKey: mibSplit.mibStdKey,
    defaultType:      type,
    defaultTransform: transform || null,
    defaultAggregate:     extras.aggregate,
    defaultLabel:         extras.label,
    defaultParsePattern:  extras.parsePattern,
    defaultParseTemplate: extras.parseTemplate,
    defaultSensorColumns: extras.sensorColumns,
  };
  try {
    var resp = await api.serverSettings.updateProfileMetric(profileId, metricKey, payload);
    if (resp && resp.metric) updateMetricInDetail(profileId, resp.metric);
    delete _mfgProfileMetricEdit[profileId + ":" + metricKey];
    delete _mfgEditMibSelections["metric:" + profileId + ":" + metricKey];
    delete _mfgEditTypeSelections["metric:" + profileId + ":" + metricKey];
    showToast("Saved");
    _mfgToastWarnings(resp);
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Save failed", "error");
  }
}

// Opens (or closes) a metric's add-override form. Closing drops the form's
// pending MIB / type picks so a reopen starts blank.
function toggleOverrideAdd(tr, open) {
  if (!tr) return;
  var key = tr.getAttribute("data-profile-id") + ":" + tr.getAttribute("data-metric-key");
  if (open) {
    _mfgOverrideAddOpen[key] = true;
  } else {
    delete _mfgOverrideAddOpen[key];
    delete _mfgEditMibSelections["new:" + key];
    delete _mfgEditTypeSelections["new:" + key];
  }
  renderIdentificationTab();
}

async function addOverride(tr) {
  if (!tr) return;
  var profileId = tr.getAttribute("data-profile-id");
  var metricKey = tr.getAttribute("data-metric-key");
  var pattern   = (tr.querySelector(".mfg-new-override-pattern")   || {}).value || "";
  var devType   = (tr.querySelector(".mfg-new-override-assettype") || {}).value || "";
  var transform = (tr.querySelector(".mfg-new-override-transform") || {}).value || "";
  var mibSel    = (tr.querySelector(".mfg-new-override-mib")       || {}).value || "";
  var type      = (tr.querySelector(".mfg-new-override-type")      || {}).value || "scalar";
  var mibSplit  = splitMibSelection(mibSel);
  // Scope rule, mirrored from the server: a row needs a device type, a model
  // pattern, or both. Neither would match anything.
  if (!pattern.trim() && !devType) {
    showToast("Pick a device type, a model regex, or both", "error");
    return;
  }
  var pair = _readSymbolPair(tr, "mfg-new-override-sym", type);
  if (!pair.symbol) { showToast("Symbol A is required", "error"); return; }
  if (type === "double_scalar" && !pair.symbolB) {
    showToast("Symbol B is required for double scalar", "error");
    return;
  }
  var extras = _mfgReadExtras(tr, "mfg-new-override", metricKey);
  var payload = {
    assetType:    devType || null,
    modelPattern: pattern.trim() || null,
    symbol:       pair.symbol,
    symbolB:      type === "double_scalar" ? pair.symbolB : null,
    mibId:        mibSplit.mibId,
    mibStdKey:    mibSplit.mibStdKey,
    type:         type,
    transform:    transform || null,
    aggregate:     extras.aggregate,
    label:         extras.label,
    parsePattern:  extras.parsePattern,
    parseTemplate: extras.parseTemplate,
    sensorColumns: extras.sensorColumns,
  };
  try {
    var resp = await api.serverSettings.createProfileMetricOverride(profileId, metricKey, payload);
    if (resp && resp.override) appendOverrideToDetail(profileId, metricKey, resp.override);
    delete _mfgEditMibSelections["new:" + profileId + ":" + metricKey];
    delete _mfgEditTypeSelections["new:" + profileId + ":" + metricKey];
    delete _mfgOverrideAddOpen[profileId + ":" + metricKey];
    showToast("Override added");
    _mfgToastWarnings(resp);
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Add override failed", "error");
  }
}

function beginOverrideEdit(tr) {
  if (!tr) return;
  _mfgProfileOverrideEdit[tr.getAttribute("data-override-id")] = true;
  renderIdentificationTab();
}

function cancelOverrideEdit(tr) {
  if (!tr) return;
  var oid = tr.getAttribute("data-override-id");
  delete _mfgProfileOverrideEdit[oid];
  delete _mfgEditMibSelections["override:" + oid];
  delete _mfgEditTypeSelections["override:" + oid];
  renderIdentificationTab();
}

async function saveOverrideEdit(tr) {
  if (!tr) return;
  var profileId  = tr.getAttribute("data-profile-id");
  var metricKey  = tr.getAttribute("data-metric-key");
  var overrideId = tr.getAttribute("data-override-id");
  var pattern    = (tr.querySelector(".mfg-edit-override-pattern")   || {}).value || "";
  var devType    = (tr.querySelector(".mfg-edit-override-assettype") || {}).value || "";
  var mibSel     = (tr.querySelector(".mfg-edit-override-mib")       || {}).value || "";
  var transform  = (tr.querySelector(".mfg-edit-override-transform") || {}).value || "";
  var type       = (tr.querySelector(".mfg-edit-override-type")      || {}).value || "scalar";
  var mibSplit   = splitMibSelection(mibSel);
  if (!pattern.trim() && !devType) {
    showToast("Pick a device type, a model regex, or both", "error");
    return;
  }
  var pair = _readSymbolPair(tr, "mfg-edit-override-sym", type);
  if (!pair.symbol) { showToast("Symbol A is required", "error"); return; }
  if (type === "double_scalar" && !pair.symbolB) {
    showToast("Symbol B is required for double scalar", "error");
    return;
  }
  var extras = _mfgReadExtras(tr, "mfg-edit-override", metricKey);
  var payload = {
    assetType:    devType || null,
    modelPattern: pattern.trim() || null,
    symbol:       pair.symbol,
    symbolB:      type === "double_scalar" ? pair.symbolB : null,
    mibId:        mibSplit.mibId,
    mibStdKey:    mibSplit.mibStdKey,
    type:         type,
    transform:    transform || null,
    aggregate:     extras.aggregate,
    label:         extras.label,
    parsePattern:  extras.parsePattern,
    parseTemplate: extras.parseTemplate,
    sensorColumns: extras.sensorColumns,
  };
  try {
    var resp = await api.serverSettings.updateProfileMetricOverride(profileId, metricKey, overrideId, payload);
    if (resp && resp.override) replaceOverrideInDetail(profileId, metricKey, resp.override);
    delete _mfgProfileOverrideEdit[overrideId];
    delete _mfgEditMibSelections["override:" + overrideId];
    delete _mfgEditTypeSelections["override:" + overrideId];
    showToast("Saved");
    _mfgToastWarnings(resp);
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Save failed", "error");
  }
}

function replaceOverrideInDetail(profileId, metricKey, override) {
  var d = _mfgProfileDetail[profileId];
  if (!d) return;
  var m = d.metrics.find(function (mm) { return mm.metricKey === metricKey; });
  if (!m || !m.overrides) return;
  for (var i = 0; i < m.overrides.length; i++) {
    if (m.overrides[i].id === override.id) { m.overrides[i] = override; return; }
  }
}

async function deleteOverride(tr) {
  if (!tr) return;
  var profileId  = tr.getAttribute("data-profile-id");
  var metricKey  = tr.getAttribute("data-metric-key");
  var overrideId = tr.getAttribute("data-override-id");
  var ok = await showConfirm("Delete this override?", "Delete");
  if (!ok) return;
  try {
    await api.serverSettings.deleteProfileMetricOverride(profileId, metricKey, overrideId);
    removeOverrideFromDetail(profileId, metricKey, overrideId);
    showToast("Override deleted");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Delete failed", "error");
  }
}

function updateMetricInDetail(profileId, metric) {
  var d = _mfgProfileDetail[profileId];
  if (!d) return;
  for (var i = 0; i < d.metrics.length; i++) {
    if (d.metrics[i].metricKey === metric.metricKey) {
      d.metrics[i] = metric;
      return;
    }
  }
}

function appendOverrideToDetail(profileId, metricKey, override) {
  var d = _mfgProfileDetail[profileId];
  if (!d) return;
  var m = d.metrics.find(function (mm) { return mm.metricKey === metricKey; });
  if (!m) return;
  m.overrides = (m.overrides || []).concat([override]);
  // Bump summary count so the row's "N overrides" line stays in sync until
  // the next full reload.
  var summary = _mfgProfiles.find(function (p) { return p.id === profileId; });
  if (summary) summary.overrideCount += 1;
}

function removeOverrideFromDetail(profileId, metricKey, overrideId) {
  var d = _mfgProfileDetail[profileId];
  if (!d) return;
  var m = d.metrics.find(function (mm) { return mm.metricKey === metricKey; });
  if (!m) return;
  m.overrides = (m.overrides || []).filter(function (o) { return o.id !== overrideId; });
  var summary = _mfgProfiles.find(function (p) { return p.id === profileId; });
  if (summary && summary.overrideCount > 0) summary.overrideCount -= 1;
}

// ─── Widget mutations ─────────────────────────────────────────────────

// Read the shared widget form (Add or Edit card) into a payload the
// backend route accepts. Returns null + toasts on validation failure.
function _readWidgetFormPayload(scope) {
  if (!scope) return null;
  var name           = (scope.querySelector(".mfg-widget-name")        || {}).value || "";
  var mibSel         = (scope.querySelector(".mfg-widget-mib")         || {}).value || "";
  var typeSel        = (scope.querySelector(".mfg-widget-type")        || {}).value || "scalar";
  var widgetType     = (scope.querySelector(".mfg-widget-widgettype")  || {}).value || "gauge";
  var symbol         = (scope.querySelector(".mfg-widget-symbol")      || {}).value || "";
  var modelPattern   = (scope.querySelector(".mfg-widget-model")       || {}).value || "";
  var orderRaw       = (scope.querySelector(".mfg-widget-order")       || {}).value || "0";
  var transform      = (scope.querySelector(".mfg-widget-transform")   || {}).value || "";

  if (!name.trim())   { showToast("Widget name is required", "error");                 return null; }

  // An http widget names a request, not an OID, so the MIB/symbol pair is
  // required for every OTHER type. Mirrors the same split in
  // manufacturerProfileService.createWidget.
  var isHttp = widgetType === "http";
  var mibSplit = splitMibSelection(mibSel);
  if (!isHttp) {
    // Backend requires a real MibFile UUID — std:* keys aren't acceptable
    // because the asset-side collector needs an enumerable symbol directory
    // to walk against on the device.
    if (!mibSplit.mibId) { showToast("Pick an uploaded MIB (Standard MIBs aren't supported for widgets)", "error"); return null; }
    if (!symbol.trim()) { showToast("Symbol is required", "error");                     return null; }
  }

  var displayOptions = _readWidgetDisplayOptions(scope, widgetType);
  // Critical must lie beyond warning on the problem side (rule 180), or the
  // card would read critical before warning.
  if (displayOptions.warningAt != null && displayOptions.criticalAt != null &&
      (displayOptions.warningWhen === "below" ? displayOptions.criticalAt > displayOptions.warningAt : displayOptions.criticalAt < displayOptions.warningAt)) {
    showToast(displayOptions.warningWhen === "below" ? "Critical at must be at or below Warning at" : "Critical at must be at or above Warning at", "error");
    return null;
  }
  var payload = {
    name:           name.trim(),
    symbol:         isHttp ? null : symbol.trim(),
    mibId:          isHttp ? null : mibSplit.mibId,
    type:           typeSel,
    widgetType:     widgetType,
    transform:      transform || null,
    displayOptions: displayOptions,
    order:          Number(orderRaw) || 0,
    modelPattern:   modelPattern.trim() ? modelPattern.trim() : null,
  };
  if (isHttp) {
    payload.httpCheck    = _readWidgetHttpCheck(scope);
    payload.credentialId = (scope.querySelector(".mfg-http-cred") || {}).value || null;
  }
  if (widgetType === "state") {
    var mode      = (scope.querySelector(".mfg-widget-statemode")    || {}).value || "nonzero";
    var valuesRaw = (scope.querySelector(".mfg-widget-statevalues")  || {}).value || "";
    var trueLabel = (scope.querySelector(".mfg-widget-statetrue")    || {}).value || "";
    var falseLabel= (scope.querySelector(".mfg-widget-statefalse")   || {}).value || "";
    var labelSym  = (scope.querySelector(".mfg-widget-labelsymbol")  || {}).value || "";
    var problemEl = scope.querySelector(".mfg-widget-stateproblem");
    var values = valuesRaw.split(",").map(function (v) { return v.trim(); }).filter(function (v) { return v !== ""; });
    // Caught here as well as server-side: a probe whose comparison set is empty
    // would evaluate every reading to false and look healthy forever.
    if (STATE_MODES_WITH_VALUES.indexOf(mode) !== -1 && values.length === 0) {
      showToast("That state mode needs at least one comparison value", "error");
      return null;
    }
    payload.stateMap = {
      mode: mode,
      values: values,
      trueLabel: trueLabel.trim() || "Alarm",
      falseLabel: falseLabel.trim() || "OK",
      trueIsProblem: problemEl ? !!problemEl.checked : true,
    };
    payload.labelSymbol = typeSel === "table" && labelSym.trim() ? labelSym.trim() : null;
  }
  return payload;
}

async function saveNewWidget(scope) {
  if (!scope) return;
  var profileId = scope.getAttribute("data-profile-id");
  var payload = _readWidgetFormPayload(scope);
  if (!payload) return;
  try {
    var resp = await api.serverSettings.createProfileWidget(profileId, payload);
    if (resp && resp.widget) appendWidgetToDetail(profileId, resp.widget);
    delete _mfgAddingWidget[profileId];
    _mfgWidgetClearShadow("new-widget:" + profileId);
    showToast("Widget added");
    _mfgToastWarnings(resp);
    renderIdentificationTab();
    // Business rule 130: a new widget polls nothing until it is switched on
    // for an asset, so offer the devices it applies to straight away.
    if (resp && resp.widget && permAtLeast("assets", "write")) {
      openWidgetDevicesModal(profileId, resp.widget, true);
    }
  } catch (err) {
    showToast(err.message || "Add widget failed", "error");
  }
}

// ─── "Enable on these devices" (business rule 130) ─────────────────────────
// Lists the assets a widget applies to (its profile's manufacturer + optional
// model pattern) with a checkbox each. Opened right after a widget is created
// (nothing is checked — a new widget polls nothing until chosen here or on an
// asset's Custom MIB tab) and from the widget card's Devices… button (current
// state pre-checked). Saves only the difference.
async function openWidgetDevicesModal(profileId, widget, isNew) {
  var title = (isNew ? "Enable " : "Devices for ") + '"' + widget.name + '"';
  openModal(title, '<p class="empty-state" style="margin:0">Loading devices…</p>',
    '<button class="btn btn-secondary" id="wdev-cancel">' + (isNew ? "Skip for now" : "Cancel") + '</button>');
  document.getElementById("wdev-cancel").addEventListener("click", closeModal);
  var rows;
  try {
    rows = ((await api.serverSettings.listProfileWidgetAssets(profileId, widget.id)) || {}).assets || [];
  } catch (err) {
    var b = document.querySelector("#modal-overlay .modal-body");
    if (b) b.innerHTML = '<p style="color:var(--color-danger);margin:0">' + escapeHtml(err.message || "Could not load devices") + '</p>';
    return;
  }
  var initial = {};
  rows.forEach(function (r) { initial[r.id] = !!r.enabled; });
  var body = document.querySelector("#modal-overlay .modal-body");
  var footer = document.querySelector("#modal-overlay .modal-footer");
  if (!body || !footer) return;

  if (!rows.length) {
    body.innerHTML = '<p style="margin:0">No assets match this widget yet' +
      (widget.modelPattern ? ' (manufacturer + model pattern <code>' + escapeHtml(widget.modelPattern) + '</code>)' : '') +
      '. It can be switched on later from an asset\'s Custom MIB tab or this card\'s Devices… button.</p>';
    return;
  }

  body.innerHTML =
    '<p style="margin:0 0 0.6rem;font-size:0.85rem;color:var(--color-text-secondary)">' +
      (isNew
        ? 'This widget polls nothing until it is switched on for a device. Choose the devices to start polling it on now.'
        : 'Checked devices poll this widget on their hardware-sensor interval. Unchecking one stops polling it; its collected history stays.') +
    '</p>' +
    '<div style="display:flex;gap:8px;align-items:center;margin-bottom:0.5rem">' +
      '<input type="search" id="wdev-filter" placeholder="Filter by name, IP or model" style="flex:1">' +
      '<span id="wdev-count" style="font-size:0.8rem;color:var(--color-text-tertiary);white-space:nowrap"></span>' +
    '</div>' +
    '<div style="max-height:50vh;overflow:auto;border:1px solid var(--color-border);border-radius:4px">' +
      '<table class="data-table" style="font-size:0.84rem;margin:0"><thead><tr>' +
        '<th style="width:32px"><input type="checkbox" id="wdev-all" title="Select every listed device"></th>' +
        '<th>Device</th><th>IP address</th><th>Model</th><th>Status</th>' +
      '</tr></thead><tbody id="wdev-rows">' +
      rows.map(function (r) {
        var hay = [r.hostname, r.ipAddress, r.model].filter(Boolean).join(" ").toLowerCase();
        return '<tr data-hay="' + escapeHtml(hay) + '">' +
          '<td><input type="checkbox" class="wdev-pick" data-id="' + escapeHtml(r.id) + '"' + (r.enabled ? " checked" : "") + '></td>' +
          '<td>' + escapeHtml(r.hostname || "—") + (r.monitored ? '' : ' <span style="font-size:0.75rem;color:var(--color-text-tertiary)">(not monitored)</span>') + '</td>' +
          '<td class="mono">' + escapeHtml(r.ipAddress || "—") + '</td>' +
          '<td>' + escapeHtml(r.model || "—") + '</td>' +
          '<td>' + escapeHtml(r.monitorStatus || "—") + '</td>' +
        '</tr>';
      }).join("") +
      '</tbody></table>' +
    '</div>';
  footer.innerHTML =
    '<button class="btn btn-secondary" id="wdev-cancel">' + (isNew ? "Skip for now" : "Cancel") + '</button>' +
    '<button class="btn btn-primary" id="wdev-save"></button>';

  var picks = Array.prototype.slice.call(body.querySelectorAll(".wdev-pick"));
  var allBox = document.getElementById("wdev-all");
  var saveBtn = document.getElementById("wdev-save");
  function visible(p) { return p.closest("tr").style.display !== "none"; }
  function refresh() {
    var checked = picks.filter(function (p) { return p.checked; }).length;
    var changed = picks.filter(function (p) { return p.checked !== initial[p.getAttribute("data-id")]; }).length;
    document.getElementById("wdev-count").textContent = checked + " of " + picks.length + " selected";
    saveBtn.textContent = isNew ? (checked ? "Enable on " + checked + " device" + (checked === 1 ? "" : "s") : "Enable") : "Save";
    saveBtn.disabled = changed === 0;
    var vis = picks.filter(visible);
    allBox.checked = vis.length > 0 && vis.every(function (p) { return p.checked; });
  }
  picks.forEach(function (p) { p.addEventListener("change", refresh); });
  allBox.addEventListener("change", function () {
    picks.filter(visible).forEach(function (p) { p.checked = allBox.checked; });
    refresh();
  });
  document.getElementById("wdev-filter").addEventListener("input", function () {
    var q = this.value.trim().toLowerCase();
    picks.forEach(function (p) {
      var tr = p.closest("tr");
      tr.style.display = !q || tr.getAttribute("data-hay").indexOf(q) !== -1 ? "" : "none";
    });
    refresh();
  });
  document.getElementById("wdev-cancel").addEventListener("click", closeModal);
  saveBtn.addEventListener("click", async function () {
    var enable = [], disable = [];
    picks.forEach(function (p) {
      var id = p.getAttribute("data-id");
      if (p.checked && !initial[id]) enable.push(id);
      if (!p.checked && initial[id]) disable.push(id);
    });
    saveBtn.disabled = true;
    try {
      var res = await api.serverSettings.setProfileWidgetAssets(profileId, widget.id, { enable: enable, disable: disable });
      closeModal();
      var parts = [];
      if (res && res.enabled)  parts.push("on for " + res.enabled);
      if (res && res.disabled) parts.push("off for " + res.disabled);
      showToast('"' + widget.name + '" polling ' + (parts.join(", ") || "unchanged") + " device(s)", "success");
    } catch (err) {
      showToast(err.message || "Could not update devices", "error");
      saveBtn.disabled = false;
    }
  });
  refresh();
}

async function saveWidgetEdit(scope) {
  if (!scope) return;
  var profileId = scope.getAttribute("data-profile-id");
  var widgetId  = scope.getAttribute("data-widget-id");
  var payload   = _readWidgetFormPayload(scope);
  if (!payload) return;
  try {
    var resp = await api.serverSettings.updateProfileWidget(profileId, widgetId, payload);
    if (resp && resp.widget) replaceWidgetInDetail(profileId, resp.widget);
    delete _mfgWidgetEdit[widgetId];
    _mfgWidgetClearShadow("widget:" + widgetId);
    showToast("Saved");
    _mfgToastWarnings(resp);
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Save failed", "error");
  }
}

async function deleteWidget(profileId, widgetId) {
  if (!profileId || !widgetId) return;
  var d = _mfgProfileDetail[profileId];
  var w = d && (d.widgets || []).find(function (x) { return x.id === widgetId; });
  var name = w ? w.name : "this widget";
  var ok = await showConfirm('Delete the "' + name + '" widget?', "Delete");
  if (!ok) return;
  try {
    await api.serverSettings.deleteProfileWidget(profileId, widgetId);
    removeWidgetFromDetail(profileId, widgetId);
    delete _mfgWidgetEdit[widgetId];
    _mfgWidgetClearShadow("widget:" + widgetId);
    showToast("Widget deleted");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Delete failed", "error");
  }
}

function appendWidgetToDetail(profileId, widget) {
  var d = _mfgProfileDetail[profileId];
  if (!d) return;
  d.widgets = (d.widgets || []).concat([widget]);
  var summary = _mfgProfiles.find(function (p) { return p.id === profileId; });
  if (summary) summary.widgetCount = (summary.widgetCount || 0) + 1;
}

function replaceWidgetInDetail(profileId, widget) {
  var d = _mfgProfileDetail[profileId];
  if (!d || !d.widgets) return;
  for (var i = 0; i < d.widgets.length; i++) {
    if (d.widgets[i].id === widget.id) { d.widgets[i] = widget; return; }
  }
}

function removeWidgetFromDetail(profileId, widgetId) {
  var d = _mfgProfileDetail[profileId];
  if (!d || !d.widgets) return;
  d.widgets = d.widgets.filter(function (w) { return w.id !== widgetId; });
  var summary = _mfgProfiles.find(function (p) { return p.id === profileId; });
  if (summary && summary.widgetCount > 0) summary.widgetCount -= 1;
}
