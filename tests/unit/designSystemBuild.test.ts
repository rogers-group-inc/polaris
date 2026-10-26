/**
 * tests/unit/designSystemBuild.test.ts
 *
 * The two design systems (Polaris UI, Polaris Mobile) are published from the
 * repo by .design-sync/build.mjs: design/<system>/ pages + the app's own
 * stylesheet, with token values generated from that CSS. The build fails when a
 * page uses a class the app stylesheet no longer defines or a token stops
 * resolving, so running it here turns a UI change that breaks a design page
 * into a red test instead of a silently stale artifact. Runs with no
 * DATABASE_URL, as the CI unit job does (the AlertEmail page imports services).
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const repo = join(__dirname, "..", "..");
const out = join(repo, "ds-bundle");

describe("design-system build", () => {
  it("builds both systems from design/ and the app stylesheets", () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const r = spawnSync(process.execPath, [join(repo, ".design-sync", "build.mjs")], { cwd: repo, env, encoding: "utf8" });
    expect(r.stderr).not.toMatch(/problem:/);
    expect(r.status).toBe(0);

    for (const sys of ["desktop", "mobile"]) {
      const project = join(out, sys, "project");
      const tokens = JSON.parse(readFileSync(join(project, "tokens.json"), "utf8"));
      expect(tokens.color.themes.map((t: { id: string }) => t.id)).toEqual(["nightfall", "morning", "noon"]);
      // Every colour carries a value per theme, generated from the app CSS.
      for (const t of tokens.color.tokens) {
        expect(Object.keys(t.value).sort(), `${sys} ${t.name}`).toEqual(["morning", "nightfall", "noon"]);
        expect(t.usage, `${sys} ${t.name} needs a usage note`).toBeTruthy();
      }
      // The published stylesheet IS the app's.
      const bundle = readFileSync(join(project, "components", "bundle.css"), "utf8");
      const app = readFileSync(join(repo, "public", "css", sys === "desktop" ? "styles.css" : "mobile.css"), "utf8");
      expect(bundle.endsWith(app)).toBe(true);
    }

    // The alert email page is rendered from the real template, every token filled.
    const email = readFileSync(join(out, "desktop", "project", "components", "AlertEmail", "preview.html"), "utf8");
    expect(email.startsWith("<!-- @dsCard")).toBe(true);
    expect(email).toContain("fgt-branch-22");
    expect(email).not.toMatch(/\{[a-z][a-zA-Z.]*\}/);
    expect(existsSync(join(out, "mobile", "project", "components", "AppShell", "preview.html"))).toBe(true);
  }, 120_000);
});
