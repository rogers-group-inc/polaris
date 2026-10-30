/**
 * src/services/interfaceTopologyService.ts
 *
 * Inter-Fortinet topology inference from interface naming conventions.
 *
 * When FortiOS auto-builds a peer aggregate (FortiLink trunks between
 * managed FortiSwitches and their controller FortiGate, or between
 * stacked / MCLAG-paired FortiSwitches), it stamps the aggregate's
 * interface name with the peer device's serial fragment — a stronger
 * signal than LLDP because it's CMDB-stamped on the local device, not
 * inferred from optional peer-side LLDP TLVs that branch FortiGates
 * sometimes filter or fail to expose.
 *
 * Operators occasionally hand-build aggregates (true MCLAG between two
 * peer-stacks at distinct serials) and name them after the peer device's
 * hostname instead. Those are caught by the hostname-match fallback.
 *
 * No new discovery queries — this service reads the most recent
 * `AssetInterfaceSample` rows already collected by the monitoring
 * pipeline, parses interface names through `fortinetSerialPattern`, and
 * resolves matches against the in-memory Fortinet asset inventory.
 */

import { prisma } from "../db.js";
import { EXCLUDED_LIFECYCLE_STATUSES } from "../utils/assetInvariants.js";
import {
  hostnameMatchesFullPeerInterface,
  hostnameMatchesPeerInterface,
  parseFortinetPeerInterface,
  serialMatchesPeerInterface,
  type ParsedPeerInterface,
} from "../utils/fortinetSerialPattern.js";

export interface InterfaceInferredEdge {
  sourceAssetId: string;
  sourceIfName: string;
  targetAssetId: string;
  /** Target's reciprocal interface name when the inference resolved both
   * directions (each side's interface name encoded the other's identity).
   * Null when only the source side carried a parseable peer-aggregate. */
  targetIfName: string | null;
  matchVia: "serial" | "hostname";
  aggregateIndex: number | null;
}

export interface InterfaceInferredRemote {
  id: string;
  hostname: string | null;
  serialNumber: string | null;
  ipAddress: string | null;
  assetType: string | null;
  manufacturer: string | null;
  model: string | null;
}

export interface InterfaceInferenceResult {
  edges: InterfaceInferredEdge[];
  remoteAssets: Map<string, InterfaceInferredRemote>;
}

/**
 * Staleness bound for topology inference. Preserves the previous 1-hour
 * behaviour: at the default 600s system-info cadence that tolerates ~5 missed
 * scrapes (transient REST hiccups, brief network blips) while still excluding
 * interfaces that have genuinely stopped reporting because the asset is down,
 * decommissioned, or no longer monitored. An edge drawn from a stale reading
 * is wrong data, so this bound is deliberately tighter than the auto-monitor
 * picker's 72h.
 */
const INTERFACE_STALE_MS = 60 * 60 * 1000;

/**
 * Infer inter-Fortinet topology edges from each seed asset's most recent
 * interface scrape.
 *
 * @param seedAssetIds  Assets the topology graph is centered on. Edges
 *                      sourced from any of these whose peer ALSO falls in
 *                      this set are sibling edges; peers outside the set
 *                      are returned in `remoteAssets` (cross-site).
 *
 * Skips:
 *   - interface names that fail the loose pattern (port1, fortilink, etc.)
 *   - serial-match candidates with multiple inventory hits (ambiguous)
 *   - hostname-match candidates with multiple inventory hits (ambiguous)
 *   - self-loops (asset's own serial would match its own truncation)
 */
