/**
 * public/js/assets-software.js — the Software and Services tabs, and the service / process detail
 * slide-ins (history, connections, logs, log-flag rules).
 *
 * Part of the Assets page script (CQ-F050): plain browser scripts sharing
 * page globals, loaded right after assets.js on every page that carries it
 * and in app-panels.js's asset bundle, in ASSETS_FILES order. Nothing here
 * runs at load beyond listener wiring. See tests/unit/assetsSplit.test.ts.
 */

// ─── Services tab (units + optional processes) ──────────────────────────────
// Merged current-state inventory: systemd units / Windows services always, and
// — when the operator ticks "Include processes" — the per-program process
// inventory folded into the same table. A service backed by a shared runtime
// (e.g. a Spring Boot app running as "java") shows up as its unit; the "java"
// process row appears only with processes included. Two pin columns — Monitor
// and Logs are combined into one, since a row is either a service or a process,
// never both:
//   Monitor — a service's journal tailing (monitoredServices) OR a process's
//             CPU/RAM history + logs (monitoredProcesses); one checkbox per row,
//             whichever applies to that row's kind
//   Map     — both (mappedProcesses / mappedServices: Application Map)
// (Process alerting moved to Automations, so there's no Alert column.)
// Client-side TableSF for sort/filter; lazy-loaded on first tab click.
// ─── Software tab ───────────────────────────────────────────────────────────
// Installed programs + versions (GET /assets/:id/software). Up to three
// sources hold a list — the Polaris Agent, Intune detected apps, Azure Change
// Tracking — and the tab shows ONE at a time: the server lists them in
// preference order (agent first, it reads the host itself) and a picker
// appears only when there is more than one. Read-only.

var _SOFTWARE_SOURCE_LABELS = { agent: "Polaris Agent", intune: "Intune", arc: "Azure Arc" };

function _assetSoftwareTabHTML() {
  // The current-state strip's layout (_currentStateStripHTML — the MAC / ARP
  // tabs): a plain row, heading + tertiary stamp left, controls right. Not
  // .filter-bar, which is the page-level sticky bar with its own opaque
  // background and reads as a slab inside the slide-over. The strip helper
  // itself is not reused because its Refresh re-probes the device; this one
  // only re-reads what the sources last reported.
  return '<div class="section-block">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;flex-wrap:wrap;margin:0 0 0.5rem">' +
      '<div id="asset-view-sw-head" style="display:flex;align-items:baseline;gap:0.5rem;flex-wrap:wrap">' +
        '<h4 style="margin:0">Installed software</h4>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:0.5rem;flex:none">' +
        '<select id="asset-view-sw-source" class="form-input" style="display:none;padding:2px 6px;font-size:0.82rem;width:auto" aria-label="Software source"></select>' +
        '<button type="button" class="btn btn-glyph btn-glyph-refresh btn-secondary btn-sm" id="asset-view-sw-refresh" title="Re-read the stored lists">Refresh</button>' +
      '</div>' +
    '</div>' +
    '<p id="asset-view-sw-hint" style="margin:-0.25rem 0 0.5rem;font-size:0.78rem;color:var(--color-text-tertiary);display:none"></p>' +
    '<div class="table-wrapper table-wrapper-panel-sticky" id="asset-view-sw-wrapper">' +
      '<table id="asset-view-sw-table">' +
        '<thead><tr>' +
          // Name declares its width: the last visible column auto-fills the
          // leftover, so an undeclared Name would be the one starved.
          '<th style="width:230px" data-col-id="name"      data-col-required="true" data-sf-key="sortName" data-sf-type="string">Name</th>' +
          '<th style="width:110px" data-col-id="version"   data-sf-key="version"     data-sf-type="string">Version</th>' +
          '<th style="width:140px" data-col-id="publisher" data-sf-key="publisher"   data-sf-type="string">Publisher</th>' +
          // Arch and Size start hidden (column chooser): six columns starve
          // Name in the slide-over's width, and most names carry the arch.
          '<th style="width:64px"  data-col-id="arch"      data-col-default-hidden="true" data-sf-key="architecture" data-sf-type="string">Arch</th>' +
          '<th style="width:96px"  data-col-id="installed" data-sf-key="installDate" data-sf-type="string" data-sf-nofilter>Installed</th>' +
          '<th style="width:84px"  data-col-id="size"      data-col-default-hidden="true" data-sf-key="sizeSort" data-sf-type="number" data-sf-nofilter>Size</th>' +
        '</tr></thead>' +
        '<tbody id="asset-view-sw-tbody">' +
          '<tr><td colspan="6" class="empty-state">Loading…</td></tr>' +
        '</tbody>' +
      '</table>' +
    '</div>' +
  '</div>';
}

function _sizeAssetSwTableWrapper() {
  var w = document.getElementById("asset-view-sw-wrapper");
  var body = document.getElementById("asset-panel-body");
  if (!w || !body || !w.offsetParent) return;
  var h = body.getBoundingClientRect().bottom - w.getBoundingClientRect().top - 18;
  w.style.maxHeight = Math.max(260, Math.round(h)) + "px";
}
window.addEventListener("resize", _sizeAssetSwTableWrapper);

// The strip's left half after the heading: count · source, then the same
// "updated …" stamp the MAC / ARP strips carry. With one source the picker is
// hidden, so the source is named here.
function _softwareHeadSuffixHTML(sources, shown) {
  if (!sources.length) return _freshnessStampHTML(null, null, "nothing reported yet");
  var s = sources.filter(function (x) { return x.source === shown; })[0] || sources[0];
  var label = _SOFTWARE_SOURCE_LABELS[s.source] || s.source;
  return '<span style="font-size:0.72rem;color:var(--color-text-tertiary)">' +
      escapeHtml(String(s.count)) + ' program' + (s.count === 1 ? '' : 's') +
      (sources.length > 1 ? '' : ' · ' + escapeHtml(label)) + '</span>' +
    _freshnessStampHTML(s.scrapedAt, null, "not read yet");
}

// The hint under the strip — only when there is something to say: with no
// list, the three ways to get one; for Intune / Arc, the caveat that explains
// a list that looks short or stale. The agent's list needs no note.
function _softwareHintHTML(sources, shown) {
  if (!sources.length) {
    return 'One comes from the <strong>Polaris Agent</strong> (read every six hours), ' +
      'from <strong>Intune</strong>\'s detected apps (turn on <em>Read installed software</em> on the Entra ID integration), ' +
      'or from <strong>Azure Change Tracking</strong> (turn it on on the Azure Arc integration).';
  }
  var s = sources.filter(function (x) { return x.source === shown; })[0] || sources[0];
  if (s.source === "intune") return 'Intune lists unmanaged apps only on corporate-owned devices.';
  if (s.source === "arc") return 'An uninstalled program can stay listed for up to three days.';
  return "";
}

function _wireAssetSoftwareTab(asset) {
  var btn = document.querySelector('#asset-view-tabs [data-tab="software"]');
  if (!btn) return;
  var assetId = asset.id;
  var loaded = false;
  var sf = null;
  var layoutApplied = false;
  var sources = [];
  var allRows = [];
  var shown = null;

  function rowsForShown() {
    return allRows.filter(function (r) { return r.source === shown; }).map(function (r) {
      return {
        name: r.name,
        sortName: (r.name || "").toLowerCase(),
        version: r.version || "",
        publisher: r.publisher || "",
        architecture: r.architecture || "",
        installDate: r.installDate || "",
        sizeSort: r.sizeBytes != null ? Number(r.sizeBytes) : -1,
        sizeBytes: r.sizeBytes,
      };
    });
  }

  function renderRows(rows) {
    var tbody = document.getElementById("asset-view-sw-tbody");
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">' +
        (sources.length ? "No programs match the filters." : "No installed software reported.") + '</td></tr>';
      return;
    }
    var html = "";
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      html += '<tr>' +
        '<td title="' + escapeHtml(r.name) + '">' + escapeHtml(r.name) + '</td>' +
        '<td class="mono" title="' + escapeHtml(r.version) + '">' + escapeHtml(r.version || "—") + '</td>' +
        '<td title="' + escapeHtml(r.publisher) + '">' + escapeHtml(r.publisher || "—") + '</td>' +
        '<td>' + escapeHtml(r.architecture || "—") + '</td>' +
        '<td>' + escapeHtml(r.installDate || "—") + '</td>' +
        '<td>' + (r.sizeBytes != null ? escapeHtml(_fmtBytes(Number(r.sizeBytes))) : "—") + '</td>' +
      '</tr>';
    }
    tbody.innerHTML = html;
  }

  function apply() {
    var rows = rowsForShown();
    renderRows(sf ? sf.apply(rows) : rows);
  }

  function renderHeader() {
    var head = document.getElementById("asset-view-sw-head");
    if (head) head.innerHTML = '<h4 style="margin:0">Installed software</h4>' + _softwareHeadSuffixHTML(sources, shown);
    var hint = document.getElementById("asset-view-sw-hint");
    if (hint) {
      var text = _softwareHintHTML(sources, shown);
      hint.innerHTML = text;
      hint.style.display = text ? "" : "none";
    }
    var sel = document.getElementById("asset-view-sw-source");
    if (!sel) return;
    if (sources.length > 1) {
      sel.innerHTML = sources.map(function (s) {
        return '<option value="' + escapeHtml(s.source) + '"' + (s.source === shown ? " selected" : "") + '>' +
          escapeHtml(_SOFTWARE_SOURCE_LABELS[s.source] || s.source) + ' (' + escapeHtml(String(s.count)) + ')</option>';
      }).join("");
      sel.value = shown;
      sel.style.display = "";
    } else {
      sel.style.display = "none";
    }
  }

  // Order matters (see _wireAssetServicesTab): TableSF first, then the layout.
  function ensureTableWiring() {
    if (!sf && typeof TableSF !== "undefined") {
      sf = new TableSF("asset-view-sw-tbody", apply);
      var swRefresh = document.getElementById("asset-view-sw-refresh");
      sf.addClearButton(swRefresh && swRefresh.parentElement);
    }
    if (!layoutApplied && typeof applyTableLayout === "function") {
      var t = document.getElementById("asset-view-sw-table");
      if (t) {
        applyTableLayout(t, "asset-software", {
          onScreenshot: function (el) { _screenshotTableEl(el, "Software"); },
        });
        layoutApplied = true;
      }
    }
  }

  async function reload() {
    var tbody = document.getElementById("asset-view-sw-tbody");
    try {
      var resp = await api.assets.software(assetId);
      sources = (resp && resp.sources) || [];
      allRows = (resp && resp.rows) || [];
      var still = sources.some(function (s) { return s.source === shown; });
      if (!still) shown = sources.length ? sources[0].source : null;
      renderHeader();
      ensureTableWiring();
      apply();
      _sizeAssetSwTableWrapper();
    } catch (err) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Error: ' + escapeHtml(err && err.message ? err.message : String(err)) + '</td></tr>';
    }
  }

  var sel = document.getElementById("asset-view-sw-source");
  if (sel) sel.addEventListener("change", function () {
    shown = sel.value;
    renderHeader();
    apply();
  });
  var refresh = document.getElementById("asset-view-sw-refresh");
  if (refresh) refresh.addEventListener("click", function () { reload(); });

  btn.addEventListener("click", function () {
    _sizeAssetSwTableWrapper();
    if (loaded) return;
    loaded = true;
    reload();
  });
}

