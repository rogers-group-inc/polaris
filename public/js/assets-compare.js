// public/js/assets-compare.js
//
// Multi-asset telemetry comparison. Wired from the Assets bulk bar "Compare"
// button (see assets.js → _assetsUpdateBulkBar visibility + the DOMContentLoaded
// click handler that calls openCompareModal). The modal picks metrics, optional
// interface names, and a layout; openComparePanel then renders a slide-over of
// comparison charts built on the canonical SVG chart helpers from assets.js.
//
// Plain script (shares globals with assets.js / app.js / api.js) — loaded after
// assets.js in assets.html. Reuses: openModal/closeModal/showToast/escapeHtml,
// initSlideoverResize, _chartRangeBtnsHTML/_getChartRangePref/_setChartRangePref,
// _chartTimeBounds/_chartClip*/_dateChangeMarkers/_observeChartResize,
// CHART_TOOLTIP_HTML/_wireChartTooltip/_fmtTooltipTs, _fmtBitsPerSec,
// _derivePerIntervalSeries, _toLocalDatetimeInput, trackedPdfExport, _branding,
// htmlToImage (vendor), window.jspdf (vendor).

// Cap selected assets per comparison — more than this and overlaid lines become
// unreadable and the per-chart fetch fan-out gets expensive.
var _CMP_MAX_ASSETS = 10;

// Distinct, theme-agnostic line colors cycled across assets / series.
var _CMP_COLORS = [
  "#4fc3f7", "#f4a261", "#81c784", "#e57373", "#ba68c8",
  "#ffd54f", "#4db6ac", "#f06292", "#7986cb", "#a1887f",
];

// Metric catalogue. `unit` drives the y-axis + value formatting; `pct` pins the
// axis to 0–100%; `perInterface` marks the streams that need an interface-name
// selection; `needsStorage` marks the stream that resolves a mountpoint.
var _CMP_METRICS = [
  { key: "response",   label: "Response time",            unit: "ms" },
  { key: "cpu",        label: "CPU usage",                unit: "%",   pct: true },
  { key: "memory",     label: "Memory usage",             unit: "%",   pct: true },
  { key: "storage",    label: "Storage usage",            unit: "%",   pct: true, needsStorage: true },
  // Single toggle covering both interface streams — expands into the two
  // chartable sub-metrics below at chart-build time.
  { key: "interfaces", label: "Interface throughput & errors", perInterface: true },
];

// The combined "interfaces" toggle fans out into these chartable sub-metrics
// (different units → distinct charts). metricKey on a series is one of these.
var _CMP_IFACE_SUBMETRICS = [
  { key: "ifThroughput", label: "Interface throughput", unit: "bps", perInterface: true },
  { key: "ifErrors",     label: "Interface errors",     unit: "err", perInterface: true },
];

function _cmpMetric(key) {
  for (var i = 0; i < _CMP_METRICS.length; i++) {
    if (_CMP_METRICS[i].key === key) return _CMP_METRICS[i];
  }
  return null;
}

// Expand the user-selected metric keys into chartable metric objects: the
// "interfaces" toggle becomes throughput + errors; everything else maps 1:1.
function _cmpChartableMetrics() {
  var out = [];
  _cmpPanel.metrics.forEach(function (k) {
    if (k === "interfaces") { _CMP_IFACE_SUBMETRICS.forEach(function (sm) { out.push(sm); }); }
    else { var m = _cmpMetric(k); if (m) out.push(m); }
  });
  return out;
}

// alias / aggregate annotation for one (asset, interface) row, shown in parens.
function _cmpIfaceAnnotation(row) {
  if (!row) return "";
  var bits = [];
  if (row.alias && String(row.alias).trim() && row.alias !== row.ifName) bits.push("alias: " + row.alias);
  if (row.ifParent && row.ifParent !== row.ifName) {
    bits.push((row.ifType === "vlan" ? "VLAN on " : "member of ") + row.ifParent);
  }
  return bits.length ? " (" + bits.join("; ") + ")" : "";
}

function _cmpIfaceRow(siMap, assetId, ifName) {
  var si = siMap[assetId];
  var rows = (si && si.interfaces) || [];
  for (var i = 0; i < rows.length; i++) if (rows[i].ifName === ifName) return rows[i];
  return null;
}

// Modal-scoped working state (asset list + lazily-fetched system-info cache).
var _cmpState = null;
// Open-panel state (assets, metrics, interfaces, layout, range, fetch cache).
var _cmpPanel = null;

function _cmpLabel(a) { return a.hostname || a.ipAddress || a.id; }

// ─── Metric picker modal ────────────────────────────────────────────────────

