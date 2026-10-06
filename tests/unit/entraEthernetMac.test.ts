/**
 * tests/unit/entraEthernetMac.test.ts
 *
 * Intune's `ethernetMacAddress` is a "Non-Default property": the managedDevices
 * LIST call returns it null on every row, and only a per-device GET with
 * $select fills it in. entraIdService therefore reads it per device through
 * Graph $batch, skipping devices whose lastSyncDateTime has not moved since
 * the stored value was read. Without that read every Intune machine reached
 * Polaris with its Wi-Fi MAC only, and FortiGate discovery's sighting of the
 * wired NIC became a second asset for the same computer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/utils/sleep.js", () => ({ sleep: vi.fn(async () => {}) }));

import { discoverDevices, planEthernetMacFetch, type KnownEthernetMac } from "../../src/services/entraIdService.js";

const DEV_A = "aaaaaaaa-0000-0000-0000-000000000001";
const DEV_B = "bbbbbbbb-0000-0000-0000-000000000002";
const MD_A = "11111111-1111-1111-1111-111111111111";
const MD_B = "22222222-2222-2222-2222-222222222222";
const SYNC_1 = "2026-09-30T10:00:00Z";
const SYNC_2 = "2026-10-01T08:00:00Z";

// Separate tenants per test so the module's token cache never leaks a token
// minted by one test's fetch stub into another's call count.
let tenantSeq = 0;
function config() {
  tenantSeq++;
  return { tenantId: `t${tenantSeq}`, clientId: "c", clientSecret: "s", enableIntune: true };
}

function intuneRow(id: string, azureADDeviceId: string, lastSyncDateTime: string, extra: Record<string, unknown> = {}) {
  return {
    id, azureADDeviceId, deviceName: `PC-${id.slice(0, 4)}`, operatingSystem: "Windows",
    wiFiMacAddress: "A0B1C2D3E4F5", ethernetMacAddress: null, lastSyncDateTime, ...extra,
  };
}

function entraRow(deviceId: string) {
  return { id: `obj-${deviceId}`, deviceId, displayName: `PC-${deviceId.slice(0, 4)}`, accountEnabled: true };
}

interface Scenario {
  entra: any[];
  intune: any[];
  /** managedDeviceId → batch sub-response, or a function per attempt. */
  batch: (id: string, attempt: number) => { status: number; body?: any; headers?: Record<string, string> };
  /** Throw on the $batch POST itself. */
  batchThrows?: boolean;
}

let batchBodies: any[] = [];

function stubGraph(s: Scenario) {
  const attempts = new Map<string, number>();
  batchBodies = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any = {}) => {
    const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
    if (new URL(url).hostname === "login.microsoftonline.com") return json({ access_token: "tok", expires_in: 3600 });
    if (url.includes("/v1.0/devices")) return json({ value: s.entra });
    if (url.includes("/v1.0/deviceManagement/managedDevices")) return json({ value: s.intune });
    if (url.endsWith("/v1.0/$batch")) {
      if (s.batchThrows) return json({ error: { message: "boom" } }, 500);
      const body = JSON.parse(init.body);
      batchBodies.push(body);
      return json({
        responses: body.requests.map((r: any) => {
          const n = (attempts.get(r.id) ?? 0) + 1;
          attempts.set(r.id, n);
          return { id: r.id, ...s.batch(r.id, n) };
        }),
      });
    }
    return json({ error: { message: `unexpected ${url}` } }, 404);
  }));
}

