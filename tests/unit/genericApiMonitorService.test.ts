/**
 * tests/unit/genericApiMonitorService.test.ts — the `genericapi` polling
 * method (business rule 100(i)) against a fake transport.
 *
 * Pinned:
 *  - each stream's builder reads the operator's paths and nothing else (a
 *    missing value is no reading, never a zero);
 *  - a FLEET query is one paged request shared by every asset and stream on
 *    it; a PER-ASSET query fills its template from the asset's own record;
 *  - the reading model: answered → doc; not listed by a complete read or a
 *    404 → absent (the probe FAILS); could not ask → unreachable (the probe
 *    is SKIPPED, so one inventory outage never downs a fleet); no query for
 *    the stream → none;
 *  - system info gates each stream on its own resolved method, and a stream
 *    that could not be read is "not collected", never "has none".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("../../src/db.js", () => ({ prisma: { assetSource: { findMany: h.findMany } } }));

const gm = await import("../../src/services/genericApiMonitorService.js");
const ga = await import("../../src/services/genericApiService.js");
import type { GenericApiMonitorQuery, RawJsonResponse, RequestJsonOptions } from "../../src/services/genericApiService.js";

const BASE = { host: "inventory.example.com", useHttps: true, identityField: "id", detailConcurrency: 2 };

function integration(monitorQueries: GenericApiMonitorQuery[], over: Record<string, unknown> = {}) {
  return { id: "int1", name: "CMDB", type: "genericapi", enabled: true, config: { ...BASE, monitorQueries, ...over } };
}

/** The asset's generic-api source rows, as loadSourceRows selects them. */
function rowsFor(intg: ReturnType<typeof integration>, identity: string, observed: Record<string, unknown> = {}) {
  return [{ externalId: `${intg.id}:${identity}`, observed: { identity, ...observed }, integration: intg }];
}

function fakeTransport(answer: (url: URL, opts: RequestJsonOptions) => Partial<RawJsonResponse>) {
  const seen: Array<{ url: string; opts: RequestJsonOptions }> = [];
  ga._setRequestImplForTests(async (url, opts) => {
    seen.push({ url: url.toString(), opts });
    return { status: 200, headers: {}, text: "", json: null, ...answer(url, opts) };
  });
  return seen;
}

beforeEach(() => {
  gm.invalidateGenericApiMonitorCache();
  h.findMany.mockReset();
});
afterEach(() => ga._setRequestImplForTests(null));

const q = (over: Partial<GenericApiMonitorQuery>): GenericApiMonitorQuery => ({ stream: "responseTime", scope: "fleet", path: "/api/status", ...over });

// ─── Builders ────────────────────────────────────────────────────────────────

