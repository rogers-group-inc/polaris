/**
 * src/utils/dhcpClaimFreshness.ts — rank competing DHCP claims on one asset.
 *
 * An endpoint sighted by more than one FortiGate in a single discovery run
 * has several DHCP entries claiming its address: the unexpired lease still
 * bound on the site it left, the fresh lease on the site it moved to, or a
 * config-only static reservation beside a live lease. Before this helper the
 * discovery engine staged ipAddress / ipSource / learnedLocation from EVERY
 * entry, so the asset kept whichever entry happened to iterate (and win the
 * concurrent write race) last — not the latest firewall sighting.
 *
 * The score is a lexicographic vector, most decisive first:
 *   1. seenLeased — the gate's DHCP monitor confirms the binding is live-held
 *      right now. A config-only reservation row never beats a held lease.
 *   2. inventorySeenMs — the FortiGate's OWN per-client device-inventory
 *      last_seen for (mac, gate). The only genuine per-gate freshness signal:
 *      two unexpired leases are both "live" to the DHCP monitor, but only the
 *      gate the client is actually behind keeps seeing it.
 *   3. expireTime — leases only. With similar scope durations, the lease
 *      renewed most recently expires last, so the decaying remnant on the old
 *      gate loses even when inventory is disabled.
 *   4. lease-over-reservation — deterministic tiebreak.
 *
 * A LATER entry must strictly beat the standing best to take over, so equal
 * evidence keeps the first claim and re-runs are stable.
 */

export interface DhcpClaimEvidence {
  type: "dhcp-reservation" | "dhcp-lease";
  /** Monitor-confirmed currently-held binding. */
  seenLeased?: boolean;
  /** Unix seconds from the lease's expire_time (dynamic leases only). */
  expireTime?: number;
  /** The sighting gate's own per-client inventory last_seen, ms epoch. */
  inventorySeenMs?: number;
}

export type DhcpClaimScore = readonly [number, number, number, number];

export function scoreDhcpClaim(e: DhcpClaimEvidence): DhcpClaimScore {
  return [
    e.seenLeased ? 1 : 0,
    Number.isFinite(e.inventorySeenMs) ? (e.inventorySeenMs as number) : 0,
    e.type === "dhcp-lease" && Number.isFinite(e.expireTime) ? (e.expireTime as number) : 0,
    e.type === "dhcp-lease" ? 1 : 0,
  ];
}

/** Strict lexicographic comparison — ties keep the incumbent. */
export function claimBeats(candidate: DhcpClaimScore, incumbent: DhcpClaimScore): boolean {
  for (let i = 0; i < candidate.length; i++) {
    if (candidate[i] !== incumbent[i]) return candidate[i] > incumbent[i];
  }
  return false;
}

/**
 * Run-scoped claim state. The three maps below decide which FortiGate speaks
 * for an asset's address this run, and they only mean anything when every
 * competing gate lands in the SAME set.
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
  /** Phase 6: best DHCP claim score per asset. */
  bestIpClaimByAsset: Map<string, DhcpClaimScore>;
  /**
   * Freshness (ms epoch) of the sighting naming each asset's
   * fortigate-endpoint gate — shared by the Phase 6 DHCP path and the Phase 7
   * inventory path so the latest LOCAL sighting names the gate regardless of
   * which pathway or gate carried it.
   */
  bestGateClaimMsByAsset: Map<string, number>;
  /** Phase 7: freshest per-gate inventory last_seen backing an IP claim. */
  bestInvIpSeenByAsset: Map<string, number>;
}

export function createDhcpClaimState(): DhcpClaimState {
  return {
    bestIpClaimByAsset: new Map(),
    bestGateClaimMsByAsset: new Map(),
    bestInvIpSeenByAsset: new Map(),
  };
}
