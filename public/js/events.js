/**
 * public/js/events.js — Events page logic
 */

var _eventsPageSize = 15;
var _eventsCurrentOffset = 0;
var _eventsCurrentTotal = 0;
var _eventsCurrentPage = [];
var _eventsLayout = null;
// TableSF instance — held at module scope so the PDF/CSV export helpers can
// read its current filter + sort state (they no longer have a DOM strip to
// scrape). The Events page operates TableSF in *server-side mode*: every row
// that reaches the tbody is already server-filtered/sorted, so sf.apply() is
// never called — onTableSFChange translates state into API params and
// re-fetches instead. Required by the 235k–350k-row Event table; see
// polaris-ui-canon → "Sortable + filterable data table (server-side mode)".
var _eventsSF = null;

(function () {
  var pageSize = _eventsPageSize;
  var currentOffset = 0;
  var currentTotal = 0;

  function _saveEventsPrefs() {
    if (typeof currentUsername === "undefined") return;
    // Persist filter + sort state alongside the column layout, matching the
    // other list pages. Written in the standard shape now; setPrefs still
    // reads the page's legacy filters/sort shape from older saved blobs.
    PolarisPrefs.save("events", currentUsername, Object.assign(
      { pageSize: pageSize, layout: _eventsLayout ? _eventsLayout.getPrefs() : null },
      _eventsSF ? _eventsSF.getPrefs() : {},
    ));
  }
  function _restoreEventsPrefs() {
    if (typeof currentUsername === "undefined") return;
    var p = PolarisPrefs.load("events", currentUsername);
    if (!p) return;
    if (p.pageSize) {
      pageSize = p.pageSize;
      _eventsPageSize = p.pageSize;
      var psSel = document.getElementById("filter-pagesize");
      if (psSel) psSel.value = String(p.pageSize);
    }
    if (_eventsLayout && p.layout) _eventsLayout.setPrefs(p.layout);
    if (_eventsSF) _eventsSF.setPrefs(p);
  }

  // Cached set of distinct resourceType values for the Resource-column
  // multi-select. Seeded once from GET /events/resource-types (the full
  // distinct set across the whole retention window, so every option is
  // selectable even when it isn't on the current page) and then merged with
  // each fetch's page-seen values so a brand-new type appears in the filter as
  // soon as it's written.
  var _resourceTypeOptions = [];

  // Seed the Resource filter with the full distinct set from the backend so
  // the dropdown shows every option, not just those on the current page.
  async function _seedResourceTypeOptions() {
    if (!_eventsSF) return;
    try {
      var data = await api.events.resourceTypes();
      var types = (data && data.resourceTypes) || [];
      if (!types.length) return;
      var seen = {};
      _resourceTypeOptions.forEach(function (v) { seen[v] = true; });
      types.forEach(function (v) { if (v) seen[v] = true; });
      _resourceTypeOptions = Object.keys(seen).sort();
      _eventsSF.setColumnOptions("resourceType", _resourceTypeOptions);
    } catch (_) {}
  }

  /**
   * Translate the live TableSF filter + sort state into API query params for
   * GET /api/v1/events. Server-side mode: every filter goes over the wire,
   * nothing client-side. Mirrors the parameter shape extended by the same
   * commit that adds this mode to the route (CSV multi-value enums,
   * <field>Op-aware text filters, sortBy/sortDir whitelist).
   */
  function _buildEventsQuery() {
    var filters = _eventsSF ? _eventsSF._filters || {} : {};
    var params = {
      limit: pageSize,
      offset: currentOffset,
    };

    // Multi-select enums → CSV.
    if (Array.isArray(filters.level) && filters.level.length) {
      params.level = filters.level.join(",");
    }
    if (Array.isArray(filters.resourceType) && filters.resourceType.length) {
      params.resourceType = filters.resourceType.join(",");
    }

    // Text-column filters carry an operator. TableSF stores them as:
    //   plain string         → { value: s, op: "contains" }   (default)
    //   { op: "not-contains", q }
    //   { op: "empty" }
    //   { op: "notempty" }
    // The backend accepts contains | not_contains | empty | is_not_empty.
    function pushText(field, raw) {
      if (raw == null) return;
      if (typeof raw === "string") {
        var v = raw.trim();
        if (!v) return;
        params[field] = v;
        // op defaults to contains; no need to send it explicitly.
      } else if (typeof raw === "object") {
        if (raw.op === "empty") {
          params[field + "Op"] = "empty";
        } else if (raw.op === "notempty") {
          params[field + "Op"] = "is_not_empty";
        } else if (raw.op === "not-contains") {
          var q = (raw.q || "").trim();
          if (!q) return;
          params[field] = q;
          params[field + "Op"] = "not_contains";
        }
      }
    }
    pushText("action", filters.action);
    pushText("resourceName", filters.resourceName);
    pushText("actor", filters.actor);
    pushText("message", filters.message);

    // Date-range filter on the timestamp column maps to since/until.
    if (filters.timestamp && filters.timestamp.type === "date") {
      if (filters.timestamp.from) params.since = filters.timestamp.from + "T00:00:00";
      if (filters.timestamp.to)   params.until = filters.timestamp.to   + "T23:59:59.999";
    }

    // Sort state → sortBy/sortDir. The route whitelists the column set;
    // sortBy=level dispatches to orderBy: { levelRank } server-side.
    if (_eventsSF && _eventsSF._sortKey) {
      params.sortBy = _eventsSF._sortKey;
      params.sortDir = _eventsSF._sortDir === "asc" ? "asc" : "desc";
    }
    return params;
  }

  async function loadEvents() {
    var params = _buildEventsQuery();
    try {
      var data = await api.events.list(params);

      var events = data.events || [];
      currentTotal = data.total || 0;
      _eventsPageSize = pageSize;
      _eventsCurrentOffset = currentOffset;
      _eventsCurrentTotal = currentTotal;
      _eventsCurrentPage = events;
      renderTable(events);
      renderPagination();

      // Refresh the dynamic Resource-column multi-select with the distinct
      // resourceType values seen so far. Merge with the prior set so a value
      // that fell off the current page doesn't disappear from the filter.
      if (_eventsSF) {
        var seen = {};
        _resourceTypeOptions.forEach(function (v) { seen[v] = true; });
        events.forEach(function (ev) {
          if (ev.resourceType) seen[ev.resourceType] = true;
        });
        var sorted = Object.keys(seen).sort();
        if (sorted.length) {
          _resourceTypeOptions = sorted;
          _eventsSF.setColumnOptions("resourceType", sorted);
        }
      }
    } catch (err) {
      document.getElementById("events-tbody").innerHTML =
        '<tr><td colspan="8" class="empty-state">Failed to load events</td></tr>';
    }
  }

  // Wire TableSF on the events table. Server-side mode: never call sf.apply();
  // the onChange callback resets offset to 0 and triggers a fresh fetch with
  // the live filter + sort state translated into API params.
  _eventsSF = new TableSF("events-tbody", function () {
    currentOffset = 0;
    loadEvents();
    _saveEventsPrefs();
  });

  // setupColumnLayout AFTER TableSF: TableSF._setup rebuilds each header th
  // via innerHTML, which would wipe the resize handles setupColumnLayout
  // appends (canonical order — see automations.js).
  var eventsTable = document.querySelector("#events-tbody").closest("table");
  _eventsLayout = setupColumnLayout(eventsTable, {
    onChange: _saveEventsPrefs,
  });

  var prefsReady;
  if (typeof userReady !== "undefined" && userReady && typeof userReady.then === "function") {
    prefsReady = userReady.then(_restoreEventsPrefs);
  } else {
    _restoreEventsPrefs();
    prefsReady = Promise.resolve();
  }

  function renderTable(events) {
    var tbody = document.getElementById("events-tbody");
    if (!events.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No events found</td></tr>';
      return;
    }

    tbody.innerHTML = events.map(function (ev, idx) {
      var ts = new Date(ev.timestamp);
      var timeStr = formatShortDateTime(ts);

      var levelClass = "badge-level-" + (ev.level || "info");
      var levelLabel = (ev.level || "info").toUpperCase();

      // Resource type and resource name are separate columns so each can be
      // filtered on its own (type = multi-select, name = text contains).
      var resourceLabel = ev.resourceType || "-";
      var resourceName = ev.resourceName || "-";

      var detailBtn = ev.details && ev.details.changes
        ? '<button class="btn btn-secondary btn-sm btn-event-detail" data-event-idx="' + idx + '" style="padding:2px 8px;font-size:0.75rem">Detail</button>'
        : '';

      return '<tr>' +
        '<td style="font-family:var(--font-mono);font-size:0.82rem;white-space:nowrap">' + escapeHtml(timeStr) + '</td>' +
        '<td><span class="badge ' + levelClass + '">' + levelLabel + '</span></td>' +
        '<td style="font-family:var(--font-mono);font-size:0.82rem">' + escapeHtml(ev.action || "") + '</td>' +
        '<td>' + escapeHtml(resourceLabel) + '</td>' +
        '<td class="cell-wrap">' + escapeHtml(resourceName) + '</td>' +
        '<td class="cell-wrap">' + escapeHtml(ev.message || "") + '</td>' +
        '<td>' + escapeHtml(ev.actor || "-") + '</td>' +
        '<td>' + detailBtn + '</td>' +
        '</tr>';
    }).join("");

  }

  function renderPagination() {
    var containers = [];
    var mainEl = document.getElementById("pagination");
    if (mainEl) containers.push(mainEl);
    var topEl = document.getElementById("pagination-top");
    if (topEl) containers.push(topEl);
    if (containers.length === 0) return;

    var totalPages = Math.max(1, Math.ceil(currentTotal / pageSize));
    var currentPage = Math.floor(currentOffset / pageSize) + 1;

    // Build page number buttons
    var pageButtons = "";
    var startPage = Math.max(1, currentPage - 2);
    var endPage = Math.min(totalPages, startPage + 4);
    if (endPage - startPage < 4) startPage = Math.max(1, endPage - 4);

    if (startPage > 1) {
      pageButtons += '<button class="btn btn-secondary btn-sm page-btn" data-page="1">1</button>';
      if (startPage > 2) pageButtons += '<span style="color:var(--color-text-tertiary)">...</span>';
    }

    for (var p = startPage; p <= endPage; p++) {
      if (p === currentPage) {
        pageButtons += '<button class="btn btn-primary btn-sm page-btn" data-page="' + p + '" disabled>' + p + '</button>';
      } else {
        pageButtons += '<button class="btn btn-secondary btn-sm page-btn" data-page="' + p + '">' + p + '</button>';
      }
    }

    if (endPage < totalPages) {
      if (endPage < totalPages - 1) pageButtons += '<span style="color:var(--color-text-tertiary)">...</span>';
      pageButtons += '<button class="btn btn-secondary btn-sm page-btn" data-page="' + totalPages + '">' + totalPages + '</button>';
    }

    var html =
      '<button class="btn btn-secondary btn-sm page-prev" ' + (currentPage <= 1 ? 'disabled' : '') + '>&laquo; Prev</button>' +
      pageButtons +
      '<button class="btn btn-secondary btn-sm page-next" ' + (currentPage >= totalPages ? 'disabled' : '') + '>Next &raquo;</button>' +
      '<span style="font-size:0.82rem;color:var(--color-text-tertiary);margin-left:8px">' + currentTotal + ' events</span>';

    containers.forEach(function (container) {
      container.innerHTML = html;
      container.querySelector(".page-prev").addEventListener("click", function () {
        if (currentOffset >= pageSize) {
          currentOffset -= pageSize;
          loadEvents();
        }
      });
      container.querySelector(".page-next").addEventListener("click", function () {
        if (currentOffset + pageSize < currentTotal) {
          currentOffset += pageSize;
          loadEvents();
        }
      });
      container.querySelectorAll(".page-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var page = parseInt(btn.getAttribute("data-page"), 10);
          currentOffset = (page - 1) * pageSize;
          loadEvents();
        });
      });
    });
    // Events renders its own pagination (predates renderPageControls), so the
    // sticky-wrapper re-measure hooked into renderPageControls runs here instead.
    sizeStickyTableWrappers();
  }

  // Page size + Refresh — the only non-TableSF controls left. Every other
  // filter / sort lives on the column headers via TableSF and feeds into
  // loadEvents() through the onTableSFChange callback above.
  document.getElementById("filter-pagesize").addEventListener("change", function () {
    pageSize = parseInt(this.value, 10) || 15;
    _eventsPageSize = pageSize;
    currentOffset = 0;
    loadEvents();
    _saveEventsPrefs();
  });

  document.getElementById("btn-refresh").addEventListener("click", function () { loadEvents(); });

  // Detail button delegation
  document.getElementById("events-tbody").addEventListener("click", function (e) {
    var btn = e.target.closest(".btn-event-detail");
    if (!btn) return;
    var idx = parseInt(btn.getAttribute("data-event-idx"), 10);
    if (_eventsCurrentPage[idx]) showEventDetail(_eventsCurrentPage[idx]);
  });

  // Settings button
  var settingsBtn = document.getElementById("btn-event-settings");
  if (settingsBtn) settingsBtn.addEventListener("click", openEventSettingsModal);

  // Initial load — wait for restored prefs so pageSize matches the dropdown.
  // Seed the Resource filter's full option set in parallel (independent of the
  // row fetch) so the dropdown lists every resourceType, not just the page's.
  prefsReady.then(loadEvents);
  prefsReady.then(_seedResourceTypeOptions);
})();

