/**
 * tests/unit/slideoverBuilderDom.test.ts — app.js's slide-over factory
 * (buildSlideover, CQ-F025).
 *
 * Thirteen slide-overs used to hand-roll the same skeleton (overlay > panel >
 * resize handle, header with title + close, meta, body, footer) and the same
 * wiring (backdrop click, close button, Escape, resize). They now build it
 * through buildSlideover. Pinned here:
 *
 *  - each migrated panel's ensure function still builds the EXACT markup it
 *    built before the factory (GOLDENS were captured from the pre-change code:
 *    other code and tests find these elements by id, and CSS by class/order);
 *  - backdrop click, the close button and Escape each close it; a click inside
 *    the panel does not;
 *  - open() raises the overlay over a later slide-over and reveals it;
 *  - the default close runs onClose; a caller's own close replaces it;
 *  - the resize key reaches initSlideoverResize with the panel.
 *
 * app.js and the panel files are browser scripts with no module boundary, so
 * the functions under test are sliced out by name and eval'd into a happy-dom
 * Window — the approach of tests/unit/panelsAnywhereDom.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const g = globalThis as Record<string, any>;

/** One `function name(...) {...}` declaration from a public/js file, by brace matching. */
function fnSrc(file: string, name: string): string {
  const src = readFileSync(resolve(__dirname, "../../public/js", file), "utf8");
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${file}: ${name} not found`);
  let depth = 0;
  let i = src.indexOf("{", start);
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

const APP_FNS = ["buildSlideover", "revealOverlay", "raiseSlideover", "isTopmostSlideover", "wireSlideoverEscape"];
const APP_SRC = APP_FNS.map((n) => fnSrc("app.js", n)).join("\n") + "\n" +
  APP_FNS.map((n) => `globalThis.${n} = ${n};`).join("\n");

/** The markup each panel built BEFORE buildSlideover, captured from the pre-change code. */
const GOLDENS: Record<string, { id: string; className: string; innerHTML: string }> = {
  "agent-build.js:_ensureInstalledAgentsPanelDOM": {
    "id": "agent-list-panel-overlay",
    "className": "slideover-overlay",
    "innerHTML": "<div class=\"slideover\" id=\"agent-list-panel\"><div class=\"slideover-resize-handle\"></div><div class=\"slideover-header\"><div class=\"slideover-header-top\"><h3>Installed Polaris Agents</h3><button class=\"btn-icon\" id=\"agent-list-panel-close\" title=\"Close\">×</button></div><div class=\"slideover-meta\" id=\"agent-list-panel-meta\"></div></div><div class=\"slideover-body\" id=\"agent-list-panel-body\" style=\"padding:1rem\"><p class=\"empty-state\">Loading...</p></div></div>"
  },
  "assets-compare.js:_ensureComparePanelDOM": {
    "id": "compare-panel-overlay",
    "className": "slideover-overlay",
    "innerHTML": "<div class=\"slideover\" id=\"compare-panel\"><div class=\"slideover-resize-handle\"></div><div class=\"slideover-header\"><div class=\"slideover-header-top\"><h3 id=\"compare-panel-title\">Compare Assets</h3><button class=\"btn-icon\" id=\"compare-panel-close\" title=\"Close\">×</button></div><div class=\"slideover-meta\" id=\"compare-panel-meta\"></div></div><div class=\"slideover-body\" id=\"compare-panel-body\"></div><div class=\"slideover-footer\" id=\"compare-panel-footer\"><button class=\"btn btn-sm btn-secondary\" id=\"cmp-screenshot-btn\">Screenshot</button><button class=\"btn btn-sm btn-secondary\" id=\"cmp-pdf-btn\">Export PDF</button><button class=\"btn btn-sm btn-secondary\" id=\"cmp-close-btn\" style=\"margin-left:auto\">Close</button></div></div>"
  },
  "assets.js:_ensureLeasePanelDOM": {
    "id": "lease-panel-overlay",
    "className": "slideover-overlay",
    "innerHTML": "<div class=\"slideover\" id=\"lease-panel\"><div class=\"slideover-resize-handle\"></div><div class=\"slideover-header\"><div class=\"slideover-header-top\"><h3 id=\"lease-panel-title\">Lease</h3><button class=\"btn-icon\" id=\"lease-panel-close\" title=\"Close\">×</button></div><div class=\"slideover-meta\" id=\"lease-panel-meta\"></div></div><div class=\"slideover-body\" id=\"lease-panel-body\"><p class=\"empty-state\" style=\"padding:1rem 1.25rem\">Loading…</p></div><div class=\"slideover-footer\" id=\"lease-panel-footer\"></div></div>"
  },
  "assets.js:_ensureSensorPanelDOM": {
    "id": "sensor-panel-overlay",
    "className": "slideover-overlay slideover-nested",
    "innerHTML": "<div class=\"slideover\" id=\"sensor-panel\" style=\"z-index:1100\"><div class=\"slideover-resize-handle\"></div><div class=\"slideover-header\"><div class=\"slideover-header-top\"><h3 id=\"sensor-panel-title\">Sensor</h3><button class=\"btn-icon\" id=\"sensor-panel-close\" title=\"Close\">×</button></div><div class=\"slideover-meta\" id=\"sensor-panel-meta\"></div></div><div class=\"slideover-body\" id=\"sensor-panel-body\"><p class=\"empty-state\" style=\"padding:1rem 1.25rem\">Loading…</p></div><div class=\"slideover-footer\" id=\"sensor-panel-footer\"></div></div>"
  },
  "assets.js:_ensureIpsecPanelDOM": {
    "id": "ipsec-panel-overlay",
    "className": "slideover-overlay slideover-nested",
    "innerHTML": "<div class=\"slideover\" id=\"ipsec-panel\" style=\"z-index:1100\"><div class=\"slideover-resize-handle\"></div><div class=\"slideover-header\"><div class=\"slideover-header-top\"><h3 id=\"ipsec-panel-title\">IPsec tunnel</h3><button class=\"btn-icon\" id=\"ipsec-panel-close\" title=\"Close\">×</button></div><div class=\"slideover-meta\" id=\"ipsec-panel-meta\"></div></div><div class=\"slideover-body\" id=\"ipsec-panel-body\"><p class=\"empty-state\" style=\"padding:1rem 1.25rem\">Loading…</p></div><div class=\"slideover-footer\" id=\"ipsec-panel-footer\"></div></div>"
  },
  "assets.js:_ensureStoragePanelDOM": {
    "id": "storage-panel-overlay",
    "className": "slideover-overlay slideover-nested",
    "innerHTML": "<div class=\"slideover\" id=\"storage-panel\" style=\"z-index:1100\"><div class=\"slideover-resize-handle\"></div><div class=\"slideover-header\"><div class=\"slideover-header-top\"><h3 id=\"storage-panel-title\">Storage</h3><button class=\"btn-icon\" id=\"storage-panel-close\" title=\"Close\">×</button></div><div class=\"slideover-meta\" id=\"storage-panel-meta\"></div></div><div class=\"slideover-body\" id=\"storage-panel-body\"><p class=\"empty-state\" style=\"padding:1rem 1.25rem\">Loading…</p></div><div class=\"slideover-footer\" id=\"storage-panel-footer\"></div></div>"
  },
  "assets.js:_ensureProcPanelDOM": {
    "id": "proc-panel-overlay",
    "className": "slideover-overlay slideover-nested",
    "innerHTML": "<div class=\"slideover\" id=\"proc-panel\" style=\"z-index:1100\"><div class=\"slideover-resize-handle\"></div><div class=\"slideover-header\"><div class=\"slideover-header-top\"><h3 id=\"proc-panel-title\">Process</h3><button class=\"btn-icon\" id=\"proc-panel-close\" title=\"Close\">×</button></div><div class=\"slideover-meta\" id=\"proc-panel-meta\"></div></div><div class=\"slideover-body\" id=\"proc-panel-body\"><p class=\"empty-state\" style=\"padding:1rem 1.25rem\">Loading…</p></div><div class=\"slideover-footer\" id=\"proc-panel-footer\"></div></div>"
  },
  "block-panel.js:_ensureBlockPanelDOM": {
    "id": "block-panel-overlay",
    "className": "slideover-overlay",
    "innerHTML": "<div class=\"slideover\" id=\"block-panel\"><div class=\"slideover-resize-handle\"></div><div class=\"slideover-header\"><div class=\"slideover-header-top\"><h3 id=\"block-panel-title\"></h3><button class=\"btn-icon\" id=\"block-panel-close\" title=\"Close\">×</button></div><div class=\"slideover-meta\" id=\"block-panel-meta\"></div></div><div class=\"slideover-body\" id=\"block-panel-body\"><p class=\"empty-state\">Loading...</p></div><div class=\"slideover-footer\" id=\"block-panel-footer\"></div></div>"
  },
  "ip-panel.js:_ensurePanelDOM": {
    "id": "ip-panel-overlay",
    "className": "slideover-overlay",
    "innerHTML": "<div class=\"slideover\" id=\"ip-panel\"><div class=\"slideover-resize-handle\"></div><div class=\"slideover-header\"><div class=\"slideover-header-top\"><h3 id=\"ip-panel-title\"></h3><button class=\"btn-icon\" id=\"ip-panel-close\" title=\"Close\">×</button></div><div class=\"slideover-meta\" id=\"ip-panel-meta\"></div></div><div class=\"slideover-body\" id=\"ip-panel-body\"><p class=\"empty-state\">Loading...</p></div><div class=\"slideover-footer\" id=\"ip-panel-footer\"></div></div>"
  },
  "pinned-tls-certs.js:ensurePanel": {
    "id": "tls-pins-overlay",
    "className": "slideover-overlay",
    "innerHTML": "<div class=\"slideover\" id=\"tls-pins-panel\" role=\"dialog\" aria-labelledby=\"tls-pins-title\" tabindex=\"-1\"><div class=\"slideover-resize-handle\"></div><div class=\"slideover-header\"><div class=\"slideover-header-top\"><div class=\"slideover-header-lead\"><h3 id=\"tls-pins-title\">Pinned server identities</h3></div><button class=\"btn-icon\" id=\"tls-pins-close\" title=\"Close\" aria-label=\"Close pinned server identities\">×</button></div><div class=\"slideover-meta\" id=\"tls-pins-meta\"></div><div id=\"tls-pins-filters\" style=\"display:flex;gap:6px;margin-top:0.6rem\"><input type=\"text\" data-pin-filter=\"q\" placeholder=\"Filter by IP, hostname, thumbprint, subject or key type\" aria-label=\"Filter pinned identities\" autocomplete=\"off\" spellcheck=\"false\" style=\"flex:1 1 auto;min-width:0;padding:0.3rem 0.55rem;font-size:0.8rem\"><select data-pin-filter=\"kind\" aria-label=\"Kind of pin\" style=\"flex:0 0 auto;padding:0.3rem 0.55rem;font-size:0.8rem\"><option value=\"\">All kinds</option><option value=\"tls\">TLS certificates</option><option value=\"ssh\">SSH host keys</option><option value=\"archived\">Archived (decommissioned)</option></select></div></div><div class=\"slideover-body\" id=\"tls-pins-body\"><p class=\"empty-state\" style=\"padding:1rem 1.25rem\">Loading...</p></div><div class=\"slideover-footer\"><button type=\"button\" class=\"btn btn-secondary\" id=\"tls-pins-done\">Close</button></div></div>"
  },
  "server-settings-firmware.js:ensureAssetListDOM": {
    "id": "fw-assets-overlay",
    "className": "slideover-overlay",
    "innerHTML": "<div class=\"slideover\" id=\"fw-assets-panel\" role=\"dialog\" aria-labelledby=\"fw-assets-title\" tabindex=\"-1\"><div class=\"slideover-resize-handle\"></div><div class=\"slideover-header\"><div class=\"slideover-header-top\"><h3 id=\"fw-assets-title\">Devices</h3><button class=\"btn-icon\" id=\"fw-assets-close\" aria-label=\"Close\">×</button></div><div class=\"slideover-meta\" id=\"fw-assets-meta\"></div></div><div class=\"slideover-body\"><div style=\"padding:1rem 1.25rem\"><input type=\"search\" id=\"fw-assets-filter\" placeholder=\"Filter by hostname, IP, model, serial or version\" style=\"width:100%;margin-bottom:0.75rem\"><div id=\"fw-assets-body\"></div></div></div></div>"
  },
  "server-settings.js:_ensureTagAssetsPanelDOM": {
    "id": "tag-assets-overlay",
    "className": "slideover-overlay",
    "innerHTML": "<div class=\"slideover\" id=\"tag-assets-panel\" role=\"dialog\" aria-labelledby=\"tag-assets-title\" tabindex=\"-1\"><div class=\"slideover-resize-handle\"></div><div class=\"slideover-header\"><div class=\"slideover-header-top\"><h3 id=\"tag-assets-title\">Tag</h3><button class=\"btn-icon\" id=\"tag-assets-close\" title=\"Close\">×</button></div><div class=\"slideover-meta\" id=\"tag-assets-meta\"></div></div><div class=\"slideover-body\" id=\"tag-assets-body\"></div></div>"
  },
  "server-settings.js:_ensureCredUsagePanelDOM": {
    "id": "cred-usage-overlay",
    "className": "slideover-overlay",
    "innerHTML": "<div class=\"slideover\" id=\"cred-usage-panel\"><div class=\"slideover-resize-handle\"></div><div class=\"slideover-header\"><div class=\"slideover-header-top\"><h3 id=\"cred-usage-title\">Credential usage</h3><button class=\"btn-icon\" id=\"cred-usage-close\">×</button></div><div class=\"slideover-meta\" id=\"cred-usage-meta\"></div></div><div class=\"slideover-body\" id=\"cred-usage-body\"></div></div>"
  }
};

/** Closure names the ensure functions reach as free variables, stubbed. */
const PANEL_FREE_VARS = [
  "OVERLAY_ID", "close", "onBodyClick", "renderPanel", "lastData", "renderAssetList", "_listRows",
  "closeInstalledAgentsPanel", "closeComparePanel", "closeLeasePanel", "closeSensorPanel", "closeIpsecPanel",
  "closeStoragePanel", "_closeProcPanel", "closeBlockPanel", "closeIpPanel", "closeAssetList",
  "closeTagAssetsPanel", "closeCredUsagePanel", "_cmpScreenshot", "_cmpExportPdf",
];

let win: Window;

beforeEach(() => {
  win = new Window({ url: "https://polaris.test/" });
  g.window = win;
  g.document = win.document;
  g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  g.initSlideoverResize = vi.fn();
  (0, eval)(APP_SRC);
});

describe("migrated panels build the markup they built before", () => {
  for (const [key, golden] of Object.entries(GOLDENS)) {
    const [file, fn] = key.split(":");
    it(`${file} ${fn}`, () => {
      const stubs: Record<string, unknown> = { OVERLAY_ID: "tls-pins-overlay", lastData: {}, _listRows: [] };
      const args = PANEL_FREE_VARS.map((n) => (n in stubs ? stubs[n] : () => {}));
      new Function(...PANEL_FREE_VARS, fnSrc(file, fn) + `\nreturn ${fn}();`)(...args);
      const overlay = g.document.getElementById(golden.id);
      expect(overlay, `${key} built no #${golden.id}`).toBeTruthy();
      expect(overlay.className).toBe(golden.className);
      expect(overlay.innerHTML).toBe(golden.innerHTML);
    });
  }
});

