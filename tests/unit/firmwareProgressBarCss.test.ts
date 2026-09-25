/**
 * tests/unit/firmwareProgressBarCss.test.ts — the firmware progress bars must
 * be able to draw at all (business rule 87's Firmware card and the Repository
 * upload row).
 *
 * The track and the fill are both `<span>`s. An inline element ignores width
 * and height, so without a `display` of their own the fill rendered 0x0 and
 * every bar was invisible — found on prod with a FortiAP mid-reboot, proven in
 * real Chromium. happy-dom does no layout, so no DOM test could see it; this
 * reads the shipped stylesheet and fails if either rule loses its display.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(__dirname, "../../public/css/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the first rule whose selector list is exactly `selector`. */
function ruleBody(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`(?:^|})\\s*${esc}\\s*\\{([^}]*)\\}`, "m"));
  if (!m) throw new Error(`styles.css has no rule for ${selector}`);
  return m[1]!;
}
const display = (selector: string) => /(?:^|;)\s*display\s*:\s*([a-z-]+)/.exec(ruleBody(selector))?.[1] ?? null;

describe("firmware progress bars", () => {
  it("the fill is a block, so its width and height apply", () => {
    expect(display(".fw-progress-fill")).toBe("block");
  });
  it("the track is inline-block, so it has a size inside a line of text as well as in a grid cell", () => {
    expect(display(".fw-progress")).toBe("inline-block");
  });
});
