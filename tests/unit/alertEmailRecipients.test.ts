/**
 * tests/unit/alertEmailRecipients.test.ts
 *
 * The footer line that names who ELSE this alert was mailed to — the sibling of
 * {push.recipients}, and the answer to a question no single copy's To line can
 * answer once a send splits per timezone or a reminder adds recipients the
 * first copy never had.
 *
 * Four things are worth pinning:
 *
 *  - the token is DEFERRED, and unlike its push sibling it is an ENUMERATED
 *    name rather than a prefix, so the registry entry is load-bearing: miss it
 *    and the compose pass blanks the token before the delivery pass that fills
 *    it (the {chart.trigger} regression, in a new place);
 *  - BCC IS NEVER NAMED (business rule 60). A blind copy that shows up in a
 *    footer everyone reads has stopped being blind, and the only reason the
 *    extraction is safe is that both email paths put To — and only To — in
 *    `target`;
 *  - the text form carries no colon, or `pruneEmptyTextLines` deletes it;
 *  - the overflow rule, so a wide distribution list doesn't mail a roster.
 */

import { describe, it, expect } from "vitest";
import {
  MAX_NAMED_RECIPIENTS,
  ccAddressesOf,
  emailRecipientTokensIn,
  renderEmailRecipients,
  substituteEmailRecipientTokens,
  toAddressesOf,
} from "../../src/services/alertPushRecipientsService.js";
import {
  DEFAULT_ALERT_HTML,
  DEFAULT_ALERT_TEXT,
  pruneDeadLinks,
  pruneEmptyDivs,
  pruneEmptyRows,
  pruneEmptyTextLines,
} from "../../src/utils/alertEmailTemplate.js";
import {
  buildTemplateContext,
  isDeferredToken,
  renderNotificationTemplate,
  TEMPLATE_VARIABLES,
} from "../../src/utils/notificationTemplate.js";

const CTX = buildTemplateContext({
  asset: "LAKE2012.example.com",
  severity: "critical",
  message: "LAKE2012.example.com is down",
  triggerSummary: "Monitor status is down",
  time: new Date("2026-08-18T15:00:00Z"),
  ruleName: "Asset down",
  assetDetail: { id: "a-1", ipAddress: "10.20.30.40" },
});

/** Compose exactly as notificationRecipientService.buildComposedEmail does. */
function composeHtml(): string {
  return pruneDeadLinks(pruneEmptyDivs(pruneEmptyRows(
    renderNotificationTemplate(DEFAULT_ALERT_HTML, CTX, { html: true, unknown: "blank" }),
  )));
}

function composeText(): string {
  return pruneEmptyTextLines(renderNotificationTemplate(DEFAULT_ALERT_TEXT, CTX, { unknown: "blank" }));
}

describe("renderEmailRecipients", () => {
  it("names everyone this alert was mailed to", () => {
    expect(renderEmailRecipients(["Ada Lovelace", "Grace Hopper"], { html: false })).toBe(
      "Email sent to Ada Lovelace, Grace Hopper",
    );
  });

  it("reads as a pair with the push line rather than as a second footnote", () => {
    // Same verb, same shape. The two lines sit one above the other in the
    // footer block and are meant to be read as one audience list.
    expect(renderEmailRecipients(["Ada Lovelace"], { html: false }).startsWith("Email sent to ")).toBe(true);
  });

  it("counts the overflow past the cap rather than printing a roster", () => {
    const names = Array.from({ length: MAX_NAMED_RECIPIENTS + 3 }, (_, i) => `user${i}@example.com`);
    const line = renderEmailRecipients(names, { html: false });
    expect(line).toContain("user0@example.com");
    expect(line).toContain(`user${MAX_NAMED_RECIPIENTS - 1}@example.com`);
    expect(line).not.toContain(`user${MAX_NAMED_RECIPIENTS}@example.com`);
    expect(line.endsWith(", and 3 more")).toBe(true);
  });

  it("renders nothing at all when there is nobody to name", () => {
    expect(renderEmailRecipients([], { html: true })).toBe("");
    expect(renderEmailRecipients([], { html: false })).toBe("");
  });

  it("escapes the names in the HTML form", () => {
    const html = renderEmailRecipients(['<script>x</script>', "Bob & Co"], { html: true });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&amp;");
  });

  it("declares no font of its own — the footer block it sits in owns that", () => {
    expect(renderEmailRecipients(["Ada Lovelace"], { html: true })).not.toContain("font-size");
  });

  it("uses no colon, so pruneEmptyTextLines cannot delete the line", () => {
    const line = renderEmailRecipients(["Ada Lovelace"], { html: false });
    expect(line).not.toContain(":");
    expect(pruneEmptyTextLines(line)).toBe(line);
  });
});

