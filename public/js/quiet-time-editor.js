/**
 * public/js/quiet-time-editor.js — `window.PolarisQuietTimeEditor`
 *
 * The ONE browser-side editor of a quiet-time POLICY (business rule 92): the
 * shape `NotificationRule.quietTime` and a global `QuietTimeSchedule.quiet`
 * both carry, validated server-side by `utils/quietTime.ts`
 * (`quietTimeConfigSchema`). Two surfaces edit it — the automation wizard's
 * Quiet time step and the global quiet-time wizard's Schedule step — and a
 * second copy of "when, what goes quiet, which severities, how the summary
 * goes out" is how the two would drift into saving different things.
 *
 * What it renders, top to bottom:
 *   WHEN         one recurring window through the shared `PolarisRecurrence`
 *                schedule editor (days of the week / monthly / yearly, hours,
 *                an optional date range). Any further stored windows a one-shot
 *                set through the API, say — are listed read-only with Remove
 *                and re-sent verbatim; this editor never rewrites what it
 *                cannot express.
 *   WHAT GOES QUIET  the per-severity tree (`severityTreeHtml`): each severity,
 *                and under it Alerts and Escalation alerts, each with its own
 *                Reminders — ticked = held. Ticking a severity ticks all four;
 *                unticking its last kind unticks the severity. Hidden when the
 *                host asks the question itself (the global wizard's Alerts
 *                step renders the same tree through the exported helpers).
 *   RECIPIENT EXCEPTIONS  a button opening a stacked modal of addresses that
 *                do not follow the policy (business rule 120): each carries its
 *                own per-severity tree under the same windows; all unticked =
 *                the address hears everything live. Shown on both hosts, the
 *                global wizard included (it hides only the policy's own tree).
 *   SUMMARY      when the summary email goes out (at the end of each period,
 *                or at a time of day), which email channel carries it, and the
 *                recurrence threshold. Shown only while some severity holds
 *                its first alert — a reminders-and-escalations-only quiet
 *                time has nothing to summarise.
 *
 * Times are the SERVER's wall clock; the zone label the host passes in is
 * printed beside the hours for the same reason the recurrence editor prints
 * it. The summary time is checked here against the window's hours so the
 * operator hears about a clash before the save does.
 *
 * Every id is caller-prefixed so two editors can sit on one page. Depends on
 * `escapeHtml` from app.js and `window.PolarisRecurrence`.
 */

/* global escapeHtml */

