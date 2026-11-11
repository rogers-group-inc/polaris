/**
 * public/js/assets-charts.js — the asset slide-over's chart kit: the rollup-tier peak line, legend
 * toggles and series visibility prefs, the failure-aware series and outage
 * markers, drag-to-zoom and the stats strip, the chart tooltip, resize and
 * PNG capture, maintenance-window and automation-severity bands, the CPU and
 * memory charts with the memory forecast and the sessions chart, and the
 * table-screenshot cell readers.
 *
 * Part of the Assets page script (CQ-F050): plain browser scripts sharing
 * page globals, loaded right after assets.js on every page that carries it
 * and in app-panels.js's asset bundle, in ASSETS_FILES order. Nothing here
 * runs at load beyond listener wiring. See tests/unit/assetsSplit.test.ts.
 */

// ─── Bucket-peak (max) line on rollup tiers ────────────────────────────────
//
// On the hourly and daily tiers a chart's solid line is each bucket's
// AVERAGE, which flattens a five-minute spike to nothing over an hour. The
// rollups keep each bucket's MAX as well, so every rollup chart draws it as a
// fine dashed line (`2 3` — finer than the response-time chart's `4,3`
// packet-loss dash, which is what keeps the two apart) in its series' colour,
// UNDER the average. It is a NAMED series: one toggle per chart, persisted per
// user in the charts prefs map under "<chartKey>:max", default on — unlike a
// per-dimension (core) toggle, which is not persisted. Its chip only exists on
// a rollup tier, where there is a max to draw. Hiding it rescales the y-axis
// to the averages; the tooltip names both readings either way, so a huge max
// never hides the average and switching the line off never hides the peak.

