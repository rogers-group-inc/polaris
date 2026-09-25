/**
 * src/services/credentialService.ts
 *
 * Named credential store for monitoring probes (SNMP v2c/v3, WinRM, SSH,
 * REST API). Mirrors the Integration model: plaintext at rest, masked at
 * the API boundary via `stripSecrets()`. ICMP doesn't use credentials so
 * there's no "icmp" type here.
 *
 * "restapi" credentials carry a baseUrl + bearer token pair so manually-
 * created assets can be probed via the same REST-API path FMG/FortiGate-
 * discovered firewalls use through their integration's stored token.
 *
 * "http" credentials carry AUTHENTICATION ONLY — bearer token, basic, or digest
 * (utils/httpCheck.ts). They used to carry the whole HTTP health check as well
 * (path, expected status, expected body), but that half moved to a manufacturer
 * custom widget in 2026-08 because the two vary on different axes: a login is
 * per-vendor or per-site, while "which path, expecting what" is per-vendor and
 * model. Sharing one row meant a second path needed a second copy of the same
 * password, and rotating the password meant editing every path.
 *
 * There is no "none" mode: an unauthenticated check is a widget with no
 * credential attached, not a credential that authenticates nothing.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { SECRET_MASK, isMaskedSecret } from "../utils/secretMask.js";
import {
  type HttpCheckConfig,
  normalizeHttpPath,
  resolveHttpAuthMode,
  HTTP_CREDENTIAL_AUTH_MODES,
  type HttpAuthConfig,
} from "../utils/httpCheck.js";

export type CredentialType = "snmp" | "winrm" | "ssh" | "restapi" | "http";

export interface SnmpV2cConfig {
  version: "v2c";
  community: string;
  port?: number;
}

export type SnmpV3AuthProtocol = "MD5" | "SHA" | "SHA224" | "SHA256" | "SHA384" | "SHA512";
export type SnmpV3PrivProtocol = "DES" | "AES" | "AES256B" | "AES256R";

export const SNMP_V3_AUTH_PROTOCOLS: readonly SnmpV3AuthProtocol[] = [
  "MD5", "SHA", "SHA224", "SHA256", "SHA384", "SHA512",
];
export const SNMP_V3_PRIV_PROTOCOLS: readonly SnmpV3PrivProtocol[] = [
  "DES", "AES", "AES256B", "AES256R",
];

export interface SnmpV3Config {
  version: "v3";
  username: string;
  securityLevel: "noAuthNoPriv" | "authNoPriv" | "authPriv";
  authProtocol?: SnmpV3AuthProtocol;
  authKey?: string;
  privProtocol?: SnmpV3PrivProtocol;
  privKey?: string;
  port?: number;
}

export type SnmpConfig = SnmpV2cConfig | SnmpV3Config;

export interface WinRmConfig {
  username: string;
  password: string;
  port?: number;
  useHttps?: boolean;
}

/**
 * SSH credential. `privateKey` wins over `password` at every connect site
 * (remoteExec.withSshClient, monitoringService.probeSsh).
 *
 * `publicKey` is the `authorized_keys` one-liner for a Polaris-GENERATED
 * keypair (windowsSshOnboardingService). It is deliberately NOT a secret:
 * it must survive `stripSecrets` so the Windows onboarding script can be
 * re-rendered at any time from the stored credential. Regenerating the key
 * to recover a public half nobody kept would mean re-touching every endpoint
 * that trusts the old one.
 */
export interface SshConfig {
  username: string;
  password?: string;
  privateKey?: string;
  publicKey?: string;
  /**
   * Unlocks an ENCRYPTED `privateKey`. Only meaningful for an operator-supplied
   * key from their own escrow — a Polaris-generated deployment key is never
   * exported, so a passphrase on it would just sit next to the key it protects.
   * Without this, ssh2 fails at parse with "Encrypted private OpenSSH key
   * detected, but no passphrase given".
   */
  passphrase?: string;
  port?: number;
  /**
   * Authenticate the SERVER via trust-on-first-use host-key pinning
   * (sshHostKeyService). Opt-in, mirroring WinRM's `verifyTls`: absent /
   * false keeps the pre-2026-08 behavior where ssh2 accepts ANY host key,
   * so enabling it can't break an install whose hosts were never pinned.
   * New credentials default it ON in the form.
   */
  verifyHostKey?: boolean;
}

/**
 * REST API credential — a base URL + bearer token. Used by the REST API
 * polling method when the asset's source doesn't already have a token
 * (i.e. manually-created assets, or any asset where the operator wants
 * to override with a different token). FMG/FortiGate-discovered firewalls
 * keep using the integration's stored token by default.
 *
 * verifyTls defaults to false (parity with FortiOS REST behaviour where
 * self-signed device certs are common); operators flip it on when their
 * target presents a real cert.
 */
