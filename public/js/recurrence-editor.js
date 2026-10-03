/**
 * public/js/recurrence-editor.js — `window.PolarisRecurrence`
 *
 * The ONE browser-side owner of a recurrence shape (the JSON that
 * `MaintenanceSchedule.schedule` and an automation's `repeat.quiet.windows[]`
 * both carry, validated server-side by `utils/maintenanceRecurrence.ts`):
 * how it reads in words, and how an operator edits its days and hours.
 *
 * It exists because two surfaces edit the same thing — the Maintenance modal
 * on the Assets page and the quiet-time block in the automations wizard — and
 * a second copy of "which days, and what hours on each" is how the two would
 * come to disagree about the shape they both save. The summary moved here for
 * the same reason it is one function on the server: two summarisers of one
 * shape drift into describing the same window two ways on two pages.
 *
 * THE MODEL. Each day of the week is off, or on with a LIST of hour ranges —
 * and a day that is on with no ranges means all day. That is the whole
 * vocabulary, and it is deliberately the same one the engine resolves
 * (`resolveDayRanges`): the day's own hours, else the schedule-wide `hours`,
 * else all day.
 *
 * Two rules the editor enforces before the server has to:
 *   - hours are the SERVER's wall clock, never the browser's (the caller
 *     passes the zone label in; see serverClockInfo),
 *   - two ranges on ONE day may not overlap. "22:00–06:00 and 23:00–01:00" is
 *     a mistyped end time every time, each range is its own occurrence, and
 *     maintenance identifies an occurrence by its start. Overlap ACROSS days
 *     (Friday night into an all-day Saturday) is ordinary and allowed.
 *
 * Every id is caller-prefixed so two editors can sit on one page.
 *
 * Depends on `escapeHtml` from app.js.
 */

/* global escapeHtml */

