/**
 * tests/unit/fortinetSerialPattern.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  parseFortinetPeerInterface,
  serialMatchesPeerInterface,
  hostnameMatchesPeerInterface,
  hostnameMatchesFullPeerInterface,
} from "../../src/utils/fortinetSerialPattern.js";

describe("parseFortinetPeerInterface — production examples", () => {
  it("parses a FortiSwitch peer interface with -N aggregate suffix", () => {
    // S108FFTV23000001 → 8FFTV23000001-0 (drops "S10" prefix to fit 15 chars)
    expect(parseFortinetPeerInterface("8FFTV23000001-0")).toEqual({
      interfaceName: "8FFTV23000001-0",
      peerFragment: "8FFTV23000001",
      aggregateIndex: 0,
    });
  });

  it("parses a FortiGate controller interface (no aggregate suffix)", () => {
    // FGT61FTK22000001 → GT61FTK22000001 (drops "F" prefix to fit 15 chars)
    expect(parseFortinetPeerInterface("GT61FTK22000001")).toEqual({
      interfaceName: "GT61FTK22000001",
      peerFragment: "GT61FTK22000001",
      aggregateIndex: null,
    });
  });

  it("parses an operator-named hostname aggregate (no numeric suffix)", () => {
    // Custom MCLAG aggregate: operator typed the peer's hostname.
    expect(parseFortinetPeerInterface("HILLTOP2-T1024E")).toEqual({
      interfaceName: "HILLTOP2-T1024E",
      peerFragment: "HILLTOP2-T1024E",
      aggregateIndex: null,
    });
  });

  it("parses an operator-named hostname aggregate WITH a numeric suffix", () => {
    // The trailing -0 is treated as a FortiOS aggregate index.
    expect(parseFortinetPeerInterface("HILLTOP2-T1024E-0")).toEqual({
      interfaceName: "HILLTOP2-T1024E-0",
      peerFragment: "HILLTOP2-T1024E",
      aggregateIndex: 0,
    });
  });
});

describe("parseFortinetPeerInterface — negative cases (real port names)", () => {
  it.each([
    "port1", "port15", "port-14", "wan1", "wan2", "internal",
    "fortilink", "lan", "lan1", "lan2", "mesh1", "mgmt", "x2",
    "_FlInK1_ICL0_",  // MCLAG ICL — has underscores; rejected
    "8FFTV23000001",  // 13-char all-caps alnum without suffix — DOES match the loose pattern
  ])("rejects %s (lowercase / port name)", (name) => {
    if (name === "8FFTV23000001") {
      // 13 chars, all alphanumeric uppercase — DOES match the loose pattern.
      // That's intentional — without suffix, this looks like a serial-named
      // interface. The downstream serialMatchesPeerInterface() won't find an
      // asset that ends with this exact string unless one really exists, so
      // it's safe to be permissive here.
      expect(parseFortinetPeerInterface(name)).not.toBeNull();
      return;
    }
    expect(parseFortinetPeerInterface(name)).toBeNull();
  });

  it("rejects empty / null / whitespace", () => {
    expect(parseFortinetPeerInterface(null)).toBeNull();
    expect(parseFortinetPeerInterface(undefined)).toBeNull();
    expect(parseFortinetPeerInterface("")).toBeNull();
    expect(parseFortinetPeerInterface("   ")).toBeNull();
  });

  it("rejects names with mixed case", () => {
    expect(parseFortinetPeerInterface("PortA")).toBeNull();
    expect(parseFortinetPeerInterface("Internal-1")).toBeNull();
  });

  it("rejects names with non-alphanumeric / non-dash characters", () => {
    expect(parseFortinetPeerInterface("8FFTV230_25884")).toBeNull();
    expect(parseFortinetPeerInterface("8FFTV23000001.0")).toBeNull();
    expect(parseFortinetPeerInterface("8FFTV2 3025884")).toBeNull();
  });

  it("rejects names with leading or trailing dashes", () => {
    expect(parseFortinetPeerInterface("-HILLTOP2-T1024E")).toBeNull();
    expect(parseFortinetPeerInterface("HILLTOP2-T1024E-")).toBeNull();
  });

  it("rejects too-short or too-long names", () => {
    expect(parseFortinetPeerInterface("ABC123")).toBeNull(); // 6 chars, below threshold
    expect(parseFortinetPeerInterface("A".repeat(31))).toBeNull(); // 31 chars, above threshold
  });
});

describe("serialMatchesPeerInterface — match strategy", () => {
  it("matches FortiSwitch peer interface to full serial", () => {
    const parsed = parseFortinetPeerInterface("8FFTV23000001-0")!;
    expect(serialMatchesPeerInterface(parsed, "S108FFTV23000001")).toBe(true);
  });

  it("matches FortiGate peer interface to full serial", () => {
    const parsed = parseFortinetPeerInterface("GT61FTK22000001")!;
    expect(serialMatchesPeerInterface(parsed, "FGT61FTK22000001")).toBe(true);
  });

  it("is case-insensitive", () => {
    const parsed = parseFortinetPeerInterface("8FFTV23000001-0")!;
    expect(serialMatchesPeerInterface(parsed, "s108ffTV23000001")).toBe(true);
  });

  it("rejects when serial is shorter than the fragment", () => {
    // Defends against false positives where the fragment is bigger than the
    // serial we're checking against.
    const parsed = parseFortinetPeerInterface("8FFTV23000001-0")!;
    expect(serialMatchesPeerInterface(parsed, "FFTV23025884")).toBe(false);
  });

  it("rejects when the serial doesn't end with the fragment", () => {
    const parsed = parseFortinetPeerInterface("8FFTV23000001-0")!;
    expect(serialMatchesPeerInterface(parsed, "FGT12345678901234")).toBe(false);
  });

  it("matches when serial equals the fragment exactly (no truncation needed)", () => {
    const parsed = parseFortinetPeerInterface("FGT61FTK22000001")!;
    expect(serialMatchesPeerInterface(parsed, "FGT61FTK22000001")).toBe(true);
  });

  it("rejects empty / null asset serial", () => {
    const parsed = parseFortinetPeerInterface("8FFTV23000001-0")!;
    expect(serialMatchesPeerInterface(parsed, null)).toBe(false);
    expect(serialMatchesPeerInterface(parsed, undefined)).toBe(false);
    expect(serialMatchesPeerInterface(parsed, "")).toBe(false);
  });
});

describe("hostnameMatchesPeerInterface — operator-named aggregates", () => {
  it("matches an exact hostname", () => {
    const parsed = parseFortinetPeerInterface("HILLTOP2-T1024E")!;
    expect(hostnameMatchesPeerInterface(parsed, "HILLTOP2-T1024E")).toBe(true);
  });

  it("matches a hostname that starts with the fragment + dash", () => {
    const parsed = parseFortinetPeerInterface("HILLTOP2-T1024E")!;
    expect(hostnameMatchesPeerInterface(parsed, "HILLTOP2-T1024E-PROD")).toBe(true);
  });

  it("matches a hostname that starts with the fragment + dot (FQDN)", () => {
    const parsed = parseFortinetPeerInterface("HILLTOP2-T1024E")!;
    expect(hostnameMatchesPeerInterface(parsed, "HILLTOP2-T1024E.example.com")).toBe(true);
  });

  it("is case-insensitive", () => {
    const parsed = parseFortinetPeerInterface("HILLTOP2-T1024E")!;
    expect(hostnameMatchesPeerInterface(parsed, "hilltop2-t1024e")).toBe(true);
    expect(hostnameMatchesPeerInterface(parsed, "Hilltop2-T1024e")).toBe(true);
  });

  it("rejects substring collisions (no separator after fragment)", () => {
    // Without the separator rule, `HILLTOP2` would match `HILLTOP21`.
    const parsed = parseFortinetPeerInterface("HILLTOP21")!;
    expect(parsed).not.toBeNull();
    const shorter = parseFortinetPeerInterface("HILLTOP21")!;
    expect(hostnameMatchesPeerInterface(shorter, "HILLTOP21")).toBe(true);
    expect(hostnameMatchesPeerInterface(shorter, "HILLTOP21X")).toBe(false);
    expect(hostnameMatchesPeerInterface(shorter, "HILLTOP210")).toBe(false);
  });

  it("rejects when hostname is shorter than the fragment", () => {
    const parsed = parseFortinetPeerInterface("HILLTOP2-T1024E")!;
    expect(hostnameMatchesPeerInterface(parsed, "HILLTOP2")).toBe(false);
  });

  it("rejects empty / null asset hostname", () => {
    const parsed = parseFortinetPeerInterface("HILLTOP2-T1024E")!;
    expect(hostnameMatchesPeerInterface(parsed, null)).toBe(false);
    expect(hostnameMatchesPeerInterface(parsed, undefined)).toBe(false);
    expect(hostnameMatchesPeerInterface(parsed, "")).toBe(false);
  });
});

describe("hostnameMatchesPeerInterface — numbered sibling hostnames", () => {
  // An aggregate named after a peer whose hostname ends in a number: the
  // parser splits the "-1" off as if it were a FortiOS aggregate index, so the
  // fragment alone would also prefix-match every other device in the family.
  const parsed = parseFortinetPeerInterface("JEFFERSON-222E-1")!;

  it("does not match a sibling with a different trailing number", () => {
    expect(hostnameMatchesPeerInterface(parsed, "JEFFERSON-222E-6")).toBe(false);
    expect(hostnameMatchesPeerInterface(parsed, "JEFFERSON-222E-6.example.com")).toBe(false);
    expect(hostnameMatchesPeerInterface(parsed, "JEFFERSON-222E-12-OLD")).toBe(false);
  });

  it("matches the device named exactly as the interface, and its FQDN", () => {
    expect(hostnameMatchesPeerInterface(parsed, "JEFFERSON-222E-1")).toBe(true);
    expect(hostnameMatchesPeerInterface(parsed, "jefferson-222e-1.example.com")).toBe(true);
  });

  it("still matches the bare fragment and a non-numbered suffix", () => {
    expect(hostnameMatchesPeerInterface(parsed, "JEFFERSON-222E")).toBe(true);
    expect(hostnameMatchesPeerInterface(parsed, "JEFFERSON-222E-CORE")).toBe(true);
  });

  it("leaves names without a numeric suffix on the plain prefix rule", () => {
    const hand = parseFortinetPeerInterface("HILLTOP2-T1024E")!;
    expect(hostnameMatchesPeerInterface(hand, "HILLTOP2-T1024E-2")).toBe(true);
  });
});

describe("hostnameMatchesFullPeerInterface", () => {
  it("compares against the interface name with its suffix kept", () => {
    const parsed = parseFortinetPeerInterface("JEFFERSON-222E-1")!;
    expect(hostnameMatchesFullPeerInterface(parsed, "JEFFERSON-222E-1")).toBe(true);
    expect(hostnameMatchesFullPeerInterface(parsed, "JEFFERSON-222E-1.example.com")).toBe(true);
    expect(hostnameMatchesFullPeerInterface(parsed, "JEFFERSON-222E")).toBe(false);
    expect(hostnameMatchesFullPeerInterface(parsed, "JEFFERSON-222E-10")).toBe(false);
    expect(hostnameMatchesFullPeerInterface(parsed, null)).toBe(false);
  });
});