function _assetServicesTabHTML() {
  return '<div class="section-block">' +
    '<div class="filter-bar" style="justify-content:space-between;align-items:flex-start;gap:1rem;margin-bottom:0.5rem">' +
      '<p class="hint" style="margin:0;max-width:600px">systemd units (Linux) and Windows services reported by the Polaris Agent. Check <strong>Monitor</strong> to collect a service\'s log (its journal on Linux, its Event Log entries on Windows) — or, for a process, to collect its CPU/RAM history + logs — and <strong>Map</strong> to attribute connections on the <a href="/appmap.html">Application Map</a>. Click a row to open it.</p>' +
      '<div style="display:flex;align-items:center;gap:0.75rem;flex:none">' +
        '<label style="display:flex;align-items:center;gap:5px;font-size:0.8rem;white-space:nowrap"><input type="checkbox" id="asset-view-svc-include-proc">Include processes</label>' +
        '<button class="btn btn-glyph btn-glyph-refresh btn-secondary btn-sm" id="asset-view-svc-refresh" title="Refresh">Refresh</button>' +
      '</div>' +
    '</div>' +
    '<div class="table-wrapper table-wrapper-panel-sticky" id="asset-view-svc-wrapper">' +
      '<table id="asset-view-svc-table">' +
        '<thead><tr>' +
          '<th class="svc-pin-col" style="width:58px" data-col-id="monitor" data-col-required="true">Monitor</th>' +
          '<th class="svc-pin-col" style="width:40px" data-col-id="map"     data-col-required="true">Map</th>' +
          '<th                      data-col-id="name"  data-col-required="true" data-sf-key="sortName"  data-sf-type="string">Name</th>' +
          '<th style="width:90px"  data-col-id="type"  data-sf-key="typeLabel" data-sf-type="string">Type</th>' +
          '<th style="width:120px" data-col-id="state" data-sf-key="stateSort" data-sf-options="active|inactive|failed">State</th>' +
          '<th style="width:80px"  data-col-id="cpu"   data-sf-key="cpuPct"    data-sf-type="number" data-sf-nofilter>CPU %</th>' +
          '<th style="width:100px" data-col-id="mem"   data-sf-key="memSort"   data-sf-type="number" data-sf-nofilter>Memory</th>' +
        '</tr></thead>' +
        '<tbody id="asset-view-svc-tbody">' +
          '<tr><td colspan="7" class="empty-state">Loading…</td></tr>' +
        '</tbody>' +
      '</table>' +
    '</div>' +
  '</div>';
}

// Colored state pill — active/running green, failed red, activating/deactivating
// amber, everything else (inactive/stopped/dead) muted grey.
function _svcStatePill(activeState) {
  var s = (activeState || "").toLowerCase();
  var color = "var(--color-text-tertiary)";
  if (s === "active" || s === "running") color = "var(--color-success)";
  else if (s === "failed") color = "var(--color-danger)";
  else if (s === "activating" || s === "deactivating" || s === "reloading") color = "var(--color-warning)";
  var label = activeState ? escapeHtml(activeState) : "—";
  return '<span style="display:inline-flex;align-items:center;gap:5px">' +
    '<span style="width:8px;height:8px;border-radius:50%;background:' + color + ';flex:none"></span>' + label + '</span>';
}

// Startup type in the Windows Services console's own words; a systemd
// enablement state (enabled/disabled/static/…) is shown as reported.
var _WIN_START_MODE_LABELS = {
  "auto": "Automatic",
  "auto-delayed": "Automatic (Delayed Start)",
  "manual": "Manual",
  "disabled": "Disabled",
  "boot": "Boot",
  "system": "System",
};
function _svcStartupLabel(svc) {
  var e = svc && svc.enabledState;
  if (!e) return "—";
  if (svc.platform === "windows" && _WIN_START_MODE_LABELS[e]) return _WIN_START_MODE_LABELS[e];
  return e;
}

// mainPid → the units running in that process. On Windows several services
// can share one svchost.exe, and each then reports the WHOLE process's CPU and
// memory — the table and the slide-in mark those figures as shared rather than
// letting a group's total read as each member's own.
function _svcSharedProcessIndex(rows) {
  var byPid = {};
  (rows || []).forEach(function (s) {
    if (!s.mainPid) return;
    (byPid[s.mainPid] = byPid[s.mainPid] || []).push(s.unit);
  });
  return byPid;
}

function _svcSharedTagHTML(svc, byPid) {
  var units = svc.mainPid ? (byPid[svc.mainPid] || []) : [];
  if (units.length < 2) return "";
  var proc = svc.mainProcess || "one process";
  var title = "Shared: " + units.length + " services run in " + proc + " (PID " + svc.mainPid + "). The figure is the whole process, not this service alone.";
  return ' <span title="' + escapeHtml(title) + '" style="font-size:0.7rem;color:var(--color-text-tertiary)">shared</span>';
}

function _sizeAssetSvcTableWrapper() {
  var w = document.getElementById("asset-view-svc-wrapper");
  var body = document.getElementById("asset-panel-body");
  if (!w || !body || !w.offsetParent) return;
  var h = body.getBoundingClientRect().bottom - w.getBoundingClientRect().top - 18;
  w.style.maxHeight = Math.max(260, Math.round(h)) + "px";
}
window.addEventListener("resize", _sizeAssetSvcTableWrapper);

