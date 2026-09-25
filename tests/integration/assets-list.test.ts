/**
 * tests/integration/assets-list.test.ts
 *
 * Integration tests for GET /api/v1/assets — the server-side filter / sort /
 * pagination the assets page adopted when it moved off the "fetch the whole
 * table into the browser" model onto the TableSF server-side pattern (mirrors
 * tests/integration/events.test.ts). Covers:
 *   - pagination (limit / offset / total)
 *   - multi-value enum filters: status, assetType (CSV)
 *   - the `_monitor` synthetic filter (Monitored / Unmonitored / Down / Dep. Down)
 *   - operator-aware text filters (hostname contains / not_contains; empty)
 *   - the `_server` filter spanning location + learnedLocation
 *   - sort whitelist + 400 on an unknown sortBy
 *   - favorites-first ordering: ?favoriteIds floats starred assets to the top
 *     of the WHOLE result set, ahead of the active sort
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
  await authedAgent(app);
});

afterAll(async () => {
  if (!dbReachable) return;
  // Don't leave seeded assets behind for downstream test files (the suite runs
  // --no-file-parallelism against a shared DB; tagAssignment.test.ts reconciles
  // tag criteria fleet-wide and was matching our Cisco fixture).
  await prisma.asset.deleteMany();
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.asset.deleteMany();
});

interface SeedRow {
  hostname: string;
  assetType: string;
  status: "active" | "maintenance" | "decommissioned";
  monitored: boolean;
  monitorStatus: string | null;
  manufacturer: string | null;
  location: string | null;
  learnedLocation: string | null;
  lastSeenOffsetDays: number;
}

const SEED: SeedRow[] = [
  { hostname: "alpha-srv",  assetType: "server",      status: "active",         monitored: true,  monitorStatus: "up",      manufacturer: "Dell",     location: "DC1", learnedLocation: null,  lastSeenOffsetDays: 1 },
  { hostname: "beta-sw",    assetType: "switch",      status: "active",         monitored: true,  monitorStatus: "down",    manufacturer: "Cisco",    location: "DC2", learnedLocation: null,  lastSeenOffsetDays: 2 },
  { hostname: "gamma-fw",   assetType: "firewall",    status: "maintenance",    monitored: true,  monitorStatus: "up",      manufacturer: "Fortinet", location: "DC1", learnedLocation: null,  lastSeenOffsetDays: 3 },
  { hostname: "delta-srv",  assetType: "server",      status: "decommissioned", monitored: false, monitorStatus: null,      manufacturer: "HP",       location: null,  learnedLocation: null,  lastSeenOffsetDays: 10 },
  { hostname: "epsilon-srv",assetType: "server",      status: "active",         monitored: false, monitorStatus: null,      manufacturer: "Dell",     location: null,  learnedLocation: "BR4", lastSeenOffsetDays: 20 },
  { hostname: "zeta-wks",   assetType: "workstation", status: "active",         monitored: true,  monitorStatus: "warning", manufacturer: null,       location: null,  learnedLocation: null,  lastSeenOffsetDays: 30 },
];

async function seedAssets() {
  const now = Date.now();
  for (const r of SEED) {
    await prisma.asset.create({
      data: {
        hostname: r.hostname,
        assetType: r.assetType,
        status: r.status,
        monitored: r.monitored,
        monitorStatus: r.monitorStatus,
        manufacturer: r.manufacturer,
        location: r.location,
        learnedLocation: r.learnedLocation,
        lastSeen: new Date(now - r.lastSeenOffsetDays * 24 * 60 * 60 * 1000),
      },
    });
  }
}

function hostnames(body: { assets: Array<{ hostname: string }> }): string[] {
  return body.assets.map((a) => a.hostname);
}

// ─── pagination ──────────────────────────────────────────────────────────────

d("GET /api/v1/assets — pagination", () => {
  it("returns one page and the full total", async () => {
    await seedAssets();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/assets?limit=2&offset=0");
    expect(resp.status).toBe(200);
    expect(resp.body.assets).toHaveLength(2);
    expect(resp.body.total).toBe(6);
    expect(resp.body.limit).toBe(2);
    expect(resp.body.offset).toBe(0);
  });

  it("offset walks through the result set without overlap", async () => {
    await seedAssets();
    const { agent } = await authedAgent(app);
    const p1 = await agent.get("/api/v1/assets?limit=3&offset=0&sortBy=hostname&sortDir=asc");
    const p2 = await agent.get("/api/v1/assets?limit=3&offset=3&sortBy=hostname&sortDir=asc");
    expect(hostnames(p1.body)).toEqual(["alpha-srv", "beta-sw", "delta-srv"]);
    expect(hostnames(p2.body)).toEqual(["epsilon-srv", "gamma-fw", "zeta-wks"]);
  });
});

// ─── multi-value enum filters ────────────────────────────────────────────────

d("GET /api/v1/assets — multi-value enum filters", () => {
  it("status CSV returns rows matching any selected status", async () => {
    await seedAssets();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/assets?status=active,maintenance");
    expect(resp.status).toBe(200);
    // 4 active + 1 maintenance = 5; the lone decommissioned row is excluded.
    expect(resp.body.total).toBe(5);
    expect(hostnames(resp.body)).not.toContain("delta-srv");
  });

  it("single-value status still works (back-compat)", async () => {
    await seedAssets();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/assets?status=maintenance");
    expect(resp.status).toBe(200);
    expect(resp.body.total).toBe(1);
    expect(resp.body.assets[0].hostname).toBe("gamma-fw");
  });

  it("assetType CSV", async () => {
    await seedAssets();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/assets?assetType=server,switch");
    expect(resp.status).toBe(200);
    // 3 servers + 1 switch = 4.
    expect(resp.body.total).toBe(4);
  });
});

// ─── _monitor synthetic filter ───────────────────────────────────────────────

d("GET /api/v1/assets — monitor filter", () => {
  it("Unmonitored returns only monitored=false rows", async () => {
    await seedAssets();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/assets?monitor=Unmonitored");
    expect(resp.status).toBe(200);
    expect(resp.body.total).toBe(2);
    expect(hostnames(resp.body).sort()).toEqual(["delta-srv", "epsilon-srv"]);
  });

  it("Down pins monitorStatus=down", async () => {
    await seedAssets();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/assets?monitor=Down");
    expect(resp.status).toBe(200);
    expect(resp.body.total).toBe(1);
    expect(resp.body.assets[0].hostname).toBe("beta-sw");
  });

  it("Monitored returns every monitored row regardless of direction", async () => {
    await seedAssets();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/assets?monitor=Monitored");
    expect(resp.status).toBe(200);
    expect(resp.body.total).toBe(4);
  });

  it("multiple monitor chips OR together", async () => {
    await seedAssets();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/assets?monitor=Down,Unmonitored");
    expect(resp.status).toBe(200);
    // beta (down) + delta + epsilon (unmonitored) = 3.
    expect(resp.body.total).toBe(3);
  });

  it("Dep. Down returns suppressed rows; directional chips exclude them", async () => {
    await seedAssets();
    // Suppressed + probe-down: the common case for a child behind a down
    // parent. Its pill reads "Dep. Down", so it must filter under that chip
    // and NOT under "Down".
    await prisma.asset.create({
      data: {
        hostname: "eta-ap", assetType: "access_point", status: "active",
        monitored: true, monitorStatus: "down", dependencySuppressed: true,
        lastSeen: new Date(),
      },
    });
    const { agent } = await authedAgent(app);

    const dep = await agent.get("/api/v1/assets?monitor=" + encodeURIComponent("Dep. Down"));
    expect(dep.status).toBe(200);
    expect(dep.body.total).toBe(1);
    expect(dep.body.assets[0].hostname).toBe("eta-ap");

    const down = await agent.get("/api/v1/assets?monitor=Down");
    expect(down.status).toBe(200);
    expect(down.body.total).toBe(1);
    expect(down.body.assets[0].hostname).toBe("beta-sw");

    // "Monitored" is direction-agnostic and still includes the suppressed row.
    const mon = await agent.get("/api/v1/assets?monitor=Monitored");
    expect(mon.body.total).toBe(5);
  });
});

// ─── operator-aware text filters ─────────────────────────────────────────────

d("GET /api/v1/assets — text filters", () => {
  it("default operator is contains", async () => {
    await seedAssets();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/assets?hostname=srv");
    expect(resp.status).toBe(200);
    // alpha-srv, delta-srv, epsilon-srv.
    expect(resp.body.total).toBe(3);
    for (const a of resp.body.assets) expect(a.hostname).toMatch(/srv/);
  });

  it("not_contains excludes matching rows", async () => {
    await seedAssets();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/assets?hostname=srv&hostnameOp=not_contains");
    expect(resp.status).toBe(200);
    expect(resp.body.total).toBe(3);
    for (const a of resp.body.assets) expect(a.hostname).not.toMatch(/srv/);
  });

  it("empty operator matches null + empty string (manufacturer)", async () => {
    await seedAssets();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/assets?manufacturerOp=empty");
    expect(resp.status).toBe(200);
    expect(resp.body.total).toBe(1);
    expect(resp.body.assets[0].hostname).toBe("zeta-wks");
  });

  it("_server filter spans location + learnedLocation", async () => {
    await seedAssets();
    const { agent } = await authedAgent(app);
    // BR4 lives only in learnedLocation (epsilon-srv).
    const resp = await agent.get("/api/v1/assets?server=BR4");
    expect(resp.status).toBe(200);
    expect(resp.body.total).toBe(1);
    expect(resp.body.assets[0].hostname).toBe("epsilon-srv");
  });
});

// ─── sort whitelist ──────────────────────────────────────────────────────────

d("GET /api/v1/assets — sort whitelist", () => {
  it("default sort is createdAt desc (newest first)", async () => {
    await seedAssets();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/assets");
    expect(resp.status).toBe(200);
    const created = (resp.body.assets as Array<{ createdAt: string }>).map((a) => +new Date(a.createdAt));
    expect(created).toEqual([...created].sort((a, b) => b - a));
  });

  it("sortBy=hostname&sortDir=asc orders alphabetically", async () => {
    await seedAssets();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/assets?sortBy=hostname&sortDir=asc");
    expect(resp.status).toBe(200);
    expect(hostnames(resp.body)).toEqual([...hostnames(resp.body)].sort());
  });

  it("returns 400 on a sortBy outside the whitelist", async () => {
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/assets?sortBy=passwordHash");
    expect(resp.status).toBe(400);
  });
});

// ─── favorites-first ─────────────────────────────────────────────────────────

d("GET /api/v1/assets — favorites-first ordering", () => {
  it("floats starred assets to the top of the whole result set", async () => {
    await seedAssets();
    const { agent } = await authedAgent(app);
    // Star two assets that would NOT be first under hostname-asc (zeta is last,
    // gamma is in the middle). With favoriteIds they must lead the page.
    const all = await agent.get("/api/v1/assets?sortBy=hostname&sortDir=asc&limit=100");
    const byName = Object.fromEntries(
      (all.body.assets as Array<{ id: string; hostname: string }>).map((a) => [a.hostname, a.id]),
    );
    const favIds = [byName["zeta-wks"], byName["gamma-fw"]].join(",");
    const resp = await agent.get(
      "/api/v1/assets?sortBy=hostname&sortDir=asc&limit=100&favoriteIds=" + favIds,
    );
    expect(resp.status).toBe(200);
    const names = hostnames(resp.body);
    // Favorites lead, each bucket internally hostname-asc: gamma, zeta first.
    expect(names.slice(0, 2)).toEqual(["gamma-fw", "zeta-wks"]);
    // Total is unchanged — favorites are part of the result set, not added.
    expect(resp.body.total).toBe(6);
  });

  it("favorites-first respects the page boundary (offset into non-favorites)", async () => {
    await seedAssets();
    const { agent } = await authedAgent(app);
    const all = await agent.get("/api/v1/assets?sortBy=hostname&sortDir=asc&limit=100");
    const byName = Object.fromEntries(
      (all.body.assets as Array<{ id: string; hostname: string }>).map((a) => [a.hostname, a.id]),
    );
    const favIds = [byName["zeta-wks"], byName["gamma-fw"]].join(",");
    // Page size 2 with 2 favorites: page 1 is the favorites, page 2 starts the
    // non-favorite bucket (hostname-asc: alpha, beta, ...).
    const page2 = await agent.get(
      "/api/v1/assets?sortBy=hostname&sortDir=asc&limit=2&offset=2&favoriteIds=" + favIds,
    );
    expect(page2.status).toBe(200);
    expect(hostnames(page2.body)).toEqual(["alpha-srv", "beta-sw"]);
  });
});

// ─── tags column ─────────────────────────────────────────────────────────────

d("GET /api/v1/assets — tags column", () => {
  async function seedTags() {
    await seedAssets();
    const tagsByHost: Record<string, string[]> = {
      "alpha-srv": ["Production", "dc1"],
      "beta-sw": ["lab"],
      "gamma-fw": ["edge", "100%_real"],
    };
    for (const [hostname, tags] of Object.entries(tagsByHost)) {
      await prisma.asset.updateMany({ where: { hostname }, data: { tags } });
    }
  }

  it("list rows carry their tags", async () => {
    await seedTags();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/assets?limit=100");
    const alpha = (resp.body.assets as Array<{ hostname: string; tags: string[] }>).find((a) => a.hostname === "alpha-srv");
    expect(alpha?.tags).toEqual(["Production", "dc1"]);
  });

  it("contains matches any single tag, case-insensitively", async () => {
    await seedTags();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/assets?tags=PROD&sortBy=hostname&sortDir=asc");
    expect(resp.status).toBe(200);
    expect(hostnames(resp.body)).toEqual(["alpha-srv"]);
    expect(resp.body.total).toBe(1);
  });

  it("LIKE wildcards in the term are literal", async () => {
    await seedTags();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/assets?tags=" + encodeURIComponent("0%_r"));
    expect(hostnames(resp.body)).toEqual(["gamma-fw"]);
    const none = await agent.get("/api/v1/assets?tags=" + encodeURIComponent("%"));
    expect(hostnames(none.body)).toEqual(["gamma-fw"]);
  });

  it("not_contains keeps untagged rows and rows whose tags miss the term", async () => {
    await seedTags();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/assets?tags=lab&tagsOp=not_contains&sortBy=hostname&sortDir=asc");
    expect(hostnames(resp.body)).toEqual(["alpha-srv", "delta-srv", "epsilon-srv", "gamma-fw", "zeta-wks"]);
  });

  it("empty / is_not_empty", async () => {
    await seedTags();
    const { agent } = await authedAgent(app);
    const empty = await agent.get("/api/v1/assets?tagsOp=empty&sortBy=hostname&sortDir=asc");
    expect(hostnames(empty.body)).toEqual(["delta-srv", "epsilon-srv", "zeta-wks"]);
    const set = await agent.get("/api/v1/assets?tagsOp=is_not_empty&sortBy=hostname&sortDir=asc");
    expect(hostnames(set.body)).toEqual(["alpha-srv", "beta-sw", "gamma-fw"]);
  });

  it("combines with the other column filters", async () => {
    await seedTags();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/assets?tagsOp=is_not_empty&assetType=server");
    expect(hostnames(resp.body)).toEqual(["alpha-srv"]);
  });

  it("sortBy=tags orders by first tag with untagged rows last, and pages", async () => {
    await seedTags();
    const { agent } = await authedAgent(app);
    // First tags (lowercased): alpha "dc1", beta "lab", gamma "100%_real".
    const asc = await agent.get("/api/v1/assets?sortBy=tags&sortDir=asc&limit=100");
    expect(asc.status).toBe(200);
    expect(hostnames(asc.body).slice(0, 3)).toEqual(["gamma-fw", "alpha-srv", "beta-sw"]);
    expect(asc.body.total).toBe(6);
    const desc = await agent.get("/api/v1/assets?sortBy=tags&sortDir=desc&limit=100");
    expect(hostnames(desc.body).slice(0, 3)).toEqual(["beta-sw", "alpha-srv", "gamma-fw"]);
    const page2 = await agent.get("/api/v1/assets?sortBy=tags&sortDir=asc&limit=2&offset=2");
    expect(hostnames(page2.body)[0]).toBe("beta-sw");
    expect(page2.body.assets).toHaveLength(2);
    expect(page2.body.total).toBe(6);
  });

  it("sortBy=tags honours favorites-first and the active filter", async () => {
    await seedTags();
    const { agent } = await authedAgent(app);
    const all = await agent.get("/api/v1/assets?limit=100");
    const byName = Object.fromEntries(
      (all.body.assets as Array<{ id: string; hostname: string }>).map((a) => [a.hostname, a.id]),
    );
    const resp = await agent.get(
      "/api/v1/assets?sortBy=tags&sortDir=asc&tagsOp=is_not_empty&limit=100&favoriteIds=" + byName["beta-sw"],
    );
    expect(hostnames(resp.body)).toEqual(["beta-sw", "gamma-fw", "alpha-srv"]);
    expect(resp.body.total).toBe(3);
  });
});
