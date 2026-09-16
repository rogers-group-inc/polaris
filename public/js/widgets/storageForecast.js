/**
 * widgets/storageForecast.js — days until each growing filesystem fills, one
 * row PER VOLUME (host + mount path), soonest-full first. Data from
 * /dashboard/noc-summary storageForecast[] (30-day linear trend over the
 * storage samples; only growing mounts with enough history appear — a healthy
 * flat filesystem never shows). LOWER is worse here, so this widget renders
 * its own rows instead of _topnBar (whose thresholds/bars assume higher-is-
 * worse): red ≤7 days, yellow ≤30 days, and the urgency bar fills as the fill
 * date approaches. Severity-first ordering + alert pill like every feed.
 */

(function () {
  var RED_DAYS = 7;
  var YELLOW_DAYS = 30;
  var BAR_HORIZON_DAYS = 90; // bar is full at 0 days, empty at ≥90 days out
  var EMPTY = "No growing filesystems (or not enough history yet)";

  // The ⇅ header button's menu (edit mode). options[0] is the widget's
  // historical order — severity first, soonest-full within a band — so a
  // dashboard saved before this control keeps behaving exactly as it did.
  // LOWER is worse here, so "soonest" is this widget's version of "highest".
  var CMP = PolarisWidgets.sortCmp;
  function daysOf(r) { return r.value; }
  var SORTS = [
    {
      key: "severity",
      label: "Severity, then soonest full",
      cmp: CMP.then(CMP.severity(), CMP.low(daysOf)),
    },
    { key: "soonest", label: "Soonest full first", cmp: CMP.low(daysOf) },
    // The other end: the mounts with room. Useful for reading the whole
    // forecast rather than only the emergencies — the red guarantee still
    // pulls anything inside the red window back onto the screen.
    { key: "furthest", label: "Furthest out first", cmp: CMP.high(daysOf) },
    // Stable on a wallboard: rows keep their places across the refresh.
    {
      key: "hostname",
      label: "Hostname A–Z",
      cmp: CMP.then(CMP.text(function (r) { return r.hostname || r.ipAddress; }), CMP.text(function (r) { return r.detail; })),
    },
  ];

  function colorFor(days) {
    if (days <= RED_DAYS) return "#ff1744";
    if (days <= YELLOW_DAYS) return "#ffd600";
    return "#4fc3f7";
  }

  function formatDays(days) {
    if (days < 1) return "<1d";
    return Math.round(days) + "d";
  }

  function render(el, config, rows) {
    config = config || {};
    // Gear "Minimum severity": narrow to volumes whose asset carries an active
    // alert at/above the tier, before the export / horizon filter / clip.
    rows = PolarisWidgets.filterByMinSeverity(rows, config);
    // Operator's sort (⇅, edit mode) — applied BEFORE the export provider and
    // the clip so all three agree on which volumes lead and which get cut.
    rows = PolarisWidgets.applySort(rows, SORTS, config);
    PolarisWidgets.setHeaderSort(el, { options: SORTS, config: config });
    // Header export: every fetched volume row (pre horizon filter + clip),
    // severity-tiered on the owning asset's active automation alert.
    PolarisWidgets.setHeaderExport(el, {
      filename: "storage-forecast",
      columns: [
        { header: "Hostname", get: function (r) { return r.hostname || ""; } },
        { header: "IP Address", get: function (r) { return r.ipAddress || ""; } },
        { header: "Mount", get: function (r) { return r.detail || ""; } },
        { header: "Days Until Full", get: function (r) { return r.value == null ? "" : Math.round(r.value * 10) / 10; } },
        { header: "Used %", get: function (r) { return r.usedPct == null ? "" : r.usedPct; } },
      ],
      rows: rows || [],
    });
    var sorted = rows.slice();
    // "Hide beyond" horizon (days) — cut far-out forecasts before the clip.
    if (config.horizonDays != null) {
      sorted = sorted.filter(function (r) { return (r.value || 0) <= config.horizonDays; });
    }
    // Red guarantee: a filesystem inside the red window always shows.
    var limitN = parseInt(config.rowLimit, 10);
    if (isNaN(limitN) || limitN <= 0) limitN = 20;
    var shown = sorted.filter(function (r, i) { return i < limitN || (r.value || 0) <= RED_DAYS; });
    // Header severity breakdown of the volumes actually rendered (post severity
    // filter, horizon and red guarantee). Unalerted volumes get no bucket — the
    // row count here is the operator's Row limit, not a fleet total (_topnBar's
    // rule). Stamped before the empty return so the pills clear with it.
    PolarisWidgets.setHeaderSeverityCounts(el, shown, { unalerted: "omit" });
    if (!shown.length) {
      el.innerHTML = '<p class="empty-state">' + escapeHtml(PolarisWidgets.minSeverityEmptyText(config) || EMPTY) + '</p>';
      return;
    }
    el.innerHTML = shown.map(function (r) {
      var days = r.value || 0;
      var pct = Math.max(2, Math.min(100, Math.round((1 - days / BAR_HORIZON_DAYS) * 100)));
      // Alert severity wins over the days-to-full color so the bar agrees with
      // the pill beside it (same rule as _topnBar).
      var sevColor = PolarisWidgets.alertSeverityBarColor ? PolarisWidgets.alertSeverityBarColor(r.alertSeverity) : null;
      var color = sevColor || colorFor(days);
      var name = escapeHtml(r.hostname || r.ipAddress || "(unnamed)");
      var detail = r.detail ? ' <span style="color:var(--color-text-tertiary);font-size:0.8rem">' + escapeHtml(r.detail) + '</span>' : "";
      var usedNote = r.usedPct != null ? " — " + r.usedPct + "% used now" : "";
      var tip = escapeHtml((r.hostname || r.ipAddress || "(unnamed)") + (r.detail ? " — " + r.detail : "") + " — full in ~" + Math.round(days) + " days" + usedNote);
      var sevPill = PolarisWidgets.alertSeverityPill ? PolarisWidgets.alertSeverityPill(r.alertSeverity) : "";
      var tag = r.id ? "a" : "div";
      var nav = r.id ? ' href="/assets.html#view=asset:' + encodeURIComponent(r.id) + '"' : "";
      return "<" + tag + ' class="recent-item' + (r.id ? " recent-item-link" : "") + '"' + nav +
        ' style="display:grid;grid-template-columns:1fr 90px 48px;align-items:center;gap:8px;text-decoration:none">' +
        '<span class="recent-item-title" title="' + tip + '" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + sevPill + name + detail + '</span>' +
        '<div class="util-bar-track"><div class="util-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
        '<span style="font-size:0.82rem;text-align:right;color:var(--color-text-secondary)">' + formatDays(days) + '</span>' +
      "</" + tag + ">";
    }).join("");
  }

  PolarisWidgets.register({
    type: "storageForecast",
    category: "Monitoring",
    label: "Storage Forecast",
    description: "Growing filesystems ranked by projected days until full (30-day trend).",
    defaultSize: { width: 4, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: { rowLimit: 20, regionScope: "mine", sortBy: "severity" },
    requiredPermission: { key: "assets", level: "read" },

    fetchData: function (config) {
      return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["storageForecast"]).then(function (d) { return (d && d.storageForecast) || []; }).catch(function () { return []; });
    },

    renderInstance: function (el, config, data, ctx) {
      render(el, config, data);
      var timer = setInterval(function () {
        PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["storageForecast"]).then(function (d) { render(el, config, (d && d.storageForecast) || []); }).catch(function () {});
      }, PolarisWidgets.REFRESH.slow);
      ctx.onUnmount(function () { clearInterval(timer); });
    },

    renderPreview: function (el) {
      render(el, {}, [
        { id: "p1", hostname: "db-srv-04", detail: "/var", value: 4.2, usedPct: 91 },
        { id: "p2", hostname: "file-srv-02", detail: "D:", value: 18, usedPct: 78 },
        { id: "p3", hostname: "app-srv-11", detail: "/", value: 65, usedPct: 52 },
      ]);
    },

    renderConfig: function (el, config, onChange) {
      var horizons = [
        { value: "", label: "Show all (≤1 year)" },
        { value: "30", label: "Within 30 days" },
        { value: "60", label: "Within 60 days" },
        { value: "90", label: "Within 90 days" },
        { value: "180", label: "Within 180 days" },
      ];
      el.innerHTML =
        '<label>Row limit</label>' +
        '<select data-k="rowLimit">' + PolarisWidgets.rowLimitOptionsHTML(config.rowLimit == null ? 20 : config.rowLimit) + '</select>' +
        '<label>Show filesystems filling</label>' +
        '<select data-k="horizonDays">' +
          horizons.map(function (o) {
            return '<option value="' + o.value + '"' + ((config.horizonDays == null ? "" : String(config.horizonDays)) === o.value ? " selected" : "") + '>' + escapeHtml(o.label) + '</option>';
          }).join("") +
        '</select>';
      el.querySelectorAll("[data-k]").forEach(function (s) {
        s.addEventListener("change", function () {
          var k = s.getAttribute("data-k");
          if (k === "horizonDays") onChange("horizonDays", s.value === "" ? null : parseInt(s.value, 10));
          else onChange("rowLimit", PolarisWidgets.parseRowLimit(s.value));
        });
      });
      PolarisWidgets.renderMinSeverityConfig(el, config, onChange,
        "Only volumes whose device has an active alert at or above this severity are shown.");
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, true);
    },
  });
})();
