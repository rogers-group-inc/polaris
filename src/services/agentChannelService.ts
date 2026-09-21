/**
 * src/services/agentChannelService.ts — Polaris Agent WebSocket session manager
 *
 * Holds the in-memory map of `managedAgentId → WebSocket` for every
 * currently-attached agent and exposes verbs the rest of Polaris uses to
 * push frames at them:
 *
 *  - `attach(managedAgentId, ws, assetId)` — register, send hello frame,
 *    schedule heartbeat ping, emit `agent.connected` event, bump
 *    `wsConnectedAt`. Idempotent: replacing an existing attachment for
 *    the same agentId closes the old socket (an operator who reinstalled
 *    on the same host gets one live session, not two).
 *
 *  - `detach(managedAgentId, reason)` — remove from the map, close the
 *    socket if still open, stamp `wsDisconnectedAt`, emit `agent.disconnected`.
 *
 *  - `sendProbeNow(managedAgentId, stream, timeoutMs)` — server-initiated
 *    pull. Send a `probe-now-request` frame and await the matching
 *    `probe-now-response` by request-id. Resolves with the result; rejects
 *    on timeout. Used by `POST /api/v1/assets/:id/probe-now` when the
 *    asset's resolved transport is "agent".
 *
 *  - `refreshConfig(managedAgentId)` — send a `refresh-config` frame so
 *    the agent re-fetches /config immediately instead of waiting for its
 *    next poll. Called whenever the operator updates a setting that
 *    might affect agent-mode cadences/streams.
 *
 * Frame envelope (kept deliberately small):
 *
 *   { "type": "<verb>", "id": "<request-id-or-empty>", "payload": {...} }
 *
 * The id field correlates request/response pairs for probe-now; for
 * one-way frames (hello / refresh-config / heartbeat) it's empty/ignored.
 *
 * Heartbeat: server sends a ping frame every 30s; the WS library's built-
 * in pong handling tracks liveness. Two missed pongs (60s without any
 * traffic) → the server force-closes the connection and the agent's
 * reconnect-with-backoff loop kicks in. Set HEARTBEAT_INTERVAL_MS to
 * change.
 */

import type { WebSocket } from "ws";
import pg from "pg";
import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import { releaseMaintenanceHold } from "./maintenanceScheduleService.js";
import { getDirectDatabaseUrl } from "../utils/dbConnections.js";
import { CMD_WAKE_CHANNEL } from "./agentCommandWake.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const PROBE_NOW_DEFAULT_TIMEOUT_MS = 10_000;

