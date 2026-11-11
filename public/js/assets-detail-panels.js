/**
 * public/js/assets-detail-panels.js — the nested detail slide-overs: a temperature sensor, an interface
 * page (throughput, errors, addresses, VLANs, LLDP, transceiver history —
 * business rule 143 — and its screenshot), and an IPsec tunnel.
 *
 * Part of the Assets page script (CQ-F050): plain browser scripts sharing
 * page globals, loaded right after assets.js on every page that carries it
 * and in app-panels.js's asset bundle, in ASSETS_FILES order. Nothing here
 * runs at load beyond listener wiring. See tests/unit/assetsSplit.test.ts.
 */

// ─── Per-sensor temperature slide-over ─────────────────────────────────────
//
// Sits on top of the asset details panel like the interface and IPsec slide-
// overs. One sensor per modal — the old shared chart was unreadable when a
// device exposed dozens of sensors.

function _ensureSensorPanelDOM() {
  if (document.getElementById("sensor-panel-overlay")) return;
  // Skeleton + backdrop / close / Escape / resize wiring: buildSlideover
  // (app.js). Stacks by DOM order like every slide-over — raiseSlideover on open.
  buildSlideover({
    id: "sensor-panel",
    overlayClass: "slideover-nested",
    panelStyle: "z-index:1100",
    title: "Sensor",
    bodyHTML: '<p class="empty-state" style="padding:1rem 1.25rem">Loading…</p>',
    footer: true,
    close: closeSensorPanel,
    resizeKey: "polaris.panel.width.sensor",
  });
}

function closeSensorPanel() {
  var ov = document.getElementById("sensor-panel-overlay");
  if (ov) ov.classList.remove("open");
  if (_sensorRefreshTimer) { clearTimeout(_sensorRefreshTimer); _sensorRefreshTimer = null; }
}

// The stored sensor name of a transceiver reading (business rule 143). Mirrors
// src/utils/sfpOptics.ts → sfpSensorName / SFP_ROLE_LABELS, which the collector
// writes; tests/unit/sfpOpticsUi.test.ts holds the two in step, because a
// mismatch opens an empty chart rather than failing.
var SFP_ROLE_LABELS = {
  temperature: "SFP temperature",
  voltage:     "SFP voltage",
  txPower:     "Tx power",
  rxPower:     "Rx power",
  bias:        "Bias current",
};
function _sfpSensorName(ifName, role) {
  return ifName + " " + SFP_ROLE_LABELS[role];
}

async function openSensorDetailPanel(asset, sensorName) {
  if (!asset || !sensorName) return;
  _ensureSensorPanelDOM();
  var titleEl  = document.getElementById("sensor-panel-title");
  var metaEl   = document.getElementById("sensor-panel-meta");
  var bodyEl   = document.getElementById("sensor-panel-body");
  var footerEl = document.getElementById("sensor-panel-footer");
  titleEl.textContent = "Sensor — " + sensorName;
  metaEl.textContent = asset.hostname || asset.ipAddress || asset.id;
  bodyEl.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">Loading…</p>';
  footerEl.innerHTML =
    '<button class="btn btn-sm btn-secondary" id="btn-sensor-panel-close-btn">Close</button>';
  raiseSlideover(document.getElementById("sensor-panel-overlay"));
  requestAnimationFrame(function () {
    document.getElementById("sensor-panel-overlay").classList.add("open");
  });
  document.getElementById("btn-sensor-panel-close-btn").addEventListener("click", closeSensorPanel);

  var rangeBtns = _chartRangeBtnsHTML("sensor-range-btn", [
    { value: "1h",  label: "1h" },
    { value: "12h", label: "12h" },
    { value: "24h", label: "24h" },
    { value: "7d",  label: "7d" },
    { value: "30d", label: "30d" },
    { value: "custom", label: "Custom…", id: "btn-sensor-custom" },
  ], "assetSensor", "1h");
  var customPanel =
    '<div id="sensor-custom-panel" style="display:none;align-items:center;gap:6px;margin:0.5rem 0;padding:0.5rem;background:var(--color-bg-primary);border:1px solid var(--color-border);border-radius:6px;font-size:0.85rem">' +
      '<label style="display:flex;align-items:center;gap:4px">From <input type="datetime-local" id="sensor-custom-from" class="form-input" style="padding:2px 6px"></label>' +
      '<label style="display:flex;align-items:center;gap:4px">To <input type="datetime-local" id="sensor-custom-to" class="form-input" style="padding:2px 6px"></label>' +
      '<button class="btn btn-sm btn-primary" id="btn-sensor-custom-apply">Apply</button>' +
    '</div>';

  // Hardware-sensor samples are written by the telemetry pass on the same
  // cadence as CPU/memory, so the section badge tracks the asset's resolved
  // telemetry polling method (matches the System tab Hardware Sensors section).
  var sensorBadge = _streamSourceBadgeHTML(asset, "telemetry");

  bodyEl.innerHTML =
    '<div style="padding:1rem 1.25rem">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">' +
        '<div style="display:flex;align-items:baseline;gap:0.5rem;flex-wrap:wrap">' +
          '<h4 style="margin:0">' + escapeHtml(sensorName) + '</h4>' +
          sensorBadge +
        '</div>' +
        '<div style="display:flex;gap:6px">' + rangeBtns + '</div>' +
      '</div>' +
      customPanel +
      '<div id="sensor-stats" style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">Loading…</div>' +
      '<div id="sensor-chart" class="sensor-chart-box"></div>' +
    '</div>';
  var box = document.getElementById("sensor-chart");
  if (box) {
    box.classList.add("chart-box");
    box.style.minHeight = "240px";
    box.style.display = "flex";
    box.style.alignItems = "center";
    box.style.justifyContent = "center";
    box.style.color = "var(--color-text-secondary)";
    box.style.fontSize = "0.85rem";
  }

  await _loadSensorHistoryFor(asset.id, sensorName, _getChartRangePref("assetSensor", "1h"));
  // Async overwrite the badge with the authoritative resolved polling method —
  // sync render only sees per-asset overrides; this catches class / integration
  // / manual tier values too.
  _updateStreamSourceBadgesFromEffective(asset.id, asset);
  document.querySelectorAll(".sensor-range-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      var range = b.getAttribute("data-range");
      var panel = document.getElementById("sensor-custom-panel");
      if (range === "custom") {
        if (!panel) return;
        var willOpen = panel.style.display === "none";
        panel.style.display = willOpen ? "flex" : "none";
        if (willOpen) {
          var toInput   = document.getElementById("sensor-custom-to");
          var fromInput = document.getElementById("sensor-custom-from");
          if (toInput && !toInput.value) toInput.value = _toLocalDatetimeInput(new Date());
          if (fromInput && !fromInput.value) fromInput.value = _toLocalDatetimeInput(new Date(Date.now() - 24 * 3600 * 1000));
        }
        return;
      }
      if (panel) panel.style.display = "none";
      document.querySelectorAll(".sensor-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      b.classList.remove("btn-secondary"); b.classList.add("btn-primary");
      _setChartRangePref("assetSensor", range);
      _loadSensorHistoryFor(asset.id, sensorName, range);
    });
  });
  var sensorCustomApply = document.getElementById("btn-sensor-custom-apply");
  if (sensorCustomApply) {
    sensorCustomApply.addEventListener("click", function () {
      var fromInput = document.getElementById("sensor-custom-from");
      var toInput   = document.getElementById("sensor-custom-to");
      if (!fromInput.value || !toInput.value) { showToast("Enter both From and To", "error"); return; }
      var fromIso = new Date(fromInput.value).toISOString();
      var toIso   = new Date(toInput.value).toISOString();
      if (new Date(fromIso) >= new Date(toIso)) { showToast("From must be before To", "error"); return; }
      document.querySelectorAll(".sensor-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      var customBtn = document.getElementById("btn-sensor-custom");
      if (customBtn) { customBtn.classList.remove("btn-secondary"); customBtn.classList.add("btn-primary"); }
      _loadSensorHistoryFor(asset.id, sensorName, { from: fromIso, to: toIso });
    });
  }
  // Drag-select on the chart applies the selection as the custom range.
  _wireChartDragSelect(document.getElementById("sensor-chart"), function (fromIso, toIso) {
    _applyCustomRangeSelection({
      btnClass: "sensor-range-btn", customBtnId: "btn-sensor-custom",
      panelId: "sensor-custom-panel", fromId: "sensor-custom-from", toId: "sensor-custom-to",
    }, fromIso, toIso);
    _loadSensorHistoryFor(asset.id, sensorName, { from: fromIso, to: toIso });
  });
}

async function _loadSensorHistoryFor(assetId, sensorName, range, callOpts) {
  // Cancel any pending auto-refresh — manual range change shouldn't race a tick.
  if (_sensorRefreshTimer) { clearTimeout(_sensorRefreshTimer); _sensorRefreshTimer = null; }
  var silent = !!(callOpts && callOpts.silent);
  var chartEl = document.getElementById("sensor-chart");
  var stats   = document.getElementById("sensor-stats");
  if (!chartEl) return;
  if (!silent) {
    chartEl.textContent = "Loading samples…";
    if (stats) stats.textContent = "Loading…";
  }
  var panelBody = silent ? document.getElementById("sensor-panel-body") : null;
  var savedScroll = panelBody ? panelBody.scrollTop : 0;
  // Accept range as a string or `{from, to}` object (canonical convention).
  var opts = (typeof range === "string" || !range) ? { range: range || "1h" } : range;
  opts.sensorName = sensorName;
  try {
    var data = await api.assets.hardwareHistory(assetId, opts);
    var samples = (data.samples || []).filter(function (s) { return typeof s.value === "number"; });
    var rawUnit = (samples[0] && samples[0].unit) || (data.samples && data.samples[0] && data.samples[0].unit) || "";
    // Display-only °F: convert the series, the stats, and the automation
    // thresholds together (they all arrive in °C) so the chart can't disagree
    // with itself. A fan/voltage sensor's series is left exactly as stored.
    var TU = window.PolarisTempUnit;
    var toF = !!(TU && TU.isFahrenheit() && TU.isCelsiusUnit(rawUnit));
    var unit = TU ? TU.displayUnit(rawUnit) : rawUnit;
    if (toF) {
      samples = samples.map(function (s) {
        var c = {}; for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) c[k] = s[k];
        c.value = TU.convertCelsius(s.value);
        // The rollup bucket's peak moves with its average, or the dashed max
        // line would sit on a °C scale over an °F axis.
        if (typeof s.maxValue === "number") c.maxValue = TU.convertCelsius(s.maxValue);
        return c;
      });
    }
    var conv = function (v) { return toF ? TU.convertCelsius(v) : v; };
    var unitSuffix = unit ? " " + unit : "";
    if (stats) {
      var st = data.stats || {};
      var sensorParts = [
        { label: "Avg", value: typeof st.avgValue === "number" ? _hwFmtNum(conv(st.avgValue)) + unitSuffix : "—" },
        { label: "Min", value: typeof st.minValue === "number" ? _hwFmtNum(conv(st.minValue)) + unitSuffix : "—" },
        { label: "Max", value: typeof st.maxValue === "number" ? _hwFmtNum(conv(st.maxValue)) + unitSuffix : "—" },
      ];
      var sensorTierPart = _tierStatsPart(data);
      if (sensorTierPart) sensorParts.unshift(sensorTierPart);
      _renderChartStats(stats, _inChartWindow(samples, data.since).length, sensorParts);
    }
    // Thresholds come from the engine in °C; shift them with the series or the
    // dashed reference lines would sit at the wrong height on an °F chart.
    var convTiers = function (tiers) {
      if (!toF || !tiers || !tiers.length) return tiers || [];
      return tiers.map(function (t) {
        var c = {}; for (var k in t) if (Object.prototype.hasOwnProperty.call(t, k)) c[k] = t[k];
        c.threshold = TU.convertCelsius(t.threshold);
        return c;
      });
    };
    var chartOpts = {
      since:   data.since,
      until:   data.until,
      subject: sensorName,
      unit:    unit,
      // Rollup tier → the dashed bucket-peak line (`maxValue`) + its chip.
      // Only this caller passes it; the process charts that share the
      // renderer draw no max.
      maxTier: _chartRollupTier(data),
      maxPrefKey: "assetSensor",
      tiers:   convTiers(_sensorSevTiers.key === assetId + "|" + sensorName ? _sensorSevTiers.tiers : []),
    };
    _renderSensorChart(chartEl, samples, chartOpts);
    // Severity tiers for THIS sensor (class included, so a temperature
    // automation can't shade a fan chart). Fetched once per sensor — thresholds
    // don't move with the time window — and applied by re-rendering, so the
    // chart never waits on the lookup.
    var sevKey = assetId + "|" + sensorName;
    if (_sensorSevTiers.key !== sevKey) {
      var sensorClass = (samples[0] && samples[0].sensorClass) ||
        (data.samples && data.samples[0] && data.samples[0].sensorClass) || "";
      _sensorSevTiers = { key: sevKey, tiers: [] };
      _loadMetricSeverityTiers(assetId, "hwSensorValue", { sensorName: sensorName, sensorClass: sensorClass })
        .then(function (tiers) {
          if (_sensorSevTiers.key !== sevKey || !tiers.length) return; // panel moved on / nothing watches it
          _sensorSevTiers = { key: sevKey, tiers: tiers };
          if (!document.getElementById("sensor-chart")) return;
          chartOpts.tiers = convTiers(tiers);
          _renderSensorChart(chartEl, samples, chartOpts);
        });
    }
    // Stash the active selection on the chart so silent ticks / probe-now
    // refetch the same view (canonical convention: polaris-ui-canon → "Time-series chart (SVG)").
    if (opts.from && opts.to) {
      chartEl.dataset.from = opts.from;
      chartEl.dataset.to   = opts.to;
      delete chartEl.dataset.range;
    } else {
      chartEl.dataset.range = opts.range || "1h";
      delete chartEl.dataset.from;
      delete chartEl.dataset.to;
    }
  } catch (err) {
    if (!silent) {
      chartEl.textContent = "Error: " + (err.message || "failed to load");
      if (stats) stats.textContent = "";
    }
    // Silent ticks leave stale content on transient errors.
  }
  if (panelBody) {
    panelBody.scrollTop = savedScroll;
    requestAnimationFrame(function () {
      if (panelBody.scrollTop !== savedScroll) panelBody.scrollTop = savedScroll;
    });
  }
  // Custom date ranges are fixed historical windows — do not auto-refresh.
  if (opts.from && opts.to) return;
  // Schedule next auto-refresh on the resolved telemetry cadence —
  // hardware-sensor samples ride the telemetry pass, not the response-time probe.
  var settings = _monitorSettingsCache || {};
  var asset = _currentAssetForRefresh;
  var ms = _refreshIntervalMs(asset && asset.cpuMemoryIntervalSec, settings.cpuMemoryIntervalSeconds, 60);
  _scheduleSensorRefresh(assetId, sensorName, ms);
}

