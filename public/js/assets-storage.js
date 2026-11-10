/**
 * public/js/assets-storage.js — the storage mountpoint slide-over: per-volume history, the storage
 * view toggle and the storage forecast.
 *
 * Part of the Assets page script (CQ-F050): plain browser scripts sharing
 * page globals, loaded right after assets.js on every page that carries it
 * and in app-panels.js's asset bundle, in ASSETS_FILES order. Nothing here
 * runs at load beyond listener wiring. See tests/unit/assetsSplit.test.ts.
 */

// ─── Storage mountpoint slide-over ─────────────────────────────────────────
//
// Sits on top of the asset details panel like the interface and IPsec slide-
// overs. Shows used / total bytes over time and used % over time. SNMP only
// — the table renderer already gates the slide-in to mountpoints that came
// back in the last system-info pass, so we don't need to re-check here.

function _ensureStoragePanelDOM() {
  if (document.getElementById("storage-panel-overlay")) return;
  // Skeleton + backdrop / close / Escape / resize wiring: buildSlideover
  // (app.js). Stacks by DOM order like every slide-over — raiseSlideover on open.
  buildSlideover({
    id: "storage-panel",
    overlayClass: "slideover-nested",
    panelStyle: "z-index:1100",
    title: "Storage",
    bodyHTML: '<p class="empty-state" style="padding:1rem 1.25rem">Loading…</p>',
    footer: true,
    close: closeStoragePanel,
    resizeKey: "polaris.panel.width.storage",
  });
}

function closeStoragePanel() {
  var ov = document.getElementById("storage-panel-overlay");
  if (ov) ov.classList.remove("open");
}

// Opens the consolidated storage slide-in panel containing one section per
// mountpoint discovered on this asset. `focusMountPath` (optional) is the
// mount that triggered the open — its section gets scrolled into view and
// briefly highlighted. `storage` is the asset's current storage[] array
// (one row per mount) as already loaded by the System tab; we use it for
// the mount list and the latest-snapshot Used/Total/% so each section can
// paint a header before its history fetch lands.
async function openStorageDetailPanel(asset, focusMountPath, storage) {
  if (!asset) return;
  var mounts = Array.isArray(storage) ? storage.filter(function (s) { return s && s.mountPath; }) : [];
  if (mounts.length === 0 && focusMountPath) {
    // Legacy callers that only have the mountPath (no storage array) — synthesize
    // a one-entry list so the panel still works.
    mounts = [{ mountPath: focusMountPath }];
  }
  if (mounts.length === 0) return;
  _ensureStoragePanelDOM();
  var titleEl  = document.getElementById("storage-panel-title");
  var metaEl   = document.getElementById("storage-panel-meta");
  var bodyEl   = document.getElementById("storage-panel-body");
  var footerEl = document.getElementById("storage-panel-footer");
  titleEl.textContent = "Storage — " + (asset.hostname || asset.ipAddress || asset.id);
  metaEl.textContent = mounts.length + " mount" + (mounts.length === 1 ? "" : "s");
  bodyEl.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">Loading…</p>';
  footerEl.innerHTML =
    '<button class="btn btn-sm btn-secondary" id="btn-storage-panel-close-btn">Close</button>';
  raiseSlideover(document.getElementById("storage-panel-overlay"));
  requestAnimationFrame(function () {
    document.getElementById("storage-panel-overlay").classList.add("open");
  });
  document.getElementById("btn-storage-panel-close-btn").addEventListener("click", closeStoragePanel);

  var rangeBtns = _chartRangeBtnsHTML("storage-range-btn", [
    { value: "1h",  label: "1h" },
    { value: "12h", label: "12h" },
    { value: "24h", label: "24h" },
    { value: "7d",  label: "7d" },
    { value: "30d", label: "30d" },
    { value: "custom", label: "Custom…", id: "btn-storage-custom" },
  ], "assetStorage", "24h");
  var storageCustomPanel =
    '<div id="storage-custom-panel" style="display:none;align-items:center;gap:6px;margin:0.5rem 0;padding:0.5rem;background:var(--color-bg-primary);border:1px solid var(--color-border);border-radius:6px;font-size:0.85rem">' +
      '<label style="display:flex;align-items:center;gap:4px">From <input type="datetime-local" id="storage-custom-from" class="form-input" style="padding:2px 6px"></label>' +
      '<label style="display:flex;align-items:center;gap:4px">To <input type="datetime-local" id="storage-custom-to" class="form-input" style="padding:2px 6px"></label>' +
      '<button class="btn btn-sm btn-primary" id="btn-storage-custom-apply">Apply</button>' +
    '</div>';

  // Build per-mount section markup up front so the layout settles before the
  // (parallel) history fetches resolve. Each section carries data-mount so
  // re-renders and scroll-to-focus can target it by mount path.
  var sectionsHtml = mounts.map(function (m, i) {
    var safeMount = escapeHtml(m.mountPath);
    var latestPct = (m.totalBytes && m.usedBytes != null && m.totalBytes > 0)
      ? ((m.usedBytes / m.totalBytes) * 100).toFixed(1) + "%"
      : "—";
    var latestUsed  = (m.usedBytes  != null) ? _fmtBytes(m.usedBytes)  : "—";
    var latestTotal = (m.totalBytes != null) ? _fmtBytes(m.totalBytes) : "—";
    return (
      '<section class="storage-mount-section" data-mount="' + safeMount + '" data-mount-idx="' + i + '"' +
        ' style="border-top:1px solid var(--color-border);padding-top:1rem;margin-top:1rem;transition:background-color 1.2s ease">' +
        '<div style="display:flex;align-items:flex-end;justify-content:space-between;gap:0.75rem;flex-wrap:wrap;margin-bottom:0.5rem">' +
          '<div>' +
            '<h5 class="mono" style="margin:0;font-size:0.95rem">' + safeMount + '</h5>' +
            '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-top:2px">' +
              'Latest: <strong>' + latestUsed + '</strong> / ' + latestTotal + ' (' + latestPct + ')' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;gap:6px" data-storage-forecast-toggle></div>' +
        '</div>' +
        '<div data-storage-forecast-headline style="margin:0.25rem 0 0.5rem;font-size:0.85rem"></div>' +
        '<div data-storage-stats style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">Loading…</div>' +
        '<div data-storage-chart class="storage-chart-box"></div>' +
      '</section>'
    );
  }).join("");

  bodyEl.innerHTML =
    '<div style="padding:1rem 1.25rem">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;gap:0.75rem;flex-wrap:wrap">' +
        '<h4 style="margin:0">Usage history</h4>' +
        '<div style="display:flex;gap:6px">' + rangeBtns + '</div>' +
      '</div>' +
      storageCustomPanel +
      '<div style="display:flex;align-items:center;gap:0.75rem;margin:0.5rem 0 0.25rem;flex-wrap:wrap">' +
        '<div style="display:flex;gap:6px" id="storage-view-toggle"></div>' +
        '<span style="font-size:0.78rem;color:var(--color-text-secondary)">Applies to every mount below.</span>' +
      '</div>' +
      sectionsHtml +
    '</div>';
  document.querySelectorAll(".storage-chart-box").forEach(function (el) {
    el.classList.add("chart-box");
    el.style.minHeight = "180px";
    el.style.display = "flex";
    el.style.alignItems = "center";
    el.style.justifyContent = "center";
    el.style.color = "var(--color-text-secondary)";
    el.style.fontSize = "0.85rem";
  });
  _renderStorageViewToggle();
  mounts.forEach(function (m) { _renderStorageForecastToggleFor(asset.id, m.mountPath); });

  await _loadAllStorageForAsset(asset.id, mounts.map(function (m) { return m.mountPath; }), _getChartRangePref("assetStorage", "24h"));
  if (focusMountPath) _scrollStorageSectionIntoView(focusMountPath);

  document.querySelectorAll(".storage-range-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      var range = b.getAttribute("data-range");
      var panel = document.getElementById("storage-custom-panel");
      if (range === "custom") {
        if (!panel) return;
        var willOpen = panel.style.display === "none";
        panel.style.display = willOpen ? "flex" : "none";
        if (willOpen) {
          var toInput   = document.getElementById("storage-custom-to");
          var fromInput = document.getElementById("storage-custom-from");
          if (toInput && !toInput.value) toInput.value = _toLocalDatetimeInput(new Date());
          if (fromInput && !fromInput.value) fromInput.value = _toLocalDatetimeInput(new Date(Date.now() - 24 * 3600 * 1000));
        }
        return;
      }
      if (panel) panel.style.display = "none";
      document.querySelectorAll(".storage-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      b.classList.remove("btn-secondary"); b.classList.add("btn-primary");
      _setChartRangePref("assetStorage", range);
      _loadAllStorageForAsset(asset.id, mounts.map(function (m) { return m.mountPath; }), range);
    });
  });
  var storageCustomApply = document.getElementById("btn-storage-custom-apply");
  if (storageCustomApply) {
    storageCustomApply.addEventListener("click", function () {
      var fromInput = document.getElementById("storage-custom-from");
      var toInput   = document.getElementById("storage-custom-to");
      if (!fromInput.value || !toInput.value) { showToast("Enter both From and To", "error"); return; }
      var fromIso = new Date(fromInput.value).toISOString();
      var toIso   = new Date(toInput.value).toISOString();
      if (new Date(fromIso) >= new Date(toIso)) { showToast("From must be before To", "error"); return; }
      document.querySelectorAll(".storage-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      var customBtn = document.getElementById("btn-storage-custom");
      if (customBtn) { customBtn.classList.remove("btn-secondary"); customBtn.classList.add("btn-primary"); }
      _loadAllStorageForAsset(asset.id, mounts.map(function (m) { return m.mountPath; }), { from: fromIso, to: toIso });
    });
  }
  // Drag-select on any mount's chart applies the custom range to all mounts
  // (the range bar is shared across the panel).
  document.querySelectorAll("#storage-panel-body [data-storage-chart]").forEach(function (chartEl) {
    _wireChartDragSelect(chartEl, function (fromIso, toIso) {
      _applyCustomRangeSelection({
        btnClass: "storage-range-btn", customBtnId: "btn-storage-custom",
        panelId: "storage-custom-panel", fromId: "storage-custom-from", toId: "storage-custom-to",
      }, fromIso, toIso);
      _loadAllStorageForAsset(asset.id, mounts.map(function (m) { return m.mountPath; }), { from: fromIso, to: toIso });
    });
  });
}

