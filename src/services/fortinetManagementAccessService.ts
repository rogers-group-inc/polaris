/**
 * src/services/fortinetManagementAccessService.ts
 *
 * Summarizes the management-access configuration (`allowaccess` — the set of
 * protocols permitted on a device's management surface, e.g. "ping https ssh
 * snmp") for Fortinet devices discovered through a FortiManager or standalone
 * FortiGate integration, into the shape stored on `Asset.managementAccess`.
 *
 * Nothing here talks to a device. The per-gate discovery pass reads the four
 * tables below alongside the reads it already makes (both collectors:
 * fortigateService for standalone + FortiManager direct mode, the FMG device-DB
 * steps for FortiManager proxy mode) and hands the rows to
 * `summarizeGateManagementAccess`; sync Phase 13.6 only writes the result.
 * Until 2026-11 Phase 13.6 re-read every gate after discovery finished — a
 * second sweep of up to five whole tables per gate, plus a management-IP
 * lookup per gate in direct mode that missed every HA pair.
 *
 * Three device classes read their access config from different places:
 *   - Firewall (FortiGate) — the operator-named management interface's
 *     `allowaccess` from `system/interface`.
 *   - Access point (FortiAP) — the AP's `wtp-profile` `allowaccess` on the
 *     controller FortiGate, joined to the AP via `wireless-controller/wtp`.
 *   - Switch (FortiSwitch) — a managed switch has no per-device profile the
 *     way an AP does; its management access is a POLICY on the controller
 *     FortiGate (`config switch-controller security-policy local-access`),
 *     which states two lists: `mgmt-allowaccess` (the dedicated out-of-band
 *     MGMT port) and `internal-allowaccess` (the in-band `internal` SVI, which
 *     is what a FortiLink-managed switch answers on and therefore what Polaris
 *     polls). The half is chosen from the integration's
 *     `switchManagementInterface`: a `mgmt`-named interface reads the mgmt
 *     list, anything else the internal list. The policy is FLEET-WIDE, not per
 *     switch — FortiOS offers no way to attach a different local-access policy
 *     to an individual managed switch (confirmed against prod, 2026-09-03) — so
 *     `pickLocalAccessPolicy` resolves the `default` policy. (A per-switch
 *     interface `allowaccess` on the managed-switch row was consulted first
 *     until 2026-11; no firmware was ever seen exposing one, and reading it
 *     cost a whole managed-switch table per gate, so it was dropped.)
 *
 * A value this cannot read stays `protocols: null` (unknown) — never `[]`,
 * which would claim "nothing permitted" and hide the slide-over's Open HTTPS /
 * Open SSH buttons. FortiManager's device DB and FortiOS REST encode the same
 * fields differently (arrays vs space-separated strings, one-element arrays for
 * references), so every parser accepts both and refuses anything else.
 *
 * The summary drives the asset slide-over's Open HTTPS / Open SSH buttons and
 * the FortiAP "SNMP not enabled in profile" warning. Read-only.
 */

type ManagementAccessSource = "firewall-interface" | "fortiswitch" | "fortiap-profile";

export interface ManagementAccessSummary {
  source: ManagementAccessSource;
  /** Interface name the access was read from (firewall/switch), else null. */
  interfaceName: string | null;
  /** The named config object the access list came from: an AP's `wtp-profile`,
   *  or a switch's `switch-controller security-policy local-access` policy.
   *  Null on a firewall (its access is on the interface) and on a switch whose
   *  list could not be read. */
  profileName: string | null;
  /** IP the slide-over buttons should target. Falls back upstream to Asset.ipAddress. */
  mgmtIp: string | null;
  /** Normalized lowercase allowaccess list, or null when it could not be read. */
  protocols: string[] | null;
  https: boolean;
  ssh: boolean;
  snmp: boolean;
  /** ISO timestamp of the read. */
  checkedAt: string;
}

/** One device's summary, as discovery carries it on `DiscoveryResult.managementAccess`. */
export interface DiscoveredManagementAccess {
  serial: string;
  summary: ManagementAccessSummary;
}

const DEFAULT_SWITCH_MGMT_INTERFACE = "internal";

// ─── Pure parsers (unit-tested) ───────────────────────────────────────────────

/**
 * Normalize an `allowaccess` value to a lowercase protocol list.
 * FortiOS REST returns a space-separated string ("ping https ssh snmp");
 * FortiManager's device DB returns an array of strings; some shapes use
 * `{q_origin_key|name}` objects. An empty string / empty array is a real
 * answer ("nothing permitted") and yields `[]`. Anything else — absent, a
 * number (a bitmask), an object, an array with an entry that is none of the
 * above — yields `null`: unknown, never a claim that nothing is permitted.
 */
