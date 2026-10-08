/**
 * tests/unit/alertDependencyPath.test.ts
 *
 * The dependency-path diagram in a dependency-down alert email
 * (`{dependency.path}`, alertDependencyPathService, business rule 78): the
 * chain the engine blamed, root cause left and the alerting device right, at
 * most four devices (two each side of a "+N more" gap), each in its Device Map
 * location box — or a generic box when it carries no codes.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { db } = vi.hoisted(() => ({
  db: {
    assets: [] as unknown[],
    lldp: [] as unknown[],
    assetCalls: 0,
    lldpCalls: 0,
    fail: false,
  },
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    asset: {
      findMany: vi.fn(async () => {
        db.assetCalls++;
        if (db.fail) throw new Error("db down");
        return db.assets;
      }),
    },
    assetLldpNeighbor: {
      findMany: vi.fn(async () => {
        db.lldpCalls++;
        return db.lldp;
      }),
    },
  },
}));

import {
  MAX_PATH_DEVICES,
  NO_LOCATION_LABEL,
  DEPENDENCY_PATH_CID,
  buildDependencyPathBlocks,
  dependencyPathSvg,
  dependencyPathText,
  dependencyPathTokensIn,
  fitLabel,
  innerBoxOf,
  lastSeenSwitchPort,
  loadDependencyPath,
  nowStateOf,
  pathEntriesFromBlame,
  portFacing,
  renderDependencyPathBlocks,
  runsOf,
  substituteDependencyPathTokens,
  type PathEntry,
  type PathNode,
} from "../../src/services/alertDependencyPathService.js";
import { parseLocationCodes } from "../../src/utils/locationCodes.js";
import { isDeferredToken, renderNotificationTemplate } from "../../src/utils/notificationTemplate.js";
import { DEFAULT_ALERT_HTML, DEFAULT_ALERT_TEXT } from "../../src/utils/alertEmailTemplate.js";

const SELF = { id: "self", hostname: "PLC-7" };

function chainOf(n: number) {
  // Walking order: upstream first, root cause last.
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`,
    hostname: `SW-${i + 1}`,
    reason: i === n - 1 ? "down" : "suppressed",
  }));
}

function names(entries: PathEntry[]): string[] {
  return entries.map((e) => (e.kind === "gap" ? `+${e.hidden}` : e.node.hostname ?? "?"));
}

function node(partial: Partial<PathNode>): PathNode {
  return { id: null, hostname: "X", role: "suppressed", codes: null, location: null, ...partial };
}

beforeEach(() => {
  db.assets = [];
  db.lldp = [];
  db.assetCalls = 0;
  db.lldpCalls = 0;
  db.fail = false;
});

describe("pathEntriesFromBlame", () => {
  it("draws root cause first and the alerting device last", () => {
    const seq = pathEntriesFromBlame({ chain: chainOf(2), hops: 2 }, SELF)!;
    expect(names(seq.entries)).toEqual(["SW-2", "SW-1", "PLC-7"]);
    const roles = seq.entries.map((e) => (e.kind === "node" ? e.node.role : "gap"));
    expect(roles).toEqual(["down", "suppressed", "alerting"]);
  });

  it(`draws every device up to ${MAX_PATH_DEVICES} with no gap`, () => {
    const seq = pathEntriesFromBlame({ chain: chainOf(3), hops: 3 }, SELF)!;
    expect(names(seq.entries)).toEqual(["SW-3", "SW-2", "SW-1", "PLC-7"]);
  });

  it("keeps two devices on each side of a gap on a longer chain", () => {
    const seq = pathEntriesFromBlame({ chain: chainOf(6), hops: 6 }, SELF)!;
    // 7 devices: root SW-6, SW-5 | 3 hidden | SW-1 (upstream), PLC-7.
    expect(names(seq.entries)).toEqual(["SW-6", "SW-5", "+3", "SW-1", "PLC-7"]);
  });

  it("five devices hide exactly one", () => {
    const seq = pathEntriesFromBlame({ chain: chainOf(4), hops: 4 }, SELF)!;
    expect(names(seq.entries)).toEqual(["SW-4", "SW-3", "+1", "SW-1", "PLC-7"]);
  });

  it("draws a pre-chain row from its two named ends, counting the middle from hops", () => {
    const seq = pathEntriesFromBlame({
      upstream: { id: "u", hostname: "SW-UP" },
      rootCause: { id: "r", hostname: "FGT", reason: "down" },
      hops: 4,
    }, SELF)!;
    expect(names(seq.entries)).toEqual(["FGT", "+2", "SW-UP", "PLC-7"]);
    const up = seq.entries[2] as Extract<PathEntry, { kind: "node" }>;
    expect(up.node.role).toBe("suppressed");
  });

  it("a pre-chain row whose upstream is the root draws two devices", () => {
    const seq = pathEntriesFromBlame({
      upstream: { id: "u", hostname: "SW-UP" },
      rootCause: { id: "u", hostname: "SW-UP", reason: "maintenance" },
      hops: 1,
    }, SELF)!;
    expect(names(seq.entries)).toEqual(["SW-UP", "PLC-7"]);
  });

  it("is null when the blame names nobody", () => {
    expect(pathEntriesFromBlame(null, SELF)).toBeNull();
    expect(pathEntriesFromBlame({ upstream: null, rootCause: null, chain: [], hops: 0 }, SELF)).toBeNull();
  });

  it("carries the truncated flag", () => {
    expect(pathEntriesFromBlame({ chain: chainOf(1), hops: 1, truncated: true }, SELF)!.truncated).toBe(true);
  });
});

describe("location boxes", () => {
  it("uses the most specific non-area code", () => {
    const box = innerBoxOf(node({ codes: parseLocationCodes("a:Surface r:Belt 6 Shack jb:Head of 4") }))!;
    expect(box.label).toBe("Head of 4");
    expect(box.kind).toBe("junctionBox");
  });

  it("an area-only device has no inner box", () => {
    expect(innerBoxOf(node({ codes: parseLocationCodes("a:Surface") }))).toBeNull();
  });

  it("a device with no codes sits in a generic box named by its Location, else a fixed label", () => {
    expect(innerBoxOf(node({ location: "Boone Quarry" }))!.label).toBe("Boone Quarry");
    expect(innerBoxOf(node({}))!.label).toBe(NO_LOCATION_LABEL);
    expect(innerBoxOf(node({}))!.kind).toBe("generic");
  });

  it("the same junction box in two rooms is two boxes", () => {
    const a = innerBoxOf(node({ codes: parseLocationCodes("r:North jb:3") }))!;
    const b = innerBoxOf(node({ codes: parseLocationCodes("r:South jb:3") }))!;
    expect(a.key).not.toBe(b.key);
  });

  it("runs group consecutive keys and never span a gap", () => {
    expect(runsOf(["a", "a", null, "a", "b"])).toEqual([
      { start: 0, end: 1, key: "a" },
      { start: 3, end: 3, key: "a" },
      { start: 4, end: 4, key: "b" },
    ]);
  });
});

describe("ports", () => {
  const rows = [
    { assetId: "sw", matchedAssetId: "fg", localIfName: "port48", portId: "port1", portIdSubtype: "interfaceName" },
    { assetId: "sw2", matchedAssetId: "sw", localIfName: "port-12", portId: "port7", portIdSubtype: "macAddress" },
  ];

  it("prefers the device's own LLDP row, then the peer's named remote port", () => {
    expect(portFacing(rows, "sw", "fg")).toBe("port48");
    // fg has no row of its own; sw's row says its far end is fg's port1.
    expect(portFacing(rows, "fg", "sw")).toBe("port1");
  });

  it("ignores synthetic ifIndex fallbacks and non-name port subtypes", () => {
    expect(portFacing(rows, "sw2", "sw")).toBeNull();
    expect(portFacing(rows, "sw", "sw2")).toBeNull();
  });

  it("reads an endpoint's switch port only when lastSeenSwitch names that parent", () => {
    expect(lastSeenSwitchPort("FS-248E-01/port15", "fs-248e-01")).toBe("port15");
    expect(lastSeenSwitchPort("FS-248E-01/port15", "OTHER")).toBeNull();
    expect(lastSeenSwitchPort(null, "FS-248E-01")).toBeNull();
  });
});

describe("rendering", () => {
  function spec(n: number) {
    const seq = pathEntriesFromBlame({ chain: chainOf(n), hops: n }, SELF)!;
    return { entries: seq.entries, links: seq.entries.slice(1).map(() => null), truncated: false };
  }

  it("draws one circle per device and a gap marker", () => {
    const svg = dependencyPathSvg(spec(6));
    expect(svg.startsWith("<svg")).toBe(true);
    // Two circles (ring + dot) per device; three dots in the gap pill.
    expect(svg.match(/<circle/g)!.length).toBe(4 * 2 + 3);
    expect(svg).toContain("+3 more");
    expect(svg).toContain("Root cause");
    expect(svg).toContain("This alert");
  });

  it("labels an edge with its ports and escapes text", () => {
    const s = spec(1);
    s.links = [{ parentPort: "port11", childPort: null }];
    (s.entries[0] as Extract<PathEntry, { kind: "node" }>).node.hostname = "A&B<1>";
    const svg = dependencyPathSvg(s);
    expect(svg).toContain("port11 ↔ ?");
    expect(svg).toContain("A&amp;B&lt;1&gt;");
  });

  it("steps the font down before shortening a hostname", () => {
    expect(fitLabel("PLANT-SW-DIST-02", 100)).toEqual({ text: "PLANT-SW-DIST-02", fontPx: 10 });
    const cut = fitLabel("A-VERY-LONG-HOSTNAME-INDEED-01", 100);
    expect(cut.fontPx).toBe(9);
    expect(cut.text.endsWith("…")).toBe(true);
  });

  it("the text form names every drawn device with its location and has no colon", () => {
    const s = spec(1);
    (s.entries[0] as Extract<PathEntry, { kind: "node" }>).node.codes = parseLocationCodes("a:Surface jb:Head of 4");
    const text = dependencyPathText(s);
    expect(text).toBe("Dependency path  SW-1 [Surface / Head of 4] (down) → PLC-7 (this alert)");
    expect(text).not.toContain(":");
  });

  it("renders a complete block with an inline image, or a text fallback, or nothing", () => {
    const withImg = renderDependencyPathBlocks(spec(1), Buffer.from("png"));
    expect(withImg.html).toContain(`cid:${DEPENDENCY_PATH_CID}`);
    expect(withImg.html.startsWith("<tr>")).toBe(true);
    expect(withImg.attachment?.cid).toBe(DEPENDENCY_PATH_CID);

    const noImg = renderDependencyPathBlocks(spec(1), null);
    expect(noImg.html).not.toContain("cid:");
    expect(noImg.html).toContain("SW-1");
    expect(noImg.attachment).toBeNull();

    expect(renderDependencyPathBlocks(null, null)).toEqual({ html: "", text: "", attachment: null });
  });
});

describe("loadDependencyPath", () => {
  const base = { assetId: "self", assetHostname: "PLC-7", dependencyDown: true, testRun: false };

  it("costs nothing on an alert that is not dependency-down", async () => {
    expect(await loadDependencyPath({ ...base, dependencyDown: false, dependencyBlame: null })).toBeNull();
    expect(db.assetCalls).toBe(0);
  });

  it("fills location codes from description, then the device description, and ports from LLDP", async () => {
    db.assets = [
      { id: "p1", hostname: "SW-1", location: null, description: null, fortinetTopology: { deviceDescription: "a:Mine jb:JB-3" }, lastSeenSwitch: null },
      { id: "self", hostname: "PLC-7", location: "Shop", description: "no codes here", fortinetTopology: null, lastSeenSwitch: "SW-1/port9" },
    ];
    const spec = (await loadDependencyPath({ ...base, dependencyBlame: { chain: chainOf(1), hops: 1 } }))!;
    const [sw, plc] = spec.entries as Array<Extract<PathEntry, { kind: "node" }>>;
    expect(sw.node.codes?.junctionBox).toBe("JB-3");
    expect(plc.node.location).toBe("Shop");
    expect(spec.links[0]).toEqual({ parentPort: "port9", childPort: null });
    expect(db.assetCalls).toBe(1);
    expect(db.lldpCalls).toBe(1);
  });

  it("a read failure still draws the chain, unboxed by codes", async () => {
    db.fail = true;
    const spec = (await loadDependencyPath({ ...base, dependencyBlame: { chain: chainOf(1), hops: 1 } }))!;
    expect(names(spec.entries)).toEqual(["SW-1", "PLC-7"]);
  });

  it("a test alert reads nothing and uses invented locations", async () => {
    const spec = (await loadDependencyPath({
      ...base, assetId: null, testRun: true,
      dependencyBlame: { chain: [{ id: null, hostname: "EXAMPLE-CORE-01", reason: "down" }], hops: 1 },
    }))!;
    expect(db.assetCalls).toBe(0);
    const first = spec.entries[0] as Extract<PathEntry, { kind: "node" }>;
    expect(first.node.codes?.area).toMatch(/^Example/);
  });

  it("buildDependencyPathBlocks degrades to a text line or a PNG, never throws", async () => {
    const blocks = await buildDependencyPathBlocks({ ...base, dependencyBlame: { chain: chainOf(1), hops: 1 } });
    expect(blocks.text).toContain("SW-1");
    expect(blocks.html).toContain("Dependency path");
  });
});

describe("the token", () => {
  it("is deferred past compose time, while its fire-time siblings are not", () => {
    expect(isDeferredToken("dependency.path")).toBe(true);
    expect(isDeferredToken("dependency.summary")).toBe(false);
    expect(renderNotificationTemplate("x {dependency.path} y", {}, { unknown: "blank" })).toBe("x {dependency.path} y");
  });

  it("sits in both default bodies", () => {
    expect(dependencyPathTokensIn(DEFAULT_ALERT_TEXT).size).toBe(1);
    expect(dependencyPathTokensIn(DEFAULT_ALERT_HTML).size).toBe(1);
  });

  it("substitutes the block, or removes the token", () => {
    expect(substituteDependencyPathTokens("a{dependency.path}b", "$&")).toBe("a$&b");
    expect(substituteDependencyPathTokens("a{dependency.path}b", "")).toBe("ab");
  });
});

describe("the all-clear draws the chain as it is now", () => {
  it("reads a device's state with maintenance, then suppression, ahead of its own verdict", () => {
    expect(nowStateOf({ status: "maintenance", monitorStatus: "down", dependencySuppressed: true })).toBe("maintenance");
    expect(nowStateOf({ status: "active", monitorStatus: "up", dependencySuppressed: true })).toBe("suppressed");
    for (const s of ["up", "recovering", "warning", "down"] as const) {
      expect(nowStateOf({ status: "active", monitorStatus: s, dependencySuppressed: false })).toBe(s);
    }
    // No verdict rendered, so none drawn.
    for (const s of ["passive", "unknown", null]) {
      expect(nowStateOf({ status: "active", monitorStatus: s, dependencySuppressed: false })).toBe("unknown");
    }
  });

  it("colours each device by its state now, not its fire-time role", () => {
    const seq = pathEntriesFromBlame(
      { chain: [{ id: "sw", hostname: "SW-1", reason: "down" }] },
      { id: "plc", hostname: "PLC-7" },
    )!;
    const nodes = seq.entries.flatMap((e) => (e.kind === "node" ? [e.node] : []));
    nodes[0].now = "up";
    nodes[1].now = "up";
    const spec = { entries: seq.entries, links: [null], truncated: true, allClear: true };
    const svg = dependencyPathSvg(spec);
    expect(svg).toContain("#16a34a");
    expect(svg).not.toContain("Root cause");
    expect(svg).toContain("This alert · Up");
    expect(dependencyPathText(spec)).toBe("Dependency path now  SW-1 (up) → PLC-7 (this alert, up)");
    // The truncation note describes the fire-time walk, which is not redrawn.
    expect(renderDependencyPathBlocks(spec, null).html).not.toContain("walk stopped");
  });

  it("draws an unreadable device as unknown rather than assuming it recovered", () => {
    const seq = pathEntriesFromBlame({ chain: [{ id: "sw", hostname: "SW-1", reason: "down" }] }, { id: "plc", hostname: "PLC-7" })!;
    const text = dependencyPathText({ entries: seq.entries, links: [null], truncated: false, allClear: true });
    expect(text).toBe("Dependency path now  SW-1 (state unknown) → PLC-7 (this alert, state unknown)");
  });

  it("draws a test alert's all-clear with every invented device back up", async () => {
    const spec = await loadDependencyPath(
      { assetId: null, assetHostname: "Example PLC", dependencyDown: true, testRun: true, dependencyBlame: { chain: [{ id: "x", hostname: "Example Switch", reason: "down" }] } },
      { allClear: true },
    );
    expect(dependencyPathText(spec!)).toContain("Example Switch [Example Area / Example Cabinet] (up)");
  });
});
