# Merge protocol

Triggered by the user saying "merge" (in any chat, about any worktree). Merging never pushes.

## 1. Inventory the worktrees

From the main checkout (`C:\Users\dmoore\VSCode\polaris`):

```
git worktree list --porcelain
```

For every entry except the main checkout, collect: path, branch, whether `WORKLOCK` or
`DEVLOCK` exists at the path (and each lock's first line + file mtime), `git -C <path> status
--porcelain` (dirty?), `git rev-list --count main..<branch>` (commits ahead), and
`git -C <path> log -1 --format=%s`.

## 2. Present the menu

Print a **numbered** list of the worktrees with **no** lock file:

```
Ready to merge:
  1. worktree-fix-arp-tab        3 ahead   clean   "fix(arp): …"
  2. worktree-perf-engine-n2-join 1 ahead  dirty   "perf(engine): …"
Locked (skipped):
  - worktree-skills-conversion   WORKLOCK  2h old   "2026-09-06T06:10Z skills-conversion: …"
  - worktree-mobile-charts       DEVLOCK   3d old   "… dev stack polaris-mobile-charts pg=5433 app=3100"
```

A lock that is days old on a worktree whose chat has ended is stale; say so. The user decides
whether to clear it (`rm <path>/WORKLOCK`) and re-run the menu. Never delete a lock on your own.

A worktree with zero commits ahead and a clean tree has nothing to merge — list it, but mark it
"nothing to merge" so the user can choose to have it cleaned up at push time instead.

## 3. Merge the chosen ones, in the order given

For each selected worktree:

1. If dirty: commit the pending changes **in that worktree** (`git -C <path> add -A && git -C
   <path> commit -m "wip: pending changes at merge time"`), so nothing is lost and the merge
   is of a real commit.
2. From the main checkout, on `main`: `git merge --no-ff worktree-<slug>` (a merge commit per
   worktree keeps each unit of work identifiable in history; use the branch's own subjects in
   the merge message body).
3. On conflict: **stop**. Do not resolve silently. Report the conflicting files and ask; the
   common conflict is the same skill reference file edited by two branches, which is resolved
   by keeping both entries.
   **One conflict is foreseeable and is resolved before merging, not reported**: two open
   worktrees that each added a business rule both took "the next free number". The branch
   merging second renumbers its rule to main's current next-free number (`(N is the next free
   number.)` in `polaris-business-rules/SKILL.md`, plus every `rule N` citation in its code,
   tests and skill entries), and **the rule reference files are never renamed** — main keeps
   `invariants-30-43.md` / `narrative-36-43.md` whatever range they now hold, because other
   skills and code link to those paths. Do it in the worktree (re-enter it, WORKLOCK, `git merge
   main`, fix, commit), then merge to main. 2026-09-08: two branches both claimed rule 44.
4. Continue with the next selection only after the previous merge is clean.

## 4. Review what landed against the skills

A merge is the last moment a unit of work is visible as one diff. `/polaris-docs-sync` already
refreshed the entries each individual commit touched; this pass asks the wider question a
per-commit review cannot: **does what just landed change what a future session has to be told,
and is there an entry that tells it?**

For each worktree merged, read the whole branch as one diff — capture
`git merge-base main worktree-<slug>` *before* the merge, then after it
`git diff <base>..HEAD --stat` plus `git log <base>..HEAD --format=%s` — and walk this list:

- **A new invariant, or an incident the code now guards against** → a numbered business rule
  (`polaris-business-rules`: next free number + its narrative section), cited from the code.
- **A new subsystem, integration type, external system or workflow** → does it fit an existing
  skill, or does it warrant a new one (criteria below)?
- **Routing drift** — does each owning skill's `description:` still name the phrases someone
  would actually type to reach this material? A change that moves a topic between skills moves
  its trigger phrases too.
- **Stale prose the routing table never pointed at**: an entry that *describes* behaviour this
  diff contradicts, in a file no commit in the branch touched. These are the ones check-docs
  cannot see.
- **Reference files that grew** past ~1500 lines / ~100 KB → split by heading.
- **Traps found while doing the work** — anything that cost this chat time and would cost the
  next one the same (a tool that mangles a file, a test that flakes, a hook that fires
  unexpectedly) → the owning skill's notes, or a memory file if it is about this machine.
- **The always-loaded floor**: did the change alter one of the conventions in `CLAUDE.md`?

### Extend a skill, or create a new one

Create a **new** skill only when: the material is a coherent body worth ≥ ~2 reference files,
**and** no existing skill's `description:` would ever pull it into context, **or** the natural
owner's `SKILL.md` is already at its ~200-line ceiling / its description is being stretched to
cover two unrelated jobs. Otherwise **extend**: a new reference file under the owning skill plus
a row in its `SKILL.md` routing table (an orphaned reference file fails check-docs). A new skill
also needs its row in the `CLAUDE.md` skills table.

### What to do with the result

Report it as part of the merge summary — either "skills current" or a concrete list of entries
to add or change. Do **not** edit skills on `main`: skill edits are a change like any other, so
they go in their own worktree, follow the authoring constraints in `polaris-docs-sync`
(SKILL.md ≤ ~200 lines, `name:` = directory, `path/file.ts → symbol()` refs, prose moved
verbatim), pass `npm run check:docs`, and merge separately.

## 5. Verify main

After the last merge and the skill review: `npm run check:docs`, `npm run typecheck`, and the unit suite
(`npx vitest run tests/unit --no-file-parallelism`) on `main`. Report the results. Do not push;
the user says "push" separately, which runs `push-protocol.md`.

## The DEVLOCK variant (the chat's own worktree)

When the user has been working in a dev environment in THIS chat and says they are satisfied
and want to merge:

1. `podman compose -f compose.dev.yml -p polaris-<slug> down -v`
2. `rm DEVLOCK` (and `WORKLOCK` if still present)
3. commit anything pending in the worktree
4. merge it to main as in step 3 above, review as in step 4, verify as in step 5.

Then offer the numbered menu for any OTHER unlocked worktrees before finishing.
