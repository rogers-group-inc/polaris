/**
 * tests/unit/interfacePatternMatch.test.ts — the interface dimension filter
 * (`ifNamePattern`) every interface resolver in notificationEngine applies.
 *
 * The case that forced it: two FortiGates carry the same circuit, "ATT EPLS",
 * one as a VLAN interface's NAME and the other as port25's DESCRIPTION. A
 * name-only match saw one of the two; a "|" list could not be written at all.
 */

import { describe, it, expect } from "vitest";
import { interfacePatternMatch } from "../../src/services/notificationTypes.js";

describe("interfacePatternMatch", () => {
  it("matches the name or the description, case-insensitively", () => {
    expect(interfacePatternMatch("ATT EPLS", null, "att epls")).toBe(true);
    expect(interfacePatternMatch("port25", "ATT EPLS", "ATT EPLS")).toBe(true);
    expect(interfacePatternMatch("port25", "ATT EPLS", "port2")).toBe(true);
    expect(interfacePatternMatch("port24", "Uplink", "ATT EPLS")).toBe(false);
  });

  it("treats a blank or unset pattern as every interface", () => {
    expect(interfacePatternMatch("port1", null, undefined)).toBe(true);
    expect(interfacePatternMatch("port1", null, "")).toBe(true);
    expect(interfacePatternMatch("port1", null, " | ")).toBe(true);
  });

  it("reads a \"|\" list as any-of, each term trimmed", () => {
    expect(interfacePatternMatch("wan1", null, "ATT EPLS | wan1")).toBe(true);
    expect(interfacePatternMatch("port25", "ATT EPLS", "wan1|ATT EPLS")).toBe(true);
    expect(interfacePatternMatch("wan2", null, "ATT EPLS|wan1")).toBe(false);
  });

  it("never matches on an empty description", () => {
    expect(interfacePatternMatch("port1", "", "x")).toBe(false);
    expect(interfacePatternMatch("port1", null, "x")).toBe(false);
  });
});
