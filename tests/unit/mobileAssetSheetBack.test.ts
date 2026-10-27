/**
 * tests/unit/mobileAssetSheetBack.test.ts — the phone's Back button steps the
 * asset slide-up down before it leaves the page.
 *
 * The sheet keeps one history entry of its own while open. Pinned here:
 *
 *   • Back from expanded minimizes to the peek band; the next Back closes it;
 *   • closing with the X takes the entry back off, so the next Back is the page's;
 *   • a sheet stacked on the asset sheet (interface, table, a confirm…) is
 *     what the first Back closes;
 *   • a forward hash navigation (a navbar tap) is not mistaken for Back;
 *   • historyBack() — the search arrow / detail chevron — steps past the
 *     sheet's entry and leaves the sheet as it was.
 *
 * happy-dom's history does not fire popstate, so a small stack stands in for
 * it: pushState / back / go move an index and dispatch popstate a tick later,
 * as a browser does, and the real url follows through the native replaceState.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DETAIL_SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "asset-detail.js"), "utf-8");
const g = globalThis as any;
const NATIVE_HISTORY = window.history;

describe("mobile asset sheet — phone Back", () => {
  let entries: { state: any; url: string }[];
  let index: number;
  let back: ReturnType<typeof vi.fn>;
  let go: ReturnType<typeof vi.fn>;
  const flush = async () => { for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0); };
  const sheet = () => document.getElementById("asset-sheet");

  function installHistory() {
    const nativeReplace = NATIVE_HISTORY.replaceState.bind(NATIVE_HISTORY);
    nativeReplace(null, "", window.location.href.replace(/#.*$/, ""));
    entries = [{ state: null, url: window.location.href }];
    index = 0;
    const traverse = (delta: number) => {
      const to = Math.max(0, Math.min(entries.length - 1, index + delta));
      if (to === index) return;
      index = to;
      setTimeout(() => {
        nativeReplace(entries[index].state, "", entries[index].url);
        window.dispatchEvent(new PopStateEvent("popstate", { state: entries[index].state }));
      }, 0);
    };
    back = vi.fn(() => traverse(-1));
    go = vi.fn((n: number) => traverse(n));
    const fake = {
      get state() { return entries[index].state; },
      get length() { return entries.length; },
      pushState(state: any, _t: string, url?: string) {
        entries = entries.slice(0, index + 1);
        entries.push({ state, url: url ?? window.location.href });
        index = entries.length - 1;
        nativeReplace(state, "", entries[index].url);
      },
      replaceState(state: any, _t: string, url?: string) {
        entries[index] = { state, url: url ?? window.location.href };
        nativeReplace(state, "", entries[index].url);
      },
      back, go,
    };
    Object.defineProperty(window, "history", { configurable: true, get: () => fake });
  }

  // A forward fragment navigation, the way a navbar tap does it: a new entry
  // with a different url, popstate fired for it.
  function navigateTo(hash: string) {
    const url = window.location.href.replace(/#.*$/, "") + hash;
    window.history.pushState(null, "", url);
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="app"></div>';
    installHistory();
    g.escapeHtml = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    g.PolarisTabs = { showSnackbar: vi.fn(), attachSwipeToDismiss: vi.fn() };
    g.PolarisCharts = { lineChart: () => "" };
    g.PolarisMonitorStates = {
      fromPayload: () => ({ known: false, threshold: 1, recoveryPolls: 1, severity: null }),
      replay: (s: any[]) => s.map(() => ({ status: "up" })),
    };
    g.PolarisMobile = { user: () => ({ permissions: {} }) };
    g.mobileFormatDate = (s: any) => String(s ?? "");
    g.timeAgo = () => "1m ago";
    const asset = { id: "a1", hostname: "SW-1", assetType: "switch", monitored: true, status: "active", monitorStatus: "up", macAddresses: [] };
    g.api = { assets: new Proxy({ get: async () => asset } as Record<string, any>, { get: (t, k: string) => (k in t ? t[k] : async () => ({})) }) };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(DETAIL_SRC)();
  });
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, "history", { configurable: true, get: () => NATIVE_HISTORY });
  });

  it("Back minimizes, the next Back closes, the one after is the page's", async () => {
    g.PolarisAssetDetail.open("a1");
    await flush();
    expect(entries.length).toBe(2);

    window.history.back();
    await flush();
    expect(sheet()).not.toBeNull();
    expect(sheet()!.classList.contains("peek")).toBe(true);

    window.history.back();
    await flush();
    expect(sheet()).toBeNull();
    expect(index).toBe(0);
  });

  it("closing with the X takes the sheet's entry back off", async () => {
    g.PolarisAssetDetail.open("a1");
    await flush();
    (document.getElementById("asset-sheet-close") as HTMLButtonElement).click();
    await flush();
    expect(sheet()).toBeNull();
    expect(back).toHaveBeenCalledTimes(1);
    expect(index).toBe(0);
  });

  it("a tap-minimized sheet closes on the first Back", async () => {
    g.PolarisAssetDetail.open("a1");
    await flush();
    (document.getElementById("asset-sheet-scrim") as HTMLElement).click();
    expect(sheet()!.classList.contains("peek")).toBe(true);
    window.history.back();
    await flush();
    expect(sheet()).toBeNull();
  });

  it("Back closes a sheet stacked on it first", async () => {
    g.PolarisAssetDetail.open("a1");
    await flush();
    const scrim = document.createElement("div");
    scrim.className = "scrim";
    const child = document.createElement("div");
    child.className = "sheet";
    child.id = "iface-sheet";
    scrim.addEventListener("click", () => { scrim.remove(); child.remove(); });
    document.body.appendChild(scrim);
    document.body.appendChild(child);

    window.history.back();
    await flush();
    expect(document.getElementById("iface-sheet")).toBeNull();
    expect(sheet()!.classList.contains("peek")).toBe(false);

    window.history.back();
    await flush();
    expect(sheet()!.classList.contains("peek")).toBe(true);
  });

  it("a navbar navigation is not taken for Back", async () => {
    g.PolarisAssetDetail.open("a1");
    await flush();
    navigateTo("#networks");
    await flush();
    expect(sheet()!.classList.contains("peek")).toBe(false);
  });

  it("historyBack steps past the sheet's entry and keeps the sheet", async () => {
    window.history.pushState(null, "", window.location.href.replace(/#.*$/, "") + "#search");
    g.PolarisAssetDetail.open("a1");
    await flush();
    expect(index).toBe(2);

    g.PolarisAssetDetail.historyBack();
    await flush();
    expect(go).toHaveBeenCalledWith(-2);
    expect(window.location.hash).toBe("");
    expect(sheet()!.classList.contains("peek")).toBe(false);
    // Its entry is back on the page it landed on, so Back still minimizes.
    expect(entries[index].state).toEqual({ polarisAssetSheet: true });
    window.history.back();
    await flush();
    expect(sheet()!.classList.contains("peek")).toBe(true);
  });
});
