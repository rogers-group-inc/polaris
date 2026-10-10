/**
 * src/services/ipsecConnectionService.ts
 *
 * The asset IPsec tab's data: who is connected through a FortiGate's IPsec /
 * SSL-VPN (AssetIpsecConnection, current-state) beside the phase-1 tunnels
 * those connections hang off (the newest full-pass batch of
 * asset_ipsec_tunnel_samples).
 *
 * Writer: monitoringService → recordSystemInfoResult (full pass only) calls
 * persistIpsecConnections with the two halves utils/fortiosIpsec.ts parsed.
 * Reader: GET /assets/:id/ipsec. The remote peer is matched to an asset at
 * read time — its underlay address first, then its overlay / assigned
 * address — through applicationMapService → resolveIpsToAssets, so a peer
 * discovered after the scrape links without waiting for another one.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { retryOnDeadlock } from "../utils/dbRetry.js";
import { chunkArray } from "../utils/chunk.js";
import type { IpsecConnectionSample } from "../utils/fortiosIpsec.js";
import { resolveIpsToAssets } from "./applicationMapService.js";

/** A hub terminating thousands of FortiClient users is the realistic top end. */
export const MAX_IPSEC_CONNECTIONS_PER_ASSET = 5000;
const INSERT_CHUNK = 1000;

const SSL_KIND = "ssl-vpn";

function toBigInt(n: number | null): bigint | null {
  return n == null || !Number.isFinite(n) ? null : BigInt(Math.round(n));
}

/**
 * Replace an asset's connection rows with the latest scrape. Each half is
 * replaced only when it is an array — `undefined` means that read did not
 * answer and its stored rows stay. Delete + createMany in ONE transaction so
 * the tab never reads an empty intermediate. `firstSeen` carries forward for
 * a row whose name AND peer are unchanged: FortiOS reuses `<template>_<n>`
 * slots, so the same name can be a different spoke on the next scrape.
 * Returns the number of rows written.
 */
export async function persistIpsecConnections(
  assetId: string,
  halves: { ipsec?: IpsecConnectionSample[]; sslVpn?: IpsecConnectionSample[] },
  now: Date,
): Promise<number> {
  const replaceIpsec = Array.isArray(halves.ipsec);
  const replaceSsl   = Array.isArray(halves.sslVpn);
  if (!replaceIpsec && !replaceSsl) return 0;

  const incoming: IpsecConnectionSample[] = [];
  const seen = new Set<string>();
  for (const c of [...(halves.ipsec ?? []), ...(halves.sslVpn ?? [])]) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    incoming.push(c);
  }
  let rows = incoming;
  if (rows.length > MAX_IPSEC_CONNECTIONS_PER_ASSET) {
    logger.warn(
      { assetId, reported: rows.length, kept: MAX_IPSEC_CONNECTIONS_PER_ASSET, dropped: rows.length - MAX_IPSEC_CONNECTIONS_PER_ASSET },
      "IPsec connection list exceeds the per-asset cap — the IPsec tab shows a truncated set",
    );
    rows = rows.slice(0, MAX_IPSEC_CONNECTIONS_PER_ASSET);
  }

  const prior = await prisma.assetIpsecConnection.findMany({
    where: { assetId },
    select: { name: true, remoteGateway: true, peerId: true, userName: true, firstSeen: true },
  });
  const priorByName = new Map(prior.map((p) => [p.name, p]));

  const data = rows.map((c) => {
    const p = priorByName.get(c.name);
    const samePeer = p && p.remoteGateway === c.remoteGateway && p.peerId === c.peerId && p.userName === c.userName;
    return {
      id:             randomUUID(),
      assetId,
      name:           c.name,
      kind:           c.kind,
      parentTunnel:   c.parentTunnel,
      peerId:         c.peerId,
      userName:       c.userName,
      remoteGateway:  c.remoteGateway,
      tunnelIp:       c.tunnelIp,
      status:         c.status,
      incomingBytes:  toBigInt(c.incomingBytes),
      outgoingBytes:  toBigInt(c.outgoingBytes),
      connectedSince: c.uptimeSec != null && c.uptimeSec >= 0 ? new Date(now.getTime() - c.uptimeSec * 1000) : null,
      firstSeen:      samePeer ? p!.firstSeen : now,
      lastSeen:       now,
    };
  });

  const scope = replaceIpsec && replaceSsl
    ? { assetId }
    : replaceIpsec
      ? { assetId, kind: { not: SSL_KIND } }
      : { assetId, kind: SSL_KIND };
  // A half that was not read keeps its rows, so its incoming set is empty
  // here by construction and nothing it owns is re-inserted.
  // Chunked inserts: 15 columns × the 5000-row cap would overrun Postgres'
  // 65535 bind-parameter limit in one statement. Still one transaction.
  await retryOnDeadlock(() =>
    prisma.$transaction([
      prisma.assetIpsecConnection.deleteMany({ where: scope }),
      ...chunkArray(data, INSERT_CHUNK).map((chunk) => prisma.assetIpsecConnection.createMany({ data: chunk, skipDuplicates: true })),
    ]),
  );
  return data.length;
}

