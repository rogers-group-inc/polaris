/**
 * public/js/automations-wizard-dimensions.js — the dimension-value picker (aw*Dim* helpers): options,
 * suggestions, the match cue and note for a metric's dimensionFilter, and the
 * browser mirrors of the server's dimension matchers. Published as
 * window.PolarisAutomationDimensions by automations-wizard-filters.js's export
 * block, which loads after this file.
 *
 * Part of the automation wizard (CQ-F051): plain browser scripts sharing page
 * globals, loaded right after automations-wizard.js on every page that
 * carries it and in app-panels.js's asset bundle, in WIZARD_FILES order.
 * Pure — no wizard state. See tests/unit/automationsWizardSplit.test.ts.
 */

// ─── Dimension-value picker (pure rendering; see POST /automations/dimension-values) ───
// A metric's dimensionFilter used to be free text, so an operator typed a sensor
// class into a field the server validates as a closed enum (400 on save) or a
// pattern field that silently matches nothing. These three build the control's
// options and the operator-facing note from the endpoint's answer — kept
// module-level and pure so they're unit-testable off window.PolarisAutomationDimensions.

/** Options for a strict (closed-enum) dimension select. A `current` value the
 *  scoped devices don't report is KEPT and flagged rather than dropped —
 *  otherwise opening an existing automation for an unrelated edit would quietly
 *  widen its filter to "any". */
function awDimOptionsHtml(res, current) {
  var cur = current == null ? "" : String(current);
  var vals = (res && res.values) || [];
  var html = '<option value="">(any)</option>';
  var seen = false;
  vals.forEach(function (v) {
    if (v.value === cur) seen = true;
    var count = v.assetCount ? " (" + v.assetCount + ")" : "";
    // `label` is present when the stored value isn't human-readable (a state
    // probe's registry UUID): show the name, keep storing the id.
    html += '<option value="' + escapeHtml(v.value) + '"' + (v.value === cur ? " selected" : "") + '>' + escapeHtml(v.label || v.value) + count + '</option>';
  });
  if (cur && !seen) {
    html += '<option value="' + escapeHtml(cur) + '" selected>' + escapeHtml(cur) + ' — not currently reported</option>';
  }
  return html;
}

/** Case-insensitive substring test — a byte-for-byte mirror of the server's
 *  `dimensionSubstringMatch`, which is what actually selects readings. The
 *  suggestion list and the match cue below both hang off it, so a value the cue
 *  calls a match is one the engine will match too. */
function awDimSubstringMatch(value, query) {
  if (!query) return true;
  return String(value == null ? "" : value).toLowerCase().indexOf(String(query).toLowerCase()) !== -1;
}

/** Mirror of the server's `ipDimensionMatch` (notificationTypes) — substring
 *  over dotted quads lies ("10.1.1.5" is inside "110.1.1.55"), so an IP
 *  pattern is a CIDR ("/" present, containment), a trailing-dot prefix, or an
 *  exact address / octet-boundary prefix. Keep in lockstep with the server —
 *  the cue and the suggestion filter select with this, and a divergence makes
 *  the cue lie about whether the filter will fire. */
function awIpDimensionMatch(ip, pattern) {
  if (!pattern) return true;
  var value = String(ip == null ? "" : ip).trim();
  if (!value) return false;
  var p = String(pattern).trim();
  if (!p) return true;
  if (p.indexOf("/") !== -1) {
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(p);
    var v = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
    if (!m || !v) return false;
    var bits = Number(m[5]);
    if (bits > 32) return false;
    var toNum = function (o) { return ((Number(o[1]) << 24) | (Number(o[2]) << 16) | (Number(o[3]) << 8) | Number(o[4])) >>> 0; };
    if ([m, v].some(function (o) { return [o[1], o[2], o[3], o[4]].some(function (x) { return Number(x) > 255; }); })) return false;
    var mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (toNum(v) & mask) === (toNum(m) & mask);
  }
  if (p.charAt(p.length - 1) === ".") return value.indexOf(p) === 0;
  return value === p || value.indexOf(p + ".") === 0;
}

/** Mirror of the server's `macDimensionMatch` — separator-insensitive
 *  substring, so "aa-bb-cc", "aabb.cc" and "AA:BB:CC" select the same
 *  devices. Keep in lockstep with the server. */
function awMacDimensionMatch(mac, pattern) {
  if (!pattern) return true;
  var strip = function (v) { return String(v == null ? "" : v).toLowerCase().replace(/[^0-9a-f]/g, ""); };
  var needle = strip(pattern);
  if (!needle) return true;
  return strip(mac).indexOf(needle) !== -1;
}

