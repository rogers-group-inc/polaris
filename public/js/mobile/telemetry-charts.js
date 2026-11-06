// public/js/mobile/telemetry-charts.js — the asset sheet's split CPU + Memory.
//
// The phone half of the desktop's split System charts (`_renderCpuChart` and
// `_renderMemoryChart` in public/js/assets.js; polaris-ui-canon →
// canon-charts-widgets.md § Many-series chart and § Stacked-area chart). One
// section, one range control, two charts:
//
//   CPU     — the cross-core average on top (the line every threshold,
//             automation and metric reads, and the only failure-aware one),
//             one thin line per logical core under it.
//   Memory  — a stack in bytes (processes, buffers, cache — or the source's
//             own vocabulary) against the installed total, swap as its own
//             dashed line.
//
// Only a source that CAN report those shapes gets them (`splits`, the
// desktop's `_telemetrySplitsCpuMemory`): the resolved telemetry method is the
// agent or vCenter, or Unraid / TrueNAS / Proxmox on a HOST. Every other
// source keeps the combined CPU + memory % chart asset-detail.js draws, which
// is also what a split source falls back to before its method is known.
//
// Legend chips toggle a series on a tap; a long-press on a core shows only
// that core (the Avg line stays), and swallows the tap that ends it. Each
// legend is one sideways-scrolling row of chips that fades at an end with
// more past it (`.series-legend` in mobile.css), its scroll position kept
// across the re-render a toggle causes. Core visibility lives in the
// caller's per-asset state and is NOT persisted (core 5 of one host has
// nothing to do with core 5 of another); memory bands are named, so which of
// them a viewer wants is a standing preference and is persisted on the
// device. Cache ships off: reclaimable page cache drawn in the stack makes a
// healthy host look nearly full.
//
// No colour here may be red (missed poll) or grey (dependency down).

