/**
 * public/js/assets-system.js — the System tab: system info, the current-state strip (cadence ·
 * freshness · Refresh), the interfaces table, storage pools and the storage
 * table, hardware sensors, LLDP neighbours, the wireless tree, and the
 * workload / hypervisor sections.
 *
 * Part of the Assets page script (CQ-F050): plain browser scripts sharing
 * page globals, loaded right after assets.js on every page that carries it
 * and in app-panels.js's asset bundle, in ASSETS_FILES order. Nothing here
 * runs at load beyond listener wiring. See tests/unit/assetsSplit.test.ts.
 */

// ─── System tab (system info section) ──────────────────────────────────────
//
// Renders the CPU/memory chart, temperatures, interfaces (with IPsec tunnels
// nested under the FortiOS phase1-interface they're bound to), and storage.
// Telemetry is collected every ~60s, system info every ~10min, so
// these are sparse compared to the response-time chart that sits above it
// (rendered by assetMonitoringViewHTML). ICMP/SSH-monitored assets render an
// empty-state message because those probes can't deliver this data.
//
// Callers (openViewModal) only invoke this function when the asset is
// monitored — the not-monitored case is handled by the monitoring section
// above. The early-return below is defensive.

// Whether the CPU & Memory section renders as TWO charts or one.
//
// The split is a consequence of what the SOURCE reports, never of what the
// asset is. Two transports carry the two things that cannot share one
// 0-100% axis — per-core CPU (as many lines as the entity has cores) and a
// memory COMPOSITION in bytes:
//
//   agent   — the host's own logical cores, and buffers / cache / free as
//             the OS accounts for them.
//   vcenter — a VM's vCPUs or an ESXi host's physical cores from the
//             PerformanceManager, and vSphere's own memory bands.
//   unraid / truenas — the HOST only: Unraid's metrics.cpu.cpus and
//             TrueNAS's reporting.realtime carry every core; memory is used +
//             total bytes, which the memory chart draws as its one band. Their
//             VMs and containers report a single CPU figure (or none), so those
//             keep the combined chart.
//
// FortiOS REST, SNMP, WinRM and SSH report one CPU figure and one memory
// figure per sample, and two of those on two stacked 200px charts is the
// pre-2026-09 combined chart with twice the height and half the
// comparability. They keep the combined chart.
//
// Resolved, not read off the column: `cpuMemoryPolling` is stamped "agent"
// at enrollment (agentTokenService / the agents route) and defaults to
// "vcenter" on a vCenter-discovered asset, but a class or integration tier
// can carry either method too, and _resolvedStreamPolling is the same walk
// the section badge and the stale banner use.
var _SPLIT_CHART_METHODS = ["agent", "vcenter"];
// proxmox — a NODE: no per-core figures (the API publishes none, so the CPU
// chart draws its aggregate line alone), but memory splits used / ZFS ARC /
// free, which only the split memory chart can draw.
var _SPLIT_CHART_HOST_METHODS = ["unraid", "truenas", "proxmox"];

function _telemetrySplitsCpuMemory(a) {
  var method = _resolvedStreamPolling(a, "telemetry");
  if (_SPLIT_CHART_METHODS.indexOf(method) >= 0) return true;
  return _SPLIT_CHART_HOST_METHODS.indexOf(method) >= 0 &&
    !!(a && a.virtualization && a.virtualization.role === "host");
}

// A heavy stream's header stamp (business rule 118). Healthy: "updated X ago"
// off the last SUCCESS. Failing: amber "⚠ last poll failed X ago", the message
// and the last success in the tooltip — the stamp used to read the last
// ATTEMPT, so a device whose REST pull failed every time looked current.
function _streamPollStampHTML(okAt, attemptAt, failingSince, lastError) {
  if (failingSince && attemptAt) {
    var tip = "Failing since " + formatDateTime(failingSince) +
      "\nLast successful poll: " + (okAt ? formatDateTime(okAt) : "never") +
      (lastError ? "\nError: " + lastError : "");
    return '<span style="font-size:0.72rem;color:var(--color-warning);font-weight:600" title="' + escapeHtml(tip) + '">' +
      '&#9888; last poll failed ' + timeAgo(attemptAt) + '</span>';
  }
  if (!okAt) return "";
  return '<span style="font-size:0.72rem;color:var(--color-text-tertiary)" title="' + escapeHtml(formatDateTime(okAt)) + '">updated ' + timeAgo(okAt) + '</span>';
}

function assetSystemViewHTML(a) {
  if (!a) return '<p class="empty-state">No data.</p>';
  if (!a.monitored) {
    return '<div style="padding:1rem 0;color:var(--color-text-secondary)">' +
      'Enable monitoring on this asset (Edit → Monitoring tab) to start collecting CPU/memory and interface data.' +
    '</div>';
  }
  // Heavy-cadence streams (telemetry / interfaces / storage) are only
  // delivered when the resolved interfacesPolling is one of
  // _SYSTEM_TAB_IFACE_METHODS. ICMP / SSH / WinRM don't carry the data shapes
  // this tab renders yet.
  // Resolved, not guessed: the per-asset column is null on almost every asset,
  // and hand-rolling the source default here meant an integration- or
  // class-tier method never reached this gate. Same value the section badges
  // and stale banners resolve.
  var ifPolling = _resolvedStreamPolling(a, "interfaces");
  if (_SYSTEM_TAB_IFACE_METHODS.indexOf(ifPolling) === -1) {
    return '<div style="padding:1rem 0;color:var(--color-text-secondary)">' +
      "System metrics (CPU / memory / interfaces / storage) require REST API, SNMP, vCenter, or Polaris Agent on the Interfaces stream. Install the Polaris Agent (Edit → Monitoring) or switch the polling method to enable." +
    '</div>';
  }
  var rangeBtns =
    _chartRangeBtnsHTML("asset-system-range-btn", [
      { value: "1h",  label: "1h" },
      { value: "12h", label: "12h" },
      { value: "24h", label: "24h" },
      { value: "7d",  label: "7d" },
      { value: "30d", label: "30d" },
      { value: "custom", label: "Custom…", id: "btn-asset-system-custom" },
    ], "assetSystem", "1h");
  // CPU/Memory and Temperatures dispatch on their own streams now — operators
  // can run CPU/mem over REST while temperature scrapes over SNMP (the
  // branch-class FortiGate workaround). Each section gets its own badge so
  // the per-stream polling method, credential, MIB, and cadence are visible
  // at a glance. Interfaces and Storage share the Interfaces stream. LLDP is
  // its own stream (per-integration/class/asset REST or SNMP) so it also
  // gets its own badge.
  var telemetryBadge   = _streamSourceBadgeHTML(a, "telemetry");
  var temperatureBadge = _streamSourceBadgeHTML(a, "temperature");
  var interfacesBadge  = _streamSourceBadgeHTML(a, "interfaces");
  var lldpBadge        = _streamSourceBadgeHTML(a, "lldp");
  var telUpdatedAt = a.lastTelemetryAt
    ? ('<span style="font-size:0.72rem;color:var(--color-text-tertiary)" title="' + escapeHtml(formatDateTime(a.lastTelemetryAt)) + '">updated ' + timeAgo(a.lastTelemetryAt) + '</span>')
    : '';
  // CPU & Memory and Interfaces say a FAILED poll out loud (business rule 118)
  // — "updated X ago" is the last success, and a failing stream reads as the
  // failure instead. Temperatures keeps the plain stamp: it tracks no run.
  var telPollStamp     = _streamPollStampHTML(a.lastTelemetryAt,  a.lastTelemetryAttemptAt,  a.telemetryFailingSince,  a.telemetryLastError);
  var sysInfoPollStamp = _streamPollStampHTML(a.lastSystemInfoAt, a.lastSystemInfoAttemptAt, a.systemInfoFailingSince, a.systemInfoLastError);
  var telemetryBadgeFull  = telemetryBadge  + (telemetryBadge  && telPollStamp     ? " " : "") + telPollStamp;
  var interfacesBadgeFull = interfacesBadge + (interfacesBadge && sysInfoPollStamp ? " " : "") + sysInfoPollStamp;
  var lldpBadgeFull       = lldpBadge       + (lldpBadge       && sysInfoPollStamp ? " " : "") + sysInfoPollStamp;
  // Temperatures uses its own table-specific timestamp (si.lastTemperatureAt)
  // which can diverge from lastTelemetryAt when the CPU/memory pull succeeds
  // but the sensor pull fails. The header's updated stamp lives in an id'd
  // slot so _renderTemperatures can rewrite it from si data once loaded and
  // flip it amber + "last successful update X ago" when the temp data is
  // stale relative to the resolved cadence. Initial value mirrors telemetry
  // so the placeholder isn't blank during the first paint.
  var temperatureBadgeFull = temperatureBadge + (temperatureBadge ? " " : "") +
    '<span id="asset-system-temps-updated">' + telUpdatedAt + '</span>';
  function sectionHeader(title, badgeHTML, rangeBtnsHTML) {
    return '<div style="display:flex;align-items:center;justify-content:space-between;margin:1.25rem 0 0.5rem">' +
      '<div style="display:flex;align-items:baseline;gap:0.5rem;flex-wrap:wrap">' +
        '<h4 style="margin:0">' + title + '</h4>' +
        (badgeHTML || '') +
      '</div>' +
      (rangeBtnsHTML ? ('<div style="display:flex;gap:6px">' + rangeBtnsHTML + '</div>') : '') +
    '</div>';
  }
  var splitCharts = _telemetrySplitsCpuMemory(a);
  var isWorkloadContainer = a.assetType === "container";
  var sessionsRangeBtns = a.assetType === "firewall"
    ? _chartRangeBtnsHTML("asset-sessions-range-btn", [
        { value: "1h",  label: "1h" },
        { value: "12h", label: "12h" },
        { value: "24h", label: "24h" },
        { value: "7d",  label: "7d" },
        { value: "30d", label: "30d" },
        { value: "custom", label: "Custom…", id: "btn-asset-sessions-custom" },
      ], "assetSessions", "1h")
    : "";
  return (
    '<div data-shot-section="cpuMemory" data-shot-label="CPU &amp; Memory" data-shot-chart="assetSystem">' +
    sectionHeader("CPU &amp; Memory", telemetryBadgeFull, rangeBtns) +
    '<div id="asset-system-custom-panel" style="display:none;align-items:center;gap:6px;margin:0.5rem 0;padding:0.5rem;background:var(--color-bg-primary);border:1px solid var(--color-border);border-radius:6px;font-size:0.85rem">' +
      '<label style="display:flex;align-items:center;gap:4px">From <input type="datetime-local" id="asset-system-from" class="form-input" style="padding:2px 6px"></label>' +
      '<label style="display:flex;align-items:center;gap:4px">To <input type="datetime-local" id="asset-system-to" class="form-input" style="padding:2px 6px"></label>' +
      '<button class="btn btn-sm btn-primary" id="btn-asset-system-custom-apply">Apply</button>' +
    '</div>' +
    // ONE chart or TWO, decided by _telemetrySplitsCpuMemory. The split
    // exists for the two things only the agent and vCenter send — per-core
    // CPU and a memory breakdown in BYTES — and neither survives a source
    // that reports a pair of percentages. On a FortiGate or an SNMP switch
    // the two charts would be a single line each, stacked, on a tab that is
    // already long: one shared 0-100% axis says the same thing in half the
    // height.
    //
    // Split: CPU is a percentage and memory is a byte stack, so they cannot
    // share an axis; they DO share a window, because they are two readings of
    // one sample row and putting them on different ranges would only invite
    // comparing them wrongly. Each chart owns its own stats line, per the
    // chart canon.
    (splitCharts
      ? '<div style="font-size:0.78rem;font-weight:600;color:var(--color-text-secondary);margin-bottom:0.15rem">CPU</div>' +
        '<div id="asset-cpu-summary" style="display:flex;gap:1.25rem;flex-wrap:wrap;font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">' +
          '<span>Loading…</span>' +
        '</div>' +
        '<div id="asset-cpu-chart" class="chart-box" style="min-height:200px;display:flex;align-items:center;justify-content:center;color:var(--color-text-secondary);font-size:0.85rem">' +
          'Loading samples…' +
        '</div>' +
        '<div style="font-size:0.78rem;font-weight:600;color:var(--color-text-secondary);margin:0.75rem 0 0.15rem">Memory</div>' +
        // Forecast headline + toggle (_renderMemForecastBar). Hidden until a
        // forecast with any history has loaded.
        '<div id="asset-mem-forecast" style="display:none;align-items:center;justify-content:space-between;gap:0.75rem;flex-wrap:wrap;margin-bottom:0.35rem;font-size:0.85rem"></div>' +
        '<div id="asset-mem-summary" style="display:flex;gap:1.25rem;flex-wrap:wrap;font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">' +
          '<span>Loading…</span>' +
        '</div>' +
        '<div id="asset-memory-chart" class="chart-box" style="min-height:200px;display:flex;align-items:center;justify-content:center;color:var(--color-text-secondary);font-size:0.85rem">' +
          'Loading samples…' +
        '</div>'
      // Combined: no sub-heading above the chart — the section header already
      // reads "CPU & Memory" and the SVG carries its own two-key legend.
      : '<div id="asset-mem-forecast" style="display:none;align-items:center;justify-content:space-between;gap:0.75rem;flex-wrap:wrap;margin-bottom:0.35rem;font-size:0.85rem"></div>' +
        '<div id="asset-system-summary" style="display:flex;gap:1.25rem;flex-wrap:wrap;font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">' +
          '<span>Loading…</span>' +
        '</div>' +
        '<div id="asset-system-chart" class="chart-box" style="min-height:200px;display:flex;align-items:center;justify-content:center;color:var(--color-text-secondary);font-size:0.85rem">' +
          'Loading samples…' +
        '</div>') +
    '</div>' +
    // Active Sessions chart — FortiGate firewalls only. Starts hidden;
    // _renderSessionsChart reveals it once the telemetry history carries
    // sessionCount data (and hides it for assets that never report it).
    // Carries its OWN range selector (pref key "assetSessions"): the chart
    // reads the same telemetry-history endpoint as CPU & Memory, but its
    // window is selected independently — _loadSystemTabFor reuses the CPU
    // & Memory payload only when the two selections happen to match.
    (a.assetType === "firewall"
      ? '<div id="asset-system-sessions-section" data-shot-section="sessions" data-shot-label="Active Sessions" data-shot-chart="assetSessions" style="display:none">' +
          sectionHeader("Active Sessions", telemetryBadgeFull, sessionsRangeBtns) +
          '<div id="asset-sessions-custom-panel" style="display:none;align-items:center;gap:6px;margin:0.5rem 0;padding:0.5rem;background:var(--color-bg-primary);border:1px solid var(--color-border);border-radius:6px;font-size:0.85rem">' +
            '<label style="display:flex;align-items:center;gap:4px">From <input type="datetime-local" id="asset-sessions-from" class="form-input" style="padding:2px 6px"></label>' +
            '<label style="display:flex;align-items:center;gap:4px">To <input type="datetime-local" id="asset-sessions-to" class="form-input" style="padding:2px 6px"></label>' +
            '<button class="btn btn-sm btn-primary" id="btn-asset-sessions-custom-apply">Apply</button>' +
          '</div>' +
          '<div id="asset-system-sessions-chart" class="chart-box" style="min-height:200px;display:flex;align-items:center;justify-content:center;color:var(--color-text-secondary);font-size:0.85rem">' +
            'Loading samples…' +
          '</div>' +
        '</div>'
      : '') +
    // A container / App has no hardware, disks or LLDP of its own — they are
    // its host's — so those sections are not drawn at all (their loaders
    // find no mount and return).
    (isWorkloadContainer ? '' :
    '<div data-shot-section="sensors" data-shot-label="Hardware Sensors">' +
    sectionHeader("Hardware Sensors", temperatureBadgeFull, false) +
    '<div id="asset-system-temps"><span class="empty-state">Loading…</span></div>' +
    '</div>') +
    '<div data-shot-section="interfaces" data-shot-label="Interfaces" data-shot-sub="hiddenIfaces">' +
    sectionHeader("Interfaces", interfacesBadgeFull, false) +
    '<div id="asset-system-interfaces"><span class="empty-state">Loading…</span></div>' +
    '</div>' +
    // Storage is always EMITTED; whether it can carry data is decided by
    // _renderStorageTable from the RESOLVED polling methods
    // (_storageStreamDelivers), and re-decided by
    // _updateStaleBannersFromEffective once the effective-settings walk lands.
    // This section used to be dropped from the DOM whenever the interfaces
    // stream looked like REST API, judged from the per-asset interfacesPolling
    // column alone — null on almost every asset, in which case it GUESSED
    // rest_api for anything an FMG or FortiGate discovered. That was wrong on a
    // FortiSwitch two ways: an integration- or class-tier SNMP override (the
    // documented way to enable direct switch polling) still read as REST and
    // hid the section, and switching the Storage stream itself to SNMP
    // collected samples into a table with nowhere to render.
    (isWorkloadContainer ? '' :
    '<div data-shot-section="storage" data-shot-label="Storage">' +
    sectionHeader("Storage", interfacesBadgeFull, false) +
    '<div id="asset-system-storage"><span class="empty-state">Loading…</span></div>' +
    '</div>' +
    '<div data-shot-section="lldp" data-shot-label="LLDP Neighbors">' +
    sectionHeader("LLDP Neighbors", lldpBadgeFull, false) +
    '<div id="asset-system-lldp"><span class="empty-state">Loading…</span></div>' +
    '</div>') +
    // Hidden until the device actually reports FRUs — most hosts publish no
    // entPhysicalTable at all, and an empty "Modules" header on every server
    // would be pure noise.
    '<div id="asset-system-modules-section" data-shot-section="modules" data-shot-label="Hardware Modules" style="display:none">' +
    sectionHeader("Hardware Modules", "", false) +
    '<div id="asset-system-modules"><span class="empty-state">Loading…</span></div>' +
    '</div>'
  );
}

// Field-replaceable hardware (transceivers, PSUs, fan trays) from ENTITY-MIB.
// Vendor / model / serial are what an operator needs to raise an RMA or find
// the spare on the shelf, which is why they are the columns.
function _renderPhysicalEntities(entities) {
  var section = document.getElementById("asset-system-modules-section");
  var host = document.getElementById("asset-system-modules");
  if (!section || !host) return;
  var rows = Array.isArray(entities) ? entities : [];
  if (rows.length === 0) { section.style.display = "none"; return; }
  section.style.display = "";

  var CLASS_LABEL = { module: "Module", powerSupply: "Power Supply", fan: "Fan",
                      chassis: "Chassis", container: "Container", port: "Port" };
  host.innerHTML =
    '<div class="table-wrapper"><table class="data-table" style="font-size:0.82rem"><thead><tr>' +
      '<th>Type</th><th>Name</th><th>Vendor</th><th>Model</th><th>Serial</th><th>HW Rev</th>' +
    '</tr></thead><tbody>' +
    rows.map(function (e) {
      var dash = '<span style="color:var(--color-text-secondary)">—</span>';
      return '<tr>' +
        '<td>' + escapeHtml(CLASS_LABEL[e.entClass] || e.entClass) + '</td>' +
        '<td>' + escapeHtml(e.name || e.descr || ("index " + e.entIndex)) + '</td>' +
        '<td>' + (e.mfgName ? escapeHtml(e.mfgName) : dash) + '</td>' +
        '<td class="mono">' + (e.modelName ? escapeHtml(e.modelName) : dash) + '</td>' +
        '<td class="mono">' + (e.serialNum ? escapeHtml(e.serialNum) : dash) + '</td>' +
        '<td class="mono">' + (e.hardwareRev ? escapeHtml(e.hardwareRev) : dash) + '</td>' +
      '</tr>';
    }).join("") +
    '</tbody></table></div>';
}

function _currentSystemTabRange() {
  // Split section: the CPU container is the canonical carrier of the shared
  // selection — both it and the memory container are stamped, and either
  // would do. Combined section: there is only the one container.
  var chart = document.getElementById("asset-cpu-chart") || document.getElementById("asset-system-chart");
  if (!chart) return "24h";
  if (chart.dataset.from && chart.dataset.to) {
    return { from: chart.dataset.from, to: chart.dataset.to };
  }
  return chart.dataset.range || "24h";
}

// Active Sessions keeps its own window (pref key "assetSessions"), stamped
// on its own container — before the chart's first load the stored pref is
// the selection the range buttons already highlight.
function _currentSessionsRange() {
  var chart = document.getElementById("asset-system-sessions-chart");
  if (chart) {
    if (chart.dataset.from && chart.dataset.to) {
      return { from: chart.dataset.from, to: chart.dataset.to };
    }
    if (chart.dataset.range) return chart.dataset.range;
  }
  return _getChartRangePref("assetSessions", "1h");
}

// Loads + renders the Active Sessions chart on its own window. The chart
// reads the same telemetry-history rows as CPU & Memory, so a caller that
// already holds a payload for the SAME window passes it via opts.tel and
// skips the duplicate fetch (the common case — both selectors default to
// the same range).
async function _loadSessionsChartFor(assetId, range, asset, opts) {
  var container = document.getElementById("asset-system-sessions-chart");
  if (!container) return;
  var silent = !!(opts && opts.silent);
  var telOpts = (typeof range === "string" || !range) ? { range: range || "1h" } : range;
  if (telOpts.from && telOpts.to) {
    container.dataset.from = telOpts.from;
    container.dataset.to = telOpts.to;
    delete container.dataset.range;
  } else {
    container.dataset.range = telOpts.range || "1h";
    delete container.dataset.from;
    delete container.dataset.to;
  }
  if (!silent && !(opts && opts.tel)) container.textContent = "Loading samples…";
  try {
    var tel = (opts && opts.tel) || await api.assets.telemetryHistory(assetId, telOpts);
    _renderSessionsChart(container, tel, asset);
  } catch (err) {
    if (!silent) container.textContent = "Error: " + (err.message || "failed to load");
  }
}

async function _loadSystemTabFor(assetId, range, asset, opts) {
  // Cancel any pending auto-refresh — a manual range change, probe-now, or
  // re-render shouldn't race a scheduled tick.
  if (_assetSystemRefreshTimer) { clearTimeout(_assetSystemRefreshTimer); _assetSystemRefreshTimer = null; }
  var silent = !!(opts && opts.silent);
  // chartOnly: range-button click on the CPU & Memory chart. The other
  // sections (interfaces, storage, temperatures, LLDP, stations) are
  // current-state and don't depend on `range`, so we skip the systemInfo
  // re-fetch + their re-render and reuse the cached si for the chart's
  // stale banner and the latest-reading rows.
  var chartOnly = !!(opts && opts.chartOnly) && _assetSystemSiCache;
  // Two DOM shapes, decided at render time by _telemetrySplitsCpuMemory: a
  // CPU container beside a memory one, or the single combined container. The
  // loader reads whichever is mounted rather than re-deriving the gate — the
  // markup is the one authority, and an asset whose polling method changes
  // under an open panel would otherwise render into containers that are gone.
  var combined = document.getElementById("asset-system-chart");
  var chart   = combined || document.getElementById("asset-cpu-chart");
  var memChart = combined ? null : document.getElementById("asset-memory-chart");
  var summary = combined
    ? document.getElementById("asset-system-summary")
    : document.getElementById("asset-cpu-summary");
  var memSummary = combined ? null : document.getElementById("asset-mem-summary");
  var ifaces  = document.getElementById("asset-system-interfaces");
  var storage = document.getElementById("asset-system-storage");
  var temps   = document.getElementById("asset-system-temps");
  var lldp    = document.getElementById("asset-system-lldp");
  var stations = document.getElementById("asset-system-stations"); // FortiAP-only mount inside the Stations tab
  if (!chart) return;
  // Accept a range string ("24h") or a { from, to } object for custom windows.
  var telOpts = (typeof range === "string" || !range) ? { range: range || "24h" } : range;
  // The sessions chart keeps its OWN selection (stamped by
  // _loadSessionsChartFor) — only the CPU & Memory container is stamped here.
  [chart, memChart].forEach(function (el) {
    if (!el) return;
    if (telOpts.from && telOpts.to) {
      el.dataset.from = telOpts.from;
      el.dataset.to = telOpts.to;
      delete el.dataset.range;
    } else {
      el.dataset.range = telOpts.range || "24h";
      delete el.dataset.from;
      delete el.dataset.to;
    }
  });
  if (!silent) {
    chart.textContent = "Loading samples…";
    if (memChart) memChart.textContent = "Loading samples…";
    if (!chartOnly) {
      if (summary) summary.innerHTML = "<span>Loading…</span>";
      if (memSummary) memSummary.innerHTML = "<span>Loading…</span>";
      if (ifaces)  ifaces.innerHTML  = '<span class="empty-state">Loading…</span>';
      if (storage) storage.innerHTML = '<span class="empty-state">Loading…</span>';
      if (temps)   temps.innerHTML   = '<span class="empty-state">Loading…</span>';
      if (lldp)    lldp.innerHTML    = '<span class="empty-state">Loading…</span>';
    }
  }

  var panelBody = silent ? document.getElementById("asset-panel-body") : null;
  var savedScroll = panelBody ? panelBody.scrollTop : 0;

  // The memory forecast is fitted on 30 days of daily points, independent of
  // the selected range, so it rides alongside rather than inside the history
  // fetch — refetched on a full load, served from cache on range clicks and
  // the silent refresh. Never throws; a failed load just draws no overlay.
  var memForecastPromise = _loadMemoryForecastFor(assetId, !silent && !chartOnly);

  try {
    var tel, si;
    if (chartOnly) {
      tel = await api.assets.telemetryHistory(assetId, telOpts);
      si  = _assetSystemSiCache;
    } else {
      var results = await Promise.all([
        api.assets.telemetryHistory(assetId, telOpts),
        api.assets.systemInfo(assetId),
      ]);
      tel = results[0];
      si  = results[1];
      _assetSystemSiCache = si;
    }
    await memForecastPromise;
    _memForecastLastRender = { assetId: assetId, tel: tel, asset: asset, si: si };

    if (combined) {
      _renderSystemChart(chart, tel, asset, si);
    } else {
      _renderCpuChart(chart, tel, asset, si);
      if (memChart) _renderMemoryChart(memChart, tel, asset, si);
    }
    _renderMemForecastBar(assetId, !!combined);
    var sessionsChart = document.getElementById("asset-system-sessions-chart");
    if (sessionsChart) {
      var sessionsSel = _currentSessionsRange();
      var sameWindow = (typeof sessionsSel === "string")
        ? (!telOpts.from && (telOpts.range || "24h") === sessionsSel)
        : (!!telOpts.from && telOpts.from === sessionsSel.from && telOpts.to === sessionsSel.to);
      // A custom sessions window is a fixed historical slice — skip it on
      // silent auto-refresh ticks rather than refetching unchanging data.
      if (!(silent && typeof sessionsSel !== "string" && !sameWindow)) {
        await _loadSessionsChartFor(assetId, sessionsSel, asset, { tel: sameWindow ? tel : null, silent: silent });
      }
    }
    if (combined) {
      _renderSystemSummary(summary, tel);
    } else {
      _renderCpuSummary(summary, tel);
      _renderMemorySummary(memSummary, tel);
    }
    if (!chartOnly) {
      _renderInterfacesTable(ifaces, si, asset);
      _renderStorageTable(storage, si, asset);
      _renderTemperatures(temps, si, asset);
      _renderLldpNeighborsCard(lldp, si, asset);
      _renderPhysicalEntities(si && si.physicalEntities);
      if (stations) _renderWirelessStationsCard(stations, si, asset);
    }
  } catch (err) {
    if (!silent) {
      chart.textContent = "Error: " + (err.message || "failed to load");
      if (memChart) memChart.textContent = "Error: " + (err.message || "failed to load");
      if (!chartOnly) {
        if (summary) summary.innerHTML = "";
        if (memSummary) memSummary.innerHTML = "";
        if (ifaces)  ifaces.innerHTML  = '<p class="empty-state">' + escapeHtml(err.message || "failed to load") + '</p>';
        if (storage) storage.innerHTML = '<p class="empty-state">' + escapeHtml(err.message || "failed to load") + '</p>';
        if (temps)   temps.innerHTML   = '<p class="empty-state">' + escapeHtml(err.message || "failed to load") + '</p>';
        if (lldp)    lldp.innerHTML    = '<p class="empty-state">' + escapeHtml(err.message || "failed to load") + '</p>';
      }
    }
    // On silent-refresh failure leave the stale content alone so the user
    // doesn't see a transient blip blow away the panel they were reading.
  }
  if (panelBody) {
    panelBody.scrollTop = savedScroll;
    requestAnimationFrame(function () {
      if (panelBody.scrollTop !== savedScroll) panelBody.scrollTop = savedScroll;
    });
  }
  // Custom date ranges are fixed historical windows — do not auto-refresh.
  if (telOpts.from && telOpts.to) return;
  // Schedule next auto-refresh on the telemetry cadence (the fastest of the
  // three System-tab streams). Keep going on error so a transient blip doesn't
  // disable the chain.
  var settings = _monitorSettingsCache || {};
  var refAsset = asset || _currentAssetForRefresh;
  var ms = _refreshIntervalMs(refAsset && refAsset.cpuMemoryIntervalSec, settings.cpuMemoryIntervalSeconds, 60);
  _scheduleAssetSystemRefresh(assetId, refAsset, ms);
}