// ─── Settings Modal (Tabbed) ────────────────────────────────────────────────

var _activeSettingsTab = "archive";

async function openEventSettingsModal() {
  var archiveDefaults = { enabled: false, protocol: "scp", host: "", port: 22, username: "", password: "", keyPath: "", remotePath: "/var/archive/polaris" };
  var syslogDefaults = { enabled: false, protocol: "udp", host: "", port: 514, facility: "local0", severity: "info", format: "rfc5424", tlsCaPath: "", tlsCertPath: "", tlsKeyPath: "" };
  var retentionDefaults = { retentionDays: 7, minLevel: "info" };
  var alertsDefaults = { staleAfterDays: 60 };

  if (_activeSettingsTab === "assets") _activeSettingsTab = "archive";

  try {
    var results = await Promise.all([
      api.events.getArchiveSettings().catch(function () { return null; }),
      api.events.getSyslogSettings().catch(function () { return null; }),
      api.events.getRetentionSettings().catch(function () { return null; }),
      api.reservations.getStaleSettings().catch(function () { return null; }),
    ]);
    if (results[0]) {
      var s = results[0];
      archiveDefaults.enabled = s.enabled || false;
      archiveDefaults.protocol = s.protocol || "scp";
      archiveDefaults.host = s.host || "";
      archiveDefaults.port = s.port || 22;
      archiveDefaults.username = s.username || "";
      archiveDefaults.password = s.password || "";
      archiveDefaults.keyPath = s.keyPath || "";
      archiveDefaults.remotePath = s.remotePath || "/var/archive/polaris";
    }
    if (results[1]) {
      var sl = results[1];
      syslogDefaults.enabled = sl.enabled || false;
      syslogDefaults.protocol = sl.protocol || "udp";
      syslogDefaults.host = sl.host || "";
      syslogDefaults.port = sl.port || 514;
      syslogDefaults.facility = sl.facility || "local0";
      syslogDefaults.severity = sl.severity || "info";
      syslogDefaults.format = sl.format || "rfc5424";
      syslogDefaults.tlsCaPath = sl.tlsCaPath || "";
      syslogDefaults.tlsCertPath = sl.tlsCertPath || "";
      syslogDefaults.tlsKeyPath = sl.tlsKeyPath || "";
    }
    if (results[2]) {
      retentionDefaults.retentionDays = results[2].retentionDays || 7;
      retentionDefaults.minLevel = results[2].minLevel || "info";
    }
    if (results[3]) {
      alertsDefaults.staleAfterDays = typeof results[3].staleAfterDays === "number" ? results[3].staleAfterDays : 60;
    }
  } catch (_) {}

  var body =
    // Tabs
    '<div class="settings-tabs">' +
      '<button class="settings-tab' + (_activeSettingsTab === "archive" ? ' active' : '') + '" data-tab="archive">Archive Export</button>' +
      '<button class="settings-tab' + (_activeSettingsTab === "syslog" ? ' active' : '') + '" data-tab="syslog">Syslog</button>' +
      '<button class="settings-tab' + (_activeSettingsTab === "retention" ? ' active' : '') + '" data-tab="retention">Retention</button>' +
      '<button class="settings-tab' + (_activeSettingsTab === "alerts" ? ' active' : '') + '" data-tab="alerts">Alerts</button>' +
    '</div>' +
    // Archive tab panel
    '<div class="settings-tab-panel' + (_activeSettingsTab === "archive" ? ' active' : '') + '" id="tab-archive">' +
      archiveFormHTML(archiveDefaults) +
    '</div>' +
    // Syslog tab panel
    '<div class="settings-tab-panel' + (_activeSettingsTab === "syslog" ? ' active' : '') + '" id="tab-syslog">' +
      syslogFormHTML(syslogDefaults) +
    '</div>' +
    // Retention tab panel
    '<div class="settings-tab-panel' + (_activeSettingsTab === "retention" ? ' active' : '') + '" id="tab-retention">' +
      retentionFormHTML(retentionDefaults) +
    '</div>' +
    // Alerts tab panel
    '<div class="settings-tab-panel' + (_activeSettingsTab === "alerts" ? ' active' : '') + '" id="tab-alerts">' +
      alertsFormHTML(alertsDefaults) +
    '</div>';

  var noTestTab = _activeSettingsTab === "retention" || _activeSettingsTab === "alerts";
  var footer =
    '<div id="settings-footer-left" style="margin-right:auto;display:flex;gap:8px">' +
      '<button class="btn btn-secondary" id="btn-settings-test"' + (noTestTab ? ' style="display:none"' : '') + '>Test Connection</button>' +
    '</div>' +
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-settings-save">Save</button>';

  openModal("Event Settings", body, footer);

  // Tab switching
  document.querySelectorAll(".settings-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      var target = tab.getAttribute("data-tab");
      _activeSettingsTab = target;
      document.querySelectorAll(".settings-tab").forEach(function (t) { t.classList.remove("active"); });
      document.querySelectorAll(".settings-tab-panel").forEach(function (p) { p.classList.remove("active"); });
      tab.classList.add("active");
      document.getElementById("tab-" + target).classList.add("active");
      var testBtn = document.getElementById("btn-settings-test");
      if (testBtn) testBtn.style.display = (target === "retention" || target === "alerts") ? "none" : "";
      updateSyslogTlsVisibility();
    });
  });

  // Syslog protocol change → toggle TLS fields + default port
  var sysProto = document.getElementById("f-syslog-protocol");
  if (sysProto) {
    sysProto.addEventListener("change", function () {
      updateSyslogTlsVisibility();
      var portEl = document.getElementById("f-syslog-port");
      if (this.value === "tls" && portEl.value === "514") portEl.value = "6514";
      if (this.value !== "tls" && portEl.value === "6514") portEl.value = "514";
    });
  }
  updateSyslogTlsVisibility();

  // Test Connection
  document.getElementById("btn-settings-test").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    var resultId = _activeSettingsTab === "archive" ? "archive-test-result" : "syslog-test-result";
    var resultEl = document.getElementById(resultId);
    if (resultEl) resultEl.innerHTML = '<span style="color:var(--color-text-tertiary)">Testing connection...</span>';
    try {
      var result;
      if (_activeSettingsTab === "archive") {
        result = await api.events.testArchiveConnection(getArchiveFormData());
      } else {
        result = await api.events.testSyslogConnection(getSyslogFormData());
      }
      if (resultEl) {
        resultEl.innerHTML = result.ok
          ? '<span style="color:var(--color-success)">' + escapeHtml(result.message) + '</span>'
          : '<span style="color:var(--color-danger)">' + escapeHtml(result.message) + '</span>';
      }
    } catch (err) {
      if (resultEl) {
        resultEl.innerHTML = err.name === "AbortError"
          ? '<span style="color:var(--color-text-tertiary)">Test aborted</span>'
          : '<span style="color:var(--color-danger)">' + escapeHtml(err.message) + '</span>';
      }
    } finally {
      btn.disabled = false;
    }
  });

  // Save
  document.getElementById("btn-settings-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      if (_activeSettingsTab === "archive") {
        await api.events.updateArchiveSettings(getArchiveFormData());
        showToast("Archive settings saved");
      } else if (_activeSettingsTab === "syslog") {
        await api.events.updateSyslogSettings(getSyslogFormData());
        showToast("Syslog settings saved");
      } else if (_activeSettingsTab === "retention") {
        await api.events.updateRetentionSettings(getRetentionFormData());
        showToast("Retention settings saved");
      } else if (_activeSettingsTab === "alerts") {
        await api.reservations.updateStaleSettings(getAlertsFormData());
        showToast("Alert settings saved");
      }
      closeModal();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

// ─── Archive Tab Form ───────────────────────────────────────────────────────

function archiveFormHTML(d) {
  return '<div class="form-group">' +
    '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
      '<input type="checkbox" id="f-archive-enabled"' + (d.enabled ? ' checked' : '') + '>' +
      '<span>Enable automatic archive export</span>' +
    '</label>' +
    '<p class="hint">When enabled, events are archived and sent to the remote server before being pruned per the configured retention period.</p>' +
  '</div>' +
  '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
  '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Connection</p>' +
  '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
    '<div class="form-group"><label>Protocol</label>' +
      '<select id="f-archive-protocol">' +
        '<option value="scp"' + (d.protocol === "scp" ? ' selected' : '') + '>SCP</option>' +
        '<option value="sftp"' + (d.protocol === "sftp" ? ' selected' : '') + '>SFTP</option>' +
      '</select>' +
    '</div>' +
    '<div class="form-group"><label>Port</label><input type="number" id="f-archive-port" value="' + escapeHtml(String(d.port)) + '" min="1" max="65535"></div>' +
  '</div>' +
  '<div class="form-group"><label>Host / IP</label><input type="text" id="f-archive-host" value="' + escapeHtml(d.host) + '" placeholder="e.g. archive.corp.local or 10.0.5.100"></div>' +
  '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
  '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Authentication</p>' +
  '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
    '<div class="form-group"><label>Username</label><input type="text" id="f-archive-username" value="' + escapeHtml(d.username) + '" placeholder="e.g. polaris-svc"></div>' +
    '<div class="form-group"><label>Password</label><input type="password" id="f-archive-password" value="' + escapeHtml(d.password) + '" placeholder="Leave blank for key auth"></div>' +
  '</div>' +
  '<div class="form-group"><label>SSH Key Path</label><input type="text" id="f-archive-keypath" value="' + escapeHtml(d.keyPath) + '" placeholder="e.g. /home/polaris/.ssh/id_rsa"><p class="hint">Path on the Polaris server. Used instead of password when provided.</p></div>' +
  '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
  '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Destination</p>' +
  '<div class="form-group"><label>Remote Path</label><input type="text" id="f-archive-remotepath" value="' + escapeHtml(d.remotePath) + '" placeholder="e.g. /var/archive/polaris"><p class="hint">Directory on the remote server where archive files will be stored.</p></div>' +
  '<div id="archive-test-result" style="margin-top:0.5rem"></div>';
}

function getArchiveFormData() {
  return {
    enabled: document.getElementById("f-archive-enabled").checked,
    protocol: document.getElementById("f-archive-protocol").value,
    host: document.getElementById("f-archive-host").value.trim(),
    port: parseInt(document.getElementById("f-archive-port").value, 10) || 22,
    username: document.getElementById("f-archive-username").value.trim(),
    password: document.getElementById("f-archive-password").value,
    keyPath: document.getElementById("f-archive-keypath").value.trim(),
    remotePath: document.getElementById("f-archive-remotepath").value.trim() || "/var/archive/polaris",
  };
}

// ─── Syslog Tab Form ────────────────────────────────────────────────────────

