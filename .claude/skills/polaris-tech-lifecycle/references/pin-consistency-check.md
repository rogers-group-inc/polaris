# The pin-consistency guard

`scripts/check-versions.mjs`, run as `npm run check:versions`.

## What it is

A hard gate that reads every version declaration site in the repo and asserts each family
agrees. Pure file reads — no npm, no network, no database — so it runs in CI with no install and
finishes in milliseconds, the same discipline as `scripts/check-docs.mjs`.

It exists because a bump can land in nine sites of twelve and the tenth keeps provisioning the
old version on every fresh host, silently, until someone rebuilds a box. Nothing else in the
repo could catch that.

It is **not** folded into `check:docs`: two concerns want two exit codes, so either can be
bypassed on its own when that is genuinely the right call.

## What it reads

`package.json`; `agent/go.mod`; `agent/Makefile`; `Dockerfile` and `Dockerfile.dev`;
`deploy/setup-*.sh` and `deploy/setup-*.ps1` **by glob**; the shipped `deploy/polaris-*.service`
units **by glob**; `compose.dev.yml`; `docker-compose.yml`; `.github/workflows/*.yml` **by
glob**; `docs/INSTALL.md`, `README.md`, `CLAUDE.md`; and `src/data/platformEol.json`.

Globs rather than enumerated lists, so a new setup script or workflow is in scope the moment it
lands.

## The model: floors and pins

Each family declares the granularity it must agree on (`major` or `major.minor`), its sites, and
a minimum site count. Every site also carries a **role**:

- **floor** — the minimum the repo requires (`engines.node`, `@types/node`, the accept-checks,
  `NODE_MINIMUM_MAJOR`, a docs minimum column).
- **pin** — what it actually installs (the Dockerfiles, winget/MSI, a module stream, CI's
  `node-version`). This is the default for anything not marked `accept-range`.

The checker asserts **floors agree with floors, pins agree with pins, and floor ≤ pin.** It does
not demand one number per family.

That last point was learned the hard way. The first version asserted a single number, and the
moment Node became 22-floor / 24-pinned it reported a false failure listing 26 sites. There is no
correct single number there: claiming 24 as the floor would lock a host on a perfectly good 22
out of its next update via npm's engine warning, and claiming 20 would be a lie about what the
dependency tree needs. A checker that forces a choice between lying in `engines.node` and lying
in the Dockerfile is worse than no checker, because the way out is to disable it.

**The operator-facing table is a declaration site too.** `docs/INSTALL.md`'s *Supported platform
versions* table is the canonical list humans read, and nothing kept it in step with the dataset
until `dataset-docs-mirror` existed. That gap produced the same bug twice in one day: the table
went on saying Node's minimum was 20 after the bump to 22, and went on saying Java targeted 21
after that target was dropped to 17. Both were caught by someone reading carefully, which is not
a mechanism. Only `dated` technologies are compared — TimescaleDB, Windows Server and PgBouncer
state prose in those columns deliberately, having no dated lifecycle to mirror.

**A comment is not a declaration site.** Whole-line comments are stripped before matching.
`setup-rhel.sh` explains its module reset with "nodejs:20 fails with cannot enable multiple
streams otherwise" directly above `dnf module enable -y nodejs:24`, and matching that comment
made the family look self-inconsistent. Trailing comments on a line that also carries a real
declaration are kept, so `node-version: 24  # bumped 2026-09` still reads as 24.

## Rules

| Rule | Asserts | On failure |
|---|---|---|
| `node-major` | the Node floors agree, the pins agree, and floor ≤ pin | fail |
| `go-pin` | `agent/go.mod`'s directive matches every accept-regex floor, both winget ids, both MSI URLs and the prose | fail |
| `nginx-floor` | the Linux accept-regex floor matches the documented `≥` claim | fail |
| `postgres-major` | one major across the units, the Windows installer/service/NSSM trio, the image tags and the docs | fail |
| `java-major` | the JDK major agrees across the Dockerfile, the RHEL package and the Windows winget id and MSI URL | fail |
| `jsign-pin` | the jsign version agrees across the Dockerfile URL and every setup script's `JSIGN_VERSION` | fail |
| `dataset-shape` | `src/data/platformEol.json` parses; every technology has `source` and `sourceCheckedOn`; every `upgradePlaybook` resolves; every playbook `files[]` entry exists on disk; every checked family has a dataset entry | fail |
| `dataset-docs-mirror` | the **Supported platform versions** table in `docs/INSTALL.md` states the same minimum and target as the dataset, for every `dated` technology, and has a row for each of them | fail |

Two structural guards that matter as much as the equality check:

- **A family whose patterns match nothing fails.** Otherwise a renamed pin would silently police
  zero sites and the checker would report success forever.
- **A family below its `minSites` floor fails**, naming the shortfall — that is what catches a
  new `deploy/setup-<distro>.sh` that declares no Node pin.

## Warn-only checks

