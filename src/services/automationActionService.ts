/**
 * src/services/automationActionService.ts
 *
 * The single fan-out point between a fired alert (Notification row) and its
 * automation's `actions[]` — called by the engine on fire (threshold + event
 * tail) and, in the escalation-v2 phase, by the escalation sweep per due tier.
 *
 * Per action type:
 *   notify   → the existing recipient/delivery pipeline: the action converts
 *              to a DeliveryTarget and expandDeliveries creates the rows; the
 *              composed email is the ACTION's emailComposition, falling back
 *              to the rule-level one (byte-identical to the legacy path for
 *              converted rules, where the conversion copied the rule-level
 *              composition onto every action).
 *   api_call → ONE NotificationDelivery row, transport "api_call",
 *              channelId NULL (there is no channel — the destination lives on
 *              the action). meta carries {method, url, headers, body, timeoutSec}
 *              with the body rendered from the fire-time template context.
 *              The deliverNotifications drain dispatches it with retries.
 *              SECURITY: headers were typed by the operator and are stored
 *              unmasked — save-time docs/catalog warn against secrets; the
 *              URL was SSRF-checked at save and is re-checked at send.
 *   script   → an AutomationScriptRun row via requestScriptRun — NEVER
 *              executed inline here: the runAutomationScripts job claims and
 *              executes server runs; agent runs ride the AgentCommand queue
 *              (agent phase). Args render at fire time and travel as a single
 *              argv entry. Disabled/missing scripts (and, until the agent
 *              phase, runOn="agent") throw → failed-action warning Event.
 *
 * Execution is best-effort PER ACTION: one bad action never blocks the
 * others; each failure writes an `automation.action_error` warning Event.
 */

import { prisma } from "../db.js";
import { logEvent } from "./eventLogService.js";
import { renderNotificationTemplate,
  followUpLine,
} from "../utils/notificationTemplate.js";
import {
  expandDeliveries,
  buildComposedEmail,
  type ComposedEmail,
} from "./notificationRecipientService.js";
import { requestScriptRun } from "./automationScriptService.js";
import { resolveContactEmailsForAsset } from "./contactService.js";
import { logger } from "../utils/logger.js";
import {
  actionsToTargets,
  notifyChannelIds,
  CHANNEL_TRANSPORT,
  type ChannelType,
  type AutomationAction,
  type ApiCallAction,
  type EmailComposition,
} from "./notificationTypes.js";

export interface ActionExecContext {
  /** region: tags from the rule's scope (recipientScopeRegion routing). */
  scopeRegionTags?: string[];
  /** The TRIGGERING asset's region tags — stripped snapshot (regionSnapshot /
   *  Notification.regionTags) — for recipientDeviceRegion routing. */
  assetRegionTags?: string[];
  /** The triggering asset, when the alert has one (script actions target it). */
  assetId?: string | null;
  ruleId?: string;
  ruleName?: string;
  /** Rule-level emailComposition — the per-action fallback for notify actions. */
  ruleEmailComposition?: EmailComposition | null;
  /** Set by the escalation sweep: stamps delivery meta + audit details. */
  escalation?: { tier: number; attempt: number };
  /** Set by the sweep's REPEAT pass: this is a RE-SEND of the initial
   *  notification, not an escalation tier. Mutually exclusive with
   *  `escalation` — a reminder must never be labelled an escalation, since the
   *  two mean different things to whoever is reading the alert.
   *
   *  `elapsed` is how long the alert has been active ("9h 12m"), and
   *  `quietResumed` marks the reminder that ends a quiet-time hold (business
   *  rule 44). Together they put the age in the SUBJECT, which is the only
   *  part of the email an operator reads in a full inbox after a silent
   *  night. */
  repeat?: { attempt: number; elapsed?: string; quietResumed?: boolean };
  /** Audit actor; defaults to "system:automation". */
  actor?: string;
}

/**
 * Fan a fired alert's actions out to their execution paths. Never throws for
 * a single action's failure — failures are recorded as warning Events and the
 * remaining actions still run. Returns per-action counts: `executed` = actions
 * that produced at least one delivery row / script run (the escalation sweep
 * uses this to decide whether a tier counts as sent).
 */