interface Session {
  ws:        WebSocket;
  assetId:   string;
  /**
   * hostname || ipAddress, resolved once at attach. Held here so `detach` can
   * NAME the device without a database read on a teardown path that runs when
   * a socket has already died — and so both events agree on the label.
   */
  assetName: string | null;
  attachedAt: number;
  // Pending probe-now requests awaiting a matching response.
  pending:   Map<string, { resolve: (v: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>;
  // Heartbeat ping timer; cleared in detach().
  pingTimer: NodeJS.Timeout | null;
  // Set true when we see a pong for the last ping; reset to false on each ping.
  pongSeen:  boolean;
}

const sessions = new Map<string, Session>();

// ─── Lifecycle ────────────────────────────────────────────────────────

export function attach(managedAgentId: string, assetId: string, ws: WebSocket): void {
  // Replace any existing session — the new attach wins. (Operator reinstall
  // on the same host stamps a fresh row; or a transient network blip caused
  // the agent to reconnect before our half noticed the drop.)
  const existing = sessions.get(managedAgentId);
  if (existing) {
    logger.info({ managedAgentId }, "Replacing existing agent WS session");
    teardown(existing, "replaced");
  }

  const session: Session = {
    ws,
    assetId,
    assetName: null, // filled in below, before either event is written
    attachedAt: Date.now(),
    pending: new Map(),
    pingTimer: null,
    pongSeen: true, // assume alive on attach so we don't kill ourselves on the first ping cycle
  };
  sessions.set(managedAgentId, session);

  // Server-→client lifecycle frame so the agent's app-layer code knows
  // the handshake is complete (TLS + upgrade succeeded). The agent
  // doesn't depend on this for correctness; it's diagnostic.
  safeSend(ws, { type: "hello", id: "", payload: { managedAgentId } });

  // Wire incoming frames (only thing we expect at this layer is
  // probe-now-response; other frame types are forwarded to handlers).
  ws.on("message", (data) => onFrame(managedAgentId, data));
  ws.on("pong", () => { session.pongSeen = true; });
  ws.on("close", (code, reason) => {
    detach(managedAgentId, `socket closed: ${code} ${reason.toString().slice(0, 80)}`);
  });
  ws.on("error", (err) => {
    logger.warn({ err, managedAgentId }, "Agent WS error");
    detach(managedAgentId, "socket error");
  });

  // Heartbeat — ping every 30s; if no pong came back since the last ping,
  // tear down. ws.ping() returns immediately; the pong handler above
  // flips pongSeen=true when the agent replies.
  session.pingTimer = setInterval(() => {
    if (!session.pongSeen) {
      detach(managedAgentId, "heartbeat timeout");
      return;
    }
    session.pongSeen = false;
    try { ws.ping(); } catch { /* let the close handler do its job */ }
  }, HEARTBEAT_INTERVAL_MS);

  void prisma.managedAgent.update({
    where: { id: managedAgentId },
    data:  { wsConnectedAt: new Date() },
  }).catch(() => { /* best-effort */ });

  void (async () => {
    // Name the device. An `asset` Event with no resourceName gives the alert no
    // subject at all (alertSubject.eventSubjectLabel returns "" for one), so
    // every automation on agent.connected/disconnected rendered a row and an
    // email that never said WHICH agent — the one fact those alerts exist to
    // carry.
    const asset = await prisma.asset
      .findUnique({ where: { id: assetId }, select: { hostname: true, ipAddress: true } })
      .catch(() => null);
    const name = asset?.hostname || asset?.ipAddress || null;
    // The session may already be gone (a socket that died during this read),
    // and a stale entry must not be re-stamped — check identity, not presence.
    if (sessions.get(managedAgentId) === session) session.assetName = name;

    await logEvent({
      action:       "agent.connected",
      resourceType: "asset",
      resourceId:   assetId,
      resourceName: name ?? undefined,
      level:        "info",
      message:      "Polaris Agent WebSocket attached",
      details:      { managedAgentId },
    });

    // The agent is back, so whatever Polaris was doing to this host is over as
    // far as its monitoring is concerned: release the upgrade/reinstall hold
    // (business rule 80). Release here rather than when the installer returned
    // — the reattach is the first moment the asset is genuinely being watched
    // again, and a hold dropped earlier lets the lagging disconnect through.
    // Not "agent-uninstall": that one ends with the uninstall, and an agent
    // reattaching during one has not finished being removed.
    for (const kind of ["agent-upgrade", "agent-reinstall"] as const) {
      await releaseMaintenanceHold({ assetId, kind }).catch(() => { /* expiry covers it */ });
    }
  })();
}

export function detach(managedAgentId: string, reason: string): void {
  const session = sessions.get(managedAgentId);
  if (!session) return;
  sessions.delete(managedAgentId);
  teardown(session, reason);
  void prisma.managedAgent.update({
    where: { id: managedAgentId },
    data:  { wsDisconnectedAt: new Date() },
  }).catch(() => { /* best-effort */ });
  void logEvent({
    action:       "agent.disconnected",
    resourceType: "asset",
    resourceId:   session.assetId,
    // Without this the alert has no subject: an operator reading "a Polaris
    // Agent disconnected" on the widget could not tell WHICH host it was.
    resourceName: session.assetName ?? undefined,
    level:        reason === "replaced" || reason === "revoked" ? "info" : "warning",
    message:      session.assetName
      ? `Polaris Agent WebSocket detached from ${session.assetName} (${reason})`
      : `Polaris Agent WebSocket detached (${reason})`,
    details:      { managedAgentId, reason },
  });
}

function teardown(session: Session, _reason: string): void {
  if (session.pingTimer) clearInterval(session.pingTimer);
  for (const p of session.pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error("Agent disconnected"));
  }
  session.pending.clear();
  try { session.ws.close(); } catch { /* already closed */ }
}

export function isAttached(managedAgentId: string): boolean {
  return sessions.has(managedAgentId);
}

// ─── Frame dispatch ───────────────────────────────────────────────────

interface Frame {
  type:    string;
  id:      string;
  payload: unknown;
}

function onFrame(managedAgentId: string, data: unknown): void {
  let frame: Frame;
  try {
    const text = typeof data === "string" ? data : (data as Buffer).toString("utf8");
    frame = JSON.parse(text);
  } catch (err) {
    logger.warn({ err, managedAgentId }, "Agent WS frame parse failed");
    return;
  }
  if (frame.type === "probe-now-response") {
    const session = sessions.get(managedAgentId);
    if (!session) return;
    const pending = session.pending.get(frame.id);
    if (!pending) return; // probably timed out before the response arrived
    session.pending.delete(frame.id);
    clearTimeout(pending.timer);
    pending.resolve(frame.payload);
  }
  // Other inbound frame types (hello-ack, etc.) are accepted but ignored
  // for now — Phase 3b only needs probe-now plumbing.
}

// ─── Server-initiated verbs ───────────────────────────────────────────

export interface ProbeNowResult {
  success:        boolean;
  responseTimeMs?: number;
  error?:          string;
}

export function sendProbeNow(
  managedAgentId: string,
  stream: "responseTime" | "telemetry" | "interfaces" | "storage",
  timeoutMs: number = PROBE_NOW_DEFAULT_TIMEOUT_MS,
): Promise<ProbeNowResult> {
  const session = sessions.get(managedAgentId);
  if (!session) {
    return Promise.reject(new Error("Agent is not currently attached — try again after the agent reconnects"));
  }

  const id = randomFrameId();
  const send = { type: "probe-now-request", id, payload: { stream } };

  return new Promise<ProbeNowResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error(`Agent did not respond to probe-now within ${timeoutMs}ms`));
    }, timeoutMs);
    session.pending.set(id, {
      resolve: (v) => resolve(v as ProbeNowResult),
      reject,
      timer,
    });
    safeSend(session.ws, send);
  });
}

