/**
 * tests/unit/fortinetLinkState.test.ts
 *
 * The controller-link sweep (business rule 58). What is pinned here is the
 * three refusals — the decisions that separate "a useful second opinion about
 * a FortiLink session" from "a fleet-wide false alarm every time an API token
 * expires":
 *
 *   1. An unreadable controller writes NOTHING. Not down, not unknown.
 *   2. Answered-but-absent is `unknown`, never `down`.
 *   3. Confirmations refresh `fortilinkCheckedAt` and leave `fortilinkChangedAt`
 *      alone, so "down for 2h" means the outage and not the poll age.
 *
 * Plus the scale property the sweep is built around: transitions are written
 * with one `updateMany` per destination value, not one `update` per asset.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  assetRows: [] as Record<string, unknown>[],
  integrationRows: [] as Record<string, unknown>[],
  updateManyCalls: [] as Array<{ ids: string[]; data: Record<string, unknown> }>,
  updateCalls: [] as Array<{ id: string; data: Record<string, unknown> }>,
  loggedEvents: [] as Array<Record<string, unknown>>,
  // (deviceName, kind) -> inventory, or a thrown error for an unreadable one.
  inventories: new Map<string, Map<string, { connected: boolean; status: string }> | Error>(),
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    integration: { findMany: vi.fn(async () => h.integrationRows) },
    asset: {
      findMany: vi.fn(async () => h.assetRows),
      updateMany: vi.fn(async ({ where, data }: any) => {
        h.updateManyCalls.push({ ids: where.id.in, data });
        return { count: where.id.in.length };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        h.updateCalls.push({ id: where.id, data });
        return {};
      }),
    },
  },
}));

vi.mock("../../src/services/monitoringService.js", () => ({
  fetchFortinetControllerInventory: vi.fn(async (_i: any, deviceName: string, kind: string) => {
    const hit = h.inventories.get(`${deviceName}::${kind}`);
    if (hit instanceof Error) throw hit;
    return { inventory: hit ?? new Map(), fetchDurationMs: 5 };
  }),
}));

vi.mock("../../src/services/eventLogService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/eventLogService.js")>();
  return {
    ...actual,
    logEventsBatch: vi.fn(async (inputs: any[]) => {
      h.loggedEvents.push(...inputs);
      return inputs.length;
    }),
  };
});

vi.mock("../../src/metrics.js", () => ({ recordFortilinkState: vi.fn() }));

const { sweepFortinetLinkState } = await import("../../src/services/fortinetLinkStateService.js");

const FMG = { id: "i-1", type: "fortimanager", name: "CENTRAL-FMG", config: {} };

function sw(id: string, serial: string, stored: string | null, controller = "GATE-A") {
  return {
    id, hostname: id, ipAddress: null, assetType: "switch", serialNumber: serial,
    fortinetTopology: { role: "fortiswitch", controllerFortigate: controller },
    fortilinkStatus: stored, fortilinkStatusRaw: null, discoveredByIntegrationId: "i-1",
  };
}

function ap(id: string, serial: string, stored: string | null, controller = "GATE-A") {
  return {
    id, hostname: id, ipAddress: null, assetType: "access_point", serialNumber: serial,
    fortinetTopology: { role: "fortiap", controllerFortigate: controller },
    fortilinkStatus: stored, fortilinkStatusRaw: null, discoveredByIntegrationId: "i-1",
  };
}

/** Every `fortilinkStatus` value the pass wrote, by asset id. */
function writtenStatuses(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const call of h.updateManyCalls) {
    if (!("fortilinkStatus" in call.data)) continue;
    for (const id of call.ids) out[id] = call.data.fortilinkStatus;
  }
  return out;
}

beforeEach(() => {
  h.assetRows.length = 0;
  h.integrationRows.length = 0;
  h.updateManyCalls.length = 0;
  h.updateCalls.length = 0;
  h.loggedEvents.length = 0;
  h.inventories.clear();
  h.integrationRows.push(FMG);
});

