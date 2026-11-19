/**
 * tests/integration/alertGroupClone.test.ts — the Alert Groups row menu's
 * Clone (`cloneGroup`): every setting copied server-side — including a stored
 * api_call header the browser only ever sees masked — and NO automations,
 * since an automation belongs to at most one group.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { cloneGroup } from "../../src/services/alertGroupService.js";

const d = dbDescribe;
const NAME = "grp-clone-test";

async function wipe(): Promise<void> {
  await prisma.notificationRule.deleteMany({ where: { name: { startsWith: NAME } } });
  await prisma.alertGroup.deleteMany({ where: { name: { startsWith: NAME } } });
}

d("alert group clone", () => {
  beforeEach(wipe);
  afterAll(async () => { if (dbReachable) await wipe(); });

  it("copies every setting and the delivery half, but no members", async () => {
    const actions = [{ type: "api_call", method: "POST", url: "https://hooks.example.test/x", headers: { Authorization: "Bearer s3cret" } }];
    const src = await prisma.alertGroup.create({
      data: {
        name: `${NAME} source`, description: "desc", enabled: true, foldBy: "automation", minFailingPercent: 80,
        pathCheckIds: ["pc-a"], scope: { allAssets: true }, messageTemplate: "{asset}", requireAckNote: true,
        actions, repeat: { everyMin: 30, stopOn: "acknowledge" },
      } as never,
      select: { id: true },
    });
    await prisma.notificationRule.create({
      data: {
        name: `${NAME} member`, enabled: true, severity: "serious",
        trigger: { type: "asset_state", field: "poeStatus", operator: "==", value: "fault" },
        scope: { allAssets: true }, reset: { mode: "auto" }, actions: [], channels: ["in_app"], alertGroupId: src.id,
      } as never,
    });

    const copy = await cloneGroup(src.id, `${NAME} source (copy)`, "tester");

    expect(copy.id).not.toBe(src.id);
    expect(copy.name).toBe(`${NAME} source (copy)`);
    expect(copy.rules).toEqual([]);
    const row = await prisma.alertGroup.findUniqueOrThrow({ where: { id: copy.id } });
    expect(row).toMatchObject({
      description: "desc", enabled: true, foldBy: "automation", minFailingPercent: 80,
      pathCheckIds: ["pc-a"], messageTemplate: "{asset}", requireAckNote: true, createdBy: "tester",
    });
    expect(row.actions).toEqual(actions); // the real header, not a mask
    expect(row.repeat).toEqual({ everyMin: 30, stopOn: "acknowledge" });
    // The source keeps its member.
    expect(await prisma.notificationRule.count({ where: { alertGroupId: src.id } })).toBe(1);
    const ev = await prisma.event.findFirst({ where: { action: "alert_group.created", resourceId: copy.id }, select: { details: true } });
    expect((ev?.details as Record<string, unknown>)?.clonedFrom).toBe(src.id);
  });

  it("refuses an unknown group", async () => {
    await expect(cloneGroup("00000000-0000-0000-0000-000000000000", `${NAME} x`)).rejects.toMatchObject({ httpStatus: 404 });
  });
});
