/**
 * src/services/notificationTypes/actions.ts — delivery channels, targets and actions (CQ-B063, moved verbatim from notificationTypes.ts): the channel / target
 * schemas, rule-level email composition + escalation, the v2 rule shape (reset + unified
 * actions), per-action escalation, and the band-severity action fields.
 */

import { z } from "zod";
import { quietConfigSchema } from "../../utils/quietTime.js";
import { SEVERITIES, COMPARATORS } from "./scopeConditions.js";
import { triggerConditionGroupSchema } from "./triggers.js";

// ─── Delivery channels + targets ─────────────────────────────────────────────
// Channels are operator-configured delivery integrations (NotificationChannel
// registry, Notifications → Delivery tab). A rule's `targets[]` reference a
// channel by id. In-app is always implicit (every fire writes a Notification);
// targets route the same fire out through the configured channels.
//
// `transport` is the dispatch family the drain switches on; multiple channel
// `type`s can share one transport (slack + teams → webhook).
export const CHANNEL_TYPES = ["smtp", "oauth_m365", "pushbullet", "slack", "teams", "web_push"] as const;

export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const CHANNEL_TRANSPORT: Record<ChannelType, "email" | "webhook" | "web_push" | "pushbullet"> = {
  smtp: "email",
  oauth_m365: "email",
  pushbullet: "pushbullet",
  slack: "webhook",
  teams: "webhook",
  web_push: "web_push",
};

/** Channel types whose target routes to recipients (tags / addresses); the rest
 *  post to the channel's own fixed destination (URL / token). */
export const RECIPIENT_ROUTED_TYPES: ChannelType[] = ["smtp", "oauth_m365", "web_push"];

// Display metadata for the Delivery-tab add/edit modal: per-type label + the
// config fields (key, label, kind, whether it's a masked secret).
export interface ChannelFieldDef {
  key: string;
  label: string;
  kind: "text" | "number" | "password" | "select";
  secret?: boolean;
  options?: string[];
  placeholder?: string;
}

export const CHANNEL_TYPE_META: Record<ChannelType, { label: string; transport: string; singleton?: boolean; help?: string; fields: ChannelFieldDef[] }> = {
  smtp: {
    label: "Email — SMTP", transport: "email",
    fields: [
      { key: "host", label: "SMTP host", kind: "text", placeholder: "smtp.example.com" },
      // Security sits above Port: picking a security level auto-fills the
      // conventional port (none→25, starttls→587, ssl→465) in the UI.
      { key: "security", label: "Security", kind: "select", options: ["none", "starttls", "ssl"] },
      { key: "port", label: "Port", kind: "number" },
      { key: "username", label: "Username", kind: "text" },
      { key: "password", label: "Password", kind: "password", secret: true },
      { key: "from", label: "From address", kind: "text", placeholder: "polaris@example.com" },
    ],
  },
  oauth_m365: {
    label: "Email — Microsoft 365 (OAuth)", transport: "email",
    help: "Add the Mail.Send application permission to this app's Enterprise application in Azure (App registration → API permissions → Microsoft Graph → Application permissions → Mail.Send) and grant admin consent. The send-as user must be a licensed Exchange Online mailbox.",
    fields: [
      { key: "tenantId", label: "Tenant ID", kind: "text" },
      { key: "clientId", label: "Client ID", kind: "text" },
      { key: "clientSecret", label: "Client secret", kind: "password", secret: true },
      { key: "fromUserId", label: "Send-as user (UPN or object ID)", kind: "text", placeholder: "alerts@example.com" },
    ],
  },
  pushbullet: {
    label: "Pushbullet", transport: "pushbullet",
    fields: [
      { key: "accessToken", label: "Access token", kind: "password", secret: true },
    ],
  },
  slack: {
    label: "Slack", transport: "webhook",
    fields: [
      { key: "webhookUrl", label: "Incoming webhook URL", kind: "password", secret: true, placeholder: "https://hooks.slack.com/services/…" },
    ],
  },
  teams: {
    label: "Microsoft Teams", transport: "webhook",
    fields: [
      { key: "webhookUrl", label: "Incoming webhook URL", kind: "password", secret: true, placeholder: "https://outlook.office.com/webhook/…" },
    ],
  },
  web_push: {
    label: "Web Push (browser & mobile)", transport: "web_push", singleton: true,
    fields: [
      { key: "subject", label: "Contact subject (mailto: or https:)", kind: "text", placeholder: "mailto:admin@example.com" },
      // publicKey + privateKey are generated server-side, not free-typed.
    ],
  },
};

/**
 * How far OUT a notify action may reach from the triggering device's own
 * region. 8 is a ceiling, not an expectation: an install with more than eight
 * levels of nested regions has a drawing problem, not a routing one.
 */
export const MAX_DEVICE_REGION_LEVELS = 8;

