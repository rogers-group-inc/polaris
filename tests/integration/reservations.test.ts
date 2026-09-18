/**
 * tests/integration/reservations.test.ts
 *
 * Integration tests for /api/v1/reservations. Skips cleanly when
 * DATABASE_URL isn't reachable; see tests/integration/_helpers.ts.
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
  await prisma.reservation.deleteMany();
  await prisma.subnet.deleteMany();
  await prisma.ipBlock.deleteMany();
});

/** Quick scaffold: block + subnet ready to host reservations. */
async function scaffold(agent: any, csrf: string, blockCidr: string, subnetCidr: string) {
  const block = await agent.post("/api/v1/blocks").set("X-CSRF-Token", csrf).send({ name: "B", cidr: blockCidr });
  if (block.status !== 201) throw new Error(`block create: ${block.status} ${JSON.stringify(block.body)}`);
  const subnet = await agent
    .post("/api/v1/subnets")
    .set("X-CSRF-Token", csrf)
    .send({ blockId: block.body.id, cidr: subnetCidr, name: "S" });
  if (subnet.status !== 201) throw new Error(`subnet create: ${subnet.status} ${JSON.stringify(subnet.body)}`);
  return { block: block.body, subnet: subnet.body };
}

// ─── POST /api/v1/reservations ────────────────────────────────────────────────

d("POST /api/v1/reservations", () => {
  it("creates a specific-IP reservation and returns 201", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.10.0.0/16", "10.10.1.0/24");
    const resp = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.10.1.5", hostname: "host-a", owner: "alice" });
    expect(resp.status).toBe(201);
    expect(resp.body.ipAddress).toBe("10.10.1.5");
    expect(resp.body.status).toBe("active");
    expect(resp.body.sourceType).toBe("manual");
  });

  it("auto-stamps owner with the creator's username when owner is omitted", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.15.0.0/16", "10.15.1.0/24");
    const resp = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.15.1.5", hostname: "host-noowner" });
    expect(resp.status).toBe(201);
    expect(resp.body.owner).toBe("polaris-integration-tester");
    expect(resp.body.createdBy).toBe("polaris-integration-tester");
  });

  it("keeps an explicitly typed owner instead of auto-stamping", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.16.0.0/16", "10.16.1.0/24");
    const resp = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.16.1.5", hostname: "host-owned", owner: "platform-team" });
    expect(resp.status).toBe(201);
    expect(resp.body.owner).toBe("platform-team");
  });

  it("creates a full-subnet reservation and marks subnet as reserved", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.20.0.0/16", "10.20.1.0/24");
    const resp = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, hostname: "whole-subnet", owner: "alice" });
    expect(resp.status).toBe(201);
    expect(resp.body.ipAddress).toBeNull();
    const after = await agent.get(`/api/v1/subnets/${subnet.id}`);
    expect(after.body.status).toBe("reserved");
  });

  it("returns 400 for an IP not within the subnet", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.30.0.0/16", "10.30.1.0/24");
    const resp = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.30.2.5", hostname: "out-of-range" });
    expect(resp.status).toBe(400);
    expect(String(resp.body?.error || "")).toMatch(/not within subnet/i);
  });

  it("returns 409 for a duplicate active reservation on the same IP", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.40.0.0/16", "10.40.1.0/24");
    const ok = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.40.1.5", hostname: "first" });
    expect(ok.status).toBe(201);
    const dup = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.40.1.5", hostname: "second" });
    expect(dup.status).toBe(409);
  });

  it("returns 409 when reserving on a deprecated subnet", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.50.0.0/16", "10.50.1.0/24");
    await agent.put(`/api/v1/subnets/${subnet.id}`).set("X-CSRF-Token", csrf).send({ status: "deprecated" });
    const resp = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.50.1.5", hostname: "blocked" });
    expect(resp.status).toBe(409);
    expect(String(resp.body?.error || "")).toMatch(/deprecated/i);
  });
});

// ─── GET /api/v1/reservations ─────────────────────────────────────────────────

