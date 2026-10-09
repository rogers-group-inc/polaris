/**
 * tests/integration/proxmoxIntegration.test.ts — the Proxmox VE integration's
 * routes against a real database. Pins:
 *   - create validates the token ID shape and runs the SSRF guard over EVERY
 *     address (host + fallbackHosts), and defaults port 8006;
 *   - the token secret is sealed at rest and masked on read; an edit that
 *     echoes the mask back keeps the stored secret;
 *   - an edit cannot smuggle a blocked fallback address or a malformed token
 *     ID past the loose update schema;
 *   - the Query API refuses a path off the read allow-list before any call.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { afterAll, beforeAll, expect, it, vi } from "vitest";

// Secrets are sealed only when a key is configured — give this file one
// before the app (and secretBox, which reads it once) loads.
vi.hoisted(() => { process.env.POLARIS_SECRET_KEY ||= "ab".repeat(32); });

import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const NAME = "IT proxmox";

const base = () => ({
  type: "proxmox",
  name: NAME,
  autoDiscover: false,
  config: {
    host: "10.250.9.1",
    fallbackHosts: ["10.250.9.2"],
    verifyTls: false,
    apiTokenId: "polaris@pve!monitor",
    apiToken: "0f3c0c3e-1111-2222-3333-444455556666",
  },
});

async function cleanup(): Promise<void> {
  await prisma.integration.deleteMany({ where: { name: { startsWith: NAME } } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await ensureTestUser();
  await cleanup();
});
afterAll(async () => { if (dbReachable) await cleanup(); });

d("Proxmox integration routes", () => {
  it("creates one, defaulting port 8006, sealing the secret at rest and masking it on read", async () => {
    const { agent, csrf } = await authedAgent(app);
    const created = await agent.post("/api/v1/integrations").set("X-CSRF-Token", csrf).send(base());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;

    const row = await prisma.$queryRaw<Array<{ config: Record<string, unknown> }>>`SELECT config FROM integrations WHERE id = ${id}`;
    const raw = row[0]!.config;
    expect(raw.port).toBe(8006);
    expect(raw.apiTokenId).toBe("polaris@pve!monitor");
    expect(raw.apiToken).not.toBe("0f3c0c3e-1111-2222-3333-444455556666");

    const got = await agent.get(`/api/v1/integrations/${id}`);
    expect(got.status).toBe(200);
    expect(got.body.config.apiToken).not.toContain("0f3c0c3e");
    expect(got.body.config.fallbackHosts).toEqual(["10.250.9.2"]);

    // An edit that echoes the mask back keeps the real secret.
    const put = await agent.put(`/api/v1/integrations/${id}`).set("X-CSRF-Token", csrf)
      .send({ config: { ...got.body.config, fallbackHosts: ["10.250.9.3"] } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const after = await prisma.integration.findUnique({ where: { id }, select: { config: true } });
    expect((after!.config as Record<string, unknown>).apiToken).toBe("0f3c0c3e-1111-2222-3333-444455556666");
    expect((after!.config as Record<string, unknown>).fallbackHosts).toEqual(["10.250.9.3"]);
  });

  it("refuses a malformed token ID and a blocked address anywhere in the list", async () => {
    const { agent, csrf } = await authedAgent(app);
    const badToken = base();
    badToken.config.apiTokenId = "root@pam";
    expect((await agent.post("/api/v1/integrations").set("X-CSRF-Token", csrf).send({ ...badToken, name: `${NAME} t` })).status).toBe(400);

    const badFallback = base();
    badFallback.config.fallbackHosts = ["10.250.9.2", "169.254.169.254"];
    const r = await agent.post("/api/v1/integrations").set("X-CSRF-Token", csrf).send({ ...badFallback, name: `${NAME} f` });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/blocked range/);
  });

  it("refuses the same on an edit, which the loose update schema would otherwise let through", async () => {
    const { agent, csrf } = await authedAgent(app);
    const created = await agent.post("/api/v1/integrations").set("X-CSRF-Token", csrf).send({ ...base(), name: `${NAME} e` });
    const id = created.body.id as string;
    const blocked = await agent.put(`/api/v1/integrations/${id}`).set("X-CSRF-Token", csrf)
      .send({ config: { fallbackHosts: ["127.0.0.1"] } });
    expect(blocked.status).toBe(400);
    const badId = await agent.put(`/api/v1/integrations/${id}`).set("X-CSRF-Token", csrf)
      .send({ config: { apiTokenId: "not a token id" } });
    expect(badId.status).toBe(400);
  });

  it("refuses a Query API path off the read allow-list", async () => {
    const { agent, csrf } = await authedAgent(app);
    const created = await agent.post("/api/v1/integrations").set("X-CSRF-Token", csrf).send({ ...base(), name: `${NAME} q` });
    const r = await agent.post(`/api/v1/integrations/${created.body.id}/query`).set("X-CSRF-Token", csrf)
      .send({ path: "/access/users" });
    expect(r.status).toBe(400);
    expect(r.body.error ?? r.body.message).toMatch(/Not an allowed read path/);
  });
});