function _wireAssetServicesTab(asset) {
  var assetId = asset && asset.id ? asset.id : asset; // tolerate id-or-object
  var btn = document.querySelector('#asset-view-tabs [data-tab="services"]');
  if (!btn) return;
  var loaded = false;        // services loaded (first tab activation)
  var procLoaded = false;    // processes fetched at least once
  var includeProc = false;   // "Include processes" checkbox state
  var layoutApplied = false;
  var sf = null;
  var svcRows = [];
  var procRows = [];
  var procConfigs = {};
  var svcMonitored = new Set(); // monitoredServices (Logs)
  var svcMapped = new Set();    // mappedServices (Map)
  // Can a socket be attributed to a unit on this host? Agent-only — see the
  // `unitAttribution` field on GET /assets/:id/services. Default true so a
  // failed/older fetch doesn't gratuitously disable the checkbox.
  var svcUnitAttribution = true;
  var procMonitored = new Set(); // monitoredProcesses (Monitor)
  var procMapped = new Set();    // mappedProcesses (Map)

  function fmtPct(v) { return v == null ? "—" : Number(v).toFixed(1); }

  // Unified row model — services first, then (when included) processes. Each
  // carries `kind` + the raw row + the sortable columns TableSF reads by key.
  function combinedRows() {
    var out = svcRows.map(function (s) {
      return {
        kind: "service", raw: s,
        sortName: s.unit || "",
        typeLabel: "Service",
        stateSort: s.activeState || "",
        cpuPct: (s.cpuPct != null ? Number(s.cpuPct) : null),
        memSort: (s.memBytes != null ? Number(s.memBytes) : null),
      };
    });
    if (includeProc) {
      out = out.concat(procRows.map(function (p) {
        return {
          kind: "process", raw: p,
          sortName: p.name || "",
          typeLabel: "Process",
          stateSort: "",
          cpuPct: (p.cpuPct != null ? Number(p.cpuPct) : null),
          memSort: (p.memRssBytes != null ? Number(p.memRssBytes) : null),
        };
      }));
      // Stale pins: a program pinned for Monitor and/or Map that no longer
      // appears in the live inventory (it stopped running). Without a row the
      // operator has no checkbox to un-pin it, so it lingers on the Application
      // Map until its connection rows age out. Surface it as a "not running"
      // row so the Monitor/Map boxes can be unchecked.
      var live = {};
      procRows.forEach(function (p) { live[p.name] = true; });
      var staleNames = [];
      procMonitored.forEach(function (nm) { if (!live[nm]) staleNames.push(nm); });
      procMapped.forEach(function (nm) { if (!live[nm] && staleNames.indexOf(nm) < 0) staleNames.push(nm); });
      staleNames.forEach(function (nm) {
        out.push({
          kind: "process",
          raw: { name: nm, cpuPct: null, memRssBytes: null, exePath: "", _stale: true },
          sortName: nm, typeLabel: "Process", stateSort: "", cpuPct: null, memSort: null,
        });
      });
    }
    return out;
  }

  function renderRows(data) {
    var tbody = document.getElementById("asset-view-svc-tbody");
    if (!tbody) return;
    if (!data.length) {
      var empty = includeProc
        ? "No services or processes reported yet. They appear once a Polaris Agent (or an SNMP/SSH/WinRM poll) reports this host."
        : "No services reported yet. Services appear once a Polaris Agent reports this host\'s unit list.";
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">' + empty + '</td></tr>';
      return;
    }
    var canWrite = typeof canManageAssets === "function" && canManageAssets();
    var disabled = canWrite ? "" : " disabled";
    // Per-unit socket attribution needs the Polaris Agent — only it resolves a
    // PID's owning unit. On an agentless (SSH/WinRM-polled) host, mapping a
    // service would collect nothing, so disable the box and say why rather than
    // letting the operator tick something inert. Already-set pins still render
    // checked so they stay visible (and clearable once an agent lands).
    var svcMapDisabled = disabled || (svcUnitAttribution ? "" : " disabled");
    var svcMapTitle = svcUnitAttribution
      ? "Attribute this unit's connections on the Application Map"
      : "Requires the Polaris Agent — agentless SSH/WinRM collection can't attribute a socket to a unit";
    var byPid = _svcSharedProcessIndex(svcRows);
    tbody.innerHTML = data.map(function (r) {
      if (r.kind === "service") {
        var s = r.raw;
        var u = escapeHtml(s.unit);
        var logsChecked = svcMonitored.has(s.unit) ? " checked" : "";
        var mapChecked = svcMapped.has(s.unit) ? " checked" : "";
        var shared = _svcSharedTagHTML(s, byPid);
        var mem = (s.memBytes != null) ? _fmtBytes(Number(s.memBytes)) + shared : "—";
        var cpu = (s.cpuPct != null) ? fmtPct(s.cpuPct) + shared : "—";
        var logsTitle = s.platform === "windows" ? "Collect this service\'s Event Log entries" : "Tail this unit\'s journal";
        return '<tr>' +
          '<td class="svc-pin-col"><input type="checkbox" class="asset-svc-logs-toggle" data-svc-unit="' + u + '" title="' + logsTitle + '"' + logsChecked + disabled + '></td>' +
          '<td class="svc-pin-col"><input type="checkbox" class="asset-svc-map-toggle" data-svc-unit="' + u + '" title="' + escapeHtml(svcMapTitle) + '"' + mapChecked + svcMapDisabled + '></td>' +
          '<td title="' + escapeHtml(s.displayName || "") + '"><a href="#" class="asset-svc-unit-link" data-svc-unit="' + u + '">' + u + '</a></td>' +
          '<td>Service</td>' +
          '<td>' + _svcStatePill(s.activeState) + '</td>' +
          '<td>' + cpu + '</td>' +
          '<td>' + mem + '</td>' +
        '</tr>';
      }
      var p = r.raw;
      var nm = escapeHtml(p.name);
      var monChecked = procMonitored.has(p.name) ? " checked" : "";
      var pMapChecked = procMapped.has(p.name) ? " checked" : "";
      var ram = (p.memRssBytes != null) ? _fmtBytes(Number(p.memRssBytes)) : "—";
      // Stale pin (program no longer in the live inventory): still shows its
      // Monitor/Map boxes so the operator can un-pin it, but the name isn't a
      // detail link (there's no live process to open) and the State reads
      // "not running".
      if (p._stale) {
        return '<tr style="opacity:0.7">' +
          '<td class="svc-pin-col"><input type="checkbox" class="asset-proc-monitor-toggle" data-proc-name="' + nm + '" title="Uncheck to stop monitoring this (no-longer-running) program"' + monChecked + disabled + '></td>' +
          '<td class="svc-pin-col"><input type="checkbox" class="asset-proc-map-toggle" data-proc-name="' + nm + '" title="Uncheck to remove this (no-longer-running) program from the Application Map"' + pMapChecked + disabled + '></td>' +
          '<td>' + nm + '</td>' +
          '<td><span style="color:var(--color-text-secondary)">Process</span></td>' +
          '<td><span style="color:var(--color-text-tertiary)">not running</span></td>' +
          '<td>—</td>' +
          '<td>—</td>' +
        '</tr>';
      }
      return '<tr>' +
        '<td class="svc-pin-col"><input type="checkbox" class="asset-proc-monitor-toggle" data-proc-name="' + nm + '" title="Collect CPU/RAM history + logs"' + monChecked + disabled + '></td>' +
        '<td class="svc-pin-col"><input type="checkbox" class="asset-proc-map-toggle" data-proc-name="' + nm + '" title="Discover listening ports + connections for the Application Map"' + pMapChecked + disabled + '></td>' +
        '<td title="' + escapeHtml(p.exePath || "") + '"><a href="#" class="asset-proc-name-link" data-proc-name="' + nm + '">' + nm + '</a></td>' +
        '<td><span style="color:var(--color-text-secondary)">Process</span></td>' +
        '<td>—</td>' +
        '<td>' + fmtPct(p.cpuPct) + '</td>' +
        '<td>' + ram + '</td>' +
      '</tr>';
    }).join("");
  }

  function apply() {
    var rows = combinedRows();
    renderRows(sf ? sf.apply(rows) : rows);
  }

  // Persist a pin-set change for a service unit (Logs / Map).
  async function toggleSvcPin(which, unit, on) {
    var set = which === "logs" ? svcMonitored : svcMapped;
    var field = which === "logs" ? "monitoredServices" : "mappedServices";
    var next = new Set(set);
    if (on) next.add(unit); else next.delete(unit);
    try {
      var body = {};
      body[field] = Array.from(next);
      await api.assets.update(assetId, body);
      if (which === "logs") svcMonitored = next; else svcMapped = next;
      var msg = which === "logs"
        ? (on ? ("Tailing journal for " + unit) : ("Stopped tailing " + unit))
        : (on ? ("Mapping " + unit + " on the Application Map") : ("Unmapped " + unit));
      showToast(msg, "success");
    } catch (err) {
      showToast(err && err.message ? err.message : "Failed to update", "error");
      apply(); // revert the checkbox to the persisted state
    }
  }

  // Persist a pin-set change for a process program (Monitor / Map).
  async function toggleProcPin(which, name, on) {
    var set = which === "monitor" ? procMonitored : procMapped;
    var field = which === "monitor" ? "monitoredProcesses" : "mappedProcesses";
    var next = new Set(set);
    if (on) next.add(name); else next.delete(name);
    try {
      var body = {};
      body[field] = Array.from(next);
      await api.assets.update(assetId, body);
      if (which === "monitor") procMonitored = next; else procMapped = next;
      var msg = which === "monitor"
        ? (on ? ("Monitoring " + name + " (CPU/RAM + logs)") : ("Stopped monitoring " + name))
        : (on ? ("Mapping " + name + " on the Application Map (ports + connections)") : ("Unmapped " + name));
      showToast(msg, "success");
      // If this was a stale pin (program no longer in the live inventory) and
      // it's now fully un-pinned, re-render so its "not running" row drops out.
      var stillListed = procRows.some(function (p) { return p.name === name; });
      if (!stillListed && !procMonitored.has(name) && !procMapped.has(name)) apply();
    } catch (err) {
      showToast(err && err.message ? err.message : "Failed to update", "error");
      apply();
    }
  }

  async function loadServices() {
    var resp = await api.assets.services(assetId);
    svcRows = (resp && resp.services) || [];
    svcMonitored = new Set((resp && resp.monitoredServices) || []);
    svcMapped = new Set((resp && resp.mappedServices) || []);
    svcUnitAttribution = !(resp && resp.unitAttribution === false);
  }

  async function loadProcesses() {
    var resp = await api.assets.processes(assetId);
    procRows = (resp && resp.processes) || [];
    procConfigs = (resp && resp.configs) || {};
    procMonitored = new Set((resp && resp.monitoredProcesses) || []);
    procMapped = new Set((resp && resp.mappedProcesses) || []);
    procLoaded = true;
  }

  // Order matters: construct TableSF FIRST — it rewrites each data-sf-key
  // header's innerHTML (sort caret + filter UI), which wipes any resize handle
  // added earlier. applyTableLayout runs AFTER so its .sf-resize-handle spans
  // are appended last and survive on every sortable column. Both run once.
  function ensureTableWiring() {
    if (!sf && typeof TableSF !== "undefined") {
      sf = new TableSF("asset-view-svc-tbody", apply);
      var svcRefresh = document.getElementById("asset-view-svc-refresh");
      sf.addClearButton(svcRefresh && svcRefresh.parentElement);
    }
    if (!layoutApplied && typeof applyTableLayout === "function") {
      var svcTable = document.getElementById("asset-view-svc-table");
      if (svcTable) {
        applyTableLayout(svcTable, "asset-services-merged", {
          onScreenshot: function (t) { _screenshotTableEl(t, "Services"); },
        });
        layoutApplied = true;
      }
    }
  }

  async function reload() {
    var tbody = document.getElementById("asset-view-svc-tbody");
    try {
      await loadServices();
      if (includeProc) { try { await loadProcesses(); } catch (e) { /* processes are optional; keep services */ } }
      ensureTableWiring();
      apply();
      _sizeAssetSvcTableWrapper();
    } catch (err) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Error: ' + escapeHtml(err && err.message ? err.message : String(err)) + '</td></tr>';
    }
  }

  // Delegated checkbox handler (survives re-render) — dispatches on the pin
  // class + which row kind the checkbox belongs to.
  var tbody = document.getElementById("asset-view-svc-tbody");
  if (tbody) {
    tbody.addEventListener("change", function (e) {
      var cb = e.target;
      if (!cb || !cb.getAttribute) return;
      var unit = cb.getAttribute("data-svc-unit");
      var name = cb.getAttribute("data-proc-name");
      if (cb.classList.contains("asset-svc-logs-toggle")) toggleSvcPin("logs", unit, cb.checked);
      else if (cb.classList.contains("asset-svc-map-toggle")) toggleSvcPin("map", unit, cb.checked);
      else if (cb.classList.contains("asset-proc-monitor-toggle")) toggleProcPin("monitor", name, cb.checked);
      else if (cb.classList.contains("asset-proc-map-toggle")) toggleProcPin("map", name, cb.checked);
    });
    // Row name click → the matching detail slide-in (service control panel /
    // per-process charts + logs).
    tbody.addEventListener("click", function (e) {
      var svcLink = e.target.closest ? e.target.closest(".asset-svc-unit-link") : null;
      if (svcLink) {
        e.preventDefault();
        var unit = svcLink.getAttribute("data-svc-unit");
        if (!unit) return;
        var svcRow = svcRows.filter(function (r) { return r.unit === unit; })[0] || null;
        var sharedUnits = svcRow && svcRow.mainPid ? (_svcSharedProcessIndex(svcRows)[svcRow.mainPid] || []) : [];
        openServiceDetailPanel(asset, svcRow, sharedUnits);
        return;
      }
      var procLink = e.target.closest ? e.target.closest(".asset-proc-name-link") : null;
      if (procLink) {
        e.preventDefault();
        var name = procLink.getAttribute("data-proc-name");
        if (!name) return;
        var procRow = procRows.filter(function (r) { return r.name === name; })[0] || null;
        openProcessDetailPanel(asset, name, procConfigs[name] || null, procRow, procMonitored.has(name));
      }
    });
  }
  var refreshBtn = document.getElementById("asset-view-svc-refresh");
  if (refreshBtn) refreshBtn.addEventListener("click", function () { reload(); });

  // "Include processes" — fold the process inventory into the table. Lazy: the
  // /processes fetch fires only the first time it's ticked, then re-renders.
  var includeCb = document.getElementById("asset-view-svc-include-proc");
  if (includeCb) {
    includeCb.addEventListener("change", async function () {
      includeProc = includeCb.checked;
      if (includeProc && !procLoaded) {
        includeCb.disabled = true;
        try {
          await loadProcesses();
        } catch (err) {
          showToast(err && err.message ? err.message : "Failed to load processes", "error");
          includeProc = false;
          includeCb.checked = false;
        } finally {
          includeCb.disabled = false;
        }
      }
      apply();
      _sizeAssetSvcTableWrapper();
    });
  }

  btn.addEventListener("click", function () {
    _sizeAssetSvcTableWrapper();
    if (loaded) return;
    loaded = true;
    reload();
  });
}

