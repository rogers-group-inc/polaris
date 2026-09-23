/**
 * tests/unit/mobileAssetsTabPaging.test.ts
 *
 * The Assets tab pages by APPENDING: a Load more tap adds that page's cards to
 * the existing list instead of rebuilding every card accumulated so far, and
 * card taps ride ONE delegated listener on the host rather than a listener per
 * card re-attached on every tap. Walking a 2000-device fleet is 40 taps, so
 * the old shape was quadratic in DOM work and in listener attachments — on a
 * phone.
 *
 * What's pinned here is the behaviour that quadratic-to-linear rewrite could
 * plausibly break: no duplicated or dropped cards across pages, the footer
 * switching from Load-more to the final count, and a tap still opening the
 * right asset AFTER an append (i.e. the delegated listener covers cards that
 * were added to the DOM later, which is the whole reason to delegate).
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "assets-tab.js"), "utf-8");
// mobile.html loads the shared list toolbar first; assets-tab.js draws it.
const LIST_SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "list-controls.js"), "utf-8");

const g = globalThis as any;

function asset(n: number) {
  return {
    id: "a" + n,
    hostname: "DEVICE-" + n,
    assetType: "server",
    monitored: true,
    monitorStatus: "up",
    ipAddress: "10.0.0." + n,
  };
}

/** Boot the tab with a paged /assets feed of `total` devices, 50 per page. */
function mount(total: number) {
  document.body.innerHTML = '<div id="app"><main class="app-body" id="app-body"></main></div>';
  const opened: string[] = [];
  const requests: Array<{ limit: number; offset: number }> = [];

  g.escapeHtml = (s: any) => String(s ?? "");
  g.timeAgo = () => "just now";
  g.api = {
    assets: {
      list: vi.fn(async (p: any) => {
        requests.push({ limit: p.limit, offset: p.offset });
        const out = [];
        for (let i = p.offset; i < Math.min(total, p.offset + p.limit); i++) out.push(asset(i));
        return { assets: out, total };
      }),
    },
  };
  g.PolarisRouter = { go: (r: string) => opened.push(r) };
  g.PolarisTabs = { showSnackbar: vi.fn() };
  g.PolarisAssetDetail = { open: (id: string) => opened.push("detail:" + id) };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(LIST_SRC)();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(SRC)();
  const spec = g.PolarisAssetsTab.spec;
  const body = document.getElementById("app-body")!;
  spec.render(body);
  return { opened, requests };
}

const cards = () => Array.from(document.querySelectorAll(".asset-card"));
const ids = () => cards().map((c) => (c as HTMLElement).dataset.id);
const loadMore = () => document.getElementById("assets-load-more") as HTMLButtonElement | null;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("mobile Assets tab paging", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("appends each page's cards without duplicating or dropping any", async () => {
    mount(120);
    await flush();
    expect(cards().length).toBe(50);

    loadMore()!.click();
    await flush();
    expect(cards().length).toBe(100);

    loadMore()!.click();
    await flush();
    // 120 distinct devices, in order, each exactly once.
    expect(cards().length).toBe(120);
    expect(new Set(ids()).size).toBe(120);
    expect(ids()[0]).toBe("a0");
    expect(ids()[119]).toBe("a119");
  });

  it("keeps the already-rendered nodes across a Load more instead of rebuilding them", async () => {
    // The assertion that actually separates appending from re-rendering: hold
    // the identity of a first-page node and require it to survive. Under the
    // old full-rebuild the host's innerHTML was replaced, so this exact
    // element would be detached and a fresh one built in its place — 40 taps
    // of that is what made the walk to 2000 assets quadratic.
    mount(120);
    await flush();
    const first = document.querySelector('.asset-card[data-id="a0"]')!;

    loadMore()!.click();
    await flush();

    expect(document.querySelector('.asset-card[data-id="a0"]')).toBe(first);
    expect(first.isConnected).toBe(true);
  });

  it("swaps the Load-more button for the final count once everything is in", async () => {
    mount(60);
    await flush();
    expect(loadMore()).not.toBeNull();

    loadMore()!.click();
    await flush();
    expect(loadMore()).toBeNull();
    expect(document.getElementById("assets-list-footer")!.textContent).toContain("60 assets");
  });

  it("a tap on a card added by a LATER page still opens it (delegation covers new nodes)", async () => {
    const { opened } = mount(120);
    await flush();
    loadMore()!.click();
    await flush();

    // A card from the second page — one the first render never emitted, so a
    // per-card listener attached at first paint could not have reached it.
    const later = document.querySelector('.asset-card[data-id="a75"]') as HTMLElement;
    expect(later).not.toBeNull();
    later.click();
    expect(opened).toContain("detail:a75");
  });

  it("re-fetches from the top on a filter change rather than appending onto the old list", async () => {
    const { requests } = mount(120);
    await flush();
    loadMore()!.click();
    await flush();
    expect(cards().length).toBe(100);

    const chip = document.querySelector('.chip[data-key="switch"]') as HTMLElement;
    expect(chip).not.toBeNull();
    chip.click();
    await flush();

    // Offset back to 0, and the list is the new filter's first page only.
    expect(requests[requests.length - 1].offset).toBe(0);
    expect(cards().length).toBe(50);
    expect(ids()[0]).toBe("a0");
  });
});
