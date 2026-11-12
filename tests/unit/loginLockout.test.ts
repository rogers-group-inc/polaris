/**
 * tests/unit/loginLockout.test.ts
 *
 * Per-username lockout: 5 failures inside a 15-minute window lock the account
 * for 15 minutes; names are trimmed + case-folded; a stale window starts over;
 * clearLockout wipes it. lockoutRemaining's phrasing is covered in
 * userTimezone.test.ts — only its edges are here. The module keeps state and
 * starts a cleanup interval on import, so each test loads a fresh copy under
 * fake timers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Mod = typeof import("../../src/utils/loginLockout.js");
let m: Mod;

const T0 = new Date("2026-03-01T12:00:00Z");
const MIN = 60_000;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.resetModules();
  m = await import("../../src/utils/loginLockout.js");
});
afterEach(() => vi.useRealTimers());

function fail(name: string, n: number) {
  let last: ReturnType<Mod["recordFailure"]> | undefined;
  for (let i = 0; i < n; i++) last = m.recordFailure(name);
  return last!;
}

describe("recordFailure / isLocked", () => {
  it("counts failures and locks on the 5th for 15 minutes", () => {
    expect(fail("alice", 4)).toEqual({ lockedNow: false, failures: 4 });
    expect(m.isLocked("alice")).toEqual({ locked: false });
    const r = m.recordFailure("alice");
    expect(r.lockedNow).toBe(true);
    expect(r.failures).toBe(5);
    expect(r.until?.getTime()).toBe(T0.getTime() + 15 * MIN);
    expect(m.isLocked("alice")).toEqual({ locked: true, until: new Date(T0.getTime() + 15 * MIN) });
  });

  it("unlocks once the lockout has run", () => {
    fail("bob", 5);
    vi.setSystemTime(T0.getTime() + 15 * MIN - 1);
    expect(m.isLocked("bob").locked).toBe(true);
    vi.setSystemTime(T0.getTime() + 15 * MIN);
    expect(m.isLocked("bob").locked).toBe(false);
  });

  it("treats usernames case- and whitespace-insensitively", () => {
    fail("Carol", 2);
    fail("  carol ", 2);
    expect(m.recordFailure("CAROL").lockedNow).toBe(true);
    expect(m.isLocked("carol").locked).toBe(true);
  });

  it("starts a fresh window when the first failure is older than 15 minutes", () => {
    fail("dave", 4);
    vi.setSystemTime(T0.getTime() + 15 * MIN + 1);
    expect(m.recordFailure("dave")).toEqual({ lockedNow: false, failures: 1 });
  });

  it("keeps counting inside the window", () => {
    fail("erin", 4);
    vi.setSystemTime(T0.getTime() + 15 * MIN);
    expect(m.recordFailure("erin").lockedNow).toBe(true);
  });

  it("is per account", () => {
    fail("frank", 5);
    expect(m.isLocked("grace").locked).toBe(false);
  });
});

describe("clearLockout", () => {
  it("clears the counter and an active lockout", () => {
    fail("heidi", 5);
    m.clearLockout(" HEIDI ");
    expect(m.isLocked("heidi").locked).toBe(false);
    expect(m.recordFailure("heidi").failures).toBe(1);
  });
});

describe("periodic cleanup", () => {
  it("drops stale entries every 10 minutes so the next failure starts at 1", () => {
    fail("ivan", 3);
    // The window is 15 min; the 20-minute sweep is the first that sees it stale.
    vi.advanceTimersByTime(20 * MIN);
    expect(m.isLocked("ivan").locked).toBe(false);
    expect(m.recordFailure("ivan").failures).toBe(1);
  });

  it("keeps an entry whose lockout is still running", () => {
    fail("judy", 5);
    vi.advanceTimersByTime(10 * MIN);
    expect(m.isLocked("judy").locked).toBe(true);
  });
});

describe("lockoutRemaining edges", () => {
  it("says 'later' with no unlock time and 'now' once it has passed", () => {
    expect(m.lockoutRemaining(undefined)).toBe("later");
    expect(m.lockoutRemaining(new Date(T0.getTime() - 1), T0)).toBe("now");
    expect(m.lockoutRemaining(T0, T0)).toBe("now");
  });

  it("rounds a sub-minute remainder up to 1 minute", () => {
    expect(m.lockoutRemaining(new Date(T0.getTime() + 1), T0)).toBe("1 minute");
  });

  it("defaults now to the current clock", () => {
    expect(m.lockoutRemaining(new Date(T0.getTime() + 3 * MIN))).toBe("3 minutes");
  });
});
