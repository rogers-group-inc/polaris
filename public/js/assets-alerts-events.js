/**
 * public/js/assets-alerts-events.js — the asset's Alerts tab (acknowledge / clear, the rules that apply)
 * and Events tab (asset-scoped audit history, its export and detail).
 *
 * Part of the Assets page script (CQ-F050): plain browser scripts sharing
 * page globals, loaded right after assets.js on every page that carries it
 * and in app-panels.js's asset bundle, in ASSETS_FILES order. Nothing here
 * runs at load beyond listener wiring. See tests/unit/assetsSplit.test.ts.
 */

// ─── Events tab (asset-scoped audit history) ────────────────────────────────
// Self-contained reimplementation of the Events-page table + change-Detail
// popup, scoped to one asset (assetId baked into every
// fetch). events.js is only loaded on events.html, so its renderTable /
// showEventDetail / TableSF wiring aren't available here — these mirror
// public/js/events.js. Follows polaris-ui-canon → "Sortable + filterable data
// table (server-side mode)" + offset pagination outside TableSF, and
// applyTableLayout for the column resize/chooser (dynamic-table variant).
var _assetEventsCurrentPage = [];   // current page of rows (Detail lookup by idx)
var _assetEventsAssetId = null;     // asset this tab is bound to
var _assetEventsSF = null;          // TableSF instance (server-side mode)
var _assetEventsLayout = null;      // applyTableLayout handle
var _assetEventsPageSize = 15;
var _assetEventsOffset = 0;
var _assetEventsTotal = 0;
var _assetEventsLoaded = false;     // lazy-load guard (first tab click)

// Asset-details Alerts tab: active alerts for this asset + the automations
// whose scope matches it. Both loaded by _loadAssetNotificationsTab.

/**
 * The active-alerts table's shape, resolved from the viewer's permissions in
 * ONE place so the header markup and the loader's empty-state colspan can't
 * drift apart. Selection exists only for an operator who can actually act on
 * a batch — checkboxes that lead nowhere are worse than no checkboxes.
 */
function _assetAlertTableShape() {
  var canAck = permAtLeast("alerts", "write");
  var canClear = typeof canClearAlerts === "function" ? canClearAlerts() : false;
  var canSelect = canAck || canClear;
  return {
    canAck: canAck,
    canClear: canClear,
    canSelect: canSelect,
    // Time, Severity, Alert, Acknowledge, Actions (+ the checkbox column).
    colspan: 5 + (canSelect ? 1 : 0),
  };
}

function _assetNotificationsTabHTML() {
  // Actions column: an unacknowledged row offers Acknowledge (alerts:write),
  // an acknowledged one names who did it, and Clear (alerts:fullwrite) sits
  // beside either. Until this tab grew them, api.alerts.acknowledge had no
  // caller at all, which left escalation chains set to stopOn:"acknowledge"
  // unstoppable, and clearing an alert was desktop-Automations-page-only.
  var shape = _assetAlertTableShape();
  var actionW = shape.canAck && shape.canClear ? "240" : (shape.canAck || shape.canClear ? "200" : "160");
  // No bulk bar (removed 2026-10-29): rows are selected by clicking them, and
  // a right click on one of several selected rows offers Acknowledge / Clear
  // for the whole selection (_assetAlertMenuItems). One switch losing its
  // uplink raises one alert per pinned interface, so acting on many at once
  // still has to be one prompt and one confirm.
  // Down detection FIRST: "which automation decides this device is down?" is
  // the question an operator opens this tab with once the count lives on
  // automations, and the answer is not in either table below — the governing
  // automation may not have fired, and a PASSIVE device has no automation at
  // all. Filled in asynchronously by _paintAssetDownDetectionPanel.
  var downBlock = '<div class="section-block">' +
    '<h4 style="margin:0 0 0.5rem">Down detection</h4>' +
    '<p class="hint" id="asset-down-detection-panel">Resolving…</p>' +
  '</div>';

  return downBlock + '<div class="section-block">' +
    '<h4 style="margin:0 0 0.5rem">Active alerts <span id="asset-notif-active-count" style="color:var(--color-text-tertiary);font-weight:400"></span></h4>' +
    // Self-bounding sticky header (max-height set here, no JS sizer — see the
    // .table-wrapper-modal-sticky note in styles.css): a device whose gate went
    // down fills this table, and the header scrolling away took with it the
    // only thing that said which column was which.
    '<div class="table-wrapper table-wrapper-modal-sticky" style="max-height:42vh"><table><thead><tr>' +
      (shape.canSelect ? '<th class="cb-col"></th>' : "") +
      '<th style="width:160px">Time</th><th style="width:80px">Severity</th>' +
      // The alert sentence. It already carries the dimension the alert was
      // raised FOR — an interface, a sensor, a mount — as `[label]`, which is
      // what keeps the two dozen rows a switch losing its uplink produces
      // tellable apart; the dimension had its own column until that turned out
      // to restate the sentence. A rule with a custom messageTemplate that
      // drops the label keeps it in this cell's title instead.
      // The only unsized column, so without a floor it absorbs every pixel the
      // ~750px of fixed columns take from a narrow slide-over and shrinks to
      // one character per line; with it the wrapper scrolls sideways instead.
      '<th style="min-width:260px">Alert</th>' +
      // What the acknowledger wrote. requireAckNote exists to make an operator
      // say what the problem was and what the fix was, and until this column
      // the answer was stored on the row and rendered by nothing.
      '<th style="width:240px">Acknowledge</th>' +
      '<th style="width:' + actionW + 'px">Actions</th>' +
    '</tr></thead><tbody id="asset-notif-active-tbody"><tr><td colspan="' + shape.colspan + '" class="empty-state">Loading…</td></tr></tbody></table></div>' +
    '<h4 style="margin:1rem 0 0.5rem">This Asset\'s Automations</h4>' +
    '<div class="table-wrapper"><table><thead><tr>' +
      '<th style="width:200px">Name</th><th style="min-width:260px">Trigger</th><th style="width:180px">Scope</th>' +
    '</tr></thead><tbody id="asset-notif-rules-tbody"><tr><td colspan="3" class="empty-state">Loading…</td></tr></tbody></table></div>' +
  '</div>';
}

