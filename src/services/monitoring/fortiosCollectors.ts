/**
 * src/services/monitoring/fortiosCollectors.ts — the FortiOS REST collectors (CQ-B061, moved verbatim from monitoringService.ts):
 * the transport config, telemetry, hardware sensors, IPsec, and the interface
 * parse / merge cores behind collectSystemInfoFortinet.
 */

import { toFiniteOrNull } from "../../utils/num.js";
import { AppError } from "../../utils/errors.js";
import { matchesWildcard } from "../../utils/integrationFilter.js";
import { bareInterfaceIp, interfaceIpIsUnaddressed } from "../../utils/cidr.js";
import { parseInterfaceIpv6 } from "../../utils/fortiosIpv6.js";
import { fortiosSecondaryIpStrings } from "../../utils/fortiosSecondaryIp.js";
import { FORTIOS_INTERFACE_CMDB_FORMAT } from "../../utils/fortiosInterfaceRef.js";
import { fgRequest, type FortiGateConfig } from "../fortigateService.js";
import { classifyHardwareSensor, normalizeRestAlarmStatus } from "../../utils/hardwareSensors.js";
import { arpNeighborsFromFortiosRest, type ArpNeighborEntry } from "../../utils/arpNeighbors.js";
import { parseFortiosIpsec, parseFortiosSslVpn, type IpsecTunnelSample, type IpsecConnectionSample } from "../../utils/fortiosIpsec.js";
import { pickRestApiCredential, restApiCredentialAuth, type CredentialLike } from "../../utils/fortinetRestCredential.js";
import { TelemetrySample, InterfaceSample, HardwareSensorSample, PerfSlaSample, SdwanRuleSample, LldpNeighborSample, SystemInfoSample } from "./types.js";
import { startPhase, clampPct } from "./common.js";

// ─── FortiOS collectors ─────────────────────────────────────────────────────
//
// FortiOS exposes CPU and memory only as percentages via the resource/usage
// monitor, so memUsedBytes/memTotalBytes are left null. The interface monitor
// returns the cumulative tx/rx counters and link state. There's no real
// notion of mountable storage on a FortiGate, so the storage list stays empty.

/**
 * Assemble the auth for a direct FortiOS REST call against `host`.
 *
 * Two token sources, in this order:
 *
 *   1. `credential` — a `restapi`-typed Credential the operator selected on
 *      THIS asset's stream. Per-gate by nature, and the only way to poll a
 *      fleet where every gate carries its own api-user.
 *   2. the integration's own stored token — fleet-wide by construction (the
 *      FMG Monitoring tab says so in as many words), which is why (1) exists.
 *
 * The credential supplies auth + port + TLS verification only; `host` is
 * always the caller's, i.e. the asset's own address. See
 * utils/fortinetRestCredential.ts for why its baseUrl host is deliberately
 * not honoured here.
 */
export function buildFortinetConfig(
  host: string,
  integration: { type: string; config: Record<string, unknown> },
  credential?: CredentialLike | null,
): FortiGateConfig | { error: string } {
  const cfg = integration.config || {};
  const cred = pickRestApiCredential(credential);
  if (cred) {
    const auth = restApiCredentialAuth(cred.config);
    if ("error" in auth) return auth;
    return { host, ...auth };
  }
  let apiUser  = "";
  let apiToken = "";
  if (integration.type === "fortimanager") {
    apiUser  = String(cfg.fortigateApiUser  || "");
    apiToken = String(cfg.fortigateApiToken || "");
    if (!apiToken) return { error: "No FortiGate API token: this FortiManager integration has none configured (Monitoring tab), and this asset's stream has no REST API credential selected" };
  } else {
    apiUser  = String(cfg.apiUser  || "");
    apiToken = String(cfg.apiToken || "");
    if (!apiToken) return { error: "No FortiGate API token: this integration has none configured, and this asset's stream has no REST API credential selected" };
  }
  return {
    host,
    apiUser,
    apiToken,
    verifySsl: cfg.verifySsl !== true ? false : true,
  };
}

export async function collectTelemetryFortinet(host: string, integration: { type: string; config: Record<string, unknown> }, timeoutMs?: number, credential?: CredentialLike | null): Promise<TelemetrySample> {
  const fg = buildFortinetConfig(host, integration, credential);
  if ("error" in fg) throw new AppError(409, fg.error);

  // /api/v2/monitor/system/resource/usage returns a `results` object keyed by
  // resource name (cpu, mem, disk, session, ...). Each entry can be either an
  // array of {interval, current, historical} samples or a single object,
  // depending on FortiOS version. Pull whatever's freshest.
  //
  // Hardware sensors are NOT pulled here — collectHardwareSensors dispatches on
  // its own polling method (which may resolve to SNMP even when CPU/memory is
  // on REST, e.g. when /api/v2/monitor/system/sensor-info is unreliable on the
  // branch-class FortiGate and the operator routes hardware sensors to SNMP).
  const res = await fgRequest<any>(fg, "GET", "/api/v2/monitor/system/resource/usage", { query: { scope: "global" }, timeoutMs });
  const cpuPct = pickFortinetUsage(res?.cpu);
  const memPct = pickFortinetUsage(res?.mem ?? res?.memory);
  // Session count rides the same response. It's an absolute count, not a
  // percentage — pull it without the 0-100 clamp.
  const sessionCount = pickFortinetUsage(res?.session, false);
  return { cpuPct, memPct, memUsedBytes: null, memTotalBytes: null, sessionCount };
}

// FortiOS exposes temperature, fan, voltage, and power sensors at one endpoint.
// We keep EVERY sensor (not just temperature), classifying by the device's own
// `type` field when present (name heuristic otherwise) and capturing the alarm
// flag. Older FortiOS firmwares 404 this endpoint — caller swallows the failure.
export async function collectHardwareSensorsFortinet(fg: FortiGateConfig, timeoutMs?: number): Promise<HardwareSensorSample[]> {
  const res = await fgRequest<any>(fg, "GET", "/api/v2/monitor/system/sensor-info", { timeoutMs });
  const list: HardwareSensorSample[] = [];
  const arr = Array.isArray(res) ? res : (Array.isArray(res?.results) ? res.results : []);
  for (const s of arr) {
    if (!s || typeof s !== "object") continue;
    const obj  = s as Record<string, unknown>;
    const name = String(obj.name || "").trim();
    if (!name) continue;
    const restType = obj.type != null ? String(obj.type) : null;
    const { sensorClass, unit } = classifyHardwareSensor(name, restType);
    const value = obj.value;
    const n = typeof value === "number" ? value : (typeof value === "string" ? Number(value) : NaN);
    list.push({
      sensorName:  name,
      sensorClass,
      value:       Number.isFinite(n) ? Math.round((n as number) * 1000) / 1000 : null,
      unit,
      alarmStatus: normalizeRestAlarmStatus(obj.alarm ?? obj.alarm_status ?? obj.status),
    });
  }
  return list;
}

// Extract the freshest gauge value from a FortiOS resource/usage node.
// `clamp` (default true) folds the value into 0-100 for percentages (cpu/mem);
// pass false for absolute counts (e.g. session count).
function pickFortinetUsage(node: unknown, clamp = true): number | null {
  const conv = (n: number): number | null =>
    clamp ? clampPct(n) : (Number.isFinite(n) ? n : null);
  if (node == null) return null;
  // Flat number?
  if (typeof node === "number" && Number.isFinite(node)) return conv(node);
  // Object with `current`?
  if (typeof node === "object" && !Array.isArray(node)) {
    const obj = node as Record<string, unknown>;
    if (typeof obj.current === "number") return conv(obj.current);
    // historical may be the freshest; take the last entry
    if (Array.isArray(obj.historical) && obj.historical.length > 0) {
      const last = obj.historical[obj.historical.length - 1];
      if (typeof last === "number") return conv(last);
    }
  }
  // Array of {interval, current, historical} — pick the entry with shortest
  // interval (typically "1-min"), falling back to the first.
  if (Array.isArray(node) && node.length > 0) {
    const sorted = [...node].sort((a, b) => intervalRank(a?.interval) - intervalRank(b?.interval));
    for (const entry of sorted) {
      if (entry == null) continue;
      if (typeof entry.current === "number") return conv(entry.current);
      if (Array.isArray(entry.historical) && entry.historical.length > 0) {
        const last = entry.historical[entry.historical.length - 1];
        if (typeof last === "number") return conv(last);
      }
    }
  }
  return null;
}

