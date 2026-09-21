/**
 * tests/unit/alertEmailTemplate.test.ts
 *
 * The default alert email. The point of expressing it as a TEMPLATE (rather
 * than server-side string building) is that what Polaris sends and what the
 * operator can edit in a Notify action are the same text — so these tests pin
 * the template's shape, and the two prune passes that keep an under-populated
 * device from mailing a column of blank cells.
 */

import { describe, it, expect } from "vitest";
import {
  defaultAlertEmailTemplate,
  pruneEmptyChartSection,
  pruneEmptyDivs,
  pruneEmptyRows,
  pruneEmptyTextLines,
  DEFAULT_ALERT_HTML,
  DEFAULT_ALERT_TEXT,
  DEFAULT_ALERT_SUBJECT,
} from "../../src/utils/alertEmailTemplate.js";
import { substituteChartTokens, chartTokensIn, attachmentsFor, CHART_TOKENS, type RenderedChart, type ChartToken } from "../../src/services/alertChartService.js";
import { renderNotificationTemplate, buildTemplateContext } from "../../src/utils/notificationTemplate.js";

const CTX = buildTemplateContext({
  asset: "PINERUN-222E-4",
  message: "packet loss at 93.8% (fires above 5%)",
  severity: "critical",
  time: new Date("2026-08-12T10:00:00Z"),
  ruleName: "Packet loss",
  assetDetail: {
    id: "a-1",
    ipAddress: "10.20.30.40",
    lastSeenSwitch: "FS-248E-01/port15",
    lastSeenAp: null,
    location: "Pinerun County",
    description: "Warehouse mezzanine AP — north bay",
    manufacturer: "Fortinet",
    model: "FAP-431F",
  },
});