// The automation sentence builder, resolved once per page load: the wizard's
// pure factory (automations-wizard.js) over GET /automations/schema, so the
// Trigger column reads in exactly the words the edit modal's own summary uses
// and can't drift from it. Resolves to null — and the column falls back to the
// bare trigger-type badge — when the wizard file isn't loaded or the viewer
// can't read the automation schema (the tab itself only needs alerts:read).
var _assetRuleSentencesP = null;
function _assetRuleSentences() {
  if (_assetRuleSentencesP) return _assetRuleSentencesP;
  var factory = window.PolarisAutomationSentences;
  if (!factory || !permAtLeast("automationManagement", "read")) {
    _assetRuleSentencesP = Promise.resolve(null);
    return _assetRuleSentencesP;
  }
  // Share the wizard's own schema cache in both directions, so opening the
  // edit modal from this tab costs no second fetch.
  var schema = window._ruleSchema
    ? Promise.resolve(window._ruleSchema)
    : api.automations.schema().then(function (s) { window._ruleSchema = s; return s; });
  _assetRuleSentencesP = schema.then(function (s) { return factory.make(s); }).catch(function () { return null; });
  return _assetRuleSentencesP;
}

/**
 * Order the active list for reading, not just for recency. Every alert of one
 * outage carries the same triggeredAt to the second, so the server's
 * triggeredAt-desc leaves the rows that differ only by dimension in arbitrary
 * order; sorting equal timestamps by dimension (numerically, so port2 precedes
 * port10) puts the ports in the order the operator thinks about them.
 */
function _sortAssetAlerts(active) {
  return active.slice().sort(function (a, b) {
    var d = new Date(b.triggeredAt || 0).getTime() - new Date(a.triggeredAt || 0).getTime();
    if (d) return d;
    return String(a.dimension || "").localeCompare(String(b.dimension || ""), undefined, { numeric: true, sensitivity: "base" });
  });
}

/**
 * Answer "which automation decides this device is Down, and at what count?" —
 * the question this tab is opened with now that the number lives on
 * automations rather than in Monitor Settings.
 *
 * Neither table below answers it: the governing automation may not have fired,
 * and a PASSIVE device has no automation at all. The passive case gets the
 * loudest treatment and a way out, because it is the state where Polaris will
 * never tell anyone this device went down.
 */
