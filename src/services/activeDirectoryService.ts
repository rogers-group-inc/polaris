/**
 * src/services/activeDirectoryService.ts — On-premise Active Directory device discovery
 *
 * Authenticates to a domain controller via LDAP simple bind (LDAP or LDAPS)
 * and queries computer objects under a configured base DN. Produces assets
 * only — no subnets, reservations, or VIPs.
 *
 * Cross-links with the Entra ID integration via the on-prem SID: both sides
 * persist `sid:{SID}` in the asset tags array so hybrid-joined devices resolve
 * to a single asset regardless of which integration found them first.
 */

import { type Entry, type SearchOptions } from "ldapts";
import { AppError } from "../utils/errors.js";
import { matchesWildcard } from "../utils/integrationFilter.js";
import type { DirectoryPerson, DirectorySyncFilter } from "./directorySyncService.js";
import { withBoundLdapClient, decodeObjectGuid, formatLdapError, escapeLdapFilterValue } from "./ldapClient.js";
import { ldapGuidFilterValue } from "./discovery/discoveryScope.js";

export interface ActiveDirectoryConfig {
  host: string;
  port?: number;
  useLdaps?: boolean;
  verifyTls?: boolean;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  searchScope?: "sub" | "one";
  ouInclude?: string[];   // Wildcards match against distinguishedName (e.g. *OU=Servers*)
  ouExclude?: string[];
  includeDisabled?: boolean;  // Default true — disabled accounts become `decommissioned` assets
}

export interface DiscoveredAdDevice {
  objectGuid: string;           // Lowercase hex (stable AD identifier → Asset.assetTag = "ad:{guid}")
  objectSid: string;            // String SID (cross-link to Entra's onPremisesSecurityIdentifier)
  cn: string;                   // Short hostname
  dnsHostName: string;          // FQDN (preferred for Asset.hostname if present)
  distinguishedName: string;
  operatingSystem: string;
  operatingSystemVersion: string;
  description: string;
  whenCreated?: string;         // ISO
  lastLogonTimestamp?: string;  // ISO (from Windows FILETIME); replicates only every ~14 days
  disabled: boolean;            // userAccountControl & 0x2 (ACCOUNTDISABLE)
  ouPath: string;               // Derived from DN, e.g. "OU=Workstations/OU=HQ"
}

export interface AdDiscoveryResult {
  devices: DiscoveredAdDevice[];
}

export type AdDiscoveryProgressCallback = (
  step: string,
  level: "info" | "error",
  message: string,
) => void;

// LDAP connection + bind lifecycle lives in ./ldapClient (shared with the
// LDAP user-auth path). withBoundLdapClient accepts our config structurally.

// ─── Connection test ────────────────────────────────────────────────────────

export async function testConnection(config: ActiveDirectoryConfig): Promise<{
  ok: boolean;
  message: string;
}> {
  if (!config.host)         return { ok: false, message: "Host is required" };
  if (!config.bindDn)       return { ok: false, message: "Bind DN is required" };
  if (!config.bindPassword) return { ok: false, message: "Bind password is required" };
  if (!config.baseDn)       return { ok: false, message: "Base DN is required" };

  try {
    const count = await withBoundLdapClient(config, undefined, async (client) => {
      const { searchEntries } = await client.search(config.baseDn, {
        scope: config.searchScope || "sub",
        filter: "(&(objectCategory=computer)(objectClass=computer))",
        attributes: ["cn"],
        sizeLimit: 1,
        timeLimit: 10,
      });
      return searchEntries.length;
    });
    return { ok: true, message: `Connected — bind succeeded, sample computer query returned ${count} entry(s)` };
  } catch (err: any) {
    return { ok: false, message: formatLdapError(err) };
  }
}

