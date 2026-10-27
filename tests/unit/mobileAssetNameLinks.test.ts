/**
 * tests/unit/mobileAssetNameLinks.test.ts
 *
 * On the phone, another asset's name is a tap target that opens its sheet:
 * PolarisAssetDetail.linkHtml draws `<a class="asset-link" data-open-asset>`,
 * and ONE capture-phase document listener in asset-detail.js opens it,
 * closing a stacked sheet above the asset sheet first (never the network
 * sheet, which sits below it). The end-to-end click through a table sheet is
 * in mobileAssetTableSheets.test.ts; this file pins every surface that draws
 * the link, and that the current asset's own name is never drawn as one.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf-8").replace(/\r\n/g, "\n");
const mobile = (f: string) => read("public", "js", "mobile", f);
const SHEET = mobile("asset-detail.js");
const CSS = read("public", "css", "mobile.css");

describe("asset-name links (PolarisAssetDetail.linkHtml)", () => {
  it("are drawn by one helper and opened by one capture-phase document listener", () => {
    expect(SHEET).toMatch(/class="asset-link" data-open-asset="/);
    expect(SHEET).toContain('document.addEventListener("click", onAssetLinkClick, true)');
    expect(SHEET).toMatch(/linkHtml: linkHtml/);
    // No surface keeps a private copy of the opener.
    expect(SHEET.match(/closest\("\[data-open-asset\]"\)/g)?.length).toBe(1);
  });

  it("close a sheet stacked over the asset sheet through its Close button, but leave the network sheet", () => {
    const fn = SHEET.slice(SHEET.indexOf("function onAssetLinkClick("), SHEET.indexOf('document.addEventListener("click", onAssetLinkClick'));
    expect(fn).toContain('over.id !== "asset-sheet"');
    expect(fn).toContain('!over.classList.contains("network-sheet")');
    expect(fn).toContain("querySelector('[aria-label=\"Close\"]')");
  });

  it("are used wherever another asset is named with a known id", () => {
    // Asset sheet: ARP / MAC / Wireless matched device, LLDP neighbor, HA primary, group gate.
    expect(SHEET).toMatch(/return linkHtml\(m\.id, m\.hostname \|\| m\.ipAddress \|\| m\.id\)/);
    expect(SHEET).toContain("linkHtml(n.matchedAsset && n.matchedAsset.id, headline)");
    expect(SHEET).toContain("linkHtml(primaryId, primaryName)");
    expect(SHEET).toContain("linkHtml(fw.group.gateAssetId, fw.group.gateName)");
    // Site sheet title, topology node title, network IP Hostname row.
    expect(mobile("map-tab.js")).toContain("assetNameHtml(site.id, site.hostname || \"FortiGate\")");
    expect(mobile("topology-tab.js")).toMatch(/assetNameHtml\(canPivotToAsset \? \(node\.data\("assetId"\) \|\| node\.id\(\)\)/);
    expect(mobile("subnet-detail.js")).toContain('ipDetailRow("Hostname", assetNameHtml(ip.assetId, r.hostname))');
    // Per-asset alerts sheet: only from the Assets list, where it is not the open asset.
    expect(mobile("alerts.js")).toContain("opts.linkName && window.PolarisAssetDetail");
    expect(mobile("assets-tab.js")).toMatch(/linkName: true/);
  });

  it("never link the open asset's own name", () => {
    expect(SHEET).not.toMatch(/linkName: true/);
    expect(SHEET).toMatch(/nameEl\.textContent = asset\.hostname/);
  });

  it("degrade to escaped text where the asset module is absent", () => {
    for (const f of ["map-tab.js", "topology-tab.js", "subnet-detail.js"]) {
      expect(mobile(f), f).toMatch(/PolarisAssetDetail\.linkHtml\) \? PolarisAssetDetail\.linkHtml\(id, name\) : escapeHtml\(name\)/);
    }
  });

  it("are styled as a link without changing the surrounding type", () => {
    const m = CSS.match(/\n\.asset-link \{([^}]*)\}/);
    expect(m).toBeTruthy();
    expect(m![1]).toMatch(/color:\s*var\(--md-primary\)/);
    expect(m![1]).toMatch(/font:\s*inherit/);
  });
});

describe("Device Map stacking", () => {
  it("keeps Leaflet's control corners (legend, attribution) inside the map, under the asset sheet", () => {
    const m = CSS.match(/\n\.map-screen \{([^}]*)\}/);
    expect(m![1]).toMatch(/isolation:\s*isolate/);
  });
});
