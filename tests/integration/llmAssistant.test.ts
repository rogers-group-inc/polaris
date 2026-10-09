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
      // Standing in for Azure AI Foundry (rule 95(j)): its paths, its api-key header.
      if (req.url?.startsWith("/openai/")) {
        if (req.headers["api-key"] !== "az-key" || req.headers.authorization) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end('{"error":{"code":"401","message":"Access denied due to invalid subscription key"}}');
          return;
        }
        const v1 = req.url === "/openai/v1/chat/completions" && JSON.parse(body || "{}").model === "fake-deployment";
        if (!v1 && !req.url.startsWith("/openai/deployments/fake-deployment/chat/completions?api-version=2024-10-21")) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end('{"error":{"code":"DeploymentNotFound","message":"The API deployment for this resource does not exist."}}');
          return;
        }
      }
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

d("llm integration — Azure AI Foundry provider (rule 95(j))", () => {
  const AZ = `${NAME} azure`;
  let azId = "";
  const azBody = (over: Record<string, unknown> = {}) => ({
    type: "llm",
    name: AZ,
    config: { provider: "azure", host: `http://127.0.0.1:${llmPort}/openai/v1`, allowLoopback: true, model: "fake-deployment", apiToken: "az-key", ...over },
  });

  it("refuses an Azure config without its deployment, key, Entra secret, or a valid api-version", async () => {
    const { agent, csrf } = await authedAgent(app);
    const post = (over: Record<string, unknown>) => agent.post("/api/v1/integrations").set("X-CSRF-Token", csrf).send(azBody(over));
    const noDeployment = await post({ model: "" });
    expect(noDeployment.status).toBe(400);
    expect(JSON.stringify(noDeployment.body)).toMatch(/Deployment name is required/);
    expect((await post({ apiToken: "" })).status).toBe(400);
    expect((await post({ azureAuth: "entra", tenantId: "t", clientId: "c" })).status).toBe(400);
    expect((await post({ azureApiShape: "deployments", azureApiVersion: "latest" })).status).toBe(400);
    expect(await prisma.integration.count({ where: { name: AZ } })).toBe(0);
  });

  it("splits a pasted endpoint, masks the key, and still mints the role + token", async () => {
    const { agent, csrf } = await authedAgent(app);
    const r = await agent.post("/api/v1/integrations").set("X-CSRF-Token", csrf).send(azBody());
    expect(r.status).toBe(201);
    azId = r.body.id;
    expect(r.body.llmAccess.rawToken).toMatch(/^polaris_/);
    expect(r.body.config).toMatchObject({ provider: "azure", host: "127.0.0.1", port: llmPort, useHttps: false, basePath: "", azureApiShape: "v1", azureAuth: "apiKey" });
    expect(r.body.config.apiToken).not.toBe("az-key");
  });

  it("Test Connection sends one chat round with the api-key header; a blank key on the form test uses the stored one", async () => {
    const { agent, csrf } = await authedAgent(app);
    const t = await agent.post(`/api/v1/integrations/${azId}/test`).set("X-CSRF-Token", csrf);
    expect(t.body).toMatchObject({ ok: true });
    expect(t.body.message).toMatch(/deployment "fake-deployment" answered/);
    const form = await agent.post("/api/v1/integrations/test").set("X-CSRF-Token", csrf).send({ ...azBody({ apiToken: "" }), id: azId });
    expect(form.body).toMatchObject({ ok: true });
    const wrong = await agent.post("/api/v1/integrations/test").set("X-CSRF-Token", csrf).send(azBody({ apiToken: "nope" }));
    expect(wrong.body.ok).toBe(false);
    expect(wrong.body.message).toMatch(/refused the API key/);
  });

  it("the legacy deployments shape, and a missing deployment named as such", async () => {
    const { agent, csrf } = await authedAgent(app);
    const legacy = await agent.post("/api/v1/integrations/test").set("X-CSRF-Token", csrf)
      .send(azBody({ azureApiShape: "deployments", azureApiVersion: "2024-10-21" }));
    expect(legacy.body).toMatchObject({ ok: true });
    const missing = await agent.post("/api/v1/integrations/test").set("X-CSRF-Token", csrf).send(azBody({ model: "nope" }));
    expect(missing.body.message).toMatch(/Deployment "nope" was not found/);
  });

  it("check-tools probes the deployment without listing models", async () => {
    const { agent, csrf } = await authedAgent(app);
    const r = await agent.post(`/api/v1/integrations/${azId}/llm/check-tools`).set("X-CSRF-Token", csrf);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ model: "fake-deployment", result: "yes" });
  });

  it("switching to Entra stores the client secret masked, and a blank secret on PUT keeps it", async () => {
    const { agent, csrf } = await authedAgent(app);
    const put = (config: Record<string, unknown>) => agent.put(`/api/v1/integrations/${azId}`).set("X-CSRF-Token", csrf).send({ config });
    const switched = await put({ azureAuth: "entra", tenantId: "contoso.onmicrosoft.com", clientId: "11111111-2222-3333-4444-555555555555", clientSecret: "sp-secret" });
    expect(switched.status).toBe(200);
    expect(switched.body.config.clientSecret).not.toBe("sp-secret");
    expect((await put({ clientSecret: "", temperature: 0.3 })).status).toBe(200);
    const row = (await prisma.integration.findUnique({ where: { id: azId } }))!.config as any;
    expect(row.clientSecret).toBe("sp-secret");
    expect(row.temperature).toBe(0.3);
    const g = await agent.get(`/api/v1/integrations/${azId}`);
    expect(JSON.stringify(g.body)).not.toContain("sp-secret");
    expect(JSON.stringify(g.body)).not.toContain("az-key");
  });

  it("an OpenAI-compatible row saved before Azure support keeps its verdict on a plain save", async () => {
    const { agent, csrf } = await authedAgent(app);
    const cfg = ((await prisma.integration.findUnique({ where: { id: integrationId } }))!.config as any);
    const legacy = { ...cfg, toolCheck: { model: "fake-model", result: "yes", at: new Date().toISOString() } };
    delete legacy.provider;
    delete legacy.azureApiShape;
    await prisma.integration.update({ where: { id: integrationId }, data: { config: legacy } });
    const put = await agent.put(`/api/v1/integrations/${integrationId}`).set("X-CSRF-Token", csrf).send({ config: { temperature: 0.25 } });
    expect(put.status).toBe(200);
    const after = (await prisma.integration.findUnique({ where: { id: integrationId } }))!.config as any;
    expect(after.provider).toBe("openai");
    expect(after.toolCheck).toMatchObject({ result: "yes" });
  });

  it("deleting it removes its token and role like any llm integration", async () => {
    const { agent, csrf } = await authedAgent(app);
    const cfg = ((await prisma.integration.findUnique({ where: { id: azId } }))!.config as any);
    expect((await agent.delete(`/api/v1/integrations/${azId}`).set("X-CSRF-Token", csrf)).status).toBeLessThan(300);
    expect(await prisma.role.count({ where: { id: cfg.roleId } })).toBe(0);
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

  it("Efficiency Advisor: saved per user, signs off a plain turn, the line stored apart from the answer (95(h))", async () => {
    const { agent, csrf } = await authedAgent(app);
    try {
      expect((await agent.get("/api/v1/assistant/status")).body.efficiencyAdvisor).toBe(false);
      const put = await agent.put("/api/v1/assistant/preferences").set("X-CSRF-Token", csrf).send({ efficiencyAdvisor: true });
      expect(put.body).toEqual({ efficiencyAdvisor: true });
      expect((await agent.get("/api/v1/assistant/status")).body.efficiencyAdvisor).toBe(true);
      expect((await agent.put("/api/v1/assistant/preferences").set("X-CSRF-Token", csrf).send({ efficiencyAdvisor: "yes" })).status).toBe(400);

      const c = await agent.post("/api/v1/assistant/conversations").set("X-CSRF-Token", csrf).send({ title: "IT-llm advisor" });
      const r = await agent.post(`/api/v1/assistant/conversations/${c.body.id}/messages`).set("X-CSRF-Token", csrf)
        .send({ content: "Report the switches", integrationId });
      const m = r.text.match(/event: signoff\ndata: (\{.*\})/);
      expect(m).not.toBeNull();
      const line = JSON.parse(m![1]).text as string;
      const g = await agent.get(`/api/v1/assistant/conversations/${c.body.id}`);
      expect(g.body.messages[1].signOff).toBe(line);
      expect(g.body.messages[1].content).not.toContain(line);

      // An outage question earns no line.
      const o = await agent.post(`/api/v1/assistant/conversations/${c.body.id}/messages`).set("X-CSRF-Token", csrf)
        .send({ content: "Report the down switches", integrationId });
      expect(o.text).not.toMatch(/event: signoff/);
    } finally {
      await agent.put("/api/v1/assistant/preferences").set("X-CSRF-Token", csrf).send({ efficiencyAdvisor: false });
    }
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
