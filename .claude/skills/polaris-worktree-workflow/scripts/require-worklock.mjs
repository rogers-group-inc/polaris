#!/usr/bin/env node
// require-worklock.mjs — PreToolUse hook for Edit|Write|MultiEdit|NotebookEdit.
//
// Enforces the Polaris session workflow: a file inside the repository may only be edited from
// a git WORKTREE (never the main checkout), and only while that worktree carries a WORKLOCK
// file at its root. Everything outside the repository (scratchpad, memory, plan files, other
// repos) passes untouched.
//
// Opt-in per repository: enforcement applies only when the MAIN checkout contains
// .claude/skills/polaris-worktree-workflow/SKILL.md, so registering this hook at the user
// level is safe for repositories that do not use the workflow.
//
// Register in the main checkout's .claude/settings.local.json (read from the main checkout
// even when the session sits in a worktree) or in ~/.claude/settings.json:
//   { "hooks": { "PreToolUse": [ { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
//       "hooks": [ { "type": "command", "command": "f=\"$CLAUDE_PROJECT_DIR/.claude/skills/polaris-worktree-workflow/scripts/require-worklock.mjs\"; [ -f \"$f\" ] && exec node \"$f\"; exit 0" } ] } ] } }
//
// Blocks with exit code 2 (stderr is shown to Claude as the reason). Any unexpected error
// fails OPEN (exit 0) after printing a warning — a broken hook must not freeze every edit.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

function readStdin() {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}
function findGitRoot(start) {
  let dir = resolve(start);
  for (;;) {
    const g = join(dir, ".git");
    if (existsSync(g)) return { dir, git: g };
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function mainCheckoutOf(root) {
  // A worktree has a .git FILE: "gitdir: <main>/.git/worktrees/<name>"
  if (statSync(root.git).isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(root.git, "utf8"));
    if (m) {
      const gitdir = resolve(root.dir, m[1].trim());            // <main>/.git/worktrees/<name>
      return { main: dirname(dirname(dirname(gitdir))), isWorktree: true };
    }
  }
  return { main: root.dir, isWorktree: false };
}
const norm = (p) => resolve(p).replace(/\//g, sep).toLowerCase();
const under = (p, base) => norm(p).startsWith(norm(base) + sep) || norm(p) === norm(base);

try {
  const input = JSON.parse(readStdin() || "{}");
  const ti = input.tool_input || {};
  const target = ti.file_path || ti.notebook_path || ti.path;
  if (!target) process.exit(0);
  const targetDir = dirname(resolve(target));
  const root = findGitRoot(existsSync(targetDir) ? targetDir : dirname(targetDir));
  if (!root) process.exit(0);                                   // not in any git repo
  const { main, isWorktree } = mainCheckoutOf(root);
  const marker = join(main, ".claude", "skills", "polaris-worktree-workflow", "SKILL.md");
  if (!existsSync(marker)) process.exit(0);                    // repo has not opted in
  // Per-developer settings in the main checkout are not repo content; allow them.
  if (!isWorktree && /^\.claude[\\/]settings(\.local)?\.json$/i.test(resolve(target).slice(main.length + 1))) process.exit(0);
  if (!isWorktree) {
    process.stderr.write(
      `Polaris workflow: ${target} is in the MAIN checkout. Create a worktree first (EnterWorktree), ` +
      `write WORKLOCK at its root, and edit there. See .claude/skills/polaris-worktree-workflow/SKILL.md.\n`);
    process.exit(2);
  }
  if (!under(root.dir, join(main, ".claude", "worktrees"))) {
    // A worktree that lives elsewhere (manual git worktree add) is still a worktree — apply the lock rule.
  }
  // Writing the lock itself is how the rule is satisfied.
  if (norm(target) === norm(join(root.dir, "WORKLOCK"))) process.exit(0);
  if (!existsSync(join(root.dir, "WORKLOCK"))) {
    process.stderr.write(
      `Polaris workflow: no WORKLOCK in worktree ${root.dir}. Write it before editing:\n` +
      `  printf '%s %s\\n' "$(date -u +%FT%TZ)" "<purpose>" > WORKLOCK\n` +
      `(If the work is finished and committed, this edit should be happening in a new worktree.)\n`);
    process.exit(2);
  }
  process.exit(0);
} catch (err) {
  process.stderr.write(`require-worklock hook error (failing open): ${err && err.message}\n`);
  process.exit(0);
}
