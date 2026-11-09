/**
 * src/utils/fortiswitchCmdb.ts
 *
 * Pure parsers over a FortiGate switch-controller managed-switch CMDB `ports`
 * array (`/api/v2/cmdb/switch-controller/managed-switch`). Dependency-free so
 * both the monitoring pass (`monitoringService.fetchFortiswitchControllerPortsCmdb`)
 * and the discovery collectors (`fortigateService` / `fortimanagerService`) can
 * share them without an import cycle — monitoringService imports fgRequest from
 * fortigateService, so the FortiSwitch port helpers can't live there if the
 * collectors are to reuse them.
 *
 * Field shapes confirmed against a live FortiOS 7.6 switch-controller CMDB.
 */

// Type-only: no runtime dependency, so the no-cycle property above holds.
import type { DiscoveredFortiSwitch } from "../services/fortimanagerService.js";

// FortiOS coerces booleans inconsistently across endpoints — sometimes
// "enable"/"disable", sometimes "yes"/"no", sometimes real true/false, and
// integer flags like `fortilink-port: 1`. Normalize them all.
function fortiosBool(raw: unknown): boolean {
  if (raw === true) return true;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw !== "string") return false;
  const s = raw.trim().toLowerCase();
  return s === "enable" || s === "yes" || s === "true" || s === "1";
}

// Extract a trunk's physical member port names from a managed-switch CMDB
// port entry. FortiOS represents the member list in several shapes depending
// on version + datasource flag: an array of objects ({member-name} or
// {q_origin_key} or {name}), an array of bare strings, or a single
// space/comma-separated string. Empty / absent on a plain physical port.
//
// Deliberately permissive — the overlay that consumes it is best-effort, so an
// unexpected shape degrades to "no trunk resolved" rather than breaking the
// interface scrape.
export function parseFortiosMemberList(raw: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    const s = typeof v === "string" ? v.trim() : "";
    if (s && !out.includes(s)) out.push(s);
  };
  if (raw == null) return out;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === "string") {
        push(entry);
      } else if (entry && typeof entry === "object") {
        const o = entry as Record<string, unknown>;
        push(o["member-name"] ?? o["q_origin_key"] ?? o.name ?? o["interface-name"]);
      }
    }
  } else if (typeof raw === "string") {
    for (const part of raw.split(/[,\s]+/)) push(part);
  }
  return out;
}

// Build the trunk → physical-member-ports map for a managed switch from its
// CMDB `ports` array. Two distinct FortiOS representations feed the same map,
// and `overlayFortiswitchTrunkMembers` consumes both identically:
//
//   1. Operator-built static / LACP trunks — a port entry that IS the trunk
//      lists its bundle members in `members` (keyed by the trunk port's own
//      name). Can be multi-member.
//   2. FortiLink auto-ISL trunks between managed FortiSwitches — the trunk
//      itself carries NO `members` (the field is `[]` and `trunk-member` is 0
//      on a live FortiOS 7.6 switch-controller CMDB). Instead each *physical*
//      uplink port names the auto-trunk it belongs to in `isl-local-trunk-name`
//      (peer switch + port live in `isl-peer-device-sn` / `isl-peer-port-name`).
//      The two ends of one ISL get DIFFERENT trunk names — each side names the
//      peer's serial fragment — so they can't be joined by trunk name. But each
//      side's `<physical port> → <its own local trunk name>` is exactly the
//      single-member mapping the overlay needs to back-fill `ifParent`, which
//      then lets the topology renderer's `preferPhysical` swap the opaque
//      serial-named trunk label (e.g. `8FFTF25005384-0`) for the real physical
//      port (e.g. `port50`) on the inter-switch edge.
//
// Keyed by trunk-interface name; auto-ISL names ("8FFTF...-0") never collide
// with physical port names ("portN") or operator LACP-trunk names, so the two
// representations coexist safely in one map.
export function buildFortiswitchTrunkMembers(ports: unknown): Map<string, string[]> {
  const trunkMembers = new Map<string, string[]>();
  if (!Array.isArray(ports)) return trunkMembers;
  for (const p of ports) {
    if (!p || typeof p !== "object") continue;
    const port = p as Record<string, unknown>;
    const portName = String(port["port-name"] ?? "").trim();
    if (!portName) continue;
    // (1) LACP / static bundle: this port IS the trunk and lists its members.
    const members = parseFortiosMemberList(port.members ?? port.member);
    if (members.length > 0) trunkMembers.set(portName, members);
    // (2) FortiLink auto-ISL: this physical port belongs to a named trunk.
    const islTrunk = String(port["isl-local-trunk-name"] ?? "").trim();
    if (islTrunk) {
      const existing = trunkMembers.get(islTrunk);
      if (existing) {
        if (!existing.includes(portName)) existing.push(portName);
      } else {
        trunkMembers.set(islTrunk, [portName]);
      }
    }
  }
  return trunkMembers;
}