function _hwFmtNum(v) {
  if (typeof v !== "number" || !isFinite(v)) return "—";
  var a = Math.abs(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10)  return v.toFixed(1);
  return v.toFixed(2);
}
function _renderSensorChart(container, samples, opts) {
  opts = opts || {};
  var unit = opts.unit || "";
  // Degree units hug the number ("41°C"); RPM / V get a space. Checking the
  // degree sign rather than "°C" exactly keeps °F (display-unit preference)
  // formatted the same way.
  var unitTickSuffix = unit ? (unit.charAt(0) === "°" ? unit : " " + unit) : "";
  if (samples.length === 0) {
    container.textContent = "No samples in this range yet.";
    return;
  }
  var W = container.clientWidth || 600, H = 240;
  // Extra left/bottom/top padding for the rotated Y-axis label, X-axis label, and chart title.
  var padL = 64, padR = 14, padT = 28, padB = 52;
  var innerW = W - padL - padR, innerH = H - padT - padB;

  var bounds = _chartTimeBounds(samples, opts.since, opts.until);
  var t0 = bounds.t0, t1 = bounds.t1;
  var spanMs = t1 - t0, oneDayMs = 86400000;
  var pad2 = _chartPad2;

  // Rollup tiers (opts.maxTier, set by the hardware-sensor loader only): each
  // bucket's peak (`maxValue`, already in the display unit) as a dashed line
  // under the average. While shown, the visible window's peaks join the
  // y-domain so the line is never clipped off the top; hidden, the axis fits
  // the averages alone.
  var maxTier = opts.maxPrefKey ? opts.maxTier || null : null;
  var showMax = !!maxTier && _getMaxLinePref(opts.maxPrefKey);
  function maxOf(s) { return typeof s.maxValue === "number" && isFinite(s.maxValue) ? s.maxValue : null; }
  var allC = samples.map(function (s) { return s.value; });
  if (showMax) {
    _inChartWindow(samples, opts.since).forEach(function (s) { var m = maxOf(s); if (m != null) allC.push(m); });
  }
  var minC = Math.min.apply(null, allC);
  var maxC = Math.max.apply(null, allC);
  if (minC === maxC) {
    // Flat series — give it a visible band proportional to the value's scale
    // (works for °C, RPM, V alike, unlike a fixed ±5° pad).
    var pad = Math.max(Math.abs(minC) * 0.05, 1);
    minC -= pad; maxC += pad;
  } else {
    var span = maxC - minC;
    minC -= span * 0.1; maxC += span * 0.1;
  }

  var xFor = _chartXScale(padL, innerW, t0, t1);
  var yFor = _chartYScale(padT, innerH, minC, maxC);

  var pts = samples.map(function (s) { return xFor(s.timestamp) + "," + yFor(s.value); }).join(" ");
  var hits = samples.map(function (s) {
    var m = maxOf(s);
    return '<circle class="chart-hit" cx="' + xFor(s.timestamp) + '" cy="' + yFor(s.value) + '" r="6" fill="transparent" style="cursor:crosshair"' +
      ' data-ts="' + escapeHtml(String(s.timestamp)) + '"' +
      ' data-c="' + s.value + '"' +
      (maxTier ? ' data-cmax="' + (m != null ? m : "") + '"' : '') + '/>';
  }).join("");

  var ticks = "";
  for (var i = 0; i <= 4; i++) {
    var v = minC + (maxC - minC) * (i / 4);
    var y = padT + innerH - (i / 4) * innerH;
    ticks +=
      '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + _hwFmtNum(v) + unitTickSuffix + '</text>';
  }
  var xTicks = _chartXTicksSVG(t0, t1, padL, padT, innerW, innerH);

  var titleY = 14;
  var xLabelY = padT + innerH + 38;
  var yLabelX = 14;
  var yLabelY = padT + innerH / 2;
  var labels =
    '<text x="' + (W / 2) + '" y="' + titleY + '" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">' +
      escapeHtml(opts.subject || "Temperature") +
    '</text>' +
    '<text class="chart-axis-title" x="' + (padL + innerW / 2) + '" y="' + xLabelY + '" text-anchor="middle" font-size="11" fill="currentColor">Time</text>' +
    '<text class="chart-axis-title" x="' + yLabelX + '" y="' + yLabelY + '" text-anchor="middle" font-size="11" fill="currentColor"' +
      ' transform="rotate(-90 ' + yLabelX + ' ' + yLabelY + ')">' + escapeHtml(unit ? "Reading (" + unit + ")" : "Reading") + '</text>';

  var clipId = _chartClipId("sensor");
  // Severity shading: the line fades into warning/serious/critical wherever the
  // reading enters a tier of an automation that watches THIS sensor on THIS
  // asset (opts.tiers, from GET /assets/:id/metric-thresholds). Falls back to the
  // flat accent stroke when nothing watches it.
  var sev = _severityChartLayer("sensor", opts.tiers, minC, maxC, {
    padL: padL, padT: padT, innerW: innerW, innerH: innerH, W: W, padR: padR, yFor: yFor, unit: unit,
  });
  // The max line takes the same stroke as the average — the severity gradient
  // when an automation watches the sensor (it is in user space, so a peak that
  // climbs into a tier is coloured by that tier), the accent otherwise.
  var maxSvg = showMax
    ? _maxLineSVG(samples.map(function (s) {
        var m = maxOf(s);
        return m == null ? null : { x: xFor(s.timestamp), y: yFor(m) };
      }), sev.stroke)
    : "";
  container.innerHTML =
    (maxTier ? _maxLineLegendRowHTML(opts.maxPrefKey, maxTier, sev.stroke) : "") +
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      _chartClipDefs(clipId, padL, padT, innerW, innerH) +
      sev.defs +
      labels + ticks + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      _maintenanceBandLayer(t0, t1, padL, padT, innerW, innerH) +
      '<g ' + _chartClipAttr(clipId) + '>' +
        sev.lines +
        maxSvg +
        '<polyline points="' + pts + '" fill="none" stroke="' + sev.stroke + '" stroke-width="1.5"/>' +
        samples.map(function (s) { return '<circle cx="' + xFor(s.timestamp) + '" cy="' + yFor(s.value) + '" r="1.5" fill="' + sev.stroke + '"/>'; }).join("") +
        hits +
      '</g>' +
      sev.labels +
    '</svg>' + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";

  _stashChartGeometry(container, t0, t1, padL, innerW, W);
  if (maxTier) _wireMaxLineChip(container, opts.maxPrefKey, function () { _renderSensorChart(container, samples, opts); });
  _wireChartTooltip(container, function (target) {
    var c = Number(target.getAttribute("data-c"));
    var cmax = target.getAttribute("data-cmax");
    var sfx = unit ? " " + unit : "";
    return '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(target.getAttribute("data-ts"))) + '</div>' +
      '<div>' + (cmax != null
        ? _avgMaxText(_hwFmtNum(c) + sfx, cmax !== "" ? _hwFmtNum(Number(cmax)) + sfx : null)
        : _hwFmtNum(c) + sfx) + '</div>';
  });
  _addChartScreenshotButton(container, opts.subject || "Sensor", { yAxis: (unit ? "Reading (" + unit + ")" : "Reading"), subject: opts.subject, getStats: _statsSummaryFrom("sensor-stats") });
  _observeChartResize(container, function (c) { _renderSensorChart(c, samples, opts); });
}

// api.js formatBytes with this table's em-dash for missing values kept.
function _fmtBytes(n) {
  if (n == null || isNaN(n)) return "—";
  return formatBytes(n);
}

// Captures the interface slide-over (title + asset + resolved comment + both
// charts) as a single PNG and copies it to the clipboard. The per-chart
// camera buttons still exist; this gives one composite for sharing the full
// interface view.
function _screenshotInterfacePanel(asset, ifName) {
  var tputContainer = document.getElementById("iface-tput-chart");
  var errContainer  = document.getElementById("iface-err-chart");
  if (!tputContainer || !errContainer) {
    showToast("Nothing to screenshot", "error");
    return;
  }

  var titleEl = document.getElementById("iface-panel-title");
  var titleText = titleEl ? titleEl.textContent : ("Interface — " + ifName);
  var assetName = asset ? (asset.hostname || asset.dnsName || asset.ipAddress || asset.id || "") : "";
  // Concatenate the throughput + error stats lines so the screenshot
  // captures both. Prefer the dataset.summary plaintext form (set by
  // _renderChartStats) so the screenshot composer doesn't have to parse
  // bold spans out of textContent.
  var tputStatsEl = document.getElementById("iface-tput-stats");
  var errStatsEl  = document.getElementById("iface-err-stats");
  function _ifaceStatsText(el) {
    if (!el) return "";
    var s = (el.dataset && el.dataset.summary) || el.textContent || "";
    s = s.trim();
    return s === "Loading…" ? "" : s;
  }
  var tputStatsText = _ifaceStatsText(tputStatsEl);
  var errStatsText  = _ifaceStatsText(errStatsEl);
  // Prepend the From/To so the composite screenshot states the window it
  // captured — the x-axis ticks alone carry no date.
  var rangeText = _chartRangeLabel(tputContainer);
  var statsText = [rangeText, tputStatsText, errStatsText].filter(Boolean).join(" · ");

  // Resolved comment: textarea value if non-empty (covers in-progress edits and
  // saved overrides), else the discovered FortiOS CMDB description.
  var commentInput = document.getElementById("iface-comment-input");
  var commentText = "";
  if (commentInput && commentInput.value && commentInput.value.trim()) {
    commentText = commentInput.value.trim();
  } else if (_ifaceCommentState && _ifaceCommentState.discoveredDescription) {
    commentText = _ifaceCommentState.discoveredDescription;
  }

  _rasterizeChartSvgToImage(tputContainer, function (tput) {
    _rasterizeChartSvgToImage(errContainer, function (errs) {
      if (!tput && !errs) { showToast("Screenshot failed", "error"); return; }
      _composeInterfaceScreenshot({
        title: titleText,
        asset: assetName,
        comment: commentText,
        stats: statsText,
        tput: tput,
        errs: errs,
      });
    });
  });
}

