/**
 * tests/integration/searchAssetFilter.test.ts — the global search gear's
 * `monitored` / `status` query parameters over the real database: the Prisma
 * filter (including `OR: []` as match-nothing), the `tag:` scope's raw SQL
 * (`status::text IN (...)` against the enum), the Device Map group, and the
 * 400 on an unknown value.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

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
  await prisma.assetSource.deleteMany();
  await prisma.asset.deleteMany();
  await prisma.asset.createMany({
    data: [
      { hostname: "GSF-ACTIVE-MON", assetType: "server", status: "active", monitored: true, tags: ["gsfplant"] },
      { hostname: "GSF-ACTIVE-UNMON", assetType: "server", status: "active", monitored: false, tags: ["gsfplant"] },
      { hostname: "GSF-MAINT", assetType: "server", status: "maintenance", monitored: true, tags: ["gsfplant"] },
      { hostname: "GSF-STORED", assetType: "server", status: "storage", monitored: false, tags: ["gsfplant"] },
      { hostname: "GSF-DECOM", assetType: "server", status: "decommissioned", monitored: false, tags: ["gsfplant"] },
      { hostname: "GSF-FW-DECOM", assetType: "firewall", status: "decommissioned", monitored: true, latitude: 36, longitude: -86 },
    ],
  });
});

const names = (hits: { title: string }[]) => hits.map((h) => h.title).sort();

d("GET /api/v1/search — the gear's asset filter", () => {
  it("with no filter, every state is searched (the API / phone contract)", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get("/api/v1/search").query({ q: "a:GSF" });
    expect(res.status).toBe(200);
    expect(res.body.assets).toHaveLength(6);
  });

  it("the defaults — both monitored sides, Active + Maintenance", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get("/api/v1/search")
      .query({ q: "GSF", monitored: "monitored,unmonitored", status: "active,maintenance" });
    expect(res.status).toBe(200);
    expect(names(res.body.assets)).toEqual(["GSF-ACTIVE-MON", "GSF-ACTIVE-UNMON", "GSF-MAINT"]);
    // A decommissioned Device Map pin is filtered out of its own group too.
    expect(res.body.sites).toEqual([]);
  });

  it("unmonitored only", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get("/api/v1/search").query({ q: "a:GSF", monitored: "unmonitored" });
    expect(names(res.body.assets)).toEqual(["GSF-ACTIVE-UNMON", "GSF-DECOM", "GSF-STORED"]);
  });

  it("neither monitored side ticked finds no asset", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get("/api/v1/search").query({ q: "a:GSF", monitored: "" });
    expect(res.status).toBe(200);
    expect(res.body.assets).toEqual([]);
  });

  it("the tag scope's raw SQL honours both filters", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get("/api/v1/search")
      .query({ q: "tag:gsfplant", monitored: "unmonitored", status: "active,storage" });
    expect(res.status).toBe(200);
    expect(names(res.body.assets)).toEqual(["GSF-ACTIVE-UNMON", "GSF-STORED"]);
  });

  it("the Device Map group returns a decommissioned pin when that state is ticked", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get("/api/v1/search").query({ q: "m:GSF-FW", status: "decommissioned" });
    expect(names(res.body.sites)).toEqual(["GSF-FW-DECOM"]);
  });

  it("refuses an unknown state with a 400", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get("/api/v1/search").query({ q: "GSF", status: "active,retired" });
    expect(res.status).toBe(400);
  });
});
