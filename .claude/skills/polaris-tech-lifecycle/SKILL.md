---
name: polaris-tech-lifecycle
description: "Version lifecycle of the Polaris tech stack: the committed end-of-life dataset and its refresh procedure, the version-pin inventory (every Node / PostgreSQL / TimescaleDB / Go / nginx / Java / OS / npm-major pin and the file it lives in, as a lockstep table), one ordered upgrade playbook per technology with its blast radius, the check:versions pin-consistency guard, and the npm + Go dependency-audit procedure. Load when a task says EOL, end-of-life, end of support, supported until, minimum version, unsupported, version pin, outdated dependency, npm audit, npm outdated, dependabot, code scanning, CodeQL, security alert, scanner finding, Aikido, overrides, or upgrade/bump a runtime — Node 22 to 24, PostgreSQL 17 to 18, Go 1.26/1.27, Prisma 7, Express 5, TimescaleDB, nginx stable, RHEL 9, Ubuntu 24.04, node:24-trixie, latest-pg17 — and whenever a change edits engines.node, agent/go.mod, a version pin in a Dockerfile or a deploy/setup-* script, an image tag in a compose file, or node-version in a workflow."
---

# Polaris tech-stack lifecycle

Polaris pins the same handful of technologies in a dozen places at once. A Node major is
declared in `package.json`, both Dockerfiles, six `deploy/setup-*` scripts, two workflow files
and four operator docs — 23 declaration sites for one number. Until this skill existed nothing
cross-checked them and nothing recorded when a pinned version stops receiving security fixes,
so a bump could land in nine sites of twelve and the tenth would keep provisioning the old
runtime on every fresh host.

This skill owns both halves: **the committed end-of-life dataset** and **the pin inventory**
that turns a major bump from a grep hunt into a checklist. Run `npm run check:versions` to see
today's drift before touching any pin; read the inventory before editing one.

The dataset is `src/data/platformEol.json` — human-reviewed, refreshed by *this skill* on a
session, and never fetched at runtime, because an air-gapped install must still warn correctly.
Every date in it is true only because a human read a vendor page and recorded the URL. The
in-app Platform Lifecycle card reads it and never writes it; refreshing it is a task, not a job.

## Which file

| You need… | Read |
|---|---|
| every version pin in the repo and the sites it must move with, per family | [references/version-pin-inventory.md](references/version-pin-inventory.md) |
| ordered steps + blast radius for a platform major — Node, PostgreSQL, TimescaleDB, OS, nginx, Java | [references/upgrade-playbooks-platform.md](references/upgrade-playbooks-platform.md) |
| ordered steps + blast radius for a library major — Prisma, Express, the Go pin, the Go module set, the vendored frontend libs | [references/upgrade-playbooks-libraries.md](references/upgrade-playbooks-libraries.md) |
| where the EOL dataset lives, its schema, the authoritative upstream page per family, how to verify a date, the refresh procedure and the human-review rule | [references/eol-dataset.md](references/eol-dataset.md) |
| the quarterly dependency pass — `npm outdated`, `npm audit` and its known false signals here, the `overrides` block, the Go modules, how Dependabot is grouped | [references/dependency-audit.md](references/dependency-audit.md) |
| triaging a scanner finding — the four feeds (Dependabot, CodeQL, `npm audit`, Aikido), why none is a superset, and the two traps: `auto_dismissed` alerts, and a false positive that hides a true one | [references/dependency-audit.md](references/dependency-audit.md) |
| the pin-consistency guard — every rule, the warn-only checks, how to add a family or a new deploy script | [references/pin-consistency-check.md](references/pin-consistency-check.md) |
| the deploy surfaces a bump lands on, and the pre-push audit | `/polaris-deploy` → cross-cutting-deployment.md |

## Runbooks (symptom → file)

| Symptom | Runbook |
|---|---|
| `npm audit` says to downgrade Prisma, or `audit fix --force` wants to rewrite the tree | [references/dependency-audit.md](references/dependency-audit.md) |
| `npm run check:versions` fails after adding a deploy script or a workflow | [references/pin-consistency-check.md](references/pin-consistency-check.md) |
| "missing go.sum entry" or a compiler error from the in-app agent build on a fresh host | [references/version-pin-inventory.md](references/version-pin-inventory.md) → Go |
| the in-app EOL warning fires on a date nobody recognizes, or says the dataset is stale | [references/eol-dataset.md](references/eol-dataset.md) |
| a fresh RHEL install comes up with a Postgres the shipped units won't accept | [references/version-pin-inventory.md](references/version-pin-inventory.md) → PostgreSQL |

## Invariants

- **The dataset is evidence, not truth.** Every entry carries the `source` a human read and the
  `sourceCheckedOn` date they read it, plus `confidence` (`vendor` or `aggregator`). No runtime
  fetch of a third-party feed, ever — the warning must work on an air-gapped install.
