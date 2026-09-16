/**
 * widgets/topCpu.js — top-N monitored assets by average CPU%. Thin wrapper over
 * the shared _topnBar renderer; data from /dashboard/noc-summary topCpu[].
 */

(function () {
  var THRESHOLDS = [{ over: 90, color: "#ff1744" }, { over: 75, color: "#ffd600" }];
  var EMPTY = "No CPU telemetry";

  function render(el, config, rows) {
    PolarisTopN.renderRows(el, rows || [], {
      unit: "%", thresholds: THRESHOLDS, baseColor: "#4fc3f7", emptyText: EMPTY, config: config || {}, fillTo: 20,
      valueNoun: "CPU",
    });
  }

  PolarisWidgets.register({
    type: "topCpu",
    category: "Monitoring",
    label: "Highest Avg CPU",
    // Under the "Minimum severity" filter the widget lists the ALERTING rows
    // (sorted severity-first), not the fleet's top values — so the header drops
    // the superlative and gains the tier instead.
    severityLabel: "Avg CPU",
    description: "Monitored assets with the highest average CPU load (averaged over the last N polls — gear-configurable, default 10).",
    defaultSize: { width: 4, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: { rowLimit: 20, regionScope: "mine", sampleCount: 10, sortBy: "severity" },
    requiredPermission: { key: "assets", level: "read" },

    fetchData: function (config) {
      return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["topCpu"]).then(function (d) { return (d && d.topCpu) || []; }).catch(function () { return []; });
    },

    renderInstance: function (el, config, data, ctx) {
      render(el, config, data);
      var timer = setInterval(function () {
        PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["topCpu"]).then(function (d) { render(el, config, (d && d.topCpu) || []); }).catch(function () {});
      }, PolarisWidgets.REFRESH.slow);
      ctx.onUnmount(function () { clearInterval(timer); });
    },

    renderPreview: function (el) {
      render(el, { rowLimit: 3 }, [
        { id: "p1", hostname: "core-sw-01", value: 93 },
        { id: "p2", hostname: "edge-fw-02", value: 78 },
        { id: "p3", hostname: "app-srv-11", value: 54 },
      ]);
    },

    renderConfig: function (el, config, onChange) {
      // No "Hide below" control: Row limit governs the top-N shown, and every
      // red row (≥90%) always shows even past the limit (see _topnBar fillTo).
      // sampleControl = the "Average over" N-samples select (sampleCount).
      PolarisTopN.renderConfig(el, config, onChange, { sampleControl: true });
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, true);
    },
  });
})();
