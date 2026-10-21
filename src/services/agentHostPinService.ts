/**
 * src/services/agentHostPinService.ts — an agent host's pinned server
 * identities across decommission (business rule 123).
 *
 * Polaris pins the SSH host key (SshHostKey, rule 21 / 113(a)) and the WinRM
 * TLS certificate (TlsCertPin, rule 113(b)) of every host it installs an agent
 * on, keyed by the ADDRESS it dialed. Once the asset is decommissioned, that
 * address is free to be handed to another machine, and the live pin would then
 * refuse the new machine ("Host denied (verification failed)") for a reason
 * nobody can see. So, exactly while the asset is decommissioned:
 *
 *   archive   — the pins on the asset's addresses are moved off the live tables
 *               onto its ManagedAgent row (`archivedHostPins`,
 *               `hostPinsArchivedAt`). An address another non-decommissioned
 *               asset also records is left alone: its pin is not ours to take.
 *   reinstate — when the asset leaves decommissioned, each archived pin is
 *               written back verbatim. A pin some other machine has taken on
 *               that endpoint since is NEVER overwritten; it is reported.
 *   check-in  — an agent that authenticates while its archive is held raises
 *               ONE pending `decommissioned-agent-checkin` Conflict. Accept
 *               reactivates the asset and reinstates; Reject keeps it
 *               decommissioned, and the rejected row silences that same
 *               decommission (keyed on `hostPinsArchivedAt`).
 *
 * The asset PUT route archives / reinstates at the moment of the operator's
 * change; the reconcileAgentHostPins job does the same for every other path
 * that writes `status` (the stale-asset job, the directory sweeps, scheduled
 * status changes). Only assets with a ManagedAgent are in scope — the archive
 * lives on that row.
 */

import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import { forgetCachedHostKey } from "./sshHostKeyService.js";
import { forgetCachedCertPin } from "./tlsCertPinService.js";

export const DECOMMISSIONED_AGENT_COLLISION_REASON = "decommissioned-agent-checkin";

const CHECKIN_CONFLICT_WHERE = {
  entityType: "asset",
  proposedAssetFields: { path: ["collisionReason"], equals: DECOMMISSIONED_AGENT_COLLISION_REASON },
};

export interface HostPin {
  kind: "ssh" | "tls";
  host: string;
  port: number;
  fingerprint: string;
  /** SSH only: "ssh-ed25519", "ecdsa-sha2-nistp256", ... */
  keyType?: string;
  /** TLS only: the certificate subject recorded at pinning. */
  subject?: string;
  firstSeen: string;
  lastSeen: string;
}

export interface AssetHostPins {
  hasAgent: boolean;
  /** Pins currently live on the asset's addresses. */
  live: HostPin[];
  /** The archive held while the asset is decommissioned, or null. */
  archived: { at: string; pins: HostPin[] } | null;
}

interface AddressedAsset {
  id: string;
  hostname: string | null;
  ipAddress: string | null;
  dnsName: string | null;
}

/**
 * The address strings Polaris may have dialed for this asset. The agent install
 * dials `ipAddress ?? dnsName ?? hostname` (agentInstallService), and a pin is
 * keyed by that exact string, so all three are candidates. Pure.
 */
