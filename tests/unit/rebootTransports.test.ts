/**
 * tests/unit/rebootTransports.test.ts — services/rebootTransports.ts, the
 * protocol half of a reboot (business rule 115): one GateOps surface over
 * four links (token / login / fmg-proxy / ssh).
 *
 * The contract pinned here: the endpoints and bodies (REBOOT_PATH
 * `{event_log_message}`, switch restart `{mkey}`, AP restart `{wtpname}`), a
 * REFUSAL (RebootSendError — nothing rebooted) kept apart from a LOST ANSWER
 * (`{ uncertain }` — the box may already be going down), every CLI argument
 * through assertCliToken, the login link's re-sign-in after a reboot and its
 * two-refusal lockout guard, and the CLI driver answering (y/n) and paging.
 *
 * Every transport is mocked at its module boundary: fgRequest, fmgProxyRest,
 * DeviceHttpClient + gateLogin, withSshClient (a scripted interactive shell),
 * node:net.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const h = vi.hoisted(() => ({
  fgRequest: vi.fn(),
  fmgProxyRest: vi.fn(),
  gateLogin: vi.fn(),
  clientOpts: [] as unknown[],
  client: {
    get: vi.fn(),
    postJson: vi.fn(),
    delete: vi.fn(),
    clearSession: vi.fn(),
  },
  withSshClient: vi.fn(),
  createConnection: vi.fn(),
}));

vi.mock("../../src/services/fortigateService.js", () => ({ fgRequest: h.fgRequest }));
vi.mock("../../src/services/fortimanagerService.js", () => ({ fmgProxyRest: h.fmgProxyRest }));
vi.mock("../../src/services/firmwareEngines/fortigateHttps.js", () => ({ gateLogin: h.gateLogin }));
vi.mock("../../src/services/firmwareEngines/deviceHttp.js", async (orig) => {
  const real = await orig<Record<string, unknown>>();
  class FakeDeviceHttpClient {
    constructor(opts: unknown) { h.clientOpts.push(opts); }
    get(...a: unknown[]) { return h.client.get(...a); }
    postJson(...a: unknown[]) { return h.client.postJson(...a); }
    delete(...a: unknown[]) { return h.client.delete(...a); }
    clearSession() { return h.client.clearSession(); }
  }
  return { ...real, DeviceHttpClient: FakeDeviceHttpClient };
});
vi.mock("../../src/utils/remoteExec.js", () => ({ withSshClient: h.withSshClient }));
vi.mock("node:net", async (orig) => ({ ...(await orig<Record<string, unknown>>()), createConnection: h.createConnection }));

import { AppError } from "../../src/utils/errors.js";
import { DeviceConnectionError } from "../../src/services/firmwareEngines/deviceHttp.js";
import { _rebootTransportSeams, RebootSendError, parseJoinTime, type GateLink } from "../../src/services/rebootTransports.js";

const { gateOps, tcpUp } = _rebootTransportSeams;

const TOKEN: GateLink = { kind: "token", host: "10.0.0.1", port: 8443, token: "tkn", verifyTls: false, vdom: "root" };
const LOGIN: GateLink = { kind: "login", host: "10.0.0.2", port: 443, username: "admin", password: "pw", verifyTls: false, vdom: "v 1", expectedSerial: "FGT60F0000000001" };
const PROXY: GateLink = { kind: "fmg-proxy", fmgConfig: { host: "fmg.example.com" } as never, deviceName: "HQ-FGT", integrationId: "intg-1", vdom: "root" };
const SSH: GateLink = { kind: "ssh", host: "10.0.0.3", config: { username: "admin" } };

/** Run `f` as an async call, so a synchronous throw and a rejection both reject. */
const asCall = async <T,>(f: () => Promise<T>): Promise<T> => f();

const res = (status: number, body: unknown) => ({ status, headers: {}, body: typeof body === "string" ? body : JSON.stringify(body), location: null });

beforeEach(() => {
  for (const f of [h.fgRequest, h.fmgProxyRest, h.gateLogin, h.withSshClient, h.createConnection, ...Object.values(h.client)]) f.mockReset();
  h.clientOpts.length = 0;
  h.gateLogin.mockResolvedValue(undefined);
  h.client.delete.mockResolvedValue(res(200, {}));
});

