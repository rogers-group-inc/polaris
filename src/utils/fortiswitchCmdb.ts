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

// FortiOS coerces booleans inconsistently across endpoints — sometimes
// "enable"/"disable", sometimes "yes"/"no", sometimes real true/false, and
// integer flags like `fortilink-port: 1`. Normalize them all.
export function fortiosBool(raw: unknown): boolean {
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