// Renders the COMBINED chart's window summary — the shape a non-agent asset
// gets, where CPU and memory are two readings on one chart and so share one
// stats line. The container below the chart gets the canonical
// "<count> samples · <Label>: <value> · ..." shape via _renderChartStats.
// The split section's per-chart counterparts are _renderCpuSummary /
// _renderMemorySummary below.
function _renderSystemSummary(container, tel) {
  if (!container) return;
  if (!tel || !tel.stats || !tel.stats.total) {
    container.textContent = "No telemetry samples in this range yet.";
    delete container.dataset.summary;
    return;
  }
  var s = tel.stats;
  var telParts = [
    { label: "CPU avg", value: s.avgCpuPct != null ? s.avgCpuPct.toFixed(1) + "%" : "—" },
    { label: "CPU max", value: s.maxCpuPct != null ? s.maxCpuPct.toFixed(1) + "%" : "—" },
    { label: "Mem avg", value: s.avgMemPct != null ? s.avgMemPct.toFixed(1) + "%" : "—" },
    { label: "Mem max", value: s.maxMemPct != null ? s.maxMemPct.toFixed(1) + "%" : "—" },
  ];
  var telTierPart = _tierStatsPart(tel);
  if (telTierPart) telParts.unshift(telTierPart);
  _renderChartStats(container, s.total, telParts);
}

// Window summaries for the two telemetry charts. Each chart owns its own
// stats line (chart canon) — they used to share one, which since the split
// would have parked CPU's figures under the memory chart.
//
// The tier part rides the CPU line only: it describes the PAYLOAD, not
// either metric, and printing it twice reads as two different tiers.
function _renderCpuSummary(container, tel) {
  if (!container) return;
  if (!tel || !tel.stats || !tel.stats.total) {
    container.textContent = "No telemetry samples in this range yet.";
    delete container.dataset.summary;
    return;
  }
  var s = tel.stats;
  var parts = [
    { label: "CPU avg", value: s.avgCpuPct != null ? s.avgCpuPct.toFixed(1) + "%" : "—" },
    { label: "CPU max", value: s.maxCpuPct != null ? s.maxCpuPct.toFixed(1) + "%" : "—" },
  ];
  var cores = _telemetryCoreCount(tel);
  if (cores) parts.push({ label: "Cores", value: String(cores) });
  var tierPart = _tierStatsPart(tel);
  if (tierPart) parts.unshift(tierPart);
  _renderChartStats(container, s.total, parts);
}

function _renderMemorySummary(container, tel) {
  if (!container) return;
  if (!tel || !tel.stats || !tel.stats.total) {
    container.textContent = "No telemetry samples in this range yet.";
    delete container.dataset.summary;
    return;
  }
  var s = tel.stats;
  var parts = [
    { label: "Mem avg", value: s.avgMemPct != null ? s.avgMemPct.toFixed(1) + "%" : "—" },
    { label: "Mem max", value: s.maxMemPct != null ? s.maxMemPct.toFixed(1) + "%" : "—" },
  ];
  // Installed size, from the newest sample that carries one. A figure worth
  // having next to a byte-scaled chart, and the axis ceiling's provenance.
  var samples = (tel && tel.samples) || [];
  for (var i = samples.length - 1; i >= 0; i--) {
    if (typeof samples[i].memTotalBytes === "number") {
      parts.push({ label: "Installed", value: _fmtBytes(samples[i].memTotalBytes) });
      break;
    }
  }
  _renderChartStats(container, s.total, parts);
}

// Widest per-core vector in the window (0 when the source reports none).
function _telemetryCoreCount(tel) {
  var n = 0;
  ((tel && tel.samples) || []).forEach(function (s) {
    if (Array.isArray(s.cpuCorePcts) && s.cpuCorePcts.length > n) n = s.cpuCorePcts.length;
  });
  return n;
}

// Returns true when the asset is a managed FortiSwitch or FortiAP whose
// resolved polling method *for the given stream* is REST API. These devices
// aren't directly REST-able — the relevant endpoints live on the parent
// FortiGate, not on the device's own IP — so REST API delivers no telemetry,
// no temperature, no LLDP, and no interface-refresh data for them. Each
// stream has its own polling-method override, so a FortiAP on SNMP for
// temperature must not trip the "not available via REST API" banner just
// because its interfaces stream is still REST.
// Resolves the polling method actually in effect for a stream, preferring the
// cached /effective-monitor-settings walk (which covers the class + integration
// tiers) over the per-asset override, then the source default. Mirrors the
// precedence in _resolveStaleStreamSec so the "not available via REST API"
// empty-state banners agree with the resolved-polling chip. Re-deriving from
// the asset-level *Polling field alone ignored an integration-tier SNMP
// override and produced a bogus "switch to SNMP" nag on FortiGates that were
// already polling temperature via SNMP. Returns null when no method resolves.
function _resolvedStreamPolling(asset, stream) {
  if (!asset) return null;
  var field = _streamFieldPrefix(stream || "interfaces") + "Polling";
  var eff = asset.id ? _effectiveResolvedByAssetId.get(asset.id) : null;
  if (eff && eff[field]) return eff[field];
  if (asset[field]) return asset[field];
  var sk = (asset.discoveredByIntegration && asset.discoveredByIntegration.type) || "manual";
  if (!_POLLING_COMPAT[sk]) sk = "manual";
  return _polarisSourceDefaultPolling(sk, stream || "interfaces");
}

// Methods that actually put storage rows on an asset.
//
// `storagePolling` is the SOLE authority server-side, and deliberately so: the
// interfaces walk produces storage rows as a side effect, and every path drops
// them unless the storage stream itself asked for that transport
// (`data.storage = []` in the SNMP and vCenter system-info branches,
// `wantStorage` on the ssh/winrm branch, the method check at the top of
// runStorageFor). So enabling SNMP on the Interfaces stream alone collects
// nothing — a real trap, since it is the setting that reveals every OTHER
// section of this tab. Two transports reach the rows once storage does ask:
// the dedicated storage cadence (runStorageFor — SNMP walks hrStorageTable with
// the vendor disk-scalar pair as fallback, ssh reads `df`, winrm reads
// Get-Volume) and the heavy system-info pass (the same SNMP walk, the agent's
// own push, or the vCenter warm cache's guest filesystems / host datastores).
var _STORAGE_DELIVERING_METHODS = ["snmp", "ssh", "winrm", "agent", "vcenter", "unraid", "truenas", "proxmox", "genericapi"];

// Interfaces-stream methods that deliver ANY heavy-cadence system data, and so
// gate the System tab as a whole. `vcenter` belongs here since the 2026-08
// four-stream cutover — a VM's vNICs and an ESXi host's pNICs / VMkernel ports
// / vSwitches come out of the warm vCenter cache and render in the interface
// table like any other inventory (see the Virtualization section's own note).
// It was missing, so a vCenter-monitored asset was told to switch to a
// transport it doesn't use in order to see data it was already collecting.
var _SYSTEM_TAB_IFACE_METHODS = ["rest_api", "snmp", "agent", "vcenter", "unraid", "truenas", "proxmox", "genericapi"];

function _storageStreamDelivers(asset) {
  if (!asset) return false;
  return _STORAGE_DELIVERING_METHODS.indexOf(_resolvedStreamPolling(asset, "storage")) !== -1;
}

function _isRestApiManagedNetworkDevice(asset, stream) {
  if (!asset) return false;
  var t = asset.assetType;
  if (t !== "switch" && t !== "access_point") return false;
  return _resolvedStreamPolling(asset, stream || "interfaces") === "rest_api";
}

// Resolves the polling interval (in seconds) used to gate the stale-data
// banner for a given stream. Priority — most-authoritative first:
//   1. _effectiveResolvedByAssetId (full /effective-monitor-settings walk —
//      covers per-asset, class override, integration, manual tiers)
//   2. Per-asset override on the loaded asset object
//   3. Manual tier from _monitorSettingsCache
//   4. Hardcoded floor (60s telemetry / 600s systemInfo)
// The first source is missing on first paint (the eff fetch is async). The
// _updateStaleBannersFromEffective post-pass below re-evaluates each slot
// once the cache populates, so a mid-tier interval like a class override is
// honored without waiting for the next full system-info refresh.
function _resolveStaleStreamSec(assetId, asset, streamKey) {
  // Field names come from the same two mappers the polling chip uses, so the
  // threshold can't disagree with the "every 2m" the operator reads inches
  // above the banner. They were derived as streamKey + "IntervalSeconds" here,
  // which for telemetry/systemInfo named a field no tier returns (the columns
  // are cpuMemoryIntervalSec* / systemInfoIntervalSec*) — so every tier missed
  // and the walk fell through to the 60s floor, bannering a 10-minute stream
  // after three.
  var effField = _streamIntervalEffectiveField(streamKey);
  var perAssetField = _streamIntervalAssetField(streamKey);
  var defaultSec = (streamKey === "systemInfo") ? 600 : 60;
  var effResolved = assetId ? _effectiveResolvedByAssetId.get(assetId) : null;
  if (effResolved && typeof effResolved[effField] === "number" && effResolved[effField] > 0) return effResolved[effField];
  if (asset && typeof asset[perAssetField] === "number" && asset[perAssetField] > 0) return asset[perAssetField];
  var settings = _monitorSettingsCache || {};
  if (typeof settings[effField] === "number" && settings[effField] > 0) return settings[effField];
  return defaultSec;
}

// Rewrites the Temperatures section header's updated stamp using the
// table-specific timestamp (si.lastTemperatureAt). Falls back to
// lastTelemetryAt when the temp table has never produced a row (typically
// "no sensors reported"). Staleness itself is surfaced by the standard amber
// stale banner _renderTemperatures prepends above the table (same style as
// every other section), so the stamp stays neutral.
function _updateTemperatureUpdatedStamp(asset, si) {
  var slot = document.getElementById("asset-system-temps-updated");
  if (!slot) return;
  var tempLastAt = (si && (si.lastTemperatureAt || si.lastTelemetryAt)) ||
    (asset && asset.lastTelemetryAt) || null;
  if (!tempLastAt) { slot.innerHTML = ""; return; }
  slot.innerHTML = '<span style="font-size:0.72rem;color:var(--color-text-tertiary)" title="' +
    escapeHtml(formatDateTime(tempLastAt)) + '">updated ' + timeAgo(tempLastAt) + '</span>';
}

// Bare amber banner box — the shared visual for every chart/section stale
// alert. `text` is plain text (escaped here).
function _staleBannerBoxHTML(text) {
  return "<div style=\"margin-bottom:0.75rem;padding:0.5rem 0.75rem;background:rgba(245,127,23,0.08);border:1px solid rgba(245,127,23,0.3);border-radius:6px;font-size:0.8rem;color:var(--color-warning)\">&#9888; " + escapeHtml(text) + "</div>";
}

// `lastAt` is the stream's last SUCCESS (business rule 118 — for CPU / memory
// it used to be the last attempt, which is why this banner never fired over an
// empty chart). `failureError` is the open failure run's message, or null: it
// is appended to an aged banner, and it is what raises one for a stream that
// has never succeeded at all (no `lastAt` to age).
function _staleBannerInnerHTML(lastAt, resolvedSec, failureError) {
  var why = failureError ? " — the latest poll failed: " + failureError : "";
  if (!lastAt) return failureError ? _staleBannerBoxHTML("No successful poll yet" + why) : "";
  var ageMs = Date.now() - new Date(lastAt).getTime();
  var thresholdMs = resolvedSec * 3 * 1000;
  if (ageMs <= thresholdMs) return "";
  return _staleBannerBoxHTML("Last successful update " + timeAgo(lastAt) + why);
}

// The open failure run's message for a stream, off a /system-info response
// (business rule 118). Only the two streams that track a run carry one.
function _streamFailureError(si, streamKey) {
  if (!si) return null;
  if (streamKey === "telemetry")  return si.telemetryFailingSince  ? (si.telemetryLastError  || "no data returned") : null;
  if (streamKey === "systemInfo") return si.systemInfoFailingSince ? (si.systemInfoLastError || "no data returned") : null;
  return null;
}

// Amber stale-data banner. Emits a slot wrapper carrying the assetId, stream
// key, lastAt timestamp and failure message so _updateStaleBannersFromEffective
// can rewrite the inner content once /effective-monitor-settings lands (covers
// cases where the resolved cadence comes from a class override the sync render
// can't see). Banner appears when `lastAt` is older than 3× the resolved
// polling interval, or when there is no `lastAt` and a failure is open.
// `streamKey` is one of: "telemetry" (CPU/memory/temps) or "systemInfo"
// (interfaces/storage/IPsec/LLDP). `failureError` is optional — the
// Temperatures and response-time banners pass none (they track no run).
function _staleBannerHTML(assetId, asset, streamKey, lastAt, failureError) {
  var resolvedSec = _resolveStaleStreamSec(assetId, asset, streamKey);
  var inner = _staleBannerInnerHTML(lastAt, resolvedSec, failureError || null);
  return '<div class="asset-stale-banner-slot" data-asset-id="' + escapeHtml(assetId || "") + '" data-stream="' + escapeHtml(streamKey) + '" data-last-at="' + escapeHtml(lastAt || "") + '" data-failure="' + escapeHtml(failureError || "") + '">' + inner + '</div>';
}

// The stale banner text that belongs to `el` (a chart container or a table
// being screenshotted), or "" when its section is fresh. The section's banner
// is the nearest slot before `el` inside the closest ancestor that holds one —
// an empty slot means fresh, so the search ends there rather than borrowing a
// neighbouring section's banner. Bounded by the asset tab panel. Banners
// written without a slot (the Response Time chart's) are matched by id.
function _staleBannerTextFor(el) {
  if (!el || !el.closest) return "";
  var stop = el.closest('[id^="asset-view-tab-"], .slideover, .modal-body') || document.body;
  var SEL = ".asset-stale-banner-slot, #asset-monitor-stale";
  for (var node = el; node && node !== stop.parentNode; node = node.parentElement) {
    var slots = node.querySelectorAll(SEL);
    var pick = null;
    for (var i = 0; i < slots.length; i++) {
      if (slots[i].contains(el)) continue;
      // Inside el (a chart container emits its banner above its svg), or
      // before it — DOCUMENT_POSITION_FOLLOWING: el comes after the slot.
      if (el.contains(slots[i]) || (slots[i].compareDocumentPosition(el) & 4)) pick = slots[i];
    }
    if (pick) return (pick.textContent || "").replace(/\s+/g, " ").trim();
    if (node === stop) break;
  }
  return "";
}

// Re-evaluates every stale-banner slot for an asset using the now-cached
// /effective-monitor-settings resolved values. Called from
// _updateStreamSourceBadgesFromEffective so badge + banner refresh together.
// Re-checks data-asset-id on each slot so a stale fetch after the modal
// switched assets doesn't write into the wrong row.
function _updateStaleBannersFromEffective(assetId, asset) {
  if (!assetId) return;
  var sel = '.asset-stale-banner-slot[data-asset-id="' + (window.CSS && CSS.escape ? CSS.escape(assetId) : assetId) + '"]';
  var slots = document.querySelectorAll(sel);
  slots.forEach(function (slot) {
    var streamKey = slot.getAttribute("data-stream");
    var lastAt = slot.getAttribute("data-last-at") || null;
    var failureError = slot.getAttribute("data-failure") || null;
    if (!streamKey) return;
    var resolvedSec = _resolveStaleStreamSec(assetId, asset, streamKey);
    slot.innerHTML = _staleBannerInnerHTML(lastAt, resolvedSec, failureError);
  });
  // The Temperatures section's "not available via REST API" empty state is
  // decided from the resolved temperature polling method, which the sync
  // render couldn't see before this effective-settings walk landed. Re-render
  // it now so a FortiGate whose temperature resolves to SNMP at the
  // integration tier drops the misleading "switch to SNMP" hint (mirrors the
  // chip refresh in _updateStreamSourceBadgesFromEffective). Only meaningful
  // in the no-readings branch; when sensors exist the table renders regardless.
  // _assetSystemSiCache is nulled on asset switch and only repopulated for the
  // current asset, so the asset.id === assetId guard keeps si aligned.
  var tempsEl = document.getElementById("asset-system-temps");
  if (tempsEl && asset && asset.id === assetId && _assetSystemSiCache) {
    _renderTemperatures(tempsEl, _assetSystemSiCache, asset);
  }
  // Storage for the same reason: its empty state names the resolved method and
  // says which stream to change, and the sync render can only see the per-asset
  // column. A switch whose Storage or Interfaces stream is SNMP at the
  // integration tier drops the "not available" state here.
  var storageEl = document.getElementById("asset-system-storage");
  if (storageEl && asset && asset.id === assetId && _assetSystemSiCache) {
    _renderStorageTable(storageEl, _assetSystemSiCache, asset);
  }
}

// ─── Current-state tab strip: cadence · freshness · Refresh ────────────────
//
// Wireless, MAC Table and ARP Table are SNAPSHOTS of what the device last
// answered, not time series. Read without a cadence and an age, an empty
// client list or forwarding database says "nothing is connected" when it just
// as often means "not asked since yesterday" — so all three carry the same
// strip the System tab's section headers carry (_streamSourceBadgeHTML + an
// "updated X ago" stamp), plus a Refresh button that re-asks the device now.
//
// The stamp turns amber past ONE cadence, not the three _staleBannerInnerHTML
// uses: at 1× a poll is simply OVERDUE, which is what an operator asking "is
// this current" needs told; the banner stays the louder signal for data that
// has been abandoned long enough to be wrong rather than merely late.
//
// Each tab feeds ONE cadence figure into both the chip and the threshold, so
// the number an operator reads is the number being compared against. Wireless
// resolves it client-side (_resolveStaleStreamSec, the same resolver its stale
// banner already uses); MAC Table and ARP Table take the server's fully-walked
// `pollIntervalSec`, which is the only one that can see ARP's discovery-only
// case.

/** "every 10m" / "every 12h" for a cadence chip; "" when there is no figure. */
function _cadenceChipHTML(cadenceSec, title) {
  var label = _formatPollingInterval(cadenceSec);
  if (!label) return "";
  return '<span style="font-size:0.75rem;padding:2px 6px;border-radius:10px;background:var(--color-bg-primary);' +
    'border:1px solid var(--color-border);color:var(--color-text-secondary);white-space:nowrap"' +
    (title ? ' title="' + escapeHtml(title) + '"' : "") + '>every ' + escapeHtml(label) + '</span>';
}

// "updated 3m ago", amber with a ⚠ once the data is older than one cadence.
// `lastAt` null renders the never-collected case rather than an empty slot —
// on these tabs "we have never had an answer" is the single most useful thing
// the strip can say, and leaving it blank is how it went unsaid before.
function _freshnessStampHTML(lastAt, cadenceSec, neverText) {
  if (!lastAt) {
    return '<span style="font-size:0.72rem;color:var(--color-text-tertiary)">' +
      escapeHtml(neverText || "never collected") + '</span>';
  }
  var overdue = typeof cadenceSec === "number" && cadenceSec > 0 &&
    (Date.now() - new Date(lastAt).getTime()) > cadenceSec * 1000;
  var color = overdue ? "var(--color-warning)" : "var(--color-text-tertiary)";
  var title = formatDateTime(lastAt) +
    (overdue ? " — older than the " + _formatPollingInterval(cadenceSec) + " poll cadence" : "");
  return '<span style="font-size:0.72rem;color:' + color + (overdue ? ";font-weight:600" : "") + '" title="' +
    escapeHtml(title) + '">' + (overdue ? "&#9888; " : "") + 'updated ' + timeAgo(lastAt) + '</span>';
}

/**
 * The strip itself. `opts`:
 *   title       — heading text (HTML-safe string, rendered as an <h4>)
 *   suffixHTML  — optional span after the heading (the counts parenthetical)
 *   chipHTML    — the cadence chip or a full stream badge
 *   lastAt      — ISO timestamp the data was collected
 *   cadenceSec  — the same cadence the chip states; drives the amber threshold
 *   neverText   — what to say when lastAt is null
 *   refreshId   — element id for the Poll button; omitted → no button
 *                 (also omitted for operators without `assetsProbe` read)
 */
function _currentStateStripHTML(opts) {
  var canRefresh = opts.refreshId && typeof canProbeAssets === "function" && canProbeAssets();
  return '<div style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;' +
      'flex-wrap:wrap;margin:0 0 0.5rem">' +
    '<div style="display:flex;align-items:baseline;gap:0.5rem;flex-wrap:wrap">' +
      '<h4 style="margin:0">' + opts.title + '</h4>' +
      (opts.suffixHTML || "") +
      (opts.chipHTML || "") +
      _freshnessStampHTML(opts.lastAt, opts.cadenceSec, opts.neverText) +
    '</div>' +
    (canRefresh
      ? '<button type="button" class="btn btn-sm btn-secondary" id="' + escapeHtml(opts.refreshId) + '" ' +
          'title="' + escapeHtml(opts.refreshTitle || "Re-read this from the device now") + '">Poll</button>'
      : "") +
  '</div>';
}

/**
 * Wire a strip's Poll button to the narrow system-info collector.
 *
 * One endpoint serves all three tabs because one pass writes all three tables
 * (wireless stations + radios, the forwarding database, the neighbour cache).
 * `onDone` re-loads whichever tab asked, and runs on failure too so the strip's
 * own stamp refreshes either way.
 *
 * `supported: false` is reported as a toast, not an error: monitoring off, the
 * Interfaces stream Disabled, or an agent-managed host pushing on its own
 * schedule are all legitimate answers, and a spinner that simply stops would
 * leave the operator guessing which.
 */
