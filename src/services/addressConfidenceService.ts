/**
 * src/services/addressConfidenceService.ts — gathers the evidence for every
 * address of a set of assets and scores it (business rule 103). The pure
 * scoring is utils/addressConfidence.ts; this file only reads.
 *
 * Batched for list pages: one call for N assets is five queries regardless of
 * N (assets + their address and MAC rows, reservations, the three source kinds
 * that carry an address, other devices on the same addresses). Nothing here
 * writes, alerts or decides — the score is informational.
 *
 * Evidence per address:
 *   - its AssetAssociatedIp row: interface table / detected online / held
 *     reservation / held lease / ARP (rule 102 writes only current bindings);
 *     a `manual` row is the operator's choice;
 *   - a DHCP reservation for the address whose MAC is one of the asset's:
 *     configured (always) and held (decaying from Reservation.lastSeenLeased);
 *   - vCenter guest IP, Azure Arc network profile, a Generic API feed (the
 *     AssetSource blobs that carry an address);
 *   - polling: the current primary's continuous answers (Asset.ipConfirmed*);
 *   - operator: the pinned primary, or a typed address (ipOverride).
 * Penalties:
 *   - alive-elsewhere: the primary is DOWN while a gate reports the asset
 *     online at another address within the last hour;
 *   - claimed-elsewhere: another network-present asset's primary is this
 *     address and it was seen more recently than this address's best evidence.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { isValidIpAddress } from "../utils/cidr.js";
import { pingHost } from "../utils/icmpPing.js";
import { normalizeMacOrNull } from "../utils/mac.js";
import { UNMONITORABLE_STATUSES } from "../utils/assetInvariants.js";
import {
  scoreAddress,
  pollingHoursFor,
  CONFIDENCE_WARN_BELOW,
  ALIVE_ELSEWHERE_FACTOR,
  CLAIMED_ELSEWHERE_FACTOR,
  type Evidence,
  type EvidenceKind,
  type Penalty,
  type ConfidenceResult,
} from "../utils/addressConfidence.js";

const ROW_SOURCE_KIND: Record<string, EvidenceKind> = {
  "monitor-system-info": "interface",
  "device-inventory": "detected-online",
  "dhcp-reservation": "reservation-held",
  "dhcp-lease": "lease-held",
  "arp": "arp",
};

const ALIVE_ELSEWHERE_WINDOW_MS = 60 * 60 * 1000;

export type AddressConfidenceMap = Map<string, Map<string, ConfidenceResult>>;

interface AssetEvidenceRow {
  id: string;
  ipAddress: string | null;
  ipOverride: string | null;
  primaryAddressIp: string | null;
  monitored: boolean;
  monitorStatus: string | null;
  ipConfirmedFor: string | null;
  ipConfirmedSince: Date | null;
  associatedIpRows: Array<{ ip: string; mac: string | null; source: string; device: string | null; lastSeen: Date }>;
  macAddressRows: Array<{ mac: string }>;
  macAddress: string | null;
}

/**
 * Score every address of the given assets — the address-list rows plus the
 * primary, which always gets a score even when no row backs it. `extraIps`
 * adds candidate addresses to score for one asset (the pin / typed-IP check).
 */
