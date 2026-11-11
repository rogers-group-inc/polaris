/**
 * Per-user notification preference (business rule 39).
 *
 * The two pure halves are tested here because both fail SILENTLY in the
 * direction that matters: getting `preferenceAllowsTransport` backwards, or
 * letting an unknown value fall through to "deny", removes recipients from an
 * alert and nothing anywhere reports the omission.
 *
 * The multi-channel expansion is tested alongside it: one notify action now
 * fans out to one DeliveryTarget per channel, and a channel that failed to
 * make the crossing routes to nobody while still validating, persisting and
 * rendering in the wizard.
 */
import { describe, it, expect } from "vitest";
import { preferenceWithholds } from "../../src/services/notificationRecipientService.js";
import {
  NOTIFICATION_PREFERENCES,
  DEFAULT_NOTIFICATION_PREFERENCE,
  normalizeNotificationPreference,
  preferenceAllowsTransport,
} from "../../src/services/notificationPreferenceService.js";
import { notifyChannelIds, actionsToTargets, type AutomationAction } from "../../src/services/notificationTypes.js";
import { targetsToNotifyActions } from "../../src/services/notificationTypes/ruleSchema.js";
import { notifyActionSchema } from "../../src/services/notificationTypes/actions.js";

describe("normalizeNotificationPreference", () => {
  it("passes the three known values through", () => {
    for (const p of NOTIFICATION_PREFERENCES) expect(normalizeNotificationPreference(p)).toBe(p);
  });

  it("degrades anything else to email rather than throwing", () => {
    // Read on the alerting hot path from a plain TEXT column: a row holding
    // something unexpected must fall back to the method everyone has, not
    // fail a send.
    for (const junk of [null, undefined, "", "sms", 3, {}, "EMAIL"]) {
      expect(normalizeNotificationPreference(junk)).toBe(DEFAULT_NOTIFICATION_PREFERENCE);
    }
    expect(DEFAULT_NOTIFICATION_PREFERENCE).toBe("email");
  });
});

describe("preferenceAllowsTransport", () => {
  it("routes each preference to its own transport", () => {
    expect(preferenceAllowsTransport("email", "email")).toBe(true);
    expect(preferenceAllowsTransport("email", "web_push")).toBe(false);
    expect(preferenceAllowsTransport("push", "web_push")).toBe(true);
    expect(preferenceAllowsTransport("push", "email")).toBe(false);
  });

  it("lets 'any' through on both", () => {
    expect(preferenceAllowsTransport("any", "email")).toBe(true);
    expect(preferenceAllowsTransport("any", "web_push")).toBe(true);
  });

  it("never filters a fixed-destination transport", () => {
    // Slack / Teams / Pushbullet post to ONE configured destination and have no
    // per-user recipients at all, so no preference can be expressed about them
    // — and none may withhold them.
    for (const pref of [...NOTIFICATION_PREFERENCES, "nonsense"]) {
      expect(preferenceAllowsTransport(pref, "webhook")).toBe(true);
      expect(preferenceAllowsTransport(pref, "pushbullet")).toBe(true);
      expect(preferenceAllowsTransport(pref, "api_call")).toBe(true);
    }
  });

  it("treats an unreadable preference as email, not as nobody", () => {
    expect(preferenceAllowsTransport(undefined, "email")).toBe(true);
    expect(preferenceAllowsTransport("garbage", "email")).toBe(true);
  });
});

describe("notifyChannelIds", () => {
  it("falls back to the primary for a single-channel action", () => {
    expect(notifyChannelIds({ channelId: "c1" })).toEqual(["c1"]);
    expect(notifyChannelIds({ channelId: "c1", channelIds: [] })).toEqual(["c1"]);
    expect(notifyChannelIds({ channelId: "c1", channelIds: null })).toEqual(["c1"]);
  });

  it("prefers channelIds and dedupes", () => {
    expect(notifyChannelIds({ channelId: "c1", channelIds: ["c1", "c2", "c1"] })).toEqual(["c1", "c2"]);
  });
});

