/**
 * public/js/server-settings-maintenance.js — Server Settings → Maintenance and
 * Retention: the database card, agent event-log collection, capacity advisor,
 * platform lifecycle, the capacity alert hold (business rule 105), sample
 * retention, backup / restore / scheduled backups / backup history, and
 * application updates.
 *
 * Split out of server-settings.js (CQ-F051) as a byte-for-byte move. A plain
 * browser script: its functions and `var`s are page globals, called from the
 * core's tab dispatch (`loadDatabaseInfo`, `loadRetentionTab`). Loads AFTER
 * server-settings.js — tests/unit/serverSettingsSplit.test.ts holds the order.
 */

// ─── Maintenance Tab ───────────────────────────────────────────────────────

var _dbLoaded = false;
var _advisorJustStaged = false;
// True when Polaris runs in a container. There the advisor asks the operator
// to restart the container instead of offering a self-restart — a self-exit
// leaves a container with no restart policy stopped, and POST /restart
// refuses with 409.
var _advisorInContainer = false;
var _retentionLoaded = false;

// ─── Retention Tab (sample retention only — event retention lives on the
//                    Events Settings page) ─────────────────────────────────
//
// Lazy-loaded on first click of the Retention tab. Fetches the global
// Setting("sampleRetention") via api.serverSettings.getSampleRetention()
// and reuses the existing renderSampleRetentionCard / _wireSampleRetentionCard
// helpers. Was previously crammed into the Maintenance tab; phase 7 moved
// it here so the Maintenance tab keeps its DB-health focus.

async function loadRetentionTab() {
  var container = document.getElementById("tab-retention");
  if (!container) return;
  container.innerHTML = '<div class="settings-card"><p class="empty-state">Loading retention settings…</p></div>';
  try {
    var results = await Promise.allSettled([
      api.serverSettings.getSampleRetention(),
      api.serverSettings.getAgentEventLog(),
    ]);
    if (results[0].status === "rejected") throw results[0].reason;
    var retention = results[0].value && results[0].value.retention ? results[0].value.retention : null;
    var eventLogCfg = results[1].status === "fulfilled" && results[1].value && results[1].value.config
      ? results[1].value.config
      : null;
    _retentionLoaded = true;
    container.innerHTML = renderSampleRetentionCard(retention) + renderAgentEventLogCard(eventLogCfg);
    _wireSampleRetentionCard();
    _wireAgentEventLogCard();
  } catch (err) {
    container.innerHTML = '<div class="settings-card"><p class="empty-state">Error: ' + escapeHtml(err && err.message ? err.message : String(err)) + '</p></div>';
  }
}

// ─── Agent OS event-log collection card ───────────────────────────────────
// Global master switch + curation filter for the OS event-log → audit Events
// ingest. Default disabled; opt-in. Sits on the Retention tab because it
// governs how much host-event data flows into the (retention-bounded) audit
// log. Backed by Setting("agentEventLog") via api.serverSettings.getAgentEventLog().
function renderAgentEventLogCard(cfg) {
  var c = cfg || {};
  var enabled = c.enabled === true;
  var minLevel = c.minLevel === "info" || c.minLevel === "warning" || c.minLevel === "error" ? c.minLevel : "error";
  var channels = Array.isArray(c.windowsChannels) ? c.windowsChannels.join(", ") : "System, Application";
  var linuxPri = (typeof c.linuxMinPriority === "number") ? c.linuxMinPriority : 3;
  var maxPush  = (typeof c.maxPerPush === "number") ? c.maxPerPush : 100;
  var hourlyCap = (typeof c.perAssetHourlyCap === "number") ? c.perAssetHourlyCap : 500;
  function lvlOpt(v, label) { return '<option value="' + v + '"' + (minLevel === v ? " selected" : "") + '>' + label + '</option>'; }
  return '<div class="settings-card" id="agent-event-log-card" style="margin-top:1rem">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">' +
      '<h4 style="margin:0">Agent OS Event Log</h4>' +
      '<button class="btn btn-primary" id="btn-agent-event-log-save">Save</button>' +
    '</div>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.85rem">' +
      'When enabled, Polaris Agents ship matching OS event-log entries (Windows Event Log / Linux journald) which appear on each asset\'s <strong>Events</strong> tab and forward through your syslog / SFTP archival. Off by default. ' +
      'Event messages can contain hostnames or sensitive text — keep the severity filter tight and review before relying on it for compliance.' +
    '</p>' +
    '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;margin-bottom:0.85rem">' +
      '<input type="checkbox" id="ael-enabled" style="width:15px;height:15px"' + (enabled ? " checked" : "") + '>' +
      '<span style="font-size:0.9rem;font-weight:600">Collect OS event logs from agents</span>' +
    '</label>' +
    '<div class="form-row" style="gap:14px;flex-wrap:wrap">' +
      '<div style="min-width:160px"><label for="ael-min-level">Minimum severity</label>' +
        '<select id="ael-min-level">' + lvlOpt("error", "Error + Critical") + lvlOpt("warning", "Warning and up") + lvlOpt("info", "Info and up") + '</select>' +
        '<p class="hint" style="font-size:0.74rem">Lower = more volume in the audit log.</p>' +
      '</div>' +
      '<div style="min-width:120px"><label for="ael-linux-pri">Linux journald priority ≤</label>' +
        '<input type="number" id="ael-linux-pri" min="0" max="7" value="' + linuxPri + '" style="width:90px">' +
        '<p class="hint" style="font-size:0.74rem">0 emerg … 7 debug (3 = err).</p>' +
      '</div>' +
    '</div>' +
    '<div class="form-group" style="margin-top:0.6rem"><label for="ael-win-channels">Windows channels</label>' +
      '<input type="text" id="ael-win-channels" value="' + escapeHtml(channels) + '" placeholder="System, Application" style="width:100%;max-width:420px">' +
      '<p class="hint" style="font-size:0.74rem">Comma-separated Windows Event Log channel names.</p>' +
    '</div>' +
    '<div class="form-row" style="gap:14px;flex-wrap:wrap;margin-top:0.6rem">' +
      '<div style="min-width:140px"><label for="ael-max-push">Max entries per push</label>' +
        '<input type="number" id="ael-max-push" min="1" max="5000" value="' + maxPush + '" style="width:110px"></div>' +
      '<div style="min-width:160px"><label for="ael-hourly-cap">Per-asset hourly cap</label>' +
        '<input type="number" id="ael-hourly-cap" min="1" max="100000" value="' + hourlyCap + '" style="width:120px">' +
        '<p class="hint" style="font-size:0.74rem">Overflow is summarized into one event.</p>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function _wireAgentEventLogCard() {
  var saveBtn = document.getElementById("btn-agent-event-log-save");
  if (!saveBtn) return;
  saveBtn.addEventListener("click", async function () {
    var channelsRaw = (document.getElementById("ael-win-channels").value || "");
    var payload = {
      enabled: document.getElementById("ael-enabled").checked === true,
      minLevel: document.getElementById("ael-min-level").value,
      windowsChannels: channelsRaw.split(",").map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; }),
      linuxMinPriority: parseInt(document.getElementById("ael-linux-pri").value, 10),
      maxPerPush: parseInt(document.getElementById("ael-max-push").value, 10),
      perAssetHourlyCap: parseInt(document.getElementById("ael-hourly-cap").value, 10),
    };
    saveBtn.disabled = true;
    try {
      await api.serverSettings.setAgentEventLog(payload);
      showToast("Agent OS event-log settings saved", "success");
    } catch (err) {
      showToast("Save failed: " + (err && err.message ? err.message : String(err)), "error");
    } finally {
      saveBtn.disabled = false;
    }
  });
}

// api.js formatBytes with the capacity card's em-dash for missing kept.
function _capacityFormatBytes(b) {
  if (b == null) return "—";
  return formatBytes(b);
}

/**
 * A row in the Database card's table list that is NOT one of Polaris's tables —
 * pg-boss, the PostgreSQL catalog, the unattributed residual. Rendered subdued
 * and without a row count so it reads as accounting rather than as a table.
 * Returns "" for a zero/absent bucket: an install with no pg-boss schema should
 * not carry a 0 B line for it.
 */
function _capacityUnlistedRow(label, bytes, hint) {
  if (!bytes || bytes <= 0) return "";
  return '<tr title="' + escapeHtml(hint) + '">' +
    '<td style="font-size:0.78rem;font-style:italic;color:var(--color-text-secondary)">' +
      escapeHtml(label) +
    '</td>' +
    '<td style="text-align:right;color:var(--color-text-secondary)">—</td>' +
    '<td style="text-align:right;font-size:0.82rem;color:var(--color-text-secondary)">' +
      escapeHtml(_capacityFormatBytes(bytes)) +
    '</td>' +
    '</tr>';
}

function _capacitySeverityLabel(s) {
  // Accept both the new vocabulary (critical/warning/watch/ok) and the
  // legacy color names (red/amber) so a stale snapshot returned from an
  // older server build still renders cleanly during a partial rollout.
  if (s === "critical" || s === "red") return "Critical";
  if (s === "warning" || s === "amber") return "Action recommended";
  if (s === "watch") return "Watch";
  return "Healthy";
}

// CSS classes for the capacity pills/cards stay on the color vocabulary
// (`capacity-pill-red`, `capacity-reason-amber`, etc.) — they're tied to
// the actual colors, not to severity names, so renaming the enum doesn't
// change them. This helper maps a severity to its CSS class suffix.
function _capacitySeverityCssClass(s) {
  if (s === "critical" || s === "red") return "red";
  if (s === "warning" || s === "amber") return "amber";
  if (s === "watch") return "watch";
  return "ok";
}

// Friendly label for a volume's set of roles. Matches the backend's
// `volumeLabel()` so the UI and the audit-log Event message use the same
// terminology.
function _capacityVolumeLabel(roles) {
  if (!roles || !roles.length) return "Volume";
  if (roles.length === 1) {
    if (roles[0] === "db") return "Database volume";
    if (roles[0] === "app") return "Application volume";
    if (roles[0] === "state") return "State volume";
    if (roles[0] === "backups") return "Backups volume";
  }
  if (roles.indexOf("db") !== -1 && roles.indexOf("app") !== -1) return "Application + DB volume";
  if (roles.indexOf("db") !== -1) return "DB volume";
  return "Application volume";
}

// Render one volume row inside the Application host card. Bar-style indicator
// gives the operator a quick at-a-glance read on each filesystem; numeric
// detail is shown alongside.
function _capacityRenderVolume(v) {
  if (!v || !v.totalBytes) return "";
  var pct = v.freeBytes / v.totalBytes;
  var pctLabel = (pct * 100).toFixed(1) + "%";
  var barClass = "capacity-bar capacity-bar-ok";
  if (pct < 0.10) barClass = "capacity-bar capacity-bar-red";
  else if (pct < 0.20) barClass = "capacity-bar capacity-bar-amber";
  else if (pct < 0.30) barClass = "capacity-bar capacity-bar-watch";
  // Used % is the inverse of free %; show that bar so a fuller volume reads
  // as a longer/redder bar (the conventional disk-meter direction).
  var usedPct = (1 - pct) * 100;
  var pathLabel = (v.paths && v.paths.length) ? v.paths.join(", ") : "—";
  var rolesLabel = _capacityVolumeLabel(v.roles);
  return (
    '<div style="display:flex;flex-direction:column;gap:0.2rem;margin-bottom:0.55rem">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:0.5rem">' +
        '<span style="font-size:0.82rem;font-weight:600">' + escapeHtml(rolesLabel) + '</span>' +
        '<span style="font-size:0.78rem;color:var(--color-text-secondary)">' +
          _capacityFormatBytes(v.freeBytes) + ' free of ' + _capacityFormatBytes(v.totalBytes) + ' (' + escapeHtml(pctLabel) + ')' +
        '</span>' +
      '</div>' +
      '<div style="height:6px;background:var(--color-bg-tertiary, rgba(127,127,127,0.18));border-radius:3px;overflow:hidden">' +
        '<div class="' + barClass + '" style="height:100%;width:' + Math.min(100, Math.max(0, usedPct)).toFixed(1) + '%"></div>' +
      '</div>' +
      '<div style="font-size:0.74rem;color:var(--color-text-tertiary);font-family:var(--font-mono, monospace)">' + escapeHtml(pathLabel) + '</div>' +
    '</div>'
  );
}

// Combined Database Engine + Connection Pool stat card. The two sets of
// fields are tightly related (engine identity + its live connection
// state) and were taking up two cards' worth of horizontal space — fold
// them into one card with sub-headings so the Maintenance tab reads as
// host / database / engine+pool / monitoring rather than four narrow
// columns where the engine and pool barely overlap on what they tell
// the operator.
function renderEnginePoolStatHtml(db, capacity) {
  if (!db) return "";
  var hasPool = db.uptime || db.activeConnections !== undefined || db.maxConnections !== undefined;

  var engineRows =
    dbInfoRow("Type", db.type || "Unknown") +
    dbInfoRow("Version", db.version || "Unknown") +
    (db.host ? dbInfoRow("Host", db.host + (db.port ? ":" + db.port : "")) : "") +
    (db.database ? dbInfoRow("Database", db.database) : "") +
    (db.ssl ? dbInfoRow("SSL", db.ssl) : "");

  // Polaris-side pool sizing comes from the capacity snapshot. Render
  // alongside the DB-side counters so operators see configured capacity
  // (Prisma + pg-boss) and observed usage (current + peak) on one card
  // without having to cross-reference the snapshot JSON.
  var pollPool = capacity && capacity.database && capacity.database.connectionPool;
  var polarisPoolRows = "";
  if (pollPool) {
    var prismaSize = pollPool.prismaPoolSize;
    var pgbossSize = pollPool.pgbossPoolSize;
    var configured = prismaSize + (pgbossSize || 0);
    var configuredLabel = pgbossSize !== null && pgbossSize !== undefined
      ? configured + ' (Prisma ' + prismaSize + ' + pg-boss ' + pgbossSize + ')'
      : String(configured);
    polarisPoolRows =
      dbInfoRow("Polaris pool size", configuredLabel) +
      dbInfoRow("Peak observed", String(pollPool.peakObserved));
  }

  var poolRows = hasPool
    ? (db.activeConnections !== undefined ? dbInfoRow("Active connections", db.activeConnections) : "") +
      (db.maxConnections !== undefined ? dbInfoRow("Max connections", db.maxConnections) : "") +
      polarisPoolRows +
      (db.uptime ? dbInfoRow("Uptime", db.uptime) : "")
    : polarisPoolRows;

  return '<div class="capacity-stat-card">' +
    '<h5>Database engine</h5>' +
    '<div class="db-info-grid">' + engineRows + '</div>' +
    (poolRows
      ? '<h5 style="margin-top:0.85rem">Connection pool</h5>' +
        '<div class="db-info-grid">' + poolRows + '</div>'
      : '') +
  '</div>';
}

// ─── Capacity Advisor card ────────────────────────────────────────────────

// Lever rows are grouped into three sections so the operator can scan them
// quickly:
//   - "queue":         the QUEUE_MODE lever (queue-mode-endpoint apply)
//   - "env":           DATABASE_POOL_SIZE / POLARIS_PGBOSS_POOL_SIZE / per-cadence workers
//   - "advisory":      PG_MAX_CONNECTIONS / PG_* tuning (no Stage button)
function _advisorSection(rec) {
  if (rec.key === "QUEUE_MODE") return "queue";
  if (rec.applyMode === "advisory-only") return "advisory";
  return "env";
}

// Friendly labels for the levers shown in the table.
function _advisorLabel(key) {
  switch (key) {
    case "QUEUE_MODE":                       return "Queue mode";
    case "DATABASE_POOL_SIZE":               return "DATABASE_POOL_SIZE (Prisma pool)";
    case "POLARIS_PGBOSS_POOL_SIZE":         return "POLARIS_PGBOSS_POOL_SIZE";
    case "POLARIS_MONITOR_PROBE_WORKERS":    return "POLARIS_MONITOR_PROBE_WORKERS";
    case "POLARIS_MONITOR_FAST_WORKERS":     return "POLARIS_MONITOR_FAST_WORKERS";
    case "POLARIS_MONITOR_HEAVY_WORKERS":    return "POLARIS_MONITOR_HEAVY_WORKERS";
    case "POLARIS_MONITOR_FLOATING_WORKERS": return "POLARIS_MONITOR_FLOATING_WORKERS";
    case "POLARIS_PROBE_CONCURRENCY":        return "POLARIS_PROBE_CONCURRENCY (cursor)";
    case "POLARIS_HEAVY_CONCURRENCY":        return "POLARIS_HEAVY_CONCURRENCY (cursor)";
    case "PG_MAX_CONNECTIONS":               return "PostgreSQL max_connections";
    case "PG_SHARED_BUFFERS":                return "shared_buffers";
    case "PG_EFFECTIVE_CACHE_SIZE":          return "effective_cache_size";
    case "PG_WORK_MEM":                      return "work_mem";
    case "PG_RANDOM_PAGE_COST":              return "random_page_cost";
    default:                                 return key;
  }
}

// Filter the advisor's full recommendation list down to what's relevant to
// the recommended queue mode. Cursor mode hides POLARIS_MONITOR_*_WORKERS +
// POLARIS_PGBOSS_POOL_SIZE; pg-boss mode hides POLARIS_*_CONCURRENCY.
function _advisorRecommendationsForView(advisor) {
  if (!advisor || !Array.isArray(advisor.recommendations)) return [];
  var mode = advisor.recommendedQueueMode || "cursor";
  return advisor.recommendations.filter(function (r) {
    if (mode === "pgboss") {
      return r.key !== "POLARIS_PROBE_CONCURRENCY" && r.key !== "POLARIS_HEAVY_CONCURRENCY";
    }
    return r.key !== "POLARIS_PGBOSS_POOL_SIZE" &&
           r.key !== "POLARIS_MONITOR_PROBE_WORKERS" &&
           r.key !== "POLARIS_MONITOR_FAST_WORKERS" &&
           r.key !== "POLARIS_MONITOR_HEAVY_WORKERS" &&
           r.key !== "POLARIS_MONITOR_FLOATING_WORKERS";
  });
}

