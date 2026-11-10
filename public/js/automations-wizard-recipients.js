/**
 * public/js/automations-wizard-recipients.js — the recipient roll-up — WHO an automation notifies and from
 * where (ruleRecipientGroups, recipientDisplayLabels, normalizeEscalationV2),
 * behind the Automations list's Addresses column; window.PolarisAutomationRecipients.
 *
 * Part of the automation wizard (CQ-F051): plain browser scripts sharing page
 * globals, loaded right after automations-wizard.js on every page that
 * carries it and in app-panels.js's asset bundle, in WIZARD_FILES order.
 * Pure — no wizard state. See tests/unit/automationsWizardSplit.test.ts.
 */

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
  (rule.resetActions || []).forEach(function (a) {
    addNotify(a, "When it clears", false);
    // Escalation-reset overrides (business rule 145) reach their own people.
    // A tier WITHOUT an override resets through its own Notify actions, whose
    // recipients are already listed under the escalation above.
    var custom = (a && a.resetEscalation && a.resetEscalation.custom) || {};
    Object.keys(custom).forEach(function (k) {
      (custom[k] || []).forEach(function (x) { addNotify(x, "When it clears — escalation tier " + (Number(String(k).split(":").pop()) + 1), false); });
    });
  });
  return groups;
}

if (typeof window !== "undefined") {
  window.PolarisAutomationRecipients = {
    // Called through, not captured: the two live in recipient-picker.js, and
    // capturing them here made this file throw at load wherever it was
    // evaluated without that one (a few vm tests do exactly that).
    pillsToRecipients: function (p) { return pillsToRecipients(p); },
    recipientsToPills: function (r, u, ro, m) { return recipientsToPills(r, u, ro, m); },
    recipientDisplayLabels: recipientDisplayLabels,
    ruleRecipientGroups: ruleRecipientGroups,
    normalizeEscalationV2: normalizeEscalationV2,
  };
}
