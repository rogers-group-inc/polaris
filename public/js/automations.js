/**
 * public/js/automations.js — Automations page (Alerts + Automations + Delivery tabs).
 *
 * Automations tab (default, gated automationManagement): automation list;
 * create/edit opens the 5-step wizard in automations-wizard.js. Delivery tab:
 * the NotificationChannel registry. Scripts tab: the AutomationScript
 * registry. The triggered-alert LIST no longer lives here — alerts surface on
 * the dashboard's Active Alerts widget + the asset-details Alerts tab (a
 * dedicated alerts widget rework is planned).
 */

var _rulesSF = null;
var _rulesLayout = null;
// Client-side paging: the list endpoint returns every rule (a fleet has
// tens, not thousands), so TableSF filters/sorts the full set and the page
// slice happens here. Mirrors blocks.js rather than the assets/events
// server-side mode.
var _rulesPageSize = 25;
var _rulesPage = 1;

// The builder catalogs (_ruleSchema / _ruleTagList / _ruleAssetTypes /
// _ruleChannels / _ruleRecipientUsers) and _looksLikeDeviceId now live at the
// top of automations-wizard.js — the wizard is their primary owner, and keeping
// them there lets a page load the wizard WITHOUT this file (the asset-details
// Alerts tab opens the edit modal that way). This file only reads them, always
// from inside a handler, so wizard-file load order stays a non-issue.