// ─── parseJoinTime ─────────────────────────────────────────────────────────

describe("parseJoinTime", () => {
  it("reads epoch seconds (an AP's join_time_raw) and epoch ms as ms", () => {
    expect(parseJoinTime(1_760_000_000)).toBe(1_760_000_000_000);
    expect(parseJoinTime(1_760_000_000_000)).toBe(1_760_000_000_000);
  });
  it("reads a switch's date string, collapsing its double spaces", () => {
    expect(parseJoinTime("Fri Sep  4 07:26:15 2026")).toBe(Date.parse("Fri Sep 4 07:26:15 2026"));
  });
  it("null for nothing usable", () => {
    for (const v of [0, -5, NaN, Infinity, "", "   ", "not a date", null, undefined, {}]) expect(parseJoinTime(v)).toBeNull();
  });
});

// ─── token link ────────────────────────────────────────────────────────────

describe("token link", () => {
  it("labels itself and sends the reboot to REBOOT_PATH with the event-log message, scoped to the VDOM", async () => {
    h.fgRequest.mockResolvedValue({});
    const ops = gateOps(TOKEN);
    expect(ops.label).toBe("https://10.0.0.1:8443 with an API token");
    expect(await ops.rebootSelf("Polaris: reboot by alice")).toEqual({});
    const [cfg, method, path, opts] = h.fgRequest.mock.calls[0];
    expect(cfg).toMatchObject({ host: "10.0.0.1", port: 8443, apiToken: "tkn", vdom: "root", verifySsl: false });
    expect(method).toBe("POST");
    expect(path).toBe("/api/v2/monitor/system/os/reboot");
    expect(opts).toEqual({ query: { vdom: "root" }, body: { event_log_message: "Polaris: reboot by alice" } });
  });

  it("restarts a managed switch by {mkey} and an AP by {wtpname}", async () => {
    h.fgRequest.mockResolvedValue({});
    const ops = gateOps(TOKEN);
    await ops.restartSwitch("S124EP-01");
    await ops.restartAp("FP231F0000000001");
    expect(h.fgRequest.mock.calls[0].slice(2)).toEqual(["/api/v2/monitor/switch-controller/managed-switch/restart", { query: { vdom: "root" }, body: { mkey: "S124EP-01" } }]);
    expect(h.fgRequest.mock.calls[1].slice(2)).toEqual(["/api/v2/monitor/wifi/managed_ap/restart", { query: { vdom: "root" }, body: { wtpname: "FP231F0000000001" } }]);
  });

  it("refuses a device name that is not a plain token, before anything is sent", async () => {
    const ops = gateOps(TOKEN);
    // (The check throws synchronously out of the Promise-returning method; the
    // runner awaits it inside its try, so both shapes land in the same catch.)
    for (const bad of ["a b", "x;reboot", "", "a".repeat(65), "sw\nexecute reboot", "ü"]) {
      await expect(asCall(() => ops.restartSwitch(bad))).rejects.toBeInstanceOf(RebootSendError);
      await expect(asCall(() => ops.restartAp(bad))).rejects.toBeInstanceOf(RebootSendError);
    }
    expect(h.fgRequest).not.toHaveBeenCalled();
  });

  it("an HTTP / auth / FortiOS error is a refusal (RebootSendError)", async () => {
    const ops = gateOps(TOKEN);
    for (const err of [
      new AppError(502, "Authentication failed (HTTP 401) for 10.0.0.1:8443 — check your API token"),
      new AppError(502, "FortiGate permission denied (HTTP 403) for 10.0.0.1:8443 on /x"),
      new AppError(502, "FortiGate returned HTTP 500 for /x: socket hang up in the CLI"),
      new AppError(502, "FortiGate error (-37): /x"),
      new AppError(404, "Endpoint not found: /api/v2/monitor/system/os/reboot"),
    ]) {
      h.fgRequest.mockRejectedValueOnce(err);
      const e = await ops.rebootSelf("m").catch((x) => x);
      expect(e).toBeInstanceOf(RebootSendError);
      expect(e.message).toBe(err.message);
    }
  });

  it("a dropped connection or an unreadable answer is a lost answer ({ uncertain }), not a refusal", async () => {
    const ops = gateOps(TOKEN);
    for (const msg of ["fetch failed", "other side closed", "This operation was aborted", "read ECONNRESET", "Unexpected end of JSON input"]) {
      h.fgRequest.mockRejectedValueOnce(new Error(msg));
      expect(await ops.rebootSelf("m")).toEqual({ uncertain: msg });
    }
  });

  it("a fetch that never connected (refused / no DNS / unreachable) is a refusal, not uncertain", async () => {
    // Was a bug until 2026-11-16: "fetch failed" from ECONNREFUSED counted as a lost answer.
    const ops = gateOps(TOKEN);
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH"]) {
      h.fgRequest.mockRejectedValueOnce(new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) }));
      const e = await ops.rebootSelf("m").catch((x) => x);
      expect(e).toBeInstanceOf(RebootSendError);
    }
    // A reset after the request may have gone out stays uncertain.
    h.fgRequest.mockRejectedValueOnce(new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }));
    expect(await ops.rebootSelf("m")).toEqual({ uncertain: "fetch failed" });
  });

  it("reads the serial from the status ENVELOPE", async () => {
    h.fgRequest.mockResolvedValue({ serial: "FGT60F0000000001", results: { hostname: "HQ" } });
    expect(await gateOps(TOKEN).serial()).toBe("FGT60F0000000001");
    expect(h.fgRequest.mock.calls[0].slice(1)).toEqual(["GET", "/api/v2/monitor/system/status", { query: { vdom: "root" }, envelope: true }]);
  });

  it("serial is null when the envelope carries none", async () => {
    h.fgRequest.mockResolvedValue({ results: {} });
    expect(await gateOps(TOKEN).serial()).toBeNull();
  });

  it("reads the HA mode from a row or a one-row array", async () => {
    const ops = gateOps(TOKEN);
    h.fgRequest.mockResolvedValueOnce({ mode: "a-p" });
    expect(await ops.haMode()).toBe("a-p");
    h.fgRequest.mockResolvedValueOnce([{ mode: "standalone" }]);
    expect(await ops.haMode()).toBe("standalone");
    h.fgRequest.mockResolvedValueOnce([]);
    expect(await ops.haMode()).toBeNull();
    h.fgRequest.mockResolvedValueOnce({ mode: "" });
    expect(await ops.haMode()).toBeNull();
    expect(h.fgRequest.mock.calls[0][2]).toBe("/api/v2/cmdb/system/ha");
  });

  it("reads the boot time from web-ui/state utc_last_reboot (ms), null when absent or zero", async () => {
    const ops = gateOps(TOKEN);
    h.fgRequest.mockResolvedValueOnce({ utc_last_reboot: 1_760_000_000_000 });
    expect(await ops.bootTime()).toEqual(new Date(1_760_000_000_000));
    h.fgRequest.mockResolvedValueOnce({ utc_last_reboot: "1760000000000" });
    expect(await ops.bootTime()).toEqual(new Date(1_760_000_000_000));
    h.fgRequest.mockResolvedValueOnce({ utc_last_reboot: 0 });
    expect(await ops.bootTime()).toBeNull();
    h.fgRequest.mockResolvedValueOnce(null);
    expect(await ops.bootTime()).toBeNull();
    expect(h.fgRequest.mock.calls[0][2]).toBe("/api/v2/monitor/web-ui/state");
  });

  it("lists managed switches: switch-id (falls back to serial), status, join time; rows without a serial dropped", async () => {
    h.fgRequest.mockResolvedValue([
      { serial: "S124EP0000000001", "switch-id": "Core-1", status: "Connected", join_time: "Fri Sep  4 07:26:15 2026" },
      { serial: "S124EP0000000002", status: "" },
      { "switch-id": "ghost" },
    ]);
    expect(await gateOps(TOKEN).managedSwitches()).toEqual([
      { serial: "S124EP0000000001", switchId: "Core-1", status: "Connected", joinTime: Date.parse("Fri Sep 4 07:26:15 2026") },
      { serial: "S124EP0000000002", switchId: "S124EP0000000002", status: null, joinTime: null },
    ]);
    expect(h.fgRequest.mock.calls[0][2]).toBe("/api/v2/monitor/switch-controller/managed-switch/status");
  });

  it("lists managed APs: wtp_id › name › serial, join_time_raw in seconds", async () => {
    h.fgRequest.mockResolvedValue([
      { serial: "FP231F0000000001", wtp_id: "FP231F0000000001", name: "Lobby", status: "connected", join_time_raw: 1_760_000_000 },
      { serial: "FP231F0000000002", name: "Yard" },
      { serial: "FP231F0000000003" },
    ]);
    const aps = await gateOps(TOKEN).managedAps();
    expect(aps).toEqual([
      { serial: "FP231F0000000001", wtpId: "FP231F0000000001", status: "connected", joinTime: 1_760_000_000_000 },
      { serial: "FP231F0000000002", wtpId: "Yard", status: null, joinTime: null },
      { serial: "FP231F0000000003", wtpId: "FP231F0000000003", status: null, joinTime: null },
    ]);
    expect(h.fgRequest.mock.calls[0][2]).toBe("/api/v2/monitor/wifi/managed_ap");
  });

  it("a non-array table reads as no devices", async () => {
    h.fgRequest.mockResolvedValue({});
    expect(await gateOps(TOKEN).managedSwitches()).toEqual([]);
    expect(await gateOps(TOKEN).managedAps()).toEqual([]);
  });

  it("close is a no-op", async () => {
    await expect(gateOps(TOKEN).close()).resolves.toBeUndefined();
  });
});

