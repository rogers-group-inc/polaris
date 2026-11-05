/**
 * widgets/stalePolls.js — monitored assets overdue for their next response-time
 * poll (SolarWinds "Stale Polls"). Count pill + simple list with overdue time.
 * Data from /dashboard/noc-summary stalePolls[].
 */

(function () {
  function render(el, rows, config) {
    rows = rows || [];
    if (!rows.length) { el.innerHTML = '<p class="empty-state">No stale polls</p>'; return; }
    var pillCls = rows.length >= 25 ? "widget-pill-red" : rows.length >= 10 ? "widget-pill-amber" : "widget-pill-watch";
    var header = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
      '<span class="widget-pill ' + pillCls + '">' + rows.length + ' overdue</span>' +
    '</div>';
    var body = PolarisWidgets.clip(rows, config && config.rowLimit).map(function (r) {
      var name = r.hostname || r.ipAddress || "(unnamed)";
      var meta = r.ipAddress && r.hostname ? escapeHtml(r.ipAddress) : ("every " + Math.round((r.expectedIntervalSec || 0)) + "s");
      var overdue = r.lastPolledAt ? PolarisWidgets.durationSince(r.lastPolledAt) : "never";
      var nav = '/assets.html#view=asset:' + encodeURIComponent(r.id);
      return '<a class="recent-item recent-item-link" href="' + nav + '"><div>' +
        '<div class="recent-item-title"><span>' + escapeHtml(name) + '</span></div>' +
        '<div class="recent-item-meta">' + meta + '</div>' +
      '</div><span class="recent-item-time" style="color:#ffa726">' + overdue + '</span></a>';
    }).join("");
    el.innerHTML = header + body;
  }

  PolarisWidgets.register({
    type: "stalePolls",
    category: "Monitoring",
    label: "Stale Polls",
    description: "Monitored assets overdue for their next response-time probe.",
    defaultSize: { width: 4, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: { rowLimit: 10, regionScope: "mine" },
    requiredPermission: { key: "assets", level: "read" },

    fetchData: function (config) {
      return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["stalePolls"]).then(function (d) { return (d && d.stalePolls) || []; }).catch(function () { return []; });
    },

    renderInstance: function (el, config, data, ctx) {
      render(el, data, config);
      PolarisWidgets.pollVisible(ctx, function () {
        PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["stalePolls"]).then(function (d) { render(el, (d && d.stalePolls) || [], config); }).catch(function () {});
      }, PolarisWidgets.REFRESH.normal);
    },

    renderPreview: function (el) {
      var now = Date.now();
      render(el, [
        { id: "p1", hostname: "old-switch-7", ipAddress: "10.2.0.7", lastPolledAt: new Date(now - 22 * 60000).toISOString(), expectedIntervalSec: 60 },
        { id: "p2", hostname: "lab-rtr-2", ipAddress: "10.2.0.9", lastPolledAt: new Date(now - 70 * 60000).toISOString(), expectedIntervalSec: 120 },
      ], { rowLimit: 5 });
    },

    renderConfig: function (el, config, onChange) {
      el.innerHTML =
        '<label>Row limit</label>' +
        '<select data-k="rowLimit">' + PolarisWidgets.rowLimitOptionsHTML(config.rowLimit) + '</select>';
      el.querySelector('[data-k="rowLimit"]').addEventListener("change", function (e) {
        onChange("rowLimit", PolarisWidgets.parseRowLimit(e.target.value));
      });
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, true);
    },
  });
})();
