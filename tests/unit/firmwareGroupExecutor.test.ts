/**
 * tests/unit/firmwareGroupExecutor.test.ts
 *
 * Group firmware upgrades (business rule 122): the executor's ordering and
 * skip rules, against an in-memory database.
 *
 *   gate G
 *   ├── switch S1 ── AP A1, AP A2
 *   └── switch S2 ── AP A3
 *
 * Deepest first; never a device beside a running ancestor / descendant /
 * MCLAG peer; a parent only after everything behind it ended clean; a failure
 * skips only what is upstream of it; health is taken live just before each
 * start, an unhealthy device is skipped and the group moves on, and a health
 * skip does NOT hold back its ancestors; the summary email goes exactly once.
 *
 * startFirmwareUpgrade is mocked (its gates are firmwareUpgradeGates.test.ts's
 * subject); it records the start order and links the run as the real one does.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  class FakeConflict extends Error {
    httpStatus = 409;
    constructor(msg: string) { super(msg); this.name = "FirmwareRunConflictError"; }
  }
  const state = {
    group: null as Record<string, any> | null,
    members: [] as Array<Record<string, any>>,
    assets: new Map<string, Record<string, any>>(),
    runs: new Map<string, Record<string, any>>(),
    starts: [] as string[],
    conflictOn: new Set<string>(),
    seq: 0,
  };
  return {
    state,
    FakeConflict,
    logEvent: vi.fn(async () => {}),
    sendEmail: vi.fn(async () => {}),
  };
});

function eq(row: Record<string, any>, where: Record<string, any>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (v && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)) {
      if ("in" in v && !v.in.includes(row[k])) return false;
      if ("not" in v && row[k] === v.not) return false;
      continue;
    }
    if ((row[k] ?? null) !== v) return false;
  }
  return true;
}

function memberView(m: Record<string, any>) {
  const a = h.state.assets.get(m.assetId)!;
  return { ...m, asset: { ...a }, run: m.runId ? { ...h.state.runs.get(m.runId) } : null };
}

vi.mock("../../src/db.js", () => ({
  prisma: {
    firmwareGroupSchedule: {
      findUnique: vi.fn(async () => {
        const g = h.state.group;
        if (!g) return null;
        return { ...g, gate: { ...h.state.assets.get(g.gateAssetId) }, members: h.state.members.map(memberView) };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const g = h.state.group;
        if (!g || !eq(g, where)) return { count: 0 };
        Object.assign(g, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }: any) => Object.assign(h.state.group!, data)),
      findMany: vi.fn(async () => []),
    },
    firmwareGroupMember: {
      findMany: vi.fn(async () => h.state.members.map(memberView)),
      findUnique: vi.fn(async ({ where }: any) => h.state.members.find((m) => m.runId === where.runId) ?? null),
      update: vi.fn(async ({ where, data }: any) => Object.assign(h.state.members.find((m) => m.id === where.id)!, data)),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const hit = h.state.members.filter((m) => eq(m, where));
        for (const m of hit) Object.assign(m, data);
        return { count: hit.length };
      }),
    },
    asset: { findUnique: vi.fn(async ({ where }: any) => (h.state.assets.has(where.id) ? { ...h.state.assets.get(where.id) } : null)) },
    user: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: h.logEvent }));
vi.mock("../../src/services/firmwareUpgradeService.js", () => ({
  FIRMWARE_ASSET_SELECT: {},
  FirmwareRunConflictError: h.FakeConflict,
  healthBlockers: (a: Record<string, any>) => (a.monitorStatus && ["down", "warning", "recovering"].includes(a.monitorStatus) ? [`the device is ${a.monitorStatus}`] : []),
  assessGroupCandidate: vi.fn(async (a: Record<string, any>) => ({ ok: true, image: { id: "img-1", versionLabel: "7.6.8" }, fromVersion: a.osVersion, warnings: [] })),
  recordFirmwareCredentialUse: vi.fn(async () => {}),
  startFirmwareUpgrade: vi.fn(async ({ assetId, groupMemberId }: { assetId: string; groupMemberId: string }) => {
    if (h.state.conflictOn.has(assetId)) throw new h.FakeConflict("A firmware upgrade is running on X, which is above, below or paired with this device");
    const runId = `run-${++h.state.seq}`;
    h.state.runs.set(runId, { status: "running", result: null, error: null, stage: "deploying", verifiedVersion: null, progress: null });
    Object.assign(h.state.members.find((m) => m.id === groupMemberId)!, { runId, state: "running" });
    h.state.starts.push(h.state.assets.get(assetId)!.hostname);
    return { id: runId };
  }),
}));
vi.mock("../../src/services/firmwareScheduleService.js", () => ({
  CONFLICT_WAIT_MS: 2 * 60 * 60_000,
  LATE_GRACE_MS: 15 * 60_000,
  assertSchedulableTime: () => {},
  normalizeRecipients: (l: string[]) => l,
}));
vi.mock("../../src/services/notificationDeliveryService.js", () => ({
  applyBrandLetterhead: async (m: unknown) => m,
  sendEmailThroughChannel: h.sendEmail,
}));
vi.mock("../../src/services/quietTimeSummaryService.js", () => ({ resolveSummaryChannel: async () => ({ type: "smtp", config: {} }) }));
vi.mock("../../src/services/userTimezoneService.js", () => ({ resolveTimeZone: () => "UTC", serverTimeZone: () => "UTC" }));

import { advanceGroup } from "../../src/services/firmwareGroupService.js";

function asset(id: string, assetType: string, extra: Record<string, any> = {}) {
  h.state.assets.set(id, { id, hostname: id, ipAddress: "192.0.2.1", dnsName: null, assetType, model: null, osVersion: "7.4.3", status: "active", monitored: true, monitorStatus: "up", dependencySuppressed: false, serialNumber: null, manufacturer: "Fortinet", ...extra });
}

function member(assetId: string, depth: number, ancestorIds: string[], extra: Record<string, any> = {}) {
  h.state.members.push({ id: `m-${assetId}`, groupId: "g1", assetId, depth, ancestorIds, mclagPeerIds: [], state: "planned", skipKind: null, detail: null, imageId: "img-1", toVersion: "7.6.8", fromVersion: "7.4.3", runId: null, eligibleAt: null, startedAt: null, finishedAt: null, ...extra });
}

function setup(concurrency = 1) {
  h.state.group = { id: "g1", status: "running", concurrency, createdBy: "alice", firedAt: new Date("2026-10-17T02:00:00Z"), finishedAt: null, notifiedAt: null, gateAssetId: "G", scheduledFor: new Date("2026-10-17T02:00:00Z"), notifyEmails: ["ops@example.com"], error: null, createdAt: new Date(), cancelledBy: null, cancelledAt: null, notifyError: null };
  asset("G", "firewall");
  asset("S1", "switch");
  asset("S2", "switch");
  asset("A1", "access_point");
  asset("A2", "access_point");
  asset("A3", "access_point");
  member("G", 1, []);
  member("S1", 2, ["G"]);
  member("S2", 2, ["G"]);
  member("A1", 3, ["S1", "G"]);
  member("A2", 3, ["S1", "G"]);
  member("A3", 3, ["S2", "G"]);
}

/** End every running member's run with `outcome` (per asset), then advance. */
async function finishRunning(outcome: Record<string, "succeeded" | "failed" | "unverified"> = {}) {
  for (const m of h.state.members.filter((x) => x.state === "running")) {
    const run = h.state.runs.get(m.runId)!;
    const o = outcome[m.assetId] ?? "succeeded";
    Object.assign(run, { status: o, result: o === "succeeded" ? "upgraded" : o, error: o === "failed" ? "device did not come back within 15 min" : null, stage: o === "failed" ? "rebooting" : "verifying", verifiedVersion: o === "succeeded" ? "7.6.8" : null });
  }
  await advanceGroup("g1");
}