export const deliveryTargetSchema = z.object({
  channelId: z.string().min(1).max(100),
  // Recipient sources (combine freely; only meaningful for recipient-routed
  // channel types — email + web_push). Chat/Pushbullet ignore these.
  recipientUserIds: z.array(z.string().max(100)).max(500).optional(), // specific Polaris users → their email / push subs
  addresses: z.array(z.string().email().max(320)).max(100).optional(), // custom email addresses (email channels)
  recipientScopeRegion: z.boolean().optional(), // users whose region tags match the rule's scope region tag(s)
  recipientDeviceRegion: z.boolean().optional(), // users whose region tags match the TRIGGERING asset's region: tag(s)
  // Route to users whose region tags match the triggering asset's regions at
  // specific ASSET-RELATIVE levels: 1 = the device's own innermost region,
  // 2 = the division containing it, and so on outward. Independent of
  // recipientDeviceRegion (which stays "every region the asset carries, any
  // level") rather than a modifier of it, so no stored rule changes meaning and
  // the two can sit on DIFFERENT actions — a region-users trigger and an
  // L2-users escalation, which is the whole point.
  //
  // NOT asked as a global level: levels count outward from the leaves and have
  // gaps on an uneven tree, so filtering on a global level would reach nobody
  // for a device whose branch skips it. See regionHierarchyService.
  recipientDeviceRegionLevels: z
    .array(z.number().int().min(1).max(MAX_DEVICE_REGION_LEVELS))
    .max(MAX_DEVICE_REGION_LEVELS)
    .optional(),
  recipientAssetContacts: z.boolean().optional(), // address-book contacts owning the TRIGGERING asset (email only)
  // Every user holding one of these ROLES. Stored as role IDS, not names: a
  // role can be renamed, and User.roleId / ApiToken / GroupMapping all key on
  // the id already. Resolves to users, so it works on email AND web_push.
  recipientRoles: z.array(z.string().max(100)).max(50).optional(),
  // Broadcast modes — web_push only (rejected on other channel types at rule
  // save). recipientAllUsers = every user account; recipientAllRegions = every
  // user carrying at least one region tag; recipientRegions = users in the
  // NAMED regions. Names are stored BARE ("Atlanta"), matching how
  // User/GroupMapping.regionTags are stored — the `region:` prefix only
  // exists on ASSET tags.
  recipientAllUsers: z.boolean().optional(),
  recipientAllRegions: z.boolean().optional(),
  recipientRegions: z.array(z.string().max(100)).max(200).optional(),
  // Registry tag NAMES → every user whose effective tag scope carries one.
  // Authored from the address book's Tags list (and the recipient typeahead),
  // which offers the tag registry minus the Map Regions category — those
  // rows are the region catalogue under another name and route through
  // recipientRegions, which matches region tags ONLY. This one matches the
  // FLATTENED region-plus-other scope (resolveRecipientUsers), the semantics it
  // has always had as the back-compat field it started life as.
  recipientTags: z.array(z.string().max(100)).max(200).optional(),
  // Deliver only to recipients whose own notification preference accepts this
  // channel's transport (business rule 39). Carried on the TARGET as well as
  // on the notify action because actionsToTargets is the runtime path, not
  // just the legacy mirror — a field the action holds and the target drops
  // validates, persists, renders in the wizard and changes nothing at all.
  respectUserPreference: z.boolean().optional(),
});

// ─── Rule-level email composition + escalation ──────────────────────────────
// emailComposition customizes the OUTBOUND EMAIL a rule's email targets send
// (subject / text / HTML bodies + Cc/Bcc). Templates render through
// renderNotificationTemplate (src/utils/notificationTemplate.ts) — single-brace
// {token} vocabulary, cataloged in TEMPLATE_VARIABLES. When set, each email
// target sends ONE message (full To list + Cc + Bcc) instead of the default
// one-email-per-To-address fan-out. NULL = pre-feature default behavior.
// Email-only: chat/pushbullet/web_push channels ignore it.

export const emailRecipientsSchema = z
  .object({
    recipientUserIds: z.array(z.string().max(100)).max(500).optional(), // Polaris users → their emails
    addresses: z.array(z.string().email().max(320)).max(100).optional(), // custom email addresses
    recipientRoles: z.array(z.string().max(100)).max(50).optional(), // Role IDS → every user holding them
    // Map-region NAMES → every user tagged with one. Here as well as on the
    // action because the To/Cc/Bcc token fields treat a pill the same wherever
    // it is dropped — the same reason roles are resolvable in Cc/Bcc.
    recipientRegions: z.array(z.string().max(100)).max(200).optional(),
    // Registry tag names, same story: the picker lets a tag pill be dropped in
    // Cc as readily as in To, and this schema is `.strict()` — a shape the
    // builder can produce but the parser rejects fails the whole save with an
    // unrecognized-key error naming a field the operator never typed.
    recipientTags: z.array(z.string().max(100)).max(200).optional(),
  })
  .strict();