(function () {
  "use strict";

  var esc = function (s) {
    return typeof escapeHtml === "function" ? escapeHtml(String(s == null ? "" : s)) : String(s == null ? "" : s);
  };
  var R = function () { return window.PolarisRecurrence; };

  var SEVERITY_LABELS = { notice: "Notice", informational: "Informational", warning: "Warning", serious: "Serious", critical: "Critical" };
  var ALL_SEVERITIES = ["notice", "informational", "warning", "serious", "critical"];

  // The four kinds of people-facing send a quiet time can hold, per severity
  // (`held` in utils/quietTime.ts): the first alert, its reminders, the
  // escalation tiers' first runs, and the tiers' own repeats.
  var KIND_KEYS = ["alerts", "alertReminders", "escalations", "escalationReminders"];
  var KIND_LABELS = { alerts: "Alerts", alertReminders: "Reminders", escalations: "Escalation alerts", escalationReminders: "Reminders" };
  var ALL_KINDS = { alerts: true, alertReminders: true, escalations: true, escalationReminders: true };

  function anyKind(k) { return !!k && KIND_KEYS.some(function (x) { return !!k[x]; }); }
  function allKinds(k) { return !!k && KIND_KEYS.every(function (x) { return !!k[x]; }); }

  /**
   * The per-severity hold map a stored policy means, over `sevs`: its `held`
   * verbatim, else derived from the legacy `severities` + `holds` pair (every
   * kind, or every kind but the first alert). A null policy holds everything.
   */
  function heldOf(cfg, sevs) {
    var out = {};
    (sevs || ALL_SEVERITIES).forEach(function (sv) {
      var k = null;
      if (cfg && cfg.held) {
        if (cfg.held[sv] && anyKind(cfg.held[sv])) k = cfg.held[sv];
      } else if (!cfg || !Array.isArray(cfg.severities) || !cfg.severities.length || cfg.severities.indexOf(sv) >= 0) {
        k = Object.assign({}, ALL_KINDS, { alerts: !cfg || cfg.holds !== "followUps" });
      }
      if (k) out[sv] = Object.assign({}, k);
    });
    return out;
  }

  /** Does any severity hold its first alert — i.e. is a summary email owed? */
  function anyAlertsHeld(held) {
    return !!held && Object.keys(held).some(function (sv) { return held[sv] && held[sv].alerts; });
  }

  /** A policy's summary-owing answer, legacy pair included. */
  function policySummarises(cfg) {
    if (!cfg) return true;
    if (cfg.held) return anyAlertsHeld(cfg.held);
    return cfg.holds !== "followUps";
  }

  function kindsText(k) {
    if (allKinds(k)) return "everything";
    if (!k.alerts && k.alertReminders && k.escalations && k.escalationReminders) return "reminders and escalations only";
    var parts = [];
    if (k.alerts) parts.push("alerts");
    if (k.alertReminders) parts.push("alert reminders");
    if (k.escalations) parts.push("escalation alerts");
    if (k.escalationReminders) parts.push("escalation reminders");
    return parts.join(", ");
  }

  /** "everything for warning, serious" / "warning, serious: everything · critical: reminders and escalations only". */
  function describeHeld(cfg) {
    var held = cfg && cfg.held;
    if (!held) {
      var sevs = cfg && Array.isArray(cfg.severities) && cfg.severities.length ? cfg.severities.join(", ") : "every severity";
      return (cfg && cfg.holds === "followUps" ? "reminders and escalations only" : "everything") + " for " + sevs;
    }
    var groups = {}, order = [];
    Object.keys(held).forEach(function (sv) {
      if (!anyKind(held[sv])) return;
      var sig = kindsText(held[sv]);
      if (!groups[sig]) { groups[sig] = []; order.push(sig); }
      groups[sig].push(sv);
    });
    if (!order.length) return "nothing";
    return order.map(function (sig) { return groups[sig].join(", ") + ": " + sig; }).join(" · ");
  }

  /**
   * The per-severity tree: a severity, and under it Alerts and Escalation
   * alerts, each with its own Reminders. Ticked = held during the quiet
   * period (and, for Alerts, reported in the summary email); unticked = that
   * send goes out live. Ticking a severity ticks all four; unticking its last
   * kind unticks the severity.
   */
  function severityTreeHtml(prefix, held, sevs, scope, bare) {
    sevs = sevs || ALL_SEVERITIES;
    // `scope` (sev → kind → bool) hides the sends the host can never make — an
    // automation with no reminders has no Reminders box. A hidden box still
    // carries its value, so what was stored round-trips untouched.
    if (scope) sevs = sevs.filter(function (sv) { return !!scope[sv]; });
    var kind = function (sv, key, indent) {
      var on = !!(held[sv] && held[sv][key]);
      var shown = !scope || !!scope[sv][key];
      return '<label class="qte-kind-wrap" style="display:' + (shown ? "inline-flex" : "none") + ';align-items:center;gap:5px;margin:0' + (indent ? ";margin-left:1.4rem" : "") + ';font-weight:400;cursor:pointer;font-size:0.85rem">' +
        '<input type="checkbox" class="qte-kind' + (shown ? "" : " qte-kind-hidden") + '" data-kind="' + key + '"' + (on ? " checked" : "") + ' style="width:auto"> ' + esc(KIND_LABELS[key]) + '</label>';
    };
    return '<div class="qte-sevtree" data-qte-prefix="' + esc(prefix || "qte") + '" style="display:grid;gap:6px">' +
      sevs.map(function (sv) {
        var on = !!held[sv];
        return '<div class="qte-sevrow" data-sev="' + esc(sv) + '" style="border:1px solid var(--color-border);border-radius:6px;padding:6px 10px">' +
          '<label style="display:inline-flex;align-items:center;gap:6px;margin:0;font-weight:600;cursor:pointer">' +
            '<input type="checkbox" class="qte-sev" value="' + esc(sv) + '"' + (on ? " checked" : "") + ' style="width:auto"> ' +
            '<span class="sev-select sev-' + esc(sv) + '" style="padding:1px 8px;border-radius:999px;font-size:0.78rem">' + esc(SEVERITY_LABELS[sv] || sv) + '</span>' +
          '</label>' +
          '<div class="qte-sev-kinds" style="display:grid;grid-template-columns:repeat(2,minmax(0,max-content));gap:3px 2.5rem;margin:5px 0 0 1.6rem"' + (on ? "" : " hidden") + '>' +
            kind(sv, "alerts", false) + kind(sv, "escalations", false) +
            kind(sv, "alertReminders", true) + kind(sv, "escalationReminders", true) +
          '</div>' +
        '</div>';
      }).join("") +
    '</div>' +
    (bare ? "" : '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:6px 0 0">Ticked = held during the quiet period and, for Alerts, reported in the summary email. Untick a box to let that send go out live; untick a severity to let it through entirely — critical usually should. Scripts, API calls and the audit event always run.</p>');
  }

  /** Delegated handlers for the tree; `onChange` fires after every edit. */
  function wireSeverityTree(root, onChange) {
    if (!root) return;
    root.addEventListener("change", function (ev) {
      var t = ev.target;
      var row = t && t.closest ? t.closest(".qte-sevrow") : null;
      if (!row) return;
      var kinds = row.querySelector(".qte-sev-kinds");
      var sev = row.querySelector(".qte-sev");
      if (t.classList.contains("qte-sev")) {
        if (t.checked) row.querySelectorAll(".qte-kind").forEach(function (k) { k.checked = true; });
        if (kinds) kinds.hidden = !t.checked;
      } else if (t.classList.contains("qte-kind")) {
        // Only the boxes on screen count: unticking the last VISIBLE one lets
        // the severity through, whatever a hidden one says.
        var any = Array.prototype.some.call(row.querySelectorAll(".qte-kind:not(.qte-kind-hidden)"), function (k) { return k.checked; });
        if (!any && sev) { sev.checked = false; if (kinds) kinds.hidden = true; }
      }
      if (typeof onChange === "function") onChange();
    });
  }

  /** The tree as drawn: sev → kinds for every ticked severity with a kind. */
  function readTree(root) {
    var held = {};
    if (!root) return held;
    root.querySelectorAll(".qte-sevrow").forEach(function (row) {
      var sev = row.querySelector(".qte-sev");
      if (!sev || !sev.checked) return;
      var k = {}, visible = false;
      KIND_KEYS.forEach(function (key) {
        var box = row.querySelector('.qte-kind[data-kind="' + key + '"]');
        k[key] = !!(box && box.checked);
        if (k[key] && !box.classList.contains("qte-kind-hidden")) visible = true;
      });
      if (visible) held[row.getAttribute("data-sev")] = k;
    });
    return held;
  }

  /**
   * The tree → `{ held, severities }` or `{ error }`. Every severity ticked
   * with every kind collapses to `held: null, severities: null` — the server's
   * "everything" — so an untouched default re-saves as the compact form.
   */
  function collectSeverityTree(root) {
    var held = readTree(root);
    var sevs = Object.keys(held);
    if (!sevs.length) return { error: "Pick at least one severity to hold, or turn quiet time off." };
    var rows = root.querySelectorAll(".qte-sevrow").length;
    if (sevs.length === rows && sevs.every(function (sv) { return allKinds(held[sv]); })) return { held: null, severities: null };
    return { held: held, severities: sevs };
  }

  // One-click starting points for the rules editor. Each is the whole rule
  // list; "Outside business hours" is the one that INVERTS — its rules say
  // when people are at work and everything else goes quiet. Nights and
  // weekends puts SUNDAY on the night rule too: Sunday all day ends at
  // midnight, and only a Sunday 22:00–06:00 carries the quiet through to
  // 06:00 Monday (the recurrence editor keeps that tail).
  var NIGHT = [{ startTime: "22:00", endTime: "06:00" }];
  var QUIET_PRESETS = [
    { key: "nights", label: "Nights and weekends", rules: [{ days: [0, 1, 2, 3, 4, 5], ranges: NIGHT }, { days: [0, 6], ranges: [] }] },
    { key: "everynight", label: "Every night", rules: [{ days: [0, 1, 2, 3, 4, 5, 6], ranges: NIGHT }] },
    { key: "weekends", label: "Weekends only", rules: [{ days: [0, 6], ranges: [] }] },
    { key: "business", label: "Outside business hours", invert: true, rules: [{ days: [1, 2, 3, 4, 5], ranges: [{ startTime: "08:00", endTime: "18:00" }] }] },
  ];

  function zoneLabel(meta) {
    var clock = meta && meta.serverClock;
    if (!clock) return "";
    return clock.timeZone || ("UTC" + (clock.offsetMinutes >= 0 ? "+" : "-") + Math.floor(Math.abs(clock.offsetMinutes || 0) / 60));
  }

  /** The window this editor owns — the first recurring one — and the rest. */
  function splitWindows(cfg) {
    var wins = (cfg && cfg.windows) || [];
    var editable = null;
    var extras = [];
    wins.forEach(function (w) {
      if (!editable && w && w.kind === "recurring") editable = w;
      else extras.push(w);
    });
    return { editable: editable, extras: extras };
  }

  function extraRowHtml(w) {
    return '<div class="qte-extra" style="display:flex;align-items:center;gap:8px;border:1px solid var(--color-border);' +
        'border-radius:6px;padding:5px 8px;margin-top:6px">' +
      '<span style="font-size:0.85rem">' + esc(R().summary(w)) + '</span>' +
      '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">— set through the API; edit it there</span>' +
      '<button type="button" class="qte-extra-remove btn-icon" title="Remove this quiet period" aria-label="Remove this quiet period" ' +
        'style="margin-left:auto;border:1px solid var(--color-border);border-radius:4px;background:transparent;' +
        'color:var(--color-text-secondary);cursor:pointer;width:26px;height:26px">×</button>' +
    '</div>';
  }

  function emailChannels(meta) {
    return ((meta && meta.channels) || []).filter(function (c) {
      return c && c.enabled !== false && (c.type === "smtp" || c.type === "oauth_m365");
    });
  }

  // ─── Recipient exceptions (business rule 120) ──────────────────────────────

  function recipientsButtonText(list) {
    var n = (list || []).length;
    return "Recipient exceptions" + (n ? " (" + n + ")" : "") + "…";
  }

  /** What one exception means: "hears everything live" / "holds critical: everything". */
  function describeRecipient(r) {
    var d = describeHeld({ held: (r && r.held) || {} });
    return d === "nothing" ? "hears everything live" : "holds " + d;
  }

  function describeRecipients(list) {
    list = list || [];
    if (!list.length) return "None — everyone follows this quiet time.";
    return list.map(function (r) { return r.address + " (" + describeRecipient(r) + ")"; }).join(" · ");
  }

  var EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
  var MAX_RECIPIENTS = 50;

  function recipientRowHtml(prefix, r, sevs) {
    return '<div class="qte-rx-row" style="border:1px solid var(--color-border);border-radius:6px;padding:8px 10px;margin-bottom:8px">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
        '<input type="email" class="qte-rx-address" placeholder="name@example.com" maxlength="320" value="' + esc((r && r.address) || "") + '" style="flex:1 1 auto" aria-label="Email address">' +
        '<button type="button" class="qte-rx-remove btn-icon" title="Remove this exception" aria-label="Remove this exception" ' +
          'style="border:1px solid var(--color-border);border-radius:4px;background:transparent;color:var(--color-text-secondary);cursor:pointer;width:26px;height:26px">×</button>' +
      '</div>' +
      '<div style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0 0 4px">Held for this address (nothing ticked = it hears every alert live):</div>' +
      severityTreeHtml(prefix, (r && r.held) || {}, sevs, null, true) +
    '</div>';
  }

  /**
   * The stacked modal (canonical: `buildOverlay` in app.js, z 1300 over the
   * wizard) that edits `host._quietRecipients`. Save validates every row and
   * writes the list back; Cancel leaves it untouched.
   */
  function openRecipientsModal(host) {
    if (typeof buildOverlay !== "function") return null;
    var section = host.querySelector(".qte-recipients");
    // Both values are read back out of the DOM, so they are canonicalized
    // rather than trusted: the severities are re-picked from the constant list
    // and the prefix must be a bare id token. CodeQL does not follow esc(), and
    // reads the attribute round trip as DOM text reinterpreted as HTML.
    var parsed = null;
    try { parsed = JSON.parse(section.getAttribute("data-qte-sevs")); } catch (_) { /* default */ }
    var sevs = Array.isArray(parsed)
      ? ALL_SEVERITIES.filter(function (sv) { return parsed.indexOf(sv) !== -1; })
      : ALL_SEVERITIES;
    var qte = host.classList && host.classList.contains("qte") ? host : host.querySelector(".qte");
    var rawPrefix = (qte && qte.getAttribute("data-qte-prefix")) || "";
    var prefix = (/^[A-Za-z0-9_-]+$/.test(rawPrefix) ? rawPrefix : "qte") + "-rx";
    var body =
      '<p style="font-size:0.85rem;color:var(--color-text-tertiary);margin:0 0 0.75rem">These addresses do not follow the quiet time’s own choices. Tick what stays held for each one; an address with nothing ticked hears every alert, reminder and escalation live. Everyone else follows the quiet time. A reminder held for someone is sent to them when the quiet period ends.</p>' +
      '<div class="qte-rx-list"></div>' +
      '<button type="button" class="btn btn-secondary btn-sm qte-rx-add">+ Add Recipient</button>' +
      '<p class="qte-rx-problem" role="alert" style="font-size:0.8rem;color:var(--color-warning);margin:8px 0 0"></p>';
    var footer =
      '<button type="button" class="btn btn-secondary qte-rx-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-primary qte-rx-save">Save</button>';
    var layer = buildOverlay(1300, "Recipient exceptions", body, footer, null, false);
    var overlay = layer.overlay;
    var listEl = overlay.querySelector(".qte-rx-list");
    var problem = overlay.querySelector(".qte-rx-problem");
    var close = layer.close;
    var addRow = function (r) {
      var wrap = document.createElement("div");
      wrap.innerHTML = recipientRowHtml(prefix, r, sevs);
      var row = wrap.firstElementChild;
      listEl.appendChild(row);
      wireSeverityTree(row.querySelector(".qte-sevtree"), null);
      return row;
    };
    (host._quietRecipients || []).forEach(addRow);
    overlay.querySelector(".qte-rx-add").addEventListener("click", function () {
      if (listEl.querySelectorAll(".qte-rx-row").length >= MAX_RECIPIENTS) {
        problem.textContent = "At most " + MAX_RECIPIENTS + " recipient exceptions.";
        return;
      }
      var input = addRow(null).querySelector(".qte-rx-address");
      if (input) input.focus();
    });
    listEl.addEventListener("click", function (ev) {
      var btn = ev.target.closest && ev.target.closest(".qte-rx-remove");
      if (!btn) return;
      var row = btn.closest(".qte-rx-row");
      if (row) row.remove();
    });
    overlay.querySelector(".qte-rx-cancel").addEventListener("click", close);
    overlay.querySelector(".qte-rx-save").addEventListener("click", function () {
      var got = readRecipientRows(listEl);
      if (got.error) { problem.textContent = got.error; return; }
      host._quietRecipients = got.recipients;
      refreshRecipients(host);
      close();
      if (typeof host._qteFire === "function") host._qteFire();
    });
    return overlay;
  }

  /** The modal's rows → `{ recipients }` or `{ error }`. A row left blank is skipped. */
  function readRecipientRows(listEl) {
    var out = [], seen = {};
    var rows = listEl.querySelectorAll(".qte-rx-row");
    for (var i = 0; i < rows.length; i++) {
      var input = rows[i].querySelector(".qte-rx-address");
      var address = String((input && input.value) || "").trim().toLowerCase();
      if (!address) continue;
      if (!EMAIL_RE.test(address)) return { error: "“" + address + "” is not an email address." };
      if (seen[address]) return { error: address + " is listed twice." };
      seen[address] = true;
      out.push({ address: address, held: readTree(rows[i].querySelector(".qte-sevtree")) });
    }
    return { recipients: out };
  }

  function refreshRecipients(host) {
    var btn = host.querySelector(".qte-recipients-btn");
    var sum = host.querySelector(".qte-recipients-summary");
    if (btn) btn.textContent = recipientsButtonText(host._quietRecipients);
    if (sum) sum.textContent = describeRecipients(host._quietRecipients);
  }

  /**
   * @param prefix  id prefix ("awq", "qtw")
   * @param cfg     the stored policy, or null for a new one
   * @param meta    { severities: [...], channels: [...], serverClock, showSeverities?: boolean,
   *                  scope?: { sev: { alerts, alertReminders, escalations, escalationReminders } },
   *                  defaultStart?, defaultEnd? }
   *                `scope` limits the tree to the severities the host can fire
   *                at and the sends it actually makes there (an automation's
   *                own Quiet time step); absent = every severity, every send.
   */
  function html(prefix, cfg, meta) {
    meta = meta || {};
    var p = esc(prefix || "qte");
    var split = splitWindows(cfg);
    var sevs = (meta.severities || ALL_SEVERITIES);
    var channels = emailChannels(meta);
    var summaryAt = (cfg && cfg.summaryAt) || "";
    var threshold = cfg && cfg.recurrenceThreshold != null ? cfg.recurrenceThreshold : "";
    // The host that asks the severity question itself (the global wizard)
    // hands its current map in as `meta.held`, so the summary section can
    // still hide when no first alert is held.
    var held = meta.showSeverities === false && meta.held ? meta.held : heldOf(cfg, sevs);
    var summarises = meta.showSeverities === false && !meta.held ? policySummarises(cfg) : anyAlertsHeld(held);

    var sevHtml = meta.showSeverities === false ? "" :
      '<div class="form-group" style="margin-top:0.9rem">' +
        '<label style="font-weight:600">What goes quiet</label>' +
        '<p style="font-size:0.8rem;color:var(--color-text-tertiary);margin:0 0 0.4rem">Per severity: the first alert, the escalation tiers, and each one’s reminders. The alert is still raised and shows on the Active Alerts page; what changes is who hears about it, and when.</p>' +
        severityTreeHtml(p, held, sevs, meta.scope || null) +
      '</div>';

    return '<div class="qte" data-qte-prefix="' + p + '">' +
      '<div class="form-group">' +
        '<label style="font-weight:600">When</label>' +
        '<div class="qte-window">' +
          R().scheduleEditorHtml(p + "-win", {
            shape: split.editable,
            zone: zoneLabel(meta),
            defaultStart: meta.defaultStart || "22:00",
            defaultEnd: meta.defaultEnd || "06:00",
            presets: QUIET_PRESETS,
            invertLabel: "Quiet outside these hours",
            invertHelp: "— the periods below are when people are at work; everything else goes quiet",
          }) +
        '</div>' +
        '<div class="qte-extras">' + split.extras.map(extraRowHtml).join("") + '</div>' +
      '</div>' +

      sevHtml +

      // Recipient exceptions (business rule 120). The severities the modal's
      // trees offer ride on the section, since wire() is not handed `meta`.
      '<div class="form-group qte-recipients" style="margin-top:0.9rem" data-qte-sevs="' +
          esc(JSON.stringify(meta.scope ? sevs.filter(function (sv) { return !!meta.scope[sv]; }) : sevs)) + '">' +
        '<label style="font-weight:600">Recipient exceptions</label>' +
        '<p style="font-size:0.8rem;color:var(--color-text-tertiary);margin:0 0 0.4rem">Email addresses that do not follow this quiet time — an on-call phone, a NOC mailbox. Each one gets its own choice of what is held for it, under the same hours. A push recipient is matched by its account’s email.</p>' +
        '<div style="display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap">' +
          '<button type="button" class="btn btn-secondary btn-sm qte-recipients-btn">' + esc(recipientsButtonText(cfg && cfg.recipients)) + '</button>' +
          '<span class="qte-recipients-summary" style="font-size:0.8rem;color:var(--color-text-secondary)">' + esc(describeRecipients(cfg && cfg.recipients)) + '</span>' +
        '</div>' +
      '</div>' +

      '<div class="form-group qte-summary" style="margin-top:0.9rem;border-top:1px solid var(--color-border);padding-top:0.75rem"' + (summarises ? "" : " hidden") + '>' +
        '<label style="font-weight:600">The summary email</label>' +
        '<p style="font-size:0.8rem;color:var(--color-text-tertiary);margin:0 0 0.4rem">Sent to everyone the held alerts would have reached — always by email, even for people who prefer push — listing the alerts still active, each linking to the device in Polaris. No graphs.</p>' +
        '<label style="display:block;margin:0.2rem 0 0;font-weight:400;cursor:pointer">' +
          '<input type="radio" name="' + p + '-sendat" class="qte-sendat" value="end"' + (summaryAt ? "" : " checked") + ' style="width:auto"> When each quiet period ends' +
        '</label>' +
        '<label style="display:inline-flex;align-items:center;gap:6px;margin:0.2rem 0 0;font-weight:400;cursor:pointer">' +
          '<input type="radio" name="' + p + '-sendat" class="qte-sendat" value="time"' + (summaryAt ? " checked" : "") + ' style="width:auto"> At ' +
          '<input type="time" class="qte-summary-time" value="' + esc(summaryAt || "07:30") + '" style="width:auto"' + (summaryAt ? "" : " disabled") + '>' +
          '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">(' + esc(zoneLabel(meta) || "server time") + '; must be outside the quiet period — alerts held until then roll into that summary)</span>' +
        '</label>' +
        '<div style="display:flex;gap:1.5rem;flex-wrap:wrap;margin-top:0.6rem;align-items:flex-end">' +
          '<div><label>Also report an alert that recurs more than</label>' +
            '<div style="display:flex;align-items:center;gap:6px">' +
              '<input type="number" class="qte-threshold" min="1" max="100" value="' + esc(threshold) + '" placeholder="off" style="width:5rem"> times' +
            '</div>' +
            '<span class="hint">Same automation, same device, same port or mount — listed with every time it fired, even if it recovered.</span>' +
          '</div>' +
          '<div><label>Send through</label>' +
            '<select class="qte-channel" style="width:auto">' +
              '<option value="">Automatic (the alert’s own email channel)</option>' +
              channels.map(function (c) {
                return '<option value="' + esc(c.id) + '"' + (cfg && cfg.summaryChannelId === c.id ? " selected" : "") + '>' + esc(c.name) + '</option>';
              }).join("") +
            '</select>' +
            (channels.length ? "" : '<span class="hint" style="display:block;color:var(--color-warning)">No email channel is configured — add one under Delivery or the summary cannot be sent.</span>') +
          '</div>' +
        '</div>' +
        '<label style="display:flex;align-items:flex-start;gap:6px;margin:0.7rem 0 0;font-weight:400;cursor:pointer">' +
          '<input type="checkbox" class="qte-always"' + (!cfg || cfg.summaryAlways !== false ? " checked" : "") + ' style="width:auto;margin-top:0.2rem"> ' +
          '<span>All-Quiet Summary emails <span style="font-size:0.78rem;color:var(--color-text-tertiary)">— when nothing was held, an email saying nothing is outstanding, which also confirms the quiet time and email delivery are working. It goes to the people the covered automations notify, including the users of every region their devices are in.</span></span>' +
        '</label>' +
        '<p class="qte-problem" style="font-size:0.8rem;color:var(--color-warning);margin:6px 0 0"></p>' +
      '</div>' +
    '</div>';
  }

  /** Stash the read-only windows on their rows so collect re-sends them verbatim. */
  function stashExtras(host, cfg) {
    var extras = splitWindows(cfg).extras;
    var rows = host.querySelectorAll(".qte-extras .qte-extra");
    for (var i = 0; i < rows.length; i++) rows[i]._quietWindow = extras[i] || null;
  }

  function wire(host, cfg, onChange) {
    var fire = function () { refreshProblem(host); if (typeof onChange === "function") onChange(); };
    stashExtras(host, cfg || null);
    // The exceptions live on the host, not in its DOM — the modal edits them —
    // and collect() re-sends them: a stored field with no editor is deleted on
    // save.
    host._quietRecipients = ((cfg && cfg.recipients) || []).map(function (r) {
      return { address: r.address, held: Object.assign({}, r.held || {}) };
    });
    host._qteFire = fire;
    var rxBtn = host.querySelector(".qte-recipients-btn");
    if (rxBtn) rxBtn.addEventListener("click", function () { openRecipientsModal(host); });
    R().wireScheduleEditor(host.querySelector(".qte-window .rc-schedule"), fire, QUIET_PRESETS);
    // The summary section is only for a quiet time that holds a FIRST alert
    // somewhere — a reminders-and-escalations-only one has nothing to report.
    wireSeverityTree(host.querySelector(".qte-sevtree"), function () {
      var sum = host.querySelector(".qte-summary");
      if (sum) sum.hidden = !anyAlertsHeld(readTree(host.querySelector(".qte-sevtree")));
      fire();
    });
    host.querySelectorAll(".qte-sendat").forEach(function (r) {
      r.addEventListener("change", function () {
        var t = host.querySelector(".qte-summary-time");
        if (t) t.disabled = (host.querySelector(".qte-sendat:checked") || {}).value !== "time";
        fire();
      });
    });
    [".qte-summary-time", ".qte-threshold", ".qte-channel", ".qte-always"].forEach(function (sel) {
      var el = host.querySelector(sel);
      if (el) el.addEventListener(el.tagName === "SELECT" ? "change" : "input", fire);
    });
    var extras = host.querySelector(".qte-extras");
    if (extras) {
      extras.addEventListener("click", function (ev) {
        var btn = ev.target.closest && ev.target.closest(".qte-extra-remove");
        if (!btn) return;
        var row = btn.closest(".qte-extra");
        if (row) row.remove();
        fire();
      });
    }
    refreshProblem(host);
  }

  /** "HH:MM" → minutes. */
  function mins(hhmm) {
    var p = String(hhmm || "").split(":");
    return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0);
  }

  /** Does `hhmm` fall inside one of these ranges (midnight-spanning included)? */
  function timeInRanges(hhmm, ranges) {
    if (ranges === null) return true; // all day
    var t = mins(hhmm);
    return (ranges || []).some(function (r) {
      var a = mins(r.startTime), b = mins(r.endTime);
      return b > a ? (t >= a && t < b) : (t >= a || t < b);
    });
  }

  /**
   * The browser's share of the summary-time rule; the server re-checks. A time
   * is refused only when it is inside the quiet period on EVERY day the period
   * occurs — nights and weekends with a 07:30 summary is fine (weekday mornings
   * are free), every night 22:00–08:00 with 07:30 is a summary that could never
   * go out on time. Monthly / yearly shapes always leave free days.
   */
  function summaryTimeProblem(shape, summaryAt) {
    if (!shape || !summaryAt) return "";
    var days = shape.freq === "daily" ? [0, 1, 2, 3, 4, 5, 6] : (shape.freq === "weekly" ? (shape.daysOfWeek || []) : []);
    if (!days.length) return "";
    for (var i = 0; i < days.length; i++) {
      if (!timeInRanges(summaryAt, R().dayRanges(shape, days[i]))) return "";
    }
    return "The summary time " + summaryAt + " is inside the quiet period on every day it occurs, so a summary could never go out on time. Pick a time outside it, or send when the period ends.";
  }

  /**
   * The host → `{ config }` or `{ error }`. A host that asked the severity
   * question itself hands its answer in as `opts.held` (+ `opts.severities`),
   * or — a list only — `opts.severities`, which the server reads as every
   * kind held for those severities.
   */
  function collect(host, opts) {
    opts = opts || {};
    var out = {};
    var windows = [];
    var sched = R().collectScheduleEditor(host.querySelector(".qte-window .rc-schedule"));
    if (sched.error) return { error: "Quiet period — " + sched.error };
    if (sched.shape) windows.push(sched.shape);
    host.querySelectorAll(".qte-extras .qte-extra").forEach(function (row) {
      if (row._quietWindow) windows.push(row._quietWindow);
    });
    if (!windows.length) return { error: "Quiet period: pick the days and hours." };
    out.windows = windows;
    if (host._quietRecipients && host._quietRecipients.length) out.recipients = host._quietRecipients.slice();

    var tree = host.querySelector(".qte-sevtree");
    var summarises = true;
    if (opts.held !== undefined) {
      if (opts.held) out.held = opts.held;
      out.severities = opts.severities !== undefined ? opts.severities : (opts.held ? Object.keys(opts.held) : null);
      summarises = opts.held ? anyAlertsHeld(opts.held) : true;
    } else if (opts.severities !== undefined) {
      out.severities = opts.severities;
    } else if (tree) {
      var got = collectSeverityTree(tree);
      if (got.error) return { error: got.error };
      if (got.held) out.held = got.held;
      out.severities = got.severities;
      summarises = got.held ? anyAlertsHeld(got.held) : true;
    } else {
      out.severities = null;
    }

    if (summarises) {
      var sendAt = (host.querySelector(".qte-sendat:checked") || {}).value || "end";
      var t = (host.querySelector(".qte-summary-time") || {}).value || "";
      out.summaryAt = sendAt === "time" && t ? t : null;
      if (sendAt === "time" && !t) return { error: "Pick the time the summary email goes out, or send it when the period ends." };
      var problem = summaryTimeProblem(sched.shape, out.summaryAt);
      if (problem) return { error: problem };
      var th = (host.querySelector(".qte-threshold") || {}).value;
      out.recurrenceThreshold = th !== "" && th != null && !isNaN(Number(th)) ? Number(th) : null;
      var ch = (host.querySelector(".qte-channel") || {}).value || "";
      out.summaryChannelId = ch || null;
      // On by default; only the opt-out is written (the server reads absent as true).
      var always = host.querySelector(".qte-always");
      if (always && !always.checked) out.summaryAlways = false;
    } else {
      out.summaryAt = null;
      out.recurrenceThreshold = null;
      out.summaryChannelId = null;
    }
    return { config: out };
  }

  function refreshProblem(host) {
    var el = host.querySelector(".qte-problem");
    if (!el) return;
    var got = collect(host);
    el.textContent = got.error && /summary/i.test(got.error) ? got.error : "";
  }

  /** One line: "Daily 22:00–06:00 · holds everything for warning, serious · summary at 07:30". */
  function summary(cfg) {
    if (!cfg || !cfg.windows || !cfg.windows.length) return "";
    var bits = [];
    bits.push(cfg.windows.length <= 2
      ? cfg.windows.map(function (w) { return R().summary(w); }).join(" and ")
      : cfg.windows.length + " quiet periods");
    bits.push("holds " + describeHeld(cfg));
    if (policySummarises(cfg)) bits.push("summary " + (cfg.summaryAt ? "at " + cfg.summaryAt : "when it ends") + (cfg.summaryAlways === false ? ", only when something was held" : ""));
    if (cfg.recurrenceThreshold) bits.push("recurring > " + cfg.recurrenceThreshold + "× reported");
    var rx = (cfg.recipients || []).length;
    if (rx) bits.push(rx + " recipient exception" + (rx === 1 ? "" : "s"));
    return bits.join(" · ");
  }

  window.PolarisQuietTimeEditor = {
    html: html, wire: wire, collect: collect, summary: summary,
    severityTreeHtml: severityTreeHtml, wireSeverityTree: wireSeverityTree, collectSeverityTree: collectSeverityTree,
    heldOf: heldOf, describeHeld: describeHeld, anyAlertsHeld: anyAlertsHeld, policySummarises: policySummarises,
    describeRecipients: describeRecipients, openRecipientsModal: openRecipientsModal,
  };
})();