function openCompareModal() {
  var selected = (_assetsData || []).filter(function (a) { return _assetsSelected.has(a.id); });
  if (selected.length < 2) {
    showToast("Select at least two assets on this page to compare", "error");
    return;
  }
  var capped = false;
  if (selected.length > _CMP_MAX_ASSETS) { selected = selected.slice(0, _CMP_MAX_ASSETS); capped = true; }

  var metricRows = _CMP_METRICS.map(function (m) {
    var checked = (m.key === "response" || m.key === "cpu" || m.key === "memory") ? " checked" : "";
    return '<label style="display:flex;align-items:center;gap:8px;padding:3px 0">' +
      '<input type="checkbox" class="cmp-metric-cb" value="' + m.key + '"' + checked + '> ' +
      escapeHtml(m.label) +
      (m.perInterface ? ' <span style="font-size:0.75rem;color:var(--color-text-secondary)">(per interface)</span>' : '') +
      '</label>';
  }).join("");

  var assetList = selected.map(function (a) { return escapeHtml(_cmpLabel(a)); }).join(", ");

  var body =
    '<div style="display:flex;flex-direction:column;gap:1rem">' +
      '<div>' +
        '<div style="font-weight:600;margin-bottom:4px">Assets (' + selected.length + ')</div>' +
        '<div style="font-size:0.82rem;color:var(--color-text-secondary)">' + assetList + '</div>' +
        (capped ? '<div style="font-size:0.78rem;color:var(--color-warning,#e0a800);margin-top:4px">Comparing the first ' + _CMP_MAX_ASSETS + ' selected assets (capped for readability).</div>' : '') +
      '</div>' +
      '<div>' +
        '<div style="font-weight:600;margin-bottom:4px">Metrics</div>' +
        metricRows +
      '</div>' +
      '<div id="cmp-iface-section" style="display:none">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px">' +
          '<span style="font-weight:600">Interfaces</span>' +
          '<span style="display:flex;gap:6px">' +
            '<button type="button" class="btn btn-sm btn-secondary" id="cmp-iface-all">Select all</button>' +
            '<button type="button" class="btn btn-sm btn-secondary" id="cmp-iface-none">Deselect all</button>' +
          '</span>' +
        '</div>' +
        '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-bottom:6px">Only interfaces present on the selected assets are comparable — pick interface names shared across assets. Each interface lists its assets (alias / aggregate shown in parentheses) with recent average throughput so you can tell which carry traffic.</div>' +
        '<div id="cmp-iface-preview-slot" style="margin-bottom:6px"></div>' +
        '<div id="cmp-iface-list" style="display:flex;flex-direction:column;gap:6px;max-height:240px;overflow:auto">Loading interfaces…</div>' +
      '</div>' +
      '<div>' +
        '<div style="font-weight:600;margin-bottom:4px">Layout</div>' +
        '<label style="display:flex;align-items:center;gap:8px;padding:2px 0"><input type="radio" name="cmp-layout" value="perMetric" checked> One chart per metric (assets overlaid)</label>' +
        '<label style="display:flex;align-items:center;gap:8px;padding:2px 0"><input type="radio" name="cmp-layout" value="overlaid"> Overlaid (one chart per unit, all series together)</label>' +
      '</div>' +
    '</div>';

  var footer =
    '<button class="btn btn-secondary" id="cmp-cancel-btn">Cancel</button>' +
    '<button class="btn btn-primary" id="cmp-go-btn">Compare</button>';

  openModal("Compare Assets", body, footer);
  _cmpState = { assets: selected, si: {}, ifaceLoaded: false };

  document.getElementById("cmp-cancel-btn").addEventListener("click", closeModal);

  function syncIfaceSection() {
    var anyIf = Array.prototype.some.call(document.querySelectorAll(".cmp-metric-cb"), function (cb) {
      var m = _cmpMetric(cb.value);
      return cb.checked && m && m.perInterface;
    });
    var sec = document.getElementById("cmp-iface-section");
    if (sec) sec.style.display = anyIf ? "" : "none";
    if (anyIf && !_cmpState.ifaceLoaded) _cmpLoadInterfaceUnion();
  }
  document.querySelectorAll(".cmp-metric-cb").forEach(function (cb) {
    cb.addEventListener("change", syncIfaceSection);
  });

  document.getElementById("cmp-go-btn").addEventListener("click", function () {
    var metrics = Array.prototype.filter.call(document.querySelectorAll(".cmp-metric-cb"), function (cb) { return cb.checked; })
      .map(function (cb) { return cb.value; });
    if (!metrics.length) { showToast("Select at least one metric", "error"); return; }
    var layout = (document.querySelector('input[name="cmp-layout"]:checked') || {}).value || "perMetric";
    var interfaces = [];
    var needsIf = metrics.some(function (k) { var m = _cmpMetric(k); return m && m.perInterface; });
    if (needsIf) {
      interfaces = Array.prototype.filter.call(document.querySelectorAll(".cmp-iface-cb"), function (cb) { return cb.checked; })
        .map(function (cb) { return cb.value; });
      // Deselecting all interfaces is allowed — interface charts just won't
      // render. Only block when interfaces is the only thing to compare.
      var onlyIf = metrics.every(function (k) { var m = _cmpMetric(k); return m && m.perInterface; });
      if (!interfaces.length && onlyIf) {
        showToast("Select at least one interface, or pick another metric", "error");
        return;
      }
    }
    closeModal();
    openComparePanel({ assets: _cmpState.assets, metrics: metrics, interfaces: interfaces, layout: layout, si: _cmpState.si });
  });
}

// Fetch system-info for every asset missing from the cache (used for both the
// interface union and storage-mount resolution). Failures cache an empty object
// so a flaky asset doesn't block the rest.
async function _cmpEnsureSystemInfo(assets, cache) {
  var pending = assets.filter(function (a) { return !(a.id in cache); });
  await Promise.all(pending.map(function (a) {
    return api.assets.systemInfo(a.id)
      .then(function (si) { cache[a.id] = si || {}; })
      .catch(function () { cache[a.id] = {}; });
  }));
}

// Auto-fetch the usage preview when the (asset × interface) pair count is at or
// below this; above it, gate behind a button so opening the modal stays cheap
// at fleet scale.
var _CMP_IFACE_PREVIEW_CAP = 60;

