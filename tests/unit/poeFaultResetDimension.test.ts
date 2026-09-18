/**
 * tests/unit/poeFaultResetDimension.test.ts
 *
 * A PoE-fault alert ends when ITS port recovers — never because some other port
 * on the same switch is healthy (business rule 32(b)).
 *
 * The bug, as an operator met it: a `poeStatus == fault` automation covers
 * UNPINNED ports (business rule 57's carve-out), and the reset condition the
 * wizard seeds is that trigger inverted — `poeStatus != fault`, which does NOT
 * qualify for the carve-out, so the reset leaf read only the pinned ports. The
 * faulted port produced no reset reading at all, the tree's per-asset fallback
 * answered from whatever other ports the switch reported, and the first healthy
 * port cleared the alert. On a switch with no pinned ports the opposite
 * happened: no truth anywhere, and the alert could never clear.
 *
 * Both halves of the fix are pinned here — the leaf now inherits the trigger's
 * port coverage, and a leaf in the firing row's own dimension space no longer
 * falls back to the device-wide fold.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface FakeState {
  id: string;
  ruleId: string;
  assetId: string;
  dimensionKey: string;
  state: string;
  conditionMetSince: Date | null;
  recoveredSince: Date | null;
  firedAt: Date | null;
  lastValue: number | null;
  notificationId: string | null;
  firingSeverity: string | null;
  bandMetSince: unknown;
  metRun: number;
  clearRun: number;
  lastReadingAt: Date | null;
}

/** One port of the switch, as the two tables report it. */
interface Port {
  ifName: string;
  poeStatus: string | null;
  /** In Asset.monitoredInterfaces — sampled, and readable by any interface leaf. */
  pinned?: boolean;
}

const db = {
  rules: [] as any[],
  assets: [] as any[],
  ports: [] as Port[],
  states: [] as FakeState[],
  notifications: [] as any[],
  telemetry: [] as any[],
};
let seq = 0;

function findState(where: any): FakeState | null {
  const k = where.ruleId_assetId_dimensionKey;
  return db.states.find((s) => s.ruleId === k.ruleId && s.assetId === k.assetId && s.dimensionKey === k.dimensionKey) ?? null;
}

vi.mock("../../src/db.js", () => ({
  prisma: {
    notificationRule: { findMany: async () => db.rules },
    asset: { findMany: async () => db.assets, findUnique: async () => null },
    assetTelemetrySample: { findMany: async () => db.telemetry },
    assetStorageSample: { findMany: async () => [] },
    assetIpsecTunnelSample: { findMany: async () => [] },
    hostMetricsSample: { findMany: async () => [] },
    // The PINNED half: the samples table, which since the 2026-06 cutover holds
    // pinned ports only.
    assetInterfaceSample: {
      findMany: async () =>
        db.ports.filter((p) => p.pinned).map((p) => ({
          assetId: "a1", ifName: p.ifName, alias: null, timestamp: new Date(),
          operStatus: "up", adminStatus: "up", poeStatus: p.poeStatus, ipAddress: null,
        })),
    },
    // The UNPINNED half: the current-state table the carve-out reads.
    assetInterface: {
      findMany: async () =>
        db.ports.map((p) => ({ assetId: "a1", ifName: p.ifName, alias: null, poeStatus: p.poeStatus, lastSeen: new Date() })),
    },
    notificationRuleState: {
      findMany: async ({ where }: any) =>
        db.states.filter((s) => s.ruleId === where.ruleId && (where.state === undefined || s.state === where.state)),
      findUnique: async ({ where }: any) => findState(where),
      update: async ({ where, data }: any) => {
        const s = db.states.find((x) => x.id === where.id);
        if (s) Object.assign(s, data);
        return s;
      },
      updateMany: async ({ where, data }: any) => {
        const ids: string[] = where.id?.in ?? [];
        let count = 0;
        for (const s of db.states) if (ids.includes(s.id)) { Object.assign(s, data); count++; }
        return { count };
      },
      delete: async ({ where }: any) => {
        const i = db.states.findIndex((x) => x.id === where.id);
        if (i >= 0) db.states.splice(i, 1);
        return {};
      },
      deleteMany: async () => ({ count: 0 }),
      upsert: async ({ where, create, update }: any) => {
        const existing = findState(where);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const created: FakeState = {
          id: `st${++seq}`, conditionMetSince: null, recoveredSince: null, firedAt: null,
          lastValue: null, notificationId: null, firingSeverity: null, bandMetSince: null,
          metRun: 0, clearRun: 0, lastReadingAt: null, ...create,
        };
        db.states.push(created);
        return created;
      },
    },
    notification: {
      create: async ({ data }: any) => {
        const n = { id: `n${++seq}`, cleared: false, ...data };
        db.notifications.push(n);
        return n;
      },
      findFirst: async ({ where }: any) => db.notifications.find((n) => n.id === where.id && !n.cleared) ?? null,
      findMany: async () => db.notifications.filter((n) => !n.cleared),
      updateMany: async ({ where, data }: any) => {
        const ids: string[] = where.id?.in ?? (where.id ? [where.id] : []);
        let count = 0;
        for (const n of db.notifications) {
          if (ids.includes(n.id) && (where.cleared === undefined || n.cleared === where.cleared)) {
            Object.assign(n, data);
            count++;
          }
        }
        return { count };
      },
    },
    setting: { findUnique: async () => null, upsert: async () => ({}) },
    event: { findMany: async () => [] },
  },
}));

vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("../../src/services/notificationRecipientService.js", () => ({
  expandDeliveries: vi.fn(async () => {}),
  scopeRegionTagsOf: () => [],
  listRecipientUsers: vi.fn(async () => []),
  buildComposedEmail: vi.fn(() => ({ subject: "", text: "" })),
}));
vi.mock("../../src/services/automationActionService.js", () => ({
  executeActions: vi.fn(async () => ({ executed: 0, failed: 0 })),
}));

import { evaluateAllNotificationRules } from "../../src/services/notificationEngine.js";

const T0 = new Date("2026-09-18T12:00:00Z");

const POE_FAULT = {
  type: "asset_state", field: "poeStatus", operator: "==", value: "fault",
  forDurationSec: 0, dimensionFilter: {},
};
/** What the wizard seeds when the operator picks "custom conditions". */
const SEEDED_RESET = {
  mode: "condition",
  condition: {
    op: "and",
    children: [{ type: "asset_state", field: "poeStatus", operator: "!=", value: "fault", dimensionFilter: {} }],
  },
};

function poeRule(reset: unknown) {
  return {
    id: "r1", name: "PoE fault", description: null, severity: "critical",
    trigger: POE_FAULT, scope: { allAssets: true },
    clearBehavior: "manual", clearAfterSec: null, cooldownSec: null, messageTemplate: null,
    channels: ["in_app"], targets: [], emailComposition: null, escalation: null,
    reset, actions: [],
  };
}

function switchAsset(pinned: string[]) {
  return {
    id: "a1", hostname: "SW-CORE-1", assetType: "switch", tags: [], discoveredByIntegrationId: null,
    monitorStatus: "up", status: "active", consecutiveFailures: 0, dependencySuppressed: false,
    quarantinedAt: null, ipAddress: null, manufacturer: null, model: null, os: null,
    monitoredInterfaces: pinned, monitoredStorage: [], monitoredIpsecTunnels: [],
  };
}

async function tick(ports: Port[]) {
  db.ports = ports;
  await evaluateAllNotificationRules();
}

const portState = (ifName: string) => db.states.find((s) => s.dimensionKey === ifName);
const activeNotifs = () => db.notifications.filter((n) => !n.cleared);

