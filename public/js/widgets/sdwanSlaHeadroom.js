/**
 * widgets/sdwanSlaHeadroom.js — SD-WAN members closest to breaching their
 * health check's SLA target. Each live (health check, member) pair ranks on how
 * much of its target its readings use, averaged over the last 15 minutes, on
 * whichever metric (latency / jitter / loss) is nearest its line — so 100% is
 * the SLA and past it is already out. Catches a link before the out-of-SLA
 * list does. Shares the _topnBar renderer; data from noc-summary
 * sdwanSlaHeadroom[]. Dead members and health checks with no SLA target are
 * left out server-side.
 */

(function () {
  var THRESHOLDS = [{ over: 90, color: "#ff1744" }, { over: 70, color: "#ffd600" }];
  var FEED = "sdwanSlaHeadroom";

  function fetchRows(config) {
    return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), [FEED])
      .then(function (d) { return (d && d[FEED]) || []; });
  }

  function render(el, config, rows) {
    PolarisTopN.renderRows(el, rows || [], {
      unit: "%", thresholds: THRESHOLDS, baseColor: "#4fc3f7", config: config || {}, fillTo: 20,
      emptyText: "No SD-WAN health checks with an SLA target",
      valueNoun: "SLA use", valueHeader: "% of SLA target",
    });
  }

  PolarisWidgets.register({
    type: "sdwanSlaHeadroom",
    category: "SD-WAN",
    label: "SD-WAN SLA Headroom",
    description: "SD-WAN members ranked by how close their latency, jitter or loss is to the health check's SLA target (15-minute average). 100% is the line.",
    defaultSize: { width: 4, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: { rowLimit: 20, regionScope: "mine", sortBy: "severity" },
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
        { id: "p1", hostname: "fgt-branch-22", value: 96.5, detail: "Default_DNS · wan2 · loss 1.93% of 2%" },
        { id: "p2", hostname: "fgt-plant-a", value: 78, detail: "HQ_SLA · Overlay-1 · latency 117 ms of 150 ms" },
        { id: "p3", hostname: "fgt-dc-west", value: 31.2, detail: "HQ_SLA · wan1 · jitter 9.4 ms of 30 ms" },
      ]);
    },

    renderConfig: function (el, config, onChange) {
      PolarisTopN.renderConfig(el, config, onChange, {});
      // No asset-type filter: every SD-WAN row is a FortiGate.
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, false);
    },
  });
})();