async function _cmpLoadInterfaceUnion() {
  var listEl = document.getElementById("cmp-iface-list");
  if (!listEl) return;
  _cmpState.ifaceLoaded = true;
  listEl.textContent = "Loading interfaces…";
  try { await _cmpEnsureSystemInfo(_cmpState.assets, _cmpState.si); } catch (_) {}
  // Re-check: the modal may have been closed while we were fetching.
  listEl = document.getElementById("cmp-iface-list");
  if (!listEl) return;

  // Union of interface names → the assets that carry each.
  var byName = {};
  var order = [];
  _cmpState.assets.forEach(function (a) {
    var si = _cmpState.si[a.id];
    var ifaces = (si && si.interfaces) || [];
    var seen = {};
    ifaces.forEach(function (i) {
      var n = i && i.ifName;
      if (!n || seen[n]) return;
      seen[n] = 1;
      if (!byName[n]) { byName[n] = []; order.push(n); }
      byName[n].push(a);
    });
  });
  var total = _cmpState.assets.length;
  order.sort(function (a, b) {
    if (byName[b].length !== byName[a].length) return byName[b].length - byName[a].length;
    return a.localeCompare(b, undefined, { numeric: true });
  });
  if (!order.length) {
    listEl.innerHTML = '<span class="empty-state">No interfaces reported by the selected assets yet.</span>';
    return;
  }

  // Per-interface model with each asset's alias/aggregate annotation (from the
  // system-info already fetched — no extra calls).
  var ifaceData = order.map(function (n) {
    var perAsset = byName[n].map(function (a) {
      var row = _cmpIfaceRow(_cmpState.si, a.id, n);
      return { asset: a, row: row, annotation: _cmpIfaceAnnotation(row) };
    });
    return { name: n, perAsset: perAsset };
  });

  listEl.innerHTML = ifaceData.map(function (iface, i) {
    // Pre-check names present on every asset — those compare cleanly.
    var checked = iface.perAsset.length === total ? " checked" : "";
    var assetLines = iface.perAsset.map(function (pa, j) {
      return '<div style="display:flex;gap:6px;font-size:0.76rem;color:var(--color-text-secondary);padding-left:24px">' +
        '<span>' + escapeHtml(_cmpLabel(pa.asset)) + escapeHtml(pa.annotation) + '</span>' +
        '<span id="cmp-ifuse-' + i + '-' + j + '"></span>' +
        '</div>';
    }).join("");
    return '<div class="cmp-iface-item">' +
      '<label style="display:flex;align-items:center;gap:8px">' +
        '<input type="checkbox" class="cmp-iface-cb" value="' + escapeHtml(iface.name) + '"' + checked + '> ' +
        '<span class="mono" style="font-weight:600">' + escapeHtml(iface.name) + '</span> ' +
        '<span style="font-size:0.75rem;color:var(--color-text-secondary)">' + iface.perAsset.length + ' of ' + total + ' assets</span>' +
      '</label>' +
      assetLines +
    '</div>';
  }).join("");

  var allBtn = document.getElementById("cmp-iface-all");
  var noneBtn = document.getElementById("cmp-iface-none");
  if (allBtn) allBtn.onclick = function () { listEl.querySelectorAll(".cmp-iface-cb").forEach(function (cb) { cb.checked = true; }); };
  if (noneBtn) noneBtn.onclick = function () { listEl.querySelectorAll(".cmp-iface-cb").forEach(function (cb) { cb.checked = false; }); };

  // Usage preview — cheap when few pairs, button-gated otherwise.
  var pairs = ifaceData.reduce(function (acc, iface) { return acc + iface.perAsset.length; }, 0);
  var slot = document.getElementById("cmp-iface-preview-slot");
  if (slot) slot.innerHTML = "";
  if (pairs <= _CMP_IFACE_PREVIEW_CAP) {
    _cmpLoadIfaceUsage(ifaceData);
  } else if (slot) {
    slot.innerHTML = '<button type="button" class="btn btn-sm btn-secondary" id="cmp-iface-preview-btn">Load usage preview (' + pairs + ' interface readings)</button>';
    var pbtn = document.getElementById("cmp-iface-preview-btn");
    if (pbtn) pbtn.onclick = function () {
      pbtn.disabled = true; pbtn.textContent = "Loading usage…";
      _cmpLoadIfaceUsage(ifaceData).then(function () { if (slot) slot.innerHTML = ""; });
    };
  }
}

// Fill each per-asset sub-line with recent (1h) average throughput so the
// operator can tell which interfaces carry traffic. Down interfaces skip the
// fetch; failures / empty windows read "no data". Bounded by the caller.
async function _cmpLoadIfaceUsage(ifaceData) {
  var tasks = [];
  ifaceData.forEach(function (iface, i) {
    iface.perAsset.forEach(function (pa, j) {
      var span = document.getElementById("cmp-ifuse-" + i + "-" + j);
      if (span) span.textContent = "· …";
      var oper = pa.row && pa.row.operStatus;
      if (oper && String(oper).toLowerCase() !== "up") {
        if (span) span.textContent = "· down";
        return;
      }
      tasks.push(
        api.assets.interfaceHistory(pa.asset.id, iface.name, "1h").then(function (d) {
          var derived = _derivePerIntervalSeries((d && d.samples) || [], d);
          var sum = 0, n = 0;
          derived.forEach(function (x) {
            if (typeof x.inBps === "number" || typeof x.outBps === "number") { sum += (x.inBps || 0) + (x.outBps || 0); n++; }
          });
          var el = document.getElementById("cmp-ifuse-" + i + "-" + j);
          if (el) el.textContent = n ? "· " + _fmtBitsPerSec(sum / n) + " avg" : "· no data";
        }).catch(function () {
          var el = document.getElementById("cmp-ifuse-" + i + "-" + j);
          if (el) el.textContent = "· no data";
        })
      );
    });
  });
  await Promise.all(tasks);
}

// ─── Comparison slide-over ──────────────────────────────────────────────────

function _ensureComparePanelDOM() {
  if (document.getElementById("compare-panel-overlay")) return;
  var overlay = document.createElement("div");
  overlay.id = "compare-panel-overlay";
  overlay.className = "slideover-overlay";
  overlay.innerHTML =
    '<div class="slideover" id="compare-panel">' +
      '<div class="slideover-resize-handle"></div>' +
      '<div class="slideover-header">' +
        '<div class="slideover-header-top">' +
          '<h3 id="compare-panel-title">Compare Assets</h3>' +
          '<button class="btn-icon" id="compare-panel-close" title="Close">&times;</button>' +
        '</div>' +
        '<div class="slideover-meta" id="compare-panel-meta"></div>' +
      '</div>' +
      '<div class="slideover-body" id="compare-panel-body"></div>' +
      '<div class="slideover-footer" id="compare-panel-footer">' +
        '<button class="btn btn-sm btn-secondary" id="cmp-screenshot-btn">Screenshot</button>' +
        '<button class="btn btn-sm btn-secondary" id="cmp-pdf-btn">Export PDF</button>' +
        '<button class="btn btn-sm btn-secondary" id="cmp-close-btn" style="margin-left:auto">Close</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  overlay.addEventListener("click", function (e) { if (e.target === overlay) closeComparePanel(); });
  document.getElementById("compare-panel-close").addEventListener("click", closeComparePanel);
  document.getElementById("cmp-close-btn").addEventListener("click", closeComparePanel);
  document.getElementById("cmp-screenshot-btn").addEventListener("click", _cmpScreenshot);
  document.getElementById("cmp-pdf-btn").addEventListener("click", _cmpExportPdf);
  initSlideoverResize(document.getElementById("compare-panel"), "polaris.panel.width.compare");
}