function _paintAssetDownDetectionPanel(assetId) {
  var el = document.getElementById("asset-down-detection-panel");
  if (!el) return;
  api.assets.effectiveMonitorSettings(assetId).then(function (eff) {
    var el2 = document.getElementById("asset-down-detection-panel");
    if (!el2) return;
    var dd = eff && eff.downDetection;
    if (!dd) { el2.textContent = "Could not resolve which automation decides Down for this device."; return; }
    if (dd.passive) {
      var canEdit = permAtLeast("automationManagement", "write");
      el2.innerHTML =
        '<strong style="color:var(--color-warning)">Passive</strong> — no down-detection automation covers this device. ' +
        'Polaris records its polls but will never declare it Missed or Down, and no alert will ever be raised about it going offline.' +
        (canEdit ? ' <a href="/automations.html">Create a down-detection automation &rarr;</a>' : '');
      return;
    }
    var calc = window.PolarisMonitorDownAfter && window.PolarisMonitorDownAfter.calc;
    var resolved = eff.resolved || {};
    var txt = "Down for this device is decided by ";
    txt += dd.automationName ? "<strong>" + escapeHtml(dd.automationName) + "</strong>" : "an automation";
    txt += " — <strong>" + dd.missedPolls + " missed poll" + (dd.missedPolls === 1 ? "" : "s") + "</strong>";
    if (calc) {
      var c = calc(dd.missedPolls, resolved.intervalSeconds, resolved.probeTimeoutMs, dd.recoveryPolls);
      txt += ", ≈ " + window.PolarisMonitorDownAfter.human(c.realSec) + " at this device's " + c.interval + "s poll interval";
    }
    txt += ".";
    if (dd.recoveryPolls > dd.missedPolls) {
      txt += " The same automation decides the way back: <strong>" + dd.recoveryPolls +
        " received polls</strong> before it reads Up again.";
    }
    if (dd.conflict) {
      txt += ' <span style="color:var(--color-warning)">Another equally-specific automation asks for ' +
        dd.conflict.counts.filter(function (n) { return n !== dd.conflict.chosen; }).join(" / ") +
        ' — Polaris uses the smaller count. Narrow one of the two device filters to make the choice explicit.</span>';
    }
    el2.innerHTML = txt;
  }).catch(function () {
    var el3 = document.getElementById("asset-down-detection-panel");
    if (el3) el3.textContent = "Could not resolve which automation decides Down for this device.";
  });
}
function _loadAssetNotificationsTab(assetId) {
  _paintAssetDownDetectionPanel(assetId);
  var sentencesReady = _assetRuleSentences();
  api.assets.alerts(assetId).then(function (data) {
    var active = _sortAssetAlerts((data && data.active) || []);
    var rules = (data && data.matchingRules) || [];
    // Before the table renders: the tab is worth marking even if the body
    // below it fails to paint for some reason.
    _paintAssetAlertsTabStrobe(active);
    var aTbody = document.getElementById("asset-notif-active-tbody");
    if (aTbody) {
      var shape = _assetAlertTableShape();
      // The count is what makes a clear visible: with two dozen rows reading
      // the same sentence, removing one changes nothing an eye can catch.
      var countEl = document.getElementById("asset-notif-active-count");
      if (countEl) countEl.textContent = active.length ? "(" + active.length + ")" : "";
      aTbody.innerHTML = active.length ? active.map(function (n) {
        // Guarded: assetAlertsTabDom loads this tab without api.js.
        var _alertTz = typeof timeZoneOpts === "function" ? timeZoneOpts() : {};
        var ts = new Date(n.triggeredAt).toLocaleString(undefined, Object.assign({ month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }, _alertTz));
        // Actions is buttons only now — who acknowledged moved to the
        // Acknowledge column, next to what they wrote. Acknowledge (write) and
        // Clear (fullwrite) are separate permission levels, so a row can carry
        // either, both, or neither.
        var parts = [];
        if (!n.acknowledged && shape.canAck && n.canAcknowledge !== false) {
          // The automation's note policy rides the control that uses it, so
          // the modal can mark the field required without a second fetch.
          parts.push('<button class="btn btn-sm btn-secondary asset-alert-ack" data-id="' + escapeHtml(n.id) + '"' +
            (n.requireAckNote ? ' data-note-required="1"' : "") + '>Acknowledge</button>');
        }
        if (shape.canClear && n.canClear !== false) {
          parts.push('<button class="btn btn-sm btn-secondary asset-alert-clear" data-id="' + escapeHtml(n.id) + '">Clear</button>');
        }
        if (!parts.length) parts.push('<span style="color:var(--color-text-tertiary)">—</span>');
        var sel = shape.canSelect
          ? '<td class="cb-col"><input type="checkbox" class="asset-alert-sel" data-id="' + escapeHtml(n.id) + '"' +
            (n.requireAckNote ? ' data-note-required="1"' : "") + ' aria-label="Select this alert"></td>'
          : "";
        // The acknowledgement, note first: that is the part telling the next
        // operator what happened. An acknowledged row with no note still shows
        // its attribution — "acknowledged, nothing said" and "not
        // acknowledged" are different facts, and the note is optional unless
        // the automation sets requireAckNote.
        var ackCell = '<span style="color:var(--color-text-tertiary)">—</span>';
        if (n.acknowledged) {
          var when = n.acknowledgedAt
            ? new Date(n.acknowledgedAt).toLocaleString(undefined, Object.assign({ month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }, _alertTz))
            : "";
          var note = (n.acknowledgeNote || "").trim();
          // A note is free text an operator typed, so it wraps and breaks
          // rather than stretching the column past its declared width.
          ackCell = (note
            ? '<div style="font-size:0.82rem;white-space:pre-wrap;overflow-wrap:anywhere">' + escapeHtml(note) + '</div>'
            : '<div style="font-size:0.82rem;color:var(--color-text-tertiary)">No note</div>') +
            '<div style="color:var(--color-text-tertiary);font-size:0.78rem;margin-top:0.15rem">' +
            escapeHtml((n.acknowledgedBy || "acknowledged") + (when ? " · " + when : "")) + '</div>';
        }
        // The metric and the dimension ride the Alert cell's title rather than
        // a column of their own: both are the same value on every row of one
        // automation, so they identify nothing, but together they say what the
        // sentence's `[label]` IS on the rows where a bare name ("port12",
        // "TMP1") could be several things — and they are the fallback for a
        // custom messageTemplate that renders no label at all.
        var alertTitle = [n.metric, n.dimension].filter(Boolean).join(" · ");
        // Raised for this device while it was dependency-down (business rule
        // 78): the same slate badge the Status pill wears, beside the
        // severity, so the row reads as that state at a glance.
        // An escalation tier has sent for this alert (business rule 145) —
        // the same ESCALATED pill the Active Alerts widget wears.
        var escBadge = n.escalationTier
          ? ' <span class="badge badge-escalated" title="' + escapeHtml("Escalated — tier " + n.escalationTier + " has been notified" +
              (n.escalatedAt ? " (first escalation " + new Date(n.escalatedAt).toLocaleString() + ")" : "")) + '">ESCALATED' +
            (n.escalationTier > 1 ? " T" + n.escalationTier : "") + '</span>'
          : "";
        var depBadge = n.dependencyDown
          ? ' <span class="badge badge-monitor-dep-down" title="Raised while this device was dependency-down — the message names the upstream device. No reminders or escalation until the upstream recovers.">Dep. Down</span>'
          : "";
        // The message is the row's name and opens its menu (_assetAlertMenuItems):
        // a GROUPED alert (business rule 75) names many problems in one
        // sentence, and its primary verb lists them (openAlertMembers, off this
        // row's own `members` snapshot — no fetch, so it needs nothing beyond
        // the tab's assets:read); Acknowledge / Clear follow by permission. A
        // row with no verb at all stays plain text, unmarked.
        var grouped = !!n.groupKey || n.dimensionCount != null;
        var hasMenu = grouped || shape.canSelect;
        var msgCell = hasMenu
          ? '<button type="button" class="row-menu-trigger asset-alert-menu" data-id="' + escapeHtml(n.id) + '" ' +
            'aria-haspopup="menu" aria-expanded="false" style="white-space:normal;overflow-wrap:anywhere;text-align:left">' +
            escapeHtml(n.message || "") + '</button>'
          : escapeHtml(n.message || "");
        // Frozen for planned work (business rule 16) — the same MAINT badge
        // the Active Alerts widget wears: still listed, paging nobody.
        var maintPill = n.maintenanceHold
          ? ' <span class="badge badge-maintenance" title="' + escapeHtml(n.maintenanceHold === "upstream"
              ? "Paused — an upstream device is in a maintenance window. No reminders or escalation until it ends."
              : "Paused — this device is in a maintenance window. No reminders or escalation until it ends.") + '">MAINT</span>'
          : "";
        var groupPill = grouped
          ? ' <span class="widget-pill widget-pill-watch" title="' +
            escapeHtml("Grouped alert" + (n.dimensionCount ? " — " + n.dimensionCount + " still affected" : "")) + '">GROUP</span>'
          : "";
        return '<tr' + (hasMenu ? ' data-row-menu-row' : '') + '>' + sel +
          '<td style="font-family:var(--font-mono);font-size:0.82rem">' + escapeHtml(ts) + '</td>' +
          '<td><span class="badge badge-level-' + escapeHtml(n.severity || "info") + '">' + escapeHtml((n.severity || "info").toUpperCase()) + '</span>' + escBadge + depBadge + maintPill + groupPill + '</td>' +
          '<td' + (alertTitle ? ' title="' + escapeHtml(alertTitle) + '"' : "") + '>' + msgCell + '</td>' +
          '<td>' + ackCell + '</td>' +
          '<td><div style="display:flex;gap:0.4rem;align-items:center;flex-wrap:wrap">' + parts.join("") + '</div></td></tr>';
      }).join("") : '<tr><td colspan="' + shape.colspan + '" class="empty-state">No active alerts</td></tr>';
      aTbody.querySelectorAll(".asset-alert-ack").forEach(function (btn) {
        btn.addEventListener("click", function () { _acknowledgeAssetAlert(btn, assetId); });
      });
      aTbody.querySelectorAll(".asset-alert-clear").forEach(function (btn) {
        btn.addEventListener("click", function () { _clearAssetAlert(btn, assetId); });
      });
      aTbody.querySelectorAll(".asset-alert-menu").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var id = btn.getAttribute("data-id");
          var row = active.find(function (x) { return String(x.id) === id; });
          if (!row) return;
          // The selection's verbs only on a RIGHT click (the replayed click
          // rowMenuGesture reports); a left click is about this row alone.
          var gesture = typeof rowMenuGesture === "function" ? rowMenuGesture() : null;
          var selected = gesture
            ? Array.prototype.map.call(aTbody.querySelectorAll(".asset-alert-sel:checked"), function (b) { return b.getAttribute("data-id"); })
            : [];
          showRowMenu(btn, _assetAlertMenuItems(row, shape, selected, assetId), { label: "Alert actions" });
        });
      });
    }
    var rTbody = document.getElementById("asset-notif-rules-tbody");
    if (!rTbody) return;
    // The sentence builder may still be loading its schema; the rules render
    // once it settles (it never rejects — it resolves null instead).
    sentencesReady.then(function (sent) {
      _renderAssetRuleRows(rTbody, rules, sent, assetId);
    });
  }).catch(function () {
    var shape = _assetAlertTableShape();
    var aTbody = document.getElementById("asset-notif-active-tbody");
    if (aTbody) aTbody.innerHTML = '<tr><td colspan="' + shape.colspan + '" class="empty-state">Failed to load</td></tr>';
    var rTbody = document.getElementById("asset-notif-rules-tbody");
    if (rTbody) rTbody.innerHTML = '<tr><td colspan="3" class="empty-state">Failed to load</td></tr>';
  });
}

