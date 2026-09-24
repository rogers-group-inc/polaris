/**
 * tests/integration/subnets.test.ts
 *
 * Integration tests for /api/v1/subnets. Skips cleanly when DATABASE_URL
 * isn't reachable; see tests/integration/_helpers.ts.
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

/** Create a parent block; returns the block row. */
async function createBlock(agent: any, csrf: string, name: string, cidr: string) {
  const resp = await agent.post("/api/v1/blocks").set("X-CSRF-Token", csrf).send({ name, cidr });
  if (resp.status !== 201) throw new Error(`Block create failed: ${resp.status} ${JSON.stringify(resp.body)}`);
  return resp.body;
}

// ─── POST /api/v1/subnets ─────────────────────────────────────────────────────

d("POST /api/v1/subnets", () => {
  it("carves a subnet from a valid block and returns 201", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.10.0.0/16");
    const resp = await agent
      .post("/api/v1/subnets")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, cidr: "10.10.1.0/24", name: "Office VLAN", vlan: 100 });
    expect(resp.status).toBe(201);
    expect(resp.body.cidr).toBe("10.10.1.0/24");
    expect(resp.body.status).toBe("available");
    expect(resp.body.vlan).toBe(100);
  });

  it("normalizes the CIDR (zeros host bits) on create", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.11.0.0/16");
    const resp = await agent
      .post("/api/v1/subnets")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, cidr: "10.11.1.7/24", name: "Sloppy" });
    expect(resp.status).toBe(201);
    expect(resp.body.cidr).toBe("10.11.1.0/24");
  });

  it("returns 400 for an invalid CIDR", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.12.0.0/16");
    const resp = await agent
      .post("/api/v1/subnets")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, cidr: "not-a-cidr", name: "Bad" });
    expect(resp.status).toBe(400);
  });

  it("returns 400 when subnet is not within its parent block", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.13.0.0/16");
    const resp = await agent
      .post("/api/v1/subnets")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, cidr: "10.99.1.0/24", name: "Outside" });
    expect(resp.status).toBe(400);
    expect(String(resp.body?.error || "")).toMatch(/not within block/i);
  });

  it("returns 409 when subnet overlaps with a sibling", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.14.0.0/16");
    await agent
      .post("/api/v1/subnets")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, cidr: "10.14.0.0/24", name: "Sib-1" });
    const overlap = await agent
      .post("/api/v1/subnets")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, cidr: "10.14.0.0/25", name: "Sib-2" });
    expect(overlap.status).toBe(409);
    expect(String(overlap.body?.error || "")).toMatch(/overlap/i);
  });
});

// ─── Placement: no block named ──────────────────────────────────────────────

d("POST /api/v1/subnets without a blockId", () => {
  it("places the network in the most specific block containing it and says which", async () => {
    const { agent, csrf } = await authedAgent(app);
    await createBlock(agent, csrf, "Corp", "10.0.0.0/8");
    const site = await createBlock(agent, csrf, "Site", "10.90.0.0/16");
    const resp = await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ cidr: "10.90.4.0/24", name: "Floor 4" });
    expect(resp.status).toBe(201);
    expect(resp.body.blockId).toBe(site.id);
    expect(resp.body.block).toEqual({ id: site.id, name: "Site", cidr: "10.90.0.0/16" });
  });

  it("falls back to the wider block for a CIDR outside every nested one", async () => {
    const { agent, csrf } = await authedAgent(app);
    const corp = await createBlock(agent, csrf, "Corp", "10.0.0.0/8");
    await createBlock(agent, csrf, "Site", "10.90.0.0/16");
    const resp = await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ cidr: "10.91.0.0/24", name: "Elsewhere" });
    expect(resp.status).toBe(201);
    expect(resp.body.blockId).toBe(corp.id);
  });

  it("400s when no block contains the network", async () => {
    const { agent, csrf } = await authedAgent(app);
    await createBlock(agent, csrf, "Corp", "10.0.0.0/8");
    const resp = await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ cidr: "172.16.0.0/24", name: "Nowhere" });
    expect(resp.status).toBe(400);
    expect(resp.body.error).toMatch(/No IP block contains 172\.16\.0\.0\/24/);
  });

  it("still honours an explicit blockId", async () => {
    const { agent, csrf } = await authedAgent(app);
    const corp = await createBlock(agent, csrf, "Corp", "10.0.0.0/8");
    await createBlock(agent, csrf, "Site", "10.90.0.0/16");
    const resp = await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: corp.id, cidr: "10.90.5.0/24", name: "Pinned" });
    expect(resp.status).toBe(201);
    expect(resp.body.blockId).toBe(corp.id);
  });

  it("GET /subnets/resolve-block previews the same answer, and null for no match", async () => {
    const { agent, csrf } = await authedAgent(app);
    await createBlock(agent, csrf, "Corp", "10.0.0.0/8");
    const site = await createBlock(agent, csrf, "Site", "10.90.0.0/16");
    const hit = await agent.get("/api/v1/subnets/resolve-block?cidr=" + encodeURIComponent("10.90.7.9/24"));
    expect(hit.status).toBe(200);
    expect(hit.body.block).toEqual({ id: site.id, name: "Site", cidr: "10.90.0.0/16" });
    const miss = await agent.get("/api/v1/subnets/resolve-block?cidr=" + encodeURIComponent("172.16.0.0/24"));
    expect(miss.body).toEqual({ block: null });
    const junk = await agent.get("/api/v1/subnets/resolve-block?cidr=not-a-cidr");
    expect(junk.status).toBe(200);
    expect(junk.body).toEqual({ block: null });
  });
});