// ─── login link ────────────────────────────────────────────────────────────

describe("login link", () => {
  it("builds a pinning device client carrying the gate's serial (rule 113(c)) and labels itself", () => {
    const ops = gateOps(LOGIN);
    expect(ops.label).toBe('https://10.0.0.2:443 as admin "admin"');
    expect(h.clientOpts[0]).toMatchObject({ host: "10.0.0.2", port: 443, scheme: "https", verifyTls: false, expectedSerial: "FGT60F0000000001" });
  });

  it("signs in once, then reads with the VDOM in the query, unwrapping results unless the envelope is asked for", async () => {
    h.client.get.mockResolvedValue(res(200, { serial: "FGT60F0000000001", results: { mode: "a-p" } }));
    const ops = gateOps(LOGIN);
    expect(await ops.serial()).toBe("FGT60F0000000001");
    expect(await ops.haMode()).toBe("a-p");
    expect(h.gateLogin).toHaveBeenCalledTimes(1);
    expect(h.gateLogin.mock.calls[0][1]).toMatchObject({ credential: { username: "admin", password: "pw" } });
    expect(h.client.get.mock.calls[0][0]).toBe("/api/v2/monitor/system/status?vdom=v%201");
  });

  it("a refused read (401 / 403) forgets the session and signs in again on the next call", async () => {
    const ops = gateOps(LOGIN);
    h.client.get.mockResolvedValueOnce(res(401, ""));
    await expect(ops.haMode()).rejects.toMatchObject({ httpStatus: 502, message: expect.stringMatching(/HTTP 401/) });
    expect(h.client.clearSession).toHaveBeenCalled();
    h.client.get.mockResolvedValueOnce(res(200, { results: { mode: "standalone" } }));
    expect(await ops.haMode()).toBe("standalone");
    expect(h.gateLogin).toHaveBeenCalledTimes(2);
  });

  it("a read whose connection dropped also re-signs-in next time", async () => {
    const ops = gateOps(LOGIN);
    h.client.get.mockRejectedValueOnce(new DeviceConnectionError("socket hang up"));
    await expect(ops.bootTime()).rejects.toBeInstanceOf(DeviceConnectionError);
    h.client.get.mockResolvedValueOnce(res(200, { results: { utc_last_reboot: 5000 } }));
    expect(await ops.bootTime()).toEqual(new Date(5000));
    expect(h.gateLogin).toHaveBeenCalledTimes(2);
  });

  it("a non-200 or non-JSON read is a 502", async () => {
    const ops = gateOps(LOGIN);
    h.client.get.mockResolvedValueOnce(res(500, {}));
    await expect(ops.haMode()).rejects.toMatchObject({ httpStatus: 502, message: expect.stringMatching(/unexpected answer/) });
    h.client.get.mockResolvedValueOnce(res(200, "<html>"));
    await expect(ops.haMode()).rejects.toMatchObject({ httpStatus: 502 });
  });

  it("stops signing in after the gate REFUSED the admin twice (lockout guard); connection failures do not count", async () => {
    const ops = gateOps(LOGIN);
    h.gateLogin.mockRejectedValueOnce(new DeviceConnectionError("ECONNREFUSED"));
    await expect(ops.haMode()).rejects.toBeInstanceOf(DeviceConnectionError);
    h.gateLogin.mockRejectedValueOnce(new Error("login refused"));
    await expect(ops.haMode()).rejects.toThrow("login refused");
    h.gateLogin.mockRejectedValueOnce(new Error("login refused"));
    await expect(ops.haMode()).rejects.toThrow("login refused");
    expect(h.gateLogin).toHaveBeenCalledTimes(3);
    await expect(ops.haMode()).rejects.toMatchObject({ httpStatus: 502, message: expect.stringMatching(/twice/) });
    expect(h.gateLogin).toHaveBeenCalledTimes(3);
    // The send path turns the same guard into a refusal.
    await expect(ops.rebootSelf("m")).rejects.toBeInstanceOf(RebootSendError);
  });

  it("posts the reboot as JSON with the VDOM; a 2xx without status:error is sent", async () => {
    h.client.postJson.mockResolvedValue(res(200, { status: "success" }));
    expect(await gateOps(LOGIN).rebootSelf("bye")).toEqual({});
    expect(h.client.postJson).toHaveBeenCalledWith("/api/v2/monitor/system/os/reboot?vdom=v%201", { event_log_message: "bye" });
  });

  it("a 401 / 403, a non-2xx or a status:error answer is a refusal carrying FortiOS's reason", async () => {
    const ops = gateOps(LOGIN);
    h.client.postJson.mockResolvedValueOnce(res(403, ""));
    await expect(ops.rebootSelf("m")).rejects.toThrow(/HTTP 403.*System read-write/);
    h.client.postJson.mockResolvedValueOnce(res(200, { status: "error", cli_error: "command parse error" }));
    await expect(ops.restartSwitch("sw1")).rejects.toThrow("the FortiGate refused the request: command parse error (HTTP 200)");
    h.client.postJson.mockResolvedValueOnce(res(500, "oops"));
    await expect(ops.restartAp("ap1")).rejects.toThrow("the FortiGate refused the request (HTTP 500)");
    h.client.postJson.mockResolvedValueOnce(res(424, { error: -5, message: "entry not found" }));
    await expect(ops.restartAp("ap1")).rejects.toThrow("the FortiGate refused the request: -5 (HTTP 424)");
  });

  it("a connection that drops during the send is a lost answer", async () => {
    h.client.postJson.mockRejectedValue(new DeviceConnectionError("socket hang up", "ECONNRESET"));
    expect(await gateOps(LOGIN).rebootSelf("m")).toEqual({ uncertain: "socket hang up" });
  });

  it("any other send failure is a refusal", async () => {
    h.client.postJson.mockRejectedValue(new Error("certificate names serial X"));
    await expect(gateOps(LOGIN).rebootSelf("m")).rejects.toBeInstanceOf(RebootSendError);
  });

  it("a login failure on the send path is a refusal — nothing was sent", async () => {
    h.gateLogin.mockRejectedValue(new DeviceConnectionError("ECONNREFUSED"));
    await expect(gateOps(LOGIN).rebootSelf("m")).rejects.toBeInstanceOf(RebootSendError);
    expect(h.client.postJson).not.toHaveBeenCalled();
  });

  it("close logs out only when signed in, and swallows a logout failure", async () => {
    const ops = gateOps(LOGIN);
    await ops.close();
    expect(h.client.delete).not.toHaveBeenCalled();
    h.client.get.mockResolvedValue(res(200, { results: {} }));
    await ops.haMode();
    h.client.delete.mockRejectedValue(new Error("gone"));
    await expect(ops.close()).resolves.toBeUndefined();
    expect(h.client.delete).toHaveBeenCalledWith("/api/v2/authentication", 5000);
  });
});