// ─── Directory (GAL) search ─────────────────────────────────────────────────
//
// The address book's live lookup into on-prem AD. Discovery is otherwise
// hard-filtered to computer objects — this is the first PEOPLE query here, and
// nothing it returns is persisted; only an address an operator picks becomes a
// rule recipient or a saved Contact. Gated per-integration by
// `enableDirectorySearch`, since the bind account needs read access to user /
// group / contact objects that a computers-only deployment may not have granted.
//
// The attribute plumbing (mail, escaping, bind) is already proven by
// ldapAuthService, which reads `mail` on every LDAP login.

/** One directory hit, normalized to the address-book entry shape. */
export interface DirectoryHit {
  id: string;
  email: string;
  name: string | null;
  description: string | null;
  kind: "person" | "group";
}

function firstStr(v: unknown): string | null {
  if (Array.isArray(v)) return v.length ? String(v[0]) : null;
  if (v == null) return null;
  const s = String(v);
  return s === "" ? null : s;
}

/**
 * Search users, mail-enabled groups and contacts under the configured base DN.
 * One search rather than three: AD can OR the object classes in a single
 * filter, and `(mail=*)` drops anything that can't receive email anyway.
 */
export async function searchDirectoryAd(
  config: ActiveDirectoryConfig,
  query: string,
  limit = 25,
): Promise<DirectoryHit[]> {
  const raw = query.trim();
  if (raw.length < 2) return [];
  if (!config.baseDn) return [];
  const q = escapeLdapFilterValue(raw);

  const filter =
    "(&(mail=*)" +
      "(|(objectClass=user)(objectClass=group)(objectClass=contact))" +
      `(|(cn=*${q}*)(mail=*${q}*)(displayName=*${q}*)(sAMAccountName=*${q}*))` +
    ")";

  return withBoundLdapClient(config, undefined, async (client) => {
    const { searchEntries } = await client.search(config.baseDn, {
      scope: (config.searchScope as SearchOptions["scope"]) || "sub",
      filter,
      attributes: ["cn", "displayName", "mail", "description", "department", "title", "objectClass", "objectGUID"],
      sizeLimit: Math.min(Math.max(limit, 1), 100),
      timeLimit: 15,
    });

    const out: DirectoryHit[] = [];
    for (const e of searchEntries) {
      const mail = firstStr((e as any).mail);
      if (!mail) continue;
      const classes = ([] as string[]).concat((e as any).objectClass ?? []).map((c) => String(c).toLowerCase());
      const isGroup = classes.includes("group");
      const bits = [firstStr((e as any).title), firstStr((e as any).department)].filter(Boolean);
      out.push({
        // objectGUID is the stable identity, but it's a Buffer; the DN is
        // already unique and human-readable, and nothing persists this id.
        id: String(e.dn),
        email: mail,
        name: firstStr((e as any).displayName) ?? firstStr((e as any).cn),
        description: firstStr((e as any).description) || bits.join(" — ") || (isGroup ? "Distribution list" : null),
        kind: isGroup ? "group" : "person",
      });
    }
    return out.slice(0, limit);
  });
}


// ─── Directory (GAL) bulk read ──────────────────────────────────────────────
//
// The scheduled sync's reader (business rule 35). Same bind and the same
// grants as the live search above, but a full enumeration rather than a term
// match -- which changes the search options completely: searchDirectoryAd
// clamps sizeLimit to 100 and does no paging, which is right for a typeahead
// and would silently truncate a GAL at AD's MaxPageSize of 1000.
//
// The options below are copied from discoverDevices, which already does a
// paged enumeration against the same directory. Note that ldapts accumulates
// every page into `searchEntries` before returning, so `maxEntries` -- not the
// page size -- is what actually bounds memory here.

/** Exchange's mailbox-type discriminator (msExchRecipientTypeDetails). */
const EXCH_SHARED = 4;
const EXCH_ROOM = 16;
const EXCH_EQUIPMENT = 32;

/**
 * The whole GAL filter as one string. PURE and exported so it can be asserted
 * on directly: an LDAP filter is the kind of thing that is either exactly right
 * or silently returns the wrong population, and it is far cheaper to pin the
 * string than to discover the mistake against a live directory.
 *
 * `(mail=*)` is not an optimization -- an object with no address can never be
 * a recipient, so it has no business in the address book.
 *
 * OU include/exclude are deliberately NOT here. They match DNs with wildcards,
 * which an LDAP filter cannot express, so they are applied in JS afterwards via
 * directoryExclusionReason -- the same split discoverDevices already uses.
 */