export function parseAllowaccess(raw: unknown): string[] | null {
  const out: string[] = [];
  const push = (s: string) => {
    for (const tok of s.trim().split(/\s+/)) {
      const t = tok.trim().toLowerCase();
      if (t) out.push(t);
    }
  };
  if (typeof raw === "string") {
    push(raw);
  } else if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === "string") { push(entry); continue; }
      const named = entry && typeof entry === "object"
        ? ((entry as Record<string, unknown>).q_origin_key ?? (entry as Record<string, unknown>).name)
        : undefined;
      if (typeof named !== "string") return null;
      push(named);
    }
  } else {
    return null;
  }
  // Dedupe, preserve order.
  return [...new Set(out)];
}

/** Convenience booleans for the protocols that drive UI affordances. */
export function protocolFlags(protocols: string[] | null): { https: boolean; ssh: boolean; snmp: boolean } {
  if (!protocols) return { https: false, ssh: false, snmp: false };
  const has = (p: string) => protocols.includes(p);
  return { https: has("https"), ssh: has("ssh"), snmp: has("snmp") };
}

/** The first IPv4 of an interface `ip` field: FortiOS REST "10.0.0.1 255.255.255.0",
 *  FortiManager's device DB ["10.0.0.1", "255.255.255.0"]. */
function firstIpToken(ip: unknown): string | null {
  const first = Array.isArray(ip) ? ip[0] : ip;
  if (typeof first !== "string") return null;
  const tok = first.trim().split(/\s+/)[0];
  return tok && tok !== "0.0.0.0" ? tok : null;
}

/** A reference field as a name: FortiOS REST gives a string, FortiManager's
 *  device DB a one-element array of strings. */
function referenceName(v: unknown): string | null {
  const first = Array.isArray(v) ? (v.length === 1 ? v[0] : undefined) : v;
  return typeof first === "string" && first.trim() ? first.trim() : null;
}

function normalizeCmdbArray(res: unknown): any[] {
  if (Array.isArray(res)) return res;
  if (res && typeof res === "object" && Array.isArray((res as any).results)) return (res as any).results;
  return [];
}

/** Find a CMDB `system/interface` row by name (case-insensitive). */
export function findInterfaceRow(cmdbInterfaces: unknown, ifName: string | null | undefined): any | null {
  const name = (ifName ?? "").trim().toLowerCase();
  if (!name) return null;
  for (const row of normalizeCmdbArray(cmdbInterfaces)) {
    if (row && typeof row === "object" && typeof row.name === "string" && row.name.trim().toLowerCase() === name) {
      return row;
    }
  }
  return null;
}

function buildSummary(
  source: ManagementAccessSource,
  fields: { interfaceName?: string | null; profileName?: string | null; mgmtIp?: string | null; protocols: string[] | null },
  checkedAt: string,
): ManagementAccessSummary {
  const flags = protocolFlags(fields.protocols);
  return {
    source,
    interfaceName: fields.interfaceName ?? null,
    profileName: fields.profileName ?? null,
    mgmtIp: fields.mgmtIp ?? null,
    protocols: fields.protocols,
    ...flags,
    checkedAt,
  };
}

/**
 * Firewall summary from a `system/interface` table + the operator-named
 * management interface. Returns null when the named interface isn't present
 * (so the caller leaves managementAccess untouched).
 */
export function buildFirewallSummary(
  cmdbInterfaces: unknown,
  mgmtInterfaceName: string | null | undefined,
  fallbackMgmtIp: string | null | undefined,
  checkedAt: string,
): ManagementAccessSummary | null {
  const row = findInterfaceRow(cmdbInterfaces, mgmtInterfaceName);
  if (!row) return null;
  return buildSummary(
    "firewall-interface",
    {
      interfaceName: typeof row.name === "string" ? row.name : (mgmtInterfaceName ?? null),
      mgmtIp: firstIpToken(row.ip) ?? (fallbackMgmtIp || null),
      protocols: parseAllowaccess(row.allowaccess),
    },
    checkedAt,
  );
}

/** profileName(lowercased) → protocol list (null = unreadable), from a `wtp-profile` table. */
export function parseWtpProfiles(res: unknown): Map<string, string[] | null> {
  const map = new Map<string, string[] | null>();
  for (const row of normalizeCmdbArray(res)) {
    if (row && typeof row === "object" && typeof row.name === "string") {
      map.set(row.name.trim().toLowerCase(), parseAllowaccess(row.allowaccess));
    }
  }
  return map;
}

