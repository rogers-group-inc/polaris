/**
 * tests/unit/serverTracerouteSequential.test.ts — the server's `traceroute`
 * runs with `-N 1` (one probe in flight: a burst is rate-limited by MPLS core
 * routers, which silenced whole stretches of a path), and a traceroute that
 * does not know `-N` (inetutils, busybox) is retried without it once, then
 * run without it for the life of the process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
vi.mock("node:dns/promises", () => ({ reverse: vi.fn(async () => []) }));

import { traceFromServer, _resetTracerCache } from "../../src/utils/serverTraceroute.js";

const O = { maxHops: 30, probesPerHop: 3, probeTimeoutMs: 1000, budgetMs: 30_000 };
const HOPS = " 1  10.0.0.1  1.0 ms  1.1 ms  1.2 ms\n 2  8.8.8.8  5.0 ms  5.1 ms  5.2 ms\n";

/** A fake child that prints `out` and exits. */
function child(out: string) {
  const c = new EventEmitter() as any;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = () => {};
  setImmediate(() => { c.stdout.emit("data", out); c.emit("close", 0); });
  return c;
}

const realPlatform = process.platform;
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux" });
  _resetTracerCache();
  spawn.mockReset();
});
afterEach(() => { Object.defineProperty(process, "platform", { value: realPlatform }); });

describe("server traceroute — one probe in flight", () => {
  it("asks traceroute for -N 1 and uses its hops", async () => {
    spawn.mockImplementation(() => child(HOPS));
    const r = await traceFromServer("8.8.8.8", O);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0]).toBe("traceroute");
    expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(["-N", "1"]));
    expect(r.complete).toBe(true);
  });

  it("retries without -N when that traceroute rejects it, and keeps it off afterwards", async () => {
    spawn.mockImplementation((_tool: string, args: string[]) =>
      child(args.includes("-N") ? "traceroute: invalid option -- 'N'\nUsage: traceroute [OPTION...] HOST\n" : HOPS));
    const first = await traceFromServer("8.8.8.8", O);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1][1]).not.toContain("-N");
    expect(first.complete).toBe(true);
    spawn.mockClear();
    await traceFromServer("8.8.8.8", O);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][1]).not.toContain("-N");
  });

  it("keeps -N when a retry without it finds nothing either (a target that is simply dark)", async () => {
    spawn.mockImplementation(() => child(""));
    await traceFromServer("8.8.8.8", O);
    spawn.mockClear();
    spawn.mockImplementation(() => child(HOPS));
    await traceFromServer("8.8.8.8", O);
    expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(["-N", "1"]));
  });
});
