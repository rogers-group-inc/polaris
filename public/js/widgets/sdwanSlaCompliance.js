/**
 * widgets/sdwanSlaCompliance.js — how much of the last hour or day each SD-WAN
 * (health check, member) pair spent inside its SLA: alive, and no latency /
 * jitter / loss reading over the health check's target. The ISP-conversation
 * number. Ranked worst first; pairs that never left SLA are not listed.
 *
 * The feed's value is the time OUT of SLA (so a longer bar is worse, like every
 * other ranking, and the shared sort/red-guarantee logic reads it the right
 * way round); the label prints the compliance (100 − value). A health check
 * with no SLA target is judged on liveness alone and says so in its detail.
 * Shares the _topnBar renderer; data from noc-summary sdwanCompliance1h[] /
 * sdwanCompliance24h[] (one cached 24h pass server-side).
 */

(function () {
  var THRESHOLDS = [{ over: 5, color: "#ff1744" }, { over: 1, color: "#ffd600" }];

  function feedFor(config) {
    return (config && config.window) === "1h" ? "sdwanCompliance1h" : "sdwanCompliance24h";
  }

  function fetchRows(config) {
    var feed = feedFor(config);
    return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), [feed])
      .then(function (d) { return (d && d[feed]) || []; });
  }

  function compliance(v) {
    var c = Math.round((100 - v) * 100) / 100;
    return c + "% in SLA";
  }

  function render(el, config, rows) {
    var hour = (config && config.window) === "1h";
    PolarisTopN.renderRows(el, rows || [], {
      unit: "%", scale: "max", thresholds: THRESHOLDS, baseColor: "#4fc3f7", config: config || {},
      emptyText: hour ? "Every SD-WAN link stayed in SLA for the last hour" : "Every SD-WAN link stayed in SLA for the last 24 hours",
      valueNoun: "time out of SLA", valueHeader: hour ? "% out of SLA (1h)" : "% out of SLA (24h)",
      format: compliance,
    });
  }

  PolarisWidgets.register({
    type: "sdwanSlaCompliance",
    category: "SD-WAN",
    label: "SD-WAN SLA Compliance",
    description: "Share of the last hour or day each SD-WAN link spent within its health check's SLA, worst first. Links that never left SLA are not listed.",
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
        { id: "p1", hostname: "fgt-branch-22", value: 12.5, detail: "Default_DNS · wan2" },
        { id: "p2", hostname: "fgt-plant-a", value: 2.1, detail: "HQ_SLA · Overlay-1" },
        { id: "p3", hostname: "fgt-dc-west", value: 0.35, detail: "HQ_SLA · wan1" },
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