function _advisorRowHtml(rec, advisor, pgConfigFile) {
  var section = _advisorSection(rec);
  var label = _advisorLabel(rec.key);
  var current = rec.current === null || rec.current === undefined ? "—" : String(rec.current);
  var recommended = String(rec.recommended);
  // operatorOverride wins: the value was set explicitly via ALTER SYSTEM
  // (postgresql.auto.conf), so it's a deliberate choice the advisor honors —
  // never "Stage", even when it differs from the heuristic recommendation.
  var pillCls, pillLabel;
  if (rec.operatorOverride) {
    pillCls = "advisor-pill advisor-pill-ok";
    pillLabel = "Operator-set";
  } else if (rec.changeRequired) {
    pillCls = "advisor-pill advisor-pill-change";
    pillLabel = "Stage";
  } else {
    pillCls = "advisor-pill advisor-pill-ok";
    pillLabel = "OK";
  }

  // Cold-start badge for cadence-driven rows.
  var coldStartBadge = "";
  var coldKeys = ["POLARIS_MONITOR_PROBE_WORKERS","POLARIS_MONITOR_FAST_WORKERS","POLARIS_MONITOR_HEAVY_WORKERS","POLARIS_MONITOR_FLOATING_WORKERS","POLARIS_PROBE_CONCURRENCY","POLARIS_HEAVY_CONCURRENCY"];
  if (advisor && advisor.usingColdStartDefaults && coldKeys.indexOf(rec.key) !== -1) {
    coldStartBadge = ' <span class="advisor-cold-badge" title="Histogram samples insufficient — using cold-start defaults until populated">cold-start</span>';
  }
  // "Applies after queue-mode flip" hint for cursor-only / pgboss-only levers
  // when the recommended mode differs from the active mode.
  var modeFlipHint = "";
  if (rec.appliesAfterQueueModeFlip) {
    modeFlipHint = ' <span class="advisor-cold-badge" title="Takes effect after the queue-mode flip is applied">post-flip</span>';
  }
  var overrideNote = rec.operatorOverride
    ? " — set explicitly via ALTER SYSTEM (postgresql.auto.conf); advisory recommendation overridden"
    : "";
  var tooltip = "";
  if (rec.breakdown && typeof rec.breakdown === "object") {
    try {
      var parts = Object.keys(rec.breakdown).map(function (k) { return k + "=" + rec.breakdown[k]; });
      tooltip = ' title="' + escapeHtml(rec.rationale + " — " + parts.join(", ") + overrideNote) + '"';
    } catch (e) {
      tooltip = ' title="' + escapeHtml((rec.rationale || "") + overrideNote) + '"';
    }
  } else if (rec.rationale || overrideNote) {
    tooltip = ' title="' + escapeHtml((rec.rationale || "") + overrideNote) + '"';
  }

  // Checkbox column: shown only on env / queue rows where changeRequired = true.
  var checkboxCell = "";
  if (section !== "advisory") {
    if (rec.changeRequired) {
      checkboxCell = '<input type="checkbox" class="advisor-stage-checkbox" data-key="' + escapeHtml(rec.key) + '" checked>';
    } else {
      checkboxCell = '<span class="muted">—</span>';
    }
  } else if (rec.key === "PG_MAX_CONNECTIONS" || rec.key === "PG_SHARED_BUFFERS" || rec.key === "PG_EFFECTIVE_CACHE_SIZE" || rec.key === "PG_WORK_MEM" || rec.key === "PG_RANDOM_PAGE_COST") {
    // Advisory-only rows: surface the pgConfigFile hint inline on the last advisory row.
    checkboxCell = '<span class="muted">manual</span>';
  }

  return '<tr class="advisor-row advisor-row-' + section + (rec.changeRequired ? " advisor-row-change" : "") + '"' + tooltip + '>' +
    '<td>' + escapeHtml(label) + coldStartBadge + modeFlipHint + '</td>' +
    '<td class="mono">' + escapeHtml(current) + '</td>' +
    '<td class="mono">' + escapeHtml(recommended) + '</td>' +
    '<td><span class="' + pillCls + '">' + pillLabel + '</span></td>' +
    '<td style="text-align:center">' + checkboxCell + '</td>' +
  '</tr>';
}

function renderCapacityAdvisorCard(advisor, pgConfigFile, dbConnectionMode) {
  if (!advisor) return "";
  var recs = _advisorRecommendationsForView(advisor);
  if (recs.length === 0) return "";

  // Counted from the rows on screen, not advisor.anyChangeRequired: the view
  // filter can drop every changed row, and the header then read
  // "0 recommendations available" in amber.
  var changeCount = recs.filter(function (r) { return r.changeRequired; }).length;
  var headerNote = changeCount > 0
    ? '<span class="advisor-header-amber">' + changeCount + ' recommendation' + (changeCount === 1 ? "" : "s") + ' available</span>'
    : "";

  var coldStartNote = advisor.usingColdStartDefaults
    ? '<p class="hint" style="margin:0.4rem 0 0 0;font-size:0.78rem">Some cadences are using cold-start defaults until the histogram populates (~24h). Recommendations may shift once real workload duration data is observed.</p>'
    : "";

  // PgBouncer mode shifts what max_connections actually needs to support:
  // PgBouncer multiplexes Polaris's pool slots onto a much smaller backend
  // pool, so the advisor's max_connections recommendation is an upper bound
  // rather than a strict requirement under this topology.
  var pgbouncerNote = dbConnectionMode === "pgbouncer"
    ? '<p class="hint" style="margin:0.4rem 0 0 0;font-size:0.78rem;color:var(--color-text-secondary)">PgBouncer detected. Polaris\'s pool size is what it opens to PgBouncer; PgBouncer\'s <code>default_pool_size</code> is what reaches PostgreSQL. The <code>PostgreSQL max_connections</code> recommendation below is a conservative upper bound — your actual PG max only needs to support PgBouncer\'s configured pool sizes plus admin/autovacuum overhead.</p>'
    : "";

  var groupedRows = {
    queue: recs.filter(function (r) { return _advisorSection(r) === "queue"; }),
    env:   recs.filter(function (r) { return _advisorSection(r) === "env";   }),
    advisory: recs.filter(function (r) { return _advisorSection(r) === "advisory"; }),
  };

  function renderRows(list) {
    return list.map(function (r) { return _advisorRowHtml(r, advisor, pgConfigFile); }).join("");
  }

  var staged = recs.filter(function (r) { return r.applyMode !== "advisory-only" && r.changeRequired; }).length;
  var stageBtn;
  if (_advisorJustStaged && staged === 0) {
    stageBtn = _advisorInContainer
      ? _advisorContainerRestartHtml()
      : '<button class="btn btn-warning" id="capacity-advisor-restart-btn">Restart Polaris to apply</button>';
  } else if (staged > 0) {
    stageBtn = '<button class="btn btn-primary" id="capacity-advisor-stage-btn" data-staged-count="' + staged + '">Stage selected</button>';
  } else {
    stageBtn = '<button class="btn btn-primary" disabled>Stage selected</button>';
  }

  var pgConfigHint = pgConfigFile
    ? '<p class="hint" style="margin:0.4rem 0 0 0;font-size:0.78rem">Advisory-only settings live in <code>' + escapeHtml(pgConfigFile) + '</code>. Edit and restart PostgreSQL to apply.</p>'
    : "";

  return '<div class="settings-card capacity-advisor-card severity-edge severity-edge-' + (changeCount > 0 ? "amber" : "ok") + '" id="capacity-advisor-card">' +
    '<div class="capacity-header">' +
      '<h4 style="margin:0">Capacity Advisor</h4>' +
      headerNote +
    '</div>' +
    coldStartNote +
    pgbouncerNote +
    // Half-width card since the Maintenance reorder — the five fixed columns
    // no longer fit at every viewport, so the table scrolls inside its own
    // container rather than crushing the Setting column or the grid cell.
    '<div style="overflow-x:auto;margin-top:0.75rem">' +
    '<table class="ip-table advisor-table" style="width:100%;min-width:36rem">' +
      '<thead><tr>' +
        '<th>Setting</th>' +
        '<th style="width:8rem">Current</th>' +
        '<th style="width:8rem">Recommended</th>' +
        '<th style="width:6rem">Status</th>' +
        '<th style="width:5rem;text-align:center">Stage</th>' +
      '</tr></thead>' +
      '<tbody>' +
        (groupedRows.queue.length ? renderRows(groupedRows.queue) : "") +
        (groupedRows.env.length
          ? '<tr class="advisor-divider"><td colspan="5"><strong>Pool &amp; worker (apply via .env, restart Polaris)</strong></td></tr>' + renderRows(groupedRows.env)
          : "") +
        (groupedRows.advisory.length
          ? '<tr class="advisor-divider"><td colspan="5"><strong>Advisory-only (require PostgreSQL restart)</strong></td></tr>' + renderRows(groupedRows.advisory)
          : "") +
      '</tbody>' +
    '</table>' +
    '</div>' +
    pgConfigHint +
    '<div style="margin-top:0.85rem;display:flex;align-items:center;gap:0.75rem">' +
      stageBtn +
      '<span class="hint" style="font-size:0.78rem">Computed ' + escapeHtml(formatLocalTime(advisor.computedAt)) + '. ' + (_advisorInContainer ? 'Restart the Polaris container(s) after Stage to pick up changes.' : 'Restart Polaris after Stage to pick up changes.') + '</span>' +
    '</div>' +
  '</div>';
}

// ─── Platform Lifecycle card ──────────────────────────────────────────────
//
// What this host is running, and whether any of it is past or approaching end
// of life. Data comes from GET /server-settings/platform-lifecycle, which
// grades the observed stack against the committed, human-reviewed dataset in
// src/data/platformEol.json.
//
// Deliberately NO action buttons: nothing on this card is one-click fixable,
// and offering a button that cannot do the thing would be a lie. Contrast the
// two capacity reason codes that legitimately get one.

function _lifecycleStateLabel(state) {
  if (state === "below_minimum") return "Below minimum";
  if (state === "eol") return "End of life";
  if (state === "eol_extended") return "EOL (extended support)";
  if (state === "unpatched") return "Security update";
  if (state === "approaching_eol") return "Approaching EOL";
  if (state === "aging") return "Aging";
  // Distinct from "Aging" on purpose: this row is below the version Polaris
  // targets, which is a preference and not a date. "Aging" here was misread as
  // "needs upgrading" for a component with 386 days of support left.
  if (state === "behind_target") return "Behind target";
  if (state === "ahead_of_tested") return "Ahead of tested";
  if (state === "current") return "Current";
  if (state === "not_installed") return "Not installed";
  return "Unknown";
}

// "in 74 days" / "131 days ago" reads faster than a bare date, and the date is
// alongside it anyway.
function _lifecycleWhen(grade) {
  if (grade.daysUntilEol === null || grade.daysUntilEol === undefined) return "";
  var d = grade.daysUntilEol;
  if (d === 0) return "today";
  if (d > 0) return "in " + d + " day" + (d === 1 ? "" : "s");
  return -d + " day" + (d === -1 ? "" : "s") + " ago";
}

function _lifecycleRowHtml(c) {
  var g = c.grade || {};
  var css = _capacitySeverityCssClass(g.severity === "none" ? "ok" : g.severity);
  var when = _lifecycleWhen(g);

  var supportedUntil = g.eolAt
    ? escapeHtml(g.eolAt) + (when ? ' <span class="hint" style="font-size:0.72rem">(' + escapeHtml(when) + ')</span>' : "")
    : (c.policy === "dated" ? '<span class="hint">—</span>' : '<span class="hint">no published date</span>');

  var installed = c.observedVersion
    ? escapeHtml(c.observedVersion)
    : '<span class="hint">' + escapeHtml(c.probeStatus === "absent" ? "not installed" : "unknown") + "</span>";

  // probeNote can carry raw `go version` / `nginx -v` output from the host, so
  // it is escaped like everything else even though the dataset is committed.
  var titleAttr = c.probeNote ? ' title="' + escapeHtml(c.probeNote) + '"' : "";

  var target = c.polarisTarget
    ? escapeHtml(c.polarisTarget) +
      (c.targetTrackEolAt ? ' <span class="hint" style="font-size:0.72rem">(to ' + escapeHtml(c.targetTrackEolAt) + ')</span>' : "")
    : '<span class="hint">—</span>';

  var detail = "";
  var interesting = g.severity && g.severity !== "none";
  // An open advisory is a patch-level update inside the same track, so the
  // major-upgrade playbook below would be the wrong instructions.
  if (g.state === "unpatched" && g.securityFloor) {
    var sf = g.securityFloor;
    detail =
      '<tr class="lifecycle-detail-row"><td colspan="5" style="padding:0 8px 8px;font-size:0.8rem">' +
        "Update to <strong>" + escapeHtml(sf.version) + "</strong> or later on this line — " +
        // Each CVE carries the vendor's rating; the worst one set the row colour.
        (sf.advisories || []).map(function (a) {
          return escapeHtml(a.id) + ' <span class="hint">(' + escapeHtml(a.severity) + ")</span>";
        }).join(", ") +
        (sf.source ? ' <span class="hint">(' + escapeHtml(sf.source) + ")</span>" : "") +
      "</td></tr>";
  } else if (interesting && c.playbook) {
    var steps = (c.playbook.steps || []).map(function (s) {
      return "<li>" + escapeHtml(s) + "</li>";
    }).join("");
    var files = (c.playbook.files || []).map(function (f) {
      return "<code>" + escapeHtml(f) + "</code>";
    }).join(", ");
    detail =
      '<tr class="lifecycle-detail-row"><td colspan="5" style="padding:0 8px 8px">' +
        '<details>' +
          '<summary style="cursor:pointer;font-size:0.8rem">How to upgrade — ' + escapeHtml(c.playbook.title || "") + '</summary>' +
          '<div style="margin:0.5rem 0 0 0;font-size:0.8rem">' +
            (steps ? "<ol style=\"margin:0 0 0.5rem 1.1rem;padding:0\">" + steps + "</ol>" : "") +
            (files ? '<p class="hint" style="margin:0.25rem 0 0">Files that move together: ' + files + "</p>" : "") +
            (c.playbook.docAnchor ? '<p class="hint" style="margin:0.25rem 0 0">See <code>' + escapeHtml(c.playbook.docAnchor) + "</code></p>" : "") +
          "</div>" +
        "</details>" +
      "</td></tr>";
  }

  // Only a row that needs something is tinted; a healthy row stays a plain
  // table row so the problems stand out (the Status pill still says Current).
  var rowClass = interesting ? ' class="capacity-reason-' + css + '"' : "";
  return "<tr" + rowClass + titleAttr + ">" +
      "<td><strong>" + escapeHtml(c.label || c.id) + "</strong></td>" +
      "<td>" + target + "</td>" +
      "<td>" + installed + "</td>" +
      "<td>" + supportedUntil + "</td>" +
      '<td><span class="capacity-pill capacity-pill-' + css + '">' + escapeHtml(_lifecycleStateLabel(g.state)) + "</span></td>" +
    "</tr>" + detail;
}

function renderPlatformLifecycleCard(lifecycle) {
  // Same empty contract as the advisor card, so the row layout cannot break.
  if (!lifecycle) return "";

  if (lifecycle.datasetError) {
    // A broken dataset gets a visible message, never a silently empty card.
    return '<div class="settings-card severity-edge severity-edge-amber" id="platform-lifecycle-card">' +
      '<div class="capacity-header"><h4 style="margin:0">Platform Lifecycle</h4>' +
      '<span class="capacity-pill capacity-pill-amber">Unavailable</span></div>' +
      '<p class="hint" style="margin:0.6rem 0 0">The end-of-life dataset could not be read: ' +
        escapeHtml(lifecycle.datasetError) +
      "</p></div>";
  }

  var components = lifecycle.components || [];
  if (components.length === 0) return "";

  // Worst first: an operator should not have to scan for the problem.
  var order = { critical: 0, warning: 1, watch: 2, none: 3 };
  var sorted = components.slice().sort(function (a, b) {
    var d = (order[a.grade.severity] ?? 3) - (order[b.grade.severity] ?? 3);
    return d !== 0 ? d : String(a.label || a.id).localeCompare(String(b.label || b.id));
  });

  var severity = lifecycle.severity === "none" ? "ok" : lifecycle.severity;
  var pillClass = "capacity-pill capacity-pill-" + _capacitySeverityCssClass(severity);
  var problems = components.filter(function (c) {
    return c.grade.severity === "warning" || c.grade.severity === "critical";
  }).length;

  var headerNote = problems > 0
    ? '<span class="' + pillClass + '">' + problems + " need" + (problems === 1 ? "s" : "") + " attention</span>"
    : '<span class="' + pillClass + '">' + _capacitySeverityLabel(severity) + "</span>";

  // The app states how old the lifecycle data is; refreshing it is the skill's
  // job (/polaris-tech-lifecycle). Without this line a stale "Current" verdict
  // looks authoritative.
  var staleNote = "";
  if (lifecycle.datasetReviewedAt) {
    var ageDays = Math.floor((Date.now() - Date.parse(lifecycle.datasetReviewedAt + "T00:00:00Z")) / 86400000);
    if (ageDays > 180) {
      staleNote = '<p class="hint" style="margin:0.4rem 0 0;color:var(--color-warning);font-size:0.78rem">' +
        "End-of-life dates were last reviewed " + escapeHtml(lifecycle.datasetReviewedAt) +
        " (" + ageDays + ' days ago). Refresh the dataset before trusting a "Current" verdict.</p>';
    }
  }

  var infoLine = (lifecycle.informational || []).map(function (i) {
    return escapeHtml(i.label) + " " + escapeHtml(i.version);
  }).join(" · ");

  return '<div class="settings-card severity-edge severity-edge-' + _capacitySeverityCssClass(severity) + '" id="platform-lifecycle-card">' +
    '<div class="capacity-header">' +
      '<h4 style="margin:0">Platform Lifecycle</h4>' +
      headerNote +
    "</div>" +
    staleNote +
    // Five columns do not fit at every viewport; scroll inside the container
    // rather than crushing the Component column (same fix as the advisor card).
    '<div style="overflow-x:auto;margin-top:0.75rem">' +
    '<table class="ip-table" style="width:100%;min-width:42rem">' +
      "<thead><tr>" +
        "<th>Component</th>" +
        '<th style="width:9rem">Polaris target</th>' +
        '<th style="width:8rem">Installed</th>' +
        '<th style="width:12rem">Supported until</th>' +
        '<th style="width:11rem">Status</th>' +
      "</tr></thead>" +
      "<tbody>" + sorted.map(_lifecycleRowHtml).join("") + "</tbody>" +
    "</table>" +
    "</div>" +
    (infoLine ? '<p class="hint" style="margin:0.6rem 0 0;font-size:0.78rem">' + infoLine + "</p>" : "") +
    '<p class="hint" style="margin:0.3rem 0 0;font-size:0.78rem">' +
      "Checked " + escapeHtml(formatLocalTime(lifecycle.computedAt)) +
      (lifecycle.datasetReviewedAt ? " · dates reviewed " + escapeHtml(lifecycle.datasetReviewedAt) : "") +
    "</p>" +
  "</div>";
}

