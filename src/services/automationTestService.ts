/**
 * src/services/automationTestService.ts — the wizard's "Test delivery" buttons.
 *
 * Authoring an automation used to be a blind flight: the only way to learn
 * whether the SMTP channel authenticates, whether Web Push reaches your phone,
 * or whether the audit Event lands was to save the rule and provoke a real
 * trigger. This fires ONE action of a draft — saved or not — through the exact
 * delivery path a real alert takes.
 *
 * Four safety properties, each of which is the whole reason for its code:
 *
 *  0. It is about a MADE-UP device, and says so. The alert used to be fired
 *     against whichever real asset the draft would match, so the email carried
 *     a live hostname, management IP, site code and the device's own admin
 *     description — mailed on demand to an address the caller typed. Every
 *     fact in a test email now comes from `utils/sampleAlertDevice` and every
 *     chart from `sampleChartSeries`; the message, the subject and a banner at
 *     the head of the body all say TEST, so no forwarded copy of one can be
 *     mistaken for an outage.
 *
 *  1. The test alert ALWAYS carries `ruleId: null` (and `testRun: true`), even
 *     when the draft is a saved rule. notificationEscalationService sweeps
 *     `{ cleared: false, ruleId: { in: enabledRuleIds } }`, so a test alert
 *     with a real ruleId would enter the escalation ladder and start paging
 *     people on the next 60s tick. No NotificationRuleState row is written
 *     either — the engine must not think this asset is firing.
 *  2. Only `notify` actions execute (plus the audit Event in event mode).
 *     A test button that runs a registry script is RCE-by-button, and an
 *     api_call test would open real tickets in PagerDuty or ServiceNow.
 *  3. It ONLY EVER reaches the caller, and that is a recipient REWRITE
 *     rather than a flag read downstream: the action's recipients become
 *     the caller and every other recipient field — including
 *     emailComposition cc/bcc — is dropped, so the path is
 *     structurally incapable of reaching anyone else. There is
 *     deliberately no "send to the automation's real recipients" mode: a
 *     test answers "does this channel work, and what does the message
 *     look like", and answering it by paging the on-call is a cost nobody
 *     asked for. A destination with no private form (a Slack or Teams
 *     webhook posts to one channel) is tested from the Delivery tab's own
 *     per-channel Test button, which is honest about who sees it.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { logger } from "../utils/logger.js";
import { executeActions } from "./automationActionService.js";
import { drainPendingDeliveries } from "./notificationDeliveryService.js";
import { buildTemplateContext } from "../utils/notificationTemplate.js";
import { scopeRegionTagsOf } from "./notificationRecipientService.js";
import type { AutomationAction, PreviewRuleInput, Severity } from "./notificationTypes.js";
import { allRuleActionRefs, notifyChannelIds } from "./notificationTypes.js";
import { triggerSummary } from "../utils/triggerSummary.js";
import { SAMPLE_ALERT_DEVICE, SAMPLE_ALERT_HOSTNAME, sampleDimensionFor } from "../utils/sampleAlertDevice.js";

export type TestTarget = "delivery" | "event";

/** Which action of the draft to test — an index into the canonical walk. */
export interface TestActionPath {
  index: number;
  /**
   * Which of a MULTI-CHANNEL notify action's channels to test. Omitted =
   * the action's primary channel, which is every pre-multi-channel path and
   * every single-channel action. Refused if it names a channel the action
   * doesn't carry — a test that quietly retargets is worse than no test.
   */
  channelId?: string;
}

export interface SkippedAction {
  type: string;
  reason: string;
}

export interface TestDeliveryResult {
  ok: boolean;
  notificationId: string;
  message: string;
  deliveries: Array<{ transport: string; target: string; status: string; error: string | null }>;
  skipped: SkippedAction[];
  /** Whether the delivered message could carry a working Acknowledge button.
   *  No longer a COUNT: the link is one URL per alert rather than a token per
   *  recipient (business rule 25), so the only question left is whether this
   *  install has a public URL to build it from. */
  ackLinks: { enabled: boolean; reason?: string };
  timedOut?: boolean;
}

/** A dead SMTP host must not pin an HTTP worker until its own timeout. */
const DISPATCH_BUDGET_MS = 20_000;

/**
 * PURE. Resolve the addressed action, drop what a test must never run, and
 * rewrite the recipients to the caller alone.
 */
