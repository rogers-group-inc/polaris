# Version-pin inventory

Every place a stack version is declared, grouped into the family that must move together.
This is the artifact that turns a major bump from a grep hunt into a checklist.

## How to read this

A **family** is one number (a Node major, the Go pin) and every **declaration site** that
states it. A site is anything that would keep provisioning or accepting the old version if you
forgot it — which includes docs: **a doc claim is a declaration site, not commentary.** When
`docs/INSTALL.md` says "Node.js 20+" three times, those are three sites.

Site kinds:

- **pin** — an exact version this repo installs or requires. Bumping the family means editing it.
- **accept-range** — a floor an install script will tolerate on an already-provisioned host.
  Declares a *requirement*, not a version to install; the upper end of the range is a separate
  question (what have we actually tested?).
- **prose** — a version claim in a doc or a script header. Just as load-bearing, easier to miss.

`npm run check:versions` reads all of this and asserts each family agrees. If you edit a pin,
run it before you commit. If you add a declaration site, add it to the checker — the
`## Family index` table at the end of this file is the row set the script mirrors.

## Node.js

Currently **20** across 23 sites.

| Site | Form | Kind |
|---|---|---|
| `package.json` | `engines.node` `">=20.0.0"` | accept-range |
| `package.json` | `@types/node` `"^20.14.2"` | pin |
| `Dockerfile` | `FROM node:20-bookworm` (builder) and `node:20-bookworm-slim` (runtime) | pin |
| `Dockerfile.dev` | `FROM node:20-bookworm` | pin |
| four Linux setup scripts | `[[ "$(node -v)" == v20* \|\| "$(node -v)" == v22* ]]` | accept-range |
| `deploy/setup-rhel.sh`, `deploy/setup-rhel-nodb.sh` | `dnf module enable -y nodejs:20` | pin |
| `deploy/setup-ubuntu.sh`, `deploy/setup-ubuntu-nodb.sh` | NodeSource `deb.nodesource.com/node_20.x` | pin |
| two Windows setup scripts | `(node -v) -match "^v(20\|22)\."` | accept-range |
| two Windows setup scripts | `winget install --id OpenJS.NodeJS.LTS --version 20.19.0` | pin |
| two Windows setup scripts | `nodejs.org/dist/v20.19.0/node-v20.19.0-x64.msi` fallback | pin |
| both workflow files | `node-version: 20` (three occurrences) | pin |
| `docs/INSTALL.md` | "Node.js 20+" — three separate install-section headings | prose |
| `README.md` | "Install Node.js 20+" and the setup-script summary | prose |
| `CLAUDE.md` | the tech-stack table row | prose |

**Live divergences.**

- The Linux scripts accept `v22`, and so do the Windows accept-checks, but **nothing installs
  22**. A host that already has 22 passes the gate and runs a combination CI never exercised.
  `check:versions` reports this as a warning.
- Windows pins the exact build `20.19.0`. "Node 20+" is therefore false on Windows past that
  patch, and the day Node 20 goes EOL these scripts keep installing an EOL runtime on every
  fresh host with nothing objecting. This is the single most likely way Polaris ends up
  provisioning end-of-life software, and it is why the Windows scripts appear in the
  `node-major` playbook's file list.
- `engines.node` is **advisory**: there is no `.npmrc` with `engine-strict=true`, so npm warns
  and installs anyway. The accept-regexes are the only real gate.

## PostgreSQL

Currently **15** across 12 checked sites.

| Site | Form | Kind |
|---|---|---|
| `deploy/polaris-web.service` and the other shipped units | `After=` / `Requires=postgresql-15.service` | pin |
| `deploy/setup-ubuntu.sh` | rewrites `postgresql-15.service` → `postgresql.service` in the units | pin |
| `deploy/setup-rhel-nodb.sh`, `deploy/setup-ubuntu-nodb.sh` | strip the `postgresql-15.service` dependency for the external-DB variant | pin |
| two Windows setup scripts | `winget install --id PostgreSQL.PostgreSQL.15` | pin |
| two Windows setup scripts | `postgresql-15.13-1-windows-x64.exe` fallback URL | pin |
| two Windows setup scripts | `--servicename postgresql-15`, the `C:\Program Files\PostgreSQL\15\bin` candidate, NSSM `DependOnService` | pin |
| `compose.dev.yml` | `timescale/timescaledb:latest-pg15` | pin (floating patch) |
| `.github/workflows/docker-publish.yml` | `image: postgres:15-alpine` service container | pin |
| `docs/INSTALL.md` | `timescaledb-2-postgresql-15`, `/usr/pgsql-15/bin/`, `postgresql15-server` | pin |
| `README.md`, `CONTRIBUTING.md`, `CLAUDE.md` | "PostgreSQL 15+", `postgres:15` | prose |