function _composeInterfaceScreenshot(parts) {
  var cs = getComputedStyle(document.documentElement);
  var bgPrimary = cs.getPropertyValue("--color-bg-primary").trim() || "#ffffff";
  var clrText   = cs.getPropertyValue("--color-text-primary").trim() || "#111111";
  var clrSec    = cs.getPropertyValue("--color-text-secondary").trim() || "#666666";

  var scale = 2;
  var pad = 20;
  var fontFamily = "system-ui, -apple-system, 'Segoe UI', sans-serif";

  var chartW = Math.max(parts.tput ? parts.tput.width : 0, parts.errs ? parts.errs.width : 0);
  if (!chartW) chartW = 600;
  var canvasW = chartW + pad * 2;
  var maxLineW = canvasW - pad * 2;

  // Greedy whitespace wrap; long unbreakable tokens get truncated to fit.
  var tmp = document.createElement("canvas").getContext("2d");
  function wrap(font, text) {
    if (!text) return [];
    tmp.font = font;
    var words = String(text).split(/\s+/);
    var lines = [], cur = "";
    for (var i = 0; i < words.length; i++) {
      var trial = cur ? cur + " " + words[i] : words[i];
      if (tmp.measureText(trial).width <= maxLineW) cur = trial;
      else { if (cur) lines.push(cur); cur = words[i]; }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  var titleFont   = "600 16px " + fontFamily;
  var assetFont   = "13px " + fontFamily;
  var statsFont   = "11px " + fontFamily;
  var labelFont   = "600 11px " + fontFamily;
  var commentFont = "13px " + fontFamily;

  var titleLines   = wrap(titleFont, parts.title);
  var assetLines   = wrap(assetFont, parts.asset);
  var statsLines   = wrap(statsFont, parts.stats);
  var commentLines = wrap(commentFont, parts.comment);

  var titleLineH = 22, assetLineH = 18, statsLineH = 16, commentLineH = 18;
  var sectionGap = 14, chartGap = 14;

  var totalH = pad
    + titleLines.length * titleLineH
    + (assetLines.length ? 2 + assetLines.length * assetLineH : 0)
    + (statsLines.length ? 4 + statsLines.length * statsLineH : 0)
    + (commentLines.length ? sectionGap + 16 + commentLines.length * commentLineH : 0)
    + (parts.tput ? sectionGap + parts.tput.height : 0)
    + (parts.errs ? chartGap   + parts.errs.height : 0)
    + pad;

  var canvas = document.createElement("canvas");
  canvas.width  = canvasW * scale;
  canvas.height = totalH * scale;
  var ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.fillStyle = bgPrimary;
  ctx.fillRect(0, 0, canvasW, totalH);
  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  var y = pad;
  ctx.fillStyle = clrText;
  ctx.font = titleFont;
  titleLines.forEach(function (l) { ctx.fillText(l, pad, y); y += titleLineH; });

  if (assetLines.length) {
    y += 2;
    ctx.fillStyle = clrSec;
    ctx.font = assetFont;
    assetLines.forEach(function (l) { ctx.fillText(l, pad, y); y += assetLineH; });
  }

  if (statsLines.length) {
    y += 4;
    ctx.fillStyle = clrSec;
    ctx.font = statsFont;
    statsLines.forEach(function (l) { ctx.fillText(l, pad, y); y += statsLineH; });
  }

  if (commentLines.length) {
    y += sectionGap;
    ctx.fillStyle = clrSec;
    ctx.font = labelFont;
    ctx.fillText("INTERFACE COMMENTS", pad, y);
    y += 16;
    ctx.fillStyle = clrText;
    ctx.font = commentFont;
    commentLines.forEach(function (l) { ctx.fillText(l, pad, y); y += commentLineH; });
  }

  if (parts.tput) {
    y += sectionGap;
    ctx.drawImage(parts.tput.img, pad + (chartW - parts.tput.width) / 2, y, parts.tput.width, parts.tput.height);
    y += parts.tput.height;
    URL.revokeObjectURL(parts.tput.url);
  }
  if (parts.errs) {
    y += chartGap;
    ctx.drawImage(parts.errs.img, pad + (chartW - parts.errs.width) / 2, y, parts.errs.width, parts.errs.height);
    y += parts.errs.height;
    URL.revokeObjectURL(parts.errs.url);
  }

  canvas.toBlob(function (blob) {
    if (!blob) { showToast("Screenshot failed", "error"); return; }
    copyPngToClipboard(blob).then(function (ok) {
      showToast(ok ? "Interface screenshot copied to clipboard" : "Screenshot failed — requires HTTPS or clipboard permission", ok ? "success" : "error");
    });
  }, "image/png");
}

// ─── Interface page of the asset panel ─────────────────────────────────────
//
// Clicking an interface on the System tab loads it INSIDE the asset details
// slide-over, in place of the tabs, as its own back/forward entry
// (_assetHistoryOpenIface) — the header's ‹ (or Alt+Left, or Escape) returns to
// the asset with its tab and scroll position intact. It used to be a nested
// slide-over stacked on top. Its elements (#iface-panel-title / -meta / -body /
// -footer) are built by _ensureAssetPanelDOM; _showAssetPanelView switches
// which page shows. Two charts — throughput and errors — each reusing
// _wireChartTooltip so hover behaviour matches the response-time chart.

/**
 * Notice shown above the charts when this interface is NOT pinned for
 * fast-cadence polling.
 *
 * History is recorded only for pinned interfaces, so an unpinned one charts
 * nothing. Without this the operator sees two empty graphs and no reason —
 * indistinguishable from a broken panel. The fix is one checkbox away, so say
 * so and name where it is.
 */
function _ifaceUnpinnedNoticeHTML(asset, ifName) {
  var pinned = new Set((asset && asset.monitoredInterfaces) || []);
  if (pinned.has(ifName)) return "";
  return (
    '<div class="hint" style="margin:0 0 0.75rem 0;padding:0.5rem 0.65rem;background:var(--color-bg-primary);' +
      'border:1px solid var(--color-border);border-left:3px solid var(--color-warning, #d08540);border-radius:6px;font-size:0.8rem">' +
      '<strong>Not recording history.</strong> Current state above is live, but throughput and error history ' +
      'is kept only for interfaces selected for fast-cadence polling. Tick <strong>Poll&nbsp;1m</strong> for ' +
      escapeHtml(ifName) + ' on the System tab to start collecting it.' +
    '</div>'
  );
}

// The current-state row the open interface panel was opened from — the
// history loader's address line compares the window's addresses against it.
var _ifacePanelRow = null;

// opts.walk — set by _assetPanelGo when a back/forward press lands here, so the
// visit isn't pushed again.
async function openInterfaceDetailPanel(asset, ifName, ifaceRow, opts) {
  if (!asset || !ifName) return;
  opts = opts || {};
  _ifacePanelRow = ifaceRow || null;
  _ensureAssetPanelDOM();
  _clearIfaceRefreshTimer();
  if (!opts.walk) {
    if (_assetPanelHistory.entries.length === 0) _assetPanelHistory = _assetHistoryOpen(_assetPanelHistory, asset.id, true);
    _assetPanelHistory = _assetHistoryOpenIface(_assetPanelHistory, asset.id, ifName, ifaceRow);
  }
  _renderAssetPanelNav();
  if (opts.walk) _focusAssetPanelNav(opts.walk);
  var titleEl  = document.getElementById("iface-panel-title");
  var metaEl   = document.getElementById("iface-panel-meta");
  var bodyEl   = document.getElementById("iface-panel-body");
  var footerEl = document.getElementById("iface-panel-footer");
  // Title shows whatever label we already know from the system-info row, if any.
  // The interface-history response will refine it once the request lands —
  // operator-set alias overrides ifName, with the real ifName kept as subtitle.
  titleEl.textContent = "Interface — " + ifName;
  metaEl.textContent = asset.hostname || asset.ipAddress || asset.id;
  bodyEl.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">Loading…</p>';
  footerEl.innerHTML =
    '<button class="btn btn-sm btn-secondary" id="btn-iface-panel-screenshot">Screenshot</button>' +
    '<span style="flex:1"></span>' +
    '<button class="btn btn-sm btn-secondary" id="btn-iface-panel-close-btn">Close</button>';
  _showAssetPanelView("iface");
  bodyEl.scrollTop = 0;
  document.getElementById("btn-iface-panel-close-btn").addEventListener("click", closeAssetPanel);
  document.getElementById("btn-iface-panel-screenshot").addEventListener("click", function () {
    _screenshotInterfacePanel(asset, ifName);
  });

  var rangeBtns = _chartRangeBtnsHTML("iface-range-btn", [
    { value: "1h",  label: "1h" },
    { value: "12h", label: "12h" },
    { value: "24h", label: "24h" },
    { value: "7d",  label: "7d" },
    { value: "30d", label: "30d" },
    { value: "custom", label: "Custom…", id: "btn-iface-custom" },
  ], "assetInterface", "1h");
  var ifaceCustomPanel =
    '<div id="iface-custom-panel" style="display:none;align-items:center;gap:6px;margin:0.5rem 0;padding:0.5rem;background:var(--color-bg-primary);border:1px solid var(--color-border);border-radius:6px;font-size:0.85rem">' +
      '<label style="display:flex;align-items:center;gap:4px">From <input type="datetime-local" id="iface-custom-from" class="form-input" style="padding:2px 6px"></label>' +
      '<label style="display:flex;align-items:center;gap:4px">To <input type="datetime-local" id="iface-custom-to" class="form-input" style="padding:2px 6px"></label>' +
      '<button class="btn btn-sm btn-primary" id="btn-iface-custom-apply">Apply</button>' +
    '</div>';

  var canEditComment = _canEditAsset(asset);
  bodyEl.innerHTML =
    '<div style="padding:1rem 1.25rem">' +
      '<div id="iface-comment-block" style="margin-bottom:0.75rem">' +
        '<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:0.25rem">' +
          '<label for="iface-comment-input" style="font-size:0.8rem;font-weight:600;color:var(--color-text-secondary)">Interface Comments</label>' +
          '<span id="iface-comment-count" style="font-size:0.75rem;color:var(--color-text-secondary)"></span>' +
        '</div>' +
        '<textarea id="iface-comment-input" rows="2" maxlength="255" placeholder="' +
          (canEditComment ? 'Add a comment for this interface (max 255 chars). Polaris-local — not pushed to the device.' : 'Read-only — requires Assets Admin to edit.') +
          '" style="width:100%;box-sizing:border-box;padding:0.4rem 0.5rem;font-size:0.85rem;font-family:inherit;background:var(--color-bg-primary);border:1px solid var(--color-border);border-radius:6px;color:var(--color-text-primary);resize:vertical"' +
          (canEditComment ? '' : ' disabled') +
          '></textarea>' +
        '<div id="iface-comment-source" style="margin-top:0.25rem;font-size:0.75rem;color:var(--color-text-secondary)"></div>' +
        (canEditComment
          ? '<div style="display:flex;justify-content:flex-end;gap:6px;margin-top:0.4rem">' +
              '<button class="btn btn-sm btn-secondary" id="btn-iface-comment-revert" disabled>Revert</button>' +
              '<button class="btn btn-sm btn-primary" id="btn-iface-comment-save" disabled>Save</button>' +
            '</div>'
          : '') +
      '</div>' +
      '<div id="iface-tags-block" style="margin-bottom:0.75rem">' + _ifaceTagsBlockHTML(ifaceRow, canEditComment && canManageTags()) + '</div>' +
      _ifaceAddressBlockHTML(ifaceRow) +
      _ifaceVlanBlockHTML(ifaceRow, _assetVlanNames[asset.id]) +
      '<div id="iface-lldp-block" style="margin-bottom:0.75rem"></div>' +
      _ifaceUnpinnedNoticeHTML(asset, ifName) +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">' +
        '<div style="display:flex;align-items:baseline;gap:0.5rem;flex-wrap:wrap">' +
          '<h4 style="margin:0">Throughput &amp; errors</h4>' +
          _streamSourceBadgeHTML(asset, "interfaces") +
        '</div>' +
        '<div style="display:flex;gap:6px">' + rangeBtns + '</div>' +
      '</div>' +
      ifaceCustomPanel +
      '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">Throughput</h5>' +
      '<div id="iface-tput-stats" style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">Loading…</div>' +
      '<div id="iface-tput-chart" class="iface-chart-box"></div>' +
      '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">Errors per second (in / out)</h5>' +
      '<div id="iface-err-stats" style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">Loading…</div>' +
      '<div id="iface-err-chart" class="iface-chart-box"></div>' +
      // A fibre-channel port's own counters (rule 159a); shown once the port
      // is known to be FC — its WWN, its logins, or a sample carrying them.
      '<div id="iface-fc-block" style="display:' + (ifaceRow && (ifaceRow.wwn || ifaceRow.fc) ? "block" : "none") + '">' +
        '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">FC errors per minute</h5>' +
        '<div id="iface-fc-stats" style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">Loading…</div>' +
        '<div id="iface-fc-chart" class="iface-chart-box"></div>' +
        '<p class="hint" style="margin:0.25rem 0 0">The switch\'s counters, as their increase per minute. A minute in which they were cleared on the switch shows no bar.</p>' +
      '</div>' +
      _ifaceOpticsBlockHTML(asset, ifName, ifaceRow) +
    '</div>';
  document.querySelectorAll(".iface-chart-box").forEach(function (el) {
    el.classList.add("chart-box");
    el.style.minHeight = "180px";
    el.style.display = "flex";
    el.style.alignItems = "center";
    el.style.justifyContent = "center";
    el.style.color = "var(--color-text-secondary)";
    el.style.fontSize = "0.85rem";
  });

  // Interface tags (business rule 133). The saved list is written back onto
  // the row object the Interfaces table rendered from, so the table shows it
  // on its next rebuild without another fetch.
  function wireIfaceTagsEdit() {
    var btn = document.getElementById("btn-iface-tags-edit");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var row = _ifacePanelRow || { ifName: ifName, tags: [] };
      _openInterfaceTagsModal(asset, ifName, row, function (tags) {
        row.tags = tags;
        _ifacePanelRow = row;
        var block = document.getElementById("iface-tags-block");
        if (block) block.innerHTML = _ifaceTagsBlockHTML(row, canEditComment && canManageTags());
        wireIfaceTagsEdit();
      });
    });
  }
  wireIfaceTagsEdit();

  await _loadInterfaceHistoryFor(asset.id, ifName, _getChartRangePref("assetInterface", "1h"));
  // Async overwrite the badge with the authoritative resolved polling method.
  _updateStreamSourceBadgesFromEffective(asset.id, asset);
  document.querySelectorAll(".iface-range-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      var range = b.getAttribute("data-range");
      var panel = document.getElementById("iface-custom-panel");
      if (range === "custom") {
        if (!panel) return;
        var willOpen = panel.style.display === "none";
        panel.style.display = willOpen ? "flex" : "none";
        if (willOpen) {
          var toInput   = document.getElementById("iface-custom-to");
          var fromInput = document.getElementById("iface-custom-from");
          if (toInput && !toInput.value) toInput.value = _toLocalDatetimeInput(new Date());
          if (fromInput && !fromInput.value) fromInput.value = _toLocalDatetimeInput(new Date(Date.now() - 24 * 3600 * 1000));
        }
        return;
      }
      if (panel) panel.style.display = "none";
      document.querySelectorAll(".iface-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      b.classList.remove("btn-secondary"); b.classList.add("btn-primary");
      _setChartRangePref("assetInterface", range);
      _loadInterfaceHistoryFor(asset.id, ifName, range);
    });
  });
  var ifaceCustomApply = document.getElementById("btn-iface-custom-apply");
  if (ifaceCustomApply) {
    ifaceCustomApply.addEventListener("click", function () {
      var fromInput = document.getElementById("iface-custom-from");
      var toInput   = document.getElementById("iface-custom-to");
      if (!fromInput.value || !toInput.value) { showToast("Enter both From and To", "error"); return; }
      var fromIso = new Date(fromInput.value).toISOString();
      var toIso   = new Date(toInput.value).toISOString();
      if (new Date(fromIso) >= new Date(toIso)) { showToast("From must be before To", "error"); return; }
      document.querySelectorAll(".iface-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      var customBtn = document.getElementById("btn-iface-custom");
      if (customBtn) { customBtn.classList.remove("btn-secondary"); customBtn.classList.add("btn-primary"); }
      _loadInterfaceHistoryFor(asset.id, ifName, { from: fromIso, to: toIso });
    });
  }
  // The temperature / voltage / bias links under the optics charts open that
  // reading's own history, as the Interfaces table cells do.
  var opticsBlock = document.getElementById("iface-optics-block");
  if (opticsBlock) {
    opticsBlock.addEventListener("click", function (e) {
      var a = e.target.closest(".iface-optic-link");
      if (!a) return;
      e.preventDefault();
      openSensorDetailPanel(asset, a.getAttribute("data-sensor"));
    });
  }
  // Drag-select on any chart applies the selection as the custom range.
  ["iface-tput-chart", "iface-err-chart", "iface-fc-chart", "iface-rx-chart", "iface-tx-chart"].forEach(function (cid) {
    _wireChartDragSelect(document.getElementById(cid), function (fromIso, toIso) {
      _applyCustomRangeSelection({
        btnClass: "iface-range-btn", customBtnId: "btn-iface-custom",
        panelId: "iface-custom-panel", fromId: "iface-custom-from", toId: "iface-custom-to",
      }, fromIso, toIso);
      _loadInterfaceHistoryFor(asset.id, ifName, { from: fromIso, to: toIso });
    });
  });
}

async function _loadInterfaceHistoryFor(assetId, ifName, range, callOpts) {
  // Cancel any pending auto-refresh — manual range change shouldn't race a tick.
  if (_ifaceRefreshTimer) { clearTimeout(_ifaceRefreshTimer); _ifaceRefreshTimer = null; }
  var silent = !!(callOpts && callOpts.silent);
  var tputEl = document.getElementById("iface-tput-chart");
  var errEl = document.getElementById("iface-err-chart");
  var tputStats = document.getElementById("iface-tput-stats");
  var errStats  = document.getElementById("iface-err-stats");
  if (!tputEl) return;
  if (!silent) {
    tputEl.textContent = errEl.textContent = "Loading samples…";
    if (tputStats) tputStats.textContent = "Loading…";
    if (errStats)  errStats.textContent  = "Loading…";
  }
  var panelBody = silent ? document.getElementById("iface-panel-body") : null;
  var savedScroll = panelBody ? panelBody.scrollTop : 0;
  // Accept range as a string or `{from, to}` object (canonical convention).
  var opts = (typeof range === "string" || !range) ? { range: range || "1h" } : range;
  try {
    // The bands of every automation that reads this port (rule 159a), fetched
    // beside the history; a failure is no shading, never no chart.
    var tierMetrics = ["ifInErrorRate", "ifOutErrorRate"].concat(_FC_CHART_METRICS);
    var fetched = await Promise.all([
      api.assets.interfaceHistory(assetId, ifName, opts),
      _loadIfaceSeverityTiers(assetId, ifName, _ifacePanelRow && _ifacePanelRow.alias, tierMetrics).catch(function () { return {}; }),
    ]);
    var data = fetched[0];
    var ifaceTiers = fetched[1] || {};
    var derived = _derivePerIntervalSeries(data.samples || [], data);
    var visRaw = _inChartWindow(data.samples, data.since);
    var visDerived = _inChartWindow(derived, data.since);
    _renderIfaceThroughputStats(tputStats, visRaw, visDerived, data);
    _renderIfaceErrorStats(errStats, visRaw, visDerived, data);
    // Refine the title now that we know the alias; show the operator comment
    // when present.
    var titleEl = document.getElementById("iface-panel-title");
    if (titleEl) {
      titleEl.textContent = "Interface — " + (data.alias && data.alias.trim() ? data.alias.trim() + " (" + ifName + ")" : ifName);
    }
    _populateInterfaceCommentEditor(assetId, ifName, data, { silent: silent });
    _renderIfaceLldpBlock(data.lldpNeighbors || []);
    _renderIfaceAddressHistory(visRaw, _ifacePanelRow);
    var ifaceOpts = { since: data.since, until: data.until, subject: ifName, outages: data.outages, maxTier: _chartRollupTier(data), tiers: ifaceTiers };
    _renderIfaceThroughputChart(tputEl, derived, ifaceOpts);
    _renderIfaceErrorChart(errEl, derived, ifaceOpts);
    var fcBlock = document.getElementById("iface-fc-block");
    var fcEl = document.getElementById("iface-fc-chart");
    if (fcBlock && fcEl) {
      var isFc = derived.some(function (d) { return !!d.fc; }) ||
        !!(_ifacePanelRow && (_ifacePanelRow.wwn || _ifacePanelRow.fc));
      fcBlock.style.display = isFc ? "block" : "none";
      if (isFc) {
        _renderIfaceFcStats(document.getElementById("iface-fc-stats"), visRaw, visDerived);
        _renderIfaceFcChart(fcEl, derived, ifaceOpts);
      }
    }
    // Stash the active selection on each chart container so silent ticks /
    // probe-now refetch the same view (canonical convention).
    if (opts.from && opts.to) {
      tputEl.dataset.from = errEl.dataset.from = opts.from;
      tputEl.dataset.to   = errEl.dataset.to   = opts.to;
      delete tputEl.dataset.range; delete errEl.dataset.range;
    } else {
      tputEl.dataset.range = errEl.dataset.range = opts.range || "1h";
      delete tputEl.dataset.from; delete errEl.dataset.from;
      delete tputEl.dataset.to;   delete errEl.dataset.to;
    }
  } catch (err) {
    if (!silent) {
      tputEl.textContent = errEl.textContent = "Error: " + (err.message || "failed to load");
      if (tputStats) tputStats.textContent = "";
      if (errStats)  errStats.textContent  = "";
    }
    // Silent ticks leave stale content in place on transient errors.
  }
  // The optics charts load on their own: a failed sensor read must not blank
  // the throughput charts above, nor the other way round.
  await _loadIfaceOpticsHistory(assetId, ifName, opts, silent);
  if (panelBody) {
    panelBody.scrollTop = savedScroll;
    requestAnimationFrame(function () {
      if (panelBody.scrollTop !== savedScroll) panelBody.scrollTop = savedScroll;
    });
  }
  // Custom date ranges are fixed historical windows — do not auto-refresh.
  if (opts.from && opts.to) return;
  // Schedule next auto-refresh on the response-time cadence — pinned interfaces
  // ride that cadence on the backend (collectInterfacesFiltered).
  var settings = _monitorSettingsCache || {};
  var asset = _currentAssetForRefresh;
  var ms = _refreshIntervalMs(asset && asset.monitorIntervalSec, settings.intervalSeconds, 60);
  _scheduleIfaceRefresh(assetId, ifName, ms);
}

