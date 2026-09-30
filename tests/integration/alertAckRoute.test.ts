/**
 * tests/integration/alertAckRoute.test.ts
 *
 * `GET /api/v1/alerts/:id` — the read behind `/alert-ack.html`, the page an
 * emailed or pushed Acknowledge button opens (business rule 25). It replaced a
 * public token route, so what matters is that the ordinary permission and
 * region machinery actually covers it:
 *
 *   - it is gated (an anonymous caller gets nothing) and does not capture the
 *     sibling POST paths /acknowledge and /clear
 *   - it answers 404, NOT 403, for an alert outside the caller's region scope —
 *     which alerts exist elsewhere is not something this route should confirm
 *   - ...except to an admin-equivalent caller, whom region scope never narrows
 *     on the alert reads (the widget that opens the card is unscoped)
 *   - `requireAckNote` rides the payload flat, so the page knows how to ask
 *   - acknowledging through it records the caller, the note, and the `source`
 *     provenance, and `source` is a CLOSED set (it lands in an audit Event)
 *   - the note policy is refused by the WRITE, not by any form
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

const SCOPED_USERNAME = "polaris-ack-scoped";
const SCOPED_ADMIN_USERNAME = "polaris-ack-scoped-admin";
const SCOPED_PASSWORD = "test-password-do-not-use-in-prod";
const RULE_NAME = "polaris-ack-test-rule";

let admin: { agent: ReturnType<typeof request.agent>; csrf: string };
/** A non-admin operator scoped to one region — the 404-not-403 case. */
let scoped: { agent: ReturnType<typeof request.agent>; csrf: string };
/** An ADMIN carrying the same region tag — who the scope must not narrow. */
let scopedAdmin: { agent: ReturnType<typeof request.agent>; csrf: string };

async function upsertScopedUser(username: string, roleId: string) {
  await prisma.user.upsert({
    where: { username },
    // regionTags on the USER, so the effective scope is one region and an
    // alert tagged with a different one is out of reach.
    update: { roleId, regionTags: ["north"] },
    create: {
      username,
      passwordHash: await hashPassword(SCOPED_PASSWORD),
      roleId,
      regionTags: ["north"],
      authProvider: "local",
    },
  });
}

