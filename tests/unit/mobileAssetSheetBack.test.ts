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
    // The index moves WHEN popstate fires, not when back() is called: a
    // browser changes history.state and fires popstate together, and a
    // hashchange happy-dom delivers late would otherwise read the next
    // entry's state early (a 1-in-2 flake).
    const traverse = (delta: number) => {
      const to = Math.max(0, Math.min(entries.length - 1, index + delta));
      if (to === index) return;
      setTimeout(() => {
        index = to;
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
    const assets: Record<string, any> = {
      a1: { id: "a1", hostname: "SW-1", assetType: "switch", monitored: true, status: "active", monitorStatus: "up", macAddresses: [] },
      a2: { id: "a2", hostname: "SW-2", assetType: "switch", monitored: true, status: "active", monitorStatus: "up", macAddresses: [] },
    };
    g.api = { assets: new Proxy({ get: async (id: string) => assets[id] } as Record<string, any>, { get: (t, k: string) => (k in t ? t[k] : async () => ({})) }) };
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

  describe("page history", () => {
    const page = () => (document.querySelector("#asset-host .asset-page") as HTMLElement | null)?.dataset.page ?? "asset";
    const backBtn = () => document.getElementById("asset-sheet-back") as HTMLButtonElement;
    const fwdBtn = () => document.getElementById("asset-sheet-fwd") as HTMLButtonElement;
    const openStorage = async () => {
      (document.getElementById("asset-storage-btn") as HTMLButtonElement).click();
      await flush();
    };

    it("a page opened from the asset goes forward; ‹ and › walk the list", async () => {
      g.PolarisAssetDetail.open("a1");
      await flush();
      expect(backBtn().disabled).toBe(true);
      await openStorage();
      expect(page()).toBe("storage");
      expect(document.getElementById("asset-sheet-page-title")!.textContent).toBe("Storage");
      expect(document.getElementById("asset-sheet-page-sub")!.textContent).toBe("SW-1");
      expect(backBtn().getAttribute("aria-label")).toBe("Back to SW-1");
      expect(fwdBtn().disabled).toBe(true);

      backBtn().click();
      await flush();
      expect(page()).toBe("asset");
      expect(fwdBtn().disabled).toBe(false);
      expect(fwdBtn().getAttribute("aria-label")).toBe("Forward to Storage");

      fwdBtn().click();
      await flush();
      expect(page()).toBe("storage");
    });

    it("the phone's Back walks the pages, then shrinks, then closes", async () => {
      g.PolarisAssetDetail.open("a1");
      await flush();
      await openStorage();

      window.history.back();
      await flush();
      expect(page()).toBe("asset");
      expect(sheet()!.classList.contains("peek")).toBe(false);

      window.history.back();
      await flush();
      expect(sheet()!.classList.contains("peek")).toBe(true);

      window.history.back();
      await flush();
      expect(sheet()).toBeNull();
      expect(index).toBe(0);
    });

    it("another asset opened over this one is a page forward", async () => {
      g.PolarisAssetDetail.open("a1");
      await flush();
      g.PolarisAssetDetail.open("a2");
      await flush();
      expect(backBtn().disabled).toBe(false);
      backBtn().click();
      await flush();
      expect(document.getElementById("asset-sheet-name")!.textContent).toBe("SW-1");
    });

    it("opening a page from a back position drops the pages ahead", async () => {
      g.PolarisAssetDetail.open("a1");
      await flush();
      await openStorage();
      backBtn().click();
      await flush();
      g.PolarisAssetDetail.open("a2");
      await flush();
      expect(fwdBtn().disabled).toBe(true);
    });

    it("the hero's alert flag opens the Alerts page, drawn by the alerts module", async () => {
      const renderInto = vi.fn();
      const close = vi.fn();
      g.PolarisMobileAlerts = {
        summarize: () => ({ severity: "critical", count: 1, unacknowledged: 1 }),
        flagHTML: () => '<button class="alert-flag">Alerts</button>',
        renderInto, close,
      };
      try {
        g.PolarisAssetDetail.open("a1");
        await flush();
        (document.querySelector("#asset-hero-alerts .alert-flag") as HTMLElement).click();
        await flush();
        expect(page()).toBe("alerts");
        expect(document.getElementById("asset-sheet-page-title")!.textContent).toBe("Alerts");
        expect(renderInto).toHaveBeenCalledWith(document.querySelector("#asset-host .asset-page"), "a1");
        backBtn().click();
        await flush();
        expect(close).toHaveBeenCalled();   // a late load for the page just left is dropped
      } finally {
        delete g.PolarisMobileAlerts;
      }
    });

    it("a fresh open after a close starts a new history", async () => {
      g.PolarisAssetDetail.open("a1");
      await flush();
      await openStorage();
      (document.getElementById("asset-sheet-close") as HTMLButtonElement).click();
      await flush();
      g.PolarisAssetDetail.open("a2");
      await flush();
      expect(backBtn().disabled).toBe(true);
      expect(fwdBtn().disabled).toBe(true);
    });
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