function closeComparePanel() {
  var ov = document.getElementById("compare-panel-overlay");
  if (ov) ov.classList.remove("open");
}

async function openComparePanel(opts) {
  _ensureComparePanelDOM();
  _cmpPanel = {
    assets: opts.assets,
    metrics: opts.metrics,
    interfaces: opts.interfaces || [],
    layout: opts.layout,
    si: opts.si || {},
    colorByAsset: {},
    range: _getChartRangePref("assetCompare", "24h"),
    fetchCache: {},
  };
  opts.assets.forEach(function (a, i) { _cmpPanel.colorByAsset[a.id] = _CMP_COLORS[i % _CMP_COLORS.length]; });

  document.getElementById("compare-panel-title").textContent = "Compare Assets (" + opts.assets.length + ")";
  document.getElementById("compare-panel-meta").textContent =
    opts.assets.map(_cmpLabel).join(" · ");

  var rangeBtns = _chartRangeBtnsHTML("cmp-range-btn", [
    { value: "1h",  label: "1h" },
    { value: "12h", label: "12h" },
    { value: "24h", label: "24h" },
    { value: "7d",  label: "7d" },
    { value: "30d", label: "30d" },
    { value: "custom", label: "Custom…", id: "cmp-range-custom" },
  ], "assetCompare", "24h");
  var customPanel =
    '<div id="cmp-custom-panel" style="display:none;align-items:center;gap:6px;margin:0.5rem 0;padding:0.5rem;background:var(--color-bg-primary);border:1px solid var(--color-border);border-radius:6px;font-size:0.85rem">' +
      '<label style="display:flex;align-items:center;gap:4px">From <input type="datetime-local" id="cmp-custom-from" class="form-input" style="padding:2px 6px"></label>' +
      '<label style="display:flex;align-items:center;gap:4px">To <input type="datetime-local" id="cmp-custom-to" class="form-input" style="padding:2px 6px"></label>' +
      '<button class="btn btn-sm btn-primary" id="cmp-custom-apply">Apply</button>' +
    '</div>';

  var body = document.getElementById("compare-panel-body");
  body.innerHTML =
    '<div style="padding:1rem 1.25rem">' +
      '<div style="display:flex;align-items:center;justify-content:flex-end;gap:6px;margin-bottom:0.5rem;flex-wrap:wrap">' + rangeBtns + '</div>' +
      customPanel +
      '<div id="cmp-charts"></div>' +
    '</div>';

  revealOverlay(document.getElementById("compare-panel-overlay"));

  body.querySelectorAll(".cmp-range-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      var range = b.getAttribute("data-range");
      var panel = document.getElementById("cmp-custom-panel");
      if (range === "custom") {
        if (!panel) return;
        var willOpen = panel.style.display === "none";
        panel.style.display = willOpen ? "flex" : "none";
        if (willOpen) {
          var to = document.getElementById("cmp-custom-to");
          var from = document.getElementById("cmp-custom-from");
          if (to && !to.value) to.value = _toLocalDatetimeInput(new Date());
          if (from && !from.value) from.value = _toLocalDatetimeInput(new Date(Date.now() - 24 * 3600 * 1000));
        }
        return;
      }
      if (panel) panel.style.display = "none";
      body.querySelectorAll(".cmp-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      b.classList.remove("btn-secondary"); b.classList.add("btn-primary");
      _setChartRangePref("assetCompare", range);
      _cmpPanel.range = range;
      _cmpPanel.fetchCache = {};
      _cmpReload();
    });
  });
  var applyBtn = document.getElementById("cmp-custom-apply");
  if (applyBtn) {
    applyBtn.addEventListener("click", function () {
      var from = document.getElementById("cmp-custom-from");
      var to = document.getElementById("cmp-custom-to");
      if (!from.value || !to.value) { showToast("Enter both From and To", "error"); return; }
      var fromIso = new Date(from.value).toISOString();
      var toIso = new Date(to.value).toISOString();
      if (new Date(fromIso) >= new Date(toIso)) { showToast("From must be before To", "error"); return; }
      body.querySelectorAll(".cmp-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      var cb = document.getElementById("cmp-range-custom");
      if (cb) { cb.classList.remove("btn-secondary"); cb.classList.add("btn-primary"); }
      _cmpPanel.range = { from: fromIso, to: toIso };
      _cmpPanel.fetchCache = {};
      _cmpReload();
    });
  }

  // Storage-mount resolution + interface series both need system-info.
  var needsSi = _cmpPanel.metrics.some(function (k) {
    var m = _cmpMetric(k);
    return m && (m.needsStorage || m.perInterface);
  });
  if (needsSi) {
    try { await _cmpEnsureSystemInfo(_cmpPanel.assets, _cmpPanel.si); } catch (_) {}
  }
  _cmpReload();
}

function _cmpAssetHasIface(asset, ifName) {
  var si = _cmpPanel.si[asset.id];
  return !!(si && si.interfaces && si.interfaces.some(function (i) { return i.ifName === ifName; }));
}

// Largest mountpoint (by total bytes) for an asset — the representative volume
// for the scalar "Storage usage" stream. v1 compares the primary mount only.
function _cmpStorageMount(assetId) {
  var si = _cmpPanel.si[assetId];
  var rows = (si && si.storage) || [];
  var best = null;
  rows.forEach(function (r) {
    if (typeof r.totalBytes !== "number") return;
    if (!best || r.totalBytes > best.totalBytes) best = r;
  });
  return best ? best.mountPath : null;
}