(function () {
  // Permissions resolve asynchronously via /auth/me (userReady). Computing
  // them at script-load time reads an empty matrix and wrongly hides the
  // Manage tab / action buttons — so they're (re)applied after userReady.
  var canManage = false;
  var canEditRules = false;
  var canReadScripts = false;
  var canEditScripts = false;
  var canReadContacts = false;
  var canEditContacts = false;
  var canReadChecks = false;
  var canEditChecks = false;

  function applyPermGatedUI() {
    canManage = permAtLeast("automationManagement", "read");
    canEditRules = permAtLeast("automationManagement", "write");
    canReadScripts = permAtLeast("automationScripts", "read");
    canEditScripts = permAtLeast("automationScripts", "write");
    canReadContacts = permAtLeast("contacts", "read");
    // "write" is enough to add — the ownership dimension decides which rows a
    // caller may then edit or delete, row by row, in the list renderer.
    canEditContacts = permAtLeast("contacts", "write");

    var mb = document.getElementById("auto-tab-manage-btn");
    if (mb) mb.style.display = canManage ? "" : "none";
    var db = document.getElementById("auto-tab-delivery-btn");
    if (db) db.style.display = canManage ? "" : "none";
    var sb = document.getElementById("auto-tab-scripts-btn");
    if (sb) sb.style.display = canReadScripts ? "" : "none";
    var cb = document.getElementById("auto-tab-contacts-btn");
    if (cb) cb.style.display = canReadContacts ? "" : "none";
    canReadChecks = permAtLeast("connectivityChecks", "read");
    canEditChecks = permAtLeast("connectivityChecks", "write");
    var cnb = document.getElementById("auto-tab-connectivity-btn");
    if (cnb) cnb.style.display = canReadChecks ? "" : "none";
    var activeKey = (document.querySelector("#auto-tabs .page-tab.active") || {}).getAttribute
      ? document.querySelector("#auto-tabs .page-tab.active").getAttribute("data-tab") : "manage";
    var nr = document.getElementById("btn-new-rule");
    if (nr) {
      nr.style.display = canEditRules && activeKey === "manage" ? "" : "none";
      if (canEditRules && !nr._wired) { nr._wired = true; nr.addEventListener("click", function () { openAutomationWizard(null).catch(function (err) { showToast(err && err.message || "Failed to open the automation wizard", "error"); }); }); }
    }
    var ac = document.getElementById("btn-add-channel");
    if (ac) {
      ac.style.display = canEditRules && activeKey === "delivery" ? "" : "none";
      if (canEditRules && !ac._wired) { ac._wired = true; ac.addEventListener("click", function () { showChannelTypePicker(); }); }
    }
    var asBtn = document.getElementById("btn-add-script");
    if (asBtn) {
      asBtn.style.display = canEditScripts && activeKey === "scripts" ? "" : "none";
      if (canEditScripts && !asBtn._wired) { asBtn._wired = true; asBtn.addEventListener("click", function () { openScriptModal(null); }); }
    }
    var ckBtn = document.getElementById("btn-add-check");
    if (ckBtn) {
      ckBtn.style.display = canEditChecks && activeKey === "connectivity" ? "" : "none";
      if (canEditChecks && !ckBtn._wired) {
        ckBtn._wired = true;
        ckBtn.addEventListener("click", function () { window.PolarisConnectivityChecks.openCheckModal(null); });
      }
    }
    var acBtn2 = document.getElementById("btn-add-contact");
    if (acBtn2) {
      acBtn2.style.display = canEditContacts && activeKey === "contacts" ? "" : "none";
      if (canEditContacts && !acBtn2._wired) {
        acBtn2._wired = true;
        acBtn2.addEventListener("click", function () { window.PolarisAddressBook.openEditor(null); });
      }
    }
  }

  // Web push enrollment used to have an "Enable push" button here. It is gone:
  // enrolling a browser is no longer a decision of its own, it is what happens
  // when the operator says how they want to be alerted. That choice lives on
  // the account menu (every page) and on the mobile More tab, is stored on the
  // USER, and every browser reconciles its own subscription to it at boot —
  // so a page-local switch would be a second answer to the same question.

  // ─── Tabs ──────────────────────────────────────────────────────────────
  document.querySelectorAll("#auto-tabs .page-tab").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var key = btn.getAttribute("data-tab");
      document.querySelectorAll("#auto-tabs .page-tab").forEach(function (b) { b.classList.remove("active"); });
      document.querySelectorAll('[id^="auto-tab-"]').forEach(function (p) { if (p.classList.contains("page-tab-panel")) p.classList.remove("active"); });
      btn.classList.add("active");
      var panel = document.getElementById("auto-tab-" + key);
      if (panel) panel.classList.add("active");
      // Header buttons are tab-specific: New rule on Manage, Add channel on Delivery.
      var nrBtn = document.getElementById("btn-new-rule");
      if (nrBtn && canEditRules) nrBtn.style.display = key === "manage" ? "" : "none";
      var acBtn = document.getElementById("btn-add-channel");
      if (acBtn && canEditRules) acBtn.style.display = key === "delivery" ? "" : "none";
      var asBtn2 = document.getElementById("btn-add-script");
      if (asBtn2 && canEditScripts) asBtn2.style.display = key === "scripts" ? "" : "none";
      var acBtn3 = document.getElementById("btn-add-contact");
      if (acBtn3 && canEditContacts) acBtn3.style.display = key === "contacts" ? "" : "none";
      var ckBtn2 = document.getElementById("btn-add-check");
      if (ckBtn2 && canEditChecks) ckBtn2.style.display = key === "connectivity" ? "" : "none";
      if (key === "manage" && !_rulesSF) initRulesTab();
      if (key === "delivery") loadChannelsTab();
      if (key === "scripts") loadScriptsTab();
      if (key === "connectivity") window.PolarisConnectivityChecks.loadTab();
      if (key === "contacts") window.PolarisAddressBook.renderTab();
    });
  });

  document.getElementById("btn-refresh").addEventListener("click", function () {
    var active = document.querySelector("#auto-tabs .page-tab.active");
    var key = active ? active.getAttribute("data-tab") : "manage";
    if (key === "delivery") loadChannelsTab();
    else if (key === "scripts") loadScriptsTab();
    else if (key === "contacts") window.PolarisAddressBook.renderTab();
    else if (key === "connectivity") window.PolarisConnectivityChecks.loadTab();
    else loadRules();
  });

  // `#tab=<key>` opens a tab directly (the asset Connectivity tab's "Manage
  // checks" link, the screenshot pipeline). Only a visible tab can be opened.
  function openHashTab() {
    var hash = typeof location !== "undefined" ? location.hash : "";
    var m = /(?:^#|&)tab=([a-z]+)/.exec(hash || "");
    if (!m) return false;
    var btn = document.querySelector('#auto-tabs .page-tab[data-tab="' + m[1] + '"]');
    if (!btn || btn.style.display === "none") return false;
    btn.click();
    return true;
  }

  // Apply permission-gated UI (tab visibility, header buttons) once /auth/me
  // has populated the permission matrix, then boot the default (Automations) tab.
  function bootPage() {
    applyPermGatedUI();
    if (openHashTab()) return;
    if (canManage && !_rulesSF) initRulesTab();
    // A role granted connectivityChecks alone reaches this page (the page gate
    // is anyOf) with the Automations tab hidden — land it on its own tab.
    if (!canManage && canReadChecks) {
      var cbtn = document.getElementById("auto-tab-connectivity-btn");
      if (cbtn) cbtn.click();
    }
  }
  if (typeof userReady !== "undefined" && userReady && userReady.then) {
    userReady.then(bootPage);
  } else {
    bootPage();
  }

  // ═══════════════════════════════ Manage tab ═════════════════════════════
  // Persisted per user, same shape and key convention as every other list
  // page (see events.js / blocks.js): TableSF's filter+sort state, the column
  // layout (widths + hidden columns), and the page size in one blob.
  function _saveRulesPrefs() {
    if (typeof currentUsername === "undefined") return;
    PolarisPrefs.save("automations", currentUsername, Object.assign(
      { pageSize: _rulesPageSize, layout: _rulesLayout ? _rulesLayout.getPrefs() : null },
      _rulesSF ? _rulesSF.getPrefs() : {},
    ));
  }

  function _restoreRulesPrefs() {
    if (typeof currentUsername === "undefined") return;
    var p = PolarisPrefs.load("automations", currentUsername);
    if (!p) return;
    if (p.pageSize) _rulesPageSize = p.pageSize;
    if (_rulesLayout && p.layout) _rulesLayout.setPrefs(p.layout);
    if (_rulesSF) _rulesSF.setPrefs(p);
  }

  function initRulesTab() {
    var rulesTable = document.querySelector("#rules-tbody").closest("table");
    // TableSF first, then setupColumnLayout (so resize handles survive — TableSF
    // rewrites th innerHTML).
    _rulesSF = new TableSF("rules-tbody", function () {
      // A filter/sort change can shrink the result set past the current page —
      // go back to page 1 rather than leaving the operator on an empty one.
      _rulesPage = 1;
      renderRules();
      _saveRulesPrefs();
    });
    _rulesLayout = setupColumnLayout(rulesTable, { onChange: _saveRulesPrefs });
    // Restore BEFORE the first render so the initial paint already carries the
    // operator's sort, filters, widths and page size.
    _restoreRulesPrefs();
    loadRules();
  }

  var _rules = [];
  function loadRules() {
    if (!canManage) return;
    // The schema rides along because the Scope cell's tooltip spells the
    // condition tree out in the builder's own words ("Device type is equal
    // to…"). It's cached module-wide and shared with the wizard, so this
    // costs one fetch per page load; a failure only degrades the tooltip to
    // raw field/operator names, so it never blocks the list.
    var schemaReady = _ruleSchema
      ? Promise.resolve()
      : api.automations.schema().then(function (s) { _ruleSchema = s; }).catch(function () {});
    Promise.all([api.automations.list(), schemaReady]).then(function (results) {
      _rules = results[0].rules || [];
      // Before the first paint: the Addresses column resolves user ids, role
      // ids and channel ids client-side, and rendering without the catalogs
      // would show stubs and then silently rewrite them a moment later.
      return loadRuleRecipientCatalogs(_rules).then(function () { renderRules(); });
    }).catch(function () {
      document.getElementById("rules-tbody").innerHTML = '<tr><td colspan="10" class="empty-state">Failed to load automations</td></tr>';
    });
  }
  window._reloadRules = loadRules;

  // Build a full rule-input body from a loaded rule record, applying overrides.
  // The PUT /notification-rules/:id route validates the complete ruleInputSchema,
  // so the inline enable/disable toggle must resend every field.
  // Exposed on window for the unit-test harness (automationsRuleToInput.test.ts)
  // — this function silently dropping a v2 field is a data-loss bug class.
  function _ruleToInput(r, overrides) {
    // Rule-shape v2: resend reset + actions (the server's list endpoint always
    // returns them) so this full-record PUT can't strip the v2 fields. The
    // legacy clearBehavior/targets columns are the server-maintained mirror —
    // never sent from here (v2 wins server-side when both appear anyway).
    return Object.assign({
      name: r.name,
      description: r.description != null ? r.description : null,
      enabled: r.enabled,
      severity: r.severity,
      trigger: r.trigger,
      scope: r.scope || {},
      reset: r.reset || null,
      actions: Array.isArray(r.actions) ? r.actions : [],
      cooldownSec: r.cooldownSec != null ? r.cooldownSec : null,
      messageTemplate: r.messageTemplate != null ? r.messageTemplate : null,
      requireAckNote: r.requireAckNote === true,
      // MANDATORY. This function backs the list row's enable/disable toggle,
      // which PUTs the whole record; an omitted nullable Json field is cleared
      // server-side by jsonOrClear, so leaving this out would delete the
      // operator's repeat config every time they flipped the switch.
      repeat: r.repeat || null,
      channels: r.channels || ["in_app"],
      emailComposition: r.emailComposition || null,
      escalation: r.escalation || null,
      severityBands: Array.isArray(r.severityBands) && r.severityBands.length ? r.severityBands : null,
      bandNotify: r.bandNotify || null,
      // Omitting a nullable Json field CLEARS it server-side (jsonOrClear maps
      // an absent value to null → Prisma.DbNull), so the enable toggle has to
      // resend this or flipping a switch would delete the automation's reset
      // actions.
      resetActions: Array.isArray(r.resetActions) && r.resetActions.length ? r.resetActions : null,
    }, overrides || {});
  }
  window._ruleToInput = _ruleToInput;

  // ── Clone naming ──────────────────────────────────────────────────────────
  //
  // Suggested name for a cloned automation: "<root> (copy)", then "(copy 2)",
  // "(copy 3)" … until one is free among the names already in the list.
  //
  // Two deliberate behaviours. An existing copy suffix on the SOURCE is
  // stripped first, so cloning "Switch temp (copy)" gives "Switch temp
  // (copy 2)" rather than "Switch temp (copy) (copy)" — repeated cloning is
  // exactly the case this runs in. And uniqueness here is about the operator
  // being able to tell two rows apart in the list, NOT about validity:
  // NotificationRule.name carries no unique constraint, so a collision would
  // save fine and simply be unreadable.
  function cloneName(baseName, takenNames) {
    var root = String(baseName == null ? "" : baseName).replace(/\s*\(copy(?:\s+\d+)?\)\s*$/i, "").trim();
    if (!root) root = "Automation";
    var taken = {};
    (takenNames || []).forEach(function (n) { taken[String(n == null ? "" : n).trim().toLowerCase()] = true; });
    for (var i = 1; i <= 200; i++) {
      var candidate = root + (i === 1 ? " (copy)" : " (copy " + i + ")");
      if (!taken[candidate.toLowerCase()]) return candidate;
    }
    return root + " (copy)";
  }
  window._automationCloneName = cloneName;

  // ── Scope-cell hover tooltip ──────────────────────────────────────────────
  //
  // The Scope cell is necessarily terse ("custom filter (3 conditions)"), so
  // the cell's title spells out what the automation actually does: one row for
  // the filter itself, one for the actions it runs. Native title rather than a
  // custom popover — same idiom the rest of this page uses, and it survives the
  // table's column resize / reorder without extra wiring.

  // Human-readable condition tree. Mirrors the wizard's condText, but resolves
  // its labels from the loaded schema and degrades to raw field/operator names
  // when the schema fetch failed — a tooltip must never be the thing that
  // throws while rendering the list.
  function condTooltipText(g) {
    var sc = (_ruleSchema && _ruleSchema.scopeCondition) || {};
    var fields = sc.fields || [];
    var opLabels = sc.operatorLabels || {};
    var render = function (node) {
      var parts = (node.children || []).map(function (c) {
        if (c.op !== undefined && Array.isArray(c.children)) return "(" + render(c) + ")";
        var fm = fields.find(function (f) { return f.field === c.field; });
        return (fm ? fm.label : c.field) + " " + (opLabels[c.operator] || c.operator) + " " + c.value;
      });
      if (node.op === "or") return parts.join(" OR ");
      if (node.op === "none") return "NOT(" + parts.join(" OR ") + ")";
      if (node.op === "notAll") return "NOT(" + parts.join(" AND ") + ")";
      return parts.join(" AND ");
    };
    return render(g);
  }

  // What this automation does when it fires. The in-app alert is always first
  // because it's the one outcome every automation has (the wizard's
  // non-removable in-app card) — an automation with no configured actions is
  // not silent, and the tooltip shouldn't imply otherwise. Actions are counted
  // by type rather than named: channel/script names would need the Delivery +
  // Scripts caches, which the Automations tab doesn't load.
  function actionsTooltipText(r) {
    var counts = {};
    var tally = function (list) {
      (list || []).forEach(function (a) {
        if (!a || !a.type) return;
        counts[a.type] = (counts[a.type] || 0) + 1;
      });
    };
    tally(r.actions);
    (r.severityBands || []).forEach(function (b) { tally(b && b.actions); });
    if (r.bandNotify && r.bandNotify.resolvedMode === "dedicated") tally(r.bandNotify.resolvedActions);

    var labels = { notify: "notification", api_call: "API call", script: "script run" };
    var parts = ["in-app alert"];
    Object.keys(counts).forEach(function (type) {
      var n = counts[type];
      var label = labels[type] || type;
      parts.push(n + " " + label + (n === 1 ? "" : "s"));
    });

    // Escalation spans four places: the rule-level chain, each action's own
    // chain, and the same pair inside every severity band. Count tiers across
    // all of them so a tooltip can't under-report how much mail this sends.
    var tiers = 0;
    var addChain = function (esc) {
      if (esc && Array.isArray(esc.tiers)) tiers += esc.tiers.length;
    };
    addChain(r.escalation);
    (r.actions || []).forEach(function (a) { addChain(a && a.escalation); });
    (r.severityBands || []).forEach(function (b) {
      addChain(b && b.escalation);
      ((b && b.actions) || []).forEach(function (a) { addChain(a && a.escalation); });
    });

    var text = parts.join(" + ");
    if (tiers) text += " (" + tiers + " escalation tier" + (tiers === 1 ? "" : "s") + ")";
    return text;
  }

  /**
   * The automation described in its own words, one string per part of the
   * builder — what the list's Devices / Trigger / Reset / Actions columns show.
   *
   * The trigger and reset strings come from `PolarisAutomationSentences`, the
   * same pure factory the wizard renders its own steps from, so the list can't
   * describe an automation differently from the editor that made it. They come
   * back as HTML (the wizard bolds the values), and a table cell wants plain
   * text: TableSF filters and sorts on these strings, so a `<strong>` in the
   * value would be matched by a search for "strong" and would sort as markup.
   */
  var _sentCache = null;
  function sentences() {
    if (!_sentCache && window.PolarisAutomationSentences) {
      // The factory tolerates a missing schema (every catalog lookup falls back),
      // so a failed schema fetch degrades the wording instead of the column.
      _sentCache = window.PolarisAutomationSentences.make(_ruleSchema || {});
    }
    return _sentCache;
  }

  /** HTML → text, entities and all. */
  function plainText(html) {
    var d = document.createElement("div");
    d.innerHTML = String(html == null ? "" : html);
    return (d.textContent || "").replace(/\s+/g, " ").trim();
  }

  function devicesSummary(r) {
    var scope = r.scope;
    if (scope && scope.condition) return condTooltipText(scope.condition) || "(no conditions)";
    if (scope && scope.allAssets) return "All devices";
    return scopeSummary(scope);
  }

  function triggerSummary(r) {
    var s = sentences();
    if (!s) return String((r.trigger && r.trigger.type) || "");
    try {
      return plainText(s.triggerSentence(r.trigger, { severity: r.severity, severityBands: r.severityBands }));
    } catch (_e) {
      return String((r.trigger && r.trigger.type) || "");
    }
  }

  function resetSummary(r) {
    var s = sentences();
    if (!s) return "";
    try {
      return plainText(s.resetSentence(r.reset, r.trigger));
    } catch (_e) {
      return "";
    }
  }

  function scopeTooltip(r) {
    return "Filter: " + devicesSummary(r) + "\nActions: " + actionsTooltipText(r);
  }
  // Exposed for the unit-test harness (automationsScopeTooltip.test.ts) — the
  // action tally walks four separate escalation/action locations and silently
  // under-reporting them is the failure mode worth pinning.
  window._scopeTooltip = scopeTooltip;
  // The four list columns, for the unit harness (automationsListSummaries.test.ts).
  // These are what an operator reads to tell two automations apart without
  // opening either, so a summary that silently says nothing is the failure mode.
  window._ruleSummaries = {
    devices: devicesSummary,
    trigger: triggerSummary,
    reset: resetSummary,
    actions: actionsTooltipText,
    addresses: addressesSummary,
    addressesTooltip: addressesTooltip,
  };

  // ── Addresses column ──────────────────────────────────────────────────────
  //
  // "Who does this actually reach?" was only answerable by opening the wizard
  // and walking six action locations by hand. The cell carries the deduped flat
  // list (so TableSF can filter the list by an address) and the hover carries
  // the breakdown — the base notification, each severity band, each escalation
  // tier, and the reset/all-clear notifications, each with its channel.
  //
  // Resolution runs entirely client-side off three catalogs, fetched lazily
  // (see loadRuleRecipientCatalogs) — a role or a user id resolves to a name
  // only if the corresponding fetch succeeded, and degrades to the editor's
  // own "(unknown …)" stub otherwise rather than dropping a recipient.
  function recipientCatalogs() {
    return {
      users: _ruleRecipientUsers || [],
      roles: _ruleScopeRoles || [],
      channels: _ruleChannels || [],
    };
  }

  function ruleGroups(r) {
    var f = window.PolarisAutomationRecipients;
    if (!f || !f.ruleRecipientGroups) return [];
    try { return f.ruleRecipientGroups(r, recipientCatalogs()); } catch (_e) { return []; }
  }

  /** Flat, deduped, order-preserving list of every address the rule reaches. */
  function addressesSummary(r, groups) {
    groups = groups || ruleGroups(r);
    var seen = {};
    var out = [];
    groups.forEach(function (g) {
      g.to.concat(g.cc, g.bcc).forEach(function (a) {
        var k = a.toLowerCase();
        if (!seen[k]) { seen[k] = true; out.push(a); }
      });
    });
    if (out.length) return out.join(", ");
    // An automation with only chat/webhook notify actions still reaches real
    // people, through the channel's own destination — "none" would be wrong.
    var fixed = groups.filter(function (g) { return g.fixedDestination; });
    if (!fixed.length) return "";
    return fixed.map(function (g) { return g.channel || "channel"; })
      .filter(function (n, i, a) { return a.indexOf(n) === i; })
      .join(", ") + " (channel destination)";
  }

  /** The same information grouped by where in the automation it's declared. */
  function addressesTooltip(r, groups) {
    groups = groups || ruleGroups(r);
    if (!groups.length) return "No notifications are sent — this automation only raises an in-app alert.";
    var lines = [];
    groups.forEach(function (g) {
      var head = g.where + (g.channel ? " — " + g.channel : "");
      if (g.fixedDestination) {
        lines.push(head + ": posts to the channel's own destination");
        return;
      }
      lines.push(head + ":");
      var row = function (prefix, list) {
        list.forEach(function (a) { lines.push("    " + prefix + a); });
      };
      if (!g.to.length && !g.cc.length && !g.bcc.length) lines.push("    (no recipients configured)");
      row("", g.to);
      row("Cc: ", g.cc);
      row("Bcc: ", g.bcc);
    });
    return lines.join("\n");
  }

  /**
   * The three catalogs the Addresses column resolves against, fetched once and
   * only when a rule actually needs them: a fleet with no role- or user-routed
   * notify action never pays for the lookup, and `/automations/scope-options`
   * in particular is the page's most expensive read (fleet-wide groupBys), so
   * it's gated on a rule genuinely naming a role.
   *
   * Every fetch is best-effort — the column degrades to unresolved stubs, and
   * the list must never fail to render because a catalog 403'd.
   */
  function loadRuleRecipientCatalogs(rules) {
    var wantsNotify = false, wantsUsers = false, wantsRoles = false;
    // Deliberately a loose deep sweep rather than the canonical action walk:
    // this only decides WHICH fetches to make, and over-fetching is cheaper
    // than a missed location. It keys on the recipient fields themselves so a
    // Cc block anywhere — rule-level emailComposition, a legacy escalation
    // tier's `to` — counts. ruleRecipientGroups does the exact walk afterwards.
    var deep = function (v, depth) {
      if (!v || typeof v !== "object" || depth > 8) return;
      if (Array.isArray(v)) { v.forEach(function (x) { deep(x, depth + 1); }); return; }
      if (v.type === "notify") wantsNotify = true;
      if ((v.recipientUserIds || []).length) wantsUsers = true;
      if ((v.recipientRoles || []).length) wantsRoles = true;
      Object.keys(v).forEach(function (k) { deep(v[k], depth + 1); });
    };
    (rules || []).forEach(function (r) { deep(r, 0); });
    if (!wantsNotify) return Promise.resolve();
    var jobs = [];
    if (_ruleChannels === null) {
      jobs.push(api.deliveryChannels.list()
        .then(function (d) { _ruleChannels = (d && d.channels) || []; })
        .catch(function () { _ruleChannels = []; }));
    }
    if (wantsUsers && _ruleRecipientUsers === null) {
      jobs.push(api.automations.recipientUsers()
        .then(function (d) { _ruleRecipientUsers = (d && d.users) || []; })
        .catch(function () { _ruleRecipientUsers = []; }));
    }
    if (wantsRoles && _ruleScopeRoles === null) {
      jobs.push(api.automations.scopeOptions()
        .then(function (d) { _ruleScopeRoles = (d && d.roles) || []; })
        .catch(function () { _ruleScopeRoles = []; }));
    }
    return Promise.all(jobs);
  }

  function scopeSummary(scope) {
    if (!scope || typeof scope !== "object") return "-";
    if (scope.allAssets) return "All assets";
    if (scope.condition) {
      var n = 0;
      (function walk(g) { (g.children || []).forEach(function (c) { if (c.op !== undefined) walk(c); else n++; }); })(scope.condition);
      return "custom filter (" + n + " condition" + (n === 1 ? "" : "s") + ")";
    }
    var parts = [];
    if (scope.assetTypes && scope.assetTypes.length) parts.push("types: " + scope.assetTypes.join("/"));
    if (scope.tags && scope.tags.length) parts.push("tags: " + scope.tags.join("/"));
    if (scope.manufacturers && scope.manufacturers.length) parts.push("mfr: " + scope.manufacturers.join("/"));
    if (scope.models && scope.models.length) parts.push("model: " + scope.models.join("/"));
    if (scope.subnetCidrs && scope.subnetCidrs.length) parts.push("subnets: " + scope.subnetCidrs.join("/"));
    if (scope.assetIds && scope.assetIds.length) parts.push(scope.assetIds.length + " asset(s)");
    if (scope.integrationIds && scope.integrationIds.length) parts.push(scope.integrationIds.length + " integration(s)");
    return parts.length ? parts.join("; ") : "n/a";
  }

  /** Does this automation DEFINE down (business rule 36)? Delegates to the
   *  shared sentence factory so the list and the wizard cannot disagree about
   *  what counts as a down-detection automation. */
  function _isDownDetectionRule(r) {
    var f = typeof sentences === "function" ? sentences() : null;
    if (f && f.isDownDetectionTrigger) return f.isDownDetectionTrigger(r.trigger);
    return false;
  }
  function renderRules() {
    var tbody = document.getElementById("rules-tbody");
    var data = _rules.map(function (r) {
      var groups = ruleGroups(r);
      return Object.assign({}, r, {
        // "down detection" rather than the raw "asset_state" for an automation
        // that DEFINES down: it is a different kind of thing from a rule that
        // merely reads a state column, and an operator needs to find the set.
        // Computed into the row data BEFORE TableSF sees it, so the column
        // filters and sorts on it for free.
        triggerType: _isDownDetectionRule(r) ? "down detection" : (r.trigger && r.trigger.type ? r.trigger.type : ""),
        devicesSummary: devicesSummary(r),
        triggerSummary: triggerSummary(r),
        resetSummary: resetSummary(r),
        actionsSummary: actionsTooltipText(r),
        // One recipient walk per rule, read by both the cell and its hover.
        addressesSummary: addressesSummary(r, groups),
        addressesTooltip: addressesTooltip(r, groups),
        scopeTooltip: scopeTooltip(r),
      });
    });
    if (_rulesSF) data = _rulesSF.apply(data);
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="empty-state">No automations yet' + (canEditRules ? ' — click "+ New automation" to create one.' : "") + '</td></tr>';
      clearPageControls("rules-pagination");
      return;
    }

    // Clamp before slicing: deleting the last row of the final page (or a
    // filter narrowing the set) can leave _rulesPage past the end.
    var totalPages = Math.max(1, Math.ceil(data.length / _rulesPageSize));
    if (_rulesPage > totalPages) _rulesPage = totalPages;
    var pageStart = (_rulesPage - 1) * _rulesPageSize;
    var pageRows = data.slice(pageStart, pageStart + _rulesPageSize);

    renderPageControls("rules-pagination", data.length, _rulesPageSize, _rulesPage,
      function (p) {
        _rulesPage = p;
        renderRules();
      },
      function (size) {
        _rulesPageSize = size;
        _rulesPage = 1;
        renderRules();
        _saveRulesPrefs();
      });

    var prose = function (text) {
      var t = String(text == null ? "" : text);
      return '<td class="rules-prose" style="font-size:0.82rem" title="' + escapeHtml(t) + '">' + escapeHtml(t) + '</td>';
    };
    tbody.innerHTML = pageRows.map(function (r) {
      // The row's verbs live behind the name (Edit / Clone / Delete) instead of
      // an Actions column. Without edit rights there's nothing to offer, so the
      // name stays plain text rather than a control that opens an empty menu.
      var nameCell = canEditRules
        ? '<button type="button" class="row-menu-trigger rule-menu" data-id="' + r.id + '" ' +
            'aria-haspopup="menu" aria-expanded="false" title="Actions for this automation">' +
            escapeHtml(r.name) + '</button>'
        : escapeHtml(r.name);
      // Enabled toggle — interactive switch for rule editors; static label otherwise.
      var enabledCell = canEditRules
        ? '<label class="toggle-switch" title="' + (r.enabled ? "Enabled — click to disable" : "Disabled — click to enable") + '">' +
            '<input type="checkbox" class="rule-enabled-toggle" data-id="' + r.id + '"' + (r.enabled ? " checked" : "") + '>' +
            '<span class="toggle-slider"></span>' +
          '</label>'
        : (r.enabled ? "Yes" : '<span style="color:var(--color-text-tertiary)">No</span>');
      return '<tr>' +
        '<td>' + nameCell + '</td>' +
        '<td><span class="badge">' + escapeHtml(r.triggerType) + '</span></td>' +
        '<td><span class="badge badge-level-' + escapeHtml(r.severity || "info") + '">' + escapeHtml((r.severity || "info").toUpperCase()) + '</span></td>' +
        '<td>' + enabledCell + '</td>' +
        // Each prose cell carries its own full text as the title: the columns
        // are resizable and the sentences are long, so the hover is what makes a
        // truncated cell readable without widening the table.
        prose(r.devicesSummary) +
        prose(r.triggerSummary) +
        prose(r.resetSummary) +
        prose(r.actionsSummary) +
        '<td class="rules-prose" style="font-size:0.82rem" title="' + escapeHtml(r.addressesTooltip) + '">' +
          (r.addressesSummary
            ? escapeHtml(r.addressesSummary)
            : '<span style="color:var(--color-text-tertiary)">none</span>') +
        '</td>' +
        '<td>' + escapeHtml(r.createdBy || "-") + '</td>' +
        '</tr>';
    }).join("");
    tbody.querySelectorAll(".rule-enabled-toggle").forEach(function (cb) {
      cb.addEventListener("change", async function () {
        var r = _rules.find(function (x) { return x.id === cb.dataset.id; });
        if (!r) return;
        var desired = cb.checked;
        // Disabling is a removal as far as down detection is concerned — the
        // resolver only reads ENABLED rules.
        if (!desired) {
          var warn = await downDetectionRemovalWarning(r.id);
          if (warn && !(await showConfirm('Disable automation "' + r.name + '"?' + warn))) {
            cb.checked = true;
            return;
          }
        }
        cb.disabled = true;
        try {
          await api.automations.update(r.id, _ruleToInput(r, { enabled: desired }));
          r.enabled = desired;
          showToast("Automation " + (desired ? "enabled" : "disabled"), "success");
          loadRules();
        } catch (err) {
          cb.checked = !desired;
          cb.disabled = false;
          showToast(err.message || "Update failed", "error");
        }
      });
    });
    tbody.querySelectorAll(".rule-menu").forEach(function (b) {
      b.addEventListener("click", function () {
        var r = _rules.find(function (x) { return x.id === b.dataset.id; });
        if (!r) return;
        showRowMenu(b, [
          { label: "Edit", onSelect: function () { openWizardFor(r); } },
          {
            label: "Clone",
            title: "Create a disabled copy of this automation",
            // Name is uniquified HERE, not in the wizard: this is the only side
            // holding the full rule list (_rules is every row, not the page slice).
            onSelect: function () { openWizardFor(r, { clone: true, name: cloneName(r.name, _rules.map(function (x) { return x.name; })) }); },
          },
        ].concat(portabilityMenuItems(r), [
          { separator: true },
          { label: "Delete", danger: true, onSelect: function () { confirmDeleteRule(r); } },
        ]), { label: "Actions for " + r.name });
      });
    });
  }

  /** Catalogs for the export strip. The list page holds channels and the
   *  schema; the rest are best-effort, and an id that cannot be resolved is
   *  reported in the file as an id rather than dropped. */
  function portabilityCatalogs() {
    return {
      channels: _ruleChannels || [],
      scripts: _awScripts || [],
      users: _ruleRecipientUsers || [],
      stateProbes: (_ruleSchema && _ruleSchema.stateProbes) || [],
      tags: _ruleTagList || [],
      assetTypes: _ruleAssetTypes || [],
    };
  }

  /** The leading separator belongs to these items, so a page without the
   *  portability module renders one rule before Delete rather than two.
   *  Export / View code re-serialize a row the caller can already read, so they
   *  are offered at read level; the code editor gates its own Save on fullwrite. */
  function portabilityMenuItems(r) {
    var P = window.PolarisAutomationPortability;
    if (!P) return [];
    return [
      { separator: true },
      {
        label: "View code",
        title: "See and edit this automation as JSON",
        onSelect: function () { openCodeFor(r); },
      },
      {
        label: "Export",
        title: "Download this automation as a portable file",
        onSelect: function () { exportRule(r); },
      },
    ];
  }

  /** The one export path, shared by the row menu and the code modal's Export
   *  button \u2014 so a file downloaded from either place is the same portable file,
   *  and the toast that explains the dependency block is written once. */
  function exportBody(body) {
    var P = window.PolarisAutomationPortability;
    if (!P) return;
    var file = P.buildExportFile(body, portabilityCatalogs(), {
      polarisVersion: (window.polarisVersion || undefined),
    });
    var deps = (file.dependencies || []).length;
    window.downloadJson(file, P.filenameForExport(body.name));
    showToast(deps
      ? "Exported. The file lists " + deps + " thing" + (deps === 1 ? "" : "s") + " it needs \u2014 delivery wiring is not included."
      : "Exported.", "success");
  }

  function exportRule(r) {
    // _ruleToInput is the tested row -> ruleInput converter; the strip inside
    // exportBody then removes every install-specific reference and names it as
    // a dependency.
    exportBody(_ruleToInput(r));
  }

  function openCodeFor(r) {
    var P = window.PolarisAutomationPortability;
    if (!P) return;
    P.openCodeModal({
      title: "Code for \u201c" + r.name + "\u201d",
      body: _ruleToInput(r),
      canSave: canEditRules,
      // Exporting is read-level, like the code view itself, and it exports what
      // is in the textarea: an edit can be carried out of here without being
      // saved onto the running automation.
      onExport: function (edited) { exportBody(_ruleToInput(edited)); },
      onSave: canEditRules ? async function (edited) {
        // Route the edit through _ruleToInput as well: it normalises every
        // field explicitly, which is what keeps a PUT (a full replace) from
        // clearing a nullable JSON column the operator never touched.
        await api.automations.update(r.id, _ruleToInput(edited));
        showToast("Automation saved", "success");
        loadRules();
      } : null,
    });
  }

  function openWizardFor(rule, opts) {
    openAutomationWizard(rule, opts).catch(function (err) {
      showToast((err && err.message) || "Failed to open the automation wizard", "error");
    });
  }

  /**
   * The extra warning a down-detection automation earns before it is deleted or
   * disabled: taking away the LAST automation covering a device makes it
   * Passive — still polled, never declared down again. That is a legitimate
   * choice but it has to be a deliberate one, and it is the one change nothing
   * else can warn about, because the thing that would normally alert about a
   * blind fleet is the automation being removed.
   *
   * Best-effort: a failed lookup must not block the operator from managing
   * their own automations, so it degrades to the plain confirmation.
   */
  async function downDetectionRemovalWarning(ruleId) {
    var impact;
    try { impact = await api.automations.removalImpact(ruleId); }
    catch (_e) { return ""; }
    if (!impact || !impact.isDownDetection || !impact.wouldBecomePassive) return "";
    var n = impact.wouldBecomePassive;
    var msg = " " + n + " device" + (n === 1 ? "" : "s") + " would be left with NO down detection" +
      " — Polaris keeps polling " + (n === 1 ? "it" : "them") + " but will never declare " +
      (n === 1 ? "it" : "them") + " down again";
    if (impact.sampleHostnames && impact.sampleHostnames.length) {
      msg += " (e.g. " + impact.sampleHostnames.slice(0, 3).join(", ") + ")";
    }
    if (impact.wouldFallBackToAnother) {
      msg += ". Another " + impact.wouldFallBackToAnother + " would fall back to a broader automation";
    }
    return msg + ".";
  }

  async function confirmDeleteRule(r) {
    var extra = await downDetectionRemovalWarning(r.id);
    var ok = await showConfirm('Delete automation "' + r.name + '"? Its firing state is dropped; existing alerts are kept.' + extra);
    if (!ok) return;
    try { await api.automations.delete(r.id); showToast("Automation deleted", "success"); loadRules(); }
    catch (err) { showToast(err.message || "Delete failed", "error"); }
  }

  // expose for the builder (defined at module scope below)
  window._notifLoadRules = loadRules;
  window._notifGetSchema = function () { return _ruleSchema; };
})();