- **One pin family, one commit.** A Node major moves in `package.json` (`engines.node` *and*
  `@types/node`), both Dockerfiles, all six setup scripts, both workflow files, `docs/INSTALL.md`,
  `README.md` and the `CLAUDE.md` tech-stack row together — or one install path silently keeps
  provisioning the old runtime. `npm run check:versions` is what proves you got them all.
- **A doc claim is a declaration site, not commentary.** The per-platform `Node.js 24 (LTS)`
  headings in `docs/INSTALL.md`, its Supported platform versions table, both `README.md` tables
  and the `CLAUDE.md` tech-stack row are part of the family and are checked.
- **A family has two numbers: a floor and a pin.** Node is `>=22.12` in `engines.node` but 24 in
  every Dockerfile and install script, on purpose — claiming 24 as the floor would lock a host
  running a perfectly good 22 out of its next update. `check:versions` asserts floors agree with
  floors, pins with pins, and floor <= pin; it never demands one number.
- **`engines.node` is advisory.** There is no `.npmrc` with `engine-strict=true`, so npm warns
  and installs anyway. The setup scripts' accept-regexes are the only real gate, and they accept
  a *range* (22 or 24) while every pin installs 24.
- **Windows is the tightest pin and goes stale first.** The Windows setup scripts hard-pin an
  exact Node build, an exact Go version, `PostgreSQL.PostgreSQL.<major>` and
  `Microsoft.OpenJDK.<major>`, while the Linux scripts accept ranges. A stated "Node 24" is
  therefore false on Windows past the pinned patch, and the day a pinned runtime goes EOL those
  scripts keep installing it on every fresh host with nothing objecting.
- **A winget pin can fail silently, because the MSI download is the `else` branch.** `--version`
  must name a version that channel actually has (`OpenJS.NodeJS.LTS` lagged nodejs.org by two
  minors on 2026-09-09), and the package id must exist at all — `--id GoLang.Go.1.22` named a
  package winget does not publish, so on every host WITH winget the Go install failed and the
  fallback never ran. Check the manifest list before pinning.
- **The PostgreSQL unit name is a host fact and must never be in a shipped unit.** Both update
  paths overwrite `deploy/polaris-*.service` verbatim, so a major written there is re-asserted
  onto every host at every update — including hosts where that unit does not exist. It lives in
  a per-host `20-postgres.conf` drop-in; `check:versions` fails if it creeps back.
- **No unversioned install is left UNGUARDED, and that is load-bearing.** An unversioned package
  name has no number for the equality check to compare, so it drifts per host, silently, in
  exactly the place the guard exists to watch — and every instance had bitten by 2026-09-09:
  AppStream PostgreSQL 13 on RHEL, the 14/16 `postgresql` metapackage on Ubuntu,
  `default-jre-headless` giving Java 17 on one LTS and 21 on the other, and the same in the
  Dockerfile. All of those now name a version. The one that stays unversioned is `golang-go`,
  deliberately: it is followed immediately by a `go version` re-check against the accept-regex
  and a snap fallback, so the version is enforced even though the package name carries none.
  That is why `check:versions` skips it rather than reporting it.
- **`GO_MINIMUM` is the single source of truth for the Go floor** in
  `src/services/agentBuildService.ts` — the preflight and every operator-facing copy string
  interpolate it. `goAvailable()` historically only checked that `go version` *ran*, so a host
  with an older toolchain passed and failed later inside `go build`.
- **Floating tags hide drift.** `compose.dev.yml` uses a `latest-pg<major>` tag and
  `docker-compose.yml` uses `nginx:stable` and a `:latest` app image. The checker can assert
  the major those imply and nothing more; dev and the reference stack move under you.
- **CI exercises no TimescaleDB.** The publish workflow runs a plain `postgres` service
  container, so hypertable, chunk and compression paths get no CI signal at all. A PostgreSQL or
  TimescaleDB bump needs a manual smoke against a dev stack — a green CI run proves nothing here.
- **`overrides` in `package.json` is a hand-maintained CVE patch set.** Dependabot does not know
  it exists, and a parent bump can make an override redundant or insufficient. Re-verify with
  `npm ls <pkg>` before deleting one; never run `npm audit fix --force`.
- **Bumping the Go pin also moves `agent/VERSION` and the committed resource files.** That
  rebuild contract has exactly one home — `polaris-agent` → cross-cutting-polaris-agent.md. This
  skill lists the pin sites and routes there; it does not restate the contract.
- **Grade "below Polaris's minimum" separately from "upstream EOL".** The first is a
  misconfiguration of one install, fixable with a package command, and is critical. The second is
  a risk that accrues for months and clears only in a maintenance window — it is capped at
  warning on purpose, so the non-dismissible alert keeps meaning "act now".

Related: `polaris-deploy` (the deploy surfaces a bump lands on, and the pre-push audit),
`polaris-agent` (the Go pin ↔ VERSION ↔ resource-file lockstep, and the jsign pin),
`polaris-monitoring-discovery` (the chunk-bloat runbook, before any TimescaleDB move),
`polaris-change-impact` (the Prisma client lifecycle, before a Prisma major),
`polaris-docs-sync` (the commit-time review).
