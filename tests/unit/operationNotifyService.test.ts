/**
 * tests/unit/operationNotifyService.test.ts — who hears about a firmware
 * upgrade or a reboot, and through which email channel (business rules 93 /
 * 115(e), 2026-11-09): the picker spec is validated against the device when it
 * is saved, resolved again at each send (falling back to the To saved with it),
 * sent only on enabled EMAIL channels, and each user's last spec per kind
 * pre-fills their next dialog.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  class FakeAppError extends Error {
    httpStatus: number;
    constructor(status: number, msg: string) { super(msg); this.httpStatus = status; }
  }
  const state = {
    channels: [] as Array<{ id: string; name: string; type: string; enabled: boolean; config: object }>,
    oldest: { id: "ch-old", type: "smtp", config: {} } as Record<string, unknown> | null,
    users: [] as Array<Record<string, any>>,
    sent: [] as Array<{ via: string; to: string[]; cc?: string[]; bcc?: string[]; subject: string; text: string }>,
    resolved: { to: ["a@example.com"], cc: [] as string[], bcc: [] as string[] },
    resolveCalls: [] as unknown[],
    failVia: new Set<string>(),
  };
  return { state, FakeAppError };
});

vi.mock("../../src/utils/errors.js", () => ({ AppError: h.FakeAppError }));
vi.mock("../../src/db.js", () => ({
  prisma: {
    notificationChannel: {
      findMany: vi.fn(async ({ where, select }: any) => h.state.channels.filter((c) =>
        (!where.id || where.id.in.includes(c.id)) && (where.enabled === undefined || c.enabled === where.enabled) && (!where.type || where.type.in.includes(c.type)))
        .map((c) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, (c as any)[k]])) : c))),
    },
    asset: { findUnique: vi.fn(async () => ({ tags: ["region:North", "core"] })) },
    user: {
      findMany: vi.fn(async ({ where }: any) => h.state.users.filter((u) =>
        where.id ? where.id.in.includes(u.id) : where.email.in.map((e: string) => e.toLowerCase()).includes(String(u.email).toLowerCase()))),
      findUnique: vi.fn(async ({ where }: any) => h.state.users.find((u) => u.id === where.id) ?? null),
      update: vi.fn(async ({ where, data }: any) => { Object.assign(h.state.users.find((u) => u.id === where.id)!, data); return { id: where.id }; }),
    },
  },
}));
vi.mock("../../src/services/notificationRecipientService.js", () => ({
  resolveRebootActionRecipients: vi.fn(async (spec: unknown, opts: unknown) => { h.state.resolveCalls.push({ spec, opts }); return h.state.resolved; }),
  listRecipientUsers: vi.fn(async () => [{ id: "u1", username: "alice", displayName: "Alice", email: "alice@example.com", pushDevices: 2 }]),
}));
vi.mock("../../src/services/notificationRuleService.js", () => ({
  listRecipientCatalog: vi.fn(async () => ({ regions: ["North"], regionLevels: { maxLevel: 1, byName: {} }, roles: [], tagCatalog: [] })),
}));
vi.mock("../../src/services/quietTimeSummaryService.js", () => ({ resolveSummaryChannel: vi.fn(async () => h.state.oldest) }));
vi.mock("../../src/services/notificationDeliveryService.js", () => ({
  applyBrandLetterhead: vi.fn(async (m: any) => m),
  sendEmailThroughChannel: vi.fn(async (ch: any, m: any) => {
    const via = (ch.config && ch.config.name) || ch.type;
    if (h.state.failVia.has(via)) throw new Error("SMTP 550");
    h.state.sent.push({ via, ...m });
  }),
}));
vi.mock("../../src/services/userTimezoneService.js", () => ({ resolveTimeZone: (tz: string) => tz, serverTimeZone: () => "America/Chicago" }));

import {
  prepareNotify, targetFor, deliverOperationEmail, defaultNotifyFor, rememberNotifyFor, notifyDialogDefaults, assertNotifyChannels,
} from "../../src/services/operationNotifyService.js";

const render = (zone: string) => ({ subject: "S", text: `zone ${zone}`, html: "<p/>" });
const SPEC = { to: { recipientRoles: ["role-noc"], recipientDeviceRegion: true }, cc: { addresses: ["boss@example.com"] }, bcc: null, channelIds: ["ch-smtp"] };

beforeEach(() => {
  h.state.channels = [
    { id: "ch-smtp", name: "Office SMTP", type: "smtp", enabled: true, config: { name: "Office SMTP" } },
    { id: "ch-m365", name: "M365", type: "oauth_m365", enabled: true, config: { name: "M365" } },
    { id: "ch-teams", name: "Teams", type: "teams", enabled: true, config: { name: "Teams" } },
    { id: "ch-push", name: "Push", type: "web_push", enabled: true, config: { name: "Push" } },
    { id: "ch-off", name: "Old SMTP", type: "smtp", enabled: false, config: { name: "Old SMTP" } },
  ];
  h.state.oldest = { id: "ch-old", type: "smtp", config: { name: "oldest" } };
  h.state.users = [];
  h.state.sent = [];
  h.state.resolved = { to: ["a@example.com"], cc: [], bcc: [] };
  h.state.resolveCalls = [];
  h.state.failVia = new Set();
});

describe("channels", () => {
  it("accepts enabled SMTP / Microsoft 365 channels only — never push, Teams, or a disabled one", async () => {
    expect(await assertNotifyChannels(["ch-smtp", "ch-m365", "ch-smtp"])).toEqual(["ch-smtp", "ch-m365"]);
    await expect(assertNotifyChannels(["ch-push"])).rejects.toThrow(/not an email channel/);
    await expect(assertNotifyChannels(["ch-teams"])).rejects.toThrow(/not an email channel/);
    await expect(assertNotifyChannels(["ch-off"])).rejects.toThrow(/disabled/);
    await expect(assertNotifyChannels(["nope"])).rejects.toMatchObject({ httpStatus: 400 });
  });
});

describe("prepareNotify", () => {
  it("resolves the spec against the DEVICE (its region tags) and stores the spec, the channels and the To it reached", async () => {
    h.state.resolved = { to: ["noc1@example.com", "noc2@example.com"], cc: ["boss@example.com"], bcc: [] };
    const p = await prepareNotify("asset-1", SPEC);
    expect(p).toEqual({
      notifyEmails: ["noc1@example.com", "noc2@example.com"],
      notifyRecipients: { to: SPEC.to, cc: SPEC.cc, bcc: null },
      notifyChannelIds: ["ch-smtp"],
    });
    expect(h.state.resolveCalls[0]).toMatchObject({ opts: { assetRegionTags: ["North"] } });
  });

  it("refuses a To that reaches nobody with an address right now (400)", async () => {
    h.state.resolved = { to: [], cc: ["boss@example.com"], bcc: [] };
    await expect(prepareNotify("asset-1", SPEC)).rejects.toThrow(/reach nobody/);
  });
});

describe("targetFor — resolved at each send", () => {
  it("a stored spec is resolved again; Cc / Bcc and the channels come with it", async () => {
    h.state.resolved = { to: ["new@example.com"], cc: ["boss@example.com"], bcc: ["audit@example.com"] };
    const t = await targetFor({ assetId: "a", notifyEmails: ["old@example.com"], notifyRecipients: { to: SPEC.to, cc: SPEC.cc, bcc: null }, notifyChannelIds: ["ch-m365"] });
    expect(t).toEqual({ to: ["new@example.com"], cc: ["boss@example.com"], bcc: ["audit@example.com"], channelIds: ["ch-m365"] });
  });

  it("a spec that reaches nobody by now falls back to the To saved with it", async () => {
    h.state.resolved = { to: [], cc: [], bcc: [] };
    const t = await targetFor({ assetId: "a", notifyEmails: ["saved@example.com"], notifyRecipients: { to: SPEC.to } });
    expect(t.to).toEqual(["saved@example.com"]);
  });

  it("no spec: the stored addresses, with an automation booking's Cc / Bcc", async () => {
    const t = await targetFor({ assetId: "a", notifyEmails: ["x@example.com"], notifyCc: ["c@example.com"], notifyBcc: [] });
    expect(t).toEqual({ to: ["x@example.com"], cc: ["c@example.com"], bcc: [], channelIds: [] });
    expect(h.state.resolveCalls).toHaveLength(0);
  });
});

describe("deliverOperationEmail", () => {
  it("no channel chosen: the oldest enabled email channel, one message per reader in their own zone", async () => {
    h.state.users = [{ id: "u", email: "a@example.com", timezone: "America/New_York", detectedTimezone: null }];
    const err = await deliverOperationEmail({ to: ["a@example.com", "b@example.com"], cc: [], bcc: [], channelIds: [] }, render);
    expect(err).toBeNull();
    expect(h.state.sent.map((m) => [m.via, m.to[0], m.text])).toEqual([
      ["oldest", "a@example.com", "zone America/New_York"],
      ["oldest", "b@example.com", "zone America/Chicago"],
    ]);
  });

  it("with a Cc or Bcc: ONE message to the whole To line, in the install's zone", async () => {
    await deliverOperationEmail({ to: ["a@example.com", "b@example.com"], cc: ["c@example.com"], bcc: ["d@example.com"], channelIds: [] }, render);
    expect(h.state.sent).toHaveLength(1);
    expect(h.state.sent[0]).toMatchObject({ to: ["a@example.com", "b@example.com"], cc: ["c@example.com"], bcc: ["d@example.com"], text: "zone America/Chicago" });
  });

  it("goes out on EACH chosen channel that is still enabled; a failure names the channel", async () => {
    h.state.failVia.add("M365");
    const err = await deliverOperationEmail({ to: ["a@example.com"], cc: [], bcc: [], channelIds: ["ch-smtp", "ch-m365", "ch-off"] }, render);
    expect(h.state.sent.map((m) => m.via)).toEqual(["Office SMTP"]);
    expect(err).toBe("M365: a@example.com: SMTP 550");
  });

  it("never falls back silently: chosen channels all disabled = an error, nothing sent", async () => {
    const err = await deliverOperationEmail({ to: ["a@example.com"], cc: [], bcc: [], channelIds: ["ch-off"] }, render);
    expect(err).toMatch(/none of the chosen email channels/);
    expect(h.state.sent).toHaveLength(0);
  });

  it("no email channel at all is an error, not a throw", async () => {
    h.state.oldest = null;
    expect(await deliverOperationEmail({ to: ["a@example.com"], cc: [], bcc: [], channelIds: [] }, render)).toMatch(/no enabled email channel/);
  });
});

describe("what the dialog pre-fills", () => {
  it("first time: the user themselves (a user pill), on the default channel", async () => {
    h.state.users = [{ id: "u1", email: "Alice@Example.com", lastFirmwareNotify: null, lastRebootNotify: null }];
    expect(await defaultNotifyFor("u1", "firmware")).toEqual({
      notify: { to: { recipientUserIds: ["u1"] }, cc: null, bcc: null, channelIds: [] },
      notifyEmails: ["alice@example.com"],
    });
    expect(await defaultNotifyFor(null, "reboot")).toEqual({ notify: null, notifyEmails: [] });
  });

  it("then the spec they last used — one per kind — with its device-free addresses for the group dialog", async () => {
    h.state.users = [{ id: "u1", email: "alice@example.com", lastFirmwareNotify: null, lastRebootNotify: null }];
    const fw = { to: { recipientUserIds: ["u1"], addresses: ["ops@example.com"], recipientDeviceRegion: true }, cc: null, bcc: null, channelIds: ["ch-m365"] };
    await rememberNotifyFor("u1", "firmware", fw);
    const got = await defaultNotifyFor("u1", "firmware");
    expect(got.notify).toEqual(fw);
    expect(got.notifyEmails.sort()).toEqual(["alice@example.com", "ops@example.com"]);
    // The reboot list is its own.
    expect((await defaultNotifyFor("u1", "reboot")).notify?.to).toEqual({ recipientUserIds: ["u1"] });
  });

  it("a remembered list carried over by the migration (typed addresses, no channels) still pre-fills", async () => {
    h.state.users = [{ id: "u1", email: "a@example.com", lastRebootNotify: { to: { addresses: ["noc@example.com"] }, channelIds: [] } }];
    expect((await defaultNotifyFor("u1", "reboot")).notify).toEqual({ to: { addresses: ["noc@example.com"] }, channelIds: [] });
  });

  it("no signed-in user (a bearer token) remembers nothing", async () => {
    await rememberNotifyFor(null, "firmware", SPEC);
    expect(h.state.users).toEqual([]);
  });

  it("the dialog's defaults carry the catalogue, the users without push counts, and the EMAIL channels only", async () => {
    h.state.users = [{ id: "u1", email: "a@example.com" }];
    const d = await notifyDialogDefaults("u1", "firmware");
    expect(d.catalog.regions).toEqual(["North"]);
    expect(d.users).toEqual([{ id: "u1", username: "alice", displayName: "Alice", email: "alice@example.com" }]);
    expect(d.channels.map((c) => c.id)).toEqual(["ch-smtp", "ch-m365"]);
  });
});
