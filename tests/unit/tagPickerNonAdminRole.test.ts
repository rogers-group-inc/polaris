/**
 * tests/unit/tagPickerNonAdminRole.test.ts — the shared tag picker for a role
 * that holds NO serverSettingsSystem grant.
 *
 * The original bug: `_ensureTagCache` read the tag registry through
 * `GET /server-settings/tags` + `/tags/settings`, both of which sat behind the
 * blanket `serverSettingsSystem: read` floor on that mount. Every non-admin
 * built-in role is seeded `serverSettingsSystem: "none"`, so both calls 403'd,
 * the cache's `.catch()` swallowed it, and the asset edit form's tag picker
 * rendered "No tags defined yet" at an install with a full registry — with an
 * "+ Add Tag" button whose only possible outcome was another 403.
 *
 * The picker reads the auth-only catalogue route. Since 2026-11-03 the
 * registry AND assigning a tag to any record ride one key, `tags` (business
 * rule 141: a tag is write reach for everyone who holds it, so putting one on
 * a device is an administrator's act): below `tags: write` the field is
 * static — the record's own tags as fixed chips that still post back
 * unchanged, plus a hint — and the add-row is gated on the same level.
 *
 * app.js is a classic browser script, so it's eval'd into a happy-dom Window —
 * the tagPickerRegionTags.test.ts idiom.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { appSource } from "./_appSource.js";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
// The page order: the shared theme engine (theme-core.js) runs before app.js.
const APP_SRC =
  readFileSync(resolve(__dirname, "../../public/js/theme-core.js"), "utf8") + "\n" +
  appSource();

const TAGS = [
  { id: "t1", name: "Production", category: "Environment", color: "#f87171" },
  { id: "t2", name: "Nashville", category: "Site", color: "#4fc3f7" },
];

let win: InstanceType<typeof Window>;
let doc: Window["document"];

function exported<T>(name: string): T {
  const fn = (win as unknown as Record<string, unknown>)[name] ?? g[name];
  expect(typeof fn, `app.js no longer exposes ${name}`).toBe("function");
  return fn as T;
}

/**
 * Boot app.js with one role matrix and one catalogue outcome, then render the
 * picker into #host. `catalog: null` stands in for a read that failed.
 */
async function boot(opts: {
  perms: Record<string, string>;
  catalog: { enforce: boolean; tags: typeof TAGS } | null;
  selected?: string[];
}): Promise<{ calls: string[] }> {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  g.fetch = () => Promise.reject(new Error("no network in this test"));
  g.showToast = () => {};
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const calls: string[] = [];
  g.api = {
    serverSettings: {
      tagCatalog: async () => {
        calls.push("tagCatalog");
        if (!opts.catalog) throw new Error("403 Forbidden");
        return opts.catalog;
      },
      // The registry's own gated reads. A call to either is the bug: they 403
      // for the roles this test is about.
      listTags: async () => { calls.push("listTags"); throw new Error("403 Forbidden"); },
      getTagSettings: async () => { calls.push("getTagSettings"); throw new Error("403 Forbidden"); },
    },
  };

  doc.body.innerHTML = "<div id='host'></div>";
  try { (0, eval)(APP_SRC); } catch { /* app.js boot wiring touches page-specific DOM */ }

  (win as unknown as Record<string, unknown>).currentRolePermissions = opts.perms;
  g.currentRolePermissions = opts.perms;

  await exported<() => Promise<void>>("_ensureTagCache")();
  const host = doc.getElementById("host") as unknown as HTMLElement;
  host.innerHTML = exported<(s: string[]) => string>("tagFieldHTML")(opts.selected ?? []);
  return { calls };
}

// May edit assets and networks, may look at the registry, may not tag.
const USER_ROLE = { assets: "write", subnets: "write", serverSettingsSystem: "none", tags: "read" };
// May tag — and still holds no Server Settings grant at all.
const TAGGER_ROLE = { assets: "write", subnets: "write", serverSettingsSystem: "none", tags: "write" };
const ADMIN_ROLE = { assets: "fullwrite", subnets: "fullwrite", serverSettingsSystem: "write", tags: "write" };

function chipValues(): string[] {
  return Array.from(doc.querySelectorAll('input[name="f-tags-cb"]')).map(
    (e) => (e as unknown as HTMLInputElement).value,
  );
}

describe("tag picker — a role with no serverSettingsSystem grant", () => {
  beforeEach(() => { /* each test boots its own window */ });

  it("reads the catalogue route, never the gated registry routes", async () => {
    const { calls } = await boot({ perms: USER_ROLE, catalog: { enforce: false, tags: TAGS } });
    expect(calls).toEqual(["tagCatalog"]);
    expect(calls, "the gated registry read is back — it 403s for this role").not.toContain("listTags");
    expect(calls).not.toContain("getTagSettings");
  });

  it("without Tags write the field is static: the record's own tags, posted back unchanged, and the hint", async () => {
    await boot({ perms: USER_ROLE, catalog: { enforce: false, tags: TAGS }, selected: ["Production"] });
    expect(doc.getElementById("f-tags-picker"), "a live picker for a role that cannot tag").toBeNull();
    // The hidden checked box is what keeps the save from posting an empty
    // array — which the server would refuse as a tag change.
    expect(chipValues()).toEqual(["Production"]);
    expect(doc.body.textContent).toContain("Changing tags needs Read-Write on Tags");
    expect(doc.body.innerHTML).not.toContain("No tags defined yet");
  });

  it("withholds the + Add Tag row — creating a registry row needs Tags write", async () => {
    await boot({ perms: USER_ROLE, catalog: { enforce: false, tags: TAGS } });
    expect(doc.getElementById("f-tag-add-btn"), "a button whose only outcome is a 403").toBeNull();
  });

  it("renders the existing tags as selectable chips for a Tags Read-Write caller", async () => {
    await boot({ perms: TAGGER_ROLE, catalog: { enforce: false, tags: TAGS } });
    expect(doc.getElementById("f-tags-picker")).toBeTruthy();
    expect(chipValues().sort()).toEqual(["Nashville", "Production"]);
    expect(doc.body.innerHTML).not.toContain("No tags defined yet");
  });

  it("still offers + Add Tag to a caller who holds the grant", async () => {
    await boot({ perms: ADMIN_ROLE, catalog: { enforce: false, tags: TAGS } });
    expect(doc.getElementById("f-tag-add-btn")).toBeTruthy();
  });

  it("enforce=true withholds the add row even from a Tags write caller", async () => {
    await boot({ perms: ADMIN_ROLE, catalog: { enforce: true, tags: TAGS } });
    expect(doc.getElementById("f-tag-add-btn")).toBeNull();
    expect(chipValues().sort()).toEqual(["Nashville", "Production"]);
  });

  it("an empty registry still renders the static field for a role that cannot tag", async () => {
    await boot({ perms: USER_ROLE, catalog: { enforce: false, tags: [] } });
    expect(doc.body.textContent).toContain("Changing tags needs Read-Write on Tags");
    expect(doc.body.textContent, "there is no form below for this role").not.toContain("Use the form below");
  });

  it("a failed read says so instead of claiming the install has no tags", async () => {
    await boot({ perms: ADMIN_ROLE, catalog: null });
    expect(doc.body.textContent).toContain("Could not load the tag list");
    expect(doc.body.textContent).not.toContain("No tags defined yet");
    // Nothing to add TO — the add row is withheld even from a Tags write caller.
    expect(doc.getElementById("f-tag-add-btn")).toBeNull();
  });
});