// One ICL (Inter-Chassis Link) leg between two MCLAG-peer FortiSwitches, as
// seen from the local switch. A switch can carry more than one (the ICL is
// often itself an aggregate of two physical links) — one entry per local
// physical port flagged `mclag-icl-port`.
export interface FortiswitchMclagPeer {
  // Local physical port forming this ICL leg, e.g. "port51".
  localPort: string;
  // Auto-ISL trunk this leg belongs to, e.g. "_FlInK1_ICL0_". Null if absent.
  iclTrunk: string | null;
  // Peer switch serial — the canonical pairing key (port names aren't globally
  // unique across the two chassis, serials are). Required: a leg with no peer
  // serial can't be paired, so it's dropped.
  peerSn: string;
  // Peer switch name + the peer's port on the other end of this leg. Best-
  // effort labels; null when the firmware variant omits them.
  peerName: string | null;
  peerPort: string | null;
}

// Extract the MCLAG ICL legs from a managed-switch CMDB `ports` array. The
// discriminator is `mclag-icl-port` (truthy on the physical port(s) that form
// the Inter-Chassis Link to the MCLAG peer); each such port names the peer in
// `isl-peer-device-sn` / `isl-peer-device-name` / `isl-peer-port-name` and the
// local ICL trunk in `isl-local-trunk-name`. The peer switch's CMDB mirrors the
// relationship back (its `isl-peer-device-sn` points at THIS switch), so two
// switches are MCLAG peers iff each names the other's serial.
//
// NOTE: the ICL is ALSO a FortiLink auto-ISL trunk, so these same ports flow
// through `buildFortiswitchTrunkMembers` via `isl-local-trunk-name`. The
// `mclag-icl-port` flag is what distinguishes an MCLAG ICL from a plain
// inter-switch auto-ISL. Pure / dependency-free, mirroring the helpers above.
export function parseFortiswitchMclagPeers(ports: unknown): FortiswitchMclagPeer[] {
  const out: FortiswitchMclagPeer[] = [];
  if (!Array.isArray(ports)) return out;
  for (const p of ports) {
    if (!p || typeof p !== "object") continue;
    const port = p as Record<string, unknown>;
    if (!fortiosBool(port["mclag-icl-port"])) continue;
    const localPort = String(port["port-name"] ?? "").trim();
    const peerSn    = String(port["isl-peer-device-sn"] ?? "").trim();
    // Both are required: no local port → nothing to anchor the edge to; no peer
    // serial → can't pair the switches (the entire point of the table).
    if (!localPort || !peerSn) continue;
    const iclTrunk = String(port["isl-local-trunk-name"] ?? "").trim() || null;
    const peerName = String(port["isl-peer-device-name"] ?? "").trim() || null;
    const peerPort = String(port["isl-peer-port-name"] ?? "").trim() || null;
    out.push({ localPort, iclTrunk, peerSn, peerName, peerPort });
  }
  return out;
}

