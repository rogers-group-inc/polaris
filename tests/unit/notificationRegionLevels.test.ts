/**
 * tests/unit/notificationRegionLevels.test.ts
 *
 * Level-scoped device-region routing end to end: a notify action carrying
 * `recipientDeviceRegionLevels` reaches the users tagged with the triggering
 * asset's regions at those ASSET-RELATIVE levels — front-line staff at L1, the
 * division's managers at L2.
 *
 * Driven through `executeActions`, not `expandDeliveries`, on purpose. Every
 * notify action is round-tripped through the legacy `DeliveryTarget` shape by
 * `actionsToTargets` before the expander sees it, so a field missing from that
 * conversion validates, persists, renders in the wizard and routes to NOBODY.
 * Only a test that starts at the action catches it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const userRows = [
  { id: "u-nash", email: "nash@example.com", displayName: "Nashville Tech", regionTags: ["Nashville"], otherTags: [], ssoGroups: [], authProvider: "local", role: null },
  { id: "u-memp", email: "memp@example.com", displayName: "Memphis Tech", regionTags: ["Memphis"], otherTags: [], ssoGroups: [], authProvider: "local", role: null },
  { id: "u-south", email: "south@example.com", displayName: "South Manager", regionTags: ["South"], otherTags: [], ssoGroups: [], authProvider: "local", role: null },
  // Deliberately holds "South" as an OTHER tag, not a region tag: level routing
  // matches regionSet, so this user must never be reached.
  { id: "u-decoy", email: "decoy@example.com", displayName: "Decoy", regionTags: [], otherTags: ["South"], ssoGroups: [], authProvider: "local", role: null },
];

/** South ⊃ { Nashville, Memphis }. Stored as the mapRegions Setting blob. */
const REGIONS = [
  { id: "r-south", name: "South", color: "#4fc3f7", polygon: [[30, -95], [30, -75], [45, -75], [45, -95]], createdBy: null, createdAt: "", updatedAt: "" },
  { id: "r-nash", name: "Nashville", color: "#4ade80", polygon: [[35, -88], [35, -86], [37, -86], [37, -88]], createdBy: null, createdAt: "", updatedAt: "" },
  { id: "r-memp", name: "Memphis", color: "#f59e0b", polygon: [[34, -91], [34, -89], [36, -89], [36, -91]], createdBy: null, createdAt: "", updatedAt: "" },
];

const createdRows: Record<string, unknown>[] = [];

vi.mock("../../src/db.js", () => ({
  prisma: {
    user: { findMany: vi.fn(async () => userRows) },
    setting: {
      findUnique: vi.fn(async (args: any) =>
        args?.where?.key === "mapRegions" ? { value: REGIONS, updatedAt: new Date("2026-08-25T00:00:00Z") } : null,
      ),
    },
    notificationChannel: {
      findMany: vi.fn(async () => [{ id: "c1", type: "smtp", enabled: true }]),
    },
    notificationDelivery: {
      createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
        createdRows.push(...data);
        return { count: data.length };
      }),
      create: vi.fn(async () => ({})),
    },
    pushSubscription: { findMany: vi.fn(async () => []) },
    notificationAckToken: { createMany: vi.fn(async () => ({ count: 0 })) },
  },
}));

vi.mock("../../src/services/regionScopeService.js", () => ({
  resolveTagScopesForUser: vi.fn(async (u: { regionTags: string[]; otherTags: string[] }) => ({
    regionTags: { effective: u.regionTags },
    otherTags: { effective: u.otherTags },
  })),
}));

vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => {}) }));

const { executeActions } = await import("../../src/services/automationActionService.js");
const { bumpRecipientIndex } = await import("../../src/services/notificationRecipientService.js");
const { invalidateRegionHierarchy } = await import("../../src/services/mapRegionService.js");

/** The To addresses of every composed email row produced. */
function recipients(): string[] {
  const out: string[] = [];
  for (const row of createdRows) {
    const meta = row.meta as { to?: string[] } | undefined;
    if (meta?.to) out.push(...meta.to);
    else if (typeof row.target === "string") out.push(row.target);
  }
  return out.sort();
}

const CTX = { asset: "sw-nash-1", severity: "warning", message: "link down" };

beforeEach(() => {
  createdRows.length = 0;
  bumpRecipientIndex();
  invalidateRegionHierarchy();
});