function _wireCurrentStateRefresh(refreshId, assetId, onDone) {
  var btn = document.getElementById(refreshId);
  if (!btn) return;
  btn.addEventListener("click", async function () {
    btn.disabled = true;
    btn.textContent = "Polling…";
    try {
      var res = await api.assets.refreshSystemInfo(assetId);
      if (!res || res.supported === false) {
        showToast("Nothing to poll — this device does not deliver current-state data on its " +
          "current polling method.", "info");
      } else if (!res.collected) {
        showToast("Poll failed — " + (res.error || "the device returned no data"), "error");
      } else {
        showToast("Polled the device.", "success");
      }
    } catch (err) {
      showToast("Poll failed — " + ((err && err.message) || "unknown error"), "error");
    } finally {
      // The button lives inside the markup onDone replaces, so restore it
      // first for the paths where the re-render never happens (a failed
      // re-fetch leaves the old DOM in place).
      btn.disabled = false;
      btn.textContent = "Poll";
      if (typeof onDone === "function") await onDone();
    }
  });
}

// Centred "not available" empty-state for a section whose polling method
// cannot deliver this data stream. `label` is the data-type name (e.g.
// "Telemetry"). `pollingMethod` is the human-readable label (e.g. "REST API").
// Optional `description` overrides the default body text (raw HTML — caller is
// responsible for safety; use when a device-specific note is needed).
function _notAvailableViaPollingHTML(label, pollingMethod, description) {
  var desc = (description !== undefined && description !== null)
    ? description
    : "This data is not collected for this device with the current polling method. Try a different polling method on the Monitoring tab.";
  return "<div style=\"text-align:center\">" +
    "<div style=\"color:var(--color-warning);font-size:0.9rem;margin-bottom:0.4rem\">&#9888; " + escapeHtml(label) + " not available via " + escapeHtml(pollingMethod || "current polling method") + "</div>" +
    "<div style=\"font-size:0.8rem;color:var(--color-text-secondary)\">" + desc + "</div>" +
  "</div>";
}

// Orchestrator for the System-tab interfaces table (split 2026-08): the DOM
// build (tree + rows + headers, returning the mutable pin-set state) and the
// event wiring are separate phases; bodies extracted verbatim.
// The tree connector on a nested row. Two characters, not one: the elbow
// alone read as a stray glyph at the head of the name, while the elbow plus
// its horizontal run draws the line INTO the row it belongs to. A row with
// more siblings below it gets the tee, so the last member of an aggregate is
// identifiable without counting. Box-drawing rather than CSS borders because
// the cell is already mono and the glyphs survive the column-resize + sort
// re-render that a positioned pseudo-element would have to be re-measured
// against.
function _treeElbow(isLast) {
  return '<span style="color:var(--color-text-secondary);opacity:0.85;margin-right:4px;font-size:0.8rem;letter-spacing:-1px" aria-hidden="true">' +
    (isLast === false ? "├─" : "└─") + '</span>';
}

function _renderInterfacesTable(container, si, asset) {
  if (!container) return;
  // IPsec tunnels are the IPsec tab's, not this table's: that tab lists them
  // with the peers connected through each, their pins and their history. A
  // FortiGate reports every IPsec tunnel twice — as an IPsec-stream tunnel and
  // as a `tunnel`-typed interface row of the same name (the CMDB back-fill on
  // REST, IF-MIB on SNMP) — so both are left out here, pinned or not (the
  // IPsec tab shows and clears the twin's interface pin). A tunnel interface
  // with no IPsec twin — GRE, VXLAN, ssl.root — is not on that tab and stays.
  var ipsecNames = new Set(((si && si.ipsecTunnels) || []).map(function (tn) { return tn.tunnelName; }));
  var rows = ((si && si.interfaces) || []).filter(function (r) {
    return !(r.ifType === "tunnel" && ipsecNames.has(r.ifName));
  });
  if (rows.length === 0) {
    container.innerHTML = ipsecNames.size > 0
      ? '<p class="empty-state">' + _ipsecTabPointerHTML(ipsecNames.size) + '</p>'
      : '<p class="empty-state">No interface data yet — system info is collected every ~10 minutes after monitoring is enabled.</p>';
    _wireIpsecTabPointer(container);
    return;
  }
  var state = _buildInterfacesTableDOM(container, si, asset, rows, ipsecNames.size);
  _wireInterfacesTable(container, si, asset, rows, state);
  _wireIpsecTabPointer(container);
}

// "4 IPsec tunnels are on the IPsec tab" — the line that replaces them here,
// so an operator who knows them from this table finds where they went.
function _ipsecTabPointerHTML(count) {
  return count + ' IPsec tunnel' + (count === 1 ? ' is' : 's are') + ' on the ' +
    '<a href="#" class="asset-ipsec-tab-link" style="color:var(--color-accent)">IPsec tab</a>, ' +
    'with the peers connected through ' + (count === 1 ? 'it' : 'them') + ', ' + (count === 1 ? 'its' : 'their') + ' pins and history.';
}

function _wireIpsecTabPointer(container) {
  container.querySelectorAll(".asset-ipsec-tab-link").forEach(function (a) {
    a.addEventListener("click", function (e) {
      e.preventDefault();
      var tab = document.querySelector('#asset-view-tabs .page-tab[data-tab="ipsec"]');
      if (tab) tab.click();
    });
  });
}

