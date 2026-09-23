/**
 * tests/unit/mobileAssetAlerts.test.ts — the phone's per-asset alert flag and
 * the sheet behind it.
 *
 * Three properties are pinned here, each because it is a thing two surfaces
 * have to agree about:
 *
 *   • THE SEVERITY VOCABULARY. `PolarisMobileAlerts.sevRank` is the third copy
 *     of `ALERT_SEVERITY_RANK` (src/utils/alertSeverity.ts — the server's own,
 *     which picks the severity the Assets-list summary reports) after
 *     `_alertSevRank` in assets.js. A device that flags amber on the phone and
 *     red in its slide-over is what the shared vocabulary exists to prevent,
 *     so the rank map is compared key-for-key against the server's.
 *
 *   • WHAT THE FLAG SAYS. It exists only while something is active, and it
 *     STROBES only while something is unacknowledged — an acknowledged alert
 *     is still flagged, it has just stopped asking.
 *
 *   • WHO GETS THE VERBS. Acknowledge is drawn at alerts:write and Clear at
 *     alerts:fullwrite, matching the routes; a control that could only 403 is
 *     not drawn. And the flag settles from what the sheet loaded — clearing
 *     the last alert has to stop the strobe on the card behind it.
 *
 * Both browser files are executed as-is (no module boundary — the mobile SPA
 * is plain script tags), so the wiring under test is the wiring that ships.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALERT_SEVERITY_RANK } from "../../src/utils/alertSeverity.js";

const ALERTS_SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "alerts.js"), "utf-8");
const TAB_SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "assets-tab.js"), "utf-8");
const LIST_SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "list-controls.js"), "utf-8");

const g = globalThis as any;

type AlertRow = {
  id: string;
  severity: string;
  message: string;
  acknowledged?: boolean;
  acknowledgedBy?: string | null;
  acknowledgeNote?: string | null;
  requireAckNote?: boolean;
  triggeredAt?: string;
};

const flush = () => new Promise((r) => setTimeout(r, 0));

function asset(n: number, activeAlert: unknown = null) {
  return {
    id: "a" + n,
    hostname: "DEVICE-" + n,
    assetType: "server",
    monitored: true,
    monitorStatus: "up",
    ipAddress: "10.0.0." + n,
    activeAlert,
  };
}

/**
 * Boot both files against a one-page /assets feed, with `alerts` as the level
 * the viewer's role holds on the alerts function key.
 */
function mount(assets: any[], opts: { alerts?: string; alertRows?: AlertRow[] } = {}) {
  document.body.innerHTML = '<div id="app"><main class="app-body" id="app-body"></main></div>';
  const opened: string[] = [];
  const acked: Array<{ ids: string[]; note?: string }> = [];
  const cleared: string[][] = [];
  let rows: AlertRow[] = opts.alertRows ? opts.alertRows.slice() : [];

  g.escapeHtml = (s: any) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.timeAgo = () => "1m ago";
  g.api = {
    assets: {
      list: vi.fn(async () => ({ assets, total: assets.length })),
      alerts: vi.fn(async () => ({ active: rows, matchingRules: [] })),
    },
    alerts: {
      acknowledge: vi.fn(async (ids: string[], note?: string) => {
        acked.push({ ids, note });
        rows = rows.map((r) => (ids.includes(r.id) ? { ...r, acknowledged: true, acknowledgedBy: "me" } : r));
        return { acknowledged: ids.length };
      }),
      clear: vi.fn(async (ids: string[]) => {
        cleared.push(ids);
        rows = rows.filter((r) => !ids.includes(r.id));
        return { cleared: ids.length };
      }),
    },
  };
  g.PolarisRouter = { go: (r: string) => opened.push(r) };
  g.PolarisTabs = { showSnackbar: vi.fn(), attachSwipeToDismiss: vi.fn() };
  g.PolarisAssetDetail = { open: (id: string) => opened.push("detail:" + id) };
  g.PolarisMobile = { user: () => ({ permissions: { alerts: opts.alerts ?? "read", assets: "read" } }) };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(ALERTS_SRC)();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(LIST_SRC)();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(TAB_SRC)();
  const spec = g.PolarisAssetsTab.spec;
  spec.render(document.getElementById("app-body")!);
  return { opened, acked, cleared };
}

const flags = () => Array.from(document.querySelectorAll(".alert-flag")) as HTMLElement[];
const sheet = () => document.getElementById("asset-alerts-sheet");
const sheetItems = () => Array.from(document.querySelectorAll(".alert-item"));

beforeEach(() => {
  document.body.innerHTML = "";
  delete g.PolarisMobileAlerts;
  delete g.PolarisAssetsTab;
});

