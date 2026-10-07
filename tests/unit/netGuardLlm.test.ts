/**
 * tests/unit/netGuardLlm.test.ts
 *
 * Business rule 94(g): an llm integration's "Allow loopback" lifts the SSRF
 * block for loopback ONLY. Link-local (and the cloud metadata address inside
 * it), unspecified and multicast stay refused whatever the checkbox says, and
 * with the box off loopback is refused like every other integration.
 */

import { describe, it, expect } from "vitest";
import { isLoopbackHost, isBlockedLlmHost, isBlockedOutboundHost } from "../../src/utils/netGuard.js";

describe("isLoopbackHost", () => {
  it.each(["localhost", "LOCALHOST", "ollama.localhost", "127.0.0.1", "127.10.0.5", "::1", "[::1]", "::ffff:127.0.0.1"])(
    "%s is loopback",
    (h) => expect(isLoopbackHost(h)).toBe(true),
  );
  it.each(["169.254.169.254", "0.0.0.0", "10.0.0.5", "llm.example.com", "fe80::1", "224.0.0.1", ""])(
    "%s is not loopback",
    (h) => expect(isLoopbackHost(h)).toBe(false),
  );
});

describe("isBlockedLlmHost", () => {
  it("blocks loopback unless allowLoopback is set", () => {
    expect(isBlockedLlmHost("127.0.0.1", false)).toBe(true);
    expect(isBlockedLlmHost("localhost", false)).toBe(true);
    expect(isBlockedLlmHost("127.0.0.1", true)).toBe(false);
    expect(isBlockedLlmHost("localhost", true)).toBe(false);
  });

  it("never lifts the block on metadata / link-local / unspecified / multicast", () => {
    for (const h of ["169.254.169.254", "fe80::1", "0.0.0.0", "224.0.0.1", "::"]) {
      expect(isBlockedOutboundHost(h)).toBe(true);
      expect(isBlockedLlmHost(h, true)).toBe(true);
    }
  });

  it("allows ordinary LAN and DNS targets either way", () => {
    for (const h of ["10.1.5.20", "192.168.1.9", "gpu-01.corp.example"]) {
      expect(isBlockedLlmHost(h, false)).toBe(false);
      expect(isBlockedLlmHost(h, true)).toBe(false);
    }
  });
});
