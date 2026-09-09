## cross-cutting/schema-migrations-and-prisma-client-lifecycle

**What it is:** The contract between `prisma/schema.prisma`, the generated Prisma client at `src/generated/prisma/` (gitignored), the compiled `dist/generated/prisma/`, and the in-app updater pipeline that holds them together. Polaris uses Prisma 7 with `provider = "prisma-client"` which emits TypeScript source — `prisma generate` writes to `src/generated/prisma/`, then `tsc` compiles to `dist/generated/prisma/`. The running process imports from `./generated/prisma/client.js` (see `src/db.ts`). The state the running process holds in memory must match the actual DB schema, or every Prisma query that selects the affected columns crashes with `column "<name>" does not exist`.

**Lifecycle (steps must execute in this order):**
1. **Schema edit** — `prisma/schema.prisma` is the source of truth for what the Prisma client knows about.
2. **Migration written** — `prisma/migrations/<ts>_<name>/migration.sql` describes how to evolve the DB from the previous shape to the new one.
3. **Generate** — `prisma generate` writes a fresh `src/generated/prisma/`. Triggered by the `postinstall` script in `package.json` after `npm install` / `npm ci`, AND by an explicit step in `applyUpdate` (since postinstall can be silently skipped — `npm ci --ignore-scripts`, partial install recovery, etc.). **The updaters invoke the project's own CLI by path — `node node_modules/prisma/build/index.js` (`PRISMA_CLI` in `updateService.ts`, the same literal in both `deploy/update-*` scripts) — never `npx prisma`.** `npx` falls through to the registry when the local binary is missing and, in a non-TTY, installs without asking: a `node_modules` that lost the Prisma CLI would have a different major fetched and run against the schema with no log line saying so (an operator in the wrong directory on 2026-09-09 was offered `prisma@8.0.0-rc.13` against a Prisma 7 database — only the prompt stood in the way). By path it fails with ENOENT. `tests/unit/updateScriptsContract.test.ts` pins the scripts.
4. **Compile** — `npm run build` (= `tsc && node scripts/copy-build-assets.mjs`) produces `dist/`. `dist/` must be cleaned first (`rm -rf dist`) because tsc is non-destructive: stale `.js` files from a prior generation can shadow the regenerated client if Prisma changed its internal file layout (the `prisma-client` provider's auxiliary files do this between minor versions). Build via `npm run build`, never bare `npx tsc` — the copy step mirrors the bundled std MIB `.txt` files into `dist/` (tsc won't), and skipping it breaks every std SNMP-walk. See `cross-cutting/deployment`.
5. **Migrate** — `prisma migrate deploy` applies pending SQL (same local-CLI rule as step 3).
6. **Restart** — the running process picks up the new client + the new schema together.

**Writers** (files that drive each step):
- `prisma/schema.prisma` — schema source of truth.
- `prisma/migrations/*/migration.sql` — DB evolution.
- `package.json:postinstall` — calls `prisma generate` after deps install.
- `src/services/updateService.ts:applyUpdate` — orchestrates steps 3-6 in `cross-cutting/services/updateService.ts`'s seven-step pipeline.
- `prisma.config.ts` — Prisma 7 config (datasource URL, generator output path).

**Readers** (code that depends on the lifecycle's invariants holding):
- **All Prisma typed queries** (`prisma.asset.update`, `findMany`, etc.) — generated client decides which columns appear in `SELECT` / `RETURNING` clauses. A stale client crashes on any query that touches a dropped column even if the data payload doesn't.
- **Raw-SQL queries that hardcode column names** — NOT protected by the generated client; column renames must be propagated by hand. Known locations as of 2026-05-15:
  - `src/services/capacityService.ts` — `telemetryEligibleSQL` (`cpuMemoryPolling`), `systemInfoEligibleSQL` (`interfacesPolling`).
  - `src/services/capacityAdvisorService.ts:readApplicableCounts` — same two columns.
- **`src/db.ts`** — Prisma client extension; its `Asset.update` / `findMany` / `create` / `updateMany` / `upsert` wrappers go through whatever client is generated. Failure modes here surface as the generic `column "<name>" does not exist` errors in the log.
- **Operators reading the Maintenance tab** — `pg-tuning` and `capacity-advisor` routes consume the raw-SQL readers above; they 500 when those queries fail.

**Invariants:**
- The generated client and the DB schema must agree at every process start. Steps 3-6 are not optional; reordering them re-introduces the failure mode where the running client selects columns the DB no longer has.
- `src/generated/` is gitignored; the build pipeline (postinstall + the updater's explicit step) regenerates it from `schema.prisma`. Never check generated files in.
- A migration that DROPS a column requires every raw-SQL reader of that column to be updated in the same commit. The Prisma client gets rewritten automatically; raw SQL does not.
- A migration that RENAMES a column has the same constraint plus the additional risk that the rename can silently succeed (no DROP) but every reader still queries the old name.
- The updater's `rm -rf dist` between `prisma generate` and `tsc` is load-bearing — stale compiled JS from a previous Prisma-client version can shadow the fresh build.

**When changing this:**
- **Renaming or dropping any DB column:** grep the entire codebase for `prisma.$queryRawUnsafe` and raw-SQL strings containing the column name BEFORE writing the migration. Update those readers in the same commit as the migration.
- **Adding a step to the updater pipeline:** keep the generate → clean-dist → tsc → migrate → restart ordering intact. If the new step needs DB access, decide whether it should run pre- or post-migrate based on what schema state it expects.
- **Changing where the Prisma client is generated to:** update `tsconfig.json` includes, `package.json:postinstall` (if path changes), `.gitignore`, and re-verify `dist/` cleanup still wipes the right path.
- **Recovering a prod box stuck on a stale client:** from `/opt/polaris` as the app user — `rm -rf src/generated dist && node node_modules/prisma/build/index.js generate && npm run build`, then `systemctl restart polaris.target`. (`npm run build`, not bare `npx tsc`, so the std MIB asset copy runs; the local CLI by path, not `npx prisma`, so a wrong cwd or an empty `node_modules` fails instead of downloading a different Prisma.) Document this in the operator-facing runbook when the failure mode recurs.

**Related:** `cross-cutting/services/updateService.ts` invariants encode the same ordering rules at the pipeline-step level; this section is the broader contract.

---
