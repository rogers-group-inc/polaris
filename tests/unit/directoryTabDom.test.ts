/**
 * tests/unit/directoryTabDom.test.ts — DOM smoke for the Directory tab in
 * public/js/integrations.js (business rule 35).
 *
 * Same eval-into-happy-dom idiom as arcIntegrationDom.test.ts, aimed at the
 * failure modes that are SILENT in a browser:
 *
 *   1. The form → reader round trip. A control the reader can't find saves as
 *      its default, so an operator's exclusion silently does nothing.
 *   2. The reveal panel. If the exclusion fields aren't in the DOM when the
 *      sync is off, reading them back would blank an existing filter on any
 *      save made with the toggle collapsed.
 *   3. The PII warning actually rendering — it is the one thing on the tab that
 *      tells an operator what switching it on costs.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { integrationsSource } from "./_integrationsSource.js";
import { Window } from "happy-dom";
import { APP_SHELL_STUBS } from "./_appShellStubs.js";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
const SRC = integrationsSource();

let win: InstanceType<typeof Window>;

function boot(): Record<string, any> {
  win = new Window();
  g.window = win;
  g.document = win.document;
  g.localStorage = win.localStorage;

  const stubs = `
    function escapeHtml(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
    function showToast(){}
    function openModal(){}
    function closeModal(){}
    function copyTextToClipboard(){ return Promise.resolve(true); }
    function val(id){ var el = document.getElementById(id); return el ? el.value.trim() : ""; }
    var api = { integrations: {}, credentials: {}, monitorSettings: {} };
    var permAtLeast = function(){ return true; };
  `;
  (win as any).eval(APP_SHELL_STUBS + "\n" + stubs + "\n" + SRC + "\n;window.__scope = this;");
  return win as unknown as Record<string, any>;
}

/** Render the tab into the document so the readers can find its controls. */
function render(type: string, cfg: Record<string, unknown>): Record<string, any> {
  const w = boot();
  win.document.body.innerHTML = w.directoryFormHTML(type, cfg);
  return w;
}

beforeEach(() => { vi.restoreAllMocks(); });

describe("directoryFormHTML", () => {
  it("renders BOTH directory controls, and says which one stores", () => {
    render("entraid", {});
    const html = win.document.body.innerHTML;
    expect(win.document.getElementById("f-enableDirectorySearch")).toBeTruthy();
    expect(win.document.getElementById("f-enableDirectorySync")).toBeTruthy();
    // The distinction between the two is the whole reason they share a tab.
    expect(html).toContain("live and never stored");
    expect(html).toMatch(/every backup/i);
  });

  it("states the Graph shared-mailbox limitation on Entra and not on AD", () => {
    // Graph exposes no mailbox type in bulk, so the checkbox cannot do what its
    // label implies. An operator who is not told will trust it.
    render("entraid", { enableDirectorySync: true });
    expect(win.document.body.innerHTML).toMatch(/cannot identify shared mailboxes/i);

    render("activedirectory", { enableDirectorySync: true });
    const ad = win.document.body.innerHTML;
    expect(ad).not.toMatch(/cannot identify shared mailboxes/i);
    expect(ad).toMatch(/Exchange schema/i);
  });

  it("offers OU scoping on AD only — Entra has no OUs to scope by", () => {
    render("activedirectory", {});
    expect(win.document.getElementById("f-ds-ouInclude")).toBeTruthy();
    render("entraid", {});
    expect(win.document.getElementById("f-ds-ouExclude")).toBeNull();
  });

  it("collapses the exclusion panel when the sync is off, and shows it when on", () => {
    render("entraid", { enableDirectorySync: false });
    expect(win.document.getElementById("intg-ds-detail")!.getAttribute("style")).toContain("display:none");
    render("entraid", { enableDirectorySync: true });
    expect(win.document.getElementById("intg-ds-detail")!.getAttribute("style")).not.toContain("display:none");
  });

  it("keeps the exclusion fields in the DOM even while collapsed", () => {
    // Reading them back is unconditional, so a collapsed panel whose inputs
    // were absent would blank a stored filter on the next save.
    render("entraid", {
      enableDirectorySync: false,
      directorySync: { nameExclude: ["svc-*"], maxEntries: 1234 },
    });
    const w = win as unknown as Record<string, any>;
    const out = w.__scope._readDirectorySyncConfig();
    expect(out.enabled).toBe(false);
    expect(out.filter.nameExclude).toEqual(["svc-*"]);
    expect(out.filter.maxEntries).toBe(1234);
  });
});

describe("_readDirectorySyncConfig", () => {
  it("round-trips every field the tab renders", () => {
    const cfg = {
      enableDirectorySync: true,
      directorySync: {
        excludeDisabled: false,
        excludeSharedMailboxes: false,
        includeGroups: false,
        includeOrgContacts: true,
        ouInclude: ["*OU=Staff,DC=corp,DC=example"],
        ouExclude: ["*OU=Svc,DC=corp,DC=example"],
        domainInclude: ["example.com"],
        domainExclude: ["partner.example"],
        nameExclude: ["svc-*", "noreply@*"],
        groupExclude: ["CN=Contractors,DC=corp,DC=example"],
        maxEntries: 4321,
      },
    };
    const w = render("activedirectory", cfg);
    const out = w.__scope._readDirectorySyncConfig();

    expect(out.enabled).toBe(true);
    expect(out.filter).toEqual(cfg.directorySync);
  });

  it("drops blank lines and trims — a trailing newline is not an exclusion", () => {
    render("activedirectory", { enableDirectorySync: true });
    const el = win.document.getElementById("f-ds-nameExclude") as unknown as { value: string };
    el.value = "  svc-*  \n\n\n  noreply@*\n";
    const out = (win as unknown as Record<string, any>).__scope._readDirectorySyncConfig();
    expect(out.filter.nameExclude).toEqual(["svc-*", "noreply@*"]);
  });

  it("falls back to a sane cap rather than storing NaN", () => {
    render("activedirectory", { enableDirectorySync: true });
    const el = win.document.getElementById("f-ds-maxEntries") as unknown as { value: string };
    el.value = "";
    const out = (win as unknown as Record<string, any>).__scope._readDirectorySyncConfig();
    expect(out.filter.maxEntries).toBe(20000);
  });

  it("returns undefined when the tab didn't render at all", () => {
    // Other integration types must have their config left alone.
    boot();
    win.document.body.innerHTML = "";
    expect((win as unknown as Record<string, any>).__scope._readDirectorySyncConfig()).toBeUndefined();
  });
});