export const emailCompositionSchema = z
  .object({
    subjectTemplate: z.string().max(500).optional().nullable(),
    bodyTextTemplate: z.string().max(10000).optional().nullable(),
    bodyHtmlTemplate: z.string().max(20000).optional().nullable(),
    cc: emailRecipientsSchema.optional().nullable(),
    bcc: emailRecipientsSchema.optional().nullable(),
  })
  .strict();

// Escalation: ordered tiers of follow-up emails while the notification stays
// unhandled (stopOn: "acknowledge" stops on ack OR clear; "clear" ignores ack).
// Tier channels must be email-type (validated at rule save). Tier subject/body
// overrides fall back to the rule's emailComposition, then the defaults.
// Swept by the escalateNotifications job (60s).
const escalationTierSchema = z
  .object({
    afterMin: z.number().int().min(1).max(10080), // ≤ 1 week
    channelId: z.string().min(1).max(100),
    to: emailRecipientsSchema.refine(
      (r) => (r.recipientUserIds?.length ?? 0) + (r.addresses?.length ?? 0) > 0,
      { message: "Escalation tier needs at least one To recipient" },
    ),
    cc: emailRecipientsSchema.optional().nullable(),
    bcc: emailRecipientsSchema.optional().nullable(),
    subjectTemplate: z.string().max(500).optional().nullable(),
    bodyTextTemplate: z.string().max(10000).optional().nullable(),
    bodyHtmlTemplate: z.string().max(20000).optional().nullable(),
    repeatEveryMin: z.number().int().min(5).max(1440).optional().nullable(),
    maxRepeats: z.number().int().min(1).max(20).optional().nullable(), // default 5 when repeating
  })
  .strict();

export const escalationSchema = z
  .object({
    stopOn: z.enum(["acknowledge", "clear"]).default("acknowledge"),
    tiers: z.array(escalationTierSchema).min(1).max(5),
  })
  .strict();

// ─── Rule shape v2: reset + unified actions (Automations redesign) ──────────
// `reset` supersedes clearBehavior/clearAfterSec (auto gains hysteresis +
// clear-sustain); `actions` supersedes `targets` as the unified fired-outcome
// list (notify | api_call | script). Legacy columns stay stored as a lossless
// mirror (legacyMirrorOfV2) and legacy INPUT stays accepted — the transform on
// ruleInputSchema folds old POST bodies into v2, so pre-rename API clients and
// the pre-wizard UI keep working against the alias paths.

export const RESET_MODES = ["manual", "auto", "timed", "condition", "event"] as const;

export type ResetMode = (typeof RESET_MODES)[number];

/**
 * Trigger types a custom reset CONDITION tree can be attached to: the ones that
 * evaluate a continuous reading, so "what has to become true again" is a
 * question with an answer. `event` / `change` fire on an instant and carry no
 * reading to recover — they reset on a timer or by hand.
 *
 * Owned here (not spelled out at each call site) because three places have to
 * agree on it: validateRuleV2, the wizard-facing `resetModesByTriggerType`
 * catalog, and the engine's decision to run the reset-tree pass at all.
 */
const TRIGGER_TYPES_WITH_RESET_CONDITIONS = ["asset_metric", "asset_state", "host_metric", "composite"] as const;

export function triggerTypeAllowsResetCondition(type: string): boolean {
  return (TRIGGER_TYPES_WITH_RESET_CONDITIONS as readonly string[]).includes(type);
}

/**
 * The mirror image: trigger types a reset EVENT can be attached to — the two
 * that fire on an instant. An event automation has no reading to recover, but
 * it usually has a counterpart event that says the thing came back
 * (`agent.disconnected` → `agent.connected`), and that is a far better answer
 * than "clear it in four hours and hope".
 *
 * Deliberately the COMPLEMENT of TRIGGER_TYPES_WITH_RESET_CONDITIONS rather
 * than an addition to it: a continuous trigger already recovers on its own
 * reading, and letting an unrelated Event clear a live threshold alert would
 * hide a device that is still over the line.
 */
const TRIGGER_TYPES_WITH_RESET_EVENT = ["event", "change"] as const;

export function triggerTypeAllowsResetEvent(type: string): boolean {
  return (TRIGGER_TYPES_WITH_RESET_EVENT as readonly string[]).includes(type);
}

/**
 * Known recovery counterparts, keyed by the TRIGGER's action pattern. Published
 * in the builder catalog so the wizard can prefill the reset pattern instead of
 * asking an operator to remember which verb Polaris writes on the way back up.
 *
 * A suggestion only — every entry is editable, and a pattern that isn't in the
 * map leaves the field blank. Each pair is a real `logEvent` call site.
 */
