/**
 * tests/unit/fortilinkLldp.test.ts
 *
 * Pure-function coverage for the FortiLink interface-set extractor used by the
 * "Exclude FortiLink interfaces from LLDP collection" toggle. The set is the
 * authoritative basis for dropping LLDP neighbors learned on FortiLink links:
 * every CMDB interface with `fortilink` enabled, plus its member ports.
 */

import { describe, it, expect } from "vitest";
import { fortilinkInterfaceNamesFromCmdb } from "../../src/services/monitoring/fortiosCollectors.js";

describe("fortilinkInterfaceNamesFromCmdb", () => {
  it("returns the fortilink aggregate plus its member ports", () => {
    const cmdb = [
      { name: "fortilink", fortilink: "enable", member: [{ "interface-name": "a" }, { "interface-name": "b" }] },
      { name: "wan1", fortilink: "disable" },
      { name: "internal", fortilink: "disable", member: [{ "interface-name": "port1" }] },
    ];
    const set = fortilinkInterfaceNamesFromCmdb(cmdb);
    expect([...set].sort()).toEqual(["a", "b", "fortilink"]);
  });

  it("accepts the { results: [...] } envelope shape", () => {
    const set = fortilinkInterfaceNamesFromCmdb({
      results: [{ name: "fortilink", fortilink: "enable", member: [{ "interface-name": "x1" }] }],
    });
    expect([...set].sort()).toEqual(["fortilink", "x1"]);
  });

  it("falls back to q_origin_key and bare-string members for the member name", () => {
    const set = fortilinkInterfaceNamesFromCmdb([
      { name: "fortilink", fortilink: "enable", member: [{ q_origin_key: "p3" }, "p4", { interface_name: "p5" }] },
    ]);
    expect([...set].sort()).toEqual(["fortilink", "p3", "p4", "p5"]);
  });

  it("treats boolean/numeric truthy fortilink flags as enabled", () => {
    expect(fortilinkInterfaceNamesFromCmdb([{ name: "fl1", fortilink: true }]).has("fl1")).toBe(true);
    expect(fortilinkInterfaceNamesFromCmdb([{ name: "fl2", fortilink: 1 }]).has("fl2")).toBe(true);
  });

  it("returns an empty set when no interface has fortilink enabled", () => {
    const set = fortilinkInterfaceNamesFromCmdb([
      { name: "wan1", fortilink: "disable" },
      { name: "lan", fortilink: "disable", member: [{ "interface-name": "port1" }] },
    ]);
    expect(set.size).toBe(0);
  });

  it("is null/garbage tolerant", () => {
    expect(fortilinkInterfaceNamesFromCmdb(null).size).toBe(0);
    expect(fortilinkInterfaceNamesFromCmdb(undefined).size).toBe(0);
    expect(fortilinkInterfaceNamesFromCmdb("nope").size).toBe(0);
    expect(fortilinkInterfaceNamesFromCmdb([null, {}, { fortilink: "enable" }]).size).toBe(0);
  });
});
