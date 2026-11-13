/**
 * tests/unit/notificationTypesActions.test.ts — the own suite for
 * src/services/notificationTypes/actions.ts (CQ-T010).
 *
 * The delivery vocabulary every automation, alert group and escalation tier is
 * validated against: channel types and their transports, the target / notify /
 * api_call / script / event / reboot action shapes, the escalation chains (legacy
 * email tiers and v2 action tiers), reset config, the repeat config, severity
 * bands and the band-notify policy — plus the four small pure helpers that live
 * beside them (notifyChannelIds, rebootActionHasTo, escalationResetKey, the
 * reset-condition / reset-event trigger-type partitions).
 *
 * Pins the contracts the rest of the engine leans on: `.strict()` everywhere
 * (an unknown key is a client bug, never silently dropped), ONE level of
 * per-action escalation (no chains-of-chains), per-action `repeat` only on the
 * escalatable notify variant, api_call URLs http(s)-only with at most 20
 * headers (rule 114(h)), and reboot booking defaults (rule 115(c)).
 */

import { describe, it, expect } from "vitest";
import {
  CHANNEL_TYPES,
  CHANNEL_TRANSPORT,
  CHANNEL_TYPE_META,
  RECIPIENT_ROUTED_TYPES,
  MAX_DEVICE_REGION_LEVELS,
  RESET_MODES,
  RESET_EVENT_SUGGESTIONS,
  SCRIPT_INTERPRETERS,
  deliveryTargetSchema,
  emailRecipientsSchema,
  emailCompositionSchema,
  escalationSchema,
  escalationV2Schema,
  resetSchema,
  notifyActionSchema,
  actionSchema,
  escalatableActionSchema,
  rebootActionSchema,
  repeatConfigSchema,
  severityBandSchema,
  bandNotifySchema,
  notifyChannelIds,
  rebootActionHasTo,
  escalationResetKey,
  triggerTypeAllowsResetCondition,
  triggerTypeAllowsResetEvent,
} from "../../src/services/notificationTypes/actions.js";

const notify = (over: Record<string, unknown> = {}) => ({ type: "notify", channelId: "ch-1", ...over });

describe("channel registry", () => {
  it("maps every channel type to a transport, sharing webhook between slack and teams", () => {
    for (const t of CHANNEL_TYPES) expect(CHANNEL_TRANSPORT[t]).toBeDefined();
    expect(CHANNEL_TRANSPORT.smtp).toBe("email");
    expect(CHANNEL_TRANSPORT.oauth_m365).toBe("email");
    expect(CHANNEL_TRANSPORT.slack).toBe("webhook");
    expect(CHANNEL_TRANSPORT.teams).toBe("webhook");
    expect(CHANNEL_TRANSPORT.web_push).toBe("web_push");
    expect(CHANNEL_TRANSPORT.pushbullet).toBe("pushbullet");
  });

  it("keeps the display metadata's transport in step with CHANNEL_TRANSPORT", () => {
    for (const t of CHANNEL_TYPES) expect(CHANNEL_TYPE_META[t].transport).toBe(CHANNEL_TRANSPORT[t]);
  });

  it("routes recipients only on the email and web push types", () => {
    expect([...RECIPIENT_ROUTED_TYPES].sort()).toEqual(["oauth_m365", "smtp", "web_push"]);
  });

  it("marks every credential field as a masked secret", () => {
    const secretKeys = CHANNEL_TYPES.flatMap((t) => CHANNEL_TYPE_META[t].fields.filter((f) => f.secret).map((f) => `${t}.${f.key}`));
    expect(secretKeys.sort()).toEqual([
      "oauth_m365.clientSecret", "pushbullet.accessToken", "slack.webhookUrl", "smtp.password", "teams.webhookUrl",
    ]);
    for (const t of CHANNEL_TYPES) {
      for (const f of CHANNEL_TYPE_META[t].fields) if (f.secret) expect(f.kind).toBe("password");
    }
  });

  it("makes web push the only singleton channel", () => {
    expect(CHANNEL_TYPES.filter((t) => CHANNEL_TYPE_META[t].singleton)).toEqual(["web_push"]);
  });

  it("orders SMTP security above port, so picking one can fill the other", () => {
    const keys = CHANNEL_TYPE_META.smtp.fields.map((f) => f.key);
    expect(keys.indexOf("security")).toBeLessThan(keys.indexOf("port"));
    expect(CHANNEL_TYPE_META.smtp.fields.find((f) => f.key === "security")?.options).toEqual(["none", "starttls", "ssl"]);
  });
});

