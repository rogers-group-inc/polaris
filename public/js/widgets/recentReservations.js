/**
 * widgets/recentReservations.js — most-recent reservations. Source-type
 * filter (gear) lets operators include leases / VIPs / etc. in addition to
 * the default "manual only" view. Click a row → IPAM, focused on the IP.
 */

(function () {
  var SOURCE_TYPES = [
    "manual", "dhcp_reservation", "dhcp_lease", "interface_ip", "vip",
    "fortiswitch", "fortinap", "fortimanager", "fortigate", "dns_resolved", "external", "observed",
  ];

  function renderRows(el, rows, config) {
    var clipped = PolarisWidgets.clip(rows, config && config.rowLimit);
    if (!clipped.length) {
      el.innerHTML = '<p class="empty-state">No reservations match this filter</p>';
      return;
    }
    el.innerHTML = clipped.map(function (r) {
      var ip = r.ipAddress || "(full subnet)";
      var badges = '<code>' + escapeHtml(r.subnetCidr) + '</code>';
      if (r.vlan != null) badges += ' <span class="badge badge-vlan">VLAN ' + r.vlan + '</span>';
      var meta = [];
      if (r.hostname) meta.push(escapeHtml(r.hostname));
      if (r.owner) meta.push(escapeHtml(r.owner));
      if (r.createdBy) meta.push("by " + escapeHtml(r.createdBy));
      if (r.macAddress) meta.push('<code>' + escapeHtml(r.macAddress) + '</code>');
      var nav = "/ipam.html#tab=networks&subnet=" + encodeURIComponent(r.subnetId) + "&focusReservation=" + encodeURIComponent(r.id);
      return '<a class="recent-item recent-item-link" href="' + nav + '"><div>' +
        '<div class="recent-item-title"><span>' + escapeHtml(ip) + '</span>' + badges + '</div>' +
        '<div class="recent-item-meta"><span>' + escapeHtml(r.subnetName || "") + '</span>' +
        (meta.length ? '<span style="color:var(--color-text-tertiary)">·</span><span>' + meta.join(' · ') + '</span>' : '') +
        '</div>' +
        '</div><span class="recent-item-time">' + timeAgo(r.createdAt) + '</span></a>';
    }).join("");
  }

  // Shared by fetchData and the refresh timer so the two can't drift.
  function fetchRecent(config) {
    var wanted = (config && Array.isArray(config.sourceTypes)) ? config.sourceTypes : ["manual"];
    // Fetch only this widget's section; the shared getSummary memo dedupes
    // same-config widgets. recentLimit is sent only past the server's
    // 10-row default so default-config widgets share one cache slot.
    var serverLimit = PolarisWidgets.serverRowLimit(config && config.rowLimit);
    var needMore = (config && config.rowLimit === "none") || serverLimit > 10;
    return PolarisWidgets.getSummary({
      sections: ["recent"],
      sourceTypes: wanted,
      recentLimit: needMore ? serverLimit : null,
    })
      .then(function (data) { return (data && data.recentReservations) || []; })
      .catch(function () { return []; });
  }

  PolarisWidgets.register({
    type: "recentReservations",
    category: "IP Space",
    label: "Recently reserved",
    description: "Most-recent reservations. Filter by source type (manual, DHCP, VIPs, ...) from the gear menu.",
    defaultSize: { width: 6, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: { rowLimit: 10, sourceTypes: ["manual"] },
    // Mirrors the reservations:read gate on /dashboard/summary's recent section.
    requiredPermission: { key: "reservations", level: "read" },

    fetchData: function (config) {
      return fetchRecent(config);
    },

    renderInstance: function (el, config, data, ctx) {
      renderRows(el, data || [], config);
      var timer = setInterval(function () {
        fetchRecent(config).then(function (rows) { renderRows(el, rows || [], config); }).catch(function () {});
      }, PolarisWidgets.REFRESH.slow);
      ctx.onUnmount(function () { clearInterval(timer); });
    },

    renderPreview: function (el) {
      var now = Date.now();
      var mock = [
        { id: "p1", subnetId: "s1", ipAddress: "10.4.2.42", subnetCidr: "10.4.2.0/24", subnetName: "Branch HQ data", vlan: 142, hostname: "lab-vm-edge", createdBy: "anna", createdAt: new Date(now - 5 * 60 * 1000).toISOString() },
        { id: "p2", subnetId: "s2", ipAddress: "10.4.3.18", subnetCidr: "10.4.3.0/24", subnetName: "Branch HQ voice", vlan: 143, hostname: "polycom-conf", createdBy: "miguel", createdAt: new Date(now - 32 * 60 * 1000).toISOString() },
      ];
      renderRows(el, mock, { rowLimit: 2 });
    },

    renderConfig: function (el, config, onChange) {
      var current = new Set((config && config.sourceTypes) || ["manual"]);
      el.innerHTML =
        '<label>Source types</label>' +
        '<div style="display:flex;flex-wrap:wrap;gap:4px 8px;max-height:140px;overflow:auto;border:1px solid var(--color-border,rgba(255,255,255,0.1));border-radius:4px;padding:6px;">' +
          SOURCE_TYPES.map(function (s) {
            var id = "rrs_" + s;
            return '<label style="display:flex;align-items:center;gap:4px;font-size:0.78rem;margin:0">' +
              '<input type="checkbox" id="' + id + '" data-st="' + s + '"' + (current.has(s) ? " checked" : "") + '> ' + escapeHtml(s) +
            '</label>';
          }).join("") +
        '</div>' +
        '<label>Row limit</label>' +
        '<select data-k="rowLimit">' + PolarisWidgets.rowLimitOptionsHTML(config.rowLimit) + '</select>';
      el.querySelectorAll('input[data-st]').forEach(function (cb) {
        cb.addEventListener("change", function () {
          if (cb.checked) current.add(cb.getAttribute("data-st"));
          else current.delete(cb.getAttribute("data-st"));
          onChange("sourceTypes", Array.from(current));
        });
      });
      el.querySelector('[data-k="rowLimit"]').addEventListener("change", function (e) {
        onChange("rowLimit", PolarisWidgets.parseRowLimit(e.target.value));
      });
    },
  });
})();
