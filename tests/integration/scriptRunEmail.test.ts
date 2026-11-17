/**
 * tests/integration/scriptRunEmail.test.ts — business rule 190 end to end
 * through the real app: POST /api/v1/script-runs/self/email sits above
 * requireAuth, needs no CSRF token (Bearer pass), answers loopback only,
 * refuses a body that names recipients, and sends to the run's snapshot. Save
 * refuses an agent-run script with email and a non-email channel; deleting a
 * channel a script action emails through is refused (rule 167); a Scripts-tab
 * test run with an email channel emails the tester alone.
 * The transport is mocked — nothing leaves the machine.
 */

import { it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";

const mocks = vi.hoisted(() => ({ send: vi.fn(async () => undefined) }));
vi.mock("../../src/services/notificationDeliveryService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendEmailThroughChannel: mocks.send,
}));

import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { issueRunEmailPass } from "../../src/services/scriptRunEmailService.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const PFX = "rule190-test";
const URL = "/api/v1/script-runs/self/email";
let emailChannelId = "";
let chatChannelId = "";
let scriptId = "";
let agentScriptId = "";

async function runningRun(extra: Record<string, unknown> = {}): Promise<{ id: string; pass: string }> {
  const r = await prisma.automationScriptRun.create({
    data: {
      scriptId, scriptName: PFX, sha256: "x", runOn: "server", timeoutSec: 60, status: "running",
      startedAt: new Date(), requestedBy: "system:automation",
      emailChannelIds: [emailChannelId], emailTo: ["certs@example.invalid"], ...extra,
    },
  });
  return { id: r.id, pass: await issueRunEmailPass(r.id) };
}

beforeAll(async () => {
  if (!dbReachable) return;
  await ensureTestUser();
  emailChannelId = (await prisma.notificationChannel.create({ data: { name: `${PFX} smtp`, type: "smtp", enabled: true, config: { host: "relay.example.invalid" } } })).id;
  chatChannelId = (await prisma.notificationChannel.create({ data: { name: `${PFX} slack`, type: "slack", enabled: true, config: {} } })).id;
  const mk = (name: string, runTarget: string) => prisma.automationScript.create({
    data: { name: `${PFX}-${name}`, interpreter: "bash", body: "echo hi", sha256: "x", runTarget, timeoutSec: 30, enabled: true, createdBy: "test" },
  });
  scriptId = (await mk("server", "server")).id;
  agentScriptId = (await mk("agent", "agent")).id;
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.notificationRule.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.automationScriptRun.deleteMany({ where: { scriptId: { in: [scriptId, agentScriptId] } } });
  await prisma.automationScript.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.notificationChannel.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.event.deleteMany({ where: { resourceName: { startsWith: PFX } } });
});

