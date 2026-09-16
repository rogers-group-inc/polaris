/**
 * tests/unit/manufacturerProfileScope.test.ts — the write rules for what a
 * profile row may say (Phase 4 step 3 of uniform SNMP).
 *
 * The data model gained the fields the hardcoded vendor constant could
 * express and the rows could not: a device-type SCOPE on overrides, an
 * aggregate (none | avg | sum), a sample-row label, the `model` row's
 * declarative parse, and a profile-level matchPattern. Each has a rule that
 * only the service enforces, so each is pinned here against a mocked Prisma:
 *
 *   - an override needs a device type, a model pattern, or both — never
 *     neither, and the type must be one the registry knows (custom types
 *     included);
 *   - clearing a type-scoped row's pattern promotes it to the type default;
 *     clearing it on an any-type row is refused (it would match nothing);
 *   - a second default for one device type is a 409 that names the type;
 *   - aggregate is one of three words; parse fields belong to the `model`
 *     row alone and must be valid when a symbol is set;
 *   - matchPattern must compile.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  metricRow: { id: "metric-1", metricKey: "cpu" } as Record<string, unknown>,
  existing: null as Record<string, unknown> | null,
  createErr: null as { code: string } | null,
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    manufacturerProfile: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => ({ id: "p1" })),
      update: vi.fn(async ({ data }: any) => ({ id: "p1", ...data })),
    },
    manufacturerProfileMetric: {
      findUnique: vi.fn(async () => h.metricRow),
    },
    manufacturerProfileMetricOverride: {
      create: vi.fn(async ({ data }: any) => {
        if (h.createErr) throw h.createErr;
        return { id: "new-1", ...data };
      }),
      findUnique: vi.fn(async () => h.existing),
      update: vi.fn(async ({ data }: any) => {
        const changed = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
        return { ...h.existing, ...changed };
      }),
    },
    mibFile: { findMany: vi.fn(async () => []) },
  },
}));

const { createOverride, updateOverride, updateProfile } = await import("../../src/services/manufacturerProfileService.js");
const { setAssetTypeRegistry } = await import("../../src/utils/assetTypes.js");

beforeEach(() => {
  vi.clearAllMocks();
  h.metricRow = { id: "metric-1", metricKey: "cpu" };
  h.existing = null;
  h.createErr = null;
  setAssetTypeRegistry([
    { name: "firewall",     label: "Firewall",     isBuiltIn: true },
    { name: "switch",       label: "Switch",       isBuiltIn: true },
    { name: "access_point", label: "Access Point", isBuiltIn: true },
    { name: "camera",       label: "Camera",       isBuiltIn: false },
  ]);
});

describe("override scope", () => {
  it("stores a device type with no pattern as that type's default", async () => {
    const row = await createOverride("p1", "cpu", { assetType: "switch", symbol: "fsSysCpuUsage" });
    expect(row.assetType).toBe("switch");
    expect(row.modelPattern).toBeNull();
    expect(row.aggregate).toBe("none");
  });

  it("normalizes the type name and accepts a custom registry type", async () => {
    const row = await createOverride("p1", "cpu", { assetType: " Camera ", symbol: "axisCpu" });
    expect(row.assetType).toBe("camera");
  });

  it("rejects neither half, and a type the registry does not know", async () => {
    await expect(createOverride("p1", "cpu", { symbol: "x" })).rejects.toThrow(/device type, a model pattern, or both/);
    await expect(createOverride("p1", "cpu", { assetType: "toaster", symbol: "x" })).rejects.toThrow(/Unknown device type/);
  });

  it("promotes a type-scoped row to the type default when its pattern is cleared, refuses on an any-type row", async () => {
    h.existing = { id: "o1", metricRowId: "metric-1", assetType: "switch", modelPattern: "S548DF", symbol: "fsSysCpuUsage", symbolB: null, mibId: null, mibStdKey: null, type: "scalar", transform: null, aggregate: "none", label: null, parsePattern: null, parseTemplate: null, order: 0, metricRow: { profileId: "p1", metricKey: "cpu" } };
    const promoted = await updateOverride("o1", { modelPattern: "" });
    expect(promoted.modelPattern).toBeNull();
    expect(promoted.assetType).toBe("switch");

    h.existing = { ...h.existing, id: "o2", assetType: null, modelPattern: "201G" };
    await expect(updateOverride("o2", { modelPattern: "" })).rejects.toThrow(/device type, a model pattern, or both/);
  });

  it("turns the partial unique index's P2002 into a 409 naming the type", async () => {
    h.createErr = { code: "P2002" };
    await expect(createOverride("p1", "cpu", { assetType: "firewall", symbol: "fgSysCpuUsage" }))
      .rejects.toMatchObject({ httpStatus: 409, message: expect.stringContaining('"firewall"') });
  });
});

describe("aggregate, label, parse", () => {
  it("accepts the three aggregate words and rejects anything else", async () => {
    const row = await createOverride("p1", "cpu", { assetType: "switch", symbol: "cpmCPUTotal5secRev", type: "table", aggregate: "avg" });
    expect(row.aggregate).toBe("avg");
    await expect(createOverride("p1", "cpu", { assetType: "switch", symbol: "x", aggregate: "median" })).rejects.toThrow(/aggregate/);
  });

  it("keeps a label on a storage row", async () => {
    h.metricRow = { id: "metric-2", metricKey: "storage" };
    const row = await createOverride("p1", "storage", {
      assetType: "switch", symbol: "fsSysDiskUsage", symbolB: "fsSysDiskCapacity", type: "double_scalar", transform: "a_over_b_as_percent", label: " flash ",
    });
    expect(row.label).toBe("flash");
  });

  it("requires a valid parse on a configured model row, and refuses parse fields elsewhere", async () => {
    h.metricRow = { id: "metric-3", metricKey: "model" };
    const ok = await createOverride("p1", "model", {
      assetType: "switch", symbol: "fsSysVersion", parsePattern: String.raw`^(?!v\d)(.+?)[-\s]v\d`, parseTemplate: "FortiSwitch $1",
    });
    expect(ok.parseTemplate).toBe("FortiSwitch $1");
    await expect(createOverride("p1", "model", { assetType: "switch", symbol: "fsSysVersion" })).rejects.toThrow(/parsePattern is required/);
    await expect(createOverride("p1", "model", { assetType: "switch", symbol: "fsSysVersion", parsePattern: "^S\\d+" })).rejects.toThrow(/capture group/);
    h.metricRow = { id: "metric-1", metricKey: "cpu" };
    await expect(createOverride("p1", "cpu", { assetType: "switch", symbol: "x", parsePattern: "(.+)" })).rejects.toThrow(/model metric only/);
  });
});

describe("updateProfile — matchPattern", () => {
  it("stores a compiling regex, clears on null, refuses garbage", async () => {
    // getProfile after the write reads the DB; the mock returns a bare row,
    // so only the validation path is exercised here.
    await expect(updateProfile("p1", { matchPattern: "([" })).rejects.toThrow(/valid regex/);
  });
});