describe("refusal 1 — an unreadable controller writes nothing", () => {
  it("leaves every device behind a failed controller untouched", async () => {
    h.assetRows.push(sw("sw-1", "S1", "up"), sw("sw-2", "S2", "up"));
    h.inventories.set("GATE-A::switches", new Error("RPC -11: no valid session"));

    const result = await sweepFortinetLinkState();

    expect(result.controllersFailed).toBe(1);
    expect(result.controllersRead).toBe(0);
    // The loudest false alarm this feature could produce: a dark FMG reporting
    // a fleet-wide link outage. Nothing is written at all — not the status,
    // not even the checkedAt refresh, because the value is no longer current
    // and the UI reads a frozen checkedAt as exactly that.
    expect(h.updateManyCalls).toHaveLength(0);
    expect(h.updateCalls).toHaveLength(0);
    expect(h.loggedEvents).toHaveLength(0);
  });

  it("isolates the failure — other controllers in the same pass still sweep", async () => {
    h.assetRows.push(sw("sw-dark", "S1", "up", "GATE-DARK"), sw("sw-ok", "S2", "up", "GATE-OK"));
    h.inventories.set("GATE-DARK::switches", new Error("unreachable"));
    h.inventories.set("GATE-OK::switches", new Map([["S2", { connected: false, status: "Disconnected" }]]));

    const result = await sweepFortinetLinkState();

    expect(result.controllersFailed).toBe(1);
    expect(result.controllersRead).toBe(1);
    expect(writtenStatuses()).toEqual({ "sw-ok": "down" });
  });
});

describe("refusal 2 — answered-but-absent is unknown, never down", () => {
  it("reads a device missing from the controller's table as unknown", async () => {
    h.assetRows.push(sw("sw-1", "S1", "up"));
    // The controller answered; this switch simply is not in the table.
    h.inventories.set("GATE-A::switches", new Map([["OTHER", { connected: true, status: "Connected" }]]));

    await sweepFortinetLinkState();

    expect(writtenStatuses()).toEqual({ "sw-1": "unknown" });
  });

  it("still calls a PRESENT but disconnected device down", async () => {
    h.assetRows.push(sw("sw-1", "S1", "up"));
    h.inventories.set("GATE-A::switches", new Map([["S1", { connected: false, status: "Disconnected" }]]));

    await sweepFortinetLinkState();

    expect(writtenStatuses()).toEqual({ "sw-1": "down" });
  });
});

describe("refusal 3 — a confirmation is not a change", () => {
  it("refreshes checkedAt and leaves changedAt alone when the value holds", async () => {
    h.assetRows.push(sw("sw-1", "S1", "down"));
    h.inventories.set("GATE-A::switches", new Map([["S1", { connected: false, status: "Disconnected" }]]));

    const result = await sweepFortinetLinkState();

    expect(result.unchanged).toBe(1);
    expect(result.transitions).toBe(0);
    expect(h.updateManyCalls).toHaveLength(1);
    const data = h.updateManyCalls[0]!.data;
    expect(data).toHaveProperty("fortilinkCheckedAt");
    // The whole point: "down for 2h13m" has to be the outage length, so a
    // confirmation must not bump changedAt.
    expect(data).not.toHaveProperty("fortilinkChangedAt");
    expect(data).not.toHaveProperty("fortilinkStatus");
    expect(h.loggedEvents).toHaveLength(0);
  });

  it("stores a moved raw word without calling it a transition", async () => {
    // An AP going offline -> discovered is down throughout. Worth recording,
    // not worth an Event or a changedAt bump.
    h.assetRows.push({ ...ap("ap-1", "A1", "down"), fortilinkStatusRaw: "offline" });
    h.inventories.set("GATE-A::aps", new Map([["A1", { connected: false, status: "discovered" }]]));

    const result = await sweepFortinetLinkState();

    expect(result.transitions).toBe(0);
    expect(h.updateCalls).toEqual([{ id: "ap-1", data: { fortilinkStatusRaw: "discovered" } }]);
    expect(h.loggedEvents).toHaveLength(0);
  });
});

describe("AP status vocabulary", () => {
  it("accepts both words FortiOS uses for a healthy AP", async () => {
    h.assetRows.push(ap("ap-online", "A1", "down"), ap("ap-connected", "A2", "down"));
    h.inventories.set("GATE-A::aps", new Map([
      ["A1", { connected: false, status: "online" }],
      ["A2", { connected: false, status: "connected" }],
    ]));

    await sweepFortinetLinkState();

    // Note `connected: false` on both rows: for an AP the STATUS WORD decides,
    // via the same helper the probe path uses. A firmware that reports "online"
    // must not read as a dead CAPWAP tunnel.
    expect(writtenStatuses()).toEqual({ "ap-online": "up", "ap-connected": "up" });
  });

  it("reads offline and discovered as down", async () => {
    h.assetRows.push(ap("ap-1", "A1", "up"), ap("ap-2", "A2", "up"));
    h.inventories.set("GATE-A::aps", new Map([
      ["A1", { connected: true, status: "offline" }],
      ["A2", { connected: true, status: "discovered" }],
    ]));

    await sweepFortinetLinkState();

    expect(writtenStatuses()).toEqual({ "ap-1": "down", "ap-2": "down" });
  });
});

