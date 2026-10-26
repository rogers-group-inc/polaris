/**
 * tests/unit/eventsAlertsPanelDom.test.ts — the Events page's one Alerts
 * slide-over (public/js/events.js + public/events.html).
 *
 * Discovery conflicts used to have a slide-over of their own beside it. Both
 * are now views of one panel, and two things an operator reported are pinned:
 *   • the panel opens on the view that holds something (it used to open on
 *     "Stale reservations" while the only live item was a failed push), and
 *   • the badge is red for a pending conflict or a permanently failed push —
 *     the two things drawn red inside the panel — and yellow only for stale
 *     reservations or pushes still retrying.
 *
 * Only the two panel blocks of events.js are evaluated (sliced by their
 * section headers), over the panel markup sliced from events.html, so the
 * page's own boot code and its dozens of API calls stay out of it.
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

interface Fixture {
  conflicts: number;
  queued: number;
  failed: number;
  stale: number;
  canReview?: boolean;
}

type Win = Window & Record<string, any>;

async function boot(f: Fixture): Promise<{ win: Win; calls: string[] }> {
  const win = new Window() as Win;
  const calls: string[] = [];
  win.document.body.innerHTML = button + overlay;
  win.escapeHtml = (s: unknown) => String(s ?? "");
  win.showToast = () => {};
  win.showConfirm = async () => false;
  win.canReviewConflicts = () => f.canReview !== false;
  win.api = {
    conflicts: {
      count: async () => { calls.push("conflicts.count"); return { count: f.conflicts }; },
      list: async (q: { status: string }) => { calls.push(`conflicts.list:${q.status}`); return { conflicts: [] }; },
    },
    reservations: {
      pushQueueCount: async () => ({ count: f.queued, failed: f.failed }),
      alertsCount: async () => ({ count: f.stale }),
      listPushQueue: async () => { calls.push("listPushQueue"); return { reservations: [] }; },
      listAlerts: async (show: string) => { calls.push(`listAlerts:${show}`); return { alerts: [] }; },
      getStaleSettings: async () => ({ staleAfterDays: 60 }),
    },
  };
  win.eval(blocks);
  await settle();
  return { win, calls };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

async function openAlerts(win: Win): Promise<void> {
  (win.document.getElementById("btn-alerts") as unknown as HTMLButtonElement).click();
  await settle();
}

function badge(win: Win): { shown: boolean; text: string; background: string } {
  const el = win.document.getElementById("alerts-badge") as unknown as HTMLElement;
  return { shown: el.style.display === "block", text: el.textContent || "", background: el.style.background };
}

function view(win: Win): string {
  return (win.document.getElementById("alerts-panel-filter") as unknown as HTMLSelectElement).value;
}

describe("Events Alerts panel", () => {
  it("has no separate Conflicts button or slide-over any more", () => {
    expect(html).not.toContain('id="btn-conflicts"');
    expect(html).not.toContain('id="conflict-overlay"');
  });

  it("opens on the push queue when a failed push is the only thing live", async () => {
    const { win, calls } = await boot({ conflicts: 0, queued: 1, failed: 1, stale: 0 });
    await openAlerts(win);
    expect(view(win)).toBe("push-queue");
    expect(calls).toContain("listPushQueue");
    expect(calls.some((c) => c.startsWith("listAlerts"))).toBe(false);
  });

  it("opens on pending conflicts first, when there are any", async () => {
    const { win, calls } = await boot({ conflicts: 2, queued: 1, failed: 1, stale: 3 });
    await openAlerts(win);
    expect(view(win)).toBe("conflicts:pending");
    expect(calls).toContain("conflicts.list:pending");
  });

  it("opens on stale reservations ahead of pushes that are only retrying", async () => {
    const { win } = await boot({ conflicts: 0, queued: 2, failed: 0, stale: 1 });
    await openAlerts(win);
    expect(view(win)).toBe("active");
  });

  it("colours the badge red for a failed push and yellow for stale or retrying items", async () => {
    const failed = await boot({ conflicts: 0, queued: 1, failed: 1, stale: 0 });
    expect(badge(failed.win)).toMatchObject({ shown: true, text: "1" });
    expect(badge(failed.win).background).toContain("--color-danger");

    const conflict = await boot({ conflicts: 1, queued: 0, failed: 0, stale: 0 });
    expect(badge(conflict.win).background).toContain("--color-danger");

    const warning = await boot({ conflicts: 0, queued: 1, failed: 0, stale: 2 });
    expect(badge(warning.win)).toMatchObject({ shown: true, text: "3" });
    expect(badge(warning.win).background).toContain("--color-warning");

    const none = await boot({ conflicts: 0, queued: 0, failed: 0, stale: 0 });
    expect(badge(none.win).shown).toBe(false);
  });

  it("drops the conflict views for a role that cannot review conflicts", async () => {
    const { win, calls } = await boot({ conflicts: 0, queued: 0, failed: 0, stale: 1, canReview: false });
    expect(win.document.getElementById("alerts-filter-conflicts")).toBeNull();
    expect(calls).not.toContain("conflicts.count");
    await openAlerts(win);
    expect(view(win)).toBe("active");
  });

  it("does not paint a conflict list over a view the operator has switched to", async () => {
    const { win } = await boot({ conflicts: 1, queued: 0, failed: 0, stale: 0 });
    let release: () => void = () => {};
    win.api.conflicts.list = () => new Promise((r) => { release = () => r({ conflicts: [] }); });
    await openAlerts(win);
    const sel = win.document.getElementById("alerts-panel-filter") as unknown as HTMLSelectElement;
    sel.value = "push-queue";
    sel.dispatchEvent(new win.Event("change") as unknown as Event);
    await settle();
    release();
    await settle();
    const body = win.document.getElementById("alerts-panel-body")!.textContent || "";
    expect(body).toContain("No push-queued reservations");
    expect(body).not.toContain("No conflicts found");
  });
});
