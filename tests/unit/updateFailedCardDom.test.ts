/**
 * tests/unit/updateFailedCardDom.test.ts
 *
 * The Application Updates card's "Update Failed" state (`renderUpdateFailed`
 * in server-settings.js) and its Check Again button.
 *
 * Prod, 2026-09-10: after a failed update the card's Check Again did nothing.
 * `checkForUpdatesUI` writes "Fetching latest version..." into the
 * `#update-check-status` span beside the button before it sends the request,
 * and the failed card was the one card that rendered the button without the
 * span — so the handler threw on null, the request was never sent, and the
 * button sat disabled reading "Checking...". Dismiss re-rendered the plain
 * check state (which has the span) and only then did the check work.
 *
 * Two properties: the failed card renders the span, and the handler survives
 * a card that forgot it. Both functions are pulled out of server-settings.js
 * rather than evaluating the file (its top level wires up the whole page).
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SETTINGS_JS = readFileSync(join(process.cwd(), "public", "js", "server-settings.js"), "utf-8");

/** Pull one top-level function out of the file by brace matching (keeping a
 *  leading `async`, which checkForUpdatesUI has). */
function extractFn(src: string, name: string): string {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  if (src.slice(start - 6, start) === "async ") start -= 6;
  let depth = 0;
  let i = src.indexOf("{", start);
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

const FAILED_STATUS = {
  state: "failed",
  error: "git update failed: error: Your local changes to the following files would be overwritten by merge",
  steps: [
    { name: "Backup database", status: "done", message: "Backup skipped (disabled in settings)" },
    { name: "Pull latest code", status: "failed", message: "git update failed" },
    { name: "Install dependencies", status: "pending", message: "" },
  ],
};

type Harness = {
  renderFailed: (status: unknown) => void;
  check: () => Promise<void>;
  calls: { checkForUpdates: number };
};

/** Build both functions against a fake `api` whose check resolves as given. */
function harness(checkResult: unknown): Harness {
  const calls = { checkForUpdates: 0 };
  const api = {
    serverSettings: {
      checkForUpdates: async () => { calls.checkForUpdates++; return checkResult; },
      dismissUpdate: async () => {},
    },
  };
  const factory = new Function(
    "api",
    [
      "function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }",
      "function loadBackupHistory() {}",
      "function loadDatabaseInfo() {}",
      "function renderUpdateDisabled() {}",
      "function renderUpdateAvailable() {}",
      "function applyUpdateUI() {}",
      "var _dbLoaded = true;",
      extractFn(SETTINGS_JS, "renderUpdateFailed"),
      extractFn(SETTINGS_JS, "checkForUpdatesUI"),
      "return { renderFailed: renderUpdateFailed, check: checkForUpdatesUI };",
    ].join("\n"),
  ) as (api: unknown) => { renderFailed: (s: unknown) => void; check: () => Promise<void> };
  return { ...factory(api), calls };
}

describe("Update Failed card — Check Again", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="update-status-area"></div>';
  });

  it("renders the status span beside the Check Again button, like every other card", () => {
    const h = harness({ state: "up-to-date", currentVersion: "0.9.1" });
    h.renderFailed(FAILED_STATUS);
    const btn = document.getElementById("btn-check-updates");
    const span = document.getElementById("update-check-status");
    expect(btn).not.toBeNull();
    expect(span).not.toBeNull();
    expect(span!.parentElement).toBe(btn!.parentElement);
  });

  it("clicking Check Again sends the check and reports the result in the span", async () => {
    const h = harness({ state: "up-to-date", currentVersion: "0.9.1" });
    h.renderFailed(FAILED_STATUS);
    const btn = document.getElementById("btn-check-updates") as HTMLButtonElement;

    btn.click();
    // The click handler is async; let its awaits settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(h.calls.checkForUpdates).toBe(1);
    expect(document.getElementById("update-check-status")!.textContent).toContain("Up to date (v0.9.1)");
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe("Check for Updates");
  });

  it("the handler still sends the check when a card forgot the span", async () => {
    const h = harness({ state: "up-to-date", currentVersion: "0.9.1" });
    document.body.innerHTML = '<button id="btn-check-updates">Check Again</button>';

    await expect(h.check()).resolves.toBeUndefined();

    expect(h.calls.checkForUpdates).toBe(1);
    const btn = document.getElementById("btn-check-updates") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });
});