/** AP serial(uppercased) → profile name, from a `wtp` table. */
export function parseWtpToProfile(res: unknown): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of normalizeCmdbArray(res)) {
    if (!row || typeof row !== "object") continue;
    const serial = row.serial ?? row["wtp-id"] ?? row.wtp_id ?? row.name;
    const profile = referenceName(row["wtp-profile"] ?? row.wtp_profile);
    if (typeof serial === "string" && serial.trim() && profile) {
      map.set(serial.trim().toUpperCase(), profile);
    }
  }
  return map;
}

/**
 * AP summary by joining the AP serial → wtp-profile → allowaccess. Returns null
 * when the AP can't be resolved to a profile (leaves managementAccess
 * untouched). A profile that is not in the profile table (or the table was not
 * read) is unknown — `protocols: null`.
 */
export function buildApSummary(
  apSerial: string,
  apIp: string | null | undefined,
  wtpToProfile: Map<string, string>,
  profiles: Map<string, string[] | null>,
  checkedAt: string,
): ManagementAccessSummary | null {
  const profileName = wtpToProfile.get((apSerial ?? "").trim().toUpperCase());
  if (!profileName) return null;
  const protocols = profiles.get(profileName.toLowerCase()) ?? null;
  return buildSummary(
    "fortiap-profile",
    { profileName, mgmtIp: apIp || null, protocols },
    checkedAt,
  );
}

/** One `switch-controller security-policy local-access` policy. Either list is
 *  null when the policy doesn't state it (never `[]`, which would read as "no
 *  protocol permitted" — a positive claim this cannot make). */
export interface LocalAccessPolicy {
  name: string;
  /** `mgmt-allowaccess` — the dedicated out-of-band MGMT port. */
  mgmt: string[] | null;
  /** `internal-allowaccess` — the in-band `internal` SVI. */
  internal: string[] | null;
}

/**
 * Parse the local-access policies off a `local-access` table into a
 * name(lowercased) -> policy map. An absent or unreadable list stays null
 * rather than becoming an empty allowaccess (see LocalAccessPolicy).
 */
export function parseLocalAccessPolicies(res: unknown): Map<string, LocalAccessPolicy> {
  const map = new Map<string, LocalAccessPolicy>();
  for (const row of normalizeCmdbArray(res)) {
    if (!row || typeof row !== "object") continue;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!name) continue;
    map.set(name.toLowerCase(), {
      name,
      mgmt: parseAllowaccess(row["mgmt-allowaccess"] ?? row.mgmt_allowaccess),
      internal: parseAllowaccess(row["internal-allowaccess"] ?? row.internal_allowaccess),
    });
  }
  return map;
}

/**
 * Which half of a local-access policy a switch's management interface reads.
 * `mgmt` is the dedicated out-of-band port; everything else — `internal` and
 * any operator-named SVI — is in-band, which is what a FortiLink-managed
 * switch answers on and what Polaris polls.
 */
export function localAccessHalfFor(switchIfaceName: string): "mgmt" | "internal" {
  const n = (switchIfaceName ?? "").trim().toLowerCase();
  return n.startsWith("mgmt") ? "mgmt" : "internal";
}

/**
 * The policy that governs a controller's managed switches. FortiOS has no
 * per-switch attachment for a local-access policy — the `default` policy
 * governs every managed switch (confirmed against prod, 2026-09-03) — so that
 * is the answer, and a site that renamed its only policy still resolves, since
 * one policy can only be the one in force.
 */
export function pickLocalAccessPolicy(
  policies: Map<string, LocalAccessPolicy> | null | undefined,
): LocalAccessPolicy | null {
  if (!policies || policies.size === 0) return null;
  const dflt = policies.get("default");
  if (dflt) return dflt;
  if (policies.size === 1) return [...policies.values()][0]!;
  return null;
}

/**
 * Switch summary — the protocols the controller's local-access policy permits
 * on the half of the switch Polaris reaches it by (`localAccessHalfFor`).
 * Nothing readable => `protocols: null` (unknown, NOT "nothing permitted"), and
 * the UI renders both verbs optimistically with an "unverified" note.
 */