// Storage stats bars are per-mount (no fixed element id) — resolve the one in
// the chart's own .storage-mount-section at click time.
function _storageStatsSummaryFor(container) {
  return function () {
    var section = container.closest ? container.closest(".storage-mount-section") : null;
    var el = section && section.querySelector("[data-storage-stats]");
    return (el && el.dataset.summary) || "";
  };
}

function _findStorageSection(mountPath) {
  if (!mountPath) return null;
  // Use attribute selector with CSS.escape so unusual mount paths like
  // "C:" / "/var/log" don't break the selector. CSS.escape is available
  // in every browser Polaris supports.
  try {
    return document.querySelector('.storage-mount-section[data-mount="' + CSS.escape(mountPath) + '"]');
  } catch (_) {
    var sections = document.querySelectorAll(".storage-mount-section");
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].getAttribute("data-mount") === mountPath) return sections[i];
    }
    return null;
  }
}

function _scrollStorageSectionIntoView(mountPath) {
  var section = _findStorageSection(mountPath);
  if (!section) return;
  // Defer a tick so the just-rendered charts have their final layout before
  // we measure scroll position.
  setTimeout(function () {
    section.scrollIntoView({ behavior: "smooth", block: "start" });
    // Brief highlight to make the target obvious — fades via the
    // 1.2s background-color transition declared in the section style.
    section.style.backgroundColor = "var(--color-accent-soft, rgba(79,195,247,0.15))";
    setTimeout(function () { section.style.backgroundColor = "transparent"; }, 900);
  }, 30);
}

// Module-level cache of the most recent storage panel state so toggle clicks
// (view + forecast visibility) can re-render without re-fetching. Reset on
// every _loadAllStorageForAsset call.
//   { assetId, mounts: [{ mountPath, data, samples, forecast, error? }] }
var _storagePanelState = null;

function _renderStorageViewToggle() {
  var bar = document.getElementById("storage-view-toggle");
  if (!bar) return;
  var view = _getStorageViewPref();
  bar.innerHTML =
    '<button class="btn btn-sm ' + (view === "pct"   ? 'btn-primary' : 'btn-secondary') + ' storage-view-btn" data-view="pct">Used %</button>' +
    '<button class="btn btn-sm ' + (view === "bytes" ? 'btn-primary' : 'btn-secondary') + ' storage-view-btn" data-view="bytes">Used bytes</button>';
  bar.querySelectorAll(".storage-view-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      var next = b.getAttribute("data-view");
      if (next === _getStorageViewPref()) return;
      _setStorageViewPref(next);
      _renderStorageViewToggle();
      _rerenderAllStorageSectionsFromState();
    });
  });
}

function _renderStorageForecastToggleFor(assetId, mountPath) {
  var section = _findStorageSection(mountPath);
  if (!section) return;
  var bar = section.querySelector("[data-storage-forecast-toggle]");
  if (!bar) return;
  var on = _getStorageForecastVisible(assetId, mountPath);
  bar.innerHTML =
    '<button class="btn btn-sm ' + (on ? 'btn-primary' : 'btn-secondary') + '" title="Per asset and mount; default on">' +
      (on ? '✓ Forecast' : 'Forecast') +
    '</button>';
  var btn = bar.querySelector("button");
  if (btn) {
    btn.addEventListener("click", function () {
      var next = !_getStorageForecastVisible(assetId, mountPath);
      _setStorageForecastVisible(assetId, mountPath, next);
      _renderStorageForecastToggleFor(assetId, mountPath);
      _rerenderStorageSectionFromState(mountPath);
    });
  }
}

function _rerenderAllStorageSectionsFromState() {
  var s = _storagePanelState;
  if (!s || !s.mounts) return;
  s.mounts.forEach(function (m) { _rerenderStorageSectionFromState(m.mountPath); });
}

function _rerenderStorageSectionFromState(mountPath) {
  var s = _storagePanelState;
  if (!s || !s.mounts) return;
  var mountState = null;
  for (var i = 0; i < s.mounts.length; i++) {
    if (s.mounts[i].mountPath === mountPath) { mountState = s.mounts[i]; break; }
  }
  if (!mountState) return;
  var section = _findStorageSection(mountPath);
  if (!section) return;
  var chartEl = section.querySelector("[data-storage-chart]");
  var statsEl = section.querySelector("[data-storage-stats]");
  var headEl  = section.querySelector("[data-storage-forecast-headline]");
  if (mountState.error) {
    if (chartEl) chartEl.textContent = "Error: " + mountState.error;
    if (statsEl) statsEl.textContent = "";
    if (headEl)  headEl.innerHTML = "";
    return;
  }
  var view = _getStorageViewPref();
  _renderStorageStats(statsEl, mountState.samples, mountState.data, view);
  _renderStorageForecastHeadline(headEl, mountState.forecast, view);
  _renderStorageChart(chartEl, mountState.samples, {
    since: mountState.data && mountState.data.since,
    until: mountState.data && mountState.data.until,
    outages: mountState.data && mountState.data.outages,
    subject: mountPath,
    view: view,
    forecast: mountState.forecast,
    forecastVisible: _getStorageForecastVisible(s.assetId, mountPath),
  });
}

async function _loadAllStorageForAsset(assetId, mountPaths, range) {
  if (!Array.isArray(mountPaths) || mountPaths.length === 0) return;
  var reqOpts = (typeof range === "string" || !range) ? { range: range || "24h" } : range;
  var rangeKey = typeof range === "string" ? range : "custom";

  // Set every section's chart container to "Loading…" up front so the user
  // sees activity across the pane, not just on the focused mount. Stamp the
  // active selection on each chart container too (canonical convention) so
  // screenshots and drag-select read the live window.
  mountPaths.forEach(function (mp) {
    var section = _findStorageSection(mp);
    if (!section) return;
    var chartEl = section.querySelector("[data-storage-chart]");
    var statsEl = section.querySelector("[data-storage-stats]");
    var headEl  = section.querySelector("[data-storage-forecast-headline]");
    if (chartEl) {
      chartEl.textContent = "Loading samples…";
      if (reqOpts.from && reqOpts.to) {
        chartEl.dataset.from = reqOpts.from;
        chartEl.dataset.to = reqOpts.to;
        delete chartEl.dataset.range;
      } else {
        chartEl.dataset.range = reqOpts.range || "24h";
        delete chartEl.dataset.from;
        delete chartEl.dataset.to;
      }
    }
    if (statsEl) statsEl.textContent = "Loading…";
    if (headEl)  headEl.innerHTML = "";
  });

  // One {primary, 7d-forecast} pair per mount, deduped to a single fetch
  // when the operator's selected range happens to be 7d. All N pairs fire
  // in parallel under one Promise.all — per-mount failures are caught and
  // stored so one bad mount doesn't take down the rest of the pane.
  var perMount = await Promise.all(mountPaths.map(async function (mountPath) {
    try {
      var primaryPromise = api.assets.storageHistory(assetId, mountPath, reqOpts);
      var forecastPromise = rangeKey === "7d" ? primaryPromise : api.assets.storageHistory(assetId, mountPath, { range: "7d" });
      var pair = await Promise.all([primaryPromise, forecastPromise]);
      var data = pair[0];
      var samples = (data && data.samples) || [];
      var forecastSamples = (pair[1] && pair[1].samples) || [];
      var forecast = _computeStorageForecast(forecastSamples);
      return { mountPath: mountPath, data: data, samples: samples, forecast: forecast };
    } catch (err) {
      return { mountPath: mountPath, error: err && err.message ? err.message : "failed to load" };
    }
  }));

  _storagePanelState = { assetId: assetId, mounts: perMount };
  perMount.forEach(function (m) { _rerenderStorageSectionFromState(m.mountPath); });
}

