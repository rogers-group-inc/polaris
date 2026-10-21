/**
 * tests/unit/assetPanelShotPdfDom.test.ts — the asset-details header's capture
 * buttons (public/js/assets.js + styles.css).
 *
 * The header carries two glyph buttons where Copy + Screenshot used to be: a
 * camera (copy the tab as a PNG) and a download tray (save the same capture as
 * a PDF). Both give way to the Events tab's Export dropdown, and the PDF path
 * slices a tall capture across letter pages rather than squashing it onto one.
 *
 * Functions are sliced out of assets.js by name and eval'd with the app-shell
 * globals stubbed — the approach of tests/unit/assetPanelHeaderActionsDom.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;

const assetsSrc = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8");
const assetsLines = assetsSrc.split(/\r?\n/);
const cssSrc = readFileSync(resolve(__dirname, "../../public/css/styles.css"), "utf8");

function fnSrc(name: string): string {
  const start = assetsLines.findIndex(
    (l) => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`),
  );
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

const FN_NAMES = ["_syncAssetFooterButtons", "_saveCaptureAsPdf", "_assetExportSubject"];
// eslint-disable-next-line no-new-func
new Function(FN_NAMES.map(fnSrc).join("\n") + "\n" + FN_NAMES.map((n) => `globalThis.${n} = ${n};`).join("\n"))();

describe("asset header capture buttons", () => {
  it("has no Copy button; Screenshot is the camera glyph and PDF the download glyph", () => {
    expect(assetsSrc).not.toContain('id="btn-asset-copy"');
    expect(assetsSrc).toMatch(/btn-glyph-camera[^"]*" id="btn-asset-screenshot"/);
    expect(assetsSrc).toMatch(/btn-glyph-download[^"]*" id="btn-asset-pdf"/);
    expect(cssSrc).toMatch(/\.btn-glyph-camera\s*\{\s*--btn-glyph:/);
  });

  describe("_syncAssetFooterButtons", () => {
    beforeEach(() => {
      document.body.innerHTML =
        '<div id="asset-view-tabs">' +
        '<button class="page-tab active" data-tab="general"></button>' +
        '<button class="page-tab" data-tab="events"></button>' +
        "</div>" +
        '<button id="btn-asset-screenshot"></button>' +
        '<button id="btn-asset-pdf"></button>' +
        '<span id="asset-export-wrap" style="display:none"></span>';
    });

    function shown(id: string) {
      return (document.getElementById(id) as HTMLElement).style.display !== "none";
    }

    it("shows camera + PDF off the Events tab", () => {
      g._syncAssetFooterButtons();
      expect([shown("btn-asset-screenshot"), shown("btn-asset-pdf"), shown("asset-export-wrap")]).toEqual([true, true, false]);
    });

    it("swaps both for the Export dropdown on the Events tab", () => {
      document.querySelector('[data-tab="general"]')!.classList.remove("active");
      document.querySelector('[data-tab="events"]')!.classList.add("active");
      g._syncAssetFooterButtons();
      expect([shown("btn-asset-screenshot"), shown("btn-asset-pdf"), shown("asset-export-wrap")]).toEqual([false, false, true]);
    });
  });

  describe("_saveCaptureAsPdf", () => {
    let docs: any[];
    beforeEach(() => {
      docs = [];
      g.showToast = vi.fn();
      g.window.jspdf = {
        jsPDF: function () {
          const doc = {
            pages: 1,
            images: [] as Array<{ y: number; h: number }>,
            fills: [] as number[][],
            saved: "",
            internal: { pageSize: { getWidth: () => 612, getHeight: () => 792 } },
            addPage() { doc.pages++; },
            setFillColor(r: number, gg: number, b: number) { doc.fills.push([r, gg, b]); },
            rect() {},
            addImage(_d: string, _f: string, _x: number, y: number, _w: number, h: number) { doc.images.push({ y, h }); },
            save(name: string) { doc.saved = name; },
          };
          docs.push(doc);
          return doc;
        },
      };
      // happy-dom has no 2D context; the slices only need to exist.
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
        drawImage() {},
        getImageData: () => ({ data: [10, 20, 30, 255] }),
      } as any);
      vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,");
    });

    function fakeCanvas(w: number, h: number) {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      return c;
    }

    it("fits a short capture on one page with the capture's own background", () => {
      g._saveCaptureAsPdf(fakeCanvas(1128, 400), { hostname: "core sw01" }, "General");
      const d = docs[0];
      expect(d.pages).toBe(1);
      expect(d.images).toHaveLength(1);
      expect(d.fills[0]).toEqual([10, 20, 30]);
      expect(d.saved).toMatch(/^asset-core-sw01-General-\d{4}-\d{2}-\d{2}\.pdf$/);
    });

    it("runs a tall capture across pages, each band within the printable height", () => {
      // 564pt printable width over 1128px → 0.5pt/px; 744pt printable height → 1488px bands.
      g._saveCaptureAsPdf(fakeCanvas(1128, 4000), { hostname: "fw1" }, "System");
      const d = docs[0];
      expect(d.pages).toBe(3);
      expect(d.images.map((i: any) => i.h)).toEqual([744, 744, 512]);
    });

    it("throws a readable error when jsPDF is not loaded", () => {
      g.window.jspdf = undefined;
      expect(() => g._saveCaptureAsPdf(fakeCanvas(10, 10), {}, "")).toThrow(/PDF library not loaded/);
    });
  });
});
