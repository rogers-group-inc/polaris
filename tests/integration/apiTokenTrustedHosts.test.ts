/**
 * tests/integration/apiTokenTrustedHosts.test.ts
 *
 * Per-token trusted hosts end to end:
 *   - POST /api-tokens stores a canonicalized trustedHosts list, refuses a
 *     typo with 400, and echoes the list on GET
 *   - a token whose list covers the caller (supertest dials loopback) works
 *   - a token whose list does not is refused with 403 naming the address
 *     Polaris saw — not a bare 401 — and writes an api_token.untrusted_host
 *     warning Event
 *   - a token with no list is accepted from anywhere (pre-feature behaviour)
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser, waitForEventCount } from "./_helpers.js";
import { createToken } from "../../src/services/apiTokenService.js";
import { createRole, deleteRole } from "../../src/services/roleService.js";

const d = dbDescribe;

const ROLE = "test-trusted-hosts-assets-read";
const TOKEN_PREFIX = "trusted-hosts-test-";

let roleId = "";
let loopbackToken = "";
let remoteOnlyToken = "";
let remoteOnlyTokenId = "";
let anySourceToken = "";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  await prisma.apiToken.deleteMany({ where: { name: { startsWith: TOKEN_PREFIX } } });
  await prisma.role.deleteMany({ where: { name: ROLE } });

  roleId = (await createRole({ name: ROLE, permissions: { assets: "read" } })).id;

  loopbackToken = (await createToken({
    name: `${TOKEN_PREFIX}loopback`,
    roleId,
    trustedHosts: ["127.0.0.0/8", "::1"],
    createdBy: "integration-test",
  })).rawToken;
  const remote = await createToken({
    name: `${TOKEN_PREFIX}remote-only`,
    roleId,
    trustedHosts: ["10.99.0.0/16"],
    createdBy: "integration-test",
  });
  remoteOnlyToken = remote.rawToken;
  remoteOnlyTokenId = remote.token.id;
  anySourceToken = (await createToken({
    name: `${TOKEN_PREFIX}any`,
    roleId,
    createdBy: "integration-test",
  })).rawToken;
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.apiToken.deleteMany({ where: { name: { startsWith: TOKEN_PREFIX } } });
  await prisma.event.deleteMany({ where: { action: "api_token.untrusted_host", resourceId: remoteOnlyTokenId } });
  await deleteRole(roleId).catch(() => {});
  await prisma.$disconnect();
});

d("API token trusted hosts", () => {
  it("a token whose trusted hosts cover the caller is accepted", async () => {
    const res = await request(app).get("/api/v1/assets").set("Authorization", `Bearer ${loopbackToken}`);
    expect(res.status).toBe(200);
  });

  it("a token with no trusted hosts is accepted from any source", async () => {
    const res = await request(app).get("/api/v1/assets").set("Authorization", `Bearer ${anySourceToken}`);
    expect(res.status).toBe(200);
  });

  it("a token presented from outside its trusted hosts is 403 naming the source, and is audited", async () => {
    const res = await request(app).get("/api/v1/assets").set("Authorization", `Bearer ${remoteOnlyToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/trusted-hosts-test-remote-only/);
    expect(res.body.error).toMatch(/127\.0\.0\.1|::1/);
    expect(await waitForEventCount("api_token.untrusted_host", 1, remoteOnlyTokenId)).toBeGreaterThanOrEqual(1);
    const row = await prisma.apiToken.findUnique({ where: { id: remoteOnlyTokenId } });
    expect(row?.lastUsedAt).toBeNull();
  });

  it("POST /api-tokens canonicalizes the list and GET echoes it", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent
      .post("/api/v1/api-tokens")
      .set("X-CSRF-Token", csrf)
      .send({ name: `${TOKEN_PREFIX}route`, roleId, trustedHosts: [" 10.1.2.5/24 ", "10.1.2.0/24", "192.168.4.20"] });
    expect(res.status).toBe(201);
    expect(res.body.token.trustedHosts).toEqual(["10.1.2.0/24", "192.168.4.20"]);

    const list = await agent.get("/api/v1/api-tokens");
    const found = list.body.tokens.find((t: { name: string }) => t.name === `${TOKEN_PREFIX}route`);
    expect(found.trustedHosts).toEqual(["10.1.2.0/24", "192.168.4.20"]);
  });

  it("POST /api-tokens refuses a malformed trusted host with 400 and mints nothing", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent
      .post("/api/v1/api-tokens")
      .set("X-CSRF-Token", csrf)
      .send({ name: `${TOKEN_PREFIX}typo`, roleId, trustedHosts: ["10.1.2.300"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/10\.1\.2\.300/);
    expect(await prisma.apiToken.count({ where: { name: `${TOKEN_PREFIX}typo` } })).toBe(0);
  });
});
