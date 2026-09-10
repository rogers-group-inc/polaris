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
fully merged into `main` (`git branch --merged main | grep '^  worktree-'`). For each:

1. **Refuse** if `WORKLOCK` or `DEVLOCK` exists at its path — a lock means a chat may still be
   using it; list it as skipped.
2. Check for directory junctions inside it (`node_modules`, `src/generated` pointing at the main
   checkout). If any: drop them with PowerShell `(Get-Item $p).Delete()` first — `git worktree
   remove` follows a junction and deletes the target.
3. If a dev stack lingers (`podman ps -a --format '{{.Names}}' | grep polaris-<slug>`):
   `podman compose -f compose.dev.yml -p polaris-<slug> down -v`.
4. `git worktree remove <path>` (add `--force` only for untracked leftovers like `.env`,
   `node_modules`, `src/generated`, never for uncommitted source changes — those mean the
   worktree was not actually finished; report instead).
5. `git branch -d worktree-<slug>` (`-d`, not `-D`: it refuses if the branch is not merged,
   which is the safety you want).

If a `git worktree remove` fails with "Permission denied", a Bash tool call still has that
directory as its cwd — `cd` out and retry.

## 4. Report

List what was pushed, which worktrees and branches were removed, and which were skipped and why
(lock present / not merged / dirty). `git worktree prune` at the end clears stale metadata for
directories deleted by hand.
