/**
 * tests/integration/tagFilterRoutes.test.ts
 *
 * The tag registry's write surface, for the two things the service-level suite
 * can't see because they only exist at the route:
 *
 *   1. THE MAP REGIONS LOCK. That category belongs to the Device Map: every tag
 *      in it is minted by a region save and kept in step by the region reconcile
 *      through RegionTagAssignment provenance, so a hand-added sibling would be
 *      indistinguishable from one of those rows and owned by nothing. Creating a
 *      tag there is refused, MOVING one in is refused (same act), and a tag
 *      already there may not carry an auto-assign device filter — two
 *      managed-sync engines on one tag NAME would spend every cycle undoing each
 *      other. Editing the map's own row otherwise still works.
 *   2. THE FILTER SHAPE ON THE WIRE. `assetCondition` (the condition tree the
 *      shared builder posts) round-trips, an empty tree is stored as NO filter
 *      rather than as every asset, and writing either shape clears the other so
 *      a row never carries two answers to "which devices?".
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";
import { REGION_TAG_CATEGORY } from "../../src/services/mapRegionService.js";

const d = dbDescribe;
const PFX = "tagfilter-route-test";
const TAG_NAME = `${PFX}-tag`;

let agent: ReturnType<typeof request.agent>;
let csrf = "";

const TREE = {
  op: "and",
  children: [{ field: "manufacturer", operator: "equals", value: "Cisco" }],
};

/** The flat shape a pre-cutover row (or an old API caller) carries. */
const FLAT = {
  version: 1,
  match: "all",
  rules: [{ field: "model", op: "contains", values: ["FS-108"] }],
};

beforeAll(async () => {
  if (!dbReachable) return;
  await ensureTestUser();
  ({ agent, csrf } = await authedAgent(app));
});

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
});

