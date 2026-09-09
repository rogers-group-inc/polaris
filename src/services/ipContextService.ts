// Cross-referencing a single IP address against everything Polaris already
// knows about it, so the manual "Add Asset" form can answer the questions an
// operator would otherwise open three other pages to answer: which network is
// this, which FortiGate is it behind, is the address already leased or
// reserved (and to what MAC), and is there already an asset sitting on it.
//
// Every fact here is read from a table something else already writes -- this
// service performs no device I/O and creates nothing. It is a lookup, and the
// operator remains the one who decides what to do with the answer.
//
// -- Which firewall ---------------------------------------------------------
// Three independent sources can name the gate, ranked by how directly each one
// observed THIS address:
//
//   1. AssetArpEntry -- the gate's own layer-3 neighbour cache resolved the
//      address minutes ago. Live, and it carries the MAC as a bonus.
//   2. Subnet.fortigateDevice -- the gate that serves the containing network's
//      DHCP. Config truth rather than an observation, but it holds for an
//      address nothing has ever seen, which is the common case when
//      pre-registering a device that has not been racked yet.
//   3. AssetFortigateSighting -- a gate saw a device at this address at some
//      point. Historical, and the weakest of the three.
//
// The gate NAME the latter two carry is FortiManager's device name, not the
// firewall's hostname, so resolving it to an Asset goes through
// utils/fortinetParentKey.ts -- the conflation that module exists to prevent is
// exactly the one a name-keyed Asset.hostname lookup would make here.
//
// -- Suggestions ------------------------------------------------------------
// The derived `suggestions` block is advisory only. It is never applied
// server-side: the route returns it, the form offers it, and the operator
// accepts it. A suggestion is only emitted when a real row supplied it, so an
// empty block means "nothing known", never "nothing to fill in".

import { prisma } from "../db.js";
import { isValidIpAddress } from "../utils/cidr.js";
import { buildIpContexts } from "./subnetService.js";
import {
  buildInfraParentIndex,
  resolveInfraParentAsset,
  type InfraParentCandidate,
} from "../utils/fortinetParentKey.js";

/** Per-source row caps. An address should resolve to a handful of rows in
 *  every one of these tables; a larger answer is itself a duplicate-address
 *  finding, and the cap keeps a pathological one from filling the panel. */
const ROW_CAP = 10;

export interface IpContextOptions {
  /** Caller holds subnets:read -- emit the containing-network block. */
  includeSubnets: boolean;
  /** Caller holds reservations:read -- look up and emit the lease/reservation. */
  includeReservations: boolean;
}

export interface IpContextSubnet {
  id: string;
  cidr: string;
  name: string;
  vlan: number | null;
  status: string;
  tags: string[];
  fortigateDevice: string | null;
  lastDiscoveredAt: Date | null;
  block: { id: string; name: string; cidr: string } | null;
  integration: { id: string; name: string; type: string } | null;
}

export interface IpContextReservation {
  id: string;
  hostname: string | null;
  macAddress: string | null;
  owner: string | null;
  createdBy: string | null;
  sourceType: string;
  /** null | "lease" | "reservation" -- how the gate hands the address out
   *  (business rule 23), deliberately separate from sourceType's ownership. */
  dhcpBinding: string | null;
  pushStatus: string | null;
  expiresAt: Date | null;
  lastSeenLeased: Date | null;
  lastSeenArp: Date | null;
  notes: string | null;
}

export interface IpContextArpRow {
  macAddress: string;
  ifName: string | null;
  ageSec: number | null;
  lastSeen: Date;
  gate: { id: string; hostname: string | null } | null;
  matched: { id: string; hostname: string | null } | null;
}

export interface IpContextSighting {
  fortigateDevice: string;
  source: string;
  lastSeen: Date;
  asset: { id: string; hostname: string | null; assetType: string } | null;
}

export interface IpContextSwitchPort {
  macAddress: string;
  ifName: string | null;
  vlanId: number | null;
  lastSeen: Date;
  switchAsset: { id: string; hostname: string | null } | null;
}

