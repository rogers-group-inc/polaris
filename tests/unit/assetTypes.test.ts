/**
 * tests/unit/assetTypes.test.ts — `isGenericAssetType`, the one
 * predicate every merge path (operator merge, conflict accept, duplicate-
 * hostname ghost merge) uses to decide that a Type of "other" is unclassified
 * rather than a classification, so a specific type beats it.
 */

import { describe, it, expect } from "vitest";
import { isGenericAssetType } from "../../src/utils/assetTypes.js";

describe("isGenericAssetType", () => {
  it("is true for the 'other' catch-all in any spelling", () => {
    expect(isGenericAssetType("other")).toBe(true);
    expect(isGenericAssetType(" Other ")).toBe(true);
    expect(isGenericAssetType("OTHER")).toBe(true);
  });

  it("is true for an absent value", () => {
    expect(isGenericAssetType(null)).toBe(true);
    expect(isGenericAssetType(undefined)).toBe(true);
    expect(isGenericAssetType("")).toBe(true);
  });

  it("is false for every specific type, built-in or custom", () => {
    for (const t of ["server", "switch", "workstation", "hypervisor", "kubernetes_cluster", "camera"]) {
      expect(isGenericAssetType(t)).toBe(false);
    }
  });
});
