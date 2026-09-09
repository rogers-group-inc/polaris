/**
 * src/app.ts — Full application server (extracted from index.ts)
 *
 * Only imported when DATABASE_URL is configured (setup is complete).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import session from "express-session";
import pgSession from "connect-pg-simple";
import pg from "pg";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import { router } from "./api/router.js";
import { pwaRouter } from "./api/routes/pwa.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { errorHandler } from "./api/middleware/errorHandler.js";
import { csrfMiddleware } from "./api/middleware/csrf.js";
import { logger } from "./utils/logger.js";
import { resolveTrustProxy } from "./utils/trustProxy.js";
import { buildHelmetOptions } from "./utils/securityHeaders.js";
import { validateRuntimeConfiguration } from "./utils/runtimeConfig.js";
import { isProxyMode } from "./utils/proxyMode.js";
import { UPLOADS_DIR } from "./utils/paths.js";
import { isAzureSsoConfiguredAsync, getSsoSettings } from "./services/azureAuthService.js";
import { isLoginSourceAllowed } from "./services/loginAccessService.js";
import { isApiDocsSourceAllowed } from "./services/apiDocsAccessService.js";
import { logEvent } from "./services/eventLogService.js";
import { isOidcEnabled } from "./services/oidcAuthService.js";
import { isEntraProxyLoginAvailable } from "./services/entraProxyAuthService.js";
import { stripUntrustedEntraProxyHeaders } from "./api/middleware/entraProxyHeaders.js";
import {
  renderMetrics,
  startHttpRequestTimer,
  incHttpInFlight,
  decHttpInFlight,
  statusToClass,
} from "./metrics.js";
// Background jobs are NOT statically imported here — importing a job module
// runs its self-start side effect, which must be gated by process role. They
// are dynamically imported per-role in startBackgroundJobs() below.
import { roleConfig, type RoleConfig } from "./utils/role.js";
import { startDiscoveryScheduler } from "./jobs/discoveryScheduler.js";
import { ensureRegistryLoaded } from "./services/oidRegistry.js";
import { detectTimescale, migrateToHypertables } from "./services/timescaleService.js";
import { initializeQueue, startPgbossWorkers, startDiscoveryWorker, startScanWorker, startQueueProducer, stopPgbossWorkers } from "./services/queueService.js";
import { runDiscovery } from "./services/discovery/discoveryEngine.js";
import { runScan } from "./services/networkScanRunner.js";
import { startSampleWriteBuffer, shutdownFlushSampleBuffers } from "./services/sampleWriteBuffer.js";
import { startProbePatchBuffer, shutdownFlushProbePatchBuffer } from "./services/probePatchBuffer.js";
import { runStartupDiskCheck } from "./utils/startupDiskCheck.js";
import { runSchemaSanityCheck } from "./utils/schemaSanityCheck.js";
import { getDbConnectionMode } from "./utils/dbConnections.js";
import { startMetricsOnlyServer } from "./utils/metricsServer.js";
import { recordDbConnectionMode, setDbPoolRoleCapacity } from "./metrics.js";
import { startFmgActivityHeartbeat } from "./services/fmgActivityService.js";
import { rememberLoginTarget } from "./utils/loginRedirect.js";

// Fail-fast environment validation runs BEFORE any listener binds, before
// pg-boss init, before sample buffers start. Throws on misconfiguration
// (e.g. POLARIS_PROXY_CERT_PATH set without POLARIS_PUBLIC_URL) so systemd's
// Restart=on-failure cycles the unit cleanly instead of leaving a half-
// initialized listener open. See src/utils/runtimeConfig.ts.
validateRuntimeConfiguration();

// Stamp the detected DB connection topology once at boot so operators (and
// `/metrics` scrapes) can confirm Polaris recognized their PgBouncer setup
// without reading logs. The mode is constant for the life of the process.
{
  const mode = getDbConnectionMode();
  recordDbConnectionMode(mode);
  if (mode === "pgbouncer") {
    logger.info(
      "DB connection mode: PgBouncer detected. Application queries through DATABASE_URL; pg-boss / pg_dump / pg_stat_activity through POLARIS_DB_DIRECT_URL.",
    );
  } else {
    logger.info("DB connection mode: direct to PostgreSQL.");
  }
}

// Warm the symbolic-OID registry once at startup so the first monitor tick
// can resolve vendor MIB symbols without paying a load on the hot path. Errors
// are non-fatal — the registry will lazily reload on the next resolve() call.
ensureRegistryLoaded().catch((err) => {
  logger.warn({ err: err?.message }, "OID registry warm-up failed");
});

// Process role gates which subsystems boot here (see src/utils/role.ts).
// Unset POLARIS_ROLE => "all" => every capability on => today's single-process
// behavior. web = HTTP + singleton schedulers + migrations; monitor = pg-boss
// monitor consumers + write buffers; discovery = pg-boss discovery consumer.
const cfg = roleConfig();
logger.info(
  {
    role: cfg.role,
    runsHttp: cfg.runsHttp,
    runsMonitorConsumers: cfg.runsMonitorConsumers,
    runsDiscoveryConsumers: cfg.runsDiscoveryConsumers,
    runsSchedulers: cfg.runsSchedulers,
    runsMigrations: cfg.runsMigrations,
  },
  `Polaris process role: ${cfg.role}`,
);

// Capacity Advisor sanity check: the web role sizes pools + max_connections
// using POLARIS_MONITOR_REPLICAS to know the group's process count. Pre-Phase-3
// fresh installs (and any -nodb install before this fix) didn't write the var,
// so the advisor silently degrades to single-process math and over-recommends
// per-process DATABASE_POOL_SIZE / under-recommends max_connections. Warn loudly
// when we detect the gap so operators can `echo POLARIS_MONITOR_REPLICAS=N >>
// /opt/polaris/.env` and restart.
if (cfg.role === "web") {
  const replicasRaw = (process.env.POLARIS_MONITOR_REPLICAS ?? "").trim();
  const replicas = Number.parseInt(replicasRaw, 10);
  if (!replicasRaw || !Number.isFinite(replicas) || replicas < 1) {
    logger.warn(
      { POLARIS_MONITOR_REPLICAS: replicasRaw || "(unset)" },
      "POLARIS_MONITOR_REPLICAS is unset on the web role — Capacity Advisor will assume single-process and mis-size DATABASE_POOL_SIZE + PG max_connections. Set it to the number of polaris-monitor@N units enabled (matches --monitor-replicas at install time) in /opt/polaris/.env and restart polaris.target.",
    );
  }
}

// Stamp this process's configured connection capacity under its role label so
// /metrics exposes the per-role footprint — in a multi-process deployment no
// single process sees the whole group, so the Capacity Advisor / Prometheus
// sums these (across roles + monitor-replica instances) against max_connections.
{
  const envInt = (name: string, dflt: number): number => {
    const n = Number.parseInt(process.env[name] ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  const prismaPool = envInt("DATABASE_POOL_SIZE", 25);
  const pgbossPool = envInt("POLARIS_PGBOSS_POOL_SIZE", 20);
  setDbPoolRoleCapacity(cfg.role, prismaPool + pgbossPool);
}

// Warm the monitor-queue mode cache at startup so the dispatcher in
// `monitorAssets.ts` and the capacity snapshot both see the same value, then
// start the pg-boss surfaces this role needs: monitor consumers
// (runsMonitorConsumers), the discovery consumer (runsDiscoveryConsumers), and
// the producer connection so schedulers can publish (runsSchedulers).
// initializeQueue() runs in every role (cheap cache warm). Non-fatal — failure
// leaves Polaris on the cursor (default) queue.
void (async () => {
  try {
    await initializeQueue();
    if (cfg.runsMonitorConsumers) {
      await startPgbossWorkers().catch((err) => {
        const msg = String(err?.message || "");
        // Distinguish the most common operator-actionable failure (the role
        // Polaris connects as doesn't own the pgboss schema) from generic
        // pg-boss errors. The actionable error gets a multi-line log entry
        // with the SQL the DBA needs to run; everything else stays a plain
        // warn line.
        if (/permission denied for schema pgboss/i.test(msg)) {
          logger.error(
            { err: msg },
            "pg-boss worker start failed — the polaris DB role does not own the pgboss schema.\n" +
            "Polaris will fall back to in-process cursor mode (suitable for small/medium fleets only).\n" +
            "To enable pg-boss for large fleets, run the following on the polaris database as a Postgres\n" +
            "superuser (psql ... or via your managed-Postgres console), replacing $DB_USER with the\n" +
            "polaris role:\n" +
            "  ALTER SCHEMA pgboss OWNER TO $DB_USER;\n" +
            "  GRANT ALL ON SCHEMA pgboss TO $DB_USER;\n" +
            "  GRANT ALL ON ALL TABLES    IN SCHEMA pgboss TO $DB_USER;\n" +
            "  GRANT ALL ON ALL SEQUENCES IN SCHEMA pgboss TO $DB_USER;\n" +
            "  GRANT ALL ON ALL FUNCTIONS IN SCHEMA pgboss TO $DB_USER;\n" +
            "  ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON TABLES    TO $DB_USER;\n" +
            "  ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON SEQUENCES TO $DB_USER;\n" +
            "  ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON FUNCTIONS TO $DB_USER;\n" +
            "Then restart the polaris service.",
          );
        } else {
          logger.warn({ err: msg }, "pg-boss worker start failed; staying on cursor");
        }
      });
    }
    if (cfg.runsDiscoveryConsumers) {
      await startDiscoveryWorker(runDiscovery).catch((err) => {
        logger.warn({ err: err?.message }, "pg-boss discovery worker start failed");
      });
      // Network Discovery (business rule 34) rides the same role but its OWN
      // queue — POLARIS_DISCOVERY_WORKERS defaults to 2, so a scan sharing that
      // lane would stall integration discovery for the whole fleet.
      await startScanWorker(runScan).catch((err) => {
        logger.warn({ err: err?.message }, "pg-boss network-scan worker start failed");
      });
      // Snapshot per-FmgWorker lane state to the DB every 2 s so the web role
      // can surface "active FMG calls" on the integration card without holding
      // the worker instances itself. See services/fmgActivityService.ts.
      startFmgActivityHeartbeat();
    }
    // Producer connection: schedulers (monitor producer ticks, discovery
    // scheduler) publish jobs, so the web/all role needs a live boss to send
    // through even when it consumes nothing. No-op in cursor mode.
    if (cfg.runsSchedulers && !cfg.runsMonitorConsumers) {
      await startQueueProducer().catch((err) => {
        logger.warn({ err: err?.message }, "pg-boss producer init failed; publishing disabled");
      });
    }
  } catch (err: any) {
    logger.warn({ err: err?.message }, "Queue initialization failed; defaulting to cursor mode");
  }
})();

// Sample-write + probe-patch buffers batch the per-probe sample inserts and
// state updates. The monitor consumers produce them via SNMP/REST probes, AND
// the web role produces them via the Polaris Agent `/samples` + `/probe-now`
// endpoints (mounted on the HTTP listener) — both roles must run the flush
// tick or agent-sourced rows sit in the in-process buffer and only land on
// graceful shutdown. runsWriteBuffers is true for monitor + web (+ all).
if (cfg.runsWriteBuffers) {
  // Sample-write buffer: batches the six append-only sample tables (monitor /
  // telemetry / temperature / interface / storage / ipsec tunnel) into one
  // createMany per 2-second flush window instead of one create per work item.
  startSampleWriteBuffer();
  // Probe-patch buffer: the STATE side of recordProbeResult — one bulk UPDATE
  // FROM VALUES per 2 s window covers every asset's monitorStatus / counters /
  // last-at timestamps instead of one prisma.asset.update per probe.
  startProbePatchBuffer();
}

// Standalone /metrics listener for the non-HTTP roles (monitor, discovery).
// Web/all serve /metrics from the main Express app, so this only fires when
// runsHttp is false AND the operator has set POLARIS_METRICS_PORT. Without
// this, every metric stamped from inside a monitor worker or discovery
// consumer lives in a process Prometheus never scrapes — the symptom is the
// "no data" panels for probe / work-duration / sample-write / discovery /
// FMG-proxy-lane on the Grafana dashboard.
if (!cfg.runsHttp) {
  const rawPort = Number.parseInt(process.env.POLARIS_METRICS_PORT ?? "", 10);
  if (Number.isFinite(rawPort) && rawPort > 0) {
    const bind = process.env.POLARIS_METRICS_BIND || "127.0.0.1";
    void startMetricsOnlyServer(rawPort, bind).catch((err) => {
      logger.error(
        { err: err?.message, port: rawPort, bind },
        "Failed to start metrics-only HTTP listener",
      );
    });
  }
}

// Start role-appropriate background jobs (dynamic imports so a job module's
// self-start side effect only fires in the role that should run it).
void startBackgroundJobs(cfg);

// Graceful shutdown on SIGTERM/SIGINT so in-flight jobs can drain and the
// final buffer flushes land before the process exits. No-op when
// pg-boss never started.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => {
    Promise.allSettled([
      shutdownFlushSampleBuffers(),
      shutdownFlushProbePatchBuffer(),
      stopPgbossWorkers(),
    ]).finally(() => process.exit(0));
  });
}

// Detect TimescaleDB once at startup so the prune layer + capacity service
// can dispatch on hypertable status without paying a probe on every call.
// When detected, also convert the six sample tables to hypertables and
// apply the compression policy (idempotent — safe to re-run). Existing data
// is migrated in place during the conversion via `migrate_data => TRUE`,
// taking a brief ACCESS EXCLUSIVE lock per table; the operator sees a
// "Converting sample table to hypertable" log line for each.
//
// Non-fatal — failure leaves Polaris on plain-Postgres prune for the
// affected table(s). Detection is awaited because the migrate step depends
// on the cache being warm; the migrate itself runs as a fire-and-forget
// chain so it doesn't block listen().
detectTimescale()
  .then(() => {
    // The hypertable conversion is schema DDL — run it only where migrations
    // run (web/all), so monitor/discovery replicas don't race on the same
    // ACCESS EXCLUSIVE locks. Detection itself runs in every role (read-only,
    // warms the prune/capacity cache).
    if (cfg.runsMigrations) {
      return migrateToHypertables().catch((err) => {
        logger.warn({ err: err?.message }, "TimescaleDB hypertable migration failed");
      });
    }
  })
  .catch((err) => {
    logger.warn({ err: err?.message }, "TimescaleDB detection failed");
  });

// Boot-time disk diagnostic. Logs a clear "X volume has Y MB free" line for
// every filesystem Polaris/Postgres write to, at info/warn/error level
// depending on free percentage. Catches the "polaris flapping because /var
// is full" case before the operator has to dig through Prisma errors.
// Non-fatal — never blocks startup; the periodic capacityWatch job and
// Maintenance tab carry the same signal at runtime.
void runStartupDiskCheck();

const app = express();

// ─── Trust proxy ────────────────────────────────────────────────────────────
// Resolution: operator-set TRUST_PROXY wins; otherwise proxy mode auto-defaults
// to "1" (first-hop trust); otherwise unset (direct-to-internet, no X-Forwarded-*
// honored — required for that mode because clients can otherwise spoof their IP
// and bypass the login rate limiter). See src/utils/trustProxy.ts.
const trustProxy = resolveTrustProxy();
if (trustProxy !== undefined) {
  app.set("trust proxy", /^\d+$/.test(String(trustProxy)) ? Number(trustProxy) : trustProxy);
}

// ─── Session secret ──────────────────────────────────────────────────────────
// Hard-fail in production if SESSION_SECRET is unset; a predictable fallback
// lets attackers forge session cookies. Dev keeps a fallback for convenience.
function resolveSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length > 0) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET is required when NODE_ENV=production. Set a long random value in .env before starting the server."
    );
  }
  return "polaris-dev-secret-change-in-production";
}
const SESSION_SECRET = resolveSessionSecret();

// ─── Security headers ────────────────────────────────────────────────────────
// Shared with the Dash wallboard listener — see src/utils/securityHeaders.ts
// for the full CSP rationale (inline-script ban, map-tile img hosts, the
// Screenshot/weather connect-src entries).
app.use(helmet(buildHelmetOptions()));

// ─── Response compression ────────────────────────────────────────────────────
app.use(compression());

// ─── Body parsing with size limits ───────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" })); // SAML callback posts form-encoded

// ─── Session ─────────────────────────────────────────────────────────────────
const PgStore = pgSession(session);
const sessionPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

app.use(
  session({
    store: new PgStore({
      pool: sessionPool,
      createTableIfMissing: true,
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      // "auto" sets Secure when the request is HTTPS (including behind a
      // reverse proxy when TRUST_PROXY is set so X-Forwarded-Proto is
      // believed). Removes the need for a FORCE_HTTPS override.
      secure: "auto",
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
    },
  })
);

// ─── CSRF protection ─────────────────────────────────────────────────────────
// Must come after session middleware (reads/writes req.session) and before
// any route handler that performs writes.
app.use(csrfMiddleware);

// ─── HTTP request metrics ────────────────────────────────────────────────────
// Tracks `polaris_http_request_duration_seconds` (by method/route/status_class)
// and `polaris_http_in_flight`. Skips /metrics and /health to avoid scrape
// requests showing up as application traffic. The matched Express route
// template is captured at response-finish time so cardinality stays bounded
// — unmatched paths roll up to "unmatched" instead of one series per URL.
app.use((req, res, next) => {
  if (req.path === "/metrics" || req.path === "/health") return next();
  incHttpInFlight();
  const stopTimer = startHttpRequestTimer();
  let observed = false;
  const finalize = () => {
    if (observed) return;
    observed = true;
    decHttpInFlight();
    // req.route is populated only when Express matched a route. Combine with
    // baseUrl so /api/v1/assets/:id renders correctly instead of just "/:id".
    const route = req.route?.path
      ? (req.baseUrl ?? "") + (typeof req.route.path === "string" ? req.route.path : "unmatched")
      : "unmatched";
    stopTimer(req.method, route, statusToClass(res.statusCode));
  };
  res.once("finish", finalize);
  res.once("close", finalize);
  next();
});

// ─── Rate limiting ───────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again in 15 minutes." },
});
app.use("/api/v1/auth/login", loginLimiter);
app.use("/api/v1/auth/azure/login", loginLimiter);

// ─── Entra App Proxy identity-header strip ──────────────────────────────────
// The App Proxy header-SSO identity headers are unsigned; requests not
// arriving from an allowlisted connector address must never be seen carrying
// them. Mounted before every consumer (the auto-login redirect below and the
// /api/v1/auth/entra-proxy routes). Defense in depth — the login route
// re-validates trust itself and never relies on stripping alone.
app.use(stripUntrustedEntraProxyHeaders);

// ─── Local login source-IP gate ─────────────────────────────────────────────
// Optional, default OFF (`loginAccessConfig` — Server Settings → Web Server →
// Local Login Access). When enabled, the local login FORM and the password
// endpoints answer only to allowed source IPs.
//
// Why both halves: /login.html is deliberately not in protectedPages (it is
// the anti-lockout path when SSO is down — under "Skip login page" it is
// reached as /login.html?local=1, see the login-page middleware below), so
// gating the page alone would be cosmetic — the form is a plain POST to a
// JSON API that anyone could curl. The page gate is UX; the endpoint gate is
// the control. This gate is mounted ABOVE the skip redirect on purpose: an
// out-of-scope visitor is dropped before that redirect could confirm anything.
//
// Scope: POST /auth/login + /auth/login/totp only. Those carry local AND LDAP
// credentials — both are restricted, by design. Every SSO route (SAML, OIDC,
// App Proxy) is untouched: SSO is the path that must keep working from
// anywhere, which is what makes restricting this one safe.
//
// An unauthorized page request is DROPPED (socket destroyed, no response) —
// the dashServer posture, so a scanner gets no confirmation that a local login
// path exists. The API answers the SAME generic 401 a wrong password gets, for
// the same reason: "you are on the wrong network" is a fact worth learning.
// Fails OPEN on a settings read error (isLoginSourceAllowed) — a DB blip must
// not become the lockout this feature exists to prevent.
const LOGIN_CREDENTIAL_PATHS = new Set(["/api/v1/auth/login", "/api/v1/auth/login/totp"]);
app.use(async (req, res, next) => {
  const isLoginPage = req.path === "/login.html";
  const isCredentialPost = req.method === "POST" && LOGIN_CREDENTIAL_PATHS.has(req.path);
  if (!isLoginPage && !isCredentialPost) return next();

  if (await isLoginSourceAllowed(req.ip ?? "")) return next();

  if (isLoginPage) {
    try {
      req.socket?.destroy();
    } catch {
      /* connection already torn down */
    }
    return;
  }
  logEvent({
    action: "auth.login.blocked_source",
    resourceType: "user",
    resourceName: typeof req.body?.username === "string" ? req.body.username : undefined,
    level: "warning",
    message: "Local login refused — source IP outside the configured login-access scope",
    details: { ip: req.ip, userAgent: req.get("user-agent") || undefined },
  });
  return res.status(401).json({ error: "Invalid username or password" });
});

