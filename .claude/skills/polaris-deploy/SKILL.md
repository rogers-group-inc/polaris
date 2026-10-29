---
name: polaris-deploy
description: "Polaris deployment, runtime configuration and operations: the environment-variable catalogue, split-role systemd layout (polaris.target, web/monitor@N/discovery/dash/migrate), the in-app updater and update trains, nginx front-end + managed config + cert rotation, Docker/compose, first-run setup lock, disk-space monitoring, backup/restore, install and update scripts, docs/INSTALL.md. /polaris-deploy is also the release pipeline for a finished worktree: it runs the docs-sync review itself, audits the deployment surfaces, makes the end-of-work commit, merges THIS worktree's branch to main and pushes — no other worktree is listed or merged — and invoking it is the go-ahead for that merge and push. It ends by publishing docs/wiki/ to the GitHub wiki (npm run wiki:publish -- --apply --push) only when the live wiki differs from origin/main's docs/wiki/, then re-publishes the Polaris UI / Polaris Mobile design-system artifacts when the push changed the app CSS, design/ or the alert email template, and commits + pushes whatever the docs-sync routing put in the polaris-toolbox and fortinet-api-conventions plugin repos — invoking it is the go-ahead for both publishes and those pushes too. Run it when a task is done, when adding or changing an env var, or when a change touches deploy/, Dockerfile, nginx, systemd units or the updater."
disable-model-invocation: true
---

# Polaris deployment and operations

Production is **split-role + nginx-fronted** on every install: `polaris.target` groups
`polaris-migrate` (oneshot, sole migrator) → `polaris-web` → `polaris-monitor@N` →
`polaris-discovery` → `polaris-dash`. The legacy single-process `polaris.service` is gone;
local dev (`npm run dev`, `POLARIS_ROLE` unset = `all`) is the only all-in-one runtime.
**Production is updated through the in-app updater** (Server Settings → Maintenance), which
also syncs the shipped systemd units and the nginx config — never advise `git pull` or a
manual restart unless asked.

## Which file

| You need… | Read |
|---|---|
| every environment variable, its default and what it tunes | [references/env-vars.md](references/env-vars.md) (mirror of `.env.example`, which a running install reads — keep both in step) |
| the updater, update trains, unit/nginx sync on restart, the nginx front-end and in-app GUI, `migrate-to-nginx.sh`, disk-space monitoring, the first-run setup lock | [references/deployment-updates.md](references/deployment-updates.md) |
| systemd deployment of the roles, per-role `/metrics` listeners, nginx-front HTTPS, the in-app nginx GUI | [references/multi-process-deployment.md](references/multi-process-deployment.md) |
| the deployment lockstep checklist — Dockerfile, `deploy/setup-*`, `deploy/update-*`, `docs/INSTALL.md`, `copy-build-assets.mjs`, Go pin, disk-sizing table | [references/cross-cutting-deployment.md](references/cross-cutting-deployment.md) |
| active/standby HA — Patroni + etcd, the role reconciler, the systemd drop-ins, `/health/ready`, the file state PostgreSQL does not replicate, the update window | [references/high-availability.md](references/high-availability.md) (operator-facing walkthrough: `docs/HA.md`) |
| the operator install guide (RHEL/Rocky/Alma 9, Ubuntu/Debian, container) and the disk-sizing source of truth | `docs/INSTALL.md` — **fresh installs only** |
| the operator runbook for a host that already exists — a runtime major, PostgreSQL 15 → 17, AppStream → PGDG, legacy single-process → split-role, pre-nginx → nginx, an update that died mid-flight | `docs/UPGRADING.md` |
| the local dev stack (podman/docker compose, host-native, DB reset) | `DEVELOPMENT.md` |
| the shipped units, nginx template, sudo wrapper, update scripts | `deploy/` |
| the production image and the multi-container stack | `Dockerfile`, `docker-compose.yml` (state under `./state`) |
| the merge, push and clean-up steps this pipeline ends with (it skips the merge menu) | `polaris-worktree-workflow` → merge-protocol.md, push-protocol.md |

## The release pipeline — what `/polaris-deploy` does, in order

Invoking this skill on a finished worktree is the user's go-ahead for everything below,
**including the merge, the push, the plugin-repo pushes and — when the live wiki or a design
system is out of date — the wiki and design-system publishes**.
Do not ask for the docs-sync review, the merge, any push or either publish separately; the
only things that stop the pipeline are a failing check, a merge conflict, or `main` behind
`origin/main`.