export async function executeActions(
  notificationId: string,
  actions: AutomationAction[],
  ctx: Record<string, string>,
  exec: ActionExecContext,
): Promise<{ executed: number; failed: number }> {
  let executed = 0;
  let failed = 0;

  // Address-book contacts owning the triggering asset. Resolved AT MOST ONCE
  // per fire and only when an action actually asks for them — several notify
  // actions on one rule share the answer, and a rule that never opts in pays
  // nothing. Resolution lives here rather than in expandDeliveries because
  // contactService imports notificationRecipientService (listRecipientUsers),
  // so the expander reaching back for contacts would close an import cycle.
  let contactEmails: string[] | undefined;
  const assetContactEmails = async (): Promise<string[]> => {
    if (contactEmails) return contactEmails;
    if (!exec.assetId) return (contactEmails = []);
    try {
      contactEmails = await resolveContactEmailsForAsset(exec.assetId);
    } catch (err) {
      // A failed contact lookup must not lose the rest of the recipients.
      logger.warn({ err, assetId: exec.assetId }, "Failed to resolve asset contacts for notify action");
      contactEmails = [];
    }
    return contactEmails;
  };

  // Does THIS action group offer both an email and a push channel? Business
  // rule 39's whole gate: a `respectUserPreference` action may only drop
  // recipients when the method they'd fall through to is actually on offer.
  // Resolved AT MOST ONCE per group and only when some action asked — the same
  // posture as assetContactEmails above, so a group that never opts in costs
  // nothing and issues no extra query.
  let _bothMethods: boolean | null = null;
  const groupOffersBothMethods = async (): Promise<boolean> => {
    if (_bothMethods !== null) return _bothMethods;
    return (_bothMethods = await actionsCarryBothMethods(actions));
  };

  for (const [index, action] of actions.entries()) {
    try {
      if (action.type === "notify") {
        const composed = composeForNotify(action.emailComposition ?? null, exec, ctx);
        const rows = await expandDeliveries(notificationId, actionsToTargets([action]), {
          scopeRegionTags: exec.scopeRegionTags,
          assetRegionTags: exec.assetRegionTags,
          ...(action.recipientAssetContacts ? { assetContactEmails: await assetContactEmails() } : {}),
          composedEmail: composed,
          // Push has no facts table to prune, so the two policy sentences
          // are joined into one line and appended to the body. Both are ""
          // on an automation that neither repeats nor escalates, and the
          // whole option then stays undefined — a one-shot alert's push is
          // byte-identical to what it was.
          ...(followUpLine(ctx) ? { followUp: followUpLine(ctx) } : {}),
          escalation: exec.escalation,
          repeat: exec.repeat,
          ...(action.respectUserPreference ? { enforceUserPreference: await groupOffersBothMethods() } : {}),
        });
        if (rows > 0) executed++;
      } else if (action.type === "api_call") {
        await enqueueApiCall(notificationId, action, ctx, exec);
        executed++;
      } else if (action.type === "event") {
        // No-op HERE. The audit Event is written by the engine's fire path
        // (which owns the severity + resourceId), not by the action executor;
        // this action's presence is what gates it. Counting it as executed
        // would also mislead the escalation sweep, which reads `executed` to
        // decide whether a tier actually delivered anything.
      } else {
        // script — enqueue an AutomationScriptRun; the runAutomationScripts
        // job (server) or the agent command queue (agent) executes it. Args
        // render NOW from the fire-time context (single argv, never shell-
        // interpolated by the runner). requestScriptRun throws on disabled/
        // missing scripts and (until the agent phase) on runOn="agent" —
        // recorded as a failed action Event by the catch below.
        const args = action.argsTemplate && action.argsTemplate.trim()
          ? renderNotificationTemplate(action.argsTemplate, ctx)
          : null;
        await requestScriptRun({
          scriptId: action.scriptId,
          runOn: action.runOn,
          args,
          timeoutSec: action.timeoutSec ?? null,
          notificationId,
          ruleId: exec.ruleId ?? null,
          assetId: exec.assetId ?? null,
          requestedBy: exec.actor ?? "system:automation",
        });
        executed++;
      }
    } catch (err) {
      failed++;
      await logEvent({
        action: "automation.action_error",
        resourceType: "notification",
        resourceId: notificationId,
        resourceName: exec.ruleName,
        actor: exec.actor ?? "system:automation",
        level: "warning",
        message: `Automation action ${index + 1} (${action.type}) failed: ${(err as Error)?.message}`,
        details: {
          actionIndex: index,
          actionType: action.type,
          ruleId: exec.ruleId ?? null,
          assetId: exec.assetId ?? null,
          ...(exec.escalation ? { escalation: exec.escalation } : {}),
          err: (err as Error)?.message,
        },
      }).catch(() => {});
    }
  }
  return { executed, failed };
}

/**
 * Do the notify actions in ONE action group reach recipients by BOTH email and
 * web push?
 *
 * The group is the `actions[]` list being executed — the rule's own actions, a
 * severity band's, the reset list, or one escalation tier's — which is exactly
 * the unit the wizard grays the preference checkbox on. A MULTI-CHANNEL action
 * counts on its own: one action carrying an SMTP channel and a Web Push
 * channel offers both methods by itself, which is the shape the checkbox was
 * really added for.
 *
 * Chat and Pushbullet channels are ignored — they post to one fixed
 * destination and have no per-user recipients, so they can neither satisfy a
 * preference nor be excluded by one.
 *
 * Exported for the tests: a wrong answer here is silent in the worst
 * direction — a false positive drops every push-preferring recipient from an
 * email-only alert, and nothing anywhere reports the omission.
 */