export function buildGalLdapFilter(filter: DirectorySyncFilter): string {
  const classes = ["(&(objectCategory=person)(objectClass=user))", "(objectClass=contact)"];
  // A mail-enabled group is a distribution list. Excluded at the SOURCE when
  // the operator doesn't want them, rather than fetched and dropped.
  if (filter.includeGroups) classes.push("(&(objectClass=group)(mail=*))");

  const parts = ["(mail=*)", `(|${classes.join("")})`];

  // LDAP_MATCHING_RULE_BIT_AND against userAccountControl bit 2 (ACCOUNTDISABLE).
  // Contacts and groups have no userAccountControl at all, and an absent
  // attribute does not match the bit test -- so this negation keeps them.
  if (filter.excludeDisabled) parts.push("(!(userAccountControl:1.2.840.113556.1.4.803:=2))");

  // Unlike Graph, AD answers this honestly wherever the Exchange schema is
  // present. Where it is absent the attribute is simply missing, and these
  // negations keep the entry -- the correct default, since an install with no
  // Exchange schema has no shared mailboxes to exclude.
  if (filter.excludeSharedMailboxes) {
    for (const v of [EXCH_SHARED, EXCH_ROOM, EXCH_EQUIPMENT]) {
      parts.push(`(!(msExchRecipientTypeDetails=${v}))`);
    }
  }

  return `(&${parts.join("")})`;
}

/** Attributes the GAL read needs, beyond what the device read asks for. */
const GAL_ATTRIBUTES = [
  "objectGUID", "distinguishedName", "cn", "displayName", "mail", "title", "department",
  "telephoneNumber", "mobile", "description", "objectClass", "userAccountControl",
  "msExchRecipientTypeDetails", "memberOf",
];

function mailboxKindOf(raw: unknown): "user" | "shared" | "room" | "equipment" | "unknown" {
  const n = Number(firstStr(raw));
  if (!Number.isFinite(n)) return "unknown"; // no Exchange schema: not a claim either way
  if (n === EXCH_SHARED) return "shared";
  if (n === EXCH_ROOM) return "room";
  if (n === EXCH_EQUIPMENT) return "equipment";
  return "user";
}

/**
 * Every mail-enabled user, contact and distribution list under the base DN.
 *
 * The identity is objectGUID, NOT the DN the live search uses: this one is
 * PERSISTED as provenance, and a DN changes when a person moves OU or is
 * renamed -- which would read as "the old person left, a new one arrived" and
 * churn the contact row on every reorganization. The GUID survives both.
 */