// ─── Transceiver history on the interface page (business rule 143) ─────────
// Rx and Tx power for an SFP port, charted from the hardware-sensor samples the
// collector wrote under the port's name. Drawn only when the port carries
// optics. They follow the page's range buttons. The temperature, voltage and
// bias readings are linked rather than charted here, each opening its own
// history in the sensor slide-over. Optics history records whether or not the
// interface is pinned: it rides the hardware-sensor stream, not the interface
// one.
function _ifaceOpticsBlockHTML(asset, ifName, ifaceRow) {
  if (!ifaceRow || !ifaceRow.optics) return "";
  function link(role, label) {
    return '<a href="#" class="iface-optic-link" data-sensor="' + escapeHtml(_sfpSensorName(ifName, role)) + '">' + label + '</a>';
  }
  return '<div id="iface-optics-block" style="margin-top:1.25rem">' +
    '<div style="display:flex;align-items:baseline;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.25rem">' +
      '<h4 style="margin:0">Optical power</h4>' +
      _streamSourceBadgeHTML(asset, "telemetry") +
    '</div>' +
    '<div style="font-size:0.8rem;color:var(--color-text-secondary);margin-bottom:0.25rem">Transceiver history: ' +
      link("temperature", "Temperature") + ' · ' + link("voltage", "Voltage") + ' · ' + link("bias", "Bias current") +
    '</div>' +
    '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">Rx power</h5>' +
    '<div id="iface-rx-stats" style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">Loading…</div>' +
    '<div id="iface-rx-chart" class="iface-chart-box"></div>' +
    '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">Tx power</h5>' +
    '<div id="iface-tx-stats" style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">Loading…</div>' +
    '<div id="iface-tx-chart" class="iface-chart-box"></div>' +
  '</div>';
}

async function _loadIfaceOpticsHistory(assetId, ifName, opts, silent) {
  var series = [
    { role: "rxPower", chart: "iface-rx-chart", stats: "iface-rx-stats" },
    { role: "txPower", chart: "iface-tx-chart", stats: "iface-tx-stats" },
  ].filter(function (s) { return document.getElementById(s.chart); });
  if (series.length === 0) return;
  await Promise.all(series.map(async function (s) {
    var chartEl = document.getElementById(s.chart);
    var statsEl = document.getElementById(s.stats);
    var sensorName = _sfpSensorName(ifName, s.role);
    if (!silent) chartEl.textContent = "Loading samples…";
    // A fresh options object: the history client must not see (or leave) a
    // sensorName on the interface page's own range options.
    var q = opts.from && opts.to ? { from: opts.from, to: opts.to } : { range: opts.range || "1h" };
    q.sensorName = sensorName;
    try {
      var data = await api.assets.hardwareHistory(assetId, q);
      var samples = (data.samples || []).filter(function (x) { return typeof x.value === "number"; });
      if (statsEl) {
        var st = data.stats || {};
        var fmt = function (v) { return typeof v === "number" ? v.toFixed(2) + " dBm" : "—"; };
        var parts = [
          { label: "Avg", value: fmt(st.avgValue) },
          { label: "Min", value: fmt(st.minValue) },
          { label: "Max", value: fmt(st.maxValue) },
        ];
        var tierPart = _tierStatsPart(data);
        if (tierPart) parts.unshift(tierPart);
        _renderChartStats(statsEl, _inChartWindow(samples, data.since).length, parts);
      }
      if (samples.length === 0) {
        chartEl.textContent = "No readings in this window.";
      } else {
        _renderSensorChart(chartEl, samples, {
          since: data.since, until: data.until, subject: ifName + " " + SFP_ROLE_LABELS[s.role],
          unit: "dBm", maxTier: _chartRollupTier(data), maxPrefKey: "assetSensor",
        });
      }
      if (opts.from && opts.to) { chartEl.dataset.from = opts.from; chartEl.dataset.to = opts.to; delete chartEl.dataset.range; }
      else { chartEl.dataset.range = opts.range || "1h"; delete chartEl.dataset.from; delete chartEl.dataset.to; }
    } catch (err) {
      if (!silent) {
        chartEl.textContent = "Error: " + (err.message || "failed to load");
        if (statsEl) statsEl.textContent = "";
      }
    }
  }));
}

// Per-panel state for the Interface Comments editor. Tracks the saved value
// so we can detect dirty edits, and the discovered description so the source
// label below the textarea reflects whether the override is hiding a CMDB
// description. Cleared on every panel open.
var _ifaceCommentState = null;

function _populateInterfaceCommentEditor(assetId, ifName, data, opts) {
  var input = document.getElementById("iface-comment-input");
  if (!input) return;
  var countEl  = document.getElementById("iface-comment-count");
  var saveBtn  = document.getElementById("btn-iface-comment-save");
  var revertBtn = document.getElementById("btn-iface-comment-revert");
  var silent = !!(opts && opts.silent);

  var savedValue = (data && typeof data.overrideDescription === "string")
    ? data.overrideDescription
    : (data && typeof data.description === "string" && data.overrideDescription == null
        ? "" /* discovered-only, override is empty */
        : "");
  var discoveredDescription = (data && data.discoveredDescription) || "";
  // Description-sync context from the interface-history response: when the
  // originating integration syncs descriptions (Polaris-primary), the copy
  // below flips from "Polaris-local" to "synced to device" and a per-row
  // status line (synced/failed) renders under the editor.
  var descriptionSync = (data && data.descriptionSync) || { enabled: false, status: null, lastSyncAt: null, error: null };

  // Don't clobber in-progress typing on auto-refresh ticks. Range changes
  // (silent=false) always re-populate so the user sees the latest value.
  var stateMatches = _ifaceCommentState
    && _ifaceCommentState.assetId === assetId
    && _ifaceCommentState.ifName === ifName;
  var isDirty = stateMatches && _ifaceCommentState.dirty;

  if (silent && isDirty) {
    // Refresh the discovered description hint silently; leave input alone.
    _ifaceCommentState.savedValue = savedValue;
    _ifaceCommentState.discoveredDescription = discoveredDescription;
    _renderIfaceCommentSource(_ifaceCommentState);
    return;
  }

  _ifaceCommentState = {
    assetId: assetId,
    ifName: ifName,
    savedValue: savedValue,
    discoveredDescription: discoveredDescription,
    descriptionSync: descriptionSync,
    dirty: false,
  };
  input.value = savedValue;
  // Show the device-reported description as ghost text when no override is
  // set, so the operator can see what's currently being shown in lists
  // before deciding to type over it.
  if (!input.disabled) {
    input.placeholder = discoveredDescription
      ? "Device says: " + discoveredDescription
      : (descriptionSync.enabled
          ? "Add a comment for this interface (max 255 chars). Synced to the device — Polaris is primary."
          : "Add a comment for this interface (max 255 chars). Polaris-local — not pushed to the device.");
  }
  if (countEl) countEl.textContent = input.value.length + " / 255";
  if (saveBtn) saveBtn.disabled = true;
  if (revertBtn) revertBtn.disabled = true;
  _renderIfaceCommentSource(_ifaceCommentState);

  if (!input._ifaceCommentWired) {
    input._ifaceCommentWired = true;
    input.addEventListener("input", function () {
      if (!_ifaceCommentState) return;
      _ifaceCommentState.dirty = input.value !== _ifaceCommentState.savedValue;
      if (countEl) countEl.textContent = input.value.length + " / 255";
      if (saveBtn) saveBtn.disabled = !_ifaceCommentState.dirty;
      if (revertBtn) revertBtn.disabled = !_ifaceCommentState.dirty;
    });
    if (saveBtn) {
      saveBtn.addEventListener("click", _saveIfaceComment);
    }
    if (revertBtn) {
      revertBtn.addEventListener("click", function () {
        if (!_ifaceCommentState) return;
        input.value = _ifaceCommentState.savedValue;
        _ifaceCommentState.dirty = false;
        if (countEl) countEl.textContent = input.value.length + " / 255";
        if (saveBtn) saveBtn.disabled = true;
        if (revertBtn) revertBtn.disabled = true;
        _renderIfaceCommentSource(_ifaceCommentState);
      });
    }
  }
}

function _renderIfaceCommentSource(state) {
  var sourceEl = document.getElementById("iface-comment-source");
  if (!sourceEl || !state) return;
  var sync = state.descriptionSync || { enabled: false, status: null, lastSyncAt: null, error: null };
  if (state.savedValue) {
    if (sync.enabled) {
      // Synced mode: the comment is pushed to the device (Polaris-primary),
      // so surface the per-row push status instead of the local-only copy.
      if (sync.status === "failed") {
        sourceEl.textContent = "Sync to device failed" + (sync.error ? ": " + sync.error : "") + " — retries on the next discovery cycle.";
      } else if (sync.status === "conflict") {
        sourceEl.textContent = "Sync conflict — this comment and the device were both edited since the last sync. Neither was overwritten; save to push your value and resolve.";
      } else if (sync.status === "synced") {
        sourceEl.textContent = "Synced to device" + (sync.lastSyncAt ? " " + timeAgo(sync.lastSyncAt) : "") + " — Polaris is primary.";
      } else {
        sourceEl.textContent = "Will sync to the device on save — Polaris is primary.";
      }
    } else if (state.discoveredDescription && state.discoveredDescription !== state.savedValue) {
      sourceEl.textContent = "Override active. Device reports: " + state.discoveredDescription;
    } else {
      sourceEl.textContent = "Polaris-local override (not pushed to device).";
    }
  } else if (state.discoveredDescription) {
    sourceEl.textContent = sync.enabled
      ? "Showing device-reported description. Type here to set it from Polaris (synced to the device)."
      : "Showing device-reported description. Type here to override (Polaris-local only).";
  } else {
    sourceEl.textContent = "No comment set on this interface.";
  }
}

async function _saveIfaceComment() {
  if (!_ifaceCommentState) return;
  var input = document.getElementById("iface-comment-input");
  var saveBtn = document.getElementById("btn-iface-comment-save");
  var revertBtn = document.getElementById("btn-iface-comment-revert");
  if (!input) return;
  var value = input.value;
  if (value.length > 255) {
    showToast("Interface Comments must be 255 characters or fewer", "error");
    return;
  }
  var assetId = _ifaceCommentState.assetId;
  var ifName  = _ifaceCommentState.ifName;
  var prevDisabled = saveBtn ? saveBtn.disabled : false;
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }
  try {
    var resp = await api.assets.setInterfaceComment(assetId, ifName, value);
    var newSaved = (resp && typeof resp.description === "string") ? resp.description : (value.trim() ? value : "");
    if (_ifaceCommentState && _ifaceCommentState.assetId === assetId && _ifaceCommentState.ifName === ifName) {
      _ifaceCommentState.savedValue = newSaved;
      _ifaceCommentState.dirty = input.value !== newSaved;
      input.value = newSaved;
      if (revertBtn) revertBtn.disabled = !_ifaceCommentState.dirty;
      // Fold the save-time push outcome into the status line (description
      // sync — Polaris-primary; `sync.attempted` is false when the toggle is
      // off or the comment was cleared).
      var syncResp = resp && resp.sync;
      if (syncResp && syncResp.attempted && _ifaceCommentState.descriptionSync) {
        _ifaceCommentState.descriptionSync.status = syncResp.status || null;
        _ifaceCommentState.descriptionSync.lastSyncAt = new Date().toISOString();
        _ifaceCommentState.descriptionSync.error = syncResp.error || null;
      }
      _renderIfaceCommentSource(_ifaceCommentState);
    }
    var syncOutcome = resp && resp.sync;
    if (syncOutcome && syncOutcome.attempted && syncOutcome.status === "failed") {
      showToast("Comment saved in Polaris, but the device push failed — it will retry on the next discovery cycle", "error");
    } else if (syncOutcome && syncOutcome.attempted) {
      showToast("Interface comment saved and pushed to device", "success");
    } else {
      showToast("Interface comment saved", "success");
    }
  } catch (err) {
    showToast("Save failed: " + (err && err.message ? err.message : "unknown error"), "error");
  } finally {
    if (saveBtn) { saveBtn.textContent = "Save"; saveBtn.disabled = _ifaceCommentState ? !_ifaceCommentState.dirty : prevDisabled; }
  }
}

