/**
 * tests/integration/secretFollowsDestinationPhase10.test.ts
 *
 * Business rules 111 and 112, the route-level gaps the 2026-10-13 re-scan
 * found: the LDAP settings save kept the bind password when the server moved
 * (F3), an Integrations Read-Write user could repoint the AI Assistant (F59),
 * and a read-only role could walk an asset with any stored SNMP credential
 * (F62).
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import { SECRET_MASK } from "../../src/utils/secretMask.js";
import { dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";
import { assertCredentialInAssetScope } from "../../src/services/assetCredentialScopeService.js";

const d = dbDescribe;
const PFX = "phase10-test";
const PASSWORD = "phase10-password-not-real";

function matrix(base: string, overrides: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key } of FUNCTION_KEYS) out[key] = overrides[key] ?? base;
  return out;
}
async function createRoleUser(suffix: string, permissions: Record<string, string>): Promise<string> {
  const role = await prisma.role.create({ data: { name: PFX + "-role-" + suffix, permissions } });
  const username = PFX + "-user-" + suffix;
  await prisma.user.create({ data: { username, passwordHash: await hashPassword(PASSWORD), roleId: role.id, authProvider: "local" } });
  return username;
}
type Session = { agent: ReturnType<typeof request.agent>; csrf: string };
const sessions = new Map<string, Session>();
async function loginAs(username: string): Promise<Session> {
  const cached = sessions.get(username);
  if (cached) return cached;
  const agent = request.agent(app);
  await agent.get("/api/v1/auth/me");
  const resp = await agent.post("/api/v1/auth/login").send({ username, password: PASSWORD }).set("Content-Type", "application/json");
  if (resp.status !== 200) throw new Error("login as " + username + " failed (" + resp.status + ")");
  await agent.get("/api/v1/auth/me");
  const cookies = (agent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
  const s = { agent, csrf: (cookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "" };
  sessions.set(username, s);
  return s;
}

let admin = "";
let readOnly = "";
let integrationsOnly = "";
let ownCredId = "";
let otherCredId = "";
let assetId = "";
let llmId = "";
let savedLdap: unknown = undefined;

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.integration.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.credential.deleteMany({ where: { name: { startsWith: PFX } } });
  admin = await createRoleUser("admin", matrix("fullwrite"));
  readOnly = await createRoleUser("ro", matrix("read"));
  integrationsOnly = await createRoleUser("integ", matrix("read", { integrations: "write" }));

  const own = await prisma.credential.create({ data: { name: PFX + "-own", type: "snmp", config: { version: "v2c", community: "own-community" } as never } as never });
  const other = await prisma.credential.create({ data: { name: PFX + "-other", type: "snmp", config: { version: "v2c", community: "other-community" } as never } as never });
  ownCredId = own.id;
  otherCredId = other.id;
  const a = await prisma.asset.create({
    data: { hostname: PFX + "-sw", assetType: "switch", status: "active", ipAddress: "198.51.100.150", monitored: false, monitorCredentialId: ownCredId } as never,
  });
  assetId = a.id;

  const llm = await prisma.integration.create({
    data: { name: PFX + "-llm", type: "llm", enabled: false, config: { provider: "openai", host: "llm.corp.example", port: 443, useHttps: true, basePath: "/v1", model: "m", maxToolRounds: 12, maxRowsPerTool: 1000 } as never } as never,
  });
  llmId = llm.id;

  savedLdap = (await prisma.setting.findUnique({ where: { key: "ldap" } }))?.value;
  await prisma.setting.upsert({
    where: { key: "ldap" },
    update: { value: { enabled: false, url: "ldaps://dc1.corp.example:636", bindDn: "cn=svc", bindPassword: "stored-bind-pw", tlsVerify: true } as never },
    create: { key: "ldap", value: { enabled: false, url: "ldaps://dc1.corp.example:636", bindDn: "cn=svc", bindPassword: "stored-bind-pw", tlsVerify: true } as never },
  });
});

afterAll(async () => {
  if (!dbReachable) return;
  if (savedLdap === undefined) await prisma.setting.deleteMany({ where: { key: "ldap" } });
  else await prisma.setting.update({ where: { key: "ldap" }, data: { value: savedLdap as never } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.integration.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.credential.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.$disconnect();
});

d("PUT /auth/ldap/settings — the bind password follows the server (F3)", () => {
  it("refuses an echoed mask with a new server URL, and leaves the stored password alone", async () => {
    const { agent, csrf } = await loginAs(admin);
    const res = await agent.put("/api/v1/auth/ldap/settings").set("X-CSRF-Token", csrf)
      .send({ enabled: false, url: "ldaps://evil.example:636", bindDn: "cn=svc", bindPassword: SECRET_MASK, tlsVerify: true });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/bind password/);
    const row = await prisma.setting.findUnique({ where: { key: "ldap" } });
    expect((row!.value as Record<string, unknown>).url).toBe("ldaps://dc1.corp.example:636");
  });
  it("keeps it for an echoed mask when the server is unchanged", async () => {
    const { agent, csrf } = await loginAs(admin);
    const res = await agent.put("/api/v1/auth/ldap/settings").set("X-CSRF-Token", csrf)
      .send({ enabled: false, url: "ldaps://dc1.corp.example:636", bindDn: "cn=svc2", bindPassword: SECRET_MASK, tlsVerify: true });
    expect(res.status).toBe(200);
  });
});

d("PUT /integrations/:id (llm) — repointing the AI Assistant (F59)", () => {
  it("refuses an Integrations Read-Write caller moving the model server", async () => {
    const { agent, csrf } = await loginAs(integrationsOnly);
    const res = await agent.put(`/api/v1/integrations/${llmId}`).set("X-CSRF-Token", csrf).send({ config: { host: "llm.evil.example" } });
    expect(res.status).toBe(403);
    const row = await prisma.integration.findUnique({ where: { id: llmId } });
    expect((row!.config as Record<string, unknown>).host).toBe("llm.corp.example");
  });
  it("still lets that caller change the model", async () => {
    const { agent, csrf } = await loginAs(integrationsOnly);
    const res = await agent.put(`/api/v1/integrations/${llmId}`).set("X-CSRF-Token", csrf).send({ config: { model: "m2" } });
    expect(res.status).toBe(200);
  });
  it("allows the move with the provisioning grants, and records it as a warning", async () => {
    const { agent, csrf } = await loginAs(admin);
    const res = await agent.put(`/api/v1/integrations/${llmId}`).set("X-CSRF-Token", csrf).send({ config: { host: "llm2.corp.example" } });
    expect(res.status).toBe(200);
    const ev = await prisma.event.findFirst({ where: { action: "integration.updated", resourceId: llmId }, orderBy: { timestamp: "desc" } });
    expect(ev?.level).toBe("warning");
  });
});

d("POST /credentials/test (restapi) — the base URL is guarded too (F73)", () => {
  it("refuses a base URL on a metadata address before anything is sent", async () => {
    const { agent, csrf } = await loginAs(admin);
    const res = await agent.post("/api/v1/credentials/test").set("X-CSRF-Token", csrf)
      .send({ type: "restapi", host: "198.51.100.151", config: { baseUrl: "http://169.254.169.254/latest/meta-data", apiToken: "t" } });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/loopback \/ link-local \/ metadata/);
  });
});

d("SNMP walk — a read-only role uses only the asset's own credentials (F62)", () => {
  it("refuses a credential the asset does not use", async () => {
    const { agent, csrf } = await loginAs(readOnly);
    const res = await agent.post(`/api/v1/assets/${assetId}/snmp-walk`).set("X-CSRF-Token", csrf).send({ credentialId: otherCredId, oid: "1.3.6.1.2.1.1", maxRows: 5 });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/Assets Read-Write/);
  });
  it("lets a read-only caller use the asset's own credential, and assets:write use any", async () => {
    await expect(assertCredentialInAssetScope(assetId, ownCredId, false)).resolves.toBeUndefined();
    await expect(assertCredentialInAssetScope(assetId, otherCredId, true)).resolves.toBeUndefined();
    await expect(assertCredentialInAssetScope(assetId, otherCredId, false)).rejects.toThrow(/Assets Read-Write/);
  });
});
