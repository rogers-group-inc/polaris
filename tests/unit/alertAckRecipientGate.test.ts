/**
 * tests/unit/alertAckRecipientGate.test.ts — a recipient who cannot
 * acknowledge does not get the Acknowledge button.
 *
 * Business rule 25 gives every reader of an alert the SAME link and lets the
 * page decide who may act, which is what collapsed the send back into one
 * message. That still holds for anyone Polaris cannot identify — an
 * address-book contact, an operator-typed address — but not for an account
 * whose role we can read: mailing a read-only operator a button that can only
 * refuse them is noise, so the body goes out twice at most (with and without
 * the button), never once per person.
 *
 * The three surfaces that carry the link are pinned here: the composed email
 * (two variants), the plain per-address email (`noAck` in meta) and web push
 * (no tray action at all).
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
  ackCapabilityByAddress,
  splitAckVariants,
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

describe("splitAckVariants", () => {
  const cap = new Map<string, boolean>([["yes@x.com", true], ["no@x.com", false]]);

  it("returns ONE variant, unchanged, when nobody is known to lack the permission", () => {
    // The pre-feature shape: an install with no read-only recipient on the
    // message must still produce a single delivery row.
    const out = splitAckVariants(["yes@x.com", "stranger@x.com"], ["cc@x.com"], ["bcc@x.com"], cap);
    expect(out).toEqual([
      { ack: true, to: ["yes@x.com", "stranger@x.com"], cc: ["cc@x.com"], bcc: ["bcc@x.com"] },
    ]);
  });

  it("treats an address with no Polaris account as capable", () => {
    // Contacts and typed addresses keep the button — the page decides.
    const out = splitAckVariants(["stranger@x.com"], [], [], cap);
    expect(out).toEqual([{ ack: true, to: ["stranger@x.com"], cc: [], bcc: [] }]);
  });

  it("splits into two copies when a recipient cannot acknowledge", () => {
    const out = splitAckVariants(["yes@x.com", "no@x.com"], [], [], cap);
    expect(out).toEqual([
      { ack: true, to: ["yes@x.com"], cc: [], bcc: [] },
      { ack: false, to: ["no@x.com"], cc: [], bcc: [] },
    ]);
  });

  it("splits Cc and Bcc by the same test", () => {
    const out = splitAckVariants(
      ["yes@x.com", "no@x.com"],
      ["yes@x.com".replace("yes", "cc-yes"), "no@x.com"],
      ["no@x.com"],
      new Map([...cap, ["cc-yes@x.com", true]]),
    );
    expect(out[0]).toEqual({ ack: true, to: ["yes@x.com"], cc: ["cc-yes@x.com"], bcc: [] });
    expect(out[1]).toEqual({ ack: false, to: ["no@x.com"], cc: ["no@x.com"], bcc: ["no@x.com"] });
  });

  it("promotes Cc into To when a variant loses its whole To line", () => {
    // Otherwise the empty-To guard drops the message and the Cc'd reader
    // never hears about the alert.
    const out = splitAckVariants(["no@x.com"], ["yes@x.com"], [], cap);
    expect(out[0]).toEqual({ ack: true, to: ["yes@x.com"], cc: [], bcc: [] });
    expect(out[1]).toEqual({ ack: false, to: ["no@x.com"], cc: [], bcc: [] });
  });

  it("sends a Bcc-only variant one message per address so the blind list stays blind", () => {
    const out = splitAckVariants(["no@x.com"], [], ["yes@x.com", "other@x.com"], cap);
    expect(out.filter((v) => v.ack)).toEqual([
      { ack: true, to: ["yes@x.com"], cc: [], bcc: [] },
      { ack: true, to: ["other@x.com"], cc: [], bcc: [] },
    ]);
  });

  it("drops nobody: every input address lands in exactly one variant", () => {
    const out = splitAckVariants(["yes@x.com", "no@x.com"], ["cc@x.com"], ["bcc@x.com"], cap);
    const landed = out.flatMap((v) => [...v.to, ...v.cc, ...v.bcc]).sort();
    expect(landed).toEqual(["bcc@x.com", "cc@x.com", "no@x.com", "yes@x.com"]);
  });
});

describe("ackCapabilityByAddress", () => {
  it("reads the role matrix through the shared level ladder", async () => {
    const cap = await ackCapabilityByAddress();
    expect(cap.get("noc@example.com")).toBe(true);
    expect(cap.get("ro@example.com")).toBe(false);
  });

  it("omits an address nobody signs in with", async () => {
    const cap = await ackCapabilityByAddress();
    expect(cap.has("contact@example.com")).toBe(false);
  });
});

describe("expandDeliveries — composed email", () => {
  it("mails the read-only recipient the same alert with no acknowledge link", async () => {
    await expandDeliveries(
      "n-1",
      [{ channelId: "c-mail", recipientRegions: ["Atlanta"] }] as never,
      { composedEmail: composed() },
    );
    const rows = emailRows();
    expect(rows).toHaveLength(2);

    const withAck = rows.find((r) => (metaOf(r).to as string[]).includes("noc@example.com"))!;
    const without = rows.find((r) => (metaOf(r).to as string[]).includes("ro@example.com"))!;
    expect(metaOf(withAck).text).toContain(ACK_URL);
    expect(metaOf(withAck).html).toContain(ACK_URL);
    // Not merely a dead link — the whole line/button is pruned away.
    expect(metaOf(without).text).not.toContain("Acknowledge");
    expect(metaOf(without).html).not.toContain("Acknowledge");
    // Same alert, same subject: only the button differs.
    expect(metaOf(without).subject).toBe(metaOf(withAck).subject);
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
  it("stamps noAck on the read-only address only", async () => {
    await expandDeliveries("n-1", [
      { channelId: "c-mail", recipientRegions: ["Atlanta"], addresses: ["contact@example.com"] },
    ] as never);
    const byTarget = new Map(emailRows().map((r) => [r.target as string, metaOf(r).noAck]));
    expect(byTarget.get("ro@example.com")).toBe(true);
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
    // Capability stops splitting the send: with no button on either copy there
    // is nothing for the two variants to differ about, so the read-only
    // recipient rides the same message as everyone else.
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

  it("leaves a FIRING send exactly as it was", async () => {
    // The option defaults off: same two variants, same links.
    await expandDeliveries(
      "n-1",
      [{ channelId: "c-mail", recipientRegions: ["Atlanta"] }] as never,
      { composedEmail: composed() },
    );
    const rows = emailRows();
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => String(metaOf(r).text).includes(ACK_URL))).toBe(true);
  });
});