d("rule 190 — POST /script-runs/self/email", () => {
  it("sends with the run's pass alone — no session, no CSRF token — to the run's recipients", async () => {
    mocks.send.mockClear();
    const { pass } = await runningRun();
    const res = await request(app).post(URL).set("Authorization", `Bearer ${pass}`)
      .send({ subject: "Cert renewed", text: "new cert", files: [{ filename: "intranet.pem", contentType: "application/x-pem-file", contentBase64: Buffer.from("PEM").toString("base64") }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: 1, remaining: 2 });
    const msg = (mocks.send.mock.calls[0] as unknown as [unknown, Record<string, any>])[1];
    expect(msg.to).toEqual(["certs@example.invalid"]);
    expect(msg.files[0].filename).toBe("intranet.pem");
  });

  it("answers 401 with the pass message (the route is reached above requireAuth) for no pass or a finished run", async () => {
    const none = await request(app).post(URL).send({ subject: "s", text: "" });
    expect(none.status).toBe(401);
    expect(none.body.error).toMatch(/email pass/);
    const { id, pass } = await runningRun();
    await prisma.automationScriptRun.update({ where: { id }, data: { status: "succeeded" } });
    const done = await request(app).post(URL).set("Authorization", `Bearer ${pass}`).send({ subject: "s", text: "" });
    expect(done.status).toBe(401);
  });

  it("refuses a body that names its own recipients", async () => {
    const { pass } = await runningRun();
    const res = await request(app).post(URL).set("Authorization", `Bearer ${pass}`)
      .send({ subject: "s", text: "", to: ["attacker@example.invalid"] });
    expect(res.status).toBe(400);
  });

  it("refuses a caller that is not on the Polaris host", async () => {
    const { pass } = await runningRun();
    const prev = app.get("trust proxy");
    app.set("trust proxy", 1);
    try {
      const res = await request(app).post(URL).set("Authorization", `Bearer ${pass}`)
        .set("X-Forwarded-For", "203.0.113.9").send({ subject: "s", text: "" });
      expect(res.status).toBe(403);
    } finally {
      app.set("trust proxy", prev);
    }
  });

  it("stops at three emails per run", async () => {
    const { pass } = await runningRun({ emailsSent: 3 });
    const res = await request(app).post(URL).set("Authorization", `Bearer ${pass}`).send({ subject: "s", text: "" });
    expect(res.status).toBe(429);
  });
});

d("rule 190 — saving and deleting", () => {
  const rule = (name: string, action: Record<string, unknown>) => ({
    name: `${PFX}-${name}`, enabled: false, severity: "informational",
    trigger: { type: "event", actionPattern: "path_check.tls_cert_changed" },
    scope: { allAssets: true }, reset: { mode: "timed", afterSec: 3600 },
    actions: [action],
  });

  it("refuses email on an agent-run script, through a non-email channel or with no To; saves a server one", async () => {
    const { agent, csrf } = await authedAgent(app);
    const onAgent = await agent.post("/api/v1/automations").set("X-CSRF-Token", csrf)
      .send(rule("agent", { type: "script", scriptId: agentScriptId, runOn: "agent", email: { channelId: emailChannelId, addresses: ["a@example.invalid"] } }));
    expect(onAgent.status).toBe(400);
    expect(onAgent.body.error).toMatch(/Polaris server can send email/);
    const viaChat = await agent.post("/api/v1/automations").set("X-CSRF-Token", csrf)
      .send(rule("chat", { type: "script", scriptId, runOn: "server", email: { channelId: chatChannelId, addresses: ["a@example.invalid"] } }));
    expect(viaChat.status).toBe(400);
    expect(viaChat.body.error).toMatch(/must be an email channel/);
    const ok = await agent.post("/api/v1/automations").set("X-CSRF-Token", csrf)
      .send(rule("ok", { type: "script", scriptId, runOn: "server", email: { channelId: emailChannelId, addresses: ["a@example.invalid"] } }));
    expect(ok.status).toBe(201);
    // Rule 190(a): the Notify picker's shape — a To is required, Cc alone is not one.
    const ccOnly = await agent.post("/api/v1/automations").set("X-CSRF-Token", csrf)
      .send(rule("cc-only", { type: "script", scriptId, runOn: "server", email: { channelIds: [emailChannelId], cc: { addresses: ["a@example.invalid"] } } }));
    expect(ccOnly.status).toBe(400);
    expect(ccOnly.body.error).toMatch(/at least one To recipient/);
    const picker = await agent.post("/api/v1/automations").set("X-CSRF-Token", csrf)
      .send(rule("picker", { type: "script", scriptId, runOn: "server", email: {
        channelIds: [emailChannelId], recipientDeviceRegionLevels: [1], cc: { addresses: ["audit@example.invalid"] },
      } }));
    expect(picker.status).toBe(201);
  });

  it("refuses to delete a channel a script action emails through (rule 167)", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.delete(`/api/v1/delivery-channels/${emailChannelId}`).set("X-CSRF-Token", csrf);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain(`${PFX}-ok`);
  });

  it("a test run with an email channel emails the signed-in tester only", async () => {
    const { agent, csrf } = await authedAgent(app);
    const me = await prisma.user.findFirst({ where: { username: (await agent.get("/api/v1/auth/me")).body.username } });
    const before = me!.email;
    await prisma.user.update({ where: { id: me!.id }, data: { email: "tester@example.invalid" } });
    try {
      const res = await agent.post(`/api/v1/automations/scripts/${scriptId}/test-run`).set("X-CSRF-Token", csrf)
        .send({ args: "dry_run=1", emailChannelId });
      expect(res.status).toBe(202);
      const run = await prisma.automationScriptRun.findUnique({ where: { id: res.body.runId } });
      expect(run).toMatchObject({ emailChannelIds: [emailChannelId], emailTo: ["tester@example.invalid"], emailCc: [], emailBcc: [] });
    } finally {
      await prisma.user.update({ where: { id: me!.id }, data: { email: before } });
    }
  });
});
