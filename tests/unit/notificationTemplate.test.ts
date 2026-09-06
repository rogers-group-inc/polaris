/**
 * tests/unit/notificationTemplate.test.ts
 *
 * The shared notification template renderer: token catalog completeness,
 * single-pass {token} interpolation, unknown-token passthrough, HTML-escaping
 * of interpolated values (not template markup), and the small helpers
 * (escapeHtml / templateNeedsAsset / formatElapsed).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  TEMPLATE_VARIABLES,
  buildTemplateContext,
  renderNotificationTemplate,
  escapeHtml,
  templateNeedsAsset,
  formatElapsed,
  formatLocalTime,
  isDeferredToken,
  setRecoverySentence,
  type TemplateContextParts,
} from "../../src/utils/notificationTemplate.js";
import { DEFAULT_ALERT_TEXT, DEFAULT_ALERT_HTML, DEFAULT_ALERT_SUBJECT } from "../../src/utils/alertEmailTemplate.js";

const FULL_PARTS: TemplateContextParts = {
  asset: "fw-atl-01",
  metric: "cpuPct",
  value: "97.5",
  threshold: "90",
  dimension: "port1",
  conditions: "2 of 3 conditions met",
  message: "High CPU: fw-atl-01 — cpuPct = 97.5 (threshold 90)",
  severity: "critical",
  time: new Date("2026-07-04T12:00:00.000Z"),
  link: "https://polaris.example.com/notifications.html",
  ruleName: "High CPU",
  ruleDescription: "Fires on sustained CPU",
  assetDetail: {
    id: "asset-1",
    ipAddress: "10.1.1.1",
    macAddress: "AA:BB:CC:DD:EE:FF",
    lastSeenSwitch: "FS-248E-01/port15",
    lastSeenAp: "FAP-431F-02",
    assetType: "firewall",
    status: "active",
    location: "Atlanta DC",
    learnedLocation: "fgt-atl",
    description: "Edge firewall — Atlanta DC, rack B4",
    manufacturer: "Fortinet",
    model: "FGT-100F",
    serialNumber: "FG100F123",
    os: "FortiOS",
    osVersion: "7.4.5",
    department: "IT",
    assignedTo: "netops",
    tags: ["prod", "region:Atlanta"],
  },
  triggerSummary: "Response time (median over 5 minutes) is 760 ms",
  // An event-triggered alert usually fires on something that isn't a device,
  // so these are the only identifying facts its email gets.
  event: {
    action: "integration.discover.error",
    level: "error",
    resourceType: "integration",
    resourceName: "FMG-Ashfield",
    actor: "system:scheduler",
    message: "Discovery failed: RPC -11 no valid session",
  },
  escalationTier: 2,
  escalationElapsed: "1h 30m",
  repeatAttempt: 3,
  repeatElapsed: "45m",
  // The reminder that ends a quiet-time hold (business rule 44).
  repeatQuiet: "Reminders resumed after a quiet period — this alert has been active for 9h 12m.",
  // The follow-up policy the alert was RAISED under — snapshotted at fire
  // time so a reminder describes the same automation the first email did.
  repeatPolicy: "Reminders every 15 minutes until acknowledged.",
  escalationPolicy: "Escalates in 30 minutes if not acknowledged.",
};

/**
 * Tokens with NO context key, by design — they are filled later, and both rely
 * on unknown tokens surviving the render:
 *
 *  - `{ack}` is built from the Notification's own id, and the context is
 *    finished BEFORE that row exists (prisma.notification.create is handed the
 *    completed ctx to snapshot onto templateCtx). Filled by
 *    substituteAckToken() at delivery expansion.
 *  - `{chart.*}` are inline images built at DELIVERY time from the last hour of
 *    samples (alertChartService), so an escalation email at T+90min charts the
 *    last hour as of sending rather than re-rendering a frozen snapshot.
 *
 * The set is read from the implementation rather than restated here. A local
 * copy is what let the bug through the first time: this file listed
 * {chart.trigger} while the renderer's own list didn't, so the test passed and
 * production blanked the token before the pass that fills it ever ran.
 */
const DEFERRED_TOKENS = new Set(TEMPLATE_VARIABLES.map((v) => v.token).filter((t) => isDeferredToken(t.slice(1, -1))));
const CONTEXT_TOKENS = TEMPLATE_VARIABLES.filter((v) => !DEFERRED_TOKENS.has(v.token));

