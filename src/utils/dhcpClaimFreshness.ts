/**
 * src/utils/dhcpClaimFreshness.ts — rank competing address claims on one asset.
 *
 * An endpoint is routinely claimed by several entries in a single discovery
 * run: the unexpired lease still bound on the site it left, the fresh lease on
 * the site it moved to, a static reservation beside a leftover lease, the
 * FortiGate's own detected-device row for the MAC, and — on a docked laptop or
 * a plant PC with both adapters up — one claim per network card. Before this
 * helper the discovery engine staged ipAddress / ipSource / learnedLocation
 * from EVERY entry, so the asset kept whichever entry happened to iterate (and
 * win the concurrent write race) last. Business rule 101 is the contract.
 *
 * The score is a lexicographic vector, most decisive first:
 *   1. tier — how directly the claim says "this address, right now":
 *        3  a detected-device row that is online. FortiOS builds it from the
 *           traffic it is seeing from that MAC, so it is the current address,
 *           not the one that was handed out.
 *        2  a DHCP binding the gate's DHCP monitor confirms is held right now
 *           (`seenLeased` — every live lease, and a reservation whose target
 *           is holding it).
 *        1  a detected-device row that is remembered but offline.
 *        0  configuration nobody is holding: a static reservation whose target
 *           is not online.
 *   2. recent — the claim's own evidence time falls inside RECENT_CLAIM_MS of
 *      the run. Keeps a gate the device left an hour ago from winning on the
 *      medium or the binding type below.
 *   3. medium — wired (2) over unknown (1) over wireless (0). When a device is
 *      on both at once, the wired address is the one that stays put.
 *   4. reservation over lease — a reservation the device is holding is an
 *      address somebody chose on purpose; a lease is whatever the pool had.
 *   5. seenMs — the claim's evidence time: a detected-device row's own
 *      last_seen (online = run time), or for a DHCP entry the gate's
 *      detected-device last_seen for (mac, gate) — the only per-gate freshness
 *      signal two unexpired leases have.
 *   6. expireTime — leases only. With similar scope durations, the lease
 *      renewed most recently expires last.
 *
 * A LATER claim must strictly beat the standing best to take over, so equal
 * evidence keeps the first claim and re-runs are stable.
 */

export type AddressMedium = "wired" | "wireless" | "unknown";

export interface AddressClaimEvidence {
  kind: "device-inventory" | "dhcp-reservation" | "dhcp-lease";
  /**
   * Detected-device row: `is_online`. DHCP entry: `seenLeased` (the DHCP
   * monitor confirms the binding is held right now).
   */
  current?: boolean;
  medium?: AddressMedium;
  /** Evidence time, ms epoch — see the header's key 5. */
  seenMs?: number;
  /** Unix seconds from the lease's expire_time (dynamic leases only). */
  expireTime?: number;
}

export type AddressClaimScore = readonly [number, number, number, number, number, number];

/** How close to the run a claim's evidence must be to count as recent (key 2). */
export const RECENT_CLAIM_MS = 60 * 60 * 1000;

const MEDIUM_RANK: Record<AddressMedium, number> = { wired: 2, unknown: 1, wireless: 0 };

export function scoreAddressClaim(e: AddressClaimEvidence, nowMs: number): AddressClaimScore {
  const isInventory = e.kind === "device-inventory";
  const tier = isInventory ? (e.current ? 3 : 1) : (e.current ? 2 : 0);
  const seenMs = Number.isFinite(e.seenMs) ? (e.seenMs as number) : 0;
  const recent = seenMs > 0 && nowMs - seenMs <= RECENT_CLAIM_MS ? 1 : 0;
  return [
    tier,
    recent,
    MEDIUM_RANK[e.medium ?? "unknown"],
    e.kind === "dhcp-reservation" ? 1 : 0,
    seenMs,
    e.kind === "dhcp-lease" && Number.isFinite(e.expireTime) ? (e.expireTime as number) : 0,
  ];
}

/** Strict lexicographic comparison — ties keep the incumbent. */
export function claimBeats(candidate: AddressClaimScore, incumbent: AddressClaimScore): boolean {
  for (let i = 0; i < candidate.length; i++) {
    if (candidate[i] !== incumbent[i]) return candidate[i] > incumbent[i];
  }
  return false;
}

/**
 * Which medium a MAC-list entry's SOURCE label implies. Intune's hardware
 * inventory names each adapter's type, and a vCenter vNIC is a wired port as
 * far as the network is concerned. Everything else (a sighting, the agent's
 * NIC list) does not say.
 */
export function mediumFromMacSource(source: string | null | undefined): AddressMedium {
  if (source === "intune-ethernet" || source === "vcenter-vnic") return "wired";
  if (source === "intune-wifi") return "wireless";
  return "unknown";
}

/**
 * The medium of one sighting, from the strongest evidence it carries: the row's
 * own FortiAP / SSID attribution or FortiSwitch attribution first, then the
 * medium the asset's MAC entry was labelled with by a hardware source.
 */
export function claimMedium(opts: {
  wirelessEvidence?: boolean;
  wiredEvidence?: boolean;
  macSource?: string | null;
}): AddressMedium {
  if (opts.wirelessEvidence) return "wireless";
  if (opts.wiredEvidence) return "wired";
  return mediumFromMacSource(opts.macSource);
}

/**
 * Run-scoped claim state. The maps below decide which FortiGate — and which of
 * the device's network cards — speaks for an asset's address this run, and they
 * only mean anything when every competing claim lands in the SAME set.
 *
 * That is not automatic. `syncDhcpSubnets` runs ONCE PER MANAGED GATE in
 * FortiManager mode (the `onDeviceComplete` streaming callback), so maps
 * declared inside it start empty for every gate — each gate then wins its own
 * map unconditionally and the asset's ipAddress / ipSource / learnedLocation
 * become last-gate-to-finish-wins, which is the exact failure the ranking
 * above exists to prevent. The FMG run's closing `syncDhcpSubnets` call does
 * not repair it either: that one uses mode "finalize", and Phases 3-7 are
 * gated to "full" | "skip-deprecation".
 *
 * Prod 2026-09-22: an endpoint whose live-lease gate scored 1 on `seenLeased`
 * lost its address to a gate holding a never-claimed static reservation
 * (score 0) that finished 10 seconds later.
 *
 * So the state is created once per discovery RUN and threaded through every
 * per-gate sync — the same shape `AdoptionBudget` uses, for the same reason.
 * Single-call paths (standalone FortiGate, Windows Server, the directory and
 * cloud integrations) may omit it: one call is already run scope.
 *
 * Keyed by assetId, so size tracks fleet size, not gate count.
 */
export interface DhcpClaimState {
  /**
   * Best address claim per asset — ONE ladder shared by the Phase 6 DHCP pass
   * and the Phase 7 detected-device pass, so an online detected-device row on
   * one gate and a leftover lease on another compete directly instead of the
   * DHCP pass deciding alone.
   */
  bestAddressClaimByAsset: Map<string, AddressClaimScore>;
  /**
   * Freshness (ms epoch) of the sighting naming each asset's
   * fortigate-endpoint gate — shared by the Phase 6 DHCP path and the Phase 7
   * inventory path so the latest LOCAL sighting names the gate regardless of
   * which pathway or gate carried it.
   */
  bestGateClaimMsByAsset: Map<string, number>;
}

export function createDhcpClaimState(): DhcpClaimState {
  return {
    bestAddressClaimByAsset: new Map(),
    bestGateClaimMsByAsset: new Map(),
  };
}
