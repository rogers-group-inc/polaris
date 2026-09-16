/**
 * widgets/diskUsage.js — top monitored filesystems by used %. One row PER VOLUME
 * (host + mount path), ranked fullest-first. Thin wrapper over the shared
 * _topnBar renderer; data from /dashboard/noc-summary diskUsage[]. Like Highest
 * CPU/Memory the Row limit governs the top-N shown and every red row (≥90%)
 * always shows even past the limit.
 */

(function () {
  var THRESHOLDS = [{ over: 90, color: "#ff1744" }, { over: 75, color: "#ffd600" }];
  var EMPTY = "No storage telemetry";

  function render(el, config, rows) {
    PolarisTopN.renderRows(el, rows || [], {
      unit: "%", thresholds: THRESHOLDS, baseColor: "#4fc3f7", emptyText: EMPTY, config: config || {}, fillTo: 20,
      valueNoun: "disk usage",
    });
  }

  PolarisWidgets.register({
    type: "diskUsage",
    category: "Monitoring",
    label: "Highest Disk Usage",
    // Under the "Minimum severity" filter the widget lists the ALERTING rows
    // (sorted severity-first), not the fleet's top values — so the header drops
    // the superlative and gains the tier instead.
    severityLabel: "Disk Usage",
    description: "Monitored filesystems with the highest used percentage, per volume.",
    defaultSize: { width: 4, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: { rowLimit: 20, regionScope: "mine", sortBy: "severity" },
    requiredPermission: { key: "assets", level: "read" },

    fetchData: function (config) {
      return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["diskUsage"]).then(function (d) { return (d && d.diskUsage) || []; }).catch(function () { return []; });
    },

    renderInstance: function (el, config, data, ctx) {
      render(el, config, data);
      var timer = setInterval(function () {
        PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["diskUsage"]).then(function (d) { render(el, config, (d && d.diskUsage) || []); }).catch(function () {});
      }, PolarisWidgets.REFRESH.slow);
      ctx.onUnmount(function () { clearInterval(timer); });
    },

    renderPreview: function (el) {
      render(el, {}, [
        { id: "p1", hostname: "db-srv-04", detail: "/var", value: 96 },
        { id: "p2", hostname: "vm-host-09", detail: "C:", value: 82 },
        { id: "p3", hostname: "app-srv-11", detail: "/", value: 57 },
      ]);
    },

    renderConfig: function (el, config, onChange) {
      // No "Hide below" control: Row limit governs the top-N shown; every red
      // row (≥90%) always shows even past the limit.
      PolarisTopN.renderConfig(el, config, onChange, {});
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, true);
    },
  });
})();
