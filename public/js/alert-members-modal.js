/* public/js/alert-members-modal.js — PolarisAlertMembers: the components one
 * GROUPED alert is made of (business rule 75), in a modal.
 *
 * A grouped alert names many problems on one device — eight PoE ports, two
 * SD-WAN members, a temperature and a fan from two automations of one Alert
 * Group — and every list surface shows it as ONE row whose message carries a
 * capped summary. This dialog is the way back to the parts: each contribution,
 * which automation raised it, its own severity and reading, when it joined,
 * and — for the ones that have recovered — when they left.
 *
 * Opened from a row menu on the Active Alerts widget and on the asset
 * slide-over's Alerts tab, through `openAlertMembers` in app.js, which loads
 * this file on first use (no page carries it statically).
 *
 * What it reads, and what it must not:
 *   • `members` is the alert's RENDER SNAPSHOT, not the live truth (the engine
 *     counts NotificationRuleState rows to decide whether the alert is over).
 *     That is exactly what a reader wants here — what this alert covered and
 *     who has left it — and it is why a recovered member is shown, not hidden:
 *     the snapshot keeps departures on purpose.
 *   • A caller that already HOLDS the row (the Alerts tab's feed carries every
 *     scalar column) passes it, and nothing is fetched — that tab is gated
 *     assets:read and must not need alerts:read to explain its own rows. A
 *     caller holding only an id (the widget's feed does not ship the snapshot)
 *     passes the id, and the dialog reads GET /alerts/:id, the same read the
 *     acknowledge dialog makes, gated alerts:read.
 */

(function () {
  "use strict";

  function esc(s) {
    return typeof window.escapeHtml === "function"
      ? window.escapeHtml(s)
      : String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
  }

  function rank(sev) {
    return typeof window._alertSevRank === "function" ? window._alertSevRank(sev) : 0;
  }

  function when(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function natural(a, b) {
    return String(a || "").localeCompare(String(b || ""), undefined, { numeric: true, sensitivity: "base" });
  }

  /**
   * Still-affected first, worst severity first, then by name — the order the
   * alert's own message names them in. Recovered ones after, most recent
   * departure first: the one that just came back is the one being asked about.
   */
  function ordered(members) {
    var active = members.filter(function (m) { return !m.leftAt; });
    var left = members.filter(function (m) { return !!m.leftAt; });
    active.sort(function (a, b) { return (rank(b.severity) - rank(a.severity)) || natural(a.label || a.key, b.label || b.key); });
    left.sort(function (a, b) { return new Date(b.leftAt).getTime() - new Date(a.leftAt).getTime(); });
    return { active: active, left: left };
  }

  /** Several automations only under an Alert Group; one automation folding
   *  its own components needs no Automation column — every row would repeat
   *  the alert's own name. */
  function manyRules(members) {
    var seen = {};
    members.forEach(function (m) { if (m.ruleId) seen[m.ruleId] = true; });
    return Object.keys(seen).length > 1;
  }

  function rowHTML(m, showRule) {
    var recovered = !!m.leftAt;
    var sev = m.severity || "info";
    var status = recovered
      ? '<span class="badge badge-active" title="' + esc("Recovered " + when(m.leftAt)) + '">Recovered</span>'
      : '<span class="badge badge-level-' + esc(sev) + '">' + esc(sev.toUpperCase()) + "</span>";
    var dim = recovered ? ' style="opacity:0.6"' : "";
    // The KEY rides the title: the label is what a human reads ("port12 (AP-1)"),
    // the key is what a dimension filter or another surface calls it.
    var name = m.label || m.key || "Whole device";
    var nameTitle = m.key && m.key !== name ? ' title="' + esc(m.key) + '"' : "";
    return "<tr" + dim + ">" +
      "<td>" + status + "</td>" +
      '<td style="font-family:var(--font-mono);font-size:0.82rem;overflow-wrap:anywhere"' + nameTitle + ">" + esc(name) + "</td>" +
      (showRule ? "<td>" + esc(m.ruleName || "") + "</td>" : "") +
      '<td style="font-family:var(--font-mono);font-size:0.82rem">' + esc(m.value == null ? "—" : m.value) + "</td>" +
      '<td style="font-family:var(--font-mono);font-size:0.82rem;white-space:nowrap">' + esc(when(m.joinedAt)) + "</td>" +
      '<td style="font-family:var(--font-mono);font-size:0.82rem;white-space:nowrap">' + esc(recovered ? when(m.leftAt) : "—") + "</td>" +
      "</tr>";
  }

  function bodyHTML(alert) {
    var members = Array.isArray(alert.members) ? alert.members : [];
    var o = ordered(members);
    var showRule = manyRules(members);
    var owner = alert.groupName
      ? "Alert group: " + alert.groupName
      : alert.ruleName ? "Grouped by device — " + alert.ruleName : "Grouped by device";
    var head = '<div style="margin-bottom:0.8rem">' +
      '<div style="color:var(--color-text-secondary);font-size:0.85rem">' + esc(owner) +
        (alert.assetHostname ? " · " + esc(alert.assetHostname) : "") + "</div>" +
      (alert.message ? '<div style="margin-top:0.3rem">' + esc(alert.message) + "</div>" : "") +
      '<div style="color:var(--color-text-tertiary);font-size:0.82rem;margin-top:0.3rem">' +
        o.active.length + " still affected" + (o.left.length ? " · " + o.left.length + " recovered" : "") + "</div>" +
      "</div>";
    if (!members.length) {
      return head + '<p class="empty-state">This alert carries no component list — it was raised before grouping recorded one.</p>';
    }
    var cols = '<th style="width:110px">Status</th><th>Component</th>' + (showRule ? "<th>Automation</th>" : "") +
      '<th style="width:90px">Value</th><th style="width:130px">Joined</th><th style="width:130px">Recovered</th>';
    var rows = o.active.concat(o.left).map(function (m) { return rowHTML(m, showRule); }).join("");
    return head +
      '<div class="table-wrapper" style="max-height:60vh;overflow:auto">' +
        '<table class="data-table"><thead><tr>' + cols + "</tr></thead><tbody>" + rows + "</tbody></table>" +
      "</div>";
  }

  function footerHTML(opts) {
    return (opts.onOpenDevice ? '<button type="button" class="btn btn-secondary" id="alert-members-device">Open device</button>' : "") +
      '<button type="button" class="btn btn-primary" id="alert-members-close">Close</button>';
  }

  function render(alert, opts) {
    window.openModal("Alerts in this group", bodyHTML(alert), footerHTML(opts));
    var close = document.getElementById("alert-members-close");
    if (close) close.addEventListener("click", function () { window.closeModal(); });
    var dev = document.getElementById("alert-members-device");
    if (dev) dev.addEventListener("click", function () { window.closeModal(); opts.onOpenDevice(); });
  }

  /**
   * open(alertOrId, opts) — `alertOrId` is a row already holding `members`, or
   * an alert id to read. opts.onOpenDevice adds an "Open device" button.
   */
  function open(alertOrId, opts) {
    opts = opts || {};
    if (alertOrId && typeof alertOrId === "object" && Array.isArray(alertOrId.members)) {
      render(alertOrId, opts);
      return Promise.resolve();
    }
    var id = typeof alertOrId === "object" && alertOrId ? alertOrId.id : alertOrId;
    return window.api.alerts.get(id).then(function (alert) {
      render(alert || {}, opts);
    }).catch(function (err) {
      if (typeof window.showToast === "function") {
        window.showToast((err && err.message) || "Couldn't load this alert's components", "error");
      }
    });
  }

  window.PolarisAlertMembers = { open: open };
})();
