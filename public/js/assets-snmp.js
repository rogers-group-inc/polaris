/**
 * public/js/assets-snmp.js — SNMP-facing tabs: the Custom MIB tab (widgets, layout, drag), the SNMP
 * Walk tab and Device Query → API Query.
 *
 * Part of the Assets page script (CQ-F050): plain browser scripts sharing
 * page globals, loaded right after assets.js on every page that carries it
 * and in app-panels.js's asset bundle, in ASSETS_FILES order. Nothing here
 * runs at load beyond listener wiring. See tests/unit/assetsSplit.test.ts.
 */

// ─── Custom MIB tab (Slice 7) ────────────────────────────────────────────
// One tab per asset whose manufacturer has at least one
// ManufacturerCustomWidget defined under its ManufacturerProfile. Widgets
// are rendered per `widgetType`:
//   * gauge — compact radial-arc with min/max + threshold ranges
//   * line  — small SVG line chart over the last 60 sample window
//   * table — flat table of the latest row array
// The Polaris collector probes each widget on the customWidget cadence
// (default 60s); the renderer doesn't poll — it shows the freshest sample
// the server has; it refreshes on the next collector cycle.

// Tab state: the payload last rendered, and the layout editor's working copy.
// The layout belongs to the MANUFACTURER PROFILE (every asset under it shares
// it); the pencil at the tab's top right edits it with the dashboard's column
// model — drag a card by its grip into any column, cycle a column's width
// (3/4/6/12 of 12) and a card's height (1×/2×/3×) — and the second click saves.
var _cmib = { payload: null, editing: false, working: null };
var CMIB_WIDTHS = [3, 4, 6, 12];
var CMIB_ROW_PX = 170;   // one height step; 2× / 3× add the gap between steps
var CMIB_GAP_PX = 12;
var CMIB_PENCIL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>';
var CMIB_CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

function _cmibIsMfr(w) { return w.enabled !== null && w.enabled !== undefined; }

/**
 * A complete layout for these widgets: the saved one with unknown ids dropped,
 * then every manufacturer widget it does not mention appended as its own
 * 3-wide column (so a widget created after the layout was saved still shows).
 * With nothing saved, every widget gets its own 3-wide column — four across,
 * close to the default grid.
 */
function _cmibCompleteLayout(saved, widgets) {
  var ids = widgets.filter(_cmibIsMfr).map(function (w) { return w.id; });
  var seen = {};
  var columns = [];
  ((saved && saved.columns) || []).forEach(function (c) {
    var ws = (c.widgets || []).filter(function (x) {
      if (ids.indexOf(x.id) === -1 || seen[x.id]) return false;
      seen[x.id] = 1;
      return true;
    }).map(function (x) { return { id: x.id, height: [1, 2, 3].indexOf(x.height) !== -1 ? x.height : 1 }; });
    if (ws.length) columns.push({ id: c.id, width: CMIB_WIDTHS.indexOf(c.width) !== -1 ? c.width : 3, widgets: ws });
  });
  ids.forEach(function (id) {
    if (!seen[id]) columns.push({ id: "col-" + id, width: 3, widgets: [{ id: id, height: 1 }] });
  });
  return { version: 1, columns: columns };
}

// How a single-value widget is drawn — switchable from the layout editor, and
// saved to the widget on the manufacturer profile with the layout. Only a
// SCALAR symbol's gauge / line / value (or a table widget mistakenly pointed
// at a scalar, offered so it can be fixed): a state probe, an HTTP check or a
// real table walk is a different kind of widget, changed on the profile.
var CMIB_DISPLAY_TYPES = [["gauge", "Gauge"], ["line", "Line"], ["value", "Value"]];
function _cmibCanSwitchType(w) {
  return w.type === "scalar" && ["gauge", "line", "value", "table"].indexOf(w.widgetType) !== -1;
}
function _cmibTypePickerHTML(w) {
  if (!_cmibCanSwitchType(w)) return "";
  var opts = CMIB_DISPLAY_TYPES.slice();
  if (w.widgetType === "table") opts.push(["table", "Table"]);
  return '<select class="cmib-type" data-widget-id="' + escapeHtml(w.id) + '" title="Show this widget as" style="font-size:0.72rem;padding:1px 4px;width:auto">' +
    opts.map(function (o) {
      return '<option value="' + o[0] + '"' + (o[0] === w.widgetType ? " selected" : "") + '>' + o[1] + '</option>';
    }).join("") +
  '</select>';
}
/** The widget as the editor shows it: its pending display type, if changed. */
function _cmibShown(w) {
  var t = _cmib.typeChanges && _cmib.typeChanges[w.id];
  return t ? Object.assign({}, w, { widgetType: t }) : w;
}

function _cmibCardHTML(w, opts) {
  opts = opts || {};
  var hasSwitch = _cmibIsMfr(w);
  var off = hasSwitch && !w.enabled;
  var toggle = !hasSwitch ? "" :
    '<label class="toggle-switch" style="flex-shrink:0" title="' +
      (w.enabled ? "Polling on — click to stop polling this widget on this asset" : "Polling off — click to start polling this widget on this asset") + '">' +
      '<input type="checkbox" class="custom-widget-toggle" data-widget-id="' + escapeHtml(w.id) + '"' +
        (w.enabled ? " checked" : "") + (canManageAssets() && !opts.editing ? "" : " disabled") + '>' +
      '<span class="toggle-slider"></span>' +
    '</label>';
  var height = opts.height
    ? ';height:' + (opts.height * CMIB_ROW_PX + (opts.height - 1) * CMIB_GAP_PX) + 'px;overflow:auto;box-sizing:border-box'
    : '';
  // `data-shot-expand`: the screenshot / PDF capture lets this card grow to its
  // full content for the length of the capture (_expandShotRegions), so a
  // table taller than the card's layout height is captured whole, not clipped.
  return '<div class="custom-mib-card" data-widget-id="' + escapeHtml(w.id) + '" data-shot-section="mib:' + escapeHtml(w.symbol) + '" data-shot-label="' + escapeHtml(w.name) + '"' + (height ? ' data-shot-expand' : '') + ' style="border:1px solid var(--color-border);border-radius:6px;padding:10px;background:var(--color-bg-secondary,rgba(0,0,0,0.03))' + height + '">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px">' +
      '<span style="display:flex;align-items:center;gap:4px;min-width:0">' +
        (opts.editing ? '<span class="cmib-grip" draggable="true" data-widget-id="' + escapeHtml(w.id) + '" title="Drag to move (to any column)">⠿</span>' : '') +
        '<span style="font-weight:600">' + escapeHtml(w.name) + '</span>' +
      '</span>' +
      '<span style="display:flex;align-items:center;gap:8px;min-width:0">' +
        '<span style="font-size:0.72rem;color:var(--color-text-tertiary);font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis">' + escapeHtml(w.symbol) + '</span>' +
        (opts.editing ? _cmibTypePickerHTML(w) + '<button type="button" class="cmib-tool cmib-height" data-widget-id="' + escapeHtml(w.id) + '" title="Height (click to cycle 1×/2×/3×)">' + opts.height + '×</button>' : toggle) +
      '</span>' +
    '</div>' +
    // Switched off for this asset: the notice alone. The last reading used to
    // be drawn dimmed beneath it, which on a widget switched off because it
    // reads nothing useful here (a PDU with no temperature probe) kept
    // showing the bad value.
    (off
      ? '<p class="empty-state" style="padding:0.5rem 0;margin:0">Polling is off for this asset.</p>'
      : _renderCustomWidgetBody(w)) +
  '</div>';
}

function _cmibLayoutHTML(layout, byId, editing) {
  var html = '<div class="cmib-layout' + (editing ? ' editing' : '') + '">';
  layout.columns.forEach(function (c, ci) {
    html += '<div class="cmib-col" data-col-id="' + escapeHtml(c.id) + '" style="grid-column:span ' + c.width + '">';
    if (editing) {
      html += '<div class="cmib-col-bar">' +
        '<button type="button" class="cmib-tool cmib-col-move" data-col-id="' + escapeHtml(c.id) + '" data-dir="-1" title="Move column left"' + (ci === 0 ? ' disabled' : '') + '>‹</button>' +
        '<button type="button" class="cmib-tool cmib-col-move" data-col-id="' + escapeHtml(c.id) + '" data-dir="1" title="Move column right"' + (ci === layout.columns.length - 1 ? ' disabled' : '') + '>›</button>' +
        '<span class="cmib-col-bar-fill"></span>' +
        '<button type="button" class="cmib-tool cmib-width" data-col-id="' + escapeHtml(c.id) + '" title="Column width (click to cycle 3/4/6/12 of 12)">' + c.width + '/12</button>' +
      '</div>';
    }
    c.widgets.forEach(function (x) {
      var w = byId[x.id];
      if (w) html += _cmibCardHTML(editing ? _cmibShown(w) : w, { editing: editing, height: x.height });
    });
    html += '</div>';
  });
  if (editing) html += '<div class="cmib-newcol" data-newcol="1">Drop here for a new column</div>';
  return html + '</div>';
}

