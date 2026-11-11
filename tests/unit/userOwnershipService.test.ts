/**
 * tests/unit/userOwnershipService.test.ts — business rule 48(e): a deleted
 * account's — or a deleted API token's — rows carry a tombstone no future
 * actor can match, on EVERY model whose `createdBy` decides write reach.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const calls: { model: string; where: any; data: any }[] = [];
const deleted: { model: string; where: any }[] = [];

function ownedTable(model: string, count: number) {
  return { updateMany: vi.fn(({ where, data }: any) => { calls.push({ model, where, data }); return { count }; }) };
}

vi.mock("../../src/db.js", () => ({
  prisma: {
    subnet: ownedTable("subnet", 1),
    reservation: ownedTable("reservation", 2),
    credential: ownedTable("credential", 3),
    contact: ownedTable("contact", 4),
    asset: ownedTable("asset", 5),
    maintenanceSchedule: ownedTable("maintenanceSchedule", 6),
    pathCheck: ownedTable("pathCheck", 7),
    firmwareGroupSchedule: ownedTable("firmwareGroupSchedule", 8),
    user: { delete: vi.fn(({ where }: any) => { deleted.push({ model: "user", where }); return {}; }) },
    apiToken: { delete: vi.fn(({ where }: any) => { deleted.push({ model: "apiToken", where }); return {}; }) },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  },
}));

import {
  ownershipTombstone,
  tokenOwnershipTombstone,
  apiTokenActor,
  assertUsernameNotReserved,
  deleteUserAndTombstoneOwnership,
  deleteTokenAndTombstoneOwnership,
  tombstoneTotal,
  OWNED_MODELS,
  OWNERSHIP_TOMBSTONE_PREFIX,
} from "../../src/services/userOwnershipService.js";

beforeEach(() => {
  calls.length = 0;
  deleted.length = 0;
});

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
    expect(() => assertUsernameNotReserved("rapid")).not.toThrow();
  });
});

describe("a token is an owner too", () => {
  it("stamps a deleted token's rows with a tombstone naming the token", () => {
    expect(apiTokenActor("ci")).toBe("api:ci");
    expect(tokenOwnershipTombstone("ci", "fedcba9876543210")).toBe("deleted:api:ci#fedcba98");
  });
  it("refuses a username that could pass for a token's actor", () => {
    expect(() => assertUsernameNotReserved("api:ci")).toThrow(/reserved/);
    expect(() => assertUsernameNotReserved("API:ci")).toThrow(/reserved/);
  });
});

describe("deleteUserAndTombstoneOwnership", () => {
  it("rewrites createdBy on every owned model, then deletes the user, in one transaction", async () => {
    const counts = await deleteUserAndTombstoneOwnership({ id: "0123456789abcdef", username: "alice" });

    expect(calls.map((c) => c.model)).toEqual([...OWNED_MODELS]);
    for (const c of calls) {
      expect(c.where).toEqual({ createdBy: "alice" });
      expect(c.data).toEqual({ createdBy: "deleted:alice#01234567" });
    }
    expect(deleted).toEqual([{ model: "user", where: { id: "0123456789abcdef" } }]);
    expect(counts).toEqual({ subnets: 1, reservations: 2, credentials: 3, contacts: 4, assets: 5, maintenanceSchedules: 6, pathChecks: 7, firmwareGroupSchedules: 8 });
    expect(tombstoneTotal(counts)).toBe(36);
  });
});

describe("deleteTokenAndTombstoneOwnership", () => {
  it("rewrites the rows the token created — matched on api:<name> — then deletes the token", async () => {
    await deleteTokenAndTombstoneOwnership({ id: "fedcba9876543210", name: "ci" });

    expect(calls.map((c) => c.model)).toEqual([...OWNED_MODELS]);
    for (const c of calls) {
      expect(c.where).toEqual({ createdBy: "api:ci" });
      expect(c.data).toEqual({ createdBy: "deleted:api:ci#fedcba98" });
    }
    expect(deleted).toEqual([{ model: "apiToken", where: { id: "fedcba9876543210" } }]);
  });
  it("never touches rows a USER of the same name owns", async () => {
    await deleteTokenAndTombstoneOwnership({ id: "fedcba9876543210", name: "alice" });
    expect(calls.every((c) => c.where.createdBy === "api:alice")).toBe(true);
  });
});

/**
 * The guard against the gap this widening closed: rule 141(e) made `createdBy`
 * decide write reach on more models without adding them to the tombstone. Any
 * model handed to the write scope as a record, by a `createdBy: true` select
 * on a Prisma delegate, must be in OWNED_MODELS.
 */
describe("ownedModelsCoverage", () => {
  const SRC = join(__dirname, "..", "..", "src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== "generated") walk(p); }
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  walk(join(SRC, "services"));
  walk(join(SRC, "api"));

  it("lists every model the write scope reads createdBy from", () => {
    // Files that judge ownership: they call the write scope or assertOwnership.
    const judges = files.filter((f) => /\b(inWriteScope|assertInWriteScope|assertAllInWriteScope|assertOwnership|scheduleCanEditMap)\s*\(/.test(readFileSync(f, "utf8")));
    expect(judges.length).toBeGreaterThan(5);
    const seen = new Set<string>();
    for (const f of judges) {
      const text = readFileSync(f, "utf8");
      // prisma.<model>.find*({ ... select: { ... createdBy: true ... } ... })
      for (const m of text.matchAll(/prisma\.(\w+)\.find\w+\(\{[^;]{0,400}?createdBy:\s*true/g)) seen.add(m[1]);
    }
    const missing = [...seen].filter((m) => !(OWNED_MODELS as readonly string[]).includes(m));
    expect(missing, `models whose createdBy feeds an ownership check but are not tombstoned: ${missing.join(", ")}`).toEqual([]);
  });
});