export interface RestApiConfig {
  baseUrl: string;
  apiToken: string;
  verifyTls?: boolean;
}

/**
 * HTTP-check credential. The shape lives in utils/httpCheck.ts (shared with the
 * probe and its unit tests) rather than being redeclared here — this is the
 * same type, re-exported under the credential vocabulary so callers reading
 * this file can find it.
 */
export type { HttpCheckConfig } from "../utils/httpCheck.js";

export type CredentialConfig = SnmpConfig | WinRmConfig | SshConfig | RestApiConfig | HttpCheckConfig;

export interface CredentialRecord {
  id: string;
  name: string;
  type: CredentialType;
  config: Record<string, unknown>;
  // Ownership dimension for the `credentials` function key — the username
  // that created the row, or null for a row that predates the column
  // (unowned; fullwrite-only). Never inferred: the routes stamp it on
  // create and no update path may rewrite it, or a write-level operator
  // could adopt someone else's credential by saving it.
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SaveCredentialInput {
  name: string;
  type: CredentialType;
  config: Record<string, unknown>;
  createdBy?: string | null;
}

export interface UpdateCredentialInput {
  name?: string;
  config?: Record<string, unknown>;
}

const MASK = SECRET_MASK;

/**
 * Field names treated as secrets. Returned masked on every GET and
 * preserved from the stored value on PUT when the caller resubmits the
 * mask (or an empty string).
 */
const SECRET_FIELDS_BY_TYPE: Record<CredentialType, string[]> = {
  snmp:    ["community", "authKey", "privKey"],
  winrm:   ["password"],
  ssh:     ["password", "privateKey", "passphrase"],
  restapi: ["apiToken"],
  // An http check's auth is optional (plenty of health endpoints are
  // unauthenticated) but when present it is a real credential, so both carriers
  // mask and seal. `expectBody` deliberately does NOT — it is the thing the
  // operator needs to see and edit on every visit to the form, and masking it
  // would make the check un-reviewable.
  http:    ["apiToken", "password"],
};

function secretFieldsFor(type: string): string[] {
  return SECRET_FIELDS_BY_TYPE[type as CredentialType] ?? [];
}

export function stripSecrets(cred: CredentialRecord): CredentialRecord {
  const config = { ...(cred.config || {}) } as Record<string, unknown>;
  for (const field of secretFieldsFor(cred.type)) {
    const v = config[field];
    if (typeof v === "string" && v.length > 0) {
      config[field] = MASK;
    }
  }
  return { ...cred, config };
}

function isMaskedValue(v: unknown): boolean {
  return isMaskedSecret(v) || (typeof v === "string" && v.trim() === "");
}

function normalizeName(name: string): string {
  return name.trim();
}

function validateSnmpConfig(config: Record<string, unknown>): void {
  const version = config.version;
  if (version !== "v2c" && version !== "v3") {
    throw new AppError(400, "SNMP config requires version 'v2c' or 'v3'");
  }
  if (version === "v2c") {
    if (typeof config.community !== "string" || !config.community) {
      throw new AppError(400, "SNMP v2c requires a community string");
    }
  } else {
    if (typeof config.username !== "string" || !config.username) {
      throw new AppError(400, "SNMP v3 requires a username");
    }
    const level = config.securityLevel;
    if (level !== "noAuthNoPriv" && level !== "authNoPriv" && level !== "authPriv") {
      throw new AppError(400, "SNMP v3 requires securityLevel noAuthNoPriv, authNoPriv, or authPriv");
    }
    if (level === "authNoPriv" || level === "authPriv") {
      if (!SNMP_V3_AUTH_PROTOCOLS.includes(config.authProtocol as SnmpV3AuthProtocol)) {
        throw new AppError(
          400,
          `SNMP v3 authProtocol must be one of ${SNMP_V3_AUTH_PROTOCOLS.join(", ")} when auth is enabled`,
        );
      }
      if (typeof config.authKey !== "string" || !config.authKey) {
        throw new AppError(400, "SNMP v3 authKey is required when auth is enabled");
      }
    }
    if (level === "authPriv") {
      if (!SNMP_V3_PRIV_PROTOCOLS.includes(config.privProtocol as SnmpV3PrivProtocol)) {
        throw new AppError(
          400,
          `SNMP v3 privProtocol must be one of ${SNMP_V3_PRIV_PROTOCOLS.join(", ")} when authPriv is selected`,
        );
      }
      if (typeof config.privKey !== "string" || !config.privKey) {
        throw new AppError(400, "SNMP v3 privKey is required when authPriv is selected");
      }
    }
  }
  if (config.port !== undefined && config.port !== null) {
    const p = Number(config.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new AppError(400, "SNMP port must be between 1 and 65535");
    }
  }
}

function validateWinRmConfig(config: Record<string, unknown>): void {
  if (typeof config.username !== "string" || !config.username) {
    throw new AppError(400, "WinRM requires a username");
  }
  if (typeof config.password !== "string" || !config.password) {
    throw new AppError(400, "WinRM requires a password");
  }
  if (config.port !== undefined && config.port !== null) {
    const p = Number(config.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new AppError(400, "WinRM port must be between 1 and 65535");
    }
  }
}

function validateSshConfig(config: Record<string, unknown>): void {
  if (typeof config.username !== "string" || !config.username) {
    throw new AppError(400, "SSH requires a username");
  }
  const hasPassword = typeof config.password === "string" && config.password.length > 0;
  const hasKey      = typeof config.privateKey === "string" && config.privateKey.length > 0;
  if (!hasPassword && !hasKey) {
    throw new AppError(400, "SSH requires either a password or a private key");
  }
  if (config.port !== undefined && config.port !== null) {
    const p = Number(config.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new AppError(400, "SSH port must be between 1 and 65535");
    }
  }
  if (config.verifyHostKey !== undefined && typeof config.verifyHostKey !== "boolean") {
    throw new AppError(400, "SSH verifyHostKey must be a boolean");
  }
  // A passphrase unlocks a private key and means nothing without one. Catching
  // it here beats a connect-time parse error the operator has to decode.
  if (typeof config.passphrase === "string" && config.passphrase.length > 0 && !hasKey) {
    throw new AppError(400, "SSH passphrase only applies to a private key — add the key, or clear the passphrase");
  }
}

function validateRestApiConfig(config: Record<string, unknown>): void {
  if (typeof config.baseUrl !== "string" || !config.baseUrl) {
    throw new AppError(400, "REST API credential requires a baseUrl");
  }
  // Defensive URL parse — operators may paste a hostname with no scheme,
  // a trailing path, or even a stray newline. We require an http(s) scheme
  // because the polling code can't talk anything else, and we trim trailing
  // slashes so the probe path concatenation doesn't double up. The trim
  // happens at validation time so the stored value is canonical.
  let u: URL;
  try { u = new URL(config.baseUrl.trim()); }
  catch { throw new AppError(400, "REST API baseUrl must be a valid URL (e.g. https://device.example/)"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new AppError(400, "REST API baseUrl must use http:// or https://");
  }
  config.baseUrl = u.toString().replace(/\/+$/, "");
  if (typeof config.apiToken !== "string" || !config.apiToken) {
    throw new AppError(400, "REST API credential requires an apiToken");
  }
  if (config.verifyTls !== undefined && typeof config.verifyTls !== "boolean") {
    throw new AppError(400, "REST API verifyTls must be a boolean");
  }
}

/**
 * Validate an `http` CREDENTIAL — which since 2026-08 carries authentication
 * and nothing else. The check definition it used to hold (path, expected
 * status, expected body, TLS verification) moved to a manufacturer custom
 * widget; `validateHttpCheckDefinition` below validates that half wherever it
 * now appears.
 *
 * "none" is not an accepted mode here. A credential exists to authenticate, so
 * one that authenticates nothing is an empty row that still reads as
 * configuration — and an unauthenticated check is already expressible by a
 * widget selecting no credential at all, which is the same outcome without the
 * misleading artefact.
 */
function validateHttpConfig(config: Record<string, unknown>): void {
  if (config.authMode === undefined || config.authMode === null || config.authMode === "") {
    throw new AppError(400, `HTTP credential requires an authentication type: ${HTTP_CREDENTIAL_AUTH_MODES.join(", ")}`);
  }
  if (typeof config.authMode !== "string" ||
      !(HTTP_CREDENTIAL_AUTH_MODES as readonly string[]).includes(config.authMode)) {
    throw new AppError(400, `HTTP credential auth type must be one of: ${HTTP_CREDENTIAL_AUTH_MODES.join(", ")}`);
  }
  const authMode = config.authMode as string;
  const hasUser = typeof config.username === "string" && config.username.length > 0;
  const hasPass = typeof config.password === "string" && config.password.length > 0;

  if (authMode === "bearer" && !(typeof config.apiToken === "string" && config.apiToken.length > 0)) {
    throw new AppError(400, "HTTP credential bearer auth needs an API token");
  }
  // "form" is the device admin login the firmware repository posts to a
  // switch or AP's own login page (business rule 87) — the same two carriers
  // as basic / digest, and the same requirement that both be present.
  if ((authMode === "basic" || authMode === "digest" || authMode === "form") && !(hasUser && hasPass)) {
    // Named per mode: "basic auth needs..." on a digest credential sends the
    // operator looking for a field that isn't the one they got wrong.
    throw new AppError(400, `HTTP credential ${authMode} ${authMode === "form" ? "login" : "auth"} needs both a username and a password`);
  }

  // Drop the carriers this mode does not send, and every field left over from
  // the pre-split shape. This runs on the MERGED config (validateConfig is
  // called after mergeConfigPreservingSecrets on both the create and update
  // paths), which is the only place a stored secret can actually be removed:
  // blanking a secret in the request body means "keep the stored value" to the
  // merge, so a client-side clear would preserve the very credential it appears
  // to delete.
  if (authMode !== "bearer") delete config.apiToken;
  if (authMode !== "basic" && authMode !== "digest" && authMode !== "form") {
    delete config.username;
    delete config.password;
  }
  for (const stale of CHECK_DEFINITION_FIELDS) delete config[stale];
}

/**
 * Fields that used to live on an `http` credential and now belong to the check
 * definition. Stripped on the next save of any credential still carrying them —
 * the values are not migrated, because the credential had no manufacturer or
 * model to attribute a widget to and guessing one would invent configuration
 * nobody wrote.
 */
const CHECK_DEFINITION_FIELDS = [
  "useHttps", "port", "path", "expectStatus", "expectBody",
  "matchMode", "caseSensitive", "failOnMismatch", "verifyTls",
] as const;

/**
 * Validate a CHECK DEFINITION — the half that answers "which request, and what
 * answer counts as healthy". Shared by the manufacturer custom widget (where it
 * is stored) and the credential Test Connection flow (where it is supplied ad
 * hoc), so a check cannot be accepted in one place and rejected in the other.
 *
 * Mutates its argument to canonicalize, matching validateConfig's convention:
 *
 *  - the regex is COMPILED here, because an invalid pattern would otherwise
 *    fail once per asset per interval forever, with the operator finding out
 *    from a probe error column instead of the form they typed it into.
 *  - `path` is canonicalized (leading slash) so the stored value is what the
 *    request line will actually carry.
 *  - `caseSensitive` is only meaningful alongside an `expectBody`; a lone
 *    toggle is accepted rather than rejected (harmless, and rejecting it would
 *    400 a form the operator is mid-way through).
 *  - `failOnMismatch` is STRIPPED. A mismatch now always fails (see
 *    utils/httpCheck.ts), so a stored `false` would silently mean something the
 *    UI can no longer express and the evaluator no longer honours.
 */
export function validateHttpCheckDefinition(config: Record<string, unknown>): void {
  if (config.useHttps !== undefined && typeof config.useHttps !== "boolean") {
    throw new AppError(400, "HTTP check useHttps must be a boolean");
  }
  if (config.port !== undefined && config.port !== null) {
    const p = Number(config.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new AppError(400, "HTTP check port must be between 1 and 65535");
    }
    config.port = p;
  }
  if (config.path !== undefined && config.path !== null && typeof config.path !== "string") {
    throw new AppError(400, "HTTP check path must be a string");
  }
  // Canonicalize so the stored value equals the request line. A blank path is
  // stored as "/" here (unlike Asset.httpCheckPath, where blank means "no
  // override") — this IS the definition, so it has to name a path.
  config.path = normalizeHttpPath(typeof config.path === "string" ? config.path : null);

  if (config.expectStatus !== undefined && config.expectStatus !== null) {
    const s = Number(config.expectStatus);
    if (!Number.isInteger(s) || s < 100 || s > 599) {
      throw new AppError(400, "HTTP check expected status must be a status code between 100 and 599");
    }
    config.expectStatus = s;
  }
  const mode = config.matchMode;
  if (mode !== undefined && mode !== null && mode !== "contains" && mode !== "regex") {
    throw new AppError(400, 'HTTP check matchMode must be "contains" or "regex"');
  }
  if (config.expectBody !== undefined && config.expectBody !== null && typeof config.expectBody !== "string") {
    throw new AppError(400, "HTTP check expected content must be a string");
  }
  const expectBody = typeof config.expectBody === "string" ? config.expectBody : "";
  if (mode === "regex" && expectBody) {
    try { new RegExp(expectBody); }
    catch (err: any) {
      throw new AppError(400, `HTTP check regex is invalid: ${err?.message || "unparseable"}`);
    }
  }
  for (const flag of ["caseSensitive", "verifyTls"]) {
    if (config[flag] !== undefined && typeof config[flag] !== "boolean") {
      throw new AppError(400, `HTTP check ${flag} must be a boolean`);
    }
  }
  // Retired knob — see the doc comment. Dropped rather than rejected so an
  // existing widget re-saves cleanly instead of 400-ing on a field the form
  // never sent.
  delete config.failOnMismatch;
}

export function validateConfig(type: CredentialType, config: Record<string, unknown>): void {
  if (type === "snmp")    return validateSnmpConfig(config);
  if (type === "winrm")   return validateWinRmConfig(config);
  if (type === "ssh")     return validateSshConfig(config);
  if (type === "restapi") return validateRestApiConfig(config);
  if (type === "http")    return validateHttpConfig(config);
  throw new AppError(400, `Unknown credential type "${type}"`);
}

/**
 * Merge incoming config onto the stored one, preserving any secret field
 * whose incoming value is either the mask sentinel or empty. Lets the
 * edit modal round-trip a masked value without wiping the real secret.
 */
export function mergeConfigPreservingSecrets(
  type: CredentialType,
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing, ...incoming };
  for (const field of secretFieldsFor(type)) {
    if (isMaskedValue(incoming[field])) {
      merged[field] = existing[field];
    }
  }
  return merged;
}

async function findByName(name: string, excludeId?: string): Promise<CredentialRecord | null> {
  const found = await prisma.credential.findUnique({ where: { name } });
  if (!found) return null;
  if (excludeId && found.id === excludeId) return null;
  return found as unknown as CredentialRecord;
}

export async function listCredentials(): Promise<CredentialRecord[]> {
  const rows = await prisma.credential.findMany({ orderBy: { name: "asc" } });
  return (rows as unknown as CredentialRecord[]).map(stripSecrets);
}

export async function getCredential(id: string, opts?: { revealSecrets?: boolean }): Promise<CredentialRecord> {
  const row = await prisma.credential.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Credential not found");
  const cred = row as unknown as CredentialRecord;
  return opts?.revealSecrets ? cred : stripSecrets(cred);
}

export async function createCredential(input: SaveCredentialInput): Promise<CredentialRecord> {
  const name = normalizeName(input.name);
  if (!name) throw new AppError(400, "Credential name is required");
  if (input.type !== "snmp" && input.type !== "winrm" && input.type !== "ssh" && input.type !== "restapi" && input.type !== "http") {
    throw new AppError(400, "Credential type must be snmp, winrm, ssh, restapi, or http");
  }
  if (!input.config || typeof input.config !== "object") {
    throw new AppError(400, "Credential config is required");
  }
  validateConfig(input.type, input.config);
  if (await findByName(name)) {
    throw new AppError(409, `A credential named "${name}" already exists`);
  }
  const created = await prisma.credential.create({
    data: {
      name,
      type: input.type,
      config: input.config as any,
      // Stamped once, at create. `updateCredential` takes no createdBy and
      // never writes one, so ownership cannot be reassigned by an edit.
      createdBy: input.createdBy ?? null,
    },
  });
  return stripSecrets(created as unknown as CredentialRecord);
}

export async function updateCredential(id: string, input: UpdateCredentialInput): Promise<CredentialRecord> {
  const existing = await prisma.credential.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "Credential not found");

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = normalizeName(input.name);
    if (!name) throw new AppError(400, "Credential name cannot be empty");
    if (await findByName(name, id)) {
      throw new AppError(409, `A credential named "${name}" already exists`);
    }
    data.name = name;
  }
  if (input.config) {
    const merged = mergeConfigPreservingSecrets(
      existing.type as CredentialType,
      (existing.config as Record<string, unknown>) || {},
      input.config,
    );
    validateConfig(existing.type as CredentialType, merged);
    data.config = merged;
  }
  const updated = await prisma.credential.update({ where: { id }, data });
  return stripSecrets(updated as unknown as CredentialRecord);
}

