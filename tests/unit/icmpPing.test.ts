/**
 * tests/unit/icmpPing.test.ts
 *
 * The system-`ping` wrappers, with child_process.spawn replaced by a fake
 * child so no process is started. burstPing.test.ts covers parsePingSummary's
 * wording; this pins the argv per platform, the exit/close/error/timeout
 * handling, and the "spawn failure is NOT loss" contract of burstPingHost.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

const cp = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: cp.spawn }));

import { pingHost, burstPingHost, parsePingSummary } from "../../src/utils/icmpPing.js";

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

let child: FakeChild;
beforeEach(() => {
  child = new FakeChild();
  cp.spawn.mockReset();
  cp.spawn.mockImplementation(() => child);
});
afterEach(() => {
  setPlatform(realPlatform);
  vi.useRealTimers();
});

describe("pingHost", () => {
  it("sends one echo with a seconds timeout on POSIX", async () => {
    setPlatform("linux");
    const p = pingHost("10.0.0.1", 1500);
    expect(cp.spawn).toHaveBeenCalledWith("ping", ["-c", "1", "-W", "2", "10.0.0.1"], { stdio: ["ignore", "pipe", "pipe"] });
    child.emit("close", 0);
    await expect(p).resolves.toEqual({ success: true });
  });

  it("uses -n / -w milliseconds on Windows", async () => {
    setPlatform("win32");
    const p = pingHost("h", 1500);
    expect(cp.spawn.mock.calls[0][1]).toEqual(["-n", "1", "-w", "1500", "h"]);
    child.emit("close", 0);
    await p;
  });

  it("reports a non-zero exit as a failure naming the code", async () => {
    const p = pingHost("h", 1000);
    child.emit("close", 1);
    await expect(p).resolves.toEqual({ success: false, error: "ping exit 1" });
  });

  it("reports a spawn error event, and ignores a later close", async () => {
    const p = pingHost("h", 1000);
    child.emit("error", new Error("spawn ping ENOENT"));
    child.emit("close", 0);
    await expect(p).resolves.toEqual({ success: false, error: "spawn ping ENOENT" });
  });

  it("resolves (never rejects) when spawn throws synchronously (EPERM)", async () => {
    cp.spawn.mockImplementation(() => { throw new Error("spawn EPERM"); });
    await expect(pingHost("h", 1000)).resolves.toEqual({ success: false, error: "spawn EPERM" });
  });

  it("kills a wedged ping after timeout + 2 s", async () => {
    vi.useFakeTimers();
    const p = pingHost("h", 1000);
    vi.advanceTimersByTime(2_999);
    expect(child.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await expect(p).resolves.toEqual({ success: false, error: "ping timed out" });
    expect(child.kill).toHaveBeenCalled();
  });
});

describe("burstPingHost", () => {
  it("builds the POSIX argv with interval floor 0.2 s and quiet mode", async () => {
    setPlatform("linux");
    const p = burstPingHost("h", { count: 5, intervalMs: 50, timeoutMs: 900 });
    expect(cp.spawn.mock.calls[0][1]).toEqual(["-c", "5", "-i", "0.2", "-W", "1", "-q", "h"]);
    child.emit("close", 1);
    await p;
  });

  it("builds the Windows argv without an interval", async () => {
    setPlatform("win32");
    const p = burstPingHost("h", { count: 3, intervalMs: 500, timeoutMs: 700 });
    expect(cp.spawn.mock.calls[0][1]).toEqual(["-n", "3", "-w", "700", "h"]);
    child.emit("close", 0);
    await p;
  });

  it("parses stdout + stderr on close, ignoring the exit code", async () => {
    const p = burstPingHost("h", { count: 5, intervalMs: 200, timeoutMs: 1000 });
    child.stdout.emit("data", Buffer.from("5 packets transmitted, 3 received, 40% packet loss\n"));
    child.stderr.emit("data", Buffer.from("rtt min/avg/max/mdev = 1.0/2.5/4.0/0.3 ms\n"));
    child.emit("close", 1);
    await expect(p).resolves.toEqual({ sent: 5, received: 3, avgRttMs: 2.5 });
  });

  it("a spawn error is 'nothing sent', not 100% loss", async () => {
    const p = burstPingHost("h", { count: 5, intervalMs: 200, timeoutMs: 1000 });
    child.emit("error", new Error("ENOENT"));
    await expect(p).resolves.toEqual({ sent: 0, received: 0, avgRttMs: null });
  });

  it("a synchronous spawn throw is also 'nothing sent'", async () => {
    cp.spawn.mockImplementation(() => { throw new Error("EPERM"); });
    await expect(burstPingHost("h", { count: 5, intervalMs: 200, timeoutMs: 1000 })).resolves.toEqual({ sent: 0, received: 0, avgRttMs: null });
  });

  it("SIGKILLs at count × pace + timeout + 3 s and parses what it had (silent → all lost)", async () => {
    setPlatform("linux");
    vi.useFakeTimers();
    const p = burstPingHost("h", { count: 4, intervalMs: 500, timeoutMs: 1000 });
    vi.advanceTimersByTime(4 * 500 + 1000 + 3000 - 1);
    expect(child.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(p).resolves.toEqual({ sent: 4, received: 0, avgRttMs: null });
  });

  it("paces the Windows ceiling at 1 s per echo whatever interval was asked", async () => {
    setPlatform("win32");
    vi.useFakeTimers();
    const p = burstPingHost("h", { count: 2, intervalMs: 200, timeoutMs: 500 });
    vi.advanceTimersByTime(2 * 1000 + 500 + 3000 - 1);
    expect(child.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await p;
  });
});

describe("parsePingSummary guards", () => {
  it("clamps received to sent and ignores a zero transmitted count", () => {
    expect(parsePingSummary("3 packets transmitted, 9 received", 3)).toEqual({ sent: 3, received: 3, avgRttMs: null });
    expect(parsePingSummary("0 packets transmitted, 0 received", 5)).toEqual({ sent: 5, received: 0, avgRttMs: null });
  });

  it("reads the Windows Average when there were replies", () => {
    expect(parsePingSummary("Packets: Sent = 2, Received = 2, Lost = 0\nMinimum = 1ms, Maximum = 3ms, Average = 2ms", 2))
      .toEqual({ sent: 2, received: 2, avgRttMs: 2 });
  });
});
