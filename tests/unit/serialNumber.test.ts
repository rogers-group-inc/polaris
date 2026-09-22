/**
 * tests/unit/serialNumber.test.ts
 *
 * The shared serial-usability test. The agent carries its own copy of the same
 * list (agent/internal/collectors/serialnumber.go); the last describe block in
 * this file asserts the two are identical, so a change to one fails here until
 * it is made in both.
 *
 * Reads the .go file as TEXT, so the match must tolerate either line ending:
 * .gitattributes normalizes to LF in the repo and CRLF in a Windows checkout.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  isUsableSerial,
  usableSerialOrNull,
  PLACEHOLDER_SERIALS,
  MIN_SERIAL_LENGTH,
} from "../../src/utils/serialNumber.js";

describe("isUsableSerial", () => {
  it("accepts real serials from every source that reports one", () => {
    expect(isUsableSerial("MP2YZAC2")).toBe(true); // Lenovo, SMBIOS Type 1
    expect(isUsableSerial("7XQ4P42")).toBe(true); // Dell service tag
    expect(isUsableSerial("FGT60FTK21000123")).toBe(true); // Fortinet
    expect(isUsableSerial("S248DF0000000001")).toBe(true); // FortiSwitch
    expect(isUsableSerial("VMware-56 4d 2a 1b")).toBe(true); // hypervisor-assigned
  });

  it("rejects every vendor placeholder, case- and whitespace-insensitively", () => {
    for (const junk of [
      "To Be Filled By O.E.M.",
      "TO BE FILLED BY O.E.M.",
      "  to be filled by o.e.m.  ",
      "Default string",
      "System Serial Number",
      "Not Specified",
      "Not Applicable",
      "None",
      "Unknown",
      "N/A",
      "INVALID",
      "0123456789",
      "null",
    ]) {
      expect(isUsableSerial(junk), junk).toBe(false);
    }
  });

  it("rejects a single repeated character whatever it is", () => {
    expect(isUsableSerial("00000000")).toBe(false);
    expect(isUsableSerial("XXXXXXXXXX")).toBe(false);
    expect(isUsableSerial("--------")).toBe(false);
  });

  it("rejects anything shorter than the floor, and the empty cases", () => {
    expect(isUsableSerial("AB1")).toBe(false);
    expect(isUsableSerial("")).toBe(false);
    expect(isUsableSerial("   ")).toBe(false);
    expect(isUsableSerial(null)).toBe(false);
    expect(isUsableSerial(undefined)).toBe(false);
  });

  it("does NOT reject the Windows SystemSKU shape on length alone", () => {
    // The regression this list backstops is caught in the collector, not here:
    // a SKU is long and varied enough to pass every test in this file. Stated
    // as a test so nobody adds a SKU-shaped heuristic and calls the bug fixed.
    expect(isUsableSerial("LENOVO_MT_83DG_BU_idea_FM_Legion 5 16IRX9")).toBe(true);
    expect(isUsableSerial("SKU=NotProvided;ModelName=PowerEdge R740")).toBe(true);
  });

  it("keeps the placeholder list lower-cased so the lookup can match", () => {
    for (const entry of PLACEHOLDER_SERIALS) {
      expect(entry, entry).toBe(entry.toLowerCase().trim());
      expect(entry.length, entry).toBeGreaterThan(0);
    }
    expect(MIN_SERIAL_LENGTH).toBeGreaterThan(0);
  });
});

describe("usableSerialOrNull", () => {
  it("returns the trimmed serial when it is one", () => {
    expect(usableSerialOrNull("  MP2YZAC2\n")).toBe("MP2YZAC2");
  });

  it("returns null for a placeholder, so a caller can fall through", () => {
    expect(usableSerialOrNull("To Be Filled By O.E.M.")).toBeNull();
    expect(usableSerialOrNull(null)).toBeNull();
    expect(usableSerialOrNull(undefined)).toBeNull();
  });
});

describe("the agent carries the same list", () => {
  it("agent/internal/collectors/serialnumber.go matches PLACEHOLDER_SERIALS exactly", () => {
    // Two copies of "what is not a serial" exist on purpose — the agent
    // rejects a placeholder before it goes on the wire, this end rejects what
    // older agents and the cloud sources still send. Two copies that DISAGREE
    // are how a value gets stored that one half of the system thinks is junk,
    // so the parity is asserted rather than trusted to a comment.
    const here = dirname(fileURLToPath(import.meta.url));
    const goFile = resolve(here, "../../agent/internal/collectors/serialnumber.go");
    const src = readFileSync(goFile, "utf8");

    const body = src.slice(
      src.indexOf("var placeholderSerials = map[string]struct{}{"),
      src.indexOf("const minSerialLength"),
    );
    const goEntries = new Set(
      [...body.matchAll(/^\s*"([^"]+)":\s*\{\},\s*$/gm)].map((m) => m[1]),
    );

    expect(goEntries.size).toBeGreaterThan(0);
    expect([...goEntries].sort()).toEqual([...PLACEHOLDER_SERIALS].sort());
  });

  it("the agent uses the same length floor", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const goFile = resolve(here, "../../agent/internal/collectors/serialnumber.go");
    const src = readFileSync(goFile, "utf8");
    const m = /const minSerialLength = (\d+)/.exec(src);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(MIN_SERIAL_LENGTH);
  });
});
