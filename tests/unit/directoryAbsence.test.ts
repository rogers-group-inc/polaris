/**
 * tests/unit/directoryAbsence.test.ts
 *
 * The three decisions behind the AD / Entra disappearance sweep (business
 * rule 69): is this directory read trustworthy at all, which existing source
 * rows really vanished (as opposed to being filtered out or switched off),
 * and is the resulting delete set too large to be ordinary turnover.
 *
 * The sweep itself is DB-bound and lives inside a private helper in
 * discoveryEngine.ts; these are the parts that decide whether a fleet gets
 * decommissioned, so they are pure on purpose.
 */

import { describe, it, expect } from "vitest";

import { classifyDirectoryRows, absenceExceedsGuard } from "../../src/utils/directoryAbsence.js";
import { adSweepBlockedReason } from "../../src/services/activeDirectoryService.js";
import { entraSweepBlockedReason } from "../../src/services/entraIdService.js";

const row = (externalId: string) => ({ externalId, id: `src-${externalId}` });

describe("classifyDirectoryRows", () => {
  it("sorts rows into alive / gone / disabled", () => {
    const rows = [row("a"), row("b"), row("c")];
    const fates = classifyDirectoryRows(rows, ["a", "b"], ["b"]);
    expect(fates.alive.map((r) => r.externalId)).toEqual(["a"]);
    expect(fates.disabled.map((r) => r.externalId)).toEqual(["b"]);
    expect(fates.gone.map((r) => r.externalId)).toEqual(["c"]);
  });

  it("matches case-insensitively — neither directory promises the case it returns", () => {
    const fates = classifyDirectoryRows([row("ABC-123")], ["abc-123"], []);
    expect(fates.alive).toHaveLength(1);
    expect(fates.gone).toHaveLength(0);
  });

  it("keeps a device the operator's filter excluded — present, just not synced", () => {
    // `present` is the RAW read; a device dropped by deviceExclude / ouExclude
    // is still in it, so the row is alive rather than swept. Re-widening the
    // filter must find the same asset, not a new one.
    const fates = classifyDirectoryRows([row("filtered-out")], ["filtered-out"], []);
    expect(fates.gone).toHaveLength(0);
    expect(fates.alive).toHaveLength(1);
  });

  it("calls a disabled device disabled, not gone, even when includeDisabled skipped it", () => {
    // includeDisabled=false drops the device before the sync sees it, but the
    // raw read still lists it — the asset is decommissioned and the source row
    // is KEPT, because the device has not left the directory.
    const fates = classifyDirectoryRows([row("off")], ["off"], ["off"]);
    expect(fates.disabled.map((r) => r.externalId)).toEqual(["off"]);
    expect(fates.gone).toHaveLength(0);
  });

  it("treats an empty present set as everything gone (the caller's gate, not ours)", () => {
    const fates = classifyDirectoryRows([row("a"), row("b")], [], []);
    expect(fates.gone).toHaveLength(2);
  });
});

describe("absenceExceedsGuard", () => {
  it("allows ordinary turnover on a small fleet — the floor, not the ratio, decides", () => {
    // 20% of 40 is 8, which would refuse retiring a couple of laptops.
    expect(absenceExceedsGuard(8, 40)).toBe(false);
    expect(absenceExceedsGuard(50, 40)).toBe(false);
  });

  it("refuses a categorical shrink on a large fleet", () => {
    // A narrowed baseDn or a half-revoked grant returns a complete, non-empty,
    // well-formed read missing most of the estate — nothing else catches it.
    expect(absenceExceedsGuard(1200, 2000)).toBe(true);
    expect(absenceExceedsGuard(401, 2000)).toBe(true);
    expect(absenceExceedsGuard(400, 2000)).toBe(false);
  });
});

describe("adSweepBlockedReason", () => {
  const whole = { presentObjectGuids: ["a"], inventoryComplete: true, scoped: false };

  it("trusts a whole read", () => {
    expect(adSweepBlockedReason(whole)).toBeNull();
  });

  it("names the scoped run first, so the reason is not a plausible lie", () => {
    expect(adSweepBlockedReason({ ...whole, scoped: true, inventoryComplete: false })).toMatch(/scoped/);
  });

  it("refuses an incomplete read", () => {
    expect(adSweepBlockedReason({ ...whole, inventoryComplete: false })).toMatch(/incomplete/);
  });

  it("refuses an empty read — a bind or baseDn answer far more often than an emptied domain", () => {
    expect(adSweepBlockedReason({ ...whole, presentObjectGuids: [] })).toMatch(/empty/);
  });
});

describe("entraSweepBlockedReason", () => {
  const whole = { presentDeviceIds: ["a"], inventoryComplete: true, scoped: false };

  it("trusts a whole read", () => {
    expect(entraSweepBlockedReason(whole)).toBeNull();
  });

  it("names the scoped run first", () => {
    expect(entraSweepBlockedReason({ ...whole, scoped: true, inventoryComplete: false })).toMatch(/scoped/);
  });

  it("refuses a cancelled or capped read", () => {
    expect(entraSweepBlockedReason({ ...whole, inventoryComplete: false })).toMatch(/incomplete/);
  });

  it("refuses an empty tenant read — usually a consent answer", () => {
    expect(entraSweepBlockedReason({ ...whole, presentDeviceIds: [] })).toMatch(/empty/);
  });
});
