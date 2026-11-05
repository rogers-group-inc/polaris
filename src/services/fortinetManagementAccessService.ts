/**
 * src/services/fortinetManagementAccessService.ts
 *
 * Reads the management-access configuration (`allowaccess` — the set of
 * protocols permitted on a device's management surface, e.g. "ping https ssh
 * snmp") for Fortinet devices discovered through a FortiManager or standalone
 * FortiGate integration, and summarizes it into the shape stored on
 * `Asset.managementAccess`.
 *
 * Three device classes read their access config from different places:
 *   - Firewall (FortiGate) — the operator-named management interface's
 *     `allowaccess` from `/api/v2/cmdb/system/interface`.
 *   - Access point (FortiAP) — the AP's `wtp-profile` `allowaccess` on the
 *     controller FortiGate (`/api/v2/cmdb/wireless-controller/wtp-profile`,
 *     joined to the AP via `/api/v2/cmdb/wireless-controller/wtp`).
 *   - Switch (FortiSwitch) — a managed switch has no per-device profile the
 *     way an AP does; its management access is a POLICY on the controller
 *     FortiGate (`config switch-controller security-policy local-access`,
 *     REST `/api/v2/cmdb/switch-controller.security-policy/local-access`),
 *     which states two lists: `mgmt-allowaccess` (the dedicated out-of-band
 *     MGMT port) and `internal-allowaccess` (the in-band `internal` SVI, which
 *     is what a FortiLink-managed switch answers on and therefore what Polaris
 *     polls). The half is chosen from the integration's
 *     `switchManagementInterface`: a `mgmt`-named interface reads the mgmt
 *     list, anything else the internal list. A per-switch interface
 *     `allowaccess` on the managed-switch object still wins when the firmware
 *     exposes one. The policy is FLEET-WIDE, not per switch — FortiOS offers
 *     no way to attach a different local-access policy to an individual
 *     managed switch (confirmed against prod, 2026-09-03) — so
 *     `pickLocalAccessPolicy` resolves the `default` policy every managed
 *     switch answers to, and keeps a shape-matched assignment lookup only as a
 *     defensive first pass. When nothing can be read at all, `protocols` stays
 *     null (unknown) and the UI renders the buttons optimistically with a
 *     note.
 *
 * The summary drives the asset slide-over's Open HTTPS / Open SSH buttons and
 * the FortiAP "SNMP not enabled in profile" warning. It is read-only — nothing
 * here writes to the device.
 *
 * Transport is unified via buildTransportForIntegration + callFortiOs, so the
 * same code path serves FMG-proxy, FMG-direct, and standalone FortiGate.
 */

import { buildTransportForIntegration, callFortiOs } from "./reservationPushService.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { logger } from "../utils/logger.js";

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

const DEFAULT_SWITCH_MGMT_INTERFACE = "internal";

// ─── Pure parsers (unit-tested) ───────────────────────────────────────────────

/**
 * Normalize a FortiOS `allowaccess` value to a lowercase protocol list.
 * FortiOS returns it either as a space-separated string ("ping https ssh snmp")
 * or, on some CMDB/monitor shapes, an array of strings or `{q_origin_key|name}`
 * objects. Anything unrecognized yields an empty list (never throws).
 */
export function parseAllowaccess(raw: unknown): string[] {
  const out: string[] = [];
  const push = (s: unknown) => {
    if (typeof s !== "string") return;
    for (const tok of s.trim().split(/\s+/)) {
      const t = tok.trim().toLowerCase();
      if (t) out.push(t);
    }
  };
  if (typeof raw === "string") {
    push(raw);
  } else if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === "string") push(entry);
      else if (entry && typeof entry === "object") {
        const o = entry as Record<string, unknown>;
        push(o.q_origin_key ?? o.name ?? o.id);
      }
    }
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

