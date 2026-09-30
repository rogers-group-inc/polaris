/**
 * tests/unit/usersTagPicker.test.ts — the Users page tag picker
 * (`otherTagsPickerHtml` / `collectOtherTags` in public/js/users.js).
 *
 * The picker used to be a bare chip input with no registry behind it; it now
 * renders the whole `Tag` catalogue as selectable pills and only falls back to
 * chips for names the registry doesn't carry. Three things that must hold, all
 * of which an operator reads as "my tag scope was wiped" when they don't:
 *
 *  - CASE. Everything that actually matches a tag compares case-insensitively
 *    (`selSet` here, `normalizePermissions`-adjacent tag normalization in
 *    utils/tagNormalize.ts), so a user tagged "pci" against a registry tag
 *    named "PCI" must come out selected — not listed as an unregistered chip
 *    AND a deselected pill at the same time.
 *  - AN UNREADABLE CATALOGUE. `GET /server-settings/tags` needs
 *    serverSettingsSystem=read and a user administrator may not hold it.
 *    Absent a catalogue there is no evidence about any tag, so every
 *    assignment stays a chip under a note saying why — never "not in the
 *    registry".
 *  - COLLECTION. `collectOtherTags` is what a save writes, and it now reads
 *    THREE places (chips, selected pills, and text still sitting in the
 *    input). Missing any one of them silently drops a scope the admin never
 *    touched.
 *
 * users.js is a classic browser script; an indirect eval puts its top-level
 * declarations on globalThis — the usersRegionPicker.test.ts idiom.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, any>;
let otherTagsPickerHtml: (idPrefix: string, selected: string[]) => string;
let collectOtherTags: (idPrefix: string) => string[];
let addOtherTagChips: (input: unknown) => Promise<void>;
let userTagPillsHtml: (u: { regionTags?: string[]; otherTags?: string[] }) => string;
let splitUserTagScope: (tags: string[]) => { regionTags: string[]; otherTags: string[] };

interface TagRow { name: string; color: string; category: string }

const CATALOG: TagRow[] = [
  { name: "PCI", color: "#ef5350", category: "Compliance" },
  { name: "Critical", color: "#4fc3f7", category: "General" },
];

/** Point users.js at a catalogue, or at the unreadable-catalogue state. */
function setCatalog(loaded: boolean, rows: TagRow[] = []) {
  g._tagCatalogLoaded = loaded;
  g._tagList = rows.map((r) => r.name);
  g._tagByName = {};
  rows.forEach((r) => { g._tagByName[r.name.toLowerCase()] = r; });
}

/** Render into a live document so collectOtherTags can query it by id. */
function mount(selected: string[]): void {
  g.document.body.innerHTML = otherTagsPickerHtml("f-tags", selected);
}

/** The chip row above the grid: names the picker is NOT backing with a pill. */
function chips(): string[] {
  return Array.from(g.document.querySelectorAll(".other-tag-chip")).map((el: any) =>
    (el.getAttribute("data-tag") || "").trim(),
  );
}

/** Pills, with their selected state — what an operator sees pre-ticked. */
function pills(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  Array.from(g.document.querySelectorAll(".other-tag-pill")).forEach((el: any) => {
    out[el.getAttribute("data-tag")] = el.getAttribute("data-selected") === "1";
  });
  return out;
}

function chipNote(): string {
  const n = g.document.querySelector(".other-tags-chip-note") as any;
  if (!n) return "";
  // Hidden note = "nothing unregistered", which is not a claim about anything.
  if ((n.getAttribute("style") || "").includes("display:none")) return "";
  return (n.textContent || "").trim();
}

