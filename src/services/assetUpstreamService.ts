/**
 * src/services/assetUpstreamService.ts
 *
 * Resolves the three UPSTREAM devices the asset-details General tab names —
 * Last Seen Switch, Last Seen AP, Last Seen Firewall — from the display
 * strings discovery records into the actual Asset rows behind them, so the
 * rows can carry verbs (open the device, open its HTTPS UI, SSH to it) instead
 * of being dead text an operator has to re-find by hand in the Assets list.
 *
 * Four inputs, all of them already written by something else — nothing new is
 * collected:
 *   - `Asset.lastSeenSwitch` — "<switch-id-or-hostname>/<port>"
 *   - `Asset.lastSeenAp`     — the FortiAP's name
 *   - the freshest `AssetFortigateSighting.fortigateDevice` — FortiManager's
 *     DEVICE NAME for the gate, which is under no obligation to match the
 *     gate's own hostname.
 *   - FALLBACK, firewall only: the gate that owns the network the asset's
 *     address sits in, per IPAM (`resolveOwningGateContexts`). Consulted only
 *     when NO gate has ever sighted the device, and reported as
 *     `source: "subnet"` so it can never be read as a sighting: a sighting
 *     records a gate seeing the device, this infers the gate from the address,
 *     and the two are not the same claim. It carries no `lastSeen` for exactly
 *     that reason. `ipContextService.pickNamedGate` makes the opposite
 *     ranking (subnet over sighting) on the Add Asset panel, and deliberately
 *     so — that panel answers "what is at this address today", where the
 *     serving gate is the better answer; this row is labelled "Last Seen", so
 *     evidence outranks inference.
 *
 * That last point is why name resolution goes through
 * `utils/fortinetParentKey.ts` (serial -> the candidate's own FMG device-name
 * stamp -> hostname -> name-as-serial) rather than matching against
 * `Asset.hostname`: matching hostnames alone is the mismatch that silently
 * unparented every switch on this install once, and "no match" is a legitimate
 * state here too — an unadopted switch, a gate another integration hasn't
 * discovered yet, a decommissioned AP. Unresolved is reported as the NAME with
 * no asset, never as an error, and the UI keeps rendering it as plain text.
 *
 * The displayed NAME never changes: the firewall half reports the most recent
 * sighting's device and resolves exactly that one, rather than walking down the
 * list for the first name that happens to match something (which is right for
 * `resolveEndpointParent`, whose job is to find *a* parent — this one annotates
 * a value already on screen).
 *
 * Read-only. Management access rides along per resolved device, reduced through
 * the same `shapeManagementAccessForClient` the Assets list uses.
 */

import { prisma } from "../db.js";
import {
  buildInfraParentIndex,
  parentAssetWhereOr,
  resolveInfraParentAsset,
} from "../utils/fortinetParentKey.js";
import { shapeManagementAccessForClient } from "./fortinetManagementAccessService.js";
import { resolveOwningGateContexts } from "./ipUpstreamChainService.js";

/** The resolved device, shaped for the client's remote-access gating. */
export interface UpstreamAssetRef {
  id: string;
  hostname: string | null;
  ipAddress: string | null;
  assetType: string;
  status: string;
  monitorStatus: string | null;
  managementAccess: { mgmtIp: string | null; protocols: string[] | null; https: boolean; ssh: boolean } | null;
}

/** One upstream row: the name as displayed, plus the asset it resolved to. */
export interface UpstreamEntry {
  /** The device name exactly as the General tab renders it. */
  name: string;
  /** Switch only — the port half of `lastSeenSwitch`, when it carried one. */
  port?: string;
  /** Firewall only — when that sighting was last refreshed. Present for
   *  `source: "sighting"` and never for `"subnet"`, which has no moment. */
  lastSeen?: string;
  /**
   * Firewall only — which of the two answers this is:
   *   `"sighting"` — a gate REPORTED this device (AssetFortigateSighting).
   *   `"subnet"`   — nothing has; this is the gate that owns the network the
   *                  asset's address sits in. An inference about where the
   *                  device must be, not a record of it being seen, so the UI
   *                  labels it and never prints a "last seen" time for it.
   */
  source?: "sighting" | "subnet";
  /** Firewall, `source: "subnet"` only — the network that named the gate. */
  subnetCidr?: string;
  /** Null when the name resolves to no asset (see the module note). */
  asset: UpstreamAssetRef | null;
}

