## Project Overview

**Polaris** is an IP management tool that allows users to reserve and manage IP address space (IPv4 and IPv6) for use across other infrastructure projects. Named after the North Star — a fixed reference point operators can navigate by when wiring up everything else. It provides a central registry for subnets, individual IPs, and reservations — preventing conflicts and giving teams visibility into IP utilization.

> **Naming:** the project was previously called Shelob and has been fully rebranded — every on-host identifier (install path, system user, Postgres DB/user, systemd unit, NSSM service name, firewall rule label), browser-side identifier (CSRF cookie, localStorage keys), and source-level constant (argon2 timing dummy, encrypted-backup magic) now uses `polaris` / `Polaris` / `POLARIS`. Encrypted backups are versioned by the 8-byte magic header `POLARIS\0`; the previous `SHELOB1\0` format is no longer recognized. Existing installs migrate via dump-and-reinstall (plain `pg_dump` carries cleanly into a polaris-named DB).

Version policy: `<major>.<minor>` lives in `package.json` and is the single source of truth — pre-release line is the 0.x series, bump the minor (e.g. `0.9.0` → `0.10.0`) when cutting a named release. The patch is the git commit count, computed at runtime by `src/utils/version.ts`: it reads `POLARIS_BUILD_COMMIT_COUNT` (baked into the Docker image at build time) when set, otherwise falls back to `git rev-list --count HEAD` for RHEL prod / dev where the .git tree is present. Never edit the patch in package.json — it stays `<major>.<minor>.0` there. Version is shown in the sidebar and embedded in backup filenames.

---

## Skills — where the project memory lives

This file is the always-loaded floor. Everything deeper lives in twelve project skills under
`.claude/skills/` and loads on demand — each `SKILL.md` routes to its `references/` with
"read X when Y" tables. **Load the skill before you design, not at commit time**: the
invariants and "when changing this" checklists are what make a change land right the first time.

| Skill | Load when | Invocation |
|---|---|---|
| `polaris-domain-model` | a task names a model, column, enum, `sourceType`, `monitorStatus`; edits `prisma/schema.prisma`; writes a migration | auto |
| `polaris-business-rules` | **before changing any behavior** around subnets, reservations, leases, discovery writes, `lastSeen`, monitor status, dependency suppression, maintenance, alerts/automations, packet loss, secrets, backups, SSH, login gating, RBAC levels — or when anything cites "rule N" | auto (model only) |
| `polaris-api-rbac` | adding/changing an endpoint or gate, a permission key, a 401/403, tokens, login/SSO, anything in `src/api/` | auto |
| `polaris-change-impact` | **before editing anything** in `src/services`, `src/jobs`, `src/utils` or a route; adding a service/job/integration/metric; "where does X live" / "what depends on X" | auto |
| `polaris-ui-canon` | any change under `public/`; HTML/CSS/JS/theme/widget/chart/mobile/Dash work | auto |
| `polaris-monitoring-discovery` | probes, cadence, collectors, MIBs, discovery phases, integrations, background jobs, metrics, runbooks | auto |
| `polaris-agent` | anything under `agent/`, agent install/build/upgrade, cert pins, `ManagedAgent`, sample streams | auto |
| `polaris-tech-lifecycle` | EOL dates, a version pin or minimum version, bumping Node / Postgres / Go / a dependency major, `npm audit`, Dependabot | auto |
| `polaris-worktree-workflow` | the start of every coding task; "worktree", "lock", "dev environment", "merge", "push" | auto + `/polaris-worktree-workflow` |
| `polaris-deploy` | a task is done: it runs docs-sync, audits deploy surfaces, commits, merges and pushes; env vars, systemd/nginx/Docker, the updater | `/polaris-deploy` only |
| `polaris-docs-sync` | a commit made outside `/polaris-deploy`; after `check:docs` fails | `/polaris-docs-sync` only |
| `polaris-design-sync` | publishing the UI kit to the Claude Design project; after the external kit is lifted into `design/` | `/polaris-design-sync` only |

In-place references the skills point at: `.env.example` (runtime variables, with comments),
`docs/INSTALL.md` (install + disk sizing), `DEVELOPMENT.md` (local dev stack),
`design/POLARIS-UI-GUIDE.md` (the portable UI contract — a drop-in zone, never edited here),
`agent/README.md`, `CONTRIBUTING.md`.

External plugins (separate repos; clone, then `claude --plugin-dir <clone>`):
`fortinet-api-conventions` — https://github.com/davidmoore-rogers/fortinet-api-conventions (FortiManager / FortiOS / FortiSwitch / FortiAP API traps) and
`polaris-api-conventions` — https://github.com/rogers-group-inc/polaris-api-conventions (the client guide to this app's `/api/v1`, generated from `public/api.html`; regenerate it there when that page changes).
Both are fed from this repo's commits, not edited on their own schedule: the `/polaris-docs-sync` routing table has a row for each saying when a change here must be recorded there.

---

## Session workflow (always in force)

