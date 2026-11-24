/**
 * tests/unit/assetsSources.missing.test.ts — business rule 200 on the desktop
 * Sources tab (public/js/assets-sources.js): a source whose state the server
 * reports as "missing" (`assetSourceService.missingSourceState`) gets the
 * amber `badge-expired` Missing badge with a since-when tooltip, a line of its
 * own in the "Reported state by source" roll-up, and never counts as a
 * directory disagreement.
 */

import { describe, it, expect } from "vitest";
import { assetsFileSource } from "./_assetsSource.js";
import { missingSourceState } from "../../src/services/assetSourceService.js";
import { deriveAssetSourceState } from "../../src/utils/assetSourceState.js";

function extractFn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name}: unbalanced braces`);
}

function extractVar(src: string, name: string): string {
  const start = src.indexOf(`var ${name} = {`);
  if (start < 0) throw new Error(`${name} not found`);
  return src.slice(start, src.indexOf("};", start) + 2);
}

const SRC = assetsFileSource("assets-sources.js");
const prelude = `
  var escapeHtml = function (s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); };
  var formatDate = function (d) { return "D(" + new Date(d).toISOString().slice(0, 10) + ")"; };
  var _assetSourceLabels = { ad: "Active Directory", entra: "Entra ID" };
`;
const fns = new Function(`${prelude}
  ${extractVar(SRC, "_assetSourceStateBadgeClass")}
  ${extractFn(SRC, "_assetSourceStateBadge")}
  ${extractFn(SRC, "_assetSourceAccountStatesDisagree")}
  ${extractFn(SRC, "_assetSourceStateSummaryHTML")}
  return { badge: _assetSourceStateBadge, summary: _assetSourceStateSummaryHTML, disagree: _assetSourceAccountStatesDisagree };
`)() as {
  badge: (state: unknown) => string;
  summary: (sources: unknown[]) => string;
  disagree: (states: unknown[]) => boolean;
};

const SINCE = new Date("2026-11-20T10:00:00Z");
const missing = missingSourceState(SINCE);

describe("Sources tab Missing state (rule 200)", () => {
  it("draws the Missing badge amber, with since-when in the tooltip", () => {
    const html = fns.badge(missing);
    expect(html).toContain('class="badge badge-expired"');
    expect(html).toContain(">Missing<");
    expect(html).toContain("since D(2026-11-20)");
  });

  it("gives Missing its own line in the roll-up, with the date, beside Enabled", () => {
    const html = fns.summary([
      { sourceKind: "entra", state: deriveAssetSourceState("entra", { accountEnabled: true }) },
      { sourceKind: "ad", state: missing, missingSince: SINCE.toISOString() },
    ]);
    expect(html).toMatch(/Enabled<\/strong> per <span[^>]*>Entra ID/);
    expect(html).toMatch(/Missing<\/strong> per <span[^>]*>Active Directory <span[^>]*>\(not found since D\(2026-11-20\)\)/);
    expect(html).not.toContain("Directory sources disagree");
  });

  it("is never a directory disagreement", () => {
    expect(fns.disagree([deriveAssetSourceState("entra", { accountEnabled: true }), missing])).toBe(false);
  });
});