describe("builders", () => {
  it("response time: up from the declared values, the source's own latency, a missing value is no answer", () => {
    const rt = q({ map: { up: "state", latencyMs: "rtt", uptimeSec: "up_s" }, upValues: ["Online"] });
    expect(gm.buildProbeResult({ state: "online", rtt: "12.6", up_s: 3600 }, rt)).toEqual({ success: true, responseTimeMs: 13, uptimeSec: 3600 });
    expect(gm.buildProbeResult({ state: "offline" }, rt)).toMatchObject({ success: false, error: 'The feed reports "offline"' });
    expect(gm.buildProbeResult({}, rt)).toMatchObject({ success: false, error: 'No value at "state"' });
    // No up list: the common spellings.
    expect(gm.buildProbeResult({ s: true }, q({ map: { up: "s" } })).success).toBe(true);
    expect(gm.buildProbeResult({ s: "running" }, q({ map: { up: "s" } })).success).toBe(true);
    expect(gm.buildProbeResult({ s: "stopped" }, q({ map: { up: "s" } })).success).toBe(false);
  });

  it("CPU / memory: percentages clamped, sizes in the declared unit, used derived from total − free", () => {
    const cm = q({ stream: "cpuMemory", map: { cpuPct: "cpu", memTotal: "mem.total", memFree: "mem.free" }, byteUnit: "MB" });
    expect(gm.buildTelemetry({ cpu: "140", mem: { total: 1024, free: 256 } }, cm)).toEqual({
      cpuPct: 100, memPct: 75, memUsedBytes: 768 * 1024 ** 2, memTotalBytes: 1024 ** 3,
    });
    expect(gm.buildTelemetry({}, cm)).toBeNull();
  });

  it("interfaces: one row per name, status spellings normalized, Mbps to bps, a non-address IP dropped", () => {
    const ifq = q({ stream: "interfaces", itemsPath: "ports", map: { name: "id", operStatus: "link", speedMbps: "speed", inOctets: "rx", macAddress: "mac", ipAddress: "ip" } });
    const rows = gm.buildInterfaces({ ports: [
      { id: "eth0", link: "connected", speed: 1000, rx: 5, mac: "aa-bb-cc-00-00-01", ip: "10.0.0.5/24" },
      { id: "eth0", link: "down" },
      { id: "wlan0", link: "LowerLayerDown", ip: "not-an-ip" },
      { link: "up" },
    ] }, ifq);
    expect(rows).toEqual([
      { ifName: "eth0", operStatus: "up", adminStatus: null, speedBps: 1_000_000_000, inOctets: 5, outOctets: null, inErrors: null, outErrors: null, macAddress: "AA:BB:CC:00:00:01", ipAddress: "10.0.0.5" },
      { ifName: "wlan0", operStatus: "down", adminStatus: null, speedBps: null, inOctets: null, outOctets: null, inErrors: null, outErrors: null },
    ]);
  });

  it("storage, temperature and LLDP rows", () => {
    expect(gm.buildStorage({ v: [{ n: "/", t: 100, f: 40 }] }, q({ stream: "storage", itemsPath: "v", map: { mountPath: "n", total: "t", free: "f" }, byteUnit: "KB" })))
      .toEqual([{ mountPath: "/", totalBytes: 102_400, usedBytes: 61_440 }]);
    expect(gm.buildTemperatures([{ s: "cpu", c: "51.5" }, { s: "psu" }], q({ stream: "temperature", map: { name: "s", celsius: "c" } })))
      .toEqual([{ sensorName: "cpu", sensorClass: "temperature", value: 51.5, unit: "°C", alarmStatus: null }]);
    const ll = gm.buildLldpNeighbors({ n: [
      { p: "port1", sys: "core-sw", rp: "Gi0/1", ip: "10.0.0.1" },
      { p: "port2" },
      { p: "port3", sys: "x", ip: "nope" },
    ] }, q({ stream: "lldp", itemsPath: "n", map: { localIfName: "p", systemName: "sys", portId: "rp", managementIp: "ip" } }));
    expect(ll.map((r) => [r.localIfName, r.systemName, r.portId, r.managementIp])).toEqual([
      ["port1", "core-sw", "Gi0/1", "10.0.0.1"],
      ["port3", "x", null, null],
    ]);
  });

  it("widgets: numbers become scalar samples, a state becomes 0/1 through its StateMap, a missing value is skipped", () => {
    const wq = q({ stream: "widgets", widgets: [
      { name: "Toner", type: "gauge", path: "toner" },
      { name: "Pages", type: "line", path: "pages" },
      { name: "Door", type: "state", path: "door", stateMap: { mode: "notEquals", values: ["closed"], trueIsProblem: true } },
    ] });
    expect(gm.buildWidgetSamples({ toner: "15", door: "OPEN" }, wq, "int1")).toEqual({
      samples: [{ widgetId: "ga:int1:toner", kind: "scalar", value: 15 }],
      stateRows: [{ probeId: "ga:int1:door", rowKey: "", rowLabel: "Door", value: 1, rawValue: "OPEN" }],
    });
    expect(gm.buildWidgetSamples({ door: "closed" }, wq, "int1").stateRows[0].value).toBe(0);
  });
});

// ─── Reading ─────────────────────────────────────────────────────────────────