1. **Never edit the main checkout.** Before the first edit of a task, create a worktree
   (`EnterWorktree` → `.claude/worktrees/<slug>`, branch `worktree-<slug>`) and write a
   `WORKLOCK` file at its root (one line: ISO timestamp + purpose). A PreToolUse hook refuses
   Edit/Write inside the repo without one.
2. **Finishing a task = delete `WORKLOCK`, then commit everything in the worktree.** Run
   `/polaris-docs-sync` first — or `/polaris-deploy`, which runs it and carries on through
   merge and push. The end-of-work commit does not wait for approval; merges and pushes do,
   and `/polaris-deploy` is that approval.
3. **A dev environment = a `DEVLOCK` file at the worktree root + one podman stack per worktree**
   (`podman compose -f compose.dev.yml -p polaris-<slug>`; podman, never docker).
4. **"merge"** → list every worktree WITHOUT a lock file as a numbered menu, merge the chosen
   ones to `main` with `--no-ff`, never push; then review what landed against the skills
   (update an entry, or add a skill, when the work changed what a future session needs told). **"push"** → audit deploy surfaces, push `main`,
   then remove the merged worktrees and branches. Both protocols are in `/polaris-worktree-workflow`.
5. `WORKLOCK` / `DEVLOCK` are gitignored and never committed.

---

## Architecture

Code lives in `src/` (`api/routes/`, `api/middleware/`, `services/`, `jobs/`, `utils/`, `models/`, `setup/`). Frontend is vanilla JavaScript in `public/`. Database schema in `prisma/schema.prisma`. Migrations in `prisma/migrations/`. Fresh-install + update scripts and systemd units in `deploy/`; maintenance utilities (audit, MIB fetcher, doc-check, FMG smoke tests) in `scripts/`. Operator-facing docs in `docs/`.

> The file-by-file map is `polaris-change-impact` → references/file-map/; writer/reader relationships are its cross-cutting and per-service entries; canonical UI implementations are in `polaris-ui-canon`. Process roles (`web` / `monitor` / `discovery` / `dash` / `all`) are gated by `src/utils/role.ts` — see `polaris-monitoring-discovery` → process-roles-runtime.md.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 24 LTS / TypeScript (ESM) — floor is 22.12 (`pg-boss` requires it); Node 20 is EOL |
| Framework | Express 5 |
| ORM | Prisma 7 (driver-adapter via `@prisma/adapter-pg`; generated client at `src/generated/prisma/`, regenerated by `postinstall`) |
| Database | PostgreSQL 17 |
| Sessions | express-session + connect-pg-simple (PostgreSQL store) |
| Validation | Zod |
| Logging | Pino + pino-pretty |
| Auth | argon2id via @node-rs/argon2, @node-saml/node-saml (Azure SAML SSO), otpauth + qrcode (optional TOTP second factor for local accounts) |
| IP Math | netmask |
| Security | helmet, express-rate-limit |
| File uploads | multer |
| PDF export | jspdf + jspdf-autotable |
| DOM screenshots | html-to-image (bundled under `public/js/vendor/`) — capture rules in `polaris-ui-canon` → tech-stack-frontend.md |
| Mapping | Leaflet + leaflet.markercluster + leaflet-draw 1.0.4 (region polygon edit mode) + OpenStreetMap tiles (bundled under `public/css/vendor/leaflet/` and `public/js/vendor/leaflet/`) |
| Graph layout | Cytoscape.js column solver (`computeTopologyColumns` in `topology-render.js`), dagre fallback — the solver, location-code hulls and building/floor views are in `polaris-ui-canon` → tech-stack-frontend.md |
| Asset monitoring | net-snmp, ssh2, `node:https`/`node:http` (FortiOS REST, WinRM, HTTP check), system `ping` / fping (batched ICMP + loss sweep) — per-transport rules in `polaris-monitoring-discovery` → polling-methods-streams.md |
| Testing | Vitest + Supertest |
| Frontend | Vanilla JavaScript + HTML (served from /public) |

> Each version above is one of many declaration sites (a Node major lives in 23). Never bump one
> alone — `polaris-tech-lifecycle` owns the lockstep list, EOL dates and `check:versions`.

---

## Getting Started

```bash
# Install dependencies
npm install

# Setup database
npx prisma migrate dev --name init

# Seed example data
npm run db:seed

# Start dev server (with hot reload)
npm run dev

# Run tests
npm test

# Build for production
npm run build && npm start

# Test FortiManager connectivity
npm run test:fmg

# Type check / lint / structural guards (the checks also run in CI + pre-commit)
npm run typecheck
npm run lint
npm run check:docs && npm run check:versions && npm run check:deps
```

---

## Key Coding Conventions