**Live divergence — the RHEL install path cannot satisfy its own units.**
`deploy/setup-rhel.sh` installs `postgresql-server postgresql` from AppStream and runs
`postgresql-setup --initdb`, which yields an unversioned `postgresql.service`. The units the
same script then installs declare `Requires=postgresql-15.service`, and `docs/INSTALL.md`
documents the PGDG packages instead — explicitly noting that AppStream's package names cannot
satisfy `timescaledb-2-postgresql-15`. So the scripted install and the documented install are
not the same install, and the scripted one is internally inconsistent. `check:versions` reports
this as a warning rather than a failure because fixing it changes the RHEL install path, which
is a decision for a human.

**TimescaleDB compatibility caps the PostgreSQL major from the other side.** TimescaleDB 2.29
dropped PostgreSQL 15; 2.28.x is the last line that supports it. Staying on 15 pins the
extension, which is why the dataset targets PostgreSQL 17.

## TimescaleDB

No version is pinned anywhere. The real constraints are:

| Site | Form |
|---|---|
| `docs/INSTALL.md` | `timescaledb-2-postgresql-15` — the PG major is inside the package name |
| `compose.dev.yml` | `timescale/timescaledb:latest-pg15`, `shared_preload_libraries=timescaledb` |
| runtime | detected, not pinned: `src/services/timescaleService.ts` reads `pg_extension` |

**CI exercises no TimescaleDB at all** — the publish workflow's service container is a plain
`postgres` image. Every hypertable, chunk-interval and compression path in the app is therefore
untested by CI, and a green CI run proves nothing about a PostgreSQL or TimescaleDB bump. Smoke
it against a dev stack, and read the chunk-bloat runbook in `polaris-monitoring-discovery`
first: an extension move and a chunk-interval change must not land together.

## Go (agent toolchain)

Currently **1.22** across 12 sites — and 1.22 is past upstream support (Go keeps only the two
most recent majors alive).

| Site | Form | Kind |
|---|---|---|
| `agent/go.mod` | `go 1.22` directive | pin |
| four Linux setup scripts | `go version \| grep -qE 'go1\.(2[2-9]\|[3-9][0-9])'` | accept-range |
| `deploy/setup-rhel.sh`, `deploy/setup-rhel-nodb.sh` | `dnf module enable -y go-toolset` then `dnf install -y golang` | pin (module stream) |
| `deploy/setup-ubuntu.sh`, `deploy/setup-ubuntu-nodb.sh` | `golang-go`, re-verified against the same regex, snap fallback when too old | accept-range |
| two Windows setup scripts | `(go version) -match "go1\.(2[2-9]\|[3-9][0-9])"` | accept-range |
| two Windows setup scripts | `winget install --id GoLang.Go.1.22` | pin |
| two Windows setup scripts | `go.dev/dl/go1.22.7.windows-amd64.msi` fallback | pin |
| `Dockerfile` | `golang-go` from `bookworm-backports`, because bookworm-slim ships 1.21.x | pin (suite) |
| `agent/Makefile` | `go-winres@v0.3.3` for the Windows resource files | pin |
| `docs/INSTALL.md` | "Go 1.22+" — three occurrences | prose |

**The app-side preflight.** `GO_MINIMUM` in `src/services/agentBuildService.ts` is the single
source of truth for the number the running app requires, and every operator-facing copy string
interpolates it. Historically the check only confirmed `go version` *ran*, so a host with Go
1.21 passed the preflight, showed an enabled Build button, and failed later inside `go build` —
which is what "missing go.sum entry" or a bare compiler error from the in-app build means on a
fresh host.

Bumping the pin also moves `agent/VERSION` and the committed Windows resource files. That
rebuild contract lives in `polaris-agent` → cross-cutting-polaris-agent.md; do not restate it.

## nginx

Floor **1.25** across 5 sites — and 1.25 itself went EOL in May 2024.

| Site | Form | Kind |
|---|---|---|
| four Linux setup scripts | `nginx -v 2>&1 \| grep -qE '1\.(2[5-9]\|[3-9][0-9])'` | accept-range |
| `deploy/setup-rhel.sh` etc. | nginx.org **mainline** repo, `baseurl` encoding the OS release | pin (repo) |
| `deploy/migrate-to-nginx.sh` | parses the running version for its own gate | accept-range |
| `docker-compose.yml` | `image: nginx:mainline` | floating |
| `docs/INSTALL.md` | "nginx ≥ 1.25", "mainline from nginx.org for HTTP/3" — three occurrences | prose |
| `public/js/server-settings.js` | "Requires nginx 1.25+" help text beside the HTTP/3 toggle | prose |

The 1.25 floor is a **feature** requirement (first branch with stable HTTP/3), not a support
statement. Because the scripts install from the mainline repo, a scripted install lands on a
current branch anyway — so the stale floor is a documentation problem, not a provisioning one.
That is the opposite of the Node situation, and worth keeping straight.

`nginx -v` writes to **stderr**, and the version there is the only place the app can read it.

## Java and jsign

Java **17**, jsign **7.4**.