function _cmpSeries(asset, metric, ctx, label, color) {
  return {
    assetId: asset.id,
    metricKey: metric.key,
    ifName: (ctx && ctx.ifName) || null,
    label: label,
    color: color,
  };
}

// Build the list of chart descriptors for the current layout. Each descriptor:
//   { title, unit, pct, series: [{assetId, metricKey, ifName, label, color}] }
function _cmpChartSpecs() {
  var p = _cmpPanel;
  var specs = [];

  if (p.layout === "overlaid") {
    // Group selected metrics by unit; one chart per unit, every (asset×metric)
    // [×interface] drawn as its own line. Colors cycle across the chart's series.
    var byUnit = {};
    var unitOrder = [];
    _cmpChartableMetrics().forEach(function (m) {
      if (!byUnit[m.unit]) { byUnit[m.unit] = []; unitOrder.push(m.unit); }
      byUnit[m.unit].push(m);
    });
    unitOrder.forEach(function (unit) {
      var metrics = byUnit[unit];
      var series = [];
      metrics.forEach(function (m) {
        if (m.perInterface) {
          p.interfaces.forEach(function (ifName) {
            p.assets.forEach(function (a) {
              if (!_cmpAssetHasIface(a, ifName)) return;
              series.push(_cmpSeries(a, m, { ifName: ifName }, _cmpLabel(a) + " " + m.label + " [" + ifName + "]", null));
            });
          });
        } else {
          p.assets.forEach(function (a) {
            series.push(_cmpSeries(a, m, {}, _cmpLabel(a) + " — " + m.label, null));
          });
        }
      });
      series.forEach(function (s, i) { s.color = _CMP_COLORS[i % _CMP_COLORS.length]; });
      if (series.length) specs.push({ title: _cmpUnitTitle(unit, metrics), unit: unit, pct: !!metrics[0].pct, series: series });
    });
    return specs;
  }

  // perMetric: one chart per metric (assets overlaid, colored by asset). Interface
  // metrics fan out to one chart per selected interface name.
  _cmpChartableMetrics().forEach(function (m) {
    if (m.perInterface) {
      p.interfaces.forEach(function (ifName) {
        var series = [];
        p.assets.forEach(function (a) {
          if (!_cmpAssetHasIface(a, ifName)) return;
          series.push(_cmpSeries(a, m, { ifName: ifName }, _cmpLabel(a), p.colorByAsset[a.id]));
        });
        if (series.length) specs.push({ title: m.label + " — " + ifName, unit: m.unit, pct: !!m.pct, series: series });
      });
    } else {
      var series2 = p.assets.map(function (a) {
        return _cmpSeries(a, m, {}, _cmpLabel(a), p.colorByAsset[a.id]);
      });
      specs.push({ title: m.label, unit: m.unit, pct: !!m.pct, series: series2 });
    }
  });
  return specs;
}

function _cmpUnitTitle(unit, metrics) {
  var labels = metrics.map(function (m) { return m.label; }).join(" / ");
  if (unit === "%") return labels + " (%)";
  if (unit === "ms") return "Response time (ms)";
  if (unit === "bps") return "Interface throughput";
  if (unit === "err") return "Interface errors";
  return labels;
}

function _cmpAxisLabel(unit) {
  if (unit === "%") return "Utilization (%)";
  if (unit === "ms") return "Response time (ms)";
  if (unit === "bps") return "Throughput (bps)";
  if (unit === "err") return "Errors / interval";
  return "";
}

function _cmpFmtY(v, unit) {
  if (unit === "%") return Math.round(v) + "%";
  if (unit === "bps") return _fmtBitsPerSec(v);
  return Math.round(v);
}

function _cmpFmtVal(v, unit) {
  if (unit === "%") return v.toFixed(1) + "%";
  if (unit === "ms") return Math.round(v) + " ms";
  if (unit === "bps") return _fmtBitsPerSec(v);
  return String(Math.round(v));
}

function _cmpMemPct(x) {
  if (typeof x.memPct === "number") return x.memPct;
  if (typeof x.memUsedBytes === "number" && typeof x.memTotalBytes === "number" && x.memTotalBytes > 0) {
    return (x.memUsedBytes / x.memTotalBytes) * 100;
  }
  return null;
}

function _cmpRangeKey() {
  var r = _cmpPanel.range;
  return (typeof r === "string") ? r : (r.from + "_" + r.to);
}

// Fetch (and cache, per range) one series → { points: [{t, v}], since, until }.
function _cmpFetchSeries(s) {
  var key = s.metricKey + "|" + s.assetId + "|" + (s.ifName || "") + "|" + _cmpRangeKey();
  if (!_cmpPanel.fetchCache[key]) _cmpPanel.fetchCache[key] = _cmpFetchSeriesRaw(s);
  return _cmpPanel.fetchCache[key];
}

function _cmpPack(data, pts) {
  return {
    // A failed poll has no value of its own — it plots at the baseline — so it
    // has to survive this filter on its `ok:false` flag rather than being
    // dropped as a non-numeric row. Everything else without a finite number is
    // junk and still goes.
    points: pts.filter(function (p) {
      return p.ok === false || (typeof p.v === "number" && isFinite(p.v));
    }),
    // Response-time failure windows for THIS asset over the same range, served
    // by the chart endpoints (services/probeOutageService.ts). The streams with
    // no success flag of their own dive across these. Per series, so one
    // asset's outage never pulls another asset's line to the baseline — which
    // is the trap a chart-wide union would have walked into, since a compare
    // chart co-plots different assets.
    outages: (data && data.outages) || [],
    since: data && data.since,
    until: data && data.until,
  };
}

