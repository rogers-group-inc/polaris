/**
 * tests/unit/fortinetControllers.test.ts
 *
 * Own suite for src/services/monitoring/fortinetControllers.ts — the Fortinet
 * controller-status inventory (managed FortiSwitch / FortiAP tables read off
 * the parent FortiGate) and the transport dispatch it shares with the other
 * controller fetchers.
 *
 * Pinned:
 *   - resolveControllerMgmtIp: Asset.ipAddress of a firewall THIS integration
 *     manages first (rule 111), FMG CMDB fallback, 5-minute cache, null misses
 *     are not cached;
 *   - fetchViaFortinetTransport: strict direct mode (no silent proxy
 *     fallback), proxy mode with an abort timeout, standalone FortiGate,
 *     unsupported type -> AppError 500;
 *   - fetchFortinetControllerInventory: serial keying (upper-cased, sn /
 *     wtp_id fallbacks), status -> connected, os_version picking, AP
 *     telemetry, the 30 s cache, in-flight coalescing, and no caching of a
 *     failure.
 *
 * Module caches cannot be reset, so every test uses its own integration id.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  fgRequest: vi.fn(),
  fmgProxyRest: vi.fn(),
  resolveDeviceMgmtIpViaFmg: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/fortigateService.js", () => ({ fgRequest: h.fgRequest }));
vi.mock("../../src/services/fortimanagerService.js", () => ({
  fmgProxyRest: h.fmgProxyRest,
  resolveDeviceMgmtIpViaFmg: h.resolveDeviceMgmtIpViaFmg,
}));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { AppError } from "../../src/utils/errors.js";
import { isFortiapStatusOnline } from "../../src/utils/fortiapMonitorRow.js";
import {
  resolveControllerMgmtIp,
  fetchViaFortinetTransport,
  unwrapFortiosRows,
  fetchFortinetControllerInventory,
  FORTINET_CONTROLLER_CACHE_TTL_MS,
} from "../../src/services/monitoring/fortinetControllers.js";

let seq = 0;
/** A fresh integration id per test, because the module caches are unresettable. */
function nextId(prefix = "int"): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

const DIRECT_FMG = {
  host: "fmg.example", useProxy: false, fortigateApiToken: "tok", fortigateApiUser: "api",
  mgmtInterface: "mgmt", fortigateVerifySsl: true,
};

