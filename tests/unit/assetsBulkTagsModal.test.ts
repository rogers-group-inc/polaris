/**
 * tests/unit/assetsBulkTagsModal.test.ts — the Assets bulk bar's Tags modal
 * (openBulkTagsModal): the chosen mode and the picked tags reach
 * POST /assets/bulk-tags for every selected id, Replace asks first, and an
 * empty Add never leaves the browser. Built on the REAL shared tag picker from
 * app.js (tagFieldHTML / wireTagPicker / getTagFieldValue), so a change to the
 * picker's checkbox name or ids that would silently send no tags fails here.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const g = globalThis as Record<string, unknown>;

type BulkCall = { ids: string[]; mode: string; tags: string[] };
const calls: BulkCall[] = [];
let confirmAnswer = true;
let confirms = 0;
let toasts: { msg: string; kind?: string }[] = [];

let win: Window;
let openBulkTagsModal: () => Promise<void>;
let selected: Set<string>;

/** Slice one top-level function (sync or async) out of a source file. CRLF-safe. */
function extractFunction(src: string, name: string): string {
  const re = new RegExp("\\n(async )?function " + name + "\\(");
  const m = re.exec(src);
  if (!m) throw new Error("function not found: " + name);
  const start = m.index + 1;
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end + 2);
}

function extractVar(src: string, name: string): string {
  const start = src.indexOf("\nvar " + name + " ");
  if (start < 0) throw new Error("var not found: " + name);
  const end = src.indexOf(";\n", start);
  return src.slice(start + 1, end + 2);
}

beforeAll(() => {
  win = new Window();
  g.window = win;
  g.document = win.document;
  g.escapeHtml = (s: unknown) => String(s ?? "");
  g.randomTagColor = () => "#4fc3f7";
  g.permAtLeast = () => false; // no registry create row
  g.showToast = (msg: string, kind?: string) => { toasts.push({ msg, kind }); };
  g.showConfirm = async () => { confirms++; return confirmAnswer; };
  g.closeModal = () => { win.document.body.innerHTML = ""; };
  g.openModal = (_title: string, body: string, footer: string) => {
    win.document.body.innerHTML = body + footer;
  };
  g.loadAssets = () => {};
  g.api = {
    serverSettings: {
      tagCatalog: async () => ({
        enforce: false,
        tags: [
          { id: "t1", name: "lab", category: "General", color: "#111111" },
          { id: "t2", name: "prod", category: "General", color: "#222222" },
        ],
      }),
    },
    assets: {
      bulkTags: async (ids: string[], mode: string, tags: string[]) => {
        calls.push({ ids: ids.slice(), mode, tags: tags.slice() });
        return { updated: ids.length, unchanged: 0, notFound: [], tags };
      },
    },
  };

  const appSrc = readFileSync(resolve(__dirname, "../../public/js/app.js"), "utf8").replace(/\r\n/g, "\n");
  const assetsSrc = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").replace(/\r\n/g, "\n");
  const body = [
    extractVar(appSrc, "_tagCache"),
    extractVar(appSrc, "REGION_TAG_CATEGORY"),
    ...["_ensureTagCache", "_tagChipStyle", "_canCreateRegistryTags", "_renderTagChips",
        "tagFieldHTML", "getTagFieldValue", "_wireChipListeners", "wireTagPicker"]
      .map((n) => extractFunction(appSrc, n)),
    "var _assetsSelected = new Set();",
    extractVar(assetsSrc, "BULK_TAG_MODE_HINTS"),
    extractFunction(assetsSrc, "openBulkTagsModal"),
  ].join("\n");
  const exported = new Function(body + "\nreturn { openBulkTagsModal: openBulkTagsModal, sel: _assetsSelected };")() as
    { openBulkTagsModal: () => Promise<void>; sel: Set<string> };
  openBulkTagsModal = exported.openBulkTagsModal;
  selected = exported.sel;
});

beforeEach(() => {
  calls.length = 0;
  confirms = 0;
  confirmAnswer = true;
  toasts = [];
  win.document.body.innerHTML = "";
  selected.clear();
  selected.add("a1");
  selected.add("a2");
});

const el = (sel: string) => win.document.querySelector(sel) as unknown as
  { click: () => void; checked: boolean; textContent: string; dispatchEvent: (e: unknown) => void } | null;

function pick(tag: string) {
  const cb = el('input[name="f-tags-cb"][value="' + tag + '"]')!;
  cb.checked = true;
}
function chooseMode(mode: string) {
  const r = el('input[name="bulk-tags-mode"][value="' + mode + '"]')!;
  r.checked = true;
  r.dispatchEvent(new win.Event("change"));
}
async function submit() {
  el("#bulk-tags-go")!.click();
  await new Promise((r) => setTimeout(r, 0));
}

describe("openBulkTagsModal", () => {
  it("defaults to Add and sends the picked tags for every selected id", async () => {
    await openBulkTagsModal();
    expect(el("#bulk-tags-go")!.textContent).toBe("Add Tags");
    pick("lab");
    await submit();
    expect(calls).toEqual([{ ids: ["a1", "a2"], mode: "add", tags: ["lab"] }]);
    expect(confirms).toBe(0);
  });

  it("Remove sends mode remove", async () => {
    await openBulkTagsModal();
    chooseMode("remove");
    expect(el("#bulk-tags-go")!.textContent).toBe("Remove Tags");
    pick("prod");
    await submit();
    expect(calls[0].mode).toBe("remove");
    expect(calls[0].tags).toEqual(["prod"]);
  });

  it("Replace confirms first and sends nothing when declined", async () => {
    await openBulkTagsModal();
    chooseMode("replace");
    pick("lab");
    confirmAnswer = false;
    await submit();
    expect(confirms).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("Replace with no tags is allowed (clears) after confirming", async () => {
    await openBulkTagsModal();
    chooseMode("replace");
    await submit();
    expect(calls).toEqual([{ ids: ["a1", "a2"], mode: "replace", tags: [] }]);
  });

  it("Add with nothing picked never calls the API", async () => {
    await openBulkTagsModal();
    await submit();
    expect(calls).toHaveLength(0);
    expect(toasts[0].kind).toBe("error");
  });
});
