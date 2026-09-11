/**
 * src/setup/setupRoutes.ts — API endpoints for first-run setup wizard
 */

import { Router } from "express";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import pg from "pg";
import { markSetupComplete } from "./detectSetup.js";
import { hashPassword } from "../utils/password.js";
import { ENV_FILE, STATE_DIR } from "../utils/paths.js";
import { makeRateLimiter } from "../api/middleware/rateLimits.js";
import { PG_DATA_DIR_CANDIDATES, pickFirstExistingPath, probeDiskFree } from "../utils/startupDiskCheck.js";
import { generateSecretKey } from "../utils/secretBox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const router = Router();

// The wizard is unauthenticated by design (first-run only, see the
// .setup-complete boot lock) — keep the DB-touching routes tightly
// rate-limited so a network neighbor can't use them as a connect proxy
// or brute-force surface while setup is in progress.
const setupActionLimiter = makeRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: "Too many setup attempts. Please wait 15 minutes and try again.",
});

const DbConfigSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535).default(5432),
  username: z.string().min(1),
  password: z.string(),
  database: z.string().min(1),
  ssl: z.boolean().default(false),
  sslAllowSelfSigned: z.boolean().default(false),
});

type DbConfig = z.infer<typeof DbConfigSchema>;

function buildPgClientOptions(db: DbConfig, database: string): pg.ClientConfig {
  // No sslmode in the connection string — pg-connection-string parses it into
  // its own ssl options that conflict with the explicit `ssl` field below in
  // a version-dependent way. Carrying TLS settings on the explicit field only
  // is unambiguous.
  const connectionString = `postgresql://${encodeURIComponent(db.username)}:${encodeURIComponent(db.password)}@${db.host}:${db.port}/${database}`;
  const opts: pg.ClientConfig = { connectionString, connectionTimeoutMillis: 8000 };
  if (db.ssl) {
    opts.ssl = db.sslAllowSelfSigned ? { rejectUnauthorized: false } : true;
  }
  return opts;
}

const passwordSchema = z.string()
  .min(8, "Password must be at least 8 characters")
  .regex(/[a-z]/, "Password must contain a lowercase letter")
  .regex(/[A-Z]/, "Password must contain an uppercase letter")
  .regex(/[0-9]/, "Password must contain a number")
  .regex(/[^a-zA-Z0-9]/, "Password must contain a special character");

const FinalizeSchema = z.object({
  db: DbConfigSchema,
  admin: z.object({
    username: z.string().min(1).max(64),
    password: passwordSchema,
  }),
  app: z.object({
    port: z.coerce.number().int().min(1).max(65535).default(3000),
    sessionSecret: z.string().min(16),
  }),
});

function buildConnectionString(db: DbConfig): string {
  const encoded = encodeURIComponent(db.password);
  const base = `postgresql://${encodeURIComponent(db.username)}:${encoded}@${db.host}:${db.port}/${db.database}`;
  if (!db.ssl) return base;
  // sslmode=no-verify keeps TLS but skips cert validation — recognized by
  // node-postgres (the driver used by @prisma/adapter-pg at runtime).
  //
  // It is NOT a libpq value, and this URL is also the source of the PG* env the
  // backup path hands pg_dump/psql. That translation is `libpqSslMode()` in
  // utils/pgEnv.ts (business rule 51) — do not "fix" this line by writing a
  // libpq value here instead: `require` means "validate the chain" to
  // node-postgres, which is exactly what a self-signed server cannot satisfy,
  // so it would trade broken backups for an app that cannot connect at all.
  return `${base}?sslmode=${db.sslAllowSelfSigned ? "no-verify" : "require"}`;
}

// GET /api/setup/status
router.get("/status", (_req, res) => {
  res.json({ needsSetup: true });
});

// POST /api/setup/preflight — runs after the operator picks a DB host but
// before finalize. Returns disk-free info for every volume Polaris will write
// to (state dir + app dir) and, when the DB host is localhost, the
// conventional PostgreSQL data directory candidates so the wizard can warn
// "your /var is only 8 GB, this is going to bite you in 6 months."
//
// Cross-platform via node:fs/promises — RHEL, Ubuntu, Windows all return
// usable statfs data. PostgreSQL's actual `data_directory` isn't available
// here (we haven't connected yet), so we walk a list of conventional paths
// per platform and report the first one that exists. The runtime
// `capacityService` resolves PGDATA authoritatively via `SHOW data_directory`
// once the DB connection is up.
// Candidate list + first-existing probe shared with the boot-time check —
// see utils/startupDiskCheck.ts (was a verbatim copy here until the
// 2026-08 audit).

