/**
 * tests/unit/serverTraceroute.test.ts — the three system-tracer parsers the
 * Polaris server's path-check source reads (traceroute / tracepath / tracert)
 * and the hop assembly that turns any of them into the agent's wire shape. A
 * wrong parse reads as "the path changed", so each format is pinned here.
 */

import { describe, it, expect } from "vitest";
import {
  parseTraceroute,
  parseTracepath,
  parseTracert,
  assembleTrace,
  tracerArgs,
  SILENT_HOP_LIMIT,
} from "../../src/utils/serverTraceroute.js";

const O = { maxHops: 30, probesPerHop: 3, probeTimeoutMs: 1000, budgetMs: 30_000 };

describe("parseTraceroute (traceroute -n)", () => {
  const out = [
    "traceroute to 8.8.8.8 (8.8.8.8), 30 hops max, 60 byte packets",
    " 1  192.168.1.1  0.512 ms  0.401 ms  0.388 ms",
    " 2  * * *",
    " 3  10.0.0.1  1.2 ms 10.0.0.2  1.3 ms *",
    " 4  8.8.8.8  9.9 ms  10.1 ms  10.0 ms",
  ].join("\n");
  it("reads each TTL's first responder and one RTT per probe (-1 = no reply)", () => {
    const hops = parseTraceroute(out);
    expect(hops.map((h) => h.ttl)).toEqual([1, 2, 3, 4]);
    expect(hops[0]).toMatchObject({ ip: "192.168.1.1", rttMs: [0.512, 0.401, 0.388] });
    expect(hops[1]).toMatchObject({ ip: null, rttMs: [-1, -1, -1] });
    expect(hops[2]).toMatchObject({ ip: "10.0.0.1", rttMs: [1.2, 1.3, -1] });
  });
  it("treats a !-annotation as the end of the path", () => {
    const [h] = parseTraceroute(" 9  10.9.9.9  3.1 ms !H  3.0 ms !H  *");
    expect(h).toMatchObject({ ip: "10.9.9.9", stop: true, rttMs: [3.1, 3.0, -1] });
  });
});

describe("parseTracepath (tracepath -n)", () => {
  const out = [
    " 1?: [LOCALHOST]                      pmtu 1500",
    " 1:  192.168.1.1                      0.512ms",
    " 1:  192.168.1.1                      0.401ms",
    " 2:  no reply",
    " 3:  8.8.8.8                          10.1ms reached",
    "     Resume: pmtu 1500 hops 3 back 3",
  ].join("\n");
  it("folds repeated TTL lines into one hop and skips LOCALHOST", () => {
    const hops = parseTracepath(out);
    expect(hops.map((h) => h.ttl)).toEqual([1, 2, 3]);
    expect(hops[0]).toMatchObject({ ip: "192.168.1.1", rttMs: [0.512, 0.401] });
    expect(hops[1]).toMatchObject({ ip: null, rttMs: [-1] });
    expect(hops[2]).toMatchObject({ ip: "8.8.8.8", rttMs: [10.1] });
  });
});

describe("parseTracert (Windows tracert -d)", () => {
  const out = [
    "Tracing route to 8.8.8.8 over a maximum of 30 hops",
    "",
    "  1    <1 ms    <1 ms    <1 ms  192.168.1.1",
    "  2     *        *        *     Request timed out.",
    "  3    12 ms    11 ms    12 ms  8.8.8.8",
    "",
    "Trace complete.",
  ].join("\r\n");
  it("reads <1 ms as a sub-millisecond reply and the trailing address as the hop", () => {
    const hops = parseTracert(out);
    expect(hops.map((h) => h.ttl)).toEqual([1, 2, 3]);
    expect(hops[0]).toMatchObject({ ip: "192.168.1.1", rttMs: [0.5, 0.5, 0.5] });
    expect(hops[1]).toMatchObject({ ip: null, rttMs: [-1, -1, -1] });
    expect(hops[2]).toMatchObject({ ip: "8.8.8.8", rttMs: [12, 11, 12] });
  });
  it("stops at a 'reports: Destination host unreachable' hop", () => {
    const [h] = parseTracert("  4  10.0.0.1  reports: Destination host unreachable.");
    expect(h).toMatchObject({ ip: "10.0.0.1", stop: true });
  });
});