// ─── Credential usage ("where is this credential wired?") ───────────────────
//
// A credential reaches a monitored asset through the monitor-settings
// fall-through. For each of the eight per-stream slots the effective
// credential is the first non-null of:
//   1. Asset.<stream>CredentialId   → "asset" level (stream-specific)
//   2. Asset.monitorCredentialId    → "asset" level (default)
//   3. MonitorClassOverride.<stream>CredentialId for the asset's
//        (discoveredByIntegrationId | null, assetType) class → "class" level
//   4. Integration.config.monitorCredentialId (discovered assets only)
//        → "integration" level
// The manual tier (Setting "manualMonitorSettings") carries no default
// credential, so manual assets resolve through the asset + class tiers only.
//
// This resolves by FK wiring; it does NOT check whether a stream's actual
// polling method needs that credential type. It answers "where is this
// credential configured" — exactly the admin / delete-safety question.

/**
 * The eight per-stream credential slots that exist on both Asset and
 * MonitorClassOverride. Storage has no slot of its own (it rides the
 * `interfaces` credential), so it isn't listed here.
 */
// Badge shown when a credential is wired in the asset's default slot
// (`monitorCredentialId`) rather than a specific stream — it's the fallback
// used for every monitoring stream without its own per-stream override.
const DEFAULT_STREAM_LABEL = "All Polling Methods";

