/**
 * tests/unit/assetVipRowsDom.test.ts — the asset-details General tab's VIP /
 * Virtual Server rows (`assetVipRowsHTML` in public/js/assets.js).
 *
 * Three things about these rows break silently:
 *
 *  - the row exists to put the EXTERNAL address on screen. A stamp with no
 *    extip must still render (the gate is the other half of the answer) and
 *    must not print an empty copy target;
 *  - the gate is named by FortiManager's DEVICE NAME. A gate that resolved to
 *    an asset becomes a link, but the displayed NAME must not change to the
 *    asset's hostname — that is the conflation `fortinetParentKey` exists to
 *    prevent, and an operator matching this against the FortiGate config is
 *    looking for the config's spelling;
 *  - an unresolved gate must stay TEXT rather than a dead link.
 *
 * assets.js is a ~20k-line browser script with no module boundary, so the
 * function under test is sliced out by name and eval'd — the approach of
 * tests/unit/assetUpstreamRowsDom.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, any>;
const assetsLines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

/** Slice a top-level `function NAME(...) {` … `}` block out of assets.js. */
function fnSrc(name: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

let rowsHTML: (vips: unknown[]) => string;

/** One VIP entry as GET /assets/:id/vips ships it. */
function vip(over: Record<string, unknown> = {}) {
  return {
    ip: "10.4.12.63",
    subnetCidr: "10.4.12.0/24",
    reservationId: "res-1",
    name: "web-prod",
    extip: "203.0.113.10",
    role: "mapped",
    isVirtualServer: false,
    device: "SITE-A-FGT-PRIMARY",
    asset: { id: "fw-1", hostname: "fgt-a.example.internal" },
    ...over,
  };
}

function render(vips: unknown[]): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = rowsHTML(vips);
  return host;
}

beforeEach(() => {
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  (0, eval)(fnSrc("assetVipRowsHTML"));
  rowsHTML = g.assetVipRowsHTML;
  expect(typeof rowsHTML, "assets.js no longer declares assetVipRowsHTML").toBe("function");
});

describe("assetVipRowsHTML", () => {
  it("renders nothing when the asset is behind no VIP", () => {
    expect(rowsHTML([])).toBe("");
    expect(rowsHTML(null as unknown as unknown[])).toBe("");
  });

  it("puts the external address, the VIP name and the gate in one row", () => {
    const host = render([vip()]);
    expect(host.querySelector(".detail-label")!.textContent).toBe("VIP");
    const value = host.querySelector(".detail-value")!;
    // The external address is the copy target — that is what the row is for.
    const copy = value.querySelector(".copy-cell")!;
    expect(copy.getAttribute("data-copy")).toBe("203.0.113.10");
    expect(value.textContent).toContain("web-prod");
    // The gate keeps the name the VIP config carries, NOT the asset hostname.
    const link = value.querySelector("a.dep-tree-link")!;
    expect(link.textContent).toBe("SITE-A-FGT-PRIMARY");
    expect(link.getAttribute("data-asset-id")).toBe("fw-1");
    expect(link.getAttribute("title")).toBe("fgt-a.example.internal");
    // The note says which side of the VIP the asset sits on.
    expect(value.textContent).toContain("maps to 10.4.12.63");
  });

  it("labels a load-balance virtual server as one, and names its pool side", () => {
    const host = render([vip({ isVirtualServer: true, role: "realserver", name: "lb-pool" })]);
    expect(host.querySelector(".detail-label")!.textContent).toBe("Virtual Server");
    expect(host.querySelector(".detail-value")!.textContent).toContain("pool member 10.4.12.63");
  });

  it("says so when the asset's own address IS the external side", () => {
    const host = render([vip({ role: "external", ip: "203.0.113.10" })]);
    expect(host.querySelector(".detail-value")!.textContent).toContain("this address is the external side");
  });

  it("keeps an unresolved gate as plain text, not a dead link", () => {
    const host = render([vip({ asset: null, device: "GATE-NOT-IN-INVENTORY" })]);
    const value = host.querySelector(".detail-value")!;
    expect(value.querySelector("a")).toBeNull();
    expect(value.textContent).toContain("GATE-NOT-IN-INVENTORY");
  });

  it("still names the gate when the VIP carries no external address", () => {
    const host = render([vip({ extip: null })]);
    const value = host.querySelector(".detail-value")!;
    expect(value.querySelector(".copy-cell")).toBeNull();
    expect(value.textContent).toContain("no external IP");
    expect(value.querySelector("a.dep-tree-link")).not.toBeNull();
  });

  it("renders one row per VIP", () => {
    const host = render([vip(), vip({ ip: "10.4.13.63", name: "api-prod", extip: "203.0.113.11" })]);
    expect(host.querySelectorAll(".detail-row")).toHaveLength(2);
  });

  it("escapes a VIP name carrying markup", () => {
    const host = render([vip({ name: '<img src=x onerror="alert(1)">' })]);
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector(".detail-value")!.textContent).toContain("<img src=x");
  });
});
