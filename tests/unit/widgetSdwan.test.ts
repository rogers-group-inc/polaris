/**
 * tests/unit/widgetSdwan.test.ts
 *
 * The five SD-WAN dashboard widgets (public/js/widgets/sdwan*.js), rendered in
 * happy-dom through the real registry: each registers under the SD-WAN picker
 * category, its preview draws rows, and the parts that differ from the stock
 * widgets hold — compliance labels the time IN SLA while ranking on time out,
 * flapping labels a count, the list widgets name what an operator acts on
 * (the member a rule is on vs. the one it prefers; the paths a site has left),
 * and the gear's kind / window switches narrow the rows.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Window } from "happy-dom";

interface WidgetDef {
  type: string;
  category: string;
  requiredPermission: { key: string; level: string };
  defaultConfig: Record<string, unknown>;
  renderPreview: (el: unknown) => void;
  renderInstance: (el: unknown, config: Record<string, unknown>, data: unknown, ctx: { onUnmount: (fn: () => void) => void }) => void;
}

const g = globalThis as Record<string, unknown>;
let doc: Window["document"];
let W: { getByType: (t: string) => WidgetDef | null };
const TYPES = ["sdwanRuleFailovers", "sdwanSingleLink", "sdwanSlaHeadroom", "sdwanFlapping", "sdwanSlaCompliance"];

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const load = (f: string) => (0, eval)(readFileSync(resolve(here, "../../public/js/widgets/" + f), "utf8"));
  load("index.js");
  g.PolarisWidgets = (win as unknown as { PolarisWidgets: unknown }).PolarisWidgets;
  load("_topnBar.js");
  g.PolarisTopN = (win as unknown as { PolarisTopN: unknown }).PolarisTopN;
  for (const t of TYPES) load(t + ".js");
  W = g.PolarisWidgets as typeof W;
});

function body() {
  const article = doc.createElement("article");
  article.className = "dashboard-widget";
  article.innerHTML = '<div class="dashboard-widget-header"><h3 class="dashboard-widget-title">t</h3></div><div class="body"></div>';
  doc.body.appendChild(article);
  return article.querySelector(".body") as unknown as HTMLElement;
}

// Drive renderInstance with data in hand; the refresh timer is torn down at once.
function renderWith(type: string, config: Record<string, unknown>, data: unknown) {
  const el = body();
  const cleanups: Array<() => void> = [];
  W.getByType(type)!.renderInstance(el, config, data, { onUnmount: (fn) => cleanups.push(fn) });
  cleanups.forEach((fn) => fn());
  return el;
}

describe("SD-WAN widgets", () => {
  it("all five register under SD-WAN, gated on assets:read, and draw a preview", () => {
    for (const t of TYPES) {
      const def = W.getByType(t);
      expect(def, t).toBeTruthy();
      expect(def!.category).toBe("SD-WAN");
      expect(def!.requiredPermission).toEqual({ key: "assets", level: "read" });
      const el = body();
      def!.renderPreview(el);
      expect(el.querySelector(".empty-state"), t).toBeNull();
      expect(el.textContent!.length, t).toBeGreaterThan(0);
    }
  });

  it("compliance ranks on time out of SLA but labels time in SLA", () => {
    const el = renderWith("sdwanSlaCompliance", { rowLimit: 5 }, [
      { id: "a", hostname: "fgt-1", value: 2.5, detail: "HC · wan1" },
    ]);
    expect(el.textContent).toContain("97.5% in SLA");
  });

  it("flapping labels a count, singular and plural", () => {
    const el = renderWith("sdwanFlapping", { rowLimit: 5 }, [
      { id: "a", hostname: "fgt-1", value: 1, detail: "wan1 · HC" },
      { id: "b", hostname: "fgt-2", value: 6, detail: "wan2 · HC" },
    ]);
    expect(el.textContent).toContain("1 drop");
    expect(el.textContent).toContain("6 drops");
  });

  it("rule failovers say where traffic is and where it should be, and the gear can hide a kind", () => {
    const rows = [
      { assetId: "a", hostname: "fgt-1", ruleName: "VoIP", state: "failedOver", selectedMember: "wan2", preferredMembers: ["wan1"] },
      { assetId: "b", hostname: "fgt-2", ruleName: "To-HQ", state: "down", selectedMember: null, preferredMembers: ["Overlay-1"] },
    ];
    const all = renderWith("sdwanRuleFailovers", { groupBy: "none", rowLimit: 10 }, rows);
    expect(all.textContent).toContain("on wan2 · prefers wan1");
    expect(all.textContent).toContain("no usable member");
    const downOnly = renderWith("sdwanRuleFailovers", { groupBy: "none", rowLimit: 10, showFailedOver: false }, rows);
    expect(downOnly.querySelectorAll(".dash-alert-item").length).toBe(1);
    expect(downOnly.textContent).toContain("To-HQ");
  });

  it("single-link sites show live paths of total and can leave out sites with none", () => {
    const rows = [
      { assetId: "a", hostname: "fgt-1", alivePaths: 1, totalPaths: 2, alive: ["wan1"], downMembers: ["wan2"] },
      { assetId: "b", hostname: "fgt-2", alivePaths: 0, totalPaths: 2, alive: [], downMembers: ["wan1", "wan2"] },
    ];
    const el = renderWith("sdwanSingleLink", { rowLimit: 10 }, rows);
    expect(el.textContent).toContain("only wan1");
    expect(el.textContent).toContain("1/2");
    expect(el.textContent).toContain("no live path");
    const some = renderWith("sdwanSingleLink", { rowLimit: 10, showNoPath: false }, rows);
    expect(some.querySelectorAll(".dash-alert-item").length).toBe(1);
  });

  it("empty feeds say what the empty state means", () => {
    expect(renderWith("sdwanSingleLink", {}, []).textContent).toContain("Every SD-WAN site has a backup path");
    expect(renderWith("sdwanRuleFailovers", {}, []).textContent).toContain("Every SD-WAN rule is on its preferred link");
    expect(renderWith("sdwanSlaCompliance", { window: "1h" }, []).textContent).toContain("last hour");
  });
});