export const RESET_EVENT_SUGGESTIONS: Record<string, string> = {
  "agent.disconnected": "agent.connected",
  "agent.upgrade_failed": "agent.upgrade_succeeded",
  // Written when the upgrade fan-out couldn't even start on a row (rule 49) —
  // distinct from upgrade_failed, which means the attempt reached the host and
  // lost. Both recover on the same verb.
  "agent.upgrade_skipped": "agent.upgrade_succeeded",
  "agent.install_failed": "agent.installed",
  "agent.uninstall_failed": "agent.uninstalled",
  "agent.build.failed": "agent.build.completed",
  "integration.discover.error": "integration.discover.completed",
  "platform.lifecycle_changed": "platform.lifecycle_recovered",
  // Written only on a landing at `ok` — a partial recovery (critical →
  // warning) keeps the `changed` verb, so this pair clears the alert when
  // capacity is actually healthy and not a step before it.
  "capacity.severity_changed": "capacity.severity_recovered",
};

const resetEventSchema = z
  .object({
    // Glob over Event.action, same vocabulary as the event trigger.
    actionPattern: z.string().min(1).max(200),
    // Optional narrowing, mirroring the event trigger's own field.
    resourceType: z.string().max(60).optional().nullable(),
  })
  .strict();

export const resetSchema = z
  .object({
    mode: z.enum(RESET_MODES).default("manual"),
    // auto only — hysteresis: the alert recovers when the value no longer
    // meets `trigger.operator clearThreshold` (a fire at cpu >= 90 with
    // clearThreshold 80 clears at < 80). Omit = recover at the fire threshold.
    clearThreshold: z.number().optional().nullable(),
    // auto + condition — clear-sustain: the recovery must hold this long
    // before the alert auto-clears. 0/omit = clear on first recovered tick.
    sustainSec: z.number().int().min(0).max(86400).optional().nullable(),
    // The same clear-sustain as a COUNT OF READINGS, and the authority when
    // set (`sustainSec` is its wall-clock mirror — see FOR_POLLS_NOTE): the
    // recovery must hold across this many consecutive readings. "Down after 3
    // missed, reset after 5 received" already meant readings on the down path
    // (business rule 36); this is the same sentence for every other condition.
    sustainPolls: z.number().int().min(0).max(100).optional().nullable(),
    // timed only (the old clearAfterSec).
    afterSec: z.number().int().min(1).max(2592000).optional().nullable(),
    // condition only — a custom AND/OR reset tree (same leaf vocabulary as the
    // composite trigger). While the alert is firing, this tree is the sole
    // recovery authority. Allowed on ANY continuous trigger (single metric /
    // state as well as composite), restricted to leaves of the trigger's own
    // kind by validateRuleV2; the wizard seeds it with the trigger INVERTED so
    // the starting point is what the automatic reset would have done.
    condition: triggerConditionGroupSchema.optional().nullable(),
    // event only (event/change triggers) — clear when the counterpart Event
    // arrives for the SAME subject the alert is about. Same-subject is not
    // configurable: one agent reconnecting says nothing about another, and the
    // subject key is the one the alert already stores (assetId, else the
    // resource label).
    resetEvent: resetEventSchema.optional().nullable(),
  })
  .strict();

export const API_CALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export const SCRIPT_RUN_TARGETS = ["server", "agent"] as const;

// Interpreter vocabulary for the AutomationScript registry (owned here — the
// vocabulary file — so the catalog, the script service, and the routes never
// drift; the Go agent mirrors this list in scriptexec).
export const SCRIPT_INTERPRETERS = ["bash", "sh", "powershell", "cmd", "python3"] as const;

export type ScriptInterpreter = (typeof SCRIPT_INTERPRETERS)[number];

/** A notify action's delivery fields — everything that says WHO and HOW. The
 *  exported `notifyActionSchema` adds the identity + reset-linking fields
 *  (business rule 145); this core is also what an escalation-reset override
 *  holds, so an override can never itself carry a link. */
