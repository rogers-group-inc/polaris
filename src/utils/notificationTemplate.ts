/**
 * src/utils/notificationTemplate.ts
 *
 * Shared variable-token vocabulary + renderer for notification templating:
 * the in-app messageTemplate, rule-level email composition (subject / text /
 * HTML bodies), and escalation-tier overrides all render through here so the
 * token vocabulary lives in exactly one place. Syntax is single-brace
 * `{token}` (consistent with the original messageTemplate tokens — NOT
 * `{{ }}`). Unknown tokens are left literal so a typo stays visible in the
 * delivered message instead of silently vanishing.
 *
 * The engine snapshots the built context onto Notification.templateCtx at
 * fire time (when the rule has emailComposition/escalation), so escalation
 * emails render at T+delay with the exact fire-time values even if the asset
 * has since been deleted.
 */

import { severityCss } from "./severityStyle.js";

export interface TemplateVariable {
  token: string;
  label: string;
  description: string;
  group: "notification" | "rule" | "asset" | "escalation";
}

/**
 * The token catalog — single source of truth, surfaced to the rule-builder UI
 * via buildSchemaCatalog().templateVariables. Adding a token requires a
 * matching key in buildTemplateContext() (and, for asset-sourced tokens, the
 * asset-detail select in notificationEngine).
 *
 * ONE DELIBERATE EXCEPTION: `{ack}` has NO key in buildTemplateContext. Its
 * value is built from the Notification's own id, and the context is finished
 * BEFORE that row exists — `prisma.notification.create` is handed the completed
 * ctx to snapshot onto templateCtx. Giving it a context key would render it to
 * "" at compose time and leave nothing for the later pass to substitute. It is
 * filled instead by substituteAckToken() during delivery expansion, which works
 * precisely because unknown tokens are left literal. (It is one URL per ALERT,
 * not per recipient — see business rule 25.)
 */