// ─── API documentation source-IP gate ───────────────────────────────────
// GET /api serves developer docs (public/api.html) with NO login — source-IP
// scope is the only gate (the `apiDocsConfig` Setting, edited on Server
// Settings → API Tokens; default enabled, RFC1918 + loopback). Three exact
// paths, because express.static below would otherwise serve public/api.html
// UNGATED at /api.html — the same interception the login gate above does for
// /login.html. Deny = socket destroy (the dash/login-page stealth posture: a
// scanner learns nothing). The gate FAILS CLOSED (isApiDocsSourceAllowed) —
// this fronts an unauthenticated disclosure surface, so a settings-read blip
// hides the docs briefly rather than exposing them; the login gate above
// makes the opposite call for the opposite reason. On managed proxy installs
// nginx renders a matching `location = /api` allow block, but THIS gate is
// authoritative on every install type (Windows/NSSM, dev, Docker included).
// This is an unmounted app.use, so req.path is the full path — /api/v1/*
// never matches the exact-path Set.
const API_DOCS_PATHS = new Set(["/api", "/api/", "/api.html"]);
app.use(async (req, _res, next) => {
  if (!API_DOCS_PATHS.has(req.path)) return next();
  if (await isApiDocsSourceAllowed(req.ip ?? "")) return next();
  try {
    req.socket?.destroy();
  } catch {
    /* connection already torn down */
  }
});