function intervalRank(s: unknown): number {
  // 1-min < 10-min < 30-min < 1-hour < 1-day < anything else
  switch (s) {
    case "1-min":  return 0;
    case "10-min": return 1;
    case "30-min": return 2;
    case "1-hour": return 3;
    case "1-day":  return 4;
    default:       return 5;
  }
}

// ─── FortiOS interface parse/merge cores (split 2026-08) ────────────────────
// Pure functions over the two REST payloads (CMDB system/interface + monitor
// system/interface) so the payload quirks — hyphenated member keys, the
// ipv4_addresses vs legacy `ip` fallback, Mbps→bps, aggregate-member
// synthesis — are unit-testable with fixtures
// (tests/unit/fortiInterfaceParse.test.ts). collectSystemInfoFortinet keeps
// the transport fan-out + error semantics.

export interface FortiCmdbInterfaceEntry {
  type: string | null;
  parent: string | null;
  vlanId: number | null;
  members: string[];
  alias: string | null;
  description: string | null;
  addressingMode: string | null;
  /** The CMDB's `status` — "up" | "down" — which is the ADMIN status, i.e.
   *  whether the interface is configured up at all.
   *
   *  It has to come from here because the MONITOR endpoint does not carry it:
   *  `/api/v2/monitor/system/interface` reports `link` (the oper status) and
   *  nothing else status-shaped. Confirmed on FortiOS 7.6.7 against the lab
   *  gates — the monitor payload's `status` is `undefined` on every entry,
   *  while the CMDB's is "up"/"down" on all of them. */
  adminStatus: string | null;
  /** The CMDB's configured IPv4 address, bare (mask stripped), or null when
   *  unset / 0.0.0.0. Only read for interfaces the monitor endpoint omits —
   *  see `backfillFortiCmdbOnlyTunnels`; the monitor's runtime IP wins
   *  everywhere else. */
  ipAddress: string | null;
  /** The interface's configured secondary IPv4 addresses (CMDB `secondary-ip`
   *  child table), bare, in CMDB order; empty when there are none. The
   *  monitor endpoint does not say which of an interface's addresses is the
   *  secondary, so this is the only source of that distinction. */
  secondaryIps: string[];
  /** The CMDB's configured IPv6 (`ipv6.ip6-address`, else the first
   *  `ip6-extra-addr`), via utils/fortiosIpv6.ts → parseInterfaceIpv6;
   *  null when unset / link-local. The monitor endpoint carries no IPv6 at
   *  all (FortiOS 7.6.7 / 8.0.1), so this is the interface's only IPv6
   *  source on both transports (business rule 126). A dhcp / pppoe /
   *  delegated interface's IPv6 is runtime state the CMDB does not hold. */
  ipv6Address: string | null;
  /** A `type tunnel` interface's underlay (CMDB `interface`, e.g. "wan1");
   *  null for every other type and for FortiOS's built-in per-VDOM
   *  pseudo-tunnels (`ssl.root`, `l2t.root`, `naf.root`), which carry none. */
  tunnelUnderlay: string | null;
}

/**
 * Build the name → CMDB-metadata map from a `/api/v2/cmdb/system/interface`
 * response. Tolerates both the bare-array and `{results: []}` envelope
 * shapes; a null/failed response yields an empty map (callers fall back to
 * monitor-only types — same as the original try/catch).
 */
export function parseFortiCmdbInterfaceTable(cmdbRes: unknown): Map<string, FortiCmdbInterfaceEntry> {
  const cmdbByName = new Map<string, FortiCmdbInterfaceEntry>();
  if (!cmdbRes) return cmdbByName;
  const arr = Array.isArray(cmdbRes)
    ? cmdbRes
    : (Array.isArray((cmdbRes as any)?.results) ? (cmdbRes as any).results : []);
  for (const c of arr) {
    if (!c || typeof c !== "object" || typeof c.name !== "string") continue;
    const t = typeof c.type === "string" ? c.type : null;
    // CMDB `member` is an array of { "interface-name": "<port>" } entries on
    // aggregate and hard-switch / vap-switch interfaces. The FortiOS REST
    // envelope returns the key with a hyphen — the JS-friendly underscore
    // form (`interface_name`) doesn't exist, and accessing it would silently
    // yield undefined, collapsing the members list to empty. `q_origin_key`
    // duplicates the value for the table's primary key, so it's a reliable
    // fallback when a firmware variant drops `interface-name`.
    const members: string[] = Array.isArray(c.member)
      ? c.member.map((m: any) => {
          if (typeof m === "string") return m;
          if (m && typeof m === "object") {
            if (typeof m["interface-name"] === "string") return m["interface-name"];
            if (typeof m.q_origin_key  === "string") return m.q_origin_key;
            if (typeof m.interface_name === "string") return m.interface_name;
          }
          return null;
        }).filter(Boolean)
      : [];
    const alias       = typeof c.alias       === "string" && c.alias.trim()       ? c.alias.trim()       : null;
    const description = typeof c.description === "string" && c.description.trim() ? c.description.trim() : null;
    // L3 addressing mode — CMDB `mode` is "static" | "dhcp" | "pppoe". Keep
    // only known values so a firmware-specific surprise doesn't leak into the
    // UI; anything else (or absent) leaves addressingMode null.
    const rawMode = typeof c.mode === "string" ? c.mode.trim().toLowerCase() : "";
    const addressingMode = (rawMode === "static" || rawMode === "dhcp" || rawMode === "pppoe") ? rawMode : null;
    // Only the two values FortiOS actually uses; anything else is treated as
    // unknown rather than passed through, for the same reason `mode` is.
    const rawStatus = typeof c.status === "string" ? c.status.trim().toLowerCase() : "";
    const adminStatus = rawStatus === "up" || rawStatus === "down" ? rawStatus : null;
    // FortiOS REST gives `ip` as "x.x.x.x y.y.y.y"; tolerate the [ip, mask]
    // array shape the FMG device DB uses.
    const rawIp = Array.isArray(c.ip) ? c.ip[0] : c.ip;
    const ipAddress = typeof rawIp === "string" && !interfaceIpIsUnaddressed(rawIp)
      ? bareInterfaceIp(rawIp)
      : null;
    // Secondary rows carry their own `ip` in the same two shapes. FortiOS REST
    // spells the table `secondary-IP` — see utils/fortiosSecondaryIp.ts.
    const secondaryIps: string[] = [];
    for (const rawSec of fortiosSecondaryIpStrings(c)) {
      if (interfaceIpIsUnaddressed(rawSec)) continue;
      const bare = bareInterfaceIp(rawSec);
      if (bare !== ipAddress && !secondaryIps.includes(bare)) secondaryIps.push(bare);
    }
    cmdbByName.set(c.name, {
      type:    t,
      parent:  t === "vlan" && typeof c.interface === "string" ? c.interface : null,
      vlanId:  t === "vlan" && typeof c.vlanid === "number" ? c.vlanid : null,
      members,
      alias,
      description,
      addressingMode,
      adminStatus,
      ipAddress,
      secondaryIps,
      ipv6Address: parseInterfaceIpv6(c).addresses[0]?.ipAddress ?? null,
      tunnelUnderlay: t === "tunnel" && typeof c.interface === "string" && c.interface.trim() ? c.interface.trim() : null,
    });
  }
  return cmdbByName;
}

/**
 * A software switch's member ports live in `/api/v2/cmdb/system/switch-interface`,
 * not on its `system/interface` row (which carries `type: "switch"` and no
 * `member`, unlike a hardware switch). Copy them onto the CMDB map's entry so
 * `backfillFortiAggregateMembers` nests them under the switch like any other
 * bundle. Only entries the interface table already knows are touched, and an
 * entry that already has members keeps them. Tolerates both REST envelopes; a
 * failed read (null) changes nothing. Mutates `cmdbByName` in place.
 */