export const TEMPLATE_VARIABLES: TemplateVariable[] = [
  { token: "{asset}", label: "Asset", description: "Asset hostname (or id / \"host\")", group: "notification" },
  { token: "{metric}", label: "Metric", description: "Metric / field / event action that triggered", group: "notification" },
  { token: "{value}", label: "Value", description: "Observed value at fire time", group: "notification" },
  { token: "{threshold}", label: "Threshold", description: "Configured threshold / comparison value", group: "notification" },
  { token: "{dimension}", label: "Dimension", description: "Sub-asset dimension (interface / mount / sensor / tunnel)", group: "notification" },
  { token: "{conditions}", label: "Conditions", description: "Multi-condition summary, e.g. \"2 of 3 conditions met\" (composite triggers; empty otherwise)", group: "notification" },
  { token: "{message}", label: "Message", description: "The rendered in-app notification message", group: "notification" },
  { token: "{severity}", label: "Severity", description: "Rule severity (e.g. warning)", group: "notification" },
  { token: "{severity.upper}", label: "SEVERITY", description: "Rule severity upper-cased (e.g. WARNING)", group: "notification" },
  { token: "{severity.color}", label: "Severity color", description: "Hex colour for this severity (e.g. #d97706) — for styling an HTML email", group: "notification" },
  { token: "{chart.sensor}", label: "Sensor chart", description: "Last hour of the HARDWARE SENSOR this alert fired on, with the device's own alarm periods shaded — inline chart (HTML) or a now/avg/peak line (plain text). Renders away entirely unless the automation triggers on a hardware sensor's value or its alarm", group: "notification" },
  { token: "{chart.sdwanLatency}", label: "SD-WAN latency chart", description: "Last hour of SD-WAN latency on the HEALTH CHECK and WAN member this alert fired on, with the FortiGate's own SLA target as a dashed line and the periods it called the member down shaded. Renders away entirely unless the automation triggers on SD-WAN (a health-check metric, a service rule's status, or its selected member)", group: "notification" },
  { token: "{chart.sdwanJitter}", label: "SD-WAN jitter chart", description: "Last hour of SD-WAN jitter on the health check and WAN member this alert fired on, against its SLA target. Renders away entirely unless the automation triggers on SD-WAN", group: "notification" },
  { token: "{chart.sdwanLoss}", label: "SD-WAN packet-loss chart", description: "Last hour of SD-WAN packet loss on the health check and WAN member this alert fired on, against its SLA target. Renders away entirely unless the automation triggers on SD-WAN", group: "notification" },
  { token: "{chart.cpu}", label: "CPU chart", description: "Last hour of CPU as an inline chart (HTML) or a now/avg/peak line (plain text). Dropped from an SD-WAN alert, which charts the health check instead — a firewall whose WAN link is degrading is answering its own probes perfectly", group: "notification" },
  { token: "{chart.memory}", label: "Memory chart", description: "Last hour of memory as an inline chart (HTML) or a now/avg/peak line (plain text)", group: "notification" },
  { token: "{chart.responseTime}", label: "Response-time chart", description: "Last hour of probe response time as an inline chart (HTML) or a now/avg/peak line (plain text)", group: "notification" },
  { token: "{brand.header}", label: "Letterhead", description: "This install's logo, application name and subtitle — the block in the top-right corner of the default email. Filled at send time (the logo rides as an inline image); renders away on an install with neither a subtitle nor a readable logo", group: "notification" },
  { token: "{interface.lldp}", label: "Interface LLDP neighbors", description: "The LLDP neighbours on the INTERFACE this alert fired on — what was plugged into the port, its own port, management IP and when it last advertised. Renders away entirely unless the automation triggers on an interface (status, PoE, throughput, error rate) and the port has a neighbour", group: "notification" },
  { token: "{time}", label: "Time", description: "Trigger time (ISO-8601)", group: "notification" },
  { token: "{time.local}", label: "Time (readable)", description: "Trigger time in the Polaris server's own timezone, e.g. \"Aug 12, 2026, 1:46 PM CDT\" — what the default email prints", group: "notification" },
  { token: "{link}", label: "Link", description: "Notifications page URL (empty if POLARIS_PUBLIC_URL unset)", group: "notification" },
  { token: "{ack}", label: "Acknowledge link", description: "URL of this alert's acknowledge page in Polaris — the reader signs in (unless they already are), adds a note and acknowledges. The same link for every recipient; empty when POLARIS_PUBLIC_URL is unset", group: "notification" },
  { token: "{asset.link}", label: "Open asset", description: "URL that opens this device in Polaris (empty if POLARIS_PUBLIC_URL unset)", group: "asset" },
  { token: "{asset.connectedSwitch}", label: "Connected switch", description: "Switch/port the device was last seen on, e.g. FS-248E-01/port15", group: "asset" },
  { token: "{asset.connectedAp}", label: "Connected AP", description: "Access point the device was last seen on", group: "asset" },
  { token: "{trigger.summary}", label: "What fired", description: "The trigger in the builder's own words, with the observed value — e.g. \"Response time (median over 5 minutes) is 760 ms\"", group: "notification" },
  { token: "{event.action}", label: "Event action", description: "Event-triggered alerts: the audit action that fired (e.g. integration.discover.error)", group: "notification" },
  { token: "{event.resource}", label: "Event resource", description: "Event-triggered alerts: what it happened to — the integration, user or device name", group: "notification" },
  { token: "{event.resourceType}", label: "Event resource type", description: "Event-triggered alerts: the kind of thing it happened to (integration / asset / user …)", group: "notification" },
  { token: "{event.actor}", label: "Event actor", description: "Event-triggered alerts: who or what caused it (an operator, or a system: actor)", group: "notification" },
  { token: "{event.message}", label: "Event detail", description: "Event-triggered alerts: the audit event's own text — the REASON, e.g. \"Discovery failed: RPC -11 no valid session\". Empty on every other trigger type", group: "notification" },
  { token: "{event.level}", label: "Event level", description: "Event-triggered alerts: the audit level of the source event (info / warning / error)", group: "notification" },
  { token: "{rule}", label: "Rule name", description: "Name of the triggering rule", group: "rule" },
  { token: "{rule.description}", label: "Rule description", description: "Description of the triggering rule", group: "rule" },
  { token: "{asset.ip}", label: "Asset IP", description: "Primary IP address", group: "asset" },
  { token: "{asset.mac}", label: "Asset MAC", description: "MAC address", group: "asset" },
  { token: "{asset.type}", label: "Asset type", description: "Asset type (e.g. firewall)", group: "asset" },
  { token: "{asset.status}", label: "Asset status", description: "Lifecycle status (e.g. active)", group: "asset" },
  { token: "{asset.location}", label: "Asset location", description: "Location (operator-set, falling back to learned)", group: "asset" },
  { token: "{asset.description}", label: "Asset description", description: "The device's description — operator-typed, or adopted from the device when description sync is on (empty when unset)", group: "asset" },
  { token: "{asset.manufacturer}", label: "Manufacturer", description: "Asset manufacturer", group: "asset" },
  { token: "{asset.model}", label: "Model", description: "Asset model", group: "asset" },
  { token: "{asset.serial}", label: "Serial", description: "Asset serial number", group: "asset" },
  { token: "{asset.os}", label: "OS", description: "Operating system", group: "asset" },
  { token: "{asset.osVersion}", label: "OS version", description: "Operating system version", group: "asset" },
  { token: "{asset.department}", label: "Department", description: "Asset department", group: "asset" },
  { token: "{asset.assignedTo}", label: "Assigned to", description: "Person the asset is assigned to", group: "asset" },
  { token: "{asset.tags}", label: "Asset tags", description: "Asset tags, comma-joined", group: "asset" },
  { token: "{escalation.tier}", label: "Escalation tier", description: "Escalation tier number (empty on the initial email)", group: "escalation" },
  { token: "{escalation.elapsed}", label: "Escalation elapsed", description: "Time since the notification fired (e.g. 1h 30m)", group: "escalation" },
  { token: "{repeat.attempt}", label: "Reminder number", description: "Which reminder this is (empty on the initial notification)", group: "escalation" },
  { token: "{repeat.elapsed}", label: "Reminder elapsed", description: "Time since the alert fired, on a reminder (e.g. 1h 30m)", group: "escalation" },
  { token: "{repeat.quiet}", label: "Quiet period ended", description: "On the first reminder after a quiet period, a sentence saying reminders have resumed and how long the alert has been active. Empty on every other send", group: "escalation" },
  { token: "{repeat.policy}", label: "Reminder policy", description: "Whether this alert will keep reminding, in words — e.g. \"Reminders every 15 minutes until acknowledged.\" Empty (and its row prunes away) when the automation doesn't repeat", group: "escalation" },
  { token: "{escalation.policy}", label: "Escalation policy", description: "Whether this alert goes over the reader's head if they leave it — e.g. \"Escalates in 30 minutes if not acknowledged.\" Empty when the automation has no escalation at the severity it fired at", group: "escalation" },
];