function syslogFormHTML(d) {
  return '<div class="form-group">' +
    '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
      '<input type="checkbox" id="f-syslog-enabled"' + (d.enabled ? ' checked' : '') + '>' +
      '<span>Enable syslog forwarding</span>' +
    '</label>' +
    '<p class="hint">When enabled, events are forwarded to a remote syslog server in real time.</p>' +
  '</div>' +
  '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
  '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Connection</p>' +
  '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
    '<div class="form-group"><label>Protocol</label>' +
      '<select id="f-syslog-protocol">' +
        '<option value="udp"' + (d.protocol === "udp" ? ' selected' : '') + '>UDP</option>' +
        '<option value="tcp"' + (d.protocol === "tcp" ? ' selected' : '') + '>TCP</option>' +
        '<option value="tls"' + (d.protocol === "tls" ? ' selected' : '') + '>TLS (Secure)</option>' +
      '</select>' +
    '</div>' +
    '<div class="form-group"><label>Port</label><input type="number" id="f-syslog-port" value="' + escapeHtml(String(d.port)) + '" min="1" max="65535"></div>' +
  '</div>' +
  '<div class="form-group"><label>Host / IP</label><input type="text" id="f-syslog-host" value="' + escapeHtml(d.host) + '" placeholder="e.g. syslog.corp.local or 10.0.5.200"></div>' +
  '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
  '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Syslog Options</p>' +
  '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
    '<div class="form-group"><label>Facility</label>' +
      '<select id="f-syslog-facility">' +
        syslogFacilityOptions(d.facility) +
      '</select>' +
    '</div>' +
    '<div class="form-group"><label>Minimum Severity</label>' +
      '<select id="f-syslog-severity">' +
        '<option value="info"' + (d.severity === "info" ? ' selected' : '') + '>Info (all events)</option>' +
        '<option value="warning"' + (d.severity === "warning" ? ' selected' : '') + '>Warning and above</option>' +
        '<option value="error"' + (d.severity === "error" ? ' selected' : '') + '>Error only</option>' +
      '</select>' +
    '</div>' +
  '</div>' +
  '<div class="form-group"><label>Message Format</label>' +
    '<select id="f-syslog-format">' +
      '<option value="rfc5424"' + (d.format === "rfc5424" ? ' selected' : '') + '>RFC 5424 (modern)</option>' +
      '<option value="rfc3164"' + (d.format === "rfc3164" ? ' selected' : '') + '>RFC 3164 (BSD/legacy)</option>' +
    '</select>' +
  '</div>' +
  '<div id="syslog-tls-fields">' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">TLS Certificates</p>' +
    '<div class="form-group"><label>CA Certificate Path</label><input type="text" id="f-syslog-tlsca" value="' + escapeHtml(d.tlsCaPath) + '" placeholder="e.g. /etc/polaris/ca.pem"><p class="hint">Certificate authority to verify the syslog server.</p></div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
      '<div class="form-group"><label>Client Certificate</label><input type="text" id="f-syslog-tlscert" value="' + escapeHtml(d.tlsCertPath) + '" placeholder="Optional"></div>' +
      '<div class="form-group"><label>Client Key</label><input type="text" id="f-syslog-tlskey" value="' + escapeHtml(d.tlsKeyPath) + '" placeholder="Optional"></div>' +
    '</div>' +
  '</div>' +
  '<div id="syslog-test-result" style="margin-top:0.5rem"></div>';
}

function syslogFacilityOptions(selected) {
  var facilities = ["local0","local1","local2","local3","local4","local5","local6","local7"];
  return facilities.map(function (f) {
    return '<option value="' + f + '"' + (selected === f ? ' selected' : '') + '>' + f.toUpperCase() + '</option>';
  }).join("");
}

function updateSyslogTlsVisibility() {
  var protoEl = document.getElementById("f-syslog-protocol");
  var tlsFields = document.getElementById("syslog-tls-fields");
  if (protoEl && tlsFields) {
    tlsFields.style.display = protoEl.value === "tls" ? "block" : "none";
  }
}

function getSyslogFormData() {
  return {
    enabled: document.getElementById("f-syslog-enabled").checked,
    protocol: document.getElementById("f-syslog-protocol").value,
    host: document.getElementById("f-syslog-host").value.trim(),
    port: parseInt(document.getElementById("f-syslog-port").value, 10) || 514,
    facility: document.getElementById("f-syslog-facility").value,
    severity: document.getElementById("f-syslog-severity").value,
    format: document.getElementById("f-syslog-format").value,
    tlsCaPath: document.getElementById("f-syslog-tlsca").value.trim(),
    tlsCertPath: document.getElementById("f-syslog-tlscert").value.trim(),
    tlsKeyPath: document.getElementById("f-syslog-tlskey").value.trim(),
  };
}

// ─── Retention Tab Form ─────────────────────────────────────────────────────

function retentionFormHTML(d) {
  return '<div class="form-group">' +
    '<label>Retention Period (days)</label>' +
    '<input type="number" id="f-retention-days" value="' + escapeHtml(String(d.retentionDays)) + '" min="1" max="365" style="max-width:120px">' +
    '<p class="hint">Events older than this many days are automatically deleted. ' +
      'If archive export is enabled, events are archived before being removed. ' +
      'Default is 7 days.</p>' +
  '</div>' +
  '<div class="form-group">' +
    '<label>Minimum Event Level to Retain</label>' +
    '<select id="f-retention-minlevel" style="max-width:300px">' +
      '<option value="info"' + (d.minLevel === "info" ? ' selected' : '') + '>Info — store all events (recommended)</option>' +
      '<option value="warning"' + (d.minLevel === "warning" ? ' selected' : '') + '>Warning — drop info events permanently</option>' +
      '<option value="error"' + (d.minLevel === "error" ? ' selected' : '') + '>Error — drop info and warning events permanently</option>' +
    '</select>' +
    '<p class="hint"><strong>This is a retention filter, not a display filter.</strong> Events below the selected level are never written to the database and cannot be recovered later — they will also be missing from syslog and SFTP archive exports. To hide events from the page without losing the data, use the Level dropdown at the top of the Events page instead. Default is Info (all events stored).</p>' +
  '</div>';
}

function getRetentionFormData() {
  return {
    retentionDays: Math.max(1, parseInt(document.getElementById("f-retention-days").value, 10) || 7),
    minLevel: document.getElementById("f-retention-minlevel").value || "info",
  };
}

// ─── Alerts Tab Form ────────────────────────────────────────────────────────

function alertsFormHTML(d) {
  return '<div class="form-group">' +
    '<label>Stale DHCP reservation threshold (days)</label>' +
    '<input type="number" id="f-alerts-staleAfterDays" value="' + escapeHtml(String(d.staleAfterDays)) + '" min="0" max="3650" style="max-width:120px">' +
    '<p class="hint">Polaris flags a discovered <code>dhcp_reservation</code> as stale when its target client has not been seen within this many days &mdash; counting both DHCP lease activity <em>and</em> network presence of a correlated asset (matched by MAC, then IP), so a statically-addressed device that never pulls a lease but is online stays out of the list. ' +
      'When a row is flagged it appears in the Alerts panel and a one-time <code>reservation.stale</code> Event is written to the audit log. ' +
      'Set to <strong>0</strong> to disable stale-reservation detection entirely. Default is 60 days.</p>' +
    '<p class="hint" style="color:var(--color-text-tertiary)">A reservation re-arms automatically: if discovery sees the IP active again, the alert is cleared and a future stretch of inactivity will fire one fresh notification rather than being suppressed by the prior one.</p>' +
  '</div>';
}

function getAlertsFormData() {
  return {
    staleAfterDays: Math.max(0, parseInt(document.getElementById("f-alerts-staleAfterDays").value, 10) || 0),
  };
}

/* ─── Conflict Resolution Panel ──────────────────────────────────────────── */

