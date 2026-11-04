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
const baseIdx = argv.indexOf("--base");
const base = baseIdx >= 0 ? argv[baseIdx + 1] : "main";
const positional = argv.filter((a, i) => !a.startsWith("--") && !(baseIdx >= 0 && i === baseIdx + 1));
const [slug, purpose] = positional;

if (!slug || !purpose) die(`usage: worktree-start.mjs <slug> "<purpose>" [--env] [--install] [--base <ref>]`);
if (!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(slug)) die(`slug "${slug}" must be lowercase letters, digits, dots and dashes`);
if (!base) die("--base needs a ref");
for (const f of flags) if (!["--env", "--install", "--base"].includes(f)) die(`unknown flag ${f}`);

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

run("git", ["-C", main, "worktree", "add", "-q", "-b", branch, path, base]);
writeFileSync(join(path, "WORKLOCK"), `${new Date().toISOString()} ${purpose}\n`);

const steps = [`worktree ${path}`, `branch ${branch} from ${base} @ ${run("git", ["-C", path, "rev-parse", "--short", "HEAD"])}`, "WORKLOCK written"];

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