0. **Restore `WORKLOCK` if the worktree has none.** The usual way to reach this pipeline is a
   task already finished the CLAUDE.md way — `WORKLOCK` deleted, work committed — and the
   PreToolUse hook then refuses step 1's and step 2's edits inside the worktree. Write the lock
   back (`printf '%s %s\n' "$(date -u +%FT%TZ)" "deploy pipeline" > WORKLOCK`) before editing,
   and delete it again at step 4. Its absence here means the work is committed, not that a new
   worktree is needed — which is what the hook's own message will otherwise tell you.
1. **Docs-sync review — run it, never ask the user to.** Read
   `.claude/skills/polaris-docs-sync/SKILL.md` and follow its procedure over the whole branch
   (`git diff main...HEAD`). The Skill tool refuses that skill by design
   (`disable-model-invocation`); reading the file and following it is how this pipeline runs
   it. While the branch is still one diff, also walk the merge-time skill review in
   `polaris-worktree-workflow` → merge-protocol.md § 4 (new invariant → numbered rule, new
   subsystem → entry or skill, routing drift, stale prose, traps) and make those edits here
   in the worktree — after the merge they would need a worktree of their own.
2. **Deployment-surface audit** — the three checks in the next section. Fixes are commits in
   the worktree, before the merge, so `main` never receives a direct commit.
3. **Verify.** First, if `src/generated/prisma` does not exist in the worktree, run
   `DATABASE_URL=postgresql://x:x@localhost:5432/x npx prisma generate` — a worktree that never
   ran `npm install` has no client, and the checks below then fail 270+ files with errors that
   read like the branch broke them (seven sessions lost a full suite run to this by 2026-10-29).
   Then `npm run check:docs && npm run typecheck && npx vitest run tests/unit
   --no-file-parallelism`, plus `npm run check:versions` when a pin moved and
   `npm run check:wiki` when `docs/wiki/` changed. A failure stops
   the pipeline; report the output.
   **The unit suite is not the gate.** `docker-publish.yml` runs `tests/unit` in its `test`
   job and `npx vitest run tests/integration --no-file-parallelism` in a SEPARATE `integration`
   job, and `build` is `needs: [test, integration]` — so one red integration case publishes no
   image, silently, for every merge that follows. Run the integration suite too whenever the
   branch touched a route, a service or a contract a test could pin; it needs a real database
   (`polaris-worktree-workflow` → dev-environment.md, then `DATABASE_URL=… npx prisma migrate
   deploy`), and without one every case SKIPS and the green is worthless. If no database can be
   had, say so in the step 10 report rather than calling the branch verified.
4. **End-of-work commit**: `rm WORKLOCK`, commit everything pending (one logical change per
   commit). A `DEVLOCK` means a dev stack is up: `podman compose -f compose.dev.yml -p
   polaris-<slug> down -v`, delete the lock, then commit.
5. **Merge this chat's worktree — and only it.** From the main checkout — a worktree-isolated
   session must `ExitWorktree` (keep) first; its Bash guard refuses git aimed at the main
   checkout. **Before merging**, `git fetch origin` and check `git log origin/main..main`: it must
   be empty. Commits there were merged by someone else and would ride along on this push — stop,
   list them, and let the user decide (push them too, or push nothing). Then
   `git merge --no-ff worktree-<slug>`. **No inventory, no numbered menu**: other worktrees are
   never listed, offered or merged by this pipeline, locked or not — that is what a bare
   "merge" is for. Conflict → stop and report. Then `npm run check:docs` + `npm run typecheck`
   on `main`.
6. **Push** per push-protocol.md § 1–2: `git push origin main` (stop and report if `main` is
   behind `origin/main`). Clean-up (§ 3) covers **this worktree and its branch only** — not
   other `worktree-*` branches that happen to be fully merged.
7. **Publish the wiki — do not ask.** Run `npm run wiki:publish` from the main checkout (plan
   only: it fetches, diffs `origin/main`'s `docs/wiki/` against the live wiki and changes
   nothing). **Publish only when it needs updating:** if the plan says "the wiki is current",
   there is nothing to publish — say so in the report and move on; never run `--apply` against a
   current wiki. When the plan lists pages to add, update or delete, run
   `npm run wiki:publish -- --apply --push` straight away — the user decided (2026-10-21) that
   invoking `/polaris-deploy` approves that write to the separate, public `<repo>.wiki.git`
   along with the merge and the push. Carry the plan's page list, **DELETE** lines included,
   into the report. If the harness or the auto-mode
   classifier still refuses the push, that refusal is the only reason to ask: show the plan and
   ask "Publish N wiki pages? (y/n)". The script's header lists what it guards against: `master`
   not `main`, CRLF, mirrored deletes, README skipped, `check:wiki` over the ref. Never hand-copy
   pages instead.
