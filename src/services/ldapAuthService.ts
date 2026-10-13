/**
 * src/services/ldapAuthService.ts — LDAP user authentication + group lookup
 *
 * Authenticates a username/password against an LDAP/AD directory by binding as
 * the user, reads the user's group membership, and provisions a Polaris user
 * (group → role + tags via groupMappingService). Distinct from
 * activeDirectoryService, which uses a service-account bind to DISCOVER
 * computer objects — this path binds AS the end user to verify credentials.
 *
 * Settings live in the `ldap` Setting row (managed from the Authentication
 * modal). bindPassword is masked "********" on read and preserved-on-unchanged
 * on write, mirroring the SAML/OIDC secret handling.
 *
 * SECURITY:
 *   - Empty passwords are rejected BEFORE any bind. An empty password to an
 *     LDAP bind is an "unauthenticated bind" that many servers accept as
 *     success — that would authenticate anyone as any user.
 *   - The username is RFC-4515-escaped before substitution into searchFilter
 *     (escapeLdapFilterValue) to prevent filter injection.
 */

import { type Entry } from "ldapts";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import {
  withBoundLdapClient,
  escapeLdapFilterValue,
  decodeObjectGuid,
  formatLdapError,
  type LdapConnectionConfig,
} from "./ldapClient.js";
import { provisionExternalUser } from "./ssoProvisioning.js";
import { SECRET_MASK, LEGACY_ASTERISK_MASK, isMaskedSecret } from "../utils/secretMask.js";
import { movedDestinationKey } from "../utils/secretDestination.js";

export interface LdapSettings {
  enabled: boolean;
  url: string; // ldap://host:389 or ldaps://host:636
  bindDn: string;
  bindPassword: string;
  searchBase: string;
  searchFilter: string; // {{username}} placeholder
  tlsVerify: boolean;
  displayNameAttr: string;
  emailAttr: string;
  // Group membership
  userIdAttribute: string; // stable per-user id; objectGUID (AD) or entryUUID
  groupAttribute: string; // multi-valued group DNs on the user entry, e.g. memberOf
  groupBaseDn: string; // optional reverse member search base ("" = skip)
  groupFilter: string; // optional reverse member search filter, {{userDn}} placeholder
}

const LDAP_DEFAULTS: LdapSettings = {
  enabled: false,
  url: "",
  bindDn: "",
  bindPassword: "",
  searchBase: "",
  searchFilter: "(sAMAccountName={{username}})",
  tlsVerify: true,
  displayNameAttr: "displayName",
  emailAttr: "mail",
  userIdAttribute: "objectGUID",
  groupAttribute: "memberOf",
  groupBaseDn: "",
  groupFilter: "(member={{userDn}})",
};

// Emits the shared bullet mask; the merge below additionally accepts the
// pre-consolidation asterisk mask so an in-flight settings form from a
// pre-upgrade page still round-trips without clobbering the stored secret.
const MASK = SECRET_MASK;

let _cache: { value: LdapSettings; expiry: number } | null = null;

export async function getLdapSettings(): Promise<LdapSettings> {
  if (_cache && Date.now() < _cache.expiry) return _cache.value;
  const row = await prisma.setting.findUnique({ where: { key: "ldap" } });
  const value = row?.value
    ? { ...LDAP_DEFAULTS, ...(row.value as Record<string, any>) }
    : { ...LDAP_DEFAULTS };
  _cache = { value, expiry: Date.now() + 30000 };
  return value;
}

/** Settings as returned to the admin UI — bindPassword masked. */
export async function getLdapSettingsMasked(): Promise<LdapSettings> {
  const s = await getLdapSettings();
  return { ...s, bindPassword: s.bindPassword ? MASK : "" };
}

/**
 * The bind password to save. The UI echoes the mask back to mean "keep the
 * stored one" — business rule 111(a): only while the server it goes to is
 * unchanged (the URL: host, port, ldap vs ldaps; and certificate checking).
 * A moved destination is a 400 asking for the password again (re-scan F3).
 * Anything else typed is saved as typed (blank clears it).
 */