// Per-service detail slide-in — reuses the process detail nested slide-over
// shell. Unit metadata + log viewer (the journal on Linux, the service's Event
// Log entries on Windows) + ports/connections. (Start/stop/restart control was
// removed — Satellite-posture change.) sharedUnits: every unit running in this
// service's process, itself included (see _svcSharedProcessIndex).
function openServiceDetailPanel(asset, svc, sharedUnits) {
  if (!asset || !svc) return;
  _ensureProcPanelDOM();
  var titleEl = document.getElementById("proc-panel-title");
  var metaEl  = document.getElementById("proc-panel-meta");
  var bodyEl  = document.getElementById("proc-panel-body");
  var footerEl = document.getElementById("proc-panel-footer");
  titleEl.textContent = "Service — " + svc.unit;
  metaEl.textContent = asset.hostname || asset.ipAddress || asset.id;
  _setProcPanelFooter(footerEl);
  raiseSlideover(document.getElementById("proc-panel-overlay"));
  revealOverlay(document.getElementById("proc-panel-overlay"));

  function metaRow(label, value) {
    return '<div style="display:flex;justify-content:space-between;gap:12px;padding:0.3rem 0;border-bottom:1px solid var(--color-border)">' +
      '<span style="color:var(--color-text-secondary)">' + label + '</span>' +
      '<span style="text-align:right">' + value + '</span></div>';
  }
  // Long text: label above, text below, left-aligned — a right-aligned
  // paragraph beside its label reads as ragged.
  function blockRow(label, value) {
    return '<div style="padding:0.3rem 0;border-bottom:1px solid var(--color-border)">' +
      '<div style="color:var(--color-text-secondary);margin-bottom:0.15rem">' + label + '</div>' +
      '<div style="white-space:pre-wrap">' + value + '</div></div>';
  }
  var isWin = svc.platform === "windows";
  var others = (sharedUnits || []).filter(function (u) { return u !== svc.unit; });
  var sharedNote = others.length ? ' <span style="font-size:0.72rem;color:var(--color-text-tertiary)">(whole process)</span>' : "";
  var pidVal = svc.mainPid ? (escapeHtml(svc.mainProcess || "") + " (PID " + svc.mainPid + ")") : "—";
  var memVal = (svc.memBytes != null) ? _fmtBytes(Number(svc.memBytes)) + sharedNote : "—";
  // Null until the agent's second inventory scrape (it is a mean since the
  // previous one), and for a stopped service.
  var cpuVal = (svc.cpuPct != null) ? Number(svc.cpuPct).toFixed(1) + "%" + sharedNote : "—";

  bodyEl.innerHTML =
    '<div style="padding:1rem 1.25rem">' +
      '<div style="font-size:0.85rem">' +
        metaRow("Display name", escapeHtml(svc.displayName || "—")) +
        (svc.description ? blockRow("Description", escapeHtml(svc.description)) : "") +
        metaRow("Platform", escapeHtml(svc.platform || "—")) +
        metaRow("State", _svcStatePill(svc.activeState)) +
        (svc.subState ? metaRow("Sub-state", escapeHtml(svc.subState)) : "") +
        metaRow(isWin ? "Startup type" : "Enabled", escapeHtml(_svcStartupLabel(svc))) +
        metaRow("Main process", pidVal) +
        metaRow("CPU", cpuVal) +
        metaRow("Memory", memVal) +
        (others.length
          ? blockRow("Shares its process with", escapeHtml(others.join(", ")) +
              '<div style="font-size:0.75rem;color:var(--color-text-tertiary);margin-top:0.2rem">CPU and memory are the whole process\'s, not this service\'s alone.</div>')
          : "") +
      '</div>' +
      // Ports & Connections (Phase 3) — populated when the unit is pinned for
      // Map (mappedServices); the agent attributes its PIDs' sockets to the unit.
      '<div style="margin-top:1rem;padding-top:0.75rem;border-top:1px solid var(--color-border)">' +
        '<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:0.25rem;gap:8px;flex-wrap:wrap">' +
          '<h4 style="margin:0">Ports &amp; Connections</h4>' +
          '<a class="btn btn-sm btn-secondary" href="/appmap.html#focus=' + encodeURIComponent("asset:" + asset.id) + '">View on Application Map</a>' +
        '</div>' +
        '<div id="svc-conn-view" style="font-size:0.8rem;color:var(--color-text-secondary)">Loading…</div>' +
      '</div>' +
      // Log viewer (Phase 2) — populated when the unit is pinned for Monitor
      // (monitoredServices) and the agent has read it: the unit's journal on
      // Linux, the service's Event Log entries on Windows.
      '<div style="margin-top:1rem;padding-top:0.75rem;border-top:1px solid var(--color-border)">' +
        '<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:0.25rem;gap:8px;flex-wrap:wrap">' +
          '<h4 style="margin:0">Logs <span style="font-weight:400;font-size:0.75rem;color:var(--color-text-tertiary)">' + (isWin ? "Event Log" : "journalctl") + '</span></h4>' +
          '<div style="display:flex;align-items:center;gap:10px">' +
            '<label style="font-size:0.78rem;display:flex;align-items:center;gap:4px"><input type="checkbox" id="svc-logs-flagged-only">Flagged only</label>' +
            '<button class="btn btn-sm btn-secondary" id="btn-svc-logs-export" title="Download the collected log lines as CSV">Export</button>' +
            '<button class="btn btn-glyph btn-glyph-refresh btn-sm btn-secondary" id="btn-svc-logs-refresh" title="Refresh">Refresh</button>' +
          '</div>' +
        '</div>' +
        (isWin
          ? '<p class="hint" style="font-size:0.76rem">Tick this service\'s <strong>Monitor</strong> box in the Services tab to collect its Event Log entries: the Service Control Manager\'s entries naming it in System (start, stop, crash, failed start, startup-type change) and whatever it logs under its own name in System or Application. The newest 50 from each log arrive within a minute or two, then new ones as they happen. Needs agent 0.22.0 or later.</p>'
          : '<p class="hint" style="font-size:0.76rem">Tick this unit\'s <strong>Monitor</strong> box in the Services tab to start tailing its journal — lines appear within a minute or two.</p>') +
        '<div id="svc-logs-view" style="max-height:300px;overflow:auto;background:var(--color-bg-primary);border:1px solid var(--color-border);border-radius:6px;padding:0.5rem;font-family:var(--font-mono);font-size:0.78rem;white-space:pre-wrap;color:var(--color-text-secondary)">Loading…</div>' +
      '</div>' +
    '</div>';

  var refreshLogs = document.getElementById("btn-svc-logs-refresh");
  if (refreshLogs) refreshLogs.addEventListener("click", function () { _loadServiceLogsFor(asset.id, svc.unit, svc.platform); });
  var flaggedOnly = document.getElementById("svc-logs-flagged-only");
  if (flaggedOnly) flaggedOnly.addEventListener("change", function () { _loadServiceLogsFor(asset.id, svc.unit, svc.platform); });
  var exportLogs = document.getElementById("btn-svc-logs-export");
  if (exportLogs) exportLogs.addEventListener("click", function () {
    var fl = document.getElementById("svc-logs-flagged-only");
    _exportPanelLogsCsv("service", asset, svc.unit, !!(fl && fl.checked), exportLogs);
  });
  _loadServiceConnectionsFor(asset.id, svc.unit);
  _loadServiceLogsFor(asset.id, svc.unit, svc.platform);
}