| Site | Form | Kind |
|---|---|---|
| `Dockerfile` | Java 17 headless, plus a SHA-256-pinned `jsign-7.4.jar` fetched by digest | pin |
| `deploy/setup-rhel.sh`, `deploy/setup-rhel-nodb.sh` | `java-17-openjdk-headless` | pin |
| `deploy/setup-ubuntu.sh`, `deploy/setup-ubuntu-nodb.sh` | **`default-jre-headless`** — unversioned | none |
| two Windows setup scripts | `Microsoft.OpenJDK.17` + `aka.ms/download-jdk/microsoft-jdk-17-windows-x64.msi` | pin |
| all six setup scripts | `JSIGN_VERSION="7.4"` + `JSIGN_SHA256` | pin |

**Live divergence.** The Ubuntu scripts install the distro default JRE, which is Java 17 on
22.04 and Java 21 on 24.04. Two supported Polaris hosts therefore sign agent binaries with
different JDK majors, and only one of them matches what every other site pins. There is no
number in `default-jre-headless` to disagree with, so the equality check cannot see it —
`check:versions` reports it as an `unversioned-install` warning instead.

Both are build-time only (jsign signs the Windows agent binaries) and the feature is opt-in, so
a missing or mismatched JDK degrades signing rather than breaking the app.

## Operating systems

| OS | Supported | Sites |
|---|---|---|
| RHEL / Rocky / AlmaLinux | 9 | `deploy/setup-rhel.sh`, `deploy/setup-rhel-nodb.sh`, `docs/INSTALL.md`, `README.md` |
| Ubuntu / Debian | Ubuntu 22.04+ | `deploy/setup-ubuntu.sh`, `deploy/setup-ubuntu-nodb.sh`, `docs/INSTALL.md` |
| Windows Server | 2019 / 2022 | `deploy/setup-windows.ps1`, `deploy/setup-windows-nodb.ps1`, `README.md` |
| Debian (container base) | 12 bookworm | `Dockerfile`, `Dockerfile.dev` |

The nginx.org `baseurl` in the RHEL scripts encodes the OS release (`centos/9`), so a RHEL 10
move is a URL change in the install scripts, not just a documentation change. Check the PGDG
and TimescaleDB repositories publish for the new major before promising support.

## npm majors that are architectural

These are not "pins" in the lockstep sense — one site each, in `package.json` — but a major
move is a project, not a dependency bump, so they are listed here and ignored in Dependabot.

- **express 5** — the `:param(regex)` route form throws at boot; that is what
  `tests/unit/routerBoots.test.ts` guards.
- **the Prisma family** — `prisma`, `@prisma/client` and `@prisma/adapter-pg` are **one
  version** and must move together. Driver-adapter setup, and the generated client is
  gitignored so every checkout regenerates via `postinstall`.
- **zod 3**, **typescript 6**, **eslint 9** + `typescript-eslint 8`, **vitest 4** +
  `@vitest/coverage-v8` (versions must match), **pg 8**, **pg-boss 12**, **pino 10**,
  **undici 6**, **multer 2**, **happy-dom 20**.
- **the vendored frontend set** — Leaflet, leaflet.markercluster, leaflet-draw, Cytoscape,
  dagre, html-to-image. These ship as files under `public/`, so a bump is a file copy, not an
  npm operation. See `polaris-ui-canon` → tech-stack-frontend.md.

## The overrides block

`package.json` carries five `overrides` entries — `@hono/node-server`, `qs`, `fflate`,
`@xmldom/xmldom`, `fast-uri` — each a hand-placed floor patching a reachable transitive
advisory. Dependabot does not know the block exists. A parent bump can make an override
redundant (harmless but misleading) or insufficient (a real hole). Re-verify with
`npm ls <pkg>` before deleting one, and never `npm audit fix --force`. Details:
[dependency-audit.md](dependency-audit.md).

## Family index

The row set `scripts/check-versions.mjs` mirrors. These drift together or not at all.

| Family | Agree on | Sites | Warn-only companion |
|---|---|---|---|
| `node-major` | major | 23 | accept-range exceeds every pin |
| `go-pin` | major.minor | 12 | — |
| `nginx-floor` | major.minor | 5 | — |
| `postgres-major` | major | 12 | `postgres-source` (RHEL AppStream vs PGDG) |
| `java-major` | major | 6 | `unversioned-install` (Ubuntu `default-jre-headless`) |
| `jsign-pin` | major.minor | 5 | — |
| `dataset-shape` | n/a | — | dataset older than 120 days |

Not families, on purpose: the CI-has-no-TimescaleDB gap (a standing truth, not drift — a check
that can never pass is noise) and the floating tags (reported informationally, since there is
no number to compare).

## Things that are NOT pins

Do not "bump" these:

- **The Polaris version.** `package.json` holds `<major>.<minor>` and the patch is the git
  commit count, computed at runtime by `src/utils/version.ts`. Bump the minor only when cutting
  a named release.
- **`agent/VERSION`.** The agent's own version, decoupled from Polaris's, and the thing the
  fleet's upgrade check compares against.
- **The encrypted-backup magic header.** A format marker, not a version to increment.
- **`schemaVersion` in `src/data/platformEol.json`.** The dataset's shape version — bump it only
  when the schema changes, not when a date does.