// "hourly" | "daily" when the history payload reads a rollup tier, else null.
function _chartRollupTier(data) {
  if (!data) return null;
  if (data.tier === "hourly" || data.tier === "daily") return data.tier;
  var bs = typeof data.bucketSeconds === "number" ? data.bucketSeconds : 0;
  if (bs > 0) return bs >= 86400 ? "daily" : "hourly";
  return null;
}
function _getMaxLinePref(chartKey) {
  return _getChartRangePref(chartKey + ":max", "on") !== "off";
}
function _setMaxLinePref(chartKey, on) {
  _setChartRangePref(chartKey + ":max", on ? "on" : "off");
}
// The legend chip: a short dashed-line swatch instead of a colour square (the
// line takes each series' colour, so no single colour names it). Its off look
// mirrors _seriesChipHTML — the strikethrough carries the state, the label
// keeps most of its ink because the chip is the only route back.
//
// The swatch is a CSS-gradient dash (2px on, 3px off — the line's own
// `2 3`), NOT an inline <svg>: the chip sits inside the chart container ahead
// of the plot, and the drag-select, tooltip and camera all find the plot with
// container.querySelector("svg") — a swatch svg would win that lookup.
// `color` is the swatch: the series colour on a single-series chart, so the
// key matches the line it toggles. Omitted where the max lines come in several
// colours (cores, members, in/out) and the swatch can only say "all of them":
// the primary text colour then, never grey, which is the Parent down colour.
// A gradient reference (severity shading) cannot be a CSS background, so it
// falls back to the accent the un-shaded line uses.
function _maxLineChipHTML(chartKey, tier, on, color) {
  var sw = !color ? "var(--color-text-primary)" : (/^url\(/.test(color) ? "var(--color-accent)" : color);
  var span = tier === "daily" ? "day" : "hour";
  return '<span class="chart-max-chip" data-max-chart="' + escapeHtml(chartKey) + '"' +
    ' title="' + escapeHtml((on ? "Click to hide" : "Click to show") + " the dashed line of each " + span + "'s highest reading") + '"' +
    ' style="cursor:pointer;display:inline-flex;align-items:center;gap:4px;user-select:none' +
    (on ? '' : ';opacity:0.8;text-decoration:line-through') + '">' +
    '<span class="chart-max-swatch" aria-hidden="true" style="width:15px;height:2px;flex:0 0 auto;' +
      'background-image:linear-gradient(to right,' + sw + ' 0,' + sw + ' 2px,transparent 2px,transparent 5px);' +
      'background-size:5px 2px;background-repeat:repeat-x' + (on ? '' : ';opacity:0.45') + '"></span>' +
    escapeHtml("Max (" + tier + " peak)") + '</span>';
}
// A chip-only legend row for a chart whose own legend lives inside its SVG
// (CPU & Memory, interface throughput) or that has none (hardware sensor).
// Empty off a rollup tier.
function _maxLineLegendRowHTML(chartKey, tier, color) {
  if (!tier) return "";
  return '<div class="chart-max-legend" style="display:flex;flex-wrap:wrap;gap:4px 10px;font-size:0.72rem;color:var(--color-text-secondary);margin-bottom:2px">' +
    _maxLineChipHTML(chartKey, tier, _getMaxLinePref(chartKey), color) + '</div>';
}
// Wires every Max chip for `chartKey` under `root`: flip the pref, re-render.
function _wireMaxLineChip(root, chartKey, rerender) {
  if (!root) return;
  root.querySelectorAll(".chart-max-chip").forEach(function (chip) {
    if (chip.getAttribute("data-max-chart") !== chartKey) return;
    chip.addEventListener("click", function () {
      _setMaxLinePref(chartKey, !_getMaxLinePref(chartKey));
      rerender();
    });
  });
}
// The dashed max line. `pts` is in time order, each `{x, y, color?}` or null —
// a null (a bucket with no max: written before the column existed, or a
// response-time bucket with no successes) BREAKS the line rather than bridging
// it. A per-point `color` splits the line where it changes; the segment into a
// point takes that point's colour. Goes inside the chart's clip-path group,
// before the average line it sits under.
function _maxLineSVG(pts, color, opts) {
  opts = opts || {};
  var width = opts.width || 1.25;
  var opacity = opts.opacity != null ? opts.opacity : 0.85;
  var extra = opts.attrs || "";
  var out = "";
  var run = [];
  function cOf(p) { return p.color || color; }
  function poly(list) {
    out += '<polyline class="chart-max-line"' + extra + ' points="' +
      list.map(function (p) { return p.x + "," + p.y; }).join(" ") +
      '" fill="none" stroke="' + cOf(list[list.length - 1]) + '" stroke-width="' + width +
      '" stroke-dasharray="2 3" stroke-linejoin="round" opacity="' + opacity + '"/>';
  }
  function flush() {
    if (run.length === 1) {
      // A lone bucket between two gaps: a dash needs two points, so a dot.
      out += '<circle class="chart-max-line"' + extra + ' cx="' + run[0].x + '" cy="' + run[0].y + '" r="' + width +
        '" fill="' + cOf(run[0]) + '" opacity="' + opacity + '"/>';
    } else if (run.length > 1) {
      var start = 0;
      for (var j = 2; j < run.length; j++) {
        if (cOf(run[j]) !== cOf(run[j - 1])) { poly(run.slice(start, j)); start = j - 1; }
      }
      poly(run.slice(start));
    }
    run = [];
  }
  (pts || []).forEach(function (p) {
    if (!p || !isFinite(p.x) || !isFinite(p.y)) { flush(); return; }
    run.push(p);
  });
  flush();
  return out;
}
// Tooltip fragment naming both readings of a rollup bucket: "<avg> avg · <max> max".
function _avgMaxText(avgText, maxText) {
  return escapeHtml(avgText) + ' avg<span style="color:var(--color-text-secondary)"> · ' +
    escapeHtml(maxText != null && maxText !== "" ? maxText : "—") + ' max</span>';
}
// Storage chart view mode (Used % vs Used bytes). Single string per user
// because operators tend to think in one mental model across the whole
// fleet, not per-asset.
function _getStorageViewPref() {
  if (!currentUsername) return "pct";
  try {
    var v = localStorage.getItem("polaris-prefs-storage-view-" + currentUsername);
    return v === "bytes" ? "bytes" : "pct";
  } catch (_) { return "pct"; }
}
function _setStorageViewPref(view) {
  if (!currentUsername) return;
  try {
    localStorage.setItem("polaris-prefs-storage-view-" + currentUsername, view === "bytes" ? "bytes" : "pct");
  } catch (_) {}
}

// ─── Telemetry chart series visibility (legend toggles) ────────────────────
//
// Both CPU & Memory charts let an operator click a legend chip to take a
// series out of the drawing. The two halves keep their state in different
// places, on purpose:
//
//   memory bands   PERSISTED per user, here. The bands are named and mean
//                  the same thing on every host, so a way of reading memory
//                  is an opinion an operator holds, not a per-visit whim.
//   cpu cores      NOT persisted — see _cpuHiddenCores, which keeps them on
//                  the container. Core 5 of one host has nothing to do with
//                  core 5 of another, so carrying the choice between assets
//                  would hide a different core every time.
//
// CACHE SHIPS OFF. Page cache is reclaimable: the OS fills whatever RAM the
// processes are not using and hands it straight back when they want it. Drawn
// in the stack it makes a perfectly healthy host look nearly full, which is
// the single most common misreading of this chart — so the default answers
// "how much memory is actually spoken for" and the chip is right there,
// visibly off, for anyone who wants the whole picture.
var _MEM_BANDS_OFF_BY_DEFAULT = ["cache"];

function _memBandVisible(key) {
  var fallback = _MEM_BANDS_OFF_BY_DEFAULT.indexOf(key) === -1;
  if (!currentUsername) return fallback;
  try {
    var raw = localStorage.getItem("polaris-prefs-series-" + currentUsername);
    var p = raw ? JSON.parse(raw) : null;
    var v = p && p["mem:" + key];
    // Absent means "never touched this chip", which is the default — not
    // false. Only an explicit boolean overrides.
    return typeof v === "boolean" ? v : fallback;
  } catch (_) { return fallback; }
}

function _setMemBandVisible(key, on) {
  if (!currentUsername) return;
  try {
    var raw = localStorage.getItem("polaris-prefs-series-" + currentUsername);
    var p = raw ? (JSON.parse(raw) || {}) : {};
    p["mem:" + key] = !!on;
    localStorage.setItem("polaris-prefs-series-" + currentUsername, JSON.stringify(p));
  } catch (_) {}
}

// Which cores the operator has hidden on THIS chart, as a Set of core index
// strings (plus "avg" for the aggregate line). Kept on the container's
// dataset rather than in a module variable because the resize observer and
// the 60-second silent refresh both re-render — state held anywhere else is
// lost on every tick, which makes hiding a core useless for the one job it
// has, watching the others.
function _cpuHiddenCores(container) {
  var raw = (container && container.dataset ? container.dataset.coresOff : "") || "";
  var out = {};
  raw.split(",").forEach(function (k) { if (k !== "") out[k] = true; });
  return out;
}

function _setCpuHiddenCores(container, hidden) {
  var keys = Object.keys(hidden).filter(function (k) { return hidden[k]; });
  if (keys.length === 0) delete container.dataset.coresOff;
  else container.dataset.coresOff = keys.join(",");
}

// Per-asset memory forecast-overlay visibility — the storage pref below, one
// level up (memory has no mount dimension). Default OFF (operator decision
// 2026-10-27): absent entry = off, so the dashed projection appears only on an
// asset someone switched it on for. Both choices are stored, so an asset
// toggled either way before the default flipped keeps that choice.
function _getMemoryForecastVisible(assetId) {
  if (!currentUsername || !assetId) return false;
  try {
    var raw = localStorage.getItem("polaris-prefs-memory-forecast-" + currentUsername);
    var p = raw ? JSON.parse(raw) : null;
    return !!(p && p[assetId] === true);
  } catch (_) { return false; }
}
function _setMemoryForecastVisible(assetId, visible) {
  if (!currentUsername || !assetId) return;
  try {
    var raw = localStorage.getItem("polaris-prefs-memory-forecast-" + currentUsername);
    var p = raw ? (JSON.parse(raw) || {}) : {};
    p[assetId] = !!visible;
    localStorage.setItem("polaris-prefs-memory-forecast-" + currentUsername, JSON.stringify(p));
  } catch (_) {}
}

// Per-(asset, mount) forecast-overlay visibility. Default on; only stored
// when the operator explicitly toggles it off (or back on after toggling
// off) — absent entry = default on.
function _getStorageForecastVisible(assetId, mountPath) {
  if (!currentUsername || !assetId || !mountPath) return true;
  try {
    var raw = localStorage.getItem("polaris-prefs-storage-forecast-" + currentUsername);
    var p = raw ? JSON.parse(raw) : null;
    var v = p && p[assetId + ":" + mountPath];
    return v === false ? false : true;
  } catch (_) { return true; }
}
function _setStorageForecastVisible(assetId, mountPath, visible) {
  if (!currentUsername || !assetId || !mountPath) return;
  try {
    var raw = localStorage.getItem("polaris-prefs-storage-forecast-" + currentUsername);
    var p = raw ? (JSON.parse(raw) || {}) : {};
    p[assetId + ":" + mountPath] = !!visible;
    localStorage.setItem("polaris-prefs-storage-forecast-" + currentUsername, JSON.stringify(p));
  } catch (_) {}
}

// Per-asset collapsed-interface persistence. Storage shape:
//   { "<assetId>": ["wan1", "agg1", ...] }  // collapsed parent ifNames
// Same per-user keying as chart-range prefs. Per-asset because the same parent
// name on different assets can have wildly different children.
// `scope` picks the storage key: the System tab's interface tree (default)
// and the Stations tab's wireless tree keep separate collapsed sets, since a
// radio and an interface can share a name and neither should collapse the
// other. Existing callers pass no scope and keep the original key.
function _getCollapsedIfaces(assetId, scope) {
  if (!currentUsername || !assetId) return new Set();
  try {
    var raw = localStorage.getItem("polaris-prefs-" + (scope || "iface") + "-collapse-" + currentUsername);
    var p = raw ? JSON.parse(raw) : null;
    var arr = (p && p[assetId]) || [];
    return new Set(arr);
  } catch (_) { return new Set(); }
}
function _setCollapsedIfaces(assetId, collapsedSet, scope) {
  if (!currentUsername || !assetId) return;
  try {
    var raw = localStorage.getItem("polaris-prefs-" + (scope || "iface") + "-collapse-" + currentUsername);
    var p = raw ? (JSON.parse(raw) || {}) : {};
    if (collapsedSet.size === 0) delete p[assetId];
    else p[assetId] = Array.from(collapsedSet);
    localStorage.setItem("polaris-prefs-" + (scope || "iface") + "-collapse-" + currentUsername, JSON.stringify(p));
  } catch (_) {}
}

// Screenshot-options persistence (the section-picker modal behind the asset
// details Screenshot button). Storage shape, keyed by tab key:
//   { "system": { sections: { interfaces: false, ... }, includeHiddenIfaces: true } }
// A missing section key means checked. Chart ranges are intentionally NOT
// persisted — they default to whatever the live chart shows when the modal
// opens. Writes replace the tab's entry wholesale with only the keys present
// in the live panel, so section keys from assets that no longer render a
// given section age out naturally.
function _getScreenshotPrefs() {
  if (!currentUsername) return {};
  try {
    var raw = localStorage.getItem("polaris-prefs-screenshot-" + currentUsername);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch (_) { return {}; }
}
function _setScreenshotPrefs(tabKey, obj) {
  if (!currentUsername || !tabKey) return;
  try {
    var p = _getScreenshotPrefs();
    p[tabKey] = obj;
    localStorage.setItem("polaris-prefs-screenshot-" + currentUsername, JSON.stringify(p));
  } catch (_) {}
}

// Render a chart range-button bar with the saved (or default) range marked as
// primary. `entries` is a list of { value, label, id? }; each rendered button
// carries `data-range="<value>"` so existing click handlers work unchanged.
function _chartRangeBtnsHTML(barClass, entries, prefKey, fallback) {
  var active = _getChartRangePref(prefKey, fallback);
  return entries.map(function (e) {
    var primary = e.value === active;
    var idAttr = e.id ? ' id="' + e.id + '"' : '';
    return '<button class="btn btn-sm ' + (primary ? 'btn-primary' : 'btn-secondary') + ' ' + barClass +
      '" data-range="' + e.value + '"' + idAttr + '>' + e.label + '</button>';
  }).join("");
}

// Lookback-overflow clipping helpers. The history endpoints fetch ~1 bucket
// of samples BEFORE the visible window so the chart's polyline enters from
// the left edge with continuous data instead of starting partway through;
// see the "Time-series chart (SVG)" section of polaris-ui-canon. The chart
// renderer hides those pre-since samples by wrapping every data-drawing
// element (polyline / dots / failure lines / hit targets) in a <g> bound
// to a per-chart clipPath that matches the inner plot area exactly.
//
// _chartClipDefs returns the <defs>…</defs> string that declares the
// clipPath; _chartClipAttr returns the matching `clip-path="…"` attribute.
// Each chart instance derives a unique id from its container so multiple
// charts on the same page don't collide.
var _chartClipSeq = 0;
function _chartClipId(prefix) {
  _chartClipSeq += 1;
  return "polaris-chart-clip-" + (prefix || "x") + "-" + _chartClipSeq;
}
function _chartClipDefs(id, padL, padT, innerW, innerH) {
  return '<defs><clipPath id="' + id + '">' +
    '<rect x="' + padL + '" y="' + padT + '" width="' + innerW + '" height="' + innerH + '"/>' +
    '</clipPath></defs>';
}
function _chartClipAttr(id) {
  return 'clip-path="url(#' + id + ')"';
}

// The four verdict hexes below, the outage-marker helpers, _inChartWindow,
// _derivePerIntervalSeries and the memory band tables live ONCE in
// public/js/chart-shared.js (PolarisChartShared), shared with the phone; the
// asset-detail helpers likewise in public/js/asset-shared.js. Here they are
// aliases and three-line wrappers that keep the desktop names, so both
// modules must load before this file (tests/unit/assetSharedModules.test.ts).
//
// Failed-poll color shared by every failure-aware chart element (red baseline
// dots, fade-to-red line segments). Matches the danger hue the tooltips use.
var _CHART_FAIL_COLOR = PolarisChartShared.FAIL_COLOR;

// The dependency-down grey. A probe that missed while the asset was
// dependency-suppressed (its parent was dark) draws the SAME dive as an
// outage — nothing was measured either way — but drained of alarm, because
// Polaris knows exactly why it missed and the device itself is not being
// accused of anything. Reserved for that one meaning; red stays the
// unexplained outage. Flat hex like _CHART_FAIL_COLOR: it has to read on all
// three themes and is duplicated in utils/sparklineSvg.ts (DEP_COLOR) so the
// alert email and the device page draw one outage the same way.
var _CHART_DEP_COLOR = PolarisChartShared.DEP_COLOR;

// The response-time series is drawn in the UP green rather than the theme
// accent, so the one chart that is ABOUT reachability speaks the same four
// colors as the Status pill and the Last-30-min strip: green up, amber missed,
// purple paying it back, red down. Every other chart (CPU, memory, interface
// counters) keeps its own series color — those are about a reading, not a
// verdict, and recoloring them would make green mean two different things.
// A token, not a hex, so all three themes get their own success green.
var _CHART_UP_COLOR = "var(--color-success)";

// A missed poll that has NOT yet reached the covering automation's count. The
// probe failed, but the device is short of answers rather than judged Down
// (business rule 36) — the same "Missed" the Status pill reports and the same
// amber cell the Last-30-min strip draws directly above this chart. Red is
// reserved for a miss that IS the verdict, so the chart shows an outage
// building rather than asserting one on the first dropped packet.
//
// EXACTLY the strip's amber (rgba(255,193,7,·)), not a deeper cousin picked for
// contrast: the strip sits directly above this chart, so two ambers a shade
// apart read as two different meanings rather than one. The polling-method
// transition markers spend the same hue on this chart, but at a lighter opacity
// and as full-height dashed lines with a dot above the plot — different shape,
// different weight, and never on the baseline where a missed poll sits.
var _CHART_MISS_COLOR = PolarisChartShared.MISS_COLOR;

// A poll that ANSWERED while missed polls are still outstanding. Same meaning
// and same hue as the blue cell on the Last-30-min strip: the device is
// answering, it just has not paid the debt off yet. Kept a flat hex for the
// same reason the fail/dep colors are — it must read on all three themes AND on
// the alert email's white card, which is why it is the deeper light-blue 700
// rather than the pale #4fc3f7 the Recovering PILL tints itself with.
//
// It was PURPLE until 2026-08-29, chosen when this chart's series was still the
// theme accent and blue would have collided with it. The series is the Up green
// now, so blue is free — and it is the better answer twice over: it agrees with
// the Recovering pill (which was repointed at this exact value in the same
// change, having been keyed to var(--color-accent) and therefore rendering GOLD
// on the morning theme) instead of contradicting it, and it puts real distance
// between this and the lavender #9575cd that means MAINTENANCE on the same
// chart, which the magenta-leaning purple only ever held by a shade.
//
// #0288d1 is also POLARIS_HEALTH_COLORS.recovering, which the Device Map has
// used for the same state all along. Convergent, NOT shared: that map is
// deliberately its own palette (see the comment on it in api.js) — do not make
// either one read the other.
var _CHART_RECOVER_COLOR = PolarisChartShared.RECOVER_COLOR;

/**
 * "#rrggbb" + alpha → "rgba(r,g,b,a)". Exists because the Last-30-min strip
 * paints its cells at a fixed translucency while the colour ITSELF is now a
 * variable — the Down cell takes the covering automation's severity colour,
 * which arrives as a flat hex from PolarisChartSeverity.downColorOf. A
 * malformed input returns the string untouched, so a bad value shows up as a
 * missing cell rather than a silently wrong hue.
 */
function _hexWithAlpha(hex, alpha) {
  var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return hex;
  var n = parseInt(m[1], 16);
  return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + alpha + ")";
}

// The stroke/dot color for one plot point. `ok:false` points carry `dep:true`
// when the miss was explained and `downColor` when the covering automation's
// severity is known; `ok:true` points carry `rec:true` when misses were still
// outstanding at that probe. Single decider so a dive can never come out half
// grey and half red, and so the climb back out cannot come out half green and
// half blue.
//
// Note an `ok` point can no longer be `down`: since 2026-09-01 an answered
// probe is `recovering` whatever the bucket level (business rule 30), which is
// what closed the red → GREEN → blue → green artefact — an answered probe taken
// while the bucket was still above the threshold read `down`, and with no way to
// paint an `ok` point in the down colour it fell through to the series green.
function _chartPointColor(p, seriesColor) {
  return PolarisChartShared.chartPointColor(p, seriesColor);
}

// Failure-aware line rendering. `pts` is a time-ordered list of
// { x, y, ok } plot points where failed polls sit at the chart baseline
// (y = padT + innerH) with ok:false. Consecutive OK points connect in the
// series color, consecutive failures connect in red along the baseline, and
// each OK↔fail transition segment gets its own userSpaceOnUse linearGradient
// so the line visibly fades from the series color into red (and back) instead
// of jumping. Returns { defs, segments } SVG strings; `idPrefix` must be
// unique per render (the chart's clipId works) so gradient ids never collide
// across charts.
function _failureAwareSeriesSVG(pts, seriesColor, idPrefix) {
  var defs = "";
  var segs = "";
  for (var i = 1; i < pts.length; i++) {
    var a = pts[i - 1], b = pts[i];
    var ca = _chartPointColor(a, seriesColor), cb = _chartPointColor(b, seriesColor);
    var stroke;
    // Compare COLORS, not ok flags: a red outage running straight into a grey
    // dependency stretch (the parent went down part-way through) is a
    // transition too, and fading between them is what shows where the reason
    // changed.
    if (ca === cb) {
      stroke = ca;
    } else {
      var gid = idPrefix + "-seg-" + i;
      defs += '<linearGradient id="' + gid + '" gradientUnits="userSpaceOnUse"' +
        ' x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '">' +
        '<stop offset="0%" stop-color="' + ca + '"/>' +
        '<stop offset="100%" stop-color="' + cb + '"/>' +
        '</linearGradient>';
      stroke = 'url(#' + gid + ')';
    }
    segs += '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y +
      '" stroke="' + stroke + '" stroke-width="1.5"/>';
  }
  return { defs: defs, segments: segs };
}

// Red baseline dots for failed polls — one per failure point in `pts`
// (companions to _failureAwareSeriesSVG). Slightly larger than the 1.5px
// series dots so a lone failure is visible at a glance.
function _failureDotsSVG(pts) {
  return pts.filter(function (p) { return !p.ok; }).map(function (p) {
    return '<circle cx="' + p.x + '" cy="' + p.y + '" r="2.5" fill="' + _chartPointColor(p, null) + '"/>';
  }).join("");
}

// Median sampling cadence of a time-ordered series, in ms. Needs >= 3
// timestamps to have a meaningful middle. Sizes the hole test in
// _seriesReportedThrough below.
function _medianCadenceMs(timestampsMs) {
  return PolarisChartShared.medianCadenceMs(timestampsMs);
}

// Missed-poll markers for the streams that carry no per-sample success flag —
// telemetry (CPU / memory), storage, interface counters. A failed poll on any
// of those leaves no row at all, because the heavy cadences do not RUN while
// an asset is down (runsHeavyCadences gates them on `up`), so there is nothing
// in those tables to mark.
//
// The record therefore lives in the one stream that kept measuring: the
// response-time probe, which runs in every state and writes a real
// success:false row per interval. The chart endpoints serve it as `outages` —
// [{from, to}] stretches during which every probe failed (built by
// services/probeOutageService.ts).
//
// This replaced a 2.5x-median-cadence gap heuristic. That guess could not tell
// an outage from a disk that was unmounted, from a metric this device never
// reports, or from an operator widening the cadence — and it drew a red dive
// straight through maintenance windows, which is backwards (a band means the
// gap is explained; a dive means it isn't). Polling stops entirely during
// maintenance, so a maintenance window contains no failed probes and yields no
// outage, with no special case needed.
//
// One marker at each end of an outage so the line dives to the baseline and
// climbs back out; an outage that lasted a single probe collapses to one
// marker, which is what one missed poll looks like.
//
// Each window carries a `kind`: "dependency" means every probe in it missed
// while the asset was dependency-suppressed — its parent was dark, so the hole
// is explained and its markers draw grey instead of red. The shape is
// identical, because nothing was measured either way; only the accusation
// changes. Markers come back as { t, dep } objects rather than bare timestamps
// for exactly that reason.
//
// `sampleTimesMs` is the series' OWN good timestamps, and a window the series
// kept reporting through is dropped: the Polaris Agent pushes on its own
// schedule and is not gated on monitorStatus, so an agent host can keep
// reporting CPU straight through an outage of the server-side probe transport.
// Diving a line that has data would misreport the data we are actually holding.
// See _seriesReportedThrough for what "kept reporting" means.
function _outageMarkers(outages, sampleTimesMs) {
  return PolarisChartShared.outageMarkers(outages, sampleTimesMs);
}

// Did the series keep reporting through the outage [from, to]? Two pieces of
// evidence, either one enough:
//
//   • a sample strictly INSIDE the window — the agent case, where the host
//     pushed readings while the probe transport could not reach it;
//   • NO HOLE around the window — the last sample at or before `from` and the
//     first at or after `to` sit no further apart than the series' normal
//     cadence (1.5x, for jitter). That is a blip shorter than the series'
//     own interval whose neighbouring polls both succeeded: nothing is missing.
//
// This replaced a guard that padded the window by half the cadence on each
// side and discarded it when ANY sample fell in the padding. The last good
// poll before a device drops and the first one after it recovers land right
// next to the outage's edges almost every time — telemetry runs every 5-10
// minutes against a probe every minute — so that guard threw away most real
// outages and the line bridged straight across them. On the hourly and daily
// tiers the padding grew to 30 minutes and 12 hours and swallowed nearly
// every window, which is why wider ranges showed no misses at all.
//
// The hole test is the old gap heuristic used only as a VETO: a hole never
// creates a marker (only the probe's record does), it can only prove there
// was no hole to mark. `to` on a rollup tier is the END of the last failed
// bucket, i.e. the next bucket's start, so the neighbour lookups are
// inclusive and the interior test is strict.
function _seriesReportedThrough(times, cadenceMs, from, to) {
  return PolarisChartShared.seriesReportedThrough(times, cadenceMs, from, to);
}

// The three things every chart does with those markers, kept together so a new
// chart can't wire up two of them and forget the third — and so the grey lives
// in one place. `_outagePts` returns baseline plot points to merge into the
// series; the other two return SVG.
function _outagePts(markers, xFor, baselineY) {
  return (markers || []).map(function (m) {
    return { t: m.t, x: xFor(m.t), y: baselineY, ok: false, dep: m.dep };
  });
}
function _outageDotsSVG(markers, xFor, baselineY) {
  return (markers || []).map(function (m) {
    return '<circle cx="' + xFor(m.t) + '" cy="' + baselineY + '" r="2.5" fill="' +
      (m.dep ? _CHART_DEP_COLOR : _CHART_FAIL_COLOR) + '"/>';
  }).join("");
}
// Tooltip body for a missed-poll hit target. A dependency miss names the
// reason instead of reading as a bare failure — "no data collected" with no
// explanation is what sends an operator hunting a device that was fine.
function _missTooltipHTML(target) {
  var dep = target.getAttribute("data-dep") === "1";
  return '<div style="font-weight:600;margin-bottom:2px">' +
    escapeHtml(_fmtTooltipTs(target.getAttribute("data-ts"))) + '</div>' +
    (dep
      ? '<div style="color:' + _CHART_DEP_COLOR + '">Dependency down — upstream device was down, not polled</div>'
      : '<div style="color:var(--color-danger,#d32f2f)">Missed poll — no data collected</div>');
}

function _outageHitsSVG(markers, xFor, padT, innerH) {
  return (markers || []).map(function (m) {
    return '<rect class="chart-hit" x="' + (xFor(m.t) - 5) + '" y="' + padT + '" width="10" height="' + innerH +
      '" fill="transparent" style="cursor:crosshair" data-ts="' + escapeHtml(new Date(m.t).toISOString()) +
      '" data-miss="1"' + (m.dep ? ' data-dep="1"' : '') + '/>';
  }).join("");
}

// Stash the rendered plot geometry on the chart container so the drag-select
// helper can translate mouse positions back into timestamps at event time.
// Re-renders replace the SVG but keep the container element, so the dataset
// is simply rewritten on every render and the wired listeners stay valid.
function _stashChartGeometry(container, t0, t1, padL, innerW, viewW) {
  if (!container || !container.dataset) return;
  container.dataset.geomT0 = String(t0);
  container.dataset.geomT1 = String(t1);
  container.dataset.geomPadL = String(padL);
  container.dataset.geomInnerW = String(innerW);
  container.dataset.geomViewW = String(viewW);
}

// Click-drag on a chart's plot area selects a time window and applies it as
// that chart's custom date range (works from any starting range — preset or
// custom). Geometry comes from the dataset stamped by _stashChartGeometry at
// render time. Drags under 6px fall through to normal click/hover behavior.
// The SVG renders with preserveAspectRatio="none" at width:100%, so client-x
// is scaled through the viewBox width before mapping onto the time axis.
function _wireChartDragSelect(container, applySelection) {
  if (!container || container._dragSelectWired) return;
  container._dragSelectWired = true;
  function geom() {
    var d = container.dataset;
    var g = {
      t0: Number(d.geomT0), t1: Number(d.geomT1),
      padL: Number(d.geomPadL), innerW: Number(d.geomInnerW), viewW: Number(d.geomViewW),
    };
    if (!isFinite(g.t0) || !isFinite(g.t1) || g.t1 <= g.t0 || !(g.innerW > 0) || !(g.viewW > 0)) return null;
    return g;
  }
  function tsAtClientX(clientX, svgEl, g) {
    var rect = svgEl.getBoundingClientRect();
    if (!(rect.width > 0)) return null;
    var xView = ((clientX - rect.left) / rect.width) * g.viewW;
    var frac = (xView - g.padL) / g.innerW;
    if (frac < 0) frac = 0;
    if (frac > 1) frac = 1;
    return g.t0 + frac * (g.t1 - g.t0);
  }
  container.addEventListener("mousedown", function (e) {
    if (e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest(".chart-screenshot-btn")) return;
    var svgEl = container.querySelector("svg");
    if (!svgEl || !(svgEl === e.target || svgEl.contains(e.target))) return;
    var g = geom();
    if (!g) return;
    e.preventDefault(); // stop text selection during the drag
    var startX = e.clientX;
    var box = null;
    function place(curX) {
      if (!box) {
        box = document.createElement("div");
        box.style.cssText = "position:absolute;top:" + svgEl.offsetTop + "px;height:" + svgEl.clientHeight +
          "px;background:rgba(79,195,247,0.16);border:1px solid rgba(79,195,247,0.65);pointer-events:none;z-index:4";
        container.appendChild(box);
      }
      var rect = container.getBoundingClientRect();
      var x0 = Math.min(startX, curX) - rect.left;
      var x1 = Math.max(startX, curX) - rect.left;
      box.style.left = x0 + "px";
      box.style.width = Math.max(1, x1 - x0) + "px";
    }
    function onMove(ev) {
      if (!box && Math.abs(ev.clientX - startX) < 6) return;
      ev.preventDefault();
      place(ev.clientX);
    }
    function onUp(ev) {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      var dragged = !!box;
      if (box && box.parentNode) box.parentNode.removeChild(box);
      box = null;
      if (!dragged || Math.abs(ev.clientX - startX) < 6) return;
      var ta = tsAtClientX(startX, svgEl, g);
      var tb = tsAtClientX(ev.clientX, svgEl, g);
      if (ta == null || tb == null) return;
      var from = Math.min(ta, tb), to = Math.max(ta, tb);
      if (to - from < 1000) return; // sub-second selections are noise
      applySelection(new Date(from).toISOString(), new Date(to).toISOString());
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// Reflect a drag-selected custom window in a chart's range-button bar: preset
// buttons drop to secondary, the Custom… button (when the surface has one)
// goes primary, and the custom From/To panel opens pre-filled with the
// selection so the operator can see — and fine-tune — the window that was
// just applied. `ui` = { btnClass, customBtnId?, panelId?, fromId?, toId? }.
function _applyCustomRangeSelection(ui, fromIso, toIso) {
  document.querySelectorAll("." + ui.btnClass).forEach(function (x) {
    x.classList.remove("btn-primary"); x.classList.add("btn-secondary");
  });
  var customBtn = ui.customBtnId ? document.getElementById(ui.customBtnId) : null;
  if (customBtn) { customBtn.classList.remove("btn-secondary"); customBtn.classList.add("btn-primary"); }
  var panel = ui.panelId ? document.getElementById(ui.panelId) : null;
  if (panel) panel.style.display = "flex";
  var fromInput = ui.fromId ? document.getElementById(ui.fromId) : null;
  var toInput = ui.toId ? document.getElementById(ui.toId) : null;
  if (fromInput) fromInput.value = _toLocalDatetimeInput(new Date(fromIso));
  if (toInput) toInput.value = _toLocalDatetimeInput(new Date(toIso));
}

// Renders a stats line into the given container using the canonical
// Response Time format (see polaris-ui-canon → "Time-series chart (SVG)"): leading "<count> samples"
// span (count bolded), then one "<Label>: <value>" span per metric.
// Flex gap on the container handles visual separation. Also writes a
// plaintext summary to container.dataset.summary for screenshot
// composers and tooltips. Pass count = 0 to render the empty-state
// message and clear the summary.
//
// parts: [{label: "Avg", value: "83 ms"}, ...] — entries with null/empty
// value are skipped so callers don't have to filter.
// Build a "View: Hourly avg" / "View: Daily avg" stats-line entry from the
// chart history response's tier discriminator. Returns null on the detail
// tier (or when the response predates the tier field) so callers can
// safely unshift the result and skip rendering. Wired through every chart
// loader's _renderChartStats call so operators see at a glance that they
// are looking at rollup aggregates rather than raw samples.
function _tierStatsPart(data) {
  if (!data) return null;
  var tier = data.tier;
  if (!tier || tier === "detail") return null;
  return { label: "View", value: tier === "hourly" ? "Hourly avg" : "Daily avg" };
}

function _renderChartStats(container, count, parts) {
  if (!container) return;
  // Apply the canonical layout styles directly so any stats container
  // looks identical regardless of how it was declared in markup.
  container.style.display = "flex";
  container.style.gap = "1.25rem";
  container.style.flexWrap = "wrap";
  if (!count) {
    container.textContent = "No samples in this range yet.";
    delete container.dataset.summary;
    return;
  }
  parts = Array.isArray(parts) ? parts : [];
  var html = '<span><strong>' + count + '</strong> samples</span>';
  var summary = count + " samples";
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (!p || p.value == null || p.value === "") continue;
    var label = String(p.label);
    var value = String(p.value);
    html += '<span><strong>' + escapeHtml(label) + ':</strong> ' + escapeHtml(value) + '</span>';
    summary += " · " + label.toLowerCase() + " " + value;
  }
  container.innerHTML = html;
  container.dataset.summary = summary;
}

// Bound a chart's X axis to the *requested* time window (since/until from the
// *History API) rather than the data's first/last timestamp. Without this,
// switching range from 24h to 7d on a host with only 24h of data leaves the
// X axis at 24h — the user can't see "no past data" because the data is
// re-stretched to fill the chart. Falls back to sample-derived bounds when no
// window is supplied.
// --- Shared chart scaffolding (2026-08 consolidation) ---
// The byte-identical closures every SVG chart renderer used to re-declare:
// zero-padded time parts, the calendar-aligned X-axis ticks, and the linear
// time->x / value->y scales. Renderers keep their own paddings, Y ticks, and
// series drawing -- those genuinely differ per chart.
// assets-compare.js (loaded after this file on assets.html) shares them.
function _chartPad2(n) { return n < 10 ? "0" + n : String(n); }
// X-axis ticks on CALENDAR boundaries, not on fifths of the window. The fifths
// every chart used to draw landed at arbitrary instants (a 7-day window ticked
// every 1.4 days: 9/17 18:36, 9/19 04:12 …), so a date-only label named a day
// it sat in the middle of, skipped whole days (9/18 and 9/22 never appeared),
// and never lined up with the dashed midnight lines _dateChangeMarkers draws.
// Now the step is the smallest "nice" one that keeps labels ≥ ~80px apart, and
// every tick is aligned to local time: a multiple of the step past local
// midnight for sub-day steps, local midnight itself (via setDate, so DST cannot
// drift it) for day steps — which puts a day tick exactly on its dashed line.
// Returns [{ ts, label }], each strictly inside [t0, t1].
var _CHART_TICK_STEPS_MS = [
  60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3,
  3600e3, 2 * 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3,
];
var _CHART_TICK_STEPS_DAYS = [1, 2, 3, 7, 14, 30];
function _chartTimeTicks(t0, t1, innerW) {
  var span = t1 - t0;
  if (!(span > 0)) return [];
  var maxTicks = Math.max(2, Math.floor((innerW || 600) / 80));
  var dayMs = 86400000;
  var out = [];
  var stepMs = null;
  // HH:MM labels only while _dateChangeMarkers still names each midnight line
  // (≤ 4 days); past that an hour label could belong to any of the days.
  if (span <= 4 * dayMs) {
    for (var i = 0; i < _CHART_TICK_STEPS_MS.length; i++) {
      // +1: a window that starts ON a boundary holds one more tick than intervals.
      if (Math.floor(span / _CHART_TICK_STEPS_MS[i]) + 1 <= maxTicks) { stepMs = _CHART_TICK_STEPS_MS[i]; break; }
    }
  }
  // Every tick, label and midnight is in the operator's display timezone
  // (chart-shared.js zone helpers; the browser's own zone on "auto").
  var Z = PolarisChartShared;
  if (stepMs != null) {
    var base = Z.zoneMidnight(t0);
    var ts = base + Math.ceil((t0 - base) / stepMs) * stepMs;
    for (var guard = 0; ts <= t1 && guard < 200; guard++, ts += stepMs) {
      var p = Z.zoneParts(ts);
      // A multi-day window names its midnights by date, not "00:00".
      var atMidnight = p.hour === 0 && p.minute === 0;
      out.push({
        ts: ts,
        label: atMidnight && span > dayMs
          ? p.month + "/" + p.day
          : _chartPad2(p.hour) + ":" + _chartPad2(p.minute),
      });
    }
    return out;
  }
  var stepDays = _CHART_TICK_STEPS_DAYS[_CHART_TICK_STEPS_DAYS.length - 1];
  for (var k = 0; k < _CHART_TICK_STEPS_DAYS.length; k++) {
    if (Math.floor(span / (_CHART_TICK_STEPS_DAYS[k] * dayMs)) + 1 <= maxTicks) { stepDays = _CHART_TICK_STEPS_DAYS[k]; break; }
  }
  var day = Z.zoneMidnight(t0);
  if (day < t0) day = Z.addZoneDays(day, 1);
  for (var g2 = 0; day <= t1 && g2 < 200; g2++) {
    var dp = Z.zoneParts(day);
    out.push({ ts: day, label: dp.month + "/" + dp.day });
    day = Z.addZoneDays(day, stepDays);
  }
  return out;
}
// The tick marks + labels for _chartTimeTicks, in the markup every renderer
// used to inline. A label within half its width of either end of the plot is
// anchored to that end instead of centred on it — a centred label on the last
// tick overhung the 10px right padding and was clipped by the SVG edge.
// `opts.dateLine` adds the M/D under the first tick and wherever the day
// changes (the response-time chart on a ≤24h window, whose labels are HH:MM).
function _chartXTicksSVG(t0, t1, padL, padT, innerW, innerH, opts) {
  opts = opts || {};
  var ticks = _chartTimeTicks(t0, t1, innerW);
  var right = padL + innerW;
  var out = "";
  var prevDay = null;
  for (var i = 0; i < ticks.length; i++) {
    var t = ticks[i];
    var x = padL + ((t.ts - t0) / (t1 - t0)) * innerW;
    var half = t.label.length * 3; // ~6px per glyph at font-size 10
    var anchor = "middle";
    if (x + half > right + 6) anchor = "end";
    else if (x - half < padL - 6) anchor = "start";
    out +=
      '<line x1="' + x + '" y1="' + (padT + innerH) + '" x2="' + x + '" y2="' + (padT + innerH + 3) + '" stroke="rgba(127,127,127,0.4)"/>' +
      '<text x="' + x + '" y="' + (padT + innerH + 14) + '" text-anchor="' + anchor + '" font-size="10" fill="currentColor">' + t.label + '</text>';
    if (opts.dateLine) {
      var dp = PolarisChartShared.zoneParts(t.ts);
      var key = dp.year + "-" + dp.month + "-" + dp.day;
      if (key !== prevDay) {
        out +=
          '<text x="' + x + '" y="' + (padT + innerH + 26) + '" text-anchor="' + anchor + '" font-size="10" fill="currentColor" opacity="0.7">' + dp.month + "/" + dp.day + '</text>';
        prevDay = key;
      }
    }
  }
  return out;
}
function _chartXScale(padL, innerW, t0, t1) {
  return function (ts) { return padL + ((new Date(ts).getTime() - t0) / (t1 - t0)) * innerW; };
}
function _chartYScale(padT, innerH, min, max) {
  return function (v) { return padT + innerH - ((v - min) / (max - min)) * innerH; };
}

function _chartTimeBounds(samples, since, until) {
  function ms(v) {
    if (v == null) return null;
    return typeof v === "number" ? v : new Date(v).getTime();
  }
  var t0 = ms(since);
  var t1 = ms(until);
  if (t0 == null && samples && samples.length) t0 = new Date(samples[0].timestamp).getTime();
  if (t1 == null && samples && samples.length) t1 = new Date(samples[samples.length - 1].timestamp).getTime();
  if (t0 == null) t0 = 0;
  if (t1 == null || t1 <= t0) t1 = t0 + 1;
  return { t0: t0, t1: t1 };
}

// The points a chart's stated figures describe: those at or after the visible
// window's left edge. History endpoints return lookback rows BEFORE `since`
// (anchored on rows — one for a gauge, two for a counter) only so the line
// enters from the edge; the clip-path hides them from the drawing, and every
// stats line, total and axis maximum must leave them out the same way, or a
// figure counts a reading the operator cannot see. `tsKey` names the
// timestamp field when it is not `timestamp`.
function _inChartWindow(points, since, tsKey) {
  return PolarisChartShared.inChartWindow(points, since, tsKey);
}

// Vertical dashed indicator at each local-midnight inside (t0, t1). The
// time-only tick labels on ≤24h ranges hide the day boundary, so without
// this the reader can't tell where the calendar date changes. Beyond 4d
// the tick labels themselves already encode the date, so the per-line
// "M/D" label is suppressed but the dashed line stays as a day separator.
function _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) {
  // Midnights of the operator's display timezone, like the ticks.
  var Z = PolarisChartShared;
  var d = Z.zoneMidnight(t0);
  if (d <= t0) d = Z.addZoneDays(d, 1);
  var withLabel = (t1 - t0) <= 4 * 86400000;
  var out = "";
  var safety = 0;
  while (d < t1 && safety++ < 64) {
    var x = padL + ((d - t0) / (t1 - t0)) * innerW;
    out +=
      '<line x1="' + x + '" y1="' + padT + '" x2="' + x + '" y2="' + (padT + innerH) +
      '" stroke="rgba(127,127,127,0.55)" stroke-width="1" stroke-dasharray="3,3"/>';
    if (withLabel) {
      var dp = Z.zoneParts(d);
      var label = dp.month + "/" + dp.day;
      out +=
        '<text x="' + (x + 4) + '" y="' + (padT + 11) +
        '" font-size="10" fill="currentColor" opacity="0.7">' + label + '</text>';
    }
    d = Z.addZoneDays(d, 1);
  }
  return out;
}

function _fmtSpeed(bps) {
  if (bps == null || isNaN(bps)) return "—";
  if (bps >= 1_000_000_000) return (bps / 1_000_000_000) + " Gbps";
  if (bps >= 1_000_000)     return (bps / 1_000_000)     + " Mbps";
  if (bps >= 1_000)         return (bps / 1_000)         + " Kbps";
  return bps + " bps";
}
function _fmtBitsPerSec(bps) {
  if (bps == null || isNaN(bps)) return "—";
  if (bps >= 1_000_000_000) return (bps / 1_000_000_000).toFixed(2) + " Gbps";
  if (bps >= 1_000_000)     return (bps / 1_000_000).toFixed(2)     + " Mbps";
  if (bps >= 1_000)         return (bps / 1_000).toFixed(2)         + " Kbps";
  return Math.round(bps) + " bps";
}
// Compact variant for chart y-axis ticks. Drops trailing ".00" on whole-unit
// values (so "100 Mbps" instead of "100.00 Mbps") and uses one decimal under
// 10 so labels still show enough resolution at small ceilings.
function _fmtBitsPerSecAxis(bps) {
  if (bps == null || isNaN(bps)) return "—";
  function pick(n, unit) {
    var s = n >= 10 ? Math.round(n).toString() : n.toFixed(1).replace(/\.0$/, "");
    return s + " " + unit;
  }
  if (bps >= 1_000_000_000) return pick(bps / 1_000_000_000, "Gbps");
  if (bps >= 1_000_000)     return pick(bps / 1_000_000,     "Mbps");
  if (bps >= 1_000)         return pick(bps / 1_000,         "Kbps");
  return Math.round(bps) + " bps";
}
// A chart point's time, on the same display-timezone clock as the axis under
// it (chart-shared.js zone helpers; CQ-F017). Every chart tooltip uses it.
function _fmtTooltipTs(ts) {
  function p(n) { return n < 10 ? "0" + n : String(n); }
  var d = new Date(ts);
  var tz = typeof timeZoneOpts === "function" ? timeZoneOpts() : {};
  var z = PolarisChartShared.zoneParts(d.getTime());
  return d.toLocaleDateString(undefined, Object.assign({ month: "short", day: "numeric", year: "numeric" }, tz)) +
    " " + p(z.hour) + ":" + p(z.minute) + ":" + p(z.second);
}

/**
 * Wire generic chart-tooltip behavior. Each <circle class="chart-hit"> on the
 * SVG has its data-* attributes formatted by `formatHTML(target)` and rendered
 * inside `tipEl` while the cursor is over that hit. Mirrors the response-time
 * chart's tooltip pattern but works for any line/bar chart.
 */
function _wireChartTooltip(container, formatHTML) {
  var tip = container.querySelector(".chart-tooltip");
  var svgEl = container.querySelector("svg");
  if (!tip || !svgEl) return;
  function showTip(target, evt) {
    tip.innerHTML = formatHTML(target);
    tip.style.display = "block";
    var rect = container.getBoundingClientRect();
    var x = evt.clientX - rect.left + 12;
    var y = evt.clientY - rect.top + 12;
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    if (x + tw > container.clientWidth - 4) x = evt.clientX - rect.left - tw - 12;
    if (y + th > container.clientHeight - 4) y = evt.clientY - rect.top - th - 12;
    if (x < 4) x = 4;
    if (y < 4) y = 4;
    tip.style.left = x + "px";
    tip.style.top  = y + "px";
  }
  svgEl.addEventListener("mousemove", function (evt) {
    var t = evt.target;
    if (t && t.classList && t.classList.contains("chart-hit")) showTip(t, evt);
    else tip.style.display = "none";
  });
  svgEl.addEventListener("mouseleave", function () { tip.style.display = "none"; });
}
var CHART_TOOLTIP_HTML =
  '<div class="chart-tooltip" style="position:absolute;pointer-events:none;display:none;background:var(--color-bg-primary);border:1px solid var(--color-border);border-radius:4px;padding:6px 8px;font-size:0.75rem;line-height:1.35;color:var(--color-text-primary);box-shadow:0 4px 12px rgba(0,0,0,0.25);white-space:nowrap;z-index:5"></div>';

// Re-runs `rerender(container)` whenever the container's width changes by more
// than a pixel — needed because the chart SVGs use a fixed viewBox computed
// from clientWidth at render time and `preserveAspectRatio="none"`, so any
// later width change would otherwise stretch the labels and ticks. One
// observer per container; rAF-debounced so a drag yields one redraw per frame.
function _observeChartResize(container, rerender) {
  if (!container || !window.ResizeObserver) return;
  if (container._chartResizeObs) container._chartResizeObs.disconnect();
  var lastW = container.clientWidth;
  var pending = false;
  var obs = new ResizeObserver(function () {
    var w = container.clientWidth;
    if (Math.abs(w - lastW) < 2) return;
    lastW = w;
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      if (!container.isConnected) { obs.disconnect(); container._chartResizeObs = null; return; }
      try { rerender(container); } catch (_) {}
    });
  });
  obs.observe(container);
  container._chartResizeObs = obs;
}

// Serialize a live chart SVG into a standalone document an <img> can paint.
// Loaded as an image the SVG sees NO page stylesheet and NO custom property,
// so everything it inherited from the page has to be written into it:
//   - every var(--token[, fallback]) is replaced by the value the live SVG
//     resolves it to — not just the accent: the response-time chart's normal
//     samples are var(--color-success), which the rasterizer painted black
//     while only --color-accent was substituted;
//   - currentColor becomes the SVG's computed color;
//   - the root gets the computed font stack (with a sans tail, since page
//     webfonts don't load inside an image), or every tick label falls back to
//     the renderer's default serif.
// Hit targets and in-SVG axis titles are stripped (the canvas wrapper redraws
// the titles in its margins). Returns the serialized string.
function _serializeChartSvgForRaster(svgEl, width, height) {
  var cs = getComputedStyle(svgEl);
  var rootCs = getComputedStyle(document.documentElement);
  var resolvedText = cs.color || rootCs.getPropertyValue("--color-text-primary").trim() || "#111111";
  var fontStack = (cs.fontFamily || "").trim();
  fontStack = (fontStack ? fontStack + ", " : "") + "system-ui, -apple-system, 'Segoe UI', sans-serif";

  var clone = svgEl.cloneNode(true);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  clone.setAttribute("width", width);
  clone.setAttribute("height", height);
  clone.removeAttribute("style");
  clone.setAttribute("font-family", fontStack);
  if (!clone.getAttribute("viewBox")) {
    clone.setAttribute("viewBox", "0 0 " + width + " " + height);
  }
  Array.prototype.forEach.call(clone.querySelectorAll(".chart-hit, .monitor-hit, .chart-axis-title"), function (n) {
    n.parentNode.removeChild(n);
  });

  var serialized = new XMLSerializer().serializeToString(clone);
  serialized = serialized.replace(/currentColor/g, resolvedText);
  // Innermost var() first, looping so a fallback that is itself a var()
  // resolves too. An unresolvable token with no fallback becomes the text
  // colour rather than staying a var() the image renders as black.
  var varRe = /var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^()]*))?\)/g;
  for (var guard = 0; guard < 5 && serialized.indexOf("var(") !== -1; guard++) {
    serialized = serialized.replace(varRe, function (_m, name, fallback) {
      var v = cs.getPropertyValue(name).trim() || rootCs.getPropertyValue(name).trim();
      if (v) return v;
      return fallback != null && fallback.trim() ? fallback.trim() : resolvedText;
    });
  }
  return serialized;
}

