/**
 * src/services/assetUpstreamService.ts
 *
 * Resolves the three UPSTREAM devices the asset-details General tab names —
 * Last Seen Switch, Last Seen AP, Last Seen Firewall — from the display
 * strings discovery records into the actual Asset rows behind them, so the
 * rows can carry verbs (open the device, open its HTTPS UI, SSH to it) instead
 * of being dead text an operator has to re-find by hand in the Assets list.
 *
 * Five inputs, all of them already written by something else — nothing new is
 * collected:
 *   - `Asset.lastSeenSwitch` — "<switch-id-or-hostname>/<port>"
 *   - `Asset.lastSeenAp`     — the FortiAP's name
 *   - FIREWALL, managed FortiSwitch / FortiAP: the controller gate stamped on
 *     `fortinetTopology` (`controllerSerial` / `controllerFortigate`) — the
 *     gate holding its FortiLink session / CAPWAP tunnel, the same value its
 *     Location shows. Answers the row outright (`source: "controller"`);
 *     sightings and IPAM are not consulted for such a device. Before this, a
 *     statically-addressed AP whose gate was replaced and deleted named the
 *     deleted gate forever: sightings come only from DHCP bindings, and
 *     nothing prunes them.
 *   - every other device: the newest `AssetFortigateSighting.fortigateDevice`
 *     whose gate still resolves to a firewall Polaris holds — FortiManager's
 *     DEVICE NAME for the gate, which is under no obligation to match the
 *     gate's own hostname. A sighting naming a gate that is gone (deleted,
 *     decommissioned) is passed over.
 *   - FALLBACK, firewall only: the gate that owns the network the asset's
 *     address sits in, per IPAM (`resolveOwningGateContexts`). Consulted only
 *     when no gate Polaris still holds has sighted the device, and reported as
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
 * The firewall half walks the sightings newest first and stops at the first
 * gate that resolves — a newer sighting always outranks an older one, and an
 * unresolved name is passed over only because the alternative is naming a
 * gate that no longer exists. When none resolve and IPAM has no answer either,
 * the newest name is reported unresolved, as before (`pickFirewallEntry`).
 *
 * Read-only. Management access rides along per resolved device, reduced through
 * the same `shapeManagementAccessForClient` the Assets list uses.
 */

import { prisma } from "../db.js";
import {
  buildInfraParentIndex,
  normalizeNameKey,
  parentAssetWhereOr,
  readControllerStamp,
  resolveInfraParentAsset,
  type InfraParentScope,
} from "../utils/fortinetParentKey.js";
import { shapeManagementAccessForClient } from "./fortinetManagementAccessService.js";
import { resolveOwningGateContexts } from "./ipUpstreamChainService.js";

/** The resolved device, shaped for the client's remote-access gating. */
interface UpstreamAssetRef {
  id: string;
  hostname: string | null;
  ipAddress: string | null;
  assetType: string;
  status: string;
  monitorStatus: string | null;
  managementAccess: { mgmtIp: string | null; protocols: string[] | null; https: boolean; ssh: boolean } | null;
}