// Build + inject the table DOM. Returns the state the wiring phase needs:
// the pin sets (mutated there as toggles save), edit rights, and the
// inactive-row count (drives the show-inactive toggle label).
function _buildInterfacesTableDOM(container, si, asset, rows, ipsecCount) {
  var lldpAll = (si && si.lldpNeighbors) || [];
  var staleBanner = _staleBannerHTML(asset && asset.id, asset, "systemInfo", si && si.lastSystemInfoAt, _streamFailureError(si, "systemInfo"));
  var monitored        = new Set(((si && si.monitoredInterfaces)   || (asset && asset.monitoredInterfaces)   || []));
  var canEdit = canManageAssets();
  // VLAN columns appear only when at least one row in this table actually
  // carries port-VLAN data (managed FortiSwitches overlaid from the parent
  // FortiGate's CMDB). On FortiGates / non-Fortinet hosts the columns would
  // otherwise render as dashes across every row, which is just noise.
  // VLAN id -> name for the pills; kept per asset so the interface slide-over,
  // which opens from a row of this table, labels its VLAN card the same way.
  var vlanNames = (si && si.vlanNames) || {};
  if (asset && asset.id) _assetVlanNames[asset.id] = vlanNames;
  var showVlanCols = rows.some(function (r) {
    return r.nativeVlan != null ||
      (Array.isArray(r.taggedVlans) && r.taggedVlans.length > 0) ||
      r.trunksAllVlans === true;
  });
  // Same rule for PoE: only a device that actually reports a PSE gets the
  // column. A FortiGate, a server, or a switch polled over REST would
  // otherwise show a dash on every row for a feature it never reports.
  var showPoeCol = rows.some(function (r) { return r.poeStatus != null; });
  // And for IPv6 (business rule 126): an IPv4-only device would show a dash in
  // every row, so the column appears once any interface reports an IPv6.
  // Never while IPv6 is off for the install (business rule 128), whatever
  // rows written before it was switched off still carry.
  var showIpv6Col = (typeof polarisIpv6Enabled !== "undefined" && polarisIpv6Enabled === true) &&
    rows.some(function (r) { return !!r.ipv6Address; });
  // Every interface and tunnel renders (2026-08). Traffic-less rows used to
  // ship hidden behind a "Show N inactive interfaces" expander so a 48-port
  // switch with 6 live ports wasn't a wall of zeros — but "no counters yet" is
  // a poor proxy for "not interesting" (an admin-shut port the operator is
  // hunting for, a link that just came up, a dead tunnel that should be up),
  // and the expander was a bespoke control answering exactly one question.
  // Per-column sort + inline filter — TableSF, the same control every other
  // list table in Polaris carries — answers that one and the rest: sort In/Out
  // descending for the busy ports, filter Status for what's up, filter Native
  // VLAN for a segment. The nesting + collapse tree stays as the DEFAULT view;
  // the table flattens the moment a sort or a filter is active (renderBody).
  // And for interface tags (business rule 133): the column appears once any
  // port carries one. A port gets its first tag from the interface slide-over.
  var showTagsCol = rows.some(function (r) { return Array.isArray(r.tags) && r.tags.length > 0; });
  // And for transceiver readings (business rule 143): the five optics columns
  // appear once any port carries them. Rx / Tx show by default; temperature,
  // voltage and bias start hidden and are one tick away in the column gear.
  var showOpticsCols = rows.some(function (r) { return r.optics != null; });
  var COLS = 11 + (showVlanCols ? 2 : 0) + (showPoeCol ? 1 : 0) + (showIpv6Col ? 1 : 0) + (showTagsCol ? 1 : 0) + (showOpticsCols ? 5 : 0);
  // Per-user, per-asset collapsed parents. Read HERE rather than in the wiring
  // phase because every row build has to bake the current state into its own
  // markup: a sort/filter re-render replaces the whole tbody, so a post-hoc
  // DOM fix-up would be undone on the operator's next keystroke.
  var collapsed = _getCollapsedIfaces(asset && asset.id);
  // Group LLDP neighbors by local interface so the row builder can stamp the
  // first neighbor's label inline. Most ports only ever see one neighbor; a
  // "+N" badge appears when more are present and the slide-over enumerates them.
  var lldpByIf = {};
  lldpAll.forEach(function (n) {
    if (!n || !n.localIfName) return;
    if (!lldpByIf[n.localIfName]) lldpByIf[n.localIfName] = [];
    lldpByIf[n.localIfName].push(n);
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  // Plain status label — also the Status column's sort/filter value, so the
  // pill an operator reads and the value their filter matches can't diverge.
  function statusLabelOf(i) {
    if (i.adminStatus && String(i.adminStatus).toLowerCase() === "down") return "admin shut";
    if (i.operStatus) return String(i.operStatus).toLowerCase();
    if (i.adminStatus) return String(i.adminStatus).toLowerCase();
    return "";
  }

  // The monitor badges (`.status-pill` has no rule in styles.css and rendered
  // as bare text). An admin-shut port is deliberate, not a fault — outline.
  function statusCell(i) {
    var statusLabel = statusLabelOf(i);
    if (!statusLabel) return "—";
    var kind = statusLabel === "up" ? "monitored"
             : statusLabel === "admin shut" ? "monitor-passive"
             : "monitor-down";
    return '<span class="badge badge-' + kind + '" style="white-space:nowrap">' + escapeHtml(statusLabel) + '</span>';
  }

  function typeBadge(iface, isChild) {
    var t = iface.ifType;
    if (isChild && iface.subIface) {
      return '<span class="hue-pill iface-type-tag" style="--hue:#6b7280;margin-left:5px">Sub-interface</span>';
    }
    // Member port of an aggregate: show "Member" regardless of its stored type.
    if (isChild && t !== "vlan") {
      return '<span class="hue-pill iface-type-tag" style="--hue:#6b7280;margin-left:5px">Member</span>';
    }
    var cfgs = {
      physical:  ["Physical",  "#6b7280"],
      aggregate: ["Aggregate", "#3b82f6"],
      vlan:      [iface.vlanId ? "VLAN " + iface.vlanId : "VLAN", "#0d9488"],
      loopback:  ["Loopback",  "#6b7280"],
      tunnel:    ["Tunnel",    "#6b7280"],
    };
    var cfg = cfgs[t];
    if (!cfg) return "";
    // A bundle names its FortiOS kind: a hardware or software switch groups
    // member ports like an aggregate but is not one.
    var bundleLabels = { "hard-switch": "Hardware switch", "switch": "Software switch", "redundant": "Redundant", "vap-switch": "WiFi switch" };
    if (t === "aggregate" && bundleLabels[iface.ifSubtype]) cfg = [bundleLabels[iface.ifSubtype], cfg[1]];
    var c = cfg[1];
    return '<span class="hue-pill iface-type-tag" style="--hue:' + c + ';margin-left:5px">' + escapeHtml(cfg[0]) + '</span>';
  }

  // Native + Tagged VLAN cells for the interfaces table — populated only on
  // managed FortiSwitches where the monitoring path overlaid the parent
  // FortiGate's CMDB ports table. Other rows in the same table get "—".
  // The Tagged column collapses long lists past 6 entries to "<6>, +N more"
  // with the full list in the cell tooltip; trunk-all ports show "all"
  // distinctly from explicit-list trunks, matching the slide-over pill.
  // "Delivering · class3" — status and negotiated budget read together, since
  // the class is meaningless without knowing power is actually flowing.
  // The class is a BUDGET bracket, not a measurement: RFC 3621 defines no
  // per-port wattage object, so there is no wattage to show here.
  var POE_LABELS = { disabled: "Disabled", searching: "Searching", delivering: "Delivering",
                     fault: "Fault", test: "Test", "other-fault": "Fault (other)" };
  function poeCellHTML(iface) {
    if (!showPoeCol) return "";
    var st = iface.poeStatus;
    if (!st) return '<td class="mono">—</td>';
    var LABEL = POE_LABELS;
    var color = (st === "fault" || st === "other-fault") ? "var(--color-danger,#dc2626)"
      : st === "delivering" ? "var(--color-success,#16a34a)"
      : "var(--color-text-secondary)";
    var cls = iface.poeClass ? ' <span style="color:var(--color-text-secondary)">· ' + escapeHtml(iface.poeClass) + '</span>' : "";
    return '<td class="mono" style="color:' + color + '">' + escapeHtml(LABEL[st] || st) + cls + '</td>';
  }
  // Transceiver DDM cells. Rx below RX_LOW_DBM is tinted: that is past the
  // receive sensitivity of most optics, and the agent's own sensor status
  // stays "ok" there (it says the sensor works, not that the light is good).
  var RX_LOW_DBM = -20;
  function opticsCellsHTML(iface) {
    if (!showOpticsCols) return "";
    var o = iface.optics || null;
    function num(v, digits) { return (typeof v === "number" && isFinite(v)) ? v.toFixed(digits) : null; }
    // A reading opens its own history (the sensor slide-over), addressed by the
    // stored sensor name the collector gave it (rule 143's `<port> <role>`).
    var roleOrder = ["rxPower", "txPower", "temperature", "voltage", "bias"];
    var cellIdx = 0;
    function cell(text, extra) {
      var role = roleOrder[cellIdx++];
      if (text == null) return '<td class="mono"' + (extra || "") + '>—</td>';
      return '<td class="mono"' + (extra || "") + '><a href="#" class="iface-optic-link" data-sensor="' +
        escapeHtml(_sfpSensorName(iface.ifName, role)) + '" title="Show history" style="color:inherit;text-decoration:none">' +
        escapeHtml(text) + '</a></td>';
    }
    if (!o) return cell(null) + cell(null) + cell(null) + cell(null) + cell(null);
    var rx = num(o.rxDbm, 2);
    var rxLow = typeof o.rxDbm === "number" && o.rxDbm <= RX_LOW_DBM;
    var rxExtra = rxLow
      ? ' style="color:var(--color-danger,#dc2626)" title="Receive power is below the sensitivity of most optics (' + RX_LOW_DBM + ' dBm) — check the fibre, connectors and the far-end transmitter"'
      : "";
    var tempTxt = null;
    if (typeof o.temperatureC === "number" && isFinite(o.temperatureC)) {
      var TU = window.PolarisTempUnit;
      var tv = TU ? TU.convertCelsius(o.temperatureC) : o.temperatureC;
      tempTxt = tv.toFixed(1) + " " + (TU ? TU.celsiusLabel() : "°C");
    }
    var bias = (typeof o.biasA === "number" && isFinite(o.biasA)) ? (o.biasA * 1000).toFixed(2) : null;
    return cell(rx, rxExtra) +
      cell(num(o.txDbm, 2)) +
      cell(tempTxt) +
      cell(num(o.voltage, 2) != null ? num(o.voltage, 2) + " V" : null) +
      cell(bias);
  }
  function vlanCellsHTML(iface) {
    if (!showVlanCols) return "";
    var native = (iface.nativeVlan != null) ? iface.nativeVlan : null;
    var tagged = Array.isArray(iface.taggedVlans) ? iface.taggedVlans : [];
    var trunkAll = iface.trunksAllVlans === true;
    var nativeCell = '<td>' + (native != null ? _vlanPillHTML(native, vlanNames) : "—") + '</td>';
    // Each pill carries its own number on hover, so the cell-level tooltip is
    // only for what no pill shows: the "+N more" remainder and trunk-all.
    function pills(list) {
      return '<span class="vlan-pills">' + list.map(function (v) { return _vlanPillHTML(v, vlanNames); }).join("") + '</span>';
    }
    var taggedHTML, taggedTitle;
    if (trunkAll) {
      taggedHTML = '<span class="hue-pill vlan-pill">all</span>';
      taggedTitle = "allowed-vlans=all" + (tagged.length > 0 ? " (explicit: " + tagged.join(",") + ")" : "");
    } else if (tagged.length === 0) {
      taggedHTML = "—";
      taggedTitle = "";
    } else if (tagged.length <= 6) {
      taggedHTML = pills(tagged);
      taggedTitle = "";
    } else {
      taggedHTML = pills(tagged.slice(0, 6)) + ' <span style="opacity:0.7">+' + (tagged.length - 6) + ' more</span>';
      taggedTitle = tagged.map(function (v) { return _vlanOptionLabel(v, vlanNames); }).join(", ");
    }
    var taggedCell = '<td' + (taggedTitle ? ' title="' + escapeHtml(taggedTitle) + '"' : "") + '>' + taggedHTML + '</td>';
    return nativeCell + taggedCell;
  }

  // L3 addressing mode pill (FortiOS CMDB `system/interface.mode`). Only the
  // FortiOS REST path populates this; SNMP / Polaris Agent rows leave it null
  // and render "—" (same convention as the FortiSwitch-only VLAN columns).
  function addressingCell(iface) {
    var m = iface.addressingMode;
    if (!m) return "<td>—</td>";
    var cfgs = {
      dhcp:   ["DHCP",   "#3b82f6"],
      static: ["Static", "#6b7280"],
      pppoe:  ["PPPoE",  "#8b5cf6"],
    };
    var cfg = cfgs[String(m).toLowerCase()];
    if (!cfg) return '<td>' + escapeHtml(String(m)) + "</td>";
    var c = cfg[1];
    return '<td><span class="badge hue-pill" style="--hue:' + c + '">' + cfg[0] + "</span></td>";
  }

  function buildRow(iface, opts) {
    opts = opts || {};
    var isPinned = monitored.has(iface.ifName);
    // Every row is pinnable on its own, aggregate members included: the trunk
    // answers "how busy is the link", but only the members show how the load
    // splits across it, or which leg of a LAG went quiet.
    var checkbox = _ifaceMonToggleHTML(iface.ifName, isPinned, canEdit);

    var prefix = "", padStyle = "";
    if (opts.isParent) {
      var isCollapsed = collapsed.has(iface.ifName);
      prefix = '<button class="iface-expand-toggle" data-parent="' + escapeHtml(iface.ifName) + '" style="background:none;border:none;cursor:pointer;color:var(--color-text-secondary);padding:0 3px 0 0;font-size:0.75rem;vertical-align:middle;line-height:1" title="' +
        (isCollapsed ? "Expand children" : "Collapse children") + '">' + (isCollapsed ? "▶" : "▼") + '</button>';
    }
    if (opts.isChild) {
      padStyle = "padding-left:1.4rem;";
      prefix = _treeElbow(opts.lastChild);
    }
    // Operator-set alias overrides ifName as the visible label when present.
    // The real ifName is preserved as a tooltip + secondary subtitle so the
    // operator can still correlate to switch port labels in the wild.
    var label = iface.alias && iface.alias.trim() ? iface.alias.trim() : iface.ifName;
    var aliasOverride = !!(iface.alias && iface.alias.trim() && iface.alias.trim() !== iface.ifName);
    var subtitle = aliasOverride
      ? '<span style="display:block;font-size:0.7rem;opacity:0.6;font-weight:normal">' + escapeHtml(iface.ifName) + '</span>'
      : '';
    // In flat (sorted/filtered) mode a member port has no parent row above it to
    // indent under, so the "Member" badge is what still identifies it as one.
    var badgeAsChild = opts.isChild || (opts.flat && !!iface.ifParent);
    var nameCell =
      '<td class="mono" style="' + padStyle + '" title="' + escapeHtml(iface.ifName) + '">' + prefix +
      '<a href="#" class="asset-iface-link" data-row-menu data-ifname="' + escapeHtml(iface.ifName) + '" style="color:var(--color-accent);text-decoration:none">' + escapeHtml(label) + '</a>' +
      typeBadge(iface, badgeAsChild) +
      subtitle +
      '</td>';

    var speed = iface.speedBps != null ? _fmtSpeed(iface.speedBps) : "—";
    var errs  = ((iface.inErrors != null && iface.inErrors > 0) || (iface.outErrors != null && iface.outErrors > 0))
      ? ((iface.inErrors || 0) + " / " + (iface.outErrors || 0))
      : "0 / 0";
    // A nested row carries its parent's name so the expand/collapse toggle can
    // find it, and ships hidden when that parent is currently collapsed.
    var rowAttrs = "";
    if (opts.isChild) {
      rowAttrs = ' class="iface-child" data-parent="' + escapeHtml(opts.parentName) + '"';
      if (!opts.flat && collapsed.has(opts.parentName)) rowAttrs += ' style="display:none"';
    }
    var neighborCell = '<td>' + _lldpNeighborInlineCell(lldpByIf[iface.ifName] || []) + '</td>';

    var pollCell = '<td style="text-align:center;width:1%">' + checkbox + "</td>";

    return "<tr" + rowAttrs + ">" +
      pollCell +
      nameCell +
      "<td>" + statusCell(iface) + "</td>" +
      "<td>" + speed + "</td>" +
      '<td class="mono">' + escapeHtml(iface.ipAddress  || "—") + "</td>" +
      (showIpv6Col ? '<td class="mono">' + escapeHtml(iface.ipv6Address || "—") + "</td>" : "") +
      addressingCell(iface) +
      '<td class="mono">' + escapeHtml(iface.macAddress || "—") + "</td>" +
      vlanCellsHTML(iface) +
      poeCellHTML(iface) +
      opticsCellsHTML(iface) +
      "<td>" + (iface.inOctets  != null ? _fmtBytes(iface.inOctets)  : "—") + "</td>" +
      "<td>" + (iface.outOctets != null ? _fmtBytes(iface.outOctets) : "—") + "</td>" +
      '<td title="In errors / Out errors (cumulative)">' + errs + "</td>" +
      neighborCell +
      (showTagsCol ? '<td>' + (_ifaceTagPillsHTML(iface.tags) || "—") + '</td>' : "") +
    "</tr>";
  }

  function sectionRow(label, count) {
    return '<tr style="background:transparent"><td colspan="' + COLS + '" style="padding:0.35rem 0.6rem 0.2rem;font-size:0.71rem;font-weight:600;color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid var(--color-border)">' +
      escapeHtml(label) + ' <span style="font-weight:400;opacity:0.7">(' + count + ')</span>' +
    "</td></tr>";
  }

  // ── build tree ─────────────────────────────────────────────────────────────
  // childMap: parentIfName -> sorted [child interfaces]  (members first, VLANs after)
  //
  // A child is only nested when its parent is actually IN this list. An
  // ifParent naming a row that isn't here is a real state, not corruption: a
  // FortiLink trunk aggregate leaves the switch's ifTable while its link is
  // down, so its member ports keep pointing at a name the scrape no longer
  // carries. Nesting them anyway rendered them nowhere at all — neither as
  // top-level rows nor under a parent cluster that never got built — so the
  // ports vanished from the System tab at exactly the moment the trunk went
  // down.
  //
  // IPsec tunnels and their interface twins were taken out by the caller
  // (_renderInterfacesTable): they are the IPsec tab's.
  //
  // A dotted sub-interface ("br0.10" on a FortiAP, "eth0.20" on a Linux host)
  // reaches us with no ifParent — IF-MIB has no parent column and neither
  // source back-fills one — so when the base name is itself in the list the
  // row is nested under it as that VLAN. A copy, not the record: only this
  // table's tree reads the inferred parent.
  //
  // A FortiAP abbreviates the base: the sub-interfaces of wlan01 / wlan10 are
  // w01.12 / w10.10. Those nest under the wlanNN row too, but as a plain
  // sub-interface — the suffix is not documented as a VLAN id, so the badge
  // makes no VLAN claim. The bridge is abbreviated the same way: br0's
  // sub-interfaces are br.10 / br.12, and nest under br0 on the same terms.
  var ifaceNameSet = new Set(rows.map(function (r) { return r.ifName; }));
  var treeRows = rows.map(function (r) {
    if (r.ifParent && ifaceNameSet.has(r.ifParent)) return r;
    var m = /^(.+)\.(\d+)$/.exec(String(r.ifName || ""));
    if (!m) return r;
    var wlan = /^w(\d+)$/.exec(m[1]);
    if (!ifaceNameSet.has(m[1]) && wlan && ifaceNameSet.has("wlan" + wlan[1])) {
      return Object.assign({}, r, { ifParent: "wlan" + wlan[1], subIface: true });
    }
    if (m[1] === "br" && !ifaceNameSet.has("br") && ifaceNameSet.has("br0")) {
      return Object.assign({}, r, { ifParent: "br0", subIface: true });
    }
    if (!ifaceNameSet.has(m[1])) return r;
    return Object.assign({}, r, {
      ifParent: m[1],
      ifType: "vlan",
      vlanId: r.vlanId != null ? r.vlanId : Number(m[2]),
    });
  });
  var childMap = {};
  treeRows.forEach(function (r) {
    if (r.ifParent && ifaceNameSet.has(r.ifParent)) {
      if (!childMap[r.ifParent]) childMap[r.ifParent] = [];
      childMap[r.ifParent].push(r);
    }
  });
  Object.keys(childMap).forEach(function (k) {
    childMap[k].sort(function (a, b) {
      var av = a.ifType === "vlan" ? 1 : 0, bv = b.ifType === "vlan" ? 1 : 0;
      if (av !== bv) return av - bv;
      return String(a.ifName).localeCompare(String(b.ifName), undefined, { numeric: true, sensitivity: "base" });
    });
  });

  // Push an interface plus its VLAN/aggregate children onto `entries`, in
  // reading order.
  function pushCluster(entries, group, iface) {
    var kids = childMap[iface.ifName] || [];
    var collapseGroup = iface.ifName;
    entries.push(_ifaceEntry(iface, group, { isParent: kids.length > 0 }));
    kids.forEach(function (child, ci) {
      entries.push(_ifaceEntry(child, group, {
        isChild: true, parentName: collapseGroup, lastChild: ci === kids.length - 1,
      }));
    });
  }

  // ── row model ──────────────────────────────────────────────────────────────
  // One entry per rendered row. It carries the raw record, the tree placement
  // the default view nests it with, and the flat comparable fields TableSF
  // sorts + filters on. A sortable table needs its rows as DATA, not only as
  // HTML — and the tree order the entries are built in doubles as the "natural"
  // order a filtered-but-unsorted view falls back to.
  //
  // Each field is named for the column's EXISTING data-col-id, because
  // setupColumnLayout derives a column's persistence id from data-sf-key first
  // and data-col-id only as a fallback — keeping the two identical is what lets
  // already-saved column widths / hidden columns / drag order keep applying
  // instead of being orphaned by the day this table became sortable.
  //
  // `ifname` is an ARRAY on purpose: TableSF joins array values with a space for
  // both comparison and matching, so an aliased port sorts by the label the
  // operator reads while staying findable by its real ifName.
  // The Tagged VLAN column's filter+sort value: the full set as an ARRAY, not
  // the cell's "+N more" summary and not a joined string. TableSF matches a
  // multi-select selection against each element of an array row value, so the
  // array is what lets "Tagged VLANs: 30" select the ports carrying VLAN 30
  // out of a 40-VLAN trunk list. A trunk-all port reports the single "all"
  // sentinel, matching what its cell renders — filtering by a specific VLAN
  // deliberately does not select it, since the device never enumerated one.
  function taggedVlanList(iface) {
    if (iface.trunksAllVlans === true) return ["all"];
    var tagged = Array.isArray(iface.taggedVlans) ? iface.taggedVlans : [];
    return tagged.map(function (v) { return String(v); });
  }
  function neighborText(ifName) {
    var ns = lldpByIf[ifName] || [];
    if (ns.length === 0) return "";
    var n = ns[0];
    var label = (n.systemName && String(n.systemName).trim()) || n.chassisId || n.managementIp || "neighbor";
    var port = n.portId || n.portDescription || "";
    return port ? (label + " / " + port) : label;
  }
  function opticNum(iface, key) {
    var v = iface.optics ? iface.optics[key] : null;
    return (typeof v === "number" && isFinite(v)) ? v : null;
  }
  function _ifaceEntry(iface, group, tree) {
    var alias = (iface.alias && iface.alias.trim()) ? iface.alias.trim() : "";
    var errIn = iface.inErrors != null ? Number(iface.inErrors) : 0;
    var errOut = iface.outErrors != null ? Number(iface.outErrors) : 0;
    return {
      kind: "iface", raw: iface, group: group, tree: tree,
      ifname: (alias && alias !== iface.ifName) ? [alias, iface.ifName] : [iface.ifName],
      status: statusLabelOf(iface),
      speed: iface.speedBps != null ? Number(iface.speedBps) : null,
      ip: iface.ipAddress || "",
      ipv6: iface.ipv6Address || "",
      addressing: iface.addressingMode ? String(iface.addressingMode).toLowerCase() : "",
      mac: iface.macAddress || "",
      "native-vlan": iface.nativeVlan != null ? Number(iface.nativeVlan) : null,
      "tagged-vlans": taggedVlanList(iface),
      poe: iface.poeStatus || "",
      "sfp-rx":    opticNum(iface, "rxDbm"),
      "sfp-tx":    opticNum(iface, "txDbm"),
      "sfp-temp":  opticNum(iface, "temperatureC"),
      "sfp-volts": opticNum(iface, "voltage"),
      "sfp-bias":  opticNum(iface, "biasA"),
      "in": iface.inOctets != null ? Number(iface.inOctets) : null,
      out: iface.outOctets != null ? Number(iface.outOctets) : null,
      errors: (iface.inErrors != null || iface.outErrors != null) ? (errIn + errOut) : null,
      neighbor: neighborText(iface.ifName),
      // An ARRAY, like tagged-vlans: a multi-select of one tag matches every
      // port carrying it among others.
      tags: (Array.isArray(iface.tags) ? iface.tags : []).map(function (t) { return t.name; }),
    };
  }
  // Top-level: no ifParent set, or a parent that isn't in this list (see the
  // childMap note — a down FortiLink trunk's members land here).
  var topLevel = treeRows.filter(function (r) {
    return !r.ifParent || !ifaceNameSet.has(r.ifParent);
  });
  topLevel.sort(function (a, b) {
    return String(a.ifName).localeCompare(String(b.ifName), undefined, { numeric: true, sensitivity: "base" });
  });

  // Group physical + aggregate together so member ports nest under their
  // aggregate inline (a "lag1" row sorts among "port1, port2..." and its
  // member ports indent under it on expand). The previous split — separate
  // "Aggregate Interfaces" and "Physical Interfaces" headers — fragmented
  // the natural reading order and forced the operator to mentally stitch a
  // physical port back to its aggregate two sections apart. "Other" (VLAN,
  // loopback, tunnel) stays in its own group because those are conceptually
  // distinct surfaces, not physical-layer ports.
  var ifaceGroup = topLevel.filter(function (r) {
    return r.ifType === "aggregate" || r.ifType === "physical" || r.ifType == null;
  });
  var otherGroup = topLevel.filter(function (r) {
    return r.ifType && r.ifType !== "physical" && r.ifType !== "aggregate";
  });

  // ── entries, in tree order ─────────────────────────────────────────────────
  var GROUP_LABELS = { iface: "Interfaces", other: "Other Interfaces" };
  // Section counts stay TOP-LEVEL counts (what they always were): "Interfaces
  // (24)" means 24 ports, not 24 rows including their members.
  var groupCounts = { iface: ifaceGroup.length, other: otherGroup.length };
  var entries = [];
  ifaceGroup.forEach(function (iface) { pushCluster(entries, "iface", iface); });
  otherGroup.forEach(function (iface) { pushCluster(entries, "other", iface); });

  // ── render ─────────────────────────────────────────────────────────────────
  // Two modes. Unfiltered (sorted or not): the nested tree with its section
  // headers — a sort reorders the clusters within each section and the
  // children within each cluster, so a member port stays under its aggregate
  // with its elbow and the aggregate keeps its expand toggle. Filtered: no
  // section headers and no expand toggles, and a match is never hidden by a
  // collapsed parent — but a child whose parent ALSO matched still nests under
  // it with its elbow, since a filter that keeps both (a Status filter on a
  // switch keeps its FortiLink trunk and the ports in it) has a whole tree to
  // show. Only a child whose parent filtered out goes flat, its badge saying
  // what it is a member of. Only the tbody is rewritten, so TableSF's rebuilt
  // header row and applyTableLayout's widths/handles survive.
  function sortedTree(list) {
    var clusters = [], kidsOf = {};
    list.forEach(function (e) {
      if (e.tree.isChild) (kidsOf[e.tree.parentName] = kidsOf[e.tree.parentName] || []).push(e);
      else clusters.push(e);
    });
    var out = [];
    ["iface", "other"].forEach(function (g) {
      sf.apply(clusters.filter(function (e) { return e.group === g; })).forEach(function (p) {
        var kids = sf.apply(kidsOf[p.raw.ifName] || []);
        out.push(p);
        kids.forEach(function (k, i) {
          out.push(Object.assign({}, k, { tree: Object.assign({}, k.tree, { lastChild: i === kids.length - 1 }) }));
        });
      });
    });
    return out;
  }
  function renderTreeBody(list) {
    var out = "";
    var lastGroup = null;
    list.forEach(function (e) {
      if (e.group !== lastGroup) {
        out += sectionRow(GROUP_LABELS[e.group], groupCounts[e.group]);
        lastGroup = e.group;
      }
      out += buildRow(e.raw, e.tree);
    });
    return out;
  }
  function renderFilteredBody(list) {
    var matchedParents = new Set();
    list.forEach(function (e) { if (!e.tree.isChild) matchedParents.add(e.raw.ifName); });
    var kidsOf = {};
    list.forEach(function (e) {
      if (e.tree.isChild && matchedParents.has(e.tree.parentName)) {
        (kidsOf[e.tree.parentName] = kidsOf[e.tree.parentName] || []).push(e);
      }
    });
    var out = "";
    list.forEach(function (e) {
      if (e.tree.isChild && matchedParents.has(e.tree.parentName)) return;
      out += buildRow(e.raw, { flat: true });
      if (e.tree.isChild) return;
      var kids = kidsOf[e.raw.ifName] || [];
      kids.forEach(function (k, i) {
        out += buildRow(k.raw, { flat: true, isChild: true, parentName: e.raw.ifName, lastChild: i === kids.length - 1 });
      });
    });
    return out;
  }
  var sf = null;
  var afterRender = [];   // hooks the wiring phase adds (select-all resync)
  function renderBody() {
    var tbody = container.querySelector("#asset-iface-tbody");
    if (!tbody) return;
    var st = sf ? sf.getPrefs() : null;
    // Filtered means a filter that REMOVES a row, not merely one that is set:
    // a Status picker with every state ticked reads "All" and keeps every
    // row, and treating it as a filter flattened the tree under a header that
    // showed nothing active (a saved ["down","up"] on the switch type did).
    var list = (st && Object.keys(st.sfFilters || {}).length > 0) ? sf.apply(entries) : null;
    var filtered = !!list && list.length < entries.length;
    if (!filtered) {
      tbody.innerHTML = renderTreeBody(st && st.sortKey ? sortedTree(entries) : entries);
    } else if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="' + COLS + '" class="empty-state">No interfaces match the current filters.</td></tr>';
    } else {
      tbody.innerHTML = renderFilteredBody(list);
    }
    afterRender.forEach(function (fn) { fn(); });
  }

  // Both VLAN columns filter through a multi-select of the VLAN ids this device
  // actually reports (data-sf-options="" + setColumnOptions below), not a
  // free-text box: a VLAN is an identifier out of a closed set the switch just
  // told us, so there is nothing for an operator to type that isn't already
  // pickable — and typing "10" into a substring filter also matched 100, 110
  // and 210. data-sf-type is still what sorting reads, so Native VLAN keeps its
  // numeric ordering.
  var vlanHeader = showVlanCols
    ? '<th data-col-id="native-vlan" data-sf-key="native-vlan" data-sf-type="number" data-sf-options="" title="Untagged PVID on the FortiSwitch port">Native VLAN</th>' +
      '<th data-col-id="tagged-vlans" data-sf-key="tagged-vlans" data-sf-type="string" data-sf-options="" title="Tagged VLAN set on the FortiSwitch port (allowed-vlans − untagged-vlans). \"all\" indicates `set allowed-vlans all`. Filtering matches the full set, including VLANs the cell summarizes as \"+N more\".">Tagged VLANs</th>'
    : "";
  var poeHeader = showPoeCol
    ? '<th data-col-id="poe" data-sf-key="poe" data-sf-options="" title="Power over Ethernet: detection status and the negotiated power CLASS (a budget bracket, e.g. class3 = up to 12.95 W at the powered device). POWER-ETHERNET-MIB defines no per-port wattage, so no draw is shown. SNMP only.">PoE</th>'
    : "";
  var opticsHeader = showOpticsCols
    ? '<th data-col-id="sfp-rx" data-sf-key="sfp-rx" data-sf-type="number" data-sf-nofilter title="Transceiver receive power, from its digital diagnostics. Read from the switch\'s ENTITY-SENSOR table and placed on the port by the cage layout (SNMP names no port for these readings).">Rx (dBm)</th>' +
      '<th data-col-id="sfp-tx" data-sf-key="sfp-tx" data-sf-type="number" data-sf-nofilter title="Transceiver transmit power, from its digital diagnostics">Tx (dBm)</th>' +
      '<th data-col-id="sfp-temp" data-sf-key="sfp-temp" data-sf-type="number" data-sf-nofilter data-col-default-hidden="true" title="Transceiver temperature">SFP Temp</th>' +
      '<th data-col-id="sfp-volts" data-sf-key="sfp-volts" data-sf-type="number" data-sf-nofilter data-col-default-hidden="true" title="Transceiver supply voltage">SFP Voltage</th>' +
      '<th data-col-id="sfp-bias" data-sf-key="sfp-bias" data-sf-type="number" data-sf-nofilter data-col-default-hidden="true" title="Transmit laser bias current">Bias (mA)</th>'
    : "";
  container.innerHTML = staleBanner +
    '<p class="hint" style="margin:0 0 0.4rem 0;font-size:0.76rem">A <strong>Monitored</strong> interface is polled every minute and records <strong>history</strong>; click its button to switch it between Monitored and Unmonitored. Every interface below shows its current state; only monitored ones record history you can chart or alert on throughput.' +
      (ipsecCount > 0 ? ' ' + _ipsecTabPointerHTML(ipsecCount) : '') + '</p>' +
    '<div class="table-wrapper table-wrapper-panel-sticky" id="asset-iface-wrapper"><table class="data-table" style="font-size:0.82rem"><thead><tr>' +
      '<th title="Monitored interfaces are polled every minute and record history. Unmonitored interfaces still show current state here, but record no history to chart." style="width:112px" data-col-id="poll" data-col-required="true" data-col-no-resize="true">' +
        '<button type="button" class="iface-mon-toggle iface-mon-all" id="iface-poll-all" title="Switch every listed interface (rows hidden by a filter keep their current setting)"' + (canEdit ? '' : ' disabled') + '>Monitor all</button>' +
      '</th>' +
      '<th data-col-id="ifname" data-col-required="true" data-sf-key="ifname" data-sf-type="natural">Interface</th>' +
      '<th data-col-id="status" data-sf-key="status" data-sf-options="">Status</th>' +
      '<th data-col-id="speed" data-sf-key="speed" data-sf-type="number" data-sf-nofilter>Speed</th>' +
      '<th data-col-id="ip" data-sf-key="ip" data-sf-type="ip">IP</th>' +
      (showIpv6Col ? '<th data-col-id="ipv6" data-sf-key="ipv6" data-sf-type="ip" title="The interface\'s IPv6 address — the first one that is not link-local (fe80::) or loopback">IPv6</th>' : "") +
      '<th data-col-id="addressing" data-sf-key="addressing" data-sf-options="dhcp=DHCP|static=Static|pppoe=PPPoE" title="L3 addressing mode — FortiOS only (CMDB system/interface mode). DHCP, Static, or PPPoE; other sources show —">Addressing</th>' +
      '<th data-col-id="mac" data-sf-key="mac" data-sf-type="string">MAC</th>' +
      vlanHeader +
      poeHeader +
      opticsHeader +
      '<th data-col-id="in" data-sf-key="in" data-sf-type="number" data-sf-nofilter>In</th>' +
      '<th data-col-id="out" data-sf-key="out" data-sf-type="number" data-sf-nofilter>Out</th>' +
      '<th data-col-id="errors" data-sf-key="errors" data-sf-type="number" data-sf-nofilter>Errors (in/out)</th>' +
      '<th title="LLDP neighbor seen on this interface" data-col-id="neighbor" data-sf-key="neighbor" data-sf-type="string">Neighbor</th>' +
      (showTagsCol ? '<th data-col-id="tags" data-sf-key="tags" data-sf-options="" title="Tags on this interface — added by hand in the interface panel, or (&#9881;) by a tag whose auto-assign filter names the port&#39;s native VLAN">Tags</th>' : "") +
    '</tr></thead><tbody id="asset-iface-tbody"></tbody></table></div>';

  // Sort + filter state is per user AND per device class (a switch's filters
  // are meaningless on a firewall), keyed the same way the column layout is.
  // It has to be persisted rather than held in a closure: the System tab
  // rebuilds this whole container on every refresh tick, so anything living
  // only in memory would be wiped mid-investigation.
  var ifaceTypeKey = _assetTableTypeKey("asset-interfaces", asset);
  if (typeof TableSF !== "undefined") {
    sf = new TableSF("asset-iface-tbody", function () {
      PolarisPrefs.save(ifaceTypeKey, currentUsername, sf.getPrefs());
      renderBody();
    });
    sf.addClearButton();
    // Status and PoE offer only what this device actually reports — the value
    // sets are device-dependent (a tunnel reports "dynamic", a FortiSwitch port
    // reports "searching") and a checkbox that can never match is noise.
    sf.setColumnOptions("status", _distinctSorted(entries.map(function (e) { return e.status; })));
    if (showTagsCol) {
      sf.setColumnOptions("tags", _distinctSorted([].concat.apply([], entries.map(function (e) { return e.tags; }))));
    }
    if (showPoeCol) {
      sf.setColumnOptions("poe", _distinctSorted(entries.map(function (e) { return e.poe; }))
        .map(function (v) { return { value: v, label: POE_LABELS[v] || v }; }));
    }
    // Same rule for the two VLAN columns, per column rather than pooled: a
    // VLAN offered under Native that no port carries untagged (or under Tagged
    // that no port trunks) is an option that can only ever match nothing.
    if (showVlanCols) {
      sf.setColumnOptions("native-vlan", _distinctVlanOptions(entries.map(function (e) { return e["native-vlan"]; }), vlanNames));
      var taggedSeen = [];
      entries.forEach(function (e) {
        var t = e["tagged-vlans"];
        if (Array.isArray(t)) taggedSeen = taggedSeen.concat(t);
        else if (t) taggedSeen.push(t);
      });
      sf.setColumnOptions("tagged-vlans", _distinctVlanOptions(taggedSeen, vlanNames));
    }
    // Restore, minus any state pointing at a column THIS device doesn't render
    // (PoE and the two VLAN columns appear only when something reports them).
    // A stale filter on an absent column would match nothing, with no visible
    // control to clear it; applyState drops an unknown sortKey for us.
    var savedSf = PolarisPrefs.load(ifaceTypeKey, currentUsername);
    if (savedSf) {
      var presentKeys = {};
      container.querySelectorAll("thead th[data-sf-key]").forEach(function (th) {
        presentKeys[th.getAttribute("data-sf-key")] = true;
      });
      var keptFilters = {};
      Object.keys(savedSf.sfFilters || {}).forEach(function (k) {
        if (presentKeys[k]) keptFilters[k] = savedSf.sfFilters[k];
      });
      sf.applyState({ sortKey: savedSf.sortKey, sortDir: savedSf.sortDir, sfFilters: keptFilters });
    }
  }
  renderBody();
  if (typeof applyTableLayout === "function") {
    // Per device-type persistence — FortiGate, FortiSwitch, FortiAP, and
    // generic endpoints have very different interface tables (aggregate
    // names + IPsec rows on firewalls; dozens of `port1..portN` on switches;
    // 2-3 short names on APs) so operators want independent column widths
    // per class. See _assetTableTypeKey. Runs AFTER TableSF (which rebuilds
    // each sortable th's innerHTML and would wipe the resize handles).
    applyTableLayout(container.querySelector("table"), ifaceTypeKey, {
      onScreenshot: function (t) { _screenshotTableEl(t, "Interfaces", { hiddenNoun: "interface" }); },
    });
  }
  _sizeAssetIfaceTableWrapper();
  return {
    monitored: monitored, canEdit: canEdit,
    collapsed: collapsed, afterRender: afterRender,
  };
}

/**
 * One VLAN as a pill labelled with its NAME, the number on hover. `names` is
 * the id -> name map the system-info and mac-table responses carry
 * (vlanNameService: the asset's own VLAN interfaces, then its controller
 * FortiGate's). An id nothing names reads "VLAN 30" so it still reads as a
 * VLAN. `inferred` marks a MAC-table VLAN filled from the access port.
 */
/**
 * A port's CONFIGURED VLANs — native and tagged — for the MAC Table tabs,
 * which otherwise show only the VLAN each entry was learned in. `state` is a
 * `portVlans` value ({ nativeVlan, taggedVlans, trunksAllVlans }); "" when the
 * port states nothing. Pills as on the Interfaces table's two VLAN columns,
 * capped at six tagged with "+N more" (the full list on hover).
 */
function _portVlansHTML(state, names) {
  if (!state) return "";
  var bits = [];
  if (state.nativeVlan != null) {
    bits.push('<span style="font-weight:400;color:var(--color-text-secondary);font-size:0.75rem">Native</span> ' + _vlanPillHTML(state.nativeVlan, names));
  }
  var tagged = Array.isArray(state.taggedVlans) ? state.taggedVlans : [];
  if (state.trunksAllVlans === true) {
    bits.push('<span style="font-weight:400;color:var(--color-text-secondary);font-size:0.75rem">Tagged</span> <span class="hue-pill vlan-pill" title="allowed-vlans=all' +
      (tagged.length ? " (explicit: " + escapeHtml(tagged.join(",")) + ")" : "") + '">all</span>');
  } else if (tagged.length) {
    var shown = tagged.slice(0, 6).map(function (v) { return _vlanPillHTML(v, names); }).join("");
    var more = tagged.length > 6
      ? ' <span style="opacity:0.7" title="' + escapeHtml(tagged.map(function (v) { return _vlanOptionLabel(v, names); }).join(", ")) + '">+' +
        (tagged.length - 6) + ' more</span>'
      : "";
    bits.push('<span style="font-weight:400;color:var(--color-text-secondary);font-size:0.75rem">Tagged</span> <span class="vlan-pills">' + shown + '</span>' + more);
  }
  return bits.join(' <span style="opacity:0.6">·</span> ');
}

function _vlanPillHTML(vlanId, names, inferred) {
  var id = String(vlanId);
  var name = names && names[id];
  var title = "VLAN " + id + (inferred ? " — inferred from the access port's native VLAN; the switch reported none" : "");
  return '<span class="hue-pill vlan-pill' + (inferred ? " vlan-inferred" : "") + '" title="' + escapeHtml(title) + '">' +
    escapeHtml(name || ("VLAN " + id)) + '</span>';
}

/**
 * An interface's tags as pills (business rule 133). `tags` is the system-info
 * row's `[{ name, color, auto }]`. Rides the .vlan-pill shape (the other pill
 * these cells carry) with the tag's own registry colour as `--hue`; a name with
 * no registry colour keeps the class default. A tag a filter applied carries
 * the ⚙ the Tags registry uses for auto-assigned.
 */
function _ifaceTagPillsHTML(tags) {
  var list = Array.isArray(tags) ? tags : [];
  if (list.length === 0) return "";
  return '<span class="vlan-pills">' + list.map(function (t) {
    var hue = tagHueStyle(t.color || "");
    var title = t.via === "network" ? "Inherited from a network this port carries"
      : t.auto ? "Applied by this tag's auto-assign filter (Native VLAN)" : "Added by hand";
    return '<span class="hue-pill vlan-pill"' + (hue ? ' style="' + hue + '"' : "") + ' title="' + escapeHtml(title) + '">' +
      (t.auto ? '&#9881; ' : '') + escapeHtml(t.name) + '</span>';
  }).join("") + '</span>';
}

/** The interface slide-over's Tags block: the pills plus, for an editor, the
 *  button that opens _openInterfaceTagsModal. Re-rendered in place on save. */
function _ifaceTagsBlockHTML(row, canEdit) {
  var pills = _ifaceTagPillsHTML(row && row.tags);
  return '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:0.5rem;margin-bottom:0.25rem">' +
      '<span style="font-size:0.8rem;font-weight:600;color:var(--color-text-secondary)">Tags</span>' +
      (canEdit ? '<button class="btn btn-sm btn-secondary" id="btn-iface-tags-edit">Edit tags</button>' : '') +
    '</div>' +
    (pills || '<span style="font-size:0.8rem;color:var(--color-text-tertiary)">No tags</span>');
}

/**
 * Edit the HAND-APPLIED tags on one interface, in the shared tag picker. Tags a
 * filter applied are listed above it read-only: they belong to the tag's
 * filter, and the server leaves them alone unless one is ticked here, which
 * keeps it on the port by hand. `onSaved(tags)` gets the port's full list.
 */
async function _openInterfaceTagsModal(asset, ifName, row, onSaved) {
  await _ensureTagCache();
  var tags = (row && Array.isArray(row.tags)) ? row.tags : [];
  var manual = tags.filter(function (t) { return !t.auto; }).map(function (t) { return t.name; });
  var byFilter = tags.filter(function (t) { return t.auto && t.via !== "network"; });
  var byNetwork = tags.filter(function (t) { return t.auto && t.via === "network"; });
  var body =
    (byFilter.length
      ? '<div class="form-group"><label>Applied by a tag filter</label>' +
          '<div>' + _ifaceTagPillsHTML(byFilter) + '</div>' +
          '<p class="hint">Applied because this port is on a VLAN the tag&rsquo;s auto-assign filter names. Change the filter under ' +
            'Server Settings &rarr; Tags to remove one; ticking it below keeps it on this port by hand.</p>' +
        '</div>'
      : '') +
    (byNetwork.length
      ? '<div class="form-group"><label>Inherited from a network</label>' +
          '<div>' + _ifaceTagPillsHTML(byNetwork) + '</div>' +
          '<p class="hint">Inherited because this port carries the VLAN of a network tagged in IP Management. Change that ' +
            'network&rsquo;s tags to remove one; ticking it below keeps it on this port by hand.</p>' +
        '</div>'
      : '') +
    tagFieldHTML(manual);
  var footer =
    '<button class="btn btn-secondary" id="iface-tags-cancel">Cancel</button>' +
    '<button class="btn btn-primary" id="iface-tags-save">Save</button>';
  openModal("Interface tags — " + ifName, body, footer);
  wireTagPicker();
  document.getElementById("iface-tags-cancel").onclick = closeModal;
  document.getElementById("iface-tags-save").onclick = async function () {
    var btn = document.getElementById("iface-tags-save");
    btn.disabled = true;
    try {
      var r = await api.assets.setInterfaceTags(asset.id, ifName, getTagFieldValue());
      closeModal();
      showToast("Interface tags saved");
      if (typeof onSaved === "function") onSaved(r.tags || []);
    } catch (e) {
      showToast((e && e.message) || "Saving interface tags failed", "error");
      btn.disabled = false;
    }
  };
}

/** The label a VLAN filter option shows: "30 · Users_VL30", or the bare id. */
function _vlanOptionLabel(id, names) {
  var name = names && names[String(id)];
  return name ? id + " · " + name : String(id);
}

/**
 * Distinct VLAN ids as multi-select options, ordered NUMERICALLY with any
 * non-numeric sentinel (the Tagged column's "all") last. _distinctSorted can't
 * be reused here: its alphabetical sort lists 100 and 1000 between 10 and 20,
 * which reads as a broken list in a column whose every value is a number.
 */
function _distinctVlanOptions(values, names) {
  var seen = {};
  var nums = [];
  var others = [];
  (values || []).forEach(function (v) {
    if (v == null || v === "") return;
    var s = String(v);
    if (seen[s]) return;
    seen[s] = true;
    if (/^\d+$/.test(s)) nums.push(s);
    else others.push(s);
  });
  nums.sort(function (a, b) { return Number(a) - Number(b); });
  others.sort();
  return nums.concat(others).map(function (s) {
    return { value: s, label: (s === "all") ? "all (trunk)" : _vlanOptionLabel(s, names) };
  });
}

/**
 * Height-bound the interfaces table's wrapper so its header freezes and the
 * rows scroll INSIDE it (.table-wrapper-panel-sticky pins thead to the
 * wrapper's top edge) — on a 48-port switch the column labels, and the sort +
 * filter controls that live in them, otherwise scroll away immediately.
 *
 * The bound is a fraction of the SLIDE-OVER BODY's height, deliberately not the
 * wrapper's own distance to that body's bottom the way _sizeAssetSvcTableWrapper
 * measures. Two reasons: this table sits MID-TAB (storage, sensors, LLDP and
 * physical-entity sections follow it), so a distance-to-bottom bound would
 * measure a different value every time the operator scrolls the panel; and
 * measuring only the panel body works while the System tab is still
 * display:none, which is the state the table is first built in (the panel opens
 * on General) and there is no per-tab hook to re-size from.
 */
function _sizeAssetIfaceTableWrapper() {
  var w = document.getElementById("asset-iface-wrapper");
  if (!w) return;
  var body = document.getElementById("asset-panel-body");
  var avail = (body && body.clientHeight) || (typeof window !== "undefined" ? window.innerHeight : 0) || 0;
  if (!avail) return;
  w.style.maxHeight = Math.max(300, Math.round(avail * 0.72)) + "px";
}
window.addEventListener("resize", _sizeAssetIfaceTableWrapper);

/** The Interfaces table's per-row switch: one button that reads Monitored or
 *  Unmonitored and flips on click (_wireInterfacesTable). */
function _ifaceMonToggleHTML(ifName, on, canEdit) {
  return '<button type="button" class="iface-mon-toggle asset-iface-toggle' + (on ? ' is-on' : '') + '"' +
    ' data-ifname="' + escapeHtml(ifName) + '" aria-pressed="' + (on ? 'true' : 'false') + '"' +
    (canEdit ? '' : ' disabled') +
    ' title="' + (on ? 'Polled every minute with history — click to stop' : 'Current state only — click to poll every minute and record history') + '">' +
    (on ? 'Monitored' : 'Unmonitored') + '</button>';
}
function _ifaceMonIsOn(btn) { return btn.getAttribute("aria-pressed") === "true"; }
function _ifaceMonSet(btn, on) {
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.classList.toggle("is-on", on);
  btn.textContent = on ? "Monitored" : "Unmonitored";
  btn.title = on ? "Polled every minute with history — click to stop" : "Current state only — click to poll every minute and record history";
}

/** Distinct, non-empty, alphabetically sorted values — multi-select options. */
function _distinctSorted(values) {
  var seen = {};
  var out = [];
  (values || []).forEach(function (v) {
    if (!v || seen[v]) return;
    seen[v] = true;
    out.push(v);
  });
  return out.sort();
}

// Wire the built table: select-all + per-row pin toggles (PUTs), the
// expand/collapse tree, and the interface / LLDP-neighbor drill-down links.
// (IPsec tunnels — their pins and their history — are the IPsec tab's.)
//
// Every row-level handler is DELEGATED off the tbody rather than bound per
// element: a sort or filter rewrites the tbody wholesale, so per-row listeners
// would be dropped on the operator's first keystroke. `state.monitored` is
// mutated IN PLACE for the same reason — the row builder closes over that Set
// to decide which boxes render checked, so rebinding a local would leave a
// re-render showing stale pins.
function _wireInterfacesTable(container, si, asset, rows, state) {
  var monitored        = state.monitored;
  var canEdit          = state.canEdit;
  var collapsed        = state.collapsed;
  var assetId          = asset && asset.id;
  var tbody            = container.querySelector("#asset-iface-tbody");
  function replaceSet(set, next) {
    set.clear();
    next.forEach(function (v) { set.add(v); });
  }

  // Header button — offers "Monitor all" until every row button in the table
  // (collapsed rows included) reads Monitored, then "Unmonitor all".
  var ifaceAllCb = container.querySelector("#iface-poll-all");
  function syncIfaceAllCb() {
    if (!ifaceAllCb) return;
    var boxes = container.querySelectorAll(".asset-iface-toggle");
    var on = 0;
    boxes.forEach(function (b) { if (_ifaceMonIsOn(b)) on++; });
    var allOn = boxes.length > 0 && on === boxes.length;
    ifaceAllCb.textContent = allOn ? "Unmonitor all" : "Monitor all";
    ifaceAllCb.setAttribute("data-next", allOn ? "off" : "on");
    if (canEdit) ifaceAllCb.disabled = boxes.length === 0;
  }
  syncIfaceAllCb();
  if (state.afterRender) state.afterRender.push(syncIfaceAllCb);
  if (canEdit && asset && ifaceAllCb) {
    ifaceAllCb.addEventListener("click", async function () {
      var on = ifaceAllCb.getAttribute("data-next") !== "off";
      var ifaceBoxes  = container.querySelectorAll(".asset-iface-toggle");
      // Select-all covers the LISTED rows and leaves everything else pinned as
      // it was — with a filter active the operator can't see the rest, and
      // silently un-pinning an interface they aren't looking at would stop its
      // fast-cadence polling (and drop it to 24h retention) invisibly. With no
      // filter, every row is listed, so this is the old whole-table behavior.
      var nextIf = new Set(monitored);
      ifaceBoxes.forEach(function (b) {
        var n = b.getAttribute("data-ifname");
        if (on) nextIf.add(n); else nextIf.delete(n);
      });
      var patch = { monitoredInterfaces: Array.from(nextIf) };
      ifaceAllCb.disabled = true;
      try {
        await api.assets.update(asset.id, patch);
        replaceSet(monitored, nextIf);
        if (si)    si.monitoredInterfaces    = Array.from(nextIf);
        if (asset) asset.monitoredInterfaces = Array.from(nextIf);
        ifaceBoxes.forEach(function (b) { _ifaceMonSet(b, on); });
        showToast(on ? "Monitoring every listed interface" : "Stopped monitoring the listed interfaces");
      } catch (err) {
        showToast(err.message || "Failed to update", "error");
      } finally {
        ifaceAllCb.disabled = false;
        syncIfaceAllCb();
      }
    });
  }

  if (!tbody) return;

  // Monitored / Unmonitored buttons — interface rows write monitoredInterfaces.
  tbody.addEventListener("click", async function (e) {
    var cb = e.target && e.target.closest ? e.target.closest(".asset-iface-toggle") : null;
    if (!cb || cb.disabled) return;
    if (!canEdit || !asset) return;
    var name = cb.getAttribute("data-ifname");
    var on = !_ifaceMonIsOn(cb);
    var next = new Set(monitored);
    if (on) next.add(name); else next.delete(name);
    var patch = { monitoredInterfaces: Array.from(next) };
    cb.disabled = true;
    try {
      await api.assets.update(asset.id, patch);
      replaceSet(monitored, next);
      if (si) si.monitoredInterfaces = Array.from(next);
      if (asset) asset.monitoredInterfaces = Array.from(next);
      _ifaceMonSet(cb, on);
      showToast(on ? ("Monitoring " + name + " every minute") : ("Stopped monitoring " + name));
    } catch (err) {
      showToast(err.message || "Failed to update", "error");
    } finally {
      cb.disabled = false;
      syncIfaceAllCb();
    }
  });

  tbody.addEventListener("click", function (e) {
    var t = e.target;
    if (!t || !t.closest) return;

    // Expand / collapse an aggregate (or a physical port carrying VLANs).
    // Present in the tree view, sorted or not — only a filtered table
    // renders flat, so there's nothing to collapse there.
    var tog = t.closest(".iface-expand-toggle");
    if (tog) {
      e.stopPropagation();
      var parentName = tog.getAttribute("data-parent");
      var expanded = tog.textContent.trim() === "▼";
      tog.textContent = expanded ? "▶" : "▼";
      tog.title = expanded ? "Expand children" : "Collapse children";
      container.querySelectorAll(".iface-child").forEach(function (row) {
        if (row.getAttribute("data-parent") !== parentName) return;
        row.style.display = expanded ? "none" : "";
      });
      if (expanded) collapsed.add(parentName); else collapsed.delete(parentName);
      _setCollapsedIfaces(assetId, collapsed);
      return;
    }

    // Interface name click — opens the per-interface history panel, or, when
    // the interface's address sits in a Polaris network, offers that network
    // too (_openInterfaceOrNetwork). The already-loaded row rides along so the
    // slide-over can surface current-state fields (VLAN config in particular)
    // that the interface-history endpoint doesn't carry.
    // A transceiver reading cell — its history in the sensor slide-over.
    var opticLink = t.closest(".iface-optic-link");
    if (opticLink) {
      e.preventDefault();
      openSensorDetailPanel(asset, opticLink.getAttribute("data-sensor"));
      return;
    }

    var ifLink = t.closest(".asset-iface-link");
    if (ifLink) {
      e.preventDefault();
      var ifn = ifLink.getAttribute("data-ifname");
      var row = rows.find(function (r) { return r.ifName === ifn; }) || null;
      _openInterfaceOrNetwork(asset, ifn, row, ifLink);
      return;
    }

    // Neighbor link click — open the matched asset's view modal so the operator
    // can pivot from one device to its LLDP peer in one click.
    var lldpLink = t.closest(".asset-lldp-link");
    if (lldpLink) {
      e.preventDefault();
      var id = lldpLink.getAttribute("data-asset-id");
      if (id) openViewModal(id);
    }
  });
}

// The address an interface row carries, in the form GET /assets/ip-context
// takes: the first address when a row lists several, without a prefix length
// or a mask ("10.4.12.1/24", "10.4.12.1 255.255.255.0"), and null for the
// unconfigured placeholders a device reports (0.0.0.0, ::). Display parsing
// only — the containment maths stays server-side.
function _ifaceIpForLookup(raw) {
  if (raw == null) return null;
  var first = String(raw).trim().split(/[\s,;]+/)[0] || "";
  first = first.split("/")[0];
  if (!first) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(first)) return first === "0.0.0.0" ? null : first;
  if (first.indexOf(":") !== -1 && /^[0-9a-f:.]+$/i.test(first)) return first === "::" ? null : first;
  return null;
}

