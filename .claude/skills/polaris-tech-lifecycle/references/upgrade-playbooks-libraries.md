# Upgrade playbooks — libraries

Library majors are **upgrade debt, not end-of-life risk**: npm packages publish no EOL dates, so
there is no calendar to grade them against. That is why they are ignored in Dependabot and
checked in CI rather than warned about in the app — see [dependency-audit.md](dependency-audit.md)
for where each mechanism sits.

## Prisma major

**Risk: high.** The ORM is in every write path.

Read `polaris-change-impact` → cross-cutting/schema-migrations-and-prisma-client-lifecycle.md
first; it owns the migration and client-generation contract and this file does not restate it.

### Order
1. Bump `prisma`, `@prisma/client` **and** `@prisma/adapter-pg` in one commit. They are one
   version; merging any of the three alone breaks the build.
2. `npx prisma generate`, then `npm run typecheck`. The generated client lives under
   `src/generated/` and is gitignored, so every checkout and every build regenerates it via
   `postinstall` — a stale client is the usual cause of a wall of implicit-`any` errors.
3. Replay every migration against a scratch database from empty.
4. Run the integration suite against a real Postgres.

### Blast radius
The driver adapter is the fragile part: connection handling, pooling and PgBouncer behaviour are
adapter-level concerns, so a major can change pool semantics without any type error. Watch
connection counts at fleet scale, not just correctness at one asset.

### Traps
- **Ignore `npm audit`'s advice to downgrade the Prisma major.** It has advised exactly that
  here, and it is wrong; the standing rule is in [dependency-audit.md](dependency-audit.md).
- Never run `prisma generate` through a directory junction into another worktree — it overwrites
  that tree's client with this branch's schema.

## Express major

**Risk: high**, and it has already broken production once.

### Order
1. Read the Express migration guide for the target major, specifically routing and error handling.
2. Bump, then run `tests/unit/routerBoots.test.ts` **first** — it exists because of this.
3. Re-check every middleware ordering assumption: helmet, session, CSRF, rate limiting.

### Blast radius
Routing syntax is validated at **boot**, not at request time, so a bad route pattern takes the
whole process down rather than failing one endpoint. The `:param(regex)` form throws on Express 5
and crashed production once; the router-boot test is the guard, and it must stay in the suite.

## The Go pin

The pin sites are in [version-pin-inventory.md](version-pin-inventory.md) → Go, and the ordered
steps are in the dataset's `go-pin` playbook. Two things belong here:

- **`GO_MINIMUM` in `src/services/agentBuildService.ts` is the number the app enforces.** Bump it
  with the pin, so the preflight and every operator-facing copy string move together instead of
  drifting into a claim nothing checks.
- **The rebuild contract is `polaris-agent`'s.** Bumping the `go` directive also moves
  `agent/VERSION` and the committed Windows resource files, and the fleet's upgrade check
  compares against that version. Route there; do not restate it. Note the 2026-09-09 floor move
  deliberately did **not** touch `agent/VERSION`: a toolchain bump is not an agent release, and
  moving the version tells every enrolled agent an upgrade is waiting. Rebuild when you mean to.
- **Check what each platform can actually install before choosing the floor.** Since 2026-09-09
  this family has a floor AND a pin (1.26 → 1.27) for that reason: no Linux path can install
  1.27 — the RHEL `go-toolset` module carries 1.26.7 and the Go snap's newest channel is
  `1.26/stable` — while the Windows scripts pin the newest winget has a manifest for. Neither
  Ubuntu LTS reaches the floor from its own archive at all, so the snap fallback is the branch
  that runs there. A floor above what a platform can provide is an install script that fails.
- **The winget package is `GoLang.Go` with per-version manifests.** `--id GoLang.Go --version N`,
  never `--id GoLang.Go.N` — that named a package that does not exist, and since the MSI download
  is the `else` branch of `if ($hasWinget)`, the failure left the host with no Go at all.

Go's policy is only the two most recent majors, so this pin ages faster than anything else in the
stack — roughly every six months something falls off the back.

## The Go module set

`agent/go.mod` has eight modules and low churn. Dependabot watches it monthly rather than weekly
because every agent-side bump implies a version bump, a rebuild of every platform binary, and a
re-sign — the review cost dwarfs the bump.

`gopsutil` is the one to watch: it reads OS internals for the sample streams, so a bump can
change what a metric means on one platform and not another. Verify one Linux and one Windows
agent report sane values before shipping.

## Zod, TypeScript, Vitest, ESLint

**Risk: low to medium**, all developer-facing.

- **Zod** — schemas are co-located at the top of every route file, so a major means a mechanical
  sweep. Watch error-shape changes: the API's 400 bodies are derived from Zod issues, so a
  changed issue shape is an API-contract change even though no route was touched.
- **TypeScript** — expect new errors from stricter inference; that is the point. Do not widen
  types to silence them.
- **Vitest** — `vitest` and `@vitest/coverage-v8` must match. `happy-dom` is effectively part of
  this family: it mis-parses `<option selected>`, so DOM tests must set selection in JS after
  insertion rather than asserting on the attribute.
- **ESLint** — `eslint` and `typescript-eslint` move together.

## Vendored frontend libraries

Leaflet (plus markercluster and draw), Cytoscape, dagre and html-to-image ship as **files under
`public/`**, not as runtime npm dependencies. A bump is a file copy plus a browser pass, and
`package.json` carrying a version for them is for types and tooling only — updating the npm entry
without copying the file changes nothing at runtime, which is the trap.

See `polaris-ui-canon` → tech-stack-frontend.md for the per-library rules.

## The overrides block

Five entries in `package.json`, each a hand-placed floor patching a reachable transitive
advisory. The full procedure — when to add, how to verify, when to remove — is in
[dependency-audit.md](dependency-audit.md). The one rule worth repeating: a parent bump can make
an override redundant *or* insufficient, so re-verify with `npm ls <pkg>` rather than assuming.