function _renderStorageStats(container, samples, data, view) {
  if (!container) return;
  samples = _inChartWindow(samples, data && data.since);
  var latest = samples.length ? samples[samples.length - 1] : null;
  var parts;
  if (view === "bytes") {
    parts = [
      { label: "Latest used", value: latest && typeof latest.usedBytes  === "number" ? _fmtBytes(latest.usedBytes)  : "—" },
      { label: "Total",       value: latest && typeof latest.totalBytes === "number" ? _fmtBytes(latest.totalBytes) : "—" },
      { label: "Free",        value: (latest && typeof latest.totalBytes === "number" && typeof latest.usedBytes === "number")
                                     ? _fmtBytes(Math.max(0, latest.totalBytes - latest.usedBytes))
                                     : "—" },
    ];
  } else {
    var pcts = [];
    samples.forEach(function (s) {
      if (s.totalBytes && s.usedBytes != null && s.totalBytes > 0) {
        pcts.push((s.usedBytes / s.totalBytes) * 100);
      }
    });
    var minP = pcts.length ? Math.min.apply(null, pcts) : null;
    var maxP = pcts.length ? Math.max.apply(null, pcts) : null;
    var avgP = pcts.length ? pcts.reduce(function (a, b) { return a + b; }, 0) / pcts.length : null;
    var latestPct = (latest && latest.totalBytes && latest.usedBytes != null && latest.totalBytes > 0)
      ? ((latest.usedBytes / latest.totalBytes) * 100)
      : null;
    parts = [
      { label: "Latest", value: latestPct != null ? latestPct.toFixed(1) + "%" : "—" },
      { label: "Avg",    value: avgP      != null ? avgP.toFixed(1)      + "%" : "—" },
      { label: "Min",    value: minP      != null ? minP.toFixed(1)      + "%" : "—" },
      { label: "Max",    value: maxP      != null ? maxP.toFixed(1)      + "%" : "—" },
    ];
  }
  var tier = _tierStatsPart(data);
  if (tier) parts.unshift(tier);
  _renderChartStats(container, samples.length, parts);
}

// Linear least-squares over the last 7 days of usedBytes samples. Treats the
// latest sample's totalBytes as the projection target (FortiOS volume resizes
// are rare; assuming a fixed denominator avoids regressing two correlated
// series). Returns null when there are fewer than two samples or the latest
// sample has no totalBytes — caller renders "no data" in that case.
//
// `signal` semantics:
//   "growing"        — slope > 0 and daysToFull ≤ 365
//   "beyond-horizon" — slope > 0 but daysToFull > 365 (negligible growth)
//   "flat"           — |slope| × 7d projection is < 0.1% of totalBytes
//   "shrinking"      — slope < 0 with measurable shrink
function _computeStorageForecast(samples) {
  if (!Array.isArray(samples)) return null;
  var pts = [];
  for (var i = 0; i < samples.length; i++) {
    var s = samples[i];
    if (typeof s.usedBytes !== "number") continue;
    var ts = new Date(s.timestamp).getTime();
    if (!isFinite(ts)) continue;
    pts.push({ ts: ts, used: s.usedBytes, total: s.totalBytes });
  }
  if (pts.length < 2) return null;
  // Latest non-null totalBytes from the series — used as the projection
  // ceiling. Falls back to scanning the most recent samples that have it set.
  var totalBytes = null;
  for (var k = pts.length - 1; k >= 0; k--) {
    if (typeof pts[k].total === "number" && pts[k].total > 0) { totalBytes = pts[k].total; break; }
  }
  if (totalBytes == null) return null;
  // Least-squares: regress used = m * ts + b.
  var n = pts.length, sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (var j = 0; j < n; j++) {
    sumX  += pts[j].ts;
    sumY  += pts[j].used;
    sumXY += pts[j].ts * pts[j].used;
    sumXX += pts[j].ts * pts[j].ts;
  }
  var denom = (n * sumXX) - (sumX * sumX);
  if (denom === 0) return null;
  var slopePerMs = ((n * sumXY) - (sumX * sumY)) / denom;
  var intercept  = (sumY - slopePerMs * sumX) / n;
  var msPerDay = 86400000;
  var slopePerDay = slopePerMs * msPerDay;
  var latest = pts[pts.length - 1];
  // Significance threshold: 7-day projected change less than 0.1% of total.
  var sevenDayDelta = Math.abs(slopePerDay) * 7;
  var significanceFloor = totalBytes * 0.001;
  var signal;
  var daysToFull = null;
  if (sevenDayDelta < significanceFloor) {
    signal = "flat";
  } else if (slopePerDay < 0) {
    signal = "shrinking";
  } else {
    var remaining = totalBytes - latest.used;
    if (remaining <= 0) {
      daysToFull = 0;
      signal = "growing";
    } else {
      daysToFull = remaining / slopePerDay;
      signal = daysToFull > 365 ? "beyond-horizon" : "growing";
    }
  }
  return {
    slopePerMs: slopePerMs,
    slopePerDay: slopePerDay,
    intercept: intercept,
    latestTs: latest.ts,
    latestUsed: latest.used,
    totalBytes: totalBytes,
    daysToFull: daysToFull,
    signal: signal,
  };
}

function _renderStorageForecastHeadline(container, forecast, view) {
  if (!container) return;
  if (!forecast) { container.innerHTML = ""; return; }
  var color = "var(--color-text-secondary)";
  var headline;
  if (forecast.signal === "growing") {
    var days = forecast.daysToFull;
    if (days != null && days < 30) color = "var(--color-danger, #e63946)";
    else if (days != null && days < 90) color = "var(--color-warning, #f4a261)";
    else color = "var(--color-success, #2a9d8f)";
    headline = "Days until full: <strong>" + (days != null ? days.toFixed(days < 10 ? 1 : 0) : "—") + "</strong>";
    var trendBytes = Math.abs(forecast.slopePerDay);
    if (view === "bytes") {
      headline += ' <span style="color:var(--color-text-secondary)">· trend: +' + _fmtBytes(trendBytes) + "/day</span>";
    } else {
      var pctPerDay = (forecast.slopePerDay / forecast.totalBytes) * 100;
      headline += ' <span style="color:var(--color-text-secondary)">· trend: +' + pctPerDay.toFixed(pctPerDay < 1 ? 2 : 1) + "%/day</span>";
    }
  } else if (forecast.signal === "shrinking") {
    color = "var(--color-success, #2a9d8f)";
    headline = "Shrinking";
    var shrinkBytes = Math.abs(forecast.slopePerDay);
    if (view === "bytes") {
      headline += ' <span style="color:var(--color-text-secondary)">· −' + _fmtBytes(shrinkBytes) + "/day</span>";
    } else {
      var shrinkPct = Math.abs((forecast.slopePerDay / forecast.totalBytes) * 100);
      headline += ' <span style="color:var(--color-text-secondary)">· −' + shrinkPct.toFixed(shrinkPct < 1 ? 2 : 1) + "%/day</span>";
    }
  } else if (forecast.signal === "beyond-horizon") {
    color = "var(--color-success, #2a9d8f)";
    headline = "Days until full: <strong>&gt; 1 year</strong>";
  } else {
    headline = "No measurable growth";
  }
  container.innerHTML = '<span style="color:' + color + '">' + headline + "</span>";
}

