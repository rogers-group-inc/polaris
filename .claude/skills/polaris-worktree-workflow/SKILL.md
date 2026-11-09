---
name: polaris-worktree-workflow
description: "Polaris session workflow: start every task in its own git worktree under .claude/worktrees/, create WORKLOCK before the first edit and DEVLOCK when a dev environment is running, finish by deleting WORKLOCK and committing; spin up or tear down a per-worktree podman dev stack; on 'merge' list the unlocked worktrees as a numbered menu and merge the chosen ones to main; on 'push' push main and clean up the merged worktrees. Load at the start of any coding task, whenever the user says worktree, lock, dev environment, dev stack, podman, merge, or push, and when a WORKLOCK/DEVLOCK question comes up."
---

# Session workflow — worktrees, locks, dev stacks, merge, push

## The six rules (also in CLAUDE.md, always in force)

1. **Never edit the main checkout.** Before the first edit of a task, create a worktree with
   `scripts/worktree-start.mjs` (→ `.claude/worktrees/<slug>` on branch `worktree-<slug>`,
   `WORKLOCK` written) — **never the `EnterWorktree` tool**. A PreToolUse hook refuses
   Edit/Write inside the repo without a `WORKLOCK`.
2. **Finishing = delete `WORKLOCK`, then commit everything in the worktree.** That
   end-of-work commit does not wait for approval (run `/polaris-docs-sync` first). Merging to
   main and pushing happen only when the user says "merge" / "push" — or invokes
   `/polaris-deploy`, which is docs-sync → deploy audit → commit → merge → push as one pipeline
   and is itself the go-ahead for the last two. It merges and cleans up only the chat's own
   worktree — never a menu of the others.
3. **A dev environment = `DEVLOCK` at the worktree root + one podman stack per worktree.**
4. **"merge"** → the merge protocol below (numbered menu of unlocked worktrees).
   **"push"** → the push protocol below (push main, clean up what was merged).
5. **Lock files (and `PARENT`) are gitignored and never committed.** Content: one line, ISO timestamp +
   purpose. A lock older than the chat that made it is stale; the merge menu shows its age.
6. **Record every error you hit** as one file in `error-log/` beside the memory directory
   (`~/.claude/projects/<this project>/error-log/`, outside the repo, never committed; its
   README has the shape). A recurring trap is logged each time — the count is the signal the
   user reviews to change this workflow.

## Which file

| Step | Read |
|---|---|
| creating and preparing a worktree (own `npm install`, `prisma generate`, no junctions), committing safely beside other sessions | [references/worktree-setup.md](references/worktree-setup.md) |
| bringing up / tearing down the per-worktree podman stack (`podman machine start`, `-p polaris-<slug>`, port offsets, `.env`, seed) | [references/dev-environment.md](references/dev-environment.md) |
| the merge menu, the merge steps, the post-merge skill review, the DEVLOCK variant | [references/merge-protocol.md](references/merge-protocol.md) |
| the push and clean-up steps | [references/push-protocol.md](references/push-protocol.md) |
| creating a worktree in one call (worktree + branch + WORKLOCK + Prisma client [+ .env, npm ci]) | [scripts/worktree-start.mjs](scripts/worktree-start.mjs) |
| the enforcement hook and how it is registered | [scripts/require-worklock.mjs](scripts/require-worklock.mjs) |
| may this worktree be removed? (lock / `PARENT` / a chat filed under its folder → keep) — merge, push and `/polaris-deploy` ask it | [scripts/worktree-keep.mjs](scripts/worktree-keep.mjs) |
| the Bash hook that refuses heredoc programs / risky file writes / repo appends (→ Shell notes) | [scripts/refuse-risky-heredoc.mjs](scripts/refuse-risky-heredoc.mjs) |

## Start of a task (short form)

One call, from the main checkout or any worktree:

```
node .claude/skills/polaris-worktree-workflow/scripts/worktree-start.mjs <slug> "<purpose>" [--env] [--install]
```