// The docs page itself — deliberately NOT in protectedPages (no login), and
// registered long before the /api no-store middleware + /api/v1 router mounts,
// which a bare app.get("/api") cannot shadow anyway. Express's non-strict
// routing also matches "/api/".
app.get("/api", (_req, res) => {
  res.set("Cache-Control", "no-store");
  // root + relative name, not one absolute path: sendFile applies its
  // dotfile denial to EVERY segment of a rootless path, so a checkout under
  // a dot-directory (a .claude worktree) 404s the file. With root set, only
  // the name itself is checked — the dashServer.ts dash.html pattern.
  res.sendFile("api.html", { root: path.resolve(__dirname, "..", "public") });
});

// HTTP → HTTPS redirect lived here in pre-Phase-4 Node-HTTPS mode. After
// Phase 4, nginx owns redirects (configured in deploy/nginx/polaris.conf
// via the optional `listen 80;` server block operators can enable); local
// dev runs HTTP-only on 127.0.0.1 so there's nothing to redirect from.

// Inactivity timeout — check and update last activity on every authenticated request
app.use(async (req, res, next) => {
  if (req.session?.userId) {
    const settings = await getSsoSettings().catch(() => ({ autoLogoutMinutes: 0 }));
    if (settings.autoLogoutMinutes > 0) {
      const lastActivity = req.session.lastActivity || 0;
      const idleMs = Date.now() - lastActivity;
      if (lastActivity > 0 && idleMs > settings.autoLogoutMinutes * 60 * 1000) {
        req.session.destroy(() => {});
        if (req.path.startsWith("/api/")) {
          return res.status(401).json({ error: "Session expired due to inactivity" });
        }
        // An idle timeout has to END somewhere — on the form-less signed-out
        // page, not on /login.html, which under "Skip login page" would hand
        // the unattended screen a fresh session via a silent SSO round-trip.
        return res.redirect("/signed-out.html?reason=inactivity");
      }
    }
    req.session.lastActivity = Date.now();
  }
  next();
});

