---
name: polaris-deploy
description: "Polaris deployment, runtime configuration and operations: the environment-variable catalogue, split-role systemd layout (polaris.target, web/monitor@N/discovery/dash/migrate), the in-app updater and update trains, nginx front-end + managed config + cert rotation, Docker/compose, first-run setup lock, disk-space monitoring, backup/restore, install and update scripts, docs/INSTALL.md. Run /polaris-deploy before pushing, when adding or changing an env var, or when a change touches deploy/, Dockerfile, nginx, systemd units or the updater."
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
| the operator install guide (RHEL/Rocky/Alma 9, Ubuntu/Debian, Windows Server) and the disk-sizing source of truth | `docs/INSTALL.md` |
| the local dev stack (podman/docker compose, host-native, DB reset) | `DEVELOPMENT.md` |
| the shipped units, nginx template, sudo wrapper, update scripts | `deploy/` |
| the production image and the multi-container stack | `Dockerfile`, `docker-compose.yml` (state under `./state`) |

## Before any push — audit the deployment surfaces

When the user says "push", before running the push protocol in `/polaris-worktree-workflow`:

1. Re-read `README.md`, `docs/INSTALL.md`, the install/update scripts under `deploy/` and
   `scripts/`, and the Dockerfile / compose files for anything the change invalidated
   (a new env var, a new runtime dependency, a changed port, a new unit, a new nginx
   location). Stage the fixes as their own commit before pushing.
2. If a `polaris_*` metric changed, the Grafana dashboard JSON changed with it.
3. If a dependency or Go pin moved, `Dockerfile`, every `deploy/setup-*.{sh,ps1}`,
   `docs/INSTALL.md` and `agent/go.mod` moved in lockstep. Run `npm run check:versions` to
   prove it — the full site list per family is `polaris-tech-lifecycle` →
   version-pin-inventory.md, and it is longer than this rule implies.

## Adding an environment variable

Add it to `.env.example` with a comment → `references/env-vars.md` → `docs/INSTALL.md` if
operator-set → a default in `deploy/setup-*.{sh,ps1}` if the install scripts write `.env`
→ the Capacity Advisor if it sizes a pool. See `cross-cutting-deployment.md`.

## Facts that bite

- `POLARIS_PROXY_CERT_PATH` and `POLARIS_PUBLIC_URL` are required in production; boot fails fast without them. `TRUST_PROXY` defaults to `"1"` behind nginx.
- `SESSION_SECRET` is required in production. `POLARIS_SECRET_KEY` unset = secrets stored in plaintext (a watch-severity reason); set it and restart to seal, and keep a copy off-host.
- The version patch is the git commit count (`src/utils/version.ts`, `POLARIS_BUILD_COMMIT_COUNT` in Docker); never edit the patch in `package.json`.
- Operator unit customization lives in `<unit>.d/*.conf` drop-ins — direct edits to the synced unit files or `/etc/nginx/conf.d/polaris.conf` are clobbered on the next update.
- The wizard is unauthenticated; `.setup-complete` stops it from re-running on a host whose `.env` vanished.
- Disk severity tiers: watch 20–30 % free, amber 10–20 %, red < 10 % (sidebar banner).

Related: `polaris-agent` (cert-pin rotation rides a cert swap), `polaris-monitoring-discovery` →
`process-roles-runtime.md` and `observability.md`, `polaris-business-rules` rule 20c (backup you cannot restore),
`polaris-tech-lifecycle` (which version to move to, when it goes end-of-life, and every site that declares it).
