/**
 * src/services/notificationDeliveryService.ts
 *
 * Drains pending NotificationDelivery rows and dispatches each through its
 * configured NotificationChannel (email SMTP/M365 / webhook slack-teams /
 * pushbullet / web_push) — or, for transport "api_call", straight from the
 * row's meta (channelId is NULL by design there; the request spec was
 * rendered at fire time by automationActionService). Driven by the
 * deliverNotifications job (~15s).
 *   - pull a bounded batch of pending rows (attempts < MAX_ATTEMPTS),
 *   - resolve each row's channel + config (secrets live on the channel),
 *   - dispatch with bounded concurrency,
 *   - mark sent / failed (failed rows retry until MAX_ATTEMPTS),
 *   - a NULL channel (deleted/disabled) → permanent fail, EXCEPT api_call
 *     rows whose NULL channel is legitimate (normal retry path),
 *   - prune dead push subscriptions (HTTP 410/404),
 *   - write ONE summary audit Event per non-empty drain.
 */

import { chunkArray } from "../utils/chunk.js";
import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { logger } from "../utils/logger.js";
import { notificationsPageUrl, pushDeepLinkUrl, ackUrlForEmail, ackUrlForPush, assetUrlForPush } from "../utils/notificationTemplate.js";
import { buildAlertCharts, chartTokensIn, substituteChartTokens, attachmentsFor, type ChartToken, type RenderedChart } from "./alertChartService.js";
import { buildInterfaceLldpBlocks, interfaceTokensIn, substituteInterfaceTokens } from "./alertInterfaceService.js";
import { buildAlertBrandBlock, brandTokensIn, substituteBrandTokens, BRAND_LOGO_CID } from "./alertBrandService.js";
import { pruneEmptyChartSection, pruneEmptyTextLines } from "../utils/alertEmailTemplate.js";
import { logEvent } from "./eventLogService.js";
import { type ChannelType, probeLossWindowSecFromTrigger } from "./notificationTypes.js";
import { sendSmtpEmail, sendM365Email, type EmailMessage } from "./notificationChannels/emailChannel.js";
import { sendWebhook } from "./notificationChannels/webhookChannel.js";
import { sendPushbullet } from "./notificationChannels/pushbulletChannel.js";
import { sendWebPush, type WebPushError } from "./notificationChannels/webPushChannel.js";
import { sendApiCall } from "./notificationChannels/apiCallChannel.js";

const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 200;
const CONCURRENCY = 8;

interface ChannelInfo {
  id: string;
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

interface DeliveryRow {
  id: string;
  channelId: string | null;
  transport: string;
  target: string;
  meta: unknown;
  attempts: number;
  notification: {
    id: string;
    message: string;
    severity: string;
    assetId: string | null;
    assetHostname: string | null;
    /** The sub-asset dimension this alert is about — for a hardware-sensor
     *  automation, the sensor name whose last hour the email charts. */
    dimension: string | null;
    /** The metric that fired — puts its chart first in the body. */
    metric: string | null;
    /** The automation — read back (lazily) for the loss chart's History window. */
    ruleId: string | null;
    triggeredAt: Date;
  };
}

/**
 * Per-drain-pass render memo.
 *
 * One alert can still produce several delivery rows rendering the SAME body —
 * a rule routed to two email channels, an escalation tier re-sending it, a
 * retry of a row that failed earlier in the pass — and the charts are built
 * here, at delivery time, not at fire time. Without this, those rows would each
 * query and rasterize the identical last-hour graphs. (Until the acknowledge
 * link stopped naming a person, a composed email also fanned out one row per
 * recipient, which is what forced this memo; business rule 25.)
 *
 * Scoped to ONE drain pass and deliberately never module-level: an escalation
 * email at T+90min must re-render against the current hour rather than replay
 * an hours-old snapshot, which is the whole reason charts are built in the
 * drain. PROMISES are cached, not results, so rows dispatched concurrently in
 * the same chunk share a single build instead of racing into N of them.
 */
interface RenderMemo {
  charts: Map<string, Promise<Map<ChartToken, RenderedChart>>>;
  lossWindow: Map<string, Promise<number | null>>;
}

function newRenderMemo(): RenderMemo {
  return { charts: new Map(), lossWindow: new Map() };
}

/** Memoized read-through: one build per (alert, exact chart set) per drain. */
function memoize<T>(cache: Map<string, Promise<T>>, key: string, build: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit) return hit;
  const p = build();
  cache.set(key, p);
  return p;
}