// Unified storage chart. `view` ∈ "pct" | "bytes". When `opts.forecast` is
// present and `opts.forecastVisible` is true and the forecast is growing,
// the X-axis extends to the right by up to one history-span so the projected
// dashed line is visible without compressing history off the chart.
function _renderStorageChart(container, samples, opts) {
  if (!container) return;
  opts = opts || {};
  var view = opts.view === "bytes" ? "bytes" : "pct";
  var forecast = opts.forecast || null;
  var forecastVisible = opts.forecastVisible !== false && forecast != null;
  // Draw the projection for every non-null forecast — flat and shrinking
  // trajectories are useful information too. Only skip when we don't have
  // enough data to regress (forecast === null).
  var drawForecast = forecastVisible && forecast != null;

  if (view === "bytes") {
    var used  = samples.map(function (s) { return { ts: s.timestamp, v: s.usedBytes }; }).filter(function (e) { return typeof e.v === "number"; });
    var total = samples.map(function (s) { return { ts: s.timestamp, v: s.totalBytes }; }).filter(function (e) { return typeof e.v === "number"; });
    if (used.length === 0 && total.length === 0) {
      container.textContent = "No usage samples in this range yet.";
      return;
    }
  } else {
    var pctValues = samples.map(function (s) {
      var pct = (s.totalBytes && s.usedBytes != null && s.totalBytes > 0) ? (s.usedBytes / s.totalBytes) * 100 : null;
      return { ts: s.timestamp, v: pct };
    }).filter(function (e) { return typeof e.v === "number"; });
    if (pctValues.length === 0) {
      container.textContent = "No usage % samples in this range yet.";
      return;
    }
  }

  var W = container.clientWidth || 600, H = 180;
  var padL = view === "bytes" ? 64 : 44, padR = 10, padT = 10, padB = 32;
  var innerW = W - padL - padR, innerH = H - padT - padB;
  var bounds = _chartTimeBounds(samples, opts.since, opts.until);
  var t0 = bounds.t0, t1 = bounds.t1;
  var historySpan = Math.max(1, t1 - t0);
  var forecastEndTs = null;
  if (drawForecast) {
    // Always extend the X-axis by exactly one history-span so the projection
    // half of the chart sits next to a same-scale history half — a 1h range
    // shows 1h of history + 1h of future, a 7d range shows 7d + 7d, etc.
    // Flat and shrinking trajectories still get the extension so the dashed
    // line is visible; "growing" trajectories with daysToFull < historySpan
    // get clipped to the 100% line by the Y-axis cap below.
    forecastEndTs = forecast.latestTs + historySpan;
    if (forecastEndTs > t1) t1 = forecastEndTs;
  }
  var spanMs = t1 - t0, oneDayMs = 86400000;
  var pad2 = _chartPad2;

  var ceil;
  if (view === "bytes") {
    var maxV = 0;
    samples.forEach(function (s) {
      if (typeof s.usedBytes  === "number" && s.usedBytes  > maxV) maxV = s.usedBytes;
      if (typeof s.totalBytes === "number" && s.totalBytes > maxV) maxV = s.totalBytes;
    });
    if (maxV <= 0) maxV = 1;
    function tidyCeil(n) {
      var exp = Math.pow(10, Math.floor(Math.log10(n)));
      var mant = n / exp;
      var step = mant <= 1 ? 1 : mant <= 2 ? 2 : mant <= 5 ? 5 : 10;
      return step * exp;
    }
    ceil = tidyCeil(maxV);
  } else {
    ceil = 100;
  }
  var xFor = _chartXScale(padL, innerW, t0, t1);
  var yFor = _chartYScale(padT, innerH, 0, ceil);

  var ticks = "";
  for (var i = 0; i <= 4; i++) {
    var v = ceil * i / 4;
    var y = padT + innerH - (i / 4) * innerH;
    var label = view === "bytes" ? _fmtBytes(v) : v.toFixed(0) + "%";
    ticks +=
      '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (padL - 4) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + label + '</text>';
  }
  var xTicks = _chartXTicksSVG(t0, t1, padL, padT, innerW, innerH);

  // Missed polls. The storage cadence doesn't run while an asset is down, so a
  // skipped scrape leaves no row — same as telemetry and the interface
  // counters, and handled the same way: outage windows come from the
  // response-time probe (see _outageMarkers) rather than from the size of the
  // hole. That distinction is what makes this safe HERE in particular — a
  // mount that is simply unmounted on a healthy device sits inside no outage
  // window and draws no dive, where a gap heuristic would have called it one.
  //
  // clipId is built here rather than at the SVG assembly below because it seeds
  // the per-render gradient id prefix _failureAwareSeriesSVG needs; without a
  // unique prefix the fade gradients collide between the several mount charts
  // on the Storage tab.
  var clipId = _chartClipId("storage");
  var baselineY = padT + innerH;
  var gapMarkers = _outageMarkers(opts.outages, samples.map(function (s) { return +new Date(s.timestamp); }));
  var failDefs = "";
  // Both bytes-view series dive together: used and total ride the same storage
  // row, so an outage is an outage for both.
  function storageFailAwarePts(list) {
    if (!list.length) return [];
    var pts = list.map(function (e) {
      return { t: +new Date(e.ts), x: xFor(e.ts), y: yFor(e.v), ok: true };
    });
    _outagePts(gapMarkers, xFor, baselineY).forEach(function (mp) { pts.push(mp); });
    pts.sort(function (a, b) { return a.t - b.t; });
    return pts;
  }
  // `dash` re-applies a dashed stroke per emitted segment. _failureAwareSeriesSVG
  // returns one <line> per segment (so each OK<->fail transition can carry its
  // own fade gradient), so a dash baked into a single polyline has nowhere to
  // live — it has to be stamped onto each segment instead.
  function storageFailLine(list, color, idSuffix, dash) {
    var pts = storageFailAwarePts(list);
    if (!pts.length) return "";
    var seg = _failureAwareSeriesSVG(pts, color, clipId + "-" + idSuffix);
    failDefs += seg.defs;
    return dash ? seg.segments.replace(/<line /g, '<line stroke-dasharray="4 3" ') : seg.segments;
  }
  var failDots = _outageDotsSVG(gapMarkers, xFor, baselineY);
  var missHits = _outageHitsSVG(gapMarkers, xFor, padT, innerH);

  // Build main series, hit-targets, and forecast overlay per view.
  var seriesSvg = "", hitSvg = "", legendSvg = "", forecastSvg = "", nowMarkerSvg = "";
  if (view === "bytes") {
    var usedSeries  = samples.filter(function (s) { return typeof s.usedBytes  === "number"; }).map(function (s) { return { ts: s.timestamp, v: s.usedBytes  }; });
    var totalSeries = samples.filter(function (s) { return typeof s.totalBytes === "number"; }).map(function (s) { return { ts: s.timestamp, v: s.totalBytes }; });
    seriesSvg =
      storageFailLine(totalSeries, "#9b5de5", "total", true) +
      storageFailLine(usedSeries, "var(--color-accent)", "used") +
      failDots +
      samples.filter(function (s) { return typeof s.totalBytes === "number"; }).map(function (s) { return '<circle cx="' + xFor(s.timestamp) + '" cy="' + yFor(s.totalBytes) + '" r="1.5" fill="#9b5de5"/>'; }).join("") +
      samples.filter(function (s) { return typeof s.usedBytes  === "number"; }).map(function (s) { return '<circle cx="' + xFor(s.timestamp) + '" cy="' + yFor(s.usedBytes)  + '" r="1.5" fill="var(--color-accent)"/>'; }).join("");
    legendSvg =
      '<g font-size="10" fill="currentColor">' +
        '<rect x="' + (padL + 10) + '" y="2" width="10" height="10" fill="var(--color-accent)"/>' +
        '<text x="' + (padL + 24) + '" y="11">Used</text>' +
        '<rect x="' + (padL + 80) + '" y="2" width="10" height="10" fill="#9b5de5"/>' +
        '<text x="' + (padL + 94) + '" y="11">Total</text>' +
        (drawForecast ? '<line x1="' + (padL + 150) + '" y1="7" x2="' + (padL + 168) + '" y2="7" stroke="var(--color-accent)" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.7"/><text x="' + (padL + 172) + '" y="11">Forecast</text>' : '') +
      '</g>';
    hitSvg = samples.map(function (s) {
      var y = padT + innerH;
      if (typeof s.usedBytes  === "number") y = Math.min(y, yFor(s.usedBytes));
      if (typeof s.totalBytes === "number") y = Math.min(y, yFor(s.totalBytes));
      return '<circle class="chart-hit" cx="' + xFor(s.timestamp) + '" cy="' + y + '" r="6" fill="transparent" style="cursor:crosshair"' +
        ' data-ts="' + escapeHtml(String(s.timestamp)) + '"' +
        ' data-used="'  + (typeof s.usedBytes  === "number" ? s.usedBytes  : "") + '"' +
        ' data-total="' + (typeof s.totalBytes === "number" ? s.totalBytes : "") + '"/>';
    }).join("");
  } else {
    var pctSeries = samples.map(function (s) {
      var pct = (s.totalBytes && s.usedBytes != null && s.totalBytes > 0) ? (s.usedBytes / s.totalBytes) * 100 : null;
      return { ts: s.timestamp, v: pct };
    }).filter(function (e) { return typeof e.v === "number"; });
    seriesSvg =
      storageFailLine(pctSeries, "var(--color-accent)", "pct") +
      failDots +
      pctSeries.map(function (e) { return '<circle cx="' + xFor(e.ts) + '" cy="' + yFor(e.v) + '" r="1.5" fill="var(--color-accent)"/>'; }).join("");
    if (drawForecast) {
      legendSvg =
        '<g font-size="10" fill="currentColor">' +
          '<line x1="' + (padL + 10) + '" y1="7" x2="' + (padL + 28) + '" y2="7" stroke="var(--color-accent)" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.7"/>' +
          '<text x="' + (padL + 32) + '" y="11">Forecast</text>' +
        '</g>';
    }
    hitSvg = pctSeries.map(function (e) {
      return '<circle class="chart-hit" cx="' + xFor(e.ts) + '" cy="' + yFor(e.v) + '" r="6" fill="transparent" style="cursor:crosshair"' +
        ' data-ts="' + escapeHtml(String(e.ts)) + '" data-v="' + e.v + '"/>';
    }).join("");
  }

  // Forecast overlay — dashed line in same color as the active series.
  // Drawn for every signal (growing / flat / shrinking / beyond-horizon)
  // so the operator always sees the projected trajectory next to history.
  if (drawForecast) {
    var fStart = forecast.latestTs;
    var fEnd   = forecastEndTs;
    var fStartV, fEndV;
    if (view === "bytes") {
      fStartV = forecast.latestUsed;
      fEndV   = forecast.intercept + forecast.slopePerMs * fEnd;
      if (fEndV > ceil) fEndV = ceil;
      if (fEndV < 0) fEndV = 0;
    } else {
      fStartV = (forecast.latestUsed / forecast.totalBytes) * 100;
      var projectedUsed = forecast.intercept + forecast.slopePerMs * fEnd;
      var projectedPct  = (projectedUsed / forecast.totalBytes) * 100;
      fEndV = Math.max(0, Math.min(100, projectedPct));
    }
    var x1 = xFor(fStart), y1 = yFor(fStartV);
    var x2 = xFor(fEnd),   y2 = yFor(fEndV);
    forecastSvg =
      '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '"' +
        ' stroke="var(--color-accent)" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.7"/>';
    // Vertical "now" divider at the projection origin.
    nowMarkerSvg =
      '<line x1="' + x1 + '" y1="' + padT + '" x2="' + x1 + '" y2="' + (padT + innerH) + '"' +
        ' stroke="rgba(127,127,127,0.55)" stroke-width="1" stroke-dasharray="2,3"/>' +
      '<text x="' + (x1 + 3) + '" y="' + (padT + 9) + '" font-size="9" fill="currentColor" opacity="0.7">now</text>';
  }

  container.innerHTML =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      _chartClipDefs(clipId, padL, padT, innerW, innerH) +
      // Fade gradients get their own <defs> beside the clip's — valid SVG, and
      // they must NOT sit inside the clipped <g> that references them.
      (failDefs ? '<defs>' + failDefs + '</defs>' : '') +
      ticks + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      _maintenanceBandLayer(t0, t1, padL, padT, innerW, innerH) +
      '<g ' + _chartClipAttr(clipId) + '>' +
        seriesSvg +
        forecastSvg +
        nowMarkerSvg +
        // missHits BEFORE hitSvg: the storage chart's hit targets are small
        // circles anchored on the line, so the full-height miss rect has to
        // paint under them or it would steal the hover from the real samples
        // flanking the gap. (The CPU/Memory chart is the opposite case — its
        // hits are full-height Voronoi lanes, so its miss rect must go last.)
        missHits +
        hitSvg +
      '</g>' +
      legendSvg +
    '</svg>' + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";
  _stashChartGeometry(container, t0, t1, padL, innerW, W);
  if (view === "bytes") {
    _wireChartTooltip(container, function (target) {
      if (target.getAttribute("data-miss") === "1") {
        return _missTooltipHTML(target);
      }
      var u = target.getAttribute("data-used");
      var t = target.getAttribute("data-total");
      return '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(target.getAttribute("data-ts"))) + '</div>' +
        '<div>Used: '  + (u !== "" ? _fmtBytes(Number(u)) : "—") + '</div>' +
        '<div>Total: ' + (t !== "" ? _fmtBytes(Number(t)) : "—") + '</div>';
    });
    _addChartScreenshotButton(container, "Storage usage (bytes)", { yAxis: "Bytes", subject: opts.subject, getStats: _storageStatsSummaryFor(container) });
  } else {
    _wireChartTooltip(container, function (target) {
      if (target.getAttribute("data-miss") === "1") {
        return _missTooltipHTML(target);
      }
      return '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(target.getAttribute("data-ts"))) + '</div>' +
        '<div>Used: ' + Number(target.getAttribute("data-v")).toFixed(2) + '%</div>';
    });
    _addChartScreenshotButton(container, "Storage usage %", { yAxis: "Used %", subject: opts.subject, getStats: _storageStatsSummaryFor(container) });
  }
  _observeChartResize(container, function (c) { _renderStorageChart(c, samples, opts); });
}