d("GET /api/v1/reservations", () => {
  // The list endpoint returns a paginated envelope { reservations, total,
  // limit, offset } rather than a bare array (pagination cutover, 5a5ed32).
  it("lists all reservations", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.60.0.0/16", "10.60.1.0/24");
    await agent.post("/api/v1/reservations").set("X-CSRF-Token", csrf).send({ subnetId: subnet.id, ipAddress: "10.60.1.5", hostname: "h1" });
    await agent.post("/api/v1/reservations").set("X-CSRF-Token", csrf).send({ subnetId: subnet.id, ipAddress: "10.60.1.6", hostname: "h2" });
    const resp = await agent.get("/api/v1/reservations");
    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.reservations)).toBe(true);
    expect(resp.body.reservations.length).toBeGreaterThanOrEqual(2);
    expect(resp.body.total).toBeGreaterThanOrEqual(2);
  });

  it("filters by owner", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.70.0.0/16", "10.70.1.0/24");
    await agent.post("/api/v1/reservations").set("X-CSRF-Token", csrf).send({ subnetId: subnet.id, ipAddress: "10.70.1.5", hostname: "h1", owner: "alice" });
    await agent.post("/api/v1/reservations").set("X-CSRF-Token", csrf).send({ subnetId: subnet.id, ipAddress: "10.70.1.6", hostname: "h2", owner: "bob" });
    const resp = await agent.get("/api/v1/reservations?owner=alice");
    expect(resp.status).toBe(200);
    expect(resp.body.reservations.every((r: any) => r.owner === "alice")).toBe(true);
    expect(resp.body.reservations.length).toBe(1);
  });

  it("filters by projectRef", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.80.0.0/16", "10.80.1.0/24");
    await agent.post("/api/v1/reservations").set("X-CSRF-Token", csrf).send({ subnetId: subnet.id, ipAddress: "10.80.1.5", hostname: "h1", owner: "x", projectRef: "proj-a" });
    await agent.post("/api/v1/reservations").set("X-CSRF-Token", csrf).send({ subnetId: subnet.id, ipAddress: "10.80.1.6", hostname: "h2", owner: "y", projectRef: "proj-b" });
    const resp = await agent.get("/api/v1/reservations?projectRef=proj-a");
    expect(resp.body.reservations.every((r: any) => r.projectRef === "proj-a")).toBe(true);
    expect(resp.body.reservations.length).toBe(1);
  });

  it("filters by status (active by default)", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.90.0.0/16", "10.90.1.0/24");
    const r = await agent.post("/api/v1/reservations").set("X-CSRF-Token", csrf).send({ subnetId: subnet.id, ipAddress: "10.90.1.5", hostname: "h1" });
    await agent.delete(`/api/v1/reservations/${r.body.id}`).set("X-CSRF-Token", csrf);
    const released = await agent.get("/api/v1/reservations?status=released");
    const active = await agent.get("/api/v1/reservations?status=active");
    expect(released.body.reservations.length).toBe(1);
    expect(active.body.reservations.find((x: any) => x.id === r.body.id)).toBeUndefined();
  });
});

// ─── GET /api/v1/reservations/:id ────────────────────────────────────────────

d("GET /api/v1/reservations/:id", () => {
  it("returns the reservation", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.100.0.0/16", "10.100.1.0/24");
    const created = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.100.1.5", hostname: "h1" });
    const resp = await agent.get(`/api/v1/reservations/${created.body.id}`);
    expect(resp.status).toBe(200);
    expect(resp.body.id).toBe(created.body.id);
    expect(resp.body.ipAddress).toBe("10.100.1.5");
  });

  it("returns 404 for an unknown id", async () => {
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/reservations/00000000-0000-0000-0000-000000000000");
    expect(resp.status).toBe(404);
  });
});

// ─── PUT /api/v1/reservations/:id ────────────────────────────────────────────

