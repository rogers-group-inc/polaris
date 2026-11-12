/**
 * tests/integration/tagRenameCarry.test.ts
 *
 * Business rule 169 against a real database: renaming a registry tag through
 * `updateTag` carries the new name into every place that selects by it.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { updateTag } from "../../src/services/tagRegistryService.js";
import { carryRegionRename } from "../../src/services/tagRenameCarryService.js";

const d = dbDescribe;
const PFX = "tag-carry-test";
const OLD = `${PFX}-core`;
const NEW = `${PFX}-backbone`;
const OTHER = `${PFX}-edge`;

async function cleanup() {
  await prisma.notificationRule.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.alertGroup.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.quietTimeSchedule.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.pathCheck.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.contact.deleteMany({ where: { email: { startsWith: PFX } } });
  await prisma.groupMapping.deleteMany({ where: { groupKey: { startsWith: PFX } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX } } });
  await prisma.tag.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.event.deleteMany({ where: { action: "tag.updated", resourceName: { startsWith: PFX } } });
}

const cond = (value: string) => ({ field: "tag", operator: "has", value });
const tree = (value: string) => ({ op: "and", children: [cond(value), cond(OTHER)] });

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});
beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
});
afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

d("renaming a tag follows its name (rule 169)", () => {
  it("into tag scopes, device filters and tag-routed recipients — and nowhere else", async () => {
    const tag = await prisma.tag.create({ data: { name: OLD } as never });
    const dependent = await prisma.tag.create({ data: { name: `${PFX}-derived`, assetCondition: tree(OLD.toUpperCase()) } as never });
    const role = await prisma.role.findFirstOrThrow();
    const user = await prisma.user.create({ data: { username: `${PFX}-user`, passwordHash: "x", roleId: role.id, otherTags: [OTHER, OLD] } as never });
    const bystander = await prisma.user.create({ data: { username: `${PFX}-bystander`, passwordHash: "x", roleId: role.id, otherTags: [OTHER] } as never });
    const both = await prisma.user.create({ data: { username: `${PFX}-both`, passwordHash: "x", roleId: role.id, otherTags: [OLD, NEW] } as never });
    const mapping = await prisma.groupMapping.create({ data: { provider: "oidc", groupKey: `${PFX}-group`, otherTags: [OLD] } as never });
    const rule = await prisma.notificationRule.create({ data: {
      name: `${PFX} rule`,
      trigger: { type: "asset_state", field: "ifOperStatus", operator: "==", value: "down", dimensionFilter: { ifTag: `uplink|${OLD}` } },
      scope: { conditions: tree(OLD) },
      actions: [{ type: "notify", channelId: "ch", recipientTags: [OLD, OTHER] }],
    } as never });
    const untouched = await prisma.notificationRule.create({ data: {
      name: `${PFX} untouched`, trigger: { type: "asset_state", field: "status", operator: "==", value: "down" }, scope: { conditions: { op: "and", children: [cond(OTHER)] } },
    } as never });
    const group = await prisma.alertGroup.create({ data: { name: `${PFX} group`, scope: { conditions: tree(OLD) }, actions: [{ type: "notify", channelId: "ch", recipientTags: [OLD] }] } as never });
    const quiet = await prisma.quietTimeSchedule.create({ data: { name: `${PFX} quiet`, scope: { conditions: tree(OLD) }, quiet: {} } as never });
    const check = await prisma.pathCheck.create({ data: { name: `${PFX} check`, kind: "http", target: "https://example.invalid/", traceroute: {}, scope: { conditions: tree(OLD) }, definitionSha256: "x" } as never });
    const contact = await prisma.contact.create({ data: { email: `${PFX}@example.invalid`, assetCondition: tree(OLD) } as never });
    const untouchedStamp = (await prisma.notificationRule.findUniqueOrThrow({ where: { id: untouched.id } })).updatedAt;

    await updateTag(tag.id, { name: NEW }, "tester");

    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).otherTags).toEqual([OTHER, NEW]);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: bystander.id } })).otherTags).toEqual([OTHER]);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: both.id } })).otherTags).toEqual([NEW]);
    expect((await prisma.groupMapping.findUniqueOrThrow({ where: { id: mapping.id } })).otherTags).toEqual([NEW]);

    const r = await prisma.notificationRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(r.scope).toEqual({ conditions: tree(NEW) });
    expect((r.trigger as { dimensionFilter: { ifTag: string } }).dimensionFilter.ifTag).toBe(`uplink|${NEW}`);
    expect(r.actions).toEqual([{ type: "notify", channelId: "ch", recipientTags: [NEW, OTHER] }]);
    expect((await prisma.notificationRule.findUniqueOrThrow({ where: { id: untouched.id } })).updatedAt).toEqual(untouchedStamp);

    const g = await prisma.alertGroup.findUniqueOrThrow({ where: { id: group.id } });
    expect(g.scope).toEqual({ conditions: tree(NEW) });
    expect(g.actions).toEqual([{ type: "notify", channelId: "ch", recipientTags: [NEW] }]);
    expect((await prisma.quietTimeSchedule.findUniqueOrThrow({ where: { id: quiet.id } })).scope).toEqual({ conditions: tree(NEW) });
    expect((await prisma.pathCheck.findUniqueOrThrow({ where: { id: check.id } })).scope).toEqual({ conditions: tree(NEW) });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).assetCondition).toEqual(tree(NEW));
    // Another tag's own filter, written in a different case.
    expect((await prisma.tag.findUniqueOrThrow({ where: { id: dependent.id } })).assetCondition).toEqual(tree(NEW));

    // The audit Event says what followed. logEvent is fire-and-forget.
    let message = "";
    for (let i = 0; i < 50 && !message; i++) {
      const ev = await prisma.event.findFirst({ where: { action: "tag.updated", resourceId: tag.id }, orderBy: { timestamp: "desc" } });
      message = ev?.message ?? "";
      if (!message) await new Promise((res) => setTimeout(res, 100));
    }
    expect(message).toContain("followed in 2 users, 1 group mapping, 1 automation, 1 alert group, 1 quiet time, 1 path check, 1 tag filter, 1 contact");
  });

  it("a colour-only edit carries nothing", async () => {
    const tag = await prisma.tag.create({ data: { name: OLD } as never });
    const user = await prisma.user.create({ data: { username: `${PFX}-user`, passwordHash: "x", roleId: (await prisma.role.findFirstOrThrow()).id, otherTags: [OLD] } as never });
    await updateTag(tag.id, { color: "#336699" }, "tester");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).otherTags).toEqual([OLD]);
  });
});

d("renaming a region follows its name into device filters (rule 169(a))", () => {
  it("rewrites region: conditions and recipientRegions, and leaves principals' scopes to their own service", async () => {
    const from = `${PFX}-East`;
    const to = `${PFX}-Coast`;
    const role = await prisma.role.findFirstOrThrow();
    const user = await prisma.user.create({ data: { username: `${PFX}-user`, passwordHash: "x", roleId: role.id, regionTags: [from], otherTags: [`region:${from}`] } as never });
    const rule = await prisma.notificationRule.create({ data: {
      name: `${PFX} region rule`,
      trigger: { type: "asset_state", field: "status", operator: "==", value: "down" },
      scope: { conditions: { op: "and", children: [cond(`region:${from.toUpperCase()}`), cond(from)] } },
      actions: [{ type: "notify", channelId: "ch", recipientRegions: [from, "elsewhere"] }],
    } as never });
    const quiet = await prisma.quietTimeSchedule.create({ data: { name: `${PFX} quiet`, scope: { conditions: { op: "and", children: [cond(`region:${from}`)] } }, quiet: {} } as never });

    const out = await carryRegionRename(from, to);
    expect(out).toMatchObject({ automations: 1, quietTimes: 1, users: 0, groupMappings: 0 });

    const r = await prisma.notificationRule.findUniqueOrThrow({ where: { id: rule.id } });
    // The region's tag follows; a plain tag that happens to share the name does not.
    expect(r.scope).toEqual({ conditions: { op: "and", children: [cond(`region:${to}`), cond(from)] } });
    expect(r.actions).toEqual([{ type: "notify", channelId: "ch", recipientRegions: [to, "elsewhere"] }]);
    expect((await prisma.quietTimeSchedule.findUniqueOrThrow({ where: { id: quiet.id } })).scope).toEqual({ conditions: { op: "and", children: [cond(`region:${to}`)] } });
    const u = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(u.regionTags).toEqual([from]);
    expect(u.otherTags).toEqual([`region:${from}`]);
  });
});
