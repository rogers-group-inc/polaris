/**
 * widgets/maintenanceSchedules.js — ACTIVE MAINTENANCE. One row per
 * maintenance schedule currently in effect: what it is holding, which kinds of
 * device, and when the window expires. Data from /dashboard/noc-summary
 * maintenanceSchedules[].
 *
 * Why it exists: every other NOC widget deliberately EXCLUDES assets in
 * maintenance (nocDashboardService's NOT_IN_MAINTENANCE — a planned window is
 * not an outage), so a board built from them says nothing at all about the
 * devices that are down on purpose. This is the widget that does, and the
 * question it answers is "when does this come back?".
 *
 * The filter is the shared NOC one (regions / asset types / FortiGates) with
 * one deliberate difference from every other widget (business rule 72): **a
 * schedule matches when ANY of its devices does, and is then shown WHOLE.** A window covering
 * switches, APs and servers is still the thing a switch-scoped dashboard needs
 * to know about, so the row counts every device in it and names every type —
 * narrowing the row to the matching devices would report a smaller maintenance
 * than the one actually running. `matchedCount` (server-side) is what makes
 * the "n of m in this scope" note honest instead.
 *
 * Times are SERVER-LOCAL wall clock. The recurrence engine evaluates schedules
 * against the Polaris server's clock, so the feed sends both the wall-clock
 * string (what the operator must SEE — re-rendering it in the viewer's zone
 * paints the window on the wrong hour) and the true instant, which is the only
 * form the "ends in 40m" countdown can be computed from. Never derive one from
 * the other here.
 */

