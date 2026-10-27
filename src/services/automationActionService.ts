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
 *              SECURITY: headers are secrets — sealed at rest on the rule,
 *              the group and this delivery row, masked in API responses
 *              (business rule 114(h)); the URL was SSRF-checked at save and is
 *              re-checked at send.
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

import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { logEvent } from "./eventLogService.js";
import { renderNotificationTemplate, templateIsJson,
  followUpLine,
} from "../utils/notificationTemplate.js";
import {
  expandDeliveries,
  resolveRebootActionRecipients,
  buildComposedEmail,
  type ComposedEmail,
} from "./notificationRecipientService.js";
import { requestScriptRun } from "./automationScriptService.js";
import { resolveContactEmailsForAsset } from "./contactService.js";
import { resolveQuietHold, resolveQuietWindow, type QuietHold, type QuietSource } from "./quietTimeHoldService.js";
import { formatLocalIsoMinute } from "../utils/maintenanceRecurrence.js";
import { isOperatorSubject } from "../utils/alertEmailTemplate.js";
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
  /** Set by the engine when a GROUPED alert (business rule 75) gained a
   *  contribution after it was already up: this send updates a live alert
   *  rather than opening one. Mutually exclusive with the two above for the
   *  same reason they are with each other — "another port faulted" is neither
   *  a reminder nor an escalation tier, and a reader who cannot tell the three
   *  apart cannot tell whether the situation is spreading or merely ageing.
   *
   *  `count` is the number of contributions the alert now names, which is what
   *  makes the subject worth reading in a full inbox. */
  /** `change`: what joined or came back, for the subject ("port7 back"). */
  growth?: { count: number; change?: string };
  /** Set by the escalation sweep on a reminder or tier inside a quiet window
   *  whose policy carries recipient exceptions (business rule 120): the pass
   *  goes out live to the excepted readers and is written held for the rest,
   *  who get it when the window ends (`releaseHeldFollowUps`). */
  quietHold?: QuietHold;
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

  // THE SEND. One id per fan-out, stamped onto every delivery row this call
  // creates, so the email footer can name the audience of THIS message instead
  // of everyone the alert has ever reached (see ExpandDeliveriesOptions.
  // dispatchId, and buildRecipientBlocks, which is its only reader).
  //
  // Minted per CALL rather than per action, because the call IS the send: the
  // engine fires a rule's whole action list in one of these, so the email
  // action's footer can still say the on-call's phone buzzed — while the
  // sweep's repeat pass runs one action per call, which is what keeps a
  // reminder from naming an escalation tier's people.
  const dispatchId = randomUUID();

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
  // Is this group an ALL-CLEAR — the reset actions, or a severity band's
  // resolved actions — rather than a fire?
  //
  // `severity` is the signal because it already IS one: "resolved" is a
  // pseudo-severity (never in SEVERITIES, so no rule can carry it) that the
  // three all-clear paths — fireResolved, fireReset and the operator-clear
  // path in notificationService — stamp into the context precisely to colour
  // the email green and read right in a subject line. Reading it here means a
  // fourth all-clear path gets the behaviour by writing the same line it
  // already has to write, instead of by remembering a second flag.
  //
  // What it buys: no Acknowledge button on an email announcing the alert is
  // over, and no Acknowledge tray action on the matching push (business rule
  // 25). Both used to lead to `/alert-ack.html` telling the reader the alert
  // already cleared and there is nothing to acknowledge — and on a rule with
  // `requireAckNote`, to a 400 demanding a note about it first.
  const allClear = ctx["severity"] === "resolved";

  // ── Quiet time (business rule 92) ──────────────────────────────────────────
  // Decided HERE, not in the engine, because this is the one function every
  // people-facing send passes through: the engine's fire and growth paths,
  // the event tail (which never builds a Reading) and the three all-clear
  // paths all arrive here with a notification id. The sweep's tiers and
  // reminders arrive here too, but it has already gated them (`exec.escalation`
  // / `exec.repeat`), so they are left alone.
  //
  // Two answers come out of one read of the alert row:
  //   - a FIRE (or growth update) inside a quiet window is HELD: its notify
  //     actions still resolve their recipients, but the rows are written
  //     `held` (see ExpandDeliveriesOptions.hold) and the alert is stamped with
  //     who held it; scripts, API calls and the audit Event run as usual.
  //   - an ALL-CLEAR for an alert whose fire was held and never summarised is
  //     DROPPED on the notify side: nobody was told it started, so there is
  //     no inbox in which "resolved" means anything. Once a summary has named
  //     it, its all-clear goes out like any other.
  // A test delivery is never held: it exists to show the operator what the
  // email looks like, and "held for quiet time" would show them nothing.
  let hold: QuietHold | null = null;
  let dropPeopleFacing = false;
  let stampHold = false;
  // A fire NOT held while a quiet window is open for it — a severity the
  // policy lets through. It is stamped with the window's source (quietSource,
  // no quietHeldAt) so the summary can list it to the readers it reached
  // (business rule 92(f)).
  let liveSource: QuietSource | null = null;
  // Only a fire that would actually TELL someone can be held. An automation
  // with no notify action — an event trigger that only writes the audit
  // Event, or only runs a script — has no people-facing send for quiet time
  // to withhold, so it is never stamped and never appears in a summary: a
  // summary of "alerts nobody was told about" must not list alerts nobody was
  // ever going to be told about. (The operator's firmware event automation,
  // 2026-10-05.)
  const peopleFacing = actions.some((a) => a.type === "notify");
  if (!exec.escalation && !exec.repeat && peopleFacing) {
    // Fails toward "deliver" (no hold, no drop), logged: the same posture the
    // hold service takes for its own reads — a read error here must never
    // cost an alert its audience.
    const row = await (async () => {
      try {
        return await prisma.notification.findUnique({
          where: { id: notificationId },
          select: { ruleId: true, assetId: true, metric: true, severity: true, testRun: true, quietHeldAt: true, quietSummarizedAt: true, quietSource: true },
        });
      } catch (err) {
        logger.warn({ err: (err as Error)?.message, notificationId }, "quiet-time check could not read the alert — delivering as usual");
        return null;
      }
    })();
    if (row && !row.testRun) {
      if (allClear) {
        dropPeopleFacing = !!row.quietHeldAt && !row.quietSummarizedAt;
      } else {
        const question = {
          ruleId: row.ruleId ?? exec.ruleId,
          severity: ctx["severity"] || row.severity,
          metric: row.metric,
          assetId: row.assetId,
        };
        hold = await resolveQuietHold(question);
        stampHold = !!hold && !row.quietHeldAt;
        if (!hold && !row.quietHeldAt && row.quietSource == null) {
          liveSource = await resolveQuietWindow(question).catch((err) => {
            logger.warn({ err: (err as Error)?.message, notificationId }, "quiet-time window lookup failed — the live alert will not be in the summary");
            return null;
          });
        }
      }
    }
  }
  // Recipient exceptions (business rule 120): the fire may have reached some
  // readers live while it was held for the rest. Then the all-clear is not
  // dropped — it goes to everyone who was told, and skips only the readers
  // the fire was held for and who have heard nothing since.
  let excludeRecipients: { addresses: Set<string>; userIds: Set<string>; chat: boolean } | undefined;
  if (dropPeopleFacing) {
    const split = await heldFireAudience(notificationId).catch((err) => {
      logger.warn({ err: (err as Error)?.message, notificationId }, "quiet-time all-clear split could not read the deliveries — dropping as before");
      return null;
    });
    if (split) { excludeRecipients = split; dropPeopleFacing = false; }
  }
  if (dropPeopleFacing) {
    await logEvent({
      action: "notification.quiet_allclear_dropped",
      resourceType: "notification",
      resourceId: notificationId,
      resourceName: exec.ruleName,
      actor: exec.actor ?? "system:automation",
      level: "info",
      message: "All-clear not sent: the alert was held for quiet time and nobody had been told about it yet",
      details: { ruleId: exec.ruleId ?? null, assetId: exec.assetId ?? null },
    }).catch(() => {});
  }
  // With recipient exceptions the stamp waits until the fan-out has said
  // whether ANYONE was actually held: an alert that went out live to every
  // one of its readers owes no summary and must not be stamped as held.
  const deferStamp = !!hold?.split;
  const holdStats = { live: 0, held: 0 };
  const stampHeld = async (h: QuietHold): Promise<void> => {
    await prisma.notification.update({
      where: { id: notificationId },
      // The NAME rides along so a summary for a since-deleted schedule can
      // still say which one held the alert.
      data: { quietHeldAt: new Date(), quietSource: { kind: h.source.kind, id: h.source.id, name: h.source.name } },
    });
    await logEvent({
      action: "notification.quiet_held",
      resourceType: "notification",
      resourceId: notificationId,
      resourceName: exec.ruleName,
      actor: exec.actor ?? "system:automation",
      level: "info",
      message:
        `Held for quiet time (${h.source.kind === "global" ? "global quiet time" : "automation quiet time"} "${h.source.name}") — ` +
        `a summary of outstanding alerts goes out after ${formatLocalIsoMinute(h.windowEnd)}` +
        (holdStats.live > 0 ? ` (sent live to ${holdStats.live} excepted recipient ${holdStats.live === 1 ? "copy" : "copies"})` : ""),
      details: {
        ruleId: exec.ruleId ?? null,
        assetId: exec.assetId ?? null,
        source: { kind: h.source.kind, id: h.source.id, name: h.source.name },
        windowEnd: formatLocalIsoMinute(h.windowEnd),
        ...(h.split ? { liveRows: holdStats.live, heldRows: holdStats.held } : {}),
      },
    }).catch(() => {});
  };
  if (hold && stampHold && !deferStamp) await stampHeld(hold);
  // The hold this fan-out writes under: the fire's own, or the one the sweep
  // handed in for a split reminder/tier (rule 120).
  const fanHold = hold ?? exec.quietHold ?? null;

  let _bothMethods: boolean | null = null;
  const groupOffersBothMethods = async (): Promise<boolean> => {
    if (_bothMethods !== null) return _bothMethods;
    return (_bothMethods = await actionsCarryBothMethods(actions));
  };

  for (const [index, action] of actions.entries()) {
    try {
      if (action.type === "notify") {
        // The quiet-time all-clear drop (above). The other action types below
        // are not people-facing and run regardless.
        if (dropPeopleFacing) continue;
        const composed = composeForNotify(action.emailComposition ?? null, exec, ctx);
        const rows = await expandDeliveries(notificationId, actionsToTargets([action]), {
          scopeRegionTags: exec.scopeRegionTags,
          assetRegionTags: exec.assetRegionTags,
          ...(action.recipientAssetContacts ? { assetContactEmails: await assetContactEmails() } : {}),
          // ONE body for the whole action, rendered in the install's own zone
          // and saying so ({time.zone}). It used to be rebuilt once per
          // recipient timezone, which mailed the same alert to each zone's
          // readers separately — an operator who named two people on an
          // automation saw only themselves on the To line. Business rule 25:
          // the audience of an alert is not split by a fact about one reader.
          composedEmail: composed,
          // Push has no facts table to prune, so the two policy sentences
          // are joined into one line and appended to the body. Both are ""
          // on an automation that neither repeats nor escalates, and the
          // whole option then stays undefined — a one-shot alert's push is
          // byte-identical to what it was.
          ...(followUpLine(ctx) ? { followUp: followUpLine(ctx) } : {}),
          escalation: exec.escalation,
          repeat: exec.repeat,
          // Every row of this fan-out shares it — that is what makes the
          // footer's audience "this send" and not "this alert".
          dispatchId,
          // ...and push / chat, which have no composed body, say "resolved"
          // with the recovery sentence instead of repeating the fire.
          ...(allClear ? { noAck: true, allClearMessage: ctx["message"] ?? "" } : {}),
          ...(action.respectUserPreference ? { enforceUserPreference: await groupOffersBothMethods() } : {}),
          ...(fanHold ? { hold: { kind: fanHold.source.kind, id: fanHold.source.id, windowEnd: fanHold.windowEnd, ...(fanHold.split ? { isHeldFor: fanHold.isHeldFor } : {}) } } : {}),
          ...(excludeRecipients ? { excludeRecipients } : {}),
          stats: holdStats,
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
      } else if (action.type === "reboot") {
        // Business rule 115(c): BOOK a reboot of the triggering asset through
        // the reboot scheduler — never sent inline. A skip (already booked,
        // rebooted within the gap) is an Event, not a failure, and does not
        // count as executed; a refused gate throws into the catch below.
        if (!exec.assetId) throw new Error("the alert has no device to reboot");
        // The results recipients resolve NOW, against the triggering device —
        // "Asset's L1 Region Users" means the people who own THIS box — and
        // the booking stores plain addresses, like an operator's booking.
        const recips = await resolveRebootActionRecipients(action, {
          assetRegionTags: exec.assetRegionTags,
          ...(action.recipientAssetContacts ? { assetContactEmails: await assetContactEmails() } : {}),
          logCtx: { notificationId, assetId: exec.assetId, action: "reboot" },
        });
        // The booking's invariant is that someone always hears the outcome; a
        // To that resolved to nobody is a failed action, not a silent reboot.
        if (recips.to.length === 0) throw new Error("the reboot's To recipients resolved to no email address — nothing was booked");
        const { bookRebootFromAutomation } = await import("./rebootScheduleService.js");
        const res = await bookRebootFromAutomation({
          assetId: exec.assetId,
          when: action.when,
          at: action.at,
          notifyEmails: recips.to,
          notifyCc: recips.cc,
          notifyBcc: recips.bcc,
          minGapHours: action.minGapHours,
          ruleId: exec.ruleId ?? null,
          ruleName: exec.ruleName ?? null,
          notificationId,
        });
        if (res.booked) executed++;
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
  if (hold && stampHold && deferStamp && holdStats.held > 0) await stampHeld(hold);
  // A split fire that reached every reader live owes no summary as HELD, but
  // it still happened inside the window.
  else if (hold && stampHold && deferStamp) liveSource = hold.source;
  if (liveSource) {
    const src = liveSource;
    await prisma.notification.updateMany({
      where: { id: notificationId, quietHeldAt: null },
      data: { quietSource: { kind: src.kind, id: src.id, name: src.name } },
    }).catch((err) => {
      logger.warn({ err: (err as Error)?.message, notificationId }, "could not stamp the live alert's quiet source");
    });
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
 * Who the all-clear of a quiet-held alert must skip, or null when it must be
 * dropped whole (business rules 92 + 120).
 *
 * Rule 92 drops the all-clear of an alert whose fire was held and never
 * summarised, because nobody was told it started. With recipient exceptions
 * that is only true per reader: the excepted ones got the fire live (or a
 * reminder since). So: when NO row of this alert ever went out (`pending` /
 * `sent`), the answer is null and the all-clear drops exactly as before.
 * Otherwise it goes out, skipping the readers a held fire row named who have
 * not been reached by any live row since (a `deferred` reminder copy has not
 * reached anyone; one the window-end release sent has). Chat rows have no reader to tell
 * apart, so they are skipped when the chat send was held and never went live.
 */
export async function heldFireAudience(
  notificationId: string,
): Promise<{ addresses: Set<string>; userIds: Set<string>; chat: boolean } | null> {
  const rows = await prisma.notificationDelivery.findMany({
    where: { notificationId, status: { in: ["held", "pending", "sent"] } },
    select: { transport: true, target: true, status: true, meta: true },
  });
  const live = rows.filter((r) => r.status !== "held");
  if (live.length === 0) return null;
  const metaOf = (m: unknown) => (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
  const collect = (rs: typeof rows) => {
    const addresses = new Set<string>();
    const userIds = new Set<string>();
    let chat = false;
    for (const r of rs) {
      const meta = metaOf(r.meta);
      if (r.transport === "email") {
        const list: unknown[] = [
          ...r.target.split(","),
          ...(Array.isArray(meta["cc"]) ? (meta["cc"] as unknown[]) : []),
          ...(Array.isArray(meta["bcc"]) ? (meta["bcc"] as unknown[]) : []),
        ];
        for (const a of list) if (typeof a === "string" && a.trim()) addresses.add(a.trim().toLowerCase());
      } else if (r.transport === "web_push") {
        if (typeof meta["userId"] === "string" && meta["userId"]) userIds.add(meta["userId"]);
      } else {
        chat = true;
      }
    }
    return { addresses, userIds, chat };
  };
  const heldFire = collect(rows.filter((r) => r.status === "held"));
  const told = collect(live);
  return {
    addresses: new Set(Array.from(heldFire.addresses).filter((a) => !told.addresses.has(a))),
    userIds: new Set(Array.from(heldFire.userIds).filter((u) => !told.userIds.has(u))),
    chat: heldFire.chat && !told.chat,
  };
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
    if (!isOperatorSubject(comp.subjectTemplate)) {
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
  // A grouped alert that gained a contribution (business rule 75). Same shape
  // and same restraint as the reminder prefix above: only when nobody wrote a
  // subject template. The COUNT is the finding — "another port" is noise, "now
  // 9 ports" is a spreading fault — so it is what the marker carries. Then
  // WHAT changed, because a port that recovers and faults again inside one
  // alert leaves the count where it was, and "[UPDATED · 2]" twice in a row
  // read as the same email sent twice.
  if (exec.growth && !exec.escalation) {
    const comp = actionComp ?? exec.ruleEmailComposition ?? {};
    const composed = buildComposedEmail(comp, ctx);
    if (!isOperatorSubject(comp.subjectTemplate)) {
      const change = exec.growth.change ? ` · ${exec.growth.change}` : "";
      composed.subject = `[UPDATED · ${exec.growth.count}${change}] ${composed.subject}`;
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
  if (!isOperatorSubject(merged.subjectTemplate)) {
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
  // A JSON body gets JSON escaping for every substituted value: the values are
  // device-reported, and a quote in a hostname must not close the string it sits
  // in. A body that is not JSON (form-encoded, plain text) renders as before.
  const body = action.bodyTemplate && action.bodyTemplate.trim()
    ? renderNotificationTemplate(action.bodyTemplate, ctx, { json: templateIsJson(action.bodyTemplate) })
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
