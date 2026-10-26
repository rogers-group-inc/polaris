/**
 * tests/unit/interfaceTagService.test.ts
 *
 * The pure half of interface tagging (business rule 133): which names an
 * operator may hand-apply to a port. The DB-bound half — the manual/auto split,
 * the filter-applied rows and the rename — is tests/integration/interfaceTags.test.ts.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const { normalizeInterfaceTags } = await import("../../src/services/interfaceTagService.js");

describe("normalizeInterfaceTags", () => {
  it("trims, drops blanks and dedupes case-insensitively, first casing kept", () => {
    expect(normalizeInterfaceTags([" Uplink ", "", "uplink", "PoE"])).toEqual(["Uplink", "PoE"]);
  });

  it("reads a non-array as no tags", () => {
    expect(normalizeInterfaceTags(undefined)).toEqual([]);
    expect(normalizeInterfaceTags("Uplink")).toEqual([]);
  });

  // Both namespaces tag DEVICES and are owned by another reconciler; on a port
  // they would mean nothing and no engine would ever remove them.
  it("refuses the region: and azure: namespaces, in any case", () => {
    expect(() => normalizeInterfaceTags(["region:Atlanta"])).toThrow(/system-managed/);
    expect(() => normalizeInterfaceTags(["REGION:Atlanta"])).toThrow(/system-managed/);
    expect(() => normalizeInterfaceTags(["azure:env=prod"])).toThrow(/system-managed/);
  });

  it("refuses an over-long tag", () => {
    expect(() => normalizeInterfaceTags(["x".repeat(500)])).toThrow();
  });
});
