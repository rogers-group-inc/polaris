/**
 * tests/integration/events.test.ts
 *
 * Integration tests for GET /api/v1/events. Covers the server-side sort +
 * filter UX added when the Events page adopted the TableSF pattern:
 *   - multi-value enum filters (level, resourceType) via CSV
 *   - operator-aware text filters (action, actor, message) — contains,
 *     not_contains, empty, is_not_empty
 *   - sort whitelist (timestamp | level | action | resourceType |
 *     resourceName | actor | message), with sortBy=level dispatching to
 *     orderBy: { levelRank } so severity sort is info < warning < error
 *   - 400 on a sortBy outside the whitelist
 *   - single-value level back-compat (?level=info still works post-change)
 *   - actor filter (drive-by — silently dropped pre-this-change)
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
  // Warm the process-cached agent up front: the first login writes an
  // auth.login.local audit Event, and doing it here lets beforeEach wipe it.
  // Logging in mid-test instead would contaminate the exact-total assertions
  // (the seeded counts assume the table holds only seedEvents() rows).
  await authedAgent(app);
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.event.deleteMany();
});

/** Seed a fixed set of events covering every filter / sort axis under test. */
async function seedEvents() {
  const now = Date.now();
  const rows = [
    { level: "info",    levelRank: 0, action: "block.created",        resourceType: "block",       resourceName: "alpha",   actor: "alice", message: "created block",  offsetMs: 6000 },
    { level: "warning", levelRank: 1, action: "subnet.updated",       resourceType: "subnet",      resourceName: "beta",    actor: "bob",   message: "updated subnet", offsetMs: 5000 },
    { level: "error",   levelRank: 2, action: "asset.discover.failed",resourceType: "asset",       resourceName: "gamma",   actor: "carol", message: "fortimanager unreachable", offsetMs: 4000 },
    { level: "info",    levelRank: 0, action: "reservation.created",  resourceType: "reservation", resourceName: "delta",   actor: "alice", message: "created reservation", offsetMs: 3000 },
    { level: "info",    levelRank: 0, action: "integration.sync",     resourceType: "integration", resourceName: null,      actor: null,    message: "", offsetMs: 2000 },
  ];
  for (const r of rows) {
    await prisma.event.create({
      data: {
        timestamp: new Date(now - r.offsetMs),
        level: r.level,
        levelRank: r.levelRank,
        action: r.action,
        resourceType: r.resourceType,
        resourceName: r.resourceName,
        actor: r.actor,
        message: r.message,
      },
    });
  }
}

// ─── GET /api/v1/events — filters ─────────────────────────────────────────────

d("GET /api/v1/events — multi-value enum filters", () => {
  it("multi-value level filter (CSV) returns rows matching any selected level", async () => {
    await seedEvents();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/events?level=info,warning");
    expect(resp.status).toBe(200);
    const levels = (resp.body.events as Array<{ level: string }>).map((e) => e.level);
    expect(levels).toEqual(expect.arrayContaining(["info", "warning"]));
    expect(levels).not.toContain("error");
    // Three info rows + one warning row = 4 total.
    expect(resp.body.total).toBe(4);
  });

  it("single-value level filter (?level=info) still works (back-compat)", async () => {
    await seedEvents();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/events?level=info");
    expect(resp.status).toBe(200);
    expect(resp.body.total).toBe(3);
    for (const ev of resp.body.events) expect(ev.level).toBe("info");
  });

  it("multi-value resourceType filter (CSV)", async () => {
    await seedEvents();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/events?resourceType=block,subnet");
    expect(resp.status).toBe(200);
    const types = (resp.body.events as Array<{ resourceType: string }>).map((e) => e.resourceType);
    expect(types).toEqual(expect.arrayContaining(["block", "subnet"]));
    expect(types).not.toContain("asset");
    expect(resp.body.total).toBe(2);
  });
});