// Extract per-port operator descriptions from a managed-switch CMDB `ports`
// array (`config switch-controller managed-switch … config ports … set
// description`). One entry per port that carries a non-empty description.
// Feeds the FortiSwitch interface overlay so switch-port rows get the same
// "discovered description" display fallback (and description-sync read side)
// that FortiGate interfaces get from the system/interface CMDB. Pure /
// dependency-free, mirroring the helpers above.
export function parseFortiswitchPortDescriptions(ports: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(ports)) return out;
  for (const p of ports) {
    if (!p || typeof p !== "object") continue;
    const port = p as Record<string, unknown>;
    const portName = String(port["port-name"] ?? "").trim();
    if (!portName) continue;
    const description = typeof port.description === "string" ? port.description.trim() : "";
    if (description) out.set(portName, description);
  }
  return out;
}

// Identify a managed FortiSwitch's physical uplink port(s) to its controller
// FortiGate from the switch-controller CMDB `ports` array. The directly-cabled
// FortiLink uplink port carries `fortilink-port: 1` AND names the FortiGate in
// `fgt-peer-device-name` / `fgt-peer-port-name` (the latter is the FortiGate's
// LOGICAL interface — almost always "fortilink" — not a physical port, so it's
// not useful as the FortiGate-side label; the FortiGate-side physical port is
// resolved separately from LLDP). A switch chained behind another FortiSwitch
// has NO such port — its path to the FortiGate runs over an ISL trunk, so this
// returns [] for it (correct: only directly-cabled chain-head switches get a
// real FG↔switch uplink edge; map.ts demotes the rest).
//
// Returns every qualifying physical port (normally one; dual-homed switches
// can have two). The caller uses it only when there's exactly one — an
// unambiguous single uplink port — and otherwise leaves the switch-side label
// to the LLDP backfill.
export function findFortiswitchUplinkPorts(ports: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(ports)) return out;
  for (const p of ports) {
    if (!p || typeof p !== "object") continue;
    const port = p as Record<string, unknown>;
    const portName = String(port["port-name"] ?? "").trim();
    if (!portName) continue;
    const isUplink =
      fortiosBool(port["fortilink-port"]) ||
      String(port["fgt-peer-device-name"] ?? "").trim() !== "";
    if (isUplink && !out.includes(portName)) out.push(portName);
  }
  return out;
}

// Read a managed FortiSwitch's SERIAL from one managed-switch CMDB row.
//
// The table's mkey is `switch-id`, and the long-standing assumption was that it
// IS the serial. It is only the DEFAULT. FortiLink setups frequently rename it
// to the switch's hostname -- confirmed on FortiOS 7.6.7, and already documented
// at descriptionSyncService's matchManagedSwitchRow, which matches on
// `switch-id` OR `sn` for exactly this reason.
//
// On a renamed fleet, reading the mkey alone yields HOSTNAMES. That silently
// broke the FMG roster's decommission protection: the serials it collected were
// compared against `Asset.serialNumber` by `isVouchedManagedDevice` and never
// matched, so a switch authorized at FMG but missing from the live status query
// was decommissioned instead of protected -- the precise failure that roster
// exists to prevent (found 2026-09-03 against a live FMG).
//
// `sn` first, mkey as the fallback so a fleet that never renamed is unchanged.
// `name` is deliberately NOT consulted: it is the operator's display label, and
// accepting it here is how a hostname becomes a serial in the first place.
export function readManagedSwitchCmdbSerial(row: unknown): string | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const sn = typeof r.sn === "string" ? r.sn.trim() : "";
  if (sn) return sn;
  const mkey = typeof r["switch-id"] === "string" ? r["switch-id"].trim() : "";
  return mkey || null;
}