// ═══════════════════════════ Delivery (channels) tab ════════════════════════
// Operator-managed list of outbound delivery channels, set up like the
// Integrations page. Backed by /notification-channels; secrets masked on read.

async function loadChannelsTab() {
  var container = document.getElementById("channels-list");
  if (!container) return;
  if (!_ruleSchema) { try { _ruleSchema = await api.automations.schema(); } catch (_e) { /* labels degrade to raw type */ } }
  container.innerHTML = '<p class="empty-state">Loading…</p>';
  loadWebPushCard();
  try {
    var resp = await api.deliveryChannels.list();
    _ruleChannels = (resp && resp.channels) || [];
    renderChannelsList(_ruleChannels);
  } catch (err) {
    container.innerHTML = '<p class="empty-state">Error: ' + escapeHtml(err.message || "load failed") + '</p>';
  }
}

// ─── Web Push card ───────────────────────────────────────────────────────
// Every other channel names a destination (SMTP host, webhook URL, Pushbullet
// account) and so earns a form. Web Push names nothing — the keypair is
// generated, the destinations are whichever devices users enrolled, and WHO
// gets a given alert is chosen per Notify action when an automation is built.
// So it's one switch.
async function loadWebPushCard() {
  var el = document.getElementById("web-push-card");
  if (!el) return;
  try { renderWebPushCard(await api.deliveryChannels.getWebPush()); }
  catch (_e) { el.innerHTML = ""; }
}

