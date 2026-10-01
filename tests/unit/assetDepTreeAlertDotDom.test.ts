/**
 * tests/unit/assetDepTreeAlertDotDom.test.ts — the asset-details Dependency
 * Tree's per-node active-alert dot (`renderDependencyTreeBlock` /
 * `_depTreeNodeRow` in public/js/assets.js).
 *
 * The status pip on each row is MONITOR STATE, so an up device with a live
 * alert reads as a plain green ▲. The dot is what tells an operator which
 * device in the chain is alerting. Pinned here:
 *
 *  - every kind of row (parent, self, HA peer, child, grandchild) shows the dot
 *    when its node carries an `activeAlert` — parents, self and the HA peer are
 *    rebuilt field-by-field by the renderer, so a field missed there is
 *    dropped silently;
 *  - it is the assets list's own dot (app.js alertSummaryDotHTML): coloured by
 *    the worst severity, strobing while any alert is unacknowledged, still
 *    (`is-handled`) once all are taken;
 *  - a quiet node renders no dot at all.
 *
 * Functions are sliced out by name and eval'd — the approach of
 * tests/unit/assetVipRowsDom.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, any>;
const read = (f: string) => readFileSync(resolve(__dirname, "../../public/js/" + f), "utf8").split(/\r?\n/);
const assetsLines = read("assets.js");
const appLines = read("app.js");

/** Slice a top-level `function NAME(...) {` … `}` or `var NAME = {` … `};` block. */
function src(lines: string[], name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`) || l.startsWith(`var ${name} =`));
  if (start < 0) throw new Error(`function/var ${name} not found`);
  if (lines[start].trimEnd().endsWith(";")) return lines[start];
  const end = lines.findIndex((l, i) => i > start && (l === "}" || l === "};"));
  if (end < 0) throw new Error(`no end of ${name}`);
  return lines.slice(start, end + 1).join("\n");
}

const node = (id: string, over: Record<string, unknown> = {}) => ({
  id, hostname: id, assetType: "switch", dependencyLayer: 2,
  monitorStatus: "up", monitored: true, ...over,
});

function render(payload: unknown): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = g.renderDependencyTreeBlock(payload, "self");
  return host;
}

/** The row whose hostname (link or bold self) reads `name`. */
function rowFor(host: HTMLElement, name: string): HTMLElement {
  const row = [...host.querySelectorAll<HTMLElement>(".dep-tree-row")]
    .find((r) => r.querySelector(".dep-tree-link, .dep-tree-self")?.textContent === name);
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

beforeEach(() => {
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  for (const n of ["assetAlertStrobeColor", "alertSummaryDotHTML"]) (0, eval)(src(appLines, n));
  for (const n of [
    "_DEP_TREE_TYPE_LABEL", "_DEP_TREE_VIA_LABEL", "_DEP_TREE_VIA_TITLE",
    "_depTreeStatusPip", "_depTreeTypeLabel", "_depTreeNodeRow", "renderDependencyTreeBlock",
  ]) (0, eval)(src(assetsLines, n));
});

describe("dependency tree active-alert dot", () => {
  const payload = {
    asset: node("self", { activeAlert: { severity: "warning", count: 1, unacknowledged: 1 } }),
    effectiveParents: [{
      parent: node("gate", { assetType: "firewall", dependencyLayer: 1,
        activeAlert: { severity: "critical", count: 2, unacknowledged: 0 } }),
      source: "computed", detectedVia: "controller",
    }],
    haPeer: node("peer", { assetType: "firewall", activeAlert: { severity: "notice", count: 1, unacknowledged: 1 } }),
    children: [{
      ...node("child", { assetType: "access_point", activeAlert: { severity: "serious", count: 3, unacknowledged: 2 } }),
      grandchildren: [
        node("gc-alerting", { assetType: "access_point", activeAlert: { severity: "critical", count: 1, unacknowledged: 1 } }),
        node("gc-quiet", { assetType: "access_point", activeAlert: null }),
      ],
      childCount: 2,
    }],
  };

  it("puts a dot on every alerting row — parent, self, HA peer, child, grandchild", () => {
    const host = render(payload);
    for (const name of ["gate", "self", "peer", "child", "gc-alerting"]) {
      expect(rowFor(host, name).querySelector(".alert-strobe-dot"), name).not.toBeNull();
    }
  });

  it("renders no dot on a quiet node", () => {
    expect(rowFor(render(payload), "gc-quiet").querySelector(".alert-strobe-dot")).toBeNull();
  });

  it("strobes while unacknowledged, sits still once every alert is taken", () => {
    const host = render(payload);
    expect(rowFor(host, "child").querySelector(".alert-strobe-dot")!.classList.contains("is-handled")).toBe(false);
    expect(rowFor(host, "gate").querySelector(".alert-strobe-dot")!.classList.contains("is-handled")).toBe(true);
  });

  it("colours by the worst severity and names it in the tooltip", () => {
    const dot = rowFor(render(payload), "child").querySelector<HTMLElement>(".alert-strobe-dot")!;
    expect(dot.getAttribute("style")).toContain("--color-sev-serious");
    expect(dot.getAttribute("title")).toBe("3 active alerts, worst serious — 2 unacknowledged");
  });

  it("keeps the monitor-state pip independent of the dot", () => {
    // An up device with a live alert: the pip still says Up.
    const row = rowFor(render(payload), "child");
    expect(row.querySelector(".dep-tree-pip")!.getAttribute("title")).toBe("Up");
  });
});
