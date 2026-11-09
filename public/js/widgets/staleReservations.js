/**
 * widgets/staleReservations.js — count + top N stale DHCP reservations.
 * Permission-gated on `staleReservations:read` so users without visibility
 * into the alerts queue don't see the widget in the library.
 */

(function () {
  function renderRows(el, rows, total, rowLimit) {
    if (!total) { el.innerHTML = '<p class="empty-state">No stale reservations</p>'; return; }
    var clipped = PolarisWidgets.clip(rows, rowLimit);
    var pillCls = "widget-pill-watch";
    if (total >= 25) pillCls = "widget-pill-red";
    else if (total >= 10) pillCls = "widget-pill-amber";
    var header = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
      '<span class="widget-pill ' + pillCls + '">' + total + ' stale</span>' +
      '<a href="/events.html#tab=stale-reservations" style="font-size:0.8rem;color:var(--color-text-secondary)">View all →</a>' +
    '</div>';
    var body = clipped.map(function (r) {
      var ip = r.ipAddress || "(no IP)";
      var sub = (r.hostname ? escapeHtml(r.hostname) + ' · ' : '') + escapeHtml(r.subnetCidr || "");
      var nav = "/ipam.html#tab=networks&subnet=" + encodeURIComponent(r.subnetId) + "&focusReservation=" + encodeURIComponent(r.id);
      var days = r.daysSinceSeen != null ? r.daysSinceSeen + 'd' : '—';
      return '<a class="recent-item recent-item-link" href="' + nav + '"><div>' +
        '<div class="recent-item-title"><span>' + escapeHtml(ip) + '</span></div>' +
        '<div class="recent-item-meta">' + sub + '</div>' +
      '</div><span class="recent-item-time">' + days + '</span></a>';
    }).join("");
    el.innerHTML = header + body;
  }

  // Shared by fetchData and the refresh timer so the two can't drift.
  function fetchStale() {
    return Promise.all([
      api.reservations.listAlerts("active").catch(function () { return []; }),
      api.reservations.alertsCount().catch(function () { return { count: 0 }; }),
    ]).then(function (out) {
      return { rows: out[0] || [], total: (out[1] && out[1].count) || 0 };
    });
  }

  PolarisWidgets.register({
    type: "staleReservations",
    category: "IP Space",
    label: "Stale reservations",
    description: "DHCP reservations whose client hasn't held the IP recently — candidates for cleanup.",
    defaultSize: { width: 4, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: { rowLimit: 5 },
    requiredPermission: { key: "staleReservations", level: "read" },

    fetchData: function () {
      return fetchStale();
    },

    renderInstance: function (el, config, data, ctx) {
      renderRows(el, data.rows || [], data.total || 0, config && config.rowLimit);
      PolarisWidgets.pollVisible(ctx, function () {
        fetchStale().then(function (d) { renderRows(el, (d && d.rows) || [], (d && d.total) || 0, config && config.rowLimit); }).catch(function () {});
      }, PolarisWidgets.REFRESH.slow);
    },

    renderPreview: function (el) {
      var mock = [
        { id: "p1", ipAddress: "10.4.2.42", subnetId: "s1", subnetCidr: "10.4.2.0/24", hostname: "lab-printer-old", daysSinceSeen: 92 },
        { id: "p2", ipAddress: "10.4.2.51", subnetId: "s1", subnetCidr: "10.4.2.0/24", hostname: "guest-vm-temp", daysSinceSeen: 71 },
      ];
      renderRows(el, mock, 12, 2);
    },

    renderConfig: function (el, config, onChange) {
      el.innerHTML =
        '<label>Row limit</label>' +
        '<select data-k="rowLimit">' + PolarisWidgets.rowLimitOptionsHTML(config.rowLimit) + '</select>';
      el.querySelector('[data-k="rowLimit"]').addEventListener("change", function (e) {
        onChange("rowLimit", PolarisWidgets.parseRowLimit(e.target.value));
      });
    },
  });
})();