(function () {
  var DEFAULT_ROWS = 10;
  // A window inside this much of its end is the one an operator is waiting on.
  var ENDING_SOON_MS = 30 * 60 * 1000;
  // nocDashboardService.NOC_FEED_CACHE_TTL_MS (10s) plus a second of slack —
  // how long the server may keep answering with a payload computed before a
  // write this widget just made. Only the post-create settle refresh uses it.
  var SERVER_FEED_TTL_MS = 11000;

  function endsAtMs(r) {
    if (!r || !r.endsAtUtc) return null;
    var t = new Date(r.endsAtUtc).getTime();
    return isNaN(t) ? null : t;
  }

  // "2h 14m" / "18m" / "under a minute" — how long until the window expires.
  // Null when the feed sent no end (a schedule whose windows are still open
  // past their occurrence, i.e. the up-to-30s reconcile closing lag).
  function remaining(r) {
    var end = endsAtMs(r);
    if (end == null) return null;
    var ms = end - Date.now();
    if (ms <= 0) return "ending";
    var mins = Math.floor(ms / 60000);
    if (mins < 1) return "under a minute";
    if (mins < 60) return mins + "m";
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    if (h < 24) return h + "h" + (m ? " " + m + "m" : "");
    var d = Math.floor(h / 24);
    return d + "d" + (h % 24 ? " " + (h % 24) + "h" : "");
  }

  // "Sep 18, 18:00" from the server's own wall-clock string — parsed as DIGITS,
  // never as an instant, so the browser's zone can't move it.
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function wallClock(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(String(s || ""));
    if (!m) return null;
    return MONTHS[Number(m[2]) - 1] + " " + Number(m[3]) + ", " + m[4];
  }

  function typeSummary(r) {
    var types = (r && r.assetTypes) || [];
    if (!types.length) return "";
    return types.map(function (t) {
      return PolarisWidgets.assetTypeLabel(t.assetType) + " " + t.count;
    }).join(", ");
  }

  var CMP = PolarisWidgets.sortCmp;
  // options[0] is the feed's own order (soonest to end first) — a dashboard
  // saved before this control keeps behaving exactly as it did.
  var SORTS = [
    { key: "ending", label: "Ending soonest first", cmp: CMP.low(endsAtMs) },
    { key: "longest", label: "Ending last first", cmp: CMP.high(endsAtMs) },
    { key: "devices", label: "Most devices first", cmp: CMP.high(function (r) { return r.deviceCount; }) },
    { key: "name", label: "Name A–Z", cmp: CMP.text(function (r) { return r.name; }) },
  ];

  function rowHTML(r) {
    var ends = wallClock(r.endsAt);
    var left = remaining(r);
    var end = endsAtMs(r);
    var soon = end != null && end - Date.now() <= ENDING_SOON_MS;
    var devices = r.deviceCount + (r.deviceCount === 1 ? " device" : " devices");
    // What the filter actually claimed, when it claimed only part of the
    // schedule. Without it a region-scoped board reads "40 devices" about a
    // window that has four of its own.
    var scope = (r.filtered && r.matchedCount > 0)
      ? " (" + r.matchedCount + " in this scope)"
      : "";
    var types = typeSummary(r);
    // ONE flex item, not three: `.recent-item-meta` is `display:flex; gap:12px`,
    // so every element and text run inside it becomes a flex item and gets 12px
    // of gap around it — which tore "4 devices (2 in this scope) · Switch 2"
    // into three drifting fragments. Everything the line says is one span.
    var meta = "<span>" + escapeHtml(devices + scope + (types ? " · " + types : "")) + "</span>";
    // The recurring/one-time distinction changes what "expires" means — a
    // recurring window comes back tomorrow, a one-time one is over.
    var kind = r.adhoc ? "ad-hoc" : (r.kind === "recurring" ? "recurring" : "one-time");
    var kindPill = '<span class="widget-pill widget-pill-neutral" style="margin-right:6px">' + kind + "</span>";
    var timeCell = ends
      ? '<span class="widget-pill ' + (soon ? "widget-pill-amber" : "widget-pill-watch") + '"' +
        ' title="' + escapeHtml("Window ends " + ends + " (Polaris server time)") + '">' +
        escapeHtml(ends) + "</span>" +
        (left ? '<div class="recent-item-meta" style="text-align:right">' + escapeHtml(left) + "</div>" : "")
      : '<span class="recent-item-time" title="This schedule&#39;s window has ended — its devices leave maintenance on the next reconcile">ending</span>';
    // A div, not a link: the row's verbs are a menu (review / disable), and
    // there is no URL that opens one schedule.
    return '<div class="recent-item' + (window.POLARIS_DASH_LOCAL ? "" : " recent-item-link") + '"' +
      ' data-schedule-id="' + escapeHtml(r.id || "") + '">' +
      '<div style="min-width:0">' +
        '<div class="recent-item-title">' + kindPill + "<span>" + escapeHtml(r.name || "(unnamed)") + "</span></div>" +
        '<div class="recent-item-meta">' + meta + "</div>" +
      "</div>" +
      '<div style="text-align:right;white-space:nowrap">' + timeCell + "</div>" +
    "</div>";
  }

  /**
   * May this viewer create a schedule from here? The same three conditions the
   * row verbs check: a real dashboard shell (not a library preview), a page
   * carrying the maintenance modal, and the level that modal's Save needs.
   * A button that opens an editor whose every save 403s is worse than no
   * button — the route stays the control either way.
   */
  function canCreate(el) {
    if (window.POLARIS_DASH_LOCAL) return false;
    if (!el || !el.closest || !el.closest(".dashboard-widget")) return false;
    if (typeof window.openMaintenanceModal !== "function") return false;
    return typeof window.canManageMaintenance === "function" && window.canManageMaintenance();
  }

  // The top bar. Rendered over the list AND over the empty state — an empty
  // widget is exactly when an operator wants to schedule something, and it is
  // the only affordance this widget has that does not need a row to click.
  function topBarHTML(el) {
    if (!canCreate(el)) return "";
    return '<div class="maint-widget-bar">' +
      '<button type="button" class="btn btn-secondary btn-sm" data-maint-new ' +
      'title="Create a maintenance schedule — opens the Maintenance editor">+ New schedule</button>' +
    "</div>";
  }

  function render(el, rows, config) {
    rows = (rows || []).slice();
    rows = PolarisWidgets.applySort(rows, SORTS, config);
    PolarisWidgets.setHeaderSort(el, { options: SORTS, config: config });
    PolarisWidgets.setHeaderExport(el, {
      filename: "active-maintenance",
      columns: [
        { header: "Schedule", get: function (r) { return r.name || ""; } },
        { header: "Kind", get: function (r) { return r.adhoc ? "ad-hoc" : r.kind; } },
        { header: "Devices", get: function (r) { return String(r.deviceCount); } },
        { header: "Asset Types", get: typeSummary },
        // The server's wall clock, as sent — an ISO conversion here would
        // restate it in the exporter's zone and lose the point.
        { header: "Started (server time)", get: function (r) { return r.startedAt || ""; } },
        { header: "Ends (server time)", get: function (r) { return r.endsAt || ""; } },
        { header: "Dependents", get: function (r) { return r.suppressChildren === false ? "Unaffected" : "Marked down"; } },
      ],
      rows: rows,
    });
    var displayed = PolarisWidgets.clip(rows, config && config.rowLimit != null ? config.rowLimit : DEFAULT_ROWS);
    // Count pill: schedules on screen, deliberately NEUTRAL (business rule 72
    // — planned work is never reported in the vocabulary of an outage).
    // setHeaderCount's
    // fallback is red, which is the generic "these are down" colour — and a red
    // count over planned work is the one thing this widget must not say. Every
    // other widget's red count means someone should do something; here nobody
    // should. The rows carry no alert severity either, so there is nothing for
    // the severity palette to agree with.
    PolarisWidgets.setHeaderPills(el, displayed.length
      ? [{ text: displayed.length, className: "widget-pill-neutral", title: "Maintenance windows open now" }]
      : []);
    var bar = topBarHTML(el);
    if (!displayed.length) {
      el.innerHTML = bar + '<p class="empty-state">No maintenance windows are open</p>';
      return;
    }
    var note = rows.length > displayed.length
      ? '<p class="widget-overflow-note">' +
        escapeHtml("Showing " + displayed.length + " of " + rows.length + " open windows — raise Row limit to see the rest.") +
        "</p>"
      : "";
    el.innerHTML = bar + displayed.map(rowHTML).join("") + note;
  }

  function fetchRows(config) {
    return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["maintenanceSchedules"])
      .then(function (d) { return (d && d.maintenanceSchedules) || []; })
      .catch(function () { return []; });
  }

  /**
   * The row's verbs. Review opens the Maintenance modal on that schedule;
   * Disable ends its open windows immediately (the server reconciles inline)
   * and restores every held device's status.
   *
   * Both go quiet where the click cannot work — the /dash wallboard loads
   * neither app.js nor the maintenance modal, and a role below
   * maintenanceManagement:fullwrite cannot open the editor or save. A row left
   * with no verb does nothing rather than opening an empty menu.
   */
  function openScheduleRow(anchor, row, onChanged) {
    var dialogs = typeof window.showRowMenu === "function" && !window.POLARIS_DASH_LOCAL;
    var mayManage = typeof window.canManageMaintenance === "function" && window.canManageMaintenance();
    if (!dialogs || !mayManage) return false;
    var items = [];
    if (typeof window.openMaintenanceModal === "function") {
      items.push({
        label: "Open schedule…",
        title: "Review this maintenance schedule — its filter, targets and window",
        onSelect: function () { window.openMaintenanceModal({ scheduleId: row.id }); },
      });
    }
    if (typeof window.maintSetScheduleEnabled === "function" && typeof window.showConfirm === "function") {
      items.push({
        label: "Disable schedule",
        title: "End this window now — held devices leave maintenance and resume polling",
        danger: true,
        onSelect: function () { disableSchedule(row, onChanged); },
      });
    }
    if (!items.length) return false;
    window.showRowMenu(anchor, items, { label: "Maintenance schedule actions" });
    return true;
  }

  /**
   * Run `fn` once the shared modal overlay closes. `closeModal` fires no event
   * and `openMaintenanceModal` resolves when the dialog is BUILT, not when the
   * operator is done with it, so the close is observed rather than awaited.
   * The observer disconnects itself; a modal that never opened (a page without
   * the overlay) calls back immediately rather than leaving a watcher behind.
   */
  function afterModalClose(fn) {
    var overlay = document.getElementById("modal-overlay");
    if (!overlay || typeof window.MutationObserver !== "function") { fn(); return; }
    var seenOpen = overlay.classList.contains("open");
    var obs = new window.MutationObserver(function () {
      var open = overlay.classList.contains("open");
      if (open) { seenOpen = true; return; }
      if (!seenOpen) return;
      obs.disconnect();
      fn();
    });
    obs.observe(overlay, { attributes: true, attributeFilter: ["class"] });
  }

  function disableSchedule(row, onChanged) {
    window.showConfirm(
      'Disable maintenance schedule "' + (row.name || "") + '"? Its open windows end immediately, ' +
      "held devices leave maintenance and resume polling. It stops firing until it is re-enabled."
    ).then(function (ok) {
      if (!ok) return;
      return window.maintSetScheduleEnabled(row.id, false).then(function () {
        if (typeof window.showToast === "function") window.showToast("Schedule disabled");
        onChanged(row.id);
      });
    }).catch(function (err) {
      if (typeof window.showToast === "function") {
        window.showToast((err && err.message) || "Couldn't disable the schedule", "error");
      }
    });
  }

  PolarisWidgets.register({
    type: "maintenanceSchedules",
    category: "Monitoring",
    label: "Active Maintenance",
    description: "Maintenance schedules in effect right now, with the devices they hold and when each window expires.",
    defaultSize: { width: 4, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: { rowLimit: DEFAULT_ROWS, regionScope: "mine", sortBy: SORTS[0].key },
    // The feed reads MaintenanceSchedule + open window rows, which assets:read
    // has no claim on — same key the Maintenance modal and its routes use. A
    // role without it gets an empty widget, never a 403.
    requiredPermission: { key: "maintenanceManagement", level: "read" },

    fetchData: fetchRows,

    renderInstance: function (el, config, data, ctx) {
      // Schedules disabled FROM THIS WIDGET, held over every later paint until
      // the feed agrees. getNocSummary memoizes 15s client-side on top of the
      // route's 10s TTL, so without this a disabled schedule comes straight
      // back and reads as a click that did nothing. It only ever REMOVES a
      // row, never invents one.
      var dropped = {};
      var latest = data;
      var settleTimer = null;
      var visible = function () {
        return (latest || []).filter(function (r) { return !dropped[r.id]; });
      };
      var paint = function () { render(el, visible(), config); };
      var refresh = function () {
        return fetchRows(config).then(function (d) { latest = d; paint(); }).catch(function () {});
      };
      paint();
      var onClick = function (ev) {
        if (ev.defaultPrevented || ev.button === 1 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
        if (ev.target.closest("[data-maint-new]")) {
          ev.preventDefault();
          window.openMaintenanceModal({});
          // Refresh when the operator closes the editor, not on a timer: a
          // schedule created in there may already be in its window, and the
          // widget claiming not to know about it is how a create reads as a
          // failure. The memo is dropped first or the refetch is served the
          // answer from before the write.
          afterModalClose(function () {
            if (PolarisWidgets.invalidateNocSummary) PolarisWidgets.invalidateNocSummary();
            refresh();
            // …and once more past the SERVER's own 10s per-feed cache, which
            // the client memo drop cannot reach: a schedule created seconds
            // ago is invisible to a refetch served from a payload computed
            // before it existed. Without this the new row waits out the 30s
            // timer, which reads as the create having done nothing.
            if (settleTimer) clearTimeout(settleTimer);
            settleTimer = setTimeout(function () {
              if (PolarisWidgets.invalidateNocSummary) PolarisWidgets.invalidateNocSummary();
              refresh();
            }, SERVER_FEED_TTL_MS);
          });
          return;
        }
        var item = ev.target.closest(".recent-item[data-schedule-id]");
        if (!item || !el.contains(item)) return;
        var id = item.getAttribute("data-schedule-id");
        var row = (latest || []).find(function (r) { return r.id === id; });
        if (!row) return;
        ev.preventDefault();
        openScheduleRow(item, row, function (disabledId) {
          dropped[disabledId] = true;
          paint();
          refresh();
        });
      };
      el.addEventListener("click", onClick);
      // `normal`: a window's end is minutes away at the closest, and the
      // countdown is re-derived on every paint from the instant the feed sent.
      var timer = setInterval(refresh, PolarisWidgets.REFRESH.normal);
      ctx.onUnmount(function () {
        clearInterval(timer);
        if (settleTimer) clearTimeout(settleTimer);
        el.removeEventListener("click", onClick);
      });
    },

    renderPreview: function (el) {
      var now = Date.now();
      var wall = function (ms) {
        var d = new Date(ms);
        var p = function (n) { return (n < 10 ? "0" : "") + n; };
        return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
          "T" + p(d.getHours()) + ":" + p(d.getMinutes());
      };
      render(el, [
        {
          id: "p1", name: "Quarterly switch firmware", kind: "recurring", adhoc: false,
          deviceCount: 12, matchedCount: 12, filtered: false, suppressChildren: true,
          assetTypes: [{ assetType: "switch", count: 9 }, { assetType: "access_point", count: 3 }],
          startedAt: wall(now - 45 * 60000), endsAt: wall(now + 22 * 60000),
          endsAtUtc: new Date(now + 22 * 60000).toISOString(),
        },
        {
          id: "p2", name: "DC-A power work", kind: "oneshot", adhoc: false,
          deviceCount: 4, matchedCount: 4, filtered: false, suppressChildren: false,
          assetTypes: [{ assetType: "server", count: 3 }, { assetType: "firewall", count: 1 }],
          startedAt: wall(now - 2 * 3600000), endsAt: wall(now + 5 * 3600000),
          endsAtUtc: new Date(now + 5 * 3600000).toISOString(),
        },
      ], { rowLimit: 5 });
    },

    renderConfig: function (el, config, onChange) {
      el.innerHTML =
        "<label>Row limit</label>" +
        '<select data-k="rowLimit">' +
        PolarisWidgets.rowLimitOptionsHTML(config.rowLimit == null ? DEFAULT_ROWS : config.rowLimit) +
        "</select>" +
        '<p class="widget-config-hint">A schedule is listed when ANY of its devices is in scope, and is then shown whole — a window covering several asset types stays visible on a board filtered to one of them.</p>';
      el.querySelector('[data-k="rowLimit"]').addEventListener("change", function (e) {
        onChange("rowLimit", PolarisWidgets.parseRowLimit(e.target.value));
      });
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, true);
    },
  });
})();