async function _cmpFetchSeriesRaw(s) {
  var range = _cmpPanel.range;
  try {
    if (s.metricKey === "response") {
      var d = await api.assets.monitorHistory(s.assetId, range);
      return _cmpPack(d, (d.samples || []).map(function (x) {
        // Rollup tiers (hourly/daily, used by the wider ranges) carry
        // successCount + the bucket average in responseTimeMs and have no
        // per-sample `success`; detail tier carries `success`. Without the
        // tier check the response series vanished entirely on 7d/30d.
        //
        // Response time is the one metric here that carries its OWN failure
        // flag, so it marks failures directly rather than reading `outages`. A
        // partial-loss rollup bucket is NOT an outage — it still plots its
        // average.
        var rollup = typeof x.successCount === "number";
        var failed = rollup ? (x.sampleCount > 0 && x.successCount === 0) : !x.success;
        // A failure the upstream explains (dependency-suppressed at probe
        // time) dives grey instead of red — same shape, no accusation. On a
        // rollup bucket that means every failure in it was one.
        var dep = rollup
          ? (x.failureCount > 0 && (x.dependencyFailureCount || 0) >= x.failureCount)
          : x.dependencyDown === true;
        if (failed) return { t: x.timestamp, v: null, ok: false, dep: dep };
        var v = rollup
          ? (x.successCount > 0 && typeof x.responseTimeMs === "number" ? x.responseTimeMs : null)
          : ((x.success && typeof x.responseTimeMs === "number") ? x.responseTimeMs : null);
        return { t: x.timestamp, v: v };
      }));
    }
    if (s.metricKey === "cpu" || s.metricKey === "memory") {
      var t = await api.assets.telemetryHistory(s.assetId, range);
      return _cmpPack(t, (t.samples || []).map(function (x) {
        var v = s.metricKey === "cpu" ? (typeof x.cpuPct === "number" ? x.cpuPct : null) : _cmpMemPct(x);
        return { t: x.timestamp, v: v };
      }));
    }
    if (s.metricKey === "storage") {
      var mount = _cmpStorageMount(s.assetId);
      if (!mount) return { points: [], since: null, until: null };
      var st = await api.assets.storageHistory(s.assetId, mount, range);
      return _cmpPack(st, (st.samples || []).map(function (x) {
        var v = (x.totalBytes && x.usedBytes != null && x.totalBytes > 0) ? (x.usedBytes / x.totalBytes) * 100 : null;
        return { t: x.timestamp, v: v };
      }));
    }
    if (s.metricKey === "ifThroughput" || s.metricKey === "ifErrors") {
      var ih = await api.assets.interfaceHistory(s.assetId, s.ifName, range);
      var derived = _derivePerIntervalSeries(ih.samples || [], ih);
      var pts = derived.map(function (x) {
        var v;
        if (s.metricKey === "ifThroughput") {
          v = (typeof x.inBps === "number" || typeof x.outBps === "number") ? (x.inBps || 0) + (x.outBps || 0) : null;
        } else {
          v = (typeof x.inErr === "number" || typeof x.outErr === "number") ? (x.inErr || 0) + (x.outErr || 0) : null;
        }
        return { t: x.timestamp, v: v };
      });
      return _cmpPack(ih, pts);
    }
  } catch (err) {
    return { points: [], since: null, until: null, error: (err && err.message) || "failed" };
  }
  return { points: [], since: null, until: null };
}

// Fold each series' probe-outage windows into its own point list as valueless
// baseline points, so the render pass sees one uniform { t, v, ok } series.
//
// Called from _cmpReload once per load — deliberately NOT from
// _renderCompareChart, which re-runs on every resize observation and would
// append a duplicate set of markers each time.
//
// Response time is skipped: it carries an explicit per-sample flag and marked
// its own failures at fetch time.
function _cmpApplyOutageMarkers(series) {
  series.forEach(function (s) {
    if (s.metricKey === "response") return;
    if (!s.data || !s.data.points.length) return;
    // Idempotent per data object. `s.data` comes from _cmpPanel.fetchCache and
    // is shared by anything holding the same (metric, asset, ifName, range)
    // key, so a second pass over an already-marked series would append a
    // duplicate set of red dots. Today every _cmpReload caller clears the cache
    // first, which makes this belt-and-braces — but that is an invariant three
    // call sites away, and a future "re-render without refetch" path would
    // silently break it.
    if (s.data._outagesApplied) return;
    s.data._outagesApplied = true;
    var good = s.data.points
      .filter(function (p) { return p.ok !== false; })
      .map(function (p) { return +new Date(p.t); });
    _outageMarkers(s.data.outages, good).forEach(function (m) {
      s.data.points.push({ t: new Date(m.t).toISOString(), v: null, ok: false, dep: m.dep });
    });
  });
}

async function _cmpReload() {
  var chartsEl = document.getElementById("cmp-charts");
  if (!chartsEl) return;
  var specs = _cmpChartSpecs();
  if (!specs.length) {
    chartsEl.innerHTML = '<p class="empty-state">Nothing to compare.</p>';
    return;
  }
  // Skeleton cards first so the panel feels responsive while fetches run.
  chartsEl.innerHTML = specs.map(function (sp) {
    return '<div class="cmp-card" style="margin-bottom:1.25rem;background:var(--color-bg-primary);border:1px solid var(--color-border);border-radius:6px;padding:0.75rem">' +
      '<div style="font-weight:600;margin-bottom:0.25rem">' + escapeHtml(sp.title) + '</div>' +
      '<div class="cmp-legend" style="display:flex;flex-wrap:wrap;gap:0.4rem 1rem;font-size:0.78rem;margin-bottom:0.4rem"></div>' +
      '<div class="cmp-chart" style="min-height:220px;display:flex;align-items:center;justify-content:center;color:var(--color-text-secondary);font-size:0.85rem">Loading…</div>' +
    '</div>';
  }).join("");

  var cards = chartsEl.querySelectorAll(".cmp-card");
  await Promise.all(specs.map(function (sp, i) {
    return Promise.all(sp.series.map(function (s) {
      return _cmpFetchSeries(s).then(function (data) { s.data = data; });
    })).then(function () {
      var card = cards[i];
      if (!card) return;
      _cmpApplyOutageMarkers(sp.series);
      var legendEl = card.querySelector(".cmp-legend");
      legendEl.innerHTML = sp.series.map(function (s) {
        return '<span style="display:inline-flex;align-items:center;gap:4px">' +
          '<span style="width:12px;height:12px;border-radius:2px;background:' + s.color + ';display:inline-block"></span>' +
          escapeHtml(s.label) + '</span>';
      }).join("");
      var chartEl = card.querySelector(".cmp-chart");
      _renderCompareChart(chartEl, sp);
      _observeChartResize(chartEl, function (c) { _renderCompareChart(c, sp); });
    });
  }));
}

