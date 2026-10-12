/**
 * public/js/chart-severity.js — severity shading for asset-detail charts.
 *
 * An automation can escalate one alert by value (business rule 19: tier 0 at the
 * trigger's own threshold, severity bands stacked above it). A chart drawn in a
 * single accent color tells the operator nothing about which of those tiers a
 * reading is sitting in, so a 41 °C spike and a 20 °C idle look alike.
 *
 * These helpers turn the tier ladder that the SERVER computed for this asset +
 * this sensor (GET /assets/:id/metric-thresholds, backed by the same
 * resolveTierLadder the engine evaluates) into SVG linear-gradient stops keyed
 * on the chart's value domain. The gradient is vertical and in user space, so
 * the line — and every dot on it — takes the color of the severity at its own
 * height, fading between tiers rather than switching hard.
 *
 * Pure and DOM-free, loaded before assets.js and exposed on
 * window.PolarisChartSeverity (unit-tested in tests/unit/chartSeverity.test.ts).
 */
(function () {
  "use strict";

  // Mirrors SEVERITIES in src/services/notificationTypes.ts (least → most severe)
  // and the .sev-select palette in styles.css. Each severity is its own
  // --color-sev-* token (styles.css :root + the daylight block), the palette the
  // .badge-level-* pills and severity-coloured tags read too.
  var SEV_ORDER = ["notice", "informational", "warning", "serious", "critical"];
  var SEV_COLOR = {
    notice: "var(--color-sev-notice)",
    informational: "var(--color-sev-informational)",
    warning: "var(--color-sev-warning)",
    serious: "var(--color-sev-serious)",
    critical: "var(--color-sev-critical)",
  };
  /** Color of a reading no tier claims — the charts' normal line color. */
  var BASE_COLOR = "var(--color-accent)";

  /**
   * The colour a `down` monitor state is DRAWN in, per severity — the browser
   * mirror of DOWN_SEVERITY_HEX in src/utils/severityStyle.ts, which the alert
   * email uses. Change one, change both.
   *
   * Down is not inherently red: red is what `critical` looks like, and critical
   * is merely the default severity of a seeded down automation. An operator who
   * says an outage on this device class is only worth a `warning` has said
   * something about how it should read.
   *
   * Flat hex rather than the theme tokens SEV_COLOR uses, for the same reason
   * the chart's fail / recovering / dependency colours are: these have to hold
   * on all three themes AND on the alert email's white card, and the browser and
   * the email must not draw one outage two different colours. They are pulled
   * deliberately deeper than the neighbours they sit beside in the chart's
   * vocabulary — the miss amber #ffc107, the recovering blue #0288d1, the
   * dependency grey #9aa0a6 — so the pairs stay tellable apart.
   */
  var DOWN_SEV_COLOR = {
    notice: "#546e7a",
    informational: "#1565c0",
    warning: "#f9a825",
    serious: "#e65100",
    critical: "#d32f2f",
  };
  /** What Down has always been drawn in, and the answer for an unknown or
   *  absent severity — including the case where no automation could be
   *  resolved at all, where inventing a gentler colour would understate a
   *  verdict Polaris is still asserting. */
  var DOWN_DEFAULT_COLOR = DOWN_SEV_COLOR.critical;
  /** Default fade depth at a tier boundary, as a fraction of chart height. */
  var DEFAULT_FADE = 0.05;

  function sevRank(s) { return SEV_ORDER.indexOf(s); }
  function colorOf(s) { return SEV_COLOR[s] || BASE_COLOR; }
  /** The colour a `down` probe/cell takes under an automation of this severity. */
  function downColorOf(s) { return DOWN_SEV_COLOR[s] || DOWN_DEFAULT_COLOR; }
  function isUp(op) { return op === ">" || op === ">="; }
  function isDown(op) { return op === "<" || op === "<="; }

  function tierMeets(tier, v) {
    switch (tier.operator) {
      case ">":  return v >  tier.threshold;
      case ">=": return v >= tier.threshold;
      case "<":  return v <  tier.threshold;
      case "<=": return v <= tier.threshold;
      default:   return false;
    }
  }

  function usableTiers(tiers) {
    return (tiers || []).filter(function (t) {
      return t && typeof t.threshold === "number" && isFinite(t.threshold) &&
        sevRank(t.severity) >= 0 && (isUp(t.operator) || isDown(t.operator));
    });
  }

  /** The most severe tier a value satisfies, or null. Mirrors the engine's
   *  "most-severe MET tier wins" rule (thresholds need not be monotonic). */
  function severityAt(tiers, v) {
    var best = null;
    usableTiers(tiers).forEach(function (t) {
      if (!tierMeets(t, v)) return;
      if (!best || sevRank(t.severity) > sevRank(best.severity)) best = t;
    });
    return best ? best.severity : null;
  }

  /**
   * Gradient stops for a value domain, top (maxV) → bottom (minV).
   * `offset` is 0..1 down the plot area, matching an SVG linearGradient drawn
   * y1=top → y2=bottom. Returns [] when no tier lands in view AND the domain is
   * entirely un-escalated, so callers can keep their flat stroke.
   *
   * Thresholds outside the domain are handled by CLAMPING, not by widening it:
   * a chart whose whole range sits above critical is entirely critical-colored,
   * and a cold threshold 60° below the data adds nothing.
   */
  function gradientStops(tiers, minV, maxV, opts) {
    opts = opts || {};
    var fade = typeof opts.fade === "number" ? opts.fade : DEFAULT_FADE;
    var use = usableTiers(tiers);
    if (!use.length || !(maxV > minV)) return [];
    var span = maxV - minV;
    var offsetOf = function (v) { return (maxV - v) / span; };

    // Color changes only at a threshold: cut the domain there, then ask what
    // severity holds in each resulting slice.
    var cuts = [0, 1];
    use.forEach(function (t) {
      var o = offsetOf(t.threshold);
      if (o > 1e-4 && o < 1 - 1e-4) cuts.push(o);
    });
    cuts.sort(function (a, b) { return a - b; });
    cuts = cuts.filter(function (o, i, arr) { return i === 0 || o - arr[i - 1] > 1e-6; });

    var intervals = [];
    for (var i = 0; i < cuts.length - 1; i++) {
      var midValue = maxV - ((cuts[i] + cuts[i + 1]) / 2) * span;
      var color = colorOf(severityAt(use, midValue));
      var prev = intervals[intervals.length - 1];
      // Merge touching slices of the same color so no pointless fade is emitted.
      if (prev && prev.color === color) prev.to = cuts[i + 1];
      else intervals.push({ from: cuts[i], to: cuts[i + 1], color: color });
    }
    if (intervals.length === 1 && intervals[0].color === BASE_COLOR) return [];

    var stops = [];
    intervals.forEach(function (iv, idx) {
      // Fade is capped at a third of the slice so a thin band can't invert its
      // own stops (a critical tier 1° above serious still reads as a band).
      var f = Math.min(fade, (iv.to - iv.from) / 3);
      stops.push({ offset: iv.from + (idx === 0 ? 0 : f), color: iv.color });
      stops.push({ offset: iv.to - (idx === intervals.length - 1 ? 0 : f), color: iv.color });
    });
    return stops;
  }

  /** Tiers whose threshold falls inside the domain — the ones worth drawing a
   *  reference line for. Outside ones are already expressed by the shading. */
  function visibleTiers(tiers, minV, maxV) {
    return usableTiers(tiers).filter(function (t) { return t.threshold > minV && t.threshold < maxV; });
  }

  /** "≥ 40" / "≤ 0" — the comparator as an operator reads it. */
  function tierLabel(tier, unit) {
    var cmp = tier.operator === ">=" ? "≥" : tier.operator === ">" ? ">" : tier.operator === "<=" ? "≤" : "<";
    var num = Math.round(tier.threshold * 100) / 100;
    return tier.severity + " " + cmp + " " + num + (unit ? " " + unit : "");
  }

  window.PolarisChartSeverity = {
    SEV_ORDER: SEV_ORDER,
    BASE_COLOR: BASE_COLOR,
    DOWN_DEFAULT_COLOR: DOWN_DEFAULT_COLOR,
    colorOf: colorOf,
    downColorOf: downColorOf,
    severityAt: severityAt,
    gradientStops: gradientStops,
    visibleTiers: visibleTiers,
    tierLabel: tierLabel,
  };
})();
