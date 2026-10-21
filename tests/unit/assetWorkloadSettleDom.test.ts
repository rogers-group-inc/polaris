/**
 * tests/unit/assetWorkloadSettleDom.test.ts — the asset page's Workload card
 * action bar (public/js/assets.js → _wireWorkloadActions).
 *
 * TrueNAS reports app.upgrade / app.redeploy done while the App is still
 * DEPLOYING, so a single re-read after the action showed an updated App as
 * not running until the operator reloaded the page. The card now re-reads
 * until the workload reaches the state the verb aims at, holding the verbs
 * off meanwhile.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;
const lines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

function fnSrc(name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}

beforeAll(() => {
  g.escapeHtml = (s: any) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.canManageAssets = () => true;
  g.showConfirm = async () => true;
  // eslint-disable-next-line no-eval
  (0, eval)(["_wlStateBadge", "_wlUpdateBadge", "_wireWorkloadActions"].map(fnSrc).join("\n") +
    "\nglobalThis._wireWorkloadActions = _wireWorkloadActions;");
});

const status = (state: string, rawState: string, verbs: string[], updateAvailable = false) => ({
  platform: "truenas", role: "container", integrationName: "nas", state, rawState,
  updateAvailable, version: "1.0", latestVersion: "1.1", monitoringPausedByStop: false, verbs,
});

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

let mount: HTMLElement;
let reads: any[];

beforeEach(() => {
  vi.useFakeTimers();
  g.showToast = vi.fn();
  reads = [];
  g.api = {
    assets: {
      workload: vi.fn(async () => reads.shift()),
      workloadAction: vi.fn(async () => ({ ok: true, message: 'App "plex" updated on TrueNAS SCALE.' })),
      workloadCheckUpdates: vi.fn(),
    },
  };
  mount = document.createElement("div");
  mount.innerHTML = '<span data-wl-state></span><span data-wl-update></span><div data-wl-actions></div>';
  document.body.appendChild(mount);
});

afterEach(() => {
  mount.remove();
  vi.useRealTimers();
});

function wire() {
  g._wireWorkloadActions(mount, { id: "a1", hostname: "plex" }, { virtualization: { role: "container", platform: "truenas" } });
}

const bar = () => mount.querySelector("[data-wl-actions]") as HTMLElement;
const verbButtons = () => Array.from(bar().querySelectorAll("[data-wl-verb]")).map((b) => b.getAttribute("data-wl-verb"));

describe("_wireWorkloadActions settle loop", () => {
  it("keeps re-reading after an update until the App is running again", async () => {
    reads.push(status("running", "RUNNING", ["stop", "restart", "update"], true));
    wire();
    await flush();

    reads.push(status("other", "DEPLOYING", ["start"]));
    (bar().querySelector('[data-wl-verb="update"]') as HTMLButtonElement).click();
    await flush();

    expect(g.api.assets.workloadAction).toHaveBeenCalledWith("a1", "update", {});
    expect(bar().textContent).toContain("settle");
    expect(verbButtons()).toEqual([]);
    expect(mount.querySelector("[data-wl-state]")!.textContent).toContain("DEPLOYING");

    reads.push(status("running", "RUNNING", ["stop", "restart"]));
    await vi.advanceTimersByTimeAsync(3000);
    await flush();

    expect(g.api.assets.workload).toHaveBeenCalledTimes(3);
    expect(verbButtons()).toEqual(["stop", "restart"]);
    expect(mount.querySelector("[data-wl-state]")!.textContent).toContain("Running");
    expect(bar().textContent).not.toContain("settle");
  });

  it("gives up after the deadline and shows whatever state the host reports", async () => {
    reads.push(status("running", "RUNNING", ["stop", "restart"]));
    wire();
    await flush();

    g.api.assets.workload.mockImplementation(async () => status("stopped", "CRASHED", ["start"]));
    (bar().querySelector('[data-wl-verb="restart"]') as HTMLButtonElement).click();
    await flush();
    expect(verbButtons()).toEqual([]);

    await vi.advanceTimersByTimeAsync(125000);
    await flush();
    expect(verbButtons()).toEqual(["start"]);
  });

  it("re-reads once, without waiting, when the action fails", async () => {
    reads.push(status("running", "RUNNING", ["stop", "restart", "update"], true));
    wire();
    await flush();

    g.api.assets.workloadAction.mockRejectedValueOnce(new Error("Not authorized"));
    reads.push(status("running", "RUNNING", ["stop", "restart", "update"], true));
    (bar().querySelector('[data-wl-verb="update"]') as HTMLButtonElement).click();
    await flush();

    expect(g.showToast).toHaveBeenCalledWith("Not authorized", "error");
    expect(verbButtons()).toEqual(["stop", "restart", "update"]);
    await vi.advanceTimersByTimeAsync(10000);
    expect(g.api.assets.workload).toHaveBeenCalledTimes(2);
  });

  it("stops polling once the panel is closed", async () => {
    reads.push(status("running", "RUNNING", ["stop", "restart"]));
    wire();
    await flush();

    g.api.assets.workload.mockImplementation(async () => status("other", "DEPLOYING", []));
    (bar().querySelector('[data-wl-verb="restart"]') as HTMLButtonElement).click();
    await flush();
    const calls = g.api.assets.workload.mock.calls.length;

    mount.remove();
    await vi.advanceTimersByTimeAsync(9000);
    expect(g.api.assets.workload.mock.calls.length).toBeLessThanOrEqual(calls + 1);
  });
});