describe("deliveryTargetSchema", () => {
  it("accepts a bare channel reference", () => {
    expect(deliveryTargetSchema.safeParse({ channelId: "c" }).success).toBe(true);
  });

  it("refuses an empty channel id and a malformed address", () => {
    expect(deliveryTargetSchema.safeParse({ channelId: "" }).success).toBe(false);
    expect(deliveryTargetSchema.safeParse({ channelId: "c", addresses: ["not-an-address"] }).success).toBe(false);
  });

  it("bounds device-region levels to 1..MAX_DEVICE_REGION_LEVELS integers", () => {
    expect(MAX_DEVICE_REGION_LEVELS).toBe(8);
    expect(deliveryTargetSchema.safeParse({ channelId: "c", recipientDeviceRegionLevels: [1, 8] }).success).toBe(true);
    expect(deliveryTargetSchema.safeParse({ channelId: "c", recipientDeviceRegionLevels: [0] }).success).toBe(false);
    expect(deliveryTargetSchema.safeParse({ channelId: "c", recipientDeviceRegionLevels: [9] }).success).toBe(false);
    expect(deliveryTargetSchema.safeParse({ channelId: "c", recipientDeviceRegionLevels: [1.5] }).success).toBe(false);
    expect(deliveryTargetSchema.safeParse({ channelId: "c", recipientDeviceRegionLevels: [1, 2, 3, 4, 5, 6, 7, 8, 1] }).success).toBe(false);
  });

  it("carries respectUserPreference, so the runtime target path does not drop it (rule 39)", () => {
    const r = deliveryTargetSchema.parse({ channelId: "c", respectUserPreference: true });
    expect(r.respectUserPreference).toBe(true);
  });
});

describe("email recipients and composition", () => {
  it("is strict — an unknown recipient key fails the save rather than vanishing", () => {
    expect(emailRecipientsSchema.safeParse({ recipientUserIds: ["u"], groups: ["x"] }).success).toBe(false);
  });

  it("accepts the region and tag pills in Cc as readily as in To", () => {
    expect(emailRecipientsSchema.safeParse({ recipientRegions: ["Atlanta"], recipientTags: ["noc"] }).success).toBe(true);
  });

  it("accepts null Cc/Bcc and nullable templates, and bounds the subject", () => {
    expect(emailCompositionSchema.safeParse({ subjectTemplate: null, cc: null, bcc: null }).success).toBe(true);
    expect(emailCompositionSchema.safeParse({ subjectTemplate: "x".repeat(501) }).success).toBe(false);
    expect(emailCompositionSchema.safeParse({ bodyHtmlTemplate: "x".repeat(20000) }).success).toBe(true);
  });

  it("is strict at the composition level too", () => {
    expect(emailCompositionSchema.safeParse({ replyTo: "a@b.c" }).success).toBe(false);
  });
});

