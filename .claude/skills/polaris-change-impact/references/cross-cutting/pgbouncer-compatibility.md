## cross-cutting/pgbouncer-compatibility

**What it is:** Polaris is **PgBouncer-aware**. Operators who put PgBouncer (or any connection multiplexer) in front of PostgreSQL set `POLARIS_DB_DIRECT_URL` to the direct Postgres URL while `DATABASE_URL` points at PgBouncer. Polaris routes different code paths to one URL or the other based on what each path needs.

**Connection-string helpers** (`src/utils/dbConnections.ts`):
- `getApplicationDatabaseUrl()` — returns DATABASE_URL.
- `getDirectDatabaseUrl()` — returns POLARIS_DB_DIRECT_URL when set, else falls back to DATABASE_URL.
- `getDbConnectionMode()` — returns `"pgbouncer"` when the two URLs differ OR DATABASE_URL has `?pgbouncer=true`; `"direct"` otherwise.

**Routing rules:**
- **Application queries (Prisma client)** → DATABASE_URL via `src/db.ts`. Under PgBouncer this hits the multiplexer; under direct mode it hits Postgres straight.
- **pg-boss queue ops** → `getDirectDatabaseUrl()` in `src/services/queueService.ts:startPgbossWorkers`. Required: pg-boss uses LISTEN/NOTIFY and the pg client's prepared-statement cache, both of which break under PgBouncer transaction pooling.
- **`pg_dump` backup + restore** → `getDirectDatabaseUrl()` in `src/api/routes/serverSettings.ts` (`/database/backup` and `/database/restore` routes). PgBouncer doesn't proxy the COPY-heavy dump protocol reliably.
- **`pg_stat_activity` reads** (connection-pool snapshot) AND **`pg_stat_database` reads** (disk-read pressure: `blks_read`/`blks_hit`/`blk_read_time`/`track_io_timing`, via `readPgStatDatabaseIo()`) → dedicated `pg.Pool` (max 2) in `src/services/capacityService.ts:getDirectStatsPool()`, opened lazily only when PgBouncer mode is detected. Going through PgBouncer would show the multiplexed view of backend connections, which under-counts what Polaris actually holds.
- **express-session** → DATABASE_URL (PgBouncer-safe; low-volume INSERT/SELECT/DELETE with no LISTEN/NOTIFY, no held prepared statements).
- **Prisma CLI migrations** → the in-app updater passes the migrate child `getDirectDatabaseUrl()` (plus `lock_timeout` and its application_name, rule 197 — `services/migrationGuardService.ts`), so it reaches Postgres directly; CLI invocations under PgBouncer should explicitly set `DATABASE_URL=<direct URL>` before `npx prisma migrate deploy`. Documented in `docs/INSTALL.md`.

**Detection signal:** `polaris_db_connection_mode{mode}` gauge (set once at boot from `recordDbConnectionMode()` in `src/app.ts`) plus an info-level log line at boot. Operators verify Polaris recognized their topology without grepping for connection errors.

**Capacity Advisor caveat:** The advisor's `PG_MAX_CONNECTIONS` recommendation is sized to keep Polaris's pool at ≤65% of `max_connections`. Under PgBouncer mode this is a conservative upper bound — PgBouncer's `default_pool_size` × pool count is what actually hits Postgres, so a smaller `max_connections` is fine. UI shows a hint ("PgBouncer detected") above the recommendation table when applicable; the underlying math stays the same.

**When changing this:**
- Adding a new code path that issues `LISTEN`, `NOTIFY`, `pg_dump`, `pg_restore`, or any session-scoped state-machine SQL: route it through `getDirectDatabaseUrl()` so it doesn't break PgBouncer installs.
- Adding a new code path that reads `pg_stat_activity` or `pg_stat_database` for cluster-wide stats: route it through `getDirectStatsPool()` so the numbers are accurate.
- Routine read/write through Prisma: leave it alone. The application URL is the right path.

---