export interface IpContextApStation {
  macAddress: string;
  ssid: string | null;
  band: string | null;
  lastSeen: Date;
  /** How the station was tied to the address: by the resolved MAC, or by the
   *  address the AP itself recorded for the station. */
  matchedBy: "mac" | "ip";
  apAsset: { id: string; hostname: string | null } | null;
}

export interface IpContextExistingAsset {
  id: string;
  hostname: string | null;
  assetType: string;
  status: string;
  ipAddress: string | null;
  /** true when the address is the asset's primary IP, false when it only
   *  appears among its associated (secondary-interface) addresses. */
  primary: boolean;
}

export interface IpContextFirewall {
  /** The gate as its source names it -- FortiManager's device name for the
   *  subnet/sighting paths, the asset's own hostname for the ARP one. */
  deviceName: string;
  source: "arp" | "subnet" | "sighting";
  asset: {
    id: string;
    hostname: string | null;
    location: string | null;
    learnedLocation: string | null;
    latitude: number | null;
    longitude: number | null;
  } | null;
}

export interface IpContextSuggestions {
  hostname?: string;
  macAddress?: string;
  location?: string;
  latitude?: number;
  longitude?: number;
}

export interface IpContextResult {
  ip: string;
  subnet: IpContextSubnet | null;
  reservation: IpContextReservation | null;
  arp: IpContextArpRow[];
  sightings: IpContextSighting[];
  switchPorts: IpContextSwitchPort[];
  apStations: IpContextApStation[];
  existingAssets: IpContextExistingAsset[];
  firewall: IpContextFirewall | null;
  suggestions: IpContextSuggestions;
  /** Which sections the caller's role let us look at. A hidden section reads
   *  as "not shown", never as "nothing found" -- the two are different answers
   *  and conflating them would have the panel assert an empty network. */
  visibility: { subnets: boolean; reservations: boolean };
}

/**
 * Look one IP address up across networks, reservations/leases, gate ARP caches,
 * FortiGate sightings, switch forwarding tables and the asset inventory.
 *
 * Returns null for anything that isn't a parseable address -- the caller is a
 * debounced keystroke handler, so a half-typed value is the normal case and
 * not an error.
 */
