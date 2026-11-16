/**
 * tests/unit/ipv6GateService.test.ts — the stateful half of business rule 128:
 * the per-process cache behind ipv6Enabled() / ipv6Dialable(), getIpv6Status,
 * the install-time decision and the operator toggle (with their Events), and
 * the UDP route check.
 *
 * The pure helpers (routableHostIpv6, decideIpv6Enabled, parseIpv6Config …)
 * are pinned by tests/unit/ipv6Gate.test.ts.
 *
 * node:os.networkInterfaces and node:dgram.createSocket are replaced, so no
 * socket is ever opened. Date is faked (timers stay real) so the store's 30 s
 * TTL and the gate's 60 s refresh can be crossed on demand.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const h = vi.hoisted(() => ({
  ifaces: {} as Record<string, unknown[]>,
  sockMode: "ok" as "ok" | "error" | "hang" | "throw-create" | "throw-connect",
  sockets: [] as Array<{ close: ReturnType<typeof vi.fn>; connectArgs: unknown[] }>,
}));

vi.mock("node:os", async (orig) => {
  const real = await orig<typeof import("node:os")>();
  return { ...real, networkInterfaces: vi.fn(() => h.ifaces) };
});

vi.mock("node:dgram", async (orig) => {
  const real = await orig<typeof import("node:dgram")>();
  const { EventEmitter: EE } = await import("node:events");
  return {
    ...real,
    createSocket: vi.fn(() => {
      if (h.sockMode === "throw-create") throw new Error("udp6 unsupported");
      const s = new EE() as EventEmitter & { close: ReturnType<typeof vi.fn>; connect: (...a: unknown[]) => void; connectArgs: unknown[] };
      s.close = vi.fn();
      s.connectArgs = [];
      s.connect = (...args: unknown[]) => {
        s.connectArgs = args;
        if (h.sockMode === "throw-connect") throw new Error("EINVAL");
        const cb = args[2] as () => void;
        if (h.sockMode === "ok") queueMicrotask(cb);
        if (h.sockMode === "error") queueMicrotask(() => s.emit("error", new Error("ENETUNREACH")));
      };
      h.sockets.push(s);
      return s;
    }),
  };
});

vi.mock("../../src/utils/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import {
  getIpv6Status,
  ipv6Enabled,
  ipv6Dialable,
  initializeIpv6Setting,
  setIpv6Enabled,
  hasIpv6Route,
  _resetIpv6GateForTests,
} from "../../src/services/ipv6GateService.js";

const nic = (address: string, family: "IPv4" | "IPv6", internal = false) =>
  ({ address, family, internal, netmask: "", mac: "00:00:00:00:00:00", cidr: null, scopeid: 0 });

const V6_HOST = { lo: [nic("::1", "IPv6", true)], eth0: [nic("10.0.0.5", "IPv4"), nic("2001:db8::5", "IPv6")] };
const V4_HOST = { lo: [nic("::1", "IPv6", true)], eth0: [nic("10.0.0.5", "IPv4"), nic("fe80::1%eth0", "IPv6")] };

let now = new Date("2026-11-16T00:00:00Z").getTime();
function advance(ms: number): void {
  now += ms;
  vi.setSystemTime(now);
}
function stored(value: unknown): void {
  stubbed(prisma.setting.findUnique).mockResolvedValue(value === null ? null : { key: "ipv6Config", value });
}
/** Let a background refresh (store read + route check) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(async () => {
  resetDbStub();
  resetEventLogStub();
  h.ifaces = V4_HOST;
  h.sockMode = "ok";
  h.sockets = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  advance(3_600_000);
  stored(null);
  await flush(); // drain any refresh a previous test left running
  _resetIpv6GateForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("hasIpv6Route", () => {
  it("is true when the kernel picks a route, and asks it about 2000::1 without sending", async () => {
    expect(await hasIpv6Route()).toBe(true);
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0].connectArgs.slice(0, 2)).toEqual([9, "2000::1"]);
    expect(h.sockets[0].close).toHaveBeenCalledTimes(1);
  });

  it("is false on a socket error (no route)", async () => {
    h.sockMode = "error";
    expect(await hasIpv6Route()).toBe(false);
    expect(h.sockets[0].close).toHaveBeenCalledTimes(1);
  });

  it("is false when a udp6 socket cannot be created", async () => {
    h.sockMode = "throw-create";
    expect(await hasIpv6Route()).toBe(false);
  });

  it("is false when connect throws synchronously", async () => {
    h.sockMode = "throw-connect";
    expect(await hasIpv6Route()).toBe(false);
    expect(h.sockets[0].close).toHaveBeenCalledTimes(1);
  });

  it("is false after the timeout when the kernel never answers", async () => {
    h.sockMode = "hang";
    expect(await hasIpv6Route(5)).toBe(false);
    expect(h.sockets[0].close).toHaveBeenCalledTimes(1);
  });
});

describe("getIpv6Status", () => {
  it("undecided (no row) follows the host: on with a routable address", async () => {
    h.ifaces = V6_HOST;
    expect(await getIpv6Status()).toEqual({
      enabled: true, setBy: null, installHostAddresses: [], hostAddresses: ["2001:db8::5"], hasRoute: true, dialable: true,
    });
  });

  it("undecided on an IPv4-only host is off and never dialable, even with a route", async () => {
    const s = await getIpv6Status();
    expect(s).toMatchObject({ enabled: false, hostAddresses: [], hasRoute: true, dialable: false });
  });

  it("a stored decision wins over the host", async () => {
    h.ifaces = V6_HOST;
    stored({ enabled: false, setBy: "operator", installHostAddresses: ["2001:db8::9"] });
    expect(await getIpv6Status()).toMatchObject({ enabled: false, setBy: "operator", installHostAddresses: ["2001:db8::9"], dialable: false });
  });

  it("on without a routable address is dialable through a route alone", async () => {
    stored({ enabled: true, setBy: "operator" });
    expect(await getIpv6Status()).toMatchObject({ enabled: true, hostAddresses: [], hasRoute: true, dialable: true });
  });

  it("on with neither an address nor a route is on but NOT dialable", async () => {
    h.sockMode = "error";
    stored({ enabled: true, setBy: "operator" });
    expect(await getIpv6Status()).toMatchObject({ enabled: true, hasRoute: false, dialable: false });
  });

  it("a settings outage keeps the last DECIDED answer rather than flipping to host detection", async () => {
    h.ifaces = V6_HOST;
    stored({ enabled: false, setBy: "operator" });
    expect((await getIpv6Status()).enabled).toBe(false);
    advance(31_000); // past the store TTL
    stubbed(prisma.setting.findUnique).mockRejectedValue(new Error("db down"));
    expect(await getIpv6Status()).toMatchObject({ enabled: false, setBy: "operator" });
  });

  it("a settings outage while still undecided answers host detection", async () => {
    h.ifaces = V6_HOST;
    await getIpv6Status();
    advance(31_000);
    stubbed(prisma.setting.findUnique).mockRejectedValue(new Error("db down"));
    expect(await getIpv6Status()).toMatchObject({ enabled: true, setBy: null });
  });

  it("a settings outage with no prior answer answers host detection", async () => {
    stubbed(prisma.setting.findUnique).mockRejectedValue(new Error("db down"));
    expect(await getIpv6Status()).toMatchObject({ enabled: false, setBy: null, installHostAddresses: [] });
  });
});

describe("ipv6Enabled / ipv6Dialable (synchronous cache)", () => {
  it("before the first refresh answers host detection, then the stored switch once the refresh lands", async () => {
    h.ifaces = V6_HOST;
    stored({ enabled: false, setBy: "operator" });
    expect(ipv6Enabled()).toBe(true);
    expect(ipv6Dialable()).toBe(true);
    await flush();
    expect(ipv6Enabled()).toBe(false);
    expect(ipv6Dialable()).toBe(false);
  });

  it("before the first refresh is not dialable on a host without a routable address (route check is async)", () => {
    stored({ enabled: true, setBy: "operator" });
    expect(ipv6Dialable()).toBe(false);
  });

  it("does not refresh again within 60 s, and refreshes in the background after", async () => {
    stored({ enabled: true, setBy: "operator" });
    await getIpv6Status();
    const sockets = h.sockets.length;
    advance(59_000);
    expect(ipv6Enabled()).toBe(true);
    await flush();
    expect(h.sockets.length).toBe(sockets);

    advance(2_000);
    stored({ enabled: false, setBy: "operator" });
    // A stale cache answers its last value at once…
    expect(ipv6Enabled()).toBe(true);
    await flush();
    // …and the background refresh brings the new one.
    expect(h.sockets.length).toBe(sockets + 1);
    expect(ipv6Enabled()).toBe(false);
  });

  it("starts only one refresh for many stale reads", async () => {
    await getIpv6Status();
    const sockets = h.sockets.length;
    advance(61_000);
    for (let i = 0; i < 10; i++) ipv6Enabled();
    await flush();
    expect(h.sockets.length).toBe(sockets + 1);
  });
});

describe("initializeIpv6Setting", () => {
  it("on a host with a routable IPv6 switches ON, records the addresses, and audits", async () => {
    h.ifaces = V6_HOST;
    expect(await initializeIpv6Setting()).toEqual({ initialized: true, enabled: true });
    expect(prisma.setting.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: "ipv6Config" },
      update: { value: { enabled: true, setBy: "install", installHostAddresses: ["2001:db8::5"] } },
    }));
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "settings.ipv6.initialized",
      resourceType: "setting",
      resourceId: "ipv6Config",
      actor: "system",
      level: "info",
      message: expect.stringContaining("2001:db8::5"),
      details: { enabled: true, hostAddresses: ["2001:db8::5"] },
    });
    // The cache is refreshed so this process answers the decision at once.
    expect(ipv6Enabled()).toBe(true);
  });

  it("on an IPv4-only host switches OFF and says how to turn it on", async () => {
    expect(await initializeIpv6Setting()).toEqual({ initialized: true, enabled: false });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "settings.ipv6.initialized",
      message: expect.stringMatching(/OFF at install/),
      details: { enabled: false, hostAddresses: [] },
    });
  });

  it("never overwrites a decision already made (by an operator or an earlier boot)", async () => {
    h.ifaces = V6_HOST;
    stored({ enabled: false, setBy: "operator" });
    expect(await initializeIpv6Setting()).toEqual({ initialized: false, enabled: false });
    expect(prisma.setting.upsert).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("treats a pre-release { mode: 'on' } row as decided, and { mode: 'auto' } as undecided", async () => {
    stored({ mode: "on" });
    expect(await initializeIpv6Setting()).toEqual({ initialized: false, enabled: true });
    stored({ mode: "auto" });
    expect(await initializeIpv6Setting()).toEqual({ initialized: true, enabled: false });
  });

  it("reads the row fresh, not a value cached before another role decided", async () => {
    await getIpv6Status(); // caches "no row" in the store
    stored({ enabled: true, setBy: "operator" });
    expect(await initializeIpv6Setting()).toEqual({ initialized: false, enabled: true });
    expect(prisma.setting.upsert).not.toHaveBeenCalled();
  });
});

describe("setIpv6Enabled", () => {
  it("switches off, keeps the install-time addresses, and audits the change with the old value", async () => {
    h.ifaces = V6_HOST;
    stored({ enabled: true, setBy: "install", installHostAddresses: ["2001:db8::5"] });
    const after = await setIpv6Enabled(false, "alice");
    expect(after).toMatchObject({ enabled: false, setBy: "operator", installHostAddresses: ["2001:db8::5"], dialable: false });
    expect(stubbed(prisma.setting.upsert).mock.calls[0][0].update.value).toEqual({
      enabled: false, setBy: "operator", installHostAddresses: ["2001:db8::5"],
    });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "settings.ipv6.updated",
      resourceType: "setting",
      resourceId: "ipv6Config",
      actor: "alice",
      level: "info",
      message: "IPv6 switched OFF (was on)",
      details: { enabled: false, previous: true, dialable: false },
    });
    expect(ipv6Enabled()).toBe(false);
  });

  it("names no previous value when it did not change", async () => {
    stored({ enabled: true, setBy: "operator" });
    await setIpv6Enabled(true, "bob");
    expect(eventLog.logEvent.mock.calls[0][0].message).toBe("IPv6 switched ON");
  });

  it("warns in the Event when on but this server cannot reach IPv6", async () => {
    h.sockMode = "error";
    stored({ enabled: false, setBy: "install" });
    const after = await setIpv6Enabled(true, "carol");
    expect(after).toMatchObject({ enabled: true, dialable: false, hasRoute: false });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      message: expect.stringMatching(/^IPv6 switched ON \(was off\) — this server cannot reach IPv6/),
      details: { enabled: true, previous: false, dialable: false, hasRoute: false, hostAddresses: [] },
    });
  });

  it("propagates a failed write and writes no Event", async () => {
    stubbed(prisma.setting.upsert).mockRejectedValue(new Error("write failed"));
    await expect(setIpv6Enabled(true, "dave")).rejects.toThrow("write failed");
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});