// ─── POST /api/v1/subnets/next-available ──────────────────────────────────────

d("POST /api/v1/subnets/next-available", () => {
  it("auto-allocates the next available subnet of the requested prefix length", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.20.0.0/16");
    const r1 = await agent
      .post("/api/v1/subnets/next-available")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, prefixLength: 24, name: "Auto-1" });
    expect(r1.status).toBe(201);
    expect(r1.body.cidr).toBe("10.20.0.0/24");
    const r2 = await agent
      .post("/api/v1/subnets/next-available")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, prefixLength: 24, name: "Auto-2" });
    expect(r2.status).toBe(201);
    expect(r2.body.cidr).toBe("10.20.1.0/24");
  });

  it("returns 409 when no space remains in the block", async () => {
    const { agent, csrf } = await authedAgent(app);
    // /30 block holds exactly one /30; allocate it then ask for another.
    const block = await createBlock(agent, csrf, "Tiny", "10.21.0.0/30");
    const ok = await agent
      .post("/api/v1/subnets/next-available")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, prefixLength: 30, name: "Only" });
    expect(ok.status).toBe(201);
    const full = await agent
      .post("/api/v1/subnets/next-available")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, prefixLength: 30, name: "Overflow" });
    expect(full.status).toBe(409);
  });
});

// ─── GET /api/v1/subnets ──────────────────────────────────────────────────────