// An interface name is a link to its history panel — and, when the address it
// carries sits inside a Polaris network, a fork: the operator may want the
// interface OR the network that address lives in (the network slide-over,
// scrolled to that row). The fork is offered only when the network exists,
// resolved on click through GET /assets/ip-context — one small request, only
// for an interface that has an address, only for a viewer who can read
// networks — so a table of 48 ports costs nothing to render, and an address in
// no network opens the interface straight away, as before. A plain click
// always opens the interface; the fork is the RIGHT click's menu (rowMenuGesture,
// app.js), so the lookup is paid only when the operator asks for the menu. The
// menu anchors at the pointer; a lookup that fails, or lands after the table
// re-rendered under it, opens the interface rather than nothing.
function _openInterfaceOrNetwork(asset, ifName, row, anchor) {
  var at = typeof rowMenuGesture === "function" ? rowMenuGesture() : null;
  if (!at) {
    openInterfaceDetailPanel(asset, ifName, row);
    return;
  }
  var openIface = { label: "Open interface", onSelect: function () { openInterfaceDetailPanel(asset, ifName, row); } };
  // IPv4 first; an IPv6-only interface looks its IPv6 network up instead
  // (business rule 126).
  var ip = _ifaceIpForLookup(row && row.ipAddress) ||
    ((typeof polarisIpv6Enabled !== "undefined" && polarisIpv6Enabled === true) ? _ifaceIpForLookup(row && row.ipv6Address) : null);
  var canReadNetworks = typeof permAtLeast === "function" && permAtLeast("subnets", "read");
  var canLookup = typeof api !== "undefined" && api.assets && typeof api.assets.ipContext === "function";
  if (!ip || !canReadNetworks || !canLookup) {
    showRowMenu(anchor, [openIface], { label: ifName, menuAt: at });
    return;
  }
  api.assets.ipContext(ip).then(function (ctx) {
    var subnet = ctx && ctx.subnet;
    if (!anchor || !document.body.contains(anchor)) {
      openInterfaceDetailPanel(asset, ifName, row);
      return;
    }
    var items = [openIface];
    if (subnet && subnet.id) {
      var where = subnet.cidr + (subnet.name ? " · " + subnet.name : "");
      items.push({ label: "Open network", title: ip + " is in " + where, onSelect: function () {
        PolarisPanels.openNetwork(subnet.id, { focusIp: ip, subnetCidr: subnet.cidr });
      } });
    }
    showRowMenu(anchor, items, { label: ifName, menuAt: at });
  }, function () {
    openInterfaceDetailPanel(asset, ifName, row);
  });
}

// Render the inline "Neighbor" cell for the System tab interface table. Shows
// the first neighbor's system name (falling back to chassisId / managementIp
// when LLDP didn't supply one), plus a "+N" badge when multiple neighbors
// share the local port. Returns "—" when no neighbor is on this interface.
// Peer-inferred entries (source = "peer-inferred", derived from
// Asset.fortinetTopology rather than a direct LLDP scrape) render in italic
// with a tooltip explaining the inference. A matched neighbor with an active
// alert carries the same strobing severity dot as the Assets list
// (alertSummaryDotHTML, from matchedAsset.alert stamped by GET
// /assets/:id/system-info).
function _lldpNeighborInlineCell(neighbors) {
  if (!neighbors || neighbors.length === 0) return "—";
  var first = neighbors[0];
  var inferred = first.source === "peer-inferred";
  var inferredTitle = inferred ? "Inferred from peer's reported uplink (no direct LLDP from this device)" : "";
  var label = (first.systemName && String(first.systemName).trim())
    || first.chassisId
    || first.managementIp
    || "neighbor";
  var port = first.portId || first.portDescription || "";
  var openTag = inferred
    ? '<em style="font-style:italic" title="' + escapeHtml(inferredTitle) + '">'
    : "";
  var closeTag = inferred ? "</em>" : "";
  var labelHtml = first.matchedAsset && first.matchedAsset.id
    ? '<a href="#" class="asset-lldp-link" data-asset-id="' + escapeHtml(first.matchedAsset.id) +
      '" style="color:var(--color-accent);text-decoration:none">' + escapeHtml(label) + '</a>'
    : escapeHtml(label);
  var alertDot = first.matchedAsset && first.matchedAsset.alert
    ? ' ' + alertSummaryDotHTML(first.matchedAsset.alert)
    : "";
  var portStr = port ? ' <span style="opacity:0.7" class="mono">/ ' + escapeHtml(port) + '</span>' : "";
  var more = neighbors.length > 1
    ? ' <span class="badge hue-pill" style="--hue:#6b7280">+' + (neighbors.length - 1) + '</span>'
    : "";
  return openTag + labelHtml + alertDot + portStr + more + closeTag;
}

// Used-% cell for the storage table: the canonical utilization bar
// (.util-bar-track/.util-bar-fill) plus a right-aligned label, colored on the
// SAME thresholds as the Highest Disk Usage widget (widgets/diskUsage.js) so a
// volume can't read amber in one place and blue in the other.
var _STORAGE_PCT_THRESHOLDS = [{ over: 90, color: "#ff1744" }, { over: 75, color: "#ffd600" }];

function _storagePctCell(pct) {
  if (pct == null) return '<span style="color:var(--color-text-tertiary)">—</span>';
  var v = Math.max(0, Math.min(100, pct));
  var color = "#4fc3f7";
  for (var i = 0; i < _STORAGE_PCT_THRESHOLDS.length; i++) {
    if (v >= _STORAGE_PCT_THRESHOLDS[i].over) { color = _STORAGE_PCT_THRESHOLDS[i].color; break; }
  }
  // The label is rounded to fit the narrow column; the exact figure rides a
  // native tooltip so nothing is lost.
  return '<div class="util-row" title="' + escapeHtml(v.toFixed(1) + '% used') + '">' +
    '<div class="util-bar-track"><div class="util-bar-fill" style="width:' + v.toFixed(1) + '%;background:' + color + '"></div></div>' +
    '<span style="width:34px;flex:0 0 auto;text-align:right;font-size:0.78rem;color:var(--color-text-secondary)">' + Math.round(v) + '%</span>' +
  '</div>';
}

// A pool's health word as the platform reports it (ZFS ONLINE / DEGRADED /
// FAULTED…, Unraid's array state STARTED / STOPPED, a disk's DISK_OK…),
// coloured by whether it reads healthy. Unknown words stay neutral.
function _storageHealthCell(h) {
  var state = PolarisAssetShared.storageHealthState(h);
  var color = state === "good" ? "var(--color-success,#46a758)" : state === "bad" ? "var(--color-danger,#e5484d)" : "var(--color-text-secondary)";
  return '<span style="color:' + color + '">' + escapeHtml(h) + '</span>';
}

// ─── Pool layout (Unraid / TrueNAS) ─────────────────────────────────────────
// Under the Storage table: each pool's device groups (ZFS vdevs by role,
// Unraid's parity + data disks, a pool's members) and each disk's health,
// errors, size and temperature, plus the last scrub / parity check. One
// collapsible block per pool, open when something in it is unhealthy — a
// healthy 12-disk NAS should not push the rest of the tab down.
// Inventory, not a time series: it is as fresh as the last discovery run.

function _poolMemberUnhealthy(m) {
  return PolarisAssetShared.poolMemberUnhealthy(m);
}

function _poolScanText(scan) {
  return PolarisAssetShared.poolScanText(scan);
}

function _poolLayoutsHTML(rows, details) {
  var pools = rows
    .map(function (s) { return { name: s.mountPath, d: details[s.mountPath] }; })
    .filter(function (p) { return p.d && Array.isArray(p.d.groups) && p.d.groups.length > 0; });
  if (pools.length === 0) return "";
  var dash = '<span style="color:var(--color-text-tertiary)">—</span>';
  var ROLE = { data: "Data", parity: "Parity", log: "Log", cache: "Cache", spare: "Spare", special: "Special", dedup: "Dedup" };
  return '<div data-shot-section="poolLayout" data-shot-label="Pool Devices" style="margin-top:0.75rem">' +
    '<h5 style="margin:0 0 0.4rem;font-size:0.85rem">Pool devices <span style="font-weight:400;font-size:0.75rem;color:var(--color-text-tertiary)">— as of the last discovery run</span></h5>' +
    pools.map(function (p) {
      var d = p.d;
      var anyBad = d.groups.some(function (g) { return g.members.some(_poolMemberUnhealthy); }) ||
        (d.health && !/^(ONLINE|STARTED|DISK_OK)$/i.test(d.health));
      var showSplit = d.groups.some(function (g) { return g.members.some(function (m) { return m.readErrors != null || m.writeErrors != null || m.checksumErrors != null; }); });
      var hasSmart = d.groups.some(function (g) { return g.members.some(function (m) { return !!m.smart; }); });
      var hasFs = d.groups.some(function (g) { return g.members.some(function (m) { return !!m.filesystem; }); });
      var head =
        '<summary style="cursor:pointer;padding:0.35rem 0;font-size:0.84rem">' +
          '<strong class="mono">' + escapeHtml(p.name) + '</strong>' +
          (d.health ? ' · ' + _storageHealthCell(d.health) : '') +
          (d.type ? ' · <span style="color:var(--color-text-secondary)">' + escapeHtml(d.type) + '</span>' : '') +
          (d.scan ? ' · <span style="color:var(--color-text-secondary)">' + escapeHtml(_poolScanText(d.scan)) + '</span>' : '') +
        '</summary>' +
        (d.healthDetail ? '<p class="hint" style="margin:0 0 0.4rem;color:var(--color-warning)">' + escapeHtml(d.healthDetail) + '</p>' : '');
      var th = '<th>Group</th><th>Device</th><th>Health</th>' +
        (showSplit ? '<th title="Read / write / checksum errors">Errors (R/W/C)</th>' : '<th>Errors</th>') +
        (hasSmart ? '<th>SMART</th>' : '') +
        (hasFs ? '<th>Filesystem</th>' : '') +
        '<th>Size</th><th>Temp</th><th>Model / Serial</th>';
      var body = d.groups.map(function (g) {
        var gLabel = (ROLE[g.role] || g.role) + (g.layout ? " · " + g.layout : "") + (g.name ? ' <span class="mono" style="color:var(--color-text-tertiary)">' + escapeHtml(g.name) + '</span>' : "");
        return g.members.map(function (m, i) {
          var errs = showSplit
            ? [m.readErrors, m.writeErrors, m.checksumErrors].map(function (x) { return x == null ? "—" : String(x); }).join(" / ")
            : (m.errors != null ? String(m.errors) : "—");
          var errBad = (m.readErrors || 0) + (m.writeErrors || 0) + (m.checksumErrors || 0) + (m.errors || 0) > 0;
          var temp = m.temperatureC != null
            ? escapeHtml(window.PolarisTempUnit ? (Math.round(window.PolarisTempUnit.convertReading(m.temperatureC, "°C") * 10) / 10) + " " + window.PolarisTempUnit.displayUnit("°C") : m.temperatureC + " °C")
            : dash;
          var ident = [m.model, m.serial].filter(Boolean).map(escapeHtml).join(' <span style="color:var(--color-text-tertiary)">·</span> ');
          return '<tr>' +
            '<td>' + (i === 0 ? gLabel + (g.health && g.members.length > 1 ? " " + _storageHealthCell(g.health) : "") : "") + '</td>' +
            '<td class="mono">' + escapeHtml(m.name) + (m.device && m.device !== m.name ? ' <span style="color:var(--color-text-tertiary)">' + escapeHtml(m.device) + '</span>' : '') +
              (m.mediaType ? ' <span class="badge" style="font-size:0.68rem">' + escapeHtml(m.mediaType) + '</span>' : '') + '</td>' +
            '<td>' + (m.health ? _storageHealthCell(m.health) : dash) + '</td>' +
            '<td' + (errBad ? ' style="color:var(--color-danger,#e5484d);font-weight:600"' : '') + '>' + escapeHtml(errs) + '</td>' +
            (hasSmart ? '<td>' + (m.smart ? _storageHealthCell(m.smart) : dash) + '</td>' : '') +
            (hasFs ? '<td>' + (m.filesystem ? escapeHtml(m.filesystem) : dash) + '</td>' : '') +
            '<td>' + (m.sizeBytes != null ? _fmtBytes(m.sizeBytes) : dash) + '</td>' +
            '<td>' + temp + '</td>' +
            '<td style="font-size:0.78rem">' + (ident || dash) + '</td>' +
          '</tr>';
        }).join("");
      }).join("");
      return '<details' + (anyBad ? ' open' : '') + ' style="margin-bottom:0.4rem">' + head +
        '<div class="table-wrapper"><table class="data-table" style="font-size:0.8rem"><thead><tr>' + th + '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '</details>';
    }).join("") +
  '</div>';
}