const notifyFieldsSchema = z
  .object({
    type: z.literal("notify"),
    // The action's PRIMARY channel, and the lossless single-channel mirror of
    // `channelIds` — every pre-multi-channel reader (the legacy targets
    // column, the escalation-tier converter, the automations list's recipient
    // groups) still names a channel through this field, so it must always
    // equal channelIds[0]. Enforced below rather than repaired silently: a
    // payload whose two views disagree is a client bug, and guessing which one
    // the operator meant is how an alert goes to the wrong place.
    channelId: z.string().min(1).max(100),
    // Every channel this ONE action delivers through. Absent (or a single
    // entry) is the pre-feature shape. Multiple channels exist so an operator
    // can say "page this person by email AND push" once — and, with
    // respectUserPreference below, so ONE action can carry both methods and
    // let each recipient's own preference pick which of them reaches them.
    // Resolved through notifyChannelIds(); expands to one DeliveryTarget per
    // channel, so nothing downstream needs to know an action can be plural.
    channelIds: z.array(z.string().min(1).max(100)).min(1).max(10).optional(),
    // Deliver through only the channel(s) matching each recipient's own
    // notification preference (User.notificationPreference). Business rule 39.
    //
    // Consulted ONLY when the action group actually offers both methods — an
    // action group with email alone would otherwise silently drop every
    // push-preferring recipient, i.e. the preference would delete the alert
    // rather than route it. The group test lives at execution time
    // (automationActionService), not here, because the group is the actions[]
    // list being run, which a single action cannot see.
    respectUserPreference: z.boolean().optional(),
    // Recipient sources — same semantics as deliveryTargetSchema (meaningful
    // for recipient-routed channel types only; chat/pushbullet ignore them).
    recipientUserIds: z.array(z.string().max(100)).max(500).optional(),
    addresses: z.array(z.string().email().max(320)).max(100).optional(),
    recipientScopeRegion: z.boolean().optional(),
    // Route to users whose region tags match the TRIGGERING asset's region:
    // tag(s) — works with any device filter (no region: tag needed on the
    // scope). The engine threads the asset's stripped region snapshot into
    // the expander (Notification.regionTags on the escalation sweep).
    recipientDeviceRegion: z.boolean().optional(),
    // Asset-relative level routing — see deliveryTargetSchema for why levels
    // are counted outward from the DEVICE rather than globally.
    recipientDeviceRegionLevels: z
      .array(z.number().int().min(1).max(MAX_DEVICE_REGION_LEVELS))
      .max(MAX_DEVICE_REGION_LEVELS)
      .optional(),
    // Route to the address-book contacts RESPONSIBLE for the triggering asset
    // (Contact.assetCriteria ∪ Contact.assetIds). Same union semantics as
    // recipientDeviceRegion and works with any device filter — the difference
    // is that ownership is stated once on the contact instead of per rule.
    // Email transports only: a contact is an address, not an account, so there
    // is no push subscription to reach.
    recipientAssetContacts: z.boolean().optional(),
    // Every user holding one of these ROLES (role ids — see deliveryTargetSchema).
    recipientRoles: z.array(z.string().max(100)).max(50).optional(),
    // Broadcast modes — see deliveryTargetSchema. web_push only; validated at
    // rule save so the model can never hold a state the builder won't render.
    recipientAllUsers: z.boolean().optional(),
    recipientAllRegions: z.boolean().optional(),
    recipientRegions: z.array(z.string().max(100)).max(200).optional(),
    recipientTags: z.array(z.string().max(100)).max(200).optional(),
    // Per-action email composition override; falls back to the rule-level
    // emailComposition, then the pre-feature defaults. Email transports only.
    emailComposition: emailCompositionSchema.optional().nullable(),
  })
  // NOT superRefine()d, deliberately: this schema is a member of the `action`
  // discriminated union AND is .extend()ed into the escalatable variant, and
  // both refuse a ZodEffects. The channelId === channelIds[0] coherence check
  // therefore lives in assertActionRefs (notificationRuleService), which
  // already walks every action location through allRuleActionRefs.
  .strict();

/** The tier-key of an escalation-reset override: `<severity>:<tierIdx>` on the
 *  severity's level chain (0-based tier index). */
export function escalationResetKey(severity: string, tierIdx: number): string {
  return `${severity}:${tierIdx}`;
}

// Business rule 145 — a reset Notify can MATCH a trigger Notify and, when the
// alert escalated, also tell the escalation tiers that actually sent.
const resetEscalationSchema = z
  .object({
    // Per-tier overrides keyed escalationResetKey(severity, tierIdx). A tier
    // with no entry uses its own Notify actions (the default); a tier with one
    // sends these instead. Only consulted for tiers that FIRED for the alert.
    custom: z.record(z.string().max(80), z.array(notifyFieldsSchema).max(10)).optional(),
  })
  .strict();

export const notifyActionSchema = notifyFieldsSchema
  .extend({
    // Stable identity, client-generated, so a reset action can point at this
    // one across edits (rows are positional, and removing one shifts the rest).
    id: z.string().min(1).max(64).optional(),
    // RESET ACTIONS ONLY (assertActionRefs refuses them anywhere else):
    // which trigger Notify this reset action answers for. Without
    // `customized`, delivery follows that action LIVE at reset time
    // (expandResetActions); the stored channel/recipient fields are a snapshot
    // refreshed at every save, used only if the target has gone.
    matchActionId: z.string().min(1).max(64).optional(),
    customized: z.boolean().optional(),
    // Also send the reset to the escalation tiers that sent for this alert.
    resetEscalation: resetEscalationSchema.optional().nullable(),
  })
  .strict();

/**
 * Every channel one notify action delivers through, deduped, primary first.
 *
 * THE single reader of the channelId/channelIds pair — validation, the action
 * executor, the wizard's mirror and the recipient-group renderer all go
 * through it, so "an action has one channel" survives nowhere as an
 * assumption. Falls back to the primary alone, which is what every stored
 * pre-feature action and every legacy-converted tier carries.
 */
export function notifyChannelIds(a: { channelId: string; channelIds?: string[] | null }): string[] {
  const list = a.channelIds?.length ? a.channelIds : [a.channelId];
  return Array.from(new Set(list.filter(Boolean)));
}