describe("escalationSchema (legacy email tiers)", () => {
  const tier = (over: Record<string, unknown> = {}) => ({ afterMin: 15, channelId: "c", to: { addresses: ["a@b.co"] }, ...over });

  it("defaults stopOn to acknowledge", () => {
    expect(escalationSchema.parse({ tiers: [tier()] }).stopOn).toBe("acknowledge");
  });

  it("needs a To user or address on every tier", () => {
    expect(escalationSchema.safeParse({ tiers: [tier({ to: {} })] }).success).toBe(false);
    expect(escalationSchema.safeParse({ tiers: [tier({ to: { recipientUserIds: ["u1"] } })] }).success).toBe(true);
  });

  it("holds between one and five tiers", () => {
    expect(escalationSchema.safeParse({ tiers: [] }).success).toBe(false);
    expect(escalationSchema.safeParse({ tiers: Array.from({ length: 5 }, () => tier()) }).success).toBe(true);
    expect(escalationSchema.safeParse({ tiers: Array.from({ length: 6 }, () => tier()) }).success).toBe(false);
  });

  it("bounds afterMin to a week and repeats to 5..1440 minutes", () => {
    expect(escalationSchema.safeParse({ tiers: [tier({ afterMin: 10081 })] }).success).toBe(false);
    expect(escalationSchema.safeParse({ tiers: [tier({ afterMin: 0 })] }).success).toBe(false);
    expect(escalationSchema.safeParse({ tiers: [tier({ repeatEveryMin: 4 })] }).success).toBe(false);
    expect(escalationSchema.safeParse({ tiers: [tier({ repeatEveryMin: 5, maxRepeats: 20 })] }).success).toBe(true);
    expect(escalationSchema.safeParse({ tiers: [tier({ maxRepeats: 21 })] }).success).toBe(false);
  });
});

describe("escalationV2Schema (tiers of actions)", () => {
  it("takes any action type in a tier", () => {
    const r = escalationV2Schema.safeParse({
      tiers: [{ afterMin: 30, actions: [notify(), { type: "api_call", url: "https://x.example/hook" }] }],
    });
    expect(r.success).toBe(true);
  });

  it("refuses an empty tier", () => {
    expect(escalationV2Schema.safeParse({ tiers: [{ afterMin: 30, actions: [] }] }).success).toBe(false);
  });

  it("refuses a nested escalation inside a tier action — no chains-of-chains", () => {
    const r = escalationV2Schema.safeParse({
      tiers: [{ afterMin: 30, actions: [notify({ escalation: { tiers: [{ afterMin: 5, actions: [notify()] }] } })] }],
    });
    expect(r.success).toBe(false);
  });
});

describe("reset modes", () => {
  it("lists the five modes and defaults to manual", () => {
    expect([...RESET_MODES]).toEqual(["manual", "auto", "timed", "condition", "event"]);
    expect(resetSchema.parse({}).mode).toBe("manual");
  });

  it("bounds the sustain, the sustain count and the timed delay", () => {
    expect(resetSchema.safeParse({ mode: "auto", sustainSec: 86400 }).success).toBe(true);
    expect(resetSchema.safeParse({ mode: "auto", sustainSec: 86401 }).success).toBe(false);
    expect(resetSchema.safeParse({ mode: "auto", sustainPolls: 101 }).success).toBe(false);
    expect(resetSchema.safeParse({ mode: "timed", afterSec: 0 }).success).toBe(false);
    expect(resetSchema.safeParse({ mode: "timed", afterSec: 2592000 }).success).toBe(true);
  });

  it("takes a reset event with an optional resource narrowing, strictly", () => {
    expect(resetSchema.safeParse({ mode: "event", resetEvent: { actionPattern: "agent.connected", resourceType: "asset" } }).success).toBe(true);
    expect(resetSchema.safeParse({ mode: "event", resetEvent: { actionPattern: "" } }).success).toBe(false);
    expect(resetSchema.safeParse({ mode: "event", resetEvent: { actionPattern: "x", level: "info" } }).success).toBe(false);
  });

  it("partitions trigger types: continuous ones take a condition, instantaneous ones an event", () => {
    for (const t of ["asset_metric", "asset_state", "host_metric", "composite"]) {
      expect(triggerTypeAllowsResetCondition(t)).toBe(true);
      expect(triggerTypeAllowsResetEvent(t)).toBe(false);
    }
    for (const t of ["event", "change"]) {
      expect(triggerTypeAllowsResetCondition(t)).toBe(false);
      expect(triggerTypeAllowsResetEvent(t)).toBe(true);
    }
    expect(triggerTypeAllowsResetCondition("bogus")).toBe(false);
    expect(triggerTypeAllowsResetEvent("bogus")).toBe(false);
  });

  it("suggests the counterpart recovery verb for each known failure event", () => {
    expect(RESET_EVENT_SUGGESTIONS["agent.disconnected"]).toBe("agent.connected");
    expect(RESET_EVENT_SUGGESTIONS["agent.upgrade_failed"]).toBe(RESET_EVENT_SUGGESTIONS["agent.upgrade_skipped"]);
    expect(RESET_EVENT_SUGGESTIONS["integration.discover.error"]).toBe("integration.discover.completed");
    // A suggestion never points back at its own trigger.
    for (const [k, v] of Object.entries(RESET_EVENT_SUGGESTIONS)) expect(v).not.toBe(k);
  });
});