/** Pull the first IPv4 token from a CMDB interface `ip` field ("10.0.0.1 255.255.255.0"). */
function firstIpToken(ip: unknown): string | null {
  if (typeof ip !== "string") return null;
  const tok = ip.trim().split(/\s+/)[0];
  return tok && tok !== "0.0.0.0" ? tok : null;
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
 * Firewall summary from a `/api/v2/cmdb/system/interface` response + the
 * operator-named management interface. Returns null when the named interface
 * isn't present (so the caller leaves managementAccess untouched).
 */
export function buildFirewallSummary(
  cmdbInterfaces: unknown,
  mgmtInterfaceName: string | null | undefined,
  fallbackMgmtIp: string | null | undefined,
  checkedAt: string,
): ManagementAccessSummary | null {
  const row = findInterfaceRow(cmdbInterfaces, mgmtInterfaceName);
  if (!row) return null;
  const protocols = parseAllowaccess(row.allowaccess);
  return buildSummary(
    "firewall-interface",
    {
      interfaceName: typeof row.name === "string" ? row.name : (mgmtInterfaceName ?? null),
      mgmtIp: firstIpToken(row.ip) ?? (fallbackMgmtIp || null),
      protocols,
    },
    checkedAt,
  );
}

/** profileName(lowercased) → protocol list, from a `wtp-profile` CMDB response. */
export function parseWtpProfiles(res: unknown): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of normalizeCmdbArray(res)) {
    if (row && typeof row === "object" && typeof row.name === "string") {
      map.set(row.name.trim().toLowerCase(), parseAllowaccess(row.allowaccess));
    }
  }
  return map;
}

/** AP serial(uppercased) → profile name, from a `wtp` CMDB response. */
export function parseWtpToProfile(res: unknown): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of normalizeCmdbArray(res)) {
    if (!row || typeof row !== "object") continue;
    const serial = row.serial ?? row["wtp-id"] ?? row.wtp_id ?? row.name;
    const profile = row["wtp-profile"] ?? row.wtp_profile;
    if (typeof serial === "string" && typeof profile === "string" && serial.trim() && profile.trim()) {
      map.set(serial.trim().toUpperCase(), profile.trim());
    }
  }
  return map;
}

/**
 * AP summary by joining the AP serial → wtp-profile → allowaccess. Returns null
 * when the AP can't be resolved to a profile (leaves managementAccess untouched).
 */
export function buildApSummary(
  apSerial: string,
  apIp: string | null | undefined,
  wtpToProfile: Map<string, string>,
  profiles: Map<string, string[]>,
  checkedAt: string,
): ManagementAccessSummary | null {
  const profileName = wtpToProfile.get((apSerial ?? "").trim().toUpperCase());
  if (!profileName) return null;
  const protocols = profiles.get(profileName.toLowerCase()) ?? [];
  return buildSummary(
    "fortiap-profile",
    { profileName, mgmtIp: apIp || null, protocols },
    checkedAt,
  );
}

/** The FortiGate CMDB path holding the managed-switch management-access ACL. */
const LOCAL_ACCESS_CMDB_PATH = "/api/v2/cmdb/switch-controller.security-policy/local-access";

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
 * Parse the local-access policies off a
 * `/api/v2/cmdb/switch-controller.security-policy/local-access` response into
 * a name(lowercased) -> policy map. An absent list stays null rather than
 * becoming an empty allowaccess (see LocalAccessPolicy).
 */
