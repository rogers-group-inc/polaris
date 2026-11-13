/**
 * tests/unit/reservationPushService.test.ts — the own suite for
 * src/services/reservationPushService.ts (CQ-T010).
 *
 * Complements:
 *   - releaseDhcpLease.test.ts — the lease-revoke verb on both transports;
 *   - reservationDescriptionBudget.test.ts — the 255-character budget;
 *   - reservedAddressCollisionMessage.test.ts — the collision text;
 *   - reservationPushClassify.test.ts — classifyPushError;
 *   - reservationService / assetQuarantineService / descriptionSync /
 *     subnetRefresh / reboot suites, which MOCK this module.
 *
 * Adds the device conversation itself, which no suite drives: transport
 * selection (FortiManager proxy vs direct with its token / interface / mgmt-IP
 * requirements, standalone FortiGate with its vdom default, every other
 * integration refused), `callFortiOs` appending the vdom to a proxied resource
 * that already has a query, the DHCP-scope match (gateway + netmask, then the
 * ip-range start), push's pre-check, write, echoed-mkey / read-back
 * verification and description composition, update's pinned-vs-discovered
 * entry resolution and its MAC-collision refusal, unpush's pinned and
 * discovered paths (never a blind DELETE), and integrationPushEnabled.
 *
 * The FortiGate is faked one layer down, at `fgRequest` / `fmgProxyRest`
 * (as releaseDhcpLease.test.ts does): a CMDB GET answers its `results` list,
 * a CMDB POST answers the FortiOS write envelope with `mkey` at the top level
 * — the shapes `fgRequest` and `fmgProxyRest` hand back after unwrapping.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ fgRequest: vi.fn(), fmgProxyRest: vi.fn(), resolveMgmtIp: vi.fn() }));

vi.mock("../../src/services/fortigateService.js", () => ({ fgRequest: h.fgRequest }));
vi.mock("../../src/services/fortimanagerService.js", () => ({ fmgProxyRest: h.fmgProxyRest, resolveDeviceMgmtIpViaFmg: h.resolveMgmtIp }));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import {
  buildTransportForIntegration,
  callFortiOs,
  findScopeIdForCidr,
  integrationPushEnabled,
  normalizeMac,
  pushReservation,
  unpushReservation,
  updatePushedReservation,
  type Transport,
} from "../../src/services/reservationPushService.js";

// ─── A fake FortiGate DHCP CMDB ──────────────────────────────────────────────

interface Reserved { id: number; ip?: string; mac?: string; description?: string; type?: string }
const gate = {
  servers: [] as Array<Record<string, unknown>>,
  reserved: new Map<number, Reserved[]>(),
  nextId: 100,
  /** What a POST echoes: "mkey" (number), "mkey-string", or "none". */
  echo: "mkey" as "mkey" | "mkey-string" | "none",
  /** Mutate what a write lands as, to exercise verify mismatches. */
  landAs: null as ((r: Reserved) => Reserved | null) | null,
  calls: [] as Array<{ method: string; path: string; body?: unknown }>,
};

function device(method: string, rawPath: string, body?: any): unknown {
  const path = rawPath.split("?")[0];
  gate.calls.push({ method, path, body });
  if (method === "GET" && path === "/api/v2/cmdb/system.dhcp/server") return gate.servers;
  const m = /^\/api\/v2\/cmdb\/system\.dhcp\/server\/(\d+)\/reserved-address(?:\/(\d+))?$/.exec(path);
  if (!m) throw new Error(`unexpected ${method} ${path}`);
  const scope = Number(m[1]);
  const list = gate.reserved.get(scope) ?? [];
  gate.reserved.set(scope, list);
  if (method === "GET") return list.map((r) => ({ ...r }));
  if (method === "POST") {
    const id = gate.nextId++;
    const row = { id, ...body };
    const landed = gate.landAs ? gate.landAs(row) : row;
    if (landed) list.push(landed);
    return gate.echo === "none"
      ? { http_method: "POST", status: "success", http_status: 200 }
      : { http_method: "POST", status: "success", http_status: 200, mkey: gate.echo === "mkey" ? id : String(id) };
  }
  const id = Number(m[2]);
  const i = list.findIndex((r) => r.id === id);
  if (method === "PUT") {
    if (i >= 0) list[i] = gate.landAs ? (gate.landAs({ ...list[i], ...body }) as Reserved) : { ...list[i], ...body };
    return { status: "success", mkey: id };
  }
  if (method === "DELETE") {
    if (i >= 0) list.splice(i, 1);
    return { status: "success" };
  }
  throw new Error(`unexpected ${method}`);
}