// Convert per-bucket counter endpoints (rollup tier) or cumulative
// octet/error counters (detail tier) into the {timestamp, inBps, outBps,
// inErr, outErr} shape the throughput + error charts consume.
//
// Detail tier (`bucketSeconds === 0` or absent): diff each pair of
// consecutive samples; negative deltas (counter wraps / device reboots)
// are dropped, matching the long-standing detail-tier behavior.
//
// Rollup tier (`bucketSeconds > 0`): the server already pre-computed
// `*BytesPerSec` / `*ErrorsPerSec` from the bucket's first/last counter
// values. We emit one derived point per rollup row — no diff. Bits/sec
// charts multiply bytes-per-sec by 8. The error-count series multiplies
// errors-per-sec by `bucketSeconds` so each derived point shows "errors
// in this bucket" — same semantic as detail tier's "errors in this
// interval", just at a coarser granularity.
function _derivePerIntervalSeries(samples, data) {
  return PolarisChartShared.derivePerIntervalSeries(samples, data);
}

function _renderIfaceThroughputStats(container, rawSamples, derived, data) {
  if (!container) return;
  var inMax = 0, outMax = 0, inSum = 0, outSum = 0, inN = 0, outN = 0;
  derived.forEach(function (d) {
    if (typeof d.inBps  === "number") { inSum  += d.inBps;  inN++;  if (d.inBps  > inMax)  inMax  = d.inBps; }
    if (typeof d.outBps === "number") { outSum += d.outBps; outN++; if (d.outBps > outMax) outMax = d.outBps; }
  });
  var ifaceTputParts = [
    { label: "In avg",   value: _fmtBitsPerSec(inN  ? inSum  / inN  : 0) },
    { label: "In peak",  value: _fmtBitsPerSec(inMax) },
    { label: "Out avg",  value: _fmtBitsPerSec(outN ? outSum / outN : 0) },
    { label: "Out peak", value: _fmtBitsPerSec(outMax) },
  ];
  var ifaceTputTierPart = _tierStatsPart(data);
  if (ifaceTputTierPart) ifaceTputParts.unshift(ifaceTputTierPart);
  _renderChartStats(container, rawSamples.length, ifaceTputParts);
}

function _renderIfaceErrorStats(container, rawSamples, derived, data) {
  if (!container) return;
  var errIn = 0, errOut = 0;
  derived.forEach(function (d) {
    if (typeof d.inErr  === "number") errIn  += d.inErr;
    if (typeof d.outErr === "number") errOut += d.outErr;
  });
  var ifaceErrParts = [
    { label: "In errors",  value: String(errIn) },
    { label: "Out errors", value: String(errOut) },
    { label: "Total",      value: String(errIn + errOut) },
  ];
  var ifaceErrTierPart = _tierStatsPart(data);
  if (ifaceErrTierPart) ifaceErrParts.unshift(ifaceErrTierPart);
  _renderChartStats(container, rawSamples.length, ifaceErrParts);
}

// Render the LLDP neighbor card inside the interface slide-over. Empty when
// the interface has no neighbors. When the neighbor's chassis/management info
// resolves to an existing Polaris asset, the system-name link opens that
// asset's view modal so the operator can pivot from one device to the next.
// VLAN summary card for the interface slide-over. Renders only when the
// passed-in row carries nativeVlan or taggedVlans (i.e. managed FortiSwitch
// ports overlaid from the parent FortiGate's CMDB). Other asset types and
// SNMP-only paths on non-Fortinet switches return empty markup so the
// surrounding layout stays unchanged.
// The interface's addresses, IPv4 and IPv6 (business rule 126), as the
// current-state row has them. `_renderIfaceAddressHistory` adds what the
// history window saw once the samples land. Always rendered — an interface
// with no address says so — so the history half has a place to write.
function _ifaceAddressBlockHTML(iface) {
  var v4 = (iface && iface.ipAddress) || "";
  var v6 = (iface && iface.ipv6Address) || "";
  function line(label, value) {
    return '<div><span style="font-size:0.75rem;color:var(--color-text-secondary);display:inline-block;min-width:3.2rem">' + label + '</span> ' +
      '<span class="mono" style="margin-left:6px">' + (value ? escapeHtml(value) : "—") + '</span></div>';
  }
  return '<div id="iface-addr-block" style="margin-bottom:0.75rem;padding:0.5rem 0.65rem;background:var(--color-bg-primary);border:1px solid var(--color-border);border-radius:6px">' +
    '<div style="font-size:0.8rem;font-weight:600;color:var(--color-text-secondary);margin-bottom:0.25rem">Addresses</div>' +
    line("IPv4", v4) + ((typeof polarisIpv6Enabled !== "undefined" && polarisIpv6Enabled === true) ? line("IPv6", v6) : "") +
    '<div id="iface-addr-history" style="margin-top:0.25rem;font-size:0.75rem;color:var(--color-text-secondary)"></div>' +
  '</div>';
}

// Pure: every distinct address (either family) the window's samples carried,
// oldest first, minus the current ones — a renumbered port or a rotated IPv6
// is visible without reading the samples.
function _ifaceAddressesSeen(samples, current) {
  var skip = {};
  (current || []).forEach(function (a) { if (a) skip[a] = true; });
  var seen = {}, out = [];
  (samples || []).forEach(function (s) {
    [s && s.ipAddress, s && s.ipv6Address].forEach(function (a) {
      if (!a || skip[a] || seen[a]) return;
      seen[a] = true;
      out.push(a);
    });
  });
  return out;
}

function _renderIfaceAddressHistory(samples, ifaceRow) {
  var el = document.getElementById("iface-addr-history");
  if (!el) return;
  var v6On = typeof polarisIpv6Enabled !== "undefined" && polarisIpv6Enabled === true;
  var others = _ifaceAddressesSeen(samples, [ifaceRow && ifaceRow.ipAddress, ifaceRow && ifaceRow.ipv6Address])
    .filter(function (a) { return v6On || a.indexOf(":") === -1; }); // rule 128
  el.innerHTML = others.length
    ? 'Also held in this range: <span class="mono">' + others.map(escapeHtml).join(", ") + '</span>'
    : "";
}

function _ifaceVlanBlockHTML(iface, names) {
  if (!iface) return "";
  var native = (iface.nativeVlan != null) ? iface.nativeVlan : null;
  var tagged = Array.isArray(iface.taggedVlans) ? iface.taggedVlans : [];
  var trunkAll = iface.trunksAllVlans === true;
  if (native == null && tagged.length === 0 && !trunkAll) return "";
  // Role pill: trunk-all wins over explicit-list trunk wins over access.
  // Operationally these are three distinct states and the badge must show
  // which one without forcing the operator to read the body of the card.
  var role = trunkAll ? "Trunk (all)" : (tagged.length === 0 ? "Access" : "Trunk");
  var nativeBit = native != null
    ? '<div><span style="font-size:0.75rem;color:var(--color-text-secondary)">Native VLAN</span> ' +
        '<span style="margin-left:6px">' + _vlanPillHTML(native, names) + '</span></div>'
    : "";
  var taggedBit;
  if (trunkAll) {
    taggedBit = '<div style="margin-top:0.25rem"><span style="font-size:0.75rem;color:var(--color-text-secondary)">Allowed VLANs</span> ' +
      '<span class="mono" style="margin-left:6px">all</span>' +
      (tagged.length > 0
        ? ' <span style="font-size:0.7rem;color:var(--color-text-secondary)">(' + tagged.length + ' explicitly listed)</span> ' +
          '<span class="vlan-pills">' + tagged.map(function (v) { return _vlanPillHTML(v, names); }).join("") + '</span>'
        : "") +
    '</div>';
  } else if (tagged.length > 0) {
    taggedBit = '<div style="margin-top:0.25rem"><span style="font-size:0.75rem;color:var(--color-text-secondary)">Tagged VLANs</span> ' +
      '<span class="vlan-pills" style="margin-left:6px">' + tagged.map(function (v) { return _vlanPillHTML(v, names); }).join("") + '</span> ' +
      '<span style="font-size:0.7rem;color:var(--color-text-secondary)">(' + tagged.length + ')</span>' +
    '</div>';
  } else {
    taggedBit = "";
  }
  return '<div style="margin-bottom:0.75rem;padding:0.5rem 0.65rem;background:var(--color-bg-primary);border:1px solid var(--color-border);border-radius:6px">' +
    '<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:0.25rem">' +
      '<span style="font-size:0.8rem;font-weight:600;color:var(--color-text-secondary)">VLAN</span>' +
      '<span class="badge hue-pill" style="--hue:#0d9488">' + escapeHtml(role) + '</span>' +
    '</div>' +
    nativeBit +
    taggedBit +
  '</div>';
}

function _renderIfaceLldpBlock(neighbors) {
  var container = document.getElementById("iface-lldp-block");
  if (!container) return;
  if (!neighbors || neighbors.length === 0) {
    container.innerHTML = "";
    return;
  }
  var html =
    '<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:0.25rem">' +
      '<label style="font-size:0.8rem;font-weight:600;color:var(--color-text-secondary)">LLDP Neighbor' + (neighbors.length > 1 ? "s" : "") + '</label>' +
      '<span style="font-size:0.7rem;color:var(--color-text-secondary)">' +
        (neighbors[0] && neighbors[0].source ? neighbors[0].source.toUpperCase() : "") +
      '</span>' +
    '</div>';
  html += '<div style="display:flex;flex-direction:column;gap:0.4rem">';
  neighbors.forEach(function (n) {
    var inferred = n.source === "peer-inferred";
    var inferredTitle = "Inferred from peer's reported uplink (no direct LLDP from this device)";
    var cardStyle = "background:var(--color-bg-primary);border:1px solid var(--color-border);border-radius:6px;padding:0.5rem 0.6rem";
    if (inferred) cardStyle += ";font-style:italic";
    var cardTitle = inferred ? ' title="' + escapeHtml(inferredTitle) + '"' : "";
    var label = n.systemName || n.chassisId || n.managementIp || "Unknown neighbor";
    var titleHtml = n.matchedAsset && n.matchedAsset.id
      ? '<a href="#" class="iface-lldp-asset-link" data-asset-id="' + escapeHtml(n.matchedAsset.id) + '" style="color:var(--color-accent);text-decoration:none;font-weight:600">' + escapeHtml(label) + '</a>'
      : '<span style="font-weight:600">' + escapeHtml(label) + '</span>';
    var rows = [];
    if (n.portId)               rows.push(["Remote port",     escapeHtml(n.portId) + (n.portDescription ? ' <span style="opacity:0.7">— ' + escapeHtml(n.portDescription) + '</span>' : "")]);
    else if (n.portDescription) rows.push(["Remote port",     escapeHtml(n.portDescription)]);
    if (n.chassisId)            rows.push(["Chassis ID",      '<span class="mono">' + escapeHtml(n.chassisId) + '</span>' + (n.chassisIdSubtype ? ' <span style="opacity:0.7">(' + escapeHtml(n.chassisIdSubtype) + ')</span>' : "")]);
    if (n.managementIp)         rows.push(["Management IP",   '<span class="mono">' + escapeHtml(n.managementIp) + '</span>']);
    if (n.capabilities && n.capabilities.length > 0) {
      rows.push(["Capabilities", n.capabilities.map(function (c) {
        return '<span class="badge hue-pill" style="--hue:#3b82f6;margin-right:3px">' + escapeHtml(c) + '</span>';
      }).join("")]);
    }
    if (n.systemDescription)    rows.push(["System description", '<span style="font-size:0.8rem">' + escapeHtml(n.systemDescription) + '</span>']);
    if (inferred)               rows.push(["Source", '<span style="font-size:0.78rem;color:var(--color-text-secondary)">Inferred from peer&rsquo;s reported uplink</span>']);
    var rowHtml = rows.map(function (r) {
      return '<div style="display:flex;gap:0.5rem;font-size:0.8rem"><div style="width:140px;color:var(--color-text-secondary);flex-shrink:0">' + r[0] + '</div><div style="flex:1;min-width:0;word-break:break-word">' + r[1] + '</div></div>';
    }).join("");
    var matchHint = n.matchedAsset
      ? ''
      : ' <span class="badge hue-pill" style="--hue:#6b7280;margin-left:6px" title="No Polaris asset matched this neighbor by management IP, chassis MAC, or hostname">unmatched</span>';
    html +=
      '<div style="' + cardStyle + '"' + cardTitle + '>' +
        '<div style="margin-bottom:0.4rem">' + titleHtml + matchHint + '</div>' +
        rowHtml +
      '</div>';
  });
  html += '</div>';
  container.innerHTML = html;
  container.querySelectorAll(".iface-lldp-asset-link").forEach(function (link) {
    link.addEventListener("click", function (e) {
      e.preventDefault();
      var id = link.getAttribute("data-asset-id");
      if (id) openViewModal(id);
    });
  });
}