export function applyFortiSoftwareSwitchMembers(
  cmdbByName: Map<string, FortiCmdbInterfaceEntry>,
  switchIfaceRes: unknown,
): void {
  if (!switchIfaceRes) return;
  const rows = Array.isArray(switchIfaceRes)
    ? switchIfaceRes
    : (Array.isArray((switchIfaceRes as any)?.results) ? (switchIfaceRes as any).results : []);
  for (const r of rows) {
    if (!r || typeof r !== "object" || typeof r.name !== "string") continue;
    const entry = cmdbByName.get(r.name);
    if (!entry || entry.members.length > 0) continue;
    const members: string[] = Array.isArray(r.member)
      ? r.member.map((m: any) => {
          if (typeof m === "string") return m;
          if (m && typeof m === "object") {
            if (typeof m["interface-name"] === "string") return m["interface-name"];
            if (typeof m.q_origin_key === "string") return m.q_origin_key;
          }
          return null;
        }).filter(Boolean)
      : [];
    if (members.length > 0) entry.members = members;
  }
}

/**
 * Merge the `/api/v2/monitor/system/interface` payload with the CMDB map
 * into InterfaceSample rows. CMDB type/parent/vlanid/alias/description win;
 * the monitor payload supplies runtime state (link, counters, IP, MAC,
 * speed — reported in Mbps, converted to bps here).
 */
export function buildFortiInterfaceSamples(
  monitorObj: Record<string, any>,
  cmdbByName: Map<string, FortiCmdbInterfaceEntry>,
): InterfaceSample[] {
  const interfaces: InterfaceSample[] = [];
  for (const [name, info] of Object.entries(monitorObj)) {
    if (!info || typeof info !== "object") continue;
    const i = info as any;
    // Pick the first IPv4 if the device exposes a list, else fall back to the legacy `ip` string.
    let ip: string | null = null;
    if (Array.isArray(i.ipv4_addresses) && i.ipv4_addresses.length > 0) {
      const a = i.ipv4_addresses[0];
      ip = typeof a === "string" ? a : (a?.ip || null);
    } else if (typeof i.ip === "string") {
      ip = i.ip.split(" ")[0];
    }
    const speedMbps = typeof i.speed === "number" ? i.speed : null;
    // Prefer CMDB type/parent/vlanid; fall back to whatever the monitor
    // payload happened to include.
    const cmdbEntry = cmdbByName.get(name);
    const rawType   = cmdbEntry?.type ?? (typeof i.type === "string" ? i.type : null);
    const rawParent = cmdbEntry?.parent ?? (i.type === "vlan" && typeof i.interface === "string" ? i.interface : null);
    const rawVlanId = cmdbEntry?.vlanId ?? (i.type === "vlan" && typeof i.vlanid === "number" ? i.vlanid : null);
    interfaces.push({
      ifName:      name,
      // CMDB FIRST, exactly like type/parent/vlanId above. The monitor payload
      // has no `status` field at all on FortiOS 7.6.7 — it carries `link` and
      // nothing else status-shaped — so reading it from `i` alone left
      // adminStatus null on every interface of every standalone FortiGate.
      //
      // That was not a cosmetic gap: business rule 57 skips an `ifOperStatus`
      // reading whose adminStatus is not "up" (an admin-downed port is
      // deliberately down, not an outage), so a null silently disabled EVERY
      // interface-down automation on a standalone-discovered gate. The
      // automation saved, looked correct on the Devices step, and never fired.
      // Found against the lab gates 2026-09-21; the monitor fallback stays for
      // any firmware that does populate it.
      adminStatus: cmdbEntry?.adminStatus
        ?? (i.status === "down" ? "down" : i.status === "up" ? "up" : (i.status ?? null)),
      operStatus:  i.link === false ? "down" : i.link === true ? "up" : null,
      speedBps:    speedMbps != null ? Math.round(speedMbps * 1_000_000) : null,
      duplex:      fortiMonitorDuplex(i.link, i.duplex),
      ipAddress:   ip,
      // Only the CMDB knows which addresses are secondary; without it the
      // field stays undefined ("not known") rather than claiming "none".
      secondaryIps: cmdbEntry ? cmdbEntry.secondaryIps.filter((s) => s !== ip) : undefined,
      ipv6Address: cmdbEntry?.ipv6Address ?? null,
      macAddress:  typeof i.mac === "string" ? i.mac.toUpperCase() : null,
      inOctets:    toFiniteOrNull(i.rx_bytes),
      outOctets:   toFiniteOrNull(i.tx_bytes),
      inErrors:    toFiniteOrNull(i.rx_errors  ?? i.errors_in),
      outErrors:   toFiniteOrNull(i.tx_errors  ?? i.errors_out),
      ifType:      normalizeFortiIfType(rawType),
      ifSubtype:   fortiIfSubtype(rawType),
      ifParent:    rawParent,
      vlanId:      rawVlanId,
      alias:       cmdbEntry?.alias       ?? null,
      description: cmdbEntry?.description ?? null,
      addressingMode: cmdbEntry?.addressingMode ?? null,
    });
  }
  return interfaces;
}

/**
 * FortiOS monitor `duplex` → "full" | "half" | null. The field is numeric:
 * 1 on a full-duplex link that is up, 0 on a link that is down (confirmed on
 * FortiOS 7.6.7 and 8.0.1 against the lab gates). 0 on a link that IS up can
 * only be half duplex. A down link has no duplex at all, so `link` gates it.
 */
export function fortiMonitorDuplex(link: unknown, duplex: unknown): string | null {
  if (link !== true || typeof duplex !== "number") return null;
  if (duplex === 1) return "full";
  if (duplex === 0) return "half";
  return null;
}

/**
 * Back-fill ifParent on member ports of aggregate / hard-switch / vap-switch
 * interfaces. CMDB carries the canonical `member` array; we also accept the
 * monitor-side `member` array as a fallback.
 *
 * Member ports owned by an aggregate (the `set members "port15" "port16"`
 * ports under FortiLink) are typically *omitted* from the monitor endpoint —
 * FortiOS treats them as subordinate to the aggregate and doesn't surface
 * them as standalone interfaces. CMDB still lists them. For those, synthesize
 * a row from CMDB metadata so the System tab tree can render them nested
 * under their aggregate; runtime fields stay null because the monitor
 * endpoint never returned counters for them. Mutates `interfaces` in place.
 */
export function backfillFortiAggregateMembers(
  interfaces: InterfaceSample[],
  monitorObj: Record<string, any>,
  cmdbByName: Map<string, FortiCmdbInterfaceEntry>,
): void {
  const ifMap = new Map(interfaces.map((s) => [s.ifName, s]));
  for (const iface of interfaces.slice()) {
    if (iface.ifType !== "aggregate") continue;
    const cmdbEntry = cmdbByName.get(iface.ifName);
    const monitorEntry = monitorObj[iface.ifName] as any;
    const members =
      cmdbEntry?.members.length ? cmdbEntry.members :
      Array.isArray(monitorEntry?.member) ? monitorEntry.member.map(String) : [];
    for (const memberName of members) {
      const memberStr = String(memberName);
      const existing = ifMap.get(memberStr);
      if (existing) {
        if (!existing.ifParent) existing.ifParent = iface.ifName;
        continue;
      }
      const memberCmdb = cmdbByName.get(memberStr);
      const synthetic: InterfaceSample = {
        ifName:      memberStr,
        adminStatus: null,
        operStatus:  null,
        speedBps:    null,
        ipAddress:   null,
        macAddress:  null,
        inOctets:    null,
        outOctets:   null,
        inErrors:    null,
        outErrors:   null,
        ifType:      memberCmdb?.type ? normalizeFortiIfType(memberCmdb.type) : "physical",
        ifParent:    iface.ifName,
        vlanId:      memberCmdb?.vlanId ?? null,
        alias:       memberCmdb?.alias ?? null,
        description: memberCmdb?.description ?? null,
      };
      interfaces.push(synthetic);
      ifMap.set(memberStr, synthetic);
    }
  }
}

/**
 * Synthesize a row for a CMDB bundle the monitor endpoint omitted. FortiOS's
 * `/api/v2/monitor/system/interface` leaves a SOFTWARE switch out entirely
 * while listing its member ports and the VLANs on it (FortiOS 7.6.8, HUB1-a,
 * 2026-10-28: `Software Switch` absent, `a` / `b` / `LabSSProd` present), so
 * without this the switch never reached the inventory and its members never
 * nested. Built from the CMDB alone — admin status, configured address, alias,
 * description — with no runtime state, exactly like the tunnel back-fill
 * below. Run BEFORE `backfillFortiAggregateMembers`, which then nests the
 * members under it. A bundle the monitor did report is left alone. Mutates
 * `interfaces` in place.
 */
