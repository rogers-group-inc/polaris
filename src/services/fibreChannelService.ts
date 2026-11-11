/**
 * src/services/fibreChannelService.ts
 *
 * Business rule 156: a fibre-channel switch's ports and the devices logged
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
  hostLookupNames,
  pickHostMatch,
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
    const [oldPorts, oldLogins, candidates, sw] = await Promise.all([
      prisma.assetFcPort.findMany({ where: { assetId: switchId }, select: { ifIndex: true, firstSeen: true } }),
      prisma.assetFcLogin.findMany({
        where: { assetId: switchId },
        select: { ifIndex: true, ifName: true, vsan: true, portWwn: true, hostName: true, firstSeen: true },
      }),
      loadMatchCandidates(switchId, inv.logins),
      prisma.asset.findUnique({ where: { id: switchId }, select: { hostname: true } }),
    ]);
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
          const matchedAssetId = pickHostMatch(l.hostName, candidates, switchId);
          return {
            assetId: switchId,
            ...l,
            matchedAssetId,
            matchMethod: matchedAssetId ? "name" : null,
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

  const collectedAt = [...ports, ...logins].reduce<Date | null>(
    (max, r) => (!max || r.lastSeen > max ? r.lastSeen : max),
    null,
  );
  return {
    collectedAt,
    switch: ports.length || logins.length ? { ports, logins } : null,
    host: fabrics.length ? { fabrics } : null,
  };
}
