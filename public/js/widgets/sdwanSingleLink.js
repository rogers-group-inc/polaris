/**
 * widgets/sdwanSingleLink.js — sites one failure from offline: SD-WAN gates
 * that have two or more WAN paths and are down to one (or none). Members are
 * counted by the physical path they ride, so two overlay tunnels over the same
 * ISP port are one path, not redundancy; a site built with a single path never
 * had redundancy to lose and is not listed. A member is down when any health
 * check probing it says so (the SD-WAN Members table's verdict). The down
 * widgets never show this state — the site is still up. Click a row to open the
 * gate on its SD-WAN tab. Data from noc-summary sdwanSingleLink[].
 */

(function () {
  var FEED = "sdwanSingleLink";

  function fetchRows(config) {
    return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), [FEED])
      .then(function (d) { return (d && d[FEED]) || []; });
  }

  function hostOf(r) { return r.hostname || r.ipAddress || "(unnamed)"; }

  var CMP = PolarisWidgets.sortCmp;
  function alivePathsOf(r) { return r.alivePaths; }
  // options[0] is the feed's own order: severity, then fewest live paths.
  var SORTS = [
    { key: "severity", label: "Severity, then fewest paths", cmp: CMP.then(CMP.severity(), CMP.low(alivePathsOf)) },
    { key: "paths", label: "Fewest live paths first", cmp: CMP.low(alivePathsOf) },
    { key: "hostname", label: "Hostname A–Z", cmp: CMP.text(hostOf) },
    { key: "site", label: "Site A–Z", cmp: CMP.then(CMP.text(function (r) { return r.site; }), CMP.text(hostOf)) },
  ];

  function rowHTML(r) {
    var none = r.alivePaths === 0;
    var title = (PolarisWidgets.alertSeverityPill ? PolarisWidgets.alertSeverityPill(r.alertSeverity) : "") +
      escapeHtml(hostOf(r));
    if (r.site && r.site !== "(unknown)") title += ' <span class="dash-alert-ip">' + escapeHtml(r.site) + '</span>';
    var parts = [];
    parts.push(none ? "no live path" : "only " + escapeHtml((r.alive || []).join(", ")));
    if (r.downMembers && r.downMembers.length) parts.push("down: " + escapeHtml(r.downMembers.join(", ")));
    var pill = '<span class="widget-pill ' + (none ? "widget-pill-red" : "widget-pill-amber") + '"' +
      ' title="Live WAN paths of the paths this gate has">' + r.alivePaths + "/" + r.totalPaths + "</span>";
    var href = "/assets.html#view=asset:" + encodeURIComponent(r.assetId) + "&tab=sdwan";
    return '<a class="dash-alert-item" href="' + href + '" data-asset-id="' + escapeHtml(r.assetId) + '" style="text-decoration:none">' +
      '<div class="dash-alert-row" style="width:100%">' +
        '<div class="dash-alert-body">' +
          '<div class="dash-alert-title">' + title + '</div>' +
          '<div class="dash-alert-sub">' + parts.join(" · ") + '</div>' +
        '</div>' +
        '<div class="dash-alert-time">' + pill + '</div>' +
      '</div>' +
    '</a>';
  }

  function render(el, rows, config) {
    config = config || {};
    rows = (rows || []).filter(function (r) { return config.showNoPath !== false || r.alivePaths > 0; });
    rows = PolarisWidgets.filterByMinSeverity(rows, config);
    rows = PolarisWidgets.applySort(rows, SORTS, config);
    PolarisWidgets.setHeaderSort(el, { options: SORTS, config: config });
    PolarisWidgets.setHeaderExport(el, {
      filename: "sdwan-single-link-sites",
      columns: [
        { header: "Hostname", get: function (r) { return r.hostname || ""; } },
        { header: "IP Address", get: function (r) { return r.ipAddress || ""; } },
        { header: "Site", get: function (r) { return r.site || ""; } },
        { header: "Live Paths", get: function (r) { return r.alivePaths; } },
        { header: "Total Paths", get: function (r) { return r.totalPaths; } },
        { header: "Live", get: function (r) { return (r.alive || []).join(" "); } },
        { header: "Down Members", get: function (r) { return (r.downMembers || []).join(" "); } },
      ],
      rows: rows,
    });
    var clipped = PolarisWidgets.clip(rows, config.rowLimit);
    PolarisWidgets.setHeaderSeverityCounts(el, clipped);
    if (!clipped.length) {
      var empty = PolarisWidgets.minSeverityEmptyText(config) || "Every SD-WAN site has a backup path";
      el.innerHTML = '<p class="empty-state">' + escapeHtml(empty) + '</p>';
      return;
    }
    el.innerHTML = clipped.map(rowHTML).join("");
  }

  PolarisWidgets.register({
    type: "sdwanSingleLink",
    category: "SD-WAN",
    label: "SD-WAN Sites on One Link",
    description: "SD-WAN gates built with two or more WAN paths that are down to one (or none) — still online, one failure from offline.",
    defaultSize: { width: 4, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: { rowLimit: 10, regionScope: "mine", showNoPath: true, sortBy: "severity" },
    requiredPermission: { key: "assets", level: "read" },

    fetchData: function (config) {
      return fetchRows(config).catch(function () { return []; });
    },

    renderInstance: function (el, config, data, ctx) {
      render(el, data, config);
      var onClick = function (ev) {
        if (ev.defaultPrevented || ev.button === 1 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
        var link = ev.target.closest(".dash-alert-item[data-asset-id]");
        if (!link || !el.contains(link)) return;
        ev.preventDefault();
        PolarisWidgets.openAssetDetail(link.getAttribute("data-asset-id"), { tab: "sdwan" });
      };
      el.addEventListener("click", onClick);
      var timer = setInterval(function () {
        fetchRows(config).then(function (rows) { render(el, rows, config); }).catch(function () {});
      }, PolarisWidgets.REFRESH.normal);
      ctx.onUnmount(function () { clearInterval(timer); el.removeEventListener("click", onClick); });
    },

    renderPreview: function (el) {
      render(el, [
        { assetId: "p1", hostname: "fgt-branch-22", ipAddress: "10.22.0.1", site: "Branch 22", alivePaths: 1, totalPaths: 2, alive: ["wan1"], downMembers: ["wan2", "Overlay-2"] },
        { assetId: "p2", hostname: "fgt-plant-a", ipAddress: "10.40.0.1", site: "Plant A", alivePaths: 0, totalPaths: 2, alive: [], downMembers: ["wan1", "wan2"] },
      ], { rowLimit: 5 });
    },

    renderConfig: function (el, config, onChange) {
      var showNone = config.showNoPath !== false;
      el.innerHTML =
        '<label class="widget-config-typeopt"><input type="checkbox" data-show="showNoPath"' + (showNone ? " checked" : "") + '> Include sites with no live path</label>' +
        '<label>Row limit</label>' +
        '<select data-k="rowLimit">' + PolarisWidgets.rowLimitOptionsHTML(config.rowLimit) + '</select>';
      el.querySelector("[data-show]").addEventListener("change", function (e) { onChange("showNoPath", e.target.checked); });
      el.querySelector("[data-k]").addEventListener("change", function (e) { onChange("rowLimit", PolarisWidgets.parseRowLimit(e.target.value)); });
      PolarisWidgets.renderMinSeverityConfig(el, config, onChange,
        "Only sites whose gate has an active SD-WAN member alert at or above this severity are shown.");
      // No asset-type filter: every SD-WAN row is a FortiGate.
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, false);
    },
  });
})();
