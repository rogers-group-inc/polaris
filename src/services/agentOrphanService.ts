/**
 * src/services/agentOrphanService.ts — the Polaris Agent that outlives its
 * asset record (business rule 163).
 *
 * `ManagedAgent` cascades with its asset, so deleting an asset (or merging one
 * away while the survivor already has an agent of its own) removes the agent's
 * ROW — and with it the bearer token, the Agent card and its Uninstall button.
 * It does nothing on the host: the binary, the service unit, `agent.conf`, and
 * any reboot opt-in stay installed and running, sending requests Polaris now
 * answers with 401, for good. The 2026-11-11 orphan audit found no path that
 * warned about this and no record that it had happened.
 *
 * Operator decision (2026-11-11): deleting such an asset WARNS, offers to try
 * the uninstall first, and — if the uninstall fails — says so and asks whether
 * to delete anyway. The orchestration is the browser's (it is a conversation
 * with the operator, and the uninstall is asynchronous). This service is the
 * server's two parts:
 *
 *   `listAgentHosts(ids)`           which of these assets have an agent — the
 *                                   delete dialogs ask before they confirm.
 *   `recordAgentsLeftOnHosts(...)`  when a delete or merge goes ahead anyway,
 *                                   close the agent's live session and write a
 *                                   warning Event naming the host, so there is
 *                                   a record of what is still out there.
 *
 * It never refuses a delete: an API client, or an operator who has decided,
 * may leave an agent behind. It makes sure that is never silent.
 */

import { prisma } from "../db.js";
import { chunkArray } from "../utils/chunk.js";
import { logEvent } from "./eventLogService.js";
import { detach } from "./agentChannelService.js";

const ID_CHUNK = 500;

export interface AgentHost {
  assetId: string;
  managedAgentId: string;
  /** What to call the host in a dialog or an Event. */
  name: string;
  installStatus: string;
  agentVersion: string | null;
}

/**
 * The assets among `assetIds` that have a Polaris Agent record, in any install
 * state — a failed or half-removed agent may still have left files on the
 * host, so it is still worth a warning. One indexed read per 500 ids.
 */
export async function listAgentHosts(assetIds: readonly string[]): Promise<AgentHost[]> {
  const out: AgentHost[] = [];
  for (const chunk of chunkArray([...new Set(assetIds)], ID_CHUNK)) {
    const rows = await prisma.managedAgent.findMany({
      where: { assetId: { in: chunk } },
      select: {
        id: true, assetId: true, installStatus: true, agentVersion: true,
        asset: { select: { hostname: true, ipAddress: true } },
      },
    });
    for (const r of rows) {
      out.push({
        assetId: r.assetId,
        managedAgentId: r.id,
        name: r.asset?.hostname || r.asset?.ipAddress || r.assetId,
        installStatus: r.installStatus,
        agentVersion: r.agentVersion,
      });
    }
  }
  return out;
}

export type AgentLeftReason = "asset-deleted" | "asset-merged";

/**
 * Call AFTER the asset rows (and so their `ManagedAgent` rows) are gone, with
 * the hosts read beforehand. Closes each agent's WebSocket session — otherwise
 * it and its 30 s ping timer live until the agent stops or the web role
 * restarts, and a late disconnect Event names a record that no longer exists —
 * and writes one warning Event per host.
 *
 * The Event is filed against the INTEGRATION-less "agent" resource rather than
 * the asset: the asset id no longer resolves, and an Event that points at a
 * deleted record cannot be opened from the Events page.
 */
export async function recordAgentsLeftOnHosts(
  hosts: readonly AgentHost[],
  opts: { actor?: string; reason: AgentLeftReason; survivorName?: string },
): Promise<number> {
  if (hosts.length === 0) return 0;
  for (const h of hosts) {
    try { detach(h.managedAgentId, "revoked"); } catch { /* no session in this process */ }
  }
  const why = opts.reason === "asset-merged"
    ? `its record was merged into ${opts.survivorName ? `"${opts.survivorName}"` : "another asset"}, which already had an agent of its own`
    : "its asset record was deleted";
  await Promise.all(hosts.map((h) => logEvent({
    action: "agent.left_on_host",
    resourceType: "agent",
    resourceId: h.managedAgentId,
    resourceName: h.name,
    actor: opts.actor,
    level: "warning",
    message: `The Polaris Agent is still installed on ${h.name}: ${why}. Polaris no longer accepts its token and can no longer uninstall it — remove it on the host.`,
    details: {
      reason: opts.reason, assetId: h.assetId, managedAgentId: h.managedAgentId,
      installStatus: h.installStatus, agentVersion: h.agentVersion,
    },
  })));
  return hosts.length;
}