export async function listDirectoryPeople(
  config: ActiveDirectoryConfig,
  filter: DirectorySyncFilter,
  signal?: AbortSignal,
): Promise<DirectoryPerson[]> {
  if (!config.baseDn) return [];
  const ldapFilter = buildGalLdapFilter(filter);

  return withBoundLdapClient(config, signal, async (client) => {
    const { searchEntries } = await client.search(config.baseDn as string, {
      scope: (config.searchScope as SearchOptions["scope"]) || "sub",
      filter: ldapFilter,
      attributes: GAL_ATTRIBUTES,
      explicitBufferAttributes: ["objectGUID"],
      paged: { pageSize: PAGE_SIZE },
      sizeLimit: filter.maxEntries,
      timeLimit: 120,
    });

    const out: DirectoryPerson[] = [];
    for (const e of searchEntries) {
      if (signal?.aborted) break;
      const mail = firstStr((e as any).mail);
      if (!mail) continue;

      const guidRaw = (e as any).objectGUID;
      const guid = Buffer.isBuffer(guidRaw) ? decodeObjectGuid(guidRaw) : "";
      // Same guard parseEntry applies to computers: an all-zero GUID shows up
      // on half-provisioned objects and would collide with every other one.
      if (!guid || /^0+$/.test(guid)) continue;

      const classes = ([] as string[]).concat((e as any).objectClass ?? []).map((c) => String(c).toLowerCase());
      const isGroup = classes.includes("group");
      // firstStr returns null when the attribute is absent, and Number(null)
      // is 0 -- which would read as a present-and-enabled account. Keep the
      // absent case NaN so it stays "no claim".
      const uacRaw = firstStr((e as any).userAccountControl);
      const uac = uacRaw == null ? NaN : Number(uacRaw);

      out.push({
        externalId: guid,
        email: mail,
        name: firstStr((e as any).displayName) ?? firstStr((e as any).cn),
        jobTitle: firstStr((e as any).title),
        department: firstStr((e as any).department),
        phone: firstStr((e as any).telephoneNumber) ?? firstStr((e as any).mobile),
        description: firstStr((e as any).description) ?? (isGroup ? "Distribution list" : null),
        kind: isGroup ? "group" : "person",
        distinguishedName: e.dn || firstStr((e as any).distinguishedName) || undefined,
        // Only a claim when the attribute was actually present: a missing
        // userAccountControl (every contact and group) is not "enabled".
        disabled: Number.isFinite(uac) ? (uac & 2) === 2 : undefined,
        mailboxKind: mailboxKindOf((e as any).msExchRecipientTypeDetails),
        groupDns: ([] as string[]).concat((e as any).memberOf ?? []).map((g) => String(g)),
      });
    }
    return out.slice(0, filter.maxEntries);
  });
}

// ─── Manual query (UI tool) ─────────────────────────────────────────────────

/**
 * Run an arbitrary LDAP search against the configured DC using stored
 * credentials. baseDn defaults to the integration's configured base.
 * Returns plain objects with Buffer attributes stringified where possible.
 */
export async function proxyQuery(
  config: ActiveDirectoryConfig,
  body: { filter?: string; baseDn?: string; scope?: "sub" | "one" | "base"; attributes?: string[]; sizeLimit?: number },
): Promise<unknown> {
  const filter = body.filter?.trim() || "(&(objectCategory=computer)(objectClass=computer))";
  const baseDn = body.baseDn?.trim() || config.baseDn;
  if (!baseDn) throw new AppError(400, "baseDn is required (either in the query or the integration config)");

  const size = Math.min(Math.max(body.sizeLimit || 50, 1), 500);
  const attrs = body.attributes && body.attributes.length > 0 ? body.attributes : undefined;

  return withBoundLdapClient(config, undefined, async (client) => {
    const { searchEntries } = await client.search(baseDn, {
      scope: body.scope || "sub",
      filter,
      attributes: attrs,
      sizeLimit: size,
      timeLimit: 15,
    });
    return { entries: searchEntries.map(simplifyEntry) };
  });
}

function simplifyEntry(entry: Entry): Record<string, unknown> {
  const out: Record<string, unknown> = { dn: entry.dn };
  for (const key of Object.keys(entry)) {
    if (key === "dn") continue;
    const v = (entry as any)[key];
    if (Buffer.isBuffer(v)) {
      out[key] = v.toString("utf8");
    } else if (Array.isArray(v) && v.length > 0 && Buffer.isBuffer(v[0])) {
      out[key] = (v as Buffer[]).map((b) => b.toString("utf8"));
    } else {
      out[key] = v;
    }
  }
  return out;
}

// ─── Device discovery ───────────────────────────────────────────────────────

const DEVICES_HARD_CAP = 10_000;
const PAGE_SIZE = 1000;

const ATTRIBUTES = [
  "objectGUID",
  "objectSid",
  "cn",
  "dNSHostName",
  "distinguishedName",
  "operatingSystem",
  "operatingSystemVersion",
  "description",
  "whenCreated",
  "lastLogonTimestamp",
  "userAccountControl",
];

// Attributes that must come back as raw bytes so we can decode them ourselves.
const BUFFER_ATTRIBUTES = ["objectGUID", "objectSid"];