(function () {
  var overlay = document.getElementById("conflict-overlay");
  var panel = document.getElementById("conflict-panel");
  var closeBtn = document.getElementById("conflict-panel-close");
  var filterSel = document.getElementById("conflict-panel-filter");
  var body = document.getElementById("conflict-panel-body");
  var countEl = document.getElementById("conflict-panel-count");
  var badge = document.getElementById("conflict-badge");
  var btn = document.getElementById("btn-conflicts");
  if (!btn || !overlay) return;

  // Load pending count for badge on page load
  async function refreshBadge() {
    try {
      var data = await api.conflicts.count();
      var n = data.count || 0;
      if (n > 0) {
        badge.textContent = n > 99 ? "99+" : String(n);
        badge.style.display = "block";
      } else {
        badge.style.display = "none";
      }
      if (typeof window.refreshConflictDot === "function") window.refreshConflictDot();
    } catch (_) {}
  }
  refreshBadge();

  function openPanel() {
    overlay.classList.add("open");
    loadConflicts();
  }

  function closePanel() {
    overlay.classList.remove("open");
    refreshBadge();
  }

  btn.addEventListener("click", openPanel);
  closeBtn.addEventListener("click", closePanel);
  overlay.addEventListener("click", function (e) { if (e.target === overlay) closePanel(); });
  filterSel.addEventListener("change", loadConflicts);

  async function loadConflicts(silent) {
    if (!silent) body.innerHTML = '<div class="empty-state" style="padding:2rem">Loading...</div>';
    try {
      var status = filterSel.value;
      var data = await api.conflicts.list({ status: status, limit: 5000 });
      var conflicts = data.conflicts || [];
      countEl.textContent = conflicts.length + " conflict" + (conflicts.length !== 1 ? "s" : "") + (status !== "all" ? " (" + status + ")" : "");
      if (!conflicts.length) {
        body.innerHTML = '<div class="empty-state" style="padding:2rem">No conflicts found.</div>';
        return;
      }
      body.innerHTML = conflicts.map(function (c) { return renderConflictCard(c); }).join("");

      // Per-row winner pickers (asset conflicts only). Toggling a pill updates
      // the winning side's highlight in the same row.
      body.querySelectorAll("[data-conflict-winner]").forEach(function (el) {
        el.addEventListener("click", function () {
          var row = el.closest("tr");
          if (!row) return;
          var side = el.getAttribute("data-conflict-winner");
          row.setAttribute("data-winner", side);
          row.querySelectorAll("[data-conflict-winner]").forEach(function (b) {
            b.classList.toggle("is-active", b.getAttribute("data-conflict-winner") === side);
          });
        });
      });

      // Duplicate-IP conflicts: per-asset "give this one a new address". The
      // input lives in the same row; Enter submits it like the button does.
      body.querySelectorAll("[data-dupip-apply]").forEach(function (el) {
        var conflictId = el.getAttribute("data-conflict-id");
        var assetId = el.getAttribute("data-asset-id");
        var row = el.closest("tr");
        var input = row ? row.querySelector("[data-dupip-input]") : null;
        var apply = async function () {
          var value = input ? input.value.trim() : "";
          if (!value) {
            showToast("Enter the new IP address for this asset", "error");
            if (input) input.focus();
            return;
          }
          el.disabled = true;
          if (input) input.disabled = true;
          try {
            var out = await api.conflicts.reassignIp(conflictId, { assetId: assetId, ipAddress: value });
            showToast(out && out.resolved
              ? "Address updated — duplicate resolved"
              : "Address updated — " + ((out && out.remaining) || 0) + " assets still share the old address");
            var scrollTop = body.scrollTop;
            await loadConflicts(true);
            body.scrollTop = scrollTop;
            refreshBadge();
          } catch (err) {
            showToast(err.message, "error");
            el.disabled = false;
            if (input) input.disabled = false;
          }
        };
        el.addEventListener("click", apply);
        if (input) {
          input.addEventListener("keydown", function (e) {
            if (e.key === "Enter") { e.preventDefault(); apply(); }
          });
        }
      });

      // Duplicate-IP conflicts, the other cause: one device recorded twice.
      // "Merge into this" keeps the clicked row and absorbs the rest through the
      // operator merge engine. Destructive and irreversible, so the confirm
      // NAMES every record that will be deleted rather than counting them, and
      // points at the asset page's Merge modal for per-field control.
      body.querySelectorAll("[data-dupip-merge]").forEach(function (el) {
        var conflictId = el.getAttribute("data-conflict-id");
        var survivorId = el.getAttribute("data-asset-id");
        el.addEventListener("click", async function () {
          var card = el.closest(".conflict-card");
          var rows = card ? Array.prototype.slice.call(card.querySelectorAll("[data-dupip-merge]")) : [];
          var others = rows
            .map(function (b) {
              return {
                id: b.getAttribute("data-asset-id"),
                label: (b.closest("tr") || {}).firstElementChild
                  ? b.closest("tr").firstElementChild.textContent.trim()
                  : b.getAttribute("data-asset-id"),
              };
            })
            .filter(function (r) { return r.id && r.id !== survivorId; });
          if (!others.length) { showToast("Nothing to merge — only one asset on this address", "error"); return; }
          var survivorLabel = (el.closest("tr") && el.closest("tr").firstElementChild)
            ? el.closest("tr").firstElementChild.textContent.trim()
            : survivorId;

          // showConfirm renders with white-space:pre-wrap, so the line breaks
          // below survive into the dialog.
          var msg = [
            'Merge into "' + survivorLabel + '"?',
            "",
            "These records will be absorbed and then DELETED:",
            others.map(function (o) { return "  • " + o.label; }).join("\n"),
            "",
            'Their sources, MACs, IP history, sightings and dependency links move to "' +
              survivorLabel + '"; their monitoring history is permanently lost. ' +
              "Only do this if they are the same physical device.",
            "",
            "For per-field control over which values survive, use Merge on the asset's Sources tab instead.",
          ].join("\n");
          var ok = typeof showConfirm === "function" ? await showConfirm(msg) : window.confirm(msg);
          if (!ok) return;

          el.disabled = true;
          try {
            var out = await api.conflicts.merge(conflictId, {
              survivorAssetId: survivorId,
              absorbAssetIds: others.map(function (o) { return o.id; }),
            });
            showToast(out && out.resolved
              ? "Merged — duplicate resolved, moved " + ((out && out.movedSources) || 0) + " source(s)"
              : "Merged — " + ((out && out.remaining) || 0) + " assets still share the address");
            var scrollTop = body.scrollTop;
            await loadConflicts(true);
            body.scrollTop = scrollTop;
            refreshBadge();
          } catch (err) {
            showToast(err.message, "error");
            el.disabled = false;
          }
        });
      });

      // Chassis-replacement: load the per-address diff on demand. It is a
      // separate read because discovery syncs subnets in Phase 1 and
      // reservations in Phases 3–5, so it cannot be snapshotted at raise time
      // without comparing the old chassis against itself.
      body.querySelectorAll("[data-chassis-diff]").forEach(function (el) {
        el.addEventListener("click", async function () {
          var id = el.getAttribute("data-chassis-diff");
          var panel = body.querySelector('[data-chassis-diff-panel="' + id + '"]');
          if (!panel) return;
          if (panel.innerHTML) { panel.innerHTML = ""; el.textContent = "Review reservations"; return; }
          el.disabled = true;
          try {
            var res = await api.conflicts.chassisDiff(id);
            panel.innerHTML = renderChassisDiffPanel(id, res.lines || []);
            el.textContent = "Hide reservations";
            bindChassisMigrate(body, panel);
          } catch (err) {
            showToast(err.message, "error");
          } finally {
            el.disabled = false;
          }
        });
      });

      // Bind accept/reject/merge buttons
      body.querySelectorAll("[data-conflict-action]").forEach(function (el) {
        el.addEventListener("click", async function () {
          var id = el.getAttribute("data-conflict-id");
          var action = el.getAttribute("data-conflict-action");
          el.disabled = true;
          try {
            var kind = el.getAttribute("data-conflict-kind");
            if (action === "accept") {
              await api.conflicts.accept(id);
              showToast(kind === "subnet"
                ? "New FortiGate chassis adopted for this network"
                : "Conflict accepted — discovered values applied");
            } else if (action === "merge") {
              var card = el.closest(".conflict-card");
              var fieldWinners = {};
              if (card) {
                card.querySelectorAll("tr[data-winner][data-field]").forEach(function (row) {
                  var field = row.getAttribute("data-field");
                  var winner = row.getAttribute("data-winner");
                  if (field && (winner === "existing" || winner === "proposed")) {
                    fieldWinners[field] = winner;
                  }
                });
              }
              await api.conflicts.merge(id, { fieldWinners: fieldWinners });
              showToast("Conflict merged with selected values");
            } else {
              await api.conflicts.reject(id);
              showToast(kind === "subnet"
                ? "Dismissed — this chassis change won't be reported again"
                : "Conflict rejected — existing values kept");
            }
            var scrollTop = body.scrollTop;
            await loadConflicts(true);
            body.scrollTop = scrollTop;
            refreshBadge();
          } catch (err) {
            showToast(err.message, "error");
            el.disabled = false;
          }
        });
      });
    } catch (err) {
      body.innerHTML = '<div class="empty-state" style="padding:2rem;color:var(--color-danger)">' + escapeHtml(err.message) + '</div>';
    }
  }

  // Resolved-status markup shared by both conflict card variants: a
  // colored Accepted/Rejected badge, the resolver, and the resolve time.
  function resolvedActionsHtml(c) {
    var statusClass = c.status === "accepted"
      ? "badge-active"
      : (c.status === "rejected" ? "badge-conflict" : "badge-" + c.status);
    var meta = "";
    if (c.resolvedBy) meta += " by " + escapeHtml(c.resolvedBy);
    if (c.resolvedAt) {
      var ts = new Date(c.resolvedAt);
      meta += " · " + ts.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
        " " + ts.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    }
    return '<span class="badge ' + statusClass + '" style="text-transform:capitalize">' + escapeHtml(c.status) + '</span>' +
      (meta ? ' <span style="color:var(--color-text-tertiary);font-size:0.75rem">' + meta + '</span>' : '');
  }

  function sourceBadgeClass(sourceType) {
    if (!sourceType) return "badge-source-device";
    if (sourceType === "vip") return "badge-source-vip";
    if (sourceType.startsWith("dhcp")) return "badge-source-dhcp";
    if (sourceType === "interface_ip") return "badge-source-interface";
    return "badge-source-device";
  }

  function sourceLabel(sourceType) {
    var map = {
      vip: "VIP", dhcp_reservation: "DHCP Reservation", dhcp_lease: "DHCP Lease",
      interface_ip: "Interface IP", fortiswitch: "FortiSwitch", fortinap: "FortiAP",
      fortimanager: "FortiManager", manual: "Manual",
    };
    return map[sourceType] || sourceType || "Unknown";
  }

  function renderConflictCard(c) {
    if (c.entityType === "asset") return renderAssetConflictCard(c);
    if (c.entityType === "subnet") return renderSubnetConflictCard(c);
    return renderReservationConflictCard(c);
  }

  // Copy the checked addresses onto the new gate. Deliberately does NOT close
  // the conflict — an operator may copy a few, look again, and copy more — so
  // the panel is reloaded rather than the whole list.
  function bindChassisMigrate(body, panel) {
    var btn = panel.querySelector("[data-chassis-migrate]");
    if (!btn) return;
    btn.addEventListener("click", async function () {
      var id = btn.getAttribute("data-chassis-migrate");
      var ips = Array.prototype.slice
        .call(panel.querySelectorAll("[data-chassis-ip]"))
        .filter(function (cb) { return cb.checked; })
        .map(function (cb) { return cb.getAttribute("data-chassis-ip"); });
      if (!ips.length) { showToast("Select at least one address to copy", "error"); return; }
      btn.disabled = true;
      try {
        var out = await api.conflicts.migrateReservations(id, { ips: ips });
        var msg = "Copied " + (out.created + out.updated) + " reservation(s) to the new gate";
        if (out.queuedForPush) msg += " — " + out.queuedForPush + " queued for push";
        if (out.skipped && out.skipped.length) msg += "; " + out.skipped.length + " skipped";
        showToast(msg);
        var res = await api.conflicts.chassisDiff(id);
        panel.innerHTML = renderChassisDiffPanel(id, res.lines || []);
        bindChassisMigrate(body, panel);
      } catch (err) {
        showToast(err.message, "error");
        btn.disabled = false;
      }
    });
  }

  // Subnet chassis-replacement conflict (business rule 41): the FortiGate
  // serving this subnet answered with a serial that is neither the stored one
  // nor any member of its HA cluster, so the physical box was swapped.
  //
  // This renderer exists because the dispatcher above falls through to the
  // RESERVATION card for any non-asset entity type. A subnet conflict has no
  // `c.reservation`, so it came out as a blank "(full subnet)" card with four
  // dashes and two working buttons — an operator told nothing about what
  // happened, but able to resolve it anyway.
  //
  // The per-address migration picker is loaded on demand (the diff is a
  // separate read — see GET /conflicts/:id/chassis-diff), so the card starts
  // as the identity summary and expands.
  function renderSubnetConflictCard(c) {
    var p = c.proposedSubnetFields || {};
    var subnet = c.subnet || {};
    var isResolved = c.status !== "pending";
    var cidr = p.cidr || subnet.cidr || "(unknown subnet)";
    var dash = '<span style="color:var(--color-text-tertiary);font-style:italic">—</span>';
    var val = function (v) { return v ? escapeHtml(String(v)) : dash; };

    var rows = [
      ["Chassis serial", val(p.oldSerial), "<strong>" + val(p.newSerial) + "</strong>"],
      ["FortiGate name", val(p.oldDeviceName), val(p.newDeviceName)],
    ].map(function (r) {
      return '<tr><td class="conflict-field">' + r[0] + '</td><td>' + r[1] + '</td><td>' + r[2] + '</td></tr>';
    }).join("");

    var actions = isResolved
      ? resolvedActionsHtml(c)
      : '<button class="btn btn-secondary btn-sm" data-conflict-action="reject" data-conflict-id="' + c.id + '" data-conflict-kind="subnet">Dismiss</button>' +
        '<button class="btn btn-secondary btn-sm" data-chassis-diff="' + c.id + '">Review reservations</button>' +
        '<button class="btn btn-primary btn-sm" data-conflict-action="accept" data-conflict-id="' + c.id + '" data-conflict-kind="subnet">Adopt new chassis</button>';

    return '<div class="conflict-card">' +
      '<div class="conflict-card-header">' +
        '<span class="badge badge-conflict">Chassis replaced</span>' +
        '<strong>' + escapeHtml(cidr) + '</strong>' +
        '<span class="conflict-card-subnet">' + escapeHtml(subnet.name || "") + '</span>' +
      '</div>' +
      '<div style="padding:0.5rem 0.75rem;color:var(--color-text-secondary);font-size:0.8125rem">' +
        'A different FortiGate now serves this network. Its previous reservations are ' +
        'archived — nothing was changed or removed.' +
      '</div>' +
      '<div class="conflict-table" style="padding:0">' +
        '<table><thead><tr>' +
          '<th class="conflict-field">Field</th>' +
          '<th>Previous gate</th>' +
          '<th>Now serving</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>' +
      '</div>' +
      '<div data-chassis-diff-panel="' + c.id + '"></div>' +
      '<div class="conflict-card-actions">' + actions + '</div>' +
    '</div>';
  }

  // The archived old chassis's reservations against what the new gate reports.
  // Only `manual` / `dhcp_reservation` lines can be carried forward; the rest
  // are shown with why, because hiding one leaves an operator hunting for an
  // address they remember.
  var CHASSIS_REFUSAL_LABEL = {
    "device-owned": "on the device",
    "observed": "observed only",
    "device-managed": "managed device",
  };

  function renderChassisDiffPanel(id, lines) {
    if (!lines.length) {
      return '<div style="padding:0.5rem 0.75rem;color:var(--color-text-tertiary);font-size:0.8125rem">' +
        'Neither gate reports any reservations for this network.</div>';
    }
    var verdictLabel = {
      "only-old": "Missing on the new gate",
      "only-new": "New gate only",
      "differs": "Differs",
      "same": "Matches",
    };
    var rows = lines.map(function (l) {
      var ip = l.ip || "(full subnet)";
      var pick = l.migratable
        ? '<input type="checkbox" data-chassis-ip="' + escapeHtml(ip) + '"' +
          (l.verdict === "only-old" || l.verdict === "differs" ? " checked" : "") + ">"
        : '<span style="color:var(--color-text-tertiary);font-size:0.75rem">' +
          escapeHtml(CHASSIS_REFUSAL_LABEL[l.notMigratableReason] || "—") + "</span>";
      var oldSide = l.old ? escapeHtml(l.old.hostname || l.old.ipAddress || "") : "—";
      var newSide = l.new ? escapeHtml(l.new.hostname || l.new.ipAddress || "") : "—";
      return "<tr><td>" + pick + "</td><td><strong>" + escapeHtml(ip) + "</strong></td>" +
        "<td>" + oldSide + "</td><td>" + newSide + "</td>" +
        '<td style="font-size:0.75rem;color:var(--color-text-secondary)">' +
        escapeHtml(verdictLabel[l.verdict] || l.verdict) + "</td></tr>";
    }).join("");

    return '<div class="conflict-table" style="padding:0">' +
      '<table><thead><tr><th style="width:34px"></th><th>Address</th>' +
      "<th>Previous gate</th><th>Now serving</th><th>Status</th></tr></thead>" +
      "<tbody>" + rows + "</tbody></table></div>" +
      '<div style="padding:0.5rem 0.75rem;display:flex;gap:0.5rem;align-items:center">' +
      '<button class="btn btn-primary btn-sm" data-chassis-migrate="' + escapeHtml(id) + '">Copy selected to the new gate</button>' +
      '<span style="color:var(--color-text-tertiary);font-size:0.75rem">' +
      "Copied reservations are queued for push when DHCP push is enabled." +
      "</span></div>";
  }

  function renderReservationConflictCard(c) {
    var res = c.reservation || {};
    var subnet = res.subnet || {};
    var ip = res.ipAddress || "(full subnet)";
    var subnetLabel = subnet.cidr || "";
    if (subnet.name) subnetLabel += " — " + subnet.name;
    var isResolved = c.status !== "pending";

    var fields = ["hostname", "owner", "projectRef", "notes"];
    var rows = fields.map(function (f) {
      var existingVal = res[f] || null;
      var proposedKey = "proposed" + f.charAt(0).toUpperCase() + f.slice(1);
      var proposedVal = c[proposedKey] || null;
      var changed = (c.conflictFields || []).includes(f);
      return '<tr class="' + (changed ? "conflict-changed" : "") + '">' +
        '<td class="conflict-field">' + formatFieldName(f) + '</td>' +
        '<td>' + (existingVal ? escapeHtml(existingVal) : '<span style="color:var(--color-text-tertiary);font-style:italic">—</span>') + '</td>' +
        '<td>' + (proposedVal ? (changed ? '<strong>' + escapeHtml(proposedVal) + '</strong>' : escapeHtml(proposedVal)) : '<span style="color:var(--color-text-tertiary);font-style:italic">—</span>') + '</td>' +
        '</tr>';
    }).join("");

    var actions = isResolved
      ? resolvedActionsHtml(c)
      : '<button class="btn btn-secondary btn-sm" data-conflict-action="reject" data-conflict-id="' + c.id + '">Reject</button>' +
        '<button class="btn btn-primary btn-sm" data-conflict-action="accept" data-conflict-id="' + c.id + '">Accept</button>';

    return '<div class="conflict-card">' +
      '<div class="conflict-card-header">' +
        '<span class="badge ' + sourceBadgeClass(c.proposedSourceType) + '">' + escapeHtml(sourceLabel(c.proposedSourceType)) + '</span>' +
        '<strong>' + escapeHtml(ip) + '</strong>' +
        '<span class="conflict-card-subnet">' + escapeHtml(subnetLabel) + '</span>' +
      '</div>' +
      '<div class="conflict-table" style="padding:0">' +
        '<table><thead><tr>' +
          '<th class="conflict-field">Field</th>' +
          '<th>Current (Manual)</th>' +
          '<th>Discovered</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '</table>' +
      '</div>' +
      '<div class="conflict-card-actions">' + actions + '</div>' +
    '</div>';
  }

  // IP-override conflict: a discovery write proposed an IP that differs from
  // the asset's operator IP pin (Asset.ipOverride). Single-field card with
  // plain Accept/Reject — no per-field merge picker. Accept adopts the
  // discovered address and releases the pin; Reject keeps the pin (the same
  // discovered address won't re-raise).
  function renderIpOverrideConflictCard(c) {
    var existing = c.existingAssetSnapshot || c.asset || {};
    var proposed = c.proposedAssetFields || {};
    var isResolved = c.status !== "pending";
    var pinned = proposed.overrideIp || existing.ipOverride || existing.ipAddress || null;
    var discovered = proposed.ipAddress || null;
    var hostLabel = existing.hostname || proposed.hostname || "(asset)";

    var rows =
      '<tr class="conflict-changed">' +
        '<td class="conflict-field">IP Address</td>' +
        '<td>' + (pinned ? '<span class="mono">' + escapeHtml(pinned) + '</span>' : '<span style="color:var(--color-text-tertiary);font-style:italic">—</span>') + '</td>' +
        '<td>' + (discovered ? '<strong class="mono">' + escapeHtml(discovered) + '</strong>' : '<span style="color:var(--color-text-tertiary);font-style:italic">—</span>') + '</td>' +
      '</tr>';

    var explainer = 'IP override conflict — discovery reports a different address' +
      (proposed.ipSource ? ' (via ' + escapeHtml(proposed.ipSource) + ')' : '') +
      ' than this asset\'s manually pinned IP. <strong>Accept</strong> to adopt the discovered address and release the override; <strong>Reject</strong> to keep the pinned address (the same discovered address won\'t re-raise, but a new one will).';

    var actions = isResolved
      ? resolvedActionsHtml(c)
      : '<button class="btn btn-secondary btn-sm" data-conflict-action="reject" data-conflict-id="' + c.id + '" title="Keep the pinned address">Reject (keep override)</button>' +
        '<button class="btn btn-primary btn-sm" data-conflict-action="accept" data-conflict-id="' + c.id + '" title="Adopt the discovered address and release the override">Accept discovered IP</button>';

    return '<div class="conflict-card">' +
      '<div class="conflict-card-header">' +
        '<span class="badge badge-warning">IP Override</span>' +
        '<strong>' + escapeHtml(hostLabel) + '</strong>' +
        (pinned ? '<span class="conflict-card-subnet" style="font-family:var(--font-mono);font-size:0.78rem">pinned ' + escapeHtml(pinned) + '</span>' : '') +
      '</div>' +
      '<div style="padding:6px 14px;font-size:0.78rem;color:var(--color-text-secondary)">' + explainer + '</div>' +
      '<div class="conflict-table" style="padding:0">' +
        '<table><thead><tr>' +
          '<th class="conflict-field">Field</th>' +
          '<th>Pinned (Manual Override)</th>' +
          '<th>Discovered</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '</table>' +
      '</div>' +
      '<div class="conflict-card-actions">' + actions + '</div>' +
    '</div>';
  }

  // Duplicate-address conflict (business rule 40): N network-present assets
  // recording ONE ipAddress. There is nothing to accept — the resolution is to
  // give one of them a different address — so the card renders a per-asset
  // "new IP" field instead of the winner pickers, plus Dismiss.
  function renderDuplicateIpConflictCard(c) {
    var proposed = c.proposedAssetFields || {};
    var ip = proposed.ipAddress || "—";
    var members = Array.isArray(proposed.members) ? proposed.members : [];
    var isResolved = c.status !== "pending";

    var rows = members.map(function (m) {
      var name = m.hostname || m.assetId || "(unnamed)";
      var link = m.assetId
        ? '<a href="/assets.html#view=asset:' + encodeURIComponent(m.assetId) + '">' + escapeHtml(name) + '</a>'
        : escapeHtml(name);
      var claimBits = [];
      if (m.pinned) claimBits.push("pinned by operator");
      else if (m.ipSource) claimBits.push("via " + m.ipSource);
      var confirmed = m.ipLastSeen || m.lastSeen;
      if (confirmed) claimBits.push("confirmed " + timeAgo(confirmed));
      var claim = claimBits.length
        ? escapeHtml(claimBits.join(" · "))
        : '<span style="color:var(--color-text-tertiary);font-style:italic">unknown</span>';
      var newIpCell = isResolved
        ? '<td></td>'
        : '<td style="white-space:nowrap">' +
            '<input type="text" class="form-input" style="width:150px;display:inline-block" ' +
              'placeholder="new IP address" data-dupip-input="' + escapeHtml(m.assetId || "") + '">' +
            ' <button class="btn btn-primary btn-sm" data-dupip-apply data-conflict-id="' + c.id + '" ' +
              'data-asset-id="' + escapeHtml(m.assetId || "") + '" ' +
              'title="Assign this address to ' + escapeHtml(name) + ' and pin it">Apply</button>' +
          '</td>';
      // The other cause of a shared address: one device recorded twice. Keeping
      // THIS row absorbs the others through the same merge engine the asset
      // page's Merge modal uses.
      var mergeCell = isResolved
        ? '<td></td>'
        : '<td style="white-space:nowrap">' +
            '<button class="btn btn-secondary btn-sm" data-dupip-merge data-conflict-id="' + c.id + '" ' +
              'data-asset-id="' + escapeHtml(m.assetId || "") + '" ' +
              'title="These records are the same device — keep ' + escapeHtml(name) + ' and absorb the other' +
              (members.length > 2 ? 's' : '') + '">Merge into this</button>' +
          '</td>';
      return '<tr class="conflict-changed">' +
        '<td class="conflict-field">' + link + '</td>' +
        '<td>' + escapeHtml(m.assetType || "—") + '</td>' +
        '<td>' + escapeHtml(m.status || "—") + (m.monitored ? "" : ' <span style="color:var(--color-text-tertiary);font-size:0.7rem">(unmonitored)</span>') + '</td>' +
        '<td style="font-size:0.75rem">' + claim + '</td>' +
        newIpCell +
        mergeCell +
        '</tr>';
    }).join("");

    var explainer = '<strong class="mono">' + escapeHtml(ip) + '</strong> is recorded on ' +
      members.length + ' assets that are all in a network-present status. Two devices, or one device ' +
      'recorded twice — resolve it whichever way it actually is. ' +
      '<strong>Two devices:</strong> enter a new address on the row of whichever one should move; it is saved ' +
      'as a manual pin (discovery reporting the same address later releases the pin by itself). ' +
      '<strong>One device:</strong> use <em>Merge into this</em> on the record to keep — the other' +
      (members.length > 2 ? 's are' : ' is') + ' absorbed into it and deleted. ' +
      '<strong>Reject</strong> dismisses the conflict and changes nothing; the same set will not re-raise, ' +
      'a changed one will.';

    var actions = isResolved
      ? resolvedActionsHtml(c)
      : '<button class="btn btn-secondary btn-sm" data-conflict-action="reject" data-conflict-id="' + c.id + '" title="Keep both records on this address">Reject (dismiss)</button>';

    return '<div class="conflict-card">' +
      '<div class="conflict-card-header">' +
        '<span class="badge badge-conflict">Duplicate IP</span>' +
        '<strong>' + escapeHtml(ip) + '</strong>' +
        '<span class="conflict-card-subnet" style="font-size:0.78rem">' + members.length + ' assets</span>' +
      '</div>' +
      '<div style="padding:6px 14px;font-size:0.78rem;color:var(--color-text-secondary)">' + explainer + '</div>' +
      '<div class="conflict-table" style="padding:0">' +
        '<table><thead><tr>' +
          '<th class="conflict-field">Asset</th>' +
          '<th>Type</th>' +
          '<th>Status</th>' +
          '<th>Address claim</th>' +
          '<th>' + (isResolved ? '' : 'New IP address') + '</th>' +
          '<th>' + (isResolved ? '' : 'Same device') + '</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '</table>' +
      '</div>' +
      '<div class="conflict-card-actions">' + actions + '</div>' +
    '</div>';
  }

  function renderAssetConflictCard(c) {
    var proposedKind = c.proposedAssetFields || {};
    if (proposedKind.collisionReason === "ip-override") return renderIpOverrideConflictCard(c);
    if (proposedKind.collisionReason === "duplicate-ip") return renderDuplicateIpConflictCard(c);
    // Prefer the conflict-time snapshot of the existing asset so a resolved
    // card shows what the asset looked like when the conflict was raised, not
    // the post-merge live row. Conflicts predating the snapshot column fall
    // back to the live asset relation.
    var existing = c.existingAssetSnapshot || c.asset || {};
    var proposed = c.proposedAssetFields || {};
    var isResolved = c.status !== "pending";

    var fields = [
      ["hostname", "Hostname"],
      ["serialNumber", "Serial"],
      ["macAddress", "MAC"],
      ["ipAddress", "IP"],
      ["manufacturer", "Manufacturer"],
      ["model", "Model"],
      ["os", "OS"],
      ["osVersion", "OS Version"],
      ["assignedTo", "Primary User"],
    ];

    // os/osVersion default to proposed-wins on Accept (authoritative from
    // Entra/AD). Never highlight them as a conflict — just informational.
    // ipAddress isn't written by the merge path; show it read-only.
    var autoUpdateFields = new Set(["os", "osVersion"]);
    var readOnlyFields = new Set(["ipAddress"]);
    // Default winner per row matches today's accept logic so an
    // untouched merge produces the same result as Accept.
    var existingHostLower = (existing.hostname || "").toLowerCase();
    var proposedHostLower = (proposed.hostname || "").toLowerCase();
    var isNetbiosUpgrade =
      proposed.matchedVia === "netbios" &&
      proposedHostLower.length > existingHostLower.length &&
      existingHostLower.length > 0 &&
      proposedHostLower.indexOf(existingHostLower) === 0;
    var defaultWinnerFor = function (key, existingVal, proposedVal) {
      if (key === "hostname") {
        return ((!existingVal && proposedVal) || isNetbiosUpgrade) ? "proposed" : "existing";
      }
      if (key === "os" || key === "osVersion") return "proposed";
      return (!existingVal && proposedVal) ? "proposed" : "existing";
    };
    var isResolvedForRows = c.status !== "pending";
    var rows = fields.map(function (pair) {
      var key = pair[0], label = pair[1];
      var existingVal = existing[key] || null;
      var proposedVal = proposed[key] || null;
      var differs = !autoUpdateFields.has(key) && existingVal && proposedVal && String(existingVal).toLowerCase() !== String(proposedVal).toLowerCase();
      var autoUpdate = autoUpdateFields.has(key) && proposedVal && String(existingVal || "").toLowerCase() !== String(proposedVal).toLowerCase();
      var readOnly = readOnlyFields.has(key);
      var winner = defaultWinnerFor(key, existingVal, proposedVal);
      var rowAttrs = readOnly || isResolvedForRows
        ? ''
        : ' data-field="' + escapeHtml(key) + '" data-winner="' + winner + '"';
      var existingCellClass = winner === "existing" ? "conflict-winner-cell" : "conflict-loser-cell";
      var proposedCellClass = winner === "proposed" ? "conflict-winner-cell" : "conflict-loser-cell";
      // Picker cell — hidden for read-only fields and for resolved conflicts.
      var pickerCell;
      if (readOnly) {
        pickerCell = '<td class="conflict-picker"><span style="color:var(--color-text-tertiary);font-size:0.7rem">read-only</span></td>';
      } else if (isResolvedForRows) {
        pickerCell = '<td class="conflict-picker"></td>';
      } else {
        pickerCell = '<td class="conflict-picker">' +
          '<button type="button" class="conflict-winner-btn' + (winner === "existing" ? " is-active" : "") + '" data-conflict-winner="existing" title="Keep current value">◀</button>' +
          '<button type="button" class="conflict-winner-btn' + (winner === "proposed" ? " is-active" : "") + '" data-conflict-winner="proposed" title="Use discovered value">▶</button>' +
          '</td>';
      }
      return '<tr class="' + (differs ? "conflict-changed" : "") + '"' + rowAttrs + '>' +
        '<td class="conflict-field">' + escapeHtml(label) + (autoUpdate ? ' <span style="color:var(--color-text-tertiary);font-size:0.7rem">(auto)</span>' : '') + '</td>' +
        '<td class="' + (readOnly || isResolvedForRows ? '' : existingCellClass) + '">' + (existingVal ? escapeHtml(existingVal) : '<span style="color:var(--color-text-tertiary);font-style:italic">—</span>') + '</td>' +
        pickerCell +
        '<td class="' + (readOnly || isResolvedForRows ? '' : proposedCellClass) + '">' + (proposedVal ? (differs ? '<strong>' + escapeHtml(proposedVal) + '</strong>' : escapeHtml(proposedVal)) : '<span style="color:var(--color-text-tertiary);font-style:italic">—</span>') + '</td>' +
        '</tr>';
    }).join("");

    // Source-aware labels (Entra vs AD vs vCenter) — older Entra-only
    // conflicts predate assetTagPrefix and default to Entra in the backend,
    // so the same default applies here. vCenter conflicts carry
    // sourceType="vcenter" with assetType discriminating VM vs ESXi host.
    var isVcenter = proposed.sourceType === "vcenter";
    var isAd = !isVcenter && proposed.assetTagPrefix === "ad:";
    var sourceLabel = isVcenter ? "vCenter" : isAd ? "Active Directory" : "Entra ID";
    var sourceShort = isVcenter
      ? (proposed.assetType === "hypervisor" ? "vCenter ESXi host" : "vCenter VM")
      : isAd ? "AD computer" : "Entra device";
    var rightColLabel = isVcenter ? "vCenter" : isAd ? "Active Directory" : "Entra / Intune";

    // Collision reason + match mechanism shape the explainer copy.
    var reason = proposed.collisionReason || "untagged-collision";
    var via = proposed.matchedVia === "netbios" ? "netbios" : "exact";

    var explainer;
    if (proposed.bothAssetsExist) {
      explainer = "Duplicate assets — this " + escapeHtml(sourceShort) + " already has its own Polaris asset, and the asset shown here shares its hostname with no " + escapeHtml(sourceLabel) + " link. <strong>Apply merge</strong> combines them into one asset (the " + escapeHtml(sourceShort) + "'s duplicate is absorbed and removed); <strong>Reject</strong> keeps both assets as-is — nothing is created or deleted.";
    } else if (reason === "duplicate-registration") {
      explainer = "Duplicate registration — another " + sourceShort + " with a different ID already exists under this hostname. <strong>Accept</strong> to merge into the existing record (replaces its assetTag with the new ID; the prior ID is preserved as a <code>prev-…</code> tag); <strong>Reject</strong> to keep them as separate assets.";
    } else if (reason === "mac-collision") {
      explainer = "MAC collision — the MAC reported by this " + sourceShort + " matches a MAC ever seen on an existing asset. <strong>Note:</strong> MAC randomization on modern Windows/iOS makes this a softer signal than hostname — confirm before accepting. <strong>Accept</strong> to merge into the existing record; <strong>Reject</strong> to keep them separate.";
    } else {
      explainer = "Hostname collision — this " + sourceShort + " shares a name with an existing asset that has no " + sourceLabel + " link. <strong>Accept</strong> to adopt the existing asset; <strong>Reject</strong> to create a separate asset for the " + sourceShort + ".";
    }
    if (via === "netbios") {
      explainer += ' <span style="color:var(--color-text-tertiary)">(matched via 15-char NetBIOS truncation — the longer canonical name will replace the truncated one on Accept.)</span>';
    }

    var badges = [];
    if (proposed.bothAssetsExist) {
      badges.push('<span class="badge badge-warning">Duplicate assets</span>');
    } else if (reason === "duplicate-registration") {
      badges.push('<span class="badge badge-warning">Duplicate registration</span>');
    } else if (reason === "mac-collision") {
      badges.push('<span class="badge" style="background:rgba(255,152,0,0.12);color:#ff9800;border:1px solid rgba(255,152,0,0.3)">MAC collision</span>');
    }
    if (via === "netbios") {
      badges.push('<span class="badge" style="background:rgba(255,193,7,0.12);color:#ffc107;border:1px solid rgba(255,193,7,0.3)">NetBIOS-truncated match</span>');
    }
    if (proposed.trustType) badges.push('<span class="badge" style="background:rgba(79,195,247,0.1);color:var(--color-accent);border:1px solid rgba(79,195,247,0.2)">' + escapeHtml(proposed.trustType) + '</span>');
    if (proposed.complianceState) badges.push('<span class="badge ' + (proposed.complianceState === "compliant" ? "badge-active" : "badge-warning") + '">' + escapeHtml(proposed.complianceState) + '</span>');

    var rejectTitle = proposed.bothAssetsExist
      ? "Keep both assets separate (nothing is created or deleted)"
      : "Create a separate asset for this " + sourceShort;
    var acceptTitle = proposed.bothAssetsExist
      ? "Merge the " + sourceShort + "'s duplicate asset into this one"
      : reason === "duplicate-registration"
        ? "Merge into the existing " + sourceShort
        : "Adopt the existing asset as this " + sourceShort;

    var actions = isResolved
      ? resolvedActionsHtml(c)
      : '<button class="btn btn-secondary btn-sm" data-conflict-action="reject" data-conflict-id="' + c.id + '" title="' + escapeHtml(rejectTitle) + '">Reject (keep separate)</button>' +
        '<button class="btn btn-primary btn-sm" data-conflict-action="merge" data-conflict-id="' + c.id + '" title="' + escapeHtml(acceptTitle) + '">Apply merge</button>';

    return '<div class="conflict-card">' +
      '<div class="conflict-card-header">' +
        '<span class="badge" style="background:rgba(79,195,247,0.12);color:var(--color-accent);border:1px solid rgba(79,195,247,0.3)">' + escapeHtml(sourceLabel) + '</span>' +
        '<strong>' + escapeHtml(existing.hostname || proposed.hostname || "(asset)") + '</strong>' +
        '<span class="conflict-card-subnet" style="font-family:var(--font-mono);font-size:0.78rem">' + escapeHtml(c.proposedDeviceId || "") + '</span>' +
        (badges.length ? '<span style="margin-left:auto;display:flex;gap:4px">' + badges.join("") + '</span>' : '') +
      '</div>' +
      '<div style="padding:6px 14px;font-size:0.78rem;color:var(--color-text-secondary)">' + explainer + (isResolved ? '' : ' Use ◀ / ▶ between the columns to pick the winning value per field — defaults match the legacy Accept behavior.') + '</div>' +
      '<div class="conflict-table conflict-table-picker" style="padding:0">' +
        '<table><thead><tr>' +
          '<th class="conflict-field">Field</th>' +
          '<th>Existing Asset</th>' +
          '<th class="conflict-picker"></th>' +
          '<th>' + escapeHtml(rightColLabel) + '</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '</table>' +
      '</div>' +
      '<div class="conflict-card-actions">' + actions + '</div>' +
    '</div>';
  }
})();