export function backfillFortiCmdbOnlyBundles(
  interfaces: InterfaceSample[],
  cmdbByName: Map<string, FortiCmdbInterfaceEntry>,
): void {
  const present = new Set(interfaces.map((s) => s.ifName));
  for (const [name, c] of cmdbByName) {
    const subtype = fortiIfSubtype(c.type);
    if (!subtype || present.has(name)) continue;
    interfaces.push({
      ifName:      name,
      adminStatus: c.adminStatus,
      operStatus:  null,
      speedBps:    null,
      ipAddress:   c.ipAddress,
      secondaryIps: c.secondaryIps,
      ipv6Address: c.ipv6Address,
      macAddress:  null,
      inOctets:    null,
      outOctets:   null,
      inErrors:    null,
      outErrors:   null,
      ifType:      "aggregate",
      ifSubtype:   subtype,
      ifParent:    null,
      vlanId:      null,
      alias:       c.alias,
      description: c.description,
      addressingMode: c.addressingMode,
    });
    present.add(name);
  }
}

/**
 * Synthesize rows for CMDB `type tunnel` interfaces the monitor endpoint
 * omitted — IPsec phase1-interfaces (site-to-site, dial-up and ADVPN hub /
 * spoke overlays), plus GRE / VXLAN, which FortiOS also types `tunnel`.
 *
 * `/api/v2/monitor/system/interface` leaves these out, so on a REST-polled
 * gate they never reached `asset_interfaces`: the System tab didn't list
 * them and the overlay addresses configured on them (`set ip 10.255.0.1
 * 255.255.255.255`) were never tied to the firewall. The CMDB read that
 * already runs alongside the monitor one carries both the name and the `ip`.
 *
 * Runtime fields stay null — the CMDB has no link state or counters, and the
 * tunnel's real state is its SA, which the IPsec stream owns (an SNMP
 * ifOperStatus "up" is meaningless for the same reason). The per-instance
 * shortcut interfaces ADVPN spawns at runtime (`<name>_0`, `<name>_1`…) are
 * not CMDB rows and are not synthesized; they carry the parent's address.
 * A tunnel the monitor DID report is left alone. Mutates `interfaces` in place.
 *
 * A tunnel with neither an address nor an underlay is skipped: that is the
 * shape of FortiOS's built-in per-VDOM pseudo-tunnels (`ssl.root`,
 * `l2t.root`, `naf.root`), present on every gate and never what an operator
 * means by a tunnel. An unnumbered route-based IPsec interface still has its
 * underlay, so it is kept. Confirmed against the FortiOS 7.6.7 lab gates.
 */
export function backfillFortiCmdbOnlyTunnels(
  interfaces: InterfaceSample[],
  cmdbByName: Map<string, FortiCmdbInterfaceEntry>,
): void {
  const present = new Set(interfaces.map((s) => s.ifName));
  for (const [name, c] of cmdbByName) {
    if (c.type !== "tunnel" || present.has(name)) continue;
    if (!c.ipAddress && !c.ipv6Address && !c.tunnelUnderlay) continue;
    interfaces.push({
      ifName:      name,
      adminStatus: c.adminStatus,
      operStatus:  null,
      speedBps:    null,
      ipAddress:   c.ipAddress,
      secondaryIps: c.secondaryIps,
      ipv6Address: c.ipv6Address,
      macAddress:  null,
      inOctets:    null,
      outOctets:   null,
      inErrors:    null,
      outErrors:   null,
      ifType:      "tunnel",
      ifParent:    null,
      vlanId:      null,
      alias:       c.alias,
      description: c.description,
      addressingMode: c.addressingMode,
    });
    present.add(name);
  }
}

export async function collectSystemInfoFortinet(
  host: string,
  integration: { type: string; config: Record<string, unknown> },
  opts: { includeIpsec?: boolean; includeLldp?: boolean; includeArp?: boolean; includeSslVpn?: boolean; timeoutMs?: number } = {},
  credential?: CredentialLike | null,
): Promise<SystemInfoSample> {
  const fg = buildFortinetConfig(host, integration, credential);
  if ("error" in fg) throw new AppError(409, fg.error);
  const timeoutMs = opts.timeoutMs;

  // Fan out every independent FortiOS REST call in parallel. The merge logic
  // (cmdb + monitor → interfaces[]) only depends on both responses being
  // available, not on serial ordering of the requests. Sequencing them used
  // to make a healthy host's collection 5× longer than necessary; on a
  // wedged host it stacked their 15s timeouts (~75s total) instead of
  // running them concurrently (~15s).
  //
  // Per-stream error handling is preserved: cmdb fetch returns null on any
  // failure (token without cmdb scope is the common case), ipsec and lldp
  // each have their own .catch fallback, and the monitor-interface error
  // is captured and only re-thrown if it would have ended up with an empty
  // interfaces[] (matching the prior behavior where monitor failure with
  // no interfaces threw, but partial success returned).
  const endCmdb = startPhase("systeminfo.rest.cmdb_interface");
  const cmdbInterfacePromise = fgRequest<any>(fg, "GET", "/api/v2/cmdb/system/interface", { query: { vdom: "root", format: FORTIOS_INTERFACE_CMDB_FORMAT }, timeoutMs })
    .catch(() => null as any)
    .then((res) => { endCmdb({ ok: res != null }); return res; });
  // Software switch members (applyFortiSoftwareSwitchMembers). Best-effort: a
  // gate with none returns an empty list, a token without the scope fails and
  // the switch simply shows without nested members.
  const endSwitchIf = startPhase("systeminfo.rest.cmdb_switch_interface");
  const switchInterfacePromise = fgRequest<any>(fg, "GET", "/api/v2/cmdb/system/switch-interface", { query: { vdom: "root" }, timeoutMs })
    .catch(() => null as any)
    .then((res) => { endSwitchIf({ ok: res != null }); return res; });
  const endMonitorIf = startPhase("systeminfo.rest.monitor_interface");
  const monitorInterfacePromise = fgRequest<any>(fg, "GET", "/api/v2/monitor/system/interface", {
    query: { scope: "vdom", include_vlan: "true", include_aggregate: "true" },
    timeoutMs,
  })
    .then((res) => { endMonitorIf({ ok: true }); return { ok: true as const, res }; })
    .catch((err) => { endMonitorIf({ ok: false }); return { ok: false as const, err }; });
  const ipsecPromise = opts.includeIpsec
    ? (() => {
        const endIpsec = startPhase("systeminfo.rest.ipsec");
        // A failed read keeps the old contract for tunnels ([] — no samples
        // this pass) but leaves the connection halves undefined, so the
        // IPsec tab keeps its last answer instead of blanking.
        return collectIpsecFortinet(fg, timeoutMs, { includeSslVpn: opts.includeSslVpn })
          .catch((): FortiIpsecCollection => ({ tunnels: [], connections: undefined, sslVpnSessions: undefined }))
          .then((r) => { endIpsec({ tunnels: r.tunnels.length, connections: r.connections?.length ?? null }); return r; });
      })()
    : Promise.resolve<FortiIpsecCollection | undefined>(undefined);
  const lldpPromise = opts.includeLldp !== false
    ? (() => {
        const endLldp = startPhase("systeminfo.rest.lldp");
        return collectLldpNeighborsFortinet(fg, timeoutMs)
          .catch(() => undefined)
          .then((neighbors) => { endLldp({ neighbors: neighbors?.length ?? null }); return neighbors; });
      })()
    : Promise.resolve<LldpNeighborSample[] | undefined>(undefined);
  // IP neighbour cache. Same endpoint discovery already reads per gate, called
  // here so a monitored firewall refreshes it on the system-info cadence
  // instead of once per discovery interval. IPv4 only -- FortiOS exposes no
  // NDP equivalent over REST, which the SNMP path does cover.
  const arpPromise = opts.includeArp
    ? (() => {
        const endArp = startPhase("systeminfo.rest.arp");
        return fgRequest<any[]>(fg, "GET", "/api/v2/monitor/network/arp", { timeoutMs })
          .then((rows) => (Array.isArray(rows) ? arpNeighborsFromFortiosRest(rows) : undefined))
          .catch(() => undefined)
          .then((rows) => { endArp({ entries: rows?.length ?? null }); return rows; });
      })()
    : Promise.resolve<ArpNeighborEntry[] | undefined>(undefined);

  const [cmdbRes, switchIfaceRes, monitorOutcome, ipsec, lldpNeighbors, arpNeighbors] = await Promise.all([
    cmdbInterfacePromise,
    switchInterfacePromise,
    monitorInterfacePromise,
    ipsecPromise,
    lldpPromise,
    arpPromise,
  ]);

  const cmdbByName = parseFortiCmdbInterfaceTable(cmdbRes);
  applyFortiSoftwareSwitchMembers(cmdbByName, switchIfaceRes);
  // FortiLink-enabled interface set (fortilink-flagged interfaces + their member
  // ports) from the same CMDB response — fed back to the caller so the LLDP
  // exclusion filter can drop FortiLink links without a second CMDB fetch.
  const fortilinkInterfaces = [...fortilinkInterfaceNamesFromCmdb(cmdbRes)];

  let interfaces: InterfaceSample[] = [];
  if (monitorOutcome.ok) {
    const res = monitorOutcome.res;
    const obj = (res && typeof res === "object" && !Array.isArray(res)) ? res as Record<string, any> : {};
    interfaces = buildFortiInterfaceSamples(obj, cmdbByName);
    backfillFortiCmdbOnlyBundles(interfaces, cmdbByName);
    backfillFortiAggregateMembers(interfaces, obj, cmdbByName);
    backfillFortiCmdbOnlyTunnels(interfaces, cmdbByName);
  } else if (interfaces.length === 0) {
    // Monitor failed AND we have no interfaces from the (also-failing) cmdb
    // synthesis path — re-throw the original error to match the prior
    // semantics. Partial success returns whatever we managed to merge.
    throw monitorOutcome.err;
  }
  applyFortiInterfaceFilter(interfaces, integration);
  // ipsecTunnels: best-effort, already resolved above. Older FortiOS
  // firmwares 404 the endpoint and FortiGates without IPsec configured
  // return an empty list — either way the System tab just hides the
  // section. Skipped entirely on the fast (per-minute) cadence so we
  // don't hammer the endpoint.
  //
  // lldpNeighbors: also best-effort. FortiOS 6.4+ exposes the per-interface
  // neighbor list; older firmwares 404 it. An empty array is "queried
  // successfully, no neighbors" → persist layer wipes stale rows. A
  // genuine failure leaves `lldpNeighbors` undefined → persist layer
  // leaves existing rows alone. `includeLldp: false` lets the caller skip
  // this when the operator routed LLDP to SNMP; the caller overlays the
  // SNMP result onto the returned sample.
  return {
    interfaces, storage: [],
    ipsecTunnels:     ipsec?.tunnels,
    ipsecConnections: ipsec?.connections,
    sslVpnSessions:   ipsec?.sslVpnSessions,
    lldpNeighbors,
    lldpSource: opts.includeLldp !== false ? "fortios" : undefined,
    arpNeighbors,
    fortilinkInterfaces,
  };
}