// ─── Capacity alert hold (business rule 105) ───────────────────────────────
// The card grades capacity live, but the alert is recorded by the 10-minute
// capacityWatch job only once a change has held for the operator's hold. This
// row says what the alerting side last recorded and any change it is waiting
// out — so an alert beside a card that reads Healthy has an explanation on the
// same screen. The hold itself is set on the event trigger step of a capacity
// automation (Automations → the wizard); the card does not restate it.
// When every check passes, the status rides on the OK row as its second
// sentence (_capacityAllPassedHtml) instead of standing as a row of its own.

function _capacityAlertHoldStatus(t) {
  if (!t) return "";
  var status = "";
  if (t.pending) {
    var sinceMs = new Date(t.pending.since).getTime();
    var heldMin = Math.max(0, Math.round((Date.now() - sinceMs) / 60000));
    var dueIso = new Date(sinceMs + t.holdMinutes * 60000).toISOString();
    status = 'Waiting out a change to <strong>' + escapeHtml(_capacitySeverityLabel(t.pending.severity)) +
      '</strong>: seen for ' + heldMin + ' of ' + t.holdMinutes + ' min. It is recorded (and alerts) at the first check after ' +
      escapeHtml(formatLocalTime(dueIso)) + ' if every check until then still agrees; one check back at ' +
      escapeHtml(_capacitySeverityLabel(t.recorded ? t.recorded.severity : "ok")) + ' discards it.';
  } else if (t.recorded) {
    // recordedAt moves only when a change is recorded, so it reads "since".
    status = 'Alerting has recorded <strong>' + escapeHtml(_capacitySeverityLabel(t.recorded.severity)) +
      '</strong> since ' + escapeHtml(formatLocalTime(t.recorded.recordedAt)) + '.';
  }
  return status;
}

function renderCapacityAlertHoldHtml(t) {
  var status = _capacityAlertHoldStatus(t);
  if (!status) return "";
  return '<div class="capacity-alert-hold" style="margin:0.75rem 0;padding-top:0.75rem;border-top:1px solid var(--color-border)">' +
    '<p class="hint" id="capacity-alert-hold-status" style="margin:0">' + status + '</p>' +
  '</div>';
}

// The empty-reasons row: the live grade and the alerting side's state as one line.
function _capacityAllPassedHtml(computedAt, t) {
  var status = _capacityAlertHoldStatus(t);
  return '<div class="capacity-reasons">' +
    '<div class="capacity-reason capacity-reason-ok">' +
      '<div class="capacity-reason-head">' +
        '<span class="capacity-pill capacity-pill-ok capacity-pill-sm">OK</span>' +
        '<span class="capacity-reason-msg">All capacity checks passed' +
          (computedAt ? ' at ' + escapeHtml(formatLocalTime(computedAt)) : '') + '.' +
          (status ? ' <span id="capacity-alert-hold-status">' + status + '</span>' : '') +
        '</span>' +
      '</div>' +
    '</div>' +
  '</div>';
}