describe("notify actions", () => {
  it("accepts the minimal shape and the identity / reset-linking fields (rule 145)", () => {
    expect(notifyActionSchema.safeParse(notify()).success).toBe(true);
    expect(notifyActionSchema.safeParse(notify({ id: "a1", matchActionId: "a0", customized: true })).success).toBe(true);
  });

  it("caps channelIds at ten and refuses an empty list", () => {
    expect(notifyActionSchema.safeParse(notify({ channelIds: [] })).success).toBe(false);
    expect(notifyActionSchema.safeParse(notify({ channelIds: Array.from({ length: 11 }, (_, i) => `c${i}`) })).success).toBe(false);
  });

  it("does NOT itself enforce channelId === channelIds[0] — that lives in assertActionRefs", () => {
    expect(notifyActionSchema.safeParse(notify({ channelId: "a", channelIds: ["b"] })).success).toBe(true);
  });

  it("keys a reset-escalation override per severity tier, and those overrides cannot carry a link", () => {
    expect(escalationResetKey("critical", 0)).toBe("critical:0");
    expect(escalationResetKey("warning", 2)).toBe("warning:2");
    const ok = notifyActionSchema.safeParse(notify({ resetEscalation: { custom: { "critical:0": [notify()] } } }));
    expect(ok.success).toBe(true);
    const linked = notifyActionSchema.safeParse(notify({ resetEscalation: { custom: { "critical:0": [notify({ matchActionId: "x" })] } } }));
    expect(linked.success).toBe(false);
  });

  it("refuses an unknown key (strict)", () => {
    expect(notifyActionSchema.safeParse(notify({ priority: 1 })).success).toBe(false);
  });
});

describe("notifyChannelIds", () => {
  it("falls back to the primary channel alone", () => {
    expect(notifyChannelIds({ channelId: "a" })).toEqual(["a"]);
    expect(notifyChannelIds({ channelId: "a", channelIds: null })).toEqual(["a"]);
    expect(notifyChannelIds({ channelId: "a", channelIds: [] })).toEqual(["a"]);
  });

  it("dedupes, keeps order, and drops blanks", () => {
    expect(notifyChannelIds({ channelId: "a", channelIds: ["a", "b", "a", "", "c"] })).toEqual(["a", "b", "c"]);
  });

  it("reads channelIds when present, even if channelId disagrees", () => {
    expect(notifyChannelIds({ channelId: "z", channelIds: ["b"] })).toEqual(["b"]);
  });
});

describe("api_call actions", () => {
  const call = (over: Record<string, unknown> = {}) => ({ type: "api_call", url: "https://hooks.example/x", ...over });

  it("defaults the method to POST and the timeout to 15s", () => {
    const r = actionSchema.parse(call()) as { method: string; timeoutSec: number };
    expect(r.method).toBe("POST");
    expect(r.timeoutSec).toBe(15);
  });

  it("only fetches http(s) URLs", () => {
    expect(actionSchema.safeParse(call({ url: "http://x.example/" })).success).toBe(true);
    expect(actionSchema.safeParse(call({ url: "ftp://x.example/" })).success).toBe(false);
    expect(actionSchema.safeParse(call({ url: "file:///etc/passwd" })).success).toBe(false);
    expect(actionSchema.safeParse(call({ url: "not a url" })).success).toBe(false);
  });

  it("allows at most 20 headers with 1–100 character names", () => {
    const h = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`H${i}`, "v"]));
    expect(actionSchema.safeParse(call({ headers: h(20) })).success).toBe(true);
    expect(actionSchema.safeParse(call({ headers: h(21) })).success).toBe(false);
    expect(actionSchema.safeParse(call({ headers: { "": "v" } })).success).toBe(false);
    expect(actionSchema.safeParse(call({ headers: { ["x".repeat(101)]: "v" } })).success).toBe(false);
  });

  it("bounds the timeout to 1..60s and refuses an unknown method", () => {
    expect(actionSchema.safeParse(call({ timeoutSec: 61 })).success).toBe(false);
    expect(actionSchema.safeParse(call({ timeoutSec: 0 })).success).toBe(false);
    expect(actionSchema.safeParse(call({ method: "OPTIONS" })).success).toBe(false);
  });
});