async function _loadServiceLogsFor(assetId, unit, platform) {
  var el = document.getElementById("svc-logs-view");
  if (!el) return;
  var flaggedToggle = document.getElementById("svc-logs-flagged-only");
  var flaggedOnly = !!(flaggedToggle && flaggedToggle.checked);
  try {
    var data = await api.assets.serviceLogs(assetId, unit, { limit: 300, flagged: flaggedOnly ? 1 : undefined });
    var logs = data.logs || [];
    if (!logs.length) {
      el.textContent = flaggedOnly
        ? "No flagged log lines in this window."
        : (platform === "windows"
          ? "No Event Log entries collected yet. Tick this service's Monitor box (Services tab); entries arrive within a minute or two. A service that has never started, stopped or failed may have none."
          : "No log lines collected yet. Tick this unit's Monitor box (Services tab) — journald tailing starts within a minute or two.");
      return;
    }
    // Server returns newest-first; keep that order (newest at the top).
    el.innerHTML = logs.map(function (l) {
      var d = l.timestamp ? new Date(l.timestamp) : null;
      var ts = d ? d.toLocaleDateString(undefined, timeZoneOpts()) + " " + d.toLocaleTimeString(undefined, timeZoneOpts()) : "";
      var lvl = l.level ? "[" + escapeHtml(l.level) + "] " : "";
      var flags = Array.isArray(l.flags) ? l.flags : [];
      var badges = flags.map(function (f) {
        var col = f.color || "var(--color-warning)";
        return '<span style="display:inline-block;margin-left:6px;padding:0 5px;border-radius:3px;font-size:0.7rem;background:' + col + ';color:#000">' + escapeHtml(f.label || f.name) + '</span>';
      }).join("");
      var hl = flags.length ? ';background:rgba(245,158,11,0.12);border-left:2px solid var(--color-warning);padding-left:4px' : "";
      return '<div style="' + hl + '"><span style="color:var(--color-text-tertiary)">' + escapeHtml(ts) + '</span> ' + lvl + escapeHtml(l.message || "") + badges + '</div>';
    }).join("");
  } catch (err) {
    el.textContent = "Error: " + (err.message || "failed to load logs");
  }
}

// ─── Per-process detail slide-in (nested slide-over) ─────────────────────────
// CPU/RAM charts (reusing _renderSensorChart) + an editable log-path config +
// a log viewer. Opened from the Processes-tab name link. Mirrors the interface
// detail panel's nested-slideover + range-button pattern.
function _ensureProcPanelDOM() {
  if (document.getElementById("proc-panel-overlay")) return;
  // Skeleton + backdrop / close / Escape / resize wiring: buildSlideover
  // (app.js). Stacks by DOM order like every slide-over — raiseSlideover on open.
  buildSlideover({
    id: "proc-panel",
    overlayClass: "slideover-nested",
    panelStyle: "z-index:1100",
    title: "Process",
    bodyHTML: '<p class="empty-state" style="padding:1rem 1.25rem">Loading…</p>',
    footer: true,
    close: _closeProcPanel,
    resizeKey: "polaris.panel.width.process",
  });
}

function _closeProcPanel() {
  var ov = document.getElementById("proc-panel-overlay");
  if (ov) ov.classList.remove("open");
}

// Footer for the process/service slide-in: Copy (plaintext of the panel body)
// + Screenshot (html-to-image capture, asset-details pattern) on the left,
// Close on the right. Shared by openServiceDetailPanel + openProcessDetailPanel.
function _setProcPanelFooter(footerEl) {
  footerEl.innerHTML =
    '<button type="button" class="btn btn-sm btn-secondary" id="btn-proc-panel-copy">Copy</button>' +
    '<button type="button" class="btn btn-sm btn-secondary" id="btn-proc-panel-shot">Screenshot</button>' +
    '<span style="flex:1"></span>' +
    '<button class="btn btn-sm btn-secondary" id="btn-proc-panel-close-btn">Close</button>';
  document.getElementById("btn-proc-panel-close-btn").addEventListener("click", _closeProcPanel);
  document.getElementById("btn-proc-panel-copy").addEventListener("click", _copyProcPanel);
  document.getElementById("btn-proc-panel-shot").addEventListener("click", _screenshotProcPanel);
}

// Copy the process/service slide-in as plaintext: title + asset line, then the
// same block extraction/formatting the asset-details Copy button uses.
function _copyProcPanel() {
  var bodyEl = document.getElementById("proc-panel-body");
  var blocks = _extractTabBlocks(bodyEl);
  if (!blocks.length) { showToast("Nothing to copy", "error"); return; }
  var titleEl = document.getElementById("proc-panel-title");
  var metaEl  = document.getElementById("proc-panel-meta");
  var header = [];
  var t = titleEl ? (titleEl.textContent || "").trim() : "";
  if (t) { header.push(t); header.push(new Array(t.length + 1).join("=")); }
  var m = metaEl ? (metaEl.textContent || "").trim() : "";
  if (m) header.push(m);
  var text = (header.length ? header.join("\n") + "\n\n" : "") + _blocksToPlaintext(blocks);
  copyTextToClipboard(text).then(function (ok) {
    showToast(ok ? "Details copied to clipboard" : "Copy failed", ok ? "success" : "error");
  });
}

// Screenshot the process/service slide-in and copy it to the clipboard as a
// PNG. Same approach as the asset-details Screenshot (_runScreenshotCapture):
// force the slide-over to a canonical width so output is independent of the
// operator's drag-resize, let the charts' ResizeObservers re-render, rasterize
// the live body via html-to-image, and draw a self-identifying title strip.
function _screenshotProcPanel() {
  var panel = document.getElementById("proc-panel-body");
  var slideover = document.getElementById("proc-panel");
  if (!panel) { showToast("Nothing to screenshot", "error"); return; }
  if (typeof htmlToImage === "undefined") {
    showToast("Screenshot failed — capture library not loaded", "error");
    return;
  }

  var cs = getComputedStyle(document.documentElement);
  var bgPrimary = cs.getPropertyValue("--color-bg-primary").trim() || "#ffffff";
  var clrText   = cs.getPropertyValue("--color-text-primary").trim() || "#111";
  var clrSec    = cs.getPropertyValue("--color-text-secondary").trim() || "#666";
  var fontSans  = cs.getPropertyValue("--font-sans").trim() || "system-ui,-apple-system,sans-serif";

  var btn = document.getElementById("btn-proc-panel-shot");
  if (btn) btn.disabled = true;

  var CAPTURE_WIDTH = 900; // px — canonical width for the nested slide-over
  var prevWidth = slideover ? slideover.style.width : "";
  if (slideover) slideover.style.width = CAPTURE_WIDTH + "px";
  panel.classList.add("screenshot-hide-scrollbars");
  function release() {
    panel.classList.remove("screenshot-hide-scrollbars");
    if (slideover) slideover.style.width = prevWidth;
  }
  function done() { if (btn) btn.disabled = false; }

  var titleEl = document.getElementById("proc-panel-title");
  var metaEl  = document.getElementById("proc-panel-meta");
  var title = titleEl ? (titleEl.textContent || "").trim() : "";
  var meta  = metaEl ? (metaEl.textContent || "").trim() : "";

  // Double-rAF clears the relayout + ResizeObserver delivery for the width
  // change; the timeout covers the chart re-renders those observers kick off.
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      setTimeout(function () {
        var scale = 2;
        // Capture the body's content wrapper, not the body itself — the body
        // is the scroll container (viewport-bounded height), so capturing it
        // would clip everything below the fold. The wrapper is content-height.
        var target = panel.firstElementChild || panel;
        htmlToImage.toCanvas(target, { pixelRatio: scale, backgroundColor: bgPrimary })
          .then(function (capture) {
            release();
            var pad = 24;
            var titleH = title ? (meta ? 58 : 40) : 0;
            var w = capture.width / scale;
            var h = capture.height / scale;
            var canvas = document.createElement("canvas");
            canvas.width  = (w + pad * 2) * scale;
            canvas.height = (titleH + h + pad * (title ? 1 : 2)) * scale;
            var ctx = canvas.getContext("2d");
            ctx.scale(scale, scale);
            ctx.fillStyle = bgPrimary;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            if (title) {
              ctx.fillStyle = clrText;
              ctx.font = "bold 17px " + fontSans;
              ctx.fillText(title, pad, 30);
              if (meta) {
                ctx.fillStyle = clrSec;
                ctx.font = "12px " + fontSans;
                ctx.fillText(meta, pad, 48);
              }
            }
            ctx.drawImage(capture, pad, titleH || pad, w, h);
            canvas.toBlob(function (blob) {
              done();
              if (!blob) { showToast("Screenshot failed", "error"); return; }
              copyPngToClipboard(blob).then(function (ok) {
                showToast(ok ? "Screenshot copied to clipboard" : "Screenshot failed — requires HTTPS or clipboard permission", ok ? "success" : "error");
              });
            }, "image/png");
          })
          .catch(function () {
            release();
            done();
            showToast("Screenshot failed", "error");
          });
      }, 300);
    });
  });
}

