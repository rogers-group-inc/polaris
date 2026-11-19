/**
 * src/services/agentAddressService.ts — the asset's own agent decides its
 * primary address (business rule 195).
 *
 * Three pieces, one decision:
 *
 *   confirmedAgentAddress   — on every system-info push: the address the agent
 *                             connected from, if it is private and one the
 *                             agent reports (utils/agentAddress.ts). Stored on
 *                             the polaris-agent AssetSource blob as
 *                             `confirmedIp`, which the projection ranks above
 *                             every observer below Fortinet infra.
 *   applyAgentAddress       — the same push writes the projected address at
 *                             once, rather than waiting for a discovery run.
 *                             Never on a pinned asset (any of the three pins).
 *   loadAgentHeldAddressAssetIds — discovery's DHCP / detected-device / ARP
 *                             ladder (rule 101) reads this once per run and
 *                             does not stage ipAddress for these assets.
 *                             Without it every FortiManager run would move
 *                             the asset to the gate's address and the
 *                             end-of-run projection would move it back.
 */

import { prisma } from "../db.js";
import { logEvent } from "./eventLogService.js";
import { AGENT_ADDRESS_FRESH_MS, confirmAgentAddress } from "../utils/agentAddress.js";
import { projectAssetFromSources } from "../utils/assetProjection.js";

/** The address the agent vouches for on this push, or null. */
export async function confirmedAgentAddress(
  assetId: string,
  sourceIp: string | null | undefined,
  primaryIp: string | null | undefined,
): Promise<string | null> {
  if (!sourceIp) return null;
  const rows = await prisma.assetAssociatedIp.findMany({
    where: { assetId, source: "agent-interface" },
    select: { ip: true },
  });
  return confirmAgentAddress({ sourceIp, primaryIp, reportedIps: rows.map((r) => r.ip) });
}

/**
 * Re-project the address and write it when it changed. Returns the new
 * address, or null when nothing was written.
 */
export async function applyAgentAddress(assetId: string, now: Date = new Date()): Promise<string | null> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: {
      id: true, hostname: true, ipAddress: true,
      ipOverride: true, ipBlankPinned: true, primaryAddressIp: true,
    },
  });
  if (!asset) return null;
  // An operator's choice stands; discovery's vote on a typed override is
  // discovery's to raise, not a 5-minute heartbeat's.
  if (asset.ipOverride || asset.ipBlankPinned || asset.primaryAddressIp) return null;

  const sources = await prisma.assetSource.findMany({
    where: { assetId },
    select: { sourceKind: true, inferred: true, observed: true, lastSeen: true },
  });
  const { projected, provenance } = projectAssetFromSources(
    sources.map((s) => ({
      sourceKind: s.sourceKind,
      inferred: s.inferred,
      observed: s.observed as Record<string, unknown> | null,
      lastSeen: s.lastSeen,
    })),
    { now },
  );
  // Only the agent's own answer is this path's to write; any other winner is
  // discovery's, applied on its own run.
  if (provenance.ipAddress !== "polaris-agent" || !projected.ipAddress) return null;
  if (projected.ipAddress === asset.ipAddress) return null;

  await prisma.asset.update({
    where: { id: assetId },
    data: { ipAddress: projected.ipAddress, ipSource: "polaris-agent" },
  });
  void logEvent({
    action: "asset.address.agent",
    resourceType: "asset",
    resourceId: assetId,
    resourceName: asset.hostname || projected.ipAddress,
    actor: "system:agent",
    level: "info",
    message: `Primary address of "${asset.hostname || assetId}" moved to ${projected.ipAddress}` +
      (asset.ipAddress ? ` (was ${asset.ipAddress})` : "") +
      " — the address its agent connects from",
    details: { from: asset.ipAddress, to: projected.ipAddress, rule: 195 },
  });
  return projected.ipAddress;
}

/**
 * Assets whose primary address their agent currently holds: a polaris-agent
 * source with a confirmed address, pushed within AGENT_ADDRESS_FRESH_MS. One
 * query per discovery run; the blob is the agent's small identity record.
 */
export async function loadAgentHeldAddressAssetIds(now: Date = new Date()): Promise<Set<string>> {
  const rows = await prisma.assetSource.findMany({
    where: {
      sourceKind: "polaris-agent",
      inferred: false,
      lastSeen: { gte: new Date(now.getTime() - AGENT_ADDRESS_FRESH_MS) },
    },
    select: { assetId: true, observed: true },
  });
  const out = new Set<string>();
  for (const r of rows) {
    const ip = (r.observed as Record<string, unknown> | null)?.confirmedIp;
    if (typeof ip === "string" && ip.trim() !== "") out.add(r.assetId);
  }
  return out;
}