describe("assembleTrace", () => {
  it("fills gaps, pads each hop to probesPerHop, and marks the trace complete at the destination", () => {
    const r = assembleTrace([
      { ttl: 1, ip: "10.0.0.1", rttMs: [1], stop: false },
      { ttl: 3, ip: "8.8.8.8", rttMs: [9, 9, 9], stop: false },
      { ttl: 4, ip: "8.8.8.8", rttMs: [9], stop: false },
    ], "8.8.8.8", O);
    expect(r.complete).toBe(true);
    expect(r.hops).toEqual([
      { ttl: 1, ip: "10.0.0.1", rttMs: [1, -1, -1] },
      { ttl: 2, ip: null, rttMs: [-1, -1, -1] },
      { ttl: 3, ip: "8.8.8.8", rttMs: [9, 9, 9] },
    ]);
  });
  it("drops trailing silent hops of an incomplete trace", () => {
    const r = assembleTrace([
      { ttl: 1, ip: "10.0.0.1", rttMs: [1, 1, 1], stop: false },
      { ttl: 2, ip: null, rttMs: [-1, -1, -1], stop: false },
      { ttl: 3, ip: null, rttMs: [-1, -1, -1], stop: false },
    ], "8.8.8.8", O);
    expect(r.complete).toBe(false);
    expect(r.hops.map((h) => h.ttl)).toEqual([1]);
  });
  it("gives up after the silent-hop limit and at a stop hop", () => {
    const raw = Array.from({ length: 20 }, (_, i) => ({ ttl: i + 1, ip: i === 0 ? "10.0.0.1" : null, rttMs: [], stop: false }));
    raw.push({ ttl: 21, ip: "8.8.8.8", rttMs: [1], stop: false });
    const r = assembleTrace(raw, "8.8.8.8", O);
    expect(r.complete).toBe(false);
    expect(r.hops.length).toBeLessThanOrEqual(1 + SILENT_HOP_LIMIT);
    const stopped = assembleTrace([
      { ttl: 1, ip: "10.0.0.1", rttMs: [1], stop: true },
      { ttl: 2, ip: "8.8.8.8", rttMs: [1], stop: false },
    ], "8.8.8.8", O);
    expect(stopped.hops.map((h) => h.ttl)).toEqual([1]);
    expect(stopped.complete).toBe(false);
  });
  it("never goes past maxHops", () => {
    const raw = Array.from({ length: 10 }, (_, i) => ({ ttl: i + 1, ip: `10.0.0.${i + 1}`, rttMs: [1], stop: false }));
    expect(assembleTrace(raw, "8.8.8.8", { ...O, maxHops: 4 }).hops).toHaveLength(4);
  });
});

describe("tracerArgs", () => {
  it("passes numeric output, hop cap, probes and wait to each tool", () => {
    expect(tracerArgs("traceroute", "8.8.8.8", O)).toEqual(["-n", "-q", "3", "-w", "1", "-m", "30", "8.8.8.8"]);
    expect(tracerArgs("tracepath", "8.8.8.8", O)).toEqual(["-n", "-m", "30", "8.8.8.8"]);
    expect(tracerArgs("tracert", "8.8.8.8", O)).toEqual(["-d", "-h", "30", "-w", "1000", "8.8.8.8"]);
  });
  it("rounds a sub-second probe wait up to traceroute's 1 s floor", () => {
    expect(tracerArgs("traceroute", "8.8.8.8", { ...O, probeTimeoutMs: 300 })).toContain("1");
  });
});
