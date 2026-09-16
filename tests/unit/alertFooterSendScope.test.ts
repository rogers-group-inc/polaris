/**
 * tests/unit/alertFooterSendScope.test.ts
 *
 * The alert email footer names the audience of THIS SEND, not of the alert.
 *
 * The incident: an operator read a reminder whose `{email.recipients}` footer
 * said "Email sent to <the escalation manager>" and concluded their reminders
 * were escalating over their head. They were not — the manager sat on the T+30
 * tier and on no reminder at all — but the footer read every delivery row the
 * alert had ever produced, so once tier 1 fired, every later reminder named
 * them. A footnote at the bottom of one email cannot describe an audience that
 * email does not have.
 *
 * Three things are pinned here, and the middle one is the load-bearing one:
 *
 *  - `expandDeliveries` stamps `meta.dispatch` on every row of a fan-out;
 *  - ONE `executeActions` call is ONE dispatch — so a fire's two notify actions
 *    still see each other (the cross-transport line the footer exists for)
 *    while the sweep's per-action reminders do not;
 *  - `buildRecipientBlocks` narrows on that stamp, and falls back to the whole
 *    alert for a row queued before the stamp existed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = {
  channels: [] as any[],
  deliveries: [] as any[],
  /** Every `where` the footer's delivery read was called with. */
  deliveryQueries: [] as any[],
};

/** The `meta: { path, equals }` filter Prisma applies server-side. */
function matchesMetaFilter(row: any, where: any): boolean {
  if (!where?.meta) return true;
  const { path, equals } = where.meta as { path: string[]; equals: unknown };
  let cur: any = row.meta;
  for (const seg of path) cur = cur == null ? undefined : cur[seg];
  return cur === equals;
}

vi.mock("../../src/db.js", () => ({
  prisma: {
    notificationChannel: {
      findMany: vi.fn(async ({ where }: any) => db.channels.filter((c) => where.id.in.includes(c.id))),
    },
    notificationDelivery: {
      createMany: vi.fn(async ({ data }: any) => {
        db.deliveries.push(...data);
        return { count: data.length };
      }),
      create: vi.fn(async ({ data }: any) => {
        db.deliveries.push(data);
        return { id: "d", ...data };
      }),
      findMany: vi.fn(async ({ where }: any) => {
        db.deliveryQueries.push(where);
        return db.deliveries.filter(
          (r) =>
            r.notificationId === where.notificationId &&
            where.transport.in.includes(r.transport) &&
            matchesMetaFilter(r, where),
        );
      }),
    },
    user: { findMany: vi.fn(async () => []) },
    pushSubscription: { findMany: vi.fn(async () => []), groupBy: vi.fn(async () => []) },
    setting: { findUnique: vi.fn(async () => null) },
  },
}));

vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => {}) }));

import { expandDeliveries } from "../../src/services/notificationRecipientService.js";
import { executeActions } from "../../src/services/automationActionService.js";
import { buildRecipientBlocks } from "../../src/services/alertPushRecipientsService.js";

const CTX = {
  asset: "sw-core-1",
  severity: "critical",
  message: "sw-core-1 is down",
  "trigger.summary": "Monitor status is down",
};

const notify = (addresses: string[]) => ({ type: "notify" as const, channelId: "ch-email", addresses });

/** The addresses a row's `target` names, lower-cased. */
const addressesOf = (rows: any[]) =>
  rows.flatMap((r) => String(r.target).split(",").map((a) => a.trim().toLowerCase())).filter(Boolean);

beforeEach(() => {
  db.channels.length = 0;
  db.deliveries.length = 0;
  db.deliveryQueries.length = 0;
  db.channels.push({ id: "ch-email", type: "smtp", enabled: true });
});

