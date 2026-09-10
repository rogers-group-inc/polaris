/**
 * widgets/downNodes.js — "Down Assets": monitored assets currently down,
 * grouped by site or division (SolarWinds "Down Nodes" panel). The registered
 * type stays `downNodes` — saved dashboard layouts key on it.
 *
 * Dependency-suppressed assets (own probe failing, but a parent is down too)
 * are OUT by default, so one dead gate reads as one outage instead of one per
 * device behind it; the gear's "Include dependency-down assets" toggle brings
 * them back for the operator sizing a blast radius, and those rows wear a
 * "Dep. Down" badge so the two kinds stay tellable apart.
 *
 * Severity-first: nodes carrying an active automation alert lead (feed sorts
 * alertRank desc), then youngest outage first (monitorStatusChangedAt desc — server-side, so the newest
 * outages survive the cap). Reuses the monitorAlerts row markup (dash-alert
 * classes + alert-severity pill). Data from noc-summary downNodes[].
 *
 * Clicking a row is a CHOICE, not an assumption. A down device with an
 * unacknowledged alert offers Acknowledge / Open device from a row menu, since
 * on a wallboard the first thing an operator wants to do is take the alert —
 * and walking to the device page, finding the Alerts tab and picking the row
 * out of it is three steps to say "I've got this". A row with nothing to
 * acknowledge (no alert, or one someone already owns) keeps the old behaviour
 * and opens the device straight away. The decision lives in ONE place,
 * PolarisWidgets.openAssetRow — including the surfaces where it can't ask
 * (/dash loads no dialogs) and the roles that may not acknowledge.
 */

