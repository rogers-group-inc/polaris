/**
 * tests/unit/firmwareGroupService.test.ts — the own suite for
 * src/services/firmwareGroupService.ts (business rule 122, CQ-T010).
 *
 * Complements:
 *   - firmwareGroupOrdering.test.ts — the pure predicates (ancestorsOf, depthOf,
 *     pickNext, subtreeState, conflicts);
 *   - firmwareGroupExecutor.test.ts — advanceGroup's ordering against an
 *     in-memory group (deepest first, concurrency, health skips, subtree
 *     skips, the conflict wait, the image re-check, the email once);
 *   - tests/integration/firmwareGroup.test.ts — the routes on a real database.
 *
 * Adds what none of them reach without a database: PLACEMENT (resolve —
 * controller stamp, dependency-tree fallback, override-over-computed, the
 * Fortinet-stamp fallback when the tree has no rows, a switch from another
 * integration, the 400 / 404 guards), PLANNING (drops, the FortiAP warning,
 * MCLAG peers, the booking / other-group / existing-group reads), BOOKING
 * (concurrency bounds, one group per gate, supersession only when confirmed and
 * inside the transaction, the race and P2002 409s, the Events), CANCEL (pending
 * vs running, the race), the TICK (missed vs started vs a lost claim, a failing
 * pass), tryStart's remaining branches (deleted asset, deleted image, a drop at
 * start, the start-time health race, a plain failure), the reentrancy guard,
 * the summary email's failure paths and per-recipient zone, and the reads.
 *
 * No flash, SSH or HTTP: firmwareUpgradeService is mocked whole.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  assess: vi.fn(),
  health: vi.fn(),
  start: vi.fn(),
  recordCred: vi.fn(),
  assertTime: vi.fn(),
  normalize: vi.fn(),
  channel: vi.fn(),
  send: vi.fn(),
  render: vi.fn(),
  zone: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/firmwareUpgradeService.js", async () => {
  const { AppError } = await import("../../src/utils/errors.js");
  class FirmwareRunConflictError extends AppError {
    constructor(message: string) { super(409, message); this.name = "FirmwareRunConflictError"; }
  }
  return {
    FIRMWARE_ASSET_SELECT: {},
    FirmwareRunConflictError,
    assessGroupCandidate: h.assess,
    healthBlockers: h.health,
    recordFirmwareCredentialUse: h.recordCred,
    startFirmwareUpgrade: h.start,
  };
});
vi.mock("../../src/services/firmwareScheduleService.js", () => ({
  CONFLICT_WAIT_MS: 2 * 60 * 60_000,
  LATE_GRACE_MS: 15 * 60_000,
  assertSchedulableTime: h.assertTime,
  normalizeRecipients: h.normalize,
}));
vi.mock("../../src/services/notificationDeliveryService.js", () => ({
  applyBrandLetterhead: async (m: unknown) => m,
  sendEmailThroughChannel: h.send,
}));
vi.mock("../../src/services/quietTimeSummaryService.js", () => ({ resolveSummaryChannel: h.channel }));
vi.mock("../../src/services/userTimezoneService.js", () => ({ resolveTimeZone: h.zone, serverTimeZone: () => "Server/Zone" }));
vi.mock("../../src/utils/firmwareGroupResultEmailTemplate.js", () => ({ renderFirmwareGroupResultEmail: h.render }));

import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { AppError } from "../../src/utils/errors.js";
import { FirmwareRunConflictError } from "../../src/services/firmwareUpgradeService.js";
import {
  MAX_GROUP_SIZE,
  activeGroupForAsset,
  advanceGroup,
  advanceGroupForRun,
  cancelGroupSchedule,
  createGroupSchedule,
  getGroupSchedule,
  listGroupSchedules,
  planGroup,
  recordGroupCredentialUse,
  resolveGroupSources,
  runDueGroupSchedules,
} from "../../src/services/firmwareGroupService.js";

const db = prisma as any;
const NOW = new Date("2026-10-17T02:00:00Z");

// ─── An in-memory fleet for placement / planning ─────────────────────────────

type Row = Record<string, any>;
const fleet = {
  assets: new Map<string, Row>(),
  edges: [] as Array<{ assetId: string; parentAssetId: string; source: "override" | "computed" }>,
  integrations: [] as Array<{ id: string; name: string }>,
};

function asset(id: string, assetType: string, extra: Row = {}): Row {
  const row = {
    id, hostname: id, ipAddress: "192.0.2.10", dnsName: null, serialNumber: null, manufacturer: "Fortinet", assetType,
    model: null, osVersion: "7.4.3", status: "active", monitored: true, monitorStatus: "up", dependencySuppressed: false,
    discoveredByIntegrationId: "int-1", fortinetTopology: null, ...extra,
  };
  fleet.assets.set(id, row);
  return row;
}

function installFleet(): void {
  db.asset.findMany.mockImplementation(async ({ where }: any) => {
    const all = [...fleet.assets.values()];
    if (where?.assetType?.in) return all.filter((a) => where.assetType.in.includes(a.assetType));
    if (where?.id?.in) return all.filter((a) => where.id.in.includes(a.id));
    return [];
  });
  db.assetDependencyParent.findMany.mockImplementation(async ({ where }: any) =>
    fleet.edges
      .filter((e) => where.assetId.in.includes(e.assetId) && where.source.in.includes(e.source))
      .map((e) => ({ ...e, parent: { assetType: fleet.assets.get(e.parentAssetId)?.assetType ?? "switch" } })));
  db.integration.findMany.mockImplementation(async ({ where }: any) => fleet.integrations.filter((i) => where.id.in.includes(i.id)));
  db.assetMclagPeer.findMany.mockResolvedValue([]);
  db.firmwareUpgradeRun.findMany.mockResolvedValue([]);
  db.firmwareUpgradeSchedule.findMany.mockResolvedValue([]);
  db.firmwareGroupSchedule.findFirst.mockResolvedValue(null);
  db.firmwareGroupMember.findMany.mockResolvedValue([]);
}

/** G (gate, serial FGT1) ── S1 (stamped) ── A1 (tree only); a second gate G2. */
function siteFleet(): void {
  asset("G", "firewall", { serialNumber: "FGT1", hostname: "gate-a" });
  asset("S1", "switch", { fortinetTopology: { controllerSerial: "FGT1" } });
  asset("A1", "access_point");
  fleet.edges.push({ assetId: "A1", parentAssetId: "S1", source: "computed" });
  fleet.integrations.push({ id: "int-1", name: "FMG Prod" });
}

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  fleet.assets.clear();
  fleet.edges = [];
  fleet.integrations = [];
  for (const f of Object.values(h)) f.mockReset();
  h.assess.mockImplementation(async (a: Row) => ({ ok: true, image: { id: `img-${a.assetType}`, versionLabel: "7.6.8" }, fromVersion: a.osVersion, warnings: [] }));
  h.health.mockReturnValue([]);
  h.recordCred.mockResolvedValue(undefined);
  h.normalize.mockImplementation((l: string[]) => l.map((e) => e.toLowerCase()));
  h.channel.mockResolvedValue({ type: "smtp", config: { host: "mail" } });
  h.send.mockResolvedValue(undefined);
  h.render.mockImplementation((i: Row) => ({ subject: `Group ${i.outcome}`, text: "t", html: "<p>h</p>" }));
  h.zone.mockImplementation((tz: string | null) => tz ?? "UTC");
  installFleet();
});