// Mobile UA redirect — phone-class user-agents that hit the dashboard root
// get bounced to /mobile.html, which is the dedicated phone SPA. We only
// redirect "/" and "/index.html" — every other page (assets, subnets, the
// SSO callback handler, etc.) stays untouched so phones can still access
// the desktop UI directly when they need to. The `?desktop=1` query param
// is the escape hatch the mobile app uses on its "Desktop view" link.
//
// `Mobile` covers Chrome/Firefox on phones (including every Android phone
// browser — Android phone UAs always carry the `Mobile` token, which is
// also why the old `Android.*Mobile` alternative was redundant and a
// polynomial-ReDoS hazard on attacker-supplied UA strings), and
// `iPhone`/`iPod` covers Safari on iPhone. iPad is intentionally excluded —
// modern iPad Safari requests desktop layouts by default, and the desktop
// UI works fine on a tablet-class screen.
const PHONE_UA_REGEX = /(Mobile|iPhone|iPod)/i;
app.use((req, res, next) => {
  if (req.path !== "/" && req.path !== "/index.html") return next();
  if (req.query.desktop === "1") return next();
  const ua = req.get("user-agent") || "";
  if (PHONE_UA_REGEX.test(ua)) {
    return res.redirect("/mobile.html");
  }
  return next();
});

