/**
 * tests/unit/platformLifecycleService.test.ts
 *
 * The service's contract is mostly a NEGATIVE one: it must never throw, and it
 * must keep the capacity snapshot and the Maintenance tab renderable when the
 * lifecycle data is the only broken thing. So most of this file is failure
 * injection.
 *
 * Not testable here (needs a real host): the nginx exec under a hardened
 * systemd unit, /etc/os-release inside a container versus on RHEL, and the
 * Windows path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted, because vi.mock factories are lifted above ordinary top-level
// declarations and would otherwise read these before initialization.
const { queryRawUnsafe, detectionState, goAvailableMock, containerMock, pgbouncerMock } = vi.hoisted(() => ({
  queryRawUnsafe: vi.fn(),
  detectionState: vi.fn(),
  goAvailableMock: vi.fn(),
  containerMock: vi.fn(),
  pgbouncerMock: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({ prisma: { $queryRawUnsafe: queryRawUnsafe } }));
vi.mock("../../src/services/timescaleService.js", () => ({ getDetectionState: detectionState }));
vi.mock("../../src/services/agentBuildService.js", () => ({ goAvailable: goAvailableMock }));
vi.mock("../../src/utils/deploymentContext.js", () => ({ runtimeIsContainer: containerMock }));
vi.mock("../../src/utils/dbConnections.js", () => ({ isPgbouncerMode: pgbouncerMock }));
vi.mock("../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  getPlatformLifecycle,
  observePlatformStack,
  loadPlatformEolDataset,
  _resetLifecycleMemo,
  _resetDatasetCache,
} from "../../src/services/platformLifecycleService.js";

beforeEach(() => {
  vi.clearAllMocks();
  _resetLifecycleMemo();
  _resetDatasetCache();
  queryRawUnsafe.mockResolvedValue([{ server_version: "15.13" }]);
  detectionState.mockReturnValue({ extensionInstalled: true, extensionVersion: "2.17.2", hypertables: new Set(), detectedAt: 1 });
  goAvailableMock.mockResolvedValue({ ok: true, version: "go version go1.26.3 linux/amd64", versionNumber: "1.26.3", track: "1.26", meetsMinimum: true });
  containerMock.mockReturnValue(false);
  pgbouncerMock.mockReturnValue(false);
});

describe("loadPlatformEolDataset", () => {
  it("loads and validates the committed dataset", () => {
    const d = loadPlatformEolDataset();
    expect(d.technologies.length).toBeGreaterThan(0);
    expect(d.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("caches — a second call returns the same object", () => {
    expect(loadPlatformEolDataset()).toBe(loadPlatformEolDataset());
  });
});

describe("observePlatformStack — never throws", () => {
  it("resolves when the database query rejects", async () => {
    queryRawUnsafe.mockRejectedValue(new Error("ECONNREFUSED"));
    const out = await observePlatformStack();
    const pg = out.find((o) => o.id === "postgres")!;
    expect(pg.probeStatus).toBe("error");
    expect(pg.observedVersion).toBeNull();
  });

  it("resolves when Go is absent", async () => {
    goAvailableMock.mockResolvedValue({ ok: false, error: "go not found on PATH", meetsMinimum: false });
    const out = await observePlatformStack();
    expect(out.find((o) => o.id === "go")!.probeStatus).toBe("absent");
  });

  it("resolves when the Go probe itself rejects", async () => {
    goAvailableMock.mockRejectedValue(new Error("spawn EPERM"));
    const out = await observePlatformStack();
    expect(out.find((o) => o.id === "go")!.probeStatus).toBe("error");
  });

  it("reports the TimescaleDB extension version from cached boot state", async () => {
    const out = await observePlatformStack();
    const ts = out.find((o) => o.id === "timescaledb")!;
    expect(ts.observedVersion).toBe("2.17.2");
    expect(ts.probeStatus).toBe("ok");
    // Cached at boot — this must not cost a query.
    expect(queryRawUnsafe).not.toHaveBeenCalledWith(expect.stringContaining("pg_extension"));
  });

  it("reports the extension as undetectable when present without a version", async () => {
    detectionState.mockReturnValue({ extensionInstalled: true, extensionVersion: null, hypertables: new Set(), detectedAt: 1 });
    const out = await observePlatformStack();
    expect(out.find((o) => o.id === "timescaledb")!.probeStatus).toBe("undetectable");
  });

  it("reports the extension absent when not installed", async () => {
    detectionState.mockReturnValue({ extensionInstalled: false, extensionVersion: null, hypertables: new Set(), detectedAt: 1 });
    const out = await observePlatformStack();
    expect(out.find((o) => o.id === "timescaledb")!.probeStatus).toBe("absent");
  });

  it("reports PgBouncer as undetectable, with the manual-check note, when in use", async () => {
    pgbouncerMock.mockReturnValue(true);
    const out = await observePlatformStack();
    const pb = out.find((o) => o.id === "pgbouncer")!;
    expect(pb.probeStatus).toBe("undetectable");
    expect(pb.probeNote).toMatch(/by hand/);
  });

  it("always reports the running Node version", async () => {
    const out = await observePlatformStack();
    const node = out.find((o) => o.id === "node")!;
    expect(node.observedVersion).toBe(process.versions.node);
    expect(node.probeStatus).toBe("ok");
  });

  it("uses SHOW server_version, not SELECT version()", async () => {
    await observePlatformStack();
    expect(queryRawUnsafe).toHaveBeenCalledWith("SHOW server_version");
  });

  it("labels the OS row as a container base image when containerized", async () => {
    containerMock.mockReturnValue(true);
    const out = await observePlatformStack();
    const os = out.find((o) => o.id.startsWith("os:"))!;
    // On a non-Linux test host there is no /etc/os-release, so only assert the
    // note when the probe actually read one.
    if (os.probeStatus === "ok") expect(os.probeNote).toMatch(/container base image/);
    else expect(os.probeStatus).toBe("undetectable");
  });
});

describe("getPlatformLifecycle", () => {
  it("assembles a graded result without throwing", async () => {
    const r = await getPlatformLifecycle({ force: true });
    expect(r.datasetError).toBeNull();
    expect(r.components.length).toBeGreaterThan(0);
    expect(r.datasetReviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const c of r.components) {
      expect(c.grade.state).toBeTruthy();
      expect(["none", "watch", "warning", "critical"]).toContain(c.grade.severity);
    }
  });

  it("grades a Postgres major below the minimum as critical", async () => {
    queryRawUnsafe.mockResolvedValue([{ server_version: "13.14" }]);
    const r = await getPlatformLifecycle({ force: true });
    const pg = r.components.find((c) => c.id === "postgres")!;
    expect(pg.grade.state).toBe("below_minimum");
    expect(pg.grade.severity).toBe("critical");
    // The install-is-misconfigured case is uncapped on purpose.
    expect(pg.grade.capacitySeverityCap).toBeUndefined();
    expect(r.severity).toBe("critical");
  });

  it("attaches the upgrade playbook to a graded component", async () => {
    const r = await getPlatformLifecycle({ force: true });
    const pg = r.components.find((c) => c.id === "postgres")!;
    expect(pg.playbook?.id).toBe("postgres-major");
    expect(pg.playbook?.files.length).toBeGreaterThan(0);
  });

  it("never grades a policy:none component", async () => {
    const r = await getPlatformLifecycle({ force: true });
    const prisma = r.components.find((c) => c.id === "prisma")!;
    expect(prisma.grade.severity).toBe("none");
  });

  it("reports Polaris and agent versions as informational", async () => {
    const r = await getPlatformLifecycle({ force: true });
    expect(r.informational.map((i) => i.id)).toContain("polaris");
    expect(r.informational.map((i) => i.id)).toContain("polaris-agent");
  });

  it("memoizes — a second call does not re-probe", async () => {
    await getPlatformLifecycle({ force: true });
    const callsAfterFirst = goAvailableMock.mock.calls.length;
    await getPlatformLifecycle();
    expect(goAvailableMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("re-probes when forced", async () => {
    await getPlatformLifecycle({ force: true });
    const callsAfterFirst = goAvailableMock.mock.calls.length;
    await getPlatformLifecycle({ force: true });
    expect(goAvailableMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("survives a wholesale database outage with a renderable result", async () => {
    queryRawUnsafe.mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await getPlatformLifecycle({ force: true });
    expect(r.datasetError).toBeNull();
    expect(r.components.length).toBeGreaterThan(0);
    const pg = r.components.find((c) => c.id === "postgres")!;
    expect(pg.grade.state).toBe("unknown");
    expect(pg.grade.severity).toBe("none");
  });
});