function _renderCompareChart(container, spec) {
  if (!container) return;
  var series = spec.series.filter(function (s) { return s.data && s.data.points && s.data.points.length; });
  if (!series.length) {
    container.style.display = "flex";
    container.textContent = "No samples in this range yet.";
    return;
  }
  var unit = spec.unit;
  var W = container.clientWidth || 600, H = 220;
  var padL = 64, padR = 12, padT = 14, padB = 30;
  var innerW = W - padL - padR, innerH = H - padT - padB;

  // Shared time bounds + global value extent across every series in the chart.
  var sinceVals = [], untilVals = [], boundsPts = [], yPeak = 0;
  series.forEach(function (s) {
    if (s.data.since != null) sinceVals.push(new Date(s.data.since).getTime());
    if (s.data.until != null) untilVals.push(new Date(s.data.until).getTime());
    s.data.points.forEach(function (p) {
      boundsPts.push({ timestamp: p.t });
      // Failures carry no value and plot at the baseline, so they must never
      // widen the axis. Explicit rather than relying on `null > yPeak` being
      // false by accident — those points reach this loop now.
      if (typeof p.v === "number" && isFinite(p.v) && p.v > yPeak) yPeak = p.v;
    });
  });
  var since = sinceVals.length ? Math.min.apply(null, sinceVals) : null;
  var until = untilVals.length ? Math.max.apply(null, untilVals) : null;
  var bounds = _chartTimeBounds(boundsPts, since, until);
  var t0 = bounds.t0, t1 = bounds.t1;
  var spanMs = t1 - t0, oneDayMs = 86400000;
  var pad2 = _chartPad2;

  var yMin = 0, yMax;
  if (spec.pct) { yMax = 100; }
  else { yMax = yPeak > 0 ? yPeak * 1.1 : 1; }

  var xFor = _chartXScale(padL, innerW, t0, t1);
  var yFor = _chartYScale(padT, innerH, yMin, yMax);

  var ticks = "";
  for (var i = 0; i <= 4; i++) {
    var tv = yMin + (yMax - yMin) * (i / 4);
    var ty = padT + innerH - (i / 4) * innerH;
    ticks +=
      '<line x1="' + padL + '" y1="' + ty + '" x2="' + (W - padR) + '" y2="' + ty + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (padL - 4) + '" y="' + (ty + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + _cmpFmtY(tv, unit) + '</text>';
  }
  var xTicks = _chartXTicksSVG(t0, t1, padL, padT, innerW, innerH);

  // clipId is built BEFORE the series loop because it seeds the per-render
  // gradient id prefix the failure-aware renderer needs — several cards share
  // the panel, and a colliding prefix would cross-wire their fade gradients.
  // The series index rides along too, since one chart holds several series.
  var clipId = _chartClipId("compare");
  var baselineY = padT + innerH;
  var polylines = "", dots = "", hits = "", failDefs = "";
  series.forEach(function (s, si) {
    var pts = s.data.points.slice().sort(function (a, b) { return new Date(a.t) - new Date(b.t); });
    // Failed polls sit at the baseline with no value of their own, so an outage
    // reads as the line diving to zero rather than a straight bridge over it.
    var plot = pts.map(function (p) {
      var ok = p.ok !== false;
      return { x: xFor(p.t), y: ok ? yFor(p.v) : baselineY, ok: ok, dep: p.dep === true, t: p.t, v: p.v };
    });
    var seg = _failureAwareSeriesSVG(plot, s.color, clipId + "-" + si);
    failDefs += seg.defs;
    polylines += seg.segments;
    // 2.5px dots for the failures (grey when dependency-explained); OK points
    // keep their 1.5px series dot.
    dots += _failureDotsSVG(plot);
    plot.forEach(function (p) {
      if (p.ok) {
        dots += '<circle cx="' + p.x + '" cy="' + p.y + '" r="1.5" fill="' + s.color + '"/>';
        hits += '<circle class="chart-hit" cx="' + p.x + '" cy="' + p.y + '" r="5" fill="transparent" style="cursor:crosshair"' +
          ' data-ts="' + escapeHtml(String(p.t)) + '"' +
          ' data-label="' + escapeHtml(s.label) + '"' +
          ' data-val="' + escapeHtml(_cmpFmtVal(p.v, unit)) + '"/>';
      } else {
        hits += '<circle class="chart-hit" cx="' + p.x + '" cy="' + p.y + '" r="5" fill="transparent" style="cursor:crosshair"' +
          ' data-ts="' + escapeHtml(String(p.t)) + '"' +
          ' data-label="' + escapeHtml(s.label) + '"' +
          ' data-failed="1"' + (p.dep ? ' data-dep="1"' : '') + '/>';
      }
    });
  });

  var yLabelX = 14, yLabelY = padT + innerH / 2;
  var yTitle = '<text class="chart-axis-title" x="' + yLabelX + '" y="' + yLabelY + '" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.85" transform="rotate(-90 ' + yLabelX + ' ' + yLabelY + ')">' + escapeHtml(_cmpAxisLabel(unit)) + '</text>';

  container.style.display = "block";
  container.innerHTML =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      _chartClipDefs(clipId, padL, padT, innerW, innerH) +
      // Fade gradients get their own <defs> next to the clip's. They must not
      // sit inside the clipped <g> that references them.
      (failDefs ? '<defs>' + failDefs + '</defs>' : '') +
      ticks + xTicks + yTitle +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      '<g ' + _chartClipAttr(clipId) + '>' + polylines + dots + hits + '</g>' +
    '</svg>' + CHART_TOOLTIP_HTML;
  container.style.position = "relative";

  _wireChartTooltip(container, function (target) {
    var head = '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(target.getAttribute("data-ts"))) + '</div>';
    if (target.getAttribute("data-failed")) {
      return head + (target.getAttribute("data-dep") === "1"
        ? '<div style="color:' + _CHART_DEP_COLOR + '">Dependency down — upstream device was down, not polled</div>'
        : '<div style="color:var(--color-danger,#d32f2f)">Missed poll — no data collected</div>');
    }
    return head +
      '<div>' + escapeHtml(target.getAttribute("data-label")) + ': ' + escapeHtml(target.getAttribute("data-val")) + '</div>';
  });
}

// ─── Screenshot + PDF export ────────────────────────────────────────────────

// Capture the comparison panel body to the clipboard as a PNG, mirroring the
// asset-details Screenshot (canonical 1100px width so the image is independent
// of the operator's drag-resized slide-over).
function _cmpScreenshot() {
  var panel = document.getElementById("compare-panel-body");
  var slideover = document.getElementById("compare-panel");
  if (!panel || typeof htmlToImage === "undefined") {
    showToast("Screenshot failed — capture library not loaded", "error");
    return;
  }
  var cs = getComputedStyle(document.documentElement);
  var bg = cs.getPropertyValue("--color-bg-primary").trim() || "#ffffff";
  var clrText = cs.getPropertyValue("--color-text-primary").trim() || "#111";
  var fontSans = cs.getPropertyValue("--font-sans").trim() || "system-ui,-apple-system,sans-serif";
  var btn = document.getElementById("cmp-screenshot-btn");
  if (btn) btn.disabled = true;

  var CAPTURE_WIDTH = 1100;
  var prevWidth = slideover ? slideover.style.width : "";
  if (slideover) slideover.style.width = CAPTURE_WIDTH + "px";
  panel.classList.add("screenshot-hide-scrollbars");
  function release() {
    panel.classList.remove("screenshot-hide-scrollbars");
    if (slideover) slideover.style.width = prevWidth;
  }
  function whenSettled(cb) {
    requestAnimationFrame(function () { requestAnimationFrame(function () { setTimeout(cb, 300); }); });
  }
  var scale = 2;
  whenSettled(function () {
    htmlToImage.toCanvas(panel, { pixelRatio: scale, backgroundColor: bg }).then(function (capture) {
      release();
      var pad = 24, titleH = 44;
      var w = capture.width / scale, h = capture.height / scale;
      var canvas = document.createElement("canvas");
      canvas.width = (w + pad * 2) * scale;
      canvas.height = (titleH + h + pad) * scale;
      var ctx = canvas.getContext("2d");
      ctx.scale(scale, scale);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w + pad * 2, titleH + h + pad);
      ctx.fillStyle = clrText;
      ctx.font = "bold 17px " + fontSans;
      ctx.fillText("Asset Comparison (" + _cmpPanel.assets.length + " assets)", pad, 30);
      ctx.drawImage(capture, pad, titleH, w, h);
      canvas.toBlob(function (blob) {
        if (btn) btn.disabled = false;
        if (!blob) { showToast("Screenshot failed", "error"); return; }
        copyPngToClipboard(blob).then(function (ok) {
          showToast(ok ? "Screenshot copied to clipboard" : "Screenshot failed — requires HTTPS or clipboard permission", ok ? "success" : "error");
        });
      }, "image/png");
    }).catch(function () {
      release();
      if (btn) btn.disabled = false;
      showToast("Screenshot failed", "error");
    });
  });
}