export async function discoverDevices(
  config: ActiveDirectoryConfig,
  signal?: AbortSignal,
  onProgress?: AdDiscoveryProgressCallback,
  /**
   * Narrow the run to ONE computer object, by `objectGUID` (the value stored
   * on the AssetSource row). Backs the asset slide-in's "Discover Now".
   *
   * Keyed on the GUID rather than the DN on purpose: a computer object that
   * moves OU keeps its GUID and changes its DN, so a DN-based search would
   * silently find nothing for exactly the machines most likely to need a
   * refresh. The search still runs from `config.baseDn` at the configured
   * scope, so an object moved OUT of the base DN correctly returns nothing —
   * that is the same answer a full run would give.
   */
  scope?: { objectGuid: string },
): Promise<AdDiscoveryResult> {
  const log = onProgress || (() => {});

  if (!config.host)         throw new AppError(400, "Host is required");
  if (!config.bindDn)       throw new AppError(400, "Bind DN is required");
  if (!config.bindPassword) throw new AppError(400, "Bind password is required");
  if (!config.baseDn)       throw new AppError(400, "Base DN is required");

  // objectGUID is binary: the filter needs escaped bytes, not the hex string.
  // A malformed stored GUID must fail loudly rather than build a filter that
  // matches the wrong object (or, worse, everything).
  const scopedGuidFilter = scope ? ldapGuidFilterValue(scope.objectGuid) : null;
  if (scope && !scopedGuidFilter) {
    throw new AppError(400, `Malformed AD objectGUID for scoped discovery: ${scope.objectGuid}`);
  }

  const devices: DiscoveredAdDevice[] = [];

  try {
    await withBoundLdapClient(config, signal, async (client) => {
      const options: SearchOptions = {
        scope: config.searchScope || "sub",
        filter: scopedGuidFilter
          ? `(&(objectCategory=computer)(objectClass=computer)(objectGUID=${scopedGuidFilter}))`
          : "(&(objectCategory=computer)(objectClass=computer))",
        attributes: ATTRIBUTES,
        explicitBufferAttributes: BUFFER_ATTRIBUTES,
        paged: { pageSize: PAGE_SIZE },
        sizeLimit: DEVICES_HARD_CAP,
        timeLimit: 120,
      };
      const { searchEntries } = await client.search(config.baseDn, options);

      for (const entry of searchEntries) {
        if (signal?.aborted) break;
        const dev = parseEntry(entry);
        if (!dev) continue;
        devices.push(dev);
      }
    });
  } catch (err: any) {
    const msg = formatLdapError(err);
    log("discover.ad.search", "error", `Active Directory: search failed — ${msg}`);
    throw new AppError(502, `Active Directory search failed: ${msg}`);
  }

  log("discover.ad.search", "info", `Active Directory: retrieved ${devices.length} computer object(s)`);

  const filtered = filterDevices(devices, config.ouInclude, config.ouExclude);
  const dropped = devices.length - filtered.length;
  if (dropped > 0) {
    log("discover.filter", "info", `Device filter: ${filtered.length} included, ${dropped} excluded`);
  }

  if (config.includeDisabled === false) {
    const beforeDisabled = filtered.length;
    const active = filtered.filter((d) => !d.disabled);
    const disabledCount = beforeDisabled - active.length;
    if (disabledCount > 0) {
      log("discover.filter.disabled", "info", `Skipping ${disabledCount} disabled computer account(s) (includeDisabled=false)`);
    }
    return { devices: active };
  }

  return { devices: filtered };
}

// ─── Parsing helpers ────────────────────────────────────────────────────────