// Combined input + output throughput on a single chart. Two color-coded lines
// share one bps y-axis (autoscaled to the higher of the two peaks) and one
// hover tooltip that names both values at the same timestamp.
function _renderIfaceThroughputChart(container, derived, opts) {
  opts = opts || {};
  var inSeries  = derived.filter(function (d) { return typeof d.inBps  === "number"; });
  var outSeries = derived.filter(function (d) { return typeof d.outBps === "number"; });
  if (inSeries.length === 0 && outSeries.length === 0) {
    container.textContent = "No throughput samples yet — fast-cadence polling is required for sub-minute resolution.";
    return;
  }
  var W = container.clientWidth || 600, H = 180;
  var padL = 56, padR = 10, padT = 14, padB = 32;
  var innerW = W - padL - padR, innerH = H - padT - padB;
  var bounds = _chartTimeBounds(derived, opts.since, opts.until);
  var t0 = bounds.t0, t1 = bounds.t1;
  var spanMs = t1 - t0, oneDayMs = 86400000;
  var pad2 = _chartPad2;
  var maxV = 0;
  inSeries.forEach (function (d) { if (d.inBps  > maxV) maxV = d.inBps;  });
  outSeries.forEach(function (d) { if (d.outBps > maxV) maxV = d.outBps; });
  // Rollup tiers (opts.maxTier): each bucket's peak rate as a dashed line
  // under its average. While shown, the visible window's peaks join the axis
  // so the line is never clipped off the top; hidden, it fits the averages.
  var maxTier = opts.maxTier || null;
  var showMax = !!maxTier && _getMaxLinePref("assetInterface");
  function finiteOrNull(v) { return typeof v === "number" && isFinite(v) ? v : null; }
  if (showMax) {
    _inChartWindow(derived, opts.since).forEach(function (d) {
      var a = finiteOrNull(d.inMaxBps), b = finiteOrNull(d.outMaxBps);
      if (a != null && a > maxV) maxV = a;
      if (b != null && b > maxV) maxV = b;
    });
  }
  if (maxV < 1000) maxV = 1000;
  function tidyCeil(n) {
    var exp = Math.pow(10, Math.floor(Math.log10(n)));
    var mant = n / exp;
    var step = mant <= 1 ? 1 : mant <= 2 ? 2 : mant <= 5 ? 5 : 10;
    return step * exp;
  }
  var ceil = tidyCeil(maxV);

  var xFor = _chartXScale(padL, innerW, t0, t1);
  var yFor = _chartYScale(padT, innerH, 0, ceil);

  // Missed polls (interface streams have no per-sample success flag — a
  // failed poll simply leaves no row) render exactly like response-time
  // failures: red dots at the baseline flanking the outage, with the series
  // lines fading into red across it instead of bridging. Outage windows come
  // from the response-time probe (see _outageMarkers).
  var gapMarkers = _outageMarkers(opts && opts.outages, derived.map(function (d) { return new Date(d.timestamp).getTime(); }));
  var baselineY = padT + innerH;
  function failAwarePts(list, key) {
    if (!list.length) return [];
    var pts = list.map(function (d) {
      return { t: new Date(d.timestamp).getTime(), x: xFor(d.timestamp), y: yFor(d[key]), ok: true };
    });
    _outagePts(gapMarkers, xFor, baselineY).forEach(function (mp) { pts.push(mp); });
    pts.sort(function (a, b) { return a.t - b.t; });
    return pts;
  }
  var failDots = _outageDotsSVG(gapMarkers, xFor, baselineY);
  var missHits = _outageHitsSVG(gapMarkers, xFor, padT, innerH);

  // Single hit point per timestamp so the tooltip names both values together.
  var hits = derived.map(function (d) {
    var hasIn  = typeof d.inBps  === "number";
    var hasOut = typeof d.outBps === "number";
    if (!hasIn && !hasOut) return "";
    // Anchor the hit at whichever line is higher so the cursor lands close to a visible curve.
    var hi = hasIn && hasOut ? Math.max(d.inBps, d.outBps) : (hasIn ? d.inBps : d.outBps);
    var inMx = finiteOrNull(d.inMaxBps), outMx = finiteOrNull(d.outMaxBps);
    return '<circle class="chart-hit" cx="' + xFor(d.timestamp) + '" cy="' + yFor(hi) + '" r="6" fill="transparent" style="cursor:crosshair"' +
      ' data-ts="' + escapeHtml(String(d.timestamp)) + '"' +
      ' data-in="'  + (hasIn  ? d.inBps  : "") + '"' +
      ' data-out="' + (hasOut ? d.outBps : "") + '"' +
      (maxTier
        ? ' data-in-max="' + (inMx != null ? inMx : "") + '" data-out-max="' + (outMx != null ? outMx : "") + '"'
        : '') + '/>';
  }).join("");

  var ticks = "";
  for (var i = 0; i <= 4; i++) {
    var v = ceil * i / 4;
    var y = padT + innerH - (i / 4) * innerH;
    ticks +=
      '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (padL - 4) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + _fmtBitsPerSecAxis(v) + '</text>';
  }
  var xTicks = _chartXTicksSVG(t0, t1, padL, padT, innerW, innerH);
  var inColor  = "var(--color-accent)";
  var outColor = "#f4a261";
  var legend =
    '<g font-size="10" fill="currentColor">' +
      '<rect x="' + (padL + 4)   + '" y="2" width="10" height="10" fill="' + inColor  + '"/>' +
      '<text x="' + (padL + 18)  + '" y="11">Input</text>' +
      '<rect x="' + (padL + 70)  + '" y="2" width="10" height="10" fill="' + outColor + '"/>' +
      '<text x="' + (padL + 84)  + '" y="11">Output</text>' +
    '</g>';
  var clipId = _chartClipId("ifaceTp");
  var inLine  = _failureAwareSeriesSVG(failAwarePts(inSeries,  "inBps"),  inColor,  clipId + "-in");
  var outLine = _failureAwareSeriesSVG(failAwarePts(outSeries, "outBps"), outColor, clipId + "-out");
  function maxPts(key) {
    return derived.map(function (d) {
      var v = finiteOrNull(d[key]);
      return v == null ? null : { x: xFor(d.timestamp), y: yFor(v) };
    });
  }
  var maxSvg = showMax ? _maxLineSVG(maxPts("inMaxBps"), inColor) + _maxLineSVG(maxPts("outMaxBps"), outColor) : "";
  container.innerHTML =
    _maxLineLegendRowHTML("assetInterface", maxTier) +
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      _chartClipDefs(clipId, padL, padT, innerW, innerH) +
      '<defs>' + inLine.defs + outLine.defs + '</defs>' +
      ticks + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      _maintenanceBandLayer(t0, t1, padL, padT, innerW, innerH) +
      '<g ' + _chartClipAttr(clipId) + '>' +
        maxSvg +
        inLine.segments +
        outLine.segments +
        inSeries .map(function (d) { return '<circle cx="' + xFor(d.timestamp) + '" cy="' + yFor(d.inBps)  + '" r="1.5" fill="' + inColor  + '"/>'; }).join("") +
        outSeries.map(function (d) { return '<circle cx="' + xFor(d.timestamp) + '" cy="' + yFor(d.outBps) + '" r="1.5" fill="' + outColor + '"/>'; }).join("") +
        failDots +
        missHits +
        hits +
      '</g>' +
      legend +
    '</svg>' + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";
  _stashChartGeometry(container, t0, t1, padL, innerW, W);
  if (maxTier) _wireMaxLineChip(container, "assetInterface", function () { _renderIfaceThroughputChart(container, derived, opts); });
  _wireChartTooltip(container, function (target) {
    if (target.getAttribute("data-miss") === "1") {
      return _missTooltipHTML(target);
    }
    var inV  = target.getAttribute("data-in");
    var outV = target.getAttribute("data-out");
    // Rollup buckets name avg AND peak (data-in-max is only stamped there).
    function cell(v, mx) {
      var avg = v !== "" ? _fmtBitsPerSec(Number(v)) : "—";
      if (mx == null) return avg;
      return _avgMaxText(avg, mx !== "" ? _fmtBitsPerSec(Number(mx)) : null);
    }
    return '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(target.getAttribute("data-ts"))) + '</div>' +
      '<div>Input: '  + cell(inV,  target.getAttribute("data-in-max"))  + '</div>' +
      '<div>Output: ' + cell(outV, target.getAttribute("data-out-max")) + '</div>';
  });
  _addChartScreenshotButton(container, "Throughput", { yAxis: "Throughput (bits/s)", subject: opts.subject, getStats: _statsSummaryFrom("iface-tput-stats") });
  _observeChartResize(container, function (c) { _renderIfaceThroughputChart(c, derived, opts); });
}

// ─── Interface error charts (rule 159a) ────────────────────────────────────
//
// Both interface error charts — Errors on every port, FC errors on a
// fibre-channel port — are stacked bars in the RATE an automation compares:
// errors per second for ifIn/OutErrorRate, per minute for the fc*Rate metrics.
// So the number on the axis is the number an operator typed as a threshold.
//
// Severity follows the convention the CPU, memory, sensor and path charts set
// (_severityChartLayer): every band of an automation that reads THIS port
// (getMetricSeverityTiers, filtered by the port's name and tags) is a dashed,
// labelled line in the band's colour, and the series that automation reads
// takes the band's colour while it sits inside it. A series no automation
// reads keeps its own colour. The fail / maintenance / date markers are the
// throughput chart's. Colour is inline, never a class: the screenshot button
// sees no stylesheet.

/** "0", "0.04", "1.5", "12" — a rate small enough to need its decimals. */
function _fmtErrRate(v) {
  if (typeof v !== "number" || !isFinite(v)) return "—";
  if (v === 0) return "0";
  var a = Math.abs(v);
  if (a >= 10) return String(Math.round(v));
  if (a >= 1) return String(Math.round(v * 10) / 10);
  if (a >= 0.01) return String(Math.round(v * 100) / 100);
  return v.toExponential(1);
}

/**
 * Severity tiers for each interface metric a chart draws, for one port. One
 * request per metric, cached a minute per (asset, port) so the panel's
 * auto-refresh does not re-ask; a failure is no shading, never no chart.
 */
var _ifaceTierCache = {};
function _loadIfaceSeverityTiers(assetId, ifName, alias, metrics) {
  var key = assetId + "|" + ifName + "|" + metrics.join(",");
  var hit = _ifaceTierCache[key];
  if (hit && Date.now() - hit.at < 60000) return Promise.resolve(hit.tiers);
  return Promise.all(metrics.map(function (m) {
    return _loadMetricSeverityTiers(assetId, m, { ifName: ifName, alias: alias || null });
  })).then(function (lists) {
    var tiers = {};
    metrics.forEach(function (m, i) { tiers[m] = lists[i] || []; });
    _ifaceTierCache[key] = { at: Date.now(), tiers: tiers };
    return tiers;
  });
}

/**
 * One stacked-bar rate chart. `spec`:
 *   kind      — clip / gradient id prefix
 *   unit      — "/s" | "/min", appended to tier labels and the tooltip
 *   floorMax  — the smallest axis top, so a quiet port is not all axis
 *   series    — bottom → top: {key, label, short, color, tiers, get(d)}
 *   events    — optional {label, get(d) → {count, severity|null}}: a diamond
 *               above the plot for each interval with a count, in the band's
 *               colour when an automation reads it
 *   tooltip   — (d) → extra rows of HTML under the timestamp
 *   title, yAxis, statsId, rerender
 */