function renderWebPushCard(state) {
  var el = document.getElementById("web-push-card");
  if (!el) return;
  var canEdit = permAtLeast("automationManagement", "write");
  var on = !!(state && state.enabled);
  var count = (state && state.subscriberCount) || 0;

  // Without this the toggle is feedback-free — an operator can't tell whether
  // anyone actually receives what they turned on.
  var devices = count === 0
    ? '<span style="color:var(--color-text-tertiary)">no devices enrolled yet</span>'
    : '<strong>' + count + '</strong> device' + (count === 1 ? '' : 's') + ' enrolled';

  el.innerHTML = '<div class="integration-card">' +
    '<div class="integration-card-header">' +
      '<div class="integration-card-header-top">' +
        '<div class="integration-card-title">' +
          '<span class="integration-type-badge">Web Push</span>' +
          '<strong>Browser &amp; mobile push</strong>' +
          (on ? '<span class="integration-status dot-ok">Enabled</span>'
              : '<span class="integration-status dot-unknown">Disabled</span>') +
        '</div>' +
        (canEdit
          ? '<div class="integration-card-actions">' +
            (on ? '<button class="btn btn-sm btn-secondary" id="wp-test" title="Send a test push to your own devices">Send test</button> ' : '') +
            '<label class="toggle-switch" title="' + (on ? 'Turn Web Push off' : 'Turn Web Push on') + '">' +
            '<input type="checkbox" id="wp-toggle"' + (on ? ' checked' : '') + '>' +
            '<span class="toggle-slider"></span></label></div>'
          : '') +
      '</div>' +
    '</div>' +
    '<div class="integration-card-details">' +
      '<div class="detail-row"><span class="detail-label">Devices</span><span class="detail-value">' + devices + '</span></div>' +
      '<div class="detail-row"><span class="detail-label">Recipients</span><span class="detail-value">' +
        'Chosen per automation — add a <strong>Notify</strong> action and pick who receives it' +
      '</span></div>' +
    '</div>' +
    // Inside the card, not after it: this container is display:contents inside
    // the tab's two-column card grid, so a sibling paragraph would claim a whole
    // grid cell of its own next to the first channel.
    (on && count === 0
      ? '<p style="font-size:0.8rem;color:var(--color-text-tertiary);margin:0.75rem 0 0">' +
        'Users enable push per device from the sidebar (desktop) or More → Push notifications (mobile). ' +
        'An automation targeting users who haven\'t enrolled delivers nothing.</p>'
      : '') +
  '</div>';

  var testBtn = document.getElementById("wp-test");
  if (testBtn) {
    testBtn.addEventListener("click", async function () {
      testBtn.disabled = true;
      var old = testBtn.textContent;
      testBtn.textContent = "Sending…";
      try {
        var r = await api.deliveryChannels.testWebPush();
        showToast(r.message || "Test sent", r.ok ? "success" : "error");
        // A dead subscription may have been pruned — refresh the count.
        if (r.pruned) loadWebPushCard();
      } catch (err) {
        showToast(err.message || "Test failed", "error");
      }
      testBtn.disabled = false;
      testBtn.textContent = old;
    });
  }

  var toggle = document.getElementById("wp-toggle");
  if (!toggle) return;
  toggle.addEventListener("change", async function () {
    var want = toggle.checked;
    toggle.disabled = true;
    try {
      var next = await api.deliveryChannels.setWebPush(want);
      showToast(want ? "Web Push enabled" : "Web Push disabled", want ? "success" : "info");
      renderWebPushCard(next);
      // The channel list and the wizard's channel picker both change shape.
      loadChannelsTab();
    } catch (err) {
      showToast(err.message || "Couldn't change Web Push", "error");
      toggle.checked = !want;
      toggle.disabled = false;
    }
  });
}