function parseEntry(entry: Entry): DiscoveredAdDevice | null {
  const guidRaw = entry.objectGUID;
  const sidRaw = entry.objectSid;
  const guid = Buffer.isBuffer(guidRaw) ? decodeObjectGuid(guidRaw) : "";
  const sid = Buffer.isBuffer(sidRaw) ? decodeObjectSid(sidRaw) : "";
  // Reject empty or all-zero GUIDs (32 hex zeros). The latter shows up on
  // half-provisioned computer objects and would otherwise produce an asset
  // tagged "ad:00000000000000000000000000000000" that collides with every
  // other broken entry.
  if (!guid || /^0+$/.test(guid)) return null;

  const cn = readString(entry.cn);
  const dnsHostName = readString(entry.dNSHostName);
  const distinguishedName = entry.dn || readString(entry.distinguishedName);
  const os = readString(entry.operatingSystem);
  const osVersion = readString(entry.operatingSystemVersion);
  const description = readString(entry.description);
  const whenCreated = decodeGeneralizedTime(readString(entry.whenCreated));
  const lastLogon = decodeFileTime(readString(entry.lastLogonTimestamp));
  const uac = parseInt(readString(entry.userAccountControl) || "0", 10);
  const disabled = (uac & 0x2) === 0x2;
  const ouPath = deriveOuPath(distinguishedName);

  return {
    objectGuid: guid,
    objectSid: sid,
    cn,
    dnsHostName,
    distinguishedName,
    operatingSystem: os,
    operatingSystemVersion: osVersion,
    description,
    whenCreated,
    lastLogonTimestamp: lastLogon,
    disabled,
    ouPath,
  };
}

function readString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  if (Array.isArray(v)) return readString(v[0]);
  return String(v);
}

// decodeObjectGuid lives in ./ldapClient (shared with LDAP user-auth).

// objectSid is a binary SID structure. Decode to the standard S-1-<auth>-<sub>...
// string form.
function decodeObjectSid(buf: Buffer): string {
  if (buf.length < 8) return "";
  const revision = buf.readUInt8(0);
  const subAuthCount = buf.readUInt8(1);
  // identifierAuthority is a 48-bit big-endian integer
  const authority =
    buf.readUIntBE(2, 6); // safe for values up to 2^48
  const parts: string[] = [`S-${revision}-${authority}`];
  for (let i = 0; i < subAuthCount; i++) {
    const offset = 8 + i * 4;
    if (offset + 4 > buf.length) break;
    parts.push(String(buf.readUInt32LE(offset)));
  }
  return parts.join("-");
}

// AD Generalized Time: "YYYYMMDDHHMMSS.0Z" → ISO string
function decodeGeneralizedTime(s: string): string | undefined {
  if (!s) return undefined;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z$/);
  if (!m) return undefined;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

// Windows FILETIME: 100-nanosecond intervals since 1601-01-01 UTC → ISO string.
// AD returns "0" for never-logged-on, which we treat as undefined.
function decodeFileTime(s: string): string | undefined {
  if (!s || s === "0") return undefined;
  // Use BigInt to preserve precision; epoch offset is 11644473600 seconds.
  let n: bigint;
  try { n = BigInt(s); } catch { return undefined; }
  if (n <= 0n) return undefined;
  const ms = Number(n / 10000n) - 11644473600000;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

// "CN=FOO,OU=Workstations,OU=HQ,DC=corp,DC=local" → "OU=HQ/OU=Workstations"
// (outer→inner so a human reads the containment top-down).
function deriveOuPath(dn: string): string {
  if (!dn) return "";
  const parts = dn.split(/(?<!\\),/).map((p) => p.trim());
  const ous = parts.filter((p) => p.toUpperCase().startsWith("OU="));
  return ous.reverse().join("/");
}

// matchesWildcard is imported from ../utils/integrationFilter.js — the
// canonical glob-lite matcher shared by every device/VM/interface filter.

function filterDevices(
  devices: DiscoveredAdDevice[],
  include?: string[],
  exclude?: string[],
): DiscoveredAdDevice[] {
  if (include && include.length > 0) {
    return devices.filter((d) => include.some((p) => matchesWildcard(p, d.distinguishedName)));
  }
  if (exclude && exclude.length > 0) {
    return devices.filter((d) => !exclude.some((p) => matchesWildcard(p, d.distinguishedName)));
  }
  return devices;
}