function _renderIfaceRateBars(container, derived, opts, spec) {
  opts = opts || {};
  var CS = window.PolarisChartSeverity;
  var rows = derived.filter(function (d) {
    return spec.series.some(function (s) { return typeof s.get(d) === "number"; }) ||
      (spec.events && spec.events.get(d) && spec.events.get(d).count > 0);
  });
  if (rows.length === 0) {
    container.textContent = spec.empty || "No error samples reported by this interface.";
    return;
  }
  var W = container.clientWidth || 600, H = spec.events ? 210 : 190;
  var padL = 48, padR = 10, padT = spec.events ? 34 : 20, padB = 32;
  var innerW = W - padL - padR, innerH = H - padT - padB;
  var bounds = _chartTimeBounds(derived, opts.since, opts.until);
  var t0 = bounds.t0, t1 = bounds.t1;

  var maxV = 0;
  rows.forEach(function (d) {
    var sum = 0;
    spec.series.forEach(function (s) { var v = s.get(d); if (typeof v === "number" && v > 0) sum += v; });
    if (sum > maxV) maxV = sum;
  });
  // The axis reaches the lowest upward threshold, so the bands an automation
  // set are on the chart even while the port is quiet: how close it came is
  // the question the chart answers.
  var lowestUp = null;
  spec.series.forEach(function (s) {
    (s.tiers || []).forEach(function (t) {
      if ((t.operator === ">" || t.operator === ">=") && typeof t.threshold === "number" && t.threshold > 0) {
        if (lowestUp === null || t.threshold < lowestUp) lowestUp = t.threshold;
      }
    });
  });
  var ceil = Math.max(maxV * 1.2, spec.floorMax, lowestUp !== null ? lowestUp * 1.15 : 0);

  var xFor = _chartXScale(padL, innerW, t0, t1);
  var yFor = _chartYScale(padT, innerH, 0, ceil);
  var baselineY = padT + innerH;
  var slot = innerW / Math.max(1, Math.round((t1 - t0) / Math.max(1, _ifaceIntervalMs(rows))));
  var barW = Math.max(1, Math.min(14, slot * 0.75));

  function colorFor(s, v) {
    if (!CS || !s.tiers || !s.tiers.length || typeof v !== "number") return s.color;
    var sev = CS.severityAt(s.tiers, v);
    return sev ? CS.colorOf(sev) : s.color;
  }

  var bars = "", hits = "", events = "";
  rows.forEach(function (d) {
    var cx = xFor(d.timestamp);
    var acc = 0;
    spec.series.forEach(function (s) {
      var v = s.get(d);
      if (typeof v !== "number" || v <= 0) return;
      var yBot = yFor(Math.min(ceil, acc));
      var yTop = yFor(Math.min(ceil, acc + v));
      var h = Math.max(1, yBot - yTop);
      bars += '<rect x="' + (cx - barW / 2) + '" y="' + (yBot - h) + '" width="' + barW + '" height="' + h + '" fill="' + colorFor(s, v) + '"/>';
      acc += v;
    });
    if (spec.events) {
      var ev = spec.events.get(d);
      if (ev && ev.count > 0) {
        var ec = ev.severity && CS ? CS.colorOf(ev.severity) : "var(--color-text-secondary)";
        events += '<rect x="' + (cx - 3.5) + '" y="' + (padT - 11) + '" width="7" height="7" fill="' + ec + '" transform="rotate(45 ' + cx + ' ' + (padT - 7.5) + ')"/>';
      }
    }
    hits += '<rect class="chart-hit" x="' + (cx - Math.max(3, slot / 2)) + '" y="' + (padT - 14) + '" width="' + Math.max(6, slot) + '" height="' + (innerH + 14) + '"' +
      ' fill="transparent" style="cursor:crosshair" data-ts="' + escapeHtml(String(d.timestamp)) + '" data-i="' + derived.indexOf(d) + '"/>';
  });

  // Band lines + captions, one per visible tier per series that has them.
  var lines = "", labels = "";
  if (CS) {
    var seen = {};
    spec.series.forEach(function (s) {
      CS.visibleTiers(s.tiers || [], 0, ceil).forEach(function (t) {
        var y = yFor(t.threshold);
        var color = CS.colorOf(t.severity);
        var cap = CS.tierLabel(t, spec.unit) + (spec.series.length > 1 ? " (" + s.short + ")" : "");
        var k = t.severity + "|" + t.threshold;
        lines += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y +
          '" stroke="' + color + '" stroke-width="1.2" stroke-dasharray="4,4" opacity="0.8">' +
          '<title>' + escapeHtml((t.ruleName || "") + " — " + cap) + '</title></line>';
        labels += '<text x="' + (W - padR - 2) + '" y="' + Math.max(padT + 8, y - 3 - (seen[k] ? 10 : 0)) +
          '" text-anchor="end" font-size="9" font-weight="600" fill="' + color + '">' + escapeHtml(cap) + '</text>';
        seen[k] = true;
      });
    });
  }

  var gapMarkers = _outageMarkers(opts.outages, derived.map(function (d) { return new Date(d.timestamp).getTime(); }));
  var failDots = _outageDotsSVG(gapMarkers, xFor, baselineY);
  var missHits = _outageHitsSVG(gapMarkers, xFor, padT, innerH);

  var ticks = "";
  for (var i = 0; i <= 4; i++) {
    var v = ceil * i / 4;
    var ty = padT + innerH - (i / 4) * innerH;
    ticks +=
      '<line x1="' + padL + '" y1="' + ty + '" x2="' + (W - padR) + '" y2="' + ty + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (padL - 4) + '" y="' + (ty + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + _fmtErrRate(v) + '</text>';
  }
  var xTicks = _chartXTicksSVG(t0, t1, padL, padT, innerW, innerH);
  var lx = padL + 10, legend = '<g font-size="10" fill="currentColor">';
  spec.series.forEach(function (s) {
    legend += '<rect x="' + lx + '" y="2" width="10" height="10" fill="' + s.color + '"/>' +
      '<text x="' + (lx + 14) + '" y="11">' + escapeHtml(s.label + " " + spec.unit) + '</text>';
    lx += 14 + (s.label.length + spec.unit.length + 2) * 5.6 + 14;
  });
  if (spec.events) {
    legend += '<rect x="' + (lx + 1.5) + '" y="3.5" width="7" height="7" fill="var(--color-text-secondary)" transform="rotate(45 ' + (lx + 5) + ' 7)"/>' +
      '<text x="' + (lx + 14) + '" y="11">' + escapeHtml(spec.events.label) + '</text>';
  }
  legend += '</g>';

  var clipId = _chartClipId(spec.kind);
  container.innerHTML =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      _chartClipDefs(clipId, padL, padT, innerW, innerH) +
      ticks + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      _maintenanceBandLayer(t0, t1, padL, padT, innerW, innerH) +
      '<g ' + _chartClipAttr(clipId) + '>' + bars + lines + failDots + '</g>' +
      events + labels + missHits + hits +
      legend +
    '</svg>' + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";
  _stashChartGeometry(container, t0, t1, padL, innerW, W);
  _wireChartTooltip(container, function (target) {
    if (target.getAttribute("data-miss") === "1") return _missTooltipHTML(target);
    var d = derived[Number(target.getAttribute("data-i"))];
    if (!d) return "";
    return '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(target.getAttribute("data-ts"))) + '</div>' +
      spec.tooltip(d);
  });
  _addChartScreenshotButton(container, spec.title, { yAxis: spec.yAxis, subject: opts.subject, getStats: _statsSummaryFrom(spec.statsId) });
  _observeChartResize(container, function (c) { spec.rerender(c); });
}

/** The typical spacing of a chart's points, for the bar width. */
function _ifaceIntervalMs(rows) {
  var gaps = [];
  for (var i = 1; i < rows.length; i++) {
    var g = new Date(rows[i].timestamp).getTime() - new Date(rows[i - 1].timestamp).getTime();
    if (g > 0) gaps.push(g);
  }
  if (!gaps.length) return 60000;
  gaps.sort(function (a, b) { return a - b; });
  return gaps[Math.floor(gaps.length / 2)];
}

function _renderIfaceErrorChart(container, derived, opts) {
  opts = opts || {};
  var tiers = opts.tiers || {};
  _renderIfaceRateBars(container, derived, opts, {
    kind: "ifaceErr",
    unit: "/s",
    floorMax: 0.05,
    // In errors take the accent (the colour a reading no band claims), out
    // errors stay purple; neither is amber any more, so amber only ever means
    // a Warning band. Red stays reserved for missed polls.
    series: [
      { key: "in",  label: "In errors",  short: "in",  color: "var(--color-accent)", tiers: tiers.ifInErrorRate  || [], get: function (d) { return d.inErrRate; } },
      { key: "out", label: "Out errors", short: "out", color: "#9b5de5",             tiers: tiers.ifOutErrorRate || [], get: function (d) { return d.outErrRate; } },
    ],
    tooltip: function (d) {
      return '<div>In errors: ' + _fmtErrRate(d.inErrRate) + ' /s' + (typeof d.inErr === "number" ? ' (' + d.inErr + ')' : '') + '</div>' +
        '<div>Out errors: ' + _fmtErrRate(d.outErrRate) + ' /s' + (typeof d.outErr === "number" ? ' (' + d.outErr + ')' : '') + '</div>';
    },
    title: "Interface errors",
    yAxis: "Errors per second",
    statsId: "iface-err-stats",
    rerender: function (c) { _renderIfaceErrorChart(c, derived, opts); },
  });
}

// The fibre-channel counters an FC chart draws (business rule 159a), each with
// the automation metric that reads it. CRC and invalid words are the bars —
// the optic / cable story; the three link counters are the diamond row.
var _FC_CHART_BARS = [
  { key: "invalidCrcs",    metric: "fcCrcErrorRate",      label: "CRC errors",    short: "CRC",   color: "var(--color-accent)" },
  { key: "invalidTxWords", metric: "fcInvalidTxWordRate", label: "Invalid words", short: "words", color: "#2a9d8f" },
];
var _FC_CHART_EVENTS = [
  { key: "linkFailures", metric: "fcLinkFailureRate", label: "Link failures" },
  { key: "syncLosses",   metric: "fcSyncLossRate",    label: "Sync losses" },
  { key: "sigLosses",    metric: "fcSignalLossRate",  label: "Signal losses" },
];
var _FC_CHART_METRICS = _FC_CHART_BARS.concat(_FC_CHART_EVENTS).map(function (c) { return c.metric; });

function _renderIfaceFcChart(container, derived, opts) {
  opts = opts || {};
  var tiers = opts.tiers || {};
  var CS = window.PolarisChartSeverity;
  _renderIfaceRateBars(container, derived, opts, {
    kind: "ifaceFc",
    unit: "/min",
    floorMax: 5,
    empty: "No fibre-channel counters recorded for this port yet. Monitor it to record them every minute.",
    series: _FC_CHART_BARS.map(function (c) {
      return { key: c.key, label: c.label, short: c.short, color: c.color, tiers: tiers[c.metric] || [],
        get: function (d) { return d.fc ? d.fc[c.key] : null; } };
    }),
    events: {
      label: "Link failure, loss of sync or signal",
      get: function (d) {
        if (!d.fc) return null;
        var count = 0, sev = null;
        _FC_CHART_EVENTS.forEach(function (c) {
          var v = d.fc[c.key];
          if (typeof v !== "number" || v <= 0) return;
          count += v;
          var s = CS ? CS.severityAt(tiers[c.metric] || [], v) : null;
          if (s && (!sev || CS.SEV_ORDER.indexOf(s) > CS.SEV_ORDER.indexOf(sev))) sev = s;
        });
        return { count: count, severity: sev };
      },
    },
    tooltip: function (d) {
      if (!d.fc) return '<div>No FC reading</div>';
      return _FC_CHART_BARS.concat(_FC_CHART_EVENTS).map(function (c) {
        return '<div>' + escapeHtml(c.label) + ': ' + _fmtErrRate(d.fc[c.key]) + ' /min</div>';
      }).join("");
    },
    title: "Fibre-channel errors",
    yAxis: "Errors per minute",
    statsId: "iface-fc-stats",
    rerender: function (c) { _renderIfaceFcChart(c, derived, opts); },
  });
}

function _renderIfaceFcStats(container, rawSamples, derived) {
  if (!container) return;
  var peak = {};
  var linkEvents = 0;
  derived.forEach(function (d) {
    if (!d.fc) return;
    _FC_CHART_BARS.forEach(function (c) {
      var v = d.fc[c.key];
      if (typeof v === "number" && (peak[c.key] == null || v > peak[c.key])) peak[c.key] = v;
    });
    _FC_CHART_EVENTS.forEach(function (c) { if (typeof d.fc[c.key] === "number" && d.fc[c.key] > 0) linkEvents++; });
  });
  _renderChartStats(container, rawSamples.length, [
    { label: "Peak CRC", value: peak.invalidCrcs != null ? _fmtErrRate(peak.invalidCrcs) + " /min" : "—" },
    { label: "Peak invalid words", value: peak.invalidTxWords != null ? _fmtErrRate(peak.invalidTxWords) + " /min" : "—" },
    { label: "Intervals with a link event", value: String(linkEvents) },
  ]);
}

// ─── IPsec tunnel slide-over ───────────────────────────────────────────────
//
// Sits on top of the asset details panel like the interface slide-over does.
// Shows a status timeline (each sample colored up/partial/down) and per-
// interval throughput derived from the cumulative byte counters. No auto-
// refresh because IPsec rides the system-info cadence (~10 min) — closing
// and reopening the panel is fast enough.

function _ensureIpsecPanelDOM() {
  if (document.getElementById("ipsec-panel-overlay")) return;
  // Skeleton + backdrop / close / Escape / resize wiring: buildSlideover
  // (app.js). Stacks by DOM order like every slide-over — raiseSlideover on open.
  buildSlideover({
    id: "ipsec-panel",
    overlayClass: "slideover-nested",
    panelStyle: "z-index:1100",
    title: "IPsec tunnel",
    bodyHTML: '<p class="empty-state" style="padding:1rem 1.25rem">Loading…</p>',
    footer: true,
    close: closeIpsecPanel,
    resizeKey: "polaris.panel.width.ipsec",
  });
}

function closeIpsecPanel() {
  var ov = document.getElementById("ipsec-panel-overlay");
  if (ov) ov.classList.remove("open");
  if (_ipsecRefreshTimer) { clearTimeout(_ipsecRefreshTimer); _ipsecRefreshTimer = null; }
}

async function openIpsecTunnelDetailPanel(asset, tunnelName) {
  if (!asset || !tunnelName) return;
  _ensureIpsecPanelDOM();
  var titleEl  = document.getElementById("ipsec-panel-title");
  var metaEl   = document.getElementById("ipsec-panel-meta");
  var bodyEl   = document.getElementById("ipsec-panel-body");
  var footerEl = document.getElementById("ipsec-panel-footer");
  titleEl.textContent = "IPsec — " + tunnelName;
  metaEl.textContent = asset.hostname || asset.ipAddress || asset.id;
  bodyEl.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">Loading…</p>';
  footerEl.innerHTML =
    '<button class="btn btn-sm btn-secondary" id="btn-ipsec-panel-close-btn">Close</button>';
  raiseSlideover(document.getElementById("ipsec-panel-overlay"));
  requestAnimationFrame(function () {
    document.getElementById("ipsec-panel-overlay").classList.add("open");
  });
  document.getElementById("btn-ipsec-panel-close-btn").addEventListener("click", closeIpsecPanel);

  var rangeBtns = _chartRangeBtnsHTML("ipsec-range-btn", [
    { value: "1h",  label: "1h"  },
    { value: "12h", label: "12h" },
    { value: "24h", label: "24h" },
    { value: "7d",  label: "7d"  },
    { value: "30d", label: "30d" },
    { value: "custom", label: "Custom…", id: "btn-ipsec-custom" },
  ], "assetIpsec", "1h");
  var ipsecCustomPanel =
    '<div id="ipsec-custom-panel" style="display:none;align-items:center;gap:6px;margin:0.5rem 0;padding:0.5rem;background:var(--color-bg-primary);border:1px solid var(--color-border);border-radius:6px;font-size:0.85rem">' +
      '<label style="display:flex;align-items:center;gap:4px">From <input type="datetime-local" id="ipsec-custom-from" class="form-input" style="padding:2px 6px"></label>' +
      '<label style="display:flex;align-items:center;gap:4px">To <input type="datetime-local" id="ipsec-custom-to" class="form-input" style="padding:2px 6px"></label>' +
      '<button class="btn btn-sm btn-primary" id="btn-ipsec-custom-apply">Apply</button>' +
    '</div>';

  // IPsec rides the FortiOS REST interfaces stream — even when the operator
  // routes Interfaces to SNMP, IPsec stays on REST since SNMP has no
  // equivalent (see polaris-monitoring-discovery). The configurable stream that controls its
  // delivery is `interfaces`.
  var ipsecBadge = _streamSourceBadgeHTML(asset, "interfaces");

  bodyEl.innerHTML =
    '<div style="padding:1rem 1.25rem">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">' +
        '<div style="display:flex;align-items:baseline;gap:0.5rem;flex-wrap:wrap">' +
          '<h4 style="margin:0">Tunnel state &amp; throughput</h4>' +
          ipsecBadge +
        '</div>' +
        '<div style="display:flex;gap:6px">' + rangeBtns + '</div>' +
      '</div>' +
      ipsecCustomPanel +
      '<div id="ipsec-stats" style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">Loading…</div>' +
      '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">Status</h5>' +
      '<div id="ipsec-status-chart" class="ipsec-chart-box"></div>' +
      '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">Incoming (bps)</h5>' +
      '<div id="ipsec-in-chart" class="ipsec-chart-box"></div>' +
      '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">Outgoing (bps)</h5>' +
      '<div id="ipsec-out-chart" class="ipsec-chart-box"></div>' +
    '</div>';
  document.querySelectorAll(".ipsec-chart-box").forEach(function (el) {
    el.classList.add("chart-box");
    el.style.minHeight = "140px";
    el.style.display = "flex";
    el.style.alignItems = "center";
    el.style.justifyContent = "center";
    el.style.color = "var(--color-text-secondary)";
    el.style.fontSize = "0.85rem";
  });

  await _loadIpsecHistoryFor(asset.id, tunnelName, _getChartRangePref("assetIpsec", "1h"));
  // Async overwrite the badge with the authoritative resolved polling method.
  _updateStreamSourceBadgesFromEffective(asset.id, asset);
  document.querySelectorAll(".ipsec-range-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      var range = b.getAttribute("data-range");
      var panel = document.getElementById("ipsec-custom-panel");
      if (range === "custom") {
        if (!panel) return;
        var willOpen = panel.style.display === "none";
        panel.style.display = willOpen ? "flex" : "none";
        if (willOpen) {
          var toInput   = document.getElementById("ipsec-custom-to");
          var fromInput = document.getElementById("ipsec-custom-from");
          if (toInput && !toInput.value) toInput.value = _toLocalDatetimeInput(new Date());
          if (fromInput && !fromInput.value) fromInput.value = _toLocalDatetimeInput(new Date(Date.now() - 24 * 3600 * 1000));
        }
        return;
      }
      if (panel) panel.style.display = "none";
      document.querySelectorAll(".ipsec-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      b.classList.remove("btn-secondary"); b.classList.add("btn-primary");
      _setChartRangePref("assetIpsec", range);
      _loadIpsecHistoryFor(asset.id, tunnelName, range);
    });
  });
  var ipsecCustomApply = document.getElementById("btn-ipsec-custom-apply");
  if (ipsecCustomApply) {
    ipsecCustomApply.addEventListener("click", function () {
      var fromInput = document.getElementById("ipsec-custom-from");
      var toInput   = document.getElementById("ipsec-custom-to");
      if (!fromInput.value || !toInput.value) { showToast("Enter both From and To", "error"); return; }
      var fromIso = new Date(fromInput.value).toISOString();
      var toIso   = new Date(toInput.value).toISOString();
      if (new Date(fromIso) >= new Date(toIso)) { showToast("From must be before To", "error"); return; }
      document.querySelectorAll(".ipsec-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      var customBtn = document.getElementById("btn-ipsec-custom");
      if (customBtn) { customBtn.classList.remove("btn-secondary"); customBtn.classList.add("btn-primary"); }
      _loadIpsecHistoryFor(asset.id, tunnelName, { from: fromIso, to: toIso });
    });
  }
  // Drag-select on any of the three charts applies the custom range.
  ["ipsec-status-chart", "ipsec-in-chart", "ipsec-out-chart"].forEach(function (cid) {
    _wireChartDragSelect(document.getElementById(cid), function (fromIso, toIso) {
      _applyCustomRangeSelection({
        btnClass: "ipsec-range-btn", customBtnId: "btn-ipsec-custom",
        panelId: "ipsec-custom-panel", fromId: "ipsec-custom-from", toId: "ipsec-custom-to",
      }, fromIso, toIso);
      _loadIpsecHistoryFor(asset.id, tunnelName, { from: fromIso, to: toIso });
    });
  });
}