function _customMibTabHTML(payload) {
  // A different asset (or a fresh open) never inherits an edit in progress.
  if (!_cmib.payload || _cmib.payload.assetId !== payload.assetId) {
    _cmib.editing = false;
    _cmib.working = null;
  }
  _cmib.payload = payload;
  var feeds = [];
  var anyMfr = false;
  payload.widgets.forEach(function (w) {
    if (w.source && w.source.kind === "genericapi") {
      if (feeds.indexOf(w.source.integrationName) === -1) feeds.push(w.source.integrationName);
    } else {
      anyMfr = true;
    }
  });
  var parts = [];
  if (anyMfr) {
    parts.push('Widgets from <b>' + escapeHtml(payload.manufacturer || "this manufacturer") + '</b> ' +
      '— defined at Server Settings → Identification → Manufacturer Profiles.');
  }
  if (feeds.length) {
    parts.push('Widgets from the Generic API integration' + (feeds.length > 1 ? 's ' : ' ') +
      feeds.map(function (n) { return '<b>' + escapeHtml(n) + '</b>'; }).join(", ") +
      ' — defined on its Monitoring tab.');
  }
  var hint = parts.join(" ");
  // Business rule 130: a manufacturer widget polls this asset only once its
  // card's switch is on. `enabled` is null on a Generic API widget (no switch).
  var mfrWidgets = payload.widgets.filter(_cmibIsMfr);
  var genericWidgets = payload.widgets.filter(function (w) { return !_cmibIsMfr(w); });
  var anyOn = mfrWidgets.some(function (w) { return w.enabled; });
  if (_cmib.editing) {
    hint = '<b>Editing the layout for every ' + escapeHtml(payload.manufacturer || "") + ' asset.</b> ' +
      'Drag a card by ⠿ into any column, set each column\'s width and each card\'s height, and switch a single-value widget between Gauge, Line and Value, then click ✓ to save. Display changes are saved to the widget on the profile.';
  } else if (mfrWidgets.length && !anyOn) {
    hint += ' <span style="color:var(--color-warning)">Polling is off for every widget — ' +
      (canManageAssets() ? 'switch a card on to start collecting.' : 'an asset editor can switch one on.') + '</span>';
  } else if (payload.polling === "disabled") {
    hint += ' <span style="color:var(--color-warning)">Polling is disabled for this asset; data may be stale.</span>';
  } else if (!payload.lastCustomWidgetAt) {
    hint += ' <span style="color:var(--color-text-tertiary)">No sample collected yet — waiting for the next probe cycle.</span>';
  }
  // The pencil: a profile write, so only for a role that can save one.
  var canLayout = mfrWidgets.length > 0 && !!payload.profileId && permAtLeast("manufacturerProfiles", "write");
  var tools = !canLayout ? "" : (_cmib.editing
    ? '<button type="button" class="btn btn-sm btn-secondary cmib-reset" title="Return to the default grid when saved">Reset</button>' +
      '<button type="button" class="btn btn-sm btn-secondary cmib-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-primary btn-icon-only cmib-edit-btn" title="Done editing — save this layout for every ' + escapeHtml(payload.manufacturer || "") + ' asset">' + CMIB_CHECK_SVG + '</button>'
    : '<button type="button" class="btn btn-primary btn-icon-only cmib-edit-btn" title="Customize this layout (shared by every ' + escapeHtml(payload.manufacturer || "") + ' asset)">' + CMIB_PENCIL_SVG + '</button>');

  var html = '<div class="custom-mib-tab" data-asset-id="' + escapeHtml(payload.assetId || "") + '">' +
    '<div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:0.75rem">' +
      '<div style="flex:1;font-size:0.82rem;color:var(--color-text-secondary)">' + hint + '</div>' +
      (tools ? '<div style="display:flex;gap:6px;flex-shrink:0">' + tools + '</div>' : '') +
    '</div>';

  var byId = {};
  payload.widgets.forEach(function (w) { byId[w.id] = w; });
  if (_cmib.editing) {
    html += _cmibLayoutHTML(_cmib.working, byId, true);
  } else if (payload.widgetLayout && mfrWidgets.length) {
    html += _cmibLayoutHTML(_cmibCompleteLayout(payload.widgetLayout, payload.widgets), byId, false);
  } else {
    html += '<div class="custom-mib-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px">' +
      mfrWidgets.map(function (w) { return _cmibCardHTML(w); }).join("") + '</div>';
  }
  // Generic API widgets are an integration's, not the profile's: never part of
  // the profile layout, always after it.
  if (genericWidgets.length) {
    html += '<div class="custom-mib-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-top:12px">' +
      genericWidgets.map(function (w) { return _cmibCardHTML(w); }).join("") + '</div>';
  }
  return html + '</div>';
}

function _cmibRerender() {
  var panel = document.getElementById("asset-view-tab-customMib");
  if (panel && _cmib.payload) panel.innerHTML = _customMibTabHTML(_cmib.payload);
}

function _cmibFindCol(colId) {
  var cols = _cmib.working ? _cmib.working.columns : [];
  for (var i = 0; i < cols.length; i++) if (cols[i].id === colId) return i;
  return -1;
}

/** Move a widget to column `colId` (or a new trailing column when null) at
 *  `index`; empty columns left behind are dropped. */
function _cmibMoveWidget(widgetId, colId, index) {
  var cols = _cmib.working.columns;
  var entry = null;
  cols.forEach(function (c) {
    var i = c.widgets.findIndex(function (x) { return x.id === widgetId; });
    if (i !== -1) {
      if (c.id === colId && i < index) index--;
      entry = c.widgets.splice(i, 1)[0];
    }
  });
  if (!entry) return;
  if (colId === null) {
    cols.push({ id: "col-" + Date.now().toString(36), width: 3, widgets: [entry] });
  } else {
    var target = cols[_cmibFindCol(colId)];
    if (!target) return;
    target.widgets.splice(Math.max(0, Math.min(index, target.widgets.length)), 0, entry);
  }
  _cmib.working.columns = cols.filter(function (c) { return c.widgets.length > 0; });
}

// The insertion index within a column for a pointer at clientY: before the
// first card whose midpoint is below it.
function _cmibDropIndex(colEl, clientY) {
  var cards = Array.prototype.slice.call(colEl.querySelectorAll(":scope > .custom-mib-card:not(.lifted)"));
  for (var i = 0; i < cards.length; i++) {
    var r = cards[i].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return { index: i, before: cards[i] };
  }
  return { index: cards.length, before: null };
}

function _cmibClearDropCues() {
  document.querySelectorAll(".cmib-drop-marker").forEach(function (m) { m.remove(); });
  document.querySelectorAll(".cmib-newcol.drag-over").forEach(function (n) { n.classList.remove("drag-over"); });
}

var _cmibDragId = null;

document.addEventListener("click", async function (e) {
  var t = e.target && e.target.closest ? e.target : null;
  if (!t || !t.closest(".custom-mib-tab")) return;
  var editBtn = t.closest(".cmib-edit-btn");
  if (editBtn) {
    if (!_cmib.editing) {
      _cmib.working = _cmibCompleteLayout(_cmib.payload.widgetLayout, _cmib.payload.widgets);
      _cmib.reset = false;
      _cmib.typeChanges = {};
      _cmib.editing = true;
      _cmibRerender();
      return;
    }
    editBtn.disabled = true;
    try {
      // Display-type changes are written to the WIDGETS on the profile first
      // (each a partial update carrying only widgetType), then the layout.
      var changed = Object.keys(_cmib.typeChanges || {});
      for (var k = 0; k < changed.length; k++) {
        var wid = changed[k];
        await api.serverSettings.updateProfileWidget(_cmib.payload.profileId, wid, { widgetType: _cmib.typeChanges[wid] });
        _cmib.payload.widgets.forEach(function (w) { if (w.id === wid) w.widgetType = _cmib.typeChanges[wid]; });
      }
      var resp = await api.serverSettings.setProfileWidgetLayout(_cmib.payload.profileId, _cmib.reset ? null : _cmib.working);
      _cmib.payload.widgetLayout = resp ? resp.layout : null;
      _cmib.editing = false;
      _cmib.working = null;
      _cmib.typeChanges = {};
      showToast("Layout" + (changed.length ? " and widget display" : "") + " saved for every " + (_cmib.payload.manufacturer || "") + " asset", "success");
      _cmibRerender();
    } catch (err) {
      editBtn.disabled = false;
      showToast(err.message || "Could not save the layout", "error");
    }
    return;
  }
  if (!_cmib.editing) return;
  if (t.closest(".cmib-cancel")) {
    _cmib.editing = false;
    _cmib.working = null;
    _cmib.typeChanges = {};
    _cmibRerender();
    return;
  }
  if (t.closest(".cmib-reset")) {
    _cmib.working = _cmibCompleteLayout(null, _cmib.payload.widgets);
    _cmib.reset = true;
    _cmibRerender();
    return;
  }
  var widthBtn = t.closest(".cmib-width");
  if (widthBtn) {
    var col = _cmib.working.columns[_cmibFindCol(widthBtn.getAttribute("data-col-id"))];
    if (col) col.width = CMIB_WIDTHS[(CMIB_WIDTHS.indexOf(col.width) + 1) % CMIB_WIDTHS.length];
    _cmib.reset = false;
    _cmibRerender();
    return;
  }
  var heightBtn = t.closest(".cmib-height");
  if (heightBtn) {
    var wid = heightBtn.getAttribute("data-widget-id");
    _cmib.working.columns.forEach(function (c) {
      c.widgets.forEach(function (x) { if (x.id === wid) x.height = (x.height % 3) + 1; });
    });
    _cmib.reset = false;
    _cmibRerender();
    return;
  }
  var moveBtn = t.closest(".cmib-col-move");
  if (moveBtn) {
    var cols = _cmib.working.columns;
    var i = _cmibFindCol(moveBtn.getAttribute("data-col-id"));
    var j = i + Number(moveBtn.getAttribute("data-dir"));
    if (i !== -1 && j >= 0 && j < cols.length) {
      var tmp = cols[i]; cols[i] = cols[j]; cols[j] = tmp;
    }
    _cmib.reset = false;
    _cmibRerender();
  }
});

document.addEventListener("dragstart", function (e) {
  var grip = e.target && e.target.closest ? e.target.closest(".cmib-grip") : null;
  if (!grip || !_cmib.editing) return;
  _cmibDragId = grip.getAttribute("data-widget-id");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", _cmibDragId);
  var card = grip.closest(".custom-mib-card");
  if (card) card.classList.add("lifted");
});

