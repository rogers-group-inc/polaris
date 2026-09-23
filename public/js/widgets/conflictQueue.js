/**
 * widgets/conflictQueue.js — pending discovery conflicts. Role-scoped by
 * the underlying /conflicts endpoint (admin sees both flavors,
 * networkadmin sees reservations, assetsadmin sees assets) — we just
 * surface what the API returns. Permission-gated on discoveryConflicts:read.
 */

(function () {
  function renderRows(el, count, rows) {
    if (!count) { el.innerHTML = '<p class="empty-state">No pending conflicts</p>'; return; }
    var pillCls = count >= 25 ? "widget-pill-red" : count >= 10 ? "widget-pill-amber" : "widget-pill-watch";
    var header = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
      '<span class="widget-pill ' + pillCls + '">' + count + ' pending</span>' +
      '<a href="/events.html#tab=conflicts" style="font-size:0.8rem;color:var(--color-text-secondary)">Review →</a>' +
    '</div>';
    var body = rows.slice(0, 5).map(function (c) {
      var subtitle;
      if (c.entityType === "asset") {
        var f = c.proposedAssetFields || {};
        var reason = f.collisionReason || "asset";
        // Reason labels for the flavours whose raw key doesn't read as English.
        if (reason === "duplicate-ip") reason = "duplicate IP " + (f.ipAddress || "");
        else if (reason === "ip-override") reason = "IP override";
        // Business rule 83's pair. The contested one names the gate count
        // rather than the serial: which gates are arguing is the fact, and the
        // serial is already the card's title.
        else if (reason === "serial-two-controllers") {
          var gates = Array.isArray(f.claimants) ? f.claimants.length : 2;
          reason = "serial claimed by " + gates + " FortiGates";
        } else if (reason === "duplicate-serial") reason = "duplicate serial " + (f.serialNumber || "");
        subtitle = (f.hostname || "(unnamed)") + ' · ' + reason;
      } else {
        subtitle = (c.proposedHostname || c.proposedOwner || "—") + ' · ' + (c.proposedSourceType || "reservation");
      }
      return '<a class="recent-item recent-item-link" href="/events.html#tab=conflicts&id=' + encodeURIComponent(c.id) + '"><div>' +
        '<div class="recent-item-title"><span>' + escapeHtml(c.entityType) + ' conflict</span></div>' +
        '<div class="recent-item-meta">' + escapeHtml(subtitle) + '</div>' +
      '</div></a>';
    }).join("");
    el.innerHTML = header + body;
  }

  // Shared by fetchData and the refresh timer so the two can't drift.
  function fetchConflicts() {
    return Promise.all([
      api.conflicts.count().catch(function () { return { count: 0 }; }),
      api.conflicts.list({ status: "pending", limit: 5 }).catch(function () { return []; }),
    ]).then(function (out) {
      return { count: (out[0] && out[0].count) || 0, rows: out[1] || [] };
    });
  }

  PolarisWidgets.register({
    type: "conflictQueue",
    category: "Discovery",
    label: "Conflict queue",
    description: "Pending discovery conflicts. Role-scoped — you only see the ones your role can resolve.",
    defaultSize: { width: 4, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: {},
    requiredPermission: { key: "discoveryConflicts", level: "read" },

    fetchData: function () {
      return fetchConflicts();
    },

    renderInstance: function (el, _config, data, ctx) {
      renderRows(el, data.count || 0, data.rows || []);
      var timer = setInterval(function () {
        fetchConflicts().then(function (d) { renderRows(el, (d && d.count) || 0, (d && d.rows) || []); }).catch(function () {});
      }, PolarisWidgets.REFRESH.slow);
      ctx.onUnmount(function () { clearInterval(timer); });
    },

    renderPreview: function (el) {
      renderRows(el, 4, [
        { id: "p1", entityType: "asset", proposedAssetFields: { hostname: "lab-vm-23", collisionReason: "untagged-collision" } },
        { id: "p2", entityType: "reservation", proposedHostname: "printer-3rd-floor", proposedSourceType: "dhcp_lease" },
      ]);
    },
  });
})();
