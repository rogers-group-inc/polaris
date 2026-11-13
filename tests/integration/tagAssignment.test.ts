/**
 * tests/integration/tagAssignment.test.ts
 *
 * Service-level integration coverage for filter-based tag auto-assignment
 * (src/services/tagAssignmentService.ts). DB-driven (Prisma reads/writes +
 * raw inet containment), so we drive the service and assert against the
 * resulting Asset.tags arrays + TagAutoAssignment provenance rows. Skips
 * cleanly when DATABASE_URL is unreachable (see _helpers.ts).
 *
 * Behavior exercised (read from the service, not assumed):
 *   - reconcileTag ADDS the tag to matching assets + records provenance.
 *   - reconcileTag REMOVES the tag from drifted assets (managed sync), and
 *     deletes their provenance.
 *   - A hand-applied copy of the same tag name on a NON-matching asset (no
 *     provenance) is preserved forever.
 *   - Subnet/CIDR membership works (v4) via the inet query.
 *   - Clearing the filter strips engine-owned copies.
 *   - previewTagFilter returns match count + diff without writing.
 *
 * Both filter SHAPES are exercised: the current `assetCondition` condition tree
 * and the legacy flat `criteria` blob, which still has to keep matching until
 * migrateTagFilterShape folds it forward.
 */

