/**
 * tests/unit/integrationTabDesignTokens.test.ts — the integration modal's tab
 * bodies are built from the shared form parts and theme tokens.
 *
 * An audit (2026-09-23) found the tabs in three visual dialects: General built
 * from sectionHeading() / formDivider(), the feature tabs from hand-styled
 * <h4>/<hr>, and Geographic Location from neither. It also found the nightfall
 * accent hard-coded as rgba(79,195,247,…) in ~36 places, which painted sky-blue
 * tints on the daylight themes, and a colour token (--color-bg-subtle) that
 * does not exist, so its fallback grey was all anyone ever saw. Those are
 * static properties of the source, so they are asserted statically.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8").replace(/\r\n/g, "\n");
const js = read("public/js/integrations.js");
const css = read("public/css/styles.css");
const app = read("public/js/app.js");

describe("integration tab bodies use theme tokens", () => {
  it("hard-codes no rgba() colour", () => {
    expect(js.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,[^)]*\)/g) ?? []).toEqual([]);
  });

  it("gives no token a hex fallback", () => {
    expect(js.match(/var\(--color-[a-z-]+,\s*#[0-9a-fA-F]{3,8}\)/g) ?? []).toEqual([]);
  });

  it("names no undefined colour token", () => {
    const used = new Set([...js.matchAll(/var\((--color-[a-z0-9-]+)/g)].map((m) => m[1]!));
    const defined = new Set([...css.matchAll(/^\s*(--color-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]!));
    expect([...used].filter((t) => !defined.has(t))).toEqual([]);
  });

  it("infoBox() tints from the accent token, not the nightfall hex", () => {
    const body = app.slice(app.indexOf("function infoBox("), app.indexOf("function checkboxRow("));
    expect(body).toContain("var(--color-accent)");
    expect(body).not.toMatch(/rgba\(/);
  });
});

describe("integration tab bodies use the shared form parts", () => {
  it("hand-rolls no <h4> section heading", () => {
    expect(js).not.toContain("<h4 style=");
  });

  it("hand-rolls no <hr> divider inside a tab builder", () => {
    // The Query API consoles further down the file are their own dialogs and
    // keep their own rule; everything before them is modal-tab markup.
    const tabs = js.slice(0, js.indexOf("// ─── Saved-query store + console wiring"));
    expect(tabs).not.toContain("<hr style=");
  });

  it("styles prose hints outside a form-group at the infoBox size in integration panels", () => {
    // Two tiers: a field hint (inside .form-group) keeps 0.72rem; a tab intro,
    // bullet list or callout body takes infoBox()'s 0.82rem instead of body size.
    expect(css).toMatch(/\.page-tab-panel\[id\^="intg-"\] \.hint:not\(\.form-group \.hint\) \{[^}]*font-size: 0\.82rem;[^}]*color: var\(--color-text-tertiary\);/);
    expect(app).toMatch(/function infoBox\(html\) \{[\s\S]*?font-size:0\.82rem;/);
    // Declared before .hint-error, so an error hint keeps its colour at equal specificity.
    expect(css.indexOf('.page-tab-panel[id^="intg-"] .hint:not(')).toBeLessThan(css.indexOf(".form-group .hint.hint-error"));
  });
});
