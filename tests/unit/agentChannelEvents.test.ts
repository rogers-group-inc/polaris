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
    on(event: string, fn: (...args: unknown[]) => void) { handlers.set(event, fn); return this; },
    send(data: string) { this.sent.push(data); },
    ping() { /* no-op */ },
    close() { /* no-op */ },
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