d("GET /api/v1/subnets", () => {
  it("lists all subnets", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.30.0.0/16");
    await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: block.id, cidr: "10.30.1.0/24", name: "A" });
    await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: block.id, cidr: "10.30.2.0/24", name: "B" });
    const resp = await agent.get("/api/v1/subnets");
    expect(resp.status).toBe(200);
    // listSubnets returns a pagination envelope { subnets, total, limit, offset }
    expect(Array.isArray(resp.body.subnets)).toBe(true);
    expect(resp.body.subnets.length).toBeGreaterThanOrEqual(2);
  });

  it("filters by blockId", async () => {
    const { agent, csrf } = await authedAgent(app);
    const a = await createBlock(agent, csrf, "A", "10.40.0.0/16");
    const b = await createBlock(agent, csrf, "B", "10.41.0.0/16");
    await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: a.id, cidr: "10.40.1.0/24", name: "in-A" });
    await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: b.id, cidr: "10.41.1.0/24", name: "in-B" });
    const resp = await agent.get(`/api/v1/subnets?blockId=${a.id}`);
    expect(resp.status).toBe(200);
    expect(resp.body.subnets.every((s: any) => s.blockId === a.id)).toBe(true);
    expect(resp.body.subnets.length).toBe(1);
  });

  it("filters by status", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.50.0.0/16");
    const sub = await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: block.id, cidr: "10.50.1.0/24", name: "S" });
    await agent.put(`/api/v1/subnets/${sub.body.id}`).set("X-CSRF-Token", csrf).send({ status: "deprecated" });
    const dep = await agent.get("/api/v1/subnets?status=deprecated");
    const avl = await agent.get("/api/v1/subnets?status=available");
    expect(dep.body.subnets.every((s: any) => s.status === "deprecated")).toBe(true);
    expect(dep.body.subnets.length).toBe(1);
    expect(avl.body.subnets.find((s: any) => s.id === sub.body.id)).toBeUndefined();
  });

  it("counts only live reservations into _count and carries the utilization denominator", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.56.0.0/16");
    const sub = await agent
      .post("/api/v1/subnets")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, cidr: "10.56.1.0/24", name: "Churned" });

    // Three live addresses, plus the kind of row the column used to over-count:
    // a released reservation (soft-released, kept forever) and a whole-subnet
    // reservation, which holds no individual address.
    await prisma.reservation.createMany({
      data: [
        { subnetId: sub.body.id, ipAddress: "10.56.1.10", status: "active" },
        { subnetId: sub.body.id, ipAddress: "10.56.1.11", status: "active" },
        { subnetId: sub.body.id, ipAddress: "10.56.1.12", status: "active" },
        { subnetId: sub.body.id, ipAddress: "10.56.1.13", status: "released" },
        { subnetId: sub.body.id, ipAddress: "10.56.1.14", status: "expired" },
        { subnetId: sub.body.id, ipAddress: null, status: "active" },
      ],
    });

    const resp = await agent.get(`/api/v1/subnets?blockId=${block.id}`);
    expect(resp.status).toBe(200);
    const row = resp.body.subnets.find((s: any) => s.id === sub.body.id);
    expect(row._count.reservations).toBe(3);
    expect(row.usableHosts).toBe(254);
    expect(row.utilizationPercent).toBeCloseTo(1.2, 5);
    // The delete/archive confirmations quote this one: the cascade takes the
    // released and expired history with it.
    expect(row.totalReservations).toBe(6);
  });

  it("quotes no utilization denominator for an IPv6 network", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "V6", "2001:db8::/32");
    const sub = await agent
      .post("/api/v1/subnets")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, cidr: "2001:db8:1::/64", name: "V6 net" });
    expect(sub.status).toBe(201);

    const resp = await agent.get(`/api/v1/subnets?blockId=${block.id}`);
    const row = resp.body.subnets.find((s: any) => s.id === sub.body.id);
    // A /64 is not a thing anyone fills, and the count would not survive a
    // double — the cell shows the reservation count with a dash beside it.
    expect(row.usableHosts).toBeNull();
    expect(row.utilizationPercent).toBeNull();
  });

  it("filters by tag in SQL: total counts only matches and pages stay full", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.55.0.0/16");
    // Three tagged subnets interleaved (by cidr sort order) with two untagged
    // ones — the old post-paginate filter returned a short first page here
    // and a total of 5.
    for (const [i, tags] of [["1", ["dmz"]], ["2", []], ["3", ["dmz"]], ["4", []], ["5", ["dmz"]]] as const) {
      await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf)
        .send({ blockId: block.id, cidr: `10.55.${i}.0/24`, name: `S${i}`, tags: [...tags] });
    }
    const page1 = await agent.get("/api/v1/subnets?tag=dmz&limit=2&offset=0");
    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(3);
    expect(page1.body.subnets.map((s: any) => s.cidr)).toEqual(["10.55.1.0/24", "10.55.3.0/24"]);
    const page2 = await agent.get("/api/v1/subnets?tag=dmz&limit=2&offset=2");
    expect(page2.body.subnets.map((s: any) => s.cidr)).toEqual(["10.55.5.0/24"]);
  });
});

// ─── GET /api/v1/subnets/:id/ips ──────────────────────────────────────────────