// ─── Placement ───────────────────────────────────────────────────────────────

describe("resolveGroupSources — placement", () => {
  it("refuses an empty selection and one over the cap with 400", async () => {
    await expect(resolveGroupSources([])).rejects.toMatchObject({ httpStatus: 400, message: "Select at least one device" });
    const many = Array.from({ length: MAX_GROUP_SIZE + 1 }, (_, i) => `a${i}`);
    await expect(resolveGroupSources(many)).rejects.toMatchObject({ httpStatus: 400 });
    expect(db.asset.findMany).not.toHaveBeenCalled();
  });

  it("de-duplicates the selection and 404s with the count of vanished assets", async () => {
    asset("G", "firewall");
    await expect(resolveGroupSources(["G", "G", "gone1", "gone2"])).rejects.toMatchObject({ httpStatus: 404, message: expect.stringMatching(/^2 of the selected assets no longer exist/) });
  });

  it("places a switch by its controller stamp and an AP through the dependency tree's first firewall", async () => {
    siteFleet();
    const r = await resolveGroupSources(["A1", "S1", "G"]);
    expect(r.unresolved).toEqual([]);
    expect(r.unsupported).toEqual([]);
    expect(r.sources).toEqual([{ gateAssetId: "G", gateName: "gate-a", integrationId: "int-1", integrationName: "FMG Prod", assetIds: ["G", "S1", "A1"] }]); // the asset read's order

  });

  it("walks the tree one query per level, not one per device", async () => {
    siteFleet();
    asset("A2", "access_point");
    fleet.edges.push({ assetId: "A2", parentAssetId: "S1", source: "computed" });
    fleet.edges.push({ assetId: "S1", parentAssetId: "G", source: "computed" });
    await resolveGroupSources(["A1", "A2"]);
    // level 0 = {A1, A2}, level 1 = {S1}; G is a firewall so the walk stops.
    expect(db.assetDependencyParent.findMany).toHaveBeenCalledTimes(2);
    expect(db.assetDependencyParent.findMany.mock.calls[0][0].where.assetId.in).toEqual(["A1", "A2"]);
    expect(db.assetDependencyParent.findMany.mock.calls[1][0].where.assetId.in).toEqual(["S1"]);
  });

  it("an override parent wins over the computed one", async () => {
    asset("G", "firewall", { hostname: "gate-a" });
    asset("G2", "firewall", { hostname: "gate-b" });
    asset("A1", "access_point");
    fleet.edges.push({ assetId: "A1", parentAssetId: "G", source: "computed" });
    fleet.edges.push({ assetId: "A1", parentAssetId: "G2", source: "override" });
    const r = await resolveGroupSources(["A1"]);
    expect(r.sources.map((s) => s.gateAssetId)).toEqual(["G2"]);
  });

  it("with no tree rows, falls back to the Fortinet stamps: an AP's parentSwitch, then that switch's controller", async () => {
    asset("G", "firewall", { serialNumber: "FGT1" });
    asset("S1", "switch", { hostname: "idf-1", fortinetTopology: { controllerSerial: "FGT1" } });
    asset("A1", "access_point", { fortinetTopology: { parentSwitch: "IDF-1" } });
    const r = await resolveGroupSources(["A1"]);
    expect(r.unresolved).toEqual([]);
    expect(r.sources[0]).toMatchObject({ gateAssetId: "G", assetIds: ["A1"] });
  });

  it("names a switch it cannot place, and one discovered by a different integration than its gate", async () => {
    siteFleet();
    asset("S9", "switch");
    asset("S2", "switch", { discoveredByIntegrationId: "int-2", fortinetTopology: { controllerSerial: "FGT1" } });
    const r = await resolveGroupSources(["S9", "S2", "G"]);
    expect(r.sources).toEqual([expect.objectContaining({ gateAssetId: "G", assetIds: ["G"] })]);
    expect(r.unresolved).toEqual([
      { assetId: "S9", name: "S9", reason: expect.stringMatching(/cannot tell which FortiGate controls it/) },
      { assetId: "S2", name: "S2", reason: "it was discovered by a different integration than its FortiGate gate-a" },
    ]);
  });

  it("a device with no integration of its own is placed under any gate", async () => {
    siteFleet();
    fleet.assets.get("S1")!.discoveredByIntegrationId = null;
    const r = await resolveGroupSources(["S1"]);
    expect(r.unresolved).toEqual([]);
    expect(r.sources[0].gateAssetId).toBe("G");
  });

  it("lists non-Fortinet-infra assets as unsupported and sorts sources by gate name", async () => {
    asset("GB", "firewall", { hostname: "beta" });
    asset("GA", "firewall", { hostname: "alpha", discoveredByIntegrationId: null });
    asset("SRV", "server", { hostname: "db01" });
    const r = await resolveGroupSources(["GB", "GA", "SRV"]);
    expect(r.unsupported).toEqual([{ assetId: "SRV", name: "db01", reason: expect.stringMatching(/only FortiGates/) }]);
    expect(r.sources.map((s) => s.gateName)).toEqual(["alpha", "beta"]);
    expect(r.sources[0]).toMatchObject({ integrationId: null, integrationName: null });
  });
});

