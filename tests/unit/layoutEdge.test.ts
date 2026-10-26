/**
 * tests/unit/layoutEdge.test.ts
 *
 * The layout preference (16:9 / 16:10 / Auto) caps the shell to a column
 * centred in the window. Everything pinned to the RIGHT of the window must
 * offset by --layout-edge — the gap between the column's edge and the
 * window's — or on a wide screen it floats out in the margin, past the page's
 * own cards (seen 2026-10-26: the assistant's button sat in the window corner
 * while the page ended well to its left).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const STYLES = readFileSync(resolve(__dirname, "../../public/css/styles.css"), "utf8");
const ASSISTANT = readFileSync(resolve(__dirname, "../../public/css/assistant.css"), "utf8");

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const m = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[2];
}

describe("--layout-edge", () => {
  it("is derived from the layout width on :root, never negative", () => {
    expect(STYLES).toMatch(/--layout-edge:\s*max\(0px,\s*calc\(\(100vw - var\(--layout-max-width\)\) \/ 2\)\)/);
  });

  it.each([
    [STYLES, ".slideover"],
    [STYLES, ".toast-container"],
    [ASSISTANT, ".asst-fab"],
    [ASSISTANT, ".asst-panel"],
  ])("%#: %s sits on the column's edge, not the window's", (css, selector) => {
    const right = /(?:^|;|\n)\s*right:\s*([^;]+);/.exec(rule(css, selector))?.[1] ?? "";
    expect(right).toMatch(/var\(--layout-edge/);
  });
});