beforeAll(() => {
  const win = new Window();
  g.window = win;
  g.document = win.document;
  g.PolarisPrefs = { save: () => {}, load: () => null };
  g.escapeHtml = (s: unknown) => String(s ?? "");
  g.showToast = () => {};
  g.showConfirm = async () => false;
  g.permAtLeast = () => true;
  g.api = { serverSettings: { listTags: async () => CATALOG, createTag: async (b: any) => ({ ...b, color: "#9e9e9e", category: "General" }) } };
  g.currentUsername = "alice";
  g.formatDate = () => "";
  g.regionPillsHtml = () => "";
  g.TableSF = function () {};
  g.setupColumnLayout = () => null;
  g.userReady = Promise.resolve();
  g.window.PolarisRegionPills = {
    isLoaded: () => false,
    load: async () => ({}),
    names: () => [],
    colorFor: () => "#9e9e9e",
    rgbTriplet: () => "158, 158, 158",
    html: (names: string[]) => names.join(""),
  };

  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/users.js"), "utf8"));
  otherTagsPickerHtml = g.otherTagsPickerHtml as typeof otherTagsPickerHtml;
  collectOtherTags = g.collectOtherTags as typeof collectOtherTags;
  addOtherTagChips = g.addOtherTagChips as typeof addOtherTagChips;
  userTagPillsHtml = g.userTagPillsHtml as typeof userTagPillsHtml;
  splitUserTagScope = g._splitUserTagScope as typeof splitUserTagScope;
  expect(typeof otherTagsPickerHtml, "users.js no longer declares otherTagsPickerHtml").toBe("function");
  expect(typeof collectOtherTags, "users.js no longer declares collectOtherTags").toBe("function");
  expect(typeof addOtherTagChips, "users.js no longer declares addOtherTagChips").toBe("function");
  expect(typeof userTagPillsHtml, "users.js no longer declares userTagPillsHtml").toBe("function");
  expect(typeof splitUserTagScope, "users.js no longer declares _splitUserTagScope").toBe("function");
});

beforeEach(() => {
  setCatalog(true, CATALOG);
  g.document.body.innerHTML = "";
});

describe("otherTagsPickerHtml", () => {
  it("renders every registry tag as a pill, selecting the assigned ones", () => {
    mount(["PCI"]);
    expect(pills()).toEqual({ PCI: true, Critical: false });
    expect(chips()).toEqual([]);
    expect(chipNote()).toBe("");
  });

  it("selects a pill on a CASE difference instead of calling it unregistered", () => {
    mount(["pci"]);
    expect(pills().PCI).toBe(true);
    expect(chips()).toEqual([]);
  });

  it("keeps a tag the registry doesn't carry as a removable chip", () => {
    mount(["PCI", "legacy-tag"]);
    expect(chips()).toEqual(["legacy-tag"]);
    expect(pills().PCI).toBe(true);
    expect(chipNote()).toContain("outside the tag registry");
  });

  it("makes no unregistered claim when the catalogue could not be read", () => {
    // serverSettingsSystem=read is not universal; an empty catalogue we never
    // fetched is not evidence that a tag is gone.
    setCatalog(false);
    mount(["PCI", "legacy-tag"]);
    expect(chips().sort()).toEqual(["PCI", "legacy-tag"]);
    expect(pills()).toEqual({});
    expect(chipNote()).toContain("could not be read");
  });

  it("groups pills by the registry's categories", () => {
    mount([]);
    const cats = Array.from(g.document.querySelectorAll(".other-tags-cat")).map((el: any) =>
      el.getAttribute("data-category"),
    );
    expect(cats.sort()).toEqual(["Compliance", "General"]);
  });
});

describe("collectOtherTags", () => {
  it("collects selected pills and chips, and nothing deselected", () => {
    mount(["PCI", "legacy-tag"]);
    expect(collectOtherTags("f-tags").sort()).toEqual(["PCI", "legacy-tag"]);
  });

  it("collects an assignment the catalogue could not confirm", () => {
    setCatalog(false);
    mount(["PCI", "legacy-tag"]);
    expect(collectOtherTags("f-tags").sort()).toEqual(["PCI", "legacy-tag"]);
  });

  it("collects text still sitting uncommitted in the input", () => {
    // Save can be clicked while a typed tag has not been committed to a chip;
    // dropping it would look like the click was ignored.
    mount([]);
    (g.document.querySelector(".other-tags-input") as any).value = "fresh, another";
    expect(collectOtherTags("f-tags").sort()).toEqual(["another", "fresh"]);
  });

  it("de-duplicates case-insensitively across pill, chip and input", () => {
    mount(["PCI"]);
    (g.document.querySelector(".other-tags-input") as any).value = "pci";
    expect(collectOtherTags("f-tags")).toEqual(["PCI"]);
  });

  it("returns [] for a picker that isn't on the page", () => {
    expect(collectOtherTags("f-nope")).toEqual([]);
  });
});