// {asset.link} is only a URL when the install has a public URL to build one
// from — the same rule {link} follows.
const PREV_PUBLIC_URL = process.env.POLARIS_PUBLIC_URL;
beforeAll(() => { process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com"; });
afterAll(() => {
  if (PREV_PUBLIC_URL === undefined) delete process.env.POLARIS_PUBLIC_URL;
  else process.env.POLARIS_PUBLIC_URL = PREV_PUBLIC_URL;
});

describe("buildTemplateContext", () => {
  it("provides a context key for every cataloged token except the deferred ones", () => {
    const ctx = buildTemplateContext(FULL_PARTS);
    for (const v of CONTEXT_TOKENS) {
      const name = v.token.slice(1, -1); // strip { }
      expect(ctx, `missing context key for ${v.token}`).toHaveProperty([name]);
    }
  });

  it("keeps the deferred tokens OUT of the context", () => {
    const ctx = buildTemplateContext(FULL_PARTS);
    for (const token of DEFERRED_TOKENS) {
      const name = token.slice(1, -1);
      // A context key here would render the token to "" at compose time and
      // leave the per-recipient substitution nothing to fill.
      expect(ctx, `${token} must not be a context key`).not.toHaveProperty([name]);
      expect(renderNotificationTemplate(token, ctx)).toBe(token);
    }
  });

  it("leaves every deferred token in the DEFAULT body intact through a blank render", () => {
    // The regression that motivated the prefix rule. Polaris's own default body
    // renders with unknown:"blank" (so a pre-upgrade templateCtx can't leak
    // "{rule}" into a subject), which means a deferred token the renderer
    // doesn't recognize is DELETED here — silently, and only in production,
    // since the delivery pass then finds nothing to substitute.
    const ctx = buildTemplateContext(FULL_PARTS);
    for (const body of [DEFAULT_ALERT_SUBJECT, DEFAULT_ALERT_TEXT, DEFAULT_ALERT_HTML]) {
      const rendered = renderNotificationTemplate(body, ctx, { unknown: "blank" });
      for (const [, name] of body.matchAll(/\{([a-zA-Z][\w.]*)\}/g)) {
        if (!isDeferredToken(name!)) continue;
        expect(rendered, `{${name}} was blanked before its delivery-time pass`).toContain(`{${name}}`);
      }
    }
  });

  it("defers any chart token by prefix, including ones not yet invented", () => {
    expect(isDeferredToken("chart.trigger")).toBe(true);
    expect(isDeferredToken("chart.probeLoss")).toBe(true);
    expect(isDeferredToken("chart.somethingWeAddNextYear")).toBe(true);
    expect(isDeferredToken("ack")).toBe(true);
    expect(isDeferredToken("asset")).toBe(false);
    // Not a chart token — the prefix is "chart.", not "chart".
    expect(isDeferredToken("charter")).toBe(false);
  });

  it("renders every cataloged context token to a non-empty value with full parts", () => {
    const ctx = buildTemplateContext(FULL_PARTS);
    for (const v of CONTEXT_TOKENS) {
      expect(renderNotificationTemplate(v.token, ctx), `${v.token} rendered empty`).not.toBe("");
      expect(renderNotificationTemplate(v.token, ctx)).not.toBe(v.token);
    }
  });

  it("maps the derived fields correctly", () => {
    const ctx = buildTemplateContext(FULL_PARTS);
    expect(ctx["severity.upper"]).toBe("CRITICAL");
    expect(ctx["time"]).toBe("2026-07-04T12:00:00.000Z");
    expect(ctx["asset.location"]).toBe("Atlanta DC");
    expect(ctx["asset.tags"]).toBe("prod, region:Atlanta");
    expect(ctx["escalation.tier"]).toBe("2");
  });

  it("falls back to learnedLocation when location is unset and to empty strings when parts are missing", () => {
    const ctx = buildTemplateContext({ assetDetail: { learnedLocation: "fgt-atl" } });
    expect(ctx["asset.location"]).toBe("fgt-atl");
    const empty = buildTemplateContext({});
    expect(empty["asset.ip"]).toBe("");
    expect(empty["escalation.tier"]).toBe("");
    expect(empty["asset.tags"]).toBe("");
  });
});

describe("setRecoverySentence", () => {
  it("stamps the headline as well as {message}", () => {
    // The body prints no {message} line (it repeated the trigger sentence on a
    // fire), so a recovery whose only text lived there would have mailed a
    // severity colour, a hostname, and nothing about what happened.
    const ctx = buildTemplateContext({ asset: "fw-atl-01", severity: "resolved", triggerSummary: "Response time is 120 ms" });
    setRecoverySentence(ctx, "Resolved: High CPU — fw-atl-01 recovered");
    expect(ctx["message"]).toBe("Resolved: High CPU — fw-atl-01 recovered");
    // It REPLACES the trigger sentence: re-rendering the recovered reading under
    // a green "resolved" header reads like a fresh alert about a healthy device.
    expect(ctx["trigger.summary"]).toBe("Resolved: High CPU — fw-atl-01 recovered");
    expect(renderNotificationTemplate(DEFAULT_ALERT_TEXT, ctx, { unknown: "blank" }))
      .toContain("Resolved: High CPU — fw-atl-01 recovered");
  });
});

describe("renderNotificationTemplate", () => {
  const ctx = buildTemplateContext(FULL_PARTS);

  it("interpolates known tokens", () => {
    expect(renderNotificationTemplate("{asset}: {metric} = {value} (limit {threshold})", ctx))
      .toBe("fw-atl-01: cpuPct = 97.5 (limit 90)");
  });

  it("leaves unknown tokens literal (typos stay visible)", () => {
    expect(renderNotificationTemplate("{asset} {notAToken} {asset.nope}", ctx))
      .toBe("fw-atl-01 {notAToken} {asset.nope}");
  });

  it("does not re-interpolate substituted values (single pass)", () => {
    const c = buildTemplateContext({ ...FULL_PARTS, value: "{threshold}" });
    expect(renderNotificationTemplate("{value}", c)).toBe("{threshold}");
  });

  it("HTML mode escapes interpolated values but not template markup", () => {
    const c = buildTemplateContext({ ...FULL_PARTS, asset: '<script>alert("x")</script>' });
    const out = renderNotificationTemplate("<p><strong>{asset}</strong></p>", c, { html: true });
    expect(out).toBe("<p><strong>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</strong></p>");
  });
});

describe("escapeHtml", () => {
  it("escapes the five significant characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });
});

describe("templateNeedsAsset", () => {
  it("detects {asset.*} tokens across templates", () => {
    expect(templateNeedsAsset(["{asset} only", null, undefined])).toBe(false);
    expect(templateNeedsAsset([null, "IP: {asset.ip}"])).toBe(true);
  });
});

describe("formatElapsed", () => {
  it("formats minutes / hours / days", () => {
    expect(formatElapsed(5 * 60_000)).toBe("5m");
    expect(formatElapsed(92 * 60_000)).toBe("1h 32m");
    expect(formatElapsed(120 * 60_000)).toBe("2h");
    expect(formatElapsed(26 * 60 * 60_000)).toBe("1d 2h");
    expect(formatElapsed(-500)).toBe("0m");
  });
});

describe("formatLocalTime", () => {
  // The email's "Raised" row. {time}'s ISO form is right for a machine and
  // wrong for a body: unfriendly, and a 24-character string with no break
  // opportunity, which wrapped mid-token inside the facts table.
  it("reads as a date and a clock time, with the server's zone named", () => {
    const out = formatLocalTime(new Date("2026-08-12T18:46:01.561Z"));
    expect(out).toMatch(/Aug \d{1,2}, 2026/);
    expect(out).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/);
    // Which zone depends on the host; that it's NAMED is the point — an
    // unlabelled wall-clock time is worse than the ISO string it replaced.
    expect(out).not.toBe(new Date("2026-08-12T18:46:01.561Z").toISOString());
    expect(out.length).toBeGreaterThan("Aug 12, 2026, 1:46 PM".length);
  });

  it("accepts the string form a snapshotted context carries", () => {
    expect(formatLocalTime("2026-08-12T18:46:01.561Z")).toMatch(/Aug \d{1,2}, 2026/);
  });

  it("renders nothing it can't parse, so the row prunes instead of mailing Invalid Date", () => {
    expect(formatLocalTime("not a date")).toBe("");
    expect(formatLocalTime(null)).toBe("");
    expect(formatLocalTime(undefined)).toBe("");
    expect(formatLocalTime("")).toBe("");
  });
});