/**
 * Standalone FortiOS LLDP query for the cross-transport case (interfaces ride
 * SNMP but LLDP rides REST). Same wire format as collectLldpNeighborsFortinet
 * but builds its own FortiGateConfig from the integration so the caller
 * doesn't have to.
 */
export async function collectLldpOnlyFortinet(
  host: string,
  integration: { type: string; config: Record<string, unknown> },
  timeoutMs?: number,
  credential?: CredentialLike | null,
): Promise<LldpNeighborSample[] | undefined> {
  const fg = buildFortinetConfig(host, integration, credential);
  if ("error" in fg) throw new AppError(409, fg.error);
  return await collectLldpNeighborsFortinet(fg, timeoutMs).catch(() => undefined);
}

/**
 * FortiOS exposes LLDP neighbors at /api/v2/monitor/system/interface/lldp-neighbors.
 * The response shape is `{ results: [{ interface, chassis_id, port_id, ... }, …] }`.
 * Field names vary across versions (some firmwares use `local_intf` / `local_intf_name`
 * / `interface`; some use `port_desc` / `port_description`; capabilities show up
 * either as a CSV string or an array). Be defensive about every field.
 */
async function collectLldpNeighborsFortinet(fg: FortiGateConfig, timeoutMs?: number): Promise<LldpNeighborSample[]> {
  const res = await fgRequest<any>(fg, "GET", "/api/v2/monitor/system/interface/lldp-neighbors", { query: { vdom: "root" }, timeoutMs });
  const arr = Array.isArray(res?.results) ? res.results : (Array.isArray(res) ? res : []);
  const out: LldpNeighborSample[] = [];
  for (const n of arr) {
    if (!n || typeof n !== "object") continue;
    const r = n as Record<string, unknown>;
    const localIfName = pickFortiString(r["local_intf"], r["local_intf_name"], r["interface"], r["local_interface"]);
    if (!localIfName) continue;
    // Some FortiOS releases pack management addresses as an array, others as a
    // comma-separated string. Pull the first IPv4 we can find.
    let mgmt: string | null = null;
    const mgmtRaw = r["management_addresses"] ?? r["management_address"] ?? r["mgmt_addr"];
    if (Array.isArray(mgmtRaw)) {
      for (const m of mgmtRaw) {
        if (typeof m === "string" && m) { mgmt = m; break; }
        if (m && typeof m === "object") {
          const a = (m as any).address ?? (m as any).ip ?? (m as any).addr;
          if (typeof a === "string" && a) { mgmt = a; break; }
        }
      }
    } else if (typeof mgmtRaw === "string" && mgmtRaw) {
      mgmt = mgmtRaw.split(",")[0]!.trim() || null;
    }
    out.push({
      localIfName,
      chassisIdSubtype:  pickFortiString(r["chassis_id_subtype"], r["chassis_subtype"]),
      chassisId:         pickFortiString(r["chassis_id"]),
      portIdSubtype:     pickFortiString(r["port_id_subtype"], r["port_subtype"]),
      portId:            pickFortiString(r["port_id"]),
      portDescription:   pickFortiString(r["port_description"], r["port_desc"]),
      systemName:        pickFortiString(r["system_name"], r["sys_name"]),
      systemDescription: pickFortiString(r["system_description"], r["sys_desc"]),
      managementIp:      mgmt,
      capabilities:      pickFortiCapabilities(r["enabled_capabilities"] ?? r["system_capabilities"]),
    });
  }
  return out;
}

function pickFortiString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string") {
      const t = v.trim();
      if (t) return t;
    }
  }
  return null;
}

function pickFortiCapabilities(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim().toLowerCase()).filter((s) => s.length > 0);
  }
  if (typeof raw === "string") {
    return raw.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
  }
  return [];
}

/**
 * FortiLink-enabled interface names from a CMDB `/api/v2/cmdb/system/interface`
 * response: every interface whose `fortilink` setting is enabled, PLUS the
 * member ports of those interfaces (FortiLink is an aggregate; its members are
 * the physical ports — e.g. the `fortilink` aggregate and member `a`). This is
 * the authoritative definition of a "FortiLink interface" (the CMDB flag), not
 * a name heuristic. Used to exclude FortiLink links from LLDP collection when
 * the integration's `excludeFortilinkLldp` toggle is on. Pure + defensive about
 * the FortiOS member-array shape (same `interface-name` / `q_origin_key`
 * fallback chain collectSystemInfoFortinet uses).
 */
export function fortilinkInterfaceNamesFromCmdb(cmdbRes: unknown): Set<string> {
  const out = new Set<string>();
  const arr = Array.isArray(cmdbRes)
    ? cmdbRes
    : (Array.isArray((cmdbRes as any)?.results) ? (cmdbRes as any).results : []);
  for (const c of arr) {
    if (!c || typeof c !== "object" || typeof (c as any).name !== "string") continue;
    const fl = (c as any).fortilink;
    if (!(fl === "enable" || fl === true || fl === 1)) continue;
    out.add((c as any).name);
    const member = (c as any).member;
    if (Array.isArray(member)) {
      for (const m of member) {
        if (typeof m === "string") { if (m) out.add(m); continue; }
        if (m && typeof m === "object") {
          const v = (m as any)["interface-name"] ?? (m as any).q_origin_key ?? (m as any).interface_name;
          if (typeof v === "string" && v) out.add(v);
        }
      }
    }
  }
  return out;
}

