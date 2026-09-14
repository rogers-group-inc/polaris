/**
 * tests/unit/alertPushRecipients.test.ts
 *
 * The footer line that names who ELSE this alert buzzed. Four things are worth
 * pinning:
 *
 *  - the token is DEFERRED, so the compose pass must leave it literal for the
 *    delivery pass to fill (the {chart.trigger} regression, in a new place) —
 *    and this one cannot be anything else: the push delivery rows it counts do
 *    not exist yet when the body is composed;
 *  - the footer block survives the compose-time pruning passes with the token
 *    still in it, and the "Sent by Polaris" line survives the empty case;
 *  - the text form carries no colon, or `pruneEmptyTextLines` deletes it;
 *  - the overflow rule, so a broadcast push doesn't mail a roster.
 */

import { describe, it, expect } from "vitest";
import {
  MAX_NAMED_RECIPIENTS,
  pushRecipientTokensIn,
  recipientName,
  renderPushRecipients,
  substitutePushRecipientTokens,
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

describe("renderPushRecipients", () => {
  it("names everyone this alert was pushed to", () => {
    expect(renderPushRecipients(["Ada Lovelace", "Grace Hopper"], { html: false })).toBe(
      "Web push sent to Ada Lovelace, Grace Hopper",
    );
  });

  it("counts the overflow past the cap rather than printing a roster", () => {
    const names = Array.from({ length: MAX_NAMED_RECIPIENTS + 4 }, (_, i) => `User ${i}`);
    const line = renderPushRecipients(names, { html: false });
    expect(line).toContain("User 0");
    expect(line).toContain(`User ${MAX_NAMED_RECIPIENTS - 1}`);
    expect(line).not.toContain(`User ${MAX_NAMED_RECIPIENTS}`);
    expect(line.endsWith(", and 4 more")).toBe(true);
  });

  it("renders nothing at all when the alert pushed to nobody", () => {
    expect(renderPushRecipients([], { html: true })).toBe("");
    expect(renderPushRecipients([], { html: false })).toBe("");
  });

  it("escapes the names in the HTML form", () => {
    const html = renderPushRecipients(['<script>x</script>', 'Bob & Co'], { html: true });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&amp;");
  });

  it("declares no font of its own — the footer block it sits in owns that", () => {
    // "Same font and size as the line below it" is guaranteed by inheritance,
    // not by a second copy of the 11px grey that would then drift.
    expect(renderPushRecipients(["Ada Lovelace"], { html: true })).not.toContain("font-size");
  });

  it("uses no colon, so pruneEmptyTextLines cannot delete the line", () => {
    const line = renderPushRecipients(["Ada Lovelace"], { html: false });
    expect(line).not.toContain(":");
    expect(pruneEmptyTextLines(line)).toBe(line);
  });
});

describe("recipientName", () => {
  it("prefers the display name", () => {
    expect(recipientName({ displayName: "Ada Lovelace", username: "alovelace" })).toBe("Ada Lovelace");
  });

  it("falls back to the username an SSO account may never have gained a name for", () => {
    expect(recipientName({ displayName: null, username: "alovelace" })).toBe("alovelace");
    expect(recipientName({ displayName: "   ", username: "alovelace" })).toBe("alovelace");
  });
});

describe("the {push.recipients} token", () => {
  it("is deferred, so the compose pass leaves it for delivery", () => {
    expect(isDeferredToken("push.recipients")).toBe(true);
    // Prefix, not an enumerated name — the rule that outlived {chart.trigger}.
    expect(isDeferredToken("push.somethingWeAddNextYear")).toBe(true);
    expect(isDeferredToken("pushbullet")).toBe(false);
    for (const body of [DEFAULT_ALERT_HTML, DEFAULT_ALERT_TEXT]) {
      expect(renderNotificationTemplate(body, CTX, { unknown: "blank" })).toContain("{push.recipients}");
    }
  });

  it("is catalogued for the wizard, like every other token in the default body", () => {
    expect(TEMPLATE_VARIABLES.some((v) => v.token === "{push.recipients}")).toBe(true);
  });

  it("is found in both default bodies", () => {
    expect(pushRecipientTokensIn(DEFAULT_ALERT_TEXT, DEFAULT_ALERT_HTML).has("push.recipients")).toBe(true);
    expect(pushRecipientTokensIn("no tokens here").size).toBe(0);
  });

  it("removes itself when the block is empty", () => {
    expect(substitutePushRecipientTokens("a{push.recipients}b", "")).toBe("ab");
  });
});

describe("the email footer", () => {
  it("survives the compose passes with the token still waiting in it", () => {
    const html = composeHtml();
    expect(html).toContain("{push.recipients}");
    expect(html).toContain('Sent by Polaris · automation "Asset down"');
    // Above the sender line, which is what was asked for.
    expect(html.indexOf("{push.recipients}")).toBeLessThan(html.indexOf("Sent by Polaris"));
  });

  it("keeps the sender line when the alert pushed to nobody", () => {
    // The token blanks away at DELIVERY, after pruneEmptyDivs has already run —
    // so the empty case must leave the enclosing footer untouched.
    const filled = substitutePushRecipientTokens(composeHtml(), "");
    expect(filled).toContain('Sent by Polaris · automation "Asset down"');
    expect(filled).not.toContain("{push.recipients}");
  });

  it("puts the two lines inside one block, so they cannot drift apart", () => {
    const html = composeHtml();
    const footer = /<div style="font-size:11px;color:#9ca3af;margin-top:10px">[\s\S]*?Sent by Polaris/.exec(html)?.[0] ?? "";
    expect(footer).toContain("{push.recipients}");
  });

  it("survives the text body's own pruning pass, filled or empty", () => {
    const text = composeText();
    expect(text).toContain("{push.recipients}");
    const filled = pruneEmptyTextLines(
      substitutePushRecipientTokens(text, renderPushRecipients(["Ada Lovelace"], { html: false })),
    );
    expect(filled).toContain("Web push sent to Ada Lovelace");
    const empty = pruneEmptyTextLines(substitutePushRecipientTokens(text, ""));
    expect(empty).not.toContain("{push.recipients}");
    expect(empty).not.toMatch(/\n\s*\n\s*$/);
  });
});
