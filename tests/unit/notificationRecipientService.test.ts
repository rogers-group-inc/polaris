/**
 * tests/unit/notificationRecipientService.test.ts — notificationRecipientService's
 * own suite (CQ-T010).
 *
 * Complements (and does not repeat) the ~25 suites that reach expandDeliveries
 * through the engine: notificationBroadcast (region-only vs flattened match,
 * broadcast modes), notificationRegionLevels (level routing), alertAckRecipientGate
 * (rule 25 one-To-line), notificationAssetContacts, alertFooterSendScope (dispatch
 * stamp), quietTimeHoldAtFire (rule 92 / 120 holds through the action layer),
 * alertEmailTemplate / alertEmailManagedBy (buildComposedEmail), and
 * operationNotifyService (which only MOCKS resolveRebootActionRecipients).
 *
 * Covered here, directly against the service:
 *   - the user index: disabled accounts excluded (rule 140(a)), canAcknowledge
 *     from the role matrix, preference normalisation, 30 s cache + bump
 *   - resolveRecipientUsersByIds / ByRoles empty-input contracts, listRecipientUsers
 *   - dedupeEmailRecipients, preferenceWithholds, fillComposedAckUrl, defaultBodyContext
 *   - resolveRebootActionRecipients (rule 115(c)) — the first test of the real one
 *   - expandDeliveries: disabled / missing / unknown channels, the address owner
 *     map's order + dedupe, composed To/Cc/Bcc (Bcc never on the target, rule 60),
 *     noAck / allClear meta, webhook rows, push fallback + noAck for read-only,
 *     the rule 39 preference filter (and that it never deletes the alert),
 *     hold → held / deferred status, rule 120 isHeldFor split and
 *     excludeRecipients, provenance stamps, stats
 *   - scopeRegionTagsOf
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/regionScopeService.js", () => ({
  resolveTagScopesForUser: vi.fn(async (u: { regionTags: string[]; otherTags: string[] }) => ({
    regionTags: { effective: u.regionTags },
    otherTags: { effective: u.otherTags },
  })),
}));
const region = vi.hoisted(() => ({
  regionLevelIndex: vi.fn(async () => ({}) as never),
  orphanedRegionTags: vi.fn((_t: string[], _i: unknown): string[] => []),
  deviceRegionsAtLevels: vi.fn((_t: string[], _l: number[], _i: unknown): string[] => []),
}));
vi.mock("../../src/services/regionHierarchyService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ...region,
}));

import {
  bumpRecipientIndex,
  resolveRecipientUsers,
  resolveRecipientUsersByIds,
  resolveUsersByRoles,
  resolveAllUsers,
  listRecipientUsers,
  dedupeEmailRecipients,
  preferenceWithholds,
  fillComposedAckUrl,
  defaultBodyContext,
  resolveRebootActionRecipients,
  expandDeliveries,
  scopeRegionTagsOf,
} from "../../src/services/notificationRecipientService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

type U = {
  id: string; email: string | null; displayName: string | null; regionTags: string[]; otherTags: string[];
  ssoGroups: string[]; authProvider: string; roleId: string; notificationPreference: string | null;
  role: { permissions: Record<string, string> } | null;
};
function user(id: string, over: Partial<U> = {}): U {
  return {
    id, email: `${id}@example.test`, displayName: id.toUpperCase(), regionTags: [], otherTags: [],
    ssoGroups: [], authProvider: "local", roleId: "r-noc", notificationPreference: null,
    role: { permissions: { alerts: "write" } }, ...over,
  };
}

let users: U[] = [];
let channels: Array<{ id: string; type: string; enabled: boolean }> = [];
let subs: Array<{ userId: string; endpoint: string; p256dh: string; auth: string; surface: string }> = [];
const written = (): Array<Record<string, any>> =>
  stubbed(prisma.notificationDelivery.createMany).mock.calls.flatMap((c) => c[0].data);

beforeEach(() => {
  resetDbStub();
  bumpRecipientIndex();
  delete process.env.POLARIS_PUBLIC_URL;
  users = [
    user("u1", { regionTags: ["Atlanta"], roleId: "r-noc" }),
    user("u2", { regionTags: ["Memphis"], roleId: "r-ro", role: { permissions: { alerts: "read" } } }),
    user("u3", { email: null, otherTags: ["oncall"], roleId: "r-noc" }),
  ];
  channels = [
    { id: "c-mail", type: "smtp", enabled: true },
    { id: "c-push", type: "web_push", enabled: true },
    { id: "c-slack", type: "slack", enabled: true },
    { id: "c-off", type: "smtp", enabled: false },
    { id: "c-weird", type: "carrier_pigeon", enabled: true },
  ];
  subs = [];
  stubbed(prisma.user.findMany).mockImplementation(async (args: any) => (args?.where?.disabledAt === null ? users : users));
  stubbed(prisma.notificationChannel.findMany).mockImplementation(async ({ where }: any) => channels.filter((c) => where.id.in.includes(c.id)));
  stubbed(prisma.pushSubscription.findMany).mockImplementation(async ({ where }: any) => subs.filter((s) => where.userId.in.includes(s.userId)));
  stubbed(prisma.pushSubscription.groupBy).mockImplementation(async () => {
    const m = new Map<string, number>();
    for (const s of subs) m.set(s.userId, (m.get(s.userId) ?? 0) + 1);
    return [...m].map(([userId, n]) => ({ userId, _count: { _all: n } }));
  });
  stubbed(prisma.notificationDelivery.createMany).mockImplementation(async ({ data }: any) => ({ count: data.length }));
  region.regionLevelIndex.mockImplementation(async () => ({}) as never);
  region.orphanedRegionTags.mockImplementation(() => []);
  region.deviceRegionsAtLevels.mockImplementation(() => []);
});

afterEach(() => {
  delete process.env.POLARIS_PUBLIC_URL;
});

describe("the user index", () => {
  it("reads only enabled accounts (rule 140(a))", async () => {
    await resolveAllUsers();
    expect(stubbed(prisma.user.findMany).mock.calls[0][0].where).toEqual({ disabledAt: null });
  });

  it("derives canAcknowledge from alerts >= write, defaulting true without a role", async () => {
    users.push(user("u4", { role: null }));
    const all = await resolveAllUsers();
    expect(Object.fromEntries(all.map((u) => [u.id, u.canAcknowledge]))).toEqual({ u1: true, u2: false, u3: true, u4: true });
  });

  it("normalises an unknown preference to email and keeps a valid one", async () => {
    users[0].notificationPreference = "push";
    users[1].notificationPreference = "carrier-pigeon";
    const all = await resolveAllUsers();
    expect(all.map((u) => u.notificationPreference)).toEqual(["push", "email", "email"]);
  });

  it("projects to the recipient shape — no tag sets or roleId leak", async () => {
    const [u] = await resolveRecipientUsersByIds(["u1"]);
    expect(Object.keys(u).sort()).toEqual(["canAcknowledge", "displayName", "email", "id", "notificationPreference"]);
  });

  it("caches the index across calls until bumpRecipientIndex", async () => {
    await resolveAllUsers();
    await resolveAllUsers();
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    bumpRecipientIndex();
    await resolveAllUsers();
    expect(prisma.user.findMany).toHaveBeenCalledTimes(2);
  });
});

describe("resolvers' empty-input contracts", () => {
  it("an empty or absent list routes to nobody, without loading the index", async () => {
    expect(await resolveRecipientUsers([])).toEqual([]);
    expect(await resolveRecipientUsers(undefined)).toEqual([]);
    expect(await resolveRecipientUsers(["region:"])).toEqual([]);
    expect(await resolveRecipientUsersByIds([])).toEqual([]);
    expect(await resolveUsersByRoles(["", ""])).toEqual([]);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("matches roles by id and tags case-insensitively through the region prefix", async () => {
    expect((await resolveUsersByRoles(["r-noc"])).map((u) => u.id)).toEqual(["u1", "u3"]);
    expect((await resolveRecipientUsers(["REGION:atlanta", "OnCall"])).map((u) => u.id)).toEqual(["u1", "u3"]);
  });
});

describe("listRecipientUsers", () => {
  it("joins each user's push-device count, zero when none", async () => {
    stubbed(prisma.user.findMany).mockResolvedValue([{ id: "u1", username: "a", displayName: null, email: null }, { id: "u2", username: "b", displayName: null, email: null }]);
    subs = [{ userId: "u2", endpoint: "e1", p256dh: "k", auth: "a", surface: "desktop" }, { userId: "u2", endpoint: "e2", p256dh: "k", auth: "a", surface: "mobile" }];
    const out = await listRecipientUsers();
    expect(out.map((u) => [u.id, u.pushDevices])).toEqual([["u1", 0], ["u2", 2]]);
    expect(stubbed(prisma.user.findMany).mock.calls[0][0].orderBy).toEqual({ username: "asc" });
  });
});

describe("pure helpers", () => {
  it("dedupeEmailRecipients: To wins over Cc, Bcc drops anything visible, case-insensitively", () => {
    expect(dedupeEmailRecipients(["A@x.test"], ["a@x.test", "b@x.test"], ["B@X.TEST", "c@x.test", "A@x.test"]))
      .toEqual({ cc: ["b@x.test"], bcc: ["c@x.test"] });
  });

  it("preferenceWithholds only when the preferred channel can actually reach them", () => {
    expect(preferenceWithholds("email", "email", { hasPushDevice: false, hasEmail: true })).toBe(false);
    expect(preferenceWithholds("push", "email", { hasPushDevice: true, hasEmail: true })).toBe(true);
    expect(preferenceWithholds("push", "email", { hasPushDevice: false, hasEmail: true })).toBe(false);
    expect(preferenceWithholds("email", "web_push", { hasPushDevice: true, hasEmail: true })).toBe(true);
    expect(preferenceWithholds("email", "web_push", { hasPushDevice: true, hasEmail: false })).toBe(false);
    expect(preferenceWithholds("any", "web_push", { hasPushDevice: false, hasEmail: false })).toBe(false);
  });

  it("fillComposedAckUrl substitutes one URL everywhere, and leaves no html key when there was none", () => {
    const out = fillComposedAckUrl({ subject: "s", text: "Ack: {ack}\nend", html: '<a href="{ack}">Ack</a>' }, "https://p.example.test/alert-ack.html?id=n1");
    expect(out.text).toContain("https://p.example.test/alert-ack.html?id=n1");
    expect(out.html).toContain("https://p.example.test/alert-ack.html?id=n1");
    expect(out.text).not.toContain("{ack}");
    expect("html" in fillComposedAckUrl({ subject: "s", text: "t" }, null)).toBe(false);
  });

  it("fillComposedAckUrl with no URL leaves no literal token behind", () => {
    const out = fillComposedAckUrl({ subject: "s {ack}", text: "line\n{ack}\nend", html: '<p>x</p><a href="{ack}">Acknowledge</a>' }, null);
    expect(out.subject).not.toContain("{ack}");
    expect(out.text).not.toContain("{ack}");
    expect(out.html).not.toContain("{ack}");
  });

  it("defaultBodyContext blanks device facts on an interface alert only, without mutating", () => {
    const ctx = { metric: "ifOperStatus", "asset.ip": "10.0.0.1", "asset.model": "M", asset: "sw1", "asset.link": "L" };
    const out = defaultBodyContext(ctx);
    expect(out).toMatchObject({ "asset.ip": "", "asset.model": "", asset: "sw1", "asset.link": "L" });
    expect(ctx["asset.ip"]).toBe("10.0.0.1");
    const cpu = { metric: "cpuPercent", "asset.ip": "10.0.0.1" };
    expect(defaultBodyContext(cpu)).toBe(cpu);
  });

  it("scopeRegionTagsOf collects region: tags from the flat list and positive 'has' leaves, deduped", () => {
    expect(scopeRegionTagsOf({
      tags: ["region:East", "rack:7", "Region:West"],
      condition: { op: "and", children: [
        { field: "tag", operator: "has", value: "region:North" },
        { field: "tag", operator: "lacks", value: "region:South" },
        { op: "or", children: [{ field: "tag", operator: "has", value: "region:East" }, { field: "hostname", operator: "has", value: "region:Nope" }] },
      ] },
    }).sort()).toEqual(["Region:West", "region:East", "region:North"]);
    expect(scopeRegionTagsOf(null)).toEqual([]);
    expect(scopeRegionTagsOf({ tags: "region:x" as never })).toEqual([]);
  });
});

describe("resolveRebootActionRecipients (rule 115(c))", () => {
  it("resolves To from users, typed addresses and contacts, deduped; Cc/Bcc never repeat To", async () => {
    const out = await resolveRebootActionRecipients(
      {
        recipientUserIds: ["u1", "u3"], // u3 has no address — contributes none
        notifyEmails: ["Ops@Example.test"],
        addresses: ["u1@example.test"],
        recipientAssetContacts: true,
        cc: { recipientUserIds: ["u1", "u2"], addresses: ["cc@example.test"] },
        bcc: { addresses: ["CC@example.test", "hidden@example.test"] },
      },
      { assetContactEmails: ["owner@example.test"] },
    );
    expect(out.to).toEqual(["ops@example.test", "u1@example.test", "owner@example.test"]);
    expect(out.cc.sort()).toEqual(["cc@example.test", "u2@example.test"]);
    expect(out.bcc).toEqual(["hidden@example.test"]);
  });

  it("ignores contacts unless asked, and device-region routing without asset tags", async () => {
    const out = await resolveRebootActionRecipients(
      { recipientDeviceRegion: true, recipientDeviceRegionLevels: [1] },
      { assetContactEmails: ["owner@example.test"] },
    );
    expect(out).toEqual({ to: [], cc: [], bcc: [] });
    expect(region.regionLevelIndex).not.toHaveBeenCalled();
  });

  it("routes to the device's region and to the users at a level out from it", async () => {
    region.deviceRegionsAtLevels.mockReturnValue(["Memphis"]);
    const out = await resolveRebootActionRecipients(
      { recipientDeviceRegion: true, recipientDeviceRegionLevels: [2] },
      { assetRegionTags: ["Atlanta"] },
    );
    expect(out.to.sort()).toEqual(["u1@example.test", "u2@example.test"]);
    expect(region.deviceRegionsAtLevels).toHaveBeenCalledWith(["Atlanta"], [2], expect.anything());
  });

  it("abstains from level routing when the asset carries an orphaned region tag (rule 58)", async () => {
    region.orphanedRegionTags.mockReturnValue(["Gone"]);
    region.deviceRegionsAtLevels.mockReturnValue(["Memphis"]);
    const out = await resolveRebootActionRecipients({ recipientDeviceRegionLevels: [1] }, { assetRegionTags: ["Gone"] });
    expect(out.to).toEqual([]);
  });
});

describe("expandDeliveries — channels and plain email", () => {
  it("returns 0 and writes nothing for no targets, no channel ids, or only unusable channels", async () => {
    expect(await expandDeliveries("n1", undefined)).toBe(0);
    expect(await expandDeliveries("n1", [{ channelId: "" } as never])).toBe(0);
    expect(await expandDeliveries("n1", [
      { channelId: "c-off", addresses: ["a@example.test"] },
      { channelId: "c-missing", addresses: ["a@example.test"] },
      { channelId: "c-weird", addresses: ["a@example.test"] },
    ] as never)).toBe(0);
    expect(prisma.notificationDelivery.createMany).not.toHaveBeenCalled();
  });

  it("writes one row per distinct address: typed first, then users, then contacts", async () => {
    const n = await expandDeliveries("n1", [
      { channelId: "c-mail", addresses: [" Typed@Example.test ", ""], recipientUserIds: ["u1", "u3"], recipientAssetContacts: true },
    ] as never, { assetContactEmails: ["u1@example.test", "contact@example.test"] });
    expect(n).toBe(3);
    expect(written().map((r) => r.target)).toEqual(["typed@example.test", "u1@example.test", "contact@example.test"]);
    expect(written()[0]).toEqual({ notificationId: "n1", channelId: "c-mail", transport: "email", target: "typed@example.test", meta: undefined });
  });

  it("dedupes the same channel/transport/target across two targets", async () => {
    await expandDeliveries("n1", [
      { channelId: "c-mail", addresses: ["a@example.test"] },
      { channelId: "c-mail", addresses: ["A@example.test"] },
    ] as never);
    expect(written()).toHaveLength(1);
  });

  it("marks a plain all-clear row noAck, and skips a target that resolves no address", async () => {
    await expandDeliveries("n1", [
      { channelId: "c-mail", addresses: ["a@example.test"] },
      { channelId: "c-mail", recipientUserIds: ["u3"] }, // u3 has no email
    ] as never, { noAck: true });
    expect(written()).toEqual([expect.objectContaining({ target: "a@example.test", meta: { noAck: true } })]);
  });
});

describe("expandDeliveries — composed email", () => {
  const composed = { subject: "Down", text: "Ack {ack}", html: '<a href="{ack}">Acknowledge</a>', cc: { addresses: ["cc@example.test", "a@example.test"] }, bcc: { addresses: ["blind@example.test", "cc@example.test"] } };

  it("writes ONE row: target is the To line only; Bcc rides meta, never the target (rule 60)", async () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.test/";
    await expandDeliveries("n1", [{ channelId: "c-mail", addresses: ["a@example.test", "b@example.test"] }] as never, { composedEmail: composed });
    const rows = written();
    expect(rows).toHaveLength(1);
    expect(rows[0].target).toBe("a@example.test, b@example.test");
    expect(rows[0].target).not.toContain("blind");
    expect(rows[0].meta).toMatchObject({ composed: true, to: ["a@example.test", "b@example.test"], cc: ["cc@example.test"], bcc: ["blind@example.test"], subject: "Down" });
    expect(rows[0].meta.text).toContain("https://polaris.example.test/");
    expect(rows[0].meta.allClear).toBeUndefined();
  });

  it("an all-clear blanks the ack link and says allClear to the drain", async () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.test";
    await expandDeliveries("n1", [{ channelId: "c-mail", addresses: ["a@example.test"] }] as never, { composedEmail: { subject: "s", text: "Ack {ack}" }, noAck: true });
    const meta = written()[0].meta;
    expect(meta.allClear).toBe(true);
    expect(meta.text).not.toContain("polaris.example.test");
    expect("html" in meta).toBe(false);
  });
});

describe("expandDeliveries — web push, chat, preference", () => {
  beforeEach(() => {
    subs = [
      { userId: "u1", endpoint: "https://push.example.test/u1", p256dh: "pk", auth: "ak", surface: "desktop" },
      { userId: "u2", endpoint: "https://push.example.test/u2", p256dh: "pk", auth: "ak", surface: "mobile" },
    ];
  });

  it("one row per subscription, stamped with the owner, an email fallback, and noAck for a read-only role", async () => {
    await expandDeliveries("n1", [
      { channelId: "c-push", recipientUserIds: ["u1", "u2"] },
      { channelId: "c-mail", addresses: ["x@example.test"] },
    ] as never, { followUp: "Reminders every 15 minutes" });
    const push = written().filter((r) => r.transport === "web_push");
    expect(push).toHaveLength(2);
    expect(push[0].meta).toEqual({
      p256dh: "pk", auth: "ak", surface: "desktop", userId: "u1",
      fallback: { userId: "u1", channelId: "c-mail", address: "u1@example.test" },
      followUp: "Reminders every 15 minutes",
    });
    expect(push[1].meta.noAck).toBe(true);
  });

  it("no fallback when the action carries no enabled email channel; allClear message stamped", async () => {
    await expandDeliveries("n1", [{ channelId: "c-push", recipientUserIds: ["u1"] }, { channelId: "c-off" }] as never, { allClearMessage: "Resolved: sw1 recovered" });
    const meta = written()[0].meta;
    expect(meta.fallback).toBeUndefined();
    expect(meta).toMatchObject({ allClear: true, message: "Resolved: sw1 recovered" });
  });

  it("writes nothing for matched users with no device, without querying subscriptions for nobody", async () => {
    expect(await expandDeliveries("n1", [{ channelId: "c-push", recipientUserIds: ["u3"] }] as never)).toBe(0);
    expect(await expandDeliveries("n1", [{ channelId: "c-push", recipientUserIds: ["nobody"] }] as never)).toBe(0);
    expect(stubbed(prisma.pushSubscription.findMany).mock.calls).toHaveLength(1);
  });

  it("recipientAllUsers is push-only: it does not widen the email half of the same action", async () => {
    await expandDeliveries("n1", [{ channelId: "c-mail", recipientAllUsers: true, addresses: ["a@example.test"] }] as never);
    expect(written().map((r) => r.target)).toEqual(["a@example.test"]);
  });

  it("a chat channel writes one fixed-destination row, with allClear meta only on an all-clear", async () => {
    await expandDeliveries("n1", [{ channelId: "c-slack" }] as never);
    expect(written()).toEqual([{ notificationId: "n1", channelId: "c-slack", transport: "webhook", target: "", meta: undefined }]);
    stubbed(prisma.notificationDelivery.createMany).mockClear();
    await expandDeliveries("n2", [{ channelId: "c-slack" }] as never, { allClearMessage: "ok" });
    expect(written()[0].meta).toEqual({ allClear: true, message: "ok" });
  });

  it("rule 39: drops a push-preferring user from email only when enforced AND their push can reach them", async () => {
    users[0].notificationPreference = "push"; // u1 has a device
    users[1].notificationPreference = "push"; // u2 has a device too
    subs = subs.filter((s) => s.userId === "u1"); // ...now only u1 does
    const t = [{ channelId: "c-mail", recipientUserIds: ["u1", "u2"], respectUserPreference: true }] as never;
    await expandDeliveries("n1", t);
    expect(written().map((r) => r.target)).toEqual(["u1@example.test", "u2@example.test"]); // not enforced
    stubbed(prisma.notificationDelivery.createMany).mockClear();
    await expandDeliveries("n1", t, { enforceUserPreference: true });
    expect(written().map((r) => r.target)).toEqual(["u2@example.test"]); // u2 kept: no device to route to
  });

  it("rule 39 never touches a target that did not opt in, even when the caller enforces", async () => {
    users[0].notificationPreference = "push";
    subs = subs.filter((s) => s.userId === "u1");
    await expandDeliveries("n1", [{ channelId: "c-mail", recipientUserIds: ["u1"] }] as never, { enforceUserPreference: true });
    expect(written().map((r) => r.target)).toEqual(["u1@example.test"]);
    expect(prisma.pushSubscription.groupBy).not.toHaveBeenCalled();
  });
});

describe("expandDeliveries — provenance, holds (rules 92 / 120) and stats", () => {
  const windowEnd = new Date("2026-03-08T12:00:00Z");

  it("stamps escalation / repeat / dispatch into every row's meta", async () => {
    await expandDeliveries("n1", [{ channelId: "c-mail", addresses: ["a@example.test"] }] as never, {
      escalation: { tier: 2, attempt: 1 }, repeat: { attempt: 3 }, dispatchId: "d-1",
    });
    expect(written()[0].meta).toEqual({ escalation: { tier: 2, attempt: 1 }, repeat: { attempt: 3 }, dispatch: "d-1" });
  });

  it("a hold writes status 'held' with the window stamp; a held reminder is 'deferred'", async () => {
    const stats = { live: 0, held: 0 };
    await expandDeliveries("n1", [{ channelId: "c-mail", addresses: ["a@example.test"] }, { channelId: "c-slack" }] as never, {
      hold: { kind: "automation", id: "qt-1", windowEnd }, stats,
    });
    expect(written().map((r) => r.status)).toEqual(["held", "held"]);
    expect(written()[1].meta).toEqual({ quietHold: { kind: "automation", id: "qt-1", windowEnd: "2026-03-08T12:00:00.000Z" } });
    expect(stats).toEqual({ live: 0, held: 2 });
    stubbed(prisma.notificationDelivery.createMany).mockClear();
    await expandDeliveries("n1", [{ channelId: "c-mail", addresses: ["a@example.test"] }] as never, {
      hold: { kind: "global", id: "g", windowEnd }, repeat: { attempt: 1 },
    });
    expect(written()[0].status).toBe("deferred");
  });

  it("no hold → no status key at all (byte-identical pending row) and stats count live", async () => {
    const stats = { live: 0, held: 0 };
    await expandDeliveries("n1", [{ channelId: "c-mail", addresses: ["a@example.test"] }] as never, { stats });
    expect("status" in written()[0]).toBe(false);
    expect(stats).toEqual({ live: 1, held: 0 });
  });

  it("rule 120: a composed send splits into a live row for the excepted and a held row for the rest; an emptied To promotes Cc", async () => {
    await expandDeliveries("n1", [{ channelId: "c-mail", addresses: ["boss@example.test", "team@example.test"] }] as never, {
      composedEmail: { subject: "s", text: "t", cc: { addresses: ["bosscc@example.test"] } },
      hold: { kind: "automation", id: "q", windowEnd, isHeldFor: (a) => a !== "boss@example.test" && a !== "bosscc@example.test" },
    });
    const rows = written();
    expect(rows.map((r) => [r.target, r.status ?? "live", r.meta.cc])).toEqual([
      ["boss@example.test", "live", ["bosscc@example.test"]],
      ["team@example.test", "held", []],
    ]);
    stubbed(prisma.notificationDelivery.createMany).mockClear();
    await expandDeliveries("n1", [{ channelId: "c-mail", addresses: ["team@example.test"] }] as never, {
      composedEmail: { subject: "s", text: "t", cc: { addresses: ["bosscc@example.test"] } },
      hold: { kind: "automation", id: "q", windowEnd, isHeldFor: (a) => a !== "bosscc@example.test" },
    });
    expect(written().map((r) => [r.target, r.status ?? "live"])).toEqual([["bosscc@example.test", "live"], ["team@example.test", "held"]]);
  });

  it("rule 120 all-clear: excludeRecipients drops held-for addresses, users and (optionally) chat", async () => {
    subs = [{ userId: "u1", endpoint: "e-u1", p256dh: "k", auth: "a", surface: "desktop" }, { userId: "u2", endpoint: "e-u2", p256dh: "k", auth: "a", surface: "desktop" }];
    await expandDeliveries("n1", [
      { channelId: "c-mail", addresses: ["Skip@example.test", "keep@example.test"] },
      { channelId: "c-push", recipientUserIds: ["u1", "u2"] },
      { channelId: "c-slack" },
    ] as never, {
      composedEmail: { subject: "s", text: "t", cc: { addresses: ["skip@example.test", "cc@example.test"] } },
      excludeRecipients: { addresses: new Set(["skip@example.test", "u2@example.test"]), userIds: new Set<string>(), chat: true },
    });
    const rows = written();
    expect(rows.find((r) => r.transport === "email")).toMatchObject({ target: "keep@example.test", meta: { cc: ["cc@example.test"] } });
    expect(rows.filter((r) => r.transport === "web_push").map((r) => r.target)).toEqual(["e-u1"]);
    expect(rows.some((r) => r.transport === "webhook")).toBe(false);
  });
});