function _chanTypeMeta() { return (_ruleSchema && _ruleSchema.channelTypes) || {}; }
function channelTypeLabel(type) { var m = _chanTypeMeta()[type]; return (m && m.label) || type; }

// Short badge token per channel type for the card header.
var _CHANNEL_BADGE = { smtp: "SMTP", oauth_m365: "M365", pushbullet: "Pushbullet", slack: "Slack", teams: "Teams", web_push: "Web Push" };

// Detail rows for a channel card — schema-driven from the type's field defs.
// Non-secret values (host, tenant id, client id, from, send-as user, …) render
// directly; secret fields show configured/not-set rather than the value.
function channelDetailRows(c) {
  var defs = (_chanTypeMeta()[c.type] && _chanTypeMeta()[c.type].fields) || [];
  var cfg = (c.config && typeof c.config === "object") ? c.config : {};
  var rows = '<div class="detail-row"><span class="detail-label">Type</span><span class="detail-value">' + escapeHtml(channelTypeLabel(c.type)) + '</span></div>';
  defs.forEach(function (f) {
    var val;
    if (f.secret) {
      val = cfg[f.key + "Set"] ? '<span class="badge badge-active">configured</span>' : '<span style="color:var(--color-text-tertiary)">not set</span>';
    } else {
      var raw = cfg[f.key];
      if (raw === undefined || raw === null || String(raw) === "") return; // skip empty optional fields
      val = escapeHtml(String(raw));
    }
    rows += '<div class="detail-row"><span class="detail-label">' + escapeHtml(f.label) + '</span><span class="detail-value">' + val + '</span></div>';
  });
  if (c.type === "web_push") {
    rows += '<div class="detail-row"><span class="detail-label">VAPID keypair</span><span class="detail-value">' +
      (cfg.privateKeySet ? '<span class="badge badge-active">generated</span>' : '<span style="color:var(--color-danger)">not generated</span>') + '</span></div>';
  }
  return rows;
}

