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
  };
})();
