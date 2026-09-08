/**
 * public/js/server-settings-ha.js — Server Settings → High Availability.
 *
 * Its own file rather than more of server-settings.js: this tab is a build
 * procedure with its own state machine (nodes → enable → three scripts →
 * approvals → rehearsal), and the flow reads better in one place than
 * interleaved with certificate rotation and retention.
 *
 * Exposes `window.PolarisHaTab = { load }`, which server-settings.js calls on
 * first activation of the tab, matching the other lazy-loaded tabs.
 *
 * Three things this UI is deliberately careful about:
 *
 *   - It never claims a node is installed. Everything it knows comes from
 *     Patroni and from what a node has actually asked for, so before adoption
 *     it renders instructions, not status.
 *   - The guidance card states real figures for THIS install, and says "could
 *     not determine" where it could not measure. A green tick that quietly
 *     meant "probably fine" is worse than a blank.
 *   - Approving a node is a decision made against evidence: the source
 *     address and the SSH host key fingerprints the node presented, shown
 *     next to the Approve button.
 */

(function () {
  "use strict";

  var _cfg = null;
  var _cluster = null;
  var _enrollments = [];
  var _advisories = null;
  var _localAddresses = [];
  var _scripts = {};          // role → { script, filename }
  var _pollTimer = null;
  var _advisoriesPending = false;

  function el(id) { return document.getElementById(id); }
  function esc(v) { return typeof escapeHtml === "function" ? escapeHtml(String(v == null ? "" : v)) : String(v == null ? "" : v); }

  function canWrite() {
    if (typeof permAtLeast === "function") return permAtLeast("serverSettingsSystem", "fullwrite");
    return typeof isAdmin === "function" ? isAdmin() : false;
  }

  // ─── Advisory rendering ───────────────────────────────────────────────────

  var LEVEL_COLOR = {
    ok: "var(--color-success)",
    warn: "var(--color-warning)",
    bad: "var(--color-danger)",
    unknown: "var(--color-text-tertiary)",
  };
  var LEVEL_LABEL = { ok: "OK", warn: "Check", bad: "Problem", unknown: "Unknown" };

  function advisoryRow(label, advisory) {
    var a = advisory || { level: "unknown", detail: "Not measured." };
    var color = LEVEL_COLOR[a.level] || LEVEL_COLOR.unknown;
    return (
      '<div style="display:grid;grid-template-columns:180px 84px 1fr;gap:0.6rem;align-items:start;padding:0.5rem 0;border-bottom:1px solid var(--color-border-light)">' +
        '<div style="font-size:0.85rem;color:var(--color-text-primary)">' + esc(label) + "</div>" +
        '<div><span class="badge" style="background:' + color + ';color:#0d0d1a;font-weight:600">' +
          esc(LEVEL_LABEL[a.level] || a.level) + "</span></div>" +
        '<div style="font-size:0.82rem;color:var(--color-text-secondary)">' + esc(a.detail) + "</div>" +
      "</div>"
    );
  }

  function placementTable(rows, chosen) {
    var body = (rows || []).map(function (r) {
      var isChosen = r.placement === chosen;
      var label = r.placement === "third-site" ? "A third site"
        : r.placement === "standby-dc" ? "The standby datacenter"
        : "The primary datacenter";
      return (
        '<tr' + (isChosen ? ' style="background:var(--color-bg-elevated)"' : "") + ">" +
          "<td>" + esc(label) +
            (r.recommended ? ' <span class="badge badge-active">recommended</span>' : "") +
            (isChosen ? ' <span class="badge badge-type">your choice</span>' : "") + "</td>" +
          "<td>" + esc(r.primaryHostDies) + "</td>" +
          "<td>" + esc(r.primaryDcDark) + "</td>" +
          '<td style="color:' + (r.standbyDcDark === "no effect" ? "var(--color-text-secondary)" : "var(--color-danger)") + '">' +
            esc(r.standbyDcDark) + "</td>" +
        "</tr>" +
        '<tr><td colspan="4" style="font-size:0.8rem;color:var(--color-text-tertiary);padding-top:0;border-top:none">' +
          esc(r.note) + "</td></tr>"
      );
    }).join("");
    return (
      '<div class="table-wrapper"><table class="data-table"><thead><tr>' +
        "<th>Witness location</th><th>Primary host dies</th><th>Primary site dark</th><th>Standby site dark</th>" +
      "</tr></thead><tbody>" + body + "</tbody></table></div>"
    );
  }

  function guidanceCard() {
    var a = _advisories;
    var support = a && a.support;
    var unsupported = support && support.supported === false;
    var host = (a && a.host) || {};

    var body;
    if (!a) {
      body = '<p class="empty-state" style="padding:0.5rem 0">' +
        (_advisoriesPending ? "Measuring this install…" : "Open this card to measure latency, bandwidth and sizing for this install.") +
        "</p>";
    } else {
      body =
        (unsupported
          ? '<div style="border:1px solid var(--color-danger);border-radius:var(--radius-md);padding:0.75rem;margin-bottom:1rem">' +
              '<div style="font-weight:600;color:var(--color-danger);margin-bottom:0.35rem">This install cannot use the two-datacenter deployment</div>' +
              "<ul style=\"margin:0 0 0 1.1rem;font-size:0.82rem;color:var(--color-text-secondary)\">" +
                support.reasons.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") +
              "</ul>" +
            "</div>"
          : "") +
        advisoryRow("Latency to standby", a.latency && a.latency.standby) +
        advisoryRow("Latency to witness", a.latency && a.latency.witness) +
        advisoryRow("Write-ahead log rate", a.bandwidth) +
        advisoryRow("Data loss on failover", a.rpo) +
        advisoryRow("Downtime on failover", a.rto) +
        advisoryRow("Standby hardware", a.standby) +
        advisoryRow("Witness hardware", a.witness) +
        '<div style="margin-top:1rem">' +
          '<div style="font-size:0.85rem;font-weight:600;margin-bottom:0.5rem">Where the witness sits decides which outage recovers by itself</div>' +
          placementTable(a.placements, _cfg && _cfg.witnessPlacement) +
        "</div>" +
        '<div style="margin-top:1rem;font-size:0.8rem;color:var(--color-text-tertiary)">' +
          "This host: " + esc(host.cpuCount || "?") + " vCPU, " +
          esc(host.totalMemBytes ? Math.round(host.totalMemBytes / 1073741824) + " GiB RAM" : "memory unknown") +
          ", Node " + esc(host.nodeMajor || "?") +
          (host.tsdbVersion ? ", TimescaleDB " + esc(host.tsdbVersion) : ", no TimescaleDB") +
          (host.polarisUid != null ? ", polaris uid " + esc(host.polarisUid) : "") +
          (host.chrony ? " · clock: " + esc(host.chrony) : " · clock sync not detected") +
        "</div>" +
        '<div style="margin-top:0.75rem;font-size:0.8rem;color:var(--color-text-tertiary)">' +
          "A failover resets in-memory state: login lockouts, rate-limit counters and half-finished " +
          "two-factor challenges. Up to two seconds of buffered samples are lost, agent samples " +
          "produced during the gap are not queued, and one duplicate alert email is possible. " +
          "Sessions, audit events and monitor state all replicate." +
        "</div>";
    }

    return (
      '<div class="settings-card">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">' +
          '<h4 style="margin:0">Before you enable</h4>' +
          '<button class="btn btn-sm btn-secondary" id="ha-measure">' + (a ? "Re-measure" : "Measure this install") + "</button>" +
        "</div>" +
        '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.75rem">' +
          "A second host in another datacenter that takes over automatically, behind one public name. " +
          "PostgreSQL is managed by Patroni over a three-member etcd; replication is asynchronous. " +
          'Read <a href="https://github.com/rogers-group-inc/polaris/blob/main/docs/HA.md" target="_blank" rel="noreferrer">docs/HA.md</a> before starting.' +
        "</p>" +
        body +
      "</div>"
    );
  }

  // ─── Nodes form ───────────────────────────────────────────────────────────

  function addrOptions(selected) {
    var opts = ['<option value="">Choose or type an address…</option>'];
    (_localAddresses || []).forEach(function (a) {
      opts.push('<option value="' + esc(a.address) + '"' + (a.address === selected ? " selected" : "") + ">" +
        esc(a.address) + " (" + esc(a.iface) + ")</option>");
    });
    return opts.join("");
  }

  function nodeRow(role, label, node, opts) {
    var n = node || {};
    var isPrimary = role === "primary";
    return (
      "<tr>" +
        '<td style="white-space:nowrap"><strong>' + esc(label) + "</strong>" +
          (isPrimary ? '<br><span style="font-size:0.75rem;color:var(--color-text-tertiary)">this host</span>' : "") + "</td>" +
        '<td><input type="text" id="ha-' + role + '-name" value="' + esc(n.name || "") +
          '" placeholder="' + esc(role === "witness" ? "witness" : "polaris-" + (isPrimary ? "a" : "b")) +
          '" style="width:100%" ' + (opts.disabled ? "disabled" : "") + "></td>" +
        "<td>" +
          (isPrimary && _localAddresses.length
            ? '<select id="ha-primary-addr-pick" style="width:100%;margin-bottom:0.25rem" ' + (opts.disabled ? "disabled" : "") + ">" +
                addrOptions(n.clusterAddr) + "</select>"
            : "") +
          '<input type="text" id="ha-' + role + '-addr" value="' + esc(n.clusterAddr || "") +
            '" placeholder="IP or hostname the other nodes reach it on" style="width:100%" ' +
            (opts.disabled ? "disabled" : "") + ">" +
        "</td>" +
        '<td><input type="text" id="ha-' + role + '-sans" value="' + esc((n.extraSans || []).join(", ")) +
          '" placeholder="optional, comma separated" style="width:100%" ' + (opts.disabled ? "disabled" : "") + "></td>" +
        "<td>" +
          (isPrimary
            ? '<span style="color:var(--color-text-tertiary)">—</span>'
            : '<input type="text" id="ha-' + role + '-reach" value="' + esc(n.reachPrimaryVia || "") +
              '" placeholder="defaults to the primary" style="width:100%" ' + (opts.disabled ? "disabled" : "") + ">") +
        "</td>" +
      "</tr>"
    );
  }

  function nodesCard() {
    var enabled = _cfg && _cfg.enabled;
    var nodes = (_cfg && _cfg.nodes) || {};
    var writable = canWrite() && !enabled;
    var gslb = (_cfg && _cfg.gslb) || { monitorIntervalSec: 5, monitorRetries: 3, dnsTtlSec: 5 };

    return (
      '<div class="settings-card">' +
        '<h4>1. Nodes</h4>' +
        '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.75rem">' +
          "Three planes, and they are not interchangeable. The <strong>public URL</strong> " +
          (_advisories && _advisories.host && _advisories.host.publicUrl
            ? "(<span class=\"mono\">" + esc(_advisories.host.publicUrl) + "</span>) "
            : "") +
          "is what browsers, agents and your load balancer use, and it never carries traffic between " +
          "the nodes. The <strong>cluster address</strong> is how each node reaches the other two: " +
          "etcd, Patroni, replication and the file sync all use it, so on two routed datacenters " +
          "these are usually private addresses. <strong>Extra names</strong> are baked into that " +
          "node's etcd certificate, for a NAT address or a second interface." +
        "</p>" +
        '<div class="table-wrapper"><table class="data-table"><thead><tr>' +
          "<th>Node</th><th>Member name</th><th>Cluster address</th><th>Extra names</th><th>Reach the primary via</th>" +
        "</tr></thead><tbody>" +
          nodeRow("primary", "Primary", nodes.primary, { disabled: !writable }) +
          nodeRow("standby", "Standby", nodes.standby, { disabled: !writable }) +
          nodeRow("witness", "Witness", nodes.witness, { disabled: !writable }) +
        "</tbody></table></div>" +
        '<div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-top:1rem">' +
          "<div>" +
            '<label style="font-size:0.82rem">Witness location</label>' +
            '<select id="ha-witness-placement" style="width:100%" ' + (writable ? "" : "disabled") + ">" +
              ["third-site", "standby-dc", "primary-dc"].map(function (p) {
                var label = p === "third-site" ? "A third site (recommended)"
                  : p === "standby-dc" ? "The standby datacenter"
                  : "The primary datacenter";
                var sel = (_cfg && _cfg.witnessPlacement) === p ? " selected" : "";
                return '<option value="' + p + '"' + sel + ">" + esc(label) + "</option>";
              }).join("") +
            "</select>" +
            '<p class="hint" style="font-size:0.78rem">Decides which outage recovers without a human. See the table above.</p>' +
          "</div>" +
          "<div>" +
            '<label style="font-size:0.82rem">Load-balancer monitor</label>' +
            '<div style="display:flex;gap:0.4rem;align-items:center">' +
              '<input type="number" id="ha-gslb-interval" min="1" max="300" value="' + esc(gslb.monitorIntervalSec) +
                '" style="width:70px" ' + (writable ? "" : "disabled") + '> <span style="font-size:0.8rem">s interval</span>' +
              '<input type="number" id="ha-gslb-retries" min="1" max="10" value="' + esc(gslb.monitorRetries) +
                '" style="width:60px" ' + (writable ? "" : "disabled") + '> <span style="font-size:0.8rem">retries</span>' +
              '<input type="number" id="ha-gslb-ttl" min="0" max="3600" value="' + esc(gslb.dnsTtlSec) +
                '" style="width:70px" ' + (writable ? "" : "disabled") + '> <span style="font-size:0.8rem">s DNS TTL</span>' +
            "</div>" +
            '<p class="hint" style="font-size:0.78rem">Only used to estimate downtime. Point the monitor at <span class="mono">/health/ready</span>.</p>' +
          "</div>" +
        "</div>" +
        (enabled
          ? '<p style="margin-top:0.75rem;font-size:0.82rem;color:var(--color-text-secondary)">' +
              "High availability is enabled" +
              (_cfg.enabledBy ? " by " + esc(_cfg.enabledBy) : "") +
              (_cfg.enabledAt ? " on " + esc(new Date(_cfg.enabledAt).toLocaleString()) : "") +
              ". The credentials and the etcd authority are stored and sealed; re-enabling never rotates them." +
            "</p>"
          : "") +
        '<div style="margin-top:1rem;display:flex;gap:0.5rem;align-items:center">' +
          (enabled
            ? '<button class="btn btn-secondary" id="ha-disable"' + (canWrite() ? "" : " disabled") + ">Disable</button>"
            : '<button class="btn btn-primary" id="ha-enable"' + (canWrite() ? "" : " disabled") + ">2. Enable high availability</button>") +
          (enabled ? '<button class="btn btn-secondary btn-sm" id="ha-teardown">Teardown script</button>' : "") +
          (canWrite() ? "" : '<span style="font-size:0.8rem;color:var(--color-text-tertiary)">Needs Full Read-Write on Server Settings.</span>') +
        "</div>" +
      "</div>"
    );
  }

  // ─── Scripts ──────────────────────────────────────────────────────────────

  var ROLE_LABEL = { primary: "Primary", standby: "Standby", witness: "Witness" };
  var ROLE_NOTE = {
    primary: "Run on THIS host, in a maintenance window. It adopts the running PostgreSQL under Patroni, which stops the database and the app for a few minutes.",
    witness: "Run on the witness host. It installs etcd and nothing else — no PostgreSQL, no Polaris, no application secrets.",
    standby: "Run on the standby host. It installs every package the primary has, joins etcd, clones the database, and leaves the application stopped.",
  };

  function scriptRow(role) {
    var s = _scripts[role];
    var pending = latestEnrollment(role);
    var statusText = pending
      ? (pending.status === "pending" ? "waiting for your approval"
        : pending.status === "approved" ? "approved, waiting for the node to download"
        : pending.status === "delivered" ? "installed"
        : pending.status)
      : "no script generated yet";
    return (
      '<div style="border:1px solid var(--color-border);border-radius:var(--radius-md);padding:0.75rem;margin-bottom:0.75rem">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;flex-wrap:wrap">' +
          "<div><strong>" + esc(ROLE_LABEL[role]) + "</strong> " +
            '<span style="font-size:0.8rem;color:var(--color-text-tertiary)">' + esc(statusText) + "</span></div>" +
          "<div>" +
            '<button class="btn btn-sm btn-secondary" data-ha-gen="' + role + '"' + (canWrite() ? "" : " disabled") + ">" +
              (s ? "Re-generate" : "Generate") + "</button> " +
            (s ? '<button class="btn btn-sm btn-secondary" data-ha-copy="' + role + '">Copy</button> ' : "") +
            (s ? '<button class="btn btn-sm btn-primary" data-ha-dl="' + role + '">Download .sh</button>' : "") +
          "</div>" +
        "</div>" +
        '<p style="font-size:0.8rem;color:var(--color-text-secondary);margin:0.4rem 0 0 0">' + esc(ROLE_NOTE[role]) + "</p>" +
        (s
          ? '<textarea readonly rows="8" class="mono" style="width:100%;margin-top:0.5rem">' + esc(s.script) + "</textarea>"
          : "") +
      "</div>"
    );
  }

  function latestEnrollment(role) {
    for (var i = 0; i < _enrollments.length; i++) {
      if (_enrollments[i].role === role) return _enrollments[i];
    }
    return null;
  }

  function scriptsCard() {
    if (!_cfg || !_cfg.enabled) return "";
    return (
      '<div class="settings-card">' +
        "<h4>3. Node scripts</h4>" +
        '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.75rem">' +
          "Each script carries no secrets beyond a single-use token that expires in 24 hours. " +
          "Run it as root on the node; it registers here, waits for you to approve it below, " +
          "then downloads its configuration, certificates and keys over pinned TLS. " +
          "Build in this order: witness, primary, standby." +
        "</p>" +
        scriptRow("witness") +
        scriptRow("primary") +
        scriptRow("standby") +
      "</div>"
    );
  }

  // ─── Approvals ────────────────────────────────────────────────────────────

  function approvalsCard() {
    if (!_cfg || !_cfg.enabled) return "";
    var pending = _enrollments.filter(function (e) { return e.status === "pending"; });
    var recent = _enrollments.filter(function (e) { return e.status !== "pending"; }).slice(0, 8);

    var pendingHtml = pending.length
      ? pending.map(function (e) {
          return (
            '<div style="border:1px solid var(--color-warning);border-radius:var(--radius-md);padding:0.75rem;margin-bottom:0.5rem">' +
              '<div style="display:flex;justify-content:space-between;align-items:start;gap:0.75rem;flex-wrap:wrap">' +
                "<div style=\"font-size:0.85rem\">" +
                  "<div><strong>" + esc(ROLE_LABEL[e.role] || e.role) + "</strong> node is asking to join</div>" +
                  '<div style="color:var(--color-text-secondary);margin-top:0.3rem">' +
                    "from <span class=\"mono\">" + esc(e.registeredFromIp || "unknown address") + "</span>" +
                    (e.registeredNodeName ? ", calling itself <span class=\"mono\">" + esc(e.registeredNodeName) + "</span>" : "") +
                    (e.nodeName ? " · expected <span class=\"mono\">" + esc(e.nodeName) + "</span>" : "") +
                  "</div>" +
                  (e.sshHostKeyFingerprints && e.sshHostKeyFingerprints.length
                    ? '<div style="color:var(--color-text-tertiary);margin-top:0.3rem;font-size:0.78rem">SSH host keys:<br>' +
                        e.sshHostKeyFingerprints.map(function (f) { return '<span class="mono">' + esc(f) + "</span>"; }).join("<br>") +
                      "</div>"
                    : '<div style="color:var(--color-text-tertiary);margin-top:0.3rem;font-size:0.78rem">It presented no SSH host keys.</div>') +
                "</div>" +
                "<div style=\"white-space:nowrap\">" +
                  '<button class="btn btn-sm btn-primary" data-ha-approve="' + esc(e.id) + '"' + (canWrite() ? "" : " disabled") + ">Approve</button> " +
                  '<button class="btn btn-sm btn-danger" data-ha-reject="' + esc(e.id) + '"' + (canWrite() ? "" : " disabled") + ">Reject</button>" +
                "</div>" +
              "</div>" +
              '<p style="font-size:0.78rem;color:var(--color-text-secondary);margin:0.5rem 0 0 0">' +
                "Approving releases this node's bundle once: its etcd certificate and key, " +
                (e.role === "witness"
                  ? "and nothing else."
                  : "the Patroni configuration, the file-sync key, this host's .env and the nginx certificate and key.") +
                " Check the address and the host keys are the machine you built." +
              "</p>" +
            "</div>"
          );
        }).join("")
      : '<p class="empty-state" style="padding:0.5rem 0">Nothing waiting. A node appears here seconds after its script runs.</p>';

    var recentHtml = recent.length
      ? '<div class="table-wrapper" style="margin-top:0.75rem"><table class="data-table"><thead><tr>' +
          "<th>Node</th><th>Status</th><th>From</th><th>When</th>" +
        "</tr></thead><tbody>" +
        recent.map(function (e) {
          var badge = e.status === "delivered" ? "badge-active"
            : e.status === "rejected" ? "badge-conflict"
            : e.status === "approved" ? "badge-type" : "badge-disabled";
          var when = e.deliveredAt || e.approvedAt || e.registeredAt || e.createdAt;
          return "<tr>" +
            "<td>" + esc(ROLE_LABEL[e.role] || e.role) + " · " + esc(e.nodeName) + "</td>" +
            '<td><span class="badge ' + badge + '">' + esc(e.status) + "</span></td>" +
            '<td class="mono">' + esc(e.registeredFromIp || "—") + "</td>" +
            "<td>" + esc(when ? new Date(when).toLocaleString() : "—") + "</td>" +
          "</tr>";
        }).join("") +
        "</tbody></table></div>"
      : "";

    return (
      '<div class="settings-card">' +
        "<h4>4. Approvals" + (pending.length ? ' <span class="badge badge-conflict">' + pending.length + " waiting</span>" : "") + "</h4>" +
        '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.75rem">' +
          "A node's token buys the right to ask, not the bundle. Nothing is released until you " +
          "approve it here, so a script that leaked shows up as a request you can reject." +
        "</p>" +
        pendingHtml +
        recentHtml +
      "</div>"
    );
  }

  // ─── Cluster ──────────────────────────────────────────────────────────────

  function clusterCard() {
    if (!_cfg || !_cfg.enabled) return "";
    var c = _cluster || { available: false, members: [] };
    if (!c.available) {
      return (
        '<div class="settings-card">' +
          "<h4>5. Cluster</h4>" +
          '<p class="empty-state" style="padding:0.5rem 0">' +
            esc(c.reason || "Patroni is not running on this host yet") + ". " +
            "This is the expected state until the primary script has adopted the database." +
          "</p>" +
        "</div>"
      );
    }
    var rows = c.members.map(function (m) {
      var isLeader = m.role === "leader" || m.role === "master" || m.role === "primary";
      var stateBadge = m.state === "running" || m.state === "streaming" ? "badge-active" : "badge-conflict";
      return "<tr>" +
        "<td>" + esc(m.name) + (isLeader ? ' <span class="badge badge-active">leader</span>' : "") + "</td>" +
        "<td>" + esc(m.role) + "</td>" +
        '<td><span class="badge ' + stateBadge + '">' + esc(m.state) + "</span></td>" +
        '<td class="mono">' + esc(m.host || "—") + "</td>" +
        "<td>" + (m.lagBytes == null ? "—" : esc(m.lagBytes) + " B") + "</td>" +
        "<td>" + esc(m.timeline == null ? "—" : m.timeline) + "</td>" +
        "<td>" + (m.tags && m.tags.nofailover === true ? '<span class="badge badge-disabled">nofailover</span>' : "—") + "</td>" +
      "</tr>";
    }).join("");

    return (
      '<div class="settings-card">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">' +
          '<h4 style="margin:0">5. Cluster</h4>' +
          "<div>" +
            (c.automaticFailover
              ? '<span class="badge badge-active">automatic failover armed</span>'
              : '<span class="badge badge-disabled">automatic failover not armed</span>') +
          "</div>" +
        "</div>" +
        '<div class="table-wrapper"><table class="data-table"><thead><tr>' +
          "<th>Member</th><th>Role</th><th>State</th><th>Address</th><th>Lag</th><th>Timeline</th><th>Tags</th>" +
        "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
        '<p style="font-size:0.8rem;color:var(--color-text-secondary);margin-top:0.75rem">' +
          "This node is the <strong>" + esc(c.localRole) + "</strong>. " +
          (c.automaticFailover
            ? "The standby can win an election."
            : "The standby carries a <span class=\"mono\">nofailover</span> tag, so it will not promote itself. " +
              "Remove it after a switchover rehearsal: <span class=\"mono\">patronictl -c /etc/patroni/patroni.yml switchover</span>, " +
              "then edit the tag and reload. Section 7 of docs/HA.md walks through it.") +
        "</p>" +
      "</div>"
    );
  }

  // ─── Render and wire ──────────────────────────────────────────────────────

  function render() {
    var container = el("tab-ha");
    if (!container) return;
    container.innerHTML =
      guidanceCard() + nodesCard() + scriptsCard() + approvalsCard() + clusterCard();
    wire();
  }

  function readNode(role) {
    var name = (el("ha-" + role + "-name") || {}).value || "";
    var addr = (el("ha-" + role + "-addr") || {}).value || "";
    var sans = ((el("ha-" + role + "-sans") || {}).value || "")
      .split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    var reach = ((el("ha-" + role + "-reach") || {}).value || "").trim();
    var node = { name: name.trim(), clusterAddr: addr.trim() };
    if (sans.length) node.extraSans = sans;
    if (reach) node.reachPrimaryVia = reach;
    return node;
  }

  function wire() {
    var pick = el("ha-primary-addr-pick");
    if (pick) {
      pick.addEventListener("change", function () {
        if (pick.value && el("ha-primary-addr")) el("ha-primary-addr").value = pick.value;
      });
    }

    var measure = el("ha-measure");
    if (measure) measure.addEventListener("click", function () { loadAdvisories(true); });

    var enable = el("ha-enable");
    if (enable) enable.addEventListener("click", onEnable);

    var disable = el("ha-disable");
    if (disable) disable.addEventListener("click", onDisable);

    var teardown = el("ha-teardown");
    if (teardown) teardown.addEventListener("click", onTeardown);

    document.querySelectorAll("[data-ha-gen]").forEach(function (b) {
      b.addEventListener("click", function () { onGenerate(b.getAttribute("data-ha-gen")); });
    });
    document.querySelectorAll("[data-ha-copy]").forEach(function (b) {
      b.addEventListener("click", function () { onCopy(b.getAttribute("data-ha-copy")); });
    });
    document.querySelectorAll("[data-ha-dl]").forEach(function (b) {
      b.addEventListener("click", function () { onDownload(b.getAttribute("data-ha-dl")); });
    });
    document.querySelectorAll("[data-ha-approve]").forEach(function (b) {
      b.addEventListener("click", function () { onApprove(b.getAttribute("data-ha-approve")); });
    });
    document.querySelectorAll("[data-ha-reject]").forEach(function (b) {
      b.addEventListener("click", function () { onReject(b.getAttribute("data-ha-reject")); });
    });
  }

  function onEnable() {
    var body = {
      witnessPlacement: (el("ha-witness-placement") || {}).value || "third-site",
      primary: readNode("primary"),
      standby: readNode("standby"),
      witness: readNode("witness"),
      gslb: {
        monitorIntervalSec: Number((el("ha-gslb-interval") || {}).value || 5),
        monitorRetries: Number((el("ha-gslb-retries") || {}).value || 3),
        dnsTtlSec: Number((el("ha-gslb-ttl") || {}).value || 5),
      },
    };
    var missing = ["primary", "standby", "witness"].filter(function (r) {
      return !body[r].name || !body[r].clusterAddr;
    });
    if (missing.length) {
      showToast("Every node needs a member name and a cluster address (" + missing.join(", ") + ")", "error");
      return;
    }

    var warning = body.witnessPlacement === "standby-dc"
      ? "\n\nYou have put the witness in the STANDBY datacenter. Losing that site, or the link " +
        "to it, will leave the primary without a quorum: it demotes itself and the service stops " +
        "until an operator rebuilds a single-member etcd by hand. Drill that runbook before " +
        "relying on this."
      : body.witnessPlacement === "primary-dc"
        ? "\n\nYou have put the witness in the PRIMARY datacenter. Losing that whole site will " +
          "need a manual promotion of the standby."
        : "";

    showConfirm(
      "Enable high availability?\n\n" +
      "This generates the etcd certificate authority, the database credentials and the file-sync " +
      "keys, and stores them sealed in the database. Nothing is installed and nothing restarts — " +
      "you then run the three generated scripts." + warning
    ).then(function (ok) {
      if (!ok) return;
      var btn = el("ha-enable");
      if (btn) btn.disabled = true;
      api.ha.enable(body)
        .then(function () {
          showToast("High availability enabled — generate the node scripts next", "success");
          _scripts = {};
          return load(true);
        })
        .catch(function (err) {
          showToast((err && err.message) || "Could not enable high availability", "error");
          if (btn) btn.disabled = false;
        });
    });
  }

  function onDisable() {
    showConfirm(
      "Disable high availability?\n\n" +
      "This only changes Polaris's configuration. It does NOT stop Patroni or etcd, and it does " +
      "not touch the standby. Run the teardown script on each host to undo the host changes.\n\n" +
      "The credentials and the etcd authority are kept, so re-enabling does not invalidate " +
      "certificates the nodes already hold."
    ).then(function (ok) {
      if (!ok) return;
      api.ha.disable()
        .then(function () { showToast("High availability disabled in configuration", "success"); return load(true); })
        .catch(function (err) { showToast((err && err.message) || "Could not disable", "error"); });
    });
  }

  function onGenerate(role) {
    var existing = latestEnrollment(role);
    var proceed = existing && (existing.status === "pending" || existing.status === "approved")
      ? showConfirm(
          "Re-generate the " + role + " script?\n\n" +
          "The outstanding request for this node is cancelled, and any copy of the previous " +
          "script stops working."
        )
      : Promise.resolve(true);

    Promise.resolve(proceed).then(function (ok) {
      if (!ok) return;
      api.ha.mintToken(role)
        .then(function (r) {
          _scripts[role] = { script: r.script, filename: r.filename };
          showToast("Script generated — valid until " + new Date(r.expiresAt).toLocaleString(), "success");
          return load(true);
        })
        .catch(function (err) { showToast((err && err.message) || "Could not generate the script", "error"); });
    });
  }

  function onCopy(role) {
    var s = _scripts[role];
    if (!s) return;
    var done = typeof copyTextToClipboard === "function"
      ? copyTextToClipboard(s.script)
      : navigator.clipboard.writeText(s.script).then(function () { return true; }, function () { return false; });
    Promise.resolve(done).then(function (ok) {
      showToast(ok ? "Script copied to clipboard" : "Could not copy — select the text and copy manually", ok ? "success" : "error");
    });
  }

  function onDownload(role) {
    var s = _scripts[role];
    if (!s) return;
    var blob = new Blob([s.script], { type: "text/plain;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = s.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function onApprove(id) {
    var e = _enrollments.filter(function (x) { return x.id === id; })[0] || {};
    showConfirm(
      "Approve this " + (e.role || "node") + "?\n\n" +
      "From: " + (e.registeredFromIp || "unknown address") + "\n" +
      "Calls itself: " + (e.registeredNodeName || "(not stated)") + "\n" +
      (e.sshHostKeyFingerprints && e.sshHostKeyFingerprints.length
        ? "SSH host keys:\n  " + e.sshHostKeyFingerprints.join("\n  ") + "\n"
        : "It presented no SSH host keys.\n") +
      "\nThis releases its bundle once. " +
      (e.role === "witness"
        ? "A witness bundle holds etcd material only."
        : "That bundle contains this host's .env, the nginx private key and the database credentials.")
    ).then(function (ok) {
      if (!ok) return;
      api.ha.approve(id)
        .then(function () { showToast("Node approved", "success"); return load(true); })
        .catch(function (err) { showToast((err && err.message) || "Could not approve", "error"); });
    });
  }

  function onReject(id) {
    showConfirm("Reject this node? Its token is already spent, so the operator will have to generate a new script.")
      .then(function (ok) {
        if (!ok) return;
        api.ha.reject(id)
          .then(function () { showToast("Node rejected", "success"); return load(true); })
          .catch(function (err) { showToast((err && err.message) || "Could not reject", "error"); });
      });
  }

  function onTeardown() {
    api.ha.teardownScript()
      .then(function (r) {
        var body =
          '<p style="font-size:0.85rem;color:var(--color-text-secondary)">' +
            "Run this as root on the node that should keep the database. The database files are " +
            "untouched — Patroni manages a cluster, it does not convert one. Polaris never runs " +
            "this for you." +
          "</p>" +
          '<textarea readonly rows="18" class="mono" style="width:100%">' + esc(r.script) + "</textarea>";
        var footer =
          '<button class="btn btn-secondary" onclick="closeModal()">Close</button>' +
          '<button class="btn btn-primary" id="ha-teardown-dl">Download .sh</button>';
        openModal("HA teardown script", body, footer, { wide: true });
        var dl = el("ha-teardown-dl");
        if (dl) {
          dl.addEventListener("click", function () {
            _scripts.__teardown = { script: r.script, filename: r.filename };
            onDownload("__teardown");
          });
        }
      })
      .catch(function (err) { showToast((err && err.message) || "Could not build the teardown script", "error"); });
  }

  // ─── Loading ──────────────────────────────────────────────────────────────

  function loadAdvisories(force) {
    if (_advisoriesPending && !force) return Promise.resolve();
    _advisoriesPending = true;
    render();
    var body = {};
    var sAddr = (el("ha-standby-addr") || {}).value;
    var wAddr = (el("ha-witness-addr") || {}).value;
    if (sAddr) body.standbyAddr = sAddr.trim();
    if (wAddr) body.witnessAddr = wAddr.trim();
    var iv = Number((el("ha-gslb-interval") || {}).value || 0);
    var rt = Number((el("ha-gslb-retries") || {}).value || 0);
    var tt = Number((el("ha-gslb-ttl") || {}).value || 0);
    if (iv || rt || tt) {
      body.gslb = {};
      if (iv) body.gslb.monitorIntervalSec = iv;
      if (rt) body.gslb.monitorRetries = rt;
      if (tt || tt === 0) body.gslb.dnsTtlSec = tt;
    }
    return api.ha.advisories(body)
      .then(function (r) { _advisories = r.advisories; })
      .catch(function (err) { showToast((err && err.message) || "Could not measure this install", "error"); })
      .finally(function () { _advisoriesPending = false; render(); });
  }

  /**
   * Fetch and render. `quiet` skips the loading placeholder so the 10s poll
   * does not make the tab flicker while an operator is typing in it.
   */
  function load(quiet) {
    var container = el("tab-ha");
    if (!container) return Promise.resolve();
    if (!quiet && !container.innerHTML) {
      container.innerHTML = '<div class="settings-card"><p class="empty-state">Loading high availability…</p></div>';
    }
    return api.ha.status()
      .then(function (r) {
        _cfg = r.config;
        _cluster = r.cluster;
        _enrollments = r.enrollments || [];
        _localAddresses = r.localAddresses || [];
        render();
        startPolling();
      })
      .catch(function (err) {
        if (err && err.status === 403) { container.innerHTML = ""; return; }
        container.innerHTML = '<div class="settings-card"><p class="empty-state">Could not load: ' +
          esc((err && err.message) || "unknown error") + "</p></div>";
      });
  }

  /**
   * Poll while the tab is visible.
   *
   * A node registering is the one event an operator is actively waiting for
   * during a build, and it arrives from another machine — so the tab refreshes
   * itself rather than making them press a button. Stops when the tab is
   * hidden so it costs nothing the rest of the time.
   */
  function startPolling() {
    if (_pollTimer) return;
    _pollTimer = setInterval(function () {
      var panel = el("tab-ha");
      if (!panel || !panel.classList.contains("active") || document.hidden) return;
      // Never clobber a form the operator is filling in.
      var active = document.activeElement;
      if (active && active.id && active.id.indexOf("ha-") === 0) return;
      api.ha.status()
        .then(function (r) {
          var pendingBefore = _enrollments.filter(function (e) { return e.status === "pending"; }).length;
          _cfg = r.config;
          _cluster = r.cluster;
          _enrollments = r.enrollments || [];
          _localAddresses = r.localAddresses || [];
          var pendingNow = _enrollments.filter(function (e) { return e.status === "pending"; }).length;
          render();
          if (pendingNow > pendingBefore) {
            showToast("A node is asking to join — review it under Approvals", "success");
          }
        })
        .catch(function () { /* transient; the next tick retries */ });
    }, 10000);
  }

  window.PolarisHaTab = { load: load };
})();
