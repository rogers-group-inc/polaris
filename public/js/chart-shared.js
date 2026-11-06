// public/js/chart-shared.js
//
// The pure chart helpers the desktop asset charts (public/js/assets.js, plus
// assets-compare.js through assets.js's wrappers) and the phone's charts
// (public/js/mobile/charts.js, mobile/telemetry-charts.js,
// mobile/asset-detail.js) both need. The phone does not load assets.js, so
// each of these used to live twice as a "port of … keep the two in step"
// copy. One copy now, loaded by mobile.html and by every desktop page that
// loads assets.js, BEFORE either (tests/unit/assetSharedModules.test.ts
// guards the script order).
//
// Pure functions and constants only — no DOM, no SVG. The renderers stay
// with their surfaces.

(function () {
  // ─── The missed-poll / recovery vocabulary ────────────────────────────────
  // One outage and one recovery look the same on every surface: these four
  // hexes are also DEP_COLOR / MISS_COLOR / RECOVER_COLOR / FAIL_COLOR in
  // src/utils/sparklineSvg.ts (the alert email), which cannot load this file
  // — change them there too. assets.js documents what each one means.
  var FAIL_COLOR = "#d32f2f";     // a miss that IS the Down verdict (critical red)
  var DEP_COLOR = "#9aa0a6";      // a miss while the asset was dependency-suppressed
  var MISS_COLOR = "#ffc107";     // a miss short of the automation's count (rule 36)
  var RECOVER_COLOR = "#0288d1";  // answered while misses are still outstanding

  // The stroke/dot colour for one plot point. `ok:false` points carry
  // `dep:true` when the miss was explained and `downColor` (the covering
  // automation's SEVERITY colour) when it is known; `ok:true` points carry
  // `rec:true` while misses are still outstanding. Grey outranks the amber/red
  // split, and a point with no `down` flag stays red — every chart that never
  // resolved a threshold. Single decider so a dive can never come out half
  // grey and half red.
  function chartPointColor(p, seriesColor) {
    if (p && p.ok) return p.rec ? RECOVER_COLOR : seriesColor;
    if (p && p.dep) return DEP_COLOR;
    return p && p.down === false ? MISS_COLOR : ((p && p.downColor) || FAIL_COLOR);
  }

  // ─── Outage markers on the streams with no per-sample success flag ───────

  // Median sampling cadence of a time-ordered series, in ms. Needs >= 3
  // timestamps to have a meaningful middle. Sizes the hole test in
  // seriesReportedThrough below.
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

  // Did the series keep reporting through the outage [from, to]? Either piece
  // of evidence is enough:
  //   • a sample strictly INSIDE the window — the agent case, where the host
  //     pushed readings while the probe transport could not reach it;
  //   • NO HOLE around the window — the last sample at or before `from` and
  //     the first at or after `to` sit no further apart than 1.5x the series'
  //     own cadence: a blip shorter than its interval, nothing missing.
  // The hole test is only a VETO: a hole never creates a marker. `to` on a
  // rollup tier is the next bucket's start, so the neighbour lookups are
  // inclusive and the interior test is strict. (The guard this replaced padded
  // the window and threw away most real outages; see git history.)
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

  // Missed-poll markers for telemetry / storage / interface counters. A failed
  // poll on those leaves no row at all (the heavy cadences do not RUN while an
  // asset is down), so the record lives in the response-time probe, served by
  // the chart endpoints as `outages` [{from, to, kind}] (built by
  // services/probeOutageService.ts). Maintenance yields no outage, because
  // polling stops entirely during it.
  //
  // One marker at each end of an outage so the line dives to the baseline and
  // climbs back out; a single-probe outage collapses to one marker. A
  // `kind: "dependency"` window marks `dep: true` (drawn grey, not red).
  // `sampleTimesMs` is the series' own good timestamps; a window the series
  // kept reporting through is dropped WHOLE (not just its edges — that would
  // zigzag through the interior readings).
  function outageMarkers(outages, sampleTimesMs) {
    if (!outages || !outages.length) return [];
    var times = (sampleTimesMs || []).slice().sort(function (a, b) { return a - b; });
    var cadenceMs = medianCadenceMs(times);
    var markers = [];
    outages.forEach(function (o) {
      var from = +new Date(o.from);
      var to   = +new Date(o.to);
      var dep  = o.kind === "dependency";
      if (!isFinite(from) || !isFinite(to)) return;
      if (seriesReportedThrough(times, cadenceMs, from, to)) return;
      markers.push({ t: from, dep: dep });
      if (to > from) markers.push({ t: to, dep: dep });
    });
    return markers.sort(function (a, b) { return a.t - b.t; });
  }

  // ─── Window + series shaping ──────────────────────────────────────────────

  // The points a chart's stated figures describe: those at or after the
  // visible window's left edge. History endpoints return lookback rows BEFORE
  // `since` only so the line enters from the edge; every stats line, total
  // and axis maximum must leave them out, or a figure counts a reading the
  // operator cannot see. `since` and the timestamps may be ISO strings or
  // epoch ms; `tsKey` names the timestamp field when it is not `timestamp`.
  // A missing or unparseable `since` keeps every row.
  function inChartWindow(points, since, tsKey) {
    var list = points || [];
    if (since == null) return list;
    var t0 = typeof since === "number" ? since : new Date(since).getTime();
    if (!isFinite(t0)) return list;
    var key = tsKey || "timestamp";
    return list.filter(function (p) {
      var v = p && p[key];
      var t = typeof v === "number" ? v : new Date(v).getTime();
      return !(t < t0);
    });
  }

  // Interface counter samples → per-interval rates
  // [{timestamp, inBps, outBps, inErr, outErr[, inMaxBps, outMaxBps]}].
  //
  // Rollup tier (`bucketSeconds > 0`): the server pre-computed
  // `*BytesPerSec` / `*ErrorsPerSec` per bucket — one point per row, bytes ×8
  // to bits, errors × bucketSeconds so each point is "errors in this bucket",
  // plus each bucket's PEAK rate for the dashed max line (null on a bucket
  // written before the column existed).
  //
  // Detail tier: cumulative counters differenced pairwise; a negative delta (a
  // counter wrap or a reboot) is dropped rather than drawn as a spike, and a
  // pair whose timestamps do not move forward — or do not parse — yields no
  // point (a NaN rate cannot be drawn).
  function derivePerIntervalSeries(samples, data) {
    samples = samples || [];
    if (data && typeof data.bucketSeconds === "number" && data.bucketSeconds > 0) {
      var bucketSec = data.bucketSeconds;
      return samples.map(function (s) {
        return {
          timestamp: s.timestamp,
          inBps:  typeof s.inBytesPerSec  === "number" ? s.inBytesPerSec  * 8 : null,
          outBps: typeof s.outBytesPerSec === "number" ? s.outBytesPerSec * 8 : null,
          inErr:  typeof s.inErrorsPerSec  === "number" ? Math.round(s.inErrorsPerSec  * bucketSec) : null,
          outErr: typeof s.outErrorsPerSec === "number" ? Math.round(s.outErrorsPerSec * bucketSec) : null,
          inMaxBps:  typeof s.maxInBytesPerSec  === "number" ? s.maxInBytesPerSec  * 8 : null,
          outMaxBps: typeof s.maxOutBytesPerSec === "number" ? s.maxOutBytesPerSec * 8 : null,
        };
      });
    }
    function delta(a, b) {
      if (typeof a !== "number" || typeof b !== "number") return null;
      return b - a < 0 ? null : b - a;
    }
    var out = [];
    for (var i = 1; i < samples.length; i++) {
      var prev = samples[i - 1], cur = samples[i];
      var dtSec = (new Date(cur.timestamp) - new Date(prev.timestamp)) / 1000;
      if (!(dtSec > 0)) continue;
      var inOct = delta(prev.inOctets, cur.inOctets);
      var outOct = delta(prev.outOctets, cur.outOctets);
      out.push({
        timestamp: cur.timestamp,
        inBps:  inOct  != null ? (inOct  * 8) / dtSec : null,
        outBps: outOct != null ? (outOct * 8) / dtSec : null,
        inErr:  delta(prev.inErrors,  cur.inErrors),
        outErr: delta(prev.outErrors, cur.outErrors),
      });
    }
    return out;
  }

  // ─── Memory bands ─────────────────────────────────────────────────────────
  // Two vocabularies (assets.js explains each band): the OS's (agent) and the
  // hypervisor's (vSphere). The primary band takes the same orange in both.
  // No band may be red (missed poll) or grey (dependency down).
  var MEM_BANDS_AGENT = [
    { key: "processes", label: "Processes", color: "#f4a261" },
    { key: "buffers",   label: "Buffers",   color: "#8ab17d" },
    { key: "cache",     label: "Cache",     color: "#2a9d8f" },
  ];
  var MEM_BANDS_VSPHERE = [
    { key: "consumed",   label: "Consumed",     color: "#f4a261" },
    { key: "private",    label: "Private",      color: "#f4a261" },
    { key: "shared",     label: "Shared",       color: "#2a9d8f" },
    { key: "ballooned",  label: "Ballooned",    color: "#e9c46a" },
    { key: "swapped",    label: "Host-swapped", color: "#9c6ade" },
    { key: "compressed", label: "Compressed",   color: "#4d96d9" },
  ];
  // A TrueNAS host / a Proxmox node fill the agent's columns in the platform's
  // own words. Same keys and colours, so a chip toggled on one host stays
  // toggled on the next.
  function relabelAgent(map) {
    return MEM_BANDS_AGENT.map(function (b) { return { key: b.key, label: map[b.key] || b.label, color: b.color }; });
  }
  var MEM_BANDS_TRUENAS = relabelAgent({ processes: "Services", cache: "ZFS Cache" });
  var MEM_BANDS_PROXMOX = relabelAgent({ processes: "Used", cache: "ZFS ARC" });
  var MEM_SWAP_COLOR = "#9c6ade";

  function memAgentBandsFor(asset) {
    var v = asset && asset.virtualization;
    if (v && v.platform === "proxmox" && v.role === "host") return MEM_BANDS_PROXMOX;
    return v && v.platform === "truenas" && v.role === "host" ? MEM_BANDS_TRUENAS : MEM_BANDS_AGENT;
  }

  // A reported reading: a finite number. The history endpoints serialise the
  // BigInt byte columns to numbers, so anything else (a string, NaN) is "not
  // reported", never coerced.
  function numOrNull(v) {
    return typeof v === "number" && isFinite(v) ? v : null;
  }

  // One sample → { kind, table, values, total, free, inUse, swapUsed,
  // swapTotal }, or null when it carries no total (a percentage-only source,
  // FortiOS) or, outside vSphere, no used figure. `values` holds null for a
  // band the source did not report, distinct from 0 for one it reported
  // empty — the renderer drops a band no row reported at all, which is what
  // collapses a bytes-only source (SNMP / WinRM) to the one band it can draw.
  function memBandsFor(s) {
    var total = numOrNull(s.memTotalBytes);
    if (total == null) return null;
    var vs = {
      consumed:   numOrNull(s.memConsumedBytes),
      private:    numOrNull(s.memPrivateBytes),
      shared:     numOrNull(s.memSharedBytes),
      ballooned:  numOrNull(s.memBalloonedBytes),
      swapped:    numOrNull(s.memSwappedBytes),
      compressed: numOrNull(s.memCompressedBytes),
    };
    var isVsphere = Object.keys(vs).some(function (k) { return vs[k] != null; });
    var values, table;
    if (isVsphere) {
      values = vs;
      table = MEM_BANDS_VSPHERE;
    } else {
      var used = numOrNull(s.memUsedBytes);
      if (used == null) return null;
      values = { processes: used, buffers: numOrNull(s.memBuffersBytes), cache: numOrNull(s.memCachedBytes) };
      table = MEM_BANDS_AGENT;
    }
    var sum = 0;
    table.forEach(function (b) { sum += values[b.key] || 0; });
    return {
      kind:      isVsphere ? "vsphere" : "agent",
      table:     table,
      values:    values,
      total:     total,
      free:      Math.max(0, total - sum),
      inUse:     Math.min(total, sum),
      swapUsed:  numOrNull(s.swapUsedBytes),
      swapTotal: numOrNull(s.swapTotalBytes),
    };
  }

  window.PolarisChartShared = {
    FAIL_COLOR: FAIL_COLOR,
    DEP_COLOR: DEP_COLOR,
    MISS_COLOR: MISS_COLOR,
    RECOVER_COLOR: RECOVER_COLOR,
    chartPointColor: chartPointColor,
    medianCadenceMs: medianCadenceMs,
    seriesReportedThrough: seriesReportedThrough,
    outageMarkers: outageMarkers,
    inChartWindow: inChartWindow,
    derivePerIntervalSeries: derivePerIntervalSeries,
    MEM_BANDS_AGENT: MEM_BANDS_AGENT,
    MEM_BANDS_VSPHERE: MEM_BANDS_VSPHERE,
    MEM_BANDS_TRUENAS: MEM_BANDS_TRUENAS,
    MEM_BANDS_PROXMOX: MEM_BANDS_PROXMOX,
    MEM_SWAP_COLOR: MEM_SWAP_COLOR,
    memAgentBandsFor: memAgentBandsFor,
    numOrNull: numOrNull,
    memBandsFor: memBandsFor,
  };
})();
