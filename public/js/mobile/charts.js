// public/js/mobile/charts.js — Tiny SVG line-chart helper.
//
// All charts in the mobile app are simple polyline overlays on a flexible-
// width SVG box. Multiple series are supported so the same helper drives
// the response-time chart, the CPU+Memory chart, and future per-interface
// throughput charts.
//
// The SVG plot uses `preserveAspectRatio="none"` so the polyline stretches
// to fill the container — that scales any text inside, which is why the
// axis labels are HTML positioned around the SVG rather than <text> nodes
// inside it. The wrapper is `.chart-wrap` (see mobile.css).
//
// usage:
//   PolarisCharts.lineChart({
//     series: [
//       { values: [{ts, v}, ...], color: "var(--md-primary)", fill: true, label: "RTT" },
//     ],
//     // a series may also set `width` (stroke px, default 1.6) and `opacity`,
//     // and `max: [{ts, v, rec?}]` — its rollup buckets' MAX, drawn as a
//     // dashed companion line (see "Bucket max" below)
//     showMax: true,         // draw the `max` companions (default true)
//     maxToggle: true,       // render the Max chip under the chart
//     yMin: 0, yMax: 100,    // optional — auto-derived if absent
//     yUnit: "%",            // appended to y-axis tick labels
//     height: 80,            // total px including axis gutters
//     ariaLabel: "Response time over the last 24 hours",
//   })
//   → returns HTML string ready to drop into innerHTML
//
// Missed polls read the same way they do on the desktop charts: a failed poll
// sits at the chart baseline in red and stays connected to its neighbors, with
// the transition segment fading between the series color and red so an outage
// looks like the line diving to zero instead of a straight bridge over the
// hole. Two ways to feed that in per series:
//
//   • `{ ts, v: null, ok: false }` points — for streams that carry an explicit
//     per-sample success flag (the monitor/response-time stream).
//   • `gapFade: true` on the series PLUS `outages` on the chart options — for
//     streams where a failed poll simply leaves no row (CPU/memory telemetry).
//     `outages` is the [{from, to}] list the chart endpoints serve: the
//     stretches during which every response-time probe failed. The heavy
//     cadences do not run while an asset is down, so that probe stream is the
//     only record that the poll was missed at all.
//
// Maintenance windows draw as labelled lavender bands, the phone half of
// `_maintenanceBandLayer` in public/js/assets.js: pass `maintenance` (the
// `windows` array GET /assets/:id/maintenance-windows serves) plus `from` /
// `to` (the requested range, ms). Server-driven polling stops for the whole
// window, so the series simply has no rows there — the band says why. The
// time axis stretches over the in-range part of every window, because a
// window still open at the right-hand edge would otherwise fall off the end
// of an axis that stops at the last sample, and a range spent entirely in
// maintenance draws the band instead of "No data".
//
// Bucket max: a chart reading a ROLLUP tier (the history payload's
// `bucketSeconds > 0`) plots each bucket's average, which flattens the spikes
// the bucket held. A series' `max` companion draws the bucket MAX as a dashed
// ("2 3") line in the series' own colour, thinner and fainter than the
// average and drawn under every average, broken wherever a bucket's max is
// null. While `showMax` is on the value axis spans the max too, so it is
// never clipped; off, it spans the averages only. `maxToggle: true` adds the
// `Max` chip (`maxChipHTML`) under the chart when any max was supplied; the
// caller re-renders on a tap through `wireMaxToggle(host, onToggle)` and
// keeps the choice. A max point may carry `rec` (the response-time chart's
// recovering bucket) and takes that verdict colour like its average does.

