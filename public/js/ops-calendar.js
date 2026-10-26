/**
 * public/js/ops-calendar.js — the operations calendar (window.PolarisOpsCalendar).
 *
 * The Events page's Calendar tab: maintenance windows, reboots and firmware
 * upgrades, booked and past, on one Month / Week / Day / List calendar. It was
 * the Maintenance modal's Calendar tab until the reboot and firmware bookings
 * needed a home that was not about maintenance; the modal now links here.
 *
 * Data: GET /calendar (operationsCalendarService). Every time is a SERVER-LOCAL
 * wall-clock "YYYY-MM-DDTHH:MM" string — the recurrence engine and the
 * schedulers run on the server's clock, so nothing below parses one as an
 * instant: day bucketing is string arithmetic on "YYYY-MM-DD". A kind the
 * caller may not read comes back null and is not offered as a filter.
 *
 * The host passes what a click MEANS (this module only draws):
 *   onItem(item)        — an item was clicked (item.kind, item.raw)
 *   onDay(dayKey, hour) — an empty day / hour was clicked; omit it and empty
 *                         cells are not clickable (the caller cannot create)
 *
 * The markup keeps the `maint-cal-*` classes and ids the styles were written
 * for; one calendar per page.
 */
(function () {
  "use strict";

  var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  /** Pixels per hour in the Week / Day time grid — the CSS row height, mirrored here for click → hour. */
  var HOUR_PX = 28;
  var KINDS = ["maintenance", "reboot", "firmware"];
  var KIND_LABEL = { maintenance: "Maintenance", reboot: "Reboots", firmware: "Firmware" };

  var STATUS_LABEL = {
    pending: "scheduled", started: "started", cancelled: "cancelled", refused: "refused", missed: "missed",
    queued: "starting", running: "running", sending: "sending", rebooting: "rebooting",
    succeeded: "succeeded", failed: "failed", unverified: "unverified",
    completed: "finished", // a group firmware upgrade (rule 122)
  };
  /** Status → the class family that colours it. */
  function statusClass(st) {
    if (st === "succeeded" || st === "completed") return "ok";
    if (st === "failed" || st === "refused" || st === "missed") return "bad";
    if (st === "unverified") return "warn";
    if (st === "cancelled") return "off";
    if (st === "pending") return "pending";
    return "live";
  }

  // ─── State ───────────────────────────────────────────────────────────────
  var opts = {};
  var cursor = null;          // the day the calendar is looking at
  var month = null;           // {y, m} derived from the cursor
  var view = readView();
  var expanded = {};          // day / week keys unfolded past the 3-item fold
  var itemsByKey = {};        // key → item, for the click handler
  var available = {};         // kind → true when the server returned it
  var hiddenKinds = readHidden();
  var renderSeq = 0;

  function readView() {
    try { return viewOf(localStorage.getItem("polaris.opsCalView") || localStorage.getItem("polaris.maintCalView")); } catch (e) { return "month"; }
  }
  function viewOf(v) { return v === "day" || v === "week" || v === "list" ? v : "month"; }
  function readHidden() {
    try {
      var v = JSON.parse(localStorage.getItem("polaris.opsCalHidden") || "[]");
      var out = {};
      (Array.isArray(v) ? v : []).forEach(function (k) { if (KINDS.indexOf(k) >= 0) out[k] = true; });
      return out;
    } catch (e) { return {}; }
  }
  function saveHidden() {
    try { localStorage.setItem("polaris.opsCalHidden", JSON.stringify(Object.keys(hiddenKinds).filter(function (k) { return hiddenKinds[k]; }))); } catch (e) { /* per-browser convenience */ }
  }

  // ─── Day / time helpers (server-local strings, never instants) ──────────
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function dayKey(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function shiftDay(key, delta) {
    var p = key.split("-").map(Number);
    return dayKey(new Date(p[0], p[1] - 1, p[2] + delta));
  }
  function parseLocalIso(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(iso || ""));
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtLocal(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(String(iso || ""));
    if (!m) return String(iso || "");
    return MONTHS[Number(m[2]) - 1] + " " + Number(m[3]) + " " + m[1] + " " + m[4];
  }
  function fmtDate(key) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
    if (!m) return String(key || "");
    return MONTHS[Number(m[2]) - 1] + " " + Number(m[3]) + " " + m[1];
  }

  /**
   * The day keys an item paints on. Windows are half-open, so one ending
   * exactly at midnight (an all-day window, or 22:00 → 00:00) does NOT claim
   * the following day.
   */
  function occurrenceDays(occ) {
    var startDay = String(occ.start).slice(0, 10);
    var endDay = String(occ.end).slice(0, 10);
    if (String(occ.end).slice(11, 16) === "00:00" && endDay > startDay) endDay = shiftDay(endDay, -1);
    var out = [];
    var cur = startDay;
    for (var i = 0; i < 400; i++) {
      out.push(cur);
      if (cur >= endDay) break;
      cur = shiftDay(cur, 1);
    }
    return out;
  }

  /** Chip label for `occ` as seen on day `key`. A point in time (a reboot) reads as its start. */
  function chipTime(occ, key) {
    var startDay = String(occ.start).slice(0, 10);
    var startTime = String(occ.start).slice(11, 16);
    var endTime = String(occ.end).slice(11, 16);
    var endDay = String(occ.end).slice(0, 10);
    if (occ.point) return startTime;
    if (startTime === "00:00" && endTime === "00:00" && endDay > startDay) return "All day";
    if (key !== startDay) return "→ " + endTime;
    if (endDay !== startDay) return startTime + " →";
    return startTime + "–" + endTime;
  }

  /** A day or longer? Those are bars; shorter ones are chips. 23h so a DST night cannot demote a one-day window. */
  function isMultiDay(occ) {
    if (occ.point) return false;
    var a = parseLocalIso(occ.start), b = parseLocalIso(occ.end);
    if (!a || !b) return false;
    return b.getTime() - a.getTime() >= 23 * 3600 * 1000;
  }

  /** "28d 3h" / "4h" / "45m" between two local-ISO minutes. */
  function duration(startIso, endIso) {
    var a = parseLocalIso(startIso), b = parseLocalIso(endIso);
    if (!a || !b) return "";
    var mins = Math.max(0, Math.round((b.getTime() - a.getTime()) / 60000));
    var d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
    if (d) return d + "d" + (h ? " " + h + "h" : "");
    if (h) return h + "h" + (m ? " " + m + "m" : "");
    return m + "m";
  }

  // ─── Items ───────────────────────────────────────────────────────────────

  /** A maintenance occurrence as a calendar item. */
  function maintItem(o, i) {
    return {
      key: "m" + i, kind: "maintenance", name: o.name, start: o.start, end: o.end, point: false,
      cls: (o.enabled ? "" : " maint-cal-chip-off") + (o.adhoc ? " maint-cal-chip-adhoc" : ""),
      attrs: ' data-schedule-id="' + escapeHtml(o.scheduleId) + '"',
      tip: o.name + "\n" + fmtLocal(o.start) + " → " + fmtLocal(o.end) + " (" + duration(o.start, o.end) + ")" +
        (o.adhoc ? "\nAd-hoc window" : "") + (o.enabled ? "" : "\n(disabled)"),
      meta: duration(o.start, o.end) + (o.adhoc ? " · ad-hoc" : "") + (o.enabled ? "" : " · disabled"),
      raw: o,
    };
  }

  /**
   * A reboot or firmware booking / run as a calendar item. Drawn as a point
   * in time (its booked time) while it has not run; a run spans its start to
   * its end, so a long flash reads as long.
   */
  function deviceItem(o, i) {
    var st = String(o.status || "");
    var isRun = !!o.runId && st !== "pending";
    var what = o.kind === "reboot" ? "Reboot" : "Firmware" + (o.toVersion ? " " + o.toVersion : "");
    var stLabel = STATUS_LABEL[st] || st;
    var name = what + " · " + o.assetName;
    var by = o.by ? (String(o.by).indexOf("automation:") === 0 ? "automation “" + String(o.by).slice(11) + "”" : o.by) : "";
    return {
      key: (o.kind === "reboot" ? "r" : "f") + i, kind: o.kind, name: name, start: o.start, end: o.end, point: !isRun,
      cls: " maint-cal-chip-" + o.kind + " maint-cal-st-" + statusClass(st),
      attrs: ' data-kind="' + o.kind + '" data-asset-id="' + escapeHtml(o.assetId) + '"',
      tip: name + "\n" + (o.booked ? "Booked for " : "Started ") + fmtLocal(o.start) +
        (isRun && o.end ? " → " + fmtLocal(o.end) : "") + "\n" + stLabel.charAt(0).toUpperCase() + stLabel.slice(1) +
        (by ? " · " + (o.booked ? "booked by " : "by ") + by : "") + (o.note ? "\nReason: " + o.note : "") + (o.error ? "\n" + o.error : ""),
      meta: stLabel + (by ? " · " + by : ""),
      raw: o,
    };
  }

  /** The response → the items the filters allow, sorted. Pure (exported for the tests). */
  function itemsOf(res, hidden) {
    var out = [];
    (res.maintenance || []).forEach(function (o, i) { if (!hidden.maintenance) out.push(maintItem(o, i)); });
    (res.reboot || []).forEach(function (o, i) { if (!hidden.reboot) out.push(deviceItem(Object.assign({ kind: "reboot" }, o), i)); });
    (res.firmware || []).forEach(function (o, i) { if (!hidden.firmware) out.push(deviceItem(Object.assign({ kind: "firmware" }, o), i)); });
    out.sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : a.name.localeCompare(b.name); });
    return out;
  }

  function itemButton(cls, o, style, inner) {
    return '<button type="button" class="' + cls + o.cls + '"' + (style ? ' style="' + style + '"' : "") +
      ' data-item="' + o.key + '"' + o.attrs + ' title="' + escapeHtml(o.tip) + '">' + inner + "</button>";
  }

  // ─── Shell ───────────────────────────────────────────────────────────────

  function shellHTML() {
    var create = typeof opts.onDay === "function";
    return (
      '<div class="maint-cal">' +
        '<div class="maint-cal-bar">' +
          '<button type="button" class="btn btn-secondary btn-sm" id="maint-cal-prev" aria-label="Previous month">&lsaquo;</button>' +
          '<strong id="maint-cal-title" class="maint-cal-title">…</strong>' +
          '<button type="button" class="btn btn-secondary btn-sm" id="maint-cal-next" aria-label="Next month">&rsaquo;</button>' +
          '<button type="button" class="btn btn-secondary btn-sm" id="maint-cal-today">Today</button>' +
          '<div class="maint-cal-view" role="group" aria-label="View">' +
            ["day", "week", "month", "list"].map(function (v) {
              var on = view === v;
              return '<button type="button" class="btn btn-sm ' + (on ? "btn-primary" : "btn-secondary") + '" data-view="' + v + '" aria-pressed="' + on + '">' +
                v.charAt(0).toUpperCase() + v.slice(1) + "</button>";
            }).join("") +
          "</div>" +
          '<span class="hint maint-cal-hint">Server local time — ' +
            (create ? "click a day to schedule a maintenance window, or an item to open it." : "click an item to open it.") + "</span>" +
        "</div>" +
        '<div class="maint-cal-kinds" id="maint-cal-kinds" role="group" aria-label="Show"></div>' +
        '<div class="maint-cal-dow">' + DOW.map(function (d) { return "<div>" + d + "</div>"; }).join("") + "</div>" +
        '<div id="maint-cal-grid" class="maint-cal-grid"><div class="empty-state" style="grid-column:1/-1">Loading…</div></div>' +
        '<div class="maint-cal-legend">' +
          '<span><i class="maint-cal-key"></i>Maintenance</span>' +
          '<span><i class="maint-cal-key maint-cal-key-adhoc"></i>Ad-hoc window</span>' +
          '<span><i class="maint-cal-key maint-cal-key-reboot"></i>Reboot</span>' +
          '<span><i class="maint-cal-key maint-cal-key-firmware"></i>Firmware upgrade</span>' +
          '<span><i class="maint-cal-key maint-cal-key-bad"></i>Failed / missed / refused</span>' +
          '<span><i class="maint-cal-key maint-cal-key-off"></i>Disabled / cancelled</span>' +
          '<span class="hint maint-cal-legend-note">A window a day or longer is drawn once as a bar across the week; shorter ones are chips on the day they start.</span>' +
        "</div>" +
        '<div id="maint-cal-note" class="hint" style="margin-top:6px"></div>' +
      "</div>"
    );
  }

  function kindsHTML() {
    return KINDS.filter(function (k) { return available[k]; }).map(function (k) {
      return '<label class="maint-cal-kind"><input type="checkbox" data-kind="' + k + '"' + (hiddenKinds[k] ? "" : " checked") + "> " + KIND_LABEL[k] + "</label>";
    }).join("");
  }

  function wire(host) {
    host.querySelector("#maint-cal-prev").addEventListener("click", function () { shift(-1); });
    host.querySelector("#maint-cal-next").addEventListener("click", function () { shift(1); });
    host.querySelector("#maint-cal-today").addEventListener("click", function () {
      var now = new Date();
      cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      render();
    });
    var viewEl = host.querySelector(".maint-cal-view");
    viewEl.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("[data-view]") : null;
      if (!b) return;
      view = viewOf(b.getAttribute("data-view"));
      try { localStorage.setItem("polaris.opsCalView", view); } catch (err) { /* per-browser convenience only */ }
      viewEl.querySelectorAll("[data-view]").forEach(function (x) {
        var on = x.getAttribute("data-view") === view;
        x.setAttribute("aria-pressed", String(on));
        x.classList.toggle("btn-primary", on);
        x.classList.toggle("btn-secondary", !on);
      });
      render();
    });
    host.querySelector("#maint-cal-kinds").addEventListener("change", function (e) {
      var k = e.target && e.target.getAttribute ? e.target.getAttribute("data-kind") : null;
      if (!k) return;
      hiddenKinds[k] = !e.target.checked;
      saveHidden();
      render();
    });
    host.querySelector("#maint-cal-grid").addEventListener("click", function (e) {
      var more = e.target.closest ? e.target.closest(".maint-cal-more") : null;
      if (more) {
        expanded[more.getAttribute("data-week") || more.getAttribute("data-day")] = true;
        render();
        return;
      }
      var chip = e.target.closest ? e.target.closest("[data-item]") : null;
      if (chip) {
        var item = itemsByKey[chip.getAttribute("data-item")];
        if (item && typeof opts.onItem === "function") opts.onItem(item);
        return;
      }
      if (typeof opts.onDay !== "function") return;
      var col = e.target.closest ? e.target.closest(".maint-cal-time-col") : null;
      if (col) {
        var hour;
        var rect = col.getBoundingClientRect ? col.getBoundingClientRect() : null;
        if (rect && rect.height > 0 && typeof e.clientY === "number") hour = (e.clientY - rect.top) / HOUR_PX;
        opts.onDay(col.getAttribute("data-day"), hour);
        return;
      }
      var cell = e.target.closest ? e.target.closest(".maint-cal-day") : null;
      if (cell) opts.onDay(cell.getAttribute("data-day"));
    });
  }

  /** Previous / Next move by the unit the view shows: a day, a week, or a month. */
  function shift(delta) {
    var c = cursor;
    if (view === "day") c = new Date(c.getFullYear(), c.getMonth(), c.getDate() + delta);
    else if (view === "week") c = new Date(c.getFullYear(), c.getMonth(), c.getDate() + 7 * delta);
    else c = new Date(c.getFullYear(), c.getMonth() + delta, 1);   // keeps the 1st, so Jan 31 → Feb does not skip to March
    cursor = c;
    expanded = {};
    render();
  }

  /** Title: "Aug 2026", "Aug 9 – 15, 2026", "Aug 30 – Sep 5, 2026", "Wed Aug 12 2026". */
  function title(gridStart, gridEnd) {
    if (view === "day") return DOW[gridStart.getDay()] + " " + MONTHS[gridStart.getMonth()] + " " + gridStart.getDate() + " " + gridStart.getFullYear();
    if (view === "week") {
      var a = MONTHS[gridStart.getMonth()] + " " + gridStart.getDate();
      var b = (gridStart.getMonth() === gridEnd.getMonth() ? "" : MONTHS[gridEnd.getMonth()] + " ") + gridEnd.getDate();
      return a + " – " + b + ", " + gridEnd.getFullYear();
    }
    return MONTHS[month.m] + " " + month.y;
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  async function render() {
    var grid = document.getElementById("maint-cal-grid");
    var titleEl = document.getElementById("maint-cal-title");
    var noteEl = document.getElementById("maint-cal-note");
    if (!grid || !cursor) return;
    var seq = ++renderSeq;
    month = { y: cursor.getFullYear(), m: cursor.getMonth() };

    var first = new Date(month.y, month.m, 1);
    var gridStart = new Date(month.y, month.m, 1 - first.getDay());   // the Sunday on/before the 1st
    var daysInMonth = new Date(month.y, month.m + 1, 0).getDate();
    var cells = Math.ceil((first.getDay() + daysInMonth) / 7) * 7;
    var gridEnd = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + cells - 1);
    var dayCols = 0;
    if (view === "week") {
      gridStart = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - cursor.getDay());
      gridEnd = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + 6);
      dayCols = 7;
    } else if (view === "day") {
      gridStart = cursor;
      gridEnd = cursor;
      dayCols = 1;
    }
    titleEl.textContent = title(gridStart, gridEnd);
    var unit = view === "day" ? "day" : view === "week" ? "week" : "month";
    var prevEl = document.getElementById("maint-cal-prev"), nextEl = document.getElementById("maint-cal-next");
    if (prevEl) prevEl.setAttribute("aria-label", "Previous " + unit);
    if (nextEl) nextEl.setAttribute("aria-label", "Next " + unit);
    var noteHint = document.querySelector(".maint-cal-legend-note");
    if (noteHint) noteHint.textContent = dayCols
      ? "Windows a day or longer sit in the all-day band; shorter ones are blocks at their hours." + (opts.onDay ? " Click an empty hour to schedule a maintenance window there." : "")
      : "A window a day or longer is drawn once as a bar across the week; shorter ones are chips on the day they start.";

    var res;
    try {
      res = await api.calendar.get(dayKey(gridStart), dayKey(gridEnd));
    } catch (err) {
      if (seq !== renderSeq) return;
      grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">' +
        escapeHtml(err && err.message ? err.message : "Failed to load the calendar") + "</div>";
      return;
    }
    if (seq !== renderSeq) return;   // a later navigation already asked again
    KINDS.forEach(function (k) { available[k] = Array.isArray(res[k]); });
    var kindsEl = document.getElementById("maint-cal-kinds");
    if (kindsEl) kindsEl.innerHTML = kindsHTML();
    noteEl.textContent = res.truncated ? "Too many items to show them all here — some are omitted." : "";

    var all = itemsOf(res, hiddenKinds);
    itemsByKey = {};
    all.forEach(function (o) { itemsByKey[o.key] = o; });

    var dowEl = document.querySelector(".maint-cal-dow");
    grid.classList.toggle("maint-cal-grid-list", view === "list");
    grid.classList.toggle("maint-cal-grid-time", !!dayCols);
    if (view === "list") {
      if (dowEl) dowEl.style.display = "none";
      grid.innerHTML = listHTML(all);
      return;
    }
    if (dayCols) {
      if (dowEl) dowEl.style.display = "none";
      grid.innerHTML = timeGridHTML(all, gridStart, dayCols);
      var scroller = grid.querySelector(".maint-cal-time-scroll");
      if (scroller) scroller.scrollTop = Math.round(6 * HOUR_PX);   // open on the working day, not midnight
      return;
    }
    if (dowEl) dowEl.style.display = "";
    grid.innerHTML = monthHTML(all, gridStart, gridEnd, cells);
  }

  /**
   * Month grid. TWO shapes: a TIMED item — anything shorter than a day, an
   * overnight 22:00 → 02:00 included, and every reboot / firmware point — is
   * ONE chip on the day it starts; a window a day or longer is a BAR spanning
   * the week row, once, the way a calendar draws an all-day event.
   */
  function monthHTML(all, gridStart, gridEnd, cells) {
    var todayKey = dayKey(new Date());
    var weeks = cells / 7;
    var chipsByDay = {};
    var barsByWeek = [];
    for (var w = 0; w < weeks; w++) barsByWeek.push([]);
    var weekIndexOf = function (key) {
      var p = key.split("-").map(Number);
      var d = new Date(p[0], p[1] - 1, p[2]);
      return Math.floor(Math.round((d.getTime() - gridStart.getTime()) / 86400000) / 7);
    };
    var firstKey = dayKey(gridStart), lastKey = dayKey(gridEnd);
    all.forEach(function (occ) {
      var days = occurrenceDays(occ);
      if (!isMultiDay(occ)) {
        (chipsByDay[days[0]] = chipsByDay[days[0]] || []).push(occ);
        return;
      }
      var inGrid = days.filter(function (k) { return k >= firstKey && k <= lastKey; });
      if (!inGrid.length) return;
      var byWeek = {};
      inGrid.forEach(function (k) { var wi = weekIndexOf(k); (byWeek[wi] = byWeek[wi] || []).push(k); });
      Object.keys(byWeek).forEach(function (wi) {
        var ks = byWeek[wi];
        var p0 = ks[0].split("-").map(Number);
        barsByWeek[Number(wi)].push({
          occ: occ, col: new Date(p0[0], p0[1] - 1, p0[2]).getDay() + 1, span: ks.length,
          fromBefore: ks[0] !== days[0], toAfter: ks[ks.length - 1] !== days[days.length - 1],
        });
      });
    });

    var dayTitle = opts.onDay ? function (key) { return "Click to schedule a maintenance window on " + fmtDate(key); } : function () { return ""; };
    var html = "";
    for (var w2 = 0; w2 < weeks; w2++) {
      var lanes = [];
      var placed = barsByWeek[w2].map(function (b) {
        var lane = 0;
        for (; lane < lanes.length; lane++) {
          var clash = lanes[lane].some(function (o) { return b.col < o.col + o.span && o.col < b.col + b.span; });
          if (!clash) break;
        }
        (lanes[lane] = lanes[lane] || []).push(b);
        return { bar: b, lane: lane };
      });
      var weekKey = "w" + w2;
      var maxLanes = expanded[weekKey] ? lanes.length : Math.min(lanes.length, 3);
      var hidden = placed.filter(function (p) { return p.lane >= maxLanes; }).length;
      var laneHtml = placed.filter(function (p) { return p.lane < maxLanes; }).map(function (p) {
        var o = p.bar.occ;
        var startT = String(o.start).slice(11, 16), endT = String(o.end).slice(11, 16);
        var edge = ((p.bar.fromBefore ? "" : startT + " ") + (p.bar.toAfter ? "" : "→ " + endT + " ")).trim();
        return itemButton("maint-cal-span" + (p.bar.fromBefore ? " maint-cal-span-from" : "") + (p.bar.toAfter ? " maint-cal-span-to" : ""), o,
          "grid-column:" + p.bar.col + " / span " + p.bar.span + ";grid-row:" + (p.lane + 1),
          (edge ? '<span class="maint-cal-chip-time">' + escapeHtml(edge) + "</span> " : "") + escapeHtml(o.name));
      }).join("");
      if (hidden) {
        laneHtml += '<button type="button" class="maint-cal-more maint-cal-more-week" style="grid-column:1 / -1;grid-row:' + (maxLanes + 1) + '" data-week="' + weekKey + '">+' + hidden + " more window" + (hidden === 1 ? "" : "s") + "</button>";
      }
      var cellsHtml = "";
      for (var c = 0; c < 7; c++) {
        var d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + w2 * 7 + c);
        var key = dayKey(d);
        var occs = chipsByDay[key] || [];
        var shown = expanded[key] ? occs : occs.slice(0, 3);
        var chips = shown.map(function (occ) {
          return itemButton("maint-cal-chip", occ, "", '<span class="maint-cal-chip-time">' + escapeHtml(chipTime(occ, key)) + "</span> " + escapeHtml(occ.name));
        }).join("");
        if (!expanded[key] && occs.length > shown.length) {
          chips += '<button type="button" class="maint-cal-more" data-day="' + key + '">+' + (occs.length - shown.length) + " more</button>";
        }
        var t = dayTitle(key);
        cellsHtml += '<div class="maint-cal-day' + (d.getMonth() !== month.m ? " maint-cal-day-out" : "") +
          (key === todayKey ? " maint-cal-day-today" : "") + (opts.onDay ? "" : " maint-cal-day-ro") + '" data-day="' + key + '"' +
          (t ? ' title="' + escapeHtml(t) + '"' : "") + ">" +
          '<div class="maint-cal-daynum">' + d.getDate() + "</div>" +
          '<div class="maint-cal-chips">' + chips + "</div>" +
          "</div>";
      }
      html += '<div class="maint-cal-week">' +
        (laneHtml ? '<div class="maint-cal-lanes">' + laneHtml + "</div>" : "") +
        '<div class="maint-cal-days">' + cellsHtml + "</div>" +
      "</div>";
    }
    return html;
  }

  /**
   * Week / Day view: hours down the side, one column per day, each timed item
   * a block at its hours (an overnight window is two blocks), windows a day or
   * longer in an all-day band above the hours.
   */
  function timeGridHTML(all, gridStart, dayCols) {
    var todayKey = dayKey(new Date());
    var days = [];
    for (var i = 0; i < dayCols; i++) {
      var d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      days.push({ d: d, key: dayKey(d) });
    }
    var firstKey = days[0].key, lastKey = days[days.length - 1].key;
    var colTemplate = "3.2rem repeat(" + dayCols + ", minmax(0, 1fr))";

    var bars = [];
    all.forEach(function (occ) {
      if (!isMultiDay(occ)) return;
      var occDays = occurrenceDays(occ);
      var inGrid = occDays.filter(function (k) { return k >= firstKey && k <= lastKey; });
      if (!inGrid.length) return;
      var col = days.findIndex(function (x) { return x.key === inGrid[0]; }) + 1;
      bars.push({ occ: occ, col: col, span: inGrid.length, fromBefore: inGrid[0] !== occDays[0], toAfter: inGrid[inGrid.length - 1] !== occDays[occDays.length - 1] });
    });
    var lanes = [];
    var barHtml = bars.map(function (b) {
      var lane = 0;
      for (; lane < lanes.length; lane++) {
        var clash = lanes[lane].some(function (o) { return b.col < o.col + o.span && o.col < b.col + b.span; });
        if (!clash) break;
      }
      (lanes[lane] = lanes[lane] || []).push(b);
      var o = b.occ;
      var startT = String(o.start).slice(11, 16), endT = String(o.end).slice(11, 16);
      var edge = ((b.fromBefore ? "" : startT + " ") + (b.toAfter ? "" : "→ " + endT)).trim();
      return itemButton("maint-cal-span" + (b.fromBefore ? " maint-cal-span-from" : "") + (b.toAfter ? " maint-cal-span-to" : ""), o,
        "grid-column:" + b.col + " / span " + b.span + ";grid-row:" + (lane + 1),
        (edge ? '<span class="maint-cal-chip-time">' + escapeHtml(edge) + "</span> " : "") + escapeHtml(o.name));
    }).join("");

    var blocksByDay = {};
    all.forEach(function (occ) {
      if (isMultiDay(occ)) return;
      var a = parseLocalIso(occ.start), b = parseLocalIso(occ.end);
      if (!a || !b) return;
      occurrenceDays(occ).forEach(function (k) {
        if (k < firstKey || k > lastKey) return;
        var p = k.split("-").map(Number);
        var dayStart = new Date(p[0], p[1] - 1, p[2]).getTime();
        var from = Math.max(0, (a.getTime() - dayStart) / 60000);
        var to = Math.min(1440, (b.getTime() - dayStart) / 60000);
        if (to <= from) return;
        (blocksByDay[k] = blocksByDay[k] || []).push({ occ: occ, from: from, to: to, cont: a.getTime() < dayStart, runs: b.getTime() > dayStart + 86400000 });
      });
    });

    var now = new Date();
    var nowMin = now.getHours() * 60 + now.getMinutes();
    var hourLabels = "";
    for (var h = 0; h < 24; h++) hourLabels += '<div class="maint-cal-hour">' + (h ? pad(h) + ":00" : "") + "</div>";
    var head = '<div class="maint-cal-time-head" style="grid-template-columns:' + colTemplate + '"><div></div>' +
      days.map(function (x) {
        return '<div class="maint-cal-time-dayhead' + (x.key === todayKey ? " maint-cal-day-today" : "") + '">' +
          '<span class="maint-cal-time-dow">' + DOW[x.d.getDay()] + '</span> <span class="maint-cal-time-daynum">' + x.d.getDate() + "</span></div>";
      }).join("") + "</div>";
    var band = barHtml
      ? '<div class="maint-cal-time-band" style="grid-template-columns:' + colTemplate + '"><div class="maint-cal-hour">all day</div>' +
        '<div class="maint-cal-lanes" style="grid-template-columns:repeat(' + dayCols + ', minmax(0, 1fr))">' + barHtml + "</div></div>"
      : "";
    var cols = days.map(function (x) {
      var blocks = (blocksByDay[x.key] || []).sort(function (p, q) { return p.from - q.from || p.to - q.to; });
      var ends = [];
      blocks.forEach(function (blk) {
        var lane = ends.findIndex(function (e) { return e <= blk.from; });
        if (lane < 0) { lane = ends.length; ends.push(blk.to); } else ends[lane] = blk.to;
        blk.lane = lane;
      });
      var nLanes = Math.max(1, ends.length);
      var inner = blocks.map(function (blk) {
        var o = blk.occ;
        var top = (blk.from / 60) * HOUR_PX, height = Math.max(14, ((blk.to - blk.from) / 60) * HOUR_PX - 2);
        var label = o.point
          ? String(o.start).slice(11, 16)
          : pad(Math.floor(blk.from / 60)) + ":" + pad(Math.round(blk.from % 60)) + "–" +
            (blk.to >= 1440 ? "00:00" : pad(Math.floor(blk.to / 60)) + ":" + pad(Math.round(blk.to % 60)));
        return itemButton("maint-cal-block" + (blk.cont ? " maint-cal-block-cont" : "") + (blk.runs ? " maint-cal-block-runs" : ""), o,
          "top:" + top + "px;height:" + height + "px;left:" + (blk.lane * 100 / nLanes) + "%;width:calc(" + (100 / nLanes) + "% - 2px)",
          '<span class="maint-cal-chip-time">' + label + "</span> " + escapeHtml(o.name));
      }).join("");
      var nowLine = x.key === todayKey ? '<div class="maint-cal-nowline" style="top:' + ((nowMin / 60) * HOUR_PX) + 'px"></div>' : "";
      return '<div class="maint-cal-time-col' + (x.key === todayKey ? " maint-cal-time-col-today" : "") + '" data-day="' + x.key + '"' +
        (opts.onDay ? ' title="' + escapeHtml("Click an hour to schedule a maintenance window on " + fmtDate(x.key)) + '"' : "") + ">" + inner + nowLine + "</div>";
    }).join("");
    var body = '<div class="maint-cal-time-scroll"><div class="maint-cal-time-body" style="grid-template-columns:' + colTemplate + ";height:" + (24 * HOUR_PX) + 'px">' +
      '<div class="maint-cal-hours">' + hourLabels + "</div>" + cols + "</div></div>";
    return '<div class="maint-cal-time">' + head + band + body + "</div>";
  }

  /**
   * The List view: the same items as readable rows, grouped by the day they
   * start. Windows already running when the month opens sit first — "what is
   * in maintenance right now" is the first question the view answers.
   */
  function listHTML(all) {
    var monthFirst = dayKey(new Date(month.y, month.m, 1));
    var monthLast = dayKey(new Date(month.y, month.m + 1, 0));
    var inMonth = all.filter(function (o) {
      var days = occurrenceDays(o);
      return days[days.length - 1] >= monthFirst && days[0] <= monthLast;
    });
    if (!inMonth.length) return '<div class="empty-state">Nothing on the calendar this month.</div>';
    var groups = [];
    var running = inMonth.filter(function (o) { return String(o.start).slice(0, 10) < monthFirst; });
    if (running.length) groups.push({ label: "Already running when the month opens", items: running });
    var byDay = {};
    inMonth.forEach(function (o) {
      var k = String(o.start).slice(0, 10);
      if (k < monthFirst) return;
      (byDay[k] = byDay[k] || []).push(o);
    });
    Object.keys(byDay).sort().forEach(function (k) { groups.push({ label: fmtDate(k), key: k, items: byDay[k] }); });
    var todayKey = dayKey(new Date());
    return groups.map(function (g) {
      var rows = g.items.map(function (o) {
        var when = o.point
          ? String(o.start).slice(11, 16)
          : !isMultiDay(o)
            ? String(o.start).slice(11, 16) + " – " + String(o.end).slice(11, 16)
            : fmtLocal(o.start) + " → " + fmtLocal(o.end);
        return itemButton("maint-cal-row", o, "",
          '<span class="maint-cal-row-when">' + escapeHtml(when) + "</span>" +
          '<span class="maint-cal-row-name">' + escapeHtml(o.name) + "</span>" +
          '<span class="maint-cal-row-meta">' + escapeHtml(o.meta) + "</span>");
      }).join("");
      return '<section class="maint-cal-group' + (g.key === todayKey ? " maint-cal-group-today" : "") + '">' +
        '<h4 class="maint-cal-group-title">' + escapeHtml(g.label) + (g.key === todayKey ? ' <span class="badge badge-active">today</span>' : "") + "</h4>" +
        rows + "</section>";
    }).join("");
  }

  // ─── Public ──────────────────────────────────────────────────────────────

  /** Draw the calendar into `host`. Call once per page; `refresh()` re-reads. */
  function mount(host, o) {
    opts = o || {};
    expanded = {};
    var today = new Date();
    cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    month = { y: cursor.getFullYear(), m: cursor.getMonth() };
    host.innerHTML = shellHTML();
    wire(host);
    return render();
  }

  window.PolarisOpsCalendar = {
    mount: mount,
    refresh: function () { return render(); },
    // Pure internals, exported for the tests (day bucketing has the edge cases).
    _occurrenceDays: occurrenceDays,
    _chipTime: chipTime,
    _itemsOf: itemsOf,
    _statusClass: statusClass,
  };
})();
