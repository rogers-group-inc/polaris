# Version-pin inventory

Every place a stack version is declared, grouped into the family that must move together.
This is the artifact that turns a major bump from a grep hunt into a checklist.

## How to read this

A **family** is one number (a Node major, the Go pin) and every **declaration site** that
states it. A site is anything that would keep provisioning or accepting the old version if you
forgot it — which includes docs: **a doc claim is a declaration site, not commentary.** When
`docs/INSTALL.md` carries three per-platform `Node.js 24 (LTS)` install sections, those are
three sites.

Site kinds:

- **pin** — an exact version this repo installs or requires. Bumping the family means editing it.
- **accept-range** — a floor an install script will tolerate on an already-provisioned host.
  Declares a *requirement*, not a version to install; the upper end of the range is a separate
  question (what have we actually tested?).
- **prose** — a version claim in a doc or a script header. Just as load-bearing, easier to miss.

Every site also has a **role**, and this is the part that matters:

- **floor** — the minimum the repo requires: `engines.node`, `@types/node`, the accept-checks,
  `NODE_MINIMUM_MAJOR`, a docs table's minimum column.
- **pin** — what it actually installs: the Dockerfiles, winget/MSI versions, a module stream,
  `node-version` in CI.

`npm run check:versions` asserts the floors agree with each other, the pins agree with each
other, and the floor never exceeds the pin. It deliberately does **not** demand a single number
per family, because a floor and a pin answer different questions — see *Why two numbers* under
Node. Run it before you commit any pin edit. If you add a declaration site, add it to the
checker; the `## Family index` table at the end of this file is the row set the script mirrors.

## Node.js

**Floor 22, pinned 24**, across 22 checked sites. Those are two different numbers on purpose —
see *Why two numbers* below.

| Site | Form | Role |
|---|---|---|
| `package.json` | `engines.node` `">=22.12.0"` | floor |
| `package.json` | `@types/node` `"^22.20.1"` | floor |
| `src/utils/platformVersions.ts` | `NODE_MINIMUM_MAJOR` | floor |
| four Linux setup scripts | `[[ "$(node -v)" == v24* \|\| "$(node -v)" == v22* ]]` | floor (22) |
| two Windows setup scripts | `(node -v) -match "^v(22\|24)\."` | floor (22) |
| `docs/INSTALL.md` | the **Supported platform versions** table, minimum column | floor |
| `README.md` | the system-requirements table, minimum column | floor |
| `Dockerfile` | `FROM node:24-bookworm` (builder) and `node:24-bookworm-slim` (runtime) | pin |
| `Dockerfile.dev` | `FROM node:24-bookworm` | pin |
| `deploy/setup-rhel.sh`, `deploy/setup-rhel-nodb.sh` | `dnf module enable -y nodejs:24` | pin |
| `deploy/setup-ubuntu.sh`, `deploy/setup-ubuntu-nodb.sh` | NodeSource `deb.nodesource.com/node_24.x` | pin |
| two Windows setup scripts | `winget install --id OpenJS.NodeJS.LTS --version 24.14.1` | pin |
| two Windows setup scripts | `nodejs.org/dist/v24.14.1/node-v24.14.1-x64.msi` fallback | pin |
| both workflow files | `node-version: 24` (three occurrences) | pin |
| `docs/INSTALL.md` | three `### 3. Node.js 24 (LTS)` install sections | prose pin |
| `CLAUDE.md` | the tech-stack table row | prose |
| `deploy/upgrade-node.sh` | the existing-host upgrade path | pin |

**Why two numbers.** The floor is what the dependency tree actually requires — `pg-boss` needs
22.12 — and the pin is what every install path provisions. Keeping them apart is deliberate: if
`engines.node` claimed 24, an install already running a perfectly good 22 would be locked out of
its next update by npm's engine warning, for no reason. So `check:versions` asserts the floors
agree with each other, the pins agree with each other, and the floor never exceeds the pin. It
does **not** demand one number, because that would force a choice between lying in `engines.node`
and lying in the Dockerfile.

**Live divergences and standing facts.**

- **A host on the floor has under a year of runway.** Node 22 ends 2027-04-30. The accept-checks
  tolerate it, nothing installs it, and nothing tests it — CI runs 24.