export function assetPinHosts(asset: Pick<AddressedAsset, "hostname" | "ipAddress" | "dnsName">): string[] {
  const out: string[] = [];
  for (const v of [asset.ipAddress, asset.dnsName, asset.hostname]) {
    const s = typeof v === "string" ? v.trim() : "";
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Hosts another asset still answers to. Its pin protects that asset too, so
 * archiving it would lower that asset's guard. Decommissioned assets don't
 * count — they are the ones giving addresses up.
 */
async function hostsClaimedElsewhere(assetId: string, hosts: string[]): Promise<Set<string>> {
  if (hosts.length === 0) return new Set();
  const others = await prisma.asset.findMany({
    where: {
      id: { not: assetId },
      status: { not: "decommissioned" },
      OR: [{ ipAddress: { in: hosts } }, { dnsName: { in: hosts } }, { hostname: { in: hosts } }],
    },
    select: { ipAddress: true, dnsName: true, hostname: true },
  });
  const claimed = new Set<string>();
  for (const o of others) {
    for (const v of [o.ipAddress, o.dnsName, o.hostname]) if (v && hosts.includes(v)) claimed.add(v);
  }
  return claimed;
}

type SshRow = { id: string; host: string; port: number; keyType: string; fingerprint: string; firstSeen: Date; lastSeen: Date };
type TlsRow = { id: string; host: string; port: number; fingerprint: string; subject: string; firstSeen: Date; lastSeen: Date };

function sshToPin(r: SshRow): HostPin {
  return { kind: "ssh", host: r.host, port: r.port, fingerprint: r.fingerprint, keyType: r.keyType, firstSeen: r.firstSeen.toISOString(), lastSeen: r.lastSeen.toISOString() };
}
function tlsToPin(r: TlsRow): HostPin {
  return { kind: "tls", host: r.host, port: r.port, fingerprint: r.fingerprint, subject: r.subject, firstSeen: r.firstSeen.toISOString(), lastSeen: r.lastSeen.toISOString() };
}

async function livePinRows(hosts: string[]): Promise<{ ssh: SshRow[]; tls: TlsRow[] }> {
  if (hosts.length === 0) return { ssh: [], tls: [] };
  const [ssh, tls] = await Promise.all([
    prisma.sshHostKey.findMany({ where: { host: { in: hosts } }, orderBy: [{ host: "asc" }, { port: "asc" }] }),
    prisma.tlsCertPin.findMany({
      where: { host: { in: hosts } },
      select: { id: true, host: true, port: true, fingerprint: true, subject: true, firstSeen: true, lastSeen: true },
      orderBy: [{ host: "asc" }, { port: "asc" }],
    }),
  ]);
  return { ssh, tls };
}

/** Parse the stored archive defensively — it is a JSON column. */
export function parseArchivedPins(raw: unknown): HostPin[] {
  if (!Array.isArray(raw)) return [];
  const out: HostPin[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    if ((o.kind !== "ssh" && o.kind !== "tls") || typeof o.host !== "string" || typeof o.fingerprint !== "string") continue;
    const port = Number(o.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    out.push({
      kind: o.kind,
      host: o.host,
      port,
      fingerprint: o.fingerprint,
      ...(typeof o.keyType === "string" ? { keyType: o.keyType } : {}),
      ...(typeof o.subject === "string" ? { subject: o.subject } : {}),
      firstSeen: typeof o.firstSeen === "string" ? o.firstSeen : new Date(0).toISOString(),
      lastSeen: typeof o.lastSeen === "string" ? o.lastSeen : new Date(0).toISOString(),
    });
  }
  return out;
}

function pinLabel(p: HostPin): string {
  return `${p.kind === "ssh" ? "SSH host key" : "TLS certificate"} ${p.host}:${p.port}`;
}

/** What the Sources tab and the decommission warning show for one asset. */
export async function hostPinsForAsset(assetId: string): Promise<AssetHostPins> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: {
      id: true, hostname: true, ipAddress: true, dnsName: true,
      managedAgent: { select: { id: true, archivedHostPins: true, hostPinsArchivedAt: true } },
    },
  });
  if (!asset) throw new AppError(404, "Asset not found");
  const { ssh, tls } = await livePinRows(assetPinHosts(asset));
  const agent = asset.managedAgent;
  return {
    hasAgent: !!agent,
    live: [...ssh.map(sshToPin), ...tls.map(tlsToPin)],
    archived: agent?.hostPinsArchivedAt
      ? { at: agent.hostPinsArchivedAt.toISOString(), pins: parseArchivedPins(agent.archivedHostPins) }
      : null,
  };
}

export interface DecommissionPinPreview {
  assetId: string;
  hostname: string | null;
  /** The pins archiveAgentHostPins would move — what the warning names. */
  pins: HostPin[];
}

/**
 * What decommissioning these assets would archive: one entry per agent host
 * not already decommissioned (non-agent assets are out of scope and omitted).
 * One query per table for the whole selection, so the bulk bar can ask about
 * hundreds of rows at once.
 */
