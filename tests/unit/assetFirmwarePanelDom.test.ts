/**
 * tests/unit/assetFirmwarePanelDom.test.ts — the Firmware card on the asset
 * details System tab (`assetFirmwarePanelHTML` and friends in
 * public/js/assets.js; business rule 87).
 *
 * The card is the only place an operator sees what the Repository can do to
 * THIS device, so what is pinned is the state vocabulary the server hands it
 * and what each state withholds: the Upgrade verb is fullwrite-only (the
 * facts stay visible at read); a running flash shows stage and percent and no
 * verb; a card for a server or firewall does not exist at all; and the
 * approval dialog names the exact image — version, platform, file, hash —
 * with the button dead until the operator says they checked it.
 *
 * assets.js is a ~20k-line browser script with no module boundary, so the
 * functions under test are sliced out by name and eval'd — the approach of
 * tests/unit/assetAgentPanelOfferDom.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, any>;
const assetsLines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

function fnSrc(name: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}
function varSrc(name: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(`var ${name} = `));
  if (start < 0) throw new Error(`assets.js: var ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i >= start && /;\s*$/.test(l));
  return assetsLines.slice(start, end + 1).join("\n");
}

let level = "fullwrite";
const RANK: Record<string, number> = { none: 0, read: 1, write: 2, fullwrite: 3 };

beforeEach(() => {
  level = "fullwrite";
  g.escapeHtml = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.timeAgo = () => "5 minutes ago";
  g.formatBytes = (n: number) => n + " B";
  g.permAtLeast = (key: string, want: string) => key === "firmware" && RANK[level] >= RANK[want];
  for (const name of ["_assetFirmwareEligible", "_fwBadge", "_fwImageLine", "_fwRunResultHTML", "_fwStageRow", "_fwProgressHTML", "_fwRunHistoryHTML", "assetFirmwarePanelHTML", "_fwApprovalBlockHTML", "_fwApprovalModalHTML"]) {
    (0, eval)(fnSrc(name));
  }
  (0, eval)(varSrc("_FW_STAGE_LABELS"));
});

const asset = (over: Record<string, unknown> = {}) => ({ id: "a1", hostname: "lab-sw1", ipAddress: "10.0.0.5", serialNumber: "S108FFTF23001234", assetType: "switch", ...over });
const image = (over: Record<string, unknown> = {}) => ({
  id: "img-1", manufacturer: "Fortinet", assetType: "switch", model: "FortiSwitch S108FF", platform: "S108FF", versionLabel: "7.6.8 build1164",
  role: "primary", filename: "FSW_108F-v7-build1164-FORTINET.out", sizeBytes: 45678901, sha256: "deadbeef", uploadedBy: "dmoore", uploadedAt: "2026-09-20T14:02:00Z", ...over,
});
const fw = (over: Record<string, unknown> = {}) => ({
  state: "available", available: true, reason: null, engine: "fortiswitch-https", platform: "S108FF", current: "7.4.3 build0542",
  image: image(), backupImage: null, credential: { credentialId: "c1", credentialName: "FSW admin", scope: "manufacturer" }, blockers: [], activeRun: null, lastRun: null, ...over,
});
function render(a: Record<string, unknown>, f: unknown): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = g.assetFirmwarePanelHTML(a, f);
  return host;
}
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("who gets a card", () => {
  it("switches and access points only", () => {
    expect(g._assetFirmwareEligible(asset())).toBe(true);
    expect(g._assetFirmwareEligible(asset({ assetType: "access_point" }))).toBe(true);
    expect(g._assetFirmwareEligible(asset({ assetType: "server" }))).toBe(false);
    expect(g._assetFirmwareEligible(asset({ assetType: "firewall" }))).toBe(false);
    expect(g.assetFirmwarePanelHTML(asset({ assetType: "server" }), fw())).toBe("");
    expect(g.assetFirmwarePanelHTML(asset(), null)).toBe("");
  });
});

describe("the states, in the server's words", () => {
  it("unsupported: the reason, no verb", () => {
    const r = render(asset(), fw({ state: "unsupported", available: false, reason: "No upgrade engine for Aruba switches — images can be stored in the Repository but Polaris cannot apply them.", image: null }));
    expect(text(r)).toContain("Not supported");
    expect(text(r)).toContain("No upgrade engine for Aruba switches");
    expect(r.querySelector("#btn-fw-upgrade")).toBeNull();
  });
  it("no-image: the reason and a link to the Repository", () => {
    const r = render(asset(), fw({ state: "no-image", available: false, reason: "No firmware is in the Repository for Fortinet switches.", image: null }));
    expect(text(r)).toContain("No image");
    expect(r.querySelector('a[href="/server-settings.html?tab=firmware"]')).not.toBeNull();
  });
  it("up-to-date: the Current badge", () => {
    const r = render(asset(), fw({ state: "up-to-date", available: false, reason: "No Repository image is newer than 7.6.8 build1164.", current: "7.6.8 build1164", image: null }));
    expect(text(r)).toContain("Current");
    expect(text(r)).toContain("Running 7.6.8 build1164");
  });
  it("no-credential: amber, the image still shown, the link", () => {
    const r = render(asset(), fw({ state: "no-credential", available: false, reason: "7.6.8 build1164 is available, but no device admin login is bound…", credential: null }));
    expect(text(r)).toContain("No login bound");
    expect(r.querySelector("#btn-fw-upgrade")).toBeNull();
  });
  it("available at fullwrite: the facts and the verb, naming the version", () => {
    const r = render(asset(), fw());
    expect(text(r)).toContain("Upgrade available");
    expect(text(r)).toContain("Current: 7.4.3 build0542");
    expect(text(r)).toContain("Available: 7.6.8 build1164 (S108FF)");
    expect(text(r)).toContain("Login: FSW admin (manufacturer binding)");
    expect(text(r.querySelector("#btn-fw-upgrade"))).toBe("Upgrade firmware to 7.6.8 build1164…");
    expect(r.querySelector("#btn-fw-history")).not.toBeNull();
  });
  it("available at write: the facts, the hint, no verb", () => {
    level = "write";
    const r = render(asset(), fw());
    expect(text(r)).toContain("Available: 7.6.8 build1164");
    expect(r.querySelector("#btn-fw-upgrade")).toBeNull();
    expect(text(r)).toMatch(/needs Full Read-Write on Firmware Repository/);
  });
  it("names the backup when it is also eligible", () => {
    const r = render(asset(), fw({ backupImage: image({ id: "img-2", role: "backup", versionLabel: "7.6.5 build1105" }) }));
    expect(text(r)).toContain("Also eligible: 7.6.5 build1105 (S108FF) (the model’s backup)");
  });
  it("running: stage, percent rows done/active, step, no verb", () => {
    const run = { id: "run-1", status: "running", stage: "deploying", fromVersion: "7.4.3 build0542", toVersion: "7.6.8 build1164", progress: { erase: 100, write: 40, verify: 0, curStep: 2, totStep: 5 }, startedAt: "2026-09-25T01:00:00Z" };
    const r = render(asset(), fw({ state: "running", available: false, activeRun: run }));
    expect(text(r)).toContain("Upgrading");
    expect(text(r)).toContain("Stage: Deploying · step 2 of 5");
    const rows = Array.from(r.querySelectorAll(".fw-stage"));
    expect(rows.map((x) => text(x.querySelector(".fw-stage-label")))).toEqual(["Erasing flash", "Writing image", "Verifying image"]);
    expect(rows[0]!.classList.contains("is-done")).toBe(true);
    expect(rows[1]!.classList.contains("is-active")).toBe(true);
    expect((rows[1]!.querySelector(".fw-progress-fill") as HTMLElement).getAttribute("style")).toMatch(/width:40%/);
    expect(r.querySelector("#btn-fw-upgrade")).toBeNull();
    expect(r.querySelector("#asset-fw-progress")).not.toBeNull();
  });
  it("rebooting and verifying draw indeterminate rows once reached", () => {
    const r = render(asset(), fw({ state: "running", available: false, activeRun: { id: "r", status: "running", stage: "verifying", toVersion: "7.6.8 build1164", progress: { erase: 100, write: 100, verify: 100 } } }));
    const labels = Array.from(r.querySelectorAll(".fw-stage")).map((x) => text(x.querySelector(".fw-stage-label")));
    expect(labels).toEqual(["Erasing flash", "Writing image", "Verifying image", "Rebooting", "Verifying new version"]);
    expect(r.querySelectorAll(".fw-progress.is-indeterminate")).toHaveLength(1);
  });
  it("shows the last run's result under the facts: succeeded, unverified, failed", () => {
    expect(text(render(asset(), fw({ lastRun: { status: "succeeded", result: "upgraded", verifiedVersion: "7.6.8 build1164", toVersion: "7.6.8 build1164", finishedAt: "2026-09-25T01:20:00Z" } })))).toContain("Upgraded to 7.6.8 build1164, 5 minutes ago");
    expect(text(render(asset(), fw({ lastRun: { status: "unverified", toVersion: "7.6.8 build1164", error: "no answer" } })))).toMatch(/couldn’t confirm the version/);
    const failed = render(asset(), fw({ lastRun: { status: "failed", stage: "staging", toVersion: "7.6.8 build1164", error: "the switch did not accept the image (500)" } }));
    expect(text(failed)).toContain("Upgrade to 7.6.8 build1164 failed at uploading image: the switch did not accept the image (500)");
  });
  it("an error reading availability is one honest line", () => {
    const r = render(asset(), { error: "request failed" });
    expect(text(r)).toContain("Couldn’t read upgrade status: request failed");
    expect(r.querySelector("#btn-fw-history")).toBeNull();
  });
});

describe("the approval dialog", () => {
  it("names the device and every fact about the image, and no radio when there is one image", () => {
    const host = document.createElement("div");
    host.innerHTML = g._fwApprovalModalHTML(asset(), fw());
    const t = text(host);
    expect(t).toContain("lab-sw1 (10.0.0.5)");
    expect(t).toContain("S108FFTF23001234");
    expect(Array.from(host.querySelectorAll("dd")).map(text)).toContain("7.4.3 build0542");
    expect(t).toContain("FSW admin (manufacturer binding)");
    expect(t).toContain("7.6.8 build1164 · the model’s primary image");
    expect(t).toContain("FSW_108F-v7-build1164-FORTINET.out (45678901 B)");
    expect(t).toContain("deadbeef");
    expect(t).toContain("Fortinet › switch › FortiSwitch S108FF");
    expect(host.querySelectorAll('input[name="fw-approve-image"]')).toHaveLength(1);
    expect((host.querySelector('input[name="fw-approve-image"]') as HTMLElement).getAttribute("style")).toMatch(/display:none/);
    expect(host.querySelector("#fw-approve-ack")).not.toBeNull();
    expect(t).toMatch(/reboots during the upgrade/);
  });
  it("offers the backup as a second radio with the primary checked", () => {
    const host = document.createElement("div");
    host.innerHTML = g._fwApprovalModalHTML(asset(), fw({ backupImage: image({ id: "img-2", role: "backup", versionLabel: "7.6.5 build1105" }) }));
    const radios = Array.from(host.querySelectorAll('input[name="fw-approve-image"]')) as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(["img-1", "img-2"]);
    expect(radios[0]!.hasAttribute("checked")).toBe(true);
    expect(radios[1]!.hasAttribute("checked")).toBe(false);
    expect(text(host)).toContain("the backup is this model’s previous image");
    expect(text(host)).toContain("7.6.5 build1105 · the model’s backup image");
  });
});
