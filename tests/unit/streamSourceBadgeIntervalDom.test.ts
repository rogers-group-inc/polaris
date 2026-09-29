/**
 * tests/unit/streamSourceBadgeIntervalDom.test.ts — a stream badge can state a
 * cadence that is not its stream's own (public/js/assets.js).
 *
 * The SD-WAN tab's headers borrow the Interfaces stream's badge: SD-WAN is
 * scheduled only when Interfaces is on FortiOS REST, so the method and tier are
 * right. The cadence is not — SD-WAN polls on the integration's
 * sdwanIntervalSeconds (default 60s), and the badge read "every 10m" over a
 * table whose rows landed a minute apart.
 *
 * Pinned here: `opts.intervalSec` sets the sync render's cadence (null drops
 * the slot), rides the span as data-interval-sec, and the async
 * /effective-monitor-settings rewrite keeps it instead of re-stamping the
 * borrowed stream's interval. A badge without the option is unchanged.
 *
 * Functions are sliced out of assets.js by name and eval'd — the harness of
 * tests/unit/sdwanSectionHeaderDom.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;

const assetsLines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

/** Slice a top-level `function NAME(...) {` … `}` block out of assets.js. */
function fnSrc(name: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

const FN_NAMES = [
  "_formatPollingInterval",
  "_streamBadgeText",
  "_streamSourceBadgeHTML",
  "_updateStreamSourceBadgesFromEffective",
];

// A FortiGate whose Interfaces stream resolves to REST at 600s.
const ASSET = { id: "a1", discoveredByIntegration: { type: "fortigate" } };
const EFF = {
  resolved: { interfacesPolling: "rest_api", interfacesIntervalSec: 600 },
  provenance: { interfacesPolling: "manual" },
};

beforeEach(() => {
  document.body.innerHTML = "";
  g.escapeHtml = (s: any) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g._POLLING_COMPAT = { fortigate: true, manual: true };
  g._POLLING_LABELS = { rest_api: "REST API" };
  g._TIER_LABELS = { asset: "Asset", class: "Class", integration: "Integration", manual: "Source default" };
  g._polarisSourceDefaultPolling = () => "rest_api";
  g._streamFieldPrefix = (s: string) => s;
  g._streamIntervalAssetField = () => "interfacesIntervalSec";
  g._streamIntervalEffectiveField = () => "interfacesIntervalSec";
  g._streamTransportLabel = () => "Direct";
  g._streamCredential = () => null;
  g._resolveStreamMibLabel = () => null;
  g._credentialCache = { loaded: true };
  g._ensureCredentials = async () => {};
  g._effectiveResolvedByAssetId = new Map();
  g._updateStaleBannersFromEffective = () => {};

  // eslint-disable-next-line no-eval
  (0, eval)(FN_NAMES.map(fnSrc).join("\n\n"));
});

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.querySelector(".asset-stream-source-badge") as HTMLElement;
}

describe("_streamSourceBadgeHTML interval override", () => {
  it("states the caller's cadence, and the async rewrite keeps it", async () => {
    const span = mount(g._streamSourceBadgeHTML(ASSET, "interfaces", { intervalSec: 60 }));
    expect(span.getAttribute("data-interval-sec")).toBe("60");
    expect(span.textContent).toContain("every 1m");

    await g._updateStreamSourceBadgesFromEffective("a1", ASSET, Promise.resolve(EFF));
    expect(span.textContent).toContain("every 1m");
    expect(span.textContent).not.toContain("every 10m");
    expect(span.textContent).toContain("Source default");
  });

  it("drops the cadence slot when the stated cadence is null", async () => {
    const span = mount(g._streamSourceBadgeHTML(ASSET, "interfaces", { intervalSec: null }));
    expect(span.getAttribute("data-interval-sec")).toBe("");
    await g._updateStreamSourceBadgesFromEffective("a1", ASSET, Promise.resolve(EFF));
    expect(span.textContent).not.toContain("every");
  });

  it("leaves a badge without the option on its stream's own cadence", async () => {
    const span = mount(g._streamSourceBadgeHTML(ASSET, "interfaces"));
    expect(span.hasAttribute("data-interval-sec")).toBe(false);
    await g._updateStreamSourceBadgesFromEffective("a1", ASSET, Promise.resolve(EFF));
    expect(span.textContent).toContain("every 10m");
  });
});