describe("the dispatch stamp", () => {
  it("rides every row expandDeliveries creates for one fan-out", async () => {
    await expandDeliveries("n1", [{ channelId: "ch-email", addresses: ["a@example.com", "b@example.com"] }], {
      dispatchId: "disp-1",
    });
    expect(db.deliveries).toHaveLength(2);
    for (const row of db.deliveries) expect((row.meta as any).dispatch).toBe("disp-1");
  });

  it("is absent — and the row otherwise unchanged — when the caller stamps none", async () => {
    await expandDeliveries("n1", [{ channelId: "ch-email", addresses: ["a@example.com"] }], {});
    expect(db.deliveries).toHaveLength(1);
    expect(db.deliveries[0].meta).toBeUndefined();
  });
});

describe("one executeActions call is one send", () => {
  it("gives a fire's two notify actions the SAME dispatch, so each names the other", async () => {
    await executeActions("n1", [notify(["noc@example.com"]), notify(["oncall@example.com"])], CTX, {
      ruleId: "r1",
      ruleName: "Asset down",
    });
    expect(db.deliveries).toHaveLength(2);
    const stamps = new Set(db.deliveries.map((r) => (r.meta as any).dispatch));
    expect(stamps.size).toBe(1);
    expect(Array.from(stamps)[0]).toBeTruthy();
  });

  it("gives a separate call its OWN dispatch — the fire and the reminder that follows it", async () => {
    await executeActions("n1", [notify(["noc@example.com"])], CTX, { ruleId: "r1", ruleName: "Asset down" });
    await executeActions("n1", [notify(["noc@example.com"])], CTX, {
      ruleId: "r1",
      ruleName: "Asset down",
      repeat: { attempt: 1 },
    });
    expect(db.deliveries).toHaveLength(2);
    const [fire, reminder] = db.deliveries;
    expect((fire.meta as any).dispatch).not.toBe((reminder.meta as any).dispatch);
  });
});

describe("buildRecipientBlocks scope", () => {
  /** A fire, a reminder of it, and an escalation tier — three sends, one alert. */
  async function seedThreeSends() {
    await executeActions("n1", [notify(["noc@example.com"])], CTX, { ruleId: "r1", ruleName: "Asset down" });
    await executeActions("n1", [notify(["noc@example.com"])], CTX, {
      ruleId: "r1", ruleName: "Asset down", repeat: { attempt: 1 },
    });
    await executeActions("n1", [notify(["manager@example.com"])], CTX, {
      ruleId: "r1", ruleName: "Asset down", escalation: { tier: 1, attempt: 1 },
    });
    const [fire, reminder, tier] = db.deliveries.map((r) => (r.meta as any).dispatch as string);
    return { fire, reminder, tier };
  }

  it("does NOT name the escalation tier's recipient on the reminder — the reported bug", async () => {
    const { reminder } = await seedThreeSends();
    const { email } = await buildRecipientBlocks("n1", reminder);
    expect(email.text).toContain("noc@example.com");
    expect(email.text).not.toContain("manager@example.com");
  });

  it("names the tier's recipient on the tier's own email, and nobody else's", async () => {
    const { tier } = await seedThreeSends();
    const { email } = await buildRecipientBlocks("n1", tier);
    expect(email.text).toContain("manager@example.com");
    expect(email.text).not.toContain("noc@example.com");
  });

  it("narrows in the database rather than after the read", async () => {
    const { fire } = await seedThreeSends();
    db.deliveryQueries.length = 0;
    await buildRecipientBlocks("n1", fire);
    expect(db.deliveryQueries).toHaveLength(1);
    expect(db.deliveryQueries[0].meta).toEqual({ path: ["dispatch"], equals: fire });
  });

  it("falls back to the whole alert for a row queued before the stamp existed", async () => {
    await seedThreeSends();
    const { email } = await buildRecipientBlocks("n1", null);
    // Every address of every send — the pre-2026-09-16 behaviour, kept so an
    // in-flight row drains with a footer instead of without one.
    expect(email.text).toContain("noc@example.com");
    expect(email.text).toContain("manager@example.com");
    expect(db.deliveryQueries.at(-1)?.meta).toBeUndefined();
    // And the seeding itself is what makes the assertion meaningful.
    expect(new Set(addressesOf(db.deliveries)).size).toBe(2);
  });
});
