/**
 * tests/unit/safeText.test.ts
 *
 * The input layer that sits behind output encoding (business rule 109): names
 * keep every character a person types except control characters, and a
 * device-reported serial is stored only if it has the shape of one.
 */

import { describe, it, expect } from "vitest";
import { deviceSerialOrNull, hasNoControlChars, stripControlChars } from "../../src/utils/safeText.js";

describe("hasNoControlChars", () => {
  it.each(["Core switch", "O'Brien's \"lab\"", "München – Büro", "日本語", "a;b,c", "x');alert(1);('"])(
    "allows %j — quotes and Unicode are legal in a name",
    (name) => {
      expect(hasNoControlChars(name)).toBe(true);
    },
  );

  it.each(["a\nb", "a\rb", "a\tb", "a\u0000b", "a\u007fb", "a\u0085b", "a b", "a b", "\u001b[31m"])(
    "refuses %j",
    (name) => {
      expect(hasNoControlChars(name)).toBe(false);
    },
  );
});

describe("stripControlChars", () => {
  it("removes control characters and trims", () => {
    expect(stripControlChars("  ca\n-root\u0000.pem\r\n")).toBe("ca-root.pem");
    expect(stripControlChars("a b c")).toBe("abc");
  });

  it("leaves a clean name untouched", () => {
    expect(stripControlChars("corp-root-ca.pem")).toBe("corp-root-ca.pem");
  });

  it("returns the empty string for nothing but control characters", () => {
    expect(stripControlChars("\n\r\t")).toBe("");
  });
});

describe("deviceSerialOrNull", () => {
  it.each(["FGT60F0000000001", "S108FF5918000123", "FP231KTF24000001", "FGVM010000000001", "  FG100F0000000001  "])(
    "accepts the serial %j",
    (serial) => {
      expect(deviceSerialOrNull(serial)).toBe(serial.trim());
    },
  );

  it.each(["", "short", "has space0123456", "x');alert(1);('", "<img src=x>", "FG100F\n0000000001", "a".repeat(33), "FG-100F-0000", 12345678, null, undefined, {}])(
    "refuses %j",
    (serial) => {
      expect(deviceSerialOrNull(serial)).toBeNull();
    },
  );
});