export function selectTestActions(
  rule: Pick<PreviewRuleInput, "actions" | "severityBands" | "bandNotify" | "resetActions" | "escalation">,
  path: TestActionPath,
  callerUserId: string,
): { actions: AutomationAction[]; skipped: SkippedAction[] } {
  const refs = allRuleActionRefs(rule as never);
  const ref = refs[path.index];
  if (!ref) throw new AppError(400, "That action is no longer part of the automation");

  const action = ref.action;
  if (action.type === "script") {
    return { actions: [], skipped: [{ type: "script", reason: "scripts are never run by a test button" }] };
  }
  if (action.type === "api_call") {
    return { actions: [], skipped: [{ type: "api_call", reason: "an API call would act on a real system" }] };
  }
  if (action.type !== "notify") {
    return { actions: [], skipped: [{ type: action.type, reason: "nothing to deliver" }] };
  }

  // Keep the channel and the message, drop every route to anyone else.
  // Listing the fields KEPT (rather than deleting a denylist) means a NEW
  // recipient field can't silently survive a test.
  const comp = action.emailComposition
    ? { ...action.emailComposition, cc: null, bcc: null }
    : action.emailComposition;
  // One channel per test send: the buttons are per-DELIVERY ("Send Test
  // Email", "Send Test Web Push"), so a multi-channel action offers one button
  // per channel rather than firing all of them off a single click.
  const channelIds = notifyChannelIds(action);
  const channelId = path.channelId ?? channelIds[0];
  if (!channelIds.includes(channelId)) {
    throw new AppError(400, "That delivery channel is no longer part of the action");
  }
  return {
    actions: [{
      type: "notify",
      channelId,
      recipientUserIds: [callerUserId],
      ...(comp ? { emailComposition: comp } : {}),
    }],
    skipped: [],
  };
}

/** The alert body a test produces — clearly a test, in the message itself. */
function testMessage(ruleName: string, hostname: string | null): string {
  return `[TEST] ${ruleName || "Automation"} — delivery test${hostname ? ` for ${hostname}` : ""}`;
}

export interface RunTestArgs {
  rule: PreviewRuleInput;
  path: TestActionPath;
  target: TestTarget;
  actorUserId: string;
  actorUsername: string;
}

