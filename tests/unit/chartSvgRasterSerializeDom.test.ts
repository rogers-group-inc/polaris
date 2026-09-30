/**
 * tests/unit/chartSvgRasterSerializeDom.test.ts — the per-chart camera
 * button's SVG prep (_serializeChartSvgForRaster in public/js/assets.js).
 *
 * The camera rasterizes the chart by loading its serialized SVG as an <img>.
 * An image sees no page stylesheet and no custom property, so whatever the
 * live chart inherited has to be written into the markup first. Until
 * 2026-09-23 only currentColor and var(--color-accent) were substituted: the
 * response-time chart's normal samples are var(--color-success), and every
 * one of them came out BLACK in the PNG, while the tick labels, which carry
 * no font-family of their own, fell back to the renderer's serif.
 *
 * Pinned here: every var() resolves (including a var() fallback and an
 * unknown token), currentColor resolves, the root carries a sans font stack,
 * and the interactive scaffolding (hit targets, in-SVG axis titles the canvas
 * redraws) is stripped.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const assetsLines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

function fnSrc(name: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  return assetsLines.slice(start, end + 1).join("\n");
}

const serialize = new Function(
  `${fnSrc("_serializeChartSvgForRaster")}; return _serializeChartSvgForRaster;`,
)() as (svg: Element, w: number, h: number) => string;

function liveSvg(inner: string): SVGSVGElement {
  const host = document.createElement("div");
  host.innerHTML = `<svg viewBox="0 0 200 100" style="width:200px">${inner}</svg>`;
  document.body.appendChild(host);
  return host.querySelector("svg") as SVGSVGElement;
}

describe("_serializeChartSvgForRaster", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    const root = document.documentElement.style;
    root.setProperty("--color-success", "#2e7d32");
    root.setProperty("--color-accent", "#4fc3f7");
    root.setProperty("--color-border", "#333344");
    document.documentElement.style.color = "rgb(220, 220, 230)";
  });

  it("resolves every var() token, not only the accent", () => {
    const out = serialize(
      liveSvg(
        '<circle cx="1" cy="1" r="1.5" fill="var(--color-success)"/>' +
        '<line x1="0" y1="0" x2="1" y2="1" stroke="var(--color-border)" style="stroke:var(--color-accent)"/>',
      ),
      200,
      100,
    );
    expect(out).not.toContain("var(");
    expect(out).toContain('fill="#2e7d32"');
    expect(out).toContain('stroke="#333344"');
    expect(out).toContain("stroke:#4fc3f7");
  });

  it("takes a declared fallback, including a nested var(), and never leaves an unknown token", () => {
    const out = serialize(
      liveSvg(
        '<rect fill="var(--nope, #123456)"/>' +
        '<rect stroke="var(--nope, var(--color-success))"/>' +
        '<rect fill="var(--also-nope)"/>',
      ),
      200,
      100,
    );
    expect(out).not.toContain("var(");
    expect(out).toContain('fill="#123456"');
    expect(out).toContain('stroke="#2e7d32"');
  });

  it("replaces currentColor and stamps a sans font stack on the root", () => {
    const out = serialize(liveSvg('<text x="1" y="1" fill="currentColor">650</text>'), 200, 100);
    expect(out).not.toContain("currentColor");
    const doc = new DOMParser().parseFromString(out, "image/svg+xml");
    const root = doc.documentElement;
    expect(root.getAttribute("font-family")).toMatch(/sans-serif$/);
    expect(root.getAttribute("width")).toBe("200");
    expect(root.getAttribute("height")).toBe("100");
    expect(root.getAttribute("style")).toBeNull();
  });

  it("strips hit targets and in-SVG axis titles", () => {
    const out = serialize(
      liveSvg(
        '<circle class="monitor-hit" r="7" fill="transparent"/>' +
        '<rect class="chart-hit"/>' +
        '<text class="chart-axis-title">Time</text>' +
        '<circle class="keep" r="1.5" fill="var(--color-success)"/>',
      ),
      200,
      100,
    );
    expect(out).not.toContain("monitor-hit");
    expect(out).not.toContain("chart-hit");
    expect(out).not.toContain("chart-axis-title");
    expect(out).toContain('class="keep"');
  });
});