async function login(username: string, password: string) {
  const agent = request.agent(app);
  await agent.get("/api/v1/auth/me");
  const resp = await agent
    .post("/api/v1/auth/login")
    .send({ username, password })
    .set("Content-Type", "application/json");
  if (resp.status !== 200) throw new Error(`login failed for ${username} (${resp.status})`);
  await agent.get("/api/v1/auth/me");
  const cookies = (agent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
  const csrf = (cookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "";
  return { agent, csrf };
}

async function makeAlert(over?: { regionTags?: string[]; requireAckNote?: boolean }) {
  const rule = await prisma.notificationRule.create({
    data: {
      name: `${RULE_NAME}-${Math.random().toString(36).slice(2, 8)}`,
      enabled: false, // never let the engine act on a fixture
      severity: "critical",
      requireAckNote: over?.requireAckNote === true,
      trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" } as never,
      scope: {} as never,
      actions: [] as never,
    },
  });
  const notif = await prisma.notification.create({
    data: {
      ruleId: rule.id,
      assetHostname: "ACK-TEST-SWITCH",
      severity: "critical",
      message: "ACK-TEST-SWITCH is down",
      regionTags: over?.regionTags ?? [],
    },
  });
  return notif;
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  admin = await authedAgent(app);

  const adminRole = await prisma.role.findUnique({ where: { name: "admin" } });
  if (!adminRole) throw new Error("built-in 'admin' Role missing — run prisma migrate deploy on the test DB");
  const netRole = await prisma.role.findUnique({ where: { name: "networkadmin" } });
  if (!netRole) throw new Error("built-in 'networkadmin' Role missing — run prisma migrate deploy on the test DB");
  await upsertScopedUser(SCOPED_USERNAME, netRole.id);
  await upsertScopedUser(SCOPED_ADMIN_USERNAME, adminRole.id);
  scoped = await login(SCOPED_USERNAME, SCOPED_PASSWORD);
  scopedAdmin = await login(SCOPED_ADMIN_USERNAME, SCOPED_PASSWORD);
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.notification.deleteMany({ where: { assetHostname: "ACK-TEST-SWITCH" } });
  await prisma.notificationRule.deleteMany({ where: { name: { startsWith: RULE_NAME } } });
  await prisma.user.deleteMany({ where: { username: { in: [SCOPED_USERNAME, SCOPED_ADMIN_USERNAME] } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.notification.deleteMany({ where: { assetHostname: "ACK-TEST-SWITCH" } });
  await prisma.notificationRule.deleteMany({ where: { name: { startsWith: RULE_NAME } } });
});

d("GET /alerts/:id — the acknowledge page's read", () => {
  it("returns the alert with the flat ack-note policy and the rule name", async () => {
    const n = await makeAlert({ requireAckNote: true });
    const res = await admin.agent.get(`/api/v1/alerts/${n.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(n.id);
    expect(res.body.message).toBe("ACK-TEST-SWITCH is down");
    expect(res.body.assetHostname).toBe("ACK-TEST-SWITCH");
    expect(res.body.acknowledged).toBe(false);
    // Flat, so no surface has to fetch the automation to know how to ask.
    expect(res.body.requireAckNote).toBe(true);
    expect(res.body.ruleName).toContain(RULE_NAME);
    // Never leak the rule relation itself.
    expect(res.body.rule).toBeUndefined();
  });

  it("is gated — an anonymous caller gets nothing", async () => {
    const n = await makeAlert();
    const res = await request(app).get(`/api/v1/alerts/${n.id}`);
    expect(res.status).toBe(401);
  });

  it("404s an unknown id", async () => {
    const res = await admin.agent.get("/api/v1/alerts/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("404s — not 403s — an alert outside the caller's region scope", async () => {
    // A 403 would confirm the alert exists. The reader learns only that the
    // link goes nowhere they can go, which is what the page renders.
    const n = await makeAlert({ regionTags: ["south"] });
    const res = await scoped.agent.get(`/api/v1/alerts/${n.id}`);
    expect(res.status).toBe(404);

    // ...and an unscoped alert is still visible to the same caller, so the
    // above is the region predicate rather than a broken fixture.
    const shared = await makeAlert();
    expect((await scoped.agent.get(`/api/v1/alerts/${shared.id}`)).status).toBe(200);
  });

  it("does not region-scope an admin-equivalent caller — on the card or the list", async () => {
    // The Active Alerts widget is unscoped, so an admin who picked up a region
    // tag (user, role or SSO group) saw the alert there and then got "not here
    // any more" from its acknowledge card.
    const n = await makeAlert({ regionTags: ["south"] });
    const one = await scopedAdmin.agent.get(`/api/v1/alerts/${n.id}`);
    expect(one.status).toBe(200);
    expect(one.body.id).toBe(n.id);

    const list = await scopedAdmin.agent.get("/api/v1/alerts?search=ACK-TEST-SWITCH");
    expect(list.status).toBe(200);
    expect(list.body.notifications.map((r: { id: string }) => r.id)).toContain(n.id);

    // ...and the non-admin on the same region tag is still narrowed by it.
    const narrowed = await scoped.agent.get("/api/v1/alerts?search=ACK-TEST-SWITCH");
    expect(narrowed.body.notifications.map((r: { id: string }) => r.id)).not.toContain(n.id);

    const ack = await scopedAdmin.agent
      .post("/api/v1/alerts/acknowledge")
      .set("X-CSRF-Token", scopedAdmin.csrf)
      .send({ ids: [n.id] });
    expect(ack.status).toBe(200);
    expect(ack.body.acknowledged).toBe(1);
  });

  it("does not capture the sibling POST routes", async () => {
    const n = await makeAlert();
    const ack = await admin.agent
      .post("/api/v1/alerts/acknowledge")
      .set("X-CSRF-Token", admin.csrf)
      .send({ ids: [n.id] });
    expect(ack.status).toBe(200);
    expect(ack.body.acknowledged).toBe(1);
  });
});

d("POST /alerts/acknowledge — from the page", () => {
  it("records the caller, the note and the page's provenance", async () => {
    const n = await makeAlert();
    const res = await admin.agent
      .post("/api/v1/alerts/acknowledge")
      .set("X-CSRF-Token", admin.csrf)
      .send({ ids: [n.id], note: "replaced the SFP", source: "ack_page" });
    expect(res.status).toBe(200);

    const row = await prisma.notification.findUnique({ where: { id: n.id } });
    expect(row?.acknowledged).toBe(true);
    expect(row?.acknowledgeNote).toBe("replaced the SFP");
    expect(row?.acknowledgedBy).toBeTruthy();

    // The provenance reaches the audit log, which is the only reason it exists.
    const ev = await prisma.event.findFirst({
      where: { action: "notification.acknowledged" },
      orderBy: { timestamp: "desc" },
    });
    expect((ev?.details as Record<string, unknown>)?.source).toBe("ack_page");

    // And the page reads its own result back.
    const after = await admin.agent.get(`/api/v1/alerts/${n.id}`);
    expect(after.body.acknowledged).toBe(true);
    expect(after.body.acknowledgeNote).toBe("replaced the SFP");
  });

  it("refuses a source outside the closed set", async () => {
    // It lands in Event.details, so free text there would be a log-injection
    // surface, not a convenience.
    const n = await makeAlert();
    const res = await admin.agent
      .post("/api/v1/alerts/acknowledge")
      .set("X-CSRF-Token", admin.csrf)
      .send({ ids: [n.id], source: "totally-made-up" });
    expect(res.status).toBe(400);
    expect((await prisma.notification.findUnique({ where: { id: n.id } }))?.acknowledged).toBe(false);
  });

  it("refuses an empty note when the automation demands one", async () => {
    // Enforced by the WRITE, not by the page's `required` attribute — that is
    // what makes every acknowledge surface obey the same policy.
    const n = await makeAlert({ requireAckNote: true });
    const res = await admin.agent
      .post("/api/v1/alerts/acknowledge")
      .set("X-CSRF-Token", admin.csrf)
      .send({ ids: [n.id], note: "   ", source: "ack_page" });
    expect(res.status).toBe(400);
    expect((await prisma.notification.findUnique({ where: { id: n.id } }))?.acknowledged).toBe(false);

    const ok = await admin.agent
      .post("/api/v1/alerts/acknowledge")
      .set("X-CSRF-Token", admin.csrf)
      .send({ ids: [n.id], note: "stack rebooted", source: "ack_page" });
    expect(ok.status).toBe(200);
  });
});