describe("mobile alert severity vocabulary", () => {
  it("ranks severities exactly as the server does", () => {
    mount([asset(1)]);
    const M = g.PolarisMobileAlerts;
    for (const [sev, rank] of Object.entries(ALERT_SEVERITY_RANK)) {
      expect(M.sevRank(sev), sev).toBe(rank);
    }
    // Unknown ranks 0 rather than throwing or out-ranking a critical.
    expect(M.sevRank("nonsense")).toBe(0);
    expect(M.sevRank(undefined)).toBe(0);
  });

  it("summarizes a list the way the list endpoint does — worst severity wins", () => {
    mount([asset(1)]);
    const M = g.PolarisMobileAlerts;
    const s = M.summarize([
      { severity: "warning", acknowledged: true },
      { severity: "critical", acknowledged: false },
      { severity: "notice", acknowledged: false },
    ]);
    expect(s).toEqual({ severity: "critical", count: 3, unacknowledged: 2 });
    expect(M.summarize([])).toBeNull();
  });

  it("gives an unknown severity the critical colour rather than none", () => {
    mount([asset(1)]);
    const M = g.PolarisMobileAlerts;
    expect(M.sevColor("warning")).toBe("var(--md-sev-warning)");
    expect(M.sevColor("bogus")).toBe("var(--md-sev-critical)");
  });
});

describe("the search-row alert dot", () => {
  // Search rows are one line with an icon, a name, a subtitle and a chevron —
  // an "ALERTS" pill in there pushes the hostname into an ellipsis on a phone,
  // so the same statement is reduced to a dot. It has to keep saying
  // everything the flag says except the word.
  it("carries the flag's colour, handled state and label", () => {
    mount([asset(1)]);
    const M = g.PolarisMobileAlerts;

    expect(M.dotHTML(null)).toBe("");
    expect(M.dotHTML({ severity: "critical", count: 0, unacknowledged: 0 })).toBe("");

    const live = M.dotHTML({ severity: "serious", count: 2, unacknowledged: 1 });
    expect(live).toContain("var(--md-sev-serious)");
    expect(live).not.toContain("is-handled");
    expect(live).toContain("2 active alerts, worst serious");
    expect(live).toContain("1 unacknowledged");

    const handled = M.dotHTML({ severity: "warning", count: 1, unacknowledged: 0 });
    expect(handled).toContain("is-handled");
    expect(handled).toContain("acknowledged");
  });

  it("is not a tap target — the row it sits in opens the device", () => {
    mount([asset(1)]);
    const html = g.PolarisMobileAlerts.dotHTML({ severity: "critical", count: 1, unacknowledged: 1 });
    // A <button> here would be a second target two thumb-widths from the row's
    // own, and (nested in the row button) would swallow the tap outright.
    expect(html.startsWith("<span")).toBe(true);
    expect(html).not.toContain("<button");
    expect(html).toContain('role="img"');
  });
});

describe("the Assets-list alert flag", () => {
  it("appears only on cards with active alerts, coloured by the worst one", async () => {
    mount([
      asset(1, { severity: "warning", count: 1, unacknowledged: 1 }),
      asset(2, null),
    ]);
    await flush();
    const f = flags();
    expect(f.length).toBe(1);
    expect(f[0].closest(".asset-card")!.getAttribute("data-id")).toBe("a1");
    expect(f[0].textContent).toContain("Alerts");
    expect(f[0].getAttribute("style")).toContain("var(--md-sev-warning)");
  });

  it("strobes while anything is unacknowledged and goes steady once it is handled", async () => {
    mount([
      asset(1, { severity: "critical", count: 2, unacknowledged: 1 }),
      asset(2, { severity: "critical", count: 2, unacknowledged: 0 }),
    ]);
    await flush();
    const [one, two] = flags();
    expect(one.classList.contains("is-handled")).toBe(false);
    expect(one.getAttribute("aria-label")).toContain("1 unacknowledged");
    expect(two.classList.contains("is-handled")).toBe(true);
    expect(two.getAttribute("aria-label")).toContain("all acknowledged");
  });

  it("opens the alerts sheet on tap instead of the device", async () => {
    const { opened } = mount([asset(1, { severity: "critical", count: 1, unacknowledged: 1 })], {
      alertRows: [{ id: "n1", severity: "critical", message: "Device is down" }],
    });
    await flush();
    flags()[0].click();
    await flush();

    expect(opened).toEqual([]);                       // the card underneath did not fire
    expect(sheet()).not.toBeNull();
    expect(sheet()!.textContent).toContain("DEVICE-1");
    expect(sheetItems().length).toBe(1);
    expect(sheetItems()[0].textContent).toContain("Device is down");
  });

  it("still opens the device when the card itself is tapped", async () => {
    const { opened } = mount([asset(1, { severity: "critical", count: 1, unacknowledged: 1 })]);
    await flush();
    (document.querySelector(".asset-card .name") as HTMLElement).click();
    await flush();
    expect(opened).toEqual(["detail:a1"]);
    expect(sheet()).toBeNull();
  });
});