// ─── FortiManager proxy link ───────────────────────────────────────────────

describe("fmg-proxy link", () => {
  it("relays by the gate's FortiManager DEVICE NAME with the VDOM in the path", async () => {
    h.fmgProxyRest.mockResolvedValue({});
    const ops = gateOps(PROXY);
    expect(ops.label).toBe('FortiManager fmg.example.com proxy to device "HQ-FGT"');
    expect(await ops.rebootSelf("m")).toEqual({});
    expect(h.fmgProxyRest).toHaveBeenCalledWith(PROXY.kind === "fmg-proxy" ? PROXY.fmgConfig : null, "HQ-FGT", "POST",
      "/api/v2/monitor/system/os/reboot?vdom=root", { body: { event_log_message: "m" }, integrationId: "intg-1" });
  });

  it("cannot read the serial (the proxy does not relay the envelope)", async () => {
    expect(await gateOps(PROXY).serial()).toBeNull();
    expect(h.fmgProxyRest).not.toHaveBeenCalled();
  });

  it("reads through the proxy (GET, unwrapped)", async () => {
    h.fmgProxyRest.mockResolvedValue({ mode: "a-a" });
    expect(await gateOps(PROXY).haMode()).toBe("a-a");
    expect(h.fmgProxyRest.mock.calls[0].slice(1)).toEqual(["HQ-FGT", "GET", "/api/v2/cmdb/system/ha?vdom=root", { integrationId: "intg-1" }]);
  });

  it("a transport drop is a lost answer; any AppError FortiManager raises is a refusal", async () => {
    const ops = gateOps(PROXY);
    h.fmgProxyRest.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await ops.rebootSelf("m")).toEqual({ uncertain: "socket hang up" });
    h.fmgProxyRest.mockRejectedValueOnce(new AppError(502, "FortiManager proxy: Unexpected end of JSON input"));
    await expect(ops.rebootSelf("m")).rejects.toBeInstanceOf(RebootSendError);
    h.fmgProxyRest.mockRejectedValueOnce(new Error("device offline"));
    await expect(ops.rebootSelf("m")).rejects.toBeInstanceOf(RebootSendError);
  });
});