It creates `.claude/worktrees/<slug>` on branch `worktree-<slug>` from **local** `main`
(`--base <ref>` to change), writes `WORKLOCK`, and generates the Prisma client (a fresh worktree
has none, and its absence reads like a broken build: worktree-setup.md step 5). `--env` copies
the main checkout's `.env` (tests against a DB, a dev stack); `--install` runs `npm ci` (a
dependency change — otherwise Node resolves `node_modules` up-tree from the main checkout).
Then, as its own Bash call, `cd` to the path it prints; the harness makes that the working
directory. Edit with absolute paths under it.

**A large project** (a code-quality review, anything run as many batches over days) gets a
**parent** worktree: `worktree-start.mjs <project> "<purpose>" --parent` writes `PARENT` (no
`WORKLOCK`, no Prisma client — nothing is edited there), and the user opens the project's
long-running chat in that folder, so Claude Code files the chat there. Each batch is
`worktree-start.mjs <batch> "<purpose>" --under <project>` → `<project>-<batch>` from local
`main`; it merges straight to `main` and is removed like any other worktree. Each `--under`
first fast-forwards the parent to `main`, so a chat opened there reads current CLAUDE.md and
skills (the parent never has commits of its own; edit only in batches). The parent is
never offered by the merge menu nor removed by a push or `/polaris-deploy` — `worktree-keep.mjs`
says `keep` for it — until the user retires it by deleting `PARENT`. The plan and its progress
live in a committed doc on `main` (the code-quality review's is `docs/CODE-QUALITY-LEDGER.md`),
not on the parent's branch, which stays empty. **Why:** Claude Code lists a chat under the
folder it is filed in; the code-quality review's chat was filed under its first batch worktree
(`cq-guards`, by the retired EnterWorktree tool), and its own `/polaris-deploy` removed that
worktree on 2026-11-05, so the chat vanished from VS Code. A chat launched from the main
checkout and moving between worktrees with `cd` stays filed under the main checkout, which is
never removed — the parent is for a chat you want opened beside its project.

**Do not use the `EnterWorktree` tool, or the Agent tool's `isolation: "worktree"`.** Retired
2026-11-04: they refused to start on a lowercase-`c:\` launch, put the session under a Bash
guard that refused heredocs / variables / compound git (~30 logged refusals in six days), left a
git lock that broke clean-up, and branched from `origin/main`. For a subagent, create its
worktree with the script and name the absolute path in its prompt.

**Without the guard, the main checkout is protected only by discipline and the WORKLOCK hook
(which covers Edit/Write, not Bash).** So: run state-changing git (`add`, `commit`, `checkout`,
`reset`, `stash`) only from inside your worktree; touch the main checkout with `git -C
<main-checkout>` only for the merge / push protocols; never `sed -i` or redirect into a path
outside your worktree. **Watch for "Shell cwd was reset"**: a Bash call that `cd`s outside the
working directories (the error-log or memory folder, say) drops the shell back in the MAIN
checkout, not your worktree — `cd` back before the next git command, or use `git -C
<worktree-path>` throughout.

## Shell notes

The first three rows are ENFORCED by `scripts/refuse-risky-heredoc.mjs`, a PreToolUse Bash hook
(registered like `require-worklock.mjs`, in the main checkout's `.claude/settings.local.json`):
it refuses a heredoc that is a python/node program, a file-writing heredoc with a backslash or
non-ASCII in it, and a heredoc appended to a repo file. The notes alone did not stop them (~12
error-log entries in the four days after they were written), and the mangling is the Bash
TOOL's — a quoted `<<'EOF'` loses backslashes too — so no quoting gets past it.

| Trap | Do instead |
|---|---|
| `cat >> f <<'EOF'` to append source | **Edit** (anchor on the last block) — no CRLF / escaping surprises |
| a Python/Node edit script over CRLF files (`public/js/*`) | normalise `\r\n` before matching, or use Edit, which matches either |
| non-ASCII (`—`, `→`) or backslashes through a Git Bash heredoc | **Write** the script to the scratchpad, run `python <script> <args>`; `PYTHONIOENCODING=utf-8` when it prints non-ASCII |
| a commit message with `->` / quotes / backticks | **Write** it to the scratchpad, `git commit -F <file>` |
| `sed -i` on a CRLF file | it keeps CRLF only per line it rewrites — check the per-file diffstat |
| a session still on a legacy `EnterWorktree` worktree | its guard refuses heredocs, `$var` / `$(…)` paths, `xargs`, git in a compound — one plain command per call, literal paths |

## End of a task (short form)

One-command form: `/polaris-deploy` does everything below and carries on through merge and
push. The steps stay here for a commit made outside that pipeline.

```
/polaris-docs-sync                            # refresh the skill entries the change touched
npm run check:docs && npm run typecheck && npm run lint && npx vitest run tests/unit
# typecheck and lint both cover tests/ as well as src/ (since 2026-11-09)
# and, when the work touched a route / service / contract, the suite CI gates the image on:
#   DATABASE_URL=… npx vitest run tests/integration --no-file-parallelism   (needs a real DB)
rm WORKLOCK
git add -A && git commit                      # one logical change per commit; last one closes the work
```
Report the branch name and say the worktree is ready to merge. Do not merge or push.

## "merge" (short form; full steps in merge-protocol.md)

1. `git worktree list --porcelain`; for each non-main worktree check for `WORKLOCK` / `DEVLOCK`.
2. Print a **numbered list of the unlocked worktrees** (branch · commits ahead of main · last
   subject · dirty?) and, un-numbered, the locked ones with each lock's age. A `PARENT`
   worktree is never numbered: list it as a project with its `<parent>-<batch>` worktrees
   beneath (those are numbered as usual and merge straight to main).
3. The user picks numbers. For each pick, in order: commit anything pending in that worktree;
   from the main checkout `git merge --no-ff worktree-<slug>`; on conflict stop and report.
4. **Review what landed against the skills**: read each merged branch as one diff and ask what
   a future session must now be told — a new invariant → a numbered business rule; a new
   subsystem → an entry in the owning skill, or a new skill when nothing's `description:`
   would ever reach it; drifted trigger phrases; prose the diff contradicts in a file no commit
   touched; traps that cost this chat time. Report "skills current" or the concrete list; make
   the edits in their own worktree, never on main.
5. After the last merge: `npm run check:docs` + `npm run typecheck` on main. **Do not push.**
6. If the chat's own worktree holds a `DEVLOCK` and the user asks to merge it: tear the stack
   down (`podman compose -p polaris-<slug> down -v`), delete `DEVLOCK`, commit pending, then merge.

## "push" (short form; full steps in push-protocol.md)

1. Run `/polaris-deploy`'s deployment-surface audit; stage fixes as their own commit (skipped
   when this push is the last stage of `/polaris-deploy` — its audit already ran in the worktree).
2. `git push origin main`.
3. For each worktree merged in this session (plus any `worktree-*` branch already fully merged,
   `git branch --merged main` — but under `/polaris-deploy` only the chat's own): refuse unless
   `scripts/worktree-keep.mjs <path>` prints `remove` (a lock, a `PARENT`, or a chat filed
   under the folder all mean keep); check for directory junctions;
   `podman compose -p polaris-<slug> down -v` if a stack lingers; `git worktree unlock <path>`
   (a legacy EnterWorktree lock; ignore "is not locked"); `git worktree remove <path>`;
   `git branch -d worktree-<slug>`. Report what was removed.

## Why it is shaped this way

Two or three chats work this repo at once. A worktree per chat keeps their indexes apart
(the shared-tree landing incidents of 2026-08 are in `worktree-setup.md`); the lock files let
a merge session tell "finished" from "someone is still typing" without asking; the numbered
menu keeps the merge decision human; the skill review happens at merge because that is the
first time a unit of work is legible as one diff rather than a string of commits; and cleaning
up on push, not on merge, leaves a merged worktree inspectable until the code has actually left
the machine.
