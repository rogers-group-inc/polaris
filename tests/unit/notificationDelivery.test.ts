/**
 * tests/unit/notificationDelivery.test.ts
 *
 * Pure-function coverage for the notification delivery layer: the
 * delivery-target Zod schema (superRefine rules per channel) and the webhook
 * body formatters (slack / teams / generic). The DB-bound recipient resolution
 * + drain path is exercised by the integration suite + the podman walkthrough.
 */

import { describe, it, expect } from "vitest";
import { deliveryTargetSchema, emailCompositionSchema, escalationSchema } from "../../src/services/notificationTypes.js";
import { formatBody, type WebhookPayload } from "../../src/services/notificationChannels/webhookChannel.js";
import { buildGraphMessage } from "../../src/services/notificationChannels/emailChannel.js";
import { scopeRegionTagsOf, dedupeEmailRecipients } from "../../src/services/notificationRecipientService.js";

describe("scopeRegionTagsOf", () => {
  it("extracts only region: tags from a scope", () => {
    expect(scopeRegionTagsOf({ tags: ["region:Atlanta", "prod", "firewall:fgt-1", "region:Ashfield"] }))
      .toEqual(["region:Atlanta", "region:Ashfield"]);
  });
  it("returns [] for no scope / no region tags", () => {
    expect(scopeRegionTagsOf(null)).toEqual([]);
    expect(scopeRegionTagsOf({ tags: ["prod"] })).toEqual([]);
    expect(scopeRegionTagsOf({})).toEqual([]);
  });
});

describe("deliveryTargetSchema", () => {
  it("accepts a target referencing a channel by id", () => {
    expect(deliveryTargetSchema.safeParse({ channelId: "ch-1" }).success).toBe(true);
  });
  it("accepts recipient routing (tags + explicit addresses)", () => {
    expect(deliveryTargetSchema.safeParse({ channelId: "ch-1", recipientTags: ["region:Atlanta"], addresses: ["a@example.com"] }).success).toBe(true);
  });
  it("requires a channelId", () => {
    expect(deliveryTargetSchema.safeParse({ recipientTags: ["x"] }).success).toBe(false);
    expect(deliveryTargetSchema.safeParse({ channelId: "" }).success).toBe(false);
  });
  it("rejects an invalid email address", () => {
    expect(deliveryTargetSchema.safeParse({ channelId: "ch-1", addresses: ["nope"] }).success).toBe(false);
  });
  it("accepts individual user-account recipients", () => {
    expect(deliveryTargetSchema.safeParse({ channelId: "ch-1", recipientUserIds: ["u1", "u2"] }).success).toBe(true);
  });
  it("accepts the scope-region recipient flag", () => {
    expect(deliveryTargetSchema.safeParse({ channelId: "ch-1", recipientScopeRegion: true }).success).toBe(true);
  });
  it("accepts a combination of recipient sources", () => {
    const r = deliveryTargetSchema.safeParse({ channelId: "ch-1", recipientUserIds: ["u1"], addresses: ["a@example.com"], recipientScopeRegion: true });
    expect(r.success).toBe(true);
  });
});

describe("formatBody", () => {
  const payload: WebhookPayload = {
    title: "[ERROR] sw-core-1",
    message: "CPU 95% > 90%",
    severity: "error",
    assetHostname: "sw-core-1",
    url: "https://polaris.example.com/notifications.html",
    triggeredAt: "2026-06-29T12:00:00.000Z",
  };

  it("slack → { text } with a link", () => {
    const body = formatBody("slack", payload) as { text: string };
    expect(body.text).toContain("[ERROR] sw-core-1");
    // Slack requires & < > to be escaped in text we did not write (rule 109).
    expect(body.text).toContain("CPU 95% &gt; 90%");
    expect(body.text).toContain("<https://polaris.example.com/notifications.html|View>");
  });

  it("teams → MessageCard with severity color + action", () => {
    const body = formatBody("teams", payload) as Record<string, any>;
    expect(body["@type"]).toBe("MessageCard");
    expect(body.themeColor).toBe("dc2626"); // error
    expect(body.potentialAction[0].targets[0].uri).toBe(payload.url);
  });

  it("generic → full notification JSON", () => {
    const body = formatBody("generic", payload) as Record<string, any>;
    expect(body.source).toBe("polaris");
    expect(body.severity).toBe("error");
    expect(body.asset).toBe("sw-core-1");
    expect(body.message).toBe("CPU 95% > 90%");
  });

  it("teams omits the action when there is no url", () => {
    const body = formatBody("teams", { ...payload, url: null }) as Record<string, any>;
    expect(body.potentialAction).toBeUndefined();
  });
});

