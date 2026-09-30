/**
 * tests/unit/descriptionSyncService.test.ts
 *
 * Push-path coverage for description sync with the FortiOS transport mocked
 * at the callFortiOs seam (the same seam both useProxy modes and the
 * standalone FortiGate integration flow through — reservationPushService's
 * Transport). Asserts: pre-read → PUT → read-back-verify sequencing, the
 * equal-value short-circuit (no PUT), verify-mismatch → permanent failure,
 * thrown transport errors → classified failure result (never a throw), and
 * the per-target endpoint/body shapes for interface / switch-port /
 * device-level targets.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AppError } from "../../src/utils/errors.js";

vi.mock("../../src/db.js", () => ({
  prisma: {
    asset: { findMany: vi.fn(), update: vi.fn() },
    assetInterfaceOverride: { findMany: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn() }));
vi.mock("../../src/services/reservationPushService.js", () => ({
  buildTransportForIntegration: vi.fn(),
  callFortiOs: vi.fn(),
  // Mirror of the real classifier's AppError-status behavior — the real
  // function has its own coverage in reservationPushClassify.test.ts.
  classifyPushError: (err: unknown) =>
    err instanceof AppError && [400, 404, 409].includes(err.httpStatus) ? "permanent" : "transient",
}));
vi.mock("../../src/services/fortimanagerService.js", () => ({ proxyQuery: vi.fn() }));

import { prisma } from "../../src/db.js";
import { proxyQuery } from "../../src/services/fortimanagerService.js";
import { callFortiOs, buildTransportForIntegration } from "../../src/services/reservationPushService.js";
import {
  pushInterfaceDescription,
  pushSwitchPortDescription,
  pushDeviceDescription,
  runDescriptionSyncForIntegration,
} from "../../src/services/descriptionSyncService.js";

const callMock = vi.mocked(callFortiOs);
const transportMock = vi.mocked(buildTransportForIntegration);
const fmgQueryMock = vi.mocked(proxyQuery);

const integration = { id: "intg-1", type: "fortimanager", config: {} };
const fakeTransport = { kind: "direct-fortigate", fgConfig: { host: "10.0.0.1", apiToken: "t" }, vdom: "root" } as any;

beforeEach(() => {
  vi.clearAllMocks();
  transportMock.mockResolvedValue(fakeTransport);
});

describe("pushInterfaceDescription", () => {
  it("pre-reads, PUTs, verifies, and reports the overwritten device value", async () => {
    callMock
      .mockResolvedValueOnce([{ name: "port1", description: "device old" }]) // pre-read
      .mockResolvedValueOnce({}) // PUT
      .mockResolvedValueOnce([{ name: "port1", description: "new value" }]); // verify
    const res = await pushInterfaceDescription({
      integration, deviceName: "FG-BRANCH-01", ifName: "port1", value: "new value",
    });
    expect(res).toEqual({ ok: true, previousDeviceValue: "device old" });
    expect(callMock).toHaveBeenCalledTimes(3);
    const put = callMock.mock.calls[1];
    expect(put[1]).toBe("PUT");
    expect(put[2]).toBe("/api/v2/cmdb/system/interface/port1");
    expect(put[3]).toEqual({ description: "new value" });
  });

  it("skips the PUT entirely when the device already matches", async () => {
    callMock.mockResolvedValueOnce([{ name: "port1", description: "same" }]);
    const res = await pushInterfaceDescription({
      integration, deviceName: "FG-BRANCH-01", ifName: "port1", value: "same",
    });
    expect(res.ok).toBe(true);
    expect(callMock).toHaveBeenCalledTimes(1); // pre-read only
  });

  it("skips the pre-read when currentDeviceValue is supplied (reconcile path)", async () => {
    callMock
      .mockResolvedValueOnce({}) // PUT
      .mockResolvedValueOnce([{ description: "v2" }]); // verify
    const res = await pushInterfaceDescription({
      integration, deviceName: "FG-BRANCH-01", ifName: "port1", value: "v2",
      currentDeviceValue: "v1", transport: fakeTransport,
    });
    expect(res).toEqual({ ok: true, previousDeviceValue: "v1" });
    expect(transportMock).not.toHaveBeenCalled();
    expect(callMock.mock.calls[0][1]).toBe("PUT");
  });

  it("flags a verify mismatch as a permanent failure", async () => {
    callMock
      .mockResolvedValueOnce([{ description: "old" }]) // pre-read
      .mockResolvedValueOnce({}) // PUT accepted…
      .mockResolvedValueOnce([{ description: "old" }]); // …but device kept the old value
    const res = await pushInterfaceDescription({
      integration, deviceName: "FG-BRANCH-01", ifName: "port1", value: "new",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errorKind).toBe("permanent");
      expect(res.error).toContain("verify mismatch");
    }
  });

  it("returns a classified failure instead of throwing on transport errors", async () => {
    callMock.mockRejectedValueOnce(new AppError(404, "Endpoint not found"));
    const notFound = await pushInterfaceDescription({
      integration, deviceName: "FG-BRANCH-01", ifName: "port1", value: "v",
    });
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) expect(notFound.errorKind).toBe("permanent");

    callMock.mockRejectedValueOnce(new Error("ETIMEDOUT"));
    const timeout = await pushInterfaceDescription({
      integration, deviceName: "FG-BRANCH-01", ifName: "port1", value: "v",
    });
    expect(timeout.ok).toBe(false);
    if (!timeout.ok) expect(timeout.errorKind).toBe("transient");
  });

  it("URL-encodes interface names", async () => {
    callMock
      .mockResolvedValueOnce([{ description: null }])
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce([{ description: "v" }]);
    await pushInterfaceDescription({
      integration, deviceName: "FG", ifName: "ae1/2", value: "v",
    });
    expect(callMock.mock.calls[1][2]).toBe("/api/v2/cmdb/system/interface/ae1%2F2");
  });
});

describe("pushSwitchPortDescription", () => {
  it("pre-reads the managed-switch row and PUTs the child ports entry", async () => {
    callMock
      .mockResolvedValueOnce([{
        "switch-id": "S124EP1234567890",
        ports: [{ "port-name": "port5", description: "old port desc" }],
      }]) // pre-read (whole switch row)
      .mockResolvedValueOnce({}) // PUT child entry
      .mockResolvedValueOnce([{ description: "patch bay 3" }]); // verify child entry
    const res = await pushSwitchPortDescription({
      integration, deviceName: "FG-BRANCH-01",
      switchId: "S124EP1234567890", portName: "port5", value: "patch bay 3",
    });
    expect(res).toEqual({ ok: true, previousDeviceValue: "old port desc" });
    const put = callMock.mock.calls[1];
    expect(put[2]).toBe("/api/v2/cmdb/switch-controller/managed-switch/S124EP1234567890/ports/port5");
    expect(put[3]).toEqual({ description: "patch bay 3" });
  });

  it("truncates to the switch-port cap (63)", async () => {
    const long = "z".repeat(100);
    callMock
      .mockResolvedValueOnce([{ "switch-id": "SN", ports: [{ "port-name": "port1", description: null }] }])
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce([{ description: "z".repeat(63) }]);
    const res = await pushSwitchPortDescription({
      integration, deviceName: "FG", switchId: "SN", portName: "port1", value: long,
    });
    expect(res.ok).toBe(true);
    expect((callMock.mock.calls[1][3] as any).description).toHaveLength(63);
  });

  // switch-id is often renamed away from the serial (confirmed on FortiOS
  // 7.6.7) — the save-time path passes the asset serial, so it must resolve
  // the row via `sn` and PUT against the row's real mkey.
  it("resolves a renamed switch-id by serial (sn match) and PUTs the real mkey", async () => {
    callMock
      .mockResolvedValueOnce([
        { "switch-id": "CORE-SW-2", sn: "S124EPTK00000001", ports: [{ "port-name": "port5", description: "old" }] },
      ]) // full-table pre-read
      .mockResolvedValueOnce({}) // PUT
      .mockResolvedValueOnce([{ description: "patch bay 3" }]); // verify
    const res = await pushSwitchPortDescription({
      integration, deviceName: "FG-BRANCH-01",
      switchId: "S124EPTK00000001", portName: "port5", value: "patch bay 3",
    });
    expect(res).toEqual({ ok: true, previousDeviceValue: "old" });
    expect(callMock.mock.calls[0][2]).toBe("/api/v2/cmdb/switch-controller/managed-switch");
    expect(callMock.mock.calls[1][2]).toBe("/api/v2/cmdb/switch-controller/managed-switch/CORE-SW-2/ports/port5");
    expect(callMock.mock.calls[2][2]).toBe("/api/v2/cmdb/switch-controller/managed-switch/CORE-SW-2/ports/port5");
  });

  it("fails permanent when the switch is in no managed-switch row (id or sn)", async () => {
    callMock.mockResolvedValueOnce([{ "switch-id": "OTHER-SW", sn: "S999" }]);
    const res = await pushSwitchPortDescription({
      integration, deviceName: "FG", switchId: "S124MISSING", portName: "port1", value: "v",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errorKind).toBe("permanent");
      expect(res.error).toContain("not found");
    }
    expect(callMock).toHaveBeenCalledTimes(1); // no PUT attempted
  });
});

describe("pushDeviceDescription", () => {
  it("fortigate-global target writes system/global alias (capped at 35)", async () => {
    const long = "a".repeat(50);
    callMock
      .mockResolvedValueOnce([{ alias: "old alias" }]) // pre-read
      .mockResolvedValueOnce({}) // PUT
      .mockResolvedValueOnce([{ alias: "a".repeat(35) }]); // verify
    const res = await pushDeviceDescription({
      integration, deviceName: "FG-HQ", target: { kind: "fortigate-global" }, value: long,
    });
    expect(res).toEqual({ ok: true, previousDeviceValue: "old alias" });
    const put = callMock.mock.calls[1];
    expect(put[2]).toBe("/api/v2/cmdb/system/global");
    expect((put[3] as any).alias).toHaveLength(35);
  });

  it("managed-switch target writes the switch description", async () => {
    callMock
      .mockResolvedValueOnce([{ "switch-id": "SN1", description: null }])
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce([{ description: "IDF-2 stack" }]);
    const res = await pushDeviceDescription({
      integration, deviceName: "FG-HQ",
      target: { kind: "managed-switch", switchId: "SN1" }, value: "IDF-2 stack",
    });
    expect(res.ok).toBe(true);
    expect(callMock.mock.calls[1][2]).toBe("/api/v2/cmdb/switch-controller/managed-switch/SN1");
    expect(callMock.mock.calls[1][3]).toEqual({ description: "IDF-2 stack" });
  });

  it("managed-switch target resolves a renamed switch-id by serial", async () => {
    callMock
      .mockResolvedValueOnce([
        { "switch-id": "RIVERBEND-SW-01", sn: "SR12DPTD00000000", description: "old" },
      ]) // full-table pre-read
      .mockResolvedValueOnce({}) // PUT
      .mockResolvedValueOnce([{ description: "IDF closet" }]); // verify
    const res = await pushDeviceDescription({
      integration, deviceName: "RIVERBEND-101F-1",
      target: { kind: "managed-switch", switchId: "SR12DPTD00000000" }, value: "IDF closet",
    });
    expect(res).toEqual({ ok: true, previousDeviceValue: "old" });
    expect(callMock.mock.calls[1][2]).toBe("/api/v2/cmdb/switch-controller/managed-switch/RIVERBEND-SW-01");
  });

  it("wtp target writes the AP location (AP Manager's field — not comment)", async () => {
    callMock
      .mockResolvedValueOnce([{ "wtp-id": "FP231F123", location: "old" }])
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce([{ location: "lobby AP" }]);
    const res = await pushDeviceDescription({
      integration, deviceName: "FG-HQ",
      target: { kind: "wtp", wtpId: "FP231F123" }, value: "lobby AP",
    });
    expect(res).toEqual({ ok: true, previousDeviceValue: "old" });
    expect(callMock.mock.calls[1][2]).toBe("/api/v2/cmdb/wireless-controller/wtp/FP231F123");
    expect(callMock.mock.calls[1][3]).toEqual({ location: "lobby AP" });
  });

  it("a failed verify read reports transient (PUT landed, re-check next cycle)", async () => {
    callMock
      .mockResolvedValueOnce([{ alias: "old" }])
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("socket hang up"));
    const res = await pushDeviceDescription({
      integration, deviceName: "FG-HQ", target: { kind: "fortigate-global" }, value: "new",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errorKind).toBe("transient");
      expect(res.error).toContain("verify read");
    }
  });
});

describe("runDescriptionSyncForIntegration", () => {
  // Regression: a FortiLink-renamed switch-id (serial only present on `sn`)
  // used to make the reconcile's serial lookup miss the CMDB row entirely —
  // the switch was silently skipped and a Polaris description edit never
  // pushed. The row map must key by both switch-id and sn.
  it("pushes to a switch whose switch-id is renamed (serial only on `sn`)", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValue([{
      id: "a1",
      hostname: "riverbend-sw-01",
      serialNumber: "SR12DPTD00000000",
      description: "IDF closet switch",
      descriptionSync: null,
      fortinetTopology: { role: "fortiswitch", controllerFortigate: "RIVERBEND-101F-1" },
    }] as any);
    vi.mocked(prisma.assetInterfaceOverride.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.asset.update).mockResolvedValue({} as any);
    callMock.mockImplementation(async (_t, method, path) => {
      if (method === "GET" && path === "/api/v2/cmdb/switch-controller/managed-switch") {
        return [{ "switch-id": "RIVERBEND-SW-01", sn: "SR12DPTD00000000", description: "", ports: [] }];
      }
      if (method === "PUT" && path === "/api/v2/cmdb/switch-controller/managed-switch/RIVERBEND-SW-01") {
        return {};
      }
      if (method === "GET" && path === "/api/v2/cmdb/switch-controller/managed-switch/RIVERBEND-SW-01") {
        return [{ "switch-id": "RIVERBEND-SW-01", description: "IDF closet switch" }];
      }
      throw new Error(`unexpected FortiOS call: ${method} ${path}`);
    });

    const summary = await runDescriptionSyncForIntegration({
      id: "intg-1", type: "fortimanager", config: { syncDescriptions: true }, name: "FMG",
    });

    expect(summary.pushed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.skippedDevices).toBe(0);
    const put = callMock.mock.calls.find((c) => c[1] === "PUT");
    expect(put?.[2]).toBe("/api/v2/cmdb/switch-controller/managed-switch/RIVERBEND-SW-01");
    expect(put?.[3]).toEqual({ description: "IDF closet switch" });
    // Central management not detected on this integration — no FMG DB calls.
    expect(fmgQueryMock).not.toHaveBeenCalled();
  });

  // Central AP management: the per-AP rows AP Manager displays live in each
  // controller FortiGate's device DB on FMG, and the field is `location`
  // (comment doesn't exist in FMG's copy — installs strip it). A device-side
  // push must mirror there via a JSON-RPC update — never a set (which would
  // create objects), never an install.
  it("mirrors a pushed wtp location into FMG's device DB when central AP mgmt is detected", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValue([{
      id: "ap1",
      hostname: "lobby-ap",
      serialNumber: "FP231FTF00000001",
      description: "lobby AP",
      descriptionSync: null,
      fortinetTopology: { role: "fortiap", controllerFortigate: "RIVERBEND-101F-1" },
    }] as any);
    vi.mocked(prisma.assetInterfaceOverride.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.asset.update).mockResolvedValue({} as any);
    callMock.mockImplementation(async (_t, method, path) => {
      if (method === "GET" && path === "/api/v2/cmdb/wireless-controller/wtp") {
        return [{ "wtp-id": "FP231FTF00000001", location: "" }]; // location attr present → surface enabled
      }
      if (method === "PUT" && path === "/api/v2/cmdb/wireless-controller/wtp/FP231FTF00000001") return {};
      if (method === "GET" && path === "/api/v2/cmdb/wireless-controller/wtp/FP231FTF00000001") {
        return [{ "wtp-id": "FP231FTF00000001", location: "lobby AP" }];
      }
      throw new Error(`unexpected FortiOS call: ${method} ${path}`);
    });
    const fmgEnvelope = (data: unknown) => ({ result: [{ status: { code: 0 }, data }] });
    const FMG_WTP = "/pm/config/device/RIVERBEND-101F-1/vdom/root/wireless-controller/wtp";
    fmgQueryMock.mockImplementation(async (_cfg, method, params) => {
      const p = (params as Array<{ url: string; data?: unknown }>)[0];
      if (method === "get" && p.url === FMG_WTP) {
        return fmgEnvelope([{ "wtp-id": "FP231FTF00000001", location: "stale FMG copy" }]);
      }
      if (method === "update" && p.url === `${FMG_WTP}/FP231FTF00000001`) {
        return fmgEnvelope({});
      }
      if (method === "get" && p.url === `${FMG_WTP}/FP231FTF00000001`) {
        return fmgEnvelope([{ "wtp-id": "FP231FTF00000001", location: "lobby AP" }]); // read-back verify
      }
      throw new Error(`unexpected FMG call: ${method} ${JSON.stringify(p)}`);
    });

    const summary = await runDescriptionSyncForIntegration({
      id: "intg-1", type: "fortimanager",
      config: { syncDescriptions: true, adom: "root", centralManagement: { wtp: true, fsw: false } },
      name: "FMG",
    });

    expect(summary.pushed).toBe(1);        // device-side wtp PUT
    expect(summary.fmgMirrored).toBe(1);   // FMG device-DB update
    expect(summary.fmgMirrorFailed).toBe(0);
    const write = fmgQueryMock.mock.calls.find((c) => c[1] === "update");
    expect((write?.[2] as Array<{ url: string; data?: unknown }>)[0]).toEqual({
      url: `${FMG_WTP}/FP231FTF00000001`,
      data: { location: "lobby AP" },
    });
  });

  it("mirrors an already-agreed value (no push needed) when FMG's copy is stale", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValue([{
      id: "ap1",
      hostname: "lobby-ap",
      serialNumber: "FP231FTF00000001",
      description: "lobby AP",
      descriptionSync: { status: "synced", value: "lobby AP" },
      fortinetTopology: { role: "fortiap", controllerFortigate: "RIVERBEND-101F-1" },
    }] as any);
    vi.mocked(prisma.assetInterfaceOverride.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.asset.update).mockResolvedValue({} as any);
    callMock.mockImplementation(async (_t, method, path) => {
      if (method === "GET" && path === "/api/v2/cmdb/wireless-controller/wtp") {
        return [{ "wtp-id": "FP231FTF00000001", location: "lobby AP" }]; // device already agrees
      }
      throw new Error(`unexpected FortiOS call: ${method} ${path}`);
    });
    const fmgEnvelope = (data: unknown) => ({ result: [{ status: { code: 0 }, data }] });
    const FMG_WTP = "/pm/config/device/RIVERBEND-101F-1/vdom/root/wireless-controller/wtp";
    fmgQueryMock.mockImplementation(async (_cfg, method, params) => {
      const p = (params as Array<{ url: string; data?: unknown }>)[0];
      if (method === "get" && p.url === FMG_WTP) {
        return fmgEnvelope([{ "wtp-id": "FP231FTF00000001", location: "" }]); // FMG copy stale
      }
      if (method === "update") return fmgEnvelope({});
      if (method === "get") return fmgEnvelope([{ "wtp-id": "FP231FTF00000001", location: "lobby AP" }]);
      throw new Error("unexpected FMG call");
    });

    const summary = await runDescriptionSyncForIntegration({
      id: "intg-1", type: "fortimanager",
      config: { syncDescriptions: true, adom: "root", centralManagement: { wtp: true, fsw: false } },
      name: "FMG",
    });

    expect(summary.pushed).toBe(0);        // nothing to push device-side
    expect(summary.fmgMirrored).toBe(1);   // but FMG's stale copy got healed
  });

  // The toggle is per device class: with FortiSwitch sync on and FortiAP sync
  // off, the AP is never read, pushed or mirrored — even under central AP
  // management — while the switch still syncs.
  it("skips a device class whose own toggle is off", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValue([
      {
        id: "sw1", hostname: "idf-sw", serialNumber: "S108EN0000000001", description: "IDF switch",
        descriptionSync: null, fortinetTopology: { role: "fortiswitch", controllerFortigate: "FG-1" },
      },
      {
        id: "ap1", hostname: "lobby-ap", serialNumber: "FP231FTF00000001", description: "lobby AP",
        descriptionSync: { status: "synced", value: "lobby AP" },
        fortinetTopology: { role: "fortiap", controllerFortigate: "FG-1" },
      },
    ] as any);
    vi.mocked(prisma.assetInterfaceOverride.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.asset.update).mockResolvedValue({} as any);
    callMock.mockImplementation(async (_t, method, path) => {
      if (method === "GET" && path === "/api/v2/cmdb/switch-controller/managed-switch") {
        return [{ "switch-id": "S108EN0000000001", description: "IDF switch", ports: [] }];
      }
      throw new Error(`unexpected FortiOS call: ${method} ${path}`);
    });

    const summary = await runDescriptionSyncForIntegration({
      id: "intg-1", type: "fortimanager",
      config: {
        syncDescriptions: true, // legacy key — the explicit per-class keys win
        syncFortigateDescriptions: false, syncSwitchDescriptions: true, syncApDescriptions: false,
        adom: "root", centralManagement: { wtp: true, fsw: false },
      },
      name: "FMG",
    });

    expect(summary.devices).toBe(1);
    expect(callMock.mock.calls.map((c) => c[2])).toEqual(["/api/v2/cmdb/switch-controller/managed-switch"]);
    expect(fmgQueryMock).not.toHaveBeenCalled(); // no wtp mirror with AP sync off
  });

  it("does nothing when every class is off", async () => {
    const summary = await runDescriptionSyncForIntegration({
      id: "intg-1", type: "fortigate",
      config: { syncFortigateDescriptions: false, syncSwitchDescriptions: false, syncApDescriptions: false },
      name: "FG",
    });
    expect(summary.devices).toBe(0);
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
  });
});
