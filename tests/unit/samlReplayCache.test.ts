/**
 * tests/unit/samlReplayCache.test.ts
 *
 * Business rule 108 / F242: one signed assertion signs in once. samlReplay
 * .test.ts covers claim/replay/empty-id and the TTL boundary; this pins the
 * expiry pruning and the 5000-entry bound (oldest evicted first).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { claimSamlAssertion, clearSamlReplayCache, SAML_REPLAY_TTL_MS } from "../../src/utils/samlReplayCache.js";

const T0 = Date.UTC(2026, 5, 1);

beforeEach(() => clearSamlReplayCache());

describe("claimSamlAssertion", () => {
  it("remembers for one hour", () => {
    expect(SAML_REPLAY_TTL_MS).toBe(3_600_000);
  });

  it("accepts the same id again exactly at expiry", () => {
    expect(claimSamlAssertion("_a", T0)).toBe(true);
    expect(claimSamlAssertion("_a", T0 + SAML_REPLAY_TTL_MS)).toBe(true);
    expect(claimSamlAssertion("_a", T0 + SAML_REPLAY_TTL_MS + 1)).toBe(false);
  });

  it("bounds the cache at 5000 entries, evicting the oldest first", () => {
    for (let i = 0; i < 5001; i++) expect(claimSamlAssertion(`_id${i}`, T0 + i)).toBe(true);
    // The 5001st insert left 5001 entries; the next claim's prune drops the oldest one.
    expect(claimSamlAssertion("_fresh", T0 + 5001)).toBe(true);
    expect(claimSamlAssertion("_id0", T0 + 5002)).toBe(true);   // evicted → accepted again
    expect(claimSamlAssertion("_id4999", T0 + 5003)).toBe(false); // recent → still a replay
  });

  it("clearSamlReplayCache forgets every id", () => {
    claimSamlAssertion("_x", T0);
    clearSamlReplayCache();
    expect(claimSamlAssertion("_x", T0)).toBe(true);
  });
});