export interface IpsecTunnelRow {
  timestamp:       Date;
  tunnelName:      string;
  parentInterface: string | null;
  remoteGateway:   string | null;
  status:          string;
  incomingBytes:   number | null;
  outgoingBytes:   number | null;
  proxyIdCount:    number | null;
}

function bigToNum(v: bigint | null): number | null {
  return v == null ? null : Number(v);
}

/**
 * The asset's current phase-1 tunnel set. Anchored to the last FULL pass
 * (lastSystemInfoAt — the full pass writes every tunnel at that exact
 * timestamp), because the fast cadence writes only PINNED tunnels and the raw
 * newest timestamp would hide every unpinned one within a minute. Clamped
 * down when the anchor is ahead of the newest row (that pass's IPsec read
 * failed), and falls back to the newest batch when the anchor batch is empty.
 */
export async function readLatestIpsecTunnels(assetId: string, lastSystemInfoAt: Date | null): Promise<IpsecTunnelRow[]> {
  const latest = await prisma.assetIpsecTunnelSample.findFirst({
    where: { assetId },
    orderBy: { timestamp: "desc" },
    select: { timestamp: true },
  });
  if (!latest) return [];
  let anchor = lastSystemInfoAt ?? latest.timestamp;
  if (anchor > latest.timestamp) anchor = latest.timestamp;
  let rows = await prisma.assetIpsecTunnelSample.findMany({
    where: { assetId, timestamp: anchor },
    orderBy: { tunnelName: "asc" },
  });
  if (rows.length === 0 && anchor.getTime() !== latest.timestamp.getTime()) {
    rows = await prisma.assetIpsecTunnelSample.findMany({
      where: { assetId, timestamp: latest.timestamp },
      orderBy: { tunnelName: "asc" },
    });
  }
  return rows.map((t) => ({
    timestamp:       t.timestamp,
    tunnelName:      t.tunnelName,
    parentInterface: t.parentInterface,
    remoteGateway:   t.remoteGateway,
    status:          t.status,
    incomingBytes:   bigToNum(t.incomingBytes),
    outgoingBytes:   bigToNum(t.outgoingBytes),
    proxyIdCount:    t.proxyIdCount,
  }));
}

export interface IpsecConnectionRow {
  name:           string;
  kind:           string;
  parentTunnel:   string | null;
  peerId:         string | null;
  userName:       string | null;
  remoteGateway:  string | null;
  tunnelIp:       string | null;
  status:         string;
  incomingBytes:  number | null;
  outgoingBytes:  number | null;
  connectedSince: Date | null;
  firstSeen:      Date;
  lastSeen:       Date;
  matchedAsset:   { id: string; hostname: string | null; ipAddress: string | null; assetType: string } | null;
}

/** A tunnel row as the IPsec tab draws it: the sample plus its interface twin's facts and its pins. */
export interface IpsecTabTunnelRow extends IpsecTunnelRow {
  /** The tunnel INTERFACE's configured (overlay) address — FortiOS names the phase-1 and its interface alike. */
  overlayIp:       string | null;
  /** Pinned in Asset.monitoredIpsecTunnels (SA status + bytes every minute; IPsec tunnel automations). */
  pinned:          boolean;
  /** The interface twin is pinned in Asset.monitoredInterfaces (interface status + octets every minute). */
  interfacePinned: boolean;
  /** A site-to-site tunnel's far end, matched by its remote gateway; null for a dial-up template. */
  matchedAsset:    { id: string; hostname: string | null; ipAddress: string | null; assetType: string } | null;
}

