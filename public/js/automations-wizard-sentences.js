/**
 * public/js/automations-wizard-sentences.js — the sentence builder (makeAutomationSentences, a pure
 * factory over the /schema payload): the trigger / reset prose the list and the
 * editor share; window.PolarisAutomationSentences.
 *
 * Part of the automation wizard (CQ-F051): plain browser scripts sharing page
 * globals, loaded right after automations-wizard.js on every page that
 * carries it and in app-panels.js's asset bundle, in WIZARD_FILES order.
 * Pure — no wizard state. See tests/unit/automationsWizardSplit.test.ts.
 */

// ─── Sentence builder (pure; factory over the /schema payload) ───
// Everything the live wizard sentence + summary rendering needs, closed over
// only the schema `s` — no draft/DOM state — so it is unit-testable
// (tests/unit/automationSentences.test.ts evaluates this file in a Node vm
// and pulls the factory off window.PolarisAutomationSentences, same idiom as
// the appmap filter core). Extracted verbatim from openAutomationWizard 2026-08.
function makeAutomationSentences(s) {
  function findType(t) { return s.triggerTypes.find(function (x) { return x.type === t; }); }
  /** Device-scoped? Composite depends on kind (host composites ignore scope). */
  function isTriggerScoped(tr) {
    if (!tr || !tr.type) return true;
    if (tr.type === "composite") return tr.kind !== "host";
    var def = findType(tr.type);
    return !!(def && def.scoped);
  }
  function metricLabel(m) { var x = s.metricMeta && s.metricMeta[m]; return x ? x.label : m; }
  function metricUnit(m) { var x = s.metricMeta && s.metricMeta[m]; return (x && x.unit) || ""; }
  // hwSensorValue's unit depends on the sensor class in the dimension filter
  // (metricMeta carries the "(sensor unit)" placeholder) — resolve it from the
  // schema's sensorClassUnits map (temperature → °C, fan → RPM, voltage → V,
  // disk → °C). "" when the class is empty/unknown or the class has no unit.
  function leafUnit(metric, df) {
    var u = metricUnit(metric);
    if (u !== "(sensor unit)") return u;
    var cls = df && df.sensorClass ? String(df.sensorClass).trim().toLowerCase() : "";
    return (cls && s.sensorClassUnits && s.sensorClassUnits[cls]) || "";
  }
  // Storage used is ONE condition in the builder — "Storage used >= [80] [% ▾]"
  // — over two stored metrics: the % unit is storageUsedPct, a size unit is
  // storageUsedBytes with the threshold stored in bytes. Both carried the same
  // label, so listing them separately put "Storage used" in the picker twice.
  // Sizes are 1024-based with formatBytes' labels, the same figures the
  // asset's storage table shows.
  var BYTE_UNITS = [["KB", 1024], ["MB", 1048576], ["GB", 1073741824], ["TB", 1099511627776]];
  var PCT_OF_BYTES = { storageUsedBytes: "storageUsedPct" };
  var BYTES_OF_PCT = { storageUsedPct: "storageUsedBytes" };
  function byteUnitMult(u) {
    for (var i = 0; i < BYTE_UNITS.length; i++) if (BYTE_UNITS[i][0] === u) return BYTE_UNITS[i][1];
    return null;
  }
  /** The unit a stored byte threshold reads best in: the largest that leaves a
   *  value of at least 1. GB when there is no value yet. */
  function byteUnitFor(bytes) {
    var n = Number(bytes);
    if (bytes == null || bytes === "" || !isFinite(n) || n <= 0) return "GB";
    var pick = BYTE_UNITS[0][0];
    BYTE_UNITS.forEach(function (u) { if (n >= u[1]) pick = u[0]; });
    return pick;
  }
  function bytesIn(bytes, unit) {
    var m = byteUnitMult(unit) || 1;
    return Math.round((Number(bytes) / m) * 1000) / 1000;
  }
  /** "80 %", "500 GB", "…" — a threshold as prose, a byte threshold in its unit. */
  function thresholdText(metric, df, thr) {
    var u = leafUnit(metric, df);
    if (thr == null || thr === "" || isNaN(thr)) return "…" + (u && u !== "bytes" ? " " + u : "");
    if (u === "bytes") { var bu = byteUnitFor(thr); return bytesIn(thr, bu) + " " + bu; }
    return String(thr) + (u ? " " + u : "");
  }
  function fieldLabel(f) { var x = s.fieldMeta && s.fieldMeta[f]; return x ? x.label : f; }
  function changeLabel(c) { return (s.changeTypeMeta && s.changeTypeMeta[c]) || c; }

  // ── Down detection ──────────────────────────────────────────────────────
  // A `monitor status == down` automation does not merely READ the column — its
  // missedPolls count is what the probe loop compares consecutiveFailures
  // against for every device it covers (business rule 36). Four surfaces have to
  // agree on the question "is this one of those?": the wizard's condition row,
  // the automations list's type badge, the asset Alerts tab, and the passive
  // pill's explanation — so the predicate is exported rather than re-derived.
  // The shape comes from schema.downDetection, so a pre-upgrade server (no key)
  // degrades to the plain state row instead of rendering a control the API
  // would reject.
  function downDetectionMeta() { return s.downDetection || null; }
  function isDownDetectionLeaf(leaf) {
    var dd = downDetectionMeta();
    if (!dd || !leaf || leaf.type !== "asset_state") return false;
    return leaf.field === dd.field &&
           String(leaf.operator || "==") === String(dd.operator || "==") &&
           String(leaf.value).toLowerCase() === String(dd.value).toLowerCase();
  }
  function isDownDetectionTrigger(tr) {
    if (!tr) return false;
    // Authority lives on a BARE trigger only. A multi-leaf composite is
    // rejected server-side (the probe loop cannot evaluate a CPU reading on the
    // way to deciding down), so treating one as a down-detection automation
    // here would label a rule the server refuses to give authority to.
    return isDownDetectionLeaf(tr);
  }
  function missedPollsOf(leaf) {
    var dd = downDetectionMeta();
    var n = Number(leaf && leaf.missedPolls);
    return n > 0 ? Math.round(n) : ((dd && dd.default) || 3);
  }
  // Does this leaf actually DECLARE a count, i.e. is it the automation's own
  // definition of down? Distinct from the shape test above, and the distinction
  // matters for every sentence: a `monitor status == down` leaf inside a
  // multi-condition trigger carries NO authority (the server refuses a count
  // there — the probe loop cannot evaluate a CPU reading on the way to deciding
  // down), so phrasing it as "misses 3 polls in a row" would state a count that
  // does not exist and that nothing would honour. Such a leaf reads as the plain
  // status comparison it really is.
  function leafDeclaresDownCount(leaf) {
    return isDownDetectionLeaf(leaf) && leaf.missedPolls != null;
  }
  // ── Dependency-down alerting (business rule 78) ─────────────────────────
  // A down automation may opt to still alert about a device that is
  // dependency-suppressed (Dep. Down), naming the upstream device. The key
  // rides the trigger like `missedPolls`, and its NAME comes from the catalog:
  // a pre-upgrade server (no `dependencyDownKey`) renders no control at all,
  // rather than one whose key the API would refuse.
  function dependencyDownMeta() {
    var dd = downDetectionMeta();
    return dd && dd.dependencyDownKey ? dd : null;
  }
  function leafAlertsWhenDependencyDown(leaf) {
    var dd = dependencyDownMeta();
    return !!(dd && isDownDetectionLeaf(leaf) && leaf[dd.dependencyDownKey] === true);
  }
  // ── State (0/1) metrics ────────────────────────────────────────────────
  // A state metric's reading is a flag, so its threshold is 0 or 1 and the
  // number is meaningless to read back: the automation is about "Alarm", not
  // about "== 1". The probe registry (schema.stateProbes) carries each probe's
  // name and its two labels, so every surface renders the operator's own words.
  function isBooleanMetric(m) {
    return !!m && (s.booleanMetrics || []).indexOf(m) !== -1;
  }
  function stateProbeOf(id) {
    if (!id) return null;
    var list = s.stateProbes || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  /** The probe's map, or the generic true/false fallback when the probe can't be
   *  resolved (deleted profile, or a schema fetched before it was defined). */
  /**
   * The two state names for a boolean leaf, in the operator's own words.
   *
   * Two sources, most-specific first: a `customStateValue` row names its chosen
   * PROBE's labels (per-probe, from the registry), and any other boolean metric
   * falls back to the metric-wide labels the server declares
   * (`booleanMetricLabels`, e.g. hwSensorAlarm → Alarm / OK). Generic
   * "true"/"false" is the last resort — a probe that no longer resolves, or a
   * schema fetched before a metric's labels existed.
   */
  function stateMapOf(metric, df) {
    var p = stateProbeOf(df && df.stateProbeId);
    var m = p && p.stateMap;
    if (m) {
      return {
        trueLabel: m.trueLabel || "true",
        falseLabel: m.falseLabel || "false",
        trueIsProblem: m.trueIsProblem !== false,
        name: p.name || "",
      };
    }
    var byMetric = (s.booleanMetricLabels || {})[metric];
    return {
      trueLabel: (byMetric && byMetric.trueLabel) || "true",
      falseLabel: (byMetric && byMetric.falseLabel) || "false",
      trueIsProblem: !byMetric || byMetric.trueIsProblem !== false,
      name: "",
    };
  }
  /** "Alarm" / "OK" for a 0/1 threshold. */
  /**
   * One monitorStatus VALUE as operators know it, lower-cased so it drops into
   * a sentence ("Monitor status equals missed"). The stored value is the enum —
   * `warning` — but every pill in the product reads "Missed", and the sentence
   * is the last place that quoted the column instead of the label. Falls back
   * to the raw value when api.js hasn't loaded (the factory is also used by
   * automations.js, which loads it, and by the DOM tests, which may not).
   */
  function monStatusWord(value) {
    var raw = value == null ? "" : String(value);
    if (!raw) return raw;
    return (typeof monitorStatusLabel === "function" ? monitorStatusLabel(raw) : raw).toLowerCase();
  }
  function stateValueLabel(metric, df, threshold) {
    var t = Number(threshold);
    if (t !== 0 && t !== 1) return "…";
    var m = stateMapOf(metric, df);
    return t === 1 ? m.trueLabel : m.falseLabel;
  }
  /** The clause for a boolean leaf: "PSU alarm is Alarm on rows matching PSU 2",
   *  or "Hardware sensor alarm is Alarm on sensors matching TMP1". A resolved
   *  probe NAME becomes the subject (so stateProbeId isn't also repeated as a
   *  dimension clause); every other dimension renders through the shared
   *  DIM_PHRASE table exactly as it does on a numeric leaf. The aggregation reads
   *  as "at any point in" / "throughout" rather than min/max of a flag. */
  function stateLeafClause(leaf) {
    var df = leaf.dimensionFilter || {};
    var m = stateMapOf(leaf.metric, df);
    var subject = m.name || metricLabel(leaf.metric);
    var verb = leaf.operator === "!=" ? "is not" : "is";
    var out = subject + " " + verb + " " + stateValueLabel(leaf.metric, df, leaf.threshold);
    if (leaf.windowSec > 0 && leaf.aggregation === "max") out += " at any point in the last " + humanDuration(leaf.windowSec);
    else if (leaf.windowSec > 0 && leaf.aggregation === "min") out += " throughout the last " + humanDuration(leaf.windowSec);
    Object.keys(df).forEach(function (k) {
      // The probe is the subject when it resolved to a name; an unresolved one
      // still shows as a clause so the filter is never invisible.
      if (k === "stateProbeId" && m.name) return;
      if (df[k]) out += " " + dimPhrase(k, df[k]);
    });
    return out;
  }

  // ── Sentence builder ───────────────────────────────────────────────────
  var CMP_PHRASE = Object.assign({ ">": "is above", ">=": "is at or above", "<": "is below", "<=": "is at or below", "==": "equals", "!=": "is not" }, s.comparatorPhrases || {});
  var INV_CMP = Object.assign({ ">": "<=", ">=": "<", "<": ">=", "<=": ">", "==": "!=", "!=": "==" }, s.inverseComparators || {});
  var AGG_PHRASE = Object.assign({ latest: "", avg: "avg over", median: "median over", min: "min over", max: "max over" }, s.aggregationPhrases || {});
  var DIM_PHRASE = Object.assign({
    sensorClass: "for sensors of class {value}", sensorNamePattern: "on sensors matching {value}",
    ifNamePattern: "on interfaces matching {value}",
    ifTag: "on interfaces tagged {value}",
    hostnamePattern: "on devices whose hostname matches {value}",
    ipPattern: "on devices whose IP matches {value}",
    macPattern: "on devices whose MAC matches {value}",
    manufacturerPattern: "on devices whose manufacturer matches {value}",
    modelPattern: "on devices whose model matches {value}",
    mountPathPattern: "on mounts matching {value}", sdwanRulePattern: "on SD-WAN rules matching {value}",
    healthCheck: "for health check {value}",
    link: "on member {value}", tunnelName: "on tunnel {value}", widgetId: "for widget {value}",
    sdwanMemberIp: "on members whose IP address {value}",
    processNamePattern: "for processes matching {value}",
    // Mirrors the server's dimensionPhrases. Present as built-in fallbacks too so
    // the factory reads correctly against a partial /schema payload, the same as
    // every other dimension above.
    stateProbeId: "for probe {value}", stateRowPattern: "on rows matching {value}",
    checkId: "for check {value}",
  }, s.dimensionPhrases || {});

  /** A path check's NAME for its id — the id must never reach a
   *  sentence. Resolved off /schema's `pathChecks` registry. */
  function checkNameOf(id) {
    var list = s.pathChecks || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return "«" + list[i].name + "»";
    return id + " (not found)";
  }
  /** A custom widget's NAME for its id (a UUID or a Generic API `ga:` key),
   *  off /schema's `customWidgets`. Same quoting as checkNameOf. */
  function widgetNameOf(id) {
    var list = s.customWidgets || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return "«" + list[i].name + "»";
    return id + " (not found)";
  }
  /** One dimension clause: the DIM_PHRASE template with its value. */
  function dimPhrase(k, value) {
    var v = k === "checkId" && value && value !== "…" ? checkNameOf(value)
      : k === "widgetId" && value && value !== "…" ? widgetNameOf(value)
      : value;
    // A multi value reads as a list: "for health check Microsoft or Primary WAN".
    if (awDimIsMulti(k) && value && value !== "…") v = awDimTerms(value).join(" or ");
    // The SD-WAN member IP filter stores a comparison, not a pattern: word it.
    if (k === "sdwanMemberIp" && value && value !== "…") v = awMemberIpWords(value);
    return (DIM_PHRASE[k] || k + " = {value}").replace("{value}", v);
  }

  // Windowed-ratio metrics: the window is the measurement, mirrored from the
  // server's `windowedRatioMetrics` with the same built-in fallback the other
  // catalogs use so the factory reads correctly against a partial payload.
  var RATIO_WINDOW_DEFAULT_SEC = 900;
  function isWindowedRatio(m) {
    return (s.windowedRatioMetrics || ["probeLossPct"]).indexOf(m) !== -1;
  }
  /** A forecast-over-a-horizon metric (memory forecast): it names its horizon
   *  where an aggregation would go — " (14 days out)", the server's
   *  triggerSubject wording. */
  function forecastClause(leaf) {
    if ((s.forecastHorizonMetrics || ["memForecastPct"]).indexOf(leaf.metric) === -1) return "";
    var n = typeof leaf.forecastDays === "number" && leaf.forecastDays >= 1 ? Math.round(leaf.forecastDays) : (s.forecastDaysDefault || 14);
    return " (" + n + (n === 1 ? " day" : " days") + " out)";
  }
  /** A leaf's COUNT window (business rule 66), or 0. Mirrors triggerWindowPolls
   *  server-side: never on a ratio (its window is its own denominator) and never
   *  on `latest` (no window at all), so the prose can't claim a count the engine
   *  would ignore. Kept inside the pure factory — it reads the same draft the
   *  sentence does and must not reach for anything in the DOM. */
  function leafCountWindow(leaf) {
    if (!leaf || isWindowedRatio(leaf.metric)) return 0;
    if (!leaf.aggregation || leaf.aggregation === "latest") return 0;
    var n = leaf.windowPolls;
    return typeof n === "number" && n > 0 ? Math.round(n) : 0;
  }
  function humanDuration(sec) {
    if (!sec || sec <= 0) return "";
    if (sec % 3600 === 0) { var h = sec / 3600; return h + (h === 1 ? " hour" : " hours"); }
    if (sec % 60 === 0) { var m = sec / 60; return m + (m === 1 ? " minute" : " minutes"); }
    return sec + " seconds";
  }
  function tgLeafPhrase(leaf) {
    if (!leaf || !leaf.type) return "…";
    // Defensive: a filter row from an UNCOMPILED UI tree (the stored trigger
    // never carries one — tgFilterCompile folds them away before save).
    if (leaf.type === "asset_filter") {
      return dimPhrase(leaf.dim, String(leaf.value || "…"));
    }
    if (leaf.type === "asset_state") {
      // A down-detection leaf is not a status comparison to read back — it is a
      // statement about what the operator wants "down" to MEAN, so it reads as
      // the device behaviour rather than as the column value it produces.
      if (leafDeclaresDownCount(leaf)) {
        var dMiss = missedPollsOf(leaf);
        var dOut = "the device misses " + dMiss + " poll" + (dMiss === 1 ? "" : "s") + " in a row";
        var dDf = leaf.dimensionFilter || {};
        Object.keys(dDf).forEach(function (k) {
          if (dDf[k]) dOut += " " + dimPhrase(k, dDf[k]);
        });
        return dOut;
      }
      // The INVERTED down leaf (resetSentence's auto path runs the trigger
      // through invertedLeaf): recovery from an outage is an event — the device
      // answered — not a status value to compare against.
      if (leaf.field === "monitorStatus" && leaf.operator === "!=" && String(leaf.value).toLowerCase() === "down") {
        return "the device answers a poll again";
      }
      // "passive" is a coverage fact, not a device state, so it says so.
      if (leaf.field === "monitorStatus" && leaf.operator === "==" && String(leaf.value).toLowerCase() === "passive") {
        return "no down-detection automation covers the device";
      }
      var sVal = leaf.value == null || leaf.value === "" ? "…"
        : (leaf.field === "monitorStatus" ? monStatusWord(leaf.value) : String(leaf.value));
      var sOut = fieldLabel(leaf.field) + " " + (CMP_PHRASE[leaf.operator] || leaf.operator) + " " + sVal;
      // State leaves carry dimension filters too (interface for the ifOper
      // trio, tunnel for ipsecStatus, hostname everywhere) — render them the
      // same way a metric leaf does, or the filter is invisible in the sentence.
      var sDf = leaf.dimensionFilter || {};
      Object.keys(sDf).forEach(function (k) {
        if (sDf[k]) sOut += " " + dimPhrase(k, sDf[k]);
      });
      return sOut;
    }
    if (isBooleanMetric(leaf.metric)) return stateLeafClause(leaf);
    // A windowed ratio IS its window, so it says so plainly instead of borrowing
    // an aggregation phrase it doesn't have ("avg over 15 minutes" would be a
    // second average on top of a percentage).
    var agg = forecastClause(leaf) ? forecastClause(leaf)
      : isWindowedRatio(leaf.metric)
      ? " (over the last " + (humanDuration(leaf.windowSec) || humanDuration(RATIO_WINDOW_DEFAULT_SEC)) + " of probe history, from the first successful probe)"
      : leaf.aggregation && leaf.aggregation !== "latest" && leafCountWindow(leaf)
        ? " (" + (AGG_PHRASE[leaf.aggregation] || leaf.aggregation) + " the last " + leafCountWindow(leaf) + " readings)"
      : leaf.aggregation && leaf.aggregation !== "latest" && leaf.windowSec
        ? " (" + (AGG_PHRASE[leaf.aggregation] || leaf.aggregation) + " " + humanDuration(leaf.windowSec) + ")" : "";
    var out = (leaf.type === "host_metric" ? "the Polaris host's " : "") + metricLabel(leaf.metric) + agg + " " + (CMP_PHRASE[leaf.operator] || leaf.operator) + " " + thresholdText(leaf.metric, leaf.dimensionFilter, leaf.threshold);
    var df = leaf.dimensionFilter || {};
    Object.keys(df).forEach(function (k) {
      if (df[k]) out += " " + dimPhrase(k, df[k]);
    });
    return out;
  }
  function tgTreePhrase(node) {
    var parts = (node.children || []).map(function (c) {
      if (c && c.type === undefined && Array.isArray(c.children)) return "(" + tgTreePhrase(c) + ")";
      return tgLeafPhrase(c);
    });
    return parts.join(node.op === "or" ? " OR " : " AND ");
  }
  /**
   * The severity ladder tail: what the condition actually RAISES.
   *
   * Severity bands stack higher tiers on the same trigger (business rule 19) —
   * each band re-compares the metric with its own threshold, optionally its own
   * operator and its own sustained-for, and carries its own severity. The
   * sentence described tier 0 only, so a banded automation read as "at or above
   * 65 °C" while it actually escalates at 80 and 90; spell the whole ladder out.
   *
   * `opts.severity` is the base tier. Pass it (with or without bands) to have
   * the sentence name what fires; omit `opts` entirely for the bare condition
   * sentence the wizard rendered before bands existed.
   */
  function severityLadderPhrase(tr, opts) {
    var sev = opts && opts.severity;
    if (!sev) return "";
    // Bands are numeric-metric-only server-side; ignore any that ride along on
    // another trigger type (or on a 0/1 state metric, where a threshold ladder
    // over two values means nothing) rather than describing a threshold that
    // can't exist.
    var banded = tr && (tr.type === "asset_metric" || tr.type === "host_metric") && !isBooleanMetric(tr.metric);
    var bands = (banded && opts.severityBands ? opts.severityBands : []).filter(function (b) { return b && b.severity; });
    if (!bands.length) return " — <strong>" + escapeHtml(sev) + "</strong>";
    var baseDur = tr.forDurationSec || 0;
    var parts = ["<strong>" + escapeHtml(sev) + "</strong> at this level"];
    bands.forEach(function (b) {
      var op = b.operator || tr.operator;
      // "serious at or above 90 %" — the tier name is the subject here, so the
      // comparator drops its leading "is" ("is at or above" reads as a verb
      // phrase about the metric, which the base clause already supplied).
      var cmp = String(CMP_PHRASE[op] || op).replace(/^is /, "");
      var p = "<strong>" + escapeHtml(b.severity) + "</strong> " + escapeHtml(cmp) + " " +
        escapeHtml(thresholdText(tr.metric, tr.dimensionFilter, b.threshold));
      // A band inherits the base sustained-for unless it sets its own — print
      // only the deviation, so the common (inherited) case stays readable.
      var dur = b.forDurationSec == null ? baseDur : b.forDurationSec;
      if (dur !== baseDur) p += dur > 0 ? " for " + humanDuration(dur) : " immediately";
      parts.push(p);
    });
    return " — " + parts.join(", ");
  }
  /**
   * How a hold reads in prose: "3 polls" when the rule COUNTS readings (which
   * is what the engine does with it), the wall-clock mirror otherwise. Every
   * sentence surface goes through this so the words can't disagree with the
   * field the operator typed into.
   */
  function holdPhrase(tr) {
    var n = tr && typeof tr.forPolls === "number" && tr.forPolls > 0 ? Math.round(tr.forPolls) : 0;
    if (n > 0) return n + (n === 1 ? " poll" : " polls");
    return humanDuration((tr && tr.forDurationSec) || 0);
  }
  /** The same, compact, for the formula block ("held 3p" / "held 10m"). */
  function holdPhraseCompact(tr) {
    var n = tr && typeof tr.forPolls === "number" && tr.forPolls > 0 ? Math.round(tr.forPolls) : 0;
    return n > 0 ? n + "p" : compactDuration((tr && tr.forDurationSec) || 0);
  }
  function triggerSentence(tr, opts) {
    if (!tr || !tr.type) return "…";
    var out;
    var tail = severityLadderPhrase(tr, opts);
    if (tr.type === "composite") {
      out = "When <strong>" + escapeHtml(tgTreePhrase({ op: tr.op, children: tr.children || [] }) || "…") + "</strong>";
      if (tr.forDurationSec > 0) out += ", sustained for <strong>" + holdPhrase(tr) + "</strong>";
      return out + tail + ".";
    }
    if (tr.type === "asset_metric" && isBooleanMetric(tr.metric)) {
      out = "When <strong>" + escapeHtml(stateLeafClause(tr)) + "</strong>";
      if (tr.forDurationSec > 0) out += ", sustained for <strong>" + holdPhrase(tr) + "</strong>";
      if (tr.includeServer === true) out += ", including the <strong>Polaris server</strong>’s own runs";
      return out + tail + ".";
    }
    if (tr.type === "asset_metric" || tr.type === "host_metric") {
      var subject = tr.type === "host_metric" ? "the Polaris host's " + metricLabel(tr.metric) : metricLabel(tr.metric);
      // The `|| tr.x` fallbacks echo the STORED value when it isn't a known
      // phrase key. The builder only ever emits known keys, but a rule can also
      // be written straight to the API, so the fallback is arbitrary stored text
      // landing in a sentence the wizard assigns to innerHTML — escape it.
      // A windowed ratio prints its History window (the measurement itself) the
      // way tgLeafPhrase does — its aggregation is "latest", so the ordinary
      // agg clause would silently drop the window from a stored (collapsed)
      // loss rule's sentence.
      var agg = forecastClause(tr) ? forecastClause(tr)
        : isWindowedRatio(tr.metric)
        ? " (over the last " + (humanDuration(tr.windowSec) || humanDuration(RATIO_WINDOW_DEFAULT_SEC)) + " of probe history, from the first successful probe)"
        : tr.aggregation && tr.aggregation !== "latest" && tr.windowSec
          ? " (" + escapeHtml(AGG_PHRASE[tr.aggregation] || tr.aggregation) + " " +
            (leafCountWindow(tr) ? "the last " + leafCountWindow(tr) + " readings" : humanDuration(tr.windowSec)) + ")" : "";
      out = "When <strong>" + escapeHtml(subject) + agg + " " + escapeHtml(CMP_PHRASE[tr.operator] || tr.operator) + " " + escapeHtml(thresholdText(tr.metric, tr.dimensionFilter, tr.threshold)) + "</strong>";
      var df = tr.dimensionFilter || {};
      Object.keys(df).forEach(function (k) {
        if (df[k]) out += " " + escapeHtml(dimPhrase(k, df[k]));
      });
    } else if (tr.type === "asset_state") {
      var trVal = tr.value == null || tr.value === "" ? "…"
        : (tr.field === "monitorStatus" ? monStatusWord(tr.value) : String(tr.value));
      out = "When <strong>" + escapeHtml(fieldLabel(tr.field)) + " " + escapeHtml(CMP_PHRASE[tr.operator] || tr.operator) + " " + escapeHtml(trVal) + "</strong>";
      // Same dimension clauses a metric trigger renders — a state trigger can
      // filter by interface / tunnel / hostname and the sentence must say so.
      var sdf = tr.dimensionFilter || {};
      Object.keys(sdf).forEach(function (k) {
        if (sdf[k]) out += " " + escapeHtml(dimPhrase(k, sdf[k]));
      });
    } else if (tr.type === "event") {
      // The detail conditions are named here, not summarised as "with filters":
      // an automation that fires one way only (direction = escalated) reads as
      // one that fires on everything unless the sentence says the word.
      var dmt = (tr.detailsMatch && typeof tr.detailsMatch === "object") ? tr.detailsMatch : {};
      var dmKeys = Object.keys(dmt);
      out = "When an audit event matching <strong>" + escapeHtml(tr.actionPattern || "…") + "</strong>" +
        (tr.resourceType ? " on <strong>" + escapeHtml(tr.resourceType) + "</strong> resources" : "") +
        (tr.minLevel ? " at level <strong>" + escapeHtml(tr.minLevel) + "</strong> or above" : "") +
        (dmKeys.length
          ? " saying " + dmKeys.map(function (k) {
              return "<strong>" + escapeHtml(k) + " = " + escapeHtml(String(dmt[k])) + "</strong>";
            }).join(" and ")
          : "") + " occurs";
    } else if (tr.type === "change") {
      out = "When <strong>" + escapeHtml(changeLabel(tr.changeType)) + "</strong> is detected";
    } else {
      out = "…";
    }
    if ((tr.type === "asset_metric" || tr.type === "host_metric" || tr.type === "asset_state") && tr.forDurationSec > 0) {
      out += ", sustained for <strong>" + holdPhrase(tr) + "</strong>";
    }
    // Business rule 78 — the one thing this automation does that a plain down
    // automation does not, so the sentence has to say it: a reader comparing
    // two down automations in the list is otherwise looking at identical prose.
    if (leafAlertsWhenDependencyDown(tr)) {
      out += " — and still when the device is <strong>dependency-down</strong>, naming the upstream device";
    }
    // Path Monitor: the server is a source no device filter names, so the
    // sentence is the one place an operator reading the list learns it counts.
    if (tr.includeServer === true && (tr.type === "asset_metric" || tr.type === "change")) {
      out += ", including the <strong>Polaris server</strong>’s own runs";
    }
    return out + tail + ".";
  }
  // ── Formula view ────────────────────────────────────────────────────────
  // The machine-readable twin of triggerSentence, rendered under it on step 3.
  //
  // It exists because the sentence reads loosest exactly where the semantics get
  // subtle: the wizard has ONE poll-counted duration field, and it means two
  // different things (tgStampWindows). With an aggregation it is the MEASUREMENT
  // WINDOW — the value is reduced over the period, so a dip inside it averages
  // away. With `latest` it is a HOLD CLOCK — the newest sample must qualify at
  // every 60s check across the period, and one that doesn't restarts it. The
  // formula puts the window INSIDE the term and the hold OUTSIDE it, so the two
  // can't read alike.
  //
  // Returns PLAIN TEXT (the caller escapes and renders it monospaced), as
  // { lines, note }: severity bands are one line per tier aligned under the
  // shared term, and `note` carries the sampling-floor caveat below. Event and
  // change triggers return no lines — they carry no aggregation and no window,
  // so their English sentence is already exact and a formula would only add
  // syntax.

  // The engine reads samples over `max(windowSec, 15 min)` and reduces every row
  // it fetched (notificationEngine.resolveAssetMetricReadings), so a window
  // under the floor is really measured over the floor. The formula prints the
  // window the operator configured and says so in the note rather than quietly
  // showing either number as if it were the whole truth.
  var SAMPLING_FLOOR_SEC = 900;
  var FORMULA_AGG = Object.assign({ latest: "latest", avg: "avg", median: "median", min: "min", max: "max" }, s.formulaAggregations || {});
  // Over a 0/1 flag, min/max are "did it ever" / "was it always" — reading them
  // as min()/max() of a boolean is the same unreadability the state labels fix.
  var FORMULA_STATE_AGG = { latest: "latest", max: "any", min: "all", avg: "avg", median: "median" };
  var FORMULA_DIM = Object.assign({
    sensorClass: "class=", sensorNamePattern: "name~", ifNamePattern: "if~", ifTag: "ifTag=",
    mountPathPattern: "mount~", sdwanRulePattern: "rule~", healthCheck: "health=", link: "member=",
    tunnelName: "tunnel=", widgetId: "widget=", processNamePattern: "process~",
    stateProbeId: "probe=", stateRowPattern: "row~", hostnamePattern: "host~", checkId: "check=",
    ipPattern: "ip~", macPattern: "mac~", manufacturerPattern: "mfr~", modelPattern: "model~",
  }, s.formulaDimensions || {});

  /** "15m" / "2h" / "45s" — the compact form, since a formula line is dense. */
  function compactDuration(sec) {
    if (!sec || sec <= 0) return "";
    if (sec % 3600 === 0) return (sec / 3600) + "h";
    if (sec % 60 === 0) return (sec / 60) + "m";
    return sec + "s";
  }
  function spaces(n) { return n > 0 ? new Array(n + 1).join(" ") : ""; }

  /** `[class="temperature", name~"CPU ON-DIE"]`, or "" with no filter. */
  function formulaDims(leaf, skipProbe) {
    var df = leaf.dimensionFilter || {};
    var parts = [];
    Object.keys(df).forEach(function (k) {
      if (!df[k]) return;
      if (k === "stateProbeId" && skipProbe) return; // the probe is the subject
      var v = df[k];
      if (k === "stateProbeId") {
        var p = stateProbeOf(v);
        if (p && p.name) v = p.name;
      }
      if (k === "checkId") v = checkNameOf(v).replace(/[«»]/g, "");
      if (k === "widgetId") v = widgetNameOf(v).replace(/[«»]/g, "");
      // A comparison, already carrying its operator: memberIp != 0.0.0.0.
      if (k === "sdwanMemberIp") { parts.push("memberIp " + String(v).trim().replace(/\s+/, " ")); return; }
      parts.push((FORMULA_DIM[k] || (k + "=")) + '"' + v + '"');
    });
    return parts.length ? "[" + parts.join(", ") + "]" : "";
  }

  /** The value side: `median(CPU usage[if~"wan"], 15m)`. */
  function formulaTerm(leaf) {
    // The formula view exists to name the MECHANISM the prose smooths over, so
    // a down-detection leaf shows the counter the probe loop actually compares
    // rather than the status column that comparison produces.
    if (leafDeclaresDownCount(leaf)) {
      return "consecutive_misses(response poll" + formulaDims(leaf, false).replace(/^\[/, ", ").replace(/\]$/, "") + ")";
    }
    // A state leaf's dimension filters (interface / tunnel / hostname) render
    // inside the term like a metric's: `Interface oper status[if~"wan"]`.
    if (leaf.type === "asset_state") return fieldLabel(leaf.field) + formulaDims(leaf, false);
    var df = leaf.dimensionFilter || {};
    var flag = isBooleanMetric(leaf.metric);
    var probeName = flag ? stateMapOf(leaf.metric, df).name : "";
    var subject = probeName ||
      (leaf.type === "host_metric" ? "host " + metricLabel(leaf.metric) : metricLabel(leaf.metric));
    var agg = leaf.aggregation || "latest";
    var fn = (flag ? FORMULA_STATE_AGG[agg] : FORMULA_AGG[agg]) || agg;
    // `loss(probes, 15m since first ok)` — the window is inside the term because
    // it IS the measurement. A hold, when the operator sets one, prints outside
    // it as "held 10m" like any other term's (the two axes, shown apart).
    if (isWindowedRatio(leaf.metric)) {
      return "loss(probes" + formulaDims(leaf, false) + ", " +
        compactDuration(leaf.windowSec > 0 ? leaf.windowSec : RATIO_WINDOW_DEFAULT_SEC) + " since first ok)";
    }
    // `latest` reads one sample, so it takes no window argument — that absence is
    // the whole point of the view. Every other aggregation always prints one,
    // falling back to the floor when the trigger carries no window at all (which
    // the wizard refuses to save, but a hand-written rule can).
    // A COUNT window prints as the count (business rule 66) — "avg(RTT, 10p)"
    // says the window is ten readings, where "10m" would claim a clock the rule
    // does not keep.
    var win = agg === "latest" ? ""
      : leafCountWindow(leaf) ? ", " + leafCountWindow(leaf) + "p"
      : ", " + compactDuration(leaf.windowSec > 0 ? leaf.windowSec : SAMPLING_FLOOR_SEC);
    return fn + "(" + subject + formulaDims(leaf, !!probeName) + win + ")";
  }
  /** The comparison side: `>= 65 °C`, or `== "Alarm"` for a flag. */
  function formulaCompare(leaf, operator, threshold) {
    var op = operator || leaf.operator;
    // Pairs with formulaTerm's counter: the comparison the probe loop makes is
    // `>= N`, not `== "down"`.
    if (leafDeclaresDownCount(leaf)) return ">= " + missedPollsOf(leaf);
    if (leaf.type === "asset_state") {
      return op + ' "' + (leaf.value == null || leaf.value === "" ? "…" : leaf.value) + '"';
    }
    if (isBooleanMetric(leaf.metric)) {
      return op + ' "' + stateValueLabel(leaf.metric, leaf.dimensionFilter || {}, threshold == null ? leaf.threshold : threshold) + '"';
    }
    var thr = threshold == null ? leaf.threshold : threshold;
    return op + " " + thresholdText(leaf.metric, leaf.dimensionFilter, thr);
  }
  function formulaLeafLine(leaf) { return formulaTerm(leaf) + " " + formulaCompare(leaf); }

  /** A nested group renders inline — `(a AND b)` — so the tree never indents
   *  past one level and the lines stay scannable. */
  function formulaInline(node) {
    var parts = (node.children || []).map(function (c) {
      if (c && c.type === undefined && Array.isArray(c.children)) return "(" + formulaInline(c) + ")";
      return formulaLeafLine(c);
    });
    return parts.join(node.op === "or" ? " OR " : " AND ");
  }

  /** " ⇒ warning", or "" when the caller didn't pass the ladder. */
  function sevArrow(sev) { return sev ? "  ⇒ " + sev : ""; }

  function triggerFormula(tr, opts) {
    var out = { lines: [], note: "" };
    if (!tr || !tr.type) return out;
    var sev = (opts && opts.severity) || "";
    var hold = tr.forDurationSec > 0 ? tr.forDurationSec : 0;

    if (tr.type === "composite") {
      var kids = tr.children || [];
      var op = tr.op === "or" ? "OR" : "AND";
      var pad = spaces(op.length + 1);
      kids.forEach(function (c, i) {
        var body = c && c.type === undefined && Array.isArray(c.children) ? "(" + formulaInline(c) + ")" : formulaLeafLine(c);
        out.lines.push((i === 0 ? pad : op + " ") + body);
      });
      // The hold applies to the whole tree, so it gets its own line rather than
      // hanging off whichever condition happens to be last.
      if (hold || sev) out.lines.push(pad + (hold ? "held " + holdPhraseCompact(tr) : "") + sevArrow(sev));
      out.note = formulaNote(tr);
      return out;
    }

    if (tr.type !== "asset_metric" && tr.type !== "host_metric" && tr.type !== "asset_state") return out;

    var term = formulaTerm(tr);
    out.lines.push(term + " " + formulaCompare(tr) + (hold ? "  held " + holdPhraseCompact(tr) : "") + sevArrow(sev));

    // Severity bands: same term, one line per tier, aligned under it. Mirrors
    // severityLadderPhrase's applicability test — bands riding along on a state
    // metric or a non-numeric trigger describe a threshold that can't exist.
    var banded = (tr.type === "asset_metric" || tr.type === "host_metric") && !isBooleanMetric(tr.metric);
    var bands = (banded && sev && opts.severityBands ? opts.severityBands : []).filter(function (b) { return b && b.severity; });
    bands.forEach(function (b) {
      // A band with its own seconds is a wall-clock band (resolveTierLadder);
      // one that inherits inherits the trigger's unit as well as its value.
      var dur = b.forDurationSec == null ? hold : b.forDurationSec;
      var phrase = b.forDurationSec == null ? holdPhraseCompact(tr) : compactDuration(dur);
      out.lines.push(spaces(term.length) + " " + formulaCompare(tr, b.operator || tr.operator, b.threshold) +
        (dur ? "  held " + phrase : "") + sevArrow(b.severity));
    });
    out.note = formulaNote(tr);
    return out;
  }

  /** The sampling-floor caveat, when any aggregated term asks for less than the
   *  floor (or carries no window at all). Empty when every window is honest. */
  function formulaNote(tr) {
    var flagged = false;
    function visit(leaf) {
      if (!leaf || leaf.type === "asset_state" || !leaf.metric) return;
      var agg = leaf.aggregation || "latest";
      if (agg === "latest") return;
      if (!(leaf.windowSec >= SAMPLING_FLOOR_SEC)) flagged = true;
    }
    function walk(node) {
      (node.children || []).forEach(function (c) {
        if (c && c.type === undefined && Array.isArray(c.children)) walk(c);
        else visit(c);
      });
    }
    if (tr.type === "composite") walk(tr); else visit(tr);
    if (!flagged) return "";
    return "Samples are read over a " + compactDuration(SAMPLING_FLOOR_SEC) +
      " floor, so a shorter measurement window is still reduced over the last " +
      humanDuration(SAMPLING_FLOOR_SEC) + ".";
  }

  /**
   * The trigger's clause, inverted — what has to become true for an auto-reset to
   * fire. Returns null for the trigger types with no single clause to invert.
   *
   * Numeric: the opposite comparator, at the hysteresis clear threshold when one
   * is set and otherwise at the SAME threshold that raised the alert.
   * 0/1 metrics: the VALUE flips rather than the comparator, because "is OK"
   * reads as a state an operator can look for while "is not Alarm" reads as a
   * double negative — and a flag has no dead band for a clear threshold to sit in.
   */
  function invertedLeaf(tr, reset) {
    if (!tr) return null;
    var t = tr.type;
    if (t !== "asset_metric" && t !== "host_metric" && t !== "asset_state") return null;
    var inv = {};
    Object.keys(tr).forEach(function (k) { inv[k] = tr[k]; });
    if (t !== "asset_state" && isBooleanMetric(tr.metric)) {
      inv.threshold = Number(tr.threshold) === 0 ? 1 : 0;
      inv.operator = tr.operator === "!=" ? "!=" : "==";
      return inv;
    }
    inv.operator = INV_CMP[tr.operator] || tr.operator;
    if (t !== "asset_state" && reset && reset.clearThreshold != null && !isNaN(reset.clearThreshold)) {
      inv.threshold = reset.clearThreshold;
    }
    return inv;
  }

  /**
   * A whole condition tree inverted — the seed for a custom reset condition, so
   * an operator starts from what the automatic reset would have done and edits
   * from there instead of from a blank row.
   *
   * De Morgan, not a wrapper: NOT(A AND B) is (NOT A) OR (NOT B), so the group
   * operator flips at every level alongside each leaf's comparator. That is also
   * why it stays expressible — the tree vocabulary is and/or only, and inverting
   * an and/or tree yields another and/or tree.
   *
   * A leaf that has nothing to invert (no comparator to flip) is copied through
   * untouched rather than dropped: leaving a condition the operator can see and
   * fix beats silently narrowing the tree they asked to be seeded.
   */
  function invertedTree(node) {
    if (!node || !Array.isArray(node.children)) return node;
    return {
      op: node.op === "and" ? "or" : "and",
      children: node.children.map(function (c) {
        if (c && c.type === undefined && Array.isArray(c.children)) return invertedTree(c);
        return invertedLeaf(c) || JSON.parse(JSON.stringify(c));
      }),
    };
  }

  /**
   * The part an operator can't read off the clause. Two cases are worth saying
   * out loud:
   *
   * A monitor-status alert clears at the FIRST successful probe, when the state
   * is `recovering` — not when it has fully returned to `up`. "Anything other
   * than down" is technically what happens, but nobody reads it that way, and the
   * gap matters: it is the difference between "the device answered once" and "the
   * device is healthy again".
   *
   * A numeric alert with no clear threshold resets at the very value that raised
   * it, so a reading sitting on the line re-alerts. The dead-band control is
   * right there on this step, so pointing at it is actionable.
   */
  function resetCaveat(tr, reset) {
    if (!tr) return "";
    // NOTE this tests the TRIGGER, so a composite carrying a down leaf never
    // reaches it (invertedLeaf returns null for trees and resetSentence's auto
    // path bails first). Pre-existing, and left as-is: the caveat is about the
    // single-trigger case an operator actually authors here.
    if (tr.type === "asset_state" && tr.field === "monitorStatus" && String(tr.value).toLowerCase() === "down") {
      return " After an outage that happens at the <strong>first successful poll</strong>" +
        " — the status reads <code>recovering</code> then, not <code>up</code>." +
        " A full return to <code>up</code> takes " + missedPollsOf(tr) +
        " consecutive success" + (missedPollsOf(tr) === 1 ? "" : "es") + ".";
    }
    var numeric = (tr.type === "asset_metric" || tr.type === "host_metric") && !isBooleanMetric(tr.metric);
    var noBand = !reset || reset.clearThreshold == null || isNaN(reset.clearThreshold);
    if (numeric && noBand && tr.threshold != null && tr.threshold !== "") {
      return " That is the same value that raised it, so a reading hovering on the line can re-alert" +
        " — set a clear threshold below it to add a dead band.";
    }
    return "";
  }

  function resetSentence(reset, tr) {
    var out;
    reset = reset || { mode: "manual" };
    if (reset.mode === "manual") {
      out = "Stays active until <strong>someone clears it manually</strong>.";
    } else if (reset.mode === "timed") {
      out = "Resets automatically after <strong>" + (reset.afterSec ? humanDuration(reset.afterSec) : "…") + "</strong>.";
    } else if (reset.mode === "event") {
      var rev = reset.resetEvent || {};
      out = "Resets when an audit event matching <strong>" + escapeHtml(rev.actionPattern || "…") + "</strong>" +
        (rev.resourceType ? " on <strong>" + escapeHtml(rev.resourceType) + "</strong> resources" : "") +
        " occurs for the same device or resource.";
    } else if (reset.mode === "condition") {
      out = "Resets when <strong>" + escapeHtml(reset.condition ? tgTreePhrase(reset.condition) : "…") + "</strong>";
      if (reset.sustainSec > 0) out += " and stays that way for <strong>" + humanDuration(reset.sustainSec) + "</strong>";
      out += ".";
    } else {
      // "The condition is no longer met" is true but says nothing an operator can
      // check. Spell out the actual recovery clause by rendering the trigger
      // INVERTED through the same phrase builder the trigger sentence uses — one
      // renderer, so the two can't describe the same automation differently.
      var inv = invertedLeaf(tr, reset);
      out = inv
        ? "Resets when <strong>" + escapeHtml(tgLeafPhrase(inv)) + "</strong>"
        // Composite / event / change: there's no single clause to invert (a tree
        // stops being satisfied in as many ways as it has branches).
        : "Resets when <strong>the trigger conditions are no longer met</strong>";
      // "stays there" rather than "stays that way": the clause names a value the
      // reading has to sit at, which is a place, not a manner.
      if (reset.sustainSec > 0) out += " and stays there for <strong>" + humanDuration(reset.sustainSec) + "</strong>";
      out += ".";
      out += resetCaveat(tr, reset);
    }
    return out;
  }

  return {
    findType: findType, isTriggerScoped: isTriggerScoped,
    metricLabel: metricLabel, metricUnit: metricUnit, leafUnit: leafUnit,
    thresholdText: thresholdText, byteUnitFor: byteUnitFor, byteUnitMult: byteUnitMult, bytesIn: bytesIn,
    BYTE_UNITS: BYTE_UNITS, PCT_OF_BYTES: PCT_OF_BYTES, BYTES_OF_PCT: BYTES_OF_PCT,
    isBooleanMetric: isBooleanMetric, stateProbeOf: stateProbeOf, stateMapOf: stateMapOf,
    stateValueLabel: stateValueLabel, stateLeafClause: stateLeafClause,
    monStatusWord: monStatusWord,
    fieldLabel: fieldLabel, changeLabel: changeLabel, humanDuration: humanDuration,
    isDownDetectionLeaf: isDownDetectionLeaf, isDownDetectionTrigger: isDownDetectionTrigger,
    missedPollsOf: missedPollsOf, downDetectionMeta: downDetectionMeta,
    leafDeclaresDownCount: leafDeclaresDownCount,
    dependencyDownMeta: dependencyDownMeta, leafAlertsWhenDependencyDown: leafAlertsWhenDependencyDown,
    tgLeafPhrase: tgLeafPhrase, tgTreePhrase: tgTreePhrase,
    triggerSentence: triggerSentence, severityLadderPhrase: severityLadderPhrase, resetSentence: resetSentence,
    invertedLeaf: invertedLeaf, invertedTree: invertedTree, resetCaveat: resetCaveat,
    triggerFormula: triggerFormula, compactDuration: compactDuration,
    holdPhrase: holdPhrase, holdPhraseCompact: holdPhraseCompact,
    CMP_PHRASE: CMP_PHRASE, INV_CMP: INV_CMP, AGG_PHRASE: AGG_PHRASE, DIM_PHRASE: DIM_PHRASE,
  };
}
if (typeof window !== "undefined") window.PolarisAutomationSentences = { make: makeAutomationSentences };
