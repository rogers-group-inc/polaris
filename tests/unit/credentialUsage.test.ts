/**
 * tests/unit/credentialUsage.test.ts
 *
 * Coverage for the credential-usage resolver in credentialService:
 *   - per-stream asset cred beats asset default beats class beats integration
 *   - asset default outranks both the class and integration tiers
 *   - manual assets (no integration) fall through asset -> class only
 *   - distinct-count dedup when one asset hits a credential via many streams
 *   - the delete guard trips on effective usage AND on config-only references
 *
 * Prisma is mocked so the resolution math is exercised without a live DB.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => ({
  prisma: {
    credential: { findUnique: vi.fn(), delete: vi.fn() },
    asset: { findMany: vi.fn() },
    monitorClassOverride: { findMany: vi.fn() },
    integration: { findMany: vi.fn() },
    // Path checks that authenticate with a credential (business rule 85).
    pathCheck: { findMany: vi.fn(async () => []) },
  },
}));

import {
  getCredentialUsage,
  getCredentialUsageCounts,
  deleteCredential,
} from "../../src/services/credentialService.js";
import { prisma } from "../../src/db.js";

type Mock = ReturnType<typeof vi.fn>;
const credFindUnique = prisma.credential.findUnique as unknown as Mock;
const credDelete = prisma.credential.delete as unknown as Mock;
const assetFindMany = prisma.asset.findMany as unknown as Mock;
const classFindMany = prisma.monitorClassOverride.findMany as unknown as Mock;
const intFindMany = prisma.integration.findMany as unknown as Mock;

const CRED_A = "11111111-1111-1111-1111-111111111111"; // asset/stream-level
const CRED_B = "22222222-2222-2222-2222-222222222222"; // class-level
const CRED_C = "33333333-3333-3333-3333-333333333333"; // integration-level
const CRED_D = "44444444-4444-4444-4444-444444444444"; // class ref, no assets
const CRED_E = "55555555-5555-5555-5555-555555555555"; // unused
const INT1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function asset(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "asset", hostname: null, ipAddress: null, assetType: "firewall",
    monitored: true, status: "active", discoveredByIntegrationId: null,
    monitorCredentialId: null,
    responseTimeCredentialId: null, cpuMemoryCredentialId: null,
    temperatureCredentialId: null, interfacesCredentialId: null,
    lldpCredentialId: null, customWidgetCredentialId: null,
    processesCredentialId: null, eventLogCredentialId: null,
    ...over,
  };
}

function classOv(over: Record<string, unknown>): Record<string, unknown> {
  return {
    integrationId: null, assetType: "firewall",
    responseTimeCredentialId: null, cpuMemoryCredentialId: null,
    temperatureCredentialId: null, interfacesCredentialId: null,
    lldpCredentialId: null, customWidgetCredentialId: null,
    processesCredentialId: null, eventLogCredentialId: null,
    ...over,
  };
}

// A1: stream override CRED_A, inherits CRED_B (class cpuMemory), CRED_C (int default)
const A1 = asset({ id: "a1", hostname: "fw1", discoveredByIntegrationId: INT1, responseTimeCredentialId: CRED_A });
// A2: asset default CRED_A — a genuine override (CRED_A is NOT the integration's
// credential), so it outranks the class + integration tiers and is asset-level
const A2 = asset({ id: "a2", hostname: "fw2", discoveredByIntegrationId: INT1, monitorCredentialId: CRED_A });
// A3: manual asset (no integration), inherits CRED_A from the manual class override's lldp slot
const A3 = asset({ id: "a3", hostname: "sw3", assetType: "switch", discoveredByIntegrationId: null });
// A4: discovery STAMPED the integration's own credential (CRED_C) onto the asset
// default. Even though it's an FK on the asset row, it was inherited from the
// integration, so it must classify as integration-level, not asset-level.
const A4 = asset({ id: "a4", hostname: "fw4", discoveredByIntegrationId: INT1, monitorCredentialId: CRED_C });

const CLASS_FW_INT1 = classOv({ integrationId: INT1, assetType: "firewall", cpuMemoryCredentialId: CRED_B });
const CLASS_SW_MANUAL = classOv({ integrationId: null, assetType: "switch", lldpCredentialId: CRED_A });
const CLASS_ROUTER_REF = classOv({ integrationId: INT1, assetType: "router", cpuMemoryCredentialId: CRED_D }); // no matching asset
const INTEGRATIONS = [{ id: INT1, name: "HQ FMG", config: { monitorCredentialId: CRED_C } }];

function seed(assets = [A1, A2, A3, A4], overrides = [CLASS_FW_INT1, CLASS_SW_MANUAL, CLASS_ROUTER_REF], integrations = INTEGRATIONS) {
  credFindUnique.mockImplementation((args: { where: { id: string } }) => Promise.resolve({ id: args.where.id }));
  assetFindMany.mockResolvedValue(assets);
  classFindMany.mockResolvedValue(overrides);
  intFindMany.mockResolvedValue(integrations);
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});

describe("getCredentialUsageCounts", () => {
  it("counts effective usage across tiers, deduping per asset", async () => {
    const counts = await getCredentialUsageCounts();
    // A1 uses A (stream) + B (class) + C (int); A2 uses A (default only); A3 uses A (manual class); A4 uses C (stamped default)
    expect(counts[CRED_A]).toBe(3); // A1, A2, A3
    expect(counts[CRED_B]).toBe(1); // A1
    expect(counts[CRED_C]).toBe(2); // A1 (fall-through) + A4 (stamped default), deduped per asset
    expect(counts[CRED_D]).toBeUndefined(); // referenced by a class override with no matching asset
  });
});

describe("getCredentialUsage", () => {
  it("buckets the stream override under asset level", async () => {
    const u = await getCredentialUsage(CRED_A);
    const a1 = u.assetLevel.find((a) => a.assetId === "a1");
    expect(a1?.streams).toEqual(["Response time"]);
    // A2's default lands as an "All Polling Methods" badge at asset level
    const a2 = u.assetLevel.find((a) => a.assetId === "a2");
    expect(a2?.streams).toContain("All Polling Methods");
    // A3 inherits CRED_A via the manual class override -> class level, not asset
    expect(u.assetLevel.some((a) => a.assetId === "a3")).toBe(false);
    const manualClass = u.classLevel.find((g) => g.assetType === "switch");
    expect(manualClass?.integrationName).toBeNull(); // manual tier
    expect(manualClass?.assets.map((a) => a.assetId)).toEqual(["a3"]);
    expect(u.total).toBe(3);
  });

  it("puts class-inherited assets under class level with the integration name", async () => {
    const u = await getCredentialUsage(CRED_B);
    expect(u.assetLevel).toHaveLength(0);
    expect(u.classLevel).toHaveLength(1);
    expect(u.classLevel[0].integrationName).toBe("HQ FMG");
    expect(u.classLevel[0].assetType).toBe("firewall");
    expect(u.classLevel[0].assets.map((a) => a.assetId)).toEqual(["a1"]);
    expect(u.total).toBe(1);
  });

  it("puts integration-default-inherited and stamped-default assets under integration level", async () => {
    const u = await getCredentialUsage(CRED_C);
    expect(u.integrationLevel).toHaveLength(1);
    expect(u.integrationLevel[0].integrationName).toBe("HQ FMG");
    // a1 inherits CRED_C via fall-through; a4 has it STAMPED as its default FK —
    // both classify as integration-level, neither as asset-level
    expect(u.integrationLevel[0].assets.map((a) => a.assetId)).toEqual(["a1", "a4"]);
    expect(u.assetLevel.some((a) => a.assetId === "a4")).toBe(false);
    // A2 does NOT appear: its asset default (CRED_A) is a genuine override
    expect(u.total).toBe(2);
    expect(u.integrationRefCount).toBe(1);
  });

  it("treats a stamped default (asset FK == integration's own credential) as integration-level, not asset-level", async () => {
    // The bug the user hit: every discovered asset showed 'asset level' because
    // discovery stamps the integration credential onto Asset.monitorCredentialId.
    const u = await getCredentialUsage(CRED_C);
    const a4Asset = u.assetLevel.find((a) => a.assetId === "a4");
    expect(a4Asset).toBeUndefined();
    const a4Int = u.integrationLevel[0].assets.find((a) => a.assetId === "a4");
    expect(a4Int).toBeDefined();
    expect(a4Int?.streams).toEqual(["All Polling Methods"]);
  });

  it("reports config references even when no assets resolve to the credential", async () => {
    const u = await getCredentialUsage(CRED_D);
    expect(u.total).toBe(0);
    expect(u.classRefCount).toBe(1);
  });
});

describe("deleteCredential guard", () => {
  it("blocks deletion when assets effectively use the credential", async () => {
    await expect(deleteCredential(CRED_B)).rejects.toMatchObject({ httpStatus: 409 });
    expect(credDelete).not.toHaveBeenCalled();
  });

  it("blocks deletion when only a class override references it (no assets)", async () => {
    await expect(deleteCredential(CRED_D)).rejects.toMatchObject({ httpStatus: 409 });
    expect(credDelete).not.toHaveBeenCalled();
  });

  it("blocks deletion while a path check authenticates with it, naming the check", async () => {
    const { prisma } = await import("../../src/db.js");
    vi.mocked(prisma.pathCheck.findMany).mockResolvedValueOnce([{ name: "ERP health" }] as never);
    await expect(deleteCredential(CRED_E)).rejects.toMatchObject({ httpStatus: 409, message: expect.stringMatching(/path check "ERP health"/) });
    expect(credDelete).not.toHaveBeenCalled();
  });

  it("deletes an unused, unreferenced credential", async () => {
    credDelete.mockResolvedValue({ id: CRED_E });
    await expect(deleteCredential(CRED_E)).resolves.toBeUndefined();
    expect(credDelete).toHaveBeenCalledWith({ where: { id: CRED_E } });
  });
});
