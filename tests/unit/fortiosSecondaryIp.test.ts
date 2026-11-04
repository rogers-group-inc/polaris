import { describe, it, expect } from "vitest";
import { fortiosSecondaryIpRows, fortiosSecondaryIpStrings } from "../../src/utils/fortiosSecondaryIp.js";

describe("fortiosSecondaryIpRows", () => {
  it("reads FortiOS REST's `secondaryip` table and ignores the `secondary-IP` flag (HUB1-a, 7.6.8)", () => {
    // Shape read off a lab gate with two real secondaries, 2026-11-04.
    const rows = [
      { id: 1, q_origin_key: 1, ip: "99.1.1.1 255.255.255.255", allowaccess: "" },
      { id: 2, q_origin_key: 2, ip: "192.168.250.1 255.255.255.0", allowaccess: "" },
    ];
    const iface = { name: "BGP", "secondary-IP": "enable", secondaryip: rows };
    expect(fortiosSecondaryIpRows(iface)).toBe(rows);
    expect(fortiosSecondaryIpStrings(iface)).toEqual(["99.1.1.1 255.255.255.255", "192.168.250.1 255.255.255.0"]);
  });

  it("takes the table under either spelling, whichever way round the flag is", () => {
    const rows = [{ id: 1, ip: "10.2.2.1 255.255.255.0" }];
    expect(fortiosSecondaryIpRows({ secondaryip: "enable", "secondary-IP": rows })).toBe(rows);
  });

  it("reads an [ip, mask] array table and ignores an integer flag (FortiManager, assumed)", () => {
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