// The "Needs attention" strip above the Database card. Read from the severity
// edges already on the page rather than from the payloads, so every card that
// grades itself is covered without this knowing its rules — including one that
// grades after an async load (Scheduled Backups), which calls this again. Only
// amber and red count: watch is informational. Each entry scrolls to its card.
function renderCardAlertSummary(container) {
  var host = document.getElementById("maintenance-alert-summary");
  if (!host) return;
  var scope = container || document;
  var flagged = Array.prototype.slice.call(
    scope.querySelectorAll(".severity-edge.severity-edge-red, .severity-edge.severity-edge-amber"),
  ).filter(function (el) { return el.id; });
  if (flagged.length === 0) { host.innerHTML = ""; return; }

  var anyRed = false;
  var items = flagged.map(function (el) {
    var red = el.classList.contains("severity-edge-red");
    if (red) anyRed = true;
    var h = el.querySelector("h4");
    var title = h ? h.textContent.trim() : el.id;
    return '<button type="button" class="card-alert-summary-item" data-target="' + escapeHtml(el.id) + '">' +
      '<span class="capacity-pill capacity-pill-' + (red ? "red" : "amber") + ' capacity-pill-sm">' +
        (red ? "Critical" : "Warning") +
      '</span>' + escapeHtml(title) +
    '</button>';
  });
  host.innerHTML =
    '<div class="card-alert-summary severity-edge severity-edge-' + (anyRed ? "red" : "amber") + '">' +
      '<span class="card-alert-summary-label">Needs attention</span>' + items.join("") +
    '</div>';
  host.querySelectorAll(".card-alert-summary-item").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var target = document.getElementById(btn.getAttribute("data-target"));
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function renderCapacityCard(capacity, dbInfo, pgTuning, capacityTransition) {
  if (!capacity) {
    // Capacity grading unavailable (e.g. statfs not supported) — still render
    // the engine + pool stats under a plain Database header so operators
    // don't lose visibility into the database connection.
    var engineOnly = renderEnginePoolStatHtml(dbInfo, null);
    if (!engineOnly) return "";
    return '<div class="settings-card">' +
      '<h4>Database</h4>' +
      '<div class="capacity-grid">' + engineOnly + '</div>' +
    '</div>';
  }

  // Platform lifecycle reasons (EOL, below minimum, an open security advisory)
  // ride the capacity snapshot so they reach the sidebar alert, Events and
  // email — but on this tab they belong to the Platform Lifecycle card, which
  // lists them per component. Drop them here and grade the card on what is
  // left, so a Node advisory does not paint the Database card amber.
  var allReasons = capacity.reasons || [];
  var dbReasons = allReasons.filter(function (r) {
    return r.family !== "platform_lifecycle" && !/^platform_/.test(r.code || "");
  });
  var severity = capacity.severity || "ok";
  if (dbReasons.length !== allReasons.length) {
    var sevRank = { ok: 0, watch: 1, warning: 2, amber: 2, critical: 3, red: 3 };
    severity = dbReasons.reduce(function (worst, r) {
      return (sevRank[r.severity] || 0) > (sevRank[worst] || 0) ? r.severity : worst;
    }, "ok");
  }
  capacity = Object.assign({}, capacity, { reasons: dbReasons });
  // CSS class suffix stays on the color vocab (`red`/`amber`/`watch`/`ok`)
  // while the severity enum uses critical/warning. See _capacitySeverityCssClass.
  var severityCssClass = _capacitySeverityCssClass(severity);
  var pillClass = "capacity-pill capacity-pill-" + severityCssClass;

  // pg_tuning_needed used to inline a per-setting table here; that's now
  // rendered inside the Capacity Advisor card, which also covers max_connections
  // and worker-count recommendations alongside the PostgreSQL settings.

  // Reasons section — list each issue with severity + suggestion. When the
  // list is empty we still render a single subdued "all checks passed" row
  // so an operator sees evidence of work rather than a silent void.
  var reasonsHtml = "";
  var allPassed = !capacity.reasons || capacity.reasons.length === 0;
  if (allPassed) {
    reasonsHtml = _capacityAllPassedHtml(capacity.computedAt, capacityTransition);
  } else if (capacity.reasons && capacity.reasons.length > 0) {
    reasonsHtml =
      '<div class="capacity-reasons">' +
        capacity.reasons.map(function (r) {
          // Action buttons for reason codes that have a one-click apply.
          // The legacy pgboss_recommended / pgboss_overdue / pgboss_pending
          // codes were folded into the Capacity Advisor's QUEUE_MODE lever
          // — they no longer come back from the server.
          var action = "";
          if (r.code === "metrics_token_unset") {
            action = '<button class="btn btn-sm btn-primary capacity-action" data-action="generate-token" data-which="metrics" style="margin-top:0.5rem">Generate token</button>';
          } else if (r.code === "health_token_unset") {
            action = '<button class="btn btn-sm btn-primary capacity-action" data-action="generate-token" data-which="health" style="margin-top:0.5rem">Generate token</button>';
          }
          var rowPillLabel = (r.severity === "critical" || r.severity === "red") ? "Critical"
            : r.severity === "watch" ? "Watch"
            : "Warning";
          var cssClass = _capacitySeverityCssClass(r.severity);
          return '<div class="capacity-reason capacity-reason-' + cssClass + '">' +
            '<div class="capacity-reason-head">' +
              '<span class="capacity-pill capacity-pill-' + cssClass + ' capacity-pill-sm">' +
                rowPillLabel +
              '</span>' +
              '<span class="capacity-reason-msg">' + escapeHtml(r.message) + '</span>' +
            '</div>' +
            '<div class="capacity-reason-suggestion">' + escapeHtml(r.suggestion) + '</div>' +
            action +
          '</div>';
        }).join("") +
      '</div>';
  }

  var host = capacity.appHost || {};
  var db = capacity.database || {};
  var work = capacity.workload || {};

  var volumes = Array.isArray(host.volumes) ? host.volumes : [];
  var volumesHtml = volumes.length
    ? volumes.map(_capacityRenderVolume).join("")
    : '<p class="hint" style="margin:0">No volume statistics available — statfs may be unsupported on this host.</p>';

  var hostHtml =
    '<div class="capacity-stat-card">' +
      '<h5>Application host</h5>' +
      '<div class="db-info-grid">' +
        dbInfoRow("CPU cores", host.cpuCount != null ? host.cpuCount : "—") +
        dbInfoRow("RAM (total)", _capacityFormatBytes(host.totalMemoryBytes)) +
        dbInfoRow("RAM (available)", _capacityFormatBytes(host.freeMemoryBytes)) +
        (host.loadAvg ? dbInfoRow("Load avg (1/5/15m)", host.loadAvg.map(function (n) { return n.toFixed(2); }).join(" / ")) : "") +
        dbInfoRow("DB co-located", host.dbColocated ? "Yes" : "No (remote)") +
      '</div>' +
      '<h5 style="margin-top:0.85rem">Storage volumes</h5>' +
      '<div style="margin-top:0.4rem">' + volumesHtml + '</div>' +
      (host.dbColocated
        ? ''
        : '<p class="hint" style="margin-top:0.5rem">PostgreSQL is on a separate host — its data volume is not visible here.</p>') +
    '</div>';

  var allTables = (dbInfo && dbInfo.tables) || [];
  var tablesHtml = allTables.map(function (t) {
    return '<tr>' +
      '<td class="mono" style="font-size:0.78rem">' + escapeHtml(t.name) + '</td>' +
      '<td style="text-align:right">' + formatNumber(t.rows) + '</td>' +
      '<td style="text-align:right;font-size:0.82rem;color:var(--color-text-secondary)">' + escapeHtml(t.size) + '</td>' +
      '</tr>';
  }).join("");

  // The rest of "Current size": bytes that are really on disk but are not one of
  // Polaris's tables, so they can never appear as a row above. Listing them is
  // the whole point — the card used to print a whole-database total over a
  // public-schema-only list and leave the difference unexplained (on prod,
  // 76.6 GB over a list summing to 2.6 GB).
  var acct = (dbInfo && dbInfo.sizeAccounting) || null;
  var unlisted = acct && acct.unlisted ? acct.unlisted : null;
  if (unlisted) {
    tablesHtml +=
      _capacityUnlistedRow("pg-boss job queue", unlisted.pgbossBytes,
        "The monitor work queue's own schema. Real bytes on the same disk, but not a Polaris table.") +
      _capacityUnlistedRow("PostgreSQL catalog", unlisted.catalogBytes,
        "pg_catalog + information_schema — PostgreSQL's own bookkeeping.") +
      _capacityUnlistedRow("Other schemas", unlisted.otherBytes,
        "Anything outside public, pgboss and the system catalogs, including TimescaleDB's own catalog.") +
      _capacityUnlistedRow("Unattributed", unlisted.unattributedBytes,
        "Polaris-owned bytes the table list could not attribute to a table. Expected to be zero — " +
        "anything here means the hypertable rows above are understated.");
    if (dbInfo && dbInfo.sizeBytes != null) {
      tablesHtml +=
        '<tr style="border-top:1px solid var(--color-border)">' +
          '<td style="font-size:0.78rem;font-weight:600">Total</td>' +
          '<td></td>' +
          '<td style="text-align:right;font-size:0.82rem;font-weight:600">' +
            escapeHtml(_capacityFormatBytes(dbInfo.sizeBytes)) +
          '</td>' +
        '</tr>';
    }
  }

  // Two ways these figures can be wrong rather than merely unexplained, both
  // previously invisible: the chunk fold failing (every hypertable then reads
  // ~0, indistinguishable from empty) and a catalog that has never been
  // ANALYZEd (relpages 0 regardless of content — the state a pg_upgrade leaves
  // behind until vacuumdb runs).
  // Business rule 71: a degraded measurement degrades VISIBLY.
  var sizingWarnings = "";
  var sizingFootnote = "";
  if (acct && acct.sizing === "parent-only") {
    sizingWarnings +=
      '<p class="hint" style="margin-top:0.5rem;color:var(--color-warning,#f59e0b)">' +
      'Hypertable sizing is degraded — the TimescaleDB chunk catalog could not be read, so every sample ' +
      'table is listed at its parent size (near zero) and their real bytes appear under Unattributed. ' +
      'Check the server log for <span class="mono">dbSize.chunk_aware_sizing_failed</span>.' +
      '</p>';
  }
  // Weighed by the bytes they hide, not the count: every TimescaleDB chunk
  // compression leaves a small un-analyzed relation behind, so a count alone
  // warned permanently on a healthy install. Material = over 64 MB or 1% of
  // the database; below that it is a plain hint, not a warning.
  if (acct && acct.neverAnalyzedRelations > 0) {
    var naCount = escapeHtml(formatNumber(acct.neverAnalyzedRelations));
    var naMissing = acct.neverAnalyzedMissingBytes;
    var naTotal = (dbInfo && dbInfo.sizeBytes) || 0;
    var naMaterial = naMissing == null || naMissing > Math.max(64 * 1024 * 1024, naTotal * 0.01);
    var naFix =
      'Autovacuum only analyzes a relation after enough writes, so one nothing writes to stays this way ' +
      'until <span class="mono">vacuumdb --analyze-only</span> runs against the database.';
    if (naMissing == null) {
      sizingWarnings +=
        '<p class="hint" style="margin-top:0.5rem;color:var(--color-warning,#f59e0b)">' +
        naCount + ' relations have never been vacuumed or analyzed — too many to size individually — so ' +
        'every size on this card may be substantially understated. This is expected right after a restore ' +
        'or a PostgreSQL major-version upgrade. ' + naFix +
        '</p>';
    } else if (naMaterial) {
      sizingWarnings +=
        '<p class="hint" style="margin-top:0.5rem;color:var(--color-warning,#f59e0b)">' +
        naCount + ' relation(s) that have never been analyzed hold about ' +
        escapeHtml(_capacityFormatBytes(naMissing)) + ' that no size on this card includes. ' + naFix +
        '</p>';
    } else {
      // Immaterial: a footnote at the foot of the table scroll, not a card-level hint.
      sizingFootnote =
        '<p class="hint" style="margin:0.4rem 0 0;font-size:0.7rem">' +
        naCount + ' small relation(s), about ' + escapeHtml(_capacityFormatBytes(naMissing)) +
        ', are not yet analyzed and are left out of the sizes above — normal for recently compressed ' +
        'TimescaleDB chunks, and too small to matter.' +
        '</p>';
    }
  }

  // TimescaleDB three-state: not installed / installed but no hypertables / enabled
  var ts = db.timescale || {};
  var tsLabel = "Not installed";
  if (ts.extensionInstalled) {
    var htCount = Array.isArray(ts.hypertableTables) ? ts.hypertableTables.length : 0;
    tsLabel = htCount > 0 ? ("Enabled (" + htCount + " hypertable" + (htCount === 1 ? "" : "s") + ")") : "Installed, not enabled";
  }

  // Monitor queue: three-state shape mirroring TimescaleDB. When
  // `persisted` differs from `active`, the operator has clicked the
  // [Enable on next restart] button and a restart is pending — append a
  // bold "Pending: <mode> on next restart" hint so it's not invisible.
  var q = db.queue || {};
  var queueLabel;
  if (!q.pgbossInstalled) {
    queueLabel = "Cursor (pg-boss not installed)";
  } else if (q.active === "pgboss") {
    queueLabel = "pg-boss (active)";
  } else {
    queueLabel = "Cursor (pg-boss installed, not active)";
  }
  if (q.persisted && q.active && q.persisted !== q.active) {
    queueLabel += ' <strong style="color:var(--color-warning,#f59e0b)">— Pending: ' +
      escapeHtml(q.persisted) + ' on next restart</strong>';
  }

  var dbHtml =
    '<div class="capacity-stat-card">' +
      '<h5>Database</h5>' +
      '<div class="db-info-grid">' +
        dbInfoRow(
          "Current size",
          _capacityFormatBytes(db.sizeBytes),
          "Every relation in the database: Polaris's tables with their indexes, TOAST and TimescaleDB " +
          "chunks, plus the pg-boss queue schema and PostgreSQL's own catalog. The table list below " +
          "accounts for all of it. Read from the catalog (pg_class.relpages) rather than by measuring " +
          "the data directory, so it is accurate as of the last ANALYZE.",
        ) +
        dbInfoRow(
          "Steady-state at current settings",
          _capacityFormatBytes(work.steadyStateSizeBytes),
          "Steady-state size is what the database grows to if monitoring settings stay as " +
          "they are. Reduce retention or cadence to lower it.\n\nLegitimately larger than " +
          "the current size while sample tables are still filling. Retention is reclaimed a " +
          "whole TimescaleDB chunk at a time, so tables grow and drop in a weekly cycle; this is " +
          "the largest total they reach together, not each table's own peak added up.",
        ) +
        (allTables.length ? dbInfoRow("Tables", allTables.length) : "") +
        dbInfoRow("TimescaleDB", tsLabel) +
        dbInfoRow("Monitor queue", queueLabel) +
      '</div>' +
      (tablesHtml
        ? '<div style="margin-top:0.75rem;max-height:240px;overflow-y:auto">' +
            '<table class="ip-table"><thead><tr>' +
              '<th>Table</th>' +
              '<th style="text-align:right">Rows</th>' +
              '<th style="text-align:right">Size</th>' +
            '</tr></thead><tbody>' + tablesHtml + '</tbody></table>' +
            sizingFootnote +
          '</div>'
        : sizingFootnote) +
      sizingWarnings +
    '</div>';

  var workHtml =
    '<div class="capacity-stat-card">' +
      '<h5>Monitoring workload</h5>' +
      '<div class="db-info-grid">' +
        dbInfoRow("Assets", formatNumber(work.monitoredAssetCount || 0)) +
        dbInfoRow("Interfaces", formatNumber(work.monitoredInterfaceCount || 0)) +
        dbInfoRow("Storage mounts", formatNumber(work.monitoredStorageCount || 0)) +
        dbInfoRow("Agents", formatNumber(work.agentCount || 0)) +
        (work.cadences
          // Fleet averages (monitoringService.fleetCadences: the harmonic,
          // rate-weighted mean of every monitored asset's resolved interval),
          // so mixed cadences give a fraction and even a uniform fleet carries
          // float noise (60.000000000000014) — fleetCadences now rounds them to
          // whole seconds at the source; the card formats what it is given.
          ? dbInfoRow("Cadences",
              _fmtCadenceSec(work.cadences.responseTimeSec) + " response · " +
              _fmtCadenceSec(work.cadences.telemetrySec) + " telemetry · " +
              _fmtCadenceSec(work.cadences.systemInfoSec) + " system info",
              "Fleet averages: each stream's polling interval averaged across every monitored asset, weighted by how often each one polls.")
          : "") +
        (work.retention
          ? dbInfoRow("Retention",
              work.retention.monitorDays + "d monitor · " +
              work.retention.telemetryDays + "d telemetry · " +
              work.retention.systemInfoDays + "d system info")
          : "") +
      '</div>' +
    '</div>';

  var enginePoolHtml = renderEnginePoolStatHtml(dbInfo, capacity);

  return '<div class="settings-card capacity-card severity-edge severity-edge-' + severityCssClass + '" id="capacity-card">' +
    '<div class="capacity-header">' +
      '<h4 style="margin:0">Database</h4>' +
      '<span class="' + pillClass + '">' + _capacitySeverityLabel(severity) + '</span>' +
    '</div>' +
    reasonsHtml +
    (allPassed ? "" : renderCapacityAlertHoldHtml(capacityTransition)) +
    '<div class="capacity-grid">' + hostHtml + dbHtml + enginePoolHtml + workHtml + '</div>' +
    '<p class="hint" style="margin-top:0.75rem;font-size:0.78rem">Last computed ' + escapeHtml(formatLocalTime(capacity.computedAt)) + '</p>' +
  '</div>';
}

// ─── Sample Retention card (Maintenance tab) ───────────────────────────────
//
// Edit the global Setting("sampleRetention") shape. One card with a compact
// 3-stream × 3-tier × 3-class grid (27 inputs total). Values are days; 0
// disables retention for that cell ("keep forever").
//
// Layout per stream: a small header row with the three class columns
// (Default / Switches / Access points) followed by three rows for the
// three tiers (Detail / Hourly / Daily). Stream sections stack vertically.
// Inputs are tight (3.5rem) so the whole card fits in a single screen.

// Per-ENTITY retention. Rows = entities, columns = tiers (detail/hourly/daily).
// Encoding per cell: N = keep N days; 0 = drop this tier; -1 = keep forever.
// The three selection-aware entities (interfaces/storage/ipsec) apply their
// configured retention to OPERATOR-SELECTED (monitored) rows only — unselected
// bulk rows are kept a fixed 24h and never rolled up (chosen per-asset in the
// interface/storage/IPsec slide-ins).
var SAMPLE_RETENTION_ENTITIES = [
  { key: "assets",      label: "Response time",  hint: "Per-asset response-time probe (asset_monitor_samples)." },
  { key: "cpuMem",      label: "CPU & memory",   hint: "Per-asset CPU / memory telemetry." },
  { key: "hardware",    label: "Hardware sensors", hint: "Per-asset hardware sensors (temperature / fan / voltage / power / disk)." },
  { key: "interfaces",  label: "Interfaces",     hint: "Per-interface counters.", selectionAware: true },
  { key: "storage",     label: "Storage",        hint: "Per-volume usage.",       selectionAware: true },
  { key: "ipsec",       label: "IPsec tunnels",  hint: "Per-tunnel state.",       selectionAware: true },
  { key: "perfSla",     label: "SD-WAN Perf SLA", hint: "Per health-check member latency / jitter / loss." },
  { key: "pathCheck", label: "Path checks", hint: "Per agent host × check: latency, phases, HTTP status and pass/fail." },
  { key: "process",     label: "Processes & services", hint: "Pinned-program CPU/RAM plus process + service log lines." },
];
// FLAT entities: one window instead of detail/hourly/daily, for tables that are
// current-state-with-age rather than tiered time-series. Same −1/0/N encoding.
var SAMPLE_RETENTION_FLAT_ENTITIES = [
  {
    key: "appMapConnections",
    label: "Application Map connections",
    hint: "Observed listening ports + peers for mapped processes/services. Rows accumulate " +
          "(one per distinct socket) and age out on this window; capped at 200 listening / " +
          "500 outbound / 200 inbound per program per host. Also sets how far back the " +
          "Application Map's “Seen within” filter can reach.",
    def: 30,
  },
  {
    key: "arpEntries",
    label: "ARP / neighbour cache",
    hint: "IP→MAC bindings read from each FortiGate. Rows accumulate (one per distinct " +
          "binding, not one per poll) and age out on this window; capped at 4000 per device. " +
          "Also sets how far back the ARP Table tab’s range selector can reach.",
    def: 30,
  },
  {
    key: "pathCheckTraceroutes",
    label: "Path traceroutes",
    hint: "Hop-by-hop paths the Polaris Agent traced for path checks (every Nth run " +
          "and on each pass→fail and recovery). Sets how far back the Paths tab’s path history reaches.",
    def: 30,
  },
];
var SAMPLE_RETENTION_TIERS   = [
  { key: "detail", label: "Detail"      },
  { key: "hourly", label: "Hourly avg"  },
  { key: "daily",  label: "Daily avg"   },
];
var SAMPLE_RETENTION_DEFAULTS = {
  detail: 7,
  hourly: 30,
  daily:  365,
};

function _retentionInputHtml(entity, tier, value) {
  var id = "ret-" + entity + "-" + tier;
  var safeValue = (typeof value === "number" && Number.isFinite(value)) ? value : 0;
  return '<input type="number" min="-1" max="3650" step="1" id="' + id + '" data-entity="' + escapeHtml(entity) +
    '" data-tier="' + escapeHtml(tier) +
    '" value="' + safeValue + '" style="width:4rem;text-align:center;padding:2px 4px;font-size:0.85rem">';
}

function renderSampleRetentionCard(retention) {
  // Fall through to defaults if the snapshot fetch failed; operator can
  // still edit and Save to seed the Setting on first use.
  var r = retention || {};
  var defTier = { detail: 7, hourly: 30, daily: 365 };

  var rows = "";
  var hasSelectionAware = false;
  SAMPLE_RETENTION_ENTITIES.forEach(function (entity) {
    var entRet = r[entity.key] || defTier;
    if (entity.selectionAware) hasSelectionAware = true;
    var cells = SAMPLE_RETENTION_TIERS.map(function (tier) {
      return '<td style="padding:3px 6px;text-align:center">' +
        _retentionInputHtml(entity.key, tier.key, entRet[tier.key]) +
      '</td>';
    }).join("");
    var label = escapeHtml(entity.label) + (entity.selectionAware ? ' <span style="color:var(--color-text-tertiary)">*</span>' : "");
    rows +=
      '<tr>' +
        '<td style="padding:4px 10px 4px 0;font-size:0.85rem;white-space:nowrap">' + label +
          '<div style="font-size:0.72rem;color:var(--color-text-tertiary)">' + escapeHtml(entity.hint) + '</div>' +
        '</td>' +
        cells +
        '<td style="padding:3px 0 3px 6px;font-size:0.78rem;color:var(--color-text-tertiary)">days</td>' +
      '</tr>';
  });

  var headerCells = SAMPLE_RETENTION_TIERS.map(function (tier) {
    return '<th style="padding:3px 6px;text-align:center;font-size:0.74rem;color:var(--color-text-secondary);font-weight:600;text-transform:uppercase;letter-spacing:0.04em">' +
      escapeHtml(tier.label) +
    '</th>';
  }).join("");

  var footnote = hasSelectionAware
    ? '<p class="hint" style="margin-top:0.5rem;font-size:0.76rem">* Applies to <strong>selected (monitored)</strong> interfaces / storage / IPsec tunnels only — unselected ones are kept 24&nbsp;h and not rolled up. Choose which to keep from each asset\'s interface / storage / IPsec slide-in.</p>'
    : "";

  // Flat entities render as their own single-input rows: they have one window,
  // so putting them in the tier table would leave two thirds of it meaningless.
  var flatRows = SAMPLE_RETENTION_FLAT_ENTITIES.map(function (entity) {
    var cur = r[entity.key] && typeof r[entity.key].days === "number" ? r[entity.key].days : entity.def;
    return '<tr>' +
      '<td style="padding:4px 10px 4px 0;font-size:0.85rem">' + escapeHtml(entity.label) +
        '<div style="font-size:0.72rem;color:var(--color-text-tertiary);max-width:34rem">' + escapeHtml(entity.hint) + '</div>' +
      '</td>' +
      '<td style="padding:3px 6px;text-align:center;vertical-align:top">' +
        '<input type="number" min="-1" max="3650" step="1" id="ret-flat-' + escapeHtml(entity.key) + '"' +
        ' data-flat-entity="' + escapeHtml(entity.key) + '"' +
        ' value="' + cur + '" style="width:4rem;text-align:center;padding:2px 4px;font-size:0.85rem">' +
      '</td>' +
      '<td style="padding:3px 0 3px 6px;font-size:0.78rem;color:var(--color-text-tertiary);vertical-align:top">days</td>' +
    '</tr>';
  }).join("");
  var flatSection = flatRows
    ? '<h5 style="margin:1.1rem 0 0.35rem;font-size:0.8rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--color-text-secondary)">Single-window data</h5>' +
      '<table style="border-collapse:collapse"><tbody>' + flatRows + '</tbody></table>'
    : "";

  return '<div class="settings-card" id="sample-retention-card">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">' +
      '<h4 style="margin:0">Sample Retention</h4>' +
      '<div style="display:flex;gap:6px">' +
        '<button class="btn btn-secondary btn-sm" id="btn-sample-retention-defaults">Restore defaults</button>' +
        '<button class="btn btn-primary"   id="btn-sample-retention-save">Save</button>' +
      '</div>' +
    '</div>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.85rem">' +
      'How long Polaris keeps each kind of sample data. Older samples roll up into hourly buckets, then daily buckets, then drop. Per cell: <strong>N</strong> = keep N days, <strong>0</strong> = drop that tier, <strong>−1</strong> = keep forever.' +
    '</p>' +
    '<table style="border-collapse:collapse">' +
      '<thead><tr>' +
        '<th></th>' +
        headerCells +
        '<th></th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
    '</table>' +
    footnote +
    flatSection +
    '<p class="hint" style="margin-top:0.5rem;font-size:0.78rem">Defaults: 7 days detail / 30 days hourly / 365 days daily. Takes effect on the next nightly prune (heavy-loop tick) and on the next chart request.</p>' +
  '</div>';
}

function _wireSampleRetentionCard() {
  var card = document.getElementById("sample-retention-card");
  if (!card) return;
  var saveBtn = document.getElementById("btn-sample-retention-save");
  var defBtn  = document.getElementById("btn-sample-retention-defaults");
  if (defBtn) {
    defBtn.addEventListener("click", function () {
      // Restore the default values into the inputs without saving. The
      // operator clicks Save to actually persist.
      SAMPLE_RETENTION_ENTITIES.forEach(function (entity) {
        SAMPLE_RETENTION_TIERS.forEach(function (tier) {
          var el = document.getElementById("ret-" + entity.key + "-" + tier.key);
          if (el) el.value = String(SAMPLE_RETENTION_DEFAULTS[tier.key]);
        });
      });
      SAMPLE_RETENTION_FLAT_ENTITIES.forEach(function (entity) {
        var el = document.getElementById("ret-flat-" + entity.key);
        if (el) el.value = String(entity.def);
      });
    });
  }
  if (saveBtn) {
    saveBtn.addEventListener("click", async function () {
      var payload = {};
      var hasError = false;
      SAMPLE_RETENTION_ENTITIES.forEach(function (entity) {
        payload[entity.key] = {};
        SAMPLE_RETENTION_TIERS.forEach(function (tier) {
          var el = document.getElementById("ret-" + entity.key + "-" + tier.key);
          if (!el) return;
          var n = parseInt(el.value, 10);
          // -1 = keep forever, 0 = drop tier, 1..3650 = days.
          if (!Number.isFinite(n) || n < -1 || n > 3650) {
            hasError = true;
            el.style.borderColor = "var(--color-status-error, #e57373)";
            return;
          }
          el.style.borderColor = "";
          payload[entity.key][tier.key] = n;
        });
      });
      SAMPLE_RETENTION_FLAT_ENTITIES.forEach(function (entity) {
        var el = document.getElementById("ret-flat-" + entity.key);
        if (!el) return;
        var n = parseInt(el.value, 10);
        if (!Number.isFinite(n) || n < -1 || n > 3650) {
          hasError = true;
          el.style.borderColor = "var(--color-status-error, #e57373)";
          return;
        }
        el.style.borderColor = "";
        payload[entity.key] = { days: n };
      });
      if (hasError) {
        showToast("Retention values must be −1 (forever), 0 (off), or 1–3650 days", "error");
        return;
      }
      saveBtn.disabled = true;
      try {
        await api.serverSettings.setSampleRetention(payload);
        showToast("Sample retention saved", "success");
        _showRetentionPruneInfoModal();
      } catch (err) {
        showToast("Save failed: " + (err && err.message ? err.message : String(err)), "error");
      } finally {
        saveBtn.disabled = false;
      }
    });
  }
}

// Post-save explainer: retention changes are applied by the retention prune
// pass, which runs on a 24h cadence (RETENTION_PRUNE_INTERVAL_MS server-side)
// — the save itself deletes nothing. Sets expectations for when the operator
// will actually see database size move.
function _showRetentionPruneInfoModal() {
  var p = 'style="font-size:0.9rem;color:var(--color-text-secondary);margin:0 0 0.75rem"';
  var body =
    '<p ' + p + '>Retention changes are applied by the <strong>retention prune pass</strong>, ' +
      'which runs once every 24 hours — not at save time. The next pass fires when 24 hours ' +
      'have elapsed since the previous one, so the new limits take effect ' +
      '<strong>within the next 24 hours</strong>.</p>' +
    '<p ' + p + '>When it runs, sample history is stored in one-day chunks and every chunk ' +
      'entirely older than the new cutoff is dropped whole — that is what returns disk space ' +
      'to the operating system, compressed history included. Expect a step down in database ' +
      'size at that point, then a one-day trim on each pass after.</p>' +
    '<p ' + p + '>Two caveats: the chunk straddling a cutoff is kept until it fully ages past it ' +
      '(up to one extra day of data per tier), and rows removed by row-level deletes free space ' +
      'for reuse inside PostgreSQL rather than shrinking files on disk.</p>' +
    '<p style="font-size:0.85rem;color:var(--color-text-tertiary);margin:0">You can confirm the ' +
      'prune ran on the Maintenance tab — the Database card’s volume bars and steady-state ' +
      'size reflect the new retention after the next pass.</p>';
  var footer = '<button class="btn btn-primary" onclick="closeModal()">Got it</button>';
  openModal("When will the database shrink?", body, footer);
}

async function loadDatabaseInfo() {
  var container = document.getElementById("tab-maintenance");
  container.innerHTML = '<div class="settings-card"><p class="empty-state">Loading maintenance information...</p></div>';

  try {
    // Fetch capacity advisor in parallel with the database snapshot — if the
    // advisor fails (e.g. statfs not available) we still render the rest of
    // the tab. Also pull the NTP timezone override so capacity timestamps
    // render in server time; failures fall through to browser-local.
    var results = await Promise.allSettled([
      api.serverSettings.getDatabase(),
      api.serverSettings.getCapacityAdvisor(),
      loadTzOverride(),
      api.serverSettings.getPlatformLifecycle(),
    ]);
    if (results[0].status === "rejected") throw results[0].reason;
    var db = results[0].value;
    var lifecycle = results[3] && results[3].status === "fulfilled" ? results[3].value : null;
    var advisorResp = results[1].status === "fulfilled" && results[1].value
      ? results[1].value
      : null;
    var advisor = advisorResp && advisorResp.advisor ? advisorResp.advisor : null;
    var capacity = advisorResp && advisorResp.capacity ? advisorResp.capacity : null;
    var pgTuning = advisorResp && advisorResp.pgTuning ? advisorResp.pgTuning : null;
    var capacityTransition = advisorResp && advisorResp.capacityTransition ? advisorResp.capacityTransition : null;
    var dbConnectionMode = advisorResp && advisorResp.dbConnectionMode ? advisorResp.dbConnectionMode : "direct";
    _advisorInContainer = !!(advisorResp && advisorResp.runtimeIsContainer);
    _dbLoaded = true;

    var advisorHtml = renderCapacityAdvisorCard(advisor, pgTuning && pgTuning.pgConfigFile, dbConnectionMode);
    var lifecycleHtml = renderPlatformLifecycleCard(lifecycle);

    // ── Application Updates card ──
    var updateCardHtml =
      '<div class="settings-card" id="update-card">' +
        '<h4>Application Updates</h4>' +
        '<p id="update-card-intro" style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
          'Check for new versions and apply updates directly from the browser. Automatic rollback on failure.' +
        '</p>' +
        '<div id="update-status-area">' +
          '<div class="db-info-grid" style="margin-bottom:1rem">' +
            '<div class="db-info-label">Current Version</div>' +
            '<div class="db-info-value" id="update-current-version">v' + escapeHtml(_branding && _branding.version ? _branding.version : '?') + '</div>' +
          '</div>' +
          '<div style="display:flex;gap:8px;align-items:center">' +
            '<button class="btn btn-secondary" id="btn-check-updates">Check for Updates</button>' +
            '<span id="update-check-status" style="font-size:0.82rem"></span>' +
          '</div>' +
        '</div>' +
        // Update source — which git repo updates are pulled from, and whether
        // that comes from POLARIS_UPDATE_REPO (.env) or the install's origin.
        // Lives outside #update-status-area so it survives status re-renders.
        '<div id="update-repo-info" style="margin-top:0.75rem;font-size:0.8rem;color:var(--color-text-tertiary)"></div>' +
        // Update train — nightly (every commit) vs release (tagged releases only).
        // The train, backup and history sections are the git updater's; a
        // container install removes them (_applyImageUpdateLayout).
        '<div id="update-train-section" style="margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid var(--color-border)">' +
          '<label for="update-train-select" style="display:block;font-size:0.85rem;font-weight:600;margin-bottom:0.35rem">Update train</label>' +
          '<select id="update-train-select" style="max-width:280px">' +
            '<option value="nightly">Nightly — latest commits</option>' +
            '<option value="release">Release — stable releases only</option>' +
          '</select>' +
          '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.3rem 0 0">' +
            'Nightly tracks every change on the update branch. Release only downloads published, tagged releases.' +
          '</p>' +
        '</div>' +
        '<div id="update-backup-section" style="margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid var(--color-border)">' +
          '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none">' +
            '<input type="checkbox" id="update-backup-checkbox" style="width:15px;height:15px;flex-shrink:0">' +
            '<span style="font-size:0.85rem">Back up database before applying updates</span>' +
          '</label>' +
          '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.3rem 0 0 23px">Disable to skip the backup step. The migration step of an update cannot be rolled back, so with this off a failed update has <strong>no recovery point</strong> — the in-app updater does not roll back, and the fallback script restores the database only from this backup. If you turned this off because backups were failing, the Backups card below now says why. Not recommended for production systems.</p>' +
        '</div>' +
        '<details id="update-history" style="margin-top:1rem">' +
          '<summary style="cursor:pointer;font-size:0.82rem;color:var(--color-text-secondary);user-select:none">Recent updates</summary>' +
          '<div id="update-history-body" style="margin-top:0.6rem;font-size:0.82rem;color:var(--color-text-tertiary)">Loading...</div>' +
        '</details>' +
      '</div>';

    container.innerHTML =
      // Filled by renderCardAlertSummary once the cards below are in the DOM.
      '<div id="maintenance-alert-summary"></div>' +
      // Database first — the volume bars and capacity severity are what an
      // operator opens this tab to see. Capacity Advisor and Application
      // Updates then share one row as half-width cards; the advisor renders
      // nothing when it has no recommendations, in which case Updates keeps
      // the full width rather than leaving half a row empty.
      renderCapacityCard(capacity, db, pgTuning, capacityTransition) +
      (advisorHtml
        ? '<div class="settings-cards-row">' + advisorHtml + updateCardHtml + '</div>'
        : updateCardHtml) +
      // Platform Lifecycle sits with the "what is this server and does it need
      // work" group (Database → Advisor → Updates → Lifecycle) and above the
      // operational-task group below. Full width of its own on purpose: it
      // wants six columns, and pairing it with Updates would recreate the
      // column crush the advisor card already had to solve.
      lifecycleHtml +
      // ── Polaris Agent card ──
      // ── Backup / Restore / History / Scheduled — four columns ──
      '<div class="settings-cards-row-4">' +

      // ── Backup Card ──
      '<div class="settings-card">' +
        '<h4>Backup</h4>' +
        '<p class="hint" style="margin-bottom:0.75rem">Create a compressed backup of the database. Optionally encrypt with a password for secure storage or transfer.</p>' +
        '<div class="form-row" style="align-items:flex-end;gap:12px;flex-wrap:wrap">' +
          '<div style="flex:1;min-width:200px">' +
            '<label for="backup-password">Encryption password <span style="color:var(--color-text-tertiary)">(optional)</span></label>' +
            '<input type="password" id="backup-password" placeholder="Leave blank for unencrypted backup" autocomplete="new-password">' +
          '</div>' +
          '<div style="flex:1;min-width:200px">' +
            '<label for="backup-password-confirm">Confirm password</label>' +
            '<input type="password" id="backup-password-confirm" placeholder="Re-enter password" autocomplete="new-password">' +
          '</div>' +
          '<div>' +
            '<button class="btn btn-primary" id="btn-backup" style="white-space:nowrap">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="vertical-align:-2px;margin-right:4px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
              'Create Backup</button>' +
          '</div>' +
        '</div>' +
        '<div id="backup-status" style="margin-top:0.5rem"></div>' +
      '</div>' +

      // ── Restore Card ──
      '<div class="settings-card">' +
        '<h4>Restore</h4>' +
        '<p class="hint" style="margin-bottom:0.75rem">Restore the database from a previously created backup file. This will replace all current data.</p>' +
        '<div class="restore-drop-zone" id="restore-drop-zone">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32" style="opacity:0.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
          '<p>Drag and drop a backup file here, or <label for="restore-file-input" class="link-text" style="cursor:pointer">browse</label></p>' +
          '<p class="hint">Accepts .gz or .enc.gz files</p>' +
          '<input type="file" id="restore-file-input" accept=".gz" style="display:none">' +
        '</div>' +
        '<div id="restore-file-info" style="display:none;margin-top:0.75rem">' +
          '<div class="db-info-grid" style="margin-bottom:0.75rem">' +
            '<div class="db-info-label">File</div><div class="db-info-value" id="restore-filename">-</div>' +
            '<div class="db-info-label">Size</div><div class="db-info-value" id="restore-filesize">-</div>' +
            '<div class="db-info-label">Backup version</div><div class="db-info-value" id="restore-version">-</div>' +
            '<div class="db-info-label">Encrypted</div><div class="db-info-value" id="restore-encrypted">-</div>' +
          '</div>' +
          '<div id="restore-version-warning" style="display:none;margin-bottom:0.75rem;padding:0.6rem 0.75rem;border-radius:6px;background:color-mix(in srgb, var(--color-warning) 12%, transparent);border:1px solid color-mix(in srgb, var(--color-warning) 30%, transparent);font-size:0.82rem;color:var(--color-text-primary)">' +
            '<strong style="color:var(--color-warning)">Version mismatch</strong> — ' +
            'This backup was created with a different version of Polaris. ' +
            'Restoring a backup from a different version may fail or cause issues if the database schema has changed. ' +
            'For best results, ensure the application version matches the backup version before restoring.' +
          '</div>' +
          '<div id="restore-password-row" style="display:none;margin-bottom:0.75rem">' +
            '<label for="restore-password">Decryption password</label>' +
            '<input type="password" id="restore-password" placeholder="Enter the password used during backup" autocomplete="off">' +
          '</div>' +
          '<div style="display:flex;gap:8px">' +
            '<button class="btn btn-danger" id="btn-restore">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="vertical-align:-2px;margin-right:4px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
              'Restore Database</button>' +
            '<button class="btn btn-secondary" id="btn-restore-cancel">Cancel</button>' +
          '</div>' +
        '</div>' +
        '<div id="restore-status" style="margin-top:0.5rem"></div>' +
      '</div>' +

      // ── Backup History Card ──
      '<div class="settings-card">' +
        '<h4>Backup History</h4>' +
        '<div id="backup-history-body"><p class="empty-state">Loading...</p></div>' +
      '</div>' +

      // ── Scheduled Backups card ──
      // Manual backup alone means "someone remembers to click the button".
      // This is the standing recovery point; default off so it never competes
      // with an enterprise backup product already covering this Postgres.
      // The edge goes red when the last run failed (loadBackupSchedule).
      '<div class="settings-card severity-edge severity-edge-ok" id="bksched-card">' +
        '<h4>Scheduled Backups</h4>' +
        '<p class="hint" style="margin-bottom:0.75rem">Take a backup automatically on a fixed cadence. Off by default — leave it off if an enterprise backup product already covers this PostgreSQL instance. Copies land in <code>data/backups/</code> on this host; set an off-host directory so losing the host does not lose every backup with it.</p>' +
        '<label style="display:flex;align-items:center;gap:8px;margin-bottom:0.75rem">' +
          '<input type="checkbox" id="bksched-enabled">' +
          '<span>Enable scheduled backups</span>' +
        '</label>' +
        '<div id="bksched-fields" class="form-row" style="align-items:flex-end;gap:12px;flex-wrap:wrap">' +
          '<div style="min-width:130px">' +
            '<label for="bksched-interval">Every (hours)</label>' +
            '<input type="number" id="bksched-interval" min="1" max="168" step="1">' +
          '</div>' +
          '<div style="min-width:150px">' +
            '<label for="bksched-hour">At UTC hour <span style="color:var(--color-text-tertiary)">(optional)</span></label>' +
            '<input type="number" id="bksched-hour" min="0" max="23" step="1" placeholder="any">' +
          '</div>' +
          '<div style="min-width:130px">' +
            '<label for="bksched-retain">Keep last</label>' +
            '<input type="number" id="bksched-retain" min="1" max="50" step="1">' +
          '</div>' +
          '<div style="flex:1;min-width:200px">' +
            '<label for="bksched-passphrase">Encryption passphrase <span style="color:var(--color-text-tertiary)">(optional)</span></label>' +
            '<input type="password" id="bksched-passphrase" placeholder="Leave blank for unencrypted" autocomplete="new-password">' +
          '</div>' +
          '<div style="flex:1;min-width:220px">' +
            '<label for="bksched-copyto">Off-host copy directory <span style="color:var(--color-text-tertiary)">(optional)</span></label>' +
            '<input type="text" id="bksched-copyto" placeholder="/mnt/backups/polaris">' +
          '</div>' +
          '<div>' +
            '<button class="btn btn-primary" id="btn-bksched-save" style="white-space:nowrap">Save Schedule</button>' +
          '</div>' +
        '</div>' +
        '<div id="bksched-status" style="margin-top:0.5rem"></div>' +
      '</div>' +

      '</div>'; // close 4-column row of Backup/Restore/History/Scheduled cards

    renderCardAlertSummary(container);
    initBackupControls();
    initRestoreControls();
    loadBackupHistory();
    loadBackupSchedule();
    initUpdateControls();
    initCapacityActions();
    initCapacityAdvisorActions();
  } catch (err) {
    container.innerHTML = '<div class="settings-card"><p class="empty-state">Error: ' + escapeHtml(err.message) + '</p></div>';
  }
}

// ─── Backup Logic ───────────────────────────────────────────────────────────

// Returns true if the caller should proceed. If discoveries are running, prompts
// the user to abort them first; aborts on confirmation, cancels on dismissal.
async function warnIfDiscoveryRunning(actionLabel) {
  var result;
  try { result = await api.integrations.discoveries(); } catch (_) { return true; }
  var running = (result && result.discoveries) || [];
  if (running.length === 0) return true;

  var names = running.map(function (d) { return d.name; }).join(", ");
  var confirmed = await showConfirm(
    'A discovery is currently running (' + names + ').\n\n' +
    'Abort the discovery and continue with the ' + actionLabel + '?'
  );
  if (!confirmed) return false;

  await Promise.allSettled(running.map(function (d) {
    return api.integrations.abortDiscover(d.id);
  }));
  return true;
}

// Business rule 138: a firmware flash runs inside Polaris, so an update or a
// restart would leave it unfinished. Ask before either: resolves
// { proceed, abort } — abort true means the operator chose "abort and
// continue", sent to the server as abortFirmwareRuns so the runs are aborted
// in their name. A caller who cannot list the runs (no assets:read) learns of
// them from the server's 409 instead — see firmwareRunsFrom409.
async function warnIfFirmwareRunning(actionLabel) {
  var runs;
  try { runs = ((await api.assets.activeFirmwareRuns()) || {}).runs || []; } catch (_) { return { proceed: true, abort: false }; }
  if (runs.length === 0) return { proceed: true, abort: false };
  var ok = await confirmAbortFirmwareRuns(runs, actionLabel);
  return { proceed: ok, abort: ok };
}

function confirmAbortFirmwareRuns(runs, actionLabel) {
  var stageOf = typeof firmwareStageLabel === "function" ? firmwareStageLabel : function (s) { return s || "starting"; };
  var lines = runs.map(function (r) {
    return "• " + r.assetName + " → " + r.toVersion + " — " + stageOf(r.stage) + ", started by " + r.startedBy;
  }).join("\n");
  var one = runs.length === 1;
  return showConfirm(
    (one ? "A firmware upgrade is" : runs.length + " firmware upgrades are") + " in progress:\n\n" + lines + "\n\n" +
    "The " + actionLabel + " restarts Polaris, which would leave " + (one ? "it" : "them") + " unfinished. " +
    "Abort " + (one ? "it" : "them") + " and continue with the " + actionLabel + "? " +
    "A device that has already started flashing carries on by itself; verify its version afterwards."
  );
}

// The runs a 409 `firmware-upgrade-running` named, or null for any other error.
function firmwareRunsFrom409(err) {
  return err && err.status === 409 && err.data && err.data.code === "firmware-upgrade-running"
    ? (err.data.firmwareRuns || [])
    : null;
}

/**
 * Wire click handlers for the action buttons rendered inside capacity
 * reasons. Called from loadDatabaseInfo after the card is in the DOM.
 *
 * Only the metrics/health token-generation buttons remain here; queue-mode
 * changes are handled by the Capacity Advisor card via its Stage flow.
 */
function initCapacityActions() {
  var card = document.getElementById("capacity-card");
  if (!card) return;

  card.querySelectorAll('button[data-action="generate-token"]').forEach(function (btn) {
    btn.addEventListener("click", async function () {
      var which = btn.getAttribute("data-which");
      if (which !== "metrics" && which !== "health") return;
      btn.disabled = true;
      btn.textContent = "Generating...";
      try {
        await api.serverSettings.generateSecurityToken(which);
        showToast("Token written to .env — gate is active immediately", "success");
        _dbLoaded = false;
        loadDatabaseInfo();
      } catch (err) {
        showToast("Could not generate token: " + (err && err.message ? err.message : "unknown error"), "error");
        btn.disabled = false;
        btn.textContent = "Generate token";
      }
    });
  });
}

/**
 * Wire the Stage button on the Capacity Advisor card. Collects checked rows,
 * confirms the operator, posts to POST /capacity-advisor/stage, and renders
 * per-row success/error badges from the receipt.
 */
function wireAdvisorRestartBtn(restartBtn) {
  if (!restartBtn) return;
  restartBtn.addEventListener("click", async function () {
    if (!await warnIfDiscoveryRunning("restart")) return;
    var fw = await warnIfFirmwareRunning("restart");
    if (!fw.proceed) return;
    // The firmware confirm already said the restart is coming.
    var ok = fw.abort || await showConfirm(
      "Restart Polaris now?\n\n" +
      "The server will be unreachable for ~30 seconds. Any in-flight operator action " +
      "will fail and must be retried after the restart."
    );
    if (!ok) return;
    restartBtn.disabled = true;
    restartBtn.textContent = fw.abort ? "Aborting firmware upgrade..." : "Restarting...";
    try {
      try {
        await api.serverSettings.restart(fw.abort);
      } catch (err) {
        var runs = firmwareRunsFrom409(err);
        if (!runs || !await confirmAbortFirmwareRuns(runs, "restart")) throw err;
        restartBtn.textContent = "Aborting firmware upgrade...";
        await api.serverSettings.restart(true);
      }
      _advisorJustStaged = false;
      pollUntilServerReachable();
    } catch (err) {
      showToast("Restart failed: " + (err && err.message ? err.message : "unknown error"), "error");
      restartBtn.disabled = false;
      restartBtn.textContent = "Restart Polaris to apply";
    }
  });
}

/**
 * In a container the advisor asks the operator to restart it rather than
 * offering a button: Polaris can't see the container's restart policy, and a
 * self-exit under Unraid's default ("no") leaves the container stopped.
 */
function _advisorContainerRestartHtml() {
  return '<span class="hint" id="capacity-advisor-container-restart" style="font-size:0.82rem;color:var(--color-warning)">' +
    '<strong>Staged.</strong> Restart the Polaris container yourself to apply — ' +
    '<code>docker compose restart</code> for a compose stack (every role reads <code>.env</code>), ' +
    '<code>docker restart &lt;name&gt;</code>, or Restart on your container host\'s Docker page.' +
    '</span>';
}

/**
 * Mark a staged advisor row in place: drop the checkbox, flip the Status pill
 * to "Staged". Staged env values live in .env but don't reach the running
 * process until restart, so a re-fetch would still show them as pending —
 * hence we mutate the DOM directly instead of re-rendering from the advisor.
 */
function markAdvisorRowStaged(card, key) {
  var checkbox = card.querySelector('input.advisor-stage-checkbox[data-key="' + key + '"]');
  if (!checkbox) return;
  var row = checkbox.closest("tr");
  if (!row) return;
  var cells = row.querySelectorAll("td");
  // Status pill is the 4th column; Stage checkbox is the 5th (see _advisorRowHtml).
  if (cells[3]) cells[3].innerHTML = '<span class="advisor-pill advisor-pill-ok">Staged</span>';
  if (cells[4]) cells[4].innerHTML = '<span class="muted">✓</span>';
  row.classList.remove("advisor-row-change");
}

function initCapacityAdvisorActions() {
  var card = document.getElementById("capacity-advisor-card");
  if (!card) return;

  wireAdvisorRestartBtn(document.getElementById("capacity-advisor-restart-btn"));

  var stageBtn = document.getElementById("capacity-advisor-stage-btn");
  if (!stageBtn || stageBtn.disabled) return;

  stageBtn.addEventListener("click", async function () {
    _advisorJustStaged = false;
    var checked = Array.prototype.slice.call(
      card.querySelectorAll('input.advisor-stage-checkbox:checked')
    ).map(function (el) { return el.getAttribute("data-key"); });
    if (checked.length === 0) {
      showToast("Tick at least one row before staging", "error");
      return;
    }
    var msg = "Write " + checked.length + " value" + (checked.length === 1 ? "" : "s") +
      " to .env? They take effect on next Polaris restart.\n\nKeys:\n  " + checked.join("\n  ") +
      "\n\nmax_connections and PostgreSQL tuning are NOT in this set — those require a Postgres restart and must be done manually.";
    var ok = await showConfirm(msg);
    if (!ok) return;
    stageBtn.disabled = true;
    stageBtn.textContent = "Staging...";
    try {
      var receipt = await api.serverSettings.stageCapacityAdvisor(checked);
      var appliedRows = (receipt.results || []).filter(function (r) { return r.status === "applied"; });
      var applied = appliedRows.length;
      var errored = (receipt.results || []).filter(function (r) { return r.status === "error";   });
      if (errored.length > 0) {
        showToast("Staged " + applied + ", " + errored.length + " error" + (errored.length === 1 ? "" : "s") + ": " + errored.map(function (r) { return r.key + " — " + (r.reason || "unknown"); }).join("; "), "error");
        stageBtn.disabled = false;
        stageBtn.textContent = "Stage selected";
        return;
      }
      // Staged values are written to .env but don't reach the running process
      // until restart, so re-fetching the advisor would still show them as
      // pending. Instead, mark the staged rows and swap the footer button to
      // "Restart Polaris to apply" in place — no full-tab reload.
      _advisorJustStaged = true;
      appliedRows.forEach(function (r) { markAdvisorRowStaged(card, r.key); });
      showToast("Staged " + applied + " value" + (applied === 1 ? "" : "s") + ". " +
        (_advisorInContainer ? "Restart the Polaris container(s) to apply." : "Restart Polaris to apply."), "success");

      var remaining = card.querySelectorAll("input.advisor-stage-checkbox").length;
      if (remaining === 0 && _advisorInContainer) {
        var holder = document.createElement("span");
        holder.innerHTML = _advisorContainerRestartHtml();
        stageBtn.replaceWith(holder.firstChild);
      } else if (remaining === 0) {
        var restartBtn = document.createElement("button");
        restartBtn.className = "btn btn-warning";
        restartBtn.id = "capacity-advisor-restart-btn";
        restartBtn.textContent = "Restart Polaris to apply";
        stageBtn.replaceWith(restartBtn);
        wireAdvisorRestartBtn(restartBtn);
      } else {
        // Other recommendations remain unstaged — keep the Stage button live.
        stageBtn.disabled = false;
        stageBtn.textContent = "Stage selected";
      }
    } catch (err) {
      showToast("Stage failed: " + (err && err.message ? err.message : "unknown error"), "error");
      stageBtn.disabled = false;
      stageBtn.textContent = "Stage selected";
    }
  });
}

function initBackupControls() {
  var btnBackup = document.getElementById("btn-backup");
  btnBackup.addEventListener("click", async function () {
    var pw = document.getElementById("backup-password").value;
    var pwConfirm = document.getElementById("backup-password-confirm").value;
    var statusEl = document.getElementById("backup-status");

    if (pw && pw !== pwConfirm) {
      statusEl.innerHTML = '<span class="badge badge-error">Passwords do not match</span>';
      return;
    }

    if (!await warnIfDiscoveryRunning("backup")) return;

    btnBackup.disabled = true;
    btnBackup.textContent = "Creating backup...";
    statusEl.innerHTML = '<span class="badge badge-info">Compressing' + (pw ? " and encrypting" : "") + ' database...</span>';

    try {
      var result = await api.serverSettings.backupDatabase(pw || null);
      if (!result || !result.blob) throw new Error("No data received");

      // Trigger download
      var url = URL.createObjectURL(result.blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      var sizeKb = (result.blob.size / 1024).toFixed(1);
      statusEl.innerHTML = '<span class="badge badge-success">Backup created: ' + escapeHtml(result.filename) + ' (' + sizeKb + ' KB' + (pw ? ', encrypted' : '') + ')</span>';
      document.getElementById("backup-password").value = "";
      document.getElementById("backup-password-confirm").value = "";
      showToast("Backup downloaded: " + result.filename, "success");
      loadBackupHistory();
    } catch (err) {
      statusEl.innerHTML = '<span class="badge badge-error">' + escapeHtml(err.message) + '</span>';
      showToast("Backup failed: " + err.message, "error");
    } finally {
      btnBackup.disabled = false;
      btnBackup.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="vertical-align:-2px;margin-right:4px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Create Backup';
    }
  });
}

// ─── Restore Logic ──────────────────────────────────────────────────────────

var _restoreFile = null;

function initRestoreControls() {
  var dropZone = document.getElementById("restore-drop-zone");
  var fileInput = document.getElementById("restore-file-input");
  var fileInfo = document.getElementById("restore-file-info");
  var btnRestore = document.getElementById("btn-restore");
  var btnCancel = document.getElementById("btn-restore-cancel");

  dropZone.addEventListener("dragover", function (e) {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });
  dropZone.addEventListener("dragleave", function () {
    dropZone.classList.remove("drag-over");
  });
  dropZone.addEventListener("drop", function (e) {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    if (e.dataTransfer.files.length > 0) selectRestoreFile(e.dataTransfer.files[0]);
  });

  fileInput.addEventListener("change", function () {
    if (fileInput.files.length > 0) selectRestoreFile(fileInput.files[0]);
  });

  btnCancel.addEventListener("click", function () {
    _restoreFile = null;
    fileInfo.style.display = "none";
    dropZone.style.display = "";
    document.getElementById("restore-status").innerHTML = "";
    fileInput.value = "";
  });

  btnRestore.addEventListener("click", async function () {
    if (!_restoreFile) return;
    var pw = document.getElementById("restore-password")?.value || null;
    var statusEl = document.getElementById("restore-status");

    if (!await warnIfDiscoveryRunning("restore")) return;

    var confirmed = await showConfirm("This will replace ALL current data with the backup contents. This cannot be undone. Continue?");
    if (!confirmed) return;

    btnRestore.disabled = true;
    btnRestore.textContent = "Restoring...";
    statusEl.innerHTML = '<span class="badge badge-info">Restoring database...</span>';

    try {
      var result = await api.serverSettings.restoreDatabase(_restoreFile, pw);
      statusEl.innerHTML = '<span class="badge badge-success">' + escapeHtml(result.message || "Restore completed") +
        (result.backupDate ? ' (backup from ' + escapeHtml(formatDate(result.backupDate)) + ')' : '') + '</span>';
      showToast("Database restored successfully", "success");

      // A restore drops and recreates every table, so the running processes are
      // holding stale relation OIDs (the service recycles its own pool, but the
      // monitor/discovery roles have their own) and possibly a generated Prisma
      // client built against a different schema version. Make the restart
      // impossible to miss rather than leaving the operator on a subtly broken
      // instance.
      if (result.restartRequired) {
        statusEl.innerHTML +=
          '<div style="margin-top:0.75rem;padding:0.6rem 0.75rem;border-radius:6px;' +
          'background:color-mix(in srgb, var(--color-warning) 12%, transparent);' +
          'border:1px solid color-mix(in srgb, var(--color-warning) 30%, transparent);' +
          'font-size:0.85rem;color:var(--color-text-primary)">' +
          '<strong style="color:var(--color-warning)">Restart required</strong> — ' +
          'every Polaris process must restart to pick up the restored schema. ' +
          'Until then, queries may fail with "could not open relation".' +
          '</div>';
      }

      // Reset the form
      _restoreFile = null;
      fileInfo.style.display = "none";
      dropZone.style.display = "";
      document.getElementById("restore-file-input").value = "";

      // Refresh the database info
      setTimeout(function () {
        _dbLoaded = false;
        loadDatabaseInfo();
      }, 1500);
    } catch (err) {
      statusEl.innerHTML = '<span class="badge badge-error">' + escapeHtml(err.message) + '</span>';
      showToast("Restore failed: " + err.message, "error");
    } finally {
      btnRestore.disabled = false;
      btnRestore.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="vertical-align:-2px;margin-right:4px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>Restore Database';
    }
  });
}

function selectRestoreFile(file) {
  _restoreFile = file;
  var dropZone = document.getElementById("restore-drop-zone");
  var fileInfo = document.getElementById("restore-file-info");
  var statusEl = document.getElementById("restore-status");

  dropZone.style.display = "none";
  fileInfo.style.display = "";
  statusEl.innerHTML = "";

  document.getElementById("restore-filename").textContent = file.name;
  document.getElementById("restore-filesize").textContent = formatFileSize(file.size);

  // Extract version from filename: polaris-backup-1.0.0-2026-...gz
  var versionMatch = file.name.match(/polaris-backup-(\d+\.\d+\.\d+)-/);
  var backupVersion = versionMatch ? versionMatch[1] : null;
  var currentVersion = _branding && _branding.version ? _branding.version : null;
  var versionEl = document.getElementById("restore-version");
  var warningEl = document.getElementById("restore-version-warning");

  if (backupVersion) {
    versionEl.textContent = backupVersion;
    if (currentVersion && backupVersion !== currentVersion) {
      warningEl.style.display = "";
      warningEl.innerHTML =
        '<strong style="color:var(--color-warning)">Version mismatch</strong> — ' +
        'This backup was created with <strong>v' + escapeHtml(backupVersion) + '</strong>, ' +
        'but the running application is <strong>v' + escapeHtml(currentVersion) + '</strong>. ' +
        'Restoring a backup from a different version may fail or cause issues if the database schema has changed. ' +
        'For best results, ensure the application version matches the backup version before restoring.';
    } else {
      warningEl.style.display = "none";
    }
  } else {
    versionEl.innerHTML = '<span style="color:var(--color-text-tertiary)">Unknown</span>';
    warningEl.style.display = "";
    warningEl.innerHTML =
      '<strong style="color:var(--color-warning)">Unknown version</strong> — ' +
      'Could not determine the application version from this backup file. ' +
      'Ensure this backup was created by a compatible version of Polaris before restoring.';
  }

  var isEncrypted = file.name.includes(".enc");
  document.getElementById("restore-encrypted").innerHTML = isEncrypted
    ? '<span class="badge badge-warning" style="font-size:0.75rem">Yes</span>'
    : '<span class="badge badge-info" style="font-size:0.75rem">No</span>';
  document.getElementById("restore-password-row").style.display = isEncrypted ? "" : "none";

  // Also check magic bytes for encryption detection
  if (file.size > 8) {
    var reader = new FileReader();
    reader.onload = function () {
      var arr = new Uint8Array(reader.result);
      var magic = String.fromCharCode.apply(null, arr.slice(0, 7));
      if (magic === "POLARIS") {
        document.getElementById("restore-encrypted").innerHTML = '<span class="badge badge-warning" style="font-size:0.75rem">Yes</span>';
        document.getElementById("restore-password-row").style.display = "";
      }
    };
    reader.readAsArrayBuffer(file.slice(0, 8));
  }
}

// ─── Scheduled Backups ──────────────────────────────────────────────────────

async function loadBackupSchedule() {
  var enabledEl = document.getElementById("bksched-enabled");
  if (!enabledEl) return;
  var statusEl = document.getElementById("bksched-status");

  function syncFieldState() {
    var on = enabledEl.checked;
    ["bksched-interval", "bksched-hour", "bksched-retain", "bksched-passphrase", "bksched-copyto"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.disabled = !on;
    });
  }

  try {
    var s = await api.serverSettings.getBackupSchedule();
    enabledEl.checked = !!s.enabled;
    document.getElementById("bksched-interval").value = s.intervalHours;
    document.getElementById("bksched-hour").value = s.hourUtc === null ? "" : s.hourUtc;
    document.getElementById("bksched-retain").value = s.retainCount;
    // The GET returns the mask sentinel, never the stored passphrase. Sending it
    // back unchanged means "keep what is stored" (server-side isMaskedSecret).
    document.getElementById("bksched-passphrase").value = s.passphrase || "";
    document.getElementById("bksched-copyto").value = s.copyToDir || "";
    syncFieldState();

    var bkCard = document.getElementById("bksched-card");
    if (bkCard) {
      bkCard.classList.toggle("severity-edge-red", !!s.lastError);
      bkCard.classList.toggle("severity-edge-ok", !s.lastError);
      renderCardAlertSummary(document.getElementById("tab-maintenance"));
    }

    if (s.lastError) {
      statusEl.innerHTML = '<span class="badge badge-danger">Last run failed: ' + escapeHtml(s.lastError) + '</span>';
    } else if (s.lastRunAt) {
      statusEl.innerHTML = '<span class="hint">Last successful backup: ' + escapeHtml(formatDate(s.lastRunAt)) + '</span>';
    } else if (s.enabled) {
      statusEl.innerHTML = '<span class="hint">Enabled — the first backup runs shortly.</span>';
    } else {
      statusEl.innerHTML = '';
    }
  } catch (err) {
    statusEl.innerHTML = '<span class="badge badge-danger">Could not load schedule: ' + escapeHtml(err.message) + '</span>';
    return;
  }

  enabledEl.addEventListener("change", syncFieldState);

  document.getElementById("btn-bksched-save").addEventListener("click", async function () {
    var btn = this;
    var hourRaw = document.getElementById("bksched-hour").value;
    var body = {
      enabled: enabledEl.checked,
      intervalHours: parseInt(document.getElementById("bksched-interval").value, 10) || 24,
      hourUtc: hourRaw === "" ? null : parseInt(hourRaw, 10),
      retainCount: parseInt(document.getElementById("bksched-retain").value, 10) || 7,
      passphrase: document.getElementById("bksched-passphrase").value,
      copyToDir: document.getElementById("bksched-copyto").value,
    };
    btn.disabled = true;
    btn.textContent = "Saving...";
    try {
      await api.serverSettings.saveBackupSchedule(body);
      showToast("Backup schedule saved", "success");
      await loadBackupSchedule();
    } catch (err) {
      showToast("Could not save schedule: " + err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Save Schedule";
    }
  });
}

// ─── Backup History ─────────────────────────────────────────────────────────

// The check that would have said "your pg_dump is PostgreSQL 13, your server
// is 15" on the day it became true, instead of on the day someone needed a
// restore (prod, 2026-09-09: months of failing backups behind "see the server
// log"). Renders nothing when the tools are fine; the resolver's own sentence
// — versions, path, fix — when they are not. Rule 47.
function renderBackupToolingBanner(t) {
  if (!t || t.ok) return '';
  var problems = [t.pgDump, t.psql].filter(function (r) { return r && !r.compatible; });
  if (problems.length === 0) return '';
  return '<div style="background:color-mix(in srgb, var(--color-danger) 10%, transparent);border:1px solid var(--color-danger);border-radius:6px;padding:0.75rem 1rem;margin-bottom:0.75rem">' +
      '<div style="font-weight:600;font-size:0.88rem;margin-bottom:0.35rem">&#10007; Backups cannot run on this host</div>' +
      problems.map(function (r) {
        return '<p style="font-size:0.82rem;margin:0.25rem 0;line-height:1.5">' + escapeHtml(r.problem || (r.tool + ' is unusable')) + '</p>';
      }).join('') +
    '</div>';
}

async function loadBackupHistory() {
  var body = document.getElementById("backup-history-body");
  if (!body) return;
  try {
    // The tooling probe is best-effort: a failure there must not hide the list.
    var results = await Promise.all([
      api.serverSettings.listBackups(),
      api.serverSettings.backupTooling().catch(function () { return null; }),
    ]);
    var history = results[0];
    var toolingHtml = renderBackupToolingBanner(results[1]);
    if (!history || history.length === 0) {
      body.innerHTML = toolingHtml + '<p class="empty-state" style="font-size:0.85rem">No backups have been created yet.</p>';
      return;
    }
    // Every backup is listed (it stopped at the newest 20, so an older one
    // could not be downloaded or deleted from here); the list scrolls instead.
    body.innerHTML = toolingHtml +
      '<div style="max-height:420px;overflow-y:auto">' +
      '<table class="ip-table"><thead><tr>' +
        '<th>Date</th><th>Filename</th><th style="text-align:right">Size</th><th>Encrypted</th><th style="width:140px"></th>' +
      '</tr></thead><tbody>' +
      history.map(function (b) {
        var dlBtn = b.downloadable !== false
          ? '<button class="btn btn-secondary btn-sm backup-dl-btn" data-id="' + escapeHtml(b.id) + '" data-filename="' + escapeHtml(b.filename) + '" style="font-size:0.75rem;padding:2px 8px">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" style="vertical-align:-1px;margin-right:3px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
              'Download</button>'
          : '<span style="font-size:0.75rem;color:var(--color-text-tertiary)">Unavailable</span>';
        var preUpdateBadge = b.preUpdate
          ? ' <span class="badge" style="font-size:0.7rem;background:color-mix(in srgb, var(--color-warning) 15%, transparent);color:var(--color-warning);border:1px solid color-mix(in srgb, var(--color-warning) 40%, transparent)">Pre-update</span>'
          : '';
        // Rule 158(a): a backup file found on disk that the history no longer
        // lists. Its real name and version are unknown; it is still a backup.
        var untrackedBadge = b.untracked
          ? ' <span class="badge badge-info" style="font-size:0.7rem" title="Found on disk with no history entry — its original filename and version are not known">Found on disk</span>'
          : '';
        var pathRow = b.path
          ? '<div class="mono" style="font-size:0.72rem;color:var(--color-text-tertiary);margin-top:2px;word-break:break-all" title="' + escapeHtml(b.path) + '">' + escapeHtml(b.path) + '</div>'
          : '';
        return '<tr>' +
          '<td style="font-size:0.82rem;white-space:nowrap;vertical-align:top">' + escapeHtml(formatDate(b.createdAt)) + '</td>' +
          '<td class="mono" style="font-size:0.82rem">' + escapeHtml(b.filename) + preUpdateBadge + untrackedBadge + pathRow + '</td>' +
          '<td style="text-align:right;font-size:0.82rem;color:var(--color-text-secondary);vertical-align:top">' + formatFileSize(b.size || b.sizeBytes || 0) + '</td>' +
          '<td style="vertical-align:top">' + (b.encrypted
            ? '<span class="badge badge-warning" style="font-size:0.7rem">Encrypted</span>'
            : '<span class="badge badge-info" style="font-size:0.7rem">Plain</span>') +
          '</td>' +
          '<td style="display:flex;gap:4px;vertical-align:top">' + dlBtn +
            '<button class="btn btn-danger btn-sm backup-del-btn" data-id="' + escapeHtml(b.id) + '" style="font-size:0.75rem;padding:2px 8px" title="Delete">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" style="vertical-align:-1px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>' +
            '</button>' +
          '</td>' +
          '</tr>';
      }).join("") +
      '</tbody></table>' +
      '</div>';

    // Wire up download buttons
    body.querySelectorAll(".backup-dl-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-id");
        btn.disabled = true;
        btn.textContent = "...";
        api.serverSettings.downloadBackup(id).then(function (result) {
          if (!result || !result.blob) throw new Error("No data received");
          var url = URL.createObjectURL(result.blob);
          var a = document.createElement("a");
          a.href = url;
          a.download = result.filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          showToast("Downloaded: " + result.filename, "success");
        }).catch(function (err) {
          showToast("Download failed: " + err.message, "error");
        }).finally(function () {
          btn.disabled = false;
          btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" style="vertical-align:-1px;margin-right:3px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download';
        });
      });
    });

    body.querySelectorAll(".backup-del-btn").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var id = btn.getAttribute("data-id");
        var ok = await showConfirm("Delete this backup? This cannot be undone.");
        if (!ok) return;
        btn.disabled = true;
        try {
          await api.serverSettings.deleteBackup(id);
          showToast("Backup deleted");
          loadBackupHistory();
        } catch (err) {
          showToast("Delete failed: " + err.message, "error");
          btn.disabled = false;
        }
      });
    });
  } catch {
    body.innerHTML = '<p class="empty-state" style="font-size:0.85rem">Could not load backup history.</p>';
  }
}

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  var units = ["B", "KB", "MB", "GB"];
  var i = 0;
  var size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return size.toFixed(i === 0 ? 0 : 1) + " " + units[i];
}

