/* global api, escapeHtml, showToast, showConfirm, openModal, closeModal, tabbedBodyHTML, wireModalTabs, permAtLeast, buildOverlay */
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
        // Widths: Devices and Alerts carry prose ("All devices", the per-severity
        // phrasing) and must not wrap mid-word; When is a short window summary.
        '<th style="width:16%">Name</th><th style="width:18%;min-width:9rem">Devices</th><th style="width:26%">Alerts</th>' +
        '<th style="width:14%">When</th><th style="width:12%">Summary</th><th style="width:8%">Status</th><th></th>' +
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
    host.querySelectorAll("[data-qt-detail]").forEach(function (el) {
      el.addEventListener("click", function () { openDetail(el.getAttribute("data-qt-id"), el.getAttribute("data-qt-detail")); });
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
    var QE = window.PolarisQuietTimeEditor;
    var sev = QE ? QE.describeHeld(q || {}) : (q && q.severities && q.severities.length ? q.severities.join(", ") : "every severity");
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
    var QE = window.PolarisQuietTimeEditor;
    var summary = !(QE ? QE.policySummarises(q) : q.holds !== "followUps")
      ? '<span style="color:var(--color-text-tertiary)">none — no first alert is held, so there is nothing to report</span>'
      : (q.summaryAt ? "at " + escapeHtml(q.summaryAt) : "when it ends") +
        (q.recurrenceThreshold ? '<div style="font-size:0.78rem;color:var(--color-text-tertiary)">recurring &gt; ' + q.recurrenceThreshold + "× reported</div>" : "");
    return "<tr>" +
      "<td><strong>" + escapeHtml(s.name) + "</strong>" + (s.configValid === false ? ' <span class="badge badge-deprecated" title="This schedule’s stored config could not be read and is ignored">unreadable</span>' : "") + "</td>" +
      '<td style="white-space:nowrap">' + escapeHtml(scopePhrase(s.scope)) + "</td>" +
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
      // The three counts open the lists behind them (a stacked overlay over
      // this modal): which alerts the summary stamped, what the email said,
      // and who it went to with each address's outcome.
      "<td>" + detailBtn(r.id, "covered", (r.notificationIds || []).length + " alert" + ((r.notificationIds || []).length === 1 ? "" : "s"), "Every alert this summary covered") + "</td>" +
      "<td>" + detailBtn(r.id, "listed", r.listedCount + " outstanding" + (r.recurringCount ? ", " + r.recurringCount + " recurring" : ""), "What the email listed") + "</td>" +
      "<td>" + (recips.length ? detailBtn(r.id, "recipients", sent + "/" + recips.length, "Who it went to, and whether it arrived") : "—") + "</td>" +
      '<td><span class="badge ' + statusCls + '"' + (firstErr ? ' title="' + escapeHtml(firstErr) + '"' : "") + '>' + escapeHtml(r.status) + "</span></td>" +
      '<td style="text-align:right;white-space:nowrap">' +
        (failed && canEdit() && recips.length
          ? '<button type="button" class="btn btn-sm" data-qt-resend="' + escapeHtml(r.id) + '" title="Send again to the recipients it did not reach">Resend</button>'
          : "") +
      "</td>" +
    "</tr>";
  }

  function detailBtn(id, kind, label, title) {
    return '<button type="button" class="qt-detail" data-qt-detail="' + kind + '" data-qt-id="' + escapeHtml(id) + '" title="' + escapeHtml(title) + '" ' +
      'style="background:none;border:none;padding:0;font:inherit;color:var(--color-accent);cursor:pointer;text-decoration:underline dotted">' + escapeHtml(label) + "</button>";
  }

  var SEV_ORDER = { critical: 0, serious: 1, warning: 2, informational: 3, notice: 4 };
  function sevPill(sev) {
    return '<span class="badge badge-level-' + escapeHtml(sev) + '">' + escapeHtml(String(sev || "").toUpperCase()) + "</span>";
  }
  function fmtAt(v) {
    if (!v) return "—";
    var d = new Date(v);
    return isNaN(d.getTime()) ? String(v) : d.toLocaleString();
  }
  function deviceCell(assetId, hostname, dimension) {
    var name = escapeHtml(hostname || "(no device)");
    // The same landing path the summary email links (`assetOpenPath`).
    var link = assetId ? '<a href="/assets/' + encodeURIComponent(assetId) + '" target="_blank" rel="noopener">' + name + "</a>" : name;
    return link + (dimension ? ' <span style="color:var(--color-text-tertiary)">· ' + escapeHtml(dimension) + "</span>" : "");
  }
  var TH = 'style="text-align:left;padding:6px 10px;font-size:0.72rem;letter-spacing:.06em;text-transform:uppercase;color:var(--color-text-tertiary)"';
  var TD = 'style="padding:6px 10px;border-top:1px solid var(--color-border);font-size:0.85rem;vertical-align:top"';

  /** The Covered list: every alert the summary stamped, as it is now. */
  function coveredHtml(d) {
    var rows = (d.covered || []).slice().sort(function (a, b) {
      return (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9) || String(a.triggeredAt).localeCompare(String(b.triggeredAt));
    });
    if (!rows.length) return '<p class="hint">Nothing was held during this quiet period — this was an all-quiet summary.</p>';
    return '<p class="hint" style="margin:0 0 8px">Every alert held and covered by this summary, as it is now. <strong>Listed</strong> marks the ones the email named; the rest had recovered under the threshold by the time it was sent.</p>' +
      '<table style="width:100%;border-collapse:collapse"><thead><tr><th ' + TH + '>Severity</th><th ' + TH + '>Device</th><th ' + TH + '>What</th><th ' + TH + '>Fired</th><th ' + TH + '>Now</th></tr></thead><tbody>' +
      rows.map(function (n) {
        var now = n.cleared
          ? '<span style="color:var(--color-success,#15803d)">Recovered' + (n.clearedAt ? " " + escapeHtml(fmtAt(n.clearedAt)) : "") + "</span>"
          : '<span style="color:var(--color-sev-critical,#dc2626);font-weight:600">Still active</span>' + (n.acknowledged ? ' <span class="badge badge-active">ACK</span>' : "");
        return "<tr><td " + TD + ">" + sevPill(n.severity) + (n.listed ? ' <span class="badge badge-active" title="Named in the summary email">LISTED</span>' : "") + "</td>" +
          "<td " + TD + ">" + deviceCell(n.assetId, n.assetHostname, n.dimension) + "</td>" +
          "<td " + TD + ">" + escapeHtml(n.message || "") + (n.ruleName ? '<div style="font-size:0.78rem;color:var(--color-text-tertiary)">' + escapeHtml(n.ruleName) + "</div>" : "") + "</td>" +
          "<td " + TD + ' style="white-space:nowrap">' + escapeHtml(fmtAt(n.triggeredAt)) + "</td>" +
          "<td " + TD + ">" + now + "</td></tr>";
      }).join("") + "</tbody></table>";
  }

  /** The Listed view: what the email said — outstanding rows, then recurring ones with every fire time. */
  function listedHtml(d) {
    var out = (d.listed && d.listed.outstanding) || [];
    var rec = (d.listed && d.listed.recurring) || [];
    if (!out.length && !rec.length) {
      var held = d.summary && d.summary.details && d.summary.details.heldCount;
      return '<p class="hint">The email listed nothing: ' + (held ? held + " alert" + (held === 1 ? "" : "s") + " fired and recovered during the quiet period" : "no alerts were held") + ". It was sent as the all-quiet summary.</p>";
    }
    var html = "";
    if (out.length) {
      html += '<h4 style="margin:0 0 6px;font-size:0.85rem">Still outstanding (' + out.length + ")</h4>" +
        '<table style="width:100%;border-collapse:collapse;margin-bottom:14px"><thead><tr><th ' + TH + '>Severity</th><th ' + TH + '>Device</th><th ' + TH + '>What</th><th ' + TH + '>Since</th></tr></thead><tbody>' +
        out.map(function (r) {
          return "<tr><td " + TD + ">" + sevPill(r.severity) + "</td><td " + TD + ">" + deviceCell(r.assetId, r.assetHostname, r.dimension) + "</td>" +
            "<td " + TD + ">" + escapeHtml(r.message || "") + (r.ruleName ? '<div style="font-size:0.78rem;color:var(--color-text-tertiary)">' + escapeHtml(r.ruleName) + "</div>" : "") + "</td>" +
            "<td " + TD + ' style="white-space:nowrap">' + escapeHtml(fmtAt(r.triggeredAt)) + "</td></tr>";
        }).join("") + "</tbody></table>";
    }
    if (rec.length) {
      var th = d.listed.recurrenceThreshold;
      html += '<h4 style="margin:0 0 6px;font-size:0.85rem">Recurring (' + rec.length + ")" + (th ? ' <span style="font-weight:400;color:var(--color-text-tertiary)">— fired more than ' + th + " time" + (th === 1 ? "" : "s") + "</span>" : "") + "</h4>" +
        '<table style="width:100%;border-collapse:collapse"><thead><tr><th ' + TH + '>Device</th><th ' + TH + '>What</th><th ' + TH + '>Fired</th><th ' + TH + '>When</th></tr></thead><tbody>' +
        rec.map(function (r) {
          return "<tr><td " + TD + ">" + deviceCell(r.assetId, r.assetHostname, r.dimension) + "</td>" +
            "<td " + TD + ">" + sevPill(r.severity) + " " + escapeHtml(r.ruleName || "") + '<div style="font-size:0.78rem;color:' + (r.stillActive ? "var(--color-sev-critical,#dc2626)" : "var(--color-success,#15803d)") + '">' + (r.stillActive ? "Still active" : "Recovered") + "</div></td>" +
            "<td " + TD + ' style="white-space:nowrap"><strong>' + r.count + "</strong> time" + (r.count === 1 ? "" : "s") + "</td>" +
            "<td " + TD + ">" + (r.times || []).map(function (t) { return escapeHtml(fmtAt(t)); }).join("<br>") + "</td></tr>";
        }).join("") + "</tbody></table>";
    }
    return html;
  }

  /** The Recipients view: every address with its outcome. */
  function recipientsHtml(d) {
    var recips = (d.summary && Array.isArray(d.summary.recipients)) ? d.summary.recipients : [];
    if (!recips.length) return '<p class="hint">This summary had no recipients.</p>';
    return '<table style="width:100%;border-collapse:collapse"><thead><tr><th ' + TH + '>Address</th><th ' + TH + '>Status</th><th ' + TH + '>Attempts</th><th ' + TH + '>Error</th></tr></thead><tbody>' +
      recips.map(function (r) {
        var cls = r.status === "sent" ? "badge-active" : r.status === "pending" ? "badge-warning" : "badge-deprecated";
        return "<tr><td " + TD + ">" + escapeHtml(r.address) + (r.userId ? ' <span style="font-size:0.78rem;color:var(--color-text-tertiary)">(account)</span>' : "") + "</td>" +
          "<td " + TD + '><span class="badge ' + cls + '">' + escapeHtml(r.status) + "</span></td>" +
          "<td " + TD + ">" + escapeHtml(String(r.attempts == null ? "—" : r.attempts)) + "</td>" +
          "<td " + TD + ">" + (r.error ? escapeHtml(r.error) : "—") + "</td></tr>";
      }).join("") + "</tbody></table>";
  }

  /** Open one of the three lists over the Settings modal. */
  async function openDetail(id, kind) {
    var d;
    try {
      d = await api.quietTimes.summary(id);
    } catch (err) {
      showToast((err && err.message) || "Could not load the summary", "error");
      return;
    }
    var s = d.summary || {};
    var range = fmtAt(s.coveredFrom) + " → " + fmtAt(s.coveredTo);
    var titles = { covered: "Alerts covered", listed: "What the email listed", recipients: "Recipients" };
    var body = '<p style="margin:0 0 10px;font-size:0.85rem;color:var(--color-text-secondary)">' + escapeHtml(s.sourceName || "") +
      ' <span style="color:var(--color-text-tertiary)">(' + (s.sourceKind === "global" ? "global quiet time" : "automation quiet time") + ") · " + escapeHtml(range) + "</span></p>" +
      (kind === "covered" ? coveredHtml(d) : kind === "listed" ? listedHtml(d) : recipientsHtml(d));
    if (typeof buildOverlay !== "function") { showToast("The dialog helper did not load", "error"); return; }
    var layer = buildOverlay(1300, titles[kind] || "Summary", body, '<button type="button" class="btn btn-secondary" id="qt-detail-close">Close</button>', null, kind !== "recipients");
    var closeBtn = layer.dialog.querySelector("#qt-detail-close");
    if (closeBtn) closeBtn.addEventListener("click", layer.close);
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