beforeEach(() => {
  db.rules = [];
  db.assets = [switchAsset([])];
  db.ports = [];
  db.states = [];
  db.notifications = [];
  db.telemetry = [];
  seq = 0;
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a PoE fault alert on an UNPINNED port", () => {
  it("is not resolved by a healthy port on the same switch", () => runFaultHoldsTest());

  async function runFaultHoldsTest() {
    db.rules = [poeRule(SEEDED_RESET)];
    await tick([
      { ifName: "port1", poeStatus: "fault" },
      { ifName: "port2", poeStatus: "delivering" },
      { ifName: "port3", poeStatus: "searching" },
    ]);
    expect(portState("port1")?.state).toBe("firing");
    expect(activeNotifs()).toHaveLength(1);

    // Nothing changed. The reset tree must answer about port1 — which is still
    // faulted — and not about port2, which was never what the alert was about.
    await tick([
      { ifName: "port1", poeStatus: "fault" },
      { ifName: "port2", poeStatus: "delivering" },
      { ifName: "port3", poeStatus: "searching" },
    ]);
    expect(portState("port1")?.state).toBe("firing");
    expect(activeNotifs()).toHaveLength(1);
  }

  it("clears when THAT port recovers", async () => {
    db.rules = [poeRule(SEEDED_RESET)];
    await tick([{ ifName: "port1", poeStatus: "fault" }, { ifName: "port2", poeStatus: "delivering" }]);
    expect(activeNotifs()).toHaveLength(1);

    // The reset leaf inherits the trigger's carve-out, so it can SEE the
    // unpinned port it has to speak for. Without that half the alert would
    // stand forever.
    await tick([{ ifName: "port1", poeStatus: "delivering" }, { ifName: "port2", poeStatus: "delivering" }]);
    expect(portState("port1")?.state).toBe("clear");
    expect(activeNotifs()).toHaveLength(0);
  });

  it("holds even on a switch with a PINNED healthy port — the pin is not a stand-in", async () => {
    // The shape the fallback actually took in production: the reset leaf read
    // the pinned port and nothing else, so the pinned port answered for the
    // faulted one.
    db.assets = [switchAsset(["port2"])];
    db.rules = [poeRule(SEEDED_RESET)];
    await tick([
      { ifName: "port1", poeStatus: "fault" },
      { ifName: "port2", poeStatus: "delivering", pinned: true },
    ]);
    expect(portState("port1")?.state).toBe("firing");

    await tick([
      { ifName: "port1", poeStatus: "fault" },
      { ifName: "port2", poeStatus: "delivering", pinned: true },
    ]);
    expect(portState("port1")?.state).toBe("firing");
    expect(activeNotifs()).toHaveLength(1);
  });

  it("keeps one alert per port — one recovering leaves the other up", async () => {
    db.rules = [poeRule(SEEDED_RESET)];
    await tick([{ ifName: "port1", poeStatus: "fault" }, { ifName: "port2", poeStatus: "fault" }]);
    expect(activeNotifs()).toHaveLength(2);

    await tick([{ ifName: "port1", poeStatus: "delivering" }, { ifName: "port2", poeStatus: "fault" }]);
    expect(portState("port1")?.state).toBe("clear");
    expect(portState("port2")?.state).toBe("firing");
    expect(activeNotifs()).toHaveLength(1);
  });

  it("still lets a DEVICE-WIDE reset leaf clear it — the mixed tree is untouched", async () => {
    // Business rule 32(b)'s other half: a leaf in a different dimension space
    // (CPU reports at dimKey "") has no per-port entry to find, and its
    // device-wide truth is the only answer there is.
    db.rules = [poeRule({
      mode: "condition",
      condition: { op: "and", children: [{ type: "asset_metric", metric: "cpuPct", operator: "<", threshold: 20, aggregation: "latest", windowSec: 0 }] },
    })];
    db.telemetry = [{ assetId: "a1", timestamp: new Date(), cpuPct: 80, memPct: null, memUsedBytes: null, sessionCount: null }];
    await tick([{ ifName: "port1", poeStatus: "fault" }]);
    expect(portState("port1")?.state).toBe("firing");

    db.telemetry = [{ assetId: "a1", timestamp: new Date(), cpuPct: 5, memPct: null, memUsedBytes: null, sessionCount: null }];
    await tick([{ ifName: "port1", poeStatus: "fault" }]);
    expect(portState("port1")?.state).toBe("clear");
    expect(activeNotifs()).toHaveLength(0);
  });
});