describe("transitions and their Events", () => {
  it("writes one asset.fortilink.changed Event per device that moved", async () => {
    h.assetRows.push(sw("sw-1", "S1", "up"), sw("sw-2", "S2", "up"));
    h.inventories.set("GATE-A::switches", new Map([
      ["S1", { connected: false, status: "Disconnected" }],
      ["S2", { connected: true, status: "Connected" }],
    ]));

    const result = await sweepFortinetLinkState();

    expect(result.transitions).toBe(1);
    expect(h.loggedEvents).toHaveLength(1);
    const ev = h.loggedEvents[0]!;
    expect(ev.action).toBe("asset.fortilink.changed");
    expect(ev.resourceId).toBe("sw-1");
    // A link going down is a warning; the level filter on the Events page is
    // how an operator separates the two directions without reading messages.
    expect(ev.level).toBe("warning");
    expect(String(ev.message)).toContain("up → down");
  });

  it("logs the first observation as info, not a warning", async () => {
    // from === null is Polaris learning the state, not the link dropping.
    h.assetRows.push(sw("sw-1", "S1", null));
    h.inventories.set("GATE-A::switches", new Map([["S1", { connected: false, status: "Disconnected" }]]));

    await sweepFortinetLinkState();

    expect(h.loggedEvents).toHaveLength(1);
    expect(h.loggedEvents[0]!.level).toBe("info");
  });

  it("batches by destination value instead of one write per asset", async () => {
    // The scale property. 40 switches dropping at once is 2 statements (one
    // updateMany for the moved set, one for the confirmed remainder), not 40.
    for (let i = 0; i < 40; i++) h.assetRows.push(sw(`sw-${i}`, `S${i}`, "up"));
    const inv = new Map<string, { connected: boolean; status: string }>();
    for (let i = 0; i < 40; i++) inv.set(`S${i}`, { connected: false, status: "Disconnected" });
    h.inventories.set("GATE-A::switches", inv);

    const result = await sweepFortinetLinkState();

    expect(result.transitions).toBe(40);
    const statusWrites = h.updateManyCalls.filter((c) => "fortilinkStatus" in c.data);
    expect(statusWrites).toHaveLength(1);
    expect(statusWrites[0]!.ids).toHaveLength(40);
  });
});

describe("controller grouping", () => {
  it("asks each controller once per kind, not once per device", async () => {
    const { fetchFortinetControllerInventory } = await import("../../src/services/monitoringService.js");
    h.assetRows.push(sw("sw-1", "S1", "up"), sw("sw-2", "S2", "up"), ap("ap-1", "A1", "up"));
    h.inventories.set("GATE-A::switches", new Map([
      ["S1", { connected: true, status: "Connected" }],
      ["S2", { connected: true, status: "Connected" }],
    ]));
    h.inventories.set("GATE-A::aps", new Map([["A1", { connected: true, status: "online" }]]));

    await sweepFortinetLinkState();

    // Three devices, two upstream calls — the property that keeps the sweep
    // affordable on FMG proxy mode at concurrency 1.
    expect(vi.mocked(fetchFortinetControllerInventory)).toHaveBeenCalledTimes(2);
  });

  it("skips a device with no controller recorded", async () => {
    h.assetRows.push({ ...sw("sw-1", "S1", "up"), fortinetTopology: { role: "fortiswitch" } });

    const result = await sweepFortinetLinkState();

    expect(result.controllersRead).toBe(0);
    expect(h.updateManyCalls).toHaveLength(0);
  });

  it("falls back to the integration host for a standalone FortiGate", async () => {
    h.integrationRows.length = 0;
    h.integrationRows.push({ id: "i-1", type: "fortigate", name: "BRANCH-FG", config: { host: "10.1.1.1" } });
    h.assetRows.push({ ...sw("sw-1", "S1", "up"), fortinetTopology: { role: "fortiswitch" } });
    h.inventories.set("10.1.1.1::switches", new Map([["S1", { connected: false, status: "Disconnected" }]]));

    await sweepFortinetLinkState();

    // The standalone gate IS the one controller, whatever the topology blob
    // does or does not say.
    expect(writtenStatuses()).toEqual({ "sw-1": "down" });
  });
});