d("PUT /api/v1/reservations/:id", () => {
  it("updates reservation metadata (hostname, owner, notes)", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.110.0.0/16", "10.110.1.0/24");
    const created = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.110.1.5", hostname: "old", owner: "alice" });
    const resp = await agent
      .put(`/api/v1/reservations/${created.body.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ hostname: "new", owner: "bob", notes: "post-rename" });
    expect(resp.status).toBe(200);
    expect(resp.body.hostname).toBe("new");
    expect(resp.body.owner).toBe("bob");
    expect(resp.body.notes).toBe("post-rename");
  });

  it("extends the TTL via expiresAt", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.120.0.0/16", "10.120.1.0/24");
    const created = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.120.1.5", hostname: "ttl" });
    const newExpiry = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const resp = await agent
      .put(`/api/v1/reservations/${created.body.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ expiresAt: newExpiry });
    expect(resp.status).toBe(200);
    expect(new Date(resp.body.expiresAt).toISOString()).toBe(newExpiry);
  });

  it("returns 409 when trying to update a released reservation", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.130.0.0/16", "10.130.1.0/24");
    const created = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.130.1.5", hostname: "h" });
    await agent.delete(`/api/v1/reservations/${created.body.id}`).set("X-CSRF-Token", csrf);
    const resp = await agent
      .put(`/api/v1/reservations/${created.body.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ hostname: "nope" });
    expect(resp.status).toBe(409);
  });
});

// ─── DELETE /api/v1/reservations/:id ─────────────────────────────────────────

d("DELETE /api/v1/reservations/:id", () => {
  it("releases an active reservation and returns 204", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.140.0.0/16", "10.140.1.0/24");
    const created = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.140.1.5", hostname: "h" });
    const resp = await agent.delete(`/api/v1/reservations/${created.body.id}`).set("X-CSRF-Token", csrf);
    expect(resp.status).toBe(204);
    // Status flips to released; the row stays around so audit history works.
    const fresh = await prisma.reservation.findUnique({ where: { id: created.body.id } });
    expect(fresh!.status).toBe("released");
  });

  it("restores subnet status to available after a full-subnet release", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.150.0.0/16", "10.150.1.0/24");
    const r = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, hostname: "whole" });
    const before = await agent.get(`/api/v1/subnets/${subnet.id}`);
    expect(before.body.status).toBe("reserved");
    await agent.delete(`/api/v1/reservations/${r.body.id}`).set("X-CSRF-Token", csrf);
    const after = await agent.get(`/api/v1/subnets/${subnet.id}`);
    expect(after.body.status).toBe("available");
  });

  it("returns 409 when reservation is already released", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.160.0.0/16", "10.160.1.0/24");
    const r = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.160.1.5", hostname: "h" });
    await agent.delete(`/api/v1/reservations/${r.body.id}`).set("X-CSRF-Token", csrf);
    const resp = await agent.delete(`/api/v1/reservations/${r.body.id}`).set("X-CSRF-Token", csrf);
    expect(resp.status).toBe(409);
  });
});

// ─── Audit events (service-layer logging) ───────────────────────────────────

d("reservation mutations write exactly one audit Event each", () => {
  beforeEach(async () => {
    await prisma.event.deleteMany({ where: { action: { startsWith: "reservation." } } });
  });

  it("create, auto-allocate, update, and release each write one Event", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.90.0.0/16", "10.90.1.0/24");

    const created = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.90.1.5", hostname: "evt-host", owner: "alice" });
    expect(created.status).toBe(201);
    expect(await waitForEventCount("reservation.created", 1, created.body.id)).toBe(1);
    const createdEvt = await prisma.event.findFirst({ where: { action: "reservation.created", resourceId: created.body.id } });
    expect(createdEvt?.message).toContain("created for 10.90.1.5");

    const auto = await agent
      .post("/api/v1/reservations/next-available")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, hostname: "evt-auto", owner: "bob" });
    expect(auto.status).toBe(201);
    expect(await waitForEventCount("reservation.created", 1, auto.body.id)).toBe(1);
    const autoEvt = await prisma.event.findFirst({ where: { action: "reservation.created", resourceId: auto.body.id } });
    expect(autoEvt?.message).toContain("auto-allocated");

    const updated = await agent
      .put(`/api/v1/reservations/${created.body.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ notes: "updated note" });
    expect(updated.status).toBe(200);
    expect(await waitForEventCount("reservation.updated", 1, created.body.id)).toBe(1);
    const updEvt = await prisma.event.findFirst({ where: { action: "reservation.updated", resourceId: created.body.id } });
    expect((updEvt?.details as any)?.changes?.notes?.to).toBe("updated note");

    const released = await agent
      .delete(`/api/v1/reservations/${created.body.id}`)
      .set("X-CSRF-Token", csrf);
    expect(released.status).toBe(204);
    expect(await waitForEventCount("reservation.released", 1, created.body.id)).toBe(1);
  });

  it("a failed create (duplicate IP) writes no Event", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.91.0.0/16", "10.91.1.0/24");
    const first = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.91.1.5", hostname: "evt-dup", owner: "alice" });
    expect(first.status).toBe(201);
    await waitForEventCount("reservation.created", 1, first.body.id);

    const dup = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.91.1.5", hostname: "evt-dup-2", owner: "bob" });
    expect(dup.status).toBe(409);
    await new Promise((r) => setTimeout(r, 200));
    expect(await prisma.event.count({ where: { action: "reservation.created" } })).toBe(1);
  });
});

