/**
 * tests/unit/platformAdvisoryAlertDom.test.ts — the sidebar alerts for open
 * platform security advisories (renderPlatformAdvisoryAlert in public/js/app.js).
 *
 * What's pinned here is what rots without anyone noticing:
 *  - ONE panel per component, each with its own dismiss;
 *  - each panel tinted by the vendor's worst CVE rating — not by the card's
 *    grade, which adds a step for a network-exposed component;
 *  - the dismissal contract: per user, per "<component>:<CVE>" pair. A panel
 *    returns only when one of ITS pairs is new; dismissing one component
 *    leaves the others; moving within a line while the same CVEs stay open is
 *    not news.
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

/** gradeSeverity is the CARD's grade — deliberately not what the sidebar tints by. */
function comp(id: string, cves: Array<[string, string]>, over: Record<string, any> = {}, gradeSeverity = "critical") {
  return {
    id,
    label: id === "node" ? "Node.js" : id,
    observedVersion: "24.18.0",
    grade: {
      state: "unpatched",
      severity: gradeSeverity,
      securityFloor: {
        version: "24.22.1",
        advisories: cves.map(([cveId, rating]) => ({ id: cveId, severity: rating })),
      },
    },
    ...over,
  };
}

const wrapper = () => document.getElementById("platform-advisory-alert") as HTMLElement;
const panels = () => Array.from(wrapper().querySelectorAll(".platform-advisory-alert")) as HTMLElement[];
const labels = () => panels().map((p) => p.querySelector(".query-status-label")!.textContent);
const dismiss = (label: string) => {
  const p = panels().find((x) => x.querySelector(".query-status-label")!.textContent === label);
  (p!.querySelector(".platform-advisory-dismiss") as HTMLElement).click();
};

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
    ${["_platformAdvisoryDismissKey", "_platformAdvisoryPairs", "_platformAdvisoryTint", "_worstAdvisoryRating", "renderPlatformAdvisoryAlert"].map(fnSrc).join("\n")}
    return { renderPlatformAdvisoryAlert };
  })()`);
  render = exported.renderPlatformAdvisoryAlert;
});

describe("one panel per component", () => {
  it("stays hidden with nothing open", () => {
    render();
    expect(wrapper().style.display).toBe("none");
    expect(panels()).toHaveLength(0);
  });

  it("renders a separate panel for each component, each with its own dismiss", () => {
    advisories = [comp("node", [["CVE-1", "high"]]), comp("postgres", [["CVE-2", "low"]])];
    render();
    expect(wrapper().style.display).toBe("block");
    expect(labels()).toEqual(["Node.js security update", "postgres security update"]);
    for (const p of panels()) expect(p.querySelectorAll(".platform-advisory-dismiss")).toHaveLength(1);
  });

  it("names the installed version, CVE count, worst rating and the release to move to", () => {
    advisories = [comp("node", [["CVE-1", "medium"], ["CVE-2", "high"]])];
    render();
    expect(panels()[0].textContent).toContain("24.18.0 · 2 CVEs · high");
    expect(panels()[0].textContent).toContain("update to 24.22.1");
    expect(panels()[0].getAttribute("title")).toBe("CVE-1 (medium), CVE-2 (high)");
  });

  it("uses the capacity alert's 14px SVG triangle, not a text glyph", () => {
    advisories = [comp("node", [["CVE-1", "high"]])];
    render();
    expect(panels()[0].querySelector("svg.platform-advisory-icon")).not.toBeNull();
    expect(panels()[0].innerHTML).not.toContain("⚠");
  });

  it("escapes every interpolated value", () => {
    advisories = [comp("<b>x</b>", [["<i>y</i>", "low"]], { label: "<b>x</b>", observedVersion: "<s>" })];
    render();
    // No element was injected. (Asserting on innerHTML would mislead: the DOM
    // serialises < > inside an ATTRIBUTE value — the CVE title — unescaped,
    // although it is inert text there.)
    expect(wrapper().querySelector("b, i, s")).toBeNull();
    expect(wrapper().innerHTML).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(panels()[0].getAttribute("title")).toBe("<i>y</i> (low)");
  });
});

describe("tint follows the vendor's CVE rating, not the card grade", () => {
  it.each([
    ["critical", "platform-advisory-red"],
    ["high", "platform-advisory-red"],
    ["medium", "platform-advisory-amber"],
    ["low", "platform-advisory-watch"],
  ])("%s → %s", (rating, cls) => {
    // Card grade "critical" on every case: a network-exposed low CVE grades
    // amber on the card, but the sidebar reports the CVE itself.
    advisories = [comp("node", [["CVE-1", rating]], {}, "critical")];
    render();
    expect(panels()[0].className).toContain(cls);
  });

  it("takes the worst rating among a component's CVEs", () => {
    advisories = [comp("node", [["CVE-1", "low"], ["CVE-2", "medium"]])];
    render();
    expect(panels()[0].className).toContain("platform-advisory-amber");
  });
});

describe("dismissal", () => {
  it("hides only the dismissed component, and keeps it hidden on the next poll", () => {
    advisories = [comp("node", [["CVE-1", "high"]]), comp("postgres", [["CVE-2", "low"]])];
    render();
    dismiss("Node.js security update");
    expect(labels()).toEqual(["postgres security update"]);
    render();
    expect(labels()).toEqual(["postgres security update"]);
  });

  it("hides the wrapper once every panel is dismissed", () => {
    advisories = [comp("node", [["CVE-1", "high"]])];
    render();
    dismiss("Node.js security update");
    expect(wrapper().style.display).toBe("none");
  });

  it("returns when a new CVE opens on that component", () => {
    advisories = [comp("node", [["CVE-1", "high"]])];
    render();
    dismiss("Node.js security update");
    advisories = [comp("node", [["CVE-1", "high"], ["CVE-9", "medium"]])];
    render();
    expect(labels()).toEqual(["Node.js security update"]);
  });

  it("does not bring back a dismissed component when ANOTHER one gets an advisory", () => {
    advisories = [comp("node", [["CVE-1", "high"]])];
    render();
    dismiss("Node.js security update");
    advisories = [comp("node", [["CVE-1", "high"]]), comp("postgres", [["CVE-1", "low"]])];
    render();
    expect(labels()).toEqual(["postgres security update"]);
  });

  it("does not return when the installed version moves but the same CVEs stay open", () => {
    advisories = [comp("node", [["CVE-1", "high"]])];
    render();
    dismiss("Node.js security update");
    advisories = [comp("node", [["CVE-1", "high"]], { observedVersion: "24.20.0" })];
    render();
    expect(panels()).toHaveLength(0);
  });

  it("keeps an earlier dismissal when a second component is dismissed", () => {
    advisories = [comp("node", [["CVE-1", "high"]]), comp("postgres", [["CVE-2", "low"]])];
    render();
    dismiss("Node.js security update");
    dismiss("postgres security update");
    render();
    expect(panels()).toHaveLength(0);
  });

  it("forgets pairs that are no longer open, so the stored list cannot grow forever", () => {
    advisories = [comp("node", [["CVE-1", "high"]]), comp("postgres", [["CVE-2", "low"]])];
    render();
    dismiss("Node.js security update");
    advisories = [comp("postgres", [["CVE-2", "low"]])]; // Node patched
    render();
    dismiss("postgres security update");
    expect(JSON.parse(localStorage.getItem("polaris.platform-advisories.dismissed.alice")!)).toEqual(["postgres:CVE-2"]);
  });

  it("is per user", () => {
    advisories = [comp("node", [["CVE-1", "high"]])];
    render();
    dismiss("Node.js security update");
    g.currentUsername = "bob";
    render();
    expect(panels()).toHaveLength(1);
  });

  it("survives a corrupt stored value by showing every panel", () => {
    localStorage.setItem("polaris.platform-advisories.dismissed.alice", "{not json");
    advisories = [comp("node", [["CVE-1", "high"]])];
    render();
    expect(panels()).toHaveLength(1);
  });
});
