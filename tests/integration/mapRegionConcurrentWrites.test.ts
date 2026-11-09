/**
 * tests/integration/mapRegionConcurrentWrites.test.ts
 *
 * Concurrent region writes must not lose each other's edits.
 *
 * Every region mutation is a read-modify-write of ONE JSON blob (`Setting`
 * key `mapRegions`): load the whole array, change one element, write the whole
 * array back. Unlocked, two overlapping writers both read the same starting
 * array and the second write silently discards the first one's edit.
 *
 * That was not theoretical. The Device Map's edit mode saves every changed
 * polygon at once with `Promise.all(dirty.map(...))`, so dragging three regions
 * and clicking "Save Regions" reliably persisted only one of them — while all
 * three PUTs returned 200 and the toolbar reported "3 regions saved".
 *
 * This test HAS to hit a real database: the fix is a `pg_advisory_xact_lock`,
 * and a mocked Prisma client would make the lock a no-op and pass either way.
 * It skips cleanly when DATABASE_URL is unreachable (_helpers.ts).
 */

import { it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe } from "./_helpers.js";
import {
  createRegion,
  deleteRegion,
  invalidateRegionHierarchy,
  listRegions,
  updateRegion,
  type MapRegion,
} from "../../src/services/mapRegionService.js";

const SETTING_KEY = "mapRegions";
const NAMES = ["ccw-alpha", "ccw-bravo", "ccw-charlie", "ccw-delta", "ccw-echo"];

/** A small square near (40, -74), offset so each region is distinct. */
function square(offset: number): Array<[number, number]> {
  const lat = 40 + offset;
  const lng = -74 + offset;
  return [
    [lat, lng],
    [lat, lng + 0.1],
    [lat + 0.1, lng + 0.1],
    [lat + 0.1, lng],
  ];
}

/** Move a region somewhere unmistakable, so a lost write is obvious. */
function movedSquare(marker: number): Array<[number, number]> {
  const lat = 10 + marker;
  const lng = 20 + marker;
  return [
    [lat, lng],
    [lat, lng + 0.5],
    [lat + 0.5, lng + 0.5],
    [lat + 0.5, lng],
  ];
}

async function wipe() {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  const kept = Array.isArray(row?.value)
    ? (row!.value as unknown as MapRegion[]).filter((r) => !NAMES.includes(r.name))
    : [];
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: kept as never },
    create: { key: SETTING_KEY, value: kept as never },
  });
  await prisma.tag.deleteMany({ where: { name: { in: NAMES.map((n) => `region:${n}`) } } });
  invalidateRegionHierarchy();
}

dbDescribe("concurrent map-region writes", () => {
  beforeEach(wipe);
  afterAll(wipe);

  it("keeps EVERY edit when several regions are updated at once", async () => {
    // Exactly what the map does on Save Regions.
    const created: MapRegion[] = [];
    for (let i = 0; i < 4; i++) {
      created.push(await createRegion({ name: NAMES[i]!, polygon: square(i), actor: "test" }));
    }

    await Promise.all(
      created.map((r, i) => updateRegion(r.id, { polygon: movedSquare(i) })),
    );

    const after = await listRegions();
    for (let i = 0; i < created.length; i++) {
      const row = after.find((r) => r.id === created[i]!.id);
      expect(row, `${NAMES[i]} survived`).toBeTruthy();
      // The moved shape is what proves the write landed, not merely that the
      // region still exists.
      expect(row!.polygon, `${NAMES[i]} kept its new polygon`).toEqual(movedSquare(i));
    }
  });

  it("keeps every CREATE when several regions are created at once", async () => {
    await Promise.all(
      NAMES.slice(0, 4).map((name, i) => createRegion({ name, polygon: square(i), actor: "test" })),
    );
    const after = (await listRegions()).filter((r) => NAMES.includes(r.name));
    expect(after.map((r) => r.name).sort()).toEqual(NAMES.slice(0, 4).slice().sort());
  });

  it("does not resurrect a deleted region when a concurrent edit lands", async () => {
    const a = await createRegion({ name: NAMES[0]!, polygon: square(0), actor: "test" });
    const b = await createRegion({ name: NAMES[1]!, polygon: square(1), actor: "test" });

    await Promise.all([deleteRegion(a.id), updateRegion(b.id, { polygon: movedSquare(1) })]);

    const after = await listRegions();
    expect(after.find((r) => r.id === a.id), "deleted region stays deleted").toBeUndefined();
    expect(after.find((r) => r.id === b.id)?.polygon, "concurrent edit survived").toEqual(movedSquare(1));
  });

  it("still enforces the duplicate-name 409 under concurrency", async () => {
    // Both creates race for the same name; the loser must 409 rather than both
    // landing. Without the lock both read an array without the name and both
    // insert it.
    const results = await Promise.allSettled([
      createRegion({ name: NAMES[0]!, polygon: square(0), actor: "test" }),
      createRegion({ name: NAMES[0]!, polygon: square(1), actor: "test" }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const rows = (await listRegions()).filter((r) => r.name === NAMES[0]);
    expect(rows).toHaveLength(1);
  });

  it("keeps a rename and a sibling's polygon edit made at the same time", async () => {
    const a = await createRegion({ name: NAMES[0]!, polygon: square(0), actor: "test" });
    const b = await createRegion({ name: NAMES[1]!, polygon: square(1), actor: "test" });

    await Promise.all([
      updateRegion(a.id, { name: NAMES[2]! }),
      updateRegion(b.id, { polygon: movedSquare(3) }),
    ]);

    const after = await listRegions();
    expect(after.find((r) => r.id === a.id)?.name).toBe(NAMES[2]);
    expect(after.find((r) => r.id === b.id)?.polygon).toEqual(movedSquare(3));
  });
});