// Rasterize the SVG inside `container` to a PNG blob via Image+Canvas, using
// _serializeChartSvgForRaster to make the SVG self-contained. The hit-target
// circles and tooltip element are stripped — they're interactive scaffolding,
// not part of the visual. `meta` adds a header (title / subject / asset) and
// axis labels (xAxis / yAxis) drawn in canvas margins around the chart so the
// screenshot is self-identifying once it leaves the page.
function _captureChartAsPng(container, meta, callback) {
  meta = meta || {};
  // Skip any svg that lives inside the screenshot button itself (its camera icon).
  var svgEl = null;
  if (container && container.querySelectorAll) {
    var all = container.querySelectorAll("svg");
    for (var i = 0; i < all.length; i++) {
      if (!all[i].closest(".chart-screenshot-btn")) { svgEl = all[i]; break; }
    }
  }
  if (!svgEl) { callback(null); return; }
  var rect = svgEl.getBoundingClientRect();
  var width = Math.ceil(rect.width);
  var height = Math.ceil(rect.height);
  if (!width || !height) { callback(null); return; }

  var rootCs = getComputedStyle(document.documentElement);
  var pickVar = function (name, fallback) {
    var v = rootCs.getPropertyValue(name).trim();
    return v || fallback;
  };
  // Background matches the page so the screenshot blends with the live UI.
  // Uses --color-bg-primary — the same token the chart panels and the
  // slide-over surface render, so the capture matches what's on screen.
  var bgPrimary  = pickVar("--color-bg-primary", "#ffffff");
  var textSec    = pickVar("--color-text-secondary", "#666666");
  var warnColor  = pickVar("--color-warning", "#f57f17");
  var resolvedText = getComputedStyle(svgEl).color || pickVar("--color-text-primary", "#111111");

  var serialized = _serializeChartSvgForRaster(svgEl, width, height);

  var blob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" });
  var url = URL.createObjectURL(blob);
  var img = new Image();
  img.onload = function () {
    var scale = 2;

    // Build header. Line 1 is "<Title> — <Subject>" (subject = interface or
    // tunnel name when the chart is in a sub-panel). Line 2 is the asset.
    // Line 3 is the From/To range — the x-axis ticks carry only times of
    // day, so the date has to travel with the image. Line 4 is an optional
    // stats summary (same one shown above the chart).
    var titleParts = [];
    if (meta.title)   titleParts.push(meta.title);
    if (meta.subject) titleParts.push(meta.subject);
    var headerLine1 = titleParts.join(" — ");
    var headerLines = [];
    if (headerLine1)  headerLines.push({ text: headerLine1, bold: true });
    if (meta.asset)   headerLines.push({ text: meta.asset });
    if (meta.range)   headerLines.push({ text: meta.range });
    if (meta.stats)   headerLines.push({ text: meta.stats });
    if (meta.stale)   headerLines.push({ text: meta.stale, warn: true });
    var headerH = headerLines.length ? 8 + headerLines.length * 16 : 0;

    var footerH  = meta.xAxis ? 22 : 0;
    var leftPadW = meta.yAxis ? 22 : 0;
    var totalW = leftPadW + width;
    var totalH = headerH + height + footerH;

    var canvas = document.createElement("canvas");
    canvas.width  = totalW * scale;
    canvas.height = totalH * scale;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = bgPrimary;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);

    var fontFamily = "system-ui, -apple-system, 'Segoe UI', sans-serif";

    if (headerH > 0) {
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      var headerX = leftPadW + 8;
      var nextY = 8;
      headerLines.forEach(function (line) {
        ctx.fillStyle = line.warn ? warnColor : line.bold ? resolvedText : textSec;
        ctx.font = (line.bold ? "600 13px " : line.warn ? "600 11px " : "11px ") + fontFamily;
        ctx.fillText(line.text, headerX, nextY);
        nextY += 16;
      });
    }

    ctx.drawImage(img, leftPadW, headerH, width, height);
    URL.revokeObjectURL(url);

    if (leftPadW > 0) {
      ctx.save();
      ctx.fillStyle = resolvedText;
      ctx.font = "600 11px " + fontFamily;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.translate(11, headerH + height / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(meta.yAxis, 0, 0);
      ctx.restore();
    }

    if (footerH > 0) {
      ctx.fillStyle = resolvedText;
      ctx.font = "600 11px " + fontFamily;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(meta.xAxis, leftPadW + width / 2, headerH + height + footerH / 2);
    }

    canvas.toBlob(function (b) { callback(b); }, "image/png");
  };
  img.onerror = function () { URL.revokeObjectURL(url); callback(null); };
  img.src = url;
}

// Builds a getStats callback for _addChartScreenshotButton that reads the
// plaintext summary _renderChartStats stashes on the chart's stats bar
// (dataset.summary), so the screenshot carries the same samples/Avg/Min/Max
// line shown above the chart. Read at click time — the bar re-renders on
// every range change, so capturing the element id (not its content) here
// keeps the screenshot in sync with the visible view.
function _statsSummaryFrom(statsElId) {
  return function () {
    var el = document.getElementById(statsElId);
    return (el && el.dataset.summary) || "";
  };
}

// "From <local datetime> to <local datetime>" label for a chart's window: the
// custom From/To the loaders stamp on the container when there is one,
// otherwise the span the chart actually drew (dataset.geomT0/T1 from
// _stashChartGeometry). Preset ranges need it too — the x-axis ticks carry
// only times of day, so a pasted screenshot would otherwise have no date.
// The "to" end drops its date when it falls on the same day as "from".
function _chartRangeLabel(container) {
  if (!container || !container.dataset) return "";
  var ds = container.dataset;
  var from = null, to = null;
  if (ds.from && ds.to) { from = new Date(ds.from); to = new Date(ds.to); }
  else if (ds.geomT0 && ds.geomT1) { from = new Date(Number(ds.geomT0)); to = new Date(Number(ds.geomT1)); }
  if (!from || !to || isNaN(+from) || isNaN(+to)) return "";
  // The display timezone, like the axis ticks the caption describes.
  var tz = typeof timeZoneOpts === "function" ? timeZoneOpts() : {};
  var dateOpts = Object.assign({ month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" },
    typeof timeZoneOpts === "function" ? timeZoneOpts() : {});
  var sameDay = PolarisChartShared.zoneDayKey(from.getTime()) === PolarisChartShared.zoneDayKey(to.getTime());
  var toText = sameDay
    ? to.toLocaleTimeString(undefined, Object.assign({ hour: "2-digit", minute: "2-digit" }, tz))
    : to.toLocaleString(undefined, dateOpts);
  return "From " + from.toLocaleString(undefined, dateOpts) + " to " + toText;
}

// Inject a small camera button at the top-right of a chart container. The
// button copies the rendered chart to the clipboard as a PNG, mirroring the
// asset-details screenshot UX. `axisOpts` carries metadata that gets stamped
// onto the screenshot so it self-identifies after copy/paste:
//   { xAxis: "Time", yAxis: "Response time (ms)", subject?: "port15" }
// The asset name is resolved from `_currentAssetForRefresh` at click time.
function _addChartScreenshotButton(container, label, axisOpts) {
  if (!container) return;
  axisOpts = axisOpts || {};
  var existing = container.querySelector(".chart-screenshot-btn");
  if (existing) existing.parentNode.removeChild(existing);

  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "chart-screenshot-btn";
  btn.title = "Copy chart as image";
  btn.setAttribute("aria-label", "Copy " + label + " chart as image");
  btn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>' +
      '<circle cx="12" cy="13" r="4"/>' +
    '</svg>';
  btn.style.cssText =
    "position:absolute;top:6px;right:6px;background:var(--color-bg-primary);" +
    "border:1px solid var(--color-border);border-radius:4px;padding:4px 6px;" +
    "cursor:pointer;color:var(--color-text-secondary);z-index:6;line-height:0;" +
    "display:inline-flex;align-items:center;justify-content:center";
  btn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    var a = _currentAssetForRefresh;
    var assetName = a ? (a.hostname || a.dnsName || a.ipAddress || a.id || "") : "";
    var statsLine = "";
    if (typeof axisOpts.getStats === "function") {
      try { statsLine = axisOpts.getStats() || ""; } catch (_) { statsLine = ""; }
    }
    var meta = {
      title: label,
      asset: assetName,
      subject: axisOpts.subject || "",
      xAxis: axisOpts.xAxis || "Time",
      yAxis: axisOpts.yAxis || label,
      stats: statsLine,
      // Every capture carries its From/To in the header so the image is
      // dated once it leaves the page. Read at click time from the dataset
      // stamped on the container (custom window, else the rendered span).
      range: _chartRangeLabel(container),
      // The section's amber "Last successful update …" banner, so a chart of
      // stalled data says so once it leaves the page.
      stale: _staleBannerTextFor(container),
    };
    _captureChartAsPng(container, meta, function (blob) {
      if (!blob) { showToast("Screenshot failed", "error"); return; }
      copyPngToClipboard(blob).then(function (ok) {
        showToast(ok ? label + " chart copied to clipboard" : "Screenshot failed — requires HTTPS or clipboard permission", ok ? "success" : "error");
      });
    });
  });
  container.style.position = "relative";
  container.appendChild(btn);
}

// Rasterize the SVG inside `container` to a fully-loaded HTMLImageElement at
// native size. Shares _serializeChartSvgForRaster with _captureChartAsPng
// but stops short of drawing to canvas — the caller composites multiple images together.
// Calls back with `{ img, width, height, url }` (caller revokes `url`) or null.
function _rasterizeChartSvgToImage(container, callback) {
  var svgEl = null;
  if (container && container.querySelectorAll) {
    var all = container.querySelectorAll("svg");
    for (var i = 0; i < all.length; i++) {
      if (!all[i].closest(".chart-screenshot-btn")) { svgEl = all[i]; break; }
    }
  }
  if (!svgEl) { callback(null); return; }
  var rect = svgEl.getBoundingClientRect();
  var width = Math.ceil(rect.width);
  var height = Math.ceil(rect.height);
  if (!width || !height) { callback(null); return; }

  var serialized = _serializeChartSvgForRaster(svgEl, width, height);

  var blob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" });
  var url = URL.createObjectURL(blob);
  var img = new Image();
  img.onload = function () { callback({ img: img, width: width, height: height, url: url }); };
  img.onerror = function () { URL.revokeObjectURL(url); callback(null); };
  img.src = url;
}

