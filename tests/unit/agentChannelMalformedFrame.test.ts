/**
 * tests/unit/agentChannelMalformedFrame.test.ts — re-scan F8. A frame is
 * agent-controlled JSON, and `null`, a number, an array or an object without a
 * string `type` all parse. `frame.type` on `null` threw inside the ws message
 * listener — outside every try/catch — so one compromised agent host could
 * exit the web role on demand. A bad frame is ignored; a handler that still
 * throws closes that agent's socket, never the process.
 */

import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    asset:        { findUnique: vi.fn(async () => ({ hostname: "app-01", ipAddress: null })) },
    managedAgent: { update: vi.fn(async () => ({})) },
  },
  logEvent: vi.fn(async () => {}),
}));

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: h.logEvent }));
vi.mock("../../src/services/maintenanceScheduleService.js", () => ({ releaseMaintenanceHold: vi.fn(async () => true) }));
vi.mock("../../src/utils/dbConnections.js", () => ({ getDirectDatabaseUrl: () => null }));

import { asFrame, attach, detach, isAttached } from "../../src/services/agentChannelService.js";

function fakeWs() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    handlers,
    readyState: 1,
    on(event: string, fn: (...args: unknown[]) => void) { handlers.set(event, fn); return this; },
    send() { /* no-op */ },
    ping() { /* no-op */ },
    close() { /* no-op */ },
    terminate() { /* no-op */ },
  };
}

describe("asFrame", () => {
  it("refuses every JSON value that is not an object with a string type", () => {
    for (const v of [null, 0, 1, "x", true, [], [{ type: "a" }], {}, { type: 5 }, { id: "x" }]) {
      expect(asFrame(v)).toBeNull();
    }
  });

  it("keeps a well-formed frame and defaults a missing id", () => {
    expect(asFrame({ type: "probe-now-response", id: "r1", payload: { ok: 1 } }))
      .toEqual({ type: "probe-now-response", id: "r1", payload: { ok: 1 } });
    expect(asFrame({ type: "hello-ack" })).toEqual({ type: "hello-ack", id: "", payload: undefined });
  });
});

describe("the message listener", () => {
  it("survives `null`, numbers, arrays and junk without throwing, and keeps the session", () => {
    const ws = fakeWs();
    attach("ma-f8", "asset-f8", ws as never);
    const onMessage = ws.handlers.get("message")!;
    for (const frame of ["null", "0", "[]", '"x"', "{}", '{"type":7}', "not json", Buffer.from("null")]) {
      expect(() => onMessage(frame)).not.toThrow();
    }
    expect(isAttached("ma-f8")).toBe(true);
    detach("ma-f8", "test");
  });
});