const stateOf = (id: string) => h.state.members.find((m) => m.assetId === id)!;

beforeEach(() => {
  h.state.group = null;
  h.state.members = [];
  h.state.assets.clear();
  h.state.runs.clear();
  h.state.starts = [];
  h.state.conflictOn.clear();
  h.state.seq = 0;
  h.sendEmail.mockClear();
  h.logEvent.mockClear();
});

describe("group executor (rule 122)", () => {
  it("runs deepest first, one at a time, each parent after its children", async () => {
    setup(1);
    await advanceGroup("g1");
    for (let i = 0; i < 6; i++) await finishRunning();
    expect(h.state.starts).toEqual(["A1", "A2", "A3", "S1", "S2", "G"]);
    expect(h.state.group!.status).toBe("completed");
    expect(h.state.members.every((m) => m.state === "upgraded")).toBe(true);
  });

  it("runs independent branches in parallel up to the concurrency, never a device beside its ancestor", async () => {
    setup(3);
    await advanceGroup("g1");
    expect(h.state.starts).toEqual(["A1", "A2", "A3"]);
    // A1 done, A2 still running: S1 must wait for A2; nothing else is eligible.
    Object.assign(h.state.runs.get(stateOf("A1").runId)!, { status: "succeeded", result: "upgraded" });
    Object.assign(h.state.runs.get(stateOf("A3").runId)!, { status: "succeeded", result: "upgraded" });
    await advanceGroup("g1");
    expect(h.state.starts).toEqual(["A1", "A2", "A3", "S2"]);
    expect(stateOf("S1").state).toBe("planned");
    expect(stateOf("G").state).toBe("planned");
  });

  it("skips an unhealthy device, moves straight to the next, and does not hold back its ancestors", async () => {
    setup(1);
    h.state.assets.get("A1")!.monitorStatus = "down";
    await advanceGroup("g1");
    expect(stateOf("A1")).toMatchObject({ state: "skipped", skipKind: "health", detail: "the device is down" });
    expect(h.state.starts).toEqual(["A2"]); // same pass
    for (let i = 0; i < 5; i++) await finishRunning();
    expect(h.state.starts).toEqual(["A2", "A3", "S1", "S2", "G"]);
    expect(stateOf("S1").state).toBe("upgraded");
    expect(h.state.group!.status).toBe("completed");
  });

  it("a failure skips only what is upstream of it; the other branch carries on", async () => {
    setup(1);
    await advanceGroup("g1"); // A1 starts
    await finishRunning({ A1: "failed" });
    for (let i = 0; i < 4; i++) await finishRunning();
    expect(stateOf("A1")).toMatchObject({ state: "failed", detail: "device did not come back within 15 min" });
    expect(stateOf("S1")).toMatchObject({ state: "skipped", skipKind: "subtree" });
    expect(stateOf("S1").detail).toMatch(/A1, behind it, failed/);
    expect(stateOf("G")).toMatchObject({ state: "skipped", skipKind: "subtree" });
    expect(stateOf("A2").state).toBe("upgraded");
    expect(stateOf("A3").state).toBe("upgraded");
    expect(stateOf("S2").state).toBe("upgraded");
    expect(h.state.starts).not.toContain("S1");
    expect(h.state.starts).not.toContain("G");
    expect(h.state.group!.status).toBe("completed");
  });

  it("an unverified child also holds its parent back", async () => {
    setup(1);
    h.state.members = h.state.members.filter((m) => ["S2", "A3"].includes(m.assetId));
    await advanceGroup("g1");
    await finishRunning({ A3: "unverified" });
    expect(stateOf("S2")).toMatchObject({ state: "skipped", skipKind: "subtree" });
  });

  it("sends the summary exactly once, naming failures, health skips and upstream skips", async () => {
    setup(1);
    h.state.assets.get("A3")!.monitorStatus = "warning";
    await advanceGroup("g1");
    await finishRunning({ A1: "failed" });
    for (let i = 0; i < 4; i++) await finishRunning();
    expect(h.state.group!.status).toBe("completed");
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    const msg = (h.sendEmail.mock.calls[0] as unknown as [unknown, { subject: string; text: string }])[1];
    expect(msg.subject).toMatch(/FAILED/);
    expect(msg.text).toMatch(/FAILED \(1\)[\s\S]*A1 \(FortiAP\): rebooting: device did not come back within 15 min/);
    expect(msg.text).toMatch(/SKIPPED — HEALTH \(1\)[\s\S]*A3 \(FortiAP\): the device is warning/);
    expect(msg.text).toMatch(/SKIPPED — UPSTREAM OF A DEVICE THAT DID NOT FINISH CLEANLY \(2\)/);
    await advanceGroup("g1");
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("waits on a related flash elsewhere, then gives up after the conflict wait", async () => {
    setup(1);
    h.state.members = h.state.members.filter((m) => m.assetId === "A1");
    h.state.conflictOn.add("A1");
    const t0 = new Date("2026-10-17T02:00:00Z");
    await advanceGroup("g1", t0);
    expect(stateOf("A1")).toMatchObject({ state: "waiting" });
    expect(stateOf("A1").eligibleAt).toEqual(t0);
    await advanceGroup("g1", new Date(t0.getTime() + 60 * 60_000));
    expect(stateOf("A1").state).toBe("waiting");
    await advanceGroup("g1", new Date(t0.getTime() + 2 * 60 * 60_000 + 60_000));
    expect(stateOf("A1")).toMatchObject({ state: "skipped", skipKind: "timeout" });
    expect(h.state.group!.status).toBe("completed");
  });

  it("re-checks the image when it starts: already current is recorded, a changed primary drops the device", async () => {
    setup(1);
    h.state.members = h.state.members.filter((m) => ["A1", "A2"].includes(m.assetId));
    const svc = await import("../../src/services/firmwareUpgradeService.js");
    const assess = svc.assessGroupCandidate as unknown as ReturnType<typeof vi.fn>;
    assess.mockImplementationOnce(async () => ({ ok: false, kind: "current", reason: "nothing newer" }));
    assess.mockImplementationOnce(async () => ({ ok: true, image: { id: "img-2", versionLabel: "7.6.9" }, fromVersion: "7.4.3", warnings: [] }));
    await advanceGroup("g1");
    expect(stateOf("A1").state).toBe("already-current");
    expect(stateOf("A2")).toMatchObject({ state: "dropped" });
    expect(stateOf("A2").detail).toMatch(/primary image changed to 7.6.9/);
    expect(h.state.starts).toEqual([]);
  });
});
