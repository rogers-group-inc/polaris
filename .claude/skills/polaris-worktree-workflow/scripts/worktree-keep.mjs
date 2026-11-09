#!/usr/bin/env node
// worktree-keep.mjs — may this worktree be merged-and-removed, or must it be kept?
//
//   node .claude/skills/polaris-worktree-workflow/scripts/worktree-keep.mjs [<worktree-path> ...]
//
// With no paths: every worktree under <main>/.claude/worktrees/. One line per worktree:
//
//   remove  <slug>
//   keep    <slug>  — PARENT (code-quality review); 2 chats filed here; WORKLOCK
//
// A worktree is KEPT when any of these holds:
//   - WORKLOCK / DEVLOCK at its root — a chat is editing it / a dev stack runs from it;
//   - PARENT at its root — the home of a large project (worktree-start.mjs --parent); only the
//     user retires one, by deleting PARENT;
//   - a Claude Code chat is FILED under its folder (~/.claude/projects/<encoded path>/*.jsonl).
//     Claude Code lists chats by the folder they were launched in, so removing that folder makes
//     the chat unreachable from VS Code and `claude --resume`. The code-quality review's chat
//     vanished this way on 2026-11-05: the retired EnterWorktree tool re-filed it under its first
//     batch worktree (cq-guards), and the chat's own /polaris-deploy removed that worktree.
//
// The merge menu leaves kept worktrees out (a PARENT's sub-worktrees are listed under it), and
// the push clean-up never removes one. Exit code is 0 unless the arguments are unusable.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

/** Claude Code's project-folder name for a working directory: every non-alphanumeric → "-". */
export function encodeProjectDir(dir) {
  return resolve(dir).replace(/[^A-Za-z0-9]/g, "-");
}

/** Number of chats Claude Code has filed under `dir` (drive-letter case varies: c-- / C--). */
export function chatsFiledUnder(dir, projectsRoot = join(homedir(), ".claude", "projects")) {
  if (!existsSync(projectsRoot)) return 0;
  const want = encodeProjectDir(dir).toLowerCase();
  let n = 0;
  for (const name of readdirSync(projectsRoot)) {
    if (name.toLowerCase() !== want) continue;
    const p = join(projectsRoot, name);
    if (!statSync(p).isDirectory()) continue;
    n += readdirSync(p).filter((f) => f.endsWith(".jsonl")).length;
  }
  return n;
}

/** The reasons a worktree must be kept; empty means it may be removed once merged. */
export function keepReasons(path, projectsRoot) {
  const reasons = [];
  const parent = join(path, "PARENT");
  if (existsSync(parent)) {
    const purpose = readFileSync(parent, "utf8").trim().replace(/^\S+\s+/, "");
    reasons.push(`PARENT${purpose ? ` (${purpose})` : ""}`);
  }
  const chats = chatsFiledUnder(path, projectsRoot);
  if (chats) reasons.push(`${chats} chat${chats === 1 ? "" : "s"} filed here`);
  for (const lock of ["WORKLOCK", "DEVLOCK"]) if (existsSync(join(path, lock))) reasons.push(lock);
  return reasons;
}

function main() {
  let paths = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (paths.length === 0) {
    const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
    if (r.status !== 0) { process.stderr.write("worktree-keep: not inside a git checkout\n"); process.exit(1); }
    const root = join(resolve(r.stdout.trim()), "..", ".claude", "worktrees");
    paths = existsSync(root) ? readdirSync(root).map((d) => join(root, d)).filter((p) => statSync(p).isDirectory()) : [];
  }
  for (const p of paths) {
    const reasons = keepReasons(resolve(p));
    process.stdout.write(reasons.length ? `keep    ${basename(p)}  — ${reasons.join("; ")}\n` : `remove  ${basename(p)}\n`);
  }
}

if (process.argv[1] && basename(process.argv[1]) === "worktree-keep.mjs") main();