async function _loadIpsecHistoryFor(assetId, tunnelName, range, callOpts) {
  // Cancel any pending auto-refresh — manual range change shouldn't race a tick.
  if (_ipsecRefreshTimer) { clearTimeout(_ipsecRefreshTimer); _ipsecRefreshTimer = null; }
  var silent = !!(callOpts && callOpts.silent);
  var statusEl = document.getElementById("ipsec-status-chart");
  var inEl     = document.getElementById("ipsec-in-chart");
  var outEl    = document.getElementById("ipsec-out-chart");
  var stats    = document.getElementById("ipsec-stats");
  if (!statusEl) return;
  if (!silent) {
    statusEl.textContent = inEl.textContent = outEl.textContent = "Loading samples…";
    if (stats) stats.textContent = "Loading…";
  }
  var panelBody = silent ? document.getElementById("ipsec-panel-body") : null;
  var savedScroll = panelBody ? panelBody.scrollTop : 0;
  // Accept range as a string or `{from, to}` object (canonical convention).
  var opts = (typeof range === "string" || !range) ? { range: range || "1h" } : range;
  try {
    var data = await api.assets.ipsecHistory(assetId, tunnelName, opts);
    var samples = data.samples || [];
    var derived = _deriveIpsecThroughput(samples, data);
    _renderIpsecStats(stats, _inChartWindow(samples, data.since), _inChartWindow(derived, data.since), data);
    var ipsecOpts = { since: data.since, until: data.until, subject: tunnelName };
    _renderIpsecStatusChart(statusEl, samples, ipsecOpts);
    _renderIpsecBpsChart(inEl,  derived, "in",  ipsecOpts);
    _renderIpsecBpsChart(outEl, derived, "out", ipsecOpts);
    if (opts.from && opts.to) {
      statusEl.dataset.from = inEl.dataset.from = outEl.dataset.from = opts.from;
      statusEl.dataset.to   = inEl.dataset.to   = outEl.dataset.to   = opts.to;
      delete statusEl.dataset.range; delete inEl.dataset.range; delete outEl.dataset.range;
    } else {
      statusEl.dataset.range = inEl.dataset.range = outEl.dataset.range = opts.range || "1h";
      delete statusEl.dataset.from; delete inEl.dataset.from; delete outEl.dataset.from;
      delete statusEl.dataset.to;   delete inEl.dataset.to;   delete outEl.dataset.to;
    }
  } catch (err) {
    if (!silent) {
      statusEl.textContent = inEl.textContent = outEl.textContent = "Error: " + (err.message || "failed to load");
      if (stats) stats.textContent = "";
    }
    // Silent ticks leave stale content on transient errors.
  }
  if (panelBody) {
    panelBody.scrollTop = savedScroll;
    requestAnimationFrame(function () {
      if (panelBody.scrollTop !== savedScroll) panelBody.scrollTop = savedScroll;
    });
  }
  // Custom date ranges are fixed historical windows — do not auto-refresh.
  if (opts.from && opts.to) return;
  // Schedule next auto-refresh on the response-time cadence — pinned tunnels
  // ride that cadence on the backend (collectFastFiltered).
  var settings = _monitorSettingsCache || {};
  var asset = _currentAssetForRefresh;
  var ms = _refreshIntervalMs(asset && asset.monitorIntervalSec, settings.intervalSeconds, 60);
  _scheduleIpsecRefresh(assetId, tunnelName, ms);
}

// FortiOS resets phase-1 byte counters when the SA renegotiates, so a
// negative delta is treated as a counter reset (skipped) rather than negative
// throughput. Same convention as _derivePerIntervalSeries for interfaces.
// Rollup tier delivers `incomingBytesPerSec` / `outgoingBytesPerSec` already —
// one derived point per rollup sample, no diff needed.
function _deriveIpsecThroughput(samples, data) {
  if (data && typeof data.bucketSeconds === "number" && data.bucketSeconds > 0) {
    return (samples || []).map(function (s) {
      var inBps  = typeof s.incomingBytesPerSec === "number" ? s.incomingBytesPerSec * 8 : null;
      var outBps = typeof s.outgoingBytesPerSec === "number" ? s.outgoingBytesPerSec * 8 : null;
      return { timestamp: s.timestamp, inBps: inBps, outBps: outBps };
    });
  }
  var out = [];
  for (var i = 1; i < samples.length; i++) {
    var prev = samples[i - 1];
    var cur  = samples[i];
    var dtMs = new Date(cur.timestamp) - new Date(prev.timestamp);
    if (dtMs <= 0) continue;
    var dtSec = dtMs / 1000;
    function delta(a, b) {
      if (typeof a !== "number" || typeof b !== "number") return null;
      var d = b - a;
      return d < 0 ? null : d;
    }
    var inB  = delta(prev.incomingBytes, cur.incomingBytes);
    var outB = delta(prev.outgoingBytes, cur.outgoingBytes);
    out.push({
      timestamp: cur.timestamp,
      inBps:  inB  != null ? (inB  * 8) / dtSec : null,
      outBps: outB != null ? (outB * 8) / dtSec : null,
    });
  }
  return out;
}

function _renderIpsecStats(container, samples, derived, data) {
  if (!container) return;
  var up = 0, down = 0, partial = 0, dynamic = 0;
  if (data && typeof data.bucketSeconds === "number" && data.bucketSeconds > 0) {
    // Rollup tier: each row carries per-status counts across its bucket.
    // Sum them so "Status" reads the same as detail-tier semantics —
    // total samples observed in each state across the whole range.
    samples.forEach(function (s) {
      up      += s.statusUpCount      || 0;
      down    += s.statusDownCount    || 0;
      partial += s.statusPartialCount || 0;
      dynamic += s.statusDynamicCount || 0;
    });
  } else {
    samples.forEach(function (s) {
      if (s.status === "up") up++;
      else if (s.status === "down") down++;
      else if (s.status === "dynamic") dynamic++;
      else partial++;
    });
  }
  var inMax = 0, outMax = 0, inSum = 0, outSum = 0, inN = 0, outN = 0;
  derived.forEach(function (d) {
    if (typeof d.inBps  === "number") { inSum  += d.inBps;  inN++;  if (d.inBps  > inMax)  inMax  = d.inBps; }
    if (typeof d.outBps === "number") { outSum += d.outBps; outN++; if (d.outBps > outMax) outMax = d.outBps; }
  });
  // Dial-up server template — phase-2 children appear as separate `parent`-
  // bearing tunnels that we filter out, so the up/partial/down rollup is
  // meaningless. Status reads "dial-up server"; throughput lines stay.
  var statusValue;
  if (dynamic > 0 && up === 0 && down === 0 && partial === 0) {
    statusValue = "dial-up server";
  } else {
    statusValue = up + " up / " + partial + " partial / " + down + " down";
    if (dynamic > 0) statusValue += " / " + dynamic + " dynamic";
  }
  var ipsecParts = [
    { label: "Status",   value: statusValue },
    { label: "In avg",   value: _fmtBitsPerSec(inN  ? inSum  / inN  : 0) },
    { label: "In peak",  value: _fmtBitsPerSec(inMax) },
    { label: "Out avg",  value: _fmtBitsPerSec(outN ? outSum / outN : 0) },
    { label: "Out peak", value: _fmtBitsPerSec(outMax) },
  ];
  var ipsecTierPart = _tierStatsPart(data);
  if (ipsecTierPart) ipsecParts.unshift(ipsecTierPart);
  _renderChartStats(container, samples.length, ipsecParts);
}

function _renderIpsecStatusChart(container, samples, opts) {
  opts = opts || {};
  if (samples.length === 0) {
    container.textContent = "No samples in this range yet.";
    return;
  }
  var W = container.clientWidth || 600, H = 60;
  var padL = 56, padR = 10, padT = 8, padB = 22;
  var innerW = W - padL - padR, innerH = H - padT - padB;
  var bounds = _chartTimeBounds(samples, opts.since, opts.until);
  var t0 = bounds.t0, t1 = bounds.t1;
  // Width of the trailing status bar — without this, the last sample stretches
  // to the right edge of the chart, which is misleading when the requested
  // window extends past the last sample.
  var lastStepMs = samples.length > 1
    ? (new Date(samples[samples.length - 1].timestamp).getTime() - new Date(samples[samples.length - 2].timestamp).getTime())
    : 600000;
  var spanMs = t1 - t0, oneDayMs = 86400000;
  var pad2 = _chartPad2;
  function colorFor(s) {
    if (s === "up") return MONITOR_STATE_COLORS.up;
    if (s === "down") return MONITOR_STATE_COLORS.down;
    if (s === "dynamic") return "#7b8794"; // dial-up server template — neutral gray
    return MONITOR_STATE_COLORS.warning;
  }
  var xFor = _chartXScale(padL, innerW, t0, t1);
  // Each sample covers from its own x to the next sample's x (or the chart edge).
  var bars = samples.map(function (s, i) {
    var x  = xFor(s.timestamp);
    var x2;
    if (i + 1 < samples.length) {
      x2 = xFor(samples[i + 1].timestamp);
    } else {
      x2 = Math.min(padL + innerW, xFor(new Date(s.timestamp).getTime() + lastStepMs));
    }
    var w = Math.max(1, x2 - x);
    return '<rect class="chart-hit" x="' + x + '" y="' + padT + '" width="' + w + '" height="' + innerH + '" fill="' + colorFor(s.status) + '" opacity="0.85" style="cursor:crosshair"' +
      ' data-ts="' + escapeHtml(String(s.timestamp)) + '"' +
      ' data-status="' + escapeHtml(s.status) + '"/>';
  }).join("");
  var xTicks = _chartXTicksSVG(t0, t1, padL, padT, innerW, innerH);
  var hasDynamic = samples.some(function (s) { return s.status === "dynamic"; });
  var legend =
    '<g font-size="10" fill="currentColor">' +
      '<rect x="' + padL + '" y="2" width="10" height="6" fill="' + MONITOR_STATE_COLORS.up + '"/><text x="' + (padL + 14) + '" y="8">up</text>' +
      '<rect x="' + (padL + 50) + '" y="2" width="10" height="6" fill="' + MONITOR_STATE_COLORS.warning + '"/><text x="' + (padL + 64) + '" y="8">partial</text>' +
      '<rect x="' + (padL + 110) + '" y="2" width="10" height="6" fill="' + MONITOR_STATE_COLORS.down + '"/><text x="' + (padL + 124) + '" y="8">down</text>' +
      (hasDynamic ? '<rect x="' + (padL + 160) + '" y="2" width="10" height="6" fill="#7b8794"/><text x="' + (padL + 174) + '" y="8">dynamic</text>' : '') +
    '</g>';
  var clipId = _chartClipId("ipsecStat");
  container.innerHTML =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      _chartClipDefs(clipId, padL, padT, innerW, innerH) +
      xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      _maintenanceBandLayer(t0, t1, padL, padT, innerW, innerH) +
      '<g ' + _chartClipAttr(clipId) + '>' +
        bars +
      '</g>' +
      legend +
    '</svg>' + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";
  _stashChartGeometry(container, t0, t1, padL, innerW, W);
  _wireChartTooltip(container, function (target) {
    return '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(target.getAttribute("data-ts"))) + '</div>' +
      '<div>Status: ' + escapeHtml(target.getAttribute("data-status")) + '</div>';
  });
  _addChartScreenshotButton(container, "IPsec status", { yAxis: "Status", subject: opts.subject, getStats: _statsSummaryFrom("ipsec-stats") });
  _observeChartResize(container, function (c) { _renderIpsecStatusChart(c, samples, opts); });
}

function _renderIpsecBpsChart(container, derived, side, opts) {
  opts = opts || {};
  var values = derived.map(function (d) { return { ts: d.timestamp, v: side === "in" ? d.inBps : d.outBps }; })
                     .filter(function (e) { return typeof e.v === "number"; });
  if (values.length === 0) {
    container.textContent = "No throughput samples yet — IPsec data is collected on the system-info cadence (~10 min).";
    return;
  }
  var W = container.clientWidth || 600, H = 160;
  var padL = 56, padR = 10, padT = 10, padB = 28;
  var innerW = W - padL - padR, innerH = H - padT - padB;
  var samplesForBounds = values.map(function (e) { return { timestamp: e.ts }; });
  var bounds = _chartTimeBounds(samplesForBounds, opts.since, opts.until);
  var t0 = bounds.t0, t1 = bounds.t1;
  var spanMs = t1 - t0, oneDayMs = 86400000;
  var pad2 = _chartPad2;
  var maxV = Math.max.apply(null, values.map(function (e) { return e.v; }));
  if (maxV < 1000) maxV = 1000;
  function tidyCeil(n) {
    var exp = Math.pow(10, Math.floor(Math.log10(n)));
    var mant = n / exp;
    var step = mant <= 1 ? 1 : mant <= 2 ? 2 : mant <= 5 ? 5 : 10;
    return step * exp;
  }
  var ceil = tidyCeil(maxV);
  var xFor = _chartXScale(padL, innerW, t0, t1);
  var yFor = _chartYScale(padT, innerH, 0, ceil);
  var pts = values.map(function (e) { return xFor(e.ts) + "," + yFor(e.v); }).join(" ");
  var hits = values.map(function (e) {
    return '<circle class="chart-hit" cx="' + xFor(e.ts) + '" cy="' + yFor(e.v) + '" r="6" fill="transparent" style="cursor:crosshair"' +
      ' data-ts="' + escapeHtml(String(e.ts)) + '" data-v="' + e.v + '"/>';
  }).join("");
  var ticks = "";
  for (var i = 0; i <= 4; i++) {
    var v = ceil * i / 4;
    var y = padT + innerH - (i / 4) * innerH;
    ticks +=
      '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (padL - 4) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + _fmtBitsPerSec(v) + '</text>';
  }
  var xTicks = _chartXTicksSVG(t0, t1, padL, padT, innerW, innerH);
  var color = side === "in" ? "var(--color-accent)" : "#f4a261";
  var clipId = _chartClipId("ipsecBps");
  container.innerHTML =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      _chartClipDefs(clipId, padL, padT, innerW, innerH) +
      ticks + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      _maintenanceBandLayer(t0, t1, padL, padT, innerW, innerH) +
      '<g ' + _chartClipAttr(clipId) + '>' +
        '<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.5"/>' +
        values.map(function (e) { return '<circle cx="' + xFor(e.ts) + '" cy="' + yFor(e.v) + '" r="1.5" fill="' + color + '"/>'; }).join("") +
        hits +
      '</g>' +
    '</svg>' + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";
  _stashChartGeometry(container, t0, t1, padL, innerW, W);
  _wireChartTooltip(container, function (target) {
    return '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(target.getAttribute("data-ts"))) + '</div>' +
      '<div>' + (side === "in" ? "Incoming" : "Outgoing") + ': ' + _fmtBitsPerSec(Number(target.getAttribute("data-v"))) + '</div>';
  });
  _addChartScreenshotButton(container, side === "in" ? "IPsec incoming" : "IPsec outgoing", { yAxis: "Throughput (bits/s)", subject: opts.subject, getStats: _statsSummaryFrom("ipsec-stats") });
  _observeChartResize(container, function (c) { _renderIpsecBpsChart(c, derived, side, opts); });
}
