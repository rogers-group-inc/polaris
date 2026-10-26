/**
 * tests/unit/credentialUsage.test.ts
 *
 * Coverage for the credential-usage resolver in credentialService:
 *   - per-stream asset cred beats asset default beats class beats integration
 *   - asset default outranks both the class and integration tiers
 *   - manual assets (no integration) fall through asset -> class only
 *   - distinct-count dedup when one asset hits a credential via many streams
 *   - the delete guard trips on effective usage AND on config-only references
 *   - operations: a Firmware Repository login binding and a Polaris Agent's
 *     install credential (or the Polaris-managed SSH fallback) count too
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
    managedAgent: { findMany: vi.fn(async () => []) },
    firmwareCredentialBinding: { findMany: vi.fn(async () => []) },
    // Path checks that authenticate with a credential (business rule 85).
    pathCheck: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock("../../src/services/windowsSshOnboardingService.js", () => ({
  getOnboardingState: vi.fn(async () => ({ credentialIds: { windows: null, linux: null } })),
}));

import {
  getCredentialUsage,
  getCredentialUsageCounts,
  deleteCredential,
} from "../../src/services/credentialService.js";
import { prisma } from "../../src/db.js";
import { getOnboardingState } from "../../src/services/windowsSshOnboardingService.js";

type Mock = ReturnType<typeof vi.fn>;
const credFindUnique = prisma.credential.findUnique as unknown as Mock;
const credDelete = prisma.credential.delete as unknown as Mock;
const assetFindMany = prisma.asset.findMany as unknown as Mock;
const classFindMany = prisma.monitorClassOverride.findMany as unknown as Mock;
const intFindMany = prisma.integration.findMany as unknown as Mock;
const agentFindMany = prisma.managedAgent.findMany as unknown as Mock;
const bindingFindMany = prisma.firmwareCredentialBinding.findMany as unknown as Mock;
const onboardingState = getOnboardingState as unknown as Mock;

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
  agentFindMany.mockResolvedValue([]);
  bindingFindMany.mockResolvedValue([]);
  onboardingState.mockResolvedValue({ credentialIds: { windows: null, linux: null } });
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

describe("operations usage (firmware binding, agent install)", () => {
  const HTTP_LOGIN = "66666666-6666-6666-6666-666666666666";
  const SSH_GATE = "77777777-7777-7777-7777-777777777777";
  const WIN_MANAGED = "88888888-8888-8888-8888-888888888888";
  const LINUX_MANAGED = "99999999-9999-9999-9999-999999999999";
  const SW1 = asset({ id: "sw1", hostname: "sw1", assetType: "switch", manufacturer: "Fortinet", model: "FS-148F" });
  const SW2 = asset({ id: "sw2", hostname: "sw2", assetType: "switch", manufacturer: "Fortinet", model: "FS-424E" });
  const FW9 = asset({ id: "fw9", hostname: "fw9", assetType: "firewall", manufacturer: "Fortinet", model: "FGT-60F" });
  const WIN = asset({ id: "win", hostname: "win", assetType: "server" });
  const LNX = asset({ id: "lnx", hostname: "lnx", assetType: "server" });
  const binding = (over: Record<string, unknown>) => ({
    id: "b", manufacturer: "Fortinet", assetType: null, model: null, source: "credential", credentialId: null, credential: null, ...over,
  });

  beforeEach(() => {
    seed([SW1, SW2, FW9, WIN, LNX], [], []);
  });

  it("counts every asset a Repository login binding resolves to, model tier first", async () => {
    bindingFindMany.mockResolvedValue([
      binding({ id: "b1", assetType: "switch", credentialId: HTTP_LOGIN, credential: { id: HTTP_LOGIN, name: "Switch login", type: "http" } }),
      binding({ id: "b2", assetType: "switch", model: "FS-424E", credentialId: SSH_GATE, credential: { id: SSH_GATE, name: "Gate SSH", type: "ssh" } }),
      binding({ id: "b3", assetType: "firewall", source: "integration-token" }),
    ]);
    const counts = await getCredentialUsageCounts();
    expect(counts[HTTP_LOGIN]).toBe(1); // sw1 — sw2's model binding outranks it
    expect(counts[SSH_GATE]).toBe(1); // sw2
    const u = await getCredentialUsage(HTTP_LOGIN);
    expect(u.total).toBe(1);
    expect(u.monitoringTotal).toBe(0);
    expect(u.operationLevel).toEqual([
      expect.objectContaining({ kind: "firmware", assets: [expect.objectContaining({ assetId: "sw1", streams: ["Firmware upgrades", "Reboots"] })] }),
    ]);
  });

  it("skips a binding whose credential was deleted and a REST token on a non-firewall", async () => {
    bindingFindMany.mockResolvedValue([
      binding({ id: "b1", assetType: "switch", model: "FS-148F", credentialId: HTTP_LOGIN, credential: null }),
      binding({ id: "b2", credentialId: SSH_GATE, credential: { id: SSH_GATE, name: "Token", type: "restapi" } }),
    ]);
    const counts = await getCredentialUsageCounts();
    expect(counts[HTTP_LOGIN]).toBeUndefined();
    expect(counts[SSH_GATE]).toBe(1); // fw9 only — the restapi token fits firewalls alone
  });

  it("counts agents by install credential, falling back to the Polaris-managed one per platform", async () => {
    onboardingState.mockResolvedValue({ credentialIds: { windows: WIN_MANAGED, linux: LINUX_MANAGED } });
    agentFindMany.mockResolvedValue([
      { assetId: "win", osPlatform: "windows", installCredentialId: null },
      { assetId: "lnx", osPlatform: "linux", installCredentialId: null },
      { assetId: "fw9", osPlatform: "linux", installCredentialId: SSH_GATE },
    ]);
    const counts = await getCredentialUsageCounts();
    expect(counts[WIN_MANAGED]).toBe(1);
    expect(counts[LINUX_MANAGED]).toBe(1);
    expect(counts[SSH_GATE]).toBe(1);
    const u = await getCredentialUsage(LINUX_MANAGED);
    expect(u.operationLevel[0]).toMatchObject({ kind: "agent", assets: [expect.objectContaining({ assetId: "lnx" })] });
  });

  it("counts an asset once when it uses the credential for monitoring and operations", async () => {
    seed([asset({ id: "sw1", hostname: "sw1", assetType: "switch", manufacturer: "Fortinet", model: "FS-148F", monitorCredentialId: SSH_GATE })], [], []);
    bindingFindMany.mockResolvedValue([binding({ credentialId: SSH_GATE, credential: { id: SSH_GATE, name: "Gate SSH", type: "ssh" } })]);
    expect((await getCredentialUsageCounts())[SSH_GATE]).toBe(1);
    const u = await getCredentialUsage(SSH_GATE);
    expect(u.total).toBe(1);
    expect(u.assetLevel).toHaveLength(1);
    expect(u.operationLevel[0].assets).toHaveLength(1);
  });

  it("does not block deletion over operations alone (both FKs are SET NULL)", async () => {
    onboardingState.mockResolvedValue({ credentialIds: { windows: null, linux: LINUX_MANAGED } });
    agentFindMany.mockResolvedValue([{ assetId: "lnx", osPlatform: "linux", installCredentialId: null }]);
    credDelete.mockResolvedValue({ id: LINUX_MANAGED });
    await expect(deleteCredential(LINUX_MANAGED)).resolves.toBeUndefined();
  });
});