d("GET /api/v1/events — operator-aware text filters", () => {
  it("default operator is contains (matches pre-this-change behavior)", async () => {
    await seedEvents();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/events?action=updated");
    expect(resp.status).toBe(200);
    expect(resp.body.total).toBe(1);
    expect(resp.body.events[0].action).toBe("subnet.updated");
  });

  it("not_contains excludes matching rows", async () => {
    await seedEvents();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/events?action=created&actionOp=not_contains");
    expect(resp.status).toBe(200);
    for (const ev of resp.body.events) {
      expect(ev.action).not.toMatch(/created/);
    }
    // 5 seeded - 2 with "created" = 3.
    expect(resp.body.total).toBe(3);
  });

  it("empty operator matches null + empty string", async () => {
    await seedEvents();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/events?messageOp=empty");
    expect(resp.status).toBe(200);
    expect(resp.body.total).toBe(1);
    expect(resp.body.events[0].action).toBe("integration.sync");
  });

  it("is_not_empty operator returns rows with non-blank values", async () => {
    await seedEvents();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/events?actorOp=is_not_empty");
    expect(resp.status).toBe(200);
    // 4 of 5 rows have an actor; the integration.sync row has actor=null.
    expect(resp.body.total).toBe(4);
    for (const ev of resp.body.events) expect(ev.actor).toBeTruthy();
  });

  it("resourceName filter narrows to one named resource", async () => {
    await seedEvents();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/events?resourceName=beta");
    expect(resp.status).toBe(200);
    expect(resp.body.total).toBe(1);
    expect(resp.body.events[0].resourceName).toBe("beta");
  });

  it("resourceName empty operator matches the null-name row", async () => {
    await seedEvents();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/events?resourceNameOp=empty");
    expect(resp.status).toBe(200);
    expect(resp.body.total).toBe(1);
    expect(resp.body.events[0].action).toBe("integration.sync");
  });

  it("actor filter is honored (drive-by — silently dropped pre-this-change)", async () => {
    await seedEvents();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/events?actor=alice");
    expect(resp.status).toBe(200);
    expect(resp.body.total).toBe(2);
    for (const ev of resp.body.events) expect(ev.actor).toBe("alice");
  });
});

// ─── GET /api/v1/events — sort whitelist ─────────────────────────────────────

d("GET /api/v1/events — sort whitelist", () => {
  it("default sort is timestamp desc", async () => {
    await seedEvents();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/events");
    expect(resp.status).toBe(200);
    const timestamps = (resp.body.events as Array<{ timestamp: string }>).map((e) => +new Date(e.timestamp));
    const sorted = [...timestamps].sort((a, b) => b - a);
    expect(timestamps).toEqual(sorted);
  });

  it("sortBy=action&sortDir=asc orders alphabetically", async () => {
    await seedEvents();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/events?sortBy=action&sortDir=asc");
    expect(resp.status).toBe(200);
    const actions = (resp.body.events as Array<{ action: string }>).map((e) => e.action);
    const sorted = [...actions].sort();
    expect(actions).toEqual(sorted);
  });

  it("sortBy=level dispatches to levelRank (severity order, not alphabetical)", async () => {
    await seedEvents();
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/events?sortBy=level&sortDir=asc");
    expect(resp.status).toBe(200);
    // Severity ascending = info, info, info, warning, error.
    // Alphabetical ascending would be error, info, info, info, warning.
    const levels = (resp.body.events as Array<{ level: string }>).map((e) => e.level);
    expect(levels[0]).toBe("info");
    expect(levels[levels.length - 1]).toBe("error");
  });

  it("returns 400 on a sortBy outside the whitelist", async () => {
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/events?sortBy=password");
    expect(resp.status).toBe(400);
  });
});

// ─── GET /api/v1/events?assetId= — the asset-details Events tab ──────────────

d("GET /api/v1/events — assetId (every event about one device)", () => {
  it("returns the device's own rows AND its alerts' fire / clear, and nothing about another device", async () => {
    // Written through logEvent, so the test also pins the write-time stamp:
    // the alert rows carry the device only in details.assetId.
    const { logEvent } = await import("../../src/services/eventLogService.js");
    await logEvent({ action: "asset.monitor.up", resourceType: "asset", resourceId: "dev-1", message: "up" });
    await logEvent({ action: "notification.triggered", resourceType: "notification", resourceId: "notif-1", message: "PoE fault", details: { ruleId: "r1", assetId: "dev-1" } });
    await logEvent({ action: "notification.auto_cleared", resourceType: "notification", resourceId: "notif-1", message: "resolved", details: { ruleId: "r1", assetId: "dev-1" } });
    await logEvent({ action: "notification.triggered", resourceType: "notification", resourceId: "notif-2", message: "other device", details: { ruleId: "r1", assetId: "dev-2" } });
    await logEvent({ action: "asset.monitor.up", resourceType: "asset", resourceId: "dev-2", message: "up" });

    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/events?assetId=dev-1");
    expect(resp.status).toBe(200);
    const actions = resp.body.events.map((e: { action: string }) => e.action).sort();
    expect(actions).toEqual(["asset.monitor.up", "notification.auto_cleared", "notification.triggered"]);
    expect(resp.body.total).toBe(3);
  });
});