d("GET /api/v1/subnets/:id/ips", () => {
  // The panel loads ONE page of addresses, so it fetches only that page's
  // reservations — an actively-leased /21 carries thousands. What must not
  // regress with that narrowing: the page still shows its own reservations,
  // and `hasConflict` still means "anywhere in this subnet", not "on this
  // page" (it warns about the subnet, and the conflicting row is usually
  // nowhere near page 1).
  async function seed(agent: any, csrf: string) {
    const block = await createBlock(agent, csrf, "IPs", "10.70.0.0/16");
    const sub = await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, cidr: "10.70.0.0/24", name: "Panel" });
    return sub.body.id as string;
  }

  it("returns the page's own reservations and omits ones outside the window", async () => {
    const { agent, csrf } = await authedAgent(app);
    const subnetId = await seed(agent, csrf);
    // .5 lands on page 1 at pageSize 4 (.0 network, .1, .2, .3 …); .200 does not.
    await prisma.reservation.createMany({
      data: [
        { subnetId, ipAddress: "10.70.0.2", hostname: "ON-PAGE", status: "active", sourceType: "manual", createdBy: "t" },
        { subnetId, ipAddress: "10.70.0.200", hostname: "OFF-PAGE", status: "active", sourceType: "manual", createdBy: "t" },
      ],
    });
    const resp = await agent.get(`/api/v1/subnets/${subnetId}/ips?page=1&pageSize=4`);
    expect(resp.status).toBe(200);
    const named = resp.body.ips
      .filter((i: any) => i.reservation)
      .map((i: any) => i.reservation.hostname);
    expect(named).toEqual(["ON-PAGE"]);
    // Paging metadata still describes the whole subnet.
    expect(resp.body.totalIps).toBeGreaterThan(4);
  });

  it("flags hasConflict from a conflict on a row the current page cannot show", async () => {
    const { agent, csrf } = await authedAgent(app);
    const subnetId = await seed(agent, csrf);
    await prisma.reservation.create({
      data: {
        subnetId, ipAddress: "10.70.0.240", hostname: "FAR-AWAY", status: "active",
        sourceType: "manual", createdBy: "t", conflictMessage: "discovery disagrees",
      },
    });
    const resp = await agent.get(`/api/v1/subnets/${subnetId}/ips?page=1&pageSize=4`);
    expect(resp.status).toBe(200);
    // Nothing on page 1 carries the conflict, but the subnet does.
    expect(resp.body.ips.some((i: any) => i.reservation)).toBe(false);
    expect(resp.body.subnet.hasConflict).toBe(true);
    expect(resp.body.subnet.conflictMessage).toBe("One or more IPs have conflicts");
  });

  it("reports no conflict when the subnet has none", async () => {
    const { agent, csrf } = await authedAgent(app);
    const subnetId = await seed(agent, csrf);
    const resp = await agent.get(`/api/v1/subnets/${subnetId}/ips?page=1&pageSize=4`);
    expect(resp.body.subnet.hasConflict).toBe(false);
    expect(resp.body.subnet.conflictMessage).toBeNull();
  });
});

// ─── GET /api/v1/subnets/:id ──────────────────────────────────────────────────

d("GET /api/v1/subnets/:id", () => {
  it("returns the subnet with its reservations", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.60.0.0/16");
    const sub = await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: block.id, cidr: "10.60.1.0/24", name: "S" });
    await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: sub.body.id, ipAddress: "10.60.1.10", hostname: "h01" });

    const resp = await agent.get(`/api/v1/subnets/${sub.body.id}`);
    expect(resp.status).toBe(200);
    expect(resp.body.id).toBe(sub.body.id);
    expect(Array.isArray(resp.body.reservations)).toBe(true);
    expect(resp.body.reservations.length).toBe(1);
    expect(resp.body.reservations[0].ipAddress).toBe("10.60.1.10");
  });

  it("returns 404 for an unknown id", async () => {
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/subnets/00000000-0000-0000-0000-000000000000");
    expect(resp.status).toBe(404);
  });
});

// ─── PUT /api/v1/subnets/:id ──────────────────────────────────────────────────

d("PUT /api/v1/subnets/:id", () => {
  it("updates subnet metadata (name, purpose, vlan, tags)", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.70.0.0/16");
    const sub = await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: block.id, cidr: "10.70.1.0/24", name: "Old" });
    const resp = await agent
      .put(`/api/v1/subnets/${sub.body.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ name: "New", purpose: "renamed", vlan: 200, tags: ["x", "y"] });
    expect(resp.status).toBe(200);
    expect(resp.body.name).toBe("New");
    expect(resp.body.purpose).toBe("renamed");
    expect(resp.body.vlan).toBe(200);
    expect(resp.body.tags).toEqual(["x", "y"]);
  });

  it("updates subnet status (available → deprecated)", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.71.0.0/16");
    const sub = await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: block.id, cidr: "10.71.1.0/24", name: "S" });
    const resp = await agent
      .put(`/api/v1/subnets/${sub.body.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ status: "deprecated" });
    expect(resp.status).toBe(200);
    expect(resp.body.status).toBe("deprecated");
  });
});

// ─── DELETE /api/v1/subnets/:id ───────────────────────────────────────────────

