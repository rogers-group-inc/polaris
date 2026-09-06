/**
 * Per-user display timezone.
 *
 * The pure halves are tested here because every one of them fails SILENTLY in
 * the direction that matters:
 *
 *   - a resolution order that skips `detectedTimezone` sends every default
 *     account its email on the SERVER's clock, which is the exact misreading
 *     the column set exists to stop — and the email still arrives, so nothing
 *     reports it;
 *   - a `splitTimeZoneGroups` that groups wrongly either mails somebody the
 *     wrong wall clock or fans one alert out into a copy per person, and both
 *     look like a working alert from the outside;
 *   - `retimeContext` losing a token blanks a row out of the body rather than
 *     erroring.
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
import { splitTimeZoneGroups } from "../../src/services/notificationRecipientService.js";
import { formatLocalTime, retimeContext } from "../../src/utils/notificationTemplate.js";
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

describe("retimeContext", () => {
  const iso = "2026-08-12T18:46:00.000Z";

  it("re-derives time.local from the ISO token", () => {
    const ctx = { time: iso, "time.local": formatLocalTime(iso, "UTC"), asset: "sw1" };
    const out = retimeContext(ctx, "America/Chicago");
    expect(out["time.local"]).toBe(formatLocalTime(iso, "America/Chicago"));
    // Everything else survives untouched — this rebuilds one token, not a ctx.
    expect(out.asset).toBe("sw1");
    expect(out.time).toBe(iso);
  });

  it("leaves a context with no usable time alone", () => {
    // A pre-upgrade Notification.templateCtx keeps whatever it was stored
    // with rather than being blanked.
    const ctx = { "time.local": "Aug 12, 2026, 1:46 PM CDT" };
    expect(retimeContext(ctx, "America/Denver")).toBe(ctx);
  });

  it("does not mutate its input", () => {
    const ctx = { time: iso, "time.local": "x" };
    retimeContext(ctx, "America/Chicago");
    expect(ctx["time.local"]).toBe("x");
  });
});

describe("splitTimeZoneGroups", () => {
  const zones = new Map([
    ["chi@example.com", "America/Chicago"],
    ["chi2@example.com", "America/Chicago"],
    ["ny@example.com", "America/New_York"],
  ]);

  it("returns ONE group when every recipient agrees", () => {
    // The ordinary fleet. Splitting here would fan one alert out into a copy
    // per person, which business rule 25 retired.
    const g = splitTimeZoneGroups(["chi@example.com", "chi2@example.com"], [], [], zones, "UTC");
    expect(g).toHaveLength(1);
    expect(g[0]!.timeZone).toBe("America/Chicago");
    expect(g[0]!.to).toEqual(["chi@example.com", "chi2@example.com"]);
  });

  it("splits only when the readers genuinely disagree", () => {
    const g = splitTimeZoneGroups(["chi@example.com", "ny@example.com"], [], [], zones, "UTC");
    expect(g).toHaveLength(2);
    expect(g.map((x) => x.timeZone)).toEqual(["America/Chicago", "America/New_York"]);
  });

  it("falls unknown addresses back to the fallback zone", () => {
    // A typed address or an address-book contact owns no account, so there is
    // no zone to read — it gets what every recipient got before this existed.
    const g = splitTimeZoneGroups(["typed@example.com"], [], [], zones, "UTC");
    expect(g).toHaveLength(1);
    expect(g[0]!.timeZone).toBe("UTC");
  });

  it("groups an empty map into exactly one send", () => {
    // The no-op path: a caller that cannot rebuild its body per zone must
    // produce the single row the composed path always did.
    const g = splitTimeZoneGroups(["a@x.com", "b@y.com"], ["c@z.com"], [], new Map(), "UTC");
    expect(g).toHaveLength(1);
    expect(g[0]!.to).toEqual(["a@x.com", "b@y.com"]);
    expect(g[0]!.cc).toEqual(["c@z.com"]);
  });

  it("groups Cc and Bcc on the same key as To", () => {
    // An address is mailed in its OWNER's zone whichever line it sits on, so
    // nobody gets two copies and a Cc'd reader sees the same wall clock.
    const g = splitTimeZoneGroups(["chi@example.com"], ["ny@example.com"], ["chi2@example.com"], zones, "UTC");
    const chi = g.find((x) => x.timeZone === "America/Chicago")!;
    const ny = g.find((x) => x.timeZone === "America/New_York")!;
    expect(chi.to).toEqual(["chi@example.com"]);
    expect(chi.bcc).toEqual(["chi2@example.com"]);
    expect(ny.to).toEqual([]);
    expect(ny.cc).toEqual(["ny@example.com"]);
  });

  it("matches addresses case- and whitespace-insensitively", () => {
    const g = splitTimeZoneGroups(["  CHI@Example.com "], [], [], zones, "UTC");
    expect(g[0]!.timeZone).toBe("America/Chicago");
  });

  it("leads with the primary recipients' zone", () => {
    // Insertion order is first appearance across to, then cc, then bcc.
    const g = splitTimeZoneGroups(["ny@example.com"], ["chi@example.com"], [], zones, "UTC");
    expect(g[0]!.timeZone).toBe("America/New_York");
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
