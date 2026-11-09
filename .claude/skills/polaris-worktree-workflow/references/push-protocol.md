# Push protocol

Triggered by the user saying "push", or as the last stage of `/polaris-deploy`. Those two are
the go-ahead; nothing else is.

## 1. Pre-push audit

Run the deployment-surface audit in `/polaris-deploy` (README, `docs/INSTALL.md`, `deploy/`
scripts, Dockerfile / compose, Grafana JSON if a metric moved). Stage any fixes as their own
commit on `main` before pushing. Inside `/polaris-deploy` the audit already ran in the worktree
(its step 2) — skip to the push. If `main` is behind `origin/main`, stop and report — the user
decides whether to merge or rebase.

## 2. Push

```
git push origin main
```

Report the pushed range (`old..new`).

## 3. Clean up the merged worktrees

Candidates: every worktree merged in this session, plus any other `worktree-*` branch already
fully merged into `main` (`git branch --merged main | grep '^  worktree-'`). **Inside
`/polaris-deploy` the only candidate is the invoking chat's own worktree** — other merged
branches are left for a bare "push". For each:

1. **Refuse** unless `node .claude/skills/polaris-worktree-workflow/scripts/worktree-keep.mjs
   <path>` prints `remove`. It prints `keep — <reasons>` for a `WORKLOCK` / `DEVLOCK` (a chat
   may still be using it), a `PARENT` (the home of a large project — only the user retires it,
   by deleting `PARENT`), and a worktree a Claude Code chat is FILED under (removing the folder
   makes that chat unreachable from VS Code and `claude --resume`; the code-quality review's
   chat was lost this way on 2026-11-05). List each as skipped with its reasons.
2. Check for directory junctions inside it (`node_modules`, `src/generated` pointing at the main
   checkout). If any: drop them with PowerShell `(Get-Item $p).Delete()` first — `git worktree
   remove` follows a junction and deletes the target.
3. If a dev stack lingers (`podman ps -a --format '{{.Names}}' | grep polaris-<slug>`):
   `podman compose -f compose.dev.yml -p polaris-<slug> down -v`.
4. `git worktree unlock <path>` — no-op output aside, harmless when unlocked. A worktree made
   by the retired `EnterWorktree` tool carries a git-level lock ("claude session <slug>
   (pid …)") that `ExitWorktree keep` leaves behind, and `remove` refuses it (five logged
   clean-ups, 2026-10-30 → 11-02). Its own call; ignore "is not locked".
5. `git worktree remove <path>` (add `--force` only for untracked leftovers like `.env`,
   `node_modules`, `src/generated`, never for uncommitted source changes — those mean the
   worktree was not actually finished; report instead).
6. `git branch -d worktree-<slug>` (`-d`, not `-D`: it refuses if the branch is not merged,
   which is the safety you want).

If a `git worktree remove` fails with "Permission denied", a Bash tool call still has that
directory as its cwd — `cd <main-checkout>` and retry (a session that `cd`'d into its own
worktree must leave it before removing it).

## 4. Report

List what was pushed, which worktrees and branches were removed, and which were skipped and why
(lock present / not merged / dirty). `git worktree prune` at the end clears stale metadata for
directories deleted by hand.
