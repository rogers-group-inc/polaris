/**
 * tests/unit/ifMib.test.ts — the pure IF-MIB / EtherLike-MIB enum decoders.
 */

import { describe, it, expect } from "vitest";
import { dot3DuplexLabel, ifStatusLabel, snmpIfTypeLabel } from "../../src/utils/ifMib.js";

describe("dot3DuplexLabel", () => {
  it("decodes halfDuplex(2) and fullDuplex(3)", () => {
    expect(dot3DuplexLabel(2)).toBe("half");
    expect(dot3DuplexLabel(3)).toBe("full");
  });

  it("returns null for unknown(1), a missing instance, and anything out of range", () => {
    expect(dot3DuplexLabel(1)).toBeNull();
    expect(dot3DuplexLabel(null)).toBeNull();
    expect(dot3DuplexLabel(undefined)).toBeNull();
    expect(dot3DuplexLabel(0)).toBeNull();
    expect(dot3DuplexLabel(4)).toBeNull();
  });
});

describe("ifStatusLabel", () => {
  it("decodes the RFC 2863 states and refuses unknown values", () => {
    expect(ifStatusLabel(1)).toBe("up");
    expect(ifStatusLabel(2)).toBe("down");
    expect(ifStatusLabel(7)).toBe("lowerLayerDown");
    expect(ifStatusLabel(99)).toBeNull();
    expect(ifStatusLabel(null)).toBeNull();
  });
});

describe("snmpIfTypeLabel", () => {
  it("maps the common types and leaves the rest null rather than guessing physical", () => {
    expect(snmpIfTypeLabel(6)).toBe("physical");
    expect(snmpIfTypeLabel(161)).toBe("aggregate");
    expect(snmpIfTypeLabel(71)).toBeNull();
  });
});
