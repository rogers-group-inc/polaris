/**
 * tests/unit/eventsConflictSourceLabelDom.test.ts — an asset identity card
 * names the integration that raised it.
 *
 * The card used to guess from two fields and fell back to "Entra ID" /
 * "Entra / Intune" for everything that was not vCenter or AD, so an Azure Arc
 * hostname collision (2026-11-24, prod) read as an Entra card. `GET /conflicts`
 * now sends `source` (conflictResolutionService → assetConflictSourceDescriptor)
 * and the card uses it; a response without it keeps the old guess.
 *
 * Only the two panel blocks of events.js are evaluated (sliced by their section
 * headers, as tests/unit/eventsCardDelegationDom.test.ts does).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const html = readFileSync(resolve(__dirname, "../../public/events.html"), "utf8");
const js = readFileSync(resolve(__dirname, "../../public/js/events.js"), "utf8");

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`marker not found: ${from} / ${to}`);
  return src.slice(a, b);
}

const button = slice(html, '<button class="btn btn-secondary" id="btn-alerts"', "<button class=\"btn btn-secondary btn-icon-only\"");
const overlay = slice(html, '<div class="slideover-overlay" id="alerts-overlay">', "<script ");
const conflictStart = js.indexOf("/* ─── Conflict views");
const alertsStart = js.indexOf("/* ─── Alerts Panel:");
const alertsEnd = js.indexOf("})();", alertsStart) + "})();".length;
const blocks = js.slice(conflictStart, alertsEnd);

type Win = Window & Record<string, any>;

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

const ARM = "/subscriptions/s1/resourcegroups/rg/providers/microsoft.hybridcompute/machines/rhel8test";

function arcCard(withSource: boolean) {
  return {
    id: "c1", entityType: "asset", status: "pending", assetId: "a1", proposedDeviceId: ARM,
    createdAt: "2026-11-24T12:00:00Z",
    asset: { id: "a1", hostname: "rhel8test" },
    existingAssetSnapshot: { hostname: "rhel8test", os: "Linux", osVersion: "8.10" },
    proposedAssetFields: {
      sourceType: "azurearc", hostname: "rhel8test", collisionReason: "untagged-collision",
      os: "Red Hat Enterprise Linux 8.10 (Ootpa)", osVersion: "4.18.0-553.el8_10.x86_64",
    },
    ...(withSource
      ? { source: { kind: "arc", platform: "Azure Arc", device: "Azure Arc machine", column: "Azure Arc" } }
      : {}),
  };
}

async function paint(conflicts: unknown[]): Promise<HTMLElement> {
  const win = new Window() as Win;
  win.document.body.innerHTML = button + overlay;
  win.escapeHtml = (s: unknown) => String(s ?? "");
  win.copyIpHtml = (s: unknown) => String(s ?? "");
  win.showToast = () => {};
  win.showConfirm = async () => true;
  win.canReviewConflicts = () => true;
  win.api = {
    conflicts: { count: async () => ({ count: 1 }), list: async () => ({ conflicts }) },
    reservations: {
      pushQueueCount: async () => ({ count: 0, failed: 0 }),
      alertsCount: async () => ({ count: 0 }),
      listPushQueue: async () => ({ reservations: [] }),
      listAlerts: async () => ({ alerts: [] }),
      getStaleSettings: async () => ({ staleAfterDays: 60 }),
    },
  };
  win.eval(blocks);
  await settle();
  (win.document.getElementById("btn-alerts") as unknown as HTMLButtonElement).click();
  await settle();
  return win.document.getElementById("alerts-panel-body") as unknown as HTMLElement;
}

describe("asset identity card — the source label", () => {
  it("an Azure Arc card names Azure Arc in its badge, explainer and right-hand column", async () => {
    const body = await paint([arcCard(true)]);
    const text = body.textContent ?? "";
    expect(text).toContain("Azure Arc machine");
    expect(text).toContain("no Azure Arc link");
    const headers = Array.from(body.querySelectorAll("th")).map((th) => th.textContent?.trim());
    expect(headers).toContain("Azure Arc");
    expect(headers).not.toContain("Entra / Intune");
    expect(text).not.toContain("Entra");
  });

  it("a response without `source` keeps the old guess", async () => {
    const body = await paint([arcCard(false)]);
    const headers = Array.from(body.querySelectorAll("th")).map((th) => th.textContent?.trim());
    expect(headers).toContain("Entra / Intune");
  });
});