export function keptLdapBindPassword(
  cur: Pick<LdapSettings, "url" | "tlsVerify" | "bindPassword">,
  input: Record<string, any>,
): string {
  const echoed = isMaskedSecret(input.bindPassword) || input.bindPassword === LEGACY_ASTERISK_MASK;
  if (!echoed) return String(input.bindPassword ?? "").trim();
  if (!cur.bindPassword) return "";
  const moved = movedDestinationKey(
    { url: cur.url ?? "", verifyTls: cur.tlsVerify !== false },
    {
      url: input.url === undefined ? undefined : String(input.url).trim(),
      verifyTls: input.tlsVerify === undefined ? undefined : input.tlsVerify !== false,
    },
  );
  if (moved) {
    throw new AppError(
      400,
      `The ${moved === "url" ? "LDAP server URL" : "certificate check"} changed, so the stored bind password is not reused: a saved secret is never sent to a new destination. Enter the bind password again to save this change.`,
    );
  }
  return cur.bindPassword;
}

export async function updateLdapSettings(input: Record<string, any>): Promise<LdapSettings> {
  const cur = await getLdapSettings();
  const value: LdapSettings = {
    enabled: !!input.enabled,
    url: (input.url ?? cur.url ?? "").trim(),
    bindDn: (input.bindDn ?? cur.bindDn ?? "").trim(),
    bindPassword: keptLdapBindPassword(cur, input),
    searchBase: (input.searchBase ?? cur.searchBase ?? "").trim(),
    searchFilter: (input.searchFilter ?? cur.searchFilter ?? LDAP_DEFAULTS.searchFilter).trim(),
    tlsVerify: input.tlsVerify !== false,
    displayNameAttr: (input.displayNameAttr ?? cur.displayNameAttr ?? LDAP_DEFAULTS.displayNameAttr).trim(),
    emailAttr: (input.emailAttr ?? cur.emailAttr ?? LDAP_DEFAULTS.emailAttr).trim(),
    userIdAttribute: (input.userIdAttribute ?? cur.userIdAttribute ?? LDAP_DEFAULTS.userIdAttribute).trim(),
    groupAttribute: (input.groupAttribute ?? cur.groupAttribute ?? LDAP_DEFAULTS.groupAttribute).trim(),
    groupBaseDn: (input.groupBaseDn ?? cur.groupBaseDn ?? "").trim(),
    groupFilter: (input.groupFilter ?? cur.groupFilter ?? LDAP_DEFAULTS.groupFilter).trim(),
  };
  await prisma.setting.upsert({
    where: { key: "ldap" },
    update: { value: value as any },
    create: { key: "ldap", value: value as any },
  });
  _cache = { value, expiry: Date.now() + 30000 };
  return value;
}