// Find the visible content of the asset details slide-in: the active tab
// panel when the slide-in is rendered with tabs, otherwise the body itself
// (modal-style edit views without tabs).
function _activeAssetPanel() {
  var panels = document.querySelectorAll('[id^="asset-view-tab-"]');
  for (var i = 0; i < panels.length; i++) {
    if (panels[i].classList.contains('active')) return panels[i];
  }
  return document.getElementById('asset-panel-body') ||
         document.querySelector('#modal-overlay .modal-body');
}

function _activeAssetTabLabel() {
  var btn = document.querySelector('#asset-view-tabs .page-tab.active');
  return btn ? (btn.innerText || btn.textContent || '').trim() : '';
}

// Walk the active tab panel and extract structured content blocks for the
// plaintext Copy button (the Screenshot button rasterizes the live DOM via
// html-to-image instead — see _runScreenshotCapture). Five block shapes:
//   { type: 'kv',      label, value }   from .detail-row pairs (General tab)
//   { type: 'table',   headers, rows }  from any <table> (System/Quarantine/etc.)
//   { type: 'heading', text }           from .section-label and <h1>-<h6>
//   { type: 'chart',   svg }            from any rendered chart <svg>
//                                       (skipped by the plaintext copy)
//   { type: 'text',    lines }          free-form panel text (Polaris Agent
//                                       block, chart stat lines, source badges)
//                                       with interactive/icon subtrees stripped
// Buttons, inputs, the gear/screenshot wraps, and hidden nodes are skipped.
function _extractTabBlocks(root) {
  if (!root) return [];
  // Interactive + icon scaffolding: never carries content worth capturing, and
  // (gear/screenshot wraps, resize handles) would otherwise leak into text.
  var SKIP_SEL = 'button,input,select,textarea,.sf-col-gear-wrap,.chart-screenshot-btn,.sf-resize-handle,script,style';
  var blocks = [];
  function isHidden(el) {
    if (!el) return true;
    var cs = el.ownerDocument && el.ownerDocument.defaultView
      ? el.ownerDocument.defaultView.getComputedStyle(el)
      : null;
    return cs && (cs.display === 'none' || cs.visibility === 'hidden');
  }
  // Collect visible, non-interactive text from a free-form subtree, one line
  // per block-level leaf so the Polaris Agent grid ("Version: …", "Platform: …")
  // and stat strips render as readable lines rather than one run-on string.
  function collectTextLines(el) {
    var lines = [];
    function isBlockish(c) {
      var cs = el.ownerDocument.defaultView.getComputedStyle(c);
      var d = cs ? cs.display : '';
      return d === 'block' || d === 'flex' || d === 'grid' || d === 'list-item' ||
        /^(DIV|P|LI|TR|SECTION|UL|OL|H[1-6])$/.test(c.tagName);
    }
    function hasBlockChild(node) {
      for (var i = 0; i < node.children.length; i++) {
        var c = node.children[i];
        if (isHidden(c) || (c.matches && c.matches(SKIP_SEL))) continue;
        if (isBlockish(c)) return true;
      }
      return false;
    }
    function pushLeaf(node) {
      var clone = node.cloneNode(true);
      if (clone.querySelectorAll) {
        Array.prototype.forEach.call(clone.querySelectorAll(SKIP_SEL), function (n) {
          if (n.parentNode) n.parentNode.removeChild(n);
        });
      }
      var t = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) lines.push(t);
    }
    function rec(node) {
      if (hasBlockChild(node)) {
        for (var i = 0; i < node.childNodes.length; i++) {
          var c = node.childNodes[i];
          if (c.nodeType === 3) {
            var t = c.nodeValue.replace(/\s+/g, ' ').trim();
            if (t) lines.push(t);
          } else if (c.nodeType === 1 && !isHidden(c) && !(c.matches && c.matches(SKIP_SEL))) {
            rec(c);
          }
        }
      } else {
        pushLeaf(node);
      }
    }
    rec(el);
    return lines;
  }
  function walk(node) {
    if (!node || node.nodeType !== 1) return;
    var el = node;
    if (isHidden(el)) return;
    // Rendered chart SVG → image block. Skip the camera button's own icon svg
    // and any small decorative/icon svg (charts are large; icons ~14-24px).
    if (el.tagName && el.tagName.toLowerCase() === 'svg') {
      if (!el.closest || !el.closest('.chart-screenshot-btn')) {
        var sr = el.getBoundingClientRect();
        if (sr.width >= 80 && sr.height >= 60) blocks.push({ type: 'chart', svg: el });
      }
      return;
    }
    if (el.matches && el.matches(SKIP_SEL)) return;
    if (el.classList && el.classList.contains('detail-row')) {
      var lbl = el.querySelector('.detail-label');
      var val = el.querySelector('.detail-value');
      if (lbl && val) {
        blocks.push({
          type: 'kv',
          label: (lbl.innerText || lbl.textContent || '').trim(),
          value: (val.innerText || val.textContent || '').trim(),
        });
      }
      return;
    }
    if (el.tagName === 'TABLE') {
      var headers = [];
      el.querySelectorAll('thead th').forEach(function (th) {
        headers.push((th.innerText || th.textContent || '').trim());
      });
      // No <thead>? Some compact tables (Ports & Connections in the process/
      // service slide-in) put their <th> row straight in the implicit tbody.
      if (!headers.length) {
        el.querySelectorAll('tr:first-child th').forEach(function (th) {
          headers.push((th.innerText || th.textContent || '').trim());
        });
      }
      var rows = [];
      el.querySelectorAll('tbody tr').forEach(function (tr) {
        var row = [];
        tr.querySelectorAll('td').forEach(function (td) {
          row.push((td.innerText || td.textContent || '').trim().replace(/\s+/g, ' '));
        });
        if (row.length) rows.push(row);
      });
      if (rows.length) blocks.push({ type: 'table', headers: headers, rows: rows });
      return;
    }
    if (el.classList && el.classList.contains('section-label')) {
      var st = (el.innerText || el.textContent || '').trim();
      if (st) blocks.push({ type: 'heading', text: st });
      return;
    }
    if (/^H[1-6]$/.test(el.tagName)) {
      var ht = (el.innerText || el.textContent || '').trim();
      if (ht) blocks.push({ type: 'heading', text: ht });
      return;
    }
    // Free-form leaf (no structural descendants we handle separately) → text.
    if (!el.querySelector('.detail-row, table, .section-label, h1, h2, h3, h4, h5, h6, svg')) {
      var lines = collectTextLines(el);
      if (lines.length) blocks.push({ type: 'text', lines: lines });
      return;
    }
    for (var i = 0; i < el.childNodes.length; i++) walk(el.childNodes[i]);
  }
  walk(root);
  return blocks;
}