export async function previewDecommissionPins(assetIds: string[]): Promise<DecommissionPinPreview[]> {
  if (assetIds.length === 0) return [];
  const assets = await prisma.asset.findMany({
    where: { id: { in: assetIds }, status: { not: "decommissioned" }, managedAgent: { isNot: null } },
    select: { id: true, hostname: true, ipAddress: true, dnsName: true },
  });
  if (assets.length === 0) return [];
  const hostsByAsset = new Map(assets.map((a) => [a.id, assetPinHosts(a)]));
  const allHosts = [...new Set([...hostsByAsset.values()].flat())];
  // An address an asset OUTSIDE the selection still answers to is kept, as
  // archiveAgentHostPins keeps it; one inside the selection is going too.
  const selected = new Set(assetIds);
  const others = allHosts.length
    ? await prisma.asset.findMany({
        where: {
          id: { notIn: [...selected] },
          status: { not: "decommissioned" },
          OR: [{ ipAddress: { in: allHosts } }, { dnsName: { in: allHosts } }, { hostname: { in: allHosts } }],
        },
        select: { ipAddress: true, dnsName: true, hostname: true },
      })
    : [];
  const shared = new Set<string>();
  for (const o of others) for (const v of [o.ipAddress, o.dnsName, o.hostname]) if (v) shared.add(v);
  const { ssh, tls } = await livePinRows(allHosts.filter((h) => !shared.has(h)));
  const pins = [...ssh.map(sshToPin), ...tls.map(tlsToPin)];
  return assets.map((a) => {
    const hosts = hostsByAsset.get(a.id) ?? [];
    return { assetId: a.id, hostname: a.hostname, pins: pins.filter((p) => hosts.includes(p.host)) };
  });
}

/**
 * Move the asset's pins into its agent's archive. Idempotent: an asset with no
 * agent, or whose archive is already held, is left alone (returns null).
 */
export async function archiveAgentHostPins(
  assetId: string,
  actor: string | undefined,
): Promise<{ archived: HostPin[]; leftShared: string[] } | null> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: {
      id: true, hostname: true, ipAddress: true, dnsName: true,
      managedAgent: { select: { id: true, hostPinsArchivedAt: true } },
    },
  });
  if (!asset?.managedAgent || asset.managedAgent.hostPinsArchivedAt) return null;

  const hosts = assetPinHosts(asset);
  const shared = await hostsClaimedElsewhere(asset.id, hosts);
  const own = hosts.filter((h) => !shared.has(h));
  const { ssh, tls } = await livePinRows(own);
  const pins = [...ssh.map(sshToPin), ...tls.map(tlsToPin)];

  // Guard on the archive still being empty, so two writers (the PUT hook and
  // the reconcile job) never both archive — the loser's deletes roll back.
  const won = await prisma.$transaction(async (tx) => {
    const claimed = await tx.managedAgent.updateMany({
      where: { id: asset.managedAgent!.id, hostPinsArchivedAt: null },
      data: { archivedHostPins: pins as unknown as Prisma.InputJsonValue, hostPinsArchivedAt: new Date() },
    });
    if (claimed.count === 0) return false;
    if (ssh.length) await tx.sshHostKey.deleteMany({ where: { id: { in: ssh.map((r) => r.id) } } });
    if (tls.length) await tx.tlsCertPin.deleteMany({ where: { id: { in: tls.map((r) => r.id) } } });
    return true;
  });
  if (!won) return null;
  for (const r of ssh) forgetCachedHostKey(r.host, r.port);
  for (const r of tls) forgetCachedCertPin(r.host, r.port);

  const label = asset.hostname || asset.ipAddress || asset.id;
  await logEvent({
    action: "asset.host_pins_archived",
    resourceType: "asset",
    resourceId: asset.id,
    resourceName: label,
    actor: actor ?? "system",
    level: "info",
    message: pins.length
      ? `Archived ${pins.length} pinned server identit${pins.length === 1 ? "y" : "ies"} of decommissioned agent host "${label}" (${pins.map(pinLabel).join(", ")}) — its addresses no longer refuse another machine`
      : `Decommissioned agent host "${label}" had no pinned server identities to archive`,
    details: { pins, leftShared: [...shared] },
  });
  return { archived: pins, leftShared: [...shared] };
}

export interface ReinstateOutcome {
  restored: HostPin[];
  /** Endpoints where another key or certificate has been pinned since; left as they are. */
  skipped: Array<HostPin & { currentFingerprint: string }>;
}

/**
 * Put the archived pins back and clear the archive. A pin another machine took
 * on the same endpoint while the asset was away is kept, never overwritten —
 * replacing a live pin is the operator's call (Pinned server identities).
 * Returns null when no archive is held.
 */
