/**
 * tests/unit/webhookTextEscaping.test.ts
 *
 * Slack and Teams alert text includes device-derived strings (hostnames, event
 * messages). Slack's markup control characters and Teams' markdown must not be
 * live in them (scan finding F248; business rule 109).
 */

import { describe, it, expect } from "vitest";
import {
  escapeSlackText,
  escapeTeamsText,
  formatBody,
  type WebhookPayload,
} from "../../src/services/notificationChannels/webhookChannel.js";

const base: WebhookPayload = {
  title: "[ERROR] host",
  message: "CPU high",
  severity: "error",
  assetHostname: "host",
  url: "https://polaris.example.com/notifications.html",
  triggeredAt: "2026-10-12T12:00:00.000Z",
};

describe("escapeSlackText", () => {
  it("escapes exactly &, < and >", () => {
    expect(escapeSlackText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it.each(["<!channel>", "<!here>", "<!everyone>", "<@U12345>", "<#C123|general>", "<https://evil.example|Click here>"])(
    "defuses the control sequence %s",
    (evil) => {
      const out = escapeSlackText(evil);
      expect(out).not.toContain("<");
      expect(out).not.toContain(">");
    },
  );

  it("escapes the ampersand first so entities are not double-decoded", () => {
    expect(escapeSlackText("&lt;")).toBe("&amp;lt;");
  });

  it("leaves ordinary text alone", () => {
    expect(escapeSlackText("fw-atl-01: CPU 95%")).toBe("fw-atl-01: CPU 95%");
  });
});

describe("formatBody for Slack", () => {
  it("escapes the device-derived title and message but keeps the server-built View link live", () => {
    const body = formatBody("slack", { ...base, title: "<!channel> pwned", message: "see <https://evil|here>" }) as { text: string };
    expect(body.text).not.toContain("<!channel>");
    expect(body.text).not.toContain("<https://evil|here>");
    expect(body.text).toContain("&lt;!channel&gt; pwned");
    expect(body.text).toContain("<https://polaris.example.com/notifications.html|View>");
  });
});

describe("escapeTeamsText", () => {
  it.each([
    ["[click](https://evil.example)", "\\[click\\]\\(https://evil.example\\)"],
    ["![x](https://evil/p.png)", "\\!\\[x\\]\\(https://evil/p.png\\)"],
    ["**bold** _it_ `code`", "\\*\\*bold\\*\\* \\_it\\_ \\`code\\`"],
    ["<b>html</b>", "\\<b\\>html\\</b\\>"],
    ["# heading", "\\# heading"],
  ])("neutralises %j", (input, expected) => {
    expect(escapeTeamsText(input)).toBe(expected);
  });

  it("escapes a list marker at the start of a line", () => {
    expect(escapeTeamsText("- item\n1. two\nplain - dash")).toBe("\\- item\n1\\. two\nplain - dash");
  });

  it("leaves ordinary hostnames and numbers readable", () => {
    expect(escapeTeamsText("fw-atl-01.example.com 95%")).toBe("fw-atl-01.example.com 95%");
  });
});

describe("formatBody for Teams", () => {
  it("escapes title and text, and leaves the plain-text summary and the action link alone", () => {
    const body = formatBody("teams", { ...base, title: "[x](https://evil)", message: "**pwned**" }) as Record<string, any>;
    expect(body.title).toBe("\\[x\\]\\(https://evil\\)");
    expect(body.text).toBe("\\*\\*pwned\\*\\*");
    expect(body.summary).toBe("[x](https://evil)");
    expect(body.potentialAction[0].targets[0].uri).toBe(base.url);
  });
});

describe("formatBody for the generic webhook", () => {
  it("is JSON and carries the raw values: a receiving system decides how to render them", () => {
    const body = formatBody("generic", { ...base, message: "<b>raw</b> & more" }) as Record<string, any>;
    expect(body.message).toBe("<b>raw</b> & more");
  });
});
