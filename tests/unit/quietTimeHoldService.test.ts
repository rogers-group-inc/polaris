/**
 * tests/unit/quietTimeHoldService.test.ts — own unit suite for
 * src/services/quietTimeHoldService.ts (CQ-T010).
 *
 * The precedence itself (own policy vs ignore-global vs global) is pinned in
 * quietTimeHoldResolve.test.ts. This suite covers the rest of the contract
 * (business rules 92 and 120, rule 44's fail-loud posture): the catalog cache
 * and its bump, an unreadable catalog or schedule, severity / alert-kind /
 * scope matching (IPv4 and IPv6 subnets), the per-pass memo and the batched
 * device read, recipient exceptions, the open-window lookup and the
 * row-level config read.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ decorate: vi.fn(async (_assets?: unknown[], _conditions?: unknown[]) => {}) }));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/scopeRelationIndex.js", () => ({ decorateRelationLeafHits: mocks.decorate }));

import {
  bumpQuietTimeCache,
  parseQuietTimeConfig,
  newQuietHoldMemo,
  primeQuietHoldAssets,
  resolveQuietHold,
  resolveQuietWindow,
  quietSourceConfig,
} from "../../src/services/quietTimeHoldService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const NIGHTLY = { version: 1, kind: "recurring", freq: "daily", hours: [{ startTime: "22:00", endTime: "06:00" }] };
const NIGHT = new Date(2026, 9, 3, 23, 0, 0, 0);
const NOON = new Date(2026, 9, 3, 12, 30, 0, 0);
const MORNING_END = new Date(2026, 9, 4, 6, 0, 0, 0);

const db = { schedules: [] as any[], rules: [] as any[] };

const assetRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id, assetType: "switch", tags: [], discoveredByIntegrationId: null, hostname: id, manufacturer: null, model: null,
  os: null, ipAddress: "10.1.0.5", status: "active", osVersion: null, department: null, location: null, learnedLocation: null,
  ...extra,
});

const schedule = (id: string, quiet: Record<string, unknown>, scope: Record<string, unknown> = {}, day = 1) => ({
  id, name: `Sched ${id}`, scope, quiet: { windows: [NIGHTLY], ...quiet }, createdAt: new Date(2026, 0, day),
});

beforeEach(() => {
  resetDbStub();
  mocks.decorate.mockClear();
  bumpQuietTimeCache();
  db.schedules = [];
  db.rules = [];
  stubbed(prisma.quietTimeSchedule.findMany).mockImplementation(async () => db.schedules);
  stubbed(prisma.notificationRule.findMany).mockImplementation(async () => db.rules);
  stubbed(prisma.asset.findUnique).mockResolvedValue(null);
  stubbed(prisma.asset.findMany).mockResolvedValue([]);
});

const ask = (extra: Record<string, unknown> = {}) =>
  resolveQuietHold({ ruleId: "r-plain", severity: "warning", metric: "cpuPct", assetId: "a1", now: NIGHT, ...extra });

describe("parseQuietTimeConfig", () => {
  it("returns the parsed policy for a valid blob", () => {
    expect(parseQuietTimeConfig({ windows: [NIGHTLY] })?.windows).toHaveLength(1);
  });

  it("returns null for null, undefined, the exemption marker, or a hand-edited blob", () => {
    expect(parseQuietTimeConfig(null)).toBeNull();
    expect(parseQuietTimeConfig(undefined)).toBeNull();
    expect(parseQuietTimeConfig({ ignoreGlobal: true })).toBeNull();
    expect(parseQuietTimeConfig({ windows: "tonight" })).toBeNull();
    expect(parseQuietTimeConfig({ windows: [NIGHTLY], extra: 1 })).toBeNull();
  });
});

describe("resolveQuietHold — basics", () => {
  it("holds nothing for a rule-less alert, without reading the catalog", async () => {
    expect(await resolveQuietHold({ ruleId: null, severity: "critical", metric: null, assetId: null, now: NIGHT })).toBeNull();
    expect(await resolveQuietHold({ ruleId: undefined, severity: "critical", metric: null, assetId: null, now: NIGHT })).toBeNull();
    expect(prisma.quietTimeSchedule.findMany).not.toHaveBeenCalled();
  });

  it("is not quiet outside every window", async () => {
    db.schedules = [schedule("g1", {})];
    expect(await ask({ now: NOON })).toBeNull();
  });

  it("returns the whole-stretch end and an every-recipient hold for a plain policy", async () => {
    db.schedules = [schedule("g1", {})];
    const hold = await ask();
    expect(hold?.source).toEqual({ kind: "global", id: "g1", name: "Sched g1" });
    expect(hold?.windowEnd).toEqual(MORNING_END);
    expect(hold?.split).toBe(false);
    expect(hold?.isHeldFor("anyone@example.com")).toBe(true);
    expect(hold?.isHeldFor(null)).toBe(true);
  });

  it("reads only enabled schedules, oldest first, and only rules that carry a quiet time", async () => {
    await ask();
    expect(prisma.quietTimeSchedule.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { enabled: true }, orderBy: { createdAt: "asc" },
    }));
    const ruleWhere = stubbed(prisma.notificationRule.findMany).mock.calls[0]![0].where;
    expect(ruleWhere).toHaveProperty("NOT");
  });

  it("takes the FIRST matching schedule (the catalog's oldest-first order)", async () => {
    db.schedules = [schedule("old", {}, {}, 1), schedule("new", {}, {}, 2)];
    expect((await ask())?.source.id).toBe("old");
  });
});

describe("resolveQuietHold — matching a global schedule", () => {
  it("honours the legacy severities list", async () => {
    db.schedules = [schedule("g1", { severities: ["info", "warning"] })];
    expect(await ask({ severity: "warning" })).not.toBeNull();
    expect(await ask({ severity: "critical" })).toBeNull();
  });

  it("lets the fire through but holds the follow-ups under holds: followUps", async () => {
    db.schedules = [schedule("g1", { holds: "followUps" })];
    expect(await ask({ send: "fire" })).toBeNull();
    expect(await ask({ send: "reminder" })).not.toBeNull();
    expect(await ask({ send: "escalation" })).not.toBeNull();
  });

  it("honours alertKinds, and an alert with no metric matches only an any-kind schedule", async () => {
    db.schedules = [schedule("g1", { alertKinds: ["memPct"] })];
    expect(await ask({ metric: "memPct" })).not.toBeNull();
    expect(await ask({ metric: "cpuPct" })).toBeNull();
    expect(await ask({ metric: null })).toBeNull();
    db.schedules = [schedule("g2", {})];
    bumpQuietTimeCache();
    expect(await ask({ metric: null })).not.toBeNull();
  });

  it("falls through to the next schedule when the first does not match", async () => {
    db.schedules = [schedule("g1", { severities: ["critical"] }, {}, 1), schedule("g2", {}, {}, 2)];
    expect((await ask({ severity: "warning" }))?.source.id).toBe("g2");
  });

  it("ignores a schedule whose stored config no longer parses", async () => {
    db.schedules = [{ id: "bad", name: "Bad", scope: {}, quiet: { windows: "x" }, createdAt: new Date(2026, 0, 1) }, schedule("g2", {}, {}, 2)];
    expect((await ask())?.source.id).toBe("g2");
  });

  it("treats a bare {} scope as every device, without a device read", async () => {
    db.schedules = [schedule("g1", {}, {})];
    expect(await ask({ assetId: null })).not.toBeNull();
    expect(prisma.asset.findUnique).not.toHaveBeenCalled();
  });

  it("matches a constrained scope against the device (IPv4 subnet)", async () => {
    db.schedules = [schedule("g1", {}, { subnetCidrs: ["10.1.0.0/24"] })];
    stubbed(prisma.asset.findUnique).mockResolvedValue(assetRow("a1"));
    expect(await ask()).not.toBeNull();
    stubbed(prisma.asset.findUnique).mockResolvedValue(assetRow("a2", { ipAddress: "10.2.0.5" }));
    expect(await ask({ assetId: "a2" })).toBeNull();
  });

  it("matches a constrained scope on an IPv6 device", async () => {
    db.schedules = [schedule("g1", {}, { subnetCidrs: ["2001:db8::/32"] })];
    stubbed(prisma.asset.findUnique).mockResolvedValue(assetRow("a6", { ipAddress: "2001:db8::5" }));
    expect(await ask({ assetId: "a6" })).not.toBeNull();
  });

  it("never selects a device-less alert or an unknown device with a constrained scope", async () => {
    db.schedules = [schedule("g1", {}, { assetTypes: ["switch"] })];
    expect(await ask({ assetId: null })).toBeNull();
    expect(await ask({ assetId: "gone" })).toBeNull();
  });

  it("decorates the device row for the schedules' relation leaves", async () => {
    db.schedules = [schedule("g1", {}, { assetTypes: ["switch"] })];
    stubbed(prisma.asset.findUnique).mockResolvedValue(assetRow("a1"));
    await ask();
    expect(mocks.decorate).toHaveBeenCalledTimes(1);
    expect(mocks.decorate.mock.calls[0]![0]).toEqual([expect.objectContaining({ id: "a1", status: "active" })]);
  });
});

describe("resolveQuietHold — the automation's own setting", () => {
  it("judges an automation by its own policy and stamps the automation as the source", async () => {
    db.rules = [{ id: "r1", name: "Own", quietTime: { windows: [NIGHTLY] } }];
    const hold = await ask({ ruleId: "r1" });
    expect(hold?.source).toEqual({ kind: "automation", id: "r1", name: "Own" });
  });

  it("lets an unreadable rule blob fall back to the global schedules (never toward exempt)", async () => {
    db.rules = [{ id: "r-bad", name: "Bad", quietTime: { windows: 3 } }];
    db.schedules = [schedule("g1", {})];
    expect((await ask({ ruleId: "r-bad" }))?.source.kind).toBe("global");
  });
});

describe("recipient exceptions (rule 120)", () => {
  it("splits the hold per address when the policy carries exceptions", async () => {
    db.schedules = [schedule("g1", { recipients: [{ address: "oncall@example.com", held: {} }] })];
    const hold = await ask();
    expect(hold?.split).toBe(true);
    expect(hold?.isHeldFor("oncall@example.com")).toBe(false);
    expect(hold?.isHeldFor("ONCALL@example.com ")).toBe(false);
    expect(hold?.isHeldFor("someone@example.com")).toBe(true);
    expect(hold?.isHeldFor(null)).toBe(true);
  });

  it("opens a hold for an exception stricter than the policy, held only for that address", async () => {
    const kinds = { alerts: true, alertReminders: false, escalations: false, escalationReminders: false };
    db.schedules = [schedule("g1", { severities: ["critical"], recipients: [{ address: "boss@example.com", held: { warning: kinds } }] })];
    const hold = await ask({ severity: "warning" });
    expect(hold).not.toBeNull();
    expect(hold?.isHeldFor("boss@example.com")).toBe(true);
    expect(hold?.isHeldFor("other@example.com")).toBe(false);
    // A reminder is held for nobody: no hold at all.
    expect(await ask({ severity: "warning", send: "reminder" })).toBeNull();
  });
});

describe("the catalog cache", () => {
  it("reads the catalog once inside the TTL and again after a bump", async () => {
    db.schedules = [schedule("g1", {})];
    await ask();
    await ask({ severity: "critical" });
    expect(prisma.quietTimeSchedule.findMany).toHaveBeenCalledTimes(1);
    // A save made while cached is invisible until bumped.
    db.schedules = [];
    expect(await ask({ severity: "info" })).not.toBeNull();
    bumpQuietTimeCache();
    expect(await ask({ severity: "info" })).toBeNull();
    expect(prisma.quietTimeSchedule.findMany).toHaveBeenCalledTimes(2);
  });

  it("treats an unreadable catalog as not quiet, and retries on the next ask", async () => {
    db.schedules = [schedule("g1", {})];
    stubbed(prisma.notificationRule.findMany).mockRejectedValueOnce(new Error("db hiccup"));
    expect(await ask()).toBeNull();
    expect(await ask({ severity: "critical" })).not.toBeNull();
  });
});

describe("the per-pass memo", () => {
  it("answers a repeated question from the memo, keyed by send kind too", async () => {
    db.schedules = [schedule("g1", { holds: "followUps" })];
    const memo = newQuietHoldMemo();
    expect(await ask({ memo, send: "fire" })).toBeNull();
    expect(await ask({ memo, send: "reminder" })).not.toBeNull();
    expect(memo.holds.size).toBe(2);
    // A memoised answer stands even after the catalog changes.
    db.schedules = [];
    bumpQuietTimeCache();
    expect(await ask({ memo, send: "reminder" })).not.toBeNull();
  });

  it("reads each device once however many alerts it carries", async () => {
    db.schedules = [schedule("g1", {}, { assetTypes: ["switch"] })];
    stubbed(prisma.asset.findUnique).mockResolvedValue(assetRow("a1"));
    const memo = newQuietHoldMemo();
    await ask({ memo, metric: "cpuPct" });
    await ask({ memo, metric: "memPct" });
    expect(prisma.asset.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("primeQuietHoldAssets", () => {
  it("is a no-op when no schedule has a constrained scope", async () => {
    db.schedules = [schedule("g1", {})];
    const memo = newQuietHoldMemo();
    await primeQuietHoldAssets(["a1", "a2"], memo);
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
    expect(memo.assets.size).toBe(0);
  });

  it("reads the distinct unseen devices in one query and memoises misses as null", async () => {
    db.schedules = [schedule("g1", {}, { assetTypes: ["switch"] })];
    stubbed(prisma.asset.findMany).mockResolvedValue([assetRow("a1")]);
    const memo = newQuietHoldMemo();
    memo.assets.set("a0", null);
    await primeQuietHoldAssets(["a1", "a1", "a2", "a0"], memo);
    expect(prisma.asset.findMany).toHaveBeenCalledTimes(1);
    expect(stubbed(prisma.asset.findMany).mock.calls[0]![0].where).toEqual({ id: { in: ["a1", "a2"] } });
    expect(memo.assets.get("a1")).toMatchObject({ id: "a1" });
    expect(memo.assets.get("a2")).toBeNull();
    expect(mocks.decorate).toHaveBeenCalledTimes(1);
    // The per-alert resolve now hits the memo.
    await ask({ memo, assetId: "a1" });
    expect(prisma.asset.findUnique).not.toHaveBeenCalled();
  });

  it("skips the query when every device is already memoised", async () => {
    db.schedules = [schedule("g1", {}, { assetTypes: ["switch"] })];
    const memo = newQuietHoldMemo();
    memo.assets.set("a1", null);
    await primeQuietHoldAssets(["a1"], memo);
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
  });
});

describe("resolveQuietWindow (rule 92(f))", () => {
  it("names the open window whatever the policy holds for this severity", async () => {
    db.schedules = [schedule("g1", { severities: ["info"] })];
    expect(await ask({ severity: "critical" })).toBeNull();
    expect(await resolveQuietWindow({ ruleId: "r-plain", severity: "critical", metric: "cpuPct", assetId: "a1", now: NIGHT }))
      .toEqual({ kind: "global", id: "g1", name: "Sched g1" });
  });

  it("is null outside the window, for a rule-less alert, and for an ignore-global automation", async () => {
    db.schedules = [schedule("g1", {})];
    db.rules = [{ id: "r-ig", name: "IG", quietTime: { ignoreGlobal: true } }];
    expect(await resolveQuietWindow({ ruleId: "r-plain", severity: "warning", metric: null, assetId: null, now: NOON })).toBeNull();
    expect(await resolveQuietWindow({ ruleId: null, severity: "warning", metric: null, assetId: null, now: NIGHT })).toBeNull();
    expect(await resolveQuietWindow({ ruleId: "r-ig", severity: "warning", metric: null, assetId: null, now: NIGHT })).toBeNull();
  });

  it("answers from the automation's own window when it has one", async () => {
    db.rules = [{ id: "r1", name: "Own", quietTime: { windows: [NIGHTLY], severities: ["info"] } }];
    expect(await resolveQuietWindow({ ruleId: "r1", severity: "critical", metric: null, assetId: null, now: NIGHT }))
      .toEqual({ kind: "automation", id: "r1", name: "Own" });
    expect(await resolveQuietWindow({ ruleId: "r1", severity: "critical", metric: null, assetId: null, now: NOON })).toBeNull();
  });

  it("applies alert kind and scope like the hold does", async () => {
    db.schedules = [schedule("g1", { alertKinds: ["memPct"] }, {}, 1), schedule("g2", {}, { assetTypes: ["firewall"] }, 2)];
    stubbed(prisma.asset.findUnique).mockResolvedValue(assetRow("a1"));
    expect(await resolveQuietWindow({ ruleId: "r-plain", severity: "warning", metric: "cpuPct", assetId: "a1", now: NIGHT })).toBeNull();
    expect((await resolveQuietWindow({ ruleId: "r-plain", severity: "warning", metric: "memPct", assetId: "a1", now: NIGHT }))?.id).toBe("g1");
    stubbed(prisma.asset.findUnique).mockResolvedValue(assetRow("fw", { assetType: "firewall" }));
    expect((await resolveQuietWindow({ ruleId: "r-plain", severity: "warning", metric: "cpuPct", assetId: "fw", now: NIGHT }))?.id).toBe("g2");
    expect(await resolveQuietWindow({ ruleId: "r-plain", severity: "warning", metric: "cpuPct", assetId: null, now: NIGHT })).toBeNull();
  });
});

describe("quietSourceConfig", () => {
  it("reads a global schedule's row directly, enabled or not", async () => {
    stubbed(prisma.quietTimeSchedule.findUnique).mockResolvedValue({ name: "Nights", quiet: { windows: [NIGHTLY] } });
    const out = await quietSourceConfig({ kind: "global", id: "g1" });
    expect(out).toMatchObject({ name: "Nights", exists: true });
    expect(out?.config.windows).toHaveLength(1);
    expect(prisma.quietTimeSchedule.findUnique).toHaveBeenCalledWith({ where: { id: "g1" }, select: { name: true, quiet: true } });
  });

  it("reads an automation's row", async () => {
    stubbed(prisma.notificationRule.findUnique).mockResolvedValue({ name: "Own", quietTime: { windows: [NIGHTLY] } });
    expect(await quietSourceConfig({ kind: "automation", id: "r1" })).toMatchObject({ name: "Own", exists: true });
  });

  it("is null for a deleted source or an unreadable / exemption config", async () => {
    stubbed(prisma.quietTimeSchedule.findUnique).mockResolvedValue(null);
    expect(await quietSourceConfig({ kind: "global", id: "gone" })).toBeNull();
    stubbed(prisma.quietTimeSchedule.findUnique).mockResolvedValue({ name: "Bad", quiet: { windows: 1 } });
    expect(await quietSourceConfig({ kind: "global", id: "bad" })).toBeNull();
    stubbed(prisma.notificationRule.findUnique).mockResolvedValue(null);
    expect(await quietSourceConfig({ kind: "automation", id: "gone" })).toBeNull();
    stubbed(prisma.notificationRule.findUnique).mockResolvedValue({ name: "IG", quietTime: { ignoreGlobal: true } });
    expect(await quietSourceConfig({ kind: "automation", id: "ig" })).toBeNull();
  });
});
