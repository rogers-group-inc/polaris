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

  it("PUT /api-tokens/:id/trusted-hosts takes effect on the next request, and is audited", async () => {
    const { agent, csrf } = await authedAgent(app);
    const minted = await createToken({
      name: `${TOKEN_PREFIX}editable`,
      roleId,
      trustedHosts: ["10.98.0.0/16"],
      createdBy: "integration-test",
    });
    const call = () => request(app).get("/api/v1/assets").set("Authorization", `Bearer ${minted.rawToken}`);
    expect((await call()).status).toBe(403);

    const put = await agent
      .put(`/api/v1/api-tokens/${minted.token.id}/trusted-hosts`)
      .set("X-CSRF-Token", csrf)
      .send({ trustedHosts: ["10.98.0.0/16", "127.0.0.1", "::1"] });
    expect(put.status).toBe(200);
    expect(put.body.token.trustedHosts).toEqual(["10.98.0.0/16", "127.0.0.1", "::1"]);
    expect((await call()).status).toBe(200);
    expect(await waitForEventCount("api_token.trusted_hosts_updated", 1, minted.token.id)).toBe(1);

    // Clearing the list re-opens the token and is logged at warning level.
    const cleared = await agent
      .put(`/api/v1/api-tokens/${minted.token.id}/trusted-hosts`)
      .set("X-CSRF-Token", csrf)
      .send({ trustedHosts: [] });
    expect(cleared.status).toBe(200);
    await waitForEventCount("api_token.trusted_hosts_updated", 2, minted.token.id);
    const widen = await prisma.event.findFirst({
      where: { action: "api_token.trusted_hosts_updated", resourceId: minted.token.id },
      orderBy: { timestamp: "desc" },
    });
    expect(widen?.level).toBe("warning");
    await prisma.event.deleteMany({ where: { resourceId: minted.token.id } });
  });

  it("PUT /api-tokens/:id/trusted-hosts refuses a typo (400) and a revoked token (409)", async () => {
    const { agent, csrf } = await authedAgent(app);
    const minted = await createToken({ name: `${TOKEN_PREFIX}revoked`, roleId, createdBy: "integration-test" });
    const typo = await agent
      .put(`/api/v1/api-tokens/${minted.token.id}/trusted-hosts`)
      .set("X-CSRF-Token", csrf)
      .send({ trustedHosts: ["10.1.2.300"] });
    expect(typo.status).toBe(400);
    await prisma.apiToken.update({ where: { id: minted.token.id }, data: { revokedAt: new Date() } });
    const revoked = await agent
      .put(`/api/v1/api-tokens/${minted.token.id}/trusted-hosts`)
      .set("X-CSRF-Token", csrf)
      .send({ trustedHosts: ["10.0.0.1"] });
    expect(revoked.status).toBe(409);
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