/**
 * The `format=` filter for DISCOVERY's read of FortiOS REST
 * `/api/v2/cmdb/switch-controller/managed-switch` (standalone FortiGate, and
 * the FortiManager path through `/sys/proxy/json`): the serial keys, the
 * operator description (location codes) and the `ports` table, which
 * `findFortiswitchUplinkPorts` reads. `format=` keeps a listed child table
 * whole, so `ports` arrives with every per-port attribute. Each switch row
 * otherwise carries ~200 top-level attributes. A field discovery starts
 * reading must be added here, or it is silently absent. Other readers of the
 * same endpoint (monitoring's per-switch reads) do not use this list.
 * Pinned by tests/unit/fortiosDiscoveryFormats.test.ts.
 */
export const FORTISWITCH_DISCOVERY_CMDB_FORMAT = ["sn", "switch-id", "name", "description", "ports"].join("|");

/**
 * The `format=` filter for MONITORING's per-switch read of
 * `/api/v2/cmdb/switch-controller/managed-switch/<switch-id>/ports`: the port
 * attributes the VLAN, trunk-member, MCLAG and port-description parsers read.
 * Addressing the child table directly is what lets `format=` apply to each
 * port row; on the parent read it cannot reach inside `ports` (54 ports ×
 * ~106 attributes per switch). HUB1-a, two 48-port switches: 342 KB → 57 KB,
 * identical values. A field a parser starts using is added here first.
 */
export const FORTISWITCH_MONITOR_PORT_FORMAT = [
  "port-name", "vlan", "allowed-vlans", "untagged-vlans", "allowed-vlans-all", "members", "member",
  "isl-local-trunk-name", "isl-peer-device-name", "isl-peer-device-sn", "isl-peer-port-name", "mclag-icl-port", "description",
].join("|");

/** One managed-switch port's VLAN configuration, as monitoring overlays it. */
export interface FortiswitchPortVlan {
  nativeVlan: number | null;
  taggedVlans: number[];
  /** `set allowed-vlans-all enable` (or the legacy literal "all"): the port trunks every VLAN. */
  trunksAllVlans: boolean;
}

/**
 * VLAN name → VLAN id, from the controller FortiGate's `system/interface`
 * rows. On a FortiLink-managed switch every port VLAN field NAMES a FortiGate
 * VLAN interface — `vlan: "_default"`, `allowed-vlans: [{ "vlan-name":
 * "quarantine" }]` — never a number (FortiOS 7.6.8, HUB1-a, 2026-11-04:
 * `_default` → 1, `quarantine` → 4093). The id lives on that interface's
 * `vlanid`. Rows without a valid id (physical ports, tunnels) are left out.
 */
export function fortiosVlanIdByName(interfaceRows: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(interfaceRows)) return out;
  for (const r of interfaceRows) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const id = typeof row.vlanid === "number" ? row.vlanid : Number(row.vlanid);
    if (name && Number.isInteger(id) && id >= 1 && id <= 4094) out.set(name, id);
  }
  return out;
}

const validVlanId = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 4094;

/**
 * One VLAN reference as an id: a number, a numeric string, an object carrying a
 * numeric `vlan-id` / `vlanid` / `id` / `vlan`, or a NAME (a bare string or
 * an object's `vlan-name` / `name` / `q_origin_key`) looked up in
 * `vlanIdByName`. Null when it resolves to nothing.
 */
function resolveVlanRef(ref: unknown, vlanIdByName: ReadonlyMap<string, number>): number | null {
  if (ref == null) return null;
  if (typeof ref === "number") return validVlanId(ref) ? ref : null;
  if (typeof ref === "string") {
    const s = ref.trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) { const n = Number(s); return validVlanId(n) ? n : null; }
    return vlanIdByName.get(s) ?? null;
  }
  if (typeof ref === "object") {
    const o = ref as Record<string, unknown>;
    for (const k of ["vlan-id", "vlanid", "id", "vlan"]) {
      const v = o[k];
      const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
      if (validVlanId(n)) return n;
    }
    for (const k of ["vlan-name", "name", "q_origin_key"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) {
        const id = vlanIdByName.get(v.trim());
        if (id !== undefined) return id;
      }
    }
  }
  return null;
}