// A fleet-average cadence for display: whole seconds, never below 1.
function _fmtCadenceSec(sec) {
  var n = Number(sec);
  if (!isFinite(n) || n <= 0) return "-";
  return Math.max(1, Math.round(n)) + "s";
}

function dbInfoRow(label, value, hint) {
  var titleAttr = hint ? ' title="' + escapeHtml(hint) + '"' : "";
  return '<div class="db-info-label"' + titleAttr + '>' + escapeHtml(label) + '</div>' +
         '<div class="db-info-value"' + titleAttr + '>' + escapeHtml(String(value)) + '</div>';
}

function formatNumber(n) {
  if (n === undefined || n === null) return "-";
  return Number(n).toLocaleString();
}

// ─── Application Updates ───────────────────────────────────────────────────

var _updatePollTimer = null;

function initUpdateControls() {
  document.getElementById("btn-check-updates").addEventListener("click", checkForUpdatesUI);

  // Show which repo updates are pulled from + where that's configured.
  loadUpdateRepoInfo();

  // Load and wire the backup checkbox + update-train dropdown (one settings GET)
  var backupCheckbox = document.getElementById("update-backup-checkbox");
  var trainSelect = document.getElementById("update-train-select");
  api.serverSettings.getUpdateSettings().then(function (s) {
    if (backupCheckbox) backupCheckbox.checked = !s.skipBackup;
    if (trainSelect) trainSelect.value = s.train === "release" ? "release" : "nightly";
  }).catch(function () {
    if (backupCheckbox) backupCheckbox.checked = true; // default: enabled
    if (trainSelect) trainSelect.value = "nightly";
  });
  if (backupCheckbox) {
    backupCheckbox.addEventListener("change", function () {
      api.serverSettings.setUpdateSettings({ skipBackup: !backupCheckbox.checked }).catch(function (err) {
        showToast("Failed to save setting: " + err.message, "error");
        backupCheckbox.checked = !backupCheckbox.checked; // revert
      });
    });
  }
  if (trainSelect) {
    var _prevTrain = trainSelect.value;
    trainSelect.addEventListener("change", function () {
      var train = trainSelect.value;
      api.serverSettings.setUpdateSettings({ train: train }).then(function () {
        _prevTrain = train;
        showToast("Update train set to " + (train === "release" ? "Release" : "Nightly"), "success");
        // A prior check reflects the old train — clear it so the operator
        // re-checks against the newly selected train.
        var statusEl = document.getElementById("update-check-status");
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--color-text-tertiary)">Train changed — check for updates to compare.</span>';
      }).catch(function (err) {
        showToast("Failed to save setting: " + err.message, "error");
        trainSelect.value = _prevTrain; // revert
      });
    });
  }

  var historyEl = document.getElementById("update-history");
  if (historyEl) {
    var historyLoaded = false;
    historyEl.addEventListener("toggle", function () {
      if (!historyEl.open || historyLoaded) return;
      historyLoaded = true;
      loadUpdateHistory();
    });
  }

  // Check if there's a pending notification from a background check or previous restart
  api.serverSettings.getUpdateStatus().then(function (status) {
    if (status.updateMethod === "image") {
      renderImageUpdate(status);
    } else if (status.state === "disabled") {
      renderUpdateDisabled(status);
    } else if (status.state === "complete") {
      renderUpdateComplete(status);
    } else if (status.state === "failed") {
      renderUpdateFailed(status);
    } else if (status.state === "available") {
      renderUpdateAvailable(status);
    } else if (status.state === "applying" || status.state === "restarting") {
      renderUpdateProgress();
      renderSteps(status.steps);
      startUpdatePolling();
    }
  }).catch(function () {});
}