/**
 * The IPsec tab payload, minus the cadence (the route resolves that).
 *
 * The tab is the ONLY place an IPsec tunnel is listed, pinned or opened for
 * its history: the System tab's Interfaces table leaves out every IPsec
 * tunnel and its `tunnel`-typed interface twin. So the tunnel rows carry what
 * that table used to show for them — the twin's overlay address, and both pin
 * states (an interface twin pinned in `monitoredInterfaces` would otherwise
 * be polled with nothing anywhere saying so).
 */
export async function readAssetIpsec(assetId: string): Promise<{
  tunnels: IpsecTabTunnelRow[];
  connections: IpsecConnectionRow[];
  collectedAt: Date | null;
}> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: { lastSystemInfoAt: true, monitoredIpsecTunnels: true, monitoredInterfaces: true },
  });
  const [tunnelSamples, rows] = await Promise.all([
    readLatestIpsecTunnels(assetId, asset?.lastSystemInfoAt ?? null),
    prisma.assetIpsecConnection.findMany({
      where: { assetId },
      orderBy: [{ parentTunnel: "asc" }, { name: "asc" }],
    }),
  ]);
  const twins = tunnelSamples.length > 0
    ? await prisma.assetInterface.findMany({
        where: { assetId, ifName: { in: tunnelSamples.map((t) => t.tunnelName) } },
        select: { ifName: true, ipAddress: true },
      })
    : [];
  const overlayByName = new Map(twins.map((t) => [t.ifName, t.ipAddress]));
  const pinnedTunnels = new Set(asset?.monitoredIpsecTunnels ?? []);
  const pinnedIfaces  = new Set(asset?.monitoredInterfaces ?? []);

  // One resolution pass for every address on the tab: each peer's underlay +
  // overlay, and each site-to-site tunnel's remote gateway (a dial-up
  // template reports 0.0.0.0 — "any peer" — and is never resolved).
  const usable = (ip: string | null | undefined): ip is string => !!ip && ip !== "0.0.0.0";
  const ips = new Set<string>();
  for (const r of rows) {
    if (usable(r.remoteGateway)) ips.add(r.remoteGateway);
    if (usable(r.tunnelIp)) ips.add(r.tunnelIp);
  }
  for (const t of tunnelSamples) if (usable(t.remoteGateway)) ips.add(t.remoteGateway);
  const resolved = ips.size > 0 ? await resolveIpsToAssets([...ips]) : new Map();
  const lite = (a: { id: string; hostname: string | null; ipAddress: string | null; assetType: string } | undefined) =>
    a ? { id: a.id, hostname: a.hostname, ipAddress: a.ipAddress, assetType: a.assetType } : null;

  const tunnels: IpsecTabTunnelRow[] = tunnelSamples.map((t) => {
    const ip = overlayByName.get(t.tunnelName);
    const far = usable(t.remoteGateway) ? resolved.get(t.remoteGateway) : undefined;
    return {
      ...t,
      overlayIp:       usable(ip) ? ip : null,
      pinned:          pinnedTunnels.has(t.tunnelName),
      interfacePinned: pinnedIfaces.has(t.tunnelName),
      matchedAsset:    far && far.id !== assetId ? lite(far) : null,
    };
  });

  let collectedAt: Date | null = null;
  const connections: IpsecConnectionRow[] = rows.map((r) => {
    if (!collectedAt || r.lastSeen > collectedAt) collectedAt = r.lastSeen;
    // The underlay address names the peer DEVICE; an overlay address is
    // only consulted when that does not resolve. A gate's own resolution
    // is never a match (a hub reached through its own NAT).
    const hit = [r.remoteGateway, r.tunnelIp]
      .map((ip) => (ip ? resolved.get(ip) : undefined))
      .find((a) => a && a.id !== assetId);
    return {
      name:           r.name,
      kind:           r.kind,
      parentTunnel:   r.parentTunnel,
      peerId:         r.peerId,
      userName:       r.userName,
      remoteGateway:  r.remoteGateway,
      tunnelIp:       r.tunnelIp,
      status:         r.status,
      incomingBytes:  bigToNum(r.incomingBytes),
      outgoingBytes:  bigToNum(r.outgoingBytes),
      connectedSince: r.connectedSince,
      firstSeen:      r.firstSeen,
      lastSeen:       r.lastSeen,
      matchedAsset:   hit ? { id: hit.id, hostname: hit.hostname, ipAddress: hit.ipAddress, assetType: hit.assetType } : null,
    };
  });
  // No connection rows: the tunnel batch's own stamp is the read time.
  if (!collectedAt && tunnels.length > 0) collectedAt = tunnels[0].timestamp;
  return { tunnels, connections, collectedAt };
}