/** The SD-WAN pair takes SEVERAL values — "these two health checks", "wan1 and
 *  wan2" — stored joined by "|" (FortiOS object names admit no "|"), any-of,
 *  each term a substring. Mirror of the server's utils/sdwanDimensions; keep
 *  the two in lockstep. A plain function test rather than a lookup table so the
 *  sentence factory above can call it before this part of the file has run.
 *  The interface filter takes the same list shape ("ATT EPLS | port25"); its
 *  server matcher is notificationTypes.interfacePatternMatch, which also reads
 *  each interface's description — the picker offers descriptions as values, so
 *  the any-of match below over those values agrees with it. */
function awDimIsMulti(dim) { return dim === "healthCheck" || dim === "link" || dim === "ifNamePattern" || dim === "ifTag"; }

/** The "|"-separated terms of a multi value — trimmed, blanks dropped. */
function awDimTerms(value) {
  return String(value == null ? "" : value).split("|").map(function (t) { return t.trim(); }).filter(Boolean);
}

/** Canonical stored form: de-duplicated case-insensitively (first spelling
 *  kept), joined by "|" with no padding. */
function awDimJoinTerms(terms) {
  var seen = {};
  var out = [];
  (terms || []).forEach(function (t) {
    var v = String(t == null ? "" : t).trim();
    if (!v || seen[v.toLowerCase()]) return;
    seen[v.toLowerCase()] = true;
    out.push(v);
  });
  return out.join("|");
}

/** What the input shows for a stored value — the terms spaced out, so the
 *  list reads as a list. Single-value dims are shown as stored. */
function awDimDisplayValue(dim, stored) {
  return awDimIsMulti(dim) ? awDimTerms(stored).join(" | ") : String(stored == null ? "" : stored);
}

/** What a dim control's text is stored as — canonical for a multi dim. */
function awDimStoredValue(dim, text) {
  return awDimIsMulti(dim) ? awDimJoinTerms(awDimTerms(text)) : String(text == null ? "" : text).trim();
}

/** Mirror of the server's `sdwanDimensionMatch`: any term a case-insensitive
 *  substring. No terms = match. */
function awSdwanDimensionMatch(value, pattern) {
  var terms = awDimTerms(pattern);
  if (!terms.length) return true;
  return terms.some(function (t) { return awDimSubstringMatch(value, t); });
}

/**
 * A multi dim's text split into what is PICKED and what is still being TYPED.
 * Every term before the last "|" is picked. The last term is the fragment
 * being typed — unless the text ends with "|", or the last term is exactly a
 * reported value (it was clicked, or typed out in full), in which case it is
 * picked too and the fragment is empty. The fragment is what the suggestion
 * list filters by, so after a pick the whole list is back on offer.
 */
function awDimMultiState(res, text) {
  var raw = String(text == null ? "" : text);
  var terms = awDimTerms(raw);
  var reported = {};
  ((res && res.values) || []).forEach(function (v) { reported[String(v.value).toLowerCase()] = true; });
  var fragment = "";
  if (terms.length && !/\|\s*$/.test(raw) && !reported[terms[terms.length - 1].toLowerCase()]) fragment = terms.pop();
  return { picked: terms, fragment: fragment };
}

/** Clicking a suggestion on a multi dim: toggle it. Already picked → removed;
 *  otherwise added in place of whatever fragment was being typed. Returns the
 *  new display text. */
function awDimTogglePick(res, text, value) {
  var st = awDimMultiState(res, text);
  var lc = String(value).toLowerCase();
  var had = st.picked.some(function (t) { return t.toLowerCase() === lc; });
  var next = had ? st.picked.filter(function (t) { return t.toLowerCase() !== lc; }) : st.picked.concat([value]);
  return awDimTerms(awDimJoinTerms(next)).join(" | ");
}

/** Which matcher selects readings for a dimension — the two identity dims with
 *  value shapes substring can't honestly serve get their own, the SD-WAN pair
 *  is any-of; everything else is the shared substring the engine uses. */
function awDimMatcher(dim) {
  if (dim === "ipPattern") return awIpDimensionMatch;
  if (dim === "macPattern") return awMacDimensionMatch;
  if (dim === "ifTag") return awInterfaceTagMatch;
  if (awDimIsMulti(dim)) return awSdwanDimensionMatch;
  return awDimSubstringMatch;
}

