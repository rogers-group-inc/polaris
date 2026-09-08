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
const {
  queryRawUnsafe,
  detectionState,
  goAvailableMock,
  containerMock,
  pgbouncerMock,
  settingFindUnique,
  settingUpsert,
  logEventMock,
} = vi.hoisted(() => ({
  queryRawUnsafe: vi.fn(),
  detectionState: vi.fn(),
  goAvailableMock: vi.fn(),
  containerMock: vi.fn(),
  pgbouncerMock: vi.fn(),
  settingFindUnique: vi.fn(),
  settingUpsert: vi.fn(),
  logEventMock: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    $queryRawUnsafe: queryRawUnsafe,
    setting: { findUnique: settingFindUnique, upsert: settingUpsert },
  },
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: logEventMock }));
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
  lifecycleCapacityReasons,
  LIFECYCLE_REASON_FAMILY,
  lifecycleFingerprint,
  recordPlatformLifecycleTransition,
  lifecycleStateIsFresh,
  LIFECYCLE_STATE_SETTING_KEY,
  LIFECYCLE_CHANGED_ACTION,
  LIFECYCLE_RECOVERED_ACTION,
  LIFECYCLE_WATCH_MIN_AGE_MS,
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
  settingFindUnique.mockResolvedValue(null);
  settingUpsert.mockResolvedValue({});
  logEventMock.mockResolvedValue(undefined);
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

describe("lifecycleCapacityReasons", () => {
  function result(components: any[]): any {
    return {
      computedAt: new Date().toISOString(),
      datasetReviewedAt: "2026-09-08",
      datasetError: null,
      severity: "none",
      components,
      informational: [],
    };
  }

  function c(over: Record<string, any> = {}): any {
    return {
      id: "node",
      label: "Node.js",
      observedVersion: "20.19.0",
      polarisMinimum: "20",
      polarisTarget: "24",
      targetTrackEolAt: "2028-04-30",
      grade: {
        state: "eol",
        severity: "critical",
        track: "20",
        eolAt: "2026-04-30",
        daysUntilEol: -131,
        capacitySeverityCap: "warning",
      },
      ...over,
    };
  }

  it("emits nothing when everything is healthy", () => {
    expect(lifecycleCapacityReasons(result([]))).toEqual([]);
    expect(
      lifecycleCapacityReasons(result([c({ grade: { ...c().grade, severity: "none", state: "current" } })])),
    ).toEqual([]);
  });

  it("never emits a watch-severity row", () => {
    // "Node 20 goes EOL in five months" is real but not yet actionable, and a
    // capacity row would fire a severity-transition Event on every restart.
    expect(
      lifecycleCapacityReasons(result([c({ grade: { ...c().grade, severity: "watch", state: "aging" } })])),
    ).toEqual([]);
  });

  it("caps upstream EOL at warning even when the component grades critical", () => {
    const out = lifecycleCapacityReasons(result([c()]));
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("warning");
    expect(out[0].code).toBe("platform_eol");
  });

  it("leaves below_minimum uncapped so it reaches the sidebar alert", () => {
    const out = lifecycleCapacityReasons(
      result([
        c({
          observedVersion: "18.20.4",
          grade: { state: "below_minimum", severity: "critical", track: "18", eolAt: null, daysUntilEol: null },
        }),
      ]),
    );
    expect(out[0].severity).toBe("critical");
    expect(out[0].code).toBe("platform_below_minimum");
    expect(out[0].message).toContain("below Polaris's minimum");
  });

  it("puts every row in one family so the collapse pass yields one", () => {
    const out = lifecycleCapacityReasons(
      result([
        c(),
        c({ id: "postgres", label: "PostgreSQL", grade: { ...c().grade, state: "approaching_eol", severity: "warning", daysUntilEol: 74, capacitySeverityCap: undefined } }),
      ]),
    );
    expect(new Set(out.map((r) => r.family))).toEqual(new Set([LIFECYCLE_REASON_FAMILY]));
  });

  it("names the breadth on the winning row, since collapse merges suggestions not messages", () => {
    const out = lifecycleCapacityReasons(
      result([
        c(),
        c({ id: "postgres", label: "PostgreSQL", grade: { ...c().grade, severity: "warning", state: "approaching_eol", daysUntilEol: 74, capacitySeverityCap: undefined } }),
        c({ id: "nginx", label: "nginx", grade: { ...c().grade, severity: "warning", state: "approaching_eol", daysUntilEol: 20, capacitySeverityCap: undefined } }),
      ]),
    );
    expect(out[0].message).toContain("+2 other platform components need attention");
  });

  it("says nothing about breadth when there is only one problem", () => {
    expect(lifecycleCapacityReasons(result([c()]))[0].message).not.toContain("other platform component");
  });

  it("states the approaching-EOL day count and the target", () => {
    const out = lifecycleCapacityReasons(
      result([
        c({ grade: { ...c().grade, state: "approaching_eol", severity: "warning", daysUntilEol: 74, eolAt: "2026-11-21", capacitySeverityCap: undefined } }),
      ]),
    );
    expect(out[0].code).toBe("platform_eol_approaching");
    expect(out[0].message).toContain("74 days");
    expect(out[0].suggestion).toContain("Node.js 24");
    expect(out[0].suggestion).toContain("2028-04-30");
  });

  it("mentions extended support when that is the state", () => {
    const out = lifecycleCapacityReasons(
      result([
        c({ grade: { ...c().grade, state: "eol_extended", severity: "warning", extendedSupportUntil: "2032-04-21" } }),
      ]),
    );
    expect(out[0].message).toContain("Extended support runs to 2032-04-21");
  });
});

