/**
 * Display timezone — the per-user setting, and the zone an alert email says
 * it is written in.
 *
 * The pure halves are tested here because each fails SILENTLY in the direction
 * that matters: a wrong resolution order shows an operator the wrong wall
 * clock in the UI, and a `describeTimeZone` that comes back empty or wrong
 * mails a perfectly deliverable alert whose reader cannot tell 1:46 PM in
 * Nashville from 1:46 PM anywhere else.
 *
 * The email path itself no longer renders per recipient at all (business rule
 * 25 — one message, one To line, the install's clock); `describeTimeZone` is
 * what pays for that, so it is pinned hardest.
 */
import { describe, it, expect } from "vitest";
import {
  AUTO_TIMEZONE,
  isValidTimeZone,
  listTimeZones,
  normalizeUserTimezone,
  resolveTimeZone,
  serverTimeZone,
} from "../../src/services/userTimezoneService.js";
import { buildTemplateContext, describeTimeZone, formatLocalTime } from "../../src/utils/notificationTemplate.js";
import { lockoutRemaining } from "../../src/utils/loginLockout.js";

describe("normalizeUserTimezone", () => {
  it("passes a real IANA zone through", () => {
    expect(normalizeUserTimezone("America/Chicago")).toBe("America/Chicago");
    expect(normalizeUserTimezone("UTC")).toBe("UTC");
  });

  it("degrades anything unusable to auto rather than throwing", () => {
    // Read on the alerting path from a plain TEXT column: a row holding
    // something this build's ICU can't apply must fall back, not fail a send.
    for (const junk of [null, undefined, "", "  ", "Mars/Olympus", 3, {}, []]) {
      expect(normalizeUserTimezone(junk)).toBe(AUTO_TIMEZONE);
    }
  });

  it("treats the literal auto as auto", () => {
    expect(normalizeUserTimezone("auto")).toBe(AUTO_TIMEZONE);
  });
});