describe("fleet queries", () => {
  const fleetStatus = q({ name: "Status", recordsPath: "items", matchPath: "device", map: { up: "state" } });
  const fleetCpu = q({ stream: "cpuMemory", path: "/api/status", recordsPath: "items", matchPath: "device", map: { cpuPct: "cpu" } });

  it("one request answers every asset and every stream on the same query", async () => {
    const intg = integration([fleetStatus, fleetCpu]);
    const seen = fakeTransport(() => ({ json: { items: [{ device: "a", state: "up", cpu: 10 }, { device: "b", state: "down", cpu: 90 }] } }));
    h.findMany.mockImplementation(async ({ where }: any) => rowsFor(intg, where.assetId === "asset-a" ? "a" : "b"));
    expect((await gm.probeGenericApi("asset-a")).success).toBe(true);
    expect(await gm.probeGenericApi("asset-b")).toMatchObject({ success: false, error: 'The feed reports "down"' });
    // The CPU query makes the identical request, so it reads the same cached response.
    expect(await gm.collectTelemetryGenericApi("asset-a")).toMatchObject({ supported: true, data: { cpuPct: 10 } });
    expect(seen.filter((s) => s.url.includes("/api/status"))).toHaveLength(1);
  });

  it("an asset a COMPLETE read does not list is absent — the probe fails", async () => {
    const intg = integration([fleetStatus]);
    fakeTransport(() => ({ json: { items: [{ device: "other", state: "up" }] } }));
    h.findMany.mockResolvedValue(rowsFor(intg, "a"));
    const r = await gm.probeGenericApi("asset-a");
    expect(r.skipped).toBeUndefined();
    expect(r).toMatchObject({ success: false, error: 'Not in "Status" on "CMDB"' });
  });

  it("an unreachable API, or an incomplete read, SKIPS the probe — one outage never downs the fleet", async () => {
    h.findMany.mockResolvedValue(rowsFor(integration([fleetStatus]), "a"));
    fakeTransport(() => ({ status: 503, text: "maintenance" }));
    expect(await gm.probeGenericApi("asset-a")).toMatchObject({ success: false, skipped: true });

    gm.invalidateGenericApiMonitorCache();
    const paged = q({ ...fleetStatus, paginate: true });
    h.findMany.mockResolvedValue(rowsFor(integration([paged], { pagination: { mode: "page", pageParam: "page", maxPages: 1 } }), "a"));
    fakeTransport(() => ({ json: { items: [{ device: "other", state: "up" }] } }));
    expect(await gm.probeGenericApi("asset-a")).toMatchObject({ success: false, skipped: true });
  });

  it("matches on the identity normalized like the integration's identity field", async () => {
    const intg = integration([q({ ...fleetStatus, matchPath: "mac" })], { identityField: "macAddress" });
    fakeTransport(() => ({ json: { items: [{ mac: "aa-bb-cc-00-00-09", state: "ok" }] } }));
    h.findMany.mockResolvedValue(rowsFor(intg, "AA:BB:CC:00:00:09"));
    expect((await gm.probeGenericApi("asset-a")).success).toBe(true);
  });
});

