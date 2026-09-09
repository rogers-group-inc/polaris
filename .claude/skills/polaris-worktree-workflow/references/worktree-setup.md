# Worktree setup and safe committing

## Creating the worktree

Use the `EnterWorktree` tool with a short slug (`skills-conversion`, `fix-arp-tab`). It creates
`.claude/worktrees/<slug>` on branch `worktree-<slug>` from `origin/main` (setting
`worktree.baseRef`; check `git status -sb` in the main checkout first — if local `main` is
ahead of `origin/main`, the fresh worktree will not carry those commits) and switches the
session's working directory into it. Then, before the first edit:

```
printf '%s %s\n' "$(date -u +%FT%TZ)" "<purpose>" > WORKLOCK
```

`WORKLOCK` and `DEVLOCK` are gitignored. Their presence is the only signal another chat has
that this worktree is in use, so write `WORKLOCK` immediately and delete it only when the
work is committed.

## Making the worktree usable

A fresh worktree has no `.env`, no `node_modules` and no `src/generated/prisma`.

1. `cp <main-checkout>/.env .env` — gitignored; `prisma generate` reads `DATABASE_URL` from it
   at config-load time without connecting.
2. `npm install --no-audit --no-fund` — its own `node_modules` (about a minute on this PC) and,
   via `postinstall`, its own generated Prisma client. `postinstall` also runs
   `git config core.hooksPath .githooks`, so the pre-commit doc guard is active here too.
3. **Never junction `node_modules` or `src/generated` from the main checkout into a worktree.**
   Both `rm -rf` (MSYS) and `git worktree remove --force` follow directory junctions and delete
   the TARGET — they emptied the live repo's `node_modules/` and `src/generated/` twice in one
   session (2026-08-28). If a junction exists, drop it with PowerShell `(Get-Item $p).Delete()`
   before removing the worktree. Never run `prisma generate` through a junction either: it
   overwrites the shared tree's client with this branch's schema.
4. Without a reachable database the test suite **silently skips ~34 files** and still reports
   green; a green host-side run does not validate a schema or migration change. See
   `dev-environment.md` to give the worktree its own database, or run the unit suite only
   (`npx vitest run tests/unit --no-file-parallelism`).
5. A wall of implicit-`any` typecheck errors or "81 files failed, 0 tests" in a brand-new
   worktree means the generated client is missing, not that the change is broken — run
   `npx prisma generate` (with `DATABASE_URL` set to anything well-formed) first.
6. **Nothing tells you step 2 was skipped.** The worktrees live INSIDE the main checkout
   (`<repo>/.claude/worktrees/<slug>`), so Node's `node_modules` lookup walks up the tree and
   finds the main checkout's — `npm run lint`, `npm run typecheck` and `npx vitest` all run in
   a worktree with no `node_modules` of its own, and none of them complain. `src/generated/prisma`
   is resolved as a path INSIDE the worktree, though, so the only symptom of an unprepared
   worktree is step 5's wall of ~900 implicit-`any` errors, which reads like the change broke
   the build. Verified 2026-09-09: `npm run typecheck` in a worktree with zero local packages
   ran `tsc` from up-tree and reported 907 errors, all of them the absent client.

## Line endings and the docs

`core.autocrlf=true` here, so files check out CRLF and commit LF (`text=auto`). New files
written with LF are fine. Check the diffstat per file before committing: a whole-file CRLF flip
or a stray NUL byte turns a one-line change into thousands of lines and makes git treat the
file as binary (`grep -n` then prints "Binary file … matches"; use `grep -a`).

## Committing beside other sessions

Inside a worktree the index is private, so the plain recipe applies: `git add -A`, verify
`git status` names no in-progress operation (a concurrent session's `git revert` or merge in
the SAME worktree would be hijacked by a plain `git commit`), then commit. One logical change
per commit. The pre-commit hook runs `check:docs` against the filesystem, so an untracked
source file left by someone else in this worktree fails it — that is the one case for
`--no-verify`, and say so in the hand-off.

If you ever must land a commit in the SHARED main checkout while another session is
force-pushing over it (do not — that is what worktrees are for), the recipes are:
`git worktree add --detach <scratch> origin/main` + `git cherry-pick <mine>` +
`git push origin HEAD:main`; always pass the OLD value to `git update-ref` so the CAS refuses
instead of clobbering; re-check `git log -1` before trusting that a ref move stuck; and
verify on the new base (`prisma generate`, `typecheck`, unit suite) before pushing.

## Reference

The `EnterWorktree` tool refuses complex compound shell commands that name `git` (it cannot
verify they stay inside the worktree). Run git as plain, separate commands from the worktree
root, and keep the Bash tool's persistent cwd there (`cd` back explicitly after any `cd` into a
subdirectory).