function renderChannelsList(allChannels) {
  var container = document.getElementById("channels-list");
  if (!container) return;
  var canEdit = permAtLeast("automationManagement", "write");
  // web_push is rendered by its own on/off card above, not as a configurable
  // destination. It still lives in _ruleChannels so the automation wizard can
  // select it as a Notify target.
  var channels = (allChannels || []).filter(function (c) { return c.type !== "web_push"; });
  if (!channels.length) {
    container.innerHTML = '<div class="empty-state-card"><p>No delivery channels configured.</p>' +
      (canEdit ? '<p style="color:var(--color-text-tertiary);font-size:0.85rem;margin-top:0.5rem">Click “+ Add channel” to add an SMTP / Microsoft 365 email, Pushbullet, Slack, or Microsoft Teams destination.</p>' : '') + '</div>';
    return;
  }
  container.innerHTML = channels.map(function (c) {
    var actions = canEdit
      ? '<button class="btn btn-sm btn-secondary ch-test" data-id="' + c.id + '">Test</button> ' +
        '<button class="btn btn-sm btn-secondary ch-edit" data-id="' + c.id + '">Edit</button> ' +
        '<button class="btn btn-sm btn-danger ch-del" data-id="' + c.id + '">Delete</button>'
      : '';
    var statusPill = c.enabled
      ? '<span class="integration-status dot-ok">Enabled</span>'
      : '<span class="integration-status dot-unknown">Disabled</span>';
    return '<div class="integration-card">' +
      '<div class="integration-card-header">' +
        '<div class="integration-card-header-top">' +
          '<div class="integration-card-title">' +
            '<span class="integration-type-badge">' + escapeHtml(_CHANNEL_BADGE[c.type] || c.type) + '</span>' +
            '<strong>' + escapeHtml(c.name) + '</strong>' +
            statusPill +
          '</div>' +
          (actions ? '<div class="integration-card-actions">' + actions + '</div>' : '') +
        '</div>' +
      '</div>' +
      '<div class="integration-card-details">' + channelDetailRows(c) + '</div>' +
    '</div>';
  }).join("");
  if (!canEdit) return;
  container.querySelectorAll(".ch-edit").forEach(function (b) { b.addEventListener("click", function () { openChannelModal(channels.find(function (x) { return x.id === b.dataset.id; })); }); });
  container.querySelectorAll(".ch-del").forEach(function (b) { b.addEventListener("click", function () { deleteChannel(channels.find(function (x) { return x.id === b.dataset.id; })); }); });
  container.querySelectorAll(".ch-test").forEach(function (b) { b.addEventListener("click", function () { testChannel(channels.find(function (x) { return x.id === b.dataset.id; }), b); }); });
}

async function deleteChannel(c) {
  if (!c) return;
  if (!(await showConfirm('Delete delivery channel "' + c.name + '"? Automations referencing it will stop delivering through it.'))) return;
  try { await api.deliveryChannels.delete(c.id); showToast("Channel deleted", "success"); loadChannelsTab(); }
  catch (err) { showToast(err.message || "Delete failed", "error"); }
}

async function testChannel(c, btn) {
  if (!c) return;
  var body = {};
  if (c.type === "smtp" || c.type === "oauth_m365") {
    var to = window.prompt("Send a test email to:", "");
    if (!to) return;
    body.to = to.trim();
  } else if (c.type === "web_push") {
    showToast("Test web push from a device that receives it — set Notifications to Push or Email and push in the account menu.", "info");
    return;
  }
  if (btn) btn.disabled = true;
  try { var r = await api.deliveryChannels.test(c.id, body); showToast(r.message || "Test sent", "success"); }
  catch (err) { showToast(err.message || "Test failed", "error"); }
  if (btn) btn.disabled = false;
}

// Short card subtitle per channel type for the add-channel type picker,
// mirroring the Add Integration type-picker cards. Falls back to the schema
// label when a type isn't listed here.
var _CHANNEL_TYPE_DESC = {
  smtp: "Email via an SMTP server",
  oauth_m365: "Email via Microsoft 365 (OAuth)",
  pushbullet: "Push notifications via Pushbullet",
  slack: "Post to a Slack channel",
  teams: "Post to a Microsoft Teams channel",
  web_push: "Browser & mobile push notifications",
};
// Clean card title per type (schema labels carry parenthetical detail that
// reads better as the subtitle).
var _CHANNEL_TYPE_TITLE = {
  smtp: "Email — SMTP",
  oauth_m365: "Microsoft 365",
  pushbullet: "Pushbullet",
  slack: "Slack",
  teams: "Microsoft Teams",
  web_push: "Web Push",
};

// Add-channel entry point: pick a type from card-style buttons (same look as
// the Add Integration picker), then open the channel form for that type.
function showChannelTypePicker() {
  var meta = _chanTypeMeta();
  // web_push is not offered here — it's a capability toggled on its own card,
  // with no destination to configure.
  var types = Object.keys(meta).filter(function (t) { return t !== "web_push"; });
  if (types.length === 0) { showToast("Channel schema not loaded", "error"); return; }
  var cards = types.map(function (t) {
    var title = _CHANNEL_TYPE_TITLE[t] || (meta[t] && meta[t].label) || t;
    var desc = _CHANNEL_TYPE_DESC[t] || (meta[t] && meta[t].label) || "";
    return '<button class="btn btn-secondary ch-pick" data-type="' + escapeHtml(t) + '" style="padding:1.2rem;font-size:0.95rem;display:flex;flex-direction:column;align-items:center;gap:6px;white-space:normal;text-align:center">' +
      '<strong>' + escapeHtml(title) + '</strong>' +
      '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">' + escapeHtml(desc) + '</span>' +
      '</button>';
  }).join("");
  var body =
    '<p style="font-size:0.9rem;color:var(--color-text-secondary);margin-bottom:1rem">Select the type of delivery channel to add:</p>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' + cards + '</div>';
  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>';
  openModal("Add delivery channel", body, footer, { wide: true });
  document.querySelectorAll(".ch-pick").forEach(function (b) {
    b.addEventListener("click", function () { closeModal(); openChannelModal(null, b.dataset.type); });
  });
}