const CREDENTIAL_STREAMS = [
  { field: "responseTimeCredentialId", label: "Response time" },
  { field: "cpuMemoryCredentialId",    label: "CPU / memory" },
  { field: "temperatureCredentialId",  label: "Hardware sensors" },
  { field: "interfacesCredentialId",   label: "Interfaces / storage" },
  { field: "lldpCredentialId",         label: "LLDP" },
  { field: "customWidgetCredentialId", label: "Custom widgets" },
  { field: "processesCredentialId",    label: "Processes" },
  { field: "eventLogCredentialId",     label: "Event log" },
] as const;

type CredRow = Record<string, string | boolean | null | undefined>;

export interface CredentialUsageAsset {
  assetId: string;
  hostname: string | null;
  ipAddress: string | null;
  assetType: string;
  monitored: boolean;
  status: string;
  /** Stream labels (+ "Default") this credential is wired for at this level. */
  streams: string[];
}

export interface CredentialUsageClassGroup {
  integrationId: string | null;
  integrationName: string | null; // null when the class override is the manual tier
  assetType: string;
  /** Stream labels the class override points at this credential. */
  streams: string[];
  assets: CredentialUsageAsset[];
}

export interface CredentialUsageIntegrationGroup {
  integrationId: string;
  integrationName: string;
  assets: CredentialUsageAsset[];
}