/** One upstream row: the name as displayed, plus the asset it resolved to. */
interface UpstreamEntry {
  /** The device name exactly as the General tab renders it. */
  name: string;
  /** Switch only — the port half of `lastSeenSwitch`, when it carried one. */
  port?: string;
  /** Firewall only — when that sighting was last refreshed. Present for
   *  `source: "sighting"` and never for `"subnet"`, which has no moment. */
  lastSeen?: string;
  /**
   * Firewall only — which of the three answers this is:
   *   `"controller"` — a managed FortiSwitch / FortiAP: the gate holding its
   *                  FortiLink session / CAPWAP tunnel, per discovery's
   *                  `fortinetTopology` stamp. Current state, no moment.
   *   `"sighting"` — a gate REPORTED this device (AssetFortigateSighting).
   *   `"subnet"`   — no gate Polaris still holds has; this is the gate that
   *                  owns the network the asset's address sits in. An
   *                  inference about where the device must be, not a record
   *                  of it being seen, so the UI labels it and never prints a
   *                  "last seen" time for it.
   */
  source?: "controller" | "sighting" | "subnet";
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
    select: {
      id: true, assetType: true, lastSeenSwitch: true, lastSeenAp: true, ipAddress: true,
      fortinetTopology: true,
    },
  });
  if (!asset) return null;

  const sw = splitLastSeenSwitch(asset.lastSeenSwitch);
  const apName = typeof asset.lastSeenAp === "string" ? asset.lastSeenAp.trim() : "";

  // A managed FortiSwitch / FortiAP: the gate holding its FortiLink session /
  // CAPWAP tunnel is the firewall that sees it, rewritten every discovery run —
  // the same value its Location column shows. Sightings only exist for a
  // device a gate's DHCP leases or reserves for, so a statically-addressed AP
  // under a replacement gate kept naming the deleted gate forever. Read off
  // the asset itself (no sighting table), so it needs no assetsQuarantine
  // grant.
  const controller = isControllerManagedType(asset.assetType)
    ? readControllerStamp(asset.fortinetTopology)
    : {};
  const controllerName = typeof controller.name === "string" ? controller.name.trim() : "";
  const controllerSerial = typeof controller.serial === "string" ? controller.serial.trim() : "";
  const useController = !!(controllerName || controllerSerial);

  // A firewall is the thing doing the sighting, not the thing sighted — the
  // General tab hides all three rows for one, so don't pay for the lookups.
  // Every sighting row, newest first: a gate that was replaced and deleted
  // leaves its rows behind (nothing prunes them), so the row names the newest
  // sighting whose gate Polaris still holds, not merely the newest one. A
  // handful of rows per asset (one per gate × binding kind).
  const wantSighting = includeFirewall && asset.assetType !== "firewall" && !useController;
  const sightings = wantSighting
    ? await prisma.assetFortigateSighting.findMany({
        where: { assetId, NOT: { fortigateDevice: "" } },
        orderBy: { lastSeen: "desc" },
        select: { fortigateDevice: true, lastSeen: true },
        take: SIGHTING_SCAN_LIMIT,
      })
    : [];
  const sightingNames = [...new Set(sightings.map((s) => s.fortigateDevice.trim()).filter(Boolean))];

  // IPAM is consulted whenever no sighting is SETTLED until the candidates
  // are loaded — i.e. any time there are sightings at all it may still be
  // needed (every sighted gate could be gone), so it rides along when there's
  // an address to place. The ROW still prefers a live sighting (business rule
  // 55): a sighting is a record of the device being seen, this is an
  // inference from IPAM, and the entry says which it is so the row can never
  // read as evidence it isn't. Skipped for a firewall (same reason the
  // sighting half is), for a controller-managed device, and for an asset with
  // no address to place.
  const ip = typeof asset.ipAddress === "string" ? asset.ipAddress.trim() : "";
  const wantSubnetGate = includeSubnetGate && asset.assetType !== "firewall" && !useController && !!ip;
  const owning = wantSubnetGate ? (await resolveOwningGateContexts([ip])).get(ip) : undefined;
  const subnetGateAssetId = owning?.gateAssetId ?? null;

  const branches: Array<Record<string, unknown>> = [];
  const pushBranches = (name: string, assetType: string) => {
    const or = parentAssetWhereOr({ name });
    if (or.length > 0) branches.push({ assetType, OR: or });
  };
  if (sw) pushBranches(sw.name, "switch");
  if (apName) pushBranches(apName, "access_point");
  for (const n of sightingNames) pushBranches(n, "firewall");
  if (useController) {
    const or = parentAssetWhereOr({ serial: controllerSerial || null, name: controllerName || null });
    if (or.length > 0) branches.push({ assetType: "firewall", OR: or });
  }
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

  // A switch / AP NAME several devices share (business rule 91 — the per-site
  // switch-id of a FortiLink fleet). The resolver picks between them by the
  // gate each sits under, so the candidates' controllers must be in the same
  // index, and the scope is what this asset is known to sit behind: the
  // switches whose forwarding tables hold its MAC, the gate that last sighted
  // it, the gate IPAM says owns its address. All of it loaded only when a
  // name actually collides — the common case stays one query.
  const sharesName = (name: string, assetType: string) =>
    candidates.filter((c) => c.assetType === assetType && normalizeNameKey(c.hostname) === normalizeNameKey(name)).length > 1;
  const collided = (sw && sharesName(sw.name, "switch")) || (apName && sharesName(apName, "access_point"));
  let scope: InfraParentScope = {};
  if (collided) {
    const controllerOr = candidates
      .filter((c) => c.assetType !== "firewall")
      .flatMap((c) => parentAssetWhereOr(readControllerStamp(c.fortinetTopology)));
    const [controllers, macTableRows, owningForScope] = await Promise.all([
      controllerOr.length > 0
        ? (prisma.asset.findMany({ where: { assetType: "firewall", OR: controllerOr }, select: ASSET_SELECT }) as Promise<CandidateRow[]>)
        : Promise.resolve([] as CandidateRow[]),
      prisma.assetMacTableEntry.findMany({
        where:   { matchedAssetId: assetId, status: "learned", lastSeen: { gte: new Date(Date.now() - 48 * 60 * 60 * 1000) } },
        select:  { assetId: true },
        orderBy: { lastSeen: "desc" },
      }),
      // The IPAM gate as SCOPE even when a sighting exists — the firewall ROW
      // keeps its evidence-over-inference rule; this only narrows a name.
      owning === undefined && ip ? resolveOwningGateContexts([ip]).then((m) => m.get(ip)) : Promise.resolve(owning),
    ]);
    for (const c of controllers) if (!candidates.some((x) => x.id === c.id)) candidates.push(c);
    const gateIds: string[] = [];
    const preIndex = buildInfraParentIndex(candidates);
    for (const n of sightingNames) {
      const sighted = resolveInfraParentAsset(preIndex, { name: n }, "firewall");
      if (sighted) { gateIds.push(sighted.id); break; }
    }
    const ipamGate = owningForScope?.gateAssetId;
    if (ipamGate && !gateIds.includes(ipamGate)) gateIds.push(ipamGate);
    scope = { preferIds: [...new Set(macTableRows.map((r) => r.assetId))], gateIds };
  }

  // One index over every candidate: the resolver filters by type BEFORE it
  // counts, so a switch and a gate sharing a hostname no longer shadow each
  // other, and the switch candidates' controllers are in reach for the scope.
  const index = buildInfraParentIndex(candidates);
  const resolve = (name: string, assetType: string): UpstreamAssetRef | null => {
    const hit = resolveInfraParentAsset(index, { name }, assetType, assetType === "firewall" ? undefined : scope);
    if (!hit) return null;
    const row = candidates.find((c) => c.id === hit.id);
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
    firewall: useController
      ? controllerEntry(index, candidates, controllerName, controllerSerial)
      : pickFirewallEntry(sightings, (name) => resolve(name, "firewall"), subnetGate),
    // `firewall` reports whether the SIGHTING half was consulted; a
    // controller-managed device's row is answered without it.
    visibility: { firewall: includeFirewall || useController, subnetGate: wantSubnetGate },
  };
}