/** Escape a string for safe embedding in HTML text/attribute content. */
export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Asset fields the template context draws on (subset of the Asset row). */
export interface AssetTemplateDetail {
  /** Needed for {asset.link}; the rest are rendered directly. */
  id?: string | null;
  ipAddress?: string | null;
  macAddress?: string | null;
  /** "<switch>/port<N>" — where the device was last seen wired. */
  lastSeenSwitch?: string | null;
  /** The AP the device was last seen associated with. */
  lastSeenAp?: string | null;
  assetType?: string | null;
  status?: string | null;
  location?: string | null;
  learnedLocation?: string | null;
  /**
   * The device's description. Operator-typed, or adopted from the device's own
   * admin description when description sync is on (business rule 14) — which is
   * where a site's "what is this box for" text usually already lives, and the
   * reason it belongs in an alert body: "Front-office PoE switch, closet B"
   * tells the reader what broke in a way a hostname does not.
   */
  description?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  os?: string | null;
  osVersion?: string | null;
  department?: string | null;
  assignedTo?: string | null;
  tags?: string[] | null;
}

export interface TemplateContextParts {
  /** The `{asset}` label — hostname / assetId / "host". */
  asset?: string;
  metric?: string;
  value?: string;
  threshold?: string;
  dimension?: string;
  /** Composite triggers only — "k of n conditions met". */
  conditions?: string;
  message?: string;
  severity?: string;
  time?: Date | string;
  link?: string | null;
  ruleName?: string;
  ruleDescription?: string | null;
  /** "Response time (median over 5 minutes) is 760 ms" — utils/triggerSummary. */
  triggerSummary?: string;
  /**
   * What happens if nobody acts — the two sentences from
   * notificationTypes.followUpPolicy, resolved for the severity this alert
   * FIRED at. Supplied only on a fire (and a band change); deliberately absent
   * on a recovery or a reset, where an alert that is already over has no
   * follow-up left to describe.
   */
  repeatPolicy?: string;
  escalationPolicy?: string;
  /**
   * Event-path alerts: the source Event's own identity. Most event automations
   * fire on things that are NOT assets (an integration, a user, the host),
   * where the device facts prune away and this is the only thing the body can
   * say about what happened.
   */
  event?: {
    action?: string | null;
    level?: string | null;
    resourceType?: string | null;
    resourceName?: string | null;
    actor?: string | null;
    /**
     * The Event's own message — the REASON, which the action name alone never
     * gives ("integration.discover.error" vs "Discovery failed: RPC -11 no
     * valid session"). It reaches the email as its own facts row rather than
     * through `{message}`, so it survives an operator replacing the rule's
     * message template — and the 12 seeded event automations, which set
     * `messageTemplate: "{value}"` precisely to surface this text, no longer
     * depend on that indirection to say why anything failed.
     */
    message?: string | null;
  } | null;
  assetDetail?: AssetTemplateDetail | null;
  escalationTier?: number;
  escalationElapsed?: string;
  /** Which reminder this is; empty on the initial notification. */
  repeatAttempt?: number;
  repeatElapsed?: string;
  /**
   * On the reminder that ENDS a quiet-time hold: reminders have resumed, and
   * the alert has been active this long (business rule 44). Supplied by the
   * escalation sweep's repeat pass; empty everywhere else, including on the
   * ordinary reminders inside a repeat schedule with no quiet time at all.
   */
  repeatQuiet?: string;
  /**
   * IANA zone to render `{time.local}` in. Omitted = the server's zone, which
   * is what every caller had before User.timezone existed and what every
   * recipient-less surface (webhook, Slack post, test preview) still wants.
   *
   * The EMAIL path sets this per recipient group — see rebuildForTimeZone in
   * notificationRecipientService. It is deliberately NOT part of the snapshot
   * identity: Notification.templateCtx stores the server-zone rendering, and a
   * per-recipient copy is rebuilt from the same parts rather than stored.
   */
  timeZone?: string | null;
}

