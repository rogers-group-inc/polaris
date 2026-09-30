/**
 * src/api/routes/agentsWs.ts — Polaris Agent WebSocket upgrade handler
 *
 * Express doesn't route raw HTTP `upgrade` events through its middleware
 * stack; the Node `http.Server.on("upgrade", ...)` event has to be wired
 * separately. `attachAgentWsUpgradeHandler` does that — mounted twice from
 * src/app.ts (once on the plain HTTP server, once inside httpsManager on
 * the HTTPS server) so both transports accept agent connections.
 *
 * Auth model: bearer in `Sec-WebSocket-Protocol` subprotocol, format
 * `polaris-agent.v1.bearer.<token>`. The subprotocol header keeps the
 * token out of access logs (URL query strings would leak it). On
 * successful verification we echo the protocol name back in the response
 * upgrade headers so the agent's WS library accepts the handshake; the
 * `<token>` half is rejected from the echo to avoid loop-back leakage.
 *
 * Phase 3b: bare-minimum implementation. Once the upgrade succeeds we
 * hand the socket to `agentChannelService.attach()` and from that point
 * on it's frame-by-frame application code.
 */

import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer } from "ws";
import { verifyBearer } from "../../services/agentTokenService.js";
import { attach } from "../../services/agentChannelService.js";
import { logger } from "../../utils/logger.js";

const SUBPROTOCOL_PREFIX = "polaris-agent.v1.bearer.";
const PATH = "/api/v1/agents/ws";

// We construct one WebSocketServer per Node http(s) Server. `noServer: true`
// means we drive the upgrade handshake ourselves (so we can do bearer auth
// before handing off). Each instance is small — a few hundred bytes of
// state — so creating one per attach is fine.
export function attachAgentWsUpgradeHandler(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", async (req: IncomingMessage, socket: Socket, head: Buffer) => {
    try {
      // Only handle our path; let other upgrade handlers (none today, but
      // future code paths might add some) see other URLs untouched.
      const url = new URL(req.url ?? "/", "http://placeholder");
      if (url.pathname !== PATH) return;

      // Extract the bearer from Sec-WebSocket-Protocol. Library + browser
      // implementations send subprotocols as a comma-separated header;
      // we look for the one that starts with our prefix.
      const protocolHeader = req.headers["sec-websocket-protocol"];
      const protocols = String(protocolHeader ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const tokenProto = protocols.find((p) => p.startsWith(SUBPROTOCOL_PREFIX));
      if (!tokenProto) {
        rejectUpgrade(socket, 401, "Missing polaris-agent.v1.bearer.<token> subprotocol");
        return;
      }
      const rawBearer = tokenProto.slice(SUBPROTOCOL_PREFIX.length);
      const callerIp = req.socket.remoteAddress ?? null;

      // The verify is an argon2 check on the libuv pool, and after a server
      // restart every agent's WS and REST calls queue on it at once — long
      // enough to outlast the agent's 10s handshake timeout. An agent that gave
      // up has already redialed; finishing ITS abandoned upgrade would attach a
      // dead socket that displaces the live retry. Watch the socket while we
      // wait and drop the upgrade if it went away.
      let abandoned = false;
      const markAbandoned = () => { abandoned = true; };
      socket.once("close", markAbandoned);
      socket.once("end", markAbandoned);
      let verified: Awaited<ReturnType<typeof verifyBearer>>;
      try {
        verified = await verifyBearer(rawBearer, callerIp);
      } finally {
        socket.off("close", markAbandoned);
        socket.off("end", markAbandoned);
      }
      if (upgradeAbandoned(socket, abandoned)) {
        logger.info({ callerIp }, "Agent WS upgrade abandoned by the agent during bearer verify — dropped");
        try { socket.destroy(); } catch { /* already gone */ }
        return;
      }
      if (!verified) {
        rejectUpgrade(socket, 401, "Invalid or revoked agent bearer");
        return;
      }

      // Pass the upgrade through to `ws`. We intentionally don't echo
      // back any subprotocol — sending the bearer-bearing one would put
      // a secret in the response headers, and the `ws` Node client
      // accepts a no-protocol response by default. The agent reads the
      // bearer back from agent.conf, never from the upgrade response.
      wss.handleUpgrade(req, socket, head, (ws) => {
        attach(verified.managedAgentId, verified.assetId, ws);
      });
    } catch (err) {
      logger.warn({ err }, "Agent WS upgrade handler crashed");
      try { rejectUpgrade(socket, 500, "Internal error"); } catch { /* socket already gone */ }
    }
  });
}

/** True when the agent hung up on this upgrade before we could answer it. */
export function upgradeAbandoned(
  socket: Pick<Socket, "destroyed" | "readable" | "writable">,
  sawCloseOrEnd: boolean,
): boolean {
  return sawCloseOrEnd || socket.destroyed || !socket.readable || !socket.writable;
}

function rejectUpgrade(socket: Socket, status: number, reason: string): void {
  const body = `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
  try { socket.write(body); } catch { /* peer already gone */ }
  try { socket.destroy(); } catch { /* idem */ }
}
