/**
 * widgets/statusSummary.js — NOC status tiles. Compact color-coded counts of
 * monitored assets by state (Total / Up / Down / Missed / Unknown), plus an
 * infra Uptime% gauge and an active-Alerts count. Data from
 * /dashboard/noc-summary. The gear toggles which tiles appear.
 */

(function () {
  // The shared widget status palette (api.js). Read once here rather than per
  // use because TILE_DEFS below is built at module scope: an undeclared WC
  // threw "WC is not defined" before register() was ever reached, which took
  // this whole widget out of the registry rather than just mis-coloring it.
  var WC = window.POLARIS_WIDGET_STATUS_COLORS;

  // Tile catalog: id → { label, color, value(data) }. Color drives the tile's
  // left border + number. Uptime / alerts colors are computed per-value.
  var TILE_DEFS = [
    { id: "total",   label: "Total",   color: WC.neutral, val: function (d) { return d.statusCounts.total; } },
    { id: "up",      label: "Up",      color: WC.ok, val: function (d) { return d.statusCounts.up; } },
    { id: "down",    label: "Down",    color: WC.down, val: function (d) { return d.statusCounts.down; } },
    // The `warning` monitorStatus is labeled "Missed" everywhere an operator
    // sees it (POLARIS_MONITOR_STATUS_LABELS in api.js) — the count key stays
    // `warning` because that is the stored value the server groups by.
    { id: "warning", label: "Missed", color: WC.warning, val: function (d) { return d.statusCounts.warning; } },
    { id: "unknown", label: "Unknown", color: WC.neutral, val: function (d) { return d.statusCounts.unknown; } },
    // Maintenance-window assets — excluded from Up/Down/Missed server-side
    // (their frozen monitorStatus is not live state); purple matches the
    // assets-page maintenance pill and the Status Map dot.
    { id: "maintenance", label: "Maint", color: window.POLARIS_HEALTH_COLORS.maintenance, val: function (d) { return d.statusCounts.maintenance; } },
    // Passive — no down-detection automation covers these devices, so Polaris
    // renders no verdict about them. Its own tile because a climbing Passive
    // count is the signal that devices have stopped being judged, and folding
    // it into Unknown would read as "never probed" about devices being polled
    // perfectly well.
    { id: "passive", label: "Passive", color: window.POLARIS_HEALTH_COLORS.passive, val: function (d) { return d.statusCounts.passive; } },
    { id: "uptime",  label: "Uptime",  color: null,      val: function (d) { return d.uptimePercent; } },
    { id: "alerts",  label: "Alerts",  color: null,      val: function (d) { return d.activeAlertCount; } },
  ];
  var ALL_IDS = TILE_DEFS.map(function (t) { return t.id; });

  function uptimeColor(pct) { return pct >= 98 ? WC.ok : pct >= 95 ? WC.warning : WC.down; }

  function tileHTML(def, data) {
    var raw = def.val(data);
    var color = def.color;
    var display;
    if (def.id === "uptime") {
      display = raw == null ? "—" : raw + "%";
      color = raw == null ? WC.neutral : uptimeColor(raw);
    } else if (def.id === "alerts") {
      display = raw == null ? 0 : raw;
      color = raw > 0 ? WC.down : WC.ok;
    } else {
      display = raw == null ? 0 : raw;
    }
    return '<div style="border-left:3px solid ' + color + ';padding:6px 10px;background:var(--color-surface-2,rgba(255,255,255,0.03));border-radius:4px;min-width:0">' +
      '<div style="font-size:1.5rem;font-weight:600;line-height:1.1;color:' + color + '">' + escapeHtml(String(display)) + '</div>' +
      '<div style="font-size:0.72rem;color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:0.03em">' + escapeHtml(def.label) + '</div>' +
    '</div>';
  }

  function renderTiles(el, data, config) {
    if (!data || !data.statusCounts) { el.innerHTML = '<p class="empty-state">No monitored assets</p>'; return; }
    var wanted = (config && Array.isArray(config.tiles) && config.tiles.length) ? config.tiles : ALL_IDS;
    var defs = TILE_DEFS.filter(function (t) { return wanted.indexOf(t.id) !== -1; });
    el.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(82px,1fr));gap:8px">' +
      defs.map(function (def) { return tileHTML(def, data); }).join("") +
    '</div>';
  }

  PolarisWidgets.register({
    type: "statusSummary",
    category: "Monitoring",
    label: "Status summary",
    description: "At-a-glance counts of monitored assets by state, plus infra uptime % and active alerts.",
    defaultSize: { width: 6, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: { tiles: ALL_IDS.slice(), regionScope: "mine" },
    requiredPermission: { key: "assets", level: "read" },

    fetchData: function (config) {
      return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["status"]).catch(function () { return null; });
    },

    renderInstance: function (el, config, data, ctx) {
      renderTiles(el, data, config);
      var timer = setInterval(function () {
        PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["status"]).then(function (d) { renderTiles(el, d, config); }).catch(function () {});
      }, PolarisWidgets.REFRESH.normal);
      ctx.onUnmount(function () { clearInterval(timer); });
    },

    renderPreview: function (el) {
      renderTiles(el, { statusCounts: { total: 312, up: 296, down: 4, warning: 7, unknown: 3, recovering: 0, passive: 0, maintenance: 2 }, uptimePercent: 99.2, activeAlertCount: 11 }, null);
    },

    renderConfig: function (el, config, onChange) {
      var current = new Set((config && config.tiles) || ALL_IDS);
      el.innerHTML =
        '<label>Show tiles</label>' +
        TILE_DEFS.map(function (t) {
          return '<label style="display:flex;gap:6px;align-items:center;font-size:0.85rem;margin:3px 0">' +
            '<input type="checkbox" data-tile="' + t.id + '"' + (current.has(t.id) ? " checked" : "") + '> ' + escapeHtml(t.label) +
          '</label>';
        }).join("");
      el.querySelectorAll("input[data-tile]").forEach(function (cb) {
        cb.addEventListener("change", function () {
          if (cb.checked) current.add(cb.getAttribute("data-tile"));
          else current.delete(cb.getAttribute("data-tile"));
          onChange("tiles", Array.from(current));
        });
      });
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, true);
    },
  });
})();