/**
 * One active alert's row menu. Pure apart from the handlers it returns.
 *
 * `selected` is the ids of the selected rows, passed only on a right click:
 * when this row is one of SEVERAL selected, the menu is the selection's —
 * Acknowledge / Clear for all of them, in one request each (the Assets-list
 * pattern; the bulk bar that used to carry these is gone). Otherwise it is the
 * row's own: a grouped alert's "Show alerts in this group" first and primary
 * (what a click on the message does), then Acknowledge while unacknowledged
 * (alerts:write) and Clear (alerts:fullwrite). Neither of those is ever
 * primary — a left click must not change an alert's state unconfirmed.
 */
function _assetAlertMenuItems(n, shape, selected, assetId) {
  var id = String(n.id);
  var sel = (selected || []).map(String);
  if (sel.length > 1 && sel.indexOf(id) >= 0) {
    var bulk = [{ heading: sel.length + " selected" }];
    if (shape.canAck) bulk.push({ label: "Acknowledge", onSelect: function () { _bulkAcknowledgeAssetAlerts(sel, assetId); } });
    if (shape.canClear) bulk.push({ label: "Clear", danger: true, onSelect: function () { _bulkClearAssetAlerts(sel, assetId); } });
    return bulk;
  }
  var items = [];
  if (n.groupKey || n.dimensionCount != null) {
    items.push({
      label: "Show alerts in this group",
      primary: true,
      title: "List the components this alert is made of — which are still affected and which have recovered",
      onSelect: function () { openAlertMembers(n); },
    });
  }
  var verbs = [];
  if (!n.acknowledged && shape.canAck && n.canAcknowledge !== false) verbs.push({ label: "Acknowledge", onSelect: function () { _bulkAcknowledgeAssetAlerts([id], assetId); } });
  if (shape.canClear && n.canClear !== false) verbs.push({ label: "Clear", danger: true, onSelect: function () { _bulkClearAssetAlerts([id], assetId); } });
  if (items.length && verbs.length) items.push({ separator: true });
  return items.concat(verbs);
}

/** "1 alert" / "3 alerts" — used in every prompt, confirm and toast below. */
function _alertCountLabel(n) {
  return n + " alert" + (n === 1 ? "" : "s");
}

/**
 * Copy for the acknowledge modal, given how many alerts and whether the
 * automation demands a note. Pure — the wording is the whole UI here.
 *
 * The question is a PLACEHOLDER, never a value: it greys out, disappears on
 * the first keystroke, and an untouched box submits as no note at all. The
 * emailed ack page's textarea asks the same thing (public/js/alert-ack.js), so
 * the two surfaces prompt for one thing — keep them in step.
 */
function _ackPromptOpts(count, required) {
  return {
    title: count === 1 ? "Acknowledge alert" : "Acknowledge " + _alertCountLabel(count),
    label: required ? "Note (required)" : "Note (optional)",
    placeholder: "What is the problem and what is the fix?",
    help: required
      ? "This alert's automation requires a note."
      : "Anyone reading this alert later sees the note.",
    multiline: true,
    required: !!required,
    requiredMessage: "A note is required to acknowledge this — say what the problem is and what the fix was.",
    maxLength: 2000,
    okLabel: "Acknowledge",
  };
}
if (typeof window !== "undefined") window._ackPromptOpts = _ackPromptOpts;

/** The one definition of the acknowledge dialog, shared by the single-row and
 *  bulk paths — the `_promptQuarantineReason` pattern. Resolves to the note,
 *  "" when left blank on an optional one, or null if cancelled. */
function _promptAckNote(count, required) {
  return showPrompt("", _ackPromptOpts(count, required));
}

/**
 * Acknowledge one alert from the asset's Alerts tab.
 *
 * showPrompt, not window.prompt: the browser's box is unstyled, unreachable in
 * the installed PWA, suppressed outright by some browsers — and it cannot mark
 * a field required, which an automation with `requireAckNote` needs. It builds
 * its own overlay, so it stacks over the asset slide-over without disturbing
 * it. Cancelling (null, never "") cancels the whole thing.
 */
async function _acknowledgeAssetAlert(btn, assetId) {
  var note = await _promptAckNote(1, btn.dataset.noteRequired === "1");
  if (note === null) return; // cancelled
  btn.disabled = true;
  var old = btn.textContent;
  btn.textContent = "…";
  try {
    var res = await api.alerts.acknowledge([btn.dataset.id], note || undefined);
    // Report what the SERVER did, not what was asked for: the route skips rows
    // already acknowledged, and a success toast over a no-op is how "I clicked
    // it and nothing happened" starts.
    var n = res && typeof res.acknowledged === "number" ? res.acknowledged : 1;
    showToast(n ? "Alert acknowledged" : "Already acknowledged", n ? "success" : "error");
    _loadAssetNotificationsTab(assetId);
  } catch (err) {
    showToast(err.message || "Couldn't acknowledge the alert", "error");
    btn.disabled = false;
    btn.textContent = old;
  }
}

/**
 * Clear one alert from the asset's Alerts tab (alerts:fullwrite). Confirmed
 * first because clearing is the operator's "this outage is handled" statement:
 * it ends the alert, runs the automation's reset actions and stops escalation,
 * and an auto-reset rule whose condition is still true will simply raise a new
 * one — so a mis-click is noise, not a silent loss.
 */
async function _clearAssetAlert(btn, assetId) {
  var ok = await showConfirm("Clear this alert? It stops escalation and runs the automation's reset actions. A still-true condition can raise a new alert.");
  if (!ok) return;
  btn.disabled = true;
  var old = btn.textContent;
  btn.textContent = "…";
  try {
    var res = await api.alerts.clear([btn.dataset.id]);
    var n = res && typeof res.cleared === "number" ? res.cleared : 1;
    showToast(n ? "Alert cleared" : "That alert was already cleared", n ? "success" : "error");
    _loadAssetNotificationsTab(assetId);
  } catch (err) {
    showToast(err.message || "Couldn't clear the alert", "error");
    btn.disabled = false;
    btn.textContent = old;
  }
}

