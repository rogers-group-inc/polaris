/**
 * public/js/automations-wizard-filters.js — trigger filter rows (compile ↔ lift): a "+ Condition" row that
 * names a device or component identifier, folded into the condition leaves at
 * save (tgFilterCompile) and re-derived on edit (tgFilterLift). Its export
 * block also publishes the dimension helpers (window.PolarisAutomationDimensions)
 * beside window.PolarisTriggerFilters.
 *
 * Part of the automation wizard (CQ-F051): plain browser scripts sharing page
 * globals, loaded right after automations-wizard.js on every page that
 * carries it and in app-panels.js's asset bundle, in WIZARD_FILES order.
 * Pure — no wizard state. See tests/unit/automationsWizardSplit.test.ts.
 */

// ─── Trigger filter rows (compile ↔ lift) ───────────────────────────────────
// A filter row is a "+ Condition" entry that names a device identifier
// (hostname / IP / MAC / manufacturer / model) or a component name (interface
// / IPsec tunnel / storage mount) instead of a metric: `{type: "asset_filter",
// dim, value}` in the UI tree only. The STORED rule never carries them — at
// save, `tgFilterCompile` folds each row into its group's condition leaves as
// `dimensionFilter[dim]` (so the engine, signature, sentences and preview all
// see the shape that already existed), and on edit `tgFilterLift` re-derives
// the rows from a stored tree. Both are pure and exposed for unit tests.

function awIsFilterLeaf(node) { return !!node && node.type === "asset_filter"; }

/** "!= 0.0.0.0" → {operator, ip}; null for anything else. The browser twin of
 *  notificationTypes.parseMemberIpFilter, minus the address validation the
 *  server does on save (business rule 98). */
function awParseMemberIp(raw) {
  var m = /^\s*(==|!=)\s*(\S+)\s*$/.exec(String(raw == null ? "" : raw));
  return m ? { operator: m[1], ip: m[2] } : null;
}

/** The comparison in words, for a sentence: "!= 0.0.0.0" → "is not 0.0.0.0". */
function awMemberIpWords(raw) {
  var p = awParseMemberIp(raw);
  if (!p) return String(raw == null ? "" : raw);
  return (p.operator === "!=" ? "is not " : "is ") + p.ip;
}
function awIsGroup(node) { return !!node && node.type === undefined && Array.isArray(node.children); }

/** Every condition (non-filter) leaf under a node, groups walked depth-first. */
function awConditionLeaves(node) {
  var out = [];
  (function walk(n) {
    if (!n) return;
    if (awIsGroup(n)) { n.children.forEach(walk); return; }
    if (!awIsFilterLeaf(n)) out.push(n);
  })(node);
  return out;
}

/**
 * Fold filter rows into their group's condition leaves. A filter applies to
 * every condition leaf UNDER its group (nested groups included) that supports
 * the dimension, never overwriting a value a deeper row already set — so
 * "AND [hostname X, OR [cpu, mem]]" narrows both branches, and a nested
 * group's own filter wins over an outer one. Filters demand an AND group:
 * under OR, "cpu high OR hostname X" has no honest meaning — the errors say
 * to group the filter with its conditions. Returns {tree, errors}; the tree
 * has no asset_filter leaves left.
 */
function tgFilterCompile(tree, supports, labelOf) {
  var errors = [];
  var label = labelOf || function (d) { return d; };
  (function walk(group) {
    if (!awIsGroup(group)) return;
    var filters = group.children.filter(awIsFilterLeaf);
    group.children = group.children.filter(function (c) { return !awIsFilterLeaf(c); });
    group.children.forEach(walk); // depth-first: nested rows fold before outer ones
    filters.forEach(function (f) {
      var name = label(f.dim);
      if (!String(f.value || "").trim()) {
        errors.push(name + " filter: give it a value.");
        return;
      }
      if ((group.op || "and") !== "and") {
        errors.push(name + " filter: filters only make sense in an AND group — put the filter and the conditions it narrows together in one.");
        return;
      }
      var applied = 0;
      awConditionLeaves(group).forEach(function (leaf) {
        if (!supports(leaf, f.dim)) return;
        leaf.dimensionFilter = leaf.dimensionFilter || {};
        if (!leaf.dimensionFilter[f.dim]) leaf.dimensionFilter[f.dim] = String(f.value).trim();
        applied++;
      });
      if (!applied) {
        errors.push(name + " filter: no condition in its group can take it — add the condition it narrows (or move the filter next to one).");
      }
    });
  })(tree);
  return { tree: tree, errors: errors };
}

/**
 * The inverse, for rendering a stored tree: at each group (top-down), a
 * dimension whose value is IDENTICAL on every supporting condition leaf below
 * lifts out into one filter row (appended after the group's conditions, where
 * the operator would have added it) and is stripped from the leaves; differing
 * values recurse, so a sub-group that is internally uniform still lifts there.
 * Whatever can't be lifted stays on the leaf, where the row renders it inline.
 */
function tgFilterLift(tree, supports, dims) {
  (function walk(group) {
    if (!awIsGroup(group)) return;
    var lifted = [];
    (dims || []).forEach(function (d) {
      var supporting = awConditionLeaves(group).filter(function (l) { return supports(l, d); });
      if (!supporting.length) return;
      var first = (supporting[0].dimensionFilter || {})[d];
      if (!first) return;
      var uniform = supporting.every(function (l) { return ((l.dimensionFilter || {})[d]) === first; });
      // Lifting from an OR group would compile back as an error — leave those inline.
      if (!uniform || (group.op || "and") !== "and") return;
      supporting.forEach(function (l) {
        delete l.dimensionFilter[d];
        if (!Object.keys(l.dimensionFilter).length) delete l.dimensionFilter;
      });
      lifted.push({ type: "asset_filter", dim: d, value: first });
    });
    group.children.forEach(walk);
    lifted.forEach(function (f) { group.children.push(f); });
  })(tree);
  return tree;
}

if (typeof window !== "undefined") {
  window.PolarisAutomationDimensions = {
    optionsHtml: awDimOptionsHtml, suggestHtml: awDimSuggestHtml, matchCue: awDimMatchCue,
    substringMatch: awDimSubstringMatch, ipMatch: awIpDimensionMatch, macMatch: awMacDimensionMatch,
    sdwanMatch: awSdwanDimensionMatch, isMulti: awDimIsMulti, terms: awDimTerms, joinTerms: awDimJoinTerms,
    displayValue: awDimDisplayValue, storedValue: awDimStoredValue, multiState: awDimMultiState, togglePick: awDimTogglePick,
    note: awDimNote, narrow: awDimNarrow,
  };
  window.PolarisTriggerFilters = {
    compile: tgFilterCompile, lift: tgFilterLift,
    parseMemberIp: awParseMemberIp, memberIpWords: awMemberIpWords,
  };
}
