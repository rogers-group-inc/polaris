/**
 * tests/unit/userOwnershipService.test.ts — business rule 48(e): a deleted
 * account's rows carry a tombstone no future account can match.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import { ownershipTombstone, assertUsernameNotReserved, OWNERSHIP_TOMBSTONE_PREFIX } from "../../src/services/userOwnershipService.js";

describe("ownershipTombstone", () => {
  it("keeps the old name readable and pins it to the deleted account", () => {
    expect(ownershipTombstone("alice", "0123456789abcdef")).toBe("deleted:alice#01234567");
  });
  it("can never equal a live username, because the prefix is reserved", () => {
    const stamp = ownershipTombstone("alice", "0123456789abcdef");
    expect(stamp.startsWith(OWNERSHIP_TOMBSTONE_PREFIX)).toBe(true);
    expect(() => assertUsernameNotReserved(stamp)).toThrow(/reserved/);
    expect(() => assertUsernameNotReserved("Deleted:bob")).toThrow(/reserved/);
  });
  it("leaves ordinary names alone", () => {
    expect(() => assertUsernameNotReserved("alice")).not.toThrow();
    expect(() => assertUsernameNotReserved("undeleted:alice")).not.toThrow();
  });
});