8. **Publish the design systems — do not ask.** When the pushed range touched anything in
   `.design-sync/NOTES.md`'s trigger table (`public/css/styles.css` or `mobile.css`,
   `design/**`, the alert email template, `.design-sync/**`), run `node .design-sync/build.mjs`
   from the main checkout and publish the affected system(s) — Polaris UI and/or Polaris
   Mobile — by NOTES.md's procedure, index last with `"via": "Polaris repo @<sha>"`. The user
   decided (2026-10-26) that design changes sync to the artifacts automatically, so invoking
   `/polaris-deploy` approves this publish too. Nothing in the trigger table moved → nothing to
   publish; say so. A build failure here means the merged UI broke a design page: report it,
   do not publish a partial system.
9. **Commit and push the plugin repos — do not ask.** When step 1's docs-sync routing sent an
   edit to `../polaris-toolbox` or `../fortinet-api-conventions`, that edit is committed and
   pushed here, after the Polaris push — the user decided (2026-10-29) that invoking
   `/polaris-deploy` approves those pushes too. A worktree-isolated session cannot commit to a
   sibling repo, so this runs after step 5's `ExitWorktree`. Per repo: `git -C <repo> status
   --short`, commit what the routing put there (bump `plugin.json` first), then check
   `git -C <repo> log --oneline origin/main..main` and push with `git -C <repo> push origin main`
   **as a call of its own** — chained after anything else, the auto-mode classifier has refused
   it as "Create Public Surface" (twice on 2026-10-28). If it is refused anyway, name the
   repo and its unpushed commits and ask "Push <repo>? (y/n)". Nothing unpushed → say so.
10. **Report**: the pushed range, the worktree and branch removed, skill entries changed, the
   wiki publish (its `polaris@<sha>` marker, or pending / current), the design-system publish
   (which system, which version, or nothing to publish), each plugin repo pushed (its range, or
   nothing to push), and anything skipped with the reason.

## The deployment-surface audit (pipeline step 2; also what a bare "push" runs)

1. Re-read `README.md`, `docs/INSTALL.md`, the install/update scripts under `deploy/` and
   `scripts/`, and the Dockerfile / compose files for anything the change invalidated
   (a new env var, a new runtime dependency, a changed port, a new unit, a new nginx
   location). Stage the fixes as their own commit.
2. If a `polaris_*` metric changed, the Grafana dashboard JSON changed with it.
3. If a dependency or Go pin moved, `Dockerfile`, every `deploy/setup-*.sh`,
   `docs/INSTALL.md` and `agent/go.mod` moved in lockstep. Run `npm run check:versions` to
   prove it — the full site list per family is `polaris-tech-lifecycle` →
   version-pin-inventory.md, and it is longer than this rule implies.

## Adding an environment variable

Add it to `.env.example` with a comment → `references/env-vars.md` → `docs/INSTALL.md` if
operator-set → a default in `deploy/setup-*.sh` if the install scripts write `.env`
→ the Capacity Advisor if it sizes a pool. See `cross-cutting-deployment.md`.

## Facts that bite

- `POLARIS_PROXY_CERT_PATH` and `POLARIS_PUBLIC_URL` are required in production; boot fails fast without them. `TRUST_PROXY` defaults to `"1"` behind nginx.
- `SESSION_SECRET` is required in production. `POLARIS_SECRET_KEY` unset = secrets stored in plaintext (a watch-severity reason); set it and restart to seal, and keep a copy off-host.
- The version patch is the git commit count (`src/utils/version.ts`, `POLARIS_BUILD_COMMIT_COUNT` in Docker); never edit the patch in `package.json`.
- Operator unit customization lives in `<unit>.d/*.conf` drop-ins — direct edits to the synced unit files or `/etc/nginx/conf.d/polaris.conf` are clobbered on the next update.
- The wizard is unauthenticated; `.setup-complete` stops it from re-running on a host whose `.env` vanished.
- Disk severity tiers: watch 20–30 % free, amber 10–20 %, red < 10 % (sidebar banner).
- A command an operator is told to run under `sudo` names its full path (`sudo /usr/local/sbin/polaris-update-sync --apply-helpers`). RHEL's sudo `secure_path` leaves out `/usr/local/sbin`, so the bare name is "command not found" there, even on a fresh install. `tests/unit/rootHelperHintsFullPath.test.ts` fails on any `sudo polaris-…` in `deploy/`, `docs/`, `src/`, `public/`.

Related: `polaris-agent` (cert-pin rotation rides a cert swap), `polaris-monitoring-discovery` →
`process-roles-runtime.md` and `observability.md`, `polaris-business-rules` rule 20c (backup you cannot restore),
`polaris-tech-lifecycle` (which version to move to, when it goes end-of-life, and every site that declares it).
