# Worktree setup and safe committing

## Creating the worktree

`node .claude/skills/polaris-worktree-workflow/scripts/worktree-start.mjs <slug> "<purpose>"`
with a short slug (`skills-conversion`, `fix-arp-tab`). It runs `git worktree add -b
worktree-<slug> .claude/worktrees/<slug> main` — **local** `main`, so merges not yet pushed are
in the base — writes `WORKLOCK`, and generates the Prisma client; `--env` and `--install` add
the `.env` copy and `npm ci`. It refuses an existing path or branch. Then `cd` to the printed
path as its own Bash call.

**Why not `EnterWorktree`** (retired 2026-11-04, error-log review 2): on a session launched
from a lowercase `c:\` it created the worktree and then refused to enter it ("core.worktree
redirect", 8 entries in six days — the Agent tool's `isolation: "worktree"` fails the same
way); it put the session under a Bash guard that refused heredocs, variables, loops, `xargs`
and git in a compound (~30 entries); its git-level lock survived `ExitWorktree keep` and made
`git worktree remove` refuse (5); and it branched from `origin/main`. A plain `cd` into a
worktree gets none of that — the guard belongs to the tool, not to the directory (verified
2026-11-04). The price is that nothing stops a Bash command touching the main checkout; SKILL.md
→ "Start of a task" says what to keep out of it.

To lock a worktree by hand (a follow-up task in an already-committed one): the Write tool
(`require-worklock.mjs` exempts the lock file itself), or a lone Bash
`printf '%s %s\n' "$(date -u +%FT%TZ)" "<purpose>" > WORKLOCK`.

`WORKLOCK` and `DEVLOCK` are gitignored. Their presence is the only signal another chat has
that this worktree is in use, so write `WORKLOCK` immediately and delete it only when the
work is committed.

## Making the worktree usable

A fresh worktree has no `.env`, no `node_modules` and no `src/generated/prisma`.

`worktree-start.mjs` does steps 1–2 on request (`--env`, `--install`) and the client always.

1. `cp <main-checkout>/.env .env` — gitignored; needed for tests against a DB, not for
   `prisma generate` (since 2026-11-04 `prisma.config.ts` hands `generate` a placeholder URL
   when `DATABASE_URL` is unset, so `npm ci` no longer fails in postinstall without a `.env`).
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
   `npx prisma generate` (with `DATABASE_URL` set to anything well-formed) first. The same
   absence wears a THIRD face that reads like a broken import in your own test: a single unit
   file failing to collect with `Error: Cannot find module './generated/prisma/client.js'
   imported from src/db.ts`, pointed at by whatever that test imports transitively (a service
   → `src/db.ts`). A FOURTH face hides the cause entirely: `designSystemBuild.test.ts`
   spawns `.design-sync/build.mjs` (which imports `src/db.ts`) and asserts only its exit status,
   so it fails with a bare `expected 1 to be +0` — run `node .design-sync/build.mjs` to see the
   `ERR_MODULE_NOT_FOUND` (2026-10-27). When only the client is missing, `cp -r <main-checkout>/src/generated/prisma
   src/generated/` (~12 MB) is the quick way past it — a COPY, never a junction (step 3), and
   it costs nothing at removal time.
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

**Splitting ONE file's changes across two commits** (no `git add -p` here): never rewrite the
WORKING file to stage a subset and then restore it. On 2026-11-03 the working `users.ts` was
rewritten in the moment between the strip and the `git add` — something watching the file
(an editor buffer is the likeliest) merged two versions and every route came out duplicated.
Build the first commit's version of the file in the scratchpad, then put it straight into the
index: `git hash-object -w <scratch-file>` and
`git update-index --cacheinfo 100644,<sha>,<repo/path>` — each its own call. The working tree
keeps the full version and goes into the next commit with a plain `git add`. Read the staged
`git diff --cached --stat` per file before committing.

If you ever must land a commit in the SHARED main checkout while another session is
force-pushing over it (do not — that is what worktrees are for), the recipes are:
`git worktree add --detach <scratch> origin/main` + `git cherry-pick <mine>` +
`git push origin HEAD:main`; always pass the OLD value to `git update-ref` so the CAS refuses
instead of clobbering; re-check `git log -1` before trusting that a ref move stuck; and
verify on the new base (`prisma generate`, `typecheck`, unit suite) before pushing.

## Reference

The refused shapes and what to do instead are tabled in SKILL.md → "Shell inside a worktree";
this is the history. A worktree-isolated session's Bash guard refuses any command it cannot statically prove stays
inside the worktree — and that is **wider than "compound commands naming `git`"**, which is how
this was described until 2026-09-11. A plain `cat >> file <<'EOF' … EOF` heredoc, naming no git
and touching nothing outside the worktree, is refused on its own with *"too complex to verify
that it stays inside the worktree"*; so is that heredoc chained to anything else. Appending to a
file is therefore an `Edit` (anchor on the last existing block), not a shell append. Run git as
plain, separate commands from the worktree root, and keep the Bash tool's persistent cwd there
(`cd` back explicitly after any `cd` into a subdirectory).