export function parseLocalAccessPolicies(res: unknown): Map<string, LocalAccessPolicy> {
  const map = new Map<string, LocalAccessPolicy>();
  for (const row of normalizeCmdbArray(res)) {
    if (!row || typeof row !== "object") continue;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!name) continue;
    const half = (v: unknown) => (v === undefined || v === null ? null : parseAllowaccess(v));
    map.set(name.toLowerCase(), {
      name,
      mgmt: half(row["mgmt-allowaccess"] ?? row.mgmt_allowaccess),
      internal: half(row["internal-allowaccess"] ?? row.internal_allowaccess),
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
 * Pick the policy that governs ONE managed switch.
 *
 * **The policy is fleet-wide.** FortiOS has no per-switch attachment for a
 * local-access policy — the `default` policy governs every managed switch a
 * controller has (confirmed against prod, 2026-09-03) — so that is the answer
 * this returns, and a site that renamed its only policy still resolves, since
 * one policy can only be the one in force.
 *
 * The assignment lookup ahead of it is a defensive first pass, kept for the
 * firmware that might grow one: it matches any key on the managed-switch row
 * whose NAME mentions `local-access` rather than guessing a literal field name,
 * because a wrong literal key resolves to nothing SILENTLY (the failure mode
 * utils/fortinetParentKey.ts exists to document) — and an unassigned switch,
 * which today is every switch, falls straight through it.
 */
export function pickLocalAccessPolicy(
  policies: Map<string, LocalAccessPolicy> | null | undefined,
  managedSwitchRow: unknown,
): LocalAccessPolicy | null {
  if (!policies || policies.size === 0) return null;
  if (managedSwitchRow && typeof managedSwitchRow === "object") {
    for (const [key, value] of Object.entries(managedSwitchRow as Record<string, unknown>)) {
      if (!key.toLowerCase().includes("local-access")) continue;
      const named =
        typeof value === "string"
          ? value
          : value && typeof value === "object"
            ? ((value as any).q_origin_key ?? (value as any).name)
            : null;
      if (typeof named !== "string" || !named.trim()) continue;
      const hit = policies.get(named.trim().toLowerCase());
      if (hit) return hit;
    }
  }
  const dflt = policies.get("default");
  if (dflt) return dflt;
  if (policies.size === 1) return [...policies.values()][0]!;
  return null;
}

/**
 * Switch summary — the protocols a managed FortiSwitch permits on the interface
 * Polaris reaches it by, most specific source first:
 *
 *   1. a per-switch interface `allowaccess` on the managed-switch object, on
 *      firmware that exposes one (never yet seen in the wild here, kept because
 *      it is the device's own statement about itself);
 *   2. the controller's `security-policy local-access` policy for this switch,
 *      reading the mgmt or internal half per `localAccessHalfFor`. This is the
 *      real answer on FortiOS 7.x — a managed switch has no per-device profile
 *      the way a FortiAP does.
 *
 * Neither available => `protocols: null` (unknown, NOT "nothing permitted"), and
 * the UI renders both verbs optimistically with an "unverified" note.
 */
export function buildSwitchSummary(
  managedSwitchRow: unknown,
  switchIfaceName: string,
  switchIp: string | null | undefined,
  checkedAt: string,
  policies?: Map<string, LocalAccessPolicy> | null,
): ManagementAccessSummary {
  let protocols: string[] | null = null;
  let profileName: string | null = null;
  if (managedSwitchRow && typeof managedSwitchRow === "object") {
    const row = managedSwitchRow as Record<string, any>;
    // Some firmware exposes a `switch-interface` / `interface` array on the
    // managed-switch object; try to find the named SVI's allowaccess.
    const ifaceArrays = [row["switch-interface"], row.interface, row.interfaces].filter(Array.isArray) as any[][];
    for (const arr of ifaceArrays) {
      const m = findInterfaceRow(arr, switchIfaceName);
      if (m && m.allowaccess !== undefined) {
        protocols = parseAllowaccess(m.allowaccess);
        break;
      }
    }
  }
  if (protocols == null) {
    const policy = pickLocalAccessPolicy(policies, managedSwitchRow);
    if (policy) {
      const list = localAccessHalfFor(switchIfaceName) === "mgmt" ? policy.mgmt : policy.internal;
      if (list) {
        protocols = list;
        profileName = policy.name;
      }
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

// ─── Live collection ──────────────────────────────────────────────────────────

export interface DeviceAccessGroup {
  /** Controller FortiGate device name (used to build the transport). */
  deviceName: string;
  /** The firewall itself, when this device is a discovered firewall asset. */
  firewall?: { serial: string; mgmtIp?: string | null } | null;
  switches: Array<{ serial: string; ipAddress?: string | null }>;
  aps: Array<{ serial: string; ipAddress?: string | null }>;
}

// Bounded-concurrency mapper shared via utils/concurrency (2026-08 dedup).

/**
 * Collect management-access summaries for every firewall / switch / AP in the
 * supplied groups. Returns a Map keyed by device SERIAL. Failures (transport
 * build, individual REST reads) are swallowed per-device so one unreachable
 * FortiGate never aborts the whole pass — the affected serials simply don't
 * appear in the returned map, and the caller leaves their managementAccess as-is.
 */
export async function collectManagementAccess(
  integration: { id: string; type: string; config: unknown },
  groups: DeviceAccessGroup[],
  opts: { mgmtInterface?: string | null; switchManagementInterface?: string | null; concurrency?: number; checkedAt?: string } = {},
): Promise<Map<string, ManagementAccessSummary>> {
  const result = new Map<string, ManagementAccessSummary>();
  const checkedAt = opts.checkedAt ?? new Date().toISOString();
  const mgmtIfaceName = (opts.mgmtInterface ?? "").trim() || "mgmt";
  const switchIfaceName = (opts.switchManagementInterface ?? "").trim() || DEFAULT_SWITCH_MGMT_INTERFACE;

  await mapWithConcurrency(groups, opts.concurrency ?? 4, async (group) => {
    if (!group.deviceName) return;
    const needsWireless = group.aps.length > 0;
    const needsSwitch = group.switches.length > 0;
    let transport;
    try {
      transport = await buildTransportForIntegration(integration, group.deviceName);
    } catch (err) {
      logger.debug({ err, device: group.deviceName }, "managementAccess: transport build failed; skipping device");
      return;
    }

    const get = (path: string) =>
      callFortiOs<unknown>(transport!, "GET", path).catch((err) => {
        logger.debug({ err, device: group.deviceName, path }, "managementAccess: CMDB read failed");
        return null;
      });

    const [cmdbInterfaces, wtpProfilesRes, wtpRes, managedSwitchRes, localAccessRes] = await Promise.all([
      group.firewall ? get("/api/v2/cmdb/system/interface") : Promise.resolve(null),
      needsWireless ? get("/api/v2/cmdb/wireless-controller/wtp-profile") : Promise.resolve(null),
      needsWireless ? get("/api/v2/cmdb/wireless-controller/wtp") : Promise.resolve(null),
      needsSwitch ? get("/api/v2/cmdb/switch-controller/managed-switch") : Promise.resolve(null),
      // One read per controller serves every switch it manages — the ACL is a
      // policy on the gate, not a per-device profile. Skipped entirely when the
      // gate manages no switches.
      needsSwitch ? get(LOCAL_ACCESS_CMDB_PATH) : Promise.resolve(null),
    ]);

    // Firewall
    if (group.firewall && cmdbInterfaces) {
      const summary = buildFirewallSummary(cmdbInterfaces, mgmtIfaceName, group.firewall.mgmtIp, checkedAt);
      if (summary) result.set(group.firewall.serial, summary);
    }

    // Access points
    if (needsWireless) {
      const profiles = parseWtpProfiles(wtpProfilesRes);
      const wtpToProfile = parseWtpToProfile(wtpRes);
      for (const ap of group.aps) {
        const summary = buildApSummary(ap.serial, ap.ipAddress, wtpToProfile, profiles, checkedAt);
        if (summary) result.set(ap.serial, summary);
      }
    }

    // Switches: the controller's local-access policy, with a per-switch
    // interface allowaccess taking precedence where the firmware exposes one.
    // Still best-effort — protocols stays null when neither can be read.
    if (needsSwitch) {
      const switchRows = normalizeCmdbArray(managedSwitchRes);
      const bySerial = new Map<string, any>();
      for (const row of switchRows) {
        const sn = row?.["switch-id"] ?? row?.serial ?? row?.name;
        if (typeof sn === "string") bySerial.set(sn.trim().toUpperCase(), row);
      }
      const policies = parseLocalAccessPolicies(localAccessRes);
      if (policies.size === 0) {
        logger.debug(
          { device: group.deviceName },
          "managementAccess: no switch-controller local-access policy readable; switch access stays unknown",
        );
      }
      for (const sw of group.switches) {
        const row = bySerial.get((sw.serial ?? "").trim().toUpperCase()) ?? null;
        result.set(sw.serial, buildSwitchSummary(row, switchIfaceName, sw.ipAddress, checkedAt, policies));
      }
    }
  });

  return result;
}