d("DELETE /api/v1/subnets/:id", () => {
  it("deletes a subnet with no active reservations", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.80.0.0/16");
    const sub = await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: block.id, cidr: "10.80.1.0/24", name: "S" });
    const resp = await agent.delete(`/api/v1/subnets/${sub.body.id}`).set("X-CSRF-Token", csrf);
    expect(resp.status).toBe(204);
    const after = await agent.get(`/api/v1/subnets/${sub.body.id}`);
    expect(after.status).toBe(404);
  });

  it("returns 409 when active reservations exist", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Parent", "10.81.0.0/16");
    const sub = await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: block.id, cidr: "10.81.1.0/24", name: "S" });
    await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: sub.body.id, ipAddress: "10.81.1.5", hostname: "h01" });
    const resp = await agent.delete(`/api/v1/subnets/${sub.body.id}`).set("X-CSRF-Token", csrf);
    expect(resp.status).toBe(409);
  });
});

// ─── Move to another block ───────────────────────────────────────────────────

d("POST /api/v1/subnets/:id/move", () => {
  it("re-parents the network and keeps its reservations, then frees the old block for deletion", async () => {
    const { agent, csrf } = await authedAgent(app);
    const from = await createBlock(agent, csrf, "Old", "10.84.0.0/16");
    const to = await createBlock(agent, csrf, "New", "10.84.0.0/15");
    const sub = await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: from.id, cidr: "10.84.1.0/24", name: "S" });
    await agent.post("/api/v1/reservations").set("X-CSRF-Token", csrf).send({ subnetId: sub.body.id, ipAddress: "10.84.1.5", hostname: "h01" });

    const resp = await agent.post(`/api/v1/subnets/${sub.body.id}/move`).set("X-CSRF-Token", csrf).send({ blockId: to.id });
    expect(resp.status).toBe(200);
    expect(resp.body.id).toBe(sub.body.id);
    expect(resp.body.blockId).toBe(to.id);
    expect(await prisma.reservation.count({ where: { subnetId: sub.body.id, status: "active" } })).toBe(1);
    expect(await waitForEventCount("subnet.moved", 1, sub.body.id)).toBe(1);

    const del = await agent.delete(`/api/v1/blocks/${from.id}`).set("X-CSRF-Token", csrf);
    expect(del.status).toBe(204);
  });

  it("refuses a block that does not contain the CIDR (rule 2)", async () => {
    const { agent, csrf } = await authedAgent(app);
    const from = await createBlock(agent, csrf, "Old", "10.85.0.0/16");
    const other = await createBlock(agent, csrf, "Elsewhere", "10.86.0.0/16");
    const sub = await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: from.id, cidr: "10.85.1.0/24", name: "S" });
    const resp = await agent.post(`/api/v1/subnets/${sub.body.id}/move`).set("X-CSRF-Token", csrf).send({ blockId: other.id });
    expect(resp.status).toBe(400);
    expect((await prisma.subnet.findUnique({ where: { id: sub.body.id } }))?.blockId).toBe(from.id);
  });

  it("refuses a destination holding an overlapping network (rule 1)", async () => {
    const { agent, csrf } = await authedAgent(app);
    const from = await createBlock(agent, csrf, "Old", "10.87.0.0/16");
    const to = await createBlock(agent, csrf, "New", "10.87.0.0/15");
    await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: to.id, cidr: "10.87.0.0/22", name: "Wide" });
    const sub = await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: from.id, cidr: "10.87.1.0/24", name: "S" });
    const resp = await agent.post(`/api/v1/subnets/${sub.body.id}/move`).set("X-CSRF-Token", csrf).send({ blockId: to.id });
    expect(resp.status).toBe(409);
    expect(resp.body.error).toMatch(/10\.87\.0\.0\/22/);
  });

  it("refuses a move into the block it is already in", async () => {
    const { agent, csrf } = await authedAgent(app);
    const from = await createBlock(agent, csrf, "Old", "10.88.0.0/16");
    const sub = await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: from.id, cidr: "10.88.1.0/24", name: "S" });
    const resp = await agent.post(`/api/v1/subnets/${sub.body.id}/move`).set("X-CSRF-Token", csrf).send({ blockId: from.id });
    expect(resp.status).toBe(400);
  });

  it("lists move targets: containing blocks only, overlapping ones flagged", async () => {
    const { agent, csrf } = await authedAgent(app);
    const from = await createBlock(agent, csrf, "Old", "10.89.0.0/16");
    const wide = await createBlock(agent, csrf, "Wide", "10.88.0.0/14");
    const busy = await createBlock(agent, csrf, "Busy", "10.89.0.0/20");
    await createBlock(agent, csrf, "Unrelated", "10.200.0.0/16");
    await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: busy.id, cidr: "10.89.0.0/23", name: "In the way" });
    const sub = await agent.post("/api/v1/subnets").set("X-CSRF-Token", csrf).send({ blockId: from.id, cidr: "10.89.1.0/24", name: "S" });

    const resp = await agent.get(`/api/v1/subnets/${sub.body.id}/move-targets`);
    expect(resp.status).toBe(200);
    const byId = Object.fromEntries(resp.body.map((t: any) => [t.id, t]));
    expect(Object.keys(byId).sort()).toEqual([busy.id, wide.id].sort());
    expect(byId[wide.id].overlaps).toBeNull();
    expect(byId[busy.id].overlaps).toBe("10.89.0.0/23");
  });
});