async function _cmpExportPdf() {
  await trackedPdfExport("Exporting comparison PDF", async function () {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      throw new Error("PDF library not loaded. Check your internet connection and reload the page.");
    }
    if (typeof htmlToImage === "undefined") throw new Error("Capture library not loaded.");
    var jsPDF = window.jspdf.jsPDF;
    var doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });
    var pageW = doc.internal.pageSize.getWidth();
    var pageH = doc.internal.pageSize.getHeight();
    var margin = 40;
    var now = new Date();
    var ts = now.toLocaleDateString() + " " + now.toLocaleTimeString();

    doc.setFontSize(16);
    doc.setTextColor(40, 40, 40);
    doc.text((_branding ? _branding.appName : "Polaris") + " — Asset Comparison", margin, 36);
    doc.setFontSize(9);
    doc.setTextColor(120, 120, 120);
    var rangeLabel = (typeof _cmpPanel.range === "string") ? _cmpPanel.range : "custom";
    doc.text("Generated: " + ts + "  |  Range: " + rangeLabel + "  |  Assets: " + _cmpPanel.assets.length, margin, 52);
    var assetLine = _cmpPanel.assets.map(_cmpLabel).join(", ");
    doc.setFontSize(8);
    var assetLines = doc.splitTextToSize(assetLine, pageW - margin * 2);
    doc.text(assetLines, margin, 66);

    var cards = document.querySelectorAll("#cmp-charts .cmp-card");
    if (!cards.length) { showToast("Nothing to export", "error"); return; }
    var bg = getComputedStyle(document.documentElement).getPropertyValue("--color-bg-primary").trim() || "#ffffff";
    var y = 66 + assetLines.length * 10 + 10;
    for (var i = 0; i < cards.length; i++) {
      var canvas = await htmlToImage.toCanvas(cards[i], { pixelRatio: 2, backgroundColor: bg });
      var imgW = pageW - margin * 2;
      var imgH = (canvas.height / canvas.width) * imgW;
      if (y + imgH > pageH - margin) { doc.addPage(); y = margin; }
      doc.addImage(canvas.toDataURL("image/png"), "PNG", margin, y, imgW, imgH);
      y += imgH + 16;
    }
    var filename = "polaris-asset-comparison-" + now.toISOString().slice(0, 10) + ".pdf";
    doc.save(filename);
    showToast("Exported comparison to " + filename);
  });
}
