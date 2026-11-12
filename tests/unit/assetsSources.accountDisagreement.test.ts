/**
 * tests/unit/assetsSources.accountDisagreement.test.ts
 *
 * The Sources tab's "Directory sources disagree" call-out —
 * `_assetSourceAccountStatesDisagree` in public/js/assets-sources.js. The
 * readings fed to it are the server's own (deriveAssetSourceState in
 * src/utils/assetSourceState.ts), which is what `GET /assets/:id/sources`
 * embeds as each row's `state`.
 */

import { describe, it, expect } from "vitest";
import { assetsFileSource } from "./_assetsSource.js";
import { deriveAssetSourceState } from "../../src/utils/assetSourceState.js";

/** Source text of `function <name>(...) { ... }`, braces balanced. */
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

const disagree = new Function(
  `${extractFn(assetsFileSource("assets-sources.js"), "_assetSourceAccountStatesDisagree")}; return _assetSourceAccountStatesDisagree;`,
)() as (states: unknown[]) => boolean;

describe("_assetSourceAccountStatesDisagree", () => {
  const entraEnabled  = deriveAssetSourceState("entra", { accountEnabled: true });
  const adDisabled    = deriveAssetSourceState("ad", { accountDisabled: true });
  const adEnabled     = deriveAssetSourceState("ad", { accountDisabled: false });
  const vmPoweredOff  = deriveAssetSourceState("vcenter-vm", { powerState: "POWERED_OFF" });
  const intune        = deriveAssetSourceState("intune", { complianceState: "compliant" });

  it("flags two directories that disagree", () => {
    expect(disagree([entraEnabled, adDisabled])).toBe(true);
  });

  it("does not flag agreeing directories", () => {
    expect(disagree([entraEnabled, adEnabled])).toBe(false);
    expect(disagree([])).toBe(false);
  });

  it("ignores runtime readings — a powered-off VM with a live account is not a conflict", () => {
    expect(disagree([entraEnabled, vmPoweredOff])).toBe(false);
  });

  it("ignores sources that report no state", () => {
    expect(disagree([intune, entraEnabled])).toBe(false);
    expect(disagree([intune, entraEnabled, adDisabled])).toBe(true);
  });
});