// Protect dashboard pages — redirect unauthenticated users to login
const protectedPages = ["/", "/index.html", "/ipam.html", "/blocks.html", "/subnets.html", "/reservations.html", "/users.html", "/integrations.html", "/assets.html", "/events.html", "/notifications.html", "/automations.html", "/server-settings.html", "/map.html", "/appmap.html", "/alert-ack.html"];

// Page-level gating — each protected page requires at least `read` on the
// matching function key. Maps to the same matrix the API guards use, so
// hiding a page also hides the API surface it consumes. A user without
// the requisite permission bounces to "/". Pages not in the map are
// reachable to any authenticated user (the per-tile cards / API requests
// handle their own permission state).
//
// `anyOf` covers a page whose content spans several function keys and is
// usable with any ONE of them — IPAM is IP Blocks + Networks, and a role
// granted only one of the two still has a tab to land on (public/js/ipam.js
// hides the other tab and refuses to default onto it). Keep each entry in
// lockstep with the matching NAV_ITEMS gate in public/js/app.js: the nav gate
// is what stops the sidebar advertising the page, this one is what stops a
// typed URL or a stale bookmark landing on a shell that can only 403.
type PagePermission =
  | { key: string; level: "read" | "write" }
  | { anyOf: { key: string; level: "read" | "write" }[] };
const pageRequiredPermission: Record<string, PagePermission> = {
  "/users.html":           { key: "users",                level: "read" },
  "/integrations.html":    { key: "integrations",         level: "read" },
  // /notifications.html stays gated forever — already-delivered web-push
  // payloads deep-link to it (Automations rename, 2026-07). Both pages gate on
  // automationManagement since the Alerts LIST left the page (an alert-only
  // viewer following an old deep link bounces to "/", where the Active Alerts
  // widget lives).
  "/notifications.html":   { key: "automationManagement", level: "read" },
  "/automations.html":     { key: "automationManagement", level: "read" },
  // `credentials=write` joins the floor with the ownership dimension on that
  // key (2026-09-04): a role granted "add credentials, edit your own" has to
  // be able to REACH the Credentials tab, and it lives on this page. The page
  // JS already hides every other tab from a non-admin, so this widens the
  // door to exactly the tab the grant is about.
  "/server-settings.html": { anyOf: [{ key: "serverSettingsSystem", level: "read" }, { key: "credentials", level: "write" }] },
  "/appmap.html":          { key: "applicationMap",       level: "read" },
  // Added 2026-08 alongside the deviceMap=read floor on the /map API mount.
  // Without it a deviceMap=none role could still load the page shell (the nav
  // entry is hidden, but the URL is typeable) and sit on an empty map issuing
  // 403s — the same "gate the page and the API it consumes together" rule the
  // rest of this map follows.
  "/map.html":             { key: "deviceMap",            level: "read" },
  // Added 2026-08-20 with the sidebar nav gates. These three pages were
  // advertised in the nav to every authenticated session and were reachable
  // by URL regardless of the matrix, so a role with none on them loaded the
  // shell and got a bare "Forbidden" from the first list fetch.
  "/ipam.html":            { anyOf: [{ key: "ipBlocks", level: "read" }, { key: "subnets", level: "read" }] },
  "/assets.html":          { key: "assets",               level: "read" },
  "/events.html":          { key: "events",               level: "read" },
  // The page an emailed / pushed Acknowledge button lands on. `read`, not
  // `write`: someone who may see alerts but not acknowledge them should reach
  // the page and be told so, rather than being bounced to "/" with no
  // explanation of where the link they followed went (business rule 25).
  "/alert-ack.html":       { key: "alerts",               level: "read" },
};
const PERM_RANK = { none: 0, read: 1, write: 2, fullwrite: 3 } as const;

// ─── "Skip login page" → where an unauthenticated visitor is sent ───────────
// Honors either configured provider — SAML (Azure) takes precedence, OIDC is
// the fallback — and answers null when the flag is off or neither provider
// resolves. FAILS OPEN (null) on a settings read error: a DB blip must not
// make the login page unreachable, the isLoginSourceAllowed posture.
async function skipLoginSsoTarget(): Promise<string | null> {
  try {
    const settings = await getSsoSettings();
    if (!settings.skipLoginPage) return null;
    if (await isAzureSsoConfiguredAsync()) return "/api/v1/auth/azure/login?prompt=none";
    if (await isOidcEnabled()) return "/api/v1/auth/oidc/login";
    return null;
  } catch {
    return null;
  }
}

// ─── /login.html under "Skip login page" ────────────────────────────────────
// The setting used to redirect PROTECTED pages only, which left the form one
// typed URL away for anyone, on any network — "skip" read as "hide from
// navigation", and operators expected "hide". So an unauthenticated GET of
// /login.html now goes to SSO too, UNLESS the request says why the form has
// to be drawn. Two query keys do that, and each exists to stop a loop or a
// lockout:
//   ?error=…      an SSO attempt just failed and bounced here (every SAML /
//                 OIDC / App Proxy failure redirect carries it) — redirecting
//                 again would ping-pong between Polaris and the IdP forever.
//   ?local=1      the anti-lockout path: local and LDAP accounts, and the way
//                 back in when the IdP is down. The Session tab's hint names
//                 this URL — it is deliberately guessable, not a secret; the
//                 source-IP gate above is what restricts WHO can reach the
//                 form, and it runs first, so an out-of-scope visitor is
//                 dropped before this redirect can tell them anything.
// A LOGOUT never lands here at all. Every desktop logout landing — account
// menu, inactivity timer, the server-side idle check above — is
// /signed-out.html, a page with no form whose Sign in button opens the bare
// /login.html, so this middleware decides what happens next: SSO when skip
// is on, the form when it is off. Landing a logout on /login.html directly
// would let a silent prompt=none provider sign the operator straight back in
// and make Logout look broken. The phone's counterpart is the one-shot
// sessionStorage marker in mobile/auth.js.
// /login.html stays out of protectedPages: it must never be gated on a
// session, and the SSO failure routes rely on it being reachable.
const LOGIN_FORM_QUERY_KEYS = ["error", "local"];
app.use(async (req, res, next) => {
  if (req.path !== "/login.html" || req.session?.userId) return next();
  if (LOGIN_FORM_QUERY_KEYS.some(k => Object.prototype.hasOwnProperty.call(req.query, k))) return next();
  const ssoTarget = await skipLoginSsoTarget();
  if (ssoTarget) return res.redirect(ssoTarget);
  return next();
});

