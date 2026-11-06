/**
 * widgets/sitesWithIssues.js — sites where one or more monitored assets carry an
 * ACTIVE ALERT, worst alert severity first (SolarWinds "Sites with Issues").
 * Poll state plays no part: a missed poll ("warning" monitorStatus) is not an
 * issue until an automation raises an alert for it. Each site row expands
 * inline to list its alerted nodes, each pipped by its own highest active
 * alert. Node detail arrives inline in the payload, so expansion needs no
 * second fetch (unlike monitorAlerts). Data from /dashboard/noc-summary
 * sitesWithIssues[].
 */

(function () {
  // Per-instance expand state keyed by widget element (same technique as
  // monitorAlerts) so a 30s re-tick doesn't collapse the open site.
  var _state = new WeakMap();
  function getState(el) {
    var s = _state.get(el);
    if (!s) { s = { expanded: null }; _state.set(el, s); }
    return s;
  }

  function severityPip(sev) {
    var color = (PolarisWidgets.alertSeverityBarColor && PolarisWidgets.alertSeverityBarColor(sev)) || window.POLARIS_WIDGET_STATUS_COLORS.neutral;
    return '<span title="Highest active alert: ' + escapeHtml(sev || "") + '" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + color + ';margin-right:6px"></span>';
  }

  function rankOf(sev) {
    return (sev && PolarisWidgets.ALERT_SEVERITY_RANK && PolarisWidgets.ALERT_SEVERITY_RANK[sev]) || 0;
  }

  // One count pill per severity present at the site, worst first: "1 critical"
  // "2 warning". Each device counts once, under its own worst active alert.
  function severityPills(counts) {
    return Object.keys(counts || {}).sort(function (a, b) { return rankOf(b) - rankOf(a); }).map(function (sev) {
      var cls = PolarisWidgets.alertSeverityPillClass(sev) || "widget-pill-watch";
      return '<span class="widget-pill ' + cls + '">' + counts[sev] + ' ' + escapeHtml(sev) + '</span>';
    }).join(" ");
  }

  function render(el, sites, config) {
    sites = sites || [];
    var st = getState(el);
    // "downCount" is the stored value of configs saved before the feed became
    // alert-driven; it means the default severity order.
    var sortBy = (config && config.sortBy) || "severity";
    var sorted = sites.slice().sort(function (a, b) {
      if (sortBy === "name") return (a.site || "").localeCompare(b.site || "");
      return ((b.alertRank || 0) - (a.alertRank || 0)) || ((b.alertedCount || 0) - (a.alertedCount || 0)) || (a.site || "").localeCompare(b.site || "");
    });
    sorted = PolarisWidgets.clip(sorted, config && config.rowLimit);
    // Header severity breakdown of the SITES on screen: each site carries the
    // worst active alert among its own nodes (server-side), so a pill counts
    // sites at that severity — not nodes. Stamped before the empty return so
    // the pills clear with it.
    PolarisWidgets.setHeaderSeverityCounts(el, sorted, { unalerted: "omit" });
    if (!sorted.length) { el.innerHTML = '<p class="empty-state">No sites with issues</p>'; return; }
    if (st.expanded && !sorted.some(function (s) { return s.site === st.expanded; })) st.expanded = null;

    el.innerHTML = sorted.map(function (s) {
      var isOpen = st.expanded === s.site;
      var pills = severityPills(s.severityCounts);
      var head = '<button type="button" class="dash-alert-row" data-site="' + escapeHtml(s.site) + '" aria-expanded="' + (isOpen ? "true" : "false") + '" style="width:100%">' +
        '<div class="dash-alert-body">' +
          '<div class="dash-alert-title">' + escapeHtml(s.site) + (s.division ? ' <span style="color:var(--color-text-secondary);font-weight:400">· ' + escapeHtml(s.division) + '</span>' : '') + '</div>' +
          '<div class="dash-alert-sub">' + pills + ' <span style="color:var(--color-text-tertiary)">of ' + s.total + '</span></div>' +
        '</div>' +
      '</button>';
      var body = "";
      if (isOpen) {
        var nodes = (s.nodes || []).slice().sort(function (a, b) {
          return rankOf(b.alertSeverity) - rankOf(a.alertSeverity);
        });
        body = '<div class="dash-alert-expand">' + (nodes.length ? nodes.map(function (n) {
          var name = n.hostname || n.id;
          var href = '/assets.html#view=asset:' + encodeURIComponent(n.id);
          return '<div style="padding:2px 0">' + severityPip(n.alertSeverity) + '<a class="dep-tree-link" href="' + href + '">' + escapeHtml(name) + '</a></div>';
        }).join("") : '<div class="empty-state" style="text-align:left;padding:0">No node detail</div>') + '</div>';
      }
      return '<div class="dash-alert-item' + (isOpen ? ' is-expanded' : '') + '">' + head + body + '</div>';
    }).join("");
  }

  function wire(el, getData, config) {
    el.addEventListener("click", function (ev) {
      if (ev.target.closest(".dash-alert-expand a")) return; // let node links navigate
      var btn = ev.target.closest(".dash-alert-row");
      if (!btn || !el.contains(btn)) return;
      var site = btn.getAttribute("data-site");
      var st = getState(el);
      st.expanded = st.expanded === site ? null : site;
      render(el, getData(), config);
    });
  }

  PolarisWidgets.register({
    type: "sitesWithIssues",
    category: "NOC",
    label: "Sites with Issues",
    description: "Sites with monitored assets carrying active alerts, worst alert severity first. Expand a site for its alerted nodes.",
    defaultSize: { width: 6, height: 1 },
    minSize: { width: 4, height: 1 },
    defaultConfig: { rowLimit: 10, sortBy: "severity", regionScope: "mine" },
    requiredPermission: { key: "assets", level: "read" },

    fetchData: function (config) {
      return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["sitesWithIssues"]).then(function (d) { return (d && d.sitesWithIssues) || []; }).catch(function () { return []; });
    },

    renderInstance: function (el, config, data, ctx) {
      var current = data || [];
      render(el, current, config);
      wire(el, function () { return current; }, config);
      PolarisWidgets.pollVisible(ctx, function () {
        PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["sitesWithIssues"]).then(function (d) { current = (d && d.sitesWithIssues) || []; render(el, current, config); }).catch(function () {});
      }, PolarisWidgets.REFRESH.normal);
      ctx.onUnmount(function () { _state.delete(el); });
    },

    renderPreview: function (el) {
      render(el, [
        { site: "Plant A", division: "Ops", alertSeverity: "critical", alertRank: 5, alertedCount: 3, severityCounts: { critical: 1, warning: 2 }, total: 12, nodes: [
          { id: "n1", hostname: "fs-aisle-3", alertSeverity: "critical" },
          { id: "n2", hostname: "fap-conf-rm", alertSeverity: "warning" },
        ] },
        { site: "DC West", division: "Core", alertSeverity: "serious", alertRank: 4, alertedCount: 1, severityCounts: { serious: 1 }, total: 8, nodes: [] },
      ], { rowLimit: 5, sortBy: "severity" });
    },

    renderConfig: function (el, config, onChange) {
      el.innerHTML =
        '<label>Sort by</label>' +
        '<select data-k="sortBy">' +
          '<option value="severity"' + (config.sortBy !== "name" ? " selected" : "") + '>Alert severity</option>' +
          '<option value="name"' + (config.sortBy === "name" ? " selected" : "") + '>Site name</option>' +
        '</select>' +
        '<label>Row limit</label>' +
        '<select data-k="rowLimit">' + PolarisWidgets.rowLimitOptionsHTML(config.rowLimit) + '</select>';
      el.querySelectorAll("[data-k]").forEach(function (s) {
        s.addEventListener("change", function () {
          var k = s.getAttribute("data-k");
          onChange(k, k === "rowLimit" ? PolarisWidgets.parseRowLimit(s.value) : s.value);
        });
      });
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, true);
    },
  });
})();
