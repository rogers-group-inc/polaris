/* global escapeHtml, showConfirm, buildOverlay */
/**
 * public/js/automations-portability.js — export / import one automation as a
 * portable JSON file, plus the "view code" editor.
 *
 * Exposed as `window.PolarisAutomationPortability`. Loaded on every page that
 * loads automations-wizard.js (five of them), because the wizard's Summary step
 * calls into it; the Automations list row menu uses it too.
 *
 * ── Two serializations, deliberately different ───────────────────────────────
 *
 *   stripForExport()  → PORTABLE. Every install-specific reference is removed
 *                       and recorded as a NAMED dependency instead. Carries no
 *                       ids and no secrets, so the file is safe to email, commit
 *                       or paste into a ticket.
 *   forCodeView()     → FULL FIDELITY. Ids intact, api_call headers included,
 *                       because an edit there must round-trip losslessly onto
 *                       the same automation. The modal says so.
 *
 * The stripped `rule` is exactly a `ruleInputSchema` body, so **every export
 * must be a valid import** — that property is the headline unit test.
 *
 * ── Three traps this module exists to avoid ──────────────────────────────────
 *
 * (A) `actions` is emitted EXPLICITLY as [{type:"event"}], never omitted. The
 *     server's withEventAction() re-injects the audit Event only when `actions`
 *     is undefined, and that never happens on the import path: the file goes
 *     through the wizard draft, and _awDraftFromRule coerces an absent list to
 *     [] which is then sent explicitly. Omitting would save a rule with ZERO
 *     actions — still writing a Notification row, so it looks like it fired,
 *     while logging nothing.
 *
 * (B) An empty `scope` ({}) is NOT "all assets" — the engine's scopeWhere
 *     returns null for it, which loads zero assets. Worse, step2Html renders it
 *     with "All assets" CHECKED and validateStep2 calls it valid, while step 6
 *     summarises it as "(none)". So a strip that empties the scope must instead
 *     emit an empty CONDITION TREE, which validateStep2 refuses outright and
 *     which therefore forces the operator to re-pick. Note {} and
 *     {condition:{op:"and",children:[]}} are OPPOSITES server-side.
 *
 * (C) dimensionFilter.stateProbeId / .widgetId are OPTIONAL, and the engine
 *     applies them only when present — so blanking one WIDENS the trigger from
 *     "this PSU alarm probe" to "every state probe on the device". They are
 *     therefore recorded as dependencies AND reported back so the wizard can
 *     block the save until the operator re-picks.
 *
 * The same widening applies to condition-tree pruning: an emptied AND group is
 * true for every asset, so a group left with no children is REMOVED from its
 * parent rather than kept.
 */
