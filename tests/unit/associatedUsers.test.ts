/**
 * tests/unit/associatedUsers.test.ts — the user sightings on
 * Asset.associatedUsers and the last logged-on user (business rule 186):
 * sightings keep the SOURCE's time, only advance per account, compare
 * case-blind, and the list stays bounded.
 */

import { describe, it, expect } from "vitest";
import {
  splitAccountName,
  mergeUserSightings,
  lastLoggedOnUser,
  MAX_ASSOCIATED_USERS,
} from "../../src/utils/associatedUsers.js";

const at = (iso: string) => new Date(iso);

describe("splitAccountName", () => {
  it("keeps DOMAIN\\user apart, and a UPN or bare name whole", () => {
    expect(splitAccountName("CORP\\jdoe")).toEqual({ user: "jdoe", domain: "CORP" });
    expect(splitAccountName(" jdoe@corp.example ")).toEqual({ user: "jdoe@corp.example" });
    expect(splitAccountName("jdoe")).toEqual({ user: "jdoe" });
  });

  it("refuses an empty account and tolerates a stray slash", () => {
    expect(splitAccountName("")).toBeNull();
    expect(splitAccountName("   ")).toBeNull();
    expect(splitAccountName(null)).toBeNull();
    expect(splitAccountName("\\jdoe")).toEqual({ user: "jdoe" });
    expect(splitAccountName("CORP\\")).toEqual({ user: "CORP" });
  });
});

describe("mergeUserSightings", () => {
  it("adds a new account with the source's own time and source", () => {
    const { list, changed } = mergeUserSightings([], [{ account: "CORP\\jdoe", seenAt: at("2026-11-01T08:00:00Z"), source: "fortigate-auth" }]);
    expect(changed).toBe(true);
    expect(list).toEqual([{ user: "jdoe", domain: "CORP", lastSeen: "2026-11-01T08:00:00.000Z", source: "fortigate-auth" }]);
  });

  it("only advances: an older sighting of a known account changes nothing", () => {
    const stored = [{ user: "jdoe", domain: "CORP", lastSeen: "2026-11-02T00:00:00.000Z", source: "intune" }];
    const { list, changed } = mergeUserSightings(stored, [{ account: "CORP\\jdoe", seenAt: at("2026-11-01T00:00:00Z"), source: "device-inventory" }]);
    expect(changed).toBe(false);
    expect(list).toEqual(stored);
  });

  it("a newer sighting moves the time and takes the reporting source", () => {
    const stored = [{ user: "jdoe", domain: "CORP", lastSeen: "2026-11-01T00:00:00.000Z", source: "device-inventory" }];
    const { list, changed } = mergeUserSightings(stored, [{ account: "corp\\JDOE", seenAt: at("2026-11-03T00:00:00Z"), source: "fortigate-auth" }]);
    expect(changed).toBe(true);
    expect(list).toEqual([{ user: "JDOE", domain: "corp", lastSeen: "2026-11-03T00:00:00.000Z", source: "fortigate-auth" }]);
  });

  it("does not mutate the stored list it was given", () => {
    const stored = [{ user: "jdoe", lastSeen: "2026-11-01T00:00:00.000Z", source: "intune" }];
    mergeUserSightings(stored, [{ account: "jdoe", seenAt: at("2026-11-05T00:00:00Z"), source: "intune" }]);
    expect(stored[0].lastSeen).toBe("2026-11-01T00:00:00.000Z");
  });

  it("is newest-first and keeps only the newest MAX_ASSOCIATED_USERS", () => {
    const sightings = Array.from({ length: MAX_ASSOCIATED_USERS + 5 }, (_, i) => ({
      account: `user${i}`, seenAt: new Date(Date.UTC(2026, 10, 1, 0, i)), source: "intune",
    }));
    const { list } = mergeUserSightings([], sightings);
    expect(list).toHaveLength(MAX_ASSOCIATED_USERS);
    expect(list[0].user).toBe(`user${MAX_ASSOCIATED_USERS + 4}`);
    expect(list.some((u) => u.user === "user0")).toBe(false);
  });

  it("skips empty accounts and invalid times, and tolerates a junk stored value", () => {
    const { list, changed } = mergeUserSightings("not a list", [
      { account: "", seenAt: at("2026-11-01T00:00:00Z"), source: "intune" },
      { account: "jdoe", seenAt: new Date(NaN), source: "intune" },
    ]);
    expect(changed).toBe(false);
    expect(list).toEqual([]);
  });
});

describe("lastLoggedOnUser", () => {
  it("is the newest entry whatever the stored order", () => {
    expect(lastLoggedOnUser([
      { user: "a", lastSeen: "2026-11-01T00:00:00Z", source: "intune" },
      { user: "b", lastSeen: "2026-11-03T00:00:00Z", source: "fortigate-auth" },
      { user: "c", lastSeen: "2026-11-02T00:00:00Z", source: "device-inventory" },
    ])?.user).toBe("b");
  });

  it("is null for nothing", () => {
    expect(lastLoggedOnUser([])).toBeNull();
    expect(lastLoggedOnUser(null)).toBeNull();
  });
});
