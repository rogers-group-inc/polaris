/**
 * tests/unit/placeholderMac.generate.test.ts
 *
 * The reserve modals' "Generate" MAC button — public/js/placeholder-mac.js
 * (`window.PolarisPlaceholderMac.generate`), shared by the desktop IP panel
 * and the mobile subnet sheet. This is the only generator: the server never
 * mints a placeholder MAC, it only recognizes one (isPlaceholderMac in
 * src/utils/mac.ts), so the last case checks the two agree.
 *
 * The script is an IIFE that writes onto `window`; it runs in a vm context
 * whose `window.crypto` is either a deterministic byte sequence or Node's real
 * WebCrypto.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { DEFAULT_PLACEHOLDER_MAC_PREFIX, isPlaceholderMac } from "../../src/utils/mac.js";

const SRC = readFileSync(resolve(__dirname, "../../public/js/placeholder-mac.js"), "utf8");

type Gen = (prefix?: unknown) => string;

/** Load the script with `getRandomValues` filling from `bytes`, or real crypto. */
function load(bytes?: number[]): { generate: Gen; DEFAULT_PREFIX: string } {
  const crypto = bytes
    ? { getRandomValues: (arr: Uint8Array) => { for (let i = 0; i < arr.length; i++) arr[i] = bytes[i]!; return arr; } }
    : webcrypto;
  const win: Record<string, unknown> = { crypto };
  vm.runInNewContext(SRC, { window: win, Uint8Array });
  return win.PolarisPlaceholderMac as { generate: Gen; DEFAULT_PREFIX: string };
}

describe("placeholder-mac.js generate", () => {
  it("keeps the prefix and fills out to six octets", () => {
    const mac = load([0xaa, 0xbb, 0xcc]).generate("02:0F:5E");
    expect(mac).toBe("02:0F:5E:AA:BB:CC");
    expect(mac.split(":")).toHaveLength(6);
  });

  it("pads single-digit octets", () => {
    expect(load([0x01, 0x02, 0x03]).generate("02:0F:5E")).toBe("02:0F:5E:01:02:03");
  });

  it("works for any accepted prefix length", () => {
    expect(load([1, 2, 3, 4, 5]).generate("02")).toBe("02:01:02:03:04:05");
    expect(load([0x33]).generate("02:0F:5E:11:22")).toBe("02:0F:5E:11:22:33");
  });

  it("falls back to the default rather than throwing on a bad prefix", () => {
    // Runs behind a UI button — refusing to produce a MAC because a stored
    // setting drifted would be worse than producing a correct one.
    const { generate } = load([1, 2, 3]);
    for (const bad of ["00:50:56", "zz", "", null, undefined]) {
      expect(generate(bad).startsWith(DEFAULT_PLACEHOLDER_MAC_PREFIX)).toBe(true);
    }
  });

  it("carries the same default prefix as the server", () => {
    expect(load().DEFAULT_PREFIX).toBe(DEFAULT_PLACEHOLDER_MAC_PREFIX);
  });

  it("produces a MAC the server's placeholder predicate recognizes", () => {
    const mac = load().generate("02:0F:5E");
    expect(isPlaceholderMac(mac, "02:0F:5E")).toBe(true);
  });

  it("uses real randomness", () => {
    const { generate } = load();
    const macs = new Set(Array.from({ length: 50 }, () => generate("02:0F:5E")));
    expect(macs.size).toBeGreaterThan(45);
  });
});
