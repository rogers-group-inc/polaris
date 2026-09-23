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
      .replace(/"/g, "&quot;");
  }

  // Failed-poll color — the same hue the desktop charts use
  // (`_CHART_FAIL_COLOR` in public/js/assets.js), so a missed poll reads
  // identically on both surfaces.
  var FAIL_COLOR = "#d32f2f";
  // Dependency-down grey: the poll missed because the asset's PARENT was dark,
  // so the dive is drawn without the alarm — the device itself isn't accused of
  // anything. Same value as _CHART_DEP_COLOR (desktop) and DEP_COLOR
  // (utils/sparklineSvg.ts, the alert email); one outage looks the same on all
  // three surfaces.
  var DEP_COLOR = "#9aa0a6";
  // The missed-poll amber and the recovering purple — the other two thirds of
  // the response-time chart's verdict vocabulary. A miss that has NOT reached
  // the covering automation's count is amber, because red asserts Down and
  // spending it on the first dropped packet of a three-miss threshold dates the
  // outage two polls early; a poll that ANSWERED while misses are still
  // outstanding is purple, and stays purple until the automation's reset run is
  // served (business rule 36). Same values as _CHART_MISS_COLOR /
  // _CHART_RECOVER_COLOR on desktop, the Last-30-min strip's own cells, and
  // MISS_COLOR / RECOVER_COLOR in utils/sparklineSvg.ts — one outage and one
  // recovery look the same on all three surfaces; change one, change all.
  var MISS_COLOR = "#ffc107";
  var RECOVER_COLOR = "#0288d1";

  // The stroke/dot colour for one plot point. Port of `_chartPointColor` in
  // public/js/assets.js — keep the two in step. Grey outranks the amber/red
  // split (a miss the upstream explains is not counted against this device at
  // all), and a point with no `down` flag stays red, which is every chart that
  // never resolved a threshold.
  // `p.downColor` is the covering automation's SEVERITY colour for a `down`
  // probe (business rule 36) — Down is not inherently red, red is what
  // `critical` looks like. Absent ⇒ FAIL_COLOR, which is both the critical
  // colour and the right answer for a miss no automation was resolved for.
  function pointColorFor(p, seriesColor) {
    if (p && p.ok) return p.rec ? RECOVER_COLOR : seriesColor;
    if (p && p.dep) return DEP_COLOR;
    return p && p.down === false ? MISS_COLOR : ((p && p.downColor) || FAIL_COLOR);
  }
  function failColorFor(p) { return pointColorFor(p, null); }

  // Gradient ids must be unique per rendered chart — several charts share the
  // asset sheet's DOM (response time, CPU/memory, three SD-WAN charts).
  var _chartSeq = 0;

  // Median sampling cadence of a time-ordered series (ms); sizes the hole test
  // in seriesReportedThrough below. Port of `_medianCadenceMs` in
  // public/js/assets.js — keep the two in step.
  function medianCadenceMs(timestampsMs) {
    if (!timestampsMs || timestampsMs.length < 3) return 0;
    var dts = [];
    for (var i = 1; i < timestampsMs.length; i++) {
      var dt = timestampsMs[i] - timestampsMs[i - 1];
      if (dt > 0) dts.push(dt);
    }
    if (!dts.length) return 0;
    dts.sort(function (a, b) { return a - b; });
    return dts[Math.floor(dts.length / 2)];
  }

  // Missed-poll markers for the streams with no per-sample success flag, read
  // from the response-time probe's own failure record rather than guessed at
  // from the shape of the hole: the heavy cadences do not RUN while an asset is
  // down, so a skipped poll leaves nothing behind, and the probe — which keeps
  // running in every state — is what knows the device was unreachable.
  //
  // One marker at each end of an outage so the line dives to the baseline and
  // climbs back out; a single-probe outage collapses to one marker.
  //
  // A marker landing on top of a real sample is dropped: the Polaris Agent
  // pushes on its own schedule and is not gated on monitorStatus, so an agent
  // host can keep reporting CPU straight through an outage of the server-side
  // probe transport. Port of `_outageMarkers` in public/js/assets.js — keep the
  // two in step.
  function outageMarkers(outages, sampleTimesMs) {
    if (!outages || !outages.length) return [];
    var times = (sampleTimesMs || []).slice().sort(function (a, b) { return a - b; });
    var cadenceMs = medianCadenceMs(times);
    var markers = [];
    outages.forEach(function (o) {
      var from = +new Date(o.from);
      var to   = +new Date(o.to);
      var dep = o.kind === "dependency";
      if (!isFinite(from) || !isFinite(to)) return;
      // Skip the WHOLE window when the series kept reporting through it, not
      // merely its edges — see _outageMarkers in public/js/assets.js.
      if (seriesReportedThrough(times, cadenceMs, from, to)) return;
      markers.push({ t: from, dep: dep });
      if (to > from) markers.push({ t: to, dep: dep });
    });
    return markers.sort(function (a, b) { return a.t - b.t; });
  }

  // A sample strictly inside the window, or no hole around it (the neighbours
  // at-or-before `from` and at-or-after `to` within 1.5x cadence). Port of
  // `_seriesReportedThrough` in public/js/assets.js, which carries the reasoning
  // — keep the two in step.
  function seriesReportedThrough(times, cadenceMs, from, to) {
    var prev = null, next = null;
    for (var i = 0; i < times.length; i++) {
      var t = times[i];
      if (t > from && t < to) return true;
      if (t <= from) prev = t;
      if (t >= to && next === null) next = t;
    }
    if (!(cadenceMs > 0) || prev === null || next === null) return false;
    return next - prev <= cadenceMs * 1.5;
  }

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
  function failureAwareSegments(pts, seriesColor, idPrefix) {
    var defs = "";
    var out = "";
    // Colour, not ok-ness, is what breaks a run: a red outage that runs into a
    // grey dependency stretch (the parent went down part-way through) has to
    // split, or the whole thing takes the first point's stroke.
    function strokeFor(p) { return pointColorFor(p, seriesColor); }
    function polyline(slice, p0) {
      if (slice.length < 2) return "";
      return '<polyline points="' + slice.map(function (p) { return p.x.toFixed(1) + "," + p.y.toFixed(1); }).join(" ") +
        '" fill="none" stroke="' + strokeFor(p0) + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
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

  function lineChart(opts) {
    opts = opts || {};
    var series = opts.series || [];
    var totalHeight = opts.height || 80;
    var viewWidth   = opts.width  || 600;     // viewBox width — scales to 100% in CSS
    var pad = opts.padding || 2;              // breathing room inside the plot
    var yUnit = opts.yUnit || "";

    // Normalize every series up front so the range/axis passes and the render
    // pass agree on exactly which points exist (gap markers included).
    var prepared = series.map(function (s) { return { s: s, pts: seriesPoints(s) }; });
    applySharedOutageMarkers(prepared, opts.outages);

    // Figure out the y-axis range across all visible points. Failed polls carry
    // no value — they plot at the baseline — so they never widen the range.
    var yMin = (opts.yMin != null) ? opts.yMin : Infinity;
    var yMax = (opts.yMax != null) ? opts.yMax : -Infinity;
    var anyValues = false, anyPoints = false;
    prepared.forEach(function (e) {
      e.pts.forEach(function (p) {
        anyPoints = true;
        if (p.v == null) return;
        anyValues = true;
        if (opts.yMin == null && p.v < yMin) yMin = p.v;
        if (opts.yMax == null && p.v > yMax) yMax = p.v;
      });
    });
    if (!anyPoints) {
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

    // Time axis from the union of all series.
    var tMin = Infinity, tMax = -Infinity;
    prepared.forEach(function (e) {
      e.pts.forEach(function (p) {
        if (p.ts < tMin) tMin = p.ts;
        if (p.ts > tMax) tMax = p.ts;
      });
    });
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

      var seg = failureAwareSegments(plot, color, idPrefix + "-s" + si);
      defs += seg.defs;
      body.push(seg.segments);
      body.push(failureDots(plot));
    });

    var svgParts = [];
    svgParts.push('<svg class="chart-svg" viewBox="0 0 ' + viewWidth + ' ' + plotHeight + '" preserveAspectRatio="none" role="img" aria-label="' + escapeAttr(opts.ariaLabel || "Chart") + '">');
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
    var xLabels = ''
      + '<div class="chart-x-labels">'
      + '  <span class="chart-x-tick">' + formatX(tMin, tMax - tMin) + '</span>'
      + '  <span class="chart-x-tick">' + formatX(tMax, tMax - tMin) + '</span>'
      + '</div>';

    return ''
      + '<div class="chart-wrap" style="height:' + totalHeight + 'px;padding:' + TOP_GUTTER + 'px ' + RIGHT_GUTTER + 'px ' + BOTTOM_GUTTER + 'px ' + LEFT_GUTTER + 'px;">'
      +   yLabels
      +   svgParts.join("")
      +   xLabels
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
  function formatX(ts, spanMs) {
    if (ts == null || !isFinite(ts)) return "";
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    if (spanMs < 36 * 3600 * 1000) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    if (spanMs < 31 * 86400 * 1000) {
      return d.toLocaleDateString([], { month: "short", day: "numeric" });
    }
    return d.toLocaleDateString([], { month: "short", year: "numeric" });
  }

  window.PolarisCharts = {
    lineChart: lineChart,
    // exported for unit tests
    _outageMarkers: outageMarkers,
    _medianCadenceMs: medianCadenceMs,
    _seriesPoints: seriesPoints,
    _applySharedOutageMarkers: applySharedOutageMarkers,
  };
})();