export async function actionsCarryBothMethods(actions: AutomationAction[]): Promise<boolean> {
  const ids = Array.from(
    new Set(actions.flatMap((a) => (a.type === "notify" ? notifyChannelIds(a) : []))),
  );
  if (ids.length < 2) return false; // one channel cannot be two methods
  const channels = await prisma.notificationChannel.findMany({
    where: { id: { in: ids } },
    select: { type: true },
  });
  const methods = new Set(
    channels
      .map((ch) => CHANNEL_TRANSPORT[ch.type as ChannelType])
      .filter((t) => t === "email" || t === "web_push"),
  );
  return methods.size >= 2;
}

/**
 * Compose the outbound email for a notify action. Normal fires: the ACTION's
 * composition wins wholesale, falling back to the rule-level one, and no
 * composition at all means the legacy per-address fan-out (undefined).
 * ESCALATION fires reproduce the legacy tier semantics exactly:
 *   - PER-FIELD merge — tier subject ?? rule subject, tier body ?? rule body
 *     (a tier that only overrode the subject still renders the rule's body),
 *   - cc/bcc come from the tier action only (never the rule composition),
 *   - ALWAYS composed (one To+Cc+Bcc email per action, even with no
 *     composition anywhere → default subject/body),
 *   - the default "[ESCALATION n]" subject prefix when neither level set a
 *     subject template.
 */
function composeForNotify(
  actionComp: EmailComposition | null,
  exec: ActionExecContext,
  ctx: Record<string, string>,
): ComposedEmail | undefined {
  // A REPEAT is a re-send of the initial email, not a tier override, so it
  // takes the normal-fire composition path (the action's composition wholesale,
  // falling back to the rule's) rather than escalation's per-field tier→rule
  // merge. The only difference from a first send is the subject prefix, and
  // that mirrors "[ESCALATION n]" exactly: applied ONLY when nobody set a
  // subject template, so an operator who wrote their own keeps it verbatim and
  // can use the {repeat.attempt} token instead.
  if (exec.repeat && !exec.escalation) {
    const comp = actionComp ?? exec.ruleEmailComposition ?? {};
    const composed = buildComposedEmail(comp, ctx);
    if (!comp.subjectTemplate || !comp.subjectTemplate.trim()) {
      // The reminder that ends a quiet-time hold carries the alert's AGE in
      // the subject as well as the body (business rule 44): it lands in an
      // inbox beside a night's worth of other mail, and "[REMINDER 4]" alone
      // does not distinguish an alert twenty minutes old from one that has
      // been burning since 22:00. Only on that reminder — putting the age on
      // every one of them would make the marker mean nothing.
      const age = exec.repeat.quietResumed && exec.repeat.elapsed ? ` · ACTIVE ${exec.repeat.elapsed}` : "";
      composed.subject = `[REMINDER ${exec.repeat.attempt}${age}] ${composed.subject}`;
    }
    return composed;
  }
  if (!exec.escalation) {
    // ALWAYS compose. Before the rich default body this returned undefined
    // when nobody had customized anything, dropping those alerts onto the
    // legacy "message + View:" path — which is exactly the sparse email this
    // replaced. buildComposedEmail fills each blank piece from the shared
    // default template, so an automation with no composition gets the same
    // body as one that customized only the subject.
    const comp = actionComp ?? exec.ruleEmailComposition ?? {};
    return buildComposedEmail(comp, ctx);
  }
  const rule = exec.ruleEmailComposition;
  const merged: EmailComposition = {
    subjectTemplate: actionComp?.subjectTemplate ?? rule?.subjectTemplate ?? null,
    bodyTextTemplate: actionComp?.bodyTextTemplate ?? rule?.bodyTextTemplate ?? null,
    bodyHtmlTemplate: actionComp?.bodyHtmlTemplate ?? rule?.bodyHtmlTemplate ?? null,
    cc: actionComp?.cc ?? null,
    bcc: actionComp?.bcc ?? null,
  };
  const composed = buildComposedEmail(merged, ctx);
  if (!merged.subjectTemplate || !merged.subjectTemplate.trim()) {
    composed.subject = `[ESCALATION ${exec.escalation.tier}] ${composed.subject}`;
  }
  return composed;
}

/**
 * Queue an api_call action as a NotificationDelivery row (transport
 * "api_call", channelId NULL — no channel involved; the drain gives us the
 * retry/attempts/status machinery for free). The body template renders NOW,
 * from the fire-time context, so the drain never needs the rule.
 */
async function enqueueApiCall(
  notificationId: string,
  action: ApiCallAction,
  ctx: Record<string, string>,
  exec: ActionExecContext,
): Promise<void> {
  const body = action.bodyTemplate && action.bodyTemplate.trim()
    ? renderNotificationTemplate(action.bodyTemplate, ctx)
    : undefined;
  await prisma.notificationDelivery.create({
    data: {
      notificationId,
      channelId: null,
      transport: "api_call",
      target: action.url,
      meta: {
        apiCall: true,
        method: action.method,
        url: action.url,
        ...(action.headers && Object.keys(action.headers).length > 0 ? { headers: action.headers } : {}),
        ...(body !== undefined ? { body } : {}),
        timeoutSec: action.timeoutSec,
        ...(exec.escalation ? { escalation: exec.escalation } : {}),
      },
    },
  });
}
