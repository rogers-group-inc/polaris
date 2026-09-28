/**
 * tests/unit/assetAlertsTabDom.test.ts — the asset-details Alerts tab's active
 * list (public/js/assets.js).
 *
 * The tab shipped as a per-row surface, which held up only while an asset had
 * one alert. A per-interface automation on a switch that loses its uplink
 * raises one alert per pinned port, all in the same minute, all rendering the
 * automation's one message template — so the operator saw two dozen identical
 * rows, no way to tell which port each was about, and no way to see that
 * clearing one had done anything.
 *
 * What's pinned here is what makes that list usable and would rot silently:
 *  - the dimension (the interface / sensor the alert is ABOUT), since without
 *    it the rows are genuinely indistinguishable. It rides the Alert cell's
 *    title rather than a Detail column of its own — that column restated the
 *    sentence, which already carries the label;
 *  - the Acknowledge column carrying what the acknowledger WROTE, which is the
 *    whole point of requireAckNote and was stored-and-never-rendered until it
 *    got a column;
 *  - the empty-state colspan tracking the permission-dependent column count;
 *  - equal-timestamp ordering by dimension, numerically (port2 before port10);
 *  - the select/bulk wiring, including that a reload does NOT stack a second
 *    handler on the persistent bulk buttons — that bug fires N batches on the
 *    Nth click, and clearing twice as many alerts as asked is not recoverable
 *    from the UI;
 *  - action toasts reporting the SERVER's count, which is how "I clicked Clear
 *    and nothing happened" becomes "that alert was already cleared".
 *
 * assets.js is a ~17k-line browser script with no module boundary, so the
 * functions under test are sliced out by name and eval'd with the app-shell
 * globals stubbed — the approach of tests/unit/assetInterfacesTableDom.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { APP_SHELL_STUBS } from "./_appShellStubs.js";

const g = globalThis as Record<string, any>;

const SPLIT = /\r?\n/;

const assetsLines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(SPLIT);
// Two of the functions the tab calls — the severity colour and the severity
// rank behind its strobe — live in app.js, because the global search dropdown
// draws the same dot on pages that never load assets.js. The slicer falls
// through to app.js rather than pinning which file each name is in: this test
// is about the tab's behaviour, not about where the source happens to sit.
const appLines = readFileSync(resolve(__dirname, "../../public/js/app.js"), "utf8").split(SPLIT);
// The panel states the resulting wall-clock time using the SHARED helper the
// settings cards and the wizard also read, so load the real module rather than
// stub it — the point of the assertion is that the two halves agree.
const DOWN_AFTER_SRC = readFileSync(resolve(__dirname, "../../public/js/monitor-down-after.js"), "utf8");

/** Slice a top-level `[async ]function NAME(...) {` … `}` block out of assets.js, else app.js. */
function fnSrc(name: string): string {
  for (const [file, lines] of [["assets.js", assetsLines], ["app.js", appLines]] as const) {
    const start = lines.findIndex(
      (l) => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`),
    );
    if (start < 0) continue;
    const end = lines.findIndex((l, i) => i > start && l === "}");
    if (end < 0) throw new Error(`${file}: no end of function ${name}`);
    return lines.slice(start, end + 1).join("\n");
  }
  throw new Error(`function ${name} not found in assets.js or app.js`);
}

const FN_NAMES = [
  "_assetAlertTableShape",
  "_assetNotificationsTabHTML",
  "_sortAssetAlerts",
  "_loadAssetNotificationsTab",
  // Paints the "which automation decides Down for this device" panel above the
  // tables. Sliced in because _loadAssetNotificationsTab calls it directly.
  "_paintAssetDownDetectionPanel",
  "_wireAssetAlertSelection",
  // The tab's own strobe — painted from the alerts the tab just loaded, so it
  // settles on acknowledge/clear without a second fetch.
  "_paintAssetAlertsTabStrobe",
  "assetAlertStrobeColor",
  "_alertSevRank",
  "_alertCountLabel",
  "_ackPromptOpts",
  "_promptAckNote",
  "_acknowledgeAssetAlert",
  "_clearAssetAlert",
  "_bulkAcknowledgeAssetAlerts",
  "_bulkClearAssetAlerts",
  // The matching-automations table's Scope cell.
  "_assetRuleScopeText",
];

/** Two ports of one switch, down together — the shape that motivated all this. */
function makeAlerts() {
  return [
    { id: "n2", severity: "serious", message: "LAKESIDE-148F-1: a monitored interface is down", dimension: "port10", metric: "ifOperStatus", triggeredAt: "2026-07-23T14:50:00Z", acknowledged: false },
    { id: "n1", severity: "serious", message: "LAKESIDE-148F-1: a monitored interface is down", dimension: "port2", metric: "ifOperStatus", triggeredAt: "2026-07-23T14:50:00Z", acknowledged: false },
    { id: "n0", severity: "warning", message: "LAKESIDE-148F-1 is down", dimension: null, metric: "monitorStatus", triggeredAt: "2026-07-22T14:50:00Z", acknowledged: true, acknowledgedBy: "jsmith", acknowledgedAt: "2026-07-22T15:00:00Z", acknowledgeNote: "Bad SFP in the uplink — swapped it, monitoring" },
  ];
}

interface Ctx {
  acked: { ids: string[]; note?: string }[];
  cleared: string[][];
  toasts: { msg: string; type: string }[];
  ackResult: () => any;
  clearResult: () => any;
}

let ctx: Ctx;

/** Mount the tab shell and run one load against the stubbed API. */
async function mount(opts?: { perm?: string; alerts?: any[]; downDetection?: any }) {
  const perm = opts?.perm ?? "fullwrite";
  const RANK: Record<string, number> = { none: 0, read: 1, write: 2, fullwrite: 3 };
  g.permAtLeast = (_key: string, level: string) => RANK[perm] >= RANK[level];
  g.escapeHtml = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  g.showToast = (msg: string, type?: string) => ctx.toasts.push({ msg, type: type || "success" });
  g.showConfirm = vi.fn(async () => true);
  // The module is an IIFE that assigns onto `window`.
  g.window = g.window || g;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("window", DOWN_AFTER_SRC)(g.window);
  g.api = {
    assets: {
      alerts: vi.fn(async () => ({ active: opts?.alerts ?? makeAlerts(), matchingRules: [] })),
      // Read by the down-detection panel. Default: a covered device.
      effectiveMonitorSettings: vi.fn(async () => ({
        resolved: { intervalSeconds: 60, probeTimeoutMs: 5000 },
        downDetection: opts?.downDetection ?? { passive: false, missedPolls: 3, automationName: "Asset down", conflict: null },
      })),
    },
    alerts: {
      acknowledge: vi.fn(async (ids: string[], note?: string) => { ctx.acked.push({ ids, note }); return ctx.ackResult(); }),
      clear: vi.fn(async (ids: string[]) => { ctx.cleared.push(ids); return ctx.clearResult(); }),
    },
  };
  // _loadAssetNotificationsTab's other half (the matching-automations table) is
  // out of scope here; stub the two hooks it reaches for.
  g._assetRuleSentences = () => Promise.resolve(null);
  g._renderAssetRuleRows = vi.fn();

  // The slide-over's real tab strip, so the tab strobe has something to mark.
  document.body.innerHTML =
    `<div class="page-tabs" id="asset-view-tabs">` +
    `<button type="button" class="page-tab active" data-tab="general">General</button>` +
    `<button type="button" class="page-tab" data-tab="notifications">Alerts</button>` +
    `</div>` +
    `<div id="tab">${g._assetNotificationsTabHTML()}</div>`;
  g._loadAssetNotificationsTab("A1");
  await new Promise((r) => setTimeout(r, 0));
}

// The sliced functions call each other by name, so they have to land on
// globalThis rather than in a Function body's scope.
// APP_SHELL_STUBS carries the app.js helpers these functions call as free
// variables in the browser (syncSelectedRows, the form parts).
const SRC = APP_SHELL_STUBS + "\n" + FN_NAMES.map(fnSrc).join("\n") + "\n" + FN_NAMES.map((n) => `globalThis.${n} = ${n};`).join("\n");

beforeEach(() => {
  ctx = {
    acked: [], cleared: [], toasts: [],
    ackResult: () => ({ acknowledged: 1 }),
    clearResult: () => ({ cleared: 1 }),
  };
  // Owned by the suite, not by mount(), so a test can set its return value
  // before mounting without having it replaced underneath.
  // showPrompt, not window.prompt: the note dialog is a Polaris modal (the
  // browser box is unstyled, dead in the installed PWA, and can't mark a field
  // required — which requireAckNote needs).
  g.showPrompt = vi.fn(async () => "");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(SRC)();
});

const rows = () => Array.from(document.querySelectorAll("#asset-notif-active-tbody tr"));
const cell = (tr: Element, i: number) => (tr.children[i] as HTMLElement).textContent!.trim();

describe("asset Alerts tab — automations Scope cell", () => {
  const scopeText = (sc: any) => g._assetRuleScopeText(sc);
  afterEach(() => { delete g.window._ruleSchema; });

  it("spells out a condition-built scope instead of a dash", () => {
    g.window = g.window || g;
    g.window._ruleSchema = { scopeCondition: { fields: [{ field: "assetType", label: "Device type" }], operatorLabels: { equals: "equals" } } };
    expect(scopeText({ condition: { op: "and", children: [{ field: "assetType", operator: "equals", value: "server" }] } }))
      .toBe("Device type equals server");
  });

  it("falls back to raw field names when the schema is not loaded", () => {
    expect(scopeText({ condition: { op: "or", children: [{ field: "tag", operator: "has", value: "dc" }, { field: "tag", operator: "has", value: "core" }] } }))
      .toBe("tag has dc OR tag has core");
  });

  it("reads all-assets and the flat dimensions", () => {
    expect(scopeText({ allAssets: true })).toBe("All assets");
    expect(scopeText({ assetTypes: ["server"], tags: ["dc"] })).toBe("types: server; tags: dc");
  });
});

describe("asset Alerts tab — active list", () => {
  it("freezes the header by scrolling inside the table, not the panel", async () => {
    await mount();
    const wrap = document.querySelector(".table-wrapper-modal-sticky") as HTMLElement;
    expect(wrap).toBeTruthy();
    // Self-bounding: the sticky-thead CSS only helps if the wrapper is what
    // scrolls, which needs a height bound. No JS sizer runs in a slide-over.
    expect(wrap.style.maxHeight).toBeTruthy();
    expect(wrap.querySelector("thead")).toBeTruthy();
  });

  // cb(0) time(1) severity(2) alert(3) acknowledge(4) actions(5)
  const ALERT_COL = 3, ACK_COL = 4, ACTIONS_COL = 5;

  it("names the dimension each alert was raised for, on the Alert cell", async () => {
    await mount();
    // The metric and the dimension identify what the sentence's `[label]` IS,
    // on the cell rather than in a column that would repeat one value down the
    // whole table and restate the message besides.
    const titles = rows().map((tr) => (tr.children[ALERT_COL] as HTMLElement).getAttribute("title"));
    expect(titles.slice(0, 2)).toEqual(["ifOperStatus · port2", "ifOperStatus · port10"]);
    // A whole-device alert has no dimension: the metric alone, no dangling
    // separator.
    expect(titles[2]).toBe("monitorStatus");
    expect(rows().map((tr) => cell(tr, ALERT_COL))).toEqual([
      "LAKESIDE-148F-1: a monitored interface is down",
      "LAKESIDE-148F-1: a monitored interface is down",
      "LAKESIDE-148F-1 is down",
    ]);
  });

  it("shows what the acknowledger wrote, with who and when under it", async () => {
    await mount();
    const ack = cell(rows()[2], ACK_COL);
    expect(ack).toContain("Bad SFP in the uplink — swapped it, monitoring");
    expect(ack).toContain("jsmith");
    // The attribution moved OUT of Actions when the note got a column, so the
    // acknowledger's name must not render twice.
    expect(cell(rows()[2], ACTIONS_COL)).not.toContain("jsmith");
    // An unacknowledged row has nothing to say here, and must not print blank.
    expect(cell(rows()[0], ACK_COL)).toBe("—");
  });

  it("distinguishes acknowledged-with-no-note from unacknowledged", async () => {
    // The note is optional unless the automation sets requireAckNote, so a
    // silent acknowledgement is a real state — and rendering it as an em dash
    // would make it read as nobody having touched the alert.
    await mount({
      alerts: [{ id: "q1", severity: "warning", message: "x is down", dimension: null, metric: "monitorStatus", triggeredAt: "2026-07-22T14:50:00Z", acknowledged: true, acknowledgedBy: "jsmith", acknowledgedAt: "2026-07-22T15:00:00Z", acknowledgeNote: null }],
    });
    const ack = cell(rows()[0], ACK_COL);
    expect(ack).toContain("No note");
    expect(ack).toContain("jsmith");
  });

  it("orders equal timestamps by dimension, numerically", async () => {
    const sorted = g._sortAssetAlerts(makeAlerts());
    // Same minute → port2 before port10 (a plain string sort inverts these).
    expect(sorted.map((a: any) => a.id)).toEqual(["n1", "n2", "n0"]);
  });

  it("counts the active alerts in the heading", async () => {
    await mount();
    expect(document.getElementById("asset-notif-active-count")!.textContent).toBe("(3)");
    await mount({ alerts: [] });
    expect(document.getElementById("asset-notif-active-count")!.textContent).toBe("");
  });

  it("spans the empty state across every column that renders", async () => {
    await mount({ alerts: [] });
    const td = document.querySelector("#asset-notif-active-tbody td") as HTMLElement;
    const headers = document.querySelectorAll("#tab thead th").length - 3; // minus the rules table's 3
    expect(Number(td.getAttribute("colspan"))).toBe(headers);
    expect(Number(td.getAttribute("colspan"))).toBe(6);
  });
});

describe("asset Alerts tab — selection + bulk actions", () => {
  it("enables the bulk buttons only once something is selected", async () => {
    await mount();
    const ack = document.getElementById("asset-alert-bulk-ack") as HTMLButtonElement;
    const clr = document.getElementById("asset-alert-bulk-clear") as HTMLButtonElement;
    expect(ack.disabled).toBe(true);
    expect(clr.disabled).toBe(true);
    expect(document.getElementById("asset-alert-selcount")!.textContent).toBe("None selected");

    const boxes = Array.from(document.querySelectorAll<HTMLInputElement>(".asset-alert-sel"));
    boxes[0].checked = true;
    boxes[0].dispatchEvent(new Event("change"));
    expect(ack.disabled).toBe(false);
    expect(clr.disabled).toBe(false);
    expect(document.getElementById("asset-alert-selcount")!.textContent).toBe("1 selected");
    // Partial selection: the header box reads as neither on nor off.
    const all = document.getElementById("asset-alert-selall") as HTMLInputElement;
    expect(all.indeterminate).toBe(true);
    expect(all.checked).toBe(false);
  });

  it("select-all takes every rendered row", async () => {
    await mount();
    const all = document.getElementById("asset-alert-selall") as HTMLInputElement;
    all.checked = true;
    all.dispatchEvent(new Event("change"));
    expect(document.querySelectorAll<HTMLInputElement>(".asset-alert-sel:checked").length).toBe(3);
    expect(document.getElementById("asset-alert-selcount")!.textContent).toBe("3 selected");
    expect(all.indeterminate).toBe(false);
  });

  it("clears the whole selection in ONE request, confirmed with the count", async () => {
    ctx.clearResult = () => ({ cleared: 3 });
    await mount();
    const all = document.getElementById("asset-alert-selall") as HTMLInputElement;
    all.checked = true;
    all.dispatchEvent(new Event("change"));
    (document.getElementById("asset-alert-bulk-clear") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));

    expect(g.showConfirm).toHaveBeenCalledTimes(1);
    expect(String((g.showConfirm as any).mock.calls[0][0])).toContain("3 alerts");
    expect(ctx.cleared).toEqual([["n1", "n2", "n0"]]);
    expect(ctx.toasts.at(-1)).toEqual({ msg: "Cleared 3 alerts", type: "success" });
  });

  it("acknowledges the selection with one shared note", async () => {
    ctx.ackResult = () => ({ acknowledged: 2 });
    (g.showPrompt as any).mockResolvedValue("switch reboot");
    await mount();
    const boxes = Array.from(document.querySelectorAll<HTMLInputElement>(".asset-alert-sel"));
    boxes[0].checked = true; boxes[0].dispatchEvent(new Event("change"));
    boxes[1].checked = true; boxes[1].dispatchEvent(new Event("change"));
    (document.getElementById("asset-alert-bulk-ack") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));

    expect(ctx.acked).toEqual([{ ids: ["n1", "n2"], note: "switch reboot" }]);
    expect(ctx.toasts.at(-1)!.msg).toBe("Acknowledged 2 alerts");
  });

  it("cancelling the note prompt sends nothing", async () => {
    (g.showPrompt as any).mockResolvedValue(null);
    await mount();
    const all = document.getElementById("asset-alert-selall") as HTMLInputElement;
    all.checked = true;
    all.dispatchEvent(new Event("change"));
    (document.getElementById("asset-alert-bulk-ack") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.acked).toEqual([]);
  });

  it("asks for the note in a Polaris modal, with the same question the ack page asks", async () => {
    await mount();
    (document.querySelector(".asset-alert-ack") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    const opts = (g.showPrompt as any).mock.calls[0][1];
    // The prompt text is a PLACEHOLDER, never a value: it must vanish on the
    // first keystroke and an untouched box must submit as no note at all.
    expect(opts.placeholder).toBe("What is the problem and what is the fix?");
    expect(opts.value).toBeUndefined();
    expect(opts.multiline).toBe(true);
    expect(opts.maxLength).toBe(2000);
  });

  it("marks the note required when the alert's automation requires one", async () => {
    await mount({ alerts: [{ id: "n9", severity: "critical", message: "loss", dimension: null, metric: "probeLossPct", triggeredAt: "2026-07-23T14:50:00Z", acknowledged: false, requireAckNote: true }] });
    const btn = document.querySelector(".asset-alert-ack") as HTMLButtonElement;
    expect(btn.dataset.noteRequired).toBe("1");
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    const opts = (g.showPrompt as any).mock.calls[0][1];
    expect(opts.required).toBe(true);
    expect(opts.label).toMatch(/required/i);
    expect(opts.requiredMessage).toBeTruthy();
  });

  it("leaves the note optional when no automation asks for one", async () => {
    await mount();
    (document.querySelector(".asset-alert-ack") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect((g.showPrompt as any).mock.calls[0][1].required).toBe(false);
  });

  it("requires the note for a batch when ANY selected alert's automation does", async () => {
    // The route takes ONE note for every id and refuses such a batch whole, so
    // asking up front beats a 400 after the operator has closed the dialog.
    await mount({ alerts: [
      { id: "n1", severity: "warning", message: "a", dimension: null, triggeredAt: "2026-07-23T14:50:00Z", acknowledged: false },
      { id: "n2", severity: "critical", message: "b", dimension: null, triggeredAt: "2026-07-23T14:49:00Z", acknowledged: false, requireAckNote: true },
    ] });
    const all = document.getElementById("asset-alert-selall") as HTMLInputElement;
    all.checked = true;
    all.dispatchEvent(new Event("change"));
    (document.getElementById("asset-alert-bulk-ack") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect((g.showPrompt as any).mock.calls[0][1].required).toBe(true);
  });

  it("does not stack a second handler on the bulk buttons when the tab reloads", async () => {
    await mount();
    // Every action reloads the tab; the tbody is rebuilt but the bulk bar and
    // the select-all are NOT, so a naive re-wire fires N batches on click N.
    g._loadAssetNotificationsTab("A1");
    await new Promise((r) => setTimeout(r, 0));
    g._loadAssetNotificationsTab("A1");
    await new Promise((r) => setTimeout(r, 0));

    const all = document.getElementById("asset-alert-selall") as HTMLInputElement;
    all.checked = true;
    all.dispatchEvent(new Event("change"));
    expect(document.querySelectorAll<HTMLInputElement>(".asset-alert-sel:checked").length).toBe(3);
    (document.getElementById("asset-alert-bulk-clear") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.cleared.length).toBe(1);
  });
});

describe("asset Alerts tab — what the toast reports", () => {
  it("says so when the server cleared nothing", async () => {
    ctx.clearResult = () => ({ cleared: 0 });
    await mount();
    (document.querySelector(".asset-alert-clear") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.toasts.at(-1)).toEqual({ msg: "That alert was already cleared", type: "error" });
  });

  it("says so when the alert was already acknowledged", async () => {
    ctx.ackResult = () => ({ acknowledged: 0 });
    await mount();
    (document.querySelector(".asset-alert-ack") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.toasts.at(-1)).toEqual({ msg: "Already acknowledged", type: "error" });
  });
});

describe("asset Alerts tab — permission gating", () => {
  it("offers no selection at all to a viewer who cannot act", async () => {
    await mount({ perm: "read" });
    expect(document.getElementById("asset-alert-bulkbar")).toBeNull();
    expect(document.getElementById("asset-alert-selall")).toBeNull();
    expect(document.querySelectorAll(".asset-alert-sel").length).toBe(0);
    // Five columns, not six — and the empty state has to match.
    await mount({ perm: "read", alerts: [] });
    expect(Number(document.querySelector("#asset-notif-active-tbody td")!.getAttribute("colspan"))).toBe(5);
  });

  it("gives a write-level operator acknowledge but not clear", async () => {
    await mount({ perm: "write" });
    expect(document.getElementById("asset-alert-bulk-ack")).toBeTruthy();
    expect(document.getElementById("asset-alert-bulk-clear")).toBeNull();
    expect(document.querySelectorAll(".asset-alert-clear").length).toBe(0);
    expect(document.querySelectorAll(".asset-alert-sel").length).toBe(3);
  });
});

describe("asset Alerts tab — down detection panel", () => {
  const panel = () => document.getElementById("asset-down-detection-panel") as HTMLElement | null;

  it("names the governing automation, its count, and the resulting wall-clock time", async () => {
    // Neither table on this tab answers "which automation decides Down for this
    // device": the governing automation may never have fired.
    await mount();
    await new Promise((r) => setTimeout(r, 10));
    const txt = panel()!.textContent || "";
    expect(txt).toContain("Asset down");
    expect(txt).toContain("3 missed polls");
    expect(txt).toMatch(/2m 5s/);       // 60s interval x 2, plus the 5s timeout
    expect(txt).toContain("60s poll interval");
  });

  it("says PASSIVE plainly, and that no alert will ever be raised", async () => {
    await mount({ downDetection: { passive: true, missedPolls: null, automationName: null, conflict: null } });
    await new Promise((r) => setTimeout(r, 10));
    const txt = panel()!.textContent || "";
    expect(txt).toContain("Passive");
    expect(txt).toMatch(/never declare it Missed or Down/i);
    expect(txt).toMatch(/no alert will ever be raised/i);
    // And a way out, for someone who can act on it.
    expect(panel()!.querySelector('a[href="/automations.html"]')).toBeTruthy();
  });

  it("offers no create link to an operator who cannot author automations", async () => {
    await mount({ perm: "read", downDetection: { passive: true, missedPolls: null, automationName: null, conflict: null } });
    await new Promise((r) => setTimeout(r, 10));
    expect(panel()!.textContent).toContain("Passive");
    expect(panel()!.querySelector('a[href="/automations.html"]')).toBeFalsy();
  });

  it("surfaces a same-specificity tie and which count won", async () => {
    await mount({ downDetection: { passive: false, missedPolls: 2, automationName: "Core switches", conflict: { ruleIds: ["a", "b"], counts: [2, 10], chosen: 2 } } });
    await new Promise((r) => setTimeout(r, 10));
    const txt = panel()!.textContent || "";
    expect(txt).toContain("Core switches");
    expect(txt).toMatch(/equally-specific/i);
    expect(txt).toContain("10");
    expect(txt).toMatch(/smaller count/i);
  });
});

/**
 * The Alerts tab strobes in the colour of the worst active alert on the device
 * — the same signal the Assets list puts beside the hostname, so an operator
 * who opened the slide-over off a strobing row can see which tab it was about.
 */
describe("asset Alerts tab — the tab's own strobe", () => {
  const alertsTab = () => document.querySelector('#asset-view-tabs .page-tab[data-tab="notifications"]') as HTMLElement;

  it("marks the tab in the colour of the HIGHEST severity, not the newest alert", async () => {
    // makeAlerts(): two serious (newest) and one warning. Serious wins.
    await mount();
    const tab = alertsTab();
    expect(tab.classList.contains("alert-strobe")).toBe(true);
    expect(tab.style.getPropertyValue("--strobe-color")).toBe("var(--color-sev-serious)");
  });

  it("moves only while something is unacknowledged", async () => {
    await mount({
      alerts: [
        { id: "n1", severity: "critical", message: "down", dimension: null, triggeredAt: "2026-07-23T14:50:00Z", acknowledged: true, acknowledgedBy: "jsmith" },
      ],
    });
    const tab = alertsTab();
    // Still marked — an acknowledged alert is still active — but settled.
    expect(tab.classList.contains("alert-strobe")).toBe(true);
    expect(tab.classList.contains("is-handled")).toBe(true);
    expect(tab.style.getPropertyValue("--strobe-color")).toBe("var(--color-danger)");
  });

  it("clears the marking entirely when the last alert is gone", async () => {
    // The state that matters most: clearing the last alert must STOP the
    // strobe, not leave it running until the panel is closed.
    await mount({ alerts: [] });
    const tab = alertsTab();
    expect(tab.classList.contains("alert-strobe")).toBe(false);
    expect(tab.classList.contains("is-handled")).toBe(false);
    expect(tab.style.getPropertyValue("--strobe-color")).toBe("");
  });

  // The severity → colour map and the rank order this tab shares with the
  // Assets list's dot are pinned in tests/unit/assetAlertIndicator.test.ts,
  // where both halves of that agreement live.

  it("is a no-op when no slide-over is open", () => {
    document.body.innerHTML = "";
    expect(() => g._paintAssetAlertsTabStrobe([{ severity: "critical", acknowledged: false }])).not.toThrow();
  });
});
