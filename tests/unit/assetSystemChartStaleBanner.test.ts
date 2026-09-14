/**
 * tests/unit/assetSystemChartStaleBanner.test.ts — the asset-details System
 * tab's CPU & Memory stale banner in the EMPTY-window state (public/js/assets.js).
 *
 * The amber "Last successful update X ago" banner is emitted inside the chart
 * container, so the empty-samples early return used to drop it: a device whose
 * telemetry pull had been failing for hours showed the banner on Response time,
 * Hardware Sensors and Interfaces, while CPU & Memory — the one card with
 * nothing at all to draw — said only "No telemetry samples in this range yet."
 * and gave no reason. An empty window is precisely when the last successful
 * pull is the only thing that explains the gap, so the banner has to survive
 * the early return.
 *
 * What's pinned: the banner reaches the DOM on the empty path when the last
 * telemetry is older than 3x the resolved cadence; a fresh device stays quiet;
 * the slot wrapper still carries the asset id and stream key that
 * _updateStaleBannersFromEffective rewrites once /effective-monitor-settings
 * lands; and the "not available via REST API" state never grows a banner,
 * because a stream this device cannot deliver has no freshness to report.
 *
 * assets.js is a ~18k-line browser script with no module boundary, so the
 * functions under test are sliced out by name and eval'd with the app-shell
 * globals stubbed — the approach of tests/unit/hwSensorTableScroll.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;

const assetsSrc = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8");
const assetsLines = assetsSrc.split(/\r?\n/);

/** Slice a top-level `function NAME(...) {` … `}` block out of assets.js. */
function fnSrc(name: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

// The real banner helpers ride along — the point of the test is that a banner
// the shared helpers decide to render actually reaches this container.
const FN_NAMES = [
  "_streamIntervalAssetField",
  "_streamIntervalEffectiveField",
  "_resolveStaleStreamSec",
  "_staleBannerBoxHTML",
  "_staleBannerInnerHTML",
  "_staleBannerHTML",
  "_isRestApiManagedNetworkDevice",
  "_renderSystemChart",
];
const SRC = FN_NAMES.map(fnSrc).join("\n") + "\n" +
  FN_NAMES.map((n) => `globalThis.${n} = ${n};`).join("\n");

const ASSET = { id: "A1", assetType: "firewall", cpuMemoryIntervalSec: 120 };

/** Render the CPU & Memory chart into a fresh container. */
function render(lastTelemetryAt: string | null, asset: any = ASSET) {
  document.body.innerHTML = '<div id="chart"></div>';
  const el = document.getElementById("chart")!;
  g._renderSystemChart(el, { samples: [] }, asset, { lastTelemetryAt });
  return el;
}

function agoIso(minutes: number) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

beforeEach(() => {
  g.escapeHtml = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  g.timeAgo = () => "7h ago";
  g._resolvedStreamPolling = (asset: any) => (asset && asset.assetType === "access_point" ? "rest_api" : "snmp");
  g._assetMonitorStreamSource = () => ({ polling: "REST API" });
  g._notAvailableViaPollingHTML = (label: string) => '<div class="na">' + label + " not available</div>";
  // Cadence tiers the banner threshold is resolved from: empty here, so
  // _resolveStaleStreamSec falls through to the asset's own interval.
  g._effectiveResolvedByAssetId = new Map();
  g._monitorSettingsCache = {};
  // eslint-disable-next-line no-new-func
  new Function(SRC)();
});

describe("_resolveStaleStreamSec", () => {
  it("reads the resolved cadence a tier above the asset", () => {
    // A class/integration override lands only in the effective walk. Naming
    // the wrong resolved field here is invisible — it just silently returns
    // the 60s floor — so the tier order is pinned per stream.
    g._effectiveResolvedByAssetId.set("A1", { cpuMemoryIntervalSeconds: 600, systemInfoIntervalSeconds: 1800 });
    expect(g._resolveStaleStreamSec("A1", ASSET, "telemetry")).toBe(600);
    expect(g._resolveStaleStreamSec("A1", ASSET, "systemInfo")).toBe(1800);
  });

  it("falls back to the per-asset override, then the manual tier", () => {
    expect(g._resolveStaleStreamSec("A1", ASSET, "telemetry")).toBe(120);
    g._monitorSettingsCache = { cpuMemoryIntervalSeconds: 300, systemInfoIntervalSeconds: 900 };
    expect(g._resolveStaleStreamSec("A1", { id: "A1" }, "telemetry")).toBe(300);
    expect(g._resolveStaleStreamSec("A1", { id: "A1" }, "systemInfo")).toBe(900);
  });

  it("floors at 60s telemetry / 600s system info when no tier answers", () => {
    expect(g._resolveStaleStreamSec("A1", { id: "A1" }, "telemetry")).toBe(60);
    expect(g._resolveStaleStreamSec("A1", { id: "A1" }, "systemInfo")).toBe(600);
  });

  it("keeps response time on its pre-split field names", () => {
    expect(g._resolveStaleStreamSec("A1", { id: "A1", monitorIntervalSec: 30 }, "responseTime")).toBe(30);
    g._effectiveResolvedByAssetId.set("A1", { intervalSeconds: 45 });
    expect(g._resolveStaleStreamSec("A1", { id: "A1", monitorIntervalSec: 30 }, "responseTime")).toBe(45);
  });
});

describe("CPU & Memory chart — empty window", () => {
  it("still flags a stalled telemetry pull", () => {
    const el = render(agoIso(7 * 60));
    expect(el.textContent).toContain("Last successful update 7h ago");
    // The empty state itself is not replaced by the banner — both are shown.
    expect(el.textContent).toContain("No telemetry samples in this range yet.");
  });

  it("stays quiet inside 3x the resolved cadence", () => {
    // 2-minute cadence (asset override) → threshold 6 minutes.
    const el = render(agoIso(3));
    expect(el.textContent).not.toContain("Last successful update");
    expect(el.textContent).toContain("No telemetry samples in this range yet.");
  });

  it("honours a cadence set a tier above the asset", () => {
    // 10-minute class override → 30-minute threshold. Under the old field
    // names no tier matched and this 5-minute-old pull read as stale.
    g._effectiveResolvedByAssetId.set("A1", { cpuMemoryIntervalSeconds: 600 });
    expect(render(agoIso(5)).textContent).not.toContain("Last successful update");
    expect(render(agoIso(45)).textContent).toContain("Last successful update");
  });

  it("stays quiet for a device that has never reported telemetry", () => {
    const el = render(null);
    expect(el.textContent).not.toContain("Last successful update");
    expect(el.textContent).toContain("No telemetry samples in this range yet.");
  });

  it("leaves a slot the effective-settings pass can rewrite", () => {
    // _updateStaleBannersFromEffective re-evaluates every slot by asset id +
    // stream key once the resolved cadence lands, so the wrapper has to be
    // emitted even on the path that renders no banner.
    const slot = render(agoIso(3)).querySelector(".asset-stale-banner-slot") as HTMLElement;
    expect(slot).not.toBeNull();
    expect(slot.getAttribute("data-asset-id")).toBe("A1");
    expect(slot.getAttribute("data-stream")).toBe("telemetry");
  });

  it("never banners a stream the polling method cannot deliver", () => {
    // A REST-managed FortiAP isn't directly REST-able; the section says so
    // instead. "Stale" would be meaningless — nothing was ever collected.
    const el = render(agoIso(7 * 60), { id: "A2", assetType: "access_point" });
    expect(el.querySelector("div.na")).not.toBeNull();
    expect(el.textContent).not.toContain("Last successful update");
  });
});