describe("buildSlideover", () => {
  function build(extra: Record<string, unknown> = {}) {
    return g.buildSlideover({ id: "demo-panel", title: "Demo", footer: true, resizeKey: "polaris.panel.width.demo", ...extra });
  }

  it("builds the canonical skeleton with ids from the prefix", () => {
    const h = build({ dialog: true });
    expect(h.overlay.id).toBe("demo-panel-overlay");
    expect(h.overlay.className).toBe("slideover-overlay");
    expect(h.overlay.parentNode).toBe(g.document.body);
    expect(h.panel.id).toBe("demo-panel");
    expect(h.panel.getAttribute("role")).toBe("dialog");
    expect(h.panel.getAttribute("aria-labelledby")).toBe("demo-panel-title");
    expect(h.panel.getAttribute("tabindex")).toBe("-1");
    expect([...h.panel.children].map((c: Element) => c.className))
      .toEqual(["slideover-resize-handle", "slideover-header", "slideover-body", "slideover-footer"]);
    expect(h.body.id).toBe("demo-panel-body");
    expect(h.footer.id).toBe("demo-panel-footer");
    expect(g.document.getElementById("demo-panel-title").textContent).toBe("Demo");
    expect(g.document.getElementById("demo-panel-meta")).toBeTruthy();
    expect(g.initSlideoverResize).toHaveBeenCalledWith(h.panel, "polaris.panel.width.demo");
  });

  it("omits what the caller nulls out, and the footer unless asked", () => {
    const h = g.buildSlideover({ id: "bare", titleId: null, bodyId: null, closeTitle: null, meta: false });
    expect(h.panel.querySelector("h3").hasAttribute("id")).toBe(false);
    expect(h.body.hasAttribute("id")).toBe(false);
    expect(h.panel.querySelector(".btn-icon").hasAttribute("title")).toBe(false);
    expect(h.panel.querySelector(".slideover-meta")).toBeNull();
    expect(h.footer).toBeNull();
    expect(g.initSlideoverResize).not.toHaveBeenCalled();
  });

  it("closes on a backdrop click, the close button and Escape — not on a click inside the panel", () => {
    const onClose = vi.fn();
    const h = build({ onClose });
    const isOpen = () => h.overlay.classList.contains("open");

    h.overlay.classList.add("open");
    h.body.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    expect(isOpen()).toBe(true);
    h.overlay.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    expect(isOpen()).toBe(false);

    h.overlay.classList.add("open");
    (g.document.getElementById("demo-panel-close") as any).click();
    expect(isOpen()).toBe(false);

    h.overlay.classList.add("open");
    g.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("a caller's own close replaces the default", () => {
    const close = vi.fn();
    const h = build({ close });
    h.overlay.classList.add("open");
    h.overlay.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    (g.document.getElementById("demo-panel-close") as any).click();
    expect(close).toHaveBeenCalledTimes(2);
    expect(h.close).toBe(close);
    expect(h.overlay.classList.contains("open")).toBe(true);
  });

  it("open() raises the overlay past a later slide-over and reveals it, then runs after()", async () => {
    const h = build();
    const later = g.buildSlideover({ id: "later-panel" });
    later.overlay.classList.add("open");
    const after = vi.fn();
    h.open(after);
    expect(g.document.body.lastElementChild).toBe(h.overlay);
    await new Promise((r) => setTimeout(r, 60));
    expect(h.overlay.classList.contains("open")).toBe(true);
    expect(after).toHaveBeenCalledTimes(1);
    expect(g.isTopmostSlideover(h.overlay)).toBe(true);

    // Escape now closes the top one only.
    g.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(h.overlay.classList.contains("open")).toBe(false);
    expect(later.overlay.classList.contains("open")).toBe(true);
  });
});