export async function reinstateAgentHostPins(
  assetId: string,
  actor: string | undefined,
): Promise<ReinstateOutcome | null> {
  const agent = await prisma.managedAgent.findUnique({
    where: { assetId },
    select: { id: true, archivedHostPins: true, hostPinsArchivedAt: true, asset: { select: { hostname: true, ipAddress: true } } },
  });
  if (!agent?.hostPinsArchivedAt) return null;
  const pins = parseArchivedPins(agent.archivedHostPins);
  const restored: HostPin[] = [];
  const skipped: ReinstateOutcome["skipped"] = [];

  const released = await prisma.$transaction(async (tx) => {
    const claimed = await tx.managedAgent.updateMany({
      where: { id: agent.id, hostPinsArchivedAt: agent.hostPinsArchivedAt },
      data: { archivedHostPins: Prisma.DbNull, hostPinsArchivedAt: null },
    });
    if (claimed.count === 0) return false;
    for (const p of pins) {
      const where = { host_port: { host: p.host, port: p.port } };
      const current = p.kind === "ssh"
        ? await tx.sshHostKey.findUnique({ where, select: { fingerprint: true } })
        : await tx.tlsCertPin.findUnique({ where, select: { fingerprint: true } });
      if (current) {
        if (current.fingerprint === p.fingerprint) restored.push(p);
        else skipped.push({ ...p, currentFingerprint: current.fingerprint });
        continue;
      }
      const stamps = { firstSeen: new Date(p.firstSeen), lastSeen: new Date(p.lastSeen) };
      if (p.kind === "ssh") {
        await tx.sshHostKey.create({ data: { host: p.host, port: p.port, keyType: p.keyType ?? "unknown", fingerprint: p.fingerprint, ...stamps } });
      } else {
        await tx.tlsCertPin.create({ data: { host: p.host, port: p.port, fingerprint: p.fingerprint, subject: p.subject ?? "", ...stamps } });
      }
      restored.push(p);
    }
    return true;
  });
  if (!released) return null;
  for (const p of pins) {
    if (p.kind === "ssh") forgetCachedHostKey(p.host, p.port);
    else forgetCachedCertPin(p.host, p.port);
  }

  const label = agent.asset.hostname || agent.asset.ipAddress || assetId;
  await logEvent({
    action: "asset.host_pins_reinstated",
    resourceType: "asset",
    resourceId: assetId,
    resourceName: label,
    actor: actor ?? "system",
    level: skipped.length ? "warning" : "info",
    message:
      `Reinstated ${restored.length} archived server identit${restored.length === 1 ? "y" : "ies"} of agent host "${label}"` +
      (skipped.length
        ? `; ${skipped.length} left as they are because another key is pinned there now (${skipped.map(pinLabel).join(", ")}) — compare it under Pinned server identities`
        : ""),
    details: { restored, skipped },
  });
  return { restored, skipped };
}

/**
 * Close the asset's pending check-in conflicts — the operator brought the asset
 * back by another route (the edit form), which is what Accept would have done.
 */
export async function resolvePendingCheckinConflicts(assetId: string, resolvedBy: string): Promise<number> {
  const r = await prisma.conflict.updateMany({
    where: { ...CHECKIN_CONFLICT_WHERE, assetId, status: "pending" },
    data: { status: "accepted", resolvedBy, resolvedAt: new Date() },
  });
  return r.count;
}

// ─── Check-in ────────────────────────────────────────────────────────────────

/** A raise per agent at most this often per process; a pending row is refreshed, not duplicated. */
const CHECKIN_THROTTLE_MS = 10 * 60 * 1000;
const lastCheckinRaise = new Map<string, number>();

export function _resetCheckinThrottle(): void {
  lastCheckinRaise.clear();
}

/**
 * Called from agentTokenService.verifyBearer when an authenticated agent's
 * archive is held. Fire-and-forget and throttled — it sits on every agent
 * request and must never slow or fail one.
 */
export function noteArchivedAgentCheckin(managedAgentId: string, callerIp: string | null): void {
  const now = Date.now();
  if (now - (lastCheckinRaise.get(managedAgentId) ?? 0) < CHECKIN_THROTTLE_MS) return;
  lastCheckinRaise.set(managedAgentId, now);
  void raiseDecommissionedAgentConflict(managedAgentId, callerIp);
}