export interface AssetUpstream {
  switch: UpstreamEntry | null;
  ap: UpstreamEntry | null;
  firewall: UpstreamEntry | null;
  /**
   * Which halves were consulted. The firewall half reads
   * `AssetFortigateSighting`, which is gated `assetsQuarantine:read` on its own
   * endpoint — so a caller without it reads "not shown" rather than a
   * confident "no firewall has seen this device" (the /ip-context precedent).
   */
  visibility: {
    firewall: boolean;
    /**
     * Whether the IPAM fallback was allowed to run. The sighting half reads
     * `AssetFortigateSighting` (gated `assetsQuarantine:read`); the fallback
     * reads `Subnet` (gated `subnets:read`) — two different grants, so a
     * caller holding one and not the other must be able to tell "no gate owns
     * this address" from "you weren't shown that half" (the /ip-context
     * precedent).
     */
    subnetGate: boolean;
  };
}

const ASSET_SELECT = {
  id: true,
  hostname: true,
  serialNumber: true,
  assetType: true,
  status: true,
  monitorStatus: true,
  ipAddress: true,
  fortinetTopology: true,
  managementAccess: true,
} as const;

type CandidateRow = {
  id: string;
  hostname: string | null;
  serialNumber: string | null;
  assetType: string;
  status: string;
  monitorStatus: string | null;
  ipAddress: string | null;
  fortinetTopology: unknown;
  managementAccess: unknown;
};

function toRef(row: CandidateRow): UpstreamAssetRef {
  return {
    id: row.id,
    hostname: row.hostname,
    ipAddress: row.ipAddress,
    assetType: row.assetType,
    status: row.status,
    monitorStatus: row.monitorStatus,
    managementAccess: shapeManagementAccessForClient(row.managementAccess),
  };
}

/** The switch half of a `lastSeenSwitch` value, plus the port it carried. */
export function splitLastSeenSwitch(v: string | null | undefined): { name: string; port: string } | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  const slash = t.indexOf("/");
  const name = (slash === -1 ? t : t.slice(0, slash)).trim();
  if (!name) return null;
  return { name, port: slash === -1 ? "" : t.slice(slash + 1).trim() };
}

/**
 * Resolve the upstream switch / AP / firewall for one asset.
 *
 * ONE candidate query for all three names (each branch type-scoped), then the
 * shared precedence per kind — never letting SQL pick among matches, and never
 * a query per row: this runs on a slide-over open, but the same shape would
 * hold if a list surface ever wanted it.
 *
 * Returns null only when the asset itself is gone.
 */