function _renderStorageTable(container, si, asset) {
  if (!container) return;
  var rows = (si && si.storage) || [];
  if (rows.length === 0) {
    // Distinguish "nothing collected this yet" from "nothing ever will".
    // The second case used to render as the first — or, before 2026-08, as no
    // Storage section at all — which read as a device with no disks rather
    // than as a stream that is switched off.
    if (!_storageStreamDelivers(asset)) {
      var storageMethod = _resolvedStreamPolling(asset, "storage");
      var storageOff = !storageMethod || storageMethod === "disabled";
      // "not available via Disabled" isn't a sentence; when the stream is
      // simply off, the description carries the specifics instead.
      var methodLabel = storageOff
        ? "the current polling method"
        : (_POLLING_LABELS[storageMethod] || storageMethod);
      var storageDesc =
        (storageOff ? "The <strong>Storage</strong> stream is switched off for this device. " : "") +
        "Set it to <strong>SNMP</strong> on this asset's Monitoring tab, or on the integration's Monitoring tab to cover the whole class. " +
        "It has to be the <strong>Storage</strong> stream specifically — the Interfaces stream's SNMP walk collects the same rows but they are dropped unless Storage asked for them. " +
        "FortiOS REST API publishes no mountable storage, so a Fortinet device reports its system flash over SNMP only.";
      container.innerHTML = _notAvailableViaPollingHTML("Storage", methodLabel, storageDesc);
      return;
    }
    container.innerHTML = '<p class="empty-state">No storage data yet — the first scrape lands within one storage polling interval.</p>';
    return;
  }
  var monitored = new Set(((si && si.monitoredStorage) || (asset && asset.monitoredStorage) || []));
  var canEdit = canManageAssets();
  // A hypervisor's volumes carry facts the storage stream does not (datastore
  // type / backing / provisioned, pool kind / health). Each column is drawn
  // only when some row has a value for it.
  var details = _storageDetailsFor(asset) || {};
  var extraCols = [
    { id: "type",        label: "Type",        cell: function (d) { return d.type ? escapeHtml(d.type) : null; } },
    { id: "health",      label: "Health",      cell: function (d) { return d.health ? _storageHealthCell(d.health) : null; } },
    { id: "backing",     label: "Backing",     cell: function (d) { return d.backing ? escapeHtml(d.backing) : null; } },
    { id: "provisioned", label: "Provisioned", cell: function (d) { return d.provisionedBytes != null ? _fmtBytes(d.provisionedBytes) : null; } },
  ].filter(function (c) {
    return rows.some(function (s) { var d = details[s.mountPath]; return d && c.cell(d) != null; });
  });
  var dash = '<span style="color:var(--color-text-tertiary)">—</span>';
  var body = rows.map(function (s) {
    var pct = (s.totalBytes && s.usedBytes != null && s.totalBytes > 0) ? ((s.usedBytes / s.totalBytes) * 100) : null;
    var checked = monitored.has(s.mountPath) ? ' checked' : '';
    var disabled = canEdit ? '' : ' disabled';
    var checkbox =
      '<input type="checkbox" class="asset-storage-toggle" data-mount="' + escapeHtml(s.mountPath) + '"' + checked + disabled +
      ' title="Poll this mountpoint every minute (response-time cadence)">';
    var d = details[s.mountPath] || null;
    var nameCell = '<a href="#" class="asset-storage-link" data-mount="' + escapeHtml(s.mountPath) + '" style="color:var(--color-accent);text-decoration:none">' + escapeHtml(s.mountPath) + '</a>' +
      (d && d.accessible === false ? ' <span style="color:var(--color-danger,#ef5350);font-size:0.8em">(inaccessible)</span>' : '');
    return '<tr>' +
      '<td style="text-align:center;width:1%">' + checkbox + '</td>' +
      '<td class="mono">' + nameCell + '</td>' +
      extraCols.map(function (c) { var v = d ? c.cell(d) : null; return '<td>' + (v != null ? v : dash) + '</td>'; }).join("") +
      '<td>' + (s.usedBytes  != null ? _fmtBytes(s.usedBytes)  : '—') + '</td>' +
      '<td>' + (s.totalBytes != null ? _fmtBytes(s.totalBytes) : '—') + '</td>' +
      '<td>' + _storagePctCell(pct) + '</td>' +
    '</tr>';
  }).join("");
  container.innerHTML =
    '<p class="hint" style="margin:0 0 0.4rem 0;font-size:0.76rem">The <strong>Poll&nbsp;1m</strong> column selects volumes for fast-cadence polling and <strong>full-history retention</strong>. Unselected volumes are kept for 24&nbsp;h only.</p>' +
    '<div class="table-wrapper"><table class="data-table" style="font-size:0.82rem"><thead><tr>' +
      '<th title="Pin this mountpoint for fast-cadence polling + full-history retention (unselected volumes are kept 24h)" style="width:32px" data-col-id="poll" data-col-required="true">' +
        '<input type="checkbox" id="storage-poll-all" title="Select / de-select all volumes for fast-cadence polling"' + (canEdit ? '' : ' disabled') + '>' +
      '</th>' +
      '<th data-col-id="mount" data-col-required="true">Mount</th>' +
      extraCols.map(function (c) { return '<th data-col-id="' + c.id + '">' + c.label + '</th>'; }).join("") +
      '<th data-col-id="used">Used</th>' +
      '<th data-col-id="total">Total</th>' +
      '<th data-col-id="usedPct">Used %</th>' +
    '</tr></thead><tbody>' + body + '</tbody></table></div>' +
    _poolLayoutsHTML(rows, details);
  if (typeof applyTableLayout === "function") {
    applyTableLayout(container.querySelector("table"), _assetTableTypeKey("asset-storage", asset), {
      onScreenshot: function (t) { _screenshotTableEl(t, "Storage"); },
    });
  }

  // Header select-all checkbox — same pattern as the interfaces table:
  // mirrors the aggregate Poll 1m state (indeterminate = some pinned) and
  // writes the whole monitoredStorage set in one PUT.
  var storageAllCb = container.querySelector("#storage-poll-all");
  function syncStorageAllCb() {
    if (!storageAllCb) return;
    var boxes = container.querySelectorAll(".asset-storage-toggle");
    var on = 0;
    boxes.forEach(function (b) { if (b.checked) on++; });
    storageAllCb.checked = boxes.length > 0 && on === boxes.length;
    storageAllCb.indeterminate = on > 0 && on < boxes.length;
  }
  syncStorageAllCb();
  if (canEdit && asset && storageAllCb) {
    storageAllCb.addEventListener("change", async function () {
      var on = storageAllCb.checked;
      var boxes = container.querySelectorAll(".asset-storage-toggle");
      var next = new Set();
      if (on) boxes.forEach(function (b) { next.add(b.getAttribute("data-mount")); });
      storageAllCb.disabled = true;
      try {
        await api.assets.update(asset.id, { monitoredStorage: Array.from(next) });
        monitored = next;
        if (si) si.monitoredStorage = Array.from(next);
        if (asset) asset.monitoredStorage = Array.from(next);
        boxes.forEach(function (b) { b.checked = on; });
        showToast(on ? "Fast-polling every volume" : "Stopped fast-polling all volumes");
      } catch (err) {
        showToast(err.message || "Failed to update", "error");
      } finally {
        storageAllCb.disabled = false;
        syncStorageAllCb();
      }
    });
  }

  if (canEdit && asset) {
    container.querySelectorAll(".asset-storage-toggle").forEach(function (cb) {
      cb.addEventListener("change", async function () {
        var mount = cb.getAttribute("data-mount");
        var current = new Set(monitored);
        if (cb.checked) current.add(mount); else current.delete(mount);
        cb.disabled = true;
        try {
          await api.assets.update(asset.id, { monitoredStorage: Array.from(current) });
          monitored = current;
          if (si) si.monitoredStorage = Array.from(current);
          if (asset) asset.monitoredStorage = Array.from(current);
          showToast(cb.checked ? ("Polling " + mount + " every minute") : ("Stopped fast-polling " + mount));
        } catch (err) {
          cb.checked = !cb.checked;
          showToast(err.message || "Failed to update", "error");
        } finally {
          cb.disabled = false;
          syncStorageAllCb();
        }
      });
    });
  }
  container.querySelectorAll(".asset-storage-link").forEach(function (link) {
    link.addEventListener("click", function (e) {
      e.preventDefault();
      openStorageDetailPanel(asset, link.getAttribute("data-mount"), rows);
    });
  });
}

// Latest-snapshot hardware-sensor table (temperature / fan / voltage / power /
// disk) with per-row alarm status. Each sensor name is a clickable link that
// opens the per-sensor history slide-over (see openSensorDetailPanel). The
// device's whole fgHwSensorTable / sensor-info table lands here, not just
// temperatures.
function _hwClassLabel(cls) {
  switch (cls) {
    case "temperature": return "Temp";
    case "fan":         return "Fan";
    case "voltage":     return "Voltage";
    case "current":     return "Current";
    case "optical":     return "Optical";
    case "poe":         return "PoE";
    case "power":       return "Power";
    case "disk":        return "Disk";
    default:            return "Other";
  }
}
function _hwReadingText(s) {
  if (typeof s.value !== "number" || !isFinite(s.value)) return "—";
  // Convert for display only when the install asked for °F AND this row is a
  // Celsius reading — the same table carries fan RPM and voltage rails, which
  // must pass through untouched (PolarisTempUnit gates on the row's own unit).
  var TU = window.PolarisTempUnit;
  var raw  = TU ? TU.convertReading(s.value, s.unit) : s.value;
  var unit = TU ? TU.displayUnit(s.unit) : s.unit;
  // Trim trailing zeros for a clean decimal; append the unit when present.
  var v = Math.round(raw * 1000) / 1000;
  return unit ? (v + " " + unit) : String(v);
}
// Past this many rows the table is capped and scrolls under a sticky header
// instead of growing the System tab: a chassis publishes dozens of sensors
// (a FortiGate-201G walk is 30+ TMP/VOL/FAN/PSU rows), and an unbounded table
// pushed Storage, LLDP and every section below it off the panel entirely.
var HW_SENSOR_SCROLL_ROWS = 10;
// The cap is derived from the row box rather than a vh fraction so the same
// number of rows is visible whatever the panel height: ~39px per 0.82rem row
// (0.6rem padding x2 + line box + border) plus ~38px of header. Showing
// exactly HW_SENSOR_SCROLL_ROWS rows leaves the next one visibly cut off,
// which is what tells the operator there is more below.
function _hwTableWrapper(rowCount) {
  if (rowCount <= HW_SENSOR_SCROLL_ROWS) return { cls: "table-wrapper", style: "" };
  return {
    cls: "table-wrapper table-wrapper-modal-sticky",
    style: "max-height:" + (HW_SENSOR_SCROLL_ROWS * 39 + 38) + "px",
  };
}
function _hwStatusCell(s) {
  if (s.alarmStatus === "alarm") {
    return '<span style="color:var(--color-danger,#e5484d);font-weight:600">⚠ alarm</span>';
  }
  if (s.alarmStatus === "ok") {
    return '<span style="color:var(--color-success,#46a758)">ok</span>';
  }
  return '<span style="color:var(--color-text-tertiary)">—</span>';
}
function _renderTemperatures(container, si, asset) {
  if (!container) return;
  _updateTemperatureUpdatedStamp(asset, si);
  var latestRaw = (si && si.hardwareSensors) || [];
  // Auto-hide sensors with no usable reading (null/NaN value — e.g. an
  // unpopulated SFP cage or a sensor the agent couldn't read). Unlike the old
  // temperature-only table we KEEP exact-zero readings: a 0 V rail or a PSU
  // presence of 0 is meaningful. Hidden sensors stay reachable via the toggle.
  var hasReading = function (s) {
    return typeof s.value === "number" && isFinite(s.value);
  };
  var latest = latestRaw.filter(hasReading);
  var hidden = latestRaw.filter(function (s) { return !hasReading(s); });
  if (latest.length === 0) {
    if (_isRestApiManagedNetworkDevice(asset, "temperature")) {
      var tempPolling = _assetMonitorStreamSource(asset, "temperature").polling || "REST API";
      container.innerHTML = _notAvailableViaPollingHTML("Hardware Sensors", tempPolling);
    } else {
      // Check the hardware-sensor stream specifically — the dispatcher uses
      // temperaturePolling, not cpuMemoryPolling, so a firewall whose
      // CPU/memory is on REST but whose hardware sensors have already been
      // flipped to SNMP shouldn't show the "switch to SNMP" nag.
      var isFortinetRestFirewall = asset && asset.assetType === "firewall" &&
        _resolvedStreamPolling(asset, "temperature") === "rest_api";
      if (isFortinetRestFirewall) {
        var fgTempPolling = _assetMonitorStreamSource(asset, "temperature").polling || "REST API";
        var fgTempDesc = "Lower-end FortiGate models (60F/61F/91G class) do not support the sensor-info endpoint via REST API. " +
          "Upgrade FortiOS or switch the <strong>Hardware Sensors</strong> polling method to <strong>SNMP</strong> on the integration's Monitoring tab to enable collection on affected models.";
        container.innerHTML = _notAvailableViaPollingHTML("Hardware Sensors", fgTempPolling, fgTempDesc);
      } else {
        container.innerHTML = '<p class="empty-state">No hardware sensors reported by this device.</p>';
      }
    }
    return;
  }
  var rowFor = function (s) {
    var name = '<a href="#" class="asset-temp-link" data-name="' + escapeHtml(s.sensorName) + '" style="color:var(--color-accent);text-decoration:none">' + escapeHtml(s.sensorName) + '</a>';
    return '<tr>' +
      '<td>' + name + '</td>' +
      '<td>' + escapeHtml(_hwClassLabel(s.sensorClass)) + '</td>' +
      '<td class="mono">' + escapeHtml(_hwReadingText(s)) + '</td>' +
      '<td>' + _hwStatusCell(s) + '</td>' +
    '</tr>';
  };
  var rows = latest.map(rowFor).join("");
  var hiddenRows = hidden.map(rowFor).join("");
  // Stale-state surfaces as the standard amber banner above the table — the
  // same style every other section/chart uses — keyed on the table-specific
  // timestamp so it fires when CPU/mem succeeds but the sensor pull fails.
  _updateTemperatureUpdatedStamp(asset, si);
  var sensorStaleBanner = _staleBannerHTML(asset && asset.id, asset, "telemetry",
    (si && (si.lastTemperatureAt || si.lastTelemetryAt)) || null);
  var headCells =
    '<th data-col-id="sensor" data-col-required="true">Sensor</th>' +
    '<th data-col-id="class">Class</th>' +
    '<th data-col-id="reading">Reading</th>' +
    '<th data-col-id="status">Status</th>';
  var toggleHTML = "";
  if (hidden.length > 0) {
    var hiddenWrap = _hwTableWrapper(hidden.length);
    toggleHTML =
      '<details class="asset-temp-hidden" style="margin-top:0.5rem;font-size:0.82rem">' +
        '<summary style="cursor:pointer;color:var(--color-text-tertiary);user-select:none">' +
          'Show ' + hidden.length + ' sensor' + (hidden.length === 1 ? '' : 's') + ' with no reading' +
        '</summary>' +
        '<div class="' + hiddenWrap.cls + '" style="margin-top:0.4rem' +
          (hiddenWrap.style ? ';' + hiddenWrap.style : '') + '">' +
          '<table class="data-table" style="font-size:0.82rem"><thead><tr>' + headCells +
          '</tr></thead><tbody>' + hiddenRows + '</tbody></table>' +
        '</div>' +
      '</details>';
  }
  var wrap = _hwTableWrapper(latest.length);
  container.innerHTML =
    sensorStaleBanner +
    '<div class="' + wrap.cls + '"' + (wrap.style ? ' style="' + wrap.style + '"' : '') + '>' +
      '<table class="data-table" style="font-size:0.82rem"><thead><tr>' + headCells +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +
    '</div>' +
    toggleHTML;
  if (typeof applyTableLayout === "function") {
    container.querySelectorAll("table").forEach(function (t) {
      applyTableLayout(t, _assetTableTypeKey("asset-hardware-sensors", asset), {
        onScreenshot: function (tbl) { _screenshotTableEl(tbl, "Hardware Sensors"); },
      });
    });
  }

  container.querySelectorAll(".asset-temp-link").forEach(function (link) {
    link.addEventListener("click", function (e) {
      e.preventDefault();
      openSensorDetailPanel(asset, link.getAttribute("data-name"));
    });
  });
}

// Standalone LLDP Neighbors roll-up card on the System tab — sits below
// Storage. Same data the per-interface inline column already shows on
// the Interfaces table, but in one consolidated view so operators can
// scan every neighbor without scrolling the interface table. Each row
// shows the local port, the neighbor's chassis/system identity, and a
// click-through to the matched Polaris asset (if the LLDP collector
// resolved one) or a plain label for non-Polaris ghost neighbors.
function _renderLldpNeighborsCard(container, si, asset) {
  if (!container) return;
  var neighbors = (si && si.lldpNeighbors) || [];
  if (neighbors.length === 0) {
    if (_isRestApiManagedNetworkDevice(asset, "lldp")) {
      var lldpPolling = _assetMonitorStreamSource(asset, "lldp").polling || "REST API";
      container.innerHTML = _notAvailableViaPollingHTML("LLDP Neighbors", lldpPolling);
    } else {
      container.innerHTML = "<p class=\"empty-state\">" +
        "No LLDP neighbors collected. Either the device isn’t advertising LLDP, " +
        "the monitoring transport doesn’t support it, or the FortiOS REST endpoint " +
        "returned 404 — try flipping the integration’s LLDP transport to SNMP." +
      "</p>";
    }
    return;
  }
  // Stable presentation: sort by local port, then chassis id.
  neighbors.sort(function (a, b) {
    var la = String(a.localIfName || ""), lb = String(b.localIfName || "");
    if (la !== lb) return la.localeCompare(lb);
    return String(a.chassisId || "").localeCompare(String(b.chassisId || ""));
  });
  var rows = neighbors.map(function (n) {
    var inferred = n.source === "peer-inferred";
    var inferredTitle = inferred ? "Inferred from peer's reported uplink (no direct LLDP from this device)" : "";
    var rowStyle = inferred ? ' style="font-style:italic"' : "";
    var rowTitle = inferred ? ' title="' + escapeHtml(inferredTitle) + '"' : "";
    var primary = n.systemName || n.managementIp || n.chassisId || "(unknown)";
    var primaryHtml = (n.matchedAsset && n.matchedAsset.id)
      ? '<a href="#" class="asset-lldp-link" data-asset-id="' + escapeHtml(n.matchedAsset.id) +
        '" style="color:var(--color-accent);text-decoration:none">' + escapeHtml(primary) + '</a>'
      : escapeHtml(primary);
    var idBits = [];
    if (n.chassisId)    idBits.push("chassis " + n.chassisId);
    if (n.portId)       idBits.push("port "    + n.portId);
    if (n.managementIp) idBits.push("mgmt "    + n.managementIp);
    var caps = (Array.isArray(n.capabilities) && n.capabilities.length > 0)
      ? n.capabilities.join(", ")
      : "—";
    return '<tr' + rowStyle + rowTitle + '>' +
      '<td class="mono">' + escapeHtml(n.localIfName || "—") + '</td>' +
      '<td>' + primaryHtml +
        (idBits.length ? '<div class="mono" style="font-size:0.72rem;color:var(--color-text-tertiary);margin-top:2px">' + escapeHtml(idBits.join(" · ")) + '</div>' : '') +
      '</td>' +
      '<td style="font-size:0.78rem;color:var(--color-text-secondary)">' + escapeHtml(caps) + '</td>' +
    '</tr>';
  }).join("");
  var lldpStaleBanner = _staleBannerHTML(asset && asset.id, asset, "systemInfo", si && si.lastSystemInfoAt, _streamFailureError(si, "systemInfo"));
  container.innerHTML = lldpStaleBanner +
    '<div class="table-wrapper"><table class="data-table" style="font-size:0.82rem"><thead><tr>' +
      '<th data-col-id="localPort" data-col-required="true">Local Port</th>' +
      '<th data-col-id="neighbor" data-col-required="true">Neighbor</th>' +
      '<th data-col-id="capabilities">Capabilities</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  if (typeof applyTableLayout === "function") {
    applyTableLayout(container.querySelector("table"), _assetTableTypeKey("asset-lldp", asset), {
      onScreenshot: function (t) { _screenshotTableEl(t, "LLDP Neighbors"); },
    });
  }

  // Click-through on matched-asset links opens the matched asset's
  // details slide-in directly — same in-place pattern the inline
  // interface-table Neighbor cell uses, no full-page nav.
  container.querySelectorAll(".asset-lldp-link").forEach(function (link) {
    link.addEventListener("click", function (e) {
      e.preventDefault();
      var assetId = link.getAttribute("data-asset-id");
      if (assetId) openViewModal(assetId);
    });
  });
}

// Stations tab content for FortiAPs. Empty placeholder filled by
// _loadSystemTabFor() on modal open (which fetches /system-info once and
// hydrates every tab's mount, so opening Stations after System never
// re-fetches). Includes a stub message that flips to the populated
// table once the data lands.
function _assetStationsTabHTML(a) {
  if (!a.monitored) {
    return '<p class="empty-state" style="padding:1rem 0">Monitoring is disabled for this AP — enable it to collect its radios, the SSIDs they broadcast, and the clients connected to each.</p>';
  }
  return '<div data-shot-section="stations" data-shot-label="Wireless"><div id="asset-system-stations">' +
    '<span class="empty-state">Loading radios and wireless clients…</span>' +
    '</div></div>';
}


// ─── Wireless tree (radio → SSID → station) ─────────────────────────────────
//
// The Stations tab used to be a flat list of clients, which answered "who is
// connected" and nothing about the radio they are connected TO. The tree adds
// the two levels above: each radio with its channel, width and power, then
// the SSIDs that radio broadcasts, then the clients on each SSID.
//
// Radios come from GET /assets/:id/system-info's `apRadios` (AssetApRadio +
// nested AssetApVap). An AP with no radio inventory — discovery has not run
// since the feature shipped, or it is not controller-managed — falls back to
// the flat station table, so nothing regresses while the tree fills in.

/** "5 GHz" / "2.4 GHz" for a radio heading; the short form is for chips. */
function _radioBandLabel(band) {
  if (band === "2.4GHz") return "2.4 GHz";
  if (band === "5GHz")   return "5 GHz";
  if (band === "6GHz")   return "6 GHz";
  return "";
}

/** Small neutral chip used for a radio's channel / width / power facts. */
function _wirelessChip(text, title) {
  return '<span style="display:inline-block;padding:0 6px;border-radius:3px;font-size:0.7rem;' +
    'background:var(--color-surface-2,#8881);color:var(--color-text-secondary);margin-left:6px"' +
    (title ? ' title="' + escapeHtml(title) + '"' : "") + '>' + escapeHtml(text) + '</span>';
}

/**
 * Transmit power as the SOURCES actually reported it. The controller states a
 * PERCENTAGE of the radio's ceiling and is labelled as one. The AP's own MIB
 * publishes fapRadioTxPowerConfig / Oper / Max as bare integers with no UNITS
 * clause at all, so those are rendered WITHOUT a unit — appending "dBm" to a
 * number the module never called dBm would read as a measurement. Shown as
 * "<oper> (cfg <config>, max <max>)": the gap between configured and operating
 * is what DARRP did to the radio.
 */
function _radioPowerLabel(r) {
  var bits = [];
  if (r.txPowerOper != null) {
    var parts = [];
    if (r.txPowerConfig != null) parts.push("cfg " + r.txPowerConfig);
    if (r.txPowerMax != null) parts.push("max " + r.txPowerMax);
    bits.push(r.txPowerOper + (parts.length ? " (" + parts.join(", ") + ")" : ""));
  } else if (r.txPowerMax != null) {
    bits.push("max " + r.txPowerMax);
  }
  if (r.txPowerPct != null) bits.push(r.txPowerPct + "%");
  if (!bits.length) return "—";
  return bits.join(" · ");
}

/**
 * Attach each station to the SSID it is actually on.
 *
 * BSSID first: it is the per-VAP radio address the client associated with, so
 * it identifies one SSID on one radio exactly. The (radio, SSID-name) pair is
 * the fallback for sources that publish no BSSID. A station's own `wlanId` is
 * deliberately NOT used — it is only as trustworthy as the source's VAP
 * numbering, and getting it wrong files a client under someone else's SSID.
 *
 * Anything left over is returned rather than dropped: a client Polaris cannot
 * file is still a client, and hiding it would make the tree quietly disagree
 * with the station count.
 */
function _buildWirelessTree(radios, stations) {
  return PolarisAssetShared.buildWirelessTree(radios, stations);
}

/** The matched-endpoint cell shared by the tree and the flat station table. */
function _stationEndpointHTML(s) {
  if (s.matchedAsset && s.matchedAsset.id) {
    return '<a href="#" class="asset-station-link" data-asset-id="' + escapeHtml(s.matchedAsset.id) +
      '" style="color:var(--color-accent);text-decoration:none">' +
      escapeHtml(s.matchedAsset.hostname || s.matchedAsset.ipAddress || s.matchedAsset.id) +
      '</a>';
  }
  return '<span style="color:var(--color-text-tertiary)">(not in inventory)</span>';
}

/** One client row of the tree, indented under its SSID. */
function _wirelessStationRow(s, parentKey, hidden, isLast) {
  var signal = (s.signalStrength != null) ? (s.signalStrength + " dBm") : "—";
  return '<tr class="wireless-child" data-parent="' + escapeHtml(parentKey) + '"' + hidden + '>' +
    '<td style="padding-left:2.8rem" class="mono">' +
      _treeElbow(isLast) + escapeHtml(s.staMacAddr) +
    '</td>' +
    '<td class="mono" style="font-size:0.75rem">' + escapeHtml(s.bssid || "—") + '</td>' +
    '<td class="mono">' + escapeHtml(s.staIpAddr || "—") + '</td>' +
    '<td>' + _stationEndpointHTML(s) + '</td>' +
    '<td>' + escapeHtml(_wirelessBandLabel(s.band)) + '</td>' +
    '<td style="text-align:right">' + escapeHtml(signal) + '</td>' +
  '</tr>';
}

