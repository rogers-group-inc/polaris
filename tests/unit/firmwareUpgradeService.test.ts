/**
 * tests/unit/firmwareUpgradeService.test.ts — CQ-T010 (business rules 87,
 * 93, 112, 122, 129, 138).
 *
 * Complements tests/unit/firmwareUpgradeGates.test.ts (startFirmwareUpgrade's
 * gates in order, the runner, the recovery wait, Abort with a live runner, and
 * the standalone-device availability states), firmwareGroupExecutor.test.ts /
 * firmwareSchedule.test.ts (which mock this service), and
 * tests/integration/firmwareAbortRestartGuard.test.ts. Untouched there and
 * pinned here, on the shared _dbStub with the Repository and engines mocked:
 *
 *  - healthBlockers: each state gate, and that `maintenance` and an
 *    unmonitored device are allowed;
 *  - rule 129 (HA): a secondary's card points at its primary and shows the
 *    primary's live run; a non-a-p cluster is unsupported; a primary's card
 *    lists the cluster members (including a peer Polaris holds no record of);
 *  - "pending-discovery": a flash that already succeeded is not re-offered;
 *  - checkSchedulableUpgrade (rule 93): image gates + login, health only as
 *    warnings; the backup image may be booked, anything else may not;
 *  - assessGroupCandidate (rule 122): never throws, maps each refusal to its
 *    drop kind, HA members are refused, primary image only;
 *  - recordFirmwareCredentialUse (rule 112): the destination, nothing for an
 *    integration-token binding, never throws;
 *  - the reads (getRunForAsset's same-404, listRunsForAsset clamping),
 *    abortAllFirmwareRuns, and failOrphanedFirmwareRuns at boot.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  findUpgradeCandidates: vi.fn(),
  firmwareVsPrimary: vi.fn(),
  loadPrimaryFirmwareImages: vi.fn(),
  primaryImageForAsset: vi.fn(),
  resolveFirmwareCredential: vi.fn(),
  resolveImagePath: vi.fn(),
  recordCredentialUse: vi.fn(),
  openMaintenanceHold: vi.fn(),
  releaseMaintenanceHold: vi.fn(),
  notifyScheduledRunFinished: vi.fn(),
  notifyRunStarted: vi.fn(),
  notifyRunFinished: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/firmwareRepositoryService.js", () => ({
  findUpgradeCandidates: h.findUpgradeCandidates,
  firmwareVsPrimary: h.firmwareVsPrimary,
  loadPrimaryFirmwareImages: h.loadPrimaryFirmwareImages,
  primaryImageForAsset: h.primaryImageForAsset,
  resolveFirmwareCredential: h.resolveFirmwareCredential,
  resolveImagePath: h.resolveImagePath,
}));
vi.mock("../../src/services/firmwareEngines/index.js", () => ({
  engineFor: (m: string | null, t: string, serial: string | null) =>
    (m ?? "").toLowerCase() === "fortinet" && ["switch", "access_point", "firewall"].includes(t) && serial ? { kind: `${t}-engine` } : null,
  engineByKind: () => null,
}));
vi.mock("../../src/services/credentialUseAuditService.js", () => ({ recordCredentialUse: h.recordCredentialUse }));
vi.mock("../../src/services/maintenanceScheduleService.js", () => ({
  openMaintenanceHold: h.openMaintenanceHold,
  releaseMaintenanceHold: h.releaseMaintenanceHold,
}));
vi.mock("../../src/services/holdRecoveryWait.js", () => ({ holdUntilMonitorAnswers: vi.fn() }));
vi.mock("../../src/services/connectionPathService.js", () => ({ resolveConnectionPath: vi.fn() }));
vi.mock("../../src/services/firmwareScheduleService.js", () => ({ notifyScheduledRunFinished: h.notifyScheduledRunFinished }));
vi.mock("../../src/services/firmwareEmailService.js", () => ({
  notifyRunStarted: h.notifyRunStarted,
  notifyRunFinished: h.notifyRunFinished,
}));

import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import {
  abortAllFirmwareRuns,
  assessGroupCandidate,
  checkSchedulableUpgrade,
  failOrphanedFirmwareRuns,
  getRun,
  getRunForAsset,
  getUpgradeAvailability,
  healthBlockers,
  listRunsForAsset,
  recordFirmwareCredentialUse,
  type FirmwareAssetRow,
} from "../../src/services/firmwareUpgradeService.js";

const NOW = new Date("2026-07-01T09:00:00Z");

function asset(over: Partial<FirmwareAssetRow> = {}): FirmwareAssetRow {
  return {
    id: "a1", hostname: "sw1", ipAddress: "10.0.0.5", dnsName: null, serialNumber: "S248EP0000001", manufacturer: "Fortinet",
    assetType: "switch", model: "FS-248E", osVersion: "7.2.0", status: "active", monitored: true, monitorStatus: "up",
    dependencySuppressed: false, discoveredByIntegrationId: "i1", fortinetTopology: null,
    ...over,
  };
}

const IMG = { id: "img-p", versionLabel: "7.4.3" } as any;
const BACKUP = { id: "img-b", versionLabel: "7.4.2" } as any;
const CRED = { credentialId: "c1", scope: "model" } as any;

function run(over: Record<string, unknown> = {}) {
  return {
    id: "r1", assetId: "a1", imageId: "img-p", platform: "S248EP", fromVersion: "7.2.0", toVersion: "7.4.3", engine: "x",
    status: "running", stage: "staging", progress: null, result: null, error: null, verifiedVersion: null,
    startedBy: "alice", startedAt: NOW, finishedAt: null, heartbeatAt: null, log: [],
    asset: { hostname: "sw1", ipAddress: "10.0.0.5", model: "FS-248E" },
    ...over,
  };
}

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  for (const f of Object.values(h)) f.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.findUpgradeCandidates.mockResolvedValue({ reason: "ok", engine: "switch-engine", platform: "S248EP", primary: IMG, backup: BACKUP, current: "7.2.0" });
  h.resolveFirmwareCredential.mockResolvedValue(CRED);
  h.loadPrimaryFirmwareImages.mockResolvedValue([]);
  vi.mocked(prisma.firmwareUpgradeRun.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.asset.findMany).mockResolvedValue([] as never);
});

describe("healthBlockers", () => {
  it("a clean, answering device has none", () => {
    expect(healthBlockers(asset())).toEqual([]);
  });

  it("every unmonitorable status blocks", () => {
    for (const status of ["decommissioned", "disabled", "storage", "quarantined"]) {
      expect(healthBlockers(asset({ status }))).toEqual([`the asset is ${status}`]);
    }
  });

  it("down / warning / recovering block; maintenance does not", () => {
    for (const s of ["down", "warning", "recovering"]) {
      expect(healthBlockers(asset({ monitorStatus: s }))[0]).toMatch(new RegExp(`^the device is ${s}`));
    }
    expect(healthBlockers(asset({ monitorStatus: "maintenance" }))).toEqual([]);
  });

  it("an unmonitored device's stale down status does not block", () => {
    expect(healthBlockers(asset({ monitored: false, monitorStatus: "down" }))).toEqual([]);
  });

  it("dependency suppression and no address both block, in order", () => {
    expect(healthBlockers(asset({ dependencySuppressed: true, ipAddress: null }))).toEqual([
      "the device is behind a parent that is down (dependency-suppressed)",
      "the asset has no IP address to reach the web UI at",
    ]);
    expect(healthBlockers(asset({ ipAddress: null, dnsName: "sw1.corp" }))).toEqual([]);
  });
});

describe("getUpgradeAvailability — HA clusters (rule 129) and pending discovery", () => {
  const fw = (topo: Record<string, unknown>, over: Partial<FirmwareAssetRow> = {}) =>
    asset({ assetType: "firewall", serialNumber: "FG100F0000001", hostname: "fgt-b", fortinetTopology: topo, ...over });

  it("a secondary points at its primary and shows the primary's live run", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(fw({ haMode: "a-p", haRole: "secondary", haPeerSerial: "fg100f0000002" }) as never);
    vi.mocked(prisma.asset.findMany).mockResolvedValue([{ id: "p1", hostname: "fgt-a", serialNumber: "FG100F0000002", fortinetTopology: { haRole: "primary" } }] as never);
    vi.mocked(prisma.firmwareUpgradeRun.findFirst)
      .mockResolvedValueOnce(null as never) // own active
      .mockResolvedValueOnce(null as never) // own last
      .mockResolvedValueOnce(run({ id: "rp", assetId: "p1" }) as never);
    const r = await getUpgradeAvailability("a1");
    expect(r.state).toBe("cluster-member");
    expect(r.clusterPrimary).toEqual({ assetId: "p1", hostname: "fgt-a" });
    expect(r.reason).toContain("(fgt-a)");
    expect(r.activeRun?.id).toBe("rp");
    const where = vi.mocked(prisma.asset.findMany).mock.calls[0]![0]!.where as any;
    expect(where.OR[0]).toEqual({ serialNumber: { equals: "FG100F0000002", mode: "insensitive" } });
  });

  it("a secondary whose primary is unknown still says cluster-member, with no primary", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(fw({ haMode: "a-p", haRole: "secondary" }) as never);
    const r = await getUpgradeAvailability("a1");
    expect(r).toMatchObject({ state: "cluster-member", clusterPrimary: null, activeRun: null });
  });

  it("an active-active cluster's primary is unsupported", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(fw({ haMode: "a-a", haRole: "primary" }) as never);
    const r = await getUpgradeAvailability("a1");
    expect(r.state).toBe("unsupported");
    expect(r.reason).toMatch(/^The FortiGate's HA cluster runs mode a-a/);
  });

  it("an a-p primary lists the cluster: itself first, known peers, and a peer with no record", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(fw({ haMode: "a-p", haRole: "primary", haPeerSerial: "FG100F0000009" }, { hostname: "fgt-a" }) as never);
    vi.mocked(prisma.asset.findMany).mockResolvedValue([{ id: "s1", hostname: "fgt-c", serialNumber: "fg100f0000003", fortinetTopology: {} }] as never);
    const r = await getUpgradeAvailability("a1");
    expect(r.state).toBe("available");
    expect(r.cluster).toEqual({
      mode: "a-p",
      members: [
        { serial: "FG100F0000001", assetId: "a1", hostname: "fgt-a", role: "primary" },
        { serial: "FG100F0000003", assetId: "s1", hostname: "fgt-c", role: "secondary" },
        { serial: "FG100F0000009", assetId: null, hostname: null, role: "secondary" },
      ],
    });
  });

  it("a standalone device carries no cluster", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset() as never);
    expect((await getUpgradeAvailability("a1")).cluster).toBeUndefined();
  });

  it("the image the last succeeded run flashed is not re-offered (pending-discovery)", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset() as never);
    vi.mocked(prisma.firmwareUpgradeRun.findFirst)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce(run({ status: "succeeded", verifiedVersion: "7.4.3", imageId: "img-p" }) as never);
    const r = await getUpgradeAvailability("a1");
    expect(r).toMatchObject({ state: "pending-discovery", available: false, image: IMG });
    expect(h.resolveFirmwareCredential).not.toHaveBeenCalled();
  });

  it("an unverified last run of the same image does NOT suppress the offer", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset() as never);
    vi.mocked(prisma.firmwareUpgradeRun.findFirst)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce(run({ status: "succeeded", verifiedVersion: null }) as never);
    expect((await getUpgradeAvailability("a1")).state).toBe("available");
  });

  it("a firewall with no login names the token alternative", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(fw({}) as never);
    h.resolveFirmwareCredential.mockResolvedValue(null);
    const r = await getUpgradeAvailability("a1");
    expect(r.state).toBe("no-credential");
    expect(r.reason).toContain("or API token");
  });

  it("platform-unmatched names the six-character platform", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset() as never);
    h.findUpgradeCandidates.mockResolvedValue({ reason: "platform-unmatched", engine: "e", platform: "S248EP", primary: null, backup: null });
    const r = await getUpgradeAvailability("a1");
    expect(r).toMatchObject({ state: "no-image" });
    expect(r.reason).toContain("platform S248EP");
  });

  it("404 for an unknown asset", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(null as never);
    await expect(getUpgradeAvailability("x")).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe("checkSchedulableUpgrade (rule 93)", () => {
  it("404 for an unknown asset", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(null as never);
    await expect(checkSchedulableUpgrade("x", "img-p")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("health is a warning at booking time, not a refusal", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset({ monitorStatus: "down" }) as never);
    const r = await checkSchedulableUpgrade("a1", "img-p");
    expect(r.approved).toBe(IMG);
    expect(r.fromVersion).toBe("7.2.0");
    expect(r.warnings[0]).toMatch(/^the device is down/);
  });

  it("the eligible backup may be booked; any other image may not", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset() as never);
    expect((await checkSchedulableUpgrade("a1", "img-b")).approved).toBe(BACKUP);
    await expect(checkSchedulableUpgrade("a1", "img-old")).rejects.toMatchObject({
      httpStatus: 400, message: expect.stringContaining("or its backup (7.4.2)"),
    });
  });

  it("an empty imageId is refused as required", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset() as never);
    await expect(checkSchedulableUpgrade("a1", "")).rejects.toMatchObject({ httpStatus: 400, message: expect.stringMatching(/imageId is required/) });
  });

  it("no bound login refuses the booking (400)", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset() as never);
    h.resolveFirmwareCredential.mockResolvedValue(null);
    await expect(checkSchedulableUpgrade("a1", "img-p")).rejects.toMatchObject({ httpStatus: 400, message: expect.stringMatching(/^No device admin login is bound/) });
  });

  it("an HA secondary cannot be booked; nothing newer is a 409", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset({ assetType: "firewall", serialNumber: "FG100F0000001", fortinetTopology: { haMode: "a-p", haRole: "secondary" } }) as never);
    await expect(checkSchedulableUpgrade("a1", "img-p")).rejects.toMatchObject({ httpStatus: 400, message: expect.stringMatching(/^Cannot upgrade: .*secondary/) });

    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset() as never);
    h.findUpgradeCandidates.mockResolvedValue({ reason: "current", current: "7.4.3", primary: null });
    await expect(checkSchedulableUpgrade("a1", "img-p")).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("a placeholder / short serial names no platform", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset({ serialNumber: "S24" }) as never);
    await expect(checkSchedulableUpgrade("a1", "img-p")).rejects.toMatchObject({ httpStatus: 400, message: expect.stringMatching(/no usable serial number/) });
  });
});

describe("assessGroupCandidate (rule 122)", () => {
  it("ok: the PRIMARY image, with health as warnings", async () => {
    const r = await assessGroupCandidate(asset({ dependencySuppressed: true }));
    expect(r).toEqual({ ok: true, image: IMG, fromVersion: "7.2.0", warnings: ["the device is behind a parent that is down (dependency-suppressed)"] });
  });

  it("no engine → unsupported, and no candidate query", async () => {
    const r = await assessGroupCandidate(asset({ manufacturer: "Cisco" }));
    expect(r).toMatchObject({ ok: false, kind: "unsupported" });
    expect(h.findUpgradeCandidates).not.toHaveBeenCalled();
  });

  it("any HA member — even a primary — is refused", async () => {
    const r = await assessGroupCandidate(asset({ assetType: "firewall", serialNumber: "FG100F0000001", fortinetTopology: { haMode: "a-p", haRole: "primary" } }));
    expect(r).toMatchObject({ ok: false, kind: "ha-member" });
  });

  it("no address → no-address", async () => {
    expect(await assessGroupCandidate(asset({ ipAddress: null }))).toMatchObject({ ok: false, kind: "no-address" });
  });

  it("maps each candidate refusal to its drop kind", async () => {
    const cases: Array<[string, string]> = [
      ["current", "current"], ["no-serial", "no-serial"], ["no-version", "no-version"],
      ["no-engine", "unsupported"], ["no-images", "no-image"], ["platform-unmatched", "no-image"],
    ];
    for (const [reason, kind] of cases) {
      h.findUpgradeCandidates.mockResolvedValueOnce({ reason, platform: "S248EP", current: null, primary: null });
      expect(await assessGroupCandidate(asset())).toMatchObject({ ok: false, kind });
    }
  });

  it("no login → no-credential, never a throw", async () => {
    h.resolveFirmwareCredential.mockResolvedValue(null);
    expect(await assessGroupCandidate(asset())).toMatchObject({ ok: false, kind: "no-credential" });
  });
});

describe("recordFirmwareCredentialUse (rule 112)", () => {
  it("records the stored login aimed at the asset's address", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset() as never);
    await recordFirmwareCredentialUse("a1", "alice" as never);
    expect(h.recordCredentialUse).toHaveBeenCalledWith("alice", "firmware.flash", [
      { credentialId: "c1", destination: "10.0.0.5", assetId: "a1", assetName: "sw1" },
    ]);
  });

  it("falls back to the DNS name, then the hostname, for the destination", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset({ ipAddress: null, dnsName: null }) as never);
    await recordFirmwareCredentialUse("a1", "alice" as never);
    expect(h.recordCredentialUse.mock.calls[0]![2][0].destination).toBe("sw1");
  });

  it("nothing for an integration-token binding or a missing asset", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(asset() as never);
    h.resolveFirmwareCredential.mockResolvedValue({ credentialId: null, scope: "manufacturer" });
    await recordFirmwareCredentialUse("a1", "alice" as never);
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(null as never);
    await recordFirmwareCredentialUse("a1", "alice" as never);
    expect(h.recordCredentialUse).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    vi.mocked(prisma.asset.findUnique).mockRejectedValue(new Error("db"));
    await expect(recordFirmwareCredentialUse("a1", "alice" as never)).resolves.toBeUndefined();
  });
});

describe("reads", () => {
  it("getRun returns the summary, the log and the asset; 404 when absent", async () => {
    vi.mocked(prisma.firmwareUpgradeRun.findUnique).mockResolvedValue(run({ log: null }) as never);
    const r = await getRun("r1");
    expect(r).toMatchObject({ id: "r1", log: [], asset: { hostname: "sw1" } });
    vi.mocked(prisma.firmwareUpgradeRun.findUnique).mockResolvedValue(null as never);
    await expect(getRun("x")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("getRunForAsset answers another asset's run with the same 404", async () => {
    vi.mocked(prisma.firmwareUpgradeRun.findUnique).mockResolvedValue(run({ assetId: "other" }) as never);
    await expect(getRunForAsset("a1", "r1")).rejects.toMatchObject({ httpStatus: 404, message: "Firmware upgrade run not found" });
  });

  it("listRunsForAsset clamps the limit to 1..100, newest first", async () => {
    vi.mocked(prisma.firmwareUpgradeRun.findMany).mockResolvedValue([] as never);
    await listRunsForAsset("a1", 0);
    await listRunsForAsset("a1", 5000);
    await listRunsForAsset("a1");
    expect(vi.mocked(prisma.firmwareUpgradeRun.findMany).mock.calls.map((c) => (c[0] as any).take)).toEqual([1, 100, 20]);
    expect((vi.mocked(prisma.firmwareUpgradeRun.findMany).mock.calls[0]![0] as any).orderBy).toEqual({ startedAt: "desc" });
  });
});

describe("abortAllFirmwareRuns / failOrphanedFirmwareRuns", () => {
  it("abortAll closes every orphaned live run and returns what it aborted, skipping one that failed", async () => {
    vi.mocked(prisma.firmwareUpgradeRun.findMany).mockResolvedValue([{ id: "r1" }, { id: "r2" }] as never);
    vi.mocked(prisma.firmwareUpgradeRun.findUnique).mockImplementation((async (args: any) =>
      args.where.id === "r1" ? run({ id: "r1" }) : run({ id: "r2", status: "succeeded" })) as never);
    vi.mocked(prisma.firmwareUpgradeRun.update).mockImplementation((async (args: any) => run({ id: args.where.id, ...args.data })) as never);
    const out = await abortAllFirmwareRuns("updater", "restart");
    expect(out.map((r) => [r.id, r.status, r.result])).toEqual([["r1", "failed", "aborted"]]);
    expect(out[0]!.error).toBe("Aborted by updater during staging (restart) — no runner was driving this run; verify the device's version by hand");
    expect(h.releaseMaintenanceHold).toHaveBeenCalledWith({ assetId: "a1", kind: "firmware-upgrade" });
    expect(eventLog.logEvent.mock.calls[0]![0]).toMatchObject({ action: "firmware.upgrade_aborted", actor: "updater", details: { orphaned: true, reason: "restart" } });
  });

  it("failOrphaned marks each live run failed, drops its hold, audits, and notifies", async () => {
    vi.mocked(prisma.firmwareUpgradeRun.findMany).mockResolvedValue([
      { id: "r1", assetId: "a1", toVersion: "7.4.3", asset: { hostname: null, ipAddress: "10.0.0.5" } },
    ] as never);
    vi.mocked(prisma.firmwareUpgradeRun.update).mockResolvedValue({} as never);
    expect(await failOrphanedFirmwareRuns()).toBe(1);
    expect(vi.mocked(prisma.firmwareUpgradeRun.update).mock.calls[0]![0]).toMatchObject({
      where: { id: "r1" }, data: { status: "failed", result: "failed", finishedAt: NOW },
    });
    expect(h.releaseMaintenanceHold).toHaveBeenCalledWith({ assetId: "a1", kind: "firmware-upgrade" });
    expect(eventLog.logEvent.mock.calls[0]![0]).toMatchObject({ action: "firmware.upgrade_failed", resourceName: "10.0.0.5", actor: "system:firmware" });
    expect(h.notifyScheduledRunFinished).toHaveBeenCalledWith("r1");
    expect(h.notifyRunFinished).toHaveBeenCalledWith("r1");
  });

  it("a failed hold release or email never stops the orphan sweep", async () => {
    vi.mocked(prisma.firmwareUpgradeRun.findMany).mockResolvedValue([
      { id: "r1", assetId: "a1", toVersion: "1", asset: { hostname: "x", ipAddress: null } },
      { id: "r2", assetId: "a2", toVersion: "1", asset: { hostname: "y", ipAddress: null } },
    ] as never);
    vi.mocked(prisma.firmwareUpgradeRun.update).mockRejectedValue(new Error("gone"));
    h.releaseMaintenanceHold.mockRejectedValue(new Error("db"));
    h.notifyRunFinished.mockRejectedValue(new Error("smtp"));
    expect(await failOrphanedFirmwareRuns()).toBe(2);
    expect(eventLog.logEvent).toHaveBeenCalledTimes(2);
  });

  it("no live runs → 0, nothing written", async () => {
    vi.mocked(prisma.firmwareUpgradeRun.findMany).mockResolvedValue([] as never);
    expect(await failOrphanedFirmwareRuns()).toBe(0);
    expect(prisma.firmwareUpgradeRun.update).not.toHaveBeenCalled();
  });
});
