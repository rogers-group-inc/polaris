/**
 * public/js/path-checks.js — Path Monitor page (/path-monitor.html).
 *
 * Path checks: an HTTP / HTTPS / TCP / ICMP check (+ an optional
 * traceroute) run from every source the check picks — the Polaris Agent on
 * each matching host, or this Polaris server itself (one toggle picks). This file owns the
 * list, the check wizard (General → Expectations → Traceroute → Sources, a
 * stepper with Back / Next — the automations wizard's idiom, its own steps)
 * and the fleet Results view. The per-source charts and hop table live in
 * assets.js (the slide-over's Paths tab, which the Results view reuses for
 * the server's own row).
 *
 * A check has NO threshold — the SLA is an automation on the path* metrics
 * (business rule 85) — so nothing here offers one.
 *
 * Gates: pathChecks read (see the list, open Results) / write
 * (create, edit, duplicate, enable, delete). UP_TO_WRITE ladder — never test
 * fullwrite on it (rule 43d). Aiming the SERVER at a target is chained on
 * networkScan write as well (canRunOnServer) — the server enforces it; the
 * toggle only says so up front.
 */
(function () {
  "use strict";

  // ─── Status spec (MIRROR) ───────────────────────────────────────────────
  // Mirrors parseStatusSpec in src/utils/httpCheck.ts and the Go agent's copy
  // (agent/internal/collectors/path_check_http.go). Pinned to the server by
  // tests/unit/pathCheckStatusSpecParity.test.ts — change all three.
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

  function canRead() { return typeof permAtLeast === "function" && permAtLeast("pathChecks", "read"); }
  function canEdit() { return typeof permAtLeast === "function" && permAtLeast("pathChecks", "write"); }
  function canRunOnServer() { return typeof permAtLeast === "function" && permAtLeast("networkScan", "write"); }

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
  var UNEXPECTED_COLOR = "#e07b00";

  /**
   * Pure (tested): a source's latest run as one word. A failed run that still
   * got an HTTP answer is "Unexpected response" — the target answered, just
   * not with what the check expects (status code or body match).
   */
  function resultState(lastOk, lastHttpStatus) {
    if (lastOk === true) return "ok";
    if (lastOk === false) return lastHttpStatus != null ? "unexpected" : "fail";
    return null;
  }
  var RESULT_LABELS = { ok: "OK", fail: "Fail", unexpected: "Unexpected response" };
  var RESULT_COLORS = { ok: OK_COLOR, fail: FAIL_COLOR, unexpected: UNEXPECTED_COLOR };

  function resultPill(lastOk, hasSample, lastHttpStatus) {
    var st = hasSample ? resultState(lastOk, lastHttpStatus) : null;
    if (!st) return '<span style="color:var(--color-text-tertiary)">no result yet</span>';
    return '<span class="badge" style="background:' + RESULT_COLORS[st] + ';color:#fff">' + RESULT_LABELS[st] + "</span>";
  }

  /**
   * Pure (tested): a check's Result cell across all its sources, no counts.
   * A source that got no answer at all outranks one that got the wrong answer.
   */
  function checkResultState(c) {
    var fail = c.failCount || 0;
    var unexpected = Math.min(c.unexpectedCount || 0, fail);
    if (fail > unexpected) return "fail";
    if (unexpected) return "unexpected";
    if (c.okCount) return "ok";
    return null;
  }

  // ─── List ───────────────────────────────────────────────────────────────

  var _checks = [];
  var _sf = null;
  var _layout = null;
  var _page = 1;
  var _pageSize = 25;

  function savePrefs() {
    if (typeof currentUsername === "undefined" || typeof PolarisPrefs === "undefined") return;
    PolarisPrefs.save("pathChecks", currentUsername, Object.assign(
      { pageSize: _pageSize, layout: _layout ? _layout.getPrefs() : null },
      _sf ? _sf.getPrefs() : {},
    ));
  }

  function restorePrefs() {
    if (typeof currentUsername === "undefined" || typeof PolarisPrefs === "undefined") return;
    var p = PolarisPrefs.load("pathChecks", currentUsername);
    if (!p) return;
    if (p.pageSize) _pageSize = p.pageSize;
    if (_layout && p.layout) _layout.setPrefs(p.layout);
    if (_sf) _sf.setPrefs(p);
  }

  function initTable() {
    var tbody = document.getElementById("path-tbody");
    if (!tbody || _sf) return;
    var table = tbody.closest("table");
    // TableSF first, then setupColumnLayout (TableSF rewrites th innerHTML).
    _sf = new TableSF("path-tbody", function () { _page = 1; renderList(); savePrefs(); });
    _layout = setupColumnLayout(table, { onChange: savePrefs });
    restorePrefs();
  }

  async function loadTab() {
    if (!canRead()) return;
    initTable();
    try {
      var res = await api.pathChecks.list();
      _checks = (res && res.checks) || [];
      renderList();
    } catch (err) {
      var tb = document.getElementById("path-tbody");
      if (tb) tb.innerHTML = '<tr><td colspan="10" class="empty-state">' + esc(err.message || "Failed to load path checks") + "</td></tr>";
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

  /** Results row verbs, pure (tested): the server has no asset to open. */
  function resultRowMenu(isServer, handlers) {
    if (isServer) return [{ label: "Show charts and path", onSelect: handlers.openServer }];
    return [{ label: "Open asset — Paths tab", onSelect: handlers.openAsset }];
  }

  function renderList() {
    var tbody = document.getElementById("path-tbody");
    if (!tbody) return;
    var editor = canEdit();
    var data = _checks.map(function (c) {
      return Object.assign({}, c, { tracerouteEnabled: !!(c.traceroute && c.traceroute.enabled) ? "true" : "false" });
    });
    if (_sf) data = _sf.apply(data);
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="empty-state">' +
        (_checks.length ? "No checks match the filters." : "No path checks yet" + (editor ? ' — click "+ Add check" to create one.' : ".")) +
        "</td></tr>";
      if (typeof clearPageControls === "function") clearPageControls("path-pagination");
      return;
    }
    var totalPages = Math.max(1, Math.ceil(data.length / _pageSize));
    if (_page > totalPages) _page = totalPages;
    var rows = data.slice((_page - 1) * _pageSize, _page * _pageSize);
    renderPageControls("path-pagination", data.length, _pageSize, _page,
      function (p) { _page = p; renderList(); },
      function (size) { _pageSize = size; _page = 1; renderList(); savePrefs(); });

    tbody.innerHTML = rows.map(function (c) {
      var result;
      if (!c.sourceCount) result = '<span style="color:var(--color-text-tertiary)">no sources</span>';
      else {
        var st = checkResultState(c);
        result = st
          ? '<strong style="color:' + RESULT_COLORS[st] + '">' + RESULT_LABELS[st] + "</strong>"
          : '<span style="color:var(--color-text-tertiary)">no results yet</span>';
      }
      var enabledCell = editor
        ? '<label class="toggle-switch" title="' + (c.enabled ? "Enabled — click to disable" : "Disabled — click to enable") + '">' +
            '<input type="checkbox" class="path-enabled-toggle" data-id="' + esc(c.id) + '"' + (c.enabled ? " checked" : "") + '>' +
            '<span class="toggle-slider"></span></label>'
        : (c.enabled ? "Yes" : '<span style="color:var(--color-text-tertiary)">No</span>');
      return "<tr>" +
        '<td><button type="button" class="row-menu-trigger path-menu" data-id="' + esc(c.id) + '" aria-haspopup="menu" aria-expanded="false" title="Actions for this check">' + esc(c.name) + "</button></td>" +
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

    tbody.querySelectorAll(".path-menu").forEach(function (b) {
      b.addEventListener("click", function () {
        var c = _checks.find(function (x) { return x.id === b.dataset.id; });
        if (c) showRowMenu(b, menuItems(c, { canEdit: editor }));
      });
    });
    tbody.querySelectorAll(".path-enabled-toggle").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var c = _checks.find(function (x) { return x.id === cb.dataset.id; });
        if (c) toggleEnabled(c, cb.checked, cb);
      });
    });
  }

  async function toggleEnabled(check, enabled, cb) {
    if (cb) cb.disabled = true;
    try {
      await api.pathChecks.setEnabled(check.id, enabled);
      showToast("Check " + (enabled ? "enabled" : "disabled"), "success");
      loadTab();
    } catch (err) {
      if (cb) { cb.checked = !enabled; cb.disabled = false; }
      showToast(err.message || "Update failed", "error");
    }
  }

  async function deleteCheck(check) {
    var ok = await showConfirm('Delete path check "' + check.name + '"? Agents stop running it on their next config refresh. ' +
      "Its past results age out on the retention schedule, and automations filtered to it will stop matching.");
    if (!ok) return;
    try {
      await api.pathChecks.delete(check.id);
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
    return field("Name", '<input type="text" id="pc-name" maxlength="120" value="' + esc(c.name || "") + '">') +
      field("Description", '<input type="text" id="pc-description" maxlength="1000" value="' + esc(c.description || "") + '">') +
      field("Kind",
        '<select id="pc-kind">' + ["https", "http", "tcp", "icmp"].map(function (k) {
          return '<option value="' + k + '">' + KIND_LABELS[k] + "</option>";
        }).join("") + "</select>",
        "HTTP / HTTPS send one GET (or HEAD) and judge the status (and body, if set). TCP opens a connection. ICMP sends one ping.") +
      '<div class="form-group"><label id="pc-target-label">' + esc(hint.label) + '</label>' +
        '<input type="text" id="pc-target" maxlength="512" placeholder="' + esc(hint.placeholder) + '" value="' + esc(c.target || "") + '">' +
        '<p class="hint" style="margin:4px 0 0">Loopback, link-local, multicast and IPv6 targets are refused, as is this Polaris server. Credentials in a URL are not supported.</p></div>' +
      '<div style="display:flex;gap:1rem;flex-wrap:wrap">' +
        field("Every (minutes)", '<input type="number" id="pc-interval-min" min="1" max="60" step="1" value="' + Math.round((c.intervalSec || 60) / 60) + '" style="max-width:120px">') +
        field("Timeout (ms)", '<input type="number" id="pc-timeout-ms" min="500" max="30000" step="100" value="' + (c.timeoutMs || 5000) + '" style="max-width:140px">', "At most half the interval.") +
      "</div>" +
      requestSectionHtml(c) +
      checkboxLine("pc-enabled", "Enabled", c.enabled !== false);
  }

  // ─── Request options (HTTP / HTTPS) ────────────────────────────────────
  // Method (GET / HEAD — never anything that writes), a Host header override,
  // following redirects, and authentication with an http Credential. A check
  // that authenticates runs ONLY from this Polaris server, so the secret never
  // reaches an agent (business rule 85). The first three need agent 0.23.0+.

  var _httpCredentials = null; // [{id, name, authMode}] — null: not loaded / not permitted

  function authModeLabel(m) { return m === "bearer" ? "Bearer token" : m === "basic" ? "Basic" : m === "digest" ? "Digest" : m; }

  /** Pure: which stored credentials a path check can authenticate with (tested). */
  function usableHttpCredentials(list) {
    return (list || []).filter(function (cr) {
      if (!cr || cr.type !== "http") return false;
      var cfg = cr.config || {};
      var mode = cfg.authMode || (cfg.apiToken ? "bearer" : cfg.username ? "basic" : "");
      return mode === "bearer" || mode === "basic" || mode === "digest";
    }).map(function (cr) {
      var cfg = cr.config || {};
      return { id: cr.id, name: cr.name, authMode: cfg.authMode || (cfg.apiToken ? "bearer" : "basic") };
    });
  }

  function requestSectionHtml(c) {
    var http = c.http || {};
    var credOptions = '<option value="">None</option>';
    var creds = _httpCredentials;
    var current = c.credentialId || "";
    var listed = false;
    (creds || []).forEach(function (cr) {
      if (cr.id === current) listed = true;
      credOptions += '<option value="' + esc(cr.id) + '">' + esc(cr.name) + " (" + esc(authModeLabel(cr.authMode)) + ")</option>";
    });
    // A stored credential this caller cannot list still shows as chosen.
    if (current && !listed) credOptions += '<option value="' + esc(current) + '">(the credential this check uses)</option>';
    var credHint = creds === null
      ? "Listing credentials needs the <strong>Credentials</strong> permission."
      : !creds.length
        ? "No HTTP credentials with Bearer, Basic or Digest yet. Add one under Server Settings → Credentials."
        : "A check that authenticates runs <strong>only from this Polaris server</strong>, so the password or token never leaves it.";
    return '<div id="pc-request-fields">' + formDivider() + sectionHeading("Request") +
      '<div style="display:flex;gap:1rem;flex-wrap:wrap">' +
        field("Method", '<select id="pc-method" style="max-width:140px"><option value="GET">GET</option><option value="HEAD">HEAD</option></select>',
          "HEAD fetches the headers only — no body to check.") +
        '<div style="flex:1;min-width:220px">' +
          field("Host header", '<input type="text" id="pc-host-header" maxlength="260" placeholder="(the URL\'s host)" value="' + esc(http.hostHeader || "") + '">',
            "Sent instead of the URL's host (and used for TLS), so you can point the URL at one server's address and still ask for the site by name.") +
        "</div>" +
      "</div>" +
      checkboxLine("pc-follow-redirects", "Follow redirects", http.followRedirects === true,
        "Up to 5, each new address checked like the first. The check judges the final response. Authentication and the Host header go only to the original site, never to a redirect that leaves it.") +
      field("Authentication", '<select id="pc-credential"' + (creds === null && !current ? " disabled" : "") + ">" + credOptions + "</select>", credHint) +
      '<p id="pc-auth-cleartext" style="display:none;font-size:0.8rem;color:var(--color-warning,#b26a00);margin:-0.5rem 0 0.75rem">Basic and Bearer over plain HTTP send the secret unencrypted. Prefer an HTTPS URL, or Digest.</p>' +
      '<p id="pc-agent-version-note" style="display:none;font-size:0.8rem;color:var(--color-text-tertiary);margin:0 0 0.75rem">Agent hosts need Polaris Agent 0.23.0 or later to run a check with these options; older agents skip it and show <em>upgrade agent</em>.</p>' +
    "</div>";
  }

  function expectationsTab(c) {
    var http = c.http || {};
    var bm = http.bodyMatch || null;
    return '<div id="pc-http-fields">' +
        field("Accepted status codes",
          '<input type="text" id="pc-status-spec" placeholder="200-299" value="' + esc(http.expectStatus || "") + '">',
          'Codes and ranges, comma-separated — e.g. <code>200,204,300-399</code>. Blank means any 2xx. Unless the check follows redirects (General step), a 302 is judged as a 302.') +
        '<p class="hint" id="pc-status-error" style="color:var(--color-danger,#d32f2f);display:none;margin:-0.5rem 0 0.75rem"></p>' +
        field("Body must",
          '<select id="pc-body-mode"><option value="">(no body check)</option><option value="contains">contain</option>' +
            '<option value="exact">equal exactly</option><option value="regex">match the regular expression</option>' +
            '<option value="!contains">NOT contain</option><option value="!exact">NOT equal exactly</option><option value="!regex">NOT match the regular expression</option></select>' +
          '<input type="text" id="pc-body-pattern" maxlength="1024" style="margin-top:6px" value="' + esc(bm ? bm.pattern : "") + '">',
          "Checked in the first 64 KB. Regular expressions use RE2 syntax (the agent's): no lookahead / lookbehind or backreferences.") +
        checkboxLine("pc-body-case", "Case-sensitive", !!(bm && bm.caseSensitive)) +
        '<div id="pc-tls-row">' + checkboxLine("pc-verify-tls", "Verify the TLS certificate", http.verifyTls !== false,
          "Off accepts any certificate — the check still reports its issuer and expiry.") + "</div>" +
        checkboxLine("pc-keep-excerpt", "Keep a body excerpt on every run", !!c.keepBodyExcerpt,
          "Every run stores a SHA-256 fingerprint and the size of the body. Up to 4 KB of the body itself is kept only when a run fails — or on every run with this on. Response bodies can contain sensitive data.") +
      "</div>" +
      '<div id="pc-nonhttp-note" style="display:none">' + infoBox("TCP and ICMP checks pass when the connection (or the echo reply) arrives within the timeout. There is nothing else to expect.") + "</div>" +
      testBlockHtml();
  }

  // ─── Test run (Expectations step) ──────────────────────────────────────
  // POST /path-checks/test runs the DRAFT once from this Polaris server and
  // hands back what came back, so the expectation is written from the real
  // answer rather than guessed. Same gate as running from the server.

  function testBlockHtml() {
    var may = canRunOnServer();
    return formDivider() +
      '<div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap">' +
        '<button type="button" class="btn btn-secondary" id="pc-test"' + (may ? "" : " disabled") + ">Test from this Polaris server</button>" +
        '<span style="' + TEST_HINT + ';flex:1;min-width:240px">' + (may
          ? "Sends the request once, with these expectations, and shows what came back. Nothing is saved."
          : "Testing needs <strong>Read-Write on Network Discovery</strong>, because the server sends the request from its own network.") + "</span>" +
      "</div>" +
      '<div id="pc-test-result" style="margin-top:0.75rem"></div>';
  }

  var TEST_HINT = "font-size:0.8rem;color:var(--color-text-tertiary);margin:0";

  function fmtDay(v) {
    var d = new Date(v);
    if (isNaN(d.getTime())) return "—";
    try { return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); } catch (_) { return d.toDateString(); }
  }

  function fmtMs(v) { return typeof v === "number" ? (v < 10 ? Math.round(v * 10) / 10 : Math.round(v)) + " ms" : null; }

  /** Pure: the test result panel (tested). `res` is POST /path-checks/test. */
  function testResultHtml(res) {
    var sm = (res && res.sample) || {};
    var pill = '<span class="badge" style="background:' + (sm.ok ? OK_COLOR : FAIL_COLOR) + ';color:#fff">' + (sm.ok ? "Passes" : "Fails") + "</span>";
    var facts = [];
    if (sm.httpStatus != null) {
      facts.push("<strong>HTTP " + esc(sm.httpStatus) + "</strong>" + (res.httpVersion ? ' <span style="' + TEST_HINT + '">HTTP/' + esc(res.httpVersion) + "</span>" : "") +
        ' <button type="button" class="btn btn-sm btn-secondary" id="pc-test-use-status" data-status="' + esc(sm.httpStatus) + '">Accept only ' + esc(sm.httpStatus) + "</button>");
    }
    [["Total", sm.latencyMs], ["DNS", sm.dnsMs], ["Connect", sm.connectMs], ["TLS", sm.tlsMs], ["TTFB", sm.ttfbMs]].forEach(function (p) {
      var v = fmtMs(p[1]);
      if (v) facts.push(p[0] + " " + v);
    });
    if (sm.resolvedIp) facts.push("Resolved " + esc(sm.resolvedIp));
    if (res && res.finalUrl) facts.push("Redirected to <code>" + esc(res.finalUrl) + "</code>");
    if (sm.tlsIssuer) facts.push("TLS issuer " + esc(sm.tlsIssuer));
    if (sm.tlsNotAfter) facts.push("TLS expires " + esc(fmtDay(sm.tlsNotAfter)));
    if (sm.bodyBytes != null) facts.push(esc(sm.bodyBytes) + " bytes" + (sm.bodyBytes >= 65536 ? " (first 64 KB read)" : ""));
    var html = '<div style="display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap;margin-bottom:0.5rem">' + pill +
        (sm.ok ? '<span style="' + TEST_HINT + '">with the expectations above</span>'
               : '<span style="color:' + FAIL_COLOR + ';font-size:0.85rem">' + esc(sm.error || "failed") + "</span>") +
      "</div>" +
      (facts.length ? '<div style="display:flex;gap:0.35rem 1rem;flex-wrap:wrap;font-size:0.85rem;margin-bottom:0.5rem">' +
        facts.map(function (f) { return "<span>" + f + "</span>"; }).join("") + "</div>" : "");
    var headers = res && res.headers;
    if (headers && Object.keys(headers).length) {
      html += '<details style="margin-bottom:0.5rem"><summary style="cursor:pointer;font-size:0.85rem">Response headers (' + Object.keys(headers).length + ")</summary>" +
        '<table class="data-table" style="width:100%;font-size:0.8rem;margin-top:0.35rem"><tbody>' +
        Object.keys(headers).map(function (k) {
          return '<tr><td style="width:30%;font-family:var(--font-mono,monospace)">' + esc(k) + '</td><td style="word-break:break-all">' + esc(headers[k]) + "</td></tr>";
        }).join("") + "</tbody></table></details>";
    }
    if (res && typeof res.body === "string") {
      html += '<div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.35rem">' +
          '<span style="font-size:0.85rem;font-weight:600">Response body</span>' +
          '<span style="' + TEST_HINT + '">Select text below, then</span>' +
          '<button type="button" class="btn btn-sm btn-secondary" id="pc-test-use-sel">Require the selected text</button>' +
        "</div>" +
        (res.body
          ? '<pre id="pc-test-body" style="max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:0.75rem;background:var(--color-bg-subtle,rgba(127,127,127,0.08));padding:0.5rem;border-radius:var(--radius-md);margin:0">' + esc(res.body) + "</pre>"
          : '<p style="' + TEST_HINT + '">(empty body)</p>');
    }
    html += '<p style="' + TEST_HINT + ';margin-top:0.5rem">Tested from this Polaris server. Agent hosts can get a different answer — another network, DNS server or proxy.</p>';
    return html;
  }

  function tracerouteTab(c) {
    var t = c.traceroute || {};
    var num = function (id, label, v, min, max) {
      return field(label, '<input type="number" id="' + id + '" min="' + min + '" max="' + max + '" value="' + v + '" style="max-width:120px">');
    };
    return checkboxLine("pc-tr-enabled", "Trace the route", t.enabled !== false,
        "Also runs immediately whenever a run fails after a passing one, so a failure always has a fresh path. Each hop is matched to the device Polaris monitors at that address.") +
      '<div style="display:flex;gap:1rem;flex-wrap:wrap">' +
        num("pc-tr-every", "Every N runs", t.everyNRuns || 5, 1, 100) +
        num("pc-tr-maxhops", "Max hops", t.maxHops || 30, 1, 64) +
        num("pc-tr-probes", "Probes per hop", t.probesPerHop || 3, 1, 5) +
      "</div>" +
      '<p class="hint">A changed hop sequence is written to Events as <code>path_check.path_changed</code>, which an automation can alert on. macOS agents do not trace in this version.</p>';
  }

  /** The step's question, then one line of explanation (the wizard canon). */
  function stepHead(question, explain) {
    return '<h3 style="margin:0 0 0.25rem">' + esc(question) + "</h3>" +
      '<p style="margin:0 0 1rem;color:var(--color-text-tertiary);font-size:0.85rem">' + esc(explain) + "</p>";
  }

  function sourcesTab(c) {
    var mayServer = canRunOnServer();
    // One toggle picks the source: on, this server runs the check; off, the
    // agent hosts the filter below selects. The filter is hidden (and not
    // collected) while the server is the source.
    return '<div class="form-group"><label style="display:flex;align-items:center;gap:8px;font-weight:500">' +
        '<span class="toggle-switch"><input type="checkbox" id="pc-server"><span class="toggle-slider"></span></span>' +
        "Run from this Polaris server</label>" +
        '<p class="hint" style="margin:2px 0 0 42px">On: the server that hosts Polaris runs the check itself, whether it is installed on Linux or in a container, with no agent needed. ' +
        "Its results appear as the <strong>Polaris server</strong> row in Results, with the same charts and path graph; automations alert on agent hosts only, because the server is not an asset. " +
        "Off: the agent hosts you pick below run it." +
        (mayServer ? "" : " <strong>Needs Read-Write on Network Discovery</strong> as well as Path Monitor to turn on, because the server probes from its own network.") + "</p></div>" +
      '<div id="pc-server-only-note" style="display:none">' + infoBox("This check <strong>authenticates</strong>, so it runs only from this Polaris server — its credential is never sent to an agent. To run it from agent hosts instead, set Authentication to <em>None</em> on the General step.") + "</div>" +
      '<div id="pc-both-note" style="display:none">' + infoBox("This check runs from <strong>both</strong> this server and agent hosts. A check now has one source: saving with the toggle on keeps only the server; turning it off keeps only the agent hosts.") + "</div>" +
      '<div id="pc-agent-sources">' +
        formDivider() +
        sectionHeading("Agent hosts") +
        infoBox("An agent host runs a check only if it has an active <strong>Polaris Agent</strong> (0.21.0 or later). This filter is always combined with <em>Polaris Agent installed = yes</em>.") +
        checkboxLine("pc-all-hosts", "All agent hosts", false) +
        '<div id="pc-cond-wrap"><div id="pc-cond-root"></div></div>' +
        '<div class="aw-preview-box" id="pc-preview" style="margin-top:0.75rem;max-height:260px;overflow:auto"></div>' +
      "</div>";
  }

  /** The four steps, in the order the operator answers them. */
  var STEPS = [
    { key: "general", label: "General", question: "What should this check test?", explain: "Name it, pick the kind, and say where it points and how often it runs." },
    { key: "expect", label: "Expectations", question: "What counts as a pass?", explain: "For HTTP and HTTPS, the status codes and body text a run must see. TCP and ICMP pass when the target answers." },
    { key: "trace", label: "Traceroute", question: "Should it trace the route?", explain: "A traceroute records every hop between the source and the target, so a failure shows where the path broke." },
    { key: "sources", label: "Sources", question: "Where should it run from?", explain: "This Polaris server, or the agent hosts you pick. Each source keeps its own results." },
  ];

  /** Pure: the step (1-based) a validateCheck refusal belongs to. */
  function stepOfTab(tab) {
    for (var i = 0; i < STEPS.length; i++) if (STEPS[i].key === tab) return i + 1;
    return 1;
  }

  function stepperHtml() {
    var parts = [];
    STEPS.forEach(function (st, i) {
      var n = i + 1;
      if (i > 0) parts.push('<div class="stepper-line" data-line="' + (n - 1) + '"></div>');
      parts.push('<div class="stepper-step" data-step="' + n + '"><span class="stepper-num">' + n + "</span><span>" + esc(st.label) + "</span></div>");
    });
    return '<div class="stepper" id="pc-stepper">' + parts.join("") + "</div>";
  }

  async function openCheckModal(existing, opts) {
    opts = opts || {};
    if (!canEdit()) return;
    try {
      _filterSchema = _filterSchema || await api.pathChecks.filterSchema();
    } catch (err) {
      showToast(err.message || "Failed to load the device-filter vocabulary", "error");
      return;
    }
    var CB = window.PolarisConditionBuilder;
    if (!CB) { showToast("Condition builder failed to load — reload the page", "error"); return; }
    _httpCredentials = null;
    if (typeof permAtLeast === "function" && permAtLeast("credentials", "read") && api.credentials && api.credentials.list) {
      try { _httpCredentials = usableHttpCredentials(await api.credentials.list()); } catch (_) { _httpCredentials = null; }
    }

    var c = existing ? JSON.parse(JSON.stringify(existing)) : {
      kind: "https", intervalSec: 60, timeoutMs: 5000, enabled: true,
      http: { expectStatus: "", verifyTls: true, bodyMatch: null },
      traceroute: { enabled: true, everyNRuns: 5, maxHops: 30, probesPerHop: 3 },
      scope: { allAssets: true }, assetIds: [], runOnServer: false,
    };
    var editingId = existing && !opts.duplicate ? existing.id : null;
    if (opts.duplicate) { c.name = uniqueName((existing.name || "Check") + " (copy)"); c.enabled = false; }
    var pins = new Set(c.assetIds || []);
    var builder = CB.create({ meta: _filterSchema.scopeCondition, valueOptions: scopeValueOptions, onChange: schedulePreview });

    var panels = { general: generalTab(c), expect: expectationsTab(c), trace: tracerouteTab(c), sources: sourcesTab(c) };
    var bodyHtml = stepperHtml() + STEPS.map(function (st, i) {
      return '<div class="step-panel' + (i === 0 ? " visible" : "") + '" id="pc-step-' + (i + 1) + '">' +
        stepHead(st.question, st.explain) + panels[st.key] + "</div>";
    }).join("");
    var title = editingId ? "Edit Path Check" : "Add Path Check";
    var footer = '<button type="button" class="btn btn-secondary" id="pc-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-secondary" id="pc-back" style="display:none">&larr; Back</button>' +
      '<button type="button" class="btn btn-primary" id="pc-next">Next &rarr;</button>' +
      '<button type="button" class="btn btn-primary" id="pc-save" style="display:none">' + (editingId ? "Save Changes" : "Create") + "</button>";
    openModal(title, bodyHtml, footer, { wide: true });
    var body = document.querySelector("#modal-overlay .modal-body");
    // Edit mode unlocks every step (and shows Save throughout); a new check is
    // walked in order, each Next validating the step it leaves.
    var step = 1;
    var visited = editingId ? STEPS.length : 1;
    // Pin selects from the model (the happy-dom <option selected> trap, and
    // the reason product code sets .value rather than writing `selected`).
    body.querySelector("#pc-kind").value = c.kind || "https";
    body.querySelector("#pc-body-mode").value = c.http && c.http.bodyMatch ? (c.http.bodyMatch.negate ? "!" : "") + c.http.bodyMatch.mode : "";
    body.querySelector("#pc-method").value = (c.http && c.http.method) || "GET";
    body.querySelector("#pc-credential").value = c.credentialId || "";

    var scope = c.scope || {};
    var serverCb = body.querySelector("#pc-server");
    serverCb.checked = c.runOnServer === true;
    // A check that already runs on the server stays tickable-OFF for a caller
    // who may not aim the server; ticking it ON is refused up front (and by
    // the server, which also refuses re-aiming a server-run check).
    if (!canRunOnServer() && !serverCb.checked) serverCb.disabled = true;
    var hadAgentSources = !!(scope.allAssets || scope.condition || (c.assetIds && c.assetIds.length));
    body.querySelector("#pc-both-note").style.display = editingId && c.runOnServer === true && hadAgentSources ? "" : "none";
    var allCb = body.querySelector("#pc-all-hosts");
    allCb.checked = scope.allAssets === true;
    var condRoot = body.querySelector("#pc-cond-root");
    condRoot.innerHTML = builder.groupHtml(scope.condition || { op: "and", children: [] }, 0);
    builder.wire(body, "#pc-cond-root");
    // The blank condition row is seeded only while the agent filter is the
    // source: seeding it under a server-run check left an unfilled row that
    // then refused the save.
    function syncAll() {
      body.querySelector("#pc-cond-wrap").style.display = allCb.checked ? "none" : "block";
      if (!allCb.checked && !serverCb.checked) builder.seedIfEmpty(condRoot);
    }
    function syncSource() {
      body.querySelector("#pc-agent-sources").style.display = serverCb.checked ? "none" : "";
      syncAll();
    }
    allCb.addEventListener("change", function () { syncAll(); schedulePreview(); });
    serverCb.addEventListener("change", function () { syncSource(); schedulePreview(); });
    syncSource();

    function syncKind() {
      var k = body.querySelector("#pc-kind").value;
      var hint = TARGET_HINTS[k];
      body.querySelector("#pc-target-label").textContent = hint.label;
      body.querySelector("#pc-target").placeholder = hint.placeholder;
      var isHttp = k === "http" || k === "https";
      body.querySelector("#pc-http-fields").style.display = isHttp ? "" : "none";
      body.querySelector("#pc-nonhttp-note").style.display = isHttp ? "none" : "";
      body.querySelector("#pc-tls-row").style.display = k === "https" ? "" : "none";
      body.querySelector("#pc-request-fields").style.display = isHttp ? "" : "none";
      syncRequest();
    }
    /** Authentication locks Sources to the server; the new options need agent 0.23.0. */
    function syncRequest() {
      var k = body.querySelector("#pc-kind").value;
      var isHttp = k === "http" || k === "https";
      var cred = isHttp ? body.querySelector("#pc-credential").value : "";
      var mode = "";
      (_httpCredentials || []).forEach(function (cr) { if (cr.id === cred) mode = cr.authMode; });
      body.querySelector("#pc-auth-cleartext").style.display = (cred && k === "http" && (mode === "basic" || mode === "bearer")) ? "" : "none";
      var usesOptions = isHttp && (body.querySelector("#pc-method").value === "HEAD" || !!body.querySelector("#pc-host-header").value.trim() ||
        body.querySelector("#pc-follow-redirects").checked || body.querySelector("#pc-body-mode").value.charAt(0) === "!");
      body.querySelector("#pc-agent-version-note").style.display = usesOptions && !cred ? "" : "none";
      var serverOnly = !!cred;
      var lock = body.querySelector("#pc-server-only-note");
      if (lock) lock.style.display = serverOnly ? "" : "none";
      // Forced on while the check authenticates; clearing Authentication hands
      // the toggle back as the operator left it.
      if (serverOnly && !serverCb.checked) { serverCb.checked = true; forcedServer = true; }
      if (!serverOnly && forcedServer) { serverCb.checked = false; forcedServer = false; }
      serverCb.disabled = serverOnly || (!canRunOnServer() && !serverCb.checked);
      syncSource();
    }
    var forcedServer = false;
    body.querySelector("#pc-kind").addEventListener("change", syncKind);
    ["#pc-method", "#pc-credential", "#pc-body-mode"].forEach(function (sel) { body.querySelector(sel).addEventListener("change", syncRequest); });
    body.querySelector("#pc-host-header").addEventListener("input", syncRequest);
    body.querySelector("#pc-follow-redirects").addEventListener("change", syncRequest);
    syncKind();
    syncRequest();

    var statusInput = body.querySelector("#pc-status-spec");
    function syncStatusError() {
      var r = parseStatusSpec(statusInput.value);
      var el = body.querySelector("#pc-status-error");
      el.textContent = r.error || "";
      el.style.display = r.error ? "" : "none";
    }
    statusInput.addEventListener("input", syncStatusError);

    // ── Test run ──
    var testBtn = body.querySelector("#pc-test");
    var testOut = body.querySelector("#pc-test-result");
    testBtn.addEventListener("click", async function () {
      var draft = collectCheck(body, {}, []);
      var problem = validateCheck(Object.assign({}, draft, { name: draft.name || "Test run", runOnServer: true }));
      if (problem && (problem.tab === "general" || problem.tab === "expect")) {
        showToast(problem.message, "error");
        if (problem.tab === "general") goToStep(1);
        return;
      }
      testBtn.disabled = true;
      testOut.innerHTML = '<p style="font-size:0.8rem;color:var(--color-text-tertiary);margin:0">Sending the request from the Polaris server…</p>';
      try {
        var res = await api.pathChecks.test(draft);
        testOut.innerHTML = testResultHtml(res);
        var useStatus = testOut.querySelector("#pc-test-use-status");
        if (useStatus) useStatus.addEventListener("click", function () {
          statusInput.value = useStatus.getAttribute("data-status");
          syncStatusError();
          showToast("Accepted status codes set to " + statusInput.value, "success");
        });
        var useSel = testOut.querySelector("#pc-test-use-sel");
        if (useSel) useSel.addEventListener("click", function () {
          var pre = testOut.querySelector("#pc-test-body");
          var sel = window.getSelection ? String(window.getSelection() || "") : "";
          var inside = pre && window.getSelection && window.getSelection().anchorNode && pre.contains(window.getSelection().anchorNode);
          if (!sel || !inside) { showToast("Select some text in the response body first", "error"); return; }
          if (sel.length > 1024) { showToast("The selection is longer than 1024 characters — select less", "error"); return; }
          body.querySelector("#pc-body-mode").value = "contains";
          body.querySelector("#pc-body-pattern").value = sel;
          body.querySelector("#pc-body-case").checked = true;
          showToast("The body must now contain the selected text", "success");
        });
      } catch (err) {
        testOut.innerHTML = '<p style="color:' + FAIL_COLOR + ';margin:0;font-size:0.85rem">' + esc(err.message || "Test failed") + "</p>";
      } finally {
        testBtn.disabled = !canRunOnServer();
      }
    });

    // ── Sources preview ──
    var previewTimer = null;
    var previewSeq = 0;
    function schedulePreview() {
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = setTimeout(runPreview, 400);
    }
    function previewShell(head, inner) {
      body.querySelector("#pc-preview").innerHTML = '<div style="font-size:0.85rem;margin-bottom:0.5rem">' + head + "</div>" + (inner || "");
    }
    async function runPreview() {
      if (serverCb.checked) { ++previewSeq; return; } // the agent half is hidden
      var sc = collectScope();
      if (sc.error && !pins.size) {
        previewShell('<span class="hint">' + esc(sc.error) + "</span>");
        return;
      }
      var seq = ++previewSeq;
      previewShell('<span class="hint">Resolving agent hosts…</span>');
      try {
        var res = await api.pathChecks.previewSources({ scope: sc.scope || {}, assetIds: Array.from(pins) });
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
        return '<tr><td style="width:28px"><input type="checkbox" class="pc-pin" data-id="' + esc(a.assetId) + '" title="Pin this host — it keeps running the check even if the filter stops matching"' + (pins.has(a.assetId) ? " checked" : "") + ' style="width:auto"></td>' +
          '<td><span title="' + (a.online ? "online" : "offline") + '" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + (a.online ? "var(--color-success,#2a9d8f)" : "var(--color-text-tertiary)") + '"></span></td>' +
          "<td>" + esc(a.hostname || a.ipAddress || a.assetId) + (a.pinnedOnly ? ' <span class="tag-chip">pinned — outside filter</span>' : "") + "</td>" +
          "<td>" + esc(a.ipAddress || "") + "</td>" +
          '<td style="font-size:0.8rem">' + esc(a.os || "") + "</td>" +
          "<td><code>" + esc(a.agentVersion ? "v" + a.agentVersion : "—") + "</code>" +
            (a.supported ? "" : ' <span class="hint" title="Path checks need agent ' + esc(res.minAgentVersion) + '+">upgrade</span>') + "</td></tr>";
      }).join("");
      var missing = (res.pinnedWithoutAgent || []).map(function (a) {
        return '<li>' + esc(a.hostname || a.ipAddress || a.assetId) + " — pinned, but has no active agent</li>";
      }).join("");
      previewShell(head, (rows ? '<table class="data-table" style="width:100%"><tbody>' + rows + "</tbody></table>" : '<p class="hint">No agent hosts match.</p>') +
        (missing ? '<ul class="hint" style="margin:0.5rem 0 0 1rem">' + missing + "</ul>" : ""));
      body.querySelectorAll(".pc-pin").forEach(function (cb) {
        cb.addEventListener("change", function () {
          if (cb.checked) pins.add(cb.dataset.id); else pins.delete(cb.dataset.id);
          schedulePreview();
        });
      });
    }
    function collectScope() {
      if (serverCb.checked) return { scope: {} };
      if (allCb.checked) return { scope: { allAssets: true } };
      var group = body.querySelector("#pc-cond-root > .scg-group");
      var tree = group ? builder.collect(group) : { op: "and", children: [] };
      if (!tree.children.length) return { scope: {}, empty: true, error: 'Add a condition, pin a host, or check "All agent hosts".' };
      var problem = builder.validate(tree);
      if (problem) return { scope: {}, error: problem };
      return { scope: { condition: tree } };
    }
    runPreview();

    // ── Stepper navigation ──
    function stepProblem(n) {
      var sc = collectScope();
      var payload = collectCheck(body, sc.scope || {}, Array.from(pins));
      var problem = checkProblem(sc, payload);
      return problem && stepOfTab(problem.tab) === n ? problem : null;
    }
    function updateStepper() {
      document.querySelectorAll("#pc-stepper .stepper-step").forEach(function (el) {
        var n = Number(el.getAttribute("data-step"));
        el.classList.toggle("active", n === step);
        el.classList.toggle("done", n < step);
        el.classList.toggle("clickable", n <= visited && n !== step);
      });
      document.querySelectorAll("#pc-stepper .stepper-line").forEach(function (el) {
        el.classList.toggle("done", Number(el.getAttribute("data-line")) < step);
      });
    }
    function syncFooter() {
      document.getElementById("pc-back").style.display = step > 1 ? "" : "none";
      document.getElementById("pc-next").style.display = step < STEPS.length ? "" : "none";
      document.getElementById("pc-save").style.display = (step === STEPS.length || editingId) ? "" : "none";
    }
    function goToStep(n, gopts) {
      gopts = gopts || {};
      if (n < 1 || n > STEPS.length) return false;
      if (gopts.validate) {
        var problem = stepProblem(step);
        if (problem) { showToast(problem.message, "error"); return false; }
      }
      document.getElementById("pc-step-" + step).classList.remove("visible");
      step = n;
      visited = Math.max(visited, n);
      document.getElementById("pc-step-" + step).classList.add("visible");
      updateStepper();
      syncFooter();
      var mb = document.querySelector("#modal-overlay .modal-body");
      if (mb) mb.scrollTop = 0;
      if (STEPS[n - 1].key === "sources") schedulePreview();
      return true;
    }
    document.getElementById("pc-next").addEventListener("click", function () { goToStep(step + 1, { validate: true }); });
    document.getElementById("pc-back").addEventListener("click", function () { goToStep(step - 1); });
    document.getElementById("pc-stepper").addEventListener("click", function (ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest(".stepper-step") : null;
      if (!el) return;
      var n = Number(el.getAttribute("data-step"));
      if (n <= visited && n !== step) goToStep(n);
    });
    // → / ← walk the steps and Enter means Next, submitting only on the last
    // step (app.js § Stepped-modal keyboard navigation).
    if (typeof wireModalStepKeys === "function") wireModalStepKeys({ back: "pc-back", next: "pc-next", submit: "pc-save" });
    updateStepper();
    syncFooter();

    // ── Save ──
    document.getElementById("pc-cancel").addEventListener("click", closeModal);
    document.getElementById("pc-save").addEventListener("click", async function () {
      var sc = collectScope();
      var payload = collectCheck(body, sc.scope || {}, Array.from(pins));
      var problem = checkProblem(sc, payload);
      if (problem) {
        goToStep(stepOfTab(problem.tab));
        showToast(problem.message, "error");
        return;
      }
      var btn = document.getElementById("pc-save");
      btn.disabled = true;
      try {
        if (editingId) await api.pathChecks.update(editingId, payload);
        else await api.pathChecks.create(payload);
        closeModal();
        showToast(editingId ? "Check saved" : "Check created — " + (payload.runOnServer ? "the server runs it within a minute; " : "") + "agents pick it up within a few minutes", "success");
        loadTab();
      } catch (err) {
        btn.disabled = false;
        showToast(err.message || "Save failed", "error");
      }
    });
  }

  /**
   * Pure: the Sources refusal the condition tree adds on top of validateCheck.
   * A server-run check has no agent filter to refuse. Otherwise a tree with a
   * bad row is always refused; an EMPTY tree only when nothing else runs the
   * check (no pins, not all hosts).
   */
  var NO_SOURCE_MESSAGE = 'Turn on "Run from this Polaris server", or add a condition, pin a host, or check "All agent hosts"';

  function scopeProblem(sc, payload) {
    if (!sc || !sc.error || payload.runOnServer) return null;
    var elsewhere = (payload.assetIds && payload.assetIds.length) || (payload.scope && payload.scope.allAssets);
    if (sc.empty && elsewhere) return null;
    return { tab: "sources", message: sc.empty ? NO_SOURCE_MESSAGE : sc.error };
  }

  /** Pure: the first refusal; an unfilled filter row says so itself rather than "no source". */
  function checkProblem(sc, payload) {
    var p = validateCheck(payload);
    var s = scopeProblem(sc, payload);
    return p && p.tab === "sources" && s ? s : (p || s);
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
    var kind = v("pc-kind");
    var isHttp = kind === "http" || kind === "https";
    var modeSel = v("pc-body-mode");
    var negate = modeSel.charAt(0) === "!";
    var mode = negate ? modeSel.slice(1) : modeSel;
    var pattern = v("pc-body-pattern");
    var method = v("pc-method") === "HEAD" ? "HEAD" : "GET";
    var credentialId = isHttp ? (v("pc-credential") || null) : null;
    var out = {
      name: v("pc-name").trim(),
      description: v("pc-description").trim() || null,
      enabled: on("pc-enabled"),
      kind: kind,
      target: v("pc-target").trim(),
      intervalSec: Math.round(Number(v("pc-interval-min")) || 1) * 60,
      timeoutMs: Math.round(Number(v("pc-timeout-ms")) || 5000),
      http: isHttp ? {
        expectStatus: v("pc-status-spec").trim(),
        bodyMatch: mode && pattern ? Object.assign({ mode: mode, pattern: pattern, caseSensitive: on("pc-body-case") }, negate ? { negate: true } : {}) : null,
        verifyTls: kind === "https" ? on("pc-verify-tls") : false,
        method: method,
        hostHeader: v("pc-host-header").trim() || null,
        followRedirects: on("pc-follow-redirects"),
      } : null,
      traceroute: {
        enabled: on("pc-tr-enabled"),
        everyNRuns: Math.round(Number(v("pc-tr-every")) || 5),
        maxHops: Math.round(Number(v("pc-tr-maxhops")) || 30),
        probesPerHop: Math.round(Number(v("pc-tr-probes")) || 3),
      },
      keepBodyExcerpt: isHttp && on("pc-keep-excerpt"),
      credentialId: credentialId,
    };
    // One source: the server (always, for an authenticating check — the
    // server refuses agent Sources on one) or the agent hosts, never both.
    var server = !!credentialId || on("pc-server");
    out.scope = server ? {} : scope;
    out.assetIds = server ? [] : (assetIds || []);
    out.runOnServer = server;
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
      if (p.http.hostHeader && !/^[a-z0-9.-]+(:\d{1,5})?$/i.test(p.http.hostHeader)) {
        return { tab: "general", message: "Host header must be a host name or address, optionally with :port" };
      }
      if (p.http.method === "HEAD" && p.http.bodyMatch) {
        return { tab: "expect", message: "A HEAD request has no body to match — use GET, or set the body check to none" };
      }
      var s = parseStatusSpec(p.http.expectStatus);
      if (s.error) return { tab: "expect", message: "Accepted status codes: " + s.error };
      if (p.http.bodyMatch && p.http.bodyMatch.mode === "regex") {
        try { new RegExp(p.http.bodyMatch.pattern); } catch (e) { return { tab: "expect", message: "Invalid regular expression: " + e.message }; }
        if (/\(\?<?[=!]/.test(p.http.bodyMatch.pattern)) return { tab: "expect", message: "Lookahead / lookbehind is not supported (the agent uses RE2)" };
      }
    }
    var hasScope = p.scope && (p.scope.allAssets || p.scope.condition);
    if (!hasScope && !(p.assetIds && p.assetIds.length) && !p.runOnServer) {
      return { tab: "sources", message: NO_SOURCE_MESSAGE };
    }
    return null;
  }

  // ─── Results (fleet view) ───────────────────────────────────────────────

  async function openResults(check) {
    var head = kindBadge(check.kind) + ' <code style="font-size:0.85rem">' + esc(check.target) + "</code> · " + esc(intervalLabel(check.intervalSec));
    var body = '<div id="path-res-head" style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;margin-bottom:0.75rem">' + head +
        '<span id="path-res-summary" style="margin-left:auto"></span></div>' +
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
        '</tr></thead><tbody id="path-res-tbody"><tr><td colspan="8" class="empty-state">Loading…</td></tr></tbody></table>' +
      "</div>" +
      // The Polaris server's own row opens its charts and path graph HERE —
      // the server is no asset, so it has no slide-over to open. The ids
      // are the slide-over Paths tab's, whose renderer draws both.
      '<div id="path-server-detail" style="margin-top:1rem"></div>';
    var footer = '<button class="btn btn-secondary" id="path-res-refresh">Refresh</button>' +
      (canEdit() ? '<button class="btn btn-secondary" id="path-res-edit">Edit</button>' : "") +
      '<button class="btn btn-primary" id="path-res-close">Close</button>';
    openModal("Results — " + check.name, body, footer, { large: true });
    var tbody = document.getElementById("path-res-tbody");
    tbody.dataset.checkId = check.id;
    var sf = typeof TableSF === "function" ? new TableSF("path-res-tbody", function () { draw(); }) : null;
    var rows = [];

    function draw() {
      var data = sf ? sf.apply(rows.slice()) : rows;
      if (!data.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-state">' +
          (rows.length ? "No sources match the filters." : "Nothing runs this check yet. Check its Sources: turn on this Polaris server, or pick agent hosts running agent 0.21.0 or later.") + "</td></tr>";
        return;
      }
      tbody.innerHTML = data.map(function (r) {
        var dot = r.server
          ? '<span title="Runs on this Polaris server" style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:var(--color-accent)"></span>'
          : '<span title="' + (r.online ? "agent online" : "agent offline") + '" style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:' +
            (r.online ? "var(--color-success,#2a9d8f)" : "var(--color-text-tertiary)") + '"></span>';
        return "<tr>" +
          '<td>' + dot + '<button type="button" class="row-menu-trigger path-res-host" data-id="' + esc(r.assetId || "") + '"' + (r.server ? ' data-server="1"' : "") + ">" +
            esc(r.hostname || r.ipAddress || r.assetId) + "</button>" +
            (r.server ? ' <span class="badge" title="The Polaris server runs this check itself">server</span>' : "") +
            (r.supported ? "" : ' <span class="hint" title="Needs agent 0.21.0+">upgrade agent</span>') + "</td>" +
          "<td>" + resultPill(r.lastOk, !!r.lastSampleAt, r.lastHttpStatus) + "</td>" +
          "<td>" + (r.lastLatencyMs != null ? Math.round(r.lastLatencyMs) + " ms" : "—") + "</td>" +
          "<td>" + (r.lastHttpStatus != null ? r.lastHttpStatus : "—") + "</td>" +
          "<td>" + esc(r.lastResolvedIp || "—") + "</td>" +
          "<td>" + (r.lastHopCount != null ? r.lastHopCount + (r.lastTracerouteComplete ? " ✓" : "") : "—") + "</td>" +
          "<td>" + esc(fmtWhen(r.lastSampleAt)) + "</td>" +
          '<td class="cell-wrap" style="font-size:0.8rem">' + esc(r.lastOk === false ? (r.lastError || "") : "") + "</td>" +
          "</tr>";
      }).join("");
      tbody.querySelectorAll(".path-res-host").forEach(function (b) {
        b.addEventListener("click", function () {
          showRowMenu(b, resultRowMenu(b.dataset.server === "1", {
            openServer: openServerDetail,
            openAsset: function () {
              // The slide-over's Paths tab reuses the same element ids; empty
              // the server detail first so the two never share a page.
              var mount = document.getElementById("path-server-detail");
              if (mount) mount.innerHTML = "";
              if (typeof openViewModal === "function") openViewModal(b.dataset.id, { tab: "pathCheck" });
            },
          }));
        });
      });
    }

    async function openServerDetail() {
      var mount = document.getElementById("path-server-detail");
      if (!mount) return;
      mount.innerHTML = '<p class="hint">Loading…</p>';
      try {
        var payload = await api.pathChecks.server(check.id);
        if (!document.body.contains(mount)) return;
        if (typeof renderServerPathDetail === "function") renderServerPathDetail(mount, payload);
        else mount.innerHTML = '<p class="hint">Charts are unavailable on this page.</p>';
      } catch (err) {
        mount.innerHTML = '<p class="hint">' + esc(err.message || "Failed to load the server's results") + "</p>";
      }
    }

    async function load() {
      try {
        var res = await api.pathChecks.results(check.id);
        if (tbody.dataset.checkId !== check.id || !document.body.contains(tbody)) return;
        rows = (res.results || []).map(function (r) { return Object.assign({}, r, { lastOk: r.lastOk === null ? null : r.lastOk }); });
        var passing = rows.filter(function (r) { return r.lastOk === true; }).length;
        var summary = document.getElementById("path-res-summary");
        if (summary) summary.innerHTML = "<strong>" + passing + "</strong> of " + rows.length + " source" + (rows.length === 1 ? "" : "s") + " passing";
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
    document.getElementById("path-res-refresh").addEventListener("click", load);
    document.getElementById("path-res-close").addEventListener("click", closeModal);
    var editBtn = document.getElementById("path-res-edit");
    if (editBtn) editBtn.addEventListener("click", function () { clearInterval(timer); openCheckModal(check); });
  }

  // ─── Page boot (/path-monitor.html) ──────────────────────────────────────
  // Permissions resolve asynchronously via /auth/me (userReady); reading them
  // at load would see an empty matrix and hide the add button.
  function bootPage() {
    if (!document.getElementById("path-page")) return;
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

  window.PolarisPathChecks = {
    loadTab: loadTab,
    renderList: renderList,
    openCheckModal: openCheckModal,
    openResults: openResults,
    menuItems: menuItems,
    resultRowMenu: resultRowMenu,
    parseStatusSpec: parseStatusSpec,
    validateCheck: validateCheck,
    collectCheck: collectCheck,
    scopeProblem: scopeProblem,
    resultState: resultState,
    checkResultState: checkResultState,
    testResultHtml: testResultHtml,
    usableHttpCredentials: usableHttpCredentials,
    stepOfTab: stepOfTab,
    STEPS: STEPS,
  };
})();