/**
 * The Category box beside the tag input.
 *
 * Creating a registry row from this picker used to file every tag under the
 * server's "General" default with no way to say otherwise, so a tag added while
 * assigning scope landed in a category nobody chose and had to be moved on the
 * registry page afterwards.
 */
describe("tag creation category", () => {
  it("offers a Category box, defaulted to General, to a caller who may create tags", () => {
    mount([]);
    const box = g.document.querySelector(".other-tags-category") as any;
    expect(box).toBeTruthy();
    expect(box.value).toBe("General");
    // The existing categories are suggestions, not a closed list -- a new one
    // is typed straight in.
    const opts = Array.from(g.document.querySelectorAll("datalist option")).map(
      (o: any) => o.getAttribute("value"),
    );
    expect(opts).toContain("Compliance");
    expect(opts).toContain("General");
  });

  it("never suggests Map Regions, which the registry refuses by hand", () => {
    // Every row in that category is minted by a Device Map region save, so a
    // hand-created sibling is a 409 the operator did nothing to earn.
    setCatalog(true, CATALOG.concat([{ name: "region:Ashfield", color: "#4fc3f7", category: "Map Regions" }]));
    mount([]);
    const opts = Array.from(g.document.querySelectorAll("datalist option")).map(
      (o: any) => o.getAttribute("value"),
    );
    expect(opts).not.toContain("Map Regions");
  });

  it("hides the Category box from a caller who cannot create registry rows", () => {
    // Without the grant a typed name attaches to this assignment alone, so
    // there is no row for a category to land on.
    const perm = g.permAtLeast;
    // `write` is serverSettingsSystem's top rung as of 2026-09-23, the identity
    // providers having moved to `authentication` and left the old fullwrite
    // routes to come down onto write. Stubbing the retired level here would
    // pass the gate and silently stop testing anything.
    g.permAtLeast = (key: string, level: string) => !(key === "serverSettingsSystem" && level === "write");
    try {
      mount([]);
      expect(g.document.querySelector(".other-tags-category")).toBeNull();
    } finally {
      g.permAtLeast = perm;
    }
  });

  it("sends the typed category through to the registry create", async () => {
    const posted: any[] = [];
    const orig = g.api.serverSettings.createTag;
    g.api.serverSettings.createTag = async (b: any) => {
      posted.push(b);
      return { name: b.name, category: b.category, color: "#9e9e9e" };
    };
    try {
      mount([]);
      const cat = g.document.querySelector(".other-tags-category") as any;
      cat.value = "Sites";
      const input = g.document.querySelector(".other-tags-input") as any;
      input.value = "Memphis-DC";
      await addOtherTagChips(input);
      expect(posted).toEqual([{ name: "Memphis-DC", category: "Sites" }]);
    } finally {
      g.api.serverSettings.createTag = orig;
    }
  });

  it("files a brand-new category under its own heading rather than someone else's", async () => {
    const orig = g.api.serverSettings.createTag;
    g.api.serverSettings.createTag = async (b: any) => ({ name: b.name, category: b.category, color: "#9e9e9e" });
    try {
      mount([]);
      (g.document.querySelector(".other-tags-category") as any).value = "Sites";
      const input = g.document.querySelector(".other-tags-input") as any;
      input.value = "Memphis-DC";
      await addOtherTagChips(input);
      const group = g.document.querySelector('.other-tags-cat[data-category="Sites"]') as any;
      expect(group).toBeTruthy();
      expect(group.querySelector('.other-tag-pill[data-tag="Memphis-DC"]')).toBeTruthy();
      // Promoted, not duplicated: the chip it was added as is gone.
      expect(chips()).toEqual([]);
    } finally {
      g.api.serverSettings.createTag = orig;
    }
  });
});