/**
 * Acknowledge every selected alert in ONE request (or one alert, from its row
 * menu; `btn` is optional and only shows progress). The note is prompted once
 * for the batch because the route takes one shared note by design — and
 * because nobody types a per-interface note for the twelve ports that went
 * down together.
 *
 * The note is required when ANY selected alert's automation requires one: the
 * server refuses such a batch whole (it has one note to apply to all of them),
 * so asking for it up front beats a 400 after the fact.
 */
async function _bulkAcknowledgeAssetAlerts(ids, assetId, btn) {
  if (!ids.length) return;
  var required = ids.some(function (id) {
    var box = document.querySelector('.asset-alert-sel[data-id="' + id + '"]');
    return !!(box && box.dataset.noteRequired === "1");
  });
  var note = await _promptAckNote(ids.length, required);
  if (note === null) return; // cancelled
  var old = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  try {
    var res = await api.alerts.acknowledge(ids, note || undefined);
    var n = res && typeof res.acknowledged === "number" ? res.acknowledged : ids.length;
    showToast(n ? "Acknowledged " + _alertCountLabel(n) : "Nothing to acknowledge — already acknowledged", n ? "success" : "error");
    _loadAssetNotificationsTab(assetId);
  } catch (err) {
    showToast(err.message || "Couldn't acknowledge the alerts", "error");
    if (btn) { btn.disabled = false; btn.textContent = old; }
  }
}

/**
 * Clear every selected alert in ONE request (alerts:fullwrite). The confirm
 * names the count, since the whole point of the selection is that the rows can
 * read identically — "clear this alert" over twenty of them says nothing about
 * how many are going.
 */
async function _bulkClearAssetAlerts(ids, assetId, btn) {
  if (!ids.length) return;
  var ok = await showConfirm("Clear " + _alertCountLabel(ids.length) + "? Clearing stops escalation and runs each automation's reset actions. A still-true condition can raise a new alert.");
  if (!ok) return;
  var old = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  try {
    var res = await api.alerts.clear(ids);
    var n = res && typeof res.cleared === "number" ? res.cleared : ids.length;
    showToast(n ? "Cleared " + _alertCountLabel(n) : "Nothing cleared — they were already cleared", n ? "success" : "error");
    _loadAssetNotificationsTab(assetId);
  } catch (err) {
    showToast(err.message || "Couldn't clear the alerts", "error");
    if (btn) { btn.disabled = false; btn.textContent = old; }
  }
}

/**
 * The Scope cell's text. A builder-authored scope is a condition TREE, which
 * the old types-and-tags join read as "—" — so the more-specific automation in
 * a pair looked like the unscoped one. Labels come from the automation schema
 * when _assetRuleSentences has cached it, raw field/operator names otherwise
 * (the Automations page's condTooltipText does the same).
 */
function _assetRuleScopeText(sc) {
  if (!sc || typeof sc !== "object" || sc.allAssets) return "All assets";
  if (sc.condition && (sc.condition.children || []).length) {
    var meta = (window._ruleSchema && window._ruleSchema.scopeCondition) || {};
    var fields = meta.fields || [];
    var opLabels = meta.operatorLabels || {};
    var render = function (node) {
      var parts = (node.children || []).map(function (c) {
        if (c.op !== undefined && Array.isArray(c.children)) return "(" + render(c) + ")";
        var fm = fields.find(function (f) { return f.field === c.field; });
        return (fm ? fm.label : c.field) + " " + (opLabels[c.operator] || c.operator) + " " + c.value;
      });
      if (node.op === "or") return parts.join(" OR ");
      if (node.op === "none") return "NOT(" + parts.join(" OR ") + ")";
      if (node.op === "notAll") return "NOT(" + parts.join(" AND ") + ")";
      return parts.join(" AND ");
    };
    return render(sc.condition);
  }
  var parts = [];
  if (sc.assetTypes && sc.assetTypes.length) parts.push("types: " + sc.assetTypes.join("/"));
  if (sc.tags && sc.tags.length) parts.push("tags: " + sc.tags.join("/"));
  if (sc.manufacturers && sc.manufacturers.length) parts.push("mfr: " + sc.manufacturers.join("/"));
  if (sc.models && sc.models.length) parts.push("model: " + sc.models.join("/"));
  if (sc.subnetCidrs && sc.subnetCidrs.length) parts.push("subnets: " + sc.subnetCidrs.join("/"));
  if (sc.assetIds && sc.assetIds.length) parts.push(sc.assetIds.length + " asset(s)");
  if (sc.integrationIds && sc.integrationIds.length) parts.push(sc.integrationIds.length + " integration(s)");
  // Nothing narrowed at all — `{}` means "any device" (scopeIsUnconstrained).
  return parts.length ? parts.join("; ") : "All assets";
}

