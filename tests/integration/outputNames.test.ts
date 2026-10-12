/**
 * tests/integration/outputNames.test.ts
 *
 * Business rule 109, the input half. Output is encoded for its context, so a
 * name may keep its quotes and Unicode; what the API now refuses is a control
 * character in an API token name, an integration name or a certificate
 * filename — and a quote-laden name must still be accepted and come back intact.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";
import { createRole, deleteRole } from "../../src/services/roleService.js";

const d = dbDescribe;

const ROLE = "test-output-names-role";
const TOKEN_PREFIX = "test-output-names-";
let roleId = "";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  await prisma.apiToken.deleteMany({ where: { name: { startsWith: TOKEN_PREFIX } } });
  await prisma.role.deleteMany({ where: { name: ROLE } });
  roleId = (await createRole({ name: ROLE, permissions: { assets: "read" } })).id;
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.apiToken.deleteMany({ where: { name: { startsWith: TOKEN_PREFIX } } });
  await deleteRole(roleId).catch(() => {});
  await prisma.$disconnect();
});

d("API token names", () => {
  it.each(["a\nb", "a\rb", "a\u0000b", "a b"])("refuses a name with a control character: %j", async (suffix) => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post("/api/v1/api-tokens").set("X-CSRF-Token", csrf).send({ name: TOKEN_PREFIX + suffix, roleId });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/control characters/i);
  });

  it("accepts a name full of quotes and brackets and returns it exactly as typed", async () => {
    const { agent, csrf } = await authedAgent(app);
    const name = `${TOKEN_PREFIX}x');alert(1);(' "q" <b>`;
    const created = await agent.post("/api/v1/api-tokens").set("X-CSRF-Token", csrf).send({ name, roleId });
    expect(created.status).toBe(201);
    const list = await agent.get("/api/v1/api-tokens");
    expect(list.body.tokens.map((t: { name: string }) => t.name)).toContain(name);
  });
});

d("integration names", () => {
  it("refuses a name with a control character", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent
      .post("/api/v1/integrations")
      .set("X-CSRF-Token", csrf)
      .send({ type: "windowsserver", name: "lab\nserver", config: {} });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/control characters/i);
  });
});