const str = (v: string | null | undefined): string => v ?? "";

/**
 * "Aug 12, 2026, 1:46 PM CDT" — the trigger time as a person reads it, in
 * `timeZone` when one is given, otherwise the SERVER's zone.
 *
 * The zone used to be unconditionally the server's, on the reasoning that a
 * recipient's was unknowable from an email. That stopped being true with
 * User.timezone: the delivery layer now groups an alert's To list by the
 * recipients' zones and rebuilds the body once per group, so each copy names
 * the reader's own wall clock. Callers with no recipient in hand (webhooks,
 * a Slack post, the automation test preview) pass nothing and keep the server
 * zone, which is what they always had.
 *
 * `timeZoneName: "short"` is NOT optional here and must survive any edit: two
 * operators comparing the same alert in different zones need the label to tell
 * the copies apart, and it is the only thing that makes an "auto" recipient's
 * server-zone rendering self-describing.
 *
 * An unresolvable zone falls back to the server's rather than throwing — an
 * alert must never fail to send over a bad timezone string.
 *
 * ISO-8601 stays available as `{time}` for anything machine-read. It is a poor
 * default for a body, though: besides being unfriendly it is a 24-character
 * string with no break opportunity, which wrapped mid-token inside the facts
 * table. Returns "" for an unparseable input rather than "Invalid Date", so the
 * row prunes away instead of mailing an error.
 */
