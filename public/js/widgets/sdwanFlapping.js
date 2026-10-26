/**
 * widgets/sdwanFlapping.js — SD-WAN members that keep bouncing: how many times
 * each went up → down in the last hour or day (gear "Window"). A member that
 * drops twenty times for a minute each never stays down long enough to sit on
 * the failures list, which is what this catches. One row per member: the count
 * is its worst health check's, since a bounce shows in every health check
 * probing it. Shares the _topnBar renderer; data from noc-summary
 * sdwanFlaps1h[] / sdwanFlaps24h[] (one cached 24h pass server-side).
 */

(function () {
  // Drops in the window, not a percentage — bars scale to the worst member.
  var THRESHOLDS_1H = [{ over: 4, color: "#ff1744" }, { over: 2, color: "#ffd600" }];
  var THRESHOLDS_24H = [{ over: 12, color: "#ff1744" }, { over: 4, color: "#ffd600" }];

  function feedFor(config) {
    return (config && config.window) === "1h" ? "sdwanFlaps1h" : "sdwanFlaps24h";
  }

  function fetchRows(config) {
    var feed = feedFor(config);
    return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), [feed])
      .then(function (d) { return (d && d[feed]) || []; });
  }

  function render(el, config, rows) {
    var hour = (config && config.window) === "1h";
    PolarisTopN.renderRows(el, rows || [], {
      unit: "count", thresholds: hour ? THRESHOLDS_1H : THRESHOLDS_24H, baseColor: "#4fc3f7", config: config || {},
      emptyText: hour ? "No SD-WAN member dropped in the last hour" : "No SD-WAN member dropped in the last 24 hours",
      valueNoun: "drops", valueHeader: hour ? "Drops (1h)" : "Drops (24h)",
      format: function (v) { return v + (v === 1 ? " drop" : " drops"); },
    });
  }

  PolarisWidgets.register({
    type: "sdwanFlapping",
    category: "SD-WAN",
    label: "SD-WAN Flapping Links",
    description: "SD-WAN members ranked by how many times they went down in the last hour or day — links that bounce without staying down.",
    defaultSize: { width: 4, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: { window: "24h", rowLimit: 20, regionScope: "mine", sortBy: "severity" },
    requiredPermission: { key: "assets", level: "read" },

    fetchData: function (config) {
      return fetchRows(config).catch(function () { return []; });
    },

    renderInstance: function (el, config, data, ctx) {
      render(el, config, data);
      var timer = setInterval(function () {
        fetchRows(config).then(function (rows) { render(el, config, rows); }).catch(function () {});
      }, PolarisWidgets.REFRESH.slow);
      ctx.onUnmount(function () { clearInterval(timer); });
    },

    renderPreview: function (el) {
      render(el, { rowLimit: 3 }, [
        { id: "p1", hostname: "fgt-branch-22", value: 17, detail: "wan2 · Default_DNS" },
        { id: "p2", hostname: "fgt-plant-a", value: 5, detail: "Overlay-2 · HQ_SLA" },
        { id: "p3", hostname: "fgt-dc-west", value: 1, detail: "wan1 · HQ_SLA" },
      ]);
    },

    renderConfig: function (el, config, onChange) {
      PolarisTopN.renderConfig(el, config, onChange, {});
      var win = config.window === "1h" ? "1h" : "24h";
      el.insertAdjacentHTML("afterbegin",
        '<label>Window</label>' +
        '<select data-sdwan-window>' +
          '<option value="1h"' + (win === "1h" ? " selected" : "") + '>Last hour</option>' +
          '<option value="24h"' + (win === "24h" ? " selected" : "") + '>Last 24 hours</option>' +
        '</select>');
      el.querySelector("[data-sdwan-window]").addEventListener("change", function (e) { onChange("window", e.target.value); });
      // No asset-type filter: every SD-WAN row is a FortiGate.
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, false);
    },
  });
})();