// ─── SSH link (FortiOS CLI) ────────────────────────────────────────────────

type ShellScript = (input: string, emit: (s: string) => void, close: () => void) => void;

/** A fake interactive FortiOS shell: prints a banner + prompt, then answers each write via `script`. */
function fakeShell(script: ShellScript, opts: { banner?: string; shellError?: Error } = {}) {
  const writes: string[] = [];
  h.withSshClient.mockImplementation(async (_host: string, _cfg: unknown, fn: (c: unknown) => Promise<unknown>) => fn({
    shell(_o: unknown, cb: (err: Error | undefined, stream: unknown) => void) {
      if (opts.shellError) return cb(opts.shellError, undefined);
      const stream = new EventEmitter() as EventEmitter & { write: (s: string) => void; end: () => void };
      let closed = false;
      const emit = (s: string) => process.nextTick(() => { if (!closed) stream.emit("data", Buffer.from(s)); });
      const close = () => process.nextTick(() => { if (!closed) { closed = true; stream.emit("close"); } });
      stream.write = (s: string) => { writes.push(s); script(s, emit, close); };
      stream.end = () => { /* the client ends it */ };
      cb(undefined, stream);
      emit(opts.banner ?? "\x1b[0mWelcome\r\nFGT-HQ # ");
    },
  }));
  return writes;
}

