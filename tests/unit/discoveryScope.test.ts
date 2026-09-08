/**
 * tests/unit/discoveryScope.test.ts — the pure scope helpers.
 *
 * The load-bearing one is `ldapGuidFilterValue`. AD's `objectGUID` is binary,
 * so a scoped search has to present it as escaped bytes; `decodeObjectGuid`
 * stores those bytes as lowercase hex in WIRE ORDER with no byte-swapping, and
 * this helper's whole job is to reverse that faithfully. Get the order wrong
 * and the filter matches zero objects — which surfaces not as an error but as
 * "Discover Now appears to do nothing", the exact silent-failure shape this
 * codebase has been bitten by before (see fortinetParentKey's header).
 *
 * So the round trip is pinned against the real decoder rather than a
 * hand-written expectation.
 */

import { describe, it, expect } from "vitest";
import {
  ldapGuidFilterValue,
  scopeLabel,
  scopeMatchesIntegrationType,
  SCOPE_INTEGRATION_TYPE,
  type DiscoveryScope,
} from "../../src/services/discovery/discoveryScope.js";
import { decodeObjectGuid } from "../../src/services/ldapClient.js";

describe("ldapGuidFilterValue", () => {
  it("round-trips the bytes decodeObjectGuid produced, in order", () => {
    const raw = Buffer.from([
      0x4c, 0xa2, 0x1f, 0x00, 0x11, 0x22, 0x33, 0x44,
      0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc,
    ]);
    const hex = decodeObjectGuid(raw);
    expect(hex).toBe("4ca21f00112233445566778899aabbcc");

    const filter = ldapGuidFilterValue(hex);
    expect(filter).toBe("\\4c\\a2\\1f\\00\\11\\22\\33\\44\\55\\66\\77\\88\\99\\aa\\bb\\cc");

    // And the escaped form parses back to the identical byte sequence — the
    // property that actually matters to the LDAP server.
    const bytes = Buffer.from((filter as string).split("\\").filter(Boolean).map((b) => parseInt(b, 16)));
    expect(bytes.equals(raw)).toBe(true);
  });

  it("preserves leading zero bytes as \\00 rather than collapsing them", () => {
    const raw = Buffer.alloc(16);
    raw[15] = 0x01;
    const filter = ldapGuidFilterValue(decodeObjectGuid(raw));
    expect(filter).toBe("\\00".repeat(15) + "\\01");
  });

  it("is case-insensitive on input and lowercases the output", () => {
    expect(ldapGuidFilterValue("ABCDEF00112233445566778899AABBCC"))
      .toBe(ldapGuidFilterValue("abcdef00112233445566778899aabbcc"));
  });

  it("rejects anything that is not exactly 32 hex characters", () => {
    // A malformed GUID must fail loudly at the caller, never build a filter
    // that matches the wrong object — or everything.
    expect(ldapGuidFilterValue("")).toBeNull();
    expect(ldapGuidFilterValue("nothex")).toBeNull();
    expect(ldapGuidFilterValue("4ca21f00112233445566778899aabb")).toBeNull();   // 30
    expect(ldapGuidFilterValue("4ca21f00112233445566778899aabbccdd")).toBeNull(); // 34
    // A dashed GUID is the WRONG shape here — objectGUID is stored undashed.
    expect(ldapGuidFilterValue("4ca21f00-1122-3344-5566-778899aabbcc")).toBeNull();
    // A wildcard must never survive into a filter.
    expect(ldapGuidFilterValue("*")).toBeNull();
  });
});

describe("scopeMatchesIntegrationType", () => {
  const cases: Array<[DiscoveryScope, string]> = [
    [{ kind: "fmg-device", deviceName: "fgt-1" }, "fortimanager"],
    [{ kind: "entra-device", deviceId: "abc" }, "entraid"],
    [{ kind: "ad-object", objectGuid: "abc" }, "activedirectory"],
  ];

  it("accepts each kind against its own integration type", () => {
    for (const [scope, type] of cases) expect(scopeMatchesIntegrationType(scope, type)).toBe(true);
  });

  it("rejects every cross pairing", () => {
    for (const [scope] of cases) {
      for (const [, otherType] of cases) {
        if (SCOPE_INTEGRATION_TYPE[scope.kind] === otherType) continue;
        expect(scopeMatchesIntegrationType(scope, otherType)).toBe(false);
      }
    }
    // And against a type with no scope support at all.
    expect(scopeMatchesIntegrationType({ kind: "fmg-device", deviceName: "x" }, "vcenter")).toBe(false);
  });

  it("maps every union member — a new kind must declare its type", () => {
    const kinds: DiscoveryScope["kind"][] = ["fmg-device", "entra-device", "ad-object"];
    for (const k of kinds) expect(typeof SCOPE_INTEGRATION_TYPE[k]).toBe("string");
    expect(Object.keys(SCOPE_INTEGRATION_TYPE).sort()).toEqual([...kinds].sort());
  });
});

describe("scopeLabel", () => {
  it("is undefined for an unscoped run — the run row's 'full run' signal", () => {
    expect(scopeLabel(undefined)).toBeUndefined();
    expect(scopeLabel(undefined, "ignored")).toBeUndefined();
  });

  it("prefers a caller-supplied display name over an opaque identifier", () => {
    expect(scopeLabel({ kind: "entra-device", deviceId: "9f1c-guid" }, "LAPTOP-42")).toBe("LAPTOP-42");
    expect(scopeLabel({ kind: "ad-object", objectGuid: "abcd" }, "  SRV-01  ")).toBe("SRV-01");
  });

  it("falls back to the identifier when no display name is offered", () => {
    expect(scopeLabel({ kind: "fmg-device", deviceName: "FGT-HQ" })).toBe("FGT-HQ");
    expect(scopeLabel({ kind: "entra-device", deviceId: "9f1c" })).toBe("9f1c");
    expect(scopeLabel({ kind: "ad-object", objectGuid: "abcd" })).toBe("abcd");
  });

  it("ignores a blank display name rather than labelling a run with whitespace", () => {
    expect(scopeLabel({ kind: "fmg-device", deviceName: "FGT-HQ" }, "   ")).toBe("FGT-HQ");
    expect(scopeLabel({ kind: "fmg-device", deviceName: "FGT-HQ" }, null)).toBe("FGT-HQ");
  });
});