app.use(async (req, res, next) => {
  if (!protectedPages.includes(req.path)) return next();
  if (!req.session?.userId) {
    // Remember where they were going BEFORE choosing how to bounce them —
    // every branch below (App Proxy, skip-login SSO, the login page) comes
    // back through a route that consumes this. Without it an emailed
    // Acknowledge link lands the reader on the dashboard after they sign in,
    // with nothing left of the alert they were asked to look at.
    rememberLoginTarget(req, res, req.originalUrl);
    // Entra App Proxy silent auto-login — highest precedence: identity
    // headers surviving the strip middleware mean this request definitively
    // came through an allowlisted connector, and the user already passed
    // Entra pre-authentication, so they must never see the login page. The
    // login route re-validates trust and, on any failure, redirects to
    // /login.html (NOT in protectedPages) so this can never loop. Inherent
    // to seamless SSO (same as skipLoginPage): navigating to any protected
    // page after logout re-establishes the session.
    if (await isEntraProxyLoginAvailable(req).catch(() => false)) {
      return res.redirect("/api/v1/auth/entra-proxy/login?next=" + encodeURIComponent(req.originalUrl));
    }
    // Skip login page: redirect unauthenticated users straight to SSO. The
    // flag is only ever set by an SSO-authenticated admin (see the guard on
    // PUT /auth/azure/settings), so reaching here normally resolves a
    // provider; the final /login.html catch covers the edge case where SSO
    // was torn down after the flag was set (the login-page middleware above
    // falls through to the form for the same reason, so this cannot loop).
    const ssoTarget = await skipLoginSsoTarget();
    if (ssoTarget) return res.redirect(ssoTarget);
    return res.redirect("/login.html");
  }
  const required = pageRequiredPermission[req.path];
  if (required) {
    // Old-session self-heal: a session issued before the dynamic-roles
    // cutover has `userId` but no `roleSnapshot`, so the lookup below
    // would silently return "none" and bounce the operator home. Defer
    // to `ensureRoleSnapshot` which loads the user's role from
    // DB and stamps the session in place. One DB hit per surviving old
    // session; the snapshot path is hot after that.
    const { ensureRoleSnapshot, permissionOf } = await import("./api/middleware/permissions.js");
    const snap = await ensureRoleSnapshot(req).catch(() => null);
    const perms = (snap?.permissions ?? req.session.roleSnapshot?.permissions ?? {}) as Record<string, "none" | "read" | "write" | "fullwrite">;
    // permissionOf resolves pre-rename snapshot keys (notifications → alerts)
    // so live sessions survive the Automations RBAC rename without re-login.
    const alternatives = "anyOf" in required ? required.anyOf : [required];
    const permitted = alternatives.some(
      alt => PERM_RANK[permissionOf(perms, alt.key)] >= PERM_RANK[alt.level],
    );
    if (!permitted) {
      return res.redirect("/");
    }
  }
  return next();
});

