/**
 * widgets/slowestResponse.js — top-N monitored assets by latest probe response
 * time (ms). Shares the _topnBar renderer; data from noc-summary
 * slowestResponse[].
 */

(function () {
  var THRESHOLDS = [{ over: 500, color: "#ff1744" }, { over: 200, color: "#ffd600" }];
  var EMPTY = "No response-time data";

  function render(el, config, rows) {
    PolarisTopN.renderRows(el, rows || [], {
      unit: "ms", thresholds: THRESHOLDS, baseColor: "#4fc3f7", emptyText: EMPTY, config: config || {}, fillTo: 20,
      valueNoun: "response time",
    });
  }

  PolarisWidgets.register({
    type: "slowestResponse",
    category: "Monitoring",
    label: "Slowest Response",
    // Under the "Minimum severity" filter the widget lists the ALERTING rows
    // (sorted severity-first), not the fleet's top values — so the header drops
    // the superlative and gains the tier instead.
    severityLabel: "Response Time",
    description: "Monitored assets with the highest average response time (last 10 probes).",
    defaultSize: { width: 4, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: { rowLimit: 20, regionScope: "mine", sortBy: "severity" },
    requiredPermission: { key: "assets", level: "read" },

    fetchData: function (config) {
      return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["slowestResponse"]).then(function (d) { return (d && d.slowestResponse) || []; }).catch(function () { return []; });
    },

    renderInstance: function (el, config, data, ctx) {
      render(el, config, data);
      var timer = setInterval(function () {
        PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["slowestResponse"]).then(function (d) { render(el, config, (d && d.slowestResponse) || []); }).catch(function () {});
      }, PolarisWidgets.REFRESH.slow);
      ctx.onUnmount(function () { clearInterval(timer); });
    },

    renderPreview: function (el) {
      render(el, { rowLimit: 3 }, [
        { id: "p1", hostname: "branch-fw-22", value: 640 },
        { id: "p2", hostname: "wan-rtr-03", value: 280 },
        { id: "p3", hostname: "core-sw-01", value: 90 },
      ]);
    },

    renderConfig: function (el, config, onChange) {
      // No "Hide below" control: Row limit governs the top-N shown, and every
      // red row (≥500 ms) always shows even past the limit (see _topnBar fillTo).
      PolarisTopN.renderConfig(el, config, onChange, {});
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, true);
    },
  });
})();
