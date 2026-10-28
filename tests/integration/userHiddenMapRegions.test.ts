/**
 * tests/integration/userHiddenMapRegions.test.ts
 *
 * The /api/v1/me/hidden-map-regions surface (Device Map Regions panel eyes,
 * shared with the phone's Map tab):
 *   - empty before anything is saved; a full-replace PUT round-trips, normalized
 *   - strictly per user — two users never see each other's
 *   - a readonly caller can hide regions (no function-key gate; view-only)
 *   - a malformed body is refused
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;

const RO_USERNAME = "polaris-hidden-regions-readonly";
const RO_PASSWORD = "test-password-do-not-use-in-prod";
const PATH = "/api/v1/me/hidden-map-regions";

let admin: { agent: ReturnType<typeof request.agent>; csrf: string };
let readonly: { agent: ReturnType<typeof request.agent>; csrf: string };

async function loginReadonly() {
  const agent = request.agent(app);
  await agent.get("/api/v1/auth/me");
  const resp = await agent
    .post("/api/v1/auth/login")
    .send({ username: RO_USERNAME, password: RO_PASSWORD })
    .set("Content-Type", "application/json");
  if (resp.status !== 200) throw new Error(`readonly login failed (${resp.status})`);
  await agent.get("/api/v1/auth/me");
  const cookies = (agent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
  const csrf = (cookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "";
  return { agent, csrf };
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  admin = await authedAgent(app);

  const roRole = await prisma.role.findUnique({ where: { name: "readonly" } });
  if (!roRole) throw new Error("built-in 'readonly' Role missing — run prisma migrate deploy on the test DB");
  await prisma.user.upsert({
    where:  { username: RO_USERNAME },
    update: { roleId: roRole.id },
    create: {
      username:     RO_USERNAME,
      passwordHash: await hashPassword(RO_PASSWORD),
      roleId:       roRole.id,
      authProvider: "local",
    },
  });
  readonly = await loginReadonly();
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.user.updateMany({ data: { hiddenMapRegionIds: [] } });
  await prisma.user.deleteMany({ where: { username: RO_USERNAME } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.user.updateMany({ data: { hiddenMapRegionIds: [] } });
});

d("/me/hidden-map-regions", () => {
  it("starts empty and round-trips a normalized full replace", async () => {
    const empty = await admin.agent.get(PATH);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ regionIds: [] });

    const put = await admin.agent
      .put(PATH)
      .set("X-CSRF-Token", admin.csrf)
      .send({ regionIds: ["r1", " r2 ", "r1", ""] });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ regionIds: ["r1", "r2"] });

    const back = await admin.agent.get(PATH);
    expect(back.body).toEqual({ regionIds: ["r1", "r2"] });

    const cleared = await admin.agent.put(PATH).set("X-CSRF-Token", admin.csrf).send({ regionIds: [] });
    expect(cleared.body).toEqual({ regionIds: [] });
  });

  it("is strictly per user, and open to a readonly caller", async () => {
    await admin.agent.put(PATH).set("X-CSRF-Token", admin.csrf).send({ regionIds: ["admins-region"] });

    const roEmpty = await readonly.agent.get(PATH);
    expect(roEmpty.status).toBe(200);
    expect(roEmpty.body).toEqual({ regionIds: [] });

    const roPut = await readonly.agent.put(PATH).set("X-CSRF-Token", readonly.csrf).send({ regionIds: ["ro-region"] });
    expect(roPut.status).toBe(200);
    expect(roPut.body).toEqual({ regionIds: ["ro-region"] });

    const adminBack = await admin.agent.get(PATH);
    expect(adminBack.body).toEqual({ regionIds: ["admins-region"] });
  });

  it("refuses a malformed body", async () => {
    const notArray = await admin.agent.put(PATH).set("X-CSRF-Token", admin.csrf).send({ regionIds: "r1" });
    expect(notArray.status).toBe(400);
    const missing = await admin.agent.put(PATH).set("X-CSRF-Token", admin.csrf).send({});
    expect(missing.status).toBe(400);
  });
});