function _renderAssetRuleRows(rTbody, rules, sent, assetId) {
  // Clicking an automation's name opens the same edit modal the Automations
  // page uses — offered only to operators who could actually save it (the
  // wizard is an editor, not a viewer).
  var canEdit = typeof openAutomationWizard === "function" && permAtLeast("automationManagement", "write");
  rTbody.innerHTML = rules.length ? rules.map(function (r, i) {
    var scope = _assetRuleScopeText(r.scope);
    // Trigger column: the plain-English summary from the top of the edit
    // modal, severity ladder included — a banded automation names every tier
    // it can raise, not just the first. Falls back to the raw trigger-type
    // badge when the sentence builder isn't available.
    var trig = sent
      ? sent.triggerSentence(r.trigger, { severity: r.severity, severityBands: r.severityBands })
      : '<span class="badge">' + escapeHtml((r.trigger && r.trigger.type) || "") + '</span>';
    // The standard row gestures (polaris-ui-canon → Row context menu): click
    // the name or double-click the row to edit, right-click for the menu.
    var name = canEdit
      ? '<button type="button" class="row-menu-trigger asset-notif-rule-edit" data-rule-idx="' + i + '" ' +
          'aria-haspopup="menu" aria-expanded="false" title="Actions for this automation">' + escapeHtml(r.name) + '</button>'
      : escapeHtml(r.name);
    return '<tr' + (canEdit ? ' data-row-menu-row' : '') + '><td>' + name + '</td>' +
      '<td style="font-size:0.85rem">' + trig + '</td>' +
      '<td style="font-size:0.85rem">' + escapeHtml(scope) + '</td></tr>';
  }).join("") : '<tr><td colspan="3" class="empty-state">No automations currently match this asset</td></tr>';
  if (!canEdit) return;
  function editRule(rule) {
    // Saving refreshes the Automations page list through this optional hook;
    // wrapping it is how this tab picks up the edit. The wrapper is one-shot
    // (it restores on the first fire) and unwraps any stale copy of itself
    // first — open-then-cancel leaves one installed, and chaining them would
    // reload the tab once per cancelled attempt. automations.html loads
    // assets.js too, so the page's own reloader must survive either way.
    var prevReload = window._reloadRules;
    while (prevReload && prevReload._assetAlertsPrev !== undefined) prevReload = prevReload._assetAlertsPrev;
    var hook = function () {
      window._reloadRules = prevReload;
      if (prevReload) prevReload();
      if (document.getElementById("asset-notif-rules-tbody")) _loadAssetNotificationsTab(assetId);
    };
    hook._assetAlertsPrev = prevReload || null;
    window._reloadRules = hook;
    openAutomationWizard(rule).catch(function (err) {
      window._reloadRules = prevReload;
      showToast((err && err.message) || "Failed to open the automation wizard", "error");
    });
  }
  rTbody.querySelectorAll(".asset-notif-rule-edit").forEach(function (b) {
    b.addEventListener("click", function () {
      var rule = rules[parseInt(b.getAttribute("data-rule-idx"), 10)];
      if (!rule) return;
      showRowMenu(b, [
        { label: "Edit", primary: true, onSelect: function () { editRule(rule); } },
      ], { label: "Actions for " + rule.name });
    });
  });
}

// The tab fills the slide-over: the panel body stops scrolling and the table
// scrolls inside it under a sticky header (styles.css, "Asset Events tab").
// The toolbar is a plain flex row, not a .filter-bar — that one is a sticky,
// opaque page-level strip and drew a box over the panel's glass. Order, left
// to right: Clear Filters (moved in by _wireAssetEventsTab), Refresh, N / page.
function _assetEventsTabHTML(assetId) {
  return '<div class="section-block asset-events-tab">' +
    '<div class="asset-events-toolbar" style="display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-bottom:0.5rem">' +
      '<button class="btn btn-glyph btn-glyph-refresh btn-secondary btn-sm" id="asset-view-events-refresh" title="Refresh">Refresh</button>' +
      '<select id="asset-view-events-pagesize" style="width:auto" aria-label="Rows per page">' +
        '<option value="15" selected>15 / page</option>' +
        '<option value="25">25 / page</option>' +
        '<option value="50">50 / page</option>' +
        '<option value="100">100 / page</option>' +
      '</select>' +
    '</div>' +
    '<div class="table-wrapper table-wrapper-panel-sticky" id="asset-view-events-wrapper">' +
      '<table id="asset-view-events-table">' +
        '<thead><tr>' +
          '<th style="width:160px" data-col-fit="content" data-col-id="timestamp" data-sf-key="timestamp" data-sf-type="date">Timestamp</th>' +
          '<th style="width:70px"  data-col-fit="content" data-col-id="level"     data-sf-key="level"     data-sf-type="string" data-sf-options="info|warning|error">Level</th>' +
          '<th style="width:140px" data-col-id="action"    data-sf-key="action"    data-sf-type="string">Action</th>' +
          '<th style="width:100px" data-col-id="resource"  data-sf-key="resourceType" data-sf-type="string">Resource</th>' +
          '<th                      data-col-id="message"  data-sf-key="message"   data-sf-type="string">Message</th>' +
          '<th style="width:100px" data-col-fit="content" data-col-id="user" data-sf-key="actor"     data-sf-type="string">User</th>' +
        '</tr></thead>' +
        '<tbody id="asset-view-events-tbody">' +
          '<tr><td colspan="6" class="empty-state">Loading…</td></tr>' +
        '</tbody>' +
      '</table>' +
    '</div>' +
    // renderPageControls draws into this (grid, 10px top margin — the gap
    // the old 0.75rem padding gave).
    '<div id="asset-view-events-pagination" style="display:flex;align-items:center;gap:12px;justify-content:center;flex:none"></div>' +
  '</div>';
}

function _renderAssetEventRow(ev, idx) {
  var ts = new Date(ev.timestamp);
  var timeStr = formatShortDateTime(ts);

  var levelClass = "badge-level-" + escapeHtml(ev.level || "info");
  var levelLabel = escapeHtml((ev.level || "info").toUpperCase());

  var resourceLabel = ev.resourceType || "-";
  var resourceName = ev.resourceName ? ' <span style="color:var(--color-text-tertiary);font-size:0.8rem">(' + escapeHtml(ev.resourceName) + ')</span>' : "";

  // An event with a field-by-field change list opens it from the Action text
  // (and a double click on the row) — the Events page's gesture, no column.
  var hasChanges = !!(ev.details && ev.details.changes);
  var actionCell = hasChanges
    ? '<button type="button" class="row-menu-trigger ev-detail-trigger" data-event-idx="' + idx + '" ' +
        'aria-haspopup="menu" aria-expanded="false" title="View what changed">' + escapeHtml(ev.action || "") + '</button>'
    : escapeHtml(ev.action || "");

  return '<tr' + (hasChanges ? ' data-row-menu-row' : '') + '>' +
    '<td style="font-family:var(--font-mono);font-size:0.82rem;white-space:nowrap">' + escapeHtml(timeStr) + '</td>' +
    '<td><span class="badge ' + levelClass + '">' + levelLabel + '</span></td>' +
    '<td style="font-family:var(--font-mono);font-size:0.82rem">' + actionCell + '</td>' +
    '<td>' + escapeHtml(resourceLabel) + resourceName + '</td>' +
    // The whole message on hover — a narrow Message column cuts it short.
    '<td' + (ev.message ? ' title="' + escapeHtml(ev.message) + '"' : '') + '>' + escapeHtml(ev.message || "") + '</td>' +
    '<td>' + escapeHtml(ev.actor || "-") + '</td>' +
    '</tr>';
}