/**
 * The probe-loss History window (ms) the alert's automation measures over, for
 * the email's loss chart — so the graph spans exactly the period the ratio that
 * fired was computed on, instead of a fixed hour. Null when there is nothing to
 * follow: no rule (test alerts), a deleted rule, or a trigger with no loss
 * condition. Best-effort by the chart contract — a read failure means the
 * default window, never a failed delivery. One indexed read per delivery that
 * actually embeds a loss chart; the drain is off the engine's hot path.
 */
async function lossChartWindowMs(ruleId: string | null): Promise<number | null> {
  if (!ruleId) return null;
  try {
    const rule = await prisma.notificationRule.findUnique({ where: { id: ruleId }, select: { trigger: true } });
    const sec = rule ? probeLossWindowSecFromTrigger(rule.trigger) : null;
    return sec ? sec * 1000 : null;
  } catch (err) {
    logger.debug({ err: (err as Error)?.message, ruleId }, "loss chart window lookup failed — using the default");
    return null;
  }
}

function titleFor(n: DeliveryRow["notification"]): string {
  const sev = n.severity.toUpperCase();
  return n.assetHostname ? `[${sev}] ${n.assetHostname}` : `[${sev}] Polaris notification`;
}

function cfgStr(config: Record<string, unknown>, key: string): string {
  const v = config[key];
  return typeof v === "string" ? v : "";
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

/**
 * Build the EmailMessage for an email-transport delivery row. Composed rows
 * (meta.composed — rule emailComposition / escalation tiers) carry the full
 * pre-rendered snapshot; legacy rows (including pre-upgrade pending rows) get
 * the byte-identical default subject/body.
 */
async function emailMessageFor(d: DeliveryRow, meta: Record<string, unknown>, url: string | null, memo: RenderMemo): Promise<EmailMessage | { error: string }> {
  if (meta.composed === true) {
    const to = asStringArray(meta.to);
    if (to.length === 0) return { error: "composed email delivery has no To recipients" };
    let text = typeof meta.text === "string" ? meta.text : d.notification.message;
    let html = typeof meta.html === "string" && meta.html ? meta.html : undefined;

    // Charts are built HERE, not at fire time: the drain is a queue off the
    // engine's hot path, and an escalation email at T+90min then shows the
    // last hour as of sending rather than re-rendering a frozen snapshot.
    let attachments: EmailMessage["attachments"];
    const wanted = chartTokensIn(text, html);
    if (wanted.size > 0) {
      const assetId = d.notification.assetId;
      const charts = assetId
        // Keyed by the alert plus the exact chart set this body asks for — two
        // notify actions on one rule can compose different bodies, so the token
        // set is part of the identity, not just the notification.
        ? await memoize(
            memo.charts,
            `${d.notification.id}|${Array.from(wanted).sort().join(",")}`,
            async () =>
              buildAlertCharts(assetId, wanted, {
                sensorName: d.notification.dimension,
                metric: d.notification.metric,
                // The loss chart follows the automation's own History window; only
                // resolved when the body embeds one, and only meaningful there.
                lossWindowMs: wanted.has("chart.probeLoss") || wanted.has("chart.trigger")
                  ? await memoize(memo.lossWindow, d.notification.ruleId ?? "", () =>
                      lossChartWindowMs(d.notification.ruleId),
                    )
                  : null,
              }),
          )
        : new Map<ChartToken, RenderedChart>();
      // Charts render away individually (no samples) and collectively (an alert
      // about Polaris itself has no asset to chart), so both bodies get a tidy
      // pass afterwards: the HTML drops the "Last hour" heading left standing
      // over nothing, the text collapses the blank lines the removed tokens
      // left behind.
      text = pruneEmptyTextLines(substituteChartTokens(text, charts, { html: false }));
      if (html) {
        html = pruneEmptyChartSection(substituteChartTokens(html, charts, { html: true }));
        attachments = attachmentsFor(charts, html);
      }
    }

    // The interface block rides the same contract: built here so an escalation
    // re-reads the port rather than replaying a snapshot, and expanding to a
    // complete block or to nothing — so a non-interface alert (or a port with
    // no LLDP neighbour) needs no pruning pass of its own. One read serves both
    // bodies; the empty case is free, since buildInterfaceLldpBlocks returns
    // before querying unless the alert is about an interface.
    if (interfaceTokensIn(text, html).size > 0) {
      const lldp = await buildInterfaceLldpBlocks(
        d.notification.assetId,
        d.notification.metric,
        d.notification.dimension,
        // Rendered in the same zone as the body this block is stitched into —
        // see the timeZone stamp in expandDeliveries. Absent on a send that
        // did not split by zone, which keeps the server-zone default.
        typeof meta.timeZone === "string" ? meta.timeZone : null,
      );
      text = pruneEmptyTextLines(substituteInterfaceTokens(text, lldp.text));
      if (html) html = substituteInterfaceTokens(html, lldp.html);
    }

    // The letterhead. Built here rather than at fire time for the same reason
    // the charts are — the logo is an inline attachment, and an escalation sent
    // at T+90min should carry the install's CURRENT branding — but unlike them
    // it needs no per-alert context at all, so one memoized read serves the
    // whole drain. The attachment only rides along when the substituted HTML
    // actually references it (the block degrades to text, or to nothing, when
    // the logo can't be read).
    if (brandTokensIn(text, html).size > 0) {
      const brand = await buildAlertBrandBlock();
      text = pruneEmptyTextLines(substituteBrandTokens(text, brand.text));
      if (html) {
        html = substituteBrandTokens(html, brand.html);
        if (brand.attachment && html.includes(`cid:${BRAND_LOGO_CID}`)) {
          attachments = [...(attachments ?? []), brand.attachment];
        }
      }
    }

    return {
      to,
      cc: asStringArray(meta.cc),
      bcc: asStringArray(meta.bcc),
      subject: typeof meta.subject === "string" && meta.subject ? meta.subject : titleFor(d.notification),
      text,
      html,
      ...(attachments?.length ? { attachments } : {}),
    };
  }
  return {
    to: d.target,
    subject: titleFor(d.notification),
    // `noAck` is stamped at fan-out for an address whose Polaris role can't
    // acknowledge (business rule 25) — the link is left off rather than mailed
    // to someone the page can only refuse. An address with no account behind
    // it is never stamped, so contacts keep the link.
    text: appendAckLine(
      d.notification.message + (url ? `\n\nView: ${url}` : ""),
      meta.noAck === true ? null : ackUrlForEmail(d.notification.id),
    ),
  };
}

/** Append the acknowledge line to a plain-text body. Pure. */
export function appendAckLine(text: string, ackUrl: string | null): string {
  if (!ackUrl) return text;
  return `${text}\n\nAcknowledge this alert: ${ackUrl}`;
}

async function dispatch(d: DeliveryRow, channel: ChannelInfo | undefined, memo: RenderMemo): Promise<{ ok: true } | { ok: false; error: string; gone?: boolean }> {
  // api_call rows carry NO channel by design (channelId NULL — the whole
  // request spec lives in meta, rendered at fire time). Dispatch before the
  // channel checks so the null channel isn't treated as deleted.
  if (d.transport === "api_call") {
    const m = (d.meta && typeof d.meta === "object" ? d.meta : {}) as Record<string, unknown>;
    try {
      await sendApiCall({
        method: typeof m.method === "string" ? m.method : "POST",
        url: typeof m.url === "string" && m.url ? m.url : d.target,
        headers: m.headers && typeof m.headers === "object" ? (m.headers as Record<string, string>) : undefined,
        body: typeof m.body === "string" ? m.body : undefined,
        timeoutSec: typeof m.timeoutSec === "number" ? m.timeoutSec : undefined,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message ?? String(err) };
    }
  }
  if (!channel) return { ok: false, error: "delivery channel was deleted" };
  if (!channel.enabled) return { ok: false, error: "delivery channel is disabled" };
  const url = notificationsPageUrl();
  const cfg = channel.config || {};
  const meta = (d.meta && typeof d.meta === "object" ? d.meta : {}) as Record<string, unknown>;
  const type = channel.type as ChannelType;
  try {
    if (type === "smtp" || type === "oauth_m365") {
      const msg = await emailMessageFor(d, meta, url, memo);
      if ("error" in msg) return { ok: false, error: msg.error };
      if (type === "smtp") {
        await sendSmtpEmail(
          { host: cfgStr(cfg, "host"), port: Number(cfg.port) || 587, security: (cfgStr(cfg, "security") as any) || "starttls", username: cfgStr(cfg, "username"), password: cfgStr(cfg, "password"), from: cfgStr(cfg, "from") },
          msg,
        );
      } else {
        await sendM365Email(
          { tenantId: cfgStr(cfg, "tenantId"), clientId: cfgStr(cfg, "clientId"), clientSecret: cfgStr(cfg, "clientSecret"), fromUserId: cfgStr(cfg, "fromUserId") },
          msg,
        );
      }
    } else if (type === "slack" || type === "teams") {
      const webhookUrl = cfgStr(cfg, "webhookUrl");
      if (!webhookUrl) return { ok: false, error: `${type} channel has no webhook URL` };
      await sendWebhook(webhookUrl, type, {
        title: titleFor(d.notification),
        message: d.notification.message,
        severity: d.notification.severity,
        assetHostname: d.notification.assetHostname,
        url,
        triggeredAt: d.notification.triggeredAt.toISOString(),
      });
    } else if (type === "pushbullet") {
      await sendPushbullet({ accessToken: cfgStr(cfg, "accessToken") }, { title: titleFor(d.notification), body: d.notification.message });
    } else if (type === "web_push") {
      // Web push gets its OWN url, not the shared `url` the email/chat
      // transports use: the deep link depends on which surface enrolled the
      // subscription (snapshotted into meta at fan-out). It also never comes
      // back null — pushDeepLinkUrl falls back to a relative path when
      // POLARIS_PUBLIC_URL is unset, which the service worker resolves.
      await sendWebPush(
        { publicKey: cfgStr(cfg, "publicKey"), privateKey: cfgStr(cfg, "privateKey"), subject: cfgStr(cfg, "subject") },
        { endpoint: d.target, p256dh: String(meta.p256dh ?? ""), auth: String(meta.auth ?? "") },
        {
          title: titleFor(d.notification),
          // The follow-up policy rides IN the body: a push has no facts
          // table, and "will this keep bothering me / is my manager about
          // to get this" is exactly the question a tray notification is
          // read to answer. Absent (and the body unchanged) when the
          // automation neither repeats nor escalates.
          body: typeof meta.followUp === "string" && meta.followUp
            ? `${d.notification.message}\n\n${meta.followUp}`
            : d.notification.message,
          severity: d.notification.severity,
          url: pushDeepLinkUrl(meta.surface),
          notificationId: d.notification.id,
          // The DEVICE page, as its own tray action. The body tap goes where
          // the server chose (the Alerts list / the phone's alerts tab),
          // which is the right landing for triage across several alerts but
          // two taps from the one device this alert is about. Null — and no
          // button — for an alert with no asset behind it: a capacity
          // warning, a failed backup, a discovery error.
          ...(assetUrlForPush(d.notification.assetId) ? { assetUrl: assetUrlForPush(d.notification.assetId) } : {}),
          // The alert's acknowledge page — the same URL the email carries,
          // and the page itself decides whether the person who taps it may
          // acknowledge. sw.js renders the Acknowledge action button when it
          // arrives and opens this URL; it is omitted (no tray action at all)
          // when fan-out stamped `noAck` because the subscription's owner
          // holds a role that can't acknowledge. Unlike email, a push always
          // has a known account behind it, so there is no unknown case.
          ...(meta.noAck === true ? {} : { ackUrl: ackUrlForPush(d.notification.id) }),
        },
      );
    } else {
      return { ok: false, error: `unknown channel type "${channel.type}"` };
    }
    return { ok: true };
  } catch (err) {
    const e = err as WebPushError;
    return { ok: false, error: e?.message ?? String(err), gone: e?.gone };
  }
}

/** What expandDeliveries stamps on a web_push row so a dead endpoint can be
 *  re-routed. Absent when the action carries no email channel, or the
 *  recipient's account has no address. */
interface PushFallback {
  userId: string;
  channelId: string;
  address: string;
}

export function readPushFallback(meta: unknown): PushFallback | null {
  const f = (meta as { fallback?: unknown } | null | undefined)?.fallback as Partial<PushFallback> | undefined;
  return f && typeof f.userId === "string" && typeof f.channelId === "string" && typeof f.address === "string"
    ? { userId: f.userId, channelId: f.channelId, address: f.address }
    : null;
}

/** One sibling delivery row of the same alert, as the fallback pass reads it. */
export interface FallbackSibling {
  transport: string;
  status: string;
  target: string;
  channelId: string | null;
  meta: unknown;
}

/**
 * Is ANY other push device of this recipient's still reached or still trying?
 *
 * The fallback is per RECIPIENT, not per row: one account with three enrolled
 * browsers has three delivery rows and two of them may have succeeded, so
 * emailing on the first dead endpoint is a duplicate — and duplicates are how
 * people learn to ignore alerts. `sent` counts as reached; `pending` means a
 * retry may still land it (a 5xx burns up to MAX_ATTEMPTS before it is
 * terminal). Only OTHER rows belonging to the SAME user count.
 *
 * Pure — exported for the tests, since both directions fail quietly: too eager
 * sends a second copy, too shy sends nothing at all.
 */
export function pushStillInPlay(siblings: FallbackSibling[], userId: string): boolean {
  return siblings.some(
    (s) => s.transport === "web_push" &&
      (s.status === "sent" || s.status === "pending") &&
      readPushFallback(s.meta)?.userId === userId,
  );
}

/**
 * Has this address already been emailed on this channel for this alert — by
 * the automation's own email target, or by an earlier pass's fallback?
 *
 * Substring, not equality: a COMPOSED send is ONE row whose `target` is the
 * whole joined To list, so an equality test would miss a recipient who is
 * already on it and mail them a second copy.
 *
 * Pure — exported for the tests.
 */
export function alreadyEmailedOnChannel(
  siblings: FallbackSibling[],
  channelId: string,
  address: string,
): boolean {
  const needle = address.trim().toLowerCase();
  return siblings.some(
    (s) => s.transport === "email" && s.channelId === channelId &&
      s.target.toLowerCase().includes(needle),
  );
}

/**
 * Email the recipients whose web push just failed for good.
 *
 * The signal is the ONLY one Polaris actually gets: a push service answering
 * 404/410 means that subscription is dead. It is not "the phone is off" — a
 * phone in a drawer returns 201 and the message quietly expires at its TTL,
 * and nothing ever reports that. So this catches an uninstalled browser,
 * cleared site data, or a rotated endpoint, and deliberately claims nothing
 * more.

 * Three rules keep it from emailing people who were reached perfectly well:
 *
 *   PER RECIPIENT, NOT PER ROW. One account with three enrolled browsers has
 *   three delivery rows; two may have succeeded. So a user is only emailed
 *   when EVERY push row of theirs on this alert has stopped being in play —
 *   `sent` counts as reached, and `pending` means a retry may still land it.
 *
 *   THE ACTION'S OWN EMAIL CHANNEL. `fallback.channelId` was chosen at
 *   expansion time from the same action's channels, so no alert is re-routed
 *   through an SMTP config nobody picked for it.
 *
 *   NEVER TWICE. An existing email row on the same (alert, channel, address)
 *   — the operator's own email target, or an earlier pass's fallback — wins,
 *   and the fallback is skipped.
 *
 * The body is CLONED from a sibling email row on the same channel when one
 * exists, so a custom composition reaches the fallback too; with no sibling it
 * is the plain per-address path, which renders the default alert email.
 */
async function enqueuePushFallbacks(terminal: DeliveryRow[]): Promise<number> {
  const wanted = terminal
    .map((r) => ({ notificationId: r.notification.id, fallback: readPushFallback(r.meta) }))
    .filter((x): x is { notificationId: string; fallback: PushFallback } => !!x.fallback);
  if (wanted.length === 0) return 0;

  const byNotification = new Map<string, PushFallback[]>();
  for (const w of wanted) {
    const list = byNotification.get(w.notificationId) ?? [];
    if (!list.some((f) => f.userId === w.fallback.userId)) list.push(w.fallback);
    byNotification.set(w.notificationId, list);
  }

  const created: Prisma.NotificationDeliveryCreateManyInput[] = [];
  for (const [notificationId, fallbacks] of byNotification) {
    const siblings = await prisma.notificationDelivery.findMany({
      where: { notificationId },
      select: { transport: true, status: true, target: true, channelId: true, meta: true },
    });
    for (const f of fallbacks) {
      if (pushStillInPlay(siblings, f.userId)) continue;
      if (alreadyEmailedOnChannel(siblings, f.channelId, f.address)) continue;
      // Reuse the action's own composed body when it has one.
      const composedSibling = siblings.find(
        (s) => s.transport === "email" && s.channelId === f.channelId &&
          !!(s.meta as { composed?: unknown } | null)?.composed,
      );
      const composed = composedSibling?.meta as Record<string, unknown> | undefined;
      created.push({
        notificationId,
        channelId: f.channelId,
        transport: "email",
        target: f.address,
        meta: {
          ...(composed ? { ...composed, to: [f.address], cc: [], bcc: [] } : {}),
          // Audit provenance: this row exists because a push died, not because
          // the automation addressed this person by email.
          pushFallback: true,
        } as Prisma.InputJsonValue,
      });
    }
  }

  if (created.length === 0) return 0;
  await prisma.notificationDelivery.createMany({ data: created });
  logger.info({ count: created.length }, "web push failed permanently; queued email fallback");
  return created.length;
}

/** One drain pass. Returns counts. */
/**
 * @param opts.notificationId Drain only ONE alert's rows. The wizard's test
 * buttons use this to dispatch immediately instead of waiting up to 15s for
 * the tick — extending the drain rather than cloning it, because this function
 * owns retries, permanent-fail classification, dead-push pruning and the
 * summary Event. The job itself calls it with no arguments, unchanged.
 */
export async function drainPendingDeliveries(
  opts: { notificationId?: string } = {},
): Promise<{ processed: number; sent: number; failed: number }> {
  const rows = (await prisma.notificationDelivery.findMany({
    where: {
      status: "pending",
      attempts: { lt: MAX_ATTEMPTS },
      ...(opts.notificationId ? { notificationId: opts.notificationId } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE,
    select: {
      id: true,
      channelId: true,
      transport: true,
      target: true,
      meta: true,
      attempts: true,
      // assetId is what the last-hour charts query against — the hostname is a
      // fire-time snapshot and can't be joined back to sample rows.
      // ruleId feeds the loss chart's window: the automation's own History is
      // what the chart should span (resolved lazily, only when a loss chart is
      // actually in the body).
      notification: { select: { id: true, message: true, severity: true, assetId: true, assetHostname: true, dimension: true, metric: true, ruleId: true, triggeredAt: true } },
    },
  })) as DeliveryRow[];

  if (rows.length === 0) return { processed: 0, sent: 0, failed: 0 };

  // Resolve the referenced channels once (config carries the secrets).
  const channelIds = Array.from(new Set(rows.map((r) => r.channelId).filter((x): x is string => !!x)));
  const channelList = channelIds.length
    ? await prisma.notificationChannel.findMany({ where: { id: { in: channelIds } }, select: { id: true, type: true, enabled: true, config: true } })
    : [];
  const channels = new Map<string, ChannelInfo>(
    channelList.map((c) => [c.id, { id: c.id, type: c.type, enabled: c.enabled, config: (c.config && typeof c.config === "object" ? c.config : {}) as Record<string, unknown> }]),
  );

  const sentIds: string[] = [];
  const failed: { id: string; error: string }[] = [];
  const deadEndpoints: string[] = [];
  const now = new Date();
  const memo = newRenderMemo();

  for (const chunk of chunkArray(rows, CONCURRENCY)) {
    const results = await Promise.all(chunk.map(async (d) => ({ d, r: await dispatch(d, d.channelId ? channels.get(d.channelId) : undefined, memo) })));
    for (const { d, r } of results) {
      if (r.ok) sentIds.push(d.id);
      else {
        failed.push({ id: d.id, error: r.error.slice(0, 500) });
        if (r.gone && d.transport === "web_push") deadEndpoints.push(d.target);
      }
    }
  }

  const ops: Promise<unknown>[] = [];
  if (sentIds.length > 0) {
    ops.push(prisma.notificationDelivery.updateMany({ where: { id: { in: sentIds } }, data: { status: "sent", lastAttemptAt: now } }));
  }
  // Web push rows that just gave up for good, so the drain can email the
  // person instead (see enqueuePushFallbacks).
  const terminalPush: DeliveryRow[] = [];
  for (const f of failed) {
    const row = rows.find((r) => r.id === f.id)!;
    // A missing channel is permanent — fail immediately rather than burn
    // retries. api_call rows legitimately carry NO channel (spec in meta), so
    // their failures always take the normal retry path.
    const permanent = row.transport !== "api_call" && (!row.channelId || !channels.get(row.channelId));
    const nextAttempts = row.attempts + 1;
    const terminal = permanent || nextAttempts >= MAX_ATTEMPTS;
    if (terminal && row.transport === "web_push") terminalPush.push(row);
    ops.push(
      prisma.notificationDelivery.update({
        where: { id: f.id },
        data: { attempts: { increment: 1 }, lastAttemptAt: now, error: f.error, status: terminal ? "failed" : "pending" },
      }),
    );
  }
  if (deadEndpoints.length > 0) {
    ops.push(prisma.pushSubscription.deleteMany({ where: { endpoint: { in: deadEndpoints } } }));
  }
  await Promise.all(ops);

  // AFTER the status writes, never before: enqueuePushFallbacks asks whether
  // any of a recipient's OTHER devices are still in play, and the rows that
  // just failed have to already read `failed` for that question to be honest.
  const fellBack = await enqueuePushFallbacks(terminalPush).catch((err) => {
    // A fallback that throws must never cost the drain its status writes or
    // its summary Event — the alert has already been delivered to everyone
    // else by this point.
    logger.warn({ err }, "push-to-email fallback failed");
    return 0;
  });

  if (failed.length > 0 || sentIds.length > 0) {
    await logEvent({
      action: "notification.delivered",
      resourceType: "notification",
      actor: "system:notification-delivery",
      level: failed.length > 0 ? "warning" : "info",
      message: `Notification delivery: ${sentIds.length} sent, ${failed.length} failed`,
      details: { sent: sentIds.length, failed: failed.length, prunedSubscriptions: deadEndpoints.length, emailedInsteadOfPush: fellBack },
    }).catch(() => {});
  }

  logger.debug({ processed: rows.length, sent: sentIds.length, failed: failed.length }, "notification delivery drain");
  return { processed: rows.length, sent: sentIds.length, failed: failed.length };
}