// ─── Planning ────────────────────────────────────────────────────────────────

describe("planGroup", () => {
  it("refuses an unsupported device, an unplaced one, and a selection spanning two gates", async () => {
    siteFleet();
    asset("SRV", "server");
    await expect(planGroup(["G", "SRV"])).rejects.toMatchObject({ httpStatus: 400, message: expect.stringMatching(/SRV is not$/) });
    asset("S9", "switch");
    await expect(planGroup(["G", "S9"])).rejects.toMatchObject({ httpStatus: 400, message: expect.stringMatching(/cannot place S9 \(/) });
    asset("G2", "firewall", { hostname: "gate-b" });
    await expect(planGroup(["G", "G2"])).rejects.toMatchObject({ httpStatus: 400, message: expect.stringMatching(/spans 2: gate-a \(1\), gate-b \(1\)/) });
  });

  it("orders deepest first, keeps each member's ancestors, drops with kind + reason", async () => {
    siteFleet();
    fleet.edges.push({ assetId: "S1", parentAssetId: "G", source: "computed" });
    h.assess.mockImplementation(async (a: Row) => a.id === "S1"
      ? { ok: false, kind: "current", reason: "already on 7.6.8" }
      : { ok: true, image: { id: `img-${a.id}`, versionLabel: "7.6.8" }, fromVersion: a.osVersion, warnings: a.id === "G" ? ["HA lag"] : [] });
    db.firmwareUpgradeRun.findMany.mockResolvedValue([{ assetId: "A1" }]);
    const plan = await planGroup(["G", "S1", "A1"]);
    expect(plan.gate).toEqual({ assetId: "G", name: "gate-a", integrationId: "int-1", integrationName: "FMG Prod" });
    expect(plan.included.map((m) => [m.assetId, m.depth, m.ancestorIds])).toEqual([["A1", 3, ["S1", "G"]], ["G", 1, []]]);
    expect(plan.included[1]).toMatchObject({ imageId: "img-G", toVersion: "7.6.8", fromVersion: "7.4.3", warnings: ["HA lag"] });
    expect(plan.dropped).toEqual([{ assetId: "S1", name: "S1", assetType: "switch", model: null, depth: 2, fromVersion: "7.4.3", kind: "current", reason: "already on 7.6.8" }]);
    // A1 has flashed before: no FortiAP warning.
    expect(plan.included[0].warnings).toEqual([]);
  });

  it("warns on a FortiAP no run has ever flashed, and asks only about the included APs", async () => {
    siteFleet();
    const plan = await planGroup(["A1", "G"]);
    expect(db.firmwareUpgradeRun.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { assetId: { in: ["A1"] }, status: "succeeded" } }));
    expect(plan.included.find((m) => m.assetId === "A1")!.warnings[0]).toMatch(/no firmware upgrade has succeeded on this FortiAP before/);
  });

  it("records MCLAG peers both ways, only those inside the selection", async () => {
    asset("G", "firewall", { serialNumber: "FGT1" });
    asset("S1", "switch", { fortinetTopology: { controllerSerial: "FGT1" } });
    asset("S2", "switch", { fortinetTopology: { controllerSerial: "FGT1" } });
    db.assetMclagPeer.findMany.mockResolvedValue([{ assetId: "S1", matchedAssetId: "S2" }, { assetId: "S1", matchedAssetId: "OUTSIDE" }, { assetId: "S2", matchedAssetId: null }]);
    const plan = await planGroup(["S1", "S2", "G"]);
    const peers = Object.fromEntries(plan.included.map((m) => [m.assetId, m.mclagPeerIds]));
    expect(peers).toEqual({ S1: ["S2"], S2: ["S1"], G: [] });
  });

  it("reports the gate's existing group, pending single-device bookings and members in another gate's group", async () => {
    siteFleet();
    const when = new Date("2026-10-20T02:00:00Z");
    db.firmwareUpgradeSchedule.findMany.mockResolvedValue([{ id: "sch-1", assetId: "S1", scheduledFor: when, toVersion: "7.6.8" }]);
    db.firmwareGroupSchedule.findFirst.mockResolvedValue({ id: "grp-0", scheduledFor: when, status: "pending" });
    db.firmwareGroupMember.findMany.mockResolvedValue([{ assetId: "A1", groupId: "grp-9" }]);
    const plan = await planGroup(["S1", "A1"]);
    expect(plan.individualBookings).toEqual([{ scheduleId: "sch-1", assetId: "S1", name: "S1", scheduledFor: when, toVersion: "7.6.8" }]);
    expect(plan.existingGroup).toEqual({ id: "grp-0", scheduledFor: when, status: "pending" });
    expect(plan.otherGroups).toEqual([{ assetId: "A1", name: "A1", groupId: "grp-9" }]);
    expect(db.firmwareGroupMember.findMany.mock.calls[0][0].where.group.gateAssetId).toEqual({ not: "G" });
  });

  it("with nothing included, never queries bookings or other groups", async () => {
    siteFleet();
    h.assess.mockResolvedValue({ ok: false, kind: "no-image", reason: "no image" });
    const plan = await planGroup(["G"]);
    expect(plan.included).toEqual([]);
    expect(db.firmwareUpgradeSchedule.findMany).not.toHaveBeenCalled();
    expect(db.firmwareGroupMember.findMany).not.toHaveBeenCalled();
  });
});

// ─── Booking ─────────────────────────────────────────────────────────────────

function groupDetailRow(id: string, extra: Row = {}): Row {
  return {
    id, gateAssetId: "G", scheduledFor: NOW, concurrency: 1, notifyEmails: ["ops@example.com"], status: "pending", error: null,
    createdBy: "alice", createdAt: NOW, cancelledBy: null, cancelledAt: null, firedAt: null, finishedAt: null, notifiedAt: null,
    notifyError: null, gate: { id: "G", hostname: "gate-a", ipAddress: null }, members: [], ...extra,
  };
}