(function () {
  // Gutter widths chosen so axis labels fit without crowding the plot at
  // the default 80px chart height.
  var LEFT_GUTTER   = 36;
  var RIGHT_GUTTER  = 8;
  var BOTTOM_GUTTER = 18;
  var TOP_GUTTER    = 4;

  // The returned markup lands in innerHTML, and ariaLabel can carry
  // API-sourced names (e.g. SD-WAN health-check names) — escape anything
  // interpolated into an attribute.
  function escapeAttr(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // The missed-poll / recovery vocabulary and the outage-marker helpers are
  // shared with the desktop charts — public/js/chart-shared.js, loaded before
  // this file. The alert email (src/utils/sparklineSvg.ts) holds the same four
  // hexes; change them there too.
  var CS = window.PolarisChartShared;
  var FAIL_COLOR = CS.FAIL_COLOR, DEP_COLOR = CS.DEP_COLOR;
  var MISS_COLOR = CS.MISS_COLOR, RECOVER_COLOR = CS.RECOVER_COLOR;
  var pointColorFor = CS.chartPointColor;
  var medianCadenceMs = CS.medianCadenceMs;
  var outageMarkers = CS.outageMarkers;

  function failColorFor(p) { return pointColorFor(p, null); }

  // Gradient ids must be unique per rendered chart — several charts share the
  // asset sheet's DOM (response time, CPU/memory, three SD-WAN charts).
  var _chartSeq = 0;

  // Normalize one series' `values` into time-ordered { ts (ms), v, ok } points:
  // drops junk and coerces explicit `ok:false` failures into valueless
  // baseline points.
  function seriesPoints(s) {
    var pts = [];
    (s.values || []).forEach(function (p) {
      if (p == null || p.ts == null) return;
      var failed = p.ok === false;
      if (p.v == null && !failed) return;
      var t = +new Date(p.ts);
      if (!isFinite(t)) return;
      pts.push({
        ts: t, v: failed ? null : p.v, ok: !failed, dep: p.dep === true,
        // Carried through from the caller's replay of the monitor state machine
        // (PolarisMonitorStates). `down === false` is the deliberate amber; both
        // are undefined on every series that never resolved a threshold, which
        // leaves those charts exactly as they were.
        rec: p.rec === true, down: p.down, downColor: p.downColor,
      });
    });
    pts.sort(function (a, b) { return a.ts - b.ts; });
    return pts;
  }

  // Missed-poll markers for the `gapFade` series, derived ONCE from the chart's
  // outage windows and the UNION of those series' good timestamps, then applied
  // to all of them — the same rule the desktop CPU/memory + interface charts
  // use. Union rather than per-series because CPU and memory ride the same
  // telemetry row: shared markers keep both lines diving at the same x instead
  // of drawing two offset red notches, and the union is also the right input to
  // the reported-through test (a sample on EITHER series proves the host was
  // reporting).
  function applySharedOutageMarkers(prepared, outages) {
    var seen = {};
    var any = false;
    prepared.forEach(function (e) {
      if (!e.s.gapFade) return;
      any = true;
      e.pts.forEach(function (p) { if (p.ok) seen[p.ts] = true; });
    });
    if (!any) return [];
    var union = Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
    var marks = outageMarkers(outages, union);
    if (!marks.length) return marks;
    prepared.forEach(function (e) {
      if (!e.s.gapFade || !e.pts.length) return;
      marks.forEach(function (m) { e.pts.push({ ts: m.t, v: null, ok: false, dep: m.dep }); });
      e.pts.sort(function (a, b) { return a.ts - b.ts; });
    });
    return marks;
  }

  // Failure-aware line rendering over plot-space { x, y, ok } points. Runs of
  // same-state points collapse into one polyline (a phone can hold a day of
  // per-minute samples, so per-segment <line> elements the way the desktop
  // chart emits them would be thousands of nodes); each OK↔fail transition
  // gets its own userSpaceOnUse linearGradient so the stroke visibly fades
  // between the series color and red instead of jumping.
  // `width` / `opacity` are the series' own stroke (default 1.6, opaque) — a
  // many-series chart draws its per-core lines thin and translucent under the
  // one line every threshold reads.
  function failureAwareSegments(pts, seriesColor, idPrefix, width, opacity) {
    var defs = "";
    var out = "";
    var sw = width > 0 ? width : 1.6;
    var op = opacity != null && opacity < 1 ? ' stroke-opacity="' + opacity + '"' : "";
    // Colour, not ok-ness, is what breaks a run: a red outage that runs into a
    // grey dependency stretch (the parent went down part-way through) has to
    // split, or the whole thing takes the first point's stroke.
    function strokeFor(p) { return pointColorFor(p, seriesColor); }
    function polyline(slice, p0) {
      if (slice.length < 2) return "";
      return '<polyline points="' + slice.map(function (p) { return p.x.toFixed(1) + "," + p.y.toFixed(1); }).join(" ") +
        '" fill="none" stroke="' + strokeFor(p0) + '" stroke-width="' + sw + '"' + op + ' stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
    }
    var runStart = 0;
    for (var i = 1; i <= pts.length; i++) {
      var atEnd = i === pts.length;
      if (!atEnd && strokeFor(pts[i]) === strokeFor(pts[i - 1])) continue;
      out += polyline(pts.slice(runStart, i), pts[runStart]);
      if (atEnd) break;
      var a = pts[i - 1], b = pts[i];
      var gid = idPrefix + "-g" + i;
      defs += '<linearGradient id="' + gid + '" gradientUnits="userSpaceOnUse"' +
        ' x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '">' +
        '<stop offset="0%" stop-color="' + strokeFor(a) + '"/>' +
        '<stop offset="100%" stop-color="' + strokeFor(b) + '"/>' +
        '</linearGradient>';
      out += '<line x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) +
        '" stroke="url(#' + gid + ')" stroke-width="1.6" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
      runStart = i;
    }
    return { defs: defs, segments: out };
  }

  // Red baseline dots for failed polls, so a lone missed poll is visible and
  // not just a hairline notch. Drawn as a near-zero-length round-capped stroke
  // rather than a <circle>: the plot uses preserveAspectRatio="none", which
  // squashes circles into ellipses, while a non-scaling stroke stays round in
  // screen space at whatever width the phone renders the chart.
  function failureDots(pts) {
    return pts.filter(function (p) { return !p.ok; }).map(function (p) {
      // Both endpoints round at the same precision so the stub always runs
      // forward by exactly 0.01 user units.
      return '<line x1="' + p.x.toFixed(2) + '" y1="' + p.y.toFixed(2) + '" x2="' + (p.x + 0.01).toFixed(2) + '" y2="' + p.y.toFixed(2) +
        '" stroke="' + failColorFor(p) + '" stroke-width="4" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
    }).join("");
  }

  // Same lavender as the desktop band and the phone's `.dot.maint`.
  var MAINT_FILL   = "rgba(149,117,205,0.14)";
  var MAINT_STROKE = "rgba(149,117,205,0.45)";
  // A band narrower than this share of the plot carries no label — the
  // mobile counterpart of the desktop's 46px floor.
  var MAINT_LABEL_MIN_FRAC = 0.15;

  // Maintenance windows → [{ from, to, name }] (ms) clamped to [lo, hi]. An
  // open window (`endedAt` null) runs to `nowMs`. Windows outside the range,
  // or with an unparseable start, are dropped.
  function maintenanceSpans(windows, lo, hi, nowMs) {
    if (!windows || !windows.length || !(hi > lo)) return [];
    var out = [];
    windows.forEach(function (w) {
      if (!w) return;
      var ws = +new Date(w.startedAt);
      var we = w.endedAt ? +new Date(w.endedAt) : nowMs;
      if (!isFinite(ws) || !isFinite(we) || we <= lo || ws >= hi) return;
      out.push({ from: Math.max(ws, lo), to: Math.min(we, hi), name: w.scheduleName || "Maintenance" });
    });
    return out.sort(function (a, b) { return a.from - b.from; });
  }

  function lineChart(opts) {
    opts = opts || {};
    var series = opts.series || [];
    var totalHeight = opts.height || 80;
    var viewWidth   = opts.width  || 600;     // viewBox width — scales to 100% in CSS
    var pad = opts.padding || 2;              // breathing room inside the plot
    var yUnit = opts.yUnit || "";

    // Normalize every series up front so the range/axis passes and the render
    // pass agree on exactly which points exist (gap markers included).
    var prepared = series.map(function (s) { return { s: s, pts: seriesPoints(s), maxPts: maxPoints(s) }; });
    applySharedOutageMarkers(prepared, opts.outages);
    var showMax = opts.showMax !== false;
    var anyMax = prepared.some(function (e) {
      return e.maxPts.some(function (p) { return p.v != null; });
    });
    // The chip's swatch: the line's own colour when every max line shares one
    // (response time, CPU only), so the key matches what it toggles; the chip's
    // text colour when they differ (in/out, members).
    var maxColors = {};
    prepared.forEach(function (e) {
      if (e.maxPts.some(function (p) { return p.v != null; })) maxColors[e.s.color || "var(--md-primary)"] = true;
    });
    var maxSwatch = Object.keys(maxColors).length === 1 ? Object.keys(maxColors)[0] : null;

    // With an explicit range the window's left edge is `from`. History
    // endpoints return lookback rows before it only so a line can enter from
    // the edge; they sit off-plot (the root <svg> clips its overflow) and must
    // neither stretch the time axis nor widen the value axis.
    var hasRange = opts.from != null && opts.to != null && isFinite(+opts.from) && isFinite(+opts.to);
    var edge = hasRange ? +opts.from : -Infinity;

    // Figure out the y-axis range across all visible points. Failed polls carry
    // no value — they plot at the baseline — so they never widen the range.
    var yMin = (opts.yMin != null) ? opts.yMin : Infinity;
    var yMax = (opts.yMax != null) ? opts.yMax : -Infinity;
    var anyValues = false, anyPoints = false;
    prepared.forEach(function (e) {
      e.pts.forEach(function (p) {
        if (p.ts < edge) return;
        anyPoints = true;
        if (p.v == null) return;
        anyValues = true;
        if (opts.yMin == null && p.v < yMin) yMin = p.v;
        if (opts.yMax == null && p.v > yMax) yMax = p.v;
      });
      // A shown max widens the axis so its peaks are never clipped; a hidden
      // one leaves the axis to the averages.
      if (!showMax) return;
      e.maxPts.forEach(function (p) {
        if (p.ts < edge || p.v == null) return;
        if (opts.yMin == null && p.v < yMin) yMin = p.v;
        if (opts.yMax == null && p.v > yMax) yMax = p.v;
      });
    });
    // Time axis from the union of all series, then widened over the in-range
    // part of every maintenance window. Without an explicit range there is
    // nothing to widen TO, so bands are clipped to the samples' own span.
    var tMin = Infinity, tMax = -Infinity;
    prepared.forEach(function (e) {
      e.pts.forEach(function (p) {
        if (p.ts < edge) return;
        if (p.ts < tMin) tMin = p.ts;
        if (p.ts > tMax) tMax = p.ts;
      });
    });
    // A series whose first in-window reading lands after the edge still
    // starts at the edge when a lookback row exists to enter from.
    var anyLookback = hasRange && prepared.some(function (e) { return e.pts.length && e.pts[0].ts < edge; });
    if (anyLookback) tMin = edge;
    var nowMs = Date.now();
    var bands = hasRange
      ? maintenanceSpans(opts.maintenance, +opts.from, +opts.to, nowMs)
      : (anyPoints ? maintenanceSpans(opts.maintenance, tMin, tMax, nowMs) : []);
    bands.forEach(function (b) {
      if (b.from < tMin) tMin = b.from;
      if (b.to > tMax) tMax = b.to;
    });
    if (!anyPoints && !bands.length) {
      return ''
        + '<div class="chart-wrap" style="height:' + totalHeight + 'px;">'
        + '  <div class="chart-empty">No data</div>'
        + '</div>';
    }
    // A window with nothing but failed polls (device down the whole time) still
    // has something to say — plot the red baseline on a nominal 0–1 axis rather
    // than falling through to "No data".
    if (!anyValues) {
      if (opts.yMin == null) yMin = 0;
      if (opts.yMax == null) yMax = 1;
    }
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    if (opts.yMin == null) yMin = Math.min(yMin, 0);

    if (tMin === tMax) tMax = tMin + 1;

    // Plot area in viewBox space — leave gutters at top/bottom for breathing
    // room (the actual axis labels are HTML, sitting in the wrapper's
    // padding around the SVG).
    var plotHeight = totalHeight - TOP_GUTTER - BOTTOM_GUTTER;
    function x(t) { return pad + (viewWidth - 2 * pad) * ((+new Date(t) - tMin) / (tMax - tMin)); }
    function y(v) { return plotHeight - pad - (plotHeight - 2 * pad) * ((v - yMin) / (yMax - yMin)); }
    var baselineY = plotHeight - pad;   // where failed polls sit

    _chartSeq += 1;
    var idPrefix = "pc-" + _chartSeq;

    var defs = "";
    var body = [];

    // Faint y midline so the eye has something to anchor on.
    body.push('<line x1="0" x2="' + viewWidth + '" y1="' + (plotHeight / 2).toFixed(1) + '" y2="' + (plotHeight / 2).toFixed(1) + '" stroke="var(--md-outline-variant)" stroke-width="0.5" stroke-dasharray="2,2" opacity="0.5"/>');

    // Maintenance bands sit under the series so the line stays on top.
    var maint = maintenanceLayer(bands, x, plotHeight, viewWidth, pad);
    body.push(maint.svg);
    var maintLabels = maint.labels;

    // Bucket-max companions first, so every average draws over every max.
    if (showMax) {
      prepared.forEach(function (e) {
        if (!e.maxPts.length) return;
        body.push(maxLine(e.maxPts, e.s, x, y));
      });
    }

    prepared.forEach(function (e, si) {
      var color = e.s.color || "var(--md-primary)";
      var plot = e.pts.map(function (p) {
        return { x: x(p.ts), y: p.ok ? y(p.v) : baselineY, ok: p.ok, dep: p.dep, rec: p.rec, down: p.down, downColor: p.downColor };
      });
      if (!plot.length) return;

      if (e.s.fill) {
        var first = plot[0], last = plot[plot.length - 1];
        var fillPts = plot.map(function (p) { return p.x.toFixed(1) + "," + p.y.toFixed(1); }).join(" ")
          + " " + last.x.toFixed(1) + "," + baselineY.toFixed(1)
          + " " + first.x.toFixed(1) + "," + baselineY.toFixed(1);
        body.push('<polygon points="' + fillPts + '" fill="' + color + '" opacity="0.12"/>');
      }

      var seg = failureAwareSegments(plot, color, idPrefix + "-s" + si, e.s.width, e.s.opacity);
      defs += seg.defs;
      body.push(seg.segments);
      body.push(failureDots(plot));
    });

    var svgParts = [];
    var aria = (opts.ariaLabel || "Chart") + (bands.length ? " (includes maintenance — polling paused)" : "");
    svgParts.push('<svg class="chart-svg" viewBox="0 0 ' + viewWidth + ' ' + plotHeight + '" preserveAspectRatio="none" role="img" aria-label="' + escapeAttr(aria) + '">');
    if (defs) svgParts.push('<defs>' + defs + '</defs>');
    svgParts.push(body.join(""));
    svgParts.push('</svg>');

    // Y-axis labels — three ticks (max / mid / min) on the left gutter.
    var yMid = (yMin + yMax) / 2;
    var yLabels = ''
      + '<div class="chart-y-labels">'
      + '  <span class="chart-y-tick" style="top:0;">'                 + formatY(yMax, yUnit) + '</span>'
      + '  <span class="chart-y-tick" style="top:50%;transform:translateY(-50%);">' + formatY(yMid, yUnit) + '</span>'
      + '  <span class="chart-y-tick" style="bottom:0;">'              + formatY(yMin, yUnit) + '</span>'
      + '</div>';

    // X-axis labels — start time at left, end time at right.
    var crossesDay = new Date(tMin).toDateString() !== new Date(tMax).toDateString();
    var xLabels = ''
      + '<div class="chart-x-labels">'
      + '  <span class="chart-x-tick">' + formatX(tMin, tMax - tMin, crossesDay) + '</span>'
      + '  <span class="chart-x-tick">' + formatX(tMax, tMax - tMin, crossesDay) + '</span>'
      + '</div>';

    return ''
      + '<div class="chart-wrap" style="height:' + totalHeight + 'px;padding:' + TOP_GUTTER + 'px ' + RIGHT_GUTTER + 'px ' + BOTTOM_GUTTER + 'px ' + LEFT_GUTTER + 'px;">'
      +   yLabels
      +   svgParts.join("")
      +   (maintLabels ? '<div class="chart-maint-labels">' + maintLabels + '</div>' : '')
      +   xLabels
      + '</div>'
      + (opts.legend ? stateLegend(prepared, edge, bands.length > 0, opts.legend) : '')
      // The Max chip sits under the colour key: the key says what the colours
      // mean, the chip is the control for the dashed lines.
      + (opts.maxToggle && anyMax
        ? '<div class="series-legend-bar"><div class="series-legend" data-legend="max">' + maxChipHTML(showMax, maxSwatch) + '</div></div>'
        : '');
  }

  // A series' `max` companion → time-ordered { ts (ms), v, rec } points. A
  // null / non-numeric v is KEPT (as v: null) because it is where the dashed
  // line breaks — a bucket with no successes, or one rolled up before the max
  // was kept.
  function maxPoints(s) {
    var pts = [];
    (s.max || []).forEach(function (p) {
      if (p == null || p.ts == null) return;
      var t = +new Date(p.ts);
      if (!isFinite(t)) return;
      var v = typeof p.v === "number" && isFinite(p.v) ? p.v : null;
      pts.push({ ts: t, v: v, rec: p.rec === true });
    });
    pts.sort(function (a, b) { return a.ts - b.ts; });
    return pts;
  }

  // Dashed bucket-max line(s) for one series: one polyline per unbroken run
  // of the same colour. Thinner (×0.75) and fainter (×0.6) than the series'
  // own stroke. A colour change (Up → Recovering on the response-time chart)
  // starts the next run AT the previous point, so the line stays joined.
  var MAX_DASH = "2 3";
  function maxLine(pts, s, x, y) {
    var color = s.color || "var(--md-primary)";
    var sw = ((s.width > 0 ? s.width : 1.6) * 0.75).toFixed(2).replace(/\.?0+$/, "");
    var op = Math.round(((s.opacity != null && s.opacity < 1 ? s.opacity : 1) * 0.6) * 100) / 100;
    var out = "";
    function strokeOf(p) { return pointColorFor({ ok: true, rec: p.rec }, color); }
    function emit(run) {
      if (run.length < 2) return;
      out += '<polyline class="max-line" points="' + run.map(function (p) { return x(p.ts).toFixed(1) + "," + y(p.v).toFixed(1); }).join(" ") +
        '" fill="none" stroke="' + strokeOf(run[run.length - 1]) + '" stroke-width="' + sw + '" stroke-opacity="' + op +
        '" stroke-dasharray="' + MAX_DASH + '" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>';
    }
    var run = [];
    pts.forEach(function (p) {
      if (p.v == null) { emit(run); run = []; return; }
      if (run.length && strokeOf(p) !== strokeOf(run[run.length - 1])) {
        var joint = run[run.length - 1];
        emit(run);
        // The joining segment takes the new run's colour.
        run = [{ ts: joint.ts, v: joint.v, rec: p.rec }];
      }
      run.push(p);
    });
    emit(run);
    return out;
  }

  // The Max chip — a `.chip` like the CPU chart's series chips, with a dashed
  // swatch. A switched-off chip keeps most of its ink and is struck through.
  // `color` = the swatch; omitted, the chip's own text colour (currentColor).
  function maxChipHTML(on, color) {
    return '<button type="button" class="chip series-chip max-chip" data-max-toggle="1"'
      + ' aria-pressed="' + (on ? "true" : "false") + '" aria-label="Bucket max lines"'
      + ' style="height:32px;padding:0 10px;gap:6px;font-size:13px;' + (on ? '' : 'opacity:.8;text-decoration:line-through;') + '">'
      + '<span aria-hidden="true" style="width:14px;height:0;flex:0 0 auto;border-top:2px dashed ' + (color || 'currentColor') + ';' + (on ? '' : 'opacity:.45;') + '"></span>'
      + 'Max</button>';
  }

  // One delegated click listener per host for the Max chip. The host keeps the
  // LATEST callback, so a re-render or a range change never stacks a second
  // handler; pass null to detach the behaviour without removing the listener.
  function wireMaxToggle(host, onToggle) {
    if (!host) return;
    host._polarisMaxToggle = onToggle || null;
    if (host.dataset.maxToggleWired === "1") return;
    host.dataset.maxToggleWired = "1";
    host.addEventListener("click", function (ev) {
      var chip = ev.target && ev.target.closest ? ev.target.closest("[data-max-toggle]") : null;
      if (!chip || typeof host._polarisMaxToggle !== "function") return;
      host._polarisMaxToggle();
    });
  }

  /** Is this history payload read from a rollup tier (hourly / daily buckets)? */
  function isRollup(resp) {
    return !!(resp && typeof resp.bucketSeconds === "number" && resp.bucketSeconds > 0);
  }

  // Maintenance bands as SVG rects plus their HTML labels (see the header note
  // on text in a stretched SVG), placed by percentage of the plot width.
  function maintenanceLayer(bands, x, plotHeight, viewWidth, pad) {
    var svg = "", labels = "";
    var plotW = viewWidth - 2 * pad;
    bands.forEach(function (b) {
      var x0 = x(b.from), x1 = x(b.to);
      if (x1 - x0 < 1) x1 = x0 + 1;   // a sliver window stays visible
      svg += '<rect class="maintenance-band" x="' + x0.toFixed(1) + '" y="0" width="' + (x1 - x0).toFixed(1) + '" height="' + plotHeight +
        '" fill="' + MAINT_FILL + '" stroke="' + MAINT_STROKE + '" stroke-width="1" stroke-dasharray="2,3" vector-effect="non-scaling-stroke"/>';
      var frac = (x1 - x0) / plotW;
      if (frac >= MAINT_LABEL_MIN_FRAC) {
        labels += '<span class="chart-maint-label" style="left:' + ((x0 / viewWidth) * 100).toFixed(2) + '%;max-width:' + (frac * 100).toFixed(2) + '%;">'
          + escapeAttr(b.name) + '</span>';
      }
    });
    return { svg: svg, labels: labels };
  }

  // ─── Stacked-area chart (parts of a whole, in bytes) ────────────────────
  // The phone half of the desktop Memory chart (`_renderMemoryChart` in
  // public/js/assets.js; polaris-ui-canon → canon-charts-widgets.md
  // § Stacked-area chart). The caller shapes each sample and decides which
  // bands are switched on; this only draws.
  //
  //   PolarisCharts.stackChart({
  //     samples: [{ ts, total, values: { processes, buffers, cache }, swap }],
  //     bands:   [{ key, color }],     // the SWITCHED-ON bands, bottom-up
  //     swapColor: "#9c6ade",          // omit to draw no swap line
  //     outages, maintenance, from, to, height, ariaLabel,
  //   })
  //
  // The axis ceiling is the WHOLE (the largest total in the window), drawn as
  // a dashed line, so the gap above the stack is the remainder and is never
  // painted. Bands stack over what is switched on only: a hidden band's bytes
  // move into the gap, which is why the caller says so in its legend. Runs
  // split at the probe's outage record — the same evidence the line charts
  // dive on (`outageMarkers`) — so a band never paints flat across a window
  // nothing was collected in; a one-sample run is dropped rather than drawn as
  // a 1px spike. Swap is not part of the whole and rides as its own line.
  function stackChart(opts) {
    opts = opts || {};
    var totalHeight = opts.height || 120;
    var viewWidth = opts.width || 600;
    var pad = opts.padding || 2;
    var bandDefs = opts.bands || [];
    var hasRange = opts.from != null && opts.to != null && isFinite(+opts.from) && isFinite(+opts.to);
    var edge = hasRange ? +opts.from : -Infinity;

    var rows = [];
    (opts.samples || []).forEach(function (s) {
      if (!s || s.ts == null) return;
      var t = +new Date(s.ts);
      var total = Number(s.total);
      if (!isFinite(t) || !(total > 0)) return;
      rows.push({ t: t, total: total, values: s.values || {}, swap: s.swap });
    });
    rows.sort(function (a, b) { return a.t - b.t; });
    var inWin = rows.filter(function (r) { return r.t >= edge; });

    var tMin = Infinity, tMax = -Infinity, yMax = 0;
    inWin.forEach(function (r) {
      if (r.t < tMin) tMin = r.t;
      if (r.t > tMax) tMax = r.t;
      if (r.total > yMax) yMax = r.total;
    });
    if (hasRange && rows.length && rows[0].t < edge) tMin = edge;
    var nowMs = Date.now();
    var mspans = hasRange
      ? maintenanceSpans(opts.maintenance, +opts.from, +opts.to, nowMs)
      : (inWin.length ? maintenanceSpans(opts.maintenance, tMin, tMax, nowMs) : []);
    mspans.forEach(function (b) {
      if (b.from < tMin) tMin = b.from;
      if (b.to > tMax) tMax = b.to;
    });
    if (!inWin.length && !mspans.length) {
      return '<div class="chart-wrap" style="height:' + totalHeight + 'px;"><div class="chart-empty">No data</div></div>';
    }
    if (!(yMax > 0)) yMax = 1;
    if (tMin === tMax) tMax = tMin + 1;

    var plotHeight = totalHeight - TOP_GUTTER - BOTTOM_GUTTER;
    function x(t) { return pad + (viewWidth - 2 * pad) * ((t - tMin) / (tMax - tMin)); }
    function y(v) { return plotHeight - pad - (plotHeight - 2 * pad) * (Math.max(0, v) / yMax); }
    function xy(px, py) { return px.toFixed(1) + "," + py.toFixed(1); }

    var cuts = outageMarkers(opts.outages, rows.map(function (r) { return r.t; })).map(function (m) { return m.t; });
    var runs = [], cur = [];
    rows.forEach(function (r, i) {
      if (i > 0) {
        var a = rows[i - 1].t;
        if (cuts.some(function (c) { return c > a && c < r.t; })) { runs.push(cur); cur = []; }
      }
      cur.push(r);
    });
    if (cur.length) runs.push(cur);

    var body = [];
    body.push('<line x1="0" x2="' + viewWidth + '" y1="' + (plotHeight / 2).toFixed(1) + '" y2="' + (plotHeight / 2).toFixed(1) + '" stroke="var(--md-outline-variant)" stroke-width="0.5" stroke-dasharray="2,2" opacity="0.5"/>');
    var maint = maintenanceLayer(mspans, x, plotHeight, viewWidth, pad);
    body.push(maint.svg);

    runs.forEach(function (run) {
      if (run.length < 2) return;
      var lower = run.map(function () { return 0; });
      bandDefs.forEach(function (b) {
        var upper = run.map(function (r, i) {
          var v = Number(r.values[b.key]);
          return Math.min(r.total, lower[i] + (isFinite(v) && v > 0 ? v : 0));
        });
        var top = run.map(function (r, i) { return xy(x(r.t), y(upper[i])); });
        var bottom = run.map(function (r, i) { return xy(x(r.t), y(lower[i])); }).reverse();
        body.push('<polygon class="stack-band" data-band="' + escapeAttr(b.key) + '" points="' + top.concat(bottom).join(" ") +
          '" fill="' + b.color + '" fill-opacity="0.85"/>');
        lower = upper;
      });
      body.push('<polyline class="stack-total" points="' + run.map(function (r) { return xy(x(r.t), y(r.total)); }).join(" ") +
        '" fill="none" stroke="var(--md-on-surface-variant)" stroke-width="1" stroke-dasharray="6,4" opacity="0.7" vector-effect="non-scaling-stroke"/>');
      if (opts.swapColor) {
        var sw = run.filter(function (r) { return r.swap != null && isFinite(Number(r.swap)); });
        if (sw.length >= 2) {
          body.push('<polyline class="stack-swap" points="' + sw.map(function (r) { return xy(x(r.t), y(Number(r.swap))); }).join(" ") +
            '" fill="none" stroke="' + opts.swapColor + '" stroke-width="1.5" stroke-dasharray="2,2" vector-effect="non-scaling-stroke"/>');
        }
      }
    });

    var aria = (opts.ariaLabel || "Chart") + (mspans.length ? " (includes maintenance — polling paused)" : "");
    var crossesDay = new Date(tMin).toDateString() !== new Date(tMax).toDateString();
    return ''
      + '<div class="chart-wrap" style="height:' + totalHeight + 'px;padding:' + TOP_GUTTER + 'px ' + RIGHT_GUTTER + 'px ' + BOTTOM_GUTTER + 'px ' + LEFT_GUTTER + 'px;">'
      + '  <div class="chart-y-labels">'
      + '    <span class="chart-y-tick" style="top:0;">' + formatBytesAxis(yMax) + '</span>'
      + '    <span class="chart-y-tick" style="top:50%;transform:translateY(-50%);">' + formatBytesAxis(yMax / 2) + '</span>'
      + '    <span class="chart-y-tick" style="bottom:0;">0</span>'
      + '  </div>'
      + '<svg class="chart-svg" viewBox="0 0 ' + viewWidth + ' ' + plotHeight + '" preserveAspectRatio="none" role="img" aria-label="' + escapeAttr(aria) + '">'
      + body.join("")
      + '</svg>'
      + (maint.labels ? '<div class="chart-maint-labels">' + maint.labels + '</div>' : '')
      + '  <div class="chart-x-labels">'
      + '    <span class="chart-x-tick">' + formatX(tMin, tMax - tMin, crossesDay) + '</span>'
      + '    <span class="chart-x-tick">' + formatX(tMax, tMax - tMin, crossesDay) + '</span>'
      + '  </div>'
      + '</div>';
  }

  // Binary units, the way the OS reports memory: 16 GB is 16 × 1024³.
  // The compact AXIS form — whole values drop their ".0" ("16 GB", where
  // api.js formatBytes says "16.0 GB") and zero is the bare axis floor "0".
  // Named apart from api.js formatBytes (which mobile.html also loads) so
  // the one name never means two outputs (CQ-F018).
  function formatBytesAxis(n) {
    n = Number(n);
    if (!isFinite(n) || n <= 0) return "0";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (n >= 100 || i === 0 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, "")) + " " + units[i];
  }

  // The key under a chart that opts in with `legend: { series: "Up" }` — one
  // entry per colour the chart actually DREW, in the Status pill's order, with
  // the same names as the desktop key and the alert email's (legendSvg in
  // src/utils/sparklineSvg.ts). A chart that drew only its series gets no key:
  // the card's title already names it.
  function stateLegend(prepared, edge, hasMaint, legendOpts) {
    var drawn = {};
    var downColor = null;
    prepared.forEach(function (e) {
      e.pts.forEach(function (p) {
        if (p.ts < edge) return;
        if (p.ok) { drawn[p.rec ? "rec" : "up"] = e.s.color || "var(--md-primary)"; return; }
        var k = p.dep ? "dep" : p.down === false ? "missed" : "down";
        drawn[k] = true;
        if (k === "down" && p.downColor) downColor = p.downColor;
      });
    });
    var entries = [];
    if (drawn.up) entries.push({ label: legendOpts.series || "Series", color: drawn.up });
    if (drawn.missed) entries.push({ label: "Missed poll", color: MISS_COLOR });
    if (drawn.down) entries.push({ label: "Down", color: downColor || FAIL_COLOR });
    if (drawn.rec) entries.push({ label: "Recovering", color: RECOVER_COLOR });
    if (drawn.dep) entries.push({ label: "Parent down", color: DEP_COLOR });
    if (hasMaint) entries.push({ label: "Maintenance", color: MAINT_FILL, border: MAINT_STROKE, band: true });
    if (entries.length < 2 && drawn.up) return "";
    return '<div class="chart-state-legend" style="display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--md-on-surface-variant);margin-top:4px;">'
      + entries.map(function (e) {
        var swatch = e.band
          ? '<span style="width:12px;height:9px;flex:0 0 auto;background:' + e.color + ';border:1px dashed ' + e.border + ';"></span>'
          : '<span style="width:14px;height:0;flex:0 0 auto;border-top:2px solid ' + e.color + ';"></span>';
        return '<span style="display:inline-flex;align-items:center;gap:5px;">' + swatch + escapeAttr(e.label) + '</span>';
      }).join("")
      + '</div>';
  }

  function formatY(v, unit) {
    if (v == null) return "";
    var n = Number(v);
    if (!isFinite(n)) return "";
    var fmt;
    if (Math.abs(n) >= 1000) fmt = Math.round(n).toString();
    else if (Math.abs(n) >= 100) fmt = n.toFixed(0);
    else if (Math.abs(n) >= 10)  fmt = n.toFixed(1);
    else                         fmt = n.toFixed(2);
    return fmt + (unit ? " " + unit : "");
  }

  // Picks an appropriate label format based on the total window duration:
  // sub-day windows show HH:MM, sub-month show "MMM D", larger show "MMM YYYY".
  // A sub-day window that crosses midnight (every 24h window does) prefixes the
  // date — otherwise both ends of a 24h chart read the same "14:05".
  function formatX(ts, spanMs, crossesDay) {
    if (ts == null || !isFinite(ts)) return "";
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    if (spanMs < 36 * 3600 * 1000) {
      if (crossesDay) {
        return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      }
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    if (spanMs < 31 * 86400 * 1000) {
      return d.toLocaleDateString([], { month: "short", day: "numeric" });
    }
    return d.toLocaleDateString([], { month: "short", year: "numeric" });
  }

  window.PolarisCharts = {
    lineChart: lineChart,
    stackChart: stackChart,
    formatBytesAxis: formatBytesAxis,
    maxChipHTML: maxChipHTML,
    wireMaxToggle: wireMaxToggle,
    isRollup: isRollup,
    MAX_DASH: MAX_DASH,
    // exported for unit tests
    _outageMarkers: outageMarkers,
    _medianCadenceMs: medianCadenceMs,
    _seriesPoints: seriesPoints,
    _applySharedOutageMarkers: applySharedOutageMarkers,
    _maintenanceSpans: maintenanceSpans,
  };
})();
