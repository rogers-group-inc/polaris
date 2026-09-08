/**
 * tests/integration/assetHostnameDiscovered.test.ts
 *
 * `hostnameDiscovered` on the asset list + detail payloads — the discovery-
 * projected hostname the assets-page Hostname cell prints under an
 * operator-pinned one.
 *
 * The interesting part is that it is NOT a column: `Asset.hostnameOverride`
 * makes the pinned value the effective `hostname`, so the discovered name is
 * recoverable only from the `AssetSource.observed` blobs. These tests pin
 * through the real PUT route (rather than writing `hostnameOverride` directly)
 * so the pin + the projection stay in the same relationship the UI creates,
 * and assert the three "print nothing" cases the frontend relies on.
 *
 * The second half covers the inverse read: a pinned row shows the operator TWO
 * names, so both the Hostname column filter and the global search have to find
 * it by either one.
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
  await prisma.asset.deleteMany();
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.asset.deleteMany();
});

/**
 * An asset with one AD source claiming `dnsHostName`, projected onto the Asset
 * row the way discovery leaves it.
 */
async function seedDiscovered(dnsHostName: string): Promise<string> {
  const asset = await prisma.asset.create({
    data: { hostname: dnsHostName, assetType: "workstation", status: "active" },
  });
  await prisma.assetSource.create({
    data: {
      assetId: asset.id,
      sourceKind: "ad",
      externalId: "ad-guid:" + asset.id,
      observed: { dnsHostName },
    },
  });
  return asset.id;
}

/** Pin (or, with "", clear) an asset's hostname through the real edit route. */
async function putHostname(id: string, hostname: string) {
  const { agent, csrf } = await authedAgent(app);
  return agent.put("/api/v1/assets/" + id).set("X-CSRF-Token", csrf).send({ hostname });
}

d("GET /api/v1/assets — hostnameDiscovered", () => {
  it("names the discovered hostname on a pinned row, on both list and detail", async () => {
    const id = await seedDiscovered("WKS-OLD.corp.local");
    const { agent } = await authedAgent(app);

    const put = await putHostname(id, "reception-pc");
    expect(put.status).toBe(200);
    expect(put.body.hostname).toBe("reception-pc");
    expect(put.body.hostnameOverride).toBe("reception-pc");

    const list = await agent.get("/api/v1/assets?limit=100");
    expect(list.status).toBe(200);
    const row = (list.body.assets as Array<Record<string, unknown>>).find((a) => a.id === id);
    expect(row?.hostname).toBe("reception-pc");
    expect(row?.hostnameOverride).toBe("reception-pc");
    expect(row?.hostnameDiscovered).toBe("WKS-OLD.corp.local");

    const detail = await agent.get("/api/v1/assets/" + id);
    expect(detail.status).toBe(200);
    expect(detail.body.hostnameDiscovered).toBe("WKS-OLD.corp.local");
  });

  it("tracks what discovery says NOW, not what it said when the pin was typed", async () => {
    const id = await seedDiscovered("WKS-OLD.corp.local");
    const { agent } = await authedAgent(app);
    await putHostname(id, "reception-pc");

    // A later discovery cycle renames the device at the source. The pin keeps
    // the Asset row on "reception-pc" (the db.ts guard), and the sub-line is
    // expected to follow the source.
    await prisma.assetSource.updateMany({
      where: { assetId: id, sourceKind: "ad" },
      data: { observed: { dnsHostName: "WKS-NEW.corp.local" } },
    });

    const list = await agent.get("/api/v1/assets?limit=100");
    const row = (list.body.assets as Array<Record<string, unknown>>).find((a) => a.id === id);
    expect(row?.hostname).toBe("reception-pc");
    expect(row?.hostnameDiscovered).toBe("WKS-NEW.corp.local");
  });

  it("is null on an unpinned row, and on a pinned row with no discovery opinion", async () => {
    // Unpinned but discovered — nothing is being overridden, so no second line.
    const discovered = await seedDiscovered("plain-pc.corp.local");
    // Manually created (no sources at all), then pinned: there IS no original.
    const manual = await prisma.asset.create({
      data: { hostname: "hand-made", assetType: "server", status: "active" },
    });
    const { agent } = await authedAgent(app);
    const put = await putHostname(manual.id, "hand-made-2");
    expect(put.body.hostnameOverride).toBe("hand-made-2");

    const list = await agent.get("/api/v1/assets?limit=100");
    const rows = list.body.assets as Array<Record<string, unknown>>;
    expect(rows.find((a) => a.id === discovered)?.hostnameDiscovered).toBeNull();
    expect(rows.find((a) => a.id === manual.id)?.hostnameDiscovered).toBeNull();
  });

  it("clearing the pin drops the second line and restores the discovered name", async () => {
    const id = await seedDiscovered("WKS-OLD.corp.local");
    const { agent } = await authedAgent(app);
    await putHostname(id, "reception-pc");

    const cleared = await putHostname(id, "");
    expect(cleared.status).toBe(200);
    expect(cleared.body.hostnameOverride).toBeNull();
    expect(cleared.body.hostname).toBe("WKS-OLD.corp.local");

    const list = await agent.get("/api/v1/assets?limit=100");
    const row = (list.body.assets as Array<Record<string, unknown>>).find((a) => a.id === id);
    expect(row?.hostnameDiscovered).toBeNull();
  });
});

