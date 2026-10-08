/**
 * tests/unit/tagPickerUnlistedTags.test.ts — the shared tag picker keeps the
 * tags it has no registry row for (`_renderTagChips` / `getTagFieldValue` in
 * public/js/app.js).
 *
 * The picker used to render chips for registry rows only, and the edit form
 * saves exactly what getTagFieldValue reads off the rendered checkboxes — so
 * every tag an asset carried without a registry row (discovery's azurearc,
 * auto-discovered, arc-*, fortiswitch, entraid…) was silently stripped the
 * first time an operator edited the asset's tags. The 2026-10 report: "edit an
 * asset and change the tags, and it removes all the tags created from
 * discovery". `azure:` tags (Arc-owned) are hidden altogether — no chip, no
 * saved value; the server keeps the asset's own (withArcOwnedTags).
 *
 * Same eval-into-happy-dom idiom as tagPickerRegionTags.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
const APP_SRC = readFileSync(resolve(__dirname, "../../public/js/app.js"), "utf8");

const TAGS = [
  { name: "Production", category: "Environment", color: "#f87171" },
  { name: "azure:DefenderPlan=P1", category: "Azure Tags", color: "#4fc3f7" },
  { name: "azure:Env=Prod", category: "Azure Tags", color: "#4ade80" },
];

let win: InstanceType<typeof Window>;
let doc: Window["document"];
let catalog: { enforce: boolean; tags: typeof TAGS } | Error;

function exported<T>(name: string): T {
  const fn = (win as unknown as Record<string, unknown>)[name] ?? g[name];
  expect(typeof fn, `app.js no longer exposes ${name}`).toBe("function");
  return fn as T;
}

async function setup(): Promise<void> {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  g.fetch = () => Promise.reject(new Error("no network in this test"));
  g.showToast = () => {};
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.api = {
    serverSettings: {
      tagCatalog: async () => {
        if (catalog instanceof Error) throw catalog;
        return catalog;
      },
    },
  };
  doc.body.innerHTML = "<div id='host'></div>";
  try { (0, eval)(APP_SRC); } catch (_e) { /* app.js boot wiring touches page-specific DOM */ }
  await exported<() => Promise<void>>("_ensureTagCache")();
}

function render(selected: string[]): void {
  (doc.getElementById("host") as unknown as HTMLElement).innerHTML =
    exported<(s: string[]) => string>("tagFieldHTML")(selected);
}

const value = () => exported<() => string[]>("getTagFieldValue")().sort();
const chip = (name: string) =>
  doc.querySelector(`input[name="f-tags-cb"][value="${name}"]`) as unknown as HTMLInputElement | null;

describe("tag picker — tags with no registry row", () => {
  beforeEach(async () => {
    catalog = { enforce: false, tags: TAGS };
    await setup();
  });

  it("a save with no edits returns every tag the asset carried, bar the hidden azure: ones", () => {
    const tags = ["Production", "azurearc", "auto-discovered", "arc-hybrid"];
    render([...tags, "azure:DefenderPlan=P1"]);
    expect(value()).toEqual([...tags].sort());
  });

  it("renders the unlisted tags ticked under their own group", () => {
    render(["azurearc", "Production"]);
    const labels = Array.from(doc.querySelectorAll(".tag-picker-cat-label")).map((e) => e.textContent);
    expect(labels).toContain("Not in tag list");
    expect(chip("azurearc")!.checked).toBe(true);
  });

  it("adding a registry tag keeps the discovery tags", () => {
    render(["azurearc", "auto-discovered"]);
    chip("Production")!.checked = true;
    expect(value()).toEqual(["Production", "auto-discovered", "azurearc"]);
  });

  it("unticking an unlisted tag removes it — the operator still decides", () => {
    render(["azurearc", "auto-discovered"]);
    chip("azurearc")!.checked = false;
    expect(value()).toEqual(["auto-discovered"]);
  });

  it("no unlisted group when every tag has a registry row", () => {
    render(["Production"]);
    const labels = Array.from(doc.querySelectorAll(".tag-picker-cat-label")).map((e) => e.textContent);
    expect(labels).not.toContain("Not in tag list");
  });

  it("azure: tags get no chip — not from the registry, not from the asset", () => {
    render(["azure:DefenderPlan=P1", "azure:Unregistered=x", "Production"]);
    expect(chip("azure:DefenderPlan=P1")).toBeNull();
    expect(chip("azure:Env=Prod")).toBeNull();
    expect(chip("azure:Unregistered=x")).toBeNull();
    const labels = Array.from(doc.querySelectorAll(".tag-picker-cat-label")).map((e) => e.textContent);
    expect(labels).not.toContain("Azure Tags");
    expect(labels).not.toContain("Not in tag list");
    expect(value()).toEqual(["Production"]);
  });

  it("the read-only field shows no azure: pill", () => {
    (doc.getElementById("host") as unknown as HTMLElement).innerHTML =
      exported<(s: string[], o: object) => string>("tagFieldHTML")(["azure:Env=Prod", "Production"], { readOnly: true });
    const text = (doc.getElementById("host") as unknown as HTMLElement).textContent || "";
    expect(text).toContain("Production");
    expect(text).not.toContain("azure:");
  });
});

describe("tag picker — catalogue read failed", () => {
  it("still keeps the asset's tags instead of saving an empty list", async () => {
    catalog = new Error("403");
    await setup();
    render(["Production", "azurearc"]);
    expect(value()).toEqual(["Production", "azurearc"]);
  });
});