describe("recipientDeviceRegionLevels routing", () => {
  it("L1 reaches the device's own region, not the division", async () => {
    await executeActions(
      "n1",
      [{ type: "notify", channelId: "c1", recipientDeviceRegionLevels: [1] } as never],
      CTX,
      { assetRegionTags: ["Nashville", "South"] },
    );
    expect(recipients()).toEqual(["nash@example.com"]);
  });

  it("L2 reaches the division's manager, not the local tech", async () => {
    await executeActions(
      "n1",
      [{ type: "notify", channelId: "c1", recipientDeviceRegionLevels: [2] } as never],
      CTX,
      { assetRegionTags: ["Nashville", "South"] },
    );
    expect(recipients()).toEqual(["south@example.com"]);
  });

  it("survives the actionsToTargets round trip when the parent tag is absent", async () => {
    // Only the leaf tag is on the asset; the division is found by walking the
    // containment edges.
    await executeActions(
      "n1",
      [{ type: "notify", channelId: "c1", recipientDeviceRegionLevels: [2] } as never],
      CTX,
      { assetRegionTags: ["Nashville"] },
    );
    expect(recipients()).toEqual(["south@example.com"]);
  });

  it("routes a different device in the same division to the same manager", async () => {
    await executeActions(
      "n1",
      [{ type: "notify", channelId: "c1", recipientDeviceRegionLevels: [2] } as never],
      CTX,
      { assetRegionTags: ["Memphis"] },
    );
    expect(recipients()).toEqual(["south@example.com"]);
  });

  it("combines levels in one action", async () => {
    await executeActions(
      "n1",
      [{ type: "notify", channelId: "c1", recipientDeviceRegionLevels: [1, 2] } as never],
      CTX,
      { assetRegionTags: ["Nashville"] },
    );
    expect(recipients()).toEqual(["nash@example.com", "south@example.com"]);
  });

  it("matches REGION tags only — an identically-named 'other' tag is not a region", async () => {
    await executeActions(
      "n1",
      [{ type: "notify", channelId: "c1", recipientDeviceRegionLevels: [2] } as never],
      CTX,
      { assetRegionTags: ["Nashville"] },
    );
    expect(recipients()).not.toContain("decoy@example.com");
  });

  it("unions with the all-levels flag rather than replacing it", async () => {
    // recipientDeviceRegion keeps meaning "every region the asset carries", so
    // a stored rule cannot change meaning by this feature existing.
    await executeActions(
      "n1",
      [{ type: "notify", channelId: "c1", recipientDeviceRegion: true, recipientDeviceRegionLevels: [2] } as never],
      CTX,
      { assetRegionTags: ["Nashville"] },
    );
    expect(recipients()).toEqual(["nash@example.com", "south@example.com"]);
  });

  it("delivers nothing when the requested level is above the top of the tree", async () => {
    await executeActions(
      "n1",
      [{ type: "notify", channelId: "c1", recipientDeviceRegionLevels: [3] } as never],
      CTX,
      { assetRegionTags: ["Nashville"] },
    );
    expect(createdRows).toHaveLength(0);
  });

  it("contributes nothing when the asset carries no region tags at all", async () => {
    await executeActions(
      "n1",
      [{ type: "notify", channelId: "c1", recipientDeviceRegionLevels: [1, 2] } as never],
      CTX,
      { assetRegionTags: [] },
    );
    expect(createdRows).toHaveLength(0);
  });

  it("ABSTAINS instead of paging the division when the leaf tag names no region", async () => {
    // Business rule 58, reproduced at the level the incident happened. The
    // asset sits in a region whose polygon was renamed away, so its leaf tag
    // is stranded (rule 54) while the division tag still resolves. Pre-58 the
    // stranded tag was dropped and "South" became L1 — so this action mailed
    // south@example.com, and the Nashville tech who owns the site heard
    // nothing. Nothing in the UI said so: the tag still rendered on the asset.
    await executeActions(
      "n1",
      [{ type: "notify", channelId: "c1", recipientDeviceRegionLevels: [1] } as never],
      CTX,
      { assetRegionTags: ["Middle Tenneessee", "South"] },
    );
    expect(createdRows).toHaveLength(0);
  });

  it("abstains at EVERY level, not just the one the stranded leaf would hold", async () => {
    await executeActions(
      "n1",
      [{ type: "notify", channelId: "c1", recipientDeviceRegionLevels: [1, 2] } as never],
      CTX,
      { assetRegionTags: ["Middle Tenneessee", "South"] },
    );
    expect(createdRows).toHaveLength(0);
  });

  it("leaves the OTHER recipient arms of the same action untouched", async () => {
    // The abstention is scoped to the level arm — an alert must not lose the
    // people who were named outright just because a tag went stale.
    await executeActions(
      "n1",
      [{
        type: "notify",
        channelId: "c1",
        recipientUserIds: ["u-south"],
        recipientDeviceRegionLevels: [1],
      } as never],
      CTX,
      { assetRegionTags: ["Middle Tenneessee", "South"] },
    );
    expect(recipients()).toEqual(["south@example.com"]);
  });
});