export function formatLocalTime(value: Date | string | null | undefined, timeZone?: string | null): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return d.toLocaleString("en-US", {
      ...(timeZone ? { timeZone } : {}),
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    // Either the zone is one this build's ICU cannot apply, or there is no
    // ICU data at all. Retry once WITHOUT the zone before giving up, so a bad
    // User.timezone costs the reader only the label they asked for and not the
    // whole legible timestamp.
    if (timeZone) return formatLocalTime(value, null);
    // A Node build without full ICU: the ISO form beats nothing.
    return d.toISOString();
  }
}

/**
 * Re-render an ALREADY-BUILT context's zone-dependent tokens in `timeZone`.
 *
 * The email path needs one body per recipient zone, but by then the context is
 * a flat token→string map (it has been snapshotted onto
 * Notification.templateCtx and may have come back out of the database) — the
 * TemplateContextParts it was built from are long gone. This rebuilds the
 * derived tokens from the ones that survived the flattening.
 *
 * `{time}` is the ISO-8601 instant and is what makes this possible: it is
 * kept in the context precisely because it is machine-read, so `{time.local}`
 * can always be re-derived from it. That is the ONLY zone-dependent token in
 * the catalogue — every other time-ish token ({escalation.elapsed},
 * {repeat.elapsed}) is a DURATION, which reads the same in every zone.
 *
 * Anything a new zone-dependent token is added for must be re-derived here
 * too, or half an alert's copies will disagree with the other half.
 *
 * A context with no usable `{time}` is returned untouched rather than blanked:
 * a pre-upgrade snapshot keeps whatever `{time.local}` it was stored with.
 */
export function retimeContext(
  ctx: Record<string, string>,
  timeZone: string,
): Record<string, string> {
  const iso = ctx["time"];
  if (!iso) return ctx;
  const local = formatLocalTime(iso, timeZone);
  if (!local) return ctx;
  return { ...ctx, "time.local": local };
}

/**
 * Flatten the fire-time parts into the token→string map the renderer consumes.
 * Every cataloged token gets a key (missing parts render as ""), so the map
 * serializes cleanly onto Notification.templateCtx.
 */
