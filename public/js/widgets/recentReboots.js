/**
 * widgets/recentReboots.js — assets that rebooted recently (SolarWinds "Recent
 * Reboots"). Detected from device.reboot Events emitted when an SNMP sysUpTime
 * reading drops. Data from /dashboard/noc-summary recentReboots[].
 */

(function () {
  function render(el, rows) {
    rows = rows || [];
    // Header severity breakdown of the rows on screen — these rows arrive
    // already clipped to the Row limit (fetchData clips), so `rows` IS the
    // rendered set. Severity here is the reboot-relevant active alert the feed
    // attaches (eventRel "device.reboot"); a device that rebooted with no such
    // automation firing gets no bucket, so a quiet reboot list shows no pills.
    PolarisWidgets.setHeaderSeverityCounts(el, rows, { unalerted: "omit" });
    if (!rows.length) { el.innerHTML = '<p class="empty-state">No recent reboots</p>'; return; }
    el.innerHTML = rows.map(function (r) {
      var name = r.hostname || r.ipAddress || "(unnamed)";
      var meta = r.ipAddress && r.hostname ? escapeHtml(r.ipAddress) : "";
      var nav = r.id ? '/assets.html#view=asset:' + encodeURIComponent(r.id) : null;
      var tag = nav ? "a" : "div";
      var href = nav ? ' href="' + nav + '"' : "";
      return "<" + tag + ' class="recent-item' + (nav ? " recent-item-link" : "") + '"' + href + '><div>' +
        '<div class="recent-item-title"><span>' + escapeHtml(name) + '</span></div>' +
        (meta ? '<div class="recent-item-meta">' + meta + '</div>' : '') +
      '</div><span class="recent-item-time">' + timeAgo(r.rebootedAt) + '</span></' + tag + ">";
    }).join("");
  }

  PolarisWidgets.register({
    type: "recentReboots",
    category: "Monitoring",
    label: "Recent Reboots",
    description: "Devices that rebooted recently (detected from SNMP sysUpTime drops).",
    defaultSize: { width: 4, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: { rowLimit: 10, regionScope: "mine" },
    requiredPermission: { key: "events", level: "read" },

    fetchData: function (config) {
      return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["recentReboots"]).then(function (d) { return PolarisWidgets.clip((d && d.recentReboots) || [], config && config.rowLimit); }).catch(function () { return []; });
    },

    renderInstance: function (el, config, data, ctx) {
      render(el, data);
      PolarisWidgets.pollVisible(ctx, function () {
        PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["recentReboots"]).then(function (d) { render(el, PolarisWidgets.clip((d && d.recentReboots) || [], config && config.rowLimit)); }).catch(function () {});
      }, PolarisWidgets.REFRESH.slow);
    },

    renderPreview: function (el) {
      var now = Date.now();
      render(el, [
        { id: "p1", hostname: "core-sw-01", ipAddress: "10.0.0.1", rebootedAt: new Date(now - 35 * 60000).toISOString() },
        { id: "p2", hostname: "edge-fw-02", ipAddress: "10.0.0.2", rebootedAt: new Date(now - 5 * 3600000).toISOString() },
      ]);
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