/**
 * Fetch the FortiLink-enabled interface set directly from CMDB. Used on the
 * SNMP-interfaces path (which doesn't otherwise fetch CMDB) when the operator
 * has `excludeFortilinkLldp` on — one extra REST call, gated behind the toggle.
 * Returns an empty set on any failure (e.g. a token without CMDB scope), so a
 * failure degrades to "collect all LLDP" rather than dropping neighbors.
 */
export async function fetchFortilinkInterfaceSet(fg: FortiGateConfig, timeoutMs?: number): Promise<Set<string>> {
  const res = await fgRequest<any>(fg, "GET", "/api/v2/cmdb/system/interface", { query: { vdom: "root", format: FORTIOS_INTERFACE_CMDB_FORMAT }, timeoutMs })
    .catch(() => null as any);
  return fortilinkInterfaceNamesFromCmdb(res);
}

/**
 * FortiOS exposes IPsec at /api/v2/monitor/vpn/ipsec: one entry per phase-1
 * the IKE daemon is servicing plus one per dynamic CHILD (a hub's connected
 * ADVPN spokes / dial-up peers / FortiClient users, a spoke's ADVPN
 * shortcuts — each carries `parent`). utils/fortiosIpsec.ts → parseFortiosIpsec
 * splits the two: phase-1 rows roll up into `tunnels` (the sample stream, the
 * System tab, pins — children are never pinnable, they come and go with
 * peers and traffic) and children become `connections` (the current-state
 * table behind the asset's IPsec tab). Older firmwares 404 the endpoint —
 * the caller swallows the failure.
 *
 * The CMDB phase1-interface read supplies each tunnel's parent interface,
 * the dial-up `type`, and the ADVPN / xauth / EAP flags that classify a
 * child. It is best-effort (a token without cmdb scope leaves those null)
 * and runs in parallel with the monitor read. CMDB-only synthesis (configured
 * phase-1 tunnels missing from the monitor answer get a "down" / "dynamic"
 * row) only runs when the monitor call succeeded — a monitor failure rejects
 * this function, which the caller treats as "no ipsec data", not "every
 * tunnel down".
 *
 * `includeSslVpn` adds the SSL-VPN session list (/api/v2/monitor/vpn/ssl) as
 * a third parallel read with its own failure: `sslVpnSessions` is undefined
 * when it was not asked for or did not answer, so a gate whose token lacks
 * that scope keeps whatever SSL rows it had rather than wiping them.
 */
export interface FortiIpsecCollection {
  tunnels:        IpsecTunnelSample[];
  connections:    IpsecConnectionSample[] | undefined;
  sslVpnSessions: IpsecConnectionSample[] | undefined;
}

