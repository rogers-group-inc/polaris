# Polaris — Development Environment

How to run Polaris locally for development. Production deployment is the
split-role, nginx-fronted layout described in [docker-compose.yml](docker-compose.yml)
and [docs/INSTALL.md](docs/INSTALL.md) — none of that applies here. Dev is a
single process (`POLARIS_ROLE` unset = `all`), plain HTTP, no nginx, no
Prometheus.

There are two ways to run dev, both backed by the same Postgres container:

1. **Containerized app** — everything in podman/docker via `compose.dev.yml`
   (best on Windows, where native modules like argon2 and net-snmp are
   awkward to build against the host toolchain).
2. **Host-native app** — `npm run dev` on the host, pointed at the Postgres
   container.

---

## The dev compose stack (`compose.dev.yml`)

Two services under the compose project name `polaris` (containers become
`polaris-postgres-1` / `polaris-app-1`, volumes `polaris_pgdata` /
`polaris_node_modules`):

### `postgres`

- `timescale/timescaledb:latest-pg17` (PG 17.x on the same Alpine base the
  previous `postgres:17-alpine` used), data on the `pgdata` named volume
  (survives `compose down`; only `compose down -v` wipes it).
- **TimescaleDB is installed in dev on purpose**, so dev matches what every
  documented production install runs. Without it the 21 sample + rollup tables
  stay plain tables locally, and hypertable behavior — compression policies,
  `drop_chunks` pruning, and the `timescaledb_pre_restore()` /
  `timescaledb_post_restore()` gates in `backupService` — is only ever exercised
  in production. `shared_preload_libraries=timescaledb` is set as a server flag
  in the compose `command:`, NOT left to the image: the TimescaleDB entrypoint
  only writes it into `postgresql.conf` during initdb, which does not re-run on
  an already-initialized volume, so an existing dev database would otherwise come
  up with the extension installed but unloadable. `CREATE EXTENSION timescaledb`
  runs once per database; Polaris converts the sample tables to hypertables
  itself at boot (`timescaleService.convertToHypertables`, `migrate_data => TRUE`,
  so existing rows carry over).
- Credentials `polaris` / `polaris`, database `polaris` (dev-only values).
- Published on `127.0.0.1:5432` so host tools (psql, DBeaver, `npm run dev`,
  Prisma Studio) can reach it. Inside the compose network the app reaches it
  at host `postgres`.
- Healthcheck via `pg_isready`; the app service waits on it.

### `app`

- Built from [Dockerfile.dev](Dockerfile.dev): `node:24-trixie` plus
  native-module build deps (`python3`, `build-essential`), `postgresql-client-17`
  for ad-hoc psql inside the container, and `iputils-ping` (the monitoring
  code path spawns the system `ping` for ICMP probes). The production image
  in [Dockerfile](Dockerfile) is a separate multi-stage build — don't confuse
  the two.
- Source tree is **bind-mounted** at `/app`, so `tsx watch` (via
  `npm run dev`) hot-reloads on host edits. No rebuild needed for code
  changes — only rebuild the image when Dockerfile.dev itself changes.
- A named volume shadows `/app/node_modules` so the container's Linux-built
  native modules never mix with a Windows host `node_modules`. Consequence:
  after changing `package.json` deps, run `npm install` **inside the
  container** (the default `command:` self-heals this by running
  `npm install` when `node_modules/.bin/tsx` is missing).
- App published on `127.0.0.1:3000`.

### Bringing it up

```bash
podman compose -f compose.dev.yml up -d postgres
podman compose -f compose.dev.yml run --rm app npm install
podman compose -f compose.dev.yml run --rm app npx prisma migrate deploy
podman compose -f compose.dev.yml run --rm app npm run db:seed
podman compose -f compose.dev.yml up app
```

(`docker compose` works identically if you use docker instead of podman.)

### One stack per git worktree

A second stack can run beside the main one for a worktree under `.claude/worktrees/`:
pass `-p polaris-<slug>` (the compose project name isolates containers and volumes) and
move the published ports with `POLARIS_DEV_PG_PORT` / `POLARIS_DEV_APP_PORT` (defaults
5432 / 3000). Run the compose commands from the worktree root so the bind mount is that
branch. The full procedure — including the `DEVLOCK` marker and teardown with
`down -v` — is in the `polaris-worktree-workflow` skill
([.claude/skills/polaris-worktree-workflow/references/dev-environment.md](.claude/skills/polaris-worktree-workflow/references/dev-environment.md)).

### First-run setup wizard vs. DATABASE_URL

`DATABASE_URL` is deliberately **not** set in the app service's environment.
On a fresh stack the first-run setup wizard runs at http://localhost:3000 —
give it host `postgres`, port `5432`, user/password/db `polaris`. The wizard
writes `.env` and `.setup-complete` into the bind-mounted project root (both
gitignored), and subsequent boots pick them up.

To bypass the wizard, set `DATABASE_URL=postgresql://polaris:polaris@postgres:5432/polaris`
in `.env` (or uncomment the line in `compose.dev.yml`) before first boot.

**Do not set `POLARIS_STATE_DIR` in the dev container.** When set, the wizard
writes `.env` under the state dir but `npm run dev`'s `node --env-file=.env`
reads `/app/.env` — the two desync and boot fails with "DATABASE_URL is
missing but .setup-complete is present". Left unset, all state files
(`.env`, `.setup-complete`, `data/`, `public/uploads/`) land in the
bind-mounted project root, which is gitignored.