function renderUpdateDisabled(status) {
  var area = document.getElementById("update-status-area");
  if (!area) return;
  area.innerHTML =
    '<div class="db-info-grid" style="margin-bottom:1rem">' +
      '<div class="db-info-label">Current Version</div>' +
      '<div class="db-info-value">v' + escapeHtml(status.currentVersion || '?') + '</div>' +
    '</div>' +
    '<div style="background:var(--color-bg-secondary);border:1px solid var(--color-border);border-radius:6px;padding:0.85rem 1rem">' +
      '<div style="font-weight:600;font-size:0.9rem;margin-bottom:0.35rem">' +
        escapeHtml(status.error || 'In-app updates are disabled.') +
      '</div>' +
      (status.method
        ? '<div style="font-size:0.82rem;color:var(--color-text-secondary)">' + escapeHtml(status.method) + '</div>'
        : '') +
    '</div>';
}

// A container install updates by pulling a newer image, so the card keeps
// only what applies there: the version, a daily registry check the operator
// can re-run, and how to update. The update train, the pre-update backup
// toggle and the git history are the in-app updater's and are removed.
function _applyImageUpdateLayout() {
  ["update-train-section", "update-backup-section", "update-history"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.remove();
  });
  var repo = document.getElementById("update-repo-info");
  if (repo) repo.innerHTML = "";
  var intro = document.getElementById("update-card-intro");
  if (intro) intro.textContent = "Polaris checks the published image once a day and tells you here, and in the sidebar, when a newer one is out.";
}

