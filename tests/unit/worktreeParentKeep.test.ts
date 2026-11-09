/**
 * tests/unit/worktreeParentKeep.test.ts — the parent-worktree workflow
 * (.claude/skills/polaris-worktree-workflow/scripts/worktree-keep.mjs and the
 * --parent / --under flags of worktree-start.mjs). A worktree is kept by merge
 * and push while it holds a lock, a PARENT marker, or a Claude Code chat filed
 * under its folder — the code-quality review's chat vanished on 2026-11-05
 * when its own deploy removed the worktree it was filed under.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPTS = resolve(__dirname, "../../.claude/skills/polaris-worktree-workflow/scripts");
const START = join(SCRIPTS, "worktree-start.mjs");

type KeepModule = {
  encodeProjectDir: (dir: string) => string;
  chatsFiledUnder: (dir: string, root?: string) => number;
  keepReasons: (path: string, root?: string) => string[];
};
let keep: KeepModule;
let base: string;

beforeAll(async () => {
  keep = (await import(pathToFileURL(join(SCRIPTS, "worktree-keep.mjs")).href)) as KeepModule;
  base = mkdtempSync(join(tmpdir(), "wt-parent-"));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("worktree-keep", () => {
  it("encodes a folder the way Claude Code names its project folder", () => {
    const enc = keep.encodeProjectDir("C:\\Users\\u\\VSCode\\polaris\\.claude\\worktrees\\cq-guards");
    expect(enc.endsWith("-Users-u-VSCode-polaris--claude-worktrees-cq-guards")).toBe(true);
    expect(enc).not.toMatch(/[^A-Za-z0-9-]/);
  });

  it("counts the chats filed under a worktree, whatever the drive-letter case", () => {
    const wt = join(base, "wt-chat");
    mkdirSync(wt);
    const projects = join(base, "projects");
    const folder = keep.encodeProjectDir(wt);
    const flipped = folder[0] === folder[0].toUpperCase() ? folder[0].toLowerCase() + folder.slice(1) : folder[0].toUpperCase() + folder.slice(1);
    mkdirSync(join(projects, flipped), { recursive: true });
    writeFileSync(join(projects, flipped, "abc.jsonl"), "{}\n");
    writeFileSync(join(projects, flipped, "notes.txt"), "not a chat\n");
    expect(keep.chatsFiledUnder(wt, projects)).toBe(1);
    expect(keep.keepReasons(wt, projects)).toEqual(["1 chat filed here"]);
  });

  it("keeps a PARENT (naming its purpose) and a locked worktree; frees a plain merged one", () => {
    const projects = join(base, "no-projects");
    const parent = join(base, "wt-parent");
    mkdirSync(parent);
    writeFileSync(join(parent, "PARENT"), "2026-11-09T00:00:00Z code-quality review\n");
    expect(keep.keepReasons(parent, projects)).toEqual(["PARENT (code-quality review)"]);

    const locked = join(base, "wt-locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "WORKLOCK"), "x\n");
    writeFileSync(join(locked, "DEVLOCK"), "x\n");
    expect(keep.keepReasons(locked, projects)).toEqual(["WORKLOCK", "DEVLOCK"]);

    const plain = join(base, "wt-plain");
    mkdirSync(plain);
    expect(keep.keepReasons(plain, projects)).toEqual([]);
  });
});

describe("worktree-start --parent / --under", () => {
  let repo: string;
  const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  const start = (...args: string[]) => spawnSync(process.execPath, [START, ...args], { cwd: repo, encoding: "utf8" });

  beforeAll(() => {
    repo = join(base, "repo");
    mkdirSync(join(repo, ".claude", "skills", "polaris-worktree-workflow"), { recursive: true });
    writeFileSync(join(repo, ".claude", "skills", "polaris-worktree-workflow", "SKILL.md"), "x\n");
    git("init", "-q", "-b", "main");
    git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
  });

  it("--parent makes a home worktree with PARENT and no WORKLOCK", () => {
    const r = start("cq", "code-quality review", "--parent");
    expect(r.status, r.stderr).toBe(0);
    const p = join(repo, ".claude", "worktrees", "cq");
    expect(readFileSync(join(p, "PARENT"), "utf8")).toMatch(/code-quality review/);
    expect(existsSync(join(p, "WORKLOCK"))).toBe(false);
    expect(r.stdout).toMatch(/--under cq/);
  });

  it("--under refuses a parent that does not exist", () => {
    const r = start("dup-helpers", "batch", "--under", "nope");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no parent worktree "nope"/);
  });

  it("--parent and --under together are refused", () => {
    const r = start("x", "y", "--parent", "--under", "cq");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/exclusive/);
  });
});
