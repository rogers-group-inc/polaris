/**
 * tests/integration/azureTagsHidden.test.ts
 *
 * `azure:` tags are mirrored from Azure resource tags by the Arc sync. The tag
 * PICKER leaves them out (client-side, isPickerHiddenTag in public/js/app.js)
 * so an operator can never put an Azure tag on a device whose Arc resource
 * does not carry it; every other surface still shows them, so the tag
 * vocabularies keep listing them. Because the picker has no chip for them,
 * every operator write keeps the asset's own `azure:` tags (the edit form PUTs
 * a list without them) and drops any the body tries to add
 * (withArcOwnedTags / normalizeBulkTags).
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;

const HOST = "azure-tags-hidden-test";
const AZ = `azure:${HOST}=P1`;
const AZ_NEW = `azure:${HOST}=Forged`;
let id = "";

async function cleanup(): Promise<void> {
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST } } });
  await prisma.tag.deleteMany({ where: { name: { contains: HOST } } });
}

async function tagsOf(assetId: string): Promise<string[]> {
  const row = await prisma.asset.findUnique({ where: { id: assetId }, select: { tags: true } });
  return row?.tags ?? [];
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
    data: { hostname: `${HOST}-a`, assetType: "server", status: "active", tags: [`${HOST}-plain`, AZ] } as never,
  });
  id = a.id;
  await prisma.tag.create({ data: { name: AZ, category: "Azure Tags", color: "#4fc3f7" } });
  await prisma.tag.create({ data: { name: `${HOST}-plain`, category: "General", color: "#4ade80" } });
});

afterAll(async () => {
  if (!dbReachable) return;
  try {
    await cleanup();
    await prisma.$disconnect();
  } catch { /* noop */ }
});

d("azure: tags stay in the tag vocabularies (only the picker hides them)", () => {
  it("the catalogue still lists them — the picker filters client-side", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get("/api/v1/server-settings/tags/catalog");
    expect(res.status).toBe(200);
    expect((res.body.tags as { name: string }[]).map((t) => t.name)).toContain(AZ);
  });

  it("the distinct asset-tag list still offers them to filters", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get("/api/v1/assets/tags");
    expect(res.status).toBe(200);
    expect(res.body.tags).toContain(AZ);
  });
});

d("operator writes cannot add or remove an azure: tag", () => {
  it("an edit that omits the asset's azure: tag keeps it (the hidden-picker save)", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.put(`/api/v1/assets/${id}`).set("X-CSRF-Token", csrf).send({ tags: ["other"] });
    expect(res.status).toBe(200);
    expect((await tagsOf(id)).sort()).toEqual([AZ, "other"].sort());
  });

  it("an edit cannot add an azure: tag the Arc resource does not carry", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.put(`/api/v1/assets/${id}`).set("X-CSRF-Token", csrf).send({ tags: [`${HOST}-plain`, AZ_NEW] });
    expect(res.status).toBe(200);
    expect(await tagsOf(id)).not.toContain(AZ_NEW);
    expect(await tagsOf(id)).toContain(AZ);
  });

  it("a create drops every azure: tag in the body", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post("/api/v1/assets").set("X-CSRF-Token", csrf)
      .send({ hostname: `${HOST}-b`, assetType: "server", tags: ["kept", AZ_NEW] });
    expect(res.status).toBe(201);
    expect(await tagsOf(res.body.id)).toEqual(["kept"]);
  });

  it("bulk add ignores an azure: tag, and replace keeps the asset's own", async () => {
    const { agent, csrf } = await authedAgent(app);
    const add = await agent.post("/api/v1/assets/bulk-tags").set("X-CSRF-Token", csrf)
      .send({ ids: [id], mode: "add", tags: [AZ_NEW, "added"] });
    expect(add.status).toBe(200);
    expect(await tagsOf(id)).not.toContain(AZ_NEW);
    const replace = await agent.post("/api/v1/assets/bulk-tags").set("X-CSRF-Token", csrf)
      .send({ ids: [id], mode: "replace", tags: ["only"] });
    expect(replace.status).toBe(200);
    expect(await tagsOf(id)).toEqual([AZ, "only"]);
  });

  it("bulk remove cannot strip one", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post("/api/v1/assets/bulk-tags").set("X-CSRF-Token", csrf)
      .send({ ids: [id], mode: "remove", tags: [AZ, `${HOST}-plain`] });
    expect(res.status).toBe(200);
    expect(await tagsOf(id)).toEqual([AZ]);
  });
});