function renderImageUpdate(status) {
  _applyImageUpdateLayout();
  var area = document.getElementById("update-status-area");
  if (!area) return;
  var available = status.state === "available";
  var behind = status.commitsBehind || 0;

  var latestHtml = "";
  if (available) {
    var changesLink = status.source && status.latestCommit
      ? ' <a href="' + escapeHtml(status.source) + '/commits/' + encodeURIComponent(status.latestCommit) + '" target="_blank" rel="noopener noreferrer" style="font-size:0.8rem">What changed</a>'
      : "";
    latestHtml =
      '<div style="background:color-mix(in srgb, var(--color-primary) 10%, transparent);border:1px solid var(--color-primary);border-radius:6px;padding:1rem;margin-bottom:1rem">' +
        '<div style="color:var(--color-primary);font-weight:600;font-size:0.95rem;margin-bottom:0.5rem">Update Available</div>' +
        '<div class="db-info-grid">' +
          '<div class="db-info-label">Latest</div><div class="db-info-value">v' + escapeHtml(status.latestVersion || "?") +
            (status.latestCommit ? ' <span class="mono" style="color:var(--color-text-tertiary)">(' + escapeHtml(status.latestCommit) + ')</span>' : "") +
            ' <span style="color:var(--color-text-tertiary);font-size:0.8rem">' + behind + ' commit' + (behind === 1 ? "" : "s") + ' newer</span>' + changesLink +
          '</div>' +
        '</div>' +
        (status.method ? '<div style="font-size:0.82rem;color:var(--color-text-secondary);margin-top:0.6rem">' + escapeHtml(status.method) + '</div>' : "") +
      '</div>';
  }

  var stateLine;
  if (available) {
    stateLine = "";
  } else if (status.state === "up-to-date") {
    stateLine = '<span style="color:var(--color-success)">Up to date with ' + escapeHtml(status.image || "the published image") + '</span>';
  } else if (status.note) {
    stateLine = '<span style="color:var(--color-text-secondary)">' + escapeHtml(status.note) + '</span>';
  } else {
    stateLine = '<span style="color:var(--color-text-tertiary)">Not checked yet — the first check runs a minute after Polaris starts.</span>';
  }

  area.innerHTML =
    '<div class="db-info-grid" style="margin-bottom:1rem">' +
      '<div class="db-info-label">Current Version</div>' +
      '<div class="db-info-value" id="update-current-version">v' + escapeHtml(status.currentVersion || "?") + '</div>' +
      (status.checkedAt
        ? '<div class="db-info-label">Last checked</div><div class="db-info-value">' + escapeHtml(formatLocalTime(status.checkedAt)) + '</div>'
        : "") +
    '</div>' +
    latestHtml +
    '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
      '<button class="btn btn-secondary" id="btn-check-updates">' + (available ? "Check Again" : "Check for Updates") + '</button>' +
      '<span id="update-check-status" style="font-size:0.82rem">' + stateLine + '</span>' +
    '</div>' +
    (!available && status.method
      ? '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.6rem 0 0">' + escapeHtml(status.method) + '</p>'
      : "");
  document.getElementById("btn-check-updates").addEventListener("click", checkForUpdatesUI);
}

async function loadUpdateRepoInfo() {
  var el = document.getElementById("update-repo-info");
  if (!el) return;
  try {
    var info = await api.serverSettings.getUpdateRepo();
    if (!info || !info.url) {
      // Disabled/Docker installs or no origin remote — nothing useful to show.
      el.innerHTML = "";
      return;
    }
    var src = info.source === "env"
      ? 'configured via <span class="mono">POLARIS_UPDATE_REPO</span> in <span class="mono">.env</span>'
      : 'from the <span class="mono">origin</span> git remote (set <span class="mono">POLARIS_UPDATE_REPO</span> in <span class="mono">.env</span> to override)';
    el.innerHTML =
      '<span style="font-weight:600">Update source:</span> ' +
      '<span class="mono" style="color:var(--color-text-secondary)">' + escapeHtml(info.url) + '</span>' +
      '<br><span style="font-size:0.76rem">' + src + '</span>';
  } catch (err) {
    el.innerHTML = "";
  }
}

async function loadUpdateHistory() {
  var body = document.getElementById("update-history-body");
  if (!body) return;
  try {
    var commits = await api.serverSettings.getUpdateHistory(20);
    if (!commits || commits.length === 0) {
      body.innerHTML = '<span>No commit history available.</span>';
      return;
    }
    var html = '<div style="border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-bg-secondary);max-height:280px;overflow-y:auto">';
    commits.forEach(function (c, i) {
      html += '<div style="padding:0.35rem 0.6rem;' + (i < commits.length - 1 ? 'border-bottom:1px solid var(--color-border);' : '') + 'display:flex;gap:10px;align-items:baseline">' +
        '<span class="mono" style="color:var(--color-text-tertiary);flex-shrink:0">' + escapeHtml(c.hash) + '</span>' +
        (c.date ? '<span style="color:var(--color-text-tertiary);font-size:0.78rem;flex-shrink:0">' + escapeHtml(c.date) + '</span>' : '') +
        '<span style="color:var(--color-text-primary)">' + escapeHtml(c.subject) + '</span>' +
      '</div>';
    });
    html += '</div>';
    body.innerHTML = html;
  } catch (err) {
    body.innerHTML = '<span style="color:var(--color-danger)">Failed to load history: ' + escapeHtml(err.message || String(err)) + '</span>';
  }
}

async function checkForUpdatesUI() {
  var btn = document.getElementById("btn-check-updates");
  // Every card that renders #btn-check-updates must render this span beside
  // it. The Update Failed card once did not, and this line threw on null
  // before the request was sent — Check Again looked dead until Dismiss
  // re-rendered the plain check state (prod, 2026-09-10). Tolerate a missing
  // span anyway: a dead button is the worst outcome here.
  var statusEl = document.getElementById("update-check-status") || { innerHTML: "" };
  btn.disabled = true;
  btn.textContent = "Checking...";
  statusEl.innerHTML = '<span style="color:var(--color-text-tertiary)">Fetching latest version...</span>';

  try {
    var result = await api.serverSettings.checkForUpdates();

    if (result.updateMethod === "image") {
      renderImageUpdate(result);
      return;
    }

    if (result.state === "disabled") {
      renderUpdateDisabled(result);
      return;
    }

    if (result.state === "up-to-date") {
      if (result.note) {
        statusEl.innerHTML = '<span style="color:var(--color-text-secondary)">' + escapeHtml(result.note) + '</span>';
      } else {
        statusEl.innerHTML = '<span style="color:var(--color-success)">Up to date (v' + escapeHtml(result.currentVersion) + ')</span>';
      }
      btn.textContent = "Check for Updates";
      btn.disabled = false;
      return;
    }

    if (result.state === "available") {
      renderUpdateAvailable(result);
      return;
    }

    if (result.state === "failed") {
      statusEl.innerHTML = '<span style="color:var(--color-danger)">' + escapeHtml(result.error || "Check failed") + '</span>';
    }
  } catch (err) {
    statusEl.innerHTML = '<span style="color:var(--color-danger)">' + escapeHtml(err.message) + '</span>';
  }

  btn.textContent = "Check for Updates";
  btn.disabled = false;
}

function renderUpdateAvailable(result) {
  var area = document.getElementById("update-status-area");

  var changesHtml = "";
  if (result.changes && result.changes.length > 0) {
    changesHtml = '<div style="margin-top:0.75rem"><label style="font-size:0.78rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--color-text-tertiary)">Changes (' + result.commitsBehind + ' commit' + (result.commitsBehind === 1 ? '' : 's') + ')</label>' +
      '<div style="max-height:160px;overflow-y:auto;margin-top:0.4rem;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-bg-secondary)">';
    result.changes.forEach(function (c) {
      var parts = c.match(/^(\w+)\s+(.*)$/);
      if (parts) {
        changesHtml += '<div style="padding:0.3rem 0.6rem;font-size:0.82rem;border-bottom:1px solid var(--color-border)">' +
          '<span class="mono" style="color:var(--color-text-tertiary);margin-right:8px">' + escapeHtml(parts[1]) + '</span>' +
          '<span>' + escapeHtml(parts[2]) + '</span></div>';
      } else {
        changesHtml += '<div style="padding:0.3rem 0.6rem;font-size:0.82rem;border-bottom:1px solid var(--color-border)">' + escapeHtml(c) + '</div>';
      }
    });
    changesHtml += '</div></div>';
  }

  area.innerHTML =
    '<div style="background:color-mix(in srgb, var(--color-primary) 10%, transparent);border:1px solid var(--color-primary);border-radius:6px;padding:1rem;margin-bottom:1rem">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<span style="color:var(--color-primary);font-weight:600;font-size:0.95rem">Update Available</span>' +
        (result.train === "release"
          ? '<span style="font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--color-text-tertiary);border:1px solid var(--color-border);border-radius:10px;padding:1px 8px">Release' + (result.releaseTag ? ' ' + escapeHtml(result.releaseTag) : '') + '</span>'
          : '<span style="font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--color-text-tertiary);border:1px solid var(--color-border);border-radius:10px;padding:1px 8px">Nightly</span>') +
      '</div>' +
      // Set by the server when the checkout is already ahead of the running
      // build (an earlier update pulled, then failed before the restart).
      // Without it this card would read as a brand-new release.
      (result.note
        ? '<div style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.6rem">' + escapeHtml(result.note) + '</div>'
        : '') +
      '<div class="db-info-grid">' +
        '<div class="db-info-label">Current</div><div class="db-info-value">v' + escapeHtml(result.currentVersion) + ' <span class="mono" style="color:var(--color-text-tertiary)">(' + escapeHtml(result.currentCommit) + ')</span></div>' +
        '<div class="db-info-label">Latest</div><div class="db-info-value">v' + escapeHtml(result.latestVersion) + ' <span class="mono" style="color:var(--color-text-tertiary)">(' + escapeHtml(result.latestCommit) + ')</span></div>' +
      '</div>' +
      changesHtml +
    '</div>' +
    '<div style="display:flex;gap:8px;align-items:center">' +
      '<button class="btn btn-primary" id="btn-apply-update">Apply Update</button>' +
      '<button class="btn btn-secondary" id="btn-check-updates">Check Again</button>' +
      '<span id="update-check-status" style="font-size:0.82rem"></span>' +
    '</div>';

  document.getElementById("btn-apply-update").addEventListener("click", applyUpdateUI);
  document.getElementById("btn-check-updates").addEventListener("click", checkForUpdatesUI);
}

async function applyUpdateUI() {
  if (!await warnIfDiscoveryRunning("update")) return;
  var fw = await warnIfFirmwareRunning("update");
  if (!fw.proceed) return;
  var abortFirmware = fw.abort;

  var backupCheckbox = document.getElementById("update-backup-checkbox");
  var backupEnabled = backupCheckbox ? backupCheckbox.checked : true;

  var password = null;
  // Server default: a FAILED pre-update backup aborts the update. This flag is
  // the operator's explicit "proceed anyway", collected in the password modal.
  var allowWithoutBackup = false;
  if (backupEnabled) {
    var pwResult = await promptUpdateBackupPassword();
    if (pwResult === null) return; // user cancelled
    password = pwResult.password || null; // empty string → unencrypted
    allowWithoutBackup = !!pwResult.allowWithoutBackup;
  } else {
    var confirmed = await showConfirm(
      "Apply this update? Backup is disabled — no recovery point will be created, and the migration step cannot be rolled back. " +
      "The server will restart automatically when complete."
    );
    if (!confirmed) return;
  }

  var btn = document.getElementById("btn-apply-update");
  btn.disabled = true;
  btn.textContent = abortFirmware ? "Aborting firmware upgrade..." : "Starting update...";

  try {
    try {
      await api.serverSettings.applyUpdate(password, allowWithoutBackup, abortFirmware);
    } catch (err) {
      // A flash this browser could not see (no assets:read), or one that
      // started after the check above — the server names it (rule 138).
      var runs = firmwareRunsFrom409(err);
      if (!runs || !await confirmAbortFirmwareRuns(runs, "update")) throw err;
      btn.textContent = "Aborting firmware upgrade...";
      await api.serverSettings.applyUpdate(password, allowWithoutBackup, true);
    }
    renderUpdateProgress();
    startUpdatePolling();
    // Kick the sidebar's own update-progress panel (app.js). It self-paces at
    // 60 s while idle and 5 s only once it has SEEN an update in flight, so
    // without this nudge it can sleep clean through the applying phase and
    // never render — the panel is the only progress the operator has once they
    // navigate off this page.
    if (typeof window._pollUpdateProgress === "function") window._pollUpdateProgress();
  } catch (err) {
    showToast("Failed to start update: " + err.message, "error");
    btn.disabled = false;
    btn.textContent = "Apply Update";
  }
}