// ─── POST /api/v1/reservations/next-available/preview ─────────────────────────

d("POST /api/v1/reservations/next-available/preview", () => {
  it("returns the first N free addresses without reserving anything", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.60.0.0/16", "10.60.1.0/24");

    const resp = await agent
      .post("/api/v1/reservations/next-available/preview")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, count: 3 });
    expect(resp.status).toBe(200);
    expect(resp.body.ips).toEqual(["10.60.1.1", "10.60.1.2", "10.60.1.3"]);
    // Preview writes nothing.
    expect(await prisma.reservation.count({ where: { subnetId: subnet.id } })).toBe(0);
  });

  it("skips addresses that already carry an active reservation", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.61.0.0/16", "10.61.1.0/24");
    for (const ip of ["10.61.1.1", "10.61.1.3"]) {
      const r = await agent
        .post("/api/v1/reservations")
        .set("X-CSRF-Token", csrf)
        .send({ subnetId: subnet.id, ipAddress: ip, hostname: `h-${ip}` });
      expect(r.status).toBe(201);
    }
    const resp = await agent
      .post("/api/v1/reservations/next-available/preview")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, count: 3 });
    expect(resp.status).toBe(200);
    expect(resp.body.ips).toEqual(["10.61.1.2", "10.61.1.4", "10.61.1.5"]);
  });

  it("returns an unbroken run when contiguous is asked for", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.62.0.0/16", "10.62.1.0/24");
    const taken = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.62.1.2", hostname: "in-the-way" });
    expect(taken.status).toBe(201);

    const loose = await agent
      .post("/api/v1/reservations/next-available/preview")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, count: 3, contiguous: false });
    expect(loose.body.ips).toEqual(["10.62.1.1", "10.62.1.3", "10.62.1.4"]);

    const run = await agent
      .post("/api/v1/reservations/next-available/preview")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, count: 3, contiguous: true });
    expect(run.status).toBe(200);
    expect(run.body.ips).toEqual(["10.62.1.3", "10.62.1.4", "10.62.1.5"]);
  });

  it("refuses a contiguous run that does not fit, naming the largest one that does", async () => {
    const { agent, csrf } = await authedAgent(app);
    // /29 → hosts .1-.6. Taking .3 and .6 leaves runs of 2 (.1-.2) and 2 (.4-.5).
    const { subnet } = await scaffold(agent, csrf, "10.63.0.0/16", "10.63.1.0/29");
    for (const ip of ["10.63.1.3", "10.63.1.6"]) {
      const r = await agent
        .post("/api/v1/reservations")
        .set("X-CSRF-Token", csrf)
        .send({ subnetId: subnet.id, ipAddress: ip, hostname: `h-${ip}` });
      expect(r.status).toBe(201);
    }
    const resp = await agent
      .post("/api/v1/reservations/next-available/preview")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, count: 3, contiguous: true });
    expect(resp.status).toBe(409);
    expect(resp.body.error).toContain("largest available run is 2");
  });

  it("refuses when the subnet has too few free addresses at all", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.64.0.0/16", "10.64.1.0/30");
    const resp = await agent
      .post("/api/v1/reservations/next-available/preview")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, count: 5 });
    expect(resp.status).toBe(409);
    expect(resp.body.error).toContain("free address");
  });

  it("rejects a count above the bulk ceiling", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.65.0.0/16", "10.65.1.0/24");
    const resp = await agent
      .post("/api/v1/reservations/next-available/preview")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, count: 500 });
    expect(resp.status).toBe(400);
  });
});

// ─── Device-owned addresses (VIP / interface IP) ──────────────────────────────
//
// A FortiGate VIP and a statically-configured interface address belong to the
// device's own config. Polaris reports them; it must not offer to reserve,
// release or edit one.