export function buildTemplateContext(parts: TemplateContextParts): Record<string, string> {
  const a = parts.assetDetail;
  const severity = str(parts.severity);
  const time = parts.time instanceof Date ? parts.time.toISOString() : str(parts.time);
  return {
    "asset": str(parts.asset),
    "metric": str(parts.metric),
    "value": str(parts.value),
    "threshold": str(parts.threshold),
    "dimension": str(parts.dimension),
    "conditions": str(parts.conditions),
    "message": str(parts.message),
    "severity": severity,
    "severity.upper": severity.toUpperCase(),
    "severity.color": severityCss(severity),
    "time": time,
    // A pre-upgrade Notification.templateCtx has no key for this, so an
    // escalation re-rendering that snapshot renders it blank (unknown:"blank"
    // for our own default body) and the "Raised" row prunes away — a missing
    // row, never a literal "{time.local}" in an operator's inbox.
    "time.local": formatLocalTime(parts.time ?? null, parts.timeZone ?? null),
    "link": str(parts.link),
    "rule": str(parts.ruleName),
    "rule.description": str(parts.ruleDescription),
    "trigger.summary": str(parts.triggerSummary),
    "event.action": str(parts.event?.action),
    "event.level": str(parts.event?.level),
    "event.resource": str(parts.event?.resourceName),
    "event.resourceType": str(parts.event?.resourceType),
    "event.actor": str(parts.event?.actor),
    "event.message": str(parts.event?.message),
    "asset.ip": str(a?.ipAddress),
    "asset.mac": str(a?.macAddress),
    "asset.type": str(a?.assetType),
    "asset.status": str(a?.status),
    "asset.location": str(a?.location ?? a?.learnedLocation),
    "asset.description": str(a?.description),
    "asset.manufacturer": str(a?.manufacturer),
    "asset.model": str(a?.model),
    "asset.serial": str(a?.serialNumber),
    "asset.os": str(a?.os),
    "asset.osVersion": str(a?.osVersion),
    "asset.department": str(a?.department),
    "asset.assignedTo": str(a?.assignedTo),
    "asset.tags": (a?.tags ?? []).join(", "),
    "asset.connectedSwitch": str(a?.lastSeenSwitch),
    "asset.connectedAp": str(a?.lastSeenAp),
    "asset.link": a?.id ? (assetPageUrl(a.id) ?? "") : "",
    // NOTE: no "ack" key — see the TEMPLATE_VARIABLES comment. It is
    // substituted per recipient at delivery-expansion time.
    "escalation.tier": parts.escalationTier !== undefined ? String(parts.escalationTier) : "",
    "escalation.elapsed": str(parts.escalationElapsed),
    // Present-but-EMPTY on the initial send, exactly like the escalation pair
    // above. The renderer leaves an unknown token in place, so a subject
    // containing {repeat.attempt} would print the literal braces on the first
    // email if these keys were absent. The sweep's repeat pass supplies them.
    "repeat.attempt": parts.repeatAttempt !== undefined ? String(parts.repeatAttempt) : "",
    "repeat.elapsed": str(parts.repeatElapsed),
    // Same present-but-empty contract as the pair above, and for the same
    // reason: the default body prints this token on EVERY send, so a missing
    // key would show the literal braces on the initial alert.
    "repeat.quiet": str(parts.repeatQuiet),
    // Present-but-empty everywhere they don't apply, for the same reason the
    // four above are: the renderer leaves an UNKNOWN token in place, so a
    // body printing {repeat.policy} on a non-repeating alert would show the
    // literal braces if the key were absent instead of blank.
    "repeat.policy": str(parts.repeatPolicy),
    "escalation.policy": str(parts.escalationPolicy),
  };
}

/**
 * Stamp a recovery sentence into BOTH the headline slot and `{message}`.
 *
 * The default alert body leads with `{trigger.summary}` — "what this email is
 * about" — and deliberately prints no `{message}` line under it, because on a
 * FIRE the two say the same thing. On a RECOVERY they don't: the trigger
 * sentence would re-render the recovered reading ("Response time … is 120 ms"),
 * which under a green "resolved" header reads like a fresh alert about a healthy
 * device — and the one sentence that says it came back would appear nowhere.
 *
 * So the recovery sentence takes the headline as well. `{message}` keeps it too,
 * which leaves the in-app card, the chat/push bodies and any operator template
 * that prints `{message}` exactly as they were.
 */
export function setRecoverySentence(ctx: Record<string, string>, sentence: string): void {
  ctx["message"] = sentence;
  ctx["trigger.summary"] = sentence;
}

const TOKEN_RE = /\{([a-zA-Z][\w.]*)\}/g;

/**
 * Tokens that are deliberately NOT in buildTemplateContext because they are
 * resolved after the context exists:
 *   - `ack` is per-RECIPIENT (notificationRecipientService, at fan-out)
 *   - `chart.*` are per-DELIVERY inline images (alertChartService, at send)
 *
 * The renderer must leave these alone no matter what `unknown` says, or the
 * later pass finds nothing to substitute.
 *
 * The interface half (`{interface.lldp}` — the LLDP neighbours on the port an
 * alert is about, read at delivery by alertInterfaceService) is deferred for the
 * same reason the charts are: it needs a DB read, and its HTML and plain-text
 * forms are different markup, which one context string can't carry.
 *
 * The branding half (`{brand.header}` — the install's logo, application name and
 * subtitle in the email's top-right corner, built at delivery by
 * alertBrandService) is deferred for the same pair of reasons: the logo rides as
 * an inline CID attachment, which one context string can't carry, and the HTML
 * and plain-text forms are different markup. Deferring it also means an
 * escalation email sent hours later carries the CURRENT branding rather than a
 * fire-time snapshot of it.
 *
 * Every half is matched by PREFIX rather than by an enumerated list. An
 * enumerated one was wrong within a week: `{chart.trigger}` shipped in the
 * default body, wasn't added here, and was silently blanked at compose time —
 * the token vanished before the delivery pass that fills it, so the chart the
 * alert is actually about never led the email. A prefix can't drift, and this
 * file is a pure util that must not import the chart service (which pulls in
 * Prisma) just to enumerate its own tokens.
 */
