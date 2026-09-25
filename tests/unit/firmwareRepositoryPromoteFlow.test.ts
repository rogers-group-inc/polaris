/**
 * tests/unit/firmwareRepositoryPromoteFlow.test.ts — the Make primary click
 * on Server Settings → Repository (business rule 87), end to end through the
 * tab's own wiring: POST, re-fetch, re-render.
 *
 * Rows are drawn primary-first, so a swap moves only the two version strings
 * while every pill and button stays where it was — an operator reported the
 * toast fired and "nothing changed". What is pinned: the table really does
 * re-render from the re-fetched tree, the promoted row is flagged so the eye
 * lands on it, the node the operator had open stays open, and the toast names
 * both the new primary and the new backup.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

function image(over: Record<string, unknown> = {}) {
  return {
    id: "img-1", manufacturer: "Fortinet", assetType: "switch", model: "FortiSwitch S108FF", platform: "S108FF",
    versionLabel: "7.6.8 build1164", role: "primary", filename: "a.out", sizeBytes: 100,
    sha256: "abc", uploadedBy: "dmoore", uploadedAt: "2026-09-20T14:02:00Z", fileMissing: false, warnings: [] as string[], ...over,
  };
}

/** The tree as the server sorts it: primary first. `primaryIs` picks which image holds the role. */
function tree(primaryIs: "new" | "old") {
  const a = image({ id: "img-new", versionLabel: "7.6.8 build1164", version: { major: 7, minor: 6, patch: 8, build: 1164 }, role: primaryIs === "new" ? "primary" : "backup" });
  const b = image({ id: "img-old", versionLabel: "7.6.5 build1105", version: { major: 7, minor: 6, patch: 5, build: 1105 }, role: primaryIs === "old" ? "primary" : "backup" });
  const images = primaryIs === "new" ? [a, b] : [b, a];
  const eff = { credentialName: "Mock device login", scope: "manufacturer" };
  return { manufacturers: [{ name: "Fortinet", assetCount: 1, binding: { credentialName: "Mock device login", stale: false }, effectiveBinding: eff, assetTypes: [
    { assetType: "switch", label: "Switch", engine: "fortiswitch-https", assetCount: 1, binding: null, effectiveBinding: eff, models: [
      { model: "FortiSwitch S108FF", assetCount: 1, orphaned: false, images, binding: null, effectiveBinding: eff },
    ] },
  ] }] };
}

function boot() {
  const win = new Window({ url: "https://polaris.test/server-settings.html" });
  const calls: string[] = [];
  const toasts: string[] = [];
  let treeCalls = 0;
  Object.assign(win as unknown as Record<string, unknown>, {
    formatBytes: (n: number) => n + " B",
    timeAgo: () => "2 days ago",
    escapeHtml: (x: unknown) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string)),
    showToast: (m: string) => toasts.push(m),
    calloutHTML: () => "",
    permAtLeast: () => true,
    isAdmin: () => true,
    api: { serverSettings: {
      // First fetch: the new image is primary. After the promote the server
      // answers with the roles swapped, as it does for real.
      getFirmwareTree: async () => { treeCalls++; calls.push("tree"); return tree(treeCalls === 1 ? "new" : "old"); },
      listFirmwareRuns: async () => ({ runs: [] }),
      promoteFirmwareImage: async (id: string) => { calls.push("promote:" + id); return { image: { id } }; },
    } },
  });
  win.document.body.innerHTML = '<div id="tab-firmware"></div>';
  (win as unknown as { eval: (s: string) => void }).eval(readFileSync(resolve(__dirname, "../../public/js/server-settings-firmware.js"), "utf8"));
  const tab = (win as unknown as { PolarisFirmwareTab: { load: () => Promise<void>; nodeKey: (...p: string[]) => string; _setState: (s: unknown) => void } }).PolarisFirmwareTab;
  return { win, tab, calls, toasts };
}

const rowsOf = (doc: Document) => Array.from(doc.querySelectorAll("tr[data-image-id]")).map((r) => r.getAttribute("data-image-id") + ":" + r.querySelector(".fw-role-pill")!.textContent);

describe("Make primary on the Repository tab", () => {
  it("re-fetches the tree, redraws the rows swapped, flags the promoted row, keeps the node open and names both roles", async () => {
    const { win, tab, calls, toasts } = boot();
    const key = tab.nodeKey("Fortinet", "switch", "FortiSwitch S108FF");
    tab._setState({ expanded: { [key]: true } });
    await tab.load();
    const doc = win.document as unknown as Document;
    expect(rowsOf(doc)).toEqual(["img-new:Primary", "img-old:Backup"]);

    const promote = doc.querySelector(".fw-image-promote") as HTMLElement;
    expect(promote.getAttribute("data-id")).toBe("img-old");
    promote.click();
    await new Promise((r) => setTimeout(r, 30));

    expect(calls).toEqual(["tree", "promote:img-old", "tree"]);
    // Rows keep their version order; the roles and the verb are what moved.
    expect(rowsOf(doc)).toEqual(["img-new:Backup", "img-old:Primary"]);
    // The node the operator had open is still open after the redraw.
    expect((doc.querySelector(`.fw-node[data-fw-key="${key}"] .fw-node-caret`) as HTMLElement).textContent).toBe("▼");
    // The promoted row is flagged so the swap is visible, and the verb moved to the other row.
    expect(doc.querySelector('tr[data-image-id="img-old"]')!.classList.contains("fw-row-flash")).toBe(true);
    expect(doc.querySelector('tr[data-image-id="img-new"] .fw-image-promote')).not.toBeNull();
    expect(toasts).toEqual(["7.6.5 build1105 is now the primary image; 7.6.8 build1164 is the backup"]);
  });

  it("a failed promote toasts the server's message and leaves the rows alone", async () => {
    const { win, tab, toasts } = boot();
    (win as unknown as { api: { serverSettings: { promoteFirmwareImage: unknown } } }).api.serverSettings.promoteFirmwareImage = async () => { throw new Error("That image is already the primary"); };
    tab._setState({ expanded: { [tab.nodeKey("Fortinet", "switch", "FortiSwitch S108FF")]: true } });
    await tab.load();
    const doc = win.document as unknown as Document;
    (doc.querySelector(".fw-image-promote") as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(rowsOf(doc)).toEqual(["img-new:Primary", "img-old:Backup"]);
    expect(toasts).toEqual(["That image is already the primary"]);
  });
});
