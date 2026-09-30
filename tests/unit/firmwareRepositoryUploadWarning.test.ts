/**
 * tests/unit/firmwareRepositoryUploadWarning.test.ts — Server Settings →
 * Repository: an upload's warnings land on the node that took the upload,
 * after reload() has re-rendered it (business rule 87).
 *
 * The node is found again by its data-fw-key, which is built from
 * operator-typed text (the model name). It used to be spliced into a CSS
 * selector with only `"` escaped (CodeQL js/incomplete-sanitization,
 * 2026-09-28) — safe only because nodeKey() URI-encodes each part. It is now
 * compared as a value; the model here carries a quote and a backslash so the
 * path stays covered whichever way the lookup is written.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const MODEL = 'FortiSwitch "S108\\FF';

function tree() {
  return { manufacturers: [{ name: "Fortinet", assetCount: 1, binding: null, effectiveBinding: null, assetTypes: [
    { assetType: "switch", label: "Switch", engine: "fortiswitch-https", assetCount: 1, binding: null, effectiveBinding: null, models: [
      { model: MODEL, assetCount: 1, orphaned: false, images: [], binding: null, effectiveBinding: null },
    ] },
  ] }] };
}

async function boot() {
  const win = new Window({ url: "https://polaris.test/server-settings.html" });
  const uploads: Array<Record<string, string>> = [];
  Object.assign(win as unknown as Record<string, unknown>, {
    formatBytes: (n: number) => n + " B",
    timeAgo: () => "just now",
    escapeHtml: (x: unknown) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string)),
    showToast: () => {},
    calloutHTML: () => "",
    permAtLeast: () => true,
    isAdmin: () => true,
    requestAnimationFrame: (fn: () => void) => fn(),
    api: { serverSettings: {
      getFirmwareTree: async () => tree(),
      listFirmwareRuns: async () => ({ runs: [] }),
      uploadFirmwareImage: async (_f: unknown, fields: Record<string, string>) => {
        uploads.push(fields);
        return { image: { versionLabel: "7.6.8 build1164" }, demoted: null, rotatedOut: null, warnings: ["No asset under this model carries serial prefix S108FF."] };
      },
    } },
  });
  win.document.body.innerHTML = '<div id="tab-firmware"></div>';
  (win as unknown as { eval: (s: string) => void }).eval(readFileSync(resolve(__dirname, "../../public/js/server-settings-firmware.js"), "utf8"));
  const tab = (win as unknown as { PolarisFirmwareTab: { load: () => Promise<void>; nodeKey: (...p: string[]) => string } }).PolarisFirmwareTab;
  await tab.load();
  const doc = win.document as unknown as Document;
  const nodeEl = () => Array.from(doc.querySelectorAll(".fw-node[data-fw-key]")).find((n) => n.getAttribute("data-fw-key") === tab.nodeKey("Fortinet", "switch", MODEL)) as HTMLElement;
  return { win, tab, doc, uploads, nodeEl };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("upload warnings after the re-render", () => {
  it("shows the warnings on the node that took the upload, even when its key carries a quote and a backslash", async () => {
    const { uploads, nodeEl } = await boot();
    // Open every level down to the model so its upload row renders.
    for (const depth of ["0", "1", "2"]) {
      const closed = Array.from((nodeEl()?.ownerDocument ?? document).querySelectorAll(`.fw-node[data-fw-depth="${depth}"]`)) as HTMLElement[];
      for (const n of closed) {
        if (!n.querySelector(":scope > .fw-node-body .fw-node, :scope .fw-upload-row")) (n.querySelector(":scope > .fw-node-header") as HTMLElement).click();
      }
      await settle();
    }
    const input = nodeEl().querySelector(".fw-upload-file") as HTMLInputElement;
    expect(input, "the model node's upload row did not render").toBeTruthy();
    Object.defineProperty(input, "files", { value: [{ name: "FSW_108F-v7-build1164-FORTINET.out", size: 1024 }] });
    (nodeEl().querySelector(".fw-upload-btn") as HTMLElement).click();
    await settle();
    expect(uploads).toEqual([{ manufacturer: "Fortinet", assetType: "switch", model: MODEL }]);
    const status = nodeEl().querySelector(".fw-upload-status") as HTMLElement;
    expect(status.className).toContain("is-warn");
    expect(status.textContent).toContain("serial prefix S108FF");
  });
});