- All IP math lives in `src/utils/cidr.ts`. **Never** do string manipulation on IPs elsewhere.
- **Resolving a FortiSwitch/FortiAP's parent goes through `src/utils/fortinetParentKey.ts`. Never match `fortinetTopology.controllerFortigate` against `Asset.hostname`** — that field holds FortiManager's *device name*, and "no parent" is a legitimate state, so the mismatch fails silently across dependency suppression, Device Map membership, region tags and FortiLink auto-monitor. The full reasoning and the second class of consumer that must keep using the device name are in `polaris-change-impact` → cross-cutting/fortinet-parent-key-resolution.md.
- Services (`src/services/`) contain **all business logic**. Route handlers are thin — validate input, call a service, return a response.
- All Zod schemas live co-located with their route file (top of file).
- Database calls go through service functions only — never raw Prisma in route handlers. **Interim state (2026-06):** several legacy route files still carry inline Prisma (heaviest in `agents.ts`, `assets.ts`, `integrations.ts`, `serverSettings.ts`, `users.ts`). New endpoints MUST use services; when you touch a legacy route, extract opportunistically. Until a handler is extracted, any audit-worthy mutation it makes must still write an `Event` inline (these files already import `logEvent`) — auditability is the part that can't wait for the refactor.
- All errors thrown by services must be instances of `AppError` (`src/utils/errors.ts`) with an `httpStatus` property.
- Use `async/await` throughout; avoid `.then()` chains.
- Write a unit test for every public function in `src/utils/` and `src/services/`. `vitest.config.ts` excludes `**/.claude/**`: those are full scratch checkouts of this repo (one per in-flight branch) and Vitest's default include would otherwise collect every worktree's tests into `npm test` — silently inflating the suite ~3× and failing loudly once a worktree diverges enough to reach a real DB. If the file count jumps between runs, suspect that first.
- All audit-worthy actions (creates, updates, deletes, discovery events) must write an `Event` record.
- **Commits.** Each logical change gets its own commit; don't batch unrelated work. Inside a worktree the end-of-work commit (after deleting `WORKLOCK`) happens without asking — see Session workflow. Merging to `main` and pushing happen only when the user says so.
- **Run `/polaris-docs-sync` before the end-of-work commit.** It names the skill reference entries each kind of change must refresh (models, services, jobs, routes, rules, UI canonicals, env vars, metrics) and runs `npm run check:docs`, which enforces the structural half (every model / service / job / route named, no `file:line` refs, every service has a touches entry, every referenced path exists). Anything the change moved, broke or invalidated gets refreshed in the same commit — the indexes only stay trustworthy if they are reviewed every commit.
- **Never push without the user's explicit go-ahead.** "push" and `/polaris-deploy` are that go-ahead; both run the deployment-surface audit (README, `docs/INSTALL.md`, `deploy/` scripts, Dockerfile / compose), then the push protocol in `/polaris-worktree-workflow`.
- **Production is updated through the in-app updater** (Server Settings → Maintenance), which also syncs the shipped systemd units and nginx config. Do not suggest `git pull` or manual restart steps unless asked.
- **Version is automatic** — never edit the patch in `package.json`. See the version policy above.
- **FortiManager ↔ standalone FortiGate parity.** Treat the FortiManager and standalone FortiGate integrations as paired surfaces. Whenever you add or change a FortiManager-side feature — new tab, config field, toggle, push pathway, monitoring stream, filter, etc. — evaluate whether the same change applies to the standalone FortiGate path and, if so, ship both in the same change. The two integrations talk to the same FortiOS device fleet via different transports (FMG proxy/direct vs. direct REST), so most user-visible features make sense on both. Only skip parity when the feature is structurally FMG-only (multi-FortiGate device filter, ADOM scoping, FMG-proxy concurrency tuning). UI: the Add/Edit modal tab layouts (`General` / `Filters` / `Monitoring` / `DHCP Push` / `Quarantine Push` / `Description Sync` / `SD-WAN` / `Geographic Location`) should look identical between the two types — diverge only on the tab content where the integrations genuinely differ. Backend: prefer `buildTransportForIntegration()`-style helpers that dispatch on integration type so push/quarantine/lease-release pathways stay generic instead of hardcoding `type === "fortimanager"` checks.
- **Scale-check every change at 100 and 2000 monitored assets.** Before shipping any code that touches background jobs, discovery phases, monitor passes, or per-asset DB queries, explicitly reason through its behaviour at both ends of the fleet-size range. At 100 assets, correctness matters most; at 2000, sequential-await-per-row loops, large IN clauses, repeated findMany calls inside ticking jobs, and DB connection churn become the dominant failure modes. The specific anti-patterns to flag: `for...of rows { await prisma...update() }` (should be `$transaction([...])` or batched `Promise.all`), `for...of items { await someDbCall() }` in a reconciler or job tick (parallelize with `Promise.all` when order doesn't matter), and queries that load all monitored assets without a tight `select` (every extra column at 2000 assets adds memory and serialization cost on the hot 5s/30s ticking loops).

---

## Out of Scope

- DNS record management
- DHCP server full-configuration push (scope creation, server policies, lease-time settings — individual reservation push and DHCP lease release ARE supported via the FMG/FortiGate DHCP Push toggle)
- Network device provisioning
- Cloud provider VPC/subnet creation (AWS, GCP, Azure)
- Acting as an identity provider (Polaris authenticates against local accounts, Azure SAML, OIDC, LDAP/AD, or Entra App Proxy header SSO — it does not issue identities for other systems)
