/**
 * widgets/downInterfaces.js — physical interfaces that are administratively up
 * but operationally down (only interfaces selected for monitoring — the asset's
 * pinned monitoredInterfaces list; unpinned ports are filtered server-side),
 * PLUS IPsec tunnels that are fully down, grouped by the gate they live on. Mirrors the Down Assets widget: same dash-alert
 * row markup, group-header + count-pill grouping, click a row to open the owning
 * asset. A down tunnel row shows the parent physical interface it rides (the
 * FortiOS phase1-interface WAN port). Data from noc-summary downInterfaces[] +
 * downIpsecTunnels[].
 */

(function () {
  // Humanizes a type the static label map lacks (an operator-added registry
  // type), so a row/export never prints a raw snake_case value.
  var typeName = PolarisWidgets.assetTypeLabel;

  // Normalize the two noc-summary arrays into a single row list with a `kind`
  // discriminator so render/group/sort treat them uniformly. The physical /
  // tunnel config toggles (default both on) drop a whole kind before merging.
  function mergeRows(d, config) {
    config = config || {};
    var wantIfaces = config.showInterfaces !== false;
    var wantTunnels = config.showTunnels !== false;
    var ifaces = !wantIfaces ? [] : ((d && d.downInterfaces) || []).map(function (n) {
      return {
        kind: "interface",
        assetId: n.assetId, hostname: n.hostname, ipAddress: n.ipAddress, assetType: n.assetType,
        name: n.ifName, label: n.ifLabel, parentInterface: null, remoteGateway: null,
        gate: n.gate, lastUpAt: n.lastUpAt,
        alertSeverity: n.alertSeverity, alertRank: n.alertRank || 0,
      };
    });
    var tunnels = !wantTunnels ? [] : ((d && d.downIpsecTunnels) || []).map(function (t) {
      return {
        kind: "tunnel",
        assetId: t.assetId, hostname: t.hostname, ipAddress: t.ipAddress, assetType: t.assetType,
        name: t.tunnelName, label: null, parentInterface: t.parentInterface, remoteGateway: t.remoteGateway,
        gate: t.gate, lastUpAt: t.lastUpAt,
        alertSeverity: t.alertSeverity, alertRank: t.alertRank || 0,
      };
    });
    // Severity-first (rows on assets carrying an active automation alert lead,
    // by alert severity), then youngest outage first (newest lastUpAt at the
    // top): the gate groups render in this order, and the row-limit clip keeps
    // the highest-severity/freshest outages when over the cap. Nulls (no
    // observed up sample in the window — down the longest / unknown) sink to
    // the bottom within their severity band.
    return ifaces.concat(tunnels).sort(function (a, b) {
      var d = (b.alertRank || 0) - (a.alertRank || 0);
      if (d !== 0) return d;
      if (!a.lastUpAt && !b.lastUpAt) return 0;
      if (!a.lastUpAt) return 1;
      if (!b.lastUpAt) return -1;
      return new Date(b.lastUpAt) - new Date(a.lastUpAt);
    });
  }

  // Alphabetical by interface/tunnel name — display order within each gate
  // group (and for the ungrouped view).
  function byName(a, b) {
    return String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true, sensitivity: "base" });
  }

  function groupKey(row, groupBy) {
    if (groupBy === "none") return null;
    return row.gate || "(unknown)";
  }

  function rowHTML(n) {
    var typeLabel = typeName(n.assetType, "asset");
    var host = n.hostname || n.ipAddress || "(unnamed)";
    var title = (PolarisWidgets.alertSeverityPill ? PolarisWidgets.alertSeverityPill(n.alertSeverity) : "") +
      escapeHtml(n.name || (n.kind === "tunnel" ? "(tunnel)" : "(interface)"));
    if (n.label) title += ' <span class="dash-alert-ip">' + escapeHtml(n.label) + '</span>';
    var sub;
    if (n.kind === "tunnel") {
      // Lead with the tunnel marker, then the parent physical interface it rides
      // (the operator's key ask), then the remote gateway when known.
      var parts = ['<span class="widget-pill">IPsec tunnel</span>'];
      parts.push(n.parentInterface ? "via " + escapeHtml(n.parentInterface) : "no parent iface");
      if (n.remoteGateway) parts.push("&rarr; " + escapeHtml(n.remoteGateway));
      parts.push(escapeHtml(host));
      sub = parts.join(" · ");
    } else {
      sub = [escapeHtml(host), escapeHtml(typeLabel)].join(" · ");
    }
    var href = '/assets.html#view=asset:' + encodeURIComponent(n.assetId);
    return '<a class="dash-alert-item" href="' + href + '" data-asset-id="' + escapeHtml(n.assetId) + '" style="text-decoration:none">' +
      '<div class="dash-alert-row" style="width:100%">' +
        '<div class="dash-alert-body">' +
          '<div class="dash-alert-title">' + title + '</div>' +
          '<div class="dash-alert-sub">' + sub + '</div>' +
        '</div>' +
        '<div class="dash-alert-time" data-changed-at="' + (n.lastUpAt || "") + '" title="Down since last seen up">' +
          (n.lastUpAt ? PolarisWidgets.durationSince(n.lastUpAt) : "—") +
        '</div>' +
      '</div>' +
    '</a>';
  }

  function render(el, rows, config) {
    // Gear "Minimum severity": drop rows whose owning asset carries no active
    // alert at/above the configured tier, before the header count / export /
    // clip so all three agree.
    rows = PolarisWidgets.filterByMinSeverity(rows, config);
    // Header export: the merged interface + tunnel list (pre-clip),
    // severity-tiered on the owning asset's active automation alert.
    PolarisWidgets.setHeaderExport(el, {
      filename: "down-interfaces",
      columns: [
        { header: "Name", get: function (n) { return n.name || ""; } },
        { header: "Kind", get: function (n) { return n.kind === "tunnel" ? "IPsec tunnel" : "Interface"; } },
        { header: "Label", get: function (n) { return n.label || ""; } },
        { header: "Hostname", get: function (n) { return n.hostname || ""; } },
        { header: "IP Address", get: function (n) { return n.ipAddress || ""; } },
        { header: "Gate", get: function (n) { return n.gate || ""; } },
        { header: "Parent Interface", get: function (n) { return n.parentInterface || ""; } },
        { header: "Remote Gateway", get: function (n) { return n.remoteGateway || ""; } },
        { header: "Last Up", get: function (n) { return n.lastUpAt ? new Date(n.lastUpAt).toISOString() : ""; } },
      ],
      rows: rows,
    });
    var groupBy = (config && config.groupBy) || "gate";
    var clipped = PolarisWidgets.clip(rows, config && config.rowLimit);
    // Header severity breakdown — one pill per active-alert severity among the
    // RENDERED rows (most severe first, colored to that severity), plus a
    // trailing grey pill for the rendered rows carrying no alert, so the pills
    // sum to what's on screen. Stamped before the empty return so they clear.
    PolarisWidgets.setHeaderSeverityCounts(el, clipped);
    if (!clipped.length) {
      var empty = PolarisWidgets.minSeverityEmptyText(config) || "No interfaces or tunnels down";
      el.innerHTML = '<p class="empty-state">' + escapeHtml(empty) + '</p>';
      return;
    }

    if (groupBy === "none") {
      el.innerHTML = clipped.slice().sort(byName).map(rowHTML).join("");
      return;
    }
    // Bucket into groups preserving first-seen order — rows arrive youngest
    // outage first (mergeRows), so the gates render newest-outage-first.
    // Within each gate the rows sort alphabetically by name.
    var groups = {};
    var order = [];
    clipped.forEach(function (n) {
      var k = groupKey(n, groupBy);
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(n);
    });
    el.innerHTML = order.map(function (k) {
      var list = groups[k];
      return '<div class="dash-alert-group-header" style="display:flex;align-items:center;gap:8px;margin:6px 0 4px;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.03em;color:var(--color-text-secondary)">' +
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(k) + '</span>' +
        // Count pill colored to the group's most severe row, so a gate whose
        // rows are all `serious` reads orange instead of critical-red.
        '<span class="' + PolarisWidgets.countPillClass(list) + '">' + list.length + '</span>' +
      '</div>' + list.slice().sort(byName).map(rowHTML).join("");
    }).join("");
  }

  PolarisWidgets.register({
    type: "downInterfaces",
    category: "Monitoring",
    label: "Down Interfaces",
    description: "Monitored (pinned) interfaces admin-up but operationally down, plus fully-down IPsec tunnels, grouped by the gate they're on.",
    defaultSize: { width: 6, height: 1 },
    minSize: { width: 4, height: 1 },
    defaultConfig: { groupBy: "gate", rowLimit: 10, regionScope: "mine", showInterfaces: true, showTunnels: true },
    requiredPermission: { key: "assets", level: "read" },

    fetchData: function (config) {
      return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["downInterfaces", "downIpsecTunnels"]).then(function (d) { return mergeRows(d, config); }).catch(function () { return []; });
    },

    renderInstance: function (el, config, data, ctx) {
      render(el, data, config);
      // Click a row → open the owning asset's details slide-in in place. Plain
      // left-clicks open in place; ctrl/meta/middle-click keep the href so the
      // operator can open the Assets page in a new tab. Delegated on el so it
      // survives the 30s re-render.
      var onClick = function (ev) {
        if (ev.defaultPrevented || ev.button === 1 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
        var link = ev.target.closest(".dash-alert-item[data-asset-id]");
        if (!link || !el.contains(link)) return;
        ev.preventDefault();
        PolarisWidgets.openAssetDetail(link.getAttribute("data-asset-id"));
      };
      el.addEventListener("click", onClick);
      var timer = setInterval(function () {
        PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["downInterfaces", "downIpsecTunnels"]).then(function (d) { render(el, mergeRows(d, config), config); }).catch(function () {});
      }, PolarisWidgets.REFRESH.normal);
      ctx.onUnmount(function () { clearInterval(timer); el.removeEventListener("click", onClick); });
    },

    renderPreview: function (el) {
      var now = Date.now();
      render(el, mergeRows({
        downInterfaces: [
          { assetId: "p1", hostname: "fs-aisle-3", ipAddress: "10.1.2.5", assetType: "switch", ifName: "port12", ifLabel: "AP uplink", gate: "fgt-plant-a", lastUpAt: new Date(now - 9 * 60000).toISOString() },
          { assetId: "p3", hostname: "fgt-dc-west", ipAddress: "10.9.0.1", assetType: "firewall", ifName: "wan2", ifLabel: "Backup ISP", gate: "fgt-dc-west", lastUpAt: new Date(now - 3 * 3600000).toISOString() },
        ],
        downIpsecTunnels: [
          { assetId: "p3", hostname: "fgt-dc-west", ipAddress: "10.9.0.1", assetType: "firewall", tunnelName: "vpn-hq", parentInterface: "wan1", remoteGateway: "203.0.113.7", gate: "fgt-dc-west", lastUpAt: new Date(now - 47 * 60000).toISOString() },
        ],
      }), { groupBy: "gate", rowLimit: 5 });
    },

    renderConfig: function (el, config, onChange) {
      var showIf = config.showInterfaces !== false;
      var showTun = config.showTunnels !== false;
      el.innerHTML =
        '<label>Show</label>' +
        '<div class="widget-config-typegrid">' +
          '<label class="widget-config-typeopt"><input type="checkbox" data-show="showInterfaces"' + (showIf ? " checked" : "") + '> Physical interfaces</label>' +
          '<label class="widget-config-typeopt"><input type="checkbox" data-show="showTunnels"' + (showTun ? " checked" : "") + '> IPsec tunnels</label>' +
        '</div>' +
        '<label>Group by</label>' +
        '<select data-k="groupBy">' +
          '<option value="gate"' + ((config.groupBy || "gate") === "gate" ? " selected" : "") + '>Gate</option>' +
          '<option value="none"' + (config.groupBy === "none" ? " selected" : "") + '>None</option>' +
        '</select>' +
        '<label>Row limit</label>' +
        '<select data-k="rowLimit">' + PolarisWidgets.rowLimitOptionsHTML(config.rowLimit) + '</select>';
      el.querySelectorAll("[data-show]").forEach(function (cb) {
        cb.addEventListener("change", function () { onChange(cb.getAttribute("data-show"), cb.checked); });
      });
      el.querySelectorAll("[data-k]").forEach(function (s) {
        s.addEventListener("change", function () {
          var k = s.getAttribute("data-k");
          onChange(k, k === "rowLimit" ? PolarisWidgets.parseRowLimit(s.value) : s.value);
        });
      });
      PolarisWidgets.renderMinSeverityConfig(el, config, onChange,
        "Only rows whose device has an active alert at or above this severity are shown.");
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, true);
    },
  });
})();