- `engines.node` is **advisory**: there is no `.npmrc` with `engine-strict=true`, so npm warns
  and installs anyway. The accept-regexes are the only real gate.
- **Windows pins an exact build** (`24.14.1`), so "Node 24" is false there past that patch, and
  the day 24 goes EOL those scripts keep installing it on every fresh host with nothing
  objecting. This is still the single most likely way Polaris ends up provisioning
  end-of-life software, which is why the Windows scripts are in the `node-major` playbook's file
  list. The 2026-09 bump from 20 is the worked example: it initially missed `engines.node`,
  `Dockerfile.dev`, both README tables and `node-version:` in CI — so the suite went green
  against a runtime no supported install had.
- `@types/node` tracks the **floor**, not the pin, so the compiler cannot green-light an API the
  oldest supported runtime lacks. The 2026-09 bump left it on 20 after moving `engines` to 22;
  `check:versions` is what caught that.

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

**RESOLVED 2026-09-09 — the RHEL install path used not to satisfy its own units.**
`deploy/setup-rhel.sh` installed `postgresql-server postgresql` from AppStream and ran
`postgresql-setup --initdb`, which yields an unversioned `postgresql.service` — while the units
the same script goes on to install declare `Requires=postgresql-15.service`. It could not
satisfy itself, and `docs/INSTALL.md` had documented the PGDG path all along, noting that
AppStream's package names also cannot satisfy `timescaledb-2-postgresql-15`. The script now
follows the documented path: PGDG repo, `dnf -qy module disable postgresql`, the
`postgresql15*` packages, `/usr/pgsql-15/bin/postgresql-15-setup initdb`, and the
`postgresql-15` service.

**The non-obvious part of that move, worth keeping in mind for a major bump.** PGDG puts its
binaries in `/usr/pgsql-<major>/bin` and nothing on `PATH`, and Polaris spawns `pg_dump` and
`psql` by BARE NAME for backup and restore (`src/services/backupService.ts`). The script
therefore symlinks exactly those two into `/usr/local/bin`, which is on the default systemd
`PATH`; without them every backup on a fresh install fails with ENOENT, and a backup you
discover is missing only when you need it is the worst kind. Just those two — symlinking the
whole bindir would shadow tools an operator may have pinned deliberately. The script's own
`psql` calls use the absolute path instead, rather than trusting `sudo`'s `secure_path` to
include `/usr/local/bin`.

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
| `deploy/setup-ubuntu.sh`, `deploy/setup-ubuntu-nodb.sh` | `openjdk-17-jre-headless`, falling back to `default-jre-headless` | pin |
| two Windows setup scripts | `Microsoft.OpenJDK.17` + `aka.ms/download-jdk/microsoft-jdk-17-windows-x64.msi` | pin |
| all six setup scripts | `JSIGN_VERSION="7.4"` + `JSIGN_SHA256` | pin |

**RESOLVED 2026-09-09.** The Ubuntu scripts installed `default-jre-headless`, the distro
default — Java 17 on 22.04 and Java 21 on 24.04. Two supported Polaris hosts therefore signed
agent binaries with different JDK majors, and only one matched the 17 every other site pins.
There was no number in the package name for the equality check to compare, so the drift was
invisible to the pin check as well as to the operator. Both scripts now install
`openjdk-17-jre-headless` by name, falling back to the distro default only if that package is
unavailable on the release — signing with the wrong major beats not signing at all, and the log
says which happened. `check:versions` skips `unversioned-install` when a file also runs a
versioned install, so a guarded fallback is not reported as a silent default.

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

Site counts move whenever a declaration site is added, so treat them as "roughly this many",
not as a figure to keep in step by hand — `npm run check:versions` prints the live count.

| Family | Agree on | Floor → pin | Warn-only companion |
|---|---|---|---|
| `node-major` | major | 22 → 24 | — (the accept-range gap closed when 24 became the pin) |
| `go-pin` | major.minor | 1.22 | — |
| `nginx-floor` | major.minor | 1.25 | — |
| `postgres-major` | major | 15 | `postgres-source` — quiet since setup-rhel.sh moved to PGDG |
| `java-major` | major | 17 | `unversioned-install` — quiet since the Ubuntu scripts pinned 17 |
| `jsign-pin` | major.minor | 7.4 | — |
| `dataset-shape` | n/a | n/a | dataset older than 120 days |

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
