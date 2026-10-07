/**
 * tests/integration/llmAssistant.test.ts — the `llm` integration and the AI
 * assistant end to end against a real database (business rule 95):
 *   - creating an llm integration mints a read-only `llm-*` role + API token,
 *     returns the raw token once, refuses a caller without roles + apiTokens
 *     write, and enforces the loopback-only host exception (95(f), 95(g));
 *   - the minted token reads inventory and cannot write, read credentials, or
 *     drive the assistant; regenerate replaces it; delete removes token + role;
 *   - the integration is never discoverable and a PUT cannot spoof roleId;
 *   - a streamed turn against a fake OpenAI-compatible server runs a tool as
 *     the caller, streams text, stores the answer and a DB-sourced report;
 *   - conversations are owner-only (95(d)).
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";
import { createToken } from "../../src/services/apiTokenService.js";
import { createRole } from "../../src/services/roleService.js";

const d = dbDescribe;
const NAME = "IT llm assistant";
const WEAK_ROLE = "it-llm-integrations-only";
const ASSET = "it-llm-down-switch";

let llmServer: http.Server;
let llmPort = 0;
let weakToken = "";
let integrationId = "";
let rawToken = "";
let roleId = "";

// A fake OpenAI-compatible model server: /v1/models lists one model; the
// first chat round asks for list_assets, the second answers in two deltas.
function startFakeLlm(): Promise<void> {
  llmServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "fake-model" }] }));
        return;
      }
      const j = JSON.parse(body || "{}");
      const hasToolResult = (j.messages || []).some((m: any) => m.role === "tool");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (j.tools?.some((t: any) => t.function?.name === "polaris_probe")) {
        // The tool-calling check (llmService.probeToolCalling).
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "p1", function: { name: "polaris_probe", arguments: '{"ok":true}' } }] }, finish_reason: "tool_calls" }] });
      } else if (!hasToolResult && j.tools?.length) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "create_report", arguments: JSON.stringify({ title: "Down switches", source: "list_assets", args: { search: ASSET } }) } }] }, finish_reason: "tool_calls" }] });
      } else {
        send({ choices: [{ delta: { content: "One switch " } }] });
        send({ choices: [{ delta: { content: "is down." }, finish_reason: "stop" }] });
      }
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((r) => llmServer.listen(0, "127.0.0.1", () => { llmPort = (llmServer.address() as AddressInfo).port; r(); }));
}

async function cleanup(): Promise<void> {
  const rows = await prisma.integration.findMany({ where: { name: { startsWith: NAME } }, select: { id: true, config: true } });
  for (const r of rows) {
    const c = r.config as Record<string, unknown>;
    if (typeof c.tokenId === "string") await prisma.apiToken.deleteMany({ where: { id: c.tokenId } });
    if (typeof c.roleId === "string") await prisma.role.deleteMany({ where: { id: c.roleId } });
  }
  await prisma.integration.deleteMany({ where: { name: { startsWith: NAME } } });
  await prisma.apiToken.deleteMany({ where: { name: WEAK_ROLE } });
  await prisma.role.deleteMany({ where: { name: WEAK_ROLE } });
  await prisma.asset.deleteMany({ where: { hostname: ASSET } });
  await prisma.assistantConversation.deleteMany({ where: { title: { startsWith: "IT-llm" } } });
  await prisma.user.deleteMany({ where: { username: "it-llm-other" } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await ensureTestUser();
  await cleanup();
  await startFakeLlm();
  const weak = await createRole({ name: WEAK_ROLE, permissions: { integrations: "write" } });
  weakToken = (await createToken({ name: WEAK_ROLE, roleId: weak.id, createdBy: "integration-test" })).rawToken;
  // monitored: false — the app's boot-time monitor pass would otherwise flip
  // an IP-less monitored asset to "warning" ("Asset has no IP address")
  // before the report reads it. The report only needs the stored status.
  await prisma.asset.create({ data: { hostname: ASSET, assetType: "switch", status: "active", monitored: false, monitorStatus: "down", model: "FS-148F" } as never });
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await new Promise<void>((r) => llmServer.close(() => r()));
});

const llmBody = (over: Record<string, unknown> = {}) => ({
  type: "llm",
  name: NAME,
  config: { host: "10.250.0.9", port: 11434, model: "fake-model", ...over },
});

d("llm integration — provisioning (rule 95(f))", () => {
  it("refuses a caller without roles + apiTokens write, writing nothing", async () => {
    const r = await request(app).post("/api/v1/integrations").set("Authorization", `Bearer ${weakToken}`).send(llmBody());
    expect(r.status).toBe(403);
    expect(await prisma.integration.count({ where: { name: NAME } })).toBe(0);
  });

  it("refuses a loopback host unless Allow loopback is ticked", async () => {
    const { agent, csrf } = await authedAgent(app);
    const r = await agent.post("/api/v1/integrations").set("X-CSRF-Token", csrf).send(llmBody({ host: "127.0.0.1" }));
    expect(r.status).toBe(400);
    const meta = await agent.post("/api/v1/integrations").set("X-CSRF-Token", csrf).send(llmBody({ host: "169.254.169.254", allowLoopback: true }));
    expect(meta.status).toBe(400);
  });

  it("creates the integration, a read-only role and a token shown once", async () => {
    const { agent, csrf } = await authedAgent(app);
    const r = await agent.post("/api/v1/integrations").set("X-CSRF-Token", csrf)
      .send(llmBody({ host: "127.0.0.1", port: llmPort, allowLoopback: true, apiToken: "sk-local" }));
    expect(r.status).toBe(201);
    expect(r.body.autoDiscover).toBe(false);
    expect(r.body.llmAccess.rawToken).toMatch(/^polaris_/);
    expect(r.body.config.apiToken).not.toBe("sk-local");
    integrationId = r.body.id;
    rawToken = r.body.llmAccess.rawToken;
    roleId = r.body.config.roleId;
    const role = await prisma.role.findUnique({ where: { id: roleId } });
    const perms = role!.permissions as Record<string, string>;
    expect(role!.name).toMatch(/^llm-/);
    expect(perms.assets).toBe("read");
    expect(perms.credentials).toBe("none");
    expect(perms.users).toBe("none");
    expect(Object.values(perms).every((v) => v === "read" || v === "none")).toBe(true);
    // GET never hands the raw token back.
    const g = await agent.get(`/api/v1/integrations/${integrationId}`);
    expect(JSON.stringify(g.body)).not.toContain(rawToken);
  });

  it("the minted token reads inventory but cannot write, read secrets, or use the assistant", async () => {
    const bearer = { Authorization: `Bearer ${rawToken}` };
    expect((await request(app).get("/api/v1/assets").set(bearer)).status).toBe(200);
    expect((await request(app).post("/api/v1/blocks").set(bearer).send({ name: "x", cidr: "10.99.0.0/16" })).status).toBe(403);
    expect((await request(app).get("/api/v1/credentials").set(bearer)).status).toBe(403);
    expect((await request(app).get("/api/v1/assistant/status").set(bearer)).status).toBe(403);
  });

  it("is never discoverable, and a PUT cannot repoint its role", async () => {
    const { agent, csrf } = await authedAgent(app);
    expect((await agent.post(`/api/v1/integrations/${integrationId}/discover`).set("X-CSRF-Token", csrf)).status).toBe(400);
    const put = await agent.put(`/api/v1/integrations/${integrationId}`).set("X-CSRF-Token", csrf)
      .send({ config: { roleId: "00000000-0000-0000-0000-000000000000", autoDiscover: true, temperature: 0.5 } });
    expect(put.status).toBe(200);
    const row = await prisma.integration.findUnique({ where: { id: integrationId } });
    expect((row!.config as any).roleId).toBe(roleId);
    expect((row!.config as any).temperature).toBe(0.5);
    expect((row!.config as any).apiToken).toBe("sk-local"); // blank on PUT keeps the stored key
    expect(row!.autoDiscover).toBe(false);
  });

  it("Test Connection finds the model on the fake server", async () => {
    const { agent, csrf } = await authedAgent(app);
    const r = await agent.post(`/api/v1/integrations/${integrationId}/test`).set("X-CSRF-Token", csrf);
    expect(r.body).toMatchObject({ ok: true });
  });

  it("regenerate replaces the token", async () => {
    const { agent, csrf } = await authedAgent(app);
    const r = await agent.post(`/api/v1/integrations/${integrationId}/llm/regenerate-token`).set("X-CSRF-Token", csrf);
    expect(r.status).toBe(200);
    expect(r.body.rawToken).not.toBe(rawToken);
    expect((await request(app).get("/api/v1/assets").set("Authorization", `Bearer ${rawToken}`)).status).toBe(401);
    rawToken = r.body.rawToken;
    expect((await request(app).get("/api/v1/assets").set("Authorization", `Bearer ${rawToken}`)).status).toBe(200);
  });

  it("check-tools stamps the verdict; a PUT keeps it, cannot forge it, and drops it when the model moves", async () => {
    const { agent, csrf } = await authedAgent(app);
    const r = await agent.post(`/api/v1/integrations/${integrationId}/llm/check-tools`).set("X-CSRF-Token", csrf);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ model: "fake-model", result: "yes" });
    const stamped = async () => ((await prisma.integration.findUnique({ where: { id: integrationId } }))!.config as any).toolCheck;
    expect(await stamped()).toMatchObject({ model: "fake-model", result: "yes" });
    expect(await prisma.event.count({ where: { action: "integration.llm.tool_check", resourceId: integrationId } })).toBeGreaterThan(0);

    const put = (config: Record<string, unknown>) => agent.put(`/api/v1/integrations/${integrationId}`).set("X-CSRF-Token", csrf).send({ config });
    expect((await put({ temperature: 0.4, toolCheck: { model: "x", result: "no" } })).status).toBe(200);
    expect(await stamped()).toMatchObject({ model: "fake-model", result: "yes" });
    expect((await put({ model: "other-model" })).status).toBe(200);
    expect(await stamped()).toBeUndefined();
    expect((await put({ model: "fake-model" })).status).toBe(200);

    const other = await agent.post(`/api/v1/integrations/${integrationId.replace(/.$/, (c) => (c === "0" ? "1" : "0"))}/llm/check-tools`).set("X-CSRF-Token", csrf);
    expect(other.status).toBe(404);
  });

  it("stores the context window, and refuses one below 2048 tokens", async () => {
    const { agent, csrf } = await authedAgent(app);
    const put = (contextWindow: number) => agent.put(`/api/v1/integrations/${integrationId}`).set("X-CSRF-Token", csrf).send({ config: { contextWindow } });
    expect((await put(16384)).status).toBe(200);
    expect(((await prisma.integration.findUnique({ where: { id: integrationId } }))!.config as any).contextWindow).toBe(16384);
    expect((await put(1000)).status).toBe(400);
  });
});

d("the assistant (rule 95(a), (c), (d))", () => {
  let convId = "";

  it("reports the enabled integration by name and model only", async () => {
    const { agent } = await authedAgent(app);
    const r = await agent.get("/api/v1/assistant/status");
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    const mine = r.body.integrations.find((i: any) => i.id === integrationId);
    // Names only — never config. No Assistant name was set, so the default.
    expect(mine).toEqual({ id: integrationId, name: NAME, model: "fake-model", displayName: "Assistant" });
  });

  it("streams a turn: tool as the caller, text, a DB-sourced report, all stored", async () => {
    const { agent, csrf } = await authedAgent(app);
    const c = await agent.post("/api/v1/assistant/conversations").set("X-CSRF-Token", csrf).send({ title: "IT-llm turn" });
    expect(c.status).toBe(201);
    convId = c.body.id;
    const r = await agent.post(`/api/v1/assistant/conversations/${convId}/messages`).set("X-CSRF-Token", csrf)
      .send({ content: "Report the down switches", integrationId });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/event-stream/);
    const text = r.text;
    expect(text).toMatch(/event: start/);
    expect(text).toMatch(/event: tool\ndata: \{"name":"create_report"/);
    expect(text).toMatch(/event: report/);
    // Text written after a report is held and released whole, table-stripped
    // (rule 95(c) — the model has not seen the rows), not streamed piecemeal.
    expect(text).toMatch(/event: token\ndata: \{"text":"One switch is down\."\}/);
    expect(text).toMatch(/event: done/);

    const g = await agent.get(`/api/v1/assistant/conversations/${convId}`);
    expect(g.body.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    const answer = g.body.messages[1];
    expect(answer.content).toBe("One switch is down.");
    expect(answer.toolsUsed[0]).toMatchObject({ name: "create_report", ok: true });
    expect(answer.reports[0].rows).toEqual([expect.objectContaining({ hostname: ASSET, monitorStatus: "down", model: "FS-148F" })]);
  });

  it("someone else's conversation is a 404, not a 403", async () => {
    const readonly = await prisma.role.findUnique({ where: { name: "readonly" } });
    const other = await prisma.user.upsert({
      where: { username: "it-llm-other" },
      create: { username: "it-llm-other", passwordHash: "x", roleId: readonly!.id },
      update: {},
    });
    const foreign = await prisma.assistantConversation.create({ data: { userId: other.id, title: "IT-llm foreign" } });
    const { agent, csrf } = await authedAgent(app);
    expect((await agent.get(`/api/v1/assistant/conversations/${foreign.id}`)).status).toBe(404);
    expect((await agent.delete(`/api/v1/assistant/conversations/${foreign.id}`).set("X-CSRF-Token", csrf)).status).toBe(404);
    expect(await prisma.assistantConversation.count({ where: { id: foreign.id } })).toBe(1);
  });

  it("/clear empties the thread and keeps it", async () => {
    const { agent, csrf } = await authedAgent(app);
    expect((await agent.delete(`/api/v1/assistant/conversations/${convId}/messages`).set("X-CSRF-Token", csrf)).status).toBe(204);
    const g = await agent.get(`/api/v1/assistant/conversations/${convId}`);
    expect(g.body.messages).toEqual([]);
  });

  it("conversation retention is saved, audited, and range-checked", async () => {
    const { agent, csrf } = await authedAgent(app);
    const before = (await agent.get("/api/v1/assistant/status")).body.retentionDays;
    const next = before === 45 ? 46 : 45;
    const put = (retentionDays: number) => agent.put("/api/v1/assistant/settings").set("X-CSRF-Token", csrf).send({ retentionDays });
    try {
      expect((await put(next)).body).toEqual({ retentionDays: next });
      expect((await agent.get("/api/v1/assistant/status")).body.retentionDays).toBe(next);
      const ev = await prisma.event.findFirst({ where: { action: "assistant.settings.updated" }, orderBy: { timestamp: "desc" } });
      expect(ev?.message).toContain(`to ${next} days`);
      expect((await put(0)).status).toBe(400);
    } finally {
      await put(before);
    }
  });

  it("the audit Event names the lookup, never the question", async () => {
    const ev = await prisma.event.findFirst({ where: { action: "assistant.chat", resourceId: integrationId }, orderBy: { timestamp: "desc" } });
    expect(ev?.message).toMatch(/create_report/);
    expect(JSON.stringify(ev)).not.toContain("Report the down switches");
  });
});

d("llm integration — delete (rule 95(f))", () => {
  it("removes the token and the role", async () => {
    const { agent, csrf } = await authedAgent(app);
    const row = await prisma.integration.findUnique({ where: { id: integrationId } });
    const tokenId = (row!.config as any).tokenId;
    expect((await agent.delete(`/api/v1/integrations/${integrationId}`).set("X-CSRF-Token", csrf)).status).toBe(204);
    expect(await prisma.apiToken.count({ where: { id: tokenId } })).toBe(0);
    expect(await prisma.role.count({ where: { id: roleId } })).toBe(0);
    expect((await request(app).get("/api/v1/assets").set("Authorization", `Bearer ${rawToken}`)).status).toBe(401);
  });
});
