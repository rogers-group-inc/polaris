/**
 * tests/unit/alertGroupService.test.ts — the own suite for
 * src/services/alertGroupService.ts (business rule 75, CQ-T010).
 *
 * Complements the integration suites (alertGroupDelivery, alertGroupSubnetFold,
 * alertGroupAutomationFold — the engine folding real alerts) with the
 * registry's own contract against the shared DB stub:
 *   - which automations may join, for the fold mode the editor is SHOWING, and
 *     the reason each refusal gives;
 *   - the 400s (a vanished member, an ineligible trigger, a member of another
 *     group) and the 404;
 *   - membership replacement retiring the live alerts of every automation that
 *     joined OR left, and releasing their state rows;
 *   - the reshape retirements — disable, rescope (key-order-blind, CQ-B054),
 *     refold — and that an unrelated save retires nothing;
 *   - seeding a group with no delivery from its FIRST member that has actions,
 *     only into fields the group has not set (rule 75 + 114(a));
 *   - deliveryAfterChange (re-scan F56) and the removal-impact read;
 *   - the alert_group.created / updated / deleted / seeded Events.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  assertActionRefs: vi.fn(),
  applyResetSnapshots: vi.fn(),
  restoreMasked: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/notificationRuleService.js", () => ({
  assertActionRefs: h.assertActionRefs,
  applyResetSnapshots: h.applyResetSnapshots,
}));
vi.mock("../../src/utils/actionHeaderMask.js", () => ({ restoreMaskedActionHeaders: h.restoreMasked }));

import { prisma } from "../../src/db.js";
import { Prisma } from "../../src/generated/prisma/client.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { AppError } from "../../src/utils/errors.js";
import {
  listGroups,
  getGroup,
  listJoinableRules,
  createGroup,
  updateGroup,
  deleteGroup,
  groupRemovalImpact,
  deliveryAfterChange,
} from "../../src/services/alertGroupService.js";

// ─── An in-memory rule table behind every notificationRule read ────────────

type Rule = {
  id: string; name: string; enabled: boolean; severity: string; trigger: unknown;
  alertGroupId: string | null; alertGroup: { name: string } | null;
  actions?: unknown; escalation?: unknown; resetActions?: unknown; emailComposition?: unknown;
};

let rules: Rule[] = [];
let groupRow: Record<string, unknown> | null = null;
let seedRow: Record<string, unknown> | null = null;
let liveAlerts: { id: string }[] = [];

const PORT_DOWN = { type: "asset_state", field: "ifOperStatus", operator: "==", value: "down" };
const DEVICE_DOWN = { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" };
const HOST_CPU = { type: "host_metric", metric: "cpuPct", operator: ">", threshold: 90 };
const AGENT_EVENT = { type: "event", actionPattern: "agent.disconnected" };
const SWITCH_COMPOSITE = { type: "composite", kind: "asset", condition: { op: "and", children: [] } };
const HOST_COMPOSITE = { type: "composite", kind: "host", condition: { op: "and", children: [] } };

const notify = (channelId = "ch-1") => ({ type: "notify", channelId, addresses: ["noc@x.co"] });

function rule(id: string, over: Partial<Rule> = {}): Rule {
  return { id, name: `Rule ${id}`, enabled: true, severity: "warning", trigger: PORT_DOWN, alertGroupId: null, alertGroup: null, actions: [], ...over };
}

function group(over: Record<string, unknown> = {}) {
  return {
    id: "g1", name: "Switch health", description: null, enabled: true, scope: null, foldBy: "device",
    messageTemplate: null, requireAckNote: false, emailComposition: null, actions: null, resetActions: null,
    escalation: null, repeat: null, createdBy: "ada", createdAt: new Date(), updatedAt: new Date(),
    rules: [] as { id: string; name: string; enabled: boolean; severity: string; trigger: unknown }[],
    ...over,
  };
}

const ruleFind = stubbed(prisma.notificationRule.findMany);
const groupFindUnique = stubbed(prisma.alertGroup.findUnique);
const groupCreate = stubbed(prisma.alertGroup.create);
const groupUpdate = stubbed(prisma.alertGroup.update);
const ruleUpdateMany = stubbed(prisma.notificationRule.updateMany);
const notifUpdateMany = stubbed(prisma.notification.updateMany);
const notifFind = stubbed(prisma.notification.findMany);
const stateDelete = stubbed(prisma.notificationRuleState.deleteMany);
const stateUpdateMany = stubbed(prisma.notificationRuleState.updateMany);

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  h.assertActionRefs.mockReset().mockResolvedValue(undefined);
  h.applyResetSnapshots.mockReset();
  h.restoreMasked.mockReset();
  rules = [];
  groupRow = group();
  seedRow = null;
  liveAlerts = [];

  ruleFind.mockImplementation(async (args: any) => {
    const w = args?.where ?? {};
    if (w.id?.in) return rules.filter((r) => w.id.in.includes(r.id));
    if ("alertGroupId" in w) return rules.filter((r) => r.alertGroupId === w.alertGroupId);
    return [...rules];
  });
  // getGroup selects `rules`; the seed read and the foldBy read do not.
  groupFindUnique.mockImplementation(async (args: any) => {
    if (args.select?.rules) return groupRow;
    if (args.select?.foldBy && Object.keys(args.select).length === 1) return groupRow ? { foldBy: groupRow.foldBy } : null;
    return seedRow ?? groupRow;
  });
  groupCreate.mockImplementation(async ({ data }: any) => ({ id: "g1", name: data.name }));
  groupUpdate.mockImplementation(async ({ data }: any) => ({ id: "g1", name: data.name ?? "Switch health" }));
  notifFind.mockImplementation(async () => liveAlerts);
  notifUpdateMany.mockResolvedValue({ count: 0 });
  ruleUpdateMany.mockResolvedValue({ count: 0 });
  stateDelete.mockResolvedValue({ count: 0 });
  stateUpdateMany.mockResolvedValue({ count: 0 });
});

const events = (action: string) => eventLog.logEvent.mock.calls.map((c) => c[0]).filter((e) => e.action === action);
const retiredWith = () => notifUpdateMany.mock.calls.map((c) => c[0].data.clearedBy);

async function rejects(p: Promise<unknown>, status: number, msg?: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).httpStatus).toBe(status);
  if (msg) expect((err as Error).message).toMatch(msg);
}

// ─── Reads ─────────────────────────────────────────────────────────────────

describe("listGroups / getGroup", () => {
  it("lists by name with each group's members", async () => {
    stubbed(prisma.alertGroup.findMany).mockResolvedValue([group()]);
    await listGroups();
    const args = stubbed(prisma.alertGroup.findMany).mock.calls[0]![0];
    expect(args.orderBy).toEqual({ name: "asc" });
    expect(args.select.rules.orderBy).toEqual({ name: "asc" });
  });

  it("returns the group", async () => {
    await expect(getGroup("g1")).resolves.toMatchObject({ id: "g1", name: "Switch health" });
  });

  it("404s a missing group", async () => {
    groupRow = null;
    await rejects(getGroup("nope"), 404, /not found/);
  });
});

describe("listJoinableRules", () => {
  it("marks per-port automations selectable and explains every refusal on a device group", async () => {
    rules = [
      rule("r1", { name: "Port down", trigger: PORT_DOWN }),
      rule("r2", { name: "Host CPU", trigger: HOST_CPU }),
      rule("r3", { name: "Agent gone", trigger: AGENT_EVENT }),
      rule("r4", { name: "Device down", trigger: DEVICE_DOWN }),
      rule("r5", { name: "Switch health", trigger: SWITCH_COMPOSITE }),
      rule("r6", { name: "Server health", trigger: HOST_COMPOSITE }),
    ];
    const out = await listJoinableRules();
    const by = Object.fromEntries(out.map((r) => [r.id, r]));
    expect(by.r1).toMatchObject({ selectable: true, reason: null, triggerType: "asset_state", member: false });
    expect(by.r2!.reason).toMatch(/Polaris server itself/);
    expect(by.r3!.reason).toMatch(/instant/);
    expect(by.r4!.reason).toMatch(/per automation, per device \+ automation or per subnet/);
    expect(by.r5).toMatchObject({ selectable: true, triggerType: "composite" });
    expect(by.r6!.selectable).toBe(false);
    expect(by.r6!.reason).toBe("Reports once per device already, so there is nothing for a group to fold.");
  });

  it("lets a whole-device trigger join a subnet fold, which a device fold refuses", async () => {
    rules = [rule("r4", { trigger: DEVICE_DOWN })];
    expect((await listJoinableRules(undefined, "subnet"))[0]!.selectable).toBe(true);
    expect((await listJoinableRules(undefined, "device"))[0]!.selectable).toBe(false);
  });

  it("uses the stored fold mode when the picker does not say which it is showing", async () => {
    groupRow = group({ foldBy: "automation" });
    rules = [rule("r4", { trigger: DEVICE_DOWN })];
    expect((await listJoinableRules("g1"))[0]!.selectable).toBe(true);
  });

  it("prefers the mode the picker is showing over the stored one, without reading the group", async () => {
    groupRow = group({ foldBy: "subnet" });
    rules = [rule("r4", { trigger: DEVICE_DOWN })];
    expect((await listJoinableRules("g1", "device"))[0]!.selectable).toBe(false);
    expect(groupFindUnique).not.toHaveBeenCalled();
  });

  it("falls back to device when the group asked about no longer exists", async () => {
    groupRow = null;
    rules = [rule("r4", { trigger: DEVICE_DOWN })];
    expect((await listJoinableRules("gone"))[0]!.selectable).toBe(false);
  });

  it("names the other group a taken automation already delivers through", async () => {
    rules = [rule("r1", { alertGroupId: "g2", alertGroup: { name: "Core" } }), rule("r2", { alertGroupId: "g2", alertGroup: null })];
    const out = await listJoinableRules("g1");
    expect(out[0]).toMatchObject({ selectable: false, member: false });
    expect(out[0]!.reason).toMatch(/Already delivers through "Core"/);
    expect(out[1]!.reason).toMatch(/"another group"/);
  });

  it("marks this group's own members as members and still selectable", async () => {
    rules = [rule("r1", { alertGroupId: "g1", alertGroup: { name: "Switch health" } })];
    expect((await listJoinableRules("g1"))[0]).toMatchObject({ member: true, selectable: true, reason: null });
  });

  it("never marks a member with no group asked about", async () => {
    rules = [rule("r1")];
    expect((await listJoinableRules())[0]!.member).toBe(false);
  });

  it("reads a rule with no trigger as ineligible with a null type", async () => {
    rules = [rule("r1", { trigger: null })];
    expect((await listJoinableRules())[0]).toMatchObject({ selectable: false, triggerType: null });
  });
});

// ─── Create ────────────────────────────────────────────────────────────────

describe("createGroup", () => {
  it("creates with defaults: enabled, device fold, no ack note, the actor as creator", async () => {
    await createGroup({ name: "G" }, "ada");
    const data = groupCreate.mock.calls[0]![0].data;
    expect(data).toMatchObject({ name: "G", description: null, enabled: true, foldBy: "device", messageTemplate: null, requireAckNote: false, createdBy: "ada" });
    expect(data.scope).toBeUndefined();
    expect(data.actions).toBeUndefined();
  });

  it("only disables on an explicit false and only requires an ack note on an explicit true", async () => {
    await createGroup({ name: "G", enabled: false, requireAckNote: true });
    expect(groupCreate.mock.calls[0]![0].data).toMatchObject({ enabled: false, requireAckNote: true, createdBy: null });
  });

  it("runs the same save-time action checks an automation gets (rule 114(a)), headers restored against nothing", async () => {
    const input = { name: "G", actions: [notify()] };
    await createGroup(input);
    expect(h.restoreMasked).toHaveBeenCalledWith(input, null);
    expect(h.applyResetSnapshots).toHaveBeenCalledWith(input);
    expect(h.assertActionRefs).toHaveBeenCalledWith(input);
  });

  it("creates nothing when the action checks refuse", async () => {
    h.assertActionRefs.mockRejectedValue(new AppError(400, "bad channel"));
    await rejects(createGroup({ name: "G", actions: [notify()] }), 400, /bad channel/);
    expect(groupCreate).not.toHaveBeenCalled();
  });

  it("refuses a member that no longer exists", async () => {
    rules = [rule("r1")];
    await rejects(createGroup({ name: "G", ruleIds: ["r1", "gone"] }), 400, /no longer exist/);
    expect(groupCreate).not.toHaveBeenCalled();
  });

  it("refuses an ineligible member by name and reason", async () => {
    rules = [rule("r1", { name: "Agent gone", trigger: AGENT_EVENT })];
    await rejects(createGroup({ name: "G", ruleIds: ["r1"] }), 400, /^"Agent gone" cannot join a group — Fires on an instant/);
  });

  it("checks eligibility against the fold being created", async () => {
    rules = [rule("r4", { trigger: DEVICE_DOWN })];
    await rejects(createGroup({ name: "G", ruleIds: ["r4"] }), 400, /cannot join/);
    await expect(createGroup({ name: "G", foldBy: "subnet", ruleIds: ["r4"] })).resolves.toBeDefined();
  });

  it("refuses a member of another group — at most one group per automation", async () => {
    rules = [rule("r1", { name: "Port down", alertGroupId: "g2", alertGroup: { name: "Core" } })];
    await rejects(createGroup({ name: "G", ruleIds: ["r1"] }), 400, /"Port down" already delivers through "Core"/);
  });

  it("joins the members and retires their live alerts, releasing their state rows", async () => {
    rules = [rule("r1"), rule("r2")];
    await createGroup({ name: "G", actions: [notify()], ruleIds: ["r1", "r2"] });
    expect(ruleUpdateMany).toHaveBeenCalledWith({ where: { id: { in: ["r1", "r2"] } }, data: { alertGroupId: "g1" } });
    const retire = notifUpdateMany.mock.calls[0]![0];
    expect(retire.where).toEqual({ ruleId: { in: ["r1", "r2"] }, cleared: false });
    expect(retire.data).toMatchObject({ cleared: true, clearedBy: "system:rule-regrouped" });
    expect(retire.data.clearedAt).toBeInstanceOf(Date);
    expect(stateDelete).toHaveBeenCalledWith({ where: { ruleId: { in: ["r1", "r2"] } } });
  });

  it("touches no membership with no members", async () => {
    await createGroup({ name: "G", actions: [notify()] });
    expect(ruleUpdateMany).not.toHaveBeenCalled();
    expect(notifUpdateMany).not.toHaveBeenCalled();
  });

  it("writes alert_group.created naming the members, then returns the stored group", async () => {
    rules = [rule("r1")];
    const out = await createGroup({ name: "G", actions: [notify()], ruleIds: ["r1"] }, "ada");
    expect(events("alert_group.created")).toEqual([
      expect.objectContaining({ resourceType: "alert-group", resourceId: "g1", resourceName: "G", actor: "ada", details: { ruleIds: ["r1"] } }),
    ]);
    expect(out).toMatchObject({ id: "g1" });
  });
});

describe("createGroup — seeding delivery from members", () => {
  it("takes the actions, escalation, email layout and reset actions of the FIRST posted member with actions", async () => {
    const esc = { stopOn: "acknowledge", tiers: [{ afterMin: 15, actions: [notify("ch-esc")] }] };
    rules = [
      rule("r1", { actions: [] }),
      rule("r2", { name: "Port down", actions: [notify("ch-2")], escalation: esc, emailComposition: { subjectTemplate: "S" }, resetActions: [notify("ch-r")] }),
      rule("r3", { actions: [notify("ch-3")] }),
    ];
    seedRow = { name: "G", actions: null, escalation: null, emailComposition: null, resetActions: null };
    await createGroup({ name: "G", ruleIds: ["r1", "r2", "r3"] }, "ada");
    const data = groupUpdate.mock.calls[0]![0].data;
    expect(data.actions).toEqual([expect.objectContaining({ channelId: "ch-2" })]);
    expect(data.escalation.tiers[0].actions[0].channelId).toBe("ch-esc");
    expect(data.emailComposition).toEqual({ subjectTemplate: "S" });
    expect(data.resetActions).toEqual([expect.objectContaining({ channelId: "ch-r" })]);
    expect(events("alert_group.seeded")).toEqual([
      expect.objectContaining({
        resourceId: "g1", actor: "ada",
        message: 'Alert group "G" took its recipients from "Port down"',
        details: { fromRuleId: "r2", actions: 1, escalation: true },
      }),
    ]);
  });

  it("follows the POSTED order, not the table's", async () => {
    rules = [rule("r1", { actions: [notify("ch-1")] }), rule("r2", { actions: [notify("ch-2")] })];
    seedRow = { name: "G", actions: null, escalation: null, emailComposition: null, resetActions: null };
    await createGroup({ name: "G", ruleIds: ["r2", "r1"] });
    expect(groupUpdate.mock.calls[0]![0].data.actions[0].channelId).toBe("ch-2");
  });

  it("never overwrites a field the group already set", async () => {
    rules = [rule("r1", { actions: [notify()], escalation: { tiers: [{ afterMin: 5, actions: [notify()] }] }, emailComposition: { subjectTemplate: "member" } })];
    seedRow = { name: "G", actions: [], escalation: { tiers: [] }, emailComposition: { subjectTemplate: "mine" }, resetActions: null };
    await createGroup({ name: "G", ruleIds: ["r1"] });
    const data = groupUpdate.mock.calls[0]![0].data;
    expect(data).toHaveProperty("actions");
    expect(data).not.toHaveProperty("escalation");
    expect(data).not.toHaveProperty("emailComposition");
    expect(data).not.toHaveProperty("resetActions");
  });

  it("does nothing when no member has any actions", async () => {
    rules = [rule("r1", { actions: [] })];
    seedRow = { name: "G", actions: null, escalation: null, emailComposition: null, resetActions: null };
    await createGroup({ name: "G", ruleIds: ["r1"] });
    expect(groupUpdate).not.toHaveBeenCalled();
    expect(events("alert_group.seeded")).toEqual([]);
  });

  it("does not seed when the request carried actions, even an empty list", async () => {
    rules = [rule("r1", { actions: [notify()] })];
    await createGroup({ name: "G", actions: [], ruleIds: ["r1"] });
    expect(groupUpdate).not.toHaveBeenCalled();
  });

  it("does not seed a group that already has actions of its own", async () => {
    rules = [rule("r1", { actions: [notify()] })];
    seedRow = { name: "G", actions: [notify("own")], escalation: null, emailComposition: null, resetActions: null };
    await createGroup({ name: "G", ruleIds: ["r1"] });
    expect(groupUpdate).not.toHaveBeenCalled();
  });
});

// ─── Update ────────────────────────────────────────────────────────────────

describe("updateGroup", () => {
  it("404s a missing group before touching anything", async () => {
    groupRow = null;
    await rejects(updateGroup("g1", { name: "G" }), 404);
    expect(groupUpdate).not.toHaveBeenCalled();
  });

  it("keeps the stored fold when the request omits it", async () => {
    groupRow = group({ foldBy: "subnet" });
    await updateGroup("g1", { name: "G", actions: [notify()] });
    expect(groupUpdate.mock.calls[0]![0].data.foldBy).toBe("subnet");
  });

  it("checks the CURRENT members against a new fold when only the mode changes", async () => {
    groupRow = group({ foldBy: "subnet", rules: [{ id: "r4", name: "Device down", enabled: true, severity: "warning", trigger: DEVICE_DOWN }] });
    rules = [rule("r4", { name: "Device down", trigger: DEVICE_DOWN, alertGroupId: "g1", alertGroup: { name: "Switch health" } })];
    await rejects(updateGroup("g1", { name: "G", foldBy: "device" }), 400, /"Device down" cannot join/);
  });

  it("lets the group's own members stay without tripping the one-group check", async () => {
    groupRow = group({ rules: [{ id: "r1", name: "Port down", enabled: true, severity: "warning", trigger: PORT_DOWN }] });
    rules = [rule("r1", { alertGroupId: "g1", alertGroup: { name: "Switch health" } })];
    await expect(updateGroup("g1", { name: "G", actions: [notify()], ruleIds: ["r1"] })).resolves.toBeDefined();
    expect(ruleUpdateMany).not.toHaveBeenCalled();
  });

  it("restores masked headers against the stored group", async () => {
    const input = { name: "G" };
    await updateGroup("g1", input);
    expect(h.restoreMasked).toHaveBeenCalledWith(input, groupRow);
  });

  it("leaves an omitted JSON field alone, clears a null one, and writes a sent one", async () => {
    await updateGroup("g1", { name: "G", actions: null, escalation: { tiers: [] }, scope: null });
    const data = groupUpdate.mock.calls[0]![0].data;
    expect(data.actions).toBe(Prisma.DbNull);
    expect(data.escalation).toEqual({ tiers: [] });
    expect(data.scope).toBe(Prisma.DbNull);
    expect(data.repeat).toBeUndefined();
    expect(data.resetActions).toBeUndefined();
    expect(data.emailComposition).toBeUndefined();
  });

  it("swaps the membership: leavers and joiners both have their live alerts retired", async () => {
    rules = [rule("r1", { alertGroupId: "g1", alertGroup: { name: "Switch health" } }), rule("r2")];
    await updateGroup("g1", { name: "G", actions: [notify()], ruleIds: ["r2"] });
    expect(ruleUpdateMany).toHaveBeenCalledWith({ where: { id: { in: ["r1"] } }, data: { alertGroupId: null } });
    expect(ruleUpdateMany).toHaveBeenCalledWith({ where: { id: { in: ["r2"] } }, data: { alertGroupId: "g1" } });
    expect(notifUpdateMany.mock.calls[0]![0].where).toEqual({ ruleId: { in: ["r2", "r1"] }, cleared: false });
    expect(stateDelete).toHaveBeenCalledWith({ where: { ruleId: { in: ["r2", "r1"] } } });
  });

  it("leaves membership alone when the request omits ruleIds", async () => {
    await updateGroup("g1", { name: "G" });
    expect(ruleUpdateMany).not.toHaveBeenCalled();
  });

  it("seeds delivery only when the members were posted and the actions were not", async () => {
    rules = [rule("r1", { actions: [notify()] })];
    seedRow = { name: "G", actions: null, escalation: null, emailComposition: null, resetActions: null };
    await updateGroup("g1", { name: "G", ruleIds: ["r1"] });
    expect(events("alert_group.seeded")).toHaveLength(1);
    resetEventLogStub();
    await updateGroup("g1", { name: "G" });
    expect(events("alert_group.seeded")).toHaveLength(0);
  });

  it("retires the group's live alerts when it is DISABLED, releasing their state", async () => {
    liveAlerts = [{ id: "n1" }, { id: "n2" }];
    await updateGroup("g1", { name: "G", enabled: false });
    const retire = notifUpdateMany.mock.calls.find((c) => c[0].data.clearedBy === "system:group-disabled")![0];
    expect(retire.where).toEqual({ id: { in: ["n1", "n2"] } });
    expect(stateUpdateMany).toHaveBeenCalledWith({
      where: { notificationId: { in: ["n1", "n2"] } },
      data: { state: "clear", conditionMetSince: null, recoveredSince: null, notificationId: null, bandMetSince: Prisma.DbNull },
    });
    expect(notifFind.mock.calls[0]![0].where).toEqual({ alertGroupId: "g1", cleared: false });
  });

  it("does not retire on a save of a group that was already disabled", async () => {
    groupRow = group({ enabled: false });
    liveAlerts = [{ id: "n1" }];
    await updateGroup("g1", { name: "G", enabled: false });
    expect(retiredWith()).toEqual([]);
  });

  it("writes nothing when the group has no live alerts to retire", async () => {
    liveAlerts = [];
    await updateGroup("g1", { name: "G", enabled: false });
    expect(notifUpdateMany).not.toHaveBeenCalled();
    expect(stateUpdateMany).not.toHaveBeenCalled();
  });

  it("retires on a SCOPE change", async () => {
    liveAlerts = [{ id: "n1" }];
    await updateGroup("g1", { name: "G", scope: { tags: ["core"] } });
    expect(retiredWith()).toEqual(["system:group-rescoped"]);
  });

  it("does not retire when the posted scope equals the stored one in another key order (CQ-B054)", async () => {
    groupRow = group({ scope: { condition: { op: "and", children: [] }, allAssets: false } });
    liveAlerts = [{ id: "n1" }];
    await updateGroup("g1", { name: "G", scope: { allAssets: false, condition: { children: [], op: "and" } } });
    expect(retiredWith()).toEqual([]);
  });

  it("retires on a FOLD change with the scope unchanged", async () => {
    rules = [];
    liveAlerts = [{ id: "n1" }];
    await updateGroup("g1", { name: "G", foldBy: "subnet" });
    expect(retiredWith()).toEqual(["system:group-refolded"]);
  });

  it("retires once, as a rescope, when scope and fold change together", async () => {
    liveAlerts = [{ id: "n1" }];
    await updateGroup("g1", { name: "G", foldBy: "subnet", scope: { tags: ["x"] } });
    expect(retiredWith()).toEqual(["system:group-rescoped"]);
  });

  it("retires nothing on an unrelated save", async () => {
    liveAlerts = [{ id: "n1" }];
    await updateGroup("g1", { name: "Renamed", messageTemplate: "x" });
    expect(retiredWith()).toEqual([]);
  });

  // BUG: an omitted `scope` is left untouched in the database (jsonOrClear →
  // undefined), and the route treats it as "unchanged" (alertGroups.ts only
  // re-checks the script grant when `input.scope !== undefined`) — but the
  // retire check compares the STORED scope against `input.scope ?? null`. So a
  // PUT that renames a scoped group without re-sending its scope (any API
  // client; the scope is optional in groupInputSchema) retires every live alert
  // as "system:group-rescoped" though the scope did not change.
  it.fails("does not retire when the request omits a stored scope", async () => {
    groupRow = group({ scope: { tags: ["core"] } });
    liveAlerts = [{ id: "n1" }];
    await updateGroup("g1", { name: "Renamed" });
    expect(groupUpdate.mock.calls[0]![0].data.scope).toBeUndefined();
    expect(retiredWith()).toEqual([]);
  });

  it("writes alert_group.updated with the enabled flag, fold and posted members", async () => {
    await updateGroup("g1", { name: "G", enabled: false, foldBy: "device", ruleIds: [] }, "ada");
    expect(events("alert_group.updated")).toEqual([
      expect.objectContaining({ resourceId: "g1", actor: "ada", details: { enabled: false, foldBy: "device", ruleIds: [] } }),
    ]);
  });

  it("logs ruleIds null when the members were not posted", async () => {
    await updateGroup("g1", { name: "G" });
    expect(events("alert_group.updated")[0]!.details).toMatchObject({ enabled: true, ruleIds: null });
  });
});

// ─── Delete + removal impact ───────────────────────────────────────────────

describe("deleteGroup", () => {
  it("404s a missing group", async () => {
    groupRow = null;
    await rejects(deleteGroup("g1"), 404);
    expect(stubbed(prisma.alertGroup.delete)).not.toHaveBeenCalled();
  });

  it("retires live alerts FIRST, hands the members back, then deletes", async () => {
    const order: string[] = [];
    liveAlerts = [{ id: "n1" }];
    notifUpdateMany.mockImplementation(async () => { order.push("retire"); return { count: 1 }; });
    ruleUpdateMany.mockImplementation(async () => { order.push("detach"); return { count: 2 }; });
    stubbed(prisma.alertGroup.delete).mockImplementation(async () => { order.push("delete"); return {}; });
    await deleteGroup("g1");
    expect(order).toEqual(["retire", "detach", "delete"]);
    expect(retiredWith()).toEqual(["system:group-deleted"]);
    expect(ruleUpdateMany).toHaveBeenCalledWith({ where: { alertGroupId: "g1" }, data: { alertGroupId: null } });
    expect(stubbed(prisma.alertGroup.delete)).toHaveBeenCalledWith({ where: { id: "g1" } });
  });

  it("writes alert_group.deleted counting the automations returned to their own delivery", async () => {
    groupRow = group({ rules: [
      { id: "r1", name: "A", enabled: true, severity: "warning", trigger: PORT_DOWN },
      { id: "r2", name: "B", enabled: true, severity: "warning", trigger: PORT_DOWN },
    ] });
    await deleteGroup("g1", "ada");
    expect(events("alert_group.deleted")).toEqual([
      expect.objectContaining({
        resourceId: "g1", resourceName: "Switch health", actor: "ada",
        message: 'Alert group "Switch health" deleted — 2 automation(s) returned to delivering on their own',
        details: { ruleIds: ["r1", "r2"] },
      }),
    ]);
  });
});

describe("groupRemovalImpact", () => {
  it("counts live alerts and names the members that would go silent", async () => {
    groupRow = group({ rules: [
      { id: "r1", name: "Has notify", enabled: true, severity: "warning", trigger: PORT_DOWN },
      { id: "r2", name: "Script only", enabled: false, severity: "warning", trigger: PORT_DOWN },
      { id: "r3", name: "No actions", enabled: true, severity: "warning", trigger: PORT_DOWN },
      { id: "r4", name: "Null actions", enabled: true, severity: "warning", trigger: PORT_DOWN },
    ] });
    rules = [
      rule("r1", { actions: [{ type: "script", scriptId: "s", runOn: "server" }, notify()] }),
      rule("r2", { actions: [{ type: "script", scriptId: "s", runOn: "server" }] }),
      rule("r3", { actions: [] }),
      rule("r4", { actions: null }),
    ];
    stubbed(prisma.notification.count).mockResolvedValue(3);
    const out = await groupRemovalImpact("g1");
    expect(stubbed(prisma.notification.count)).toHaveBeenCalledWith({ where: { alertGroupId: "g1", cleared: false } });
    expect(out.liveAlerts).toBe(3);
    expect(out.rules).toEqual([
      { id: "r1", name: "Has notify", enabled: true },
      { id: "r2", name: "Script only", enabled: false },
      { id: "r3", name: "No actions", enabled: true },
      { id: "r4", name: "Null actions", enabled: true },
    ]);
    expect(out.rulesWithNoOwnDelivery.map((r) => r.id)).toEqual(["r2", "r3", "r4"]);
  });

  it("asks nothing about members when the group has none", async () => {
    stubbed(prisma.notification.count).mockResolvedValue(0);
    const out = await groupRemovalImpact("g1");
    expect(out.rulesWithNoOwnDelivery).toEqual([]);
    expect(ruleFind).not.toHaveBeenCalled();
  });

  it("404s a missing group", async () => {
    groupRow = null;
    await rejects(groupRemovalImpact("g1"), 404);
  });
});

// ─── deliveryAfterChange (rule 114(a), re-scan F56) ────────────────────────

describe("deliveryAfterChange", () => {
  it("returns the request's delivery for a new group, without reading any group", async () => {
    const out = await deliveryAfterChange(null, { actions: [notify()], escalation: null });
    expect(out).toEqual({ actions: [notify()], escalation: null, resetActions: null });
    expect(groupFindUnique).not.toHaveBeenCalled();
  });

  it("falls back to the stored delivery for each field the request omits", async () => {
    groupRow = group({ actions: [notify("stored")], escalation: { tiers: [] }, resetActions: [notify("r")] });
    const out = await deliveryAfterChange("g1", { escalation: null });
    expect(out.actions).toEqual([notify("stored")]);
    expect(out.escalation).toBeNull();
    expect(out.resetActions).toEqual([notify("r")]);
  });

  it("reports the member's delivery a seed would copy into an empty group", async () => {
    const esc = { stopOn: "acknowledge", tiers: [{ afterMin: 15, actions: [notify("ch-esc")] }] };
    rules = [rule("r1", { actions: [] }), rule("r2", { actions: [notify("ch-2")], escalation: esc, resetActions: [notify("ch-r")] })];
    const out = await deliveryAfterChange(null, { ruleIds: ["gone", "r1", "r2"] });
    expect((out.actions as { channelId: string }[])[0]!.channelId).toBe("ch-2");
    expect((out.escalation as { tiers: { actions: { channelId: string }[] }[] }).tiers[0]!.actions[0]!.channelId).toBe("ch-esc");
    expect((out.resetActions as { channelId: string }[])[0]!.channelId).toBe("ch-r");
  });

  it("keeps a stored escalation over the member's", async () => {
    groupRow = group({ actions: [], escalation: { mine: true } });
    rules = [rule("r1", { actions: [notify()], escalation: { stopOn: "acknowledge", tiers: [{ afterMin: 5, actions: [notify()] }] } })];
    const out = await deliveryAfterChange("g1", { ruleIds: ["r1"] });
    expect(out.escalation).toEqual({ mine: true });
  });

  it("does not seed when the group already has actions, or the request sent some", async () => {
    groupRow = group({ actions: [notify("own")] });
    rules = [rule("r1", { actions: [notify("member")] })];
    expect((await deliveryAfterChange("g1", { ruleIds: ["r1"] })).actions).toEqual([notify("own")]);
    expect((await deliveryAfterChange("g1", { ruleIds: ["r1"], actions: [] })).actions).toEqual([]);
  });

  it("does not seed without posted members", async () => {
    groupRow = group({ actions: null });
    const out = await deliveryAfterChange("g1", {});
    expect(out.actions).toBeNull();
    expect(ruleFind).not.toHaveBeenCalled();
  });
});