export async function buildAddressConfidence(
  assetIds: readonly string[],
  opts: { now?: Date; extraIps?: Map<string, string[]> } = {},
): Promise<AddressConfidenceMap> {
  const out: AddressConfidenceMap = new Map();
  if (assetIds.length === 0) return out;
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();

  const assets: AssetEvidenceRow[] = await prisma.asset.findMany({
    where: { id: { in: [...assetIds] } },
    select: {
      id: true, ipAddress: true, ipOverride: true, primaryAddressIp: true,
      monitored: true, monitorStatus: true, ipConfirmedFor: true, ipConfirmedSince: true,
      macAddress: true,
      associatedIpRows: { select: { ip: true, mac: true, source: true, device: true, lastSeen: true } },
      macAddressRows: { select: { mac: true } },
    },
  });

  // Every address to score, per asset.
  const ipsByAsset = new Map<string, Set<string>>();
  const allIps = new Set<string>();
  for (const a of assets) {
    const set = new Set<string>();
    for (const r of a.associatedIpRows) set.add(r.ip);
    if (a.ipAddress) set.add(a.ipAddress);
    for (const ip of opts.extraIps?.get(a.id) ?? []) set.add(ip);
    ipsByAsset.set(a.id, set);
    for (const ip of set) allIps.add(ip);
  }
  if (allIps.size === 0) return out;
  const ipList = [...allIps];

  const [reservations, sources, otherClaims] = await Promise.all([
    prisma.reservation.findMany({
      where: { ipAddress: { in: ipList }, status: "active", sourceType: "dhcp_reservation" },
      select: { ipAddress: true, macAddress: true, lastSeenLeased: true, subnet: { select: { fortigateDevice: true } } },
    }),
    prisma.assetSource.findMany({
      where: { assetId: { in: [...assetIds] }, sourceKind: { in: ["vcenter-vm", "arc", "generic-api"] }, inferred: false },
      select: { assetId: true, sourceKind: true, observed: true, lastSeen: true },
    }),
    prisma.asset.findMany({
      where: {
        ipAddress: { in: ipList },
        id: { notIn: [...assetIds] },
        status: { notIn: UNMONITORABLE_STATUSES as any },
      },
      select: { id: true, hostname: true, ipAddress: true, lastSeen: true },
    }),
  ]);

  const reservationsByIp = new Map<string, typeof reservations>();
  for (const r of reservations) {
    if (!r.ipAddress) continue;
    const list = reservationsByIp.get(r.ipAddress) ?? [];
    list.push(r);
    reservationsByIp.set(r.ipAddress, list);
  }
  const claimsByIp = new Map<string, typeof otherClaims>();
  for (const c of otherClaims) {
    if (!c.ipAddress) continue;
    const list = claimsByIp.get(c.ipAddress) ?? [];
    list.push(c);
    claimsByIp.set(c.ipAddress, list);
  }
  const sourcesByAsset = new Map<string, typeof sources>();
  for (const s of sources) {
    const list = sourcesByAsset.get(s.assetId) ?? [];
    list.push(s);
    sourcesByAsset.set(s.assetId, list);
  }

  for (const a of assets) {
    const macs = new Set<string>();
    for (const m of a.macAddressRows) { const n = normalizeMacOrNull(m.mac); if (n) macs.add(n); }
    const am = normalizeMacOrNull(a.macAddress); if (am) macs.add(am);

    // A gate seeing this asset online at some address right now.
    const onlineElsewhere = a.associatedIpRows.filter((r) =>
      r.source === "device-inventory" && nowMs - r.lastSeen.getTime() <= ALIVE_ELSEWHERE_WINDOW_MS);

    const perIp = new Map<string, ConfidenceResult>();
    for (const ip of ipsByAsset.get(a.id) ?? []) {
      const evidence: Evidence[] = [];
      for (const r of a.associatedIpRows) {
        if (r.ip !== ip) continue;
        if (r.source === "manual") { evidence.push({ kind: "operator" }); continue; }
        evidence.push({ kind: ROW_SOURCE_KIND[r.source] ?? "recorded", seenAt: r.lastSeen, device: r.device });
      }
      for (const res of reservationsByIp.get(ip) ?? []) {
        const rm = normalizeMacOrNull(res.macAddress);
        if (!rm || !macs.has(rm)) continue;
        const device = res.subnet?.fortigateDevice ?? null;
        evidence.push({ kind: "reservation-configured", device });
        if (res.lastSeenLeased) evidence.push({ kind: "reservation-held", seenAt: res.lastSeenLeased, device });
      }
      for (const s of sourcesByAsset.get(a.id) ?? []) {
        const o = (s.observed ?? {}) as Record<string, unknown>;
        const carries =
          s.sourceKind === "vcenter-vm" ? o.guestIp === ip
          : s.sourceKind === "arc" ? Array.isArray(o.ipAddresses) && (o.ipAddresses as unknown[]).includes(ip)
          : o.ip === ip;
        if (!carries) continue;
        evidence.push({
          kind: s.sourceKind === "vcenter-vm" ? "vcenter" : s.sourceKind === "arc" ? "arc" : "generic-api",
          seenAt: s.lastSeen,
        });
      }
      const hours = pollingHoursFor(ip, a, nowMs);
      if (hours > 0) evidence.push({ kind: "polling", hours });
      if ((a.primaryAddressIp && a.primaryAddressIp === ip) || (a.ipOverride && a.ipOverride === ip)) {
        evidence.push({ kind: "operator" });
      }

      const penalties: Penalty[] = [];
      if (ip === a.ipAddress && a.monitored && a.monitorStatus === "down") {
        const elsewhere = onlineElsewhere.find((r) => r.ip !== ip);
        if (elsewhere) {
          penalties.push({
            kind: "alive-elsewhere",
            factor: ALIVE_ELSEWHERE_FACTOR,
            detail: `Down here, but ${elsewhere.device ?? "a FortiGate"} sees it online at ${elsewhere.ip}`,
          });
        }
      }
      const bestSeenMs = Math.max(0, ...evidence.map((e) => (e.seenAt ? e.seenAt.getTime() : 0)));
      const claimant = (claimsByIp.get(ip) ?? []).find((c) => c.lastSeen && c.lastSeen.getTime() > bestSeenMs);
      if (claimant) {
        penalties.push({
          kind: "claimed-elsewhere",
          factor: CLAIMED_ELSEWHERE_FACTOR,
          detail: `${claimant.hostname || "Another device"} holds this address and was seen more recently`,
        });
      }
      perIp.set(ip, scoreAddress(evidence, penalties, nowMs));
    }
    out.set(a.id, perIp);
  }
  return out;
}