/** One radio's header row — the level that carries channel, width and power. */
function _wirelessRadioRow(rn, key, isCollapsed) {
  var r = rn.radio;
  // A radio's client count is COUNTED from the stations filed under it rather
  // than taken from the controller's own clientCount: the two disagree while a
  // client is roaming, and a number next to a list has to match the list.
  var clients = rn.vaps.reduce(function (n, vn) { return n + vn.stations.length; }, 0);
  var bandLabel = _radioBandLabel(r.band);
  var chips = "";
  if (r.mode && r.mode.toLowerCase() !== "ap") chips += _wirelessChip(r.mode, "Radio mode");
  if (r.radioType) chips += _wirelessChip(r.radioType, "PHY / radio type");
  chips += _wirelessChip(clients + (clients === 1 ? " client" : " clients"),
    "Counted from the clients listed below, not the controller's own tally");

  var channelCell = r.channel != null
    ? ("ch " + r.channel + (r.bandwidthMhz != null ? " · " + r.bandwidthMhz + " MHz" : ""))
    : (r.bandwidthMhz != null ? r.bandwidthMhz + " MHz" : "—");

  return '<tr style="background:var(--color-surface-2,#8881)">' +
    '<td>' +
      '<button class="wireless-expand-toggle" data-parent="' + escapeHtml(key) + '" ' +
        'style="background:none;border:none;cursor:pointer;color:var(--color-text-secondary);padding:0 3px 0 0;font-size:0.75rem;vertical-align:middle;line-height:1" ' +
        'title="' + (isCollapsed ? "Expand" : "Collapse") + '">' + (isCollapsed ? "▶" : "▼") + '</button>' +
      '<strong>Radio ' + escapeHtml(String(r.radioIndex)) + '</strong>' +
      (bandLabel ? ' <span style="color:var(--color-text-secondary)">· ' + escapeHtml(bandLabel) + '</span>' : "") +
      chips +
    '</td>' +
    '<td class="mono" style="font-size:0.75rem">' + escapeHtml(r.baseBssid || "—") + '</td>' +
    '<td>—</td>' +
    '<td>—</td>' +
    '<td>' + escapeHtml(channelCell) + '</td>' +
    '<td style="text-align:right">' + escapeHtml(_radioPowerLabel(r)) +
      (r.txPowerMode ? _wirelessChip(r.txPowerMode, "Transmit-power mode") : "") +
    '</td>' +
  '</tr>';
}

/** One SSID row, between its radio and the clients on it. */
function _wirelessVapRow(vn, key, hidden, isLast) {
  var v = vn.vap;
  var label = v.ssid || v.vapName;
  // The VAP object name is worth showing only when it is not simply the SSID
  // under another name — otherwise it is noise on every row.
  var sub = (v.ssid && v.vapName && v.vapName !== v.ssid)
    ? '<span style="display:block;font-size:0.7rem;opacity:0.6">' + escapeHtml(v.vapName) + '</span>'
    : "";
  return '<tr class="wireless-child" data-parent="' + escapeHtml(key) + '"' + hidden + '>' +
    '<td style="padding-left:1.4rem">' +
      _treeElbow(isLast) + escapeHtml(label) +
      _wirelessChip(vn.stations.length + (vn.stations.length === 1 ? " client" : " clients")) + sub +
    '</td>' +
    '<td class="mono" style="font-size:0.75rem">' + escapeHtml(v.bssid || "—") + '</td>' +
    '<td>—</td>' +
    '<td>—</td>' +
    '<td>' + (v.vlanId != null ? "VLAN " + escapeHtml(String(v.vlanId)) : "—") + '</td>' +
    '<td style="text-align:right">—</td>' +
  '</tr>';
}

// Per-asset filter text, keyed by asset id like the ARP Table tab's, so a
// Refresh (or the panel history landing back on this AP) keeps the filter.
var _assetWirelessFilter = {};

function _wirelessHaystackHas(parts, filter) {
  return parts.join(" ").toLowerCase().indexOf(filter) !== -1;
}

/** Substring match across every identifying field of one client. */
function _wirelessStationMatches(s, filter) {
  if (!filter) return true;
  var m = s.matchedAsset || {};
  // MAC fragments match with or without separators (_childFilterMatches).
  return _childFilterMatches([s.staIpAddr, s.ssid, m.hostname, m.ipAddress], [s.staMacAddr, s.bssid], filter);
}

/**
 * Narrow a built tree to `filter`. A radio or SSID that matches in its own
 * right keeps everything under it (filtering on an SSID name means "show me
 * that SSID", not "show me the clients whose own fields spell it"); otherwise
 * it survives only when a client beneath it matches, carrying just those.
 */
function _filterWirelessTree(tree, filter) {
  var radios = tree.radios.map(function (rn) {
    var r = rn.radio;
    if (_wirelessHaystackHas(["radio " + r.radioIndex, r.baseBssid], filter)) return rn;
    var vaps = rn.vaps.map(function (vn) {
      var v = vn.vap;
      if (_wirelessHaystackHas([v.ssid, v.vapName, v.bssid,
          v.vlanId != null ? "vlan " + v.vlanId : ""], filter)) return vn;
      var hits = vn.stations.filter(function (s) { return _wirelessStationMatches(s, filter); });
      return hits.length ? { vap: v, stations: hits } : null;
    }).filter(Boolean);
    return vaps.length ? { radio: r, vaps: vaps } : null;
  }).filter(Boolean);
  return {
    radios: radios,
    unplaced: tree.unplaced.filter(function (s) { return _wirelessStationMatches(s, filter); }),
  };
}

/**
 * Render the radio → SSID → client tree. Expand/collapse mirrors the System
 * tab's interface tree — a ▼/▶ toggle on the parent row, children carrying
 * data-parent — and the collapsed set persists per user per asset through the
 * same helper under its own "wireless" scope.
 */
function _renderWirelessTree(container, radios, stations, asset, filter) {
  var tree = _buildWirelessTree(radios, stations);
  // Filtered AFTER the tree is built, so a client is still filed under the
  // SSID it joined — filtering first would leave BSSID matching unchanged but
  // make the counts on the radio and SSID rows describe the filtered list.
  if (filter) tree = _filterWirelessTree(tree, filter);
  var collapsed = _getCollapsedIfaces(asset && asset.id, "wireless");
  var rows = "";

  if (filter && tree.radios.length === 0 && tree.unplaced.length === 0) {
    container.innerHTML = '<div class="empty-state">No radios, SSIDs or clients match that filter.</div>';
    return;
  }

  tree.radios.forEach(function (rn) {
    var key = "radio-" + rn.radio.radioIndex;
    // A filter opens every radio it kept: a match hidden under a collapsed
    // radio reads as no match at all.
    var isCollapsed = !filter && collapsed.has(key);
    var hidden = isCollapsed ? ' style="display:none"' : "";
    rows += _wirelessRadioRow(rn, key, isCollapsed);
    if (rn.vaps.length === 0) {
      rows += '<tr class="wireless-child" data-parent="' + escapeHtml(key) + '"' + hidden + '>' +
        '<td colspan="6" style="padding-left:1.4rem;color:var(--color-text-tertiary);font-size:0.78rem">' +
          'No SSIDs reported for this radio.' +
        '</td></tr>';
    }
    rn.vaps.forEach(function (vn, vi) {
      // Tee vs elbow says whether more rows follow at this level: an SSID is
      // last only when it has no clients of its own and no sibling below it.
      var lastVap = vi === rn.vaps.length - 1 && vn.stations.length === 0;
      rows += _wirelessVapRow(vn, key, hidden, lastVap);
      vn.stations.forEach(function (st, sti) {
        rows += _wirelessStationRow(st, key, hidden,
          sti === vn.stations.length - 1 && vi === rn.vaps.length - 1);
      });
    });
  });

  // Clients Polaris could not file under any SSID are SHOWN, not dropped: the
  // alternative is a tree that quietly disagrees with the client count.
  if (tree.unplaced.length > 0) {
    rows += '<tr style="background:var(--color-surface-2,#8881)">' +
      '<td colspan="6"><strong>Not matched to a broadcast SSID</strong>' +
        _wirelessChip(tree.unplaced.length + " of " + stations.length,
          "These clients reported a BSSID or SSID no radio in the inventory is broadcasting — usually radios and stations scraped by different sources a cycle apart.") +
      '</td></tr>';
    tree.unplaced.forEach(function (s, i) {
      rows += _wirelessStationRow(s, "unplaced", "", i === tree.unplaced.length - 1);
    });
  }

  container.innerHTML =
    '<div class="table-wrapper"><table class="data-table" style="font-size:0.82rem"><thead><tr>' +
      '<th>Radio / SSID / Client</th>' +
      '<th>BSSID</th>' +
      '<th>IP</th>' +
      '<th>Endpoint</th>' +
      '<th>Channel / VLAN / Band</th>' +
      '<th style="text-align:right">Power / Signal</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';

  _wireWirelessBody(container, asset, collapsed);
}

// The Wireless tab body's two verbs — a radio / SSID row's ▶ / ▼ and a
// matched client's endpoint link — delegated from the body and bound once
// (CQ-F042): the tree and the flat list repaint whole on every keystroke in the
// tab's filter box. The latest paint's asset and collapsed set ride on the
// element, so the one listener always acts on what is on screen.
function _wireWirelessBody(container, asset, collapsed) {
  if (!container) return;
  container._wirelessState = { asset: asset, collapsed: collapsed };
  if (container.getAttribute("data-wireless-wired") === "1") return;
  container.setAttribute("data-wireless-wired", "1");
  container.addEventListener("click", function (e) {
    var t = e.target;
    if (!t || typeof t.closest !== "function") return;
    var st = container._wirelessState || {};
    var tog = t.closest(".wireless-expand-toggle");
    if (tog && container.contains(tog)) {
      e.stopPropagation();
      var parentKey = tog.getAttribute("data-parent");
      var expanded = tog.textContent.trim() === "▼";
      tog.textContent = expanded ? "▶" : "▼";
      tog.title = expanded ? "Expand" : "Collapse";
      container.querySelectorAll(".wireless-child").forEach(function (row) {
        if (row.getAttribute("data-parent") !== parentKey) return;
        row.style.display = expanded ? "none" : "";
      });
      if (st.collapsed) {
        if (expanded) st.collapsed.add(parentKey); else st.collapsed.delete(parentKey);
        _setCollapsedIfaces(st.asset && st.asset.id, st.collapsed, "wireless");
      }
      return;
    }
    // Click-through on a matched endpoint opens that asset's own details.
    var link = t.closest(".asset-station-link");
    if (link && container.contains(link)) {
      e.preventDefault();
      var linkedId = link.getAttribute("data-asset-id");
      if (linkedId) openViewModal(linkedId);
    }
  });
}

// Short band label for the Stations table. The backend derives band from the
// FortiAP's fapRadioTable ("2.4GHz" | "5GHz" | "6GHz"); render it compactly.
function _wirelessBandLabel(band) {
  if (band === "2.4GHz") return "2G";
  if (band === "5GHz")   return "5G";
  if (band === "6GHz")   return "6G";
  return "—";
}

// The Wireless tab's cadence · freshness · Refresh strip. Same cadence source
// as the stale banner directly below it (_resolveStaleStreamSec on the
// systemInfo stream), so the "every 1m" an operator reads is the figure the
// amber threshold uses. The full stream badge rather than a bare chip: which
// transport and credential answered is exactly what an operator asks next when
// the client list is empty, and the System tab already states it that way.
// The AP profile (fortinetTopology.profile, the same value as the General
// tab's AP Profile row) sits between the heading and the badge: it is the
// controller object that decides these radios and SSIDs, so it belongs next
// to them. Omitted until a discovery cycle has stamped it.
// The mesh role chip follows the profile (see _wirelessMeshRoleChipHTML).
function _wirelessStripHTML(asset, si) {
  var assetId = asset && asset.id;
  var topo = asset && asset.fortinetTopology;
  var profile = topo && typeof topo === "object" && typeof topo.profile === "string" ? topo.profile : "";
  return _currentStateStripHTML({
    title: "Wireless",
    suffixHTML: (profile
      ? '<span style="font-weight:400;color:var(--color-text-secondary)" ' +
          'title="AP profile this access point is bound to on its controller">' +
          'Profile: ' + escapeHtml(profile) + '</span>'
      : "") + _wirelessMeshRoleChipHTML(asset, si),
    chipHTML: asset ? _streamSourceBadgeHTML(asset, "interfaces") : "",
    lastAt: (si && si.lastSystemInfoAt) || (asset && asset.lastSystemInfoAt) || null,
    cadenceSec: _resolveStaleStreamSec(assetId, asset, "systemInfo"),
    neverText: "never collected",
    refreshId: "asset-wireless-refresh",
    refreshTitle: "Re-read this AP's radios, SSIDs and connected clients from the device now",
  });
}

// The AP's wireless-mesh role, as a chip on the Wireless strip:
//   leaf — FortiOS classifies its uplink as mesh (fortinetTopology.meshUplink,
//          stamped by discovery from the controller's mesh_uplink)
//   root — another access point is associated to it as a client (the same
//          signal dependency suppression uses for the root → leaf edge)
//   neither — no chip. An AP that is both (a mesh hop) shows both.
// The phone's Wireless sheet carries the same label (wirelessMeshRoleHtml in
// mobile/asset-detail.js) — change one, change both.
function _wirelessMeshRoleChipHTML(asset, si) {
  var topo = asset && asset.fortinetTopology;
  var isLeaf = !!topo && typeof topo === "object" && topo.meshUplink === "mesh";
  var parentSerial = isLeaf && typeof topo.parentApSerial === "string" ? topo.parentApSerial : "";
  var leaves = ((si && si.wirelessStations) || []).filter(function (s) {
    return s && s.matchedAsset && s.matchedAsset.assetType === "access_point";
  });
  var html = "";
  if (leaves.length > 0) {
    var names = leaves.map(function (s) { return s.matchedAsset.hostname || s.staMacAddr; });
    html += _wirelessChip("Mesh root",
      "Another access point is connected to this one as a wireless client — " +
      "this AP is a mesh root serving: " + names.join(", "));
  }
  if (isLeaf) {
    html += _wirelessChip("Mesh leaf",
      "The controller reports this AP's uplink as wireless mesh, not Ethernet" +
      (parentSerial ? " — parent AP serial " + parentSerial : ""));
  }
  return html;
}

// Re-read the system-info snapshot and repaint just this tab. Narrower than
// _loadSystemTabFor, which would also re-fetch telemetry history and repaint
// five other sections the operator is not looking at.
async function _reloadWirelessStations(assetId, asset) {
  var container = document.getElementById("asset-system-stations");
  if (!container) return;
  try {
    var si = await api.assets.systemInfo(assetId);
    // Shared with the System tab's own renderers — keep them on the same
    // snapshot rather than letting the two tabs disagree.
    if (_currentAssetForRefresh && _currentAssetForRefresh.id === assetId) _assetSystemSiCache = si;
    _renderWirelessStationsCard(container, si, asset);
  } catch (err) {
    showToast("Could not reload wireless data — " + ((err && err.message) || "unknown error"), "error");
  }
}

// Render the wireless-station table from the system-info response.
// Same shape as _renderLldpNeighborsCard — current-state list, no time
// series. Stations matched to a Polaris asset surface the asset name
// as a clickable link that opens the matched asset's details modal;
// unmatched stations just show the MAC.
function _renderWirelessStationsCard(container, si, asset) {
  if (!container) return;
  var stations = (si && si.wirelessStations) || [];
  var radios = (si && si.apRadios) || [];
  var assetId = asset && asset.id;
  // Every branch below replaces container.innerHTML, so the strip is wired
  // once here, after whichever branch ran.
  function wireStrip() {
    _wireCurrentStateRefresh("asset-wireless-refresh", assetId, function () {
      return _reloadWirelessStations(assetId, asset);
    });
  }
  if (radios.length === 0 && stations.length === 0) {
    var pollingLabel = _assetMonitorStreamSource(asset, "interfaces").polling || "the configured transport";
    container.innerHTML = _wirelessStripHTML(asset, si) +
      '<p class="empty-state" style="padding:1rem 0">' +
      'No radios or wireless clients reported yet. Radios and their SSIDs arrive with the next ' +
      'discovery run against the controlling FortiGate; connected clients come from the SNMP ' +
      'fapStationTable walk, which needs interfacesPolling set to SNMP (currently: ' +
      escapeHtml(pollingLabel) + ') on this AP.' +
      '</p>';
    wireStrip();
    return;
  }
  // The shell (strip + stale banner + filter box) renders ONCE and only the
  // table below it re-renders as the operator types — the ARP Table tab's
  // arrangement, for the same reason: rebuilding the input being typed into
  // loses the caret.
  var filter = _assetWirelessFilter[assetId] || "";
  var staleBanner = _staleBannerHTML(assetId, asset, "systemInfo", si && si.lastSystemInfoAt, _streamFailureError(si, "systemInfo"));
  container.innerHTML = _wirelessStripHTML(asset, si) + staleBanner +
    '<div style="display:flex;gap:0.6rem;align-items:center;flex-wrap:wrap;margin:0 0 0.5rem">' +
      '<input type="text" id="asset-wireless-filter" class="form-input" ' +
        'placeholder="Filter by MAC, IP, SSID, BSSID or hostname" ' +
        'style="max-width:22rem;font-size:0.82rem;flex:1 1 14rem" value="' + escapeHtml(filter) + '">' +
      '<span id="asset-wireless-counts" style="font-size:0.82rem;color:var(--color-text-secondary)"></span>' +
    '</div>' +
    '<div id="asset-wireless-body"></div>';
  var bodyEl = container.querySelector("#asset-wireless-body");
  var countsEl = container.querySelector("#asset-wireless-counts");

  function renderBody() {
    if (countsEl) {
      var shown = filter ? stations.filter(function (s) { return _wirelessStationMatches(s, filter); }).length : 0;
      countsEl.textContent = filter
        ? shown + " of " + stations.length + " client" + (stations.length === 1 ? "" : "s") + " match"
        : "";
    }
    // With radio inventory, the clients hang off the SSID they joined on the
    // radio broadcasting it. Without it — discovery has not run since the
    // feature shipped, or this AP is not controller-managed — fall back to the
    // flat list so the tab never regresses to empty while it fills in.
    if (radios.length > 0) _renderWirelessTree(bodyEl, radios, stations, asset, filter);
    else _renderWirelessFlatTable(bodyEl, stations, asset, filter);
  }

  var box = container.querySelector("#asset-wireless-filter");
  if (box) {
    // Debounced like the ARP box: a busy AP's client list re-renders whole.
    box.addEventListener("input", debounce(function () {
      filter = box.value.trim().toLowerCase();
      _assetWirelessFilter[assetId] = filter;
      renderBody();
    }, 150));
  }
  renderBody();
  wireStrip();
}

// The flat client list — the Wireless tab's fallback when the AP has no radio
// inventory yet. `filter` is already lower-cased.
function _renderWirelessFlatTable(container, stations, asset, filter) {
  // Stable sort: SSID → MAC. Same order the backend returns, but
  // re-establishing here lets the function stand on its own.
  stations.sort(function (a, b) {
    var sa = String(a.ssid || ""), sb = String(b.ssid || "");
    if (sa !== sb) return sa.localeCompare(sb);
    return String(a.staMacAddr).localeCompare(String(b.staMacAddr));
  });
  var shown = stations.filter(function (s) { return _wirelessStationMatches(s, filter); });
  if (shown.length === 0) {
    container.innerHTML = '<div class="empty-state">No clients match that filter.</div>';
    return;
  }
  var rows = shown.map(function (s) {
    var endpointHtml;
    if (s.matchedAsset && s.matchedAsset.id) {
      endpointHtml = '<a href="#" class="asset-station-link" data-asset-id="' + escapeHtml(s.matchedAsset.id) +
        '" style="color:var(--color-accent);text-decoration:none">' +
        escapeHtml(s.matchedAsset.hostname || s.matchedAsset.ipAddress || s.matchedAsset.id) +
        '</a>';
    } else {
      endpointHtml = '<span style="color:var(--color-text-tertiary)">(not in inventory)</span>';
    }
    var bandLabel   = _wirelessBandLabel(s.band);
    var signalLabel = (s.signalStrength != null) ? (s.signalStrength + " dBm") : "—";
    return '<tr>' +
      '<td>' + escapeHtml(s.ssid || "—") + '</td>' +
      '<td class="mono">' + escapeHtml(s.staMacAddr) + '</td>' +
      '<td class="mono">' + escapeHtml(s.staIpAddr || "—") + '</td>' +
      '<td>' + endpointHtml + '</td>' +
      '<td>' + escapeHtml(bandLabel) + '</td>' +
      '<td style="text-align:right">' + escapeHtml(signalLabel) + '</td>' +
    '</tr>';
  }).join("");
  container.innerHTML =
    '<div class="table-wrapper"><table class="data-table" style="font-size:0.82rem"><thead><tr>' +
      '<th data-col-id="ssid">SSID</th>' +
      '<th data-col-id="mac" data-col-required="true">MAC</th>' +
      '<th data-col-id="ip">IP</th>' +
      '<th data-col-id="endpoint" data-col-required="true">Endpoint</th>' +
      '<th data-col-id="band">Band</th>' +
      '<th style="text-align:right" data-col-id="signal">Signal</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  if (typeof applyTableLayout === "function") {
    applyTableLayout(container.querySelector("table"), _assetTableTypeKey("asset-wireless-stations", asset), {
      onScreenshot: function (t) { _screenshotTableEl(t, "Wireless Stations"); },
    });
  }

  // Click-through on matched-endpoint links — opens the endpoint asset's
  // own details modal directly; delegated with the tree's (_wireWirelessBody).
  _wireWirelessBody(container, asset, null);
}

// ─── Virtualization section (vCenter VMs + ESXi hosts) ─────────────────────
// Renders the General-tab Virtualization block from GET /assets/:id/
// virtualization. VM role: host link / cluster / power / Tools / vCPU+RAM /
// disks (datastore + backing array). Host role: cluster + connection state /
// datastores table / VMs-on-host list.
//
// GUEST FILESYSTEMS ARE NOT HERE. They are a monitored reading, not an
// inventory fact: the "vcenter" storage stream samples them every system-info
// pass, so they belong in the System tab's Storage table with the history,
// pinning and alerting every other device's mounts get. A second static copy
// on the General tab could only ever be a stale duplicate of that.

function _vcPowerBadge(state) {
  var s = String(state || "").toUpperCase();
  var label = s === "POWERED_ON" ? "Powered On" : s === "POWERED_OFF" ? "Powered Off" : s === "SUSPENDED" ? "Suspended" : (state || "—");
  var color = s === "POWERED_ON" ? "var(--color-success,#4caf50)" : s === "SUSPENDED" ? "var(--color-warning,#ffb74d)" : "var(--color-text-tertiary)";
  return '<span style="color:' + color + '">●</span> ' + escapeHtml(label);
}

// ─── Workload section (Unraid / TrueNAS SCALE) ─────────────────────────────
// The General-tab block for an asset whose virtualization blob carries a
// `platform` — a host (its pools + the VMs / containers placed on it) or a
// VM / container (its host, state, image, update status). VMs and containers
// get the business-rule-94 action bar once GET /assets/:id/workload answers
// with the live state; the bar is drawn only for assets:write.

function _wlStateBadge(state) {
  var s = String(state || "").toLowerCase();
  var label = s === "running" ? "Running" : s === "stopped" ? "Stopped" : s === "paused" ? "Paused" : (state ? String(state) : "—");
  var color = s === "running" ? "var(--color-success,#4caf50)" : s === "paused" ? "var(--color-warning,#ffb74d)" : "var(--color-text-tertiary)";
  return '<span style="color:' + color + '">●</span> ' + escapeHtml(label);
}

function _wlUpdateBadge(updateAvailable) {
  if (updateAvailable === true) return ' <span class="badge badge-update" title="The platform reports a newer image / version">Update available</span>';
  return "";
}

// What the network mode means for how Polaris can reach the container.
// Only drawn when it has no address of its own (unraidService.containerOwnIp
// decides that; `v.ip` is the result).
/** The workload integrations (Unraid, TrueNAS SCALE, Proxmox VE) — utils/workloadSources.ts's WORKLOAD_PLATFORMS. */
function _isWorkloadPlatform(p) {
  return p === "unraid" || p === "truenas" || p === "proxmox";
}

function _wlNetworkHint(v) {
  if (v.ip) return "";
  var m = String(v.networkMode || "").toLowerCase();
  var why = m === "host" ? "shares its host's network stack and address"
    : m.indexOf("container:") === 0 ? "shares another container's network"
    : v.platform === "truenas" ? "has no address of its own that TrueNAS publishes"
    : v.platform === "proxmox" ? "has no address Proxmox reports (none in its config, and none read while it was running)"
    : "is NATed behind its host's address";
  return ' <span style="color:var(--color-text-tertiary);font-size:0.85em">— ' + why + '</span>';
}

