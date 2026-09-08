/**
 * public/js/automations-wizard.js — the 6-step automation builder.
 *
 * openAutomationWizard(existing) replaces the old single-form rule builder:
 *   Step 1  Name & description (+ severity + enabled)
 *   Step 2  Asset filtering — "All assets" checkbox (default) or a nested
 *           AND/OR condition builder with drag-and-drop; live device preview
 *   Step 3  Trigger conditions — device/host triggers use the same AND/OR
 *           tree builder (1 condition saves as the legacy single trigger,
 *           2+ as a per-asset composite); event/change keep flat fields;
 *           live plain-English sentence + current-value test with per-leaf
 *           breakdown
 *   Step 4  Reset conditions — default-checked "trigger no longer true"
 *           (auto, with hysteresis/sustain extras); unchecked reveals
 *           timed / manual (+ a custom AND/OR reset-condition tree for
 *           composite triggers → reset mode "condition")
 *   Step 5  Automations (actions: notify / api_call / script) + escalation
 *           tiers of actions
 *   Step 6  Summary — review grid + the list of devices the automation
 *           affects (live scope preview)
 *
 * Mechanics: shared stepper CSS from styles.css (see polaris-ui-canon → "Wizard
 * (stepper modal)"); free navigation to visited steps (all steps unlocked in
 * edit mode); one module-scope draft (`_aw`, rule-shape v2) collected on every
 * navigation, hard-validated only on Next/Save.
 *
 * STANDALONE: this file owns the builder catalogs below and lazily fetches
 * every one of them, so a page can load it WITHOUT automations.js and still
 * open the edit modal — which is exactly what the asset-details Alerts tab
 * does. automations.js reads the same caches (always from inside a handler, so
 * script order doesn't matter) and the post-save list refresh goes through an
 * optional `window._reloadRules` hook rather than a hard dependency.
 */

var _awScripts = null;      // AutomationScript registry (null = not loadable — no automationScripts read)
var _awDraftStash = null;   // in-memory draft stash (never persisted — may contain addresses)

// Builder catalogs, cached for the page's lifetime and shared with
// automations.js (which uses _ruleSchema for its list labels + scope tooltip).
var _ruleSchema = null;
var _ruleTagList = null;  // cached distinct asset tags for the scope picker
var _ruleAssetTypes = null; // cached asset-type registry (finite set) for the scope picker
var _ruleChannels = null; // cached configured delivery channels (rule-builder picker)
var _ruleRecipientUsers = null; // cached users for the recipient picker
// Role id → name, lifted off the scope-options payload on every wizard open.
// Module scope because the list page's Addresses column needs the same map to
// name a recipientRoles pill, and scopeOptions is the only endpoint that
// publishes roles without the users:read key.
var _ruleScopeRoles = null;

// A tag value that looks like a machine identifier — an Entra/Intune GUID
// (8-4-4-4-12 hex, possibly with a prefix like "prev-entra:<guid>") or a long
// bare hex object id. Filtered out of the rule-builder tag pickers (scope +
// recipient tags) so device IDs don't flood them. Human tags
// (region:Atlanta, firewall:fgt-1, prod) never match.
function _looksLikeDeviceId(tag) {
  if (!tag) return false;
  var t = String(tag);
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(t)) return true; // GUID anywhere in the value
  if (/^[0-9a-f]{24,}$/i.test(t)) return true; // long bare hex object id
  return false;
}

// ─── Recipient pill ⇄ payload (pure; exported for tests) ───
// The Notify action's To/Cc/Bcc token fields store a pill as
// {kind:"user"|"address", value, label}; the wire shape splits that into
// recipientUserIds + addresses. Both halves live at module scope, closed over
// nothing, so tests/unit/automationRecipientPills.test.ts can pull them off
// window.PolarisAutomationRecipients (the PolarisAutomationSentences idiom).

/**
 * The two DYNAMIC recipient kinds: they name no address or account, they name a
 * RULE for finding one at fire time from the triggering asset. They were
 * checkboxes sitting under the recipient fields, which put "who gets this" in
 * two places at once; as pills they read in the same list as everyone else.
 * Their `value` is a constant — one of each is meaningful, so the pill's
 * identity IS its kind.
 */
var DYNAMIC_PILL_KINDS = { deviceRegion: "recipientDeviceRegion", assetContacts: "recipientAssetContacts" };

/**
 * The level-scoped device-region pill. Unlike the two above, its VALUE carries
 * information (the asset-relative level as a string), so several can coexist
 * and it can't be a flag keyed by kind alone.
 */
var DYNAMIC_LEVEL_KIND = "deviceRegionLevel";

/** Is this pill one of the dynamic "resolve from the triggering device" kinds? */
function isDynamicKind(kind) {
  return !!DYNAMIC_PILL_KINDS[kind] || kind === DYNAMIC_LEVEL_KIND;
}

/**
 * Fold a typed fragment and a label to one comparable form. The entries are
 * written with a typographic apostrophe and nobody types one, so "asset's"
 * — the obvious thing to type — matched nothing at all.
 */
function recipNeedle(s) {
  return String(s || "").toLowerCase().replace(/[’']/g, "");
}

/** Pills → the payload halves. Order preserved, duplicates dropped. */
function pillsToRecipients(pills) {
  var userIds = [], addresses = [], roles = [], regions = [], tags = [], levels = [];
  var out = {};
  (pills || []).forEach(function (p) {
    if (!p || !p.value) return;
    // Checked BEFORE the flag kinds: this one is keyed by value, not by kind.
    if (p.kind === DYNAMIC_LEVEL_KIND) {
      var lv = Number(p.value);
      if (Number.isInteger(lv) && lv >= 1 && levels.indexOf(lv) === -1) levels.push(lv);
      return;
    }
    if (DYNAMIC_PILL_KINDS[p.kind]) { out[DYNAMIC_PILL_KINDS[p.kind]] = true; return; }
    if (p.kind === "user") { if (userIds.indexOf(p.value) === -1) userIds.push(p.value); }
    else if (p.kind === "role") { if (roles.indexOf(p.value) === -1) roles.push(p.value); }
    else if (p.kind === "region") { if (regions.indexOf(p.value) === -1) regions.push(p.value); }
    // Registry tags are their OWN kind, not folded in with regions: a region
    // matches User.regionTags only (resolveUsersByRegions), while a tag matches
    // the flattened region-plus-other scope (resolveRecipientUsers). Same-named
    // rows would otherwise reach different people depending on which list the
    // operator happened to pick from.
    else if (p.kind === "tag") { if (tags.indexOf(p.value) === -1) tags.push(p.value); }
    else {
      var a = String(p.value).trim().toLowerCase();
      if (a && addresses.indexOf(a) === -1) addresses.push(a);
    }
  });
  if (userIds.length) out.recipientUserIds = userIds;
  if (addresses.length) out.addresses = addresses;
  if (roles.length) out.recipientRoles = roles;
  if (regions.length) out.recipientRegions = regions;
  if (tags.length) out.recipientTags = tags;
  if (levels.length) out.recipientDeviceRegionLevels = levels.slice().sort(function (a, b) { return a - b; });
  return out;
}

/** The payload halves → pills. A user id with no matching account is KEPT as an
 *  "unknown" pill rather than silently dropped on the next save — losing a
 *  recipient because their account was renamed is worse than showing a stub. */
function recipientsToPills(rec, users, roles, maxLevel) {
  var byId = {};
  (users || []).forEach(function (u) { byId[u.id] = u; });
  var roleById = {};
  (roles || []).forEach(function (r) { roleById[r.id] = r; });
  var out = [];
  // Dynamic entries first: they're the broadest thing in the list, and reading
  // "everyone in the device's region, plus Jane" in that order matches how an
  // operator describes it.
  if (rec && rec.recipientDeviceRegion) {
    out.push({ kind: "deviceRegion", value: "1", label: "Asset’s Region Users" });
  }
  if (rec && rec.recipientAssetContacts) {
    out.push({ kind: "assetContacts", value: "1", label: "Asset’s Responsible Contacts" });
  }
  // A stored level that no longer exists (someone removed the containing
  // polygon) is KEPT as an unknown pill, never dropped — the same contract as
  // an unknown user or role, and for the same reason: losing a recipient
  // silently is worse than showing a stub the operator can remove.
  ((rec && rec.recipientDeviceRegionLevels) || []).forEach(function (n) {
    var top = typeof maxLevel === "number" ? maxLevel : 0;
    out.push({
      kind: DYNAMIC_LEVEL_KIND,
      value: String(n),
      label: "Asset’s L" + n + " Region Users",
      unknown: top > 0 && n > top,
    });
  });
  ((rec && rec.recipientRegions) || []).forEach(function (name) {
    out.push({ kind: "region", value: name, label: name });
  });
  // Tag routing predates the picker offering it (the field was carried for
  // back-compat and nothing emitted it); it is now the Tags list's own output,
  // so a stored value has to round-trip as a pill or the next save drops it.
  ((rec && rec.recipientTags) || []).forEach(function (name) {
    out.push({ kind: "tag", value: name, label: name });
  });
  ((rec && rec.recipientRoles) || []).forEach(function (id) {
    // Roles are stored by ID, so a renamed role keeps routing; a DELETED one
    // survives as an unknown pill rather than vanishing on the next save.
    var r = roleById[id];
    out.push({ kind: "role", value: id, label: r ? r.name : "(unknown role)", unknown: !r });
  });
  ((rec && rec.recipientUserIds) || []).forEach(function (id) {
    var u = byId[id];
    out.push({ kind: "user", value: id, label: u ? (u.displayName || u.username) : "(unknown user)", unknown: !u });
  });
  ((rec && rec.addresses) || []).forEach(function (a) {
    out.push({ kind: "address", value: a, label: a });
  });
  return out;
}

// ─── Recipient roll-up: WHO an automation notifies, and from where ─────────
//
// Backs the list's Addresses column. Lives here rather than in automations.js
// for the same reason recipientsToPills does: this file owns the recipient
// vocabulary, and a second walk in the list would be free to disagree with the
// editor about who a rule reaches.
//
// The walk order MUST match the server's allRuleActionRefs (actions + their
// tiers, rule tiers, band actions + their tiers, band tiers, resolved actions,
// reset actions) — a location missed here reads in the UI as "nobody is
// notified", which is the failure mode this column exists to prevent.

/** Channel types that route to RECIPIENTS. Mirrors RECIPIENT_ROUTED_TYPES in
 *  notificationTypes.ts — the rest post to the channel's own fixed destination
 *  (webhook URL / Pushbullet token), where the action's recipient fields are
 *  ignored, so listing them would name people who never get the message. */
var RECIPIENT_ROUTED_CHANNEL_TYPES = { smtp: true, oauth_m365: true, web_push: true };

/**
 * Legacy email-tier escalation → v2 tiers-of-actions, exactly as the server's
 * normalizeEscalationToV2 does it (tier overrides become the notify action's
 * emailComposition). `withV2` on the read path fills reset/actions but NOT
 * escalation, so any consumer of a stored rule's chain has to do this itself.
 */
function normalizeEscalationV2(esc) {
  if (!esc || !Array.isArray(esc.tiers) || !esc.tiers.length) return esc || null;
  if (esc.tiers[0].actions !== undefined) return esc; // already v2
  return {
    stopOn: esc.stopOn || "acknowledge",
    tiers: esc.tiers.map(function (t) {
      var hasComp = t.subjectTemplate != null || t.bodyTextTemplate != null || t.bodyHtmlTemplate != null || t.cc != null || t.bcc != null;
      var action = { type: "notify", channelId: t.channelId };
      if (t.to && t.to.recipientUserIds && t.to.recipientUserIds.length) action.recipientUserIds = t.to.recipientUserIds;
      if (t.to && t.to.addresses && t.to.addresses.length) action.addresses = t.to.addresses;
      if (t.to && t.to.recipientRoles && t.to.recipientRoles.length) action.recipientRoles = t.to.recipientRoles;
      if (t.to && t.to.recipientRegions && t.to.recipientRegions.length) action.recipientRegions = t.to.recipientRegions;
      if (hasComp) {
        action.emailComposition = {};
        if (t.subjectTemplate != null) action.emailComposition.subjectTemplate = t.subjectTemplate;
        if (t.bodyTextTemplate != null) action.emailComposition.bodyTextTemplate = t.bodyTextTemplate;
        if (t.bodyHtmlTemplate != null) action.emailComposition.bodyHtmlTemplate = t.bodyHtmlTemplate;
        if (t.cc != null) action.emailComposition.cc = t.cc;
        if (t.bcc != null) action.emailComposition.bcc = t.bcc;
      }
      var tier = { afterMin: t.afterMin, actions: [action] };
      if (t.repeatEveryMin != null) tier.repeatEveryMin = t.repeatEveryMin;
      if (t.maxRepeats != null) tier.maxRepeats = t.maxRepeats;
      return tier;
    }),
  };
}

/**
 * One recipient block (a To / Cc / Bcc list) → display strings.
 *
 * Goes through recipientsToPills so the unknown-user / unknown-role policy is
 * the editor's, then relabels: this column answers "what ADDRESS receives
 * this", so a Polaris account shows its email and falls back to the account
 * name only when it has none. The three broadcast flags and the legacy tag
 * routing have no pill kind (pillsToRecipients never emits them) and are
 * prepended by hand.
 */
function recipientDisplayLabels(rec, catalogs) {
  var out = [];
  if (!rec) return out;
  var cat = catalogs || {};
  var users = cat.users || [];
  if (rec.recipientAllUsers) out.push("All users");
  if (rec.recipientAllRegions) out.push("All region users");
  recipientsToPills(rec, users, cat.roles || [], 0).forEach(function (p) {
    if (p.kind === "user") {
      var u = null;
      for (var i = 0; i < users.length; i++) if (users[i].id === p.value) { u = users[i]; break; }
      out.push((u && u.email) || p.label);
    } else if (p.kind === "role") {
      out.push("Role: " + p.label);
    } else if (p.kind === "region") {
      out.push("Region: " + p.label);
    } else if (p.kind === "tag") {
      out.push("Tag: " + p.label);
    } else {
      out.push(p.label);
    }
  });
  return out;
}

/**
 * Every notify action on a rule, grouped by WHERE it is declared, with the
 * addresses each reaches.
 *
 * `catalogs` = { users, roles, channels } — the same three the wizard caches.
 * All three are optional: a missing users list degrades a recipient to
 * "(unknown user)" rather than dropping it, and a missing channel catalogue
 * costs the channel name and the fixed-destination test, never a group.
 *
 * Returns [{ where, channel, channelType, fixedDestination, to, cc, bcc }].
 */
function ruleRecipientGroups(rule, catalogs) {
  var cat = catalogs || {};
  var channels = cat.channels || [];
  var groups = [];
  var chanById = function (id) {
    for (var i = 0; i < channels.length; i++) if (channels[i].id === id) return channels[i];
    return null;
  };
  // Non-escalation notify actions inherit the rule's emailComposition
  // wholesale when they carry none (composeForNotify: `actionComp ?? rule`);
  // an escalation tier merges the TEMPLATE fields but takes cc/bcc from the
  // action alone, so a tier never inherits the rule's Cc list.
  var addNotify = function (action, where, inTier) {
    if (!action || action.type !== "notify") return;
    var comp = action.emailComposition || (inTier ? null : rule.emailComposition) || null;
    // ONE GROUP PER CHANNEL. A notify action may deliver through several, and
    // each is a different destination with its own type \u2014 a chat channel
    // shows no recipients, an email one shows To/Cc/Bcc \u2014 so collapsing
    // them into a single row would have to pick one channel's story and tell
    // it about all of them.
    var ids = (action.channelIds && action.channelIds.length)
      ? action.channelIds
      : (action.channelId ? [action.channelId] : []);
    (ids.length ? ids : [null]).forEach(function (id) {
      var ch = id ? chanById(id) : null;
      var fixed = !!ch && !RECIPIENT_ROUTED_CHANNEL_TYPES[ch.type];
      groups.push({
        where: where,
        channel: ch ? ch.name : null,
        channelType: ch ? ch.type : null,
        fixedDestination: fixed,
        to: fixed ? [] : recipientDisplayLabels(action, cat),
        cc: fixed ? [] : recipientDisplayLabels(comp && comp.cc, cat),
        bcc: fixed ? [] : recipientDisplayLabels(comp && comp.bcc, cat),
      });
    });
  };
  // `prefix` names WHICH chain — a per-action chain chases that one action, the
  // rule/band-level chain chases the alert. Both can exist at once and used to
  // render as the same "escalation tier 1" line.
  var addTiers = function (esc, prefix) {
    var v2 = normalizeEscalationV2(esc);
    ((v2 && v2.tiers) || []).forEach(function (t, i) {
      var label = prefix + " tier " + (i + 1) +
        (t.afterMin != null ? " (after " + t.afterMin + "m)" : "");
      (t.actions || []).forEach(function (a) { addNotify(a, label, true); });
    });
  };
  // Action-then-its-tiers, interleaved, exactly as allRuleActionRefs walks it.
  (rule.actions || []).forEach(function (a, i) {
    addNotify(a, "When it fires", false);
    addTiers(a && a.escalation, "Action " + (i + 1) + " escalation");
  });
  addTiers(rule.escalation, "Escalation");
  (rule.severityBands || []).forEach(function (b) {
    var head = "At " + String((b && b.severity) || "band") + " severity";
    (b.actions || []).forEach(function (a, i) {
      addNotify(a, head, false);
      addTiers(a && a.escalation, head + ", action " + (i + 1) + " escalation");
    });
    addTiers(b && b.escalation, head + " escalation");
  });
  // Only "dedicated" resolved actions are their own list — "reuse" re-runs the
  // last-fired band's actions, which are already grouped above.
  if (rule.bandNotify && rule.bandNotify.resolvedMode === "dedicated") {
    (rule.bandNotify.resolvedActions || []).forEach(function (a) { addNotify(a, "When it eases to normal", false); });
  }
  (rule.resetActions || []).forEach(function (a) { addNotify(a, "When it clears", false); });
  return groups;
}

if (typeof window !== "undefined") {
  window.PolarisAutomationRecipients = {
    pillsToRecipients: pillsToRecipients,
    recipientsToPills: recipientsToPills,
    recipientDisplayLabels: recipientDisplayLabels,
    ruleRecipientGroups: ruleRecipientGroups,
    normalizeEscalationV2: normalizeEscalationV2,
  };
}

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
      if (df[k]) out += " " + (DIM_PHRASE[k] || k + " = {value}").replace("{value}", df[k]);
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
    hostnamePattern: "on devices whose hostname matches {value}",
    ipPattern: "on devices whose IP matches {value}",
    macPattern: "on devices whose MAC matches {value}",
    manufacturerPattern: "on devices whose manufacturer matches {value}",
    modelPattern: "on devices whose model matches {value}",
    mountPathPattern: "on mounts matching {value}", sdwanRulePattern: "on SD-WAN rules matching {value}",
    healthCheck: "for health check {value}",
    link: "on member {value}", tunnelName: "on tunnel {value}", widgetId: "for widget {value}",
    processNamePattern: "for processes matching {value}",
    // Mirrors the server's dimensionPhrases. Present as built-in fallbacks too so
    // the factory reads correctly against a partial /schema payload, the same as
    // every other dimension above.
    stateProbeId: "for probe {value}", stateRowPattern: "on rows matching {value}",
  }, s.dimensionPhrases || {});

  // Windowed-ratio metrics: the window is the measurement, mirrored from the
  // server's `windowedRatioMetrics` with the same built-in fallback the other
  // catalogs use so the factory reads correctly against a partial payload.
  var RATIO_WINDOW_DEFAULT_SEC = 900;
  function isWindowedRatio(m) {
    return (s.windowedRatioMetrics || ["probeLossPct"]).indexOf(m) !== -1;
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
      return (DIM_PHRASE[leaf.dim] || leaf.dim + " = {value}").replace("{value}", String(leaf.value || "…"));
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
          if (dDf[k]) dOut += " " + (DIM_PHRASE[k] || k + " = {value}").replace("{value}", dDf[k]);
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
        if (sDf[k]) sOut += " " + (DIM_PHRASE[k] || k + " = {value}").replace("{value}", sDf[k]);
      });
      return sOut;
    }
    if (isBooleanMetric(leaf.metric)) return stateLeafClause(leaf);
    var unit = leafUnit(leaf.metric, leaf.dimensionFilter); unit = unit ? " " + unit : "";
    // A windowed ratio IS its window, so it says so plainly instead of borrowing
    // an aggregation phrase it doesn't have ("avg over 15 minutes" would be a
    // second average on top of a percentage).
    var agg = isWindowedRatio(leaf.metric)
      ? " (over the last " + (humanDuration(leaf.windowSec) || humanDuration(RATIO_WINDOW_DEFAULT_SEC)) + " of probe history, from the first successful probe)"
      : leaf.aggregation && leaf.aggregation !== "latest" && leaf.windowSec
        ? " (" + (AGG_PHRASE[leaf.aggregation] || leaf.aggregation) + " " + humanDuration(leaf.windowSec) + ")" : "";
    var thr = leaf.threshold == null || isNaN(leaf.threshold) ? "…" : leaf.threshold;
    var out = (leaf.type === "host_metric" ? "the Polaris host's " : "") + metricLabel(leaf.metric) + agg + " " + (CMP_PHRASE[leaf.operator] || leaf.operator) + " " + thr + unit;
    var df = leaf.dimensionFilter || {};
    Object.keys(df).forEach(function (k) {
      if (df[k]) out += " " + (DIM_PHRASE[k] || k + " = {value}").replace("{value}", df[k]);
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
    var unit = leafUnit(tr.metric, tr.dimensionFilter); unit = unit ? " " + unit : "";
    var parts = ["<strong>" + escapeHtml(sev) + "</strong> at this level"];
    bands.forEach(function (b) {
      var op = b.operator || tr.operator;
      var thr = b.threshold == null || isNaN(b.threshold) ? "…" : b.threshold;
      // "serious at or above 90 %" — the tier name is the subject here, so the
      // comparator drops its leading "is" ("is at or above" reads as a verb
      // phrase about the metric, which the base clause already supplied).
      var cmp = String(CMP_PHRASE[op] || op).replace(/^is /, "");
      var p = "<strong>" + escapeHtml(b.severity) + "</strong> " + escapeHtml(cmp) + " " +
        escapeHtml(String(thr)) + escapeHtml(unit);
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
      var agg = isWindowedRatio(tr.metric)
        ? " (over the last " + (humanDuration(tr.windowSec) || humanDuration(RATIO_WINDOW_DEFAULT_SEC)) + " of probe history, from the first successful probe)"
        : tr.aggregation && tr.aggregation !== "latest" && tr.windowSec
          ? " (" + escapeHtml(AGG_PHRASE[tr.aggregation] || tr.aggregation) + " " + humanDuration(tr.windowSec) + ")" : "";
      var thr = tr.threshold == null || isNaN(tr.threshold) ? "…" : tr.threshold;
      var unit = leafUnit(tr.metric, tr.dimensionFilter); unit = unit ? " " + unit : "";
      out = "When <strong>" + escapeHtml(subject) + agg + " " + escapeHtml(CMP_PHRASE[tr.operator] || tr.operator) + " " + escapeHtml(String(thr)) + escapeHtml(unit) + "</strong>";
      var df = tr.dimensionFilter || {};
      Object.keys(df).forEach(function (k) {
        if (df[k]) out += " " + escapeHtml((DIM_PHRASE[k] || k + " = {value}").replace("{value}", df[k]));
      });
    } else if (tr.type === "asset_state") {
      var trVal = tr.value == null || tr.value === "" ? "…"
        : (tr.field === "monitorStatus" ? monStatusWord(tr.value) : String(tr.value));
      out = "When <strong>" + escapeHtml(fieldLabel(tr.field)) + " " + escapeHtml(CMP_PHRASE[tr.operator] || tr.operator) + " " + escapeHtml(trVal) + "</strong>";
      // Same dimension clauses a metric trigger renders — a state trigger can
      // filter by interface / tunnel / hostname and the sentence must say so.
      var sdf = tr.dimensionFilter || {};
      Object.keys(sdf).forEach(function (k) {
        if (sdf[k]) out += " " + escapeHtml((DIM_PHRASE[k] || k + " = {value}").replace("{value}", sdf[k]));
      });
    } else if (tr.type === "event") {
      out = "When an audit event matching <strong>" + escapeHtml(tr.actionPattern || "…") + "</strong>" +
        (tr.resourceType ? " on <strong>" + escapeHtml(tr.resourceType) + "</strong> resources" : "") +
        (tr.minLevel ? " at level <strong>" + escapeHtml(tr.minLevel) + "</strong> or above" : "") + " occurs";
    } else if (tr.type === "change") {
      out = "When <strong>" + escapeHtml(changeLabel(tr.changeType)) + "</strong> is detected";
    } else {
      out = "…";
    }
    if ((tr.type === "asset_metric" || tr.type === "host_metric" || tr.type === "asset_state") && tr.forDurationSec > 0) {
      out += ", sustained for <strong>" + holdPhrase(tr) + "</strong>";
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
    sensorClass: "class=", sensorNamePattern: "name~", ifNamePattern: "if~",
    mountPathPattern: "mount~", sdwanRulePattern: "rule~", healthCheck: "health=", link: "member=",
    tunnelName: "tunnel=", widgetId: "widget=", processNamePattern: "process~",
    stateProbeId: "probe=", stateRowPattern: "row~", hostnamePattern: "host~",
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
    var win = agg === "latest" ? "" : ", " + compactDuration(leaf.windowSec > 0 ? leaf.windowSec : SAMPLING_FLOOR_SEC);
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
    var unit = leafUnit(leaf.metric, leaf.dimensionFilter); unit = unit ? " " + unit : "";
    return op + " " + (thr == null || isNaN(thr) ? "…" : thr) + unit;
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
  function holdClause(sec) { return sec > 0 ? "  held " + compactDuration(sec) : ""; }

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
    isBooleanMetric: isBooleanMetric, stateProbeOf: stateProbeOf, stateMapOf: stateMapOf,
    stateValueLabel: stateValueLabel, stateLeafClause: stateLeafClause,
    monStatusWord: monStatusWord,
    fieldLabel: fieldLabel, changeLabel: changeLabel, humanDuration: humanDuration,
    isDownDetectionLeaf: isDownDetectionLeaf, isDownDetectionTrigger: isDownDetectionTrigger,
    missedPollsOf: missedPollsOf, downDetectionMeta: downDetectionMeta,
    leafDeclaresDownCount: leafDeclaresDownCount,
    tgLeafPhrase: tgLeafPhrase, tgTreePhrase: tgTreePhrase,
    triggerSentence: triggerSentence, severityLadderPhrase: severityLadderPhrase, resetSentence: resetSentence,
    invertedLeaf: invertedLeaf, invertedTree: invertedTree, resetCaveat: resetCaveat,
    triggerFormula: triggerFormula, compactDuration: compactDuration,
    holdPhrase: holdPhrase, holdPhraseCompact: holdPhraseCompact,
    CMP_PHRASE: CMP_PHRASE, INV_CMP: INV_CMP, AGG_PHRASE: AGG_PHRASE, DIM_PHRASE: DIM_PHRASE,
  };
}
if (typeof window !== "undefined") window.PolarisAutomationSentences = { make: makeAutomationSentences };

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

/** Which matcher selects readings for a dimension — the two identity dims with
 *  value shapes substring can't honestly serve get their own; everything else
 *  is the shared substring the engine uses. */
function awDimMatcher(dim) {
  if (dim === "ipPattern") return awIpDimensionMatch;
  if (dim === "macPattern") return awMacDimensionMatch;
  return awDimSubstringMatch;
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
  if (hits.length === 1 && hits[0].value.toLowerCase() === q.toLowerCase()) {
    return { text: "✓ exact match", warn: false };
  }
  return { text: "✓ matches " + hits.length + " of " + res.values.length + " reported " + noun, warn: false };
}

/** Sibling dimension values that narrow another dimension's list on the same
 *  condition row: sensor NAMES belong to the chosen class, WAN members to the
 *  chosen health-check. Offering the unnarrowed list would let an operator build
 *  a filter (class=temperature + name=FAN1) that matches nothing. */
function awDimNarrow(dim, df) {
  df = df || {};
  if (dim === "sensorNamePattern") return df.sensorClass ? { sensorClass: df.sensorClass } : {};
  if (dim === "link") return df.healthCheck ? { healthCheck: df.healthCheck } : {};
  // A state probe's rows belong to that probe — "PSU 2" is not a row of the
  // fan-tray probe, so offering every probe's rows would invite a combination
  // that matches nothing.
  if (dim === "stateRowPattern") return df.stateProbeId ? { stateProbeId: df.stateProbeId } : {};
  return {};
}

/** The note under the control. Returns `{text, warn}`; warn = the condition as
 *  written can never match, which is the whole point of asking the devices. */
function awDimNote(res) {
  if (!res || res.loading) return { text: "Checking what the selected devices report…", warn: false };
  if (res.error) return { text: "", warn: false };
  if (!res.scopedAssets) {
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
    note: awDimNote, narrow: awDimNarrow,
  };
  window.PolarisTriggerFilters = { compile: tgFilterCompile, lift: tgFilterLift };
}

/**
 * Open the automation builder.
 *   openAutomationWizard(null)                       → new automation
 *   openAutomationWizard(rule)                       → edit that automation
 *   openAutomationWizard(rule, { clone: true, name }) → new automation
 *       pre-filled from `rule`, saved as a create. `name` is the caller's
 *       suggested copy name (the list uniquifies it against the other rows);
 *       omitted, it falls back to "<name> (copy)".
 */
async function openAutomationWizard(existing, opts) {
  // ── Load the catalogs the steps render from ────────────────────────────
  if (!_ruleSchema) {
    try { _ruleSchema = await api.automations.schema(); }
    catch (err) { showToast("Failed to load the automation schema", "error"); return; }
  }
  if (_ruleTagList === null) {
    try { var _td = await api.assets.tags(); _ruleTagList = ((_td && _td.tags) || []).filter(function (t) { return !_looksLikeDeviceId(t); }); }
    catch (_e) { _ruleTagList = []; }
  }
  if (_ruleAssetTypes === null) {
    // GET /asset-types returns { types: [...] } (the old builder read the
    // wrong key and always showed "No asset types in the registry").
    try { var _at = await api.assetTypes.list(); _ruleAssetTypes = Array.isArray(_at) ? _at : ((_at && (_at.types || _at.assetTypes)) || []); }
    catch (_e) { _ruleAssetTypes = []; }
  }
  // Scope-picker option lists (distinct manufacturers/models + IPAM subnets) —
  // refreshed every open, they're one cheap query each.
  var _awScopeOptions = { manufacturers: [], models: [], interfaceNames: [], ssids: [], subnets: [], regions: [], tagCatalog: [] };
  try { _awScopeOptions = await api.automations.scopeOptions(); } catch (_e) {}
  if (_awScopeOptions && Array.isArray(_awScopeOptions.roles)) _ruleScopeRoles = _awScopeOptions.roles;
  try { var _cd = await api.deliveryChannels.list(); _ruleChannels = (_cd && _cd.channels) || []; }
  catch (_e) { _ruleChannels = _ruleChannels || []; }
  if (_ruleRecipientUsers === null) {
    try { var _ru = await api.automations.recipientUsers(); _ruleRecipientUsers = (_ru && _ru.users) || []; }
    catch (_e) { _ruleRecipientUsers = []; }
  }
  // Which addresses are already in the address book — decides whether a typed
  // address pill offers "save to address book". Refreshed per open (cheap) and
  // skipped entirely without the contacts key, which also hides the affordance.
  if (permAtLeast("contacts", "read")) {
    try {
      var _cl = await api.contacts.list();
      _awContactEmails = new Set(((_cl && _cl.contacts) || []).map(function (c) { return String(c.email).toLowerCase(); }));
    } catch (_e) { _awContactEmails = null; }
  } else {
    _awContactEmails = null;
  }
  // Script registry — readable only with the automationScripts key; a 403
  // hides the script action type rather than erroring the wizard.
  if (_awScripts === null && permAtLeast("automationScripts", "read")) {
    try { var _sd = await api.automationScripts.list(); _awScripts = (_sd && _sd.scripts) || []; }
    catch (_e) { _awScripts = null; }
  } else if (permAtLeast("automationScripts", "read")) {
    try { var _sd2 = await api.automationScripts.list(); _awScripts = (_sd2 && _sd2.scripts) || []; } catch (_e) {}
  }

  var s = _ruleSchema;
  // Three modes, two of which start from an existing row. A CLONE opens a
  // fully-populated draft like an edit but saves as a CREATE, so `editing`
  // stays null on purpose: every `editing`-gated branch below — PUT vs POST,
  // the affected-devices preview's self-exclusion, the draft stash — then does
  // the right thing without a second condition. Only the copy and the
  // all-steps-unlocked behaviour need to know about cloning explicitly.
  // An IMPORT is a clone whose source was a file rather than a row, so it
  // rides the same path: detached deep copy, saved as a CREATE, created
  // disabled, all steps unlocked. Only the labels and the banner differ.
  var importing = !!(opts && opts.import) && !!existing;
  var cloning = importing || (!!(opts && opts.clone) && !!existing);
  var editing = cloning ? null : (existing || null);
  // What the imported file said it needs, and what it could not carry.
  var importInfo = importing ? (opts.importInfo || {}) : null;

  // ── Draft (rule-shape v2) ──────────────────────────────────────────────
  var draft;
  if (editing || cloning) {
    // _awDraftFromRule deep-copies every branch and carries no id, so a clone
    // draft is already fully detached from the row it came from.
    draft = _awDraftFromRule(existing);
    // Retire the band-level resolved policy on the DRAFT, not just when step 3
    // renders: in edit mode an unvisited step keeps whatever the record carried,
    // so a rule saved from step 1 would otherwise keep sending recovery twice.
    retireBandResolved();
    hoistEscalationsToSeverities();
  } else if (_awDraftStash && await showConfirm("Restore your unsaved automation draft?")) {
    draft = _awDraftStash;
  } else {
    draft = {
      name: "", description: null, enabled: true, severity: "warning",
      scope: { allAssets: true },
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: null, forDurationSec: 0 },
      reset: null, // defaulted per trigger type on Step-4 entry
      cooldownSec: null, messageTemplate: null, requireAckNote: false, repeat: null,
      // The audit Event is an action now, present by default — a new
      // automation behaves like every existing one until someone removes it.
      actions: [{ type: "event" }], escalation: null,
    };
  }
  if (cloning) {
    draft.name = (opts && opts.name) || (importing ? draft.name : draft.name + " (copy)");
    // A clone starts DISABLED, and that is deliberate. Business rule 18: two
    // automations watching the same thing at the same scope rank BOTH fire, and
    // a clone is by construction identical to its source — so saving it enabled
    // would double-alert the whole fleet before the operator has changed the
    // one thing they cloned it to change. The wizard has no enabled control
    // (it moved to the list toggle), so step 1 says so in a note.
    draft.enabled = false;
  }
  _awDraftStash = null;

  var step = 1;
  var visited = (editing || cloning) ? 6 : 1;
  var STEPS = ["Name", "Devices", "Trigger", "Reset", "Actions", "Summary"];
  var scopePreviewTimer = null;
  var trigPreviewTimer = null;

  // ── Small shared helpers (schema-driven options / labels) ──────────────
  function opt(list, sel) {
    return (list || []).map(function (v) { return '<option value="' + escapeHtml(v) + '"' + (v === sel ? " selected" : "") + '>' + escapeHtml(v) + '</option>'; }).join("");
  }
  // Severity options carry the shared badge palette (styles.css .sev-select).
  function sevOpt(sel) {
    return (s.severities || []).map(function (v) {
      return '<option value="' + escapeHtml(v) + '" class="sev-' + escapeHtml(v) + '"' + (v === sel ? " selected" : "") + '>' + escapeHtml(v) + '</option>';
    }).join("");
  }
  // Display name for one asset_state VALUE. Only monitorStatus needs one — its
  // stored values are the enum, and `warning` is shown as "Missed" everywhere
  // else (POLARIS_MONITOR_STATUS_LABELS in api.js). Everything else is its own
  // label already, so it passes straight through.
  function stateEnumValueLabel(field, value) {
    return field === "monitorStatus" ? monStatusWord(value) : String(value == null ? "" : value);
  }
  function optLabeled(list, sel, labelFor) {
    return (list || []).map(function (v) {
      return '<option value="' + escapeHtml(v) + '"' + (v === sel ? " selected" : "") + '>' + escapeHtml(labelFor ? labelFor(v) : v) + '</option>';
    }).join("");
  }
  // Schema-label + sentence helpers — the pure factory above owns them; the
  // wizard aliases what its step renderers reference.
  var _sent = makeAutomationSentences(s);
  var findType = _sent.findType, isTriggerScoped = _sent.isTriggerScoped,
      metricLabel = _sent.metricLabel, metricUnit = _sent.metricUnit, leafUnit = _sent.leafUnit,
      fieldLabel = _sent.fieldLabel, changeLabel = _sent.changeLabel,
      humanDuration = _sent.humanDuration, tgTreePhrase = _sent.tgTreePhrase,
      // The tier summaries state a hold in whichever unit the rule states it.
      holdPhrase = _sent.holdPhrase,
      // The folded base-severity block summarizes itself with the same leaf
      // phrase the trigger sentence uses.
      tgLeafPhrase = _sent.tgLeafPhrase,
      triggerSentence = _sent.triggerSentence, triggerFormula = _sent.triggerFormula,
      resetSentence = _sent.resetSentence, invertedTree = _sent.invertedTree,
      isBooleanMetric = _sent.isBooleanMetric, stateMapOf = _sent.stateMapOf,
      isDownDetectionLeaf = _sent.isDownDetectionLeaf, missedPollsOf = _sent.missedPollsOf,
      isDownDetectionTrigger = _sent.isDownDetectionTrigger,
      downDetectionMeta = _sent.downDetectionMeta,
      monStatusWord = _sent.monStatusWord,
      CMP_PHRASE = _sent.CMP_PHRASE, INV_CMP = _sent.INV_CMP;
  var DIM_PLACEHOLDER = { hostnamePattern: "any device — click to pick a hostname, or type to filter", ipPattern: "click to pick an IP — a prefix like 10.4. or a CIDR like 10.4.0.0/16 also works", macPattern: "click to pick a MAC, or type one in any separator style", manufacturerPattern: "any manufacturer — click to pick, or type to filter", modelPattern: "any model — click to pick, or type to filter", sdwanRulePattern: "any SD-WAN rule — click to pick, or type to filter", ifNamePattern: "any interface — click to pick, or type to filter", sensorClass:"sensor class (temperature / fan / voltage / current / optical / poe / power / disk)", sensorNamePattern: "any sensor — click to pick one, or type to filter", mountPathPattern: "any mount — click to pick, or type to filter", healthCheck: "any health check — click to pick", link: "any WAN member — click to pick", tunnelName: "any tunnel — click to pick, or type to filter", widgetId: "custom widget id", stateProbeId: "which state probe", stateRowPattern: "every row — click to pick one, or type to filter" };
  // Dimension VALUE pickers. The server says which dimensionFilter fields it can
  // populate and whether each is a closed enum (`strict` → select-only, e.g.
  // sensorClass) or a substring match (→ suggestions, typing still allowed);
  // POST /automations/dimension-values then answers with the values the DRAFT'S
  // OWN devices report. Empty for a stale server, in which case every dimension
  // falls back to the plain text input it always was.
  var DIM_PICKERS = s.dimensionPickers || {};
  // ── Filter rows ("+ Condition → Device identifier / Component name") ─────
  // Which dimensions render as FILTER ROWS in the condition tree instead of as
  // inline inputs on a condition row. `rep` is the metric/field the value
  // picker asks /dimension-values with — the values come from the DIMENSION's
  // own source regardless, it only has to be a pair the server validates.
  // Device-identifier entries are gated on the server actually knowing them
  // (schema.deviceFilterDimensions — absent on a pre-upgrade server, in which
  // case none of this renders and rows keep their old shape).
  var TG_DEVICE_DIMS = s.deviceFilterDimensions || [];
  var TG_FILTER_META = {
    hostnamePattern: { label: "Hostname", rep: "cpuPct", device: true },
    ipPattern: { label: "IP address", rep: "cpuPct", device: true },
    macPattern: { label: "MAC address", rep: "cpuPct", device: true },
    manufacturerPattern: { label: "Manufacturer", rep: "cpuPct", device: true },
    modelPattern: { label: "Model", rep: "cpuPct", device: true },
    ifNamePattern: { label: "Interface name", rep: "ifOperStatus" },
    tunnelName: { label: "IPsec tunnel name", rep: "ipsecStatus" },
    mountPathPattern: { label: "Storage mount", rep: "storageUsedPct" },
    sdwanRulePattern: { label: "SD-WAN rule name", rep: "sdwanRuleStatus" },
  };
  function tgFilterLabel(dim) { return (TG_FILTER_META[dim] && TG_FILTER_META[dim].label) || dim; }
  /** Filter rows are offered only when the server publishes the device dims —
   *  one gate for the whole surface, so a pre-upgrade server keeps the old UI. */
  function tgFiltersAvailable() { return TG_DEVICE_DIMS.length > 0; }
  /** Can this condition leaf take dimension `d`? Device identifiers apply to
   *  every asset leaf; component names to whatever METRIC_DIMENSIONS /
   *  FIELD_DIMENSIONS say (the server's own applicability rule). */
  function tgSupportsDim(leaf, d) {
    if (!leaf || leaf.type === "asset_filter" || leaf.type === "host_metric") return false;
    if (TG_DEVICE_DIMS.indexOf(d) !== -1) return leaf.type === "asset_metric" || leaf.type === "asset_state";
    if (leaf.type === "asset_state") return (((s.fieldDimensions || {})[leaf.field]) || []).indexOf(d) !== -1;
    return (((s.metricDimensions || {})[leaf.metric]) || []).indexOf(d) !== -1;
  }
  /** Compile a collected UI tree's filter rows into its condition leaves —
   *  the pure module-level tgFilterCompile with this wizard's vocabulary. */
  function tgCompile(tree) { return tgFilterCompile(tree, tgSupportsDim, tgFilterLabel); }
  function tgLiftableDims() {
    return Object.keys(TG_FILTER_META).filter(function (d) {
      return TG_FILTER_META[d].device ? TG_DEVICE_DIMS.indexOf(d) !== -1 : true;
    });
  }
  /** Lift a stored tree's uniform dimension filters back out into filter rows
   *  for rendering. Skipped wholesale on a pre-upgrade server (no rows offered
   *  → nothing may be lifted into a shape the operator can't re-create). */
  function tgLift(tree) {
    return tgFiltersAvailable() ? tgFilterLift(tree, tgSupportsDim, tgLiftableDims()) : tree;
  }
  /** Which dimension inputs render INLINE on a condition row: everything that
   *  is integral to the metric (sensor class/name, health-check, probe rows…)
   *  always; a liftable (filter-row) dimension only as an UNLIFTED LEFTOVER —
   *  a stored value tgFilterLift couldn't raise because siblings disagree —
   *  since dropping it from the row would hide a filter that still evaluates.
   *  On a pre-upgrade server (no filter rows) everything renders inline as
   *  before. */
  function tgInlineDims(baseDims, df) {
    var out = (baseDims || []).filter(function (d) {
      if (!tgFiltersAvailable() || !TG_FILTER_META[d]) return true;
      return !!(df && df[d]);
    });
    TG_DEVICE_DIMS.forEach(function (d) {
      if (df && df[d] && out.indexOf(d) === -1) out.push(d);
    });
    return out;
  }
  // Filter-placement problems from the LAST collect, surfaced by validateStep3 /
  // validateStep4 (collect always runs right before validation on Next/Save).
  var _tgFilterErrors = [];
  var _rsFilterErrors = [];
  // key "metric|dimension|narrowJson|scopeJson" → {loading:true} | result |
  // {error:true}. Keyed by scope so re-picking devices on Step 2 re-asks rather
  // than showing the previous selection's sensors, and by the narrowing so
  // switching sensor class re-asks for THAT class's sensor names.
  var _dimValues = {};
  function dimKeyFor(metric, dim, narrow) {
    return metric + "|" + dim + "|" + JSON.stringify(narrow || {}) + "|" + JSON.stringify(draft.scope || {});
  }
  function dimResult(metric, dim, narrow) {
    var r = _dimValues[dimKeyFor(metric, dim, narrow)];
    return r && !r.loading && !r.error ? r : null;
  }

  var channels = _ruleChannels || [];
  var routedTypes = s.recipientRoutedTypes || ["smtp", "oauth_m365", "web_push"];
  function chanById(id) { return channels.find(function (c) { return c.id === id; }); }
  function chanTypeLabel(type) { return (s.channelTypes && s.channelTypes[type] && s.channelTypes[type].label) || type; }
  function isRouted(type) { return routedTypes.indexOf(type) !== -1; }
  function isEmailType(type) { return type === "smtp" || type === "oauth_m365"; }
  /**
   * Every channel one notify action delivers through — the browser mirror of
   * notifyChannelIds() in notificationTypes.ts. `channelId` is the PRIMARY and
   * the lossless single-channel view; `channelIds` is the full list when the
   * action carries more than one. Every reader goes through this so "an action
   * has one channel" survives nowhere as an assumption.
   */
  function actionChannelIds(a) {
    if (!a) return [];
    var list = (a.channelIds && a.channelIds.length) ? a.channelIds : (a.channelId ? [a.channelId] : []);
    var seen = {}, out = [];
    list.forEach(function (id) { if (id && !seen[id]) { seen[id] = true; out.push(id); } });
    return out;
  }
  /** The resolved channel objects an action delivers through (unknown ids dropped). */
  function actionChannels(a) {
    return actionChannelIds(a).map(chanById).filter(Boolean);
  }
  /**
   * Which of the two per-recipient delivery METHODS a channel type is, or "" for
   * a chat / Pushbullet channel that posts to one fixed destination and has no
   * per-user recipients at all. The vocabulary the preference checkbox is
   * gated on — see business rule 39.
   */
  function channelMethod(type) {
    if (type === "web_push") return "push";
    return isEmailType(type) ? "email" : "";
  }
  /**
   * Do the notify actions inside ONE action list offer BOTH methods? The
   * browser half of actionsCarryBothMethods() — same question, same answer, so
   * the checkbox is never enabled on a group the server would ignore it for.
   * `host` is the action list: the trigger actions, one severity band's, the
   * reset list, or a single escalation tier's.
   */
  function hostOffersBothMethods(host) {
    if (!host) return false;
    var methods = {};
    Array.from(host.querySelectorAll(":scope > .aw-action")).forEach(function (r) {
      var typeSel = r.querySelector(".aw-action-type");
      if (!typeSel || typeSel.value !== "notify") return;
      checkedChannelIds(r).forEach(function (id) {
        var ch = chanById(id);
        var m = ch && channelMethod(ch.type);
        if (m) methods[m] = true;
      });
    });
    return !!(methods.email && methods.push);
  }
  /**
   * The channel ids ticked on ONE action, in list order (so the first is the
   * primary). Takes either the `.aw-action` row or its `.aw-action-fields`.
   *
   * Scoped to that row's OWN fields box, never the whole row: an escalatable
   * action nests a `.aw-esc-sec` full of tier action rows, and a bare
   * `row.querySelectorAll(".na-chan:checked")` would fold every tier's
   * channels into its parent's list — silently, and in the direction that
   * makes an email-only action look like it offers push.
   */
  function checkedChannelIds(el) {
    if (!el) return [];
    var fields = (el.classList && el.classList.contains("aw-action-fields"))
      ? el
      : el.querySelector(":scope > .aw-action-fields");
    if (!fields) return [];
    return Array.from(fields.querySelectorAll(".na-chan:checked")).map(function (cb) { return cb.value; });
  }
  /**
   * Re-gate every preference checkbox in an action list. Called whenever the
   * list's shape changes — a channel ticked, an action added, removed or
   * retyped — because the gate is a property of the GROUP, so one row's edit
   * can enable or disable the checkbox on every other row.
   */
  function refreshPrefGating(host) {
    if (!host) return;
    var both = hostOffersBothMethods(host);
    Array.from(host.querySelectorAll(":scope > .aw-action")).forEach(function (r) {
      var wrap = r.querySelector(":scope > .aw-action-fields > .na-pref");
      if (!wrap) return;
      var cb = wrap.querySelector(".na-pref-enable");
      var hint = wrap.querySelector(".na-pref-hint");
      if (cb) cb.disabled = !both;
      wrap.style.opacity = both ? "" : ".6";
      if (hint) {
        hint.textContent = both
          ? "Each recipient is delivered only through the channel matching their own preference (Email / Push / both). Anyone without a Polaris account — a typed address or an address-book contact — is unaffected."
          : "Available once this list offers both an email and a push channel. With only one method on offer everyone receives it, whatever they prefer — otherwise the preference would delete the alert instead of routing it.";
      }
    });
  }
  // The default alert email, straight from the server (the SAME strings
  // buildComposedEmail falls back to). A new Notify action shows them so the
  // operator edits what actually gets sent; a stored action shows what it
  // saved, including a deliberately blanked field.
  function defaultEmailTemplate() {
    return s.defaultEmailTemplate || { subjectTemplate: "", bodyTextTemplate: "", bodyHtmlTemplate: "" };
  }
  function compValue(comp, key) {
    if (comp && typeof comp[key] === "string") return comp[key];
    return defaultEmailTemplate()[key] || "";
  }
  /**
   * The channel picker on a Notify action: one checkbox per configured channel,
   * ticked for those the action delivers through. Replaces the single-select —
   * an action is plural now. The ORDER of this list defines which channel is
   * primary (the first ticked), which is what keeps `channelId` a truthful
   * mirror of `channelIds[0]` without asking the operator to rank anything.
   */
  function channelChecklist(selIds) {
    if (channels.length === 0) {
      return '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0">No channels configured — add one on the Delivery tab first.</p>';
    }
    var sel = {};
    (selIds || []).forEach(function (id) { sel[id] = true; });
    return channels.map(function (ch) {
      var lbl = ch.name + " — " + chanTypeLabel(ch.type) + (ch.enabled ? "" : " (disabled)");
      return '<label style="font-size:0.82rem;display:inline-flex;align-items:center;gap:5px;margin:0">' +
        '<input type="checkbox" class="na-chan" value="' + escapeHtml(ch.id) + '"' + (sel[ch.id] ? " checked" : "") + '>' +
        escapeHtml(lbl) + '</label>';
    }).join("");
  }

  /**
   * "Sends to all 47 users (12 with a push device)" — a checked-by-default
   * broadcast should say out loud how many people it reaches, rather than
   * looking like an empty recipient list. The device half is the point: the
   * count of ACCOUNTS is not the count of people who will see anything.
   */
  function pushReachAllLine() {
    var users = _ruleRecipientUsers || [];
    if (!users.length) return "";
    var withPush = users.filter(function (u) { return (u.pushDevices || 0) > 0; }).length;
    return "Sends to all " + users.length + " user" + (users.length === 1 ? "" : "s") +
      " (" + withPush + " with a push device" + (withPush === 0 ? " — nobody would be reached" : "") + ").";
  }

  /** userId → enrolled push-browser count, off the recipient-users payload the
   *  wizard already loaded. Handed to the address-book picker so its "Push
   *  devices" column needs no endpoint of its own. */
  function pushDeviceMap() {
    var out = {};
    (_ruleRecipientUsers || []).forEach(function (u) { out[u.id] = u.pushDevices || 0; });
    return out;
  }
  /** The suggestion-row badge for one account on a push box. */
  function pushDeviceBadge(userId) {
    var n = (pushDeviceMap()[userId]) || 0;
    return n ? n + " device" + (n === 1 ? "" : "s") : "no push device";
  }

  /**
   * Warning line under a push recipient picker, or "" when everyone's
   * reachable. `alsoEmail` says this action ALSO carries an email channel, in
   * which case the named people are not lost — they simply get the email
   * copy — and the line must say so rather than claim a total loss.
   */
  function pushReachWarning(selectedIds, alsoEmail) {
    var users = _ruleRecipientUsers || [];
    var byId = {};
    users.forEach(function (u) { byId[u.id] = u; });
    var chosen = (selectedIds || []).map(function (id) { return byId[id]; }).filter(Boolean);
    if (!chosen.length) return "";
    var without = chosen.filter(function (u) { return !(u.pushDevices > 0); });
    if (!without.length) return "";
    var names = without.slice(0, 3).map(function (u) { return u.displayName || u.username; }).join(", ");
    var more = without.length > 3 ? " and " + (without.length - 3) + " more" : "";
    return '<p class="aw-push-warn" style="font-size:0.78rem;color:var(--color-warning);margin:4px 0 0">' +
      escapeHtml(without.length + " of " + chosen.length + " selected user" + (chosen.length === 1 ? "" : "s") +
      " have no push-enabled device (" + names + more + ") — " +
      (alsoEmail
        ? "they will receive only the email from this action."
        : "they will receive nothing from this action.")) +
      '</p>';
  }
  // ── Collapsible severity blocks ────────────────────────────────────────
  //
  // A four-tier automation is four condition groups plus four action lists, and
  // an operator editing the top one shouldn't have to scroll past the three
  // below it. Every severity block therefore folds.
  //
  // State lives in a module map keyed by a STABLE string rather than on the
  // element, because step 5 rebuilds its sections from the draft on every toggle
  // and step 3 re-renders when the base sampling changes — a flag on the node
  // would be lost each time. The key carries the SEVERITY, not an index, so
  // removing a tier doesn't slide another tier's state onto it. Session-scoped:
  // a freshly opened wizard shows everything expanded, since a collapsed block
  // an operator never collapsed reads as missing.
  var _awCollapsed = {};

  /**
   * What a FOLDED severity block says about itself: "is at or above 85 for 5 min".
   * Read from the block's own controls, so it can't drift from what saves — and
   * shared by the base tier and the added ones, which is the whole point: the
   * base showed nothing while the bands showed this, so the first block read as a
   * different kind of thing.
   *
   * `scopeEl` is the block. The hold field is a class on a band row and an id on
   * the base tier (the base's own "Sustained for" is MOVED into the group in
   * multi-severity mode), hence the two-selector lookup.
   */
  /**
   * THE canonical wording for what one severity tier tests: "is at or above 85
   * for 5 min". Both severity surfaces render through this — the trigger step's
   * folded-tier summary (from live DOM controls) and the actions step's
   * per-severity headings (from the draft) — because two hand-built phrasings of
   * the same tier drifted apart: the actions step said "(value is at or above
   * 85)" and dropped the hold entirely, so the same tier read as two different
   * conditions depending on which step you were on.
   *
   * Operator and threshold only; the metric is named once per step and repeating
   * it on every tier row is noise (rule 19: tiers share the trigger's sampling).
   */
  function tierConditionPhrase(operator, threshold, hold) {
    var opText = operator ? ((s.comparatorPhrases || {})[operator] || operator) : "";
    var valText = threshold != null && threshold !== "" ? String(threshold) : "?";
    // `hold` is the phrase, not a number: the unit is the rule's own (polls
    // when it counts readings, wall clock when it states seconds), and one
    // caller reading a DOM field while the other reads the draft must not be
    // where that is decided.
    var h = typeof hold === "number" ? (hold > 0 ? hold + " min" : "") : String(hold || "");
    return (opText ? opText + " " : "") + valText + (h ? " for " + h : "");
  }

  /** What the BASE severity block says about its period: the measurement window
   *  on an aggregated trigger (always wall-clock), the hold otherwise — in the
   *  unit the rule states it in. */
  function baseHoldPhrase(tr) {
    if (!tr) return "";
    return storedHoldPolls(tr) && !tgLeafAggregated(tr) ? holdPhrase(tr) : humanDuration(triggerDurationSec(tr));
  }
  /** What one TIER says: the hold it inherits, or the wall-clock one it states
   *  itself (an API-authored band — resolveTierLadder keeps those in seconds). */
  function bandHoldPhrase(tr, band) {
    if (band && band.forDurationSec != null) return humanDuration(band.forDurationSec);
    return holdPhrase(tr || {});
  }
  function tierSummaryText(scopeEl) {
    if (!scopeEl) return "";
    var op = scopeEl.querySelector(".tgl-op");
    var val = scopeEl.querySelector(".tgl-threshold");
    // ONE hold, shared by every tier, so it is read from the trigger rather than
    // from inside the block — and in minutes, because this phrase is prose (the
    // field itself counts polls). Base block vs tier follows step 5's
    // convention exactly, which is what keeps the two steps saying the same
    // thing: the base states the period its field holds (a measurement WINDOW
    // on an aggregated trigger), a tier states only a HOLD, which an aggregated
    // trigger doesn't have.
    var tr = draft.trigger || {};
    var isBand = !!(scopeEl.classList && scopeEl.classList.contains("aw-band"));
    // A tier states only the HOLD (which it inherits); the base block states
    // whatever its field holds, which on an aggregated trigger is the
    // measurement window and therefore always wall-clock.
    var hold = isBand ? holdPhrase(tr) : baseHoldPhrase(tr);
    if (!op && !val) return "";
    return tierConditionPhrase(op ? op.value : "", val ? val.value : "", hold);
  }

  function collapseBtnHtml(key) {
    var on = !!_awCollapsed[key];
    // Size and colour live in .aw-collapse (styles.css) rather than inline: the
    // glyph is the only affordance on a severity block's header line, so it has
    // to read as a control at a glance.
    return '<button type="button" class="btn-icon aw-collapse" data-collapse="' + escapeHtml(key) + '" ' +
      'aria-expanded="' + (on ? "false" : "true") + '" title="' + (on ? "Expand this severity" : "Collapse this severity") + '" ' +
      'aria-label="' + (on ? "Expand this severity" : "Collapse this severity") + '">' +
      (on ? "&#x25B8;" : "&#x25BE;") + "</button>";
  }

  /** Paint one block from the stored state (also used right after a render). */
  function applyCollapsed(container) {
    var key = container.getAttribute("data-collapse-key");
    if (!key) return;
    var on = !!_awCollapsed[key];
    container.querySelectorAll(":scope > .aw-collapse-body").forEach(function (b) {
      b.style.display = on ? "none" : "";
    });
    // A block that can't be re-wrapped marks its parts in place instead: the base
    // severity group's children are read by selector (`tgCollectGroup` walks
    // `:scope > .scg-children`), so moving them into a wrapper would break
    // collection the way relocating the combinator did.
    // Direct children AND parts inside the header: the base tier's combinator
    // select has to stay in the header (tgCollectGroup reads it as
    // `:scope > div > .scg-op`) but must still fold away with everything else.
    container.querySelectorAll(":scope > .aw-collapse-part, :scope > .aw-collapse-head > .aw-collapse-part").forEach(function (b) {
      // A part the trigger has switched OFF stays off through an unfold: the
      // fields that live inside the base severity block (the hold, a ratio's
      // sustain) are hidden by syncDurationRequirement for reasons this
      // function knows nothing about, and unfolding must not re-offer them.
      b.style.display = on || b.getAttribute("data-hold-off") === "1" ? "none" : "";
    });
    var btn = container.querySelector(':scope [data-collapse="' + key + '"]');
    if (btn) {
      btn.innerHTML = on ? "&#x25B8;" : "&#x25BE;";
      btn.setAttribute("aria-expanded", on ? "false" : "true");
      btn.setAttribute("title", on ? "Expand this severity" : "Collapse this severity");
      btn.setAttribute("aria-label", on ? "Expand this severity" : "Collapse this severity");
    }
    var sum = container.querySelector(":scope > .aw-collapse-head .aw-collapse-summary");
    if (sum) sum.style.display = on ? "" : "none";
  }

  /**
   * Wire every collapsible block under `root`. Idempotent — a re-render calls it
   * again over nodes that may already be bound.
   */
  function wireCollapsibles(root) {
    if (!root) return;
    // `data-collapse-default="closed"` seeds the fold state ONCE. A key absent
    // from _awCollapsed means "the operator has never touched this block", and an
    // explicit true/false written by the toggle below survives every later
    // re-render — so seeding on absence can't undo a deliberate expand.
    // The ROOT may be the collapsible itself (addBandRow wires the tier it just
    // built) — querySelectorAll only sees descendants, so include it explicitly.
    var blocks = Array.prototype.slice.call(root.querySelectorAll("[data-collapse-key]"));
    if (root.getAttribute && root.getAttribute("data-collapse-key")) blocks.unshift(root);
    blocks.forEach(function (container) {
      var k = container.getAttribute("data-collapse-key");
      if (k && _awCollapsed[k] === undefined && container.getAttribute("data-collapse-default") === "closed") {
        _awCollapsed[k] = true;
      }
      applyCollapsed(container);
      var btn = container.querySelector(':scope [data-collapse]');
      if (!btn || btn._awCollapseWired) return;
      btn._awCollapseWired = true;
      btn.addEventListener("click", function (ev) {
        ev.preventDefault();
        var key = container.getAttribute("data-collapse-key");
        _awCollapsed[key] = !_awCollapsed[key];
        applyCollapsed(container);
      });
    });
  }

  /** The clickable token chips. Insert into whichever .tpl-field was focused
   *  last (wireTokenPalette tracks it), so one palette serves several fields. */
  function tokenChipsHtml() {
    var vars = s.templateVariables || [];
    if (!vars.length) return "";
    return vars.map(function (v) {
      return '<button type="button" class="btn btn-sm btn-secondary tpl-token" data-token="' + escapeHtml(v.token) + '" title="' + escapeHtml(v.description) + '" style="margin:2px 4px 2px 0;font-family:var(--font-mono);font-size:0.72rem;padding:1px 6px">' + escapeHtml(v.token) + '</button>';
    }).join("");
  }
  function tokenPaletteHtml(id) {
    var chips = tokenChipsHtml();
    if (!chips) return "";
    return '<details id="' + id + '" style="margin:2px 0 6px"><summary style="font-size:0.78rem;cursor:pointer;color:var(--color-text-tertiary)">Insert variable…</summary><div style="margin-top:4px">' + chips + '</div></details>';
  }
  function scriptById(id) { return (_awScripts || []).find(function (x) { return x.id === id; }); }

  // Which action types the picker offers: catalog-driven, script additionally
  // needs the registry to be readable + the fullwrite key to attach.
  function availableActionTypes() {
    return (s.actionTypes || [{ type: "notify", label: "Send a notification" }]).filter(function (t) {
      if (t.type === "script") return Array.isArray(_awScripts) && permAtLeast("automationScripts", "fullwrite");
      return true;
    });
  }


  // Builder vocabularies — must initialize BEFORE the body assembly below
  // (step2Html/step3Html render from them during the openModal call).
  var tgMeta = s.compositeMeta || {
    groupOps: ["and", "or"],
    groupOpLabels: { and: "All conditions must be met (AND)", or: "At least one condition must be met (OR)" },
    maxDepth: 3, maxLeaves: 10,
    anyDimensionNote: "With multiple conditions, an automation alerts once per device; a per-sensor/per-interface condition counts as met when any of them crosses.",
  };
  var TRIGGER_CATEGORIES = [
    { value: "device", label: "Device conditions" },
    { value: "host", label: "Polaris host conditions" },
    { value: "event", label: (findType("event") || {}).label || "Audit event match" },
    { value: "change", label: (findType("change") || {}).label || "Change detection" },
  ];
  var scMeta = s.scopeCondition || {
    groupOps: ["and", "or", "none", "notAll"],
    groupOpLabels: {
      and: "All child conditions must be satisfied (AND)",
      or: "At least one child condition must be satisfied (OR)",
      none: "All child conditions must NOT be satisfied",
      notAll: "At least one child condition must NOT be satisfied",
    },
    operatorLabels: { equals: "is equal to", notEquals: "is not equal to", contains: "contains", notContains: "does not contain", startsWith: "starts with", endsWith: "ends with", has: "is applied", notHas: "is not applied", inCidr: "is in subnet", notInCidr: "is not in subnet" },
    fields: [
      { field: "assetType", label: "Device type", ops: ["equals", "notEquals"], optionsFrom: "assetTypes" },
      { field: "manufacturer", label: "Manufacturer", ops: ["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith"], optionsFrom: "manufacturers" },
      { field: "model", label: "Model", ops: ["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith"], optionsFrom: "models" },
      { field: "hostname", label: "Hostname", ops: ["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith"], optionsFrom: null },
      { field: "os", label: "Operating system", ops: ["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith"], optionsFrom: null },
      { field: "tag", label: "Tag", ops: ["has", "notHas"], optionsFrom: "tags" },
      { field: "subnet", label: "Subnet / IP", ops: ["inCidr", "notInCidr"], optionsFrom: "subnets" },
      { field: "interfaceName", label: "Device interface", ops: ["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith"], optionsFrom: "interfaceNames" },
      { field: "ssid", label: "Broadcast SSID", ops: ["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith"], optionsFrom: "ssids" },
      { field: "status", label: "Lifecycle status", ops: ["equals", "notEquals"], optionsFrom: null, values: ["active", "maintenance", "decommissioned", "storage", "disabled", "quarantined"] },
      // Asset ID intentionally omitted — a raw id targets one device with no
      // precedence meaning; use hostname. Saved rules using it still evaluate.
    ],
    maxDepth: 5,
  };

  // The devices-step tree is built by the shared module (public/js/condition-builder.js),
  // which contacts use too — this wizard only injects the catalog and the value
  // suggestions. Created HERE, above the body assembly, for the same reason
  // scMeta is: step2Html() runs during that assembly.
  var CB = window.PolarisConditionBuilder;
  var condBuilder = CB.create({
    meta: scMeta,
    valueOptions: scValueOptions,
    onChange: function () { scheduleScopePreview(); },
  });
  var scCloseSuggest = CB.closeSuggest; // the trigger step's dimension combobox reuses it

  // ── Modal shell: stepper + panels + footer ─────────────────────────────
  function stepperHtml() {
    var parts = [];
    for (var i = 1; i <= STEPS.length; i++) {
      parts.push('<div class="stepper-step" data-step="' + i + '"><span class="stepper-num">' + i + '</span><span>' + STEPS[i - 1] + '</span></div>');
      if (i < STEPS.length) parts.push('<div class="stepper-line" data-line="' + i + '"></div>');
    }
    return '<div class="stepper" id="aw-stepper">' + parts.join("") + '</div>';
  }

  var body =
    stepperHtml() +
    '<div class="step-panel visible" id="aw-step-1">' + step1Html() + '</div>' +
    '<div class="step-panel" id="aw-step-2">' + step2Html() + '</div>' +
    '<div class="step-panel" id="aw-step-3">' + step3Html() + '</div>' +
    '<div class="step-panel" id="aw-step-4"></div>' + // rendered on entry (depends on trigger type)
    '<div class="step-panel" id="aw-step-5"></div>' + // rendered on entry (actions/escalation)
    // The notif-email-suggest datalist went with the Cc/Bcc text inputs it fed —
    // the recipient fields now use the .aw-suggest typeahead over /contacts/search.
    '<div class="step-panel" id="aw-step-6"></div>'; // rendered on entry (summary + affected devices)

  var footer =
    '<button class="btn btn-secondary" id="aw-cancel">Cancel</button>' +
    '<button class="btn btn-secondary" id="aw-back" style="display:none">&larr; Back</button>' +
    '<button class="btn btn-primary" id="aw-next">Next &rarr;</button>' +
    '<button class="btn btn-primary" id="aw-save" style="display:none">' + (editing ? "Save changes" : cloning && !importing ? "Create clone" : "Create automation") + '</button>';

  openModal(editing ? "Edit automation" : importing ? "Imported automation" : cloning ? "Clone automation" : "New automation", body, footer, { wide: true });

  // ── Export / import / view-code (public/js/automations-portability.js) ──
  // Guarded on the global: the wizard is standalone and loads on five pages,
  // so a page that omits the module degrades to hiding these affordances.
  function portability() {
    return (typeof window !== "undefined" && window.PolarisAutomationPortability) || null;
  }

  /** The catalogs the strip needs to turn ids into readable names. All are
   *  already fetched for the builder's own pickers, so this costs no request. */
  function portabilityCatalogs() {
    return {
      channels: _ruleChannels || [],
      scripts: _awScripts || [],
      users: _ruleRecipientUsers || [],
      roles: (_awScopeOptions && _awScopeOptions.roles) || [],
      regions: (_awScopeOptions && _awScopeOptions.regions) || [],
      stateProbes: (s && s.stateProbes) || [],
      tags: _ruleTagList || [],
      assetTypes: _ruleAssetTypes || [],
      assets: [],
    };
  }

  // ── Step 1: Name & description ─────────────────────────────────────────
  /** What an imported file needs that this install may not have, and what the
   *  file could not carry. Rendered on step 1 because it is the first thing the
   *  operator sees and it says which later steps need attention. */
  function importNoteHtml() {
    if (!importing) return '';
    var P = portability();
    var deps = (importInfo && importInfo.dependencies) || [];
    var checked = P ? P.checkDependencies(deps, portabilityCatalogs()) : [];
    var missing = checked.filter(function (c) { return c.present === false; });
    var unknown = checked.filter(function (c) { return c.present === null; });
    var present = checked.filter(function (c) { return c.present === true; });

    // Every import loses its delivery wiring by design (an exported file
    // carries no channel, recipient or script ids), so Actions always needs a
    // look. The other two only when the file says so.
    var todo = ['<strong>Actions</strong> \u2014 the imported file carries no delivery wiring, so this automation is in-app only until you add some'];
    if (importInfo && importInfo.needsDevices) {
      todo.push('<strong>Devices</strong> \u2014 the device filter named specific devices, which do not travel between installs');
    }
    if (importInfo && (importInfo.blankedDimensions || []).length) {
      todo.push('<strong>Trigger</strong> \u2014 pick the state probe or widget again; without it the trigger would watch every one on the device');
    }

    function depLine(c) {
      return escapeHtml(c.name) + ' <span style="color:var(--color-text-tertiary)">(' + escapeHtml(c.kind) + ')</span>';
    }

    var depHtml = '';
    if (checked.length) {
      depHtml = '<div style="margin-top:0.5rem">This automation expects:</div><ul style="margin:0.25rem 0 0;padding-left:1.1rem">' +
        present.map(function (c) { return '<li>\u2713 ' + depLine(c) + '</li>'; }).join('') +
        missing.map(function (c) { return '<li><strong>\u2717 not in this install:</strong> ' + depLine(c) + '</li>'; }).join('') +
        unknown.map(function (c) { return '<li>? ' + depLine(c) + '</li>'; }).join('') +
        '</ul>';
    }

    var problems = ((importInfo && importInfo.problems) || []).map(function (m) {
      return '<div style="margin-top:0.35rem"><strong>' + escapeHtml(m) + '</strong></div>';
    }).join('');

    return '<div class="aw-clone-note" style="font-size:0.85rem;margin:0 0 1rem;padding:0.5rem 0.65rem;' +
      'border-left:3px solid var(--color-warning, #b7791f);background:var(--color-bg-subtle, rgba(183,121,31,0.08))">' +
      'Imported from a file. It will be created <strong>disabled</strong> \u2014 review it, then enable it from the list.' +
      problems +
      '<div style="margin-top:0.5rem">Still to do:</div><ul style="margin:0.25rem 0 0;padding-left:1.1rem">' +
      todo.map(function (t) { return '<li>' + t + '</li>'; }).join('') + '</ul>' +
      depHtml +
      '</div>';
  }

  function step1Html() {
    // Cloning: say up front that the copy is inert and why, because the wizard
    // has no enabled control to show it — that lives on the list toggle.
    var cloneNote = cloning && !importing
      ? '<p class="aw-clone-note" style="font-size:0.85rem;margin:0 0 1rem;padding:0.5rem 0.65rem;' +
        'border-left:3px solid var(--color-warning, #b7791f);background:var(--color-bg-subtle, rgba(183,121,31,0.08))">' +
        'Copied from <strong>' + escapeHtml((existing && existing.name) || "") + '</strong>. ' +
        'It will be created <strong>disabled</strong> — an identical automation watching the same thing would ' +
        'alert alongside the original. Change what you need, save, then enable it from the list.</p>'
      : "";
    // Import is offered when CREATING only \u2014 replacing the automation an
    // operator opened to edit would be a data-loss trap, not a feature.
    var importRow = (!editing && !cloning && portability() && permAtLeast("automationManagement", "fullwrite"))
      ? '<div style="display:flex;align-items:center;gap:0.5rem;margin:0 0 1rem;flex-wrap:wrap">' +
          '<button class="btn btn-secondary" id="aw-import-btn" type="button">Import from file\u2026</button>' +
          '<span style="font-size:0.8rem;color:var(--color-text-tertiary);flex:1 1 16rem">Start from an exported automation. The file\u2019s name becomes this automation\u2019s name.</span>' +
          '<input type="file" id="aw-import-input" accept=".json,.automation.json,application/json" style="display:none">' +
        '</div>'
      : '';
    return '<h3 style="margin:0 0 0.25rem">What is this automation?</h3>' +
      '<p style="font-size:0.85rem;color:var(--color-text-tertiary);margin:0 0 1rem">Name it and describe what it watches for. (Severity is set with the trigger on the next steps.)</p>' +
      importNoteHtml() +
      importRow +
      cloneNote +
      '<div class="form-group"><label>Name</label><input type="text" id="aw-name" value="' + escapeHtml(draft.name || "") + '" placeholder="e.g. Switch temperature high"></div>' +
      '<div class="form-group"><label>Description (optional)</label><input type="text" id="aw-desc" value="' + escapeHtml(draft.description || "") + '"></div>';
  }
  /**
   * Wire the Import control. Reading the file is done in the BROWSER — nothing
   * is uploaded — and the parsed rule is handed to a fresh wizard in `import`
   * mode, which then saves through the ordinary POST /automations. The server's
   * ruleInputSchema + assertActionRefs stay the authority.
   */
  function wireStep1() {
    var btn = document.getElementById("aw-import-btn");
    var input = document.getElementById("aw-import-input");
    if (!btn || !input) return;

    btn.addEventListener('click', function () {
      // Reset first: picking the SAME file twice must still fire `change`.
      input.value = "";
      input.click();
    });

    input.addEventListener('change', async function () {
      var file = this.files && this.files[0];
      input.value = "";
      if (!file) return;
      var P = portability();
      if (!P) return;

      // Refuse without reading: a rule is a few KB.
      if (file.size > P.MAX_IMPORT_BYTES) {
        showToast("That file is too large to be an automation.", "error");
        return;
      }

      // Anything typed so far is about to be replaced, and the stash is only
      // written by the Cancel button — so ask rather than silently discarding.
      collectStep1();
      if (draft.name || draft.description) {
        var ok = await showConfirm("Replace what you have started with the imported automation?");
        if (!ok) return;
      }

      var parsedFile;
      try {
        var text = await file.text();
        parsedFile = P.parseImportFile(text, file.name, triggerTypeNames());
      } catch (err) {
        showToast((err && err.message) || "That file could not be read as an automation.", "error");
        return;
      }

      // A preview in flight from THIS wizard would otherwise land in the new
      // one and paint the old draft's device count into it.
      if (scopePreviewTimer) { clearTimeout(scopePreviewTimer); scopePreviewTimer = null; }
      if (trigPreviewTimer) { clearTimeout(trigPreviewTimer); trigPreviewTimer = null; }

      // Reopen rather than mutate: steps 1-3 were rendered once at open, so
      // swapping `draft` underneath them would leave stale DOM. openModal
      // replaces the shared overlay's body, so there is no need to close first
      // (and closing would blank the screen for three catalogue re-fetches).
      openAutomationWizard(parsedFile.rule, {
        import: true,
        name: parsedFile.name,
        importInfo: {
          dependencies: parsedFile.dependencies,
          needsDevices: parsedFile.needsDevices,
          blankedDimensions: parsedFile.blankedDimensions,
          problems: parsedFile.problems,
        },
      }).catch(function (err) {
        showToast((err && err.message) || "Failed to open the imported automation", "error");
      });
    });
  }

  /** Trigger type names from the schema, so an unknown type in a file is
   *  refused before it can throw mid-render. */
  function triggerTypeNames() {
    return ((s && s.triggerTypes) || []).map(function (t) {
      return typeof t === "string" ? t : t.type;
    }).filter(Boolean);
  }

  function collectStep1() {
    draft.name = document.getElementById("aw-name").value.trim();
    draft.description = document.getElementById("aw-desc").value.trim() || null;
  }
  function validateStep1() {
    if (!draft.name) return "Name is required.";
    return null;
  }

  // ── Step 2: Asset filtering (nested condition builder) ──────────────────
  // SolarWinds-style tree: a root group with a combinator (AND / OR / NONE /
  // NOT-ALL), child rules of [field][operator][value], and nested sub-groups.
  // An empty root = all assets. Collect walks the DOM into scope.condition;
  // the backend evaluates the same tree via evaluateScopeCondition.
  function scFieldMeta(field) {
    return (scMeta.fields || []).find(function (f) { return f.field === field; }) || scMeta.fields[0];
  }
  function scValueOptions(field) {
    var fm = scFieldMeta(field);
    if (fm.values) return fm.values.map(function (v) { return { value: v, label: v }; });
    switch (fm.optionsFrom) {
      case "assetTypes": return (_ruleAssetTypes || []).map(function (t) { return { value: t.name, label: t.label || t.name }; });
      case "manufacturers": return (_awScopeOptions.manufacturers || []).map(function (m) { return { value: m, label: m }; });
      case "models": return (_awScopeOptions.models || []).map(function (m) { return { value: m, label: m }; });
      case "interfaceNames": return (_awScopeOptions.interfaceNames || []).map(function (n) { return { value: n, label: n }; });
      case "ssids":         return (_awScopeOptions.ssids || []).map(function (n) { return { value: n, label: n }; });
      case "tags": return (_ruleTagList || []).map(function (t) { return { value: t, label: t }; });
      case "subnets": return (_awScopeOptions.subnets || []).map(function (sn) { return { value: sn.cidr, label: sn.name + " — " + sn.cidr }; });
      default: return [];
    }
  }
  function step2Html() {
    var scope = draft.scope || {};
    var allAssets = !scope.condition && (scope.allAssets === true || Object.keys(scope).length === 0);
    var root = scope.condition
      ? JSON.parse(JSON.stringify(scope.condition))
      : (allAssets ? { op: "and", children: [] } : CB.legacyScopeToCondition(scope));
    return '<h3 style="margin:0 0 0.25rem">Which devices?</h3>' +
      '<p style="font-size:0.85rem;color:var(--color-text-tertiary);margin:0 0 0.75rem">Polaris-host and audit-event triggers aren’t tied to assets and ignore this filter.</p>' +
      '<div class="form-group" style="margin-bottom:0.5rem"><label style="font-weight:600"><input type="checkbox" id="aw-all-assets"' + (allAssets ? " checked" : "") + '> All assets</label>' +
      '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:2px 0 0 24px">Uncheck to filter which devices this automation applies to.</p></div>' +
      '<div id="aw-cond-wrap" style="display:' + (allAssets ? "none" : "block") + '">' +
        '<p style="font-size:0.82rem;color:var(--color-text-tertiary);margin:0 0 0.5rem">Build the filter from conditions and nested groups — drag the <span class="aw-grip" style="cursor:default">&#x2842;</span> handle to move a condition into another group or reorder groups.</p>' +
        '<div id="aw-cond-root">' + condBuilder.groupHtml(root, 0) + '</div>' +
        // Fixed-height (see .aw-preview-box): the debounced reload must not
        // resize the step under the operator's cursor.
        '<div id="aw-scope-preview" class="aw-preview-box" style="margin-top:0.75rem">' + scopePreviewHtml('<span class="aw-preview-muted">Checking…</span>') + '</div>' +
      '</div>';
  }
  function wireStep2() {
    var panel = document.getElementById("aw-step-2");
    var allCb = panel.querySelector("#aw-all-assets");
    if (allCb) {
      allCb.addEventListener("change", function () {
        var wrap = panel.querySelector("#aw-cond-wrap");
        wrap.style.display = allCb.checked ? "none" : "block";
        if (!allCb.checked) {
          // Revealed with an empty root: seed a starter row so the operator
          // lands on something editable.
          condBuilder.seedIfEmpty(panel.querySelector("#aw-cond-root"));
          scheduleScopePreview();
        }
      });
    }
    // Rows, groups, the value combobox and the grip drag all live in the
    // shared module; the preview debounce rides its onChange.
    condBuilder.wire(panel, "#aw-cond-root");
  }
  function collectStep2() {
    var cb = document.getElementById("aw-all-assets");
    if (cb && cb.checked) { draft.scope = { allAssets: true }; return; }
    var root = document.querySelector("#aw-cond-root > .scg-group");
    if (!root) return;
    var tree = condBuilder.collect(root);
    // With "All assets" unchecked an empty tree is NOT all-assets — validation
    // asks for a condition or a re-check so nothing matches silently.
    draft.scope = { condition: tree };
  }
  function validateStep2() {
    if (!isTriggerScoped(draft.trigger)) return null; // non-scoped triggers ignore the filter
    var sc = draft.scope || {};
    if (sc.allAssets || !sc.condition) return null;
    if (!sc.condition.children.length) {
      // An empty tree with "All assets" unchecked is NOT all-assets — say so
      // rather than letting it save something that matches nothing.
      return 'Add at least one condition, or check "All assets".';
    }
    return condBuilder.validate(sc.condition);
  }
  // One shell for every preview state — "Checking…", a result, an error — so the
  // box's height comes from the CSS rather than from what came back. Head holds
  // the count line (which may wrap); the matched-device list scrolls in the body.
  function scopePreviewHtml(headHtml, bodyHtml) {
    return '<p class="aw-preview-head">' + headHtml + '</p>' +
      '<div class="aw-preview-body' + (bodyHtml ? ' table-wrapper' : '') + '">' + (bodyHtml || "") + '</div>';
  }
  function scheduleScopePreview() {
    if (scopePreviewTimer) clearTimeout(scopePreviewTimer);
    scopePreviewTimer = setTimeout(runScopePreview, 400);
  }
  async function runScopePreview() {
    var box = document.getElementById("aw-scope-preview");
    if (!box) return;
    collectStep2();
    box.innerHTML = scopePreviewHtml('<span class="aw-preview-muted">Checking…</span>');
    try {
      var res = await api.automations.preview({ scope: draft.scope });
      var rows = (res.matches || []).slice(0, 15).map(function (m) {
        return '<tr><td>' + escapeHtml(m.hostname || m.assetId || "") + '</td></tr>';
      }).join("");
      // MONITORED devices are what the list and the count report — those are
      // what an operator is choosing between. The unmonitored remainder is
      // stated rather than hidden (the filter does select them), but no
      // trigger fires about an unmonitored device, so the note says so.
      var un = res.unmonitoredCount || 0;
      // The "first 15" note rides the head rather than trailing the list: in a
      // scrolling body it would sit below the fold, i.e. exactly where an
      // operator wondering whether the list is complete can't see it.
      box.innerHTML = scopePreviewHtml(
        '<strong>' + res.totalEvaluated + '</strong> monitored device(s) match this filter.' +
          (un ? ' <span class="aw-preview-muted">(+' + un + ' unmonitored — automations never fire on those.)</span>' : "") +
          (res.totalEvaluated > 15 ? ' <span class="aw-preview-muted">Showing the first 15.</span>' : ""),
        rows ? '<table><tbody>' + rows + '</tbody></table>' : ""
      );
    } catch (err) {
      box.innerHTML = scopePreviewHtml('<span class="aw-preview-muted">' + escapeHtml(err.message || "Preview unavailable") + '</span>');
    }
  }

  // ── Step 3: Trigger conditions (AND/OR condition tree) ─────────────────
  // Device / Polaris-host triggers use the same nested group builder as the
  // Devices step: leaf rows are metric/state conditions, groups combine with
  // AND/OR (only — negation would fire on missing data), drag-and-drop moves
  // conditions between groups. One condition saves as the legacy single
  // trigger (per-sensor/-mount alerting + hysteresis); two or more save as a
  // composite that alerts once per device. Audit-event and change triggers
  // keep their flat fields.
  function triggerCategoryOf(tr) {
    if (!tr || !tr.type) return "device";
    if (tr.type === "composite") return tr.kind === "host" ? "host" : "device";
    if (tr.type === "host_metric") return "host";
    if (tr.type === "event" || tr.type === "change") return tr.type;
    return "device";
  }
  function tgDefaultLeaf(kind) {
    return kind === "host"
      ? { type: "host_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: null }
      : { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: null };
  }
  function triggerToTree(tr, kind) {
    // Both stored shapes render through tgLift, so a uniform dimensionFilter
    // comes back as the filter row the operator authored it as.
    if (tr && tr.type === "composite" && (tr.kind || "asset") === kind) {
      return tgLift({ op: tr.op || "and", children: JSON.parse(JSON.stringify(tr.children || [])) });
    }
    var leafKinds = kind === "host" ? ["host_metric"] : ["asset_metric", "asset_state"];
    if (tr && leafKinds.indexOf(tr.type) !== -1) {
      var leaf = JSON.parse(JSON.stringify(tr));
      delete leaf.forDurationSec;
      return tgLift({ op: "and", children: [leaf] });
    }
    return { op: "and", children: [tgDefaultLeaf(kind)] };
  }
  /** Mirror of the server's collapseCompositeTrigger: 1 leaf ⇒ legacy single
   *  trigger (so Step 4 offers hysteresis and the stored shape matches). */
  function tgCollapse(tr) {
    var op = tr.op, children = tr.children;
    while (children.length === 1 && children[0] && children[0].type === undefined && Array.isArray(children[0].children)) {
      op = children[0].op; children = children[0].children;
    }
    if (children.length === 1 && children[0] && children[0].type !== undefined) {
      var leaf = JSON.parse(JSON.stringify(children[0]));
      leaf.forDurationSec = tr.forDurationSec || 0;
      // The COUNT rides down with its mirror (collapseCompositeTrigger does the
      // same server-side): a collapsed leaf keeping only the seconds would fall
      // back to the engine's wall-clock path.
      if (tr.forPolls > 0) leaf.forPolls = tr.forPolls;
      return leaf;
    }
    return { type: "composite", kind: tr.kind, op: op, children: children, forDurationSec: tr.forDurationSec || 0, forPolls: tr.forPolls > 0 ? tr.forPolls : undefined };
  }
  function tgLeaves(node) {
    var out = [];
    (node.children || []).forEach(function (c) {
      if (c && c.type !== undefined) out.push(c);
      else if (c) out = out.concat(tgLeaves(c));
    });
    return out;
  }
  /**
   * Re-pin each rendered leaf row's selects from the model, right after a tree's
   * HTML is injected. In a browser this is a no-op (the parsed
   * `<option selected>` markup already agrees); happy-dom — the wizard's test
   * environment — mis-parses a mid-list selected option, which made a STORED
   * asset_state trigger read back as a metric row and throw in tgCollectLeaf.
   * Same idiom as renderBandCond's post-render assignments. DOM rows and
   * tgLeaves() walk the same depth-first order by construction, so index i of
   * one is index i of the other.
   */
  function pinTreeSelects(rootEl, tree) {
    if (!rootEl || !tree) return;
    var leaves = tgLeaves(tree);
    rootEl.querySelectorAll(".scr-row").forEach(function (row, i) {
      var leaf = leaves[i];
      if (!leaf) return;
      var what = row.querySelector(".tgl-what");
      if (what) what.value = leaf.type === "asset_filter" ? "d:" + leaf.dim : leaf.type === "asset_state" ? "f:" + leaf.field : "m:" + leaf.metric;
      var op = row.querySelector(".tgl-op");
      if (op && leaf.operator) op.value = leaf.operator;
      var agg = row.querySelector(".tgl-agg");
      if (agg && !agg.getAttribute("data-ratio")) agg.value = leaf.aggregation || "latest";
      if (leaf.type === "asset_state") {
        var v = row.querySelector("select.tgl-value");
        if (v && leaf.value != null) v.value = String(leaf.value);
      } else {
        var flag = row.querySelector("select.tgl-flag");
        var t = Number(leaf.threshold);
        if (flag && (t === 0 || t === 1)) flag.value = String(t);
      }
      row.querySelectorAll("select.tgl-dim").forEach(function (el) {
        var d = el.getAttribute("data-dim");
        el.value = (leaf.dimensionFilter && leaf.dimensionFilter[d]) || "";
      });
    });
  }
  function tgGroupOpOptions(sel) {
    return (tgMeta.groupOps || ["and", "or"]).map(function (o) {
      return '<option value="' + o + '"' + (o === sel ? " selected" : "") + '>' + escapeHtml((tgMeta.groupOpLabels || {})[o] || o) + '</option>';
    }).join("");
  }
  function tgWhatOptions(kind, selWhat) {
    if (kind === "host") {
      var hm = (findType("host_metric") || {}).metrics || [];
      return hm.map(function (m) {
        var v = "m:" + m;
        return '<option value="' + escapeHtml(v) + '"' + (v === selWhat ? " selected" : "") + '>' + escapeHtml(metricLabel(m)) + '</option>';
      }).join("");
    }
    var metrics = (findType("asset_metric") || {}).metrics || [];
    var fields = (findType("asset_state") || {}).fields || [];
    var html = '<optgroup label="Metrics">' + metrics.map(function (m) {
      var v = "m:" + m;
      return '<option value="' + escapeHtml(v) + '"' + (v === selWhat ? " selected" : "") + '>' + escapeHtml(metricLabel(m)) + '</option>';
    }).join("") + '</optgroup><optgroup label="Device state">' + fields.map(function (f) {
      var v = "f:" + f;
      return '<option value="' + escapeHtml(v) + '"' + (v === selWhat ? " selected" : "") + '>' + escapeHtml(fieldLabel(f)) + '</option>';
    }).join("") + '</optgroup>';
    // Filter rows: narrow the conditions in this group by who the device is
    // (identifier) or which component the reading is about (name). Gated on the
    // server publishing the vocabulary — see tgFiltersAvailable.
    if (tgFiltersAvailable()) {
      var filterOpt = function (d) {
        var v = "d:" + d;
        return '<option value="' + escapeHtml(v) + '"' + (v === selWhat ? " selected" : "") + '>' + escapeHtml(tgFilterLabel(d)) + '</option>';
      };
      var idDims = tgLiftableDims().filter(function (d) { return TG_FILTER_META[d].device; });
      var nameDims = tgLiftableDims().filter(function (d) { return !TG_FILTER_META[d].device; });
      html += '<optgroup label="Device identifier (filters this group)">' + idDims.map(filterOpt).join("") + '</optgroup>' +
        '<optgroup label="Component name (filters this group)">' + nameDims.map(filterOpt).join("") + '</optgroup>';
    }
    return html;
  }
  function tgStateValueControl(field, val) {
    var meta = s.fieldMeta && s.fieldMeta[field];
    var v = val != null ? String(val) : "";
    if (meta && (meta.kind === "enum" || meta.kind === "bool") && meta.values) {
      // Labeled, not raw: monitorStatus stores `warning` but every pill in the
      // product reads "Missed", and the builder was the one surface still
      // quoting the enum. The option VALUE is untouched, so what saves and what
      // the engine compares are unchanged.
      return '<select class="tgl-value" style="width:130px">' +
        optLabeled(meta.values, v, function (x) { return stateEnumValueLabel(field, x); }) + '</select>';
    }
    if (meta && meta.kind === "number") return '<input type="number" class="tgl-value" value="' + escapeHtml(v) + '" style="width:110px" placeholder="e.g. 3">';
    return '<input type="text" class="tgl-value" value="' + escapeHtml(v) + '" style="width:130px" placeholder="e.g. up / down">';
  }
  /**
   * The value control for a 0/1 state metric: the probe's OWN two labels
   * ("Alarm" / "OK"), not a number box. It carries `.tgl-threshold` so
   * tgCollectLeaf reads it like any other threshold and the saved trigger stays a
   * plain numeric comparison — the engine needs no boolean special case, and a
   * rule saved here still opens correctly in a client that predates this control.
   * Labels come from the row's chosen probe, so changing the probe relabels it
   * (see the stateProbeId branch in wireTgTree's change handler).
   */
  function tgStateFlagControl(leaf) {
    var m = stateMapOf(leaf.metric, leaf.dimensionFilter || {});
    var t = Number(leaf.threshold);
    // Default to the state the operator called the interesting one, which is
    // what they're almost always alerting on.
    var sel = (t === 0 || t === 1) ? String(t) : (m.trueIsProblem ? "1" : "0");
    return '<select class="tgl-threshold tgl-flag" style="width:auto;min-width:110px" title="Which state fires the alert">' +
      '<option value="1"' + (sel === "1" ? " selected" : "") + '>' + escapeHtml(m.trueLabel) + '</option>' +
      '<option value="0"' + (sel === "0" ? " selected" : "") + '>' + escapeHtml(m.falseLabel) + '</option>' +
    '</select>';
  }
  // One dimensionFilter control. A dimension the server can populate renders as
  // a select (closed enum) or a COMBOBOX (substring match — click to pick one of
  // the values the scoped devices report, or type a pattern); anything else stays
  // the plain text box it always was.
  function dimControlHtml(d, df, metric) {
    var value = (df && df[d]) || "";
    var meta = DIM_PICKERS[d];
    var placeholder = escapeHtml(DIM_PLACEHOLDER[d] || d);
    if (!meta) {
      return '<input type="text" class="tgl-dim" data-dim="' + escapeHtml(d) + '" placeholder="' + placeholder + '" value="' + escapeHtml(value) + '" style="flex:1;min-width:120px">';
    }
    var res = dimResult(metric, d, awDimNarrow(d, df));
    if (meta.strict) {
      return '<select class="tgl-dim" data-dim="' + escapeHtml(d) + '" style="flex:1;min-width:150px;font-size:0.8rem" title="' + placeholder + '">' +
        awDimOptionsHtml(res, value) + '</select>';
    }
    // Combobox + a cue that says whether the typed pattern selects anything —
    // the whole point being that a sensor name is not guessable, so the field
    // has to offer the fleet's own names and confirm what's in it.
    return '<span class="aw-combo aw-combo-dim" style="flex:1;min-width:160px">' +
        '<input type="text" class="tgl-dim" data-dim="' + escapeHtml(d) + '" autocomplete="off" placeholder="' + placeholder + '" value="' + escapeHtml(value) + '">' +
        '<div class="aw-suggest"></div>' +
      '</span>' +
      '<span class="tgl-dim-cue" style="font-size:0.75rem;white-space:nowrap"></span>';
  }
  /** The metric OR state field a dim control belongs to, read LIVE off its row
   *  so switching the metric re-asks for that metric's values instead of
   *  reusing the old ones. State fields ("f:") ask through the same
   *  /dimension-values endpoint — the two namespaces share no name, so the
   *  bare identifier is unambiguous server-side. */
  function dimMetricOf(el) {
    var row = el.closest(".scr-row");
    var what = row && row.querySelector(".tgl-what");
    var v = what ? String(what.value || "") : "";
    // A filter row has no metric of its own — the picker asks with the
    // dimension's representative pair (the values come from the dimension's
    // source either way; the pair only has to validate server-side).
    if (v.indexOf("d:") === 0) return (TG_FILTER_META[v.slice(2)] || {}).rep || "";
    return v.indexOf("m:") === 0 || v.indexOf("f:") === 0 ? v.slice(2) : "";
  }
  /** The row's current dimensionFilter, read live off its controls (mirrors
   *  tgCollectLeaf) — the narrowing input for sibling-dependent lists. */
  function dimFilterOfRow(row) {
    var df = {};
    if (!row) return df;
    row.querySelectorAll(".tgl-dim").forEach(function (el) {
      var v = (el.value || "").trim();
      if (v) df[el.getAttribute("data-dim")] = v;
    });
    return df;
  }
  /** The dimension-value result for a control, read live off its row (metric +
   *  sibling narrowing), or null before it's been asked for. */
  function dimResultOf(el) {
    var d = el.getAttribute("data-dim");
    var metric = dimMetricOf(el);
    if (!metric) return null;
    return _dimValues[dimKeyFor(metric, d, awDimNarrow(d, dimFilterOfRow(el.closest(".scr-row"))))] || null;
  }
  function dimSuggestOf(el) {
    var combo = el.closest && el.closest(".aw-combo");
    return combo ? combo.querySelector(".aw-suggest") : null;
  }
  /** Paint the per-input match cue ("✓ matches 2 of 14 reported hardware
   *  sensors" / "✕ matches none …"). */
  function paintDimCue(el, res) {
    var combo = el.closest && el.closest(".aw-combo");
    var cue = combo && combo.nextElementSibling;
    if (!cue || !cue.classList || !cue.classList.contains("tgl-dim-cue")) return;
    var c = awDimMatchCue(res, el.value, el.getAttribute("data-dim"));
    cue.textContent = c.text;
    cue.style.color = c.warn ? "var(--color-warning, #d9a441)" : "var(--color-success, #3ba55d)";
  }
  function applyDimOptions(el) {
    var d = el.getAttribute("data-dim");
    if (!DIM_PICKERS[d]) return;
    var metric = dimMetricOf(el);
    var narrow = awDimNarrow(d, dimFilterOfRow(el.closest(".scr-row")));
    var res = metric ? _dimValues[dimKeyFor(metric, d, narrow)] : null;
    // Cue + any open suggestion list track the LATEST result and value, so the
    // loading→loaded transition fills them in without the operator re-clicking.
    paintDimCue(el, res);
    var sug = dimSuggestOf(el);
    if (sug && sug.classList.contains("open")) sug.innerHTML = awDimSuggestHtml(res, el.value, d);
    // A condition row's dims sit inside .tgl-line2; a filter row's input is on
    // line 1 with its note below — fall back to the row-level lookup for it.
    var note = el.closest(".tgl-line2");
    note = note && note.querySelector(".tgl-dim-note");
    if (!note) {
      var frow = el.closest(".scr-row");
      note = frow && frow.getAttribute("data-filter-row") ? frow.querySelector(".tgl-dim-note") : null;
    }
    if (note) {
      var n = awDimNote(res);
      // Two pickers can share one row (SD-WAN health-check + member): a
      // never-matches warning from either must not be overwritten by the other's
      // quiet line.
      if (n.warn || note.getAttribute("data-warn") !== "1") {
        note.textContent = n.text;
        note.setAttribute("data-warn", n.warn ? "1" : "0");
        note.style.color = n.warn ? "var(--color-warning, #d9a441)" : "var(--color-text-tertiary)";
      }
    }
    if (!res || res.loading || res.error) return;
    var key = dimKeyFor(metric, d, narrow);
    if (el.getAttribute("data-dim-key") === key) return; // already applied
    el.setAttribute("data-dim-key", key);
    var cur = el.value || "";
    if (el.tagName === "SELECT") {
      el.innerHTML = awDimOptionsHtml(res, cur);
      el.value = cur;
    }
  }
  /** Fire input+change on a control the code just filled in, so the handlers
   *  that already exist (trigger sentence, unit chip, sibling narrowing, the
   *  match cue) do the follow-up work. Built from the element's OWN window: a
   *  DOM implementation rejects an Event constructed by another realm's
   *  constructor, which is what the happy-dom wizard tests run in. */
  function fireInputChange(el) {
    var view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    el.dispatchEvent(new view.Event("input", { bubbles: true }));
    el.dispatchEvent(new view.Event("change", { bubbles: true }));
  }
  /** Combobox behaviour for the substring dimension inputs, mirroring the
   *  Devices-step value combo: focus/click opens everything the scoped devices
   *  report, typing filters it, ArrowUp/Down + Enter pick, Esc closes. Delegated
   *  once per panel (guarded) so tier rows and re-rendered condition rows are
   *  covered without re-binding — a panel's innerHTML being replaced doesn't
   *  drop panel-level listeners. */
  function wireDimCombo(panel) {
    if (!panel || panel._dimComboWired) return;
    panel._dimComboWired = true;
    var isDim = function (t) {
      return t && t.tagName === "INPUT" && t.classList && t.classList.contains("tgl-dim") && t.closest(".aw-combo-dim");
    };
    var open = function (input) {
      var sug = dimSuggestOf(input);
      if (!sug || input.disabled) return;
      sug.innerHTML = awDimSuggestHtml(dimResultOf(input), input.value, input.getAttribute("data-dim"));
      sug.classList.add("open");
    };
    panel.addEventListener("focusin", function (e) { if (isDim(e.target)) open(e.target); });
    panel.addEventListener("click", function (e) { if (isDim(e.target)) open(e.target); });
    panel.addEventListener("input", function (e) {
      if (!isDim(e.target)) return;
      open(e.target); // refilter as they type
      paintDimCue(e.target, dimResultOf(e.target));
    });
    panel.addEventListener("focusout", function (e) {
      var input = e.target;
      if (!isDim(input)) return;
      // Delay so a mousedown on a suggestion (which fires before blur
      // completes) still lands.
      setTimeout(function () {
        var sug = dimSuggestOf(input);
        if (sug && !sug.contains(document.activeElement)) scCloseSuggest(sug);
      }, 150);
    });
    panel.addEventListener("mousedown", function (e) {
      var item = e.target.closest && e.target.closest(".aw-suggest-item");
      if (!item) return;
      var combo = item.closest(".aw-combo-dim");
      var input = combo && combo.querySelector("input.tgl-dim");
      if (!input) return;
      e.preventDefault(); // keep focus on the input
      input.value = item.getAttribute("data-val");
      // Notify first, close second — the input event reopens the list, so
      // closing before it would leave the picked-and-still-open state.
      fireInputChange(input);
      scCloseSuggest(dimSuggestOf(input));
    });
    panel.addEventListener("keydown", function (e) {
      var input = e.target;
      if (!isDim(input)) return;
      var sug = dimSuggestOf(input);
      var isOpen = sug && sug.classList.contains("open");
      if (e.key === "Escape") {
        if (isOpen) { scCloseSuggest(sug); e.stopPropagation(); } // keep the modal open
        return;
      }
      if (!isOpen) return;
      var items = Array.prototype.slice.call(sug.querySelectorAll(".aw-suggest-item"));
      if (!items.length) return;
      var idx = items.findIndex(function (i) { return i.classList.contains("active"); });
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        var next = e.key === "ArrowDown" ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
        items.forEach(function (i) { i.classList.remove("active"); });
        items[next].classList.add("active");
        if (items[next].scrollIntoView) items[next].scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && idx >= 0) {
        e.preventDefault();
        input.value = items[idx].getAttribute("data-val");
        fireInputChange(input);
        scCloseSuggest(dimSuggestOf(input)); // after, for the same reason as the click path
      }
    });
  }
  /** Fetch (once per metric+dimension+scope) and populate every dim control on
   *  the panel. Cheap and idempotent once cached, so it's safe to call from the
   *  panel's change handler as well as after a render. */
  async function refreshDimOptions(panel) {
    if (!panel) return;
    var els = Array.prototype.slice.call(panel.querySelectorAll(".tgl-dim[data-dim]"));
    if (!els.length) return;
    wireDimCombo(panel); // every panel that renders dim controls comes through here
    var need = {};
    els.forEach(function (el) {
      var d = el.getAttribute("data-dim");
      if (!DIM_PICKERS[d]) return;
      var metric = dimMetricOf(el);
      if (!metric) return;
      var narrow = awDimNarrow(d, dimFilterOfRow(el.closest(".scr-row")));
      var key = dimKeyFor(metric, d, narrow);
      if (!_dimValues[key]) need[key] = { metric: metric, dimension: d, narrow: narrow };
    });
    var keys = Object.keys(need);
    keys.forEach(function (k) { _dimValues[k] = { loading: true }; });
    els.forEach(applyDimOptions); // paints the "checking…" note
    if (keys.length) {
      await Promise.all(keys.map(async function (k) {
        try {
          _dimValues[k] = await api.automations.dimensionValues({
            metric: need[k].metric, dimension: need[k].dimension, scope: draft.scope || {}, narrow: need[k].narrow,
          });
        } catch (_e) {
          // Never block authoring on the picker — the control stays usable with
          // whatever the operator types / already had selected.
          _dimValues[k] = { error: true };
        }
      }));
      els.forEach(applyDimOptions);
    }
  }
  function tgLeafRowHtml(leaf, kind) {
    leaf = leaf || tgDefaultLeaf(kind);
    // A FILTER row: "<what> matches <value>". The value control is the same
    // picker combobox a dimension input gets (same .tgl-dim classes, so the
    // combobox / cue / note machinery applies unchanged); the fixed "matches"
    // is honest — the stored dimensionFilter is a positive pattern, there is
    // no negative to offer.
    if (leaf.type === "asset_filter") {
      var fdf = {}; fdf[leaf.dim] = leaf.value || "";
      return '<div class="scr-row" data-filter-row="1" style="margin:4px 0;padding:4px;border:1px dashed var(--color-border);border-radius:6px">' +
        '<div style="display:flex;gap:6px;align-items:center">' +
          '<span class="aw-grip" draggable="true" title="Drag to move">&#x2842;</span>' +
          '<select class="tgl-what" style="flex:0 1 220px;min-width:0">' + tgWhatOptions(kind, "d:" + leaf.dim) + '</select>' +
          '<span style="font-size:0.85rem;white-space:nowrap">matches</span>' +
          dimControlHtml(leaf.dim, fdf, (TG_FILTER_META[leaf.dim] || {}).rep || "") +
          '<button type="button" class="btn btn-sm btn-danger scr-remove" title="Remove filter">&times;</button>' +
        '</div>' +
        '<div class="tgl-line2" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:4px 0 0 22px;font-size:0.8rem;color:var(--color-text-tertiary)">' +
          '<span class="tgl-dim-note" style="flex-basis:100%;font-size:0.78rem"></span>' +
        '</div>' +
      '</div>';
    }
    var isState = leaf.type === "asset_state";
    // A 0/1 state metric: equality only, and the value is a state name.
    var isFlag = !isState && isBooleanMetric(leaf.metric);
    var what = isState ? "f:" + leaf.field : "m:" + leaf.metric;
    // Unit chip sits beside the threshold value it qualifies (read-only —
    // never part of the input). hwSensorValue resolves it from the typed
    // sensor class; "sensor unit" is the unresolved placeholder.
    var unit = "";
    if (!isState && !isFlag) {
      unit = leafUnit(leaf.metric, leaf.dimensionFilter || {});
      if (!unit && metricUnit(leaf.metric) === "(sensor unit)") unit = "sensor unit";
    }
    var valueControl;
    if (isState) valueControl = tgStateValueControl(leaf.field, leaf.value);
    else if (isFlag) valueControl = tgStateFlagControl(leaf);
    else {
      valueControl = '<input type="number" step="any" class="tgl-threshold" value="' + (leaf.threshold != null && !isNaN(leaf.threshold) ? leaf.threshold : "") + '" placeholder="value" style="width:110px">' +
        (unit ? '<span class="tgl-unit" style="font-size:0.8rem;color:var(--color-text-tertiary);white-space:nowrap">' + escapeHtml(unit) + '</span>' : "");
    }
    // The missed-poll count rides the same row as the condition it qualifies.
    // Deliberately NOT a separate block below the tree: with two or more
    // conditions there would be no way to tell which leaf it modified, which is
    // the exact failure mode the "Sustained for" field's own history is about.
    var ddControls = "";
    var ddMeta = downDetectionMeta();
    if (isState && ddMeta && isDownDetectionLeaf(leaf)) {
      ddControls =
        '<span class="tgl-dd-word" style="font-size:0.85rem;white-space:nowrap;color:var(--color-text-secondary)">after</span>' +
        '<input type="number" class="tgl-misses" min="' + ddMeta.min + '" max="' + ddMeta.max + '"' +
          ' value="' + missedPollsOf(leaf) + '" style="width:72px"' +
          ' title="' + escapeHtml(ddMeta.help || "") + '">' +
        '<span class="tgl-dd-word" style="font-size:0.85rem;white-space:nowrap;color:var(--color-text-secondary)">missed poll(s)</span>';
    }
    // A monitorStatus value is one of six names — an ordered comparator over it
    // is meaningless ("status >= down"), and allowing one would also let a rule
    // look like a down-detection automation without being one.
    var enumState = isState && s.fieldMeta && s.fieldMeta[leaf.field] && s.fieldMeta[leaf.field].kind === "enum";
    var line1 =
      '<div style="display:flex;gap:6px;align-items:center">' +
        '<span class="aw-grip" draggable="true" title="Drag to move">&#x2842;</span>' +
        '<select class="tgl-what" style="flex:1;min-width:0">' + tgWhatOptions(kind, what) + '</select>' +
        // Ordered comparators can't apply to a flag, so the operator select
        // offers only is / is-not rather than letting an operator write ">= 1".
        '<select class="tgl-op" style="width:64px">' + opt(isFlag || enumState ? ["==", "!="] : s.comparators, leaf.operator || (isState || isFlag ? "==" : ">=")) + '</select>' +
        valueControl +
        ddControls +
        '<button type="button" class="btn btn-sm btn-danger scr-remove" title="Remove condition">&times;</button>' +
      '</div>';
    var line2 = "";
    var ratio = !isState && !!leaf && isWindowedRatioMetric(leaf.metric);
    if (isState) {
      // State leaves take dimension filters too (fieldDimensions — interface
      // for the ifOper/ifAdmin/poe trio, tunnel for ipsecStatus): same controls
      // and pickers as a metric leaf, minus the aggregation select a
      // current-state comparison has no use for. With filter rows available,
      // the liftable dims render inline only as UNLIFTED LEFTOVERS (a stored
      // value tgFilterLift couldn't raise into a row) — see tgInlineDims.
      var fDims = kind === "host" ? [] : tgInlineDims((s.fieldDimensions && s.fieldDimensions[leaf.field]) || [], leaf.dimensionFilter);
      var isDD = ddMeta && isDownDetectionLeaf(leaf);
      if (fDims.length || isDD) {
        var fDf = leaf.dimensionFilter || {};
        line2 =
          '<div class="tgl-line2" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:4px 0 0 22px;font-size:0.8rem;color:var(--color-text-tertiary)">' +
            fDims.map(function (d) { return dimControlHtml(d, fDf, leaf.field); }).join("") +
            (fDims.some(function (d) { return DIM_PICKERS[d]; }) ? '<span class="tgl-dim-note" style="flex-basis:100%;font-size:0.78rem"></span>' : "") +
            // Both painted asynchronously (syncDownDetection) and rendered
            // rather than omitted, so there is somewhere to paint into: the
            // derived time-to-down depends on the scoped devices' poll
            // intervals, and the coverage line on the carve-out preview.
            (isDD ? '<span class="tgl-dd-multi" style="flex-basis:100%;font-size:0.78rem;display:none"></span>' : "") +
            (isDD ? '<span class="tgl-dd-derived" style="flex-basis:100%;font-size:0.78rem"></span>' : "") +
            (isDD ? '<span class="tgl-dd-coverage" style="flex-basis:100%;font-size:0.78rem"></span>' : "") +
          '</div>';
      }
    }
    if (!isState) {
      var dims = kind === "host" ? [] : tgInlineDims((s.metricDimensions && s.metricDimensions[leaf.metric]) || [], leaf.dimensionFilter);
      var df = leaf.dimensionFilter || {};
      var dimInputs = dims.map(function (d) { return dimControlHtml(d, df, leaf.metric); }).join("");
      // Averaging a flag would produce a duty cycle rather than a state, so a
      // flag's aggregation is limited to the three that mean something, worded as
      // what they actually ask of the window.
      var aggControl = isFlag
        // These read as complete phrases now that no window box follows them —
        // the period itself is the poll-counted duration field below.
        ? '<select class="tgl-agg" style="width:auto;font-size:0.8rem">' + optLabeled(["latest", "max", "min"], leaf.aggregation || "latest", function (v) {
            return v === "latest" ? "current state" : v === "max" ? "at any point in the period" : "throughout the period";
          }) + '</select>'
        : '<select class="tgl-agg" style="width:auto;font-size:0.8rem">' + opt(s.aggregations, leaf.aggregation || "latest") + '</select>';
      // A windowed ratio has nothing to aggregate — it's already a percentage
      // over the window. The select stays in the DOM (collectors read .tgl-agg)
      // but hidden, replaced by a phrase naming what the window actually does.
      if (ratio) {
        aggControl = '<select class="tgl-agg" data-ratio="1" style="display:none">' + opt(s.aggregations, "latest") + '</select>' +
          '<span style="font-size:0.8rem">over the History window below, counting from the first successful probe</span>';
      }
      // No per-condition window input: an aggregation's measurement period IS
      // the poll-counted duration field below the tree (see tgStampWindows).
      // Two time boxes meaning almost the same thing is what this removes.
      line2 =
        '<div class="tgl-line2" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:4px 0 0 22px;font-size:0.8rem;color:var(--color-text-tertiary)">' +
          aggControl +
          dimInputs +
          (dims.some(function (d) { return DIM_PICKERS[d]; }) ? '<span class="tgl-dim-note" style="flex-basis:100%;font-size:0.78rem"></span>' : "") +
        '</div>';
    }
    return '<div class="scr-row"' + (ratio ? ' data-ratio="1"' : "") + ' style="margin:4px 0;padding:4px;border:1px solid var(--color-border);border-radius:6px">' + line1 + line2 + '</div>';
  }
  function tgGroupHtml(group, depth, kind) {
    group = group || { op: "and", children: [] };
    var inner = (group.children || []).map(function (c) {
      return c && c.type === undefined && Array.isArray(c.children)
        ? tgGroupHtml(c, depth + 1, kind)
        : tgLeafRowHtml(c, kind);
    }).join("");
    return '<div class="scg-group" data-depth="' + depth + '" style="border:1px solid var(--color-border);border-left:3px solid ' + (depth === 0 ? "var(--color-accent)" : "var(--color-success)") + ';border-radius:6px;padding:0.55rem;margin:4px 0">' +
      '<div style="display:flex;gap:6px;align-items:center;margin-bottom:2px">' +
        (depth > 0 ? '<span class="aw-grip" draggable="true" title="Drag to move group">&#x2842;</span>' : "") +
        '<select class="scg-op" style="flex:1;font-size:0.85rem">' + tgGroupOpOptions(group.op || "and") + '</select>' +
        (depth > 0 ? '<button type="button" class="btn btn-sm btn-danger scg-remove" title="Remove group">&times;</button>' : "") +
      '</div>' +
      '<div class="scg-children">' + inner + '</div>' +
      '<div style="margin-top:4px">' +
        '<button type="button" class="btn btn-sm btn-secondary scg-add-rule">+ Condition</button> ' +
        (depth + 1 < (tgMeta.maxDepth || 3) ? '<button type="button" class="btn btn-sm btn-secondary scg-add-group">+ Group</button>' : "") +
      '</div>' +
    '</div>';
  }
  function tgCollectLeaf(rowEl, kind) {
    var what = rowEl.querySelector(".tgl-what").value;
    if (what.indexOf("d:") === 0) {
      var fEl = rowEl.querySelector(".tgl-dim");
      return { type: "asset_filter", dim: what.slice(2), value: fEl ? fEl.value.trim() : "" };
    }
    var op = rowEl.querySelector(".tgl-op").value;
    if (what.indexOf("f:") === 0) {
      var vEl = rowEl.querySelector(".tgl-value");
      var sLeaf = { type: "asset_state", field: what.slice(2), operator: op, value: vEl ? vEl.value : "" };
      var sDf = {};
      rowEl.querySelectorAll(".tgl-dim").forEach(function (el) { var v = el.value.trim(); if (v) sDf[el.getAttribute("data-dim")] = v; });
      if (Object.keys(sDf).length) sLeaf.dimensionFilter = sDf;
      // Only stamped when the control is actually present, so a non-down leaf
      // can never carry a stray count into the payload (the server rejects it).
      var mEl = rowEl.querySelector(".tgl-misses");
      if (mEl && String(mEl.value).trim() !== "") sLeaf.missedPolls = Number(mEl.value);
      return sLeaf;
    }
    var leaf = {
      type: kind === "host" ? "host_metric" : "asset_metric",
      metric: what.slice(2),
      aggregation: (rowEl.querySelector(".tgl-agg") || { value: "latest" }).value || "latest",
      // Stamped by tgStampWindows from the tree's duration field — the row
      // carries no window control of its own.
      windowSec: 0,
      operator: op,
      threshold: Number(rowEl.querySelector(".tgl-threshold").value),
    };
    if (kind !== "host") {
      var df = {};
      rowEl.querySelectorAll(".tgl-dim").forEach(function (el) { var v = el.value.trim(); if (v) df[el.getAttribute("data-dim")] = v; });
      if (Object.keys(df).length) leaf.dimensionFilter = df;
    }
    return leaf;
  }
  function tgCollectGroup(groupEl, kind) {
    var op = groupEl.querySelector(":scope > div > .scg-op").value;
    var children = [];
    groupEl.querySelectorAll(":scope > .scg-children > *").forEach(function (el) {
      if (el.classList.contains("scr-row")) children.push(tgCollectLeaf(el, kind));
      else if (el.classList.contains("scg-group")) children.push(tgCollectGroup(el, kind));
    });
    return { op: op, children: children };
  }
  /** Delegated wiring for a trigger-style condition tree (Step 3 + the Step-4
   *  reset builder). Added ONCE per panel (guard flag) — renders may replace
   *  the inner HTML freely. kindFn is read at event time (device↔host swaps). */
  function wireTgTree(panel, rootSelector, kindFn, onChange) {
    if (panel._tgWired) return;
    panel._tgWired = true;
    panel.addEventListener("click", function (e) {
      var btn = e.target.closest && e.target.closest("button");
      if (!btn) return;
      var root = panel.querySelector(rootSelector);
      if (!root || !root.contains(btn)) return;
      if (btn.classList.contains("scr-remove")) {
        btn.closest(".scr-row").remove();
        onChange();
      } else if (btn.classList.contains("scg-remove")) {
        btn.closest(".scg-group").remove();
        onChange();
      } else if (btn.classList.contains("scg-add-rule")) {
        btn.closest(".scg-group").querySelector(":scope > .scg-children")
          .insertAdjacentHTML("beforeend", tgLeafRowHtml(null, kindFn()));
        onChange();
      } else if (btn.classList.contains("scg-add-group")) {
        var g = btn.closest(".scg-group");
        var depth = Number(g.getAttribute("data-depth")) + 1;
        if (depth >= (tgMeta.maxDepth || 3)) { showToast("Groups nest at most " + (tgMeta.maxDepth || 3) + " levels", "info"); return; }
        g.querySelector(":scope > .scg-children")
          .insertAdjacentHTML("beforeend", tgGroupHtml({ op: "or", children: [tgDefaultLeaf(kindFn())] }, depth, kindFn()));
        onChange();
      }
    });
    // Live unit hint: typing a sensor class into the hwSensorValue dimension
    // filter swaps the row's unit chip (°C / RPM / V …) as the class resolves.
    panel.addEventListener("input", function (e) {
      var t = e.target;
      if (!t || !t.classList || !t.classList.contains("tgl-dim") || t.getAttribute("data-dim") !== "sensorClass") return;
      var root = panel.querySelector(rootSelector);
      if (!root || !root.contains(t)) return;
      var row = t.closest(".scr-row");
      var span = row && row.querySelector(".tgl-unit");
      if (!span) return;
      var metric = String(row.querySelector(".tgl-what").value || "").slice(2);
      span.textContent = leafUnit(metric, { sensorClass: t.value }) || "sensor unit";
    });
    panel.addEventListener("change", function (e) {
      var t = e.target;
      if (!t || !t.classList) return;
      var root = panel.querySelector(rootSelector);
      if (!root || !root.contains(t)) return;
      if (t.classList.contains("tgl-what")) {
        // What changed: re-render the row with the new leaf's default fields.
        var row = t.closest(".scr-row");
        var what = t.value;
        var metric = what.slice(2);
        var leaf;
        if (what.indexOf("d:") === 0) {
          leaf = { type: "asset_filter", dim: metric, value: "" };
        } else if (what.indexOf("f:") === 0) {
          leaf = { type: "asset_state", field: metric, operator: "==", value: "" };
        } else if (isBooleanMetric(metric)) {
          // A flag defaults to "is <the interesting state>" — an ordered
          // comparator and an empty threshold would be invalid here.
          leaf = { type: "asset_metric", metric: metric, aggregation: "latest", windowSec: 0, operator: "==", threshold: null };
        } else {
          leaf = { type: kindFn() === "host" ? "host_metric" : "asset_metric", metric: metric, aggregation: "latest", windowSec: 0, operator: ">=", threshold: null };
        }
        row.outerHTML = tgLeafRowHtml(leaf, kindFn());
      } else if (t.classList.contains("tgl-dim") && t.getAttribute("data-dim") === "stateProbeId") {
        // The value control shows the CHOSEN probe's labels ("Alarm" / "OK"), so
        // picking a different probe has to relabel it — otherwise the row would
        // read with the previous probe's words. Re-rendered from the row's own
        // collected leaf so nothing else typed on it is lost; the panel-level
        // change handler re-applies the loaded dimension option lists after this.
        var prow = t.closest(".scr-row");
        if (prow) prow.outerHTML = tgLeafRowHtml(tgCollectLeaf(prow, kindFn()), kindFn());
      } else if (t.classList.contains("tgl-value")) {
        // The missed-poll control exists only for the down-detection value, so
        // picking "Down" has to re-render the row to reveal it (and picking
        // anything else to hide it) — same reason changing the state probe
        // relabels its value control above. Scoped to monitorStatus rows so an
        // unrelated enum row doesn't churn on every selection.
        var vrow = t.closest(".scr-row");
        var vwhat = vrow && vrow.querySelector(".tgl-what");
        if (vrow && vwhat && vwhat.value === "f:monitorStatus") {
          vrow.outerHTML = tgLeafRowHtml(tgCollectLeaf(vrow, kindFn()), kindFn());
        }
      }
      onChange();
    });
    CB.wireDnD(panel, rootSelector, onChange, tgMeta.maxDepth || 3);
  }

  /**
   * Every hold and window on the trigger and reset steps is counted in POLLS,
   * not minutes (2026-08-28). A threshold can only be tested when a reading
   * arrives, so "sustained for 3" has always meant three readings — minutes
   * were a wall-clock spelling of that, and one that meant a different number
   * of readings on a device polled every 5 minutes than on one polled every 30
   * seconds. What is STORED is unchanged (seconds), so each field carries its
   * seconds on `data-sec` and shows the poll count that value works out to at
   * the cadence the matched devices actually use (awCadence, below). Editing the
   * count rewrites data-sec; a cadence arriving later repaints the count and
   * leaves the stored seconds alone, so an async answer can never silently
   * change what a loaded automation would save.
   *
   * The hold is ONE field for the whole trigger — the per-severity-tier hold
   * was removed with the same change. Rule 19 still lets a tier carry its own
   * `forDurationSec` and the engine still honours one on an API-authored rule;
   * the builder simply stops writing them, so every tier inherits the base
   * (which is what resolveTierLadder already does for a band with none).
   */
  var DUR_PLACEHOLDER_OPTIONAL = "0 = fire as soon as the value reaches this level";
  // Default History for a windowed-ratio trigger, and the floor the engine
  // enforces on it. Mirrors PROBE_LOSS_DEFAULT/MIN_WINDOW_SEC server-side —
  // both in SECONDS here, because the floor is the engine's and doesn't move
  // with the cadence the field is counted in.
  var RATIO_WINDOW_DEFAULT_SEC = 900;
  var RATIO_WINDOW_MIN_SEC = 300;
  var RATIO_WINDOW_MAX_SEC = 86400;
  /** Cadence when the server hasn't answered (yet, or at all). Every note that
   *  falls back to it SAYS so rather than presenting it as this fleet's. */
  var CADENCE_FALLBACK_SEC = 60;

  function pollsFromSec(sec, intervalSec) {
    var iv = intervalSec > 0 ? intervalSec : CADENCE_FALLBACK_SEC;
    var n = Math.round((Number(sec) || 0) / iv);
    return n > 0 ? n : 0;
  }
  function secFromPolls(polls, intervalSec) {
    var iv = intervalSec > 0 ? intervalSec : CADENCE_FALLBACK_SEC;
    var n = Math.round(Number(polls) || 0);
    return n > 0 ? n * iv : 0;
  }
  /**
   * One poll-counted field. `attr` carries the id/class the caller identifies it
   * by; `sec` is the STORED value it round-trips. `zeroNote` is what the caption
   * says at 0, where there is no duration to convert.
   */
  function pollFieldHtml(attr, sec, opts) {
    opts = opts || {};
    var iv = awCadence().sec;
    // A stored COUNT wins over the seconds mirror: `forPolls` is what the rule
    // actually states (the engine counts readings), so a rule authored at a
    // 60s cadence still reads "3 polls" on a fleet that now polls every 5
    // minutes, instead of being re-divided into 1. Only a rule that predates
    // the count falls back to dividing its seconds.
    var shown = opts.polls != null ? Math.max(0, Math.round(opts.polls)) : pollsFromSec(sec, iv);
    // WHICH HALF IS THE TRUTH. For a hold the COUNT is (the engine counts
    // readings — `forPolls`), so a cadence arriving later leaves the count
    // alone and re-derives the seconds mirror. For a windowed ratio's History
    // the SECONDS are (`windowSec` is the measurement — business rule 29c), so
    // the cadence repaints the count instead. Getting this backwards is how an
    // async cadence answer silently halved a stored hold.
    // A ratio's History is LOCKED to seconds; every other field starts
    // seconds-authoritative only while its count is a derivation (a legacy rule
    // being read at whatever cadence was known when it rendered) and becomes
    // count-authoritative the moment the rule states a count or the operator
    // types one.
    var lock = opts.authority === "sec" ? "sec" : "";
    var authority = lock || (opts.polls != null ? "polls" : "sec");
    return '<div class="form-group ' + (opts.wrapClass || "aw-dur") + '"' +
        (opts.hidden ? ' style="margin:0.5rem 0 0;display:none"' : ' style="margin:0.5rem 0 0"') + '>' +
      '<label style="font-size:0.8rem">' + escapeHtml(opts.label || "Sustained for (polls)") +
        '<span class="aw-dur-req" style="display:none;color:var(--color-danger);font-weight:700;margin-left:2px">*</span></label>' +
      '<input type="number" ' + attr + ' class="aw-poll-input" data-authority="' + authority + '"' +
        (lock ? ' data-authority-lock="sec"' : "") + ' data-sec="' + (Number(sec) || 0) + '" min="0" ' +
        'value="' + shown + '" placeholder="' + escapeHtml(opts.placeholder || DUR_PLACEHOLDER_OPTIONAL) + '">' +
      '<p class="aw-poll-note" style="margin:2px 0 0;font-size:0.78rem;color:var(--color-text-tertiary)"></p>' +
      '<p class="aw-dur-note" style="display:none;margin:2px 0 0;font-size:0.78rem;color:var(--color-text-tertiary)"></p></div>';
  }
  function durationFieldHtml(attr, sec, polls, authority) {
    // The asterisk is hidden until an aggregated condition makes the field
    // mandatory (syncDurationRequirement) — avg / median / min / max have no
    // period to measure over without it.
    return pollFieldHtml(attr, sec, { label: "Sustained for (polls)", polls: polls, authority: authority });
  }
  /**
   * The SECOND time field a windowed-ratio trigger gets (2026-08-20): the base
   * field above it is the History window (the measurement itself), this is the
   * optional hold — the ratio must stay over the threshold for this many polls
   * before the alert fires. Rendered for every device/host trigger but hidden
   * unless a ratio condition is present (syncDurationRequirement toggles it
   * live), the same rendered-not-omitted pattern the base field takes.
   */
  function ratioSustainFieldHtml(tr) {
    return pollFieldHtml('id="tf-sustain-min"', triggerSustainSec(tr), {
      wrapClass: "aw-ratio-sustain",
      hidden: !triggerIsWindowedRatio(tr),
      label: "Sustained for (polls)",
      polls: triggerIsWindowedRatio(tr) && triggerSustainSec(tr) > 0 ? storedHoldPolls(tr) : null,
    }).replace(
      '<p class="aw-dur-note"',
      '<p style="margin:2px 0 0;font-size:0.78rem;color:var(--color-text-tertiary)">Optional — how long the loss must stay over the threshold before the alert fires. Each reading still measures over the History window above.</p><p class="aw-dur-note"',
    );
  }

  /**
   * The THIRD ratio-only field (2026-09-01): the saturation ceiling. At or above
   * it the reading is dropped and any live alert on that device clears.
   *
   * It exists because the loss measurement stopped trimming outages out of its
   * own window (business rule 29). A device back from a 55-minute outage now
   * genuinely reads ~92% for the rest of the window, and this is the control
   * that decides whether that deserves an alert. Prefilled from the server's
   * `readingCeilingDefault` (100 — suppressing only a total outage, so every
   * pre-existing rule is unchanged); an operator who does not want an alert
   * trailing every outage lowers it.
   *
   * Rendered for every device/host trigger but hidden unless a ratio condition
   * is present, the same rendered-not-omitted pattern as the sustain field, so
   * syncDurationRequirement can toggle it live as the metric changes.
   */
  function ratioCeilingFieldHtml(tr) {
    var ratio = triggerIsWindowedRatio(tr);
    var stored = tr && typeof tr.ignoreAtOrAbove === "number" ? tr.ignoreAtOrAbove : null;
    var val = stored === null ? "" : String(stored);
    return '<div class="form-group aw-ratio-ceiling"' + (ratio ? "" : ' style="display:none"') + '>' +
      '<label>Ignore readings at or above (%)</label>' +
      '<input type="number" id="tf-ratio-ceiling" min="0" max="100" step="1" value="' + escapeHtml(val) + '" placeholder="' + ratioCeilingDefault() + '">' +
      '<p style="margin:2px 0 0;font-size:0.78rem;color:var(--color-text-tertiary)">' +
      'At or above this the reading is treated as an outage rather than packet loss: no alert fires, and any alert this automation already raised on that device clears. ' +
      'The default of 100% ignores only a total outage. A device that has just come back from a long one still reads close to 100% for the rest of the History window, so lower this to stop an alert trailing every outage.</p>' +
      '</div>';
  }
  /** The server publishes the default so the two cannot drift. */
  function ratioCeilingDefault() {
    var n = s.readingCeilingDefault;
    return typeof n === "number" ? n : 100;
  }

  // ── Poll cadence ──────────────────────────────────────────────────────────
  // How often the draft's OWN devices take the reading it watches — the number
  // every poll-counted field converts through, from POST /automations/poll-cadence.
  // Cached per (metric, scope) the _dimValues way: the cadence is NOT one number
  // for a fleet (it resolves per asset through the monitor-settings hierarchy),
  // so the honest answer comes from the server and the caption says which number
  // it is showing — and how wide the spread behind it is.
  var _awCadence = null;            // { key, data } | null
  var _awCadencePending = "";       // key currently in flight

  /** The Polaris host samples itself on a fixed 30s tick (hostMetricsCollector). */
  var HOST_METRIC_INTERVAL_SEC = 30;
  var CADENCE_STREAM_NOUN = {
    responseTime: "status-probe",
    cpuMemory: "CPU/memory",
    temperature: "hardware-sensor",
    systemInfo: "interface/system",
    storage: "storage",
  };

  /** The metric whose cadence the poll fields are counted in: the first metric
   *  leaf of the trigger. A multi-condition trigger holds ONE clock over the
   *  whole tree, so it is counted in the first condition's cadence and the
   *  caption names which. */
  function cadenceMetricOf(tr) {
    if (!tr) return "";
    var leaves = tr.type === "composite" ? (tgLeaves(tr) || []) : [tr];
    for (var i = 0; i < leaves.length; i++) {
      var l = leaves[i];
      if (!l) continue;
      if (l.type === "asset_state") { if (l.field) return l.field; continue; }
      if (l.metric) return l.metric;
    }
    return "";
  }
  function cadenceKeyFor(tr) {
    return (tr && tr.type === "host_metric" ? "host" : cadenceMetricOf(tr)) + "|" +
      JSON.stringify(draft.scope || {});
  }
  /**
   * What the fields convert at right now: `sec` is always usable (falling back
   * to 60 with `known:false` so a caption can admit it), `min`/`max` bound the
   * spread, `stream` names which collector's cadence it is.
   */
  function awCadence() {
    var tr = draft.trigger || {};
    if (tr.type === "host_metric" || tr.kind === "host") {
      return { sec: HOST_METRIC_INTERVAL_SEC, known: true, min: HOST_METRIC_INTERVAL_SEC, max: HOST_METRIC_INTERVAL_SEC, host: true, stream: "", assetCount: 0 };
    }
    var d = _awCadence && _awCadence.key === cadenceKeyFor(tr) ? _awCadence.data : null;
    if (d && d.mode > 0) {
      return { sec: d.mode, known: true, min: d.min || d.mode, max: d.max || d.mode, host: false, stream: d.stream || "", assetCount: d.assetCount || 0, timeoutMs: d.timeoutMs || 0 };
    }
    return { sec: CADENCE_FALLBACK_SEC, known: false, min: 0, max: 0, host: false, stream: (d && d.stream) || "", assetCount: (d && d.assetCount) || 0 };
  }
  /** "≈ 5 min at the 60s CPU/memory poll interval these devices use." */
  function cadenceNoteFor(polls) {
    var c = awCadence();
    var n = Math.max(0, Math.round(Number(polls) || 0));
    // At 0 there is no duration to convert, and every field that accepts 0
    // already says what 0 means in its own words (placeholder / inline text).
    if (n === 0) return "";
    // Formatted here rather than through PolarisMonitorDownAfter.human: this
    // caption is the wizard's own and must read "10m" even where that shared
    // file hasn't loaded (the down-detection caption below still uses it — that
    // arithmetic is genuinely shared with the asset surfaces). The formatter in
    // the sentences factory is out of scope from here, hence the local one.
    var total = n * c.sec;
    var human = total % 3600 === 0 ? (total / 3600) + "h" : total % 60 === 0 ? (total / 60) + "m" : total + "s";
    var head = n + " poll" + (n === 1 ? "" : "s") + " ≈ " + human;
    if (c.host) return head + " — the Polaris host samples itself every " + c.sec + "s.";
    var noun = CADENCE_STREAM_NOUN[c.stream] ? CADENCE_STREAM_NOUN[c.stream] + " poll" : "poll";
    if (!c.known) {
      return head + " at an assumed " + c.sec + "s interval — this fleet’s actual cadence was unavailable.";
    }
    var out = head + " at the " + c.sec + "s " + noun + " interval these devices use";
    if (c.max > c.min) out += " (range across the matched devices: " + c.min + "s to " + c.max + "s)";
    return out + ".";
  }
  /** Repaint every poll field's caption, and — when the cadence itself moved —
   *  the counts, from the seconds each field is holding. Never touches a field
   *  the operator is typing in. */
  function syncPollFields(panel, cadenceChanged) {
    if (!panel) return;
    var iv = awCadence().sec;
    Array.prototype.forEach.call(panel.querySelectorAll(".aw-poll-input"), function (input) {
      if (cadenceChanged && input !== document.activeElement) {
        if (input.getAttribute("data-authority") === "sec") {
          input.value = pollsFromSec(input.getAttribute("data-sec"), iv);
        } else {
          // The count stands; its wall-clock mirror follows the new cadence.
          input.setAttribute("data-sec", String(secFromPolls(input.value, iv)));
        }
      }
      var note = input.parentNode && input.parentNode.querySelector(".aw-poll-note");
      if (note) {
        var wrap = input.parentNode;
        note.style.display = wrap && wrap.style && wrap.style.display === "none" ? "none" : "";
        note.textContent = cadenceNoteFor(input.value);
      }
    });
    syncBandDurationMirrors(panel);
  }
  /** The COUNT a poll field states — what the engine counts, and what
   *  collection stores as `forPolls` / `sustainPolls`. */
  function pollFieldCount(input) {
    if (!input || input.value === "") return 0;
    var n = Math.round(Number(input.value) || 0);
    return n > 0 ? n : 0;
  }
  /**
   * Seconds a poll field stands for — the count's wall-clock MIRROR. The stored value
   * wins while the count on screen still represents it (so loading 300s at a
   * 45s cadence and saving without touching the field can't drift it to 315),
   * and the COUNT wins the moment the two disagree — which is what makes a
   * value set any way other than typing (a repaint, a test, a future caller)
   * mean what it appears to mean.
   */
  function pollFieldSec(input) {
    if (!input) return 0;
    if (input.value === "") return 0;
    var iv = awCadence().sec;
    var stored = Number(input.getAttribute("data-sec"));
    var shown = Math.round(Number(input.value) || 0);
    if (!isNaN(stored) && stored >= 0 && pollsFromSec(stored, iv) === shown) return Math.round(stored);
    return secFromPolls(shown, iv);
  }
  function setPollFieldSec(input, sec) {
    if (!input) return;
    input.setAttribute("data-sec", String(Math.max(0, Math.round(Number(sec) || 0))));
    if (input !== document.activeElement) input.value = pollsFromSec(sec, awCadence().sec);
  }
  /** An edit to the count IS the value: rewrite the seconds it stands for. */
  function wirePollFields(panel) {
    if (!panel || panel._awPollWired) return;
    panel._awPollWired = true;
    panel.addEventListener("input", function (e) {
      var t = e.target;
      if (!t || !t.classList || !t.classList.contains("aw-poll-input")) return;
      t.setAttribute("data-sec", String(secFromPolls(t.value, awCadence().sec)));
      // A typed count is a STATED count: from here the number stands and the
      // seconds follow it (unless this field is locked to seconds — a ratio's
      // History window is a measurement, not a count).
      if (t.getAttribute("data-authority-lock") !== "sec") t.setAttribute("data-authority", "polls");
      syncPollFields(panel, false);
    });
  }
  /**
   * Fetch the cadence for the current (metric, scope) when it isn't already
   * cached, then repaint. Never blocks authoring: a failed lookup leaves the
   * fields converting at the fallback and saying so.
   */
  async function refreshCadence(panel) {
    var tr = draft.trigger || {};
    if (tr.type === "host_metric" || tr.kind === "host") { syncPollFields(panel, true); return; }
    var key = cadenceKeyFor(tr);
    if ((_awCadence && _awCadence.key === key) || _awCadencePending === key) { syncPollFields(panel, false); return; }
    _awCadencePending = key;
    var metric = cadenceMetricOf(tr);
    try {
      var data = await api.automations.pollCadence({ metric: metric || undefined, scope: draft.scope || {} });
      _awCadence = { key: key, data: data };
    } catch (_e) {
      _awCadence = { key: key, data: { mode: 0, min: 0, max: 0, timeoutMs: 0, assetCount: 0, stream: "" } };
    } finally {
      if (_awCadencePending === key) _awCadencePending = "";
    }
    var live = document.getElementById("aw-step-3");
    syncPollFields(panel, true);
    if (live && live !== panel) syncPollFields(live, true);
    syncDownDetection(live || panel);
    // A repaint can move what the fields SAY (a legacy rule's seconds convert at
    // the real cadence rather than the assumed one), and the sentence + formula
    // are rendered from the collected draft — so re-collect, or the prose would
    // keep describing the count the fallback cadence produced.
    if (live) refreshTriggerSentence();
    if (document.getElementById("aw-step-4")) refreshResetSentence();
  }
  /**
   * Show/hide the duration field's red asterisk + note for the BASE tree: with
   * an aggregated condition the field supplies the measurement window, so it's
   * mandatory; with `latest` only it stays the optional sustain clock. Severity
   * tiers share the base's window, so their own duration field (a per-tier hold)
   * is never marked required.
   */
  // The devices a down-detection draft would govern, and how long its count
  // actually takes on them, read off the SAME cadence lookup the poll-counted
  // fields convert through (awCadence) — the poll interval is not one number
  // for a fleet, so the caption says which number it is showing and how wide
  // the spread behind it is. Before that lookup existed this caption had no
  // source at all and always fell back to "unavailable".

  /** Drop every missedPolls in a trigger tree (see the call site in collectStep3). */
  function stripMissedPolls(node) {
    if (!node) return;
    if (node.missedPolls != null) delete node.missedPolls;
    (node.children || []).forEach(stripMissedPolls);
  }
  function syncDownDetection(panel) {
    var rows = panel.querySelectorAll('.scr-row');
    // Down-detection authority lives on a BARE trigger only — the server
    // refuses a count inside a multi-condition trigger. So the control is
    // hidden the moment a second condition appears, with a note saying why,
    // rather than sitting there collecting a number nothing would honour.
    var multi = rows.length > 1;
    Array.prototype.forEach.call(rows, function (row) {
      var m = row.querySelector('.tgl-misses');
      if (!m) return;
      var show = !multi;
      m.style.display = show ? '' : 'none';
      Array.prototype.forEach.call(row.querySelectorAll('.tgl-dd-word'), function (el) {
        el.style.display = show ? '' : 'none';
      });
      var note = row.querySelector('.tgl-dd-multi');
      if (note) {
        note.style.display = show ? 'none' : '';
        note.textContent = 'Down detection needs this to be the only condition — the probe loop can only see whether the device answered. ' +
          'As one of several conditions this just reads the status column.';
      }
    });
    Array.prototype.forEach.call(rows, function (row) {
      var missEl = row.querySelector('.tgl-misses');
      var derived = row.querySelector('.tgl-dd-derived');
      if (!missEl || !derived) return;
      var n = Number(missEl.value) > 0 ? Math.round(Number(missEl.value)) : 3;
      var cad = awCadence();
      var calc = window.PolarisMonitorDownAfter && window.PolarisMonitorDownAfter.calc;
      if (!calc) { derived.textContent = ''; return; }
      var mode = cad.sec;
      var to   = cad.timeoutMs > 0 ? cad.timeoutMs : 5000;
      var c = calc(n, mode, to);
      var human = window.PolarisMonitorDownAfter.human(c.realSec);
      if (!cad.known) {
        // Say so rather than presenting a guessed interval as this fleet's.
        derived.textContent = '≈ ' + human + ' at a ' + mode + 's poll interval — this fleet’s actual intervals were unavailable.';
      } else if (cad.min === cad.max) {
        derived.textContent = '≈ ' + human + ' at the ' + mode + 's poll interval these devices use.';
      } else {
        var lo = window.PolarisMonitorDownAfter.human(calc(n, cad.min, to).realSec);
        var hi = window.PolarisMonitorDownAfter.human(calc(n, cad.max, to).realSec);
        derived.textContent = '≈ ' + human + ' at the ' + mode + 's interval most of these devices use' +
          ' (range across the matched devices: ' + lo + ' to ' + hi + ').';
      }
    });
  }
  /**
   * "" unless the element folds away with a collapsed severity block. Every
   * show/hide of a field that lives INSIDE the base tier has to ask: the hold
   * is a collapse part now, so an unrelated edit repainting it would otherwise
   * re-open it inside a folded block.
   */
  function unfoldedDisplay(el) {
    if (!el || !el.classList || !el.classList.contains("aw-collapse-part")) return "";
    var grp = el.closest("[data-collapse-key]");
    var key = grp && grp.getAttribute("data-collapse-key");
    return key && _awCollapsed[key] ? "none" : "";
  }
  /**
   * Every severity tier waits out the ONE hold on the trigger (rule 19), so each
   * tier renders it read-only rather than leaving the operator to infer that the
   * number above the first tier governs all of them. Mirrors the trigger field's
   * LABEL too — a ratio's "History (polls)" and an aggregate's "Measured over
   * (polls)" are the same shared field wearing a different name — and hides
   * itself whenever the trigger states no hold or has no hold field at all
   * (an all-down-detection tree), where an empty box in every tier would read as
   * a field each tier was meant to fill in.
   */
  function syncBandDurationMirrors(panel) {
    if (!panel) return;
    var host = panel.querySelector("#aw-bands");
    if (!host) return;
    var rows = host.querySelectorAll(".aw-band-dur");
    if (!rows.length) return;
    var wrap = panel.querySelector("#tf-duration-min");
    wrap = wrap && wrap.closest(".aw-dur");
    var input = wrap && wrap.querySelector("#tf-duration-min");
    var labelEl = wrap && wrap.querySelector("label");
    // `data-hold-off`, not the wrap's display: inside the base tier the field is
    // also display:none while that block is folded, and a folded first tier must
    // not blank the hold out of the tiers below it.
    var hidden = !wrap || wrap.getAttribute("data-hold-off") === "1";
    var label = labelEl ? (labelEl.textContent || "").replace(/\*+\s*$/, "").trim() : "";
    var show = !hidden && !!input && pollFieldCount(input) > 0;
    Array.prototype.forEach.call(rows, function (mirror) {
      mirror.style.display = show ? "" : "none";
      if (!show) return;
      var lab = mirror.querySelector(".aw-band-dur-label");
      if (lab && label) lab.textContent = label;
      var box = mirror.querySelector(".aw-band-dur-input");
      if (box) box.value = input.value;
    });
  }
  function syncDurationRequirement(panel) {
    var wrap = panel.querySelector("#tf-duration-min");
    wrap = wrap && wrap.closest(".aw-dur");
    if (!wrap) { syncBandDurationMirrors(panel); return; }
    var root = panel.querySelector("#aw-trig-root");
    var aggs = root ? root.querySelectorAll(".scr-row .tgl-agg") : [];
    var aggregated = false;
    Array.prototype.forEach.call(aggs, function (el) { if (el.value && el.value !== "latest") aggregated = true; });
    // A tree made ENTIRELY of down-detection conditions already has a debounce:
    // the missed-poll count IS the hold. A second "Sustained for" on top would
    // be two clocks meaning almost the same thing, and would stack invisibly on
    // the wall-clock time to Down. A MIXED composite keeps the field, where it
    // legitimately applies to the whole tree.
    var ddRows = root ? root.querySelectorAll(".scr-row .tgl-misses") : [];
    var allRows = root ? root.querySelectorAll(".scr-row") : [];
    if (allRows.length && ddRows.length === allRows.length) {
      wrap.style.display = "none";
      wrap.setAttribute("data-hold-off", "1");
      syncBandDurationMirrors(panel);
      return;
    }
    wrap.removeAttribute("data-hold-off");
    wrap.style.display = unfoldedDisplay(wrap);
    var star = wrap.querySelector(".aw-dur-req");
    var note = wrap.querySelector(".aw-dur-note");
    var input = wrap.querySelector("#tf-duration-min");
    // A windowed-ratio condition (packet loss) relabels the field outright: it
    // is HISTORY, not a hold clock, and calling it "sustained for" is what let a
    // 60 here mean "measured over 15 minutes, held for 60".
    var ratio = !!(root && root.querySelector('.scr-row[data-ratio="1"]'));
    var cadSec = awCadence().sec;
    var minPolls = ratio ? Math.max(1, Math.ceil(RATIO_WINDOW_MIN_SEC / cadSec)) : 0;
    var maxPolls = ratio ? Math.max(minPolls, Math.floor(RATIO_WINDOW_MAX_SEC / cadSec)) : 0;
    var label = wrap.querySelector("label");
    if (label) {
      // The unit is polls in every mode — what changes is what the polls are
      // FOR: a measurement window for a ratio, a measurement period for an
      // aggregate, a hold clock for `latest`.
      label.innerHTML = (ratio ? "History (polls)" : aggregated ? "Measured over (polls)" : "Sustained for (polls)") +
        '<span class="aw-dur-req" style="' + (aggregated || ratio ? "" : "display:none;") + 'color:var(--color-danger);font-weight:700;margin-left:2px">*</span>';
      star = label.querySelector(".aw-dur-req");
    }
    if (star) star.style.display = aggregated || ratio ? "" : "none";
    if (note) {
      // One hold for the whole trigger: severity tiers no longer carry their
      // own, so this is what every tier waits out before it takes its severity.
      var tiersNote = multiSevOn(panel) && !ratio && !aggregated
        ? " Applies to every severity level."
        : "";
      note.style.display = aggregated || ratio || tiersNote ? "" : "none";
      note.textContent = ratio
        ? "Required — loss is failed probes / total probes over this many polls, counting from the device's first successful probe in the window. " +
          "A short window is more sensitive but coarser: over " + minPolls + " polls loss can only read in steps of " +
          Math.round(100 / minPolls) + "%."
        : aggregated ? "Required — this is the period the value is measured over." : tiersNote.trim();
    }
    if (input) {
      input.placeholder = ratio ? "e.g. " + Math.max(1, Math.round(RATIO_WINDOW_DEFAULT_SEC / cadSec)) : aggregated ? "e.g. 5" : DUR_PLACEHOLDER_OPTIONAL;
      input.setAttribute("min", ratio ? String(minPolls) : "0");
      if (ratio) input.setAttribute("max", String(maxPolls));
      else input.removeAttribute("max");
      if (aggregated || ratio) input.setAttribute("required", "required");
      else input.removeAttribute("required");
      // An empty field on a fresh loss automation lands on the default rather
      // than 0, which would save a window the engine has to invent. Set through
      // the seconds the field really holds, so the count and the stored value
      // can't disagree.
      if (ratio && (input.value === "" || Number(input.value) === 0)) setPollFieldSec(input, RATIO_WINDOW_DEFAULT_SEC);
      // The engine floors a loss window at 5 minutes whatever the cadence — a
      // count below that floor would save a window it silently widens.
      if (ratio && pollFieldSec(input) > 0 && pollFieldSec(input) < RATIO_WINDOW_MIN_SEC && input !== document.activeElement) {
        setPollFieldSec(input, minPolls * cadSec);
      }
    }
    // The ratio-only sustain field appears exactly when the History relabel
    // does — switching the metric to/from packet loss toggles both together.
    var ceilingWrap = panel.querySelector(".aw-ratio-ceiling");
    if (ceilingWrap) ceilingWrap.style.display = ratio ? "" : "none";
    var sustainWrap = panel.querySelector(".aw-ratio-sustain");
    if (sustainWrap) {
      if (ratio) sustainWrap.removeAttribute("data-hold-off");
      else sustainWrap.setAttribute("data-hold-off", "1");
      sustainWrap.style.display = ratio ? unfoldedDisplay(sustainWrap) : "none";
    }
    syncPollFields(panel, false);
  }
  function step3Html() {
    var cat = triggerCategoryOf(draft.trigger);
    var typeOpts = TRIGGER_CATEGORIES.map(function (t) {
      return '<option value="' + t.value + '"' + (t.value === cat ? " selected" : "") + '>' + escapeHtml(t.label) + '</option>';
    }).join("");
    var multi = !!(draft.severityBands && draft.severityBands.length);
    return '<h3 id="aw-step3-heading" style="margin:0 0 0.25rem">When should it fire?</h3>' +
      '<div class="aw-sentence" id="aw-trigger-sentence">…</div>' +
      // The same trigger as a formula — where the window sits versus where the
      // hold sits is what the sentence can't show at a glance.
      '<div class="aw-formula" id="aw-trigger-formula" style="display:none"></div>' +
      '<div class="form-group"><label><input type="checkbox" id="aw-multi-sev"' + (multi ? " checked" : "") + '> Use multiple severity levels (escalate severity as the value climbs)</label></div>' +
      '<div class="form-group" id="aw-single-sev-wrap"><label>Alert severity</label><select id="aw-trigger-severity" class="sev-select sev-' + escapeHtml(draft.severity || "warning") + '">' + sevOpt(draft.severity || "warning") + '</select></div>' +
      '<div class="form-group"><label>Trigger type</label><select id="aw-trigger-type">' + typeOpts + '</select></div>' +
      '<div id="aw-trigger-fields"></div>' +
      '<div id="aw-bands-host" style="display:none"></div>' +
      // The alert/event message template lives on the Actions step (inside the
      // mandatory in-app card) — the trigger step is conditions-only.
      '<div style="margin:0.5rem 0"><button type="button" class="btn btn-sm btn-secondary" id="aw-trigger-test">Test against current data</button></div>' +
      '<div id="aw-trigger-preview"></div>';
  }
  function renderTriggerFields() {
    var panel = document.getElementById("aw-step-3");
    var cat = panel.querySelector("#aw-trigger-type").value;
    var box = panel.querySelector("#aw-trigger-fields");
    var tr = draft.trigger || {};
    var html = "";
    if (cat === "device" || cat === "host") {
      var kind = cat === "host" ? "host" : "asset";
      var tree = triggerToTree(tr, kind);
      html += '<p style="font-size:0.82rem;color:var(--color-text-tertiary);margin:0 0 0.5rem">Add conditions and combine them with AND/OR groups — drag the <span class="aw-grip" style="cursor:default">&#x2842;</span> handle to move them. ' + escapeHtml(tgMeta.anyDimensionNote || "") + '</p>' +
        '<div id="aw-trig-root">' + tgGroupHtml(tree, 0, kind) + '</div>' +
        // A windowed ratio's field is its History (a measurement WINDOW, which
        // is genuinely seconds — business rule 29c), so only a non-ratio hold
        // seeds from the stored count.
        durationFieldHtml(
          'id="tf-duration-min"', triggerDurationSec(tr),
          triggerIsWindowedRatio(tr) ? null : storedHoldPolls(tr),
          // A ratio's History is a measurement window in seconds; every other
          // use of this field is a hold, and a hold is a count.
          triggerIsWindowedRatio(tr) ? "sec" : "polls",
        ) +
        ratioSustainFieldHtml(tr) +
        ratioCeilingFieldHtml(tr);
      if (cat === "host") {
        html += '<p style="font-size:0.78rem;color:var(--color-text-tertiary)">Polaris-host conditions aren’t tied to assets — the device filter from the previous step is ignored.</p>';
      }
    } else if (cat === "event") {
      var ev = tr.type === "event" ? tr : {};
      html += '<div class="form-group"><label>Action pattern (glob)</label><input type="text" id="tf-action" value="' + escapeHtml(ev.actionPattern || "") + '" placeholder="e.g. monitor.status_changed or integration.test.*"></div>';
      html += '<div class="form-group"><label>Resource type (optional)</label><input type="text" id="tf-restype" value="' + escapeHtml(ev.resourceType || "") + '" placeholder="e.g. asset / integration"></div>';
      html += '<div class="form-group"><label>Minimum event level (optional)</label><select id="tf-minlevel"><option value="">(any)</option>' + opt(s.eventLevels || ["info", "warning", "error"], ev.minLevel || "") + '</select></div>';
      html += '<p style="font-size:0.78rem;color:var(--color-text-tertiary)">Audit-event triggers aren’t tied to assets — the device filter from the previous step is ignored.</p>';
    } else if (cat === "change") {
      var ch = tr.type === "change" ? tr : {};
      var def = findType("change");
      html += '<div class="form-group"><label>Change type</label><select id="tf-changetype">' + optLabeled((def && def.changeTypes) || [], ch.changeType, changeLabel) + '</select></div>';
    }
    box.innerHTML = html;
    // Stored selects must agree with the model before the first collection
    // (refreshTriggerSentence collects) — see pinTreeSelects.
    if (cat === "device" || cat === "host") pinTreeSelects(box.querySelector("#aw-trig-root"), tree);
    refreshTriggerSentence();
    refreshDimOptions(panel);
    syncDurationRequirement(panel);
    syncDownDetection(panel);
    // Poll-counted fields: wire the edit→seconds hook once, then paint the
    // captions from whatever cadence is already cached and go ask for this
    // (metric, scope) if it isn't.
    wirePollFields(panel);
    syncPollFields(panel, false);
    refreshCadence(panel);
  }
  function wireStep3() {
    var panel = document.getElementById("aw-step-3");
    var sevSel = panel.querySelector("#aw-trigger-severity");
    if (sevSel) {
      sevSel.addEventListener("change", function () {
        draft.severity = sevSel.value;
        sevSel.className = "sev-select sev-" + sevSel.value;
        var note = panel.querySelector("#aw-band-base-note");
        if (note) note.innerHTML = bandBaseNoteHtml();
        applySevAccent(panel);
      });
    }
    var multiCb = panel.querySelector("#aw-multi-sev");
    if (multiCb) multiCb.addEventListener("change", function () { syncSeverityMode(panel); });
    panel.querySelector("#aw-trigger-type").addEventListener("change", function () {
      renderTriggerFields(); // category swap renders fresh from the draft
    });
    wireTgTree(panel, "#aw-trig-root", function () {
      return panel.querySelector("#aw-trigger-type").value === "host" ? "host" : "asset";
    }, refreshTriggerSentence);
    // Delegated: any input/select change re-renders the sentence (the tree's
    // own change handler also calls it — a second render is harmless) and
    // re-syncs the severity mode (single dropdown vs multi tiers + accent).
    panel.addEventListener("input", function () { refreshTriggerSentence(); syncSeverityMode(panel); syncDurationRequirement(panel); syncDownDetection(panel); });
    // syncBandsToBase runs AFTER syncSeverityMode so tiers built lazily on this
    // same event (first tick of the multi-severity checkbox, from a draft that
    // predates in-progress edits to the base condition) are corrected at once.
    panel.addEventListener("change", function () { refreshTriggerSentence(); syncSeverityMode(panel); syncBandsToBase(panel); refreshDimOptions(panel); syncDurationRequirement(panel); syncDownDetection(panel); refreshCadence(panel); });
    panel.querySelector("#aw-trigger-test").addEventListener("click", runTriggerPreview);
    renderTriggerFields();
    syncSeverityMode(panel);
  }
  function collectStep3() {
    var panel = document.getElementById("aw-step-3");
    var typeSel = panel.querySelector("#aw-trigger-type");
    if (!typeSel) return;
    var cat = typeSel.value;
    if (cat === "device" || cat === "host") {
      var kind = cat === "host" ? "host" : "asset";
      var root = panel.querySelector("#aw-trig-root > .scg-group");
      if (root) {
        // Fold filter rows (device identifiers / component names) into their
        // group's condition leaves — the STORED trigger only ever carries
        // dimensionFilter. Placement problems surface in validateStep3.
        var compiled = tgCompile(tgCollectGroup(root, kind));
        _tgFilterErrors = compiled.errors;
        var tree = compiled.tree;
        // The fields are COUNTED in polls but STORE seconds (see pollFieldHtml):
        // read the seconds each one stands for, so a cadence that arrives after
        // the operator typed can't reinterpret what they meant.
        var dEl = panel.querySelector("#tf-duration-min");
        var holdSec = pollFieldSec(dEl);
        // One time knob: it's the window for an aggregated condition (which then
        // needs no sustain on top), the sustain clock for a `latest` one. A
        // windowed RATIO is the exception with two: the field above is its
        // History (→ windowSec via the stamp), and its own optional sustain
        // rides the dedicated #tf-sustain-min field (hidden for everything
        // else, so a non-ratio trigger can never pick a value up from it).
        var aggregated = tgStampWindows(tree, holdSec);
        // Saturation ceiling — ratio leaves only. An empty box means "use the
        // default", stored as absent rather than as a literal 100 so the
        // server-side default stays the single source of that number.
        var cEl = panel.querySelector("#tf-ratio-ceiling");
        var cRaw = cEl ? String(cEl.value).trim() : "";
        var cNum = cRaw === "" ? null : Math.max(0, Math.min(100, Number(cRaw)));
        tgStampCeiling(tree, cNum !== null && isFinite(cNum) ? cNum : null);
        var ratio = !!root.querySelector('.scr-row[data-ratio="1"]');
        var sEl = panel.querySelector("#tf-sustain-min");
        var sustainSec = ratio ? Math.min(pollFieldSec(sEl), RATIO_WINDOW_MAX_SEC) : 0;
        // The hold is stored BOTH ways: `forPolls` is what the engine counts,
        // `forDurationSec` its wall-clock mirror (which also sizes the sample
        // window the engine fetches to see that many readings). An aggregated
        // trigger has no hold at all — its period is the measurement window.
        var holdPolls = aggregated ? (ratio ? pollFieldCount(sEl) : 0) : pollFieldCount(dEl);
        draft.trigger = tgCollapse({
          type: "composite", kind: kind, op: tree.op, children: tree.children,
          forDurationSec: aggregated ? (ratio ? sustainSec : 0) : holdSec,
          forPolls: holdPolls,
        });
        // A count only means something on a BARE trigger; the server rejects
        // one inside a multi-condition trigger. tgCollapse has already folded a
        // single-leaf tree down to that bare trigger, so anything still
        // composite here must shed its counts rather than 400 on save.
        if (draft.trigger && draft.trigger.type === "composite") stripMissedPolls(draft.trigger);
      }
    } else if (cat === "event") {
      var ev = { type: "event", actionPattern: panel.querySelector("#tf-action").value.trim() };
      var rt = panel.querySelector("#tf-restype").value.trim(); if (rt) ev.resourceType = rt;
      var ml = panel.querySelector("#tf-minlevel").value; if (ml) ev.minLevel = ml;
      draft.trigger = ev;
    } else if (cat === "change") {
      draft.trigger = { type: "change", changeType: panel.querySelector("#tf-changetype").value };
    }
    // Base severity: in multi mode it's the select injected into the condition
    // group header (.scg-sev); in single mode the standalone Alert dropdown.
    var baseSel = multiSevOn(panel) ? panel.querySelector("#aw-trig-root .scg-sev") : panel.querySelector("#aw-trigger-severity");
    if (baseSel) draft.severity = baseSel.value;
    collectBands(panel); // severity tiers live with the trigger (step 3)
  }
  /**
   * A WINDOWED-RATIO metric (today just probeLossPct) is a percentage computed
   * over a period — failed probes / total probes — so the window isn't a choice
   * layered on top of a reading, it IS the reading. Consequences here: the
   * aggregation control is meaningless (the engine ignores it), the one time
   * field means the measurement window and is mandatory, and severity tiers
   * share that window like any other sampling setting (rule 19).
   */
  function isWindowedRatioMetric(m) {
    return (s.windowedRatioMetrics || ["probeLossPct"]).indexOf(m) !== -1;
  }
  function tgLeafWindowedRatio(leaf) {
    return !!(leaf && leaf.type !== "asset_state" && isWindowedRatioMetric(leaf.metric));
  }
  /** Same question of a whole trigger, which may be a single metric OR the
   *  1-leaf composite the wizard builds before the server collapses it. */
  function triggerIsWindowedRatio(tr) {
    if (!tr) return false;
    if (tr.type === "composite") return (tgLeaves(tr) || []).some(tgLeafWindowedRatio);
    return tgLeafWindowedRatio(tr);
  }
  /** True when this leaf measures over a period rather than reading the latest
   *  sample — the case that needs a window, and so needs the duration field.
   *  A windowed-ratio leaf always counts, whatever its (ignored) aggregation. */
  function tgLeafAggregated(leaf) {
    if (tgLeafWindowedRatio(leaf)) return true;
    return !!(leaf && leaf.type !== "asset_state" && leaf.aggregation && leaf.aggregation !== "latest");
  }
  /**
   * Push `sec` into every aggregated leaf's windowSec (and 0 into every `latest`
   * leaf's). The duration field is the trigger's ONE time knob: for avg / median
   * / min / max it IS the measurement window, so the reading already covers the
   * period and no separate sustain clock applies; for `latest` it stays the
   * sustain it has always been. Returns whether any leaf is aggregated, which is
   * what tells the caller to zero forDurationSec.
   */
  function tgStampWindows(node, sec) {
    var aggregated = false;
    (function walk(n) {
      if (!n) return;
      if (n.type === undefined && Array.isArray(n.children)) { n.children.forEach(walk); return; }
      if (tgLeafAggregated(n)) { n.windowSec = sec; aggregated = true; }
      else if (n.type !== "asset_state") n.windowSec = 0;
    })(node);
    return aggregated;
  }
  /**
   * Stamp the saturation ceiling onto every windowed-ratio leaf, and STRIP it
   * from every other leaf. The strip half matters: switching a condition off
   * packet loss must not leave an ignoreAtOrAbove behind on a metric whose
   * builder no longer shows the field, silencing readings nobody can see a
   * reason for. Null clears it, which is what an emptied box means.
   */
  function tgStampCeiling(node, pct) {
    (function walk(n) {
      if (!n) return;
      if (n.type === undefined && Array.isArray(n.children)) { n.children.forEach(walk); return; }
      if (tgLeafWindowedRatio(n)) {
        if (pct === null) delete n.ignoreAtOrAbove;
        else n.ignoreAtOrAbove = pct;
      } else if (n.type !== "asset_state") {
        delete n.ignoreAtOrAbove;
      }
    })(node);
  }

  /** The trigger's measurement window in seconds — the widest window any of its
   *  aggregated leaves carries, 0 when every leaf reads `latest`. Reset leaves
   *  inherit it (see collectStep4): they answer the same question about the same
   *  device, so measuring them over a different period would be a third time
   *  knob nobody asked for. */
  function triggerWindowSec(tr) {
    if (!tr) return 0;
    var leaves = tr.type === "composite" ? tgLeaves(tr) : [tr];
    var win = 0;
    leaves.forEach(function (l) { if (tgLeafAggregated(l)) win = Math.max(win, Number(l.windowSec) || 0); });
    return win;
  }
  /**
   * The hold a stored trigger states as a COUNT OF READINGS, or null when it
   * states only seconds (every rule authored before the count existed). This is
   * what the engine actually counts — `forDurationSec` is its wall-clock mirror
   * — so it is also what the field shows, unconverted.
   */
  function storedHoldPolls(tr) {
    var n = tr && tr.forPolls;
    return typeof n === "number" && n > 0 ? Math.round(n) : null;
  }
  /** The same for a reset's clear-sustain. */
  function storedResetPolls(reset) {
    var n = reset && reset.sustainPolls;
    return typeof n === "number" && n > 0 ? Math.round(n) : null;
  }
  /** SECONDS the duration field stands for on a stored trigger: an aggregated
   *  leaf's window, else the sustain (which is what `latest` triggers carry).
   *  The field shows this divided by the cadence — seconds stay the stored unit. */
  function triggerDurationSec(tr) {
    if (!tr) return 0;
    var leaves = tr.type === "composite" ? tgLeaves(tr) : [tr];
    var win = 0;
    leaves.forEach(function (l) { if (tgLeafAggregated(l)) win = Math.max(win, Number(l.windowSec) || 0); });
    return win || Number(tr.forDurationSec) || 0;
  }
  /** The same value in minutes, for the PROSE surfaces (sentences, folded tier
   *  summaries) — those describe stored behaviour, so they keep wall clock. */
  function triggerDurationMinutes(tr) {
    return Math.round(triggerDurationSec(tr) / 60);
  }
  /**
   * Seconds for the ratio sustain field — the stored hold, but ONLY when the
   * trigger also stores a window. A legacy loss rule (windowSec 0) carries its
   * History in `forDurationSec` (the pre-History shape, which
   * triggerDurationSec reads back as the window above): showing that same value
   * here too would turn "measured over 60" into "measured over 60, then held
   * another 60" on the next save.
   */
  function triggerSustainSec(tr) {
    if (!tr || !triggerIsWindowedRatio(tr)) return 0;
    var leaves = tr.type === "composite" ? tgLeaves(tr) : [tr];
    var hasWindow = leaves.some(function (l) { return tgLeafWindowedRatio(l) && Number(l.windowSec) > 0; });
    return hasWindow ? Number(tr.forDurationSec) || 0 : 0;
  }
  /** Metrics whose reading is meaningless without an id-valued dimension: the
   *  filter is optional in the schema, so leaving it blank silently watches
   *  EVERY probe / widget on the device rather than the one intended. */
  var REQUIRED_DIM_BY_METRIC = {
    customStateValue: { key: "stateProbeId", label: "state probe" },
    customWidgetValue: { key: "widgetId", label: "custom widget" },
  };

  function tgValidateRequiredDimension(leaf, label) {
    var need = REQUIRED_DIM_BY_METRIC[leaf && leaf.metric];
    if (!need) return null;
    var df = leaf.dimensionFilter || {};
    if (df[need.key]) return null;
    return label + ": choose a " + need.label + ". Without one this would watch every " +
      need.label + " on the device, not just the one you mean.";
  }

  function tgValidateLeaf(leaf, label, isSoleCondition) {
    var dimProblem = tgValidateRequiredDimension(leaf, label);
    if (dimProblem) return dimProblem;
    if (leaf.type === "asset_state") {
      if (leaf.value == null || String(leaf.value).trim() === "") return label + ": choose or enter a value.";
      // A count is required only where it can DO anything: on the automation's
      // sole condition. Inside a multi-condition trigger the control is hidden
      // and the server rejects a count outright, so demanding one there would
      // make a perfectly legal composite unsaveable.
      var vdd = downDetectionMeta();
      if (vdd && isSoleCondition && isDownDetectionLeaf(leaf)) {
        var n = Number(leaf.missedPolls);
        if (!(isFinite(n) && n >= vdd.min && n <= vdd.max && n === Math.round(n))) {
          return label + ": enter how many consecutive missed polls make the device Down (" +
            vdd.min + "–" + vdd.max + "). This automation is the only place that number lives.";
        }
      }
      return null;
    }
    if (leaf.threshold == null || isNaN(leaf.threshold)) return label + ": enter a numeric threshold.";
    // An aggregation with no window has nothing to average / scan over, and the
    // engine would fall back to its own default lookback — so require the period
    // rather than quietly measuring something the operator never chose.
    if (tgLeafWindowedRatio(leaf)) {
      // The floor and ceiling are the ENGINE's, in seconds; the field counts
      // polls, so the message names the poll count that satisfies them at this
      // fleet's cadence rather than a number of minutes the field can't take.
      var winSec = Number(leaf.windowSec) || 0;
      var cadSec = awCadence().sec;
      if (winSec < RATIO_WINDOW_MIN_SEC) {
        return label + ": packet loss is measured over a period — set History to at least " +
          Math.max(1, Math.ceil(RATIO_WINDOW_MIN_SEC / cadSec)) + " polls (" + Math.round(RATIO_WINDOW_MIN_SEC / 60) + " minutes).";
      }
      if (winSec > RATIO_WINDOW_MAX_SEC) {
        return label + ": History can be at most " + Math.floor(RATIO_WINDOW_MAX_SEC / cadSec) + " polls (24 hours).";
      }
      return null;
    }
    if (tgLeafAggregated(leaf) && !(Number(leaf.windowSec) > 0)) {
      return label + ': "' + leaf.aggregation + '" measures over a period — set "Measured over (polls)" to 1 or more.';
    }
    return null;
  }
  function validateStep3() {
    // Filter-row placement problems from the collect that just ran (Next/Save
    // always collect before validating; the live sentence collects constantly).
    if (_tgFilterErrors.length) return _tgFilterErrors[0];
    var tr = draft.trigger || {};
    if (tr.type === "composite" || tr.type === "asset_metric" || tr.type === "asset_state" || tr.type === "host_metric") {
      var leaves = tr.type === "composite" ? tgLeaves(tr) : [tr];
      if (!leaves.length) return "Add at least one condition.";
      if (leaves.length > (tgMeta.maxLeaves || 10)) return "At most " + (tgMeta.maxLeaves || 10) + " conditions per trigger.";
      for (var i = 0; i < leaves.length; i++) {
        var p = tgValidateLeaf(leaves[i], "Condition " + (i + 1), leaves.length === 1);
        if (p) return p;
      }
      // Empty sub-groups collapse to nothing meaningful — flag them.
      if (tr.type === "composite") {
        var emptyGroup = false;
        (function walk(node) {
          if (!node || node.type !== undefined || !Array.isArray(node.children)) return;
          if (!node.children.length) { emptyGroup = true; return; }
          node.children.forEach(walk);
        })({ op: tr.op, children: tr.children });
        if (emptyGroup) return "A condition group is empty — add a condition or remove the group.";
      }
      return validateBands();
    }
    if (tr.type === "event" && !String(tr.actionPattern || "").trim()) {
      return "Enter an action pattern for the event trigger.";
    }
    return null;
  }
  // Severity bands live with the trigger (step 3): threshold + severity present,
  // actions valid (tier ordering is enforced server-side against base+operator).
  function validateBands() {
    if (!bandsApplicable(draft.trigger) || !draft.severityBands) return null;
    for (var b = 0; b < draft.severityBands.length; b++) {
      var band = draft.severityBands[b]; var bn = "Severity band " + (b + 1);
      if (band.threshold == null || isNaN(band.threshold)) return bn + ": enter a numeric threshold.";
      if (!band.severity) return bn + ": pick a severity.";
      for (var ba = 0; ba < (band.actions || []).length; ba++) {
        var pb = validateAction(band.actions[ba], bn + ", action " + (ba + 1));
        if (pb) return pb;
      }
      var betiers = (band.escalation && band.escalation.tiers) || [];
      for (var be = 0; be < betiers.length; be++) {
        if (!betiers[be].actions.length) return bn + ", escalation " + (be + 1) + ": add at least one action (or remove it).";
      }
    }
    // Only reachable on a stored rule the wizard hasn't re-saved yet — the
    // builder no longer produces dedicated resolved actions.
    if (draft.bandNotify && draft.bandNotify.onResolved && draft.bandNotify.resolvedMode === "dedicated") {
      var ra = draft.bandNotify.resolvedActions || [];
      for (var r = 0; r < ra.length; r++) {
        var pr = validateAction(ra[r], "Resolved action " + (r + 1));
        if (pr) return pr;
      }
    }
    return null;
  }
  function refreshTriggerSentence() {
    var el = document.getElementById("aw-trigger-sentence");
    if (!el) return;
    collectStep3();
    el.innerHTML = triggerSentence(draft.trigger, draftLadder());
    refreshTriggerFormula();
    // Adding or removing a condition changes which × belongs on screen, and it
    // reaches us through the builder's onChange rather than an input event.
    var panel = document.getElementById("aw-step-3");
    if (panel && multiSevOn(panel)) syncBaseTierRemove(panel);
  }
  /** The formula block under the sentence. Hidden entirely for the trigger types
   *  that have no value to compute (event / change), rather than shown empty. */
  function refreshTriggerFormula() {
    var el = document.getElementById("aw-trigger-formula");
    if (!el) return;
    var f = triggerFormula(draft.trigger, draftLadder());
    if (!f.lines.length) { el.style.display = "none"; el.innerHTML = ""; return; }
    el.style.display = "";
    el.innerHTML = '<pre>' + escapeHtml(f.lines.join("\n")) + '</pre>' +
      (f.note ? '<p class="aw-formula-note">' + escapeHtml(f.note) + '</p>' : "");
  }
  /** What the sentence needs to name every severity this trigger can raise —
   *  the base tier plus each band, so the summary doesn't stop at tier 0. */
  function draftLadder() {
    return {
      severity: draft.severity,
      severityBands: bandsApplicable(draft.trigger) ? draft.severityBands : null,
    };
  }
  async function runTriggerPreview() {
    var box = document.getElementById("aw-trigger-preview");
    if (!box) return;
    collectStep2(); collectStep3();
    box.innerHTML = '<p style="color:var(--color-text-tertiary);font-size:0.85rem">Testing…</p>';
    try {
      var res = await api.automations.preview({ trigger: draft.trigger, scope: draft.scope, reset: draft.reset || undefined });
      if (!res.supported) { box.innerHTML = '<p style="color:var(--color-text-tertiary);font-size:0.85rem">' + escapeHtml(res.note || "Not previewable.") + '</p>'; return; }
      var meeting = (res.matches || []).filter(function (m) { return m.meets; });
      var composite = (res.matches || []).some(function (m) { return Array.isArray(m.leaves); });
      // A state probe's reading is 0/1; show the probe's own word for it, since a
      // column of bare 1s and 0s is exactly what this framework exists to avoid.
      var tr0 = draft.trigger || {};
      var flagPreview = tr0.type === "asset_metric" && isBooleanMetric(tr0.metric);
      function previewValue(v) {
        if (v == null) return "n/a";
        if (!flagPreview) return String(v);
        var m2 = stateMapOf(tr0.metric, tr0.dimensionFilter || {});
        return Number(v) === 1 ? m2.trueLabel : Number(v) === 0 ? m2.falseLabel : String(v);
      }
      var rowsHtml = (res.matches || []).slice(0, 20).map(function (m) {
        var statusCell = m.meets ? '<span style="color:var(--color-danger)">would fire</span>' : m.inDeadBand ? '<span style="color:var(--color-warning,#d97706)">dead band</span>' : '<span style="color:var(--color-text-tertiary)">no</span>';
        if (composite) {
          // Per-condition breakdown: ✓ met (with witness dim), ✗ measured
          // false, — no data.
          var leafLines = (m.leaves || []).map(function (l) {
            var mark = l.met ? '<span style="color:var(--color-danger)">&#10003;</span>' : l.noData ? '<span style="color:var(--color-text-tertiary)">&mdash;</span>' : '<span style="color:var(--color-text-tertiary)">&#10007;</span>';
            var val = l.noData ? "no data" : (l.dimension ? l.dimension + " = " : "") + (l.value == null ? "n/a" : String(l.value));
            return mark + ' ' + escapeHtml(l.label) + ' <span style="color:var(--color-text-tertiary)">(' + escapeHtml(val) + ')</span>';
          }).join("<br>");
          return '<tr><td>' + escapeHtml(m.hostname || m.assetId || "host") + '</td><td style="font-size:0.78rem">' + leafLines + '</td><td>' + statusCell + '</td></tr>';
        }
        return '<tr><td>' + escapeHtml(m.hostname || m.assetId || "host") + '</td><td>' + escapeHtml(m.dimension || "") + '</td><td>' + escapeHtml(previewValue(m.value)) + '</td><td>' + statusCell + '</td></tr>';
      }).join("");
      var headHtml = composite
        ? '<tr><th>Asset</th><th>Conditions</th><th>Status</th></tr>'
        : '<tr><th>Asset</th><th>Dimension</th><th>Value</th><th>Status</th></tr>';
      box.innerHTML = '<p style="font-size:0.85rem"><strong>' + meeting.length + '</strong> of ' + res.totalEvaluated + ' currently match.</p>' +
        '<div class="table-wrapper" style="max-height:200px;overflow:auto"><table><thead>' + headHtml + '</thead><tbody>' + rowsHtml + '</tbody></table></div>';
    } catch (err) { box.innerHTML = '<p style="color:var(--color-danger)">' + escapeHtml(err.message || "Preview failed") + '</p>'; }
  }

  // ── Step 4: Reset conditions ───────────────────────────────────────────
  // Default: a checked "Reset when the trigger is no longer true" checkbox
  // (= auto mode, with hysteresis/sustain extras). Unchecking reveals the other
  // modes, led by "custom conditions" — the same AND/OR builder the trigger step
  // uses, stored as reset mode "condition" and SEEDED with the trigger inverted,
  // so the starting point is what the checkbox that was just unchecked did.
  // Event/change triggers have no continuous condition and keep the plain
  // timed/manual radios (TRIGGER_TYPES_WITH_RESET_CONDITIONS, server-side).
  /** The pattern that says the trigger's event recovered, when Polaris writes
   *  one (server-published map — the wizard never guesses a verb). */
  function resetEventSuggestion(tr) {
    var map = (s && s.resetEventSuggestions) || {};
    var pat = tr && tr.type === "event" ? String(tr.actionPattern || "").trim() : "";
    return (pat && map[pat]) || "";
  }
  /** Takes the TRIGGER, not just its type: an event automation whose action has
   *  a known counterpart (agent.disconnected → agent.connected) should start on
   *  "clears when it comes back", which is the honest answer, rather than on a
   *  four-hour timer that clears the alert whether or not anything recovered.
   *  Only ever consulted for a draft that has made no reset choice yet. */
  function defaultResetFor(tr) {
    var type = tr && tr.type ? tr.type : String(tr || "");
    var sug = resetEventSuggestion(tr);
    if (sug) return { mode: "event", resetEvent: { actionPattern: sug, resourceType: null } };
    var d = (s.resetDefaults && s.resetDefaults[type]) || { mode: "auto" };
    return JSON.parse(JSON.stringify(d));
  }
  /** The event-reset radio's fields. Prefilled from the suggestion map so
   *  picking the radio already carries the counterpart pattern. */
  function eventResetExtraHtml(reset, tr) {
    var re = (reset && reset.resetEvent) || {};
    var val = re.actionPattern || resetEventSuggestion(tr);
    return '<div style="margin:6px 0 0 24px">' +
      '<div class="form-group" style="margin:0"><label>Clearing event — action pattern (glob)</label>' +
        '<input type="text" id="aw-reset-ev-action" value="' + escapeHtml(val) + '" placeholder="e.g. agent.connected"></div>' +
      '<div class="form-group" style="margin:6px 0 0"><label>Resource type (optional)</label>' +
        '<input type="text" id="aw-reset-ev-restype" value="' + escapeHtml(re.resourceType || "") + '" placeholder="e.g. asset"></div>' +
      '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:6px 0 0">The clearing event has to be about the <strong>same device or resource</strong> the alert is about — one agent reconnecting never clears another agent’s alert. Until it arrives the alert stays up, so something that never comes back keeps its alert.</p>' +
    '</div>';
  }
  /** The dimensions a trigger reports per — [] when it alerts once per device.
   *  Composite is always per-device (its leaves fold ANY-dimension). */
  function triggerDimensions(tr) {
    if (!tr || !tr.type) return [];
    if (tr.type === "asset_metric") return (s.metricDimensions && s.metricDimensions[tr.metric]) || [];
    if (tr.type === "asset_state") return (s.stateFieldDimensions && s.stateFieldDimensions[tr.field]) || [];
    return [];
  }
  function isTriggerPerDimension(tr) { return triggerDimensions(tr).length > 0; }
  /** "interface" / "sensor" / … for the reset step's per-dimension note. */
  function perDimensionNoun(tr) {
    var dims = triggerDimensions(tr);
    for (var i = 0; i < dims.length; i++) {
      var n = s.dimensionNouns && s.dimensionNouns[dims[i]];
      if (n) return n;
    }
    return "reading";
  }
  /** The custom-reset tree an untouched draft starts from: the trigger's own
   *  condition, inverted (De Morgan for a composite). Falls back to a blank
   *  condition row only when there is nothing invertible to seed from. */
  function seededResetTree(tr, kind) {
    var seed = invertedTree(triggerToTree(tr, kind));
    return seed && (seed.children || []).length ? seed : { op: "and", children: [tgDefaultLeaf(kind)] };
  }
  function resetRadioHtml(m, reset, extra) {
    var meta = (s.resetModeMeta || {})[m] || { label: m };
    return '<div style="margin-bottom:0.6rem">' +
      '<label style="display:block;font-weight:600;font-size:0.9rem"><input type="radio" name="aw-reset-mode" value="' + m + '"' + (reset.mode === m ? " checked" : "") + '> ' + escapeHtml(meta.label || m) + '</label>' +
      (meta.help ? '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:2px 0 0 24px">' + escapeHtml(meta.help) + '</p>' : "") +
      '<div class="aw-reset-extra" data-mode="' + m + '" style="display:' + (reset.mode === m ? "block" : "none") + '">' + (extra || "") + '</div>' +
    '</div>';
  }
  function timedExtraHtml(reset) {
    return '<div style="margin:6px 0 0 24px;font-size:0.85rem">Clear after <input type="number" id="aw-after-min" min="1" value="' + Math.round((reset.afterSec || 3600) / 60) + '" style="width:90px"> min</div>';
  }
  function renderStep4() {
    var panel = document.getElementById("aw-step-4");
    var tr = draft.trigger || {};
    var modes = (s.resetModesByTriggerType && s.resetModesByTriggerType[tr.type]) || ["auto", "timed", "manual"];
    if (!draft.reset || modes.indexOf(draft.reset.mode) === -1) draft.reset = defaultResetFor(tr);
    // A reset condition is written in the trigger's kind (device vs Polaris
    // host), so switching the trigger between the two on step 3 leaves a tree
    // the server would refuse. Drop it and re-seed from the new trigger rather
    // than making the operator hand-fix leaves they never chose.
    if (draft.reset.condition) {
      var wantHostLeaves = tr.kind === "host" || tr.type === "host_metric";
      var stale = tgLeaves(draft.reset.condition).some(function (l) { return wantHostLeaves !== (l.type === "host_metric"); });
      if (stale) delete draft.reset.condition;
    }
    var reset = draft.reset;
    var isEC = tr.type === "event" || tr.type === "change";
    // A 0/1 flag has no dead band between "firing" and "clear", so the
    // hysteresis control below would be meaningless on one — it resets when the
    // flag flips back. (resetSentence makes the same exclusion.)
    var numeric = (tr.type === "asset_metric" || tr.type === "host_metric") && !isBooleanMetric(tr.metric);
    if (isEC) {
      // Event/change: no continuous condition — plain timed/manual radios.
      var radios = modes.map(function (m) {
        return resetRadioHtml(m, reset, m === "timed" ? timedExtraHtml(reset) : m === "event" ? eventResetExtraHtml(reset, tr) : "");
      }).join("");
      panel.innerHTML = '<h3 style="margin:0 0 0.25rem">How should its alerts reset?</h3>' +
        '<div class="aw-sentence" id="aw-reset-sentence">…</div>' + radios;
    } else {
      var autoOn = reset.mode === "auto";
      // Non-auto modes in the server's own order, which puts "condition" first:
      // unchecking the box lands on the trigger-inverted tree, i.e. the editable
      // spelling of what was just unchecked, instead of on "manually only".
      var customModes = modes.filter(function (m) { return m !== "auto"; });
      var selCustom = customModes.indexOf(reset.mode) !== -1 ? reset.mode : customModes[0];
      var customReset = { mode: autoOn ? selCustom : reset.mode, afterSec: reset.afterSec, condition: reset.condition, sustainSec: reset.sustainSec };

      var unit = numeric ? leafUnit(tr.metric, tr.dimensionFilter) : "";
      var invOp = INV_CMP[tr.operator] || "<";
      // Counted in polls like every hold on the trigger step: recovery is
      // judged on readings too, so "stay cleared for 3" means three readings
      // back under the line. Seconds remain what is stored (data-sec).
      // On a DOWN automation this count is not just the alert's clock: the probe
      // loop holds the device in Recovering until that many polls have answered
      // (business rule 36), so the pill and the alert end together. Say so here
      // — it is the difference between a number that delays an email and one
      // that changes what the Assets list reads.
      var downReset = isDownDetectionTrigger(tr);
      var sustainHtml = '<div style="margin:6px 0 0;font-size:0.85rem">Must stay cleared for ' +
        '<input type="number" id="aw-sustain-min" class="aw-poll-input" data-sec="' + (reset.sustainSec || 0) + '" min="0" value="' +
        (storedResetPolls(reset) != null ? storedResetPolls(reset) : pollsFromSec(reset.sustainSec || 0, awCadence().sec)) + '" style="width:80px"> polls (0 = reset immediately)' +
        (downReset
          ? '<p style="margin:2px 0 0;font-size:0.78rem;color:var(--color-text-tertiary)">' +
            'On a down automation this is the way back for the device itself: it reads <strong>Recovering</strong> ' +
            'until that many polls have answered, then <strong>Up</strong> — and the alert clears with it. ' +
            'Fewer than the missed-poll count changes nothing, since the device still has to answer once per miss.</p>'
          : '') +
        '<p class="aw-poll-note" style="margin:2px 0 0;font-size:0.78rem;color:var(--color-text-tertiary)"></p></div>';
      var autoExtras = "";
      if (numeric) {
        autoExtras =
          '<label style="display:block;font-size:0.82rem"><input type="checkbox" id="aw-hyst-enable"' + (reset.clearThreshold != null ? " checked" : "") + '> Use a different clear threshold (hysteresis)</label>' +
          '<div id="aw-hyst-fields" style="display:' + (reset.clearThreshold != null ? "block" : "none") + ';margin:4px 0 0 24px;font-size:0.85rem">value must be <strong>' + escapeHtml(CMP_PHRASE[invOp] || invOp) + '</strong> ' +
            '<input type="number" step="any" id="aw-clear-threshold" value="' + (reset.clearThreshold != null ? reset.clearThreshold : "") + '" style="width:110px"> ' + escapeHtml(unit) +
          '</div>' + sustainHtml;
      } else {
        autoExtras = sustainHtml;
      }

      var condExtra = "";
      if (customModes.indexOf("condition") !== -1) {
        var kind = tr.kind === "host" || tr.type === "host_metric" ? "host" : "asset";
        // Seeded with the trigger INVERTED (severity bands ignored — a ladder's
        // tiers all recover at tier 0, so the base condition is the one there is
        // anything to invert). That is the same clause the automatic reset uses,
        // so a stored automation reads identically until the operator edits it —
        // which is the point: the seed is a starting position, not a new default.
        var condTree = customReset.condition
          ? tgLift(JSON.parse(JSON.stringify(customReset.condition)))
          : seededResetTree(tr, kind);
        condExtra =
          '<div style="margin:6px 0 0 24px">' +
            '<div id="aw-reset-root">' + tgGroupHtml(condTree, 0, kind) + '</div>' +
            '<div style="font-size:0.85rem;margin-top:4px">Must stay true for ' +
              '<input type="number" id="aw-crs-sustain-min" class="aw-poll-input" data-sec="' + (reset.mode === "condition" ? (reset.sustainSec || 0) : 0) + '" min="0" value="' +
              (reset.mode === "condition" && storedResetPolls(reset) != null
                ? storedResetPolls(reset)
                : pollsFromSec(reset.mode === "condition" ? (reset.sustainSec || 0) : 0, awCadence().sec)) + '" style="width:80px"> polls (0 = reset immediately)' +
              '<p class="aw-poll-note" style="margin:2px 0 0;font-size:0.78rem;color:var(--color-text-tertiary)"></p></div>' +
            (isTriggerPerDimension(tr)
              ? '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:6px 0 0">This automation alerts per ' + escapeHtml(perDimensionNoun(tr)) + '. A reset condition on the same ' + escapeHtml(perDimensionNoun(tr)) + ' clears each alert on its own; one on anything else (CPU, memory, device status) is read for the whole device, so it clears all of them together.</p>'
              : "") +
            '<p style="font-size:0.78rem;color:var(--color-warning,#d97706);margin:6px 0 0">If the trigger and reset conditions can both be true at once, the automation can clear and re-fire in a loop — separate them, by moving the reset threshold away from the trigger or making the reset hold for a few polls.</p>' +
          '</div>';
      }

      var customRadios = customModes.map(function (m) {
        var extra = m === "condition" ? condExtra : m === "timed" ? timedExtraHtml(customReset) : "";
        return resetRadioHtml(m, customReset, extra);
      }).join("");

      panel.innerHTML = '<h3 style="margin:0 0 0.25rem">How should its alerts reset?</h3>' +
        '<div class="aw-sentence" id="aw-reset-sentence">…</div>' +
        '<div class="form-group" style="margin-bottom:0.5rem"><label style="font-weight:600"><input type="checkbox" id="aw-reset-auto"' + (autoOn ? " checked" : "") + '> Reset when the trigger is no longer true</label>' +
        '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:2px 0 0 24px">The alert clears automatically once the condition recovers. Uncheck to write your own reset conditions, or to reset on a timer or by hand.</p></div>' +
        '<div id="aw-auto-extras" style="display:' + (autoOn ? "block" : "none") + ';margin:0 0 0.6rem 24px">' + autoExtras + '</div>' +
        '<div id="aw-reset-custom" style="display:' + (autoOn ? "none" : "block") + '">' + customRadios + '</div>';

      var autoCb = panel.querySelector("#aw-reset-auto");
      autoCb.addEventListener("change", function () {
        panel.querySelector("#aw-auto-extras").style.display = autoCb.checked ? "block" : "none";
        panel.querySelector("#aw-reset-custom").style.display = autoCb.checked ? "none" : "block";
        refreshResetSentence();
      });
      var hystEnable = panel.querySelector("#aw-hyst-enable");
      if (hystEnable) {
        hystEnable.addEventListener("change", function () {
          panel.querySelector("#aw-hyst-fields").style.display = hystEnable.checked ? "block" : "none";
          refreshResetSentence();
        });
      }
      // The reset-condition builder shares the trigger tree machinery
      // (delegated once per panel; kind follows the trigger) — including the
      // stored-select re-pin the trigger tree gets. Unguarded: the tree renders
      // for every trigger that offers a reset condition now, not just composites.
      // A host_metric trigger carries no `kind` (only a composite does), so the
      // host test has to cover both or the builder would offer device metrics
      // for a Polaris-host automation's reset and the save would be refused.
      pinTreeSelects(panel.querySelector("#aw-reset-root"), condTree);
      wireTgTree(panel, "#aw-reset-root", function () {
        var t = draft.trigger || {};
        return t.kind === "host" || t.type === "host_metric" ? "host" : "asset";
      }, function () { refreshResetSentence(); refreshDimOptions(panel); });
      refreshDimOptions(panel);
    }

    panel.querySelectorAll('input[name="aw-reset-mode"]').forEach(function (radio) {
      radio.addEventListener("change", function () {
        panel.querySelectorAll(".aw-reset-extra").forEach(function (x) { x.style.display = x.getAttribute("data-mode") === radio.value ? "block" : "none"; });
        refreshResetSentence();
      });
    });
    if (!panel._rsWired) {
      panel._rsWired = true;
      panel.addEventListener("input", function () { refreshResetSentence(); });
    }
    // The reset holds are counted in polls too, at the trigger's own cadence —
    // wire the edit→seconds hook and paint the captions. The cadence is
    // normally already cached from step 3; asking again is a no-op when it is.
    wirePollFields(panel);
    syncPollFields(panel, false);
    refreshCadence(panel);
    refreshResetSentence();
  }
  function collectStep4() {
    var panel = document.getElementById("aw-step-4");
    var tr = draft.trigger || {};
    var autoCb = panel.querySelector("#aw-reset-auto");
    var reset;
    // Only the condition branch below repopulates these — clearing here keeps
    // a mode switch from leaving a stale filter error blocking Save.
    _rsFilterErrors = [];
    if (autoCb && autoCb.checked) {
      reset = { mode: "auto" };
      var hyst = panel.querySelector("#aw-hyst-enable");
      var ct = panel.querySelector("#aw-clear-threshold");
      if (hyst && hyst.checked && ct && ct.value !== "" && !isNaN(Number(ct.value))) reset.clearThreshold = Number(ct.value);
      var smEl = panel.querySelector("#aw-sustain-min");
      var sus = pollFieldSec(smEl);
      if (sus > 0) reset.sustainSec = sus;
      // The COUNT is the authority (the engine counts recovered readings); the
      // seconds ride along as its mirror, exactly as the trigger's hold does.
      if (pollFieldCount(smEl) > 0) reset.sustainPolls = pollFieldCount(smEl);
    } else {
      var sel = panel.querySelector('input[name="aw-reset-mode"]:checked');
      if (!sel) return;
      var mode = sel.value;
      reset = { mode: mode };
      if (mode === "event") {
        var ea = panel.querySelector("#aw-reset-ev-action");
        var er = panel.querySelector("#aw-reset-ev-restype");
        reset.resetEvent = {
          actionPattern: ea ? ea.value.trim() : "",
          resourceType: er && er.value.trim() ? er.value.trim() : null,
        };
      } else if (mode === "timed") {
        var am = panel.querySelector("#aw-after-min");
        var mins = am && am.value !== "" ? Number(am.value) : 60;
        reset.afterSec = (isNaN(mins) || mins < 1 ? 60 : mins) * 60;
      } else if (mode === "condition") {
        var kind = tr.kind === "host" || tr.type === "host_metric" ? "host" : "asset";
        var root = panel.querySelector("#aw-reset-root > .scg-group");
        if (root) {
          // Same filter-row folding the trigger tree gets (the stored reset
          // condition carries dimensionFilter only).
          var rc = tgCompile(tgCollectGroup(root, kind));
          _rsFilterErrors = rc.errors;
          reset.condition = rc.tree;
          // A reset condition is MEASURED the way the trigger is — the reset step
          // has no window control of its own, and adding one would be a second
          // minutes field next to "must stay true for", i.e. exactly the
          // measurement-window-vs-hold-clock confusion business rule 29c exists
          // to remove. tgCollectLeaf always writes windowSec 0 (step 3 stamps it
          // from its duration field), so without this an aggregated reset leaf
          // was refused by validateStep4 with a message naming a field that
          // isn't on the step — reachable on a composite reset since that
          // builder shipped, and on every trigger now that the seed carries the
          // trigger's own aggregation.
          tgStampWindows(reset.condition, triggerWindowSec(tr));
        }
        var csEl = panel.querySelector("#aw-crs-sustain-min");
        var csus = pollFieldSec(csEl);
        if (csus > 0) reset.sustainSec = csus;
        if (pollFieldCount(csEl) > 0) reset.sustainPolls = pollFieldCount(csEl);
      }
    }
    draft.reset = reset;
  }
  function validateStep4() {
    var r = draft.reset || {};
    var tr = draft.trigger || {};
    if (r.mode === "timed" && (!r.afterSec || r.afterSec < 60)) return "Timed reset: enter the clear delay (1 minute or more).";
    if (r.mode === "event") {
      if (!r.resetEvent || !String(r.resetEvent.actionPattern || "").trim()) return "Event reset: enter the action pattern of the event that clears the alert (e.g. agent.connected).";
      // The server refuses the same shape — a continuous trigger recovers on
      // its own reading, and an unrelated Event clearing it would hide a device
      // still over the line.
      if (tr.type !== "event" && tr.type !== "change") return "Resetting on an audit event only applies to event and change triggers — a " + tr.type + " automation recovers on its own reading.";
    }
    if (r.mode === "auto" && r.clearThreshold != null) {
      if (isNaN(r.clearThreshold)) return "Hysteresis: enter a numeric clear threshold.";
      var t = tr.threshold;
      if (tr.operator === "==" || tr.operator === "!=") return "Hysteresis can't be combined with the " + tr.operator + " operator.";
      if ((tr.operator === ">" || tr.operator === ">=") && r.clearThreshold > t) return "Clear threshold must be at or below the fire threshold (" + t + ").";
      if ((tr.operator === "<" || tr.operator === "<=") && r.clearThreshold < t) return "Clear threshold must be at or above the fire threshold (" + t + ").";
    }
    if (r.mode === "condition") {
      if (_rsFilterErrors.length) return "Custom reset: " + _rsFilterErrors[0];
      // event/change fire on an instant and carry no reading, so there is nothing
      // for a reset condition to watch — the server rejects the same shape.
      if (tr.type === "event" || tr.type === "change") return "A custom reset condition needs a trigger with a continuous condition — an " + tr.type + " automation resets on a timer or by hand.";
      if (!r.condition || !(r.condition.children || []).length) return "Custom reset: add at least one condition.";
      var leaves = tgLeaves(r.condition);
      if (!leaves.length) return "Custom reset: add at least one condition.";
      // Reset leaves are measured over the TRIGGER's window (collectStep4), so an
      // averaged reset condition under a trigger that reads the current value has
      // no period to average over. tgValidateLeaf's generic message points at
      // "Measured over (polls)", which on this step doesn't exist — and on a
      // `latest` trigger that field is the sustain clock, not a window, so
      // setting it wouldn't help either. Say what actually fixes it.
      var win = triggerWindowSec(draft.trigger);
      for (var k = 0; k < leaves.length; k++) {
        if (win <= 0 && tgLeafAggregated(leaves[k])) {
          return "Reset condition " + (k + 1) + ': "' + leaves[k].aggregation + '" measures over a period, and a reset condition is measured over the same period as the trigger — this trigger reads the current value, so choose "latest" here or make the trigger an averaged one.';
        }
      }
      for (var i = 0; i < leaves.length; i++) {
        var p = tgValidateLeaf(leaves[i], "Reset condition " + (i + 1));
        if (p) return p;
      }
      // Kind coherence, mirroring validateRuleV2: a Polaris-host trigger recovers
      // on host readings and a device trigger on device readings. The builder
      // only offers the trigger's own kind, so this catches a stored rule edited
      // after its trigger kind changed rather than fresh input.
      var wantHost = tr.type === "host_metric" || (tr.type === "composite" && tr.kind === "host");
      for (var j = 0; j < leaves.length; j++) {
        if (wantHost !== (leaves[j].type === "host_metric")) {
          return "Reset conditions must watch the same thing the trigger does — " + (wantHost ? "Polaris-host" : "device") + " readings.";
        }
      }
    }
    return null;
  }
  function refreshResetSentence() {
    var el = document.getElementById("aw-reset-sentence");
    if (!el) return;
    collectStep4();
    el.innerHTML = resetSentence(draft.reset, draft.trigger);
  }

  // ── Step 5: Actions + escalation + summary ─────────────────────────────
  /**
   * Who a collapsed notify row reaches, in a few words.
   *
   * Added because the pairing this feature exists for — front-line staff on the
   * trigger, the division's managers on the escalation — is two notify actions
   * on the SAME channel, which read identically as "Notify via Email" when
   * folded. The dynamic recipients are named explicitly and everything else is
   * counted, so the line stays short.
   */
  function notifySuffix(a) {
    var bits = [];
    if (a.recipientAllUsers) bits.push("all users");
    else if (a.recipientAllRegions) bits.push("all region users");
    (a.recipientDeviceRegionLevels || []).forEach(function (n) { bits.push("L" + n + " region users"); });
    if (a.recipientDeviceRegion) bits.push("device’s region users");
    if (a.recipientAssetContacts) bits.push("responsible contacts");
    var regions = (a.recipientRegions || []).length;
    if (regions) bits.push(regions + " region" + (regions === 1 ? "" : "s"));
    var tags = (a.recipientTags || []).length;
    if (tags) bits.push(tags + " tag" + (tags === 1 ? "" : "s"));
    var roles = (a.recipientRoles || []).length;
    if (roles) bits.push(roles + " role" + (roles === 1 ? "" : "s"));
    var named = (a.recipientUserIds || []).length + (a.addresses || []).length;
    if (named) bits.push(named + " recipient" + (named === 1 ? "" : "s"));
    return bits.length ? " — " + bits.join(", ") : "";
  }

  /** Server-published caps + copy vocabulary for the repeat control. */
  function repeatMeta() {
    return (s && s.repeatMeta) || { minEveryMin: 5, maxEveryMin: 1440, unbounded: true, maxStopAfterHours: 720 };
  }

  /**
   * "Repeat this notification".
   *
   * The label says what the control does and stops there — the two fields it
   * reveals already read "until Acknowledged / Cleared only", so "until it's
   * handled" in the label was answering, less precisely, a question the row
   * below it already answers.
   *
   * Two things the copy still has to state because neither can be inferred:
   * reminders re-send NOTIFICATIONS only (API calls and scripts run once, at
   * the first fire), and they cannot be exercised from the Test-delivery
   * button, because a test Notification carries ruleId null on purpose so the
   * sweep can't enlist it.
   */
  function repeatControlHtml() {
    var m = repeatMeta();
    var r = draft.repeat || null;
    return '' +
      '<label style="display:block;margin:0.6rem 0 0;font-weight:400">' +
        '<input type="checkbox" id="aw-repeat-on"' + (r ? " checked" : "") + '> ' +
        'Repeat this notification' +
      '</label>' +
      '<div id="aw-repeat-fields" style="margin:4px 0 0 1.4rem"' + (r ? "" : ' hidden') + '>' +
        '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
          '<span style="font-size:0.85rem">Re-send every</span>' +
          '<input type="number" id="aw-repeat-every" class="input" min="' + m.minEveryMin + '" max="' + m.maxEveryMin + '" ' +
                 'value="' + escapeHtml(r && r.everyMin != null ? String(r.everyMin) : "15") + '" style="width:5rem">' +
          '<span style="font-size:0.85rem">minutes, until</span>' +
          '<select id="aw-repeat-stopon" class="input" style="width:auto">' +
            '<option value="acknowledge"' + (!r || r.stopOn !== "clear" ? " selected" : "") + '>Acknowledged</option>' +
            '<option value="clear"' + (r && r.stopOn === "clear" ? " selected" : "") + '>Cleared only</option>' +
          '</select>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:6px;margin-top:4px;flex-wrap:wrap">' +
          '<span style="font-size:0.85rem">…and give up after</span>' +
          '<input type="number" id="aw-repeat-stopafter" class="input" min="1" max="' + m.maxStopAfterHours + '" ' +
                 'placeholder="never" value="' + escapeHtml(r && r.stopAfterHours != null ? String(r.stopAfterHours) : "") + '" style="width:5rem">' +
          '<span style="font-size:0.85rem">hours (optional)</span>' +
        '</div>' +
        quietControlHtml() +
        '<p id="aw-repeat-note" style="font-size:0.78rem;color:var(--color-text-tertiary);margin:4px 0 0"></p>' +
        '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:2px 0 0">' +
          'Reminders re-send the notifications only — API calls and scripts run once, when the alert first fires. ' +
          'The Test delivery button can’t exercise reminders.' +
        '</p>' +
      '</div>';
  }

  // ─── Quiet time ───────────────────────────────────────────────────────────
  // Windows during which a DUE reminder is held rather than sent, and after
  // which the next one states how long the alert has been active (business
  // rule 44). The stored shape is the Maintenance scheduler's recurrence JSON,
  // which is why the summary line comes from PolarisRecurrence rather than
  // from a formatter of our own.

  function quietMeta() {
    var m = repeatMeta();
    return (m && m.quietMeta) || { maxWindows: 8, serverClock: null, help: "" };
  }

  /** A recurrence shape in words, through the shared summariser. */
  function quietSummary(w) {
    var r = window.PolarisRecurrence;
    if (r && typeof r.summary === "function") return r.summary(w);
    return "quiet period";
  }

  /**
   * Can the shared day/hours editor express this window?
   *
   * It edits ONE weekly recurrence — each day off, all day, or carrying its
   * own hour ranges — which is every quiet time anyone has asked for now that
   * a day can hold several ranges ("nights, and all weekend" is one window,
   * not two). The SERVER still accepts the whole recurrence vocabulary, so an
   * API-authored rule can carry a one-time window, a monthly change freeze or
   * active-date bounds; those are listed read-only and re-sent VERBATIM.
   * Rewriting one into what these rows can say would silently destroy a policy
   * whose author never opened this wizard.
   */
  function quietWindowEditable(w) {
    if (!w || w.kind !== "recurring") return false;
    if (w.freq !== "daily" && w.freq !== "weekly") return false;
    if (w.activeFrom || w.activeUntil) return false;
    return true;
  }

  /** The window the day/hours editor owns — the first one it can express. */
  function quietEditableWindow() {
    var q = (draft.repeat && draft.repeat.quiet) || null;
    return ((q && q.windows) || []).filter(quietWindowEditable)[0] || null;
  }

  /** The rest: windows only the API can express, shown but never rewritten. */
  function quietExtraWindows() {
    var q = (draft.repeat && draft.repeat.quiet) || null;
    var editable = quietEditableWindow();
    return ((q && q.windows) || []).filter(function (w) { return w !== editable; });
  }

  function quietExtraRowHtml(w) {
    return '<div class="aw-quiet-extra" style="display:flex;align-items:center;gap:8px;border:1px solid var(--color-border);' +
        'border-radius:6px;padding:5px 8px;margin-top:6px">' +
      '<span style="font-size:0.85rem">' + escapeHtml(quietSummary(w)) + '</span>' +
      '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">— set through the API; edit it there</span>' +
      '<button type="button" class="aw-quiet-extra-remove btn-icon" title="Remove this quiet period" ' +
        'aria-label="Remove this quiet period" style="margin-left:auto;border:1px solid var(--color-border);' +
        'border-radius:4px;background:transparent;color:var(--color-text-secondary);cursor:pointer;width:26px;height:26px">×</button>' +
    '</div>';
  }

  function quietControlHtml() {
    var q = (draft.repeat && draft.repeat.quiet) || null;
    var wins = (q && q.windows) || [];
    var editable = quietEditableWindow();
    var extras = quietExtraWindows();
    var clock = quietMeta().serverClock;
    // The zone is NOT decoration: the hours are the server's wall clock, and an
    // operator in another zone picking 22:00 from their own head is the trap
    // maintenanceRecurrence.serverClockInfo exists for.
    var zone = clock ? (clock.timeZone || ("UTC" + (clock.offsetMinutes >= 0 ? "+" : "-") +
      Math.floor(Math.abs(clock.offsetMinutes) / 60))) : "";
    return '' +
      '<label style="display:block;margin:0.5rem 0 0;font-weight:400">' +
        '<input type="checkbox" id="aw-quiet-on"' + (wins.length ? " checked" : "") + '> ' +
        'Quiet time' +
      '</label>' +
      '<div id="aw-quiet-fields" style="margin:4px 0 0 1.4rem"' + (wins.length ? "" : ' hidden') + '>' +
        // The SAME editor the Maintenance modal uses — one day per row, each
        // off, all day, or carrying its own hour ranges.
        '<div id="aw-quiet-editor">' +
          window.PolarisRecurrence.dayEditorHtml({
            shape: editable,
            allOff: !editable && extras.length > 0,
            zone: zone,
          }) +
        '</div>' +
        '<div id="aw-quiet-extras">' + extras.map(quietExtraRowHtml).join("") + '</div>' +
        '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:6px 0 0">' +
          'Reminders due during a quiet period are <strong>held, not skipped</strong>: when it ends, the next reminder ' +
          'goes out straight away and says how long the alert has been active. The first alert, escalations and ' +
          'reset notifications are never quiet.' +
        '</p>' +
      '</div>';
  }

  /** Stash each read-only row's source shape so it is re-sent verbatim. */
  function stashQuietWindows(panel) {
    var extras = quietExtraWindows();
    var rows = panel.querySelectorAll("#aw-quiet-extras .aw-quiet-extra");
    for (var i = 0; i < rows.length; i++) rows[i]._quietWindow = extras[i] || null;
  }

  /**
   * The whole quiet time: the day/hours editor's window first, then whatever
   * read-only rows survive.
   *
   * A day editor with nothing ticked contributes NO window rather than an
   * error — a quiet time whose only window came from the API is a real state
   * (see `allOff`). validateStep5 is what refuses a ticked Quiet time with
   * nothing behind it at all.
   */
  function collectQuiet(panel) {
    var on = panel.querySelector("#aw-quiet-on");
    if (!on || !on.checked) return null;
    var out = [];
    var host = panel.querySelector("#aw-quiet-editor");
    if (host) {
      var got = window.PolarisRecurrence.collectDayEditor(host);
      if (!got.error && !got.empty) {
        out.push(Object.assign({ version: 1, kind: "recurring" }, got));
      }
    }
    panel.querySelectorAll("#aw-quiet-extras .aw-quiet-extra").forEach(function (row) {
      if (row._quietWindow) out.push(row._quietWindow);
    });
    return out.length ? { windows: out } : null;
  }

  /** The day editor's own problem with what is typed, or "" when it is fine. */
  function quietEditorProblem(panel) {
    var host = panel && panel.querySelector("#aw-quiet-editor");
    if (!host) return "";
    var got = window.PolarisRecurrence.collectDayEditor(host);
    if (got.error) return "Quiet time — " + got.error;
    // "No days" is only a problem when nothing else supplies a window.
    if (got.empty && panel.querySelectorAll("#aw-quiet-extras .aw-quiet-extra").length === 0) {
      return "Quiet time: pick the days and hours, or untick Quiet time.";
    }
    return "";
  }

  /** The live volume line + the two conditional warnings. */
  function syncRepeatNote() {
    var panel = document.getElementById("aw-step-5");
    if (!panel) return;
    var on = panel.querySelector("#aw-repeat-on");
    var fields = panel.querySelector("#aw-repeat-fields");
    if (fields) fields.hidden = !(on && on.checked);
    var note = panel.querySelector("#aw-repeat-note");
    if (!note || !on || !on.checked) return;

    var every = Number((panel.querySelector("#aw-repeat-every") || {}).value) || 0;
    var stopAfter = Number((panel.querySelector("#aw-repeat-stopafter") || {}).value) || 0;
    var quiet = collectQuiet(panel);
    var bits = [];
    if (every >= 1) {
      var perDay = Math.round((24 * 60) / every);
      // Per RECIPIENT, because the count is unknowable client-side the moment a
      // dynamic pill is in play.
      bits.push("Every " + every + " minutes = about <strong>" + perDay + " per day, per recipient</strong>" +
        (stopAfter ? ", stopping after " + stopAfter + " hour" + (stopAfter === 1 ? "" : "s") + "." : ", until someone acknowledges or the alert clears."));
      if (draftHasDynamicRecipient()) bits.push("× everyone those recipients resolve to at fire time.");
    }
    // Manual reset means nothing clears it on its own, so "until it's handled"
    // really does mean forever.
    if (draft.reset && draft.reset.mode === "manual") {
      bits.push('<span style="color:var(--color-warning)">This automation only clears when someone clears it by hand, so reminders will not stop on their own.</span>');
    }
    if (draftHasAnyEscalation()) {
      bits.push("This automation also escalates; a reminder and an escalation can arrive in the same minute." +
        (quiet ? " Escalations are not held by quiet time." : ""));
    }
    if (quiet && stopAfter) {
      // The give-up clock is wall time from the FIRE, quiet included. Worth
      // saying out loud: an operator reading "quiet 22:00–06:00" and "give up
      // after 8 hours" would reasonably expect the two not to interact, and
      // the outcome is an alert nobody is reminded about again.
      bits.push('<span style="color:var(--color-warning)">“Give up after ' + stopAfter + ' hour' +
        (stopAfter === 1 ? "" : "s") + '” counts quiet time too — if the quiet period outlasts it, no further ' +
        'reminders are sent and the held one is dropped.</span>');
    }
    // Every day, and no hours on any of them, is a quiet time with no gaps for
    // a reminder to arrive in. Read through the shared resolver rather than by
    // testing one field, since "all day" can be said three ways now (no
    // `hours`, an empty per-day list, or the absent legacy pair).
    if (quiet && (quiet.windows || []).some(function (w) {
      if (w.kind !== "recurring" || (w.freq !== "daily" && (w.daysOfWeek || []).length !== 7)) return false;
      for (var d = 0; d < 7; d++) {
        if (window.PolarisRecurrence.dayRanges(w, d) !== null) return false;
      }
      return true;
    })) {
      bits.push('<span style="color:var(--color-warning)">A quiet period covering every day, all day holds every ' +
        'reminder indefinitely — untick “Repeat this notification” instead if that is what you want.</span>');
    }
    note.innerHTML = bits.join(" ");
  }

  /** Does any notify action route to a recipient resolved at fire time? */
  function draftHasDynamicRecipient() {
    return (draft.actions || []).some(function (a) {
      return a && a.type === "notify" && (a.recipientDeviceRegion || a.recipientAssetContacts ||
        a.recipientAllUsers || a.recipientAllRegions || (a.recipientDeviceRegionLevels || []).length);
    });
  }

  function draftHasAnyEscalation() {
    if (draft.escalation && (draft.escalation.tiers || []).length) return true;
    if ((draft.actions || []).some(function (a) { return a && a.escalation && (a.escalation.tiers || []).length; })) return true;
    return ((draft.severityBands || []).some(function (b) {
      return (b && b.escalation && (b.escalation.tiers || []).length) ||
        (b && (b.actions || []).some(function (a) { return a && a.escalation && (a.escalation.tiers || []).length; }));
    }));
  }

  function actionSummary(a) {
    if (a.type === "notify") {
      var chs = actionChannels(a);
      var via = chs.length
        ? chs.map(function (x) { return x.name; }).join(" + ")
        : "…";
      // The preference filter changes WHO each channel reaches, so it belongs
      // in the one-line summary a folded action shows.
      return "Notify via " + via + notifySuffix(a) +
        (a.respectUserPreference && chs.length > 1 ? " (by each user’s preferred method)" : "");
    }
    if (a.type === "api_call") return (a.method || "POST") + " " + (a.url || "…");
    if (a.type === "script") {
      var sc = scriptById(a.scriptId);
      return "Run " + (sc ? sc.name : "…") + " on " + (a.runOn || "server");
    }
    if (a.type === "event") return "Write an audit Event";
    return a.type;
  }
  function renderStep5() {
    var panel = document.getElementById("aw-step-5");
    var esc = draft.escalation;
    // The mandatory first "action": every fire creates the in-app alert (and,
    // for metric/state/composite triggers, writes an audit Event carrying the
    // same rendered message). Not removable — only its message is editable.
    // Sibling of #aw-actions, so collectActionsFrom's :scope > .aw-action
    // never picks it up.
    var isEC = draft.trigger && (draft.trigger.type === "event" || draft.trigger.type === "change");
    // The in-app alert is genuinely unremovable, unlike the audit Event next to
    // it: every delivery row hangs off the Notification id, as do the
    // escalation sweep, acknowledge/clear and the rule state machine. The Event
    // moved out to a removable "Create an Event" action in the list below.
    var cardTitle = "Create an in-app alert (always happens)";
    var cardHelp = isEC
      ? "Every fire creates an in-app alert (the Alerts tab). This is built in and can’t be removed — notifications, API calls and scripts all hang off it. The message template below customizes the alert text — {value} is the source event’s own message; leave blank for the default."
      : "Every fire creates an in-app alert (the Alerts tab). This is built in and can’t be removed — notifications, API calls and scripts all hang off it. The message template below customizes what the alert and the audit Event say; leave blank for the default.";
    var html = '<h3 style="margin:0 0 0.25rem">What should happen?</h3>' +
      '<p style="font-size:0.85rem;color:var(--color-text-tertiary);margin:0 0 0.75rem">Notifications route through Delivery-tab channels; API calls POST to your systems; scripts run on the Polaris server or the triggering asset’s agent.</p>' +
      '<div class="form-group" id="aw-inapp-card" style="border:1px solid var(--color-border);border-radius:6px;padding:0.75rem">' +
        '<label style="font-weight:600;margin:0 0 4px;display:block">' + cardTitle + '</label>' +
        '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0 0 6px">' + cardHelp + '</p>' +
        tokenPaletteHtml("aw-token-palette") +
        '<input type="text" id="aw-msg" class="tpl-field" value="' + escapeHtml(draft.messageTemplate || "") + '" placeholder="' + (isEC ? "{rule}: {value}" : "{asset} {metric} = {value} (threshold {threshold})") + '" style="width:100%;margin-top:4px">' +
        // Belongs on this card, not on a Notify row: it is a property of the
        // ALERT record — who may close it out and on what terms — and it is
        // enforced on every acknowledge path (the Alerts tab, the phone, the
        // emailed link, the push button), not just the ones that send email.
        '<label style="display:block;margin:0.6rem 0 0;font-weight:400">' +
          '<input type="checkbox" id="aw-require-ack-note"' + (draft.requireAckNote ? " checked" : "") + '> ' +
          'Require a note when acknowledging' +
        '</label>' +
        '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:2px 0 0 1.4rem">Acknowledging asks what the problem was and what the fix was, and won’t go through empty. Escalation still stops on acknowledge.</p>' +
        repeatControlHtml() +
      '</div>';

    // Per-severity action sections: with severity bands, each tier CAN get its
    // own actions (server: band actions run when the alert ENTERS that band; an
    // empty band falls back to the base actions). That's opt-in, mirroring the
    // trigger step's "use multiple severity levels" — off (the default) means
    // one action list that runs at every severity, which is what most
    // automations want. Single-severity mode = one list, no checkbox.
    var bands = (bandsApplicable(draft.trigger) && draft.severityBands) || [];
    var perSev = !!bands.length && bandActionsPerSeverityOn();
    if (bands.length) {
      html += '<div class="form-group"><label><input type="checkbox" id="aw-band-actions-multi"' + (perSev ? " checked" : "") + '> Use different actions for each severity level</label>' +
        '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:2px 0 0 1.4rem">Leave this off to run the same actions whenever the alert changes severity.</p></div>';
    }
    // Same shape the trigger step's tiers use: heading, then the tier's own
    // condition in the shared summary style. The base tier showed no condition at
    // all here, which made it read as a different kind of block from the ones
    // below it — the exact mismatch the trigger step already fixed.
    var basePhrase = tierConditionPhrase(
      draft.trigger && draft.trigger.operator,
      draft.trigger && draft.trigger.threshold,
      baseHoldPhrase(draft.trigger),
    );
    var baseLabel = perSev
      ? 'Actions at <span style="color:' + sevColor(draft.severity) + '">' + escapeHtml(draft.severity) + '</span> <span class="aw-tier-qual">(base severity)</span>'
      : "Actions when this fires";
    // Folded on arrival: with a severity ladder this step is three or four action
    // lists, and the summary line on each header says enough to choose between
    // them. Step 3's tiers stay OPEN by contrast — their content is the condition
    // being edited, not a list to skim.
    html += '<div class="form-group"' + (perSev ? ' data-collapse-key="t5:base" data-collapse-default="closed"' : "") + ' style="' + (perSev ? "border-left:3px solid " + sevColor(draft.severity) + ";padding-left:0.6rem" : "") + '">' +
      '<div class="aw-collapse-head" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
        (perSev ? collapseBtnHtml("t5:base") : "") +
        '<label class="aw-tier-label" style="margin:0">' + baseLabel + '</label>' +
        (perSev && basePhrase ? '<span class="aw-tier-cond">' + escapeHtml(basePhrase) + '</span>' : "") +
      '</div>' +
      '<div class="aw-collapse-body">' +
      (perSev ? '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:2px 0 6px">These actions also run at higher severities that don’t define their own.</p>'
        : bands.length ? '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:2px 0 6px">These run at every severity level — each time the alert climbs or eases into a new one.</p>' : "") +
      '<div id="aw-actions"></div>' +
      '<button type="button" class="btn btn-sm btn-secondary" id="aw-add-action" style="margin-top:6px">+ Add action</button>' +
      // Escalation belongs to the SEVERITY, not to one action inside it: "if
      // this alert stays unhandled, do more" is a fact about the alert at this
      // severity, and hanging it off a single Notify row made it read as "if
      // this email goes unanswered" while the same chain fired for the whole
      // tier. The base section's chain IS the rule-level `escalation` — which is
      // what the engine resolves for an alert sitting at the base severity.
      escSectionHtml() +
      '</div>' +
    '</div>';
    bands.forEach(function (b, i) {
      // A tier may override the comparison and the hold; both belong in the
      // phrase, or "for 1 min" on a critical tier is invisible on this step.
      var bandPhrase = tierConditionPhrase(
        b.operator || (draft.trigger && draft.trigger.operator),
        b.threshold,
        // The same phrase the trigger step's folded tier shows, from the same
        // helper: a tier inherits the trigger's hold (rule 19), which an
        // AGGREGATED trigger doesn't have at all — its period is the
        // measurement window and lives in `windowSec`.
        bandHoldPhrase(draft.trigger, b),
      );
      var bandCount = ((b.actions || []).length);
      html += '<div class="form-group aw-band-actions" data-band-idx="' + i + '" data-collapse-key="t5:' + escapeHtml(b.severity) + '" data-collapse-default="closed" style="border-left:3px solid ' + sevColor(b.severity) + ';padding-left:0.6rem' + (perSev ? "" : ";display:none") + '">' +
        '<div class="aw-collapse-head" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
          collapseBtnHtml("t5:" + b.severity) +
          '<label class="aw-tier-label" style="margin:0">Actions at <span style="color:' + sevColor(b.severity) + '">' + escapeHtml(b.severity) + '</span></label>' +
          '<span class="aw-tier-cond">' + escapeHtml(bandPhrase) + '</span>' +
          // A folded section still says how much is inside it, so "no actions
          // here" (which falls back to the base) is visible without unfolding.
          '<span class="aw-collapse-summary" style="margin:0;display:none">' +
            (bandCount ? bandCount + " action" + (bandCount === 1 ? "" : "s") : "no actions of its own") +
          '</span>' +
        '</div>' +
        '<div class="aw-collapse-body">' +
        '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:2px 0 6px">' + escapeHtml((s.bandMeta && s.bandMeta.emptyBandNote) || "Leave empty to run the base actions at this severity.") + '</p>' +
        '<div class="ba-actions"></div>' +
        '<button type="button" class="btn btn-sm btn-secondary ba-add" style="margin-top:6px">+ Add action</button>' +
        // The band's own chain (severityBands[i].escalation) — the one the sweep
        // resolves while the alert sits in THIS band.
        escSectionHtml() +
        '</div>' +
      '</div>';
    });
    // ── When this resets ────────────────────────────────────────────────
    // Every clear path today writes cleared/clearedBy and nothing else, so
    // "tell the NOC it came back" wasn't expressible. The list starts mirroring
    // the trigger's Notify actions (see mirroredResetActions) so the recovery
    // reaches the same people without configuring them twice.
    // The toggle is its OWN state, not "is the list non-empty": a re-render
    // between an operator ticking it and adding a row would otherwise silently
    // untick it. On a new automation it starts on (the list seeds from the
    // trigger's notify actions); a stored rule reflects what it saved.
    if (draft.resetOn === undefined) {
      draft.resetOn = draft.resetActions === undefined
        ? true
        : !!(draft.resetActions && draft.resetActions.length);
    }
    var resetOn = draft.resetOn;
    html += '<div class="form-group" id="aw-reset-card" style="border:1px solid var(--color-border);border-radius:6px;padding:0.75rem;margin-top:0.5rem">' +
      '<label style="font-weight:600;margin:0 0 4px;display:block">' +
        '<input type="checkbox" id="aw-reset-actions-on"' + (resetOn ? " checked" : "") + '> When this resets' +
      '</label>' +
      '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0 0 6px">' +
        'Runs when the alert ends — it recovered, its timer ran out, or someone cleared it. ' +
        '<span id="aw-reset-mirror-note"></span></p>' +
      '<div id="aw-reset-wrap"' + (resetOn ? "" : ' style="display:none"') + '>' +
        '<div id="aw-reset-actions"></div>' +
        '<button type="button" class="btn btn-sm btn-secondary" id="aw-reset-add" style="margin-top:6px">+ Add action</button>' +
      '</div>' +
    '</div>';

    panel.innerHTML = html;

    // Mandatory-card escalation = the rule-level chain.
    // One chain per severity section: the base section carries the rule-level
    // chain, each band section its own.
    var baseSec = panel.querySelector("#aw-actions") && panel.querySelector("#aw-actions").closest(".form-group");
    if (baseSec) wireEscSection(baseSec.querySelector(":scope > .aw-collapse-body > .aw-esc-sec, :scope > .aw-esc-sec"), esc);
    panel.querySelectorAll(".aw-band-actions").forEach(function (sec, i) {
      var band = (draft.severityBands || [])[i] || {};
      wireEscSection(sec.querySelector(":scope > .aw-collapse-body > .aw-esc-sec, :scope > .aw-esc-sec"), band.escalation || null);
    });

    var host = panel.querySelector("#aw-actions");
    // escalatable=false: the chain lives on the section now (see escSectionHtml
    // above), so an action row carries no footer of its own.
    (draft.actions || []).forEach(function (a) { addActionRow(host, a, false); });
    panel.querySelector("#aw-add-action").addEventListener("click", function () {
      foldActionRow(addActionRow(host, null, false), false);
      syncResetMirror(panel);
    });
    // The reset list follows the trigger list as it is BUILT: picking a channel
    // on a new Notify action, or removing one, re-derives the mirrored rows.
    // Delegated so it covers rows added later. Timeout lets the row's own
    // handlers (and its removal) settle first.
    host.addEventListener("change", function () { setTimeout(function () { syncResetMirror(panel); }, 0); });
    host.addEventListener("click", function (e) {
      if (e.target && e.target.classList && e.target.classList.contains("aw-action-remove")) {
        setTimeout(function () { syncResetMirror(panel); }, 0);
      }
    });

    panel.querySelectorAll(".aw-band-actions").forEach(function (sec, i) {
      var bHost = sec.querySelector(".ba-actions");
      (((draft.severityBands || [])[i] || {}).actions || []).forEach(function (a) { addActionRow(bHost, a, false); });
      sec.querySelector(".ba-add").addEventListener("click", function () { foldActionRow(addActionRow(bHost, null, false), false); });
    });
    // Reset list: hydrate, then keep it following the trigger actions.
    var resetHost = panel.querySelector("#aw-reset-actions");
    var resetSeed = draft.resetActions === undefined
      // Brand-new automation: the audit Event is present by default on BOTH
      // halves, so a recovery is recorded the way the firing is (the draft's
      // `actions` seeds the same row), plus whatever the trigger's Notify
      // actions mirror in. It is an ordinary operator row — remove it and the
      // mirror leaves it removed.
      ? mirroredResetActions(draft.actions, [{ type: "event" }])
      : (draft.resetActions || []);                         // stored, or explicitly off
    renderResetRows(panel, resetSeed);
    panel.querySelector("#aw-reset-add").addEventListener("click", function () {
      foldActionRow(addActionRow(resetHost, null), false);
      refreshMirrorNote(panel);
    });
    // Removing the LAST reset action IS "no reset behavior", so say it on the
    // toggle instead of leaving a ticked box over an empty list — collectStep5
    // saves an empty list as null anyway, so the box would come back unticked
    // on the next open. Delegated (rows come and go with the mirror); the
    // timeout lets the row's own remove handler detach it first.
    resetHost.addEventListener("click", function (e) {
      if (!(e.target && e.target.classList && e.target.classList.contains("aw-action-remove"))) return;
      setTimeout(function () {
        if (resetHost.querySelector(".aw-action")) return;
        var cb = panel.querySelector("#aw-reset-actions-on");
        if (cb) cb.checked = false;
        draft.resetOn = false;
        var wrap = panel.querySelector("#aw-reset-wrap");
        if (wrap) wrap.style.display = "none";
        refreshMirrorNote(panel);
      }, 0);
    });
    panel.querySelector("#aw-reset-actions-on").addEventListener("change", function () {
      draft.resetOn = this.checked;
      panel.querySelector("#aw-reset-wrap").style.display = this.checked ? "" : "none";
      // Turning it back on re-seeds from the trigger rather than leaving the
      // operator with an empty list they have to rebuild by hand.
      if (this.checked && !resetHost.querySelector(".aw-action")) {
        renderResetRows(panel, mirroredResetActions(collectActionsFrom(host), [{ type: "event" }]));
      }
      refreshMirrorNote(panel);
    });

    var repToggle = panel.querySelector("#aw-repeat-on");
    if (repToggle) {
      ["#aw-repeat-on", "#aw-repeat-every", "#aw-repeat-stopon", "#aw-repeat-stopafter"].forEach(function (sel) {
        var el = panel.querySelector(sel);
        if (el) el.addEventListener(el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input", function () {
          if (sel === "#aw-repeat-on") { collectStep5(); }
          syncRepeatNote();
        });
      });
      // Quiet time: the shared editor owns its own rows and their handlers
      // (window.PolarisRecurrence.wire delegates on the host, so adding and removing
      // hour ranges needs nothing from here) and calls back on every change.
      stashQuietWindows(panel);
      var quietOn = panel.querySelector("#aw-quiet-on");
      var quietFields = panel.querySelector("#aw-quiet-fields");
      var quietHost = panel.querySelector("#aw-quiet-editor");
      if (quietOn) {
        quietOn.addEventListener("change", function () {
          if (quietFields) quietFields.hidden = !quietOn.checked;
          collectStep5();
          syncRepeatNote();
        });
      }
      if (quietHost) {
        window.PolarisRecurrence.wire(quietHost, function () {
          collectStep5();
          syncRepeatNote();
        });
      }
      var quietExtras = panel.querySelector("#aw-quiet-extras");
      if (quietExtras) {
        quietExtras.addEventListener("click", function (ev) {
          var btn = ev.target.closest && ev.target.closest(".aw-quiet-extra-remove");
          if (!btn) return;
          // Removing an API-authored window is explicit, and only removal is
          // offered: this wizard cannot express one, so any "edit" it allowed
          // would be a rewrite into something else.
          var row = btn.closest(".aw-quiet-extra");
          if (row) row.remove();
          collectStep5();
          syncRepeatNote();
        });
      }
      syncRepeatNote();
    }
    var perSevCb = panel.querySelector("#aw-band-actions-multi");
    if (perSevCb) {
      perSevCb.addEventListener("change", function () {
        // Collect first so per-tier rows already typed survive the re-render
        // (they stay on the draft while the toggle is off and are stripped only
        // at save, so an accidental un-tick doesn't destroy them).
        collectStep5();
        draft.bandActionsPerSeverity = perSevCb.checked;
        renderStep5();
      });
    }
    wireTokenPalette(panel);
    wireCollapsibles(panel);
  }
  /** Whether the per-severity action sections are in play. Explicit once the
   *  operator touches the toggle; inferred from the record otherwise, so an
   *  automation authored with per-band actions re-opens showing them. */
  function bandActionsPerSeverityOn() {
    if (typeof draft.bandActionsPerSeverity === "boolean") return draft.bandActionsPerSeverity;
    return (draft.severityBands || []).some(function (b) {
      return (b.actions && b.actions.length) || (b.escalation && b.escalation.tiers && b.escalation.tiers.length);
    });
  }

  // ── Per-item escalation section (the mandatory card + every action row) ──
  // "Escalate if unhandled": tiers of follow-up actions on a delay. The card's
  // section maps to the rule-level chain; an action row's section maps to
  // action.escalation. Tier-hosted action rows never render one (no nesting —
  // the server schema rejects chains inside escalation tiers).
  function escSectionHtml() {
    return '<div class="aw-esc-sec" style="margin-top:8px;border-top:1px dashed var(--color-border);padding-top:6px">' +
      '<div class="aesc-config" style="display:none;margin-bottom:4px"><label style="font-size:0.78rem">Stop escalating when</label> ' +
        '<select class="aesc-stopon" style="width:auto"><option value="acknowledge">Acknowledged (or cleared)</option><option value="clear">Cleared only — acknowledging does not stop it</option></select></div>' +
      '<div class="aesc-tiers"></div>' +
      '<button type="button" class="btn btn-sm btn-secondary aesc-add" style="margin-top:4px">+ Escalate if unhandled…</button>' +
    '</div>';
  }
  function wireEscSection(sec, esc) {
    if (!sec) return;
    var tiersHost = sec.querySelector(".aesc-tiers");
    var sync = function () {
      sec.querySelector(".aesc-config").style.display = tiersHost.querySelectorAll(":scope > .aw-tier").length ? "block" : "none";
    };
    if (esc && esc.stopOn) sec.querySelector(".aesc-stopon").value = esc.stopOn;
    ((esc && esc.tiers) || []).forEach(function (t) { addTierRow(tiersHost, t, sync); });
    sync();
    sec.querySelector(".aesc-add").addEventListener("click", function () {
      var max = (s.escalationMeta && s.escalationMeta.maxTiers) || 5;
      if (tiersHost.querySelectorAll(":scope > .aw-tier").length >= max) { showToast("Maximum " + max + " escalation tiers", "info"); return; }
      var row = addTierRow(tiersHost, null, sync);
      // Seed a notify action so the channel + recipient fields are right
      // there — an escalation without an action can't do anything anyway.
      foldActionRow(addActionRow(row.querySelector(".tier-actions"), null), false);
      sync();
    });
  }
  function collectEscSection(sec) {
    if (!sec) return null;
    var tiers = collectTierRows(sec.querySelector(".aesc-tiers"));
    return tiers.length ? { stopOn: sec.querySelector(".aesc-stopon").value, tiers: tiers } : null;
  }

  // ── Severity bands (numeric single-metric triggers) — live on step 3 (with
  //    the trigger, since bands are threshold-defined). Built lazily into
  //    #aw-bands-host and shown only while the trigger is a single numeric
  //    metric; syncBandsVisibility toggles as the trigger tree changes. ────────
  function bandBaseNoteHtml() {
    var tr = draft.trigger || {};
    var opPhrase = ((s.comparatorPhrases || {})[tr.operator]) || tr.operator || ">=";
    return 'This condition alerts at severity <strong>' + escapeHtml(draft.severity) + '</strong> when the value ' + escapeHtml(opPhrase) + ' <strong>' + escapeHtml(String(tr.threshold != null ? tr.threshold : "?")) + '</strong> (its actions live on the Actions step). Add another severity to escalate as the value climbs further.';
  }
  function bandsSectionHtml() {
    // Base severity + the first "+ Severity" live INSIDE the condition group
    // header (injectBaseSeverity); this section holds the added tier groups +
    // the notify policy. #aw-band-base-note is kept (hidden) for legacy callers.
    return '<div id="aw-bands-section">' +
      '<p id="aw-band-base-note" style="display:none"></p>' +
      '<div id="aw-bands"></div>' +
      '<button type="button" class="btn btn-sm btn-secondary" id="aw-band-add" style="margin-top:4px;display:none">+ Severity</button>' +
      '<div id="aw-band-notify" style="display:none;margin-top:10px;border-top:1px solid var(--color-border);padding-top:8px">' +
        '<label style="font-weight:600;font-size:0.82rem;display:block;margin:0 0 4px">Notify on</label>' +
        '<label style="font-size:0.82rem;display:block"><input type="checkbox" id="aw-bn-increase" checked> Severity increase (re-notify with the new band’s actions)</label>' +
        '<label style="font-size:0.82rem;display:block"><input type="checkbox" id="aw-bn-decrease"> Severity decrease (run the lower band’s actions)</label>' +
        // No "Resolved" row, and no note about where recovery went either: this
        // list is what to notify on as the severity MOVES, and the reset actions
        // are self-explanatory on the step that owns them. The checkbox was a
        // second mechanism for one event and the engine ran BOTH (fireResolved for
        // the band, then fireReset from recover()), so a banded automation with
        // reset actions told people twice.
      '</div>' +
    '</div>';
  }
  function bandSeverityOptions(sel) {
    return (s.severities || []).map(function (sv) {
      return '<option value="' + sv + '"' + (sv === sel ? " selected" : "") + '>' + escapeHtml(sv) + '</option>';
    }).join("");
  }
  function wireBandsSection(panel) {
    var section = panel.querySelector("#aw-bands-section");
    if (!section) return; // not a numeric single-metric trigger
    var bandsHost = panel.querySelector("#aw-bands");
    (draft.severityBands || []).forEach(function (b) { addBandRow(bandsHost, b); });
    var notifyBox = panel.querySelector("#aw-band-notify");
    var syncNotify = function () { notifyBox.style.display = bandsHost.querySelectorAll(".aw-band").length ? "block" : "none"; };
    panel.querySelector("#aw-band-add").addEventListener("click", function () { addBandRow(bandsHost, null); syncNotify(); });
    // Notify policy state.
    var bn = draft.bandNotify || {};
    panel.querySelector("#aw-bn-increase").checked = bn.onIncrease !== false;
    panel.querySelector("#aw-bn-decrease").checked = bn.onDecrease === true;
    syncNotify();
  }

  /**
   * A stored rule may still carry the retired band-level resolved policy. Saving
   * it now writes `onResolved:false`, so anything it announced on recovery would
   * go silent — unless it moves to the reset actions, which is where recovery is
   * announced from. So it does, once, and only into an EMPTY list:
   *
   *   resolvedMode "dedicated" → its own resolvedActions, verbatim.
   *   resolvedMode "reuse"     → the trigger's notify actions, which is what
   *                              "reuse the alert's actions" resolved to anyway.
   *
   * An operator who already wrote their own reset actions is left alone — they've
   * said what recovery should do.
   */
  /**
   * Hoist per-ACTION escalation chains up to the severity that owns them.
   *
   * The builder no longer offers a chain on an action row, so a stored one would
   * be invisible — and leaving it in place would ALSO double-fire, since the
   * sweep walks the level chain plus one chain per action. Both halves are
   * therefore done together: adopt, then strip.
   *
   * Tiers carry their own actions, so concatenating several actions' tiers and
   * sorting by `afterMin` reproduces the same deliveries at the same times —
   * "at 10 minutes mail the NOC, at 20 page the on-call" survives whether those
   * two tiers came from one action's chain or two. `stopOn` takes the first
   * chain's value; the alternative is inventing a precedence between two
   * operator choices that were never meant to disagree.
   *
   * A level that ALREADY has its own chain is left alone — that's the operator's
   * explicit answer for this severity — and the action chains are stripped so the
   * total number of escalations doesn't grow.
   */
  function hoistActionEscalations(actions, levelEsc) {
    var chains = [];
    (actions || []).forEach(function (a) {
      if (a && a.escalation && (a.escalation.tiers || []).length) chains.push(a.escalation);
      if (a) delete a.escalation;
    });
    if (!chains.length) return levelEsc || null;
    // MERGE rather than pick: dropping a chain because the level already had one
    // would lose "at 20 minutes page the on-call" outright. Every tier that used
    // to exist for this severity becomes one ladder in time order, and since each
    // tier carries its own actions the deliveries and their timings are unchanged.
    var tiers = ((levelEsc && levelEsc.tiers) || []).slice();
    chains.forEach(function (c) { tiers = tiers.concat(c.tiers || []); });
    tiers.sort(function (x, y) { return (x.afterMin || 0) - (y.afterMin || 0); });
    // The level's stopOn wins when it has one — it is the operator's
    // severity-wide answer, and the alternative is inventing a precedence
    // between two settings that were never meant to disagree.
    return { stopOn: (levelEsc && levelEsc.stopOn) || chains[0].stopOn || "acknowledge", tiers: tiers };
  }

  /** Run the hoist over every severity: the rule level, then each band. */
  function hoistEscalationsToSeverities() {
    draft.escalation = hoistActionEscalations(draft.actions, draft.escalation);
    (draft.severityBands || []).forEach(function (b) {
      if (!b) return;
      var next = hoistActionEscalations(b.actions, b.escalation);
      if (next) b.escalation = next; else delete b.escalation;
    });
    // Reset actions are never escalatable (there is nothing to chase about a
    // recovery), so they only need the strip.
    (draft.resetActions || []).forEach(function (a) { if (a) delete a.escalation; });
  }

  function retireBandResolved() {
    adoptLegacyResolvedActions();
    if (draft.bandNotify) {
      draft.bandNotify.onResolved = false;
      delete draft.bandNotify.resolvedMode;
      delete draft.bandNotify.resolvedActions;
    }
  }

  function adoptLegacyResolvedActions() {
    var bn = draft.bandNotify || {};
    if (bn.onResolved === false) return;
    if ((draft.resetActions || []).length) return;
    var adopted = bn.resolvedMode === "dedicated"
      ? (bn.resolvedActions || []).slice()
      : mirroredResetActions(draft.actions, []);
    if (!adopted.length) return;
    draft.resetActions = adopted;
    // The toggle carries its OWN state (see the Actions step) — set it too, or a
    // re-render would untick it out from under the rows it just adopted.
    draft.resetOn = true;
  }
  // Severity colors (mirror styles.css .sev-select palette) for the accent.
  var SEV_COLORS = { notice: "var(--color-sev-notice)", informational: "var(--color-accent)", warning: "var(--color-warning)", serious: "var(--color-sev-serious)", critical: "var(--color-danger)" };
  function sevColor(sev) { return SEV_COLORS[sev] || "var(--color-accent)"; }
  function sevRankOf(sev) { return (s.severities || []).indexOf(sev); }
  // Paint the step heading + the conditions group border to the base severity.
  function applySevAccent(panel) {
    var color = sevColor(draft.severity || "warning");
    var h = panel.querySelector("#aw-step3-heading");
    if (h) h.style.color = color;
    var root = panel.querySelector("#aw-trig-root > .scg-group");
    if (root) root.style.borderLeftColor = color;
  }
  function multiSevOn(panel) {
    var cb = panel.querySelector("#aw-multi-sev");
    return !!(cb && cb.checked && bandsApplicable(draft.trigger));
  }
  // Single mode → standalone Alert severity dropdown; multi mode → the severity
  // levels panel (base severity + tiers) with the trigger's sampling shared.
  // Built lazily; re-syncs as the trigger tree / checkbox change without wiping
  // in-progress tiers. Also repaints the severity accent.
  function syncSeverityMode(panel) {
    var cb = panel.querySelector("#aw-multi-sev");
    var applicable = bandsApplicable(draft.trigger);
    if (cb) cb.disabled = !applicable;
    var multi = multiSevOn(panel);
    var singleWrap = panel.querySelector("#aw-single-sev-wrap");
    if (singleWrap) singleWrap.style.display = multi ? "none" : "";
    var hostWrap = panel.querySelector("#aw-bands-host");
    if (hostWrap) {
      if (multi) {
        if (!hostWrap._built) { hostWrap.innerHTML = bandsSectionHtml(); hostWrap._built = true; wireBandsSection(panel); }
        hostWrap.style.display = "";
      } else {
        hostWrap.style.display = "none";
      }
    }
    // Base severity + the first "+ Severity" live in the condition group header.
    injectBaseSeverity(panel, multi);
    if (multi) syncBaseTierRemove(panel);
    applySevAccent(panel);
  }
  function sevSelectHtml(cls, sev) {
    return '<select class="' + cls + ' sev-select sev-' + escapeHtml(sev) + '" style="width:auto">' + bandSeverityOptions(sev) + '</select>';
  }
  // In multi mode, inject a Base severity select into the condition group header
  // (before the AND/OR select) + a "+ Severity" button in the group's button row,
  // and accent the group border. Removed again in single mode. Idempotent.
  /**
   * One × per severity block. With a single condition the header's × stands in
   * for the row's (matching the bands, whose × is right-aligned on the severity
   * line); with several conditions each row keeps its own, because a header
   * button could not say WHICH one it removes.
   */
  function syncBaseTierRemove(panel) {
    var root = panel && panel.querySelector("#aw-trig-root > .scg-group");
    if (!root) return;
    var hx = root.querySelector(":scope > div > .scg-base-remove");
    // Filter rows don't count toward "single condition" — the base tier is
    // single when it holds ONE metric condition, however many identifier /
    // name filters narrow it — and their own × always stays visible (a filter
    // is removable regardless of how many conditions there are).
    var rows = root.querySelectorAll(":scope > .scg-children > .scr-row:not([data-filter-row])");
    var groups = root.querySelectorAll(":scope > .scg-children > .scg-group");
    var single = rows.length === 1 && groups.length === 0;
    if (hx) hx.style.display = single ? "" : "none";
    root.querySelectorAll(":scope > .scg-children > .scr-row:not([data-filter-row]) > .scr-remove").forEach(function (b) {
      b.style.display = single ? "none" : "";
    });
  }

  function injectBaseSeverity(panel, multi) {
    var root = panel.querySelector("#aw-trig-root > .scg-group");
    if (!root) return;
    var header = root.querySelector(":scope > div"); // header row (holds .scg-op)
    var btnRow = root.querySelector(":scope > .scg-btnrow") || root.querySelector(":scope > div:last-child"); // +Condition/+Group row
    if (btnRow) btnRow.classList.add("scg-btnrow"); // pinned: the duration field moves in below the conditions
    var existingSev = header && header.querySelector(".scg-sev-wrap");
    var existingAdd = btnRow && btnRow.querySelector(".scg-add-sev");
    // The hold lives INSIDE the base tier in multi-severity mode, below its
    // conditions — where every added tier carries the same field as a read-only
    // mirror (syncBandDurationMirrors). Left between the first tier and the
    // second it read as the first tier's own hold; inside the block, with each
    // later tier showing the count it will wait out, the ladder states the one
    // hold in every tier instead of once, ambiguously, between two of them.
    // Single-severity mode moves it back out to #aw-trigger-fields, where there
    // is no tier for it to belong to.
    var durGroup = panel.querySelector("#tf-duration-min");
    durGroup = durGroup && durGroup.closest(".aw-dur");
    var sustainGroup = panel.querySelector(".aw-ratio-sustain");
    if (!multi) {
      if (existingSev) existingSev.remove();
      if (existingAdd) existingAdd.remove();
      // Out of the tier AND out of its fold: a group left collapsed when the
      // operator switched back to one severity would take the hold's display
      // with it, and nothing outside a severity block would ever restore it.
      [durGroup, sustainGroup].forEach(function (g) {
        if (!g || !root.contains(g)) return;
        g.classList.remove("aw-collapse-part");
        g.style.display = g.getAttribute("data-hold-off") === "1" ? "none" : "";
        panel.querySelector("#aw-trigger-fields").appendChild(g);
      });
      root.style.borderLeftColor = "";
      // Put the group's own chrome back: with one severity there is no tier to
      // line up with, so the combinator shares the header row again and each
      // condition keeps its own remove button.
      var wrappedOp = header && header.querySelector(":scope > .scg-op");
      if (wrappedOp) {
        wrappedOp.style.flex = "1";
        wrappedOp.style.width = "";
        wrappedOp.style.order = "";
        wrappedOp.style.marginTop = "";
      }
      if (header) header.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:2px";
      var baseX = header && header.querySelector(".scg-base-remove");
      if (baseX) baseX.remove();
      var baseChev = header && header.querySelector(".aw-collapse");
      if (baseChev) baseChev.remove();
      var baseSum = header && header.querySelector(".aw-collapse-summary");
      if (baseSum) baseSum.remove();
      root.removeAttribute("data-collapse-key");
      root.querySelectorAll(".aw-collapse-part").forEach(function (el) {
        el.classList.remove("aw-collapse-part");
        el.style.display = "";
      });
      root.querySelectorAll(":scope > .scg-children > .scr-row > .scr-remove").forEach(function (b) {
        b.style.display = "";
      });
      return;
    }
    // Below the conditions, above the +Condition/+Group/+Severity row — the
    // place the mirrors take in every added tier. Re-anchored on each pass
    // rather than moved once: the tree re-renders under this function.
    if (btnRow) {
      if (durGroup) root.insertBefore(durGroup, btnRow);
      if (sustainGroup) root.insertBefore(sustainGroup, btnRow);
    }
    // The +Condition row is moved in/marked on a different tick, so (re)mark
    // whatever is currently there rather than assuming order.
    if (multi) {
      root.querySelectorAll(":scope > .scg-children, :scope > .scg-btnrow, :scope > .aw-dur, :scope > .aw-ratio-sustain").forEach(function (el) {
        el.classList.add("aw-collapse-part");
      });
    }
    if (header && !existingSev) {
      var wrap = document.createElement("span");
      wrap.className = "scg-sev-wrap";
      wrap.style.cssText = "display:flex;align-items:center;gap:6px;margin-right:6px";
      wrap.innerHTML = '<label class="aw-tier-label" style="margin:0">severity</label>' + sevSelectHtml("scg-sev", draft.severity || "warning");
      header.insertBefore(wrap, header.firstChild);
      // Take the BANDS' layout: severity alone on the header line with the
      // remove × right-aligned, and the AND/OR select on its own line below. The
      // base tier is a severity block like the others, so it should not be the
      // one that reads differently — and the combinator sharing a line with the
      // severity select made it look like a property OF that severity.
      header.classList.add("aw-collapse-head"); // applyCollapsed reveals the summary through this
      header.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:2px;flex-wrap:wrap";
      // WRAPPED, not moved: `tgCollectGroup` reads this group's combinator as
      // `:scope > div > .scg-op`, so relocating the select out of the header
      // makes collection throw — which silently broke Next and the tier
      // mirroring. Full-basis + flex order puts it on the second line while it
      // stays exactly where the collector looks for it.
      var opSel = header.querySelector(":scope > .scg-op");
      if (opSel) {
        opSel.style.flex = "0 0 100%";
        opSel.style.width = "100%";
        opSel.style.order = "2";
        opSel.style.marginTop = "2px";
      }
      // The × is the CONDITION's own remove button, proxied up into the header so
      // it sits where every band's × sits. A proxy rather than a move: the
      // builder's delegated handler resolves `closest(".scr-row")`, which a
      // relocated button would no longer find. syncBaseTierRemove keeps exactly
      // one × on screen — the header's while the base tier holds a single
      // condition (the only shape multi-severity mode allows, since the tiers
      // mirror one metric), each row's own once there are several to tell apart.
      // The chevron the added tiers have. Keyed "t3:base" rather than by
      // severity: unlike a band, the base block IS the automation's own severity,
      // so re-picking it must not look like a different block.
      var chev = document.createElement("span");
      chev.innerHTML = collapseBtnHtml("t3:base");
      header.insertBefore(chev.firstChild, header.firstChild);
      root.setAttribute("data-collapse-key", "t3:base");
      var sum = document.createElement("span");
      // `.aw-collapse-summary` carries its own size/colour now; `.hint` is scoped
      // `.form-group .hint` and this header is not inside one, which is exactly
      // why the trigger step's summaries used to render at full body size while
      // the identical span on the actions step came out small and grey.
      sum.className = "aw-collapse-summary";
      sum.style.cssText = "margin:0;display:none";
      header.insertBefore(sum, wrap.nextSibling);
      // Everything below the header line folds. Marked in place — see
      // applyCollapsed for why these can't be wrapped.
      root.querySelectorAll(":scope > .scg-children, :scope > .aw-dur, :scope > .aw-ratio-sustain, :scope > .scg-btnrow").forEach(function (el) {
        el.classList.add("aw-collapse-part");
      });
      if (opSel) opSel.classList.add("aw-collapse-part");

      var hx = document.createElement("button");
      hx.type = "button";
      hx.className = "btn btn-sm btn-danger scg-base-remove";
      hx.title = "Remove condition";
      hx.innerHTML = "&times;";
      hx.style.marginLeft = "auto"; // right-aligned on the severity line
      hx.style.order = "1";          // ...which the wrapped combinator follows
      hx.addEventListener("click", function () {
        // The proxied × removes the CONDITION, never a filter row that happens
        // to sit first in the group.
        var real = root.querySelector(".scg-children > .scr-row:not([data-filter-row]) .scr-remove");
        if (real) real.click();
      });
      header.appendChild(hx);
      wireCollapsibles(root);
      var syncBaseSummary = function () {
        var el = header.querySelector(".aw-collapse-summary");
        if (el) el.textContent = tierSummaryText(root);
      };
      syncBaseSummary();
      root.addEventListener("input", syncBaseSummary);
      root.addEventListener("change", syncBaseSummary);
      root._awBaseSummary = syncBaseSummary;
      var sel = wrap.querySelector(".scg-sev");
      sel.value = draft.severity || "warning"; // don't rely on the markup's selected attr
      sel.addEventListener("change", function () {
        draft.severity = sel.value;
        sel.className = "scg-sev sev-select sev-" + sel.value;
        applySevAccent(panel);
        syncBandAddButtons(panel);
      });
    }
    if (btnRow && !existingAdd) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn-sm btn-secondary scg-add-sev";
      b.style.marginLeft = "4px";
      b.textContent = "+ Severity";
      b.addEventListener("click", function () { addBandRow(panel.querySelector("#aw-bands"), null); syncBandNotify(panel); });
      btnRow.appendChild(b);
    }
    root.style.borderLeftColor = sevColor(draft.severity || "warning");
    syncBandAddButtons(panel);
  }
  function syncBandNotify(panel) {
    var box = panel.querySelector("#aw-band-notify");
    var host = panel.querySelector("#aw-bands");
    if (box && host) box.style.display = host.querySelectorAll(".aw-band").length ? "block" : "none";
  }
  // Default severity for a NEW tier: one rank above the most-severe existing
  // tier (or the base) — enforces the "only increase severity" rule.
  function nextTierSeverity(bandsHost) {
    var maxRank = sevRankOf(draft.severity || "warning");
    bandsHost.querySelectorAll(".band-severity").forEach(function (sel) { maxRank = Math.max(maxRank, sevRankOf(sel.value)); });
    var sevs = s.severities || [];
    return sevs[Math.min(maxRank + 1, sevs.length - 1)] || sevs[sevs.length - 1];
  }
  /** What a tier SHARES with the base condition (business rule 19): metric,
   *  aggregation, dimension filters. Only these are mirrored — a tier's own
   *  operator / threshold / sustained-for are its own. */
  function bandSampleSig(leaf) {
    return [leaf.type, leaf.metric, leaf.aggregation || "latest", JSON.stringify(leaf.dimensionFilter || {})].join("|");
  }
  /** Render + lock a tier's condition row. The shared-sampling controls (metric,
   *  aggregation, dimensions) come from the BASE condition and are disabled, so
   *  only the operator + value are the tier's own. (The window isn't a row
   *  control any more; tiers take the base's.) */
  function renderBandCond(row, panel, leaf, kind) {
    var cond = row.querySelector(".band-cond");
    cond.innerHTML = tgLeafRowHtml(leaf, kind);
    // Set the select values rather than relying on the markup's `selected`
    // attribute (the sevSel / scg-sev precedent) — this row is re-rendered in
    // place as the base condition changes, and a mirrored control silently
    // falling back to its first option would defeat the mirroring.
    var setVal = function (q, v) { var el = cond.querySelector(q); if (el && v != null && v !== "") el.value = v; };
    setVal(".tgl-what", "m:" + leaf.metric);
    setVal(".tgl-agg", leaf.aggregation || "latest");
    setVal(".tgl-op", leaf.operator);
    var df = leaf.dimensionFilter || {};
    cond.querySelectorAll(".tgl-dim").forEach(function (el) { el.value = df[el.getAttribute("data-dim")] || ""; });
    cond.querySelectorAll(".tgl-what, .tgl-agg, .tgl-dim").forEach(function (el) { el.disabled = true; el.style.opacity = "0.55"; });
    var grip = cond.querySelector(".aw-grip"); if (grip) grip.style.display = "none";
    var rmCond = cond.querySelector(".scr-remove"); if (rmCond) rmCond.style.display = "none";
    row._sampleSig = bandSampleSig(leaf);
    refreshDimOptions(panel); // the tier's locked condition row has its own dim control
  }
  /**
   * Re-mirror the base condition's sampling onto every tier whenever it changes.
   * Tiers share metric / aggregation / dimensionFilter by definition — collectBands
   * takes only their operator + threshold — so a tier still displaying the sampling
   * it was CREATED with is a lie the operator can otherwise only fix by deleting and
   * re-adding the tier. Signature-guarded, so an edit to a tier's own operator or
   * value (which fires the same delegated change event) never re-renders it out
   * from under the cursor.
   */
  function syncBandsToBase(panel) {
    var host = panel.querySelector("#aw-bands");
    if (!host || !host.querySelector(".aw-band")) return;
    var kind = panel.querySelector("#aw-trigger-type").value === "host" ? "host" : "asset";
    // Collect + COMPILE the base group so filter rows fold into the condition
    // before tiers mirror it — a tier's locked row then shows the identifier /
    // name filters the base carries, and adding a filter row doesn't read as a
    // second condition that stops the mirroring.
    var root = panel.querySelector("#aw-trig-root > .scg-group");
    if (!root) return;
    var leaves = tgLeaves(tgCompile(tgCollectGroup(root, kind)).tree);
    if (leaves.length !== 1) return; // bands only apply to a single-metric trigger
    var base = leaves[0];
    if (base.type === "asset_state") return;
    var sig = bandSampleSig(base);
    // Windowed-ratio triggers keep their tiers' hold boxes too (2026-08-20):
    // tiers share the base's History window (the sampling), and each may hold
    // its own sustain on top — "10% for 30 min = warning, 25% for 5 min =
    // critical" is one automation (rule 19). They were hidden while a ratio
    // trigger had no sustain axis at all.
    host.querySelectorAll(":scope > .aw-band").forEach(function (row) {
      if (row._sampleSig === sig) return;
      var cur = row.querySelector(".band-cond .scr-row");
      var prev = cur ? tgCollectLeaf(cur, kind) : {};
      renderBandCond(row, panel, {
        type: base.type, metric: base.metric, aggregation: base.aggregation, windowSec: 0,
        dimensionFilter: base.dimensionFilter,
        // The tier keeps its own comparison — only the sampling is shared.
        operator: prev.operator || base.operator,
        threshold: prev.threshold != null && !isNaN(prev.threshold) ? prev.threshold : null,
      }, kind);
    });
  }
  function addBandRow(host, band) {
    if (host.querySelectorAll(".aw-band").length >= 4 && !band) { showToast("At most 4 additional severities", "info"); return null; }
    band = band || { threshold: "", severity: nextTierSeverity(host), actions: [] };
    var sev0 = band.severity || nextTierSeverity(host);
    var tr = draft.trigger || {};
    var kind = tr.type === "host_metric" ? "host" : "asset";
    // Each tier is a full condition GROUP on the SAME metric + sampling as the
    // base condition — only severity / operator / value vary (shared sampling).
    var tierLeaf = {
      type: kind === "host" ? "host_metric" : "asset_metric",
      metric: tr.metric, aggregation: tr.aggregation || "latest", windowSec: tr.windowSec || 0,
      operator: band.operator || tr.operator || ">=",
      threshold: band.threshold != null && band.threshold !== "" ? band.threshold : null,
      dimensionFilter: tr.dimensionFilter,
    };
    var panel = document.getElementById("aw-step-3");
    // No per-tier hold (2026-08-28): the trigger carries ONE "sustained for",
    // and every tier waits it out before taking its severity. A tier that
    // already carries its own `forDurationSec` — API-authored, or saved by the
    // builder before this change — keeps it on the row stash and round-trips,
    // because the engine still honours it (rule 19); the builder just offers no
    // control to set another one.
    var row = document.createElement("div");
    row.className = "aw-band scg-group";
    row.style.cssText = "border:1px solid var(--color-border);border-left:3px solid " + sevColor(sev0) + ";border-radius:6px;padding:0.55rem;margin:4px 0";
    // A tier here is just: severity + the (locked-metric) condition +
    // "+ Severity". Its ACTIONS live on the Actions step (the per-severity
    // section) — stashed on the row so collectBands round-trips them.
    row._bandActions = (band.actions && band.actions.length ? band.actions : []) || [];
    row._bandEscalation = band.escalation || null;
    // Keyed by severity: tiers carry strictly-increasing distinct severities, so
    // this is unique, and re-picking a severity carries the fold state with the
    // tier it belongs to.
    row.setAttribute("data-collapse-key", "t3:" + sev0);
    row.innerHTML =
      '<div class="aw-collapse-head" style="display:flex;align-items:center;gap:8px;margin-bottom:2px;flex-wrap:wrap">' +
        collapseBtnHtml("t3:" + sev0) +
        '<label class="aw-tier-label" style="margin:0">severity</label>' +
        sevSelectHtml("band-severity", sev0) +
        // What the tier says, for when it's folded shut. Filled by
        // syncBandSummary from the row's own inputs.
        '<span class="aw-collapse-summary" style="margin:0;display:none"></span>' +
        '<button type="button" class="btn btn-sm btn-danger band-remove" title="Remove severity" style="margin-left:auto">&times;</button>' +
      '</div>' +
      '<div class="aw-collapse-body">' +
      '<select class="scg-op" disabled style="width:100%;font-size:0.85rem;margin-bottom:2px"><option>All conditions must be met (AND)</option></select>' +
      '<div class="band-cond scg-children"></div>' +
      // Severity tiers share the trigger's sampling AND its hold (rule 19) —
      // for a windowed ratio that means the History window. The hold lives once,
      // on the trigger, so there is no per-tier duration field here — but it is
      // MIRRORED read-only into every tier (syncBandDurationMirrors), because a
      // number stated once above three tiers reads as belonging to the first one.
      '<div class="form-group aw-band-dur" style="margin:0.5rem 0 0;display:none">' +
        '<label class="aw-band-dur-label" style="font-size:0.8rem;color:var(--color-text-tertiary)">Sustained for (polls)</label>' +
        '<input type="number" class="aw-band-dur-input" disabled tabindex="-1" value="" ' +
          'title="Set once on the trigger above — every severity level waits it out." ' +
          'style="opacity:0.6;cursor:not-allowed">' +
        '<p style="margin:2px 0 0;font-size:0.78rem;color:var(--color-text-tertiary)">Set once above — every severity level waits it out.</p>' +
      '</div>' +
      '<div style="margin-top:4px"><button type="button" class="btn btn-sm btn-secondary band-add-sev">+ Severity</button></div>' +
      '</div>';
    host.appendChild(row);
    renderBandCond(row, panel, tierLeaf, kind);
    syncBandDurationMirrors(panel);
    // What a folded tier says about itself, read from its own controls so it
    // can't drift from what will be saved.
    var syncBandSummary = function () {
      var el = row.querySelector(".aw-collapse-summary");
      if (el) el.textContent = tierSummaryText(row);
    };
    syncBandSummary();
    row.addEventListener("input", syncBandSummary);
    row.addEventListener("change", syncBandSummary);
    // Re-key on severity change so a folded tier keeps its own state instead of
    // adopting whatever the severity it moved to had.
    var recollapse = function (nextSev) {
      var oldKey = row.getAttribute("data-collapse-key");
      var newKey = "t3:" + nextSev;
      if (oldKey === newKey) return;
      if (_awCollapsed[oldKey]) { _awCollapsed[newKey] = true; delete _awCollapsed[oldKey]; }
      row.setAttribute("data-collapse-key", newKey);
      var b = row.querySelector("[data-collapse]");
      if (b) b.setAttribute("data-collapse", newKey);
      applyCollapsed(row);
    };
    wireCollapsibles(row);
    row.querySelector(".band-add-sev").addEventListener("click", function () { addBandRow(host, null); syncBandNotify(panel); });
    // Per-tier accent + "only increase severity" guard: a tier can't be set at
    // or below the tier before it (or the base).
    var sevSel = row.querySelector(".band-severity");
    sevSel.value = sev0; // don't rely on the markup's selected attr
    sevSel.addEventListener("change", function () {
      var prev = row.previousElementSibling && row.previousElementSibling.classList.contains("aw-band")
        ? sevRankOf(row.previousElementSibling.querySelector(".band-severity").value)
        : sevRankOf(draft.severity || "warning");
      if (sevRankOf(sevSel.value) <= prev) {
        var sevs = s.severities || [];
        sevSel.value = sevs[Math.min(prev + 1, sevs.length - 1)];
        showToast("Each added severity must be higher than the one before it", "info");
      }
      sevSel.className = "band-severity sev-select sev-" + sevSel.value;
      row.style.borderLeftColor = sevColor(sevSel.value);
      recollapse(sevSel.value);
      syncBandAddButtons(panel);
    });
    row.querySelector(".band-remove").addEventListener("click", function () {
      row.remove();
      syncBandNotify(panel);
      syncBandAddButtons(panel);
    });
    syncBandAddButtons(panel);
    return row;
  }
  // Show a "+ Severity" button only while a HIGHER severity is still available
  // (and fewer than 4 tiers) — so the chain can reach critical but not beyond.
  function syncBandAddButtons(panel) {
    var host = panel.querySelector("#aw-bands");
    var sevs = s.severities || [];
    var maxRank = sevRankOf(draft.severity || "warning");
    var count = 0;
    if (host) host.querySelectorAll(".band-severity").forEach(function (sel) { maxRank = Math.max(maxRank, sevRankOf(sel.value)); count++; });
    var canAdd = count < 4 && maxRank < sevs.length - 1;
    panel.querySelectorAll(".scg-add-sev, .band-add-sev").forEach(function (b) { b.style.display = canAdd ? "" : "none"; });
  }

  // ── Step 6: Summary + affected devices ─────────────────────────────────
  /** Export / View code, offered on the Summary card. Both are read-level:
   *  they only re-serialize what the operator is already looking at. The code
   *  editor's SAVE is gated separately, inside openCodeModal. */
  function codeButtonsHtml() {
    if (!portability()) return '';
    return '<button class="btn btn-secondary" id="aw-view-code" type="button" style="padding:2px 10px;font-size:0.8rem">View code</button>' +
      '<button class="btn btn-secondary" id="aw-export" type="button" style="padding:2px 10px;font-size:0.8rem">Export</button>';
  }

  /** The one export path, shared by the Summary button and the code modal's
   *  Export button, so both write the same portable file with the same toast. */
  function exportBody(body) {
    var P = portability();
    if (!P) return;
    var file = P.buildExportFile(body, portabilityCatalogs(), {
      polarisVersion: (window.polarisVersion || undefined),
    });
    var missing = (file.dependencies || []).length;
    window.downloadJson(file, P.filenameForExport(body.name));
    showToast(missing
      ? 'Exported. The file lists ' + missing + ' thing' + (missing === 1 ? '' : 's') + ' it needs — delivery wiring is not included.'
      : 'Exported.', 'success');
  }

  function wireCodeButtons() {
    var P = portability();
    if (!P) return;

    var exportBtn = document.getElementById('aw-export');
    if (exportBtn) {
      exportBtn.addEventListener('click', function () {
        // No collect needed: goToStep already collected every step passed
        // through, and buildPayload is a pure function of the draft.
        exportBody(buildPayload({ nameFallback: 'Untitled automation' }));
      });
    }

    var viewBtn = document.getElementById('aw-view-code');
    if (viewBtn) {
      viewBtn.addEventListener('click', function () {
        var canSave = permAtLeast('automationManagement', 'fullwrite');
        P.openCodeModal({
          title: 'Automation code',
          body: buildPayload({ nameFallback: 'Untitled automation' }),
          canSave: canSave,
          // Read-level, like the code view itself, and it exports the textarea
          // rather than the draft: an edit can leave as a portable file without
          // first being applied to the draft or saved.
          onExport: function (edited) { exportBody(edited); },
          onSave: canSave ? async function (edited) {
            // Apply to the draft, then save through the ONE save path so
            // validation, the POST-vs-PUT choice and the toast stay shared.
            applyPayloadToDraft(edited);
            var ok = await saveAutomation(null);
            if (!ok) throw new Error('The automation was not saved — see the message above.');
          } : null,
        });
      });
    }
  }

  /** Edited JSON -> draft. Mirrors _awDraftFromRule, but for a body that came
   *  out of buildPayload rather than off the API. */
  function applyPayloadToDraft(p) {
    var next = _awDraftFromRule(p);
    // buildPayload omits `enabled` semantics the draft needs, so carry the
    // edited value when present and otherwise keep what the draft had.
    if (typeof p.enabled === 'boolean') next.enabled = p.enabled;
    else next.enabled = draft.enabled;
    Object.keys(next).forEach(function (k) { draft[k] = next[k]; });
  }

  function renderStep6() {
    var panel = document.getElementById("aw-step-6");
    panel.innerHTML = '<h3 style="margin:0 0 0.25rem">Review &amp; save</h3>' +
      '<div class="form-group" style="border:1px solid var(--color-border);border-radius:6px;padding:0.75rem">' +
        '<div style="display:flex;align-items:center;gap:0.5rem;margin:0 0 6px;flex-wrap:wrap">' +
          '<label style="font-weight:600;margin:0;flex:1 1 auto">Summary</label>' +
          codeButtonsHtml() +
        '</div>' +
        '<div id="aw-summary"></div>' +
      '</div>' +
      '<div class="form-group" style="border:1px solid var(--color-border);border-radius:6px;padding:0.75rem">' +
        '<label style="font-weight:600;margin:0 0 6px;display:block">Devices this automation affects</label>' +
        '<div id="aw-affected"><p style="color:var(--color-text-tertiary);font-size:0.85rem">Checking…</p></div>' +
      '</div>' +
      // Test delivery — omitted entirely (not disabled) without fullwrite, the
      // way the Delivery tab drops its buttons: the endpoint would 403 anyway.
      (permAtLeast("automationManagement", "fullwrite")
        ? '<div class="form-group" id="aw-test-delivery" style="border:1px solid var(--color-border);border-radius:6px;padding:0.75rem">' +
            '<label style="font-weight:600;margin:0 0 6px;display:block">Test delivery</label>' +
            '<div id="aw-test-body"></div>' +
          '</div>'
        : "");
    renderSummary();
    renderAffectedDevices();
    wireCodeButtons();
    if (permAtLeast("automationManagement", "fullwrite")) renderTestDelivery();
  }

  /**
   * Distinct testable targets for the draft, deduped by channel. PURE apart
   * from reading the channel catalogue: walks the same locations the server's
   * allRuleActionRefs does, so the `index` sent back addresses the same action.
   *
   * `api_call` and `script` are deliberately absent — the server refuses to run
   * them from a test button (an api_call would open a real ticket; a script is
   * RCE-by-button), so offering them would be a lie.
   */
  function testDeliveryTargets() {
    var out = [];
    var seen = {};
    var idx = -1;
    var perSev = bandActionsPerSeverityOn();
    var push = function (action, where) {
      idx++;
      if (action.type === "event") {
        if (!seen["event"]) { seen["event"] = true; out.push({ key: "event", kind: "event", index: idx, label: "Write a Test Event", detail: "", usedIn: [where] }); }
        else out.push(null);
        return;
      }
      if (action.type !== "notify") return;
      // A button per CHANNEL, not per action: the button names a delivery the
      // operator is about to receive, and a multi-channel action produces one
      // of each. They share the action's ref index and differ by channelId,
      // which is what the server's path carries.
      var actionIdx = idx;
      actionChannels(action).forEach(function (ch) {
        var key = "ch:" + ch.id;
        if (seen[key]) {
          // Same channel again (a band, an escalation tier, or a second action
          // on the same channel): note where, don't offer a second button for
          // the same destination.
          var prior = out.find(function (t) { return t && t.key === key; });
          if (prior && prior.usedIn.indexOf(where) === -1) prior.usedIn.push(where);
          return;
        }
        seen[key] = true;
        var kind = ch.type === "web_push" ? "push" : isEmailType(ch.type) ? "email" : "webhook";
        out.push({
          key: key, kind: kind, index: actionIdx, channelId: ch.id, channel: ch, action: action, usedIn: [where],
          // The button names the DELIVERY the operator is about to receive, not
          // the action's index or the channel row: "Send Test Web Push" is what
          // tells them to go look at their phone.
          label: kind === "push" ? "Send Test Web Push"
            : kind === "email" ? "Send Test Email"
              : "Send Test " + chanTypeLabel(ch.type),
          detail: ch.name + " — " + chanTypeLabel(ch.type),
        });
      });
    };
    // Walk order MUST match allRuleActionRefs: actions (+ their tiers), rule
    // tiers, band actions (+ tiers), band tiers, resolved actions, reset actions.
    var walkTiers = function (esc, where) {
      ((esc && esc.tiers) || []).forEach(function (t) { (t.actions || []).forEach(function (a) { push(a, where); }); });
    };
    (draft.actions || []).forEach(function (a) { push(a, "actions"); walkTiers(a.escalation, "escalation"); });
    walkTiers(draft.escalation, "escalation");
    (perSev ? (draft.severityBands || []) : []).forEach(function (b) {
      (b.actions || []).forEach(function (a) { push(a, "at " + b.severity); walkTiers(a.escalation, "escalation"); });
      walkTiers(b.escalation, "escalation");
    });
    ((draft.bandNotify && draft.bandNotify.resolvedActions) || []).forEach(function (a) { push(a, "resolved"); });
    (draft.resetActions || []).forEach(function (a) { push(a, "reset"); });
    return out.filter(Boolean);
  }

  var _awTestBusy = false;

  function renderTestDelivery() {
    var box = document.getElementById("aw-test-body");
    if (!box) return;
    var targets = testDeliveryTargets();
    if (targets.length === 0) {
      box.innerHTML = '<p class="hint" style="margin:0">This automation only creates an in-app alert — there’s nothing to send. ' +
        'Add a <strong>Notify</strong> or <strong>Create an Event</strong> action on the previous step to test delivery.</p>';
      return;
    }
    var me = (_ruleRecipientUsers || []).find(function (u) { return u.username === (typeof currentUsername !== "undefined" ? currentUsername : ""); });
    var selfDesc = me
      ? [me.email || "no email on your account", (me.pushDevices || 0) + " push device" + ((me.pushDevices || 0) === 1 ? "" : "s")].join(" · ")
      : "your account";
    // One button per delivery this automation would perform, and every one of
    // them lands on the CONFIGURING OPERATOR. There is deliberately no
    // "send to the real recipients" option: the question a test answers is
    // "does this channel work and what does the message look like", and
    // answering it by paging the on-call is a cost nobody asked for.
    box.innerHTML =
      '<p class="hint" style="margin:0 0 8px">Each test creates a <strong>real alert</strong> (flagged as a test) and delivers it through that one action immediately — ' +
        '<strong>to you only</strong>, never to this automation’s recipients.<br>' +
        '<span style="color:var(--color-text-tertiary)">You: ' + escapeHtml(selfDesc) + '</span></p>' +
      '<div id="aw-test-buttons">' + targets.map(function (t) {
        return '<div class="awtd-row" style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">' +
          '<button type="button" class="btn btn-sm btn-secondary awtd-btn" data-key="' + escapeHtml(t.key) + '">' + escapeHtml(t.label) + '</button>' +
          '<span style="font-size:0.8rem">' + escapeHtml(t.detail) +
            (t.usedIn.length > 1 || t.usedIn[0] !== "actions"
              ? ' <span style="color:var(--color-text-tertiary)">— used by: ' + escapeHtml(t.usedIn.join(", ")) + '</span>'
              : "") +
          '</span>' +
          '<div class="awtd-out" data-key="' + escapeHtml(t.key) + '" style="flex-basis:100%;font-size:0.78rem;margin:0"></div>' +
        '</div>';
      }).join("") + '</div>';

    box.querySelectorAll(".awtd-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var t = targets.find(function (x) { return x.key === btn.dataset.key; });
        if (t) runDeliveryTest(t, btn, box);
      });
    });
    syncTestButtons(box, targets);
  }

  /** Disable what a send-to-me test can't honour, and say why. */
  function syncTestButtons(box, targets) {
    var me = (_ruleRecipientUsers || []).find(function (u) { return u.username === (typeof currentUsername !== "undefined" ? currentUsername : ""); });
    targets.forEach(function (t) {
      var btn = box.querySelector('.awtd-btn[data-key="' + t.key + '"]');
      var out = box.querySelector('.awtd-out[data-key="' + t.key + '"]');
      if (!btn) return;
      var why = "";
      // A webhook/chat channel has exactly ONE destination — there is no
      // private version of a Teams post, so this surface can't test it without
      // messaging the whole channel. The Delivery tab's per-channel Test button
      // is where that decision belongs.
      if (t.kind === "webhook") why = "Posts to the whole channel, so it can’t be sent to you alone — use the Test button on the Delivery tab.";
      else if (t.kind === "email" && me && !me.email) why = "Your account has no email address.";
      else if (t.kind === "push" && me && !me.pushDevices) why = "You have no push-enabled device — turn push on from the sidebar, then reopen this step.";
      if (t.channel && t.channel.enabled === false) why = "This channel is disabled — it won’t deliver until you enable it on the Delivery tab.";
      btn.disabled = !!why || _awTestBusy;
      if (out && why) out.innerHTML = '<span style="color:var(--color-text-tertiary)">' + escapeHtml(why) + "</span>";
      else if (out && out.dataset.result !== "1") out.innerHTML = "";
    });
  }

  async function runDeliveryTest(target, btn, box) {
    if (_awTestBusy) return;
    // One at a time: every press mints a real alert.
    _awTestBusy = true;
    var old = btn.textContent;
    btn.textContent = "Sending…";
    box.querySelectorAll(".awtd-btn").forEach(function (b) { b.disabled = true; });
    var out = box.querySelector('.awtd-out[data-key="' + target.key + '"]');
    var stamp = new Date().toLocaleTimeString();
    try {
      var r = await api.automations.testDelivery({
        rule: testDeliveryPayload(),
        path: { index: target.index, ...(target.channelId ? { channelId: target.channelId } : {}) },
        target: target.kind === "event" ? "event" : "delivery",
      });
      showToast(r.message || "Test sent", r.ok ? "success" : "error");
      if (out) {
        out.dataset.result = "1";
        out.innerHTML = '<strong style="color:var(--color-' + (r.ok ? "success" : "danger") + ')">' + (r.ok ? "✓" : "✗") + "</strong> " +
          escapeHtml(r.message || "") + ' <span style="color:var(--color-text-tertiary)">· ' + escapeHtml(stamp) + "</span>" +
          (r.ackLinks && r.ackLinks.enabled
            ? '<br><span style="color:var(--color-text-tertiary)">The Acknowledge button in it opens this test alert in Polaris.</span>'
            : r.ackLinks && r.ackLinks.reason
              ? '<br><span style="color:var(--color-text-tertiary)">No acknowledge link: ' + escapeHtml(r.ackLinks.reason) + "</span>"
              : "");
      }
    } catch (err) {
      showToast(err.message || "Test failed", "error");
      if (out) {
        out.dataset.result = "1";
        out.innerHTML = '<strong style="color:var(--color-danger)">✗</strong> ' + escapeHtml(err.message || "failed") +
          ' <span style="color:var(--color-text-tertiary)">· ' + escapeHtml(stamp) + "</span>";
      }
    }
    _awTestBusy = false;
    btn.textContent = old;
    syncTestButtons(box, testDeliveryTargets());
  }

  /** The DRAFT as the test endpoint wants it — what's on screen, not what's saved. */
  /** The draft as a preview body. This was a near-copy of buildPayload,
   *  differing only in the name fallback and three omitted keys — and
   *  `previewInputSchema`'s base is a plain z.object (not .strict()), so
   *  `enabled` / `channels` / `emailComposition` are stripped rather than
   *  rejected. One builder, so the two can no longer drift. */
  function testDeliveryPayload() {
    return buildPayload({ nameFallback: "Untitled automation" });
  }
  async function renderAffectedDevices() {
    var box = document.getElementById("aw-affected");
    if (!box) return;
    if (!isTriggerScoped(draft.trigger)) {
      box.innerHTML = '<p style="color:var(--color-text-tertiary);font-size:0.85rem">This trigger isn’t tied to devices (Polaris host / audit events).</p>';
      return;
    }
    try {
      // Send the trigger + rule id so the preview can compute the precedence
      // carve-out (which devices this automation shares with more/less-specific
      // automations that watch the same thing) and exclude this rule itself.
      var body = { scope: draft.scope, trigger: draft.trigger, reset: draft.reset || undefined };
      if (editing && editing.id) body.id = editing.id;
      var res = await api.automations.preview(body);
      var matches = res.matches || [];
      var names = matches.slice(0, 100).map(function (m) {
        var carved = m.excludedBy
          ? ' <span style="color:var(--color-warning, #b7791f);font-size:0.75rem">— covered by “' + escapeHtml(m.excludedBy.ruleName) + '”</span>'
          : "";
        // Per-dimension metrics evaluate one reading per sensor / interface /
        // mount, so the same hostname legitimately appears several times —
        // WHICH sensor is the only thing that tells those rows apart.
        var dim = m.dimension
          ? ' <span style="color:var(--color-text-tertiary);font-size:0.78rem">' + escapeHtml(m.dimension) + '</span>'
          : "";
        return '<tr><td>' + escapeHtml(m.hostname || m.assetId || "") + dim + carved + '</td></tr>';
      }).join("");
      // totalEvaluated counts READINGS; totalAssets counts devices. Reporting
      // the former as "devices" made 8 firewalls with 6 temperature sensors
      // each read as "48 devices".
      var devices = res.totalAssets != null ? res.totalAssets : res.totalEvaluated;
      var countLine = '<strong>' + devices + '</strong> device(s) match the filter right now.';
      if (res.totalAssets != null && res.totalEvaluated > res.totalAssets) {
        countLine += ' <span style="color:var(--color-text-tertiary)">This metric is reported per sensor / interface / mount — ' +
          res.totalEvaluated + ' reading(s) across those ' + res.totalAssets + ' device(s), one row each below.</span>';
      }
      var spec = res.specificity
        ? '<p style="font-size:0.8rem;margin:0 0 6px">Specificity: <strong>' + escapeHtml(res.specificity.label) + '</strong>' +
          ' <span style="color:var(--color-text-tertiary)">— a more-specific automation watching the same thing takes precedence for the devices it covers.</span></p>'
        : "";
      box.innerHTML = spec +
        '<p style="font-size:0.85rem;margin:0 0 4px">' + countLine + '</p>' +
        carveOutWarningHtml(res.carveOut) +
        (names ? '<div class="table-wrapper" style="max-height:220px;overflow:auto"><table><tbody>' + names + '</tbody></table></div>' +
          (res.totalEvaluated > 100 ? '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:4px 0 0">…and ' + (res.totalEvaluated - 100) + ' more row(s).</p>' : "") : "");
    } catch (err) {
      box.innerHTML = '<p style="color:var(--color-text-tertiary);font-size:0.85rem">' + escapeHtml(err.message || "Preview unavailable") + '</p>';
    }
  }
  // Bidirectional precedence warning: what this draft takes from less-specific
  // automations (carvesFrom) + what more-specific ones already cover (carvedOut).
  function carveOutWarningHtml(carveOut) {
    if (!carveOut) return "";
    var parts = [];
    if (carveOut.carvesFrom && carveOut.carvesFrom.length) {
      var lines = carveOut.carvesFrom.map(function (c) {
        var sample = (c.sampleHostnames || []).slice(0, 3).join(", ");
        return '<li>“' + escapeHtml(c.ruleName) + '” — <strong>' + c.count + '</strong> device(s)' +
          (sample ? ' <span style="color:var(--color-text-tertiary)">(' + escapeHtml(sample) + (c.count > 3 ? ", …" : "") + ')</span>' : "") + '</li>';
      }).join("");
      parts.push('<p style="margin:0 0 2px;font-size:0.82rem">Creating this will stop these less-specific automations from alerting on the devices it covers:</p><ul style="margin:0 0 6px 1.1rem;font-size:0.82rem">' + lines + '</ul>');
    }
    if (carveOut.carvedOut && carveOut.carvedOut.count) {
      var by = (carveOut.carvedOut.byRule || []).map(function (b) { return '“' + escapeHtml(b.ruleName) + '” (' + b.count + ')'; }).join(", ");
      parts.push('<p style="margin:0 0 6px;font-size:0.82rem"><strong>' + carveOut.carvedOut.count + '</strong> matched device(s) are already covered by a more-specific automation, so this one won’t alert on them: ' + by + '.</p>');
    }
    if (!parts.length) return "";
    return '<div style="border:1px solid var(--color-warning, #d9a441);background:var(--color-warning-bg, rgba(217,164,65,0.08));border-radius:6px;padding:0.5rem 0.6rem;margin:0 0 8px">' + parts.join("") + '</div>';
  }

  // One action row — used for top-level actions AND escalation-tier actions.
  // escalatable: top-level + per-severity-band action rows get their own
  // "Escalate if unhandled" chain (action.escalation). Tier-hosted rows and
  // band resolved-action rows don't (the server schema keeps those bare).
  /**
   * Fold one action row down to its header — the type select, the summary line and
   * Remove. A per-severity ladder is three or four action lists deep, each row
   * carrying a channel picker, To/Cc/Bcc, an email body and an escalation
   * footer; expanded, the step is unreadable. The summary already says what the
   * row does, so it IS the collapsed state.
   *
   * State lives on the ELEMENT, not in the keyed `_awCollapsed` map: an action has
   * no stable identity to key on (rows are positional, and removing one shifts
   * the rest), and closed-by-default means a re-render has nothing to restore
   * anyway. The cost is that a row an operator opened re-folds when the step
   * re-renders, which is the same thing "closed by default" asks for.
   */
  function foldActionRow(row, collapsed) {
    row._awFolded = !!collapsed;
    row.querySelectorAll(":scope > .aw-action-fields, :scope > .aw-esc-sec").forEach(function (el) {
      el.style.display = collapsed ? "none" : "";
    });
    var btn = row.querySelector(":scope > div > .aw-collapse");
    if (btn) {
      btn.innerHTML = collapsed ? "&#x25B8;" : "&#x25BE;";
      btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
      var label = collapsed ? "Expand this action" : "Collapse this action";
      btn.setAttribute("title", label);
      btn.setAttribute("aria-label", label);
    }
  }

  function addActionRow(host, action, escalatable) {
    action = action || { type: "notify", channelId: channels.length ? channels[0].id : "" };
    var types = availableActionTypes();
    var row = document.createElement("div");
    row.className = "aw-action";
    row.style.cssText = "border:1px solid var(--color-border);border-radius:6px;padding:0.6rem;margin-bottom:6px";
    var typeOpts = types.map(function (t) {
      return '<option value="' + t.type + '"' + (t.type === action.type ? " selected" : "") + '>' + escapeHtml(t.label) + '</option>';
    }).join("");
    row.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
        '<button type="button" class="btn-icon aw-collapse" aria-expanded="false" ' +
          'title="Expand this action" aria-label="Expand this action">&#x25B8;</button>' +
        '<select class="aw-action-type" style="width:auto">' + typeOpts + '</select>' +
        '<span class="aw-action-summary" style="flex:1;font-size:0.8rem;color:var(--color-text-tertiary)"></span>' +
        '<button type="button" class="btn btn-sm btn-danger aw-action-remove">Remove</button>' +
      '</div>' +
      '<div class="aw-action-fields"></div>' +
      // An audit Event is instantaneous, so there is nothing to chase if it
      // goes "unhandled" — and the server schema gives `event` no escalation
      // key at all, so rendering the footer would produce an unsavable action.
      (escalatable && action.type !== "event" ? escSectionHtml() : "");
    host.appendChild(row);
    // Set the value explicitly rather than trusting the `selected` attribute
    // written via innerHTML: the collector reads .value, and relying on
    // attribute reflection makes the row's type environment-dependent (it is
    // not honored by happy-dom for a non-first option).
    row.querySelector(".aw-action-type").value = action.type;
    row.querySelector(".aw-action-remove").addEventListener("click", function () {
      var owner = row.parentNode;
      row.remove();
      // Removing the only push action re-gates every remaining preference
      // checkbox in the list.
      refreshPrefGating(owner);
    });
    row.querySelector(".aw-action-type").addEventListener("change", function () {
      // Switching TO/FROM event changes whether the escalation footer belongs,
      // so rebuild the row rather than just its fields.
      var next = row.querySelector(".aw-action-type").value;
      var esc = collectEscSection(row.querySelector(":scope > .aw-esc-sec"));
      var host2 = row.parentNode;
      var anchor = row.nextSibling;
      row.remove();
      var rebuilt = addActionRow(host2, next === "event" ? { type: "event" } : { type: next, escalation: esc }, escalatable);
      foldActionRow(rebuilt, false); // mid-edit: the operator just changed its type
      // addActionRow appends; move the rebuilt row back to where it was.
      if (anchor) host2.insertBefore(host2.lastChild, anchor);
      // A row that stopped (or started) being a Notify changes what the list offers.
      refreshPrefGating(host2);
    });
    renderActionFields(row, action);
    // The composition block carries its own token chips, and a row added after
    // the panel render would otherwise have unwired ones (wireTokenPalette is
    // idempotent — it marks what it has already bound).
    wireTokenPalette(row);
    if (escalatable && action.type !== "event") wireEscSection(row.querySelector(":scope > .aw-esc-sec"), action.escalation || null);
    row.querySelector(":scope > div > .aw-collapse").addEventListener("click", function () {
      foldActionRow(row, !row._awFolded);
    });
    // Closed by default. A row the operator just ADDED is opened by its caller —
    // you don't create an action in order to look at its summary.
    foldActionRow(row, true);
    return row;
  }
  // ─── Recipient token fields (To / Cc / Bcc) ────────────────────────────
  //
  // Email channels get three token boxes instead of the old multi-select +
  // comma-separated address input. A pill is {kind:"user"|"address", value,
  // label} and nothing more; DOM order IS the model, so collecting is a walk.
  //
  // The server model already accepted user ids in cc/bcc (emailRecipientsSchema
  // carries recipientUserIds alongside addresses) — the old UI just never
  // produced them, so this is a client-side mapping change with no schema work.

  var _awContactEmails = null; // Set of lower-cased addresses already in the book

  /** Role catalogue for the recipient tokens (from /automations/scope-options). */
  function awRoles() { return (_awScopeOptions && _awScopeOptions.roles) || []; }
  /** How deep region nesting goes. 1 (or absent) = nothing is nested, so the
   *  picker offers no level entries and a STORED level renders as unknown. */
  function awRegionMaxLevel() {
    var lv = _awScopeOptions && _awScopeOptions.regionLevels;
    return lv && typeof lv.maxLevel === "number" ? lv.maxLevel : 1;
  }

  /**
   * Dynamic recipients matching the typed fragment — "Asset's Region Users" and
   * friends, which until now existed ONLY behind the Address book button, so
   * typing the thing you wanted matched nothing and read as "we don't have it".
   *
   * The catalogue itself comes from the address-book module, which already owns
   * it for the picker's panes; a second copy here would drift. To-only,
   * mirroring `pillAllowedInField` — suggesting one into Cc would look like it
   * worked and then send to nobody. Listed FIRST because, as in the picker, it
   * isn't a search hit: it's the standing answer to "whoever owns the device".
   */
  function dynamicSuggestions(q, field, mode) {
    if (field !== "to") return [];
    var needle = recipNeedle(q);
    var book = window.PolarisAddressBook;
    if (!book || !book.dynamicEntries) return [];
    return book.dynamicEntries(awRegionMaxLevel()).filter(function (e) {
      if (!pillAllowedInField(e.source, field, mode)) return false;
      return recipNeedle(e.name).indexOf(needle) !== -1;
    });
  }

  /**
   * Roles matching the typed fragment, as suggestion entries. Local — the role
   * list is small, already loaded with the wizard, and doesn't belong in
   * /contacts/search, which is the ADDRESS book.
   */
  function roleSuggestions(q) {
    var needle = String(q || "").toLowerCase();
    return awRoles()
      .filter(function (r) { return r.name.toLowerCase().indexOf(needle) !== -1; })
      .map(function (r) { return { source: "role", id: r.id, email: "", name: r.name, description: "Every user with this role" }; });
  }

  /**
   * Map regions matching the typed fragment, as suggestion entries. Local for
   * the same reason roles are: the catalogue rode in with the wizard's
   * /scope-options payload, and a region is not an address, so
   * /contacts/search never returns one. Without this the only way to route to
   * a region was the Address book button's Regions tab, so an operator who
   * typed a region name got the PEOPLE whose names happened to match it and no
   * sign of the region that reaches all of them.
   */
  function regionSuggestions(q) {
    var needle = String(q || "").toLowerCase();
    var levels = (_awScopeOptions && _awScopeOptions.regionLevels && _awScopeOptions.regionLevels.byName) || {};
    return ((_awScopeOptions && _awScopeOptions.regions) || [])
      .filter(function (name) { return String(name).toLowerCase().indexOf(needle) !== -1; })
      .map(function (name) {
        // Level is the same L1/L2 vocabulary the picker's Regions tab and the
        // "Asset's L<n> Region Users" entries use; omitted rather than assumed
        // when the catalogue couldn't be levelled.
        var lv = levels[String(name).toLowerCase()];
        return {
          source: "region", id: name, email: "", name: name,
          description: "Every user tagged with this region" + (lv ? " (L" + lv + ")" : ""),
        };
      });
  }

  /**
   * Registry tags matching the typed fragment. Local for the same reason roles
   * and regions are — the catalogue rode in with /scope-options, and a tag is
   * not an address, so /contacts/search never returns one.
   *
   * `tagCatalog` already excludes the Map Regions category: those rows ARE the
   * region catalogue under their `region:` registry names, they are offered by
   * regionSuggestions with their nesting level, and they route through the
   * region-only matcher. Listing them twice would put the same people behind
   * two entries that reach different sets.
   */
  function tagSuggestions(q) {
    var needle = String(q || "").toLowerCase();
    return ((_awScopeOptions && _awScopeOptions.tagCatalog) || [])
      .filter(function (t) { return String(t && t.name).toLowerCase().indexOf(needle) !== -1; })
      .map(function (t) {
        return {
          source: "tag", id: t.name, email: "", name: t.name,
          description: "Every user tagged " + t.name + (t.category ? " \u00b7 " + t.category : ""),
        };
      });
  }

  function canReadContacts() { return typeof permAtLeast === "function" && permAtLeast("contacts", "read"); }
  function canAddContacts() { return typeof permAtLeast === "function" && permAtLeast("contacts", "write"); }

  // What each pill kind prints ahead of its label, and what its tooltip says.
  // The qualifier is what keeps a region called "Ashfield" from reading like a
  // person called "Ashfield" in a list that mixes both.
  var PILL_QUALIFIER = {
    role: "role:", region: "region:", tag: "tag:", deviceRegion: "dynamic:",
    deviceRegionLevel: "dynamic:", assetContacts: "dynamic:",
  };
  var PILL_TITLE = {
    region: "Every user tagged with this region",
    tag: "Every user carrying this tag",
    deviceRegion: "At fire time: the users whose region tags match the TRIGGERING device’s region (any level)",
    deviceRegionLevel: "At fire time: the users tagged with the region this many levels out from the TRIGGERING device’s own region",
    assetContacts: "At fire time: the address-book contacts whose device filter covers the TRIGGERING device",
  };

  function pillHtml(p) {
    var cls = "tag-chip" + (p.unknown ? " na-unknown" : "");
    var title = p.kind === "user"
      ? (p.unknown ? "This user account no longer exists" : "Polaris user account")
      : p.kind === "role"
        ? (p.unknown ? "This role no longer exists" : "Every user holding this role")
        : p.kind === DYNAMIC_LEVEL_KIND && p.unknown
          ? "No region is nested this deep any more — this reaches nobody"
          : PILL_TITLE[p.kind] || p.value;
    // The save affordance only makes sense for a typed address that isn't
    // already in the book, and only for someone who may add one.
    var showSave = p.kind === "address" && canAddContacts() &&
      _awContactEmails && !_awContactEmails.has(String(p.value).toLowerCase());
    return '<span class="' + cls + '" draggable="true" data-kind="' + escapeHtml(p.kind) + '" ' +
        'data-value="' + escapeHtml(p.value) + '" data-label="' + escapeHtml(p.label) + '" ' +
        (p.unknown ? 'data-unknown="1" ' : "") +
        'title="' + escapeHtml(title) + '">' +
      (PILL_QUALIFIER[p.kind]
        ? '<span style="opacity:.6;font-size:.85em">' + PILL_QUALIFIER[p.kind] + '</span> '
        : "") +
      escapeHtml(p.label) +
      (showSave
        ? '<button type="button" class="na-chip-save" data-na-save title="Save to address book" aria-label="Save to address book">&plus;</button>'
        : "") +
      '<button type="button" class="tag-chip-delete" data-na-del aria-label="Remove recipient">&times;</button>' +
    "</span>";
  }

  /**
   * May a pill of this kind live in this box? Two independent gates, and both
   * exist because the alternative is a pill that looks accepted and then
   * reaches nobody:
   *
   *  - FIELD. The dynamic kinds are To-only: the wire shape has no per-field
   *    slot for them (they're flags on the ACTION, while Cc/Bcc are
   *    EmailRecipients lists), and at fire time the expander folds contact
   *    addresses into the To owner map.
   *  - MODE. A `push` box takes only what resolves to an ACCOUNT, because a
   *    push subscription hangs off a user. `usersForTarget` on the web_push
   *    transport ignores `addresses` and `recipientAssetContacts` outright, so
   *    those two are refused at the box rather than silently dropped at
   *    delivery (business rule 25's posture: say no where the operator is
   *    looking).
   */
  // Every kind that resolves to ACCOUNTS. `tag` rides the same reasoning as
  // `region` — it names user tags, not addresses.
  var PUSH_PILL_KINDS = { user: true, role: true, region: true, tag: true, deviceRegion: true, deviceRegionLevel: true };
  function pillAllowedInField(kind, field, mode) {
    if (mode === "push" && !PUSH_PILL_KINDS[kind]) return false;
    return !isDynamicKind(kind) || field === "to";
  }
  /** The mode a box was built in, read back off the DOM (see recipBoxHtml). */
  function boxMode(box) { return (box && box.getAttribute("data-mode")) || "email"; }

  /**
   * One address-book picker entry → a pill. The picker's `source` is the
   * vocabulary: `user` and the address-shaped sources it always had, plus the
   * Regions tab's `region` and the two dynamic entries.
   */
  function pickerEntryToPill(e) {
    if (!e) return null;
    if (e.source === "region") return { kind: "region", value: e.id, label: e.id };
    if (e.source === "tag") return { kind: "tag", value: e.id, label: e.id };
    if (e.source === "deviceRegion") return { kind: "deviceRegion", value: "1", label: e.name };
    if (e.source === "deviceRegionLevel") return { kind: DYNAMIC_LEVEL_KIND, value: String(e.level), label: e.name };
    if (e.source === "assetContacts") return { kind: "assetContacts", value: "1", label: e.name };
    if (e.source === "user") return { kind: "user", value: e.id, label: e.name || e.email };
    if (!e.email) return null;
    return { kind: "address", value: e.email, label: e.name ? e.name + " <" + e.email + ">" : e.email };
  }

  function recipBoxHtml(field, label, pills, withBook, mode) {
    // The To hint names “asset’s…” because the dynamic recipients are the one
    // thing here nobody would think to TYPE — they read as a picker feature.
    // The push variant omits "address" for the same reason the box refuses
    // one: there is no subscription behind an address.
    var placeholder = field !== "to" ? ""
      : mode === "push"
        ? "Type a name, role, region or “asset’s…”"
        : "Type a name, address, role, region or “asset’s…”";
    return '<div class="na-recip-row">' +
      '<label class="na-recip-label">' + escapeHtml(label) + "</label>" +
      '<div class="na-recip-box" data-field="' + field + '" data-mode="' + (mode || "email") + '">' +
        (pills || []).map(pillHtml).join("") +
        '<input type="text" class="na-recip-input" autocomplete="off" spellcheck="false" ' +
               'placeholder="' + escapeHtml(placeholder) + '" aria-label="Add a ' + escapeHtml(label) + ' recipient">' +
        '<div class="aw-suggest"></div>' +
      "</div>" +
      (withBook
        ? '<button type="button" class="btn btn-secondary btn-sm na-book" title="Open the address book">Address book</button>'
        : "") +
    "</div>";
  }

  /** Read a box's pills back out of the DOM. */
  function pillsOf(box) {
    return Array.from(box.querySelectorAll(":scope > .tag-chip")).map(function (el) {
      return {
        kind: el.getAttribute("data-kind"),
        value: el.getAttribute("data-value"),
        // From the attribute, not textContent: the chip also renders a "role:"
        // qualifier and the ×/+ buttons, which a text scrape would fold into
        // the label and then re-render on the next drag.
        label: el.getAttribute("data-label") || "",
        unknown: el.hasAttribute("data-unknown"),
      };
    });
  }

  function addPill(box, p) {
    if (!p || !p.value) return false;
    var dup = pillsOf(box).some(function (x) {
      return x.kind === p.kind && String(x.value).toLowerCase() === String(p.value).toLowerCase();
    });
    if (dup) return false;
    box.querySelector(".na-recip-input").insertAdjacentHTML("beforebegin", pillHtml(p));
    return true;
  }

  var EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

  // Module-scope drag state. dataTransfer.getData is unreadable during
  // dragover, so the payload rides here and the MIME type is what dragover
  // filters on (the dashboard cross-container pattern, not the reorder one).
  var _naDragEl = null;
  var _naDragCue = null;
  function naClearDrag() {
    if (_naDragCue) { _naDragCue.classList.remove("aw-drop-into"); _naDragCue = null; }
    if (_naDragEl) { _naDragEl.classList.remove("na-dragging"); _naDragEl = null; }
  }

  /**
   * Wire one action's three boxes: typeahead, keyboard, removal, the save-to-
   * book affordance, the address-book button, and drag between the boxes.
   * `host` is the .na-recips wrapper — DnD is scoped to it, so a pill can never
   * jump into a different Notify action's fields.
   */
  function wireRecipBoxes(host, onChange) {
    var suggestTimer = null;

    host.querySelectorAll(".na-recip-box").forEach(function (box) {
      var input = box.querySelector(".na-recip-input");
      var sugg = box.querySelector(".aw-suggest");
      var mode = boxMode(box);
      var items = [];
      var idx = -1;

      function closeSuggest() { sugg.classList.remove("open"); sugg.innerHTML = ""; items = []; idx = -1; }
      function paint() {
        Array.from(sugg.children).forEach(function (el, i) { el.classList.toggle("active", i === idx); });
        if (idx >= 0 && sugg.children[idx]) sugg.children[idx].scrollIntoView({ block: "nearest" });
      }
      function openSuggest(entries) {
        items = entries || [];
        if (!items.length) {
          sugg.innerHTML = '<div class="aw-suggest-empty">No match — type a full address and press Enter.</div>';
          sugg.classList.add("open");
          idx = -1;
          return;
        }
        sugg.innerHTML = items.map(function (e, i) {
          var badge = e.source === "user" ? "user"
            : e.source === "contact" ? "contact"
              : isDynamicKind(e.source) ? "dynamic" : e.source;
          var label = e.email ? (e.name ? e.name + " — " + e.email : e.email) : (e.name || "");
          // On a push box the count IS the useful half of the row: an account
          // with no enrolled browser is picked exactly as easily as one with
          // three, and nothing else on screen tells them apart.
          if (mode === "push" && e.source === "user") badge = pushDeviceBadge(e.id);
          return '<div class="aw-suggest-item" data-i="' + i + '" title="' + escapeHtml(e.email || e.description || "") + '">' +
            escapeHtml(label) +
            ' <span style="opacity:.6;font-size:.85em">' + escapeHtml(badge) + "</span></div>";
        }).join("");
        sugg.classList.add("open");
        idx = 0;
        paint();
      }
      function entryToPill(e) {
        // A Polaris account becomes a USER pill and a role a ROLE pill — both
        // keyed by id, which survives a rename; only a bare address is stored
        // as the string itself. The dynamic sources share the picker's mapping
        // so a pill built by typing is identical to one picked from the book.
        if (isDynamicKind(e.source)) return pickerEntryToPill(e);
        if (e.source === "role") return { kind: "role", value: e.id, label: e.name };
        if (e.source === "region") return { kind: "region", value: e.id, label: e.id };
        if (e.source === "tag") return { kind: "tag", value: e.id, label: e.id };
        return e.source === "user"
          ? { kind: "user", value: e.id, label: e.name || e.email }
          : { kind: "address", value: e.email, label: e.name ? e.name + " <" + e.email + ">" : e.email };
      }
      function commit() {
        if (idx >= 0 && items[idx]) {
          if (addPill(box, entryToPill(items[idx]))) onChange();
          input.value = "";
          closeSuggest();
          return;
        }
        var raw = input.value.trim();
        if (!raw) return;
        if (mode === "push") {
          // A typed address has no subscription behind it, so committing one
          // would add a recipient the push transport ignores at fire time.
          showToast("A push alert reaches a Polaris account — pick a user, role or region, not an address", "error");
          return;
        }
        if (!EMAIL_RE.test(raw)) { showToast('"' + raw + '" is not a valid email address', "error"); return; }
        if (addPill(box, { kind: "address", value: raw.toLowerCase(), label: raw.toLowerCase() })) onChange();
        input.value = "";
        closeSuggest();
      }

      input.addEventListener("input", function () {
        var q = input.value.trim();
        clearTimeout(suggestTimer);
        if (q.length < 2) { closeSuggest(); return; }
        // Dynamic recipients, roles, regions and tags resolve LOCALLY and show
        // immediately — every one of those catalogues is already loaded, so the
        // list shouldn't wait on a network round trip (or disappear when the
        // caller lacks contacts:read).
        var local = dynamicSuggestions(q, box.getAttribute("data-field"), mode)
          .concat(roleSuggestions(q), regionSuggestions(q), tagSuggestions(q));
        if (!canReadContacts()) { openSuggest(local); return; }
        openSuggest(local);
        suggestTimer = setTimeout(function () {
          api.contacts.search(q, true).then(function (r) {
            // Ignore a response that lost the race with newer typing.
            if (input.value.trim() !== q) return;
            // On a push box the search half is narrowed to Polaris ACCOUNTS:
            // contacts and directory hits are addresses, which this transport
            // cannot reach, and offering them is how an operator builds an
            // action that delivers nothing.
            var hits = ((r && r.entries) || []).filter(function (e) {
              return pillAllowedInField(e.source === "user" ? "user" : "address", "to", mode);
            });
            openSuggest(local.concat(hits));
          }).catch(function () { /* keep the local matches already shown */ });
        }, 250);
      });
      input.addEventListener("keydown", function (ev) {
        if (ev.key === "ArrowDown") { ev.preventDefault(); if (items.length) { idx = (idx + 1) % items.length; paint(); } }
        else if (ev.key === "ArrowUp") { ev.preventDefault(); if (items.length) { idx = (idx - 1 + items.length) % items.length; paint(); } }
        else if (ev.key === "Enter") { ev.preventDefault(); commit(); }
        else if (ev.key === "," || ev.key === ";") { ev.preventDefault(); commit(); }
        else if (ev.key === "Escape") {
          // stopPropagation so the wizard modal doesn't close behind us.
          if (sugg.classList.contains("open")) { ev.stopPropagation(); closeSuggest(); }
        } else if (ev.key === "Backspace" && !input.value) {
          var ps = box.querySelectorAll(":scope > .tag-chip");
          if (ps.length) { ps[ps.length - 1].remove(); onChange(); }
        }
      });
      input.addEventListener("blur", function () { setTimeout(closeSuggest, 150); });
      // mousedown + preventDefault keeps focus in the input so the blur-close
      // above doesn't race the tap.
      sugg.addEventListener("mousedown", function (ev) {
        var it = ev.target.closest && ev.target.closest(".aw-suggest-item");
        if (!it) return;
        ev.preventDefault();
        idx = Number(it.getAttribute("data-i"));
        commit();
      });
      // Clicking the box's padding should focus the field — it reads as one control.
      box.addEventListener("mousedown", function (ev) { if (ev.target === box) { ev.preventDefault(); input.focus(); } });
    });

    // Pill removal + save-to-book, delegated across all three boxes.
    host.addEventListener("click", async function (ev) {
      var del = ev.target.closest && ev.target.closest("[data-na-del]");
      if (del) { del.closest(".tag-chip").remove(); onChange(); return; }

      var save = ev.target.closest && ev.target.closest("[data-na-save]");
      if (save) {
        var chip = save.closest(".tag-chip");
        var email = chip.getAttribute("data-value");
        save.disabled = true;
        try {
          await api.contacts.create({ email: email });
          if (_awContactEmails) _awContactEmails.add(String(email).toLowerCase());
          save.remove();
          showToast("Saved to the address book", "success");
        } catch (err) {
          showToast((err && err.message) || "Could not save to the address book", "error");
          save.disabled = false;
        }
        return;
      }

      var book = ev.target.closest && ev.target.closest(".na-book");
      if (book) {
        // The mode travels with the request: in push mode the picker adds a
        // "Push devices" column, withholds the rows push cannot reach, and
        // offers To alone. Counts ride along rather than being fetched there,
        // since this file already holds them.
        var srcBox = book.closest(".na-recip-row").querySelector(".na-recip-box");
        var bookMode = boxMode(srcBox);
        var res = await window.PolarisAddressBook.openPicker(
          bookMode === "push"
            ? { field: "to", mode: "push", pushDevices: pushDeviceMap() }
            : { field: "to" },
        );
        if (!res) return;
        var dest = host.querySelector('.na-recip-box[data-field="' + res.field + '"]');
        if (!dest) return;
        var added = 0, refused = 0;
        res.entries.forEach(function (e) {
          var p = pickerEntryToPill(e);
          if (!p) return;
          if (!pillAllowedInField(p.kind, res.field, boxMode(dest))) { refused++; return; }
          if (addPill(dest, p)) added++;
        });
        if (refused) {
          showToast(bookMode === "push"
            ? "A push alert reaches a Polaris account — contacts and typed addresses have no subscription behind them"
            : "“Asset’s …” recipients can only go in To — they resolve per alert, and Cc/Bcc are fixed lists", "error");
        }
        if (added) onChange();
      }
    });

    // ── Drag a pill between To / Cc / Bcc ──
    // Cross-container MOVE, so the dashboard-canvas pattern: a custom MIME type
    // makes the drag identifiable during dragover, and the element itself is
    // stashed module-side because getData is unreadable there.
    host.addEventListener("dragstart", function (ev) {
      var chip = ev.target.closest && ev.target.closest(".na-recip-box > .tag-chip");
      if (!chip) return;
      _naDragEl = chip;
      chip.classList.add("na-dragging");
      try {
        ev.dataTransfer.setData("application/x-polaris-recipient", "1");
        ev.dataTransfer.setData("text/plain", chip.getAttribute("data-value") || "");
        ev.dataTransfer.effectAllowed = "move";
      } catch (_) { /* older browsers */ }
    });
    host.addEventListener("dragover", function (ev) {
      var types = ev.dataTransfer && ev.dataTransfer.types;
      if (!types || Array.prototype.indexOf.call(types, "application/x-polaris-recipient") === -1) return;
      var box = ev.target.closest && ev.target.closest(".na-recip-box");
      // Scoped to THIS action's fields — a pill must not jump between two
      // Notify actions, whose recipients are unrelated.
      if (!box || !host.contains(box) || !_naDragEl || _naDragEl.parentNode === box) return;
      // No cue for a field this kind can't live in, so the drop is refused
      // before the operator lets go rather than after.
      if (!pillAllowedInField(_naDragEl.getAttribute("data-kind"), box.getAttribute("data-field"), boxMode(box))) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      if (_naDragCue !== box) {
        if (_naDragCue) _naDragCue.classList.remove("aw-drop-into");
        _naDragCue = box;
        box.classList.add("aw-drop-into");
      }
    });
    host.addEventListener("drop", function (ev) {
      var box = ev.target.closest && ev.target.closest(".na-recip-box");
      if (!box || !_naDragEl || _naDragEl.parentNode === box) { naClearDrag(); return; }
      ev.preventDefault();
      var p = {
        kind: _naDragEl.getAttribute("data-kind"),
        value: _naDragEl.getAttribute("data-value"),
        label: _naDragEl.getAttribute("data-label") || "",
        unknown: _naDragEl.hasAttribute("data-unknown"),
      };
      if (!pillAllowedInField(p.kind, box.getAttribute("data-field"), boxMode(box))) {
        // Keep the pill where it was: it resolves per alert, and Cc/Bcc are
        // fixed lists with no slot for it in the wire shape.
        showToast("“" + p.label + "” can only be a To recipient", "error");
        naClearDrag();
        return;
      }
      var moved = addPill(box, p);
      _naDragEl.remove();       // a move, not a copy — remove either way, since
      naClearDrag();            // a duplicate in the destination means it's there
      if (moved) onChange();
    });
    host.addEventListener("dragend", naClearDrag);
    host.addEventListener("dragleave", function (ev) {
      if (_naDragCue && ev.target === _naDragCue) { _naDragCue.classList.remove("aw-drop-into"); _naDragCue = null; }
    });
  }

  function renderActionFields(row, action) {
    var box = row.querySelector(".aw-action-fields");
    var t = action.type;
    row.querySelector(".aw-action-summary").textContent = actionSummary(action);
    if (t === "notify") {
      var comp = action.emailComposition || null;
      // Checked only when the STORED action actually carries its own templates.
      // A new action starts unchecked (= the default email), with the fields
      // prefilled from that same default so ticking the box shows the real text
      // to edit rather than an empty page.
      var customEmail = !!(comp && (comp.subjectTemplate || comp.bodyTextTemplate || comp.bodyHtmlTemplate));
      var selIds = actionChannelIds(action);
      if (!selIds.length && channels.length) selIds = [channels[0].id];
      var html =
        // CHANNELS, plural. One action may deliver through several — which is
        // what lets a single "page the on-call" action carry both an email and
        // a push channel and let each recipient's own preference pick between
        // them (the checkbox below). A checkbox list rather than a multi-select:
        // the set is small, the types matter, and a <select multiple> hides
        // what is chosen the moment it scrolls.
        '<div class="form-group" style="margin-bottom:6px">' +
          '<label style="font-size:0.8rem;display:block;margin-bottom:2px">Channels</label>' +
          '<div class="na-chan-list" style="display:flex;flex-wrap:wrap;gap:4px 14px">' + channelChecklist(selIds) + '</div>' +
        '</div>' +
        '<div class="na-fields"></div>' +
        // Cc/Bcc were promoted OUT of this disclosure into first-class token
        // fields above; what's left is genuinely about composing the message.
        // The template fields are PREFILLED with the default alert email
        // (schema.defaultEmailTemplate — the same strings the server renders
        // when they're blank), so the operator reads and edits exactly what
        // will be sent instead of guessing at a hidden default. A stored
        // action keeps whatever it saved.
        // A CHECKBOX, not a disclosure. A `<details>` says "there's more to read
        // here"; the real question is whether this action sends the default email
        // or a bespoke one, and that is a decision with two states. Unchecked
        // stores no templates at all, so the action follows the shared default
        // for good — including future changes to it — rather than freezing a
        // copy the operator never asked to own. (The old disclosure prefilled
        // the fields and collected them regardless of whether it was open, so a
        // new action silently stored its own snapshot of the default.)
        // Per-recipient channel selection. Above the composition block because
        // it decides WHO is reached, and the block below only decides what the
        // email says. Gated by refreshPrefGating(): meaningless — and disabled
        // — until this action list actually offers both methods.
        '<div class="na-pref" style="display:none">' +
          '<label style="font-size:0.8rem;display:block;margin-top:4px"><input type="checkbox" class="na-pref-enable"' +
            (action.respectUserPreference ? " checked" : "") + '> Only use the channel matching the user’s preferred notification method</label>' +
          '<p class="hint na-pref-hint" style="margin:2px 0 6px 22px"></p>' +
        '</div>' +
        '<div class="na-comp">' +
          '<label style="font-size:0.8rem;display:block;margin-top:4px"><input type="checkbox" class="na-comp-enable"' + (customEmail ? " checked" : "") + '> Customize the email (subject / body)</label>' +
          '<p class="hint" style="margin:2px 0 6px 22px">Unchecked, this action sends the default Polaris alert email.</p>' +
          '<div class="na-comp-body"' + (customEmail ? "" : ' style="display:none"') + '>' +
            '<p class="hint" style="margin:0 0 6px">This is the email Polaris sends. Edit it freely — ' +
              '<code>{ack}</code> becomes the recipient’s one-click acknowledge link, <code>{asset.link}</code> opens the device, and ' +
              '<code>{chart.cpu}</code> / <code>{chart.memory}</code> / <code>{chart.responseTime}</code> embed the last hour as charts, and ' +
              '<code>{interface.lldp}</code> lists what LLDP saw on the port an interface alert fired on. ' +
              '<button type="button" class="na-comp-reset" style="background:none;border:0;padding:0;color:var(--color-primary);cursor:pointer;font:inherit;text-decoration:underline">Reset to the default</button></p>' +
            '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Subject</label><input type="text" class="na-subject tpl-field" value="' + escapeHtml(compValue(comp, "subjectTemplate")) + '" placeholder="[{severity.upper}] {asset} — {metric} = {value}"></div>' +
            // ONE body editor with a view toggle. Both bodies are still stored
            // and both are still sent — a mail client picks which part it shows,
            // and the default template ships both deliberately. The toggle only
            // chooses which one is on screen; showing two big textareas at once
            // made the panel unreadable and implied a choice that isn't there.
            '<div class="form-group" style="margin-bottom:6px">' +
              '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">' +
                '<label style="font-size:0.8rem;margin:0">Body</label>' +
                '<span class="na-body-mode">' +
                  '<button type="button" class="btn btn-sm btn-primary na-mode" data-mode="text">Plain text</button>' +
                  '<button type="button" class="btn btn-sm btn-secondary na-mode" data-mode="html">HTML</button>' +
                '</span>' +
                '<span class="hint" style="margin:0">Both are sent — HTML for clients that render it, plain text for the rest.</span>' +
              '</div>' +
              // The variables stay visible in BOTH modes: they're the whole
              // vocabulary of the field being edited, and hiding them behind a
              // second disclosure inside a disclosure is what made them
              // undiscoverable.
              '<div style="margin:0 0 4px">' + tokenChipsHtml() + '</div>' +
              '<textarea class="na-body tpl-field" data-body-mode="text" rows="10" style="width:100%">' + escapeHtml(compValue(comp, "bodyTextTemplate")) + '</textarea>' +
              '<textarea class="na-html tpl-field" data-body-mode="html" rows="14" style="width:100%;display:none;font-family:var(--font-mono);font-size:0.8rem">' + escapeHtml(compValue(comp, "bodyHtmlTemplate")) + '</textarea>' +
            '</div>' +
          '</div>' +
        '</div>';
      box.innerHTML = html;
      var renderRecipients = function () {
        // The action's channels, as a SET of capabilities rather than one type.
        // A mixed action (email + push) renders the union: To for everyone,
        // Cc/Bcc because an email channel is present, the broadcast toggles
        // because a push channel is. The recipient FIELDS were always
        // transport-agnostic on the wire — only the old single-select forced
        // the UI to pick one shape.
        var sel = actionChannels({ channelIds: checkedChannelIds(row), channelId: "" });
        var fbox = box.querySelector(".na-fields");
        var compEl = box.querySelector(".na-comp");
        var prefEl = box.querySelector(".na-pref");
        var anyEmail = sel.some(function (x) { return isEmailType(x.type); });
        var anyPush = sel.some(function (x) { return x.type === "web_push"; });
        var fixed = sel.filter(function (x) { return !isRouted(x.type); });
        if (compEl) compEl.style.display = anyEmail ? "" : "none";
        // Offered on every recipient-routed action; ENABLED only where the
        // group carries both methods (refreshPrefGating owns that half).
        if (prefEl) prefEl.style.display = (anyEmail || anyPush) ? "" : "none";
        if (!channels.length) {
          fbox.innerHTML = '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0 0 6px">Add a channel in the Delivery tab first.</p>';
          return;
        }
        if (!sel.length) {
          fbox.innerHTML = '<p style="font-size:0.78rem;color:var(--color-warning,#d97706);margin:0 0 6px">Pick at least one channel above.</p>';
          return;
        }
        // A fixed-destination channel (Slack / Teams / Pushbullet) posts where
        // it is configured to and takes no recipients, so it is stated rather
        // than given controls — and it never suppresses the routed channels
        // sharing the action with it.
        var fixedNote = fixed.length
          ? '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0 0 6px">' +
            escapeHtml(fixed.map(function (x) { return x.name; }).join(", ")) +
            (fixed.length === 1 ? ' posts to its' : ' post to their') + ' configured destination — no recipients to choose.</p>'
          : "";
        if (!anyEmail && !anyPush) { fbox.innerHTML = fixedNote; return; }
        var isPush = anyPush;
        // A To pill has to be deliverable by SOMETHING this action carries. An
        // email channel makes every kind deliverable; push alone narrows the
        // box to the kinds that resolve to ACCOUNTS (an address and an
        // address-book contact have no subscription behind them). So the mode
        // is "push" only when there is no email channel to carry them.
        var toMode = anyEmail ? "email" : "push";
        // BOTH BROADCAST TOGGLES DEFAULT TO CHECKED on a NEW action (operator
        // decision): a push automation usually does mean "tell everyone", and
        // unchecking is one click. On a STORED action they reflect what was
        // saved — `isNew` keeps an old rule that listed three people from
        // silently becoming a fleet-wide broadcast on next edit.
        var isNew = !action.channelId && !(action.channelIds && action.channelIds.length);
        var allUsers = anyPush && (isNew ? action.recipientAllUsers !== false : !!action.recipientAllUsers);
        var allRegions = anyPush && (isNew ? action.recipientAllRegions !== false : !!action.recipientAllRegions);
        // "All Users" replaces the recipient list — but only where push is
        // the ONLY method. On a mixed action the email half still needs a To
        // list, so the broadcast covers push and the field stays visible.
        var hideTo = allUsers && !anyEmail;
        var comp0 = action.emailComposition || {};
        // ONE To field whichever channels are selected: the recipients ARE the
        // same vocabulary (accounts, roles, map regions, and the two dynamic
        // "asset's …" entries) on both transports. Cc and Bcc are email's
        // alone — a push is delivered per endpoint, so a "copy" is just
        // another recipient.
        var h = fixedNote +
          '<div class="na-users-block"' + (hideTo ? ' style="display:none"' : "") + '>' +
            '<div class="na-recips">' +
              recipBoxHtml("to", "To", recipientsToPills(action, _ruleRecipientUsers, awRoles(), awRegionMaxLevel()), canReadContacts(), toMode) +
              (anyEmail
                ? recipBoxHtml("cc", "Cc", recipientsToPills(comp0.cc, _ruleRecipientUsers, awRoles()), false) +
                  recipBoxHtml("bcc", "Bcc", recipientsToPills(comp0.bcc, _ruleRecipientUsers, awRoles()), false)
                : "") +
            "</div>" +
            (anyEmail
              ? '<p class="hint" style="margin:0 0 6px">Anything in Cc or Bcc sends <strong>one</strong> message with the full To list visible, instead of a separate email per recipient.</p>'
              : "") +
            // SAY WHO IS UNREACHABLE. Push is opt-in per browser, so a named
            // user with no enrolled device is a recipient that silently
            // receives nothing — this line and the picker's "Push devices"
            // column are the only places that admit it. On a MIXED action they
            // still get the email, which the line says rather than implying a
            // total loss.
            (anyPush ? '<div class="na-push-warn">' + pushReachWarning(action.recipientUserIds, anyEmail) + "</div>" : "") +
          "</div>" +
          (anyPush
            ? '<div class="form-group na-push-block" style="margin:6px 0 0">' +
                '<label style="display:block;font-size:0.8rem;margin:0 0 4px"><input type="checkbox" class="na-all-users"' +
                  (allUsers ? " checked" : "") + '> <strong>Send to All Users</strong>' +
                  (anyEmail ? ' <span class="hint" style="margin:0">(push only)</span>' : "") + '</label>' +
                '<label style="display:block;font-size:0.8rem;margin:6px 0 4px"><input type="checkbox" class="na-all-regions"' +
                  (allRegions ? " checked" : "") + (allUsers ? " disabled" : "") +
                  '> <strong>Send to All User Regions</strong>' +
                  (anyEmail ? ' <span class="hint" style="margin:0">(push only)</span>' : "") + '</label>' +
                // "All users" already covers every region, so the region toggle
                // is disabled rather than left to look meaningful but change
                // nothing.
                '<p class="hint na-region-note" style="margin:4px 0 0' + (allUsers ? "" : ";display:none") + '">' +
                  "“All Users” already includes everyone in every region." +
                "</p>" +
                '<p class="hint na-reach" style="margin:4px 0 0"></p>' +
              "</div>"
            : "");
        // Device-region routing (match users' region tags against the TRIGGERING
        // asset's own region: tag at fire time) and address-book ownership (the
        // contacts whose device filter covers it) are RECIPIENTS, so they are
        // pills in the To field alongside everyone else, on push as well as on
        // email — added by typing or from the address-book picker's Regions
        // tab. They were checkboxes, which split "who gets this alert" across
        // two controls and left the To field looking empty when the answer was
        // "whoever owns the box". Asset contacts stay EMAIL-ONLY (a contact is
        // an address, not an account, so there is no push endpoint behind it) —
        // enforced by the To field's own kind list, not by a second control.
        // Legacy scope-region routing (replaced by device-region in the
        // builder): rendered ONLY when the edited action already carries it,
        // so editing an old rule can't silently drop the recipients.
        if (action.recipientScopeRegion) {
          h += '<label style="display:block;font-size:0.8rem;margin:0"><input type="checkbox" class="na-scope-region" checked> …or users associated with the automation’s region (legacy — routes by the region: tag in the device filter)</label>';
        }
        fbox.innerHTML = h;
        var recips = fbox.querySelector(".na-recips");
        // Assigned below on a push channel; every pill edit has to refresh the
        // reachability line as well as the summary, and the box's onChange is
        // the only place that sees them all (typing, picker, drag, delete).
        var onPillsChanged = null;
        var resummarize = function () {
          row.querySelector(".aw-action-summary").textContent =
            actionSummary(collectActionCore("notify", box) || { type: "notify", channelId: sel[0].id });
        };
        if (recips) {
          wireRecipBoxes(recips, function () {
            resummarize();
            if (onPillsChanged) onPillsChanged();
          });
        }
        // Recompute the reachability warning as the operator changes the
        // selection, rather than only on first paint.
        if (isPush) {
          // Broadcast toggles: reveal the To field, keep the region toggle
          // inert while "All Users" covers everyone, and keep the resolved-
          // count line honest.
          var allUsersEl = fbox.querySelector(".na-all-users");
          var allRegionsEl = fbox.querySelector(".na-all-regions");
          var usersBlock = fbox.querySelector(".na-users-block");
          var noteEl = fbox.querySelector(".na-region-note");
          var reachEl = fbox.querySelector(".na-reach");
          var warnBox = fbox.querySelector(".na-push-warn");
          var toBoxEl = fbox.querySelector('.na-recip-box[data-field="to"]');
          // Recomputed from the PILLS on every change, so removing the one
          // person with a device is called out the moment it happens.
          var syncWarn = function () {
            if (!warnBox || !toBoxEl) return;
            var ids = pillsOf(toBoxEl)
              .filter(function (x) { return x.kind === "user"; })
              .map(function (x) { return x.value; });
            warnBox.innerHTML = pushReachWarning(ids, anyEmail);
          };
          var syncPush = function () {
            var au = allUsersEl.checked;
            // The broadcast covers PUSH only, so it may hide the recipient
            // field only when push is all this action does. On a mixed action
            // the To list is still the email half's entire answer.
            usersBlock.style.display = (au && !anyEmail) ? "none" : "";
            allRegionsEl.disabled = au;
            if (noteEl) noteEl.style.display = au ? "" : "none";
            if (reachEl) {
              reachEl.textContent = au
                ? pushReachAllLine()
                : allRegionsEl.checked
                  ? "Sends to every user who carries at least one region tag, plus anyone named above."
                  : "";
            }
            syncWarn();
            resummarize();
          };
          allUsersEl.addEventListener("change", syncPush);
          allRegionsEl.addEventListener("change", syncPush);
          onPillsChanged = syncWarn;
          syncPush();
        }
      };
      var compEnable = box.querySelector(".na-comp-enable");
      if (compEnable) {
        compEnable.addEventListener("change", function () {
          box.querySelector(".na-comp-body").style.display = this.checked ? "" : "none";
          // Nothing is cleared on un-tick: the typed text stays in the DOM and is
          // simply not collected, so a mis-click doesn't destroy an edit the
          // operator can restore by ticking the box again.
          row.querySelector(".aw-action-summary").textContent =
            actionSummary(collectActionCore("notify", box) || { type: "notify", channelId: "" });
        });
      }
      // Body view toggle: swap which textarea is on screen, and which button
      // reads as selected. Neither value is touched — this is a view switch.
      box.querySelectorAll(".na-mode").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var mode = btn.getAttribute("data-mode");
          box.querySelectorAll(".na-mode").forEach(function (b) {
            var on = b === btn;
            b.classList.toggle("btn-primary", on);
            b.classList.toggle("btn-secondary", !on);
          });
          box.querySelectorAll("[data-body-mode]").forEach(function (ta) {
            ta.style.display = ta.getAttribute("data-body-mode") === mode ? "" : "none";
          });
        });
      });
      var compReset = box.querySelector(".na-comp-reset");
      if (compReset) {
        compReset.addEventListener("click", function () {
          var d = defaultEmailTemplate();
          box.querySelector(".na-subject").value = d.subjectTemplate || "";
          box.querySelector(".na-body").value = d.bodyTextTemplate || "";
          box.querySelector(".na-html").value = d.bodyHtmlTemplate || "";
        });
      }
      box.querySelectorAll(".na-chan").forEach(function (cb) {
        cb.addEventListener("change", function () {
          var ids = checkedChannelIds(row);
          row.querySelector(".aw-action-summary").textContent =
            actionSummary({ type: "notify", channelId: ids[0] || "", channelIds: ids });
          renderRecipients();
          // Ticking a channel can change which METHODS this action list offers,
          // which enables or disables the preference checkbox on EVERY row in
          // it — not just this one.
          refreshPrefGating(row.parentNode);
        });
      });
      var prefEnable = box.querySelector(".na-pref-enable");
      if (prefEnable) {
        prefEnable.addEventListener("change", function () {
          row.querySelector(".aw-action-summary").textContent =
            actionSummary(collectActionCore("notify", box) || { type: "notify", channelId: "" });
        });
      }
      renderRecipients();
      refreshPrefGating(row.parentNode);
    } else if (t === "api_call") {
      var meta = s.apiCallMeta || { allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"] };
      var headers = action.headers || {};
      var headerRows = Object.keys(headers).map(function (k) { return apiHeaderRowHtml(k, headers[k]); }).join("");
      box.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
          '<select class="ac-method" style="width:auto">' + opt(meta.allowedMethods, action.method || "POST") + '</select>' +
          '<input type="text" class="ac-url" value="' + escapeHtml(action.url || "") + '" placeholder="https://api.example.com/hook" style="flex:1">' +
        '</div>' +
        '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Headers</label><div class="ac-headers">' + headerRows + '</div>' +
          '<button type="button" class="btn btn-sm btn-secondary ac-add-header" style="margin-top:4px">+ Header</button>' +
          '<p class="ac-header-warn" style="display:none;font-size:0.78rem;color:var(--color-warning,#d97706);margin:4px 0 0">Headers are stored unmasked on the automation — never paste API keys, tokens, or credentials.</p>' +
        '</div>' +
        '<div class="form-group ac-body-wrap" style="margin-bottom:6px"><label style="font-size:0.8rem">Body template (JSON — tokens like {asset} render at fire time)</label><textarea class="ac-body tpl-field" rows="4" style="width:100%;font-family:var(--font-mono)" placeholder=\'{"asset":"{asset}","value":{value},"severity":"{severity}"}\'>' + escapeHtml(action.bodyTemplate || "") + '</textarea></div>' +
        '<div class="form-group" style="margin-bottom:0"><label style="font-size:0.8rem">Timeout</label> <input type="number" class="ac-timeout" min="1" max="' + (meta.maxTimeoutSec || 60) + '" value="' + (action.timeoutSec || 15) + '" style="width:80px"> sec</div>';
      var syncApiBits = function () {
        var m = box.querySelector(".ac-method").value;
        box.querySelector(".ac-body-wrap").style.display = m === "GET" ? "none" : "";
        row.querySelector(".aw-action-summary").textContent = actionSummary({ type: "api_call", method: m, url: box.querySelector(".ac-url").value });
        var warn = box.querySelector(".ac-header-warn");
        var suspicious = Array.from(box.querySelectorAll(".ac-hname")).some(function (el) { return /authorization|api-?key|token|secret/i.test(el.value); });
        warn.style.display = suspicious ? "" : "none";
      };
      box.querySelector(".ac-add-header").addEventListener("click", function () {
        var div = document.createElement("div");
        div.innerHTML = apiHeaderRowHtml("", "");
        box.querySelector(".ac-headers").appendChild(div.firstChild);
        wireHeaderRows(box, syncApiBits);
      });
      box.addEventListener("input", syncApiBits);
      wireHeaderRows(box, syncApiBits);
      syncApiBits();
    } else if (t === "script") {
      var scripts = _awScripts || [];
      if (!scripts.length) {
        box.innerHTML = '<p style="font-size:0.82rem;color:var(--color-text-tertiary);margin:0">No scripts in the registry yet — add one on the Scripts tab first.</p>';
        return;
      }
      var scOpts = scripts.map(function (x) {
        return '<option value="' + escapeHtml(x.id) + '"' + (x.id === action.scriptId ? " selected" : "") + '>' + escapeHtml(x.name + " (" + x.interpreter + ", " + x.runTarget + ")") + '</option>';
      }).join("");
      box.innerHTML =
        '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Script</label><select class="sa-script" style="width:100%">' + scOpts + '</select></div>' +
        '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Run on</label> ' +
          '<label style="font-size:0.85rem;margin-right:10px"><input type="radio" class="sa-runon" name="sa-runon-' + Math.random().toString(36).slice(2, 8) + '" value="server"> the Polaris server</label>' +
          '<label style="font-size:0.85rem"><input type="radio" class="sa-runon-agent" value="agent"> the triggering asset’s agent</label>' +
        '</div>' +
        '<div class="form-group" style="margin-bottom:6px"><label style="font-size:0.8rem">Arguments (one string; tokens render at fire time)</label><input type="text" class="sa-args tpl-field" value="' + escapeHtml(action.argsTemplate || "") + '" placeholder="{asset} {value}"></div>' +
        '<div class="form-group" style="margin-bottom:0"><label style="font-size:0.8rem">Timeout override</label> <input type="number" class="sa-timeout" min="1" max="600" value="' + (action.timeoutSec || "") + '" style="width:80px" placeholder="script default"> sec</div>' +
        '<p style="font-size:0.78rem;color:var(--color-warning,#d97706);margin:6px 0 0">Scripts run with full privileges (Polaris service account / agent root). A human must review a script before enabling it in production.</p>';
      var runonServer = box.querySelector('.sa-runon');
      var runonAgent = box.querySelector('.sa-runon-agent');
      // Radios must share a name per row; wire them as a pair manually.
      var group = "sa-runon-" + Math.random().toString(36).slice(2, 8);
      runonServer.name = group; runonAgent.name = group;
      var syncScriptBits = function () {
        var sc = scriptById(box.querySelector(".sa-script").value) || {};
        var canServer = sc.runTarget === "server" || sc.runTarget === "either";
        var canAgent = sc.runTarget === "agent" || sc.runTarget === "either";
        runonServer.disabled = !canServer;
        runonAgent.disabled = !canAgent;
        var want = action.runOn || (canServer ? "server" : "agent");
        if (want === "server" && !canServer) want = "agent";
        if (want === "agent" && !canAgent) want = "server";
        (want === "agent" ? runonAgent : runonServer).checked = true;
        row.querySelector(".aw-action-summary").textContent = actionSummary({ type: "script", scriptId: sc.id, runOn: want });
      };
      box.querySelector(".sa-script").addEventListener("change", syncScriptBits);
      syncScriptBits();
    } else if (t === "event") {
      // Nothing to configure — the severity, message and resource all come from
      // the fire. The note earns its place because the two trigger families
      // behave differently: an event/change automation is DRIVEN by Events, so
      // the engine deliberately writes none of its own (that would loop).
      var ecTrigger = draft.trigger && (draft.trigger.type === "event" || draft.trigger.type === "change");
      box.innerHTML = ecTrigger
        ? '<p style="font-size:0.82rem;color:var(--color-warning,#d97706);margin:0">This automation is triggered BY Events, so it deliberately writes none of its own — an audit Event here would feed back into the trigger. Remove this action; it has no effect.</p>'
        : '<p style="font-size:0.82rem;color:var(--color-text-tertiary);margin:0">Writes a <strong>notification.triggered</strong> audit Event on every fire, at the alert’s severity, carrying the message from the card above. Visible on the Events tab and forwarded by syslog / SFTP archival. Remove it for a deliberately noisy automation — the in-app alert is unaffected.</p>';
    }
  }
  function apiHeaderRowHtml(k, v) {
    return '<div class="ac-hrow" style="display:flex;gap:6px;margin-bottom:4px">' +
      '<input type="text" class="ac-hname" value="' + escapeHtml(k) + '" placeholder="Header-Name" style="width:38%">' +
      '<input type="text" class="ac-hval" value="' + escapeHtml(v) + '" placeholder="value" style="flex:1">' +
      '<button type="button" class="btn btn-sm btn-danger ac-hremove">&times;</button>' +
    '</div>';
  }
  function wireHeaderRows(box, onChange) {
    box.querySelectorAll(".ac-hremove").forEach(function (b) {
      if (b._wired) return; b._wired = true;
      b.addEventListener("click", function () { b.closest(".ac-hrow").remove(); onChange(); });
    });
  }
  function collectAction(row) {
    var t = row.querySelector(".aw-action-type").value;
    var box = row.querySelector(":scope > .aw-action-fields");
    var a = collectActionCore(t, box);
    if (!a) return null;
    // Per-action escalation (escalatable rows only — tier-hosted rows have no
    // .aw-esc-sec, and :scope keeps a nested tier's sections out of reach).
    var esc = collectEscSection(row.querySelector(":scope > .aw-esc-sec"));
    if (esc) a.escalation = esc;
    return a;
  }
  function collectActionCore(t, box) {
    if (t === "notify") {
      // Ticked channels in LIST order, so channelId (the primary, and the
      // lossless single-channel mirror every legacy reader still uses) is
      // always channelIds[0] — which is exactly what the server re-checks.
      var chIds = checkedChannelIds(box);
      if (!chIds.length) return null;
      var a = { type: "notify", channelId: chIds[0] };
      if (chIds.length > 1) a.channelIds = chIds;
      // Push broadcast toggles. "All Users" subsumes every narrower source, so
      // nothing under it is collected — persisting a recipient list the UI
      // isn't showing would resurface on the next edit. Read BEFORE the pills,
      // because it decides whether they count. Both are absent on an email
      // action, where the To field is the only answer.
      var allUsersEl2 = box.querySelector(".na-all-users");
      var allRegionsEl2 = box.querySelector(".na-all-regions");
      var broadcastAll = !!(allUsersEl2 && allUsersEl2.checked);
      if (broadcastAll) a.recipientAllUsers = true;
      else if (allRegionsEl2 && allRegionsEl2.checked) a.recipientAllRegions = true;
      // To pills — the same collection on email and push, since the push box
      // is the same control with a narrower kind list.
      var toBox = box.querySelector('.na-recip-box[data-field="to"]');
      if (toBox && !broadcastAll) {
        var to = pillsToRecipients(pillsOf(toBox));
        if (to.recipientUserIds) a.recipientUserIds = to.recipientUserIds;
        if (to.addresses) a.addresses = to.addresses;
        if (to.recipientRoles) a.recipientRoles = to.recipientRoles;
        if (to.recipientRegions) a.recipientRegions = to.recipientRegions;
        if (to.recipientTags) a.recipientTags = to.recipientTags;
        // The two dynamic pills — on an email action these REPLACE the old
        // checkboxes, so they're collected from the To field and nowhere else.
        if (to.recipientDeviceRegion) a.recipientDeviceRegion = true;
        if (to.recipientDeviceRegionLevels) a.recipientDeviceRegionLevels = to.recipientDeviceRegionLevels;
        if (to.recipientAssetContacts) a.recipientAssetContacts = true;
      }
      // Per-recipient channel selection. Collected only while the checkbox is
      // ENABLED: a disabled one is a group with a single method on offer, where
      // the flag would change nothing at delivery and would resurface as a
      // ticked-but-inert box on the next edit.
      var prefEl = box.querySelector(".na-pref-enable");
      if (prefEl && prefEl.checked && !prefEl.disabled) a.respectUserPreference = true;
      // Legacy scope-region checkbox renders only on actions that already
      // carried the flag — unchecking it drops the flag deliberately.
      var regEl = box.querySelector(".na-scope-region");
      if (regEl && regEl.checked) a.recipientScopeRegion = true;
      // Per-action email composition (collected when ANY selected channel is an
      // email one; the block is hidden otherwise).
      if (chIds.map(chanById).some(function (x) { return x && isEmailType(x.type); })) {
        var c = {};
        // Only when the operator asked to customize. Unchecked stores NO
        // templates, so buildComposedEmail falls back to the shared default for
        // every piece — the action tracks the default instead of freezing a copy.
        var compOn = box.querySelector(".na-comp-enable");
        if (compOn && compOn.checked) {
          var subj = (box.querySelector(".na-subject") || {}).value || ""; if (subj.trim()) c.subjectTemplate = subj.trim();
          var bodyTxt = (box.querySelector(".na-body") || {}).value || ""; if (bodyTxt.trim()) c.bodyTextTemplate = bodyTxt;
          // Both bodies are stored: the toggle is a view switch, not a choice of
          // which one to send. A blank one still falls back per field.
          var h = (box.querySelector(".na-html") || {}).value || ""; if (h.trim()) c.bodyHtmlTemplate = h;
        }
        // Cc/Bcc ride emailComposition (unchanged storage), but now carry user
        // ids as well as raw addresses — emailRecipientsSchema always allowed
        // both; only the old UI couldn't produce them.
        var ccBox = box.querySelector('.na-recip-box[data-field="cc"]');
        var bccBox = box.querySelector('.na-recip-box[data-field="bcc"]');
        if (ccBox) { var ccR = pillsToRecipients(pillsOf(ccBox)); if (Object.keys(ccR).length) c.cc = ccR; }
        if (bccBox) { var bccR = pillsToRecipients(pillsOf(bccBox)); if (Object.keys(bccR).length) c.bcc = bccR; }
        if (Object.keys(c).length) a.emailComposition = c;
      }
      return a;
    }
    if (t === "api_call") {
      var a2 = {
        type: "api_call",
        method: box.querySelector(".ac-method").value,
        url: box.querySelector(".ac-url").value.trim(),
        timeoutSec: Number(box.querySelector(".ac-timeout").value) || 15,
      };
      var hdrs = {};
      box.querySelectorAll(".ac-hrow").forEach(function (hr) {
        var k = hr.querySelector(".ac-hname").value.trim();
        var v = hr.querySelector(".ac-hval").value;
        if (k) hdrs[k] = v;
      });
      if (Object.keys(hdrs).length) a2.headers = hdrs;
      if (a2.method !== "GET") { var bt = box.querySelector(".ac-body").value; if (bt.trim()) a2.bodyTemplate = bt; }
      return a2;
    }
    if (t === "script") {
      var scSel = box.querySelector(".sa-script");
      if (!scSel) return null;
      var runOnEl = box.querySelector('input.sa-runon:checked, input.sa-runon-agent:checked');
      var a3 = { type: "script", scriptId: scSel.value, runOn: runOnEl ? runOnEl.value : "server" };
      var args = box.querySelector(".sa-args").value; if (args.trim()) a3.argsTemplate = args;
      var to = box.querySelector(".sa-timeout").value;
      if (to !== "" && !isNaN(Number(to))) a3.timeoutSec = Number(to);
      return a3;
    }
    // The audit Event carries no configuration — its presence IS the setting.
    if (t === "event") return { type: "event" };
    return null;
  }
  function collectActionsFrom(host) {
    var out = [];
    host.querySelectorAll(":scope > .aw-action").forEach(function (row) {
      var a = collectAction(row);
      if (!a) return;
      // `_mirrorOf` marks a reset row still following its trigger action. It's
      // wizard bookkeeping, never part of the saved rule (the server schema is
      // .strict() and would reject it).
      if (row._mirrorOf) a._mirrorOf = row._mirrorOf;
      out.push(a);
    });
    return out;
  }

  /** Strip the wizard-only markers before the payload leaves the browser. */
  function stripMirrorMarks(actions) {
    return (actions || []).map(function (a) {
      var copy = JSON.parse(JSON.stringify(a));
      delete copy._mirrorOf;
      return copy;
    });
  }

  // Escalation tier row — afterMin/repeat controls + a nested action list.
  // onChange (optional) fires when the row is removed, so the owning
  // escalation section can hide its stop-condition config.
  function addTierRow(host, tier, onChange) {
    tier = tier || { afterMin: 15, actions: [] };
    var row = document.createElement("div");
    row.className = "aw-tier";
    row.style.cssText = "border:1px solid var(--color-border);border-radius:6px;padding:0.6rem;margin-bottom:6px";
    row.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">' +
        '<label style="margin:0;font-size:0.8rem;font-weight:600">Escalate after</label>' +
        '<input type="number" class="tier-after" min="1" value="' + (tier.afterMin != null ? tier.afterMin : 15) + '" style="width:80px" title="Minutes after the alert fires (while it stays unhandled)">' +
        '<label style="margin:0;font-size:0.8rem">minutes unhandled, repeat every</label>' +
        '<input type="number" class="tier-repeat" min="5" value="' + (tier.repeatEveryMin != null ? tier.repeatEveryMin : "") + '" style="width:80px" placeholder="off"> min,' +
        '<label style="margin:0;font-size:0.8rem">max</label>' +
        '<input type="number" class="tier-max" min="1" max="20" value="' + (tier.maxRepeats != null ? tier.maxRepeats : "") + '" style="width:70px" placeholder="5">' +
        '<button type="button" class="btn btn-sm btn-danger tier-remove" style="margin-left:auto">Remove escalation</button>' +
      '</div>' +
      '<div class="tier-actions"></div>' +
      '<button type="button" class="btn btn-sm btn-secondary tier-add-action">+ Add action</button>';
    host.appendChild(row);
    row.querySelector(".tier-remove").addEventListener("click", function () {
      row.remove();
      if (onChange) onChange();
    });
    // Tier-hosted action rows are never escalatable (no chains inside chains —
    // the server schema rejects it).
    var actionsHost = row.querySelector(".tier-actions");
    (tier.actions || []).forEach(function (a) { addActionRow(actionsHost, a); });
    row.querySelector(".tier-add-action").addEventListener("click", function () { foldActionRow(addActionRow(actionsHost, null), false); });
    return row;
  }

  // Collect escalation-tier rows from a host (shared by the base escalation and
  // each severity band's escalation).
  function collectTierRows(host) {
    var tiers = [];
    host.querySelectorAll(":scope > .aw-tier").forEach(function (row) {
      var t = { afterMin: Number(row.querySelector(".tier-after").value) || 0, actions: collectActionsFrom(row.querySelector(".tier-actions")) };
      var rep = row.querySelector(".tier-repeat").value;
      if (rep !== "") {
        t.repeatEveryMin = Number(rep);
        var mx = row.querySelector(".tier-max").value;
        if (mx !== "") t.maxRepeats = Number(mx);
      }
      tiers.push(t);
    });
    return tiers;
  }
  function collectStep5() {
    var panel = document.getElementById("aw-step-5");
    var host = panel.querySelector("#aw-actions");
    if (!host) return;
    // The alert/event message rides the mandatory in-app card on this step.
    var msgEl = panel.querySelector("#aw-msg");
    if (msgEl) draft.messageTemplate = msgEl.value.trim() || null;
    var ackNoteEl = panel.querySelector("#aw-require-ack-note");
    if (ackNoteEl) draft.requireAckNote = ackNoteEl.checked;
    // Re-notify cooldown was retired in 2026-08 (see the fromRule note): the
    // draft always carries null, so saving through the wizard clears one an
    // older rule still stored.
    draft.cooldownSec = null;
    // Repeat, also a property of the alert record.
    var repOn = panel.querySelector("#aw-repeat-on");
    if (repOn) {
      if (!repOn.checked) {
        draft.repeat = null;
      } else {
        var every = Number((panel.querySelector("#aw-repeat-every") || {}).value);
        var stopOnEl = panel.querySelector("#aw-repeat-stopon");
        var afterRaw = (panel.querySelector("#aw-repeat-stopafter") || {}).value;
        var rep = {
          everyMin: isNaN(every) ? 0 : every,
          stopOn: stopOnEl && stopOnEl.value === "clear" ? "clear" : "acknowledge",
        };
        // Blank means unbounded, which is the default the operator asked for —
        // so the key is omitted rather than sent as 0.
        if (afterRaw !== "" && afterRaw != null && !isNaN(Number(afterRaw))) {
          rep.stopAfterHours = Number(afterRaw);
        }
        // Quiet time rides INSIDE repeat — it modifies the reminder clock and
        // nothing else, so it cannot outlive the control that owns it: turning
        // reminders off drops the windows with them.
        var quiet = collectQuiet(panel);
        if (quiet) rep.quiet = quiet;
        draft.repeat = rep;
      }
    }
    // The BASE severity section's chain is the rule-level escalation (the engine
    // resolves it for an alert sitting at the base severity).
    var baseSecC = panel.querySelector("#aw-actions") && panel.querySelector("#aw-actions").closest(".form-group");
    draft.escalation = baseSecC
      ? collectEscSection(baseSecC.querySelector(":scope > .aw-collapse-body > .aw-esc-sec, :scope > .aw-esc-sec"))
      : null;
    draft.actions = collectActionsFrom(host);
    // Per-severity sections write back onto their bands — and onto the step-3
    // band DOM rows' stash, so a later step-3 re-collect (collectBands) can't
    // lose them. Sections render in draft.severityBands order, which matches
    // the #aw-bands row order (both come from the same collect).
    var perSevCb = panel.querySelector("#aw-band-actions-multi");
    if (perSevCb) draft.bandActionsPerSeverity = perSevCb.checked;
    var bandRows = document.querySelectorAll("#aw-bands > .aw-band");
    panel.querySelectorAll(".aw-band-actions").forEach(function (sec, i) {
      var band = (draft.severityBands || [])[i];
      if (!band) return;
      band.actions = collectActionsFrom(sec.querySelector(".ba-actions"));
      var bandEsc = collectEscSection(sec.querySelector(":scope > .aw-collapse-body > .aw-esc-sec, :scope > .aw-esc-sec"));
      if (bandEsc) band.escalation = bandEsc; else delete band.escalation;
      if (bandRows[i]) {
        bandRows[i]._bandActions = band.actions;
        bandRows[i]._bandEscalation = bandEsc || null;
      }
    });
    var resetHost = panel.querySelector("#aw-reset-actions");
    if (resetHost) {
      var resetToggle = panel.querySelector("#aw-reset-actions-on");
      if (resetToggle) draft.resetOn = resetToggle.checked;
      draft.resetActions = draft.resetOn === false ? null : collectActionsFrom(resetHost);
      if (draft.resetActions && draft.resetActions.length === 0) draft.resetActions = null;
    }
  }

  /**
   * The reset list mirrors the trigger's NOTIFY actions as they're created:
   * add a Notify on the left and the same channel + recipients appear on the
   * right, so "tell the same people it came back" costs nothing.
   *
   * A mirrored row is marked (_mirrorOf, client-only — stripped by
   * collectActionsFrom like the band stash) and DETACHES the moment the
   * operator edits or deletes it. Rows that are still attached follow later
   * changes; an edited one never gets overwritten.
   */
  /** (Re)draw the reset rows, tagging the mirrored ones so they keep tracking. */
  function renderResetRows(panel, actions) {
    var host = panel.querySelector("#aw-reset-actions");
    if (!host) return;
    host.innerHTML = "";
    (actions || []).forEach(function (a) {
      addActionRow(host, a);
      var row = host.lastElementChild;
      if (row && a._mirrorOf) {
        row._mirrorOf = a._mirrorOf;
        // Any edit inside a mirrored row detaches it: from here it is the
        // operator's, and a later trigger change must not overwrite it.
        row.addEventListener("input", function () { detachMirror(row, panel); }, true);
        row.addEventListener("change", function () { detachMirror(row, panel); }, true);
        var rm = row.querySelector(".aw-action-remove");
        if (rm) rm.addEventListener("click", function () { setTimeout(function () { refreshMirrorNote(panel); }, 0); });
      }
    });
    refreshMirrorNote(panel);
  }

  function detachMirror(row, panel) {
    if (!row._mirrorOf) return;
    row._mirrorOf = null;
    refreshMirrorNote(panel);
  }

  /** Re-mirror after the TRIGGER action list changes (add / remove / channel). */
  function syncResetMirror(panel) {
    var host = panel.querySelector("#aw-reset-actions");
    var on = panel.querySelector("#aw-reset-actions-on");
    if (!host || !on || !on.checked) return;
    var current = collectActionsFrom(host);
    // Rows the operator has touched are kept verbatim; the rest re-derive.
    renderResetRows(panel, mirroredResetActions(collectActionsFrom(panel.querySelector("#aw-actions")), current));
  }

  function refreshMirrorNote(panel) {
    var note = panel.querySelector("#aw-reset-mirror-note");
    var host = panel.querySelector("#aw-reset-actions");
    if (!note || !host) return;
    var rows = Array.from(host.querySelectorAll(":scope > .aw-action"));
    var mirrored = rows.filter(function (r) { return !!r._mirrorOf; }).length;
    // The note is about COVERAGE of the trigger's notify actions, not about the
    // row count: the list also seeds a default audit Event, and a row that was
    // never mirrorable must not read as "edited".
    var triggerHost = panel.querySelector("#aw-actions");
    var mirrorable = (triggerHost ? collectActionsFrom(triggerHost) : [])
      .filter(function (a) { return a.type === "notify" && actionChannelIds(a).length; }).length;
    if (rows.length === 0) {
      note.textContent = "Nothing here yet — add an action, or add a Notify above and it will appear here.";
    } else if (mirrorable === 0) {
      note.textContent = "Add a Notify above and it will appear here too.";
    } else if (mirrored === mirrorable) {
      note.textContent = "Following your notify actions above.";
    } else if (mirrored === 0) {
      note.textContent = "Edited — no longer following your notify actions.";
    } else {
      note.textContent = mirrored + " of " + mirrorable + " still following your notify actions.";
    }
  }

  function mirroredResetActions(triggerActions, existing) {
    var notifies = (triggerActions || []).filter(function (a) { return a.type === "notify" && actionChannelIds(a).length; });
    var kept = (existing || []).filter(function (a) { return !a._mirrorOf; });
    var stillMirrored = notifies.map(function (a) {
      var clone = JSON.parse(JSON.stringify(a));
      // An escalation chases an UNHANDLED alert — meaningless on a recovery,
      // and the server rejects it (reset actions are plain, not escalatable).
      delete clone.escalation;
      // Keyed on the WHOLE channel list: two notify actions that share a
      // primary but differ in their second channel are different destinations,
      // and mirroring one onto the other would silently drop the difference.
      clone._mirrorOf = actionChannelIds(a).join(",");
      return clone;
    });
    // Operator-authored rows keep their place after the mirrored ones.
    return stillMirrored.concat(kept);
  }
  // Severity tiers + notify policy — collected only in multi-severity mode
  // (a single numeric metric). Single mode clears them.
  function collectBands(panel) {
    if (!multiSevOn(panel)) { draft.severityBands = null; draft.bandNotify = null; return; }
    var bandsHost = panel.querySelector("#aw-bands");
    if (!bandsHost) return; // section not rendered
    var baseOp = (draft.trigger && draft.trigger.operator) || ">=";
    var kind = (draft.trigger && draft.trigger.type === "host_metric") ? "host" : "asset";
    var bands = [];
    bandsHost.querySelectorAll(":scope > .aw-band").forEach(function (row) {
      // The tier's operator + threshold come from its (locked-metric) condition
      // row; metric + aggregation + window are shared with the base condition.
      var condRow = row.querySelector(".band-cond .scr-row");
      var leaf = condRow ? tgCollectLeaf(condRow, kind) : {};
      // Per-tier actions live on the Actions step (per-severity sections) and
      // ride the row stash between collects: hydrated at addBandRow, updated
      // by collectStep5 — so a step-3 re-collect can't strip them. Band-LEVEL
      // escalation isn't offered in the builder (per-action chains are), but
      // an API-authored one round-trips through the same stash.
      // No per-tier hold to read or write: the trigger's single "sustained for"
      // governs every tier, and a band that carries no `forDurationSec` inherits
      // it (resolveTierLadder). A rule authored with per-tier holds — by the API,
      // or by this builder before the change — LOSES them on the next save from
      // here, deliberately: the wizard shows one hold, so saving several would
      // leave the rule behaving in a way nothing on screen states.
      var band = {
        threshold: leaf.threshold != null && !isNaN(leaf.threshold) ? leaf.threshold : null,
        severity: row.querySelector(".band-severity").value,
        actions: row._bandActions || [],
      };
      if (row._bandEscalation) band.escalation = row._bandEscalation;
      // Persist a per-tier operator only when it differs from the base.
      if (leaf.operator && leaf.operator !== baseOp) band.operator = leaf.operator;
      bands.push(band);
    });
    draft.severityBands = bands.length ? bands : null;
    if (!bands.length) { draft.bandNotify = null; return; }
    // onResolved is written FALSE rather than omitted: the server defaults it to
    // true, so leaving it out would keep the duplicate recovery notification the
    // reset actions already send. The stored shape keeps the field (the engine
    // still honours it on rules this wizard hasn't touched).
    draft.bandNotify = {
      onIncrease: panel.querySelector("#aw-bn-increase").checked,
      onDecrease: panel.querySelector("#aw-bn-decrease").checked,
      onResolved: false,
    };
  }
  // A 0/1 state metric is excluded: severity bands are a threshold ladder, and a
  // flag has only two values (the server rejects them too — validateSeverityBands).
  function bandsApplicable(tr) {
    return !!tr && (tr.type === "asset_metric" || tr.type === "host_metric") && !isBooleanMetric(tr.metric);
  }
  /** The bands as saved: per-tier actions + per-tier escalation only when the
   *  Actions step's per-severity toggle is on. The draft keeps them either way
   *  so toggling back restores them within the session. */
  function payloadBands() {
    var bands = draft.severityBands || null;
    if (!bands || !bands.length) return null;
    if (bandActionsPerSeverityOn()) return bands;
    return bands.map(function (b) {
      var out = { threshold: b.threshold, severity: b.severity, forDurationSec: b.forDurationSec, actions: [] };
      if (b.operator) out.operator = b.operator;
      return out;
    });
  }
  function validateAction(a, label) {
    if (a.type === "notify") {
      var chs = actionChannels(a);
      if (!chs.length) return label + ": pick a channel.";
      // Recipients are shared across an action's channels, so the check is
      // asked once about the action and named after whichever channel needs
      // them — not repeated per channel with the same answer.
      var ch = chs.filter(function (x) { return isRouted(x.type); })[0];
      if (ch) {
        var hasTo = (a.recipientUserIds && a.recipientUserIds.length) || (a.addresses && a.addresses.length) ||
          (a.recipientRoles && a.recipientRoles.length);
        var hasRecip = hasTo || a.recipientDeviceRegion || a.recipientScopeRegion || a.recipientAssetContacts ||
          a.recipientAllUsers || a.recipientAllRegions || (a.recipientRegions && a.recipientRegions.length) ||
          (a.recipientTags && a.recipientTags.length);
        if (!hasRecip) return label + " (" + ch.name + "): choose at least one recipient.";
        // A Cc/Bcc-only action silently sends NOTHING: expandDeliveries skips a
        // target whose resolved To list is empty (Graph rejects an empty To).
        // Catch it here rather than let it look configured and never deliver.
        var comp = a.emailComposition;
        var hasCcBcc = !!(comp && ((comp.cc && (comp.cc.addresses || comp.cc.recipientUserIds)) ||
                                   (comp.bcc && (comp.bcc.addresses || comp.bcc.recipientUserIds))));
        if (hasCcBcc && !hasTo && !a.recipientDeviceRegion && !a.recipientScopeRegion && !a.recipientAssetContacts) {
          return label + " (" + ch.name + "): add a To recipient — a Cc/Bcc-only email is never sent.";
        }
      }
    } else if (a.type === "api_call") {
      if (!a.url) return label + ": enter the URL.";
      if (!/^https?:\/\//i.test(a.url)) return label + ": the URL must start with http:// or https://.";
    } else if (a.type === "script") {
      if (!a.scriptId) return label + ": pick a script.";
    }
    return null;
  }
  // Validate one escalation chain (the card's rule-level chain or an
  // action's own): tier delay + at least one valid action per tier.
  function validateEscalation(esc, label) {
    if (!esc) return null;
    var tiers = esc.tiers || [];
    for (var j = 0; j < tiers.length; j++) {
      var t = tiers[j]; var tn = j + 1;
      if (!t.afterMin || isNaN(t.afterMin) || t.afterMin < 1) return label + " escalation " + tn + ": enter the delay in minutes (1 or more).";
      if (!t.actions.length) return label + " escalation " + tn + ": add at least one action (or remove it).";
      for (var k = 0; k < t.actions.length; k++) {
        var p = validateAction(t.actions[k], label + " escalation " + tn + ", action " + (k + 1));
        if (p) return p;
      }
      if (t.repeatEveryMin != null && (isNaN(t.repeatEveryMin) || t.repeatEveryMin < 5)) return label + " escalation " + tn + ": repeat interval must be 5 minutes or more.";
    }
    return null;
  }
  function validateActionList(acts, prefix) {
    for (var i = 0; i < (acts || []).length; i++) {
      var label = prefix + " " + (i + 1);
      var p = validateAction(acts[i], label);
      if (p) return p;
      var p2 = validateEscalation(acts[i].escalation, label);
      if (p2) return p2;
    }
    return null;
  }
  function validateStep5() {
    var p = validateEscalation(draft.escalation, "Alert");
    if (p) return p;
    p = validateActionList(draft.actions, "Action");
    if (p) return p;
    // Per-tier actions are validated only while the toggle is on — off, they're
    // stripped from the payload, so a half-typed hidden row must not block save.
    if (bandActionsPerSeverityOn()) {
      for (var b = 0; b < (draft.severityBands || []).length; b++) {
        var band = draft.severityBands[b];
        p = validateActionList(band.actions, band.severity + " action");
        if (p) return p;
      }
    }
    // Quiet time: what the editor can't collect contributes NO window to the
    // draft, so a ticked checkbox over a half-typed day would save silently as
    // "no quiet time" — the operator would have to notice the reminders still
    // arriving overnight to find out. `quietEditorProblem` names the day, and
    // the overlapping pair of hours, in the same words the server would.
    var panel5 = document.getElementById("aw-step-5");
    var repeatOn = panel5 && panel5.querySelector("#aw-repeat-on");
    var quietOn = panel5 && panel5.querySelector("#aw-quiet-on");
    // Only while reminders are ON: with the repeat control unticked the whole
    // block is hidden and its windows are dropped on purpose, so a leftover
    // tick in the DOM must not block the save.
    if (repeatOn && repeatOn.checked && quietOn && quietOn.checked) {
      var quietProblem = quietEditorProblem(panel5);
      if (quietProblem) return quietProblem;
    }
    return null;
  }
  function condText(g) {
    var parts = (g.children || []).map(function (c) {
      if (c.op !== undefined && Array.isArray(c.children)) return "(" + condText(c) + ")";
      var fm = scFieldMeta(c.field);
      var opLbl = (scMeta.operatorLabels || {})[c.operator] || c.operator;
      return fm.label + " " + opLbl + " " + c.value;
    });
    if (g.op === "or") return parts.join(" OR ");
    if (g.op === "none") return "NOT(" + parts.join(" OR ") + ")";
    if (g.op === "notAll") return "NOT(" + parts.join(" AND ") + ")";
    return parts.join(" AND ");
  }
  function scopeSummaryText(sc) {
    sc = sc || {};
    if (sc.allAssets) return "All assets";
    if (sc.condition) return condText(sc.condition) || "(none)";
    var parts = [];
    if (sc.assetTypes && sc.assetTypes.length) parts.push("types: " + sc.assetTypes.join("/"));
    if (sc.tags && sc.tags.length) parts.push("tags: " + sc.tags.join("/"));
    if (sc.manufacturers && sc.manufacturers.length) parts.push("mfr: " + sc.manufacturers.join("/"));
    if (sc.models && sc.models.length) parts.push("model: " + sc.models.join("/"));
    if (sc.subnetCidrs && sc.subnetCidrs.length) parts.push("subnets: " + sc.subnetCidrs.join("/"));
    if (sc.assetIds && sc.assetIds.length) parts.push(sc.assetIds.length + " asset(s)");
    return parts.length ? parts.join("; ") : "(none)";
  }
  function renderSummary() {
    var box = document.getElementById("aw-summary");
    if (!box) return;
    // One line per action; per-action chains annotate their line. Band
    // sections contribute severity-prefixed lines.
    var escSuffix = function (a) {
      return a.escalation && a.escalation.tiers && a.escalation.tiers.length
        ? " (+" + a.escalation.tiers.length + " escalation tier" + (a.escalation.tiers.length === 1 ? "" : "s") + ")"
        : "";
    };
    var actionLines = (draft.actions || []).map(function (a) { return escapeHtml(actionSummary(a) + escSuffix(a)); });
    var perSevActions = bandActionsPerSeverityOn();
    if (perSevActions) {
      (draft.severityBands || []).forEach(function (b) {
        (b.actions || []).forEach(function (a) {
          actionLines.push('<span style="color:' + escapeHtml(sevColor(b.severity)) + '">at ' + escapeHtml(b.severity) + ':</span> ' + escapeHtml(actionSummary(a) + escSuffix(a)));
        });
      });
    }
    // Escalation = the alert's (rule-level) chain + every per-action chain.
    var chains = [];
    if (draft.escalation && draft.escalation.tiers && draft.escalation.tiers.length) chains.push(draft.escalation);
    (draft.actions || []).forEach(function (a) { if (a.escalation && a.escalation.tiers && a.escalation.tiers.length) chains.push(a.escalation); });
    if (perSevActions) {
      (draft.severityBands || []).forEach(function (b) {
        (b.actions || []).forEach(function (a) { if (a.escalation && a.escalation.tiers && a.escalation.tiers.length) chains.push(a.escalation); });
      });
    }
    var tierTotal = chains.reduce(function (n, c) { return n + c.tiers.length; }, 0);
    var escLine = chains.length ? chains.length + " chain(s), " + tierTotal + " tier(s)" : "off";
    var msgRow = draft.messageTemplate
      ? '<dt>Message</dt><dd><code style="font-size:0.8rem">' + escapeHtml(draft.messageTemplate) + '</code></dd>'
      : "";
    // Only when ON: a review grid that lists every default reads as noise, and
    // this one is off on every automation that predates the feature.
    var ackNoteRow = draft.requireAckNote
      ? '<dt>Acknowledging</dt><dd>requires a note</dd>'
      : "";
    // The quiet time is part of the REMINDER answer, not a row of its own:
    // "every 15 min" and "paused overnight" together are what the reader is
    // checking before they save.
    var quietWins = (draft.repeat && draft.repeat.quiet && draft.repeat.quiet.windows) || [];
    var repeatRow = draft.repeat
      ? '<dt>Reminders</dt><dd>every ' + escapeHtml(String(draft.repeat.everyMin)) + ' min until ' +
          (draft.repeat.stopOn === "clear" ? "cleared" : "acknowledged") +
          (draft.repeat.stopAfterHours ? ", giving up after " + escapeHtml(String(draft.repeat.stopAfterHours)) + "h" : " — no limit") +
          (quietWins.length
            ? '<br><span style="color:var(--color-text-tertiary)">held during ' +
                quietWins.map(function (w) { return escapeHtml(quietSummary(w)); }).join("; ") +
                ' (server time); the next reminder after that says how long the alert has been active</span>'
            : "") +
        '</dd>'
      : "";
    var resetRow = (draft.resetActions && draft.resetActions.length)
      ? '<dt>When it resets</dt><dd>' + draft.resetActions.map(function (a) { return escapeHtml(actionSummary(a)); }).join("<br>") + '</dd>'
      : '<dt>When it resets</dt><dd><span style="color:var(--color-text-tertiary)">nothing — the alert just clears</span></dd>';
    var bandsRow = "";
    if (bandsApplicable(draft.trigger) && draft.severityBands && draft.severityBands.length) {
      var op = (draft.trigger && draft.trigger.operator) || ">=";
      var baseDur = (draft.trigger && draft.trigger.forDurationSec) || 0;
      // Each tier states its own sustain — that's the whole point of per-band
      // durations, so the review line has to show them rather than one number.
      var sustainOf = function (sec) { return sec > 0 ? " for " + humanDuration(sec) : ""; };
      var bandLine = [escapeHtml(draft.severity + " " + op + " " + ((draft.trigger || {}).threshold != null ? draft.trigger.threshold : "?") + sustainOf(baseDur))]
        .concat(draft.severityBands.map(function (b) {
          return escapeHtml(b.severity + " " + (b.operator || op) + " " + b.threshold + sustainOf(b.forDurationSec != null ? b.forDurationSec : baseDur));
        })).join(", ");
      var np = draft.bandNotify || {};
      var notifyBits = [np.onIncrease !== false ? "increase" : null, np.onDecrease ? "decrease" : null, np.onResolved !== false ? "resolved" : null].filter(Boolean).join(" + ");
      bandsRow = '<dt>Severity bands</dt><dd>' + bandLine + ' <span style="color:var(--color-text-tertiary)">— notify on ' + escapeHtml(notifyBits || "none") +
        '; ' + (perSevActions ? "per-severity actions" : "same actions at every severity") + '</span></dd>';
    }
    box.innerHTML = '<dl class="review-grid">' +
      '<dt>Name</dt><dd>' + escapeHtml(draft.name || "…") + ' <span class="badge badge-level-' + escapeHtml(draft.severity || "warning") + '">' + escapeHtml((draft.severity || "warning").toUpperCase()) + '</span>' + (draft.enabled === false ? ' <span class="badge">disabled</span>' : "") + '</dd>' +
      '<dt>Devices</dt><dd>' + escapeHtml(scopeSummaryText(draft.scope)) + '</dd>' +
      '<dt>Trigger</dt><dd>' + triggerSentence(draft.trigger, draftLadder()) + '</dd>' +
      '<dt>Reset</dt><dd>' + resetSentence(draft.reset, draft.trigger) + '</dd>' +
      msgRow +
      ackNoteRow +
      repeatRow +
      '<dt>Actions</dt><dd>' + (actionLines.length ? actionLines.join("<br>") : '<span style="color:var(--color-text-tertiary)">in-app alert only</span>') + '</dd>' +
      resetRow +
      bandsRow +
      '<dt>Escalation</dt><dd>' + escapeHtml(escLine) + '</dd>' +
    '</dl>';
  }

  // ── Token palette wiring (per panel) ───────────────────────────────────
  var _tplFocus = null;
  function wireTokenPalette(panel) {
    panel.querySelectorAll(".tpl-field").forEach(function (el) {
      if (el._tplWired) return; el._tplWired = true;
      el.addEventListener("focus", function () { _tplFocus = el; });
    });
    panel.querySelectorAll(".tpl-token").forEach(function (chip) {
      if (chip._tplWired) return; chip._tplWired = true;
      chip.addEventListener("click", function () {
        var el = _tplFocus;
        if (!el) return;
        var tok = chip.getAttribute("data-token");
        if (typeof el.setRangeText === "function" && el.selectionStart != null) {
          el.setRangeText(tok, el.selectionStart, el.selectionEnd, "end");
        } else {
          el.value += tok;
        }
        el.focus();
      });
    });
  }

  // ── Navigation ─────────────────────────────────────────────────────────
  var COLLECT = { 1: collectStep1, 2: collectStep2, 3: collectStep3, 4: collectStep4, 5: collectStep5, 6: function () {} };
  var VALIDATE = { 1: validateStep1, 2: validateStep2, 3: validateStep3, 4: validateStep4, 5: validateStep5, 6: function () { return null; } };

  function updateStepper() {
    document.querySelectorAll("#aw-stepper .stepper-step").forEach(function (el) {
      var n = Number(el.getAttribute("data-step"));
      el.classList.toggle("active", n === step);
      el.classList.toggle("done", n < step);
      el.classList.toggle("clickable", n <= visited && n !== step);
    });
    document.querySelectorAll("#aw-stepper .stepper-line").forEach(function (el) {
      el.classList.toggle("done", Number(el.getAttribute("data-line")) < step);
    });
  }
  function syncFooter() {
    document.getElementById("aw-back").style.display = step > 1 ? "" : "none";
    document.getElementById("aw-next").style.display = step < STEPS.length ? "" : "none";
    // A clone opens with every step already visited, so it gets the edit-mode
    // affordance too: save from wherever the operator finished changing things.
    document.getElementById("aw-save").style.display = (step === STEPS.length || editing || cloning) ? "" : "none";
  }
  function goToStep(n, opts) {
    opts = opts || {};
    if (!opts.skipCollect) COLLECT[step]();
    if (opts.validate) {
      var problem = VALIDATE[step]();
      if (problem) { showToast(problem, "error"); return false; }
    }
    // Cancel in-flight preview timers when leaving their steps.
    if (step === 2 && scopePreviewTimer) { clearTimeout(scopePreviewTimer); scopePreviewTimer = null; }
    if (step === 3 && trigPreviewTimer) { clearTimeout(trigPreviewTimer); trigPreviewTimer = null; }
    document.getElementById("aw-step-" + step).classList.remove("visible");
    step = n;
    visited = Math.max(visited, n);
    // Steps 4–6 re-render on entry (they depend on earlier steps' state).
    if (n === 4) renderStep4();
    if (n === 5) renderStep5();
    if (n === 6) renderStep6();
    document.getElementById("aw-step-" + n).classList.add("visible");
    updateStepper();
    syncFooter();
    var mb = document.querySelector(".modal-body");
    if (mb) mb.scrollTop = 0;
    if (n === 2) scheduleScopePreview();
    return true;
  }

  document.getElementById("aw-next").addEventListener("click", function () { goToStep(step + 1, { validate: true }); });
  document.getElementById("aw-back").addEventListener("click", function () { goToStep(step - 1); });
  document.querySelectorAll("#aw-stepper .stepper-step").forEach(function (el) {
    el.addEventListener("click", function () {
      var n = Number(el.getAttribute("data-step"));
      if (n <= visited && n !== step) goToStep(n);
    });
  });
  document.getElementById("aw-cancel").addEventListener("click", function () {
    COLLECT[step]();
    // Clones are excluded from the stash: it exists to protect work typed from
    // scratch, and a clone is one click away from being recreated — offering to
    // restore one when the operator next opens "New automation" would only
    // confuse.
    if (!editing && !cloning && (draft.name || (draft.actions || []).length)) _awDraftStash = draft; // in-memory only
    closeModal();
  });

  /**
   * The wire shape, derived purely from `draft` — no DOM reads, so export and
   * the code viewer can call it from any step (goToStep has already collected
   * every step the operator passed through). Extracted from the save handler so
   * save / export / view-code cannot drift apart.
   *
   * `nameFallback` exists for the test-delivery caller, whose draft may not be
   * named yet.
   */
  function buildPayload(o) {
    return {
      name: draft.name || ((o && o.nameFallback) || ""),
      description: draft.description,
      enabled: draft.enabled,
      severity: draft.severity,
      trigger: draft.trigger,
      scope: isTriggerScoped(draft.trigger) ? draft.scope : {},
      reset: draft.reset,
      actions: draft.actions,
      // Always null: the control is gone and clearNotificationCooldowns has
      // emptied the column. Sent explicitly rather than omitted so a rule
      // edited through the wizard clears a value an API caller re-set.
      cooldownSec: null,
      messageTemplate: draft.messageTemplate,
      requireAckNote: draft.requireAckNote === true,
      channels: ["in_app"],
      emailComposition: null, // per-action composition in v2; rule-level field retired by the wizard
      escalation: draft.escalation,
      // Per-tier actions ride the bands only when the Actions step's
      // "different actions for each severity level" toggle is on; off, every
      // band saves bare and the server runs the base actions at every severity.
      severityBands: bandsApplicable(draft.trigger) ? payloadBands() : null,
      bandNotify: bandsApplicable(draft.trigger) && draft.severityBands && draft.severityBands.length ? (draft.bandNotify || null) : null,
      // Reset actions: the wizard's mirror markers are wizard-only, and the
      // server schema is strict.
      resetActions: draft.resetActions && draft.resetActions.length ? stripMirrorMarks(draft.resetActions) : null,
      repeat: draft.repeat || null,
    };
  }

  /**
   * Validate every step, then POST or PUT. Returns true on success. The
   * validate-all loop lives HERE rather than in buildPayload, because export and
   * the code viewer must work on an incomplete draft.
   */
  async function saveAutomation(btn) {
    COLLECT[step]();
    // Validate every step; jump to the first failing one.
    for (var i = 1; i <= STEPS.length; i++) {
      var problem = VALIDATE[i]();
      if (problem) {
        if (i !== step) goToStep(i, { skipCollect: true });
        showToast(problem, "error");
        return false;
      }
    }
    var payload = buildPayload();
    if (btn) btn.disabled = true;
    try {
      if (editing) await api.automations.update(editing.id, payload);
      else await api.automations.create(payload);
      _awDraftStash = null;
      closeModal();
      showToast(editing ? "Automation saved"
        : importing ? "Automation imported — it starts disabled, enable it when you're ready"
        : cloning ? "Automation cloned — it starts disabled, enable it when you're ready"
        : "Automation created", "success");
      if (window._reloadRules) window._reloadRules();
      return true;
    } catch (err) {
      if (btn) btn.disabled = false;
      showToast(err.message || "Save failed", "error");
      return false;
    }
  }

  document.getElementById("aw-save").addEventListener("click", function () {
    saveAutomation(this);
  });

  // ── First render ───────────────────────────────────────────────────────
  // (Severity moved off step 1 onto the trigger step — wired in wireStep3.)
  wireStep1();
  wireStep2();
  wireStep3();
  updateStepper();
  syncFooter();
}

/** Rule record (API row, rule-shape v2 via the server's withV2 read) → wizard
 *  draft. `withV2` fills reset/actions but not escalation, so the chain rides
 *  through normalizeEscalationV2 — shared with the list's Addresses column,
 *  which has to read the same stored shapes. */
function _awDraftFromRule(r) {
  var esc = normalizeEscalationV2(r.escalation || null);
  return {
    name: r.name || "",
    description: r.description != null ? r.description : null,
    enabled: r.enabled !== false,
    severity: r.severity || "warning",
    trigger: JSON.parse(JSON.stringify(r.trigger || { type: "asset_metric" })),
    scope: JSON.parse(JSON.stringify(r.scope || {})),
    reset: r.reset ? JSON.parse(JSON.stringify(r.reset)) : null,
    // Re-notify cooldown was retired from the builder in 2026-08 and cleared
    // fleet-wide by the clearNotificationCooldowns one-shot. The column and
    // the engine check survive (dormant — the failureThreshold precedent), so
    // an API caller can still set one; the wizard just never reads it back,
    // which is what stops a value nothing on screen states from surviving an
    // edit.
    cooldownSec: null,
    messageTemplate: r.messageTemplate != null ? r.messageTemplate : null,
    requireAckNote: r.requireAckNote === true,
    actions: JSON.parse(JSON.stringify(Array.isArray(r.actions) ? r.actions : [])),
    escalation: esc ? JSON.parse(JSON.stringify(esc)) : null,
    severityBands: Array.isArray(r.severityBands) && r.severityBands.length ? JSON.parse(JSON.stringify(r.severityBands)) : null,
    bandNotify: r.bandNotify ? JSON.parse(JSON.stringify(r.bandNotify)) : null,
    // undefined (never set) vs null (deliberately off) matters: a NEW draft
    // seeds its reset list from the trigger, a stored rule shows what it saved.
    resetActions: Array.isArray(r.resetActions) && r.resetActions.length ? JSON.parse(JSON.stringify(r.resetActions)) : null,
    repeat: r.repeat ? JSON.parse(JSON.stringify(r.repeat)) : null,
    // Per-severity actions are opt-in on the Actions step; a stored rule opts in
    // iff any band actually carries its own actions/escalation.
    bandActionsPerSeverity: (Array.isArray(r.severityBands) ? r.severityBands : []).some(function (b) {
      return (b && b.actions && b.actions.length) || (b && b.escalation && b.escalation.tiers && b.escalation.tiers.length);
    }),
  };
}