describe("script, event and reboot actions", () => {
  it("needs a script id and a run target of server or agent", () => {
    expect(actionSchema.safeParse({ type: "script", scriptId: "s1", runOn: "agent" }).success).toBe(true);
    expect(actionSchema.safeParse({ type: "script", scriptId: "s1", runOn: "fortigate" }).success).toBe(false);
    expect(actionSchema.safeParse({ type: "script", scriptId: "", runOn: "server" }).success).toBe(false);
    expect(actionSchema.safeParse({ type: "script", scriptId: "s", runOn: "server", timeoutSec: 601 }).success).toBe(false);
  });

  it("publishes the interpreter vocabulary the agent mirrors", () => {
    expect([...SCRIPT_INTERPRETERS]).toEqual(["bash", "sh", "powershell", "cmd", "python3"]);
  });

  it("takes the audit event action with no fields at all", () => {
    expect(actionSchema.safeParse({ type: "event" }).success).toBe(true);
    expect(actionSchema.safeParse({ type: "event", level: "info" }).success).toBe(false);
  });

  it("books a reboot at 02:00 with a 24h loop guard by default (rule 115(c))", () => {
    const r = rebootActionSchema.parse({ type: "reboot" });
    expect(r).toMatchObject({ when: "at", at: "02:00", minGapHours: 24 });
  });

  it("refuses a malformed time and a gap outside 1..720h", () => {
    expect(rebootActionSchema.safeParse({ type: "reboot", at: "24:00" }).success).toBe(false);
    expect(rebootActionSchema.safeParse({ type: "reboot", at: "2:00" }).success).toBe(false);
    expect(rebootActionSchema.safeParse({ type: "reboot", at: "23:59" }).success).toBe(true);
    expect(rebootActionSchema.safeParse({ type: "reboot", minGapHours: 0 }).success).toBe(false);
    expect(rebootActionSchema.safeParse({ type: "reboot", minGapHours: 721 }).success).toBe(false);
  });

  it("refuses an unknown action type", () => {
    expect(actionSchema.safeParse({ type: "sms", to: "x" }).success).toBe(false);
  });
});

describe("rebootActionHasTo", () => {
  const base = rebootActionSchema.parse({ type: "reboot" });

  it("is false with nobody named", () => {
    expect(rebootActionHasTo(base)).toBe(false);
    expect(rebootActionHasTo({ ...base, addresses: [], recipientUserIds: [] })).toBe(false);
  });

  it.each([
    ["notifyEmails", { notifyEmails: ["a@b.co"] }],
    ["recipientUserIds", { recipientUserIds: ["u"] }],
    ["addresses", { addresses: ["a@b.co"] }],
    ["recipientRoles", { recipientRoles: ["r"] }],
    ["recipientRegions", { recipientRegions: ["Atlanta"] }],
    ["recipientTags", { recipientTags: ["noc"] }],
    ["recipientDeviceRegion", { recipientDeviceRegion: true }],
    ["recipientDeviceRegionLevels", { recipientDeviceRegionLevels: [1] }],
    ["recipientAssetContacts", { recipientAssetContacts: true }],
  ])("is true for %s", (_name, over) => {
    expect(rebootActionHasTo({ ...base, ...over })).toBe(true);
  });

  it("does not count Cc or Bcc as a To", () => {
    expect(rebootActionHasTo({ ...base, cc: { addresses: ["a@b.co"] }, bcc: { addresses: ["c@d.co"] } })).toBe(false);
  });
});