// Render extracted blocks (see _extractTabBlocks) as plaintext lines, for the
// process/service slide-in's Copy.
function _blocksToPlaintext(blocks) {
  var lines = [];
  blocks.forEach(function (b) {
    if (b.type === 'heading') {
      if (lines.length) lines.push('');
      lines.push(b.text);
      lines.push(new Array(b.text.length + 1).join('-'));
    } else if (b.type === 'kv') {
      if (b.value.indexOf('\n') !== -1) {
        var indented = b.value.split('\n').map(function (l) { return '  ' + l; }).join('\n');
        lines.push(b.label + ':\n' + indented);
      } else {
        lines.push(b.label + ': ' + (b.value || '-'));
      }
    } else if (b.type === 'text') {
      (b.lines || []).forEach(function (line) { if (line) lines.push(line); });
    } else if (b.type === 'table') {
      if (b.headers && b.headers.length) lines.push(b.headers.join(' | '));
      b.rows.forEach(function (r) { lines.push(r.join(' | ')); });
    }
    // 'chart' blocks are images — nothing to put in a plaintext copy.
  });
  return lines.join('\n');
}

// Faithful screenshot of the active tab panel, rendered at a canonical
// CAPTURE_WIDTH so the output is identical regardless of the operator's
// display size or drag-resized slide-over. The live DOM subtree is
// rasterized as-rendered via the vendored html-to-image library: it deep-
// clones the panel, inlines computed styles (incl. pseudo-elements) and the
// page's webfonts, serializes the clone into an SVG <foreignObject>, and lets
// the browser itself paint it onto a canvas — so the PNG matches how the tab
// truly renders at that width (charts, badges, theme colors, fonts). A
// small title strip (hostname + tab label) is drawn above the capture and
// the whole composition gets uniform padding so the screenshot self-
// identifies and breathes after copy/paste. Scrollbar chrome is excluded via
// the .screenshot-hide-scrollbars class (see styles.css). Webfont embedding
// fetches the Google Fonts CSS + woff2 files (allowed by CSP connect-src);
// when they're unreachable the capture still completes, just with fallback
// system fonts. One known fidelity gap: inner scrollable regions render
// scrolled-to-top in the clone (scroll offsets don't survive cloneNode).
//
// `opts.filter` (optional) is forwarded to html-to-image — return false for a
// node to prune it and its whole subtree from the clone. The options modal
// uses it to drop deselected sections. `opts.output === "pdf"` saves the
// composed canvas as a letter-portrait PDF (_saveCaptureAsPdf) instead of
// copying it to the clipboard. Returns a Promise that resolves when the
// capture has finished (success or toast'd failure — it never rejects).
function _runScreenshotCapture(asset, opts) {
  opts = opts || {};
  var panel = _activeAssetPanel();
  if (!panel) { showToast("Nothing to screenshot", "error"); return Promise.resolve(); }
  if (typeof htmlToImage === "undefined") {
    showToast("Screenshot failed — capture library not loaded", "error");
    return Promise.resolve();
  }

  var cs = getComputedStyle(document.documentElement);
  var bgPrimary = cs.getPropertyValue("--color-bg-primary").trim() || "#ffffff";
  var clrText   = cs.getPropertyValue("--color-text-primary").trim() || "#111";
  var fontSans  = cs.getPropertyValue("--font-sans").trim() || "system-ui,-apple-system,sans-serif";

  var btns = [document.getElementById("btn-asset-screenshot"), document.getElementById("btn-asset-pdf")];
  btns.forEach(function (b) { if (b) b.disabled = true; });
  function done() { btns.forEach(function (b) { if (b) b.disabled = false; }); }

  // Capture at a canonical width so the screenshot is independent of the
  // operator's display / drag-resized slide-over (initSlideoverResize stamps
  // an inline width). html-to-image freezes each element's COMPUTED pixel
  // styles into its clone, so the clone can't be reflowed after the fact —
  // the live panel itself must lay out at the target width before cloning.
  // Forcing the slide-over wide also makes every chart re-render at that
  // width via its ResizeObserver, hence the settle delay below. The
  // operator's width is restored as soon as the rasterization settles.
  var CAPTURE_WIDTH = 1100; // px — the slide-over's design max (styles.css clamp)
  var slideover = panel.closest(".slideover");
  var prevWidth = slideover ? slideover.style.width : "";
  if (slideover) slideover.style.width = CAPTURE_WIDTH + "px";

  // Hide scrollbar chrome (panel + every inner scrollable table wrap) for the
  // duration of the capture: `scrollbar-width: none` applied to the live
  // nodes is what the inlined computed styles carry into the clone. On
  // classic-scrollbar platforms (Windows) this also widens scroll containers
  // by the bar width — another reflow the settle delay absorbs.
  panel.classList.add("screenshot-hide-scrollbars");
  function release() {
    panel.classList.remove("screenshot-hide-scrollbars");
    if (slideover) slideover.style.width = prevWidth;
  }

  // Double-rAF puts us past the relayout + ResizeObserver delivery for the
  // width change; the timeout covers the chart re-renders those observers
  // kick off.
  function whenSettled(cb) {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        setTimeout(cb, 300);
      });
    });
  }

  var scale = 2;
  return new Promise(function (resolve) {
    whenSettled(function () {
      var captureOpts = { pixelRatio: scale, backgroundColor: bgPrimary };
      if (typeof opts.filter === "function") captureOpts.filter = opts.filter;
      htmlToImage.toCanvas(panel, captureOpts)
        .then(function (capture) {
          release();
          var pad = 24;
          var titleH = 48;
          var w = capture.width / scale;
          var h = capture.height / scale;
          var canvas = document.createElement("canvas");
          canvas.width = (w + pad * 2) * scale;
          canvas.height = (titleH + h + pad) * scale;
          var ctx = canvas.getContext("2d");
          ctx.scale(scale, scale);
          ctx.fillStyle = bgPrimary;
          ctx.fillRect(0, 0, w + pad * 2, titleH + h + pad);
          ctx.fillStyle = clrText;
          ctx.font = "bold 17px " + fontSans;
          var tabLabel = _activeAssetTabLabel();
          var title = "Asset Details" + (asset && asset.hostname ? " — " + asset.hostname : "");
          if (tabLabel) title += " (" + tabLabel + ")";
          ctx.fillText(title, pad, 32);
          // 1:1 device-pixel blit (w×h CSS px under the 2x transform), so the
          // captured tab is never resampled.
          ctx.drawImage(capture, pad, titleH, w, h);
          if (opts.output === "pdf") {
            try {
              _saveCaptureAsPdf(canvas, asset, tabLabel);
            } catch (err) {
              showToast("PDF export failed: " + (err.message || "Unknown error"), "error");
            }
            done();
            resolve();
            return;
          }
          canvas.toBlob(function (blob) {
            done();
            if (!blob) { showToast("Screenshot failed", "error"); resolve(); return; }
            copyPngToClipboard(blob).then(function (ok) {
              showToast(ok ? "Screenshot copied to clipboard" : "Screenshot failed — requires HTTPS or clipboard permission", ok ? "success" : "error");
              resolve();
            });
          }, "image/png");
        })
        .catch(function () {
          release();
          done();
          showToast(opts.output === "pdf" ? "PDF export failed" : "Screenshot failed", "error");
          resolve();
        });
    });
  });
}

