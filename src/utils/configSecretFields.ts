/**
 * src/utils/configSecretFields.ts — which JSON keys hold secrets.
 *
 * Consumed by the Prisma extension in src/db.ts, which seals these fields on
 * write and opens them on read for the four secret-bearing JSON columns:
 * Credential.config, Integration.config, NotificationChannel.config, and
 * Setting.value (LDAP bind password, OIDC client secret, agent signing key,
 * event-archive SFTP password, the scheduled-backup passphrase).
 *
 * ── Why a name union rather than per-type lists ────────────────────────────────
 * Each of those services already owns a per-type secret-field list for MASKING
 * (credentialService's SECRET_FIELDS_BY_TYPE, integrations' stripSecret, the
 * `secret: true` flags in CHANNEL_TYPE_META). Encryption deliberately does NOT
 * reuse them, for two reasons:
 *
 *   1. Coupling. db.ts is the lowest layer in the graph; importing three
 *      services' vocabularies into it would invert the dependency direction and
 *      drag the notification type catalogue into every process.
 *   2. Failure direction. A per-type list that MISSES a field stores a real
 *      secret in plaintext, silently. A name union that includes a field which
 *      happens not to be secret for some type merely encrypts a harmless value.
 *      Over-sealing is a non-event; under-sealing is the bug being fixed.
 *
 * So: any string leaf whose KEY is in this set gets sealed, wherever it appears
 * in the JSON (the walk is recursive because Integration.config nests secrets
 * inside per-class blocks, and Setting.value shapes vary per key).
 *
 * ── Adding a field ────────────────────────────────────────────────────────────
 * When you add a config field that holds a secret, add its key here IN THE SAME
 * CHANGE as the masking entry. Sealing is idempotent and openValue passes
 * plaintext through, so adding a name is safe on an existing install: new writes
 * seal, and the backfillSecretEncryption job seals what is already stored.
 */

/**
 * JSON keys whose string values are encrypted at rest.
 *
 * Sources, so this stays auditable against the masking lists:
 *   Credential   — community, authKey, privKey (snmp); password (winrm);
 *                  password, privateKey (ssh); apiToken (restapi)
 *   Integration  — apiToken, fortigateApiToken, password, clientSecret,
 *                  bindPassword
 *   Channel      — password (smtp), clientSecret (oauth_m365),
 *                  accessToken (pushbullet), webhookUrl (slack, teams),
 *                  privateKey (web_push VAPID)
 *   Setting      — bindPassword (ldap), clientSecret (oidc),
 *                  keystorePassword (agent signing keystore),
 *                  privateKey / signingKey,
 *                  password / passphrase (event-archive SFTP, backupSchedule)
 */
export const SECRET_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "accessToken",
  "apiToken",
  "authKey",
  "bindPassword",
  "clientSecret",
  "community",
  "fortigateApiToken",
  "keystorePassword",
  "passphrase",
  "password",
  "privKey",
  "privateKey",
  "secretAccessKey",
  "signingKey",
  "token",
  "webhookUrl",
]);

/**
 * JSON keys whose value is a MAP of secrets — every string value in it is
 * sealed, whatever the inner key (business rule 114(h)). `headers` is an
 * api_call action's custom request headers: the only way such an action
 * authenticates, so in real use an API key or bearer token under a name the
 * operator chose ("Authorization", "X-API-Key"). Only a plain object counts —
 * the Generic API integration's `headers` is an ARRAY of {name, value} rows and
 * is not touched by this rule.
 */
export const SECRET_MAP_KEYS: ReadonlySet<string> = new Set(["headers"]);

function isSecretMap(key: string, value: unknown): value is Record<string, unknown> {
  return SECRET_MAP_KEYS.has(key) && value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/**
 * The automation tables whose action JSON can carry an api_call's headers
 * (rule 114(h)), and the columns to walk. Separate from SECRET_BEARING_MODELS
 * because those are single-`config`/`value` models; these hold actions in
 * several columns.
 */
export const SECRET_ACTION_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  NotificationRule: ["actions", "escalation", "severityBands", "bandNotify", "resetActions", "reset"],
  AlertGroup: ["actions", "resetActions", "escalation"],
  NotificationDelivery: ["meta"],
};

