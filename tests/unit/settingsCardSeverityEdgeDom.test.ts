/**
 * tests/unit/settingsCardSeverityEdgeDom.test.ts — the severity left edge on
 * the Maintenance tab's grading cards (public/js/server-settings.js).
 *
 * Pinned:
 *  - the Database card grades and lists only its own reasons — platform
 *    lifecycle reasons (an open Node advisory, an EOL runtime) ride the
 *    capacity snapshot for the sidebar alert and email, but on this tab they
 *    belong to the Platform Lifecycle card;
 *  - the Capacity Advisor shows "N recommendations available" only when N > 0
 *    (it read "0 recommendations available" in amber when the view filter
 *    dropped every changed row) and wears the amber edge only then;
 *  - the Platform Lifecycle card carries the edge for its overall severity.
 *
 * Functions are sliced out by name and eval'd with their collaborators stubbed,
 * the approach of tests/unit/platformLifecycleCardDom.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;
const lines = readFileSync(resolve(__dirname, "../../public/js/server-settings.js"), "utf8").split(/\r?\n/);

function fnSrc(name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`function ${name} not found in server-settings.js`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`no end of function ${name}`);
  return lines.slice(start, end + 1).join("\n");
}

const FN_NAMES = [
  "_capacitySeverityLabel",
  "_capacitySeverityCssClass",
  "_capacityAllPassedHtml",
  "renderCapacityCard",
  "_advisorSection",
  "_advisorLabel",
  "_advisorRecommendationsForView",
  "_advisorRowHtml",
  "_advisorContainerRestartHtml",
  "renderCapacityAdvisorCard",
  "_lifecycleStateLabel",
  "_lifecycleWhen",
  "_lifecycleRowHtml",
  "renderPlatformLifecycleCard",
];

let fns: Record<string, (...a: any[]) => string>;

beforeEach(() => {
  g.escapeHtml = (s: any) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.formatLocalTime = (s: string) => String(s);
  g.formatNumber = (n: any) => String(n);
  // eslint-disable-next-line no-eval
  fns = eval(`(function () {
    var _advisorJustStaged = false;
    var _advisorInContainer = false;
    function dbInfoRow() { return ""; }
    function _capacityFormatBytes() { return ""; }
    function _capacityRenderVolume() { return ""; }
    function _capacityUnlistedRow() { return ""; }
    function renderEnginePoolStatHtml() { return ""; }
    function _capacityAlertHoldStatus() { return ""; }
    function renderCapacityAlertHoldHtml() { return ""; }
    ${FN_NAMES.map(fnSrc).join("\n")}
    ${fnSrc("renderCardAlertSummary")}
    return { renderCapacityCard, renderCapacityAdvisorCard, renderPlatformLifecycleCard, renderCardAlertSummary };
  })()`);
});

function card(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

const NODE_ADVISORY = {
  severity: "warning",
  code: "platform_unpatched",
  family: "platform_lifecycle",
  message: "Node.js 24.18.0 has a published security advisory open against it (CVE-2026-111497 high).",
  suggestion: "Update Node.js on this host to 24.22.1 or later.",
};

function capacity(reasons: any[], severity: string) {
  return {
    severity,
    computedAt: "2026-10-26T12:00:00Z",
    reasons,
    appHost: {},
    database: {},
    workload: {},
  };
}

describe("Database card", () => {
  it("drops platform lifecycle reasons and grades on what is left", () => {
    const el = card(fns.renderCapacityCard(capacity([NODE_ADVISORY], "warning"), null, null, null));
    expect(el.textContent).not.toContain("security advisory");
    expect(el.textContent).toContain("All capacity checks passed");
    expect(el.classList.contains("severity-edge")).toBe(true);
    expect(el.classList.contains("severity-edge-ok")).toBe(true);
  });

  it("keeps its own reasons and their severity alongside a dropped lifecycle reason", () => {
    const disk = { severity: "critical", code: "disk_db", family: "disk:db", message: "DB volume 95% full", suggestion: "Grow it." };
    const el = card(fns.renderCapacityCard(capacity([disk, NODE_ADVISORY], "critical"), null, null, null));
    expect(el.textContent).toContain("DB volume 95% full");
    expect(el.textContent).not.toContain("security advisory");
    expect(el.classList.contains("severity-edge-red")).toBe(true);
  });

  it("leaves the server's severity alone when nothing was dropped", () => {
    const watch = { severity: "watch", code: "db_io_pressure", message: "IO", suggestion: "x" };
    const el = card(fns.renderCapacityCard(capacity([watch], "watch"), null, null, null));
    expect(el.classList.contains("severity-edge-watch")).toBe(true);
  });
});

describe("Capacity Advisor header", () => {
  function advisor(recs: any[]) {
    return {
      anyChangeRequired: recs.some((r) => r.changeRequired),
      recommendedQueueMode: "pgboss",
      recommendations: recs,
    };
  }

  it("names the count and wears the amber edge when there are recommendations", () => {
    const el = card(fns.renderCapacityAdvisorCard(advisor([
      { key: "DATABASE_POOL_SIZE", applyMode: "env", current: 25, recommended: 50, changeRequired: true },
    ]), null, "direct"));
    expect(el.textContent).toContain("1 recommendation available");
    expect(el.classList.contains("severity-edge-amber")).toBe(true);
  });

  it("shows no count when the rows on screen need no change", () => {
    // anyChangeRequired is true from a row the pgboss view filters out.
    const a = advisor([
      { key: "POLARIS_PROBE_CONCURRENCY", applyMode: "env", current: 1, recommended: 2, changeRequired: true },
      { key: "DATABASE_POOL_SIZE", applyMode: "env", current: 50, recommended: 50, changeRequired: false },
    ]);
    const el = card(fns.renderCapacityAdvisorCard(a, null, "direct"));
    expect(el.textContent).not.toMatch(/recommendations? available/);
    expect(el.classList.contains("severity-edge-ok")).toBe(true);
  });
});

describe("Platform Lifecycle card", () => {
  it("carries the edge for its overall severity", () => {
    const el = card(fns.renderPlatformLifecycleCard({
      datasetReviewedAt: "2026-10-26",
      severity: "warning",
      components: [{
        id: "node", label: "Node.js", observedVersion: "24.18.0", polarisTarget: "24", playbook: null,
        grade: { state: "unpatched", severity: "warning", track: "24", eolAt: "2028-04-30", daysUntilEol: 500 },
      }],
      informational: [],
    }));
    expect(el.classList.contains("severity-edge")).toBe(true);
    expect(el.classList.contains("severity-edge-amber")).toBe(true);
  });
});

describe("Needs-attention summary", () => {
  function page(cards: string): HTMLElement {
    document.body.innerHTML = '<div id="tab-maintenance"><div id="maintenance-alert-summary"></div>' + cards + "</div>";
    return document.getElementById("tab-maintenance")!;
  }
  const edge = (id: string, sev: string, title: string) =>
    `<div class="settings-card severity-edge severity-edge-${sev}" id="${id}"><h4>${title}</h4></div>`;

  it("renders nothing when no card is amber or red", () => {
    const tab = page(edge("capacity-card", "ok", "Database") + edge("platform-lifecycle-card", "watch", "Platform Lifecycle"));
    fns.renderCardAlertSummary(tab);
    expect(document.getElementById("maintenance-alert-summary")!.innerHTML).toBe("");
  });

  it("lists every amber and red card by title and takes the worst colour", () => {
    const tab = page(
      edge("capacity-card", "ok", "Database") +
      edge("platform-lifecycle-card", "amber", "Platform Lifecycle") +
      edge("bksched-card", "red", "Scheduled Backups"),
    );
    fns.renderCardAlertSummary(tab);
    const strip = document.querySelector(".card-alert-summary") as HTMLElement;
    expect(strip.classList.contains("severity-edge-red")).toBe(true);
    const items = Array.from(document.querySelectorAll(".card-alert-summary-item")).map((b) => b.textContent);
    expect(items).toEqual(["WarningPlatform Lifecycle", "CriticalScheduled Backups"]);
    expect(strip.textContent).not.toContain("Database");
  });

  it("re-renders cleanly when a card regrades later, without counting itself", () => {
    const tab = page(edge("bksched-card", "red", "Scheduled Backups"));
    fns.renderCardAlertSummary(tab);
    document.getElementById("bksched-card")!.classList.replace("severity-edge-red", "severity-edge-ok");
    fns.renderCardAlertSummary(tab);
    expect(document.getElementById("maintenance-alert-summary")!.innerHTML).toBe("");
  });

  it("scrolls to the card on click", () => {
    const tab = page(edge("platform-lifecycle-card", "amber", "Platform Lifecycle"));
    let scrolled = "";
    (document.getElementById("platform-lifecycle-card") as any).scrollIntoView = function (this: HTMLElement) { scrolled = this.id; };
    fns.renderCardAlertSummary(tab);
    (document.querySelector(".card-alert-summary-item") as HTMLElement).click();
    expect(scrolled).toBe("platform-lifecycle-card");
  });
});
