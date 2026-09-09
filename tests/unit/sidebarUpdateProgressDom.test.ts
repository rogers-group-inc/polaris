/**
 * tests/unit/sidebarUpdateProgressDom.test.ts
 *
 * The sidebar's in-app update progress panel (`#update-status`, rendered by
 * `renderUpdateStatus` in app.js) and the one wiring that makes it appear in
 * time to be useful.
 *
 * Two properties, one per half of the bug this file was written for:
 *
 *   THE RENDER. The panel is visible only while the updater is actually
 *   mid-flight (state applying/restarting) and names the step the pipeline is
 *   ON — the running step when there is one, else the coarse `status.step`,
 *   else "Restarting service". "available"/"complete"/"failed" belong to the
 *   version badge and the Maintenance card, not here.
 *
 *   THE KICK. The sidebar poller self-paces: 5 s once it has SEEN an update in
 *   flight, 60 s while idle. So the Apply button has to nudge it — the poller
 *   and its only caller live in different files, and when that call went
 *   missing the sidebar slept through the whole applying phase and the panel
 *   never rendered at all. Nothing else reports that: the Maintenance card
 *   polls at its own 2 s and looks perfectly healthy while the sidebar is
 *   blank.
 *
 * renderUpdateStatus is pulled out of app.js rather than evaluating the file
 * (119 KB, with polling loops that would fire here); the kick is asserted
 * against server-settings.js source, since it is a cross-file contract with no
 * runtime seam to observe.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_JS = readFileSync(join(process.cwd(), "public", "js", "app.js"), "utf-8");
const SETTINGS_JS = readFileSync(join(process.cwd(), "public", "js", "server-settings.js"), "utf-8");

/** Pull one function out of app.js so we don't boot the whole page. */
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

type Step = { name: string; status: string; message?: string };
type Status = { state: string; step?: string; steps?: Step[] } | null;

const render = new Function(
  "status",
  [
    // The real escapeHtml lives in api.js; the panel only needs it to not throw.
    "function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }",
    "window._getUpdateStatus = function () { return status; };",
    extractFn(APP_JS, "renderUpdateStatus"),
    "renderUpdateStatus();",
    "return document.getElementById('update-status');",
  ].join("\n")
) as (status: Status) => HTMLElement;

describe("sidebar update progress panel", () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div id="update-status" class="query-status update-status" style="display:none"></div>';
  });

  it("stays hidden when no update is running", () => {
    for (const status of [null, { state: "idle" }, { state: "available" }, { state: "complete" }, { state: "failed" }]) {
      const el = render(status as Status);
      expect(el.style.display, `state ${JSON.stringify(status)}`).toBe("none");
      expect(el.innerHTML).toBe("");
    }
  });

  it("names the running step while applying", () => {
    const el = render({
      state: "applying",
      step: "Installing dependencies",
      steps: [
        { name: "Creating backup", status: "complete" },
        { name: "Installing dependencies", status: "running", message: "npm ci" },
        { name: "Building", status: "pending" },
      ],
    });
    expect(el.style.display).toBe("block");
    expect(el.textContent).toContain("Applying update");
    expect(el.textContent).toContain("Installing dependencies");
    expect(el.textContent).toContain("npm ci");
    // The full checklist stays on the Maintenance card — the panel shows one step.
    expect(el.textContent).not.toContain("Creating backup");
    expect(el.querySelector(".query-spinner")).not.toBeNull();
  });

  it("falls back to the coarse step between steps, and to a default while restarting", () => {
    const between = render({ state: "applying", step: "Running migrations", steps: [{ name: "Building", status: "complete" }] });
    expect(between.textContent).toContain("Running migrations");

    const restarting = render({ state: "restarting", steps: [] });
    expect(restarting.style.display).toBe("block");
    expect(restarting.textContent).toContain("Update — restarting");
    expect(restarting.textContent).toContain("Restarting service");
  });

  it("clicks through to the Maintenance card while active, and drops the handler when it hides", () => {
    const active = render({ state: "applying", step: "Building" });
    expect(typeof active.onclick).toBe("function");
    expect(active.style.cursor).toBe("pointer");

    const idle = render({ state: "idle" });
    expect(idle.onclick).toBeNull();
  });
});

describe("Apply Update kicks the sidebar poller", () => {
  it("calls window._pollUpdateProgress after starting the update", () => {
    const body = extractFn(SETTINGS_JS, "applyUpdateUI");
    const apply = body.indexOf("api.serverSettings.applyUpdate(");
    const kick = body.indexOf("window._pollUpdateProgress");
    expect(apply, "applyUpdateUI must call api.serverSettings.applyUpdate").toBeGreaterThan(-1);
    expect(kick, "applyUpdateUI must nudge the sidebar poller — see this file's header").toBeGreaterThan(apply);
  });

  it("app.js exposes that kick and re-paces the loop from it", () => {
    const i = APP_JS.indexOf("window._pollUpdateProgress = function");
    expect(i).toBeGreaterThan(-1);
    const fn = APP_JS.slice(i, APP_JS.indexOf("\n};", i));
    expect(fn).toContain("pollUpdateProgress()");
    expect(fn).toContain("_scheduleUpdatePoll");
  });
});
