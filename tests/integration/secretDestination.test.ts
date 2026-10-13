/**
 * tests/integration/secretDestination.test.ts
 *
 * Business rule 111, end to end: a write-only secret is never reused for a
 * destination the caller changed in the same request, a stored password is not
 * lent to an integration of another type, and typing a new address on an
 * integration-managed firewall needs Integrations Read-Write.
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
import { resolveControllerMgmtIp } from "../../src/services/monitoringService.js";

const d = dbDescribe;
const PFX = "secretdest-test";
const PASSWORD = "secretdest-password-not-real";

function matrix(base: string, overrides: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key } of FUNCTION_KEYS) out[key] = overrides[key] ?? base;
  return out;
}

async function createRoleUser(suffix: string, permissions: Record<string, string>): Promise<string> {
  const role = await prisma.role.create({ data: { name: PFX + "-role-" + suffix, permissions } });
  const username = PFX + "-user-" + suffix;
  await prisma.user.create({
    data: { username, passwordHash: await hashPassword(PASSWORD), roleId: role.id, authProvider: "local" },
  });
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
  if (resp.status !== 200) throw new Error("login as " + username + " failed (" + resp.status + "): " + JSON.stringify(resp.body));
  await agent.get("/api/v1/auth/me");
  const cookies = (agent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
  const csrf = (cookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "";
  if (!csrf) throw new Error("CSRF cookie not set after login");
  const s = { agent, csrf };
  sessions.set(username, s);
  return s;
}

let adminUser = "";
let assetsOnlyUser = "";
let integrationsUser = "";
let fmgId = "";
let firewallId = "";
let channelId = "";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.integration.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.notificationChannel.deleteMany({ where: { name: { startsWith: PFX } } });

  adminUser = await createRoleUser("admin", matrix("fullwrite"));
  assetsOnlyUser = await createRoleUser("assets", matrix("read", { assets: "write" }));
  integrationsUser = await createRoleUser("integrations", matrix("read", { assets: "write", integrations: "write" }));

  const fmg = await prisma.integration.create({
    data: {
      name: PFX + "-fmg",
      type: "fortimanager",
      enabled: false,
      config: { host: "10.99.241.10", port: 443, apiUser: "polaris", apiToken: "fmg-token-real", adom: "root" } as never,
    } as never,
  });
  fmgId = fmg.id;

  const fw = await prisma.asset.create({
    data: {
      hostname: PFX + "-fw",
      assetType: "firewall",
      status: "active",
      ipAddress: "10.99.241.50",
      ipSource: "fortimanager",
      discoveredByIntegrationId: fmgId,
      monitored: false,
    } as never,
  });
  firewallId = fw.id;

  const ch = await prisma.notificationChannel.create({
    data: {
      name: PFX + "-smtp",
      type: "smtp",
      enabled: false,
      config: { host: "smtp.corp.example", port: 587, security: "starttls", username: "mailer", password: "smtp-password-real", from: "polaris@corp.example" } as never,
    } as never,
  });
  channelId = ch.id;
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.integration.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.notificationChannel.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.$disconnect();
});

const storedConfig = async (id: string): Promise<Record<string, unknown>> =>
  ((await prisma.integration.findUnique({ where: { id } }))!.config as Record<string, unknown>);

d("PUT /integrations/:id — a secret does not follow a moved destination", () => {
  it("refuses a new host with the token left masked, and stores nothing", async () => {
    const { agent, csrf } = await loginAs(adminUser);
    const before = await storedConfig(fmgId);
    const res = await agent.put(`/api/v1/integrations/${fmgId}`).set("X-CSRF-Token", csrf)
      .send({ config: { host: "attacker.example", apiToken: SECRET_MASK } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/never sent to a new destination/i);
    const after = await storedConfig(fmgId);
    expect(after.host).toBe(before.host);
    expect(after.apiToken).toBe(before.apiToken);
  });

  it("refuses a new host with the token omitted", async () => {
    const { agent, csrf } = await loginAs(adminUser);
    const res = await agent.put(`/api/v1/integrations/${fmgId}`).set("X-CSRF-Token", csrf).send({ config: { host: "198.51.100.7" } });
    expect(res.status).toBe(400);
  });

  it("refuses a new port the same way", async () => {
    const { agent, csrf } = await loginAs(adminUser);
    const res = await agent.put(`/api/v1/integrations/${fmgId}`).set("X-CSRF-Token", csrf).send({ config: { port: 8443, apiToken: "" } });
    expect(res.status).toBe(400);
  });

  it("keeps the stored token when only a non-destination field changes", async () => {
    const { agent, csrf } = await loginAs(adminUser);
    const res = await agent.put(`/api/v1/integrations/${fmgId}`).set("X-CSRF-Token", csrf)
      .send({ config: { host: "10.99.241.10", apiToken: SECRET_MASK, adom: "root2" } });
    expect(res.status).toBe(200);
    const after = await storedConfig(fmgId);
    expect(after.adom).toBe("root2");
    expect(after.apiToken).toBeTruthy();
    expect(after.apiToken).not.toBe(SECRET_MASK);
  });

  it("accepts a new host when the token is typed again", async () => {
    const { agent, csrf } = await loginAs(adminUser);
    const res = await agent.put(`/api/v1/integrations/${fmgId}`).set("X-CSRF-Token", csrf)
      .send({ config: { host: "10.99.241.11", apiToken: "fmg-token-new" } });
    expect(res.status).toBe(200);
    expect((await storedConfig(fmgId)).host).toBe("10.99.241.11");
  });
});

d("POST /integrations/test — a stored secret stays with its own integration", () => {
  it("refuses an id of a different type instead of lending its secret", async () => {
    const { agent, csrf } = await loginAs(adminUser);
    const res = await agent.post("/api/v1/integrations/test").set("X-CSRF-Token", csrf)
      .send({ id: fmgId, name: "t", type: "windowsserver", config: { host: "10.99.241.99", username: "svc" } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/fortimanager integration, not windowsserver|is a fortimanager/i);
  });

  it("refuses a test aimed at a new host with the secret left blank", async () => {
    const { agent, csrf } = await loginAs(adminUser);
    const res = await agent.post("/api/v1/integrations/test").set("X-CSRF-Token", csrf)
      .send({ id: fmgId, name: "t", type: "fortimanager", config: { host: "198.51.100.9", apiToken: "" } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/never sent to a new destination/i);
  });
});

d("PUT /delivery-channels/:id — an SMTP password does not follow a moved server", () => {
  const put = async (config: Record<string, unknown>) => {
    const { agent, csrf } = await loginAs(adminUser);
    return agent.put(`/api/v1/delivery-channels/${channelId}`).set("X-CSRF-Token", csrf).send({ name: PFX + "-smtp", config });
  };

  it("refuses a new host with the password masked", async () => {
    const res = await put({ host: "mail.attacker.example", port: 587, security: "starttls", username: "mailer", password: SECRET_MASK });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/never sent to a new destination/i);
    const row = await prisma.notificationChannel.findUnique({ where: { id: channelId } });
    expect((row!.config as Record<string, unknown>).host).toBe("smtp.corp.example");
  });

  it("refuses downgrading the security with the password masked", async () => {
    const res = await put({ host: "smtp.corp.example", port: 25, security: "none", username: "mailer", password: SECRET_MASK });
    expect(res.status).toBe(400);
  });

  it("keeps the password when the server is unchanged", async () => {
    const res = await put({ host: "smtp.corp.example", port: 587, security: "starttls", username: "mailer", password: SECRET_MASK, from: "alerts@corp.example" });
    expect(res.status).toBe(200);
    const row = await prisma.notificationChannel.findUnique({ where: { id: channelId } });
    expect((row!.config as Record<string, unknown>).password).toBeTruthy();
    expect((row!.config as Record<string, unknown>).from).toBe("alerts@corp.example");
  });

  it("accepts a new server when the password is typed again", async () => {
    const res = await put({ host: "smtp2.corp.example", port: 587, security: "starttls", username: "mailer", password: "typed-again" });
    expect(res.status).toBe(200);
  });
});

d("PUT /assets/:id — a firewall's address is where the integration token goes", () => {
  it("refuses an Assets Read-Write caller typing a new address", async () => {
    const { agent, csrf } = await loginAs(assetsOnlyUser);
    const res = await agent.put(`/api/v1/assets/${firewallId}`).set("X-CSRF-Token", csrf).send({ ipAddress: "198.51.100.77" });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/Integrations Read-Write/);
    expect((await prisma.asset.findUnique({ where: { id: firewallId } }))!.ipAddress).toBe("10.99.241.50");
  });

  it("still lets an Assets Read-Write caller edit anything else on it", async () => {
    const { agent, csrf } = await loginAs(assetsOnlyUser);
    const res = await agent.put(`/api/v1/assets/${firewallId}`).set("X-CSRF-Token", csrf).send({ notes: "rack 4", ipAddress: "10.99.241.50" });
    expect(res.status).toBe(200);
  });

  it("allows a caller who can manage integrations", async () => {
    const { agent, csrf } = await loginAs(integrationsUser);
    const res = await agent.put(`/api/v1/assets/${firewallId}`).set("X-CSRF-Token", csrf).send({ ipAddress: "10.99.241.51" });
    expect(res.status).toBe(200);
    expect((await prisma.asset.findUnique({ where: { id: firewallId } }))!.ipAddress).toBe("10.99.241.51");
  });

  it("does not gate an asset no integration manages", async () => {
    const { agent, csrf } = await loginAs(assetsOnlyUser);
    const plain = await prisma.asset.create({ data: { hostname: PFX + "-plain", assetType: "server", status: "active", ipAddress: "10.99.241.60", monitored: false } as never });
    const res = await agent.put(`/api/v1/assets/${plain.id}`).set("X-CSRF-Token", csrf).send({ ipAddress: "10.99.241.61" });
    expect(res.status).toBe(200);
  });
});

d("PUT /assets/:id — the gate follows the managing integration, not the asset type", () => {
  it("refuses a new address on a managed firewall retyped to server", async () => {
    const retyped = await prisma.asset.create({
      data: { hostname: PFX + "-retyped", assetType: "server", status: "active", ipAddress: "10.99.241.70", discoveredByIntegrationId: fmgId, monitored: false } as never,
    });
    const { agent, csrf } = await loginAs(assetsOnlyUser);
    const res = await agent.put(`/api/v1/assets/${retyped.id}`).set("X-CSRF-Token", csrf).send({ ipAddress: "198.51.100.79" });
    expect(res.status).toBe(403);
    expect((await prisma.asset.findUnique({ where: { id: retyped.id } }))!.ipAddress).toBe("10.99.241.70");
  });

  it("refuses a new address on a managed FortiSwitch too", async () => {
    const sw = await prisma.asset.create({
      data: { hostname: PFX + "-sw", assetType: "switch", status: "active", ipAddress: "10.99.241.71", discoveredByIntegrationId: fmgId, monitored: false } as never,
    });
    const { agent, csrf } = await loginAs(assetsOnlyUser);
    const res = await agent.put(`/api/v1/assets/${sw.id}`).set("X-CSRF-Token", csrf).send({ ipAddress: "198.51.100.80" });
    expect(res.status).toBe(403);
  });
});

d("resolveControllerMgmtIp — only a firewall the integration manages answers", () => {
  const fmgCfg = { host: "127.0.0.1", port: 9, apiUser: "", apiToken: "", adom: "root", mgmtInterface: "" } as never;

  it("ignores a hand-made firewall asset that borrows the controller's name", async () => {
    await prisma.asset.create({
      data: { hostname: PFX + "-ctl-decoy", assetType: "firewall", status: "active", ipAddress: "198.51.100.81", monitored: false } as never,
    });
    expect(await resolveControllerMgmtIp(fmgId, PFX + "-ctl-decoy", fmgCfg)).toBeNull();
  });

  it("returns the managed firewall's address, matching the name case-insensitively", async () => {
    await prisma.asset.create({
      data: { hostname: PFX + "-ctl-real", assetType: "firewall", status: "active", ipAddress: "10.99.241.82", discoveredByIntegrationId: fmgId, monitored: false } as never,
    });
    expect(await resolveControllerMgmtIp(fmgId, (PFX + "-CTL-REAL").toUpperCase(), fmgCfg)).toBe("10.99.241.82");
  });
});

d("POST /assets/import-pdf — an invoice row cannot move a managed firewall's address", () => {
  const SERIAL = "FGT60FTK" + PFX.replace(/[^a-z]/g, "").toUpperCase().slice(0, 8);

  beforeAll(async () => {
    if (!dbReachable) return;
    await prisma.asset.update({ where: { id: firewallId }, data: { serialNumber: SERIAL } });
  });

  it("refuses an Assets Read-Write caller, even on a dry run, and writes nothing", async () => {
    const before = (await prisma.asset.findUnique({ where: { id: firewallId } }))!.ipAddress;
    const { agent, csrf } = await loginAs(assetsOnlyUser);
    for (const dryRun of [true, false]) {
      const res = await agent.post("/api/v1/assets/import-pdf").set("X-CSRF-Token", csrf)
        .send({ assets: [{ serialNumber: SERIAL, ipAddress: "198.51.100.78" }], dryRun });
      expect(res.status).toBe(403);
    }
    expect((await prisma.asset.findUnique({ where: { id: firewallId } }))!.ipAddress).toBe(before);
  });

  it("still imports the row's other fields when it carries no new address", async () => {
    const { agent, csrf } = await loginAs(assetsOnlyUser);
    const res = await agent.post("/api/v1/assets/import-pdf").set("X-CSRF-Token", csrf)
      .send({ assets: [{ serialNumber: SERIAL, model: "FortiGate-60F" }], dryRun: false });
    expect(res.status).toBe(200);
    expect((await prisma.asset.findUnique({ where: { id: firewallId } }))!.model).toBe("FortiGate-60F");
  });
});
