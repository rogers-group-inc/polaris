/**
 * src/services/fibreChannelService.ts
 *
 * Business rule 159: a fibre-channel switch's ports and the devices logged
 * into them, stored as CURRENT STATE on the switch asset (`AssetFcPort`,
 * `AssetFcLogin`), each login resolved to the asset it is when the device
 * registered a host name that exactly one asset answers to.
 *
 *  - **Written only for a device that answered** the FC tables
 *    (`SystemInfoSample.fibreChannel` defined). A device that is not an FC
 *    switch never gets a row, and a transport that cannot say leaves the
 *    stored rows alone.
 *  - **Full replace, first-seen kept.** A port or login still present keeps
 *    its `firstSeen`; a login that left is gone, and its leaving is an Event.
 *  - **Matching is by name only, and only when unique** (`pickHostMatch`,
 *    business rule 91). The WWN itself identifies nothing in Polaris yet; when
 *    a host source reports its own WWNs, that becomes the firm match.
 *
 * Readers: `getFibreChannelForAsset` serves the asset slide-over's Fibre
 * Channel tab for both sides — the switch's ports, and a server's logins
 * across every switch it is matched on, grouped per switch (one fabric each).
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import {
  fcErrorsFrom,
  hostLookupNames,
  normalizeWwn,
  type FcErrorCounters,
  pickHostMatch,
  pickWwnMatch,
  type FcLoginRow,
  type FcMatchCandidate,
  type FcPortRow,
} from "../utils/fibreChannel.js";
import { logEvent } from "./eventLogService.js";

const loginKey = (r: { ifIndex: number; vsan: number; portWwn: string }) => `${r.ifIndex}|${r.vsan}|${r.portWwn}`;

/** Assets that might be the hosts these logins name — one query. */
async function loadMatchCandidates(switchId: string, logins: readonly FcLoginRow[]): Promise<FcMatchCandidate[]> {
  const { exact, shorts } = hostLookupNames(logins.map((l) => l.hostName));
  if (exact.length === 0) return [];
  const or: object[] = [
    { hostname: { in: exact, mode: "insensitive" } },
    { dnsName: { in: exact, mode: "insensitive" } },
    { hostname: { in: shorts, mode: "insensitive" } },
    { dnsName: { in: shorts, mode: "insensitive" } },
    ...shorts.flatMap((s) => [
      { hostname: { startsWith: `${s}.`, mode: "insensitive" } },
      { dnsName: { startsWith: `${s}.`, mode: "insensitive" } },
    ]),
  ];
  return prisma.asset.findMany({
    where: { id: { not: switchId }, status: { not: "decommissioned" }, OR: or as any },
    select: { id: true, hostname: true, dnsName: true },
  });
}

/**
 * Replace a switch's FC ports and logins with what this pass read, resolving
 * each login's asset. One read of the stored rows, one candidate query, one
 * transaction. Best-effort for the caller: a failure is logged, never thrown.
 */