describe("isValidTimeZone", () => {
  it("accepts zones this build can format in and rejects the rest", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Nowhere/Nothing")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("resolveTimeZone", () => {
  it("prefers the explicit choice over everything", () => {
    expect(resolveTimeZone("America/Denver", "America/Chicago")).toBe("America/Denver");
  });

  it("falls to the browser-detected zone when the account is on auto", () => {
    // THE test of the feature. Almost nobody opens the picker, so if this
    // step is skipped every default account keeps receiving email on the
    // server's clock and the whole change is inert.
    expect(resolveTimeZone("auto", "America/Chicago")).toBe("America/Chicago");
    expect(resolveTimeZone(null, "America/Chicago")).toBe("America/Chicago");
  });

  it("falls to the server zone only when there is nothing else", () => {
    // An account that has never signed in on a browser — a service account on
    // a distribution list. This is the pre-column behaviour.
    expect(resolveTimeZone("auto", null)).toBe(serverTimeZone());
    expect(resolveTimeZone("auto", "Mars/Olympus")).toBe(serverTimeZone());
    expect(resolveTimeZone(undefined, undefined)).toBe(serverTimeZone());
  });
});

describe("listTimeZones", () => {
  it("offers a non-empty list that normalizes back to itself", () => {
    const zones = listTimeZones();
    expect(zones.length).toBeGreaterThan(0);
    // Whatever the picker offers must survive a round trip through the
    // read-side normalizer, or choosing it would silently store "auto".
    for (const z of zones.slice(0, 25)) expect(normalizeUserTimezone(z)).toBe(z);
  });
});

describe("formatLocalTime", () => {
  const t = new Date("2026-08-12T18:46:00Z");

  it("renders the same instant differently per zone, and labels both", () => {
    const chi = formatLocalTime(t, "America/Chicago");
    const ny = formatLocalTime(t, "America/New_York");
    expect(chi).not.toBe(ny);
    // The zone label is not decoration: it is the only thing that lets two
    // operators comparing copies of one alert tell them apart.
    expect(chi).toMatch(/C[DS]T/);
    expect(ny).toMatch(/E[DS]T/);
  });

  it("still renders when the zone is unusable", () => {
    // A bad User.timezone must cost the reader the label they asked for, never
    // the timestamp — and never the send.
    const out = formatLocalTime(t, "Mars/Olympus");
    expect(out).toBeTruthy();
    expect(out).toBe(formatLocalTime(t));
  });

  it("returns empty for unparseable input rather than Invalid Date", () => {
    expect(formatLocalTime(null)).toBe("");
    expect(formatLocalTime("not a date")).toBe("");
  });
});

describe("describeTimeZone", () => {
  const summer = new Date("2026-08-12T18:46:00Z");
  const winter = new Date("2026-01-12T18:46:00Z");

  it("names the abbreviation AND the IANA zone", () => {
    // Both halves, because neither is enough alone: "CST" names zones six
    // hours apart depending on who is reading it, and an operator who has
    // never seen "America/Chicago" written down still recognizes "CDT".
    expect(describeTimeZone(summer, "America/Chicago")).toBe("CDT (America/Chicago)");
    expect(describeTimeZone(summer, "Asia/Kolkata")).toContain("(Asia/Kolkata)");
  });

  it("labels the alert's own instant, not today's", () => {
    // An escalation re-rendering a July alert in December must not relabel it.
    expect(describeTimeZone(summer, "America/Chicago")).toBe("CDT (America/Chicago)");
    expect(describeTimeZone(winter, "America/Chicago")).toBe("CST (America/Chicago)");
  });

  it("falls back to the install's own zone when none is given", () => {
    // Which is every caller today — the email renders install-wide.
    const out = describeTimeZone(summer, null);
    expect(out).toBeTruthy();
    expect(out).toContain(serverTimeZone());
  });

  it("degrades to something legible rather than throwing", () => {
    // A zone this build's ICU cannot apply must never cost a send.
    const out = describeTimeZone(summer, "Mars/Olympus");
    expect(out).toContain("Mars/Olympus");
    expect(describeTimeZone(null, "America/Chicago")).toBeTruthy();
    expect(describeTimeZone("not a date", "America/Chicago")).toBeTruthy();
  });

  it("agrees with the abbreviation stamped on {time.local}", () => {
    // The whole point of the footer line: it explains the suffix the reader is
    // already looking at, so the two may never be rendered from different
    // zones. buildTemplateContext derives both from the same argument.
    const ctx = buildTemplateContext({ time: summer, timeZone: "America/Chicago" } as never);
    expect(ctx["time.local"]).toContain("CDT");
    expect(ctx["time.zone"]).toBe("CDT (America/Chicago)");
  });
});

describe("lockoutRemaining", () => {
  const now = new Date("2026-08-12T18:00:00Z");

  it("states a duration, never a wall-clock time", () => {
    // The message is produced BEFORE authentication, so there is no account
    // whose zone we could render in — and looking one up by the submitted
    // username would make this an account-existence oracle.
    expect(lockoutRemaining(new Date("2026-08-12T18:12:00Z"), now)).toBe("12 minutes");
    expect(lockoutRemaining(new Date("2026-08-12T18:01:00Z"), now)).toBe("1 minute");
  });

  it("rounds up so it never invites a retry that is still locked", () => {
    expect(lockoutRemaining(new Date("2026-08-12T18:00:30Z"), now)).toBe("1 minute");
    expect(lockoutRemaining(new Date("2026-08-12T18:11:01Z"), now)).toBe("12 minutes");
  });

  it("degrades rather than throwing on a missing or past deadline", () => {
    expect(lockoutRemaining(undefined, now)).toBe("later");
    expect(lockoutRemaining(new Date("2026-08-12T17:59:00Z"), now)).toBe("now");
  });
});