const booking = (extra: Partial<Parameters<typeof createGroupSchedule>[0]> = {}) => ({
  assetIds: ["G", "S1"], scheduledFor: new Date("2026-10-20T02:00:00Z"), concurrency: 2, notifyEmails: ["Ops@Example.com"],
  cancelIndividual: false, actor: "alice", now: NOW, ...extra,
});

describe("createGroupSchedule", () => {
  beforeEach(() => {
    siteFleet();
    db.firmwareGroupSchedule.create.mockResolvedValue({ id: "grp-1" });
    db.firmwareGroupSchedule.findUnique.mockResolvedValue(groupDetailRow("grp-1"));
  });

  it("checks the time and normalizes recipients before anything else", async () => {
    h.assertTime.mockImplementation(() => { throw new AppError(400, "Pick a time at least a minute from now"); });
    await expect(createGroupSchedule(booking())).rejects.toMatchObject({ httpStatus: 400 });
    expect(h.assertTime).toHaveBeenCalledWith(booking().scheduledFor, NOW);
    expect(db.asset.findMany).not.toHaveBeenCalled();
  });

  it.each([0, 11, 1.5, Number.NaN])("refuses concurrency %s", async (concurrency) => {
    await expect(createGroupSchedule(booking({ concurrency }))).rejects.toMatchObject({ httpStatus: 400, message: "Concurrency must be a whole number from 1 to 10" });
    expect(db.asset.findMany).not.toHaveBeenCalled();
  });

  it("one group per gate: a running or pending group on it is a 409", async () => {
    db.firmwareGroupSchedule.findFirst.mockResolvedValueOnce({ id: "g0", scheduledFor: NOW, status: "running" });
    await expect(createGroupSchedule(booking())).rejects.toMatchObject({ httpStatus: 409, message: expect.stringMatching(/already running on gate-a — only one group per FortiGate/) });
    db.firmwareGroupSchedule.findFirst.mockResolvedValueOnce({ id: "g0", scheduledFor: NOW, status: "pending" });
    await expect(createGroupSchedule(booking())).rejects.toMatchObject({ message: expect.stringMatching(/already scheduled for 2026-10-17T02:00:00.000Z on gate-a/) });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("a device in another gate's group, or nothing to upgrade, is a 409", async () => {
    db.firmwareGroupMember.findMany.mockResolvedValueOnce([{ assetId: "S1", groupId: "g9" }]);
    await expect(createGroupSchedule(booking())).rejects.toMatchObject({ httpStatus: 409, message: "S1 is already in another group upgrade" });
    h.assess.mockResolvedValue({ ok: false, kind: "current", reason: "current" });
    await expect(createGroupSchedule(booking())).rejects.toMatchObject({ httpStatus: 409, message: expect.stringMatching(/^Nothing to upgrade/) });
  });

  it("supersession needs the operator's confirmation", async () => {
    db.firmwareUpgradeSchedule.findMany.mockResolvedValue([{ id: "sch-1", assetId: "S1", scheduledFor: NOW, toVersion: "7.6.8" }]);
    await expect(createGroupSchedule(booking())).rejects.toMatchObject({ httpStatus: 409, message: expect.stringMatching(/1 selected device has a single-device upgrade scheduled \(S1\).*cancels it — confirm/) });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("confirmed: cancels the single bookings and creates the group in ONE transaction, then logs each", async () => {
    db.firmwareUpgradeSchedule.findMany.mockResolvedValue([{ id: "sch-1", assetId: "S1", scheduledFor: NOW, toVersion: "7.6.8" }]);
    db.firmwareUpgradeSchedule.updateMany.mockResolvedValue({ count: 1 });
    h.assess.mockImplementation(async (a: Row) => a.id === "A1"
      ? { ok: false, kind: "no-credential", reason: "no login bound" }
      : { ok: true, image: { id: `img-${a.id}`, versionLabel: "7.6.8" }, fromVersion: "7.4.3", warnings: [] });
    const out = await createGroupSchedule(booking({ assetIds: ["G", "S1", "A1"], cancelIndividual: true }));
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.firmwareUpgradeSchedule.updateMany).toHaveBeenCalledWith({
      where: { id: "sch-1", status: "pending" },
      data: expect.objectContaining({ status: "cancelled", cancelledBy: "alice", error: "Superseded by a group firmware upgrade" }),
    });
    const data = db.firmwareGroupSchedule.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ gateAssetId: "G", integrationId: "int-1", concurrency: 2, notifyEmails: ["ops@example.com"], createdBy: "alice" });
    expect(data.members.create).toEqual([
      expect.objectContaining({ assetId: "S1", imageId: "img-S1", state: "planned", depth: 2, ancestorIds: ["G"] }),
      expect.objectContaining({ assetId: "G", imageId: "img-G", state: "planned", depth: 1, ancestorIds: [] }),
      { assetId: "A1", fromVersion: "7.4.3", depth: 3, ancestorIds: [], mclagPeerIds: [], state: "dropped", detail: "no login bound" },
    ]);
    const actions = eventLog.logEvent.mock.calls.map((c) => c[0].action);
    expect(actions).toEqual(["firmware.upgrade_schedule_cancelled", "firmware.group_upgrade_scheduled"]);
    expect(eventLog.logEvent.mock.calls[0][0].details).toEqual({ scheduleId: "sch-1", supersededByGroupId: "grp-1" });
    expect(eventLog.logEvent.mock.calls[1][0].message).toMatch(/2 devices to upgrade, 1 dropped, 1 single-device booking superseded; concurrency 2; results to ops@example.com/);
    expect(out.group.id).toBe("grp-1");
  });

  it("a single booking that started while booking is a 409, and nothing is created", async () => {
    db.firmwareUpgradeSchedule.findMany.mockResolvedValue([{ id: "sch-1", assetId: "S1", scheduledFor: NOW, toVersion: "7.6.8" }]);
    db.firmwareUpgradeSchedule.updateMany.mockResolvedValue({ count: 0 });
    await expect(createGroupSchedule(booking({ cancelIndividual: true }))).rejects.toMatchObject({ httpStatus: 409, message: expect.stringMatching(/on S1 started or changed/) });
    expect(db.firmwareGroupSchedule.create).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("the partial unique index losing a race (P2002) becomes the one-group 409", async () => {
    db.firmwareGroupSchedule.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    await expect(createGroupSchedule(booking())).rejects.toMatchObject({ httpStatus: 409, message: expect.stringMatching(/just booked on gate-a/) });
    db.firmwareGroupSchedule.create.mockRejectedValue(new Error("db down"));
    await expect(createGroupSchedule(booking())).rejects.toThrow("db down");
  });
});

describe("recordGroupCredentialUse", () => {
  it("records the login use for every device", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `a${i}`);
    await recordGroupCredentialUse(ids, { actor: "alice" } as never);
    expect(h.recordCred.mock.calls.map((c) => c[0])).toEqual(ids);
  });
});

// ─── An in-memory group for cancel / execution ───────────────────────────────

const world = {
  group: null as Row | null,
  members: [] as Row[],
  runs: new Map<string, Row>(),
  users: [] as Row[],
};

function matches(row: Row, where: Row): boolean {
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

function view(m: Row): Row {
  const a = fleet.assets.get(m.assetId) ?? { id: m.assetId, hostname: null, ipAddress: null, assetType: "switch", model: null };
  return { ...m, asset: { ...a }, run: m.runId ? { ...world.runs.get(m.runId) } : null };
}

function installGroupWorld(group: Row, members: Row[]): void {
  world.group = groupDetailRow(group.id ?? "g1", group);
  world.members = members;
  db.firmwareGroupSchedule.findUnique.mockImplementation(async () => world.group
    ? { ...world.group, gate: { id: "G", hostname: "gate-a", ipAddress: null }, members: world.members.map(view) }
    : null);
  db.firmwareGroupSchedule.updateMany.mockImplementation(async ({ where, data }: any) => {
    if (!world.group || !matches(world.group, where)) return { count: 0 };
    Object.assign(world.group, data);
    return { count: 1 };
  });
  db.firmwareGroupSchedule.update.mockImplementation(async ({ data }: any) => Object.assign(world.group!, data));
  db.firmwareGroupMember.findMany.mockImplementation(async () => world.members.map(view));
  db.firmwareGroupMember.update.mockImplementation(async ({ where, data }: any) => Object.assign(world.members.find((m) => m.id === where.id)!, data));
  db.firmwareGroupMember.updateMany.mockImplementation(async ({ where, data }: any) => {
    const hit = world.members.filter((m) => matches(m, where));
    for (const m of hit) Object.assign(m, data);
    return { count: hit.length };
  });
  db.asset.findUnique.mockImplementation(async ({ where }: any) => (fleet.assets.has(where.id) ? { ...fleet.assets.get(where.id) } : null));
  db.user.findMany.mockImplementation(async () => world.users);
}

function member(assetId: string, extra: Row = {}): Row {
  return { id: `m-${assetId}`, groupId: "g1", assetId, depth: 2, ancestorIds: ["G"], mclagPeerIds: [], state: "planned", skipKind: null, detail: null, imageId: "img-1", toVersion: "7.6.8", fromVersion: "7.4.3", runId: null, eligibleAt: null, startedAt: null, finishedAt: null, ...extra };
}

beforeEach(() => {
  world.group = null;
  world.members = [];
  world.runs.clear();
  world.users = [];
  h.assess.mockImplementation(async () => ({ ok: true, image: { id: "img-1", versionLabel: "7.6.8" }, fromVersion: "7.4.3", warnings: [] }));
});

describe("cancelGroupSchedule", () => {
  beforeEach(() => { asset("G", "firewall", { hostname: "gate-a" }); asset("S1", "switch"); });

  it("404 for an unknown group, 409 for a finished one", async () => {
    db.firmwareGroupSchedule.findUnique.mockResolvedValue(null);
    await expect(cancelGroupSchedule("nope", "bob")).rejects.toMatchObject({ httpStatus: 404 });
    installGroupWorld({ status: "completed" }, []);
    await expect(cancelGroupSchedule("g1", "bob")).rejects.toMatchObject({ httpStatus: 409, message: "This group upgrade is already completed" });
  });

  it("a pending group: finished now, every waiting member skipped as cancelled, no pass, no email", async () => {
    installGroupWorld({ status: "pending" }, [member("S1"), member("G", { state: "dropped", depth: 1, ancestorIds: [] })]);
    const out = await cancelGroupSchedule("g1", "bob");
    expect(world.group).toMatchObject({ status: "cancelled", cancelledBy: "bob" });
    expect(world.group!.finishedAt).toBeInstanceOf(Date);
    expect(world.members[0]).toMatchObject({ state: "skipped", skipKind: "cancelled", detail: "the group was cancelled by bob before it started" });
    expect(world.members[1].state).toBe("dropped");
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "firmware.group_upgrade_cancelled", resourceName: "gate-a", details: { groupId: "g1", wasRunning: false } });
    expect(db.firmwareGroupMember.findMany).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(out.status).toBe("cancelled");
  });

  it("a running group with nothing flashing: stopped, then the summary goes at once as 'cancelled'", async () => {
    installGroupWorld({ status: "running", firedAt: NOW }, [member("S1")]);
    await cancelGroupSchedule("g1", "bob");
    expect(world.members[0]).toMatchObject({ state: "skipped", detail: "stopped by bob" });
    expect(world.group!.finishedAt).toBeInstanceOf(Date);
    expect(h.render).toHaveBeenCalledWith(expect.objectContaining({ outcome: "cancelled", cancelledBy: "bob" }));
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("a running group with a flash under way waits for it before emailing", async () => {
    world.runs.set("r1", { status: "running", result: null, error: null, stage: "deploying" });
    installGroupWorld({ status: "running", firedAt: NOW }, [member("S1", { state: "running", runId: "r1" })]);
    await cancelGroupSchedule("g1", "bob");
    expect(world.members[0].state).toBe("running");
    expect(h.send).not.toHaveBeenCalled();
  });

  it("a group that changed under the cancel is a 409", async () => {
    installGroupWorld({ status: "pending" }, []);
    db.firmwareGroupSchedule.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(cancelGroupSchedule("g1", "bob")).rejects.toMatchObject({ httpStatus: 409, message: expect.stringMatching(/changed while you were cancelling/) });
    expect(db.firmwareGroupMember.updateMany).not.toHaveBeenCalled();
  });
});

// ─── Execution: tryStart's remaining branches ────────────────────────────────

describe("advanceGroup — starting a member", () => {
  beforeEach(() => { asset("G", "firewall", { hostname: "gate-a" }); asset("S1", "switch"); });

  it("starts through startFirmwareUpgrade with the member id and the booker as actor", async () => {
    installGroupWorld({ status: "running", firedAt: NOW }, [member("S1")]);
    h.start.mockResolvedValue({ id: "r1" });
    await advanceGroup("g1", NOW);
    expect(h.start).toHaveBeenCalledWith({ assetId: "S1", imageId: "img-1", actor: "alice", groupMemberId: "m-S1" });
    expect(world.group!.status).toBe("running");
  });

  it("a deleted asset is dropped", async () => {
    installGroupWorld({ status: "running", firedAt: NOW }, [member("GONE")]);
    await advanceGroup("g1", NOW);
    expect(world.members[0]).toMatchObject({ state: "dropped", detail: "the asset was deleted" });
    expect(h.start).not.toHaveBeenCalled();
  });

  it("an image deleted from the Repository since booking drops the member — never another image", async () => {
    installGroupWorld({ status: "running", firedAt: NOW }, [member("S1", { imageId: null })]);
    await advanceGroup("g1", NOW);
    expect(world.members[0]).toMatchObject({ state: "dropped", detail: "the approved image (7.6.8) was deleted from the Repository" });
    expect(h.start).not.toHaveBeenCalled();
  });

  it("an assessment that fails for another reason than 'current' drops it with that reason", async () => {
    installGroupWorld({ status: "running", firedAt: NOW }, [member("S1")]);
    h.assess.mockResolvedValue({ ok: false, kind: "no-credential", reason: "No login is bound for this model" });
    await advanceGroup("g1", NOW);
    expect(world.members[0]).toMatchObject({ state: "dropped", detail: "No login is bound for this model" });
  });

  it("the health gate inside startFirmwareUpgrade, lost in a race, records a health skip without the prefix", async () => {
    installGroupWorld({ status: "running", firedAt: NOW }, [member("S1")]);
    h.start.mockRejectedValue(new AppError(409, "Cannot start: the device is down"));
    await advanceGroup("g1", NOW);
    expect(world.members[0]).toMatchObject({ state: "skipped", skipKind: "health", detail: "the device is down" });
    expect(eventLog.logEvent.mock.calls.find((c) => c[0].action === "firmware.group_member_skipped")![0]).toMatchObject({ level: "warning", details: { groupId: "g1", memberId: "m-S1", skipKind: "health" } });
  });

  it("any other refusal fails the member and the group still completes", async () => {
    installGroupWorld({ status: "running", firedAt: NOW }, [member("S1")]);
    h.start.mockRejectedValue(new AppError(409, "No login bound"));
    await advanceGroup("g1", NOW);
    expect(world.members[0]).toMatchObject({ state: "failed", detail: "No login bound" });
    expect(world.group!.status).toBe("completed");
    const done = eventLog.logEvent.mock.calls.find((c) => c[0].action === "firmware.group_upgrade_completed")![0];
    expect(done.level).toBe("warning");
    expect(done.message).toBe("Group firmware upgrade finished: 1 failed");
  });

  it("a conflict keeps the FIRST eligible time across passes", async () => {
    installGroupWorld({ status: "running", firedAt: NOW }, [member("S1")]);
    h.start.mockRejectedValue(new FirmwareRunConflictError("busy above"));
    await advanceGroup("g1", NOW);
    await advanceGroup("g1", new Date(NOW.getTime() + 30 * 60_000));
    expect(world.members[0]).toMatchObject({ state: "waiting", detail: "busy above", eligibleAt: NOW });
  });

  it("never starts more than the concurrency, counting runs already under way", async () => {
    world.runs.set("r0", { status: "running" });
    asset("S2", "switch");
    installGroupWorld({ status: "running", firedAt: NOW, concurrency: 1 }, [member("S1", { state: "running", runId: "r0" }), member("S2")]);
    await advanceGroup("g1", NOW);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("a pending group is never started by a pass", async () => {
    installGroupWorld({ status: "pending" }, [member("S1")]);
    await advanceGroup("g1", NOW);
    expect(h.start).not.toHaveBeenCalled();
    expect(world.members[0].state).toBe("planned");
  });

  it("an unknown group is a no-op", async () => {
    db.firmwareGroupSchedule.findUnique.mockResolvedValue(null);
    await advanceGroup("nope", NOW);
    expect(db.firmwareGroupMember.findMany).not.toHaveBeenCalled();
  });
});

describe("advanceGroup — recording ended runs", () => {
  beforeEach(() => { asset("G", "firewall", { hostname: "gate-a" }); asset("S1", "switch"); asset("S2", "switch"); });

  it("maps succeeded / already-current / unverified / failed onto member states, with the run's error on the bad ones", async () => {
    asset("S3", "switch");
    asset("S4", "switch");
    world.runs.set("r1", { status: "succeeded", result: "upgraded", error: null });
    world.runs.set("r2", { status: "succeeded", result: "already-current", error: null });
    world.runs.set("r3", { status: "unverified", result: null, error: "version unreadable" });
    world.runs.set("r4", { status: "cancelled", result: null, error: "orphaned by a restart" });
    installGroupWorld({ status: "running", firedAt: NOW }, [
      member("S1", { state: "running", runId: "r1" }), member("S2", { state: "running", runId: "r2" }),
      member("S3", { state: "running", runId: "r3" }), member("S4", { state: "running", runId: "r4" }),
    ]);
    await advanceGroup("g1", NOW);
    expect(world.members.map((m) => [m.state, m.detail ?? null])).toEqual([
      ["upgraded", null], ["already-current", null], ["unverified", "version unreadable"], ["failed", "orphaned by a restart"],
    ]);
    expect(world.members.every((m) => m.finishedAt === NOW)).toBe(true);
    const done = eventLog.logEvent.mock.calls.find((c) => c[0].action === "firmware.group_upgrade_completed")![0];
    expect(done.message).toBe("Group firmware upgrade finished: 1 upgraded, 1 already current, 1 failed, 1 unverified");
  });

  it("a queued or running run is left alone", async () => {
    world.runs.set("r1", { status: "queued" });
    installGroupWorld({ status: "running", firedAt: NOW }, [member("S1", { state: "running", runId: "r1" })]);
    await advanceGroup("g1", NOW);
    expect(db.firmwareGroupMember.update).not.toHaveBeenCalled();
    expect(world.group!.status).toBe("running");
  });

  it("a clean finish logs at info and tallies health / upstream / not-started skips apart", async () => {
    installGroupWorld({ status: "running", firedAt: NOW }, [
      member("S1", { state: "skipped", skipKind: "health" }),
      member("S2", { state: "skipped", skipKind: "subtree" }),
      member("G", { state: "skipped", skipKind: "cancelled" }),
    ]);
    await advanceGroup("g1", NOW);
    const done = eventLog.logEvent.mock.calls.find((c) => c[0].action === "firmware.group_upgrade_completed")![0];
    expect(done.level).toBe("info");
    expect(done.message).toBe("Group firmware upgrade finished: 1 skipped (health), 1 skipped (upstream), 1 not started");
  });

  it("advanceGroupForRun advances the run's group, and does nothing for a run outside any group", async () => {
    db.firmwareGroupMember.findUnique.mockResolvedValueOnce(null);
    await advanceGroupForRun("solo");
    expect(db.firmwareGroupSchedule.findUnique).not.toHaveBeenCalled();
    installGroupWorld({ status: "running", firedAt: NOW }, [member("S1")]);
    db.firmwareGroupMember.findUnique.mockResolvedValueOnce({ groupId: "g1" });
    await advanceGroupForRun("r1");
    expect(db.firmwareGroupMember.findUnique).toHaveBeenLastCalledWith({ where: { runId: "r1" }, select: { groupId: true } });
    expect(db.firmwareGroupSchedule.findUnique).toHaveBeenCalled();
  });

  it("a call during a pass returns at once and queues exactly one more pass", async () => {
    installGroupWorld({ status: "pending" }, []);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const real = db.firmwareGroupSchedule.findUnique.getMockImplementation();
    db.firmwareGroupSchedule.findUnique.mockImplementationOnce(async (...a: unknown[]) => { await gate; return real(...a); });
    const first = advanceGroup("g1", NOW);
    await advanceGroup("g1", NOW);
    await advanceGroup("g1", NOW);
    expect(db.firmwareGroupSchedule.findUnique).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(db.firmwareGroupSchedule.findUnique).toHaveBeenCalledTimes(2);
  });
});

// ─── The tick ────────────────────────────────────────────────────────────────

describe("runDueGroupSchedules", () => {
  beforeEach(() => { asset("G", "firewall", { hostname: "gate-a" }); asset("S1", "switch"); });

  it("starts a group inside the grace window and advances it the same tick", async () => {
    installGroupWorld({ status: "pending", scheduledFor: new Date(NOW.getTime() - 14 * 60_000) }, [member("S1")]);
    db.firmwareGroupSchedule.findMany.mockImplementation(async ({ where }: any) =>
      where.status === "pending" ? [{ id: "g1", scheduledFor: world.group!.scheduledFor, gateAssetId: "G" }] : [{ id: "g1" }]);
    h.start.mockResolvedValue({ id: "r1" });
    const out = await runDueGroupSchedules(NOW);
    expect(out).toEqual({ started: 1, missed: 0, advanced: 1 });
    expect(world.group).toMatchObject({ status: "running", firedAt: NOW });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "firmware.group_upgrade_started", resourceName: "gate-a" });
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it("more than the grace late: missed, members skipped, a warning Event and the 'missed' summary — nothing flashed", async () => {
    installGroupWorld({ status: "pending", scheduledFor: new Date(NOW.getTime() - 16 * 60_000) }, [member("S1")]);
    db.firmwareGroupSchedule.findMany.mockImplementation(async ({ where }: any) =>
      where.status === "pending" ? [{ id: "g1", scheduledFor: world.group!.scheduledFor, gateAssetId: "G" }] : []);
    const out = await runDueGroupSchedules(NOW);
    expect(out).toEqual({ started: 0, missed: 1, advanced: 0 });
    expect(world.group).toMatchObject({ status: "missed", firedAt: NOW, finishedAt: NOW });
    expect(world.group!.error).toMatch(/first saw this group 16 min late; nothing was started/);
    expect(world.members[0]).toMatchObject({ state: "skipped", skipKind: "cancelled", detail: "the group was missed" });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "firmware.group_upgrade_missed", level: "warning" });
    expect(h.render).toHaveBeenCalledWith(expect.objectContaining({ outcome: "missed" }));
    expect(h.start).not.toHaveBeenCalled();
  });

  it("a group another process claimed first is neither started nor missed", async () => {
    installGroupWorld({ status: "running", scheduledFor: NOW }, []);
    db.firmwareGroupSchedule.findMany.mockImplementation(async ({ where }: any) =>
      where.status === "pending" ? [{ id: "g1", scheduledFor: new Date(NOW.getTime() - 60_000), gateAssetId: "G" }, { id: "g1", scheduledFor: new Date(NOW.getTime() - 60 * 60_000), gateAssetId: "G" }] : []);
    const out = await runDueGroupSchedules(NOW);
    expect(out).toEqual({ started: 0, missed: 0, advanced: 0 });
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("advances running groups and stopped ones still owing an email; a failing pass is retried next tick, not thrown", async () => {
    db.firmwareGroupSchedule.findMany.mockImplementation(async ({ where }: any) => (where.status === "pending" ? [] : [{ id: "bad" }, { id: "ok" }]));
    db.firmwareGroupSchedule.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.id === "bad") throw new Error("db hiccup");
      return null;
    });
    const out = await runDueGroupSchedules(NOW);
    expect(out).toEqual({ started: 0, missed: 0, advanced: 1 });
    const activeWhere = db.firmwareGroupSchedule.findMany.mock.calls[1][0].where;
    expect(activeWhere).toEqual({ OR: [{ status: "running" }, { status: "cancelled", firedAt: { not: null }, notifiedAt: null }] });
  });
});

// ─── The summary email ───────────────────────────────────────────────────────

describe("the summary email", () => {
  beforeEach(() => { asset("G", "firewall", { hostname: "gate-a" }); asset("S1", "switch", { model: "FS-148F" }); });

  function finishedGroup(extra: Row = {}) {
    world.runs.set("r1", { status: "failed", result: null, error: "timed out", stage: "rebooting", verifiedVersion: null, progress: null });
    installGroupWorld({ status: "running", firedAt: NOW, notifyEmails: ["a@example.com", "b@example.com"], ...extra }, [member("S1", { state: "running", runId: "r1" })]);
  }

  it("goes to each recipient in their own zone (email matched case-insensitively), else the server's", async () => {
    finishedGroup();
    world.users = [{ email: "A@Example.com", timezone: "America/Chicago", detectedTimezone: null }];
    await advanceGroup("g1", NOW);
    expect(db.user.findMany.mock.calls[0][0].where).toEqual({ email: { in: ["a@example.com", "b@example.com"], mode: "insensitive" } });
    expect(h.render.mock.calls.map((c) => c[0].zone)).toEqual(["America/Chicago", "Server/Zone"]);
    expect(h.send.mock.calls.map((c) => c[1].to)).toEqual([["a@example.com"], ["b@example.com"]]);
    expect(h.send.mock.calls[0][0]).toEqual({ type: "smtp", config: { host: "mail" } });
    // The failed member carries its run's stage and error into the email.
    expect(h.render.mock.calls[0][0].members[0]).toMatchObject({ deviceName: "S1", model: "FS-148F", state: "failed", detail: "timed out", stage: "rebooting" });
    expect(world.group!.notifiedAt).toBeInstanceOf(Date);
  });

  it("no email channel: records notifyError and a warning Event", async () => {
    finishedGroup();
    h.channel.mockResolvedValue(null);
    await advanceGroup("g1", NOW);
    expect(h.send).not.toHaveBeenCalled();
    expect(world.group!.notifyError).toMatch(/no enabled email channel/);
    expect(eventLog.logEvent.mock.calls.find((c) => c[0].action === "firmware.group_upgrade_email_failed")![0].level).toBe("warning");
  });

  it("one recipient failing does not stop the others; the failure is recorded by address", async () => {
    finishedGroup();
    h.send.mockRejectedValueOnce(new Error("550 mailbox unavailable"));
    await advanceGroup("g1", NOW);
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(world.group!.notifyError).toBe("a@example.com: 550 mailbox unavailable");
  });

  it("an already-claimed summary is not sent again", async () => {
    finishedGroup({ notifiedAt: NOW });
    await advanceGroup("g1", NOW);
    expect(h.send).not.toHaveBeenCalled();
  });
});

// ─── Reads ───────────────────────────────────────────────────────────────────

describe("reads", () => {
  it("getGroupSchedule: 404, and dropped members sort last, the rest deepest first then name", async () => {
    db.firmwareGroupSchedule.findUnique.mockResolvedValueOnce(null);
    await expect(getGroupSchedule("x")).rejects.toMatchObject({ httpStatus: 404 });
    asset("G", "firewall", { hostname: "gate-a" });
    asset("Sb", "switch");
    asset("Sa", "switch");
    asset("A1", "access_point", { hostname: null, ipAddress: "192.0.2.77" });
    installGroupWorld({ status: "running" }, [
      member("A1", { depth: 3, state: "dropped" }), member("G", { depth: 1 }), member("Sb", { depth: 2 }), member("Sa", { depth: 2 }),
    ]);
    const g = await getGroupSchedule("g1");
    expect(g.members.map((m) => m.name)).toEqual(["Sa", "Sb", "gate-a", "192.0.2.77"]);
    expect(g.gateName).toBe("gate-a");
  });

  it("listGroupSchedules clamps the limit to 1–200, filters, and counts non-dropped members", async () => {
    db.firmwareGroupSchedule.findMany.mockResolvedValue([{ id: "g1", gateAssetId: "G", scheduledFor: NOW, status: "pending", concurrency: 1, createdBy: "a", gate: { id: "G", hostname: null, ipAddress: "192.0.2.1" }, _count: { members: 4 } }]);
    const rows = await listGroupSchedules({ gateAssetId: "G", status: "pending", limit: 1000 });
    expect(rows).toEqual([{ id: "g1", gateAssetId: "G", gateName: "192.0.2.1", scheduledFor: NOW, status: "pending", concurrency: 1, createdBy: "a", memberCount: 4 }]);
    const arg = db.firmwareGroupSchedule.findMany.mock.calls[0][0];
    expect(arg.take).toBe(200);
    expect(arg.where).toEqual({ gateAssetId: "G", status: "pending" });
    expect(arg.select._count).toEqual({ select: { members: { where: { state: { not: "dropped" } } } } });
    await listGroupSchedules({ limit: 0 });
    expect(db.firmwareGroupSchedule.findMany.mock.calls[1][0]).toMatchObject({ take: 1, where: {} });
    await listGroupSchedules();
    expect(db.firmwareGroupSchedule.findMany.mock.calls[2][0].take).toBe(50);
  });

  it("activeGroupForAsset: null outside a group; the gate and member state inside one", async () => {
    db.firmwareGroupMember.findFirst.mockResolvedValueOnce(null);
    expect(await activeGroupForAsset("S1")).toBeNull();
    db.firmwareGroupMember.findFirst.mockResolvedValueOnce({ state: "waiting", group: { id: "g1", gateAssetId: "G", scheduledFor: NOW, status: "running", gate: { id: "G", hostname: "gate-a", ipAddress: null } } });
    expect(await activeGroupForAsset("S1")).toEqual({ id: "g1", gateAssetId: "G", gateName: "gate-a", scheduledFor: NOW, status: "running", memberState: "waiting" });
    expect(db.firmwareGroupMember.findFirst.mock.calls[0][0].where).toEqual({ assetId: "S1", state: { not: "dropped" }, group: { status: { in: ["pending", "running"] } } });
  });
});