/** Mirror of the server's `interfaceTagMatch` (business rule 133(g)): any term
 *  equal to the tag, case-insensitively — a tag is a whole name, never a
 *  substring. No terms = match. */
function awInterfaceTagMatch(value, pattern) {
  var terms = awDimTerms(pattern);
  if (!terms.length) return true;
  var v = String(value == null ? "" : value).toLowerCase();
  return terms.some(function (t) { return t.toLowerCase() === v; });
}

/** Values a typed pattern selects out of what the scoped devices report. */
function awDimHits(res, query, dim) {
  var match = awDimMatcher(dim);
  return ((res && res.values) || []).filter(function (v) { return match(v.value, query); });
}

var AW_DIM_SUGGEST_CAP = 60;

/** Suggestion rows for a substring-matched dimension (sensor name, interface,
 *  mount path …), filtered by what's typed so far. This is a real combobox, not
 *  a `<datalist>`: the native control opens inconsistently on click, matches by
 *  prefix in some browsers, and — the reason it was replaced — gave an operator
 *  no way to tell a real sensor name from a typo, since a pattern dimension
 *  accepts free text by design. Item markup matches `.aw-suggest-item` so the
 *  Devices-step CSS and keyboard handling carry over. */
function awDimSuggestHtml(res, query, dim) {
  if (!res || res.loading) return '<div class="aw-suggest-empty">Checking what the selected devices report…</div>';
  if (res.error) return '<div class="aw-suggest-empty">Couldn’t load the reported values — typing a pattern still works.</div>';
  var noun = res.noun || "values";
  if (!(res.values || []).length) {
    return '<div class="aw-suggest-empty">The selected devices report no ' + escapeHtml(noun + (res.narrowLabel || "")) + '.</div>';
  }
  var q = String(query == null ? "" : query).trim();
  if (awDimIsMulti(dim)) return awDimMultiSuggestHtml(res, query, noun);
  var hits = awDimHits(res, q, dim);
  if (!hits.length) {
    return '<div class="aw-suggest-empty">None of the ' + res.values.length + ' reported ' + escapeHtml(noun) +
      ' contain “' + escapeHtml(q) + '”.</div>';
  }
  var html = hits.slice(0, AW_DIM_SUGGEST_CAP).map(function (v) {
    var count = v.assetCount ? ' <span style="color:var(--color-text-tertiary)">(' + v.assetCount + ')</span>' : "";
    return '<div class="aw-suggest-item" data-val="' + escapeHtml(v.value) + '" title="' + escapeHtml(v.value) + '">' +
      escapeHtml(v.value) + count + '</div>';
  }).join("");
  if (hits.length > AW_DIM_SUGGEST_CAP) {
    html += '<div class="aw-suggest-empty">+' + (hits.length - AW_DIM_SUGGEST_CAP) + ' more — keep typing to narrow.</div>';
  }
  return html;
}

/** The pick-several list for a multi dim: every reported value (filtered by
 *  the fragment being typed), each ticked when it is picked, clicking one
 *  toggles it and the list stays open for the next. */
function awDimMultiSuggestHtml(res, text, noun) {
  var st = awDimMultiState(res, text);
  var picked = {};
  st.picked.forEach(function (t) { picked[t.toLowerCase()] = true; });
  var hits = res.values.filter(function (v) { return awDimSubstringMatch(v.value, st.fragment); });
  if (!hits.length) {
    return '<div class="aw-suggest-empty">None of the ' + res.values.length + ' reported ' + escapeHtml(noun) +
      ' contain “' + escapeHtml(st.fragment) + '”.</div>';
  }
  var html = '<div class="aw-suggest-empty">Click to add or remove — pick as many as you need.</div>';
  html += hits.slice(0, AW_DIM_SUGGEST_CAP).map(function (v) {
    var on = !!picked[String(v.value).toLowerCase()];
    var count = v.assetCount ? ' <span style="color:var(--color-text-tertiary)">(' + v.assetCount + ')</span>' : "";
    return '<div class="aw-suggest-item' + (on ? ' aw-suggest-picked' : '') + '" data-val="' + escapeHtml(v.value) + '" title="' + escapeHtml(v.value) + '"' +
      ' aria-selected="' + (on ? "true" : "false") + '">' +
      '<span style="display:inline-block;width:1.1em">' + (on ? "✓" : "") + '</span>' + escapeHtml(v.value) + count + '</div>';
  }).join("");
  if (hits.length > AW_DIM_SUGGEST_CAP) {
    html += '<div class="aw-suggest-empty">+' + (hits.length - AW_DIM_SUGGEST_CAP) + ' more — keep typing to narrow.</div>';
  }
  return html;
}

