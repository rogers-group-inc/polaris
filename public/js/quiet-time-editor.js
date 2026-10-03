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
 *   WHAT GOES QUIET  "everything, summary afterwards" or "only reminders and
 *                escalations" (the first alert still sends).
 *   SEVERITIES   which alert severities the window holds (hidden when the host
 *                asks its own severity question, as the global wizard does).
 *   SUMMARY      when the summary email goes out (at the end of each period,
 *                or at a time of day), which email channel carries it, and the
 *                recurrence threshold. Shown only while "everything" is held —
 *                a follow-ups-only quiet time has nothing to summarise.
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

  // One-click starting points for the rules editor. Each is the whole rule
  // list; "Outside business hours" is the one that INVERTS — its rules say
  // when people are at work and everything else goes quiet.
  var NIGHT = [{ startTime: "22:00", endTime: "06:00" }];
  var QUIET_PRESETS = [
    { key: "nights", label: "Nights and weekends", rules: [{ days: [1, 2, 3, 4, 5], ranges: NIGHT }, { days: [0, 6], ranges: [] }] },
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

  /**
   * @param prefix  id prefix ("awq", "qtw")
   * @param cfg     the stored policy, or null for a new one
   * @param meta    { severities: [...], channels: [...], serverClock, showSeverities?: boolean,
   *                  defaultStart?, defaultEnd? }
   */
  function html(prefix, cfg, meta) {
    meta = meta || {};
    var p = esc(prefix || "qte");
    var split = splitWindows(cfg);
    var holdsAll = !cfg || cfg.holds !== "followUps";
    var sevs = (meta.severities || ["notice", "informational", "warning", "serious", "critical"]);
    var chosen = cfg && Array.isArray(cfg.severities) && cfg.severities.length ? cfg.severities : null;
    var channels = emailChannels(meta);
    var summaryAt = (cfg && cfg.summaryAt) || "";
    var threshold = cfg && cfg.recurrenceThreshold != null ? cfg.recurrenceThreshold : "";

    var sevHtml = meta.showSeverities === false ? "" :
      '<div class="form-group" style="margin-top:0.9rem">' +
        '<label style="font-weight:600">Which severities go quiet</label>' +
        '<p style="font-size:0.8rem;color:var(--color-text-tertiary);margin:0 0 0.4rem">Untick a severity to let it through whatever the hour — critical alerts usually should.</p>' +
        '<div class="qte-severities" style="display:flex;gap:0.9rem;flex-wrap:wrap">' +
          sevs.map(function (sv) {
            var on = !chosen || chosen.indexOf(sv) >= 0;
            return '<label style="display:inline-flex;align-items:center;gap:5px;margin:0;font-weight:400;cursor:pointer">' +
              '<input type="checkbox" class="qte-sev" value="' + esc(sv) + '"' + (on ? " checked" : "") + ' style="width:auto"> ' +
              '<span class="sev-select sev-' + esc(sv) + '" style="padding:1px 8px;border-radius:999px;font-size:0.78rem">' + esc(SEVERITY_LABELS[sv] || sv) + '</span>' +
            '</label>';
          }).join("") +
        '</div>' +
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

      '<div class="form-group" style="margin-top:0.9rem">' +
        '<label style="font-weight:600">What goes quiet</label>' +
        '<label style="display:block;margin:0.3rem 0 0;font-weight:400;cursor:pointer">' +
          '<input type="radio" name="' + p + '-holds" class="qte-holds" value="all"' + (holdsAll ? " checked" : "") + ' style="width:auto"> ' +
          '<strong>Everything.</strong> The alert is raised and shows on the Active Alerts page, but no email, push or chat message goes out until the quiet period ends — then one <strong>summary email</strong> lists what is still outstanding.' +
        '</label>' +
        '<label style="display:block;margin:0.3rem 0 0;font-weight:400;cursor:pointer">' +
          '<input type="radio" name="' + p + '-holds" class="qte-holds" value="followUps"' + (holdsAll ? "" : " checked") + ' style="width:auto"> ' +
          '<strong>Only reminders and escalations.</strong> The first alert and the all-clear still send; the chasing waits for the quiet period to end.' +
        '</label>' +
        '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:4px 0 0">Scripts, API calls and the audit event always run. A quiet period never drops an alert.</p>' +
      '</div>' +

      sevHtml +

      '<div class="form-group qte-summary" style="margin-top:0.9rem;border-top:1px solid var(--color-border);padding-top:0.75rem"' + (holdsAll ? "" : " hidden") + '>' +
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
    R().wireScheduleEditor(host.querySelector(".qte-window .rc-schedule"), fire, QUIET_PRESETS);
    host.querySelectorAll(".qte-holds").forEach(function (r) {
      r.addEventListener("change", function () {
        var sum = host.querySelector(".qte-summary");
        if (sum) sum.hidden = r.value !== "all";
        fire();
      });
    });
    host.querySelectorAll(".qte-sendat").forEach(function (r) {
      r.addEventListener("change", function () {
        var t = host.querySelector(".qte-summary-time");
        if (t) t.disabled = (host.querySelector(".qte-sendat:checked") || {}).value !== "time";
        fire();
      });
    });
    [".qte-summary-time", ".qte-threshold", ".qte-channel"].forEach(function (sel) {
      var el = host.querySelector(sel);
      if (el) el.addEventListener(el.tagName === "SELECT" ? "change" : "input", fire);
    });
    host.querySelectorAll(".qte-sev").forEach(function (el) { el.addEventListener("change", fire); });
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
   * The host → `{ config }` or `{ error }`. `opts.severities` lets a host that
   * asked the severity question itself hand the answer in.
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

    var holds = (host.querySelector(".qte-holds:checked") || {}).value || "all";
    out.holds = holds;

    var sevBoxes = host.querySelectorAll(".qte-sev");
    if (opts.severities !== undefined) {
      out.severities = opts.severities;
    } else if (sevBoxes.length) {
      var picked = Array.prototype.filter.call(sevBoxes, function (b) { return b.checked; }).map(function (b) { return b.value; });
      if (!picked.length) return { error: "Pick at least one severity to hold, or turn quiet time off." };
      out.severities = picked.length === sevBoxes.length ? null : picked;
    } else {
      out.severities = null;
    }

    if (holds === "all") {
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

  /** One line: "Daily 22:00–06:00 · everything held, summary at 07:30 · warning, serious". */
  function summary(cfg) {
    if (!cfg || !cfg.windows || !cfg.windows.length) return "";
    var bits = [];
    bits.push(cfg.windows.length <= 2
      ? cfg.windows.map(function (w) { return R().summary(w); }).join(" and ")
      : cfg.windows.length + " quiet periods");
    if (cfg.holds === "followUps") bits.push("only reminders and escalations held");
    else bits.push("everything held, summary " + (cfg.summaryAt ? "at " + cfg.summaryAt : "when it ends"));
    if (cfg.severities && cfg.severities.length) bits.push(cfg.severities.join(", "));
    if (cfg.recurrenceThreshold) bits.push("recurring > " + cfg.recurrenceThreshold + "× reported");
    return bits.join(" · ");
  }

  window.PolarisQuietTimeEditor = { html: html, wire: wire, collect: collect, summary: summary };
})();