These are real problems, but fixing each is a **behaviour decision for a human**, not a drift fix
a checker should force. Warning keeps them visible without making the gate un-passable.

| Check | What it reports |
|---|---|
| `node-major` extra | The install scripts accept a Node major that nothing installs, so a host that already has it is accepted and never tested. Quiet since the 2026-09 bump made 24 both the accepted ceiling and the pin; it fired for the whole time the scripts accepted 22 while every pin was 20. |
| `postgres-source` | A RHEL setup script installing unversioned AppStream `postgresql-server`, which yields `postgresql.service` while the units the same script installs require `postgresql-15.service`. **Quiet since 2026-09-09**, when setup-rhel.sh moved to the PGDG path `docs/INSTALL.md` had documented all along — AppStream package names also cannot satisfy `timescaledb-2-postgresql-15`. |
| `unversioned-install` | A site that installs a distro default instead of a named version, so there is no number for the equality check to compare. **Quiet since 2026-09-09**, when both Ubuntu scripts moved to `openjdk-17-jre-headless` (`default-jre-headless` is Java 17 on 22.04 and 21 on 24.04, so two supported hosts signed agent binaries with different majors). Skipped when the same file also runs a versioned install: that makes the unversioned one a deliberate fallback, which is logged at install time rather than silent. That pairing test matches the install COMMAND, not the package name — a bare-name regex went quiet twice on a host with no pin, first on the comment explaining the fallback and then on the `info` line reporting it. |
| `dataset-shape` staleness | `src/data/platformEol.json` last reviewed over 120 days ago. |
| floating tags | Informational list of tags that move under you (`latest-pg15`, `nginx:mainline`, `:latest`) and therefore cannot be pin-checked. |

Note the Go installs *look* unversioned (`dnf install -y golang`, `apt-get install -y golang-go`)
but are deliberately guarded — RHEL enables the `go-toolset` module stream first, Ubuntu
re-verifies `go version` and falls back to snap. They are excluded from `unversioned-install` by
name and with a reason, because a checker that cries wolf gets ignored, which is the exact
failure this guard exists to prevent.

Two of these checks have now gone *quiet* wrongly rather than loud wrongly, both by matching a package name in prose — once in a comment, once inside a log string. A false silence is the worse failure of the two: a warning you can dismiss, but a check that reports success while the thing it guards is broken actively misleads. When adding a rule, match the command, not the noun.

## Deliberately not rules

- **The CI-has-no-TimescaleDB gap.** A standing truth, not drift. A check that can never pass is
  noise; it lives in the skill's invariants and the Postgres and TimescaleDB playbooks instead.
- **The app-side Go minimum.** `GO_MINIMUM` is enforced by code with a test, which is stronger
  than a text match.
- **Floating tag contents.** There is no number to compare, only a promise.

## Output and exit codes

Warnings first, then the informational floating-tag list, then either the failure block or the
success summary. Failures print `[rule-id]` and then **every site and its value**, two columns,
so the fix is mechanical rather than another grep hunt.

Exit **0** on pass, including pass-with-warnings. Exit **1** on any failure. `--json` emits the
whole result — `{ ok, failures, warnings, families, floating }` — for machine consumption.

**The app must never shell out to this script.** The app reads the dataset; the checker reads the
repo. Different questions, and one of them is not available on a built install anyway.

## Adding a site, a family, or a deploy script

- **A new declaration site in an existing family** — add it to that family's `sites`. If it is in
  a globbed directory it may already be covered; run the checker and see whether the site count
  went up.
- **A new deploy script** — nothing to do, the glob finds it. If it legitimately declares no pin
  for some family, the `minSites` failure will name it; add it to that family's `skip` with a
  reason.
- **A new family** — four things, not one: the family in the script, a section in
  [version-pin-inventory.md](version-pin-inventory.md), a row in that file's `## Family index`
  table, and an entry in [eol-dataset.md](eol-dataset.md)'s dataset if it is something that goes
  end-of-life.
- **An accepted divergence** — add it to `ALLOW` with a real reason and the decision it defers.
  The list is empty today; keep it that way by fixing drift rather than allow-listing it.

Accept-range sites collapse to their **floor**: `[[ node -v == v20* || == v22* ]]` declares a
requirement of 20 and a tested ceiling of 22, which are two different questions. The floor goes
to the equality check; the ceiling goes to the warning.

## Where it is wired

- `npm run check:versions` — the manual entry point.
- `.githooks/pre-commit` — a second arm with a narrower staged-file filter than the docs check
  (`package.json`, `agent/go.mod`, `Dockerfile*`, `deploy/*`, compose files, workflows, the
  dataset, or the checker itself). A version check on a pure-UI commit is only latency.
- `.github/workflows/check-docs.yml` — a step in the existing structural-guard job, which
  already runs without `npm install`. Both guards then fail in the same place.

No scheduled run: the checker is deterministic over the tree, so a timer cannot discover
anything. The only time-dependent part is dataset staleness, which surfaces as a warning on
every run and, for operators, as the review-age line on the in-app card.