// Lay a composed capture canvas onto letter-portrait PDF pages: scaled to
// the printable width, then sliced into page-height bands so a tall tab runs
// across as many pages as it needs. Each page is filled with the capture's
// own background first so a dark-theme capture doesn't sit on white margins
// (read off the canvas's top-left pixel — the theme token may be any CSS
// colour syntax, which jsPDF's setFillColor doesn't parse).
function _saveCaptureAsPdf(canvas, asset, tabLabel) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error("PDF library not loaded. Check your internet connection and reload the page.");
  }
  var doc = new window.jspdf.jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });
  var pageW = doc.internal.pageSize.getWidth();
  var pageH = doc.internal.pageSize.getHeight();
  var margin = 24;
  var printW = pageW - margin * 2;
  var printH = pageH - margin * 2;
  var ptPerPx = printW / canvas.width;
  var slicePx = Math.max(1, Math.floor(printH / ptPerPx));
  var bg = canvas.getContext("2d").getImageData(0, 0, 1, 1).data;

  for (var y = 0, page = 0; y < canvas.height; y += slicePx, page++) {
    var h = Math.min(slicePx, canvas.height - y);
    var slice = document.createElement("canvas");
    slice.width = canvas.width;
    slice.height = h;
    slice.getContext("2d").drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
    if (page > 0) doc.addPage();
    doc.setFillColor(bg[0], bg[1], bg[2]);
    doc.rect(0, 0, pageW, pageH, "F");
    doc.addImage(slice.toDataURL("image/png"), "PNG", margin, margin, printW, h * ptPerPx);
  }

  var tabPart = tabLabel ? "-" + String(tabLabel).replace(/[^A-Za-z0-9._-]+/g, "-") : "";
  var filename = "asset-" + _assetExportSubject(asset) + tabPart + "-" + new Date().toISOString().slice(0, 10) + ".pdf";
  doc.save(filename);
  showToast("Exported " + filename);
}

// Enumerate the active tab's screenshot-eligible sections from the live DOM.
// Every tab builder wraps each logical section in a
// `<div data-shot-section="<key>" data-shot-label="<Label>">` (chart-bearing
// sections add data-shot-chart, Interfaces adds data-shot-sub) — so the
// options modal needs no per-tab knowledge: sections absent on this asset
// simply don't render and never appear. Wrappers that are hidden or have no
// real content (an empty async mount like the dependency tree on a
// non-Fortinet asset, or the agent panel with no agent) are skipped.
function _collectShotSections(panel) {
  if (!panel) return [];
  var out = [];
  var els = panel.querySelectorAll("[data-shot-section]");
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (el.offsetParent === null) continue; // hidden
    var hasContent = (el.textContent || "").trim() !== "" || !!el.querySelector("svg,canvas,img,table");
    if (!hasContent) continue;
    var hasHiddenIfaceSub = false;
    if (el.getAttribute("data-shot-sub") === "hiddenIfaces") {
      var rows = el.querySelectorAll(".iface-child");
      for (var r = 0; r < rows.length; r++) {
        if (rows[r].style.display === "none") { hasHiddenIfaceSub = true; break; }
      }
    }
    out.push({
      key: el.getAttribute("data-shot-section"),
      label: el.getAttribute("data-shot-label") || el.getAttribute("data-shot-section"),
      el: el,
      chartKey: el.getAttribute("data-shot-chart") || null,
      hasHiddenIfaceSub: hasHiddenIfaceSub,
    });
  }
  return out;
}

// Current on-screen selection for a chart key — a range string ("1h"…"30d")
// or {from, to} for a custom window. Dispatches to each chart's existing
// getter so the options modal's range pickers default to what's displayed.
function _currentChartSelection(chartKey) {
  if (chartKey === "assetMonitor") return _currentMonitorSelection();
  if (chartKey === "assetSystem") return _currentSystemTabRange();
  if (chartKey === "assetSessions") return _currentSessionsRange();
  if (chartKey === "assetSdwan") {
    var btn = document.querySelector(".sdwan-range-btn.btn-primary");
    return (btn && btn.getAttribute("data-range")) || _getChartRangePref("assetSdwan", "24h");
  }
  return "24h";
}

// Range-swap + capture + restore orchestration behind the options modal's
// Capture button. `choices` is:
//   { exclude: [section wrapper els], hiddenIfaces: bool,
//     charts: [{ chartKey, desired }],    // desired = string range or {from,to}
//     output?: "pdf" }                    // omitted = copy PNG to clipboard
// Charts re-render at the desired range (their loaders cancel their own
// auto-refresh timers on entry), hidden interface rows are revealed for the
// capture only, and EVERYTHING is restored in the finally — the operator's
// on-screen ranges, row visibility, and range-button state end unchanged
// (buttons + _setChartRangePref are never touched at all).
var _screenshotBusy = false; // re-entrancy guard across the whole swap→capture→restore span
async function _captureWithChoices(asset, choices) {
  if (_screenshotBusy) return;
  _screenshotBusy = true;
  function setDisabled(v) {
    ["btn-asset-screenshot", "btn-asset-pdf"].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.disabled = v;
    });
  }
  setDisabled(true);
  try {
    await _captureWithChoicesInner(asset, choices);
  } finally {
    _screenshotBusy = false;
    setDisabled(false);
  }
}

async function _captureWithChoicesInner(asset, choices) {
  choices = choices || {};
  var charts = choices.charts || [];
  var priors = {};
  var i;

  async function loadChart(chartKey, selection) {
    if (chartKey === "assetMonitor") {
      await _loadMonitorHistoryFor(asset.id, selection, { silent: true });
    } else if (chartKey === "assetSystem") {
      await _loadSystemTabFor(asset.id, selection, asset, { chartOnly: !!_assetSystemSiCache, silent: true });
    } else if (chartKey === "assetSessions") {
      await _loadSessionsChartFor(asset.id, selection, asset, { silent: true });
    } else if (chartKey === "assetSdwan") {
      var st = _sdwanTabState;
      if (st && st.hcName) {
        await _loadPerfSlaForHealthCheck(asset.id, st.hcName, (st.linksByHc && st.linksByHc[st.hcName]) || [], selection);
      }
    }
  }

  // Swap each chart to the desired range. Sequential keeps the failure
  // story simple; these are sub-second history fetches.
  for (i = 0; i < charts.length; i++) {
    priors[charts[i].chartKey] = _currentChartSelection(charts[i].chartKey);
    await loadChart(charts[i].chartKey, charts[i].desired);
  }

  // Reveal hidden interface rows for the capture. Queried NOW (not at
  // modal-confirm) so an interfaces-table rebuild in between can't orphan
  // the row references.
  var revealed = [];
  var excl = new Set(choices.exclude || []);

  // A swapped chart's range buttons still highlight the operator's on-screen
  // selection (deliberately untouched), which would contradict the captured
  // window — drop the buttons (and any open custom-range panel) from the
  // image for swapped charts only.
  var CHART_UI = {
    assetMonitor:  { btnSel: ".asset-monitor-range-btn",  panelId: "asset-monitor-custom-panel" },
    assetSystem:   { btnSel: ".asset-system-range-btn",   panelId: "asset-system-custom-panel" },
    assetSessions: { btnSel: ".asset-sessions-range-btn", panelId: "asset-sessions-custom-panel" },
    assetSdwan:    { btnSel: ".sdwan-range-btn",          panelId: null },
  };
  charts.forEach(function (c) {
    var ui = CHART_UI[c.chartKey];
    if (!ui) return;
    document.querySelectorAll(ui.btnSel).forEach(function (b) { excl.add(b); });
    if (ui.panelId) {
      var p = document.getElementById(ui.panelId);
      if (p) excl.add(p);
    }
  });
  if (choices.hiddenIfaces) {
    var ifaceWrap = document.querySelector('#asset-view-tab-system [data-shot-section="interfaces"]');
    if (ifaceWrap && !excl.has(ifaceWrap)) {
      // Hidden interface rows are the children of a collapsed aggregate / port
      // (traffic-less rows are no longer hidden at all — the table filters
      // instead). Reveal them for the capture; restored in the finally.
      var rows = ifaceWrap.querySelectorAll(".iface-child");
      for (i = 0; i < rows.length; i++) {
        if (rows[i].style.display === "none") {
          revealed.push(rows[i]);
          rows[i].style.display = "";
        }
      }
    }
  }

  // html-to-image's filter only removes excluded nodes from the CLONE — the
  // live panel's computed height (frozen into the clone's inlined styles)
  // still includes them, so the capture keeps full height with blank gaps
  // where the sections were. Hide the exclusions in the live DOM instead so
  // the panel genuinely reflows before rasterization (_runScreenshotCapture's
  // settle delay absorbs the relayout); the filter stays on as a cheap
  // skip-clone for the same nodes. Prior inline display values are restored
  // in the finally.
  var hiddenForCapture = [];
  excl.forEach(function (el) {
    hiddenForCapture.push({ el: el, prev: el.style.display });
    el.style.display = "none";
  });

  try {
    await _runScreenshotCapture(asset, {
      filter: function (node) { return !(node && excl.has(node)); },
      output: choices.output,
    });
  } finally {
    for (i = 0; i < hiddenForCapture.length; i++) {
      hiddenForCapture[i].el.style.display = hiddenForCapture[i].prev;
    }
    for (i = 0; i < revealed.length; i++) revealed[i].style.display = "none";
    for (i = 0; i < charts.length; i++) {
      try {
        await loadChart(charts[i].chartKey, priors[charts[i].chartKey]);
      } catch (_) { /* one chart failing to restore shouldn't strand the rest */ }
    }
  }
}