const DEFERRED_TOKEN_NAMES: ReadonlySet<string> = new Set(["ack"]);

export function isDeferredToken(name: string): boolean {
  return (
    DEFERRED_TOKEN_NAMES.has(name) ||
    name.startsWith("chart.") ||
    name.startsWith("interface.") ||
    name.startsWith("brand.")
  );
}

/**
 * Render a template against a context map. Single regex pass — substituted
 * values are never re-interpolated (a value containing "{threshold}" stays
 * literal). Unknown tokens are left as-is. With opts.html, interpolated
 * VALUES are HTML-escaped; the operator's own template markup is not.
 */
export function renderNotificationTemplate(
  template: string,
  ctx: Record<string, string>,
  opts?: { html?: boolean; unknown?: "keep" | "blank" },
): string {
  return template.replace(TOKEN_RE, (match, name: string) => {
    if (!(name in ctx)) {
      // A deferred token is filled by a LATER pass — blanking it here would
      // leave that pass nothing to find.
      if (isDeferredToken(name)) return match;
      // Operator templates keep an unknown token literal so a typo is visible
      // in the delivered message. Polaris's OWN default body passes
      // unknown:"blank": a context assembled before a token existed (an
      // escalation re-rendering a pre-upgrade Notification.templateCtx) must
      // not leak "{rule}" into a subject line.
      return opts?.unknown === "blank" ? "" : match;
    }
    const v = ctx[name];
    return opts?.html ? escapeHtml(v) : v;
  });
}

/** Do any of these templates reference an `{asset.*}` detail token? */
export function templateNeedsAsset(templates: Array<string | null | undefined>): boolean {
  return templates.some((t) => typeof t === "string" && /\{asset\.[\w.]*\}/.test(t));
}

/** Automations-page (Alerts tab) URL for the {link} token + the "View:" footer
 *  (null when POLARIS_PUBLIC_URL is unset). Renamed page; the server keeps a
 *  permanent /notifications.html redirect for links already delivered. */
export function notificationsPageUrl(): string | null {
  const base = process.env.POLARIS_PUBLIC_URL;
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/automations.html`;
}

/**
 * URL that opens ONE device in Polaris — the hash form app.js's
 * processSearchHash already understands, so an emailed link lands on the
 * asset's slide-over rather than a list the reader has to search.
 * Null when POLARIS_PUBLIC_URL is unset (a relative URL is useless in mail).
 */
export function assetPageUrl(assetId: string | null | undefined): string | null {
  const base = process.env.POLARIS_PUBLIC_URL;
  if (!base || !assetId) return null;
  return `${base.replace(/\/$/, "")}${assetPath(assetId)}`;
}

/** The acknowledge page's path for ONE alert. Shared by both callers below. */
function ackPath(notificationId: string): string {
  return `/alert-ack.html?id=${encodeURIComponent(notificationId)}`;
}

/**
 * Acknowledge URL for an EMAIL body. Null without a public URL, mirroring
 * notificationsPageUrl: a relative link in a mail client resolves against
 * nothing.
 *
 * The URL names the ALERT, never the recipient — the page behind it is an
 * ordinary logged-in Polaris page, so WHO acknowledged comes from the session
 * the reader signs into rather than from the link. That is what lets one
 * composed body carry a working button for every recipient at once, instead of
 * fanning the send out one message per person (business rule 25).
 */
export function ackUrlForEmail(notificationId: string): string | null {
  const base = process.env.POLARIS_PUBLIC_URL;
  if (!base) return null;
  return `${base.replace(/\/$/, "")}${ackPath(notificationId)}`;
}

/**
 * Same link for a WEB PUSH payload. Never null — like pushDeepLinkUrl it falls
 * back to a relative path, which the service worker resolves against its own
 * origin, so push acknowledgement keeps working on installs that never set a
 * public URL.
 */
export function ackUrlForPush(notificationId: string): string {
  const base = process.env.POLARIS_PUBLIC_URL;
  const path = ackPath(notificationId);
  return base ? `${base.replace(/\/$/, "")}${path}` : path;
}

/**
 * The follow-up policy sentences as ONE line, for surfaces with no facts
 * table to prune — a push body, a chat message.
 *
 * Reads the rendered context rather than the rule, so it cannot disagree with
 * what the email said about the same alert: both are the strings the engine
 * snapshotted at fire time. Returns "" when the automation neither repeats nor
 * escalates, which is the signal to leave the body exactly as it was.
 *
 * The quiet-period sentence leads when there is one, because on that send it
 * is the news and the policy sentences behind it are the background — a phone
 * notification is read one line at a time.
 */
export function followUpLine(ctx: Record<string, string>): string {
  return [ctx["repeat.quiet"], ctx["repeat.policy"], ctx["escalation.policy"]]
    .filter((s) => s && s.trim())
    .join(" ");
}

/** The device page's path for ONE asset. Shared by both callers. */
function assetPath(assetId: string): string {
  return `/assets.html#view=asset:${encodeURIComponent(assetId)}`;
}