/** The cue beside the input: does what's typed actually select anything the
 *  scoped devices report? A pattern dimension can't be validated closed (a
 *  partial like "CPU" is a legitimate filter over several sensors), so the
 *  answer is shown rather than enforced — including the case that matters, a
 *  typo that quietly matches nothing and would never fire. */
function awDimMatchCue(res, value, dim) {
  var q = String(value == null ? "" : value).trim();
  if (!q || !res || res.loading || res.error || !(res.values || []).length) return { text: "", warn: false };
  var noun = res.noun || "values";
  var hits = awDimHits(res, q, dim);
  if (!hits.length) {
    return { text: "✕ matches none of the " + res.values.length + " reported " + noun + " — this condition would never fire", warn: true };
  }
  // Any-of: the list as a whole can match while one entry in it is a typo
  // that selects nothing. Name it — the condition still fires, on the rest.
  if (awDimIsMulti(dim)) {
    var dead = awDimTerms(q).filter(function (t) { return !awDimHits(res, t, dim).length; });
    if (dead.length) {
      return { text: "✕ “" + dead.join("”, “") + "” matches none of the reported " + noun + " — the rest still apply", warn: true };
    }
  }
  if (hits.length === 1 && hits[0].value.toLowerCase() === q.toLowerCase()) {
    return { text: "✓ exact match", warn: false };
  }
  return { text: "✓ matches " + hits.length + " of " + res.values.length + " reported " + noun, warn: false };
}

/** Sibling dimension values that narrow another dimension's list on the same
 *  condition row: sensor NAMES belong to the chosen class, WAN members to the
 *  chosen health-check. Offering the unnarrowed list would let an operator build
 *  a filter (class=temperature + name=FAN1) that matches nothing. */
function awDimNarrow(dim, df, state) {
  df = df || {};
  if (dim === "sensorNamePattern") return df.sensorClass ? { sensorClass: df.sensorClass } : {};
  if (dim === "link") return df.healthCheck ? { healthCheck: df.healthCheck } : {};
  // A state probe's rows belong to that probe — "PSU 2" is not a row of the
  // fan-tray probe, so offering every probe's rows would invite a combination
  // that matches nothing.
  if (dim === "stateRowPattern") return df.stateProbeId ? { stateProbeId: df.stateProbeId } : {};
  // The interface list is the one that depends on the row's COMPARISON and not
  // only on its siblings: `poeStatus == fault` alerts on every PoE port while
  // every other PoE comparison stays pinned-only, so the two need different
  // lists. `state` is supplied only for a poeStatus row (awDimStateOfRow), so
  // no other picker's cache key moves when an operator edits a value.
  if (dim === "ifNamePattern" && state && state.stateOperator) return { stateOperator: state.stateOperator, stateValue: state.stateValue || "" };
  return {};
}

/** The note under the control. Returns `{text, warn}`; warn = the condition as
 *  written can never match, which is the whole point of asking the devices. */
function awDimNote(res) {
  if (!res || res.loading) return { text: "Checking what the selected devices report…", warn: false };
  if (res.error) return { text: "", warn: false };
  // The Polaris server can supply values with no device in scope (a Path
  // Monitor check picker), so an empty scope only warns when nothing came back.
  if (!res.scopedAssets && !(res.values || []).length) {
    return { text: "No devices match the filter on the Devices step yet, so there is nothing to list.", warn: true };
  }
  if (!(res.values || []).length) {
    return {
      // narrowLabel keeps "reported no hardware sensors" from reading as "none at
      // all" when it actually means "none of the class you picked".
      text: "None of the " + res.scopedAssets + " selected device(s) reported any " + res.noun + (res.narrowLabel || "") +
        " in the last " + res.windowHours + " h — a condition on this dimension would never match.",
      warn: true,
    };
  }
  var parts = [];
  if (res.assetsWithData < res.sampledAssets) {
    parts.push("Reported by " + res.assetsWithData + " of " + res.sampledAssets + " device(s) — the rest report no " + res.noun + ".");
  }
  if (res.sampledAssets < res.scopedAssets) {
    parts.push("Sampled " + res.sampledAssets + " of " + res.scopedAssets + " selected devices.");
  }
  return { text: parts.join(" "), warn: false };
}
