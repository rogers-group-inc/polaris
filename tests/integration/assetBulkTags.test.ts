/**
 * tests/integration/assetBulkTags.test.ts
 *
 * POST /api/v1/assets/bulk-tags — the bulk bar's add / remove / replace tag
 * edit (assetBulkTagService). Two assets with DIFFERENT starting tags, because
 * a mixed selection is the case the add mode exists for.
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;

const HOST = "asset-bulk-tags-test";
let idA = "";
let idB = "";

async function cleanup(): Promise<void> {
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST } } });
}

async function tagsOf(id: string): Promise<string[]> {
  const row = await prisma.asset.findUnique({ where: { id }, select: { tags: true } });
  return row?.tags ?? [];
}

async function post(body: unknown) {
  const { agent, csrf } = await authedAgent(app);
  return agent.post("/api/v1/assets/bulk-tags").set("X-CSRF-Token", csrf).send(body as object);
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  const a = await prisma.asset.create({
    data: { hostname: `${HOST}-a`, assetType: "server", status: "active", tags: ["alpha", "shared"] } as never,
  });
  const b = await prisma.asset.create({
    data: { hostname: `${HOST}-b`, assetType: "server", status: "active", tags: ["beta", "prev-entra:xyz"] } as never,
  });
  idA = a.id;
  idB = b.id;
});

afterAll(async () => {
  if (!dbReachable) return;
  try {
    await cleanup();
    await prisma.$disconnect();
  } catch { /* noop */ }
});

d("POST /assets/bulk-tags", () => {
  it("add keeps each asset's own tags and appends the new ones", async () => {
    const res = await post({ ids: [idA, idB], mode: "add", tags: ["shared", "new"] });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    expect(await tagsOf(idA)).toEqual(["alpha", "shared", "new"]);
    expect(await tagsOf(idB)).toEqual(["beta", "prev-entra:xyz", "shared", "new"]);
  });

  it("remove strips only from assets that carry the tag", async () => {
    const res = await post({ ids: [idA, idB], mode: "remove", tags: ["shared"] });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    expect(res.body.unchanged).toBe(1);
    expect(await tagsOf(idA)).toEqual(["alpha"]);
    expect(await tagsOf(idB)).toEqual(["beta", "prev-entra:xyz"]);
  });

  it("replace sets exactly the chosen tags but keeps discovery breadcrumbs", async () => {
    const res = await post({ ids: [idA, idB], mode: "replace", tags: ["only"] });
    expect(res.status).toBe(200);
    expect(await tagsOf(idA)).toEqual(["only"]);
    expect(await tagsOf(idB)).toEqual(["prev-entra:xyz", "only"]);
  });

  it("writes an audit Event", async () => {
    const before = new Date();
    await post({ ids: [idA], mode: "add", tags: ["audited"] });
    // logEvent is fire-and-forget; give it a beat to land.
    await new Promise((r) => setTimeout(r, 200));
    const ev = await prisma.event.findFirst({
      where: { action: "asset.bulk_tags", timestamp: { gte: before } },
      orderBy: { timestamp: "desc" },
    });
    expect(ev?.message).toContain("audited");
  });

  it("reports unknown ids without failing the batch", async () => {
    const ghost = "00000000-0000-4000-8000-000000000000";
    const res = await post({ ids: [idA, ghost], mode: "add", tags: ["x"] });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    expect(res.body.notFound).toEqual([ghost]);
  });

  it("400s on add with no tags", async () => {
    const res = await post({ ids: [idA], mode: "add", tags: [] });
    expect(res.status).toBe(400);
  });

  it("400s on adding a region: tag that names no region", async () => {
    const res = await post({ ids: [idA], mode: "add", tags: ["region:NoSuchRegion-bulk-test"] });
    expect(res.status).toBe(400);
    expect(await tagsOf(idA)).toEqual(["alpha", "shared"]);
  });
});