d("GET /api/v1/assets — Hostname filter spans both names", () => {
  it("finds a pinned row by its discovered name and by its pin", async () => {
    const id = await seedDiscovered("axis-b8a44f47d582");
    const { agent } = await authedAgent(app);
    await putHostname(id, "Peoria Scale Camera");

    // The pinned name — the value actually in the `hostname` column.
    const byPin = await agent.get("/api/v1/assets?hostname=peoria%20scale&limit=100");
    expect(byPin.status).toBe(200);
    expect((byPin.body.assets as Array<Record<string, unknown>>).map((a) => a.id)).toEqual([id]);
    expect(byPin.body.total).toBe(1);

    // The discovered name — in no column at all, only in the source blob.
    const byDiscovered = await agent.get("/api/v1/assets?hostname=b8a44f47&limit=100");
    expect(byDiscovered.status).toBe(200);
    expect((byDiscovered.body.assets as Array<Record<string, unknown>>).map((a) => a.id)).toEqual([id]);
    // `total` comes from a second count() on the same where — the discovered
    // half has to be in the where clause, not filtered out of the page.
    expect(byDiscovered.body.total).toBe(1);
  });

  it("matches the projected name only, not any old field in the source blob", async () => {
    const id = await seedDiscovered("axis-b8a44f47d582");
    // A second field in the same blob mentioning a term that is NOT the
    // hostname: the SQL narrow matches the whole blob, the projection confirm
    // is what keeps the filter honest.
    await prisma.assetSource.updateMany({
      where: { assetId: id, sourceKind: "ad" },
      data: { observed: { dnsHostName: "axis-b8a44f47d582", description: "loading-dock spare" } },
    });
    const { agent } = await authedAgent(app);
    await putHostname(id, "Peoria Scale Camera");

    const hit = await agent.get("/api/v1/assets?hostname=loading-dock&limit=100");
    expect(hit.status).toBe(200);
    expect(hit.body.assets).toHaveLength(0);
  });

  it("not_contains rejects the row when EITHER name matches", async () => {
    const pinned = await seedDiscovered("axis-b8a44f47d582");
    const other = await seedDiscovered("switch-lobby.corp.local");
    const { agent } = await authedAgent(app);
    await putHostname(pinned, "Peoria Scale Camera");

    // Excluding the discovered name has to drop the pinned row even though its
    // `hostname` column says "Peoria Scale Camera".
    const byDiscovered = await agent.get("/api/v1/assets?hostname=axis&hostnameOp=not_contains&limit=100");
    expect(byDiscovered.status).toBe(200);
    expect((byDiscovered.body.assets as Array<Record<string, unknown>>).map((a) => a.id)).toEqual([other]);

    // Excluding the pin drops it too (the plain column behavior, unchanged).
    const byPin = await agent.get("/api/v1/assets?hostname=peoria&hostnameOp=not_contains&limit=100");
    expect((byPin.body.assets as Array<Record<string, unknown>>).map((a) => a.id)).toEqual([other]);
  });

  it("leaves the empty / is_not_empty ops alone — a pinned cell is never empty", async () => {
    const id = await seedDiscovered("axis-b8a44f47d582");
    const { agent } = await authedAgent(app);
    await putHostname(id, "Peoria Scale Camera");
    await prisma.asset.create({ data: { assetType: "other", status: "active" } });

    const notEmpty = await agent.get("/api/v1/assets?hostnameOp=is_not_empty&limit=100");
    expect((notEmpty.body.assets as Array<Record<string, unknown>>).map((a) => a.id)).toEqual([id]);
    const empty = await agent.get("/api/v1/assets?hostnameOp=empty&limit=100");
    expect(empty.body.assets).toHaveLength(1);
    expect((empty.body.assets as Array<Record<string, unknown>>)[0].id).not.toBe(id);
  });
});

d("GET /api/v1/search — a pinned asset answers to both names", () => {
  it("finds it by the pin and by the discovered name, and says which", async () => {
    const id = await seedDiscovered("axis-b8a44f47d582");
    const { agent } = await authedAgent(app);
    await putHostname(id, "Peoria Scale Camera");

    const byPin = await agent.get("/api/v1/search?q=Peoria%20Scale");
    expect(byPin.status).toBe(200);
    const pinHit = (byPin.body.assets as Array<Record<string, unknown>>).find((h) => h.id === id);
    expect(pinHit?.title).toBe("Peoria Scale Camera");
    // Found by the column, so nothing needs explaining.
    expect(String(pinHit?.subtitle ?? "")).not.toContain("discovered:");

    const byDiscovered = await agent.get("/api/v1/search?q=b8a44f47d582");
    expect(byDiscovered.status).toBe(200);
    const hit = (byDiscovered.body.assets as Array<Record<string, unknown>>).find((h) => h.id === id);
    expect(hit).toBeTruthy();
    // The title is the pin, so the hit names the half that actually matched.
    expect(hit?.title).toBe("Peoria Scale Camera");
    expect(String(hit?.subtitle ?? "")).toContain("discovered: axis-b8a44f47d582");
  });

  it("does not label an unpinned asset found by its own hostname", async () => {
    const id = await seedDiscovered("plain-pc.corp.local");
    const { agent } = await authedAgent(app);
    const res = await agent.get("/api/v1/search?q=plain-pc");
    const hit = (res.body.assets as Array<Record<string, unknown>>).find((h) => h.id === id);
    expect(hit?.title).toBe("plain-pc.corp.local");
    expect(String(hit?.subtitle ?? "")).not.toContain("discovered:");
  });
});
