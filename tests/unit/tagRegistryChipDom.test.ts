/**
 * tests/unit/tagRegistryChipDom.test.ts — the Tags card's chips and the
 * "assets with this tag" slide-in (public/js/server-settings.js →
 * `_tagRegistryChipHTML` / `openTagAssetsPanel`).
 *
 *   - AN `azure:` CHIP OFFERS NO VERBS. The Arc sync owns those rows: the server
 *     refuses PUT / DELETE on them and prunes one once no asset carries it, so
 *     an Edit or Delete button would only ever produce a 409.
 *   - A CHIP OPENS THE SLIDE-IN only for a viewer holding `assets:read` (the
 *     gate on GET /assets/by-tag, which this tab does not imply).
 *   - THE PANEL lists what the endpoint returns, says when the list was capped,
 *     and drops a late answer for a tag it has already moved off.
 *
 * Loaded by eval into a happy-dom Window, the tagFilterDom idiom.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
let doc: Window["document"];
let win: InstanceType<typeof Window>;
let byTag: (tag: string) => Promise<unknown>;
let admin = true;

const chip = (t: Record<string, unknown>, canOpen: boolean): string =>
  (g._tagRegistryChipHTML as (t: unknown, c: boolean) => string)(t, canOpen);
const openPanel = (name: string): Promise<void> =>
  (g.openTagAssetsPanel as (n: string) => Promise<void>)(name);
const tick = () => new Promise((r) => setTimeout(r, 5));

beforeAll(() => {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  g.showToast = () => {};
  g.showConfirm = async () => true;
  g.isAdmin = () => admin;
  g.openModal = () => {};
  g.closeModal = () => {};
  g.tagHueStyle = (c: unknown) => (c ? "--hue: " + String(c) : "");
  g.raiseSlideover = () => {};
  g.wireSlideoverEscape = () => {};
  g.formatBytes = (b: unknown) => String(b);
  g.PolarisPrefs = { get: () => null, set: () => {} };
  g.api = { assets: { byTag: (tag: string) => byTag(tag) } };
  const ss = readFileSync(resolve(__dirname, "../../public/js/server-settings.js"), "utf8");
  // eslint-disable-next-line no-eval
  (0, eval)(ss);
});

beforeEach(() => {
  admin = true;
  doc.body.innerHTML = '<div id="host"></div>';
});

function render(html: string) {
  const host = doc.getElementById("host")!;
  host.innerHTML = html;
  return host.firstElementChild!;
}

describe("tag registry chip", () => {
  it("paints a coloured tag as a hue pill and leaves an uncoloured one plain", () => {
    const coloured = render(chip({ id: "t1", name: "prod", color: "#ff0000" }, false));
    expect(coloured.classList.contains("hue-pill")).toBe(true);
    expect(coloured.getAttribute("style")).toBe("--hue: #ff0000");
    const plain = render(chip({ id: "t1", name: "prod" }, false));
    expect(plain.classList.contains("hue-pill")).toBe(false);
    expect(plain.getAttribute("style")).toBeNull();
  });

  it("gives an operator tag Edit and Delete for an admin", () => {
    const el = render(chip({ id: "t1", name: "prod" }, true));
    expect(el.querySelector(".tag-chip-edit")).not.toBeNull();
    expect(el.querySelector(".tag-chip-delete")).not.toBeNull();
  });

  it("gives an azure: tag neither verb, whatever its casing, and says why", () => {
    for (const name of ["azure:env=prod", "Azure:Owner"]) {
      const el = render(chip({ id: "t2", name }, true));
      expect(el.querySelector(".tag-chip-edit")).toBeNull();
      expect(el.querySelector(".tag-chip-delete")).toBeNull();
      expect(el.getAttribute("title")).toContain("removes it once no asset carries it");
    }
  });

  it("gives a built-in Priority tag Edit (its filter) but never Delete, and says why (rule 136)", () => {
    const el = render(chip({ id: "t3", name: "Critical", color: "severity:critical", builtIn: true }, true));
    expect(el.querySelector(".tag-chip-edit")).not.toBeNull();
    expect(el.querySelector(".tag-chip-delete")).toBeNull();
    expect(el.getAttribute("title")).toContain("Built-in Priority tag");
  });

  it("is a button that opens the slide-in only when the viewer can read assets", () => {
    const open = render(chip({ id: "t1", name: "prod" }, true));
    expect(open.classList.contains("tag-chip-open")).toBe(true);
    expect(open.getAttribute("role")).toBe("button");
    expect(open.getAttribute("data-tag-name")).toBe("prod");
    const closed = render(chip({ id: "t1", name: "prod" }, false));
    expect(closed.classList.contains("tag-chip-open")).toBe(false);
    expect(closed.getAttribute("role")).toBeNull();
  });
});

describe("assets-with-this-tag slide-in", () => {
  it("lists the assets the endpoint returns and opens one through PolarisPanels", async () => {
    byTag = async () => ({
      total: 2,
      assets: [
        { id: "a1", hostname: "web-01", ipAddress: "10.0.0.1", assetType: "server", status: "active", monitorStatus: "up" },
        { id: "a2", hostname: null, ipAddress: "10.0.0.2", assetType: "other", status: "decommissioned", monitorStatus: null },
      ],
    });
    const opened: string[] = [];
    (win as unknown as Record<string, unknown>).PolarisPanels = { openAsset: (id: string) => opened.push(id) };
    await openPanel("prod");
    expect(doc.getElementById("tag-assets-title")!.textContent).toBe("prod");
    expect(doc.getElementById("tag-assets-meta")!.textContent).toContain("2 assets with this tag");
    const rows = doc.querySelectorAll("#tag-assets-body [data-asset-id]");
    expect(rows.length).toBe(2);
    expect(rows[1].textContent).toContain("10.0.0.2");
    expect(rows[1].textContent).toContain("decommissioned");
    (rows[0] as unknown as { click: () => void }).click();
    expect(opened).toEqual(["a1"]);
  });

  it("says when the list was capped", async () => {
    byTag = async () => ({ total: 1500, assets: [{ id: "a1", hostname: "h", assetType: "server", status: "active" }] });
    await openPanel("big");
    expect(doc.getElementById("tag-assets-body")!.textContent).toContain("Showing the first 1 of 1500");
  });

  it("shows the empty state for a tag nothing carries", async () => {
    byTag = async () => ({ total: 0, assets: [] });
    await openPanel("unused");
    expect(doc.getElementById("tag-assets-body")!.textContent).toContain("No assets carry this tag");
  });

  it("drops a late answer for a tag the panel has already moved off", async () => {
    let releaseSlow: (v: unknown) => void = () => {};
    byTag = (tag) => tag === "slow"
      ? new Promise((r) => { releaseSlow = r; })
      : Promise.resolve({ total: 1, assets: [{ id: "f1", hostname: "fast-host", assetType: "server", status: "active" }] });
    const slow = openPanel("slow");
    await openPanel("fast");
    releaseSlow({ total: 1, assets: [{ id: "s1", hostname: "slow-host", assetType: "server", status: "active" }] });
    await slow;
    await tick();
    expect(doc.getElementById("tag-assets-title")!.textContent).toBe("fast");
    expect(doc.getElementById("tag-assets-body")!.textContent).toContain("fast-host");
    expect(doc.getElementById("tag-assets-body")!.textContent).not.toContain("slow-host");
  });
});
