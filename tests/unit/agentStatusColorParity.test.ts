/**
 * tests/unit/agentStatusColorParity.test.ts
 *
 * An agent's install status is coloured in two places: the Agents settings
 * page (public/js/agent-build.js → _agentStatusBadge) and the asset panel's
 * agent row (public/js/assets.js → _agentStatusColor). They disagreed —
 * upgrade_failed read red on one and grey on the other, and the in-progress
 * statuses read accent on one and grey on the other (CQ-F021). Each file is
 * loaded standalone in its own tests, so the two helpers stay separate; this
 * test pins that they give every status the same colour.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** Source text of `function <name>(...) { ... }` from a file, braces balanced. */
function extractFn(file: string, name: string): string {
  const src = readFileSync(resolve(here, "../../public/js", file), "utf8");
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in ${file}`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name}: unbalanced braces`);
}

const badge = new Function(
  "escapeHtml",
  `${extractFn("agent-build.js", "_agentStatusBadge")}; return _agentStatusBadge;`,
)((s: string) => s) as (status: string) => string;

const color = new Function(
  `${extractFn("assets.js", "_agentStatusColor")}; return _agentStatusColor;`,
)() as (status: string) => string;

const badgeColor = (status: string) => /color:([^;]+);/.exec(badge(status))?.[1];

describe("agent status colour — Agents page and asset panel agree", () => {
  const STATUSES = [
    "active", "failed", "upgrade_failed", "uninstall_failed", "revoked",
    "pending", "uploading", "enrolling", "upgrading", "uninstalling",
    "something-new", "",
  ];
  for (const s of STATUSES) {
    it(`"${s || "(empty)"}"`, () => {
      expect(color(s)).toBe(badgeColor(s));
    });
  }

  it("a failed upgrade is danger in both", () => {
    expect(color("upgrade_failed")).toBe("var(--color-danger)");
  });
});