beforeEach(() => {
  resetDbStub();
  h.fgRequest.mockReset();
  h.fmgProxyRest.mockReset();
  h.resolveDeviceMgmtIpViaFmg.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── unwrapFortiosRows ─────────────────────────────────────────────────────

describe("unwrapFortiosRows", () => {
  it("passes a bare array through", () => {
    const rows = [{ a: 1 }];
    expect(unwrapFortiosRows(rows)).toBe(rows);
  });

  it("unwraps a { results: [...] } envelope", () => {
    expect(unwrapFortiosRows({ results: [{ serial: "S1" }] })).toEqual([{ serial: "S1" }]);
  });

  it("answers [] for anything else", () => {
    expect(unwrapFortiosRows(null)).toEqual([]);
    expect(unwrapFortiosRows(undefined)).toEqual([]);
    expect(unwrapFortiosRows({ results: "nope" })).toEqual([]);
    expect(unwrapFortiosRows("text")).toEqual([]);
    expect(unwrapFortiosRows({})).toEqual([]);
  });
});

// ─── resolveControllerMgmtIp ───────────────────────────────────────────────

describe("resolveControllerMgmtIp", () => {
  it("answers the discovered firewall's ipAddress, scoped to this integration and case-insensitive", async () => {
    const id = nextId();
    stubbed(prisma.asset.findFirst).mockResolvedValue({ ipAddress: "10.0.0.1" });

    const ip = await resolveControllerMgmtIp(id, "GATE-A", DIRECT_FMG as never);

    expect(ip).toBe("10.0.0.1");
    expect(prisma.asset.findFirst).toHaveBeenCalledWith({
      where: {
        hostname: { equals: "GATE-A", mode: "insensitive" },
        assetType: "firewall",
        discoveredByIntegrationId: id,
      },
      select: { ipAddress: true },
    });
    expect(h.resolveDeviceMgmtIpViaFmg).not.toHaveBeenCalled();
  });

  it("caches the answer per (integration, device) so the second call does not query", async () => {
    const id = nextId();
    stubbed(prisma.asset.findFirst).mockResolvedValue({ ipAddress: "10.0.0.2" });

    await resolveControllerMgmtIp(id, "GATE-B", DIRECT_FMG as never);
    await resolveControllerMgmtIp(id, "GATE-B", DIRECT_FMG as never);

    expect(prisma.asset.findFirst).toHaveBeenCalledTimes(1);
  });

  it("keys the cache by integration too — another integration's gate of the same name is looked up afresh", async () => {
    const a = nextId();
    const b = nextId();
    stubbed(prisma.asset.findFirst)
      .mockResolvedValueOnce({ ipAddress: "10.0.0.3" })
      .mockResolvedValueOnce({ ipAddress: "10.9.9.9" });

    expect(await resolveControllerMgmtIp(a, "GATE", DIRECT_FMG as never)).toBe("10.0.0.3");
    expect(await resolveControllerMgmtIp(b, "GATE", DIRECT_FMG as never)).toBe("10.9.9.9");
  });

  it("expires the cache after five minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-14T10:00:00Z"));
    const id = nextId();
    stubbed(prisma.asset.findFirst)
      .mockResolvedValueOnce({ ipAddress: "10.0.0.4" })
      .mockResolvedValueOnce({ ipAddress: "10.0.0.44" });

    expect(await resolveControllerMgmtIp(id, "G", DIRECT_FMG as never)).toBe("10.0.0.4");
    vi.setSystemTime(new Date("2026-11-14T10:04:59Z"));
    expect(await resolveControllerMgmtIp(id, "G", DIRECT_FMG as never)).toBe("10.0.0.4");
    vi.setSystemTime(new Date("2026-11-14T10:05:01Z"));
    expect(await resolveControllerMgmtIp(id, "G", DIRECT_FMG as never)).toBe("10.0.0.44");
  });

  it("falls back to the FMG CMDB when no managed firewall carries an address", async () => {
    const id = nextId();
    stubbed(prisma.asset.findFirst).mockResolvedValue({ ipAddress: null });
    h.resolveDeviceMgmtIpViaFmg.mockResolvedValue("192.0.2.10");

    const ip = await resolveControllerMgmtIp(id, "GATE-C", DIRECT_FMG as never);

    expect(ip).toBe("192.0.2.10");
    expect(h.resolveDeviceMgmtIpViaFmg).toHaveBeenCalledWith(DIRECT_FMG, "GATE-C", undefined, id);
  });

  it("falls back when no firewall row exists at all, and caches the CMDB answer", async () => {
    const id = nextId();
    stubbed(prisma.asset.findFirst).mockResolvedValue(null);
    h.resolveDeviceMgmtIpViaFmg.mockResolvedValue("192.0.2.11");

    await resolveControllerMgmtIp(id, "GATE-D", DIRECT_FMG as never);
    await resolveControllerMgmtIp(id, "GATE-D", DIRECT_FMG as never);

    expect(h.resolveDeviceMgmtIpViaFmg).toHaveBeenCalledTimes(1);
  });

  it("does not cache a miss — the next call asks again", async () => {
    const id = nextId();
    stubbed(prisma.asset.findFirst).mockResolvedValue(null);
    h.resolveDeviceMgmtIpViaFmg.mockResolvedValueOnce(null).mockResolvedValueOnce("192.0.2.12");

    expect(await resolveControllerMgmtIp(id, "GATE-E", DIRECT_FMG as never)).toBeNull();
    expect(await resolveControllerMgmtIp(id, "GATE-E", DIRECT_FMG as never)).toBe("192.0.2.12");
  });

  it("answers an IPv6 management address verbatim", async () => {
    const id = nextId();
    stubbed(prisma.asset.findFirst).mockResolvedValue({ ipAddress: "2001:db8::1" });
    expect(await resolveControllerMgmtIp(id, "GATE-V6", DIRECT_FMG as never)).toBe("2001:db8::1");
  });
});

// ─── fetchViaFortinetTransport ─────────────────────────────────────────────

