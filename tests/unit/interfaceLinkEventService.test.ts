/**
 * tests/unit/interfaceLinkEventService.test.ts — the monitored-interface up /
 * down Event: edge detection over pinned interface samples, the speed /
 * duplex the up event carries, and the batch write.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { findMany, logEventsBatch } = vi.hoisted(() => ({
  findMany: vi.fn(),
  logEventsBatch: vi.fn(),
}));
vi.mock("../../src/db.js", () => ({ prisma: { asset: { findMany } } }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEventsBatch }));

import {
  linkStateOf,
  detectInterfaceLinkTransitions,
  formatLinkSpeed,
  interfaceLinkEvent,
  recordInterfaceLinkEvents,
  _resetInterfaceLinkState,
  type InterfaceLinkReading,
} from "../../src/services/interfaceLinkEventService.js";

function reading(over: Partial<InterfaceLinkReading> = {}): InterfaceLinkReading {
  return {
    assetId: "a1",
    ifName: "port5",
    operStatus: "up",
    adminStatus: "up",
    speedBps: 1_000_000_000n,
    duplex: "full",
    alias: null,
    ...over,
  };
}

beforeEach(() => {
  _resetInterfaceLinkState();
  findMany.mockReset();
  logEventsBatch.mockReset();
});

describe("linkStateOf", () => {
  it("only up and the definite down states produce a state", () => {
    expect(linkStateOf("up")).toBe("up");
    expect(linkStateOf("down")).toBe("down");
    expect(linkStateOf("lowerLayerDown")).toBe("down");
    expect(linkStateOf("notPresent")).toBe("down");
    expect(linkStateOf("unknown")).toBeNull();
    expect(linkStateOf("dormant")).toBeNull();
    expect(linkStateOf("testing")).toBeNull();
    expect(linkStateOf(null)).toBeNull();
  });
});

describe("detectInterfaceLinkTransitions", () => {
  it("the first reading only seeds — a restart never reports links that were already up", () => {
    expect(detectInterfaceLinkTransitions([reading()], 1000)).toEqual([]);
    expect(detectInterfaceLinkTransitions([reading()], 2000)).toEqual([]);
  });

  it("reports down → up with the negotiated speed and duplex", () => {
    detectInterfaceLinkTransitions([reading({ operStatus: "down", speedBps: null, duplex: null })], 1000);
    const [t] = detectInterfaceLinkTransitions([reading({ speedBps: 100_000_000n, duplex: "half" })], 2000);
    expect(t).toMatchObject({ from: "down", to: "up", speedBps: 100_000_000, duplex: "half" });
  });

  it("reports up → down without speed or duplex, and keeps the admin status", () => {
    detectInterfaceLinkTransitions([reading()], 1000);
    const [t] = detectInterfaceLinkTransitions([reading({ operStatus: "down", adminStatus: "down", duplex: "full" })], 2000);
    expect(t).toMatchObject({ from: "up", to: "down", speedBps: null, duplex: null, adminStatus: "down" });
  });

  it("an indeterminate reading neither fires nor moves the state", () => {
    detectInterfaceLinkTransitions([reading()], 1000);
    expect(detectInterfaceLinkTransitions([reading({ operStatus: null })], 2000)).toEqual([]);
    expect(detectInterfaceLinkTransitions([reading({ operStatus: "unknown" })], 3000)).toEqual([]);
    // Still "up" underneath, so coming back as up is silent.
    expect(detectInterfaceLinkTransitions([reading()], 4000)).toEqual([]);
  });

  it("tracks each (asset, interface) separately", () => {
    detectInterfaceLinkTransitions([
      reading({ ifName: "port1", operStatus: "down" }),
      reading({ ifName: "port2", operStatus: "up" }),
      reading({ assetId: "a2", ifName: "port1", operStatus: "up" }),
    ], 1000);
    const out = detectInterfaceLinkTransitions([
      reading({ ifName: "port1", operStatus: "up" }),
      reading({ ifName: "port2", operStatus: "up" }),
      reading({ assetId: "a2", ifName: "port1", operStatus: "down" }),
    ], 2000);
    expect(out.map((t) => `${t.assetId}/${t.ifName}:${t.to}`)).toEqual(["a1/port1:up", "a2/port1:down"]);
  });

  it("drops a zero speed and an unrecognised duplex rather than reporting them", () => {
    detectInterfaceLinkTransitions([reading({ operStatus: "down" })], 1000);
    const [t] = detectInterfaceLinkTransitions([reading({ speedBps: 0, duplex: "auto" })], 2000);
    expect(t).toMatchObject({ speedBps: null, duplex: null });
  });

  it("forgets an interface not seen for over a day, so its next reading only seeds", () => {
    const day = 24 * 60 * 60 * 1000;
    detectInterfaceLinkTransitions([reading({ ifName: "old", operStatus: "down" })], 1000);
    // Another interface's reading past the prune horizon sweeps "old" out.
    detectInterfaceLinkTransitions([reading({ ifName: "other" })], 1000 + day + 60 * 60 * 1000);
    expect(detectInterfaceLinkTransitions([reading({ ifName: "old" })], 1000 + day + 2 * 60 * 60 * 1000)).toEqual([]);
  });
});

describe("formatLinkSpeed", () => {
  it("uses the largest unit and keeps one decimal only when needed", () => {
    expect(formatLinkSpeed(1_000_000_000)).toBe("1 Gbps");
    expect(formatLinkSpeed(2_500_000_000)).toBe("2.5 Gbps");
    expect(formatLinkSpeed(100_000_000)).toBe("100 Mbps");
    expect(formatLinkSpeed(10_000_000)).toBe("10 Mbps");
    expect(formatLinkSpeed(400_000_000_000)).toBe("400 Gbps");
    expect(formatLinkSpeed(500)).toBe("500 bps");
  });
});

describe("interfaceLinkEvent", () => {
  const up = {
    assetId: "a1", ifName: "port5", alias: "Uplink", from: "down" as const, to: "up" as const,
    operStatus: "up", adminStatus: "up", speedBps: 1_000_000_000, duplex: "full",
  };

  it("the up event names the port, its alias, the device, the speed and the duplex", () => {
    const e = interfaceLinkEvent(up, "SW-1");
    expect(e).toMatchObject({
      action: "monitor.interface_up",
      level: "info",
      resourceType: "asset",
      resourceId: "a1",
      resourceName: "SW-1",
      message: "Interface port5 (Uplink) on SW-1 came up — 1 Gbps, full duplex",
    });
    expect(e.details).toMatchObject({ ifName: "port5", speedBps: 1_000_000_000, duplex: "full", previousState: "down" });
  });

  it("says unknown rather than omitting a speed or duplex it could not read", () => {
    const e = interfaceLinkEvent({ ...up, alias: null, speedBps: null, duplex: null }, null);
    expect(e.message).toBe("Interface port5 on a1 came up — speed unknown, duplex unknown");
    expect(e.resourceName).toBeUndefined();
  });

  it("a fault down is a warning; an administrative shutdown is info and says so", () => {
    const down = { ...up, alias: null, from: "up" as const, to: "down" as const, operStatus: "down", speedBps: null, duplex: null };
    expect(interfaceLinkEvent(down, "SW-1")).toMatchObject({
      action: "monitor.interface_down", level: "warning", message: "Interface port5 on SW-1 went down",
    });
    expect(interfaceLinkEvent({ ...down, adminStatus: "down" }, "SW-1")).toMatchObject({
      level: "info", message: "Interface port5 on SW-1 went down (administratively down)",
    });
  });
});

describe("recordInterfaceLinkEvents", () => {
  it("does no DB work when nothing changed", async () => {
    await recordInterfaceLinkEvents([reading()]);
    await recordInterfaceLinkEvents([reading()]);
    expect(findMany).not.toHaveBeenCalled();
    expect(logEventsBatch).not.toHaveBeenCalled();
  });

  it("looks the hostnames up once and writes every edge in one batch", async () => {
    findMany.mockResolvedValue([{ id: "a1", hostname: "SW-1" }, { id: "a2", hostname: "SW-2" }]);
    await recordInterfaceLinkEvents([
      reading({ operStatus: "down" }),
      reading({ assetId: "a2", operStatus: "up" }),
    ]);
    await recordInterfaceLinkEvents([
      reading(),
      reading({ assetId: "a2", operStatus: "down" }),
    ]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual({ id: { in: ["a1", "a2"] } });
    expect(logEventsBatch).toHaveBeenCalledTimes(1);
    const events = logEventsBatch.mock.calls[0][0];
    expect(events.map((e: any) => e.message)).toEqual([
      "Interface port5 on SW-1 came up — 1 Gbps, full duplex",
      "Interface port5 on SW-2 went down",
    ]);
  });

  it("never throws when the lookup fails", async () => {
    findMany.mockRejectedValue(new Error("db gone"));
    await recordInterfaceLinkEvents([reading({ operStatus: "down" })]);
    await expect(recordInterfaceLinkEvents([reading()])).resolves.toBeUndefined();
    expect(logEventsBatch).not.toHaveBeenCalled();
  });
});