export interface CredentialUsage {
  credentialId: string;
  total: number; // distinct assets effectively using the credential
  assetLevel: CredentialUsageAsset[];
  classLevel: CredentialUsageClassGroup[];
  integrationLevel: CredentialUsageIntegrationGroup[];
  /** Class overrides referencing the credential (regardless of matching assets). */
  classRefCount: number;
  /** Integrations whose default monitor credential is this credential. */
  integrationRefCount: number;
}

interface UsageInputs {
  assets: CredRow[];
  /** keyed `${integrationId ?? ""}|${assetType}` */
  classByKey: Map<string, CredRow>;
  /** all loaded class overrides (for ref counting) */
  classRows: CredRow[];
  /** integrationId → default monitorCredentialId (or null) */
  intDefaultCred: Map<string, string | null>;
  /**
   * integrationId → every credential id referenced anywhere in its config
   * (monitorCredentialId, sshCredentialId, per-class snmp/ssh credential ids).
   * Discovery stamps one of these onto each discovered asset's
   * `monitorCredentialId`, so an asset default that matches a member of this
   * set was inherited from the integration, not set per-asset.
   */
  intCredSets: Map<string, Set<string>>;
  intName: Map<string, string>;
}

const ASSET_USAGE_SELECT = {
  id: true, hostname: true, ipAddress: true, assetType: true,
  monitored: true, status: true, discoveredByIntegrationId: true,
  monitorCredentialId: true,
  responseTimeCredentialId: true, cpuMemoryCredentialId: true,
  temperatureCredentialId: true, interfacesCredentialId: true,
  lldpCredentialId: true, customWidgetCredentialId: true,
  processesCredentialId: true, eventLogCredentialId: true,
} as const;