/**
 * The device page for a WEB PUSH payload — the `assetPageUrl` sibling of
 * `ackUrlForPush`, and null for the same reason that one is never null is not
 * available here: an alert about Polaris itself, an integration or a user has
 * no asset, and the tray button has to disappear rather than point at
 * `#view=asset:undefined`. When there IS an asset it falls back to a relative
 * path (which the service worker resolves against its own origin) so the
 * button works on installs that never set a public URL — exactly the reason
 * assetPageUrl, whose callers embed it in EMAIL and therefore need an
 * absolute one, returns null in that case instead.
 */
export function assetUrlForPush(assetId: string | null | undefined): string | null {
  if (!assetId) return null;
  const base = process.env.POLARIS_PUBLIC_URL;
  const path = assetPath(assetId);
  return base ? `${base.replace(/\/$/, "")}${path}` : path;
}

const ACK_TOKEN_RE = /\{ack\}/g;

/**
 * Fill the deferred `{ack}` token once the alert has an id. Called at delivery
 * expansion, not at compose time — see the TEMPLATE_VARIABLES note.
 * A null url (no POLARIS_PUBLIC_URL, so nothing in the mail could resolve)
 * renders empty, so a template that mentions {ack} degrades to a body without a
 * link rather than mailing the literal token.
 */
export function substituteAckToken(
  text: string,
  url: string | null,
  opts?: { html?: boolean },
): string {
  if (!text) return text;
  const value = url ?? "";
  return text.replace(ACK_TOKEN_RE, opts?.html ? escapeHtml(value) : value);
}

/** Where a push notification should land, per enrolling surface. */
export const PUSH_DEEP_LINK_PATHS = {
  desktop: "/automations.html",
  mobile: "/mobile.html#more/alerts",
} as const;

export type PushSurface = keyof typeof PUSH_DEEP_LINK_PATHS;

export function normalizePushSurface(value: unknown): PushSurface {
  return value === "mobile" ? "mobile" : "desktop";
}

/**
 * Deep link for a web-push payload. Unlike `notificationsPageUrl` this NEVER
 * returns null: when POLARIS_PUBLIC_URL is unset we emit a relative path,
 * which the service worker resolves fine via client.navigate()/openWindow().
 * That also removes the old failure mode where an unset public URL sent every
 * push to sw.js's hardcoded desktop fallback regardless of surface.
 */
export function pushDeepLinkUrl(surface: unknown): string {
  const path = PUSH_DEEP_LINK_PATHS[normalizePushSurface(surface)];
  const base = process.env.POLARIS_PUBLIC_URL;
  return base ? `${base.replace(/\/$/, "")}${path}` : path;
}

/** "92m" → "1h 32m"-style elapsed formatting for {escalation.elapsed}. */
export function formatElapsed(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}
