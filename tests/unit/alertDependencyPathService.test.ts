/**
 * tests/unit/alertDependencyPathService.test.ts — own suite for
 * alertDependencyPathService (CQ-T010, business rule 78).
 *
 * Complements, does not repeat:
 *   - alertDependencyPath.test.ts — the main contracts: entry building, location
 *     boxes, ports, SVG / text rendering, loadDependencyPath, the token, the
 *     all-clear state colours
 *   - alertDependencyPathTree.test.ts — codes resolved through the region tree
 *   - alertDependencyPathDelivery.test.ts — the token in the delivery drain
 *
 * The edges those leave open:
 *   - nowStateOf's full precedence table (passive / pending / null read as
 *     unknown, never as up);
 *   - pathEntriesFromBlame: a chain with one unreadable node falls back to the
 *     named ends, an unknown reason takes the fallback role, hops is floored
 *     and a non-number reads as 1, a non-object snapshot is nothing;
 *   - innerBoxOf: rack sits between room and junction box, a blank Location
 *     falls to the fixed label, the generic key is case-blind;
 *   - runsOf: a key that recurs after a different one is a new run;
 *   - fitLabel's floor and its three-character minimum;
 *   - portFacing / lastSeenSwitchPort edges (a synthetic own row falls through
 *     to the peer's, a trailing-slash value, a switch name with a slash);
 *   - dependencyPathText for an unnamed device and the dependency-test role;
 *   - renderDependencyPathBlocks: the truncated note is dropped on an all-clear;
 *   - substituteDependencyPathTokens never interprets "$" in the block.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import {
  nowStateOf,
  pathEntriesFromBlame,
  innerBoxOf,
  runsOf,
  fitLabel,
  portFacing,
  lastSeenSwitchPort,
  dependencyPathText,
  renderDependencyPathBlocks,
  dependencyPathTokensIn,
  substituteDependencyPathTokens,
  NO_LOCATION_LABEL,
  MAX_PATH_DEVICES,
  type PathNode,
  type DependencyPathSpec,
  type LldpPortRow,
} from "../../src/services/alertDependencyPathService.js";
import { parseLocationCodes } from "../../src/utils/locationCodes.js";

const node = (hostname: string | null, over: Partial<PathNode> = {}): PathNode => ({
  id: hostname, hostname, role: "down", codes: null, location: null, ...over,
});

describe("nowStateOf", () => {
  it("maintenance outranks suppression, which outranks the monitor's own verdict", () => {
    expect(nowStateOf({ status: "maintenance", dependencySuppressed: true, monitorStatus: "down" })).toBe("maintenance");
    expect(nowStateOf({ status: "active", dependencySuppressed: true, monitorStatus: "up" })).toBe("suppressed");
    expect(nowStateOf({ monitorStatus: "warning" })).toBe("warning");
    expect(nowStateOf({ monitorStatus: "recovering" })).toBe("recovering");
  });

  it("a state that renders no verdict is unknown — never assumed up", () => {
    for (const s of ["passive", "pending", "unknown", null, undefined]) {
      expect(nowStateOf({ monitorStatus: s })).toBe("unknown");
    }
    expect(nowStateOf({})).toBe("unknown");
  });
});

describe("pathEntriesFromBlame — edges", () => {
  const self = { id: "me", hostname: "PLC-7" };
  const hosts = (r: ReturnType<typeof pathEntriesFromBlame>) =>
    r!.entries.map((e) => (e.kind === "gap" ? `+${e.hidden}` : `${e.node.hostname}:${e.node.role}`));

  it("is nothing for a non-object snapshot", () => {
    expect(pathEntriesFromBlame(null, self)).toBeNull();
    expect(pathEntriesFromBlame("blame", self)).toBeNull();
  });

  it("a chain with an unreadable node is not trusted — the named ends draw instead", () => {
    const r = pathEntriesFromBlame({
      chain: [{ id: "sw", hostname: "SW", reason: "suppressed" }, { id: 5 }],
      upstream: { id: "sw", hostname: "SW" },
      rootCause: { id: "core", hostname: "CORE", reason: "down" },
      hops: 2,
    }, self);
    expect(hosts(r)).toEqual(["CORE:down", "SW:suppressed", "PLC-7:alerting"]);
  });

  it("an unknown reason takes the fallback role; a nameless, idless node is unreadable", () => {
    const r = pathEntriesFromBlame({ chain: [{ id: "a", reason: "exploded" }] }, self);
    expect(hosts(r)).toEqual(["null:suppressed", "PLC-7:alerting"]);
    expect(r!.entries[0].kind === "node" && r!.entries[0].node.id).toBe("a");
    expect(pathEntriesFromBlame({ upstream: { hostname: "" } }, self)).toBeNull();
  });

  it("hops is floored, and anything but a finite number reads as one", () => {
    const base = { upstream: { id: "u", hostname: "U" }, rootCause: { id: "r", hostname: "R" } };
    expect(hosts(pathEntriesFromBlame({ ...base, hops: 3.9 }, self))).toEqual(["R:down", "+1", "U:suppressed", "PLC-7:alerting"]);
    expect(hosts(pathEntriesFromBlame({ ...base, hops: "7" }, self))).toEqual(["U:down", "PLC-7:alerting"]);
    expect(hosts(pathEntriesFromBlame({ ...base, hops: Infinity }, self))).toEqual(["U:down", "PLC-7:alerting"]);
  });

  it("never draws more than MAX_PATH_DEVICES devices", () => {
    const chain = Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, hostname: `N${i}`, reason: i === 8 ? "down" : "suppressed" }));
    const r = pathEntriesFromBlame({ chain }, self)!;
    expect(r.entries.filter((e) => e.kind === "node")).toHaveLength(MAX_PATH_DEVICES);
    expect(r.entries.find((e) => e.kind === "gap")).toEqual({ kind: "gap", hidden: 10 - MAX_PATH_DEVICES });
  });
});

describe("innerBoxOf — edges", () => {
  it("a rack is more specific than a room, less than a junction box", () => {
    expect(innerBoxOf(node("a", { codes: parseLocationCodes("b:HQ r:MDF ra:R4") }))).toMatchObject({ kind: "rack", label: "R4" });
    expect(innerBoxOf(node("a", { codes: parseLocationCodes("b:HQ r:MDF ra:R4 jb:J1") }))).toMatchObject({ kind: "junctionBox", label: "J1" });
  });

  it("a blank Location falls to the fixed label; the generic key ignores case", () => {
    expect(innerBoxOf(node("a", { location: "   " }))).toMatchObject({ kind: "generic", label: NO_LOCATION_LABEL });
    const k1 = innerBoxOf(node("a", { location: "Pump House" }))!.key;
    const k2 = innerBoxOf(node("b", { location: "pump house" }))!.key;
    expect(k1).toBe(k2);
  });
});

describe("runsOf — edges", () => {
  it("a key that recurs after another starts a new run", () => {
    expect(runsOf(["a", "b", "a"])).toEqual([
      { start: 0, end: 0, key: "a" }, { start: 1, end: 1, key: "b" }, { start: 2, end: 2, key: "a" },
    ]);
    expect(runsOf([])).toEqual([]);
    expect(runsOf([null, null])).toEqual([]);
  });
});

describe("fitLabel — edges", () => {
  it("stops at the minimum font and then shortens, keeping at least three characters", () => {
    expect(fitLabel("ABCDEFGHIJ", 10)).toEqual({ text: "AB…", fontPx: 9 });
    expect(fitLabel("SW", 1)).toEqual({ text: "SW", fontPx: 9 });
  });

  it("honours a custom font range", () => {
    expect(fitLabel("ABCDEFGH", 60, 14, 12)).toEqual({ text: "ABCDEFGH", fontPx: 12 });
  });
});

describe("portFacing / lastSeenSwitchPort — edges", () => {
  const row = (over: Partial<LldpPortRow>): LldpPortRow => ({ assetId: "a", matchedAssetId: "b", localIfName: "port1", portId: null, portIdSubtype: null, ...over });

  it("a synthetic own row falls through to the peer's named remote port", () => {
    const rows = [row({ localIfName: "port-12" }), row({ assetId: "b", matchedAssetId: "a", localIfName: "x", portId: "ge-0/0/1", portIdSubtype: "interfaceName" })];
    expect(portFacing(rows, "a", "b")).toBe("ge-0/0/1");
  });

  it("is null when neither side names the other", () => {
    expect(portFacing([row({ matchedAssetId: "c" })], "a", "b")).toBeNull();
    expect(portFacing([], "a", "b")).toBeNull();
  });

  it("reads the port after the LAST slash, so a switch name with a slash still matches", () => {
    expect(lastSeenSwitchPort("Stack/1/port7", "stack/1")).toBe("port7");
    expect(lastSeenSwitchPort("SW1/", "SW1")).toBeNull();
    expect(lastSeenSwitchPort("/port1", "")).toBeNull();
    expect(lastSeenSwitchPort("SW1/port1", null)).toBeNull();
  });
});

describe("dependencyPathText / renderDependencyPathBlocks — edges", () => {
  const spec = (over: Partial<DependencyPathSpec> = {}): DependencyPathSpec => ({
    entries: [
      { kind: "node", node: node(null, { role: "dependency_test" }) },
      { kind: "node", node: node("PLC-7", { role: "alerting" }) },
    ],
    links: [null],
    truncated: true,
    ...over,
  });

  it("names an unnamed device and the dependency-test role in words; no location means no bracket", () => {
    expect(dependencyPathText(spec())).toBe("Dependency path  (unnamed device) (dependency test) → PLC-7 (this alert)");
    // The text form names the Location field, not the box's fixed fallback label.
    const located = spec({ entries: [{ kind: "node", node: node("SW", { location: " Shack 2 " }) }] });
    expect(dependencyPathText(located)).toBe("Dependency path  SW [Shack 2] (down)");
  });

  it("an all-clear drops the fire-time truncation note — it redraws nothing of that walk", () => {
    const firing = renderDependencyPathBlocks(spec(), null);
    expect(firing.html).toContain("The walk stopped");
    const cleared = renderDependencyPathBlocks(spec({ allClear: true }), null);
    expect(cleared.html).not.toContain("The walk stopped");
    expect(cleared.text.startsWith("Dependency path now")).toBe(true);
    expect(cleared.text).toContain("(state unknown)");
  });
});

describe("the token helpers — edges", () => {
  it("finds the token in any template, ignoring null ones", () => {
    expect([...dependencyPathTokensIn(null, undefined, "x {dependency.path} y")]).toEqual(["dependency.path"]);
    expect(dependencyPathTokensIn("{dependency.pathx}").size).toBe(0);
    expect(dependencyPathTokensIn("{dependency}", "").size).toBe(0);
  });

  it("substitutes every occurrence literally — '$' in the block is never a replacement pattern", () => {
    expect(substituteDependencyPathTokens("a {dependency.path} b {dependency.path}", "$&$1")).toBe("a $&$1 b $&$1");
    expect(substituteDependencyPathTokens("", "x")).toBe("");
  });
});
