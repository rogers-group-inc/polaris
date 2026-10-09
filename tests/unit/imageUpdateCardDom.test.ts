/**
 * tests/unit/imageUpdateCardDom.test.ts — the Application Updates card on a
 * container install (`renderImageUpdate` in server-settings.js).
 *
 * A container updates by pulling a newer image, so the card keeps the
 * version, the daily registry check and how to update, and drops what only
 * the in-app updater uses: the update train, the pre-update backup toggle
 * and the git history. It never offers Apply. Pinned here so the git-path
 * controls cannot creep back onto a Docker install's card.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SETTINGS_JS = readFileSync(join(process.cwd(), "public", "js", "server-settings.js"), "utf-8");

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

let renderImageUpdate: (status: unknown) => void;

/** The card's static skeleton, as the Maintenance tab renders it. */
const CARD =
  '<div id="update-card">' +
    '<p id="update-card-intro">Check for new versions and apply updates directly from the browser.</p>' +
    '<div id="update-status-area"></div>' +
    '<div id="update-repo-info">Update source: x</div>' +
    '<div id="update-train-section"><select id="update-train-select"></select></div>' +
    '<div id="update-backup-section"><input type="checkbox" id="update-backup-checkbox"></div>' +
    '<details id="update-history"></details>' +
  '</div>';

beforeEach(() => {
  document.body.innerHTML = CARD;
  const factory = new Function(
    [
      "function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;'); }",
      "function formatLocalTime(s) { return String(s); }",
      "function checkForUpdatesUI() {}",
      extractFn(SETTINGS_JS, "_applyImageUpdateLayout"),
      extractFn(SETTINGS_JS, "renderImageUpdate"),
      "return renderImageUpdate;",
    ].join("\n"),
  );
  renderImageUpdate = factory();
});

const AVAILABLE = {
  state: "available",
  updateMethod: "image",
  image: "ghcr.io/rogers-group-inc/polaris:latest",
  currentVersion: "0.9.3951",
  latestVersion: "0.9.3962",
  latestCommit: "43f9a1c",
  commitsBehind: 11,
  source: "https://github.com/rogers-group-inc/polaris",
  checkedAt: "2026-10-09T15:00:00Z",
  method: "To update, pull the latest image and recreate the container.",
};

describe("Application Updates card on a container install", () => {
  it("removes the update train, the backup toggle and the git history", () => {
    renderImageUpdate({ ...AVAILABLE, state: "up-to-date" });
    expect(document.getElementById("update-train-section")).toBeNull();
    expect(document.getElementById("update-backup-section")).toBeNull();
    expect(document.getElementById("update-history")).toBeNull();
    expect(document.getElementById("update-repo-info")!.textContent).toBe("");
    expect(document.getElementById("update-card-intro")!.textContent).toMatch(/once a day/);
  });

  it("names the newer build and how to update, with no Apply button", () => {
    renderImageUpdate(AVAILABLE);
    const area = document.getElementById("update-status-area")!;
    expect(area.textContent).toContain("Update Available");
    expect(area.textContent).toContain("v0.9.3962");
    expect(area.textContent).toContain("11 commits newer");
    expect(area.textContent).toContain("pull the latest image");
    expect(document.getElementById("btn-apply-update")).toBeNull();
    const link = area.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://github.com/rogers-group-inc/polaris/commits/43f9a1c");
    expect(document.getElementById("btn-check-updates")!.textContent).toBe("Check Again");
  });

  it("says up to date, and keeps a Check for Updates button", () => {
    renderImageUpdate({ ...AVAILABLE, state: "up-to-date", commitsBehind: 0 });
    expect(document.getElementById("update-check-status")!.textContent).toMatch(/Up to date with ghcr\.io/);
    expect(document.getElementById("btn-check-updates")!.textContent).toBe("Check for Updates");
  });

  it("shows why a check could not compare", () => {
    renderImageUpdate({ state: "disabled", updateMethod: "image", currentVersion: "0.9.3951", note: "Couldn't check ghcr.io: 503" });
    expect(document.getElementById("update-check-status")!.textContent).toContain("Couldn't check ghcr.io: 503");
  });

  it("says not checked yet before the first check", () => {
    renderImageUpdate({ state: "disabled", updateMethod: "image", currentVersion: "0.9.3951" });
    expect(document.getElementById("update-check-status")!.textContent).toMatch(/Not checked yet/);
  });
});