(function () {
  "use strict";

  var FORMAT_VERSION = 1;
  var FILE_SUFFIX = ".automation.json";
  // A rule is a few KB. 256 KB matches the deviceIcons upload precedent and is
  // checked before the file is read at all.
  var MAX_IMPORT_BYTES = 256 * 1024;
  // The rule's own nesting caps are 5 (scope) and 3 (trigger); this only bounds
  // the recursive walks below so a hostile file can't spend our stack.
  var MAX_DEPTH = 20;
  var MAX_NAME_LEN = 200; // matches name: z.string().min(1).max(200)

  // ── Small helpers ──────────────────────────────────────────────────────────

  function clone(v) {
    return v == null ? v : JSON.parse(JSON.stringify(v));
  }

  function isPlainObject(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  /** Keys that must never reach a client-side object spread. JSON.parse itself
   *  is safe (it creates an own property), but the parsed object is copied into
   *  the wizard draft, which is where pollution would bite. */
  function assertSafeKeys(value, depth) {
    if (depth > MAX_DEPTH) throw new Error("This file nests too deeply to be an automation.");
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) assertSafeKeys(value[i], depth + 1);
      return;
    }
    if (!isPlainObject(value)) return;
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new Error('This file contains a "' + key + '" key, which is not allowed.');
      }
      assertSafeKeys(value[key], depth + 1);
    }
  }

  // ── Filenames ──────────────────────────────────────────────────────────────

  /**
   * The filename IS the automation's name. Strip anything that would make it a
   * path or an invisible mess. Note the name is already rendered through
   * escapeHtml on every surface, so a hostile filename is an untidy name rather
   * than an injection — this scrub is for legibility and the length cap.
   */
  function nameFromFilename(filename) {
    var raw = String(filename == null ? "" : filename);
    // Take the last path segment, whatever separator was used.
    var parts = raw.split(/[\\/]/);
    var base = parts[parts.length - 1] || "";
    // Drop the extension: our own double extension first, then any single one.
    if (/\.automation\.json$/i.test(base)) base = base.slice(0, -FILE_SUFFIX.length);
    else base = base.replace(/\.[^.]*$/, "");
    // Control characters (incl. NUL) are invisible; collapse all whitespace.
    base = base.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    // ".." / "." would have survived the steps above as a literal name.
    if (base === "." || base === "..") base = "";
    if (base.length > MAX_NAME_LEN) base = base.slice(0, MAX_NAME_LEN).trim();
    return base;
  }

  /** "Switch temp high" → "Switch temp high.automation.json" */
  function filenameForExport(name) {
    var base = String(name == null ? "" : name)
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/[\\/:*?"<>|]/g, "-") // illegal on Windows, and path-ish everywhere
      .replace(/\s+/g, " ")
      .trim();
    if (base.length > 120) base = base.slice(0, 120).trim();
    if (!base) base = "automation";
    return base + FILE_SUFFIX;
  }

  // ── Dependency collection ──────────────────────────────────────────────────

  /**
   * A dependency is something this automation needs that a DEFAULT Polaris
   * install would not have: a delivery channel, a registry script, a state
   * probe, a custom role, a map region, a contact, a pinned device. Things every
   * install has — severities, built-in metrics, the five built-in roles — are
   * deliberately not listed, or the block would be noise.
   */
  function makeDeps() {
    var list = [];
    var seen = Object.create(null);
    return {
      add: function (kind, name, usedFor, unresolved) {
        if (name == null || name === "") return;
        // One entry per (kind, name); accumulate the usedFor sites so a channel
        // referenced by three actions reads as one dependency.
        var key = kind + "\u0000" + name;
        if (seen[key]) {
          if (usedFor && seen[key].usedFor.indexOf(usedFor) === -1) seen[key].usedFor.push(usedFor);
          return;
        }
        var entry = { kind: kind, name: String(name), usedFor: usedFor ? [usedFor] : [], unresolved: !!unresolved };
        seen[key] = entry;
        list.push(entry);
      },
      list: function () {
        return list.map(function (e) {
          var out = { kind: e.kind, name: e.name };
          if (e.usedFor.length) out.usedFor = e.usedFor.join(", ");
          if (e.unresolved) out.unresolved = true;
          return out;
        });
      },
    };
  }

  /** Look an id up in a catalog, falling back to the id itself so an
   *  unresolvable reference is still visible rather than silently dropped. */
  function nameOf(catalog, id, labelKeys) {
    if (!id) return null;
    var rows = catalog || [];
    var keys = labelKeys || ["name"];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].id === id) {
        for (var k = 0; k < keys.length; k++) {
          if (rows[i][keys[k]]) return { name: String(rows[i][keys[k]]), unresolved: false };
        }
        return { name: String(id), unresolved: true };
      }
    }
    return { name: String(id), unresolved: true };
  }

  /** Assets have no in-wizard catalogue, so a pinned id usually cannot be
   *  resolved to a hostname. Label it as an id rather than passing a raw UUID
   *  off as a device name — the point of the block is that a human can read it. */
  function assetLabel(cat, id) {
    var hit = nameOf(cat.assets, id, ["hostname", "name"]);
    if (hit && !hit.unresolved) return { name: hit.name, unresolved: false };
    return { name: "device id " + String(id), unresolved: true };
  }

  function recordEmailBox(box, label, cat, deps) {
    if (!isPlainObject(box)) return;
    (box.recipientUserIds || []).forEach(function (uid) {
      var u = nameOf(cat.users, uid, ["username", "name", "email"]);
      if (u) deps.add("user", u.name, label, u.unresolved);
    });
    (box.recipientRoles || []).forEach(function (rid) {
      var r = nameOf(cat.roles, rid);
      if (r) deps.add("role", r.name, label, r.unresolved);
    });
    (box.recipientRegions || []).forEach(function (rn) { deps.add("region", rn, label); });
    // Deliberately a COUNT, not the addresses — see the note above makeDeps.
    if ((box.addresses || []).length) {
      deps.add("emailAddress", box.addresses.length + " typed email address" + (box.addresses.length === 1 ? "" : "es"), label);
    }
  }

  function recordNotifyDeps(action, label, cat, deps) {
    // Every channel the action delivers through — `channelIds` when the action
    // is multi-channel, its primary otherwise. An import that resolved only
    // the primary would report an automation as fully wired while a second
    // channel it needs is missing on the target install.
    var chIds = (action.channelIds && action.channelIds.length)
      ? action.channelIds
      : (action.channelId ? [action.channelId] : []);
    chIds.forEach(function (id) {
      var ch = nameOf(cat.channels, id);
      if (ch) deps.add("deliveryChannel", ch.name, label, ch.unresolved);
    });
    recordEmailBox(action, label + " recipients", cat, deps);
    (action.recipientTags || []).forEach(function (t) {
      deps.add("tag", t, label + " recipients");
    });
    if (action.recipientAssetContacts) {
      deps.add("addressBook", "contacts responsible for the triggering device", label + " recipients");
    }
    var ec = action.emailComposition;
    if (ec) {
      recordEmailBox(ec.cc, label + " cc", cat, deps);
      recordEmailBox(ec.bcc, label + " bcc", cat, deps);
    }
  }

  function recordActionDeps(action, label, cat, deps) {
    if (!isPlainObject(action)) return;
    if (action.type === "notify") recordNotifyDeps(action, label, cat, deps);
    else if (action.type === "script") {
      var s = nameOf(cat.scripts, action.scriptId);
      if (s) deps.add("script", s.name, label, s.unresolved);
    } else if (action.type === "api_call") {
      var host = action.url;
      try { host = new URL(action.url).host; } catch (_e) { /* keep the raw string */ }
      deps.add("apiEndpoint", host, label);
    }
  }

  /** Walk an escalation chain (legacy email tiers OR v2 tiers-of-actions). */
  function recordEscalationDeps(esc, label, cat, deps) {
    if (!isPlainObject(esc) || !Array.isArray(esc.tiers)) return;
    esc.tiers.forEach(function (tier, ti) {
      if (!isPlainObject(tier)) return;
      var tl = label + " escalation tier " + (ti + 1);
      if (Array.isArray(tier.actions)) {
        tier.actions.forEach(function (a, ai) { recordActionDeps(a, tl + " action " + (ai + 1), cat, deps); });
      } else if (tier.channelId) {
        // Legacy email tier — it IS a notify in all but shape.
        recordNotifyDeps(tier, tl, cat, deps);
      }
    });
  }

  // ── Strip ──────────────────────────────────────────────────────────────────

  /** Keep only the reference-free `event` action, and drop its escalation
   *  (a chain's tiers require >= 1 action, so a chain cannot be emptied — it
   *  must be deleted whole). */
  function portableActions(actions, label, cat, deps) {
    var kept = [];
    (Array.isArray(actions) ? actions : []).forEach(function (a, i) {
      var l = label + " " + (i + 1);
      if (isPlainObject(a) && a.type === "event") {
        kept.push({ type: "event" });
        if (a.escalation) recordEscalationDeps(a.escalation, l, cat, deps);
        return;
      }
      recordActionDeps(a, l, cat, deps);
      if (a && a.escalation) recordEscalationDeps(a.escalation, l, cat, deps);
    });
    return kept;
  }

  /**
   * The top-level action list must always carry the audit Event. An automation
   * whose every action was delivery wiring strips to an empty list, and an empty
   * list saves a rule that writes a Notification row (so it looks like it fired)
   * while logging nothing — the server only re-injects the Event for an
   * `undefined` actions field, which the wizard draft never produces.
   */
  function withAuditEvent(actions) {
    var has = actions.some(function (a) { return a && a.type === "event"; });
    return has ? actions : [{ type: "event" }].concat(actions);
  }

  /**
   * Prune assetId leaves from a condition tree. An emptied group is REMOVED
   * from its parent rather than left in place: an empty AND group is true for
   * every asset, so keeping it would widen the scope — the same class of bug as
   * (C) above. Returns null when nothing is left.
   */
  function pruneCondition(group, cat, deps) {
    if (!isPlainObject(group) || !Array.isArray(group.children)) return null;
    var kept = [];
    group.children.forEach(function (child) {
      if (!isPlainObject(child)) return;
      if (Array.isArray(child.children)) {
        var sub = pruneCondition(child, cat, deps);
        if (sub) kept.push(sub);
        return;
      }
      if (child.field === "assetId") {
        var al = assetLabel(cat, child.value);
        deps.add("asset", al.name, "device filter", al.unresolved);
        return;
      }
      // Record the value-based dimensions worth naming as dependencies.
      if (child.field === "tag") deps.add("tag", child.value, "device filter");
      else if (child.field === "subnet") deps.add("subnet", child.value, "device filter");
      else if (child.field === "assetType") deps.add("assetType", child.value, "device filter");
      kept.push(clone(child));
    });
    if (!kept.length) return null;
    return { op: group.op, children: kept };
  }

  /** Scope: keep the value-based dimensions, drop the id-based ones. Never
   *  return a bare {} — see (B). `needsDevices` tells the caller the operator
   *  must re-pick. */
  function portableScope(scope, cat, deps) {
    var src = isPlainObject(scope) ? scope : {};
    var out = {};
    if (src.allAssets === true) out.allAssets = true;
    ["assetTypes", "tags", "manufacturers", "models", "subnetCidrs"].forEach(function (k) {
      if (Array.isArray(src[k]) && src[k].length) out[k] = clone(src[k]);
    });
    (src.assetIds || []).forEach(function (id) {
      var al = assetLabel(cat, id);
      deps.add("asset", al.name, "device filter (pinned)", al.unresolved);
    });
    (src.integrationIds || []).forEach(function (id) { deps.add("integration", id, "device filter", true); });
    (out.tags || []).forEach(function (t) { deps.add("tag", t, "device filter"); });
    (out.subnetCidrs || []).forEach(function (c) { deps.add("subnet", c, "device filter"); });
    (out.assetTypes || []).forEach(function (t) { deps.add("assetType", t, "device filter"); });

    if (src.condition) {
      var pruned = pruneCondition(src.condition, cat, deps);
      if (pruned) out.condition = pruned;
    }

    if (!Object.keys(out).length) {
      // (B): {} means MATCH NOTHING but renders as "All assets" checked. Emit an
      // empty condition tree instead — validateStep2 refuses that outright, so
      // the operator is forced to choose rather than saving something dead.
      return { scope: { condition: { op: "and", children: [] } }, needsDevices: true };
    }
    return { scope: out, needsDevices: false };
  }

  var DIMENSION_ID_FIELDS = ["stateProbeId", "widgetId", "checkId"];

  /** Blank the two id-valued dimension filters, recording each as a dependency.
   *  Collects which dimensions were blanked so the caller can mark the trigger
   *  incomplete — see (C). */
  function scrubDimensionFilter(df, cat, deps, blanked) {
    if (!isPlainObject(df)) return;
    DIMENSION_ID_FIELDS.forEach(function (field) {
      if (!df[field]) return;
      if (field === "stateProbeId") {
        var p = nameOf(cat.stateProbes, df[field]);
        deps.add("stateProbe", p ? p.name : df[field], "trigger dimension", p ? p.unresolved : true);
      } else if (field === "checkId") {
        // A path check id is install-specific. Blanked (not kept): a
        // blank checkId watches EVERY check on the host, so the import marks
        // the trigger incomplete rather than silently widening it.
        var ck = nameOf(cat.pathChecks, df[field]);
        deps.add("pathCheck", ck ? ck.name : df[field], "trigger dimension", ck ? ck.unresolved : true);
      } else {
        deps.add("customWidget", df[field], "trigger dimension", true);
      }
      delete df[field];
      if (blanked.indexOf(field) === -1) blanked.push(field);
    });
  }

  /** Walk a trigger (or a composite child, or a reset-condition node) and scrub
   *  every dimensionFilter it carries. All three shapes nest via `children`. */
  function scrubTriggerTree(node, cat, deps, blanked) {
    if (!isPlainObject(node)) return node;
    if (node.dimensionFilter) scrubDimensionFilter(node.dimensionFilter, cat, deps, blanked);
    if (Array.isArray(node.children)) {
      node.children.forEach(function (c) { scrubTriggerTree(c, cat, deps, blanked); });
    }
    return node;
  }

  /**
   * Full rule body → { rule, dependencies, needsDevices, blankedDimensions }.
   * `rule` is a valid ruleInputSchema body carrying no install-specific ids.
   */
  function stripForExport(body, catalogs) {
    var src = isPlainObject(body) ? clone(body) : {};
    var cat = catalogs || {};
    var deps = makeDeps();
    var blanked = [];

    var scoped = portableScope(src.scope, cat, deps);

    var out = {
      name: src.name || "",
      description: src.description == null ? null : src.description,
      severity: src.severity || "warning",
      trigger: scrubTriggerTree(clone(src.trigger), cat, deps, blanked),
      scope: scoped.scope,
      reset: src.reset ? clone(src.reset) : null,
      // Always null. Re-notify cooldown was retired from the builder in
      // 2026-08 and cleared fleet-wide by clearNotificationCooldowns, so a
      // fresh export has none to carry — and this same function is what
      // parseImportFile re-strips an INCOMING file through, which is the half
      // that matters: a pre-cutover .automation.json would otherwise import a
      // suppression no screen can show and no control can edit, reopening on
      // one install exactly what the migration closed on every other.
      cooldownSec: null,
      messageTemplate: src.messageTemplate == null ? null : src.messageTemplate,
      requireAckNote: src.requireAckNote === true,
      // (A) ALWAYS explicit, and never empty — see withAuditEvent.
      actions: withAuditEvent(portableActions(src.actions, "Action", cat, deps)),
    };
    if (out.reset && out.reset.condition) scrubTriggerTree(out.reset.condition, cat, deps, blanked);

    // Bands keep their thresholds (the interesting part) but lose their actions.
    // severityBandSchema.actions is .default([]), so an empty list is valid.
    if (Array.isArray(src.severityBands) && src.severityBands.length) {
      out.severityBands = src.severityBands.map(function (b, i) {
        var label = (b && b.severity ? b.severity : "band " + (i + 1)) + " band";
        var band = {
          threshold: b.threshold,
          severity: b.severity,
          actions: portableActions(b.actions, label + " action", cat, deps),
        };
        if (b.operator) band.operator = b.operator;
        if (b.forDurationSec != null) band.forDurationSec = b.forDurationSec;
        if (b.escalation) recordEscalationDeps(b.escalation, label, cat, deps);
        return band;
      });
    }

    if (isPlainObject(src.bandNotify)) {
      var bn = {};
      ["onIncrease", "onDecrease", "onResolved"].forEach(function (k) {
        if (typeof src.bandNotify[k] === "boolean") bn[k] = src.bandNotify[k];
      });
      if (src.bandNotify.resolvedMode) bn.resolvedMode = src.bandNotify.resolvedMode;
      if (src.bandNotify.resolvedActions) {
        portableActions(src.bandNotify.resolvedActions, "Resolved action", cat, deps);
      }
      if (Object.keys(bn).length) out.bandNotify = bn;
    }

    if (Array.isArray(src.resetActions) && src.resetActions.length) {
      var ra = portableActions(src.resetActions, "Reset action", cat, deps);
      if (ra.length) out.resetActions = ra;
    }

    // Rule-level escalation and emailComposition are pure delivery wiring.
    if (src.escalation) recordEscalationDeps(src.escalation, "Automation", cat, deps);
    if (src.emailComposition) {
      recordEmailBox(src.emailComposition.cc, "Email composition cc", cat, deps);
      recordEmailBox(src.emailComposition.bcc, "Email composition bcc", cat, deps);
    }

    return {
      rule: out,
      dependencies: deps.list(),
      needsDevices: scoped.needsDevices,
      blankedDimensions: blanked,
    };
  }

  /** The whole file: dependencies first, because that is what a human opening
   *  the file wants to see. The nested schemas are .strict(), so a hint cannot
   *  live next to the thing it describes — the envelope is the only place. */
  function buildExportFile(body, catalogs, meta) {
    var stripped = stripForExport(body, catalogs);
    var file = {
      polarisAutomation: FORMAT_VERSION,
      exportedAt: (meta && meta.exportedAt) || new Date().toISOString(),
    };
    if (meta && meta.polarisVersion) file.polarisVersion = meta.polarisVersion;
    file.dependencies = stripped.dependencies;
    if (stripped.needsDevices) file.needsDeviceSelection = true;
    if (stripped.blankedDimensions.length) file.needsTriggerDimension = stripped.blankedDimensions;
    file.rule = stripped.rule;
    return file;
  }

  // ── Import ─────────────────────────────────────────────────────────────────

  /**
   * Parse and vet a picked file. Throws Error with an operator-facing message;
   * the server remains the authority (ruleInputSchema + assertActionRefs on
   * save) — this only catches what would otherwise be a confusing wizard state.
   *
   * `triggerTypes` is the list from /automations/schema, so an unknown
   * trigger.type is refused here rather than throwing mid-render.
   */
  function parseImportFile(text, filename, triggerTypes) {
    if (typeof text !== "string" || !text.trim()) throw new Error("That file is empty.");
    if (text.length > MAX_IMPORT_BYTES) throw new Error("That file is too large to be an automation.");

    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error("Invalid JSON: " + ((err && err.message) || "could not be parsed"));
    }
    assertSafeKeys(parsed, 0);
    if (!isPlainObject(parsed)) throw new Error("An automation file must contain a JSON object.");

    var problems = [];
    var envelopeVersion = parsed.polarisAutomation;
    // Accept a bare rule body too — someone may have pasted one out of View code.
    var rule = isPlainObject(parsed.rule) ? parsed.rule : parsed;
    if (envelopeVersion != null && envelopeVersion !== FORMAT_VERSION) {
      problems.push(
        "This file says format version " + String(envelopeVersion) + "; this Polaris understands version " +
        FORMAT_VERSION + ". Check the automation carefully before saving.",
      );
    }

    if (!isPlainObject(rule.trigger) || !rule.trigger.type) {
      throw new Error("That file has no trigger, so it isn't an automation.");
    }
    if (Array.isArray(triggerTypes) && triggerTypes.length && triggerTypes.indexOf(rule.trigger.type) === -1) {
      throw new Error('This file uses an unknown trigger type ("' + String(rule.trigger.type) + '").');
    }
    if (rule.actions != null && !Array.isArray(rule.actions)) {
      throw new Error("That file's actions are not a list.");
    }

    var name = nameFromFilename(filename);
    if (!name) throw new Error("Rename the file — its name becomes the automation's name.");

    // Re-strip on the way IN as well. The file may have been hand-written, or
    // exported by a future version that carried a reference we must not adopt;
    // re-running the strip makes "an import never carries a foreign id" a
    // property of the code rather than a promise about the file.
    var restripped = stripForExport(rule, {});
    restripped.rule.name = name;

    var deps = Array.isArray(parsed.dependencies) ? parsed.dependencies : restripped.dependencies;

    return {
      rule: restripped.rule,
      dependencies: deps,
      name: name,
      needsDevices: restripped.needsDevices || parsed.needsDeviceSelection === true,
      blankedDimensions: restripped.blankedDimensions.length
        ? restripped.blankedDimensions
        : (Array.isArray(parsed.needsTriggerDimension) ? parsed.needsTriggerDimension : []),
      problems: problems,
    };
  }

  /** Which of a file's dependencies this install can already satisfy. Pure
   *  lookups against catalogs the wizard already holds — no network. */
  function checkDependencies(dependencies, catalogs) {
    var cat = catalogs || {};
    var byKind = {
      deliveryChannel: cat.channels,
      script: cat.scripts,
      user: cat.users,
      role: cat.roles,
      stateProbe: cat.stateProbes,
      pathCheck: cat.pathChecks,
    };
    var labelKeys = { user: ["username", "name", "email"] };
    function nameMatches(rows, value, keys) {
      return (rows || []).some(function (r) {
        if (r == null) return false;
        if (typeof r === "string") return r.toLowerCase() === String(value).toLowerCase();
        for (var i = 0; i < keys.length; i++) {
          if (r[keys[i]] && String(r[keys[i]]).toLowerCase() === String(value).toLowerCase()) return true;
        }
        return false;
      });
    }
    return (dependencies || []).map(function (d) {
      var out = { kind: d.kind, name: d.name, usedFor: d.usedFor, present: null };
      if (d.kind === "region") { out.present = nameMatches(cat.regions, d.name, ["name"]); return out; }
      if (d.kind === "tag") { out.present = nameMatches(cat.tags, d.name, ["name"]); return out; }
      if (d.kind === "assetType") { out.present = nameMatches(cat.assetTypes, d.name, ["name"]); return out; }
      var rows = byKind[d.kind];
      // No catalogue to check against (asset, subnet, integration, address, …) —
      // `present: null` renders as "can't tell", never as a false "missing".
      if (!rows) return out;
      out.present = nameMatches(rows, d.name, labelKeys[d.kind] || ["name"]);
      return out;
    });
  }

  // ── The legacy mirror, which must never reach the code editor ──────────────

  /**
   * `withV2` spreads the whole DB row, so a list row carries the legacy mirror
   * columns — and they are LIVE schema fields. Delete `actions` in the editor
   * while leaving `targets` and normalizeRuleInputCore rebuilds actions from the
   * mirror, dropping per-action escalation, script and api_call actions: a lossy
   * resurrection that looks like it worked. So they are stripped from what we
   * display, along with the server-owned and list-render-only columns.
   */
  var NON_EDITABLE_KEYS = [
    "targets", "clearBehavior", "clearAfterSec", // legacy mirror — see above
    "id", "createdAt", "updatedAt", "createdBy", // server-owned
    "devicesSummary", "triggerSummary", "resetSummary", "actionsSummary", "triggerType", // list-render extras
  ];

  function forCodeView(body) {
    var out = clone(isPlainObject(body) ? body : {});
    NON_EDITABLE_KEYS.forEach(function (k) { delete out[k]; });
    return out;
  }

  /** Fields whose ABSENCE from an edited body is destructive rather than
   *  neutral — the diff the code modal must confirm. */
  var DIFF_KEYS = [
    "enabled", "severity", "scope", "actions", "reset", "trigger",
    "escalation", "severityBands", "bandNotify", "resetActions", "emailComposition",
  ];

  function describeValue(v) {
    if (v === undefined) return "(removed)";
    if (v === null) return "(none)";
    if (Array.isArray(v)) return v.length + " item" + (v.length === 1 ? "" : "s");
    if (typeof v === "object") return "(set)";
    return String(v);
  }

  /** What changed between the loaded body and the edited one, for the confirm.
   *  `alarming` flags the changes that are dangerous rather than merely
   *  different: taking a disabled automation live, and emptying the device
   *  filter or the action list. */
  function diffForConfirm(before, after) {
    var out = [];
    DIFF_KEYS.forEach(function (k) {
      var a = isPlainObject(before) ? before[k] : undefined;
      var b = isPlainObject(after) ? after[k] : undefined;
      if (JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b)) return;
      var alarming = false;
      if (k === "enabled" && a === false && b !== false) alarming = true;
      if (k === "actions" && Array.isArray(a) && a.length && (b === undefined || (Array.isArray(b) && !b.length))) alarming = true;
      if (k === "scope" && b === undefined) alarming = true;
      var fromS = describeValue(a);
      var toS = describeValue(b);
      out.push({ key: k, from: fromS, to: toS, changed: fromS === toS, alarming: alarming });
    });
    return out;
  }


  // ── The code editor ───────────────────────────────────────────────────────

  function diffRowsHtml(diff) {
    if (!diff.length) return '<p style="font-size:0.85rem;color:var(--color-text-tertiary);margin:0">Nothing changed.</p>';
    return '<ul style="margin:0;padding-left:1.1rem;font-size:0.85rem;line-height:1.6">' +
      diff.map(function (d) {
        var body = '<code>' + escapeHtml(d.key) + '</code>: ' +
          (d.changed ? 'changed' : escapeHtml(d.from) + ' &rarr; ' + escapeHtml(d.to));
        return d.alarming
          ? '<li style="color:var(--color-danger,#c0392b)"><strong>' + body + '</strong></li>'
          : '<li>' + body + '</li>';
      }).join("") + '</ul>';
  }

  /**
   * Show one automation as editable JSON. `onSave(body)` receives the parsed
   * object and returns a promise; the modal stays open on rejection so the
   * operator does not lose their edit.
   *
   * Two properties make editing here safe rather than a footgun:
   *   - the body shown is the COMPLETE one (minus the legacy mirror, which would
   *     let a deleted `actions` be silently rebuilt from `targets`), because
   *     deleting a key here REMOVES that setting — PUT is a full replace;
   *   - a diff is confirmed before saving, and the changes that are dangerous
   *     rather than merely different (taking a disabled automation live, emptying
   *     the device filter or the action list) are called out.
   *
   * `onExport(body)` is optional and adds an Export button. What it receives is
   * the textarea's CURRENT contents, so an edit can be exported without being
   * saved first. The caller owns what "export" means, because it already holds
   * the catalogs the dependency block is named from - and both callers hand the
   * body to buildExportFile, so this button writes the PORTABLE file, not the
   * full-fidelity JSON on screen. Copy is what gives you that.
   */
  function openCodeModal(opts) {
    var o = opts || {};
    var original = forCodeView(o.body);
    var text = JSON.stringify(original, null, 2);
    var canSave = o.canSave !== false && typeof o.onSave === "function";
    var canExport = typeof o.onExport === "function";

    var note =
      '<p style="font-size:0.85rem;color:var(--color-text-tertiary);margin:0 0 0.5rem">' +
      'This is the automation exactly as it is stored. ' +
      (canSave
        ? '<strong>Removing a key removes that setting</strong> \u2014 saving replaces the whole automation rather than merging. ' +
          '<code>enabled</code>, <code>severity</code> and <code>reset</code> fall back to their defaults if you delete them, ' +
          'not to their current values.'
        : 'You do not have permission to change it.') +
      '</p>' +
      '<p style="font-size:0.8rem;color:var(--color-text-tertiary);margin:0 0 0.75rem">' +
      'Unlike an exported file, this includes delivery channel and recipient ids \u2014 and any api_call headers \u2014 so treat it as sensitive.' +
      (canExport
        ? ' <strong>Copy</strong> gives you exactly what is shown here; <strong>Export</strong> writes the portable file instead, ' +
          'with those references removed and listed as named dependencies.'
        : '') +
      '</p>';

    var body =
      note +
      '<textarea id="aw-code-text" rows="22" spellcheck="false" ' +
      (canSave ? "" : "readonly ") +
      'style="width:100%;font-family:var(--font-mono);font-size:0.8rem;line-height:1.45">' +
      escapeHtml(text) +
      '</textarea>' +
      '<div id="aw-code-err" class="form-error" style="display:none;margin-top:0.5rem"></div>';

    var footer =
      (canExport
        ? '<button class="btn btn-secondary" id="aw-code-export" type="button" ' +
          'title="Download this automation as a portable file">Export</button>'
        : "") +
      '<button class="btn btn-secondary" id="aw-code-copy" type="button">Copy</button>' +
      '<button class="btn btn-secondary" id="aw-code-cancel" type="button">' + (canSave ? "Cancel" : "Close") + '</button>' +
      (canSave ? '<button class="btn btn-primary" id="aw-code-save" type="button">Save changes</button>' : "");

    var ov = buildOverlay(1300, o.title || "Automation code", body, footer, null, true);
    var ta = ov.overlay.querySelector("#aw-code-text");
    var errBox = ov.overlay.querySelector("#aw-code-err");

    function showErr(msg) {
      errBox.textContent = msg;
      errBox.style.display = "";
    }

    ov.overlay.querySelector("#aw-code-cancel").addEventListener("click", function () { ov.close(); });

    /** The textarea as an automation body, or null with the error already shown.
     *  Export and Save share it: exporting an unparseable edit would write a
     *  file off the LAST good body, which is worse than refusing, because the
     *  operator would have no way to tell which one they got. */
    function readEdited() {
      errBox.style.display = "none";
      var parsed;
      try {
        parsed = JSON.parse(ta.value);
      } catch (err) {
        showErr("Invalid JSON: " + ((err && err.message) || "could not be parsed"));
        return null;
      }
      try {
        assertSafeKeys(parsed, 0);
      } catch (err2) {
        showErr(err2.message);
        return null;
      }
      if (!isPlainObject(parsed)) { showErr("The automation must be a JSON object."); return null; }
      if (!parsed.name || typeof parsed.name !== "string") { showErr("The automation needs a name."); return null; }
      return parsed;
    }

    if (canExport) {
      ov.overlay.querySelector("#aw-code-export").addEventListener("click", function () {
        var parsed = readEdited();
        if (!parsed) return;
        try {
          o.onExport(parsed);
        } catch (err) {
          showErr((err && err.message) || "Export failed");
        }
      });
    }

    ov.overlay.querySelector("#aw-code-copy").addEventListener("click", function () {
      var btn = this;
      var val = ta.value;
      function done(ok) {
        btn.textContent = ok ? "Copied" : "Copy failed";
        setTimeout(function () { btn.textContent = "Copy"; }, 1500);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(val).then(function () { done(true); }, function () { done(false); });
      } else {
        try { ta.select(); document.execCommand("copy"); done(true); } catch (_e) { done(false); }
      }
    });

    if (canSave) {
      ov.overlay.querySelector("#aw-code-save").addEventListener("click", async function () {
        var btn = this;

        var parsed = readEdited();
        if (!parsed) return;

        // "Did anything change?" is a question about the WHOLE body — the diff
        // below only tracks the fields whose removal is destructive, so relying
        // on it here would silently discard an edit to the message template,
        // the threshold or the name.
        if (JSON.stringify(parsed) === JSON.stringify(original)) { ov.close(); return; }

        // Deleting one of the tracked keys REMOVES that setting, so say so.
        var diff = diffForConfirm(original, parsed);
        if (!diff.length) {
          // Changed, but nothing destructive — save without a confirm.
          btn.disabled = true;
          try {
            await o.onSave(parsed);
            ov.close();
          } catch (err2) {
            btn.disabled = false;
            showErr((err2 && err2.message) || "Save failed");
          }
          return;
        }
        var alarming = diff.filter(function (d) { return d.alarming; });
        var lead = alarming.length
          ? "Save these changes? Some of them change whether or what this automation alerts on:"
          : "Save these changes?";
        var ok = await showConfirm(lead + "\n\n" + diff.map(function (d) {
          return (d.alarming ? "! " : "- ") + d.key + ": " + (d.changed ? "changed" : d.from + " -> " + d.to);
        }).join("\n"));
        if (!ok) return;

        btn.disabled = true;
        try {
          await o.onSave(parsed);
          ov.close();
        } catch (err) {
          btn.disabled = false;
          showErr((err && err.message) || "Save failed");
        }
      });
    }

    return ov;
  }

  window.PolarisAutomationPortability = {
    FORMAT_VERSION: FORMAT_VERSION,
    FILE_SUFFIX: FILE_SUFFIX,
    MAX_IMPORT_BYTES: MAX_IMPORT_BYTES,
    nameFromFilename: nameFromFilename,
    filenameForExport: filenameForExport,
    stripForExport: stripForExport,
    buildExportFile: buildExportFile,
    parseImportFile: parseImportFile,
    checkDependencies: checkDependencies,
    forCodeView: forCodeView,
    diffForConfirm: diffForConfirm,
    openCodeModal: openCodeModal,
  };
})();