export async function inferInterfaceTopology(
  seedAssetIds: string[],
): Promise<InterfaceInferenceResult> {
  if (seedAssetIds.length === 0) {
    return { edges: [], remoteAssets: new Map() };
  }

  // Current interfaces for the seed set, from the CURRENT-STATE
  // `AssetInterface` table — one row per (assetId, ifName) by construction, so
  // this is a plain indexed read.
  //
  // It replaces a DISTINCT ON over asset_interface_samples that needed a
  // 1-hour timestamp window purely to stay off the bulk of the hypertable:
  // without the bound it scanned every sample in the active chunk and sorted
  // 6+ GB to keep the latest ~88K (assetId, ifName) pairs — observed at 13.5
  // minutes / 90M rows fetched / 9 GB I/O on the prod box even with the right
  // index chosen. The staleness half of that window is preserved below as a
  // `lastSeen` bound, since drawing a topology edge from a stale reading is
  // wrong data.
  //
  // This read is also strictly MORE correct than the one it replaces. The fast
  // pinned re-walk writes ifType/ifParent as NULL, and DISTINCT ON took the
  // newest row — so on any PINNED aggregate the topology map silently saw
  // nulls and lost that aggregate's physical members. The current-state table
  // is written only by the full pass, which always populates them.
  const staleCutoff = new Date(Date.now() - INTERFACE_STALE_MS);
  const interfaceRows = await prisma.assetInterface.findMany({
    where: { assetId: { in: seedAssetIds }, lastSeen: { gt: staleCutoff } },
    select: { assetId: true, ifName: true, ifType: true, ifParent: true },
  });

  // Aggregate → physical member map. The aggregate name is the inference
  // signal (the peer's serial fragment / hostname is encoded in it) but
  // operators trace cables by physical port, not by the FortiOS-stamped
  // peer-named aggregate label. When the aggregate has exactly one
  // physical member, the cable terminates at a single physical port and
  // we can swap the ifName cleanly. Multi-member aggregates (real LACP
  // bundles) keep the aggregate name as the safe fallback — there's no
  // single "the physical port" to display, and showing a comma-joined
  // list would lie about the strict one-port-per-physical-link model.
  const physicalByParent = new Map<string, string[]>();
  for (const row of interfaceRows) {
    if (row.ifType === "physical" && row.ifParent) {
      const k = `${row.assetId}|${row.ifParent}`;
      const list = physicalByParent.get(k);
      if (list) list.push(row.ifName);
      else physicalByParent.set(k, [row.ifName]);
    }
  }
  const preferPhysical = (assetId: string, ifName: string): string => {
    const members = physicalByParent.get(`${assetId}|${ifName}`);
    return members && members.length === 1 ? members[0] : ifName;
  };

  type Candidate = {
    sourceAssetId: string;
    ifName: string;
    parsed: ParsedPeerInterface;
  };
  const candidates: Candidate[] = [];
  for (const row of interfaceRows) {
    const parsed = parseFortinetPeerInterface(row.ifName);
    if (parsed) {
      candidates.push({ sourceAssetId: row.assetId, ifName: row.ifName, parsed });
    }
  }
  if (candidates.length === 0) {
    return { edges: [], remoteAssets: new Map() };
  }

  // Pull every Fortinet infrastructure asset's identity once. Inventory
  // is small (hundreds at most) so an in-memory scan per candidate is
  // cheaper than per-candidate SQL. Decommissioned / disabled assets are not
  // candidates: a retired device keeps its hostname and serial, so it would
  // otherwise win a match nothing live contests and be drawn as a peer.
  const inventory = await prisma.asset.findMany({
    where: {
      assetType: { in: ["firewall", "switch", "access_point"] },
      status: { notIn: EXCLUDED_LIFECYCLE_STATUSES },
    },
    select: {
      id: true,
      hostname: true,
      serialNumber: true,
      ipAddress: true,
      assetType: true,
      manufacturer: true,
      model: true,
    },
  });

  type Inv = (typeof inventory)[number];

  const seedSet = new Set(seedAssetIds);
  const remoteAssets = new Map<string, InterfaceInferredRemote>();

  // Walk all candidates first and bucket every (sourceAssetId, targetAssetId)
  // pair we resolve. Both peers usually have a parseable aggregate naming
  // each other — bucketing lets us pick up the reciprocal interface name
  // and stamp it on the edge as `targetIfName`, so the topology graph
  // can render `<sourceIf> ↔ <targetIf>` instead of one side only.
  type DirectedHit = {
    sourceAssetId: string;
    sourceIfName: string;
    targetAssetId: string;
    matched: Inv;
    matchVia: "serial" | "hostname";
    aggregateIndex: number | null;
  };
  const directedHits: DirectedHit[] = [];

  for (const c of candidates) {
    // Try serial match first — FortiOS-auto path, deterministic.
    const serialMatches = inventory.filter((a) =>
      serialMatchesPeerInterface(c.parsed, a.serialNumber),
    );

    let matched: Inv | null = null;
    let matchVia: "serial" | "hostname" = "serial";

    if (serialMatches.length === 1) {
      matched = serialMatches[0];
      matchVia = "serial";
    } else if (serialMatches.length === 0) {
      // Operator-named aggregate — fall back to hostname match. The whole
      // interface name first: `NAME-1` is the device called `NAME-1` even
      // when a `NAME` also exists, which the fragment match would call
      // ambiguous.
      const fullMatches = inventory.filter((a) =>
        hostnameMatchesFullPeerInterface(c.parsed, a.hostname),
      );
      const hostnameMatches = fullMatches.length > 0
        ? fullMatches
        : inventory.filter((a) => hostnameMatchesPeerInterface(c.parsed, a.hostname));
      if (hostnameMatches.length === 1) {
        matched = hostnameMatches[0];
        matchVia = "hostname";
      } else {
        // 0 hits: probably a generic port name we let through the loose
        // pattern (e.g. `8FFTV23000001` with no matching peer in inventory).
        // >1 hits: ambiguous; refuse rather than draw a misleading edge.
        continue;
      }
    } else {
      // >1 serial match — extremely unlikely (would require multiple
      // inventory rows whose serials all end with the same fragment) but
      // skip rather than guess.
      continue;
    }

    if (!matched) continue;
    if (matched.id === c.sourceAssetId) continue;

    directedHits.push({
      sourceAssetId: c.sourceAssetId,
      sourceIfName: c.ifName,
      targetAssetId: matched.id,
      matched,
      matchVia,
      aggregateIndex: c.parsed.aggregateIndex,
    });
  }

  // Index hits by directed (source, target) pair so we can fold reciprocals
  // into a single bidirectional edge.
  const byPair = new Map<string, DirectedHit>();
  for (const h of directedHits) {
    const key = `${h.sourceAssetId}|${h.targetAssetId}`;
    if (!byPair.has(key)) byPair.set(key, h);
  }

  const edges: InterfaceInferredEdge[] = [];
  const emitted = new Set<string>();
  for (const h of directedHits) {
    const k = `${h.sourceAssetId}|${h.targetAssetId}`;
    const reverseKey = `${h.targetAssetId}|${h.sourceAssetId}`;
    if (emitted.has(k) || emitted.has(reverseKey)) continue;
    emitted.add(k);
    const reciprocal = byPair.get(reverseKey) ?? null;
    edges.push({
      sourceAssetId: h.sourceAssetId,
      sourceIfName: preferPhysical(h.sourceAssetId, h.sourceIfName),
      targetAssetId: h.targetAssetId,
      targetIfName: reciprocal
        ? preferPhysical(reciprocal.sourceAssetId, reciprocal.sourceIfName)
        : null,
      matchVia: h.matchVia,
      aggregateIndex: h.aggregateIndex,
    });
    if (!seedSet.has(h.matched.id)) {
      remoteAssets.set(h.matched.id, {
        id: h.matched.id,
        hostname: h.matched.hostname,
        serialNumber: h.matched.serialNumber,
        ipAddress: h.matched.ipAddress,
        assetType: h.matched.assetType,
        manufacturer: h.matched.manufacturer,
        model: h.matched.model,
      });
    }
  }

  return { edges, remoteAssets };
}
