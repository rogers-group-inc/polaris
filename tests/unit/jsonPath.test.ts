import { describe, it, expect } from "vitest";
import {
  JsonPathError,
  evaluateJsonPath,
  isValidJsonPath,
  parseJsonPath,
  readJsonPathString,
  readJsonPathStrings,
  selectRecords,
} from "../../src/utils/jsonPath.js";

const doc = {
  data: {
    devices: [
      { id: 1, name: "sw-01", nics: [{ mac: "aa:bb:cc:00:00:01" }, { mac: "aa:bb:cc:00:00:02" }], "serial number": "SN1" },
      { id: 2, name: "sw-02", nics: [], ips: ["10.0.0.2", "10.0.0.3"], blank: "  ", nothing: null },
      "not-an-object",
    ],
  },
  meta: { next: "abc" },
};

describe("parseJsonPath", () => {
  it("treats empty, $ and $. as the root", () => {
    expect(parseJsonPath("")).toEqual([]);
    expect(parseJsonPath("$")).toEqual([]);
    expect(parseJsonPath("$.")).toEqual([]);
  });

  it("parses dotted keys, indexes, wildcards and quoted keys alike with or without $", () => {
    const expected = [
      { kind: "key", key: "data" },
      { kind: "key", key: "devices" },
      { kind: "wildcard" },
      { kind: "key", key: "nics" },
      { kind: "index", index: 0 },
      { kind: "key", key: "serial number" },
    ];
    expect(parseJsonPath("$.data.devices[*].nics[0]['serial number']")).toEqual(expected);
    expect(parseJsonPath("data.devices[*].nics[0][\"serial number\"]")).toEqual(expected);
    expect(parseJsonPath("data.devices.*.nics[0]['serial number']")).toEqual(expected);
  });

  it("refuses what it cannot parse, so a bad mapping fails at save time", () => {
    for (const bad of ["data.", "data..x", "a[", "a[foo]", "a['x", "a['x'", "a b[0", "a]"]) {
      expect(() => parseJsonPath(bad), bad).toThrow(JsonPathError);
      expect(isValidJsonPath(bad), bad).toBe(false);
    }
    expect(() => parseJsonPath("a.".repeat(400))).toThrow(/longer than/);
  });
});

describe("evaluateJsonPath", () => {
  it("walks keys, indexes (negative too) and wildcards in document order", () => {
    expect(evaluateJsonPath(doc, "meta.next")).toEqual(["abc"]);
    expect(evaluateJsonPath(doc, "data.devices[0].id")).toEqual([1]);
    expect(evaluateJsonPath(doc, "data.devices[-1]")).toEqual(["not-an-object"]);
    expect(evaluateJsonPath(doc, "data.devices[*].nics[*].mac")).toEqual(["aa:bb:cc:00:00:01", "aa:bb:cc:00:00:02"]);
  });

  it("yields nothing — never throws — when the path walks off the document", () => {
    expect(evaluateJsonPath(doc, "data.missing.deeper")).toEqual([]);
    expect(evaluateJsonPath(doc, "meta.next.length")).toEqual([]);
    expect(evaluateJsonPath(doc, "data.devices[99]")).toEqual([]);
    expect(evaluateJsonPath(null, "a.b")).toEqual([]);
  });

  it("never reads inherited properties", () => {
    expect(evaluateJsonPath({}, "constructor")).toEqual([]);
    expect(evaluateJsonPath({}, "__proto__")).toEqual([]);
  });

  it("keeps a present-but-null value (information for the Preview)", () => {
    expect(evaluateJsonPath(doc, "data.devices[1].nothing")).toEqual([null]);
  });
});

describe("selectRecords", () => {
  it("takes the elements of the ONE array a path lands on", () => {
    const { records, skipped } = selectRecords(doc, "data.devices");
    expect(records.map((r) => r.id)).toEqual([1, 2]);
    expect(skipped).toBe(1);
  });

  it("takes the matches of a wildcard path the same way", () => {
    expect(selectRecords(doc, "$.data.devices[*]").records.map((r) => r.id)).toEqual([1, 2]);
  });

  it("treats a root array as the records when the path is blank", () => {
    expect(selectRecords([{ a: 1 }, { a: 2 }], "").records).toHaveLength(2);
  });

  it("treats a single object at the path as one record", () => {
    expect(selectRecords({ item: { id: 7 } }, "item").records).toEqual([{ id: 7 }]);
  });
});

describe("readJsonPathString / readJsonPathStrings", () => {
  const rec = (doc.data.devices[1] as Record<string, unknown>);

  it("returns the first non-empty scalar, looking inside a leaf array", () => {
    expect(readJsonPathString(rec, "ips")).toBe("10.0.0.2");
    expect(readJsonPathString(rec, "id")).toBe("2");
    expect(readJsonPathString(rec, "blank")).toBeNull();
    expect(readJsonPathString(rec, "nothing")).toBeNull();
    expect(readJsonPathString(rec, "")).toBeNull();
    expect(readJsonPathString(rec, undefined)).toBeNull();
  });

  it("collects every scalar, de-duplicated in order", () => {
    expect(readJsonPathStrings(rec, "ips")).toEqual(["10.0.0.2", "10.0.0.3"]);
    expect(readJsonPathStrings(doc.data.devices[0], "nics[*].mac")).toEqual(["aa:bb:cc:00:00:01", "aa:bb:cc:00:00:02"]);
    expect(readJsonPathStrings({ a: ["x", "x", true] }, "a")).toEqual(["x", "true"]);
  });
});
