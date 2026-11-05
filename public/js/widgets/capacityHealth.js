/**
 * widgets/capacityHealth.js — overall capacity severity pill + top reasons.
 * Permission-gated on serverSettingsSystem:read since the underlying
 * endpoint (/server-settings/pg-tuning) is admin-only and leaks fleet-shape
 * data anyone without that permission shouldn't see.
 */

(function () {
  var SEVERITY_PILL = { ok: "widget-pill-ok", watch: "widget-pill-watch", amber: "widget-pill-amber", red: "widget-pill-red" };
  // Capacity's own ladder, most severe first — deliberately NOT the automation
  // alert ladder (see setHeaderTierCounts): "red" here is a disk-space tier, not
  // a notification severity, and the two must not rank against each other.
  var SEVERITY_ORDER = ["red", "amber", "watch", "ok"];

  function renderInstance(el, payload) {
    var capacity = payload && payload.capacity;
    if (!capacity) {
      PolarisWidgets.setHeaderPills(el, []);
      el.innerHTML = '<p class="empty-state">Capacity data unavailable</p>';
      return;
    }
    var sev = capacity.severity || "ok";
    var pillCls = SEVERITY_PILL[sev] || "widget-pill-watch";
    var reasons = (capacity.reasons || []).slice(0, 5);
    // Header breakdown of the reasons on screen (the same five this renders),
    // so the title reads "2 red, 1 amber" without counting the list by eye.
    PolarisWidgets.setHeaderTierCounts(el, reasons, {
      keyOf: function (r) { return r.severity; },
      order: SEVERITY_ORDER,
      classOf: function (k) { return SEVERITY_PILL[k] || "widget-pill-watch"; },
      noun: "reason(s)",
    });
    var reasonsHtml = reasons.length
      ? '<ul style="list-style:none;padding:0;margin:8px 0 0;display:flex;flex-direction:column;gap:6px">' +
          reasons.map(function (r) {
            var rpill = SEVERITY_PILL[r.severity] || "widget-pill-watch";
            return '<li style="display:flex;gap:6px;align-items:flex-start">' +
              '<span class="widget-pill ' + rpill + '" style="flex-shrink:0">' + escapeHtml(r.severity) + '</span>' +
              '<span style="font-size:0.82rem;color:var(--color-text-secondary)">' + escapeHtml(r.message || r.code || "") + '</span>' +
            '</li>';
          }).join("") +
        '</ul>'
      : '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin:8px 0 0">No issues — everything within healthy thresholds.</p>';
    el.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<span class="widget-pill ' + pillCls + '">' + escapeHtml(sev.toUpperCase()) + '</span>' +
        '<a href="/server-settings.html#tab=maintenance" style="font-size:0.8rem;color:var(--color-text-secondary)">Open Maintenance →</a>' +
      '</div>' + reasonsHtml;
  }

  // Shared by fetchData and the refresh timer so the two can't drift.
  function fetchCapacity() {
    return api.serverSettings.getPgTuning().catch(function () { return null; });
  }

  PolarisWidgets.register({
    type: "capacityHealth",
    category: "IP Space",
    label: "Capacity health",
    description: "Overall capacity severity pill + the top reasons driving it. Admin-only.",
    defaultSize: { width: 4, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: {},
    requiredPermission: { key: "serverSettingsSystem", level: "read" },

    fetchData: function () {
      return fetchCapacity();
    },

    renderInstance: function (el, _config, data, ctx) {
      renderInstance(el, data);
      PolarisWidgets.pollVisible(ctx, function () {
        fetchCapacity().then(function (d) { renderInstance(el, d); }).catch(function () {});
      }, PolarisWidgets.REFRESH.slow);
    },

    renderPreview: function (el) {
      renderInstance(el, {
        capacity: {
          severity: "amber",
          reasons: [
            { severity: "amber", message: "DB volume below 20% free" },
            { severity: "watch", message: "Prisma pool nearing capacity" },
          ],
        },
      });
    },
  });
})();