// SECURITY: headers are secrets (an api_call's only way to authenticate) —
// sealed at rest on the rule, the group and the delivery row, masked in every
// API response, and restored on save only for the same url (business rule
// 114(h), utils/actionHeaderMask.ts). The URL is static (no {token}s) so the SSRF host check at save time checks
// what actually gets fetched; only bodyTemplate takes template tokens.
const apiCallActionSchema = z
  .object({
    type: z.literal("api_call"),
    method: z.enum(API_CALL_METHODS).default("POST"),
    url: z
      .string()
      .max(2000)
      .url()
      .refine((u) => /^https?:\/\//i.test(u), { message: "api_call URL must be http(s)" }),
    headers: z
      .record(z.string().max(1000))
      .refine((h) => Object.keys(h).length <= 20, { message: "at most 20 headers" })
      .refine((h) => Object.keys(h).every((k) => k.length >= 1 && k.length <= 100), {
        message: "header names must be 1–100 characters",
      })
      .optional(),
    bodyTemplate: z.string().max(10000).optional().nullable(), // {token} vocabulary
    timeoutSec: z.number().int().min(1).max(60).default(15),
  })
  .strict();

const scriptActionSchema = z
  .object({
    type: z.literal("script"),
    scriptId: z.string().min(1).max(100), // AutomationScript registry id
    runOn: z.enum(SCRIPT_RUN_TARGETS),
    argsTemplate: z.string().max(2000).optional().nullable(), // {token} vocabulary
    timeoutSec: z.number().int().min(1).max(600).optional().nullable(), // overrides the script default
  })
  .strict();

// Write the `notification.triggered` audit Event on every fire. Present by
// default (a migration appended it to every pre-existing rule, and the legacy
// normalizer injects it) so nothing silently stops auditing; removing it is an
// explicit operator choice for a noisy automation.
//
// This does NOT govern the in-app Alert. The Notification row is structural —
// every NotificationDelivery hangs off its id, as do the escalation sweep,
// acknowledge/clear and the rule state machine — so a notify/api_call action
// could not exist without it. Only the audit Event is optional.
const eventActionSchema = z
  .object({
    type: z.literal("event"),
  })
  .strict();

// Book a reboot of the TRIGGERING asset (business rule 115(c)). Never sends
// one inline: it books through the reboot scheduler (rule 93's shape), so the
// opt-in, the HA refusal, the maintenance hold and the results email are the
// same as an operator's booking. `when: "now"` books for a minute from now;
// "at" books the next occurrence of `at` (HH:MM, the server's local time).
// Skipped — with an Event, not a failure — when a booking is already pending
// (one per asset) or the device rebooted within `minGapHours`, which is what
// stops a memory leak from rebooting a device in a loop. Refused on reset and
// resolved lists (assertActionRefs): a recovery is no reason to reboot.
//
// WHO hears the result uses the notify action's recipient vocabulary — the To
// fields below plus `cc` / `bcc` — resolved to addresses when the automation
// fires (resolveRebootActionRecipients), so "Asset's L1 Region Users" books
// the result to the people who own the device that tripped. `notifyEmails` is
// the pre-picker shape (typed addresses only): still accepted and folded into
// To, never written by the builder. At least one To source is required —
// enforced in assertActionRefs, since a refinement here would take this
// schema out of the discriminated union.
export const REBOOT_WHEN = ["now", "at"] as const;

export const rebootActionSchema = z
  .object({
    type: z.literal("reboot"),
    when: z.enum(REBOOT_WHEN).default("at"),
    at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "at must be HH:MM").default("02:00"),
    notifyEmails: z.array(z.string().max(254)).max(20).optional(),
    recipientUserIds: z.array(z.string().max(100)).max(500).optional(),
    addresses: z.array(z.string().email().max(320)).max(100).optional(),
    recipientRoles: z.array(z.string().max(100)).max(50).optional(),
    recipientRegions: z.array(z.string().max(100)).max(200).optional(),
    recipientTags: z.array(z.string().max(100)).max(200).optional(),
    recipientDeviceRegion: z.boolean().optional(),
    recipientDeviceRegionLevels: z
      .array(z.number().int().min(1).max(MAX_DEVICE_REGION_LEVELS))
      .max(MAX_DEVICE_REGION_LEVELS)
      .optional(),
    recipientAssetContacts: z.boolean().optional(),
    cc: emailRecipientsSchema.optional().nullable(),
    bcc: emailRecipientsSchema.optional().nullable(),
    minGapHours: z.number().int().min(1).max(720).default(24),
  })
  .strict();

/** Does a reboot action name anyone in To? Mirrors the wizard's check. */
export function rebootActionHasTo(a: z.infer<typeof rebootActionSchema>): boolean {
  return !!(a.notifyEmails?.length || a.recipientUserIds?.length || a.addresses?.length ||
    a.recipientRoles?.length || a.recipientRegions?.length || a.recipientTags?.length ||
    a.recipientDeviceRegion || a.recipientDeviceRegionLevels?.length || a.recipientAssetContacts);
}

