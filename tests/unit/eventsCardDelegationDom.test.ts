/**
 * tests/unit/eventsCardDelegationDom.test.ts — the Events Alerts panel's card
 * verbs are ONE delegated listener on the panel body, bound once (CQ-F042).
 *
 * They used to be a dozen `querySelectorAll(...).forEach(addEventListener)`
 * loops run on every paint of a list that can hold thousands of conflict
 * cards. What is pinned, per view (conflicts, push queue, stale):
 *   • a card painted AFTER the listener was bound still answers its verb —
 *     the point of delegation;
 *   • a repaint does not make one click run a verb twice;
 *   • the per-element behaviour survives the move: a network link still
 *     cancels its navigation, Enter in a duplicate-IP row's address box still
 *     submits that row, a winner pill still flips only its own row.
 *
 * Only the two panel blocks of events.js are evaluated (sliced by their section
 * headers, as tests/unit/eventsAlertsPanelDom.test.ts does).
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

async function boot(): Promise<{ win: Win; calls: string[]; body: HTMLElement }> {
  const win = new Window() as Win;
  const calls: string[] = [];
  win.document.body.innerHTML = button + overlay;
  win.escapeHtml = (s: unknown) => String(s ?? "");
  win.showToast = () => {};
  win.showConfirm = async () => true;
  win.canReviewConflicts = () => true;
  win.api = {
    conflicts: {
      count: async () => ({ count: 1 }),
      list: async () => ({ conflicts: [] }),
      accept: async (id: string) => { calls.push(`accept:${id}`); },
      reject: async (id: string) => { calls.push(`reject:${id}`); },
      reassignIp: async (id: string, b: { assetId: string; ipAddress: string }) => {
        calls.push(`reassignIp:${id}:${b.assetId}:${b.ipAddress}`);
        return { resolved: true };
      },
    },
    reservations: {
      pushQueueCount: async () => ({ count: 1, failed: 0 }),
      alertsCount: async () => ({ count: 1 }),
      listPushQueue: async () => ({ reservations: [] }),
      listAlerts: async () => ({ alerts: [] }),
      getStaleSettings: async () => ({ staleAfterDays: 60 }),
      retryPush: async (id: string) => { calls.push(`retryPush:${id}`); return { outcome: "synced" }; },
      snoozeAlert: async (id: string) => { calls.push(`snooze:${id}`); return { daysAdded: 60 }; },
    },
  };
  win.eval(blocks);
  await settle();
  (win.document.getElementById("btn-alerts") as unknown as HTMLButtonElement).click();
  await settle();
  const body = win.document.getElementById("alerts-panel-body") as unknown as HTMLElement;
  return { win, calls, body };
}

function click(win: Win, el: Element): MouseEvent {
  const ev = new win.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as MouseEvent;
  el.dispatchEvent(ev);
  return ev;
}

function switchView(win: Win, value: string): Promise<void> {
  const sel = win.document.getElementById("alerts-panel-filter") as unknown as HTMLSelectElement;
  sel.value = value;
  sel.dispatchEvent(new win.Event("change") as unknown as Event);
  return settle();
}

const acceptCard =
  '<div class="conflict-card"><div class="conflict-card-actions">' +
  '<button data-conflict-action="accept" data-conflict-id="c1" data-conflict-kind="asset"><span>Accept</span></button>' +
  "</div></div>";

describe("Events Alerts panel — delegated card verbs", () => {
  it("binds the verbs once: no per-card loop is left in the paint", () => {
    const loads = blocks.slice(blocks.indexOf("async function loadConflicts"), blocks.indexOf("function resolvedActionsHtml"));
    expect(loads).not.toMatch(/querySelectorAll\([^)]*\)\.forEach\(function \(el\) \{\s*el\.addEventListener/);
    expect(blocks).not.toMatch(/\[data-pq-action\]"\)\.forEach/);
    expect(blocks).not.toMatch(/\[data-alert-action\]"\)\.forEach/);
  });

  it("runs a conflict verb on a card painted after the listener was bound, once per click across repaints", async () => {
    const { win, calls, body } = await boot();
    body.innerHTML = acceptCard;
    // A click on a child of the button reaches the button's verb, as before.
    click(win, body.querySelector("[data-conflict-action] span")!);
    await settle();
    expect(calls).toEqual(["accept:c1"]);

    // Repaint twice more (each verb repaints the list) — one click, one call.
    body.innerHTML = acceptCard;
    body.innerHTML = acceptCard;
    click(win, body.querySelector("[data-conflict-action]")!);
    await settle();
    expect(calls).toEqual(["accept:c1", "accept:c1"]);
  });

  it("ignores a click that lands on no verb", async () => {
    const { win, calls, body } = await boot();
    body.innerHTML = '<div class="conflict-card"><p class="x">not a verb</p></div>';
    click(win, body.querySelector(".x")!);
    await settle();
    expect(calls).toEqual([]);
  });

  it("flips only the clicked winner pill's own row", async () => {
    const { win, body } = await boot();
    const row = (f: string) =>
      `<tr data-field="${f}" data-winner="existing">` +
      '<td><button data-conflict-winner="existing" class="is-active">◀</button>' +
      '<button data-conflict-winner="proposed">▶</button></td></tr>';
    body.innerHTML = `<div class="conflict-card"><table><tbody>${row("hostname")}${row("model")}</tbody></table></div>`;
    const rows = body.querySelectorAll("tr");
    click(win, rows[0].querySelector('[data-conflict-winner="proposed"]')!);
    expect(rows[0].getAttribute("data-winner")).toBe("proposed");
    expect(rows[0].querySelector('[data-conflict-winner="proposed"]')!.classList.contains("is-active")).toBe(true);
    expect(rows[0].querySelector('[data-conflict-winner="existing"]')!.classList.contains("is-active")).toBe(false);
    expect(rows[1].getAttribute("data-winner")).toBe("existing");
  });

  it("submits a duplicate-IP row on Enter in its address box, and only that row", async () => {
    const { win, calls, body } = await boot();
    const row = (asset: string, ip: string) =>
      `<tr><td><input data-dupip-input="${asset}" value="${ip}"></td>` +
      `<td><button data-dupip-apply data-conflict-id="c9" data-asset-id="${asset}">Apply</button></td></tr>`;
    body.innerHTML = `<div class="conflict-card"><table><tbody>${row("a1", "10.0.0.7")}${row("a2", "10.0.0.8")}</tbody></table></div>`;
    const input = body.querySelectorAll("[data-dupip-input]")[1] as HTMLInputElement;
    const enter = new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as KeyboardEvent;
    input.dispatchEvent(enter);
    await settle();
    expect(enter.defaultPrevented).toBe(true);
    expect(calls).toEqual(["reassignIp:c9:a2:10.0.0.8"]);

    // Any other key is the box's own; Enter in an unrelated field is ignored.
    const other = new win.KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }) as unknown as KeyboardEvent;
    body.innerHTML = `<div class="conflict-card"><table><tbody>${row("a1", "10.0.0.7")}</tbody></table><input class="loose"></div>`;
    body.querySelector("[data-dupip-input]")!.dispatchEvent(other);
    const loose = new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as KeyboardEvent;
    body.querySelector(".loose")!.dispatchEvent(loose);
    await settle();
    expect(other.defaultPrevented).toBe(false);
    expect(loose.defaultPrevented).toBe(false);
    expect(calls).toEqual(["reassignIp:c9:a2:10.0.0.8"]);
  });

  it("still cancels a network link's navigation and opens the network in place", async () => {
    const { win, body } = await boot();
    const opened: unknown[] = [];
    win.PolarisPanels = { openNetwork: (id: string, o: unknown) => opened.push([id, o]) };
    body.innerHTML = '<div class="conflict-card"><a href="#" class="dupres-network-link" data-subnet-id="s1" data-ip="10.1.1.1" data-cidr="10.1.1.0/24">net</a></div>';
    const ev = click(win, body.querySelector(".dupres-network-link")!);
    expect(ev.defaultPrevented).toBe(true);
    expect(opened).toEqual([["s1", { focusIp: "10.1.1.1", subnetCidr: "10.1.1.0/24" }]]);
  });

  it("runs push-queue and stale verbs on cards painted after binding, once per click", async () => {
    const { win, calls, body } = await boot();
    await switchView(win, "push-queue");
    body.innerHTML = '<div><button data-pq-action="retry" data-pq-id="r1">Retry</button></div>';
    body.innerHTML = '<div><button data-pq-action="retry" data-pq-id="r1">Retry</button></div>';
    click(win, body.querySelector("[data-pq-action]")!);
    await settle();
    expect(calls).toEqual(["retryPush:r1"]);

    await switchView(win, "active");
    body.innerHTML = '<div><button data-alert-action="snooze" data-alert-id="r2">Snooze</button></div>';
    click(win, body.querySelector("[data-alert-action]")!);
    await settle();
    expect(calls).toEqual(["retryPush:r1", "snooze:r2"]);
  });
});