/**
 * Assign Tags folds the old Region Scope control into this one picker, so the
 * PREFIX is now what keeps the two stored dimensions apart. Getting this wrong
 * takes a scoped operator out of every region-only consumer -- the level-scoped
 * recipient entries, "My regions" on the Device Map -- with the tag still
 * visibly on their account.
 */
describe("_splitUserTagScope", () => {
  it("routes region-prefixed names to regionTags, bare, and the rest to otherTags", () => {
    expect(splitUserTagScope(["region:Ashfield", "PCI", "region:Memphis"])).toEqual({
      regionTags: ["Ashfield", "Memphis"],
      otherTags: ["PCI"],
    });
  });

  it("matches the prefix case-insensitively", () => {
    // The registry row is `region:<name>`, but a hand-typed chip need not be.
    expect(splitUserTagScope(["Region:Ashfield"]).regionTags).toEqual(["Ashfield"]);
  });

  it("drops blanks and duplicates without dropping a real assignment", () => {
    expect(splitUserTagScope(["", "  ", "region:Ashfield", "region:Ashfield", "PCI", "PCI"])).toEqual({
      regionTags: ["Ashfield"],
      otherTags: ["PCI"],
    });
  });

  it("keeps a bare prefix out of regionTags rather than storing an empty region", () => {
    expect(splitUserTagScope(["region:", "PCI"])).toEqual({ regionTags: [], otherTags: ["PCI"] });
  });
});

/**
 * The pills under a username in the Users table.
 *
 * This drew `regionTags` ALONE, which was right while Region Scope was its own
 * control. Assign Tags now edits both dimensions through one picker, so a list
 * that renders one of them tells an operator their tags did not save. The stub
 * `PolarisRegionPills.html` returns the bare names, so a name present in the
 * output is a pill drawn for it.
 */
describe("userTagPillsHtml", () => {
  it("draws BOTH dimensions, not regions alone", () => {
    const html = userTagPillsHtml({ regionTags: ["Ashfield"], otherTags: ["PCI"] });
    expect(html).toContain("Ashfield");
    expect(html).toContain("PCI");
  });

  it("draws tags for a user who has no region at all", () => {
    // The regression: a purely tag-scoped user rendered an empty cell.
    const html = userTagPillsHtml({ regionTags: [], otherTags: ["Critical"] });
    expect(html).toContain("Critical");
  });

  it("still draws regions for a user who has no other tags", () => {
    const html = userTagPillsHtml({ regionTags: ["Memphis"], otherTags: [] });
    expect(html).toContain("Memphis");
  });

  it("names the dimension on the pill, since the two match differently", () => {
    const html = userTagPillsHtml({ regionTags: [], otherTags: ["PCI"] });
    expect(html).toContain("Per-user tag scope");
  });

  it("colours a tag from the registry", () => {
    // #ef5350 is PCI's catalogue colour — a pill that ignored the registry
    // would be indistinguishable from an unregistered one.
    expect(userTagPillsHtml({ otherTags: ["PCI"] })).toContain("#ef5350");
  });

  it("still draws a tag the registry has no row for", () => {
    // No FK backs the assignment, so an unregistered name is a real scope.
    // Grey, but present — hiding it is the same lie the region-only cell told.
    const html = userTagPillsHtml({ otherTags: ["legacy-tag"] });
    expect(html).toContain("legacy-tag");
    expect(html).toContain("#9e9e9e");
  });

  it("renders nothing at all for an unscoped user", () => {
    expect(userTagPillsHtml({ regionTags: [], otherTags: [] })).toBe("");
    expect(userTagPillsHtml({})).toBe("");
  });
});
