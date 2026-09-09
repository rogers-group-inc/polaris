/**
 * tests/unit/directorySearchService.test.ts — the GAL fan-out.
 *
 * The properties that matter are all about NOT making a typeahead fragile:
 *   - only integrations that opted in are queried (the permission gate),
 *   - one backend failing degrades to the others' results instead of erroring,
 *   - a hybrid-joined person appearing in both AD and Entra is deduped,
 *   - short queries never reach the directory at all,
 *   - identical queries are served from cache rather than re-hitting the tenant.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const integrations: Array<{ id: string; name: string; type: string; config: Record<string, unknown> }> = [];

const prismaMock = vi.hoisted(() => ({
  integration: { findMany: vi.fn() },
}));
vi.mock("../../src/db.js", () => ({ prisma: prismaMock }));

const entraSearch = vi.hoisted(() => vi.fn());
const adSearch = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/entraIdService.js", () => ({ searchDirectoryEntra: entraSearch }));
vi.mock("../../src/services/activeDirectoryService.js", () => ({ searchDirectoryAd: adSearch }));

import {
  searchDirectory,
  directorySearchAvailable,
  listDirectorySources,
  bumpDirectoryCache,
} from "../../src/services/directorySearchService.js";

const hit = (email: string, over: Record<string, unknown> = {}) => ({
  id: "id-" + email, email, name: email.split("@")[0], description: null, kind: "person", ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  bumpDirectoryCache();
  integrations.length = 0;
  prismaMock.integration.findMany.mockImplementation(async () => integrations);
  entraSearch.mockResolvedValue([]);
  adSearch.mockResolvedValue([]);
});

const addEntra = (opt: boolean) =>
  integrations.push({ id: "i-entra", name: "Entra", type: "entraid", config: { enableDirectorySearch: opt } });
const addAd = (opt: boolean) =>
  integrations.push({ id: "i-ad", name: "AD", type: "activedirectory", config: { enableDirectorySearch: opt } });

describe("opt-in gate", () => {
  it("queries nothing when no integration opted in", async () => {
    addEntra(false);
    addAd(false);
    expect(await searchDirectory("jane")).toEqual([]);
    expect(entraSearch).not.toHaveBeenCalled();
    expect(adSearch).not.toHaveBeenCalled();
  });

  it("queries only the integrations that did", async () => {
    addEntra(true);
    addAd(false);
    entraSearch.mockResolvedValue([hit("jane@example.com")]);
    const out = await searchDirectory("jane");
    expect(out.map((e) => e.email)).toEqual(["jane@example.com"]);
    expect(adSearch).not.toHaveBeenCalled();
  });

  it("directorySearchAvailable reflects the gate", async () => {
    addEntra(false);
    expect(await directorySearchAvailable()).toBe(false);
    integrations.length = 0;
    addEntra(true);
    expect(await directorySearchAvailable()).toBe(true);
  });
});

describe("query floor", () => {
  it("never reaches the directory for a query below the minimum", async () => {
    addEntra(true);
    expect(await searchDirectory("j")).toEqual([]);
    expect(await searchDirectory("")).toEqual([]);
    expect(await searchDirectory("   ")).toEqual([]);
    expect(entraSearch).not.toHaveBeenCalled();
  });
});

describe("failure isolation", () => {
  it("returns the healthy backend's results when the other throws", async () => {
    addEntra(true);
    addAd(true);
    entraSearch.mockRejectedValue(new Error("Graph API permission denied (403)"));
    adSearch.mockResolvedValue([hit("onprem@example.com")]);

    const out = await searchDirectory("on");
    expect(out.map((e) => e.email)).toEqual(["onprem@example.com"]);
  });

  it("returns [] rather than throwing when every backend fails", async () => {
    addEntra(true);
    adSearch.mockResolvedValue([]);
    entraSearch.mockRejectedValue(new Error("boom"));
    expect(await searchDirectory("jane")).toEqual([]);
  });
});

describe("merging", () => {
  it("tags each hit with the backend that produced it", async () => {
    addEntra(true);
    addAd(true);
    entraSearch.mockResolvedValue([hit("cloud@example.com")]);
    adSearch.mockResolvedValue([hit("onprem@example.com")]);
    const out = await searchDirectory("example");
    expect(out.find((e) => e.email === "cloud@example.com")!.source).toBe("entra");
    expect(out.find((e) => e.email === "onprem@example.com")!.source).toBe("ad");
  });

  it("dedupes a hybrid-joined person present in both directories", async () => {
    addEntra(true);
    addAd(true);
    entraSearch.mockResolvedValue([hit("jane@example.com")]);
    adSearch.mockResolvedValue([hit("JANE@example.com")]);
    const out = await searchDirectory("jane");
    expect(out).toHaveLength(1);
  });

  it("caps the merged result set", async () => {
    addEntra(true);
    entraSearch.mockResolvedValue(Array.from({ length: 40 }, (_, i) => hit(`u${i}@example.com`)));
    expect(await searchDirectory("user", 10)).toHaveLength(10);
  });

  it("carries the group kind through", async () => {
    addEntra(true);
    entraSearch.mockResolvedValue([hit("netops@example.com", { kind: "group", description: "Distribution list" })]);
    const out = await searchDirectory("net");
    expect(out[0].kind).toBe("group");
  });
});

describe("caching", () => {
  it("serves an identical query from cache instead of re-hitting the tenant", async () => {
    addEntra(true);
    entraSearch.mockResolvedValue([hit("jane@example.com")]);
    await searchDirectory("jane");
    await searchDirectory("jane");
    await searchDirectory("JANE"); // case-insensitive key
    expect(entraSearch).toHaveBeenCalledTimes(1);
  });

  it("treats a different query as a different key", async () => {
    addEntra(true);
    entraSearch.mockResolvedValue([]);
    await searchDirectory("jane");
    await searchDirectory("john");
    expect(entraSearch).toHaveBeenCalledTimes(2);
  });
});

/**
 * The directories that feed the address book, as its source tabs need them:
 * one entry per BACKEND (a stored contact records "entra", not which of two
 * Entra integrations produced it), labelled for a human.
 */
