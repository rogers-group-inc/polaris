/**
 * tests/integration/blocks.test.ts
 *
 * Integration tests for POST|GET|PUT|DELETE /api/v1/blocks. Skips cleanly
 * when DATABASE_URL isn't reachable; see tests/integration/_helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser, waitForEventCount } from "./_helpers.js";

const d = dbDescribe;

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  // Wipe in dependency order — reservations FK to subnets FK to blocks.
  await prisma.reservation.deleteMany();
  await prisma.subnet.deleteMany();
  await prisma.ipBlock.deleteMany();
});

// ─── POST /api/v1/blocks ──────────────────────────────────────────────────────

d("POST /api/v1/blocks", () => {
  it("creates a block and returns 201", async () => {
    const { agent, csrf } = await authedAgent(app);
    const resp = await agent
      .post("/api/v1/blocks")
      .set("X-CSRF-Token", csrf)
      .send({ name: "Test Block", cidr: "10.20.0.0/16", description: "test" });
    expect(resp.status).toBe(201);
    expect(resp.body.cidr).toBe("10.20.0.0/16");
    expect(resp.body.ipVersion).toBe("v4");
  });

  it("normalizes the CIDR (zeros host bits) on create", async () => {
    const { agent, csrf } = await authedAgent(app);
    const resp = await agent
      .post("/api/v1/blocks")
      .set("X-CSRF-Token", csrf)
      .send({ name: "Sloppy CIDR", cidr: "10.30.5.7/16" });
    expect(resp.status).toBe(201);
    expect(resp.body.cidr).toBe("10.30.0.0/16");
  });

  it("returns 400 for an invalid CIDR", async () => {
    const { agent, csrf } = await authedAgent(app);
    const resp = await agent
      .post("/api/v1/blocks")
      .set("X-CSRF-Token", csrf)
      .send({ name: "Bad", cidr: "not-an-ip-block" });
    expect(resp.status).toBe(400);
  });

  it("returns 409 for a duplicate CIDR", async () => {
    const { agent, csrf } = await authedAgent(app);
    await agent.post("/api/v1/blocks").set("X-CSRF-Token", csrf).send({ name: "First", cidr: "10.40.0.0/16" });
    const dup = await agent
      .post("/api/v1/blocks")
      .set("X-CSRF-Token", csrf)
      .send({ name: "Second", cidr: "10.40.0.0/16" });
    expect(dup.status).toBe(409);
  });
});

// ─── GET /api/v1/blocks ───────────────────────────────────────────────────────

d("GET /api/v1/blocks", () => {
  it("lists all blocks", async () => {
    const { agent, csrf } = await authedAgent(app);
    await agent.post("/api/v1/blocks").set("X-CSRF-Token", csrf).send({ name: "A", cidr: "10.50.0.0/16" });
    await agent.post("/api/v1/blocks").set("X-CSRF-Token", csrf).send({ name: "B", cidr: "10.60.0.0/16" });
    const resp = await agent.get("/api/v1/blocks");
    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body)).toBe(true);
    expect(resp.body.length).toBeGreaterThanOrEqual(2);
  });

  it("filters by ipVersion", async () => {
    const { agent, csrf } = await authedAgent(app);
    await agent.post("/api/v1/blocks").set("X-CSRF-Token", csrf).send({ name: "v4", cidr: "10.70.0.0/16" });
    await agent.post("/api/v1/blocks").set("X-CSRF-Token", csrf).send({ name: "v6", cidr: "fd00:dead:beef::/48" });
    const v4 = await agent.get("/api/v1/blocks?ipVersion=v4");
    const v6 = await agent.get("/api/v1/blocks?ipVersion=v6");
    expect(v4.body.every((b: any) => b.ipVersion === "v4")).toBe(true);
    expect(v6.body.every((b: any) => b.ipVersion === "v6")).toBe(true);
    expect(v4.body.length).toBeGreaterThanOrEqual(1);
    expect(v6.body.length).toBeGreaterThanOrEqual(1);
  });

  it("filters by tag", async () => {
    const { agent, csrf } = await authedAgent(app);
    await agent.post("/api/v1/blocks").set("X-CSRF-Token", csrf).send({ name: "Prod", cidr: "10.80.0.0/16", tags: ["prod", "internal"] });
    await agent.post("/api/v1/blocks").set("X-CSRF-Token", csrf).send({ name: "Lab",  cidr: "10.81.0.0/16", tags: ["lab"] });
    const resp = await agent.get("/api/v1/blocks?tag=lab");
    expect(resp.status).toBe(200);
    expect(resp.body.every((b: any) => b.tags.includes("lab"))).toBe(true);
    expect(resp.body.find((b: any) => b.name === "Prod")).toBeUndefined();
  });
});

// ─── GET /api/v1/blocks/:id ───────────────────────────────────────────────────

d("GET /api/v1/blocks/:id", () => {
  it("returns the block with its subnets", async () => {
    const { agent, csrf } = await authedAgent(app);
    const created = await agent
      .post("/api/v1/blocks")
      .set("X-CSRF-Token", csrf)
      .send({ name: "Parent", cidr: "10.90.0.0/16" });
    await agent
      .post("/api/v1/subnets")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: created.body.id, cidr: "10.90.1.0/24", name: "Sub-1" });

    const resp = await agent.get(`/api/v1/blocks/${created.body.id}`);
    expect(resp.status).toBe(200);
    expect(resp.body.id).toBe(created.body.id);
    expect(Array.isArray(resp.body.subnets)).toBe(true);
    expect(resp.body.subnets.length).toBe(1);
    expect(resp.body.subnets[0].cidr).toBe("10.90.1.0/24");
  });

  it("returns 404 for an unknown id", async () => {
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/blocks/00000000-0000-0000-0000-000000000000");
    expect(resp.status).toBe(404);
  });
});

// ─── PUT /api/v1/blocks/:id ───────────────────────────────────────────────────

d("PUT /api/v1/blocks/:id", () => {
  it("updates block metadata (name, description, tags)", async () => {
    const { agent, csrf } = await authedAgent(app);
    const created = await agent
      .post("/api/v1/blocks")
      .set("X-CSRF-Token", csrf)
      .send({ name: "Old", cidr: "10.100.0.0/16", description: "before" });
    const resp = await agent
      .put(`/api/v1/blocks/${created.body.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ name: "New", description: "after", tags: ["renamed"] });
    expect(resp.status).toBe(200);
    expect(resp.body.name).toBe("New");
    expect(resp.body.description).toBe("after");
    expect(resp.body.tags).toContain("renamed");
    // CIDR is immutable — server ignores it on update.
    expect(resp.body.cidr).toBe("10.100.0.0/16");
  });

  it("returns 404 for an unknown id", async () => {
    const { agent, csrf } = await authedAgent(app);
    const resp = await agent
      .put("/api/v1/blocks/00000000-0000-0000-0000-000000000000")
      .set("X-CSRF-Token", csrf)
      .send({ name: "Whatever" });
    expect(resp.status).toBe(404);
  });
});

// ─── DELETE /api/v1/blocks/:id ────────────────────────────────────────────────

d("DELETE /api/v1/blocks/:id", () => {
  it("deletes a block that holds no networks and returns 204", async () => {
    const { agent, csrf } = await authedAgent(app);
    const created = await agent
      .post("/api/v1/blocks")
      .set("X-CSRF-Token", csrf)
      .send({ name: "Doomed", cidr: "10.110.0.0/16" });
    const resp = await agent
      .delete(`/api/v1/blocks/${created.body.id}`)
      .set("X-CSRF-Token", csrf);
    expect(resp.status).toBe(204);
    const after = await agent.get(`/api/v1/blocks/${created.body.id}`);
    expect(after.status).toBe(404);
  });

  it("returns 409 when active reservations exist under the block's subnets", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await agent
      .post("/api/v1/blocks")
      .set("X-CSRF-Token", csrf)
      .send({ name: "Has-Reservations", cidr: "10.120.0.0/16" });
    const subnet = await agent
      .post("/api/v1/subnets")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.body.id, cidr: "10.120.1.0/24", name: "Sub" });
    await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.body.id, ipAddress: "10.120.1.5", hostname: "host01" });

    const resp = await agent
      .delete(`/api/v1/blocks/${block.body.id}`)
      .set("X-CSRF-Token", csrf);
    expect(resp.status).toBe(409);
  });

  // Business rule 4: networks alone are enough to refuse — the FK cascade used
  // to take an empty-of-reservations network (deprecated or not) with the block.
  it("returns 409 when the block still contains networks, even with no reservations", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await agent
      .post("/api/v1/blocks")
      .set("X-CSRF-Token", csrf)
      .send({ name: "Has-Networks", cidr: "10.125.0.0/16" });
    const subnet = await agent
      .post("/api/v1/subnets")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.body.id, cidr: "10.125.1.0/24", name: "Sub" });
    await prisma.subnet.update({ where: { id: subnet.body.id }, data: { status: "deprecated" } });

    const resp = await agent
      .delete(`/api/v1/blocks/${block.body.id}`)
      .set("X-CSRF-Token", csrf);
    expect(resp.status).toBe(409);
    expect(resp.body.error).toMatch(/1 network/);
    expect(await prisma.subnet.count({ where: { id: subnet.body.id } })).toBe(1);
    expect(await prisma.ipBlock.count({ where: { id: block.body.id } })).toBe(1);
  });
});

// ─── Auth ──────────────────────────────────────────────────────────────────

d("POST/PUT/DELETE /blocks require networkadmin", () => {
  it("rejects POST /blocks without a session", async () => {
    const request = (await import("supertest")).default;
    const resp = await request(app).post("/api/v1/blocks").send({ name: "X", cidr: "10.130.0.0/16" });
    // CSRF middleware runs before auth, so a sessionless mutation is rejected
    // with 403 (missing token) rather than 401 — either way it must not land.
    expect([401, 403]).toContain(resp.status);
  });
});

// ─── Audit events (service-layer logging) ───────────────────────────────────

d("block mutations write exactly one audit Event each", () => {
  beforeEach(async () => {
    await prisma.event.deleteMany({ where: { action: { startsWith: "block." } } });
  });

  it("create, update, and delete each write one Event with the session actor", async () => {
    const { agent, csrf } = await authedAgent(app);

    const created = await agent
      .post("/api/v1/blocks")
      .set("X-CSRF-Token", csrf)
      .send({ name: "Event Block", cidr: "10.150.0.0/16" });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect(await waitForEventCount("block.created", 1, id)).toBe(1);

    const updated = await agent
      .put(`/api/v1/blocks/${id}`)
      .set("X-CSRF-Token", csrf)
      .send({ name: "Event Block 2" });
    expect(updated.status).toBe(200);
    expect(await waitForEventCount("block.updated", 1, id)).toBe(1);
    const updateEvent = await prisma.event.findFirst({ where: { action: "block.updated", resourceId: id } });
    expect(updateEvent?.actor).toBeTruthy();
    expect((updateEvent?.details as any)?.changes?.name?.to).toBe("Event Block 2");

    const deleted = await agent.delete(`/api/v1/blocks/${id}`).set("X-CSRF-Token", csrf);
    expect(deleted.status).toBe(204);
    expect(await waitForEventCount("block.deleted", 1, id)).toBe(1);
  });

  it("a validation failure writes no Event", async () => {
    const { agent, csrf } = await authedAgent(app);
    const resp = await agent
      .post("/api/v1/blocks")
      .set("X-CSRF-Token", csrf)
      .send({ name: "Bad", cidr: "not-a-cidr" });
    expect(resp.status).toBe(400);
    // Give a would-be stray event time to land before asserting zero.
    await new Promise((r) => setTimeout(r, 200));
    expect(await prisma.event.count({ where: { action: "block.created" } })).toBe(0);
  });
});