const CLASS_USAGE_SELECT = {
  integrationId: true, assetType: true,
  responseTimeCredentialId: true, cpuMemoryCredentialId: true,
  temperatureCredentialId: true, interfacesCredentialId: true,
  lldpCredentialId: true, customWidgetCredentialId: true,
  processesCredentialId: true, eventLogCredentialId: true,
} as const;

async function loadUsageInputs(): Promise<UsageInputs> {
  const [assets, classRows, integrations] = await Promise.all([
    prisma.asset.findMany({ select: ASSET_USAGE_SELECT }) as unknown as Promise<CredRow[]>,
    prisma.monitorClassOverride.findMany({ select: CLASS_USAGE_SELECT }) as unknown as Promise<CredRow[]>,
    prisma.integration.findMany({ select: { id: true, name: true, config: true } }),
  ]);
  const classByKey = new Map<string, CredRow>();
  for (const ov of classRows) {
    classByKey.set(`${(ov.integrationId as string | null) ?? ""}|${ov.assetType as string}`, ov);
  }
  const intDefaultCred = new Map<string, string | null>();
  const intCredSets = new Map<string, Set<string>>();
  const intName = new Map<string, string>();
  for (const it of integrations) {
    const cfg = it.config && typeof it.config === "object" ? (it.config as Record<string, unknown>) : {};
    const credId = typeof cfg.monitorCredentialId === "string" ? cfg.monitorCredentialId : null;
    intDefaultCred.set(it.id, credId);
    const set = new Set<string>();
    collectCredentialIds(cfg, set);
    intCredSets.set(it.id, set);
    intName.set(it.id, it.name);
  }
  return { assets, classByKey, classRows, intDefaultCred, intCredSets, intName };
}

/**
 * Recursively collect every credential-id string in an integration config —
 * any key ending in "CredentialId" (monitorCredentialId, sshCredentialId,
 * snmpCredentialId, …) at any nesting depth (top-level + per-class blocks).
 */
function collectCredentialIds(value: unknown, into: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) collectCredentialIds(v, into);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && v && /CredentialId$/.test(k)) into.add(v);
    else if (v && typeof v === "object") collectCredentialIds(v, into);
  }
}

