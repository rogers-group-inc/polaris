import { describe, it, expect } from "vitest";
import { fortiosSecondaryIpRows, fortiosSecondaryIpStrings } from "../../src/utils/fortiosSecondaryIp.js";

describe("fortiosSecondaryIpRows", () => {
  it("reads FortiOS REST's `secondary-IP` table and ignores the `secondaryip` flag", () => {
    const rows = [{ id: 1, ip: "10.2.2.1 255.255.255.0" }];
    expect(fortiosSecondaryIpRows({ secondaryip: "enable", "secondary-IP": rows })).toBe(rows);
  });

  it("reads FortiManager's `secondaryip` table and ignores the integer `secondary-IP` flag", () => {
    const rows = [{ id: 1, ip: ["10.2.2.1", "255.255.255.0"] }];
    expect(fortiosSecondaryIpRows({ "secondary-IP": 1, secondaryip: rows })).toBe(rows);
  });

  it("still accepts the legacy `secondary-ip` spelling", () => {
    const rows = [{ ip: "10.2.2.1 255.255.255.0" }];
    expect(fortiosSecondaryIpRows({ "secondary-ip": rows })).toBe(rows);
  });

  it("is empty for a row without a table, and for a non-object", () => {
    expect(fortiosSecondaryIpRows({ secondaryip: "disable" })).toEqual([]);
    expect(fortiosSecondaryIpRows(null)).toEqual([]);
    expect(fortiosSecondaryIpRows("port1")).toEqual([]);
  });
});

describe("fortiosSecondaryIpStrings", () => {
  it("returns each row's address in either shape, skipping empty and malformed rows", () => {
    expect(fortiosSecondaryIpStrings({
      "secondary-IP": [
        { ip: "10.2.2.1 255.255.255.0" },
        { ip: ["10.3.3.1", "255.255.255.0"] },
        { ip: "" },
        { ip: 42 },
        {},
        null,
      ],
    })).toEqual(["10.2.2.1 255.255.255.0", "10.3.3.1"]);
  });
});
