# Dependency audit

npm and Go dependencies, and why they are handled differently from platform runtimes.

## Why this is not in the app

npm majors publish no end-of-life dates. There is no calendar to grade a dependency against —
only "a newer major exists" (`npm outdated`, needs the registry) and "there is an advisory"
(`npm audit`, same). Both violate the air-gap requirement the in-app warning is built around.

More decisively: what version of Express a Polaris install runs is fixed by its **build**, not
by its host. Every install of a given Polaris version has the identical answer, so a per-install
runtime check whose result is determined by the build number is a build-time assertion wearing a
monitoring costume — and the operator who would see it cannot act on it. Only the maintainer can.

So: **the platform runtimes are graded in the app; the dependencies are graded in CI and here.**

## The quarterly pass

```
npm run audit:deps          # npm outdated + npm audit --audit-level=high, report only
npm run check:deps          # offline: installed majors vs the recorded targets
cd agent && go list -m -u all
```

`audit:deps` is a **reporting wrapper**, not a fixer: both halves are `|| true` and it always
exits 0. The audit level is a recorded decision rather than a remembered flag, and a non-zero
exit would go permanently red on a repo that has standing accepted advisories.

Read the report against `src/data/dependencyTargets.json`, which records the target major per
package and why anything is held back. Bump what is safe, open a decision for what is not, and
update the file with the new `reviewedAt`.

## Known false signals

**`npm audit` advises downgrading Prisma 7. That advice is wrong.** The flagged
`@hono/node-server` and `@prisma/dev` packages are Prisma 7's **dev-only bundled dev server** —
not in any runtime path — and the suggested "fix" is a major downgrade of the ORM. The standing
rule: never take it. This was assessed in `docs/security/review-2026-06-03.md`, which is a dated
snapshot; cite it for the assessment, do not copy its advisory counts here, because a copied
count looks current forever.

Other advisories that recur and stay non-actionable. These are structural facts about how the
tree is shaped, not a point-in-time count — check the reasoning still holds, but expect them back:

- **`mysql2`** — arrives through Prisma's CLI and dev tooling. **Polaris is PostgreSQL-only**;
  there is no MySQL connection anywhere in the app, so a MySQL auth-plugin or protocol advisory
  is unreachable by construction. It will nonetheless keep showing as high severity and keep
  making `prisma` itself look like a direct high finding.
- **`deepmerge-ts` via `@prisma/config`** — a stack exhaustion reached by merging recursive
  object graphs. Prisma config loading, not a request path.
- **`ip-address` (via `ip-cidr`)** — an XSS in `Address6`'s HTML-emitting methods. Polaris uses
  `ip-cidr` for IP math only and never for HTML emission, so it is not reachable.
- **`hono` / `@hono/node-server`** — Prisma 7's dev-only bundled dev server. Polaris does not use
  Hono at runtime. **Gone as of Prisma 7.10** (2026-09): zero paths to it remain in the lockfile
  and its override was deleted. If it reappears, it is Prisma tooling again, not a new exposure.

The pattern is worth naming: **most of what `npm audit` reports here is Prisma dev tooling**, and
because `prisma` is a direct dependency the aggregate makes the ORM look like the problem. That
is the mechanism behind the false "downgrade Prisma" fix. Judge reachability before severity.

**Never run `npm audit fix --force`.** It is what produces exactly the damage above: it will
happily take a major downgrade to clear a dev-only advisory.

## The overrides block

`package.json` carries seven `overrides`, each a hand-placed floor patching a transitive
advisory. The first five are runtime-reachable; the last two are not, and are floored anyway
for the reason in the second table:

| Override | Why |
|---|---|
| `dompurify` | XSS in the sanitizer reached through `jspdf`, which asks for `^3.3.1` so only a floor moves it (browser-side PDF export) |
| `qs` | `qs.stringify` DoS, reached through Express |
| `fflate` | transitive advisory |
| `@xmldom/xmldom` | reached through the SAML stack — this one is in a runtime auth path |
| `fast-uri` | path traversal / host confusion via percent-encoding, via ajv and Prisma engine tooling |

Both of the following reach the tree ONLY through `prisma`, which is a **devDependency** —
`npm prune --omit=dev` drops the whole subtree, so neither ships in the runtime image:

| Override | Why |
|---|---|
| `mysql2` | GHSA-3f6p-5ww8-9rcr: the client honours a server's auth-plugin switch to `mysql_clear_password`, leaking the plaintext password to a hostile or MITM server. Polaris has no MySQL datasource; the Prisma CLI just bundles every driver it can speak. Floored because `npm audit`'s suggested fix is a **prisma downgrade** — nonsense it will offer again every run |
| `deepmerge-ts` | stack exhaustion on recursive object graphs. `@prisma/config` **exact-pins** `7.1.5`, so an override is the only lever and it forces a major on a pinned transitive of the CLI. The merged graph is our own `prisma.config.ts`, not attacker input |

**Forcing a major on a Prisma-CLI transitive needs a positive test, not a green install.**
`npm install` succeeding proves nothing — `@prisma/config` is what consumes `deepmerge-ts`, and
it only runs when the CLI loads `prisma.config.ts`. Exercise the three paths that do:
`npx prisma generate`, `npx prisma validate`, `npx prisma migrate status` (the last reaches the
loader before it needs a database, so "can't reach database server" is a pass). All three must
still print `Loaded Prisma config from prisma.config.ts`.

Rules:

- **Dependabot does not know the block exists.** A grouped parent bump can make an override
  redundant (harmless, but it accumulates and misleads) or **insufficient** (the parent moved to
  a range the floor no longer covers — a real hole that looks patched).
- Before deleting one, run `npm ls <pkg>` and confirm every path to it already resolves above the
  floor. "The parent bumped" is not the same as "every path bumped".
- When adding one, record the reason in the same commit. An override with no rationale is
  indistinguishable from a mistake six months later.

## The Go module set

Eight modules in `agent/go.mod`, low churn. `go list -m -u all` from `agent/` lists updates;
`govulncheck` is worth running before a release but is not part of the routine pass.

Every agent-side bump implies `agent/VERSION`, a rebuild of every platform binary and a re-sign,
so the review cost dwarfs the bump. That is why Dependabot watches this monthly, not weekly.

`gopsutil` deserves specific attention: it reads OS internals for the sample streams, so a bump
can change what a metric *means* on one platform and not another. Check one Linux and one Windows
agent report sane values before shipping.

**`golang.org/x/sys` cannot be bumped independently of the Go floor, and Dependabot will not
say so.** Its `go` directive tracks the current Go release closely — v0.44.0 requires go 1.25,
v0.48.0 requires 1.26 — so a PR that looks like a one-line module bump silently demands a
toolchain move across all 14 Go pin sites. Dependabot #134 (v0.20.0 → v0.48.0) sat unmergeable
for exactly that reason and became a trivial merge the moment the Go floor reached 1.26. **When
a `golang.org/x/*` PR appears, read the target version's `go` directive first**:
`go mod download golang.org/x/sys@vX.Y.Z` then read `go` out of
`$(go env GOMODCACHE)/cache/download/golang.org/x/sys/@v/vX.Y.Z.mod`. There is no intermediate
version to retreat to — the lowest release carrying a given fix already carries its go directive.

**Cross-compile all six targets after any x/sys bump** — it *is* the syscall layer, so it can
build on the host GOOS and fail on another: `GOOS=… GOARCH=… go build ./...` over
linux/darwin/windows × amd64/arm64.

## Dependabot

`.github/dependabot.yml`, four ecosystems.

**A full PR cap silently blocks SECURITY updates too.** npm is `open-pull-requests-limit: 5`, and on 2026-09-09 all five slots were held by open version-update PRs — so `nodemailer` (4 alerts, one high) and `js-yaml` (1 high) had open Dependabot **alerts with no PR attached**, which reads exactly like Dependabot having nothing to say about them. If an alert has no PR, count the open PRs before concluding anything. Merging the backlog is what unblocks it; hand-bumping is faster.

**Dependabot is not a superset of the other scanner, and vice versa.** Aikido's SCA findings carry `AIKIDO-*` ids from its own advisory database rather than GHSA/CVE, so Dependabot reports none of them (in that same pass: `ws`, `pg`, `pg-connection-string`, `jose`, `zod`, `undici`, `dompurify`, `fast-copy`, `raw-body`). Aikido was in turn silent on the dev-only ones Dependabot caught. Read both feeds.

**npm at `/`**, weekly, grouped:

| Group | Contents | Why grouped |
|---|---|---|
| `prisma` | `prisma`, `@prisma/client`, `@prisma/adapter-pg` | one version; any one merged alone breaks the build |
| `typescript-toolchain` | `typescript`, `typescript-eslint`, `eslint` | move together or lint breaks |
| `vitest` | `vitest`, `@vitest/coverage-v8`, `happy-dom`, `supertest` | coverage must match the runner version |
| `types` | `@types/*` **except `@types/node`** | `@types/node` is a Node-pin family member |
| `prod-minor-patch` / `dev-minor-patch` | everything else, minor and patch only | volume control |

