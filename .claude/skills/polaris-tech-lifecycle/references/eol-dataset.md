# The EOL dataset

`src/data/platformEol.json` — what Polaris knows about when its stack stops receiving fixes.
This file is the seam between this skill and the in-app warning: **the skill writes it, the app
only reads it.**

## Where it lives, and why there

Under `src/data/`, read with `readFileSync` on an `import.meta.url`-relative path, the same
pattern the bundled standard MIBs use.

That placement carries one non-obvious obligation: **it needs an entry in the `ASSETS` array of
`scripts/copy-build-assets.mjs`.** `tsc` emits only `.js` and `.d.ts` and silently ignores data
files, and the Docker runtime image ships only `dist/` with no `src/`. Without the copy entry,
`npm run dev` (tsx, reading straight from `src/`) looks perfect while every built install and
every container shows an empty Platform Lifecycle card. That is a production-only failure, which
is exactly the class of bug the copy script exists to prevent. Its `copied === 0` tripwire does
not help here — the MIBs keep the counter non-zero.

Rejected alternatives, recorded so nobody re-litigates them:

- **A JSON `import`.** `tsconfig.json` has no `resolveJsonModule`; enabling it changes
  program-wide resolution for a repo this size, and whether `tsc` emits the JSON into `outDir`
  is version-dependent — which is the failure that matters, because the container ships only
  `dist/`.

  One leg of this argument has expired and is recorded so the reasoning stays honest: the
  original rejection also leaned on import attributes, since the `with` form landed in Node
  20.10 while the `assert` form it replaced was removed in 22, leaving no single spelling that
  ran across a `>=20` range. With the floor now at 22.12 that is no longer true — `with` works
  everywhere we support. The `resolveJsonModule` and emit objections stand on their own, so the
  decision is unchanged, but a future revisit should weigh only those two.
- **Somewhere under `docs/`.** `copy-build-assets.mjs` only mirrors `src/<dir>` → `dist/<dir>`,
  so anything outside `src/` would simply be absent in a container.

## Schema

Top level: `schemaVersion`, `reviewedAt`, `reviewedBy`, `sourceNotes`, `technologies[]`,
`playbooks[]`.

Each technology:

| Field | Meaning |
|---|---|
| `id` | stable key, and the id the app's probe reports under (`node`, `os:rhel`) |
| `label` | what the card shows |
| `kind` | `runtime` / `database` / `extension` / `toolchain` / `proxy` / `os` / `library` |
| `trackGranularity` | `major` or `major.minor` — vendors disagree, so it is per technology |
| `policy` | `dated` (real EOL dates), `compat` (a compatibility horizon, no dates), `none` (vendor publishes nothing) |
| `securityExposed` | true for network-reachable, unpatchable surfaces. Drives whether an EOL grades critical or warning |
| `polarisMinimum` | below this, the install is misconfigured — always critical |
| `polarisTarget` | what Polaris wants you on. **Needs an operational reason to sit above `polarisMinimum`** — a newer version merely existing is not one. Anything below it grades `behind_target` on every install, forever, so an unjustified target is permanent noise. Set it equal to the minimum when the honest answer is "stay put"; the EOL clock will raise `aging` on its own when the time comes. Java briefly targeted 21 on no better grounds than 21 being newer, and made every healthy install report a behind-target JDK |
| `polarisMaximumTested` | above this, `ahead_of_tested` (a watch, not a problem) |
| `upgradePlaybook` | id into `playbooks[]` |
| `source` / `sourceCheckedOn` / `confidence` | the provenance a human recorded |
| `tracks[]` | `{ track, released, eol, activeSupportEnds?, extendedSupport?, lts?, prerelease?, note? }` |

`eol: null` means "still supported, no announced date" — different from a missing `eol`, and
different from `policy: "none"`.

Each playbook: `{ id, title, docAnchor, risk, steps[], files[] }`. `files[]` is the lockstep
list — every path that must move together — and `check:versions` asserts each one exists,
because a playbook that sends you to a missing file is worse than no playbook.

## The boundary with the app

Three separate concerns, and mixing them is the main way this goes wrong:

- **This dataset** holds *EOL facts keyed by (technology, track)*. Nothing install-specific.
- **The app** answers *what is actually running here* — Node from the process, PostgreSQL from a
  `SHOW server_version`, the extension from `pg_extension`, Go from the build service's
  preflight, the OS from `os-release`, nginx from `nginx -v`. It grades observed against this
  file and never writes back.
- **`scripts/check-versions.mjs`** answers *what is pinned in the repo*. Also never writes here.

Adding a field is therefore a two-side change: the schema here, and the reader in the app.

