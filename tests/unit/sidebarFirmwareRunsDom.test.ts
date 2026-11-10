/**
 * tests/unit/sidebarFirmwareRunsDom.test.ts
 *
 * Business rule 138: a live firmware flash shows in the nav bar's operations
 * panel (`#query-status`, `renderQueryStatus` in app.js) beside the running
 * discoveries — the asset, the target version, who started it, the stage it
 * is on and the flash percent — with an Abort ✕ for `assets:write` only.
 *
 * Also the cross-file wiring with no runtime seam to observe here: Apply
 * Update and Restart ask about a live flash before they restart Polaris and
 * send `abortFirmwareRuns` only when the operator chose to abort, and the
 * asset card nudges the panel's poll when it starts a flash.
 *
 * The renderer and its helpers are pulled out of app.js rather than
 * evaluating the file, as sidebarUpdateProgressDom.test.ts does.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { serverSettingsSource } from "./_serverSettingsSource.js";
import { appSource } from "./_appSource.js";
import { assetsSource } from "./_assetsSource.js";

const APP_JS = appSource();
const SETTINGS_JS = serverSettingsSource();
const ASSETS_JS = assetsSource();

function extractFn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  let i = src.indexOf("{", start);
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

/** The stage labels, the percent helper and the "aborting" set — one block in app.js. */
function firmwareHelpers(): string {
  const start = APP_JS.indexOf("var _firmwareAborting = {};");
  const end = APP_JS.indexOf("var FIRMWARE_FLASHING_STAGES");
  if (start < 0 || end < 0) throw new Error("firmware helpers not found");
  return APP_JS.slice(start, end);
}

type Run = { id: string; assetId: string; assetName: string; toVersion: string; stage: string | null; progress: Record<string, number> | null; startedBy: string; abortRequestedBy: string | null };

const renderAs = new Function(
  "runs",
  "discoveries",
  "canWrite",
  [
    "var activeQueries = [];",
    "function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\"/g, '&quot;'); }",
    "function permAtLeast(key, level) { return key === 'assets' && (level === 'read' || canWrite); }",
    "window._getServerDiscoveries = function () { return discoveries; };",
    "window._getFirmwareRuns = function () { return runs; };",
    firmwareHelpers(),
    extractFn(APP_JS, "renderQueryStatus"),
    "renderQueryStatus();",
    "return document.getElementById('query-status');",
  ].join("\n"),
) as (runs: Run[], discoveries: unknown[], canWrite: boolean) => HTMLElement;

const run = (over: Partial<Run> = {}): Run => ({
  id: "run-1", assetId: "asset-1", assetName: "41A-124E-1", toVersion: "7.6.8 build1164", stage: "staging",
  progress: null, startedBy: "dmoore", abortRequestedBy: null, ...over,
});

describe("the operations panel's firmware rows (rule 138)", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="query-status" class="query-status" style="display:none"></div>';
  });

  it("names the asset, the version, who started it and the stage, under a firmware header", () => {
    const el = renderAs([run()], [], true);
    expect(el.style.display).toBe("block");
    expect(el.querySelector(".query-status-label")!.textContent).toBe("1 firmware upgrade running");
    expect(el.querySelector(".query-status-name")!.textContent).toBe("Upgrading 41A-124E-1 → 7.6.8 build1164");
    expect(el.querySelector(".query-status-progress")!.textContent).toBe("by dmoore · uploading the image");
    // The name opens the asset by id, not by a hostname search.
    expect(el.querySelector("[data-fw-asset-id]")!.getAttribute("data-fw-asset-id")).toBe("asset-1");
  });

  it("adds the flash's own percent while a switch flashes", () => {
    const el = renderAs([run({ stage: "deploying", progress: { erase: 100, write: 46.4, verify: 0 } })], [], true);
    expect(el.querySelector(".query-status-progress")!.textContent).toBe("by dmoore · flashing · write 46%");
  });

  it("offers the Abort ✕ only at assets:write", () => {
    expect(renderAs([run()], [], true).querySelector("[data-fw-run-id='run-1']")).not.toBeNull();
    document.body.innerHTML = '<div id="query-status" class="query-status" style="display:none"></div>';
    expect(renderAs([run()], [], false).querySelector("[data-fw-run-id]")).toBeNull();
  });

  it("says aborting and drops the ✕ once an abort is under way", () => {
    const el = renderAs([run({ abortRequestedBy: "alice" })], [], true);
    expect(el.querySelector(".query-status-progress")!.textContent).toBe("by dmoore · aborting…");
    expect(el.querySelector("[data-fw-run-id]")).toBeNull();
  });

  it("counts operations when a flash and a discovery run together", () => {
    const el = renderAs([run()], [{ id: "d1", name: "FMG", type: "fortigate" }], true);
    expect(el.querySelector(".query-status-label")!.textContent).toBe("2 operations running");
    expect(el.querySelectorAll(".query-status-list li")).toHaveLength(2);
  });

  it("stays hidden when nothing runs", () => {
    const el = renderAs([], [], true);
    expect(el.style.display).toBe("none");
  });
});

describe("restarts ask about a live flash first (rule 138)", () => {
  it("Apply Update asks, and sends abortFirmwareRuns only from the operator's answer or the server's 409", () => {
    const apply = extractFn(SETTINGS_JS, "applyUpdateUI");
    expect(apply).toMatch(/warnIfFirmwareRunning\("update"\)/);
    expect(apply).toMatch(/applyUpdate\(password, allowWithoutBackup, abortFirmware\)/);
    expect(apply).toMatch(/firmwareRunsFrom409\(err\)/);
  });

  it("Restart asks too", () => {
    const restart = extractFn(SETTINGS_JS, "wireAdvisorRestartBtn");
    expect(restart).toMatch(/warnIfFirmwareRunning\("restart"\)/);
    expect(restart).toMatch(/api\.serverSettings\.restart\(fw\.abort\)/);
  });

  it("the asset card nudges the panel's poll when it starts a flash", () => {
    expect(ASSETS_JS).toMatch(/window\._pollFirmwareRuns\(\)/);
  });
});
