/**
 * src/utils/fortiapGateMac.ts
 *
 * Business rule 91(e): an UNAUTHORIZED FortiAP (controller state
 * "discovered") reports no base MAC and is named by its serial, while the
 * gate's inventory / DHCP / ARP tables know the same box by its own hostname and wired
 * MAC — so neither the MAC rung, the serial-hostname rung (91(c)) nor the
 * serial-hostname ghost merge (91(d)) can pair the two, and Phase 7 mints a
 * "fortigate-endpoint" asset beside the FortiAP asset.
 *
 * The pairing key here is the controller's own view: the AP's reported
 * management address, read in THAT gate's online detected-device inventory,
 * lease and ARP tables. Never the address alone across gates — 192.168.1.2
 * is the FortiAP factory default and sits behind many gates at once. The answer is refused (null) whenever
 * the evidence is not single-valued: two MACs for the address on the gate
 * (a stale lease ARP contradicts decides nothing — rule 101), or two APs on
 * the gate reporting the same address.
 *
 * Reservations and offline inventory rows are left out on purpose: they say
 * who held the address, not who is on it. An unauthorized AP often has no
 * lease at all — it sits on its static factory default — so the detected-
 * device row is usually the evidence that exists.
 *
 * Business rule 91(g): a managed FortiSwitch is paired the same way, and
 * ALWAYS — FortiOS reports no MAC for a managed switch anywhere
 * (`managed-switch/status` has none; `switch-controller/detected-device`
 * lists only what each switch LEARNED on its ports, so its
 * `is_fortilink_peer` row is the device at the far end of the FortiLink —
 * the gate or the upstream switch — never the switch itself). The switch
 * pulls `connecting_from` from its controller by DHCP and talks to it from
 * there, so the controller's lease / ARP / online inventory row at that
 * address is the switch's management MAC. Switches and APs share the
 * "two devices on one address identify neither" refusal.
 */

import { normalizeMacOrNull } from "./mac.js";

export interface GateLeaseRow {
  device: string;
  ipAddress: string;
  macAddress: string;
  type: "dhcp-reservation" | "dhcp-lease";
}

export interface GateInventoryRow {
  device: string;
  ipAddress: string;
  macAddress: string;
  isOnline: boolean;
}

export interface GateArpRow {
  fortigateDevice: string;
  ip: string;
  mac: string;
}

export interface GateApRow {
  device: string;
  ipAddress: string;
}

/** `gate\0ip` → the one MAC the gate saw there, or null when it saw several. */
export type GateMacIndex = Map<string, string | null>;

const key = (gate: string, ip: string) => `${gate}\u0000${ip}`;

const usableIp = (ip: string | null | undefined): string | null => {
  const t = (ip || "").trim();
  return t && t !== "0.0.0.0" ? t : null;
};

export function buildGateMacIndex(input: {
  leases: readonly GateLeaseRow[];
  inventory: readonly GateInventoryRow[];
  arp: readonly GateArpRow[];
  aps: readonly GateApRow[];
  /** Managed FortiSwitches (gate + `connecting_from`) — rule 91(g). */
  switches?: readonly GateApRow[];
}): GateMacIndex {
  const { leases, inventory, arp, aps, switches = [] } = input;
  const index: GateMacIndex = new Map();
  const put = (gate: string, ip: string | null, rawMac: string) => {
    const mac = normalizeMacOrNull(rawMac);
    if (!gate || !ip || !mac) return;
    const k = key(gate, ip);
    if (!index.has(k)) index.set(k, mac);
    else if (index.get(k) !== mac) index.set(k, null);
  };
  for (const i of inventory) if (i.isOnline) put(i.device, usableIp(i.ipAddress), i.macAddress);
  for (const l of leases) if (l.type === "dhcp-lease") put(l.device, usableIp(l.ipAddress), l.macAddress);
  for (const a of arp) put(a.fortigateDevice, usableIp(a.ip), a.mac);

  // An address two managed devices (APs or switches) on one gate both report
  // identifies neither.
  const deviceCount = new Map<string, number>();
  for (const d of [...aps, ...switches]) {
    const ip = usableIp(d.ipAddress);
    if (!d.device || !ip) continue;
    deviceCount.set(key(d.device, ip), (deviceCount.get(key(d.device, ip)) ?? 0) + 1);
  }
  for (const [k, n] of deviceCount) if (n > 1 && index.has(k)) index.set(k, null);
  return index;
}

/** The MAC the AP's own controller saw on the AP's reported address, or null. */
export function fortiapGateMac(index: GateMacIndex, ap: GateApRow): string | null {
  const ip = usableIp(ap.ipAddress);
  if (!ap.device || !ip) return null;
  return index.get(key(ap.device, ip)) ?? null;
}

/**
 * The MAC a managed FortiSwitch's own controller saw on the switch's
 * `connecting_from` address, or null (rule 91(g)). Same lookup as
 * `fortiapGateMac`; named apart so each call site says which rule it applies.
 */
export function fortiswitchGateMac(index: GateMacIndex, sw: GateApRow): string | null {
  return fortiapGateMac(index, sw);
}

/**
 * The controller's admission state says the AP is waiting for approval:
 * "discovered" (FortiOS managed_ap) or "unauthorized". Blank / unknown is NOT
 * unauthorized — older firmware omits the field.
 */
export function isFortiapUnauthorized(authorizationState: string | null | undefined): boolean {
  return /^(discovered|unauthorized)$/i.test((authorizationState || "").trim());
}
