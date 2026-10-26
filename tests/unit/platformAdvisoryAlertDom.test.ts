/**
 * tests/unit/platformAdvisoryAlertDom.test.ts — the sidebar alert for open
 * platform security advisories (renderPlatformAdvisoryAlert in public/js/app.js).
 *
 * What's pinned here is the dismissal contract, because it is the part that
 * rots without anyone noticing:
 *  - dismissing hides the alert across renders for THAT user;
 *  - it returns only when a "<component>:<CVE>" pair outside the dismissed set
 *    opens — a new CVE on the same component, or an advisory on another one;
 *  - patching one component (its pairs disappear) does NOT re-raise the rest;
 *  - the panel colour follows the worst row's grade, matching the card.
 *
 * app.js is a browser script with no module boundary, so the functions are
 * sliced out by name and eval'd with the app-shell globals stubbed — the
 * approach of tests/unit/platformLifecycleCardDom.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;
const lines = readFileSync(resolve(__dirname, "../../public/js/app.js"), "utf8").split(/\r?\n/);

function fnSrc(name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`function ${name} not found in app.js`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}

function varSrc(name: string): string {
  const line = lines.find((l) => l.startsWith(`var ${name} =`));
  if (!line) throw new Error(`var ${name} not found in app.js`);
  return line;
}

let render: () => void;
let advisories: any[];

function comp(id: string, severity: string, cves: Array<[string, string]>, over: Record<string, any> = {}) {
  return {
    id,
    label: id === "node" ? "Node.js" : id,
    observedVersion: "24.18.0",
    grade: {
      state: "unpatched",
      severity,
      securityFloor: {
        version: "24.22.1",
        advisories: cves.map(([cveId, rating]) => ({ id: cveId, severity: rating })),
      },
    },
    ...over,
  };
}

const panel = () => document.getElementById("platform-advisory-alert") as HTMLElement;
const visible = () => panel().style.display === "block";
const dismiss = () => (panel().querySelector(".platform-advisory-dismiss") as HTMLElement).click();

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div id="platform-advisory-alert" style="display:none"></div>';
  g.escapeHtml = (s: any) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.currentUsername = "alice";
  advisories = [];
  g.window._getPlatformAdvisories = () => advisories;
  // eslint-disable-next-line no-eval
  const exported = eval(`(function () {
    ${varSrc("_ADVISORY_RANK")}
    ${["_platformAdvisoryDismissKey", "_platformAdvisoryPairs", "_worstAdvisoryRating", "renderPlatformAdvisoryAlert"].map(fnSrc).join("\n")}
    return { renderPlatformAdvisoryAlert };
  })()`);
  render = exported.renderPlatformAdvisoryAlert;
});

describe("visibility", () => {
  it("stays hidden with nothing open", () => {
    render();
    expect(visible()).toBe(false);
    expect(panel().innerHTML).toBe("");
  });

  it("names each component, its CVE count, worst rating and the release to move to", () => {
    advisories = [comp("node", "critical", [["CVE-1", "medium"], ["CVE-2", "high"]])];
    render();
    expect(visible()).toBe(true);
    expect(panel().textContent).toContain("Security update available");
    expect(panel().textContent).toContain("Node.js 24.18.0");
    expect(panel().textContent).toContain("2 CVEs · high · update to 24.22.1");
  });

  it("escapes every interpolated value", () => {
    advisories = [comp("<b>x</b>", "warning", [["<i>y</i>", "low"]], { label: "<b>x</b>" })];
    render();
    expect(panel().innerHTML).not.toContain("<b>x</b>");
    expect(panel().innerHTML).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("colour follows the worst row", () => {
  it.each([
    [["watch"], "platform-advisory-watch"],
    [["watch", "warning"], "platform-advisory-amber"],
    [["warning", "critical", "watch"], "platform-advisory-red"],
  ])("%j → %s", (severities, cls) => {
    advisories = severities.map((s, i) => comp(`c${i}`, s, [[`CVE-${i}`, "low"]]));
    render();
    expect(panel().className).toContain(cls);
  });
});

describe("dismissal", () => {
  it("hides the alert, and keeps it hidden on the next poll", () => {
    advisories = [comp("node", "critical", [["CVE-1", "high"]])];
    render();
    dismiss();
    expect(visible()).toBe(false);
    render();
    expect(visible()).toBe(false);
  });

  it("returns when a new CVE opens on the same component", () => {
    advisories = [comp("node", "critical", [["CVE-1", "high"]])];
    render();
    dismiss();
    advisories = [comp("node", "critical", [["CVE-1", "high"], ["CVE-9", "medium"]])];
    render();
    expect(visible()).toBe(true);
  });

  it("returns when an advisory opens on another component", () => {
    advisories = [comp("node", "critical", [["CVE-1", "high"]])];
    render();
    dismiss();
    advisories = [comp("node", "critical", [["CVE-1", "high"]]), comp("postgres", "warning", [["CVE-1", "low"]])];
    render();
    expect(visible()).toBe(true);
  });

  it("does not return when one component is patched and the rest stay open", () => {
    advisories = [comp("node", "critical", [["CVE-1", "high"]]), comp("postgres", "warning", [["CVE-2", "low"]])];
    render();
    dismiss();
    advisories = [comp("postgres", "warning", [["CVE-2", "low"]])];
    render();
    expect(visible()).toBe(false);
  });

  it("does not return when the installed version moves but the same CVEs stay open", () => {
    advisories = [comp("node", "critical", [["CVE-1", "high"]])];
    render();
    dismiss();
    advisories = [comp("node", "critical", [["CVE-1", "high"]], { observedVersion: "24.20.0" })];
    render();
    expect(visible()).toBe(false);
  });

  it("is per user", () => {
    advisories = [comp("node", "critical", [["CVE-1", "high"]])];
    render();
    dismiss();
    g.currentUsername = "bob";
    render();
    expect(visible()).toBe(true);
  });

  it("survives a corrupt stored value by showing the alert", () => {
    localStorage.setItem("polaris.platform-advisories.dismissed.alice", "{not json");
    advisories = [comp("node", "critical", [["CVE-1", "high"]])];
    render();
    expect(visible()).toBe(true);
  });
});