describe("ssh link", () => {
  it("labels itself with the SSH user", () => {
    expect(gateOps(SSH).label).toBe('SSH 10.0.0.3 as "admin"');
  });

  it("reads the serial from `get system status`, waiting for the prompt before typing", async () => {
    const writes = fakeShell((input, emit) => {
      if (input === "get system status\n") emit("get system status\r\nVersion: FortiGate-60F v7.6.7\r\nSerial-Number: FGT60F0000000001\r\nFGT-HQ # ");
    });
    expect(await gateOps(SSH).serial()).toBe("FGT60F0000000001");
    expect(writes).toEqual(["get system status\n"]);
  });

  it("pages through --More-- with a space", async () => {
    const writes = fakeShell((input, emit) => {
      if (input === "get system ha\n") emit("get system ha\r\ngroup-name : x\r\n--More-- ");
      else if (input === " ") emit("\r\nmode                : a-p\r\nFGT-HQ (global) # ");
    });
    expect(await gateOps(SSH).haMode()).toBe("a-p");
    expect(writes).toEqual(["get system ha\n", " "]);
  });

  it("reads the boot time from `get system performance status` Uptime", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-14T12:00:00Z"));
      fakeShell((input, emit) => { emit(`${input.trim()}\r\nUptime: 2 days,  3 hours,  4 minutes\r\nFGT-HQ # `); });
      expect(await gateOps(SSH).bootTime()).toEqual(new Date(Date.parse("2026-11-14T12:00:00Z") - ((2 * 86400) + (3 * 3600) + (4 * 60)) * 1000));
    } finally {
      vi.useRealTimers();
    }
  });

  it("null readings when the CLI prints nothing parseable, and no managed-device tables over SSH", async () => {
    fakeShell((input, emit) => { emit(`${input.trim()}\r\nnothing here\r\nFGT-HQ # `); });
    const ops = gateOps(SSH);
    expect(await ops.serial()).toBeNull();
    expect(await ops.haMode()).toBeNull();
    expect(await ops.bootTime()).toBeNull();
    expect(await ops.managedSwitches()).toBeNull();
    expect(await ops.managedAps()).toBeNull();
    await expect(ops.close()).resolves.toBeUndefined();
  });

  it("`execute reboot`: answers the (y/n) prompt once, and a session that then drops is a lost answer", async () => {
    const writes = fakeShell((input, emit, close) => {
      if (input === "execute reboot\n") emit("execute reboot\r\nThis operation will reboot the system !\r\nDo you want to continue? (y/n)");
      else if (input === "y") { emit("y\r\n"); close(); }
    });
    expect(await gateOps(SSH).rebootSelf("ignored over SSH")).toEqual({ uncertain: "the SSH session closed as the command ran" });
    expect(writes).toEqual(["execute reboot\n", "y"]);
  });

  it("restart commands carry the checked switch-id / AP serial", async () => {
    const writes = fakeShell((input, emit) => { if (input.endsWith("\n")) emit(`${input.trim()}\r\nFGT-HQ # `); });
    const ops = gateOps(SSH);
    expect(await ops.restartSwitch("Core-1")).toEqual({});
    expect(await ops.restartAp("FP231F0000000001")).toEqual({});
    expect(writes).toEqual([
      "execute switch-controller switch-action restart swtp Core-1\n",
      "execute wireless-controller reset-wtp FP231F0000000001\n",
    ]);
    await expect(asCall(() => ops.restartSwitch("Core-1; execute reboot"))).rejects.toBeInstanceOf(RebootSendError);
    expect(writes).toHaveLength(2);
  });

  it("a CLI error in the output is a refusal quoting it", async () => {
    fakeShell((input, emit) => { if (input.endsWith("\n")) emit(`${input.trim()}\r\nentry not found in datasource\r\nCommand fail. Return code -3\r\nFGT-HQ # `); });
    await expect(gateOps(SSH).restartSwitch("Core-9")).rejects.toThrow(/refused "execute switch-controller switch-action restart swtp Core-9": .*Command fail/);
  });

  it("a shell that cannot open, or an SSH connect failure, is a refusal", async () => {
    fakeShell(() => undefined, { shellError: new Error("shell refused") });
    await expect(gateOps(SSH).rebootSelf("m")).rejects.toThrow("shell refused");
    h.withSshClient.mockRejectedValue(new Error("All configured authentication methods failed"));
    const e = await gateOps(SSH).rebootSelf("m").catch((x) => x);
    expect(e).toBeInstanceOf(RebootSendError);
  });

  // Was a bug until 2026-11-14: sshOps.send / runFortiCli — a shell that CLOSES before its prompt ever
  // appeared (the command was never typed: `sent` is still false) resolves
  // `{ dropped: true }`, which send() reports as `{ uncertain: "the SSH session
  // closed as the command ran" }`. Nothing was sent, so the run watches for a
  // reboot that cannot come and ends unverified instead of failing with a
  // clear refusal. The contract: `{ uncertain }` is "the connection died
  // MID-SEND"; a session that never took the command is a RebootSendError —
  // as the same no-prompt case already is when it times out instead of closing.
  it("a shell that closes before the prompt (command never typed) is a refusal, not a lost answer", async () => {
    const writes: string[] = [];
    h.withSshClient.mockImplementationOnce(async (_h: string, _c: unknown, fn: (c: unknown) => Promise<unknown>) => fn({
      shell(_o: unknown, cb: (err: Error | undefined, stream: unknown) => void) {
        const stream = new EventEmitter() as EventEmitter & { write: (s: string) => void; end: () => void };
        stream.write = (s: string) => { writes.push(s); };
        stream.end = () => undefined;
        cb(undefined, stream);
        process.nextTick(() => { stream.emit("data", Buffer.from("This account has no shell access\r\n")); stream.emit("close"); });
      },
    }));
    const e = await gateOps(SSH).rebootSelf("m").catch((x) => x);
    expect(writes).toEqual([]);
    expect(e).toBeInstanceOf(RebootSendError);
  });

  describe("timeouts (fake timers)", () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
    afterEach(() => { vi.useRealTimers(); });

    it("a CLI that never answers a read rejects after 30 s", async () => {
      fakeShell(() => undefined);
      const p = gateOps(SSH).serial().catch((x) => x);
      await vi.advanceTimersByTimeAsync(30_000);
      const e = await p;
      expect(e.message).toMatch(/did not answer "get system status" within 30 s/);
    });

    it("a reboot answered 'y' whose session lingers is a lost answer after 20 s", async () => {
      fakeShell((input, emit) => { if (input === "execute reboot\n") emit("execute reboot\r\nDo you want to continue? (y/n)"); });
      const p = gateOps(SSH).rebootSelf("m");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await p).toEqual({ uncertain: "the SSH session closed as the command ran" });
    });

    it("a reboot command that was never confirmed and never answered is a refusal after 20 s", async () => {
      fakeShell(() => undefined);
      const p = gateOps(SSH).rebootSelf("m").catch((x) => x);
      await vi.advanceTimersByTimeAsync(20_000);
      const e = await p;
      expect(e).toBeInstanceOf(RebootSendError);
      expect(e.message).toMatch(/within 20 s/);
    });
  });
});