// ─── Maintenance-window chart bands ─────────────────────────────────────────
//
// Labeled translucent bands over the plot area showing when the asset was in
// a maintenance window (polling paused → the sample series has a gap; the
// band explains the gap instead of leaving blank grid). Window rows are
// fetched ONCE per asset-panel open (90-day lookback, awaited in
// openViewModal before any tab renders) into _maintWindowsCache; every chart
// render function then calls _maintenanceBandLayer(t0, t1, ...) right next
// to its _dateChangeMarkers(...) call — same coordinate contract.

var _maintWindowsCache = { assetId: null, windows: [] };

function _loadMaintWindowsCache(assetId) {
  _maintWindowsCache = { assetId: assetId, windows: [] };
  var to = new Date(Date.now() + 24 * 60 * 60 * 1000);
  var from = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  return api.assets.maintenanceWindows(assetId, { from: from.toISOString(), to: to.toISOString() })
    .then(function (res) {
      if (_maintWindowsCache.assetId !== assetId) return; // panel moved on
      _maintWindowsCache.windows = (res && res.windows) || [];
    })
    .catch(function () { /* no bands — best effort */ });
}

// SVG band layer for the cached windows clamped to [t0, t1]. Draw BEFORE the
// series group so the data line stays on top. Each band carries a native
// <title> tooltip (name + entry → exit), which works uniformly across all
// chart types without touching their custom hover handlers.
function _maintenanceBandLayer(t0, t1, padL, padT, innerW, innerH) {
  var windows = _maintWindowsCache.windows;
  if (!windows || !windows.length) return "";
  var out = "";
  for (var i = 0; i < windows.length; i++) {
    var w = windows[i];
    var ws = new Date(w.startedAt).getTime();
    var we = w.endedAt ? new Date(w.endedAt).getTime() : Date.now();
    if (isNaN(ws) || we <= t0 || ws >= t1) continue;
    var x0 = padL + (Math.max(ws, t0) - t0) / (t1 - t0) * innerW;
    var x1 = padL + (Math.min(we, t1) - t0) / (t1 - t0) * innerW;
    if (x1 - x0 < 1) x1 = x0 + 1; // sliver windows stay visible
    var name = w.scheduleName || "Maintenance";
    var tip = "Maintenance: " + name + "\n" +
      formatDateTime(ws) + " → " +
      (w.endedAt ? formatDateTime(we) : "ongoing");
    out += '<g class="maintenance-band">' +
      '<rect x="' + x0 + '" y="' + padT + '" width="' + (x1 - x0) + '" height="' + innerH +
        '" fill="rgba(149,117,205,0.14)" stroke="rgba(149,117,205,0.45)" stroke-width="1" stroke-dasharray="2,3">' +
        '<title>' + escapeHtml(tip) + '</title>' +
      '</rect>' +
      ((x1 - x0) > 46
        ? '<text x="' + (x0 + 4) + '" y="' + (padT + innerH - 5) + '" font-size="9" fill="#9575cd" opacity="0.9">' +
            escapeHtml(name.length > Math.floor((x1 - x0) / 6) ? name.slice(0, Math.max(3, Math.floor((x1 - x0) / 6) - 1)) + "…" : name) +
          '</text>'
        : "") +
      '</g>';
  }
  return out;
}

// ─── Automation severity shading on charts ─────────────────────────────────
//
// A chart's line fades into warning / serious / critical wherever the reading
// enters a tier of an automation watching THAT metric on THIS asset (severity
// bands included — business rule 19). The tier ladder is computed SERVER-side by
// GET /assets/:id/metric-thresholds (same resolveTierLadder the engine runs), so
// the shading can't disagree with what actually fires; the pure gradient math
// lives in public/js/chart-severity.js.
//
// Contract for a chart that wants shading: fetch tiers into its render opts,
// then call _severityChartLayer(...) and use the returned {defs, lines, stroke,
// labels} — `stroke` is the flat accent color when nothing watches the metric,
// so the un-shaded path is unchanged. Currently wired for the per-sensor chart;
// CPU / memory / interface charts can opt in the same way.

var _sevChartSeq = 0;

/** Tiers for one (asset, metric, sensor) — best-effort, never blocks a chart. */
function _loadMetricSeverityTiers(assetId, metric, dim) {
  if (!assetId || !metric) return Promise.resolve([]);
  var params = { metric: metric };
  if (dim && dim.sensorName)  params.sensorName  = dim.sensorName;
  if (dim && dim.sensorClass) params.sensorClass = dim.sensorClass;
  if (dim && dim.checkId)     params.checkId     = dim.checkId;
  if (dim && dim.ifName)      params.ifName      = dim.ifName;
  if (dim && dim.alias)       params.alias       = dim.alias;
  return api.assets.metricThresholds(assetId, params)
    .then(function (res) { return (res && res.tiers) || []; })
    .catch(function () { return []; }); // no shading rather than no chart
}

/**
 * SVG pieces for severity shading over a value domain [minV, maxV].
 * Returns {defs, lines, stroke, labels}: `defs` holds the vertical user-space
 * gradient, `lines` the dashed threshold references (draw inside the clipped
 * series group), `stroke` the paint for the line + dots, `labels` the right-edge
 * tier captions (draw OUTSIDE the clip so they aren't cut off).
 */
function _severityChartLayer(kind, tiers, minV, maxV, geo) {
  var flat = { defs: "", lines: "", stroke: "var(--color-accent)", labels: "" };
  var CS = window.PolarisChartSeverity;
  if (!CS || !tiers || !tiers.length) return flat;
  var stops = CS.gradientStops(tiers, minV, maxV);
  if (!stops.length) return flat;

  var id = "sevgrad-" + kind + "-" + (++_sevChartSeq);
  var y0 = geo.padT, y1 = geo.padT + geo.innerH;
  var defs =
    '<defs><linearGradient id="' + id + '" gradientUnits="userSpaceOnUse" x1="0" y1="' + y0 + '" x2="0" y2="' + y1 + '">' +
      stops.map(function (s) {
        return '<stop offset="' + (Math.round(s.offset * 10000) / 100) + '%" style="stop-color:' + s.color + '"/>';
      }).join("") +
    '</linearGradient></defs>';

  var lines = "", labels = "";
  CS.visibleTiers(tiers, minV, maxV).forEach(function (t) {
    var y = geo.yFor(t.threshold);
    var color = CS.colorOf(t.severity);
    lines += '<line x1="' + geo.padL + '" y1="' + y + '" x2="' + (geo.W - geo.padR) + '" y2="' + y +
      '" stroke="' + color + '" stroke-width="1" stroke-dasharray="4,4" opacity="0.55">' +
      '<title>' + escapeHtml(t.ruleName + " — " + CS.tierLabel(t, geo.unit)) + '</title></line>';
    // Caption rides just above its line, right-aligned to the plot edge.
    labels += '<text x="' + (geo.W - geo.padR - 2) + '" y="' + Math.max(geo.padT + 8, y - 3) +
      '" text-anchor="end" font-size="9" fill="' + color + '" opacity="0.9">' +
      escapeHtml(CS.tierLabel(t, geo.unit)) + '</text>';
  });
  return { defs: defs, lines: lines, stroke: "url(#" + id + ")", labels: labels };
}

// ─── CPU & Memory: one chart, or two under one range selector ──────────────
//
// Which shape an asset gets is decided by `_telemetryIsAgentSourced` at
// render time, and the section is a SPLIT only under the Polaris Agent.
//
// Split in 2026-09, because two things the agent reports could not share the
// one 0–100% axis the section used to have:
//
//   * PER-CORE CPU, which turns one line into as many as there are logical
//     cores. A memory line drawn through that thicket cannot be followed.
//   * memory as a STACK IN BYTES — processes, buffers and cache adding up to
//     what is actually in use, against the installed total. Bytes do not
//     share an axis with a percentage.
//
// Narrowed to the agent in 2026-09 as well: every other transport (FortiOS
// REST, SNMP, WinRM, SSH, vCenter) reports ONE CPU percentage and one memory
// figure per sample, so the split gave those assets two single-line charts
// where one had been, on a tab that is already long. They keep the combined
// chart (`_renderSystemChart`) — the same one the section had before the
// split, unchanged.
//
// The two charts keep ONE range selector, one custom-window panel and one
// fetch: both read the same telemetry rows, so a second selector would only
// let an operator put two halves of one reading on two different windows.
// Both containers are stamped with the selection (`_loadSystemTabFor`), and
// both are wired to the same drag-select handler — as is the combined
// container, which is the only one mounted in the other shape.

// The NON-AGENT shape: one chart, CPU and memory on a single 0–100% y-axis.
// Every transport but the agent reports exactly these two percentages per
// sample, so there is nothing for a second chart to carry — a bytes-only
// source (SNMP / WinRM / vCenter) is converted here rather than given the
// byte stack, which needs the agent's band breakdown to say anything the
// one line does not.
//
// CPU stays anchored at 0–100 so spikes remain meaningful; memory plots over
// the same axis as a percentage (computed from bytes when only bytes were
// sampled). One hit target per timestamp drives a unified tooltip naming
// both values.
function _renderSystemChart(container, data, asset, si) {
  var samples = (data && data.samples) || [];
  if (samples.length === 0) {
    if (_isRestApiManagedNetworkDevice(asset, "telemetry")) {
      var telPolling = _assetMonitorStreamSource(asset, "telemetry").polling || "REST API";
      container.innerHTML = _notAvailableViaPollingHTML("Telemetry", telPolling);
    } else {
      // An empty window is exactly when the stale banner matters most: the
      // chart has nothing to say, so "last successful update 7h ago" is the
      // only thing that explains the gap. The banner is emitted inside this
      // container on the data path below, so this early return used to swallow
      // it — CPU & Memory stayed silent while every other section on the tab
      // flagged the same stalled collection.
      container.innerHTML =
        _staleBannerHTML(asset && asset.id, asset, "telemetry", si && si.lastTelemetryAt, _streamFailureError(si, "telemetry")) +
        '<div style="text-align:center">No telemetry samples in this range yet.</div>';
      container.style.flexDirection = "column";
      container.style.alignItems = "stretch";
      container.style.justifyContent = "center";
    }
    return;
  }

  function memPctFromSample(s) {
    if (typeof s.memPct === "number") return s.memPct;
    if (typeof s.memUsedBytes === "number" && typeof s.memTotalBytes === "number" && s.memTotalBytes > 0) {
      return (s.memUsedBytes / s.memTotalBytes) * 100;
    }
    return null;
  }

  var since = data && data.since;
  var until = data && data.until;
  var W = container.clientWidth || 600;
  var H = 200;
  var padL = 50, padR = 10, padT = 14, padB = 28;
  var innerW = W - padL - padR;
  var innerH = H - padT - padB;

  var bounds = _chartTimeBounds(samples, since, until);
  var t0 = bounds.t0, t1 = bounds.t1;
  var spanMs = t1 - t0, oneDayMs = 86400000;
  var pad2 = _chartPad2;

  var cpuValues = samples.map(function (s) { return { s: s, v: typeof s.cpuPct === "number" ? s.cpuPct : null }; })
                         .filter(function (e) { return typeof e.v === "number"; });
  var memValues = samples.map(function (s) { return { s: s, v: memPctFromSample(s) }; })
                         .filter(function (e) { return typeof e.v === "number"; });

  // Memory forecast overlay — leaves from the newest point on the memory line.
  var memNewest = null;
  memValues.forEach(function (e) { var t = +new Date(e.s.timestamp); if (!memNewest || t > memNewest.t) memNewest = { t: t, pct: e.v }; });
  var fcProj = _memForecastProjection(asset && asset.id, memNewest, t1 - t0);
  if (fcProj && fcProj.endT > t1) { t1 = fcProj.endT; spanMs = t1 - t0; }

  var yMin = 0, yMax = 100;
  var xFor = _chartXScale(padL, innerW, t0, t1);
  var yFor = _chartYScale(padT, innerH, yMin, yMax);

  // Missed polls (the telemetry stream has no per-sample success flag — a
  // failed poll simply leaves no row) render the same way the response-time
  // and interface charts render theirs: red dots at the baseline flanking the
  // outage, with both lines fading into red across it instead of bridging it.
  // The outage windows come from the response-time probe (payload `outages`,
  // see _outageMarkers) rather than from the shape of the hole. Both lines
  // dive together: CPU and memory ride the same telemetry row, so an outage is
  // an outage for both, while a transport that reports CPU but not memory has
  // no probe failure behind it and correctly bridges instead.
  var unionTs = Object.keys(cpuValues.concat(memValues).reduce(function (acc, e) {
    acc[+new Date(e.s.timestamp)] = true;
    return acc;
  }, {})).map(Number).sort(function (a, b) { return a - b; });
  var gapMarkers = _outageMarkers(data && data.outages, unionTs);
  var baselineY = padT + innerH;
  function failAwarePts(list) {
    if (!list.length) return [];
    var pts = list.map(function (e) {
      return { t: +new Date(e.s.timestamp), x: xFor(e.s.timestamp), y: yFor(e.v), ok: true };
    });
    _outagePts(gapMarkers, xFor, baselineY).forEach(function (mp) { pts.push(mp); });
    pts.sort(function (a, b) { return a.t - b.t; });
    return pts;
  }
  var failDots = _outageDotsSVG(gapMarkers, xFor, baselineY);
  var missHits = _outageHitsSVG(gapMarkers, xFor, padT, innerH);

  // Build one full-height vertical lane per timestamp so the tooltip fires
  // anywhere in the sample's column — including over a flatlined CPU line at
  // the bottom of a chart whose memory line dominates the visible space.
  // Lane width is the Voronoi span (midpoint to each neighbor) so coverage is
  // continuous across the chart with no dead zones between samples.
  var byTs = {};
  cpuValues.forEach(function (e) {
    var k = String(e.s.timestamp);
    if (!byTs[k]) byTs[k] = { ts: e.s.timestamp, sample: e.s };
    byTs[k].cpu = e.v;
  });
  memValues.forEach(function (e) {
    var k = String(e.s.timestamp);
    if (!byTs[k]) byTs[k] = { ts: e.s.timestamp, sample: e.s };
    byTs[k].mem = e.v;
  });
  var sortedHits = Object.keys(byTs).map(function (k) { return byTs[k]; })
                         .sort(function (a, b) { return new Date(a.ts).getTime() - new Date(b.ts).getTime(); });
  // Rollup tiers: CPU's bucket peak (`maxCpuPct`) as a dashed line under the
  // CPU average. CPU only — memory moves too slowly within a bucket for its
  // peak to say anything the average does not. The axis is a fixed 0–100 %.
  var rollupTier = _chartRollupTier(data);
  var showMax = !!rollupTier && _getMaxLinePref("assetSystem");
  var hits = sortedHits.map(function (h, i) {
    var x = xFor(h.ts);
    var leftEdge  = i === 0 ? padL : (xFor(sortedHits[i - 1].ts) + x) / 2;
    var rightEdge = i === sortedHits.length - 1 ? (W - padR) : (xFor(sortedHits[i + 1].ts) + x) / 2;
    // A sample outside the plotted window (the fetch can return one older
    // than its start) puts x outside the plot: clamp the band, and draw none
    // left with no width — a negative SVG width is a console error.
    leftEdge = Math.max(padL, leftEdge);
    rightEdge = Math.min(W - padR, rightEdge);
    if (!(rightEdge > leftEdge)) return "";
    var s = h.sample;
    return '<rect class="chart-hit" x="' + leftEdge + '" y="' + padT + '" width="' + (rightEdge - leftEdge) + '" height="' + innerH + '" fill="transparent" style="cursor:crosshair"' +
      ' data-ts="' + escapeHtml(String(h.ts)) + '"' +
      ' data-cpu="' + (h.cpu != null ? h.cpu : "") + '"' +
      (rollupTier ? ' data-cpu-max="' + (typeof s.maxCpuPct === "number" ? s.maxCpuPct : "") + '"' : '') +
      ' data-mem="' + (h.mem != null ? h.mem : "") + '"' +
      ' data-mb="' + (typeof s.memUsedBytes === "number" ? s.memUsedBytes : "") + '"' +
      ' data-mt="' + (typeof s.memTotalBytes === "number" ? s.memTotalBytes : "") + '"/>';
  }).join("");

  var ticks = "";
  for (var i = 0; i <= 4; i++) {
    var v = yMin + (yMax - yMin) * (i / 4);
    var y = padT + innerH - (i / 4) * innerH;
    ticks +=
      '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (padL - 4) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + v.toFixed(0) + '%</text>';
  }
  var xTicks = _chartXTicksSVG(t0, t1, padL, padT, innerW, innerH);
  var cpuColor = "var(--color-accent)";
  var memColor = "#f4a261";
  var legend =
    '<g font-size="10" fill="currentColor">' +
      '<rect x="' + (padL + 4)  + '" y="2" width="10" height="10" fill="' + cpuColor + '"/>' +
      '<text x="' + (padL + 18) + '" y="11">CPU</text>' +
      '<rect x="' + (padL + 60) + '" y="2" width="10" height="10" fill="' + memColor + '"/>' +
      '<text x="' + (padL + 74) + '" y="11">Memory</text>' +
      (fcProj
        ? '<line x1="' + (padL + 130) + '" y1="7" x2="' + (padL + 148) + '" y2="7" stroke="' + memColor + '" stroke-width="1.5" stroke-dasharray="4 3"/>' +
          '<text x="' + (padL + 152) + '" y="11">Memory forecast</text>'
        : '') +
    '</g>';

  var chartStaleBanner = _staleBannerHTML(asset && asset.id, asset, "telemetry", si && si.lastTelemetryAt, _streamFailureError(si, "telemetry"));
  var clipId = _chartClipId("system");
  var cpuLine = _failureAwareSeriesSVG(failAwarePts(cpuValues), cpuColor, clipId + "-cpu");
  var memLine = _failureAwareSeriesSVG(failAwarePts(memValues), memColor, clipId + "-mem");
  var cpuMaxSvg = showMax
    ? _maxLineSVG(samples.map(function (s) {
        return typeof s.maxCpuPct === "number" && isFinite(s.maxCpuPct) ? { x: xFor(s.timestamp), y: yFor(s.maxCpuPct) } : null;
      }), cpuColor)
    : "";
  container.innerHTML =
    chartStaleBanner +
    _maxLineLegendRowHTML("assetSystem", rollupTier, cpuColor) +
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      _chartClipDefs(clipId, padL, padT, innerW, innerH) +
      '<defs>' + cpuLine.defs + memLine.defs + '</defs>' +
      ticks + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      _maintenanceBandLayer(t0, t1, padL, padT, innerW, innerH) +
      '<g ' + _chartClipAttr(clipId) + '>' +
        cpuMaxSvg +
        cpuLine.segments +
        memLine.segments +
        cpuValues.map(function (e) { return '<circle cx="' + xFor(e.s.timestamp) + '" cy="' + yFor(e.v) + '" r="1.5" fill="' + cpuColor + '"/>'; }).join("") +
        memValues.map(function (e) { return '<circle cx="' + xFor(e.s.timestamp) + '" cy="' + yFor(e.v) + '" r="1.5" fill="' + memColor + '"/>'; }).join("") +
        (fcProj ? _memForecastSVG(fcProj, xFor, yFor, memColor, padT, innerH) : '') +
        failDots +
        // After `hits`, not before: this chart's hit targets are full-height
        // Voronoi lanes, and a gap sits inside the neighboring sample's lane —
        // so the narrow missed-poll rect has to paint last to win the hover.
        hits +
        missHits +
      '</g>' +
      legend +
    '</svg>' + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";
  container.style.flexDirection = "column";
  _stashChartGeometry(container, t0, t1, padL, innerW, W);
  _wireMaxLineChip(container, "assetSystem", function () { _renderSystemChart(container, data, asset, si); });

  _wireChartTooltip(container, function (target) {
    var ts = target.getAttribute("data-ts");
    if (target.getAttribute("data-miss") === "1") {
      return _missTooltipHTML(target);
    }
    var cpuRaw = target.getAttribute("data-cpu");
    var cpuMaxRaw = target.getAttribute("data-cpu-max");
    var memRaw = target.getAttribute("data-mem");
    var mb = target.getAttribute("data-mb");
    var mt = target.getAttribute("data-mt");
    var memLine = '<div>Memory: ' + (memRaw !== "" ? Number(memRaw).toFixed(1) + "%" : "—");
    if (mb !== "" && mt !== "") {
      memLine += " (" + _fmtBytes(Number(mb)) + " / " + _fmtBytes(Number(mt)) + ")";
    }
    memLine += "</div>";
    var cpuTxt = cpuRaw !== "" ? Number(cpuRaw).toFixed(1) + "%" : "—";
    return '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(ts)) + '</div>' +
      '<div>CPU: ' + (cpuMaxRaw != null
        ? _avgMaxText(cpuTxt, cpuMaxRaw !== "" ? Number(cpuMaxRaw).toFixed(1) + "%" : null)
        : cpuTxt) + '</div>' +
      memLine;
  });
  _addChartScreenshotButton(container, "CPU & Memory", { yAxis: "Utilization (%)", getStats: _statsSummaryFrom("asset-system-summary") });
  _observeChartResize(container, function (c) { _renderSystemChart(c, data, asset, si); });
}

// Per-core hues are spread across an arc that DELIBERATELY EXCLUDES RED.
// Red is the missed-poll colour on every chart in this app (_CHART_FAIL_COLOR)
// and grey is the dependency-down colour — a core line in either would read
// as an outage marker. The arc runs orange → yellow → green → cyan → blue →
// violet and stops short of wrapping back into red.
// The aggregate line — the series every threshold, automation and metric
// actually reads, so it keeps the app accent and stays visually primary over
// however many core lines sit behind it.
var _CPU_AVG_COLOR = "var(--color-accent)";

