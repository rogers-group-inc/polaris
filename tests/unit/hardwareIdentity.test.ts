/**
 * tests/unit/hardwareIdentity.test.ts
 *
 * Every case here guards the same failure: a bad match key MERGES UNRELATED
 * MACHINES, which destroys inventory data and looks like nothing at all. The
 * placeholder list and the uniqueness guard are the two defences, and the
 * second exists specifically because the first cannot catch our own agent's
 * Windows SKU fallback (a well-formed string shared by a whole model line).
 */

import { describe, it, expect } from "vitest";
import { normalizeHardwareSerial, indexUniqueBy } from "../../src/utils/hardwareIdentity.js";

describe("normalizeHardwareSerial", () => {
  it("uppercases and collapses whitespace so two sources agree", () => {
    // Arc reports the raw SMBIOS string; the agent reads a registry value
    // some OEMs pad differently. Same machine, same key.
    expect(normalizeHardwareSerial("  vmware-56 4d  aa bb  ")).toBe("VMWARE-56 4D AA BB");
    expect(normalizeHardwareSerial("ABC123")).toBe("ABC123");
  });

  it("rejects the vendor placeholders that thousands of machines share", () => {
    for (const junk of [
      "To Be Filled By O.E.M.",
      "to be filled by oem",
      "System Serial Number",
      "Default string",
      "Not Specified",
      "None",
      "N/A",
      "unknown",
      "0123456789",
    ]) {
      expect(normalizeHardwareSerial(junk), junk).toBeNull();
    }
  });

  it("rejects all-same-character strings whatever the character", () => {
    expect(normalizeHardwareSerial("00000000")).toBeNull();
    expect(normalizeHardwareSerial("FFFFFFFF")).toBeNull();
    expect(normalizeHardwareSerial("XXXXXXXXXX")).toBeNull();
    // Separators don't rescue it — the alphanumeric core is still uniform.
    expect(normalizeHardwareSerial("0000-0000-0000")).toBeNull();
  });

  it("rejects values too short to be an identity", () => {
    expect(normalizeHardwareSerial("A1")).toBeNull();
    expect(normalizeHardwareSerial("12")).toBeNull();
    // Four characters is the floor, and a genuinely varied one passes.
    expect(normalizeHardwareSerial("A1B2")).toBe("A1B2");
  });

  it("rejects punctuation-only values", () => {
    expect(normalizeHardwareSerial("--------")).toBeNull();
    expect(normalizeHardwareSerial("........")).toBeNull();
  });

  it("rejects empty and non-string input", () => {
    expect(normalizeHardwareSerial("")).toBeNull();
    expect(normalizeHardwareSerial("   ")).toBeNull();
    expect(normalizeHardwareSerial(null)).toBeNull();
    expect(normalizeHardwareSerial(undefined)).toBeNull();
    expect(normalizeHardwareSerial(12345)).toBeNull();
  });

  it("keeps a placeholder-ADJACENT real serial", () => {
    // The list is exact-match, not substring, precisely so a real serial that
    // happens to contain one of these words survives.
    expect(normalizeHardwareSerial("NONE-4471-A")).toBe("NONE-4471-A");
    expect(normalizeHardwareSerial("DEFAULT-STRING-99")).toBe("DEFAULT-STRING-99");
  });
});

describe("indexUniqueBy", () => {
  const e = (key: string | null, id: string) => ({ key, value: { id }, id });

  it("indexes unambiguous keys", () => {
    const { index, ambiguous } = indexUniqueBy([e("AAA1", "asset-1"), e("BBB2", "asset-2")]);
    expect(index.get("AAA1")).toEqual({ id: "asset-1" });
    expect(index.get("BBB2")).toEqual({ id: "asset-2" });
    expect(ambiguous.size).toBe(0);
  });

  it("DROPS a key claimed by two different assets", () => {
    // A model SKU is a well-formed string that normalization cannot reject, so
    // the data itself has to disqualify it — merging on one would collapse every
    // machine of that model into a single asset. The motivating case was our own
    // agent (business rule 84): its Windows collector reported SystemSKU as the
    // serial until 0.20.1. That is fixed at the source now, but this guard is not
    // retired with it — un-upgraded agents still report SKUs, and a cloned VM
    // duplicates its template serial no matter what any collector does.
    const { index, ambiguous } = indexUniqueBy([
      e("MODEL-SKU-0A1B", "asset-1"),
      e("MODEL-SKU-0A1B", "asset-2"),
      e("REAL-SERIAL-1", "asset-3"),
    ]);
    expect(index.has("MODEL-SKU-0A1B")).toBe(false);
    expect(ambiguous.has("MODEL-SKU-0A1B")).toBe(true);
    // An unrelated good key is unaffected.
    expect(index.get("REAL-SERIAL-1")).toEqual({ id: "asset-3" });
  });

  it("stays dropped even if the key appears again later", () => {
    const { index } = indexUniqueBy([
      e("DUP", "asset-1"),
      e("DUP", "asset-2"),
      e("DUP", "asset-1"),
    ]);
    expect(index.has("DUP")).toBe(false);
  });

  it("tolerates the SAME asset reporting a key more than once", () => {
    // Two sources on one asset agreeing is corroboration, not a collision.
    const { index, ambiguous } = indexUniqueBy([e("AAA1", "asset-1"), e("AAA1", "asset-1")]);
    expect(index.get("AAA1")).toEqual({ id: "asset-1" });
    expect(ambiguous.size).toBe(0);
  });

  it("skips null keys without treating them as a collision", () => {
    const { index, ambiguous } = indexUniqueBy([
      e(null, "asset-1"),
      e(null, "asset-2"),
      e("GOOD1", "asset-3"),
    ]);
    expect(index.size).toBe(1);
    expect(ambiguous.size).toBe(0);
  });
});