/* ─── Alerts Panel (stale DHCP reservations) ─────────────────────────────── */

(function () {
  var overlay = document.getElementById("alerts-overlay");
  var panel = document.getElementById("alerts-panel");
  var closeBtn = document.getElementById("alerts-panel-close");
  var filterSel = document.getElementById("alerts-panel-filter");
  var body = document.getElementById("alerts-panel-body");
  var countEl = document.getElementById("alerts-panel-count");
  var badge = document.getElementById("alerts-badge");
  var btn = document.getElementById("btn-alerts");
  if (!btn || !overlay) return;

  async function refreshBadge() {
    try {
      // Combined badge: stale-reservation alerts + queued-push count.
      // Either signal is operator-actionable; the panel switches between
      // the three views via its filter dropdown.
      var both = await Promise.all([
        api.reservations.alertsCount().catch(function () { return { count: 0 }; }),
        api.reservations.pushQueueCount().catch(function () { return { count: 0 }; }),
      ]);
      var n = ((both[0] && both[0].count) || 0) + ((both[1] && both[1].count) || 0);
      if (n > 0) {
        badge.textContent = n > 99 ? "99+" : String(n);
        badge.style.display = "block";
      } else {
        badge.style.display = "none";
      }
      // Refresh both sidebar dots in lockstep so the Alerts button and the
      // global indicators never disagree after an operator action: the IPAM
      // dot tracks stale-reservation alerts, the Events dot tracks the push
      // queue (alongside discovery conflicts).
      if (typeof window.refreshAlertsDot === "function") window.refreshAlertsDot();
      if (typeof window.refreshConflictDot === "function") window.refreshConflictDot();
    } catch (_) { /* badge stays hidden if request fails */ }
  }
  refreshBadge();

  function openPanel() {
    overlay.classList.add("open");
    loadAlerts();
  }
  function closePanel() {
    overlay.classList.remove("open");
    refreshBadge();
  }

  btn.addEventListener("click", openPanel);
  closeBtn.addEventListener("click", closePanel);
  overlay.addEventListener("click", function (e) { if (e.target === overlay) closePanel(); });
  if (filterSel) filterSel.addEventListener("change", loadAlerts);

  async function loadAlerts() {
    body.innerHTML = '<div class="empty-state" style="padding:2rem">Loading...</div>';
    var filterVal = filterSel && filterSel.value;
    var show = filterVal === "ignored" ? "ignored"
      : filterVal === "push-queue" ? "push-queue"
      : "active";
    if (show === "push-queue") {
      try {
        var data = await api.reservations.listPushQueue();
        var rows = (data && data.reservations) || [];
        countEl.textContent = rows.length + " queued push" + (rows.length !== 1 ? "es" : "");
        if (!rows.length) {
          body.innerHTML = '<div class="empty-state" style="padding:2rem">'
            + 'No push-queued reservations.<br>'
            + '<span style="color:var(--color-text-tertiary);font-size:0.85rem">'
            + 'When you reserve an IP on a push-eligible network and the FortiGate is unreachable, '
            + 'the reservation is saved here and retried automatically when the gate recovers.'
            + '</span></div>';
          return;
        }
        body.innerHTML = rows.map(renderPushQueueCard).join("");
        body.querySelectorAll("[data-pq-action]").forEach(function (el) {
          el.addEventListener("click", async function () {
            var id = el.getAttribute("data-pq-id");
            var action = el.getAttribute("data-pq-action");
            var name = el.getAttribute("data-pq-name") || id;
            el.disabled = true;
            try {
              if (action === "retry") {
                var result = await api.reservations.retryPush(id);
                var outcome = result && result.outcome;
                var msg;
                if (outcome === "synced") msg = "Pushed to FortiGate";
                else if (outcome === "transient") msg = "FortiGate still unreachable — kept queued";
                else if (outcome === "permanent") msg = "Push hit a permanent error — see reservation for details";
                else if (outcome === "superseded") msg = "Another row already has this IP — release this one to free the queue";
                else if (outcome === "cancelled") msg = "Subnet config changed — queue cleared, reservation kept as manual";
                else msg = "Retry: " + (outcome || "no change");
                showToast(msg, outcome === "synced" ? "success" : outcome === "transient" ? "info" : "error");
              } else if (action === "free") {
                var ok = await showConfirm("Release reservation " + name + "? If it was pushed to a FortiGate, the device entry will also be removed.");
                if (!ok) { el.disabled = false; return; }
                await api.reservations.release(id);
                showToast("Reservation released");
              }
              await loadAlerts();
              refreshBadge();
            } catch (err) {
              showToast(err.message, "error");
              el.disabled = false;
            }
          });
        });
      } catch (err) {
        body.innerHTML = '<div class="empty-state" style="padding:2rem;color:var(--color-danger)">' + escapeHtml(err.message) + '</div>';
      }
      return;
    }
    try {
      // Pull settings alongside the list so the Snooze button label can show
      // the actual snooze duration ("Snooze 60d") rather than a generic verb.
      var both = await Promise.all([
        api.reservations.listAlerts(show),
        api.reservations.getStaleSettings().catch(function () { return { staleAfterDays: 60 }; }),
      ]);
      var data = both[0];
      var settings = both[1] || { staleAfterDays: 60 };
      var alerts = (data && data.alerts) || [];
      var label = show === "ignored" ? "ignored" : "stale";
      countEl.textContent = alerts.length + " " + label + " reservation" + (alerts.length !== 1 ? "s" : "");
      if (!alerts.length) {
        var empty = show === "ignored"
          ? 'No reservations are currently set to ignore stale alerts.'
          : 'No stale reservations.<br><span style="color:var(--color-text-tertiary);font-size:0.85rem">A reservation is flagged when its target client has not been seen actively holding the IP within the configured threshold (Settings &rarr; Alerts).</span>';
        body.innerHTML = '<div class="empty-state" style="padding:2rem">' + empty + '</div>';
        return;
      }
      var canIgnore = canManageNetworks();
      body.innerHTML = alerts.map(function (a) { return renderAlertCard(a, settings, show, canIgnore); }).join("");

      // Bind Snooze / Free / Ignore / Un-ignore buttons
      body.querySelectorAll("[data-alert-action]").forEach(function (el) {
        el.addEventListener("click", async function () {
          var id = el.getAttribute("data-alert-id");
          var action = el.getAttribute("data-alert-action");
          var name = el.getAttribute("data-alert-name") || id;
          el.disabled = true;
          try {
            if (action === "snooze") {
              var r = await api.reservations.snoozeAlert(id);
              showToast("Snoozed for " + r.daysAdded + " day" + (r.daysAdded === 1 ? "" : "s"));
            } else if (action === "free") {
              var ok = await showConfirm("Release reservation " + name + "? If it was pushed to a FortiGate, the device entry will also be removed.");
              if (!ok) { el.disabled = false; return; }
              await api.reservations.release(id);
              showToast("Reservation released");
            } else if (action === "ignore") {
              var ok2 = await showConfirm("Permanently ignore stale alerts for " + name + "? The row will never appear in the Alerts panel again until an admin un-ignores it. The reservation itself stays active.");
              if (!ok2) { el.disabled = false; return; }
              await api.reservations.ignoreAlert(id);
              showToast("Alert ignored");
            } else if (action === "unignore") {
              await api.reservations.unignoreAlert(id);
              showToast("Alert un-ignored");
            }
            await loadAlerts();
            refreshBadge();
          } catch (err) {
            showToast(err.message, "error");
            el.disabled = false;
          }
        });
      });
    } catch (err) {
      body.innerHTML = '<div class="empty-state" style="padding:2rem;color:var(--color-danger)">' + escapeHtml(err.message) + '</div>';
    }
  }

  // canManageNetworks() is the same role gate the rest of the Events page
  // uses for admin-only buttons; defined in app.js. Falls back to false if
  // the helper isn't loaded yet so the Ignore button is hidden, not broken.
  function canManageNetworks() {
    return typeof window.canManageNetworks === "function" ? !!window.canManageNetworks() : false;
  }

  function renderAlertCard(a, settings, show, canIgnore) {
    var ip = a.ipAddress || "(no IP)";
    var hostname = a.hostname || "(no hostname)";
    var mac = a.macAddress || "—";
    var subnet = (a.subnetName ? escapeHtml(a.subnetName) + " — " : "") + escapeHtml(a.subnetCidr);
    var device = a.fortigateDevice ? '<div><strong>FortiGate:</strong> ' + escapeHtml(a.fortigateDevice) + '</div>' : "";
    var pushed = a.pushedToName ? '<div><strong>Pushed by:</strong> ' + escapeHtml(a.pushedToName) + '</div>' : "";
    var lastSeen = a.lastSeenLeased
      ? '<div><strong>Last seen leased:</strong> ' + new Date(a.lastSeenLeased).toLocaleString() + '</div>'
      : '<div><strong>Last seen leased:</strong> <span style="color:var(--color-text-tertiary)">never</span></div>';
    // ARP presence evidence (only rendered when it ever fired): the last time
    // discovery saw the owning FortiGate's ARP table bind this IP to the
    // reserved MAC. A stale row showing an old ARP confirmation means the
    // device WAS provably on the wire then and has gone quiet since.
    var arpSeen = a.lastSeenArp
      ? '<div><strong>Last ARP confirmation:</strong> ' + new Date(a.lastSeenArp).toLocaleString() + '</div>'
      : '';
    // Cross-signal: when an asset correlated (by MAC/IP) the row is only stale
    // because that asset is also absent — show its lastSeen so the operator
    // sees the device is gone from every signal, not just DHCP.
    var assetSeen = a.assetPresenceMatch
      ? '<div><strong>Matched asset (by ' + escapeHtml(String(a.assetPresenceMatch).toUpperCase()) + '):</strong> ' +
          (a.assetLastSeen ? 'last seen ' + new Date(a.assetLastSeen).toLocaleString() : '<span style="color:var(--color-text-tertiary)">never seen</span>') + '</div>'
      : '';
    var sinceLine = '<div style="color:var(--color-warning, #ffc107);font-weight:500;margin-top:4px">' + a.daysSinceSeen + ' day' + (a.daysSinceSeen === 1 ? "" : "s") + ' without verified presence</div>';
    var labelName = (a.hostname || ip).replace(/"/g, "&quot;");
    var snoozeDays = (settings && settings.staleAfterDays) || 60;
    var snoozeLabel = "Snooze " + snoozeDays + "d";
    var actions;
    if (show === "ignored") {
      // Ignored view — only un-ignore is meaningful (snooze/free still
      // possible but redundant for a row that's already silenced). Keep
      // un-ignore admin-gated so non-admins can't reactivate alerts.
      actions = canIgnore
        ? '<button class="btn btn-sm btn-secondary" data-alert-action="unignore" data-alert-id="' + escapeHtml(a.id) + '" data-alert-name="' + escapeHtml(labelName) + '" title="Resume stale-alerting on this reservation">Un-ignore</button>'
        : '<span class="hint" style="color:var(--color-text-tertiary)">Admin only</span>';
    } else {
      var ignoreBtn = canIgnore
        ? ' <button class="btn btn-sm btn-secondary" data-alert-action="ignore" data-alert-id="' + escapeHtml(a.id) + '" data-alert-name="' + escapeHtml(labelName) + '" title="Permanently ignore stale alerts on this reservation (admin/networkadmin only). The reservation itself stays active.">Ignore</button>'
        : "";
      actions =
        '<button class="btn btn-sm btn-secondary" data-alert-action="snooze" data-alert-id="' + escapeHtml(a.id) + '" data-alert-name="' + escapeHtml(labelName) + '" title="Hide this alert for ' + snoozeDays + ' more day(s); will refire if still stale after that, or clear automatically if the IP comes back online">' + escapeHtml(snoozeLabel) + '</button>' +
        ignoreBtn +
        ' <button class="btn btn-sm btn-danger" data-alert-action="free" data-alert-id="' + escapeHtml(a.id) + '" data-alert-name="' + escapeHtml(labelName) + '" title="Release this reservation entirely (also removes it from the FortiGate if pushed)">Free</button>';
    }
    var borderColor = show === "ignored" ? "var(--color-text-tertiary)" : "var(--color-warning, #ffc107)";
    return '<div class="conflict-card" style="border-left:4px solid ' + borderColor + '">' +
      '<div class="conflict-card-header">' +
        '<div>' +
          '<div style="font-weight:600">' + escapeHtml(ip) + ' &mdash; ' + escapeHtml(hostname) + '</div>' +
          '<div style="color:var(--color-text-tertiary);font-size:0.82rem">' + subnet + '</div>' +
        '</div>' +
        '<span class="badge badge-source-dhcp">DHCP Reservation</span>' +
      '</div>' +
      '<div class="conflict-card-body" style="font-size:0.85rem;line-height:1.6">' +
        '<div><strong>MAC:</strong> ' + escapeHtml(mac) + '</div>' +
        device +
        pushed +
        lastSeen +
        arpSeen +
        assetSeen +
        '<div><strong>Created:</strong> ' + new Date(a.createdAt).toLocaleString() + '</div>' +
        sinceLine +
      '</div>' +
      '<div class="conflict-card-actions">' + actions + '</div>' +
    '</div>';
  }

  // Push-queue card: same visual language as the stale-alert card so the
  // Alerts panel reads consistently. Two action buttons — Retry (operator
  // override of the readiness gates; works on both pending and
  // failed_permanent rows) and Free (release the reservation entirely).
  function renderPushQueueCard(r) {
    var ip = r.ipAddress || "(no IP)";
    var hostname = r.hostname || "(no hostname)";
    var mac = r.macAddress || "—";
    var subnetName = r.subnet && r.subnet.name ? r.subnet.name : "";
    var subnetCidr = r.subnet && r.subnet.cidr ? r.subnet.cidr : "";
    var subnet = (subnetName ? escapeHtml(subnetName) + " — " : "") + escapeHtml(subnetCidr);
    var device = r.subnet && r.subnet.fortigateDevice
      ? '<div><strong>Target FortiGate:</strong> ' + escapeHtml(r.subnet.fortigateDevice) + '</div>'
      : "";
    var integrationName = r.pushedTo && r.pushedTo.name ? r.pushedTo.name : null;
    var integration = integrationName
      ? '<div><strong>Pushed via:</strong> ' + escapeHtml(integrationName)
        + (r.pushedTo && r.pushedTo.enabled === false ? ' <span style="color:var(--color-danger)">(disabled)</span>' : '')
        + '</div>'
      : "";
    var queuedAt = r.pushQueuedAt
      ? '<div><strong>Queued:</strong> ' + new Date(r.pushQueuedAt).toLocaleString() + '</div>'
      : "";
    var attempts = typeof r.pushAttempts === "number"
      ? '<div><strong>Attempts:</strong> ' + r.pushAttempts + '</div>'
      : "";
    var lastError = r.pushError
      ? '<div style="margin-top:6px;padding:6px 8px;background:var(--color-bg-subtle, rgba(0,0,0,0.04));border-radius:4px;font-family:var(--font-mono, monospace);font-size:0.78rem">'
        + escapeHtml(r.pushError) + '</div>'
      : "";
    var isPermanent = r.pushStatus === "failed_permanent";
    var statusBadge = isPermanent
      ? '<span class="badge" style="background:var(--color-danger);color:#fff">Push failed</span>'
      : '<span class="badge" style="background:var(--color-warning, #ffc107);color:#000">Queued for push</span>';
    var borderColor = isPermanent ? "var(--color-danger)" : "var(--color-warning, #ffc107)";
    var labelName = (r.hostname || ip).replace(/"/g, "&quot;");
    var actions =
      '<button class="btn btn-sm btn-secondary" data-pq-action="retry" data-pq-id="' + escapeHtml(r.id) + '" data-pq-name="' + escapeHtml(labelName) + '" title="Retry pushing this reservation to the FortiGate now (bypasses the readiness gate)">Retry</button>' +
      ' <button class="btn btn-sm btn-danger" data-pq-action="free" data-pq-id="' + escapeHtml(r.id) + '" data-pq-name="' + escapeHtml(labelName) + '" title="Release this reservation entirely">Free</button>';
    return '<div class="conflict-card" style="border-left:4px solid ' + borderColor + '">' +
      '<div class="conflict-card-header">' +
        '<div>' +
          '<div style="font-weight:600">' + escapeHtml(ip) + ' &mdash; ' + escapeHtml(hostname) + '</div>' +
          '<div style="color:var(--color-text-tertiary);font-size:0.82rem">' + subnet + '</div>' +
        '</div>' +
        statusBadge +
      '</div>' +
      '<div class="conflict-card-body" style="font-size:0.85rem;line-height:1.6">' +
        '<div><strong>MAC:</strong> ' + escapeHtml(mac) + '</div>' +
        device +
        integration +
        queuedAt +
        attempts +
        lastError +
      '</div>' +
      '<div class="conflict-card-actions">' + actions + '</div>' +
    '</div>';
  }
})();

/* ─── PDF Export ──────────────────────────────────────────────────────────── */

(function () {
  var menu = document.getElementById("export-menu");
  var btn  = document.getElementById("btn-export");
  if (!btn || !menu) return;

  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    menu.classList.toggle("open");
  });
  document.addEventListener("click", function () { menu.classList.remove("open"); });
  menu.addEventListener("click", function (e) { e.stopPropagation(); });

  menu.querySelectorAll("button[data-export]").forEach(function (item) {
    item.addEventListener("click", async function () {
      menu.classList.remove("open");
      await handleEventExport(this.getAttribute("data-export"), this.getAttribute("data-fmt"));
    });
  });
})();