describe("escalatable actions", () => {
  it("lets a notify action carry its own escalation and repeat", () => {
    const r = escalatableActionSchema.safeParse(notify({
      escalation: { tiers: [{ afterMin: 15, actions: [notify()] }] },
      repeat: { everyMin: 30 },
    }));
    expect(r.success).toBe(true);
  });

  it("refuses repeat on api_call and script — a second ticket is not a second email", () => {
    expect(escalatableActionSchema.safeParse({ type: "api_call", url: "https://x.example", repeat: { everyMin: 30 } }).success).toBe(false);
    expect(escalatableActionSchema.safeParse({ type: "script", scriptId: "s", runOn: "server", repeat: { everyMin: 30 } }).success).toBe(false);
  });

  it("refuses escalation on the event and reboot actions", () => {
    const esc = { tiers: [{ afterMin: 15, actions: [notify()] }] };
    expect(escalatableActionSchema.safeParse({ type: "event", escalation: esc }).success).toBe(false);
    expect(escalatableActionSchema.safeParse({ type: "reboot", escalation: esc }).success).toBe(false);
  });

  it("refuses repeat on a bare (non-escalatable) notify action", () => {
    expect(actionSchema.safeParse(notify({ repeat: { everyMin: 30 } })).success).toBe(false);
  });

  it("accepts an explicit null repeat — 'this action does not repeat'", () => {
    const r = escalatableActionSchema.parse(notify({ repeat: null })) as { repeat?: unknown };
    expect(r.repeat).toBeNull();
  });
});

describe("repeatConfigSchema", () => {
  it("defaults stopOn to acknowledge and has no maxRepeats", () => {
    expect(repeatConfigSchema.parse({ everyMin: 10 })).toEqual({ everyMin: 10, stopOn: "acknowledge" });
    expect(repeatConfigSchema.safeParse({ everyMin: 10, maxRepeats: 3 }).success).toBe(false);
  });

  it("bounds the cadence to 5..1440 and the cut-off to 1..720 hours", () => {
    expect(repeatConfigSchema.safeParse({ everyMin: 4 }).success).toBe(false);
    expect(repeatConfigSchema.safeParse({ everyMin: 1441 }).success).toBe(false);
    expect(repeatConfigSchema.safeParse({ everyMin: 5, stopAfterHours: 720 }).success).toBe(true);
    expect(repeatConfigSchema.safeParse({ everyMin: 5, stopAfterHours: 721 }).success).toBe(false);
  });
});

describe("severity bands and band notify", () => {
  it("defaults a band's actions to an empty list", () => {
    expect(severityBandSchema.parse({ threshold: 90, severity: "critical" }).actions).toEqual([]);
  });

  it("refuses an unknown severity or comparator", () => {
    expect(severityBandSchema.safeParse({ threshold: 90, severity: "apocalyptic" }).success).toBe(false);
    expect(severityBandSchema.safeParse({ threshold: 90, severity: "critical", operator: "=~" }).success).toBe(false);
  });

  it("keeps an absent followUp distinct from one that says no", () => {
    expect(severityBandSchema.parse({ threshold: 1, severity: "critical" }).followUp).toBeUndefined();
    expect(severityBandSchema.parse({ threshold: 1, severity: "critical", followUp: {} }).followUp).toEqual({ requireAckNote: false });
  });

  it("refuses reminders inside followUp — they belong on the action", () => {
    expect(severityBandSchema.safeParse({ threshold: 1, severity: "critical", followUp: { repeat: { everyMin: 10 } } }).success).toBe(false);
  });

  it("defaults bandNotify to page on increase and resolve, not decrease, reusing actions", () => {
    expect(bandNotifySchema.parse({})).toEqual({ onIncrease: true, onDecrease: false, onResolved: true, resolvedMode: "reuse" });
  });

  it("keeps resolvedActions on the bare action schema (no per-action escalation)", () => {
    const esc = { tiers: [{ afterMin: 15, actions: [notify()] }] };
    expect(bandNotifySchema.safeParse({ resolvedMode: "dedicated", resolvedActions: [notify()] }).success).toBe(true);
    expect(bandNotifySchema.safeParse({ resolvedActions: [notify({ escalation: esc })] }).success).toBe(false);
  });
});
