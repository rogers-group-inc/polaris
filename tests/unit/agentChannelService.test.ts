/**
 * tests/unit/agentChannelService.test.ts — services/agentChannelService.ts,
 * the in-memory agent WebSocket registry (rule 119(d), rule 80 hold release,
 * rule 115(a)).
 *
 * The naming of agent.connected / agent.disconnected, the hold release, the
 * replaced-socket scoping and the abandoned-upgrade drop are pinned by
 * tests/unit/agentChannelEvents.test.ts; asFrame and the malformed-frame
 * listener by tests/unit/agentChannelMalformedFrame.test.ts. This suite covers
 * the rest of the contract: the hello frame, the wsConnectedAt /
 * wsDisconnectedAt stamps, the heartbeat (ping every 30 s, a silent agent
 * force-closed), the detach level by reason, refreshConfig, the frame
 * handler's throw-closes-the-socket safety net, and the cross-process
 * command-wake LISTENer (direct URL, both channels, fixed 5 s reconnect).
 *
 * The module keeps its sessions and its LISTEN client in module state: every
 * test detaches what it attached and runs any reconnect timer to completion.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const h = vi.hoisted(() => {
  const clients: Array<EventEmitter & { opts: unknown; connect: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }> = [];
  const behaviour = { connectFails: false };
  return {
    clients, behaviour,
    directUrl: { value: "" as string },
    releaseMaintenanceHold: vi.fn(async (_hold: unknown) => true),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  };
});

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/maintenanceScheduleService.js", () => ({ releaseMaintenanceHold: h.releaseMaintenanceHold }));
vi.mock("../../src/utils/dbConnections.js", () => ({ getDirectDatabaseUrl: () => h.directUrl.value }));
vi.mock("../../src/utils/logger.js", () => ({ logger: h.logger }));
vi.mock("pg", async () => {
  const { EventEmitter: EE } = await import("node:events");
  const { vi: v } = await import("vitest");
  class Client extends EE {
    opts: unknown;
    connect = v.fn(async () => { if (h.behaviour.connectFails) throw new Error("ECONNREFUSED"); });
    query = v.fn(async () => ({ rows: [] }));
    end = v.fn(async () => undefined);
    constructor(opts: unknown) { super(); this.opts = opts; h.clients.push(this as never); }
  }
  return { default: { Client } };
});

import * as svc from "../../src/services/agentChannelService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { CMD_WAKE_CHANNEL as CMD, CFG_REFRESH_CHANNEL as CFG } from "../../src/services/agentCommandWake.js";

function fakeWs() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    handlers,
    readyState: 1,
    sent: [] as string[],
    send: vi.fn(function (this: { sent: string[] }, d: string) { this.sent.push(d); }),
    ping: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
    on(event: string, fn: (...args: unknown[]) => void) { handlers.set(event, fn); return this; },
  };
}
const frames = (ws: ReturnType<typeof fakeWs>) => ws.sent.map((s) => JSON.parse(s));
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => {
  h.clients.length = 0;
  h.behaviour.connectFails = false;
  h.directUrl.value = "";
  h.releaseMaintenanceHold.mockClear();
  for (const f of Object.values(h.logger)) f.mockReset();
  resetDbStub();
  resetEventLogStub();
  stubbed(prisma.managedAgent.update).mockResolvedValue({});
  stubbed(prisma.asset.findUnique).mockResolvedValue({ hostname: "app-01", ipAddress: "10.0.0.9" });
});

afterEach(() => { vi.useRealTimers(); });

// ─── attach / detach ───────────────────────────────────────────────────────

describe("attach", () => {
  it("registers the session, sends the hello frame and stamps wsConnectedAt", async () => {
    const ws = fakeWs();
    svc.attach("ma-1", "asset-1", ws as never);
    expect(svc.isAttached("ma-1")).toBe(true);
    expect(frames(ws)).toEqual([{ type: "hello", id: "", payload: { managedAgentId: "ma-1" } }]);
    expect(stubbed(prisma.managedAgent.update).mock.calls[0][0]).toEqual({ where: { id: "ma-1" }, data: { wsConnectedAt: expect.any(Date) } });
    await settle();
    expect(eventLog.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "agent.connected", resourceId: "asset-1", level: "info" }));
    svc.detach("ma-1", "test");
  });

  it("a failed wsConnectedAt stamp or hello send never breaks the attach", async () => {
    stubbed(prisma.managedAgent.update).mockRejectedValue(new Error("db down"));
    const ws = fakeWs();
    ws.send.mockImplementation(() => { throw new Error("socket closing"); });
    expect(() => svc.attach("ma-1", "asset-1", ws as never)).not.toThrow();
    await settle();
    expect(svc.isAttached("ma-1")).toBe(true);
    expect(h.logger.warn).toHaveBeenCalledWith(expect.anything(), "Agent WS send failed");
    svc.detach("ma-1", "test");
  });

  it("a second attach for the same agent closes the first socket and keeps one session", () => {
    const a = fakeWs();
    const b = fakeWs();
    svc.attach("ma-1", "asset-1", a as never);
    svc.attach("ma-1", "asset-1", b as never);
    expect(a.close).toHaveBeenCalled();
    expect(b.close).not.toHaveBeenCalled();
    svc.refreshConfig("ma-1");
    expect(frames(b).map((f) => f.type)).toEqual(["hello", "refresh-config"]);
    expect(frames(a).map((f) => f.type)).toEqual(["hello"]);
    svc.detach("ma-1", "test");
  });
});

describe("detach", () => {
  it("is a no-op for an agent that is not attached", () => {
    svc.detach("nobody", "revoked");
    expect(prisma.managedAgent.update).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("closes the socket, stamps wsDisconnectedAt and writes agent.disconnected at the reason's level", async () => {
    for (const [reason, level] of [["revoked", "info"], ["replaced", "info"], ["socket error", "warning"], ["operator action", "warning"]] as const) {
      const ws = fakeWs();
      svc.attach("ma-1", "asset-1", ws as never);
      await settle();
      eventLog.logEvent.mockClear();
      stubbed(prisma.managedAgent.update).mockClear();
      svc.detach("ma-1", reason);
      expect(ws.close).toHaveBeenCalled();
      expect(svc.isAttached("ma-1")).toBe(false);
      expect(stubbed(prisma.managedAgent.update).mock.calls[0][0]).toEqual({ where: { id: "ma-1" }, data: { wsDisconnectedAt: expect.any(Date) } });
      expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "agent.disconnected", level, details: { managedAgentId: "ma-1", reason } });
    }
  });

  it("a socket whose close() throws is still detached", () => {
    const ws = fakeWs();
    ws.close.mockImplementation(() => { throw new Error("already closed"); });
    svc.attach("ma-1", "asset-1", ws as never);
    expect(() => svc.detach("ma-1", "revoked")).not.toThrow();
    expect(svc.isAttached("ma-1")).toBe(false);
  });
});

// ─── heartbeat ─────────────────────────────────────────────────────────────

describe("heartbeat", () => {
  it("pings every 30 s while pongs come back", async () => {
    vi.useFakeTimers();
    const ws = fakeWs();
    svc.attach("ma-1", "asset-1", ws as never);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.ping).toHaveBeenCalledTimes(1);
    ws.handlers.get("pong")!();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.ping).toHaveBeenCalledTimes(2);
    expect(svc.isAttached("ma-1")).toBe(true);
    svc.detach("ma-1", "test");
  });

  it("an agent that misses a pong is force-closed at the next tick with a warning", async () => {
    vi.useFakeTimers();
    const ws = fakeWs();
    svc.attach("ma-1", "asset-1", ws as never);
    await vi.advanceTimersByTimeAsync(30_000); // ping, pongSeen = false
    eventLog.logEvent.mockClear();
    await vi.advanceTimersByTimeAsync(30_000); // no pong → detach
    expect(svc.isAttached("ma-1")).toBe(false);
    expect(ws.close).toHaveBeenCalled();
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "agent.disconnected", level: "warning", details: { reason: "heartbeat timeout" } });
  });

  it("detach stops the heartbeat", async () => {
    vi.useFakeTimers();
    const ws = fakeWs();
    svc.attach("ma-1", "asset-1", ws as never);
    svc.detach("ma-1", "revoked");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ws.ping).not.toHaveBeenCalled();
  });

  it("a ping that throws is left to the close handler", async () => {
    vi.useFakeTimers();
    const ws = fakeWs();
    ws.ping.mockImplementation(() => { throw new Error("not open"); });
    svc.attach("ma-1", "asset-1", ws as never);
    await expect(vi.advanceTimersByTimeAsync(30_000)).resolves.not.toThrow();
    expect(svc.isAttached("ma-1")).toBe(true);
    svc.detach("ma-1", "test");
  });
});

// ─── frames ────────────────────────────────────────────────────────────────

describe("frames", () => {
  it("a well-formed inbound frame is accepted and ignored", () => {
    const ws = fakeWs();
    svc.attach("ma-1", "asset-1", ws as never);
    ws.handlers.get("message")!(Buffer.from(JSON.stringify({ type: "hello-ack", id: "", payload: {} })));
    expect(svc.isAttached("ma-1")).toBe(true);
    expect(h.logger.debug).toHaveBeenCalledWith({ managedAgentId: "ma-1", type: "hello-ack" }, "Agent WS frame ignored");
    svc.detach("ma-1", "test");
  });

  it("a frame handler that throws closes THAT socket (malformed frame), never the process (rule 119(d))", async () => {
    const ws = fakeWs();
    svc.attach("ma-1", "asset-1", ws as never);
    h.logger.debug.mockImplementation(() => { throw new Error("handler bug"); });
    expect(() => ws.handlers.get("message")!('{"type":"x"}')).not.toThrow();
    expect(svc.isAttached("ma-1")).toBe(false);
    // The detach beat attach's name lookup, so its event waits for it.
    await settle();
    expect(eventLog.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "agent.disconnected", details: { managedAgentId: "ma-1", reason: "malformed frame" } }));
  });

  it("refreshConfig sends a refresh-config frame to an attached agent and nothing otherwise", () => {
    const ws = fakeWs();
    svc.refreshConfig("ma-1");
    svc.attach("ma-1", "asset-1", ws as never);
    svc.refreshConfig("ma-1");
    expect(frames(ws)).toEqual([
      { type: "hello", id: "", payload: { managedAgentId: "ma-1" } },
      { type: "refresh-config", id: "", payload: {} },
    ]);
    svc.detach("ma-1", "test");
  });
});

// ─── the command-wake LISTENer ─────────────────────────────────────────────

describe("startCommandWakeListener", () => {
  it("without a database URL it opens nothing (agents still poll)", async () => {
    await svc.startCommandWakeListener();
    expect(h.clients).toHaveLength(0);
    expect(h.logger.warn).toHaveBeenCalled();
  });

  it("LISTENs on both channels over the DIRECT url", async () => {
    h.directUrl.value = "postgres://direct/polaris";
    await svc.startCommandWakeListener();
    expect(h.clients).toHaveLength(1);
    const c = h.clients[0];
    expect(c.opts).toEqual({ connectionString: "postgres://direct/polaris" });
    expect(c.connect).toHaveBeenCalled();
    expect(c.query.mock.calls.map((q) => q[0])).toEqual([`LISTEN ${CMD}`, `LISTEN ${CFG}`]);
  });

  it("a command-wake NOTIFY pushes commands-pending to that agent when it is attached here", async () => {
    h.directUrl.value = "postgres://direct/polaris";
    await svc.startCommandWakeListener();
    const a = fakeWs();
    const b = fakeWs();
    svc.attach("ma-a", "asset-a", a as never);
    svc.attach("ma-b", "asset-b", b as never);
    const c = h.clients[0];
    c.emit("notification", { channel: CMD, payload: "ma-a" });
    c.emit("notification", { channel: CMD, payload: "ma-elsewhere" });
    c.emit("notification", { channel: CMD, payload: "" });
    c.emit("notification", { channel: CMD });
    expect(frames(a).map((f) => f.type)).toEqual(["hello", "commands-pending"]);
    expect(frames(a)[1]).toEqual({ type: "commands-pending", id: "", payload: {} });
    expect(frames(b).map((f) => f.type)).toEqual(["hello"]);
    svc.detach("ma-a", "test");
    svc.detach("ma-b", "test");
  });

  it("a config-refresh NOTIFY carries a comma list of agents, each sent refresh-config", async () => {
    h.directUrl.value = "postgres://direct/polaris";
    await svc.startCommandWakeListener();
    const a = fakeWs();
    const b = fakeWs();
    svc.attach("ma-a", "asset-a", a as never);
    svc.attach("ma-b", "asset-b", b as never);
    h.clients[0].emit("notification", { channel: CFG, payload: "ma-a,,ma-b,ma-gone" });
    expect(frames(a).map((f) => f.type)).toEqual(["hello", "refresh-config"]);
    expect(frames(b).map((f) => f.type)).toEqual(["hello", "refresh-config"]);
    svc.detach("ma-a", "test");
    svc.detach("ma-b", "test");
  });

  it("a failed connect closes that client and retries after 5 s", async () => {
    vi.useFakeTimers();
    h.directUrl.value = "postgres://direct/polaris";
    h.behaviour.connectFails = true;
    await svc.startCommandWakeListener();
    expect(h.clients).toHaveLength(1);
    expect(h.clients[0].end).toHaveBeenCalled();
    h.behaviour.connectFails = false;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.clients).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.clients).toHaveLength(2);
    expect(h.clients[1].query).toHaveBeenCalledWith(`LISTEN ${CMD}`);
  });

  it("an error on the live client ends it and reconnects once, however many errors arrive", async () => {
    vi.useFakeTimers();
    h.directUrl.value = "postgres://direct/polaris";
    await svc.startCommandWakeListener();
    const first = h.clients[0];
    first.emit("error", new Error("terminating connection due to administrator command"));
    first.emit("error", new Error("again"));
    expect(first.end).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.clients).toHaveLength(2);
    // The new client is the live one: a NOTIFY on it reaches an attached agent.
    const ws = fakeWs();
    svc.attach("ma-1", "asset-1", ws as never);
    h.clients[1].emit("notification", { channel: CMD, payload: "ma-1" });
    expect(frames(ws).map((f) => f.type)).toEqual(["hello", "commands-pending"]);
    svc.detach("ma-1", "test");
  });
});
