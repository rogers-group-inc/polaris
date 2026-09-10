# Contributing to Polaris

This is the short, practical version of the working agreements. The
authoritative, always-loaded source is **[CLAUDE.md](CLAUDE.md)** — when this
file and CLAUDE.md disagree, CLAUDE.md wins. Deeper material lives in the ten
project skills under [.claude/skills/](.claude/skills/) (each `SKILL.md` routes to
its `references/`): the domain model, business rules, API + RBAC, the change-impact
(touches) index, the UI canon, monitoring + discovery, the agent, deployment, the
docs-sync review and the worktree workflow — and in the portable design system the
UI canon builds on, [design/POLARIS-UI-GUIDE.md](design/POLARIS-UI-GUIDE.md).

## Getting started

```bash
npm install                       # also runs prisma generate + wires the pre-commit hook
cp .env.example .env              # then fill in DATABASE_URL etc.
npx prisma migrate dev            # apply migrations to your dev DB
npm run dev                       # single-process dev runtime (POLARIS_ROLE unset = "all")
```

`npm install` will fail to `prisma generate` without `DATABASE_URL` set (it's
resolved at config-load time, no connection is made) — copy `.env` first.

## The checks every change must pass

```bash
npm run typecheck                 # tsc, zero errors
npx vitest run tests/unit         # unit suite
npm run check:docs                # structural doc-drift guard (also a pre-commit hook + CI job)
```

Integration tests need a Postgres (TimescaleDB recommended) and run **serially**
— they share one database and wipe tables in `beforeEach`:

```bash
DATABASE_URL=postgresql://... SESSION_SECRET=... \
  npx prisma migrate deploy
DATABASE_URL=postgresql://... SESSION_SECRET=... \
  npx vitest run tests/integration --no-file-parallelism
```

CI (`.github/workflows/docker-publish.yml`) runs typecheck + lint + unit
(`test` job) and the integration suite against a `postgres:17` service
container plus a matching `postgresql-client-17` (`integration` job). It is the
only workflow that runs the suites — `check-docs.yml` runs the structural doc
guards, and CodeQL runs separately.

Both jobs gate the image build, but note *how*: `build` declares
`needs: [test, integration]`, so a failing suite does not fail the build — the
build job is reported **skipped**, no image is published, and `main` carries on
looking green. So after a push, check that `build` actually ran, not just that
the suites passed.

On Windows, `tests/integration/backupRestore.test.ts` skips itself entirely:
its gate looks for `pg_dump` on `PATH`, which a Windows dev box normally has
no reason to carry. A green local integration run therefore does **not**
validate a backup or restore change — use the podman stack for that
(`DEVELOPMENT.md`), where the container has the client tools.

## Code conventions (the load-bearing ones)

- **All IP math lives in `src/utils/cidr.ts`.** Never do string manipulation on
  IPs anywhere else — import the helper.
- **Services hold the business logic; routes are thin** (validate input → call a
  service → return). New endpoints must go through a service, not raw Prisma.
  Several legacy route files still carry inline Prisma — extract opportunistically
  when you touch them, but any audit-worthy mutation must write its `Event`
  inline until then.
- **Errors thrown by services are `AppError`** (`src/utils/errors.ts`) with an
  `httpStatus`.
- **`async/await`, not `.then()` chains** — except the two intentional
  serialization queues (geocoder rate-limiter, SNMP gate), which are marked.
- **Every audit-worthy action writes an `Event`** via `logEvent`
  (`src/services/eventLogService.ts`).
- **Unit-test every public function in `src/utils/` and `src/services/`.**
- **Zod schemas live at the top of their route file.**
- **Scale-check every change at 100 and 2000 monitored assets** — no
  `for...of { await prisma.update() }` loops in jobs/reconcilers; batch with
  `$transaction([...])` / `updateMany` / `Promise.all`.
- **FortiManager ↔ standalone FortiGate parity** — a feature added to one
  integration usually applies to the other; ship both unless it's structurally
  FMG-only.
- Model new work after the canonical implementation — UI patterns in the
  `polaris-ui-canon` skill, backend patterns in `polaris-change-impact` →
  `references/patterns/` — rather than inventing a parallel pattern.

## Commits, docs, and pushing

- **Work in a worktree.** Every task runs in its own git worktree under
  `.claude/worktrees/<slug>` with a `WORKLOCK` file at its root (a `DEVLOCK` while a
  per-worktree podman dev stack is up); the end-of-work commit deletes the lock. Merging
  to `main` and pushing are separate, explicit steps — see the
  `polaris-worktree-workflow` skill — unless you finish with `/polaris-deploy`, which chains
  docs-sync, the deploy audit, the commit, the merge and the push.
- **One logical change per commit.** Don't batch unrelated work.
- **Before every commit, run the docs-sync review** (`/polaris-docs-sync`; `/polaris-deploy`
  runs it for you): re-read the
  skill reference entries your change touched and update anything it moved, broke, or
  invalidated — in the same commit. The pre-commit hook + `npm run check:docs` enforce
  the *structural* half (every model/service/job/route named, no `file:line` or
  `(line N)` refs, every service has a touches entry, every referenced path exists,
  every reference file linked and under size), but they can't judge prose accuracy —
  that's on you.
- **Version is automatic** — patch = git commit count (`src/utils/version.ts`).
  Never edit the patch in `package.json`; bump the minor only when cutting a
  named release.
- **Before pushing**, re-read `README.md`, `docs/INSTALL.md`, the `deploy/`
  scripts, and the Dockerfile for anything the change invalidated.

## Deployment shape (so changes land safely)

Production is split-role + nginx-fronted (`polaris.target` + `polaris-web` +
`polaris-monitor@N` + `polaris-discovery`); the legacy single-process service is
gone. Updates land via the in-app updater (Server Settings → Maintenance), which
also syncs shipped systemd units and the nginx config. See
[docs/INSTALL.md](docs/INSTALL.md). Operational incident playbooks live in the
`polaris-monitoring-discovery` skill under
[.claude/skills/polaris-monitoring-discovery/references/runbooks/](.claude/skills/polaris-monitoring-discovery/references/runbooks/).

## Security expectations

Route inference through Azure AI Foundry, not personal API keys; secrets live in
Key Vault / environment variables — never hardcode them. Anything customer-,
vendor-, or regulator-facing, plus deployed code and compliance/financial
language, needs human review before use.