/** Raise or refresh the asset's one pending check-in conflict. Never throws. */
export async function raiseDecommissionedAgentConflict(managedAgentId: string, callerIp: string | null): Promise<void> {
  try {
    const agent = await prisma.managedAgent.findUnique({
      where: { id: managedAgentId },
      select: {
        id: true, assetId: true, agentVersion: true, archivedHostPins: true, hostPinsArchivedAt: true,
        asset: {
          select: {
            hostname: true, ipAddress: true, status: true, statusChangedAt: true, statusChangedBy: true,
            discoveredByIntegrationId: true,
          },
        },
      },
    });
    if (!agent?.hostPinsArchivedAt || agent.asset.status !== "decommissioned") return;
    const archivedAt = agent.hostPinsArchivedAt.toISOString();
    const proposedAssetFields = {
      collisionReason: DECOMMISSIONED_AGENT_COLLISION_REASON,
      hostname: agent.asset.hostname ?? null, // conflict-queue widget subtitle
      managedAgentId: agent.id,
      agentVersion: agent.agentVersion ?? null,
      checkinIp: callerIp,
      lastCheckinAt: new Date().toISOString(),
      archivedAt,
      pins: parseArchivedPins(agent.archivedHostPins) as unknown as Prisma.InputJsonArray,
    };
    const existingAssetSnapshot = {
      hostname: agent.asset.hostname ?? null,
      ipAddress: agent.asset.ipAddress ?? null,
      status: agent.asset.status,
      statusChangedAt: agent.asset.statusChangedAt?.toISOString() ?? null,
      statusChangedBy: agent.asset.statusChangedBy ?? null,
    };

    const prior = await prisma.conflict.findMany({
      where: { ...CHECKIN_CONFLICT_WHERE, assetId: agent.assetId },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, status: true, proposedAssetFields: true },
    });
    const pending = prior.find((c) => c.status === "pending");
    if (pending) {
      await prisma.conflict.update({ where: { id: pending.id }, data: { proposedAssetFields, existingAssetSnapshot } });
      return;
    }
    // Rejected for THIS decommission — stay quiet until the asset is
    // decommissioned again (a new archive, a new archivedAt).
    const dismissed = prior.some(
      (c) => c.status === "rejected" && (c.proposedAssetFields as Record<string, unknown> | null)?.archivedAt === archivedAt,
    );
    if (dismissed) return;

    await prisma.conflict.create({
      data: {
        entityType: "asset",
        assetId: agent.assetId,
        integrationId: agent.asset.discoveredByIntegrationId ?? null,
        conflictFields: ["status"],
        proposedAssetFields,
        existingAssetSnapshot,
      },
    });
    const label = agent.asset.hostname || agent.asset.ipAddress || agent.assetId;
    await logEvent({
      action: "conflict.detected",
      resourceType: "asset",
      resourceId: agent.assetId,
      resourceName: label,
      actor: "system",
      level: "warning",
      message: `The Polaris Agent on decommissioned asset "${label}" checked in${callerIp ? ` from ${callerIp}` : ""} — reactivate it and reinstate its ${proposedAssetFields.pins.length} archived pinned server identit${proposedAssetFields.pins.length === 1 ? "y" : "ies"}?`,
      details: { collisionReason: DECOMMISSIONED_AGENT_COLLISION_REASON, managedAgentId: agent.id, checkinIp: callerIp, archivedAt },
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), managedAgentId }, "decommissioned-agent check-in conflict raise failed");
  }
}

/**
 * Accept: the host is back. Reactivate the asset (monitoring stays off — the
 * decommission clamped it, and turning it on is the operator's choice) and
 * reinstate its pins.
 */
export async function acceptDecommissionedAgentConflict(conflict: { assetId: string; asset?: { hostname?: string | null; status?: string } | null }, actor?: string): Promise<ReinstateOutcome | null> {
  const asset = await prisma.asset.findUnique({ where: { id: conflict.assetId }, select: { status: true, hostname: true, ipAddress: true } });
  if (!asset) throw new AppError(404, "Asset not found");
  if (asset.status === "decommissioned") {
    await prisma.asset.update({
      where: { id: conflict.assetId },
      data: { status: "active", statusChangedAt: new Date(), statusChangedBy: actor ?? "system" },
    });
  }
  const outcome = await reinstateAgentHostPins(conflict.assetId, actor);
  const label = asset.hostname || asset.ipAddress || conflict.assetId;
  await logEvent({
    action: "conflict.accepted",
    resourceType: "asset",
    resourceId: conflict.assetId,
    resourceName: label,
    actor,
    message:
      `Decommissioned agent host "${label}" reactivated` +
      (outcome ? ` — ${outcome.restored.length} pinned server identit${outcome.restored.length === 1 ? "y" : "ies"} reinstated` : "") +
      (outcome?.skipped.length ? `, ${outcome.skipped.length} left in place (another key is pinned there now)` : ""),
  });
  return outcome;
}

