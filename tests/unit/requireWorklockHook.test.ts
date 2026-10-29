/**
 * tests/unit/requireWorklockHook.test.ts — pins the PreToolUse hook that gates
 * edits on a worktree's WORKLOCK (.claude/skills/polaris-worktree-workflow/
 * scripts/require-worklock.mjs). The Write that creates WORKLOCK itself must
 * pass; every other edit in an unlocked worktree, or in the main checkout, is
 * refused with exit 2.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HOOK = resolve(__dirname, "../../.claude/skills/polaris-worktree-workflow/scripts/require-worklock.mjs");

let base: string;
let main: string;
let wt: string;

function run(target: string): number {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_input: { file_path: target } }),
    encoding: "utf8",
  });
  return r.status ?? -1;
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "worklock-hook-"));
  main = join(base, "main");
  wt = join(main, ".claude", "worktrees", "wt");
  mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
  mkdirSync(join(main, ".claude", "skills", "polaris-worktree-workflow"), { recursive: true });
  writeFileSync(join(main, ".claude", "skills", "polaris-worktree-workflow", "SKILL.md"), "");
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("require-worklock hook", () => {
  it("lets the Write that creates WORKLOCK through in an unlocked worktree", () => {
    expect(run(join(wt, "WORKLOCK"))).toBe(0);
  });

  it("refuses any other edit in an unlocked worktree", () => {
    expect(run(join(wt, "src", "x.ts"))).toBe(2);
  });

  it("refuses a WORKLOCK in the main checkout", () => {
    expect(run(join(main, "WORKLOCK"))).toBe(2);
  });

  it("allows edits once WORKLOCK exists", () => {
    writeFileSync(join(wt, "WORKLOCK"), "x\n");
    expect(run(join(wt, "src", "x.ts"))).toBe(0);
  });
});
