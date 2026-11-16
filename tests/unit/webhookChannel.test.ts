/**
 * tests/unit/webhookChannel.test.ts — Slack / Teams / generic webhook delivery
 * (CQ-T010). The escaping rules themselves (rule 109) are pinned in depth by
 * webhookTextEscaping.test.ts and the real host guard (rule 110) by
 * ssrfOutboundCallers.test.ts; this suite covers every body shape and the
 * send path with netGuard and guardedFetch mocked at the module boundary.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { assertOutboundHostAllowed, resolveAllowedHost, guardedFetch } = vi.hoisted(() => ({
  assertOutboundHostAllowed: vi.fn(),
  resolveAllowedHost: vi.fn(),
  guardedFetch: vi.fn(),
}));
vi.mock("../../src/utils/netGuard.js", () => ({ assertOutboundHostAllowed, resolveAllowedHost }));
vi.mock("../../src/utils/guardedFetch.js", () => ({ guardedFetch }));

import {
  escapeSlackText,
  escapeTeamsText,
  formatBody,
  sendWebhook,
  type WebhookPayload,
} from "../../src/services/notificationChannels/webhookChannel.js";
import { severityHex } from "../../src/utils/severityStyle.js";
import { AppError } from "../../src/utils/errors.js";

const payload = (over: Partial<WebhookPayload> = {}): WebhookPayload => ({
  title: "sw-01 down",
  message: "No response for 3 polls",
  severity: "error",
  assetHostname: "sw-01",
  url: "https://polaris.example/alerts?id=n1",
  triggeredAt: "2026-11-16T12:00:00.000Z",
  ...over,
});

beforeEach(() => {
  assertOutboundHostAllowed.mockReset();
  resolveAllowedHost.mockReset();
  resolveAllowedHost.mockResolvedValue("34.1.2.3");
  guardedFetch.mockReset();
  guardedFetch.mockResolvedValue(new Response("ok", { status: 200 }));
});

describe("escapeSlackText", () => {
  it("escapes exactly &, < and >", () => {
    expect(escapeSlackText("a & <!channel> > *b*")).toBe("a &amp; &lt;!channel&gt; &gt; *b*");
  });
  it("escapes & first so an entity is not double-decoded into markup", () => {
    expect(escapeSlackText("&lt;")).toBe("&amp;lt;");
  });
  it("treats null / undefined as empty", () => {
    expect(escapeSlackText(null as unknown as string)).toBe("");
    expect(escapeSlackText(undefined as unknown as string)).toBe("");
  });
});

describe("escapeTeamsText", () => {
  it("backslash-escapes markdown and HTML introducers", () => {
    expect(escapeTeamsText("[x](http://e) *b* _i_ <b> #h")).toBe("\\[x\\]\\(http://e\\) \\*b\\* \\_i\\_ \\<b\\> \\#h");
  });
  it("escapes a dash or numbered list marker at the start of any line, keeping its indent", () => {
    expect(escapeTeamsText("- one\n  2. two\nmid - dash")).toBe("\\- one\n  2\\. two\nmid - dash");
  });
  it("leaves a dash not followed by whitespace alone", () => {
    expect(escapeTeamsText("-5 dBm")).toBe("-5 dBm");
  });
  it("treats null as empty", () => {
    expect(escapeTeamsText(null as unknown as string)).toBe("");
  });
});

describe("formatBody", () => {
  it("slack: bold escaped title, escaped message, server-built View link appended after escaping", () => {
    const b = formatBody("slack", payload({ title: "<@U1>", message: "a & b" })) as { text: string };
    expect(b).toEqual({ text: "*&lt;@U1&gt;*\na &amp; b <https://polaris.example/alerts?id=n1|View>" });
  });

  it("slack: no link without a url", () => {
    expect(formatBody("slack", payload({ url: null }))).toEqual({ text: "*sw-01 down*\nNo response for 3 polls" });
  });

  it("teams: a MessageCard with the severity colour, escaped title/text and a plain summary", () => {
    const b = formatBody("teams", payload({ title: "*t*", message: "[m]" })) as Record<string, any>;
    expect(b).toMatchObject({
      "@type": "MessageCard",
      "@context": "https://schema.org/extensions",
      themeColor: severityHex("error"),
      summary: "*t*",
      title: "\\*t\\*",
      text: "\\[m\\]",
    });
    expect(b.potentialAction).toEqual([
      { "@type": "OpenUri", name: "View in Polaris", targets: [{ os: "default", uri: "https://polaris.example/alerts?id=n1" }] },
    ]);
  });

  it("teams: no action without a url (and the key drops out of the JSON)", () => {
    const b = formatBody("teams", payload({ url: null })) as Record<string, unknown>;
    expect(b.potentialAction).toBeUndefined();
    expect(JSON.parse(JSON.stringify(b))).not.toHaveProperty("potentialAction");
  });

  it("generic: the raw notification JSON, unescaped", () => {
    expect(formatBody("generic", payload({ title: "<b>", assetHostname: null }))).toEqual({
      source: "polaris",
      title: "<b>",
      message: "No response for 3 polls",
      severity: "error",
      asset: null,
      url: "https://polaris.example/alerts?id=n1",
      triggeredAt: "2026-11-16T12:00:00.000Z",
    });
  });

  it("an unknown kind falls through to the generic body", () => {
    expect(formatBody("discord" as never, payload())).toMatchObject({ source: "polaris" });
  });
});

describe("sendWebhook", () => {
  it("rejects an unparseable URL as a 400 before any guard or request", async () => {
    const err = await sendWebhook("not a url", "slack", payload()).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ httpStatus: 400, message: "Invalid webhook URL: not a url" });
    expect(assertOutboundHostAllowed).not.toHaveBeenCalled();
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("checks the literal, then the resolution, then POSTs the formatted body with redirects off", async () => {
    await sendWebhook("https://hooks.slack.example/T1/B2", "slack", payload());
    expect(assertOutboundHostAllowed).toHaveBeenCalledWith("hooks.slack.example");
    expect(resolveAllowedHost).toHaveBeenCalledWith("hooks.slack.example");
    expect(guardedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = guardedFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.slack.example/T1/B2");
    expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" }, redirect: "manual" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual(formatBody("slack", payload()));
  });

  it("passes an IPv6 literal's bracketed hostname to the guard", async () => {
    await sendWebhook("https://[2001:db8::1]:8443/hook", "generic", payload());
    expect(assertOutboundHostAllowed).toHaveBeenCalledWith("[2001:db8::1]");
  });

  it("a blocked literal stops the send", async () => {
    assertOutboundHostAllowed.mockImplementation(() => {
      throw Object.assign(new Error("blocked"), { code: "BLOCKED_HOST" });
    });
    await expect(sendWebhook("http://127.0.0.1/h", "slack", payload())).rejects.toMatchObject({ code: "BLOCKED_HOST" });
    expect(resolveAllowedHost).not.toHaveBeenCalled();
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("a name resolving into a blocked range stops the send", async () => {
    resolveAllowedHost.mockRejectedValue(Object.assign(new Error("blocked"), { code: "BLOCKED_HOST" }));
    await expect(sendWebhook("https://rebind.example/h", "slack", payload())).rejects.toMatchObject({ code: "BLOCKED_HOST" });
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it.each([302, 404, 500])("a non-2xx answer (%i) is a 502 AppError so the drain retries", async (status) => {
    guardedFetch.mockResolvedValue(new Response(null, { status }));
    const err = await sendWebhook("https://hooks.example/h", "teams", payload()).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ httpStatus: 502, message: `Webhook POST failed: HTTP ${status}` });
  });
});