// Pulled by the "Export → All filtered results" path so the exported set
// honors whatever the operator has selected on the table headers. Reads
// TableSF state via the same translation _buildEventsQuery uses; mirrors
// the multi-value-CSV / <field>Op-aware shape the route accepts.
function _getEventFilters() {
  var sf = _eventsSF;
  if (!sf) return {};
  var filters = sf._filters || {};
  var out = {};
  if (Array.isArray(filters.level) && filters.level.length) {
    out.level = filters.level.join(",");
  }
  if (Array.isArray(filters.resourceType) && filters.resourceType.length) {
    out.resourceType = filters.resourceType.join(",");
  }
  function pushText(field, raw) {
    if (raw == null) return;
    if (typeof raw === "string") {
      var v = raw.trim();
      if (v) out[field] = v;
    } else if (typeof raw === "object") {
      if (raw.op === "empty") out[field + "Op"] = "empty";
      else if (raw.op === "notempty") out[field + "Op"] = "is_not_empty";
      else if (raw.op === "not-contains") {
        var q = (raw.q || "").trim();
        if (q) { out[field] = q; out[field + "Op"] = "not_contains"; }
      }
    }
  }
  pushText("action", filters.action);
  pushText("resourceName", filters.resourceName);
  pushText("actor", filters.actor);
  pushText("message", filters.message);
  if (filters.timestamp && filters.timestamp.type === "date") {
    if (filters.timestamp.from) out.since = filters.timestamp.from + "T00:00:00";
    if (filters.timestamp.to)   out.until = filters.timestamp.to   + "T23:59:59.999";
  }
  if (sf._sortKey) {
    out.sortBy  = sf._sortKey;
    out.sortDir = sf._sortDir === "asc" ? "asc" : "desc";
  }
  return out;
}