import { it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import {
  reconcileTag,
  reconcileAllTags,
  reconcileTagsForAsset,
  previewTagFilter,
  stripTagAssignments,
} from "../../src/services/tagAssignmentService.js";

const d = dbDescribe;

const TAG_NAME = "auto-test-tag";
const BLOCK_CIDR = "10.88.0.0/16";
const SUBNET_CIDR = "10.88.1.0/24";

/** A tag on the LEGACY flat shape. */
async function makeTag(criteria: unknown) {
  return prisma.tag.create({
    data: {
      name: TAG_NAME,
      category: "Test",
      color: "#4fc3f7",
      criteria: criteria as any,
    },
  });
}

/** A tag on the CURRENT shape — the shared device-filter condition tree. */
async function makeCondTag(assetCondition: unknown) {
  return prisma.tag.create({
    data: {
      name: TAG_NAME,
      category: "Test",
      color: "#4fc3f7",
      assetCondition: assetCondition as any,
    },
  });
}

async function makeAsset(over: Record<string, unknown>) {
  return prisma.asset.create({
    data: {
      assetType: "server",
      status: "active",
      ...over,
    } as any,
  });
}

async function cleanup() {
  if (!dbReachable) return;
  await prisma.tagAutoAssignment.deleteMany({});
  await prisma.tag.deleteMany({ where: { name: TAG_NAME } });
  // reconcileTag matches its criteria fleet-wide, so the asset table must be
  // empty of *any* asset another test file may have left behind (e.g. the
  // Cisco-manufacturer fixture in assets-list.test.ts), not just our own.
  await prisma.asset.deleteMany();
  await prisma.subnet.deleteMany({ where: { cidr: SUBNET_CIDR } });
  await prisma.ipBlock.deleteMany({ where: { cidr: BLOCK_CIDR } });
}

beforeEach(cleanup);
afterAll(cleanup);

d("tagAssignmentService.reconcileTag", () => {
  it("adds the tag to matching assets and records provenance", async () => {
    const tag = await makeTag({ version: 1, match: "all", rules: [{ field: "manufacturer", op: "exact", values: ["Cisco"] }] });
    const match = await makeAsset({ hostname: "tagtest-a", manufacturer: "Cisco" });
    const nonMatch = await makeAsset({ hostname: "tagtest-b", manufacturer: "Juniper" });

    const summary = await reconcileTag(tag.id);
    expect(summary.added).toBe(1);

    const a = await prisma.asset.findUnique({ where: { id: match.id } });
    const b = await prisma.asset.findUnique({ where: { id: nonMatch.id } });
    expect(a!.tags).toContain(TAG_NAME);
    expect(b!.tags).not.toContain(TAG_NAME);

    const prov = await prisma.tagAutoAssignment.findMany({ where: { tagId: tag.id } });
    expect(prov.map((p) => p.assetId)).toEqual([match.id]);
  });

  it("removes the tag when an asset drifts out of match", async () => {
    const tag = await makeTag({ version: 1, match: "all", rules: [{ field: "manufacturer", op: "exact", values: ["Cisco"] }] });
    const asset = await makeAsset({ hostname: "tagtest-c", manufacturer: "Cisco" });
    await reconcileTag(tag.id);
    expect((await prisma.asset.findUnique({ where: { id: asset.id } }))!.tags).toContain(TAG_NAME);

    // Drift: manufacturer changes so it no longer matches.
    await prisma.asset.update({ where: { id: asset.id }, data: { manufacturer: "Juniper" } });
    const summary = await reconcileTag(tag.id);
    expect(summary.removed).toBe(1);

    const after = await prisma.asset.findUnique({ where: { id: asset.id } });
    expect(after!.tags).not.toContain(TAG_NAME);
    expect(await prisma.tagAutoAssignment.count({ where: { tagId: tag.id } })).toBe(0);
  });

  it("never removes a hand-applied copy on a non-matching asset (no provenance)", async () => {
    const tag = await makeTag({ version: 1, match: "all", rules: [{ field: "manufacturer", op: "exact", values: ["Cisco"] }] });
    // Hand-applied tag on an asset that does NOT match the criteria.
    const manual = await makeAsset({ hostname: "tagtest-d", manufacturer: "Juniper", tags: [TAG_NAME] });

    await reconcileTag(tag.id);
    const after = await prisma.asset.findUnique({ where: { id: manual.id } });
    expect(after!.tags).toContain(TAG_NAME); // preserved
    expect(await prisma.tagAutoAssignment.count({ where: { tagId: tag.id, assetId: manual.id } })).toBe(0);
  });

  it("matches assets by subnet/CIDR membership", async () => {
    const block = await prisma.ipBlock.create({ data: { name: "Tag Test Block", cidr: BLOCK_CIDR, ipVersion: "v4" } });
    await prisma.subnet.create({ data: { blockId: block.id, cidr: SUBNET_CIDR, name: "Tag Test Subnet", status: "available" } });
    const tag = await makeTag({ version: 1, match: "all", rules: [{ field: "subnet", op: "inCidr", cidrs: [SUBNET_CIDR] }] });

    const inSubnet = await makeAsset({ hostname: "tagtest-e", ipAddress: "10.88.1.20" });
    const outSubnet = await makeAsset({ hostname: "tagtest-f", ipAddress: "10.99.1.20" });

    await reconcileTag(tag.id);
    expect((await prisma.asset.findUnique({ where: { id: inSubnet.id } }))!.tags).toContain(TAG_NAME);
    expect((await prisma.asset.findUnique({ where: { id: outSubnet.id } }))!.tags).not.toContain(TAG_NAME);
  });

  it("strips engine-owned copies when criteria are cleared", async () => {
    const tag = await makeTag({ version: 1, match: "all", rules: [{ field: "manufacturer", op: "exact", values: ["Cisco"] }] });
    const asset = await makeAsset({ hostname: "tagtest-g", manufacturer: "Cisco" });
    await reconcileTag(tag.id);
    expect((await prisma.asset.findUnique({ where: { id: asset.id } }))!.tags).toContain(TAG_NAME);

    // Clear criteria → reconcile should strip the engine-owned copy.
    await prisma.tag.update({ where: { id: tag.id }, data: { criteria: undefined } });
    // (undefined leaves the column unchanged; emulate the route's DbNull clear)
    await prisma.$executeRaw`UPDATE tags SET criteria = NULL WHERE id = ${tag.id}`;
    const summary = await reconcileTag(tag.id);
    expect(summary.removed).toBe(1);
    expect((await prisma.asset.findUnique({ where: { id: asset.id } }))!.tags).not.toContain(TAG_NAME);
  });

  it("stripTagAssignments removes all engine-owned copies", async () => {
    const tag = await makeTag({ version: 1, match: "all", rules: [{ field: "manufacturer", op: "exact", values: ["Cisco"] }] });
    const a1 = await makeAsset({ hostname: "tagtest-h", manufacturer: "Cisco" });
    const a2 = await makeAsset({ hostname: "tagtest-i", manufacturer: "Cisco" });
    await reconcileTag(tag.id);
    const stripped = await stripTagAssignments(tag.id, tag.name);
    expect(stripped).toBe(2);
    expect((await prisma.asset.findUnique({ where: { id: a1.id } }))!.tags).not.toContain(TAG_NAME);
    expect((await prisma.asset.findUnique({ where: { id: a2.id } }))!.tags).not.toContain(TAG_NAME);
  });
});

d("tagAssignmentService.previewTagFilter", () => {
  it("returns match count + diff without writing", async () => {
    const tag = await makeTag({ version: 1, match: "all", rules: [{ field: "manufacturer", op: "exact", values: ["Cisco"] }] });
    await makeAsset({ hostname: "tagtest-j", manufacturer: "Cisco" });
    await makeAsset({ hostname: "tagtest-k", manufacturer: "Cisco" });

    const preview = await previewTagFilter(
      { criteria: { version: 1, match: "all", rules: [{ field: "manufacturer", op: "exact", values: ["Cisco"] }] } },
      tag.id,
    );
    expect(preview.matchCount).toBe(2);
    expect(preview.diff).toEqual({ add: 2, remove: 0 }); // nothing applied yet
    // No writes: no provenance rows created by a preview.
    expect(await prisma.tagAutoAssignment.count({ where: { tagId: tag.id } })).toBe(0);
  });
});

// ─── The condition-tree shape ────────────────────────────────────────────────
// The tree is the shape the builder writes, so these are the cases the flat
// blob's tests can't reach: an OR group (flat criteria could only AND), and the
// decommissioned rule the tree path has to state explicitly because it used to
// be implicit in buildPrefilterWhere.

d("tagAssignmentService — assetCondition (device filter tree)", () => {
  it("applies the tag to assets matching an OR group, and strips drift", async () => {
    const tag = await makeCondTag({
      op: "or",
      children: [
        { field: "manufacturer", operator: "equals", value: "Cisco" },
        { field: "manufacturer", operator: "equals", value: "Juniper" },
      ],
    });
    const cisco = await makeAsset({ hostname: "tagtest-cond-a", manufacturer: "Cisco" });
    const juniper = await makeAsset({ hostname: "tagtest-cond-b", manufacturer: "Juniper" });
    const arista = await makeAsset({ hostname: "tagtest-cond-c", manufacturer: "Arista" });

    const added = await reconcileTag(tag.id);
    expect(added.added).toBe(2);
    expect((await prisma.asset.findUnique({ where: { id: cisco.id } }))!.tags).toContain(TAG_NAME);
    expect((await prisma.asset.findUnique({ where: { id: juniper.id } }))!.tags).toContain(TAG_NAME);
    expect((await prisma.asset.findUnique({ where: { id: arista.id } }))!.tags).not.toContain(TAG_NAME);

    // Drift one out of match — managed sync removes its engine-owned copy.
    await prisma.asset.update({ where: { id: juniper.id }, data: { manufacturer: "Arista" } });
    const after = await reconcileTag(tag.id);
    expect(after.removed).toBe(1);
    expect((await prisma.asset.findUnique({ where: { id: juniper.id } }))!.tags).not.toContain(TAG_NAME);
  });

  it("skips decommissioned assets unless the filter mentions status", async () => {
    const tag = await makeCondTag({
      op: "and",
      children: [{ field: "manufacturer", operator: "equals", value: "Cisco" }],
    });
    const live = await makeAsset({ hostname: "tagtest-cond-d", manufacturer: "Cisco" });
    const dead = await makeAsset({ hostname: "tagtest-cond-e", manufacturer: "Cisco", status: "decommissioned" });

    await reconcileTag(tag.id);
    expect((await prisma.asset.findUnique({ where: { id: live.id } }))!.tags).toContain(TAG_NAME);
    expect((await prisma.asset.findUnique({ where: { id: dead.id } }))!.tags).not.toContain(TAG_NAME);

    // Naming status opts INTO retired inventory — the operator asked for it.
    await prisma.tag.update({
      where: { id: tag.id },
      data: {
        assetCondition: {
          op: "and",
          children: [{ field: "status", operator: "equals", value: "decommissioned" }],
        } as any,
      },
    });
    await reconcileTag(tag.id);
    expect((await prisma.asset.findUnique({ where: { id: dead.id } }))!.tags).toContain(TAG_NAME);
  });

  it("reconcileTagsForAsset evaluates a tree against one asset", async () => {
    await makeCondTag({
      op: "and",
      children: [{ field: "hostname", operator: "startsWith", value: "tagtest-cond-f" }],
    });
    const hit = await makeAsset({ hostname: "tagtest-cond-f-1" });
    const miss = await makeAsset({ hostname: "tagtest-cond-g-1" });

    expect((await reconcileTagsForAsset(hit.id)).added).toBe(1);
    expect((await prisma.asset.findUnique({ where: { id: hit.id } }))!.tags).toContain(TAG_NAME);
    expect((await reconcileTagsForAsset(miss.id)).added).toBe(0);
    expect((await prisma.asset.findUnique({ where: { id: miss.id } }))!.tags).not.toContain(TAG_NAME);

    // Drift the matching asset out — the per-asset hook strips it too.
    await prisma.asset.update({ where: { id: hit.id }, data: { hostname: "moved-away-1" } });
    expect((await reconcileTagsForAsset(hit.id)).removed).toBe(1);
    expect((await prisma.asset.findUnique({ where: { id: hit.id } }))!.tags).not.toContain(TAG_NAME);
  });

  it("treats an EMPTY tree as no filter, never as every asset", async () => {
    // The whole-fleet hazard: and([]) is true for any asset, so a half-built
    // form must not be able to tag everything.
    const tag = await makeCondTag({ op: "and", children: [] });
    await makeAsset({ hostname: "tagtest-cond-h", manufacturer: "Cisco" });
    const summary = await reconcileTag(tag.id);
    expect(summary.added).toBe(0);

    const preview = await previewTagFilter({ condition: { op: "and", children: [] } });
    expect(preview.matchCount).toBe(0);
  });

  it("previewTagFilter counts a tree's matches without writing", async () => {
    const tag = await makeCondTag({
      op: "and",
      children: [{ field: "manufacturer", operator: "contains", value: "cisc" }],
    });
    await makeAsset({ hostname: "tagtest-cond-i", manufacturer: "Cisco" });
    await makeAsset({ hostname: "tagtest-cond-j", manufacturer: "CISCO Systems" });

    const preview = await previewTagFilter(
      { condition: { op: "and", children: [{ field: "manufacturer", operator: "contains", value: "cisc" }] } },
      tag.id,
    );
    expect(preview.matchCount).toBe(2);
    expect(preview.diff).toEqual({ add: 2, remove: 0 });
    expect(await prisma.tagAutoAssignment.count({ where: { tagId: tag.id } })).toBe(0);
  });
});

// Efficiency audit group 3: reconcileAllTags resolves every tree-shaped filter
// over ONE fleet read. It must land exactly what reconciling each tag on its own
// does — eligibility (decommissioned only when the tree names status), legacy
// shape, drift out of a match, and a hand-applied copy all included.
d("tagAssignmentService.reconcileAllTags", () => {
  const NAMES = [TAG_NAME + "-cisco", TAG_NAME + "-retired", TAG_NAME + "-legacy", TAG_NAME + "-host"];

  async function provenance() {
    const rows = await prisma.tagAutoAssignment.findMany({ select: { tagId: true, assetId: true } });
    return rows.map((r) => r.tagId + ":" + r.assetId).sort();
  }
  async function tagsOf(ids: string[]) {
    const rows = await prisma.asset.findMany({ where: { id: { in: ids } }, select: { id: true, tags: true } });
    return Object.fromEntries(rows.map((r) => [r.id, [...r.tags].sort()]));
  }

  it("lands the same tags and provenance as reconciling each tag alone", async () => {
    try {
      const mk = (name: string, data: Record<string, unknown>) =>
        prisma.tag.create({ data: { name, category: "Test", color: "#4fc3f7", ...data } as any });
      const cisco = await mk(NAMES[0]!, { assetCondition: { op: "and", children: [{ field: "manufacturer", operator: "equals", value: "Cisco" }] } });
      const retired = await mk(NAMES[1]!, { assetCondition: { op: "and", children: [{ field: "status", operator: "equals", value: "decommissioned" }] } });
      const legacy = await mk(NAMES[2]!, { criteria: { version: 1, match: "all", rules: [{ field: "manufacturer", op: "exact", values: ["Juniper"] }] } });
      const host = await mk(NAMES[3]!, { assetCondition: { op: "and", children: [{ field: "hostname", operator: "startsWith", value: "allt-" }] } });

      const live = await makeAsset({ hostname: "allt-1", manufacturer: "Cisco" });
      const dead = await makeAsset({ hostname: "allt-2", manufacturer: "Cisco", status: "decommissioned" });
      const jun = await makeAsset({ hostname: "other-3", manufacturer: "Juniper" });
      const drift = await makeAsset({ hostname: "allt-4", manufacturer: "Cisco" });
      const manual = await makeAsset({ hostname: "other-5", manufacturer: "HP", tags: [NAMES[0]!] });
      const ids = [live.id, dead.id, jun.id, drift.id, manual.id];

      // A first pass, then drift one asset out of the Cisco tag.
      await reconcileAllTags();
      await prisma.asset.update({ where: { id: drift.id }, data: { manufacturer: "Arista" } });

      const sharedSummary = await reconcileAllTags();
      const sharedProv = await provenance();
      const sharedTags = await tagsOf(ids);

      // Reset to the same pre-second-pass state and reconcile tag by tag.
      await prisma.tagAutoAssignment.deleteMany({});
      for (const id of ids) {
        await prisma.asset.update({ where: { id }, data: { tags: id === manual.id ? [NAMES[0]!] : [] } });
      }
      await prisma.asset.update({ where: { id: drift.id }, data: { manufacturer: "Cisco" } });
      for (const t of [cisco, retired, legacy, host]) await reconcileTag(t.id);
      await prisma.asset.update({ where: { id: drift.id }, data: { manufacturer: "Arista" } });
      for (const t of [cisco, retired, legacy, host]) await reconcileTag(t.id);

      expect(sharedProv).toEqual(await provenance());
      expect(sharedTags).toEqual(await tagsOf(ids));
      // And the outcome is the intended one.
      expect(sharedTags[live.id]).toEqual([NAMES[0]!, NAMES[3]!].sort());
      expect(sharedTags[dead.id]).toEqual([NAMES[1]!]); // only the status-naming filter reaches a decommissioned asset
      expect(sharedTags[jun.id]).toEqual([NAMES[2]!]);
      expect(sharedTags[drift.id]).toEqual([NAMES[3]!]);
      expect(sharedTags[manual.id]).toEqual([NAMES[0]!]); // hand-applied, preserved
      expect(sharedSummary.removed).toBe(1);
    } finally {
      await prisma.tagAutoAssignment.deleteMany({});
      await prisma.tag.deleteMany({ where: { name: { in: NAMES } } });
    }
  });
});