describe("transition recording", () => {
  function res(over: Record<string, any> = {}): any {
    return {
      computedAt: new Date().toISOString(),
      datasetReviewedAt: "2026-09-08",
      datasetError: null,
      severity: "warning",
      components: [
        {
          id: "node",
          label: "Node.js",
          observedVersion: "20.19.0",
          grade: { state: "eol", severity: "warning", track: "20", eolAt: "2026-04-30", daysUntilEol: -131 },
        },
      ],
      informational: [],
      ...over,
    };
  }

  const stored = (v: Record<string, any>) => ({ key: LIFECYCLE_STATE_SETTING_KEY, value: v });

  it("fires on the first observation and records the state", async () => {
    await recordPlatformLifecycleTransition(res());
    expect(logEventMock).toHaveBeenCalledTimes(1);
    const ev = logEventMock.mock.calls[0][0];
    expect(ev.action).toBe(LIFECYCLE_CHANGED_ACTION);
    expect(ev.resourceType).toBe("system");
    expect(ev.actor).toBe("system");
    expect(ev.details.direction).toBe("initial");
    expect(settingUpsert).toHaveBeenCalledTimes(1);
  });

  it("no-ops when neither severity nor fingerprint changed", async () => {
    const r = res();
    settingFindUnique.mockResolvedValue(
      stored({ severity: "warning", fingerprint: lifecycleFingerprint(r), recordedAt: new Date().toISOString() }),
    );
    await recordPlatformLifecycleTransition(r);
    expect(logEventMock).not.toHaveBeenCalled();
    expect(settingUpsert).not.toHaveBeenCalled();
  });

  it("fires when the fingerprint changed at the SAME severity", async () => {
    // The whole reason the fingerprint exists: an install already at warning
    // for Node that also goes EOL on PostgreSQL stays at warning, and a
    // severity-only compare would never mention the second problem.
    settingFindUnique.mockResolvedValue(
      stored({ severity: "warning", fingerprint: "node:20:approaching_eol", recordedAt: new Date().toISOString() }),
    );
    await recordPlatformLifecycleTransition(res());
    expect(logEventMock).toHaveBeenCalledTimes(1);
    expect(logEventMock.mock.calls[0][0].details.direction).toBe("changed");
  });

  it("emits the recovery action when everything is back in support", async () => {
    settingFindUnique.mockResolvedValue(
      stored({ severity: "critical", fingerprint: "node:20:eol", recordedAt: new Date().toISOString() }),
    );
    await recordPlatformLifecycleTransition(res({ severity: "none", components: [] }));
    const ev = logEventMock.mock.calls[0][0];
    expect(ev.action).toBe(LIFECYCLE_RECOVERED_ACTION);
    expect(ev.level).toBe("info");
  });

  it("uses error level for a critical escalation", async () => {
    settingFindUnique.mockResolvedValue(
      stored({ severity: "none", fingerprint: "", recordedAt: new Date().toISOString() }),
    );
    await recordPlatformLifecycleTransition(res({ severity: "critical" }));
    const ev = logEventMock.mock.calls[0][0];
    expect(ev.level).toBe("error");
    expect(ev.details.direction).toBe("escalated");
  });

  it("carries every non-ok component in details, not just the headline", async () => {
    const r = res({
      severity: "critical",
      components: [
        { id: "node", label: "Node.js", observedVersion: "20.1.0", grade: { state: "eol", severity: "critical", track: "20", eolAt: "2026-04-30", daysUntilEol: -131 } },
        { id: "go", label: "Go toolchain", observedVersion: "1.22.7", grade: { state: "eol", severity: "warning", track: "1.22", eolAt: "2025-02-11", daysUntilEol: -574 } },
        { id: "prisma", label: "Prisma", observedVersion: "7.9.1", grade: { state: "unknown", severity: "none", track: "7", eolAt: null, daysUntilEol: null } },
      ],
    });
    await recordPlatformLifecycleTransition(r);
    const ids = logEventMock.mock.calls[0][0].details.components.map((c: any) => c.id);
    expect(ids).toEqual(["node", "go"]); // the severity:none row is excluded
  });

  it("never throws when the Setting write fails", async () => {
    settingUpsert.mockRejectedValue(new Error("read-only transaction"));
    await expect(recordPlatformLifecycleTransition(res())).resolves.toBeUndefined();
  });

  it("never throws when logEvent fails", async () => {
    logEventMock.mockRejectedValue(new Error("event table gone"));
    await expect(recordPlatformLifecycleTransition(res())).resolves.toBeUndefined();
  });
});

