/**
 * tests/unit/firmwareRepositoryAssetListFlow.test.ts — Server Settings →
 * Repository: clicking a node's asset count opens the device-list slide-in,
 * and clicking a device opens its asset details (business rule 87).
 *
 * Driven through the tab's own wiring, not the pure renderers: the count sits
 * INSIDE the node header, so what is pinned is that the click reaches the list
 * without folding the node, that each node level asks the server for exactly
 * its own scope — the "(no model)" node included, which an empty `model` would
 * silently widen to the whole device type — and that a row hands off to
 * PolarisPanels.openAsset with the asset's id.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const eff = { credentialName: "FortiSwitch HTTP", scope: "assetType" };
function tree() {
  return { manufacturers: [{ name: "Fortinet", assetCount: 5, binding: null, effectiveBinding: null, assetTypes: [
    { assetType: "switch", label: "Switch", engine: "fortiswitch-https", assetCount: 5, binding: null, effectiveBinding: eff, models: [
      { model: "", assetCount: 2, orphaned: false, images: [], binding: null, effectiveBinding: eff },
      { model: "FortiSwitch S108FF", assetCount: 3, orphaned: false, images: [], binding: null, effectiveBinding: eff },
    ] },
  ] }] };
}

const assets = {
  total: 2, limit: 2000,
  assets: [
    { id: "a1", hostname: "SW-1", ipAddress: "10.0.0.1", assetType: "switch", model: "FortiSwitch S108FF", serialNumber: "S108FFTF1", osVersion: "7.4.3 build0542", status: "active", monitored: true, monitorStatus: "up", firmwareVsPrimary: "older" },
    { id: "a2", hostname: "SW-2", ipAddress: "10.0.0.2", assetType: "switch", model: "FortiSwitch S108FF", serialNumber: "S108FFTF2", osVersion: "7.6.8 build1164", status: "active", monitored: false, monitorStatus: null, firmwareVsPrimary: "current" },
  ],
};

async function boot() {
  const win = new Window({ url: "https://polaris.test/server-settings.html" });
  const calls: Array<Record<string, string>> = [];
  const opened: string[] = [];
  Object.assign(win as unknown as Record<string, unknown>, {
    formatBytes: (n: number) => n + " B",
    timeAgo: () => "2 days ago",
    escapeHtml: (x: unknown) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string)),
    showToast: () => {},
    calloutHTML: () => "",
    permAtLeast: () => true,
    isAdmin: () => true,
    requestAnimationFrame: (fn: () => void) => fn(),
    PolarisPanels: { openAsset: (id: string) => opened.push(id) },
    api: { serverSettings: {
      getFirmwareTree: async () => tree(),
      listFirmwareRuns: async () => ({ runs: [] }),
      listFirmwareNodeAssets: async (p: Record<string, string>) => { calls.push(p); return assets; },
    } },
  });
  win.document.body.innerHTML = '<div id="tab-firmware"></div>';
  (win as unknown as { eval: (s: string) => void }).eval(readFileSync(resolve(__dirname, "../../public/js/server-settings-firmware.js"), "utf8"));
  const tab = (win as unknown as { PolarisFirmwareTab: { load: () => Promise<void>; nodeKey: (...p: string[]) => string; _setState: (s: unknown) => void } }).PolarisFirmwareTab;
  await tab.load();
  const doc = win.document as unknown as Document;
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const countOf = (key: string) => doc.querySelector(`.fw-node[data-fw-key="${key}"] > .fw-node-header .fw-asset-count`) as HTMLElement;
  return { win, tab, doc, calls, opened, settle, countOf };
}

describe("asset count → device list → asset details", () => {
  it("asks each node for its own scope, and the (no model) node with noModel, never an empty model", async () => {
    const { tab, calls, settle, countOf } = await boot();
    countOf(tab.nodeKey("Fortinet")).click();
    await settle();
    countOf(tab.nodeKey("Fortinet", "switch")).click();
    await settle();
    countOf(tab.nodeKey("Fortinet", "switch", "FortiSwitch S108FF")).click();
    await settle();
    countOf(tab.nodeKey("Fortinet", "switch", "")).click();
    await settle();
    expect(calls).toEqual([
      { manufacturer: "Fortinet" },
      { manufacturer: "Fortinet", assetType: "switch" },
      { manufacturer: "Fortinet", assetType: "switch", model: "FortiSwitch S108FF" },
      { manufacturer: "Fortinet", assetType: "switch", noModel: "1" },
    ]);
  });

  it("opens the slide-in without folding the node, titled with the scope, listing the devices with their standing", async () => {
    const { tab, doc, settle, countOf } = await boot();
    const typeKey = tab.nodeKey("Fortinet", "switch");
    const caretBefore = doc.querySelector(`.fw-node[data-fw-key="${typeKey}"] > .fw-node-header .fw-node-caret`)!.textContent;
    countOf(typeKey).click();
    await settle();
    expect(doc.querySelector(`.fw-node[data-fw-key="${typeKey}"] > .fw-node-header .fw-node-caret`)!.textContent).toBe(caretBefore);
    expect(doc.getElementById("fw-assets-overlay")!.classList.contains("open")).toBe(true);
    expect(doc.getElementById("fw-assets-title")!.textContent).toBe("Fortinet › Switch");
    expect(doc.getElementById("fw-assets-meta")!.textContent).toBe("2 devices · 1 behind the primary image · click one to open its details");
    const rows = Array.from(doc.querySelectorAll("#fw-assets-body .fw-asset-row"));
    expect(rows.map((r) => r.getAttribute("data-asset-id"))).toEqual(["a1", "a2"]);
    expect(rows[0]!.textContent).toContain("Behind primary");
    expect(rows[1]!.textContent).toContain("Current");
    expect(rows[1]!.textContent).toContain("not monitored");
  });

  it("a row opens that asset's details through PolarisPanels, by click or by Enter", async () => {
    const { tab, doc, opened, settle, countOf, win } = await boot();
    countOf(tab.nodeKey("Fortinet", "switch", "FortiSwitch S108FF")).click();
    await settle();
    (doc.querySelector('#fw-assets-body [data-asset-id="a2"] .fw-asset-row-name') as HTMLElement).click();
    const row = doc.querySelector('#fw-assets-body [data-asset-id="a1"]') as HTMLElement;
    row.dispatchEvent(new (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(opened).toEqual(["a2", "a1"]);
  });

  it("the filter narrows the list in place", async () => {
    const { tab, doc, settle, countOf, win } = await boot();
    countOf(tab.nodeKey("Fortinet", "switch")).click();
    await settle();
    const f = doc.getElementById("fw-assets-filter") as HTMLInputElement;
    f.value = "10.0.0.2";
    f.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
    expect(Array.from(doc.querySelectorAll("#fw-assets-body .fw-asset-row")).map((r) => r.getAttribute("data-asset-id"))).toEqual(["a2"]);
    f.value = "nothing-like-this";
    f.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
    expect(doc.getElementById("fw-assets-body")!.textContent).toContain("Nothing matches");
  });
});
