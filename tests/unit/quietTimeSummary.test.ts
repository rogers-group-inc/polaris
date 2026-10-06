/**
 * tests/unit/quietTimeSummary.test.ts
 *
 * The summary that ends a quiet window (business rule 92): when it is due,
 * what it lists (outstanding vs recurring), who it goes to and in whose zone,
 * which channel carries it, and how retries roll up. The pure halves are
 * tested directly; the create/drain halves run against an in-memory prisma.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = {
  notifs: [] as any[],
  notifUpdates: [] as any[],
  deliveries: [] as any[],
  channels: [] as any[],
  users: [] as any[],
  summaries: [] as any[],
  schedules: [] as any[],
  rules: [] as any[],
  events: [] as any[],
  sent: [] as any[],
  failNext: [] as string[],
};

vi.mock("../../src/db.js", () => {
  const prisma: any = {
    notification: {
      findMany: vi.fn(async ({ where }: any) => {
        if (where?.quietSummarizedAt === null) return db.notifs.filter((n) => n.quietHeldAt && !n.quietSummarizedAt);
        return db.notifs;
      }),
      update: vi.fn(async (args: any) => { db.notifUpdates.push(args); return {}; }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let n = 0;
        for (const x of db.notifs) if (where.id.in.includes(x.id) && !x.quietSummarizedAt) { x.quietSummarizedAt = data.quietSummarizedAt; n++; }
        return { count: n };
      }),
    },
    notificationDelivery: {
      findMany: vi.fn(async ({ where }: any) => db.deliveries.filter((d) => where.notificationId.in.includes(d.notificationId) && d.status === where.status)),
    },
    notificationChannel: {
      findMany: vi.fn(async ({ where, take }: any) => {
        let rows = db.channels;
        if (where?.id?.in) rows = rows.filter((c) => where.id.in.includes(c.id));
        if (where?.enabled !== undefined) rows = rows.filter((c) => c.enabled === where.enabled);
        if (where?.type?.in) rows = rows.filter((c) => where.type.in.includes(c.type));
        return take ? rows.slice(0, take) : rows;
      }),
      findUnique: vi.fn(async ({ where }: any) => db.channels.find((c) => c.id === where.id) ?? null),
    },
    user: {
      findMany: vi.fn(async ({ where }: any = {}) => {
        // The recipient service's user index loads everyone with no filter.
        if (!where || (!where.id && !where.OR && !where.email)) return db.users;
        const ids: string[] = where?.id?.in ?? where?.OR?.find((o: any) => o.id)?.id?.in ?? [];
        const emails: string[] = where?.OR?.find((o: any) => o.email)?.email?.in ?? [];
        return db.users.filter((u) => ids.includes(u.id) || (u.email && emails.includes(u.email.toLowerCase())));
      }),
    },
    quietTimeSummary: {
      create: vi.fn(async ({ data }: any) => { const row = { id: `s${db.summaries.length + 1}`, createdAt: new Date(), ...data }; db.summaries.push(row); return { id: row.id }; }),
      findMany: vi.fn(async ({ where }: any) => db.summaries.filter((s) => where.status.in.includes(s.status))),
      findFirst: vi.fn(async ({ where }: any) => db.summaries.find((s) =>
        s.sourceKind === where.sourceKind && s.sourceId === where.sourceId && s.coveredTo.getTime() >= where.coveredTo.gte.getTime()) ?? null),
      findUnique: vi.fn(async ({ where }: any) => db.summaries.find((s) => s.id === where.id) ?? null),
      update: vi.fn(async ({ where, data }: any) => { Object.assign(db.summaries.find((s) => s.id === where.id), data); return {}; }),
    },
    quietTimeSchedule: {
      findMany: vi.fn(async () => db.schedules),
      findUnique: vi.fn(async ({ where }: any) => db.schedules.find((s) => s.id === where.id) ?? null),
    },
    notificationRule: {
      findMany: vi.fn(async () => db.rules),
      findUnique: vi.fn(async ({ where }: any) => db.rules.find((r) => r.id === where.id) ?? null),
    },
    $transaction: vi.fn(async (fn: any) => (typeof fn === "function" ? fn(prisma) : Promise.all(fn))),
  };
  return { prisma };
});
vi.mock("../../src/services/eventLogService.js", () => ({
  logEvent: vi.fn(async (e: any) => { db.events.push(e); }),
}));
// The static-recipient resolvers are the recipient service's own, tested
// there; here they read the in-memory users so the all-quiet audience can be
// asserted without the user index's role / group-mapping reads.
vi.mock("../../src/services/notificationRecipientService.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/services/notificationRecipientService.js")>();
  const byIds = async (ids?: string[]) => db.users.filter((u) => (ids ?? []).includes(u.id));
  return {
    ...real,
    resolveRecipientUsersByIds: vi.fn(byIds),
    resolveAllUsers: vi.fn(async () => db.users),
    resolveUsersInAnyRegion: vi.fn(async () => []),
    resolveUsersByRegions: vi.fn(async (names?: string[]) => db.users.filter((u) => (u.regions ?? []).some((r: string) => (names ?? []).includes(r)))),
    resolveUsersByRoles: vi.fn(async () => []),
    resolveRecipientUsers: vi.fn(async (tags?: string[]) => db.users.filter((u) => (u.regions ?? []).some((r: string) => (tags ?? []).includes(r)))),
  };
});
// The scope loader is the engine's own; here a rule's monitored devices are
// just their region snapshots, keyed by rule id through the scope.
const scopeSnapshots = vi.hoisted(() => vi.fn(async (_scope: any): Promise<string[][]> => []));
vi.mock("../../src/services/notificationEngine.js", () => ({ loadScopeRegionSnapshots: scopeSnapshots }));
// One containment edge: Nashville sits inside the Central division.
vi.mock("../../src/services/regionHierarchyService.js", () => ({
  regionLevelIndex: vi.fn(async () => ({})),
  deviceRegionsAtLevels: vi.fn((snap: string[], levels: number[]) =>
    snap.includes("Nashville") ? levels.map((l) => (l === 1 ? "Nashville" : "Central")) : levels.map(() => snap[0]!)),
}));
vi.mock("../../src/services/notificationChannels/emailChannel.js", () => ({
  sendSmtpEmail: vi.fn(async (_cfg: any, msg: any) => {
    const to = Array.isArray(msg.to) ? msg.to[0] : msg.to;
    if (db.failNext.includes(to)) { db.failNext.splice(db.failNext.indexOf(to), 1); throw new Error("smtp down"); }
    db.sent.push(msg);
  }),
  sendM365Email: vi.fn(async () => {}),
}));
vi.mock("../../src/services/alertBrandService.js", () => ({
  BRAND_TOKENS: ["brand.header"],
  BRAND_LOGO_CID: "polaris-brand-logo",
  brandTokensIn: () => new Set(),
  substituteBrandTokens: (b: string) => b,
  buildAlertBrandBlock: async () => ({ html: "", text: "", attachment: null }),
}));

import {
  summaryDue,
  buildSummaryDetails,
  recipientsFromHeldRows,
  createDueSummaries,
  drainPendingSummaries,
  runQuietTimeSummaries,
  resendSummary,
  SUMMARY_MAX_ATTEMPTS,
} from "../../src/services/quietTimeSummaryService.js";
import { bumpQuietTimeCache } from "../../src/services/quietTimeHoldService.js";
import { bumpRecipientIndex } from "../../src/services/notificationRecipientService.js";
import { quietTimeConfigSchema } from "../../src/utils/quietTime.js";

const at = (y: number, m: number, d: number, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0);
const NIGHTLY = { version: 1, kind: "recurring", freq: "daily", hours: [{ startTime: "22:00", endTime: "06:00" }] };
const EARLY = { version: 1, kind: "recurring", freq: "daily", hours: [{ startTime: "07:00", endTime: "08:00" }] };
const cfg = (extra: Record<string, unknown> = {}) => quietTimeConfigSchema.parse({ windows: [NIGHTLY], ...extra });

// A Friday night in October 2026: held at 02:00 Sat, window ends 06:00 Sat.
const HELD_AT = at(2026, 10, 3, 2, 0);
const WINDOW_END = at(2026, 10, 3, 6, 0);

function heldAlert(over: Record<string, unknown> = {}) {
  const n = {
    id: `n${db.notifs.length + 1}`,
    ruleId: "r1",
    assetId: "a1",
    assetHostname: "sw-1",
    severity: "serious",
    message: "port12 is down",
    dimension: "port12",
    metric: "ifOperStatus",
    triggeredAt: HELD_AT,
    cleared: false,
    quietHeldAt: HELD_AT,
    quietSummarizedAt: null,
    quietSource: { kind: "global", id: "g1", name: "Nights" },
    rule: { name: "Port down" },
    ...over,
  };
  db.notifs.push(n);
  return n;
}

beforeEach(() => {
  for (const k of ["notifs", "notifUpdates", "deliveries", "channels", "users", "summaries", "schedules", "rules", "events", "sent", "failNext"] as const) (db as any)[k].length = 0;
  bumpQuietTimeCache();
  // The recipient resolvers read a cached user index; a test that seeds users
  // after an earlier test built it would otherwise resolve nobody.
  bumpRecipientIndex();
  scopeSnapshots.mockReset();
  scopeSnapshots.mockImplementation(async () => []);
  db.schedules.push({ id: "g1", name: "Nights", scope: {}, quiet: { windows: [NIGHTLY] }, enabled: true, createdAt: at(2026, 10, 1), updatedAt: at(2026, 10, 1) });
  db.channels.push({ id: "ch-email", type: "smtp", enabled: true, config: { host: "mail", from: "polaris@example.com" }, createdAt: new Date() });
});

describe("summaryDue", () => {
  it("is not due before the window ends, due at the end when no time is set", () => {
    expect(summaryDue(cfg(), HELD_AT, at(2026, 10, 3, 5, 59)).due).toBe(false);
    const r = summaryDue(cfg(), HELD_AT, at(2026, 10, 3, 6, 0));
    expect(r.due).toBe(true);
    expect(r.coveredTo).toEqual(WINDOW_END);
  });

  it("waits for the send time, then is due", () => {
    expect(summaryDue(cfg({ summaryAt: "07:30" }), HELD_AT, at(2026, 10, 3, 7, 0)).due).toBe(false);
    expect(summaryDue(cfg({ summaryAt: "07:30" }), HELD_AT, at(2026, 10, 3, 7, 30)).due).toBe(true);
  });

  it("folds into the next window when one has already opened again", () => {
    const c = quietTimeConfigSchema.parse({ windows: [NIGHTLY, EARLY], summaryAt: "09:00" });
    // 07:15: the send time has not come and the early window is open.
    expect(summaryDue(c, HELD_AT, at(2026, 10, 3, 7, 15)).due).toBe(false);
    // 09:00: both windows over → due, covering the first stretch.
    expect(summaryDue(c, HELD_AT, at(2026, 10, 3, 9, 0)).due).toBe(true);
  });

  it("a deleted source flushes now", () => {
    const r = summaryDue(null, HELD_AT, at(2026, 10, 3, 3, 0));
    expect(r.due).toBe(true);
    expect(r.coveredTo).toEqual(at(2026, 10, 3, 3, 0));
  });
});

describe("buildSummaryDetails", () => {
  const base = (over: Record<string, unknown> = {}) => ({
    id: "x", ruleId: "r1", assetId: "a1", assetHostname: "sw-1", severity: "serious", message: "down", dimension: "port12",
    triggeredAt: HELD_AT, cleared: false, rule: { name: "Port down" }, ...over,
  });

  it("lists only alerts still active, oldest first", () => {
    const d = buildSummaryDetails([
      base({ id: "late", triggeredAt: at(2026, 10, 3, 4, 0) }),
      base({ id: "early", triggeredAt: at(2026, 10, 3, 1, 0) }),
      base({ id: "gone", cleared: true, dimension: "port13" }),
    ], null);
    expect(d.outstanding.map((o) => o.notificationId)).toEqual(["early", "late"]);
    expect(d.recurring).toEqual([]);
  });

  it("reports an alert that recurred MORE THAN the threshold, with every time, recovered or not — and not twice", () => {
    const d = buildSummaryDetails([
      base({ id: "f1", triggeredAt: at(2026, 10, 3, 1, 0), cleared: true }),
      base({ id: "f2", triggeredAt: at(2026, 10, 3, 2, 0), cleared: true }),
      base({ id: "f3", triggeredAt: at(2026, 10, 3, 3, 0), cleared: false }),
      base({ id: "other", dimension: "port20", triggeredAt: at(2026, 10, 3, 3, 30) }),
    ], 2);
    expect(d.recurring).toHaveLength(1);
    expect(d.recurring[0]).toMatchObject({ count: 3, dimension: "port12", stillActive: true });
    expect(d.recurring[0]!.times).toEqual([at(2026, 10, 3, 1, 0), at(2026, 10, 3, 2, 0), at(2026, 10, 3, 3, 0)].map((x) => x.toISOString()));
    // f3 is active but belongs to the recurring row, so it is not listed twice.
    expect(d.outstanding.map((o) => o.notificationId)).toEqual(["other"]);
  });

  it("exactly the threshold is not 'more than'", () => {
    const d = buildSummaryDetails([base({ id: "f1", cleared: true }), base({ id: "f2", cleared: true })], 2);
    expect(d.recurring).toEqual([]);
    expect(d.outstanding).toEqual([]);
  });
});

describe("recipientsFromHeldRows", () => {
  it("splits a composed To line, adds Cc, reads push accounts, ignores chat rows, dedupes case-insensitively", () => {
    const r = recipientsFromHeldRows([
      { transport: "email", target: "A@example.com, b@example.com", meta: { cc: ["c@example.com", "a@example.com"] } },
      { transport: "web_push", target: "https://push/1", meta: { userId: "u1" } },
      { transport: "web_push", target: "https://push/2", meta: { userId: "u1" } },
      { transport: "webhook", target: "", meta: { kind: "slack" } },
    ]);
    expect(r.addresses).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
    expect(r.userIds).toEqual(["u1"]);
  });
});

describe("createDueSummaries", () => {
  it("creates one row per due source, stamps every held alert, and resolves recipients from the held rows", async () => {
    const live = heldAlert();
    heldAlert({ id: "gone", cleared: true, dimension: "port13" });
    db.deliveries.push(
      { notificationId: live.id, status: "held", transport: "email", target: "oncall@example.com", meta: { cc: [] }, channelId: "ch-email" },
      { notificationId: live.id, status: "held", transport: "web_push", target: "https://push/1", meta: { userId: "u1" }, channelId: "ch-push" },
    );
    db.users.push({ id: "u1", email: "Phone.Person@example.com", username: "phone", timezone: "auto", detectedTimezone: "America/Chicago" });

    expect(await createDueSummaries(at(2026, 10, 3, 6, 1))).toBe(1);
    const s = db.summaries[0];
    expect(s.sourceName).toBe("Nights");
    expect(s.listedCount).toBe(1);
    expect(s.notificationIds.sort()).toEqual([live.id, "gone"].sort());
    expect(s.recipients.map((r: any) => r.address).sort()).toEqual(["oncall@example.com", "phone.person@example.com"]);
    expect(s.recipients.find((r: any) => r.address === "phone.person@example.com").userId).toBe("u1");
    expect(s.channelId).toBe("ch-email");
    expect(s.status).toBe("pending");
    // Both held alerts are covered, listed or not.
    expect(db.notifs.every((n) => n.quietSummarizedAt)).toBe(true);
  });

  it("does nothing while the window is still open", async () => {
    heldAlert();
    expect(await createDueSummaries(at(2026, 10, 3, 4, 0))).toBe(0);
    expect(db.notifs[0].quietSummarizedAt).toBeNull();
  });

  it("everything recovered under the threshold is the ALL-QUIET email, to everyone the covered alerts would have reached", async () => {
    const gone = heldAlert({ cleared: true });
    db.deliveries.push({ notificationId: gone.id, status: "held", transport: "email", target: "oncall@example.com", meta: {}, channelId: "ch-email" });
    await createDueSummaries(at(2026, 10, 3, 6, 1));
    const s = db.summaries[0];
    expect(s.status).toBe("pending");
    expect(s.listedCount).toBe(0);
    expect(s.details.allQuiet).toBe(true);
    expect(s.details.heldCount).toBe(1);
    expect(s.recipients.map((r: any) => r.address)).toEqual(["oncall@example.com"]);
    expect(db.notifs[0].quietSummarizedAt).toBeTruthy();
  });

  it("with the all-quiet email turned off, everything recovered writes an EMPTY row and nobody is mailed", async () => {
    db.schedules[0].quiet = { windows: [NIGHTLY], summaryAlways: false };
    const gone = heldAlert({ cleared: true });
    db.deliveries.push({ notificationId: gone.id, status: "held", transport: "email", target: "oncall@example.com", meta: {}, channelId: "ch-email" });
    await createDueSummaries(at(2026, 10, 3, 6, 1));
    expect(db.summaries[0].status).toBe("empty");
    expect(db.summaries[0].recipients).toEqual([]);
    expect(db.notifs[0].quietSummarizedAt).toBeTruthy();
  });

  it("marks the row unroutable, and says so, when no email channel exists", async () => {
    db.channels.length = 0;
    const live = heldAlert();
    db.deliveries.push({ notificationId: live.id, status: "held", transport: "email", target: "oncall@example.com", meta: {}, channelId: "ch-gone" });
    await createDueSummaries(at(2026, 10, 3, 6, 1));
    expect(db.summaries[0].status).toBe("unroutable");
    expect(db.events.map((e) => e.action)).toContain("quiet_time.summary_unroutable");
  });

  it("prefers the policy's summary channel, then the held rows' channel, then any email channel", async () => {
    db.channels.push({ id: "ch-2", type: "oauth_m365", enabled: true, config: {}, createdAt: new Date() });
    db.schedules[0].quiet = { windows: [NIGHTLY], summaryChannelId: "ch-2" };
    const live = heldAlert();
    db.deliveries.push({ notificationId: live.id, status: "held", transport: "email", target: "oncall@example.com", meta: {}, channelId: "ch-email" });
    await createDueSummaries(at(2026, 10, 3, 6, 1));
    expect(db.summaries[0].channelId).toBe("ch-2");
  });

  it("flushes a deleted schedule's held alerts at once, naming it from the stamp", async () => {
    db.schedules.length = 0;
    const live = heldAlert();
    db.deliveries.push({ notificationId: live.id, status: "held", transport: "email", target: "oncall@example.com", meta: {}, channelId: "ch-email" });
    expect(await createDueSummaries(at(2026, 10, 3, 3, 0))).toBe(1);
    expect(db.summaries[0].sourceName).toBe("Nights");
  });

  it("an automation's own quiet time is a source too, read off the rule", async () => {
    db.rules.push({ id: "r1", name: "Port down", quietTime: { windows: [NIGHTLY], recurrenceThreshold: 1 } });
    heldAlert({ quietSource: { kind: "automation", id: "r1" }, cleared: true });
    heldAlert({ quietSource: { kind: "automation", id: "r1" }, cleared: true, triggeredAt: at(2026, 10, 3, 3, 0) });
    db.deliveries.push({ notificationId: "n1", status: "held", transport: "email", target: "oncall@example.com", meta: {}, channelId: "ch-email" });
    await createDueSummaries(at(2026, 10, 3, 6, 1));
    expect(db.summaries[0].sourceKind).toBe("automation");
    expect(db.summaries[0].recurringCount).toBe(1);
    expect(db.summaries[0].listedCount).toBe(0);
  });
});

describe("the all-quiet summary when NOTHING was held", () => {
  const NOTIFY_TO = { type: "notify", channelId: "ch-email", recipientUserIds: ["u1"], addresses: ["NOC@example.com"] };
  function seedRules() {
    db.users.push({ id: "u1", email: "phone@example.com", username: "phone", timezone: "auto", detectedTimezone: "America/Chicago" });
    // Covered: enabled, no quiet time of its own, a severity the policy holds.
    db.rules.push({ id: "r-a", name: "Port down", enabled: true, severity: "serious", trigger: { type: "asset_state", field: "ifOperStatus" }, scope: {}, quietTime: null, updatedAt: at(2026, 10, 1), actions: [NOTIFY_TO], escalation: null, severityBands: null, bandNotify: null, resetActions: null });
    // Not covered: exempt from the global schedules.
    db.rules.push({ id: "r-b", name: "Core down", enabled: true, severity: "serious", trigger: { type: "asset_state", field: "monitorStatus" }, scope: {}, quietTime: { ignoreGlobal: true }, updatedAt: at(2026, 10, 1), actions: [{ ...NOTIFY_TO, addresses: ["exempt@example.com"] }], escalation: null, severityBands: null, bandNotify: null, resetActions: null });
    // Not covered: a severity the policy lets through.
    db.rules.push({ id: "r-c", name: "Critical only", enabled: true, severity: "critical", trigger: { type: "asset_metric", metric: "cpuPct" }, scope: {}, quietTime: null, updatedAt: at(2026, 10, 1), actions: [{ ...NOTIFY_TO, addresses: ["critical@example.com"] }], escalation: null, severityBands: null, bandNotify: null, resetActions: null });
    // Not covered: disabled.
    db.rules.push({ id: "r-d", name: "Off", enabled: false, severity: "serious", trigger: {}, scope: {}, quietTime: null, updatedAt: at(2026, 10, 1), actions: [{ ...NOTIFY_TO, addresses: ["off@example.com"] }], escalation: null, severityBands: null, bandNotify: null, resetActions: null });
  }

  it("writes one all-quiet row per ended stretch, to the covered automations' static recipients, once", async () => {
    db.schedules[0].quiet = { windows: [NIGHTLY], severities: ["serious", "warning"] };
    seedRules();
    expect(await createDueSummaries(at(2026, 10, 3, 6, 1))).toBe(1);
    const s = db.summaries[0];
    expect(s.sourceKind).toBe("global");
    expect(s.sourceName).toBe("Nights");
    expect(s.coveredFrom).toEqual(at(2026, 10, 2, 22, 0));
    expect(s.coveredTo).toEqual(at(2026, 10, 3, 6, 0));
    expect(s.notificationIds).toEqual([]);
    expect(s.details).toMatchObject({ allQuiet: true, heldCount: 0, outstanding: [], recurring: [] });
    expect(JSON.stringify(s.recipients.map((r: any) => r.address).sort())).toBe(JSON.stringify(["noc@example.com", "phone@example.com"]));
    expect(s.recipients.find((r: any) => r.address === "phone@example.com").userId).toBe("u1");
    expect(s.status).toBe("pending");
    // The same stretch is never summarised twice.
    expect(await createDueSummaries(at(2026, 10, 3, 6, 5))).toBe(0);
    expect(db.summaries).toHaveLength(1);
  });

  it("waits for the stretch to end and for the send time", async () => {
    seedRules();
    expect(await createDueSummaries(at(2026, 10, 3, 4, 0))).toBe(0); // still quiet
    db.schedules[0].quiet = { windows: [NIGHTLY], summaryAt: "07:30" };
    expect(await createDueSummaries(at(2026, 10, 3, 6, 1))).toBe(0); // ended, send time not yet
    expect(await createDueSummaries(at(2026, 10, 3, 7, 31))).toBe(1);
  });

  it("is not sent when turned off, when the policy holds no first alert, or for a stretch that ended before the policy's last edit", async () => {
    seedRules();
    db.schedules[0].quiet = { windows: [NIGHTLY], summaryAlways: false };
    expect(await createDueSummaries(at(2026, 10, 3, 6, 1))).toBe(0);
    db.schedules[0].quiet = { windows: [NIGHTLY], holds: "followUps" };
    expect(await createDueSummaries(at(2026, 10, 3, 6, 1))).toBe(0);
    db.schedules[0].quiet = { windows: [NIGHTLY] };
    db.schedules[0].updatedAt = at(2026, 10, 3, 9, 0);
    expect(await createDueSummaries(at(2026, 10, 3, 9, 5))).toBe(0);
  });

  it("an automation's own quiet time gets its own all-quiet email, to its own recipients", async () => {
    db.schedules.length = 0;
    seedRules();
    db.rules[1].quietTime = { windows: [NIGHTLY] }; // r-b now has a policy of its own
    expect(await createDueSummaries(at(2026, 10, 3, 6, 1))).toBe(1);
    expect(db.summaries[0].sourceKind).toBe("automation");
    expect(db.summaries[0].sourceId).toBe("r-b");
    expect(db.summaries[0].recipients.map((r: any) => r.address).sort()).toEqual(["exempt@example.com", "phone@example.com"]);
  });

  it("reaches device-region recipients through every region the rule's devices carry, levels included", async () => {
    seedRules();
    db.users.push(
      { id: "u-atl", email: "atl@example.com", username: "atl", regions: ["Atlanta"] },
      { id: "u-central", email: "central@example.com", username: "central", regions: ["Central"] },
      { id: "u-west", email: "west@example.com", username: "west", regions: ["West"] },
    );
    db.rules[0].actions = [
      { type: "notify", channelId: "ch-email", recipientDeviceRegion: true },
      { type: "notify", channelId: "ch-email", recipientDeviceRegionLevels: [2] },
    ];
    scopeSnapshots.mockImplementation(async () => [["Atlanta"], ["Nashville"]]);
    expect(await createDueSummaries(at(2026, 10, 3, 6, 1))).toBe(1);
    const addrs = db.summaries[0].recipients.map((r: any) => r.address).sort();
    // Atlanta by its own region; Central as the division containing Nashville;
    // West carries no device in scope and is not reached. (critical@ and
    // phone@ come from the critical-only rule, covered here: every severity is held.)
    expect(addrs).toEqual(["atl@example.com", "central@example.com", "critical@example.com", "phone@example.com"]);
    // Read once for the rule, however many of its actions route by device region.
    expect(scopeSnapshots).toHaveBeenCalledTimes(1);
  });

  it("does not read the rule's devices when no action routes by device region", async () => {
    seedRules();
    await createDueSummaries(at(2026, 10, 3, 6, 1));
    expect(scopeSnapshots).not.toHaveBeenCalled();
  });

  it("drains as an all-quiet email that says nothing was held", async () => {
    seedRules();
    await createDueSummaries(at(2026, 10, 3, 6, 1));
    const r = await drainPendingSummaries(at(2026, 10, 3, 6, 1));
    // Every severity is held here, so the critical-only automation's recipient is reached too.
    expect(r).toEqual({ sent: 3, failed: 0 });
    const m = db.sent[0];
    expect(m.subject).toBe("[QUIET TIME SUMMARY] all quiet · Nights");
    expect(m.text).toContain("no alerts were held during the quiet period");
    expect(m.text).toContain("confirms that the quiet time and your email delivery are working");
    expect(m.html).toContain("All quiet");
  });
});

describe("drainPendingSummaries", () => {
  async function seedPending() {
    const live = heldAlert();
    db.deliveries.push(
      { notificationId: live.id, status: "held", transport: "email", target: "oncall@example.com", meta: {}, channelId: "ch-email" },
      { notificationId: live.id, status: "held", transport: "web_push", target: "https://push/1", meta: { userId: "u1" }, channelId: "ch-push" },
    );
    db.users.push({ id: "u1", email: "phone@example.com", username: "phone", timezone: "auto", detectedTimezone: "Pacific/Honolulu" });
    await createDueSummaries(at(2026, 10, 3, 6, 1));
  }

  it("emails every recipient once, in their own zone, with no graphs and a device link, then audits", async () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com";
    await seedPending();
    const r = await drainPendingSummaries(at(2026, 10, 3, 6, 1));
    delete process.env.POLARIS_PUBLIC_URL;
    expect(r).toEqual({ sent: 2, failed: 0 });
    expect(db.sent.map((m) => m.to[0]).sort()).toEqual(["oncall@example.com", "phone@example.com"]);
    const phone = db.sent.find((m) => m.to[0] === "phone@example.com");
    expect(phone.subject).toBe("[QUIET TIME SUMMARY] 1 outstanding · Nights");
    expect(phone.text).toContain("Pacific/Honolulu");
    expect(phone.html).toContain("https://polaris.example.com/assets/a1");
    expect(phone.html).not.toContain("cid:");
    expect(phone.html).not.toContain("Acknowledge");
    expect(phone.html).toContain("port12 is down");
    expect(db.summaries[0].status).toBe("sent");
    expect(db.summaries[0].sentAt).toBeTruthy();
    expect(db.events.map((e) => e.action)).toContain("quiet_time.summary_sent");
  });

  it("retries a failed recipient on the next tick and gives up after the cap", async () => {
    await seedPending();
    db.failNext.push("oncall@example.com");
    expect(await drainPendingSummaries(at(2026, 10, 3, 6, 1))).toEqual({ sent: 1, failed: 0 });
    expect(db.summaries[0].status).toBe("partial");
    const again = await drainPendingSummaries(at(2026, 10, 3, 6, 2));
    expect(again).toEqual({ sent: 1, failed: 0 });
    expect(db.summaries[0].status).toBe("sent");
    expect(db.sent).toHaveLength(2 + 0); // phone once, oncall once
  });

  it("gives up after SUMMARY_MAX_ATTEMPTS, and Resend sends again only to whoever missed it", async () => {
    await seedPending();
    for (let i = 0; i < SUMMARY_MAX_ATTEMPTS; i++) db.failNext.push("oncall@example.com");
    for (let i = 0; i < SUMMARY_MAX_ATTEMPTS; i++) await drainPendingSummaries(at(2026, 10, 3, 6, 1 + i));
    expect(db.summaries[0].status).toBe("partial-failed");
    expect(db.events.map((e) => e.action)).toContain("quiet_time.summary_failed");
    expect(db.sent).toHaveLength(1); // phone, once
    // The SMTP host is back: resend reaches oncall and leaves phone alone.
    await resendSummary("s1", "admin");
    expect(db.summaries[0].status).toBe("sent");
    expect(db.sent.map((m) => m.to[0])).toEqual(["phone@example.com", "oncall@example.com"]);
    expect(db.events.map((e) => e.action)).toContain("quiet_time.summary_resent");
    // Nothing left to resend → refused rather than re-mailing everyone.
    await expect(resendSummary("s1")).rejects.toThrow(/already been reached/);
  });

  it("the whole tick creates and sends in one call", async () => {
    const live = heldAlert();
    db.deliveries.push({ notificationId: live.id, status: "held", transport: "email", target: "oncall@example.com", meta: {}, channelId: "ch-email" });
    const r = await runQuietTimeSummaries(at(2026, 10, 3, 6, 1));
    expect(r).toEqual({ created: 1, sent: 1, failed: 0 });
  });
});