export function buildSwitchSummary(
  switchIfaceName: string,
  switchIp: string | null | undefined,
  checkedAt: string,
  policies?: Map<string, LocalAccessPolicy> | null,
): ManagementAccessSummary {
  let protocols: string[] | null = null;
  let profileName: string | null = null;
  const policy = pickLocalAccessPolicy(policies);
  if (policy) {
    const list = localAccessHalfFor(switchIfaceName) === "mgmt" ? policy.mgmt : policy.internal;
    if (list) {
      protocols = list;
      profileName = policy.name;
    }
  }
  return buildSummary(
    "fortiswitch",
    { interfaceName: switchIfaceName, profileName, mgmtIp: switchIp || null, protocols },
    checkedAt,
  );
}

/**
 * Reduce a stored `Asset.managementAccess` blob to the four fields a client
 * needs in order to decide whether to offer Open HTTPS / Open SSH
 * (`_assetMgmtAccess` in public/js/assets.js). Shared by the Assets list
 * shaping and the upstream-device resolver so the two surfaces cannot disagree
 * about what a device permits.
 *
 * `protocols` passes through as a NULL-vs-not signal: null means the list could
 * not be read, and the client then offers both verbs optimistically — so
 * collapsing it to a boolean would collapse the distinction it branches on.
 */
export function shapeManagementAccessForClient(
  ma: unknown,
): { mgmtIp: string | null; protocols: string[] | null; https: boolean; ssh: boolean } | null {
  const m = ma as Record<string, unknown> | null;
  if (!m || typeof m !== "object") return null;
  return {
    mgmtIp: typeof m.mgmtIp === "string" ? m.mgmtIp : null,
    protocols: Array.isArray(m.protocols) ? (m.protocols as string[]) : null,
    https: m.https === true,
    ssh: m.ssh === true,
  };
}

// ─── Per-gate summary (called by both discovery collectors) ───────────────────

/** What one gate's discovery pass read. A table left undefined/null was not
 *  read (failed, or the gate has nothing of that class). */
export interface GateManagementAccessInputs {
  /** The firewall itself (the primary — HA standbys are not summarized). */
  firewall?: { serial: string; mgmtIp?: string | null } | null;
  /** `system/interface` rows carrying `name`, `ip`, `allowaccess`. */
  interfaceRows?: unknown;
  mgmtInterfaceName?: string | null;
  aps?: Array<{ serial: string; ipAddress?: string | null }>;
  /** `wireless-controller/wtp` rows carrying `wtp-id` + `wtp-profile`. */
  wtpRows?: unknown;
  /** `wireless-controller/wtp-profile` rows carrying `name` + `allowaccess`. */
  wtpProfileRows?: unknown;
  switches?: Array<{ serial: string; ipAddress?: string | null }>;
  /** `switch-controller security-policy local-access` rows. */
  localAccessRows?: unknown;
  switchManagementInterface?: string | null;
  checkedAt?: string;
}

/**
 * Every summary one gate's discovery pass can produce, keyed by device serial.
 * A device whose source table was not read gets no entry (its stored
 * managementAccess is left as-is), with one exception kept from the original
 * live pass: a managed switch always gets a summary, unknown when the
 * local-access table was unreadable.
 */
export function summarizeGateManagementAccess(i: GateManagementAccessInputs): DiscoveredManagementAccess[] {
  const out: DiscoveredManagementAccess[] = [];
  const checkedAt = i.checkedAt ?? new Date().toISOString();
  const mgmtIfaceName = (i.mgmtInterfaceName ?? "").trim() || "mgmt";
  const switchIfaceName = (i.switchManagementInterface ?? "").trim() || DEFAULT_SWITCH_MGMT_INTERFACE;

  if (i.firewall?.serial && i.interfaceRows != null) {
    const summary = buildFirewallSummary(i.interfaceRows, mgmtIfaceName, i.firewall.mgmtIp, checkedAt);
    if (summary) out.push({ serial: i.firewall.serial, summary });
  }

  const aps = (i.aps ?? []).filter((a) => a?.serial);
  if (aps.length > 0 && i.wtpRows != null) {
    const wtpToProfile = parseWtpToProfile(i.wtpRows);
    const profiles = parseWtpProfiles(i.wtpProfileRows);
    for (const ap of aps) {
      const summary = buildApSummary(ap.serial, ap.ipAddress, wtpToProfile, profiles, checkedAt);
      if (summary) out.push({ serial: ap.serial, summary });
    }
  }

  const switches = (i.switches ?? []).filter((s) => s?.serial);
  if (switches.length > 0) {
    const policies = parseLocalAccessPolicies(i.localAccessRows);
    for (const sw of switches) {
      out.push({ serial: sw.serial, summary: buildSwitchSummary(switchIfaceName, sw.ipAddress, checkedAt, policies) });
    }
  }
  return out;
}