async function handleEventExport(mode, fmt) {
  var events, label, ok;

  if (mode === "page") {
    events = _eventsCurrentPage;
    var pageNum = Math.floor(_eventsCurrentOffset / _eventsPageSize) + 1;
    label = "page " + pageNum;
  } else if (mode === "filtered") {
    var total = _eventsCurrentTotal;
    label = total + " filtered events";
    if (total > 100) {
      ok = await showConfirm("This will export " + total + " events. Continue?");
      if (!ok) return;
    }
  } else if (mode === "all") {
    ok = await showConfirm("Export the entire event log? This may take a moment.");
    if (!ok) return;
  }

  await trackedPdfExport("Exporting events " + fmt.toUpperCase(), async function (signal) {
    // GET /events caps limit at 200 (the Zod schema REJECTS larger values
    // rather than clamping), so multi-page exports fetch in 200-row chunks
    // up to a 10k export ceiling.
    async function fetchAllPages(baseParams) {
      var out = [];
      var offset = 0;
      var total = Infinity;
      while (offset < total && out.length < 10000) {
        var q = Object.assign({}, baseParams, { limit: 200, offset: offset });
        var data = await request("GET", "/events" + toQuery(q), undefined, signal);
        if (signal.aborted) return out;
        var chunk = (data && data.events) || [];
        out = out.concat(chunk);
        total = (data && data.total) || out.length;
        if (chunk.length === 0) break;
        offset += chunk.length;
      }
      return out;
    }
    if (mode === "filtered") {
      events = await fetchAllPages(_getEventFilters());
      label = events.length + " filtered events";
    } else if (mode === "all") {
      events = await fetchAllPages({});
      label = "all " + events.length + " events";
    }
    if (signal.aborted) return;
    if (!events || events.length === 0) { showToast("No events to export", "error"); return; }
    if (fmt === "csv") generateEventCsv(events);
    else generateEventPdf(events, label);
  });
}