var _CPU_CORE_HUE_START = 35;
var _CPU_CORE_HUE_END   = 320;

function _cpuCoreColor(i, n) {
  if (!n || n < 2) return "hsl(205,68%,50%)";
  // i/n rather than i/(n-1): dividing by n-1 puts the last core on the end
  // of the arc, which on a big core count is a near-neighbour of the first.
  var h = Math.round(_CPU_CORE_HUE_START + (i / n) * (_CPU_CORE_HUE_END - _CPU_CORE_HUE_START));
  // Alternating lightness is what keeps ADJACENT cores apart once the arc is
  // crowded — a 64-core host gets under 5° of hue each, which is invisible;
  // a 16-point lightness step is not.
  return "hsl(" + h + ",68%," + (i % 2 === 0 ? 46 : 63) + "%)";
}

// Transposes the per-sample core vectors into one series per core.
// Returns null when NO sample in the window carries per-core data, which is
// the signal every caller uses to fall back to the aggregate-only chart.
//
// Tolerates a core count that changes mid-window (a VM resized, or a sample
// truncated at the agent's report cap): the matrix is as wide as the widest
// sample, and a core missing from a given sample simply has no point there
// rather than a zero — a zero would draw an idle core that did not exist.
function _cpuCoreSeries(samples) {
  var maxCores = 0;
  samples.forEach(function (s) {
    if (Array.isArray(s.cpuCorePcts) && s.cpuCorePcts.length > maxCores) maxCores = s.cpuCorePcts.length;
  });
  if (maxCores === 0) return null;
  var series = [];
  for (var c = 0; c < maxCores; c++) series.push([]);
  samples.forEach(function (s) {
    if (!Array.isArray(s.cpuCorePcts)) return;
    for (var c = 0; c < s.cpuCorePcts.length && c < maxCores; c++) {
      var v = s.cpuCorePcts[c];
      if (typeof v === "number" && isFinite(v)) series[c].push({ s: s, v: v });
    }
  });
  return series;
}

// CPU chart — aggregate line plus one line per logical core, 0–100%.
function _renderCpuChart(container, data, asset, si) {
  var samples = (data && data.samples) || [];
  if (samples.length === 0) {
    if (_isRestApiManagedNetworkDevice(asset, "telemetry")) {
      var telPolling = _assetMonitorStreamSource(asset, "telemetry").polling || "REST API";
      container.innerHTML = _notAvailableViaPollingHTML("Telemetry", telPolling);
    } else {
      // An empty window is exactly when the stale banner matters most: the
      // chart has nothing to say, so "last successful update 7h ago" is the
      // only thing that explains the gap.
      container.innerHTML =
        _staleBannerHTML(asset && asset.id, asset, "telemetry", si && si.lastTelemetryAt, _streamFailureError(si, "telemetry")) +
        '<div style="text-align:center">No telemetry samples in this range yet.</div>';
      container.style.flexDirection = "column";
      container.style.alignItems = "stretch";
      container.style.justifyContent = "center";
    }
    return;
  }

  var since = data && data.since;
  var until = data && data.until;
  var W = container.clientWidth || 600;
  var H = 200;
  var padL = 50, padR = 10, padT = 14, padB = 28;
  var innerW = W - padL - padR;
  var innerH = H - padT - padB;

  var bounds = _chartTimeBounds(samples, since, until);
  var t0 = bounds.t0, t1 = bounds.t1;
  var spanMs = t1 - t0, oneDayMs = 86400000;
  var pad2 = _chartPad2;

  var cpuValues = samples.map(function (s) { return { s: s, v: typeof s.cpuPct === "number" ? s.cpuPct : null }; })
                         .filter(function (e) { return typeof e.v === "number"; });
  var coreSeries = _cpuCoreSeries(samples);
  var coreCount = coreSeries ? coreSeries.length : 0;
  // Which series are switched off. A core index that no longer exists (the
  // VM was resized down, or the operator moved to a smaller host with the
  // panel open) is simply not consulted — the hidden set is not pruned,
  // because growing back to that core count should restore the choice
  // rather than silently re-showing a core they had put away.
  var hidden = _cpuHiddenCores(container);
  var coreVisible = function (c) { return !hidden[String(c)]; };
  var avgVisible = !hidden.avg;
  var visibleCores = 0;
  for (var vc = 0; vc < coreCount; vc++) if (coreVisible(vc)) visibleCores++;
  var rollupTier = _chartRollupTier(data);

  var yMin = 0, yMax = 100;
  var xFor = _chartXScale(padL, innerW, t0, t1);
  var yFor = _chartYScale(padT, innerH, yMin, yMax);

  // Missed polls come from the response-time probe's own record, never from
  // the shape of a hole (see _outageMarkers). The union feeding the collision
  // guard is the aggregate series alone: the cores ride the same rows, so
  // they can add no timestamp the aggregate does not already have.
  var unionTs = cpuValues.map(function (e) { return +new Date(e.s.timestamp); })
                         .sort(function (a, b) { return a - b; });
  var gapMarkers = _outageMarkers(data && data.outages, unionTs);
  var baselineY = padT + innerH;
  function failAwarePts(list) {
    if (!list.length) return [];
    var pts = list.map(function (e) {
      return { t: +new Date(e.s.timestamp), x: xFor(e.s.timestamp), y: yFor(e.v), ok: true };
    });
    _outagePts(gapMarkers, xFor, baselineY).forEach(function (mp) { pts.push(mp); });
    pts.sort(function (a, b) { return a.t - b.t; });
    return pts;
  }
  var failDots = _outageDotsSVG(gapMarkers, xFor, baselineY);
  var missHits = _outageHitsSVG(gapMarkers, xFor, padT, innerH);

  // One full-height vertical lane per timestamp so the tooltip fires anywhere
  // in the sample's column, including over a flatlined line at the bottom.
  // Lane width is the Voronoi span so coverage is continuous.
  var sortedHits = cpuValues.slice().sort(function (a, b) {
    return new Date(a.s.timestamp).getTime() - new Date(b.s.timestamp).getTime();
  });
  var hits = sortedHits.map(function (h, i) {
    var x = xFor(h.s.timestamp);
    var leftEdge  = i === 0 ? padL : (xFor(sortedHits[i - 1].s.timestamp) + x) / 2;
    var rightEdge = i === sortedHits.length - 1 ? (W - padR) : (xFor(sortedHits[i + 1].s.timestamp) + x) / 2;
    // A sample outside the plotted window (the fetch can return one older
    // than its start) puts x outside the plot: clamp the band, and draw none
    // left with no width — a negative SVG width is a console error.
    leftEdge = Math.max(padL, leftEdge);
    rightEdge = Math.min(W - padR, rightEdge);
    if (!(rightEdge > leftEdge)) return "";
    var cores = Array.isArray(h.s.cpuCorePcts) ? h.s.cpuCorePcts.join(",") : "";
    // Rollup peaks ride the hit too, so the tooltip names avg AND max whether
    // or not the max line is shown.
    var coreMaxes = Array.isArray(h.s.cpuCoreMaxPcts) ? h.s.cpuCoreMaxPcts.map(function (v) { return typeof v === "number" ? v : ""; }).join(",") : "";
    return '<rect class="chart-hit" x="' + leftEdge + '" y="' + padT + '" width="' + (rightEdge - leftEdge) + '" height="' + innerH + '" fill="transparent" style="cursor:crosshair"' +
      ' data-ts="' + escapeHtml(String(h.s.timestamp)) + '"' +
      ' data-cpu="' + (h.v != null ? h.v : "") + '"' +
      ' data-cores="' + escapeHtml(cores) + '"' +
      (rollupTier
        ? ' data-cpu-max="' + (typeof h.s.maxCpuPct === "number" ? h.s.maxCpuPct : "") + '"' +
          ' data-core-max="' + escapeHtml(coreMaxes) + '"'
        : '') + '/>';
  }).join("");

  var ticks = "";
  for (var i = 0; i <= 4; i++) {
    var v = yMin + (yMax - yMin) * (i / 4);
    var y = padT + innerH - (i / 4) * innerH;
    ticks +=
      '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (padL - 4) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + v.toFixed(0) + '%</text>';
  }
  var xTicks = _chartXTicksSVG(t0, t1, padL, padT, innerW, innerH);

  var clipId = _chartClipId("cpu");
  var avgLine = _failureAwareSeriesSVG(failAwarePts(cpuValues), _CPU_AVG_COLOR, clipId + "-avg");

  // Core lines are plain polylines, NOT failure-aware: the aggregate already
  // dives to the baseline across every outage and carries the red dots, and
  // 64 lines all diving together would bury the marker they are supposed to
  // make legible.
  // Core lines thin out as the count rises. The aggregate is drawn at a fixed
  // 1.5px by the shared `_failureAwareSeriesSVG`, so the only lever for
  // keeping it visually primary — which it has to be, being the series every
  // threshold reads — is how much ink the cores behind it use. At 4 cores
  // they can be near-solid; at 64 the same opacity is a wall the aggregate
  // disappears into.
  // Opacity keys off how many cores are actually DRAWN, not how many the
  // host has — switching sixty-three of them off should leave the survivor
  // solid, which is what makes hiding the rest worth doing.
  var restOpacity = visibleCores <= 4 ? 0.85 : visibleCores <= 16 ? 0.62 : visibleCores <= 48 ? 0.45 : 0.32;
  // Rollup tiers: each bucket's peak as a dashed line under its average —
  // the aggregate's from `maxCpuPct`, each DRAWN core's from
  // `cpuCoreMaxPcts` (same indexing as `cpuCorePcts`; absent on buckets
  // written before per-core rollups, which simply draw no core max). The axis
  // is a fixed 0–100 %, so showing or hiding the peaks never rescales it.
  var showMax = !!rollupTier && _getMaxLinePref("assetCpu");
  var coreMaxSvg = "";
  var avgMaxSvg = "";
  if (showMax) {
    if (avgVisible) {
      avgMaxSvg = _maxLineSVG(samples.map(function (s) {
        return typeof s.maxCpuPct === "number" && isFinite(s.maxCpuPct) ? { x: xFor(s.timestamp), y: yFor(s.maxCpuPct) } : null;
      }), _CPU_AVG_COLOR);
    }
    for (var mc = 0; mc < coreCount; mc++) {
      if (!coreVisible(mc) || !coreSeries[mc].length) continue;
      coreMaxSvg += _maxLineSVG(samples.map(function (s) {
        var v = Array.isArray(s.cpuCoreMaxPcts) ? s.cpuCoreMaxPcts[mc] : null;
        return typeof v === "number" && isFinite(v) ? { x: xFor(s.timestamp), y: yFor(v) } : null;
      }), _cpuCoreColor(mc, coreCount), {
        width: 1,
        // Never more ink than the core's own line: 64 dashed lines at 0.85
        // would be the wall the thinning below exists to avoid.
        opacity: restOpacity,
        attrs: ' data-core="' + mc + '"',
      });
    }
  }
  var coreLinesSvg = "";
  if (coreSeries) {
    for (var c = 0; c < coreCount; c++) {
      var pts = coreSeries[c];
      if (pts.length === 0 || !coreVisible(c)) continue;
      var d = pts.map(function (e) { return xFor(e.s.timestamp) + "," + yFor(e.v); }).join(" ");
      coreLinesSvg += '<polyline class="cpu-core-line" data-core="' + c + '" points="' + d +
        '" fill="none" stroke="' + _cpuCoreColor(c, coreCount) + '"' +
        ' stroke-width="' + (visibleCores === 1 ? 2 : 1) + '"' +
        ' opacity="' + restOpacity + '"/>';
    }
  }

  var chartStaleBanner = _staleBannerHTML(asset && asset.id, asset, "telemetry", si && si.lastTelemetryAt, _streamFailureError(si, "telemetry"));
  container.innerHTML =
    chartStaleBanner +
    _cpuLegendHTML(coreCount, hidden, data, asset, rollupTier ? { tier: rollupTier, on: showMax } : null) +
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      _chartClipDefs(clipId, padL, padT, innerW, innerH) +
      '<defs>' + avgLine.defs + '</defs>' +
      ticks + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      _maintenanceBandLayer(t0, t1, padL, padT, innerW, innerH) +
      '<g ' + _chartClipAttr(clipId) + '>' +
        coreMaxSvg +
        coreLinesSvg +
        avgMaxSvg +
        // The aggregate goes ON TOP of the cores and gets the only dots, so
        // it stays findable in the thicket. It is also the only failure-aware
        // line, so hiding it hides the outage markers with it — which is the
        // operator's call to make, but is why it is not hidden by default.
        (avgVisible
          ? '<g>' + avgLine.segments +
              cpuValues.map(function (e) { return '<circle cx="' + xFor(e.s.timestamp) + '" cy="' + yFor(e.v) + '" r="1.5" fill="' + _CPU_AVG_COLOR + '"/>'; }).join("") +
            '</g>'
          : "") +
        failDots +
        // After `hits`, not before: the hit targets are full-height Voronoi
        // lanes and a gap sits inside the neighbouring sample's lane, so the
        // narrow missed-poll rect has to paint last to win the hover.
        hits +
        missHits +
      '</g>' +
    '</svg>' + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";
  container.style.flexDirection = "column";
  _stashChartGeometry(container, t0, t1, padL, innerW, W);

  _wireCpuLegend(container, data, asset, si, coreCount);
  _wireMaxLineChip(container, "assetCpu", function () { _renderCpuChart(container, data, asset, si); });

  _wireChartTooltip(container, function (target) {
    if (target.getAttribute("data-miss") === "1") return _missTooltipHTML(target);
    var ts = target.getAttribute("data-ts");
    var cpuRaw = target.getAttribute("data-cpu");
    var off = _cpuHiddenCores(container);
    // Rollup buckets: avg AND max per drawn series (data-cpu-max is only
    // stamped on a rollup tier).
    var rollupHit = target.hasAttribute("data-cpu-max");
    var pctTxt = function (raw) { return raw !== "" && raw != null ? Number(raw).toFixed(1) + "%" : null; };
    var html = '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(ts)) + '</div>';
    if (!off.avg) {
      html += rollupHit
        ? '<div><strong>Average: ' + _avgMaxText(pctTxt(cpuRaw) || "—", pctTxt(target.getAttribute("data-cpu-max"))) + '</strong></div>'
        : '<div><strong>Average: ' + (cpuRaw !== "" ? Number(cpuRaw).toFixed(1) + "%" : "—") + '</strong></div>';
    }
    var coreMaxRaw = rollupHit ? (target.getAttribute("data-core-max") || "").split(",") : [];
    var coresRaw = target.getAttribute("data-cores");
    if (coresRaw) {
      var vals = coresRaw.split(",").map(Number);
      // The tooltip names what is DRAWN. A hidden core listed here would
      // put a reading on screen with no line to attach it to, which is the
      // opposite of what switching it off was for.
      var shown = vals.map(function (v, i) { return { i: i, v: v }; })
                      .filter(function (r) { return !off[String(r.i)]; });
      // Busiest first, capped: a 64-core tooltip taller than the panel is
      // not a tooltip. The cap is what makes per-core hover usable at all
      // on a big host.
      var rows = shown.slice().sort(function (a, b) { return b.v - a.v; }).slice(0, 6);
      rows.forEach(function (r) {
        html += '<div><span style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;background:' +
          _cpuCoreColor(r.i, vals.length) + '"></span>Core ' + r.i + ': ' +
          (rollupHit ? _avgMaxText(r.v.toFixed(1) + "%", pctTxt(coreMaxRaw[r.i])) : r.v.toFixed(1) + '%') + '</div>';
      });
      if (shown.length > rows.length) {
        html += '<div style="color:var(--color-text-tertiary)">+' + (shown.length - rows.length) + ' more</div>';
      }
      var hiddenCount = vals.length - shown.length;
      if (hiddenCount > 0) {
        html += '<div style="color:var(--color-text-tertiary)">' + hiddenCount + ' core' +
          (hiddenCount === 1 ? "" : "s") + ' hidden</div>';
      }
    }
    return html;
  });
  _addChartScreenshotButton(container, "CPU", { yAxis: "Utilization (%)", getStats: _statsSummaryFrom("asset-cpu-summary") });
  _observeChartResize(container, function (c) { _renderCpuChart(c, data, asset, si); });
}

// Legend for the CPU chart. Rendered as HTML above the SVG rather than as
// <text> inside it because it has to WRAP — 64 core chips on one SVG line
// run off the edge of the panel — and because the chips are interactive.
// `max` ({ tier, on }) adds the rollup tier's one Max chip, which switches the
// aggregate's AND every core's dashed peak line together. It is a separate
// class from the core chips, so "Show all" and isolate never touch it.
function _cpuLegendHTML(coreCount, hidden, data, asset, max) {
  var anyHidden = Object.keys(hidden).length > 0;
  var chips = _seriesChipHTML("avg", "Average", _CPU_AVG_COLOR, !hidden.avg,
    "Click to hide the cross-core average", "cpu-legend-chip");
  for (var c = 0; c < coreCount; c++) {
    chips += _seriesChipHTML(String(c), String(c), _cpuCoreColor(c, coreCount), !hidden[String(c)],
      "Click to hide core " + c + " · double-click to show only this core", "cpu-legend-chip");
  }
  if (max && max.tier) chips += _maxLineChipHTML("assetCpu", max.tier, max.on);
  // Only offered once something is off. At 64 cores an isolate is one
  // double-click and 63 chips of undoing, so the way back has to be one
  // click too.
  if (anyHidden) {
    chips += '<span class="cpu-legend-all" title="Show every series again"' +
      ' style="cursor:pointer;display:inline-flex;align-items:center;gap:4px;color:var(--color-accent)">Show all</span>';
  }
  // Why a range can show no cores even on a source that reports them: the
  // rollup buckets carry per-core vectors only for data written since
  // per-core rollups shipped, so an older hourly/daily range has none.
  // Shown only when the rollup samples actually lack them (coreCount 0).
  // Saying so beats letting the operator conclude the source stopped
  // reporting them. A source that never reports cores gets no note — "pick
  // a shorter range" would send a FortiGate operator nowhere.
  var note = "";
  if (coreCount === 0 && data && data.tier && data.tier !== "detail" && _telemetrySplitsCpuMemory(asset)) {
    note = '<div style="font-size:0.72rem;color:var(--color-text-tertiary);margin-top:2px">' +
      'Per-core detail is not kept in these ' + escapeHtml(data.tier) + ' buckets — showing the cross-core average. Pick a shorter range to see individual cores.' +
      '</div>';
  }
  return '<div class="cpu-legend" style="display:flex;flex-wrap:wrap;gap:4px 10px;font-size:0.72rem;color:var(--color-text-secondary);margin-bottom:2px">' +
    chips + '</div>' + note;
}

// Click a chip to switch that series off or back on; double-click a core to
// show ONLY that core. One state either way — isolating is just a bulk edit
// of the hidden set, which is what keeps "hidden" and "focused" from being
// two overlapping models that can disagree.
//
// Re-renders from the same payload — never a refetch.
function _wireCpuLegend(container, data, asset, si, coreCount) {
  // A double-click also fires two clicks. Defer the single-click render just
  // past the double-click window so an isolate does not first toggle the
  // chip it was aimed at, which would leave the isolated core hidden.
  var clickTimer = null;
  container.querySelectorAll(".cpu-legend-chip").forEach(function (chip) {
    var key = chip.getAttribute("data-series");
    chip.addEventListener("click", function () {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      clickTimer = setTimeout(function () {
        clickTimer = null;
        var hidden = _cpuHiddenCores(container);
        if (hidden[key]) delete hidden[key]; else hidden[key] = true;
        _setCpuHiddenCores(container, hidden);
        _renderCpuChart(container, data, asset, si);
      }, 220);
    });
    chip.addEventListener("dblclick", function () {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      if (key === "avg") return; // "only the average" is what hiding the cores is for
      var hidden = {};
      for (var c = 0; c < coreCount; c++) if (String(c) !== key) hidden[String(c)] = true;
      _setCpuHiddenCores(container, hidden);
      _renderCpuChart(container, data, asset, si);
    });
  });
  var all = container.querySelector(".cpu-legend-all");
  if (all) {
    all.addEventListener("click", function () {
      _setCpuHiddenCores(container, {});
      _renderCpuChart(container, data, asset, si);
    });
  }
}

// One legend chip, shared by both telemetry charts so a switched-off series
// reads the same on either.
//
// THE STRIKETHROUGH CARRIES THE STATE, NOT THE DIMMING. A chip is a control,
// and a switched-off one is the ONLY route back to its series — so it has to
// stay readable. Dimming it to 0.4 measured 1.84:1 on the morning theme
// (2.01 noon, 2.17 nightfall) against 6-8.5:1 for a live chip, which is
// under the floor for non-text UI, never mind a click target. The label now
// keeps most of its ink and the line through it says "off"; only the swatch
// fades, and that is decoration — the colour is how the operator finds the
// series again, so it does not fade far either.
function _seriesChipHTML(key, label, color, on, title, cls) {
  return '<span class="' + cls + '" data-series="' + escapeHtml(key) + '" title="' + escapeHtml(title) + '"' +
    ' style="cursor:pointer;display:inline-flex;align-items:center;gap:4px;user-select:none' +
    (on ? '' : ';opacity:0.8;text-decoration:line-through') + '">' +
    '<span style="width:10px;height:10px;border-radius:2px;flex:0 0 auto;background:' + color +
    (on ? '' : ';opacity:0.45') + '"></span>' + escapeHtml(label) + '</span>';
}