export async function lookupIpContext(
  rawIp: string,
  opts: IpContextOptions,
): Promise<IpContextResult | null> {
  const ip = (rawIp || "").trim();
  if (!ip || !isValidIpAddress(ip)) return null;

  // The containing subnet is resolved regardless of includeSubnets: it is how
  // the reservation is found and one of the three ways the gate is named. Only
  // the emitted block is gated -- and the gate NAME it contributes is the same
  // value Asset.learnedLocation already shows to any assets:read caller.
  const ctx = (await buildIpContexts([ip])).get(ip) ?? null;

  const [subnetRow, arpRows, sightingRows, assetRows] = await Promise.all([
    ctx
      ? prisma.subnet.findUnique({
          where: { id: ctx.subnetId },
          select: {
            id: true, cidr: true, name: true, vlan: true, status: true,
            tags: true, fortigateDevice: true, lastDiscoveredAt: true,
            block: { select: { id: true, name: true, cidr: true } },
            integration: { select: { id: true, name: true, type: true } },
          },
        })
      : Promise.resolve(null),
    prisma.assetArpEntry.findMany({
      where: { ipAddress: ip },
      orderBy: { lastSeen: "desc" },
      take: ROW_CAP,
      select: {
        macAddress: true, ifName: true, ageSec: true, lastSeen: true,
        asset: { select: { id: true, hostname: true } },
        matchedAsset: { select: { id: true, hostname: true } },
      },
    }),
    prisma.assetFortigateSighting.findMany({
      where: { ipAddress: ip },
      orderBy: { lastSeen: "desc" },
      take: ROW_CAP,
      select: {
        fortigateDevice: true, source: true, lastSeen: true,
        asset: { select: { id: true, hostname: true, assetType: true } },
      },
    }),
    prisma.asset.findMany({
      where: { OR: [{ ipAddress: ip }, { associatedIpRows: { some: { ip } } }] },
      orderBy: { hostname: "asc" },
      take: ROW_CAP,
      select: { id: true, hostname: true, assetType: true, status: true, ipAddress: true },
    }),
  ]);

  const reservationRow =
    opts.includeReservations && ctx
      ? await prisma.reservation.findFirst({
          where: { subnetId: ctx.subnetId, ipAddress: ip, status: "active" },
          select: {
            id: true, hostname: true, macAddress: true, owner: true, createdBy: true,
            sourceType: true, dhcpBinding: true, pushStatus: true, expiresAt: true,
            lastSeenLeased: true, lastSeenArp: true, notes: true,
          },
        })
      : null;

  const arp: IpContextArpRow[] = arpRows.map((r) => ({
    macAddress: r.macAddress,
    ifName: r.ifName,
    ageSec: r.ageSec,
    lastSeen: r.lastSeen,
    gate: r.asset ? { id: r.asset.id, hostname: r.asset.hostname } : null,
    matched: r.matchedAsset ? { id: r.matchedAsset.id, hostname: r.matchedAsset.hostname } : null,
  }));

  // The MAC the address currently answers on. ARP wins over the stored
  // reservation for the same reason placeholder-MAC adoption trusts it (business
  // rule 26): a live L2 binding is what the wire says, while a reservation MAC
  // is what somebody typed -- and a placeholder is exactly the case where the
  // two disagree.
  const mac = arp[0]?.macAddress || reservationRow?.macAddress || null;

  const [switchPortRows, stationRows] = await Promise.all([
    mac
      ? prisma.assetMacTableEntry.findMany({
          where: { macAddress: mac, status: "learned" },
          orderBy: { lastSeen: "desc" },
          take: ROW_CAP,
          select: {
            macAddress: true, ifName: true, vlanId: true, lastSeen: true,
            asset: { select: { id: true, hostname: true } },
          },
        })
      : Promise.resolve([]),
    // The AP a wireless station is on. Two ways in: the MAC the address
    // resolved to, or the address the AP itself recorded for the station --
    // the latter is what answers for a device nothing wired has ever seen.
    prisma.assetWirelessStation.findMany({
      where: mac ? { OR: [{ staMacAddr: mac }, { staIpAddr: ip }] } : { staIpAddr: ip },
      orderBy: { lastSeen: "desc" },
      take: ROW_CAP,
      select: {
        staMacAddr: true, staIpAddr: true, ssid: true, band: true, lastSeen: true,
        apAsset: { select: { id: true, hostname: true } },
      },
    }),
  ]);

  const firewall = await resolveFirewall({
    arp,
    subnetGate: subnetRow?.fortigateDevice ?? null,
    sightingGate: sightingRows[0]?.fortigateDevice ?? null,
  });

  return {
    ip,
    subnet: opts.includeSubnets && subnetRow ? subnetRow : null,
    reservation: reservationRow,
    arp,
    sightings: sightingRows.map((s) => ({
      fortigateDevice: s.fortigateDevice,
      source: s.source,
      lastSeen: s.lastSeen,
      asset: s.asset ?? null,
    })),
    switchPorts: switchPortRows.map((p) => ({
      macAddress: p.macAddress,
      ifName: p.ifName,
      vlanId: p.vlanId,
      lastSeen: p.lastSeen,
      switchAsset: p.asset ?? null,
    })),
    apStations: stationRows.map((s) => ({
      macAddress: s.staMacAddr,
      ssid: s.ssid,
      band: s.band,
      lastSeen: s.lastSeen,
      matchedBy: mac && s.staMacAddr === mac ? "mac" : "ip",
      apAsset: s.apAsset ?? null,
    })),
    existingAssets: assetRows.map((a) => ({
      id: a.id,
      hostname: a.hostname,
      assetType: a.assetType,
      status: a.status,
      ipAddress: a.ipAddress,
      primary: a.ipAddress === ip,
    })),
    firewall,
    suggestions: buildSuggestions({ mac, reservation: reservationRow, firewall }),
    visibility: { subnets: opts.includeSubnets, reservations: opts.includeReservations },
  };
}