document.addEventListener("dragover", function (e) {
  if (!_cmibDragId) return;
  var t = e.target && e.target.closest ? e.target : null;
  var col = t && t.closest(".cmib-layout.editing .cmib-col");
  var newCol = t && t.closest(".cmib-layout.editing .cmib-newcol");
  if (!col && !newCol) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  _cmibClearDropCues();
  if (newCol) { newCol.classList.add("drag-over"); return; }
  var spot = _cmibDropIndex(col, e.clientY);
  var marker = document.createElement("div");
  marker.className = "cmib-drop-marker";
  if (spot.before) col.insertBefore(marker, spot.before); else col.appendChild(marker);
});

document.addEventListener("drop", function (e) {
  if (!_cmibDragId) return;
  var t = e.target && e.target.closest ? e.target : null;
  var col = t && t.closest(".cmib-layout.editing .cmib-col");
  var newCol = t && t.closest(".cmib-layout.editing .cmib-newcol");
  if (!col && !newCol) return;
  e.preventDefault();
  var id = _cmibDragId;
  if (newCol) _cmibMoveWidget(id, null, 0);
  else _cmibMoveWidget(id, col.getAttribute("data-col-id"), _cmibDropIndex(col, e.clientY).index);
  _cmibDragId = null;
  _cmib.reset = false;
  _cmibRerender();
});

document.addEventListener("dragend", function () {
  if (!_cmibDragId) return;
  _cmibDragId = null;
  _cmibClearDropCues();
  document.querySelectorAll(".custom-mib-card.lifted").forEach(function (c) { c.classList.remove("lifted"); });
});

// The layout editor's display-type picker: staged until ✓, previewed at once.
document.addEventListener("change", function (e) {
  var sel = e.target;
  if (!sel || !sel.classList || !sel.classList.contains("cmib-type") || !_cmib.editing) return;
  var wid = sel.getAttribute("data-widget-id");
  var original = (_cmib.payload.widgets.find(function (w) { return w.id === wid; }) || {}).widgetType;
  _cmib.typeChanges = _cmib.typeChanges || {};
  if (sel.value === original) delete _cmib.typeChanges[wid];
  else _cmib.typeChanges[wid] = sel.value;
  _cmibRerender();
});

// The Custom MIB card switch (business rule 130). Delegated at the document so
// the panel can re-render freely; on success the panel is redrawn from a fresh
// payload, on failure the switch snaps back and the error is toasted.
document.addEventListener("change", async function (e) {
  var input = e.target;
  if (!input || !input.classList || !input.classList.contains("custom-widget-toggle")) return;
  var tab = input.closest(".custom-mib-tab");
  var assetId = tab && tab.getAttribute("data-asset-id");
  if (!assetId) return;
  var want = input.checked;
  input.disabled = true;
  try {
    await api.assets.setCustomWidgetEnabled(assetId, input.getAttribute("data-widget-id"), want);
    showToast(want ? "Widget polling on — the first reading arrives within one hardware-sensor interval" : "Widget polling off", "success");
    var payload = await api.assets.customWidgets(assetId);
    var panel = document.getElementById("asset-view-tab-customMib");
    if (panel && payload) panel.innerHTML = _customMibTabHTML(payload);
  } catch (err) {
    input.checked = !want;
    input.disabled = false;
    showToast(err.message || "Could not change widget polling", "error");
  }
});

function _renderCustomWidgetBody(w) {
  // State probes carry their readings in `stateRows`, not `latest` (their 0/1
  // samples live in their own table) — checked before the no-sample guard so a
  // probe with rows renders even though `latest` is always null for one.
  if (w.widgetType === "state") return _renderCustomWidgetState(w);
  if (!w.latest) {
    return '<p class="empty-state" style="padding:0.5rem 0;margin:0">No sample yet.</p>';
  }
  if (w.widgetType === "gauge") return _renderCustomWidgetGauge(w);
  if (w.widgetType === "value") return _renderCustomWidgetScalarFallback(w);
  if (w.widgetType === "line")  return _renderCustomWidgetLine(w);
  if (w.widgetType === "table") return _renderCustomWidgetTable(w);
  return '<p class="empty-state" style="padding:0.5rem 0;margin:0">Unknown widgetType: ' + escapeHtml(w.widgetType) + '</p>';
}

/**
 * A state probe: one pill per row, using the probe's OWN labels and colouring
 * the side the operator called the problem. The raw device value rides a
 * tooltip — when a mapping looks wrong, the raw value is the thing you need,
 * but it isn't what an operator reads day to day.
 */
function _renderCustomWidgetState(w) {
  var rows = w.stateRows || [];
  if (!rows.length) {
    return '<p class="empty-state" style="padding:0.5rem 0;margin:0">No state reported yet.</p>';
  }
  var map = w.stateMap || {};
  var trueLabel = map.trueLabel || "true";
  var falseLabel = map.falseLabel || "false";
  var trueIsProblem = map.trueIsProblem !== false;
  var probleml = rows.filter(function (r) { return (r.value === 1) === trueIsProblem; }).length;
  var head = '<div style="font-size:0.78rem;color:' + (probleml ? "var(--color-danger)" : "var(--color-text-tertiary)") + ';margin-bottom:6px">' +
    (probleml
      ? escapeHtml(String(probleml)) + ' of ' + rows.length + ' ' + escapeHtml(rows.length === 1 ? "row" : "rows") + ' in ' + escapeHtml(trueIsProblem ? trueLabel : falseLabel)
      : 'All ' + rows.length + ' ' + escapeHtml(rows.length === 1 ? "row" : "rows") + ' ' + escapeHtml(trueIsProblem ? falseLabel : trueLabel)) +
    '</div>';
  var body = rows.map(function (r) {
    var isProblem = (r.value === 1) === trueIsProblem;
    var label = r.value === 1 ? trueLabel : falseLabel;
    var color = isProblem ? "var(--color-danger)" : "var(--color-success,#3ba55d)";
    var title = r.rawValue != null && r.rawValue !== "" ? "Device reported: " + r.rawValue : "";
    return '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:3px 0;border-top:1px solid var(--color-border)"' +
        (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' +
      '<span style="font-size:0.82rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(r.rowLabel) + '</span>' +
      '<span style="font-size:0.76rem;font-weight:600;color:' + color + ';white-space:nowrap">' + escapeHtml(label) + '</span>' +
    '</div>';
  }).join("");
  return head + body;
}

// How a single-value widget's number is shown — display only; the stored
// sample, and any automation on it, keep the device's own number.
//   * A temperature unit (°C / °F on the widget) is shown in the INSTALL's unit
//     (Server Settings temperature unit, via PolarisTempUnit), converting when
//     they differ — a vendor reporting °F reads °C on a Celsius install.
//   * displayOptions.format "duration_s" / "duration_ticks" reads the number as
//     seconds / SNMP TimeTicks (hundredths of a second, e.g. APC's
//     upsAdvBatteryRunTimeRemaining) and shows "1 h 23 m".
// conv() maps a number into display units (gauge bounds go through it too);
// text() is the label for one number, unit included.
function _cwDisplay(w) {
  var o = w.displayOptions || {};
  var TU = window.PolarisTempUnit;
  if (TU && TU.isTemperatureUnit && TU.isTemperatureUnit(o.unit)) {
    var label = TU.displayUnitAny(o.unit);
    return {
      conv: function (n) { return TU.toDisplay(n, o.unit); },
      text: function (n) { return _formatNumber(n) + " " + label; },
    };
  }
  if (o.format === "duration_s" || o.format === "duration_ticks") {
    var div = o.format === "duration_ticks" ? 100 : 1;
    return {
      conv: function (n) { return n; },
      text: function (n) { return _formatDuration(n / div); },
    };
  }
  var unit = o.unit ? " " + o.unit : "";
  return {
    conv: function (n) { return n; },
    text: function (n) { return _formatNumber(n) + unit; },
  };
}

/** Seconds as the two largest units: "2 d 3 h", "1 h 23 m", "45 m 10 s", "42 s". */
function _formatDuration(sec) {
  if (!Number.isFinite(sec)) return String(sec);
  var neg = sec < 0;
  var s = Math.round(Math.abs(sec));
  var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  var out = d ? d + " d " + h + " h" : h ? h + " h " + m + " m" : m ? m + " m " + r + " s" : r + " s";
  return (neg ? "-" : "") + out;
}

/**
 * A gauge / line widget's warning threshold against one reading, or null when
 * the widget sets none. `warningWhen` says which side is the warning — "above"
 * (the default: load, temperature) or "below" (battery, toner, runtime) — and
 * the threshold itself counts as breached, so "warn at 90" warns at 90.
 * Display only: an automation on the widget's value is what alerts.
 */
function _customWidgetWarning(n, opts) {
  var at = opts && opts.warningAt;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  var below = opts.warningWhen === "below";
  return { at: at, below: below, breached: Number.isFinite(n) && (below ? n <= at : n >= at) };
}

/**
 * The widget's warning in DISPLAY units (_cwDisplay): the threshold is entered
 * in the widget's own unit, so a °C threshold on a Fahrenheit install converts
 * with the value it is compared to.
 */
function _customWidgetWarningShown(displayValue, opts, fmt) {
  var at = opts && opts.warningAt;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  return _customWidgetWarning(displayValue, Object.assign({}, opts, { warningAt: fmt.conv(at) }));
}

/** The line under a gauge / line widget naming its threshold — amber once breached.
 *  `text` formats one number with its unit (the widget's _cwDisplay text). */
function _customWidgetWarnCaption(warn, text) {
  if (!warn) return "";
  var rule = (warn.below ? "at or below " : "at or above ") + text(warn.at);
  return warn.breached
    ? '<div class="custom-widget-warn is-breached" style="font-size:0.76rem;font-weight:600;color:var(--color-sev-warning);text-align:center;margin-top:2px">Warning — ' + escapeHtml(rule) + '</div>'
    : '<div class="custom-widget-warn" style="font-size:0.72rem;color:var(--color-text-tertiary);text-align:center;margin-top:2px">Warns ' + escapeHtml(rule) + '</div>';
}

function _renderCustomWidgetGauge(w) {
  // Compact radial-arc — 180° sweep from min to max, a tick at the warning
  // threshold when one is set (the arc turns amber past it), and the current
  // value labeled. Falls through to a numeric readout when the sample isn't a
  // scalar (e.g. an operator picked widgetType=gauge on a table-typed
  // widget; the editor doesn't yet narrow widgetType by kind).
  var raw = (w.latest && w.latest.value);
  var n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) {
    return '<div style="font-size:0.85rem">' + escapeHtml(String(raw)) + '</div>';
  }
  var opts = w.displayOptions || {};
  var fmt = _cwDisplay(w);
  // Bounds and the warning threshold are entered in the widget's own unit, so
  // they convert with the value (a °C widget on a Fahrenheit install).
  var min = fmt.conv(Number.isFinite(opts.min) ? opts.min : 0);
  var max = fmt.conv(Number.isFinite(opts.max) ? opts.max : 100);
  n = fmt.conv(n);
  function frac(v) { return max > min ? Math.max(0, Math.min(1, (v - min) / (max - min))) : 0; }
  var cx = 80, cy = 70, r = 56;
  function point(f, radius) {
    var a = Math.PI * (1 - f);  // 180° -> 0°
    return { x: cx + radius * Math.cos(a), y: cy - radius * Math.sin(a) };
  }
  var end = point(frac(n), r);
  var warn = _customWidgetWarningShown(n, opts, fmt);
  var color = warn && warn.breached ? "var(--color-sev-warning)" : "#22d3ee";
  // The large-arc flag stays 0: the value arc never sweeps more than the
  // gauge's 180°, and a 1 past the midpoint drew the long way round the circle.
  var tick = "";
  if (warn && warn.at >= min && warn.at <= max) {
    var t0 = point(frac(warn.at), r - 9), t1 = point(frac(warn.at), r + 9);
    tick = '<line class="custom-widget-warn-tick" x1="' + t0.x.toFixed(1) + '" y1="' + t0.y.toFixed(1) + '" x2="' + t1.x.toFixed(1) + '" y2="' + t1.y.toFixed(1) + '" stroke="var(--color-sev-warning)" stroke-width="2"/>';
  }
  return '<div style="text-align:center">' +
    '<svg width="160" height="86" viewBox="0 0 160 86" aria-hidden="true">' +
      '<path d="M ' + (cx - r) + ' ' + cy + ' A ' + r + ' ' + r + ' 0 0 1 ' + (cx + r) + ' ' + cy + '" stroke="var(--color-border)" stroke-width="10" fill="none" stroke-linecap="round"/>' +
      '<path class="custom-widget-gauge-arc" d="M ' + (cx - r) + ' ' + cy + ' A ' + r + ' ' + r + ' 0 0 1 ' + end.x.toFixed(1) + ' ' + end.y.toFixed(1) + '" stroke="' + color + '" stroke-width="10" fill="none" stroke-linecap="round"/>' +
      tick +
      '<text x="' + cx + '" y="' + (cy - 6) + '" text-anchor="middle" font-size="20" font-weight="600" fill="' + (warn && warn.breached ? color : "currentColor") + '">' +
        escapeHtml(fmt.text(n)) +
      '</text>' +
      '<text x="' + cx + '" y="' + (cy + 12) + '" text-anchor="middle" font-size="10" fill="var(--color-text-tertiary)">' +
        escapeHtml(fmt.text(min)) + ' &ndash; ' + escapeHtml(fmt.text(max)) +
      '</text>' +
    '</svg>' +
    _customWidgetWarnCaption(warn, fmt.text) +
  '</div>';
}

