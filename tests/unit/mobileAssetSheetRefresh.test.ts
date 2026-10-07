/**
 * tests/unit/mobileAssetSheetRefresh.test.ts — the asset slide-up's Refresh
 * reloads the sheet; it does not poll the device.
 *
 * The header Refresh button and pull-to-refresh used to fire probeNow (an
 * on-demand probe + telemetry + system-info pass against the device) and then
 * patch the pill. Nothing in the sheet re-reads on a timer, so what the
 * operator wanted from the button was "show me what Polaris has now" — the
 * monitor loop already keeps that current. Pinned here:
 *
 *   • neither path calls probeNow; both re-fetch the asset row and repaint;
 *   • the button shows for an unmonitored asset too (it no longer needs a
 *     probe transport);
 *   • the sections the operator opened stay open across a reload;
 *   • a failed reload keeps the sheet's content and says so in a snackbar.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DETAIL_SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "asset-detail.js"), "utf-8");
const g = globalThis as any;

describe("mobile asset sheet refresh", () => {
  let asset: any;
  let get: ReturnType<typeof vi.fn>;
  let probeNow: ReturnType<typeof vi.fn>;
  const flush = async () => { for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0); };
  const refreshBtn = () => document.getElementById("asset-sheet-refresh") as HTMLButtonElement;

  function boot() {
    document.body.innerHTML = '<div id="app"></div>';
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
    get = vi.fn(async () => asset);
    probeNow = vi.fn(async () => ({ success: true }));
    const known: Record<string, any> = { get, probeNow };
    g.api = { assets: new Proxy(known, { get: (t, k: string) => (k in t ? t[k] : async () => ({})) }) };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(DETAIL_SRC)();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 7, 12, 0));
    asset = {
      id: "a1", hostname: "SW-1", assetType: "switch", monitored: true, status: "active",
      monitorStatus: "down", lastResponseTimeMs: null, macAddresses: [],
    };
    boot();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("the button re-reads the asset and repaints, without polling the device", async () => {
    g.PolarisAssetDetail.open("a1");
    await flush();
    expect(document.getElementById("asset-sheet-dot")!.className).toBe("dot down");

    asset = { ...asset, monitorStatus: "up", lastResponseTimeMs: 4 };
    refreshBtn().click();
    await flush();

    expect(probeNow).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(2);
    expect(document.getElementById("asset-sheet-dot")!.className).toBe("dot up");
    expect(document.getElementById("asset-hero-pill")!.textContent).toContain("Up");
    expect(refreshBtn().disabled).toBe(false);
  });

  it("pull-to-refresh does the same reload and returns its promise", async () => {
    g.PolarisAssetDetail.open("a1");
    await flush();
    asset = { ...asset, monitorStatus: "up" };
    // A sheet opened in-app has no #asset/<id> route — the open one is used.
    const p = g.PolarisAssetDetail.spec.onPullToRefresh({ route: { name: "assets", parts: [] } });
    expect(p).toBeInstanceOf(Promise);
    await flush();
    await p;
    expect(probeNow).not.toHaveBeenCalled();
    expect(document.getElementById("asset-sheet-dot")!.className).toBe("dot up");
  });

  it("shows the button for an unmonitored asset", async () => {
    asset = { ...asset, monitored: false };
    g.PolarisAssetDetail.open("a1");
    await flush();
    expect(refreshBtn().style.display).toBe("");
  });

  it("keeps the sections the operator opened", async () => {
    g.PolarisAssetDetail.open("a1");
    await flush();
    const body = () => document.querySelector('.sect-body[data-sect="monitor"]')!;
    const wasHidden = body().hasAttribute("hidden");
    (document.querySelector('.asset-sect-header[data-key="monitor"]') as HTMLElement).click();
    expect(body().hasAttribute("hidden")).toBe(!wasHidden);

    refreshBtn().click();
    await flush();
    expect(body().hasAttribute("hidden")).toBe(!wasHidden);
  });

  it("a failed reload keeps the content and says so", async () => {
    g.PolarisAssetDetail.open("a1");
    await flush();
    get.mockRejectedValueOnce(new Error("offline"));
    refreshBtn().click();
    await flush();
    expect(document.getElementById("asset-hero-pill")).not.toBeNull();
    expect(g.PolarisTabs.showSnackbar).toHaveBeenCalledWith("Couldn’t refresh — offline", { error: true });
    expect(refreshBtn().disabled).toBe(false);
  });
});