export function refreshConfig(managedAgentId: string): void {
  const session = sessions.get(managedAgentId);
  if (!session) return;
  safeSend(session.ws, { type: "refresh-config", id: "", payload: {} });
}

// Nudge an attached agent to fetch its pending commands immediately instead of
// waiting for its ~20s command poll. No-op when the agent isn't attached (it
// picks the command up on its next poll — the guaranteed floor). Fed by the
// cross-process command-wake listener below.
export function wakeCommands(managedAgentId: string): void {
  const session = sessions.get(managedAgentId);
  if (!session) return;
  safeSend(session.ws, { type: "commands-pending", id: "", payload: {} });
}

// ─── Helpers ──────────────────────────────────────────────────────────

function safeSend(ws: WebSocket, frame: unknown): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch (err) {
    logger.warn({ err }, "Agent WS send failed");
  }
}

function randomFrameId(): string {
  // Short id is fine — only needs to be unique within one session's
  // in-flight set. Crypto-strength isn't required.
  return Math.random().toString(36).slice(2, 12);
}

// Test/diag — count of live sessions. Used by /metrics in a follow-on commit.
export function liveSessionCount(): number {
  return sessions.size;
}

// Shutdown hook: graceful close on SIGTERM/SIGINT. Wired from src/app.ts.
export async function shutdownAllSessions(): Promise<void> {
  stopCommandWakeListener();
  const ids = Array.from(sessions.keys());
  for (const id of ids) {
    detach(id, "server shutdown");
  }
}

// ─── Cross-process command-wake listener (web/all role) ───────────────
//
// A dedicated Postgres session LISTENing on CMD_WAKE_CHANNEL. When any process
// enqueues a command and calls publishCommandWake (agentCommandWake.ts), the
// NOTIFY lands here and we push a `commands-pending` WS frame to that agent if
// it's attached to this process. Best-effort — the agent's command poll is the
// guaranteed floor. LISTEN needs a session-pinned connection, so this uses the
// DIRECT database URL (PgBouncer transaction pooling would break it).

let wakeClient: pg.Client | null = null;
let wakeReconnectTimer: NodeJS.Timeout | null = null;
let wakeListenerStopped = false;

export async function startCommandWakeListener(): Promise<void> {
  wakeListenerStopped = false;
  await connectWakeListener();
}

async function connectWakeListener(): Promise<void> {
  if (wakeListenerStopped) return;
  const url = getDirectDatabaseUrl();
  if (!url) {
    logger.warn("Agent command-wake listener: no database URL — near-real-time dispatch disabled (agents still poll)");
    return;
  }
  const client = new pg.Client({ connectionString: url });
  client.on("notification", (msg) => {
    if (msg.payload) wakeCommands(msg.payload);
  });
  client.on("error", (err) => {
    logger.warn({ err: err.message }, "Agent command-wake listener error — reconnecting");
    scheduleWakeReconnect();
  });
  try {
    await client.connect();
    await client.query(`LISTEN ${CMD_WAKE_CHANNEL}`);
    wakeClient = client;
    logger.info("Agent command-wake listener attached");
  } catch (err) {
    logger.warn({ err }, "Agent command-wake listener connect failed — retrying");
    try { await client.end(); } catch { /* ignore */ }
    scheduleWakeReconnect();
  }
}

function scheduleWakeReconnect(): void {
  if (wakeListenerStopped || wakeReconnectTimer) return;
  if (wakeClient) { try { void wakeClient.end(); } catch { /* ignore */ } wakeClient = null; }
  wakeReconnectTimer = setTimeout(() => {
    wakeReconnectTimer = null;
    void connectWakeListener();
  }, 5000);
}

function stopCommandWakeListener(): void {
  wakeListenerStopped = true;
  if (wakeReconnectTimer) { clearTimeout(wakeReconnectTimer); wakeReconnectTimer = null; }
  if (wakeClient) { try { void wakeClient.end(); } catch { /* ignore */ } wakeClient = null; }
}