export async function isLdapEnabled(): Promise<boolean> {
  const s = await getLdapSettings();
  return !!(s.enabled && s.url && s.bindDn && s.searchBase);
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function parseLdapUrl(url: string): { host: string; port?: number; useLdaps: boolean } {
  const u = new URL(url);
  const useLdaps = u.protocol === "ldaps:";
  const port = u.port ? parseInt(u.port, 10) : undefined;
  return { host: u.hostname, port, useLdaps };
}

function connConfig(s: LdapSettings, bindDn: string, bindPassword: string): LdapConnectionConfig {
  const { host, port, useLdaps } = parseLdapUrl(s.url);
  return { host, port, useLdaps, verifyTls: s.tlsVerify, bindDn, bindPassword };
}

function firstString(val: unknown): string {
  if (val == null) return "";
  if (Array.isArray(val)) return firstString(val[0]);
  if (Buffer.isBuffer(val)) return val.toString("utf8");
  return String(val).trim();
}

function toStringArray(val: unknown): string[] {
  if (val == null) return [];
  const arr = Array.isArray(val) ? val : [val];
  return arr.map((v) => (Buffer.isBuffer(v) ? v.toString("utf8") : String(v))).map((s) => s.trim()).filter(Boolean);
}

function extractUid(entry: Entry, attr: string): string {
  const raw = (entry as Record<string, unknown>)[attr];
  if (raw == null) return "";
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (Buffer.isBuffer(first)) {
    return first.length === 16 ? decodeObjectGuid(first) : first.toString("hex").toLowerCase();
  }
  return String(first).trim();
}

export interface LdapAuthResult {
  dn: string;
  username: string;
  displayName: string;
  email: string;
  ldapUid: string;
  groups: string[];
}

/**
 * Bind-as-user authentication. Returns the verified profile or throws an
 * Error whose message is operator-safe. The caller maps any throw to a generic
 * "Invalid username or password" so the directory's response isn't leaked.
 */
export async function authenticateLdapUser(username: string, password: string): Promise<LdapAuthResult> {
  // SECURITY: reject empty password before binding (unauthenticated-bind trap).
  if (!password) throw new AppError(401, "Password is required");
  const s = await getLdapSettings();
  if (!s.enabled || !s.url || !s.bindDn || !s.searchBase) throw new AppError(400, "LDAP is not configured");

  const idAttr = s.userIdAttribute || "objectGUID";
  const idAttrLc = idAttr.toLowerCase();
  const bufferAttrs = idAttrLc === "objectguid" || idAttrLc === "objectsid" ? [idAttr] : [];
  const filter = s.searchFilter.replace(/\{\{username\}\}/g, escapeLdapFilterValue(username));

  // Phase 1: service-account bind + locate the user entry.
  const entry = await withBoundLdapClient(connConfig(s, s.bindDn, s.bindPassword), undefined, async (client) => {
    const { searchEntries } = await client.search(s.searchBase, {
      scope: "sub",
      filter,
      attributes: [s.displayNameAttr, s.emailAttr, idAttr, s.groupAttribute],
      explicitBufferAttributes: bufferAttrs,
      sizeLimit: 2,
      timeLimit: 15,
    });
    // Fail closed: exactly one match required (0 = unknown user, >1 = ambiguous).
    if (searchEntries.length !== 1) return null;
    return searchEntries[0];
  });
  if (!entry) throw new AppError(401, "Invalid username or password");

  const userDn = String(entry.dn || "");
  if (!userDn) throw new AppError(502, "LDAP entry has no DN");

  // Phase 2: re-bind AS the user with the supplied password (fresh client) to
  // verify credentials. A failed bind throws → caught by the caller.
  await withBoundLdapClient(connConfig(s, userDn, password), undefined, async () => {
    /* bind alone proves the password */
  });

  // Groups from the user entry's group attribute (memberOf on AD).
  const groups = new Set(toStringArray((entry as Record<string, unknown>)[s.groupAttribute]));

  // Optional reverse member search (catches groups not listed in memberOf).
  if (s.groupBaseDn && s.groupFilter) {
    const gFilter = s.groupFilter.replace(/\{\{userDn\}\}/g, escapeLdapFilterValue(userDn));
    try {
      const found = await withBoundLdapClient(connConfig(s, s.bindDn, s.bindPassword), undefined, async (client) => {
        const { searchEntries } = await client.search(s.groupBaseDn, {
          scope: "sub",
          filter: gFilter,
          attributes: ["dn"],
          sizeLimit: 500,
          timeLimit: 15,
        });
        return searchEntries.map((e) => String(e.dn || "")).filter(Boolean);
      });
      for (const g of found) groups.add(g);
    } catch {
      /* reverse search is best-effort — primary memberOf already collected */
    }
  }

  let ldapUid = extractUid(entry, idAttr);
  if (!ldapUid) ldapUid = userDn.toLowerCase(); // fall back to DN as the stable id

  return {
    dn: userDn,
    username,
    displayName: firstString((entry as Record<string, unknown>)[s.displayNameAttr]),
    email: firstString((entry as Record<string, unknown>)[s.emailAttr]),
    ldapUid,
    groups: [...groups],
  };
}

export async function findOrProvisionLdapUser(result: LdapAuthResult) {
  return provisionExternalUser({
    provider: "ldap",
    externalIdField: "ldapUid",
    externalId: result.ldapUid,
    usernameHint: result.username,
    displayName: result.displayName || null,
    email: result.email || null,
    groups: result.groups,
  });
}

/** Admin "Test" button — verify the service-account bind + base DN resolve. */
export async function testLdapConnection(): Promise<{ ok: boolean; message: string }> {
  const s = await getLdapSettings();
  if (!s.url) return { ok: false, message: "Server URL is required" };
  if (!s.bindDn) return { ok: false, message: "Bind DN is required" };
  if (!s.bindPassword) return { ok: false, message: "Bind password is required" };
  if (!s.searchBase) return { ok: false, message: "Search base is required" };
  try {
    const count = await withBoundLdapClient(connConfig(s, s.bindDn, s.bindPassword), undefined, async (client) => {
      const { searchEntries } = await client.search(s.searchBase, {
        scope: "base",
        filter: "(objectClass=*)",
        attributes: ["dn"],
        sizeLimit: 1,
        timeLimit: 10,
      });
      return searchEntries.length;
    });
    return { ok: true, message: `Connected — service bind succeeded, search base resolved (${count} entry).` };
  } catch (err: any) {
    return { ok: false, message: formatLdapError(err) };
  }
}