export async function resolveAssetUpstream(
  assetId: string,
  opts: { includeFirewall?: boolean; includeSubnetGate?: boolean } = {},
): Promise<AssetUpstream | null> {
  const includeFirewall = opts.includeFirewall !== false;
  const includeSubnetGate = opts.includeSubnetGate !== false;
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: { id: true, assetType: true, lastSeenSwitch: true, lastSeenAp: true, ipAddress: true },
  });
  if (!asset) return null;

  const sw = splitLastSeenSwitch(asset.lastSeenSwitch);
  const apName = typeof asset.lastSeenAp === "string" ? asset.lastSeenAp.trim() : "";

  // A firewall is the thing doing the sighting, not the thing sighted — the
  // General tab hides all three rows for one, so don't pay for the lookups.
  const wantSighting = includeFirewall && asset.assetType !== "firewall";
  const sighting = wantSighting
    ? await prisma.assetFortigateSighting.findFirst({
        where: { assetId, NOT: { fortigateDevice: "" } },
        orderBy: { lastSeen: "desc" },
        select: { fortigateDevice: true, lastSeen: true },
      })
    : null;
  const fwName = sighting?.fortigateDevice?.trim() || "";

  // No gate has ever reported this device — fall back to the gate that owns
  // the network its address sits in (business rule 55). Strictly a fallback: a sighting is a
  // record of the device being seen, this is an inference from IPAM, and the
  // entry says which it is so the row can never read as evidence it isn't.
  // Skipped for a firewall (same reason the sighting half is) and for an
  // asset with no address to place.
  const ip = typeof asset.ipAddress === "string" ? asset.ipAddress.trim() : "";
  const wantSubnetGate = includeSubnetGate && asset.assetType !== "firewall" && !fwName && !!ip;
  const owning = wantSubnetGate ? (await resolveOwningGateContexts([ip])).get(ip) : undefined;
  const subnetGateAssetId = owning?.gateAssetId ?? null;

  const branches: Array<Record<string, unknown>> = [];
  const pushBranches = (name: string, assetType: string) => {
    const or = parentAssetWhereOr({ name });
    if (or.length > 0) branches.push({ assetType, OR: or });
  };
  if (sw) pushBranches(sw.name, "switch");
  if (apName) pushBranches(apName, "access_point");
  if (fwName) pushBranches(fwName, "firewall");
  // The IPAM answer is already an asset id — it needs no name resolution, just
  // the same row shape, so fetch it in the one candidate query rather than a
  // second round-trip.
  if (subnetGateAssetId) branches.push({ assetType: "firewall", id: subnetGateAssetId });

  const candidates: CandidateRow[] =
    branches.length > 0
      ? ((await prisma.asset.findMany({
          where: { OR: branches, id: { not: assetId } },
          select: ASSET_SELECT,
        })) as CandidateRow[])
      : [];

  // Index per KIND, not one index over everything: `buildInfraParentIndex` is
  // first-writer-wins per key, so a switch and a gate sharing a hostname would
  // let one shadow the other and the type guard would then reject the match.
  const resolve = (name: string, assetType: string): UpstreamAssetRef | null => {
    const pool = candidates.filter((c) => c.assetType === assetType);
    if (pool.length === 0) return null;
    const hit = resolveInfraParentAsset(buildInfraParentIndex(pool), { name }, assetType);
    if (!hit) return null;
    const row = pool.find((c) => c.id === hit.id);
    return row ? toRef(row) : null;
  };

  // The gate owns the network whether or not Polaris holds an Asset row for
  // it, but this row exists to carry verbs — with no row there is no name to
  // print either (the sighting half always has FMG's device name; IPAM gives
  // an id or nothing), so an unresolved gate yields no row at all.
  const subnetGateRow = subnetGateAssetId
    ? candidates.find((c) => c.id === subnetGateAssetId && c.assetType === "firewall")
    : undefined;
  const subnetGate: UpstreamEntry | null = subnetGateRow
    ? {
        name: subnetGateRow.hostname || subnetGateRow.serialNumber || subnetGateRow.id,
        source: "subnet" as const,
        ...(owning?.subnetCidr ? { subnetCidr: owning.subnetCidr } : {}),
        asset: toRef(subnetGateRow),
      }
    : null;

  return {
    switch: sw
      ? { name: sw.name, ...(sw.port ? { port: sw.port } : {}), asset: resolve(sw.name, "switch") }
      : null,
    ap: apName ? { name: apName, asset: resolve(apName, "access_point") } : null,
    firewall: fwName
      ? {
          name: fwName,
          source: "sighting" as const,
          ...(sighting?.lastSeen ? { lastSeen: sighting.lastSeen.toISOString() } : {}),
          asset: resolve(fwName, "firewall"),
        }
      : subnetGate,
    visibility: { firewall: includeFirewall, subnetGate: wantSubnetGate },
  };
}
