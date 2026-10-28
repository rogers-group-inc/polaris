/**
 * tests/integration/builtinPriorityTags.test.ts
 *
 * Business rule 136: the five Priority tags are built in. The migration
 * (20261028130000_builtin_priority_tags) leaves every install with all five,
 * in "Priority", on their severity colour, flagged builtIn. Nobody — the test
 * user is an admin — may rename, recolour, recategorise or delete one; only
 * the device filter is editable.
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";
import { PRIORITY_TAGS, priorityTagColor } from "../../src/utils/priorityTags.js";

const d = dbDescribe;
const URL = "/api/v1/server-settings/tags";

async function critical() {
  return prisma.tag.findUniqueOrThrow({ where: { name: "Critical" } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await ensureTestUser();
});

afterAll(async () => {
  if (!dbReachable) return;
  // Leave the shared DB's Critical tag as the migration made it.
  await prisma.tag.update({
    where: { name: "Critical" },
    data: { assetCondition: null as never, criteria: null as never },
  });
});

d("built-in Priority tags (business rule 136)", () => {
  it("every install carries all five, in Priority, on their severity colour, flagged built-in", async () => {
    const rows = await prisma.tag.findMany({ where: { name: { in: PRIORITY_TAGS.map((p) => p.name) } } });
    expect(rows).toHaveLength(5);
    for (const p of PRIORITY_TAGS) {
      const row = rows.find((r) => r.name === p.name)!;
      expect(row.builtIn).toBe(true);
      expect(row.category).toBe("Priority");
      expect(row.color).toBe(priorityTagColor(p.severity));
    }
  });

  it("refuses a rename, a recolour and a category move, even for an admin", async () => {
    const { agent, csrf } = await authedAgent(app);
    const tag = await critical();
    for (const body of [{ name: "P1" }, { color: "#00ff00" }, { category: "General" }]) {
      const res = await agent.put(`${URL}/${tag.id}`).set("X-CSRF-Token", csrf).send(body);
      expect(res.status).toBe(409);
      expect(res.body.error ?? res.body.message).toMatch(/built-in Priority tag/);
    }
    const after = await critical();
    expect(after.name).toBe("Critical");
    expect(after.color).toBe("severity:critical");
    expect(after.category).toBe("Priority");
  });

  it("refuses a delete", async () => {
    const { agent, csrf } = await authedAgent(app);
    const tag = await critical();
    const res = await agent.delete(`${URL}/${tag.id}`).set("X-CSRF-Token", csrf);
    expect(res.status).toBe(409);
    expect(await prisma.tag.findUnique({ where: { id: tag.id } })).not.toBeNull();
  });

  it("accepts a device-filter edit, including one that repeats the locked fields unchanged", async () => {
    const { agent, csrf } = await authedAgent(app);
    const tag = await critical();
    const assetCondition = { op: "and", children: [{ field: "hostname", operator: "startsWith", value: "builtin-priority-test" }] };
    const res = await agent.put(`${URL}/${tag.id}`).set("X-CSRF-Token", csrf)
      .send({ name: "Critical", category: "Priority", color: "severity:critical", assetCondition });
    expect(res.status).toBe(200);
    expect((await critical()).assetCondition).toBeTruthy();

    const cleared = await agent.put(`${URL}/${tag.id}`).set("X-CSRF-Token", csrf).send({ assetCondition: null });
    expect(cleared.status).toBe(200);
    expect((await critical()).assetCondition).toBeNull();
  });
});
