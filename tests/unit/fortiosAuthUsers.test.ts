/**
 * tests/unit/fortiosAuthUsers.test.ts — a FortiGate's authenticated-user
 * table as user sightings (business rule 186): sessions are parsed with every
 * known field name, and joined ONLY to the same gate's single online
 * inventory row at the session's address — never by address alone.
 */

import { describe, it, expect } from "vitest";
import { parseFortiosAuthSessions, attachAuthUsers } from "../../src/utils/fortiosAuthUsers.js";

describe("parseFortiosAuthSessions", () => {
  it("reads each known spelling of the address and the user", () => {
    expect(parseFortiosAuthSessions([
      { username: "CORP\\jdoe", ipaddr: "10.1.0.40", type: "fsso" },
      { user_name: "asmith", ip: "10.1.0.41" },
      { user: "guest1", ipv4_address: "10.1.0.42" },
    ])).toEqual([
      { ipAddress: "10.1.0.40", user: "CORP\\jdoe" },
      { ipAddress: "10.1.0.41", user: "asmith" },
      { ipAddress: "10.1.0.42", user: "guest1" },
    ]);
  });

  it("drops IPv6 sessions, rows missing either half, and anything that is not a list", () => {
    expect(parseFortiosAuthSessions([
      { username: "a", ipaddr: "2001:db8::1" },
      { username: "", ipaddr: "10.0.0.1" },
      { username: "b" },
      null,
    ])).toEqual([]);
    expect(parseFortiosAuthSessions(undefined)).toEqual([]);
    expect(parseFortiosAuthSessions({ results: [] })).toEqual([]);
  });
});

describe("attachAuthUsers", () => {
  const row = (ipAddress: string, isOnline = true) => ({ ipAddress, isOnline } as { ipAddress: string; isOnline: boolean; authUser?: string });

  it("puts a session on the one online row at its address", () => {
    const rows = [row("10.1.0.40"), row("10.1.0.41")];
    expect(attachAuthUsers(rows, [{ ipAddress: "10.1.0.40", user: "CORP\\jdoe" }])).toEqual({ matched: 1, unmatched: 0 });
    expect(rows[0].authUser).toBe("CORP\\jdoe");
    expect(rows[1].authUser).toBeUndefined();
  });

  it("never matches an offline row — its address may already belong to someone else", () => {
    const rows = [row("10.1.0.40", false)];
    expect(attachAuthUsers(rows, [{ ipAddress: "10.1.0.40", user: "jdoe" }])).toEqual({ matched: 0, unmatched: 1 });
    expect(rows[0].authUser).toBeUndefined();
  });

  it("an address two online rows claim decides nothing", () => {
    const rows = [row("10.1.0.40"), row("10.1.0.40")];
    expect(attachAuthUsers(rows, [{ ipAddress: "10.1.0.40", user: "jdoe" }])).toEqual({ matched: 0, unmatched: 1 });
    expect(rows.every((r) => r.authUser === undefined)).toBe(true);
  });

  it("an address with sessions for two different users decides nothing; the same user twice is one", () => {
    const a = [row("10.1.0.40")];
    expect(attachAuthUsers(a, [{ ipAddress: "10.1.0.40", user: "jdoe" }, { ipAddress: "10.1.0.40", user: "asmith" }])).toEqual({ matched: 0, unmatched: 1 });
    const b = [row("10.1.0.40")];
    expect(attachAuthUsers(b, [{ ipAddress: "10.1.0.40", user: "JDOE" }, { ipAddress: "10.1.0.40", user: "jdoe" }])).toEqual({ matched: 1, unmatched: 0 });
    expect(b[0].authUser).toBe("JDOE");
  });

  it("a session with no row is counted as unmatched", () => {
    expect(attachAuthUsers([], [{ ipAddress: "10.9.9.9", user: "jdoe" }])).toEqual({ matched: 0, unmatched: 1 });
  });
});
