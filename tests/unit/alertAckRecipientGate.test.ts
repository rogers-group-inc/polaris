/**
 * tests/unit/alertAckRecipientGate.test.ts — who carries the Acknowledge
 * button, and what may split an alert email (business rule 25: nothing).
 *
 * The rule gives every reader of an alert the SAME link and lets the PAGE
 * decide who may act. For a while the email hedged that: an account whose role
 * we could read was mailed a second copy with the button pruned out. That
 * second copy is gone — it fractured the To line, so the operator who named
 * two people on an automation saw only one address and read it as Polaris
 * mailing each of them separately. A read-only recipient now reads the same
 * message as everyone else and is refused at the page, with a reason.
 *
 * WEB PUSH still withholds the tray action, and the asymmetry is deliberate: a
 * push is addressed to one browser, so leaving the action off costs nobody a
 * shared To line, and the tray has room for only two actions.
 *
 * Pinned here: the composed email (ONE row, whoever is on it), the plain
 * per-address email, and web push.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com";

const ACK_URL = "https://polaris.example.com/alert-ack.html?id=n-1";

// alerts=write => may acknowledge; alerts=read => may not.
const ROLE_WRITE = { regionTags: [], otherTags: [], permissions: { alerts: "write", assets: "write" } };
const ROLE_READONLY = { regionTags: [], otherTags: [], permissions: { alerts: "read", assets: "read" } };

const userRows = [
  {
    id: "u-noc", email: "noc@example.com", displayName: "NOC", regionTags: ["Atlanta"], otherTags: [],
    ssoGroups: [], authProvider: "local", roleId: "r-noc", role: ROLE_WRITE,
  },
  {
    id: "u-ro", email: "ro@example.com", displayName: "Viewer", regionTags: ["Atlanta"], otherTags: [],
    ssoGroups: [], authProvider: "local", roleId: "r-ro", role: ROLE_READONLY,
  },
];

const createdRows: Record<string, unknown>[] = [];

vi.mock("../../src/db.js", () => ({
  prisma: {
    user: { findMany: vi.fn(async () => userRows) },
    notificationChannel: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({
          id,
          type: id === "c-push" ? "web_push" : "smtp",
          enabled: true,
        }))),
    },
    notificationDelivery: {
      createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
        createdRows.push(...data);
        return { count: data.length };
      }),
    },
    pushSubscription: {
      findMany: vi.fn(async ({ where }: { where: { userId: { in: string[] } } }) =>
        where.userId.in.map((uid) => ({
          id: "s-" + uid, userId: uid, endpoint: "https://push/" + uid,
          p256dh: "k", auth: "a", surface: "desktop",
        }))),
    },
  },
}));

vi.mock("../../src/services/regionScopeService.js", () => ({
  resolveTagScopesForUser: vi.fn(async (u: { regionTags: string[]; otherTags: string[] }) => ({
    regionTags: { effective: u.regionTags },
    otherTags: { effective: u.otherTags },
  })),
}));

import {
  expandDeliveries,
  bumpRecipientIndex,
  type ComposedEmail,
} from "../../src/services/notificationRecipientService.js";

beforeEach(() => {
  createdRows.length = 0;
  bumpRecipientIndex();
});

// The button as the shipped template builds it — a cell-wrapped anchor, which
// is the shape pruneDeadLinks takes away whole when the token blanks.
const composed = (): ComposedEmail => ({
  subject: "[WARNING] switch-1",
  text: "switch-1 is down\n\nAcknowledge:      {ack}\n",
  html: '<tr><td style="background:#ff1744"><a href="{ack}">Acknowledge alert</a></td>'
    + '<td><a href="https://polaris.example.com/assets.html">Open device</a></td></tr>',
});

const emailRows = () => createdRows.filter((r) => r.transport === "email");
const metaOf = (r: Record<string, unknown>) => (r.meta ?? {}) as Record<string, unknown>;

describe("expandDeliveries — composed email", () => {
  it("puts a read-only recipient on the SAME message, button and all", async () => {
    // The regression this file now guards: two recipients, one delivery row,
    // both names on the To line. A role that cannot acknowledge is refused at
    // the page, not by being mailed a copy of its own.
    await expandDeliveries(
      "n-1",
      [{ channelId: "c-mail", recipientRegions: ["Atlanta"] }] as never,
      { composedEmail: composed() },
    );
    const rows = emailRows();
    expect(rows).toHaveLength(1);
    const meta = metaOf(rows[0]!);
    expect([...(meta.to as string[])].sort()).toEqual(["noc@example.com", "ro@example.com"]);
    // `target` is the To line verbatim — business rule 60 reads it back.
    expect(String(rows[0]!.target).split(", ").sort()).toEqual(["noc@example.com", "ro@example.com"]);
    expect(meta.text).toContain(ACK_URL);
    expect(meta.html).toContain(ACK_URL);
  });

  it("keeps ONE row when every recipient may acknowledge", async () => {
    await expandDeliveries(
      "n-1",
      [{ channelId: "c-mail", addresses: ["contact@example.com"], recipientUserIds: ["u-noc"] }] as never,
      { composedEmail: composed() },
    );
    const rows = emailRows();
    expect(rows).toHaveLength(1);
    expect(metaOf(rows[0]).to).toEqual(["contact@example.com", "noc@example.com"]);
    expect(metaOf(rows[0]).text).toContain(ACK_URL);
  });
});

describe("expandDeliveries — plain email + web push", () => {
  it("stamps noAck on nobody while the alert is live", async () => {
    // The plain path is one row per address by construction (the legacy shape),
    // but the READER no longer decides anything on it either: only an
    // all-clear stamps noAck, and that is a fact about the alert.
    await expandDeliveries("n-1", [
      { channelId: "c-mail", recipientRegions: ["Atlanta"], addresses: ["contact@example.com"] },
    ] as never);
    const byTarget = new Map(emailRows().map((r) => [r.target as string, metaOf(r).noAck]));
    expect(byTarget.get("ro@example.com")).toBeUndefined();
    expect(byTarget.get("noc@example.com")).toBeUndefined();
    expect(byTarget.get("contact@example.com")).toBeUndefined();
  });

  it("withholds the push tray action from a role that cannot acknowledge", async () => {
    await expandDeliveries("n-1", [{ channelId: "c-push", recipientRegions: ["Atlanta"] }] as never);
    const rows = createdRows.filter((r) => r.transport === "web_push");
    const byEndpoint = new Map(rows.map((r) => [r.target as string, metaOf(r).noAck]));
    expect(byEndpoint.get("https://push/u-ro")).toBe(true);
    expect(byEndpoint.get("https://push/u-noc")).toBeUndefined();
  });
});

/**
 * The other half of the same question. The block above asks whether the READER
 * may acknowledge; this one asks whether the ALERT still can be.
 *
 * An all-clear — the reset actions, a severity band's resolved actions, the
 * operator-clear path — announces that the alert is over, and the engine
 * clears the notification in the same breath. The button on it could only ever
 * land on `/alert-ack.html` saying "It resolved on its own or someone cleared
 * it, so there is nothing to acknowledge", and on a rule with `requireAckNote`
 * it would demand a note about it first. So the send carries none, for anyone,
 * on every surface (business rule 25).
 */