export const actionSchema = z.discriminatedUnion("type", [
  notifyActionSchema,
  apiCallActionSchema,
  scriptActionSchema,
  eventActionSchema,
  rebootActionSchema,
]);

// Escalation v2: tiers of ACTIONS (any type), superseding the email-only tier
// shape. The stored/input escalation stays on the legacy schema until the
// escalation-v2 phase flips the sweep onto executeActions; the v2 schema +
// normalizeEscalationToV2 land now so the conversion is testable and shared.
const escalationTierV2Schema = z
  .object({
    afterMin: z.number().int().min(1).max(10080),
    actions: z.array(actionSchema).min(1).max(10),
    repeatEveryMin: z.number().int().min(5).max(1440).optional().nullable(),
    maxRepeats: z.number().int().min(1).max(20).optional().nullable(),
  })
  .strict();

export const escalationV2Schema = z
  .object({
    stopOn: z.enum(["acknowledge", "clear"]).default("acknowledge"),
    tiers: z.array(escalationTierV2Schema).min(1).max(5),
  })
  .strict();

/**
 * Repeat the alert's notifications while it stays unhandled.
 *
 * `stopOn` mirrors escalation's: "acknowledge" stops on acknowledge OR clear;
 * "clear" ignores acknowledgement and only stops when the alert clears.
 *
 * There is deliberately NO maxRepeats — unbounded-until-handled is the point.
 * `stopAfterHours` is an optional, blank-by-default absolute cut-off so an
 * unacknowledged holiday weekend doesn't require an emergency edit to a live
 * automation.
 *
 * `quiet` is LEGACY. Quiet time is now the automation's own policy (rule-level
 * `quietTime`, business rule 92); the reminder sweep never reads
 * `repeat.quiet`. It stays accepted so an older export file or API client
 * still validates: `legacyQuietTimeOf` promotes its windows into `quietTime`
 * when a body is normalized, the `migrateRepeatQuietToQuietTime` job did the
 * same for stored rows, and the policy description falls back to it only
 * when a rule has no `quietTime`.
 */
export const repeatConfigSchema = z
  .object({
    everyMin: z.number().int().min(5).max(1440),
    stopOn: z.enum(["acknowledge", "clear"]).default("acknowledge"),
    stopAfterHours: z.number().int().min(1).max(720).optional().nullable(),
    quiet: quietConfigSchema.optional().nullable(),
  })
  .strict();

export type RepeatConfig = z.infer<typeof repeatConfigSchema>;

/**
 * A severity band's OWN follow-up policy: what closing the alert out costs
 * while it is sitting at this severity.
 *
 * Just the one setting today, and it is deliberately still an OBJECT rather
 * than a loose `requireAckNote` key on the band. The reason is the third state
 * a bare boolean cannot carry: *inherit the rule's*. Every banded automation
 * that predates this stores no `followUp` at all and must keep following the
 * rule's flag, so the presence test — `followUp == null` — is what keeps "the
 * band says no" apart from "the band says nothing". A second per-severity
 * setting would join it here rather than grow another key with its own absence
 * rules.
 *
 * REMINDERS ARE NOT IN HERE. They were, briefly, and they belong to the ACTION
 * instead — see `repeat` on the escalatable notify schema. A reminder re-sends
 * an automation's notify actions, and two of them in one severity can
 * reasonably chase on different clocks, which a per-severity config cannot
 * express at all.
 *
 * The builder writes a `followUp` onto EVERY band the moment "use different
 * actions for each severity level" is on (seeded from the rule's, so turning
 * the toggle on changes nothing by itself), and strips it from all of them when
 * the toggle is off — the same on/off contract `actions` already has.
 */
const bandFollowUpSchema = z
  .object({
    requireAckNote: z.boolean().default(false),
  })
  .strict();

// ─── Per-action escalation (escalatable actions) ────────────────────────────
// A rule's top-level actions and each severity band's actions may carry their
// OWN escalation chain — "notify team A, and if unhandled 15 min later notify
// their manager" — instead of (or alongside) the rule/band-level chain. The
// chain shape is the same escalation config; accepts legacy email tiers too
// (readers normalize via normalizeEscalationToV2). ONE level only: actions
// INSIDE escalation tiers (and bandNotify.resolvedActions) stay on the bare
// actionSchema, so a nested `escalation` key fails .strict() parsing — no
// chains-of-chains. Escalation state keys are derived per chain:
// escalationTierStateKey("", j) = "j" (the rule/band-level chain — unchanged
// from pre-feature rows) and escalationTierStateKey("a<i>", j) = "a<i>:t<j>".
const perActionEscalation = z.union([escalationSchema, escalationV2Schema]).optional().nullable();

