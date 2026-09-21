/**
 * tests/unit/assetSystemSectionShape.test.ts — which shape the asset-details
 * System tab's CPU & Memory section renders in (public/js/assets.js).
 *
 * The section is TWO charts (per-core CPU lines, a byte-scaled memory stack)
 * under the Polaris Agent and ONE combined 0–100% chart under every other
 * transport. That gate is worth pinning because it is invisible from either
 * renderer: both are correct code, and picking the wrong one for an asset
 * shows a FortiGate two single-line charts where it had one, or an agent host
 * a percentage line where its per-core detail should be.
 *
 * The polling method is READ THROUGH `_resolvedStreamPolling`, not off the
 * asset's own column — a class or integration tier can carry "agent" too —
 * so the stub here is that resolver, exactly as the section badge and the
 * stale banner see it.
 *
 * assets.js is a ~20k-line browser script with no module boundary, so the
 * region under test is sliced out by its surrounding comments and eval'd with
 * the app-shell globals stubbed — the approach of
 * assetCpuMemoryChartsDom.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;

const assetsSrc = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8");
const assetsLines = assetsSrc.split(/\r?\n/);

function regionSrc(startsWith: string, endsWith: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(startsWith));
  if (start < 0) throw new Error(`assets.js: region start ${startsWith} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l.startsWith(endsWith));
  if (end < 0) throw new Error(`assets.js: region end ${endsWith} not found`);
  return assetsLines.slice(start, end).join("\n");
}

const REGION = regionSrc(
  "// Whether the CPU & Memory section renders as TWO charts or one.",
  "// Field-replaceable hardware",
);
const EXPORTS = ["_telemetryIsAgentSourced", "assetSystemViewHTML"];
const SRC = REGION + "\n" + EXPORTS.map((n) => `globalThis.${n} = ${n};`).join("\n");

/** The app-shell globals the region calls into. */
function installStubs(telemetryPolling: string) {
  g.escapeHtml = (s: unknown) => String(s ?? "");
  g.timeAgo = () => "2m ago";
  g._chartRangeBtnsHTML = () => "<span class=\"range-btns\"></span>";
  g._streamSourceBadgeHTML = () => "<span class=\"badge\"></span>";
  g._SYSTEM_TAB_IFACE_METHODS = ["rest_api", "snmp", "vcenter", "agent"];
  g._resolvedStreamPolling = (_a: unknown, stream: string) =>
    (stream === "telemetry" ? telemetryPolling : "snmp");
}

function render(telemetryPolling: string, asset: Record<string, unknown> = {}): string {
  installStubs(telemetryPolling);
  // eslint-disable-next-line no-eval
  (0, eval)(SRC);
  return g.assetSystemViewHTML({ id: "a1", monitored: true, assetType: "server", ...asset });
}

describe("CPU & Memory section shape", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("mounts two charts when the agent collects telemetry", () => {
    const html = render("agent");
    expect(html).toContain('id="asset-cpu-chart"');
    expect(html).toContain('id="asset-memory-chart"');
    expect(html).toContain('id="asset-cpu-summary"');
    expect(html).toContain('id="asset-mem-summary"');
    expect(html).not.toContain('id="asset-system-chart"');
  });

  it("mounts one combined chart for every other transport", () => {
    for (const method of ["rest_api", "snmp", "winrm", "ssh", "vcenter"]) {
      const html = render(method, { assetType: "firewall" });
      expect(html, method).toContain('id="asset-system-chart"');
      expect(html, method).toContain('id="asset-system-summary"');
      expect(html, method).not.toContain('id="asset-cpu-chart"');
      expect(html, method).not.toContain('id="asset-memory-chart"');
    }
  });

  it("gives both shapes the same one range selector and custom-window panel", () => {
    for (const method of ["agent", "rest_api"]) {
      const html = render(method);
      expect(html, method).toContain('id="asset-system-custom-panel"');
      expect((html.match(/asset-system-custom-panel/g) || []).length, method).toBe(1);
      expect(html, method).toContain('data-shot-section="cpuMemory"');
    }
  });

  it("labels the two charts, and leaves the combined one to the section header", () => {
    const split = render("agent");
    expect(split).toContain(">CPU</div>");
    expect(split).toContain(">Memory</div>");
    const combined = render("snmp");
    expect(combined).not.toContain(">CPU</div>");
    expect(combined).not.toContain(">Memory</div>");
  });

  it("reads the resolved method, so a class-tier agent override still splits", () => {
    // The per-asset column says snmp; the resolver — which walks the class and
    // integration tiers — says agent. The section follows the resolver.
    installStubs("agent");
    // eslint-disable-next-line no-eval
    (0, eval)(SRC);
    expect(g._telemetryIsAgentSourced({ id: "a1", cpuMemoryPolling: "snmp" })).toBe(true);
    installStubs("snmp");
    (0, eval)(SRC);
    expect(g._telemetryIsAgentSourced({ id: "a1", cpuMemoryPolling: "agent" })).toBe(false);
  });
});