describe("per-asset queries", () => {
  const perAsset = q({ name: "Device", scope: "asset", path: "/api/devices/{{identity}}/status", map: { up: "ok" } });

  it("fills the path from the asset's record, URL-encoded", async () => {
    const seen = fakeTransport(() => ({ json: { ok: true } }));
    h.findMany.mockResolvedValue(rowsFor(integration([perAsset]), "dev 1/a"));
    expect((await gm.probeGenericApi("asset-a")).success).toBe(true);
    expect(seen[0].url).toBe("https://inventory.example.com/api/devices/dev%201%2Fa/status");
  });

  it("a 404 is absent (fails); any other failure is unreachable (skipped)", async () => {
    h.findMany.mockResolvedValue(rowsFor(integration([perAsset]), "a"));
    fakeTransport(() => ({ status: 404 }));
    expect((await gm.probeGenericApi("asset-a")).skipped).toBeUndefined();
    gm.invalidateGenericApiMonitorCache();
    fakeTransport(() => ({ status: 500 }));
    expect((await gm.probeGenericApi("asset-a")).skipped).toBe(true);
  });

  it("a placeholder the record cannot fill fails the probe without a request", async () => {
    const seen = fakeTransport(() => ({ json: { ok: true } }));
    h.findMany.mockResolvedValue(rowsFor(integration([q({ ...perAsset, path: "/api/{{serial}}" })]), "a"));
    expect(await gm.probeGenericApi("asset-a")).toMatchObject({ success: false, error: "the record has no usable value at {{serial}}" });
    expect(seen).toHaveLength(0);
  });

  it("shares one request between the streams one query feeds on a pass, and holds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    ga._setRequestImplForTests(async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { status: 200, headers: {}, text: "", json: { ok: true } };
    });
    const intg = integration([perAsset]);
    h.findMany.mockImplementation(async ({ where }: any) => rowsFor(intg, where.assetId));
    await Promise.all(["a1", "a2", "a3", "a4", "a5"].map((id) => gm.probeGenericApi(id)));
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("what the method answers without a query", () => {
  it("no query for the stream: the probe fails and says so; a collector is simply not supported", async () => {
    h.findMany.mockResolvedValue(rowsFor(integration([]), "a"));
    expect(await gm.probeGenericApi("asset-a")).toMatchObject({ success: false, error: expect.stringMatching(/no response time monitor query/) });
    expect(await gm.collectTelemetryGenericApi("asset-a")).toEqual({ supported: false });
    expect(await gm.collectHardwareSensorsGenericApi("asset-a")).toEqual({ supported: false });
  });

  it("no Generic API record at all", async () => {
    h.findMany.mockResolvedValue([]);
    expect(await gm.probeGenericApi("asset-a")).toMatchObject({ success: false, error: expect.stringMatching(/no Generic API record/) });
  });

  it("a disabled integration is unreachable — skipped, never down", async () => {
    h.findMany.mockResolvedValue(rowsFor(integration([q({ matchPath: "id", map: { up: "s" } })], {}), "a").map((r) => ({ ...r, integration: { ...r.integration, enabled: false } })));
    expect(await gm.probeGenericApi("asset-a")).toMatchObject({ skipped: true, error: 'Integration "CMDB" is disabled' });
  });
});

describe("collectSystemInfoGenericApi", () => {
  const ifq = q({ stream: "interfaces", scope: "asset", path: "/d/{{identity}}", itemsPath: "ports", map: { name: "n" } });
  const stq = q({ stream: "storage", scope: "asset", path: "/d/{{identity}}", itemsPath: "vols", map: { mountPath: "m", total: "t" } });
  const llq = q({ stream: "lldp", scope: "asset", path: "/d/{{identity}}/lldp", itemsPath: "n", map: { localIfName: "p", systemName: "s" } });

  it("reads each stream whose method is genericapi, from its own query, and marks LLDP as this source", async () => {
    fakeTransport((url) => ({ json: url.pathname.endsWith("/lldp") ? { n: [{ p: "port1", s: "sw" }] } : { ports: [{ n: "eth0" }], vols: [{ m: "/", t: 5 }] } }));
    h.findMany.mockResolvedValue(rowsFor(integration([ifq, stq, llq]), "a"));
    const r = await gm.collectSystemInfoGenericApi("asset-a", { interfacesPolling: "genericapi", storagePolling: "genericapi", lldpPolling: "genericapi" });
    expect(r.supported).toBe(true);
    expect(r.data?.interfaces.map((i) => i.ifName)).toEqual(["eth0"]);
    expect(r.data?.storage).toEqual([{ mountPath: "/", totalBytes: 5, usedBytes: null }]);
    expect(r.data?.lldpNeighbors?.[0]).toMatchObject({ localIfName: "port1", systemName: "sw" });
    expect(r.data?.lldpSource).toBe("genericapi");
  });

  it("a stream on another method contributes nothing, and LLDP that was not read stays undefined (no wipe)", async () => {
    fakeTransport(() => ({ json: { ports: [{ n: "eth0" }], vols: [{ m: "/", t: 5 }] } }));
    h.findMany.mockResolvedValue(rowsFor(integration([ifq, stq, llq]), "a"));
    const r = await gm.collectSystemInfoGenericApi("asset-a", { interfacesPolling: "genericapi", storagePolling: "snmp", lldpPolling: null });
    expect(r.data?.storage).toEqual([]);
    expect(r.data?.lldpNeighbors).toBeUndefined();
  });

  it("the pinned pass filters to the pinned rows and never reads LLDP", async () => {
    const seen = fakeTransport((url) => ({ json: url.pathname.endsWith("/lldp") ? { n: [] } : { ports: [{ n: "eth0" }, { n: "eth1" }], vols: [] } }));
    h.findMany.mockResolvedValue(rowsFor(integration([ifq, stq, llq]), "a"));
    const r = await gm.collectSystemInfoGenericApi("asset-a", { interfacesPolling: "genericapi", storagePolling: null, lldpPolling: "genericapi" }, { interfaces: ["eth1"], storage: [] });
    expect(r.data?.interfaces.map((i) => i.ifName)).toEqual(["eth1"]);
    expect(seen.some((s) => s.url.endsWith("/lldp"))).toBe(false);
  });

  it("every wanted stream unreadable: a failure, not an empty answer", async () => {
    fakeTransport(() => ({ status: 502 }));
    h.findMany.mockResolvedValue(rowsFor(integration([ifq]), "a"));
    const r = await gm.collectSystemInfoGenericApi("asset-a", { interfacesPolling: "genericapi", storagePolling: null });
    expect(r.supported).toBe(true);
    expect(r.data).toBeUndefined();
    expect(r.error).toMatch(/502/);
  });
});

describe("custom widgets", () => {
  const wq = q({ stream: "widgets", scope: "asset", path: "/d/{{identity}}", widgets: [
    { name: "Toner", type: "gauge", path: "toner", unit: "%", min: 0, max: 100, warningAt: 15 },
    { name: "Door", type: "state", path: "door", stateMap: { mode: "notEquals", values: ["closed"] } },
  ] });

  it("collects every widgets query's samples", async () => {
    fakeTransport(() => ({ json: { toner: 40, door: "closed" } }));
    h.findMany.mockResolvedValue(rowsFor(integration([wq]), "a"));
    const got = await gm.collectGenericApiWidgetSamples("asset-a");
    expect(got.samples).toEqual([{ widgetId: "ga:int1:toner", kind: "scalar", value: 40 }]);
    expect(got.stateRows).toEqual([{ probeId: "ga:int1:door", rowKey: "", rowLabel: "Door", value: 0, rawValue: "closed" }]);
  });

  it("defines the widgets in the shape the asset tab renders, tagged with their source", async () => {
    h.findMany.mockResolvedValue(rowsFor(integration([wq]), "a"));
    const defs = await gm.genericApiWidgetDefsForAsset("asset-a");
    expect(defs.map((d) => [d.id, d.widgetType, d.displayOptions])).toEqual([
      ["ga:int1:toner", "gauge", { unit: "%", min: 0, max: 100, warningAt: 15 }],
      ["ga:int1:door", "state", {}],
    ]);
    expect(defs[0].source).toEqual({ kind: "genericapi", integrationId: "int1", integrationName: "CMDB" });
    expect(defs[0].symbol).toBe("CMDB · toner");
    expect(defs[1].stateMap).toMatchObject({ mode: "notEquals", values: ["closed"] });
  });
});

describe("assetTemplateContext", () => {
  it("exposes the observed blob plus the first MAC as `mac`", () => {
    expect(gm.assetTemplateContext({ identity: "1", macs: ["AA:BB:CC:00:00:01", "AA:BB:CC:00:00:02"], ip: "10.0.0.1" }))
      .toEqual({ identity: "1", macs: ["AA:BB:CC:00:00:01", "AA:BB:CC:00:00:02"], ip: "10.0.0.1", mac: "AA:BB:CC:00:00:01" });
    expect(gm.assetTemplateContext(null)).toEqual({ mac: null });
  });
});