describe("lifecycleFingerprint", () => {
  it("ignores healthy components and is order-independent", () => {
    const mk = (components: any[]) => ({ components } as any);
    const a = mk([
      { id: "go", grade: { track: "1.22", state: "eol", severity: "warning" } },
      { id: "node", grade: { track: "20", state: "eol", severity: "critical" } },
      { id: "prisma", grade: { track: "7", state: "unknown", severity: "none" } },
    ]);
    const b = mk([
      { id: "node", grade: { track: "20", state: "eol", severity: "critical" } },
      { id: "go", grade: { track: "1.22", state: "eol", severity: "warning" } },
    ]);
    expect(lifecycleFingerprint(a)).toBe(lifecycleFingerprint(b));
  });

  it("changes when a component's state changes", () => {
    const mk = (state: string) =>
      ({ components: [{ id: "node", grade: { track: "20", state, severity: "warning" } }] } as any);
    expect(lifecycleFingerprint(mk("approaching_eol"))).not.toBe(lifecycleFingerprint(mk("eol")));
  });
});

describe("lifecycleStateIsFresh — the restart-loop guard", () => {
  it("is false with no stored state", async () => {
    expect(await lifecycleStateIsFresh()).toBe(false);
  });

  it("is true just inside the window", async () => {
    const now = Date.now();
    settingFindUnique.mockResolvedValue({
      key: LIFECYCLE_STATE_SETTING_KEY,
      value: { severity: "none", fingerprint: "", recordedAt: new Date(now - 1000).toISOString() },
    });
    expect(await lifecycleStateIsFresh(now)).toBe(true);
  });

  it("is false once the window has passed", async () => {
    const now = Date.now();
    settingFindUnique.mockResolvedValue({
      key: LIFECYCLE_STATE_SETTING_KEY,
      value: {
        severity: "none",
        fingerprint: "",
        recordedAt: new Date(now - LIFECYCLE_WATCH_MIN_AGE_MS - 1000).toISOString(),
      },
    });
    expect(await lifecycleStateIsFresh(now)).toBe(false);
  });
});
