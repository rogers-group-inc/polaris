/**
 * tests/unit/assetSourcesCellDom.test.ts — the Assets table's Sources column
 * (public/js/assets-form.js → sourcesCellHTML), business rule 199: one source
 * reads as its name, several read "N sources" behind the hover pill that lists
 * each, and none reads "-".
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeAll } from "vitest";
import { assetsSource } from "./_assetsSource.js";

const g = globalThis as Record<string, any>;
const lines = assetsSource().split(/\r?\n/);

function fnSrc(name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}

const FNS = ["_sourceEntryLabel", "sourcesCellHTML"];

beforeAll(() => {
  g.escapeHtml = (s: any) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g._assetSourceLabels = { "ad": "Active Directory", "fortigate-endpoint": "FortiGate / FortiManager (endpoint)", "manual": "Manual / other" };
  (0, eval)(FNS.map(fnSrc).join("\n") + "\n" + FNS.map((n) => `globalThis.${n} = ${n};`).join("\n"));
});

function cell(sources: unknown): HTMLElement {
  const td = document.createElement("td");
  td.innerHTML = g.sourcesCellHTML({ id: "a1", sources });
  return td;
}

describe("sourcesCellHTML", () => {
  it("no sources reads as a dash", () => {
    expect(cell([]).textContent).toBe("-");
    expect(cell(undefined).textContent).toBe("-");
  });

  it("one source reads as its label, no hover pill, integration in the title", () => {
    const td = cell([{ sourceKind: "ad", integrationName: "Corp <AD>" }]);
    expect(td.textContent).toBe("Active Directory");
    expect(td.querySelector(".mac-hover-trigger")).toBeNull();
    expect(td.querySelector("span")!.getAttribute("title")).toBe("Corp <AD>");
  });

  it("an unknown kind falls through to the raw kind", () => {
    expect(cell([{ sourceKind: "proxmox-lxc", integrationName: null }]).textContent).toBe("proxmox-lxc");
  });

  it("several sources read 'N sources' and the hover lists every one with its integration", () => {
    const td = cell([
      { sourceKind: "ad", integrationName: "Corp AD" },
      { sourceKind: "fortigate-endpoint", integrationName: "FMG" },
      { sourceKind: "manual", integrationName: null },
    ]);
    const trigger = td.querySelector(".mac-hover-trigger")!;
    expect(trigger).not.toBeNull();
    expect(trigger.firstElementChild!.textContent).toBe("3 sources");
    const rows = Array.from(td.querySelectorAll(".mac-tooltip .mac-tooltip-row"));
    expect(rows.map((r) => r.firstElementChild!.textContent)).toEqual([
      "Active Directory", "FortiGate / FortiManager (endpoint)", "Manual / other",
    ]);
    expect(rows[1].querySelector(".mac-tooltip-source")!.textContent).toBe("FMG");
    expect(rows[2].querySelector(".mac-tooltip-source")).toBeNull();
  });
});

describe("Sources column filter options", () => {
  it("offer every labelled source kind with its label, then (No source)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const root = resolve(__dirname, "../../public");
    const html = readFileSync(resolve(root, "assets.html"), "utf8");
    const th = /<th[^>]*data-sf-key="sources"[^>]*data-sf-options="([^"]+)"/.exec(html);
    expect(th).not.toBeNull();
    const options = th![1].split("|").map((o) => o.split("="));
    const app = readFileSync(resolve(root, "js/app.js"), "utf8");
    const block = /var _assetSourceLabels = \{([\s\S]*?)\n\};/.exec(app)![1];
    const labels = [...block.matchAll(/^\s*"([^"]+)":\s*"([^"]+)",?/gm)].map((m) => [m[1], m[2]]);
    expect(options.at(-1)).toEqual(["none", "(No source)"]);
    expect(new Map(options.slice(0, -1) as [string, string][])).toEqual(new Map(labels as [string, string][]));
  });
});