// ─── Memory chart (stacked bands, bytes) ───────────────────────────────────
//
// The bands stack bottom-up in the order an operator reads them: what
// processes hold, then what the kernel holds on their behalf (buffers, then
// page cache). The stack's TOP is memory in use; the gap between it and the
// axis ceiling is free memory, and the ceiling is the installed total. Swap
// is not part of the stack — it is a different device, so it rides as its
// own dashed line on the same byte axis.
//
// None of these colours may be red (missed poll) or grey (dependency down).
// Two band vocabularies, one chart. They are NOT translations of each other
// and must never appear in one stack: the agent reports how the OS is
// spending the machine's RAM, vSphere reports how the HYPERVISOR is backing
// a guest's RAM. `_memBandsFor` picks the table from the columns the row
// actually carries, and the source guarantees only one set is ever filled.
//
// The primary band takes the same orange in both tables — it is the memory
// colour this chart has always used, and the two tables never co-occur, so
// "the big one at the bottom" reads the same on any asset. No band may be
// red (missed poll) or grey (dependency down).
var _MEM_BANDS_AGENT = PolarisChartShared.MEM_BANDS_AGENT;

// vSphere. A VM fills private / shared / ballooned / swapped / compressed
// against its CONFIGURED RAM; an ESXi host fills consumed / ballooned /
// swapped against INSTALLED RAM. One table serves both because the two sets
// are disjoint — a host publishes no private/shared/compressed and a VM
// publishes no consumed — so the bands nobody reported simply drop out.
//
// Ballooned, swapped and compressed are the reason this vocabulary exists.
// They are the hypervisor taking memory back from a guest under pressure,
// and they are invisible to anything running inside that guest — an agent on
// the same VM cannot see them and must not be made to guess.
var _MEM_BANDS_VSPHERE = PolarisChartShared.MEM_BANDS_VSPHERE;
// A TrueNAS host fills the agent's columns in TrueNAS's own words — what its
// dashboard calls Services and ZFS Cache (the ARC). Same keys and colours, so
// a chip toggled on one host stays toggled on the next; the ARC is
// reclaimable like page cache, so it ships off for the same reason.
var _MEM_BANDS_TRUENAS = PolarisChartShared.MEM_BANDS_TRUENAS;

// A Proxmox node: Proxmox's own "used" with the ZFS ARC carved out of it.
var _MEM_BANDS_PROXMOX = PolarisChartShared.MEM_BANDS_PROXMOX;

function _memAgentBandsFor(asset) {
  return PolarisChartShared.memAgentBandsFor(asset);
}

var _MEM_SWAP_COLOR = PolarisChartShared.MEM_SWAP_COLOR;
var _MEM_TOTAL_COLOR = "rgba(127,127,127,0.55)";

// Shapes one sample into the band values the chart stacks, and says which
// VOCABULARY those values are in.
//
// Four shapes reach here, and the chart degrades through them rather than
// demanding the richest one:
//   agent    — every OS band present, guaranteed to close on the total.
//   vsphere  — the hypervisor's bands for a VM or an ESXi host.
//   bytes    — SNMP / WinRM: used + total, no breakdown. One band.
//   pctOnly  — FortiOS: a percentage and nothing else. Handled by the caller,
//              which switches the whole chart to a 0–100% axis.
//
// `values` carries null for a band this source did not report, distinctly
// from 0 for one it reported as empty — the renderer drops a band no row in
// the window reported at all, which is what collapses a bytes-only source
// to the single band it can honestly draw.
function _memBandsFor(s) {
  return PolarisChartShared.memBandsFor(s);
}

// Splits a run of points wherever an outage falls between two consecutive
// samples, so a stacked band does not paint straight across a window in
// which nothing was collected. Same evidence the lines use (the probe's own
// failure record), never the size of the gap.
function _memRuns(points, gapMarkers) {
  if (!points.length) return [];
  var cuts = (gapMarkers || []).map(function (m) { return m.t; }).sort(function (a, b) { return a - b; });
  if (!cuts.length) return [points];
  var runs = [], cur = [points[0]];
  for (var i = 1; i < points.length; i++) {
    var a = points[i - 1].t, b = points[i].t;
    var broken = cuts.some(function (c) { return c > a && c < b; });
    if (broken) { runs.push(cur); cur = []; }
    cur.push(points[i]);
  }
  runs.push(cur);
  return runs.filter(function (r) { return r.length > 0; });
}

// ─── Memory forecast ─────────────────────────────────────────────────────
// The Memory chart's twin of the Storage panel's forecast: a dashed
// projection past "now" plus a "days until full" headline. Unlike storage,
// the fit comes from the SERVER (GET /assets/:id/memory-forecast →
// memoryForecastService), fitted on 30 days of daily averages — the very
// figure the memDaysUntilFull automation compares, so the headline and an
// alert can never disagree. Memory in use is a PERCENTAGE of installed
// memory there (bytes first, the source's own % otherwise), so the overlay
// converts back to bytes on the byte-stacked chart.
var _memForecastCache = null;        // { assetId, data, at }
var _memForecastLastRender = null;   // { assetId, tel, asset, si } — toggle re-renders from it
var _MEM_FORECAST_TTL_MS = 15 * 60 * 1000;

async function _loadMemoryForecastFor(assetId, force) {
  var c = _memForecastCache;
  if (!force && c && c.assetId === assetId && (Date.now() - c.at) < _MEM_FORECAST_TTL_MS) return c.data;
  try {
    // The levels the headline counts down to ride along: the memory
    // utilization automations that cover this device (the engine's own tier
    // ladder, GET /metric-thresholds), else a memory forecast automation's own
    // levels. Best-effort — no levels means "Days until full", as before.
    var both = await Promise.all([
      api.assets.memoryForecast(assetId),
      _loadMetricSeverityTiers(assetId, "memPct").then(function (t) {
        return t.length ? t : _loadMetricSeverityTiers(assetId, "memForecastPct");
      }),
    ]);
    var data = both[0];
    if (data) data.levels = both[1] || [];
    _memForecastCache = { assetId: assetId, data: data, at: Date.now() };
    return data;
  } catch (_) {
    // A stale forecast for this asset beats none; a different asset's never.
    if (c && c.assetId === assetId) return c.data;
    _memForecastCache = { assetId: assetId, data: null, at: Date.now() };
    return null;
  }
}

function _memForecastFor(assetId) {
  var c = _memForecastCache;
  return (c && assetId && c.assetId === assetId) ? c.data : null;
}

// "insufficient" | "growing" | "beyond-horizon" | "flat" | "shrinking".
// "growing" is exactly the server's daysUntilFull being set — the condition
// under which a memDaysUntilFull automation has a reading at all.
function _memForecastSignal(fc) {
  if (!fc || fc.slopePerDay == null) return "insufficient";
  if (fc.daysUntilFull != null) return "growing";
  // Under 0.1 percentage points a week is noise, not a trend (the storage
  // panel's significance floor, in the same units).
  if (Math.abs(fc.slopePerDay) * 7 < 0.1) return "flat";
  return fc.slopePerDay < 0 ? "shrinking" : "beyond-horizon";
}

function _fmtPctPerDay(v) {
  var a = Math.abs(v);
  return a.toFixed(a < 1 ? 2 : 1) + "%/day";
}

/**
 * The memory level the headline counts down to: the lowest upward level of
 * the device's memory automations that memory has not reached yet — the same
 * "next level" a memory forecast alert names (memoryForecastService
 * .nextForecastLevel). `{ level, past }`: `past` is the highest level already
 * passed when there is no next one. Pure over `fc.levels` + the newest point.
 */
function _memForecastNextLevel(fc) {
  var levels = ((fc && fc.levels) || []).filter(function (t) {
    return (t.operator === ">" || t.operator === ">=") && typeof t.threshold === "number";
  }).sort(function (a, b) { return a.threshold - b.threshold; });
  if (!levels.length || !fc.points || !fc.points.length) return null;
  var used = fc.points[fc.points.length - 1].v;
  var reached = function (t) { return t.operator === ">" ? used > t.threshold : used >= t.threshold; };
  for (var i = 0; i < levels.length; i++) {
    if (!reached(levels[i])) return { level: levels[i], past: null, used: used };
  }
  return { level: null, past: levels[levels.length - 1], used: used };
}

