/**
 * tests/unit/dependencyBlame.test.ts
 *
 * Business rule 78 — `blameFromGraph`, the pure core of "who silenced this
 * device". Same inputs as `evaluateSuppression` plus the hostname, so the
 * fixtures read like the suppression ones: `upstream` is the device directly
 * above, `rootCause` the one down in its own right, and the walk carries on
 * while the blamed node is blamed only for being suppressed itself.
 */

import { describe, it, expect } from "vitest";
import { blameFromGraph, BLAME_MAX_HOPS, type BlameNodeState } from "../../src/services/dependencyTreeService.js";

function st(id: string, layer: number | null, monitorStatus: string | null, over: Partial<BlameNodeState> = {}): BlameNodeState {
  return { id, hostname: id.toUpperCase(), layer, monitorStatus, monitored: true, currentlySuppressed: false, ...over };
}
const parents = (m: Record<string, string[]>) => new Map(Object.entries(m));
const NOW = Date.parse("2026-09-21T12:00:00Z");

describe("blameFromGraph", () => {
  it("one hop: the switch is down, so the switch is upstream AND root cause", () => {
    const states = [st("sw", 2, "down"), st("plc", 3, "warning", { currentlySuppressed: true })];
    const b = blameFromGraph(states, parents({ plc: ["sw"] }), "plc", NOW)!;
    expect(b.upstream).toEqual({ id: "sw", hostname: "SW", reason: "down" });
    expect(b.rootCause).toEqual(b.upstream);
    expect(b.hops).toBe(1);
    expect(b.truncated).toBe(false);
  });

  it("two hops: a suppressed switch under a dark gate names the gate as root cause", () => {
    // The switch's own probe reads down too (it is behind the gate), but it is
    // blamed as `suppressed` so the walk goes on to the device actually dark.
    const states = [
      st("fg", 1, "down"),
      st("sw", 2, "down", { currentlySuppressed: true }),
      st("plc", 3, "down", { currentlySuppressed: true }),
    ];
    const b = blameFromGraph(states, parents({ plc: ["sw"], sw: ["fg"] }), "plc", NOW)!;
    expect(b.upstream.id).toBe("sw");
    expect(b.upstream.reason).toBe("suppressed");
    expect(b.rootCause).toEqual({ id: "fg", hostname: "FG", reason: "down" });
    expect(b.chain.map((n) => n.id)).toEqual(["sw", "fg"]);
    expect(b.hops).toBe(2);
  });

  it("a parent in a maintenance window is the root cause, and says so", () => {
    const states = [st("sw", 2, "up", { status: "maintenance" }), st("plc", 3, "down", { currentlySuppressed: true })];
    const b = blameFromGraph(states, parents({ plc: ["sw"] }), "plc", NOW)!;
    expect(b.rootCause.reason).toBe("maintenance");
  });

  it("a maintenance parent whose schedule opted OUT of suppressing children is not blamed", () => {
    const states = [
      st("sw", 2, "up", { status: "maintenance", maintenanceSuppressChildren: false }),
      st("plc", 3, "down", { currentlySuppressed: true }),
    ];
    expect(blameFromGraph(states, parents({ plc: ["sw"] }), "plc", NOW)).toBeNull();
  });

  it("a Dependency Test overlay is the root cause while it runs", () => {
    const states = [
      st("sw", 2, "up", { dependencyTestUntil: new Date(NOW + 60_000) }),
      st("plc", 3, "up", { currentlySuppressed: true }),
    ];
    expect(blameFromGraph(states, parents({ plc: ["sw"] }), "plc", NOW)!.rootCause.reason).toBe("dependency_test");
    // Expired: nobody to blame.
    const expired = [st("sw", 2, "up", { dependencyTestUntil: new Date(NOW - 1) }), states[1]!];
    expect(blameFromGraph(expired, parents({ plc: ["sw"] }), "plc", NOW)).toBeNull();
  });

  it("walks THROUGH an unmonitored parent to the monitored one that is down", () => {
    const states = [
      st("fg", 1, "down"),
      st("hub", 2, null, { monitored: false }),
      st("plc", 3, "down", { currentlySuppressed: true }),
    ];
    const b = blameFromGraph(states, parents({ plc: ["hub"], hub: ["fg"] }), "plc", NOW)!;
    expect(b.upstream.id).toBe("fg");
    expect(b.hops).toBe(1);
  });

  it("an unmonitored HA standby is ignored, not blamed and not walked", () => {
    const states = [
      st("fg1", 1, "down"),
      st("fg2", 1, null, { monitored: false, isHaStandby: true }),
      st("sw", 2, "down", { currentlySuppressed: true }),
    ];
    const b = blameFromGraph(states, parents({ sw: ["fg1", "fg2"] }), "sw", NOW)!;
    expect(b.upstream.id).toBe("fg1");
  });

  it("redundant parents: only the blamed one is named", () => {
    const states = [
      st("fg1", 1, "down"),
      st("fg2", 1, "up"),
      st("sw", 2, "down"),
    ];
    // Not actually suppressed (all-down fails), but the caller may still ask.
    const b = blameFromGraph(states, parents({ sw: ["fg1", "fg2"] }), "sw", NOW)!;
    expect(b.upstream.id).toBe("fg1");
  });

  it("among several blamed parents a definitive reason outranks `suppressed`, then hostname decides", () => {
    const states = [
      st("z-sw", 2, "down", { currentlySuppressed: true }),
      st("a-fg", 1, "down"),
      st("m-fg", 1, "down"),
      st("plc", 3, "down", { currentlySuppressed: true }),
    ];
    const b = blameFromGraph(states, parents({ plc: ["z-sw", "m-fg", "a-fg"] }), "plc", NOW)!;
    expect(b.upstream.id).toBe("a-fg");
  });

  it("returns null when nothing above the asset is blamed, or it has no parents", () => {
    expect(blameFromGraph([st("sw", 2, "up"), st("plc", 3, "down")], parents({ plc: ["sw"] }), "plc", NOW)).toBeNull();
    expect(blameFromGraph([st("plc", null, "down")], new Map(), "plc", NOW)).toBeNull();
  });

  it("a suppressed parent with nothing blamed above it is named as far as the walk got", () => {
    // A stale flag: the switch still reads suppressed but its gate is back.
    const states = [st("fg", 1, "up"), st("sw", 2, "down", { currentlySuppressed: true }), st("plc", 3, "down", { currentlySuppressed: true })];
    const b = blameFromGraph(states, parents({ plc: ["sw"], sw: ["fg"] }), "plc", NOW)!;
    expect(b.upstream.id).toBe("sw");
    expect(b.rootCause.id).toBe("sw");
    expect(b.rootCause.reason).toBe("suppressed");
    expect(b.truncated).toBe(false);
  });

  it("stops on a cycle and at the hop cap, marking the result truncated", () => {
    const cyc = [
      st("a", 2, "down", { currentlySuppressed: true }),
      st("b", 2, "down", { currentlySuppressed: true }),
      st("plc", 3, "down", { currentlySuppressed: true }),
    ];
    const c = blameFromGraph(cyc, parents({ plc: ["a"], a: ["b"], b: ["a"] }), "plc", NOW)!;
    expect(c.truncated).toBe(true);
    expect(c.chain.length).toBeLessThanOrEqual(BLAME_MAX_HOPS);

    // A chain longer than the cap, every link suppressed.
    const long: BlameNodeState[] = [st("plc", 99, "down", { currentlySuppressed: true })];
    const edges: Record<string, string[]> = { plc: ["n0"] };
    for (let i = 0; i < BLAME_MAX_HOPS + 5; i++) {
      long.push(st(`n${i}`, 50 - i, "down", { currentlySuppressed: true }));
      edges[`n${i}`] = [`n${i + 1}`];
    }
    const l = blameFromGraph(long, parents(edges), "plc", NOW)!;
    expect(l.truncated).toBe(true);
    expect(l.hops).toBe(BLAME_MAX_HOPS);
  });
});
