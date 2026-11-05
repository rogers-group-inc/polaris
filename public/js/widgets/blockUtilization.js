/**
 * widgets/blockUtilization.js — per-block address allocation bars. Sort by
 * percent (default; busiest blocks float to the top) or by name. Click a
 * row to drill into IPAM.
 */

(function () {
  function fmtAddrs(n) {
    if (n == null) return null;
    if (n >= 1048576) return (n / 1048576).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1024)    return Math.round(n / 1024) + "K";
    return String(n);
  }

  function renderRows(el, rows, config) {
    if (!rows.length) { el.innerHTML = '<p class="empty-state">No blocks yet</p>'; return; }
    var sorted = rows.slice();
    if ((config && config.sortBy) === "name") {
      sorted.sort(function (a, b) { return (a.name || "").localeCompare(b.name || ""); });
    } else {
      sorted.sort(function (a, b) { return (b.usedPercent || 0) - (a.usedPercent || 0); });
    }
    sorted = PolarisWidgets.clip(sorted, config && config.rowLimit);
    el.innerHTML = sorted.map(function (b) {
      var pct = b.usedPercent != null ? b.usedPercent : 0;
      var color = pct > 75 ? "#ff1744" : pct > 50 ? "#ffd600" : "#4fc3f7";
      var addrLabel = (b.blockAddresses != null)
        ? fmtAddrs(b.allocatedAddresses) + ' / ' + fmtAddrs(b.blockAddresses) + ' IPs'
        : b.totalSubnets + ' subnets';
      var nav = "/ipam.html#tab=networks&block=" + encodeURIComponent(b.id);
      return '<a class="block-util-item block-util-link" href="' + nav + '">' +
        '<div class="block-util-header"><div class="block-util-name"><span>' + escapeHtml(b.name) + '</span><code>' + escapeHtml(b.cidr) + '</code></div><span class="block-util-count">' + addrLabel + '</span></div>' +
        '<div class="util-row"><div class="util-bar-track"><div class="util-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div><span style="font-size:0.82rem;color:var(--color-text-secondary);min-width:32px;text-align:right">' + pct + '%</span></div>' +
      '</a>';
    }).join("");
  }

  // Shared by fetchData and the refresh timer so the two can't drift.
  function fetchBlocks() {
    return PolarisWidgets.getSummary({ sections: ["blocks"] })
      .then(function (d) { return (d && d.blockUtilization) || []; })
      .catch(function () { return []; });
  }

  PolarisWidgets.register({
    type: "blockUtilization",
    category: "IP Space",
    label: "Block utilization",
    description: "IP block address-space utilization. Busiest blocks float to the top by default.",
    defaultSize: { width: 6, height: 1 },
    minSize: { width: 4, height: 1 },
    defaultConfig: { rowLimit: 10, sortBy: "percent" },
    // Mirrors the ipBlocks:read gate on /dashboard/summary's blocks section.
    // The function key is `ipBlocks`, not `blocks` (FUNCTION_KEYS).
    requiredPermission: { key: "ipBlocks", level: "read" },

    fetchData: function (_config) {
      return fetchBlocks();
    },

    renderInstance: function (el, config, data, ctx) {
      renderRows(el, data || [], config);
      PolarisWidgets.pollVisible(ctx, function () {
        fetchBlocks().then(function (rows) { renderRows(el, rows || [], config); }).catch(function () {});
      }, PolarisWidgets.REFRESH.slow);
    },

    renderPreview: function (el) {
      var mock = [
        { id: "p1", name: "Branch HQ",  cidr: "10.4.0.0/16",    blockAddresses: 65536, allocatedAddresses: 51200, usedPercent: 78, totalSubnets: 14 },
        { id: "p2", name: "DMZ",        cidr: "172.16.0.0/22",  blockAddresses: 1024,  allocatedAddresses: 410,  usedPercent: 40, totalSubnets: 4 },
        { id: "p3", name: "Mfg floor",  cidr: "10.10.0.0/20",   blockAddresses: 4096,  allocatedAddresses: 820,  usedPercent: 20, totalSubnets: 6 },
      ];
      renderRows(el, mock, { rowLimit: 3, sortBy: "percent" });
    },

    renderConfig: function (el, config, onChange) {
      el.innerHTML =
        '<label>Sort by</label>' +
        '<select data-k="sortBy">' +
          '<option value="percent"' + ((config.sortBy || "percent") === "percent" ? " selected" : "") + '>Utilization %</option>' +
          '<option value="name"' + (config.sortBy === "name" ? " selected" : "") + '>Name</option>' +
        '</select>' +
        '<label>Row limit</label>' +
        '<select data-k="rowLimit">' + PolarisWidgets.rowLimitOptionsHTML(config.rowLimit) + '</select>';
      el.querySelectorAll("[data-k]").forEach(function (s) {
        s.addEventListener("change", function () {
          var k = s.getAttribute("data-k");
          onChange(k, k === "rowLimit" ? PolarisWidgets.parseRowLimit(s.value) : s.value);
        });
      });
    },
  });
})();
