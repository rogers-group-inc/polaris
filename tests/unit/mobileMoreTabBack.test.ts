/**
 * tests/unit/mobileMoreTabBack.test.ts
 *
 * The back chevron on every More sub-page.
 *
 * All five were inert (the Networks sub-page has since become the Networks
 * tab). On blocks / subnets / events the `wireBack()` call sat
 * AFTER the `return api…` that kicks off the fetch — unreachable dead code that
 * reads as wired at a glance — and alerts and install never called it at all.
 * Nothing caught it: `no-unreachable` would have, but `npm run lint` is scoped
 * to `src`, so nothing lints public/js.
 *
 * The chevron is the only way out of a sub-page reached by a push deep link
 * (/mobile.html#more/alerts cold-starts straight into Alerts with no in-app
 * history behind it), so "renders but does nothing" strands the operator.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "more-tab.js"), "utf-8");

const g = globalThis as any;

/** Every sub-page registered by more-tab.js, with a stub for the fetch it makes. */
const SUB_PAGES = ["blocks", "events", "alerts", "install"] as const;

let routed: string[] = [];
let resolvers: Array<() => void> = [];

/** Mirrors app.js routeChanged: topbar is rendered into the DOM before render(). */
function mount(sub: string) {
  document.body.innerHTML =
    '<div class="app" id="app"><div id="topbar-slot"></div><main class="app-body" id="app-body"></main></div>';
  const ctx = { route: { name: "more", parts: [sub] }, user: { username: "u", role: "admin", permissions: {} } };
  document.getElementById("topbar-slot")!.innerHTML = g.PolarisMoreTab.spec.renderTopbar(ctx);
  const ret = g.PolarisMoreTab.spec.render(document.getElementById("app-body")!, ctx);
  return { ctx, ret };
}

async function open(sub: string) {
  const { ret } = mount(sub);
  resolvers.splice(0).forEach((fn) => fn());
  await ret;
  await new Promise((r) => setTimeout(r, 0));
}

const backBtn = () => document.querySelector("[data-back]") as HTMLElement | null;

/** A list endpoint whose promise this test controls, so we can click mid-load. */
function deferredList(payload: unknown) {
  return vi.fn(
    () =>
      new Promise((resolve) => {
        resolvers.push(() => resolve(payload));
      }),
  );
}

beforeAll(() => {
  g.escapeHtml = (s: any) => String(s ?? "");
  g.timeAgo = () => "just now";
  g._csrfHeaders = () => ({});
  g.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
  g.PolarisTabs = { showSnackbar: vi.fn() };
  g.PolarisTheme = { get: () => "dark", set: vi.fn() };
  g.PolarisInstall = {
    isIos: () => false, isFirefox: () => false, isStandalone: () => false,
    canPrompt: () => false, prompt: vi.fn(), onChange: vi.fn(),
  };
  g.polarisPush = { isSupported: () => false, status: vi.fn(async () => ({ supported: false })) };
  g.PolarisRouter = { go: (r: string) => routed.push(r), current: () => ({ name: "more", parts: [] }) };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(SRC)();
});

beforeEach(() => {
  routed = [];
  resolvers = [];
  g.api = {
    blocks:  { list: deferredList([]) },
    subnets: { list: deferredList({ subnets: [] }) },
    events:  { list: deferredList({ events: [] }) },
    alerts:  { list: deferredList({ notifications: [] }) },
  };
});

describe("More sub-page back chevron", () => {
  it.each(SUB_PAGES)("routes back to the More menu from %s", async (sub) => {
    await open(sub);

    const btn = backBtn();
    expect(btn, `${sub} renders no back button`).not.toBeNull();
    btn!.click();

    expect(routed, `${sub} back button is inert`).toEqual(["more"]);
  });

  it("works while the list is still loading", async () => {
    // The bug's shape made this impossible even in principle: the wiring came
    // after the fetch kickoff, so back was dead for the whole load.
    mount("alerts");
    expect(document.querySelector(".spinner"), "expected the loading state").not.toBeNull();

    backBtn()!.click();

    expect(routed).toEqual(["more"]);
  });

  it("works after the list fails to load", async () => {
    g.api.alerts.list = vi.fn(async () => { throw new Error("boom"); });
    await open("alerts");
    expect(document.body.textContent).toContain("boom");

    backBtn()!.click();

    expect(routed).toEqual(["more"]);
  });

  it("leaves the root More menu without a back button", async () => {
    // Nothing to go back to — the menu is the tab root.
    document.body.innerHTML =
      '<div class="app" id="app"><div id="topbar-slot"></div><main class="app-body" id="app-body"></main></div>';
    const ctx = { route: { name: "more", parts: [] }, user: { username: "u", role: "admin", permissions: {} } };
    document.getElementById("topbar-slot")!.innerHTML = g.PolarisMoreTab.spec.renderTopbar(ctx);
    g.PolarisMoreTab.spec.render(document.getElementById("app-body")!, ctx);

    expect(backBtn()).toBeNull();
  });
});
