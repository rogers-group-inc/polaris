/**
 * tests/unit/alertPushRecipientsService.test.ts — the own suite for
 * src/services/alertPushRecipientsService.ts (CQ-T010).
 *
 * Complements:
 *   - alertPushRecipients.test.ts / alertEmailRecipients.test.ts — the render
 *     wording, the deferred tokens in the default bodies, the footer survival;
 *   - alertFooterSendScope.test.ts — the meta.dispatch stamp end to end.
 *
 * Adds the DB half of `buildRecipientBlocks` against the shared stub: the
 * delivery read's where (transports, the rule-120 status exclusions, the
 * dispatch narrowing and its alert-wide fallback), the push half (meta.userId,
 * the pre-upgrade fallback.userId, the endpoint → subscription lookup, dedupe
 * by USER, alphabetical), the email half (To + Cc, never Bcc — rule 60; dedupe
 * by address case-blind, first spelling kept, two-spelling account lookup),
 * and the never-throws pair failure. Plus the token helpers' edges.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { logger } from "../../src/utils/logger.js";
import {
  MAX_NAMED_RECIPIENTS,
  pushRecipientTokensIn,
  emailRecipientTokensIn,
  substitutePushRecipientTokens,
  substituteEmailRecipientTokens,
  recipientName,
  renderPushRecipients,
  renderEmailRecipients,
  toAddressesOf,
  ccAddressesOf,
  buildRecipientBlocks,
} from "../../src/services/alertPushRecipientsService.js";

const deliveries = stubbed(prisma.notificationDelivery.findMany);
const subs = stubbed(prisma.pushSubscription.findMany);
const users = stubbed(prisma.user.findMany);

type U = { id: string; email: string | null; displayName: string | null; username: string };
let userTable: U[] = [];

beforeEach(() => {
  resetDbStub();
  userTable = [];
  deliveries.mockResolvedValue([]);
  subs.mockResolvedValue([]);
  // One user read per half: the push half asks by id, the email half by email.
  users.mockImplementation(async ({ where }: any) => {
    if (where?.id?.in) return userTable.filter((u) => where.id.in.includes(u.id));
    if (where?.email?.in) return userTable.filter((u) => u.email && where.email.in.includes(u.email));
    return [];
  });
});

const push = (meta: unknown, target = "https://push.example/ep") => ({ transport: "web_push", target, meta });
const mail = (target: string, meta: unknown = {}) => ({ transport: "email", target, meta });

describe("token detection", () => {
  it("finds the push token in any of the templates, skipping null and empty", () => {
    expect([...pushRecipientTokensIn(null, undefined, "", "x {push.recipients} y")]).toEqual(["push.recipients"]);
  });

  it("finds nothing in templates that do not name it", () => {
    expect(pushRecipientTokensIn("{email.recipients}", "{push.recipient}").size).toBe(0);
    expect(pushRecipientTokensIn().size).toBe(0);
  });

  it("finds the email token independently of the push one", () => {
    expect([...emailRecipientTokensIn("{email.recipients}")]).toEqual(["email.recipients"]);
    expect(emailRecipientTokensIn("{push.recipients}").size).toBe(0);
  });
});

describe("token substitution", () => {
  it("returns an empty body as-is", () => {
    expect(substitutePushRecipientTokens("", "x")).toBe("");
    expect(substituteEmailRecipientTokens("", "x")).toBe("");
  });

  it("replaces every occurrence, and an empty block removes the token", () => {
    expect(substitutePushRecipientTokens("a{push.recipients}b{push.recipients}", "X")).toBe("aXbX");
    expect(substitutePushRecipientTokens("a{push.recipients}b", "")).toBe("ab");
    expect(substituteEmailRecipientTokens("a{email.recipients}b{email.recipients}", "Y")).toBe("aYbY");
  });

  it("leaves the other transport's token alone", () => {
    expect(substitutePushRecipientTokens("{email.recipients}", "X")).toBe("{email.recipients}");
    expect(substituteEmailRecipientTokens("{push.recipients}", "X")).toBe("{push.recipients}");
  });

  // Was a bug until 2026-11-13: the block went to String.replace as a
  // REPLACEMENT STRING, so `$&`, `$'` and `` $` `` in it were expanded as
  // patterns. The block carries account display names (operator- or
  // IdP-supplied) — a user named "Cash $& Co" made the footer read "Web push
  // sent to Cash {push.recipients} Co".
  it("inserts a name carrying `$&` literally into the push footer", () => {
    const block = renderPushRecipients(["Cash $& Co"], { html: false });
    expect(substitutePushRecipientTokens("[{push.recipients}]", block)).toBe("[Web push sent to Cash $& Co]");
  });

  // Was a bug until 2026-11-13: same expansion on the email half — a display
  // name containing `$'` pulled the rest of the body into the footer.
  it("inserts a name carrying `$'` literally into the email footer", () => {
    const block = renderEmailRecipients(["A $' B"], { html: false });
    expect(substituteEmailRecipientTokens("[{email.recipients}]tail", block)).toBe("[Email sent to A $' B]tail");
  });
});

describe("recipientName", () => {
  it("trims the display name", () => {
    expect(recipientName({ displayName: "  Ada  ", username: "ada" })).toBe("Ada");
  });

  it("falls back to the username for a null or whitespace-only display name", () => {
    expect(recipientName({ displayName: null, username: "ada" })).toBe("ada");
    expect(recipientName({ displayName: "   ", username: "ada" })).toBe("ada");
  });
});

describe("render overflow edges", () => {
  const names = (n: number) => Array.from({ length: n }, (_, i) => `u${String(i).padStart(2, "0")}`);

  it("names exactly MAX_NAMED_RECIPIENTS with no overflow clause", () => {
    expect(MAX_NAMED_RECIPIENTS).toBe(12);
    const out = renderPushRecipients(names(12), { html: false });
    expect(out).not.toContain("more");
    expect(out.split(", ")).toHaveLength(12);
  });

  it("counts one past the cap", () => {
    expect(renderEmailRecipients(names(13), { html: false })).toMatch(/u11, and 1 more$/);
  });

  it("escapes the html form only", () => {
    expect(renderEmailRecipients(["<b>"], { html: false })).toBe("Email sent to <b>");
    expect(renderEmailRecipients(["<b>"], { html: true })).toBe('<div style="margin-bottom:2px">Email sent to &lt;b&gt;</div>');
  });
});

describe("toAddressesOf / ccAddressesOf", () => {
  it("reads null and undefined targets as no addresses", () => {
    expect(toAddressesOf(null)).toEqual([]);
    expect(toAddressesOf(undefined)).toEqual([]);
  });

  it("trims and drops non-address fragments", () => {
    expect(toAddressesOf(" a@x.co ,, bob ,c@y.co")).toEqual(["a@x.co", "c@y.co"]);
  });

  it("reads no Cc from a non-object meta or a non-array cc", () => {
    expect(ccAddressesOf(null)).toEqual([]);
    expect(ccAddressesOf("cc")).toEqual([]);
    expect(ccAddressesOf({ cc: "a@x.co" })).toEqual([]);
  });

  it("keeps only string addresses, trimmed", () => {
    expect(ccAddressesOf({ cc: [" a@x.co ", 7, null, "nope", "b@y.co"] })).toEqual(["a@x.co", "b@y.co"]);
  });

  it("never reads bcc", () => {
    expect(ccAddressesOf({ bcc: ["hidden@x.co"] })).toEqual([]);
  });
});

describe("buildRecipientBlocks — the delivery read", () => {
  it("reads only reaching web_push + email rows, alert-wide without a dispatch id", async () => {
    await buildRecipientBlocks("n1");
    const where = deliveries.mock.calls[0]![0].where;
    expect(where).toEqual({
      notificationId: "n1",
      transport: { in: ["web_push", "email"] },
      status: { notIn: ["held", "deferred", "superseded"] },
    });
  });

  it("narrows to the send's dispatch stamp in the database when given one (rule 60)", async () => {
    await buildRecipientBlocks("n1", "d-7");
    expect(deliveries.mock.calls[0]![0].where.meta).toEqual({ path: ["dispatch"], equals: "d-7" });
  });

  it("treats a null dispatch id like an absent one", async () => {
    await buildRecipientBlocks("n1", null);
    expect(deliveries.mock.calls[0]![0].where).not.toHaveProperty("meta");
  });

  it("returns two empty blocks and asks nothing else when no row reached anyone", async () => {
    const out = await buildRecipientBlocks("n1");
    expect(out).toEqual({ push: { html: "", text: "" }, email: { html: "", text: "" } });
    expect(users).not.toHaveBeenCalled();
    expect(subs).not.toHaveBeenCalled();
  });
});

describe("buildRecipientBlocks — the push half", () => {
  it("names the stamped user, alphabetically, deduped across their devices", async () => {
    userTable = [
      { id: "u2", email: null, displayName: "Zed", username: "z" },
      { id: "u1", email: null, displayName: null, username: "amy" },
    ];
    deliveries.mockResolvedValue([push({ userId: "u2" }), push({ userId: "u1" }), push({ userId: "u2" })]);
    const out = await buildRecipientBlocks("n1");
    expect(out.push.text).toBe("Web push sent to amy, Zed");
    expect(out.push.html).toContain("Web push sent to amy, Zed");
    const asked = users.mock.calls.find((c) => c[0].where.id)![0].where.id.in;
    expect([...asked].sort()).toEqual(["u1", "u2"]);
    expect(subs).not.toHaveBeenCalled();
  });

  it("reads a pre-upgrade row's owner from the email-fallback stamp", async () => {
    userTable = [{ id: "u9", email: null, displayName: "Old Row", username: "o" }];
    deliveries.mockResolvedValue([push({ fallback: { userId: "u9" } })]);
    expect((await buildRecipientBlocks("n1")).push.text).toBe("Web push sent to Old Row");
  });

  it("resolves an unstamped row through its endpoint's subscription", async () => {
    userTable = [{ id: "u3", email: null, displayName: "Sub User", username: "s" }];
    subs.mockResolvedValue([{ userId: "u3" }]);
    deliveries.mockResolvedValue([push({}, "https://push.example/abc"), push({ userId: "" }, "https://push.example/def")]);
    const out = await buildRecipientBlocks("n1");
    expect(subs.mock.calls[0]![0].where).toEqual({ endpoint: { in: ["https://push.example/abc", "https://push.example/def"] } });
    expect(out.push.text).toBe("Web push sent to Sub User");
  });

  it("drops a row whose subscription was pruned rather than guessing whose it was", async () => {
    subs.mockResolvedValue([]);
    deliveries.mockResolvedValue([push(null, "https://push.example/gone")]);
    const out = await buildRecipientBlocks("n1");
    expect(out.push).toEqual({ html: "", text: "" });
    expect(users).not.toHaveBeenCalled();
  });

  it("skips the subscription lookup for an unstamped row with no target", async () => {
    deliveries.mockResolvedValue([push({}, "")]);
    await buildRecipientBlocks("n1");
    expect(subs).not.toHaveBeenCalled();
  });

  it("renders nothing when the stamped account no longer exists", async () => {
    deliveries.mockResolvedValue([push({ userId: "deleted" })]);
    expect((await buildRecipientBlocks("n1")).push).toEqual({ html: "", text: "" });
  });

  it("leaves the email half empty on a push-only send", async () => {
    userTable = [{ id: "u1", email: "a@x.co", displayName: "A", username: "a" }];
    deliveries.mockResolvedValue([push({ userId: "u1" })]);
    const out = await buildRecipientBlocks("n1");
    expect(out.push.text).toBe("Web push sent to A");
    expect(out.email).toEqual({ html: "", text: "" });
  });
});

describe("buildRecipientBlocks — the email half", () => {
  it("names To and Cc, an account by name and a bare address as itself, alphabetically", async () => {
    userTable = [{ id: "u1", email: "ops@x.co", displayName: "Ops Desk", username: "ops" }];
    deliveries.mockResolvedValue([mail("zed@y.co, ops@x.co", { cc: ["boss@x.co"], bcc: ["secret@x.co"] })]);
    const out = await buildRecipientBlocks("n1");
    expect(out.email.text).toBe("Email sent to boss@x.co, Ops Desk, zed@y.co");
    expect(out.email.text).not.toContain("secret");
    expect(out.push).toEqual({ html: "", text: "" });
  });

  it("dedupes addresses case-blind, keeping the first spelling", async () => {
    deliveries.mockResolvedValue([mail("Ann@X.co"), mail("ann@x.co"), mail("x@y.co", { cc: ["ANN@x.CO"] })]);
    const out = await buildRecipientBlocks("n1");
    expect(out.email.text).toBe("Email sent to Ann@X.co, x@y.co");
  });

  it("asks for each address as written AND lower-cased, then matches the account case-blind", async () => {
    userTable = [{ id: "u1", email: "ann@x.co", displayName: "Ann", username: "ann" }];
    deliveries.mockResolvedValue([mail("Ann@X.co")]);
    const out = await buildRecipientBlocks("n1");
    const asked = users.mock.calls.find((c) => c[0].where.email)![0].where.email.in;
    expect([...asked].sort()).toEqual(["Ann@X.co", "ann@x.co"]);
    expect(out.email.text).toBe("Email sent to Ann");
  });

  it("matches an account stored with different capitalisation than both spellings asked", async () => {
    // The lookup asks "Ann@X.co" and "ann@x.co"; an account stored as "ANN@X.CO"
    // is not returned by the IN at all, so it prints as the address.
    userTable = [{ id: "u1", email: "ANN@X.CO", displayName: "Ann", username: "ann" }];
    deliveries.mockResolvedValue([mail("Ann@X.co")]);
    expect((await buildRecipientBlocks("n1")).email.text).toBe("Email sent to Ann@X.co");
  });

  it("renders nothing and asks for no accounts when the email rows carry no addresses", async () => {
    deliveries.mockResolvedValue([mail("not an address", { cc: ["nope"] })]);
    const out = await buildRecipientBlocks("n1");
    expect(out.email).toEqual({ html: "", text: "" });
    expect(users).not.toHaveBeenCalled();
  });

  it("names both transports from the one delivery read", async () => {
    userTable = [{ id: "u1", email: "a@x.co", displayName: "A", username: "a" }];
    deliveries.mockResolvedValue([push({ userId: "u1" }), mail("a@x.co")]);
    const out = await buildRecipientBlocks("n1");
    expect(deliveries).toHaveBeenCalledTimes(1);
    expect(out.push.text).toBe("Web push sent to A");
    expect(out.email.text).toBe("Email sent to A");
  });
});

describe("buildRecipientBlocks — never throws, fails as a pair", () => {
  it("returns two empty blocks and logs when the delivery read fails", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    deliveries.mockRejectedValue(new Error("db down"));
    const out = await buildRecipientBlocks("n1");
    expect(out).toEqual({ push: { html: "", text: "" }, email: { html: "", text: "" } });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: "db down", notificationId: "n1" }), expect.any(String));
    warn.mockRestore();
  });

  it("drops the email half too when only the push half's lookup fails", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    userTable = [{ id: "u1", email: "a@x.co", displayName: "A", username: "a" }];
    deliveries.mockResolvedValue([push({}, "https://push.example/e"), mail("a@x.co")]);
    subs.mockRejectedValue(new Error("subs gone"));
    const out = await buildRecipientBlocks("n1");
    expect(out).toEqual({ push: { html: "", text: "" }, email: { html: "", text: "" } });
    warn.mockRestore();
  });
});