export async function persistFibreChannel(
  switchId: string,
  inv: { ports: FcPortRow[]; logins: FcLoginRow[] },
  now: Date = new Date(),
): Promise<void> {
  try {
    const [oldPorts, oldLogins, candidates, sw, hbaRows] = await Promise.all([
      prisma.assetFcPort.findMany({ where: { assetId: switchId }, select: { ifIndex: true, firstSeen: true } }),
      prisma.assetFcLogin.findMany({
        where: { assetId: switchId },
        select: { ifIndex: true, ifName: true, vsan: true, portWwn: true, hostName: true, firstSeen: true },
      }),
      loadMatchCandidates(switchId, inv.logins),
      prisma.asset.findUnique({ where: { id: switchId }, select: { hostname: true } }),
      // Hosts that report these WWNs as their own HBAs — the exact match.
      inv.logins.length
        ? prisma.assetHbaPort.findMany({
            where: { portWwn: { in: [...new Set(inv.logins.map((l) => l.portWwn))] }, asset: { status: { not: "decommissioned" } } },
            select: { assetId: true, portWwn: true },
          })
        : Promise.resolve([] as Array<{ assetId: string; portWwn: string }>),
    ]);
    const matchOf = (l: FcLoginRow): { matchedAssetId: string | null; matchMethod: string | null } => {
      const byWwn = pickWwnMatch(l.portWwn, hbaRows, switchId);
      if (byWwn) return { matchedAssetId: byWwn, matchMethod: "wwn" };
      const byName = pickHostMatch(l.hostName, candidates, switchId);
      return { matchedAssetId: byName, matchMethod: byName ? "name" : null };
    };
    const portFirst = new Map(oldPorts.map((p) => [p.ifIndex, p.firstSeen]));
    const loginFirst = new Map(oldLogins.map((l) => [loginKey(l), l.firstSeen]));

    await prisma.$transaction([
      prisma.assetFcPort.deleteMany({ where: { assetId: switchId } }),
      prisma.assetFcPort.createMany({
        data: inv.ports.map((p) => ({
          assetId: switchId,
          ifIndex: p.ifIndex,
          ifName: p.ifName,
          errorCounters: p.errorCounters as object,
          firstSeen: portFirst.get(p.ifIndex) ?? now,
          lastSeen: now,
        })),
      }),
      prisma.assetFcLogin.deleteMany({ where: { assetId: switchId } }),
      prisma.assetFcLogin.createMany({
        data: inv.logins.map((l) => {
          return {
            assetId: switchId,
            ...l,
            ...matchOf(l),
            firstSeen: loginFirst.get(loginKey(l)) ?? now,
            lastSeen: now,
          };
        }),
      }),
    ]);

    // What moved since the last pass. Silent on the first ever collection
    // (nothing stored to compare with), as every inventory writer is.
    if (oldPorts.length === 0 && oldLogins.length === 0) return;
    const newKeys = new Set(inv.logins.map(loginKey));
    const oldKeys = new Set(oldLogins.map(loginKey));
    const describe = (l: { ifName: string | null; ifIndex: number; portWwn: string; hostName: string | null }) =>
      `${l.ifName ?? `ifIndex ${l.ifIndex}`} ${l.hostName ? `${l.hostName} (${l.portWwn})` : l.portWwn}`;
    const left = oldLogins.filter((l) => !newKeys.has(loginKey(l))).map(describe);
    const joined = inv.logins.filter((l) => !oldKeys.has(loginKey(l))).map(describe);
    if (left.length === 0 && joined.length === 0) return;
    const name = sw?.hostname || switchId;
    await logEvent({
      action: "asset.fc_logins_changed",
      resourceType: "asset",
      resourceId: switchId,
      resourceName: sw?.hostname || undefined,
      level: left.length ? "warning" : "info",
      actor: "system:monitor",
      message:
        `Fibre-channel logins changed on ${name}: ` +
        [left.length ? `logged out ${left.join(", ")}` : "", joined.length ? `logged in ${joined.join(", ")}` : ""]
          .filter(Boolean)
          .join("; "),
      details: { left, joined },
    });
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, assetId: switchId }, "fibre-channel persist failed");
  }
}

/**
 * The logins on a set of fibre-channel switches, each with the live asset it
 * was matched to (or none), for the Device Map's Layer 2 links (business rule
 * 162). One indexed query; `switchIds` are the site's endpoints, so a device
 * that is not an FC switch simply has no rows. A login matched to a
 * decommissioned or disabled asset comes back unmatched, never as a link to a
 * retired device.
 */
export async function getFcLoginsForSwitches(switchIds: readonly string[]) {
  if (switchIds.length === 0) return [];
  const rows = await prisma.assetFcLogin.findMany({
    where: { assetId: { in: [...switchIds] } },
    orderBy: [{ assetId: "asc" }, { ifIndex: "asc" }, { vsan: "asc" }],
    select: {
      assetId: true,
      ifName: true,
      vsan: true,
      portWwn: true,
      hostName: true,
      hbaModel: true,
      matchMethod: true,
      matchedAsset: {
        select: {
          id: true, hostname: true, ipAddress: true, assetType: true, status: true,
          monitored: true, monitorStatus: true, dependencySuppressed: true,
          manufacturer: true, model: true, description: true,
        },
      },
    },
  });
  return rows.map((r) => {
    const live = r.matchedAsset && !["decommissioned", "disabled"].includes(String(r.matchedAsset.status));
    return { ...r, matchedAsset: live ? r.matchedAsset : null, matchMethod: live ? r.matchMethod : null };
  });
}

/** What the Interfaces table shows on an FC switch port (business rule 159a). */
export interface FcInterfaceDetail {
  errorCounters: FcErrorCounters | null;
  /** The devices logged into the port, each with the asset it was matched to. */
  logins: Array<{
    vsan: number;
    portWwn: string;
    hostName: string | null;
    matchMethod: string | null;
    matchedAsset: { id: string; hostname: string | null } | null;
  }>;
}

/**
 * ifName → the FC port's counters and logins, for an FC switch's Interfaces
 * table. Two indexed reads; an asset that is not an FC switch has no rows and
 * gets an empty map. A login matched to a decommissioned asset shows as
 * unmatched, as on the Device Map.
 */
