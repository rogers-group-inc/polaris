import { describe, it, expect } from "vitest";
import {
  parsePoeIndex,
  poeClassLabel,
  poeIfNameByIndex,
  poeIsFault,
  poeStatusLabel,
  poeWalkOutcome,
  POE_STATUS_VALUES,
} from "../../src/utils/poePorts.js";

describe("poeStatusLabel", () => {
  it("decodes every pethPsePortDetectionStatus value", () => {
    expect(poeStatusLabel(1)).toBe("disabled");
    expect(poeStatusLabel(2)).toBe("searching");
    expect(poeStatusLabel(3)).toBe("delivering");
    expect(poeStatusLabel(4)).toBe("fault");
    expect(poeStatusLabel(5)).toBe("test");
    expect(poeStatusLabel(6)).toBe("other-fault");
  });

  it("returns null for absent or out-of-range readings", () => {
    expect(poeStatusLabel(null)).toBeNull();
    expect(poeStatusLabel(undefined)).toBeNull();
    expect(poeStatusLabel(0)).toBeNull();
    expect(poeStatusLabel(99)).toBeNull();
  });

  it("keeps every produced value inside the declared enum", () => {
    for (const raw of [1, 2, 3, 4, 5, 6]) {
      expect(POE_STATUS_VALUES).toContain(poeStatusLabel(raw) as never);
    }
  });
});

describe("poeIsFault", () => {
  it("counts both fault flavours as faults", () => {
    expect(poeIsFault("fault")).toBe(true);
    expect(poeIsFault("other-fault")).toBe(true);
  });

  // The gate that keeps a "PoE is faulted" automation from firing across the
  // whole switch: an empty port searches forever, and a disabled port is an
  // operator's choice. Neither is a failure.
  it("does not treat searching or disabled as faults", () => {
    expect(poeIsFault("searching")).toBe(false);
    expect(poeIsFault("disabled")).toBe(false);
    expect(poeIsFault(null)).toBe(false);
  });
});

describe("poeClassLabel", () => {
  // The MIB enumerates class0(1)..class4(5) — the enum value is one MORE than
  // the IEEE class it names. Storing the raw integer reports a class-0 PD as
  // class 1 and a class-4 PD as a class 5 that does not exist.
  it("corrects the enum's off-by-one", () => {
    expect(poeClassLabel(1)).toBe("class0");
    expect(poeClassLabel(2)).toBe("class1");
    expect(poeClassLabel(3)).toBe("class2");
    expect(poeClassLabel(4)).toBe("class3");
    expect(poeClassLabel(5)).toBe("class4");
  });

  it("rejects values outside the enum rather than inventing a class", () => {
    expect(poeClassLabel(0)).toBeNull();
    expect(poeClassLabel(6)).toBeNull();
    expect(poeClassLabel(null)).toBeNull();
  });
});

describe("parsePoeIndex", () => {
  it("splits the {group, port} suffix", () => {
    expect(parsePoeIndex("1.5")).toEqual({ group: 1, port: 5 });
    expect(parsePoeIndex("2.48")).toEqual({ group: 2, port: 48 });
  });

  it("treats a single-component suffix as group 1", () => {
    expect(parsePoeIndex("7")).toEqual({ group: 1, port: 7 });
  });

  it("rejects malformed suffixes", () => {
    expect(parsePoeIndex("")).toBeNull();
    expect(parsePoeIndex("1.2.3")).toBeNull();
    expect(parsePoeIndex("a.b")).toBeNull();
  });
});

describe("poeIfNameByIndex", () => {
  const fortiswitch = new Map<string, string>([
    ["1", "port1"],
    ["5", "port5"],
    ["6", "port6"],
  ]);

  // On a FortiSwitch the ifIndex and the port number coincide, so this passes
  // via the trailing-number match — not via any ifIndex equivalence.
  it("resolves FortiSwitch-style port names", () => {
    const out = poeIfNameByIndex(["1.5", "1.6"], fortiswitch);
    expect(out.get("1.5")).toBe("port5");
    expect(out.get("1.6")).toBe("port6");
  });

  it("falls back to matching the trailing number of a port name", () => {
    // ifIndex values deliberately unrelated to the port numbers, which is the
    // common case on gear that numbers interfaces from a different base.
    const byIndex = new Map<string, string>([
      ["101", "port1"],
      ["105", "port5"],
    ]);
    const out = poeIfNameByIndex(["1.5"], byIndex);
    expect(out.get("1.5")).toBe("port5");
  });

  // A stacked switch has port 5 on every member. Guessing one would stamp PoE
  // state on the wrong physical port — silent on the broken one, alerting on a
  // healthy one — so an ambiguous match resolves to nothing at all.
  it("refuses an ambiguous trailing-number match", () => {
    const stacked = new Map<string, string>([
      ["10", "1/0/5"],
      ["20", "2/0/5"],
    ]);
    expect(poeIfNameByIndex(["1.5"], stacked).size).toBe(0);
  });

  it("omits rows it cannot resolve rather than guessing", () => {
    const out = poeIfNameByIndex(["1.99"], fortiswitch);
    expect(out.size).toBe(0);
  });

  // Regression guard for a heuristic that was REMOVED. Treating the PoE port
  // index as an ifIndex is the same `index == ifIndex` equivalence the
  // FortiSwitch sensor annotation was reverted for (97e54fd2) — right often
  // enough to look correct, silently wrong the rest of the time. Here ifIndex 5
  // is "port42" while the front-panel number says "port5"; the port NUMBER wins,
  // because that is a convention the vendor maintains deliberately.
  it("does NOT treat the PoE port index as an ifIndex", () => {
    const byIndex = new Map<string, string>([
      ["5", "port42"],
      ["9", "port5"],
    ]);
    expect(poeIfNameByIndex(["1.5"], byIndex).get("1.5")).toBe("port5");
  });
});

describe("poeWalkOutcome", () => {
  it("distinguishes an errored walk from one that answered empty", () => {
    // null = the walk threw (timeout / refused / transport gone). Not evidence
    // about the device, so the caller must NOT cache it as "no PSE".
    expect(poeWalkOutcome(null)).toBe("unreadable");
    expect(poeWalkOutcome(undefined)).toBe("unreadable");
    // An answer with no rows IS evidence: this device has no PSE.
    expect(poeWalkOutcome(new Map())).toBe("no-pse");
  });

  it("reports rows when the table has any", () => {
    expect(poeWalkOutcome(new Map([["1.5", 4]]))).toBe("rows");
  });
});
