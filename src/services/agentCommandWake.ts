/**
 * src/services/agentCommandWake.ts — cross-process "wake this agent" signal.
 *
 * When a command (today: an automation `run_script`) is enqueued for an agent,
 * we want the agent to pick it up immediately instead of waiting for its next
 * command poll (~20s). The agent already holds an outbound WebSocket
 * (agentChannelService); pushing a `commands-pending` frame over it makes
 * dispatch near-instant.
 *
 * But the WS session lives only in the process that accepted the upgrade (the
 * web/all role), while a script run is often enqueued from another process (the
 * automation engine in the monitor/all role). So the enqueue side emits a
 * Postgres NOTIFY (`publishCommandWake`), and the web/all role LISTENs
 * (agentChannelService.startCommandWakeListener) and pushes the WS frame.
 *
 * This is a best-effort latency optimization: the ~20s command poll remains the
 * guaranteed delivery floor if the NOTIFY is missed or the agent's WS is down.
 * NOTIFY works fine through PgBouncer; only the LISTEN side needs a session-
 * pinned direct connection (handled in agentChannelService).
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";

/** Postgres LISTEN/NOTIFY channel (lowercase — unquoted identifiers fold to it). */
export const CMD_WAKE_CHANNEL = "polaris_agent_cmd_wake";

/**
 * Sibling channel: "this agent's config changed — refetch it". Used when a
 * connectivity check is created, edited or re-scoped: the reconcile that
 * notices runs wherever the write or the scheduler job ran, while the WS
 * session lives in the web/all role. Payload is a comma-joined list of
 * managedAgentIds. The heartbeat's configEtag (≤ one heartbeat interval) stays
 * the guaranteed floor, exactly as the command poll is for the wake above.
 */
export const CFG_REFRESH_CHANNEL = "polaris_agent_cfg_refresh";

/** pg_notify payloads are capped at 8000 bytes; a uuid plus comma is 37. */
const REFRESH_IDS_PER_NOTIFY = 150;

/** Best-effort, never throws. */
export async function publishConfigRefresh(managedAgentIds: readonly string[]): Promise<void> {
  const ids = [...new Set(managedAgentIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += REFRESH_IDS_PER_NOTIFY) {
    const payload = ids.slice(i, i + REFRESH_IDS_PER_NOTIFY).join(",");
    try {
      await prisma.$executeRaw`SELECT pg_notify(${CFG_REFRESH_CHANNEL}, ${payload})`;
    } catch (err) {
      logger.debug({ err }, "publishConfigRefresh NOTIFY failed (agents pick the change up on heartbeat)");
      return;
    }
  }
}

/**
 * Best-effort: signal that a command is pending for `managedAgentId`. Delivered
 * to whichever process holds that agent's WS session. Never throws — a failed
 * NOTIFY just means the agent falls back to its command poll.
 */
export async function publishCommandWake(managedAgentId: string): Promise<void> {
  if (!managedAgentId) return;
  try {
    // pg_notify() parameterizes the payload safely (plain NOTIFY can't).
    await prisma.$executeRaw`SELECT pg_notify(${CMD_WAKE_CHANNEL}, ${managedAgentId})`;
  } catch (err) {
    logger.debug({ err, managedAgentId }, "publishCommandWake NOTIFY failed (agent will poll)");
  }
}
