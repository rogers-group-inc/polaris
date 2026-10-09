/**
 * tests/integration/genericApiRoutes.test.ts — the Generic API integration's
 * route contract (business rule 99) against a real database:
 *   - create validates the whole config: an unmapped identity field, a path
 *     that does not parse, a request path naming another host, a blocked
 *     host or token URL, and an injecting header are all 400s;
 *   - secrets come back masked, and an edit that leaves them blank keeps them;
 *   - an EDIT is validated as strictly as a create (the loose update schema
 *     would otherwise let any of the above in);
 *   - Preview refuses a bad config before making a request.
 * No outbound request reaches a real host: every case here is refused or
 * answered before the transport.
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const NAME = "IT generic api";

async function cleanup(): Promise<void> {
  await prisma.integration.deleteMany({ where: { name: { startsWith: NAME } } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await ensureTestUser();
  await cleanup();
});
afterAll(async () => { if (dbReachable) await cleanup(); });

const config = (over: Record<string, unknown> = {}) => ({
  host: "inventory.example.com",
  path: "/api/devices",
  authType: "bearer",
  apiToken: "s3cr3t-token",
  recordsPath: "data",
  fieldMap: { id: "id", hostname: "name" },
  ...over,
});
const body = (over: Record<string, unknown> = {}) => ({ type: "genericapi", name: NAME, config: config(over) });

d("Generic API integration — create / edit validation", () => {
  it("refuses a config that could not discover safely", async () => {
    const { agent, csrf } = await authedAgent(app);
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["unmapped identity", { fieldMap: { hostname: "name" } }, /identity field \(id\)/],
      ["unparseable path", { fieldMap: { id: "id", hostname: "nics[" } }, /hostname path/],
      ["path naming another host", { path: "//evil.example/x" }, /single/],
      ["blocked host", { host: "169.254.169.254" }, /blocked range/],
      ["host with a path", { host: "inventory.example.com/api" }, /name or an address only/],
      ["blocked token URL", { authType: "oauth2", tokenUrl: "http://127.0.0.1/token" }, /blocked range/],
      ["injecting header", { headers: [{ name: "X-A", value: "a\r\nHost: evil" }] }, /line breaks/],
      ["bad POST body", { method: "POST", body: "{nope" }, /not valid JSON/],
    ];
    for (const [label, over, msg] of cases) {
      const r = await agent.post("/api/v1/integrations").set("X-CSRF-Token", csrf).send(body(over));
      expect(r.status, label).toBe(400);
      expect(JSON.stringify(r.body), label).toMatch(msg);
    }
    expect(await prisma.integration.count({ where: { name: NAME } })).toBe(0);
  });

  it("creates, masks the secret, keeps it across an edit that leaves it blank, and validates the edit", async () => {
    const { agent, csrf } = await authedAgent(app);
    const created = await agent.post("/api/v1/integrations").set("X-CSRF-Token", csrf).send(body());
    expect(created.status).toBe(201);
    expect(created.body.type).toBe("genericapi");
    expect(created.body.config.apiToken).not.toBe("s3cr3t-token");
    const id = created.body.id as string;

    // An edit without the secret keeps it (and the stored copy is sealed —
    // reading it back through Prisma opens it).
    const edited = await agent.put(`/api/v1/integrations/${id}`).set("X-CSRF-Token", csrf)
      .send({ config: config({ apiToken: "", recordsPath: "items" }) });
    expect(edited.status).toBe(200);
    const stored = (await prisma.integration.findUnique({ where: { id } }))!.config as Record<string, unknown>;
    expect(stored.apiToken).toBe("s3cr3t-token");
    expect(stored.recordsPath).toBe("items");

    // The update path is validated like a create: un-mapping the identity, or
    // smuggling in a blocked host, is refused and nothing changes.
    const unmapped = await agent.put(`/api/v1/integrations/${id}`).set("X-CSRF-Token", csrf)
      .send({ config: { fieldMap: { hostname: "name" } } });
    expect(unmapped.status).toBe(400);
    const blocked = await agent.put(`/api/v1/integrations/${id}`).set("X-CSRF-Token", csrf)
      .send({ config: { host: "127.0.0.1" } });
    expect(blocked.status).toBe(400);
    const after = (await prisma.integration.findUnique({ where: { id } }))!.config as Record<string, any>;
    expect(after.fieldMap.id).toBe("id");
    expect(after.host).toBe("inventory.example.com");
  });
});

d("Generic API integration — Preview", () => {
  it("refuses an invalid config with a 400 and answers a blocked host without a request", async () => {
    const { agent, csrf } = await authedAgent(app);
    const bad = await agent.post("/api/v1/integrations/generic-api/preview").set("X-CSRF-Token", csrf)
      .send({ config: config({ fieldMap: {} }) });
    expect(bad.status).toBe(400);
    const blocked = await agent.post("/api/v1/integrations/generic-api/preview").set("X-CSRF-Token", csrf)
      .send({ config: config({ host: "localhost" }) });
    expect(blocked.status).toBe(400);
  });
});