function generateEventPdf(events, label) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error("PDF library not loaded. Check your internet connection and reload the page.");
  }
  var jsPDF = window.jspdf.jsPDF;
  var doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });

  var now = new Date();
  var timestamp = now.toLocaleDateString() + " " + now.toLocaleTimeString();

  doc.setFontSize(16);
  doc.setTextColor(40, 40, 40);
  doc.text((_branding ? _branding.appName : "Polaris") + " \u2014 Event Log", 40, 36);
  doc.setFontSize(9);
  doc.setTextColor(120, 120, 120);
  doc.text("Generated: " + timestamp + "  |  Scope: " + label + "  |  Count: " + events.length, 40, 52);

  var head = [["Timestamp", "Level", "Action", "Resource", "Message", "User"]];
  var body = events.map(function (ev) {
    var ts = new Date(ev.timestamp);
    var timeStr = formatShortDateTime(ts);
    var resource = ev.resourceType || "-";
    if (ev.resourceName) resource += " (" + ev.resourceName + ")";
    return [
      timeStr,
      (ev.level || "info").toUpperCase(),
      ev.action || "-",
      resource,
      ev.message || "-",
      ev.actor || "-",
    ];
  });

  doc.autoTable({
    startY: 64,
    head: head,
    body: body,
    theme: "grid",
    styles: { fontSize: 7.5, cellPadding: 4, overflow: "linebreak" },
    headStyles: { fillColor: [30, 30, 54], textColor: [230, 230, 230], fontStyle: "bold" },
    alternateRowStyles: { fillColor: [245, 245, 250] },
    margin: { left: 40, right: 40 },
    columnStyles: {
      0: { cellWidth: 100 },
      1: { cellWidth: 42 },
      2: { cellWidth: 90 },
      3: { cellWidth: 80 },
      5: { cellWidth: 60 },
    },
    didDrawPage: function (data) {
      var pageNum = doc.internal.getNumberOfPages();
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text(
        "Page " + data.pageNumber + " of " + pageNum + "  |  " + (_branding ? _branding.appName : "Polaris") + " Event Log",
        doc.internal.pageSize.getWidth() / 2,
        doc.internal.pageSize.getHeight() - 20,
        { align: "center" }
      );
    },
  });

  var filename = "polaris-events-" + now.toISOString().slice(0, 10) + ".pdf";
  doc.save(filename);
  showToast("Exported " + events.length + " events to " + filename);
}

function showEventDetail(ev) {
  var changes = ev.details && ev.details.changes ? ev.details.changes : {};
  var keys = Object.keys(changes);
  if (!keys.length) return;

  var rows = keys.map(function (field) {
    var c = changes[field];
    var from = c.from === null || c.from === "" ? '<span style="color:var(--color-text-tertiary);font-style:italic">empty</span>' : escapeHtml(formatDetailValue(c.from));
    var to = c.to === null || c.to === "" ? '<span style="color:var(--color-text-tertiary);font-style:italic">empty</span>' : escapeHtml(formatDetailValue(c.to));
    return '<tr>' +
      '<td style="font-weight:500;white-space:nowrap">' + escapeHtml(formatFieldName(field)) + '</td>' +
      '<td style="color:var(--color-danger)">' + from + '</td>' +
      '<td style="color:var(--color-success)">' + to + '</td>' +
      '</tr>';
  }).join("");

  var ts = new Date(ev.timestamp);
  var timeStr = formatDateTime(ts);

  var body =
    '<div style="margin-bottom:1rem;font-size:0.85rem;color:var(--color-text-secondary)">' +
      '<span style="font-family:var(--font-mono)">' + escapeHtml(ev.action) + '</span> by <strong>' + escapeHtml(ev.actor || "unknown") + '</strong> at ' + escapeHtml(timeStr) +
    '</div>' +
    '<table style="width:100%">' +
      '<thead><tr>' +
        '<th style="width:120px">Field</th>' +
        '<th>Before</th>' +
        '<th>After</th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
    '</table>';

  var title = "Change Detail" + (ev.resourceName ? " — " + ev.resourceName : "");
  openModal(title, body, '<button class="btn btn-secondary" onclick="closeModal()">Close</button>');
}

function formatFieldName(field) {
  return field.replace(/([A-Z])/g, " $1").replace(/^./, function (c) { return c.toUpperCase(); });
}

function formatDetailValue(val) {
  if (Array.isArray(val)) return val.join(", ") || "none";
  if (val instanceof Object) return JSON.stringify(val);
  return String(val);
}

function generateEventCsv(events) {
  var headers = ["Timestamp", "Level", "Action", "Resource Type", "Resource Name", "Message", "User"];
  var rows = events.map(function (ev) {
    var ts = new Date(ev.timestamp);
    var timeStr = formatDateTime(ts);
    return [
      timeStr, (ev.level || "info").toUpperCase(), ev.action || "",
      ev.resourceType || "", ev.resourceName || "", ev.message || "", ev.actor || "",
    ];
  });
  var filename = "polaris-events-" + new Date().toISOString().slice(0, 10) + ".csv";
  downloadCsv(headers, rows, filename);
  showToast("Exported " + events.length + " events to " + filename);
}