describe("the alerts sheet's verbs", () => {
  const rows: AlertRow[] = [
    { id: "n1", severity: "critical", message: "Device is down" },
    { id: "n2", severity: "warning", message: "Port down", acknowledged: true, acknowledgedBy: "dave" },
  ];
  const summary = { severity: "critical", count: 2, unacknowledged: 1 };

  async function openSheet(level: string) {
    mount([asset(1, summary)], { alerts: level, alertRows: rows });
    await flush();
    flags()[0].click();
    await flush();
  }

  it("offers neither verb to a read-only viewer", async () => {
    await openSheet("read");
    expect(document.querySelectorAll(".alert-ack").length).toBe(0);
    expect(document.querySelectorAll(".alert-clear").length).toBe(0);
    // The alerts themselves are still readable — that is the whole point of
    // the flag being offered to anyone who can see the card.
    expect(sheetItems().length).toBe(2);
  });

  it("offers Acknowledge at alerts:write, on the unacknowledged row only", async () => {
    await openSheet("write");
    const ack = Array.from(document.querySelectorAll(".alert-ack")) as HTMLElement[];
    expect(ack.length).toBe(1);
    expect(ack[0].dataset.id).toBe("n1");
    expect(document.querySelectorAll(".alert-clear").length).toBe(0);
    // The acknowledged row names who did it rather than dropping off.
    expect(sheetItems()[1].textContent).toContain("dave");
  });

  it("offers Clear only at alerts:fullwrite, on every row", async () => {
    await openSheet("fullwrite");
    expect(document.querySelectorAll(".alert-clear").length).toBe(2);
    expect(document.querySelectorAll(".alert-ack").length).toBe(1);
  });

  it("acknowledging settles the flag on the card behind it, with no list re-fetch", async () => {
    await openSheet("write");
    const listCalls = (g.api.assets.list as any).mock.calls.length;

    (document.querySelector(".alert-ack") as HTMLElement).click();
    await flush();
    await flush();

    // Still flagged — the alerts are active — but no longer asking.
    const f = flags();
    expect(f.length).toBe(1);
    expect(f[0].classList.contains("is-handled")).toBe(true);
    expect((g.api.assets.list as any).mock.calls.length).toBe(listCalls);
  });

  it("clearing the last alert removes the flag entirely", async () => {
    mount([asset(1, { severity: "critical", count: 1, unacknowledged: 1 })], {
      alerts: "fullwrite",
      alertRows: [{ id: "n1", severity: "critical", message: "Device is down" }],
    });
    await flush();
    flags()[0].click();
    await flush();

    (document.querySelector(".alert-clear") as HTMLElement).click();
    await flush();                                            // confirm sheet is up
    (document.getElementById("alert-clear-ok") as HTMLElement).click();
    await flush();
    await flush();

    expect(flags().length).toBe(0);
    expect(sheet()!.textContent).toContain("No active alerts");
  });

  it("asks for a note before acknowledging an alert whose automation requires one", async () => {
    const { acked } = mount([asset(1, { severity: "critical", count: 1, unacknowledged: 1 })], {
      alerts: "write",
      alertRows: [{ id: "n1", severity: "critical", message: "Device is down", requireAckNote: true }],
    });
    await flush();
    flags()[0].click();
    await flush();

    (document.querySelector(".alert-ack") as HTMLElement).click();
    await flush();
    const ta = document.getElementById("ack-note") as HTMLTextAreaElement;
    expect(ta).not.toBeNull();

    // A blank required note is refused with a stated reason rather than sent.
    (document.getElementById("ack-note-ok") as HTMLElement).click();
    await flush();
    expect(acked.length).toBe(0);
    expect((document.getElementById("ack-note-err") as HTMLElement).style.display).toBe("");

    ta.value = "on site";
    (document.getElementById("ack-note-ok") as HTMLElement).click();
    await flush();
    await flush();
    expect(acked).toEqual([{ ids: ["n1"], note: "on site" }]);
  });

  it("batches the whole device's unacknowledged alerts behind one control", async () => {
    const { acked } = mount([asset(1, { severity: "critical", count: 3, unacknowledged: 3 })], {
      alerts: "write",
      alertRows: [
        { id: "n1", severity: "critical", message: "port1 down" },
        { id: "n2", severity: "critical", message: "port2 down" },
        { id: "n3", severity: "warning", message: "port3 down", acknowledged: true },
      ],
    });
    await flush();
    flags()[0].click();
    await flush();

    const all = document.getElementById("asset-alerts-ack-all") as HTMLElement;
    expect(all.textContent).toContain("(2)");
    all.click();
    await flush();
    await flush();
    expect(acked).toEqual([{ ids: ["n1", "n2"], note: undefined }]);
  });
});
