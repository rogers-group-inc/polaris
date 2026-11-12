import { describe, it, expect } from "vitest";
import {
  DEFAULT_PLACEHOLDER_MAC_PREFIX,
  normalizePlaceholderPrefix,
  isPlaceholderMac,
} from "../../src/utils/mac.js";

describe("normalizePlaceholderPrefix", () => {
  it("accepts any separator form and emits colon-uppercase", () => {
    for (const raw of ["02:0f:5e", "02-0F-5E", "020f5e", "02 0f 5e", "02.0f.5e"]) {
      expect(normalizePlaceholderPrefix(raw)).toBe("02:0F:5E");
    }
  });

  it("accepts 1 through 5 octets", () => {
    expect(normalizePlaceholderPrefix("02")).toBe("02");
    expect(normalizePlaceholderPrefix("02:0F:5E:11:22")).toBe("02:0F:5E:11:22");
  });

  it("rejects 6 octets — a full MAC is not a prefix", () => {
    expect(normalizePlaceholderPrefix("02:0F:5E:11:22:33")).toBeNull();
  });

  it("rejects empty, odd-length and non-hex input", () => {
    for (const raw of ["", "   ", "0", "02:0F:5", "zz:yy:xx"]) {
      expect(normalizePlaceholderPrefix(raw)).toBeNull();
    }
  });

  it("rejects non-string input rather than coercing it", () => {
    // 42 would otherwise coerce to the hex-valid prefix "42".
    for (const raw of [null, undefined, 42, {}, ["02"], true]) {
      expect(normalizePlaceholderPrefix(raw as unknown)).toBeNull();
    }
  });

  // The load-bearing rejection: a real vendor OUI would make that vendor's
  // genuine devices look like placeholders, and adoption would overwrite them.
  // Note AA:BB:CC is NOT in this list — 0xAA has the locally-administered bit
  // set, so the IEEE cannot assign it and it is a legitimate prefix.
  it("rejects a globally administered prefix", () => {
    for (const raw of ["00:50:56", "00:0C:29", "FC:AA:14", "3C:2C:30", "D4:76:A0"]) {
      expect(normalizePlaceholderPrefix(raw)).toBeNull();
    }
  });

  it("rejects a multicast prefix", () => {
    // Bit 0 set = multicast; FortiOS will not bind it as a DHCP client identity.
    expect(normalizePlaceholderPrefix("03:0F:5E")).toBeNull();
    expect(normalizePlaceholderPrefix("01:00:5E")).toBeNull();
  });

  it("accepts every locally administered unicast first octet", () => {
    for (const raw of ["02", "06", "0A", "0E", "12", "F2", "FE"]) {
      expect(normalizePlaceholderPrefix(raw)).toBe(raw);
    }
  });

  it("the shipped default is itself valid", () => {
    expect(normalizePlaceholderPrefix(DEFAULT_PLACEHOLDER_MAC_PREFIX))
      .toBe(DEFAULT_PLACEHOLDER_MAC_PREFIX);
  });
});

describe("isPlaceholderMac", () => {
  it("matches regardless of case or separator on either side", () => {
    // Reservation.macAddress is colon-LOWER from the operator paths and
    // colon-UPPER from discovery, so this has to be spelling-proof.
    expect(isPlaceholderMac("02:0f:5e:aa:bb:cc", "02:0F:5E")).toBe(true);
    expect(isPlaceholderMac("02:0F:5E:AA:BB:CC", "02-0f-5e")).toBe(true);
    expect(isPlaceholderMac("020F5EAABBCC", "020f5e")).toBe(true);
  });

  it("does not match a MAC outside the prefix", () => {
    expect(isPlaceholderMac("00:50:56:aa:bb:cc", "02:0F:5E")).toBe(false);
    expect(isPlaceholderMac("02:0F:5F:aa:bb:cc", "02:0F:5E")).toBe(false);
  });

  it("a one-octet prefix matches the whole 02: space", () => {
    expect(isPlaceholderMac("02:99:88:77:66:55", "02")).toBe(true);
    expect(isPlaceholderMac("06:99:88:77:66:55", "02")).toBe(false);
  });

  // Anything it cannot positively identify must read as a real MAC, because
  // this predicate gates an unattended overwrite.
  it("answers false for unusable input rather than guessing", () => {
    expect(isPlaceholderMac(null, "02:0F:5E")).toBe(false);
    expect(isPlaceholderMac(undefined, "02:0F:5E")).toBe(false);
    expect(isPlaceholderMac("", "02:0F:5E")).toBe(false);
    expect(isPlaceholderMac("not-a-mac", "02:0F:5E")).toBe(false);
    expect(isPlaceholderMac("00:00:00:00:00:00", "02:0F:5E")).toBe(false);
    expect(isPlaceholderMac("02:0F:5E:AA:BB:CC", "")).toBe(false);
    expect(isPlaceholderMac("02:0F:5E:AA:BB:CC", null)).toBe(false);
    // An invalid (globally administered) prefix must not silently match.
    expect(isPlaceholderMac("00:50:56:AA:BB:CC", "00:50:56")).toBe(false);
  });
});

// The generator itself is the browser's public/js/placeholder-mac.js — tested
// in placeholderMac.generate.test.ts.