const PreflightSchema = z.object({
  dbHost: z.string().min(1).optional(),
});

// Recommended minimums. Below these, the wizard surfaces a warning but
// doesn't block — the operator may know a layout the heuristic doesn't.
// 50 GB DB volume covers a ~1000-asset deployment on default retention with
// 6 months of headroom; 5 GB app/state gets through a couple of update cycles
// (each update copies the new bundle, then verifies, then swaps).
const RECOMMENDED_DB_FREE_GB = 50;
const RECOMMENDED_APP_FREE_GB = 5;

interface PreflightVolume {
  role: "app" | "state" | "db";
  path: string;
  freeBytes: number;
  totalBytes: number;
  freePct: number;
  recommendedMinFreeGb: number;
  meetsRecommendation: boolean;
  notes: string | null;
}

async function statfsForPreflight(role: PreflightVolume["role"], path: string, recommendedMinFreeGb: number): Promise<PreflightVolume | null> {
  const base = await probeDiskFree(path);
  if (!base) return null;
  const minFreeBytes = recommendedMinFreeGb * 1024 ** 3;
  return {
    role,
    path,
    ...base,
    recommendedMinFreeGb,
    meetsRecommendation: base.freeBytes >= minFreeBytes,
    notes: null,
  };
}


router.post("/preflight", async (req, res) => {
  try {
    const { dbHost } = PreflightSchema.parse(req.body || {});

    const isLocal = dbHost
      ? ["localhost", "127.0.0.1", "::1", ""].includes(dbHost.toLowerCase().trim())
      : true;

    const out: PreflightVolume[] = [];

    // App + state volumes (almost always the same on a default install where
    // POLARIS_STATE_DIR is unset; getVolumes-style dedupe by stat.dev would
    // collapse them at runtime, but for a one-shot wizard pass we keep them
    // separate so the operator sees both paths labeled).
    const appProbe = await statfsForPreflight("app", resolve(__dirname, "..", ".."), RECOMMENDED_APP_FREE_GB);
    if (appProbe) out.push(appProbe);
    const stateProbe = await statfsForPreflight("state", STATE_DIR, RECOMMENDED_APP_FREE_GB);
    if (stateProbe) out.push(stateProbe);

    let dbCandidatePath: string | null = null;
    let dbProbe: PreflightVolume | null = null;
    if (isLocal) {
      dbCandidatePath = await pickFirstExistingPath(PG_DATA_DIR_CANDIDATES);
      if (dbCandidatePath) {
        dbProbe = await statfsForPreflight("db", dbCandidatePath, RECOMMENDED_DB_FREE_GB);
        if (dbProbe) out.push(dbProbe);
      }
    }

    // Dedupe by (freeBytes,totalBytes) heuristic (statfs doesn't surface
    // device id portably enough here; identical free+total on the same host
    // means same filesystem in practice).
    const seen = new Set<string>();
    const deduped: PreflightVolume[] = [];
    for (const v of out) {
      const key = `${v.freeBytes}|${v.totalBytes}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(v);
    }

    const warnings: string[] = [];
    for (const v of deduped) {
      if (!v.meetsRecommendation) {
        const gb = (v.freeBytes / 1024 ** 3).toFixed(1);
        warnings.push(
          v.role === "db"
            ? `Database volume (${v.path}) has only ${gb} GB free — recommended ≥ ${v.recommendedMinFreeGb} GB. Sample tables grow with monitored asset count and retention; you may run out of space within months.`
            : `${v.role === "app" ? "Application" : "State"} volume (${v.path}) has only ${gb} GB free — recommended ≥ ${v.recommendedMinFreeGb} GB. Backups and update rollback both need headroom.`,
        );
      }
    }

    if (isLocal && !dbCandidatePath) {
      warnings.push(
        "PostgreSQL data directory could not be located via the standard paths — disk-free check on the DB volume was skipped. The runtime check will catch it once the DB connection is established.",
      );
    }
    if (!isLocal) {
      warnings.push(
        `Database host (${dbHost}) is not local — disk-free check on the DB volume was skipped. Make sure the DB host has at least ${RECOMMENDED_DB_FREE_GB} GB free on its data volume before completing setup.`,
      );
    }

    res.json({
      ok: warnings.length === 0,
      isDbLocal: isLocal,
      volumes: deduped,
      warnings,
      recommendedDbFreeGb: RECOMMENDED_DB_FREE_GB,
      recommendedAppFreeGb: RECOMMENDED_APP_FREE_GB,
    });
  } catch (err: any) {
    if (err.name === "ZodError") {
      return res.status(400).json({ ok: false, message: "Invalid input", errors: err.errors });
    }
    res.status(500).json({ ok: false, message: err.message || "Preflight check failed" });
  }
});

// POST /api/setup/generate-secret
router.post("/generate-secret", (_req, res) => {
  res.json({ secret: randomBytes(32).toString("hex") });
});

// POST /api/setup/test-connection
router.post("/test-connection", setupActionLimiter, async (req, res) => {
  try {
    const db = DbConfigSchema.parse(req.body);

    // Connect to the postgres default database to test server connectivity
    const client = new pg.Client(buildPgClientOptions(db, "postgres"));
    await client.connect();

    // Check PostgreSQL version
    const versionResult = await client.query("SELECT version()");
    const version = versionResult.rows[0]?.version || "Unknown";

    // Check if target database exists
    const dbCheck = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [db.database],
    );
    const dbExists = (dbCheck.rowCount ?? 0) > 0;

    await client.end();

    res.json({
      ok: true,
      version,
      databaseExists: dbExists,
      message: dbExists
        ? `Connected — ${version.split(",")[0]}`
        : `Connected — database "${db.database}" will be created during setup`,
    });
  } catch (err: any) {
    const msg = err.code === "ECONNREFUSED"
      ? `Connection refused — ${req.body.host}:${req.body.port}`
      : err.code === "ENOTFOUND"
      ? `Host not found — ${req.body.host}`
      : err.code === "ETIMEDOUT"
      ? `Connection timed out — ${req.body.host}:${req.body.port}`
      : err.code === "28P01"
      ? "Authentication failed — check username and password"
      : err.message || "Connection failed";
    res.json({ ok: false, message: msg });
  }
});

// POST /api/setup/finalize
router.post("/finalize", setupActionLimiter, async (req, res) => {
  try {
    const { db, admin, app } = FinalizeSchema.parse(req.body);

    // Safety: don't overwrite existing working config
    if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim().length > 0) {
      return res.status(409).json({ ok: false, message: "Application is already configured" });
    }

    // Step 1: Create database if it doesn't exist
    const serverClient = new pg.Client(buildPgClientOptions(db, "postgres"));
    await serverClient.connect();

    const dbCheck = await serverClient.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [db.database],
    );
    if ((dbCheck.rowCount ?? 0) === 0) {
      // Use double-quote escaping for the database name
      const safeName = db.database.replace(/"/g, '""');
      await serverClient.query(`CREATE DATABASE "${safeName}"`);
    }
    await serverClient.end();

    // Step 2: Write .env file
    //
    // We emit the variables the wizard collected as live values, AND the
    // common optional ones as commented-out documentation so operators
    // can find them without having to consult .env.example. Keep the
    // commented blocks in sync with .env.example.
    //
    // /health and /metrics are generated with random bearer tokens out of
    // the box so a public deployment doesn't ship those endpoints open.
    // Operators who deliberately don't want auth on them can clear the
    // value (the Maintenance tab surfaces a warning when either is unset).
    const databaseUrl = buildConnectionString(db);
    const healthToken = randomBytes(32).toString("hex");
    const metricsToken = randomBytes(32).toString("hex");
    // Secret-at-rest key. Generated here rather than left to the operator so a
    // fresh install NEVER stores device/integration credentials in plaintext —
    // an unset key makes the sealing in db.ts a silent no-op.
    const secretKey = generateSecretKey();

    // Preserve any reverse-proxy env vars that setup-rhel.sh / setup-ubuntu.sh
    // wrote BEFORE the wizard ran. Without this, finalize would clobber them
    // via writeFileSync below and the new polaris-web boot would fail with
    // "POLARIS_PROXY_CERT_PATH is set but POLARIS_PUBLIC_URL is missing"
    // (or worse — silently flip back to Node HTTPS without the supporting
    // cert + nginx config that the install script staged).
    let preservedProxyCertPath: string | null = null;
    let preservedPublicUrl:     string | null = null;
    if (existsSync(ENV_FILE)) {
      try {
        const existing = readFileSync(ENV_FILE, "utf-8");
        const pcp = existing.match(/^POLARIS_PROXY_CERT_PATH=(.*)$/m);
        const pu  = existing.match(/^POLARIS_PUBLIC_URL=(.*)$/m);
        if (pcp && pcp[1].trim().length > 0) preservedProxyCertPath = pcp[1].trim();
        if (pu  && pu[1].trim().length > 0)  preservedPublicUrl     = pu[1].trim();
      } catch { /* unreadable existing .env — fine, fresh write below */ }
    }
    const reverseProxyBlock = preservedProxyCertPath && preservedPublicUrl
      ? [
          "# Reverse-proxy (nginx) front-end — preserved from pre-wizard .env",
          "# (setup-rhel.sh / setup-ubuntu.sh write these before the wizard runs).",
          `POLARIS_PROXY_CERT_PATH=${preservedProxyCertPath}`,
          `POLARIS_PUBLIC_URL=${preservedPublicUrl}`,
          "",
        ]
      : [];

    const envContent = [
      "# Polaris — Application Configuration",
      "# Generated by first-run setup wizard. Edit and restart Polaris",
      "# to apply changes.",
      "",
      "# Database",
      `DATABASE_URL=${databaseUrl}`,
      "",
      "# App",
      `PORT=${app.port}`,
      "NODE_ENV=production",
      "LOG_LEVEL=info",
      "",
      "# Session secret — required when NODE_ENV=production (server refuses",
      "# to boot without it). Regenerate with `openssl rand -hex 64` if you",
      "# need to invalidate every active session.",
      `SESSION_SECRET=${app.sessionSecret}`,
      "",
      "# Reverse-proxy trust — leave UNSET when the app is exposed directly",
      "# to the internet. Setting this while not behind a proxy lets clients",
      "# spoof their IP via X-Forwarded-For and bypass the login rate limiter.",
      "# Enable only when running behind nginx/Caddy/Cloudflare/an ALB/etc:",
      "#   TRUST_PROXY=1              # trust the nearest one hop",
      "#   TRUST_PROXY=loopback       # trust 127.0.0.1 / ::1",
      "#   TRUST_PROXY=10.0.0.0/8     # trust a specific CIDR",
      "# See https://expressjs.com/en/guide/behind-proxies.html",
      "# TRUST_PROXY=",
      "",
      "# Health check token — when set, /health requires",
      "# `Authorization: Bearer <token>`. Auto-generated at setup so /health",
      "# isn't exposed open on public deployments. Clear the value if you",
      "# need an open endpoint (e.g. some load-balancer probes); the",
      "# Maintenance tab will surface a warning while it is unset.",
      `HEALTH_TOKEN=${healthToken}`,
      "",
      "# Prometheus metrics token — when set, /metrics requires",
      "# `Authorization: Bearer <token>`. Auto-generated at setup so /metrics",
      "# isn't exposed open on public deployments — the endpoint leaks fleet",
      "# size, monitor health, and queue depth as recon data. Clear the",
      "# value if you genuinely want it open (the Maintenance tab will",
      "# surface a warning while it is unset).",
      `METRICS_TOKEN=${metricsToken}`,
      "",
      "# Encryption key for secrets stored in the database (SNMP communities,",
      "# WinRM/SSH passwords + private keys, FortiManager/FortiGate API tokens,",
      "# the Entra client secret, vCenter credentials, SMTP/M365/Slack/Teams",
      "# delivery secrets, the Web Push VAPID private key). 32 bytes as hex.",
      "#",
      "# KEEP A COPY SOMEWHERE OTHER THAN THIS HOST. Sealed secrets cannot be",
      "# recovered without this key, and a database backup restored onto a host",
      "# with a different key needs every secret re-entered. Losing the key does",
      "# not lock you out of Polaris (local logins and SSO are unaffected) — it",
      "# loses the stored device credentials.",
      "#",
      "# Clearing the value reverts to storing secrets in plaintext; the",
      "# Maintenance tab surfaces a warning while it is unset.",
      `POLARIS_SECRET_KEY=${secretKey}`,
      "",
      ...reverseProxyBlock,
    ].join("\n");

    mkdirSync(dirname(ENV_FILE), { recursive: true });
    // 0600, not the umask default. This file is the install's whole secret
    // store in one place — SESSION_SECRET, POLARIS_SECRET_KEY (which decrypts
    // every credential in the database), HEALTH_TOKEN, METRICS_TOKEN, and the
    // Postgres password inside DATABASE_URL — and at the usual 0644 every
    // local account on the host could read it.
    writeFileSync(ENV_FILE, envContent, { encoding: "utf-8", mode: 0o600 });
    // `mode` on writeFileSync only applies when it CREATES the file, so an
    // .env left behind by an earlier attempt would keep its old permissions.
    // Best-effort: on Windows this is a near-no-op (ACLs, not mode bits), and
    // a failure here must not abort a finalize that has already written.
    try {
      chmodSync(ENV_FILE, 0o600);
    } catch (err) {
      console.warn(`[setup] could not restrict permissions on ${ENV_FILE}:`, (err as Error).message);
    }

    // Step 3: Set DATABASE_URL in current process so Prisma can use it.
    // Also stamp the auto-generated bearer tokens so the gates take effect
    // immediately without a restart.
    process.env.DATABASE_URL = databaseUrl;
    process.env.PORT = String(app.port);
    process.env.SESSION_SECRET = app.sessionSecret;
    process.env.HEALTH_TOKEN = healthToken;
    process.env.METRICS_TOKEN = metricsToken;
    process.env.POLARIS_SECRET_KEY = secretKey;

    // Step 4: Run Prisma migrations
    const projectRoot = resolve(__dirname, "..", "..");
    try {
      execSync("npx prisma migrate deploy", {
        cwd: projectRoot,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: "pipe",
        timeout: 120000,
      });
    } catch (migrateErr: any) {
      const stderr = migrateErr.stderr?.toString() || migrateErr.message;
      return res.status(500).json({
        ok: false,
        step: "migrations",
        message: `Database migration failed: ${stderr.slice(0, 500)}`,
      });
    }

    // Step 5: Create admin user via raw pg
    const appClient = new pg.Client(buildPgClientOptions(db, db.database));
    await appClient.connect();

    // The dynamic-roles cutover (migration 20260524000000_roles_table_cutover)
    // moved role identity from a User.role enum column to a User.role_id FK
    // into the roles table. Look up the seeded "admin" role first.
    const roleResult = await appClient.query(
      "SELECT id FROM roles WHERE name = 'admin' LIMIT 1",
    );
    const adminRoleId = roleResult.rows[0]?.id;
    if (!adminRoleId) {
      await appClient.end();
      return res.status(500).json({
        ok: false,
        step: "create-admin",
        message:
          "Built-in admin role not found in roles table — the dynamic-roles cutover migration (20260524000000) may not have applied. Check `npx prisma migrate status`.",
      });
    }

    const passwordHash = await hashPassword(admin.password);
    // Column names: password_hash, role_id, and auth_provider are @map()'d to
    // snake_case; createdAt has @default(now()) at the DB level so it's
    // optional; updatedAt is Prisma-managed (@updatedAt) with no DB default,
    // so raw SQL must supply NOW() explicitly here.
    await appClient.query(
      `INSERT INTO users (id, username, password_hash, role_id, auth_provider, "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, 'local', NOW())
       ON CONFLICT (username) DO UPDATE SET password_hash = $2, role_id = $3, "updatedAt" = NOW()`,
      [admin.username, passwordHash, adminRoleId],
    );
    await appClient.end();

    // Write the setup-complete marker so future boots refuse to show the
    // wizard even if .env is deleted or DATABASE_URL is cleared.
    markSetupComplete();

    // Return healthToken so the wizard's post-finalize poll loop can send
    // it as a Bearer header — without it, /health on the restarted app would
    // 401 every poll and the auto-redirect would time out at 60s.
    res.json({
      ok: true,
      message: "Setup complete. The application is restarting.",
      healthToken,
    });

    // Step 6: Restart the process after response flushes
    setTimeout(() => {
      process.exit(0);
    }, 1500);
  } catch (err: any) {
    if (err.name === "ZodError") {
      return res.status(400).json({ ok: false, message: "Invalid input", errors: err.errors });
    }
    res.status(500).json({ ok: false, message: err.message || "Setup failed" });
  }
});

export default router;