describe("a dependency-down alert says so in the subject, the banner and the facts (business rule 76)", () => {
  const dep = buildTemplateContext({
    asset: "PLC-7", severity: "critical", ruleName: "PLC down", time: new Date("2026-09-21T10:00:00Z"),
    triggerSummary: "Dependency down — upstream SW-PLANT-3 is down",
    dependency: { upstream: "SW-PLANT-3", rootCause: "FG-PLANT", reason: "down" },
    assetDetail: { id: "a-7", ipAddress: "10.9.9.7" },
  });

  it("tags the subject, and a plain alert's subject is unchanged", () => {
    expect(renderNotificationTemplate(DEFAULT_ALERT_SUBJECT, dep)).toBe("[CRITICAL] PLC-7 — PLC down · DEPENDENCY DOWN");
    expect(renderNotificationTemplate(DEFAULT_ALERT_SUBJECT, CTX)).toBe("[CRITICAL] PINERUN-222E-4 — Packet loss");
  });

  it("prints the notice above the facts, and the upstream + root-cause rows", () => {
    const html = pruneEmptyDivs(pruneEmptyRows(renderNotificationTemplate(DEFAULT_ALERT_HTML, dep, { html: true, unknown: "blank" })));
    expect(html).toContain("DEPENDENCY DOWN — PLC-7 is unreachable because its upstream device SW-PLANT-3 sits behind FG-PLANT, which is down");
    expect(html).toContain("Upstream device");
    expect(html).toContain("Root cause");
    expect(html).toContain("FG-PLANT");
    const text = pruneEmptyTextLines(renderNotificationTemplate(DEFAULT_ALERT_TEXT, dep, { unknown: "blank" }));
    expect(text).toContain("Upstream:   SW-PLANT-3");
    expect(text).toContain("Root cause: FG-PLANT");
    expect(text).toContain("DEPENDENCY DOWN");
  });

  it("prunes the banner and both rows away on every other alert", () => {
    const html = pruneEmptyDivs(pruneEmptyRows(renderNotificationTemplate(DEFAULT_ALERT_HTML, CTX, { html: true, unknown: "blank" })));
    expect(html).not.toContain("Upstream device");
    expect(html).not.toContain("Root cause");
    expect(html).not.toContain("DEPENDENCY DOWN");
    // The banner div goes with its padding, not just its text.
    expect(html).not.toMatch(/border-left:3px solid #5b6b8c[^>]*>\s*<\/div>/);
    const text = pruneEmptyTextLines(renderNotificationTemplate(DEFAULT_ALERT_TEXT, CTX, { unknown: "blank" }));
    expect(text).not.toContain("Upstream:");
    expect(text).not.toContain("Root cause:");
  });

  it("drops only the root-cause row when the upstream device is the root cause", () => {
    const one = buildTemplateContext({
      asset: "PLC-7", severity: "critical", ruleName: "PLC down",
      dependency: { upstream: "SW-PLANT-3", rootCause: null, reason: "down" },
    });
    const html = pruneEmptyRows(renderNotificationTemplate(DEFAULT_ALERT_HTML, one, { html: true, unknown: "blank" }));
    expect(html).toContain("Upstream device");
    expect(html).not.toContain("Root cause");
  });
});

describe("the default alert email is a template, not string building", () => {
  it("carries the device facts the old two-line email never had", () => {
    const html = renderNotificationTemplate(DEFAULT_ALERT_HTML, CTX, { html: true });
    expect(html).toContain("PINERUN-222E-4");
    expect(html).toContain("10.20.30.40");
    expect(html).toContain("FS-248E-01/port15");
    // The description is usually where a site already states what the device is
    // FOR — and on a description-synced install it's the device's own text.
    expect(html).toContain("Warehouse mezzanine AP — north bay");
    expect(renderNotificationTemplate(DEFAULT_ALERT_TEXT, CTX)).toContain("Warehouse mezzanine AP — north bay");
  });

  it("drops the description row on a device that has none", () => {
    // Most workstations carry no description; a blank "Description" cell reads
    // as a broken email rather than as "not applicable".
    const bare = buildTemplateContext({ asset: "wks-1", assetDetail: { id: "a-2", ipAddress: "10.0.0.9" } });
    const html = pruneEmptyRows(renderNotificationTemplate(DEFAULT_ALERT_HTML, bare, { html: true, unknown: "blank" }));
    expect(html).not.toContain("Description");
    expect(pruneEmptyTextLines(renderNotificationTemplate(DEFAULT_ALERT_TEXT, bare, { unknown: "blank" })))
      .not.toContain("Description:");
  });

  it("says what fired ONCE — the message is not repeated under the headline", () => {
    // "Monitor status is down" (from the trigger) followed by a grey
    // "HARBOR-61F-1 is down" (the message) said the same thing twice. The
    // message keeps its real homes — the in-app alert card, and the chat/push
    // bodies, which carry no trigger sentence — so this is about the EMAIL only.
    for (const body of [DEFAULT_ALERT_HTML, DEFAULT_ALERT_TEXT]) {
      expect(body).not.toContain("{message}");
      expect(body).toContain("{trigger.summary}");
    }
    const html = renderNotificationTemplate(DEFAULT_ALERT_HTML, CTX, { html: true });
    expect(html).not.toContain("packet loss at 93.8%");
  });

  it("still carries an event's REASON, as its own facts row", () => {
    // The 12 seeded event automations set messageTemplate "{value}" precisely to
    // surface the event's own text, so dropping {message} from the body would
    // have left "integration.discover.error on FMG-Ashfield" with no reason.
    // {event.message} is its own row instead — which also survives an operator
    // replacing the message template, as "{value}" never did.
    const ev = buildTemplateContext({
      asset: "FMG-Ashfield",
      severity: "serious",
      triggerSummary: "integration.discover.error on FMG-Ashfield",
      event: {
        action: "integration.discover.error",
        resourceType: "integration",
        resourceName: "FMG-Ashfield",
        actor: "system:scheduler",
        message: "Discovery failed: RPC -11 no valid session",
      },
    });
    const html = pruneEmptyRows(renderNotificationTemplate(DEFAULT_ALERT_HTML, ev, { html: true, unknown: "blank" }));
    expect(html).toContain("Detail");
    expect(html).toContain("Discovery failed: RPC -11 no valid session");
    // And it prunes away on a metric alert, which has no event behind it.
    const metric = pruneEmptyRows(renderNotificationTemplate(DEFAULT_ALERT_HTML, CTX, { html: true, unknown: "blank" }));
    expect(metric).not.toContain("Detail");
  });

  it("offers Acknowledge and Open device as real links", () => {
    expect(DEFAULT_ALERT_HTML).toContain('href="{ack}"');
    expect(DEFAULT_ALERT_HTML).toContain('href="{asset.link}"');
    expect(DEFAULT_ALERT_TEXT).toContain("{ack}");
    expect(DEFAULT_ALERT_TEXT).toContain("{asset.link}");
  });

  it("asks for every last-hour chart, sensor included", () => {
    // The sensor chart is requested unconditionally; it renders away for the
    // alerts that aren't about a hardware sensor (buildAlertCharts drops it
    // when the notification carries no sensor dimension), so the template
    // needs no conditional and the operator can move or delete it like any
    // other token.
    // Read from the implementation: the body is supposed to ask for the whole
    // catalogue, so a newly added chart that nobody wired into the template is
    // the failure this pins — not a list to keep in step by hand.
    const all = new Set<string>(CHART_TOKENS);
    expect(chartTokensIn(DEFAULT_ALERT_HTML)).toEqual(all);
    expect(chartTokensIn(DEFAULT_ALERT_TEXT)).toEqual(all);
  });

  it("leads the charts with the sensor — when it renders, it IS what fired", () => {
    expect(DEFAULT_ALERT_HTML.indexOf("{chart.sensor}")).toBeLessThan(DEFAULT_ALERT_HTML.indexOf("{chart.cpu}"));
    expect(DEFAULT_ALERT_TEXT.indexOf("{chart.sensor}")).toBeLessThan(DEFAULT_ALERT_TEXT.indexOf("{chart.cpu}"));
  });

  it("survives every mail client's rendering quirks: tables, inline styles, no remote assets", () => {
    // Outlook renders through Word — flexbox/grid and <style> blocks are out.
    expect(DEFAULT_ALERT_HTML).not.toMatch(/display:\s*flex|display:\s*grid|<style/i);
    // Nothing to fetch: remote images are blocked by default in most clients.
    expect(DEFAULT_ALERT_HTML).not.toMatch(/<img[^>]+src="https?:/i);
    expect(DEFAULT_ALERT_HTML).not.toMatch(/<script/i);
  });

  it("colours itself by severity through a token, not a hardcoded hex", () => {
    const html = renderNotificationTemplate(DEFAULT_ALERT_HTML, CTX, { html: true });
    expect(html).toContain("#dc2626"); // critical
    expect(renderNotificationTemplate(DEFAULT_ALERT_HTML, buildTemplateContext({ severity: "warning" }), { html: true }))
      .toContain("#d97706");
  });

  it("gives the facts table's label column a fixed width so a long value wraps in its own column", () => {
    // Auto layout sized the two columns from their content: on a body whose
    // device rows pruned away, "Automation"/"Raised" claimed most of the 600px
    // and their values wrapped into a two-word gutter.
    expect(DEFAULT_ALERT_HTML).toContain('<td width="140" style="width:140px');
    expect(DEFAULT_ALERT_HTML).toContain("word-break:break-word");
  });

  it("prints the raised time as a person reads it, not as ISO-8601", () => {
    expect(DEFAULT_ALERT_HTML).toContain("{time.local}");
    expect(DEFAULT_ALERT_HTML).not.toMatch(/>\{time\}</);
    expect(DEFAULT_ALERT_TEXT).toContain("{time.local}");
  });

  it("says what the alert is about without calling the Polaris server a Device", () => {
    // Plenty of alerts are about Polaris itself; "Device: Polaris server" is
    // what made those read like they were about somebody's switch.
    expect(DEFAULT_ALERT_TEXT).toContain("Subject:");
    expect(DEFAULT_ALERT_TEXT).not.toContain("Device:");
  });

  it("is what defaultAlertEmailTemplate hands the wizard to prefill", () => {
    const t = defaultAlertEmailTemplate();
    expect(t.bodyHtmlTemplate).toBe(DEFAULT_ALERT_HTML);
    expect(t.bodyTextTemplate).toBe(DEFAULT_ALERT_TEXT);
    expect(t.subjectTemplate).toContain("{severity.upper}");
  });
});

describe("pruneEmptyRows", () => {
  it("drops a facts row whose value is empty", () => {
    const html = '<table><tr><td>Connected AP</td><td></td></tr><tr><td>IP</td><td>10.0.0.1</td></tr></table>';
    const out = pruneEmptyRows(html);
    expect(out).not.toContain("Connected AP");
    expect(out).toContain("10.0.0.1");
  });

  it("treats a whitespace-only value as empty", () => {
    expect(pruneEmptyRows("<tr><td>Model</td><td>  &nbsp; </td></tr>")).toBe("");
  });

  it("never touches layout rows — only two-cell label/value pairs", () => {
    const bar = '<tr><td style="background:#dc2626">&nbsp;</td></tr>';
    expect(pruneEmptyRows(bar)).toBe(bar);
    const three = "<tr><td>a</td><td></td><td>c</td></tr>";
    expect(pruneEmptyRows(three)).toBe(three);
  });

  it("prunes the real body when the device knows little about itself", () => {
    const bare = buildTemplateContext({ asset: "host-9", triggerSummary: "Monitor status is down", severity: "warning" });
    const out = pruneEmptyRows(renderNotificationTemplate(DEFAULT_ALERT_HTML, bare, { html: true }));
    expect(out).not.toContain("Connected switch");
    expect(out).not.toContain("Connected AP");
    // What fired, and the scaffolding, survive.
    expect(out).toContain("Monitor status is down");
    expect(out).toContain("Acknowledge alert");
  });

  // The regression that produced the broken box: an alert about Polaris itself
  // has NO asset, so the facts table's first row ({asset.ip}) is empty. The
  // pattern used to start at the row WRAPPING the table, run to that first
  // fact row's </tr>, read as a two-cell label/value pair, and take the
  // opening <table> tag with it — leaving an unmatched </table> that closed
  // the card early, so "Last hour" and the buttons rendered outside the box.
  it("never eats the table a fact row lives in, however empty that row is", () => {
    const ctx = buildTemplateContext({ severity: "warning", ruleName: "Capacity severity escalated", time: new Date("2026-08-12T18:46:01Z") });
    const out = pruneEmptyRows(renderNotificationTemplate(DEFAULT_ALERT_HTML, ctx, { html: true, unknown: "blank" }));
    // The facts table still opens (its own font-size is what identifies it)...
    expect(out).toMatch(/<table[^>]*font-size:13px/);
    // ...and every <table> is still closed exactly once, which is the property
    // that keeps the card from ending early.
    expect((out.match(/<table\b/g) ?? []).length).toBe((out.match(/<\/table>/g) ?? []).length);
    // The surviving rows are the ones with something to say.
    expect(out).toContain("Automation");
    expect(out).not.toContain("IP address");
  });

});

describe("pruneEmptyDivs", () => {
  it("drops a header line whose token rendered empty", () => {
    expect(pruneEmptyDivs('<div style="font-size:19px"></div>\n<div>Polaris server</div>')).toBe("<div>Polaris server</div>");
  });

  it("leaves a div with content alone, chart tokens included", () => {
    const pending = '<div style="x">{chart.cpu}</div>';
    expect(pruneEmptyDivs(pending)).toBe(pending);
  });
});

describe("pruneEmptyChartSection", () => {
  const section = (inner: string) => `<tr data-section="charts"><td><div>Last hour</div>${inner}</td></tr>`;

  it("drops a Last-hour heading left standing over nothing", () => {
    // Every chart token renders away for an alert with no asset to chart —
    // Polaris's own capacity, a failed backup — and a heading over empty space
    // reads as a broken email.
    expect(pruneEmptyChartSection(section(""))).toBe("");
  });

  it("keeps the section once a chart — or its numbers-only fallback — rendered", () => {
    expect(pruneEmptyChartSection(section('<img src="cid:x">'))).toContain("Last hour");
    expect(pruneEmptyChartSection(section("<p>CPU (last hour): now 62%</p>"))).toContain("Last hour");
  });

  it("never touches another single-cell row", () => {
    const other = '<tr><td style="padding:16px"><div>Sent by Polaris</div></td></tr>';
    expect(pruneEmptyChartSection(other)).toBe(other);
  });
});

describe("pruneEmptyTextLines", () => {
  it("drops label lines with nothing after the colon and collapses the gap", () => {
    const out = pruneEmptyTextLines("Device:     host-9\nAP:         \nIP:         10.0.0.1");
    expect(out).toBe("Device:     host-9\nIP:         10.0.0.1");
  });

  it("leaves prose alone — it only prunes Label: value lines", () => {
    expect(pruneEmptyTextLines("packet loss at 93.8% (fires above 5%)")).toBe("packet loss at 93.8% (fires above 5%)");
  });
});

describe("substituteChartTokens", () => {
  // hasData and attachment are DIFFERENT facts: "the device reported nothing"
  // vs "it reported, but the rasterizer failed". The first is dropped from the
  // email, the second still prints its numbers.
  const chart = (token: ChartToken, withPng: boolean, hasData = true): RenderedChart => ({
    token,
    cid: `polaris-${token.replace(".", "-")}@polaris`,
    hasData,
    summary: "CPU (last hour): now 62%, avg 40%, peak 97%",
    attachment: withPng
      ? { cid: `polaris-${token.replace(".", "-")}@polaris`, filename: "c.png", contentType: "image/png", content: Buffer.from("x") }
      : null,
  });

  it("embeds the image by cid and keeps the numbers as alt text", () => {
    const charts = new Map([["chart.cpu" as ChartToken, chart("chart.cpu", true)]]);
    const out = substituteChartTokens("<div>{chart.cpu}</div>", charts, { html: true });
    expect(out).toContain('src="cid:polaris-chart-cpu@polaris"');
    // Image blocking is on by default in a lot of clients — the numbers have
    // to survive it.
    expect(out).toContain("now 62%, avg 40%, peak 97%");
  });

  it("falls back to the summary line when there is no image to show", () => {
    const charts = new Map([["chart.cpu" as ChartToken, chart("chart.cpu", false)]]);
    const out = substituteChartTokens("<div>{chart.cpu}</div>", charts, { html: true });
    expect(out).not.toContain("<img");
    expect(out).toContain("now 62%");
  });

  it("writes plain text as a sentence, not markup", () => {
    const charts = new Map([["chart.cpu" as ChartToken, chart("chart.cpu", true)]]);
    expect(substituteChartTokens("{chart.cpu}", charts, { html: false })).toBe("CPU (last hour): now 62%, avg 40%, peak 97%");
  });

  it("removes a token nothing was built for, rather than mailing the literal", () => {
    expect(substituteChartTokens("a{chart.memory}b", new Map(), { html: true })).toBe("ab");
    expect(substituteChartTokens("a{chart.memory}b", new Map(), { html: false })).toBe("ab");
  });

  it("attaches only the images the final body actually references", () => {
    const charts = new Map<ChartToken, RenderedChart>([
      ["chart.cpu", chart("chart.cpu", true)],
      ["chart.memory", chart("chart.memory", true)],
    ]);
    const body = substituteChartTokens("<div>{chart.cpu}</div>", charts, { html: true });
    const attached = attachmentsFor(charts, body);
    expect(attached.map((a) => a.cid)).toEqual(["polaris-chart-cpu@polaris"]);
  });
});

// ── The component the alert is about ────────────────────────────────────────

describe("a per-component alert names its component", () => {
  // The complaint this answers: a PoE fault email named the switch and the
  // automation, and the port only in passing inside the headline sentence — so
  // eight faulted ports produced eight emails an operator could not tell apart
  // in an inbox, and nothing labelled WHICH port any one of them was about.
  const port = buildTemplateContext({
    asset: "SW-CORE-1",
    severity: "critical",
    dimension: "port12 (Indoor AP)",
    dimensionNoun: "Interface",
    triggerSummary: "PoE status on port12 (Indoor AP) is fault",
    ruleName: "PoE fault",
    assetDetail: { id: "a-1", ipAddress: "10.20.30.40" },
  });

  it("puts the component in the SUBJECT, where an inbox shows it", () => {
    expect(renderNotificationTemplate(DEFAULT_ALERT_SUBJECT, port))
      .toBe("[CRITICAL] SW-CORE-1 · port12 (Indoor AP) — PoE fault");
  });

  it("labels it in the body, in both halves", () => {
    const html = pruneEmptyRows(renderNotificationTemplate(DEFAULT_ALERT_HTML, port, { html: true, unknown: "blank" }));
    expect(html).toContain("Interface");
    expect(html).toContain("port12 (Indoor AP)");
    const text = pruneEmptyTextLines(renderNotificationTemplate(DEFAULT_ALERT_TEXT, port, { unknown: "blank" }));
    expect(text).toContain("Interface: port12 (Indoor AP)");
  });

  it("labels a sensor a sensor and a tunnel a tunnel — one template, not three", () => {
    const tunnel = buildTemplateContext({ asset: "FW-1", dimension: "AZURE-VPN", dimensionNoun: "IPsec tunnel" });
    expect(pruneEmptyTextLines(renderNotificationTemplate(DEFAULT_ALERT_TEXT, tunnel, { unknown: "blank" })))
      .toContain("IPsec tunnel: AZURE-VPN");
  });

  it("names it generically rather than not at all when the noun is unknown", () => {
    // A test alert, or a context built by a path that carries no trigger: the
    // value is still the most specific fact in the email, so it is labelled
    // rather than dropped.
    const noNoun = buildTemplateContext({ asset: "SW-1", dimension: "port3" });
    expect(pruneEmptyTextLines(renderNotificationTemplate(DEFAULT_ALERT_TEXT, noNoun, { unknown: "blank" })))
      .toContain("Component: port3");
  });

  it("leaves a whole-device alert exactly as it was", () => {
    // Every alert about a device rather than a part of one — which is most of
    // them — must be byte-identical to before this existed.
    const device = buildTemplateContext({ asset: "HARBOR-61F-1", severity: "serious", ruleName: "Asset down" });
    expect(renderNotificationTemplate(DEFAULT_ALERT_SUBJECT, device, { unknown: "blank" }))
      .toBe("[SERIOUS] HARBOR-61F-1 — Asset down");
    const html = pruneEmptyRows(renderNotificationTemplate(DEFAULT_ALERT_HTML, device, { html: true, unknown: "blank" }));
    expect(html).not.toContain("Component");
    // The bare ": " the blank label would otherwise leave behind.
    const text = pruneEmptyTextLines(renderNotificationTemplate(DEFAULT_ALERT_TEXT, device, { unknown: "blank" }));
    for (const line of text.split("\n")) expect(line.trim()).not.toBe(":");
  });
});