beforeEach(() => { batchBodies = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("planEthernetMacFetch", () => {
  it("reads a device it has never seen", () => {
    const { toFetch, resolved } = planEthernetMacFetch([[DEV_A, intuneRow(MD_A, DEV_A, SYNC_1)]], undefined, false);
    expect(toFetch).toEqual([{ deviceId: DEV_A, managedDeviceId: MD_A, lastSync: SYNC_1 }]);
    expect(resolved.size).toBe(0);
  });

  it("skips the read when the device has not synced since the stored MAC was read", () => {
    const known = new Map<string, KnownEthernetMac>([[DEV_A, { ethernetMacAddress: "00:11:22:33:44:55", ethernetMacSyncedAt: SYNC_1 }]]);
    const { toFetch, resolved } = planEthernetMacFetch([[DEV_A, intuneRow(MD_A, DEV_A, SYNC_1)]], known, false);
    expect(toFetch).toEqual([]);
    expect(resolved.get(DEV_A)).toEqual({ mac: "00:11:22:33:44:55", syncedAt: SYNC_1 });
  });

  it("re-reads once the device has synced again", () => {
    const known = new Map<string, KnownEthernetMac>([[DEV_A, { ethernetMacAddress: "00:11:22:33:44:55", ethernetMacSyncedAt: SYNC_1 }]]);
    const { toFetch } = planEthernetMacFetch([[DEV_A, intuneRow(MD_A, DEV_A, SYNC_2)]], known, false);
    expect(toFetch.map((f) => f.deviceId)).toEqual([DEV_A]);
  });

  it("re-reads a device whose earlier read never succeeded (no stamp)", () => {
    const known = new Map<string, KnownEthernetMac>([[DEV_A, { ethernetMacAddress: null, ethernetMacSyncedAt: null }]]);
    const { toFetch } = planEthernetMacFetch([[DEV_A, intuneRow(MD_A, DEV_A, SYNC_1)]], known, false);
    expect(toFetch).toHaveLength(1);
  });

  it("forceRefresh reads even an unchanged device", () => {
    const known = new Map<string, KnownEthernetMac>([[DEV_A, { ethernetMacAddress: "00:11:22:33:44:55", ethernetMacSyncedAt: SYNC_1 }]]);
    const { toFetch } = planEthernetMacFetch([[DEV_A, intuneRow(MD_A, DEV_A, SYNC_1)]], known, true);
    expect(toFetch).toHaveLength(1);
  });

  it("takes the list row's value when Graph does fill it in", () => {
    const { toFetch, resolved } = planEthernetMacFetch([[DEV_A, intuneRow(MD_A, DEV_A, SYNC_1, { ethernetMacAddress: "001122334455" })]], undefined, false);
    expect(toFetch).toEqual([]);
    expect(resolved.get(DEV_A)?.mac).toBe("00:11:22:33:44:55");
  });

  it("never puts a non-GUID managed device id into a URL, and keeps the stored MAC", () => {
    const known = new Map<string, KnownEthernetMac>([[DEV_A, { ethernetMacAddress: "00:11:22:33:44:55", ethernetMacSyncedAt: SYNC_1 }]]);
    const { toFetch, resolved } = planEthernetMacFetch([[DEV_A, intuneRow("x' or 1 eq 1", DEV_A, SYNC_2)]], known, false);
    expect(toFetch).toEqual([]);
    expect(resolved.get(DEV_A)).toEqual({ mac: "00:11:22:33:44:55", syncedAt: SYNC_1 });
  });
});

describe("discoverDevices — Intune Ethernet MAC", () => {
  it("fills in the Ethernet MAC from a per-device $batch read and stamps the sync it was read at", async () => {
    stubGraph({
      entra: [entraRow(DEV_A)],
      intune: [intuneRow(MD_A, DEV_A, SYNC_1)],
      batch: () => ({ status: 200, body: { id: MD_A, ethernetMacAddress: "001122334455" } }),
    });
    const r = await discoverDevices(config());
    const d = r.devices.find((x) => x.deviceId === DEV_A)!;
    expect(d.ethernetMacAddress).toBe("00:11:22:33:44:55");
    expect(d.wifiMacAddress).toBe("A0:B1:C2:D3:E4:F5");
    expect(d.macAddress).toBe("00:11:22:33:44:55"); // Ethernet preferred
    expect(d.ethernetMacSyncedAt).toBe(SYNC_1);
    expect(batchBodies[0].requests[0].url).toBe(`/deviceManagement/managedDevices/${MD_A}?$select=id,ethernetMacAddress`);
  });

  it("makes no $batch call for a device unchanged since its stored read", async () => {
    stubGraph({
      entra: [entraRow(DEV_A)],
      intune: [intuneRow(MD_A, DEV_A, SYNC_1)],
      batch: () => { throw new Error("should not be called"); },
    });
    const known = new Map<string, KnownEthernetMac>([[DEV_A, { ethernetMacAddress: "00:11:22:33:44:55", ethernetMacSyncedAt: SYNC_1 }]]);
    const r = await discoverDevices(config(), undefined, undefined, undefined, known);
    expect(batchBodies).toHaveLength(0);
    expect(r.devices[0].ethernetMacAddress).toBe("00:11:22:33:44:55");
  });

  it("splits reads into batches of 20", async () => {
    const ids = Array.from({ length: 45 }, (_, i) => {
      const n = String(i).padStart(12, "0");
      return { md: `33333333-3333-3333-3333-${n}`, dev: `cccccccc-0000-0000-0000-${n}` };
    });
    stubGraph({
      entra: ids.map((x) => entraRow(x.dev)),
      intune: ids.map((x) => intuneRow(x.md, x.dev, SYNC_1)),
      batch: () => ({ status: 200, body: { ethernetMacAddress: null } }),
    });
    await discoverDevices(config());
    expect(batchBodies.map((b) => b.requests.length).sort((a, b) => b - a)).toEqual([20, 20, 5]);
  });

  it("retries a throttled sub-request and takes its answer", async () => {
    stubGraph({
      entra: [entraRow(DEV_A), entraRow(DEV_B)],
      intune: [intuneRow(MD_A, DEV_A, SYNC_1), intuneRow(MD_B, DEV_B, SYNC_1)],
      batch: (id, attempt) =>
        id === MD_B && attempt === 1
          ? { status: 429, headers: { "Retry-After": "1" } }
          : { status: 200, body: { ethernetMacAddress: id === MD_A ? "001122334455" : "66778899AABB" } },
    });
    const r = await discoverDevices(config());
    expect(r.devices.find((d) => d.deviceId === DEV_B)?.ethernetMacAddress).toBe("66:77:88:99:AA:BB");
    expect(batchBodies[1].requests.map((q: any) => q.id)).toEqual([MD_B]); // only the throttled one retried
  });

  it("a failed read keeps the stored MAC and its old stamp, so the device is retried next run", async () => {
    stubGraph({
      entra: [entraRow(DEV_A)],
      intune: [intuneRow(MD_A, DEV_A, SYNC_2)],
      batch: () => ({ status: 503 }),
    });
    const known = new Map<string, KnownEthernetMac>([[DEV_A, { ethernetMacAddress: "00:11:22:33:44:55", ethernetMacSyncedAt: SYNC_1 }]]);
    const r = await discoverDevices(config(), undefined, undefined, undefined, known);
    expect(r.devices[0].ethernetMacAddress).toBe("00:11:22:33:44:55");
    expect(r.devices[0].ethernetMacSyncedAt).toBe(SYNC_1);
  });

  it("a $batch outage never fails the run", async () => {
    stubGraph({
      entra: [entraRow(DEV_A)],
      intune: [intuneRow(MD_A, DEV_A, SYNC_1)],
      batch: () => ({ status: 200 }),
      batchThrows: true,
    });
    const log = vi.fn();
    const r = await discoverDevices(config(), undefined, log);
    expect(r.devices).toHaveLength(1);
    expect(r.devices[0].ethernetMacAddress).toBeUndefined();
    expect(r.devices[0].wifiMacAddress).toBe("A0:B1:C2:D3:E4:F5");
    expect(log).toHaveBeenCalledWith("discover.intune.ethernet_mac", "error", expect.stringContaining("failed"));
  });

  it("a device reporting no Ethernet MAC is stamped, so it is not re-read until it syncs again", async () => {
    stubGraph({
      entra: [entraRow(DEV_A)],
      intune: [intuneRow(MD_A, DEV_A, SYNC_1)],
      batch: () => ({ status: 200, body: { ethernetMacAddress: null } }),
    });
    const r = await discoverDevices(config());
    expect(r.devices[0].ethernetMacAddress).toBeUndefined();
    expect(r.devices[0].ethernetMacSyncedAt).toBe(SYNC_1);
  });
});
