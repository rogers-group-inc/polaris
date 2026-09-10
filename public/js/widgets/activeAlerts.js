/**
 * widgets/activeAlerts.js — the ACTIVE ALERTS feed (SolarWinds "Needs
 * Attention"). One row per uncleared Notification, severity-first then newest,
 * each with a left severity color bar + a severity pill. Data from
 * /dashboard/noc-summary activeAlerts[].
 *
 * These are ALERTS, not audit Events. The widget used to list every warning/
 * error Event, which made it wrong twice over: raw discovery/sync failures no
 * automation covered appeared as permanent alerts (nothing clears an Event, so
 * they sat for the full 7-day retention), and the pill showed `Event.level`,
 * which collapses critical AND serious into "error" — so a `serious` automation
 * read as "error". A row now appears only because an automation raised it,
 * wears that automation's own severity (notice / warning / serious / critical),
 * and leaves when the alert clears.
 *
 * Severity filtering rides the shared "Minimum severity" gear control
 * (config.minSeverity), same as every other severity-carrying widget — and now
 * against the automation ladder these rows are actually built from, so
 * "Serious and up" means serious-and-up rather than the Event-level
 * approximation it used to.
 *
 * The widget's promise is that an ACTIVE ALERT APPEARS IN IT, which took three
 * things it was missing (2026-08):
 *   • a Row limit. The feed was hard-capped at 30 server-side and 25 in here,
 *     with no control — and the cap slices a severity-DESC list, so it eats the
 *     lowest tiers first. One per-interface automation raises one alert per
 *     pinned port, so a switch losing its uplinks could fill all 25 rows with
 *     criticals and make every serious/warning alert on the fleet invisible
 *     while the header still read "Warning and up". The server cap is now the
 *     peer feeds' 100, the view shows DEFAULT_ROWS and is operator-settable to
 *     1000, and where it bites is STATED (activeAlertsTotal) rather than being
 *     a silent end-of-list.
 *   • the dimension. Those per-port rows share an automation, a minute and a
 *     message template, so without the port name they differ in nothing — the
 *     same reason the asset Alerts tab grew a Detail column.
 *   • a click-through. The row now opens the asset's details slide-in in place
 *     (downNodes pattern), since an alert is a prompt to go look at a device.
 *
 * Two later additions (2026-09), both about the alerts that are NOT about a
 * device:
 *   • EVERY row is clickable, not just the ones naming an asset. An alert from
 *     an event-triggered or host_metric automation carries no assetId and was
 *     rendered as an inert div, so the alerts most likely to need a human —
 *     an agent disconnecting, a failed sync, Polaris itself — were the only
 *     ones the widget wouldn't let anyone act on. A click now offers the asset
 *     Alerts tab's own verbs (Acknowledge… / Clear / Open device where there
 *     IS a device) through PolarisWidgets.openAlertRow, and this widget holds
 *     the result over the caches until the feed catches up.
 *   • the gear can HIDE event-triggered alerts (config.eventAlerts). They
 *     answer a different question from the rest of the feed, and a board built
 *     for device health shouldn't have to carry them — or, on an integrations
 *     board, be the only thing that can't.
 */

