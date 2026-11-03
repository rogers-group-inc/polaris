/**
 * tests/integration/agentDeployGrant.test.ts
 *
 * Deploying the Polaris Agent is its own key, `agentDeploy` (2026-11-03; it
 * was `assets=fullwrite` from 2026-09-04 until then), not `assets=write`: it runs an installer on someone else's machine over a
 * stored SSH / WinRM credential and leaves a service behind, which is a
 * different act from editing an inventory record. Two halves are pinned here
 * because they are two different doors onto the same capability:
 *
 *  - the per-asset and bulk deploy routes, which an assets=write role could
 *    reach before, and
 *  - `agentDeploy.enabled` on an integration's class block, which is the same
 *    deployment at fleet scale and unattended. That one is CHAINED onto
 *    integrations=write: without the chain, an integrations-write role
 *    (built-in `networkadmin`, which holds assets=read) could deploy to the
 *    whole fleet through a checkbox it was never allowed to click on one
 *    device.
 *
 * Turning the toggle OFF, and any save that leaves it as it was, deliberately
 * need nothing extra — a role that inherited an enabled block must still be
 * able to switch it off.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import { dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const PFX = "agentgrant-test";
const PASSWORD = "agentgrant-password-not-real";

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
  const resp = await agent
    .post("/api/v1/auth/login")
    .send({ username, password: PASSWORD })
    .set("Content-Type", "application/json");
  if (resp.status !== 200) {
    throw new Error("login as " + username + " failed (" + resp.status + "): " + JSON.stringify(resp.body));
  }
  await agent.get("/api/v1/auth/me");
  const cookies = (agent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
  const csrf = (cookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "";
  if (!csrf) throw new Error("CSRF cookie not set after login");
  const s = { agent, csrf };
  sessions.set(username, s);
  return s;
}

let assetsWriteUser = "";
let integrationsWriteUser = "";
let fullUser = "";
let assetId = "";
let integrationId = "";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.integration.deleteMany({ where: { name: { startsWith: PFX } } });

  const asset = await prisma.asset.create({
    data: { hostname: PFX + "-host", assetType: "server", status: "active", ipAddress: "10.99.240.5", monitored: false } as never,
  });
  assetId = asset.id;

  const integration = await prisma.integration.create({
    data: {
      name: PFX + "-ad",
      type: "active_directory",
      enabled: false,
      config: {
        host: "10.99.240.10",
        serverMonitor: { enabled: true, addAsMonitored: false, agentDeploy: null },
      } as never,
    } as never,
  });
  integrationId = integration.id;

  // Full inventory editing, no deployment.
  assetsWriteUser = await createRoleUser("assetswrite", matrix("read", { assets: "write" }));
  // The networkadmin shape: may configure integrations, may only read assets.
  integrationsWriteUser = await createRoleUser("intwrite", matrix("read", { integrations: "write", assets: "read" }));
  // Admin-equivalent for the positive case.
  fullUser = await createRoleUser("full", matrix("fullwrite"));
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.integration.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX + "-user-" } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: PFX + "-role-" } } });
});

d("Polaris Agent deployment needs the agentDeploy key", () => {
  it("assets=write cannot install the agent on one asset", async () => {
    const s = await loginAs(assetsWriteUser);
    const res = await s.agent
      .post("/api/v1/assets/" + assetId + "/agent/install")
      .set("X-CSRF-Token", s.csrf)
      .send({ os: "linux", arch: "amd64", sshCredentialId: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(403);
  });

  it("assets=write cannot bulk-deploy either", async () => {
    const s = await loginAs(assetsWriteUser);
    const res = await s.agent
      .post("/api/v1/assets/bulk-agent-install")
      .set("X-CSRF-Token", s.csrf)
      .send({ assetIds: [assetId], sshCredentialId: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(403);
  });

  it("assets=write still reads the agent state — seeing is not deploying", async () => {
    const s = await loginAs(assetsWriteUser);
    const res = await s.agent.get("/api/v1/assets/" + assetId + "/agent");
    expect(res.status).not.toBe(403);
  });

  it("integrations=write cannot turn auto-deploy ON", async () => {
    const s = await loginAs(integrationsWriteUser);
    const res = await s.agent
      .put("/api/v1/integrations/" + integrationId)
      .set("X-CSRF-Token", s.csrf)
      .send({
        config: {
          serverMonitor: {
            enabled: true,
            addAsMonitored: false,
            agentDeploy: { enabled: true, sshCredentialId: null, winrmCredentialId: null, maxConcurrent: 4 },
          },
        },
      });
    expect(res.status).toBe(403);
    expect(String(res.body.error ?? res.body.message ?? "")).toMatch(/Agent Deploy/i);

    const after = await prisma.integration.findUnique({ where: { id: integrationId } });
    expect(((after?.config as any)?.serverMonitor?.agentDeploy?.enabled) ?? false).toBe(false);
  });

  it("integrations=write may still save the integration with the toggle left off", async () => {
    const s = await loginAs(integrationsWriteUser);
    const res = await s.agent
      .put("/api/v1/integrations/" + integrationId)
      .set("X-CSRF-Token", s.csrf)
      .send({ config: { serverMonitor: { enabled: true, addAsMonitored: true, agentDeploy: null } } });
    expect(res.status).toBe(200);
  });

  it("agentDeploy may turn auto-deploy on, and a write-level role may then turn it OFF", async () => {
    const su = await loginAs(fullUser);
    const on = await su.agent
      .put("/api/v1/integrations/" + integrationId)
      .set("X-CSRF-Token", su.csrf)
      .send({
        config: {
          serverMonitor: {
            enabled: true,
            addAsMonitored: false,
            agentDeploy: { enabled: true, sshCredentialId: null, winrmCredentialId: null, maxConcurrent: 4 },
          },
        },
      });
    expect(on.status).toBe(200);
    const mid = await prisma.integration.findUnique({ where: { id: integrationId } });
    expect((mid?.config as any)?.serverMonitor?.agentDeploy?.enabled).toBe(true);

    // Off is the direction that needs no extra grant.
    const s = await loginAs(integrationsWriteUser);
    const off = await s.agent
      .put("/api/v1/integrations/" + integrationId)
      .set("X-CSRF-Token", s.csrf)
      .send({
        config: {
          serverMonitor: {
            enabled: true,
            addAsMonitored: false,
            agentDeploy: { enabled: false, sshCredentialId: null, winrmCredentialId: null, maxConcurrent: 4 },
          },
        },
      });
    expect(off.status).toBe(200);
    const end = await prisma.integration.findUnique({ where: { id: integrationId } });
    expect((end?.config as any)?.serverMonitor?.agentDeploy?.enabled).toBe(false);
  });
});