### Environment variables set by the dev compose file

| Variable | Dev value | Note |
|---|---|---|
| `NODE_ENV` | `development` | |
| `PORT` | `3000` | |
| `LOG_LEVEL` | `info` | |
| `SESSION_SECRET` | dev placeholder | Only enforced (boot-fail if missing) when `NODE_ENV=production` |
| `DATABASE_URL` | unset → wizard | See above; `postgres:5432` from inside the network, `localhost:5432` from the host |
| `POLARIS_ROLE` | unset (= `all`) | Single process runs web + monitor + discovery |
| `POLARIS_STATE_DIR` | unset | Intentional — see wizard note above |

Everything else (`POLARIS_PUBLIC_URL`, `POLARIS_PROXY_CERT_PATH`,
`HEALTH_TOKEN`, `METRICS_TOKEN`, pool/worker sizing, …) is unset in dev; the
nginx-related fail-fast checks only apply to production deployments. The full
variable catalog with per-variable commentary lives in
[.env.example](.env.example) and in the `polaris-deploy` skill
([.claude/skills/polaris-deploy/references/env-vars.md](.claude/skills/polaris-deploy/references/env-vars.md)).

---

## Host-native alternative

Run only Postgres in a container and the app on the host:

```bash
podman compose -f compose.dev.yml up -d postgres
cp .env.example .env      # DATABASE_URL already points at localhost:5432/polaris
npm install
npx prisma migrate dev
npm run db:seed
npm run dev               # tsx watch, hot reload
```

The default `DATABASE_URL` in `.env.example`
(`postgresql://polaris:polaris@localhost:5432/polaris`) matches the container's
published port and credentials exactly.

Caveat on Windows hosts: some native deps (argon2, net-snmp) need a working
build toolchain; if `npm install` fights you, use the containerized app path
instead.

Caveat on a corporate network that inspects TLS: `npm install` fails with
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY` because Node ships its own CA store and
ignores the OS one, so the internal root your machine already trusts is
rejected. Point Node at your system bundle for the shell you develop in —
`export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt` on Linux, or the
exported PEM on Windows. Same root cause, and the same fix, as the operator-side
runbook in `docs/INSTALL.md` → "Networks that inspect TLS". Do not reach for
`npm config set strict-ssl false`.

---

## Day-to-day commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload (`tsx watch`, reads `.env`) |
| `npm test` / `npm run test:watch` | Vitest (+ Supertest) |
| `npm run typecheck` / `npm run lint` | `tsc --noEmit` / eslint |
| `npm run db:migrate` | `prisma migrate dev` (create + apply migrations) |
| `npm run db:seed` | Seed example data |

`npm run db:seed` creates the admin account and some IP space but **no assets**, so
every device-filter preview reads "0 devices" and the monitored-vs-unmonitored split
has nothing to show. `prisma/seed-review-assets.ts` adds a handful of SYNTHETIC
devices for that — a mix of monitored and unmonitored, with manufacturers, OS
versions, departments, locations, `region:` tags, a sighting FortiGate, pinned
interfaces and storage mounts, i.e. one value per picker the automations and
address-book device filters offer. It is deliberately NOT wired into `db:seed`
(nobody wants invented devices in a database they are about to point at a real
fleet); run it by hand, and re-run it freely — it keys on hostname and updates
rather than duplicating:

```bash
node --env-file=.env --import tsx/esm prisma/seed-review-assets.ts
```

| `npm run db:reset` | Drop + re-migrate + re-seed |
| `npm run db:studio` | Prisma Studio DB browser |
| `npm run check:docs` | Doc-index structural check (also runs as a pre-commit hook) |
| `npm run test:fmg` | FortiManager connectivity smoke test |

To run any of these inside the containerized app:
`podman compose -f compose.dev.yml run --rm app <command>` (or `exec` against
the running `app` service).

### Running the full test suite

Use `--no-file-parallelism`; the default parallel mode fails spuriously on the
DB-touching suites.

The integration suites need two things the Windows host does not have: the
compose network name `postgres` (the host reaches the DB at `127.0.0.1:5432`
instead) and `pg_dump` / `psql` on `PATH`. They self-skip when either is absent,
so a host-side `npm test` reports ~31 files skipped and still passes. To run
**everything**, run it inside the app container, which has both:

```bash
podman exec polaris-app-1 sh -c \
  'cd /app && DATABASE_URL="postgresql://polaris:polaris@postgres:5432/polaris" \
   npx vitest run --no-file-parallelism'
```

That is the only way to exercise `tests/integration/backupRestore.test.ts`,
which additionally requires the timescaledb extension to cover the
`pre_restore` / `post_restore` gates. A green host-side run is NOT coverage of
that path — the suite logs which branch it took.

### Resetting the dev database

- Schema/data reset, keep the container: `npm run db:reset`
- Nuke everything including the volume:
  `podman compose -f compose.dev.yml down -v` — then also delete
  `.setup-complete` and `.env` from the project root if you want the setup
  wizard to run again (see "First-run setup lock" in
  [.claude/skills/polaris-deploy/references/deployment-updates.md](.claude/skills/polaris-deploy/references/deployment-updates.md)).