(function () {
  // The automation ladder's own pills/bars. Event levels stay mapped at their
  // pill-equivalent ranks (index.js ALERT_SEVERITY_RANK / ALERT_SEV_PILL) so a
  // pre-upgrade cached payload still renders.
  var SEV_PILL = {
    notice: "widget-pill-neutral",
    informational: "widget-pill-watch", info: "widget-pill-watch",
    warning: "widget-pill-amber",
    serious: "widget-pill-orange",
    critical: "widget-pill-red", error: "widget-pill-red",
  };
  var SEV_BAR = {
    notice: "#9e9e9e",
    informational: "#4fc3f7", info: "#4fc3f7",
    warning: "#ffa726",
    serious: "#ff7043",
    critical: "#ef5350", error: "#ef5350",
  };
  var RANK = PolarisWidgets.ALERT_SEVERITY_RANK;
  var DEFAULT_TIER = "warning"; // pre-control default was ["warning","error"]
  // Rows shown before the operator touches the gear. 50 rather than the
  // hardcoded 25 this replaced: the widget's job is to be the place an alert
  // shows up, and it has to be one of the shared ROW_LIMIT_OPTIONS values or
  // the gear select would render with nothing marked selected.
  var DEFAULT_ROWS = 50;

  function severityOf(r) { return r.severity; }

  // Whether the operator wants alerts raised by EVENT-triggered automations in
  // this widget (config.eventAlerts: "show" | "hide", default show — an
  // existing dashboard's feed doesn't change under it).
  //
  // Event rules fire off an audit Event — agent.disconnected, a failed
  // integration sync, a discovery error — rather than off a reading, so they
  // answer a different question from the rest of the feed: an operator
  // watching device health reads them as noise, while the operator watching
  // the integrations wants exactly them. Only `event` is hidden: a `change`
  // rule (firmware changed, an asset's switch moved) is about the device, and
  // the metric/state/composite tiers are the feed's whole point.
  //
  // Filtered CLIENT-side like the severity floor, so a hidden row still spends
  // one of the server's capped rows — which the overflow note accounts for by
  // measuring the cap against what was FETCHED, not what survived the filters.
  function hidesEventAlerts(config) { return !!config && config.eventAlerts === "hide"; }

  // The rank floor to display at. Reads config.minSeverity when present, else
  // folds a pre-control `severities` checkbox array into its lowest rank (so a
  // saved ["info","warning","error"] keeps showing info rows) — an unrepresentable
  // gapped set like ["info","error"] widens to "info and up".
  function minRankOf(config) {
    if (config && config.minSeverity) return PolarisWidgets.minSeverityRank(config);
    if (config && Array.isArray(config.severities) && config.severities.length) {
      return config.severities.reduce(function (lo, s) {
        var r = RANK[s] || 0;
        return r && (lo === 0 || r < lo) ? r : lo;
      }, 0);
    }
    return RANK[DEFAULT_TIER];
  }

  // `data` is { rows, total } — total is the server's TRUE uncleared count
  // (pre-cap), so a truncated view can say so instead of just ending.
  function render(el, data, config) {
    var rows = (data && data.rows) || [];
    var total = data && data.total != null ? data.total : null;
    var min = minRankOf(config);
    var hideEvents = hidesEventAlerts(config);
    var filtered = rows.filter(function (r) {
      if (hideEvents && r.triggerType === "event") return false;
      return (RANK[severityOf(r)] || 0) >= min;
    });
    // Header export: the configured-severity listing pre the row-limit clip.
    // Severity is the raising automation's own tier, so "Critical only"
    // = critical automations rather than the old error-level Events.
    PolarisWidgets.setHeaderExport(el, {
      filename: "active-alerts",
      severityOf: severityOf,
      columns: [
        { header: "Hostname", get: function (r) { return r.hostname || ""; } },
        { header: "Detail", get: function (r) { return r.dimension || ""; } },
        { header: "Automation", get: function (r) { return r.ruleName || ""; } },
        { header: "Message", get: function (r) { return r.message || ""; } },
        { header: "Acknowledged By", get: function (r) { return r.acknowledgedBy || ""; } },
        { header: "Raised At", get: function (r) { return r.raisedAt ? new Date(r.raisedAt).toISOString() : ""; } },
      ],
      rows: filtered,
    });
    // Row limit (gear). A stored widget carries no rowLimit key — it predates
    // the control — and falls back to DEFAULT_ROWS.
    var displayed = PolarisWidgets.clip(filtered, config && config.rowLimit != null ? config.rowLimit : DEFAULT_ROWS);
    // Header severity breakdown of the alerts ON SCREEN — the row-limit slice,
    // not the whole configured-severity listing. Every alert HAS a severity, so
    // nothing lands in a grey bucket and "omit" only guards a row with an
    // unknown one.
    PolarisWidgets.setHeaderSeverityCounts(el, displayed, { unalerted: "omit", severityOf: severityOf });
    if (!filtered.length) {
      // Name the filter that emptied the widget. "No alerts at or above
      // warning" over a feed whose every row is a hidden event alert sends the
      // operator to the wrong control.
      var allEvents = hideEvents && rows.length > 0 && rows.every(function (r) { return r.triggerType === "event"; });
      var empty = allEvents
        ? "No active alerts — event-triggered alerts are hidden"
        : (rows.length ? PolarisWidgets.minSeverityEmptyText({ minSeverity: PolarisWidgets.severityTierForRank(min) }) : null);
      el.innerHTML = '<p class="empty-state">' + escapeHtml(empty || "No active alerts") + '</p>';
      return;
    }
    el.innerHTML = displayed.map(rowHTML).join("") + overflowHTML(displayed, filtered, rows, total);
  }

  function rowHTML(r) {
    var sev = r.severity || "info";
    var pillCls = SEV_PILL[sev] || "widget-pill-watch";
    var bar = SEV_BAR[sev] || "#4fc3f7";
    // The dim marks the ALERT as handled; it must not reach the acknowledgement.
    // Fading the whole row compounded .6 onto an already-tertiary grey and put
    // the owner's name near the AA floor — on precisely the rows someone still
    // has to read it off. Dim the alert, never the annotation on it.
    var fade = r.acknowledged ? "opacity:.6" : "";
    var fadeTail = fade ? ";" + fade : "";      // append to an existing inline style
    var fadeAttr = fade ? ' style="' + fade + '"' : "";  // for a span carrying none
    // The automation's name is the row's title — it says what KIND of problem
    // this is, which the message alone often doesn't. The device follows it.
    var title = r.ruleName ? '<span style="margin-right:6px' + fadeTail + '">' + escapeHtml(r.ruleName) + '</span>' : "";
    var who = r.hostname ? '<span style="margin-right:6px;color:var(--color-text-secondary)' + fadeTail + '">' + escapeHtml(r.hostname) + '</span>' : "";
    // The sub-asset the alert is ABOUT (port, sensor, mount, tunnel). Monospace
    // because it's an identifier, and beside the hostname because that pair is
    // what tells two rows of one per-interface automation apart.
    var dim = r.dimension
      ? '<span class="dash-alert-dim"' + fadeAttr + ' title="' + escapeHtml("Alert detail: " + r.dimension) + '">' +
        escapeHtml(r.dimension) + '</span>'
      : "";
    // An acknowledged alert is still active — hiding it would surprise, so it
    // stays listed and says who has it, and the alert dims to push the
    // unhandled alerts forward on a wallboard.
    //
    // The owner is IN the pill, not only in the title: these run on wallboards,
    // which never hover. The bare "ack" stays as the fallback for a feed that
    // gives no name.
    var ackWho = r.acknowledgedBy ? "ack " + r.acknowledgedBy : "ack";
    var ack = r.acknowledged
      ? '<span class="widget-pill widget-pill-neutral" style="margin-left:4px" title="' +
        escapeHtml("Acknowledged" + (r.acknowledgedBy ? " by " + r.acknowledgedBy : "")) + '">' +
        escapeHtml(ackWho) + '</span>'
      : "";
    // Every row is a prompt to DO something, so every row is clickable —
    // Acknowledge / Clear / Open device from a row menu (PolarisWidgets.
    // openAlertRow). An alert about Polaris ITSELF (a host_metric rule, an
    // event rule on a failed sync) carries no assetId: it used to render as an
    // inert div, which left the alerts most likely to need a human the only
    // ones the widget wouldn't let them act on. It is still a div — there is no
    // asset URL to put in an href — but it carries the alert id and answers the
    // click with the two verbs that don't need a device.
    var tag = r.assetId ? "a" : "div";
    var attrs = ' data-alert-id="' + escapeHtml(r.id || "") + '"' +
      (r.acknowledged ? ' data-alert-ack="1"' : "") +
      (r.assetId
        ? ' href="/assets.html#view=asset:' + encodeURIComponent(r.assetId) +
          '&tab=notifications" data-asset-id="' + escapeHtml(r.assetId) + '"'
        : "");
    // The hover/pointer affordance is withheld where the click can do nothing:
    // the /dash wallboard has no session and loads no dialogs, so a device-less
    // row there is as inert as it ever was and must not claim otherwise.
    var actionable = r.assetId || !window.POLARIS_DASH_LOCAL;
    return "<" + tag + ' class="recent-item' + (actionable ? " recent-item-link" : "") + '"' + attrs +
      ' style="border-left:3px solid ' + bar + ';padding-left:8px">' +
      '<div style="min-width:0">' +
        '<div class="recent-item-title"><span class="widget-pill ' + pillCls + '" style="margin-right:6px' + fadeTail + '">' + escapeHtml(sev) + '</span>' + title + who + dim + ack + '</div>' +
        '<div class="recent-item-meta"' + fadeAttr + '>' + escapeHtml(r.message || "") + '</div>' +
      '</div>' +
      '<span class="recent-item-time">' + timeAgo(r.raisedAt) + '</span>' +
    "</" + tag + ">";
  }

  // Where the view stops, said out loud. The cap slices a severity-DESC list,
  // so a silent end-of-list is exactly how a fleet's serious alerts go missing
  // behind a screenful of criticals.
  function overflowHTML(displayed, filtered, fetched, total) {
    var msg = null;
    // The SERVER cap is measured against what it SENT (`fetched`), not against
    // what survived the display filters — otherwise every widget with a
    // severity floor or event alerts hidden reads as truncated ("Showing 3 of
    // 40") when the operator's own filters removed the difference, and a real
    // truncation stops being tellable from a filter doing its job.
    if (total != null && total > fetched.length) {
      // The SERVER capped the fetch, so more rows need a bigger Row limit.
      msg = "Showing " + displayed.length + " of " + total + " active alerts — raise Row limit to fetch more.";
    } else if (filtered.length > displayed.length) {
      msg = "Showing " + displayed.length + " of " + filtered.length + " at this severity — raise Row limit to see the rest.";
    }
    if (!msg) return "";
    return '<p class="widget-overflow-note">' + escapeHtml(msg) + '</p>';
  }

  PolarisWidgets.register({
    type: "activeAlerts",
    category: "NOC",
    label: "Active Alerts",
    description: "Alerts your automations have raised and nothing has cleared, most severe first.",
    defaultSize: { width: 6, height: 1 },
    minSize: { width: 4, height: 1 },
    defaultConfig: { minSeverity: DEFAULT_TIER, regionScope: "mine", rowLimit: DEFAULT_ROWS, eventAlerts: "show" },
    // The feed reads Notification rows, so this is alerts:read, not events:read.
    // Every role was seeded that key at read, so no dashboard loses the widget.
    requiredPermission: { key: "alerts", level: "read" },

    fetchData: fetchAlerts,

    renderInstance: function (el, config, data, ctx) {
      // What the operator did FROM THIS WIDGET, held over every later paint
      // until the feed agrees. Both caches sit between the act and the next
      // fetch — getNocSummary memoizes 15s client-side on top of the route's
      // 10s TTL — so without this an acknowledged row comes back
      // unacknowledged and a cleared one comes back at all, which reads as a
      // click that did nothing. Overrides only ever REMOVE or ANNOTATE a row,
      // never invent one, and they cost nothing once the feed stops sending it.
      var local = { acked: {}, cleared: {} };
      var latest = data;
      var paint = function () { render(el, applyLocal(latest, local), config); };
      var refresh = function () {
        return fetchAlerts(config).then(function (d) { latest = d; paint(); }).catch(function () {});
      };
      paint();
      // Click an alert → its verbs (Acknowledge / Clear / Open device), which
      // is how an alert with no device gets acted on at all. A row that leaves
      // one verb ("Open device", for a read-only role) opens the device
      // straight away, as the click always did.
      // Ctrl/meta/middle-click keep the href so the Assets page can still open
      // in a new tab. Delegated on el so it survives the 30s re-render.
      var onClick = function (ev) {
        if (ev.defaultPrevented || ev.button === 1 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
        var link = ev.target.closest(".recent-item[data-alert-id]");
        if (!link || !el.contains(link)) return;
        ev.preventDefault();
        PolarisWidgets.openAlertRow(link, {
          alertId: link.getAttribute("data-alert-id"),
          assetId: link.getAttribute("data-asset-id"),
          acknowledged: link.getAttribute("data-alert-ack") === "1",
          onChanged: function (kind, id, fresh) {
            if (kind === "cleared") local.cleared[id] = true;
            else local.acked[id] = (fresh && fresh.acknowledgedBy) || true;
            paint();
            refresh();
          },
        });
      };
      el.addEventListener("click", onClick);
      var timer = setInterval(refresh, PolarisWidgets.REFRESH.normal);
      ctx.onUnmount(function () { clearInterval(timer); el.removeEventListener("click", onClick); });
    },

    renderPreview: function (el) {
      var now = Date.now();
      render(el, { rows: [
        { id: "a1", assetId: "p1", hostname: "fgt-branch-12", ruleName: "Asset down", message: "fgt-branch-12 is down", severity: "critical", acknowledged: false, raisedAt: new Date(now - 6 * 60000).toISOString() },
        { id: "a2", assetId: "p2", hostname: "core-sw-1", dimension: "Overlay-2", ruleName: "IPsec tunnel down", message: "core-sw-1: IPsec tunnel Overlay-2 is down", severity: "serious", acknowledged: true, acknowledgedBy: "jsmith", raisedAt: new Date(now - 40 * 60000).toISOString() },
        // The device-less kind: an event-triggered automation, no assetId —
        // the row the gear's "Event-triggered alerts" control governs.
        { id: "a3", assetId: null, hostname: null, ruleName: "Agent disconnected", message: "Agent on app-srv-04 stopped reporting", severity: "warning", triggerType: "event", acknowledged: false, raisedAt: new Date(now - 3 * 60000).toISOString() },
      ], total: 3 }, { minSeverity: DEFAULT_TIER });
    },

    renderConfig: function (el, config, onChange) {
      el.innerHTML =
        '<label>Row limit</label>' +
        '<select data-k="rowLimit">' + PolarisWidgets.rowLimitOptionsHTML(config.rowLimit == null ? DEFAULT_ROWS : config.rowLimit) + '</select>' +
        '<p class="widget-config-hint">The cap is applied most-severe-first, so a low limit hides the least severe alerts.</p>';
      el.querySelector('[data-k="rowLimit"]').addEventListener("change", function (e) {
        onChange("rowLimit", PolarisWidgets.parseRowLimit(e.target.value));
      });
      // Event-triggered alerts. A select rather than a checkbox because the
      // two states both need naming — "hide" is a claim about which alerts
      // this board is FOR, not an option someone left off.
      var evt = hidesEventAlerts(config) ? "hide" : "show";
      el.insertAdjacentHTML("beforeend",
        '<label>Event-triggered alerts</label>' +
        '<select data-k="eventAlerts">' +
          '<option value="show"' + (evt === "show" ? " selected" : "") + '>Show</option>' +
          '<option value="hide"' + (evt === "hide" ? " selected" : "") + '>Hide</option>' +
        '</select>' +
        '<p class="widget-config-hint">Alerts from automations triggered by an event (an agent disconnecting, a failed sync) rather than by a reading. Hidden rows still count against the row limit.</p>');
      el.querySelector('[data-k="eventAlerts"]').addEventListener("change", function (e) {
        onChange("eventAlerts", e.target.value === "hide" ? "hide" : "show");
      });
      // Seed the shared control from the effective floor so a pre-control
      // `severities` config renders as the tier it actually behaves like; the
      // first change writes `minSeverity` and the legacy key stops mattering.
      var seed = { minSeverity: PolarisWidgets.severityTierForRank(minRankOf(config)) };
      PolarisWidgets.renderMinSeverityConfig(el, seed, onChange, "Only alerts at or above this severity are listed.");
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, true);
    },
  });

  // Fold this widget's own acknowledge/clear acts over a fetched payload.
  // `total` drops with the rows removed but never below what is left, so the
  // overflow note can't claim fewer alerts exist than are on screen.
  function applyLocal(data, local) {
    var rows = (data && data.rows) || [];
    var total = data && data.total != null ? data.total : null;
    var out = [];
    var dropped = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (local.cleared[r.id]) { dropped++; continue; }
      var who = local.acked[r.id];
      if (who && !r.acknowledged) {
        r = Object.assign({}, r, {
          acknowledged: true,
          acknowledgedBy: typeof who === "string" ? who : r.acknowledgedBy,
        });
      }
      out.push(r);
    }
    return { rows: out, total: total == null ? null : Math.max(total - dropped, out.length) };
  }

  // The feed returns the capped list plus the TRUE uncleared count. Rows are
  // NOT clipped here — render() clips, so the export menu and the overflow note
  // can both see everything the server sent.
  function fetchAlerts(config) {
    return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["activeAlerts"]).then(function (d) {
      return { rows: (d && d.activeAlerts) || [], total: d && d.activeAlertsTotal != null ? d.activeAlertsTotal : null };
    }).catch(function () { return { rows: [], total: null }; });
  }
})();
