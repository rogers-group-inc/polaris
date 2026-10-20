/**
 * tests/unit/interfaceFilterAlias.test.ts
 *
 * An interface condition's filter (`ifNamePattern`) selects on the interface's
 * NAME or its DESCRIPTION, and takes a "|" any-of list.
 *
 * The case that forced it: an "ATT EPLS interface down" automation scoped to
 * firewalls only ever saw one of the two gates that carry the circuit. One
 * FortiGate names a VLAN interface "ATT EPLS"; the other carries the circuit
 * on port25 with "ATT EPLS" as its description — and the filter compared the
 * name alone, so port25 could never match.
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

/** One interface sample row, as the interfaces stream writes it. */
interface Port {
  assetId: string;
  ifName: string;
  alias: string | null;
  operStatus: string;
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
    assetInterfaceSample: {
      findMany: async () =>
        db.ports.map((p) => ({
          assetId: p.assetId, ifName: p.ifName, alias: p.alias, timestamp: new Date(),
          operStatus: p.operStatus, adminStatus: "up", poeStatus: null, ipAddress: null,
        })),
    },
    assetInterface: { findMany: async () => [] },
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

const T0 = new Date("2026-10-20T12:00:00Z");

function ifDownRule(ifNamePattern: string) {
  return {
    id: "r1", name: "EPLS interface down", description: null, severity: "warning",
    trigger: { type: "asset_state", field: "ifOperStatus", operator: "==", value: "down", forDurationSec: 0, dimensionFilter: { ifNamePattern } },
    scope: { allAssets: true },
    clearBehavior: "manual", clearAfterSec: null, cooldownSec: null, messageTemplate: null,
    channels: ["in_app"], targets: [], emailComposition: null, escalation: null,
    reset: { mode: "auto" }, actions: [],
  };
}

function firewall(id: string, pinned: string[]) {
  return {
    id, hostname: `FW-${id}`, assetType: "firewall", tags: [], discoveredByIntegrationId: null,
    monitorStatus: "up", status: "active", consecutiveFailures: 0, dependencySuppressed: false,
    quarantinedAt: null, ipAddress: null, manufacturer: "Fortinet", model: null, os: null,
    monitoredInterfaces: pinned, monitoredStorage: [], monitoredIpsecTunnels: [],
  };
}

const firing = () => db.states.filter((s) => s.state === "firing").map((s) => `${s.assetId}|${s.dimensionKey}`).sort();

beforeEach(() => {
  db.assets = [firewall("a1", ["ATT EPLS"]), firewall("a2", ["port25", "port24"])];
  db.ports = [
    { assetId: "a1", ifName: "ATT EPLS", alias: null, operStatus: "down" },
    { assetId: "a2", ifName: "port25", alias: "ATT EPLS", operStatus: "down" },
    { assetId: "a2", ifName: "port24", alias: "Uplink", operStatus: "down" },
  ];
  db.rules = [];
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

describe("ifNamePattern on an interface state condition", () => {
  it("matches the name on one gate and the description on the other", async () => {
    db.rules = [ifDownRule("ATT EPLS")];
    await evaluateAllNotificationRules();
    expect(firing()).toEqual(["a1|ATT EPLS", "a2|port25"]);
  });

  it("reads a \"|\" list as any-of", async () => {
    db.rules = [ifDownRule("port24|ATT EPLS")];
    await evaluateAllNotificationRules();
    expect(firing()).toEqual(["a1|ATT EPLS", "a2|port24", "a2|port25"]);
  });

  it("still selects nothing it does not name", async () => {
    db.rules = [ifDownRule("wan9")];
    await evaluateAllNotificationRules();
    expect(firing()).toEqual([]);
  });
});