function _sevName(sev) {
  var s = String(sev || "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function _memForecastHeadlineHTML(fc) {
  var muted = "var(--color-text-secondary)";
  var signal = _memForecastSignal(fc);
  var color = muted, text;
  if (signal === "insufficient") {
    var have = fc && fc.points ? fc.points.length : 0;
    var need = (fc && fc.minPoints) || 7;
    // A reboot restarts the forecast (memoryForecastService): say so, or the
    // operator reads a device with weeks of history as "1 so far".
    var since = fc && fc.restartedAt ? new Date(fc.restartedAt) : null;
    var why = since && !isNaN(since.getTime())
      ? 'Forecast restarted at the reboot on ' + since.toLocaleDateString(undefined, Object.assign({ month: "short", day: "numeric" }, timeZoneOpts())) + ' — needs '
      : 'Forecast needs ';
    return '<span style="color:' + muted + '">' + why + need + ' days of history — ' + have + ' so far</span>';
  }
  // A memory automation watches this device: count down to its next level,
  // in that level's severity colour — "Days until Serious: 12", the number a
  // memory forecast alert would quote — instead of the distance to 100 %.
  var next = _memForecastNextLevel(fc);
  if (next) {
    var trend = fc.slopePerDay > 0
      ? ' <span style="color:' + muted + '">· trend: +' + _fmtPctPerDay(fc.slopePerDay) + '</span>'
      : fc.slopePerDay < 0 ? ' <span style="color:' + muted + '">· trend: −' + _fmtPctPerDay(fc.slopePerDay) + '</span>' : '';
    var lv = next.level || next.past;
    var title = _sevName(lv.severity) + " at " + lv.threshold + " % — from «" + lv.ruleName + "». Fitted on " +
      fc.points.length + " daily averages over the last " + (fc.lookbackDays || 30) + " days, the same figure a Memory forecast automation compares";
    var lvColor = "var(--color-sev-" + lv.severity + ", " + muted + ")";
    if (next.level) {
      var d = fc.slopePerDay > 0 ? (next.level.threshold - next.used) / fc.slopePerDay : null;
      var dText = d == null ? null : d > 365 ? "&gt; 1 year" : d < 1 ? "&lt;1" : String(Math.round(d));
      text = dText == null
        ? "Below " + _sevName(next.level.severity) + " (" + next.level.threshold + " %)" + (signal === "shrinking" ? " · shrinking" : " · not growing")
        : "Days until " + _sevName(next.level.severity) + ": <strong>" + dText + "</strong>" + trend;
      // The level's own colour while it is due; muted while it is not coming.
      color = d == null || d > 365 ? muted : lvColor;
    } else {
      text = "Above " + _sevName(next.past.severity) + " (" + next.past.threshold + " %)" + trend;
      color = lvColor;
    }
    return '<span style="color:' + color + '" title="' + escapeHtml(title) + '">' + text + '</span>';
  }
  if (signal === "growing") {
    var days = fc.daysUntilFull;
    color = days < 30 ? "var(--color-danger, #e63946)" : days < 90 ? "var(--color-warning, #f4a261)" : "var(--color-success, #2a9d8f)";
    text = "Days until full: <strong>" + days.toFixed(days < 10 ? 1 : 0) + "</strong>" +
      ' <span style="color:' + muted + '">· trend: +' + _fmtPctPerDay(fc.slopePerDay) + '</span>';
  } else if (signal === "shrinking") {
    color = "var(--color-success, #2a9d8f)";
    text = 'Shrinking <span style="color:' + muted + '">· −' + _fmtPctPerDay(fc.slopePerDay) + '</span>';
  } else if (signal === "beyond-horizon") {
    color = "var(--color-success, #2a9d8f)";
    text = "Days until full: <strong>&gt; 1 year</strong>";
  } else {
    text = "No measurable growth";
  }
  return '<span style="color:' + color + '" title="Fitted on ' + fc.points.length + ' daily averages over the last ' +
    (fc.lookbackDays || 30) + ' days — the same figure a &quot;Days until memory full&quot; automation compares">' + text + '</span>';
}

// The headline + Forecast toggle above the memory chart (or above the
// combined CPU & Memory chart, prefixed "Memory" there since the chart is
// shared). Hidden while there is no history at all — a host that has never
// reported memory has nothing to forecast and nothing to toggle.
function _renderMemForecastBar(assetId, combined) {
  var bar = document.getElementById("asset-mem-forecast");
  if (!bar) return;
  var fc = _memForecastFor(assetId);
  if (!fc || !fc.points || fc.points.length === 0) {
    bar.style.display = "none";
    bar.innerHTML = "";
    return;
  }
  var on = _getMemoryForecastVisible(assetId);
  var canDraw = _memForecastSignal(fc) !== "insufficient";
  // Switched off, the bar is the toggle alone: no countdown, no shrinking,
  // no per-day trend — none of the forecast shows until it is asked for.
  var headline = canDraw && !on ? '' :
    (combined ? '<span style="color:var(--color-text-secondary)">Memory — </span>' : '') + _memForecastHeadlineHTML(fc);
  bar.style.display = "flex";
  bar.innerHTML =
    '<div>' + headline + '</div>' +
    (canDraw
      ? '<button class="btn btn-sm ' + (on ? 'btn-primary' : 'btn-secondary') + '" data-mem-forecast-toggle title="Per asset; default off">' +
          (on ? '✓ Forecast' : 'Forecast') + '</button>'
      : '');
  var btn = bar.querySelector("[data-mem-forecast-toggle]");
  if (btn) {
    btn.addEventListener("click", function () {
      _setMemoryForecastVisible(assetId, !_getMemoryForecastVisible(assetId));
      _renderMemForecastBar(assetId, combined);
      var last = _memForecastLastRender;
      if (!last || last.assetId !== assetId) return;
      var combinedEl = document.getElementById("asset-system-chart");
      var memEl = document.getElementById("asset-memory-chart");
      if (combinedEl) _renderSystemChart(combinedEl, last.tel, last.asset, last.si);
      else if (memEl) _renderMemoryChart(memEl, last.tel, last.asset, last.si);
    });
  }
}

// The projection a chart should draw, or null. `latest` is the chart's own
// newest memory point — { t: ms, pct: 0-100 } — so the dashed line leaves
// from the end of the line the operator is looking at; `historySpan` is the
// window's width, which the projection repeats into the future (the storage
// chart's rule: an hour of history beside an hour of forecast, a week beside
// a week).
function _memForecastProjection(assetId, latest, historySpan) {
  if (!latest || !isFinite(latest.t) || typeof latest.pct !== "number") return null;
  if (!_getMemoryForecastVisible(assetId)) return null;
  var fc = _memForecastFor(assetId);
  if (_memForecastSignal(fc) === "insufficient") return null;
  var endT = latest.t + Math.max(1, historySpan);
  var endPct = latest.pct + fc.slopePerDay * ((endT - latest.t) / 86400000);
  return { startT: latest.t, startPct: latest.pct, endT: endT, endPct: Math.max(0, Math.min(100, endPct)) };
}

// Dashed projection + the "now" divider, inside the chart's clip group.
// `yForPct` maps a percentage onto the chart's own axis.
function _memForecastSVG(p, xFor, yForPct, color, padT, innerH) {
  var x1 = xFor(p.startT), y1 = yForPct(p.startPct);
  var x2 = xFor(p.endT),   y2 = yForPct(p.endPct);
  return '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '"' +
      ' stroke="' + color + '" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.85"/>' +
    '<line x1="' + x1 + '" y1="' + padT + '" x2="' + x1 + '" y2="' + (padT + innerH) + '"' +
      ' stroke="rgba(127,127,127,0.55)" stroke-width="1" stroke-dasharray="2,3"/>' +
    '<text x="' + (x1 + 3) + '" y="' + (padT + 9) + '" font-size="9" fill="currentColor" opacity="0.7">now</text>';
}

// Memory in use as a percentage, the way the server fits it: bytes first,
// the source's own percentage otherwise.
function _memInUsePct(s) {
  if (typeof s.memUsedBytes === "number" && typeof s.memTotalBytes === "number" && s.memTotalBytes > 0) {
    return Math.max(0, Math.min(100, (s.memUsedBytes / s.memTotalBytes) * 100));
  }
  return typeof s.memPct === "number" ? s.memPct : null;
}

function _renderMemoryChart(container, data, asset, si) {
  var samples = (data && data.samples) || [];
  if (samples.length === 0) {
    if (_isRestApiManagedNetworkDevice(asset, "telemetry")) {
      var telPolling = _assetMonitorStreamSource(asset, "telemetry").polling || "REST API";
      container.innerHTML = _notAvailableViaPollingHTML("Telemetry", telPolling);
    } else {
      // NO stale banner here, deliberately. The banner describes the
      // telemetry STREAM, and the CPU chart directly above renders one off
      // the same `lastTelemetryAt` — two identical amber boxes inside one
      // section read as two separate problems.
      container.innerHTML = '<div style="text-align:center">No telemetry samples in this range yet.</div>';
      container.style.flexDirection = "column";
      container.style.alignItems = "stretch";
      container.style.justifyContent = "center";
    }
    return;
  }

  var since = data && data.since;
  var until = data && data.until;
  var W = container.clientWidth || 600;
  var H = 200;
  // Wider gutter than the CPU chart: the ticks are byte figures ("12.5 GB"),
  // not two-digit percentages.
  var padL = 58, padR = 10, padT = 14, padB = 28;
  var innerW = W - padL - padR;
  var innerH = H - padT - padB;

  var bounds = _chartTimeBounds(samples, since, until);
  var t0 = bounds.t0, t1 = bounds.t1;
  var spanMs = t1 - t0, oneDayMs = 86400000;
  var pad2 = _chartPad2;

  var rows = samples.map(function (s) {
    var b = _memBandsFor(s);
    return b ? { t: +new Date(s.timestamp), ts: s.timestamp, b: b } : null;
  }).filter(Boolean);

  // Percentage-only sources (FortiOS) never produce a byte row. Fall back to
  // the single 0–100% line this chart drew before the stack existed — the
  // alternative is an empty panel on every firewall in the fleet.
  if (rows.length === 0) {
    _renderMemoryPctChart(container, data, asset, si);
    return;
  }

  // The window's vocabulary, then the bands within it that some row actually
  // reported. A source that changed mid-window (the only way two vocabularies
  // land in one range) resolves to vSphere's, since its rows are the ones
  // carrying bands the other table has no slot for.
  var isVsphere = rows.some(function (r) { return r.b.kind === "vsphere"; });
  var bandTable = isVsphere ? _MEM_BANDS_VSPHERE : _memAgentBandsFor(asset);
  // Two lists, and the difference matters everywhere below. `reported` is
  // what the source measured — the legend offers a chip for each, and the
  // tooltip names every one of them, because a number the host actually
  // reported should not vanish just because its band is switched off.
  // `bands` is what gets PAINTED.
  var reported = bandTable.filter(function (b) {
    return rows.some(function (r) { return r.b.values[b.key] != null; });
  });
  // A bytes-only source reports the primary band alone; never draw an empty
  // stack if even that is missing.
  if (reported.length === 0) reported = [bandTable[0]];
  var bands = reported.filter(function (b) { return _memBandVisible(b.key); });
  var anyDetailed = reported.length > 1;
  var hiddenBands = reported.filter(function (b) { return !_memBandVisible(b.key); });
  var anySwap = rows.some(function (r) { return r.b.swapTotal != null && r.b.swapTotal > 0; });
  var swapVisible = _memBandVisible("swap");

  // THE CEILING IS THE INSTALLED TOTAL, AND NOTHING ELSE MAY RAISE IT.
  // That is what makes the gap above the stack mean free memory, keeps the
  // axis still while usage moves, and lets two hosts be compared by eye. A
  // window in which the total itself changed (a VM resized) takes the
  // largest.
  //
  // Swap used to be allowed to push it up, so the line would "stay on the
  // canvas". That was the wrong trade: swap is backing store and can exceed
  // installed RAM (trivially so on Windows, where the page file is routinely
  // larger than RAM and a commit-charge-shaped reading is larger still), and
  // when it did, the whole physical stack squashed into the bottom of the
  // chart while the dashed Installed total line floated somewhere in the
  // middle — an axis in units of nothing in particular. The bands are the
  // subject; swap is an overlay. It is drawn inside the clip group, so the
  // part above the ceiling clips at the top edge instead of rescaling
  // everything else, and the legend says so when that happens.
  var maxTotal = 0;
  rows.forEach(function (r) { if (r.b.total > maxTotal) maxTotal = r.b.total; });
  var yMax = maxTotal > 0 ? maxTotal : 1;
  var swapOverTop = rows.some(function (r) { return r.b.swapUsed != null && r.b.swapUsed > yMax; });

  // Forecast overlay. It leaves from the newest sample's memory in use as the
  // server fits it (_memInUsePct — on an agent host that is the Processes
  // band's top edge, since cache never counts), converted to bytes against
  // that sample's installed total. The axis widens to make room; the ceiling
  // does not move, so a projection that reaches it runs along the top.
  var fcProj = null, fcTotal = null;
  for (var fi = samples.length - 1; fi >= 0; fi--) {
    var fs = samples[fi], fpct = _memInUsePct(fs);
    if (fpct != null && typeof fs.memTotalBytes === "number" && fs.memTotalBytes > 0) {
      fcTotal = fs.memTotalBytes;
      fcProj = _memForecastProjection(asset && asset.id, { t: +new Date(fs.timestamp), pct: fpct }, t1 - t0);
      break;
    }
  }
  if (fcProj && fcProj.endT > t1) { t1 = fcProj.endT; spanMs = t1 - t0; }

  var xFor = _chartXScale(padL, innerW, t0, t1);
  var yFor = _chartYScale(padT, innerH, 0, yMax);
  var forecastSvg = fcProj
    ? _memForecastSVG(fcProj, xFor, function (p) { return yFor((p / 100) * fcTotal); }, "var(--color-accent)", padT, innerH)
    : "";

  var unionTs = rows.map(function (r) { return r.t; }).sort(function (a, b) { return a - b; });
  var gapMarkers = _outageMarkers(data && data.outages, unionTs);
  var baselineY = padT + innerH;

  // Build the stack. Each band's polygon runs left-to-right along its own
  // cumulative top, then right-to-left back along the band below it.
  var runs = _memRuns(rows, gapMarkers);
  var areas = "";
  bands.forEach(function (band, bi) {
    runs.forEach(function (run) {
      if (run.length === 0) return;
      var topPts = [], botPts = [];
      run.forEach(function (r) {
        var below = 0;
        for (var k = 0; k < bi; k++) below += r.b.values[bands[k].key] || 0;
        var top = below + (r.b.values[band.key] || 0);
        var x = xFor(r.ts);
        botPts.push(x + "," + yFor(below));
        topPts.push(x + "," + yFor(top));
      });
      botPts.reverse();
      // A single-sample run has no width to fill; drop it rather than emit a
      // degenerate polygon that paints as a 1px spike.
      if (run.length < 2) return;
      areas += '<polygon points="' + topPts.join(" ") + " " + botPts.join(" ") +
        '" fill="' + band.color + '" fill-opacity="0.78" stroke="none"/>';
    });
  });

  // Installed total, as a reference line at the ceiling. Without it the
  // stack's headroom is just empty space and the operator has no anchor for
  // how much of the machine is actually spoken for.
  var totalLine = "";
  runs.forEach(function (run) {
    if (run.length < 2) return;
    totalLine += '<polyline points="' + run.map(function (r) { return xFor(r.ts) + "," + yFor(r.b.total); }).join(" ") +
      '" fill="none" stroke="' + _MEM_TOTAL_COLOR + '" stroke-width="1" stroke-dasharray="4 3"/>';
  });

  var swapLine = "";
  if (anySwap && swapVisible) {
    runs.forEach(function (run) {
      var pts = run.filter(function (r) { return r.b.swapUsed != null; });
      if (pts.length < 2) return;
      swapLine += '<polyline points="' + pts.map(function (r) { return xFor(r.ts) + "," + yFor(r.b.swapUsed); }).join(" ") +
        '" fill="none" stroke="' + _MEM_SWAP_COLOR + '" stroke-width="1.5" stroke-dasharray="2 2"/>';
    });
  }

  var failDots = _outageDotsSVG(gapMarkers, xFor, baselineY);
  var missHits = _outageHitsSVG(gapMarkers, xFor, padT, innerH);

  var hits = rows.map(function (r, i) {
    var x = xFor(r.ts);
    var leftEdge  = i === 0 ? padL : (xFor(rows[i - 1].ts) + x) / 2;
    var rightEdge = i === rows.length - 1 ? (W - padR) : (xFor(rows[i + 1].ts) + x) / 2;
    // A sample outside the plotted window (the fetch can return one older
    // than its start) puts x outside the plot: clamp the band, and draw none
    // left with no width — a negative SVG width is a console error.
    leftEdge = Math.max(padL, leftEdge);
    rightEdge = Math.min(W - padR, rightEdge);
    if (!(rightEdge > leftEdge)) return "";
    // One attribute per REPORTED band, indexed by its position in
    // `reported`, so the tooltip walks that list and neither vocabulary
    // needs its own hard-coded row set — and a switched-off band still has
    // its measured figure available to print.
    var bandAttrs = reported.map(function (b, bi2) {
      var v = r.b.values[b.key];
      return ' data-b' + bi2 + '="' + (v != null ? v : "") + '"';
    }).join("");
    return '<rect class="chart-hit" x="' + leftEdge + '" y="' + padT + '" width="' + (rightEdge - leftEdge) + '" height="' + innerH + '" fill="transparent" style="cursor:crosshair"' +
      ' data-ts="' + escapeHtml(String(r.ts)) + '"' + bandAttrs +
      ' data-fr="' + r.b.free + '" data-to="' + r.b.total + '"' +
      ' data-su="' + (r.b.swapUsed != null ? r.b.swapUsed : "") + '"' +
      ' data-st="' + (r.b.swapTotal != null ? r.b.swapTotal : "") + '"/>';
  }).join("");

  var ticks = "";
  for (var i = 0; i <= 4; i++) {
    var v = yMax * (i / 4);
    var y = padT + innerH - (i / 4) * innerH;
    ticks +=
      '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (padL - 4) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + _fmtBytes(v) + '</text>';
  }
  var xTicks = _chartXTicksSVG(t0, t1, padL, padT, innerW, innerH);

  function swatch(color, label, dashed) {
    return '<span style="display:inline-flex;align-items:center;gap:4px">' +
      (dashed
        ? '<span style="width:12px;height:0;border-top:2px dashed ' + color + '"></span>'
        : '<span style="width:10px;height:10px;border-radius:2px;background:' + color + '"></span>') +
      escapeHtml(label) + '</span>';
  }
  // Every band the source REPORTED gets a chip, switched off ones included —
  // a chip that disappeared when you clicked it would be a one-way door.
  var legendParts = reported.map(function (b) {
    return _seriesChipHTML(b.key, b.label, b.color, _memBandVisible(b.key),
      "Click to " + (_memBandVisible(b.key) ? "hide" : "show") + " " + b.label.toLowerCase(), "mem-legend-chip");
  });
  legendParts.push(swatch(_MEM_TOTAL_COLOR, "Installed total", true));
  if (fcProj) legendParts.push(swatch("var(--color-accent)", "Forecast (memory in use)", true));
  // A swap line running along the ceiling is a reading, not a rendering
  // fault — say which, or the flat line at the top reads as a stuck series.
  if (anySwap) {
    legendParts.push(_seriesChipHTML("swap",
      "Swap / page file" + (swapVisible && swapOverTop ? " — above installed RAM, clipped" : ""),
      _MEM_SWAP_COLOR, swapVisible,
      "Click to " + (swapVisible ? "hide" : "show") + " the swap line", "mem-legend-chip"));
  }
  // A source with no breakdown gets told so, in the legend, rather than
  // being left to look like a host whose cache is permanently zero. The
  // vSphere stack gets a note of its own instead: its bands are measured
  // OUTSIDE the guest, and an operator comparing them against what the guest
  // itself reports needs to know that before, not after.
  var legendNote = "";
  if (!anyDetailed) {
    legendNote = '<span style="color:var(--color-text-tertiary)">(this source reports a total only — no ' +
      (isVsphere ? "hypervisor breakdown" : "cache/buffer breakdown") + ')</span>';
  } else if (isVsphere) {
    legendNote = '<span style="color:var(--color-text-tertiary)">(as the hypervisor accounts for it — not the guest\'s own view)</span>';
  }
  // Switching a band off does not delete the memory. The gap above the stack
  // stops meaning "free" and starts meaning "free, plus what you hid", and
  // an operator reading headroom off this chart has to be told which —
  // especially since Cache ships hidden and nobody chose that.
  if (hiddenBands.length > 0) {
    legendNote += '<span style="color:var(--color-text-tertiary)">(' +
      escapeHtml(hiddenBands.map(function (b) { return b.label.toLowerCase(); }).join(" + ")) +
      ' hidden — counted in the gap, not in the stack)</span>';
  }
  var legend = '<div style="display:flex;flex-wrap:wrap;gap:4px 12px;font-size:0.72rem;color:var(--color-text-secondary);margin-bottom:2px">' +
    legendParts.join("") + legendNote + '</div>';

  var clipId = _chartClipId("memory");
  container.innerHTML =
    legend +
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      _chartClipDefs(clipId, padL, padT, innerW, innerH) +
      ticks + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      _maintenanceBandLayer(t0, t1, padL, padT, innerW, innerH) +
      '<g ' + _chartClipAttr(clipId) + '>' +
        areas +
        totalLine +
        swapLine +
        forecastSvg +
        failDots +
        hits +
        missHits +
      '</g>' +
    '</svg>' + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";
  container.style.flexDirection = "column";
  _stashChartGeometry(container, t0, t1, padL, innerW, W);

  _wireChartTooltip(container, function (target) {
    if (target.getAttribute("data-miss") === "1") return _missTooltipHTML(target);
    function num(attr) {
      var raw = target.getAttribute(attr);
      return raw === "" || raw == null ? null : Number(raw);
    }
    var total = num("data-to"), free = num("data-fr");
    var used = total != null && free != null ? total - free : null;
    var html = '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(target.getAttribute("data-ts"))) + '</div>';
    function row(color, label, val) {
      if (val == null) return "";
      var pct = total ? " (" + ((val / total) * 100).toFixed(1) + "%)" : "";
      return '<div><span style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;background:' + color + '"></span>' +
        escapeHtml(label) + ': ' + _fmtBytes(val) + pct + '</div>';
    }
    // Every reported band, drawn or not. The chart answers "what is the
    // shape of this host's memory"; the tooltip answers "what exactly was
    // measured here", and dropping a figure because its band is switched
    // off would make the second question unanswerable from the panel.
    reported.forEach(function (b, bi3) {
      html += row(b.color, b.label + (_memBandVisible(b.key) ? "" : " (hidden)"), num("data-b" + bi3));
    });
    html += row("transparent", isVsphere ? "Untouched" : "Free", free);
    if (used != null) html += '<div style="margin-top:2px"><strong>In use: ' + _fmtBytes(used) + '</strong> of ' + _fmtBytes(total) + '</div>';
    var su = num("data-su"), st = num("data-st");
    if (su != null && st) {
      html += '<div><span style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;background:' + _MEM_SWAP_COLOR + '"></span>' +
        'Swap: ' + _fmtBytes(su) + ' / ' + _fmtBytes(st) + '</div>';
    }
    return html;
  });
  _wireMemLegend(container, data, asset, si);
  _addChartScreenshotButton(container, "Memory", { yAxis: "Memory used", getStats: _statsSummaryFrom("asset-mem-summary") });
  _observeChartResize(container, function (c) { _renderMemoryChart(c, data, asset, si); });
}

// Click a band chip to switch that band out of the stack, or the swap chip
// to drop its line.
//
// Unlike the CPU chart's cores, this choice is PERSISTED per user
// (_setMemBandVisible): the bands are named and mean the same thing on every
// host, so which of them an operator wants to see is a standing preference
// rather than a per-visit one. That is also what makes "cache off by
// default" expressible at all — the default is just the stored value nobody
// has overridden yet.
//
// Re-renders from the same payload; no refetch, and no reflow of the range
// selector the two charts share.
function _wireMemLegend(container, data, asset, si) {
  container.querySelectorAll(".mem-legend-chip").forEach(function (chip) {
    chip.addEventListener("click", function () {
      var key = chip.getAttribute("data-series");
      _setMemBandVisible(key, !_memBandVisible(key));
      _renderMemoryChart(container, data, asset, si);
    });
  });
}

// Percentage-only fallback (FortiOS and anything else that reports memory as
// a bare percentage). One line on a 0–100% axis — the pre-2026-09 behaviour,
// kept because a stack cannot be built out of a single percentage.
function _renderMemoryPctChart(container, data, asset, si) {
  var samples = (data && data.samples) || [];
  var vals = samples.map(function (s) { return { s: s, v: typeof s.memPct === "number" ? s.memPct : null }; })
                    .filter(function (e) { return typeof e.v === "number"; });
  if (vals.length === 0) {
    container.innerHTML = '<div style="text-align:center">No memory samples in this range yet.</div>';
    container.style.flexDirection = "column";
    container.style.alignItems = "stretch";
    container.style.justifyContent = "center";
    return;
  }

  var since = data && data.since, until = data && data.until;
  var W = container.clientWidth || 600;
  var H = 200;
  var padL = 50, padR = 10, padT = 14, padB = 28;
  var innerW = W - padL - padR, innerH = H - padT - padB;
  var bounds = _chartTimeBounds(samples, since, until);
  var t0 = bounds.t0, t1 = bounds.t1;
  // Forecast overlay — leaves from the newest point on the line.
  var newest = null;
  vals.forEach(function (e) { var t = +new Date(e.s.timestamp); if (!newest || t > newest.t) newest = { t: t, pct: e.v }; });
  var fcProj = _memForecastProjection(asset && asset.id, newest, t1 - t0);
  if (fcProj && fcProj.endT > t1) t1 = fcProj.endT;
  var spanMs = t1 - t0, oneDayMs = 86400000;
  var pad2 = _chartPad2;
  var xFor = _chartXScale(padL, innerW, t0, t1);
  var yFor = _chartYScale(padT, innerH, 0, 100);
  var baselineY = padT + innerH;
  var unionTs = vals.map(function (e) { return +new Date(e.s.timestamp); }).sort(function (a, b) { return a - b; });
  var gapMarkers = _outageMarkers(data && data.outages, unionTs);
  var pts = vals.map(function (e) {
    return { t: +new Date(e.s.timestamp), x: xFor(e.s.timestamp), y: yFor(e.v), ok: true };
  });
  _outagePts(gapMarkers, xFor, baselineY).forEach(function (mp) { pts.push(mp); });
  pts.sort(function (a, b) { return a.t - b.t; });

  var memColor = _MEM_BANDS_AGENT[0].color;
  var line = _failureAwareSeriesSVG(pts, memColor, _chartClipId("mempct") + "-l");

  var ticks = "";
  for (var i = 0; i <= 4; i++) {
    var v = 100 * (i / 4);
    var y = padT + innerH - (i / 4) * innerH;
    ticks +=
      '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (padL - 4) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + v.toFixed(0) + '%</text>';
  }
  var xTicks = _chartXTicksSVG(t0, t1, padL, padT, innerW, innerH);
  var sorted = vals.slice().sort(function (a, b) { return new Date(a.s.timestamp).getTime() - new Date(b.s.timestamp).getTime(); });
  var hits = sorted.map(function (h, i) {
    var x = xFor(h.s.timestamp);
    var leftEdge  = i === 0 ? padL : (xFor(sorted[i - 1].s.timestamp) + x) / 2;
    var rightEdge = i === sorted.length - 1 ? (W - padR) : (xFor(sorted[i + 1].s.timestamp) + x) / 2;
    // A sample outside the plotted window (the fetch can return one older
    // than its start) puts x outside the plot: clamp the band, and draw none
    // left with no width — a negative SVG width is a console error.
    leftEdge = Math.max(padL, leftEdge);
    rightEdge = Math.min(W - padR, rightEdge);
    if (!(rightEdge > leftEdge)) return "";
    return '<rect class="chart-hit" x="' + leftEdge + '" y="' + padT + '" width="' + (rightEdge - leftEdge) + '" height="' + innerH + '" fill="transparent" style="cursor:crosshair"' +
      ' data-ts="' + escapeHtml(String(h.s.timestamp)) + '" data-mem="' + h.v + '"/>';
  }).join("");

  var clipId = _chartClipId("mempctc");
  container.innerHTML =
    '<div style="display:flex;gap:12px;font-size:0.72rem;color:var(--color-text-secondary);margin-bottom:2px">' +
      '<span style="display:inline-flex;align-items:center;gap:4px"><span style="width:10px;height:10px;border-radius:2px;background:' + memColor + '"></span>Memory used</span>' +
      (fcProj ? '<span style="display:inline-flex;align-items:center;gap:4px"><span style="width:12px;height:0;border-top:2px dashed ' + memColor + '"></span>Forecast</span>' : '') +
      '<span style="color:var(--color-text-tertiary)">(this source reports a percentage only — no byte breakdown)</span>' +
    '</div>' +
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      _chartClipDefs(clipId, padL, padT, innerW, innerH) +
      '<defs>' + line.defs + '</defs>' +
      ticks + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      _maintenanceBandLayer(t0, t1, padL, padT, innerW, innerH) +
      '<g ' + _chartClipAttr(clipId) + '>' +
        line.segments +
        vals.map(function (e) { return '<circle cx="' + xFor(e.s.timestamp) + '" cy="' + yFor(e.v) + '" r="1.5" fill="' + memColor + '"/>'; }).join("") +
        (fcProj ? _memForecastSVG(fcProj, xFor, yFor, memColor, padT, innerH) : '') +
        _outageDotsSVG(gapMarkers, xFor, baselineY) +
        hits +
        _outageHitsSVG(gapMarkers, xFor, padT, innerH) +
      '</g>' +
    '</svg>' + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";
  container.style.flexDirection = "column";
  _stashChartGeometry(container, t0, t1, padL, innerW, W);
  _wireChartTooltip(container, function (target) {
    if (target.getAttribute("data-miss") === "1") return _missTooltipHTML(target);
    var raw = target.getAttribute("data-mem");
    return '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(target.getAttribute("data-ts"))) + '</div>' +
      '<div>Memory: ' + (raw !== "" ? Number(raw).toFixed(1) + "%" : "—") + '</div>';
  });
  _addChartScreenshotButton(container, "Memory", { yAxis: "Utilization (%)", getStats: _statsSummaryFrom("asset-mem-summary") });
  _observeChartResize(container, function (c) { _renderMemoryChart(c, data, asset, si); });
}

// FortiGate active-session count chart. Reuses the telemetry-history payload
// (sessionCount rides the same rows as CPU/mem). Single auto-scaled series —
// sessions are an absolute count, not a 0-100% gauge. Hides its whole section
// when the asset reports no sessions (non-FortiGate, or no data in range).
function _renderSessionsChart(container, data, asset) {
  var section = document.getElementById("asset-system-sessions-section");
  var samples = (data && data.samples) || [];
  var vals = samples.map(function (s) { return { s: s, v: typeof s.sessionCount === "number" ? s.sessionCount : null }; })
                    .filter(function (e) { return typeof e.v === "number"; });
  if (vals.length === 0) {
    // Never revealed (asset doesn't report sessionCount) → stay hidden. A
    // section the operator can already see instead shows an empty state:
    // hiding it would take the range buttons with it, stranding whoever
    // just picked the empty window.
    if (section && section.style.display !== "none") {
      container.textContent = "No session samples in this range.";
      return;
    }
    if (section) section.style.display = "none";
    return;
  }
  if (section) section.style.display = "";

  var since = data && data.since, until = data && data.until;
  var W = container.clientWidth || 600;
  var H = 200;
  var padL = 50, padR = 10, padT = 14, padB = 28;
  var innerW = W - padL - padR;
  var innerH = H - padT - padB;
  var bounds = _chartTimeBounds(samples, since, until);
  var t0 = bounds.t0, t1 = bounds.t1;
  var spanMs = t1 - t0, oneDayMs = 86400000;
  var pad2 = _chartPad2;
  function fmtCount(n) {
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
    return String(Math.round(n));
  }

  var maxV = 0;
  vals.forEach(function (e) { if (e.v > maxV) maxV = e.v; });
  var yMin = 0, yMax = maxV > 0 ? maxV * 1.1 : 1;
  var xFor = _chartXScale(padL, innerW, t0, t1);
  var yFor = _chartYScale(padT, innerH, yMin, yMax);
  var pts = vals.map(function (e) { return xFor(e.s.timestamp) + "," + yFor(e.v); }).join(" ");

  var sorted = vals.slice().sort(function (a, b) { return new Date(a.s.timestamp).getTime() - new Date(b.s.timestamp).getTime(); });
  var hits = sorted.map(function (h, i) {
    var x = xFor(h.s.timestamp);
    var leftEdge  = i === 0 ? padL : (xFor(sorted[i - 1].s.timestamp) + x) / 2;
    var rightEdge = i === sorted.length - 1 ? (W - padR) : (xFor(sorted[i + 1].s.timestamp) + x) / 2;
    // A sample outside the plotted window (the fetch can return one older
    // than its start) puts x outside the plot: clamp the band, and draw none
    // left with no width — a negative SVG width is a console error.
    leftEdge = Math.max(padL, leftEdge);
    rightEdge = Math.min(W - padR, rightEdge);
    if (!(rightEdge > leftEdge)) return "";
    return '<rect class="chart-hit" x="' + leftEdge + '" y="' + padT + '" width="' + (rightEdge - leftEdge) + '" height="' + innerH + '" fill="transparent" style="cursor:crosshair"' +
      ' data-ts="' + escapeHtml(String(h.s.timestamp)) + '" data-sc="' + h.v + '"/>';
  }).join("");

  var ticks = "";
  for (var i = 0; i <= 4; i++) {
    var v = yMin + (yMax - yMin) * (i / 4);
    var y = padT + innerH - (i / 4) * innerH;
    ticks +=
      '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (padL - 4) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + fmtCount(v) + '</text>';
  }
  var xTicks = _chartXTicksSVG(t0, t1, padL, padT, innerW, innerH);
  var color = "#2a9d8f";
  var clipId = _chartClipId("sessions");
  container.innerHTML =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      _chartClipDefs(clipId, padL, padT, innerW, innerH) +
      ticks + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      _maintenanceBandLayer(t0, t1, padL, padT, innerW, innerH) +
      '<g ' + _chartClipAttr(clipId) + '>' +
        (pts ? '<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.5"/>' : '') +
        vals.map(function (e) { return '<circle cx="' + xFor(e.s.timestamp) + '" cy="' + yFor(e.v) + '" r="1.5" fill="' + color + '"/>'; }).join("") +
        hits +
      '</g>' +
    '</svg>' + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";
  container.style.flexDirection = "column";
  _stashChartGeometry(container, t0, t1, padL, innerW, W);

  _wireChartTooltip(container, function (target) {
    var ts = target.getAttribute("data-ts");
    var sc = target.getAttribute("data-sc");
    return '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(ts)) + '</div>' +
      '<div>Sessions: ' + (sc !== "" ? Number(sc).toLocaleString() : "—") + '</div>';
  });
  _addChartScreenshotButton(container, "Active Sessions", { yAxis: "Sessions" });
  _observeChartResize(container, function (c) { _renderSessionsChart(c, data, asset); });
}

// ─── Table-screenshot cell readers ─────────────────────────────────────────
// Lifted out of _screenshotTableEl so they can be unit-tested against real
// table markup: the screenshot is a canvas re-draw of cell TEXT, so what these
// return IS the image — a cell whose meaning lives in a color or a text-free
// glyph disappears from it unless it says so with the data-shot-* pair below.

// Extract a cell's text inserting a space at every element boundary so
// visually-separated inline badges/pills — which are spaced only by CSS
// margin, with no whitespace text node between them — don't run together in
// the flattened text (e.g. the interface name link "a" + its "Physical" type
// badge would otherwise read "aPhysical"). innerText only inserts breaks at
// block boundaries, so inline siblings need this.
//
// `data-shot-text` is the escape hatch for cell content that carries its
// meaning WITHOUT text — a colored status dot, a green/red per-scrape strip.
// Those flatten to nothing here, so the column reads EMPTY in the image while
// looking fine on screen (the SD-WAN Members up/down dot and its Health Check
// Status strip both did). The attribute's value is drawn in the element's
// place and its subtree skipped, so a 48-segment strip can state its own
// summary ("46/48 up") instead of vanishing.
function _shotCellText(el) {
  var parts = [];
  (function walk(node) {
    node.childNodes.forEach(function (n) {
      if (n.nodeType === 3) {            // text node
        if (n.nodeValue) parts.push(n.nodeValue);
      } else if (n.nodeType === 1) {     // element — pad both sides
        parts.push(' ');
        var shot = n.getAttribute && n.getAttribute('data-shot-text');
        if (shot != null) parts.push(shot);   // stands in for the subtree
        else walk(n);
        parts.push(' ');
      }
    });
  })(el);
  return parts.join('').replace(/\s+/g, ' ').trim();
}
// The capture is a canvas re-draw, not a DOM rasterization, so a cell's color
// has to be carried across explicitly — otherwise every cell paints in the
// base text color and the image flattens the one thing a table screenshot is
// often taken FOR (a red PoE "Fault", a down status pill, an alarming sensor:
// in dark theme they all came out near-white). Resolution order matters: the
// cell's OWN color first (the PoE cell colors the <td>, whose children include
// a muted "· class3" suffix that would otherwise win), then the first
// text-bearing descendant that differs from the base (status pills, type
// badges, the interface-name link).
function _shotCellColor(td, view, baseColor) {
  // An explicit declaration wins: an element whose COLOR is the cell's state
  // (a status dot with no text of its own) can't be found by the text-bearing
  // walk below, since that walk deliberately ignores glyphs. It must be a
  // RESOLVED color — canvas fillStyle silently ignores an unparseable value and
  // keeps painting in the previous cell's color, so a raw "var(--x)" would leak
  // one cell's state onto the next rather than degrading to the base color.
  var declared = td.querySelector('[data-shot-color]');
  if (declared) {
    var dc = declared.getAttribute('data-shot-color');
    if (dc && dc.indexOf('var(') !== 0) return dc;
  }
  var own = view.getComputedStyle(td).color;
  if (own && own !== baseColor) return own;
  var els = td.querySelectorAll('*');
  for (var i = 0; i < els.length; i++) {
    var t = (els[i].textContent || '').trim();
    // Decorative glyphs (the ▼/▶ expand caret, the └ nesting bullet, a "·"
    // separator) carry their own muted color and sit FIRST in the cell — they
    // would otherwise mute the whole cell instead of the label doing the
    // talking.
    if (!t || !/[a-z0-9]/i.test(t)) continue;
    if (!_shotVisible(els[i], view)) continue;
    var c = view.getComputedStyle(els[i]).color;
    if (c && c !== baseColor) return c;
  }
  return own;
}
/** display/visibility test — hidden columns, hidden rows, muted glyph colors. */
function _shotVisible(el, view) {
  var cs = view.getComputedStyle(el);
  return !cs || (cs.display !== 'none' && cs.visibility !== 'hidden');
}

// Data rows the operator has hidden (the children of a collapsed parent).
// They're left out of the image, but their count is noted under it so the
// screenshot can't be mistaken for the full set — reveal them, then re-shoot.
// Control rows don't count: a toggle-button row, or a full-width section /
// grouping header that spans every column via colspan.
function _shotHiddenRowCount(tableEl, view) {
  var n = 0;
  tableEl.querySelectorAll('tbody > tr').forEach(function (tr) {
    if (_shotVisible(tr, view)) return;
    if (tr.id && /toggle/i.test(tr.id)) return;
    var tds = tr.querySelectorAll(':scope > td');
    if (tds.length === 0) return;
    if (tds.length === 1 && tds[0].hasAttribute('colspan')) return;
    n++;
  });
  return n;
}
// Is a computed background color one that paints nothing? `transparent` and any
// zero-alpha rgba() are see-through; everything else (including a keyword a
// browser hands back unresolved) counts as painted.
function _shotTransparentBg(bg) {
  if (!bg || bg === 'transparent') return true;
  var m = /^rgba?\(([^)]*)\)$/.exec(bg);
  if (!m) return false;
  var parts = m[1].split(/[\s,\/]+/).filter(function (p) { return p !== ''; });
  return parts.length > 3 && parseFloat(parts[3]) === 0;
}
// The color to lay behind a captured table. A table declares no background of
// its own — its rows are transparent over whatever card they sit in — so
// composing on --color-bg-primary would put the wrong ground under the zebra
// striping in every theme whose cards aren't the page color. Walk up to the
// first ancestor that actually paints.
function _shotBackdropColor(el, view, fallback) {
  for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
    var bg = view.getComputedStyle(n).backgroundColor;
    if (!_shotTransparentBg(bg)) return bg;
  }
  return fallback;
}