function classKeyForAsset(a: CredRow): string {
  return `${(a.discoveredByIntegrationId as string | null) ?? ""}|${a.assetType as string}`;
}

function intDefaultForAsset(a: CredRow, inputs: UsageInputs): string | null {
  const intId = a.discoveredByIntegrationId as string | null;
  return intId ? inputs.intDefaultCred.get(intId) ?? null : null;
}

/** Distinct set of credential ids effectively used by one asset (across all streams). */
function effectiveCredentialIds(a: CredRow, classOv: CredRow | null, intCredId: string | null): Set<string> {
  const out = new Set<string>();
  const assetDefault = a.monitorCredentialId as string | null;
  for (const s of CREDENTIAL_STREAMS) {
    const assetStream = a[s.field] as string | null;
    if (assetStream) { out.add(assetStream); continue; }
    if (assetDefault) { out.add(assetDefault); continue; }
    const classStream = classOv ? (classOv[s.field] as string | null) : null;
    if (classStream) { out.add(classStream); continue; }
    if (intCredId) { out.add(intCredId); continue; }
  }
  return out;
}

function toUsageAsset(a: CredRow, streams: string[]): CredentialUsageAsset {
  return {
    assetId: a.id as string,
    hostname: (a.hostname as string | null) ?? null,
    ipAddress: (a.ipAddress as string | null) ?? null,
    assetType: a.assetType as string,
    monitored: Boolean(a.monitored),
    status: a.status as string,
    streams,
  };
}

function byHostname(a: CredentialUsageAsset, b: CredentialUsageAsset): number {
  return (a.hostname || a.ipAddress || a.assetId).localeCompare(b.hostname || b.ipAddress || b.assetId);
}

/**
 * Effective-usage asset count per credential, for the Stored Credentials
 * table column. One asset findMany + small lookups; resolution is in-memory.
 */
export async function getCredentialUsageCounts(): Promise<Record<string, number>> {
  const inputs = await loadUsageInputs();
  const counts: Record<string, number> = {};
  for (const a of inputs.assets) {
    const classOv = inputs.classByKey.get(classKeyForAsset(a)) ?? null;
    const credIds = effectiveCredentialIds(a, classOv, intDefaultForAsset(a, inputs));
    for (const cid of credIds) counts[cid] = (counts[cid] ?? 0) + 1;
  }
  return counts;
}

/**
 * Full usage breakdown for one credential, grouped by the level each asset
 * inherits it from (asset / class / integration). Each asset lands in its
 * most-specific bucket, so `total` is a true distinct count.
 */