## Authoritative page per family

Prefer the vendor page. `endoflife.date` is an aggregator — convenient, usually right, and
occasionally stale — so anything taken from it gets `confidence: "aggregator"`.

| Family | Where the truth is |
|---|---|
| Node.js | the Node release schedule (nodejs/Release) — even majors go LTS, odd ones never do |
| PostgreSQL | the PostgreSQL versioning policy page — five years, dying each November |
| TimescaleDB | the Timescale self-hosted upgrade docs — a PG-compatibility statement, not a date |
| Go | the Go release policy — only the two most recent majors |
| nginx | nginx.org — odd minors mainline, even minors stable |
| RHEL | the Red Hat Enterprise Linux life cycle page — note Full vs Maintenance Support |
| Ubuntu | the Ubuntu release cycle page — standard support vs Pro/ESM |
| Debian | the Debian LTS wiki — the LTS window is a volunteer project, not the security team |
| Java | the Microsoft Build of OpenJDK support page — that is what the scripts install, and its dates can differ from Oracle's and Temurin's for the same major |
| Windows Server | the Microsoft product lifecycle pages |
| etcd (HA only) | `etcd.io/docs/*/op-guide/versioning/` states a RULE, not dates — "the current version and previous release", so a branch dies when a newer one ships. Dates therefore come from endoflife.date, which is why the entry is `policy: "compat"` with `confidence: "aggregator"` even though the policy itself was read from the vendor |
| Patroni (HA only) | nothing to read. The docs and GitHub carry release notes and a supported-PostgreSQL matrix but **no supported-version or end-of-life policy** — hence `policy: "none"`, and `confidence: "aggregator"` rather than implying a vendor read of a policy that does not exist |

**etcd and Patroni are the exception to the refresh procedure's "four things".** A new technology
normally needs a family in `scripts/check-versions.mjs` as well, and these two deliberately have
none: both are installed unversioned (`dnf install -y etcd`, `dnf install -y patroni
patroni-etcd` from PGDG), so no file names a version and a pin family would have nothing to
compare. They get an `unversioned-install` warning apiece instead — see
[version-pin-inventory.md](version-pin-inventory.md) → *etcd and Patroni*. Do not "finish the
job" by inventing a family; pinning them explicitly is a deployment decision that wants a human
and a real HA pair. Their `polarisMinimum` / `polarisTarget` are also still marked DRAFT in the
dataset notes for that reason.

## How to verify a date

1. Open the family's vendor page and read the row for the track. Do not infer a date from a
   blog post or a release announcement.
2. Record the URL you actually read in `source` and today's date in `sourceCheckedOn`. If you
   only got it from an aggregator, say so with `confidence: "aggregator"` rather than implying a
   vendor read.
3. When a vendor states a rule instead of a date ("five years after release", "the two most
   recent majors"), compute the date and put the rule in `notes` so the next refresh can check
   the arithmetic.
4. If a track has no announced EOL, use `eol: null`. Never invent a plausible date — a wrong
   date either cries wolf, which trains operators to dismiss the banner, or hides a real
   end-of-life. Both are worse than an honest "unknown".

## The refresh procedure

Quarterly, plus on any version bump, plus before any named release.

1. Start a worktree and write `WORKLOCK` (the standard session workflow).
2. For each technology, re-read its `source`. Only `eol`, `activeSupportEnds`, `latestPatch` and
   `sourceCheckedOn` change without a deliberate decision — moving `polarisMinimum` or
   `polarisTarget` is a project decision, not a refresh.
3. Add newly released tracks. Remove nothing: a track that is long dead is still the right
   answer for a host that is running it.
4. Bump the top-level `reviewedAt` (the app shows its age, and `check:versions` warns past 120
   days).
5. A **new** technology needs four things, not one: the dataset entry, a row in
   [version-pin-inventory.md](version-pin-inventory.md), a playbook, and a family in
   `scripts/check-versions.mjs`.
6. Run `npm run check:versions` and the dataset unit test.
7. Review the diff **per file** before committing — CRLF flips land silently and a stray NUL
   byte makes git treat a text file as binary. `.gitattributes` pins `src/data/*.json` to LF for
   exactly this reason.
8. Commit on its own: `chore(lifecycle): refresh EOL dataset (checked YYYY-MM-DD)`.

## Human review

**The refresh commit is never merged unreviewed.** These dates are operator-facing, drive
production change windows, and may drive budget requests. A wrong date fails in both directions
— crying wolf costs the credibility of the warning, hiding an EOL costs the thing the feature
exists to prevent.

Claude drafts the dates and the playbooks. A human confirms them, and a human decides the
upgrade schedule.
