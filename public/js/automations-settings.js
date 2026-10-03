/* global api, escapeHtml, showToast, showConfirm, openModal, closeModal, tabbedBodyHTML, wireModalTabs, permAtLeast */
/**
 * public/js/automations-settings.js — the Automations page's Settings modal.
 *
 * Opened by the Settings button beside "+ New automation". One tab today,
 * Global Quiet Times (business rule 92): the schedules during which every
 * automation WITHOUT a quiet time of its own holds the people-facing sends of
 * the alerts the schedule selects, and emails a summary when the window ends.
 * Built with the canonical modal tab-strip pair (`tabbedBodyHTML` /
 * `wireModalTabs`) so a second tab is one entry in the list.
 *
 * Exposed as `window.PolarisAutomationSettings`: `open()` from the button,
 * `renderQuietTab()` after a save. The New / Edit verbs open the global
 * quiet-time wizard (quiet-time-wizard.js), which REPLACES this modal — both
 * use the one shared #modal-overlay — and reopens it on its way out
 * (`onDone`), per the wizard canon.
 */
(function () {
  "use strict";

  function canEdit() {
    return typeof permAtLeast === "function" && permAtLeast("automationManagement", "write");
  }

  function open() {
    var body = tabbedBodyHTML("aqs", [
      { key: "quiet", label: "Global Quiet Times", html: '<div id="aqs-quiet"><p class="empty-state">Loading…</p></div>' },
    ]);
    var footer = '<button class="btn btn-secondary" id="aqs-close" type="button">Close</button>';
    openModal("Automation settings", body, footer, { large: true });
    wireModalTabs("aqs");
    document.getElementById("aqs-close").addEventListener("click", function () { closeModal(); });
    renderQuietTab();
  }

  // ── Global Quiet Times tab ─────────────────────────────────────────────────

  async function renderQuietTab() {
    var host = document.getElementById("aqs-quiet");
    if (!host) return;
    var schedules = [];
    var summaries = [];
    try {
      var res = await api.quietTimes.list();
      schedules = (res && res.schedules) || [];
    } catch (err) {
      host.innerHTML = '<p class="empty-state">' + escapeHtml((err && err.message) || "Failed to load quiet times") + "</p>";
      return;
    }
    try {
      var sr = await api.quietTimes.summaries(8);
      summaries = (sr && sr.summaries) || [];
    } catch (_e) { summaries = []; }

    var intro =
      '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin:0 0 0.75rem;max-width:72ch">' +
        "While a global quiet period is open, alerts it covers are still raised and shown on the Active Alerts page, but nobody is " +
        "emailed, pushed or messaged until it ends — then one <strong>summary email</strong> lists what is still outstanding. " +
        "An automation with a quiet time of its own (its Quiet time step) is left alone by these schedules." +
      "</p>";
    var newBtn = canEdit()
      ? '<div style="margin:0 0 0.75rem"><button type="button" class="btn btn-primary" id="aqs-new">+ New quiet time</button></div>'
      : "";

    var table;
    if (!schedules.length) {
      table = '<div class="empty-state" style="padding:1.5rem 1rem;text-align:center">' +
        '<p style="margin:0 0 0.4rem">No global quiet times yet.</p>' +
        '<p style="margin:0;font-size:0.85rem;color:var(--color-text-tertiary);max-width:56ch;margin-inline:auto">' +
          "The usual first one: every night 22:00–06:00, notice through serious, so critical alerts still page and everything else waits for the morning summary." +
        "</p></div>";
    } else {
      table = '<div class="table-wrapper"><table class="data-table"><thead><tr>' +
        "<th>Name</th><th>Devices</th><th>Alerts</th><th>When</th><th>Summary</th><th>Status</th><th></th>" +
        "</tr></thead><tbody>" + schedules.map(rowHtml).join("") + "</tbody></table></div>";
    }

    var recent = summaries.length
      ? '<h4 style="margin:1.25rem 0 0.4rem;font-size:0.95rem">Recent summaries</h4>' +
        '<div class="table-wrapper"><table class="data-table"><thead><tr><th>Sent</th><th>Quiet time</th><th>Covered</th><th>Listed</th><th>Recipients</th><th>Status</th><th></th></tr></thead><tbody>' +
        summaries.map(summaryRowHtml).join("") + "</tbody></table></div>"
      : "";

    host.innerHTML = intro + newBtn + table + recent;

    var nb = document.getElementById("aqs-new");
    if (nb) nb.addEventListener("click", function () { openWizard(null); });
    host.querySelectorAll("[data-qt-edit]").forEach(function (el) {
      el.addEventListener("click", function () {
        var row = schedules.filter(function (s) { return s.id === el.getAttribute("data-qt-edit"); })[0];
        if (row) openWizard(row);
      });
    });
    host.querySelectorAll("[data-qt-delete]").forEach(function (el) {
      el.addEventListener("click", function () { confirmDelete(el.getAttribute("data-qt-delete"), el.getAttribute("data-qt-name")); });
    });
    host.querySelectorAll("[data-qt-toggle]").forEach(function (el) {
      el.addEventListener("change", function () {
        var row = schedules.filter(function (s) { return s.id === el.getAttribute("data-qt-toggle"); })[0];
        if (row) toggle(row, el.checked);
      });
    });
    host.querySelectorAll("[data-qt-resend]").forEach(function (el) {
      el.addEventListener("click", function () { resend(el); });
    });
  }

  /** Send a failed summary again — to the recipients it never reached. */
  async function resend(btn) {
    var id = btn.getAttribute("data-qt-resend");
    btn.disabled = true;
    try {
      var res = await api.quietTimes.resendSummary(id);
      var s = res && res.summary;
      var recips = s && Array.isArray(s.recipients) ? s.recipients : [];
      var sent = recips.filter(function (r) { return r.status === "sent"; }).length;
      showToast(s ? "Summary sent to " + sent + " of " + recips.length + " recipient(s)" : "Summary queued", s && sent === recips.length ? "success" : "error");
    } catch (err) {
      showToast((err && err.message) || "Failed to resend the summary", "error");
    }
    renderQuietTab();
  }

  function scopePhrase(scope) {
    if (!scope || typeof scope !== "object" || scope.allAssets === true) return "All devices";
    if (scope.condition && scope.condition.children && scope.condition.children.length) return "Filtered devices";
    return "All devices";
  }

  function alertsPhrase(q) {
    var sev = q && q.severities && q.severities.length ? q.severities.join(", ") : "every severity";
    var kinds = q && q.alertKinds && q.alertKinds.length
      ? q.alertKinds.length + " alert kind" + (q.alertKinds.length === 1 ? "" : "s")
      : "any alert";
    return sev + " · " + kinds;
  }

  function whenPhrase(q) {
    var wins = (q && q.windows) || [];
    if (!wins.length) return "—";
    var first = window.PolarisRecurrence.summary(wins[0]);
    return wins.length > 1 ? first + " +" + (wins.length - 1) + " more" : first;
  }

  function fmtLocal(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(String(iso || ""));
    if (!m) return String(iso || "");
    var months = window.PolarisRecurrence.months;
    return months[Number(m[2]) - 1] + " " + Number(m[3]) + " " + m[4];
  }

  function rowHtml(s) {
    var q = s.quiet || {};
    var status = !s.enabled
      ? '<span class="badge badge-deprecated">Off</span>'
      : s.inWindow
        ? '<span class="badge badge-warning" title="Alerts it covers are being held right now">Quiet now' + (s.windowEnd ? " until " + escapeHtml(fmtLocal(s.windowEnd)) : "") + "</span>"
        : s.nextWindow
          ? '<span class="badge badge-active">Next ' + escapeHtml(fmtLocal(s.nextWindow.start)) + "</span>"
          : '<span class="badge badge-deprecated">No upcoming period</span>';
    var summary = q.holds === "followUps"
      ? '<span style="color:var(--color-text-tertiary)">none — only reminders and escalations held</span>'
      : (q.summaryAt ? "at " + escapeHtml(q.summaryAt) : "when it ends") +
        (q.recurrenceThreshold ? '<div style="font-size:0.78rem;color:var(--color-text-tertiary)">recurring &gt; ' + q.recurrenceThreshold + "× reported</div>" : "");
    return "<tr>" +
      "<td><strong>" + escapeHtml(s.name) + "</strong>" + (s.configValid === false ? ' <span class="badge badge-deprecated" title="This schedule’s stored config could not be read and is ignored">unreadable</span>' : "") + "</td>" +
      "<td>" + escapeHtml(scopePhrase(s.scope)) + "</td>" +
      "<td>" + escapeHtml(alertsPhrase(q)) + "</td>" +
      "<td>" + escapeHtml(whenPhrase(q)) + "</td>" +
      "<td>" + summary + "</td>" +
      "<td>" + status + "</td>" +
      '<td style="text-align:right;white-space:nowrap">' +
        (canEdit()
          ? '<label style="display:inline-flex;align-items:center;gap:4px;margin:0 8px 0 0;font-weight:400;cursor:pointer" title="Enabled">' +
              '<input type="checkbox" data-qt-toggle="' + escapeHtml(s.id) + '"' + (s.enabled ? " checked" : "") + ' style="width:auto"> On</label>' +
            '<button type="button" class="btn btn-sm" data-qt-edit="' + escapeHtml(s.id) + '">Edit</button> ' +
            '<button type="button" class="btn btn-sm btn-danger" data-qt-delete="' + escapeHtml(s.id) + '" data-qt-name="' + escapeHtml(s.name) + '">Delete</button>'
          : "") +
      "</td>" +
    "</tr>";
  }

  function summaryRowHtml(r) {
    var recips = Array.isArray(r.recipients) ? r.recipients : [];
    var sent = recips.filter(function (x) { return x.status === "sent"; }).length;
    var when = r.sentAt || r.createdAt;
    var d = when ? new Date(when) : null;
    var statusCls = r.status === "sent" || r.status === "empty" ? "badge-active" : (r.status === "pending" || r.status === "partial" ? "badge-warning" : "badge-deprecated");
    // A summary that never (fully) reached its readers can be sent again by
    // hand once the channel is fixed — only to the recipients who missed it.
    var failed = r.status === "failed" || r.status === "partial-failed" || r.status === "unroutable";
    var firstErr = (recips.filter(function (x) { return x.error; })[0] || {}).error || "";
    return "<tr>" +
      "<td>" + (d ? escapeHtml(d.toLocaleString()) : "—") + "</td>" +
      "<td>" + escapeHtml(r.sourceName) + ' <span style="font-size:0.78rem;color:var(--color-text-tertiary)">(' + (r.sourceKind === "global" ? "global" : "automation") + ")</span></td>" +
      "<td>" + escapeHtml((r.notificationIds || []).length + " alert" + ((r.notificationIds || []).length === 1 ? "" : "s")) + "</td>" +
      "<td>" + escapeHtml(r.listedCount + " outstanding" + (r.recurringCount ? ", " + r.recurringCount + " recurring" : "")) + "</td>" +
      "<td>" + (recips.length ? escapeHtml(sent + "/" + recips.length) : "—") + "</td>" +
      '<td><span class="badge ' + statusCls + '"' + (firstErr ? ' title="' + escapeHtml(firstErr) + '"' : "") + '>' + escapeHtml(r.status) + "</span></td>" +
      '<td style="text-align:right;white-space:nowrap">' +
        (failed && canEdit() && recips.length
          ? '<button type="button" class="btn btn-sm" data-qt-resend="' + escapeHtml(r.id) + '" title="Send again to the recipients it did not reach">Resend</button>'
          : "") +
      "</td>" +
    "</tr>";
  }

  function openWizard(row) {
    if (!window.PolarisQuietTimeWizard) { showToast("The quiet-time editor did not load", "error"); return; }
    // The wizard replaces this modal and calls back when it closes, saved or
    // not, so the operator lands back on the list they came from.
    window.PolarisQuietTimeWizard.open(row, { onDone: open });
  }

  async function toggle(row, enabled) {
    try {
      await api.quietTimes.update(row.id, { name: row.name, enabled: enabled, scope: row.scope || {}, quiet: row.quiet });
      showToast(enabled ? "Quiet time enabled" : "Quiet time disabled", "success");
    } catch (err) {
      showToast((err && err.message) || "Failed to update the quiet time", "error");
    }
    renderQuietTab();
  }

  async function confirmDelete(id, name) {
    var ok = await showConfirm(
      "Delete quiet time “" + (name || id) + "”?\n\nAlerts it is holding right now are summarised straight away; nothing is lost.",
    );
    if (!ok) return;
    try {
      await api.quietTimes.delete(id);
      showToast("Quiet time deleted", "success");
    } catch (err) {
      showToast((err && err.message) || "Failed to delete the quiet time", "error");
    }
    renderQuietTab();
  }

  window.PolarisAutomationSettings = { open: open, renderQuietTab: renderQuietTab };
})();