d("device-owned reservations are read-only", () => {
  /** Discovery-shaped row — created straight through Prisma, since no API
   *  route mints a vip / interface_ip reservation. */
  async function seedDeviceOwned(subnetId: string, ipAddress: string, sourceType: "vip" | "interface_ip") {
    return prisma.reservation.create({
      data: { subnetId, ipAddress, hostname: "device-owned", sourceType, status: "active", createdBy: "system:discovery" },
    });
  }

  it("refuses to edit a VIP row", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.66.0.0/16", "10.66.1.0/24");
    const row = await seedDeviceOwned(subnet.id, "10.66.1.10", "vip");
    const resp = await agent
      .put(`/api/v1/reservations/${row.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ notes: "mine now" });
    expect(resp.status).toBe(409);
    expect(resp.body.error).toContain("FortiGate VIP");
    const after = await prisma.reservation.findUnique({ where: { id: row.id } });
    expect(after?.notes ?? null).toBeNull();
  });

  it("refuses to release a VIP row", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.67.0.0/16", "10.67.1.0/24");
    const row = await seedDeviceOwned(subnet.id, "10.67.1.10", "vip");
    const resp = await agent.delete(`/api/v1/reservations/${row.id}`).set("X-CSRF-Token", csrf);
    expect(resp.status).toBe(409);
    const after = await prisma.reservation.findUnique({ where: { id: row.id } });
    expect(after?.status).toBe("active");
  });

  it("refuses to edit or release an interface-IP row", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.68.0.0/16", "10.68.1.0/24");
    const row = await seedDeviceOwned(subnet.id, "10.68.1.1", "interface_ip");
    const edit = await agent
      .put(`/api/v1/reservations/${row.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ notes: "mine now" });
    expect(edit.status).toBe(409);
    expect(edit.body.error).toContain("device interface address");
    const del = await agent.delete(`/api/v1/reservations/${row.id}`).set("X-CSRF-Token", csrf);
    expect(del.status).toBe(409);
  });

  it("refuses to reserve over a device-owned address, and never previews one", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.69.0.0/16", "10.69.1.0/24");
    await seedDeviceOwned(subnet.id, "10.69.1.1", "interface_ip");
    await seedDeviceOwned(subnet.id, "10.69.1.2", "vip");

    const create = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.69.1.2", hostname: "steal-the-vip" });
    expect(create.status).toBe(409);

    const preview = await agent
      .post("/api/v1/reservations/next-available/preview")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, count: 2 });
    expect(preview.status).toBe(200);
    expect(preview.body.ips).toEqual(["10.69.1.3", "10.69.1.4"]);
  });
});

// ─── FortiGate description budget ──────────────────────────────────────
//
// On a network that pushes reservations, `notes` is the body of the FortiOS
// `reserved-address` description — 255 characters including the
// "Polaris/<user>: … [<hostname>]" wrapper. Over-length input is refused at
// save time rather than truncated on the way to the gate; none of these cases
// reaches a device, because the check runs before the row is written (create)
// and before the MAC branch (update).

