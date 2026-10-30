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
 *
 * Event-triggered alerts have their OWN widget (2026-10). An event rule fires
 * off an audit Event — agent.disconnected, a failed integration sync, a
 * discovery error — rather than off a reading, so it answers a different
 * question from the rest of the feed: an operator watching device health
 * reads those as noise, while the operator watching the integrations wants
 * exactly them. They used to share this widget behind a Show/Hide gear
 * toggle; now there are two widgets over the one feed:
 *   • activeAlerts (this file) — every kind EXCEPT `event` (a `change` rule —
 *     firmware changed, a switch moved — is about the device, and stays here);
 *   • eventAlerts (widgets/eventAlerts.js) — only `event`, registered through
 *     PolarisWidgets.registerAlertFeed, which this file exports so the two
 *     render, sort, export and act on rows identically.
 * The split is client-side, so the two share the one cached feed payload.
 *
 * An Automations filter (2026-10) narrows either widget to the alerts of
 * picked automations — a wallboard for one team's rules, say — matched
 * client-side on each row's ruleIds like the tag and severity filters.
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
  function rankOf(r) { return RANK[severityOf(r)] || 0; }
  function raisedAtOf(r) { return r.raisedAt; }

  // The ⇅ header button's menu (edit mode). options[0] is the feed's own
  // historical order, so a dashboard saved before this control keeps behaving
  // exactly as it did. The cap slices whatever order is chosen, so a sort here
  // also decides which alerts the Row limit hides.
  //
  // No site/division option: an alert row carries neither (nocDashboardService's
  // ActiveAlertRow is built from Notification, not from the asset), and an
  // event-triggered alert has no device to take one from.
  var CMP = PolarisWidgets.sortCmp;
  var SORTS = [
    {
      key: "severity",
      label: "Severity, then newest",
      cmp: CMP.then(CMP.severity(rankOf), CMP.newest(raisedAtOf)),
    },
    { key: "newest", label: "Most recent first", cmp: CMP.newest(raisedAtOf) },
    // The alert nobody has dealt with in three days — the one a severity-first
    // feed buries at the bottom.
    { key: "oldest", label: "Longest outstanding first", cmp: CMP.oldest(raisedAtOf) },
    {
      key: "unacked",
      label: "Unacknowledged first",
      cmp: CMP.then(
        CMP.flagFirst(function (r) { return !r.acknowledged; }),
        CMP.severity(rankOf),
        CMP.newest(raisedAtOf)
      ),
    },
    // Stable on a wallboard: rows keep their places across the 30s refresh
    // instead of jumping as severities and ages change under the auto-scroll.
    {
      key: "hostname",
      label: "Hostname A–Z",
      cmp: CMP.then(CMP.text(function (r) { return r.hostname; }), CMP.newest(raisedAtOf)),
    },
  ];

  // The operator's tag pick (config.tagScope "custom" + config.tags), or null
  // when the widget isn't narrowed by tag. "Selected tags…" with nothing ticked
  // is unfiltered, mirroring the region picker.
  //
  // A row matches when its asset carries ANY picked tag. A device-less alert
  // (a host_metric rule, an event about Polaris itself) carries no tags and is
  // KEPT, for the same reason the region and asset-type filters keep it: no
  // asset filter can say anything about it.
  //
  // Client-side like the severity floor, so a filtered-out row still spends
  // one of the server's capped rows (the overflow note measures the cap
  // against what was fetched).
  function tagFilterOf(config) {
    if (!config || config.tagScope !== "custom" || !Array.isArray(config.tags) || !config.tags.length) return null;
    return config.tags;
  }
  function matchesTags(r, picked) {
    if (!picked || !r.assetId) return true;
    var tags = r.tags || [];
    for (var i = 0; i < tags.length; i++) if (picked.indexOf(tags[i]) !== -1) return true;
    return false;
  }

  // The operator's automation pick (config.automationScope "custom" +
  // config.automations, rule ids), or null when the widget isn't narrowed by
  // automation. A row matches when ANY automation behind it is picked —
  // r.ruleIds carries a grouped alert's contributing rules as well as its
  // primary one. Unlike the tag filter there is no device-less exception:
  // every alert has an automation, so the pick says something about all of
  // them. A payload from before ruleIds existed carries none and is kept
  // rather than emptying the widget until the server catches up.
  function automationFilterOf(config) {
    if (!config || config.automationScope !== "custom" || !Array.isArray(config.automations) || !config.automations.length) return null;
    return config.automations;
  }
  function matchesAutomations(r, picked) {
    if (!picked || !Array.isArray(r.ruleIds)) return true;
    for (var i = 0; i < r.ruleIds.length; i++) if (picked.indexOf(r.ruleIds[i]) !== -1) return true;
    return false;
  }

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
  //
  // `kind` is the widget: KINDS.active (every alert but event-triggered ones)
  // or the Event Alerts widget's (only those).
  function render(el, data, config, kind) {
    kind = kind || KINDS.active;
    var rows = ((data && data.rows) || []).filter(kind.owns);
    var total = data && data.total != null ? data.total : null;
    var fetched = data && data.rows ? data.rows.length : 0;
    var min = minRankOf(config);
    var pickedTags = tagFilterOf(config);
    var pickedRules = automationFilterOf(config);
    // Gear "Hide acknowledged alerts" — off by default, since an acknowledged
    // alert is still active and the dimmed row with its owner pill is the
    // default answer. A wallboard that only wants what nobody owns yet opts in.
    // Applied last so the empty text can tell "all of them are owned" apart
    // from the tag and severity filters emptying it.
    var hideAcked = !!(config && config.hideAcknowledged);
    var ackHidden = 0;
    var filtered = rows.filter(function (r) {
      if (!matchesAutomations(r, pickedRules)) return false;
      if (!matchesTags(r, pickedTags)) return false;
      if ((RANK[severityOf(r)] || 0) < min) return false;
      if (hideAcked && r.acknowledged) { ackHidden++; return false; }
      return true;
    });
    // Operator's sort (⇅, edit mode) — applied BEFORE the export provider and
    // the clip so all three agree on which alerts lead and which get cut.
    filtered = PolarisWidgets.applySort(filtered, SORTS, config);
    PolarisWidgets.setHeaderSort(el, { options: SORTS, config: config });
    // Header export: the configured-severity listing pre the row-limit clip.
    // Severity is the raising automation's own tier, so "Critical only"
    // = critical automations rather than the old error-level Events.
    PolarisWidgets.setHeaderExport(el, {
      filename: kind.filename,
      severityOf: severityOf,
      columns: [
        { header: "Hostname", get: function (r) { return r.hostname || ""; } },
        { header: "Detail", get: function (r) { return r.dimension || ""; } },
        { header: "Automation", get: function (r) { return r.ruleName || ""; } },
        { header: "Tags", get: function (r) { return (r.tags || []).join(", "); } },
        { header: "Message", get: function (r) { return r.message || ""; } },
        { header: "Dependency Down", get: function (r) { return r.dependencyDown ? (r.dependencyUpstream || "yes") : ""; } },
        { header: "Acknowledged By", get: function (r) { return r.acknowledgedBy || ""; } },
        { header: "Test", get: function (r) { return r.testRun ? "yes" : ""; } },
        { header: "Quiet", get: function (r) { return r.quietHeld ? "held" : ""; } },
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
      // Name the filter that emptied the widget — "No alerts at or above
      // warning" over a feed the tag pick emptied sends the operator to the
      // wrong control.
      var noneFromRules = pickedRules && rows.every(function (r) { return !matchesAutomations(r, pickedRules); });
      var allUntagged = pickedTags && rows.length > 0 && rows.every(function (r) { return !matchesTags(r, pickedTags); });
      var empty = noneFromRules
        ? kind.none + " from the selected automations"
        : allUntagged
        ? kind.none + " on assets with the selected tags"
        : ackHidden
          ? (ackHidden === 1 ? "The 1 alert here is acknowledged" : "All " + ackHidden + " alerts here are acknowledged") +
            " — acknowledged alerts are hidden"
          : (rows.length ? PolarisWidgets.minSeverityEmptyText({ minSeverity: PolarisWidgets.severityTierForRank(min) }) : null);
      el.innerHTML = '<p class="empty-state">' + escapeHtml(empty || kind.none) + '</p>';
      return;
    }
    el.innerHTML = displayed.map(rowHTML).join("") + overflowHTML(displayed, filtered, fetched, total);
  }

  function rowHTML(r) {
    var sev = r.severity || "info";
    var pillCls = SEV_PILL[sev] || "widget-pill-watch";
    var bar = SEV_BAR[sev] || "#4fc3f7";
    // The dim marks the ALERT as handled; it must not reach the acknowledgement.
    // Fading the whole row compounded .6 onto an already-tertiary grey and put
    // the owner's name near the AA floor — on precisely the rows someone still
    // has to read it off. Dim the alert, never the annotation on it.
    // A maintenance-frozen alert (business rule 16) dims the same way: it is
    // listed, but nobody needs to act on it until the window ends.
    var fade = r.acknowledged || r.maintenanceHold ? "opacity:.6" : "";
    var fadeTail = fade ? ";" + fade : "";      // append to an existing inline style
    var fadeAttr = fade ? ' style="' + fade + '"' : "";  // for a span carrying none
    // The automation's name is the row's title — it says what KIND of problem
    // this is, which the message alone often doesn't. The device follows it.
    var title = r.ruleName ? '<span style="margin-right:6px' + fadeTail + '">' + escapeHtml(r.ruleName) + '</span>' : "";
    // A wizard delivery test (business rule 65): a real uncleared alert about
    // the invented sample device, retired by a one-hour TTL rather than by any
    // recovery. Pilled beside the severity because a wallboard reads the pill
    // first — "critical" alone, over a message whose [TEST] prefix is easy to
    // miss, reads as an outage.
    var test = r.testRun
      ? '<span class="widget-pill widget-pill-neutral" style="margin-right:6px' + fadeTail + '" title="' +
        escapeHtml("Delivery test from the automation wizard — about a made-up device, clears itself within an hour") +
        '">TEST</span>'
      : "";
    // A grouped alert (business rule 75) — folded by an Alert Group, or by an
    // automation grouping its own components per device — names many problems
    // on one device, and neither title says so; the GROUP pill does. Both
    // kinds carry dimensionCount (null on an ungrouped alert); only the
    // Alert Group kind carries groupName.
    // Held for quiet time (business rule 92): the alert is real and live, but
    // nobody has been told yet — the summary email will. Pilled so the
    // silence reads as deliberate rather than as a delivery failure.
    var quiet = r.quietHeld
      ? '<span class="widget-pill widget-pill-neutral" style="margin-right:6px' + fadeTail + '" title="' +
        escapeHtml("Held for quiet time — no email, push or chat message has gone out; a summary email is sent when the quiet period ends") +
        '">QUIET</span>'
      : "";
    var grouped = !!r.groupName || r.dimensionCount != null;
    var count = r.dimensionCount ? " — " + r.dimensionCount + " component" + (r.dimensionCount === 1 ? "" : "s") : "";
    var group = grouped
      ? '<span class="widget-pill widget-pill-watch" style="margin-right:6px' + fadeTail + '" title="' +
        escapeHtml((r.groupName ? "Alert group: " + r.groupName : "Grouped by device") + count) +
        '">GROUP</span>'
      : "";
    var who = r.hostname ? '<span style="margin-right:6px;color:var(--color-text-secondary)' + fadeTail + '">' + escapeHtml(r.hostname) + '</span>' : "";
    // The sub-asset the alert is ABOUT (port, sensor, mount, tunnel). Monospace
    // because it's an identifier, and beside the hostname because that pair is
    // what tells two rows of one per-interface automation apart.
    //
    // Not on a grouped alert: its dimension is only the FIRST member, so
    // "port39" beside the hostname read as the whole alert while the message
    // below listed every port. The message already names them all.
    var dim = r.dimension && !grouped
      ? '<span class="dash-alert-dim"' + fadeAttr + ' title="' + escapeHtml("Alert detail: " + r.dimension) + '">' +
        escapeHtml(r.dimension) + '</span>'
      : "";
    // Raised for a device that is dependency-down, by a down automation that
    // opted to speak for it (business rule 78). The same slate badge the Down
    // Nodes widget and the asset pill wear, so the state reads the same on
    // every surface; the tooltip names who silenced it, since a wallboard
    // row has no room for the sentence.
    var dep = r.dependencyDown
      ? '<span class="badge badge-monitor-dep-down" style="margin-left:4px' + fadeTail + '" title="' +
        escapeHtml("Dependency down" + (r.dependencyUpstream ? " — upstream " + r.dependencyUpstream + " is down" : "") +
          ". No reminders or escalation until it recovers.") + '">Dep. Down</span>'
      : "";
    // Frozen for planned work (business rule 16): the device is in a
    // maintenance window, or suppressed behind one. The alert stays listed —
    // the problem predates the work — but pages nobody until the window ends,
    // and the maintenance badge every other surface wears says so. The fade
    // matches an acknowledged row: neither needs anyone right now.
    var maint = r.maintenanceHold
      ? '<span class="badge badge-maintenance" style="margin-left:4px" title="' +
        escapeHtml(r.maintenanceHold === "upstream"
          ? "Paused — an upstream device is in a maintenance window. No reminders or escalation until it ends."
          : "Paused — this device is in a maintenance window. No reminders or escalation until it ends.") +
        '">MAINT</span>'
      : "";
    // An acknowledged alert is still active — hiding it would surprise, so by
    // default (the gear's "Hide acknowledged alerts" opts out) it
    // stays listed and says who has it, and the alert dims to push the
    // unhandled alerts forward on a wallboard.
    //
    // The owner is IN the pill, not only in the title: these run on wallboards,
    // which never hover. The bare "ack" stays as the fallback for a feed that
    // gives no name. The note typed with the acknowledgement is the hover — the
    // feed withholds it on /dash, where the title falls back to the owner.
    // A dependency-down alert acknowledged BY INHERITANCE (business rule 78a)
    // carries the root cause's note, and the hover says whose it is; one that
    // took another down automation's acknowledgement on this same device
    // (business rule 78b) says it was carried over.
    var ackWho = r.acknowledgedBy ? "ack " + r.acknowledgedBy : "ack";
    var ack = r.acknowledged
      ? '<span class="widget-pill widget-pill-neutral" style="margin-left:4px" title="' +
        escapeHtml(PolarisWidgets.ackPillTitle(r.acknowledgedBy, r.acknowledgeNote, r.ackInheritedFrom, r.ackInheritedSameAsset)) + '">' +
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
    var attrs = ' data-row-menu data-alert-id="' + escapeHtml(r.id || "") + '"' +
      (r.acknowledged ? ' data-alert-ack="1"' : "") +
      // The row menu offers the group's components (openAlertMembers).
      (grouped ? ' data-alert-grouped="1"' : "") +
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
        '<div class="recent-item-title"><span class="widget-pill ' + pillCls + '" style="margin-right:6px' + fadeTail + '">' + escapeHtml(sev) + '</span>' + test + quiet + title + group + who + dim + dep + maint + ack + '</div>' +
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
    // The SERVER cap is measured against what it SENT (`fetched`, the whole
    // feed both widgets split), not against what survived this widget's
    // filters — otherwise every widget with a severity floor reads as
    // truncated when the operator's own filters removed the difference, and a
    // real truncation stops being tellable from a filter doing its job.
    // `total` counts BOTH kinds, so the note names the feed, not this widget.
    if (total != null && total > fetched) {
      // The SERVER capped the fetch, so more rows need a bigger Row limit.
      msg = "The feed stopped at " + fetched + " of " + total + " active alerts — raise Row limit to fetch more.";
    } else if (filtered.length > displayed.length) {
      msg = "Showing " + displayed.length + " of " + filtered.length + " at this severity — raise Row limit to see the rest.";
    }
    if (!msg) return "";
    return '<p class="widget-overflow-note">' + escapeHtml(msg) + '</p>';
  }

  // A feed widget over the active-alerts payload: { type, label,
  // description, filename (CSV), none (empty text), owns(row) → bool }.
  var KINDS = {
    active: {
      type: "activeAlerts",
      label: "Active Alerts",
      description: "Alerts your automations have raised from a reading or a state change and nothing has cleared, most severe first.",
      filename: "active-alerts",
      none: "No active alerts",
      owns: function (r) { return r.triggerType !== "event"; },
    },
  };
  registerKind(KINDS.active);
  PolarisWidgets.registerAlertFeed = registerKind;

  function registerKind(kind) {
    PolarisWidgets.register({
      type: kind.type,
      category: "NOC",
      label: kind.label,
      description: kind.description,
      defaultSize: { width: 6, height: 1 },
      minSize: { width: 4, height: 1 },
      defaultConfig: { minSeverity: DEFAULT_TIER, regionScope: "mine", rowLimit: DEFAULT_ROWS, tagScope: "all", tags: [], automationScope: "all", automations: [], sortBy: SORTS[0].key, hideAcknowledged: false },
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
        var paint = function () { render(el, applyLocal(latest, local), config, kind); };
        var refresh = function () {
          return fetchAlerts(config).then(function (d) { latest = d; paint(); }).catch(function () {});
        };
        paint();
        // Click an alert → its verbs (the group's alerts on a grouped one,
        // Acknowledge / Clear / Open device), which
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
            grouped: link.getAttribute("data-alert-grouped") === "1",
            onChanged: function (kind, id, fresh) {
              if (kind === "cleared") local.cleared[id] = true;
              else local.acked[id] = fresh || true;
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
        var ago = function (m) { return new Date(now - m * 60000).toISOString(); };
        render(el, { rows: [
          { id: "a1", assetId: "p1", hostname: "fgt-branch-12", ruleName: "Asset down", message: "fgt-branch-12 is down", severity: "critical", acknowledged: false, tags: ["branch"], raisedAt: ago(6) },
          { id: "a2", assetId: "p2", hostname: "core-sw-1", dimension: "Overlay-2", ruleName: "IPsec tunnel down", message: "core-sw-1: IPsec tunnel Overlay-2 is down", severity: "serious", acknowledged: true, acknowledgedBy: "jsmith", raisedAt: ago(40) },
          // The event kind — usually device-less.
          { id: "e1", assetId: null, hostname: null, ruleName: "Agent disconnected", message: "Agent on app-srv-04 stopped reporting", severity: "warning", triggerType: "event", acknowledged: false, raisedAt: ago(3) },
          { id: "e2", assetId: null, hostname: null, ruleName: "Integration sync failed", message: "FortiManager sync failed: timed out", severity: "serious", triggerType: "event", acknowledged: false, raisedAt: ago(18) },
        ], total: 4 }, { minSeverity: DEFAULT_TIER }, kind);
      },

      renderConfig: function (el, config, onChange) {
        el.innerHTML =
          '<label>Row limit</label>' +
          '<select data-k="rowLimit">' + PolarisWidgets.rowLimitOptionsHTML(config.rowLimit == null ? DEFAULT_ROWS : config.rowLimit) + '</select>' +
          '<label>Acknowledged</label>' +
          '<label class="widget-config-typeopt">' +
            '<input type="checkbox" data-b="hideAcknowledged"' + (config.hideAcknowledged ? " checked" : "") + '>' +
            ' Hide acknowledged alerts' +
          '</label>' +
          '<p class="widget-config-hint">Off (the default) keeps them listed, dimmed, with who has them.</p>';
        el.querySelector('[data-k="rowLimit"]').addEventListener("change", function (e) {
          onChange("rowLimit", PolarisWidgets.parseRowLimit(e.target.value));
        });
        el.querySelector('[data-b="hideAcknowledged"]').addEventListener("change", function (e) {
          onChange("hideAcknowledged", e.target.checked);
        });
        // Seed the shared control from the effective floor so a pre-control
        // `severities` config renders as the tier it actually behaves like; the
        // first change writes `minSeverity` and the legacy key stops mattering.
        var seed = { minSeverity: PolarisWidgets.severityTierForRank(minRankOf(config)) };
        PolarisWidgets.renderMinSeverityConfig(el, seed, onChange, "Only alerts at or above this severity are listed.");
        // Offered only the automations this widget can show (kind.owns reads
        // triggerType, which the picker entries carry too).
        PolarisWidgets.renderAutomationFilterConfig(el, config, onChange, {
          owns: kind.owns,
          note: "Shows only alerts raised by a ticked automation (a grouped alert matches if any of its automations is ticked). Nothing ticked = all automations. Filtered rows still count against the row limit.",
        });
        PolarisWidgets.renderNocFilterConfig(el, config, onChange, true);
        PolarisWidgets.renderTagFilterConfig(el, config, onChange,
          "Shows alerts on assets carrying any ticked tag. Alerts about Polaris itself (no device) stay listed. Filtered rows still count against the row limit.");
      },
    });
  }

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
      // The acknowledged alert as the modal re-read it (or `true` when it
      // handed nothing back) — so the owner and the note show before the feed
      // catches up.
      var fresh = local.acked[r.id];
      if (fresh && !r.acknowledged) {
        r = Object.assign({}, r, {
          acknowledged: true,
          acknowledgedBy: (fresh !== true && fresh.acknowledgedBy) || r.acknowledgedBy,
          acknowledgeNote: (fresh !== true && fresh.acknowledgeNote) || r.acknowledgeNote,
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