/** Prisma model names whose JSON payload is walked for secret fields. */
export const SECRET_BEARING_MODELS: ReadonlySet<string> = new Set([
  "Credential",
  "Integration",
  "NotificationChannel",
  "Setting",
]);

/**
 * The JSON column to walk, per model. Setting stores its blob in `value`; the
 * other three use `config`.
 */
export function secretJsonFieldFor(model: string): "config" | "value" | null {
  if (model === "Setting") return "value";
  if (SECRET_BEARING_MODELS.has(model)) return "config";
  return null;
}

/** Guard against a malformed or hostile blob costing unbounded work. */
const MAX_WALK_DEPTH = 8;

/**
 * Depth budget for walking a whole Prisma READ RESULT rather than a lone config
 * blob. A nested read stacks hops before the blob is even reached — e.g.
 * findMany array → reservation row → subnet → integration → config → apiToken —
 * so the blob-sized budget above would truncate before finding anything.
 */
export const RESULT_WALK_DEPTH = 16;

/**
 * Should the walk descend into this object, or is it an opaque value?
 *
 * Only PLAIN objects (and arrays, handled by the caller) are structure to walk.
 * Everything else — Date, Buffer, Prisma's Decimal, class instances — is a leaf.
 *
 * This matters because `transformSecretFields` REBUILDS the objects it walks:
 * descending into a Date would rebuild it as `{}` (a Date has no own enumerable
 * properties), silently destroying every `createdAt` / `lastSeen` in a result
 * row. Harmless while the walk only ever saw JSON config blobs; load-bearing now
 * that it also walks read results to open nested relation payloads.
 */
function isWalkable(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively transform every string leaf whose key is a secret key.
 *
 * Returns a NEW structure — never mutates the input, because Prisma args and
 * query results are shared with the caller. Non-objects, numbers, booleans and
 * nulls pass through untouched, as do non-plain objects (see `isWalkable`).
 */
export function transformSecretFields(
  value: unknown,
  transform: (plain: string) => string,
  depth = 0,
  maxDepth = MAX_WALK_DEPTH,
): unknown {
  if (depth > maxDepth) return value;
  if (Array.isArray(value)) {
    return value.map((v) => transformSecretFields(v, transform, depth + 1, maxDepth));
  }
  if (value === null || typeof value !== "object") return value;
  if (!isWalkable(value)) return value;

  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === "string" && SECRET_CONFIG_KEYS.has(k)) {
      out[k] = transform(v);
    } else if (isSecretMap(k, v)) {
      const m: Record<string, unknown> = {};
      for (const [mk, mv] of Object.entries(v)) m[mk] = typeof mv === "string" ? transform(mv) : mv;
      out[k] = m;
    } else {
      out[k] = transformSecretFields(v, transform, depth + 1, maxDepth);
    }
  }
  return out;
}

/**
 * Does this structure hold at least one secret-keyed string matching `predicate`?
 *
 * A read-only pre-scan for the read path: `transformSecretFields` rebuilds every
 * object it touches, which is far too much allocation to run over every row of
 * every query. In practice almost nothing coming back from the database carries a
 * sealed secret, so this answers "is there anything to do?" without allocating —
 * `for…in` over a plain object, no `Object.entries` arrays — and the rebuild only
 * runs on the rare result that actually needs it.
 */
export function containsSecretField(
  value: unknown,
  predicate: (v: string) => boolean,
  depth = 0,
  maxDepth = RESULT_WALK_DEPTH,
): boolean {
  if (depth > maxDepth) return false;
  if (Array.isArray(value)) {
    for (const v of value) {
      if (containsSecretField(v, predicate, depth + 1, maxDepth)) return true;
    }
    return false;
  }
  if (value === null || typeof value !== "object") return false;
  if (!isWalkable(value)) return false;

  const src = value as Record<string, unknown>;
  for (const k in src) {
    const v = src[k];
    if (typeof v === "string") {
      if (SECRET_CONFIG_KEYS.has(k) && predicate(v)) return true;
    } else if (isSecretMap(k, v)) {
      for (const mk in v) {
        const mv = v[mk];
        if (typeof mv === "string" && predicate(mv)) return true;
      }
    } else if (containsSecretField(v, predicate, depth + 1, maxDepth)) {
      return true;
    }
  }
  return false;
}
