/**
 * tests/integration/credentialUseAudit.test.ts
 *
 * Business rule 112, end to end: aiming a stored credential is allowed for the
 * operator in front of the asset (or the Discovery), and every such act writes
 * an Event — `credential.borrowed` (warning) when the caller neither owns the
 * credential nor holds Credentials Full RW, `credential.used` otherwise.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import { dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const PFX = "creduse-test";
const PASSWORD = "creduse-password-not-real";

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

let operator = "";
let ownCredId = "";
let othersCredId = "";
let assetId = "";

const credEvents = (credentialId: string) =>
  prisma.event.findMany({ where: { resourceType: "credential", resourceId: credentialId }, orderBy: { timestamp: "asc" } });

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.networkScan.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.credential.deleteMany({ where: { name: { startsWith: PFX } } });

  operator = await createRoleUser("op", matrix("read", { assets: "write", credentials: "write", networkScan: "write" }));
  const own = await prisma.credential.create({
    data: { name: PFX + "-own", type: "ssh", config: { username: "u", password: "p" } as never, createdBy: operator },
  });
  const others = await prisma.credential.create({
    data: { name: PFX + "-others", type: "ssh", config: { username: "u", password: "p" } as never, createdBy: "someone-else" },
  });
  ownCredId = own.id;
  othersCredId = others.id;
  const a = await prisma.asset.create({
    data: { hostname: PFX + "-srv", assetType: "server", status: "active", ipAddress: "10.99.242.10", monitored: false } as never,
  });
  assetId = a.id;
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.event.deleteMany({ where: { resourceType: "credential", resourceId: { in: [ownCredId, othersCredId].filter(Boolean) } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.networkScan.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.credential.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.$disconnect();
});

d("PUT /assets/:id — attaching and re-aiming a credential is allowed and recorded", () => {
  it("records someone else's credential as borrowed, at warning level", async () => {
    const { agent, csrf } = await loginAs(operator);
    const res = await agent.put(`/api/v1/assets/${assetId}`).set("X-CSRF-Token", csrf).send({ monitorCredentialId: othersCredId });
    expect(res.status).toBe(200);
    const events = await credEvents(othersCredId);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("credential.borrowed");
    expect(events[0].level).toBe("warning");
    expect(events[0].actor).toBe(operator);
    expect(events[0].assetId).toBe(assetId);
    expect(events[0].message).toMatch(/owned by someone-else/);
    expect(events[0].message).toMatch(/10\.99\.242\.10/);
  });

  it("records nothing for a re-save that changes neither the credential nor the address", async () => {
    const { agent, csrf } = await loginAs(operator);
    const res = await agent.put(`/api/v1/assets/${assetId}`).set("X-CSRF-Token", csrf).send({ monitorCredentialId: othersCredId, notes: "rack 2" });
    expect(res.status).toBe(200);
    expect(await credEvents(othersCredId)).toHaveLength(1);
  });

  it("records the attached credential again when the address moves", async () => {
    const { agent, csrf } = await loginAs(operator);
    const res = await agent.put(`/api/v1/assets/${assetId}`).set("X-CSRF-Token", csrf).send({ ipAddress: "10.99.242.11" });
    expect(res.status).toBe(200);
    const events = await credEvents(othersCredId);
    expect(events).toHaveLength(2);
    expect(events[1].message).toMatch(/10\.99\.242\.11/);
  });

  it("records the caller's own credential as used, at info level", async () => {
    const { agent, csrf } = await loginAs(operator);
    const res = await agent.put(`/api/v1/assets/${assetId}`).set("X-CSRF-Token", csrf).send({ responseTimeCredentialId: ownCredId, responseTimePolling: "ssh" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const events = await credEvents(ownCredId);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("credential.used");
    expect(events[0].level).toBe("info");
  });
});

d("Network Discovery — a saved and a run Discovery record their credentials", () => {
  it("records a borrowed credential when a Discovery is saved with it", async () => {
    const { agent, csrf } = await loginAs(operator);
    const before = (await credEvents(othersCredId)).length;
    const res = await agent.post("/api/v1/network-scans").set("X-CSRF-Token", csrf).send({
      name: PFX + "-scan",
      targets: [{ kind: "single", value: "10.99.242.20" }],
      methods: [{ type: "ssh", credentialIds: [othersCredId] }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const events = await credEvents(othersCredId);
    expect(events).toHaveLength(before + 1);
    const last = events[events.length - 1];
    expect(last.action).toBe("credential.borrowed");
    expect((last.details as Record<string, unknown>).via).toBe("network-scan.save");
    expect(last.message).toMatch(/10\.99\.242\.20/);
  });
});
