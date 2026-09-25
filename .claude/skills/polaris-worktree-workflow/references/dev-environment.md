# Per-worktree dev environment (podman)

Dev environments on this computer are **podman**, never docker: `podman compose -f compose.dev.yml …`.
The podman machine is frequently stopped; `podman ps` answering "Cannot connect to Podman …
connection refused" means start it, not that podman is missing.

Each worktree gets its **own compose project** so two stacks can run side by side: the project
name isolates containers and volumes (`polaris-<slug>-postgres-1`, `polaris-<slug>_pgdata`), and
two environment variables move the published ports off the main stack's `5432` / `3000`.

## Bring it up

From the worktree root (the stack bind-mounts the worktree, so hot reload edits this branch):

```
podman machine start                                  # idempotent
printf '%s %s\n' "$(date -u +%FT%TZ)" "dev stack polaris-<slug> pg=<pgport> app=<appport>" > DEVLOCK

# pick the lowest free pair starting at 5433 / 3100 (podman ps -a shows what is taken)
export POLARIS_DEV_PG_PORT=<pgport> POLARIS_DEV_APP_PORT=<appport>
podman compose -f compose.dev.yml -p polaris-<slug> up -d postgres
podman compose -f compose.dev.yml -p polaris-<slug> run --rm app npm install
```

Then either let the first-run wizard run (open `http://127.0.0.1:<appport>`, host `postgres`,
port `5432`, user/password/db `polaris` — it writes `.env` and `.setup-complete` into the
worktree, both gitignored), or bypass it by writing `.env` yourself before the app starts:

```
DATABASE_URL=postgresql://polaris:polaris@postgres:5432/polaris      # inside the compose network
PORT=3000                                                            # container-internal; the host sees <appport>
POLARIS_DASH_PORT=3001
SESSION_SECRET=dev-only
```

Note the host-side `DATABASE_URL` differs: from the host (running `npm run dev` natively or the
vitest suite) it is `postgresql://polaris:polaris@127.0.0.1:<pgport>/polaris`.

```
podman compose -f compose.dev.yml -p polaris-<slug> run --rm app npx prisma migrate deploy
podman compose -f compose.dev.yml -p polaris-<slug> run --rm app npm run db:seed
podman compose -f compose.dev.yml -p polaris-<slug> up -d app
```

`db:seed` creates `admin` / `admin` and some IP space but **no assets**; for device-filter
previews and monitored/unmonitored splits run `prisma/seed-review-assets.ts` by hand
(`node --env-file=.env --import tsx/esm prisma/seed-review-assets.ts`, re-runnable).

For a stack that looks like a working install rather than a fresh one — telemetry curves,
fired alerts, and a monitor status other than "Pending" on every asset — run the full
ordered chain (`mock:compare` → `mock:notifications` → `mock:demo`, the last one being the
presentation pass) under "Demo data and documentation screenshots" in `DEVELOPMENT.md`.
That section also covers `scripts/capture-screenshots.mjs`, which shoots the docs images
off such a stack, and "Mock switches and access points for the firmware repository" —
`scripts/seed-firmware-mock.ts` + `scripts/mock-firmware-devices.mjs`, both run INSIDE the
app container (`podman exec`), which put three Fortinet devices on loopback aliases, a
device-login credential and firmware images in place so an upgrade can be clicked through
end to end (business rule 87).

## Run the full test suite against it

```
podman exec polaris-<slug>-app-1 sh -c 'cd /app && DATABASE_URL="postgresql://polaris:polaris@postgres:5432/polaris" npx vitest run --no-file-parallelism'
```

The container has `pg_dump` / `psql` and the compose network name, which the Windows host does
not; only this path exercises the backup/restore and TimescaleDB-gated suites. `--no-file-parallelism`
is required either way.

**A green integration run may be a run that did nothing.** Every `tests/integration/*` file
guards on `dbReachable` (`_helpers.ts`) and SKIPS when it cannot reach the database — vitest
exits 0 and prints `Test Files 1 skipped (1)`, which scans as success. Writing integration
tests and never noticing they skipped is easy: read the **skipped** count, not the exit code.
A DB-less run skips ~76 files.

When only a few integration files matter and no full stack is up, a bare Postgres on a free
port is enough, and is quicker than the compose stack:

```
podman run -d --name polaris-<slug>-db -e POSTGRES_USER=polaris -e POSTGRES_PASSWORD=polaris \
  -e POSTGRES_DB=polaris -p <free-port>:5432 timescale/timescaledb:latest-pg17
HOSTIP=$(podman machine ssh "ip -4 addr show eth0" | awk '/inet /{print $2}' | cut -d/ -f1)
DATABASE_URL="postgresql://polaris:polaris@$HOSTIP:<free-port>/polaris" npx prisma migrate deploy
DATABASE_URL="postgresql://polaris:polaris@$HOSTIP:<free-port>/polaris" npx vitest run tests/integration/<file> --no-file-parallelism
```

**Publish on all interfaces and dial the podman machine's IP, not `127.0.0.1`.** On the WSL
backend `-p 127.0.0.1:<port>:5432` binds inside the VM, so the port answers there and is
unreachable from Windows — `prisma migrate deploy` fails `P1001: Can't reach database server`
against a container that `podman ps` shows healthy and listening, which reads as a broken
container rather than a binding that is doing exactly what it was told. The machine IP moves
when WSL restarts, so read it each time instead of pasting the last one.

Pick the port by looking at `podman ps` first — other sessions' stacks are usually up, and
they are not yours to stop. Write a `DEVLOCK` while it runs, and `podman rm -f` it when done.

`tests/integration/subnetSupersedeDeprecated.test.ts` times out on this hardware — all 6
cases, `Test timed out in 5000ms`, and they pass in CI. It is the container's latency, not a
regression: re-run that file alone with `--testTimeout=30000` before believing it. Confirmed
again 2026-09-18 on a full serial run.
And having watched a new test pass, make it FAIL once (comment out the guard it covers) before
trusting it — a route-level assertion that never saw red has proven nothing.

## Tear it down

```
podman compose -f compose.dev.yml -p polaris-<slug> down -v      # containers + volumes
rm DEVLOCK
```

`down -v` removes the named `pgdata` and `node_modules` volumes of THIS project only. The main
stack (project `polaris`) is untouched. Delete `DEVLOCK` only after the stack is gone; the merge
protocol refuses a worktree whose `DEVLOCK` is still present.

## Alternative: reuse a spare Postgres container

Older worktrees left containers behind (`podman ps -a`: `polaris-pwa-postgres` on :5434,
`polaris-scriptpub-postgres-1` on :5435 as of 2026-08). `podman start <container>`, then
`podman exec <container> psql -U polaris -d polaris -c "CREATE DATABASE polaris_<slug> OWNER polaris;"`,
point the worktree's `.env` at `localhost:<port>/polaris_<slug>`, `npx prisma migrate deploy`,
`npm run db:seed`. Cheaper than a full stack when only a database is needed; the role is
`polaris`, not `postgres`.

## Gotchas

- Do not set `POLARIS_STATE_DIR` in dev: the wizard writes `.env` under it while `npm run dev`
  reads `/app/.env`, and boot fails with "DATABASE_URL is missing but .setup-complete is present".
- The `polaris_csrf` cookie rotates on login; a curl cookie jar keeps the old line too — read the
  last one, and make one throwaway request after login before the first mutating call.
- `compose.dev.yml` sets `name: polaris`; the `-p` flag overrides it. Omit `-p` and you are
  operating the MAIN dev stack.
- **Anything you park in `.env` reaches every test.** `tests/setup.ts` dotenv-loads it so the
  suite picks up `DATABASE_URL` the way `npm run dev` does, so a var added there for a local
  experiment silently changes test behaviour. `TRUST_PROXY=1` in `.env` (needed when something
  terminates TLS in front of the dev server) breaks `tests/integration/dashServer.test.ts` — the
  case asserting a spoofed `X-Forwarded-For` loses to the socket IP *without* trust proxy — and it
  fails as a bare `socket hang up`, which reads like anything but a leftover env var. Pass such
  vars on the command line instead (`TRUST_PROXY=1 npm run dev`); a real env var survives
  `node --env-file=.env`.
- **Stopping `npm run dev` may not free the port.** Killing the npm wrapper leaves the node child
  listening, so the server you "restarted" never binds and you keep testing the old process with
  the old env. The tell is a config change that appears to have no effect. Check
  `netstat -ano | grep ':<port> .*LISTENING'` and kill that PID directly.