// Translate the live TableSF filter + sort state into GET /events params,
// pinned to this asset by `assetId` — every event ABOUT the device, so its
// alerts' fire / clear (resourceType=notification) sit beside its own
// resourceType=asset rows. Mirrors events.js _buildEventsQuery (server-side
// mode). The Resource column filter is left unwired.
function _buildAssetEventsQuery() {
  var filters = _assetEventsSF ? _assetEventsSF._filters || {} : {};
  var params = {
    assetId: _assetEventsAssetId,
    limit: _assetEventsPageSize,
    offset: _assetEventsOffset,
  };
  if (Array.isArray(filters.level) && filters.level.length) params.level = filters.level.join(",");

  function pushText(field, raw) {
    if (raw == null) return;
    if (typeof raw === "string") {
      var v = raw.trim();
      if (v) params[field] = v;
    } else if (typeof raw === "object") {
      if (raw.op === "empty") {
        params[field + "Op"] = "empty";
      } else if (raw.op === "notempty") {
        params[field + "Op"] = "is_not_empty";
      } else if (raw.op === "not-contains") {
        var q = (raw.q || "").trim();
        if (q) { params[field] = q; params[field + "Op"] = "not_contains"; }
      }
    }
  }
  pushText("action", filters.action);
  pushText("actor", filters.actor);
  pushText("message", filters.message);

  if (filters.timestamp && filters.timestamp.type === "date") {
    if (filters.timestamp.from) params.since = filters.timestamp.from + "T00:00:00";
    if (filters.timestamp.to)   params.until = filters.timestamp.to   + "T23:59:59.999";
  }
  if (_assetEventsSF && _assetEventsSF._sortKey) {
    params.sortBy = _assetEventsSF._sortKey;
    params.sortDir = _assetEventsSF._sortDir === "asc" ? "asc" : "desc";
  }
  return params;
}

async function _loadAssetEventsTabFor() {
  var tbody = document.getElementById("asset-view-events-tbody");
  if (!tbody || !_assetEventsAssetId) return;
  try {
    var data = await api.events.list(_buildAssetEventsQuery());
    var events = (data && data.events) || [];
    _assetEventsTotal = (data && data.total) || 0;
    _assetEventsCurrentPage = events;
    tbody.innerHTML = events.length
      ? events.map(_renderAssetEventRow).join("")
      : '<tr><td colspan="6" class="empty-state">No events found</td></tr>';
    _renderAssetEventsPagination();
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Failed to load events</td></tr>';
  }
}

// The shared list pager (app.js renderPageControls, CQ-F019) — page
// navigation only; the tab's own Show N selector sits above the table.
function _renderAssetEventsPagination() {
  var pageSize = _assetEventsPageSize;
  var currentPage = Math.floor(_assetEventsOffset / pageSize) + 1;
  renderPageControls("asset-view-events-pagination", _assetEventsTotal, pageSize, currentPage, function (page) {
    _assetEventsOffset = (page - 1) * pageSize;
    _loadAssetEventsTabFor();
  }, null, { itemLabel: "events" });
}

function _saveAssetEventsPrefs() {
  if (typeof currentUsername === "undefined" || !currentUsername) return;
  try {
    // Layout persistence is handled by applyTableLayout under its own
    // polaris-table-layout-asset-events-<user> key; here we keep pageSize +
    // filter/sort state. Not per-asset — operators want one Events-tab view.
    localStorage.setItem("polaris-prefs-asset-events-" + currentUsername, JSON.stringify({
      pageSize: _assetEventsPageSize,
      filters: _assetEventsSF ? _assetEventsSF._filters : null,
      sort: _assetEventsSF ? { key: _assetEventsSF._sortKey, dir: _assetEventsSF._sortDir } : null,
    }));
  } catch (_) {}
}

function _restoreAssetEventsPrefs() {
  if (typeof currentUsername === "undefined" || !currentUsername) return;
  var raw;
  try { raw = localStorage.getItem("polaris-prefs-asset-events-" + currentUsername); } catch (_) { return; }
  if (!raw) return;
  try {
    var p = JSON.parse(raw);
    if (p.pageSize) {
      _assetEventsPageSize = p.pageSize;
      var ps = document.getElementById("asset-view-events-pagesize");
      if (ps) ps.value = String(p.pageSize);
    }
    if (_assetEventsSF) {
      if (p.filters && typeof p.filters === "object") _assetEventsSF._filters = p.filters;
      if (p.sort && typeof p.sort === "object") {
        if (p.sort.key) _assetEventsSF._sortKey = p.sort.key;
        if (p.sort.dir === "asc" || p.sort.dir === "desc") _assetEventsSF._sortDir = p.sort.dir;
      }
      _assetEventsSF.restoreFilterUI();
      _assetEventsSF._updateIcons();
    }
  } catch (_) {}
}

function _wireAssetEventsTab(assetId) {
  // Fresh per modal open — the table DOM was just rebuilt by openViewModal.
  _assetEventsAssetId = assetId;
  _assetEventsOffset = 0;
  _assetEventsTotal = 0;
  _assetEventsCurrentPage = [];
  _assetEventsLoaded = false;

  var table = document.getElementById("asset-view-events-table");
  if (!table) return;
  // Server-side mode: never call sf.apply(); onChange resets offset + refetches.
  // TableSF BEFORE the column layout: TableSF._setup rebuilds each header th
  // via innerHTML, which wiped the resize handles applyTableLayout had just
  // appended, so no column on this tab could be dragged (events.js's order).
  _assetEventsSF = new TableSF("asset-view-events-tbody", function () {
    _assetEventsOffset = 0;
    _loadAssetEventsTabFor();
    _saveAssetEventsPrefs();
  });
  // Timestamp, Level and User are content-fit (data-col-fit): sized to their
  // widest rendered cell, no handle. Message is the auto-fill column.
  _assetEventsLayout = applyTableLayout(table, "asset-events", {
    onChange: _saveAssetEventsPrefs,
    onScreenshot: function (t) { _screenshotTableEl(t, "Events"); },
  });
  var evRefresh = document.getElementById("asset-view-events-refresh");
  // addClearButton puts it after Refresh; this toolbar wants it before.
  var evClear = _assetEventsSF.addClearButton(evRefresh && evRefresh.parentElement);
  if (evClear && evRefresh) evRefresh.insertAdjacentElement("beforebegin", evClear);
  _restoreAssetEventsPrefs();

  var ps = document.getElementById("asset-view-events-pagesize");
  if (ps) ps.addEventListener("change", function () {
    _assetEventsPageSize = parseInt(this.value, 10) || 15;
    _assetEventsOffset = 0;
    _loadAssetEventsTabFor();
    _saveAssetEventsPrefs();
  });
  var refresh = document.getElementById("asset-view-events-refresh");
  if (refresh) refresh.addEventListener("click", function () { _loadAssetEventsTabFor(); });

  // Lazy first fetch on first Events-tab click (avoids an extra /events query
  // on every modal open). Subsequent loads come from TableSF/pagination.
  var btn = document.querySelector('#asset-view-tabs .page-tab[data-tab="events"]');
  if (btn) btn.addEventListener("click", function () {
    if (_assetEventsLoaded) return;
    _assetEventsLoaded = true;
    _loadAssetEventsTabFor();
  });

  var tbody = document.getElementById("asset-view-events-tbody");
  if (tbody) tbody.addEventListener("click", function (e) {
    var detail = e.target.closest(".ev-detail-trigger");
    if (!detail) return;
    var ev = _assetEventsCurrentPage[parseInt(detail.getAttribute("data-event-idx"), 10)];
    if (!ev) return;
    showRowMenu(detail, [
      { label: "View Changes", primary: true, onSelect: function () { _showAssetEventDetail(ev); } },
    ], { label: "Actions for " + (ev.action || "event") });
  });
}

