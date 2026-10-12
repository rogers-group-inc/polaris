/**
 * tests/unit/assetAlertIndicator.test.ts — the Assets list's active-alert
 * indicator: the dot beside the hostname saying "something is wrong with this
 * device", coloured by the worst active alert on it.
 *
 * Both halves are here because their only real requirement is that they AGREE:
 *   • the server half (`activeAlertSummaryByAsset` in notificationService)
 *     picks which alert the row is about, out of however many the device has;
 *   • the client half (`assetAlertDotHTML` / `assetAlertStrobeColor` in
 *     assets.js) turns that into a colour and decides whether it moves.
 * A device that strobes amber in the list and red in its own slide-over is the
 * failure this file exists to catch, so the severity vocabulary and the rank
 * order are pinned on both sides.
 *
 * The client functions are sliced out of app.js by name — the browser scripts
 * have no module boundary (the approach of tests/unit/assetAlertsTabDom.test.ts).
 * They live in app.js rather than assets.js because the global search dropdown
 * draws the same dot and renders on every page, including the many that never
 * load assets.js.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const h = vi.hoisted(() => ({
  prisma: { notification: { findMany: vi.fn() } },
}));
vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/eventLogService.js", () => ({
  logEvent: vi.fn(async () => {}),
  logEventsBatch: vi.fn(async () => {}),
}));
vi.mock("../../src/services/notificationRuleService.js", () => ({
  findRulesMatchingAsset: vi.fn(async () => []),
}));

import { activeAlertSummaryByAsset } from "../../src/services/notificationService.js";
import { ALERT_SEVERITY_RANK, alertSeverityRank, higherAlertSeverity } from "../../src/utils/alertSeverity.js";

const g = globalThis as Record<string, any>;

/* ─── The client half, sliced out of app.js ───────────────────────────────── */

const assetsLines = readFileSync(resolve(__dirname, "../../public/js/app.js"), "utf8").split(/\r?\n/);

function fnSrc(name: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`app.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`app.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

const CLIENT_FNS = ["assetAlertStrobeColor", "_alertSevRank", "assetAlertDotHTML", "alertSummaryDotHTML"];

beforeAll(() => {
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const src = CLIENT_FNS.map(fnSrc).join("\n") + "\n" +
    CLIENT_FNS.map((n) => `globalThis.${n} = ${n};`).join("\n");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(src)();
});

/** Parse the one dot out of a rendered cell fragment. */
function dot(asset: unknown): HTMLElement | null {
  document.body.innerHTML = "<td>" + g.assetAlertDotHTML(asset) + "</td>";
  return document.querySelector(".alert-strobe-dot");
}

/* ─── Server: which alert is the row about ─────────────────────────────────── */

describe("activeAlertSummaryByAsset", () => {
  beforeEach(() => { h.prisma.notification.findMany.mockReset(); });

  it("takes the WORST severity per asset and counts what is still unhandled", async () => {
    h.prisma.notification.findMany.mockResolvedValueOnce([
      { assetId: "a", severity: "warning", acknowledged: true },
      { assetId: "a", severity: "critical", acknowledged: false },
      { assetId: "a", severity: "notice", acknowledged: false },
      { assetId: "b", severity: "serious", acknowledged: true },
    ]);
    const m = await activeAlertSummaryByAsset(["a", "b"]);
    expect(m.get("a")).toEqual({ severity: "critical", count: 3, unacknowledged: 2 });
    // Every alert acknowledged → still marked, but the dot stops moving.
    expect(m.get("b")).toEqual({ severity: "serious", count: 1, unacknowledged: 0 });
  });

  it("leaves an asset with no active alert out of the map entirely", async () => {
    h.prisma.notification.findMany.mockResolvedValueOnce([
      { assetId: "a", severity: "warning", acknowledged: false },
    ]);
    const m = await activeAlertSummaryByAsset(["a", "quiet"]);
    expect(m.has("quiet")).toBe(false);
  });

  it("is ONE query for the whole page, never one per row", async () => {
    // The list ships up to 10 000 rows on the export path. A query per row is
    // the shape that makes a page of assets cost a page of queries.
    h.prisma.notification.findMany.mockResolvedValueOnce([]);
    await activeAlertSummaryByAsset(["a", "b", "c", "d"]);
    expect(h.prisma.notification.findMany).toHaveBeenCalledTimes(1);
    expect(h.prisma.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { assetId: { in: ["a", "b", "c", "d"] }, cleared: false },
    }));
  });

  it("asks nothing at all for an empty page", async () => {
    const m = await activeAlertSummaryByAsset([]);
    expect(m.size).toBe(0);
    expect(h.prisma.notification.findMany).not.toHaveBeenCalled();
  });

  it("counts a CLEARED alert nowhere — the indicator is about live trouble", async () => {
    h.prisma.notification.findMany.mockResolvedValueOnce([]);
    const m = await activeAlertSummaryByAsset(["a"]);
    expect(m.size).toBe(0);
    const where = h.prisma.notification.findMany.mock.calls[0][0].where;
    expect(where.cleared).toBe(false);
  });
});