/**
 * Per-action reminders: "repeat this action" while the alert stays unhandled.
 *
 * ON THE NOTIFY SCHEMA ONLY, and only the escalatable variant — i.e. only the
 * two places an action FIRES from (`ruleInputBaseSchema.actions` and
 * `severityBandSchema.actions`). Everywhere else an action can appear it must
 * not carry one: an escalation TIER already has its own `repeatEveryMin`, a
 * `bandNotify.resolvedActions` entry announces a recovery (there is nothing
 * left to chase), and `resetActions` are the same. `REPEATABLE_ACTION_TYPES`
 * is the other half of the same decision — an `api_call` that files a ticket
 * and a `script` that writes to a registry are not the same blast radius as a
 * second email, so neither takes this key at all.
 *
 * ABSENT means "inherit the rule's `repeat`", which is what every automation
 * authored before this stores; an explicit `null` means "this action does not
 * repeat" even where the rule says otherwise. `repeatForAction` is the one
 * place that distinction is read.
 */
const perActionRepeat = repeatConfigSchema.optional().nullable();

const notifyActionEscalatableSchema = notifyActionSchema.extend({
  escalation: perActionEscalation,
  repeat: perActionRepeat,
});

const apiCallActionEscalatableSchema = apiCallActionSchema.extend({ escalation: perActionEscalation });

const scriptActionEscalatableSchema = scriptActionSchema.extend({ escalation: perActionEscalation });

export const escalatableActionSchema = z.discriminatedUnion("type", [
  notifyActionEscalatableSchema,
  apiCallActionEscalatableSchema,
  scriptActionEscalatableSchema,
  // No per-action escalation: an audit Event is instantaneous, so there is
  // nothing to chase if it goes "unhandled".
  eventActionSchema,
  // Nor on a reboot booking: it is one-shot, and its outcome has its own email.
  rebootActionSchema,
]);

export type EscalatableAction = z.infer<typeof escalatableActionSchema>;

// ─── Severity bands (value-driven severity escalation) ──────────────────────
// Higher tiers stacked on the base trigger (tier 0 = rule.severity +
// trigger.threshold + rule.actions + rule.escalation). Each band carries its
// OWN actions (run when the alert enters that band) and its own time-based
// escalation (per-band, swept band-aware). Cross-field ordering (thresholds
// monotonic in the operator direction, severities strictly increasing above
// the base) is enforced in validateRuleV2 (discriminated-union members can't
// carry a superRefine, and the base severity lives on the rule).
export const severityBandSchema = z
  .object({
    threshold: z.number(),
    severity: z.enum(SEVERITIES),
    // Per-tier comparison operator (falls back to the trigger's). Tiers share
    // the trigger's sampling — aggregation / window / dimensionFilter — so only
    // the comparison + threshold + severity + sustain vary per tier.
    operator: z.enum(COMPARATORS).optional(),
    // Per-tier sustained duration: how long the value must hold IN THIS BAND
    // before the alert takes this severity. Omitted = inherit the base
    // trigger's forDurationSec (every pre-feature band); 0 = apply immediately.
    forDurationSec: z.number().int().min(0).max(86400).optional(),
    actions: z.array(escalatableActionSchema).max(20).default([]),
    // Per-band time escalation (same shape as rule-level; accepts legacy or v2).
    escalation: z.union([escalationSchema, escalationV2Schema]).optional().nullable(),
    // Per-band follow-up policy — see bandFollowUpSchema. NULL/absent = this
    // band inherits the rule's, which is every pre-feature row.
    followUp: bandFollowUpSchema.optional().nullable(),
  })
  .strict();

export type SeverityBand = z.infer<typeof severityBandSchema>;

// Per-automation policy: which band transitions notify, and how a resolved
// (below tier 0) alert notifies. onIncrease/onResolved default on; onDecrease
// off (page when it worsens, not when it eases). resolvedMode picks whether the
// all-clear reuses the last-fired band's actions or a dedicated list.
export const bandNotifySchema = z
  .object({
    onIncrease: z.boolean().default(true),
    onDecrease: z.boolean().default(false),
    onResolved: z.boolean().default(true),
    resolvedMode: z.enum(["reuse", "dedicated"]).default("reuse"),
    resolvedActions: z.array(actionSchema).max(20).optional().nullable(),
  })
  .strict();

export type BandNotify = z.infer<typeof bandNotifySchema>;

export type DeliveryTarget = z.infer<typeof deliveryTargetSchema>;

export type EmailRecipients = z.infer<typeof emailRecipientsSchema>;

export type EmailComposition = z.infer<typeof emailCompositionSchema>;

export type EscalationTier = z.infer<typeof escalationTierSchema>;

export type EscalationConfig = z.infer<typeof escalationSchema>;

export type ResetConfig = z.infer<typeof resetSchema>;

export type NotifyAction = z.infer<typeof notifyActionSchema>;

export type ApiCallAction = z.infer<typeof apiCallActionSchema>;

export type AutomationAction = z.infer<typeof actionSchema>;

export type EscalationV2Config = z.infer<typeof escalationV2Schema>;