const fgIntegration = { id: "int-fg", type: "fortigate", config: { host: "192.0.2.1", apiUser: "polaris_api", apiToken: "t", vdom: "branch" } };
const fmgProxy = { id: "int-fmg", type: "fortimanager", config: { host: "192.0.2.2", apiUser: "u", apiToken: "t", adom: "root", useProxy: true } };
const fmgDirect = {
  id: "int-fmgd", type: "fortimanager",
  config: { host: "192.0.2.2", apiUser: "u", apiToken: "t", useProxy: false, fortigateApiUser: "fgapi", fortigateApiToken: "fgt", mgmtInterface: "port1", fortigateVerifySsl: true },
};

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  gate.servers = [
    { id: 1, interface: "lan", "default-gateway": "10.1.0.1", netmask: "255.255.255.0", "ip-range": [{ id: 1, "start-ip": "10.1.0.100", "end-ip": "10.1.0.200" }] },
    { id: 2, interface: "iot", "ip-range": [{ id: 1, "start-ip": "10.2.0.50", "end-ip": "10.2.0.99" }] },
  ];
  gate.reserved = new Map();
  gate.nextId = 100;
  gate.echo = "mkey";
  gate.landAs = null;
  gate.calls = [];
  h.fgRequest.mockImplementation(async (_cfg: unknown, method: string, path: string, opts: { body?: unknown }) => device(method, path, opts?.body));
  h.fmgProxyRest.mockImplementation(async (_cfg: unknown, _dev: string, method: string, resource: string, opts: { body?: unknown }) => device(method, resource, opts?.body));
});

const writes = () => gate.calls.filter((c) => c.method !== "GET");

// ─── Transport ───────────────────────────────────────────────────────────────