/**
 * Asset types whose upstream gate is their FortiLink / CAPWAP controller,
 * stamped on `fortinetTopology` by FortiManager / FortiGate discovery.
 */
function isControllerManagedType(assetType: string): boolean {
  return assetType === "access_point" || assetType === "switch";
}

/**
 * Sightings scanned for a live gate. An asset carries one row per gate ×
 * binding kind, so this is a ceiling against a pathological roaming history,
 * not a page size anyone should reach.
 */
const SIGHTING_SCAN_LIMIT = 50;

/** The controller gate's row: the stamped name, resolved serial-first. */
function controllerEntry(
  index: ReturnType<typeof buildInfraParentIndex>,
  candidates: CandidateRow[],
  name: string,
  serial: string,
): UpstreamEntry {
  const hit = resolveInfraParentAsset(index, { serial: serial || null, name: name || null }, "firewall");
  const row = hit ? candidates.find((c) => c.id === hit.id) : undefined;
  return {
    name: name || row?.hostname || serial,
    source: "controller",
    asset: row ? toRef(row) : null,
  };
}

/**
 * The Last Seen Firewall answer for a device with no controller, from its
 * sightings (newest first) and the IPAM fallback:
 *
 *   1. the newest sighting whose gate resolves to a firewall Polaris holds;
 *   2. else the gate that owns the device's network (`source: "subnet"`) —
 *      every sighted gate is gone, which is what replacing a firewall and
 *      deleting the old one leaves behind;
 *   3. else the newest sighting's name, unresolved — no gate in inventory and
 *      no IPAM answer; a name is still better than a blank (an install whose
 *      gates aren't assets at all lands here, exactly as before).
 *
 * Exported for the unit test; pure.
 */
export function pickFirewallEntry(
  sightings: Array<{ fortigateDevice: string; lastSeen: Date | null }>,
  resolve: (name: string) => UpstreamAssetRef | null,
  subnetGate: UpstreamEntry | null,
): UpstreamEntry | null {
  const entryFor = (s: { fortigateDevice: string; lastSeen: Date | null }, asset: UpstreamAssetRef | null): UpstreamEntry => ({
    name: s.fortigateDevice.trim(),
    source: "sighting",
    ...(s.lastSeen ? { lastSeen: s.lastSeen.toISOString() } : {}),
    asset,
  });
  for (const s of sightings) {
    const name = s.fortigateDevice.trim();
    if (!name) continue;
    const asset = resolve(name);
    if (asset && asset.status !== "decommissioned") return entryFor(s, asset);
  }
  if (subnetGate) return subnetGate;
  const newest = sightings.find((s) => s.fortigateDevice.trim());
  return newest ? entryFor(newest, resolve(newest.fortigateDevice.trim())) : null;
}