describe("emailCompositionSchema", () => {
  it("accepts an empty object (explicit opt-in with defaults)", () => {
    expect(emailCompositionSchema.safeParse({}).success).toBe(true);
  });
  it("accepts templates + cc/bcc recipients", () => {
    const r = emailCompositionSchema.safeParse({
      subjectTemplate: "[{severity.upper}] {asset}",
      bodyTextTemplate: "{message}",
      bodyHtmlTemplate: "<p>{message}</p>",
      cc: { recipientUserIds: ["u1"], addresses: ["cc@example.com"] },
      bcc: { addresses: ["audit@example.com"] },
    });
    expect(r.success).toBe(true);
  });
  it("rejects unknown keys (strict) and bad email addresses", () => {
    expect(emailCompositionSchema.safeParse({ subject: "x" }).success).toBe(false);
    expect(emailCompositionSchema.safeParse({ cc: { addresses: ["nope"] } }).success).toBe(false);
    expect(emailCompositionSchema.safeParse({ cc: { extra: true } }).success).toBe(false);
  });
  it("enforces template size caps", () => {
    expect(emailCompositionSchema.safeParse({ subjectTemplate: "x".repeat(501) }).success).toBe(false);
    expect(emailCompositionSchema.safeParse({ bodyTextTemplate: "x".repeat(10001) }).success).toBe(false);
  });
});

describe("escalationSchema", () => {
  const tier = { afterMin: 15, channelId: "ch-1", to: { addresses: ["oncall@example.com"] } };

  it("accepts a minimal single-tier escalation and defaults stopOn", () => {
    const r = escalationSchema.safeParse({ tiers: [tier] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.stopOn).toBe("acknowledge");
  });
  it("accepts overrides + repeat settings", () => {
    const r = escalationSchema.safeParse({
      stopOn: "clear",
      tiers: [{ ...tier, cc: { recipientUserIds: ["u1"] }, subjectTemplate: "[ESCALATION {escalation.tier}] {asset}", bodyTextTemplate: "{message}", repeatEveryMin: 30, maxRepeats: 3 }],
    });
    expect(r.success).toBe(true);
  });
  it("requires at least one To recipient per tier", () => {
    expect(escalationSchema.safeParse({ tiers: [{ afterMin: 15, channelId: "ch-1", to: {} }] }).success).toBe(false);
  });
  it("bounds tiers (1–5), afterMin, repeatEveryMin, maxRepeats", () => {
    expect(escalationSchema.safeParse({ tiers: [] }).success).toBe(false);
    expect(escalationSchema.safeParse({ tiers: Array.from({ length: 6 }, () => tier) }).success).toBe(false);
    expect(escalationSchema.safeParse({ tiers: [{ ...tier, afterMin: 0 }] }).success).toBe(false);
    expect(escalationSchema.safeParse({ tiers: [{ ...tier, repeatEveryMin: 4 }] }).success).toBe(false);
    expect(escalationSchema.safeParse({ tiers: [{ ...tier, repeatEveryMin: 30, maxRepeats: 21 }] }).success).toBe(false);
  });
  it("rejects an unknown stopOn", () => {
    expect(escalationSchema.safeParse({ stopOn: "never", tiers: [tier] }).success).toBe(false);
  });
});

describe("dedupeEmailRecipients", () => {
  it("To wins over Cc; Bcc drops anything visible in To or Cc", () => {
    const r = dedupeEmailRecipients(
      ["a@example.com", "b@example.com"],
      ["b@example.com", "c@example.com"],
      ["a@example.com", "c@example.com", "d@example.com"],
    );
    expect(r.cc).toEqual(["c@example.com"]);
    expect(r.bcc).toEqual(["d@example.com"]);
  });
  it("compares case-insensitively", () => {
    const r = dedupeEmailRecipients(["A@Example.com"], ["a@example.com"], ["a@EXAMPLE.com"]);
    expect(r.cc).toEqual([]);
    expect(r.bcc).toEqual([]);
  });
  it("passes disjoint lists through unchanged", () => {
    const r = dedupeEmailRecipients(["a@x.com"], ["b@x.com"], ["c@x.com"]);
    expect(r.cc).toEqual(["b@x.com"]);
    expect(r.bcc).toEqual(["c@x.com"]);
  });
});

describe("buildGraphMessage", () => {
  it("maps to/cc/bcc arrays to Graph recipient objects", () => {
    const m = buildGraphMessage({ to: ["a@x.com", "b@x.com"], cc: ["c@x.com"], bcc: ["d@x.com"], subject: "S", text: "T" }) as any;
    expect(m.toRecipients).toEqual([{ emailAddress: { address: "a@x.com" } }, { emailAddress: { address: "b@x.com" } }]);
    expect(m.ccRecipients).toEqual([{ emailAddress: { address: "c@x.com" } }]);
    expect(m.bccRecipients).toEqual([{ emailAddress: { address: "d@x.com" } }]);
  });
  it("accepts a single To string (legacy rows) and omits empty cc/bcc", () => {
    const m = buildGraphMessage({ to: "a@x.com", subject: "S", text: "T" }) as any;
    expect(m.toRecipients).toEqual([{ emailAddress: { address: "a@x.com" } }]);
    expect(m.ccRecipients).toBeUndefined();
    expect(m.bccRecipients).toBeUndefined();
  });
  it("uses Text body by default and HTML when an html body is present", () => {
    expect((buildGraphMessage({ to: "a@x.com", subject: "S", text: "T" }) as any).body).toEqual({ contentType: "Text", content: "T" });
    expect((buildGraphMessage({ to: "a@x.com", subject: "S", text: "T", html: "<p>H</p>" }) as any).body).toEqual({ contentType: "HTML", content: "<p>H</p>" });
  });
});
