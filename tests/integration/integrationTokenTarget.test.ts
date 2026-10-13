/**
 * tests/integration/integrationTokenTarget.test.ts
 *
 * Business rule 111(c), the two paths the 2026-10-13 re-scan found without it:
 * resolving a duplicate-IP conflict by giving a Fortinet-managed firewall a
 * new address (F1), and merging asset records (F72, checked on EITHER side).
 * Both need Integrations Read-Write, because the integration's API token
 * follows the asset's address.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import { dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";
import {
  reconcileDuplicateIpForAddresses,
  DUPLICATE_IP_COLLISION_REASON,
} from "../../src/services/duplicateIpConflictService.js";

const d = dbDescribe;
const PFX = "tokentarget-test";
const PASSWORD = "tokentarget-password-not-real";
// TEST-NET-2 — never a real fleet address.
const FW_IP = "198.51.100.140";
const ATTACKER_IP = "198.51.100.199";

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
  if (resp.status !== 200) throw new Error("login as " + username + " failed (" + resp.status + ")");
  await agent.get("/api/v1/auth/me");
  const cookies = (agent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
  const csrf = (cookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "";
  const s = { agent, csrf };
  sessions.set(username, s);
  return s;
}

let assetsAdmin = "";
let integrationsAdmin = "";
let fgtId = "";

async function wipeAssets() {
  await prisma.conflict.deleteMany({ where: { asset: { hostname: { startsWith: PFX } } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  await wipeAssets();
  await prisma.integration.deleteMany({ where: { name: { startsWith: PFX } } });
  // The built-in assetsadmin shape: assets full + conflicts write, no integrations.
  assetsAdmin = await createRoleUser("assets", matrix("read", { assets: "fullwrite", discoveryConflicts: "write", integrations: "none" }));
  integrationsAdmin = await createRoleUser("integ", matrix("read", { assets: "fullwrite", discoveryConflicts: "write", integrations: "write" }));
  const fgt = await prisma.integration.create({
    data: { name: PFX + "-fgt", type: "fortigate", enabled: false, config: { host: "10.99.242.1", port: 443, apiToken: "fgt-token-real" } as never } as never,
  });
  fgtId = fgt.id;
});

beforeEach(async () => {
  if (!dbReachable) return;
  await wipeAssets();
});

afterAll(async () => {
  if (!dbReachable) return;
  await wipeAssets();
  await prisma.integration.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.$disconnect();
});

async function managedFirewall(ip = FW_IP) {
  return prisma.asset.create({
    data: {
      hostname: PFX + "-fw", assetType: "firewall", status: "active", ipAddress: ip, ipSource: "fortigate",
      discoveredByIntegrationId: fgtId, lastSeen: new Date(), macAddress: "02:00:00:00:41:01", monitored: false,
    } as never,
  });
}

async function shadow(ip: string, extra: Record<string, unknown> = {}) {
  return prisma.asset.create({
    data: {
      hostname: PFX + "-shadow", assetType: "other", status: "active", ipAddress: ip, ipSource: "fortigate",
      lastSeen: new Date(), macAddress: "02:00:00:00:41:02", monitored: false, ...extra,
    } as never,
  });
}

d("POST /conflicts/:id/reassign-ip — rule 111(c) (re-scan F1)", () => {
  async function raise() {
    const fw = await managedFirewall();
    await shadow(FW_IP);
    await reconcileDuplicateIpForAddresses([FW_IP]);
    const conflict = await prisma.conflict.findFirst({
      where: {
        status: "pending", entityType: "asset",
        proposedAssetFields: { path: ["collisionReason"], equals: DUPLICATE_IP_COLLISION_REASON },
        asset: { hostname: { startsWith: PFX } },
      },
    });
    expect(conflict).toBeTruthy();
    return { fwId: fw.id, conflictId: conflict!.id };
  }

  it("refuses to give the managed firewall a new address without Integrations Read-Write", async () => {
    const { fwId, conflictId } = await raise();
    const { agent, csrf } = await loginAs(assetsAdmin);
    const res = await agent.post(`/api/v1/conflicts/${conflictId}/reassign-ip`).set("X-CSRF-Token", csrf).send({ assetId: fwId, ipAddress: ATTACKER_IP });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/Integrations Read-Write/);
    expect((await prisma.asset.findUnique({ where: { id: fwId } }))!.ipAddress).toBe(FW_IP);
  });

  it("allows it with Integrations Read-Write", async () => {
    const { fwId, conflictId } = await raise();
    const { agent, csrf } = await loginAs(integrationsAdmin);
    const res = await agent.post(`/api/v1/conflicts/${conflictId}/reassign-ip`).set("X-CSRF-Token", csrf).send({ assetId: fwId, ipAddress: ATTACKER_IP });
    expect(res.status).toBe(200);
    expect((await prisma.asset.findUnique({ where: { id: fwId } }))!.ipAddress).toBe(ATTACKER_IP);
  });
});

d("POST /assets/:id/merge — rule 111(c), either side (re-scan F72)", () => {
  it("refuses a hand-made record absorbing the firewall and keeping its own address", async () => {
    const fw = await managedFirewall();
    const fake = await shadow(ATTACKER_IP, { ipSource: "manual", ipOverride: ATTACKER_IP, macAddress: "02:00:00:00:41:03" });
    const { agent, csrf } = await loginAs(assetsAdmin);
    const res = await agent.post(`/api/v1/assets/${fake.id}/merge`).set("X-CSRF-Token", csrf).send({ otherAssetId: fw.id, survivor: "this" });
    expect(res.status).toBe(403);
    expect(await prisma.asset.findUnique({ where: { id: fw.id } })).toBeTruthy();
  });

  it("refuses the firewall surviving with the absorbed record's address", async () => {
    const fw = await managedFirewall();
    const other = await shadow(ATTACKER_IP, { macAddress: "02:00:00:00:41:04" });
    const { agent, csrf } = await loginAs(assetsAdmin);
    const res = await agent.post(`/api/v1/assets/${fw.id}/merge`).set("X-CSRF-Token", csrf)
      .send({ otherAssetId: other.id, survivor: "this", fieldWinners: { ipAddress: "other" } });
    expect(res.status).toBe(403);
    expect((await prisma.asset.findUnique({ where: { id: fw.id } }))!.ipAddress).toBe(FW_IP);
  });

  it("allows a merge that keeps the firewall's own address", async () => {
    const fw = await managedFirewall();
    const other = await shadow(ATTACKER_IP, { macAddress: "02:00:00:00:41:05" });
    const { agent, csrf } = await loginAs(assetsAdmin);
    const res = await agent.post(`/api/v1/assets/${fw.id}/merge`).set("X-CSRF-Token", csrf).send({ otherAssetId: other.id, survivor: "this" });
    expect(res.status).toBe(200);
    expect((await prisma.asset.findUnique({ where: { id: fw.id } }))!.ipAddress).toBe(FW_IP);
  });

  it("allows either refused merge with Integrations Read-Write", async () => {
    const fw = await managedFirewall();
    const fake = await shadow(ATTACKER_IP, { ipSource: "manual", ipOverride: ATTACKER_IP, macAddress: "02:00:00:00:41:06" });
    const { agent, csrf } = await loginAs(integrationsAdmin);
    const res = await agent.post(`/api/v1/assets/${fake.id}/merge`).set("X-CSRF-Token", csrf).send({ otherAssetId: fw.id, survivor: "this" });
    expect(res.status).toBe(200);
  });
});