describe("fetchViaFortinetTransport — FortiManager direct mode", () => {
  it("refuses with 409 when no FortiGate API token is configured", async () => {
    const integration = { id: nextId(), type: "fortimanager", config: { ...DIRECT_FMG, fortigateApiToken: "" } };
    const err: any = await fetchViaFortinetTransport(integration, "G", "/p", 1000, "x").catch((e: any) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(409);
    expect(err.message).toMatch(/no FortiGate API token/);
    expect(h.fgRequest).not.toHaveBeenCalled();
    expect(h.fmgProxyRest).not.toHaveBeenCalled();
  });

  it("refuses with 409 when mgmtInterface is blank (whitespace counts as blank)", async () => {
    const integration = { id: nextId(), type: "fortimanager", config: { ...DIRECT_FMG, mgmtInterface: "   " } };
    const err: any = await fetchViaFortinetTransport(integration, "G", "/p", 1000, "x").catch((e: any) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(409);
    expect(err.message).toMatch(/mgmtInterface is empty/);
  });

  it("refuses with 409 when mgmtInterface is missing entirely", async () => {
    const { mgmtInterface: _drop, ...rest } = DIRECT_FMG;
    const integration = { id: nextId(), type: "fortimanager", config: rest };
    const err: any = await fetchViaFortinetTransport(integration, "G", "/p", 1000, "x").catch((e: any) => e);
    expect(err.httpStatus).toBe(409);
  });

  it("fails with 502 (never a silent proxy fallback) when the mgmt IP cannot be resolved", async () => {
    const integration = { id: nextId(), type: "fortimanager", config: DIRECT_FMG };
    stubbed(prisma.asset.findFirst).mockResolvedValue(null);
    h.resolveDeviceMgmtIpViaFmg.mockResolvedValue(null);

    const err: any = await fetchViaFortinetTransport(integration, "GATE-X", "/p", 1000, "x").catch((e: any) => e);

    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(502);
    expect(err.message).toContain("GATE-X");
    expect(err.message).toContain('"mgmt"');
    expect(h.fmgProxyRest).not.toHaveBeenCalled();
    expect(h.fgRequest).not.toHaveBeenCalled();
  });

  it("sends the request straight to the resolved mgmt IP with the integration's FortiGate token", async () => {
    const integration = { id: nextId(), type: "fortimanager", config: DIRECT_FMG };
    stubbed(prisma.asset.findFirst).mockResolvedValue({ ipAddress: "10.1.1.1" });
    h.fgRequest.mockResolvedValue({ results: [] });

    const out = await fetchViaFortinetTransport(integration, "G", "/api/v2/x", 4321, "x");

    expect(out).toEqual({ results: [] });
    expect(h.fgRequest).toHaveBeenCalledWith(
      { host: "10.1.1.1", port: 443, apiUser: "api", apiToken: "tok", verifySsl: true },
      "GET",
      "/api/v2/x",
      { timeoutMs: 4321 },
    );
  });

  it("verifies TLS only when fortigateVerifySsl is exactly true, and defaults apiUser to empty", async () => {
    const integration = {
      id: nextId(), type: "fortimanager",
      config: { ...DIRECT_FMG, fortigateVerifySsl: "true", fortigateApiUser: undefined },
    };
    stubbed(prisma.asset.findFirst).mockResolvedValue({ ipAddress: "10.1.1.2" });
    h.fgRequest.mockResolvedValue([]);

    await fetchViaFortinetTransport(integration, "G", "/p", 1000, "x");

    expect(h.fgRequest.mock.calls[0][0]).toMatchObject({ verifySsl: false, apiUser: "" });
  });
});

describe("fetchViaFortinetTransport — FortiManager proxy mode", () => {
  it("routes through fmgProxyRest with the device name, a signal and the integration id", async () => {
    const id = nextId();
    const integration = { id, type: "fortimanager", config: { host: "fmg" } };
    h.fmgProxyRest.mockResolvedValue([{ serial: "S1" }]);

    const out = await fetchViaFortinetTransport(integration, "GATE-P", "/api/v2/y", 1000, "x");

    expect(out).toEqual([{ serial: "S1" }]);
    expect(h.fmgProxyRest).toHaveBeenCalledTimes(1);
    const [cfg, device, method, path, opts] = h.fmgProxyRest.mock.calls[0];
    expect(cfg).toEqual({ host: "fmg" });
    expect(device).toBe("GATE-P");
    expect(method).toBe("GET");
    expect(path).toBe("/api/v2/y");
    expect(opts.integrationId).toBe(id);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(h.fgRequest).not.toHaveBeenCalled();
  });

  it("treats useProxy=true (and an absent useProxy) as proxy mode", async () => {
    h.fmgProxyRest.mockResolvedValue([]);
    await fetchViaFortinetTransport({ id: nextId(), type: "fortimanager", config: { useProxy: true } }, "G", "/p", 1000, "x");
    expect(h.fmgProxyRest).toHaveBeenCalledTimes(1);
    expect(h.fgRequest).not.toHaveBeenCalled();
  });

  it("aborts the proxied call when the timeout elapses", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    h.fmgProxyRest.mockImplementation((_c: unknown, _d: unknown, _m: unknown, _p: unknown, opts: { signal: AbortSignal }) => {
      seen = opts.signal;
      return new Promise((_res, rej) => {
        opts.signal.addEventListener("abort", () => rej(new Error("aborted")));
      });
    });

    const p = fetchViaFortinetTransport({ id: nextId(), type: "fortimanager", config: {} }, "G", "/p", 500, "x");
    const settled: Promise<any> = p.catch((e: any) => e);
    await vi.advanceTimersByTimeAsync(499);
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(seen?.aborted).toBe(true);
    expect((await settled).message).toBe("aborted");
  });

  it("clears the timer once the call settles, so a later tick does not abort a finished request", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    h.fmgProxyRest.mockImplementation(async (_c: unknown, _d: unknown, _m: unknown, _p: unknown, opts: { signal: AbortSignal }) => {
      seen = opts.signal;
      return [];
    });

    await fetchViaFortinetTransport({ id: nextId(), type: "fortimanager", config: {} }, "G", "/p", 500, "x");
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("fetchViaFortinetTransport — standalone FortiGate and unsupported types", () => {
  it("sends a standalone FortiGate's request with its own config", async () => {
    const config = { host: "10.2.2.2", apiToken: "t" };
    h.fgRequest.mockResolvedValue({ ok: 1 });

    const out = await fetchViaFortinetTransport({ id: nextId(), type: "fortigate", config }, "ignored", "/p", 777, "x");

    expect(out).toEqual({ ok: 1 });
    expect(h.fgRequest).toHaveBeenCalledWith(config, "GET", "/p", { timeoutMs: 777 });
  });

  it("throws AppError 500 naming the caller for any other integration type", async () => {
    const err: any = await fetchViaFortinetTransport({ id: nextId(), type: "vcenter", config: {} }, "G", "/p", 1, "My Fetcher").catch((e: any) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(500);
    expect(err.message).toBe("Unsupported integration type for My Fetcher: vcenter");
  });
});

// ─── fetchFortinetControllerInventory ──────────────────────────────────────

function fg(id = nextId()) {
  return { id, type: "fortigate", config: { host: "10.3.3.3", apiToken: "t" } };
}

describe("fetchFortinetControllerInventory — switch table", () => {
  it("reads the managed-switch status path and keys rows by upper-cased serial", async () => {
    h.fgRequest.mockResolvedValue({
      results: [
        { serial: "s108ep0001", status: "Connected", os_version: "S108EP-v7.4.3-build0800" },
        { serial: " S2 ", status: "Disconnected" },
      ],
    });

    const { inventory, fetchDurationMs } = await fetchFortinetControllerInventory(fg(), "G", "switches", 1000);

    expect(h.fgRequest.mock.calls[0][2]).toBe("/api/v2/monitor/switch-controller/managed-switch/status");
    expect([...inventory.keys()]).toEqual(["S108EP0001", "S2"]);
    expect(inventory.get("S108EP0001")).toEqual({ connected: true, status: "Connected", osVersion: "S108EP-v7.4.3-build0800" });
    expect(inventory.get("S2")).toEqual({ connected: false, status: "Disconnected" });
    expect(fetchDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("is case-sensitive on the switch word: only 'Connected' is connected", async () => {
    h.fgRequest.mockResolvedValue([
      { serial: "A", status: "connected" },
      { serial: "B", status: "Connected" },
    ]);
    const { inventory } = await fetchFortinetControllerInventory(fg(), "G", "switches", 1000);
    expect(inventory.get("A")!.connected).toBe(false);
    expect(inventory.get("B")!.connected).toBe(true);
  });

  it("falls back to sn / wtp_id for the serial and state for the status; skips serial-less rows", async () => {
    h.fgRequest.mockResolvedValue([
      { sn: "SN1", state: "Connected" },
      { wtp_id: "W1" },
      { status: "Connected" },
      { serial: "   ", status: "Connected" },
    ]);
    const { inventory } = await fetchFortinetControllerInventory(fg(), "G", "switches", 1000);
    expect([...inventory.keys()]).toEqual(["SN1", "W1"]);
    expect(inventory.get("SN1")).toEqual({ connected: true, status: "Connected" });
    expect(inventory.get("W1")).toEqual({ connected: false, status: "" });
  });

  it("never attaches AP telemetry or a cached version to a switch row", async () => {
    h.fgRequest.mockResolvedValue([
      { serial: "S", status: "Connected", cpu_usage: 12, version: "FP231K-v7.6.0-build0100" },
    ]);
    const { inventory } = await fetchFortinetControllerInventory(fg(), "G", "switches", 1000);
    expect(inventory.get("S")).toEqual({ connected: true, status: "Connected" });
  });

  it("answers an empty map for an empty or malformed body", async () => {
    h.fgRequest.mockResolvedValue({ error: "nope" });
    const { inventory } = await fetchFortinetControllerInventory(fg(), "G", "switches", 1000);
    expect(inventory.size).toBe(0);
  });
});

describe("fetchFortinetControllerInventory — AP table", () => {
  it("reads the managed_ap path; online and connected are up, anything else is down", async () => {
    h.fgRequest.mockResolvedValue([
      { serial: "FP1", status: "online" },
      { serial: "FP2", status: "connected" },
      { serial: "FP3", status: "offline" },
      { serial: "FP4", status: "discovered" },
    ]);
    const { inventory } = await fetchFortinetControllerInventory(fg(), "G", "aps", 1000);
    expect(h.fgRequest.mock.calls[0][2]).toBe("/api/v2/monitor/wifi/managed_ap");
    expect(inventory.get("FP1")!.connected).toBe(true);
    expect(inventory.get("FP2")!.connected).toBe(true);
    expect(inventory.get("FP3")!.connected).toBe(false);
    expect(inventory.get("FP4")!.connected).toBe(false);
  });

  // Was a bug until 2026-11-14: an AP row whose status is "Online" (or "CONNECTED") is stored with
  // connected=false, so probeFortinetController marks a REST-probed AP DOWN,
  // while fortinetLinkStateService reads the same row through
  // isFortiapStatusOnline and calls the CAPWAP link UP. Both files claim to
  // use one online set ("exactly like the probe path", "keeps the sweep and
  // the probe from disagreeing"). Right: connected === isFortiapStatusOnline(status).
  it("agrees with isFortiapStatusOnline for a capitalised status word", async () => {
    h.fgRequest.mockResolvedValue([{ serial: "FP9", status: "Online" }]);
    const { inventory } = await fetchFortinetControllerInventory(fg(), "G", "aps", 1000);
    expect(inventory.get("FP9")!.connected).toBe(isFortiapStatusOnline("Online"));
  });

  it("prefers the live os_version over the cached version fields", async () => {
    h.fgRequest.mockResolvedValue([
      { serial: "FP1", status: "online", os_version: " FP231K-v7.6.2-build0200 ", version: "FP231K-v7.6.0-build0100" },
    ]);
    const { inventory } = await fetchFortinetControllerInventory(fg(), "G", "aps", 1000);
    expect(inventory.get("FP1")!.osVersion).toBe("FP231K-v7.6.2-build0200");
  });

  it("falls back to version / firmware_version only in the canonical shape", async () => {
    h.fgRequest.mockResolvedValue([
      { serial: "FP1", status: "online", version: "7.4.5 Build 0734", firmware_version: "FP231K-v7.4.5-build0734" },
      { serial: "FP2", status: "online", version: "FP431F-v7.6.0-build0100" },
      { serial: "FP3", status: "online", version: "FortiAP", firmware_version: "" },
    ]);
    const { inventory } = await fetchFortinetControllerInventory(fg(), "G", "aps", 1000);
    expect(inventory.get("FP1")!.osVersion).toBe("FP231K-v7.4.5-build0734");
    expect(inventory.get("FP2")!.osVersion).toBe("FP431F-v7.6.0-build0100");
    expect(inventory.get("FP3")).not.toHaveProperty("osVersion");
  });

  it("attaches the telemetry snapshot when the row carries cpu, memory or temperatures", async () => {
    h.fgRequest.mockResolvedValue([
      { serial: "FP1", status: "online", cpu_usage: 7, mem_free: 100, mem_total: 512 },
      { serial: "FP2", status: "online", sensors_temperatures: [{ name: "t1", value: 41 }] },
      { serial: "FP3", status: "online", mem_free: 100 },
      { serial: "FP4", status: "online" },
    ]);
    const { inventory } = await fetchFortinetControllerInventory(fg(), "G", "aps", 1000);
    expect(inventory.get("FP1")!.apTelemetry).toMatchObject({ cpuPct: 7, memFreeMb: 100, memTotalMb: 512 });
    expect(inventory.get("FP2")!.apTelemetry?.sensorTemperatures).toEqual([{ name: "t1", celsius: 41 }]);
    // mem_free alone is not enough to call it a snapshot.
    expect(inventory.get("FP3")).not.toHaveProperty("apTelemetry");
    expect(inventory.get("FP4")).not.toHaveProperty("apTelemetry");
  });

  it("lets a later duplicate serial win (last row overwrites)", async () => {
    h.fgRequest.mockResolvedValue([
      { serial: "fp1", status: "offline" },
      { serial: "FP1", status: "online" },
    ]);
    const { inventory } = await fetchFortinetControllerInventory(fg(), "G", "aps", 1000);
    expect(inventory.size).toBe(1);
    expect(inventory.get("FP1")!.status).toBe("online");
  });
});

describe("fetchFortinetControllerInventory — cache and coalescing", () => {
  it("serves a second call within the TTL from cache, with the original fetch duration", async () => {
    const integration = fg();
    h.fgRequest.mockResolvedValue([{ serial: "S", status: "Connected" }]);

    const first = await fetchFortinetControllerInventory(integration, "G", "switches", 1000);
    const second = await fetchFortinetControllerInventory(integration, "G", "switches", 1000);

    expect(h.fgRequest).toHaveBeenCalledTimes(1);
    expect(second.inventory).toBe(first.inventory);
    expect(second.fetchDurationMs).toBe(first.fetchDurationMs);
  });

  it("refetches once the TTL has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-14T10:00:00Z"));
    const integration = fg();
    h.fgRequest.mockResolvedValue([]);

    await fetchFortinetControllerInventory(integration, "G", "switches", 1000);
    vi.setSystemTime(new Date(Date.parse("2026-11-14T10:00:00Z") + FORTINET_CONTROLLER_CACHE_TTL_MS - 1));
    await fetchFortinetControllerInventory(integration, "G", "switches", 1000);
    expect(h.fgRequest).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(Date.parse("2026-11-14T10:00:00Z") + FORTINET_CONTROLLER_CACHE_TTL_MS + 1));
    await fetchFortinetControllerInventory(integration, "G", "switches", 1000);
    expect(h.fgRequest).toHaveBeenCalledTimes(2);
  });

  it("keeps switches and APs, and different controllers, in separate cache entries", async () => {
    const integration = fg();
    h.fgRequest.mockResolvedValue([]);

    await fetchFortinetControllerInventory(integration, "G1", "switches", 1000);
    await fetchFortinetControllerInventory(integration, "G1", "aps", 1000);
    await fetchFortinetControllerInventory(integration, "G2", "switches", 1000);

    expect(h.fgRequest).toHaveBeenCalledTimes(3);
  });

  it("funnels concurrent callers into one upstream request", async () => {
    const integration = fg();
    let release!: (v: unknown) => void;
    h.fgRequest.mockImplementation(() => new Promise((res) => { release = res; }));

    const calls = Array.from({ length: 5 }, () => fetchFortinetControllerInventory(integration, "G", "aps", 1000));
    await Promise.resolve();
    release([{ serial: "FP1", status: "online" }]);
    const results = await Promise.all(calls);

    expect(h.fgRequest).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r.inventory.get("FP1")!.connected).toBe(true);
  });

  it("does not cache a failure: concurrent waiters all reject, and the next call retries", async () => {
    const integration = fg();
    h.fgRequest.mockRejectedValueOnce(new Error("unreachable")).mockResolvedValueOnce([{ serial: "S", status: "Connected" }]);

    const a = fetchFortinetControllerInventory(integration, "G", "switches", 1000);
    const b = fetchFortinetControllerInventory(integration, "G", "switches", 1000);
    await expect(a).rejects.toThrow("unreachable");
    await expect(b).rejects.toThrow("unreachable");

    const c = await fetchFortinetControllerInventory(integration, "G", "switches", 1000);
    expect(c.inventory.get("S")!.connected).toBe(true);
    expect(h.fgRequest).toHaveBeenCalledTimes(2);
  });

  it("propagates a direct-mode precondition AppError to the caller", async () => {
    const integration = { id: nextId(), type: "fortimanager", config: { ...DIRECT_FMG, fortigateApiToken: undefined } };
    const err: any = await fetchFortinetControllerInventory(integration, "G", "switches", 1000).catch((e: any) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(409);
  });
});