function _renderCustomWidgetLine(w) {
  // Minimal inline SVG line chart over the sample window the server
  // returned. We don't reuse the larger System-tab chart helper (which
  // hardcodes axes specific to telemetry / RTT) — custom widgets need to
  // adapt their y-range to the actual data domain.
  var fmt = _cwDisplay(w);
  var pts = [];
  (w.samples || []).forEach(function (s) {
    var n = typeof s.value === "number" ? s.value : Number(s.value);
    if (Number.isFinite(n)) pts.push({ t: new Date(s.timestamp).getTime(), v: fmt.conv(n) });
  });
  if (pts.length < 2) {
    return _renderCustomWidgetScalarFallback(w);
  }
  var minV = pts[0].v, maxV = pts[0].v;
  pts.forEach(function (p) { if (p.v < minV) minV = p.v; if (p.v > maxV) maxV = p.v; });
  var latest = pts[pts.length - 1].v;
  var opts = w.displayOptions || {};
  var warn = _customWidgetWarningShown(latest, opts, fmt);
  // The y-domain stretches to take in the threshold, so its dashed line is on
  // the chart rather than off the top; the min / max labels stay the data's.
  var lo = warn ? Math.min(minV, warn.at) : minV;
  var hi = warn ? Math.max(maxV, warn.at) : maxV;
  if (hi === lo) { hi = lo + 1; }
  var minT = pts[0].t, maxT = pts[pts.length - 1].t;
  var W = 280, H = 90, P = 4;
  function yFor(v) { return (H - P) - (H - 2 * P) * ((v - lo) / (hi - lo)); }
  var coords = pts.map(function (p) {
    var x = P + (W - 2 * P) * ((p.t - minT) / Math.max(1, maxT - minT));
    return x.toFixed(1) + "," + yFor(p.v).toFixed(1);
  });
  var threshold = warn
    ? '<line class="custom-widget-warn-line" x1="' + P + '" x2="' + (W - P) + '" y1="' + yFor(warn.at).toFixed(1) + '" y2="' + yFor(warn.at).toFixed(1) + '" stroke="var(--color-sev-warning)" stroke-width="1" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>'
    : "";
  return '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
    threshold +
    '<polyline fill="none" stroke="#22d3ee" stroke-width="1.4" points="' + coords.join(" ") + '"/>' +
  '</svg>' +
  '<div style="display:flex;justify-content:space-between;font-size:0.7rem;color:var(--color-text-tertiary);margin-top:2px">' +
    '<span>min ' + escapeHtml(fmt.text(minV)) + '</span>' +
    '<span' + (warn && warn.breached ? ' style="color:var(--color-sev-warning);font-weight:600"' : '') + '>latest ' + escapeHtml(fmt.text(latest)) + '</span>' +
    '<span>max ' + escapeHtml(fmt.text(maxV)) + '</span>' +
  '</div>' +
  _customWidgetWarnCaption(warn, fmt.text);
}