// Legacy IPAM URL redirects. /blocks.html and /subnets.html were folded
// into /ipam.html with tabs in the 2026-05 dashboard rework. We serve a
// tiny HTML stub that loads an external script which does the redirect
// client-side so any existing fragment (e.g. /subnets.html#ip=<sid>@<ip>
// from the assets-page deep link) is preserved across the hop —
// server-side 302 would either drop the original fragment (when the
// Location carries one) or fail to set the tab (when it doesn't), and we
// can't see the fragment server-side. The script lives in an external
// file (public/js/legacy-ipam-redirect.js) because the strict CSP
// scriptSrc: 'self' blocks inline <script> blocks — without the external
// file the stub would render blank and never redirect. Must precede
// express.static so the stubs win over the still-present
// public/blocks.html and public/subnets.html files.
function legacyIpamRedirect() {
  return (_req: any, res: any) => {
    res.set("Cache-Control", "no-store");
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Polaris</title></head><body><script src="/js/legacy-ipam-redirect.js"></script></body></html>`);
  };
}
app.get("/blocks.html", legacyIpamRedirect());
app.get("/subnets.html", legacyIpamRedirect());

// Automations rename (2026-07): the page moved from /notifications.html to
// /automations.html. This redirect is PERMANENT surface — already-delivered
// web-push payloads deep-link to the old URL forever. A 302 (not 301) so a
// future re-shuffle isn't cached by browsers; no fragment concerns here (push
// deep links use query-less plain URLs). The page-gate middleware above ran
// first, so only authorized users reach this hop.
app.get("/notifications.html", (_req, res) => {
  res.redirect("/automations.html");
});

// PWA manifest + home-screen icons for the mobile SPA. Unauthenticated by
// design (see the header comment in pwa.ts — a <link rel="manifest"> is
// fetched with credentials omitted, so a gated manifest 401s for everyone).
// Must precede express.static: the manifest is generated from branding, and
// the icons are rasterized on demand, so neither is a file on disk.
app.use(pwaRouter);

// Serve uploaded logos from the state directory. On legacy installs (no
// POLARIS_STATE_DIR set) this resolves to <project>/public/uploads — the
// same files the express.static(public) mount below also serves, so the
// explicit mount is a redundant no-op. On the Docker image it points at
// /app/state/public/uploads so logos persist across container rebuilds.
app.use("/uploads", express.static(UPLOADS_DIR));
app.use(express.static(path.resolve(__dirname, "..", "public")));

// Health check. Open by default because the first-run setup wizard polls
// this endpoint (from localhost) to detect when the main app has come up.
// Set HEALTH_TOKEN=<string> in .env to require `Authorization: Bearer <token>`
// on the endpoint — useful when Polaris is public-facing and you want to
// limit health pings to your own monitoring system.
app.get("/health", (req, res) => {
  const expected = process.env.HEALTH_TOKEN;
  if (expected) {
    const auth = req.get("authorization") || "";
    const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (supplied !== expected) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  res.json({ status: "ok" });
});

// Prometheus metrics endpoint. Same Bearer-token convention as /health: open
// by default, gated by METRICS_TOKEN when set. Exports default Node.js
// process / event-loop metrics plus Polaris-specific monitor / probe
// histograms and counters defined in src/metrics.ts.
app.get("/metrics", async (req, res) => {
  const expected = process.env.METRICS_TOKEN;
  if (expected) {
    const auth = req.get("authorization") || "";
    const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (supplied !== expected) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  const { contentType, body } = await renderMetrics();
  res.setHeader("Content-Type", contentType);
  res.send(body);
});
// API responses are session/state-dependent and must never be cached. Without
// this header, browsers fall back to heuristic caching of JSON responses,
// which surfaces visibly when /auth/me gets cached pre-login and then
// re-served as a 304 after login completes — the mobile flow then thinks
// the user isn't authenticated and bounces back to the login screen.
// `no-store` disables both browser cache AND any intermediate proxy cache.
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use("/api/v1", router);
app.use(errorHandler);

export async function startApp(): Promise<void> {
  // Boot-time Prisma-client-vs-DB schema check. Fails fast with a clear
  // recovery message when the running client references columns the
  // database doesn't have (or vice versa). Runs before listen() in EVERY role
  // so a broken deploy doesn't run workers against a mismatched schema either.
  await runSchemaSanityCheck();

  // Dash wallboard listener (its own small Express app on POLARIS_DASH_PORT).
  // Boots for the dedicated dash role AND under "all" so `npm run dev` serves
  // /dash without extra setup. Bind failure is fatal for the pure dash role
  // (the listener is the process's only purpose — let systemd cycle it) but
  // only a warning under "all", where a dev port conflict must not take down
  // the main app.
  if (cfg.runsDashListener) {
    try {
      const { startDashServer } = await import("./dash/dashServer.js");
      await startDashServer();
    } catch (err: any) {
      if (!cfg.runsHttp) throw err;
      logger.warn({ err: err?.message }, "Dash wallboard listener failed to start; main app continues");
    }
  }

  // Non-HTTP roles (monitor / discovery / dash) don't bind the main port —
  // their pg-boss workers + intervals (or the dash listener above) keep the
  // event loop alive.
  if (!cfg.runsHttp) {
    logger.info({ role: cfg.role }, "Non-HTTP role — skipping main Express listen");
    return;
  }

  // Phase 4: Node HTTPS is gone. Polaris always listens HTTP-only.
  //   - Proxy mode (POLARIS_PROXY_CERT_PATH set): nginx terminates TLS on
  //     443 and proxies to 127.0.0.1:PORT — bind localhost-only so nothing
  //     else on the network can reach us.
  //   - "all" mode (POLARIS_ROLE unset, npm run dev): bind all interfaces
  //     on PORT for dev ergonomics. No HTTPS, no cert, no Setting.https.
  // PORT picks env override > 3000 default; no more Setting.https.httpPort
  // fallback since the Setting key was retired in this same release.
  const PORT_RAW = process.env.PORT ?? 3000;
  const PORT = typeof PORT_RAW === "number" ? PORT_RAW : Number.parseInt(String(PORT_RAW), 10) || 3000;
  const httpServer = isProxyMode()
    ? app.listen(PORT, "127.0.0.1", () => {
        logger.info({ port: PORT, bind: "127.0.0.1" }, "Polaris server listening (proxy mode)");
      })
    : app.listen(PORT, () => {
        logger.info({ port: PORT }, "Polaris server listening (dev / all-role HTTP-only)");
      });
  // Attach the Polaris Agent WebSocket upgrade handler. Same server
  // surface as the REST API — agents reach /api/v1/agents/ws over the
  // same port and (in production) the same HTTPS cert their pin verifies.
  const { attachAgentWsUpgradeHandler } = await import("./api/routes/agentsWs.js");
  attachAgentWsUpgradeHandler(httpServer);
  // Start the cross-process command-wake listener so an enqueued script run
  // (from any process) can push a "commands-pending" frame to the agent's WS
  // session held here. Best-effort — agents still poll as the guaranteed floor.
  const { startCommandWakeListener } = await import("./services/agentChannelService.js");
  await startCommandWakeListener();
}

/**
 * Dynamically import the background-job modules appropriate to this role.
 * Importing a job module runs its self-start side effect, so gating the
 * imports is what gates the jobs. All singleton schedulers + one-shot
 * migrations are pinned to the web/all role (runsSchedulers / runsMigrations);
 * monitor and discovery roles import none of them. Order mirrors the historical
 * static-import order; each job's own async work runs concurrently as before.
 */
async function startBackgroundJobs(cfg: RoleConfig): Promise<void> {
  const importJob = async (path: string): Promise<void> => {
    try { await import(path); }
    catch (err: any) { logger.warn({ err: err?.message, job: path }, "background job import failed"); }
  };

  // Install the operator's Sources-column (learned-location) priority into this
  // process's projection before anything projects. Every role does this: the
  // web role projects on the asset-detail + agent-enroll paths, the discovery
  // role on every sync. Discovery additionally re-reads it per run so a later
  // edit lands without a restart. Never throws — falls back to the default order.
  try {
    const { refreshProjectionPriority } = await import("./services/assetSourcePriorityService.js");
    await refreshProjectionPriority();
  } catch (err: any) {
    logger.warn({ err: err?.message }, "asset source priority refresh failed; using default order");
  }

  // Warm the asset-type registry + its inference rules on EVERY role, for the
  // same reason the priority refresh above is every-role: `seedAssetTypes`
  // runs only where `runsMigrations` is true (web / all), so in the split-role
  // layout the DISCOVERY process — the one that actually types devices — would
  // otherwise never load an operator's rules, and every run would fall back to
  // the shipped defaults with nothing saying so. Discovery re-reads it per run
  // as well, so an edit lands without a restart. Never throws.
  try {
    const { refreshCache } = await import("./services/assetTypeService.js");
    await refreshCache();
  } catch (err: any) {
    logger.warn({ err: err?.message }, "asset type registry refresh failed; using shipped matching rules");
  }

  if (cfg.runsMigrations) {
    // One-shot startup migrations / seeds / backfills — idempotent, marker-keyed.
    for (const p of [
      "./jobs/normalizeManufacturers.js",
      "./jobs/seedAssetTypes.js",
      "./jobs/seedManufacturerProfiles.js",
      "./jobs/backfillManufacturerProfileMemoryComposition.js",
      "./jobs/migrateMonitorSettingsHierarchy.js",
      "./jobs/renameMonitorClassKeys.js",
      "./jobs/migrateSampleRetentionToEntities.js",
      "./jobs/migrateMonitorStatusRename.js",
      "./jobs/migrateAutoMonitorInterfacesShape.js",
      "./jobs/migrateSystemInfoCadenceLinkage.js",
      "./jobs/migrateMonitorSettingsPerClass.js",
      "./jobs/backfillAssetSources.js",
      "./jobs/scrubLegacySidGuidTags.js",
      "./jobs/backfillFortigateEndpointSources.js",
      "./jobs/fixInfraAssetTypes.js",
      "./jobs/mergeFortiswitchEndpointGhosts.js",
      "./jobs/backfillDependencyTree.js",
      "./jobs/backfillMonitorStatusChangedAt.js",
      "./jobs/backfillInterfaceInventory.js",
      "./jobs/rasterizeStoredSvgIcons.js",
      "./jobs/clampAssetAcquiredAt.js",
      // Deliberately not marker-guarded — one indexed UPDATE that keeps
      // "an unmonitorable status cannot be monitored" true across upgrades
      // and raw-SQL writers. See its header.
      "./jobs/clampMonitoredForStatus.js",
      // Same posture: brings pre-ceiling missed-poll buckets inside
      // MAX_MISSED_POLL_BUCKET so an outage's length can no longer decide how
      // long recovery takes, and retires the dormant awaitingRecoveryConfirm
      // bit. See its header.
      "./jobs/clampFailureBucket.js",
      "./jobs/bootstrapProxyConfig.js",
      "./jobs/migrateAutomationRuleShape.js",
      "./jobs/migrateContactFilterShape.js",
      "./jobs/migrateTagFilterShape.js",
      // Clears NotificationRule.cooldownSec fleet-wide — the "Re-notify
      // cooldown" control was retired from the wizard, and a value nothing on
      // screen states must not keep governing when an automation may re-fire.
      "./jobs/clearNotificationCooldowns.js",
      "./jobs/seedBaselineAutomations.js",
      // Seals previously-plaintext secrets in Credential / Integration /
      // NotificationChannel config + Setting values. Not marker-guarded: the
      // operator may set POLARIS_SECRET_KEY after this code lands, and the job
      // must pick that up on the next boot. See its header.
      "./jobs/backfillSecretEncryption.js",
      // Deliberately not marker-guarded — retries the subnet (blockId, cidr)
      // unique index every boot until the data allows it. See its header.
      "./jobs/enforceSubnetUniqueIndex.js",
      // Read-only advisory sweep: names stored polling methods that have no
      // collector behind them, which otherwise report a healthy tick forever
      // while collecting nothing. Not marker-guarded — the answer changes as
      // collectors land and as operators edit settings. See its header.
      "./jobs/auditPollingCapability.js",
    ]) await importJob(p);
  }

  if (cfg.runsSchedulers) {
    // Periodic schedulers + reconcilers — singletons; the monitor PRODUCER
    // (monitorAssets) lives here too (it publishes work the monitor-role
    // consumers drain; in cursor mode it runs the in-process loop).
    for (const p of [
      "./jobs/monitorAssets.js",
      "./jobs/expireReservations.js",
      "./jobs/pruneEvents.js",
      "./jobs/ouiRefresh.js",
      "./jobs/updateCheck.js",
      "./jobs/discoverySlowCheck.js",
      "./jobs/decommissionStaleAssets.js",
      "./jobs/flagStaleReservations.js",
      "./jobs/capacityWatch.js",
      "./jobs/platformLifecycleWatch.js",
      "./jobs/hostMetricsCollector.js",
      "./jobs/evaluateNotificationRules.js",
      "./jobs/escalateNotifications.js",
      "./jobs/deliverNotifications.js",
      "./jobs/runAutomationScripts.js",
      "./jobs/resolvePolarisPushedConflicts.js",
      "./jobs/resolveStaleReservationConflicts.js",
      "./jobs/reconcileInfraReservations.js",
      "./jobs/cleanupStaleDnsResolvedReleased.js",
      "./jobs/mergeDuplicateHostnameAssets.js",
      // Duplicate-address sweep (business rule 40) — raises/closes the
      // `duplicate-ip` Conflict flavour for two network-present assets
      // recording one IP. Scheduler role only: one grouped scan for the
      // fleet, not one per monitor replica.
      "./jobs/detectDuplicateIpAssets.js",
      // IP-keyed upstream sweep: MAC-less assets get their Last Seen Switch /
      // AP derived through the owning gate's ARP cache, since every MAC-keyed
      // writer of those columns can never reach them. Scheduler role only.
      "./jobs/resolveIpUpstreamChain.js",
      "./jobs/dependencyReconciler.js",
      "./jobs/maintenanceScheduler.js",
      "./jobs/retryQueuedReservationPushes.js",
      "./jobs/reconcileMapRegions.js",
      "./jobs/reconcileTagAssignments.js",
      "./jobs/reconcileAppMapAutoMap.js",
      "./jobs/reconcileDnsResolvedReservations.js",
      "./jobs/runSampleRollup.js",
      "./jobs/reclaimBloatedChunks.js",
      "./jobs/autoBuildAgents.js",
      "./jobs/discoveryRunReaper.js",
      // Automatic database backups on the operator's cadence. Default-OFF; the
      // tick is a cheap due-check until Server Settings → Maintenance →
      // Scheduled Backups is enabled. Scheduler role only, so a split-role
      // install takes one backup rather than one per monitor replica.
      "./jobs/scheduledBackup.js",
      // integrationConnectionTester DISABLED 2026-06-02: the 10-min synthetic
      // /sys/status probe fired false-positive `integration.test.failed`
      // warnings on FMG (a transient RPC -11 "no valid session" — session reap
      // or a concurrent call on the shared API-key session — which the tester
      // hardcodes to "Invalid or expired API token" and stamps as lastTestOk=
      // false). A manual Test Connection seconds later always succeeds. Probe
      // disabled here (file kept) pending the planned removal + health-derived-
      // from-real-discovery-traffic redesign. NOTE: with the probe off, nothing
      // auto-refreshes lastTestOk — a stuck `false` must be cleared by one
      // manual Test Connection (discovery scheduler still gates on lastTestOk).
      // "./jobs/integrationConnectionTester.js",
    ]) await importJob(p);
    // discoveryScheduler exports an explicit starter (it was refactored off the
    // self-start pattern so the discovery worker handler can be injected).
    startDiscoveryScheduler();
  }
}

export { app };
