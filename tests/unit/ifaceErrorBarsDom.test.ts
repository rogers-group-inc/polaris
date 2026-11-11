/**
 * tests/unit/ifaceErrorBarsDom.test.ts — the interface error charts as stacked
 * bars with severity bands (business rule 159a, approved canvas 2026-11-12).
 *
 * Pinned:
 *  - Errors are drawn in errors PER SECOND (ifIn/OutErrorRate's unit), FC
 *    errors per MINUTE (the fc*Rate metrics'), so the axis reads in the number
 *    typed as the threshold;
 *  - each band of an automation reading the port is a dashed line in the band's
 *    colour with its caption, and the axis reaches the lowest band;
 *  - the series an automation reads takes the band's colour while inside it, a
 *    series no automation reads keeps its own colour;
 *  - in errors are no longer amber (amber means Warning), red is never a series;
 *  - the FC link counters are a diamond row, coloured by their own automation;
 *  - a port with nothing to draw says so instead of drawing an empty axis.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadSharedModules } from "./_sharedModules.js";
import { assetsSource } from "./_assetsSource.js";

loadSharedModules();

const g = globalThis as Record<string, any>;
const lines = assetsSource().split(/\r?\n/);

function fnSrc(name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets: function ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}
function varBlock(name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`var ${name} = `));
  if (start < 0) throw new Error(`assets: ${name} not found`);
  if (lines[start]!.trimEnd().endsWith(";")) return lines[start]!;
  const end = lines.findIndex((l, i) => i > start && l === "];");
  return lines.slice(start, end + 1).join("\n");
}

const FNS = ["_fmtErrRate", "_renderIfaceRateBars", "_ifaceIntervalMs", "_renderIfaceErrorChart", "_renderIfaceFcChart"];
const SRC = [
  readFileSync(resolve(__dirname, "../../public/js/chart-severity.js"), "utf8"),
  varBlock("_FC_CHART_BARS"), varBlock("_FC_CHART_EVENTS"), varBlock("_FC_CHART_METRICS"),
  ...FNS.map(fnSrc),
  ...FNS.map((n) => `globalThis.${n} = ${n};`),
].join("\n");

function installStubs() {
  g.escapeHtml = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c: string) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
  g._chartTimeBounds = (samples: any[], since?: string, until?: string) => ({
    t0: since ? +new Date(since) : +new Date(samples[0].timestamp),
    t1: until ? +new Date(until) : +new Date(samples[samples.length - 1].timestamp),
  });
  g._chartXScale = (padL: number, innerW: number, t0: number, t1: number) =>
    (t: string | number) => padL + ((+new Date(t) - t0) / Math.max(1, t1 - t0)) * innerW;
  g._chartYScale = (padT: number, innerH: number, yMin: number, yMax: number) =>
    (v: number) => padT + innerH - ((v - yMin) / Math.max(1e-9, yMax - yMin)) * innerH;
  g._chartClipId = (p: string) => `clip-${p}`;
  g._chartClipDefs = () => "";
  g._chartClipAttr = (id: string) => `clip-path="url(#${id})"`;
  g._chartXTicksSVG = () => "";
  g._dateChangeMarkers = () => "";
  g._maintenanceBandLayer = () => "";
  g._stashChartGeometry = () => {};
  g._addChartScreenshotButton = () => {};
  g._observeChartResize = () => {};
  g._statsSummaryFrom = () => () => "";
  g._outageMarkers = () => [];
  g._outageDotsSVG = () => "";
  g._outageHitsSVG = () => "";
  g._missTooltipHTML = () => "";
  g._fmtTooltipTs = (ts: string) => String(ts);
  g.CHART_TOOLTIP_HTML = '<div class="chart-tooltip"></div>';
  g.__tooltipFns = [] as Array<(t: Element) => string>;
  g._wireChartTooltip = (_c: Element, fn: (t: Element) => string) => { g.__tooltipFns.push(fn); };
}

beforeEach(() => {
  document.body.innerHTML = "";
  installStubs();
  (0, eval)(SRC);
  g.PolarisChartSeverity = (window as any).PolarisChartSeverity ?? g.PolarisChartSeverity;
});

const T0 = Date.UTC(2026, 10, 12, 14, 0, 0);
const iso = (m: number) => new Date(T0 + m * 60_000).toISOString();
function box(): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: 600 });
  document.body.appendChild(el);
  return el;
}
const tier = (severity: string, threshold: number) => ({ severity, operator: ">", threshold, ruleId: "r", ruleName: "Port errors" });
const opts = (tiers: Record<string, unknown[]>) => ({ since: iso(0), until: iso(10), subject: "port12", tiers });

describe("Errors (every port)", () => {
  const derived = [
    { timestamp: iso(1), inErrRate: 0.1, outErrRate: 0.02, inErr: 6, outErr: 1 },
    { timestamp: iso(2), inErrRate: 0.8, outErrRate: 0, inErr: 48, outErr: 0 },
    { timestamp: iso(3), inErrRate: 2.5, outErrRate: 0, inErr: 150, outErr: 0 },
  ];

  it("draws bars in errors per second, the in series in the band's colour while inside it", () => {
    const el = box();
    g._renderIfaceErrorChart(el, derived, opts({ ifInErrorRate: [tier("warning", 0.5), tier("critical", 2)] }));
    const fills = [...el.querySelectorAll("rect")].map((r) => r.getAttribute("fill"));
    expect(fills).toContain("var(--color-accent)");      // 0.1 /s: no band
    expect(fills).toContain("var(--color-sev-warning)"); // 0.8 /s
    expect(fills).toContain("var(--color-sev-critical)"); // 2.5 /s
    expect(fills).toContain("#9b5de5");                  // out errors, no automation
    expect(fills).not.toContain("#f59e0b");              // amber is the Warning colour now
    const caps = [...el.querySelectorAll("text")].map((t) => t.textContent);
    expect(caps).toContain("warning > 0.5 /s (in)");
    expect(caps).toContain("critical > 2 /s (in)");
    expect(el.querySelectorAll('line[stroke-dasharray="4,4"]').length).toBe(2);
  });

  it("reaches the lowest band even on a quiet port", () => {
    const el = box();
    g._renderIfaceErrorChart(el, [{ timestamp: iso(1), inErrRate: 0.01, outErrRate: 0 }], opts({ ifInErrorRate: [tier("warning", 5)] }));
    expect([...el.querySelectorAll("text")].map((t) => t.textContent)).toContain("warning > 5 /s (in)");
  });

  it("keeps every bar its own colour with no automation on the port", () => {
    const el = box();
    g._renderIfaceErrorChart(el, derived, opts({}));
    const fills = [...el.querySelectorAll("rect")].map((r) => r.getAttribute("fill"));
    expect(fills).not.toContain("var(--color-sev-warning)");
    expect(el.querySelectorAll('line[stroke-dasharray="4,4"]').length).toBe(0);
  });

  it("says so when the port reported nothing", () => {
    const el = box();
    g._renderIfaceErrorChart(el, [{ timestamp: iso(1), inErrRate: null, outErrRate: null }], opts({}));
    expect(el.textContent).toMatch(/No error samples/);
  });
});

describe("FC errors (a fibre-channel port)", () => {
  const fc = (invalidCrcs: number, invalidTxWords: number, linkFailures = 0) =>
    ({ invalidCrcs, invalidTxWords, linkFailures, syncLosses: 0, sigLosses: 0 });

  it("stacks CRC and invalid words per minute, CRC coloured by the CRC automation's bands", () => {
    const el = box();
    g._renderIfaceFcChart(el, [
      { timestamp: iso(1), fc: fc(2, 10) },
      { timestamp: iso(2), fc: fc(22, 30) },
    ], opts({ fcCrcErrorRate: [tier("warning", 5), tier("critical", 20)] }));
    const fills = [...el.querySelectorAll("rect")].map((r) => r.getAttribute("fill"));
    expect(fills).toContain("var(--color-accent)");       // CRC 2/min
    expect(fills).toContain("var(--color-sev-critical)"); // CRC 22/min
    expect(fills).toContain("#2a9d8f");                   // invalid words, no automation
    const caps = [...el.querySelectorAll("text")].map((t) => t.textContent);
    expect(caps).toContain("warning > 5 /min (CRC)");
  });

  it("marks a link failure as a diamond, in its own automation's colour", () => {
    const el = box();
    g._renderIfaceFcChart(el, [{ timestamp: iso(1), fc: fc(0, 0, 1) }], opts({ fcLinkFailureRate: [tier("serious", 0)] }));
    const diamonds = [...el.querySelectorAll("rect[transform]")].map((r) => r.getAttribute("fill"));
    expect(diamonds).toContain("var(--color-sev-serious)");
  });

  it("asks the operator to monitor a port with no FC samples yet", () => {
    const el = box();
    g._renderIfaceFcChart(el, [{ timestamp: iso(1), fc: null }], opts({}));
    expect(el.textContent).toMatch(/Monitor it/);
  });
});