export async function collectIpsecFortinet(
  fg: FortiGateConfig,
  timeoutMs?: number,
  opts: { includeSslVpn?: boolean } = {},
): Promise<FortiIpsecCollection> {
  const [cmdbResult, res, sslRes] = await Promise.all([
    fgRequest<any>(fg, "GET", "/api/v2/cmdb/vpn.ipsec/phase1-interface", { query: { vdom: "root" }, timeoutMs })
      .catch(() => null as any),
    fgRequest<any>(fg, "GET", "/api/v2/monitor/vpn/ipsec", { query: { scope: "vdom" }, timeoutMs }),
    opts.includeSslVpn
      ? fgRequest<any>(fg, "GET", "/api/v2/monitor/vpn/ssl", { timeoutMs }).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);
  const { tunnels, connections } = parseFortiosIpsec(cmdbResult, res);
  return {
    tunnels,
    connections,
    sslVpnSessions: sslRes === undefined || sslRes === null ? undefined : parseFortiosSslVpn(sslRes),
  };
}

/** Normalize a FortiOS SD-WAN member liveness value to "up"/"down". FortiOS
 *  health-check members report "alive"/"dead" on some versions, "up"/"down"
 *  or a numeric/boolean flag on others. */
function normalizeSdwanState(v: unknown): "up" | "down" {
  if (typeof v === "number")  return v > 0 ? "up" : "down";
  if (typeof v === "boolean") return v ? "up" : "down";
  const s = String(v ?? "").trim().toLowerCase();
  return s === "up" || s === "alive" || s === "1" || s === "true" ? "up" : "down";
}

/**
 * SD-WAN collector (FortiOS only; gated by Integration.config.pullSdwan, its own
 * cadence — runSdwanFor). Pulls two things in parallel:
 *   - Performance SLA health-check readings (/api/v2/monitor/virtual-wan/health-check):
 *     one PerfSlaSample per (health-check, WAN member) with latency/jitter/
 *     packet-loss gauges + link state.
 *   - SD-WAN service rules (/api/v2/cmdb/system/sdwan → `service`): each rule's
 *     mode + configured candidate members in priority order (seq-nums resolved
 *     to interface names via the global `members` table).
 *
 * The runtime selected member is INFERRED best-effort: the first candidate (in
 * priority order) that is up per the health-check data. FortiOS exposes no clean
 * REST endpoint for per-rule member selection, so `selectedMember` is null when
 * it can't be resolved (no health-check data covering the candidates). This is
 * good enough for sla / priority modes; load-balance spreads traffic so the
 * inferred "selected" is only the top healthy member — the UI shows `mode` so
 * the operator has context.
 *
 * Each sub-fetch degrades independently, like collectIpsecFortinet's
 * CMDB-optional handling. A failed health-check read yields no SLA samples. A
 * failed CMDB read yields `sdwanRules: undefined` — "not read", so the caller
 * leaves the stored rules alone — rather than [], which would full-replace
 * them with nothing: on a per-minute cadence one timed-out request would
 * otherwise blank the gate's SD-WAN tab. Older firmwares 404 the endpoints →
 * the same "not read" → the SD-WAN tab just hides the section. `reachable` is
 * false only when BOTH requests failed.
 *
 * NOTE (verify on a real FortiOS 7.x device): the health-check JSON shape, the
 * member-state field name (status vs state; "up"/"alive"/numeric), and the CMDB
 * service member-reference shape (members[].seq-num vs priority-members) vary by
 * version — the parsing here is defensive but should be confirmed.
 */
export async function collectSdwanFortinet(
  fg: FortiGateConfig,
  timeoutMs?: number,
): Promise<{ perfSla: PerfSlaSample[]; sdwanRules: SdwanRuleSample[] | undefined; reachable: boolean }> {
  const [hcRes, sdwanRes] = await Promise.all([
    fgRequest<any>(fg, "GET", "/api/v2/monitor/virtual-wan/health-check", { query: { scope: "vdom" }, timeoutMs })
      .catch(() => null as any),
    fgRequest<any>(fg, "GET", "/api/v2/cmdb/system/sdwan", { query: { vdom: "root" }, timeoutMs })
      .catch(() => null as any),
  ]);
  const thresholds = parseSdwanSlaThresholds(sdwanRes);
  const zones = parseSdwanMemberZones(sdwanRes);
  const { perfSla, memberUp } = parsePerfSlaHealthCheck(hcRes, thresholds, zones);
  const sdwanRules = sdwanRes == null ? undefined : parseSdwanRules(sdwanRes, memberUp, zones);
  return { perfSla, sdwanRules, reachable: hcRes != null || sdwanRes != null };
}

/**
 * Build a member-interface → SD-WAN zone map from the CMDB system/sdwan
 * `members[]` (each carries `interface` + `zone`, e.g. "virtual-wan-link" /
 * "overlay"). Used to label Performance-SLA members by zone. Exported for unit
 * testing; pure.
 */
export function parseSdwanMemberZones(sdwanRes: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const root = (sdwanRes && typeof sdwanRes === "object" && (sdwanRes as any).results && typeof (sdwanRes as any).results === "object")
    ? (sdwanRes as any).results
    : sdwanRes;
  if (!root || typeof root !== "object") return out;
  const members = Array.isArray((root as any).members) ? (root as any).members : [];
  for (const m of members) {
    if (!m || typeof m !== "object") continue;
    const iface = typeof (m as any).interface === "string" ? (m as any).interface.trim() : "";
    const zone  = typeof (m as any).zone === "string" ? (m as any).zone.trim() : "";
    if (iface && zone && !out.has(iface)) out.set(iface, zone);
  }
  return out;
}

export interface SlaThreshold { latencyMs: number | null; jitterMs: number | null; packetLoss: number | null; }

/**
 * Build a healthCheck-name → SLA threshold map from the CMDB system/sdwan
 * `health-check[].sla` targets. FortiOS allows multiple SLA rows per
 * health-check; we take the max configured threshold per metric (a member
 * passes the strictest target). A 0 / absent threshold means "unset" for that
 * metric → null (no chart line).
 *
 * Each SLA row carries thresholds for ALL three metrics regardless of which are
 * actually enforced — FortiOS keeps a default `jitter-threshold` of 5ms even
 * when jitter isn't part of the SLA. The `link-cost-factor` field on the SLA
 * row names the metrics the SLA actually measures (`latency` / `jitter` /
 * `packet-loss`); a threshold for a metric NOT listed there is a disabled SLA
 * and must not surface as a chart line. We only take a metric's threshold when
 * its link-cost-factor token is present. Older FortiOS that omits the field
 * (null/empty) falls back to "all metrics enabled" so existing installs are
 * unaffected. Exported for unit testing; pure.
 */
export function parseSdwanSlaThresholds(sdwanRes: unknown): Map<string, SlaThreshold> {
  const out = new Map<string, SlaThreshold>();
  const root = (sdwanRes && typeof sdwanRes === "object" && (sdwanRes as any).results && typeof (sdwanRes as any).results === "object")
    ? (sdwanRes as any).results
    : sdwanRes;
  if (!root || typeof root !== "object") return out;
  const hcs = Array.isArray((root as any)["health-check"]) ? (root as any)["health-check"] : [];
  for (const hc of hcs) {
    if (!hc || typeof hc !== "object") continue;
    const name = typeof (hc as any).name === "string" ? (hc as any).name.trim() : "";
    if (!name) continue;
    const slas = Array.isArray((hc as any).sla) ? (hc as any).sla : [];
    let lat: number | null = null, jit: number | null = null, loss: number | null = null;
    const take = (cur: number | null, raw: unknown): number | null => {
      const n = toFiniteOrNull(raw);
      if (n == null || n <= 0) return cur;
      return cur == null ? n : Math.max(cur, n);
    };
    for (const sla of slas) {
      if (!sla || typeof sla !== "object") continue;
      const factors = parseSlaLinkCostFactors((sla as any)["link-cost-factor"]);
      // factors == null → field absent/empty → treat all metrics as enabled.
      const on = (...names: string[]) => factors == null || names.some((n) => factors.has(n));
      if (on("latency"))                    lat  = take(lat,  (sla as any)["latency-threshold"]);
      if (on("jitter"))                     jit  = take(jit,  (sla as any)["jitter-threshold"]);
      if (on("packet-loss", "packetloss"))  loss = take(loss, (sla as any)["packetloss-threshold"]);
    }
    out.set(name, { latencyMs: lat, jitterMs: jit, packetLoss: loss });
  }
  return out;
}

/** Parse a FortiOS SLA-target `link-cost-factor` field into the set of metric
 *  tokens the SLA enforces. May arrive as a space/comma-separated string
 *  ("latency packet-loss") or an array of tokens. Returns null when the field
 *  is absent/empty so callers can fall back to "all metrics enabled" for older
 *  FortiOS that omits it. */
function parseSlaLinkCostFactors(raw: unknown): Set<string> | null {
  const tokens: string[] = [];
  if (Array.isArray(raw)) {
    for (const t of raw) if (typeof t === "string" && t.trim()) tokens.push(t.trim().toLowerCase());
  } else if (typeof raw === "string" && raw.trim()) {
    for (const t of raw.trim().toLowerCase().split(/[\s,]+/)) if (t) tokens.push(t);
  }
  return tokens.length ? new Set(tokens) : null;
}

/**
 * Parse a /api/v2/monitor/virtual-wan/health-check response into PerfSlaSamples.
 * Response shape: { results: { "<hc-name>": { "<member-iface>": { latency,
 * jitter, packet_loss, status, ... }, ... }, ... } } (also accepts the
 * un-enveloped object). Returns the samples plus a member-interface → up map
 * (true if the member is up in ANY health-check) used to infer rule selection.
 * Exported for unit testing; pure (no I/O).
 */
export function parsePerfSlaHealthCheck(
  hcRes: unknown,
  thresholds?: Map<string, SlaThreshold>,
  zones?: Map<string, string>,
): { perfSla: PerfSlaSample[]; memberUp: Map<string, boolean> } {
  const perfSla: PerfSlaSample[] = [];
  const memberUp = new Map<string, boolean>();
  const hcRoot = (hcRes && typeof hcRes === "object" && (hcRes as any).results && typeof (hcRes as any).results === "object")
    ? (hcRes as any).results
    : hcRes;
  if (hcRoot && typeof hcRoot === "object") {
    for (const [hcName, members] of Object.entries(hcRoot as Record<string, any>)) {
      if (!hcName || !members || typeof members !== "object") continue;
      const thr = thresholds?.get(hcName) ?? null;
      for (const [link, m] of Object.entries(members as Record<string, any>)) {
        if (!link || !m || typeof m !== "object") continue;
        const state = normalizeSdwanState((m as any).status ?? (m as any).state ?? (m as any).alive);
        const latencyMs  = toFiniteOrNull((m as any).latency);
        const jitterMs   = toFiniteOrNull((m as any).jitter);
        const packetLoss = toFiniteOrNull((m as any).packet_loss ?? (m as any).packetloss);
        perfSla.push({
          healthCheck: hcName, link, zone: zones?.get(link) ?? null, state, latencyMs, jitterMs, packetLoss,
          latencyThresholdMs:  thr?.latencyMs ?? null,
          jitterThresholdMs:   thr?.jitterMs ?? null,
          packetLossThreshold: thr?.packetLoss ?? null,
        });
        if (state === "up") memberUp.set(link, true);
        else if (!memberUp.has(link)) memberUp.set(link, false);
      }
    }
  }
  return { perfSla, memberUp };
}

/**
 * Parse a /api/v2/cmdb/system/sdwan response into SdwanRuleSamples. `config
 * system sdwan` is a single complex object carrying a global `members` array
 * (seq-num → interface) and a `service` array of the SD-WAN rules. The runtime
 * selected member is inferred from `memberUp` (first candidate in priority order
 * that is up); null when none resolvable. Rules configured for zone-based
 * selection (`priority-zone`) carry no interface members — their candidates are
 * resolved from `memberZones` (interface → zone, from parseSdwanMemberZones)
 * preserving global-member priority order. Exported for unit testing; pure.
 */
export function parseSdwanRules(
  sdwanRes: unknown,
  memberUp: Map<string, boolean>,
  memberZones?: Map<string, string>,
): SdwanRuleSample[] {
  const sdwanRules: SdwanRuleSample[] = [];
  const sdwanRoot = (sdwanRes && typeof sdwanRes === "object" && (sdwanRes as any).results && typeof (sdwanRes as any).results === "object")
    ? (sdwanRes as any).results
    : sdwanRes;
  if (!sdwanRoot || typeof sdwanRoot !== "object") return sdwanRules;
  const seqToIface = new Map<string, string>();
  // Ordered interface list in global-member (= priority) order, used to resolve
  // a zone into its member interfaces for zone-preference rules.
  const orderedIfaces: string[] = [];
  const globalMembers = Array.isArray((sdwanRoot as any).members) ? (sdwanRoot as any).members : [];
  for (const gm of globalMembers) {
    if (!gm || typeof gm !== "object") continue;
    const seq   = (gm as any)["seq-num"] ?? (gm as any).seq_num;
    const iface = typeof (gm as any).interface === "string" ? (gm as any).interface.trim() : "";
    if (seq != null && iface) seqToIface.set(String(seq), iface);
    if (iface && !orderedIfaces.includes(iface)) orderedIfaces.push(iface);
  }
  // zone → member interfaces in priority order (built from the interface→zone
  // map + global-member ordering above).
  const zoneToIfaces = new Map<string, string[]>();
  if (memberZones) {
    for (const iface of orderedIfaces) {
      const zone = memberZones.get(iface);
      if (!zone) continue;
      const list = zoneToIfaces.get(zone) ?? [];
      if (!list.includes(iface)) list.push(iface);
      zoneToIfaces.set(zone, list);
    }
  }
  const services = Array.isArray((sdwanRoot as any).service) ? (sdwanRoot as any).service : [];
  services.forEach((svc: any, seqIdx: number) => {
    if (!svc || typeof svc !== "object") return;
    const ruleName = typeof svc.name === "string" && svc.name.trim()
      ? svc.name.trim()
      : (svc.id != null ? `rule-${svc.id}` : "");
    if (!ruleName) return;
    const ruleId = svc.id != null ? String(svc.id) : null;
    const mode = typeof svc.mode === "string" && svc.mode.trim() ? svc.mode.trim() : null;
    const enabled = svc.status == null ? null : (String(svc.status).toLowerCase() === "enable" || svc.status === true);
    const criteria = deriveSdwanCriteria(svc);
    const healthChecks = collectSdwanNameList(svc["health-check"]);
    // Destination can come from address objects + Internet-Service (ISDB) +
    // application-control entries — gather names from all the common fields.
    const dst = ([] as string[]).concat(
      collectSdwanNameList(svc.dst),
      collectSdwanNameList(svc["internet-service-name"]),
      collectSdwanNameList(svc["internet-service-custom"]),
      collectSdwanNameList(svc["internet-service-app-ctrl"]),
      collectSdwanNameList(svc["internet-service-app-ctrl-group"]),
    ).filter((v, i, arr) => v && arr.indexOf(v) === i);
    // Candidate members in priority order. FortiOS uses `members` (array of
    // { seq-num }) on most versions; some use `priority-members`. Resolve each
    // seq-num to its interface via the global members table; accept a literal
    // interface string as a fallback.
    const rawMembers =
      Array.isArray(svc.members)            ? svc.members :
      Array.isArray(svc["priority-members"]) ? svc["priority-members"] : [];
    const availableMembers: string[] = [];
    for (const rm of rawMembers) {
      let iface: string | null = null;
      if (typeof rm === "string") iface = rm.trim() || null;
      else if (rm && typeof rm === "object") {
        const seq = (rm as any)["seq-num"] ?? (rm as any).seq_num;
        if (seq != null && seqToIface.has(String(seq))) iface = seqToIface.get(String(seq))!;
        else if (typeof (rm as any).interface === "string") iface = (rm as any).interface.trim() || null;
      }
      if (iface && !availableMembers.includes(iface)) availableMembers.push(iface);
    }
    // Zone-based selection: FortiOS puts the preference in `priority-zone`
    // (zone names in priority order) and leaves the interface-member arrays
    // empty. When that's the case, expand each preferred zone into its member
    // interfaces (global-member priority order) so the rule still reports
    // candidates — without this the Members column renders empty.
    const priorityZones = collectSdwanNameList(svc["priority-zone"]);
    if (availableMembers.length === 0 && priorityZones.length > 0) {
      for (const zone of priorityZones) {
        for (const iface of zoneToIfaces.get(zone) ?? []) {
          if (!availableMembers.includes(iface)) availableMembers.push(iface);
        }
      }
    }
    let selectedMember: string | null = null;
    for (const m of availableMembers) {
      if (memberUp.get(m) === true) { selectedMember = m; break; }
    }
    const status: "up" | "down" = selectedMember ? "up" : "down";
    sdwanRules.push({
      ruleName, ruleId, seq: seqIdx, enabled, mode, criteria, healthChecks, dst,
      status, selectedMember, availableMembers, priorityZones,
    });
  });
  return sdwanRules;
}

/** Collect a list of names from a FortiOS CMDB reference field, which may be
 *  an array of { name } objects, an array of strings, or a single string. */
function collectSdwanNameList(raw: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown) => { if (typeof v === "string" && v.trim()) out.push(v.trim()); };
  if (Array.isArray(raw)) {
    for (const e of raw) {
      if (typeof e === "string") push(e);
      else if (e && typeof e === "object") push((e as any).name ?? (e as any)["q_origin_key"]);
    }
  } else if (typeof raw === "string") {
    push(raw);
  }
  return out;
}

