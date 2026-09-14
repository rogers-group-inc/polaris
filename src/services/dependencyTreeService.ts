/**
 * src/services/dependencyTreeService.ts
 *
 * Dependency-aware monitoring suppression.
 *
 * Two layers, separated cleanly:
 *
 *   1. Persisted dependency DAG (slow-changing) — `AssetDependencyParent`
 *      rows. Refreshed at end of every FMG/FortiGate discovery cycle by
 *      `recomputeDependencyTree`. Operators may pin overrides via the
 *      admin override endpoints; computed rows and override rows live
 *      side-by-side, with overrides taking precedence per asset.
 *
 *   2. Runtime suppression flag (fast-changing) — `Asset.dependencySuppressed`.
 *      Driven by `reconcileDependencySuppression` (60s reconciler — source
 *      of truth) plus `propagateAfterStatusChange` (event-hook latency
 *      optimization). Suppression fires only on the confirmed-down edge:
 *      `warning` and `recovering` flapping does NOT propagate. Release is
 *      asymmetric — see the hysteresis note on `evaluateSuppression`: a parent
 *      short of `up` has not come back yet, whether it reads `recovering` or
 *      `warning`, so it holds its children suppressed until it reaches `up`.
 *
 * The DAG has two halves. The Fortinet INFRA half (firewall / switch /
 * access_point) is layered by BFS from the FortiGate roots — see
 * `buildDependencyEdgesFromInputs` + `assignLayers`. The ENDPOINT half
 * (everything else: servers, workstations, cameras, printers, ESXi hosts)
 * hangs one leaf edge off that infra tree via `buildEndpointDependencyEdges`
 * / `syncEndpointDependencyEdges` — added 2026-08 because before it an
 * endpoint had NO parent, and "no parents" means "never suppressed": a
 * camera-station server behind a dead FortiGate alerted as plain Down while
 * every switch and AP behind the same gate correctly read "Dep. Down".
 *
 * Multi-parent semantics ("all-down"): a switch with redundant uplinks
 * suppresses only when EVERY effective parent is down or itself
 * suppressed. Unmonitored parents are transparent (an un-monitored
 * mid-chain switch doesn't block recovery — we walk up to its parents).
 *
 * The pure helpers (`buildDependencyEdgesFromInputs`, `assignLayers`,
 * `buildEndpointDependencyEdges`, `evaluateSuppression`) are exported for
 * unit testing.
 */

import { prisma } from "../db.js";
import { EXCLUDED_LIFECYCLE_STATUSES } from "../utils/assetInvariants.js";
import { bareFortinetDeviceName } from "../utils/assetSourceLocation.js";
import { claimIsFresh, resolveOwningGateContexts, type MaclessClaimRow } from "./ipUpstreamChainService.js";
import { CLAIM_FRESH_DAYS } from "./duplicateIpConflictService.js";
import {
  buildInfraParentIndex,
  resolveInfraParentAsset,
  readControllerStamp,
  readParentSwitchStamp,
  normalizeNameKey,
  normalizeSerialKey,
} from "../utils/fortinetParentKey.js";
import { inferInterfaceTopology } from "./interfaceTopologyService.js";
import { logEventsBatch } from "./eventLogService.js";
import { logger } from "../utils/logger.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type DependencyDetectedVia =
  | "controller"
  | "interface"
  | "lldp"
  | "mesh"
  | "manual"
  // Endpoint-half signals (see buildEndpointDependencyEdges).
  | "switch-port"
  | "wireless"
  | "sighting"
  | "subnet";
export type DependencySource = "computed" | "override" | "endpoint" | "vcenter";

/**
 * The Fortinet infra types the BFS-layered half of the DAG is built from.
 * Everything else is an "endpoint" — a leaf that hangs off this tree.
 */
export const FORTINET_INFRA_ASSET_TYPES = ["firewall", "switch", "access_point"] as const;

/**
 * `source` on the endpoint half's rows. Its own value (rather than another
 * `computed` row) for three reasons: the infra recompute's delete-replace is
 * scoped to infra `assetId`s and must not see these; a distinct source makes
 * the whole feature revertible with one DELETE; and it mirrors how the vCenter
 * VM→host edges already carve out `source="vcenter"`. `loadEffectiveParents`
 * buckets everything that isn't `override` together, so these participate in
 * suppression exactly like a computed row.
 */
export const ENDPOINT_DEPENDENCY_SOURCE = "endpoint";

/** Pure-function input — one Fortinet infra asset. */
export interface DepAsset {
  id: string;
  hostname: string | null;
  serialNumber: string | null;
  assetType: string;
  fortinetTopology: unknown;
}

/** Pure-function input — one inferred-interface edge. Bidirectional. */
export interface DepInterfaceEdge {
  sourceAssetId: string;
  targetAssetId: string;
}

/** Pure-function input — one LLDP neighbor row that resolved to a Polaris asset. */
export interface DepLldpEdge {
  assetId:        string;  // local asset
  matchedAssetId: string;  // resolved peer
}

/**
 * Pure-function input — one wireless-mesh backhaul link. A mesh LEAF AP shows
 * up as an associated station on its ROOT AP (the root sees its mesh child as
 * a client; the leaf does not list the root). This makes the leaf depend on
 * the root AP, NOT on whatever switch discovery wrongly resolved for it.
 */
export interface DepMeshEdge {
  rootApId: string;  // the AP whose station table lists the leaf
  leafApId: string;  // the mesh child AP (matched station asset)
}

/** Output of edge construction — one directed parent→child edge. */
export interface DependencyEdge {
  childAssetId:  string;
  parentAssetId: string;
  detectedVia:   DependencyDetectedVia;
}

