/**
 * widgets/packetLoss.js — top-N monitored assets by recent probe packet loss
 * (failed-probe ratio %, computed server-side). Shares the _topnBar renderer;
 * data from noc-summary packetLoss[]. No "Hide below %" control: the gear's
 * Minimum severity filter is the display filter, and a second numeric floor
 * was just another way to hide the same row (a stored `threshold` from before
 * that control was removed is ignored).
 * Fully-down assets (100% loss — zero successful probes in the window) are
 * excluded server-side; those belong to the Down Assets widget.
 */

(function () {
  var THRESHOLDS = [{ over: 25, color: "#ff1744" }, { over: 5, color: "#ffd600" }];
  var EMPTY = "No packet loss";

  function render(el, config, rows) {
    PolarisTopN.renderRows(el, rows || [], {
      unit: "%", thresholds: THRESHOLDS, baseColor: "#4fc3f7", emptyText: EMPTY, config: config || {},
      valueNoun: "loss",
    });
  }

  PolarisWidgets.register({
    type: "packetLoss",
    category: "Monitoring",
    label: "Packet Loss",
    description: "Monitored assets with the highest recent probe loss (failed-probe ratio). Fully-down assets (100% loss) are excluded — see Down Assets.",
    defaultSize: { width: 4, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: { rowLimit: 1000, regionScope: "mine", sortBy: "severity" },
    requiredPermission: { key: "assets", level: "read" },

    fetchData: function (config) {
      return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["packetLoss"]).then(function (d) { return (d && d.packetLoss) || []; }).catch(function () { return []; });
    },

    renderInstance: function (el, config, data, ctx) {
      render(el, config, data);
      var timer = setInterval(function () {
        PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["packetLoss"]).then(function (d) { render(el, config, (d && d.packetLoss) || []); }).catch(function () {});
      }, PolarisWidgets.REFRESH.slow);
      ctx.onUnmount(function () { clearInterval(timer); });
    },

    renderPreview: function (el) {
      render(el, { rowLimit: 3 }, [
        { id: "p1", hostname: "branch-fw-22", value: 40 },
        { id: "p2", hostname: "wan-rtr-03", value: 12.5 },
        { id: "p3", hostname: "ap-lobby-07", value: 3 },
      ]);
    },

    renderConfig: function (el, config, onChange) {
      PolarisTopN.renderConfig(el, config, onChange, {});
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, true);
    },
  });
})();