/** Best-effort operator-facing criteria label, mirroring the FortiGate GUI's
 *  "Criteria" column. Derived from the service rule's mode + link-cost-factor.
 *  FortiOS field shapes vary by version — verify on a real device. */
function deriveSdwanCriteria(svc: any): string | null {
  const lcf = typeof svc["link-cost-factor"] === "string" ? svc["link-cost-factor"].trim().toLowerCase() : "";
  const lcfLabel: Record<string, string> = {
    latency: "Latency",
    jitter: "Jitter",
    "packet-loss": "Packet Loss",
    inbandwidth: "Bandwidth (in)",
    outbandwidth: "Bandwidth (out)",
    bibandwidth: "Bandwidth",
    "custom-profile-1": "Customized Profile",
  };
  if (lcf && lcfLabel[lcf]) return lcfLabel[lcf];
  const mode = typeof svc.mode === "string" ? svc.mode.trim().toLowerCase() : "";
  if (mode === "load-balance") return "Source IP";
  if (mode === "manual")       return "Manual";
  if (mode === "priority")     return "Best Quality";
  if (mode === "sla")          return "SLA";
  return null;
}

/**
 * Wildcard match used by the FMG/FortiGate integration's interface filter.
 * Mirrors src/services/fortimanagerService.ts:matchesWildcard so the System
 * tab applies the exact rule discovery uses.
 */
/**
 * Apply the FMG/FortiGate integration's interfaceInclude / interfaceExclude
 * filter to a System-tab interface list, in-place. Same rule discovery uses
 * to decide which interfaces' IPs become reservations, so the System tab
 * mirrors discovery's scope on both REST and SNMP transports.
 *
 * VLAN sub-interfaces / aggregate members survive the filter when their
 * parent does — hiding the parent would orphan the children that do match.
 */
export function applyFortiInterfaceFilter(
  interfaces: InterfaceSample[],
  integration: { config?: unknown } | null | undefined,
): void {
  const cfg = (integration?.config && typeof integration.config === "object")
    ? (integration.config as Record<string, unknown>)
    : {};
  const ifInclude = Array.isArray(cfg.interfaceInclude) ? (cfg.interfaceInclude as string[]) : [];
  const ifExclude = Array.isArray(cfg.interfaceExclude) ? (cfg.interfaceExclude as string[]) : [];
  if (ifInclude.length === 0 && ifExclude.length === 0) return;
  const allowed = (name: string): boolean => {
    if (ifInclude.length > 0) return ifInclude.some((p) => fortiInterfaceWildcardMatch(p, name));
    return !ifExclude.some((p) => fortiInterfaceWildcardMatch(p, name));
  };
  const survives = new Set<string>();
  for (const i of interfaces) if (allowed(i.ifName)) survives.add(i.ifName);
  for (const i of interfaces) {
    if (!survives.has(i.ifName) && i.ifParent && survives.has(i.ifParent)) survives.add(i.ifName);
  }
  for (let k = interfaces.length - 1; k >= 0; k--) {
    if (!survives.has(interfaces[k]!.ifName)) interfaces.splice(k, 1);
  }
}

// Shared glob-lite matcher — the interface filter MUST agree with the
// discovery-side device filters, so all of them import the one canonical.
const fortiInterfaceWildcardMatch = matchesWildcard;

/** The FortiOS types that group member ports under one interface. "switch" is
 *  a SOFTWARE switch (members in `system/switch-interface`), "hard-switch" a
 *  hardware one (members on the interface row). They share ifType "aggregate"
 *  — member back-fill, the interface tree and the auto-monitor type filter all
 *  treat them alike — and keep the FortiOS name as `ifSubtype`. */
const FORTI_BUNDLE_TYPES: ReadonlySet<string> = new Set(["aggregate", "redundant", "hard-switch", "switch", "vap-switch"]);

/** `ifSubtype` for a FortiOS type: the type itself for a bundle, else null. */
export function fortiIfSubtype(raw: unknown): string | null {
  if (!raw || typeof raw !== "string") return null;
  const t = raw.toLowerCase();
  return FORTI_BUNDLE_TYPES.has(t) ? t : null;
}

export function normalizeFortiIfType(raw: unknown): string | null {
  if (!raw || typeof raw !== "string") return null;
  const t = raw.toLowerCase();
  if (t === "physical" || t === "wl-mesh")                                          return "physical";
  if (FORTI_BUNDLE_TYPES.has(t))                                                     return "aggregate";
  if (t === "vlan")                                                                  return "vlan";
  if (t === "loopback")                                                              return "loopback";
  if (t === "tunnel" || t === "ssl" || t === "vxlan" || t === "gre" ||
      t === "ipsec"  || t === "vdom-link")                                           return "tunnel";
  return null;
}