function _renderCustomWidgetTable(w) {
  // The collector serializes table-typed widgets as an array of row objects;
  // each row's keys are the column names the operator picked. Empty array
  // = no data this cycle.
  var rows = Array.isArray(w.latest && w.latest.value) ? w.latest.value : [];
  if (rows.length === 0) return '<p class="empty-state" style="padding:0.5rem 0;margin:0">No rows.</p>';
  var cols = Object.keys(rows[0] || {});
  if (cols.length === 0) return '<p class="empty-state" style="padding:0.5rem 0;margin:0">No columns.</p>';
  var html = '<div style="overflow:auto"><table class="ip-table" style="font-size:0.78rem"><thead><tr>';
  cols.forEach(function (c) { html += '<th>' + escapeHtml(c) + '</th>'; });
  html += '</tr></thead><tbody>';
  rows.forEach(function (r) {
    html += '<tr>';
    cols.forEach(function (c) {
      var v = r[c];
      var txt = (v === null || v === undefined) ? "" : (typeof v === "object" ? JSON.stringify(v) : String(v));
      html += '<td>' + escapeHtml(txt) + '</td>';
    });
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  return html;
}

function _renderCustomWidgetScalarFallback(w) {
  var v = w.latest && w.latest.value;
  var n = typeof v === "number" ? v : (typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
  var txt;
  if (Number.isFinite(n)) {
    var fmt = _cwDisplay(w);
    txt = fmt.text(fmt.conv(n));
  } else {
    // Not a number (a DisplayString, a row array): shown as is, with its unit.
    var unit = (w.displayOptions && w.displayOptions.unit) ? (" " + w.displayOptions.unit) : "";
    txt = ((v === null || v === undefined) ? "—" : (typeof v === "object" ? JSON.stringify(v) : String(v))) + unit;
  }
  return '<div style="font-size:1.4rem;font-weight:600">' + escapeHtml(txt) + '</div>';
}

function _formatNumber(n) {
  if (!Number.isFinite(n)) return String(n);
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 1)    return n.toFixed(1);
  return n.toFixed(2);
}

// ─── SNMP Walk tab (admin only) ────────────────────────────────────────────
//
// Operator-driven snmpwalk against the asset's IP. Admin-only on both the
// frontend (the tab is omitted) and the backend (POST /assets/:id/snmp-walk
// is gated on requireAdmin). The tab only shows on assets where at least one
// monitoring stream resolves to SNMP (see _assetUsesSnmpPolling) — walking a
// host that speaks no SNMP just times out. Within the tab, pick any stored
// SNMP credential — not just the asset's monitor credential — so an admin
// can use a different community than the one the monitor uses.

// True when at least one monitoring stream actually resolves to SNMP for
// this asset. `eff` is the /effective-monitor-settings payload (walks all
// four tiers, so class overrides and integration baselines count, not just
// per-asset picks — and source defaults are already baked into `resolved`,
// though none of them is ever "snmp"). Custom MIB widget probes ride
// `Asset.customWidgetPolling` (falling back to the cpuMemory method, which
// the resolved check already covers), so the per-asset field counts too.
// Fail-open: when the effective-settings fetch failed the tab stays
// reachable rather than silently vanishing on a transient error.
function _assetUsesSnmpPolling(asset, eff) {
  if (asset && asset.customWidgetPolling === "snmp") return true;
  if (!eff || !eff.resolved) return true;
  var r = eff.resolved;
  return ["responseTimePolling", "cpuMemoryPolling", "temperaturePolling", "interfacesPolling",
          "lldpPolling", "storagePolling", "processesPolling", "eventLogPolling"]
    .some(function (k) { return r[k] === "snmp"; });
}

// ─── Device Query → API Query sub-tab ──────────────────────────────────────
//
// A read-only FortiOS REST console aimed at THIS gate, through the
// integration that discovered it. It calls POST /integrations/:id/query, the
// same endpoint as the integration's Query API console, so it carries that
// endpoint's gate (integrations=write) and nothing new on the server.
// GET only: device writes stay in the integration console, where the
// FortiGate branches audit them.
//
// Transport, by integration:
//   fortigate                   → the integration's own REST call (the gate IS
//                                 the integration's device)
//   fortimanager, proxy on      → JSON-RPC exec /sys/proxy/json, targeting
//                                 the gate by its FMG device name
//   fortimanager, proxy off     → mode "fortigate": FMG resolves the gate's
//                                 management IP, the call goes direct
// The FMG device name is fortinetTopology.deviceName — FMG's name may differ
// from the gate's configured hostname, which is only the fallback.
function _assetApiQueryTransport(a) {
  if (!a || a.assetType !== "firewall") return null;
  var integ = a.discoveredByIntegration;
  if (!integ || !integ.id) return null;
  if (!permAtLeast("integrations", "write")) return null;
  if (integ.type === "fortigate") {
    return { kind: "fortigate", integrationId: integ.id, integrationName: integ.name || "" };
  }
  if (integ.type === "fortimanager") {
    var topo = a.fortinetTopology || {};
    // A row discovered before the stamp existed falls back to the hostname,
    // as descriptionSyncService does; a mismatch shows as FMG's error.
    var deviceName = (typeof topo.deviceName === "string" && topo.deviceName.trim()) || (a.hostname || "").trim() || null;
    if (!deviceName) return null;
    return {
      kind: integ.useProxy === false ? "fmg-direct" : "fmg-proxy",
      integrationId: integ.id,
      integrationName: integ.name || "",
      deviceName: deviceName,
      adom: integ.adom || "root",
    };
  }
  return null;
}

// Last path + parameters, kept across slide-over opens like the SNMP walk's.
var _assetApiQueryLastPath = "/api/v2/monitor/system/status";
var _assetApiQueryLastParams = "vdom=root";

function _assetApiQueryPresets() {
  // The FortiGate console's preset list (integrations.js) when it is loaded.
  return (typeof _FGT_PRESET_QUERIES !== "undefined" && Array.isArray(_FGT_PRESET_QUERIES))
    ? _FGT_PRESET_QUERIES.filter(function (q) { return !q.method || q.method === "GET"; })
    : [];
}

function _assetApiQueryHTML(a, t) {
  var via = t.kind === "fortigate"
    ? "directly, with the <strong>" + escapeHtml(t.integrationName) + "</strong> integration's API token"
    : t.kind === "fmg-proxy"
      ? "through FortiManager <strong>" + escapeHtml(t.integrationName) + "</strong> (proxy), as device <code>" + escapeHtml(t.deviceName) + "</code>"
      : "directly, with FortiManager <strong>" + escapeHtml(t.integrationName) + "</strong>'s FortiGate credentials, as device <code>" + escapeHtml(t.deviceName) + "</code>";
  var presets = _assetApiQueryPresets();
  var presetOpts = '<option value="">— load a preset —</option>' + presets.map(function (q, i) {
    return '<option value="' + i + '">' + escapeHtml(q.name) + "</option>";
  }).join("");
  return (
    '<div data-shot-section="apiQuery" data-shot-label="API Query" style="display:flex;flex-direction:column;gap:0.75rem">' +
      '<div style="font-size:0.85rem;color:var(--color-text-secondary)">' +
        "Sends a read-only FortiOS REST <code>GET</code> to this FortiGate " + via + ". " +
        "Writes are not offered here — use the integration's Query API console." +
      "</div>" +
      (presets.length
        ? '<div><label class="form-label" for="asset-api-preset" style="font-size:0.8rem">Preset</label>' +
            '<select class="form-control" id="asset-api-preset">' + presetOpts + "</select></div>"
        : "") +
      "<div>" +
        '<label class="form-label" for="asset-api-path" style="font-size:0.8rem">Path</label>' +
        '<input class="form-control" id="asset-api-path" type="text" value="' + escapeHtml(_assetApiQueryLastPath) + '" placeholder="/api/v2/monitor/system/status" style="font-family:var(--font-mono,monospace);font-size:0.85rem">' +
      "</div>" +
      "<div>" +
        '<label class="form-label" for="asset-api-params" style="font-size:0.8rem">Query parameters <span style="color:var(--color-text-secondary);font-weight:normal">(one per line — <code>key=value</code>)</span></label>' +
        '<textarea class="form-control" id="asset-api-params" rows="3" style="font-family:var(--font-mono,monospace);font-size:0.82rem" placeholder="vdom=root&#10;format=name|ip|status">' + escapeHtml(_assetApiQueryLastParams) + "</textarea>" +
      "</div>" +
      '<div style="display:flex;gap:0.5rem;align-items:center">' +
        '<button type="button" class="btn btn-primary btn-sm" id="btn-asset-api-send">Send</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="btn-asset-api-copy" disabled>Copy response</button>' +
        '<span id="asset-api-status" style="font-size:0.8rem;color:var(--color-text-secondary)"></span>' +
      "</div>" +
      '<pre id="asset-api-response" style="display:none;background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:0.75rem;font-size:0.78rem;overflow:auto;max-height:60vh;white-space:pre-wrap;word-break:break-all;margin:0"></pre>' +
    "</div>"
  );
}

// "key=value" lines → an object; a bare key maps to "". Same parse as the
// integration consoles.
function _assetApiQueryParseParams(text) {
  var out = {};
  String(text || "").split("\n").forEach(function (line) {
    var trimmed = line.trim();
    if (!trimmed) return;
    var eq = trimmed.indexOf("=");
    if (eq < 0) { out[trimmed] = ""; return; }
    var key = trimmed.slice(0, eq).trim();
    if (key) out[key] = trimmed.slice(eq + 1).trim();
  });
  return out;
}

// The request body for POST /integrations/:id/query, per transport.
function _assetApiQueryPayload(t, path, params) {
  if (t.kind === "fortigate") return { method: "GET", path: path, query: params };
  if (t.kind === "fmg-direct") {
    return { mode: "fortigate", deviceName: t.deviceName, method: "GET", path: path, query: params };
  }
  // FMG proxy: the query string rides on the proxied resource.
  var qs = Object.keys(params).map(function (k) {
    return encodeURIComponent(k) + (params[k] === "" ? "" : "=" + encodeURIComponent(params[k]));
  }).join("&");
  return {
    mode: "fmg",
    method: "exec",
    params: [{
      url: "/sys/proxy/json",
      data: {
        target: ["/adom/" + t.adom + "/device/" + t.deviceName],
        action: "get",
        resource: path + (qs ? (path.indexOf("?") === -1 ? "?" : "&") + qs : ""),
      },
    }],
  };
}

function _wireAssetApiQuery(a, t) {
  var sendBtn = document.getElementById("btn-asset-api-send");
  if (!sendBtn) return;
  var copyBtn = document.getElementById("btn-asset-api-copy");
  var statusEl = document.getElementById("asset-api-status");
  var pathEl = document.getElementById("asset-api-path");
  var paramsEl = document.getElementById("asset-api-params");
  var respEl = document.getElementById("asset-api-response");
  var presetEl = document.getElementById("asset-api-preset");
  if (presetEl) {
    presetEl.addEventListener("change", function () {
      var q = _assetApiQueryPresets()[parseInt(presetEl.value, 10)];
      if (!q) return;
      pathEl.value = q.path || "";
      paramsEl.value = q.query || "";
    });
  }
  sendBtn.addEventListener("click", async function () {
    var path = pathEl.value.trim();
    if (!path) { showToast("Enter a path (e.g. /api/v2/monitor/system/status)", "error"); return; }
    _assetApiQueryLastPath = path;
    _assetApiQueryLastParams = paramsEl.value;
    var payload = _assetApiQueryPayload(t, path, _assetApiQueryParseParams(paramsEl.value));
    sendBtn.disabled = true;
    sendBtn.textContent = "Sending…";
    statusEl.textContent = "";
    var started = Date.now();
    try {
      var result = await api.integrations.query(t.integrationId, payload);
      respEl.textContent = JSON.stringify(result, null, 2);
      statusEl.textContent = "Answered in " + (Date.now() - started) + " ms";
    } catch (err) {
      respEl.textContent = "Error: " + (err && err.message ? err.message : String(err));
      statusEl.textContent = "";
    } finally {
      respEl.style.display = "";
      copyBtn.disabled = false;
      sendBtn.disabled = false;
      sendBtn.textContent = "Send";
    }
  });
  copyBtn.addEventListener("click", function () {
    copyTextToClipboard(respEl.textContent).then(function (ok) {
      if (!ok) { showToast("Copy failed", "error"); return; }
      copyBtn.textContent = "Copied!";
      setTimeout(function () { copyBtn.textContent = "Copy response"; }, 1500);
    });
  });
}

var _snmpWalkLastOid = "1.3.6.1.2.1.1";
var _snmpWalkLastCredId = null;
var _snmpWalkLastMibId = "";        // "" = no MIB, "std:..." = standard, UUID = uploaded
var _snmpWalkLastObjectName = "";   // persists object name across tab open/close
var _snmpMibCache = null;           // null = not yet loaded; [] = loaded (may be empty)
var _snmpMibStructureCache = {};    // keyed by mibId; structure payload from GET /mibs/:id/structure

// "Standard MIBs" in the SNMP Walk dropdown are strictly RFC/IEEE specs
// Polaris seeds top-level OIDs for. Vendor MIBs (FORTINET-FORTIGATE-MIB,
// CISCO-PROCESS-MIB, etc.) belong in the Uploaded MIBs section — operators
// upload them via Server Settings → Identification → MIB Database, which
// also unlocks the MIB-aware walk (symbol resolution + value decoding).
var _SNMP_STANDARD_MIBS = [
  { id: "std:system",         label: "System (RFC 1213)",              oid: "1.3.6.1.2.1.1"          },
  { id: "std:interfaces",     label: "Interfaces — ifTable (RFC 2863)", oid: "1.3.6.1.2.1.2"          },
  { id: "std:if-ext",         label: "Interfaces — ifXTable, 64-bit counters (RFC 2863)", oid: "1.3.6.1.2.1.31"         },
  { id: "std:host-resources", label: "HOST-RESOURCES-MIB (RFC 2790)",  oid: "1.3.6.1.2.1.25"         },
  { id: "std:entity",         label: "ENTITY-MIB (RFC 4133)",          oid: "1.3.6.1.2.1.47"         },
  { id: "std:entity-sensor",  label: "ENTITY-SENSOR-MIB (RFC 3433)",   oid: "1.3.6.1.2.1.99"         },
  { id: "std:lldp",           label: "LLDP-MIB (IEEE 802.1AB)",        oid: "1.0.8802.1.1.2"         },
  { id: "std:poe",            label: "PoE — POWER-ETHERNET-MIB (RFC 3621)", oid: "1.3.6.1.2.1.105"   },
  { id: "std:bridge",         label: "Bridge — MAC forwarding + STP (RFC 4188)", oid: "1.3.6.1.2.1.17" },
  { id: "std:q-bridge",       label: "Bridge — VLAN-aware forwarding (RFC 4363)", oid: "1.3.6.1.2.1.17.7" },
  { id: "std:rstp",           label: "Rapid Spanning Tree (RFC 4318)", oid: "1.3.6.1.2.1.134"        },
  { id: "std:ip",             label: "IP — addresses + neighbour cache (RFC 4293)", oid: "1.3.6.1.2.1.4" },
];

function _snmpCredentialOptions(selectedId, onlyIds) {
  var snmpCreds = (_credentialCache.list || []).filter(function (c) {
    return c.type === "snmp" && (!onlyIds || onlyIds.indexOf(c.id) !== -1);
  });
  if (!snmpCreds.length) {
    return onlyIds
      ? '<option value="">(this asset has no SNMP credential of its own)</option>'
      : '<option value="">(no SNMP credentials defined)</option>';
  }
  var defaultId = selectedId || _snmpWalkLastCredId || snmpCreds[0].id;
  var opts = "";
  snmpCreds.forEach(function (c) {
    opts += '<option value="' + escapeHtml(c.id) + '"' + (defaultId === c.id ? " selected" : "") + '>' + escapeHtml(c.name) + '</option>';
  });
  return opts;
}

function assetSnmpWalkViewHTML(a, eff) {
  if (!a.ipAddress) {
    return '<div style="padding:1rem 0;color:var(--color-text-secondary)">' +
      'SNMP walks need an IP address — assign one to this asset before running a walk.' +
    '</div>';
  }
  // Pre-select the credential this asset's SNMP polling authenticates with
  // (`snmpCredentialId` on the effective settings — the server walks each
  // SNMP stream's own chain: per-stream, default, class override, Fortinet
  // integration). Falls back to the stored monitor credential when it is an
  // SNMP one, e.g. when the effective-settings read failed.
  var monCred = a.monitorCredential;
  var pollCredId = (eff && eff.snmpCredentialId) || null;
  var seedCredId = pollCredId || ((monCred && monCred.type === "snmp") ? monCred.id : null);
  // Business rule 112(e): without Assets Read-Write a walk may use only the
  // credentials this asset already has; the server refuses any other.
  var walkOnlyIds = null;
  if (typeof canManageAssets === "function" && !canManageAssets()) {
    walkOnlyIds = [a.monitorCredentialId, a.responseTimeCredentialId, a.cpuMemoryCredentialId,
      a.temperatureCredentialId, a.interfacesCredentialId, a.lldpCredentialId,
      monCred && monCred.id, pollCredId].filter(Boolean);
  }
  // std and uploaded MIBs both use the object-name input + browse tree.
  // No MIB selected → numeric base-OID input + raw walk.
  var mibAware = !!_snmpWalkLastMibId;
  var oidVal = mibAware ? (_snmpWalkLastObjectName || "") : (_snmpWalkLastOid || "");
  var oidLabelText = mibAware ? "Object name" : "Base OID";
  var oidPlaceholder = mibAware ? "e.g. sysDescr, ifTable, lldpRemTable" : "1.3.6.1.2.1.1";
  return (
    '<div data-shot-section="snmpWalk" data-shot-label="SNMP Walk" style="display:flex;flex-direction:column;gap:0.75rem">' +
      '<div style="font-size:0.85rem;color:var(--color-text-secondary)">' +
        'Walks <code>' + escapeHtml(a.ipAddress) + '</code> using the selected SNMP credential. Admin-only — every walk is audited. Walks are capped at 5,000 rows.' +
      '</div>' +
      '<div>' +
        '<label class="form-label" for="snmp-walk-mib" style="font-size:0.8rem">MIB <span style="color:var(--color-text-secondary);font-weight:normal">(optional — select to decode values)</span></label>' +
        '<select class="form-control" id="snmp-walk-mib"><option value="">— No MIB (raw numeric walk) —</option></select>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:0.5rem;align-items:end">' +
        '<div>' +
          '<label class="form-label" for="snmp-walk-oid" style="font-size:0.8rem" id="snmp-walk-oid-label">' + oidLabelText + '</label>' +
          '<input class="form-control" id="snmp-walk-oid" type="text" value="' + escapeHtml(oidVal || "") + '" placeholder="' + escapeHtml(oidPlaceholder) + '">' +
        '</div>' +
        '<div>' +
          '<label class="form-label" for="snmp-walk-cred" style="font-size:0.8rem">Credential</label>' +
          '<select class="form-control" id="snmp-walk-cred">' + _snmpCredentialOptions(seedCredId, walkOnlyIds) + '</select>' +
        '</div>' +
        '<div>' +
          '<label class="form-label" for="snmp-walk-max" style="font-size:0.8rem">Max rows</label>' +
          '<input class="form-control" id="snmp-walk-max" type="number" min="1" max="5000" value="500" style="width:100px">' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:0.5rem;align-items:center">' +
        '<button type="button" class="btn btn-primary btn-sm" id="btn-snmp-walk">Walk</button>' +
        '<button type="button" class="btn btn-danger btn-sm" id="btn-snmp-walk-abort" style="display:none">Abort</button>' +
        '<span id="snmp-walk-countdown" style="display:none;font-size:0.8rem;color:var(--color-text-secondary);font-variant-numeric:tabular-nums" title="Time remaining before the walk is aborted"></span>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="btn-snmp-walk-copy" disabled>Copy results</button>' +
        '<span id="snmp-walk-status" style="font-size:0.8rem;color:var(--color-text-secondary)"></span>' +
      '</div>' +
      '<div id="snmp-walk-mib-tree" style="display:none"></div>' +
      '<div id="snmp-walk-results"></div>' +
    '</div>'
  );
}

// Renders the symbol tree for an uploaded MIB into #snmp-walk-mib-tree.
// Click-to-select-only: tapping a symbol fills the object-name input and
// highlights the row, but does not auto-walk (walks can be slow).
function _renderSnmpMibTree(structure, onPick, selectedName) {
  var mount = document.getElementById("snmp-walk-mib-tree");
  if (!mount) return;
  if (!structure) {
    mount.style.display = "none";
    mount.innerHTML = "";
    return;
  }

  var tableColumns = new Set();
  var tableRows = new Set();
  var tableNames = new Set();
  (structure.tables || []).forEach(function (t) {
    tableNames.add(t.name);
    tableRows.add(t.rowSymbol);
    (t.columns || []).forEach(function (c) { tableColumns.add(c); });
  });

  function rowHtml(name, suffixHtml) {
    return '<div class="snmp-mib-tree-row" data-name="' + escapeHtml(name) + '" ' +
      'style="padding:0.3rem 0.5rem;cursor:pointer;border-radius:4px;font-family:var(--font-mono,monospace);font-size:0.78rem">' +
      escapeHtml(name) + (suffixHtml || "") +
    "</div>";
  }

  var tableRowsHtml = (structure.tables || []).map(function (t) {
    var colCount = t.columns ? t.columns.length : 0;
    var suffix = ' <span style="color:var(--color-text-tertiary);font-size:0.72rem;font-family:inherit">(' + colCount + ' col' + (colCount === 1 ? "" : "s") + ")</span>";
    return rowHtml(t.name, suffix);
  }).join("");

  var scalarRowsHtml = (structure.symbols || [])
    .filter(function (s) { return !tableColumns.has(s.name) && !tableRows.has(s.name) && !tableNames.has(s.name); })
    .map(function (s) {
      var typeBadge = s.baseType && s.baseType !== "OTHER" && s.baseType !== "OBJECT IDENTIFIER"
        ? ' <span style="color:var(--color-text-tertiary);font-size:0.72rem;font-family:inherit">' + escapeHtml(s.baseType) + "</span>"
        : "";
      var unresolved = s.fullOid === null
        ? ' <span style="color:var(--color-warning,#d97706);font-size:0.72rem;font-family:inherit">(unresolved)</span>'
        : "";
      return rowHtml(s.name, typeBadge + unresolved);
    }).join("");

  function section(title, inner) {
    if (!inner) return "";
    return '<div style="margin-bottom:0.5rem">' +
      '<div style="font-size:0.78rem;font-weight:600;color:var(--color-text-secondary);padding:0.25rem 0.5rem">' +
        escapeHtml(title) +
      "</div>" +
      inner +
    "</div>";
  }

  mount.style.display = "";
  mount.innerHTML =
    '<div style="border:1px solid var(--color-border);border-radius:6px;background:var(--color-surface-alt,rgba(127,127,127,0.04))">' +
      '<div style="padding:0.4rem 0.6rem;font-size:0.78rem;color:var(--color-text-secondary);border-bottom:1px solid var(--color-border)">' +
        "Browse " + escapeHtml(structure.moduleName || "MIB") + " — click a symbol to load it into the Object name field." +
      "</div>" +
      '<div style="max-height:32vh;overflow:auto;overscroll-behavior:contain;padding:0.5rem">' +
        section("Tables", tableRowsHtml) +
        section("Scalars / Other", scalarRowsHtml) +
      "</div>" +
    "</div>";

  _applySnmpMibTreeSelection(selectedName);

  mount.querySelectorAll(".snmp-mib-tree-row").forEach(function (el) {
    el.addEventListener("click", function () { onPick(el.getAttribute("data-name")); });
  });
}

// Moves the selection highlight without rebuilding the tree. Re-rendering
// would replace the scroller element, and a fresh element starts at
// scrollTop 0 — so picking a symbol halfway down the list threw the
// operator back to the top of it. Restyle the existing rows in place.
function _applySnmpMibTreeSelection(selectedName) {
  var mount = document.getElementById("snmp-walk-mib-tree");
  if (!mount) return;
  mount.querySelectorAll(".snmp-mib-tree-row").forEach(function (el) {
    var isSel = el.getAttribute("data-name") === selectedName;
    el.style.background = isSel ? "var(--color-primary-bg,rgba(99,179,237,0.18))" : "";
    el.style.color = isSel ? "var(--color-primary,#4fc3f7)" : "";
  });
}

function _renderSnmpWalkRows(result) {
  var container = document.getElementById("snmp-walk-results");
  if (!container) return;
  if (!result.rows.length) {
    container.innerHTML = '<p class="empty-state" style="padding:0.75rem 0">No varbinds returned.</p>';
    return;
  }
  var truncated = result.truncated
    ? '<div style="font-size:0.8rem;color:var(--color-warning,#d4a23a);margin-bottom:0.4rem">Truncated at ' + result.rows.length + ' rows — narrow the OID or raise Max rows to see more.</div>'
    : "";
  var rowsHtml = result.rows.map(function (r) {
    return '<tr>' +
      '<td style="font-family:var(--font-mono,monospace);font-size:0.78rem;white-space:nowrap">' + escapeHtml(r.oid) + '</td>' +
      '<td style="font-size:0.78rem;color:var(--color-text-secondary);white-space:nowrap">' + escapeHtml(r.type) + '</td>' +
      '<td style="font-family:var(--font-mono,monospace);font-size:0.78rem;word-break:break-all">' + escapeHtml(r.value) + '</td>' +
    '</tr>';
  }).join("");
  container.innerHTML = truncated +
    '<div class="table-wrapper" style="max-height:60vh;overflow:auto">' +
      '<table class="data-table" style="font-size:0.82rem;min-width:max-content">' +
        '<thead><tr><th style="white-space:nowrap">OID</th><th style="white-space:nowrap">Type</th><th style="white-space:nowrap">Value</th></tr></thead>' +
        '<tbody>' + rowsHtml + '</tbody>' +
      '</table>' +
    '</div>';
}

function _renderMibWalkResult(result) {
  var container = document.getElementById("snmp-walk-results");
  if (!container) return;

  var header = "";
  if (result.rowCount > 0 && result.decodedCount < result.rowCount / 2) {
    header += '<div style="font-size:0.8rem;background:var(--color-warning-bg,rgba(212,162,58,0.12));color:var(--color-warning,#d4a23a);border-radius:4px;padding:0.4rem 0.6rem;margin-bottom:0.5rem">' +
      'Decoded ' + result.decodedCount + ' / ' + result.rowCount + ' values — this MIB may not match the asset’s manufacturer.' +
    '</div>';
  }
  if (result.truncated) {
    header += '<div style="font-size:0.8rem;color:var(--color-warning,#d4a23a);margin-bottom:0.4rem">Truncated at ' + result.rowCount + ' rows — raise Max rows or narrow the object to see more.</div>';
  }

  if (result.kind === "table" && result.table) {
    var t = result.table;
    if (!t.rows.length) {
      container.innerHTML = header + '<p class="empty-state" style="padding:0.75rem 0">No table rows returned.</p>';
      return;
    }
    var cols = t.columns;
    var thHtml = '<th style="white-space:nowrap">Index</th>' + cols.map(function (c) { return '<th style="white-space:nowrap">' + escapeHtml(c) + "</th>"; }).join("");
    var rowsHtml = t.rows.map(function (row) {
      var cells = '<td style="font-family:var(--font-mono,monospace);font-size:0.78rem;white-space:nowrap">' + escapeHtml(row.index) + "</td>";
      cells += cols.map(function (col) {
        var cell = row.cells[col];
        if (!cell) return '<td style="color:var(--color-text-secondary)">—</td>';
        var display = escapeHtml(cell.decoded);
        if (cell.raw !== cell.decoded) {
          display = '<span title="raw: ' + escapeHtml(cell.raw) + '" style="cursor:help;border-bottom:1px dotted var(--color-border)">' + display + "</span>";
        }
        return '<td style="font-size:0.78rem">' + display + "</td>";
      }).join("");
      return "<tr>" + cells + "</tr>";
    }).join("");
    container.innerHTML = header +
      '<div class="table-wrapper" style="max-height:60vh;overflow:auto">' +
        '<table class="data-table" style="font-size:0.82rem;min-width:max-content">' +
          "<thead><tr>" + thHtml + "</tr></thead>" +
          "<tbody>" + rowsHtml + "</tbody>" +
        "</table>" +
      "</div>";
    return;
  }

  // scalars
  var entries = result.entries || [];
  if (!entries.length) {
    container.innerHTML = header + '<p class="empty-state" style="padding:0.75rem 0">No varbinds returned.</p>';
    return;
  }
  var rowsHtml = entries.map(function (e) {
    var symHtml = e.symbol
      ? escapeHtml(e.symbol) + (e.suffix ? '<span style="color:var(--color-text-secondary)">.' + escapeHtml(e.suffix) + "</span>" : "")
      : '<span style="color:var(--color-text-secondary)">—</span>';
    var decoded = escapeHtml(e.decoded || e.raw);
    var rawHint = (e.decoded && e.decoded !== e.raw)
      ? ' <span style="font-size:0.75rem;color:var(--color-text-secondary)">(' + escapeHtml(e.raw) + ")</span>"
      : "";
    return "<tr>" +
      '<td style="font-family:var(--font-mono,monospace);font-size:0.78rem;white-space:nowrap">' + escapeHtml(e.oid) + "</td>" +
      '<td style="font-size:0.78rem">' + symHtml + "</td>" +
      '<td style="font-family:var(--font-mono,monospace);font-size:0.78rem;word-break:break-all">' + decoded + rawHint + "</td>" +
    "</tr>";
  }).join("");
  container.innerHTML = header +
    '<div class="table-wrapper" style="max-height:60vh;overflow:auto">' +
      '<table class="data-table" style="font-size:0.82rem;min-width:max-content">' +
        '<thead><tr><th style="white-space:nowrap">OID</th><th style="white-space:nowrap">Symbol</th><th style="white-space:nowrap">Value</th></tr></thead>' +
        "<tbody>" + rowsHtml + "</tbody>" +
      "</table>" +
    "</div>";
}

function _wireSnmpWalkTab(a) {
  var walkBtn = document.getElementById("btn-snmp-walk");
  if (!walkBtn) return; // tab not rendered (e.g. asset has no IP)
  var abortBtn    = document.getElementById("btn-snmp-walk-abort");
  var copyBtn     = document.getElementById("btn-snmp-walk-copy");
  var statusEl    = document.getElementById("snmp-walk-status");
  var mibSel      = document.getElementById("snmp-walk-mib");
  var oidLabel    = document.getElementById("snmp-walk-oid-label");
  var oidInput    = document.getElementById("snmp-walk-oid");
  var countdownEl = document.getElementById("snmp-walk-countdown");
  var lastResult    = null; // raw walk result
  var lastMibResult = null; // MIB-aware walk result
  var activeController = null;

  // Client-enforced walk deadline. There is no end-to-end timeout anywhere
  // else on this path (nginx allows 3600s; net-snmp's 10s timeout is per
  // getBulk request, not per walk), so a slow device could otherwise leave
  // the tab spinning indefinitely. The countdown renders next to the Walk
  // button and aborts the request when it reaches zero. The server-side walk
  // keeps running to completion either way — abort only abandons the response.
  var WALK_TIMEOUT_SEC = 60;
  var countdownTimer = null;
  var walkTimedOut = false;

  function _stopCountdown() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (countdownEl) { countdownEl.style.display = "none"; countdownEl.textContent = ""; }
  }

  function _startCountdown(controller) {
    walkTimedOut = false;
    var remaining = WALK_TIMEOUT_SEC;
    if (countdownEl) {
      countdownEl.style.display = "";
      countdownEl.textContent = remaining + "s";
    }
    countdownTimer = setInterval(function () {
      remaining -= 1;
      if (remaining <= 0) {
        _stopCountdown();
        walkTimedOut = true;
        controller.abort();
      } else if (countdownEl) {
        countdownEl.textContent = remaining + "s";
      }
    }, 1000);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  // "MIB-aware" — std AND uploaded MIBs both render the browse tree and
  // walk through the symbol-resolving endpoint. Raw OID mode (no MIB) is
  // the only branch that stays on numeric input + raw walk.
  function _isMibAware(mibId) { return !!mibId; }

  function _loadAndRenderMibTree(mibId) {
    if (!_isMibAware(mibId)) {
      _renderSnmpMibTree(null);
      return;
    }
    var pick = function (name) {
      oidInput.value = name;
      _snmpWalkLastObjectName = name;
      // preventScroll: focusing the input would otherwise scroll-into-view it,
      // jumping the modal's scroll container back to the top and yanking the
      // tree out from under the operator who just clicked a symbol.
      oidInput.focus({ preventScroll: true });
      _applySnmpMibTreeSelection(name);
    };
    var cached = _snmpMibStructureCache[mibId];
    if (cached) {
      _renderSnmpMibTree(cached, pick, _snmpWalkLastObjectName || null);
      return;
    }
    var mount = document.getElementById("snmp-walk-mib-tree");
    if (mount) {
      mount.style.display = "";
      mount.innerHTML = '<div style="padding:0.5rem;font-size:0.8rem;color:var(--color-text-secondary)">Loading MIB structure…</div>';
    }
    var fetcher = mibId.indexOf("std:") === 0
      ? api.serverSettings.getStdMibStructure(mibId)
      : api.serverSettings.getMibStructure(mibId);
    fetcher.then(function (st) {
      _snmpMibStructureCache[mibId] = st;
      if (mibSel.value === mibId) {
        _renderSnmpMibTree(st, pick, _snmpWalkLastObjectName || null);
      }
    }).catch(function (err) {
      if (mibSel.value !== mibId) return;
      var mt = document.getElementById("snmp-walk-mib-tree");
      if (mt) {
        mt.style.display = "";
        mt.innerHTML = '<div style="padding:0.5rem;font-size:0.8rem;color:var(--color-danger,#c0392b)">' +
          escapeHtml(err.message || "Failed to load MIB structure") +
        "</div>";
      }
    });
  }

  function _updateOidMode(mibId) {
    if (_isMibAware(mibId)) {
      // std and uploaded MIBs both use object-name mode; the browse tree
      // fills the input on click.
      oidLabel.textContent = "Object name";
      oidInput.placeholder = "e.g. sysDescr, ifTable, lldpRemTable";
      oidInput.value = _snmpWalkLastObjectName || "";
    } else {
      oidLabel.textContent = "Base OID";
      oidInput.placeholder = "1.3.6.1.2.1.1";
      oidInput.value = _snmpWalkLastOid;
    }
  }

  function _populateMibDropdown(uploadedMibs) {
    var html = '<option value="">— No MIB (raw numeric walk) —</option>';
    html += '<optgroup label="Standard MIBs">';
    _SNMP_STANDARD_MIBS.forEach(function (m) {
      html += '<option value="' + escapeHtml(m.id) + '"' + (_snmpWalkLastMibId === m.id ? " selected" : "") + '>' + escapeHtml(m.label) + "</option>";
    });
    html += "</optgroup>";
    if (uploadedMibs && uploadedMibs.length) {
      html += '<optgroup label="Uploaded MIBs">';
      uploadedMibs.forEach(function (m) {
        var label = m.manufacturer
          ? m.manufacturer + (m.model ? " / " + m.model : "") + " — " + m.moduleName
          : m.moduleName;
        html += '<option value="' + escapeHtml(m.id) + '"' + (_snmpWalkLastMibId === m.id ? " selected" : "") + '>' + escapeHtml(label) + "</option>";
      });
      html += "</optgroup>";
    }
    mibSel.innerHTML = html;
    _updateOidMode(mibSel.value);
    _loadAndRenderMibTree(mibSel.value);
  }

  // ── Load uploaded MIBs into dropdown ─────────────────────────────────────

  if (_snmpMibCache !== null) {
    _populateMibDropdown(_snmpMibCache);
  } else {
    _populateMibDropdown([]); // show standard MIBs immediately
    api.serverSettings.listMibs({}).then(function (mibs) {
      _snmpMibCache = Array.isArray(mibs) ? mibs : [];
      _populateMibDropdown(_snmpMibCache);
    }).catch(function () {
      _snmpMibCache = [];
    });
  }

  // ── MIB select change ─────────────────────────────────────────────────────

  mibSel.addEventListener("change", function () {
    _snmpWalkLastMibId = mibSel.value;
    _updateOidMode(mibSel.value);
    _loadAndRenderMibTree(mibSel.value);
    document.getElementById("snmp-walk-results").innerHTML = "";
    statusEl.textContent = "";
    if (copyBtn) copyBtn.disabled = true;
    lastResult = null;
    lastMibResult = null;
  });

  // ── Walk button ───────────────────────────────────────────────────────────

  walkBtn.addEventListener("click", async function () {
    var mibId   = mibSel.value;
    var oidOrObj = (oidInput.value || "").trim();
    var credId  = document.getElementById("snmp-walk-cred").value;
    var maxRows = parseInt(document.getElementById("snmp-walk-max").value, 10) || 500;
    var mibAware = _isMibAware(mibId);
    var isStd    = mibAware && mibId.indexOf("std:") === 0;

    if (!oidOrObj) { showToast(mibAware ? "Enter an object name" : "Enter a base OID", "error"); return; }
    if (!credId)   { showToast("Select an SNMP credential", "error"); return; }
    if (!mibAware && !/^\d+(\.\d+)*$/.test(oidOrObj)) {
      showToast("OID must be numeric (e.g. 1.3.6.1.2.1.1)", "error");
      return;
    }

    // Persist state
    _snmpWalkLastMibId   = mibId;
    _snmpWalkLastCredId  = credId;
    if (mibAware) { _snmpWalkLastObjectName = oidOrObj; } else { _snmpWalkLastOid = oidOrObj; }

    walkBtn.disabled = true;
    walkBtn.textContent = "Walking…";
    if (copyBtn) copyBtn.disabled = true;
    if (abortBtn) { abortBtn.style.display = ""; abortBtn.disabled = false; }
    statusEl.textContent = "Walking " + a.ipAddress + "…";
    document.getElementById("snmp-walk-results").innerHTML = "";
    lastResult = null;
    lastMibResult = null;

    activeController = new AbortController();
    var thisController = activeController;
    _startCountdown(thisController);

    try {
      if (mibAware) {
        var walkBody = { assetId: a.id, credentialId: credId, objectName: oidOrObj, maxRows: maxRows };
        var mibResult = isStd
          ? await api.serverSettings.walkStdMib(mibId, walkBody, thisController.signal)
          : await api.serverSettings.walkMib(mibId, walkBody, thisController.signal);
        lastMibResult = mibResult;
        statusEl.textContent = mibResult.rowCount + " row(s) in " + mibResult.durationMs + " ms" +
          (mibResult.truncated ? " (truncated)" : "") +
          " — decoded " + mibResult.decodedCount + "/" + mibResult.rowCount;
        _renderMibWalkResult(mibResult);
        if (copyBtn) copyBtn.disabled = !mibResult.rowCount;
      } else {
        var result = await api.assets.snmpWalk(a.id, { credentialId: credId, oid: oidOrObj, maxRows: maxRows }, thisController.signal);
        lastResult = result;
        statusEl.textContent = result.rows.length + " row(s) in " + result.durationMs + " ms" + (result.truncated ? " (truncated)" : "");
        _renderSnmpWalkRows(result);
        if (copyBtn) copyBtn.disabled = !result.rows.length;
      }
    } catch (err) {
      lastResult = null;
      lastMibResult = null;
      var aborted = err && (err.name === "AbortError" || thisController.signal.aborted);
      if (aborted) {
        var abortMsg = walkTimedOut
          ? "Walk timed out after " + WALK_TIMEOUT_SEC + "s."
          : "Walk aborted.";
        statusEl.textContent = abortMsg;
        document.getElementById("snmp-walk-results").innerHTML =
          '<p class="empty-state" style="padding:0.75rem 0">' + abortMsg + "</p>";
      } else {
        statusEl.textContent = "";
        var errMsg = err.message || "SNMP walk failed";
        // The per-host SNMP gate serializes walks against monitoring polls on
        // the same device; a gate timeout means the walk never started.
        if (/SNMP gate timeout/i.test(errMsg)) {
          errMsg = "Device was busy with another SNMP poll for the entire wait window — the walk never started. Try again in a moment.";
        }
        showToast(errMsg, "error");
        document.getElementById("snmp-walk-results").innerHTML =
          '<p class="empty-state" style="padding:0.75rem 0;color:var(--color-danger,#c0392b)">' +
            escapeHtml(errMsg) +
          "</p>";
      }
    } finally {
      _stopCountdown();
      if (activeController === thisController) activeController = null;
      walkBtn.disabled = false;
      walkBtn.textContent = "Walk";
      if (abortBtn) { abortBtn.style.display = "none"; abortBtn.disabled = false; }
    }
  });

  // ── Abort ─────────────────────────────────────────────────────────────────

  if (abortBtn) {
    abortBtn.addEventListener("click", function () {
      if (!activeController) return;
      abortBtn.disabled = true;
      statusEl.textContent = "Aborting…";
      activeController.abort();
    });
  }

  // ── Copy results ──────────────────────────────────────────────────────────

  if (copyBtn) {
    copyBtn.addEventListener("click", async function () {
      var text = "";
      if (lastMibResult) {
        if (lastMibResult.kind === "table" && lastMibResult.table) {
          var t = lastMibResult.table;
          var cols = t.columns;
          text = ["Index"].concat(cols).join("\t") + "\n" +
            t.rows.map(function (row) {
              return [row.index].concat(cols.map(function (c) {
                var cell = row.cells[c];
                return cell ? cell.decoded : "";
              })).join("\t");
            }).join("\n");
        } else if (lastMibResult.entries) {
          text = lastMibResult.entries.map(function (e) {
            var sym = e.symbol ? e.symbol + (e.suffix ? "." + e.suffix : "") : e.oid;
            return sym + " = " + (e.decoded || e.raw) + (e.decoded !== e.raw ? " (" + e.raw + ")" : "");
          }).join("\n");
        }
      } else if (lastResult) {
        text = lastResult.rows.map(function (r) { return r.oid + " = " + r.type + ": " + r.value; }).join("\n");
      }
      if (!text) return;
      try {
        if (!(await copyTextToClipboard(text))) throw new Error("copy failed");
        var count = lastMibResult ? lastMibResult.rowCount : lastResult.rows.length;
        showToast("Copied " + count + " row(s)", "success");
      } catch (_) {
        showToast("Copy failed", "error");
      }
    });
  }
}