(function () {
  "use strict";

  var WEEKDAYS = [
    { value: 0, label: "Sun" }, { value: 1, label: "Mon" }, { value: 2, label: "Tue" },
    { value: 3, label: "Wed" }, { value: 4, label: "Thu" }, { value: 5, label: "Fri" },
    { value: 6, label: "Sat" },
  ];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // Mirrors MAX_RANGES_PER_DAY in utils/maintenanceRecurrence.ts. A mismatch
  // shows up as a save the server rejects for a reason the UI never mentioned.
  var MAX_RANGES_PER_DAY = 8;

  var esc = function (s) {
    return typeof escapeHtml === "function" ? escapeHtml(String(s == null ? "" : s)) : String(s == null ? "" : s);
  };

  // ── Reading a shape ───────────────────────────────────────────────────────

  /** "22:00" → 1320. */
  function minutesOfDay(hhmm) {
    var p = String(hhmm || "0:0").split(":");
    return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0);
  }

  /**
   * The hour ranges for one day-of-week, or null for all day — the browser's
   * copy of the engine's `resolveDayRanges`, in the same order for the same
   * reason: a day's own hours, then the schedule-wide list, then the legacy
   * `startTime`/`endTime` pair every pre-per-day-hours row still carries, then
   * all day.
   */
  function dayRanges(shape, dow) {
    if (!shape) return null;
    var own = (shape.hoursByDay || []).filter(function (d) { return d.dow === dow; })[0];
    if (own) return (own.hours || []).length ? own.hours : null;
    if ((shape.hours || []).length) return shape.hours;
    if (shape.startTime && shape.endTime) return [{ startTime: shape.startTime, endTime: shape.endTime }];
    return null;
  }

  /** Which days a recurring shape matches (weekly → its list, daily → all). */
  function shapeDays(shape) {
    if (!shape || shape.kind !== "recurring") return [];
    if (shape.freq === "daily") return [0, 1, 2, 3, 4, 5, 6];
    if (shape.freq === "weekly") return (shape.daysOfWeek || []).slice().sort(function (a, b) { return a - b; });
    return [];
  }

  /** "22:00–06:00, 12:00–13:00" / "all day". */
  function hoursPhrase(ranges) {
    if (!ranges || !ranges.length) return "all day";
    return ranges.map(function (r) { return r.startTime + "–" + r.endTime; }).join(", ");
  }

  /**
   * Days grouped by the hours they keep: "Mon, Tue 22:00–06:00; Sat all day".
   *
   * Only ADJACENT days merge, so the label keeps calendar order — collecting
   * every 22:00 day together would read as a set rather than as a week. Same
   * grouping as the server's `describeDayHours`, and the two must stay in step.
   */
  function dayHoursPhrase(shape) {
    var days = shapeDays(shape);
    if (!days.length) return "";
    var groups = [];
    days.forEach(function (d) {
      var hours = hoursPhrase(dayRanges(shape, d));
      var last = groups[groups.length - 1];
      if (last && last.hours === hours) last.days.push(d);
      else groups.push({ hours: hours, days: [d] });
    });
    var label = function (ds) {
      return ds.map(function (d) { return WEEKDAYS[d].label; }).join(", ");
    };
    if (groups.length === 1) {
      return (days.length === 7 ? "Daily" : label(days)) + " " + groups[0].hours;
    }
    return groups.map(function (g) { return label(g.days) + " " + g.hours; }).join("; ");
  }

  function fmtLocal(iso) {
    // "2026-07-12T22:00(:ss)" → "Jul 12 2026 22:00"
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(String(iso || ""));
    if (!m) return String(iso || "");
    return MONTHS[Number(m[2]) - 1] + " " + Number(m[3]) + " " + m[1] + " " + m[4];
  }

  function fmtDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!m) return String(iso || "");
    return MONTHS[Number(m[2]) - 1] + " " + Number(m[3]) + " " + m[1];
  }

  /** One-line human summary of any recurrence shape. */
  function summary(shape) {
    if (!shape || !shape.kind) return "—";
    if (shape.kind === "oneshot") {
      return "One-time " + fmtLocal(shape.startAt) + " → " + fmtLocal(shape.endAt);
    }
    var base;
    switch (shape.freq) {
      case "daily":
      case "weekly":
        base = dayHoursPhrase(shape) || ("Weekly " + hoursPhrase(dayRanges(shape, 0)));
        break;
      case "monthly":
        base = "Monthly on day " + shape.dayOfMonth + " " + hoursPhrase(dayRanges(shape, 0));
        break;
      case "yearly":
        base = "Yearly " + MONTHS[(shape.month || 1) - 1] + " " + shape.day + " " + hoursPhrase(dayRanges(shape, 0));
        break;
      default:
        base = shape.freq + " " + hoursPhrase(dayRanges(shape, 0));
    }
    if (shape.activeFrom || shape.activeUntil) {
      base += " · " + (shape.activeFrom ? fmtDate(shape.activeFrom) : "…") +
        " – " + (shape.activeUntil ? fmtDate(shape.activeUntil) : "…");
    }
    return base;
  }

  // ── Editing: the hour-range list ──────────────────────────────────────────

  function rangeRowHtml(range) {
    return '<div class="rc-range" style="display:flex;align-items:center;gap:4px;margin-bottom:3px">' +
      '<input type="time" class="rc-start" value="' + esc((range && range.startTime) || "22:00") + '" style="width:auto">' +
      '<span style="color:var(--color-text-tertiary)">–</span>' +
      '<input type="time" class="rc-end" value="' + esc((range && range.endTime) || "06:00") + '" style="width:auto">' +
      '<button type="button" class="rc-remove btn-icon" title="Remove these hours" aria-label="Remove these hours" ' +
        'style="border:1px solid var(--color-border);border-radius:4px;background:transparent;' +
        'color:var(--color-text-secondary);cursor:pointer;width:24px;height:24px;line-height:1">×</button>' +
    '</div>';
  }

  /**
   * The hour-range list: the ranges themselves, an All-day tick, and Add.
   *
   * Used at two levels — inside each day row, and on its own for a monthly or
   * yearly recurrence, which matches one day per period and so has days to
   * speak of but hours to configure all the same.
   */
  function hoursListHtml(ranges, opts) {
    opts = opts || {};
    var allDay = !ranges || ranges.length === 0;
    var rows = (allDay ? [null] : ranges).map(rangeRowHtml).join("");
    return '<div class="rc-hours" style="display:flex;flex-direction:column;gap:2px">' +
      '<label style="display:inline-flex;align-items:center;gap:4px;margin:0;font-weight:400;cursor:pointer;font-size:0.85rem">' +
        '<input type="checkbox" class="rc-allday"' + (allDay ? " checked" : "") + ' style="width:auto"> All day' +
      '</label>' +
      '<div class="rc-ranges"' + (allDay ? ' hidden' : '') + '>' + rows + '</div>' +
      '<button type="button" class="rc-add btn btn-secondary btn-sm" style="align-self:flex-start"' +
        (allDay ? ' hidden' : '') + '>+ Add hours</button>' +
      (opts.note ? '<span class="rc-note" style="font-size:0.75rem;color:var(--color-text-tertiary)">' + esc(opts.note) + '</span>' : '') +
    '</div>';
  }

  /** One day's row: the day tick, and its hour-range list. */
  function dayRowHtml(dow, on, ranges) {
    return '<div class="rc-day" data-dow="' + dow + '" style="display:flex;gap:10px;align-items:flex-start;' +
        'padding:5px 0;border-top:1px solid var(--color-border)">' +
      '<label style="display:inline-flex;align-items:center;gap:5px;margin:0;font-weight:400;cursor:pointer;' +
          'flex:0 0 4.5rem;padding-top:2px">' +
        '<input type="checkbox" class="rc-on"' + (on ? " checked" : "") + ' style="width:auto">' +
        WEEKDAYS[dow].label +
      '</label>' +
      '<div class="rc-day-body" style="flex:1"' + (on ? "" : ' hidden') + '>' + hoursListHtml(ranges) + '</div>' +
      '<span class="rc-day-off" style="flex:1;font-size:0.8rem;color:var(--color-text-tertiary);padding-top:4px"' +
        (on ? ' hidden' : '') + '>—</span>' +
    '</div>';
  }

  /**
   * The seven day rows, seeded from `shape` (or a sensible default).
   *
   * Per-day rows ALWAYS, rather than a shared hour list with a "different
   * hours per day" toggle: one mental model, nothing hidden, and the summary
   * line underneath is what keeps the common "same every night" case
   * readable. `zone` is printed so nobody picks 22:00 in their own timezone.
   */
  function dayEditorHtml(opts) {
    opts = opts || {};
    var shape = opts.shape || null;
    var on = shapeDays(shape);
    // A shape that isn't weekly/daily (or no shape at all) seeds every day on
    // with the default overnight range — the shape most schedules want, and
    // the operator unticks from there. `allOff` overrides that for a host
    // whose recurrence exists but has no weekly part to show (a quiet time
    // whose only window is an API-authored monthly freeze): seeding seven
    // ticked days there would ADD a window nobody asked for on the next save.
    var seedAll = !opts.allOff &&
      (!shape || (shape.kind === "recurring" && shape.freq !== "weekly" && shape.freq !== "daily") || !on.length);
    var rows = WEEKDAYS.map(function (w) {
      var dayOn = opts.allOff ? false : (seedAll ? true : on.indexOf(w.value) >= 0);
      var ranges = seedAll
        ? [{ startTime: opts.defaultStart || "22:00", endTime: opts.defaultEnd || "06:00" }]
        : dayRanges(shape, w.value);
      return dayRowHtml(w.value, dayOn, ranges);
    }).join("");
    // The hint is suppressible because a host may already carry the same
    // sentence for its other pickers (the Maintenance modal's one-time window
    // needs it too, so that modal states it once above both).
    var hint = opts.hint === false ? "" :
      '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:2px 0 0">' +
        'Hours are the Polaris server’s wall clock' + (opts.zone ? " (" + esc(opts.zone) + ")" : "") +
        '. An end at or before the start runs into the next day — 22:00 – 06:00 ends at 6 AM the following ' +
        'morning, and it belongs to the day it STARTS on.' +
      '</p>';
    return '<div class="rc-editor">' +
      '<div class="rc-days" style="border-bottom:1px solid var(--color-border)">' + rows + '</div>' +
      '<p class="rc-summary" style="font-size:0.8rem;color:var(--color-text-secondary);margin:6px 0 0"></p>' +
      hint +
    '</div>';
  }

  // ── Editing: collection ───────────────────────────────────────────────────

  /** One `.rc-hours` block → ranges array (empty = all day), or an error. */
  function collectHoursList(host, label) {
    var allDay = host.querySelector(".rc-allday");
    if (allDay && allDay.checked) return { ranges: [] };
    var out = [];
    var rows = host.querySelectorAll(".rc-range");
    for (var i = 0; i < rows.length; i++) {
      var s = rows[i].querySelector(".rc-start").value;
      var e = rows[i].querySelector(".rc-end").value;
      if (!s || !e) return { error: label + ": every row needs a start and an end time." };
      out.push({ startTime: s, endTime: e });
    }
    if (!out.length) return { error: label + ": add hours, or tick All day." };
    // Same-day overlap, checked here so the operator hears which two ranges
    // clash instead of a 400 from the save.
    var iv = out.map(function (r) {
      var a = minutesOfDay(r.startTime);
      var b = minutesOfDay(r.endTime);
      return { a: a, b: b <= a ? b + 1440 : b, text: r.startTime + "–" + r.endTime };
    }).sort(function (x, y) { return x.a - y.a; });
    for (var k = 1; k < iv.length; k++) {
      if (iv[k].a < iv[k - 1].b) {
        return { error: label + ": " + iv[k - 1].text + " overlaps " + iv[k].text + "." };
      }
    }
    return { ranges: out };
  }

  /**
   * The day rows → the days/hours half of a recurring shape, or `{error}`.
   *
   * Collapses to the compact form when every chosen day keeps the SAME hours
   * (`hours`, plus `freq: "daily"` when that is all seven) and otherwise
   * states `hoursByDay` for EVERY chosen day — never a mix of the two. The
   * engine's fallback order exists for the legacy rows, and a shape this
   * editor wrote should not depend on it to be read correctly.
   */
  function collectDayEditor(container) {
    var days = [];
    var byDay = {};
    var rows = container.querySelectorAll(".rc-day");
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var dow = Number(row.getAttribute("data-dow"));
      if (!row.querySelector(".rc-on").checked) continue;
      var got = collectHoursList(row.querySelector(".rc-day-body"), WEEKDAYS[dow].label);
      if (got.error) return { error: got.error };
      days.push(dow);
      byDay[dow] = got.ranges;
    }
    // "No days" is reported apart from a real error, because it means
    // different things to the two hosts: the Maintenance modal has nothing to
    // save without a day, while a quiet time may legitimately carry only an
    // API-authored monthly window and no weekly one.
    if (!days.length) return { empty: true };

    var sig = function (d) { return JSON.stringify(byDay[d]); };
    var uniform = days.every(function (d) { return sig(d) === sig(days[0]); });
    if (uniform) {
      var out = days.length === 7 ? { freq: "daily" } : { freq: "weekly", daysOfWeek: days };
      if (byDay[days[0]].length) out.hours = byDay[days[0]];
      return out;
    }
    return {
      freq: "weekly",
      daysOfWeek: days,
      hoursByDay: days.map(function (d) { return { dow: d, hours: byDay[d] }; }),
    };
  }

  // ── Editing: wiring ───────────────────────────────────────────────────────

  /**
   * Delegated handlers for one editor container. Rows appear and disappear, so
   * nothing is bound per control; `onChange` fires after every mutation so the
   * caller can re-render its own summary or preview.
   */
  function wire(container, onChange) {
    var fire = function () {
      refreshSummary(container);
      if (typeof onChange === "function") onChange();
    };
    container.addEventListener("click", function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var add = t.closest(".rc-add");
      if (add) {
        var host = add.closest(".rc-hours");
        var list = host.querySelector(".rc-ranges");
        if (list.querySelectorAll(".rc-range").length >= MAX_RANGES_PER_DAY) return;
        list.insertAdjacentHTML("beforeend", rangeRowHtml(null));
        fire();
        return;
      }
      var rm = t.closest(".rc-remove");
      if (rm) {
        var range = rm.closest(".rc-range");
        var ranges = rm.closest(".rc-ranges");
        // The last range is not deleted out from under the operator: All day
        // is what "no hours" means, and an empty list with an Add button under
        // it reads as a broken control.
        if (ranges.querySelectorAll(".rc-range").length <= 1) {
          var allDay = ranges.closest(".rc-hours").querySelector(".rc-allday");
          allDay.checked = true;
          syncHoursList(ranges.closest(".rc-hours"));
        } else {
          range.remove();
        }
        fire();
      }
    });
    container.addEventListener("change", function (ev) {
      var t = ev.target;
      if (!t || !t.classList) return;
      if (t.classList.contains("rc-on")) {
        var row = t.closest(".rc-day");
        row.querySelector(".rc-day-body").hidden = !t.checked;
        row.querySelector(".rc-day-off").hidden = t.checked;
      } else if (t.classList.contains("rc-allday")) {
        syncHoursList(t.closest(".rc-hours"));
      }
      fire();
    });
    container.addEventListener("input", fire);
    refreshSummary(container);
  }

  function syncHoursList(host) {
    var allDay = host.querySelector(".rc-allday").checked;
    host.querySelector(".rc-ranges").hidden = allDay;
    var add = host.querySelector(".rc-add");
    if (add) add.hidden = allDay;
  }

  /** Paint the editor's own summary line (or the reason it can't). */
  function refreshSummary(container) {
    var out = container.querySelector(".rc-summary");
    if (!out) return;
    var got = collectDayEditor(container);
    if (got.error || got.empty) {
      out.textContent = got.error || "No days picked.";
      out.style.color = "var(--color-warning)";
      return;
    }
    out.textContent = summary(Object.assign({ version: 1, kind: "recurring" }, got));
    out.style.color = "var(--color-text-secondary)";
  }

  // ── Editing: RULES ("which days, and either all day or these hours") ──────
  //
  // The day-rows editor above asks the same question seven times. Almost every
  // schedule anyone writes is two or three sentences — "Mon–Fri 22:00–06:00"
  // and "all weekend" — so this editor takes them as sentences: each RULE is a
  // set of day chips plus the hour-range list (the same `hoursListHtml`,
  // All-day tick included). A preset row fills the rules in one click, an
  // optional INVERT ("quiet outside these hours") turns working hours into
  // everything else, and a week strip under the rules paints what they mean
  // hour by hour — gaps, a Monday morning nobody covered, two rules that
  // overlap on one day — before the save does. What it SAVES is the same
  // days/hours half of a recurring shape `collectDayEditor` produces, by the
  // same collapse, so the server, the summary and every round-trip test are
  // unchanged; the day rows survive underneath as a read-only breakdown.
  //
  // Rules are collected VERBATIM (a 22:00–06:00 range stays one overnight
  // range on its start day) so an untouched schedule re-saves byte-identical.
  // Only the INVERT path derives ranges from minute masks, stitching a run
  // that ends at midnight onto the next day's run that starts at 00:00 — the
  // one place the overnight shape has to be reconstructed rather than kept.

  var DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  /** Rules for a stored shape: days grouped by identical hours, calendar order. */
  function rulesFromShape(shape, defaults) {
    var days = shapeDays(shape);
    if (!shape || !days.length) {
      return [{ days: [0, 1, 2, 3, 4, 5, 6], ranges: [{ startTime: defaults.start, endTime: defaults.end }] }];
    }
    var groups = [];
    days.forEach(function (d) {
      var r = dayRanges(shape, d);
      var sig = JSON.stringify(r);
      var g = groups.filter(function (x) { return x.sig === sig; })[0];
      if (g) g.days.push(d); else groups.push({ sig: sig, days: [d], ranges: r === null ? [] : r.map(function (x) { return { startTime: x.startTime, endTime: x.endTime }; }) });
    });
    return groups.map(function (g) { return { days: g.days, ranges: g.ranges }; });
  }

  function ruleHtml(rule) {
    return '<div class="rc-rule" style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 10px;align-items:start;' +
        'padding:10px;border:1px solid var(--color-border);border-radius:8px;background:var(--color-bg-secondary,transparent)">' +
      '<div style="display:grid;gap:6px;min-width:0">' +
        '<div class="rc-chips" style="display:flex;gap:4px;flex-wrap:wrap">' +
          DAY_SHORT.map(function (label, dow) {
            var on = rule.days.indexOf(dow) >= 0;
            return '<button type="button" class="rc-chip" data-dow="' + dow + '" aria-pressed="' + on + '" ' +
              'style="width:2.6rem;height:1.9rem;border-radius:6px;border:1px solid ' + (on ? "var(--color-accent)" : "var(--color-border)") + ';' +
              'background:' + (on ? "var(--color-accent)" : "transparent") + ';color:' + (on ? "#fff" : "var(--color-text-secondary)") + ';' +
              'font-size:0.78rem;font-weight:500;cursor:pointer">' + label + '</button>';
          }).join("") +
        '</div>' +
        hoursListHtml(rule.ranges) +
      '</div>' +
      '<button type="button" class="rc-rule-remove btn btn-secondary btn-sm" title="Remove this period">Remove</button>' +
    '</div>';
  }

  function presetsHtml(presets) {
    if (!presets || !presets.length) return "";
    return '<div class="rc-presets" style="display:flex;gap:6px;flex-wrap:wrap;margin:0 0 8px">' +
      presets.map(function (p) {
        return '<button type="button" class="rc-preset btn btn-secondary btn-sm" data-preset="' + esc(p.key) + '" aria-pressed="false" ' +
          'style="border-radius:999px">' + esc(p.label) + '</button>';
      }).join("") +
    '</div>';
  }

  /**
   * The rules editor. `opts`: `shape` (seed), `presets` ([{key, label,
   * invert?, rules:[{days, ranges}]}]), `invertLabel` + `invertHelp` (render
   * the invert tick), `zone`, `hint`, `defaultStart` / `defaultEnd`.
   */
  function rulesEditorHtml(prefix, opts) {
    opts = opts || {};
    var p = esc(prefix || "rc");
    var defaults = { start: opts.defaultStart || "22:00", end: opts.defaultEnd || "06:00" };
    var rules = rulesFromShape(opts.shape || null, defaults);
    var hint = opts.hint === false ? "" :
      '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:2px 0 0">' +
        'Hours are the Polaris server’s wall clock' + (opts.zone ? " (" + esc(opts.zone) + ")" : "") +
        '. An end at or before the start runs into the next day — 22:00 – 06:00 ends at 6 AM the following morning.' +
      '</p>';
    var invert = opts.invertLabel
      ? '<label style="display:inline-flex;align-items:flex-start;gap:6px;margin:0 0 8px;font-weight:400;cursor:pointer;font-size:0.85rem">' +
          '<input type="checkbox" class="rc-invert" style="width:auto;margin-top:3px"> ' +
          '<span><strong>' + esc(opts.invertLabel) + '</strong>' + (opts.invertHelp ? ' <span style="color:var(--color-text-tertiary)">' + esc(opts.invertHelp) + '</span>' : "") + '</span>' +
        '</label>'
      : "";
    return '<div class="rc-rules" id="' + p + '" data-default-start="' + esc(defaults.start) + '" data-default-end="' + esc(defaults.end) + '">' +
      presetsHtml(opts.presets) +
      invert +
      '<div class="rc-rule-list" style="display:grid;gap:8px">' + rules.map(ruleHtml).join("") + '</div>' +
      '<button type="button" class="rc-rule-add btn btn-secondary btn-sm" style="margin-top:8px">+ Add period</button>' +
      '<div class="rc-strip" style="display:grid;grid-template-columns:2.4rem 1fr;gap:4px 8px;align-items:center;margin-top:12px;font-size:0.75rem;color:var(--color-text-secondary)"></div>' +
      '<div style="display:grid;grid-template-columns:2.4rem 1fr;gap:4px 8px"><span></span>' +
        '<div style="display:grid;grid-template-columns:repeat(4,1fr);font-size:0.7rem;color:var(--color-text-tertiary)"><span>00:00</span><span>06:00</span><span>12:00</span><span style="text-align:right">18:00 &nbsp; 24:00</span></div></div>' +
      '<p class="rc-summary" style="font-size:0.8rem;color:var(--color-text-secondary);margin:6px 0 0"></p>' +
      '<details class="rc-perday" style="margin-top:6px"><summary style="cursor:pointer;font-size:0.8rem;color:var(--color-text-tertiary)">Hour by hour, per day</summary>' +
        '<table class="rc-perday-table" style="margin-top:4px;font-size:0.8rem"><tbody></tbody></table></details>' +
      hint +
    '</div>';
  }

  /** The rules as the operator has them on screen: [{days, ranges|null(all day), error?}]. */
  function readRules(host) {
    var out = [];
    var rows = host.querySelectorAll(".rc-rule");
    for (var i = 0; i < rows.length; i++) {
      var days = Array.prototype.filter.call(rows[i].querySelectorAll(".rc-chip"), function (c) { return c.getAttribute("aria-pressed") === "true"; })
        .map(function (c) { return Number(c.getAttribute("data-dow")); });
      var got = collectHoursList(rows[i].querySelector(".rc-hours"), "Period " + (i + 1));
      out.push({ days: days, ranges: got.error ? null : (got.ranges.length ? got.ranges : null), allDay: !got.error && got.ranges.length === 0, error: got.error || null, index: i });
    }
    return out;
  }

  /** 7 × 1440 quiet-minute masks from the rules, plus per-day same-day overlap flags. */
  function rulesMasks(rules, invert) {
    // `own` is what each day's OWN rules cover; `spill` is what the previous
    // day's overnight range carries past midnight. A conflict is two rules
    // covering one minute of the SAME day — Friday 22:00–06:00 running into
    // "Saturday all day" is the normal shape of nights-and-weekends, not a
    // clash, and must not paint Saturday as one.
    var own = [], spill = [], conflict = [false, false, false, false, false, false, false];
    for (var d = 0; d < 7; d++) { own.push(new Uint8Array(1440)); spill.push(new Uint8Array(1440)); }
    rules.forEach(function (r) {
      if (r.error) return;
      r.days.forEach(function (dow) {
        if (r.allDay) { for (var i = 0; i < 1440; i++) { if (own[dow][i]) conflict[dow] = true; own[dow][i] = 1; } return; }
        (r.ranges || []).forEach(function (h) {
          var a = minutesOfDay(h.startTime), b = minutesOfDay(h.endTime);
          if (b <= a) b += 1440;
          for (var k = a; k < b; k++) {
            if (k < 1440) { if (own[dow][k]) conflict[dow] = true; own[dow][k] = 1; }
            else spill[(dow + 1) % 7][k % 1440] = 1;
          }
        });
      });
    });
    var m = own.map(function (o, d3) {
      var out = new Uint8Array(1440);
      for (var j = 0; j < 1440; j++) out[j] = (o[j] || spill[d3][j]) ? 1 : 0;
      return out;
    });
    if (invert) for (var d2 = 0; d2 < 7; d2++) for (var j2 = 0; j2 < 1440; j2++) m[d2][j2] = m[d2][j2] ? 0 : 1;
    return { m: m, conflict: conflict };
  }

  function hhmm(mins) {
    mins = ((mins % 1440) + 1440) % 1440;
    return String(Math.floor(mins / 60)).padStart(2, "0") + ":" + String(mins % 60).padStart(2, "0");
  }

  /** A day's mask → its ranges: null = all day, [] = nothing, runs otherwise (end "00:00" = midnight). */
  function maskRanges(mask) {
    var all = true, none = true;
    for (var i = 0; i < 1440; i++) { if (!mask[i]) all = false; else none = false; }
    if (all) return null;
    if (none) return [];
    var out = [], k = 0;
    while (k < 1440) {
      if (!mask[k]) { k++; continue; }
      var start = k;
      while (k < 1440 && mask[k]) k++;
      out.push({ startTime: hhmm(start), endTime: hhmm(k) });
    }
    return out;
  }

  /** A run ending at midnight + the next day's run from 00:00 = one overnight range on the START day. */
  function stitchMidnight(byDay) {
    for (var d = 0; d < 7; d++) {
      var today = byDay[d], next = byDay[(d + 1) % 7];
      if (!today || !next || !today.length || !next.length) continue;
      var last = today[today.length - 1], first = next[0];
      if (last.endTime === "00:00" && first.startTime === "00:00") { last.endTime = first.endTime; next.shift(); }
    }
    return byDay;
  }

  /** Per-day ranges (null = all day, [] = off) from the rules — verbatim, or via masks when inverted. */
  function rulesPerDay(rules, invert) {
    if (invert) {
      var r = rulesMasks(rules, true);
      return stitchMidnight(r.m.map(maskRanges));
    }
    var byDay = [[], [], [], [], [], [], []];
    rules.forEach(function (rule) {
      if (rule.error) return;
      rule.days.forEach(function (dow) {
        if (rule.allDay || byDay[dow] === null) { byDay[dow] = null; return; }
        byDay[dow] = byDay[dow].concat(rule.ranges || []);
      });
    });
    return byDay;
  }

  /** Days + per-day ranges → the compact or per-day stored half (the collectDayEditor collapse). */
  function collapseDays(byDay) {
    var days = [];
    for (var d = 0; d < 7; d++) if (byDay[d] === null || (byDay[d] && byDay[d].length)) days.push(d);
    if (!days.length) return { empty: true };
    var sig = function (d) { return JSON.stringify(byDay[d]); };
    var uniform = days.every(function (d) { return sig(d) === sig(days[0]); });
    if (uniform) {
      var out = days.length === 7 ? { freq: "daily" } : { freq: "weekly", daysOfWeek: days };
      if (byDay[days[0]] !== null && byDay[days[0]].length) out.hours = byDay[days[0]];
      return out;
    }
    return { freq: "weekly", daysOfWeek: days, hoursByDay: days.map(function (d) { return { dow: d, hours: byDay[d] === null ? [] : byDay[d] }; }) };
  }

  /** Same-day overlap across rules, named by day. */
  function crossRuleOverlap(byDay, rules) {
    // An all-day period sharing a day with any other period: the union would
    // quietly be "all day", which hides that the day is listed twice.
    for (var d0 = 0; d0 < 7; d0++) {
      var here = (rules || []).filter(function (r) { return !r.error && r.days.indexOf(d0) >= 0; });
      if (here.length < 2) continue;
      var allDay = here.filter(function (r) { return r.allDay; });
      if (!allDay.length) continue;
      var other = here.filter(function (r) { return r !== allDay[0]; })[0];
      var otherText = other.allDay ? "all day" : (other.ranges || []).map(function (h) { return h.startTime + "–" + h.endTime; }).join(", ");
      return DAY_SHORT[d0] + ": all day overlaps " + otherText + " — a day that is quiet all day needs no other period; remove it from one.";
    }
    for (var d = 0; d < 7; d++) {
      var ranges = byDay[d];
      if (!ranges || ranges.length < 2) continue;
      var iv = ranges.map(function (r) {
        var a = minutesOfDay(r.startTime), b = minutesOfDay(r.endTime);
        return { a: a, b: b <= a ? b + 1440 : b, text: r.startTime + "–" + r.endTime };
      }).sort(function (x, y) { return x.a - y.a; });
      for (var k = 1; k < iv.length; k++) {
        if (iv[k].a < iv[k - 1].b) return DAY_SHORT[d] + ": " + iv[k - 1].text + " overlaps " + iv[k].text + " — two periods cover the same hours; merge them or trim one.";
      }
    }
    return "";
  }

  /**
   * The rules → the days/hours half of a recurring shape, `{error}` or
   * `{empty}` — the SAME contract as collectDayEditor, so a host swaps one
   * for the other without touching its own save path.
   */
  function collectRulesEditor(host) {
    var rules = readRules(host);
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].error) return { error: rules[i].error };
      if (!rules[i].days.length) return { error: "Period " + (i + 1) + ": pick at least one day, or remove it." };
    }
    var invert = !!(host.querySelector(".rc-invert") && host.querySelector(".rc-invert").checked);
    var byDay = rulesPerDay(rules, invert);
    if (!invert) {
      var clash = crossRuleOverlap(byDay, rules);
      if (clash) return { error: clash };
    }
    return collapseDays(byDay);
  }

  function paintRules(host) {
    var rules = readRules(host);
    var invert = !!(host.querySelector(".rc-invert") && host.querySelector(".rc-invert").checked);
    var r = rulesMasks(rules, invert);
    var strip = host.querySelector(".rc-strip");
    if (strip) {
      var html = "";
      for (var d = 0; d < 7; d++) {
        var cells = "";
        for (var c = 0; c < 48; c++) {
          var q = 0;
          for (var k = c * 30; k < c * 30 + 30; k++) q += r.m[d][k];
          var bg = q >= 15 ? (r.conflict[d] && !invert ? "var(--color-warning)" : "var(--color-accent)") : "transparent";
          cells += '<i style="display:block;background:' + bg + '"></i>';
        }
        html += '<span>' + DAY_SHORT[d] + '</span>' +
          '<div style="display:grid;grid-template-columns:repeat(48,1fr);height:14px;border-radius:3px;overflow:hidden;border:1px solid var(--color-border)" aria-label="' + DAY_SHORT[d] + '">' + cells + '</div>';
      }
      strip.innerHTML = html;
    }
    var byDay = rulesPerDay(rules, invert);
    var tb = host.querySelector(".rc-perday-table tbody");
    if (tb) {
      tb.innerHTML = byDay.map(function (ranges, d) {
        var txt = ranges === null ? "all day" : (ranges && ranges.length ? ranges.map(function (x) { return x.startTime + "–" + x.endTime; }).join(", ") : "—");
        return '<tr><td style="padding:2px 10px 2px 0;color:var(--color-text-tertiary)">' + DAY_SHORT[d] + '</td><td style="padding:2px 0;font-family:ui-monospace,Consolas,monospace">' + esc(txt) + '</td></tr>';
      }).join("");
    }
    var out = host.querySelector(".rc-summary");
    if (out) {
      var got = collectRulesEditor(host);
      if (got.error || got.empty) {
        out.textContent = got.error || "No days picked.";
        out.style.color = "var(--color-warning)";
      } else {
        out.textContent = summary(Object.assign({ version: 1, kind: "recurring" }, got)) + (invert ? " (everything outside the hours above)" : "");
        out.style.color = "var(--color-text-secondary)";
      }
    }
  }

  function applyPreset(host, preset) {
    var list = host.querySelector(".rc-rule-list");
    list.innerHTML = preset.rules.map(function (r) { return ruleHtml({ days: r.days, ranges: r.ranges || [] }); }).join("");
    var inv = host.querySelector(".rc-invert");
    if (inv) inv.checked = !!preset.invert;
  }

  function markPreset(host, key) {
    host.querySelectorAll(".rc-preset").forEach(function (b) {
      var on = b.getAttribute("data-preset") === key;
      b.setAttribute("aria-pressed", String(on));
      b.classList.toggle("btn-primary", on);
      b.classList.toggle("btn-secondary", !on);
    });
  }

  /**
   * Delegated handlers on the `.rc-rules` host — re-rendering the list (a
   * preset, a fill) keeps them. `presets` is the same list the host rendered
   * with, so a click can apply it.
   */
  function wireRulesEditor(host, onChange, presets) {
    var fire = function () { paintRules(host); if (typeof onChange === "function") onChange(); };
    var byKey = {};
    (presets || []).forEach(function (p) { byKey[p.key] = p; });
    host.addEventListener("click", function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var chip = t.closest(".rc-chip");
      if (chip) {
        var on = chip.getAttribute("aria-pressed") !== "true";
        chip.setAttribute("aria-pressed", String(on));
        chip.style.background = on ? "var(--color-accent)" : "transparent";
        chip.style.borderColor = on ? "var(--color-accent)" : "var(--color-border)";
        chip.style.color = on ? "#fff" : "var(--color-text-secondary)";
        markPreset(host, null); fire(); return;
      }
      var preset = t.closest(".rc-preset");
      if (preset && byKey[preset.getAttribute("data-preset")]) {
        applyPreset(host, byKey[preset.getAttribute("data-preset")]);
        markPreset(host, preset.getAttribute("data-preset")); fire(); return;
      }
      if (t.closest(".rc-rule-add")) {
        host.querySelector(".rc-rule-list").insertAdjacentHTML("beforeend", ruleHtml({ days: [], ranges: [{ startTime: host.getAttribute("data-default-start"), endTime: host.getAttribute("data-default-end") }] }));
        markPreset(host, null); fire(); return;
      }
      var rm = t.closest(".rc-rule-remove");
      if (rm) { var row = rm.closest(".rc-rule"); if (row) row.remove(); markPreset(host, null); fire(); return; }
      // The hour-range Add / Remove inside a rule are the shared list's own
      // controls (the same markup `wire` handles for the day rows).
      var add = t.closest(".rc-add");
      if (add) {
        var hl = add.closest(".rc-hours"), ranges = hl.querySelector(".rc-ranges");
        if (ranges.querySelectorAll(".rc-range").length < MAX_RANGES_PER_DAY) ranges.insertAdjacentHTML("beforeend", rangeRowHtml(null));
        markPreset(host, null); fire(); return;
      }
      var rmr = t.closest(".rc-remove");
      if (rmr) {
        var rangeEl = rmr.closest(".rc-range"), rangesEl = rmr.closest(".rc-ranges");
        if (rangesEl.querySelectorAll(".rc-range").length <= 1) {
          rangesEl.closest(".rc-hours").querySelector(".rc-allday").checked = true;
          syncHoursList(rangesEl.closest(".rc-hours"));
        } else {
          rangeEl.remove();
        }
        markPreset(host, null); fire();
      }
    });
    host.addEventListener("change", function (ev) {
      var t = ev.target;
      if (!t || !t.classList) return;
      if (t.classList.contains("rc-allday")) syncHoursList(t.closest(".rc-hours"));
      if (!t.classList.contains("rc-invert")) markPreset(host, null);
      else markPreset(host, null);
      fire();
    });
    host.addEventListener("input", function (ev) {
      var t = ev.target;
      if (t && t.classList && (t.classList.contains("rc-start") || t.classList.contains("rc-end"))) { markPreset(host, null); fire(); }
    });
    paintRules(host);
  }

  /** Re-seed the rules from a stored shape (a loaded schedule). Handlers stay — they are delegated. */
  function fillRulesEditor(host, shape) {
    var defaults = { start: host.getAttribute("data-default-start") || "22:00", end: host.getAttribute("data-default-end") || "06:00" };
    host.querySelector(".rc-rule-list").innerHTML = rulesFromShape(shape, defaults).map(ruleHtml).join("");
    var inv = host.querySelector(".rc-invert");
    if (inv) inv.checked = false;
    markPreset(host, null);
    paintRules(host);
  }

  // ── Editing: a WHOLE recurring schedule ───────────────────────────────────
  //
  // The day/hours editor above is the days-of-the-week half of a recurrence.
  // A full recurring shape also has a frequency (days of the week / monthly /
  // yearly), the day-of-period controls those two need, an hour list for them
  // (they match one day per period and so have no per-day rows), and optional
  // first/last dates. The Maintenance modal built those around the day editor
  // in its own markup; the quiet-time editors (an automation's Quiet time step
  // and the global quiet-time wizard) need the same thing, so it lives here
  // once. Class-scoped inside a `.rc-schedule` host, with the one id the
  // <label for> needs prefixed, so two can share a page. The Maintenance modal
  // still carries its own copy for now — migrating it is a follow-up.

  function periodRanges(shape) {
    return shape && shape.kind === "recurring" ? (dayRanges(shape, 0) || []) : [];
  }

  /**
   * The whole recurring-schedule editor. `opts.shape` seeds it; `opts.zone`,
   * `opts.defaultStart`/`defaultEnd` and `opts.hint` pass to the day editor.
   */
  function scheduleEditorHtml(prefix, opts) {
    opts = opts || {};
    var shape = opts.shape && opts.shape.kind === "recurring" ? opts.shape : null;
    var storedFreq = shape ? (shape.freq || "daily") : "daily";
    var mode = storedFreq === "daily" || storedFreq === "weekly" ? "days" : storedFreq;
    var p = esc(prefix || "rc");
    var monthOpts = MONTHS.map(function (m, i) {
      return '<option value="' + (i + 1) + '"' + (shape && shape.month === i + 1 ? " selected" : "") + '>' + m + '</option>';
    }).join("");
    return '<div class="rc-schedule">' +
      '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">' +
        '<div><label for="' + p + '-freq">Repeats</label>' +
          '<select id="' + p + '-freq" class="rc-freq" style="width:auto">' +
            '<option value="days"' + (mode === "days" ? " selected" : "") + '>Specific days of the week</option>' +
            '<option value="monthly"' + (mode === "monthly" ? " selected" : "") + '>Monthly</option>' +
            '<option value="yearly"' + (mode === "yearly" ? " selected" : "") + '>Yearly</option>' +
          '</select></div>' +
        '<div class="rc-monthly-block"' + (mode === "monthly" ? "" : ' style="display:none"') + '><label>Day of month</label>' +
          '<input type="number" class="rc-daymonth" min="1" max="31" value="' + esc(shape && shape.dayOfMonth ? shape.dayOfMonth : 1) + '" style="max-width:90px">' +
          '<span class="hint" style="display:block">31 = last-day clamp in short months</span></div>' +
        '<div class="rc-yearly-block"' + (mode === "yearly" ? "" : ' style="display:none"') + '><label>Month / day</label>' +
          '<select class="rc-month" style="max-width:110px">' + monthOpts + '</select> ' +
          '<input type="number" class="rc-day" min="1" max="31" value="' + esc(shape && shape.day ? shape.day : 1) + '" style="max-width:80px">' +
        '</div>' +
      '</div>' +
      '<div class="rc-weekly-block" style="margin-top:8px' + (mode === "days" ? "" : ";display:none") + '">' +
        '<label>Days and hours</label>' +
        // The RULES editor ("Mon–Fri 22:00–06:00; all weekend"), not the seven
        // day rows — same saved shape, a quarter of the controls, and a week
        // strip that shows what the rules mean before the save does.
        '<div class="rc-days-host">' + rulesEditorHtml(p + "-rules", {
          shape: mode === "days" ? shape : null,
          zone: opts.zone,
          hint: opts.hint,
          defaultStart: opts.defaultStart,
          defaultEnd: opts.defaultEnd,
          presets: opts.presets,
          invertLabel: opts.invertLabel,
          invertHelp: opts.invertHelp,
        }) + '</div>' +
      '</div>' +
      '<div class="rc-period-block" style="margin-top:10px' + (mode === "days" ? ";display:none" : "") + '">' +
        '<label>Hours</label>' +
        '<div class="rc-period-host">' + hoursListHtml(mode === "days" ? [] : periodRanges(shape)) + '</div>' +
      '</div>' +
      '<div style="margin-top:10px">' +
        '<label>Date range (optional)</label>' +
        '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">' +
          '<input type="date" class="rc-active-from" value="' + esc(shape && shape.activeFrom ? shape.activeFrom : "") + '" style="width:auto"> &ndash; ' +
          '<input type="date" class="rc-active-until" value="' + esc(shape && shape.activeUntil ? shape.activeUntil : "") + '" style="width:auto">' +
        '</div>' +
        '<span class="hint">First / last day the schedule applies (inclusive). Leave empty for no bounds.</span>' +
      '</div>' +
    '</div>';
  }

  /** Show the blocks the chosen frequency needs. */
  function syncScheduleBlocks(host) {
    var freq = (host.querySelector(".rc-freq") || {}).value || "days";
    var show = function (sel, on) { var el = host.querySelector(sel); if (el) el.style.display = on ? "" : "none"; };
    show(".rc-weekly-block", freq === "days");
    show(".rc-monthly-block", freq === "monthly");
    show(".rc-yearly-block", freq === "yearly");
    show(".rc-period-block", freq === "monthly" || freq === "yearly");
  }

  /** Delegated handlers for one `.rc-schedule` host. `presets` must be the list it rendered with. */
  function wireScheduleEditor(host, onChange, presets) {
    var fire = function () { if (typeof onChange === "function") onChange(); };
    wireRulesEditor(host.querySelector(".rc-days-host .rc-rules"), fire, presets);
    wire(host.querySelector(".rc-period-host"), fire);
    var freq = host.querySelector(".rc-freq");
    if (freq) freq.addEventListener("change", function () { syncScheduleBlocks(host); fire(); });
    [".rc-daymonth", ".rc-month", ".rc-day", ".rc-active-from", ".rc-active-until"].forEach(function (sel) {
      var el = host.querySelector(sel);
      if (el) el.addEventListener(el.tagName === "SELECT" ? "change" : "input", fire);
    });
    syncScheduleBlocks(host);
  }

  /**
   * One `.rc-schedule` host → a complete recurring shape, or `{error}`, or
   * `{empty}` when the days mode has no day ticked (the caller decides whether
   * that is a problem — see collectDayEditor).
   */
  function collectScheduleEditor(host) {
    var freq = (host.querySelector(".rc-freq") || {}).value || "days";
    var out = { version: 1, kind: "recurring" };
    if (freq === "days") {
      var got = collectRulesEditor(host.querySelector(".rc-days-host .rc-rules"));
      if (got.empty) return { empty: true };
      if (got.error) return { error: got.error };
      Object.keys(got).forEach(function (k) { out[k] = got[k]; });
    } else {
      out.freq = freq;
      if (freq === "monthly") out.dayOfMonth = parseInt((host.querySelector(".rc-daymonth") || {}).value, 10) || 1;
      if (freq === "yearly") {
        out.month = parseInt((host.querySelector(".rc-month") || {}).value, 10) || 1;
        out.day = parseInt((host.querySelector(".rc-day") || {}).value, 10) || 1;
      }
      var hours = collectHoursList(host.querySelector(".rc-period-host"), "Hours");
      if (hours.error) return { error: hours.error };
      if (hours.ranges.length) out.hours = hours.ranges;
    }
    var af = (host.querySelector(".rc-active-from") || {}).value;
    var au = (host.querySelector(".rc-active-until") || {}).value;
    if (af) out.activeFrom = af;
    if (au) out.activeUntil = au;
    if (af && au && au < af) return { error: "The date range ends before it starts." };
    return { shape: out };
  }

  window.PolarisRecurrence = {
    weekdays: WEEKDAYS,
    months: MONTHS,
    maxRangesPerDay: MAX_RANGES_PER_DAY,
    summary: summary,
    dayRanges: dayRanges,
    hoursPhrase: hoursPhrase,
    dayEditorHtml: dayEditorHtml,
    hoursListHtml: hoursListHtml,
    collectDayEditor: collectDayEditor,
    collectHoursList: collectHoursList,
    wire: wire,
    refreshSummary: refreshSummary,
    scheduleEditorHtml: scheduleEditorHtml,
    wireScheduleEditor: wireScheduleEditor,
    collectScheduleEditor: collectScheduleEditor,
    syncScheduleBlocks: syncScheduleBlocks,
    rulesEditorHtml: rulesEditorHtml,
    wireRulesEditor: wireRulesEditor,
    collectRulesEditor: collectRulesEditor,
    fillRulesEditor: fillRulesEditor,
    rulesFromShape: rulesFromShape,
  };
})();
