/**
 * tests/unit/agentChannelEvents.test.ts
 *
 * The two things the agent WebSocket lifecycle has to get right for the rest of
 * Polaris, neither of which the socket itself cares about:
 *
 *  1. **The events NAME the device.** An `asset` Event with no `resourceName`
 *     gives an event automation an empty subject (`eventSubjectLabel` returns
 *     "" for one), so every alert about agent.connected / agent.disconnected
 *     rendered a widget row and an email that could not say WHICH agent had
 *     dropped — the one fact those alerts exist to carry.
 *  2. **A reattach releases the maintenance hold** an upgrade or reinstall took
 *     (business rule 80). The agent being back is the first moment the asset is
 *     genuinely watched again; releasing when the installer returned instead
 *     lets the lagging disconnect through, because the WS teardown trails the
 *     service stop by up to a heartbeat interval.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  asset: null as { hostname: string | null; ipAddress: string | null } | null,
  prisma: {
    asset:        { findUnique: vi.fn() },
    managedAgent: { update: vi.fn(async () => ({})) },
  },
  logEvent: vi.fn(async () => {}),
  releaseMaintenanceHold: vi.fn(async () => true),
}));

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: h.logEvent }));
vi.mock("../../src/services/maintenanceScheduleService.js", () => ({
  releaseMaintenanceHold: h.releaseMaintenanceHold,
}));
vi.mock("../../src/utils/dbConnections.js", () => ({ getDirectDatabaseUrl: () => null }));

import { attach, detach, isAttached } from "../../src/services/agentChannelService.js";

/** Minimal duck-typed socket — attach() only sends, listens and pings. */
function fakeWs() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    handlers,
    sent: [] as string[],
    readyState: 1, // WebSocket.OPEN
    terminated: false,
    on(event: string, fn: (...args: unknown[]) => void) { handlers.set(event, fn); return this; },
    send(data: string) { this.sent.push(data); },
    ping() { /* no-op */ },
    close() { /* no-op */ },
    terminate() { this.terminated = true; },
    /** Fire this socket's close handler, as ws does once a close completes. */
    fireClose(code = 1006) { handlers.get("close")?.(code, Buffer.from("")); },
  };
}

/** Let attach()'s fire-and-forget naming + release pass finish. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.asset.findUnique.mockResolvedValue({ hostname: "app-01", ipAddress: "10.0.0.9" });
});

describe("agent WS lifecycle events", () => {
  it("names the device on connect", async () => {
    attach("ma-1", "asset-1", fakeWs() as never);
    await settle();

    expect(h.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agent.connected", resourceName: "app-01" }),
    );
    detach("ma-1", "test");
  });

  it("names the device on disconnect, in the message as well as the field", async () => {
    attach("ma-2", "asset-2", fakeWs() as never);
    await settle();
    h.logEvent.mockClear();

    detach("ma-2", "heartbeat timeout");

    expect(h.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action:       "agent.disconnected",
        resourceName: "app-01",
        level:        "warning",
        message:      expect.stringContaining("app-01"),
      }),
    );
  });

  it("falls back to the IP when the asset has no hostname", async () => {
    h.prisma.asset.findUnique.mockResolvedValue({ hostname: null, ipAddress: "10.0.0.9" });
    attach("ma-3", "asset-3", fakeWs() as never);
    await settle();
    h.logEvent.mockClear();

    detach("ma-3", "socket error");

    expect(h.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agent.disconnected", resourceName: "10.0.0.9" }),
    );
  });

  it("still emits a usable disconnect when the asset could not be read", async () => {
    // A lookup failure must not cost the event — an unnamed alert still beats
    // no audit row at all.
    h.prisma.asset.findUnique.mockRejectedValue(new Error("db down"));
    attach("ma-4", "asset-4", fakeWs() as never);
    await settle();
    h.logEvent.mockClear();

    detach("ma-4", "socket error");

    expect(h.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agent.disconnected", resourceName: undefined }),
    );
  });

  it("releases the upgrade and reinstall holds when the agent comes back", async () => {
    attach("ma-5", "asset-5", fakeWs() as never);
    await settle();

    const kinds = h.releaseMaintenanceHold.mock.calls.map((c) => (c[0] as { kind: string }).kind);
    expect(kinds).toEqual(["agent-upgrade", "agent-reinstall"]);
    expect(h.releaseMaintenanceHold).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: "asset-5" }),
    );
    detach("ma-5", "test");
  });

  it("does not release the uninstall hold — nothing is meant to come back from one", async () => {
    attach("ma-6", "asset-6", fakeWs() as never);
    await settle();

    const kinds = h.releaseMaintenanceHold.mock.calls.map((c) => (c[0] as { kind: string }).kind);
    expect(kinds).not.toContain("agent-uninstall");
    detach("ma-6", "test");
  });

  it("a failed release never breaks the attach", async () => {
    h.releaseMaintenanceHold.mockRejectedValue(new Error("nope"));
    attach("ma-7", "asset-7", fakeWs() as never);
    await settle();

    expect(isAttached("ma-7")).toBe(true);
    detach("ma-7", "test");
  });

  it("marks a replaced session info, not warning — Polaris caused that one", async () => {
    attach("ma-8", "asset-8", fakeWs() as never);
    await settle();
    h.logEvent.mockClear();

    detach("ma-8", "replaced");

    expect(h.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agent.disconnected", level: "info" }),
    );
  });
});

/**
 * The server-restart reconnect herd: an agent whose first dial outlived its
 * handshake timeout redials, and Polaris can end up holding two sockets for one
 * agent. The old one's close event arrives AFTER the replacement took the map
 * slot. It used to detach by agent id, killing the live replacement and paging
 * "Agent disconnected" for a connection that was fine.
 */