export async function getCredentialUsage(id: string): Promise<CredentialUsage> {
  const exists = await prisma.credential.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw new AppError(404, "Credential not found");

  const inputs = await loadUsageInputs();
  const assetLevel: CredentialUsageAsset[] = [];
  const classGroups = new Map<string, CredentialUsageClassGroup>();
  const intGroups = new Map<string, CredentialUsageIntegrationGroup>();

  const pushIntGroup = (intId: string, a: CredRow, streams: string[]) => {
    let g = intGroups.get(intId);
    if (!g) {
      g = { integrationId: intId, integrationName: inputs.intName.get(intId) ?? intId, assets: [] };
      intGroups.set(intId, g);
    }
    g.assets.push(toUsageAsset(a, streams));
  };

  for (const a of inputs.assets) {
    const classOv = inputs.classByKey.get(classKeyForAsset(a)) ?? null;
    const assetDefault = a.monitorCredentialId as string | null;
    const intId = a.discoveredByIntegrationId as string | null;

    // Discovery stamps the integration's credential onto the asset's default
    // `monitorCredentialId`. So a default that matches a credential the asset's
    // integration provides was inherited from the integration — not a per-asset
    // choice. Treat it as integration level. Only a default pointing at a
    // credential the integration doesn't provide (or a manual asset) is a
    // genuine asset-level override. The per-stream slots are never stamped, so
    // a per-stream match is always an explicit operator override.
    const defaultInheritedFromIntegration =
      assetDefault === id && intId != null && (inputs.intCredSets.get(intId)?.has(id) ?? false);

    // ── Asset level: a genuine per-asset override ───────────────────────────
    const assetStreams: string[] = [];
    for (const s of CREDENTIAL_STREAMS) if ((a[s.field] as string | null) === id) assetStreams.push(s.label);
    if (assetDefault === id && !defaultInheritedFromIntegration) assetStreams.push(DEFAULT_STREAM_LABEL);
    if (assetStreams.length > 0) {
      assetLevel.push(toUsageAsset(a, assetStreams));
      continue; // most-specific bucket wins
    }

    // ── Integration level (stamped default): the asset's default credential
    //    was inherited from its discovering integration ──────────────────────
    if (defaultInheritedFromIntegration) {
      pushIntGroup(intId as string, a, [DEFAULT_STREAM_LABEL]);
      continue;
    }

    // The class/integration fall-through tiers only apply when the asset has no
    // default credential of its own (asset default outranks both).
    if (assetDefault != null) continue;

    // ── Class level ─────────────────────────────────────────────────────────
    if (classOv) {
      const classStreams: string[] = [];
      for (const s of CREDENTIAL_STREAMS) {
        if ((a[s.field] as string | null) == null && (classOv[s.field] as string | null) === id) {
          classStreams.push(s.label);
        }
      }
      if (classStreams.length > 0) {
        const key = classKeyForAsset(a);
        let g = classGroups.get(key);
        if (!g) {
          const intId = a.discoveredByIntegrationId as string | null;
          g = {
            integrationId: intId,
            integrationName: intId ? inputs.intName.get(intId) ?? null : null,
            assetType: a.assetType as string,
            streams: CREDENTIAL_STREAMS.filter((s) => (classOv[s.field] as string | null) === id).map((s) => s.label),
            assets: [],
          };
          classGroups.set(key, g);
        }
        g.assets.push(toUsageAsset(a, classStreams));
        continue;
      }
    }

    // ── Integration level: no asset default, some stream falls all the way
    //    through to the integration's default monitor credential ─────────────
    if (intId != null && intDefaultForAsset(a, inputs) === id) {
      const fallsThrough = CREDENTIAL_STREAMS.some(
        (s) => (a[s.field] as string | null) == null && (classOv ? (classOv[s.field] as string | null) : null) == null,
      );
      if (fallsThrough) pushIntGroup(intId, a, [DEFAULT_STREAM_LABEL]);
    }
  }

  // Reference counts (independent of whether assets currently match).
  let classRefCount = 0;
  for (const ov of inputs.classRows) {
    if (CREDENTIAL_STREAMS.some((s) => (ov[s.field] as string | null) === id)) classRefCount += 1;
  }
  let integrationRefCount = 0;
  for (const set of inputs.intCredSets.values()) if (set.has(id)) integrationRefCount += 1;

  assetLevel.sort(byHostname);
  const classLevel = [...classGroups.values()].sort(
    (a, b) => (a.integrationName || "Manual").localeCompare(b.integrationName || "Manual") || a.assetType.localeCompare(b.assetType),
  );
  for (const g of classLevel) g.assets.sort(byHostname);
  const integrationLevel = [...intGroups.values()].sort((a, b) => a.integrationName.localeCompare(b.integrationName));
  for (const g of integrationLevel) g.assets.sort(byHostname);

  const total =
    assetLevel.length +
    classLevel.reduce((n, g) => n + g.assets.length, 0) +
    integrationLevel.reduce((n, g) => n + g.assets.length, 0);

  return { credentialId: id, total, assetLevel, classLevel, integrationLevel, classRefCount, integrationRefCount };
}

/**
 * Probe-target fields for POST /credentials/test — the asset the operator
 * chose to exercise a credential against. 404s when the asset is gone.
 */
export async function getTestAssetTarget(assetId: string) {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: { id: true, hostname: true, ipAddress: true, dnsName: true },
  });
  if (!asset) throw new AppError(404, "Asset not found");
  return asset;
}

export async function deleteCredential(id: string): Promise<void> {
  const usage = await getCredentialUsage(id); // throws 404 if missing
  if (usage.total > 0) {
    const parts: string[] = [];
    if (usage.assetLevel.length) parts.push(`${usage.assetLevel.length} directly`);
    const viaClass = usage.classLevel.reduce((n, g) => n + g.assets.length, 0);
    if (viaClass) parts.push(`${viaClass} via class settings`);
    const viaInt = usage.integrationLevel.reduce((n, g) => n + g.assets.length, 0);
    if (viaInt) parts.push(`${viaInt} via integration defaults`);
    throw new AppError(
      409,
      `Credential is in use by ${usage.total} asset${usage.total === 1 ? "" : "s"} (${parts.join(", ")}); clear monitoring there first`,
    );
  }
  // No assets resolve to it, but a class override or integration default may
  // still reference it — deleting would silently null those out.
  if (usage.classRefCount > 0 || usage.integrationRefCount > 0) {
    const refs: string[] = [];
    if (usage.classRefCount) refs.push(`${usage.classRefCount} class override${usage.classRefCount === 1 ? "" : "s"}`);
    if (usage.integrationRefCount) refs.push(`${usage.integrationRefCount} integration default${usage.integrationRefCount === 1 ? "" : "s"}`);
    throw new AppError(409, `Credential is referenced by ${refs.join(" and ")}; clear those monitor settings first`);
  }
  try {
    await prisma.credential.delete({ where: { id } });
  } catch (err: any) {
    if (err?.code === "P2025") throw new AppError(404, "Credential not found");
    throw err;
  }
}
