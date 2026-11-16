/**
 * tests/unit/tagRenameCarryService.test.ts — own suite for
 * src/services/tagRenameCarryService.ts (CQ-T010, business rule 169).
 *
 * tagRenameCarry.test.ts pins the pure rewriters. This file drives the two
 * carry passes on the shared Prisma stub:
 *
 *  - carryTagRename: the guards (blank / identical names → no reads), the two
 *    tag-scope lists (User / GroupMapping `otherTags`, case-insensitive, no
 *    duplicates, untouched rows not written), every filter holder (only the
 *    columns that changed, only the rows that changed), the Application Map
 *    rules blob, and best-effort per holder;
 *  - carryRegionRename (169(a)): the `region:` tag and the bare name in
 *    `recipientRegions`, never the principals' scopes;
 *  - summarizeTagCarry's wording for every holder.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ getConfig: vi.fn(), saveConfig: vi.fn() }));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/appMapDiscoveryService.js", () => ({ getConfig: h.getConfig, saveConfig: h.saveConfig }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import {
  carryRegionRename,
  carryTagRename,
  rewriteTagRefs,
  summarizeTagCarry,
  type TagRenameCarry,
} from "../../src/services/tagRenameCarryService.js";

const HOLDERS = ["notificationRule", "alertGroup", "quietTimeSchedule", "pathCheck", "tag", "contact"] as const;
const ZERO: TagRenameCarry = {
  users: 0, groupMappings: 0, automations: 0, alertGroups: 0, quietTimes: 0, pathChecks: 0, tagFilters: 0, contacts: 0, appMapRules: 0,
};
const cond = (value: string, field = "tag") => ({ field, operator: "has", value });
const model = (name: string) => (prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>)[name]!;

beforeEach(() => {
  resetDbStub();
  for (const m of ["user", "groupMapping", ...HOLDERS]) {
    stubbed(model(m).findMany!).mockResolvedValue([]);
    stubbed(model(m).update!).mockResolvedValue({});
  }
  h.getConfig.mockReset().mockResolvedValue({ version: 2, rules: [] });
  h.saveConfig.mockReset().mockResolvedValue(undefined);
});

describe("carryTagRename — guards", () => {
  it.each([["", "b"], ["a", "  "], ["same", "same"]])("does nothing for %j -> %j", async (from, to) => {
    expect(await carryTagRename(from, to)).toEqual(ZERO);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.notificationRule.findMany).not.toHaveBeenCalled();
    expect(h.getConfig).not.toHaveBeenCalled();
  });

  it("carries a case-only rename (the stored spelling follows)", async () => {
    stubbed(prisma.user.findMany).mockResolvedValue([{ id: "u1", otherTags: ["critical"] }]);
    const c = await carryTagRename("critical", "Critical");
    expect(c.users).toBe(1);
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { otherTags: ["Critical"] } });
  });
});

describe("carryTagRename — tag scopes", () => {
  it("reads only principals with a tag scope", async () => {
    await carryTagRename("old", "new");
    expect(stubbed(prisma.user.findMany).mock.calls[0]![0]).toEqual({ where: { otherTags: { isEmpty: false } }, select: { id: true, otherTags: true } });
    expect(stubbed(prisma.groupMapping.findMany).mock.calls[0]![0]).toEqual({ where: { otherTags: { isEmpty: false } }, select: { id: true, otherTags: true } });
  });

  it("renames case-insensitively, keeps order, drops a duplicate, and leaves untouched rows unwritten", async () => {
    stubbed(prisma.user.findMany).mockResolvedValue([
      { id: "u1", otherTags: ["Plant", " OLD ", "x"] },
      { id: "u2", otherTags: ["old", "NEW"] },
      { id: "u3", otherTags: ["older", "x"] },
    ]);
    stubbed(prisma.groupMapping.findMany).mockResolvedValue([{ id: "g1", otherTags: ["Old"] }]);
    const c = await carryTagRename("old", "new");
    expect(c).toMatchObject({ users: 2, groupMappings: 1 });
    expect(prisma.user.update).toHaveBeenCalledTimes(2);
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { otherTags: ["Plant", "new", "x"] } });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: "u2" }, data: { otherTags: ["new"] } });
    expect(prisma.groupMapping.update).toHaveBeenCalledWith({ where: { id: "g1" }, data: { otherTags: ["new"] } });
  });

  it("a failed scope holder counts 0 and the rest still run", async () => {
    stubbed(prisma.user.findMany).mockRejectedValue(new Error("db"));
    stubbed(prisma.groupMapping.findMany).mockResolvedValue([{ id: "g1", otherTags: ["old"] }]);
    const c = await carryTagRename("old", "new");
    expect(c).toMatchObject({ users: 0, groupMappings: 1 });
  });
});

describe("carryTagRename — filter holders", () => {
  it("selects id plus each holder's JSON columns", async () => {
    await carryTagRename("old", "new");
    expect(stubbed(prisma.notificationRule.findMany).mock.calls[0]![0].select).toEqual({
      id: true, trigger: true, scope: true, reset: true, actions: true, escalation: true, severityBands: true,
      bandNotify: true, resetActions: true, targets: true, quietTime: true,
    });
    expect(stubbed(prisma.alertGroup.findMany).mock.calls[0]![0].select).toEqual({ id: true, scope: true, actions: true, resetActions: true, escalation: true });
    expect(stubbed(prisma.quietTimeSchedule.findMany).mock.calls[0]![0].select).toEqual({ id: true, scope: true, quiet: true });
    expect(stubbed(prisma.pathCheck.findMany).mock.calls[0]![0].select).toEqual({ id: true, scope: true, sourceFilter: true });
    expect(stubbed(prisma.tag.findMany).mock.calls[0]![0].select).toEqual({ id: true, assetCondition: true });
    expect(stubbed(prisma.contact.findMany).mock.calls[0]![0].select).toEqual({ id: true, assetCondition: true });
  });

  it("writes only the rows, and only the columns, that name the tag", async () => {
    stubbed(prisma.notificationRule.findMany).mockResolvedValue([
      {
        id: "r1", trigger: { conditions: [cond("OLD")] }, scope: { all: [cond("plant")] }, reset: null,
        actions: [{ type: "notify", recipientTags: ["old", "ops"] }], escalation: undefined,
        severityBands: [], bandNotify: null, resetActions: null, targets: null,
        quietTime: { dimensionFilter: { ifTag: "uplink|Old" } },
      },
      { id: "r2", trigger: { conditions: [cond("old", "hostname")] }, scope: null },
    ]);
    const c = await carryTagRename("old", "new");
    expect(c.automations).toBe(1);
    expect(prisma.notificationRule.update).toHaveBeenCalledTimes(1);
    expect(prisma.notificationRule.update).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: {
        trigger: { conditions: [{ field: "tag", operator: "has", value: "new" }] },
        actions: [{ type: "notify", recipientTags: ["new", "ops"] }],
        quietTime: { dimensionFilter: { ifTag: "uplink|new" } },
      },
    });
  });

  it("counts each holder table separately", async () => {
    stubbed(prisma.alertGroup.findMany).mockResolvedValue([{ id: "ag1", scope: [cond("old")] }, { id: "ag2", scope: [cond("old")] }]);
    stubbed(prisma.quietTimeSchedule.findMany).mockResolvedValue([{ id: "q1", scope: [cond("old")], quiet: null }]);
    stubbed(prisma.pathCheck.findMany).mockResolvedValue([{ id: "p1", scope: null, sourceFilter: { any: [cond("old")] } }]);
    stubbed(prisma.tag.findMany).mockResolvedValue([{ id: "t1", assetCondition: { all: [cond("old")] } }, { id: "t2", assetCondition: null }]);
    stubbed(prisma.contact.findMany).mockResolvedValue([{ id: "c1", assetCondition: [cond("old", "notTag")] }]);
    const c = await carryTagRename("old", "new");
    expect(c).toMatchObject({ alertGroups: 2, quietTimes: 1, pathChecks: 1, tagFilters: 1, contacts: 0, automations: 0 });
    expect(prisma.pathCheck.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { sourceFilter: { any: [{ field: "tag", operator: "has", value: "new" }] } } });
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  it("a failing holder (read or write) counts 0 and the others still carry", async () => {
    stubbed(prisma.notificationRule.findMany).mockRejectedValue(new Error("db"));
    stubbed(prisma.alertGroup.findMany).mockResolvedValue([{ id: "ag1", scope: [cond("old")] }]);
    stubbed(prisma.alertGroup.update).mockRejectedValue(new Error("locked"));
    stubbed(prisma.tag.findMany).mockResolvedValue([{ id: "t1", assetCondition: [cond("old")] }]);
    const c = await carryTagRename("old", "new");
    expect(c).toMatchObject({ automations: 0, alertGroups: 0, tagFilters: 1 });
  });
});

describe("carryTagRename — Application Map rules", () => {
  it("rewrites the rules that name the tag and saves the blob once", async () => {
    const keep = { id: "k", scope: [cond("other")], app: "ERP" };
    h.getConfig.mockResolvedValue({ version: 2, rules: [{ id: "a", scope: [cond("Old")], app: "MES" }, keep] });
    const c = await carryTagRename("old", "new");
    expect(c.appMapRules).toBe(1);
    expect(h.saveConfig).toHaveBeenCalledTimes(1);
    const saved = h.saveConfig.mock.calls[0]![0];
    expect(saved.version).toBe(2);
    expect(saved.rules[0]).toEqual({ id: "a", scope: [{ field: "tag", operator: "has", value: "new" }], app: "MES" });
    expect(saved.rules[1]).toBe(keep);
  });

  it("does not save when no rule names the tag", async () => {
    h.getConfig.mockResolvedValue({ version: 2, rules: [{ id: "k", scope: [cond("other")] }] });
    expect((await carryTagRename("old", "new")).appMapRules).toBe(0);
    expect(h.saveConfig).not.toHaveBeenCalled();
  });

  it("reports 0, never throws, when the blob cannot be read or saved", async () => {
    h.getConfig.mockRejectedValueOnce(new Error("db"));
    await expect(carryTagRename("old", "new")).resolves.toMatchObject({ appMapRules: 0 });
    h.getConfig.mockResolvedValue({ version: 2, rules: [{ id: "a", scope: [cond("old")] }] });
    h.saveConfig.mockRejectedValue(new Error("db"));
    await expect(carryTagRename("old", "new")).resolves.toMatchObject({ appMapRules: 0 });
  });
});

describe("carryRegionRename (rule 169(a))", () => {
  it("does nothing for blank names or a case-only rename", async () => {
    // Deliberate, not a gap: updateRegion does not treat a case-only change as
    // a rename (asset tags and principal scopes keep their spelling too), so
    // filters keeping theirs stays consistent with every other region holder.
    for (const [f, t] of [["", "x"], ["x", ""], ["North", "north"]] as const) {
      expect(await carryRegionRename(f, t)).toEqual(ZERO);
    }
    expect(prisma.notificationRule.findMany).not.toHaveBeenCalled();
  });

  it("renames the region: tag and the bare name in recipientRegions, and never touches principal scopes", async () => {
    stubbed(prisma.notificationRule.findMany).mockResolvedValue([{
      id: "r1",
      scope: [cond("region:North"), cond("North")],
      actions: [{ type: "notify", recipientRegions: ["north", "South"], recipientTags: ["North"] }],
      quietTime: { dimensionFilter: { ifTag: "region:north|uplink" } },
    }]);
    h.getConfig.mockResolvedValue({ version: 2, rules: [{ id: "a", scope: [cond("REGION:NORTH")] }] });
    const c = await carryRegionRename("North", "Northeast");
    expect(c).toEqual({ ...ZERO, automations: 1, appMapRules: 1 });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.groupMapping.findMany).not.toHaveBeenCalled();
    expect(prisma.notificationRule.update).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: {
        scope: [{ field: "tag", operator: "has", value: "region:Northeast" }, cond("North")],
        actions: [{ type: "notify", recipientRegions: ["Northeast", "South"], recipientTags: ["North"] }],
        quietTime: { dimensionFilter: { ifTag: "region:Northeast|uplink" } },
      },
    });
  });
});

describe("rewriteTagRefs — extra edges", () => {
  it("stops descending past 24 levels rather than recurse without bound", () => {
    let deep: Record<string, unknown> = cond("old");
    for (let i = 0; i < 30; i++) deep = { child: deep };
    expect(rewriteTagRefs(deep, "old", "new")).toBe(deep);
  });

  it("matches an ifTag term with surrounding spaces", () => {
    expect(rewriteTagRefs({ ifTag: "a| old |b" }, "old", "new")).toEqual({ ifTag: "a|new|b" });
  });
});

describe("summarizeTagCarry", () => {
  it("names every holder, singular and plural, in a fixed order", () => {
    expect(summarizeTagCarry({
      users: 1, groupMappings: 2, automations: 1, alertGroups: 3, quietTimes: 1, pathChecks: 2, tagFilters: 1, contacts: 4, appMapRules: 1,
    })).toBe("1 user, 2 group mappings, 1 automation, 3 alert groups, 1 quiet time, 2 path checks, 1 tag filter, 4 contacts, 1 Application Map rule");
    expect(summarizeTagCarry({ ...ZERO, appMapRules: 2, groupMappings: 1 })).toBe("1 group mapping, 2 Application Map rules");
  });

  it("is empty when nothing followed", () => {
    expect(summarizeTagCarry(ZERO)).toBe("");
  });
});