(function () {
  var SPLIT_METHODS = ["agent", "vcenter"];
  var SPLIT_HOST_METHODS = ["unraid", "truenas", "proxmox"];

  /** Does this asset's resolved telemetry method get the two charts? */
  function splits(method, asset) {
    if (SPLIT_METHODS.indexOf(method) >= 0) return true;
    return SPLIT_HOST_METHODS.indexOf(method) >= 0 &&
      !!(asset && asset.virtualization && asset.virtualization.role === "host");
  }

  // The desktop's arc (_cpuCoreColor): orange → violet, stopping short of
  // red, adjacent cores alternating lightness so a crowded arc stays legible.
  var CORE_HUE_START = 35;
  var CORE_HUE_END = 320;
  function coreColor(i, n) {
    if (!n || n < 2) return "hsl(205,68%,50%)";
    var h = Math.round(CORE_HUE_START + (i / n) * (CORE_HUE_END - CORE_HUE_START));
    return "hsl(" + h + ",68%," + (i % 2 === 0 ? 46 : 63) + "%)";
  }

  /**
   * Per-sample core vectors → one [{ts, v}] series per core, or null when no
   * sample in the window carries any (a rollup tier, or a source that never
   * reports cores). A core missing from a sample gets NO point, not a zero.
   */
  function coreSeries(samples) {
    var n = 0;
    (samples || []).forEach(function (s) {
      if (Array.isArray(s.cpuCorePcts) && s.cpuCorePcts.length > n) n = s.cpuCorePcts.length;
    });
    if (!n) return null;
    var out = [];
    for (var c = 0; c < n; c++) out.push([]);
    samples.forEach(function (s) {
      if (!Array.isArray(s.cpuCorePcts)) return;
      for (var c = 0; c < s.cpuCorePcts.length && c < n; c++) {
        var v = s.cpuCorePcts[c];
        if (typeof v === "number" && isFinite(v)) out[c].push({ ts: s.timestamp, v: v });
      }
    });
    return out;
  }

  /**
   * Rollup buckets' per-core MAX (`cpuCoreMaxPcts`, indexed like
   * `cpuCorePcts`) → one [{ts, v}] series per core for the first `n` cores.
   * A core with no max in a bucket gets v: null, which breaks its dashed line.
   * Null when no sample carries the field (detail tier, or an older server).
   */
  function coreMaxSeries(samples, n) {
    if (!n || !(samples || []).some(function (s) { return Array.isArray(s.cpuCoreMaxPcts); })) return null;
    var out = [];
    for (var c = 0; c < n; c++) out.push([]);
    samples.forEach(function (s) {
      var m = Array.isArray(s.cpuCoreMaxPcts) ? s.cpuCoreMaxPcts : [];
      for (var c = 0; c < n; c++) {
        var v = m[c];
        out[c].push({ ts: s.timestamp, v: typeof v === "number" && isFinite(v) ? v : null });
      }
    });
    return out;
  }

  // Band tables — the desktop's _MEM_BANDS_* (same keys, labels, colours), so
  // a chip means the same thing on both surfaces.
  var BANDS_AGENT = [
    { key: "processes", label: "Processes", color: "#f4a261" },
    { key: "buffers",   label: "Buffers",   color: "#8ab17d" },
    { key: "cache",     label: "Cache",     color: "#2a9d8f" },
  ];
  var BANDS_VSPHERE = [
    { key: "consumed",   label: "Consumed",     color: "#f4a261" },
    { key: "private",    label: "Private",      color: "#f4a261" },
    { key: "shared",     label: "Shared",       color: "#2a9d8f" },
    { key: "ballooned",  label: "Ballooned",    color: "#e9c46a" },
    { key: "swapped",    label: "Host-swapped", color: "#9c6ade" },
    { key: "compressed", label: "Compressed",   color: "#4d96d9" },
  ];
  function relabel(map) {
    return BANDS_AGENT.map(function (b) { return { key: b.key, label: map[b.key] || b.label, color: b.color }; });
  }
  var BANDS_TRUENAS = relabel({ processes: "Services", cache: "ZFS Cache" });
  var BANDS_PROXMOX = relabel({ processes: "Used", cache: "ZFS ARC" });
  var SWAP_COLOR = "#9c6ade";

  function agentBandsFor(asset) {
    var v = asset && asset.virtualization;
    if (v && v.platform === "proxmox" && v.role === "host") return BANDS_PROXMOX;
    return v && v.platform === "truenas" && v.role === "host" ? BANDS_TRUENAS : BANDS_AGENT;
  }

  function num(v) {
    if (v == null || v === "") return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  /**
   * One sample → { kind, values, total, inUse, swapUsed, swapTotal }, or null
   * when it carries no total (a percentage-only source). `values` holds null
   * for a band the source did not report, distinct from 0 for one it reported
   * empty. Port of `_memBandsFor` in public/js/assets.js.
   */
  function memBandsFor(s) {
    var total = num(s.memTotalBytes);
    if (total == null) return null;
    var vs = {
      consumed:   num(s.memConsumedBytes),
      private:    num(s.memPrivateBytes),
      shared:     num(s.memSharedBytes),
      ballooned:  num(s.memBalloonedBytes),
      swapped:    num(s.memSwappedBytes),
      compressed: num(s.memCompressedBytes),
    };
    var isVsphere = Object.keys(vs).some(function (k) { return vs[k] != null; });
    var values, table;
    if (isVsphere) {
      values = vs;
      table = BANDS_VSPHERE;
    } else {
      var used = num(s.memUsedBytes);
      if (used == null) return null;
      values = { processes: used, buffers: num(s.memBuffersBytes), cache: num(s.memCachedBytes) };
      table = BANDS_AGENT;
    }
    var sum = 0;
    table.forEach(function (b) { sum += values[b.key] || 0; });
    return {
      kind: isVsphere ? "vsphere" : "agent",
      values: values,
      total: total,
      inUse: Math.min(total, sum),
      swapUsed: num(s.swapUsedBytes),
      swapTotal: num(s.swapTotalBytes),
    };
  }

  // ─── Named-series visibility (persisted on this device) ────────────────
  var PREFS_KEY = "polaris-mobile-series-visibility";
  var OFF_BY_DEFAULT = ["cache"];
  function readPrefs() {
    try {
      var raw = localStorage.getItem(PREFS_KEY);
      var p = raw ? JSON.parse(raw) : null;
      return p && typeof p === "object" ? p : {};
    } catch (e) { return {}; }
  }
  /** An absent entry is "never touched" → the default; only a boolean overrides. */
  function bandVisible(key) {
    var v = readPrefs()[key];
    if (typeof v === "boolean") return v;
    return OFF_BY_DEFAULT.indexOf(key) === -1;
  }
  function setBandVisible(key, on) {
    var p = readPrefs();
    p[key] = !!on;
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) { /* private mode: this session only */ }
  }

  // ─── Rendering ──────────────────────────────────────────────────────────
  function esc(s) { return window.escapeHtml ? escapeHtml(s) : String(s == null ? "" : s); }

  // A switched-off chip keeps most of its ink: the strikethrough says "off",
  // and the chip is the only way back to its series.
  function chipHTML(group, key, label, color, on) {
    return '<button type="button" class="chip series-chip" data-group="' + group + '" data-series="' + esc(key) + '"'
      + ' aria-pressed="' + (on ? "true" : "false") + '"'
      + ' style="height:32px;padding:0 10px;gap:6px;font-size:13px;' + (on ? '' : 'opacity:.8;text-decoration:line-through;') + '">'
      + '<span aria-hidden="true" style="width:10px;height:10px;border-radius:2px;flex:0 0 auto;background:' + color + ';' + (on ? '' : 'opacity:.45;') + '"></span>'
      + esc(label) + '</button>';
  }

  function headHTML(title, meta) {
    return '<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px;">'
      + '<span class="ty-title-s">' + esc(title) + '</span>'
      + (meta ? '<span class="ty-body-s muted">' + esc(meta) + '</span>' : '')
      + '</div>';
  }

  function legendHTML(group, chips, trailing) {
    return '<div class="series-legend-bar">'
      + '<div class="series-legend" data-legend="' + group + '">' + chips + '</div>'
      + (trailing || '')
      + '</div>';
  }

  var FADE_PX = "28px";
  // Fade an end only while there is more past it, so the first chip of a
  // row at rest is not half-hidden.
  function updateFade(row) {
    var max = row.scrollWidth - row.clientWidth;
    row.style.setProperty("--fade-l", row.scrollLeft > 1 ? FADE_PX : "0px");
    row.style.setProperty("--fade-r", max > 1 && row.scrollLeft < max - 1 ? FADE_PX : "0px");
  }

  function noteHTML(text) {
    return text ? '<div class="ty-body-s muted" style="margin-top:8px;">' + esc(text) + '</div>' : '';
  }

  function cpuBlock(ctx) {
    var samples = (ctx.resp && ctx.resp.samples) || [];
    var hidden = ctx.hidden;
    var cores = coreSeries(samples);
    var n = cores ? cores.length : 0;
    var avg = samples
      .filter(function (s) { return s.cpuPct != null; })
      .map(function (s) { return { ts: s.timestamp, v: s.cpuPct }; });

    // A rollup tier carries each bucket's MAX beside its average: the dashed
    // companions (lineChart's `max`), for the average and for each DRAWN core.
    var resp = ctx.resp;
    var rollup = !!(resp && typeof resp.bucketSeconds === "number" && resp.bucketSeconds > 0);
    var avgMax = rollup
      ? samples.map(function (s) { return { ts: s.timestamp, v: typeof s.maxCpuPct === "number" ? s.maxCpuPct : null }; })
      : null;
    var coreMax = rollup ? coreMaxSeries(samples, n) : null;
    var maxOff = ctx.maxOff || {};
    var showMax = !maxOff.cpu;

    var shownCores = 0;
    for (var c = 0; c < n; c++) if (!hidden[String(c)]) shownCores++;
    var series = [];
    for (var ci = 0; ci < n; ci++) {
      if (hidden[String(ci)]) continue;
      series.push({ values: cores[ci], color: coreColor(ci, n), width: 1.1, opacity: shownCores > 1 ? 0.55 : 1, max: coreMax ? coreMax[ci] : null });
    }
    // Last, so it draws on top.
    if (!hidden.avg) series.push({ values: avg, color: "var(--md-primary)", gapFade: true, width: 2.2, max: avgMax });
    var hasMax = series.some(function (s) {
      return (s.max || []).some(function (p) { return p.v != null; });
    });

    var chart = PolarisCharts.lineChart({
      series: series,
      showMax: showMax,
      maintenance: ctx.maint,
      from: ctx.bounds && ctx.bounds.from,
      to: ctx.bounds && ctx.bounds.to,
      outages: ctx.resp && ctx.resp.outages,
      height: 140,
      yMin: 0, yMax: 100,
      yUnit: "%",
      ariaLabel: "CPU over " + ctx.range + (n ? ", average and " + shownCores + " of " + n + " cores" : ", average"),
    });

    var chips = chipHTML("cpu", "avg", "Avg", "var(--md-primary)", !hidden.avg);
    // Beside Avg, so it is in reach without scrolling past 64 cores.
    if (hasMax && PolarisCharts.maxChipHTML) chips += PolarisCharts.maxChipHTML(showMax);
    for (var k = 0; k < n; k++) chips += chipHTML("cpu", String(k), "Core " + k, coreColor(k, n), !hidden[String(k)]);
    // Outside the scrolling row, so it is in reach however many cores there are.
    var showAll = Object.keys(hidden).some(function (key) { return hidden[key]; })
      ? '<button type="button" class="btn btn-text" data-series-all="cpu" style="height:32px;padding:0 12px;flex:0 0 auto;">Show all</button>'
      : '';

    // Rollup buckets carry per-core averages (and maxes) since the max-line
    // change, so the note is only for rollup samples that still lack them —
    // buckets rolled up before then, or an older server. `n` is 0 exactly when
    // no sample carries `cpuCorePcts`. Said only for a split source (this one)
    // and only off the detail tier.
    var tier = ctx.resp && ctx.resp.tier;
    var note = !n && tier && tier !== "detail"
      ? "Per-core detail is not kept in " + tier + " buckets, so this is the cross-core average. Pick a shorter range to see each core."
      : "";

    var stats = (ctx.resp && ctx.resp.stats) || {};
    var bits = [];
    if (stats.avgCpuPct != null) bits.push("avg " + Math.round(stats.avgCpuPct) + "%");
    if (stats.maxCpuPct != null) bits.push("max " + Math.round(stats.maxCpuPct) + "%");
    var peak = null, peakCore = -1;
    for (var pc = 0; pc < n; pc++) {
      cores[pc].forEach(function (p) { if (peak == null || p.v > peak) { peak = p.v; peakCore = pc; } });
    }
    if (peakCore >= 0) bits.push("busiest Core " + peakCore + " at " + Math.round(peak) + "%");

    return headHTML("CPU", n ? n + (n === 1 ? " core" : " cores") : "")
      + '<div id="asset-cpu-chart">' + chart + '</div>'
      + legendHTML("cpu", chips, showAll)
      + noteHTML(note)
      + noteHTML(bits.join(" · "));
  }

  function memBlock(ctx) {
    var samples = (ctx.resp && ctx.resp.samples) || [];
    var shaped = [];
    samples.forEach(function (s) {
      var b = memBandsFor(s);
      if (b) shaped.push({ ts: s.timestamp, b: b });
    });

    // A percentage-only answer this time (a source that usually reports
    // bytes): one line on a 0–100% axis, and the legend says why.
    if (!shaped.length) {
      var pct = samples
        .filter(function (s) { return s.memPct != null; })
        .map(function (s) { return { ts: s.timestamp, v: s.memPct }; });
      return headHTML("Memory", "")
        + '<div id="asset-mem-chart">' + PolarisCharts.lineChart({
          series: [{ values: pct, color: "#f4a261", gapFade: true }],
          maintenance: ctx.maint,
          from: ctx.bounds && ctx.bounds.from,
          to: ctx.bounds && ctx.bounds.to,
          outages: ctx.resp && ctx.resp.outages,
          height: 140, yMin: 0, yMax: 100, yUnit: "%",
          ariaLabel: "Memory used over " + ctx.range,
        }) + '</div>'
        + noteHTML(pct.length ? "This source reports a percentage only, with no breakdown in bytes." : "");
    }

    var isVsphere = shaped.some(function (r) { return r.b.kind === "vsphere"; });
    var table = isVsphere ? BANDS_VSPHERE : agentBandsFor(ctx.asset);
    // A band no row in the window reported is dropped; one reported as 0 stays.
    var reported = table.filter(function (band) {
      return shaped.some(function (r) { return r.b.values[band.key] != null; });
    });
    var visible = reported.filter(function (band) { return bandVisible(band.key); });
    var hasSwap = shaped.some(function (r) { return r.b.swapUsed != null && r.b.swapTotal > 0; });
    var swapOn = hasSwap && bandVisible("swap");

    var chart = PolarisCharts.stackChart({
      samples: shaped.map(function (r) {
        return { ts: r.ts, total: r.b.total, values: r.b.values, swap: r.b.swapUsed };
      }),
      bands: visible,
      swapColor: swapOn ? SWAP_COLOR : null,
      maintenance: ctx.maint,
      from: ctx.bounds && ctx.bounds.from,
      to: ctx.bounds && ctx.bounds.to,
      outages: ctx.resp && ctx.resp.outages,
      height: 140,
      ariaLabel: "Memory over " + ctx.range + ", stacked by " + (visible.map(function (b) { return b.label.toLowerCase(); }).join(", ") || "nothing"),
    });

    var chips = reported.map(function (band) {
      return chipHTML("mem", band.key, band.label, band.color, bandVisible(band.key));
    }).join("");
    if (hasSwap) chips += chipHTML("mem", "swap", "Swap", SWAP_COLOR, swapOn);

    var notes = [];
    if (reported.length <= 1) {
      notes.push("This source reports a total only, with no " + (isVsphere ? "hypervisor" : "cache or buffer") + " breakdown.");
    } else if (isVsphere) {
      notes.push("As the hypervisor accounts for it, not the guest’s own view.");
    }
    // Hiding a band changes the picture, never the arithmetic: its bytes move
    // into the gap above the stack, which then is not simply "free".
    var hiddenBands = reported.filter(function (band) { return !bandVisible(band.key); });
    if (hiddenBands.length) {
      notes.push(hiddenBands.map(function (b) { return b.label; }).join(" + ") + " hidden: counted in the gap, not in the stack.");
    }

    var latest = shaped[shaped.length - 1].b.total;
    var sumIn = 0, peakIn = 0;
    shaped.forEach(function (r) { sumIn += r.b.inUse; if (r.b.inUse > peakIn) peakIn = r.b.inUse; });
    var avgIn = sumIn / shaped.length;
    var stats = "in use " + PolarisCharts.formatBytes(avgIn) + " of " + PolarisCharts.formatBytes(latest)
      + " (" + Math.round(avgIn / latest * 100) + "%) · peak " + PolarisCharts.formatBytes(peakIn);

    return headHTML("Memory", PolarisCharts.formatBytes(latest) + " installed")
      + '<div id="asset-mem-chart">' + chart + '</div>'
      + legendHTML("mem", chips, "")
      + notes.map(noteHTML).join("")
      + noteHTML(stats);
  }

  // A toggle rebuilds the legends; each row keeps where it was scrolled, so a
  // tap on a chip far along the row does not throw the row back to its start.
  function draw(host) {
    var ctx = host._telemetryCtx;
    if (!ctx) return;
    var scrolled = {};
    host.querySelectorAll(".series-legend[data-legend]").forEach(function (row) {
      scrolled[row.dataset.legend] = row.scrollLeft;
    });
    host.innerHTML = cpuBlock(ctx)
      + '<div style="height:1px;background:var(--md-outline-variant);margin:16px 0 14px;"></div>'
      + memBlock(ctx);
    host.querySelectorAll(".series-legend[data-legend]").forEach(function (row) {
      if (scrolled[row.dataset.legend]) row.scrollLeft = scrolled[row.dataset.legend];
      updateFade(row);
      row.addEventListener("scroll", function () { updateFade(row); }, { passive: true });
    });
  }

  var LONG_PRESS_MS = 500;
  // A finger that drifts this far is scrolling the row, not pressing a chip.
  var LONG_PRESS_SLOP_PX = 10;

  function isolate(ctx, key) {
    var n = (coreSeries((ctx.resp && ctx.resp.samples) || []) || []).length;
    Object.keys(ctx.hidden).forEach(function (k) { delete ctx.hidden[k]; });
    for (var c = 0; c < n; c++) if (String(c) !== key) ctx.hidden[String(c)] = true;
  }

  // One set of delegated listeners per host, attached once; they read
  // whatever context the latest render left on the host, so a range change
  // or refresh never stacks a second handler.
  function wire(host) {
    if (host.dataset.telemetryWired === "1") return;
    host.dataset.telemetryWired = "1";
    var press = null;      // { key, x, y, timer } while a finger is down on a core chip
    var swallowClick = false;

    function cancelPress() {
      if (press) { clearTimeout(press.timer); press = null; }
    }

    host.addEventListener("pointerdown", function (ev) {
      var chip = ev.target && ev.target.closest ? ev.target.closest('.series-chip[data-group="cpu"]') : null;
      cancelPress();
      // A press that ended off the chip delivered no click to swallow; a new
      // press starts clean either way.
      swallowClick = false;
      // "Only the average" is what hiding the cores is for — Avg has no isolate.
      if (!chip || chip.dataset.series === "avg") return;
      var key = chip.dataset.series;
      press = { key: key, x: ev.clientX || 0, y: ev.clientY || 0, timer: null };
      press.timer = setTimeout(function () {
        var ctx = host._telemetryCtx;
        press = null;
        if (!ctx) return;
        swallowClick = true; // the click that ends this press is not a toggle
        isolate(ctx, key);
        if (navigator.vibrate) { try { navigator.vibrate(10); } catch (e) { /* no haptics */ } }
        draw(host);
      }, LONG_PRESS_MS);
    });
    host.addEventListener("pointermove", function (ev) {
      if (!press) return;
      if (Math.abs((ev.clientX || 0) - press.x) > LONG_PRESS_SLOP_PX || Math.abs((ev.clientY || 0) - press.y) > LONG_PRESS_SLOP_PX) cancelPress();
    });
    host.addEventListener("pointerup", cancelPress);
    host.addEventListener("pointercancel", cancelPress);
    // A long-press would otherwise open the browser's own menu on the chip.
    host.addEventListener("contextmenu", function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest(".series-chip")) ev.preventDefault();
    });

    host.addEventListener("click", function (ev) {
      if (swallowClick) { swallowClick = false; return; }
      var t = ev.target && ev.target.closest ? ev.target : null;
      if (!t) return;
      var ctx = host._telemetryCtx;
      if (!ctx) return;
      // The Max chip: every dashed bucket-max line on the CPU chart at once.
      // Its own key on the caller's per-asset state, so Show all (which is
      // about cores) leaves it alone.
      if (t.closest("[data-max-toggle]")) {
        if (!ctx.maxOff) ctx.maxOff = {};
        ctx.maxOff.cpu = !ctx.maxOff.cpu;
        draw(host);
        return;
      }
      var all = t.closest("[data-series-all]");
      if (all) {
        Object.keys(ctx.hidden).forEach(function (k) { delete ctx.hidden[k]; });
        draw(host);
        return;
      }
      var chip = t.closest(".series-chip");
      if (!chip) return;
      var key = chip.dataset.series;
      if (chip.dataset.group === "mem") setBandVisible(key, !bandVisible(key));
      else if (ctx.hidden[key]) delete ctx.hidden[key];
      else ctx.hidden[key] = true;
      draw(host);
    });
  }

  /**
   * Draw both charts into `host`. ctx: { resp (telemetry-history payload),
   * maint, asset, range, bounds, hidden (the caller's per-asset core
   * visibility object — mutated by the legend), maxOff (the caller's
   * per-asset bucket-max choice, `{ cpu: true }` = hidden — mutated by the
   * Max chip) }.
   */
  function render(host, ctx) {
    if (!host) return;
    host._telemetryCtx = ctx;
    draw(host);
    wire(host);
  }

  window.PolarisTelemetryCharts = {
    splits: splits,
    render: render,
    // exported for unit tests
    _coreSeries: coreSeries,
    _coreMaxSeries: coreMaxSeries,
    _coreColor: coreColor,
    _memBandsFor: memBandsFor,
    _agentBandsFor: agentBandsFor,
    _bandVisible: bandVisible,
    PREFS_KEY: PREFS_KEY,
  };
})();