describe("listDirectorySources", () => {
  it("ignores an integration that opted into neither search nor sync", async () => {
    // A device-discovery integration that happens to point at a directory puts
    // nothing in the address book, so it gets no tab.
    integrations.push({ id: "i1", name: "Corp AD", type: "activedirectory", config: {} });
    expect(await listDirectorySources()).toEqual([]);
  });

  it("reports each opt-in separately", async () => {
    // search-only means the tab has no stored rows at all — it only answers
    // while something is typed — so the two flags cannot be collapsed into one.
    integrations.push({ id: "i1", name: "Corp Entra", type: "entraid", config: { enableDirectorySearch: true } });
    integrations.push({ id: "i2", name: "Corp AD", type: "activedirectory", config: { enableDirectorySync: true } });
    expect(await listDirectorySources()).toEqual([
      { kind: "entra", label: "Corp Entra", search: true, sync: false },
      { kind: "ad", label: "Corp AD", search: false, sync: true },
    ]);
  });

  it("falls back to the product name when two integrations share a backend", async () => {
    // They share one `Contact.origin`, so neither name may claim the rows.
    integrations.push({ id: "i1", name: "Tenant A", type: "entraid", config: { enableDirectorySync: true } });
    integrations.push({ id: "i2", name: "Tenant B", type: "entraid", config: { enableDirectorySearch: true } });
    expect(await listDirectorySources()).toEqual([
      { kind: "entra", label: "Entra ID", search: true, sync: true },
    ]);
  });

  it("skips a disabled integration", async () => {
    // The query itself filters on `enabled`; this asserts the tab strip inherits
    // that rather than naming a directory nothing will ever ask.
    prismaMock.integration.findMany.mockImplementation(async ({ where }: { where: { enabled: boolean } }) =>
      integrations.filter((i) => where.enabled !== true || (i as { enabled?: boolean }).enabled !== false));
    integrations.push({ id: "i1", name: "Old AD", type: "activedirectory", enabled: false, config: { enableDirectorySync: true } } as never);
    expect(await listDirectorySources()).toEqual([]);
  });
});