// Fetch up to the server cap of log lines for the open service/process log
// viewer (honoring the Flagged-only toggle) and download them as CSV.
async function _exportPanelLogsCsv(kind, asset, key, flaggedOnly, btn) {
  if (btn) btn.disabled = true;
  try {
    var opts = { limit: 2000, flagged: flaggedOnly ? 1 : undefined };
    var data = kind === "service"
      ? await api.assets.serviceLogs(asset.id, key, opts)
      : await api.assets.processLogs(asset.id, key, opts);
    var logs = (data && data.logs) || [];
    if (!logs.length) { showToast("No log lines to export", "error"); return; }
    var headers = ["Timestamp", "Level", "Message", "Flags"];
    // Server returns newest-first; export oldest-first like the viewer.
    var rows = logs.slice().reverse().map(function (l) {
      var flags = Array.isArray(l.flags)
        ? l.flags.map(function (f) { return f.label || f.name || ""; }).filter(Boolean).join("; ")
        : "";
      return [
        // formatDateTime, not toISOString: this column used to be UTC while the
        // sibling events export (_exportAssetEventsCsv) wrote the operator's own
        // clock, so the same outage read two different times depending on which
        // button produced the file.
        l.timestamp ? formatDateTime(l.timestamp) : "",
        l.level || "",
        l.message || "",
        flags,
      ];
    });
    var subject = _assetExportSubject(asset) + "-" + String(key).replace(/[^A-Za-z0-9._-]+/g, "-");
    var filename = "polaris-" + kind + "-logs-" + subject + "-" + new Date().toISOString().slice(0, 10) + ".csv";
    downloadCsv(headers, rows, filename);
    showToast("Exported " + logs.length + " log lines to " + filename);
  } catch (err) {
    showToast(err && err.message ? err.message : "Export failed", "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function openProcessDetailPanel(asset, name, cfg, procRow, isPinned) {
  if (!asset || !name) return;
  _ensureProcPanelDOM();
  var titleEl = document.getElementById("proc-panel-title");
  var metaEl  = document.getElementById("proc-panel-meta");
  var bodyEl  = document.getElementById("proc-panel-body");
  var footerEl = document.getElementById("proc-panel-footer");
  titleEl.textContent = "Process — " + name;
  metaEl.textContent = asset.hostname || asset.ipAddress || asset.id;
  _setProcPanelFooter(footerEl);
  raiseSlideover(document.getElementById("proc-panel-overlay"));
  requestAnimationFrame(function () {
    document.getElementById("proc-panel-overlay").classList.add("open");
  });

  var rangeBtns = _chartRangeBtnsHTML("proc-range-btn", [
    { value: "1h",  label: "1h" },
    { value: "12h", label: "12h" },
    { value: "24h", label: "24h" },
    { value: "7d",  label: "7d" },
    { value: "30d", label: "30d" },
  ], "assetProcess", "1h");

  var canEdit = canManageAssets();
  var c = cfg || {};
  var glob = c.logPathGlob || "";
  var src = c.logSource || "auto";
  function srcOpt(v, label) { return '<option value="' + v + '"' + (src === v ? " selected" : "") + '>' + label + '</option>'; }

  // Show the backing service/unit (read-only) when the process resolves to one.
  // (Start/stop/restart control was removed — Satellite-posture change.)
  var controlBlock = "";
  if (procRow && procRow.serviceUnit) {
    controlBlock =
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:0.75rem;padding-bottom:0.6rem;border-bottom:1px solid var(--color-border)">' +
        '<div style="font-size:0.82rem;color:var(--color-text-secondary)">Service / unit: <code>' + escapeHtml(procRow.serviceUnit) + '</code></div>' +
      '</div>';
  }

  // CPU/RAM charts + logs are collected per-minute ONLY for pinned programs
  // (the Monitor checkbox in the Processes tab). The inventory snapshot in the
  // table is separate from this charted time-series — so when the program
  // isn't pinned, make it obvious why the charts are empty rather than showing
  // a blank box.
  var pinBanner = isPinned ? "" :
    '<div style="margin-bottom:0.75rem;padding:0.5rem 0.75rem;border:1px solid var(--color-border);border-left:3px solid var(--color-warning);border-radius:6px;background:rgba(245,158,11,0.08);font-size:0.82rem;color:var(--color-text-secondary)">' +
      'This process isn’t pinned for monitoring. Check its <strong>Monitor</strong> box in the Processes tab to start collecting per-minute CPU/RAM and logs — data appears within a minute or two.' +
    '</div>';

  bodyEl.innerHTML =
    '<div style="padding:1rem 1.25rem">' +
      controlBlock +
      pinBanner +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">' +
        '<h4 style="margin:0">CPU &amp; Memory</h4>' +
        '<div style="display:flex;gap:6px">' + rangeBtns + '</div>' +
      '</div>' +
      '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">CPU (%)</h5>' +
      '<div id="proc-cpu-stats" style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">Loading…</div>' +
      '<div id="proc-cpu-chart" class="proc-chart-box"></div>' +
      '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">Memory (MB, RSS)</h5>' +
      '<div id="proc-mem-stats" style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">Loading…</div>' +
      '<div id="proc-mem-chart" class="proc-chart-box"></div>' +
      '<div style="margin-top:1rem;padding-top:0.75rem;border-top:1px solid var(--color-border)">' +
        '<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:0.25rem;gap:8px;flex-wrap:wrap">' +
          '<h4 style="margin:0">Ports &amp; Connections</h4>' +
          '<a class="btn btn-sm btn-secondary" href="/appmap.html#focus=' + encodeURIComponent("asset:" + asset.id) + '">View on Application Map</a>' +
        '</div>' +
        '<div id="proc-conn-view" style="font-size:0.8rem;color:var(--color-text-secondary)">Loading…</div>' +
      '</div>' +
      '<div style="margin-top:1rem;padding-top:0.75rem;border-top:1px solid var(--color-border)">' +
        '<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:0.25rem;gap:8px;flex-wrap:wrap">' +
          '<h4 style="margin:0">Logs</h4>' +
          '<div style="display:flex;align-items:center;gap:10px">' +
            '<label style="font-size:0.78rem;display:flex;align-items:center;gap:4px"><input type="checkbox" id="proc-logs-flagged-only">Flagged only</label>' +
            (canEdit ? '<button class="btn btn-sm btn-secondary" id="btn-proc-flag-rules">Manage flag rules</button>' : '') +
            '<button class="btn btn-sm btn-secondary" id="btn-proc-logs-export" title="Download the collected log lines as CSV">Export</button>' +
            '<button class="btn btn-glyph btn-glyph-refresh btn-sm btn-secondary" id="btn-proc-logs-refresh" title="Refresh">Refresh</button>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;align-items:flex-end;flex-wrap:wrap;margin:0.4rem 0">' +
          '<label style="font-size:0.78rem;color:var(--color-text-secondary)">Source' +
            '<select id="proc-log-source" style="display:block;margin-top:2px"' + (canEdit ? "" : " disabled") + '>' +
              srcOpt("auto", "Auto") + srcOpt("journald-unit", "journald (Linux)") + srcOpt("file-glob", "File path/glob") +
            '</select>' +
          '</label>' +
          '<label style="flex:1;min-width:220px;font-size:0.78rem;color:var(--color-text-secondary)">Log path / wildcard' +
            '<input type="text" id="proc-log-glob" value="' + escapeHtml(glob) + '" placeholder="/var/log/' + escapeHtml(name) + '/*.log" style="display:block;width:100%;box-sizing:border-box;margin-top:2px"' + (canEdit && canDeployAgent() ? "" : " disabled title=\"Setting a log path needs Assets Full Read-Write: the agent reads that path as a privileged user.\"") + '>' +
          '</label>' +
          (canEdit ? '<button class="btn btn-sm btn-primary" id="btn-proc-log-config-save">Save</button>' : '') +
        '</div>' +
        (c.detectedUnit ? '<p class="hint" style="font-size:0.74rem">Auto-detected unit: <code>' + escapeHtml(c.detectedUnit) + '</code></p>' : '') +
        '<div id="proc-logs-view" style="max-height:300px;overflow:auto;background:var(--color-bg-primary);border:1px solid var(--color-border);border-radius:6px;padding:0.5rem;font-family:var(--font-mono);font-size:0.78rem;white-space:pre-wrap;color:var(--color-text-secondary)">Loading…</div>' +
      '</div>' +
    '</div>';
  document.querySelectorAll(".proc-chart-box").forEach(function (el) {
    el.classList.add("chart-box");
    el.style.minHeight = "160px";
  });

  await _loadProcessHistoryFor(asset.id, name, _getChartRangePref("assetProcess", "1h"));
  _loadProcessLogsFor(asset.id, name);
  _loadProcessConnectionsFor(asset.id, name);

  document.querySelectorAll(".proc-range-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      var range = b.getAttribute("data-range");
      document.querySelectorAll(".proc-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      b.classList.remove("btn-secondary"); b.classList.add("btn-primary");
      _setChartRangePref("assetProcess", range);
      _loadProcessHistoryFor(asset.id, name, range);
    });
  });
  // Drag-select on either chart applies the selection as a custom window
  // (no Custom… button on this bar — the preset highlights just clear).
  ["proc-cpu-chart", "proc-mem-chart"].forEach(function (cid) {
    _wireChartDragSelect(document.getElementById(cid), function (fromIso, toIso) {
      _applyCustomRangeSelection({ btnClass: "proc-range-btn" }, fromIso, toIso);
      _loadProcessHistoryFor(asset.id, name, { from: fromIso, to: toIso });
    });
  });
  var refreshLogs = document.getElementById("btn-proc-logs-refresh");
  if (refreshLogs) refreshLogs.addEventListener("click", function () { _loadProcessLogsFor(asset.id, name); });
  var flaggedOnly = document.getElementById("proc-logs-flagged-only");
  if (flaggedOnly) flaggedOnly.addEventListener("change", function () { _loadProcessLogsFor(asset.id, name); });
  var exportLogs = document.getElementById("btn-proc-logs-export");
  if (exportLogs) exportLogs.addEventListener("click", function () {
    var fl = document.getElementById("proc-logs-flagged-only");
    _exportPanelLogsCsv("process", asset, name, !!(fl && fl.checked), exportLogs);
  });
  var manageRules = document.getElementById("btn-proc-flag-rules");
  if (manageRules) manageRules.addEventListener("click", function () { openLogFlagRulesModal(asset, name, function () { _loadProcessLogsFor(asset.id, name); }); });
  var saveCfg = document.getElementById("btn-proc-log-config-save");
  if (saveCfg) {
    saveCfg.addEventListener("click", async function () {
      var body = {
        logSource:   document.getElementById("proc-log-source").value,
        logPathGlob: document.getElementById("proc-log-glob").value || null,
      };
      saveCfg.disabled = true;
      try {
        await api.assets.setProcessConfig(asset.id, name, body);
        showToast("Log config saved for " + name, "success");
        _loadProcessLogsFor(asset.id, name);
      } catch (err) {
        showToast(err && err.message ? err.message : "Save failed", "error");
      } finally {
        saveCfg.disabled = false;
      }
    });
  }
}

