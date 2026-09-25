/**
 * tests/unit/firmwareUpgradeGates.test.ts
 *
 * What may start a firmware upgrade, and in which order the refusals come
 * (business rule 87). Every gate here is a reason a real device would have
 * been flashed wrongly: the wrong image, a device that is already dark, one
 * whose parent is mid-flash, no login to sign in with. The engine is mocked
 * out — this file is about the SYNCHRONOUS half of startFirmwareUpgrade and
 * the credential precedence it leans on.
 *
 * Also pinned: the hold is taken before the runner is scheduled (the same
 * ordering agentInstallMaintenanceHold.test.ts pins), and the runner never
 * writes Asset.osVersion.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const asset = {
    id: "asset-1", hostname: "lab-sw1", ipAddress: "10.0.0.5", dnsName: null, serialNumber: "S108FFTF23001234",
    manufacturer: "Fortinet", assetType: "switch", model: "FortiSwitch S108FF", osVersion: "7.4.3 build0542",
    status: "active", monitored: true, monitorStatus: "up", dependencySuppressed: false,
  };
  const primary = {
    id: "img-primary", manufacturer: "Fortinet", assetType: "switch", model: "FortiSwitch S108FF", platform: "S108FF",
    versionMajor: 7, versionMinor: 6, versionPatch: 8, build: 1164, versionLabel: "7.6.8 build1164", parsedFrom: "header",
    role: "primary", filename: "a.out", sizeBytes: 100, sha256: "aa", storagePath: "img-primary.out", notes: null, uploadedBy: null,
    uploadedAt: new Date("2026-09-20T00:00:00Z"),
  };
  const backup = { ...primary, id: "img-backup", role: "backup", versionMajor: 7, versionMinor: 6, versionPatch: 5, build: 1105, versionLabel: "7.6.5 build1105", sha256: "bb", storagePath: "img-backup.out", uploadedAt: new Date("2026-09-10T00:00:00Z") };
  const stale = { ...primary, id: "img-old", role: "backup", versionMajor: 7, versionMinor: 4, versionPatch: 0, build: 500, versionLabel: "7.4.0 build500", sha256: "cc" };
  const state = {
    asset: { ...asset } as Record<string, unknown>,
    images: [primary, backup] as Array<Record<string, unknown>>,
    bindings: [] as Array<Record<string, unknown>>,
    credentialConfig: { authMode: "form", username: "admin", password: "pw" } as Record<string, unknown>,
    activeRuns: [] as Array<{ assetId: string; asset: { hostname: string | null; ipAddress: string | null } }>,
    paths: new Map<string, string[]>(),
    mclag: [] as Array<{ matchedAssetId: string | null }>,
    created: [] as Array<Record<string, unknown>>,
    assetUpdates: [] as unknown[],
    engineOutcome: { outcome: "upgraded", verifiedVersion: "7.6.8 build1164" } as Record<string, unknown>,
  };
  return {
    state, primary, backup, stale,
    openMaintenanceHold: vi.fn(async () => true),
    releaseMaintenanceHold: vi.fn(async () => true),
    logEvent: vi.fn(async () => {}),
    resolveConnectionPath: vi.fn(async (id: string) => ({ hops: (state.paths.get(id) ?? []).map((hid) => ({ id: hid })) })),
    engineRun: vi.fn(async () => state.engineOutcome),
    stat: vi.fn(async () => ({ size: 100 })),
  };
});

vi.mock("../../src/db.js", () => ({
  prisma: {
    asset: {
      findUnique: vi.fn(async () => h.state.asset),
      findMany: vi.fn(async () => []),
      update: vi.fn(async (args: unknown) => { h.state.assetUpdates.push(args); return {}; }),
    },
    firmwareImage: {
      findMany: vi.fn(async (args: { where: { platform?: string } }) => h.state.images.filter((i) => !args.where.platform || i.platform === args.where.platform)),
      count: vi.fn(async () => h.state.images.length),
    },
    firmwareCredentialBinding: { findMany: vi.fn(async () => h.state.bindings) },
    credential: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id, name: "cred", type: "http", config: h.state.credentialConfig, createdBy: null, createdAt: new Date(), updatedAt: new Date() })) },
    firmwareUpgradeRun: {
      findFirst: vi.fn(async (args: { where: { status?: { in?: string[]; notIn?: string[] } } }) => (args.where.status?.in ? null : null)),
      findMany: vi.fn(async () => h.state.activeRuns),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const row = { id: "run-1", ...data, stage: null, progress: null, result: null, error: null, verifiedVersion: null, startedAt: new Date(), finishedAt: null }; h.state.created.push(row); return row; }),
      update: vi.fn(async () => ({})),
      findUnique: vi.fn(async () => ({ engine: "fortiswitch-https" })),
    },
    assetMclagPeer: { findMany: vi.fn(async () => h.state.mclag) },
  },
}));
vi.mock("../../src/services/maintenanceScheduleService.js", () => ({
  openMaintenanceHold: h.openMaintenanceHold,
  releaseMaintenanceHold: h.releaseMaintenanceHold,
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: h.logEvent }));
vi.mock("../../src/services/connectionPathService.js", () => ({ resolveConnectionPath: h.resolveConnectionPath }));
vi.mock("../../src/services/firmwareEngines/index.js", () => ({
  engineFor: (m: string | null, t: string, s: string | null) => (m === "Fortinet" && t === "switch" && /^S/.test(s ?? "") ? { kind: "fortiswitch-https", label: "FortiSwitch (HTTPS)", run: h.engineRun } : null),
  engineByKind: () => ({ kind: "fortiswitch-https", label: "FortiSwitch (HTTPS)", run: h.engineRun }),
  engineKindForType: () => "fortiswitch-https",
}));
vi.mock("node:fs/promises", async (orig) => ({ ...(await orig<typeof import("node:fs/promises")>()), stat: h.stat }));
vi.mock("../../src/services/discovery/assetDiscoveryScope.js", () => ({ resolveDiscoveryScopeForAsset: vi.fn(async () => ({ ok: false, reason: "no source" })) }));
vi.mock("../../src/services/discovery/discoveryEngine.js", () => ({ triggerDiscovery: vi.fn(async () => true) }));

import { startFirmwareUpgrade, getUpgradeAvailability } from "../../src/services/firmwareUpgradeService.js";
import { resolveFirmwareCredential } from "../../src/services/firmwareRepositoryService.js";

const bind = (scope: "manufacturer" | "assetType" | "model", credentialId: string | null, name = "cred") => ({
  id: `b-${scope}`, manufacturer: "Fortinet",
  assetType: scope === "manufacturer" ? null : "switch",
  model: scope === "model" ? "FortiSwitch S108FF" : null,
  credentialId, credential: credentialId ? { id: credentialId, name } : null,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.state.asset = { id: "asset-1", hostname: "lab-sw1", ipAddress: "10.0.0.5", dnsName: null, serialNumber: "S108FFTF23001234", manufacturer: "Fortinet", assetType: "switch", model: "FortiSwitch S108FF", osVersion: "7.4.3 build0542", status: "active", monitored: true, monitorStatus: "up", dependencySuppressed: false };
  h.state.images = [h.primary, h.backup];
  h.state.bindings = [bind("manufacturer", "cred-m", "mfr login")];
  h.state.credentialConfig = { authMode: "form", username: "admin", password: "pw" };
  h.state.activeRuns = [];
  h.state.paths = new Map();
  h.state.mclag = [];
  h.state.created = [];
  h.state.assetUpdates = [];
  h.state.engineOutcome = { outcome: "upgraded", verifiedVersion: "7.6.8 build1164" };
});

const start = (imageId = "img-primary") => startFirmwareUpgrade({ assetId: "asset-1", imageId, actor: "tester" });
const flushRunner = () => new Promise((r) => setTimeout(r, 30));

describe("credential precedence — model › device type › manufacturer, live rows only", () => {
  const asset = { manufacturer: "Fortinet", assetType: "switch", model: "FortiSwitch S108FF" };
  it("the manufacturer binding is the fallback", async () => {
    expect(await resolveFirmwareCredential(asset, { revealSecrets: false })).toEqual({ credentialId: "cred-m", credentialName: "mfr login", scope: "manufacturer" });
  });
  it("a device-type binding beats it, and a model binding beats both", async () => {
    h.state.bindings = [bind("manufacturer", "cred-m"), bind("assetType", "cred-t", "type login")];
    expect((await resolveFirmwareCredential(asset, { revealSecrets: false }))?.credentialId).toBe("cred-t");
    h.state.bindings.push(bind("model", "cred-x", "model login"));
    expect((await resolveFirmwareCredential(asset, { revealSecrets: false }))?.credentialId).toBe("cred-x");
  });
  it("a binding whose credential was deleted falls through instead of shadowing the wider one", async () => {
    h.state.bindings = [bind("manufacturer", "cred-m"), bind("model", null)];
    expect((await resolveFirmwareCredential(asset, { revealSecrets: false }))?.credentialId).toBe("cred-m");
  });
  it("reveals the username and password only when asked, and only for a form credential", async () => {
    const full = await resolveFirmwareCredential(asset, { revealSecrets: true });
    expect(full).toMatchObject({ credentialId: "cred-m", username: "admin", password: "pw" });
    h.state.credentialConfig = { authMode: "basic", username: "admin", password: "pw" };
    expect(await resolveFirmwareCredential(asset, { revealSecrets: true })).toBeNull();
  });
  it("is null with no binding at any scope", async () => {
    h.state.bindings = [];
    expect(await resolveFirmwareCredential(asset, { revealSecrets: false })).toBeNull();
  });
});

describe("startFirmwareUpgrade — the gates, in order", () => {
  it("starts on a clean device: run row, kickoff Event, hold, runner", async () => {
    const run = await start();
    expect(run.status).toBe("queued");
    expect(run.toVersion).toBe("7.6.8 build1164");
    expect(h.logEvent.mock.calls.map((c) => (c[0] as { action: string }).action)).toContain("firmware.upgrade_started");
    expect(h.openMaintenanceHold).toHaveBeenCalledWith(expect.objectContaining({ assetId: "asset-1", kind: "firmware-upgrade" }));
    await flushRunner();
    expect(h.engineRun).toHaveBeenCalledTimes(1);
  });

  it("takes the hold BEFORE the runner is scheduled", async () => {
    let heldBeforeReturn = false;
    h.openMaintenanceHold.mockImplementation(async () => { heldBeforeReturn = true; return true; });
    await start();
    expect(heldBeforeReturn).toBe(true);
    expect(h.engineRun).not.toHaveBeenCalled(); // setImmediate has not fired yet
  });

  it("refuses a manufacturer / type / serial no engine covers", async () => {
    h.state.asset.manufacturer = "Aruba";
    await expect(start()).rejects.toThrow(/No upgrade engine/);
  });

  it("refuses a device with no address", async () => {
    h.state.asset.ipAddress = null;
    await expect(start()).rejects.toThrow(/no IP address/);
  });

  it("refuses a placeholder serial (rule 84) before looking at any image", async () => {
    h.state.asset.serialNumber = "N/A";
    await expect(start()).rejects.toThrow(/No upgrade engine|serial/);
  });

  it("answers 409 with the reason when nothing is newer", async () => {
    h.state.asset.osVersion = "7.6.8 build1164";
    await expect(start()).rejects.toMatchObject({ httpStatus: 409, message: expect.stringMatching(/No Repository image is newer/) });
  });

  it("requires the approved imageId to be the primary or the eligible backup — never a downgrade", async () => {
    await expect(startFirmwareUpgrade({ assetId: "asset-1", imageId: "", actor: "t" })).rejects.toThrow(/imageId is required/);
    await expect(start("img-nope")).rejects.toThrow(/not offered for this device/);
    // The backup is strictly newer than 7.4.3 → allowed by name.
    const run = await start("img-backup");
    expect(run.toVersion).toBe("7.6.5 build1105");
    // A backup that is NOT newer is not offered even by name.
    h.state.images = [h.primary, h.stale];
    await expect(start("img-old")).rejects.toThrow(/not offered for this device/);
  });

  it.each([
    ["down", { monitorStatus: "down" }, /the device is down/],
    ["warning", { monitorStatus: "warning" }, /the device is warning/],
    ["recovering", { monitorStatus: "recovering" }, /the device is recovering/],
    ["dependency-suppressed", { dependencySuppressed: true }, /behind a parent that is down/],
    ["decommissioned", { status: "decommissioned" }, /the asset is decommissioned/],
    ["quarantined", { status: "quarantined" }, /the asset is quarantined/],
  ])("refuses a device that is %s", async (_label, patch, re) => {
    Object.assign(h.state.asset, patch);
    await expect(start()).rejects.toMatchObject({ httpStatus: 409, message: expect.stringMatching(re) });
    expect(h.state.created).toHaveLength(0);
  });

  it("allows a device in maintenance and an unmonitored one", async () => {
    h.state.asset.status = "maintenance";
    await expect(start()).resolves.toBeTruthy();
    h.state.asset.status = "active"; h.state.asset.monitored = false; h.state.asset.monitorStatus = "down";
    await expect(start()).resolves.toBeTruthy();
  });

  it("refuses with no login bound at any scope, naming the three scopes", async () => {
    h.state.bindings = [];
    await expect(start()).rejects.toThrow(/model, device-type or manufacturer level/);
  });

  it("refuses while a run is live on a device above it on the connection path", async () => {
    h.state.activeRuns = [{ assetId: "sw-core", asset: { hostname: "core-1", ipAddress: null } }];
    h.state.paths.set("asset-1", ["sw-core", "fw-1"]);
    await expect(start()).rejects.toThrow(/running on core-1, which is above, below or paired/);
  });

  it("refuses while a run is live on a device BELOW it", async () => {
    h.state.activeRuns = [{ assetId: "sw-edge", asset: { hostname: "edge-9", ipAddress: null } }];
    h.state.paths.set("sw-edge", ["asset-1"]);
    await expect(start()).rejects.toThrow(/edge-9/);
  });

  it("refuses while its MCLAG peer is mid-flash, and ignores an unrelated run", async () => {
    h.state.activeRuns = [{ assetId: "sw-peer", asset: { hostname: "peer", ipAddress: null } }];
    h.state.mclag = [{ matchedAssetId: "sw-peer" }];
    await expect(start()).rejects.toThrow(/peer/);
    h.state.mclag = [];
    await expect(start()).resolves.toBeTruthy();
  });

  it("refuses when the image file is missing from disk", async () => {
    h.stat.mockRejectedValueOnce(new Error("ENOENT"));
    await expect(start()).rejects.toThrow(/missing from disk/);
  });
});

describe("the runner", () => {
  it("never writes Asset.osVersion; records the device's answer on the run and releases the hold before the terminal Event", async () => {
    const order: string[] = [];
    h.releaseMaintenanceHold.mockImplementation(async () => { order.push("release"); return true; });
    h.logEvent.mockImplementation(async (e: { action: string }) => { order.push(e.action); });
    await start();
    await flushRunner();
    expect(h.state.assetUpdates).toHaveLength(0);
    expect(order.indexOf("release")).toBeLessThan(order.indexOf("firmware.upgrade_succeeded"));
    expect(order.indexOf("release")).toBeGreaterThan(order.indexOf("firmware.upgrade_started"));
  });

  it("writes upgrade_failed on a failed outcome and unverified on an unverified one", async () => {
    h.state.engineOutcome = { outcome: "failed", error: "boom" };
    await start();
    await flushRunner();
    expect(h.logEvent.mock.calls.map((c) => (c[0] as { action: string }).action)).toContain("firmware.upgrade_failed");
    h.state.engineOutcome = { outcome: "unverified", error: "no answer" };
    await start();
    await flushRunner();
    expect(h.logEvent.mock.calls.map((c) => (c[0] as { action: string }).action)).toContain("firmware.upgrade_unverified");
    expect(h.releaseMaintenanceHold).toHaveBeenCalledTimes(2);
  });
});

describe("getUpgradeAvailability", () => {
  it("offers the primary, names the eligible backup, and carries the credential's scope", async () => {
    const a = await getUpgradeAvailability("asset-1");
    expect(a.state).toBe("available");
    expect(a.available).toBe(true);
    expect(a.image?.id).toBe("img-primary");
    expect(a.backupImage?.id).toBe("img-backup");
    expect(a.credential).toEqual({ credentialId: "cred-m", credentialName: "mfr login", scope: "manufacturer" });
  });
  it("is unsupported for another manufacturer without touching the images", async () => {
    h.state.asset.manufacturer = "Aruba";
    const a = await getUpgradeAvailability("asset-1");
    expect(a.state).toBe("unsupported");
    expect(a.reason).toMatch(/No upgrade engine for Aruba switches/);
  });
  it("is no-credential with the image still shown, and blocked when a gate refuses", async () => {
    h.state.bindings = [];
    let a = await getUpgradeAvailability("asset-1");
    expect(a.state).toBe("no-credential");
    expect(a.image?.id).toBe("img-primary");
    h.state.bindings = [bind("manufacturer", "cred-m")];
    h.state.asset.monitorStatus = "down";
    a = await getUpgradeAvailability("asset-1");
    expect(a.state).toBe("blocked");
    expect(a.blockers[0]).toMatch(/the device is down/);
  });
  it("is up-to-date when nothing is newer, and no-image when the platform has none", async () => {
    h.state.asset.osVersion = "7.6.8 build1164";
    expect((await getUpgradeAvailability("asset-1")).state).toBe("up-to-date");
    h.state.asset.osVersion = "7.4.3";
    h.state.asset.serialNumber = "S548DFTF19000001";
    const a = await getUpgradeAvailability("asset-1");
    expect(a.state).toBe("no-image");
    expect(a.reason).toMatch(/none for platform S548DF/);
  });
});