describe("alert severity ranking", () => {
  it("orders the automation ladder and folds the two legacy audit levels in", () => {
    expect(alertSeverityRank("critical")).toBeGreaterThan(alertSeverityRank("serious"));
    expect(alertSeverityRank("serious")).toBeGreaterThan(alertSeverityRank("warning"));
    expect(alertSeverityRank("warning")).toBeGreaterThan(alertSeverityRank("informational"));
    expect(alertSeverityRank("informational")).toBeGreaterThan(alertSeverityRank("notice"));
    // Pre-redesign Notification rows still carry these.
    expect(alertSeverityRank("info")).toBe(alertSeverityRank("informational"));
    expect(alertSeverityRank("error")).toBe(alertSeverityRank("critical"));
  });

  it("ranks an unknown severity 0 rather than throwing or out-ranking a critical", () => {
    expect(alertSeverityRank("wat")).toBe(0);
    expect(alertSeverityRank(null)).toBe(0);
    expect(alertSeverityRank(undefined)).toBe(0);
    expect(higherAlertSeverity("critical", "wat")).toBe("critical");
  });

  it("higherAlertSeverity keeps the incumbent on a tie and handles a null side", () => {
    expect(higherAlertSeverity("serious", "serious")).toBe("serious");
    expect(higherAlertSeverity(null, "warning")).toBe("warning");
    expect(higherAlertSeverity("warning", null)).toBe("warning");
    expect(higherAlertSeverity(null, null)).toBeNull();
  });
});

/* ─── Client: the dot ──────────────────────────────────────────────────────── */

describe("assetAlertDotHTML", () => {
  it("renders nothing at all for a device with no active alert", () => {
    expect(g.assetAlertDotHTML({ id: "a" })).toBe("");
    expect(g.assetAlertDotHTML({ id: "a", activeAlert: null })).toBe("");
    expect(g.assetAlertDotHTML({ id: "a", activeAlert: { severity: "critical", count: 0, unacknowledged: 0 } })).toBe("");
    expect(g.assetAlertDotHTML(null)).toBe("");
  });

  it("strobes in the severity's colour while something is unacknowledged", () => {
    const el = dot({ activeAlert: { severity: "warning", count: 1, unacknowledged: 1 } })!;
    expect(el).toBeTruthy();
    expect(el.classList.contains("is-handled")).toBe(false);
    expect(el.getAttribute("style")).toContain("--strobe-color:var(--color-sev-warning)");
    expect(el.getAttribute("title")).toBe("1 active warning alert");
  });

  it("settles once every alert is acknowledged, without disappearing", () => {
    // An acknowledged alert is still active — hiding the dot would say the
    // device is fine, which is a different claim from "someone has this".
    const el = dot({ activeAlert: { severity: "critical", count: 2, unacknowledged: 0 } })!;
    expect(el.classList.contains("is-handled")).toBe(true);
    expect(el.getAttribute("title")).toBe("2 active alerts, worst critical — all acknowledged");
  });

  it("says how many are still unhandled when there is more than one", () => {
    const el = dot({ activeAlert: { severity: "serious", count: 5, unacknowledged: 2 } })!;
    expect(el.getAttribute("title")).toBe("5 active alerts, worst serious — 2 unacknowledged");
  });

  it("carries the same text as an aria-label — the animation is not the message", () => {
    // A reduced-motion viewer gets no animation at all (styles.css), and a
    // screen reader gets no colour, so the title has to say the whole thing.
    const el = dot({ activeAlert: { severity: "critical", count: 1, unacknowledged: 1 } })!;
    expect(el.getAttribute("aria-label")).toBe(el.getAttribute("title"));
    expect(el.getAttribute("role")).toBe("img");
  });

  it("still marks the row when the severity is missing or unrecognized", () => {
    const el = dot({ activeAlert: { severity: null, count: 1, unacknowledged: 1 } })!;
    expect(el).toBeTruthy();
    expect(el.getAttribute("style")).toContain("--strobe-color:var(--color-sev-critical)");
  });
});

describe("the two halves agree", () => {
  it("client and server rank every severity identically", () => {
    for (const sev of Object.keys(ALERT_SEVERITY_RANK)) {
      expect(g._alertSevRank(sev), sev).toBe(ALERT_SEVERITY_RANK[sev]);
    }
    expect(g._alertSevRank("wat")).toBe(alertSeverityRank("wat"));
  });

  it("every severity the server can emit has a colour on the client", () => {
    // A severity that fell through to no colour would render an invisible dot
    // — a device silently reading as healthy.
    for (const sev of Object.keys(ALERT_SEVERITY_RANK)) {
      expect(g.assetAlertStrobeColor(sev), sev).toMatch(/^var\(--color-/);
    }
  });

  it("uses the vocabulary the .badge-level-* pills already paint", () => {
    expect(g.assetAlertStrobeColor("notice")).toBe("var(--color-sev-notice)");
    expect(g.assetAlertStrobeColor("informational")).toBe("var(--color-sev-informational)");
    expect(g.assetAlertStrobeColor("info")).toBe("var(--color-sev-informational)");
    expect(g.assetAlertStrobeColor("warning")).toBe("var(--color-sev-warning)");
    expect(g.assetAlertStrobeColor("serious")).toBe("var(--color-sev-serious)");
    expect(g.assetAlertStrobeColor("critical")).toBe("var(--color-sev-critical)");
    expect(g.assetAlertStrobeColor("error")).toBe("var(--color-sev-critical)");
    expect(g.assetAlertStrobeColor("wat")).toBe("var(--color-sev-critical)");
  });
});