function _assetWorkloadHTML(res) {
  var v = res.virtualization || {};
  var isTn = v.platform === "truenas";
  var isPve = v.platform === "proxmox";
  var product = isPve ? "Proxmox VE" : isTn ? "TrueNAS SCALE" : "Unraid";
  var header = '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin:1.25rem 0 0.75rem 0">' + escapeHtml(product) + '</p>';
  var tableStyle = 'width:100%;border-collapse:collapse;font-size:0.83rem';
  var thStyle = 'text-align:left;padding:4px 8px;color:var(--color-text-tertiary);font-weight:500;border-bottom:1px solid var(--color-border)';
  var tdStyle = 'padding:4px 8px;border-bottom:1px solid var(--color-border)';

  if (v.role === "host") {
    var rows =
      '<div class="asset-view-grid">' +
        '<div class="detail-row"><span class="detail-label">Platform</span><span class="detail-value">' + escapeHtml((v.os || product) + (v.osVersion ? " " + v.osVersion : "")) + '</span></div>' +
        // A cluster node: what its peers said about it at the last discovery
        // (live up / down is the monitor status, which refreshes every tick).
        (v.hostKey ? '<div class="detail-row"><span class="detail-label">Cluster</span><span class="detail-value">' + (v.online === false ? '<span style="color:var(--color-danger)">Node offline</span>' : 'Node online') + ' <span style="color:var(--color-text-tertiary);font-size:0.85em">(at last discovery)</span></span></div>' : '') +
        (v.cpuCount != null ? '<div class="detail-row"><span class="detail-label">CPU Threads</span><span class="detail-value">' + escapeHtml(String(v.cpuCount)) + '</span></div>' : '') +
        (v.memTotalBytes != null ? '<div class="detail-row"><span class="detail-label">Memory</span><span class="detail-value">' + _fmtBytes(v.memTotalBytes) + '</span></div>' : '') +
        '<div class="detail-row"><span class="detail-label">Workloads</span><span class="detail-value">' + (v.vmCount || 0) + ' VM(s), ' + (v.containerCount || 0) + (isTn ? ' App(s)' : ' container(s)') + '</span></div>' +
      '</div>';
    // Pools are on the System tab's Storage table (kind and health as extra
    // columns), and the workloads on their own tab (_hostWorkloadsTabHTML).
    return header + rows;
  }

  // VM or container / App
  var hostAsset = res.hostAsset || null;
  var hostHtml = hostAsset
    ? '<a href="#" class="dep-tree-link" data-asset-id="' + escapeHtml(hostAsset.id) + '">' + escapeHtml(hostAsset.hostname || v.hostName || "host") + '</a>'
    : escapeHtml(v.hostName || "—");
  var isCtr = v.role === "container";
  var ports = Array.isArray(v.ports) ? v.ports : [];
  var body =
    '<div class="asset-view-grid">' +
      '<div class="detail-row"><span class="detail-label">Host</span><span class="detail-value">' + hostHtml + '</span></div>' +
      '<div class="detail-row"><span class="detail-label">State</span><span class="detail-value" data-wl-state>' + _wlStateBadge(v.state) + (v.rawState && String(v.rawState).toLowerCase() !== String(v.state || "").toLowerCase() ? ' <span style="color:var(--color-text-tertiary);font-size:0.85em">(' + escapeHtml(v.rawState) + ')</span>' : '') + '</span></div>' +
      (isCtr && v.image ? '<div class="detail-row"><span class="detail-label">Image</span><span class="detail-value mono">' + escapeHtml(v.image) + '</span></div>' : '') +
      (isCtr && v.version ? '<div class="detail-row"><span class="detail-label">Version</span><span class="detail-value">' + escapeHtml(v.version) + (v.latestVersion && v.latestVersion !== v.version ? ' <span style="color:var(--color-text-tertiary);font-size:0.85em">(latest ' + escapeHtml(v.latestVersion) + ')</span>' : '') + '</span></div>' : '') +
      // Proxmox has no image to update — an LXC is its own OS.
      (isCtr && !isPve ? '<div class="detail-row"><span class="detail-label">Updates</span><span class="detail-value" data-wl-update>' + (v.updateAvailable === true ? _wlUpdateBadge(true) : v.updateAvailable === false ? 'Up to date' : '<span style="color:var(--color-text-tertiary)">Not checked</span>') + '</span></div>' : '') +
      (isCtr && isTn && v.memberCount != null ? '<div class="detail-row"><span class="detail-label">Containers</span><span class="detail-value">' + escapeHtml(String(v.memberCount)) + '</span></div>' : '') +
      (isCtr && v.networkMode ? '<div class="detail-row"><span class="detail-label">Network</span><span class="detail-value"><span class="mono">' + escapeHtml(v.networkMode) + '</span>' + _wlNetworkHint(v) + '</span></div>' : '') +
      (ports.length > 0 ? '<div class="detail-row"><span class="detail-label">Ports</span><span class="detail-value mono">' + escapeHtml(ports.join(", ")) + '</span></div>' : '') +
      (!isCtr && v.cpuCount != null ? '<div class="detail-row"><span class="detail-label">vCPUs</span><span class="detail-value">' + escapeHtml(String(v.cpuCount)) + '</span></div>' : '') +
      (!isCtr && v.memoryBytes != null ? '<div class="detail-row"><span class="detail-label">Memory</span><span class="detail-value">' + _fmtBytes(v.memoryBytes) + '</span></div>' : '') +
      (v.autostart != null ? '<div class="detail-row"><span class="detail-label">Autostart</span><span class="detail-value">' + (v.autostart ? "Yes" : "No") + '</span></div>' : '') +
      (v.monitoringPausedByStop ? '<div class="detail-row"><span class="detail-label">Monitoring</span><span class="detail-value" style="color:var(--color-warning)">Paused — stopped from Polaris; starting it from here resumes monitoring</span></div>' : '') +
    '</div>' +
    // The action bar fills in once the live state arrives (_wireWorkloadActions).
    '<div data-wl-actions style="margin-top:0.6rem"></div>';
  return header + body;
}

/**
 * Fetch the live state and draw the action bar (business rule 94). Only for
 * assets:write — a reader sees the card without verbs. Every verb confirms;
 * a stop pauses monitoring unless "Keep monitoring while stopped" is ticked.
 */
function _wireWorkloadActions(mount, asset, res) {
  var v = (res && res.virtualization) || {};
  if (v.role !== "vm" && v.role !== "container") return;
  var bar = mount.querySelector("[data-wl-actions]");
  if (!bar || !(typeof canManageAssets === "function" && canManageAssets())) return;
  var name = asset.hostname || "this workload";
  var what = v.role === "vm" ? "VM" : (v.platform === "truenas" ? "App" : "container");
  bar.innerHTML = '<span style="color:var(--color-text-tertiary);font-size:0.85rem">Reading live state…</span>';

  // The platform reports an action done before the workload has settled — a
  // TrueNAS App comes back from app.upgrade / app.redeploy still DEPLOYING —
  // so after a verb the card re-reads until it reaches the state the verb
  // aims at, with the verbs held off meanwhile.
  var SETTLE_TARGET = { start: "running", restart: "running", update: "running", stop: "stopped" };
  var SETTLE_POLL_MS = 3000;
  var SETTLE_MAX_MS = 120000;

  // "other" is a transitional platform state (DEPLOYING); name it, not "other".
  function stateHtml(status) {
    return status.state === "other" && status.rawState ? _wlStateBadge(status.rawState) : _wlStateBadge(status.state);
  }

  function render(status, settling) {
    var verbs = settling ? [] : (status.verbs || []);
    var labels = { start: "Start", stop: "Stop", restart: "Restart", update: "Update" };
    var btns = verbs.map(function (verb) {
      var cls = verb === "stop" ? "btn-danger" : verb === "update" ? "btn-primary" : "btn-secondary";
      return '<button type="button" class="btn btn-sm ' + cls + '" data-wl-verb="' + verb + '" style="margin-right:6px">' + labels[verb] + '</button>';
    }).join("");
    // Proxmox is monitored read-only (a PVEAuditor token): no verbs, no update check.
    if (status.platform === "proxmox") {
      bar.innerHTML = '<span style="color:var(--color-text-tertiary);font-size:0.82rem">Read-only — Polaris monitors Proxmox guests but does not start or stop them.</span>';
      var pveState = mount.querySelector("[data-wl-state]");
      if (pveState) pveState.innerHTML = _wlStateBadge(status.state);
      return;
    }
    if (settling) {
      btns = '<span style="color:var(--color-text-tertiary);font-size:0.85rem">Waiting for "' + escapeHtml(name) + '" to settle…</span>';
    } else if (status.role === "container") {
      btns += '<button type="button" class="btn btn-sm btn-secondary" data-wl-check style="margin-right:6px">Check for updates</button>';
    }
    var keepMon = verbs.indexOf("stop") !== -1
      ? '<label style="display:inline-flex;align-items:center;gap:6px;font-size:0.82rem;margin-left:4px"><input type="checkbox" data-wl-keepmon style="width:auto"> Keep monitoring while stopped</label>'
      : "";
    bar.innerHTML = '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:4px">' + btns + keepMon + '</div>';
    var stateCell = mount.querySelector("[data-wl-state]");
    if (stateCell) stateCell.innerHTML = stateHtml(status);
    var updCell = mount.querySelector("[data-wl-update]");
    if (updCell) updCell.innerHTML = status.updateAvailable === true ? _wlUpdateBadge(true) : status.updateAvailable === false ? "Up to date" : '<span style="color:var(--color-text-tertiary)">Not checked</span>';

    Array.prototype.forEach.call(bar.querySelectorAll("[data-wl-verb]"), function (btn) {
      btn.addEventListener("click", async function () {
        var verb = btn.getAttribute("data-wl-verb");
        var keep = bar.querySelector("[data-wl-keepmon]");
        var pause = verb === "stop" && !(keep && keep.checked);
        var msg = verb === "update"
          ? "Update " + what + " \"" + name + "\" to the newest version " + (v.platform === "truenas" ? "TrueNAS" : "Unraid") + " offers?\n\nIt restarts during the update. Alerts are held for its duration."
          : verb === "restart"
          ? "Restart " + what + " \"" + name + "\"?\n\nAlerts are held while it restarts."
          : verb === "stop"
          ? "Stop " + what + " \"" + name + "\"?" + (pause ? "\n\nMonitoring is paused until it is started again from Polaris." : "\n\nMonitoring stays on, so it will be reported down.")
          : "Start " + what + " \"" + name + "\"?";
        if (!(await showConfirm(msg))) return;
        Array.prototype.forEach.call(bar.querySelectorAll("button"), function (b) { b.disabled = true; });
        btn.textContent = verb === "update" ? "Updating…" : verb === "restart" ? "Restarting…" : verb === "stop" ? "Stopping…" : "Starting…";
        try {
          var r = await api.assets.workloadAction(asset.id, verb, verb === "stop" ? { pauseMonitoring: pause } : {});
          showToast((r && r.message) || "Done", "success");
        } catch (err) {
          showToast((err && err.message) || "Action failed", "error");
          load();
          return;
        }
        settle(SETTLE_TARGET[verb], Date.now() + SETTLE_MAX_MS);
      });
    });
    var check = bar.querySelector("[data-wl-check]");
    if (check) {
      check.addEventListener("click", async function () {
        check.disabled = true;
        check.textContent = "Checking…";
        try {
          render(await api.assets.workloadCheckUpdates(asset.id));
        } catch (err) {
          showToast((err && err.message) || "Update check failed", "error");
          check.disabled = false;
          check.textContent = "Check for updates";
        }
      });
    }
  }

  function showError(err) {
    bar.innerHTML = '<span style="color:var(--color-text-tertiary);font-size:0.85rem">' + escapeHtml((err && err.message) || "Live state unavailable") + '</span>';
  }

  function load() {
    api.assets.workload(asset.id).then(function (s) { render(s); }).catch(showError);
  }

  // Re-read until the workload reaches `target` or the deadline passes; a
  // closed panel (bar detached) stops the loop.
  function settle(target, deadline) {
    api.assets.workload(asset.id).then(function (s) {
      if (!bar.isConnected) return;
      var waiting = target && s.state !== target && Date.now() < deadline;
      render(s, waiting);
      if (waiting) setTimeout(function () { settle(target, deadline); }, SETTLE_POLL_MS);
    }).catch(showError);
  }
  load();
}

function _assetVirtualizationHTML(res) {
  if (res && res.virtualization && _isWorkloadPlatform(res.virtualization.platform)) {
    return _assetWorkloadHTML(res);
  }
  var v = res.virtualization || {};
  var header = '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin:1.25rem 0 0.75rem 0">Virtualization</p>';
  var tableStyle = 'width:100%;border-collapse:collapse;font-size:0.83rem';
  var thStyle = 'text-align:left;padding:4px 8px;color:var(--color-text-tertiary);font-weight:500;border-bottom:1px solid var(--color-border)';
  var tdStyle = 'padding:4px 8px;border-bottom:1px solid var(--color-border)';

  if (v.role === "vm") {
    var hostAsset = res.hostAsset || null;
    var hostHtml = hostAsset
      ? '<a href="#" class="dep-tree-link" data-asset-id="' + escapeHtml(hostAsset.id) + '">' + escapeHtml(hostAsset.hostname || v.hostName || v.hostMoref || "host") + '</a>'
      : escapeHtml(v.hostName || v.hostMoref || "—");
    var dsByMoref = {};
    (res.diskDatastores || []).forEach(function (d) { dsByMoref[d.moref] = d; });

    var rows =
      '<div class="asset-view-grid">' +
        '<div class="detail-row"><span class="detail-label">Running Host</span><span class="detail-value">' + hostHtml + (v.standaloneHost ? ' <span style="color:var(--color-text-tertiary);font-size:0.8em">(standalone)</span>' : '') + '</span></div>' +
        (v.clusterName ? '<div class="detail-row"><span class="detail-label">Cluster</span><span class="detail-value">' + escapeHtml(v.clusterName) + '</span></div>' : '') +
        '<div class="detail-row"><span class="detail-label">Power State</span><span class="detail-value">' + _vcPowerBadge(v.powerState) + '</span></div>' +
        (v.toolsRunState ? '<div class="detail-row"><span class="detail-label">VMware Tools</span><span class="detail-value">' + escapeHtml(v.toolsRunState) + (v.toolsVersionStatus ? ' <span style="color:var(--color-text-tertiary);font-size:0.85em">(' + escapeHtml(v.toolsVersionStatus) + ')</span>' : '') + '</span></div>' : '') +
        (v.cpuCount != null ? '<div class="detail-row"><span class="detail-label">vCPUs</span><span class="detail-value">' + v.cpuCount + (v.cpuUsageMhz != null ? ' <span style="color:var(--color-text-tertiary);font-size:0.85em">(' + v.cpuUsageMhz + ' MHz in use' + (v.cpuMaxMhz ? ' of ' + v.cpuMaxMhz : '') + ')</span>' : '') + '</span></div>' : '') +
        (v.memoryMiB != null ? '<div class="detail-row"><span class="detail-label">Memory</span><span class="detail-value">' + _fmtBytes(v.memoryMiB * 1024 * 1024) + (v.memUsedBytes != null ? ' <span style="color:var(--color-text-tertiary);font-size:0.85em">(' + _fmtBytes(v.memUsedBytes) + ' in use)</span>' : '') + '</span></div>' : '') +
      '</div>';

    var disksHtml = "";
    if (Array.isArray(v.disks) && v.disks.length > 0) {
      disksHtml = '<div style="margin-top:0.75rem;overflow-x:auto"><table style="' + tableStyle + '">' +
        '<thead><tr><th style="' + thStyle + '">Disk</th><th style="' + thStyle + '">Capacity</th><th style="' + thStyle + '">Datastore</th><th style="' + thStyle + '">Backing</th></tr></thead><tbody>' +
        v.disks.map(function (d) {
          var ds = d.datastoreMoref ? dsByMoref[d.datastoreMoref] : null;
          return '<tr>' +
            '<td style="' + tdStyle + '">' + escapeHtml(d.label || d.key) + '</td>' +
            '<td style="' + tdStyle + '">' + _fmtBytes(d.capacityBytes) + '</td>' +
            '<td style="' + tdStyle + '">' + escapeHtml((ds && ds.name) || d.datastoreName || "—") + '</td>' +
            '<td style="' + tdStyle + '">' + escapeHtml((ds && ds.backingLabel) || "—") + '</td>' +
          '</tr>';
        }).join("") +
      '</tbody></table></div>';
    }

    return header + rows + disksHtml;
  }

  if (v.role === "host") {
    var rowsHost =
      '<div class="asset-view-grid">' +
        (v.clusterName
          ? '<div class="detail-row"><span class="detail-label">Cluster</span><span class="detail-value">' + escapeHtml(v.clusterName) + '</span></div>'
          : '<div class="detail-row"><span class="detail-label">Cluster</span><span class="detail-value" style="color:var(--color-text-tertiary)">Standalone host</span></div>') +
        (v.connectionState ? '<div class="detail-row"><span class="detail-label">Connection</span><span class="detail-value">' + escapeHtml(v.connectionState) + '</span></div>' : '') +
        (v.powerState ? '<div class="detail-row"><span class="detail-label">Power State</span><span class="detail-value">' + _vcPowerBadge(v.powerState) + '</span></div>' : '') +
      '</div>';

    // Virtual networking. INVENTORY only — which switches exist, what uplinks
    // them, which port group carries which VLAN. The live half (uplink link
    // state, the vmk's address, and the vSwitch nesting itself) is on the
    // System tab's interface table, where the `vcenter` interfaces stream
    // writes vSwitches as `aggregate` rows with the uplinks and VMkernel ports
    // as their children — the same shape a FortiSwitch trunk draws. Teaming
    // policy and port-group VLANs have no live half, so they live here.
    var vsw = Array.isArray(v.vswitches) ? v.vswitches : [];
    var pgs = Array.isArray(v.portgroups) ? v.portgroups : [];
    var vswHtml = "";
    if (vsw.length > 0) {
      // Port groups are listed under the switch that carries them, so an
      // operator reads one switch's whole story on one row block. A
      // distributed switch has none here by construction: its port groups
      // belong to the DVS object, not to this host.
      var pgByVsw = {};
      pgs.forEach(function (p) {
        var k = p.vswitchName || "";
        if (!pgByVsw[k]) pgByVsw[k] = [];
        pgByVsw[k].push(p);
      });
      vswHtml = '<div style="margin-top:0.75rem;overflow-x:auto"><table style="' + tableStyle + '">' +
        '<thead><tr><th style="' + thStyle + '">Virtual Switch</th><th style="' + thStyle + '">Uplinks</th><th style="' + thStyle + '">MTU</th><th style="' + thStyle + '">Ports</th><th style="' + thStyle + '">Teaming</th><th style="' + thStyle + '">Port Groups</th></tr></thead><tbody>' +
        vsw.map(function (s) {
          var kind = s.distributed
            ? ' <span style="color:var(--color-text-tertiary);font-size:0.8em">(distributed)</span>'
            : '';
          var uplinks = Array.isArray(s.uplinks) && s.uplinks.length > 0
            ? s.uplinks.map(function (u) { return '<span class="mono">' + escapeHtml(u) + '</span>'; }).join(", ")
            : '<span style="color:var(--color-text-tertiary)">none (internal)</span>';
          var ports = s.numPorts != null
            ? (s.numPortsAvailable != null ? s.numPortsAvailable + " free of " + s.numPorts : String(s.numPorts))
            : "—";
          var mine = pgByVsw[s.name] || [];
          var pgText = mine.length > 0
            ? mine.map(function (p) {
                // VLAN 0 is untagged and 4095 is VGT (the guest tags its own
                // frames) — both are real answers, so spell them out rather
                // than printing a number that reads like a VLAN id.
                var vlan = p.vlanId == null ? "" :
                  p.vlanId === 0 ? " (untagged)" :
                  p.vlanId === 4095 ? " (VLAN trunk)" :
                  " (VLAN " + p.vlanId + ")";
                return escapeHtml(p.name) + vlan;
              }).join("<br>")
            : '<span style="color:var(--color-text-tertiary)">—</span>';
          return '<tr>' +
            '<td style="' + tdStyle + '">' + escapeHtml(s.name) + kind + '</td>' +
            '<td style="' + tdStyle + '">' + uplinks + '</td>' +
            '<td style="' + tdStyle + '">' + (s.mtu != null ? s.mtu : "—") + '</td>' +
            '<td style="' + tdStyle + '">' + escapeHtml(ports) + '</td>' +
            '<td style="' + tdStyle + '">' + escapeHtml(s.teamingPolicy || "—") + '</td>' +
            '<td style="' + tdStyle + '">' + pgText + '</td>' +
          '</tr>';
        }).join("") +
      '</tbody></table></div>';
    }

    // Datastores are on the System tab's Storage table (with their type,
    // backing and provisioned figures as extra columns — _storageDetailsFor),
    // and the VMs on this host on their own tab (_hostWorkloadsTabHTML).
    return header + rowsHost + vswHtml;
  }

  return "";
}

// ─── Hypervisor: the workloads tab ──────────────────────────────────────────
// A hypervisor host — an ESXi host from vCenter, an Unraid or TrueNAS SCALE
// box — lists what runs on it on a tab of its own rather than at the foot of
// the General tab, where a host with forty VMs pushed everything else off it.
// Filled from the same GET /assets/:id/virtualization the General tab reads.

function _hostWorkloadsTabEligible(a) {
  var v = a && a.virtualization;
  return !!(v && v.role === "host");
}

function _hostWorkloadsTabLabel(a) {
  var v = (a && a.virtualization) || {};
  if (v.platform === "truenas") return "VMs & Apps";
  if (v.platform === "unraid" || v.platform === "proxmox") return "VMs & Containers";
  return "Virtual Machines";
}

function _hostWorkloadsTabHTML(a) {
  return '<div data-shot-section="workloads" data-shot-label="' + escapeHtml(_hostWorkloadsTabLabel(a)) + '">' +
    '<div id="asset-workloads-mount-' + escapeHtml(a.id) + '"><p class="empty-state">Loading…</p></div></div>';
}

function _hostWorkloadsBodyHTML(res) {
  var v = (res && res.virtualization) || {};
  var tableStyle = 'width:100%;border-collapse:collapse;font-size:0.83rem';
  var thStyle = 'text-align:left;padding:4px 8px;color:var(--color-text-tertiary);font-weight:500;border-bottom:1px solid var(--color-border)';
  var tdStyle = 'padding:4px 8px;border-bottom:1px solid var(--color-border)';
  var monitorCell = function (w) {
    return w.monitored ? escapeHtml(w.monitorStatus || "—") : '<span style="color:var(--color-text-tertiary)">not monitored</span>';
  };
  var link = function (w) {
    return '<a href="#" class="dep-tree-link" data-asset-id="' + escapeHtml(w.id) + '">' + escapeHtml(w.hostname || w.id) + '</a>';
  };

  if (_isWorkloadPlatform(v.platform)) {
    var isTn = v.platform === "truenas";
    var wls = res.workloads || [];
    if (wls.length === 0) return '<p class="empty-state">No VMs or ' + (isTn ? "Apps" : "containers") + ' on this ' + (v.platform === "proxmox" ? "node" : "host") + '.</p>';
    return '<div style="overflow-x:auto"><table style="' + tableStyle + '">' +
      '<thead><tr><th style="' + thStyle + '">Workload</th><th style="' + thStyle + '">Kind</th><th style="' + thStyle + '">State</th><th style="' + thStyle + '">Network</th><th style="' + thStyle + '">Monitor</th></tr></thead><tbody>' +
      wls.map(function (w) {
        var kind = w.role === "vm" ? "VM" : (isTn ? "App" : "Container");
        return '<tr>' +
          '<td style="' + tdStyle + '">' + link(w) + _wlUpdateBadge(w.updateAvailable) + '</td>' +
          '<td style="' + tdStyle + '">' + kind + '</td>' +
          '<td style="' + tdStyle + '">' + _wlStateBadge(w.state) + '</td>' +
          '<td style="' + tdStyle + '">' + (w.networkMode ? '<span class="mono">' + escapeHtml(w.networkMode) + '</span>' : '<span style="color:var(--color-text-tertiary)">—</span>') + '</td>' +
          '<td style="' + tdStyle + '">' + monitorCell(w) + '</td>' +
        '</tr>';
      }).join("") +
      '</tbody></table></div>';
  }

  var vms = res.vms || [];
  if (vms.length === 0) return '<p class="empty-state">No virtual machines on this host.</p>';
  return '<div style="overflow-x:auto"><table style="' + tableStyle + '">' +
    '<thead><tr><th style="' + thStyle + '">Virtual Machine</th><th style="' + thStyle + '">Power</th><th style="' + thStyle + '">Monitor</th></tr></thead><tbody>' +
    vms.map(function (vm) {
      return '<tr>' +
        '<td style="' + tdStyle + '">' + link(vm) + '</td>' +
        '<td style="' + tdStyle + '">' + _vcPowerBadge(vm.powerState) + '</td>' +
        '<td style="' + tdStyle + '">' + monitorCell(vm) + '</td>' +
      '</tr>';
    }).join("") +
    '</tbody></table></div>';
}

// Per-volume facts the storage stream does not carry — a vCenter datastore's
// type, backing array and provisioned size, an Unraid / TrueNAS pool's kind and
// health — keyed by the name the Storage table's rows use as their mount path.
// Set when GET /assets/:id/virtualization lands; the Storage table re-renders
// then (it may have drawn first).
var _assetStorageDetails = null; // { assetId, byName: { [name]: { type, health, backing, provisionedBytes, accessible } } }

function _setStorageDetailsFromVirtualization(assetId, res) {
  var v = (res && res.virtualization) || {};
  var byName = {};
  if (v.role === "host" && _isWorkloadPlatform(v.platform)) {
    (Array.isArray(v.pools) ? v.pools : []).forEach(function (p) {
      if (!p || !p.name) return;
      var fs = p.filesystem ? String(p.filesystem).replace(/^unraid-array/, "Unraid array") : null;
      byName[p.name] = {
        type: fs || p.kind || null,
        health: p.health || null,
        healthDetail: p.healthDetail || null,
        scan: p.scan || null,
        groups: Array.isArray(p.groups) ? p.groups : null,
      };
    });
  } else if (v.role === "host") {
    (res.datastores || []).forEach(function (d) {
      if (!d || !d.name) return;
      byName[d.name] = {
        type: d.dsType || null,
        backing: d.backingLabel || null,
        provisionedBytes: d.provisionedBytes != null ? Number(d.provisionedBytes) : null,
        accessible: d.accessible,
      };
    });
  }
  _assetStorageDetails = Object.keys(byName).length > 0 ? { assetId: assetId, byName: byName } : null;
}

function _storageDetailsFor(asset) {
  return asset && _assetStorageDetails && _assetStorageDetails.assetId === asset.id ? _assetStorageDetails.byName : null;
}