// ── Events-tab export (footer Export dropdown) ──────────────────────────────
// The header's Screenshot + PDF buttons become an Export dropdown while the
// Events tab is active (_syncAssetFooterButtons). Mirrors the Events page export
// (events.js handleEventExport / generateEventCsv / generateEventPdf) but is
// scoped to this asset via _buildAssetEventsQuery — "all" honors the
// operator's active column filters + sort, pinned to assetId.
// The generators live here (with an _asset prefix) because events.js is not
// loaded on assets.html / map.html.

var _assetExportCloserWired = false; // document-level menu closer, once per page
var _assetRemoteMenuCloserWired = false; // document-level closer for the SSH + RDP options menus

// Hostname → filename-safe fragment for the export filenames.
function _assetExportSubject(asset) {
  var s = (asset && (asset.hostname || asset.id)) || "asset";
  return String(s).replace(/[^A-Za-z0-9._-]+/g, "-");
}

function _syncAssetFooterButtons() {
  var active = document.querySelector("#asset-view-tabs .page-tab.active");
  var isEvents = !!(active && active.getAttribute("data-tab") === "events");
  var shot = document.getElementById("btn-asset-screenshot");
  var pdf = document.getElementById("btn-asset-pdf");
  var wrap = document.getElementById("asset-export-wrap");
  if (shot) shot.style.display = isEvents ? "none" : "";
  if (pdf) pdf.style.display = isEvents ? "none" : "";
  if (wrap) wrap.style.display = isEvents ? "" : "none";
}

async function _handleAssetEventExport(mode, fmt, asset) {
  var events, label, ok;
  if (mode === "page") {
    events = _assetEventsCurrentPage;
    if (!events || events.length === 0) { showToast("No events to export", "error"); return; }
    label = "page " + (Math.floor(_assetEventsOffset / _assetEventsPageSize) + 1);
  } else if (mode === "all") {
    if (_assetEventsTotal > 100) {
      ok = await showConfirm("This will export " + _assetEventsTotal + " events. Continue?");
      if (!ok) return;
    }
  }

  await trackedPdfExport("Exporting asset events " + fmt.toUpperCase(), async function (signal) {
    if (mode === "all") {
      // GET /events caps limit at 200 (Zod schema rejects, not clamps,
      // anything larger) — page through in 200-row chunks up to a 10k
      // export ceiling.
      events = [];
      var offset = 0;
      var total = Infinity;
      while (offset < total && events.length < 10000) {
        var q = _buildAssetEventsQuery();
        q.limit = 200;
        q.offset = offset;
        var data = await request("GET", "/events" + toQuery(q), undefined, signal);
        if (signal.aborted) return;
        var chunk = (data && data.events) || [];
        events = events.concat(chunk);
        total = (data && data.total) || events.length;
        if (chunk.length === 0) break;
        offset += chunk.length;
      }
      label = "all " + events.length + " events";
    }
    if (signal.aborted) return;
    if (!events || events.length === 0) { showToast("No events to export", "error"); return; }
    if (fmt === "csv") _generateAssetEventCsv(events, asset);
    else _generateAssetEventPdf(events, label, asset);
  });
}

function _generateAssetEventCsv(events, asset) {
  var headers = ["Timestamp", "Level", "Action", "Resource Type", "Resource Name", "Message", "User"];
  var rows = events.map(function (ev) {
    var ts = new Date(ev.timestamp);
    var timeStr = formatDateTime(ts);
    return [
      timeStr, (ev.level || "info").toUpperCase(), ev.action || "",
      ev.resourceType || "", ev.resourceName || "", ev.message || "", ev.actor || "",
    ];
  });
  var subject = _assetExportSubject(asset);
  var filename = "polaris-asset-events-" + subject + "-" + new Date().toISOString().slice(0, 10) + ".csv";
  downloadCsv(headers, rows, filename);
  showToast("Exported " + events.length + " events to " + filename);
}

function _generateAssetEventPdf(events, label, asset) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error("PDF library not loaded. Check your internet connection and reload the page.");
  }
  var jsPDF = window.jspdf.jsPDF;
  var doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });

  var now = new Date();
  var timestamp = now.toLocaleDateString(undefined, timeZoneOpts()) + " " + now.toLocaleTimeString(undefined, timeZoneOpts());
  var subject = _assetExportSubject(asset);

  doc.setFontSize(16);
  doc.setTextColor(40, 40, 40);
  doc.text((_branding ? _branding.appName : "Polaris") + " — Event Log — " + subject, 40, 36);
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

  var filename = "polaris-asset-events-" + subject + "-" + now.toISOString().slice(0, 10) + ".pdf";
  doc.save(filename);
  showToast("Exported " + events.length + " events to " + filename);
}

function _formatEventFieldName(field) {
  return field.replace(/([A-Z])/g, " $1").replace(/^./, function (c) { return c.toUpperCase(); });
}

function _formatEventDetailValue(val) {
  if (Array.isArray(val)) return val.join(", ") || "none";
  if (val instanceof Object) return JSON.stringify(val);
  return String(val);
}

function _showAssetEventDetail(ev) {
  var changes = ev.details && ev.details.changes ? ev.details.changes : {};
  var keys = Object.keys(changes);
  if (!keys.length) return;

  var rows = keys.map(function (field) {
    var c = changes[field];
    var from = c.from === null || c.from === "" ? '<span style="color:var(--color-text-tertiary);font-style:italic">empty</span>' : escapeHtml(_formatEventDetailValue(c.from));
    var to = c.to === null || c.to === "" ? '<span style="color:var(--color-text-tertiary);font-style:italic">empty</span>' : escapeHtml(_formatEventDetailValue(c.to));
    return '<tr>' +
      '<td style="font-weight:500;white-space:nowrap">' + escapeHtml(_formatEventFieldName(field)) + '</td>' +
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