export async function getFcByInterface(assetId: string): Promise<Map<string, FcInterfaceDetail>> {
  const [ports, logins] = await Promise.all([
    prisma.assetFcPort.findMany({ where: { assetId }, select: { ifName: true, errorCounters: true } }),
    prisma.assetFcLogin.findMany({
      where: { assetId },
      orderBy: [{ ifIndex: "asc" }, { vsan: "asc" }, { portWwn: "asc" }],
      select: {
        ifName: true, vsan: true, portWwn: true, hostName: true, matchMethod: true,
        matchedAsset: { select: { id: true, hostname: true, status: true } },
      },
    }),
  ]);
  const out = new Map<string, FcInterfaceDetail>();
  const entry = (ifName: string) => {
    let e = out.get(ifName);
    if (!e) { e = { errorCounters: null, logins: [] }; out.set(ifName, e); }
    return e;
  };
  for (const p of ports) if (p.ifName) entry(p.ifName).errorCounters = fcErrorsFrom(p.errorCounters);
  for (const l of logins) {
    if (!l.ifName) continue;
    const live = l.matchedAsset && l.matchedAsset.status !== "decommissioned";
    entry(l.ifName).logins.push({
      vsan: l.vsan,
      portWwn: l.portWwn,
      hostName: l.hostName,
      matchMethod: live ? l.matchMethod : null,
      matchedAsset: live ? { id: l.matchedAsset!.id, hostname: l.matchedAsset!.hostname } : null,
    });
  }
  return out;
}

/** The Fibre Channel tab's payload for one asset, from both sides. */
export async function getFibreChannelForAsset(assetId: string) {
  const [ports, logins, hostLogins] = await Promise.all([
    prisma.assetFcPort.findMany({ where: { assetId }, orderBy: { ifIndex: "asc" } }),
    prisma.assetFcLogin.findMany({
      where: { assetId },
      orderBy: [{ ifIndex: "asc" }, { vsan: "asc" }],
      include: { matchedAsset: { select: { id: true, hostname: true, assetType: true } } },
    }),
    prisma.assetFcLogin.findMany({
      where: { matchedAssetId: assetId },
      orderBy: [{ assetId: "asc" }, { ifIndex: "asc" }],
      include: { asset: { select: { id: true, hostname: true, model: true } } },
    }),
  ]);

  // The other devices on each switch this asset lands on that registered no
  // HBA symbolic name — in practice the storage arrays' target ports, which
  // register a port label ("PURE01-ct0") through FDMI but no driver string.
  // Shown as "on this switch, same VSAN", nothing more: zoning decides who may
  // actually talk to whom, and it is not read.
  const switchIds = [...new Set(hostLogins.map((l) => l.assetId))];
  // `matchedAssetId` spelled out with its NULL arm: a bare `not` compiles to
  // `<>`, which drops every unmatched row — the very rows this wants.
  const [peers, switchPorts] = switchIds.length
    ? await Promise.all([
        prisma.assetFcLogin.findMany({
          where: {
            assetId: { in: switchIds },
            symbolicName: null,
            OR: [{ matchedAssetId: null }, { matchedAssetId: { not: assetId } }],
          },
          select: { assetId: true, ifName: true, portWwn: true, hostName: true, vsan: true },
        }),
        prisma.assetFcPort.findMany({
          where: { assetId: { in: switchIds }, ifIndex: { in: [...new Set(hostLogins.map((l) => l.ifIndex))] } },
          select: { assetId: true, ifIndex: true, errorCounters: true },
        }),
      ])
    : [[], []];
  const countersOf = (sid: string, ifIndex: number) =>
    switchPorts.find((p) => p.assetId === sid && p.ifIndex === ifIndex)?.errorCounters ?? null;

  const fabrics = switchIds.map((sid) => {
    const rows = hostLogins.filter((l) => l.assetId === sid);
    const sw = rows[0]?.asset ?? { id: sid, hostname: null, model: null };
    return {
      switch: sw,
      vsans: [...new Set(rows.map((r) => r.vsan))],
      ports: rows.map((r) => ({
        ifName: r.ifName,
        vsan: r.vsan,
        portWwn: r.portWwn,
        nodeWwn: r.nodeWwn,
        fcid: r.fcid,
        hbaModel: r.hbaModel,
        hbaFirmware: r.hbaFirmware,
        hbaDriver: r.hbaDriver,
        osInfo: r.osInfo,
        hostName: r.hostName,
        matchMethod: r.matchMethod,
        lastSeen: r.lastSeen,
        // The switch port's cumulative counters: this HBA link's health.
        errorCounters: countersOf(sid, r.ifIndex),
      })),
      others: peers
        .filter((p) => p.assetId === sid && rows.some((r) => r.vsan === p.vsan))
        .map((p) => ({ ifName: p.ifName, portWwn: p.portWwn, label: p.hostName })),
    };
  });

  // The host's own report of its HBA ports, each with the switch port that
  // sees its WWN logged in, if a switch in Polaris does. A port no switch
  // sees is the case the switch view cannot show: a dead link, or a fabric
  // whose switch is not monitored (its `fabricWwn` still says which fabric).
  const hbaRows = await prisma.assetHbaPort.findMany({
    where: { assetId },
    orderBy: [{ name: "asc" }, { portWwn: "asc" }],
  });
  const seen = hbaRows.length
    ? await prisma.assetFcLogin.findMany({
        where: { portWwn: { in: hbaRows.map((h) => h.portWwn) } },
        select: { portWwn: true, ifName: true, vsan: true, asset: { select: { id: true, hostname: true } } },
      })
    : [];
  const hbas = hbaRows.map((h) => ({
    source: h.source,
    name: h.name,
    portWwn: h.portWwn,
    nodeWwn: h.nodeWwn,
    portState: h.portState,
    speed: h.speed,
    fabricWwn: h.fabricWwn,
    model: h.model,
    firmware: h.firmware,
    driver: h.driver,
    lastSeen: h.lastSeen,
    seenBy: seen
      .filter((s) => s.portWwn === h.portWwn)
      .map((s) => ({ switch: s.asset, ifName: s.ifName, vsan: s.vsan })),
  }));

  const collectedAt = [...ports, ...logins].reduce<Date | null>(
    (max, r) => (!max || r.lastSeen > max ? r.lastSeen : max),
    null,
  );
  return {
    collectedAt,
    switch: ports.length || logins.length ? { ports, logins } : null,
    host: fabrics.length || hbas.length ? { fabrics, hbas } : null,
  };
}

