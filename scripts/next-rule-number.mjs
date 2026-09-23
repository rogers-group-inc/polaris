#!/usr/bin/env node
// Which business-rule number is free? Derived, never stated: scans EVERY local branch (main plus
// each worktree-* branch), because two open worktrees each taking "the next free number" off
// main alone is exactly how 44 and 77 were both claimed twice (merge-protocol.md § 3).
//
// Run:  npm run rules:next        (or: node scripts/next-rule-number.mjs [--json])
//
// For each branch it reads, from that branch's tree (not the working copy):
//   - every `N. **` invariant line in references/invariants-*.md
//   - every `## Rule N` heading in references/narrative-*.md (incl. per-rule files)
//   - every `| N |` index row in SKILL.md
// and reports the highest number seen anywhere plus one. Numbers a branch holds that main does
// not are listed, since those are the collisions-in-waiting. 81 is a deliberate gap (published
// then reverted the same week); a gap is never re-used.
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = ".claude/skills/polaris-business-rules";
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

function ruleNumbersIn(text, kind) {
  if (kind === "index") {
    // | N | title | invariants-file | narrative-file |  — a row whose file cell is "—" is a
    // placeholder (a deliberate gap, or a number an in-flight worktree holds) and claims nothing.
    return [...text.matchAll(/^\| (\d+)a? \| (?:\\\||[^|])* \| ([^|]+) \|/gm)]
      .filter((m) => m[2].trim() !== "—")
      .map((m) => Number(m[1]));
  }
  const re = kind === "invariant" ? /^(\d+)a?\. \*\*/gm : /^## Rule (\d+)a?\b/gm;
  return [...text.matchAll(re)].map((m) => Number(m[1]));
}

function scanBranch(ref) {
  const found = new Set();
  let files;
  try {
    files = git("ls-tree", "-r", "--name-only", ref, "--", SKILL).split("\n").filter(Boolean);
  } catch {
    return null; // branch has no such path (very old) — nothing to count
  }
  for (const f of files) {
    const base = f.split("/").pop();
    const kind = /^invariants-.*\.md$/.test(base) ? "invariant" : /^narrative-.*\.md$/.test(base) ? "narrative" : base === "SKILL.md" ? "index" : null;
    if (!kind) continue;
    let text;
    try { text = git("show", `${ref}:${f}`); } catch { continue; }
    for (const n of ruleNumbersIn(text, kind)) found.add(n);
  }
  return found;
}

const branches = git("for-each-ref", "--format=%(refname:short)", "refs/heads/main", "refs/heads/worktree-*").split("\n").filter(Boolean);
let head = "";
try { head = git("rev-parse", "--abbrev-ref", "HEAD").trim(); } catch { /* detached */ }
if (head && head !== "HEAD" && !branches.includes(head)) branches.push(head);

const perBranch = new Map();
for (const b of branches) {
  const s = scanBranch(b);
  if (s) perBranch.set(b, s);
}
const mainSet = perBranch.get("main") ?? new Set();
let max = 0;
for (const s of perBranch.values()) for (const n of s) if (n > max) max = n;
const next = max + 1;

const json = process.argv.includes("--json");
if (json) {
  const out = { next, branches: {} };
  for (const [b, s] of perBranch) out.branches[b] = { max: Math.max(0, ...s), notOnMain: [...s].filter((n) => !mainSet.has(n)).sort((a, b) => a - b) };
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`Next free business-rule number: ${next}\n`);
  console.log("branch".padEnd(44) + "highest  not on main");
  for (const [b, s] of perBranch) {
    const notOnMain = [...s].filter((n) => !mainSet.has(n)).sort((a, b) => a - b);
    console.log(b.padEnd(44) + String(Math.max(0, ...s)).padEnd(9) + (b === "main" ? "—" : notOnMain.join(" ") || "—"));
  }
  console.log("\n81 is a deliberate gap and is never re-used. A number listed under \"not on main\" is claimed by an");
  console.log("in-flight worktree: do not take it, and when that branch merges second it keeps its number only if");
  console.log("nothing else took it first (merge-protocol.md § 3).");
}