/**
 * A FortiOS VLAN list (`allowed-vlans`, `untagged-vlans`) as sorted ids: an
 * array of references (see resolveVlanRef), or a "10,20-25" string from older
 * firmware. The "all" sentinel yields [] — it is reported by
 * `parseFortiswitchPortVlan` as `trunksAllVlans`, not as a finite list.
 */
export function parseFortiosVlanList(raw: unknown, vlanIdByName: ReadonlyMap<string, number> = new Map()): number[] {
  const out = new Set<number>();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const id = resolveVlanRef(entry, vlanIdByName);
      if (id !== null) out.add(id);
    }
  } else if (typeof raw === "string") {
    const s = raw.trim();
    if (!s || s.toLowerCase() === "all") return [];
    for (const part of s.split(",")) {
      const p = part.trim();
      if (!p) continue;
      const range = /^(\d+)\s*-\s*(\d+)$/.exec(p);
      if (range) {
        const a = Number(range[1]), b = Number(range[2]);
        if (a <= b) for (let i = a; i <= b; i++) if (validVlanId(i)) out.add(i);
      } else {
        const id = resolveVlanRef(p, vlanIdByName);
        if (id !== null) out.add(id);
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * A managed-switch port's VLANs: native (`vlan`), tagged = allowed minus
 * untagged, and whether it trunks every VLAN (`allowed-vlans-all: enable`, or
 * the literal "all" older firmware puts in `allowed-vlans`). Names resolve
 * through `vlanIdByName` (fortiosVlanIdByName over the controller's
 * interfaces); without it a FortiLink switch's ports resolve to nothing.
 */
export function parseFortiswitchPortVlan(port: unknown, vlanIdByName: ReadonlyMap<string, number>): FortiswitchPortVlan {
  const p = (port && typeof port === "object" ? port : {}) as Record<string, unknown>;
  const allowed = parseFortiosVlanList(p["allowed-vlans"], vlanIdByName);
  const untagged = new Set(parseFortiosVlanList(p["untagged-vlans"], vlanIdByName));
  const allRaw = p["allowed-vlans"];
  return {
    nativeVlan: resolveVlanRef(p.vlan, vlanIdByName),
    taggedVlans: allowed.filter((v) => !untagged.has(v)),
    trunksAllVlans: fortiosBool(p["allowed-vlans-all"]) || (typeof allRaw === "string" && allRaw.trim().toLowerCase() === "all"),
  };
}

/**
 * One managed FortiSwitch as discovery records it, from a monitor
 * `switch-controller/managed-switch/status` row plus the CMDB facts read
 * beside it (uplink port, description — null when the CMDB read had none).
 * Shared by the FortiGate and FortiManager collectors (CQ-B034). The
 * controller is recorded by name AND serial — consumers resolve the parent by
 * serial (utils/fortinetParentKey.ts), never by the name.
 */
export function fortiswitchDiscoveryRow(
  sw: Record<string, any>,
  controller: { device: string; deviceSerial: string },
  cmdb: { uplinkPort: string | null; description: string | null },
): DiscoveredFortiSwitch {
  return {
    device: controller.device,
    deviceSerial: controller.deviceSerial,
    name: sw["switch-id"] || "",
    serial: sw.serial || "",
    ipAddress: sw.connecting_from || "",
    fgtInterface: sw.fgt_peer_intf_name || "",
    osVersion: sw.os_version || "",
    joinTime: Number.isFinite(sw.join_time) && sw.join_time > 0 ? sw.join_time : undefined,
    state: sw.state || "",
    connected: sw.status === "Connected",
    uplinkPhysicalPort: cmdb.uplinkPort,
    description: cmdb.description,
  };
}