async function _loadProcessHistoryFor(assetId, name, range) {
  var cpuEl = document.getElementById("proc-cpu-chart");
  var memEl = document.getElementById("proc-mem-chart");
  var cpuStats = document.getElementById("proc-cpu-stats");
  var memStats = document.getElementById("proc-mem-stats");
  if (!cpuEl || !memEl) return;
  // Stash the active selection on both chart containers (canonical
  // convention) so screenshots carry a drag-selected custom window's From/To.
  var procOpts = (typeof range === "string" || !range) ? { range: range || "1h" } : range;
  [cpuEl, memEl].forEach(function (el) {
    if (procOpts.from && procOpts.to) {
      el.dataset.from = procOpts.from;
      el.dataset.to = procOpts.to;
      delete el.dataset.range;
    } else {
      el.dataset.range = procOpts.range || "1h";
      delete el.dataset.from;
      delete el.dataset.to;
    }
  });
  try {
    var data = await api.assets.processHistory(assetId, name, procOpts);
    var samples = data.samples || [];
    var cpu = samples.filter(function (s) { return typeof s.cpuPct === "number"; })
      .map(function (s) { return { timestamp: s.timestamp, value: s.cpuPct }; });
    var mem = samples.filter(function (s) { return s.memRssBytes != null; })
      .map(function (s) { return { timestamp: s.timestamp, value: Number(s.memRssBytes) / 1048576 }; });
    var cpuVis = _inChartWindow(cpu, data.since);
    var memVis = _inChartWindow(mem, data.since);
    if (cpuStats) _renderChartStats(cpuStats, cpuVis.length, [{ label: "Max", value: cpuVis.length ? Math.max.apply(null, cpuVis.map(function (p) { return p.value; })).toFixed(1) + "%" : "—" }]);
    if (memStats) _renderChartStats(memStats, memVis.length, [{ label: "Max", value: memVis.length ? Math.max.apply(null, memVis.map(function (p) { return p.value; })).toFixed(0) + " MB" : "—" }]);
    // No samples in range: per-process telemetry is only collected for pinned
    // programs, so an empty series almost always means "not pinned yet" or
    // "pinned moments ago." Render a hint rather than an empty chart box.
    var emptyMsg = '<div style="display:flex;align-items:center;justify-content:center;height:150px;color:var(--color-text-tertiary);font-size:0.82rem;text-align:center;padding:0 1rem">No CPU/RAM samples in this range yet — pin the process (Monitor) and allow a minute or two for collection.</div>';
    if (!cpu.length) { cpuEl.innerHTML = emptyMsg; } else { _renderSensorChart(cpuEl, cpu, { since: data.since, until: data.until, subject: name + " CPU", unit: "%" }); }
    if (!mem.length) { memEl.innerHTML = emptyMsg; } else { _renderSensorChart(memEl, mem, { since: data.since, until: data.until, subject: name + " RAM", unit: "MB" }); }
  } catch (err) {
    cpuEl.textContent = "Error: " + (err.message || "failed to load");
    memEl.textContent = "";
  }
}

// Ports & Connections section of the process detail panel (Application Map
// data, per-asset view). Three compact tables: listening ports, outbound
// connections, inbound peers — remote endpoints hydrated with the matched
// asset's hostname (link opens that asset's slide-in).
async function _loadProcessConnectionsFor(assetId, name) {
  var el = document.getElementById("proc-conn-view");
  if (!el) return;
  try {
    var d = await api.assets.processConnections(assetId, name);
    _renderConnView(el, d, 'No connection data yet. Check <strong>Map</strong> for this process in the Processes tab to start collecting listening ports and connections (data appears within a minute or two).');
  } catch (err) {
    el.textContent = "Error: " + (err && err.message ? err.message : String(err));
  }
}

// Ports & Connections for a mapped unit (Phase 3) — reuses the shared renderer.
async function _loadServiceConnectionsFor(assetId, unit) {
  var el = document.getElementById("svc-conn-view");
  if (!el) return;
  try {
    var d = await api.assets.serviceConnections(assetId, unit);
    _renderConnView(el, d, 'No connection data yet. Check <strong>Map</strong> for this unit in the Services tab to attribute its listening ports and connections (data appears within a minute or two).');
  } catch (err) {
    el.textContent = "Error: " + (err && err.message ? err.message : String(err));
  }
}

// Shared listening/outbound/inbound table renderer for the process + service
// connection panels (identical DTO shape from getAssetProcessConnections).
function _renderConnView(el, d, emptyMsg) {
  function remoteCell(r) {
    var addr = escapeHtml(r.remoteIp);
    if (r.remoteAssetId) {
      var label = escapeHtml(r.remoteHostname || r.remoteIp);
      return '<a href="#" class="proc-conn-asset-link" data-asset-id="' + escapeHtml(r.remoteAssetId) + '">' + label + '</a> <span style="color:var(--color-text-tertiary)">(' + addr + ')</span>';
    }
    return addr;
  }
  // api.js canonical (2026-08 audit — the local copy said "just now" for
  // anything under 90s and rounded up, so the same timestamp read
  // differently here than everywhere else).
  var ago = timeAgo;
  function table(headers, rowsHtml) {
    return '<table style="width:100%;border-collapse:collapse;font-size:0.78rem;margin:0.25rem 0 0.75rem">' +
      '<tr>' + headers.map(function (h) { return '<th style="text-align:left;padding:2px 8px 2px 0;border-bottom:1px solid var(--color-border);font-weight:500">' + h + '</th>'; }).join("") + '</tr>' +
      rowsHtml + '</table>';
  }
  var html = "";
  if (d.listening.length) {
    html += '<h5 style="margin:0.4rem 0 0;font-size:0.8rem">Listening (' + d.listening.length + ')</h5>';
    html += table(["Port", "Bind", "Last seen"], d.listening.map(function (r) {
      return '<tr><td style="padding:2px 8px 2px 0;font-family:var(--font-mono)">' + escapeHtml(r.proto + "/" + r.port) + '</td>' +
        '<td style="padding:2px 8px 2px 0;font-family:var(--font-mono)">' + escapeHtml(r.bindAddr || "—") + '</td>' +
        '<td style="padding:2px 8px 2px 0">' + ago(r.lastSeen) + '</td></tr>';
    }).join(""));
  }
  // Outbound + inbound share one "Peers" section with identical columns.
  // Source ports are ephemeral and never collected (agent stores only the
  // listening/destination side), so that column renders "—".
  function peerRow(r, srcPort, dstPort) {
    return '<tr><td style="padding:2px 8px 2px 0;font-family:var(--font-mono)">' + remoteCell(r) + '</td>' +
      '<td style="padding:2px 8px 2px 0;font-family:var(--font-mono)">' + srcPort + '</td>' +
      '<td style="padding:2px 8px 2px 0;font-family:var(--font-mono)">' + dstPort + '</td>' +
      '<td style="padding:2px 8px 2px 0">' + ago(r.lastSeen) + '</td></tr>';
  }
  var peerHeaders = ["Peer", "Source port", "Destination port", "Last seen"];
  if (d.outbound.length || d.inbound.length) {
    html += '<h5 style="margin:0.4rem 0 0;font-size:0.8rem">Peers</h5>';
  }
  if (d.outbound.length) {
    html += '<div style="margin:0.35rem 0 0;font-size:0.76rem;color:var(--color-text-secondary)">Outbound (' + d.outbound.length + ')</div>';
    html += table(peerHeaders, d.outbound.map(function (r) {
      return peerRow(r, "—", escapeHtml(r.proto + "/" + r.remotePort));
    }).join(""));
  }
  if (d.inbound.length) {
    html += '<div style="margin:0.35rem 0 0;font-size:0.76rem;color:var(--color-text-secondary)">Inbound (' + d.inbound.length + ')</div>';
    html += table(peerHeaders, d.inbound.map(function (r) {
      return peerRow(r, "—", escapeHtml(r.proto + "/" + r.localPort));
    }).join(""));
  }
  if (!html) {
    html = emptyMsg;
  }
  el.innerHTML = html;
  el.querySelectorAll(".proc-conn-asset-link").forEach(function (a) {
    a.addEventListener("click", function (ev) {
      ev.preventDefault();
      openViewModal(a.getAttribute("data-asset-id"));
    });
  });
}