// ─── Audit events (service-layer logging) ───────────────────────────────────

d("subnet mutations write exactly one audit Event each", () => {
  beforeEach(async () => {
    await prisma.event.deleteMany({ where: { action: { startsWith: "subnet." } } });
  });

  it("manual create and auto-allocate write one subnet.created each, with distinct messages", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Evt Block", "10.82.0.0/16");

    const manual = await agent
      .post("/api/v1/subnets")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, cidr: "10.82.1.0/24", name: "evt-manual" });
    expect(manual.status).toBe(201);
    expect(await waitForEventCount("subnet.created", 1, manual.body.id)).toBe(1);
    const manualEvt = await prisma.event.findFirst({ where: { action: "subnet.created", resourceId: manual.body.id } });
    expect(manualEvt?.message).toContain("created");

    const auto = await agent
      .post("/api/v1/subnets/next-available")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, prefixLength: 24, name: "evt-auto" });
    expect(auto.status).toBe(201);
    expect(await waitForEventCount("subnet.created", 1, auto.body.id)).toBe(1);
    const autoEvt = await prisma.event.findFirst({ where: { action: "subnet.created", resourceId: auto.body.id } });
    expect(autoEvt?.message).toContain("auto-allocated");
  });

  it("bulk-allocate writes ONE subnet.bulk-allocated and zero per-subnet events", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Evt Bulk Block", "10.83.0.0/16");

    const resp = await agent
      .post("/api/v1/subnets/bulk-allocate")
      .set("X-CSRF-Token", csrf)
      .send({
        blockId: block.id,
        prefix: "EVT",
        entries: [
          { name: "a", prefixLength: 26 },
          { name: "b", prefixLength: 26 },
          { name: "c", prefixLength: 27 },
        ],
      });
    expect(resp.status).toBe(201);
    expect(resp.body.created.length).toBe(3);
    expect(await waitForEventCount("subnet.bulk-allocated", 1)).toBe(1);
    // The three tx.subnet.create calls inside the transaction must not emit.
    await new Promise((r) => setTimeout(r, 200));
    expect(await prisma.event.count({ where: { action: "subnet.created" } })).toBe(0);
  });

  it("update and delete each write one Event; validation failure writes none", async () => {
    const { agent, csrf } = await authedAgent(app);
    const block = await createBlock(agent, csrf, "Evt CRUD Block", "10.84.0.0/16");
    const sub = await agent
      .post("/api/v1/subnets")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, cidr: "10.84.1.0/24", name: "evt-crud" });
    expect(sub.status).toBe(201);
    const id = sub.body.id as string;

    const updated = await agent
      .put(`/api/v1/subnets/${id}`)
      .set("X-CSRF-Token", csrf)
      .send({ name: "evt-crud-2" });
    expect(updated.status).toBe(200);
    expect(await waitForEventCount("subnet.updated", 1, id)).toBe(1);

    // Overlap = validation failure -> zero additional subnet.created rows
    // beyond the one from the seed create above.
    const overlap = await agent
      .post("/api/v1/subnets")
      .set("X-CSRF-Token", csrf)
      .send({ blockId: block.id, cidr: "10.84.1.0/25", name: "evt-overlap" });
    expect(overlap.status).toBe(409);
    await new Promise((r) => setTimeout(r, 200));
    expect(await prisma.event.count({ where: { action: "subnet.created" } })).toBe(1);

    const del = await agent.delete(`/api/v1/subnets/${id}`).set("X-CSRF-Token", csrf);
    expect(del.status).toBe(204);
    expect(await waitForEventCount("subnet.deleted", 1, id)).toBe(1);
  });
});