// Screenshot options modal — the header Screenshot (camera) and PDF buttons
// both land here; `output` "pdf" retitles it and saves a PDF instead of
// copying a PNG. Lists
// the active tab's sections (from the data-shot-section wrappers) with
// include/exclude checkboxes, an "Include hidden interfaces" sub-option on
// the Interfaces section, and a time-range picker (1h/12h/24h/7d/30d/Custom)
// under each chart-bearing section defaulting to the chart's current
// on-screen selection. Checkbox + hidden-iface choices persist per user+tab
// (polaris-prefs-screenshot-<user>); ranges intentionally don't. Tabs with a
// single plain section (SNMP Walk, Stations) skip the modal entirely.
function _openScreenshotOptions(asset, output) {
  var isPdf = output === "pdf";
  var noun = isPdf ? "PDF export" : "Screenshot";
  var panel = _activeAssetPanel();
  if (!panel) { showToast("Nothing to " + (isPdf ? "export" : "screenshot"), "error"); return; }
  if (typeof htmlToImage === "undefined") {
    showToast(noun + " failed — capture library not loaded", "error");
    return;
  }
  if (_screenshotBusy) return;
  var sections = _collectShotSections(panel);
  var hasOptions = sections.some(function (s) { return s.chartKey || s.hasHiddenIfaceSub; });
  if (sections.length <= 1 && !hasOptions) {
    // Route through the orchestrator (no swaps/exclusions) for its
    // re-entrancy guard.
    _captureWithChoices(asset, { output: output });
    return;
  }

  var activeTabBtn = document.querySelector("#asset-view-tabs .page-tab.active");
  var tabKey = activeTabBtn ? (activeTabBtn.getAttribute("data-tab") || "tab") : "tab";
  var prefs = _getScreenshotPrefs()[tabKey] || {};
  var savedSections = prefs.sections || {};

  var RANGES = ["1h", "12h", "24h", "7d", "30d"];
  function rangeSelectHTML(s) {
    var cur = _currentChartSelection(s.chartKey);
    var isCustom = typeof cur !== "string";
    var opts = RANGES.map(function (r) {
      return '<option value="' + r + '"' + (!isCustom && cur === r ? " selected" : "") + '>' + r + '</option>';
    }).join("") + '<option value="custom"' + (isCustom ? " selected" : "") + '>Custom…</option>';
    var fromVal = isCustom ? _toLocalDatetimeInput(new Date(cur.from)) : "";
    var toVal   = isCustom ? _toLocalDatetimeInput(new Date(cur.to))   : "";
    return '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
      '<span style="font-size:0.8rem;color:var(--color-text-secondary)">Time range</span>' +
      '<select class="form-input shot-range" data-chart="' + s.chartKey + '" style="padding:2px 6px;font-size:0.82rem;width:auto">' + opts + '</select>' +
      '<span class="shot-custom-wrap" data-chart="' + s.chartKey + '" style="display:' + (isCustom ? "inline-flex" : "none") + ';align-items:center;gap:4px;font-size:0.8rem">' +
        'From <input type="datetime-local" class="form-input shot-from" data-chart="' + s.chartKey + '" value="' + fromVal + '" style="padding:2px 6px">' +
        'To <input type="datetime-local" class="form-input shot-to" data-chart="' + s.chartKey + '" value="' + toVal + '" style="padding:2px 6px">' +
      '</span>' +
    '</div>';
  }

  var rowsHtml = sections.map(function (s, idx) {
    var checked = savedSections[s.key] !== false;
    var subs = "";
    if (s.hasHiddenIfaceSub) {
      subs += '<label style="display:flex;align-items:center;gap:6px;font-size:0.85rem">' +
        '<input type="checkbox" id="shot-sub-hidden-ifaces"' + (prefs.includeHiddenIfaces === true ? " checked" : "") + '> Include hidden interfaces' +
      '</label>';
    }
    if (s.chartKey) subs += rangeSelectHTML(s);
    var subBlock = subs
      ? '<div class="shot-sub" data-idx="' + idx + '" style="margin:0.35rem 0 0 1.6rem;display:' + (checked ? "flex" : "none") + ';flex-direction:column;gap:0.35rem">' + subs + '</div>'
      : "";
    return '<div style="padding:0.45rem 0;border-bottom:1px solid var(--color-border)">' +
      '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
        '<input type="checkbox" class="shot-sec" data-key="' + escapeHtml(s.key) + '" data-idx="' + idx + '"' + (checked ? " checked" : "") + '>' +
        '<span style="font-weight:500">' + escapeHtml(s.label) + '</span>' +
      '</label>' +
      subBlock +
    '</div>';
  }).join("");

  var body =
    '<p style="margin:0 0 0.5rem;font-size:0.85rem;color:var(--color-text-secondary)">Choose which sections of this tab to include in the ' + (isPdf ? "PDF" : "screenshot") + '.</p>' +
    '<div id="shot-section-list">' + rowsHtml + '</div>';
  var footer =
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-shot-capture">' + (isPdf ? "Export PDF" : "Capture") + '</button>';
  openModal((isPdf ? "Export PDF" : "Screenshot") + " — " + _activeAssetTabLabel(), body, footer);

  var list = document.getElementById("shot-section-list");
  list.querySelectorAll(".shot-sec").forEach(function (cb) {
    cb.addEventListener("change", function () {
      var sub = list.querySelector('.shot-sub[data-idx="' + cb.getAttribute("data-idx") + '"]');
      if (sub) sub.style.display = cb.checked ? "flex" : "none";
    });
  });
  list.querySelectorAll(".shot-range").forEach(function (sel) {
    sel.addEventListener("change", function () {
      var wrap = list.querySelector('.shot-custom-wrap[data-chart="' + sel.getAttribute("data-chart") + '"]');
      if (wrap) wrap.style.display = sel.value === "custom" ? "inline-flex" : "none";
    });
  });

  document.getElementById("btn-shot-capture").addEventListener("click", async function () {
    var secState = {};
    var excludeEls = [];
    var anyChecked = false;
    list.querySelectorAll(".shot-sec").forEach(function (cb) {
      var idx = Number(cb.getAttribute("data-idx"));
      secState[sections[idx].key] = cb.checked;
      if (cb.checked) anyChecked = true;
      else excludeEls.push(sections[idx].el);
    });
    if (!anyChecked) { showToast("Select at least one section", "error"); return; }

    // Resolve each checked chart section's desired range; validate customs.
    var chartChoices = [];
    var invalid = false;
    sections.forEach(function (s) {
      if (!s.chartKey || secState[s.key] === false) return;
      var sel = list.querySelector('.shot-range[data-chart="' + s.chartKey + '"]');
      if (!sel) return;
      var desired;
      if (sel.value === "custom") {
        var fromEl = list.querySelector('.shot-from[data-chart="' + s.chartKey + '"]');
        var toEl   = list.querySelector('.shot-to[data-chart="' + s.chartKey + '"]');
        if (!fromEl.value || !toEl.value) { invalid = true; return; }
        var fromD = new Date(fromEl.value);
        var toD   = new Date(toEl.value);
        if (!(fromD < toD)) { invalid = true; return; }
        desired = { from: fromD.toISOString(), to: toD.toISOString() };
      } else {
        desired = sel.value;
      }
      // Skip charts already showing the desired window — no swap, no restore.
      var cur = _currentChartSelection(s.chartKey);
      var same = (typeof desired === "string")
        ? desired === cur
        : (typeof cur !== "string" && cur && cur.from === desired.from && cur.to === desired.to);
      if (!same) chartChoices.push({ chartKey: s.chartKey, desired: desired });
    });
    if (invalid) { showToast("Custom range needs valid From/To with From before To", "error"); return; }

    var hiddenIfaces = false;
    var hiddenCb = document.getElementById("shot-sub-hidden-ifaces");
    if (hiddenCb && hiddenCb.checked && secState.interfaces !== false) hiddenIfaces = true;

    _setScreenshotPrefs(tabKey, { sections: secState, includeHiddenIfaces: hiddenCb ? hiddenCb.checked : prefs.includeHiddenIfaces === true });
    closeModal();
    await _captureWithChoices(asset, { exclude: excludeEls, hiddenIfaces: hiddenIfaces, charts: chartChoices, output: output });
  });
}