describe("expandDeliveries — an all-clear carries no acknowledge button", () => {
  it("blanks the button for EVERY composed recipient, and stays one row", async () => {
    await expandDeliveries(
      "n-1",
      [{ channelId: "c-mail", recipientRegions: ["Atlanta"], addresses: ["contact@example.com"] }] as never,
      { composedEmail: composed(), noAck: true },
    );
    const rows = emailRows();
    expect(rows).toHaveLength(1);
    const meta = metaOf(rows[0]!);
    expect([...(meta.to as string[])].sort()).toEqual(
      ["contact@example.com", "noc@example.com", "ro@example.com"],
    );
    expect(meta.text).not.toContain("Acknowledge");
    expect(meta.text).not.toContain(ACK_URL);
    // Pruned whole rather than left as a live-looking dead link.
    expect(meta.html).not.toContain("Acknowledge");
    expect(meta.html).not.toContain('href=""');
    // Everything else about the alert survives — this takes away a button, not
    // the email.
    expect(meta.subject).toBe("[WARNING] switch-1");
    expect(meta.html).toContain("Open device");
  });

  it("stamps noAck on every plain-email address, account or not", async () => {
    await expandDeliveries(
      "n-1",
      [{ channelId: "c-mail", recipientRegions: ["Atlanta"], addresses: ["contact@example.com"] }] as never,
      { noAck: true },
    );
    const byTarget = new Map(emailRows().map((r) => [r.target as string, metaOf(r).noAck]));
    expect(byTarget.get("noc@example.com")).toBe(true);
    expect(byTarget.get("ro@example.com")).toBe(true);
    // Including the address with no Polaris account behind it — "unknown means
    // capable" answers a question this send is not asking.
    expect(byTarget.get("contact@example.com")).toBe(true);
  });

  it("withholds the push tray action from every subscription", async () => {
    await expandDeliveries(
      "n-1",
      [{ channelId: "c-push", recipientRegions: ["Atlanta"] }] as never,
      { noAck: true },
    );
    const rows = createdRows.filter((r) => r.transport === "web_push");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => metaOf(r).noAck === true)).toBe(true);
  });

  it("leaves a FIRING send with its button", async () => {
    // The option defaults off: one row either way, and this one keeps the link.
    await expandDeliveries(
      "n-1",
      [{ channelId: "c-mail", recipientRegions: ["Atlanta"] }] as never,
      { composedEmail: composed() },
    );
    const rows = emailRows();
    expect(rows).toHaveLength(1);
    expect(String(metaOf(rows[0]!).text)).toContain(ACK_URL);
  });
});