/** Reject: the asset stays decommissioned and its pins stay archived. */
export function logDecommissionedAgentDismissal(conflict: { assetId: string; asset?: { hostname?: string | null } | null }, actor?: string): void {
  const label = conflict.asset?.hostname || conflict.assetId;
  logEvent({
    action: "conflict.rejected",
    resourceType: "asset",
    resourceId: conflict.assetId,
    resourceName: label,
    actor,
    message: `Kept "${label}" decommissioned although its Polaris Agent checked in — pins stay archived; uninstall the agent from the asset's Agent card to stop it reporting`,
  });
}

// ─── Reconcile ───────────────────────────────────────────────────────────────

const RECONCILE_BATCH = 200;
const RECONCILE_CONCURRENCY = 8;

async function inChunks<T>(rows: T[], fn: (row: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += RECONCILE_CONCURRENCY) {
    await Promise.all(rows.slice(i, i + RECONCILE_CONCURRENCY).map(fn));
  }
}

/**
 * Bring every agent's archive in line with its asset's status — the catch-all
 * for decommissions (and returns) written by a job or a discovery sweep rather
 * than the asset PUT route. Bounded per pass; idempotent.
 */
export async function reconcileAgentHostPins(): Promise<{ archived: number; reinstated: number }> {
  const [toArchive, toReinstate] = await Promise.all([
    prisma.managedAgent.findMany({
      where: { hostPinsArchivedAt: null, asset: { status: "decommissioned" } },
      select: { assetId: true },
      take: RECONCILE_BATCH,
    }),
    prisma.managedAgent.findMany({
      where: { hostPinsArchivedAt: { not: null }, asset: { status: { not: "decommissioned" } } },
      select: { assetId: true },
      take: RECONCILE_BATCH,
    }),
  ]);
  let archived = 0;
  let reinstated = 0;
  await inChunks(toArchive, async (r) => {
    try {
      if (await archiveAgentHostPins(r.assetId, "system")) archived++;
    } catch (err) {
      logger.warn({ err, assetId: r.assetId }, "agent host-pin archive failed");
    }
  });
  await inChunks(toReinstate, async (r) => {
    try {
      if (await reinstateAgentHostPins(r.assetId, "system")) {
        reinstated++;
        await resolvePendingCheckinConflicts(r.assetId, "system");
      }
    } catch (err) {
      logger.warn({ err, assetId: r.assetId }, "agent host-pin reinstate failed");
    }
  });
  return { archived, reinstated };
}

// ─── Fleet-wide views: the archive list and the thumbprint lookup ─────────

export interface ArchivedHostPin extends HostPin {
  archivedAt: string;
  asset: { id: string; hostname: string | null; ipAddress: string | null; status: string };
}

/**
 * Every pin held in an archive, for the Pinned server identities slide-over
 * (read-only there: an archived pin goes back only by reactivating its asset
 * or accepting the check-in conflict). One query — an archive is held only by
 * a decommissioned agent host.
 */
export async function listArchivedHostPins(): Promise<ArchivedHostPin[]> {
  const agents = await prisma.managedAgent.findMany({
    where: { hostPinsArchivedAt: { not: null } },
    select: {
      archivedHostPins: true,
      hostPinsArchivedAt: true,
      asset: { select: { id: true, hostname: true, ipAddress: true, status: true } },
    },
    orderBy: { hostPinsArchivedAt: "desc" },
  });
  return agents.flatMap((a) =>
    parseArchivedPins(a.archivedHostPins).map((p) => ({
      ...p,
      archivedAt: a.hostPinsArchivedAt!.toISOString(),
      asset: a.asset,
    })),
  );
}

/**
 * Read a search query as a thumbprint, or return null. `hex` is a TLS
 * SHA-256 fragment — only hex digits and the separators a thumbprint is
 * copied with (colons, spaces, dashes), compacted to upper-case hex. `ssh` is
 * an SSH fingerprint fragment, with or without the `SHA256:` prefix and its
 * padding, compared case-sensitively (base64 is). Each needs 8 characters, so
 * a short word never fans out over the pin tables. Pure.
 */