describe("buildTransportForIntegration", () => {
  it("standalone FortiGate: direct, with its own vdom (root when unset)", async () => {
    expect(await buildTransportForIntegration(fgIntegration, "x")).toMatchObject({ kind: "direct-fortigate", vdom: "branch", fgConfig: { host: "192.0.2.1", vdom: "branch" } });
    const noVdom = { ...fgIntegration, config: { host: "192.0.2.1", apiToken: "t" } };
    expect(await buildTransportForIntegration(noVdom, "x")).toMatchObject({ vdom: "root", fgConfig: { vdom: "root" } });
  });

  it("standalone FortiGate missing host or token is a 400", async () => {
    await expect(buildTransportForIntegration({ ...fgIntegration, config: { host: "h" } }, "x")).rejects.toMatchObject({ httpStatus: 400, message: expect.stringMatching(/missing host or apiToken/) });
    await expect(buildTransportForIntegration({ ...fgIntegration, config: null }, "x")).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("FortiManager in proxy mode (the default) relays through FMG, on root", async () => {
    expect(await buildTransportForIntegration(fmgProxy, "branch-fw")).toEqual({ kind: "fmg-proxy", fmgConfig: fmgProxy.config, deviceName: "branch-fw", vdom: "root", integrationId: "int-fmg" });
    const unset = { ...fmgProxy, config: { host: "h", apiUser: "u", apiToken: "t" } };
    expect((await buildTransportForIntegration(unset, "d")).kind).toBe("fmg-proxy");
    expect(h.resolveMgmtIp).not.toHaveBeenCalled();
  });

  it("FortiManager direct: resolves the gate's management IP through FMG and dials it with the FortiGate token", async () => {
    h.resolveMgmtIp.mockResolvedValue("172.16.1.1");
    const t = await buildTransportForIntegration(fmgDirect, "branch-fw");
    expect(h.resolveMgmtIp).toHaveBeenCalledWith(fmgDirect.config, "branch-fw", undefined, "int-fmgd");
    expect(t).toEqual({
      kind: "direct-fortigate", vdom: "root",
      fgConfig: { host: "172.16.1.1", port: 443, apiUser: "fgapi", apiToken: "fgt", vdom: "root", verifySsl: true, mgmtInterface: "port1" },
    });
  });

  it("FortiManager direct refuses without a FortiGate token, without a management interface, and 502s when FMG cannot name the IP", async () => {
    await expect(buildTransportForIntegration({ ...fmgDirect, config: { ...fmgDirect.config, fortigateApiToken: "" } }, "d")).rejects.toMatchObject({ httpStatus: 400, message: "Direct mode requires a FortiGate API token on the integration" });
    await expect(buildTransportForIntegration({ ...fmgDirect, config: { ...fmgDirect.config, mgmtInterface: "  " } }, "d")).rejects.toMatchObject({ httpStatus: 400, message: expect.stringMatching(/Management Interface/) });
    h.resolveMgmtIp.mockResolvedValue(null);
    await expect(buildTransportForIntegration(fmgDirect, "d")).rejects.toMatchObject({ httpStatus: 502, message: 'Could not resolve management IP for "d" via FortiManager' });
  });

  it("any other integration type is refused with a pathway-neutral 400", async () => {
    await expect(buildTransportForIntegration({ id: "x", type: "vcenter", config: {} }, "d")).rejects.toMatchObject({ httpStatus: 400, message: 'Fortinet device write is not supported for integration type "vcenter"' });
  });
});

describe("callFortiOs", () => {
  it("direct: the vdom rides as a query parameter; proxy: on the resource, after an existing query with '&'", async () => {
    const direct: Transport = { kind: "direct-fortigate", fgConfig: { host: "h", apiToken: "t" } as never, vdom: "v1" };
    h.fgRequest.mockResolvedValue([]);
    await callFortiOs(direct, "GET", "/api/v2/cmdb/firewall/address", undefined);
    expect(h.fgRequest).toHaveBeenCalledWith(direct.fgConfig, "GET", "/api/v2/cmdb/firewall/address", { query: { vdom: "v1" }, body: undefined });

    const proxy: Transport = { kind: "fmg-proxy", fmgConfig: {} as never, deviceName: "gw", vdom: "a b", integrationId: "i1" };
    h.fmgProxyRest.mockResolvedValue([]);
    await callFortiOs(proxy, "GET", "/api/v2/monitor/x?format=name");
    await callFortiOs(proxy, "PUT", "/api/v2/cmdb/y", { a: 1 });
    expect(h.fmgProxyRest.mock.calls[0].slice(1)).toEqual(["gw", "GET", "/api/v2/monitor/x?format=name&vdom=a%20b", { body: undefined, integrationId: "i1" }]);
    expect(h.fmgProxyRest.mock.calls[1].slice(1)).toEqual(["gw", "PUT", "/api/v2/cmdb/y?vdom=a%20b", { body: { a: 1 }, integrationId: "i1" }]);
  });
});

describe("integrationPushEnabled", () => {
  it.each([
    [null, false],
    [{ type: "fortigate", config: { pushReservations: true } }, true],
    [{ type: "fortimanager", config: { pushReservations: true } }, true],
    [{ type: "fortimanager", config: { pushReservations: "true" } }, false],
    [{ type: "fortigate", config: null }, false],
    [{ type: "windowsserver", config: { pushReservations: true } }, false],
  ])("%j → %s", (integration, want) => {
    expect(integrationPushEnabled(integration as never)).toBe(want);
  });
});

// ─── Scope match ─────────────────────────────────────────────────────────────

describe("findScopeIdForCidr", () => {
  const t = (): Promise<Transport> => buildTransportForIntegration(fgIntegration, "gw");

  it("matches gateway + netmask first, then a scope whose range starts inside the subnet", async () => {
    expect(await findScopeIdForCidr(await t(), "10.1.0.0/24")).toEqual({ scopeId: 1, serverInterface: "lan" });
    expect(await findScopeIdForCidr(await t(), "10.2.0.0/24")).toEqual({ scopeId: 2, serverInterface: "iot" });
  });

  it("a different mask on the same base does not match by gateway", async () => {
    await expect(findScopeIdForCidr(await t(), "10.1.0.0/25")).resolves.toEqual({ scopeId: 1, serverInterface: "lan" }); // 10.1.0.100 is inside /25
    await expect(findScopeIdForCidr(await t(), "10.1.0.0/26")).rejects.toMatchObject({ httpStatus: 409, message: "FortiGate has no DHCP scope matching subnet 10.1.0.0/26" });
  });

  it("an invalid CIDR is a 400; a malformed server row is skipped; a non-list answer means no scopes", async () => {
    await expect(findScopeIdForCidr(await t(), "999.0.0.0/24")).rejects.toMatchObject({ httpStatus: 400, message: "Invalid subnet CIDR: 999.0.0.0/24" });
    gate.servers = [{ id: 9, "default-gateway": "not-an-ip", netmask: "255.255.255.0" }, ...gate.servers];
    expect((await findScopeIdForCidr(await t(), "10.1.0.0/24")).scopeId).toBe(1);
    h.fgRequest.mockResolvedValueOnce({ unexpected: true });
    await expect(findScopeIdForCidr(await t(), "10.1.0.0/24")).rejects.toMatchObject({ httpStatus: 409 });
  });
});

// ─── Push ────────────────────────────────────────────────────────────────────

const pushParams = (over: Record<string, unknown> = {}) => ({
  reservationId: "r1", subnetCidr: "10.1.0.0/24", ip: "10.1.0.50", mac: "AA-BB-CC-DD-EE-01", hostname: "printer-2", notes: null,
  createdBy: "alice", integration: fgIntegration, deviceName: "gw", ...over,
});

describe("pushReservation", () => {
  it("writes a MAC-type entry with the composed description and verifies it by the echoed mkey", async () => {
    const out = await pushReservation(pushParams());
    expect(out).toEqual({ scopeId: 1, entryId: 100, serverInterface: "lan", description: "Polaris/alice: printer-2" });
    expect(writes()).toEqual([{ method: "POST", path: "/api/v2/cmdb/system.dhcp/server/1/reserved-address", body: { ip: "10.1.0.50", mac: "aa:bb:cc:dd:ee:01", description: "Polaris/alice: printer-2", type: "mac" } }]);
  });

  it.each([
    ["notes win, hostname bracketed", { notes: "  front desk  " }, "Polaris/alice: front desk [printer-2]"],
    ["notes, no hostname", { notes: "front desk", hostname: "" }, "Polaris/alice: front desk"],
    ["no user in scope", { createdBy: "  " }, "Polaris: printer-2"],
    ["no hostname: the IP", { hostname: null }, "Polaris/alice: 10.1.0.50"],
  ])("description: %s", async (_l, over, want) => {
    expect((await pushReservation(pushParams(over))).description).toBe(want);
  });

  it("a description over 255 characters is cut to 255 as a backstop", async () => {
    const out = await pushReservation(pushParams({ notes: "n".repeat(400) }));
    expect(out.description).toHaveLength(255);
    expect(out.description.startsWith("Polaris/alice: nnn")).toBe(true);
  });

  it("a string mkey is read as the id; no echo at all is resolved by IP + MAC on read-back", async () => {
    gate.echo = "mkey-string";
    expect((await pushReservation(pushParams())).entryId).toBe(100);
    gate.echo = "none";
    expect((await pushReservation(pushParams({ ip: "10.1.0.51", mac: "aa:bb:cc:dd:ee:02" }))).entryId).toBe(101);
  });

  it("refuses before any transport call without a device name or with a MAC that is not 48-bit", async () => {
    await expect(pushReservation(pushParams({ deviceName: "" }))).rejects.toMatchObject({ httpStatus: 400, message: expect.stringMatching(/no fortigateDevice/) });
    await expect(pushReservation(pushParams({ mac: "aa:bb:cc" }))).rejects.toMatchObject({ httpStatus: 400, message: expect.stringMatching(/^Invalid MAC address: aa:bb:cc/) });
    expect(gate.calls).toEqual([]);
  });

  it("an IP or MAC the scope already reserves is a 409 and nothing is written", async () => {
    gate.reserved.set(1, [{ id: 7, ip: "10.1.0.50", mac: "11:11:11:11:11:11", description: "Polaris/bob: cam" }]);
    await expect(pushReservation(pushParams())).rejects.toMatchObject({ httpStatus: 409, message: expect.stringMatching(/already has a reservation for 10\.1\.0\.50 on this scope \(entry id 7/) });
    gate.reserved.set(1, [{ id: 8, ip: "10.1.0.60", mac: "AA:BB:CC:DD:EE:01" }]);
    await expect(pushReservation(pushParams())).rejects.toMatchObject({ httpStatus: 409, message: expect.stringMatching(/MAC aa:bb:cc:dd:ee:01 on this scope at 10\.1\.0\.60/) });
    expect(writes()).toEqual([]);
  });

  it("a write the gate accepted but does not show is a 502 (permanent: not visible on read-back)", async () => {
    gate.landAs = () => null;
    await expect(pushReservation(pushParams())).rejects.toMatchObject({ httpStatus: 502, message: expect.stringMatching(/entry was not visible on read-back for 10\.1\.0\.50/) });
  });

  it("an entry that landed with another MAC is a verify mismatch", async () => {
    gate.landAs = (r) => ({ ...r, mac: "00:00:00:00:00:99" });
    await expect(pushReservation(pushParams())).rejects.toMatchObject({ httpStatus: 502, message: "FortiGate verify mismatch — read back 10.1.0.50 / 00:00:00:00:00:99, wrote 10.1.0.50 / aa:bb:cc:dd:ee:01" });
  });

  it("through a FortiManager proxy the same conversation runs, the vdom on each resource", async () => {
    await pushReservation(pushParams({ integration: fmgProxy, deviceName: "branch-fw" }));
    expect(h.fgRequest).not.toHaveBeenCalled();
    expect(h.fmgProxyRest.mock.calls.map((c) => `${c[2]} ${c[3]}`)).toEqual([
      "GET /api/v2/cmdb/system.dhcp/server?vdom=root",
      "GET /api/v2/cmdb/system.dhcp/server/1/reserved-address?vdom=root",
      "POST /api/v2/cmdb/system.dhcp/server/1/reserved-address?vdom=root",
      "GET /api/v2/cmdb/system.dhcp/server/1/reserved-address?vdom=root",
    ]);
  });
});

// ─── Update ──────────────────────────────────────────────────────────────────

const updateParams = (over: Record<string, unknown> = {}) => ({
  reservationId: "r1", subnetCidr: "10.1.0.0/24", ip: "10.1.0.50", newMac: "aa:bb:cc:dd:ee:09", hostname: "printer-2", notes: null,
  createdBy: "alice", scopeId: 1 as number | null, entryId: 7 as number | null, integration: fgIntegration, deviceName: "gw", ...over,
});

describe("updatePushedReservation", () => {
  beforeEach(() => {
    gate.reserved.set(1, [{ id: 7, ip: "10.1.0.50", mac: "aa:bb:cc:dd:ee:01", description: "Polaris/alice: printer-2", type: "option82" }]);
  });

  it("pinned: PUTs the new MAC + description + type=mac by id, without listing the scopes", async () => {
    const out = await updatePushedReservation(updateParams({ notes: "moved" }));
    expect(out).toEqual({ scopeId: 1, entryId: 7, serverInterface: undefined, description: "Polaris/alice: moved [printer-2]" });
    expect(gate.calls.some((c) => c.path === "/api/v2/cmdb/system.dhcp/server")).toBe(false);
    expect(writes()).toEqual([{ method: "PUT", path: "/api/v2/cmdb/system.dhcp/server/1/reserved-address/7", body: { mac: "aa:bb:cc:dd:ee:09", description: "Polaris/alice: moved [printer-2]", type: "mac" } }]);
  });

  it("discovered (no pins): resolves the scope by CIDR and the entry by IP, and returns them for the caller to stamp", async () => {
    const out = await updatePushedReservation(updateParams({ scopeId: null, entryId: null }));
    expect(out).toMatchObject({ scopeId: 1, entryId: 7, serverInterface: "lan" });
  });

  it("a stale pinned id falls back to the entry at the IP", async () => {
    const out = await updatePushedReservation(updateParams({ entryId: 999 }));
    expect(out.entryId).toBe(7);
  });

  it("no entry at the IP is a 404 naming the scope", async () => {
    await expect(updatePushedReservation(updateParams({ entryId: null, ip: "10.1.0.77" }))).rejects.toMatchObject({ httpStatus: 404, message: "FortiGate has no reservation matching 10.1.0.77 on scope 1 — was it deleted on the device?" });
  });

  it("the new MAC on ANOTHER entry is a 409; the entry's own MAC is not a collision", async () => {
    gate.reserved.get(1)!.push({ id: 8, ip: "10.1.0.60", mac: "AA:BB:CC:DD:EE:09", description: "cam" });
    await expect(updatePushedReservation(updateParams())).rejects.toMatchObject({ httpStatus: 409, message: expect.stringMatching(/another reservation for MAC aa:bb:cc:dd:ee:09 on this scope \(entry id 8, MAC AA:BB:CC:DD:EE:09, description "cam"\)/) });
    expect(writes()).toEqual([]);
    await expect(updatePushedReservation(updateParams({ newMac: "aa:bb:cc:dd:ee:01" }))).resolves.toMatchObject({ entryId: 7 });
  });

  it("refuses an invalid MAC or a missing device before any call", async () => {
    await expect(updatePushedReservation(updateParams({ newMac: "zz" }))).rejects.toMatchObject({ httpStatus: 400 });
    await expect(updatePushedReservation(updateParams({ deviceName: "" }))).rejects.toMatchObject({ httpStatus: 400 });
    expect(gate.calls).toEqual([]);
  });

  it("read-back: an entry gone after the PUT, or still carrying another MAC, is a 502", async () => {
    gate.landAs = (r) => ({ ...r, mac: "aa:bb:cc:dd:ee:01" });
    await expect(updatePushedReservation(updateParams())).rejects.toMatchObject({ httpStatus: 502, message: "FortiGate verify mismatch — read back MAC aa:bb:cc:dd:ee:01, wrote aa:bb:cc:dd:ee:09" });
    gate.landAs = null;
    const realFg = h.fgRequest.getMockImplementation()!;
    let lists = 0;
    h.fgRequest.mockImplementation(async (cfg: unknown, method: string, path: string, opts: any) => {
      if (method === "GET" && path.endsWith("/reserved-address") && ++lists === 2) return [];
      return realFg(cfg, method, path, opts);
    });
    await expect(updatePushedReservation(updateParams())).rejects.toMatchObject({ httpStatus: 502, message: "FortiGate accepted the update but entry id 7 is no longer visible on read-back" });
  });
});

// ─── Unpush ──────────────────────────────────────────────────────────────────

describe("unpushReservation", () => {
  beforeEach(() => {
    gate.reserved.set(1, [{ id: 7, ip: "10.1.0.50", mac: "aa:bb:cc:dd:ee:01" }]);
  });
  const base = { reservationId: "r1", integration: fgIntegration, deviceName: "gw" };

  it("pinned: DELETEs by id once the read confirms it is there", async () => {
    expect(await unpushReservation({ ...base, scopeId: 1, entryId: 7 })).toEqual({ removed: true, alreadyAbsent: false });
    expect(writes()).toEqual([{ method: "DELETE", path: "/api/v2/cmdb/system.dhcp/server/1/reserved-address/7", body: undefined }]);
  });

  it("pinned but gone from the device: success-with-warning, no DELETE", async () => {
    expect(await unpushReservation({ ...base, scopeId: 1, entryId: 99 })).toEqual({ removed: false, alreadyAbsent: true });
    expect(writes()).toEqual([]);
  });

  it("discovered: resolves the scope by CIDR and the entry by IP, then DELETEs that id", async () => {
    expect(await unpushReservation({ ...base, subnetCidr: "10.1.0.0/24", ip: "10.1.0.50" })).toEqual({ removed: true, alreadyAbsent: false });
    expect(writes()[0].path).toBe("/api/v2/cmdb/system.dhcp/server/1/reserved-address/7");
  });

  it("never a blind DELETE: a failed read is treated as already absent on both paths", async () => {
    h.fgRequest.mockImplementation(async (_c: unknown, method: string, path: string) => {
      if (path.endsWith("/reserved-address")) throw new Error("ETIMEDOUT");
      return device(method, path);
    });
    expect(await unpushReservation({ ...base, scopeId: 1, entryId: 7 })).toEqual({ removed: false, alreadyAbsent: true });
    expect(await unpushReservation({ ...base, subnetCidr: "10.1.0.0/24", ip: "10.1.0.50" })).toEqual({ removed: false, alreadyAbsent: true });
    expect(writes()).toEqual([]);
  });

  it("no pinned scope and no CIDR is a 400; a DELETE the device refuses propagates", async () => {
    await expect(unpushReservation({ ...base, ip: "10.1.0.50" })).rejects.toMatchObject({ httpStatus: 400, message: expect.stringMatching(/pinned scopeId or a subnetCidr/) });
    const realFg = h.fgRequest.getMockImplementation()!;
    h.fgRequest.mockImplementation(async (cfg: unknown, method: string, path: string, opts: any) => {
      if (method === "DELETE") throw new Error("FortiGate permission denied (HTTP 403)");
      return realFg(cfg, method, path, opts);
    });
    await expect(unpushReservation({ ...base, scopeId: 1, entryId: 7 })).rejects.toThrow("permission denied");
  });
});

describe("normalizeMac", () => {
  it("is the FortiOS wire form: colon-separated lower case", () => {
    expect(normalizeMac("AA-BB-CC-DD-EE-01")).toBe("aa:bb:cc:dd:ee:01");
    expect(normalizeMac("aabb.ccdd.ee01")).toBe("aa:bb:cc:dd:ee:01");
  });
});
