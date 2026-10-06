/**
 * tests/unit/assetCoordinatesRowDom.test.ts — the asset-details General tab's
 * Coordinates row (public/js/assets.js → coordinatesRowHTML).
 *
 * A failed location lookup used to be invisible: the pin quietly kept the
 * FortiGate's other (often stale) coordinates, and the SNMP Location row just
 * below showed the new address as if it had placed the pin. The row now says
 * so, reading the fortigate-firewall source's observed.geocodeFailure, which
 * discovery rewrites every run (a later hit clears it).
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;
const lines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

function fnSrc(name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}

function varSrc(name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`var ${name} =`));
  if (start < 0) throw new Error(`assets.js: var ${name} not found`);
  const end = lines.findIndex((l, i) => i >= start && l.endsWith("};"));
  return lines.slice(start, end + 1).join("\n");
}

beforeAll(() => {
  g.escapeHtml = (s: any) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  // eslint-disable-next-line no-eval
  (0, eval)(varSrc("GEOCODE_FAILURE_TEXT") + "\n" + fnSrc("coordinatesRowHTML") +
    "\nglobalThis.coordinatesRowHTML = coordinatesRowHTML;");
});

const FW = { latitude: 39.5731, longitude: -86.0929, coordSource: null };
const failedSource = (reason = "no_match") => ({
  sourceKind: "fortigate-firewall",
  observed: { geocodeFailure: { query: "186 Lewis Watson Jr Rd. Butler, GA, 31006", source: "snmp", reason } },
});

function render(asset: any, sources: any[]): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = g.coordinatesRowHTML(asset, sources);
  return host;
}

describe("coordinatesRowHTML", () => {
  it("renders the pair alone when nothing failed", () => {
    const el = render(FW, [{ sourceKind: "fortigate-firewall", observed: { geocodeFailure: null } }]);
    expect(el.textContent).toContain("39.5731, -86.0929");
    expect(el.querySelector(".geocode-failure")).toBeNull();
  });

  it("flags a failed lookup beside the coordinates, naming the address in the tooltip", () => {
    const el = render(FW, [failedSource()]);
    const flag = el.querySelector(".geocode-failure")!;
    expect(el.textContent).toContain("39.5731, -86.0929");
    expect(flag.textContent).toContain("lookup failed — address not recognised");
    expect(flag.getAttribute("title")).toContain('SNMP location "186 Lewis Watson Jr Rd. Butler, GA, 31006"');
    expect(flag.getAttribute("title")).toContain("Events tab");
  });

  it("tells unreachable apart from not recognised", () => {
    const el = render(FW, [failedSource("unreachable")]);
    expect(el.textContent).toContain("geocoder unreachable");
  });

  it("still renders the row when the failure left the asset with no coordinates", () => {
    const el = render({ latitude: null, longitude: null }, [failedSource()]);
    expect(el.querySelector(".detail-label")!.textContent).toBe("Coordinates");
    expect(el.querySelector(".geocode-failure")).not.toBeNull();
  });

  it("never flags a manual pin — the lookup does not move it", () => {
    const el = render({ ...FW, coordSource: "manual" }, [failedSource()]);
    expect(el.textContent).toContain("(manual)");
    expect(el.querySelector(".geocode-failure")).toBeNull();
  });

  it("renders nothing with no coordinates and no failure", () => {
    expect(render({ latitude: null, longitude: null }, []).innerHTML).toBe("");
  });

  it("escapes the address", () => {
    const src = failedSource();
    src.observed.geocodeFailure.query = '<img src=x onerror="x">';
    const el = render(FW, [src]);
    expect(el.querySelector("img")).toBeNull();
  });
});

// The row's only caller is _assetGeneralTabHTML, a helper split out of
// openViewModal that "closes over nothing beyond its params". It first shipped
// calling coordinatesRowHTML(a, sources) without taking `sources`, so every
// asset slide-over threw "sources is not defined" and never opened — the tests
// above exercise the row in isolation and could not see it.
describe("coordinatesRowHTML call site", () => {
  it("_assetGeneralTabHTML takes sources, and openViewModal passes them", () => {
    const helper = fnSrc("_assetGeneralTabHTML");
    expect(helper).toContain("coordinatesRowHTML(a, sources)");
    expect(helper.split("\n")[0]).toMatch(/^function _assetGeneralTabHTML\(a, sources\)/);
    expect(lines.join("\n")).toContain("_assetGeneralTabHTML(a, sources);");
  });
});
