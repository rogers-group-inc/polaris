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
    var filtered = rows.filter(function (r) { return (RANK[severityOf(r)] || 0) >= min; });
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
      var empty = rows.length ? PolarisWidgets.minSeverityEmptyText({ minSeverity: PolarisWidgets.severityTierForRank(min) }) : null;
      el.innerHTML = '<p class="empty-state">' + escapeHtml(empty || "No active alerts") + '</p>';
      return;
    }
    el.innerHTML = displayed.map(rowHTML).join("") + overflowHTML(displayed, filtered, total);
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
    // An alert is a prompt to go look at the device, so the row opens that
    // device's details slide-in on its Alerts tab (the alert itself, not the
    // General tab the operator would then have to leave). An alert about Polaris ITSELF (a host_metric
    // rule, a system-scoped event) carries no assetId and stays an inert div —
    // there's no device page to open.
    var tag = r.assetId ? "a" : "div";
    var attrs = r.assetId
      ? ' href="/assets.html#view=asset:' + encodeURIComponent(r.assetId) +
        '&tab=notifications" data-asset-id="' + escapeHtml(r.assetId) + '"'
      : "";
    return "<" + tag + ' class="recent-item' + (r.assetId ? " recent-item-link" : "") + '"' + attrs +
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
  function overflowHTML(displayed, filtered, total) {
    var msg = null;
    if (total != null && total > filtered.length) {
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
    defaultConfig: { minSeverity: DEFAULT_TIER, regionScope: "mine", rowLimit: DEFAULT_ROWS },
    // The feed reads Notification rows, so this is alerts:read, not events:read.
    // Every role was seeded that key at read, so no dashboard loses the widget.
    requiredPermission: { key: "alerts", level: "read" },

    fetchData: fetchAlerts,

    renderInstance: function (el, config, data, ctx) {
      render(el, data, config);
      // Click an alert → open its device's details slide-in in place (over the
      // dashboard) on the Alerts tab when openViewModal is loaded; fall back to
      // navigation with the same tab in the hash.
      // Ctrl/meta/middle-click keep the href so the Assets page can still open
      // in a new tab. Delegated on el so it survives the 30s re-render.
      var onClick = function (ev) {
        if (ev.defaultPrevented || ev.button === 1 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
        var link = ev.target.closest(".recent-item[data-asset-id]");
        if (!link || !el.contains(link)) return;
        ev.preventDefault();
        PolarisWidgets.openAssetDetail(link.getAttribute("data-asset-id"), { tab: "notifications" });
      };
      el.addEventListener("click", onClick);
      var timer = setInterval(function () {
        fetchAlerts(config).then(function (d) { render(el, d, config); }).catch(function () {});
      }, PolarisWidgets.REFRESH.normal);
      ctx.onUnmount(function () { clearInterval(timer); el.removeEventListener("click", onClick); });
    },

    renderPreview: function (el) {
      var now = Date.now();
      render(el, { rows: [
        { id: "a1", assetId: "p1", hostname: "fgt-branch-12", ruleName: "Asset down", message: "fgt-branch-12 is down", severity: "critical", acknowledged: false, raisedAt: new Date(now - 6 * 60000).toISOString() },
        { id: "a2", assetId: "p2", hostname: "core-sw-1", dimension: "Overlay-2", ruleName: "IPsec tunnel down", message: "core-sw-1: IPsec tunnel Overlay-2 is down", severity: "serious", acknowledged: true, acknowledgedBy: "jsmith", raisedAt: new Date(now - 40 * 60000).toISOString() },
      ], total: 2 }, { minSeverity: DEFAULT_TIER });
    },

    renderConfig: function (el, config, onChange) {
      el.innerHTML =
        '<label>Row limit</label>' +
        '<select data-k="rowLimit">' + PolarisWidgets.rowLimitOptionsHTML(config.rowLimit == null ? DEFAULT_ROWS : config.rowLimit) + '</select>' +
        '<p class="widget-config-hint">The cap is applied most-severe-first, so a low limit hides the least severe alerts.</p>';
      el.querySelector('[data-k="rowLimit"]').addEventListener("change", function (e) {
        onChange("rowLimit", PolarisWidgets.parseRowLimit(e.target.value));
      });
      // Seed the shared control from the effective floor so a pre-control
      // `severities` config renders as the tier it actually behaves like; the
      // first change writes `minSeverity` and the legacy key stops mattering.
      var seed = { minSeverity: PolarisWidgets.severityTierForRank(minRankOf(config)) };
      PolarisWidgets.renderMinSeverityConfig(el, seed, onChange, "Only alerts at or above this severity are listed.");
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, true);
    },
  });

  // The feed returns the capped list plus the TRUE uncleared count. Rows are
  // NOT clipped here — render() clips, so the export menu and the overflow note
  // can both see everything the server sent.
  function fetchAlerts(config) {
    return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["activeAlerts"]).then(function (d) {
      return { rows: (d && d.activeAlerts) || [], total: d && d.activeAlertsTotal != null ? d.activeAlertsTotal : null };
    }).catch(function () { return { rows: [], total: null }; });
  }
})();