describe("a replaced socket cannot tear down its replacement", () => {
  it("the old socket's late close leaves the new session attached and writes no event", async () => {
    const oldWs = fakeWs();
    const newWs = fakeWs();
    attach("ma-20", "asset-20", oldWs as never);
    attach("ma-20", "asset-20", newWs as never);
    await settle();
    h.logEvent.mockClear();

    oldWs.fireClose();

    expect(isAttached("ma-20")).toBe(true);
    expect(h.logEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "agent.disconnected" }),
    );
    detach("ma-20", "test");
  });

  it("the old socket's late error is inert too", async () => {
    const oldWs = fakeWs();
    attach("ma-21", "asset-21", oldWs as never);
    attach("ma-21", "asset-21", fakeWs() as never);
    await settle();
    h.logEvent.mockClear();

    oldWs.handlers.get("error")?.(new Error("ECONNRESET"));

    expect(isAttached("ma-21")).toBe(true);
    expect(h.logEvent).not.toHaveBeenCalled();
    detach("ma-21", "test");
  });

  it("the live socket's own close still detaches and pages", async () => {
    const oldWs = fakeWs();
    const newWs = fakeWs();
    attach("ma-22", "asset-22", oldWs as never);
    attach("ma-22", "asset-22", newWs as never);
    await settle();
    h.logEvent.mockClear();

    newWs.fireClose();

    expect(isAttached("ma-22")).toBe(false);
    expect(h.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agent.disconnected", level: "warning" }),
    );
  });

  it("an unscoped detach (revoke, operator action) still ends whatever is attached", async () => {
    attach("ma-23", "asset-23", fakeWs() as never);
    await settle();

    detach("ma-23", "revoked");

    expect(isAttached("ma-23")).toBe(false);
  });
});

describe("a socket that closed before attach is dropped", () => {
  it("never registers, never writes agent.connected, and does not displace the live session", async () => {
    const live = fakeWs();
    attach("ma-30", "asset-30", live as never);
    await settle();
    h.logEvent.mockClear();

    const abandoned = fakeWs();
    abandoned.readyState = 3; // CLOSED — the agent gave up on this dial
    attach("ma-30", "asset-30", abandoned as never);
    await settle();

    expect(abandoned.terminated).toBe(true);
    expect(isAttached("ma-30")).toBe(true);
    expect(h.logEvent).not.toHaveBeenCalled();

    // The live session is still the one registered: its close is the one that counts.
    live.fireClose();
    expect(isAttached("ma-30")).toBe(false);
  });

  it("with nothing attached, a closing socket leaves the agent detached and silent", async () => {
    const closing = fakeWs();
    closing.readyState = 2; // CLOSING
    attach("ma-31", "asset-31", closing as never);
    await settle();

    expect(isAttached("ma-31")).toBe(false);
    expect(h.logEvent).not.toHaveBeenCalled();
  });
});