export function pinFingerprintQuery(raw: string): { hex: string | null; ssh: string | null } | null {
  const q = raw.trim();
  const hex = /^[0-9a-f:\s-]+$/i.test(q) ? q.replace(/[^0-9a-f]/gi, "").toUpperCase() : "";
  const body = q.replace(/^sha256:/i, "");
  const ssh = /^[A-Za-z0-9+/]+=*$/.test(body) ? body.replace(/=+$/, "") : "";
  const out = { hex: hex.length >= 8 ? hex : null, ssh: ssh.length >= 8 ? ssh : null };
  return out.hex || out.ssh ? out : null;
}

export interface PinFingerprintMatch {
  assetId: string;
  kind: "ssh" | "tls";
  host: string;
  port: number;
  /** The pin is in a decommissioned agent host's archive (rule 123), not live. */
  archived: boolean;
}

/**
 * Which assets a thumbprint belongs to — global search's pin lookup. A live
 * pin resolves through its host to every asset whose ipAddress / dnsName /
 * hostname is that string (the addresses `assetPinHosts` says Polaris may have
 * dialed); an archived one names its asset directly. A TLS pin matches on its
 * pinned or its now-presented fingerprint. One asset appears once, its first
 * match kept. Bounded: `limit` rows per table, one asset query.
 */
export async function findAssetsByPinFingerprint(raw: string, limit = 8): Promise<PinFingerprintMatch[]> {
  const fq = pinFingerprintQuery(raw);
  if (!fq) return [];
  const [tls, ssh, archives] = await Promise.all([
    fq.hex
      ? prisma.$queryRaw<{ host: string; port: number }[]>`
          SELECT host, port FROM tls_cert_pins
          WHERE replace(upper(fingerprint), ':', '') LIKE ${"%" + fq.hex + "%"}
             OR replace(upper(coalesce(pending_fingerprint, '')), ':', '') LIKE ${"%" + fq.hex + "%"}
          ORDER BY host, port LIMIT ${limit}`
      : Promise.resolve([]),
    fq.ssh
      ? prisma.sshHostKey.findMany({
          where: { fingerprint: { contains: fq.ssh } },
          select: { host: true, port: true },
          orderBy: [{ host: "asc" }, { port: "asc" }],
          take: limit,
        })
      : Promise.resolve([]),
    prisma.managedAgent.findMany({
      where: { hostPinsArchivedAt: { not: null } },
      select: { assetId: true, archivedHostPins: true },
    }),
  ]);

  const live: Array<{ kind: "ssh" | "tls"; host: string; port: number }> = [
    ...tls.map((r) => ({ kind: "tls" as const, host: r.host, port: Number(r.port) })),
    ...ssh.map((r) => ({ kind: "ssh" as const, host: r.host, port: r.port })),
  ];
  const hosts = [...new Set(live.map((p) => p.host))];
  const assets = hosts.length
    ? await prisma.asset.findMany({
        where: { OR: [{ ipAddress: { in: hosts } }, { dnsName: { in: hosts } }, { hostname: { in: hosts } }] },
        select: { id: true, hostname: true, ipAddress: true, dnsName: true },
        take: limit * 4,
      })
    : [];

  const out: PinFingerprintMatch[] = [];
  const seen = new Set<string>();
  const push = (m: PinFingerprintMatch) => {
    if (seen.has(m.assetId) || out.length >= limit) return;
    seen.add(m.assetId);
    out.push(m);
  };
  for (const p of live) {
    for (const a of assets) {
      if (assetPinHosts(a).includes(p.host)) push({ assetId: a.id, ...p, archived: false });
    }
  }
  for (const a of archives) {
    for (const p of parseArchivedPins(a.archivedHostPins)) {
      const hit = p.kind === "tls"
        ? !!fq.hex && normalizeHex(p.fingerprint).includes(fq.hex)
        : !!fq.ssh && p.fingerprint.includes(fq.ssh);
      if (hit) push({ assetId: a.assetId, kind: p.kind, host: p.host, port: p.port, archived: true });
    }
  }
  return out;
}

function normalizeHex(fp: string): string {
  return fp.replace(/[^0-9a-f]/gi, "").toUpperCase();
}