/**
 * Which of the two NAME-only gate sources to believe, when both answered.
 *
 * The subnet wins over a sighting because it is the gate that serves the
 * address today, while a sighting records where some device carrying it was
 * seen at some point -- which survives the device moving, the address being
 * re-issued, or the network being re-homed. Pure, so the ranking is stated in
 * one place and tested rather than being a side effect of push order.
 */
export function pickNamedGate(
  subnetGate: string | null,
  sightingGate: string | null,
): { name: string; source: "subnet" | "sighting" } | null {
  if (subnetGate) return { name: subnetGate, source: "subnet" };
  if (sightingGate) return { name: sightingGate, source: "sighting" };
  return null;
}

/**
 * Pick the gate and resolve it to a firewall Asset.
 *
 * An ARP row already IS an asset (the row hangs off the gate that answered), so
 * it needs no name resolution at all. The other two carry only a name, and that
 * name is FortiManager's -- hence the parent-key index rather than a hostname
 * match. A name that resolves to no asset still names the gate: "behind
 * CENTRALFMG1" reads perfectly well without Polaris holding a row for it.
 */
async function resolveFirewall(input: {
  arp: IpContextArpRow[];
  subnetGate: string | null;
  sightingGate: string | null;
}): Promise<IpContextFirewall | null> {
  const arpGateId = input.arp.find((r) => r.gate)?.gate?.id ?? null;
  if (arpGateId) {
    const gate = await prisma.asset.findUnique({
      where: { id: arpGateId },
      select: {
        id: true, hostname: true, location: true, learnedLocation: true,
        latitude: true, longitude: true,
      },
    });
    if (gate) {
      return { deviceName: gate.hostname || arpGateId, source: "arp", asset: gate };
    }
  }

  const chosen = pickNamedGate(input.subnetGate, input.sightingGate);
  if (!chosen) return null;

  const firewalls = await prisma.asset.findMany({
    where: { assetType: "firewall" },
    select: {
      id: true, hostname: true, serialNumber: true, assetType: true,
      fortinetTopology: true, location: true, learnedLocation: true,
      latitude: true, longitude: true,
    },
  });
  const index = buildInfraParentIndex(firewalls as unknown as InfraParentCandidate[]);
  const byId = new Map(firewalls.map((f) => [f.id, f]));

  const hit = resolveInfraParentAsset(index, { name: chosen.name }, "firewall");
  const full = hit ? byId.get(hit.id) : undefined;
  return {
    deviceName: chosen.name,
    source: chosen.source,
    asset: full
      ? {
          id: full.id,
          hostname: full.hostname,
          location: full.location,
          learnedLocation: full.learnedLocation,
          latitude: full.latitude,
          longitude: full.longitude,
        }
      : null,
  };
}

/**
 * The values the form offers to fill in. Only facts a row actually supplied
 * appear here -- nothing is inferred or defaulted, so the form can apply the
 * whole block without second-guessing any single field.
 *
 * Coordinates come from the gate rather than from anything that observed the
 * address, because a gate's coordinates are the site's: a device behind it is
 * at that site, which is the whole reason the map draws them together.
 */
export function buildSuggestions(input: {
  mac: string | null;
  reservation: IpContextReservation | null;
  firewall: IpContextFirewall | null;
}): IpContextSuggestions {
  const out: IpContextSuggestions = {};
  if (input.mac) out.macAddress = input.mac;
  if (input.reservation?.hostname) out.hostname = input.reservation.hostname;
  const gate = input.firewall?.asset;
  if (gate) {
    const loc = gate.location || gate.learnedLocation;
    if (loc) out.location = loc;
    if (gate.latitude != null && gate.longitude != null) {
      out.latitude = gate.latitude;
      out.longitude = gate.longitude;
    }
  }
  return out;
}