export async function runTestDelivery(args: RunTestArgs): Promise<TestDeliveryResult> {
  const { rule, actorUserId, actorUsername } = args;

  // The device a test alert is about is INVENTED — see the header, and
  // `utils/sampleAlertDevice` for why every field in it is documentation-range
  // or "Example"-prefixed. It carries the same field set the engine's
  // ASSET_DETAIL_SELECT feeds a real fire, so the facts table renders the same
  // rows rather than pruning down to a bare shell.
  const asset = SAMPLE_ALERT_DEVICE;

  const severity: Severity = rule.severity ?? "warning";
  const message = testMessage(rule.name, SAMPLE_ALERT_HOSTNAME);
  const metric = rule.trigger && (rule.trigger.type === "asset_metric" || rule.trigger.type === "host_metric")
    ? rule.trigger.metric
    : rule.trigger && rule.trigger.type === "asset_state" ? rule.trigger.field : null;
  // A sensor or SD-WAN automation's email charts the sub-asset it fired on, so
  // a TEST of one has to name one too — otherwise the button can't show the
  // operator the very thing they're testing. Made up per metric family, like
  // everything else here.
  const dimension = sampleDimensionFor(metric);

  const notif = await prisma.notification.create({
    data: {
      // ALWAYS null — see the header. A real ruleId would enlist this alert in
      // the escalation sweep.
      ruleId: null,
      testRun: true,
      // Null for the same reason the sample device has no id: a test alert
      // belongs to no device, so it can never surface on a real asset's alert
      // list, and the charts are generated rather than read (see
      // `sampleChartSeries`, reached through `testRun` in the delivery drain).
      assetId: null,
      assetHostname: SAMPLE_ALERT_HOSTNAME,
      severity,
      message,
      regionTags: [],
      dimension,
      metric,
    },
    select: { id: true },
  });

  if (args.target === "event") {
    await logEvent({
      action: "notification.triggered",
      resourceType: "notification",
      resourceId: notif.id,
      resourceName: rule.name,
      actor: actorUsername,
      level: severity === "critical" || severity === "serious" ? "error" : severity === "warning" ? "warning" : "info",
      message,
      details: { test: true, ruleId: null, assetId: null, severity },
    });
    return {
      ok: true,
      notificationId: notif.id,
      message: "Test Event written — look for notification.triggered in the Events tab.",
      deliveries: [],
      skipped: [],
      ackLinks: { enabled: false, reason: "an Event carries no acknowledge link" },
    };
  }

  const { actions, skipped } = selectTestActions(rule, args.path, actorUserId);
  if (actions.length === 0) {
    return {
      ok: false,
      notificationId: notif.id,
      message: skipped[0]?.reason ?? "Nothing to deliver for that action",
      deliveries: [],
      skipped,
      ackLinks: { enabled: false },
    };
  }

  const ctx = buildTemplateContext({
    asset: SAMPLE_ALERT_HOSTNAME,
    severity,
    time: new Date(),
    ruleName: rule.name,
    ruleDescription: rule.description ?? null,
    message,
    metric: metric ?? "test",
    // No reading, deliberately: the only honest number here would be a real
    // device's, and `triggerSummary` already falls back to stating the
    // CONDITION ("Response time (median over 5 minutes) is above 500 ms"),
    // which is what the operator wrote and what they are testing the wording
    // of. A made-up number would read as a measurement.
    value: "",
    dimension: dimension ?? "",
    triggerSummary: triggerSummary({
      trigger: rule.trigger as never,
      value: null,
      dimensionLabel: dimension,
      sensorUnit: null,
    }),
    assetDetail: asset,
  });

  await executeActions(notif.id, actions, ctx, {
    scopeRegionTags: scopeRegionTagsOf(rule.scope as never),
    assetRegionTags: [],
    assetId: null,
    ruleName: rule.name,
    ruleEmailComposition: rule.emailComposition ?? null,
    actor: actorUsername,
  });

  // Dispatch now rather than waiting up to 15s for the drain tick — but keep a
  // budget, because the drain talks SMTP/Graph synchronously.
  let timedOut = false;
  try {
    await Promise.race([
      drainPendingDeliveries({ notificationId: notif.id }),
      new Promise((_r, reject) => setTimeout(() => reject(new Error("budget")), DISPATCH_BUDGET_MS)),
    ]);
  } catch (err) {
    timedOut = (err as Error)?.message === "budget";
    if (!timedOut) logger.warn({ err: (err as Error)?.message }, "test delivery dispatch failed");
  }

  const rows = await prisma.notificationDelivery.findMany({
    where: { notificationId: notif.id },
    select: { transport: true, target: true, status: true, error: true, meta: true },
  });
  const sent = rows.filter((r) => r.status === "sent").length;
  const failed = rows.filter((r) => r.status === "failed");
  const ok = sent > 0 && failed.length === 0;
  // The acknowledge link resolves against POLARIS_PUBLIC_URL; without one a
  // relative path in an inbox points at nothing, so the button renders away.
  const ackLinksEnabled = Boolean(process.env.POLARIS_PUBLIC_URL);

  await logEvent({
    action: "automation.test_delivery",
    resourceType: "notification",
    resourceId: notif.id,
    resourceName: rule.name,
    actor: actorUsername,
    // Always info: a test reaches the operator who pressed the button and
    // nobody else, so no variant of it pages real people any more.
    level: "info",
    message: `Delivery test for "${rule.name}": ${sent} sent, ${failed.length} failed (sender only)`,
    details: { rows: rows.length, sent, failed: failed.length, skipped, ackLinks: ackLinksEnabled },
  });

  const detail = failed.length ? ` — ${failed[0]!.error ?? "delivery failed"}` : "";
  const targets = rows.map((r) => r.target).filter(Boolean);
  return {
    ok,
    notificationId: notif.id,
    message: timedOut
      ? "Still sending — check the alert's deliveries in a moment."
      : sent > 0
        ? `Sent to ${targets.length ? targets.join(", ") : `${sent} destination(s)`}${detail}`
        : `Nothing was delivered${detail || " — the action resolved to no recipients"}`,
    deliveries: rows.map((r) => ({ transport: r.transport, target: r.target, status: r.status, error: r.error })),
    skipped,
    ackLinks: {
      enabled: ackLinksEnabled,
      ...(ackLinksEnabled ? {} : { reason: "POLARIS_PUBLIC_URL is not set, so no acknowledge link can be built" }),
    },
    ...(timedOut ? { timedOut } : {}),
  };
}
