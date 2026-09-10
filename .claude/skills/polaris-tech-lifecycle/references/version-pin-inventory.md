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
| `Dockerfile` | `FROM node:24-trixie` (builder) and `node:24-trixie-slim` (runtime) | pin |
| `Dockerfile.dev` | `FROM node:24-trixie` | pin |
| `deploy/setup-rhel.sh`, `deploy/setup-rhel-nodb.sh` | `dnf module enable -y nodejs:24` | pin |
| `deploy/setup-ubuntu.sh`, `deploy/setup-ubuntu-nodb.sh` | NodeSource `deb.nodesource.com/node_24.x` | pin |
| two Windows setup scripts | `winget install --id OpenJS.NodeJS.LTS --version 24.19.0` | pin |
| two Windows setup scripts | `nodejs.org/dist/v24.19.0/node-v24.19.0-x64.msi` fallback | pin |
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
- **Windows pins an exact build** (`24.19.0`), so "Node 24" is false there past that patch, and
  the day 24 goes EOL those scripts keep installing it on every fresh host with nothing
  objecting. This is still the single most likely way Polaris ends up provisioning
  end-of-life software, which is why the Windows scripts are in the `node-major` playbook's file
  list. The 2026-09 bump from 20 is the worked example: it initially missed `engines.node`,
  `Dockerfile.dev`, both README tables and `node-version:` in CI — so the suite went green
  against a runtime no supported install had.
- **The winget channel, not nodejs.org, sets the Windows patch pin.** Both Windows sites name
  the same build so the two install paths cannot diverge, and the ceiling is whatever
  `OpenJS.NodeJS.LTS` has a manifest for — 24.19.0 on 2026-09-09, while nodejs.org was already
  on 24.21.0. Check the winget manifest list before picking a patch: pinning a `--version`
  winget does not carry makes that branch fail outright rather than falling through to the MSI.
- `@types/node` tracks the **floor**, not the pin, so the compiler cannot green-light an API the
  oldest supported runtime lacks. The 2026-09 bump left it on 20 after moving `engines` to 22;
  `check:versions` is what caught that.

## PostgreSQL

Currently **17** across 18 checked sites. Moved from 15 on 2026-09-09.

