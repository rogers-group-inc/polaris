#!/usr/bin/env node
// worktree-start.mjs — create a ready-to-edit Polaris worktree in ONE call.
//
//   node .claude/skills/polaris-worktree-workflow/scripts/worktree-start.mjs <slug> "<purpose>" [--env] [--install] [--base <ref>]
//
// Replaces the EnterWorktree tool (retired 2026-11-04 after the error-log review): EnterWorktree
// put the session under a Bash guard that refused heredocs, shell variables, loops and compound
// git (~30 logged refusals in six days), refused to enter on a lowercase-`c:\` launch (8), left a
// git-level lock that broke `git worktree remove` (5), branched from origin/main rather than the
// local main that unpushed merges land on, and still left the worktree without a Prisma client
// (7). This script does the whole start block, from the main checkout or any worktree:
//
//   1. git worktree add -b worktree-<slug> <main>/.claude/worktrees/<slug> <base>  (base: local main)
//   2. WORKLOCK at the root (ISO timestamp + purpose)
//   3. prisma generate (prisma.config.ts gives generate a placeholder URL when none is set)
//   4. --env      copy the main checkout's .env (tests against a DB, a dev stack)
//      --install  npm ci in the worktree (a dependency change; otherwise node_modules resolves up-tree)
//
// Then the session moves in with a plain `cd .claude/worktrees/<slug>` (Bash) — the harness makes
// that the working directory and the require-worklock hook guards every edit.
//
// A LARGE project (a code-quality review, a migration in many batches) gets a parent:
//
//   worktree-start.mjs <parent> "<purpose>" --parent        home worktree: PARENT file, no WORKLOCK,
//                                                            no Prisma client — nothing is edited there
//   worktree-start.mjs <batch> "<purpose>" --under <parent>  sub-worktree <parent>-<batch>, from main
//
// Each sub-worktree merges straight to main and is removed as usual; the parent is never offered
// by the merge menu nor removed by a push (worktree-keep.mjs) until the user deletes PARENT.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function die(msg) {
  process.stderr.write(`worktree-start: ${msg}\n`);
  process.exit(1);
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) die(`${cmd} ${args.join(" ")} failed:\n${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const valueOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const valueIdx = new Set(["--base", "--under"].map((f) => argv.indexOf(f)).filter((i) => i >= 0).map((i) => i + 1));
const base = valueOf("--base") ?? "main";
const under = valueOf("--under");
const isParent = flags.has("--parent");
const positional = argv.filter((a, i) => !a.startsWith("--") && !valueIdx.has(i));
const [given, purpose] = positional;
const USAGE = `usage: worktree-start.mjs <slug> "<purpose>" [--env] [--install] [--base <ref>] [--parent | --under <parent>]`;

if (!given || !purpose) die(USAGE);
if (!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(given)) die(`slug "${given}" must be lowercase letters, digits, dots and dashes`);
if (flags.has("--base") && !valueOf("--base")) die("--base needs a ref");
if (flags.has("--under") && !under) die("--under needs the parent's slug");
if (isParent && under) die("--parent and --under are exclusive (a parent has no parent)");
for (const f of flags) if (!["--env", "--install", "--base", "--parent", "--under"].includes(f)) die(`unknown flag ${f}`);
const slug = under && !given.startsWith(`${under}-`) ? `${under}-${given}` : given;

// The main checkout is the parent of the common git dir, wherever this runs from.
const commonDir = run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
const main = dirname(resolve(commonDir));
if (!existsSync(join(main, ".claude", "skills", "polaris-worktree-workflow", "SKILL.md"))) {
  die(`${main} is not a Polaris checkout`);
}
const path = join(main, ".claude", "worktrees", slug);
const branch = `worktree-${slug}`;
if (existsSync(path)) die(`${path} already exists — pick another slug, or work in that worktree`);
const branchExists = spawnSync("git", ["-C", main, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
if (branchExists) die(`branch ${branch} already exists — pick another slug`);
if (under && !existsSync(join(main, ".claude", "worktrees", under, "PARENT"))) {
  die(`no parent worktree "${under}" (.claude/worktrees/${under}/PARENT) — start it with --parent first`);
}

// A chat opened in the parent reads CLAUDE.md and the skills from the parent's checkout, so keep
// it at main: the parent never has commits of its own, so a fast-forward always applies.
let parentNote = "";
if (under) {
  const parentPath = join(main, ".claude", "worktrees", under);
  const ff = spawnSync("git", ["-C", parentPath, "merge", "--ff-only", "-q", "main"], { encoding: "utf8" });
  parentNote = ff.status === 0
    ? `parent ${under} fast-forwarded to main (its chat reads current skills)`
    : `parent ${under} NOT fast-forwarded (${(ff.stderr || "").trim().split("\n")[0]}) — it has commits or changes of its own; it should not`;
}

run("git", ["-C", main, "worktree", "add", "-q", "-b", branch, path, base]);
const short = run("git", ["-C", path, "rev-parse", "--short", "HEAD"]);

if (isParent) {
  writeFileSync(join(path, "PARENT"), `${new Date().toISOString()} ${purpose}\n`);
  const p = path.replace(/\\/g, "/");
  process.stdout.write(
    `  ✓ parent worktree ${path}\n  ✓ branch ${branch} from ${base} @ ${short} (stays empty — batches merge straight to main)\n  ✓ PARENT written\n\n` +
    `Open the project's long-running chat HERE so it is filed under this folder:\n` +
    `  VS Code:  code ${p}      CLI:  cd ${p} && claude\n` +
    `Each batch:  node .claude/skills/polaris-worktree-workflow/scripts/worktree-start.mjs <batch> "<purpose>" --under ${slug}\n` +
    `Merge / push never remove this worktree; retire it by deleting PARENT when the project is done.\n`,
  );
  process.exit(0);
}

writeFileSync(join(path, "WORKLOCK"), `${new Date().toISOString()} ${purpose}\n`);
const steps = [`worktree ${path}`, `branch ${branch} from ${base} @ ${short}${under ? ` (a batch of ${under})` : ""}`, "WORKLOCK written"];
if (parentNote) steps.push(parentNote);

if (flags.has("--env")) {
  const src = join(main, ".env");
  if (existsSync(src)) { copyFileSync(src, join(path, ".env")); steps.push(".env copied from the main checkout"); }
  else steps.push("no .env in the main checkout — none copied");
}
// prisma.config.ts gives generate a placeholder itself since 2026-11-04; a base older than that
// does not, so set one here too (generate never connects).
const generateEnv = { ...process.env, DATABASE_URL: process.env.DATABASE_URL || "postgresql://generate:generate@localhost:5432/generate" };
if (flags.has("--install")) {
  run("npm ci --no-audit --no-fund", [], { cwd: path, shell: true, env: generateEnv });
  steps.push("npm ci done (postinstall generated the Prisma client)");
} else {
  run("npx prisma generate", [], { cwd: path, shell: true, env: generateEnv });
  steps.push("Prisma client generated");
}

process.stdout.write(
  steps.map((s) => `  ✓ ${s}`).join("\n") +
  `\n\nNext (Bash, its own call):  cd ${path.replace(/\\/g, "/")}\n` +
  `Then edit with absolute paths under ${path}.\n`,
);
