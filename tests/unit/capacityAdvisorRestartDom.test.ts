/**
 * tests/unit/capacityAdvisorRestartDom.test.ts — the Capacity Advisor card's
 * post-Stage footer (public/js/server-settings.js).
 *
 * On a host install the footer offers "Restart Polaris to apply". In a
 * container it must NOT: a self-restart is a plain process exit there, and a
 * container whose restart policy is "no" (Unraid's default) stays stopped.
 * The card asks the operator to restart the container instead, and
 * POST /restart refuses with 409 (tests/integration/serverRestartContainer).
 *
 * Functions are sliced out of the browser script by name and eval'd with the
 * app-shell globals stubbed — the approach of platformLifecycleCardDom.test.ts.
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
  "_advisorSection",
  "_advisorLabel",
  "_advisorRecommendationsForView",
  "_advisorRowHtml",
  "_advisorContainerRestartHtml",
  "renderCapacityAdvisorCard",
];

let render: (inContainer: boolean, justStaged: boolean) => string;

beforeEach(() => {
  g.escapeHtml = (s: any) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.formatLocalTime = (s: string) => String(s);
  // eslint-disable-next-line no-eval
  render = eval(`(function () {
    var _advisorJustStaged = false;
    var _advisorInContainer = false;
    ${FN_NAMES.map(fnSrc).join("\n")}
    return function (inContainer, justStaged) {
      _advisorInContainer = inContainer;
      _advisorJustStaged = justStaged;
      return renderCapacityAdvisorCard(globalThis.__advisor, null, "direct");
    };
  })()`);
  g.__advisor = stagedAdvisor();
});

/** Every env lever already staged → nothing left to stage, footer shows the restart step. */
function stagedAdvisor() {
  return {
    computedAt: "2026-10-09T12:00:00Z",
    anyChangeRequired: false,
    recommendedQueueMode: "pgboss",
    recommendations: [
      { key: "DATABASE_POOL_SIZE", applyMode: "env", current: 25, recommended: 50, changeRequired: false },
      { key: "PG_MAX_CONNECTIONS", applyMode: "advisory-only", current: 150, recommended: 200, changeRequired: true },
    ],
  };
}

describe("Capacity Advisor post-Stage footer", () => {
  it("offers a restart button on a host install", () => {
    document.body.innerHTML = render(false, true);
    expect(document.getElementById("capacity-advisor-restart-btn")).not.toBeNull();
    expect(document.getElementById("capacity-advisor-container-restart")).toBeNull();
  });

  it("asks the operator to restart the container instead of offering a button", () => {
    document.body.innerHTML = render(true, true);
    expect(document.getElementById("capacity-advisor-restart-btn")).toBeNull();
    const note = document.getElementById("capacity-advisor-container-restart");
    expect(note).not.toBeNull();
    expect(note!.textContent).toMatch(/restart the Polaris container yourself/i);
    expect(note!.textContent).toContain("docker restart <name>");
  });

  it("names the container in the footer hint before anything is staged", () => {
    document.body.innerHTML = render(true, false);
    expect(document.body.textContent).toMatch(/Restart the Polaris container\(s\) after Stage/);
    document.body.innerHTML = render(false, false);
    expect(document.body.textContent).toMatch(/Restart Polaris after Stage/);
  });
});