// Add/edit a channel. `existing` = the masked channel row (edit) or null (add).
// `presetType` = the type chosen in the picker (add flow); when set, the type
// is fixed and shown read-only instead of a dropdown.
function openChannelModal(existing, presetType) {
  var meta = _chanTypeMeta();
  var types = Object.keys(meta);
  if (types.length === 0) { showToast("Channel schema not loaded", "error"); return; }
  var isEdit = !!existing;
  var cur = existing || {};
  var curConfig = (cur.config && typeof cur.config === "object") ? cur.config : {};
  var fixedType = isEdit ? cur.type : (presetType && meta[presetType] ? presetType : null);
  var initialType = fixedType || types[0];

  function fieldInput(f) {
    var id = "ch-field-" + f.key;
    var val = (curConfig[f.key] != null && f.kind !== "password") ? String(curConfig[f.key]) : "";
    var setFlag = curConfig[f.key + "Set"];
    if (f.kind === "select") {
      var opts = (f.options || []).map(function (o) { return '<option value="' + o + '"' + (o === val ? " selected" : "") + '>' + o + '</option>'; }).join("");
      return '<div class="form-group"><label>' + escapeHtml(f.label) + '</label><select id="' + id + '">' + opts + '</select></div>';
    }
    var inputType = f.kind === "password" ? "password" : (f.kind === "number" ? "number" : "text");
    var ph = f.placeholder || "";
    if (f.kind === "password" && isEdit && setFlag) ph = "(unchanged)";
    return '<div class="form-group"><label>' + escapeHtml(f.label) + '</label>' +
      '<input type="' + inputType + '" id="' + id + '" value="' + escapeHtml(f.kind === "password" ? "" : val) + '" placeholder="' + escapeHtml(ph) + '"' + (f.kind === "password" ? ' autocomplete="new-password"' : '') + '></div>';
  }

  function webPushExtra() {
    var pub = curConfig.publicKey ? String(curConfig.publicKey) : "";
    var keySet = !!curConfig.privateKeySet;
    return '<div class="form-group"><label>Public key</label><input type="text" id="ch-webpush-public" value="' + escapeHtml(pub) + '" readonly placeholder="(generated on save)"></div>' +
      '<p style="font-size:0.82rem;color:var(--color-text-tertiary)">Private key: ' + (keySet ? '<span style="color:var(--color-success)">set</span>' : '<span style="color:var(--color-danger)">not set</span>') +
      (isEdit ? ' — <button type="button" class="btn btn-sm btn-secondary" id="ch-gen-vapid">Regenerate keypair</button>' : ' — generated automatically when you save') + '</p>';
  }

  function fieldsFor(type) {
    var defs = (meta[type] && meta[type].fields) || [];
    var help = meta[type] && meta[type].help;
    var html = help ? '<p style="font-size:0.8rem;color:var(--color-text-tertiary);margin:0 0 0.6rem">' + escapeHtml(help) + '</p>' : "";
    html += defs.map(fieldInput).join("");
    if (type === "web_push") html += webPushExtra();
    return html;
  }

  var typeControl = fixedType
    ? '<div class="form-group"><label>Type</label><input type="text" value="' + escapeHtml(channelTypeLabel(fixedType)) + '" readonly></div>'
    : '<div class="form-group"><label>Type</label><select id="ch-type">' + types.map(function (t) { return '<option value="' + t + '">' + escapeHtml(meta[t].label || t) + '</option>'; }).join("") + '</select></div>';

  var body =
    '<div class="form-group"><label>Name</label><input type="text" id="ch-name" value="' + escapeHtml(cur.name || "") + '" placeholder="e.g. NOC Slack"></div>' +
    typeControl +
    '<div class="form-group"><label><input type="checkbox" id="ch-enabled"' + (cur.enabled === false ? "" : " checked") + '> Enabled</label></div>' +
    '<div id="ch-fields">' + fieldsFor(initialType) + '</div>';

  var footer =
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="ch-save">' + (isEdit ? "Save changes" : "Create channel") + '</button>';

  openModal(isEdit ? "Edit delivery channel" : "Add delivery channel", body, footer, { wide: true });

  var typeSel = document.getElementById("ch-type");
  function currentType() { return isEdit ? cur.type : (typeSel ? typeSel.value : initialType); }
  if (typeSel) typeSel.addEventListener("change", function () { document.getElementById("ch-fields").innerHTML = fieldsFor(typeSel.value); wireVapidBtn(); wireSmtpPortAutofill(); });

  // SMTP: selecting a security level auto-fills the conventional port
  // (none→25, starttls→587, ssl→465). The operator can still edit the port
  // afterward — we only set it on an explicit security change.
  function wireSmtpPortAutofill() {
    var sec = document.getElementById("ch-field-security");
    var port = document.getElementById("ch-field-port");
    if (!sec || !port || sec._portWired) return;
    sec._portWired = true;
    var PORTS = { none: 25, starttls: 587, ssl: 465 };
    sec.addEventListener("change", function () {
      var d = PORTS[sec.value];
      if (d) port.value = d;
    });
  }

  function wireVapidBtn() {
    var gb = document.getElementById("ch-gen-vapid");
    if (gb && !gb._wired) {
      gb._wired = true;
      gb.addEventListener("click", async function () {
        gb.disabled = true;
        try {
          var r = await api.deliveryChannels.generateVapid(cur.id);
          var pubEl = document.getElementById("ch-webpush-public");
          if (pubEl) pubEl.value = r.publicKey || "";
          showToast("New VAPID keypair generated", "success");
        } catch (err) { showToast(err.message || "Generate failed", "error"); }
        gb.disabled = false;
      });
    }
  }
  wireVapidBtn();
  wireSmtpPortAutofill();

  function collectConfig(type) {
    var defs = (meta[type] && meta[type].fields) || [];
    var config = {};
    defs.forEach(function (f) {
      var el = document.getElementById("ch-field-" + f.key);
      if (!el) return;
      var v = el.value;
      if (f.kind === "password" && v === "") return; // blank secret → server preserves
      if (f.kind === "number") { config[f.key] = parseInt(v, 10) || 0; return; }
      config[f.key] = v.trim();
    });
    return config;
  }

  document.getElementById("ch-save").addEventListener("click", async function () {
    var name = document.getElementById("ch-name").value.trim();
    if (!name) { showToast("Name is required", "error"); return; }
    var type = currentType();
    var payload = { name: name, type: type, enabled: document.getElementById("ch-enabled").checked, config: collectConfig(type) };
    this.disabled = true;
    try {
      if (isEdit) {
        await api.deliveryChannels.update(cur.id, payload);
      } else {
        var created = await api.deliveryChannels.create(payload);
        // A brand-new Web Push channel needs a keypair to send — mint one now.
        if (type === "web_push" && created && created.id) {
          try { await api.deliveryChannels.generateVapid(created.id); } catch (_e) { /* operator can regenerate later */ }
        }
      }
      closeModal();
      showToast(isEdit ? "Channel saved" : "Channel created", "success");
      loadChannelsTab();
    } catch (err) { this.disabled = false; showToast(err.message || "Save failed", "error"); }
  });
}

// ═══════════════════════════════ Scripts tab ═══════════════════════════════
// AutomationScript registry — the scripts `script` actions reference. Gated
// automationScripts (read = view; fullwrite = CUD + test-run). RCE-equivalent
// surface: every card + modal carries the human-review reminder, and the
// server audits creation/body changes with sha256 checksums.

var _awScriptList = null;

async function loadScriptsTab() {
  var container = document.getElementById("scripts-list");
  if (!container) return;
  if (!_ruleSchema) { try { _ruleSchema = await api.automations.schema(); } catch (_e) {} }
  container.innerHTML = '<p class="empty-state">Loading…</p>';
  try {
    var resp = await api.automationScripts.list();
    _awScriptList = (resp && resp.scripts) || [];
    _awScripts = _awScriptList; // keep the wizard's picker cache in sync
    renderScriptsList(_awScriptList);
  } catch (err) {
    container.innerHTML = '<p class="empty-state">Error: ' + escapeHtml(err.message || "load failed") + '</p>';
  }
}