| Site | Form | Kind |
|---|---|---|
| `deploy/setup-rhel.sh` | `PG_MAJOR=17` — derives `PG_SERVICE`, `PG_BINDIR`, `PG_DATADIR` and the package names | pin |
| `deploy/setup-rhel-nodb.sh` | `PG_CLIENT_MAJOR=17` → `dnf install -y "postgresql${PG_CLIENT_MAJOR}"` from PGDG (was an unversioned `dnf install -y postgresql`, which is PostgreSQL 13 on RHEL 9 and cannot dump a 17 server — rule 47) | pin |
| `deploy/setup-ubuntu-nodb.sh` | `PG_CLIENT_MAJOR=17` → `apt-get install -y postgresql-client-17` from the PGDG apt repo. Was the unversioned `postgresql-client` metapackage — 14 on 22.04, 16 on 24.04 — i.e. the same rule-47 trap in apt form | pin |
| `deploy/setup-ubuntu.sh` | `PG_MAJOR=17` + the PGDG **apt** repo → `apt-get install -y postgresql-17` | pin |
| `deploy/ha/setup-rhel-ha.sh` | `PG_MAJOR=17` — the Patroni node's server packages, `PG_BIN`, `PGDATA` and the TimescaleDB package | pin |
| `deploy/dropins/20-postgres.conf.example` | `After=` / `Requires=postgresql-17.service` — the reference copy of the per-host drop-in | pin |
| two Windows setup scripts | `winget install --id PostgreSQL.PostgreSQL.17` | pin |
| two Windows setup scripts | `postgresql-17.11-1-windows-x64.exe` fallback URL | pin |
| two Windows setup scripts | `--servicename postgresql-17`, and the `C:\Program Files\PostgreSQL\<major>\bin` probe list (newest first) | pin |
| `compose.dev.yml` | `timescale/timescaledb:latest-pg17` | pin (floating patch) |
| `.github/workflows/docker-publish.yml` | `image: postgres:17-alpine` service container | pin |
| `.github/workflows/docker-publish.yml` | `postgresql-client-17` in the `integration` job. The CI **client**, and it has to agree with the service image directly above it: the job dumps that container, and pg_dump refuses a server newer than itself (rule 47). Registered 2026-09-10 — the service image had moved to 17 while the job went on using the runner's own 16, so every backup test failed and the image build was skipped for 200 commits | pin |
| `Dockerfile`, `Dockerfile.dev` | `postgresql-client-17` — named, and checked. Was the unversioned `postgresql-client`, i.e. whatever the base image shipped | pin |
| `docs/INSTALL.md` | `timescaledb-2-postgresql-17`, `/usr/pgsql-17/bin/`, `postgresql17-server` | pin |
| `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `DEVELOPMENT.md` | "PostgreSQL 17+", `postgres:17`, `latest-pg17` | prose |
| `src/services/haService.ts` | `pgBinDir` / `pgdata` fallbacks when a host was never probed | pin (code) |
| `src/services/haEnrollmentService.ts` | `DEFAULT_PG_MAJOR`, and `pgMajorFromPaths()` which derives the teardown script's unit name from the host's own paths | pin (code) |

**NOT a site any more: the shipped systemd units.** They named
`Requires=postgresql-15.service` until 2026-09-09. That was wrong in a way the equality check
could not see, because the unit files agreed with each other perfectly:

- the PostgreSQL unit name is a **host** fact — `postgresql-17.service` on RHEL/PGDG,
  `postgresql.service` on Debian/Ubuntu, nothing at all for an external database, masked under
  Patroni — while the unit file is **overwritten verbatim by every update**, in-app (via the
  transient systemd-run unit under the manage-units polkit grant) and by
  `deploy/update-linux.sh` alike;
- so `setup-ubuntu.sh` rewriting the name in place at install time was undone by the very next
  update, which handed Debian hosts a `Requires=` for a unit that does not exist there;
- and bumping the major in the units would have done the same to every existing install on its
  first update after the bump.

The dependency is a per-host drop-in now — `/etc/systemd/system/<unit>.d/20-postgres.conf`,
written by the setup scripts, reference copy in `deploy/dropins/20-postgres.conf.example`.
Drop-ins survive both sync paths. Three things enforce it:

- `check:versions` **fails** if a shipped unit names a postgresql unit again
  (`units-name-no-postgres`);
- both updaters migrate an existing host by reading the name out of the installed unit and
  writing it into a drop-in *before* overwriting — `preserve_postgres_dependency()` in
  `deploy/update-linux.sh` and the matching block in `updateService.ts`'s sync script;
- both skip that migration on an HA node (`/etc/polaris/ha-node` or a `10-ha.conf`), because
  drop-ins apply in lexical order and a `20-` file would re-add the dependency **after**
  `10-ha.conf` reset it to `patroni.service`. `setup-rhel-ha.sh` deletes any that exists.

**RESOLVED 2026-09-09 — and the bug was bigger than "the service name was wrong".**
`deploy/setup-rhel.sh` ran `dnf install -y postgresql-server postgresql` with no module
enabled, then `postgresql-setup --initdb`. Checked against the **RHEL 9.5 DVD** rather than
assumed:

- the AppStream `postgresql` module declares **no default stream** — its defaults document
  lists profiles for 15 and 16 and nothing else — so the modular packages stay hidden until a
  stream is explicitly enabled;
- the non-modular default in AppStream is **`postgresql-server-13.16-1.el9`**;
- **no `postgresql15-*` package exists anywhere on the media**, which is why AppStream can
  never satisfy `timescaledb-2-postgresql-15`.

So a fresh RHEL install got **PostgreSQL 13** — two majors below the 15 Polaris states as its
minimum, TimescaleDB-incapable, and producing an unversioned `postgresql.service` while the
units the same script installed then declared `Requires=postgresql-15.service` inline. It could
not satisfy its own units *and* it was installing the wrong major. `docs/INSTALL.md` had
documented the PGDG path all along.

The script now follows it, and the major is a single `PG_MAJOR` variable rather than a literal:
PGDG repo, `dnf -qy module disable postgresql`, the `postgresql${PG_MAJOR}*` packages,
`/usr/pgsql-${PG_MAJOR}/bin/postgresql-${PG_MAJOR}-setup initdb`, and the
`postgresql-${PG_MAJOR}` service — 17 since 2026-09-09. The unit name reaches systemd through
the per-host `20-postgres.conf` drop-in, never through a shipped unit.

**The non-obvious part of that move, and a wrong turn worth not repeating.** Polaris spawns
`psql` and `pg_dump` by BARE NAME for backup and restore (`src/services/backupService.ts`), so
they must be on the service's `PATH`. PGDG installs into `/usr/pgsql-<major>/bin`, which looks
like it would break that — and the first version of this change therefore symlinked both into
`/usr/local/bin`.

**That was wrong, and testing it in a container is what caught it.** PGDG registers
`/usr/bin/psql` and `/usr/bin/pg_dump` itself, through `alternatives`, pointing at the installed
major's bindir; a bare-name `pg_dump` resolves and dumps a live database with no help at all.
Worse, `/usr/local/bin` *precedes* `/usr/bin`, so the hardcoded links would have silently
shadowed the alternatives entry and kept resolving to 15 after an operator moved to a newer
major side by side (`alternatives --set pgsql-psql …`) — and side-by-side majors are one of the
stated reasons for preferring PGDG. It would have failed in the most expensive way available:
backups quietly using the old client while everything looked healthy.

The script now only *checks* that both resolve, and warns loudly that backups will fail if they
do not. Its own `psql` calls still use the absolute `$PG_BINDIR/psql` rather than trusting
`sudo`'s `secure_path`.

**TimescaleDB compatibility caps the PostgreSQL major from the other side.** TimescaleDB 2.29
dropped PostgreSQL 15; 2.28.x is the last line that supports it. Staying on 15 would have pinned
the extension, which is why the dataset targeted 17 and why the 2026-09-09 pass moved there.

## TimescaleDB

No version is pinned anywhere. The real constraints are:

| Site | Form |
|---|---|
| `docs/INSTALL.md` | `timescaledb-2-postgresql-17` — the PG major is inside the package name, so it moves with `PG_MAJOR` |
| `compose.dev.yml` | `timescale/timescaledb:latest-pg17`, `shared_preload_libraries=timescaledb` |
| runtime | detected, not pinned: `src/services/timescaleService.ts` reads `pg_extension` |

**CI exercises no TimescaleDB at all** — the publish workflow's service container is a plain
`postgres` image. Every hypertable, chunk-interval and compression path in the app is therefore
untested by CI, and a green CI run proves nothing about a PostgreSQL or TimescaleDB bump. Smoke
it against a dev stack, and read the chunk-bloat runbook in `polaris-monitoring-discovery`
first: an extension move and a chunk-interval change must not land together.

## Go (agent toolchain)

**Floor 1.26, pinned 1.27** across 14 sites — two numbers, the same arrangement as Node and for
a similar reason. Was 1.22 until 2026-09-09, by then two years past upstream support: Go keeps
only the two most recent majors alive.

| Site | Form | Kind |
|---|---|---|
| `agent/go.mod` | `go 1.26.0` directive — patch-qualified since `go get` rewrote it for x/sys; `check:versions` reads `/^go (\d+\.\d+)/`, so either form satisfies it and neither is worth normalising by hand | floor |
| four Linux setup scripts | `go version \| grep -qE 'go1\.(2[6-9]\|[3-9][0-9])'` | accept-range |
| `deploy/setup-rhel.sh`, `deploy/setup-rhel-nodb.sh` | `dnf module enable -y go-toolset` then `dnf install -y golang` | pin (module stream) |
| `deploy/setup-ubuntu.sh`, `deploy/setup-ubuntu-nodb.sh` | `golang-go`, re-verified against the same regex, then `snap install --channel=1.26/stable go` — which is the branch that actually runs, since neither LTS archive reaches 1.26 | accept-range |
| two Windows setup scripts | `(go version) -match "go1\.(2[6-9]\|[3-9][0-9])"` | accept-range |
| two Windows setup scripts | `winget install --id GoLang.Go --version 1.27.0` | pin |
| two Windows setup scripts | `go.dev/dl/go1.27.0.windows-amd64.msi` fallback | pin |
| `Dockerfile` | `golang-go` from `trixie-backports`, because trixie ships 1.24. The backports SUITE must track the base image — a `bookworm-backports` line on a trixie base resolves to nothing and the build fails at `apt-get install` | pin (suite) |
| `agent/Makefile` | `go-winres@v0.3.3` for the Windows resource files | pin |
| `docs/INSTALL.md` | "Go 1.26+" — three occurrences, plus the supported-versions row | prose (floor) |

**The app-side preflight.** `GO_MINIMUM` in `src/services/agentBuildService.ts` is the single
source of truth for the number the running app requires, and every operator-facing copy string
interpolates it. Historically the check only confirmed `go version` *ran*, so a host with Go
1.21 passed the preflight, showed an enabled Build button, and failed later inside `go build` —
which is what "missing go.sum entry" or a bare compiler error from the in-app build means on a
fresh host.

**Why the floor and the pin differ, as of 2026-09-09.** 1.26 and 1.27 are the two supported
majors, and **no Linux path can install 1.27**: the RHEL `go-toolset` module carries 1.26.7 and
the Go snap's newest channel is `1.26/stable`. So the floor is 1.26 — what every platform can
actually meet — and the Windows scripts pin 1.27.0, the newest winget has a manifest for.
Neither Ubuntu LTS reaches the floor from its own archive (24.04 ships 1.22, 22.04 ships 1.18),
so on a supported Ubuntu the **snap branch is the one that runs**; the apt attempt stays because
it is cheap and correct on a newer Debian, and the version re-check after it is what decides.

**The Windows winget id was wrong, and silently.** It read `--id GoLang.Go.1.22`. winget
publishes ONE `GoLang.Go` package with per-version manifests — there is no `GoLang.Go.1.22`
package — so on any host that HAS winget the install failed, and because the MSI download is the
`else` branch of `if ($hasWinget)`, the fallback never ran. The host ended up with no Go at all
and the in-app agent Build failing at the compiler, which reads as a Go problem rather than an
install-script problem. It is `--id GoLang.Go --version 1.27.0` now, and `check:versions` reads
that form.

Bumping the pin also moves `agent/VERSION` and the committed Windows resource files. That
rebuild contract lives in `polaris-agent` → cross-cutting-polaris-agent.md; do not restate it.
The 2026-09-09 floor move deliberately did **not** touch `agent/VERSION`: a toolchain bump is
not an agent release, and bumping the version would tell every enrolled agent an upgrade is
available. Rebuild the binaries in-app when you want them rebuilt.

**A MODULE bump is the other case, and it does move `agent/VERSION`.** The 2026-09-10
`golang.org/x/sys` v0.20.0 → v0.48.0 went to 0.17.3 with regenerated `.syso` files, because
unlike a `go` directive change it alters the code compiled into the binary — x/sys is the
syscall layer under gopsutil, so the shipped agent genuinely differs and enrolled agents should
be offered the upgrade. The dividing line is whether the binary's CONTENT changes, not whether
`agent/go.mod` was edited.

**The Go floor and `golang.org/x/sys` are coupled in one direction.** x/sys tracks the current
Go release in its own `go` directive — v0.44.0 needs 1.25, v0.48.0 needs 1.26 — so the module
cannot move ahead of the floor, and there is no older release carrying the same fix to retreat
to. Dependabot #134 was unmergeable against the 1.22 floor for that reason alone and became a
clean merge once the floor reached 1.26. Read the target's directive before judging such a PR;
`dependency-audit.md` → The Go module set has the one-liner for it.

## nginx

Floor **1.30** across 6 sites, installed from the nginx.org **stable** branch. A 7th
site is dev-only and deliberately not a pin: the DAST scan harness pulls `nginx:stable`
the way `docker-compose.yml` does (business rule 50).

| Site | Form | Kind |
|---|---|---|
| four Linux setup scripts | `nginx -v 2>&1 \| grep -qE '1\.(3[0-9]\|[4-9][0-9])'` | accept-range |
| `deploy/setup-rhel.sh`, `deploy/setup-rhel-nodb.sh`, `deploy/migrate-to-nginx.sh` | a two-stanza `nginx.repo` — `[nginx-stable]` `enabled=1`, `[nginx-mainline]` `enabled=0`, both `baseurl`s encoding the OS release | pin (repo) |
| `deploy/setup-ubuntu.sh`, `deploy/setup-ubuntu-nodb.sh` | `deb … nginx.org/packages/${NGINX_DISTRO} ${CODENAME} nginx` (no `/mainline` path segment) | pin (repo) |
| `deploy/ha/setup-rhel-ha.sh` | its own single-stanza copy of the same repo file | pin (repo) |
| `deploy/migrate-to-nginx.sh` | parses the running version for its own gate (`$NGINX_MINOR -lt 30`) | accept-range |
| `docker-compose.yml` | `image: nginx:stable` | floating |
| `deploy/nginx/README-scan-harness.md` | `docker.io/library/nginx:stable` in the DAST harness `podman run` | floating (dev only, ships nowhere) |
| `docs/INSTALL.md` | "nginx ≥ 1.30" and the stable-branch phrasing — five occurrences plus the table row | prose |
| `public/js/server-settings.js` | "Requires nginx 1.30+" help text beside the HTTP/3 toggle | prose |

**The floor changed meaning on 2026-09-09.** It used to be a **feature** requirement — 1.25 is
the first branch with stable HTTP/3 — which is why it sat two years past that branch's own EOL
without anyone being wrong. Now the scripts install the stable branch and the floor is 1.30, the
oldest branch still receiving fixes, so it is a **support** statement like every other floor
here. HTTP/3 still only needs 1.25; nothing in the app requires 1.30 specifically.

**Both stanzas stay in the RHEL repo file** — mainline is written at `enabled=0`, so an operator
who needs a mainline-only feature flips two flags rather than hand-writing a repo. The Ubuntu
scripts have no such spare: stable is the path segment's absence, and mainline is adding
`/mainline` back.

The two branches are one number apart and move on the same day: 1.30 (stable) and 1.31
(mainline) both shipped in 2026. Do not read `nginx:stable` in `docker-compose.yml` as a pin —
it is a floating tag, listed as such by `check:versions`.

`nginx -v` writes to **stderr**, and the version there is the only place the app can read it.

## Java and jsign

Java **25**, jsign **7.5**.

| Site | Form | Kind |
|---|---|---|
| `Dockerfile` | `openjdk-25-jre-headless`, plus a SHA-256-pinned `jsign-7.5.jar` fetched by digest | pin |
| `deploy/setup-rhel.sh`, `deploy/setup-rhel-nodb.sh` | `java-25-openjdk-headless` | pin |
| `deploy/setup-ubuntu.sh`, `deploy/setup-ubuntu-nodb.sh` | `openjdk-25-jre-headless`, falling back to `default-jre-headless` | pin |
| two Windows setup scripts | `Microsoft.OpenJDK.25` + `aka.ms/download-jdk/microsoft-jdk-25-windows-x64.msi` | pin |
| `src/services/agentSigningService.ts` | `JAVA_MINIMUM` — the number the RUNNING APP states, interpolated into every "install Java N+" string and served to the UI as `availability.javaMinimum` | pin |
| all six setup scripts | `JSIGN_VERSION="7.5"` + `JSIGN_SHA256` | pin |

**RESOLVED 2026-09-09.** The Ubuntu scripts installed `default-jre-headless`, the distro
default — Java 17 on 22.04 and Java 21 on 24.04. Two supported Polaris hosts therefore signed
agent binaries with different JDK majors, and only one matched the 17 every other site pins.
There was no number in the package name for the equality check to compare, so the drift was
invisible to the pin check as well as to the operator. Both scripts now install a JDK **by
name**, falling back to the distro default only if that package is unavailable on the release —
signing with the wrong major beats not signing at all, and the log says which happened.
`check:versions` skips `unversioned-install` when a file also runs a versioned install, so a
guarded fallback is not reported as a silent default. The Dockerfile had the same unversioned
install and was fixed on the same day the major moved: `default-jre-headless` on a trixie base
is 21, so it would have drifted under the image at the next base bump.

**Moved 17 → 25 on 2026-09-09.** jsign 7.5 is Java 8 bytecode (class file major 52, confirmed
by unpacking the jar), so nothing here *needs* a newer JDK — the move buys runway, 2030-09-30
instead of 2027-09-30, and one fewer edit later. Availability was checked on every path first,
because one platform without the package splits the fleet's signing JDK all over again: RHEL 9
AppStream (`java-25-openjdk-headless`), Debian trixie and Ubuntu 22.04 *and* 24.04
(`openjdk-25-jre-headless`), winget (`Microsoft.OpenJDK.25`) and the `aka.ms` MSI all carry it.

**The app states a floor too, and it was the last site to move (2026-09-11).** The two
`signingAvailability` error strings and the Code-signing card both said "Java 17+" for two days
after every install path moved to 25 — pointing an operator at a version `platformEol.json`
grades `below_minimum`, which is ALWAYS critical, while the card that told them to install it
called it fine. Nothing caught it because `java-major` read only install scripts, the Dockerfile
and the docs table; no family member read `src/`. `JAVA_MINIMUM` is now that number, the strings
interpolate it, the browser reads it off the availability payload rather than carrying its own
literal, and the family scans it — the same shape `GO_MINIMUM` has had since the Go floor
started being enforced. A copy string with a hardcoded version is a claim nothing checks.


**Target always equals minimum in the dataset for this row.** A target above what the install
paths provision makes every healthy install report a behind-target JDK forever, which is the
noise that teaches operators to ignore the Platform Lifecycle card. The row was briefly
21-target/17-minimum and that was the mistake; the 25 move kept the two together.

Both are build-time only (jsign signs the Windows agent binaries) and the feature is opt-in, so
a missing or mismatched JDK degrades signing rather than breaking the app.

## Operating systems

| OS | Supported | Sites |
|---|---|---|
| RHEL / Rocky / AlmaLinux | 9 | `deploy/setup-rhel.sh`, `deploy/setup-rhel-nodb.sh`, `docs/INSTALL.md`, `README.md` |
| Ubuntu / Debian | Ubuntu 22.04+ | `deploy/setup-ubuntu.sh`, `deploy/setup-ubuntu-nodb.sh`, `docs/INSTALL.md` |
| Windows Server | 2019 / 2022 | `deploy/setup-windows.ps1`, `deploy/setup-windows-nodb.ps1`, `README.md` |
| Debian (container base) | 13 trixie | `Dockerfile`, `Dockerfile.dev` — moved from 12 bookworm on 2026-09-09, because trixie ships the PostgreSQL 17 client and openjdk-25 |

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
- **zod 3**, **typescript 6**, **eslint 10** + `typescript-eslint 8`, **vitest 4** +
  `@vitest/coverage-v8` (versions must match), **pg 8**, **pg-boss 12**, **pino 10**,
  **undici 6**, **multer 2**, **happy-dom 20**.
  - eslint went 9 → 10 in 2026-09 as the fix for a `js-yaml` advisory: eslint 10 drops
    `@eslint/eslintrc`, which was the only thing pulling it, so the vulnerable package left
    the tree rather than being bumped. Clean on this codebase (0 errors).
  - **`@eslint/js` moves with it and is a third member of that group.** `eslint.config.mjs`
    imports it directly; eslint 9 supplied it transitively and eslint 10 does not, so it is
    now an explicit devDependency. The trap is that an incremental `npm install` leaves the
    old transitive copy in place and lint keeps working — only a clean `npm ci`, which is
    what CI does, surfaces `ERR_MODULE_NOT_FOUND: Cannot find package '@eslint/js'`. **Run
    `npm ci` before trusting a lint result after any eslint bump.** Its version line trails
    eslint's: 10.10.0 pairs with `@eslint/js` 10.0.1.
  - `@eslint/js` 10's recommended set adds **`no-useless-assignment`**, which lands on 31
    pre-existing sites here and is switched off in `eslint.config.mjs` with a rationale.
    Clearing those sites is an open follow-up, not part of the bump.
  - **TypeScript 6 → 7 was deliberately declined in the same pass.** Dependabot bundles it
    into the `typescript-toolchain` group with the eslint bump, which makes a compiler major
    look like a lint bump. Take eslint and `typescript-eslint` from that PR and leave
    `typescript` behind; TS 7 is a project of its own.
- **the vendored frontend set** — Leaflet, leaflet.markercluster, leaflet-draw, Cytoscape,
  dagre, html-to-image. These ship as files under `public/`, so a bump is a file copy, not an
  npm operation. See `polaris-ui-canon` → tech-stack-frontend.md.

## The overrides block

`package.json` carries five `overrides` entries — `dompurify`, `qs`, `fflate`,
`@xmldom/xmldom`, `fast-uri` — each a hand-placed floor patching a reachable transitive
advisory. (`@hono/node-server` was removed in 2026-09: Prisma 7.10 stopped shipping the Hono
dev server, so zero paths to it remained and the floor was protecting nothing. That is the
"redundant" case below, and the reason to re-check the block on every Prisma bump.) Dependabot does not know the block exists. A parent bump can make an override
redundant (harmless but misleading) or insufficient (a real hole). Re-verify with
`npm ls <pkg>` before deleting one, and never `npm audit fix --force`. Details:
[dependency-audit.md](dependency-audit.md).

## etcd and Patroni (HA installs only)

**Neither is pinned anywhere in this repo, and that is the finding.** They exist only on an
active/standby HA install (`docs/HA.md`); a single-node Polaris has neither.

| Site | Form | Role |
|---|---|---|
| `deploy/ha/setup-rhel-ha.sh` | `dnf --enablerepo=pgdg-rhel9-extras install -y etcd` | **unversioned** |
| `deploy/ha/setup-rhel-ha.sh` | `dnf install -y patroni patroni-etcd` | **unversioned** |
| `deploy/ha/patroni.yml.example` | `etcd3.hosts` — the API generation, so effectively an etcd 3.x floor | prose |
| `deploy/ha/patroni.yml.example` | written against **Patroni 3.x**; the `on_role_change` callback re-derives the role from the REST API because the vocabulary changed in 4.x | prose |
| `src/data/platformEol.json` | the `etcd` and `patroni` entries — where their lifecycle is tracked, since no pin exists to check | dataset |

There is no equality check to run: with nothing naming a version, nothing can disagree. What
`check:versions` reports instead is an `unversioned-install` warning per install line, every run.
The risk it names is specific — **a primary and a standby built months apart get whatever PGDG
shipped on their build days**, and a version skew across the pair is the likeliest way this
design breaks. etcd compounds it by supporting only the current and previous release branch, so
a host can fall out of support because something newer shipped, with no date to plan against.

Pinning both explicitly is the obvious fix and is **not** done: it is a deployment decision
(which versions, and whether to carry the PGDG repo pin) that wants a human and a real HA pair
to test against. `polarisMinimum` / `polarisTarget` in the dataset are drafted, not decided.

## Family index

The row set `scripts/check-versions.mjs` mirrors. These drift together or not at all.

Site counts move whenever a declaration site is added, so treat them as "roughly this many",
not as a figure to keep in step by hand — `npm run check:versions` prints the live count.

| Family | Agree on | Floor → pin | Warn-only companion |
|---|---|---|---|
| `node-major` | major | 22 → 24 | — (the accept-range gap closed when 24 became the pin) |
| `go-pin` | major.minor | 1.26 → 1.27 | — |
| `nginx-floor` | major.minor | 1.30 | — |
| `postgres-major` | major | 17 | `postgres-source` — quiet since setup-rhel.sh moved to PGDG; plus `units-name-no-postgres`, a hard gate |
| `java-major` | major | 25 | `unversioned-install` — quiet since the Ubuntu scripts named a major |
| `jsign-pin` | major.minor | 7.5 | — |
| `dataset-shape` | n/a | n/a | dataset older than 120 days |
| — (no family: nothing names a version) | n/a | n/a | `unversioned-install` — **loud on purpose**, two lines every run, for etcd and Patroni on an HA install |

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
