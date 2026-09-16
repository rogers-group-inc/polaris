/**
 * widgets/_topnBar.js — shared renderer for the NOC top-N metric widgets
 * (Highest Avg CPU, Highest Avg Memory, Slowest Response, Packet Loss, Highest
 * Disk Usage, Highest Temperature). These are structurally identical: a ranked
 * list of { id, hostname, ipAddress, value, detail?, site? }
 * rows drawn as a name + utilization bar + value, with per-widget units, color
 * thresholds (overridden by an alerting row's own severity color) and an
 * optional Group-by-Site view
 * (gear option; buckets the ranked rows under site headers, groups ordered
 * by their hottest row). Underscore-prefixed = internal helper; it registers
 * no widget of its own.
 *
 * Exposes window.PolarisTopN.{ renderRows, renderConfig, pickColor }.
 */

(function () {
  // thresholds: highest-first [{ over, color }]. First match wins; else base.
  function pickColor(value, thresholds, baseColor) {
    var list = thresholds || [];
    for (var i = 0; i < list.length; i++) {
      if (value >= list[i].over) return list[i].color;
    }
    return baseColor || "#4fc3f7";
  }

  // The ⇅ header button's menu, shared by all six top-N widgets. `valueNoun`
  // names what the bar measures ("CPU", "response time", …) so the two value
  // options read as a sentence about this widget rather than a generic
  // "Value, highest first".
  //
  // The red guarantee still runs after the sort, so a red row shows whatever
  // the order — but on "Lowest first" everything else it pushes past the Row
  // limit is the quiet end of the fleet, which is the point of asking for it.
  var CMP = PolarisWidgets.sortCmp;
  function valueOf(r) { return r.value; }
  function sortsFor(opts) {
    var noun = opts.valueNoun || "value";
    return [
      {
        key: "severity",
        label: "Severity, then " + noun,
        cmp: CMP.then(CMP.severity(), CMP.high(valueOf)),
      },
      { key: "highest", label: "Highest " + noun + " first", cmp: CMP.high(valueOf) },
      { key: "lowest", label: "Lowest " + noun + " first", cmp: CMP.low(valueOf) },
      // Stable on a wallboard: rows keep their places across the refresh
      // instead of re-ranking every time a sample lands.
      {
        key: "hostname",
        label: "Hostname A–Z",
        cmp: CMP.then(CMP.text(function (r) { return r.hostname || r.ipAddress; }), CMP.text(function (r) { return r.detail; })),
      },
    ];
  }

  function formatValue(value, unit) {
    if (unit === "ms") return Math.round(value) + " ms";
    if (unit === "°C") return Math.round(value) + " °C";
    return value + "%";
  }

  /**
   * el       — widget body
   * rows     — [{ id, hostname, ipAddress, value }]
   * opts     — { unit:"%"|"ms"|"°C", thresholds, baseColor, emptyText, config,
   *              fillTo, valueNoun }
   *            config: { rowLimit, sortBy }
   *            valueNoun: what the bar measures ("CPU", "response time"), used
   *            to phrase this widget's two value sort options.
   *            fillTo: red-guarantee mode (Highest Avg CPU/Memory, Disk, Slowest
   *            Response). The operator's Row limit governs how many rows show
   *            (top-N by value), EXCEPT that every RED row (at/above the top
   *            color threshold, thresholds[0].over) is always shown even past
   *            the limit — an alert must never be clipped away. fillTo is the
   *            fallback row count when the config carries no usable rowLimit.
   *            Omit fillTo to leave rowLimit as a plain cap (e.g. Packet Loss).
   */
  function renderRows(el, rows, opts) {
    opts = opts || {};
    var cfg = opts.config || {};
    // Gear "Minimum severity": drop rows below the configured alert tier before
    // anything else looks at the set, so the export and the red guarantee both
    // operate on the rows the operator asked to see.
    rows = PolarisWidgets.filterByMinSeverity(rows, cfg);
    // Operator's sort (⇅ header button, edit mode). options[0] is the shared
    // SEVERITY-FIRST order these widgets have always used — rows whose asset
    // carries an active automation alert lead (by the alert's severity rank,
    // attached server-side as alertRank), then value desc within a rank — so a
    // dashboard saved before this control keeps behaving exactly as it did.
    var sorts = sortsFor(opts);
    var sorted = PolarisWidgets.applySort(rows, sorts, cfg);
    PolarisWidgets.setHeaderSort(el, { options: sorts, config: cfg });
    // Header export: the full ranked set (pre row-limit, post the
    // gear's minimum-severity filter), severity-tiered on each asset's active
    // automation alert. The filename defaults from the widget's data-type
    // (topCpu → polaris-top-cpu-…).
    PolarisWidgets.setHeaderExport(el, {
      columns: [
        { header: "Hostname", get: function (r) { return r.hostname || ""; } },
        { header: "IP Address", get: function (r) { return r.ipAddress || ""; } },
        { header: "Value (" + (opts.unit || "%") + ")", get: function (r) { return r.value == null ? "" : r.value; } },
        { header: "Detail", get: function (r) { return r.detail || ""; } },
        { header: "Site", get: function (r) { return r.site || ""; } },
      ],
      rows: sorted,
    });
    var shown;
    if (opts.fillTo) {
      // Red guarantee: every row at/above the top color threshold shows even
      // past the row limit (an alert must never be clipped away). With
      // severity-first ordering red rows aren't a contiguous head anymore, so
      // filter by position OR redness instead of extending the slice.
      var redOver = (opts.thresholds && opts.thresholds.length) ? opts.thresholds[0].over : Infinity;
      var limitN = parseInt(cfg.rowLimit, 10);
      if (isNaN(limitN) || limitN <= 0) limitN = opts.fillTo;
      shown = sorted.filter(function (r, i) { return i < limitN || (r.value || 0) >= redOver; });
    } else {
      shown = PolarisWidgets.clip(sorted, cfg.rowLimit);
    }
    // Header severity breakdown — one pill per active-alert severity among the
    // rows about to be RENDERED (post minimum-severity filter, post row limit /
    // red guarantee), so the title counts what's on screen. Stamped before the
    // empty return below so the pills clear when the set empties. Unalerted rows
    // get no bucket here: a top-N list's row count is the operator's Row limit,
    // not a fleet total, so counting the quiet rows would be noise.
    PolarisWidgets.setHeaderSeverityCounts(el, shown, { unalerted: "omit" });
    if (!shown.length) {
      // A widget emptied by the severity filter says so, rather than reading as
      // "nothing is wrong".
      var empty = PolarisWidgets.minSeverityEmptyText(cfg) || opts.emptyText || "Nothing to show";
      el.innerHTML = '<p class="empty-state">' + escapeHtml(empty) + '</p>';
      return;
    }
    // Percentages scale against a fixed 100; latency scales against the max in
    // the visible set so the slowest node fills the bar. Computed over the
    // FULL visible set (not per group) so bars stay comparable across groups.
    var scaleMax = opts.unit === "%"
      ? 100
      : (Math.max.apply(null, shown.map(function (r) { return r.value || 0; })) || 1);

    function rowHTML(r) {
      var v = r.value || 0;
      var pct = Math.min(100, Math.round((v / scaleMax) * 100));
      // An active alert's severity wins over the widget's value thresholds so
      // the bar can't disagree with the pill beside it (see
      // alertSeverityBarColor); un-alerted rows color by value.
      var sevColor = PolarisWidgets.alertSeverityBarColor ? PolarisWidgets.alertSeverityBarColor(r.alertSeverity) : null;
      var color = sevColor || pickColor(v, opts.thresholds, opts.baseColor);
      var name = escapeHtml(r.hostname || r.ipAddress || "(unnamed)");
      // Optional secondary label (e.g. the mount path for Highest Disk Usage),
      // shown muted after the hostname in the same cell.
      var detail = r.detail ? ' <span style="color:var(--color-text-tertiary);font-size:0.8rem">' + escapeHtml(r.detail) + '</span>' : "";
      // The name cell ellipsizes — a native tooltip carries the full name (and
      // mount detail when present) for rows the column is too narrow to show.
      var tip = escapeHtml((r.hostname || r.ipAddress || "(unnamed)") + (r.detail ? " — " + r.detail : ""));
      var label = formatValue(v, opts.unit);
      var tag = r.id ? "a" : "div";
      var nav = r.id ? ' href="/assets.html#view=asset:' + encodeURIComponent(r.id) + '"' : "";
      var sevPill = PolarisWidgets.alertSeverityPill ? PolarisWidgets.alertSeverityPill(r.alertSeverity) : "";
      return "<" + tag + ' class="recent-item' + (r.id ? " recent-item-link" : "") + '"' + nav +
        ' style="display:grid;grid-template-columns:1fr 90px 48px;align-items:center;gap:8px;text-decoration:none">' +
        '<span class="recent-item-title" title="' + tip + '" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + sevPill + name + detail + '</span>' +
        '<div class="util-bar-track"><div class="util-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
        '<span style="font-size:0.82rem;text-align:right;color:var(--color-text-secondary)">' + label + '</span>' +
      "</" + tag + ">";
    }

    // Group by site (gear option, default off): bucket the already-ranked
    // rows preserving first-seen order, so groups sort by their hottest row
    // — the site with the worst offender leads. Row limit / red guarantee
    // were both applied BEFORE grouping (grouping only changes
    // presentation, never which rows qualify). Same group-header markup as
    // Down Assets / Down Interfaces, with a neutral count pill (these are
    // rankings, not alarms).
    if ((cfg.groupBy || "none") === "site") {
      var groups = {};
      var order = [];
      shown.forEach(function (r) {
        var k = r.site || "(unknown)";
        if (!groups[k]) { groups[k] = []; order.push(k); }
        groups[k].push(r);
      });
      el.innerHTML = order.map(function (k) {
        var list = groups[k];
        return '<div class="dash-alert-group-header" style="display:flex;align-items:center;gap:8px;margin:6px 0 4px;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.03em;color:var(--color-text-secondary)">' +
          '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(k) + '</span>' +
          '<span class="widget-pill">' + list.length + '</span>' +
        '</div>' + list.map(rowHTML).join("");
      }).join("");
      return;
    }

    el.innerHTML = shown.map(rowHTML).join("");
  }

  /**
   * Shared gear config: group-by + row limit (+ the shared minimum-severity
   * filter). There is deliberately no per-widget value floor: the gear's
   * Minimum severity control is the display filter, and a second numeric
   * "hide below" knob only gave two ways to make the same row disappear.
   * opts.sampleControl — true adds an "Average over" select (config key
   * `sampleCount`, default 10): how many of each asset's most-recent samples
   * the server averages before ranking (Highest Avg CPU/Memory; 1 = rank on
   * the latest sample only).
   */
  var SAMPLE_COUNT_OPTIONS = [
    { value: "1", label: "Latest sample only" },
    { value: "5", label: "5 samples" },
    { value: "10", label: "10 samples (default)" },
    { value: "20", label: "20 samples" },
    { value: "50", label: "50 samples" },
  ];

  function renderConfig(el, config, onChange, opts) {
    opts = opts || {};
    // Group-by (site buckets, default off) + row-limit control (defaults to
    // the 20-row NOC view).
    var html =
      '<label>Group by</label>' +
      '<select data-k="groupBy">' +
        '<option value="none"' + ((config.groupBy || "none") === "none" ? " selected" : "") + '>None</option>' +
        '<option value="site"' + (config.groupBy === "site" ? " selected" : "") + '>Site</option>' +
      '</select>' +
      '<label>Row limit</label>' +
      '<select data-k="rowLimit">' + PolarisWidgets.rowLimitOptionsHTML(config.rowLimit == null ? 20 : config.rowLimit) + '</select>';
    if (opts.sampleControl) {
      var curSamples = String(config.sampleCount == null ? 10 : config.sampleCount);
      html +=
        '<label>Average over</label>' +
        '<select data-k="sampleCount">' +
          SAMPLE_COUNT_OPTIONS.map(function (o) {
            return '<option value="' + o.value + '"' + (curSamples === o.value ? " selected" : "") + '>' + escapeHtml(o.label) + '</option>';
          }).join("") +
        '</select>';
    }
    el.innerHTML = html;
    el.querySelectorAll("[data-k]").forEach(function (s) {
      s.addEventListener("change", function () {
        var k = s.getAttribute("data-k");
        if (k === "groupBy") {
          onChange("groupBy", s.value);
        } else if (k === "sampleCount") {
          onChange("sampleCount", parseInt(s.value, 10));
        } else {
          onChange("rowLimit", PolarisWidgets.parseRowLimit(s.value));
        }
      });
    });
    // Shared "Minimum severity" display filter — appended last so it sits
    // between the per-widget controls and the region/asset-type scope block.
    PolarisWidgets.renderMinSeverityConfig(el, config, onChange);
  }

  window.PolarisTopN = { renderRows: renderRows, renderConfig: renderConfig, pickColor: pickColor };
})();