// ─── tcpUp ─────────────────────────────────────────────────────────────────

describe("tcpUp", () => {
  function fakeSocket() {
    const s = new EventEmitter() as EventEmitter & { destroy: () => void; setTimeout: (ms: number, cb: () => void) => void; destroyed: boolean; timeout?: number; onTimeout?: () => void };
    s.destroyed = false;
    s.destroy = () => { s.destroyed = true; };
    s.setTimeout = (ms, cb) => { s.timeout = ms; s.onTimeout = cb; };
    h.createConnection.mockReturnValue(s);
    return s;
  }

  it("true on connect, and the socket is closed", async () => {
    const s = fakeSocket();
    const p = tcpUp("10.0.0.1", 22);
    s.emit("connect");
    expect(await p).toBe(true);
    expect(s.destroyed).toBe(true);
    expect(h.createConnection).toHaveBeenCalledWith({ host: "10.0.0.1", port: 22 });
    expect(s.timeout).toBe(3000);
  });

  it("false on error and on timeout", async () => {
    let s = fakeSocket();
    let p = tcpUp("2001:db8::1", 22, 500);
    s.emit("error", new Error("ECONNREFUSED"));
    expect(await p).toBe(false);
    s = fakeSocket();
    p = tcpUp("10.0.0.1", 22, 500);
    expect(s.timeout).toBe(500);
    s.onTimeout!();
    expect(await p).toBe(false);
    expect(s.destroyed).toBe(true);
  });
});