describe("address extraction", () => {
  it("splits the composed path's joined To line", () => {
    expect(toAddressesOf("ada@example.com, grace@example.com")).toEqual([
      "ada@example.com",
      "grace@example.com",
    ]);
  });

  it("handles the plain path's single address, and an empty target", () => {
    expect(toAddressesOf("ada@example.com")).toEqual(["ada@example.com"]);
    // Fixed-destination channels (slack/teams/pushbullet) write "" — and the
    // api_call transport writes "" too. Neither is an email recipient.
    expect(toAddressesOf("")).toEqual([]);
    expect(toAddressesOf(null)).toEqual([]);
  });

  it("reads Cc from a composed row's meta", () => {
    expect(ccAddressesOf({ cc: ["ops@example.com"] })).toEqual(["ops@example.com"]);
    expect(ccAddressesOf({})).toEqual([]);
    expect(ccAddressesOf(null)).toEqual([]);
    expect(ccAddressesOf({ cc: "not-an-array" })).toEqual([]);
  });

  it("NEVER surfaces a Bcc — not from meta, and not from the target", () => {
    // The guarantee has two halves. The extractor reads `cc` and nothing else,
    // so a blind list on the same row is invisible to it...
    const meta = { cc: ["ops@example.com"], bcc: ["secret@example.com"] };
    expect(ccAddressesOf(meta)).toEqual(["ops@example.com"]);
    expect(ccAddressesOf(meta)).not.toContain("secret@example.com");
    // ...and `target` is the To line alone on both email paths, so parsing it
    // cannot reach a Bcc either. If expandDeliveries ever starts folding Bcc
    // into `target`, this footer unblinds it — that is what this pins.
    expect(toAddressesOf("ada@example.com")).not.toContain("secret@example.com");
  });

  it("ignores anything that isn't an address", () => {
    expect(toAddressesOf("ada@example.com, , not-an-address")).toEqual(["ada@example.com"]);
    expect(ccAddressesOf({ cc: ["ops@example.com", "", 7] })).toEqual(["ops@example.com"]);
  });
});

describe("the {email.recipients} token", () => {
  it("is deferred, so the compose pass leaves it for delivery", () => {
    expect(isDeferredToken("email.recipients")).toBe(true);
    for (const body of [DEFAULT_ALERT_HTML, DEFAULT_ALERT_TEXT]) {
      expect(renderNotificationTemplate(body, CTX, { unknown: "blank" })).toContain("{email.recipients}");
    }
  });

  it("is catalogued for the wizard, like every other token in the default body", () => {
    expect(TEMPLATE_VARIABLES.some((v) => v.token === "{email.recipients}")).toBe(true);
  });

  it("is found in both default bodies", () => {
    expect(emailRecipientTokensIn(DEFAULT_ALERT_TEXT, DEFAULT_ALERT_HTML).has("email.recipients")).toBe(true);
    expect(emailRecipientTokensIn("no tokens here").size).toBe(0);
  });

  it("removes itself when the block is empty", () => {
    expect(substituteEmailRecipientTokens("a{email.recipients}b", "")).toBe("ab");
  });

  it("does not collide with the push token's substitution", () => {
    const body = "{push.recipients}|{email.recipients}";
    expect(substituteEmailRecipientTokens(body, "E")).toBe("{push.recipients}|E");
  });
});

describe("the email footer", () => {
  it("survives the compose passes with both tokens still waiting in it", () => {
    const html = composeHtml();
    expect(html).toContain("{push.recipients}");
    expect(html).toContain("{email.recipients}");
    // The sender line keeps the container alive through pruneEmptyDivs, so the
    // footer can't be taken with the tokens on an install that reaches nobody.
    expect(html).toContain("Sent by Polaris");
  });

  it("keeps the token in the text body too", () => {
    expect(composeText()).toContain("{email.recipients}");
  });

  it("leaves no empty footer line when the alert named nobody", () => {
    const html = substituteEmailRecipientTokens(
      substituteEmailRecipientTokens(composeHtml(), ""),
      "",
    );
    expect(html).not.toContain("{email.recipients}");
    expect(html).toContain("Sent by Polaris");
    const text = pruneEmptyTextLines(substituteEmailRecipientTokens(composeText(), ""));
    expect(text).not.toContain("{email.recipients}");
  });
});