d("reservation notes are held to the FortiGate's description budget", () => {
  /** A subnet whose integration pushes reservations to a named FortiGate. */
  async function pushEligibleSubnet(cidr: string, blockCidr: string) {
    const integration = await prisma.integration.create({
      data: {
        name: `FMG ${cidr}`,
        type: "fortimanager",
        config: { host: "fmg.invalid", pushReservations: true },
      } as any,
    });
    const block = await prisma.ipBlock.create({
      data: { name: "B", cidr: blockCidr, ipVersion: "v4" } as any,
    });
    return prisma.subnet.create({
      data: {
        blockId: block.id,
        cidr,
        name: "pushy",
        discoveredBy: integration.id,
        fortigateDevice: "FGT-TEST-01",
      } as any,
    });
  }

  const LONG_NOTE = "n".repeat(300);

  it("refuses an over-length note at create, and writes no row", async () => {
    const { agent, csrf } = await authedAgent(app);
    const subnet = await pushEligibleSubnet("10.71.1.0/24", "10.71.0.0/16");
    const resp = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({
        subnetId: subnet.id,
        ipAddress: "10.71.1.10",
        hostname: "host-a",
        macAddress: "aa:bb:cc:dd:ee:01",
        notes: LONG_NOTE,
      });
    expect(resp.status).toBe(400);
    expect(resp.body.error).toContain("too long for the FortiGate");
    expect(await prisma.reservation.count({ where: { subnetId: subnet.id } })).toBe(0);
  });

  it("accepts the same note on a network Polaris does not push to", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf, "10.72.0.0/16", "10.72.1.0/24");
    const resp = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.72.1.10", hostname: "host-a", notes: LONG_NOTE });
    expect(resp.status).toBe(201);
    expect(resp.body.notes).toBe(LONG_NOTE);
  });

  it("refuses an edit that grows the note past the budget, and stores nothing", async () => {
    const { agent, csrf } = await authedAgent(app);
    const subnet = await pushEligibleSubnet("10.73.1.0/24", "10.73.0.0/16");
    const row = await prisma.reservation.create({
      data: {
        subnetId: subnet.id,
        ipAddress: "10.73.1.10",
        hostname: "host-a",
        macAddress: "aa:bb:cc:dd:ee:02",
        notes: "short",
        status: "active",
        createdBy: "polaris-integration-tester",
      } as any,
    });
    const resp = await agent
      .put(`/api/v1/reservations/${row.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ notes: LONG_NOTE });
    expect(resp.status).toBe(400);
    expect(resp.body.error).toContain("too long for the FortiGate");
    const after = await prisma.reservation.findUnique({ where: { id: row.id } });
    expect(after?.notes).toBe("short");
  });

  it("lets an operator SHORTEN a note that predates the rule", async () => {
    const { agent, csrf } = await authedAgent(app);
    const subnet = await pushEligibleSubnet("10.74.1.0/24", "10.74.0.0/16");
    const row = await prisma.reservation.create({
      data: {
        subnetId: subnet.id,
        ipAddress: "10.74.1.10",
        hostname: "host-a",
        macAddress: "aa:bb:cc:dd:ee:03",
        notes: LONG_NOTE,
        status: "active",
        createdBy: "polaris-integration-tester",
      } as any,
    });
    const resp = await agent
      .put(`/api/v1/reservations/${row.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ notes: "rack 4 spare" });
    expect(resp.status).toBe(200);
    const after = await prisma.reservation.findUnique({ where: { id: row.id } });
    expect(after?.notes).toBe("rack 4 spare");
  });

  it("leaves a stored over-length note alone when the edit does not touch it", async () => {
    const { agent, csrf } = await authedAgent(app);
    const subnet = await pushEligibleSubnet("10.75.1.0/24", "10.75.0.0/16");
    const row = await prisma.reservation.create({
      data: {
        subnetId: subnet.id,
        ipAddress: "10.75.1.10",
        hostname: "host-a",
        macAddress: "aa:bb:cc:dd:ee:04",
        notes: LONG_NOTE,
        status: "active",
        createdBy: "polaris-integration-tester",
      } as any,
    });
    // Editing the owner must not be blocked by a note this edit isn't touching
    // — the alternative strands the row, since every save would 400. The
    // description's truncating backstop is what covers a row like this.
    const resp = await agent
      .put(`/api/v1/reservations/${row.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ owner: "network-team" });
    expect(resp.status).toBe(200);
    const after = await prisma.reservation.findUnique({ where: { id: row.id } });
    expect(after?.owner).toBe("network-team");
    expect(after?.notes).toBe(LONG_NOTE);
  });

  it("still judges the hostname — it rides inside the same 255", async () => {
    const { agent, csrf } = await authedAgent(app);
    const subnet = await pushEligibleSubnet("10.76.1.0/24", "10.76.0.0/16");
    const row = await prisma.reservation.create({
      data: {
        subnetId: subnet.id,
        ipAddress: "10.76.1.10",
        hostname: "host-a",
        macAddress: "aa:bb:cc:dd:ee:05",
        notes: "n".repeat(200),
        status: "active",
        createdBy: "polaris-integration-tester",
      } as any,
    });
    const resp = await agent
      .put(`/api/v1/reservations/${row.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ hostname: "h".repeat(60) });
    expect(resp.status).toBe(400);
    expect(resp.body.error).toContain("too long for the FortiGate");
    const after = await prisma.reservation.findUnique({ where: { id: row.id } });
    expect(after?.hostname).toBe("host-a");
  });
});