// Per-table screenshot (the camera button injected to the left of a table's
// column-chooser gear by setupColumnLayout). Captures only that table, as it is
// actually rendered — the operator's visible columns in their dragged order and
// widths, the zebra striping, status dots, pills, and the green/red per-scrape
// health-check strips — titled with the table label and the current asset name,
// then copies the PNG to the clipboard.
//
// This is a DOM rasterization: html-to-image, the same library and the same
// deep-clone → inlined computed styles → SVG <foreignObject> path
// _runScreenshotCapture uses for a whole tab. It replaced a synthetic canvas
// re-draw, which could only paint each cell's FLATTENED TEXT in one resolved
// color — so everything a table says with shape or color reached the image as a
// stand-in glyph at best and as nothing at all at worst: the SD-WAN Members
// Health Check Status column arrived as the words "▼ 36/37 up" in place of 37
// colored segments, its status dots as ▲/▼, and a health-check chip's colored
// bullet as a bare triangle. That composer survives as _screenshotTableElText,
// the fallback for a browser where the capture library didn't load or the
// rasterization failed — it needs nothing but the DOM, and the data-shot-text /
// data-shot-color stand-ins exist for it alone.
//
// The table is captured at its CURRENT rendered width, deliberately unlike the
// tab capture's canonical 1100px: applyTableLayout stamps per-column pixel
// widths under `table-layout: fixed`, so forcing the container wider would
// leave every column where it is and only add dead space to the right.
function _screenshotTableEl(tableEl, label, opts) {
  if (!tableEl) { showToast("Nothing to screenshot", "error"); return; }
  opts = opts || {};
  if (typeof htmlToImage === "undefined") { _screenshotTableElText(tableEl, label, opts); return; }
  var view = (tableEl.ownerDocument && tableEl.ownerDocument.defaultView) || window;
  var hiddenNoun = opts.hiddenNoun || "row";

  var bodyRows = Array.prototype.slice.call(tableEl.querySelectorAll('tbody > tr'));
  var anyVisible = bodyRows.some(function (tr) { return _shotVisible(tr, view); });
  if (!anyVisible) { showToast("Nothing to screenshot", "error"); return; }

  var hiddenCount = _shotHiddenRowCount(tableEl, view);
  var hiddenNote = hiddenCount > 0
    ? "+ " + hiddenCount + " hidden " + hiddenNoun + (hiddenCount === 1 ? "" : "s") +
      " not shown — reveal them before screenshotting to include"
    : "";

  var a = _currentAssetForRefresh;
  var assetName = a ? (a.hostname || a.dnsName || a.ipAddress || a.id || "") : "";
  var staleText = _staleBannerTextFor(tableEl);

  var cs = getComputedStyle(document.documentElement);
  var bgPrimary = cs.getPropertyValue("--color-bg-primary").trim() || "#ffffff";
  var clrText   = cs.getPropertyValue("--color-text-primary").trim() || "#111";
  var clrMuted  = cs.getPropertyValue("--color-text-tertiary").trim() || "#888";
  var clrWarn   = cs.getPropertyValue("--color-warning").trim() || "#f57f17";
  var fontSans  = cs.getPropertyValue("--font-sans").trim() || "system-ui,-apple-system,sans-serif";
  var backdrop  = _shotBackdropColor(tableEl, view, bgPrimary);

  // Hide the scroll wrapper's scrollbar chrome for the duration: the class sets
  // `scrollbar-width: none` on the LIVE nodes, and it's those computed styles
  // html-to-image freezes into the clone. The wrapper is never the capture
  // target — it's a bounded-height scroll container, so capturing it would clip
  // every row below the fold (and every column right of the horizontal scroll);
  // the table element itself is content-sized in both axes.
  var wrap = tableEl.closest('.table-wrapper-sticky') || tableEl.parentElement;
  if (wrap) wrap.classList.add('screenshot-hide-scrollbars');
  function release() { if (wrap) wrap.classList.remove('screenshot-hide-scrollbars'); }

  var scale = 2;
  // Double-rAF clears the relayout hiding the scrollbars kicks off — on
  // classic-scrollbar platforms it widens the scroll container by the bar width.
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      htmlToImage.toCanvas(tableEl, { pixelRatio: scale, backgroundColor: backdrop })
        .then(function (capture) {
          release();
          var pad = 20;
          var staleY = assetName ? 58 : 40;
          var titleH = (assetName ? 48 : 32) + (staleText ? 20 : 0);
          var w = capture.width / scale;
          var h = capture.height / scale;
          var noteH = hiddenNote ? 24 : 0;
          // The note and stale line can be wider than the table — widen the canvas for them.
          var measure = document.createElement("canvas").getContext("2d");
          measure.font = "italic 12px " + fontSans;
          var noteW = hiddenNote ? measure.measureText(hiddenNote).width : 0;
          measure.font = "600 12px " + fontSans;
          var staleW = staleText ? measure.measureText(staleText).width : 0;
          var cw = Math.max(w, Math.ceil(noteW), Math.ceil(staleW)) + pad * 2;
          var ch = titleH + h + noteH + pad;
          var canvas = document.createElement("canvas");
          canvas.width = cw * scale;
          canvas.height = ch * scale;
          var ctx = canvas.getContext("2d");
          ctx.scale(scale, scale);
          ctx.fillStyle = bgPrimary;
          ctx.fillRect(0, 0, cw, ch);
          ctx.textBaseline = "alphabetic";
          ctx.fillStyle = clrText;
          ctx.font = "bold 15px " + fontSans;
          ctx.fillText(label || "Table", pad, 22);
          if (assetName) {
            ctx.fillStyle = clrMuted;
            ctx.font = "12px " + fontSans;
            ctx.fillText(assetName, pad, 40);
          }
          if (staleText) {
            ctx.fillStyle = clrWarn;
            ctx.font = "600 12px " + fontSans;
            ctx.fillText(staleText, pad, staleY);
          }
          // 1:1 device-pixel blit (w×h CSS px under the 2x transform), so the
          // captured table is never resampled.
          ctx.drawImage(capture, pad, titleH, w, h);
          if (hiddenNote) {
            ctx.fillStyle = clrMuted;
            ctx.font = "italic 12px " + fontSans;
            ctx.fillText(hiddenNote, pad, titleH + h + 16);
          }
          canvas.toBlob(function (blob) {
            if (!blob) { showToast("Screenshot failed", "error"); return; }
            copyPngToClipboard(blob).then(function (ok) {
              showToast(ok ? (label || "Table") + " copied to clipboard" : "Screenshot failed — requires HTTPS or clipboard permission", ok ? "success" : "error");
            });
          }, "image/png");
        })
        .catch(function () {
          release();
          // A rasterization that fell over (a tainted canvas, a webfont fetch
          // wedging the clone) still has a readable answer to give.
          _screenshotTableElText(tableEl, label, opts);
        });
    });
  });
}

// Fallback table screenshot: a synthetic canvas re-draw of each visible cell's
// flattened text (_shotCellText) in one resolved color (_shotCellColor), with
// auto-fit column widths. Used when html-to-image is unavailable or its
// rasterization failed — see _screenshotTableEl for why it is no longer the
// primary path, and polaris-ui-canon → canon-tables-lists.md for the
// data-shot-text / data-shot-color contract that keeps a color-only cell from
// coming out blank HERE.
function _screenshotTableElText(tableEl, label, opts) {
  if (!tableEl) { showToast("Nothing to screenshot", "error"); return; }
  opts = opts || {};
  var hiddenNoun = opts.hiddenNoun || "row";
  var view = (tableEl.ownerDocument && tableEl.ownerDocument.defaultView) || window;
  function visible(el) { return _shotVisible(el, view); }
  var baseColor = view.getComputedStyle(tableEl).color;
  var ths = Array.prototype.slice.call(tableEl.querySelectorAll('thead th'));
  var visMask = ths.map(visible);
  var headers = [];
  ths.forEach(function (th, i) {
    if (visMask[i]) headers.push((th.innerText || th.textContent || '').trim());
  });
  var rows = [];
  var rowColors = [];   // parallel to rows: the per-cell color to draw with
  var hiddenCount = _shotHiddenRowCount(tableEl, view);
  tableEl.querySelectorAll('tbody > tr').forEach(function (tr) {
    if (!visible(tr)) return;
    var row = [];
    var colors = [];
    tr.querySelectorAll(':scope > td').forEach(function (td, i) {
      if (visMask[i] === false) return;   // skip hidden columns
      row.push(_shotCellText(td));
      colors.push(_shotCellColor(td, view, baseColor));
    });
    if (row.length) { rows.push(row); rowColors.push(colors); }
  });
  if (!rows.length) { showToast("Nothing to screenshot", "error"); return; }

  var hiddenNote = hiddenCount > 0
    ? "+ " + hiddenCount + " hidden " + hiddenNoun + (hiddenCount === 1 ? "" : "s") +
      " not shown — reveal them before screenshotting to include"
    : "";

  var a = _currentAssetForRefresh;
  var assetName = a ? (a.hostname || a.dnsName || a.ipAddress || a.id || "") : "";

  var cs = getComputedStyle(document.documentElement);
  var bgPrimary = cs.getPropertyValue("--color-bg-primary").trim() || "#ffffff";
  var bgSurface = cs.getPropertyValue("--color-surface").trim() || "#f5f5f5";
  var clrBorder = cs.getPropertyValue("--color-border").trim() || "#e0e0e0";
  var clrText   = cs.getPropertyValue("--color-text-primary").trim() || "#111";
  var clrMuted  = cs.getPropertyValue("--color-text-tertiary").trim() || "#888";
  var clrWarn   = cs.getPropertyValue("--color-warning").trim() || "#f57f17";
  var staleText = _staleBannerTextFor(tableEl);

  var scale = 2;
  var pad = 20;
  var headerLines = (assetName ? 2 : 1);
  var staleY = headerLines === 2 ? 58 : 40;
  var titleH = (headerLines === 2 ? 48 : 32) + (staleText ? 20 : 0);
  var tableHeaderH = 26;
  var tableRowH = 22;
  var cellPadX = 10;
  var fontFamily = "system-ui,-apple-system,sans-serif";

  var cols = Math.max(1, headers.length || (rows[0] ? rows[0].length : 1));
  var measureCtx = document.createElement("canvas").getContext("2d");
  var colW = [];
  for (var c = 0; c < cols; c++) {
    measureCtx.font = "600 10px " + fontFamily;
    var maxW = headers[c] ? measureCtx.measureText(headers[c].toUpperCase()).width : 0;
    measureCtx.font = "12px " + fontFamily;
    for (var r = 0; r < rows.length; r++) {
      var cell = rows[r][c] || '';
      var cw = measureCtx.measureText(cell).width;
      if (cw > maxW) maxW = cw;
    }
    colW[c] = Math.min(360, Math.max(64, Math.ceil(maxW) + cellPadX * 2));
  }
  var contentW = colW.reduce(function (acc, x) { return acc + x; }, 0);
  var noteH = hiddenNote ? 24 : 0;
  // The note can be wider than the (auto-fit) table — widen the canvas for it.
  var noteW = 0;
  if (hiddenNote) { measureCtx.font = "italic 12px " + fontFamily; noteW = measureCtx.measureText(hiddenNote).width; }
  var staleW = 0;
  if (staleText) { measureCtx.font = "600 12px " + fontFamily; staleW = measureCtx.measureText(staleText).width; }
  var w = Math.max(contentW, Math.ceil(noteW), Math.ceil(staleW)) + pad * 2;
  var hdrH = headers.length ? tableHeaderH : 0;
  var h = titleH + hdrH + rows.length * tableRowH + noteH + pad;

  var canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = h * scale;
  var ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.fillStyle = bgPrimary;
  ctx.fillRect(0, 0, w, h);

  function fitText(text, maxTextW) {
    var t = String(text == null ? '' : text);
    while (ctx.measureText(t).width > maxTextW && t.length > 3) {
      t = t.slice(0, -4) + '…';
    }
    return t;
  }

  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = clrText;
  ctx.font = "bold 15px " + fontFamily;
  ctx.fillText(label || "Table", pad, 22);
  if (assetName) {
    ctx.fillStyle = clrMuted;
    ctx.font = "12px " + fontFamily;
    ctx.fillText(assetName, pad, 40);
  }
  if (staleText) {
    ctx.fillStyle = clrWarn;
    ctx.font = "600 12px " + fontFamily;
    ctx.fillText(staleText, pad, staleY);
  }

  var ty = titleH;
  if (headers.length) {
    ctx.fillStyle = bgSurface;
    ctx.fillRect(pad, ty, contentW, tableHeaderH);
    ctx.fillStyle = clrMuted;
    ctx.font = "600 10px " + fontFamily;
    var hx = pad;
    for (var hi = 0; hi < cols; hi++) {
      ctx.fillText(fitText((headers[hi] || '').toUpperCase(), colW[hi] - cellPadX * 2), hx + cellPadX, ty + 17);
      hx += colW[hi];
    }
    ty += tableHeaderH;
  }
  ctx.font = "12px " + fontFamily;
  rows.forEach(function (row, ri) {
    if (ri % 2 === 1) {
      ctx.fillStyle = bgSurface;
      ctx.fillRect(pad, ty, contentW, tableRowH);
    }
    var cx = pad;
    for (var ci = 0; ci < cols; ci++) {
      ctx.fillStyle = (rowColors[ri] && rowColors[ri][ci]) || clrText;
      ctx.fillText(fitText(row[ci] || '', colW[ci] - cellPadX * 2), cx + cellPadX, ty + 15);
      cx += colW[ci];
    }
    ty += tableRowH;
  });
  ctx.strokeStyle = clrBorder;
  ctx.lineWidth = 1;
  ctx.strokeRect(pad + 0.5, titleH + 0.5, contentW - 1, ty - titleH - 1);

  if (hiddenNote) {
    ctx.fillStyle = clrMuted;
    ctx.font = "italic 12px " + fontFamily;
    ctx.fillText(hiddenNote, pad, ty + 16);
  }

  canvas.toBlob(function (blob) {
    if (!blob) { showToast("Screenshot failed", "error"); return; }
    copyPngToClipboard(blob).then(function (ok) {
      showToast(ok ? (label || "Table") + " copied to clipboard" : "Screenshot failed — requires HTTPS or clipboard permission", ok ? "success" : "error");
    });
  }, "image/png");
}