(function () {
  // Humanizes a type the static label map lacks (an operator-added registry
  // type), so a row/export never prints a raw snake_case value.
  var typeName = PolarisWidgets.assetTypeLabel;

  function groupKey(node, groupBy) {
    if (groupBy === "division") return node.division || "Ungrouped";
    if (groupBy === "none") return null;
    return node.site || "(unknown)";
  }

  function nodeRowHTML(n) {
    var typeLabel = typeName(n.assetType, "asset");
    var name = n.hostname || n.ipAddress || "(unnamed)";
    var sub = [escapeHtml(typeLabel)];
    if (n.ipAddress) sub.push('<span class="dash-alert-ip">' + escapeHtml(n.ipAddress) + '</span>');
    // Only ever set when the gear toggle asked for these rows. Same slate badge
    // the assets table uses, so the state reads identically on both surfaces.
    if (n.dependencySuppressed) {
      sub.push('<span class="badge badge-monitor-dep-down" title="Upstream parent is down — this outage is probably not its own">Dep. Down</span>');
    }
    var href = '/assets.html#view=asset:' + encodeURIComponent(n.id);
    // The alert behind the severity pill, named so the click can offer to
    // acknowledge THAT alert. Absent on a row with no active alert — which is
    // what makes the click fall through to opening the device.
    var alertAttrs = n.alertId
      ? ' data-alert-id="' + escapeHtml(n.alertId) + '" data-alert-ack="' + (n.alertAcknowledged ? "1" : "0") + '"'
      : "";
    return '<a class="dash-alert-item" href="' + href + '" data-asset-id="' + escapeHtml(n.id) + '"' + alertAttrs + ' style="text-decoration:none">' +
      '<div class="dash-alert-row" style="width:100%">' +
        '<div class="dash-alert-body">' +
          '<div class="dash-alert-title">' + (PolarisWidgets.alertSeverityPill ? PolarisWidgets.alertSeverityPill(n.alertSeverity) : "") + escapeHtml(name) + '</div>' +
          '<div class="dash-alert-sub">' + sub.join(" · ") + '</div>' +
        '</div>' +
        '<div class="dash-alert-time" data-changed-at="' + (n.monitorStatusChangedAt || "") + '">' + PolarisWidgets.durationSince(n.monitorStatusChangedAt) + '</div>' +
      '</div>' +
    '</a>';
  }

  // `data` is { nodes, total } — total is the server's TRUE down count
  // (uncapped). The header now carries a per-severity breakdown of the RENDERED
  // rows instead of that one number, so the pills answer "what am I looking
  // at?"; the uncapped total still reaches the operator through the export
  // menu's tier counts, which stay on the full fetched set. `total` is still
  // fetched (it's part of the feed's shape and the cheapest thing to re-surface
  // if the header ever wants an overflow cue) but nothing renders it now.
  function render(el, data, config) {
    var nodes = (data && data.nodes) || [];
    // Gear "Minimum severity": narrow to nodes carrying an active alert at or
    // above the configured tier, before the count / export / clip.
    if (PolarisWidgets.minSeverityRank(config)) {
      nodes = PolarisWidgets.filterByMinSeverity(nodes, config);
    }
    // Header export: the full fetched list (pre-clip), severity-tiered on each
    // node's active automation alert (alertSeverity).
    PolarisWidgets.setHeaderExport(el, {
      filename: "down-assets",
      columns: [
        { header: "Hostname", get: function (n) { return n.hostname || ""; } },
        { header: "IP Address", get: function (n) { return n.ipAddress || ""; } },
        { header: "Type", get: function (n) { return typeName(n.assetType); } },
        { header: "Site", get: function (n) { return n.site || ""; } },
        { header: "Division", get: function (n) { return n.division || ""; } },
        { header: "Down Since", get: function (n) { return n.monitorStatusChangedAt ? new Date(n.monitorStatusChangedAt).toISOString() : ""; } },
        { header: "Dependency Down", get: function (n) { return n.dependencySuppressed ? "yes" : "no"; } },
      ],
      rows: nodes,
    });
    var groupBy = (config && config.groupBy) || "site";
    var clipped = PolarisWidgets.clip(nodes, config && config.rowLimit);
    // Header severity breakdown of the rows on screen, plus a trailing grey pill
    // for the rendered nodes carrying no active alert — so the pills sum to what
    // the panel shows. Stamped before the empty return so they clear with it.
    PolarisWidgets.setHeaderSeverityCounts(el, clipped);
    if (!clipped.length) {
      var empty = PolarisWidgets.minSeverityEmptyText(config) || "No assets down";
      el.innerHTML = '<p class="empty-state">' + escapeHtml(empty) + '</p>';
      return;
    }

    if (groupBy === "none") {
      el.innerHTML = clipped.map(nodeRowHTML).join("");
      return;
    }
    // Bucket into groups preserving first-seen order; sort groups by size desc.
    var groups = {};
    var order = [];
    clipped.forEach(function (n) {
      var k = groupKey(n, groupBy);
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(n);
    });
    order.sort(function (a, b) { return groups[b].length - groups[a].length; });
    el.innerHTML = order.map(function (k) {
      var list = groups[k];
      return '<div class="dash-alert-group-header" style="display:flex;align-items:center;gap:8px;margin:6px 0 4px;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.03em;color:var(--color-text-secondary)">' +
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(k) + '</span>' +
        // Count pill colored to the group's most severe row, matching the
        // per-row severity pills underneath it.
        '<span class="' + PolarisWidgets.countPillClass(list) + '">' + list.length + '</span>' +
      '</div>' + list.map(nodeRowHTML).join("");
    }).join("");
  }

  PolarisWidgets.register({
    type: "downNodes",
    category: "Monitoring",
    label: "Down Assets",
    description: "Monitored assets currently down — newest outages first, grouped by site or division. Dependency-down assets are excluded unless the gear says otherwise.",
    defaultSize: { width: 6, height: 1 },
    minSize: { width: 4, height: 1 },
    defaultConfig: { groupBy: "site", rowLimit: 10, regionScope: "mine", includeDependencyDown: false },
    requiredPermission: { key: "assets", level: "read" },

    fetchData: function (config) {
      return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["downNodes"]).then(function (d) {
        return { nodes: (d && d.downNodes) || [], total: d && d.downNodesTotal != null ? d.downNodesTotal : null };
      }).catch(function () { return { nodes: [], total: null }; });
    },

    renderInstance: function (el, config, data, ctx) {
      render(el, data, config);
      // The one fetch+render, so the refresh timer and the post-acknowledge
      // refresh can't fall out of step.
      var refresh = function () {
        return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["downNodes"]).then(function (d) {
          render(el, { nodes: (d && d.downNodes) || [], total: d && d.downNodesTotal != null ? d.downNodesTotal : null }, config);
        }).catch(function () {});
      };
      // Click a node → Acknowledge / Open device when there is an unhandled
      // alert to take, else straight into the asset details slide-in in place
      // (over the dashboard) when openViewModal is loaded, falling back to
      // navigation. Plain left-clicks only; ctrl/meta/middle-click keep the
      // href so the operator can still open the Assets page in a new tab.
      // Delegated on el so it survives the 30s re-render (which replaces el's
      // children) — and so the menu's anchor is a row that may be replaced
      // under it, which showRowMenu already handles by closing on scroll and
      // teardown.
      var onClick = function (ev) {
        if (ev.defaultPrevented || ev.button === 1 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
        var link = ev.target.closest(".dash-alert-item[data-asset-id]");
        if (!link || !el.contains(link)) return;
        ev.preventDefault();
        PolarisWidgets.openAssetRow(link, {
          assetId: link.getAttribute("data-asset-id"),
          alertId: link.getAttribute("data-alert-id"),
          alertAcknowledged: link.getAttribute("data-alert-ack") === "1",
          // Re-fetch rather than patching the row: the acknowledgement is one
          // of several things that may have changed in the up-to-30s the row
          // has been on screen, and the feed is the only thing that knows.
          onAcknowledged: refresh,
        });
      };
      el.addEventListener("click", onClick);
      var timer = setInterval(refresh, PolarisWidgets.REFRESH.normal);
      ctx.onUnmount(function () { clearInterval(timer); el.removeEventListener("click", onClick); });
    },

    renderPreview: function (el) {
      var now = Date.now();
      render(el, { nodes: [
        { id: "p1", hostname: "fs-aisle-3", ipAddress: "10.1.2.5", assetType: "switch", site: "Plant A", division: "Ops", monitorStatus: "down", monitorStatusChangedAt: new Date(now - 9 * 60000).toISOString() },
        { id: "p2", hostname: "fap-conf-rm", ipAddress: "10.1.2.42", assetType: "access_point", site: "Plant A", division: "Ops", monitorStatus: "down", monitorStatusChangedAt: new Date(now - 22 * 60000).toISOString() },
        { id: "p3", hostname: "rtr-wan-2", ipAddress: "10.9.0.1", assetType: "router", site: "DC West", division: "Core", monitorStatus: "down", monitorStatusChangedAt: new Date(now - 2 * 3600000).toISOString() },
      ], total: 3 }, { groupBy: "site", rowLimit: 5 });
    },

    renderConfig: function (el, config, onChange) {
      el.innerHTML =
        '<label>Group by</label>' +
        '<select data-k="groupBy">' +
          '<option value="site"' + ((config.groupBy || "site") === "site" ? " selected" : "") + '>Site</option>' +
          '<option value="division"' + (config.groupBy === "division" ? " selected" : "") + '>Division</option>' +
          '<option value="none"' + (config.groupBy === "none" ? " selected" : "") + '>None</option>' +
        '</select>' +
        '<label>Row limit</label>' +
        '<select data-k="rowLimit">' + PolarisWidgets.rowLimitOptionsHTML(config.rowLimit) + '</select>' +
        '<label>Dependencies</label>' +
        '<label class="widget-config-typeopt">' +
          '<input type="checkbox" data-b="includeDependencyDown"' + (config.includeDependencyDown ? " checked" : "") + '>' +
          ' Include dependency-down assets' +
        '</label>' +
        '<p class="widget-config-hint">Off (the default) hides assets whose parent is also down, so a dead gate counts as one outage rather than one per device behind it.</p>';
      el.querySelectorAll("[data-b]").forEach(function (cb) {
        cb.addEventListener("change", function () { onChange(cb.getAttribute("data-b"), cb.checked); });
      });
      el.querySelectorAll("[data-k]").forEach(function (s) {
        s.addEventListener("change", function () {
          var k = s.getAttribute("data-k");
          onChange(k, k === "rowLimit" ? PolarisWidgets.parseRowLimit(s.value) : s.value);
        });
      });
      PolarisWidgets.renderMinSeverityConfig(el, config, onChange,
        "Only nodes with an active alert at or above this severity are shown.");
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, true);
    },
  });
})();