async function _loadProcessLogsFor(assetId, name) {
  var el = document.getElementById("proc-logs-view");
  if (!el) return;
  var flaggedToggle = document.getElementById("proc-logs-flagged-only");
  var flaggedOnly = !!(flaggedToggle && flaggedToggle.checked);
  try {
    var data = await api.assets.processLogs(assetId, name, { limit: 300, flagged: flaggedOnly ? 1 : undefined });
    var logs = data.logs || [];
    if (!logs.length) {
      el.textContent = flaggedOnly
        ? "No flagged log lines in this window."
        : "No log lines collected yet. Set a log source/path above (or enable journald on Linux) and check that the program is pinned for Monitor.";
      return;
    }
    // Server returns newest-first; keep that order (newest at the top).
    el.innerHTML = logs.map(function (l) {
      var d = l.timestamp ? new Date(l.timestamp) : null;
      var ts = d ? d.toLocaleDateString(undefined, timeZoneOpts()) + " " + d.toLocaleTimeString(undefined, timeZoneOpts()) : "";
      var lvl = l.level ? "[" + escapeHtml(l.level) + "] " : "";
      var flags = Array.isArray(l.flags) ? l.flags : [];
      var badges = flags.map(function (f) {
        var col = f.color || "var(--color-warning)";
        return '<span style="display:inline-block;margin-left:6px;padding:0 5px;border-radius:3px;font-size:0.7rem;background:' + col + ';color:#000">' + escapeHtml(f.label || f.name) + '</span>';
      }).join("");
      var hl = flags.length ? ';background:rgba(245,158,11,0.12);border-left:2px solid var(--color-warning);padding-left:4px' : "";
      return '<div style="' + hl + '"><span style="color:var(--color-text-tertiary)">' + escapeHtml(ts) + '</span> ' + lvl + escapeHtml(l.message || "") + badges + '</div>';
    }).join("");
  } catch (err) {
    el.textContent = "Error: " + (err.message || "failed to load logs");
  }
}

// Manage-flag-rules modal: list rules (scoped to global + this asset/program),
// add a rule prefilled for this process, toggle enable, delete. onChange is
// invoked after any write so the caller can re-fetch the flagged view.
function openLogFlagRulesModal(asset, processName, onChange) {
  var bodyHTML =
    '<div id="lfr-modal">' +
      '<p class="hint" style="margin-top:0">Rules flag matching log lines at read time. Scope to all logs, this asset, or this program.</p>' +
      '<div id="lfr-list" style="margin-bottom:1rem">Loading…</div>' +
      '<h4 style="margin:0.5rem 0">Add rule</h4>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
        '<label style="font-size:0.8rem">Name<input type="text" id="lfr-name" style="width:100%;box-sizing:border-box"></label>' +
        '<label style="font-size:0.8rem">Scope<select id="lfr-scope" style="width:100%">' +
          '<option value="process">This program (' + escapeHtml(processName) + ')</option>' +
          '<option value="asset">This asset</option>' +
          '<option value="global">All process logs</option>' +
        '</select></label>' +
        '<label style="font-size:0.8rem">Match type<select id="lfr-matchtype" style="width:100%"><option value="substring">Contains</option><option value="regex">Regex</option><option value="glob">Glob</option></select></label>' +
        '<label style="font-size:0.8rem">Min level<select id="lfr-minlevel" style="width:100%"><option value="">Any</option><option value="warning">Warning+</option><option value="error">Error+</option><option value="critical">Critical</option></select></label>' +
        '<label style="font-size:0.8rem;grid-column:1/3">Pattern<input type="text" id="lfr-pattern" style="width:100%;box-sizing:border-box" placeholder="e.g. error  |  out of memory  |  *timeout*"></label>' +
        '<label style="font-size:0.8rem">Label<input type="text" id="lfr-label" style="width:100%;box-sizing:border-box" placeholder="optional"></label>' +
        '<label style="font-size:0.8rem;display:flex;align-items:center;gap:6px;margin-top:1.2rem"><input type="checkbox" id="lfr-case">Case-sensitive</label>' +
      '</div>' +
      '<div style="display:flex;justify-content:flex-end;margin-top:0.6rem"><button class="btn btn-sm btn-primary" id="lfr-add">Add rule</button></div>' +
    '</div>';
  openModal("Log flag rules — " + processName, bodyHTML, '<button class="btn btn-secondary" id="lfr-close">Close</button>');
  var closeBtn = document.getElementById("lfr-close");
  if (closeBtn) closeBtn.addEventListener("click", closeModal);

  async function refreshList() {
    var listEl = document.getElementById("lfr-list");
    if (!listEl) return;
    try {
      var resp = await api.logFlagRules.list();
      var rules = (resp && resp.rules) || [];
      // Show rules relevant to this view: global + this asset (+ its programs).
      rules = rules.filter(function (r) {
        return r.scope === "global" || r.assetId === asset.id;
      });
      if (!rules.length) { listEl.innerHTML = '<p class="empty-state" style="margin:0">No rules yet.</p>'; return; }
      listEl.innerHTML = '<table class="data-table" style="font-size:0.8rem;width:100%"><thead><tr><th>On</th><th>Name</th><th>Scope</th><th>Match</th><th>Pattern</th><th></th></tr></thead><tbody>' +
        rules.map(function (r) {
          var scopeLabel = r.scope === "process" ? ("program: " + escapeHtml(r.processName || "?")) : r.scope === "asset" ? "this asset" : "global";
          return '<tr>' +
            '<td><input type="checkbox" class="lfr-enable" data-id="' + r.id + '"' + (r.enabled ? " checked" : "") + '></td>' +
            '<td>' + escapeHtml(r.name) + '</td>' +
            '<td>' + scopeLabel + '</td>' +
            '<td>' + escapeHtml(r.matchType) + '</td>' +
            '<td class="mono">' + escapeHtml(r.pattern) +
              // Business rule 116: a stored regex the linear-time engine cannot
              // compile is skipped until it is rewritten.
              (r.patternProblem ? '<div style="color:var(--color-danger);font-family:inherit;margin-top:2px" title="' + escapeHtml(r.patternProblem) + '">Skipped — ' + escapeHtml(r.patternProblem) + '</div>' : '') +
            '</td>' +
            '<td><button class="btn btn-sm btn-danger lfr-del" data-id="' + r.id + '">Delete</button></td>' +
          '</tr>';
        }).join("") + '</tbody></table>';
      listEl.querySelectorAll(".lfr-enable").forEach(function (cb) {
        cb.addEventListener("change", async function () {
          try { await api.logFlagRules.update(cb.getAttribute("data-id"), { enabled: cb.checked }); if (onChange) onChange(); }
          catch (err) { showToast(err.message || "Update failed", "error"); cb.checked = !cb.checked; }
        });
      });
      listEl.querySelectorAll(".lfr-del").forEach(function (b) {
        b.addEventListener("click", async function () {
          try { await api.logFlagRules.remove(b.getAttribute("data-id")); refreshList(); if (onChange) onChange(); }
          catch (err) { showToast(err.message || "Delete failed", "error"); }
        });
      });
    } catch (err) {
      listEl.textContent = "Error: " + (err.message || "failed to load rules");
    }
  }

  var addBtn = document.getElementById("lfr-add");
  if (addBtn) {
    addBtn.addEventListener("click", async function () {
      var scope = document.getElementById("lfr-scope").value;
      var body = {
        name:        document.getElementById("lfr-name").value.trim(),
        scope:       scope,
        assetId:     scope === "global" ? null : asset.id,
        processName: scope === "process" ? processName : null,
        matchType:   document.getElementById("lfr-matchtype").value,
        pattern:     document.getElementById("lfr-pattern").value,
        caseSensitive: document.getElementById("lfr-case").checked,
        minLevel:    document.getElementById("lfr-minlevel").value || null,
        label:       document.getElementById("lfr-label").value.trim() || null,
      };
      if (!body.name || !body.pattern) { showToast("Name and pattern are required", "error"); return; }
      addBtn.disabled = true;
      try {
        await api.logFlagRules.create(body);
        showToast("Rule added", "success");
        document.getElementById("lfr-name").value = "";
        document.getElementById("lfr-pattern").value = "";
        document.getElementById("lfr-label").value = "";
        refreshList();
        if (onChange) onChange();
      } catch (err) {
        showToast(err.message || "Failed to add rule", "error");
      } finally {
        addBtn.disabled = false;
      }
    });
  }
  refreshList();
}