describe("actionsToTargets with multiple channels", () => {
  const base = {
    type: "notify" as const,
    channelId: "c1",
    channelIds: ["c1", "c2"],
    recipientUserIds: ["u1"],
    respectUserPreference: true,
  };

  it("expands one action to one target per channel", () => {
    const targets = actionsToTargets([base as AutomationAction]);
    expect(targets.map((t) => t.channelId)).toEqual(["c1", "c2"]);
    // Recipients are shared across an action's channels.
    for (const t of targets) expect(t.recipientUserIds).toEqual(["u1"]);
  });

  it("carries respectUserPreference onto every target", () => {
    // The runtime path IS actionsToTargets — a flag the action holds and the
    // target drops validates, persists, renders and changes nothing at all.
    for (const t of actionsToTargets([base as AutomationAction])) {
      expect(t.respectUserPreference).toBe(true);
    }
  });

  it("round-trips the flag back through targetsToNotifyActions", () => {
    const back = targetsToNotifyActions(actionsToTargets([base as AutomationAction]), null);
    expect(back).toHaveLength(2);
    for (const a of back) {
      expect(a.type).toBe("notify");
      if (a.type === "notify") expect(a.respectUserPreference).toBe(true);
    }
  });

  it("leaves a single-channel action byte-identical to the pre-feature shape", () => {
    const [t] = actionsToTargets([{ type: "notify", channelId: "c1", addresses: ["a@b.co"] } as AutomationAction]);
    expect(t).toEqual({ channelId: "c1", addresses: ["a@b.co"] });
  });
});

describe("notifyActionSchema", () => {
  it("accepts a multi-channel action and a preference flag", () => {
    const parsed = notifyActionSchema.parse({
      type: "notify",
      channelId: "c1",
      channelIds: ["c1", "c2"],
      respectUserPreference: true,
      recipientUserIds: ["u1"],
    });
    expect(parsed.channelIds).toEqual(["c1", "c2"]);
    expect(parsed.respectUserPreference).toBe(true);
  });

  it("still accepts a pre-feature single-channel action", () => {
    const parsed = notifyActionSchema.parse({ type: "notify", channelId: "c1" });
    expect(parsed.channelIds).toBeUndefined();
    expect(parsed.respectUserPreference).toBeUndefined();
    expect(notifyChannelIds(parsed)).toEqual(["c1"]);
  });

  it("stays a plain object schema, so the union and the escalatable extend still build", () => {
    // A superRefine here would make it a ZodEffects, which
    // z.discriminatedUnion() and .extend() both refuse — the coherence check
    // lives in assertActionRefs for exactly that reason.
    expect(typeof (notifyActionSchema as unknown as { extend?: unknown }).extend).toBe("function");
  });
});

describe("preferenceWithholds — a preference routes an alert, it never deletes one", () => {
  const reachable = { hasPushDevice: true, hasEmail: true };

  it("withholds the refused transport when the preferred one can reach them", () => {
    expect(preferenceWithholds("push", "email", reachable)).toBe(true);
    expect(preferenceWithholds("email", "web_push", reachable)).toBe(true);
  });

  it("never withholds the transport the recipient actually asked for", () => {
    expect(preferenceWithholds("push", "web_push", reachable)).toBe(false);
    expect(preferenceWithholds("email", "email", reachable)).toBe(false);
    expect(preferenceWithholds("any", "email", reachable)).toBe(false);
    expect(preferenceWithholds("any", "web_push", reachable)).toBe(false);
  });

  it("keeps a push-preferring recipient on the EMAIL when they have no device", () => {
    // The hole this closes: the preference filter drops them from email, the
    // push target resolves to no subscription, and they receive nothing at all
    // — silently, since no surface reports an omitted recipient.
    expect(preferenceWithholds("push", "email", { hasPushDevice: false, hasEmail: true })).toBe(false);
  });

  it("keeps an email-preferring recipient on the PUSH when they have no address", () => {
    // The mirror of the same hole: User.email is nullable, and an account
    // without one is unreachable by the very channel it asked for.
    expect(preferenceWithholds("email", "web_push", { hasPushDevice: true, hasEmail: false })).toBe(false);
  });

  it("keeps them when NEITHER channel can reach them, so the send is at least attempted", () => {
    expect(preferenceWithholds("push", "email", { hasPushDevice: false, hasEmail: false })).toBe(false);
    expect(preferenceWithholds("email", "web_push", { hasPushDevice: false, hasEmail: false })).toBe(false);
  });

  it("never withholds a fixed-destination transport", () => {
    expect(preferenceWithholds("push", "webhook", reachable)).toBe(false);
    expect(preferenceWithholds("email", "pushbullet", reachable)).toBe(false);
  });
});