function renderScriptsList(scripts) {
  var container = document.getElementById("scripts-list");
  if (!container) return;
  var canEdit = permAtLeast("automationScripts", "write");
  if (!scripts.length) {
    container.innerHTML = '<p class="empty-state">No scripts yet' + (canEdit ? ' — click "+ Add script" to create one.' : "") + '</p>';
    return;
  }
  container.innerHTML = scripts.map(function (sc) {
    var runTargetLabel = sc.runTarget === "either" ? "server or agent" : sc.runTarget;
    var actions = canEdit
      ? '<button class="btn btn-sm btn-secondary script-test" data-id="' + sc.id + '">Test run</button> ' +
        '<button class="btn btn-sm btn-secondary script-edit" data-id="' + sc.id + '">Edit</button> ' +
        '<button class="btn btn-sm btn-danger script-del" data-id="' + sc.id + '">Delete</button>'
      : "";
    return '<div class="card" style="margin-bottom:0.75rem;padding:0.9rem">' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
        '<strong>' + escapeHtml(sc.name) + '</strong>' +
        '<span class="badge">' + escapeHtml(sc.interpreter) + '</span>' +
        '<span class="badge">runs on ' + escapeHtml(runTargetLabel) + '</span>' +
        (sc.enabled ? "" : '<span class="badge" style="opacity:0.7">disabled</span>') +
        '<span style="margin-left:auto">' + actions + '</span>' +
      '</div>' +
      (sc.description ? '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin:6px 0 0">' + escapeHtml(sc.description) + '</p>' : "") +
      '<p style="font-size:0.75rem;color:var(--color-text-tertiary);margin:6px 0 0;font-family:var(--font-mono)">timeout ' + sc.timeoutSec + 's · sha256 ' + escapeHtml((sc.sha256 || "").slice(0, 12)) + '…</p>' +
      '<div class="script-test-out" data-id="' + sc.id + '"></div>' +
    '</div>';
  }).join("");

  container.querySelectorAll(".script-edit").forEach(function (b) {
    b.addEventListener("click", function () {
      var sc = _awScriptList.find(function (x) { return x.id === b.dataset.id; });
      if (sc) openScriptModal(sc);
    });
  });
  container.querySelectorAll(".script-del").forEach(function (b) {
    b.addEventListener("click", async function () {
      var sc = _awScriptList.find(function (x) { return x.id === b.dataset.id; });
      if (!sc) return;
      if (!(await showConfirm('Delete script "' + sc.name + '"? Automations referencing it must drop their script actions first (the server refuses otherwise).'))) return;
      try { await api.automationScripts.delete(sc.id); showToast("Script deleted", "success"); loadScriptsTab(); }
      catch (err) { showToast(err.message || "Delete failed", "error"); }
    });
  });
  container.querySelectorAll(".script-test").forEach(function (b) {
    b.addEventListener("click", function () {
      var sc = _awScriptList.find(function (x) { return x.id === b.dataset.id; });
      if (sc) runScriptTest(sc, b);
    });
  });
}

// Server-side test run: enqueue (202 + runId), then poll the run until it
// completes (the 5s runner job executes it) and render exit code + output.
async function runScriptTest(sc, btn) {
  var out = document.querySelector('.script-test-out[data-id="' + sc.id + '"]');
  if (sc.runTarget === "agent") { showToast("Agent-only scripts can't be test-run from here — trigger them through an automation on a real asset.", "info"); return; }
  if (!(await showConfirm('Run "' + sc.name + '" on the Polaris server NOW (as the service account)?'))) return;
  btn.disabled = true;
  if (out) out.innerHTML = '<p style="font-size:0.8rem;color:var(--color-text-tertiary);margin:6px 0 0">Queued…</p>';
  try {
    var res = await api.automationScripts.testRun(sc.id, {});
    var runId = res.runId;
    var tries = 0;
    var poll = async function () {
      tries++;
      var rr;
      try { rr = await api.automationScripts.run(runId); }
      catch (_e) { rr = null; }
      var run = rr && rr.run;
      if (run && (run.status === "succeeded" || run.status === "failed" || run.status === "timeout")) {
        var color = run.status === "succeeded" ? "var(--color-success)" : "var(--color-danger)";
        if (out) out.innerHTML =
          '<div style="border:1px solid var(--color-border);border-radius:6px;padding:0.5rem;margin-top:6px">' +
            '<p style="font-size:0.8rem;margin:0"><strong style="color:' + color + '">' + escapeHtml(run.status) + '</strong> (exit ' + (run.exitCode != null ? run.exitCode : "n/a") + ')</p>' +
            (run.stdout ? '<pre style="white-space:pre-wrap;font-size:0.75rem;max-height:160px;overflow:auto;margin:4px 0 0">' + escapeHtml(run.stdout) + '</pre>' : "") +
            (run.stderr ? '<pre style="white-space:pre-wrap;font-size:0.75rem;max-height:120px;overflow:auto;margin:4px 0 0;color:var(--color-danger)">' + escapeHtml(run.stderr) + '</pre>' : "") +
          '</div>';
        btn.disabled = false;
        return;
      }
      if (tries > 60) { if (out) out.innerHTML = '<p style="font-size:0.8rem;color:var(--color-danger);margin:6px 0 0">Timed out waiting for the run to complete.</p>'; btn.disabled = false; return; }
      setTimeout(poll, 2000);
    };
    setTimeout(poll, 2000);
  } catch (err) {
    if (out) out.innerHTML = "";
    btn.disabled = false;
    showToast(err.message || "Test run failed", "error");
  }
}

function openScriptModal(existing) {
  var s = _ruleSchema || {};
  var meta = s.scriptMeta || { languages: ["bash", "sh", "powershell", "cmd", "python3"], runOnOptions: ["server", "agent"], maxTimeoutSec: 600 };
  var sc = existing || {};
  function optList(list, sel) {
    return (list || []).map(function (v) { return '<option value="' + escapeHtml(v) + '"' + (v === sel ? " selected" : "") + '>' + escapeHtml(v) + '</option>'; }).join("");
  }
  var body =
    '<div class="form-group"><label>Name</label><input type="text" id="script-name" value="' + escapeHtml(sc.name || "") + '" placeholder="e.g. restart-print-spooler"></div>' +
    '<div class="form-group"><label>Description (optional)</label><input type="text" id="script-desc" value="' + escapeHtml(sc.description || "") + '"></div>' +
    '<div class="form-group"><label>Interpreter</label><select id="script-interp">' + optList(meta.languages, sc.interpreter || "bash") + '</select></div>' +
    '<div class="form-group"><label>Runs on</label><select id="script-target">' +
      '<option value="server"' + ((sc.runTarget || "server") === "server" ? " selected" : "") + '>the Polaris server</option>' +
      '<option value="agent"' + (sc.runTarget === "agent" ? " selected" : "") + '>the triggering asset’s agent</option>' +
      '<option value="either"' + (sc.runTarget === "either" ? " selected" : "") + '>either</option>' +
    '</select></div>' +
    '<div class="form-group"><label>Script body</label><textarea id="script-body" rows="12" style="width:100%;font-family:var(--font-mono);font-size:0.82rem" spellcheck="false">' + escapeHtml(sc.body || "") + '</textarea>' +
      '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:4px 0 0">Arguments arrive as one positional parameter ($1 / %1); alert context rides POLARIS_ALERT_ID / POLARIS_RULE / POLARIS_ASSET environment variables.</p></div>' +
    '<div class="form-group"><label>Default timeout (seconds, 1–' + (meta.maxTimeoutSec || 600) + ')</label><input type="number" id="script-timeout" min="1" max="' + (meta.maxTimeoutSec || 600) + '" value="' + (sc.timeoutSec || 60) + '"></div>' +
    '<div class="form-group"><label><input type="checkbox" id="script-enabled"' + (sc.enabled === false ? "" : " checked") + '> Enabled</label></div>' +
    '<p style="font-size:0.8rem;color:var(--color-warning,#d97706);margin:0">' + escapeHtml(meta.help || "Scripts execute with full privileges — a human must review every script before enabling it in production.") + '</p>';
  var footer =
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="script-save">' + (existing ? "Save changes" : "Create script") + '</button>';
  openModal(existing ? "Edit script" : "New script", body, footer, { wide: true });

  document.getElementById("script-save").addEventListener("click", async function () {
    var payload = {
      name: document.getElementById("script-name").value.trim(),
      description: document.getElementById("script-desc").value.trim() || null,
      interpreter: document.getElementById("script-interp").value,
      runTarget: document.getElementById("script-target").value,
      body: document.getElementById("script-body").value,
      timeoutSec: Number(document.getElementById("script-timeout").value) || 60,
      enabled: document.getElementById("script-enabled").checked,
    };
    if (!payload.name) { showToast("Name is required.", "error"); return; }
    if (!payload.body.trim()) { showToast("Script body is required.", "error"); return; }
    this.disabled = true;
    try {
      if (existing) await api.automationScripts.update(existing.id, payload);
      else await api.automationScripts.create(payload);
      closeModal();
      showToast(existing ? "Script saved" : "Script created", "success");
      loadScriptsTab();
    } catch (err) { this.disabled = false; showToast(err.message || "Save failed", "error"); }
  });
}
