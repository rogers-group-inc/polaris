/**
 * widgets/discoveryActivity.js — in-flight discoveries. Refreshes every 10s
 * while the widget is mounted so an operator can watch the progress count
 * climb without leaving the page. Permission-gated on integrations:read.
 */

(function () {
  function fmtElapsed(ms) {
    if (ms == null) return "—";
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    return m + "m " + ((s % 60) < 10 ? "0" : "") + (s % 60) + "s";
  }

  // Accepts the raw endpoint envelope, the shell's already-unwrapped array, or
  // nothing at all — the three shapes this widget's two feeds can hand it.
  function runsOf(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.discoveries)) return data.discoveries;
    return [];
  }

  function renderRows(el, runs) {
    if (!runs.length) { el.innerHTML = '<p class="empty-state">No discoveries running</p>'; return; }
    el.innerHTML = runs.map(function (r) {
      var pillCls = r.slow ? "widget-pill-amber" : "widget-pill-watch";
      var progress = "";
      if (r.totalDevices != null) {
        var done = (r.completedCount || 0) + (r.skippedOfflineCount || 0) + (r.skippedErrorCount || 0);
        var pct = Math.min(100, Math.round((done / Math.max(1, r.totalDevices)) * 100));
        // "unread" is the device discovery could not reach at all — it keeps
        // its previous data while looking healthy everywhere else, so it earns
        // a label of its own rather than just advancing the bar. Same wording
        // as the sidebar's discovery line in app.js; keep the two in step.
        var counts = done + ' / ' + r.totalDevices +
          (r.skippedOfflineCount ? ' · ' + r.skippedOfflineCount + ' offline' : '') +
          (r.skippedErrorCount ? ' · ' + r.skippedErrorCount + ' unread' : '');
        progress = '<div class="util-bar-track" style="margin-top:4px"><div class="util-bar-fill" style="width:' + pct + '%;background:#4fc3f7"></div></div>' +
          '<div style="font-size:0.72rem;color:var(--color-text-tertiary);margin-top:2px">' + counts + '</div>';
      }
      return '<div class="recent-item" style="cursor:default">' +
        '<div style="flex:1">' +
          '<div class="recent-item-title"><span>' + escapeHtml(r.name || "(unnamed)") + '</span><span class="widget-pill ' + pillCls + '" style="margin-left:6px">' + escapeHtml(r.type) + '</span></div>' +
          '<div class="recent-item-meta">' + fmtElapsed(r.elapsedMs) + (r.slow ? ' · running slow' : '') + '</div>' +
          progress +
        '</div>' +
      '</div>';
    }).join("");
  }

  PolarisWidgets.register({
    type: "discoveryActivity",
    category: "Discovery",
    label: "Discovery activity",
    description: "In-flight integration discoveries with per-run progress and slow-run amber telemetry.",
    defaultSize: { width: 4, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: {},
    requiredPermission: { key: "integrations", level: "read" },

    // GET /integrations/discoveries answers `{ discoveries: [...] }`, and
    // renderRows wants the ARRAY — reading the envelope gave `.length` of
    // undefined, so this widget rendered "No discoveries running" no matter
    // what was in flight. Unwrap it in one place (`runsOf`) and prefer the
    // snapshot the app shell already polls every 4s over issuing a second
    // request for the same endpoint; the standalone fetch stays as the
    // fallback for a host page that doesn't boot the shell poller.
    fetchData: function () {
      if (typeof window._getServerDiscoveries === "function") {
        return Promise.resolve(window._getServerDiscoveries());
      }
      return api.integrations.discoveries().catch(function () { return []; });
    },

    renderInstance: function (el, _config, data, ctx) {
      renderRows(el, runsOf(data));
      var timer = setInterval(function () {
        if (document.hidden) return;
        if (typeof window._getServerDiscoveries === "function") {
          renderRows(el, runsOf(window._getServerDiscoveries()));
          return;
        }
        api.integrations.discoveries()
          .then(function (next) { renderRows(el, runsOf(next)); })
          .catch(function () {});
      }, PolarisWidgets.REFRESH.fast);
      ctx.onUnmount(function () { clearInterval(timer); });
    },

    renderPreview: function (el) {
      renderRows(el, [
        { name: "Main DC FortiManager", type: "fortimanager", elapsedMs: 47000, slow: false, totalDevices: 86, completedCount: 41, skippedOfflineCount: 2, skippedErrorCount: 0 },
        { name: "Corp Active Directory", type: "activedirectory", elapsedMs: 12000, slow: false, totalDevices: null },
      ]);
    },
  });
})();