/** One HBA port as a host source reported it, before normalisation. */
export interface HostHbaPortInput {
  name?: string | null;
  portWwn: string;
  nodeWwn?: string | null;
  portState?: string | null;
  speed?: string | null;
  fabricWwn?: string | null;
  model?: string | null;
  firmware?: string | null;
  driver?: string | null;
}

/** "asset|source" → the canonical reading last recorded. Bounds steady state. */
const lastHbaReading = new Map<string, string>();

/** Test hook. */
export function resetHbaPortCache(): void {
  lastHbaReading.clear();
}

const text = (v: string | null | undefined, max = 255) => {
  const s = (v ?? "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};

/**
 * Record a host's own HBA ports as one source reported them (business rule
 * 159): `source` "agent" or "vcenter". An empty list clears that source's
 * rows (the host was read and has none); a port whose WWN is not a WWN is
 * dropped. Edge-triggered: an unchanged reading costs an in-memory compare.
 * Matching happens on the switch's next pass, which looks these rows up.
 */
export async function recordHostHbaPorts(
  assetId: string,
  source: "agent" | "vcenter",
  ports: readonly HostHbaPortInput[],
  now: Date = new Date(),
): Promise<void> {
  const byWwn = new Map<string, Omit<HostHbaPortInput, "portWwn"> & { portWwn: string }>();
  for (const p of ports.slice(0, 64)) {
    const portWwn = normalizeWwn(p.portWwn);
    if (!portWwn || byWwn.has(portWwn)) continue;
    byWwn.set(portWwn, {
      portWwn,
      name: text(p.name, 128),
      nodeWwn: normalizeWwn(p.nodeWwn),
      portState: text(p.portState, 64),
      speed: text(p.speed, 64),
      fabricWwn: normalizeWwn(p.fabricWwn),
      model: text(p.model),
      firmware: text(p.firmware),
      driver: text(p.driver),
    });
  }
  const rows = [...byWwn.values()].sort((a, b) => a.portWwn.localeCompare(b.portWwn));
  const key = `${assetId}|${source}`;
  const reading = JSON.stringify(rows);
  if (lastHbaReading.get(key) === reading) return;
  try {
    const old = await prisma.assetHbaPort.findMany({
      where: { assetId, source },
      select: { portWwn: true, firstSeen: true },
    });
    const first = new Map(old.map((o) => [o.portWwn, o.firstSeen]));
    await prisma.$transaction([
      prisma.assetHbaPort.deleteMany({ where: { assetId, source } }),
      prisma.assetHbaPort.createMany({
        data: rows.map((r) => ({ assetId, source, ...r, firstSeen: first.get(r.portWwn) ?? now, lastSeen: now })),
      }),
    ]);
    lastHbaReading.set(key, reading);
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, assetId, source }, "HBA port record failed");
  }
}