export interface AddressCheckResult {
  ip: string;
  /** Network evidence only — what the warning reads. */
  evidenceScore: number;
  evidenceBand: string;
  score: number;
  band: string;
  parts: ConfidenceResult["parts"];
  penalties: ConfidenceResult["penalties"];
  /** True when evidenceScore is below CONFIDENCE_WARN_BELOW — ask before applying. */
  warn: boolean;
  warnBelow: number;
  /** A one-off ICMP echo from this server, when asked for. */
  probe: { answered: boolean; error: string | null } | null;
}

/** How long the pre-save probe waits for its one echo. */
export const ADDRESS_CHECK_PROBE_TIMEOUT_MS = 2000;

/**
 * The pre-apply check for a pin or a typed address: the candidate's evidence
 * score (an address the asset has never been seen on scores 0) and, when
 * `probe` is set, whether it answers one ping from this server right now. A
 * reply proves something answers at the address, not that it is this device,
 * so it is reported beside the score rather than folded into it.
 */
export async function checkAddressConfidence(
  assetId: string,
  ip: string,
  opts: { probe?: boolean; now?: Date } = {},
): Promise<AddressCheckResult> {
  const candidate = ip.trim();
  if (!isValidIpAddress(candidate)) throw new AppError(400, "Not a valid IP address");
  const exists = await prisma.asset.findUnique({ where: { id: assetId }, select: { id: true } });
  if (!exists) throw new AppError(404, "Asset not found");
  const [scores, probe] = await Promise.all([
    buildAddressConfidence([assetId], { now: opts.now, extraIps: new Map([[assetId, [candidate]]]) }),
    opts.probe ? pingHost(candidate, ADDRESS_CHECK_PROBE_TIMEOUT_MS) : Promise.resolve(null),
  ]);
  const r = scores.get(assetId)?.get(candidate);
  const evidenceScore = r?.evidenceScore ?? 0;
  return {
    ip: candidate,
    evidenceScore,
    evidenceBand: r?.evidenceBand ?? "very-low",
    score: r?.score ?? 0,
    band: r?.band ?? "very-low",
    parts: r?.parts ?? [],
    penalties: r?.penalties ?? [],
    warn: evidenceScore < CONFIDENCE_WARN_BELOW,
    warnBelow: CONFIDENCE_WARN_BELOW,
    probe: probe ? { answered: probe.success, error: probe.success ? null : (probe.error ?? null) } : null,
  };
}

/** One asset's scores as a plain object keyed by IP — the API shape. */
export function confidenceToJson(map: Map<string, ConfidenceResult> | undefined): Record<string, ConfidenceResult> {
  const out: Record<string, ConfidenceResult> = {};
  if (!map) return out;
  for (const [ip, r] of map) out[ip] = r;
  return out;
}
