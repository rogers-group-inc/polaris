/**
 * public/js/connectivity-checks.js — Connections page (/connections.html).
 *
 * Agent-run connectivity checks: an HTTP / HTTPS / TCP / ICMP check (+ an
 * optional traceroute) the Polaris Agent runs from every host the check's
 * Sources pick. This file owns the list, the check modal and the fleet
 * Results view. The per-host charts and hop table live in assets.js
 * (the slide-over's Connectivity tab).
 *
 * A check has NO threshold — the SLA is an automation on the conn* metrics
 * (business rule 85) — so nothing here offers one.
 *
 * Gates: connectivityChecks read (see the list, open Results) / write
 * (create, edit, duplicate, enable, delete). UP_TO_WRITE ladder — never test
 * fullwrite on it (rule 43d).
 */
(function () {
  "use strict";

  // ─── Status spec (MIRROR) ───────────────────────────────────────────────
  // Mirrors parseStatusSpec in src/utils/httpCheck.ts and the Go agent's copy
  // (agent/internal/collectors/connectivity_http.go). Pinned to the server by
  // tests/unit/connectivityStatusSpecParity.test.ts — change all three.
  function parseStatusSpec(spec) {
    var s = String(spec == null ? "" : spec).trim();
    if (!s) return { ranges: [{ lo: 200, hi: 299 }], error: null };
    var parts = s.split(",");
    var ranges = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i].trim();
      if (!part) return { ranges: [], error: "Empty entry in the status list" };
      var m = /^(\d{3})(?:\s*-\s*(\d{3}))?$/.exec(part);
      if (!m) return { ranges: [], error: '"' + part + '" is not a status code or range (use 200 or 200-299)' };
      var lo = Number(m[1]);
      var hi = m[2] !== undefined ? Number(m[2]) : lo;
      if (lo < 100 || hi > 599) return { ranges: [], error: '"' + part + '" is outside 100–599' };
      if (lo > hi) return { ranges: [], error: '"' + part + '" runs backwards' };
      ranges.push({ lo: lo, hi: hi });
    }
    if (ranges.length > 20) return { ranges: [], error: "At most 20 codes or ranges" };
    return { ranges: ranges, error: null };
  }

  var KIND_LABELS = { http: "HTTP", https: "HTTPS", tcp: "TCP", icmp: "ICMP" };
  var TARGET_HINTS = {
    http:  { label: "URL", placeholder: "http://intranet.example/health" },
    https: { label: "URL", placeholder: "https://intranet.example/health" },
    tcp:   { label: "Host and port", placeholder: "db01.example:5432" },
    icmp:  { label: "Host or IP address", placeholder: "10.20.0.1" },
  };

  function canRead() { return typeof permAtLeast === "function" && permAtLeast("connectivityChecks", "read"); }
  function canEdit() { return typeof permAtLeast === "function" && permAtLeast("connectivityChecks", "write"); }

  function esc(s) { return escapeHtml(s == null ? "" : String(s)); }

  function fmtWhen(v) {
    if (!v) return "—";
    var d = new Date(v);
    if (isNaN(d.getTime())) return "—";
    try {
      return d.toLocaleString(undefined, Object.assign({ month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
        typeof timeZoneOpts === "function" ? timeZoneOpts() : {}));
    } catch (_) { return d.toLocaleString(); }
  }

  function intervalLabel(sec) {
    var m = Math.round((sec || 60) / 60);
    return "every " + (m === 1 ? "minute" : m + " min");
  }

  function kindBadge(kind) {
    return '<span class="badge">' + esc(KIND_LABELS[kind] || kind) + "</span>";
  }

  var OK_COLOR = "#2a9d8f";
  var FAIL_COLOR = "#d32f2f";

  function resultPill(lastOk, hasSample) {
    if (!hasSample || lastOk === null || lastOk === undefined) {
      return '<span style="color:var(--color-text-tertiary)">no result yet</span>';
    }
    return '<span class="badge" style="background:' + (lastOk ? OK_COLOR : FAIL_COLOR) + ';color:#fff">' +
      (lastOk ? "Reachable" : "Failing") + "</span>";
  }

  // ─── List ───────────────────────────────────────────────────────────────

  var _checks = [];
  var _sf = null;
  var _layout = null;
  var _page = 1;
  var _pageSize = 25;

  function savePrefs() {
    if (typeof currentUsername === "undefined" || typeof PolarisPrefs === "undefined") return;
    PolarisPrefs.save("connectivityChecks", currentUsername, Object.assign(
      { pageSize: _pageSize, layout: _layout ? _layout.getPrefs() : null },
      _sf ? _sf.getPrefs() : {},
    ));
  }

  function restorePrefs() {
    if (typeof currentUsername === "undefined" || typeof PolarisPrefs === "undefined") return;
    var p = PolarisPrefs.load("connectivityChecks", currentUsername);
    if (!p) return;
    if (p.pageSize) _pageSize = p.pageSize;
    if (_layout && p.layout) _layout.setPrefs(p.layout);
    if (_sf) _sf.setPrefs(p);
  }

  function initTable() {
    var tbody = document.getElementById("conn-tbody");
    if (!tbody || _sf) return;
    var table = tbody.closest("table");
    // TableSF first, then setupColumnLayout (TableSF rewrites th innerHTML).
    _sf = new TableSF("conn-tbody", function () { _page = 1; renderList(); savePrefs(); });
    _layout = setupColumnLayout(table, { onChange: savePrefs });
    restorePrefs();
  }

  async function loadTab() {
    if (!canRead()) return;
    initTable();
    try {
      var res = await api.connectivityChecks.list();
      _checks = (res && res.checks) || [];
      renderList();
    } catch (err) {
      var tb = document.getElementById("conn-tbody");
      if (tb) tb.innerHTML = '<tr><td colspan="10" class="empty-state">' + esc(err.message || "Failed to load connectivity checks") + "</td></tr>";
    }
  }

  /** Row verbs, pure (tested): Results first — it is the one a reader has. */
  function menuItems(check, perms) {
    var items = [{ label: "Results", onSelect: function () { openResults(check); } }];
    if (perms && perms.canEdit) {
      items.push({ separator: true });
      items.push({ label: "Edit", onSelect: function () { openCheckModal(check); } });
      items.push({ label: "Duplicate", title: "Create a disabled copy", onSelect: function () { openCheckModal(check, { duplicate: true }); } });
      items.push({
        label: check.enabled ? "Disable" : "Enable",
        onSelect: function () { toggleEnabled(check, !check.enabled); },
      });
      items.push({ separator: true });
      items.push({ label: "Delete", danger: true, onSelect: function () { deleteCheck(check); } });
    }
    return items;
  }

  function renderList() {
    var tbody = document.getElementById("conn-tbody");
    if (!tbody) return;
    var editor = canEdit();
    var data = _checks.map(function (c) {
      return Object.assign({}, c, { tracerouteEnabled: !!(c.traceroute && c.traceroute.enabled) ? "true" : "false" });
    });
    if (_sf) data = _sf.apply(data);
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="empty-state">' +
        (_checks.length ? "No checks match the filters." : "No connectivity checks yet" + (editor ? ' — click "+ Add check" to create one.' : ".")) +
        "</td></tr>";
      if (typeof clearPageControls === "function") clearPageControls("conn-pagination");
      return;
    }
    var totalPages = Math.max(1, Math.ceil(data.length / _pageSize));
    if (_page > totalPages) _page = totalPages;
    var rows = data.slice((_page - 1) * _pageSize, _page * _pageSize);
    renderPageControls("conn-pagination", data.length, _pageSize, _page,
      function (p) { _page = p; renderList(); },
      function (size) { _pageSize = size; _page = 1; renderList(); savePrefs(); });

    tbody.innerHTML = rows.map(function (c) {
      var result;
      if (!c.sourceCount) result = '<span style="color:var(--color-text-tertiary)">no hosts</span>';
      else if (!c.okCount && !c.failCount) result = '<span style="color:var(--color-text-tertiary)">no results yet</span>';
      else {
        result = '<span style="color:' + OK_COLOR + '">' + c.okCount + " ok</span>";
        if (c.failCount) result += ' · <strong style="color:' + FAIL_COLOR + '">' + c.failCount + " failing</strong>";
      }
      var enabledCell = editor
        ? '<label class="toggle-switch" title="' + (c.enabled ? "Enabled — click to disable" : "Disabled — click to enable") + '">' +
            '<input type="checkbox" class="conn-enabled-toggle" data-id="' + esc(c.id) + '"' + (c.enabled ? " checked" : "") + '>' +
            '<span class="toggle-slider"></span></label>'
        : (c.enabled ? "Yes" : '<span style="color:var(--color-text-tertiary)">No</span>');
      return "<tr>" +
        '<td><button type="button" class="row-menu-trigger conn-menu" data-id="' + esc(c.id) + '" aria-haspopup="menu" aria-expanded="false" title="Actions for this check">' + esc(c.name) + "</button></td>" +
        "<td>" + kindBadge(c.kind) + "</td>" +
        '<td title="' + esc(c.target) + '" style="font-family:var(--font-mono,monospace);font-size:0.82rem">' + esc(c.target) + "</td>" +
        "<td>" + esc(intervalLabel(c.intervalSec)) + "</td>" +
        "<td>" + (c.sourceCount || 0) + "</td>" +
        "<td>" + result + "</td>" +
        "<td>" + esc(fmtWhen(c.lastRunAt)) + "</td>" +
        "<td>" + (c.tracerouteEnabled === "true" ? "On" : '<span style="color:var(--color-text-tertiary)">Off</span>') + "</td>" +
        "<td>" + enabledCell + "</td>" +
        "<td>" + esc(c.createdBy || "—") + "</td>" +
        "</tr>";
    }).join("");

    tbody.querySelectorAll(".conn-menu").forEach(function (b) {
      b.addEventListener("click", function () {
        var c = _checks.find(function (x) { return x.id === b.dataset.id; });
        if (c) showRowMenu(b, menuItems(c, { canEdit: editor }));
      });
    });
    tbody.querySelectorAll(".conn-enabled-toggle").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var c = _checks.find(function (x) { return x.id === cb.dataset.id; });
        if (c) toggleEnabled(c, cb.checked, cb);
      });
    });
  }

  async function toggleEnabled(check, enabled, cb) {
    if (cb) cb.disabled = true;
    try {
      await api.connectivityChecks.setEnabled(check.id, enabled);
      showToast("Check " + (enabled ? "enabled" : "disabled"), "success");
      loadTab();
    } catch (err) {
      if (cb) { cb.checked = !enabled; cb.disabled = false; }
      showToast(err.message || "Update failed", "error");
    }
  }

  async function deleteCheck(check) {
    var ok = await showConfirm('Delete connectivity check "' + check.name + '"? Agents stop running it on their next config refresh. ' +
      "Its past results age out on the retention schedule, and automations filtered to it will stop matching.");
    if (!ok) return;
    try {
      await api.connectivityChecks.delete(check.id);
      showToast("Check deleted", "success");
      loadTab();
    } catch (err) {
      showToast(err.message || "Delete failed", "error");
    }
  }

  // ─── Check modal ────────────────────────────────────────────────────────

  var _filterSchema = null;

  function scopeValueOptions(field) {
    // The seventh copy of the optionsFrom switch (canon-modals-wizards.md §
    // Nested condition tree). A field with `values` short-circuits first, which
    // is how agentInstalled needs no case here.
    var s = _filterSchema || {};
    var fm = ((s.scopeCondition || {}).fields || []).find(function (f) { return f.field === field; }) || {};
    if (fm.values) return fm.values.map(function (v) { return { value: v, label: v }; });
    var o = s.options || {};
    switch (fm.optionsFrom) {
      case "assetTypes":     return (o.assetTypes || []).map(function (t) { return { value: t.name, label: t.label || t.name }; });
      case "manufacturers":  return (o.manufacturers || []).map(function (m) { return { value: m, label: m }; });
      case "models":         return (o.models || []).map(function (m) { return { value: m, label: m }; });
      case "interfaceNames": return (o.interfaceNames || []).map(function (n) { return { value: n, label: n }; });
      case "ssids":          return (o.ssids || []).map(function (n) { return { value: n, label: n }; });
      case "tags":           return (o.tags || []).map(function (t) { return { value: t, label: t }; });
      case "subnets":        return (o.subnets || []).map(function (sn) { return { value: sn.cidr, label: sn.name + " — " + sn.cidr }; });
      case "ipBlocks":       return (o.ipBlocks || []).map(function (b) { return { value: b.cidr, label: b.name + " — " + b.cidr }; });
      default: return [];
    }
  }

  function field(label, inner, hint) {
    return '<div class="form-group"><label>' + label + "</label>" + inner +
      (hint ? '<p class="hint" style="margin:4px 0 0">' + hint + "</p>" : "") + "</div>";
  }

  function checkboxLine(id, label, checked, hint) {
    return '<div class="form-group"><label style="display:flex;align-items:center;gap:6px;font-weight:500">' +
      '<input type="checkbox" id="' + id + '" style="width:auto"' + (checked ? " checked" : "") + "> " + label + "</label>" +
      (hint ? '<p class="hint" style="margin:2px 0 0 24px">' + hint + "</p>" : "") + "</div>";
  }

  function generalTab(c) {
    var kind = c.kind || "https";
    var hint = TARGET_HINTS[kind];
    return field("Name", '<input type="text" id="cc-name" maxlength="120" value="' + esc(c.name || "") + '">') +
      field("Description", '<input type="text" id="cc-description" maxlength="1000" value="' + esc(c.description || "") + '">') +
      field("Kind",
        '<select id="cc-kind">' + ["https", "http", "tcp", "icmp"].map(function (k) {
          return '<option value="' + k + '">' + KIND_LABELS[k] + "</option>";
        }).join("") + "</select>",
        "HTTP / HTTPS send one GET and judge the status (and body, if set). TCP opens a connection. ICMP sends one ping.") +
      '<div class="form-group"><label id="cc-target-label">' + esc(hint.label) + '</label>' +
        '<input type="text" id="cc-target" maxlength="512" placeholder="' + esc(hint.placeholder) + '" value="' + esc(c.target || "") + '">' +
        '<p class="hint" style="margin:4px 0 0">Loopback, link-local, multicast and IPv6 targets are refused, as is this Polaris server. Credentials in a URL are not supported.</p></div>' +
      '<div style="display:flex;gap:1rem;flex-wrap:wrap">' +
        field("Every (minutes)", '<input type="number" id="cc-interval-min" min="1" max="60" step="1" value="' + Math.round((c.intervalSec || 60) / 60) + '" style="max-width:120px">') +
        field("Timeout (ms)", '<input type="number" id="cc-timeout-ms" min="500" max="30000" step="100" value="' + (c.timeoutMs || 5000) + '" style="max-width:140px">', "At most half the interval.") +
      "</div>" +
      checkboxLine("cc-enabled", "Enabled", c.enabled !== false);
  }

  function expectationsTab(c) {
    var http = c.http || {};
    var bm = http.bodyMatch || null;
    return '<div id="cc-http-fields">' +
        field("Accepted status codes",
          '<input type="text" id="cc-status-spec" placeholder="200-299" value="' + esc(http.expectStatus || "") + '">',
          'Codes and ranges, comma-separated — e.g. <code>200,204,300-399</code>. Blank means any 2xx. Redirects are never followed, so a 302 is judged as a 302.') +
        '<p class="hint" id="cc-status-error" style="color:var(--color-danger,#d32f2f);display:none;margin:-0.5rem 0 0.75rem"></p>' +
        field("Body must",
          '<select id="cc-body-mode"><option value="">(no body check)</option><option value="contains">contain</option>' +
            '<option value="exact">equal exactly</option><option value="regex">match the regular expression</option></select>' +
          '<input type="text" id="cc-body-pattern" maxlength="1024" style="margin-top:6px" value="' + esc(bm ? bm.pattern : "") + '">',
          "Checked in the first 64 KB. Regular expressions run on the agent (RE2): no lookahead / lookbehind or backreferences.") +
        checkboxLine("cc-body-case", "Case-sensitive", !!(bm && bm.caseSensitive)) +
        '<div id="cc-tls-row">' + checkboxLine("cc-verify-tls", "Verify the TLS certificate", http.verifyTls !== false,
          "Off accepts any certificate — the check still reports its issuer and expiry.") + "</div>" +
        checkboxLine("cc-keep-excerpt", "Keep a body excerpt on every run", !!c.keepBodyExcerpt,
          "Every run stores a SHA-256 fingerprint and the size of the body. Up to 4 KB of the body itself is kept only when a run fails — or on every run with this on. Response bodies can contain sensitive data.") +
      "</div>" +
      '<div id="cc-nonhttp-note" style="display:none">' + infoBox("TCP and ICMP checks pass when the connection (or the echo reply) arrives within the timeout. There is nothing else to expect.") + "</div>";
  }

  function tracerouteTab(c) {
    var t = c.traceroute || {};
    var num = function (id, label, v, min, max) {
      return field(label, '<input type="number" id="' + id + '" min="' + min + '" max="' + max + '" value="' + v + '" style="max-width:120px">');
    };
    return checkboxLine("cc-tr-enabled", "Trace the route", t.enabled !== false,
        "Also runs immediately whenever a run fails after a passing one, so a failure always has a fresh path. Each hop is matched to the device Polaris monitors at that address.") +
      '<div style="display:flex;gap:1rem;flex-wrap:wrap">' +
        num("cc-tr-every", "Every N runs", t.everyNRuns || 5, 1, 100) +
        num("cc-tr-maxhops", "Max hops", t.maxHops || 30, 1, 64) +
        num("cc-tr-probes", "Probes per hop", t.probesPerHop || 3, 1, 5) +
      "</div>" +
      '<p class="hint">A changed hop sequence is written to Events as <code>connectivity.path_changed</code>, which an automation can alert on. macOS agents do not trace in this version.</p>';
  }

  function sourcesTab() {
    return infoBox("A check runs only on hosts with an active <strong>Polaris Agent</strong> (0.21.0 or later) — this filter is always combined with <em>Polaris Agent installed = yes</em>.") +
      checkboxLine("cc-all-hosts", "All agent hosts", false) +
      '<div id="cc-cond-wrap"><div id="cc-cond-root"></div></div>' +
      '<div class="aw-preview-box" id="cc-preview" style="margin-top:0.75rem;max-height:260px;overflow:auto"></div>';
  }

  async function openCheckModal(existing, opts) {
    opts = opts || {};
    if (!canEdit()) return;
    try {
      _filterSchema = _filterSchema || await api.connectivityChecks.filterSchema();
    } catch (err) {
      showToast(err.message || "Failed to load the device-filter vocabulary", "error");
      return;
    }
    var CB = window.PolarisConditionBuilder;
    if (!CB) { showToast("Condition builder failed to load — reload the page", "error"); return; }

    var c = existing ? JSON.parse(JSON.stringify(existing)) : {
      kind: "https", intervalSec: 60, timeoutMs: 5000, enabled: true,
      http: { expectStatus: "", verifyTls: true, bodyMatch: null },
      traceroute: { enabled: true, everyNRuns: 5, maxHops: 30, probesPerHop: 3 },
      scope: { allAssets: true }, assetIds: [],
    };
    var editingId = existing && !opts.duplicate ? existing.id : null;
    if (opts.duplicate) { c.name = uniqueName((existing.name || "Check") + " (copy)"); c.enabled = false; }
    var pins = new Set(c.assetIds || []);
    var builder = CB.create({ meta: _filterSchema.scopeCondition, valueOptions: scopeValueOptions, onChange: schedulePreview });

    var tabs = [
      { key: "general", label: "General", html: generalTab(c) },
      { key: "expect", label: "Expectations", html: expectationsTab(c) },
      { key: "trace", label: "Traceroute", html: tracerouteTab(c) },
      { key: "sources", label: "Sources", html: sourcesTab() },
    ];
    var title = editingId ? "Edit Connectivity Check" : "Add Connectivity Check";
    var footer = '<button class="btn btn-secondary" id="cc-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="cc-save">' + (editingId ? "Save Changes" : "Create") + "</button>";
    openModal(title, tabbedBodyHTML("cc", tabs), footer, { wide: true });
    wireModalTabs("cc");
    var body = document.querySelector("#modal-overlay .modal-body");

    // Pin selects from the model (the happy-dom <option selected> trap, and
    // the reason product code sets .value rather than writing `selected`).
    body.querySelector("#cc-kind").value = c.kind || "https";
    body.querySelector("#cc-body-mode").value = c.http && c.http.bodyMatch ? c.http.bodyMatch.mode : "";

    var scope = c.scope || {};
    var allCb = body.querySelector("#cc-all-hosts");
    allCb.checked = scope.allAssets === true;
    var condRoot = body.querySelector("#cc-cond-root");
    condRoot.innerHTML = builder.groupHtml(scope.condition || { op: "and", children: [] }, 0);
    builder.wire(body, "#cc-cond-root");
    function syncAll() {
      body.querySelector("#cc-cond-wrap").style.display = allCb.checked ? "none" : "block";
      if (!allCb.checked) builder.seedIfEmpty(condRoot);
    }
    allCb.addEventListener("change", function () { syncAll(); schedulePreview(); });
    syncAll();

    function syncKind() {
      var k = body.querySelector("#cc-kind").value;
      var hint = TARGET_HINTS[k];
      body.querySelector("#cc-target-label").textContent = hint.label;
      body.querySelector("#cc-target").placeholder = hint.placeholder;
      var isHttp = k === "http" || k === "https";
      body.querySelector("#cc-http-fields").style.display = isHttp ? "" : "none";
      body.querySelector("#cc-nonhttp-note").style.display = isHttp ? "none" : "";
      body.querySelector("#cc-tls-row").style.display = k === "https" ? "" : "none";
    }
    body.querySelector("#cc-kind").addEventListener("change", syncKind);
    syncKind();

    var statusInput = body.querySelector("#cc-status-spec");
    statusInput.addEventListener("input", function () {
      var r = parseStatusSpec(statusInput.value);
      var el = body.querySelector("#cc-status-error");
      el.textContent = r.error || "";
      el.style.display = r.error ? "" : "none";
    });

    // ── Sources preview ──
    var previewTimer = null;
    var previewSeq = 0;
    function schedulePreview() {
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = setTimeout(runPreview, 400);
    }
    function previewShell(head, inner) {
      body.querySelector("#cc-preview").innerHTML = '<div style="font-size:0.85rem;margin-bottom:0.5rem">' + head + "</div>" + (inner || "");
    }
    async function runPreview() {
      var sc = collectScope();
      if (sc.error && !pins.size) { previewShell('<span class="hint">' + esc(sc.error) + "</span>"); return; }
      var seq = ++previewSeq;
      previewShell('<span class="hint">Resolving agent hosts…</span>');
      try {
        var res = await api.connectivityChecks.previewSources({ scope: sc.scope || {}, assetIds: Array.from(pins) });
        if (seq !== previewSeq) return;
        renderPreview(res);
      } catch (err) {
        if (seq === previewSeq) previewShell('<span class="hint">' + esc(err.message || "Preview unavailable") + "</span>");
      }
    }
    function renderPreview(res) {
      var head = "<strong>" + res.total + "</strong> agent host" + (res.total === 1 ? "" : "s") + " will run this check" +
        (res.pinned ? " (" + res.pinned + " pinned)" : "") +
        (res.total > res.agents.length ? " · showing the first " + res.agents.length : "") +
        (res.matchedWithoutAgent ? ' · <span class="hint">' + res.matchedWithoutAgent + " matching device(s) have no active agent</span>" : "");
      var rows = res.agents.map(function (a) {
        return '<tr><td style="width:28px"><input type="checkbox" class="cc-pin" data-id="' + esc(a.assetId) + '" title="Pin this host — it keeps running the check even if the filter stops matching"' + (pins.has(a.assetId) ? " checked" : "") + ' style="width:auto"></td>' +
          '<td><span title="' + (a.online ? "online" : "offline") + '" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + (a.online ? "var(--color-success,#2a9d8f)" : "var(--color-text-tertiary)") + '"></span></td>' +
          "<td>" + esc(a.hostname || a.ipAddress || a.assetId) + (a.pinnedOnly ? ' <span class="tag-chip">pinned — outside filter</span>' : "") + "</td>" +
          "<td>" + esc(a.ipAddress || "") + "</td>" +
          '<td style="font-size:0.8rem">' + esc(a.os || "") + "</td>" +
          "<td><code>" + esc(a.agentVersion ? "v" + a.agentVersion : "—") + "</code>" +
            (a.supported ? "" : ' <span class="hint" title="Connectivity checks need agent ' + esc(res.minAgentVersion) + '+">upgrade</span>') + "</td></tr>";
      }).join("");
      var missing = (res.pinnedWithoutAgent || []).map(function (a) {
        return '<li>' + esc(a.hostname || a.ipAddress || a.assetId) + " — pinned, but has no active agent</li>";
      }).join("");
      previewShell(head, (rows ? '<table class="data-table" style="width:100%"><tbody>' + rows + "</tbody></table>" : '<p class="hint">No agent hosts match.</p>') +
        (missing ? '<ul class="hint" style="margin:0.5rem 0 0 1rem">' + missing + "</ul>" : ""));
      body.querySelectorAll(".cc-pin").forEach(function (cb) {
        cb.addEventListener("change", function () {
          if (cb.checked) pins.add(cb.dataset.id); else pins.delete(cb.dataset.id);
          schedulePreview();
        });
      });
    }
    function collectScope() {
      if (allCb.checked) return { scope: { allAssets: true } };
      var group = body.querySelector("#cc-cond-root > .scg-group");
      var tree = group ? builder.collect(group) : { op: "and", children: [] };
      if (!tree.children.length) return { scope: {}, error: 'Add a condition, pin a host, or check "All agent hosts".' };
      var problem = builder.validate(tree);
      if (problem) return { scope: {}, error: problem };
      return { scope: { condition: tree } };
    }
    runPreview();

    // ── Save ──
    document.getElementById("cc-cancel").addEventListener("click", closeModal);
    document.getElementById("cc-save").addEventListener("click", async function () {
      var sc = collectScope();
      var payload = collectCheck(body, sc.scope || {}, Array.from(pins));
      var problem = validateCheck(payload);
      if (!problem && sc.error && !pins.size && !(payload.scope && payload.scope.allAssets)) problem = { tab: "sources", message: sc.error };
      if (problem) {
        var tabBtn = document.querySelector('#cc-tabs .page-tab[data-tab="' + problem.tab + '"]');
        if (tabBtn) tabBtn.click();
        showToast(problem.message, "error");
        return;
      }
      var btn = document.getElementById("cc-save");
      btn.disabled = true;
      try {
        if (editingId) await api.connectivityChecks.update(editingId, payload);
        else await api.connectivityChecks.create(payload);
        closeModal();
        showToast(editingId ? "Check saved" : "Check created — agents pick it up within a few minutes", "success");
        loadTab();
      } catch (err) {
        btn.disabled = false;
        showToast(err.message || "Save failed", "error");
      }
    });
  }

  function uniqueName(base) {
    var names = new Set(_checks.map(function (c) { return c.name; }));
    if (!names.has(base)) return base;
    for (var i = 2; i < 100; i++) {
      var n = base + " " + i;
      if (!names.has(n)) return n;
    }
    return base + " " + Date.now();
  }

  /** Read the whole form into the POST body. Pure over the DOM (tested). */
  function collectCheck(root, scope, assetIds) {
    var v = function (id) { var el = root.querySelector("#" + id); return el ? el.value : ""; };
    var on = function (id) { var el = root.querySelector("#" + id); return !!(el && el.checked); };
    var kind = v("cc-kind");
    var isHttp = kind === "http" || kind === "https";
    var mode = v("cc-body-mode");
    var pattern = v("cc-body-pattern");
    var out = {
      name: v("cc-name").trim(),
      description: v("cc-description").trim() || null,
      enabled: on("cc-enabled"),
      kind: kind,
      target: v("cc-target").trim(),
      intervalSec: Math.round(Number(v("cc-interval-min")) || 1) * 60,
      timeoutMs: Math.round(Number(v("cc-timeout-ms")) || 5000),
      http: isHttp ? {
        expectStatus: v("cc-status-spec").trim(),
        bodyMatch: mode && pattern ? { mode: mode, pattern: pattern, caseSensitive: on("cc-body-case") } : null,
        verifyTls: kind === "https" ? on("cc-verify-tls") : false,
      } : null,
      traceroute: {
        enabled: on("cc-tr-enabled"),
        everyNRuns: Math.round(Number(v("cc-tr-every")) || 5),
        maxHops: Math.round(Number(v("cc-tr-maxhops")) || 30),
        probesPerHop: Math.round(Number(v("cc-tr-probes")) || 3),
      },
      keepBodyExcerpt: isHttp && on("cc-keep-excerpt"),
      scope: scope,
      assetIds: assetIds || [],
    };
    return out;
  }

  /** The client half of the server's validation; returns {tab, message} or null. */
  function validateCheck(p) {
    if (!p.name) return { tab: "general", message: "Name is required" };
    if (!p.target) return { tab: "general", message: "Target is required" };
    if (p.kind === "http" || p.kind === "https") {
      if (!/^https?:\/\//i.test(p.target) || p.target.toLowerCase().indexOf(p.kind + "://") !== 0) {
        return { tab: "general", message: "A " + p.kind.toUpperCase() + " check needs a " + p.kind + ":// URL" };
      }
    } else if (p.kind === "tcp" && !/:\d{1,5}$/.test(p.target)) {
      return { tab: "general", message: "A TCP check needs host:port" };
    }
    var minutes = p.intervalSec / 60;
    if (!(minutes >= 1 && minutes <= 60)) return { tab: "general", message: "Interval must be 1–60 minutes" };
    if (!(p.timeoutMs >= 500 && p.timeoutMs <= 30000)) return { tab: "general", message: "Timeout must be 500–30000 ms" };
    if (p.timeoutMs * 2 > p.intervalSec * 1000) return { tab: "general", message: "Timeout must be at most half the interval" };
    if (p.http) {
      var s = parseStatusSpec(p.http.expectStatus);
      if (s.error) return { tab: "expect", message: "Accepted status codes: " + s.error };
      if (p.http.bodyMatch && p.http.bodyMatch.mode === "regex") {
        try { new RegExp(p.http.bodyMatch.pattern); } catch (e) { return { tab: "expect", message: "Invalid regular expression: " + e.message }; }
        if (/\(\?<?[=!]/.test(p.http.bodyMatch.pattern)) return { tab: "expect", message: "Lookahead / lookbehind is not supported (the agent uses RE2)" };
      }
    }
    var hasScope = p.scope && (p.scope.allAssets || p.scope.condition);
    if (!hasScope && !(p.assetIds && p.assetIds.length)) {
      return { tab: "sources", message: 'Add a condition, pin a host, or check "All agent hosts"' };
    }
    return null;
  }

  // ─── Results (fleet view) ───────────────────────────────────────────────

  async function openResults(check) {
    var head = kindBadge(check.kind) + ' <code style="font-size:0.85rem">' + esc(check.target) + "</code> · " + esc(intervalLabel(check.intervalSec));
    var body = '<div id="conn-res-head" style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;margin-bottom:0.75rem">' + head +
        '<span id="conn-res-summary" style="margin-left:auto"></span></div>' +
      '<div class="table-wrapper table-wrapper-modal-sticky" style="max-height:60vh">' +
        '<table><thead><tr>' +
          '<th data-sf-key="hostname" data-sf-type="string">Host</th>' +
          '<th data-sf-key="lastOk" data-sf-type="string" style="width:110px">Result</th>' +
          '<th data-sf-key="lastLatencyMs" data-sf-type="number" data-sf-nofilter="true" style="width:100px">Latency</th>' +
          '<th data-sf-key="lastHttpStatus" data-sf-type="number" style="width:80px">Status</th>' +
          '<th data-sf-key="lastResolvedIp" data-sf-type="string" style="width:130px">Resolved IP</th>' +
          '<th data-sf-key="lastHopCount" data-sf-type="number" data-sf-nofilter="true" style="width:70px">Hops</th>' +
          '<th data-sf-key="lastSampleAt" data-sf-type="date" style="width:140px">Last result</th>' +
          '<th data-sf-key="lastError" data-sf-type="string">Error</th>' +
        '</tr></thead><tbody id="conn-res-tbody"><tr><td colspan="8" class="empty-state">Loading…</td></tr></tbody></table>' +
      "</div>";
    var footer = '<button class="btn btn-secondary" id="conn-res-refresh">Refresh</button>' +
      (canEdit() ? '<button class="btn btn-secondary" id="conn-res-edit">Edit</button>' : "") +
      '<button class="btn btn-primary" id="conn-res-close">Close</button>';
    openModal("Results — " + check.name, body, footer, { large: true });
    var tbody = document.getElementById("conn-res-tbody");
    tbody.dataset.checkId = check.id;
    var sf = typeof TableSF === "function" ? new TableSF("conn-res-tbody", function () { draw(); }) : null;
    var rows = [];

    function draw() {
      var data = sf ? sf.apply(rows.slice()) : rows;
      if (!data.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-state">' +
          (rows.length ? "No hosts match the filters." : "No hosts run this check. Check its Sources, and that the hosts run agent 0.21.0 or later.") + "</td></tr>";
        return;
      }
      tbody.innerHTML = data.map(function (r) {
        var dot = '<span title="' + (r.online ? "agent online" : "agent offline") + '" style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:' +
          (r.online ? "var(--color-success,#2a9d8f)" : "var(--color-text-tertiary)") + '"></span>';
        return "<tr>" +
          '<td>' + dot + '<button type="button" class="row-menu-trigger conn-res-host" data-id="' + esc(r.assetId) + '">' + esc(r.hostname || r.ipAddress || r.assetId) + "</button>" +
            (r.supported ? "" : ' <span class="hint" title="Needs agent 0.21.0+">upgrade agent</span>') + "</td>" +
          "<td>" + resultPill(r.lastOk, !!r.lastSampleAt) + "</td>" +
          "<td>" + (r.lastLatencyMs != null ? Math.round(r.lastLatencyMs) + " ms" : "—") + "</td>" +
          "<td>" + (r.lastHttpStatus != null ? r.lastHttpStatus : "—") + "</td>" +
          "<td>" + esc(r.lastResolvedIp || "—") + "</td>" +
          "<td>" + (r.lastHopCount != null ? r.lastHopCount + (r.lastTracerouteComplete ? " ✓" : "") : "—") + "</td>" +
          "<td>" + esc(fmtWhen(r.lastSampleAt)) + "</td>" +
          '<td class="cell-wrap" style="font-size:0.8rem">' + esc(r.lastOk === false ? (r.lastError || "") : "") + "</td>" +
          "</tr>";
      }).join("");
      tbody.querySelectorAll(".conn-res-host").forEach(function (b) {
        b.addEventListener("click", function () {
          showRowMenu(b, [{
            label: "Open asset — Connectivity tab",
            onSelect: function () { if (typeof openViewModal === "function") openViewModal(b.dataset.id, { tab: "connectivity" }); },
          }]);
        });
      });
    }

    async function load() {
      try {
        var res = await api.connectivityChecks.results(check.id);
        if (tbody.dataset.checkId !== check.id || !document.body.contains(tbody)) return;
        rows = (res.results || []).map(function (r) { return Object.assign({}, r, { lastOk: r.lastOk === null ? null : r.lastOk }); });
        var passing = rows.filter(function (r) { return r.lastOk === true; }).length;
        var summary = document.getElementById("conn-res-summary");
        if (summary) summary.innerHTML = "<strong>" + passing + "</strong> of " + rows.length + " hosts passing";
        draw();
      } catch (err) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-state">' + esc(err.message || "Failed to load results") + "</td></tr>";
      }
    }
    load();
    var timer = setInterval(function () {
      if (!document.body.contains(tbody) || tbody.dataset.checkId !== check.id) { clearInterval(timer); return; }
      if (document.visibilityState === "visible") load();
    }, Math.max(60, check.intervalSec || 60) * 1000);
    document.getElementById("conn-res-refresh").addEventListener("click", load);
    document.getElementById("conn-res-close").addEventListener("click", closeModal);
    var editBtn = document.getElementById("conn-res-edit");
    if (editBtn) editBtn.addEventListener("click", function () { clearInterval(timer); openCheckModal(check); });
  }

  // ─── Page boot (/connections.html) ──────────────────────────────────────
  // Permissions resolve asynchronously via /auth/me (userReady); reading them
  // at load would see an empty matrix and hide the add button.
  function bootPage() {
    if (!document.getElementById("conn-page")) return;
    var add = document.getElementById("btn-add-check");
    if (add) {
      add.style.display = canEdit() ? "" : "none";
      if (!add._wired) { add._wired = true; add.addEventListener("click", function () { openCheckModal(null); }); }
    }
    var refresh = document.getElementById("btn-refresh-checks");
    if (refresh && !refresh._wired) { refresh._wired = true; refresh.addEventListener("click", loadTab); }
    loadTab();
  }
  if (typeof document !== "undefined" && document.getElementById) {
    if (typeof userReady !== "undefined" && userReady && userReady.then) userReady.then(bootPage);
    else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bootPage);
    else bootPage();
  }

  window.PolarisConnectivityChecks = {
    loadTab: loadTab,
    renderList: renderList,
    openCheckModal: openCheckModal,
    openResults: openResults,
    menuItems: menuItems,
    parseStatusSpec: parseStatusSpec,
    validateCheck: validateCheck,
    collectCheck: collectCheck,
  };
})();