Majors are **ignored** for the architectural set (express, the Prisma trio, zod, pg, pg-boss,
undici, multer, pino) and for `@types/node`. An ignored major is not invisible — the playbooks
and the quarterly `npm outdated` catch it — whereas an un-ignored one becomes a PR that sits open
forever and trains everyone to ignore Dependabot.

**gomod at `/agent`**, monthly, limit 3. See above.

**github-actions at `/`**, weekly, one grouped PR. The pinned `actions/*` set rots invisibly.
Expect this to **not** touch `node-version` — that is a Node pin and belongs to `check:versions`.

**Every `uses:` is pinned to a 40-hex commit SHA with the version in a trailing comment**
(`actions/checkout@3d3c42e5… # v7.0.1`), never to a tag — since 2026-09. A tag is mutable, and
`docker-publish.yml`'s build job holds `packages: write` + `id-token: write`, which is enough to
publish a provenance-signed image under our own name; whoever controls an action's repository
could re-point `v4` at new code and reach that. Dependabot understands the SHA-plus-comment form
and rewrites both halves, so this costs nothing to keep current — but **a PR that replaces a SHA
with a bare tag is a regression, not an update.** Resolve a new pin from the release tag, e.g.
`gh api repos/<owner>/<action>/tags --jq '.[] | select(.name=="v7.0.1") | .commit.sha'`.

The same workflow refuses to build a `v*` **tag that is not reachable from the default branch**.
Branch protection does not cover tag creation, so without it anyone with write access could tag
an unreviewed commit and have it published and attested. The check asks the API
(`repos/…/compare/<default>…<sha>`, accepting only `identical` or `behind`) rather than doing a
local `git fetch`, because the checkout deliberately keeps no credentials to fetch with.

**docker at `/`**, weekly, with **node majors ignored**. Dependabot reads Dockerfile `FROM` lines
and would otherwise offer `node:24-trixie` → the next major: a whole-family platform bump
disguised as a one-line PR. Ignoring the major turns it into a useful "20.x moved" signal instead
of a trap. It will not touch the compose files, which use floating tags it could not bump anyway.

## Triage

A Dependabot PR that touches a **pin family** member is not mergeable on its own — it is one site
of many. Close it and do the bump properly through
[version-pin-inventory.md](version-pin-inventory.md), or the other twenty-two sites stay behind.

Everything else: read the changelog, check it is not in the ignored architectural set, let CI
run, and merge. `npm run check:versions` and `npm run check:deps` both run in CI, so a PR that
breaks a family or drops a major below its recorded target fails there.

## A major an `npm outdated` row cannot actually deliver: the vendored set

`cytoscape-dagre` sits in `devDependencies` at **2.5.0** while the registry is on **4.0.1**, and
that is not neglect. The file that runs is `public/js/vendor/cytoscape-dagre.js` — a byte copy of
`node_modules/cytoscape-dagre/cytoscape-dagre.js`. Bumping the npm range alone changes **nothing
at runtime**; it only makes the recorded version disagree with the file, which is worse than
being behind.

Doing it properly means copying the new dist into `public/js/vendor/` and re-checking the page,
and for this package v4 also changes the wiring: 2.5.0's UMD takes `dagre` as a factory argument
(hence the separate `public/js/vendor/dagre.min.js` global), while 4.x bundles it and its factory
takes none. So `dagre.min.js` stops being cytoscape-dagre's dependency, and whether it can be
deleted depends on who else reads that global.

It was left at 2.5.0 in the 2026-09-09 pass for that reason: the layout it drives is the
Application Map (`public/js/appmap.js` runs `layout({ name: "dagre", … })`), which is a real page
whose output has to be *looked at*, not a fallback that can be reasoned about. Do it as a UI
change with the page open — `polaris-ui-canon` → tech-stack-frontend.md — not as part of a
dependency sweep.

The same holds for the rest of the vendored set: Leaflet, leaflet.markercluster, leaflet-draw,
Cytoscape, dagre, html-to-image.

## What is deliberately not automated

- **No scheduled `npm audit` workflow.** It would be red on day one and stay red, owned by
  nobody. Dependabot already produces reviewable PRs on a schedule.
- **No auto-merge**, even for patches. The `overrides` interaction above is exactly the kind of
  thing that needs eyes.
- **No dependency count on the Maintenance tab.** The operator seeing it cannot act on it.