export interface LayerAssignment {
  layers: Map<string, number>;
  /** Edges that survived layer pruning — kept (parent.layer === child.layer - 1). */
  keptEdges: DependencyEdge[];
  /** Asset ids that ended up without a layer (cycles or disconnected). */
  unresolved: string[];
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Build the candidate parent→child edge set from raw discovery signals.
 *
 * Direction is inherent for controller edges (FortiGate → switch, switch →
 * AP). Interface and LLDP edges are bidirectional — direction is resolved
 * later by `assignLayers` via BFS from the FortiGate roots.
 *
 * The output is the FULL undirected graph expressed as both-direction
 * directed edges; `assignLayers` prunes to the parent-edge set.
 */
export function buildDependencyEdgesFromInputs(
  assets: DepAsset[],
  interfaceEdges: DepInterfaceEdge[],
  lldpEdges: DepLldpEdge[],
  meshEdges: DepMeshEdge[] = [],
  /** Switch ids that are bridged behind a FortiAP (LLDP-detected). Their
   * FortiLink controller edge is suppressed so they depend on the AP via the
   * LLDP edge instead of on the FortiGate. */
  bridgeLeafSwitchIds: Set<string> = new Set(),
): DependencyEdge[] {
  // Parent resolution is serial-first with the historical hostname match as
  // fallback — FMG's device NAME (what `controllerFortigate` holds) is not the
  // gate's configured hostname (what `Asset.hostname` holds), so a name-only
  // lookup drops every edge on installs where the two diverge. See
  // utils/fortinetParentKey.ts.
  const parentIndex = buildInfraParentIndex(assets);
  const byId = new Map<string, DepAsset>();
  for (const a of assets) byId.set(a.id, a);

  // Mesh leaves: APs whose real uplink is wireless to a root AP. Their
  // controller-derived edge (to a switch / FG) is BACKWARDS — the leaf depends
  // on the root AP, not the switch — so we suppress it below and emit the mesh
  // edge instead.
  const meshLeafSet = new Set<string>();
  for (const m of meshEdges) {
    if (byId.has(m.rootApId) && byId.has(m.leafApId) && m.rootApId !== m.leafApId) {
      meshLeafSet.add(m.leafApId);
    }
  }

  // Emit one edge per (child, parent, detectedVia) tuple. Same pair surfaced
  // via multiple signals (e.g. a FortiSwitch reachable via both its FortiLink
  // controller relationship AND a direct interface aggregate to the
  // FortiGate) keeps every signal in the candidate set so `assignLayers` can
  // split adjacency by kind. The final per-pair audit-trail row is picked
  // by `assignLayers`'s prune step, preferring the most-physical signal
  // (interface > lldp > controller) so the dependency row reflects "physical
  // cabling, not just logical management" when both are known.
  const edges = new Map<string, DependencyEdge>();
  function add(child: string, parent: string, detectedVia: DependencyDetectedVia) {
    if (child === parent) return;
    const key = `${child}|${parent}|${detectedVia}`;
    if (!edges.has(key)) {
      edges.set(key, { childAssetId: child, parentAssetId: parent, detectedVia });
    }
  }

  // ── Controller membership ─────────────────────────────────────────────
  //
  // Every discovery cycle asks each gate for its OWN managed inventory and
  // stamps the answer on the gate as `managedSwitchSerials` / `managedApSerials`
  // (FMG reads FortiManager's device DB, which answers even for a gate that is
  // offline; standalone reads the gate's own CMDB). That is not an inference --
  // it is the controller naming its children -- so it BOUNDS the graph: a
  // switch or AP that is not in gate G's list cannot sit under G at all.
  //
  // This supersedes the earlier child-side `contradictsController` veto, which
  // could only act when the CHILD carried a `controllerSerial` stamp and could
  // only reject a direct child<->firewall pair. Membership needs nothing from
  // the child, and additionally rejects a child<->child edge whose two ends
  // belong to different gates -- the cross-site link a veto cannot express.
  //
  // Prod 2026-09-03: a FortiSwitch bound correctly to its gate by `controller`
  // and `interface` edges also carried an `lldp` edge to an unrelated gate. The
  // neighbour row named the RIGHT gate; `matchedAssetId` had been resolved to
  // the wrong asset at scrape time and frozen there. Under all-down semantics
  // that spurious up parent does not merely look wrong, it BREAKS suppression:
  // the child keeps alerting as plain Down when its real upstream dies. The
  // gate's own roster did not list that switch.
  //
  // TRI-STATE, and the distinction is load-bearing:
  //   absent  -> unknown  (roster unreadable / pre-feature row) -> no constraint
  //   []      -> known-empty (gate manages none) -> every inferred edge dropped
  //   [...]   -> constrains to exactly these serials
  // An unreadable roster must never read as "manages nothing", which is why
  // discovery stamps the field only when the read actually answered.
  const knownMembersOf = new Map<string, Set<string>>();
  for (const a of assets) {
    if (a.assetType !== "firewall") continue;
    const top = a.fortinetTopology as Record<string, unknown> | null;
    if (!top) continue;
    const sw = top.managedSwitchSerials;
    const ap = top.managedApSerials;
    if (!Array.isArray(sw) && !Array.isArray(ap)) continue;
    const set = new Set<string>();
    for (const raw of [...(Array.isArray(sw) ? sw : []), ...(Array.isArray(ap) ? ap : [])]) {
      const key = normalizeSerialKey(typeof raw === "string" ? raw : null);
      if (key) set.add(key);
    }
    knownMembersOf.set(a.id, set);
  }

  // Which gate claims each switch / AP, by serial. Parent-side, so it works for
  // a child whose own `controllerSerial` stamp is missing or stale.
  const gateOfMember = new Map<string, string>();
  for (const a of assets) {
    if (a.assetType !== "switch" && a.assetType !== "access_point") continue;
    const key = normalizeSerialKey(a.serialNumber);
    if (!key) continue;
    for (const [gateId, members] of knownMembersOf) {
      if (members.has(key)) { gateOfMember.set(a.id, gateId); break; }
    }
  }

  /**
   * Does an inferred adjacency between `x` and `y` contradict what the gates
   * say they manage? Answers false whenever nothing authoritative is known --
   * membership can only ever REJECT, never assert an edge into existence.
   */
  function violatesMembership(x: string, y: string): boolean {
    const ax = byId.get(x);
    const ay = byId.get(y);
    if (!ax || !ay) return false;
    // child <-> firewall: the gate's own list decides.
    for (const [child, gate] of [[ax, ay], [ay, ax]] as const) {
      if (gate.assetType !== "firewall") continue;
      if (child.assetType !== "switch" && child.assetType !== "access_point") continue;
      const members = knownMembersOf.get(gate.id);
      if (!members) continue;                       // unknown -> no constraint
      const key = normalizeSerialKey(child.serialNumber);
      if (!key) continue;                           // no serial -> cannot judge
      if (!members.has(key)) return true;
    }
    // child <-> child: two members of DIFFERENT gates are not adjacent.
    const gx = gateOfMember.get(ax.id);
    const gy = gateOfMember.get(ay.id);
    if (gx && gy && gx !== gy) return true;
    return false;
  }

  // 1) Controller-derived edges (directed, authoritative).
  for (const a of assets) {
    const top = a.fortinetTopology as Record<string, unknown> | null;
    if (!top) continue;
    if (a.assetType === "switch") {
      // Bridged-behind-an-AP switch: its FortiLink edge is the logical-mgmt
      // path, not the physical uplink — skip it; the LLDP edge to the AP (added
      // below) makes it depend on the AP instead.
      if (bridgeLeafSwitchIds.has(a.id)) continue;
      const parent = resolveInfraParentAsset(parentIndex, readControllerStamp(top), "firewall");
      if (parent) add(a.id, parent.id, "controller");
    } else if (a.assetType === "access_point") {
      // Mesh leaf: its switch/FG controller edge is backwards — skip it; the
      // mesh edge (added below) makes it depend on its root AP instead.
      // Two signals: the station-derived meshLeafSet (root AP lists the leaf
      // as a client) and FortiOS's own mesh_uplink classification stamped on
      // fortinetTopology — the latter covers leaves whose root AP has no
      // station scrape, and pre-mesh-fix rows where parentSwitch still names
      // the switch bridged BEHIND the leaf.
      if (meshLeafSet.has(a.id)) continue;
      if (top.meshUplink === "mesh") continue;
      // Branch on stamp PRESENCE, not resolution success — unchanged from the
      // pre-serial behavior. An AP that names a parentSwitch Polaris doesn't
      // know gets no edge rather than a shortcut edge to the controller gate,
      // which would claim a physical adjacency that isn't there.
      const switchStamp = readParentSwitchStamp(top);
      const fgStamp = readControllerStamp(top);
      if (switchStamp.name) {
        const parent = resolveInfraParentAsset(parentIndex, switchStamp, "switch");
        if (parent) add(a.id, parent.id, "controller");
      } else if (fgStamp.name || fgStamp.serial) {
        // AP not behind a FortiSwitch (rare — direct uplink to FortiGate).
        const parent = resolveInfraParentAsset(parentIndex, fgStamp, "firewall");
        if (parent) add(a.id, parent.id, "controller");
      }
    }
  }

  // 1b) Mesh-derived edges (directed root AP → leaf AP, authoritative for the
  // leaf). Treated as the strongest signal so it wins the prune tiebreak and,
  // via `assignLayers`' physical adjacency, layers the leaf off its root AP.
  for (const m of meshEdges) {
    if (byId.has(m.rootApId) && byId.has(m.leafApId)) add(m.leafApId, m.rootApId, "mesh");
  }

  // 2) Interface-derived edges (bidirectional — emit both directions and
  // let assignLayers pick the parent direction via BFS layer pruning).
  // Both directions are dropped together for a contradicted pair: assignLayers
  // builds UNDIRECTED adjacency from this list, so removing one direction would
  // leave the adjacency (and therefore the layering) intact.
  for (const e of interfaceEdges) {
    const a = byId.get(e.sourceAssetId);
    const b = byId.get(e.targetAssetId);
    if (!a || !b) continue;
    if (violatesMembership(a.id, b.id)) continue;
    add(a.id, b.id, "interface");
    add(b.id, a.id, "interface");
  }

  // 3) LLDP-derived edges (bidirectional; weakest signal).
  for (const e of lldpEdges) {
    const a = byId.get(e.assetId);
    const b = byId.get(e.matchedAssetId);
    if (!a || !b) continue;
    if (violatesMembership(a.id, b.id)) continue;
    add(a.id, b.id, "lldp");
    add(b.id, a.id, "lldp");
  }

  return [...edges.values()];
}

/**
 * Staleness bound for LLDP-derived dependency edges.
 *
 * `AssetLldpNeighbor` rows are kept for 48h after a neighbor stops being
 * advertised (LLDP_STICKY_WINDOW_MS in monitoringService) so the System tab's
 * Neighbor column doesn't flap empty on a missed advertisement. That grace is
 * a DISPLAY contract. A dependency edge is a different claim: it decides
 * whether an alert is suppressed, so it needs the freshness discipline
 * `inferInterfaceTopology` already applies to its own inputs ("an edge drawn
 * from a stale reading is wrong data").
 *
 * The failure directions are asymmetric, which is why this bound is
 * deliberately tight rather than generous:
 *
 *   - A SPURIOUS parent actively breaks suppression. Multi-parent semantics
 *     are all-down, so an extra parent that is up keeps the child alerting as
 *     plain Down when its real upstream dies — the opposite of what the
 *     dependency tree is for.
 *   - A MISSING LLDP parent is usually harmless: a FortiSwitch reaches the
 *     same gate via its `controller` edge and often an `interface` edge too,
 *     both of which are unaffected by this bound.
 *
 * Prod 2026-09-03: a switch carried a stale `port-30` row — orphaned when the
 * local port label changed, so no fresh scrape could supersede it and it rode
 * out the full 48h — whose `matchedAssetId` still named the wrong FortiGate
 * from a period when two gates shared a management address. The current row
 * for the same link (keyed by the FortiLink trunk name) had already matched
 * correctly, but the recompute read both and gave the switch two parents.
 */
const LLDP_EDGE_STALE_MS = 6 * 60 * 60 * 1000;

/** One LLDP neighbor row, as far as edge freshness is concerned. */
export interface DepLldpRow {
  assetId: string;
  matchedAssetId: string | null;
  lastSeen: Date;
  source: string | null;
}

/**
 * Drop LLDP rows too stale to justify a dependency edge.
 *
 * A row is kept when EITHER:
 *
 *   1. it was refreshed within `LLDP_EDGE_STALE_MS` — ordinary grace, so a
 *      single missed advertisement doesn't drop an edge until the next
 *      recompute (which only runs per discovery cycle, 4h by default), or
 *   2. it carries the newest `lastSeen` of any row for its (asset, source) —
 *      i.e. the most recent scrape by that writer DID refresh it.
 *
 * Arm 2 is what makes this cadence-agnostic: `lldpIntervalSeconds` is
 * operator-settable up to 24h, so a fixed window alone would drop every edge
 * on a slow-cadence install. Keying it per SOURCE rather than per asset
 * matters because two writers cover one asset — `persistLldpNeighbors`
 * (snmp / fortios) and `persistManagedApLldpNeighbors` — and a write by one
 * must not age out the other's rows.
 *
 * Pure; `now` is injected for testability.
 */
export function filterFreshLldpRows(rows: DepLldpRow[], now: Date = new Date()): DepLldpRow[] {
  if (rows.length === 0) return [];
  // Newest lastSeen per (asset, source). One scrape stamps one `now` across
  // every row it writes, so "equals the max" is exactly "this scrape saw it".
  const newestBySourceKey = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.assetId}\u0001${r.source ?? ""}`;
    const t = r.lastSeen.getTime();
    const prev = newestBySourceKey.get(key);
    if (prev === undefined || t > prev) newestBySourceKey.set(key, t);
  }
  const cutoff = now.getTime() - LLDP_EDGE_STALE_MS;
  return rows.filter(r => {
    const t = r.lastSeen.getTime();
    if (t >= cutoff) return true;
    return t === newestBySourceKey.get(`${r.assetId}\u0001${r.source ?? ""}`);
  });
}

/** Rank the physical-ness of a detectedVia signal. Higher is more
 *  "physical-cabling" and wins the prune-step tiebreak when multiple signals
 *  describe the same (child, parent) pair. interface > lldp > controller
 *  reflects that operator-facing audit trails should show the strongest
 *  evidence of a real cable, with controller (logical FortiLink management)
 *  as the weakest fallback. */
function physicalRank(detectedVia: DependencyDetectedVia): number {
  if (detectedVia === "mesh")      return 4; // authoritative wireless backhaul
  if (detectedVia === "interface") return 3;
  if (detectedVia === "lldp")      return 2;
  if (detectedVia === "controller") return 1;
  return 0;
}

/**
 * Assign BFS-shortest-path layers from the FortiGate roots, then keep only
 * edges that point from layer L-1 to layer L (parent edges). Same-layer
 * edges (MCLAG siblings) and reverse edges are dropped.
 *
 * Cycles can't form once layers are assigned by BFS — disconnected
 * components or assets only reachable through unmonitored intermediates
 * end up unresolved.
 */
export function assignLayers(
  assets: DepAsset[],
  edges: DependencyEdge[],
): LayerAssignment {
  const layers = new Map<string, number>();

  // Layer 1: every FortiGate firewall.
  for (const a of assets) {
    if (a.assetType === "firewall") layers.set(a.id, 1);
  }

  // Split adjacency by signal kind. Physical adjacency (interface + LLDP)
  // expresses CABLED connectivity; controller adjacency expresses LOGICAL
  // FortiLink management — every managed FortiSwitch points back at the
  // controller FortiGate via `controllerFortigate` regardless of whether
  // it's directly cabled to it or daisy-chained behind another switch.
  // The physical-first BFS below uses physical adjacency exclusively, so
  // a chain like FG → 148F-1 (LLDP) → 148F-2 (LLDP) → 148F-3 layers
  // correctly instead of collapsing to three same-layer siblings.
  const physicalAdj = new Map<string, Set<string>>();
  const controllerAdj = new Map<string, Set<string>>();
  function link(adj: Map<string, Set<string>>, a: string, b: string) {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  }
  for (const e of edges) {
    // Mesh counts as physical (a real, if wireless, backhaul link) so the
    // leaf AP layers off its root AP in the physical-first BFS rather than
    // collapsing onto a controller-resolved switch.
    const isPhysical = e.detectedVia === "interface" || e.detectedVia === "lldp" || e.detectedVia === "mesh";
    const target = isPhysical ? physicalAdj : controllerAdj;
    link(target, e.childAssetId, e.parentAssetId);
    link(target, e.parentAssetId, e.childAssetId);
  }

  // Pass 1: BFS outward from layer 1 using physical adjacency only.
  // Stable in id order so multiple FGs at layer 1 explore deterministically
  // (matters for the hostname-tie test cases).
  function physicalBfs(seed: string[]) {
    const queue: string[] = [...seed];
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      const curLayer = layers.get(cur)!;
      const neighbors = physicalAdj.get(cur);
      if (!neighbors) continue;
      for (const n of neighbors) {
        if (!layers.has(n)) {
          layers.set(n, curLayer + 1);
          queue.push(n);
        }
      }
    }
  }
  physicalBfs([...layers.keys()].sort());

  // Pass 2: controller fallback. Assets the physical pass didn't reach
  // attach via their controller relationship — but with chain-detection so
  // a 3+ switch daisy chain doesn't collapse to "all siblings off the
  // FortiGate" just because every switch in the chain reports
  // `controllerFortigate = <FG>`.
  //
  // Algorithm: group unattached assets by their attachment point in
  // `layers` (the controller asset whose layer is known). For each group,
  // examine the physical-adjacency subgraph induced by the group. When the
  // subgraph is a SIMPLE PATH of ≥3 nodes (n nodes, n-1 edges, exactly 2
  // endpoints), we have unambiguous chain evidence — attach the
  // alphabetical endpoint as the chain head and let the physical-BFS in
  // step 3 walk through. Otherwise (1 or 2 nodes, branching, or cycles —
  // including the MCLAG pair case where two switches share a controller
  // and are directly cabled to each other), attach every member as a
  // direct sibling at `controller.layer + 1`. This preserves the existing
  // "MCLAG siblings don't become parents of each other" behavior while
  // fixing the daisy-chain misreport that motivated this change.
  let progress = true;
  while (progress) {
    progress = false;

    // Bucket unattached assets by their currently-attachable controller.
    // An asset is attachable when at least one of its controller-edge
    // neighbors is already in `layers`. Use the closest controller-edge
    // parent (min layer) so multi-controller assets attach near the root.
    const buckets = new Map<string, string[]>();
    const attachableParent = new Map<string, string>();
    for (const a of assets) {
      if (layers.has(a.id)) continue;
      const ctlNeighbors = controllerAdj.get(a.id);
      if (!ctlNeighbors) continue;
      let bestParent: string | null = null;
      let bestLayer = Infinity;
      for (const n of ctlNeighbors) {
        const nLayer = layers.get(n);
        if (nLayer != null && nLayer < bestLayer) {
          bestLayer = nLayer;
          bestParent = n;
        }
      }
      if (bestParent != null) {
        attachableParent.set(a.id, bestParent);
        const list = buckets.get(bestParent) ?? [];
        list.push(a.id);
        buckets.set(bestParent, list);
      }
    }

    // Process each bucket. Stable controller order so ties resolve
    // deterministically across runs.
    for (const [parentId, memberIds] of [...buckets.entries()].sort()) {
      const parentLayer = layers.get(parentId)!;
      const memberSet = new Set(memberIds);

      // Physical-adjacency subgraph induced by this bucket.
      type NodeStats = { id: string; neighborsInBucket: string[] };
      const stats: NodeStats[] = memberIds.map(id => ({
        id,
        neighborsInBucket: [...(physicalAdj.get(id) ?? new Set())].filter(n => memberSet.has(n)),
      }));
      const totalEdges = stats.reduce((sum, s) => sum + s.neighborsInBucket.length, 0) / 2;
      const endpoints = stats.filter(s => s.neighborsInBucket.length === 1).map(s => s.id);
      const branching = stats.some(s => s.neighborsInBucket.length > 2);

      const isSimpleChain =
        memberIds.length >= 3 &&
        totalEdges === memberIds.length - 1 &&
        endpoints.length === 2 &&
        !branching;

      if (isSimpleChain) {
        // Attach the alphabetically-first endpoint as the chain head and
        // let physical BFS in the next loop iteration walk through. Hostname
        // is the right tiebreaker — operators name daisy chains 1-2-3 by
        // convention, and the head ends up alphabetically first.
        const headById = new Map<string, DepAsset>();
        for (const a of assets) headById.set(a.id, a);
        const sortedEndpoints = [...endpoints].sort((a, b) => {
          const ha = (headById.get(a)?.hostname ?? a).toLowerCase();
          const hb = (headById.get(b)?.hostname ?? b).toLowerCase();
          return ha < hb ? -1 : ha > hb ? 1 : 0;
        });
        const head = sortedEndpoints[0];
        layers.set(head, parentLayer + 1);
        progress = true;
        // BFS through the chain.
        physicalBfs([head]);
      } else {
        // Sibling attachment — every member at controller.layer + 1.
        // Covers single-node buckets, MCLAG pairs, branching/cycled
        // components, and the existing-flat-tree behavior for
        // environments without physical-uplink signals.
        for (const id of memberIds) {
          layers.set(id, parentLayer + 1);
          progress = true;
        }
        // After siblings land, physical-BFS through them in case any of
        // them physically chain further downstream (e.g. an MCLAG pair
        // each cabling out to its own access switch).
        physicalBfs(memberIds);
      }
    }
  }

  // Prune: keep only edges where parent is exactly one layer above child.
  // Within each (child, parent) pair, prefer the most-physical detectedVia
  // for the audit-trail row that lands in AssetDependencyParent. interface
  // beats lldp beats controller.
  const bestPerPair = new Map<string, DependencyEdge>();
  for (const e of edges) {
    const childLayer  = layers.get(e.childAssetId);
    const parentLayer = layers.get(e.parentAssetId);
    if (childLayer == null || parentLayer == null) continue;
    if (parentLayer + 1 !== childLayer) continue;
    const key = `${e.childAssetId}|${e.parentAssetId}`;
    const existing = bestPerPair.get(key);
    if (!existing || physicalRank(e.detectedVia) > physicalRank(existing.detectedVia)) {
      bestPerPair.set(key, e);
    }
  }
  const keptEdges: DependencyEdge[] = [...bestPerPair.values()];

  const unresolved = assets
    .filter(a => !layers.has(a.id))
    .map(a => a.id);

  return { layers, keptEdges, unresolved };
}

// ─── Endpoint half of the DAG ───────────────────────────────────────────────

/**
 * Pure-function input — one non-infra asset and every upstream signal Polaris
 * already records for it. No new collection: all three come from columns
 * discovery has always written.
 */
export interface DepEndpoint {
  id: string;
  /** `Asset.lastSeenSwitch` — "<switch-id-or-hostname>/<port>". */
  lastSeenSwitch: string | null;
  /** `Asset.lastSeenAp` — the FortiAP's name. */
  lastSeenAp: string | null;
  /**
   * Candidate FortiGate names from `AssetFortigateSighting.fortigateDevice`,
   * MOST RECENTLY SEEN FIRST. The caller orders them; this function just takes
   * the first that resolves to a firewall asset.
   */
  sightedFortigates: string[];
  /**
   * LAST RESORT: the firewall Asset that owns the network this endpoint's
   * address sits in, per IPAM. Already an id — the caller resolves it through
   * `resolveOwningGateContexts`, which applies rule 41's serial-before-name
   * precedence — so no name matching happens here. Null when the address sits
   * in no known network, the owning gate has no Asset row, or the endpoint's
   * claim on its address is not current.
   */
  ipamGateAssetId: string | null;
}

/** One resolved endpoint parent. */
export interface EndpointParentResolution {
  parentAssetId: string;
  detectedVia: Extract<DependencyDetectedVia, "switch-port" | "wireless" | "sighting" | "subnet">;
}

/** The switch half of a `lastSeenSwitch` value ("FS-248E-01/port15" → "FS-248E-01"). */
export function switchNameFromLastSeenSwitch(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  const slash = t.indexOf("/");
  const name = (slash === -1 ? t : t.slice(0, slash)).trim();
  return name || null;
}

/**
 * Resolve the ONE upstream device an endpoint hangs off, most-specific first:
 * wired switch port → wireless AP → the FortiGate that last saw it → the
 * FortiGate that owns the network its address is in.
 *
 * The fourth tier is an INFERENCE, not an observation: no gate ever reported
 * this device, so IPAM is asked which gate serves its address. It sits last
 * because the three above it are records of the device actually being seen,
 * and it only ever fires where the alternative is no parent at all — an
 * endpoint nothing can place is an endpoint that never suppresses, so this
 * tier can only ADD suppression, never move an existing edge. The failure mode
 * is therefore a missed alert (a device suppressed behind a gate it does not
 * really sit behind), never a false one, and entering suppression still needs
 * that gate CONFIRMED down (rule 38) rather than merely flapping.
 *
 * SINGLE parent, not a union of everything that resolves — and that is the
 * load-bearing decision here. The evaluator's multi-parent rule is "all-down"
 * (built for a switch with redundant uplinks), but a switch and the gate above
 * it are in SERIES, not parallel: listing both would mean a dead access switch
 * with a healthy gate satisfies "some parent is ok" and the endpoint keeps
 * alerting — the exact case an operator expects to be suppressed. Taking only
 * the most specific parent gets the series behavior for free, because the
 * switch is itself suppressed when its gate goes down, so `isParentOk(switch)`
 * is already false. Gate down ⇒ suppressed; gate up and switch down ⇒
 * suppressed; both up ⇒ the endpoint's own probe state stands.
 *
 * An unmonitored intermediate is transparent to the evaluator (it walks up to
 * the grandparents), so pinning an endpoint to an unmonitored access switch
 * still yields gate-driven suppression rather than silence.
 *
 * Returns null when nothing resolves — treat as "no parent", i.e. this endpoint
 * never suppresses. That's the safe direction: an unresolvable upstream must
 * leave alerting exactly as it was.
 */
export function resolveEndpointParent(
  index: ReturnType<typeof buildInfraParentIndex>,
  endpoint: DepEndpoint,
): EndpointParentResolution | null {
  const switchName = switchNameFromLastSeenSwitch(endpoint.lastSeenSwitch);
  if (switchName) {
    const sw = resolveInfraParentAsset(index, { name: switchName }, "switch");
    if (sw) return { parentAssetId: sw.id, detectedVia: "switch-port" };
  }

  const apName = typeof endpoint.lastSeenAp === "string" ? endpoint.lastSeenAp.trim() : "";
  if (apName) {
    const ap = resolveInfraParentAsset(index, { name: apName }, "access_point");
    if (ap) return { parentAssetId: ap.id, detectedVia: "wireless" };
  }

  for (const name of endpoint.sightedFortigates) {
    if (!name) continue;
    const fg = resolveInfraParentAsset(index, { name }, "firewall");
    if (fg) return { parentAssetId: fg.id, detectedVia: "sighting" };
  }

  if (endpoint.ipamGateAssetId) {
    return { parentAssetId: endpoint.ipamGateAssetId, detectedVia: "subnet" };
  }

  return null;
}

/**
 * Build the endpoint half of the DAG — at most one edge per endpoint.
 *
 * `infra` is the same firewall/switch/AP inventory the infra half walks, so
 * parent resolution reuses `fortinetParentKey`'s serial → FMG-device-name →
 * hostname precedence rather than matching a stamp against `Asset.hostname`
 * (the mismatch that silently unparented every switch on this install once —
 * see utils/fortinetParentKey.ts).
 */
export function buildEndpointDependencyEdges(
  endpoints: DepEndpoint[],
  infra: DepAsset[],
): DependencyEdge[] {
  const index = buildInfraParentIndex(infra);
  const out: DependencyEdge[] = [];
  for (const e of endpoints) {
    const hit = resolveEndpointParent(index, e);
    if (!hit || hit.parentAssetId === e.id) continue;
    out.push({ childAssetId: e.id, parentAssetId: hit.parentAssetId, detectedVia: hit.detectedVia });
  }
  return out;
}

/**
 * Evaluate desired `dependencySuppressed` state for every asset given the
 * current per-asset effective-parent set and per-asset state.
 *
 * "All-down" semantics: an asset is suppressed iff it has at least one
 * effective parent AND every effective parent is either confirmed down or
 * itself suppressed. Unmonitored parents are transparent — they're skipped
 * and the walk continues to their parents (if any).
 *
 * HYSTERESIS — entering and leaving suppression ask DIFFERENT questions, and
 * that asymmetry is the whole of business rule 38a:
 *
 *   enter   (child not currently suppressed): "is this parent confirmed down?"
 *           Only `down` qualifies. `warning` and `recovering` are flapping
 *           states and must not drag a healthy subtree into Dep. Down on one
 *           missed or one answered packet.
 *   release (child currently suppressed):     "is this parent genuinely BACK?"
 *           Only `up` qualifies — the bucket has drained to zero, which is the
 *           number of answered polls the operator's own automation asked for.
 *           Anything short of that (`down`, `recovering`, `warning`) holds the
 *           subtree. Releasing early un-suppresses a subtree whose own probes
 *           are all still failing: every child immediately starts its own down
 *           run and the outage re-alerts device by device as plain Down —
 *           exactly the alert storm suppression exists to prevent. Holding
 *           until the parent is genuinely back collapses that into one
 *           recovery.
 *
 * `RELEASES_SUPPRESSION` is that release whitelist, and it is a whitelist on
 * purpose: a seventh monitor state added later holds the subtree until someone
 * decides it means "back", rather than quietly leaking it.
 *
 * The two non-verdicts are in the whitelist alongside `up`: `unknown` (never
 * probed) and `passive` (business rule 36 — no automation renders a verdict on
 * it) are not claims that the parent is unreachable, and gating release on them
 * would strand a subtree in Dep. Down with nothing that could ever clear it.
 * `warning` used to sit with them on that reasoning and no longer does — it is
 * the one state where the parent has just MISSED a poll, the least plausible
 * moment to call it recovered, and it cannot strand anything because it is
 * transient by construction (keep missing and the bucket reaches the threshold
 * → `down`; keep answering and it drains → `up`). The gap it opened was real:
 * a parent flapping through `down → recovering → recovering → warning` (a miss
 * once the bucket has drained below threshold-1, per `nextFailureBucket`) put
 * its whole subtree back on the air mid-outage, one reconciler tick later.
 *
 * Iteratively re-evaluates in BFS layer order until stable. Bounded — at
 * most one pass per layer.
 */
/**
 * The parent monitor states that let an ALREADY-SUPPRESSED child out of Dep.
 * Down. See the hysteresis note on `evaluateSuppression`: `up` is the parent
 * genuinely back, `unknown` and `passive` are the two states that render no
 * verdict at all and would otherwise strand a subtree forever. Everything else
 * — `down`, `recovering`, `warning` — holds.
 */
const RELEASES_SUPPRESSION: ReadonlySet<string> = new Set(["up", "unknown", "passive"]);

export interface SuppressionAssetState {
  id: string;
  layer: number | null;
  monitored: boolean;
  monitorStatus: string | null;
  /**
   * The asset's PERSISTED `dependencySuppressed` flag. Load-bearing, not
   * merely a seed: it selects which side of the hysteresis this asset is
   * evaluated on (see the release rule on `evaluateSuppression`).
   */
  currentlySuppressed: boolean;
  /**
   * Admin-only "Dependency Test" overlay. When this timestamp is in the
   * future, the asset is treated as confirmed-down for the purposes of
   * isParentOk — children with this asset in their effective parent set
   * get suppressed exactly as they would under a real outage. Real probes
   * still update monitorStatus normally; the overlay is purely a what-if.
   * Past or null = inactive (auto-expired or never set).
   */
  dependencyTestUntil?: Date | null;
  /**
   * Asset lifecycle status. status="maintenance" (scheduler-held while a
   * maintenance window is open) behaves exactly like an active Dependency
   * Test overlay: the parent counts as down so its children suppress — a
   * switch in maintenance takes its downstream devices into dependency
   * suppression, and the reconciler resumes them when the window ends.
   * Overridable per schedule via `maintenanceSuppressChildren`.
   */
  status?: string | null;
  /**
   * Per-schedule "mark dependents down" toggle (MaintenanceSchedule
   * .suppressChildren, OR-ed across the asset's open windows by the
   * reconciler). Only consulted when status="maintenance". false = the
   * maintenance status is IGNORED by suppression and the parent evaluates
   * by its frozen monitorStatus (dependents keep monitoring/alerting —
   * e.g. a clustered/redundant parent whose children stay reachable).
   * Omitted/true = launch behavior (maintenance parent counts as down).
   */
  maintenanceSuppressChildren?: boolean;
  /**
   * HA standby FortiGate (fortinetTopology.haRole === "secondary"). An
   * UNMONITORED standby parent is IGNORED by suppression — removed from the
   * child's effective parent set — rather than treated as a transparent
   * always-ok parent. Standbys are unmonitored by design (the cluster IP
   * routes to the active member), so the generic transparent rule's
   * "no monitored ancestor = ok" would permanently veto all-down
   * suppression for every switch LLDP-cabled to both HA members: primary
   * confirmed down, standby unknowable → child never suppresses. Ignoring
   * the standby makes the primary's probe state decide, which matches
   * physical reality (Polaris has no independent signal for the standby at
   * probe cadence). A MONITORED standby (operator opt-in) evaluates
   * normally by its own probe state.
   */
  isHaStandby?: boolean;
}
export function evaluateSuppression(
  states: SuppressionAssetState[],
  /** Map child id → effective parent ids. */
  parentsByChild: Map<string, string[]>,
): Map<string, boolean> {
  // Index by id for fast lookup.
  const stateById = new Map<string, SuppressionAssetState>();
  for (const s of states) stateById.set(s.id, s);

  // Walk in layer order so a parent's effective state is settled before
  // its children are evaluated. Assets with null layer (unresolved /
  // disconnected) end up with no parents → never suppressed.
  const sorted = [...states].sort((a, b) => {
    const la = a.layer ?? Number.MAX_SAFE_INTEGER;
    const lb = b.layer ?? Number.MAX_SAFE_INTEGER;
    return la - lb;
  });

  const result = new Map<string, boolean>();
  for (const s of sorted) result.set(s.id, false);

  // Unmonitored HA-standby parents are invisible to suppression — filtered
  // out of every parent set (top-level and the transparent-walk recursion)
  // so they neither veto nor force suppression. See isHaStandby doc above.
  const isIgnoredStandby = (id: string): boolean => {
    const ps = stateById.get(id);
    return ps?.isHaStandby === true && !ps.monitored;
  };

  for (const s of sorted) {
    const parents = (parentsByChild.get(s.id) ?? []).filter(p => !isIgnoredStandby(p));
    if (parents.length === 0) {
      result.set(s.id, false);
      continue;
    }

    // Resolve effective parents — skip unmonitored, walk up through them.
    // Bounded by layer order; we never re-enter visited.
    const visited = new Set<string>();
    const evalNow = Date.now();
    function isParentOk(parentId: string): boolean {
      if (visited.has(parentId)) return false;
      visited.add(parentId);
      const ps = stateById.get(parentId);
      if (!ps) return true; // unknown asset — treat as ok rather than block.
      // Admin-only Dependency Test overlay. Active overlay forces this
      // parent to behave as down for child suppression — it does NOT walk
      // through to grandparents the way an unmonitored parent does, since
      // the operator's intent is "pretend THIS box went offline."
      if (ps.dependencyTestUntil && ps.dependencyTestUntil.getTime() > evalNow) {
        return false;
      }
      // Maintenance window: the parent is deliberately offline — behave
      // exactly like the test overlay (down, no walk-through to
      // grandparents; "pretend THIS box went offline" is literally true).
      // Unless the schedule opted out (suppressChildren=false): then the
      // maintenance status is ignored and the parent falls through to the
      // normal evaluation below (its monitorStatus is frozen at the
      // pre-window state while polling is paused).
      if (ps.status === "maintenance" && ps.maintenanceSuppressChildren !== false) {
        return false;
      }
      if (!ps.monitored) {
        // Transparent — recurse to grandparents. No grandparents = "ok"
        // (we have no monitored ancestor that says otherwise). Ignored
        // standbys are filtered here too so a mid-chain unmonitored switch
        // whose only other parent is the standby doesn't inherit the
        // always-ok veto the top-level filter removed.
        const grand = (parentsByChild.get(parentId) ?? []).filter(g => !isIgnoredStandby(g));
        if (grand.length === 0) return true;
        return grand.some(g => isParentOk(g));
      }
      // Monitored: ok iff back AND not suppressed. Entering asks one question
      // ("is this parent confirmed down?"); LEAVING asks the opposite one and
      // answers it from a whitelist — the parent has to be genuinely back, not
      // merely not-yet-condemned (see the hysteresis note above). `s` is the
      // child under evaluation; the same rule applies through the transparent
      // walk, since an unmonitored mid-chain switch is only as recovered as its
      // own parent.
      const notBack = s.currentlySuppressed
        ? !RELEASES_SUPPRESSION.has(ps.monitorStatus ?? "unknown")
        : ps.monitorStatus === "down";
      const okStatus = !notBack;
      const suppressed = result.get(parentId) ?? false;
      return okStatus && !suppressed;
    }

    const anyParentOk = parents.some(p => isParentOk(p));
    result.set(s.id, !anyParentOk);
  }

  return result;
}

// ─── DB-bound recompute ─────────────────────────────────────────────────────

/**
 * Rebuild the persisted dependency DAG from current discovery signals.
 *
 * - Reads every Fortinet infra asset (firewall / switch / access_point);
 *   when `integrationId` is supplied, only that integration's assets are
 *   in scope (used by the per-discovery-cycle hook).
 * - Computes parent edges from controller signals + interface topology +
 *   LLDP, prunes via BFS layer assignment.
 * - Replaces the `source="computed"` rows for the in-scope assets in one
 *   transaction. `source="override"` rows are never touched.
 * - Updates `Asset.dependencyLayer` for every in-scope asset.
 *
 * Idempotent — running it twice in a row produces the same DB state.
 */
export async function recomputeDependencyTree(integrationId?: string): Promise<{
  scoped: number;
  edgesWritten: number;
  unresolved: number;
  /** Endpoint-half edges currently persisted (see syncEndpointDependencyEdges). */
  endpointEdges: number;
}> {
  // Always pull the global Fortinet inventory. Even when `integrationId`
  // narrows the scope, parent edges may cross integration boundaries (e.g.
  // a FortiSwitch managed by integration A whose controller FG was
  // discovered by integration B). The "scope" governs which assets get
  // their computed rows replaced and `dependencyLayer` rewritten — not the
  // graph we walk.
  const inventory = await prisma.asset.findMany({
    where: {
      assetType: { in: [...FORTINET_INFRA_ASSET_TYPES] },
    },
    select: {
      id: true,
      hostname: true,
      serialNumber: true,
      assetType: true,
      status: true,
      fortinetTopology: true,
      discoveredByIntegrationId: true,
    },
  });
  if (inventory.length === 0) return { scoped: 0, edgesWritten: 0, unresolved: 0, endpointEdges: 0 };

  // Scope is deliberately computed over the FULL inventory while the GRAPH is
  // built only from retired-status-free assets. Keeping a decommissioned asset
  // in scope is what lets the transaction below DELETE its computed rows and
  // null its layer; dropping it from the graph is what stops it being anyone's
  // parent. Filtering the read itself would do only the second, leaving a
  // retired switch's own stale parent rows behind forever, since nothing would
  // ever bring it back into scope.
  const inScope = integrationId
    ? new Set(inventory.filter(a => a.discoveredByIntegrationId === integrationId).map(a => a.id))
    : new Set(inventory.map(a => a.id));

  // A decommissioned or disabled device is GONE — it must not be a parent.
  // Rule 10 forces `monitored=false` on both statuses, and `evaluateSuppression`
  // treats an unmonitored parent as TRANSPARENT: it walks up to the
  // grandparents and, finding none, returns "ok". A firewall is layer 1 and has
  // no parents, so a decommissioned gate is a permanent ok vote that vetoes
  // suppression for every child still pointing at it — and unlike a live gate
  // it can never go down again, so the veto never lifts. A switch behind a
  // replaced gate would sit at plain Down forever instead of Dep. Down.
  // Same statuses the endpoint half already excludes, via the same constant.
  //
  // Note `storage` and `quarantined` are deliberately NOT dropped: rule 10 made
  // them unmonitorable too, but they describe a device that is still present
  // and still the controller, and quarantine is reversible — retiring the
  // subtree on a quarantine would rebuild it on release. They inherit the same
  // transparent-parent "ok" vote, which is a real gap, but the answer there is
  // in evaluateSuppression rather than in what the graph contains.
  const active = inventory.filter(
    a => !(EXCLUDED_LIFECYCLE_STATUSES as readonly string[]).includes(a.status),
  );
  if (active.length < inventory.length) {
    logger.debug(
      { event: "dependency.retired_excluded", excluded: inventory.length - active.length },
      "Excluded retired-status infra assets from the dependency graph",
    );
  }

  const depAssets: DepAsset[] = active.map(a => ({
    id:               a.id,
    hostname:         a.hostname,
    serialNumber:     a.serialNumber,
    assetType:        a.assetType,
    fortinetTopology: a.fortinetTopology,
  }));

  // Interface edges via the existing inferrer (operates on latest interface samples).
  const ifResult = await inferInterfaceTopology(active.map(a => a.id));
  const interfaceEdges: DepInterfaceEdge[] = ifResult.edges.map(e => ({
    sourceAssetId: e.sourceAssetId,
    targetAssetId: e.targetAssetId,
  }));

  // LLDP edges — only neighbors that resolved to a Polaris asset count for
  // dependency purposes, and only rows fresh enough to still describe the
  // cabling (see filterFreshLldpRows: the table's 48h stickiness is a display
  // grace, not a topology one).
  const lldpRowsRaw = await prisma.assetLldpNeighbor.findMany({
    where: {
      assetId: { in: active.map(a => a.id) },
      matchedAssetId: { not: null },
    },
    select: { assetId: true, matchedAssetId: true, lastSeen: true, source: true },
  });
  const lldpRows = filterFreshLldpRows(lldpRowsRaw);
  if (lldpRows.length < lldpRowsRaw.length) {
    logger.debug(
      { event: "dependency.lldp.stale_dropped", dropped: lldpRowsRaw.length - lldpRows.length },
      "Ignored stale LLDP neighbor rows when building dependency edges",
    );
  }
  const lldpEdges: DepLldpEdge[] = lldpRows
    .filter((r): r is typeof r & { matchedAssetId: string } => !!r.matchedAssetId)
    .map(r => ({ assetId: r.assetId, matchedAssetId: r.matchedAssetId }));

  // Mesh edges — a leaf AP appears as a matched wireless station on its root
  // AP. Both sides must be APs. This is the authoritative uplink for a mesh
  // leaf (overrides the wrong switch/FG controller edge discovery resolved).
  const meshRows = await prisma.assetWirelessStation.findMany({
    where: {
      matchedAssetId: { not: null },
      apAsset:      { assetType: "access_point" },
      matchedAsset: { assetType: "access_point" },
    },
    select: { apAssetId: true, matchedAssetId: true },
  });
  const meshEdges: DepMeshEdge[] = meshRows
    .filter((r): r is { apAssetId: string; matchedAssetId: string } => !!r.matchedAssetId)
    .map(r => ({ rootApId: r.apAssetId, leafApId: r.matchedAssetId }));

  // Bridge leaves — a FortiLink switch physically behind a FortiAP shows up as
  // an LLDP neighbor of that AP (the inverse of a normal switch→AP uplink). A
  // switch on either side of an AP↔switch LLDP adjacency, where the switch is
  // NOT that AP's controller parent, is bridged behind the AP → its FortiLink
  // edge is suppressed so it depends on the AP via LLDP.
  const invById = new Map(active.map(a => [a.id, a]));
  const apParentSwitchOf = (a: typeof inventory[number]) =>
    readParentSwitchStamp(a.fortinetTopology).name ?? null;
  /**
   * Does `sw` match the name the AP stamped as its parentSwitch? The stamp comes
   * from the AP's LLDP table, which reports the switch's system name — normally
   * the switch-id (= the serial), while `Asset.hostname` may be an operator-set
   * label. Comparing against hostname ALONE mis-fires in the dangerous
   * direction: the AP's real uplink switch fails the check, gets treated as
   * "bridged behind the AP", and has its FortiLink edge to the FortiGate
   * replaced by an edge to the AP — inverting the topology instead of merely
   * dropping it. Match either identity.
   */
  const switchMatchesParentStamp = (sw: typeof inventory[number], stampName: string | null) => {
    if (!stampName) return false;
    const n = normalizeNameKey(stampName);
    if (sw.hostname && normalizeNameKey(sw.hostname) === n) return true;
    const s = normalizeSerialKey(sw.serialNumber);
    return !!s && s === normalizeSerialKey(stampName);
  };
  const apIsMeshLeaf = (a: typeof inventory[number]) => {
    const t = a.fortinetTopology as Record<string, unknown> | null;
    return !!t && t.meshUplink === "mesh";
  };
  const bridgeLeafSwitchIds = new Set<string>();
  for (const e of lldpEdges) {
    const a = invById.get(e.assetId);
    const b = invById.get(e.matchedAssetId);
    if (!a || !b) continue;
    let ap: typeof inventory[number] | undefined;
    let sw: typeof inventory[number] | undefined;
    if (a.assetType === "access_point" && b.assetType === "switch") { ap = a; sw = b; }
    else if (b.assetType === "access_point" && a.assetType === "switch") { ap = b; sw = a; }
    if (!ap || !sw) continue;
    // Normal switch→AP uplink — unless the AP is a wireless-mesh leaf, whose
    // wired LLDP adjacency is always a switch bridged behind it (parentSwitch
    // on a mesh leaf is the pre-mesh-fix inversion, not a real uplink).
    if (!apIsMeshLeaf(ap) && switchMatchesParentStamp(sw, apParentSwitchOf(ap))) continue;
    bridgeLeafSwitchIds.add(sw.id);
  }

  // Build, layer, prune.
  const candidateEdges = buildDependencyEdgesFromInputs(depAssets, interfaceEdges, lldpEdges, meshEdges, bridgeLeafSwitchIds);
  const { layers, keptEdges, unresolved } = assignLayers(depAssets, candidateEdges);

  // Restrict the writeback to in-scope assets. An out-of-scope asset's
  // computed rows are NOT touched here; another integration's recompute
  // run owns those.
  const scopedKept = keptEdges.filter(e => inScope.has(e.childAssetId));

  // Single transaction: delete computed rows for in-scope children,
  // re-insert from kept edges, and update each in-scope asset's layer.
  await prisma.$transaction(async tx => {
    if (inScope.size > 0) {
      await tx.assetDependencyParent.deleteMany({
        where: {
          source:  "computed",
          assetId: { in: [...inScope] },
        },
      });
    }
    if (scopedKept.length > 0) {
      // createMany skipDuplicates handles cases where override rows pin
      // the same (child, parent) pair as the computed signal.
      await tx.assetDependencyParent.createMany({
        data: scopedKept.map(e => ({
          assetId:       e.childAssetId,
          parentAssetId: e.parentAssetId,
          source:        "computed",
          detectedVia:   e.detectedVia,
        })),
        skipDuplicates: true,
      });
    }
    // Layer update — all in-scope assets, even ones with no edges (those
    // get null layer, e.g. an isolated firewall whose hostname doesn't
    // match any switch's controllerFortigate gets layer 1; an orphan
    // switch with no resolvable parent gets null).
    //
    // Bucket in-scope assets by their resolved layer value (including null)
    // and issue ONE updateMany per distinct layer. The dependency DAG only
    // grows a handful of layers deep on real fleets — firewall (1), direct
    // switches/APs (2), chained switches (3), the occasional 4 — so this
    // collapses ~1800 sequential per-row UPDATEs into 4–6 set-based ones.
    // The previous per-asset `await tx.asset.update` loop was the dominant
    // cost of Phase 12 finalize on large fleets (~minute on 1.8k assets).
    const byLayer = new Map<number | null, string[]>();
    for (const a of inventory) {
      if (!inScope.has(a.id)) continue;
      const layer = layers.get(a.id) ?? null;
      const list = byLayer.get(layer);
      if (list) list.push(a.id);
      else byLayer.set(layer, [a.id]);
    }
    for (const [layer, ids] of byLayer) {
      await tx.asset.updateMany({
        where: { id: { in: ids } },
        data:  { dependencyLayer: layer },
      });
    }
  });

  // Endpoint half. Deliberately NOT narrowed by `integrationId`: an endpoint's
  // upstream device is resolved from its own columns against the GLOBAL infra
  // inventory, so the answer doesn't depend on which integration triggered the
  // run — and most endpoints belong to an AD / Entra / vCenter integration that
  // never calls this at all, so a scoped pass would leave them permanently
  // unparented. Writes are diffed rather than delete-replaced, which keeps two
  // integrations finalizing at once from churning each other's rows.
  let endpointEdges = 0;
  try {
    const ep = await syncEndpointDependencyEdges(depAssets, layers);
    endpointEdges = ep.edges;
    if (ep.added > 0 || ep.removed > 0 || ep.retyped > 0) {
      logger.debug(
        { event: "dependency.endpoints", ...ep },
        "Refreshed endpoint dependency edges",
      );
    }
  } catch (err: any) {
    // Never let the endpoint half fail the infra recompute — the infra tree is
    // the part discovery's callers report on, and this pass is idempotent so
    // the next cycle retries.
    logger.warn(
      { event: "dependency.endpoints.failed", err: err?.message ?? String(err) },
      "Endpoint dependency-edge refresh failed (next recompute retries)",
    );
  }

  logger.debug(
    {
      event:        "dependency.recompute",
      integrationId: integrationId ?? null,
      scoped:        inScope.size,
      edgesWritten:  scopedKept.length,
      unresolved:    unresolved.length,
      endpointEdges,
    },
    "Recomputed dependency tree",
  );

  return {
    scoped:       inScope.size,
    edgesWritten: scopedKept.length,
    unresolved:   unresolved.length,
    endpointEdges,
  };
}

// ─── Endpoint-half writeback ────────────────────────────────────────────────

/** Chunk ids so no statement carries a pathological IN list. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The owning FortiGate for each of these endpoints' addresses, per IPAM —
 * the last-resort parent tier.
 *
 * Two gates on the way in, both borrowed rather than restated:
 *
 *   - **The address claim must be current** (`claimIsFresh`, rule 40's model).
 *     A recycled DHCP address is exactly how this tier goes wrong: a laptop
 *     that left a site three weeks ago still records 10.1.1.50, and without
 *     the freshness gate it would be parented to whichever gate serves
 *     10.1.1.0/24 today — suppressing its alerts behind a device it has no
 *     relationship with. Operator-owned claims never expire; a discovered one
 *     must have been re-asserted within `CLAIM_FRESH_DAYS`.
 *   - **The gate comes from `resolveOwningGateContexts`**, which applies rule
 *     41's chassis-serial-then-FMG-device-name precedence. Never a hostname
 *     match, and never re-implemented here — one resolver, three consumers.
 *
 * An address in no known network, or one whose owning gate Polaris holds no
 * Asset row for, is simply absent: no parent, alerting unchanged, the safe
 * direction this whole half defaults to.
 */
async function resolveIpamGatesForEndpoints(assetIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (assetIds.length === 0) return out;

  const claims: MaclessClaimRow[] = [];
  for (const ids of chunk(assetIds, 500)) {
    const rows = await prisma.$queryRaw<MaclessClaimRow[]>`
      SELECT a.id, a.hostname, a."ipAddress" AS ip, a."ipSource", a."ipOverride",
             a."lastSeen", h."lastSeen" AS "ipLastSeen",
             a."lastSeenSwitch", a."lastSeenAp"
      FROM assets a
      LEFT JOIN asset_ip_history h ON h."assetId" = a.id AND h.ip = a."ipAddress"
      WHERE a.id = ANY(${ids}::text[])
        AND a."ipAddress" IS NOT NULL
        AND a."ipAddress" <> ''
    `;
    claims.push(...rows);
  }

  const cutoff = new Date(Date.now() - CLAIM_FRESH_DAYS * 86_400_000);
  const fresh = claims.filter(r => claimIsFresh(r, cutoff));
  if (fresh.length === 0) return out;

  const gates = await resolveOwningGateContexts([...new Set(fresh.map(r => r.ip))]);
  for (const r of fresh) {
    const gate = gates.get(r.ip)?.gateAssetId;
    if (gate) out.set(r.id, gate);
  }
  return out;
}

/**
 * Refresh every `source="endpoint"` row from the current endpoint columns.
 *
 * Fleet-wide but cheap: four reads, then a DIFF (insert missing / delete gone /
 * update a changed `detectedVia`) instead of the infra half's delete-replace.
 * At 2000 assets a delete-replace on every discovery finalize would rewrite the
 * whole table several times an hour, and these rows change only when a device
 * moves ports — dead-tuple churn the capacity advisor would then report on.
 *
 * `Asset.dependencyLayer` is stamped to parent-layer + 1 (null when the parent
 * itself is unlayered) so the asset-details tree can print the endpoint's level.
 */
export async function syncEndpointDependencyEdges(
  infra: DepAsset[],
  layers: Map<string, number>,
): Promise<{ endpoints: number; edges: number; added: number; removed: number; retyped: number }> {
  const endpointRows = await prisma.asset.findMany({
    where: {
      assetType: { notIn: [...FORTINET_INFRA_ASSET_TYPES] },
      status:    { notIn: EXCLUDED_LIFECYCLE_STATUSES },
    },
    select: { id: true, lastSeenSwitch: true, lastSeenAp: true, dependencyLayer: true },
  });
  const endpointIds = new Set(endpointRows.map(r => r.id));

  // Every sighting, filtered in memory rather than through a 2000-element IN
  // (the table is bounded by assets × gates-that-saw-them, and infra rows are a
  // rounding error on top).
  const sightings = await prisma.assetFortigateSighting.findMany({
    select: { assetId: true, fortigateDevice: true, lastSeen: true },
  });
  const sightedByAsset = new Map<string, Array<{ device: string; at: number }>>();
  for (const s of sightings) {
    if (!endpointIds.has(s.assetId)) continue;
    const device = (s.fortigateDevice ?? "").trim();
    if (!device) continue;
    const list = sightedByAsset.get(s.assetId);
    const entry = { device, at: s.lastSeen ? s.lastSeen.getTime() : 0 };
    if (list) list.push(entry);
    else sightedByAsset.set(s.assetId, [entry]);
  }

  // An asset already parented by the hypervisor it runs on keeps that edge and
  // gets none of ours. The VM's network path IS its host, so the placement edge
  // is the more specific truth — and unioning the two would break the existing
  // vCenter behavior under all-down semantics (host down + switch up would stop
  // suppressing).
  const vcenterParented = new Set(
    (await prisma.assetDependencyParent.findMany({
      where:  { source: "vcenter" },
      select: { assetId: true },
    })).map(r => r.assetId),
  );

  const endpoints: DepEndpoint[] = [];
  for (const r of endpointRows) {
    if (vcenterParented.has(r.id)) continue;
    const sighted = (sightedByAsset.get(r.id) ?? [])
      .sort((a, b) => b.at - a.at)
      .flatMap(s => {
        // Try the stored value, then its bare form — `fortigateDevice` should
        // already be bare, but a prefixed "<integration>:<gate>" row must not
        // silently resolve to nothing. Raw first so a gate whose real name
        // contains a colon still matches itself.
        const bare = bareFortinetDeviceName(s.device);
        return bare && bare !== s.device ? [s.device, bare] : [s.device];
      });
    endpoints.push({
      id:                r.id,
      lastSeenSwitch:    r.lastSeenSwitch,
      lastSeenAp:        r.lastSeenAp,
      sightedFortigates: [...new Set(sighted)],
      ipamGateAssetId:   null,
    });
  }

  // The IPAM tier, resolved ONLY for the endpoints the three observed tiers
  // could not place. Two passes rather than resolving every endpoint's address
  // up front: at 2000 assets the placed majority would otherwise pay for a
  // containment query and a fleet-wide firewall load they never consult, and
  // the unplaced set is the small tail this tier exists for. Set-based — one
  // claim query and one gate resolution for the whole tail, no per-asset await.
  const index = buildInfraParentIndex(infra);
  const unplaced = endpoints.filter(e => !resolveEndpointParent(index, e));
  if (unplaced.length > 0) {
    const gateByAsset = await resolveIpamGatesForEndpoints(unplaced.map(e => e.id));
    for (const e of unplaced) e.ipamGateAssetId = gateByAsset.get(e.id) ?? null;
  }

  const desiredEdges = buildEndpointDependencyEdges(endpoints, infra);
  const desiredByKey = new Map<string, DependencyEdge>();
  for (const e of desiredEdges) desiredByKey.set(`${e.childAssetId}|${e.parentAssetId}`, e);

  const existing = await prisma.assetDependencyParent.findMany({
    where:  { source: ENDPOINT_DEPENDENCY_SOURCE },
    select: { id: true, assetId: true, parentAssetId: true, detectedVia: true },
  });

  const staleIds: string[] = [];
  const retypeByVia = new Map<string, string[]>();
  const keptKeys = new Set<string>();
  for (const row of existing) {
    const key = `${row.assetId}|${row.parentAssetId}`;
    const want = desiredByKey.get(key);
    if (!want || keptKeys.has(key)) {
      staleIds.push(row.id);
      continue;
    }
    keptKeys.add(key);
    if (row.detectedVia !== want.detectedVia) {
      const list = retypeByVia.get(want.detectedVia);
      if (list) list.push(row.id);
      else retypeByVia.set(want.detectedVia, [row.id]);
    }
  }
  const toInsert = [...desiredByKey.entries()].filter(([key]) => !keptKeys.has(key)).map(([, e]) => e);

  // Layer stamp — only where it actually differs, so a steady fleet writes zero
  // rows here.
  const desiredLayerById = new Map<string, number | null>();
  for (const r of endpointRows) desiredLayerById.set(r.id, null);
  for (const e of desiredEdges) {
    const parentLayer = layers.get(e.parentAssetId);
    desiredLayerById.set(e.childAssetId, parentLayer == null ? null : parentLayer + 1);
  }
  const layerBuckets = new Map<number | null, string[]>();
  for (const r of endpointRows) {
    const want = desiredLayerById.get(r.id) ?? null;
    if (want === r.dependencyLayer) continue;
    const list = layerBuckets.get(want);
    if (list) list.push(r.id);
    else layerBuckets.set(want, [r.id]);
  }

  await prisma.$transaction(async tx => {
    for (const ids of chunk(staleIds, 500)) {
      await tx.assetDependencyParent.deleteMany({ where: { id: { in: ids } } });
    }
    for (const batch of chunk(toInsert, 1000)) {
      await tx.assetDependencyParent.createMany({
        data: batch.map(e => ({
          assetId:       e.childAssetId,
          parentAssetId: e.parentAssetId,
          source:        ENDPOINT_DEPENDENCY_SOURCE,
          detectedVia:   e.detectedVia,
        })),
        skipDuplicates: true,
      });
    }
    for (const [via, ids] of retypeByVia) {
      for (const batch of chunk(ids, 500)) {
        await tx.assetDependencyParent.updateMany({ where: { id: { in: batch } }, data: { detectedVia: via } });
      }
    }
    for (const [layer, ids] of layerBuckets) {
      for (const batch of chunk(ids, 500)) {
        // The "don't rewrite what already matches" guard has to spell out the
        // NULL case: `dependencyLayer <> 3` is NULL — not true — for a row whose
        // layer is NULL, so a bare `not` silently skips every endpoint that has
        // never been layered, which is all of them on the first run.
        await tx.asset.updateMany({
          where: {
            id: { in: batch },
            ...(layer === null
              ? { dependencyLayer: { not: null } }
              : { OR: [{ dependencyLayer: null }, { dependencyLayer: { not: layer } }] }),
          },
          data: { dependencyLayer: layer },
        });
      }
    }
  });

  return {
    endpoints: endpoints.length,
    edges:     desiredByKey.size,
    added:     toInsert.length,
    removed:   staleIds.length,
    retyped:   [...retypeByVia.values()].reduce((n, l) => n + l.length, 0),
  };
}

// ─── DB-bound reconcile ─────────────────────────────────────────────────────

/**
 * Resolve effective parents per asset. Override rows take precedence; if
 * any source="override" row exists for a child, the computed set is
 * ignored. An empty override set = explicit "no parents" pin (asset opts
 * out of suppression entirely).
 */
async function loadEffectiveParents(): Promise<Map<string, string[]>> {
  const rows = await prisma.assetDependencyParent.findMany({
    select: { assetId: true, parentAssetId: true, source: true },
  });
  const overridesByChild = new Map<string, string[]>();
  const computedByChild  = new Map<string, string[]>();
  for (const r of rows) {
    const target = r.source === "override" ? overridesByChild : computedByChild;
    const cur = target.get(r.assetId);
    if (cur) cur.push(r.parentAssetId);
    else target.set(r.assetId, [r.parentAssetId]);
  }
  // Children that have ANY override row → use override set (possibly empty
  // — explicit pin requires us to also carry an empty marker; we get this
  // by adding the assetId to the result map even when its override set
  // happens to be empty, but createMany of an empty array can't reach
  // here since we only iterate rows we found). So: any child with at
  // least one override row gets the override set; everyone else gets the
  // computed set.
  const result = new Map<string, string[]>();
  for (const [child, parents] of computedByChild) result.set(child, parents);
  for (const [child, parents] of overridesByChild) result.set(child, parents);
  return result;
}

/**
 * 60s reconciler — source of truth for `dependencySuppressed`.
 *
 * Loads every monitored asset, evaluates desired suppression state under
 * "all-down" multi-parent semantics, writes only diffs, and emits
 * `monitor.dependency_suppressed` / `monitor.dependency_resumed` events
 * for transitions.
 */
export async function reconcileDependencySuppression(): Promise<{
  evaluated: number;
  changed:   number;
}> {
  // Auto-expire any "Dependency Test" overlays whose deadline has passed
  // BEFORE we read the suppression state — this way the read sees the
  // freshly-cleared rows and the reconciler ends the test session in the
  // same tick that detects expiry. Each cleared asset writes one audit
  // Event so admins see when a test ended without explicit cleanup.
  const now0 = new Date();
  const expired = await prisma.asset.findMany({
    where: { dependencyTestUntil: { lte: now0 } },
    select: { id: true, hostname: true, dependencyTestStartedBy: true, dependencyTestUntil: true },
  });
  if (expired.length > 0) {
    await prisma.asset.updateMany({
      where: { id: { in: expired.map(e => e.id) } },
      data:  { dependencyTestUntil: null, dependencyTestStartedBy: null },
    });
    await logEventsBatch(expired.map((e) => ({
      action:       "asset.dependency_test.expired",
      resourceType: "asset",
      resourceId:   e.id,
      resourceName: e.hostname ?? undefined,
      level:        "info" as const,
      message:      `Dependency Test expired on ${e.hostname ?? e.id} (started by ${e.dependencyTestStartedBy ?? "unknown"})`,
      details:      { dependencyTestUntil: e.dependencyTestUntil, startedBy: e.dependencyTestStartedBy },
    })));
  }

  const assets = await prisma.asset.findMany({
    select: {
      id: true,
      hostname: true,
      assetType: true,
      monitored: true,
      monitorStatus: true,
      status: true,
      dependencyLayer: true,
      dependencySuppressed: true,
      dependencyTestUntil: true,
    },
  });
  if (assets.length === 0) return { evaluated: 0, changed: 0 };

  const parentsByChild = await loadEffectiveParents();

  // HA standby firewalls — unmonitored standbys are ignored as parents (see
  // SuppressionAssetState.isHaStandby). Narrow JSON-path query instead of
  // adding fortinetTopology to the fleet-wide select above: this runs every
  // 60s and firewalls are a tiny slice of a 2000-asset fleet.
  const standbyRows = await prisma.asset.findMany({
    where: {
      assetType: "firewall",
      fortinetTopology: { path: ["haRole"], equals: "secondary" },
    },
    select: { id: true },
  });
  const standbyIds = new Set(standbyRows.map(r => r.id));

  // Per-asset "mark dependents down" resolution for in-maintenance assets:
  // OR across the asset's OPEN windows' schedules (any suppressing window
  // suppresses). A window whose schedule was deleted (scheduleId SetNull,
  // open only until the next maintenance reconcile closes it) counts as
  // suppressing — the conservative launch default. Open-window counts are
  // tiny relative to the fleet, so this is one cheap query per pass.
  const maintenanceSuppress = new Map<string, boolean>();
  const openWindows = await prisma.assetMaintenanceWindow.findMany({
    where: { endedAt: null },
    select: { assetId: true, schedule: { select: { suppressChildren: true } } },
  });
  for (const w of openWindows) {
    const suppresses = w.schedule?.suppressChildren !== false;
    maintenanceSuppress.set(w.assetId, (maintenanceSuppress.get(w.assetId) ?? false) || suppresses);
  }

  const states: SuppressionAssetState[] = assets.map(a => ({
    id:                  a.id,
    layer:               a.dependencyLayer,
    monitored:           a.monitored,
    monitorStatus:       a.monitorStatus,
    status:              a.status,
    // Default true covers an operator-set manual "maintenance" status with
    // no window rows — that keeps behaving like the launch semantics.
    maintenanceSuppressChildren: maintenanceSuppress.get(a.id) ?? true,
    currentlySuppressed: a.dependencySuppressed,
    dependencyTestUntil: a.dependencyTestUntil,
    isHaStandby:         standbyIds.has(a.id),
  }));

  const desired = evaluateSuppression(states, parentsByChild);

  // Compute diffs and apply. Write each transition + emit one event per
  // changed monitored asset (un-monitored assets don't emit events —
  // operators don't care about dependency state on un-watched gear).
  const now = new Date();
  let changed = 0;
  type Transition = { id: string; hostname: string | null; from: boolean; to: boolean; layer: number | null; parentIds: string[] };
  const transitions: Transition[] = [];
  for (const a of assets) {
    const next = desired.get(a.id) ?? false;
    if (next === a.dependencySuppressed) continue;
    transitions.push({
      id:        a.id,
      hostname:  a.hostname,
      from:      a.dependencySuppressed,
      to:        next,
      layer:     a.dependencyLayer,
      parentIds: parentsByChild.get(a.id) ?? [],
    });
    changed++;
  }

  if (transitions.length === 0) return { evaluated: assets.length, changed: 0 };

  // Hostname lookup for the event payload — one extra in-memory pass.
  const hostnameById = new Map<string, string | null>();
  for (const a of assets) hostnameById.set(a.id, a.hostname);

  // Two bucketed updateMany calls instead of a per-row update loop: this
  // runs inside the 60s reconciler tick, and a broad outage can flip
  // hundreds of assets in one pass (per-row updates at 2000 monitored
  // assets would hold the transaction open across N round-trips).
  const suppressIds = transitions.filter((t) => t.to).map((t) => t.id);
  const resumeIds   = transitions.filter((t) => !t.to).map((t) => t.id);
  await prisma.$transaction([
    ...(suppressIds.length ? [prisma.asset.updateMany({
      where: { id: { in: suppressIds } },
      data:  { dependencySuppressed: true, dependencySuppressedAt: now },
    })] : []),
    ...(resumeIds.length ? [prisma.asset.updateMany({
      where: { id: { in: resumeIds } },
      data:  { dependencySuppressed: false, dependencySuppressedAt: null },
    })] : []),
  ]);

  // Events fire AFTER the DB write so anyone reading on the back of the
  // event sees the new state. Only emit for monitored assets. One awaited
  // batch (vs. the fire-and-forget pattern used elsewhere) so that when the
  // reconciler returns its caller can rely on the audit rows being durable —
  // a core switch going dark flips its whole subtree in one pass, and the
  // per-transition awaited create this replaces serialized hundreds of
  // inserts inside the 60s tick.
  const monitoredIds = new Set<string>();
  for (const a of assets) if (a.monitored) monitoredIds.add(a.id);
  await logEventsBatch(transitions.filter((t) => monitoredIds.has(t.id)).map((t) => {
    const parentHostnames = t.parentIds.map(id => hostnameById.get(id) ?? id);
    return t.to
      ? {
          action:       "monitor.dependency_suppressed",
          resourceType: "asset",
          resourceId:   t.id,
          resourceName: t.hostname ?? undefined,
          level:        "info" as const,
          message:      `Monitor: ${t.hostname ?? t.id} suppressed (parent ${parentHostnames.join(", ") || "—"} down)`,
          details: {
            layer:           t.layer,
            parentAssetIds:  t.parentIds,
            parentHostnames,
          },
        }
      : {
          action:       "monitor.dependency_resumed",
          resourceType: "asset",
          resourceId:   t.id,
          resourceName: t.hostname ?? undefined,
          level:        "info" as const,
          message:      `Monitor: ${t.hostname ?? t.id} resumed (dependency cleared)`,
          details: {
            layer:           t.layer,
            parentAssetIds:  t.parentIds,
            parentHostnames,
          },
        };
  }));

  return { evaluated: assets.length, changed };
}

/**
 * Latency-optimization hook fired from `recordProbeResult` after a
 * `monitor.status_changed` Event lands. Cheaper than a full reconciler
 * tick since we only re-evaluate the changed asset's transitive
 * descendants — the rest of the fleet's effective state hasn't moved.
 *
 * Best-effort. The 60s reconciler is the source of truth and will catch
 * anything this hook misses (server restart mid-transition, race, etc.).
 */
export async function propagateAfterStatusChange(_assetId: string): Promise<void> {
  try {
    await reconcileDependencySuppression();
  } catch (err: any) {
    logger.warn(
      { event: "dependency.propagate.failed", err: err?.message ?? String(err) },
      "propagateAfterStatusChange failed (reconciler will catch on next tick)",
    );
  }
}
