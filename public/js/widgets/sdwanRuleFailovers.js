/**
 * widgets/sdwanRuleFailovers.js — SD-WAN service rules that are not where they
 * should be: carrying traffic on a member other than the one they prefer
 * ("failed over" — steering has reacted to something even if nothing is down
 * yet), or down with no usable member at all. Only rules whose mode orders its
 * members (lowest-cost SLA, manual) can be off their preferred link; best-
 * quality and load-balance rules move by design and are never listed as failed
 * over. Zone-based rules prefer every member of their first zone. Grouped by
 * gate like Down Interfaces; click a row to open the gate on its SD-WAN tab.
 * Data from noc-summary sdwanRuleFailovers[] — current state only (rule
 * history is not kept), so there is no "since".
 */

(function () {
  var FEED = "sdwanRuleFailovers";

  function fetchRows(config) {
    return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), [FEED])
      .then(function (d) { return (d && d[FEED]) || []; });
  }

  // Gear "Show": either kind can be switched off (default both on).
  function filterKinds(rows, config) {
    config = config || {};
    var wantFailed = config.showFailedOver !== false;
    var wantDown = config.showDown !== false;
    return (rows || []).filter(function (r) { return r.state === "down" ? wantDown : wantFailed; });
  }

  function gateOf(r) { return r.hostname || r.ipAddress || "(unknown)"; }

  var CMP = PolarisWidgets.sortCmp;
  function isDown(r) { return r.state === "down"; }
  // options[0] is the feed's own order: severity, then down rules ahead of
  // failed-over ones.
  var SORTS = [
    { key: "severity", label: "Severity, then down first", cmp: CMP.then(CMP.severity(), CMP.flagFirst(isDown)) },
    { key: "gate", label: "Gate A–Z, then rule", cmp: CMP.then(CMP.text(gateOf), CMP.text(function (r) { return r.ruleName; })) },
    { key: "rule", label: "Rule A–Z", cmp: CMP.then(CMP.text(function (r) { return r.ruleName; }), CMP.text(gateOf)) },
  ];

  function rowHTML(r) {
    var down = r.state === "down";
    var title = (PolarisWidgets.alertSeverityPill ? PolarisWidgets.alertSeverityPill(r.alertSeverity) : "") +
      escapeHtml(r.ruleName || "(rule)");
    var preferred = (r.preferredMembers || []).join(", ");
    var parts = [];
    if (down) parts.push("no usable member");
    else parts.push("on " + escapeHtml(r.selectedMember || "?"));
    if (preferred) parts.push("prefers " + escapeHtml(preferred));
    parts.push(escapeHtml(gateOf(r)));
    var pill = down
      ? '<span class="widget-pill widget-pill-red">down</span>'
      : '<span class="widget-pill widget-pill-amber">failed over</span>';
    var href = "/assets.html#view=asset:" + encodeURIComponent(r.assetId) + "&tab=sdwan";
    return '<a class="dash-alert-item" href="' + href + '" data-asset-id="' + escapeHtml(r.assetId) + '" style="text-decoration:none">' +
      '<div class="dash-alert-row" style="width:100%">' +
        '<div class="dash-alert-body">' +
          '<div class="dash-alert-title">' + title + '</div>' +
          '<div class="dash-alert-sub">' + parts.join(" · ") + '</div>' +
        '</div>' +
        '<div class="dash-alert-time" title="' + escapeHtml(r.mode ? "Rule mode: " + r.mode : "") + '">' + pill + '</div>' +
      '</div>' +
    '</a>';
  }

  function render(el, rows, config) {
    config = config || {};
    rows = PolarisWidgets.filterByMinSeverity(filterKinds(rows, config), config);
    rows = PolarisWidgets.applySort(rows, SORTS, config);
    PolarisWidgets.setHeaderSort(el, { options: SORTS, config: config });
    PolarisWidgets.setHeaderExport(el, {
      filename: "sdwan-rule-failovers",
      columns: [
        { header: "Gate", get: gateOf },
        { header: "IP Address", get: function (r) { return r.ipAddress || ""; } },
        { header: "Rule", get: function (r) { return r.ruleName || ""; } },
        { header: "State", get: function (r) { return r.state === "down" ? "Down" : "Failed over"; } },
        { header: "Selected Member", get: function (r) { return r.selectedMember || ""; } },
        { header: "Preferred", get: function (r) { return (r.preferredMembers || []).join(" "); } },
        { header: "Mode", get: function (r) { return r.mode || ""; } },
        { header: "Site", get: function (r) { return r.site || ""; } },
      ],
      rows: rows,
    });
    var clipped = PolarisWidgets.clip(rows, config.rowLimit);
    PolarisWidgets.setHeaderSeverityCounts(el, clipped);
    if (!clipped.length) {
      var empty = PolarisWidgets.minSeverityEmptyText(config) || "Every SD-WAN rule is on its preferred link";
      el.innerHTML = '<p class="empty-state">' + escapeHtml(empty) + '</p>';
      return;
    }
    if ((config.groupBy || "gate") === "none") {
      el.innerHTML = clipped.map(rowHTML).join("");
      return;
    }
    var groups = {};
    var order = [];
    clipped.forEach(function (r) {
      var k = gateOf(r);
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(r);
    });
    el.innerHTML = order.map(function (k) {
      var list = groups[k];
      return '<div class="dash-alert-group-header" style="display:flex;align-items:center;gap:8px;margin:6px 0 4px;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.03em;color:var(--color-text-secondary)">' +
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(k) + '</span>' +
        '<span class="' + PolarisWidgets.countPillClass(list) + '">' + list.length + '</span>' +
      '</div>' + list.map(rowHTML).join("");
    }).join("");
  }

  PolarisWidgets.register({
    type: "sdwanRuleFailovers",
    category: "SD-WAN",
    label: "SD-WAN Rules Off Preferred Link",
    description: "SD-WAN service rules carrying traffic on a member other than the one they prefer, plus rules with no usable member, grouped by gate.",
    defaultSize: { width: 6, height: 1 },
    minSize: { width: 4, height: 1 },
    defaultConfig: { groupBy: "gate", rowLimit: 10, regionScope: "mine", showFailedOver: true, showDown: true, sortBy: "severity" },
    requiredPermission: { key: "assets", level: "read" },

    fetchData: function (config) {
      return fetchRows(config).catch(function () { return []; });
    },

    renderInstance: function (el, config, data, ctx) {
      render(el, data, config);
      // Click a row → the gate's slide-over on its SD-WAN tab, in place;
      // modified clicks keep the href.
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
        { assetId: "p1", hostname: "fgt-branch-22", ipAddress: "10.22.0.1", site: "Branch 22", ruleName: "VoIP", mode: "sla", state: "failedOver", selectedMember: "wan2", preferredMembers: ["wan1"] },
        { assetId: "p1", hostname: "fgt-branch-22", ipAddress: "10.22.0.1", site: "Branch 22", ruleName: "Office365", mode: "sla", state: "failedOver", selectedMember: "wan2", preferredMembers: ["wan1"] },
        { assetId: "p2", hostname: "fgt-plant-a", ipAddress: "10.40.0.1", site: "Plant A", ruleName: "To-HQ", mode: "manual", state: "down", selectedMember: null, preferredMembers: ["Overlay-1"] },
      ], { groupBy: "gate", rowLimit: 5 });
    },

    renderConfig: function (el, config, onChange) {
      var showFailed = config.showFailedOver !== false;
      var showDown = config.showDown !== false;
      el.innerHTML =
        '<label>Show</label>' +
        '<div class="widget-config-typegrid">' +
          '<label class="widget-config-typeopt"><input type="checkbox" data-show="showFailedOver"' + (showFailed ? " checked" : "") + '> Failed over</label>' +
          '<label class="widget-config-typeopt"><input type="checkbox" data-show="showDown"' + (showDown ? " checked" : "") + '> Down (no usable member)</label>' +
        '</div>' +
        '<label>Group by</label>' +
        '<select data-k="groupBy">' +
          '<option value="gate"' + ((config.groupBy || "gate") === "gate" ? " selected" : "") + '>Gate</option>' +
          '<option value="none"' + (config.groupBy === "none" ? " selected" : "") + '>None</option>' +
        '</select>' +
        '<label>Row limit</label>' +
        '<select data-k="rowLimit">' + PolarisWidgets.rowLimitOptionsHTML(config.rowLimit) + '</select>';
      el.querySelectorAll("[data-show]").forEach(function (cb) {
        cb.addEventListener("change", function () { onChange(cb.getAttribute("data-show"), cb.checked); });
      });
      el.querySelectorAll("[data-k]").forEach(function (s) {
        s.addEventListener("change", function () {
          var k = s.getAttribute("data-k");
          onChange(k, k === "rowLimit" ? PolarisWidgets.parseRowLimit(s.value) : s.value);
        });
      });
      PolarisWidgets.renderMinSeverityConfig(el, config, onChange,
        "Only rules whose gate has an active SD-WAN rule alert at or above this severity are shown.");
      // No asset-type filter: every SD-WAN row is a FortiGate.
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, false);
    },
  });
})();