// Resolves to { password, allowWithoutBackup } — password "" means
// proceed-without-encryption — or null when the operator cancels.
function promptUpdateBackupPassword() {
  return new Promise(function (resolve) {
    var body =
      '<p style="font-size:0.9rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'A database backup will be created before the update and the server will restart automatically when complete. ' +
        'Optionally encrypt the backup with a password — recommended if the backup will be archived off-host.' +
      '</p>' +
      '<div class="form-row" style="gap:12px;flex-wrap:wrap">' +
        '<div style="flex:1;min-width:180px">' +
          '<label for="update-backup-pw">Encryption password <span style="color:var(--color-text-tertiary)">(optional)</span></label>' +
          '<input type="password" id="update-backup-pw" placeholder="Leave blank for unencrypted backup" autocomplete="new-password">' +
        '</div>' +
        '<div style="flex:1;min-width:180px">' +
          '<label for="update-backup-pw-confirm">Confirm password</label>' +
          '<input type="password" id="update-backup-pw-confirm" placeholder="Re-enter password" autocomplete="new-password">' +
        '</div>' +
      '</div>' +
      '<div id="update-backup-pw-error" style="color:var(--color-danger);font-size:0.82rem;margin-top:0.5rem;min-height:1em"></div>' +
      // Unticked by default: if the backup fails, the update stops. Migrations
      // are not reversible, so continuing past a failed backup means the update
      // has no recovery point at all.
      '<label style="display:flex;align-items:flex-start;gap:8px;margin-top:1rem;font-size:0.85rem;color:var(--color-text-secondary)">' +
        '<input type="checkbox" id="update-allow-nobackup" style="margin-top:3px">' +
        '<span>Proceed even if the backup fails. Leave this off unless you accept that a failed migration would have no recovery point.</span>' +
      '</label>';
    var footer =
      '<button class="btn btn-secondary" id="upd-pw-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="upd-pw-ok">Apply Update</button>';
    openModal("Apply Update", body, footer);

    document.getElementById("upd-pw-cancel").onclick = function () {
      closeModal();
      resolve(null);
    };
    document.getElementById("upd-pw-ok").onclick = function () {
      var pw = document.getElementById("update-backup-pw").value;
      var pwConfirm = document.getElementById("update-backup-pw-confirm").value;
      var errEl = document.getElementById("update-backup-pw-error");
      if (pw && pw !== pwConfirm) {
        errEl.textContent = "Passwords do not match";
        return;
      }
      errEl.textContent = "";
      var allowEl = document.getElementById("update-allow-nobackup");
      closeModal();
      resolve({ password: pw || "", allowWithoutBackup: !!(allowEl && allowEl.checked) });
    };
    var pwInput = document.getElementById("update-backup-pw");
    if (pwInput) pwInput.focus();
  });
}

function renderUpdateProgress() {
  var area = document.getElementById("update-status-area");
  area.innerHTML =
    '<div style="margin-bottom:1rem">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.75rem">' +
        '<div class="spinner" style="width:18px;height:18px"></div>' +
        '<span style="font-weight:600">Updating...</span>' +
      '</div>' +
      '<div id="update-steps-list"></div>' +
    '</div>';
}

function renderSteps(steps) {
  var el = document.getElementById("update-steps-list");
  if (!el) return;

  var html = '';
  (steps || []).forEach(function (step) {
    var icon = '';
    var color = 'var(--color-text-tertiary)';
    if (step.status === "done") { icon = '&#10003;'; color = 'var(--color-success)'; }
    else if (step.status === "running") { icon = '&#9679;'; color = 'var(--color-primary)'; }
    else if (step.status === "failed") { icon = '&#10007;'; color = 'var(--color-danger)'; }
    else { icon = '&#9675;'; }

    html += '<div style="display:flex;align-items:center;gap:8px;padding:0.35rem 0;font-size:0.88rem">' +
      '<span style="color:' + color + ';font-size:1rem;width:20px;text-align:center;flex-shrink:0">' + icon + '</span>' +
      '<span style="' + (step.status === "running" ? 'font-weight:600' : '') + '">' + escapeHtml(step.name) + '</span>' +
      (step.message ? '<span style="color:var(--color-text-tertiary);font-size:0.78rem;margin-left:auto">' + escapeHtml(step.message) + '</span>' : '') +
    '</div>';
  });
  el.innerHTML = html;
}

function startUpdatePolling() {
  if (_updatePollTimer) clearInterval(_updatePollTimer);
  _updatePollTimer = setInterval(pollUpdateStatus, 2000);
}

function stopUpdatePolling() {
  if (_updatePollTimer) { clearInterval(_updatePollTimer); _updatePollTimer = null; }
}

var _serverDownSince = null;

async function pollUpdateStatus() {
  try {
    var status = await api.serverSettings.getUpdateStatus();
    _serverDownSince = null;

    if (status.state === "applying" || status.state === "restarting") {
      renderSteps(status.steps);
      if (status.state === "restarting") {
        // Server is about to go down — switch to restart polling
        stopUpdatePolling();
        pollForRestart(status);
      }
      return;
    }

    if (status.state === "complete") {
      stopUpdatePolling();
      window.location.href = "server-settings.html?tab=database";
      return;
    }

    if (status.state === "failed") {
      stopUpdatePolling();
      renderUpdateFailed(status);
      return;
    }
  } catch (err) {
    // Server is down — it's probably restarting
    if (!_serverDownSince) _serverDownSince = Date.now();
    // If server has been down for more than 60s, show an error
    if (Date.now() - _serverDownSince > 60000) {
      stopUpdatePolling();
      var area = document.getElementById("update-status-area");
      if (area) {
        area.innerHTML =
          '<div style="background:color-mix(in srgb, var(--color-danger) 10%, transparent);border:1px solid var(--color-danger);border-radius:6px;padding:1rem">' +
            '<strong style="color:var(--color-danger)">Server unreachable</strong>' +
            '<p style="font-size:0.82rem;margin-top:0.5rem">The server has not responded for over 60 seconds. It may have failed to restart. Check the server logs.</p>' +
          '</div>';
      }
    }
  }
}

function pollForRestart(lastStatus) {
  var area = document.getElementById("update-status-area");
  if (area) {
    renderSteps(lastStatus.steps);
    var stepsEl = document.getElementById("update-steps-list");
    if (stepsEl) {
      stepsEl.innerHTML += '<div style="display:flex;align-items:center;gap:8px;padding:0.5rem 0;font-size:0.88rem">' +
        '<div class="spinner" style="width:16px;height:16px"></div>' +
        '<span>Waiting for server to restart...</span>' +
      '</div>';
    }
  }

  var attempts = 0;
  var restartTimer = setInterval(async function () {
    attempts++;
    try {
      var status = await api.serverSettings.getUpdateStatus();
      if (status.state === "complete") {
        clearInterval(restartTimer);
        window.location.href = "server-settings.html?tab=database";
        return;
      }
      if (status.state === "failed") {
        clearInterval(restartTimer);
        renderUpdateFailed(status);
        return;
      }
    } catch (_) {
      // Server still down
    }
    if (attempts > 30) {
      clearInterval(restartTimer);
      if (area) {
        area.innerHTML =
          '<div style="background:color-mix(in srgb, var(--color-danger) 10%, transparent);border:1px solid var(--color-danger);border-radius:6px;padding:1rem">' +
            '<strong style="color:var(--color-danger)">Server did not come back</strong>' +
            '<p style="font-size:0.82rem;margin-top:0.5rem">The server has not responded after 60 seconds. Check the server logs for errors.</p>' +
            '<button class="btn btn-secondary" style="margin-top:0.75rem" onclick="location.reload()">Retry</button>' +
          '</div>';
      }
    }
  }, 2000);
}

// Lightweight standalone restart poller used by the Capacity Advisor "Restart
// Polaris to apply" button. Unlike pollForRestart, this isn't tied to the
// update-status state machine — a plain restart never reaches "complete", so
// we just wait for ANY successful response from the server and reload.
function pollUntilServerReachable() {
  // Full-screen overlay so the operator can see something is happening even
  // when the click happened from a non-update card.
  var overlay = document.createElement("div");
  overlay.className = "blocking-overlay";
  overlay.innerHTML =
    '<div class="blocking-overlay-card">' +
      '<div class="spinner" style="width:28px;height:28px;margin:0 auto 0.75rem"></div>' +
      '<strong>Restarting Polaris...</strong>' +
      '<p id="restart-poll-msg" style="font-size:0.82rem;margin-top:0.5rem;color:var(--color-text-secondary)">' +
        'Waiting for the server to come back online.' +
      '</p>' +
    '</div>';
  document.body.appendChild(overlay);

  var serverWentDown = false;
  var attempts = 0;
  var timer = setInterval(async function () {
    attempts++;
    try {
      await api.serverSettings.getUpdateStatus();
      if (serverWentDown) {
        // Was down, now reachable → reload to pick up the restarted process.
        clearInterval(timer);
        window.location.reload();
        return;
      }
    } catch (_) {
      // Server is down — expected during the restart window.
      serverWentDown = true;
    }
    if (attempts > 60) {
      clearInterval(timer);
      var msg = document.getElementById("restart-poll-msg");
      if (msg) {
        msg.innerHTML = '<span style="color:var(--color-danger)">Server has not responded after 120 seconds. ' +
          'Check the server logs.</span><br><button class="btn btn-secondary" style="margin-top:0.75rem" onclick="location.reload()">Retry</button>';
      }
    }
  }, 2000);
}

function renderUpdateComplete(status) {
  var area = document.getElementById("update-status-area");
  if (!area) return;

  var changesHtml = "";
  if (status.changes && status.changes.length > 0) {
    var n = status.changes.length;
    changesHtml = '<div style="margin-top:0.75rem"><label style="font-size:0.78rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--color-text-tertiary)">Applied Changes (' + n + ' commit' + (n === 1 ? '' : 's') + ')</label>' +
      '<div style="max-height:200px;overflow-y:auto;margin-top:0.4rem;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-bg-secondary)">';
    status.changes.forEach(function (c) {
      var parts = c.match(/^(\w+)\s+(.*)$/);
      if (parts) {
        changesHtml += '<div style="padding:0.3rem 0.6rem;font-size:0.82rem;border-bottom:1px solid var(--color-border)">' +
          '<span class="mono" style="color:var(--color-text-tertiary);margin-right:8px">' + escapeHtml(parts[1]) + '</span>' +
          '<span>' + escapeHtml(parts[2]) + '</span></div>';
      } else {
        changesHtml += '<div style="padding:0.3rem 0.6rem;font-size:0.82rem;border-bottom:1px solid var(--color-border)">' + escapeHtml(c) + '</div>';
      }
    });
    changesHtml += '</div></div>';
  }

  area.innerHTML =
    '<div style="background:color-mix(in srgb, var(--color-success) 10%, transparent);border:1px solid var(--color-success);border-radius:6px;padding:1rem;margin-bottom:1rem">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<span style="color:var(--color-success);font-weight:600;font-size:0.95rem">&#10003; Update Complete</span>' +
      '</div>' +
      '<div class="db-info-grid">' +
        (status.currentVersion ? '<div class="db-info-label">Previous</div><div class="db-info-value">v' + escapeHtml(status.currentVersion) + '</div>' : '') +
        (status.latestVersion ? '<div class="db-info-label">Current</div><div class="db-info-value">v' + escapeHtml(status.latestVersion) + '</div>' : '') +
      '</div>' +
      changesHtml +
    '</div>' +
    '<div style="display:flex;gap:8px;align-items:center">' +
      '<button class="btn btn-secondary" id="btn-dismiss-update">Dismiss</button>' +
      '<button class="btn btn-secondary" onclick="location.reload()">Reload Page</button>' +
    '</div>';

  document.getElementById("btn-dismiss-update").addEventListener("click", async function () {
    await api.serverSettings.dismissUpdate();
    // Reset to check state
    var area2 = document.getElementById("update-status-area");
    area2.innerHTML =
      '<div class="db-info-grid" style="margin-bottom:1rem">' +
        '<div class="db-info-label">Current Version</div>' +
        '<div class="db-info-value">v' + escapeHtml(status.latestVersion || '?') + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<button class="btn btn-secondary" id="btn-check-updates">Check for Updates</button>' +
        '<span id="update-check-status" style="font-size:0.82rem"></span>' +
      '</div>';
    document.getElementById("btn-check-updates").addEventListener("click", checkForUpdatesUI);
  });
}

function renderUpdateFailed(status) {
  var area = document.getElementById("update-status-area");
  if (!area) return;

  var stepsHtml = '';
  if (status.steps && status.steps.length > 0) {
    stepsHtml = '<div style="margin-top:0.75rem">';
    status.steps.forEach(function (step) {
      var icon = step.status === "done" ? "&#10003;" : step.status === "failed" ? "&#10007;" : "&#9675;";
      var color = step.status === "done" ? "var(--color-success)" : step.status === "failed" ? "var(--color-danger)" : "var(--color-text-tertiary)";
      stepsHtml += '<div style="display:flex;align-items:center;gap:8px;padding:0.25rem 0;font-size:0.85rem">' +
        '<span style="color:' + color + '">' + icon + '</span>' +
        '<span>' + escapeHtml(step.name) + '</span>' +
        (step.message ? '<span style="color:var(--color-text-tertiary);font-size:0.78rem;margin-left:auto">' + escapeHtml(step.message) + '</span>' : '') +
      '</div>';
    });
    stepsHtml += '</div>';
  }

  var recoveryHtml = '';
  if (status.backupFile) {
    // Three separate psql sessions, not one: a database with TimescaleDB must be
    // restored between timescaledb_pre_restore() and timescaledb_post_restore(),
    // and pre_restore only affects sessions opened after it. The single
    // `gunzip | psql` this card used to print skipped both and corrupted a
    // Timescale restore — same defect the fallback scripts carried until 2026-09.
    var CODE = 'font-size:0.8rem;background:var(--color-bg-secondary);padding:1px 5px;border-radius:3px';
    var BLOCK = 'display:block;margin-top:0.3rem;font-size:0.8rem;background:var(--color-bg-secondary);padding:4px 8px;border-radius:3px;white-space:nowrap;overflow-x:auto';
    var restoreCmd = 'gunzip -c ' + status.backupFile + ' | sudo -u postgres psql -v ON_ERROR_STOP=1 --single-transaction -d polaris';
    recoveryHtml =
      '<div style="margin-top:1rem;background:color-mix(in srgb, var(--color-warning) 8%, transparent);border:1px solid color-mix(in srgb, var(--color-warning) 35%, transparent);border-radius:6px;padding:1rem">' +
        '<div style="font-weight:600;font-size:0.88rem;margin-bottom:0.5rem">Pre-update backup available</div>' +
        '<p style="font-size:0.82rem;margin:0 0 0.75rem">A backup was created before the update started. Download it from <strong>Backup History</strong> below before attempting any recovery.</p>' +
        '<details>' +
          '<summary style="cursor:pointer;font-size:0.82rem;color:var(--color-text-secondary);user-select:none">Manual restore instructions (if the app is unavailable)</summary>' +
          '<ol style="font-size:0.82rem;margin:0.6rem 0 0.5rem;padding-left:1.4rem;line-height:1.7">' +
            '<li>Download the pre-update backup from <strong>Backup History</strong> below and copy it to the server.</li>' +
            '<li>Prefer <strong>Server Settings → Maintenance → Restore</strong> once the app is reachable — it runs the TimescaleDB restore gates for you. The steps below are for when it is not.</li>' +
            '<li>Stop the Polaris process group:<br>' +
              '<code style="' + CODE + '">sudo systemctl stop polaris.target</code></li>' +
            '<li>Open the TimescaleDB restore window (skip this and step 6 only if the extension is not installed):<br>' +
              '<code style="' + BLOCK + '">sudo -u postgres psql -d polaris -c \'SELECT timescaledb_pre_restore();\'</code></li>' +
            '<li>Restore the dump:<br>' +
              '<code style="' + BLOCK + '">' + escapeHtml(restoreCmd) + '</code></li>' +
            '<li>Close the restore window — <strong>run this even if step 5 failed</strong>; a database left in restoring mode rejects hypertable writes:<br>' +
              '<code style="' + BLOCK + '">sudo -u postgres psql -d polaris -c \'SELECT timescaledb_post_restore();\'</code></li>' +
            '<li>Start the process group again:<br>' +
              '<code style="' + CODE + '">sudo systemctl start polaris.target</code></li>' +
          '</ol>' +
        '</details>' +
      '</div>';
  }

  area.innerHTML =
    '<div style="background:color-mix(in srgb, var(--color-danger) 10%, transparent);border:1px solid var(--color-danger);border-radius:6px;padding:1rem;margin-bottom:1rem">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<span style="color:var(--color-danger);font-weight:600;font-size:0.95rem">&#10007; Update Failed</span>' +
      '</div>' +
      '<p style="font-size:0.85rem;margin:0.5rem 0">' + escapeHtml(status.error || 'Unknown error') + '</p>' +
      stepsHtml +
    '</div>' +
    recoveryHtml +
    '<div style="display:flex;gap:8px;align-items:center;margin-top:1rem">' +
      '<button class="btn btn-secondary" id="btn-dismiss-update">Dismiss</button>' +
      '<button class="btn btn-secondary" id="btn-check-updates">Check Again</button>' +
      '<span id="update-check-status" style="font-size:0.82rem"></span>' +
    '</div>';

  // Reload backup history so the pre-update backup entry is visible immediately
  if (status.backupFile) loadBackupHistory();

  document.getElementById("btn-dismiss-update").addEventListener("click", async function () {
    await api.serverSettings.dismissUpdate();
    _dbLoaded = false;
    loadDatabaseInfo();
  });
  document.getElementById("btn-check-updates").addEventListener("click", checkForUpdatesUI);
}