async function cleanup(): Promise<void> {
  const tags = await prisma.tag.findMany({ where: { name: { startsWith: PFX } }, select: { id: true } });
  if (tags.length) {
    await prisma.tagAutoAssignment.deleteMany({ where: { tagId: { in: tags.map((t) => t.id) } } });
  }
  await prisma.tag.deleteMany({ where: { name: { startsWith: PFX } } });
  // The prefix-guard cases mint rows named `region:<PFX>-...`, which the
  // startsWith above cannot see.
  await prisma.tag.deleteMany({ where: { name: { startsWith: `region:${PFX}` } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
}

function post(body: unknown) {
  return agent.post("/api/v1/server-settings/tags").set("X-CSRF-Token", csrf).send(body as never);
}
function put(id: string, body: unknown) {
  return agent.put(`/api/v1/server-settings/tags/${id}`).set("X-CSRF-Token", csrf).send(body as never);
}

d("tag registry — the Map Regions lock", () => {
  it("refuses to CREATE a tag in the Device Map's category", async () => {
    const res = await post({ name: TAG_NAME, category: REGION_TAG_CATEGORY });
    expect(res.status).toBe(409);
    expect(String(res.body?.error ?? res.body?.message ?? "")).toContain("Device Map");
    expect(await prisma.tag.findUnique({ where: { name: TAG_NAME } })).toBeNull();
  });

  it("refuses to MOVE an existing tag into it — the same act as creating one", async () => {
    const created = await post({ name: TAG_NAME, category: "General" });
    expect(created.status).toBe(201);
    const res = await put(created.body.id, { name: TAG_NAME, category: REGION_TAG_CATEGORY });
    expect(res.status).toBe(409);
    const row = await prisma.tag.findUnique({ where: { id: created.body.id } });
    expect(row!.category).toBe("General");
  });

  it("still lets the map's OWN row be edited, and keeps its category", async () => {
    // The lock is about not adding to the category from the side, not about
    // freezing the rows already in it.
    const mapRow = await prisma.tag.create({
      data: { name: TAG_NAME, category: REGION_TAG_CATEGORY, color: "#4fc3f7" },
    });
    const res = await put(mapRow.id, { name: TAG_NAME, category: REGION_TAG_CATEGORY, color: "#ff0000" });
    expect(res.status).toBe(200);
    expect(res.body.color).toBe("#ff0000");
    expect(res.body.category).toBe(REGION_TAG_CATEGORY);
  });

  it("refuses to CREATE a tag whose NAME carries the region: prefix, whatever the category", async () => {
    // The category lock alone left this open: filed under General, a
    // `region:`-named row renders in the asset picker as though the Device Map
    // owned it, and — because the auto-assign filter ban is ALSO keyed on
    // category — it is the way to put a TagAutoAssignment filter on a region
    // name, which is the two-reconciler collision the ban exists to prevent.
    const res = await post({ name: `region:${PFX}-general`, category: "General" });
    expect(res.status).toBe(409);
    expect(String(res.body?.error ?? res.body?.message ?? "")).toContain("Device Map");
    expect(await prisma.tag.findUnique({ where: { name: `region:${PFX}-general` } })).toBeNull();
  });

  it("refuses the prefix case-insensitively", async () => {
    const res = await post({ name: `Region:${PFX}-caps`, category: "General" });
    expect(res.status).toBe(409);
  });

  it("refuses to RENAME a plain tag into the prefix", async () => {
    const created = await post({ name: TAG_NAME, category: "General" });
    expect(created.status).toBe(201);
    const res = await put(created.body.id, { name: `region:${PFX}-renamed` });
    expect(res.status).toBe(409);
    const row = await prisma.tag.findUnique({ where: { id: created.body.id } });
    expect(row!.name).toBe(TAG_NAME);
  });

  it("still lets the map's own region:-named row be recoloured", async () => {
    // The guard must not fire on a colour-only edit, where the handler falls
    // back to the existing name — which of course starts with the prefix.
    const mapRow = await prisma.tag.create({
      data: { name: `region:${PFX}-live`, category: REGION_TAG_CATEGORY, color: "#4fc3f7" },
    });
    const res = await put(mapRow.id, { color: "#ff0000" });
    expect(res.status).toBe(200);
    expect(res.body.color).toBe("#ff0000");
    expect(res.body.name).toBe(`region:${PFX}-live`);
  });

  it("refuses an auto-assign filter on a tag in that category", async () => {
    // RegionTagAssignment already manages these tag names; TagAutoAssignment on
    // the same NAME would be a second reconciler stripping the first's work.
    const mapRow = await prisma.tag.create({
      data: { name: TAG_NAME, category: REGION_TAG_CATEGORY, color: "#4fc3f7" },
    });
    const res = await put(mapRow.id, { assetCondition: TREE });
    expect(res.status).toBe(409);
    const row = await prisma.tag.findUnique({ where: { id: mapRow.id } });
    expect(row!.assetCondition).toBeNull();
  });
});

d("tag registry — the device filter on the wire", () => {
  it("round-trips a condition tree and applies it on save", async () => {
    await prisma.asset.create({
      data: { hostname: `${PFX}-cisco`, assetType: "server", status: "active", manufacturer: "Cisco" } as never,
    });

    const res = await post({ name: TAG_NAME, category: "General", assetCondition: TREE });
    expect(res.status).toBe(201);
    expect(res.body.assetCondition).toEqual(TREE);
    expect(res.body.criteria).toBeNull();

    // The create fires reconcileTag best-effort; poll rather than assume timing.
    let tags: string[] = [];
    for (let i = 0; i < 20; i++) {
      const row = await prisma.asset.findFirst({ where: { hostname: `${PFX}-cisco` }, select: { tags: true } });
      tags = row?.tags ?? [];
      if (tags.includes(TAG_NAME)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(tags).toContain(TAG_NAME);
  });

  it("stores an EMPTY tree as no filter, not as every asset", async () => {
    const res = await post({ name: TAG_NAME, category: "General", assetCondition: { op: "and", children: [] } });
    expect(res.status).toBe(201);
    expect(res.body.assetCondition).toBeNull();
  });

  it("clears the legacy flat blob when a tree is written", async () => {
    // Exactly one shape may be live on a row — a criteria blob left behind a
    // tree would be a second answer to "which devices?".
    const legacy = await prisma.tag.create({
      data: { name: TAG_NAME, category: "General", color: "#4fc3f7", criteria: FLAT as never },
    });
    const res = await put(legacy.id, { assetCondition: TREE });
    expect(res.status).toBe(200);
    const row = await prisma.tag.findUnique({ where: { id: legacy.id } });
    expect(row!.assetCondition).toEqual(TREE);
    expect(row!.criteria).toBeNull();
  });

  it("leaves the filter untouched when neither shape key is posted", async () => {
    // The editor omits both keys for a legacy filter it can't render, so a
    // colour-only save must not clear a live filter.
    const created = await post({ name: TAG_NAME, category: "General", assetCondition: TREE });
    const res = await put(created.body.id, { name: TAG_NAME, color: "#123456" });
    expect(res.status).toBe(200);
    const row = await prisma.tag.findUnique({ where: { id: created.body.id } });
    expect(row!.assetCondition).toEqual(TREE);
  });

  it("clears the filter on an explicit null (the toggle switched off)", async () => {
    const created = await post({ name: TAG_NAME, category: "General", assetCondition: TREE });
    const res = await put(created.body.id, { assetCondition: null });
    expect(res.status).toBe(200);
    const row = await prisma.tag.findUnique({ where: { id: created.body.id } });
    expect(row!.assetCondition).toBeNull();
    expect(row!.criteria).toBeNull();
  });

  it("hands the editor a folded tree for a tag still on the flat shape", async () => {
    await prisma.tag.create({
      data: { name: TAG_NAME, category: "General", color: "#4fc3f7", criteria: FLAT as never },
    });
    const res = await agent.get("/api/v1/server-settings/tags");
    expect(res.status).toBe(200);
    const row = (res.body as Array<Record<string, unknown>>).find((t) => t.name === TAG_NAME)!;
    expect(row.assetCondition).toBeNull();
    expect(row.assetConditionEffective).toEqual({
      op: "and",
      children: [{ field: "model", operator: "contains", value: "FS-108" }],
    });
    expect(row.assetFilterUnconvertible).toEqual([]);
  });

  it("serves the builder vocabulary with the WIDE device-filter field set", async () => {
    const res = await agent.get("/api/v1/server-settings/tags/filter-schema");
    expect(res.status).toBe(200);
    const fields = (res.body?.scopeCondition?.fields ?? []).map((f: { field: string }) => f.field);
    // The four the flat tag builder already offered — anything narrower would
    // make the shape cutover a regression.
    for (const f of ["osVersion", "department", "location", "fortigate"]) {
      expect(fields).toContain(f);
    }
    expect(res.body.regionCategory).toBe(REGION_TAG_CATEGORY);
  });
});
