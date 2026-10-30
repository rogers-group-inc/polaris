/**
 * src/dash/dashServer.ts — the Dash wallboard listener.
 *
 * A small standalone Express app serving an UNAUTHENTICATED, READ-ONLY
 * duplicate of the Dashboard page at /dash, in its own process
 * (POLARIS_ROLE=dash; also boots in-process under role "all" for dev).
 * nginx proxies `location /dash` here with a URI-preserving proxy_pass, so
 * this app serves everything natively under the /dash prefix and dev
 * direct-access (http://host:3001/dash) matches prod (https://host/dash).
 *
 * Access control, in middleware order (each layer is load-bearing):
 *   1. Operator kill-switch — the `dashConfig` Setting row (Server Settings →
 *      Web Server → Dash Wallboard). Disabled ⇒ 403 for everything. Read
 *      through a ~10s TTL cache, which is also the cross-process propagation
 *      delay for a toggle (the web process writes the row).
 *   2. Source-IP gate — `ipScope` resolves to RFC1918+loopback (default),
 *      "all" (no gate), or "custom" (must match an allow-list CIDR). An
 *      UNAUTHORIZED source is DROPPED (socket destroyed, no response) so a
 *      scanner can't confirm the wallboard exists. Only as trustworthy as the
 *      `trust proxy` posture — nginx mode trusts the first hop's
 *      X-Forwarded-For; direct mode uses the socket address.
 *   3. GET/HEAD-only — every write verb 405s app-wide, which is also why no
 *      session/CSRF middleware is mounted at all.
 *   4. Permission identity — every API request is stamped with the seeded
 *      `readonly` Role's snapshot on req.roleSnapshot, so the mounted REAL
 *      route files (dashboard / reservations / map) enforce their existing
 *      requirePermission / hasPermission gates unmodified, resolving as a
 *      readonly caller. An exact-path allowlist (plus a prefix rule for the
 *      parameterized /weather/ proxy paths) in front of them caps the
 *      exposed surface to the handful of GETs the dashboard widgets call.
 *
 * The process performs NO writes on behalf of dash viewers — widget layout
 * customization persists in the viewer's browser localStorage.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type http from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import compression from "compression";
import dashboardRouter from "../api/routes/dashboard.js";
import reservationsRouter from "../api/routes/reservations.js";
import mapRouter from "../api/routes/map.js";
import weatherRouter from "../api/routes/weather.js";
import savedDashboardsRouter from "../api/routes/savedDashboards.js";
import { errorHandler } from "../api/middleware/errorHandler.js";
import { requirePermission } from "../api/middleware/permissions.js";
import { dashWeatherLimiter, makeRateLimiter } from "../api/middleware/rateLimits.js";
import { ipInScope } from "../utils/ipScope.js";
import { getDashSettings, type DashSettings } from "../services/dashSettingsService.js";
import {
  getReadonlyRoleIdentity,
  type DashRoleIdentity,
} from "../services/dashRoleSnapshotService.js";
import { buildHelmetOptions } from "../utils/securityHeaders.js";
import { resolveDashBind, resolveDashPort } from "../utils/dashConfig.js";
import { UPLOADS_DIR } from "../utils/paths.js";
import { resolveTrustProxy } from "../utils/trustProxy.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "..", "public");

/**
 * The complete API surface reachable through this listener (paths relative
 * to the /dash/api/v1 mount). Everything else 404s before touching a route
 * file. Keep in lockstep with what the widget modules + dash-boot.js fetch.
 */
const API_PATH_ALLOWLIST = new Set<string>([
  "/auth/me",
  "/server-settings/branding",
  "/dashboard/summary",
  "/dashboard/noc-summary",
  "/dashboard/filter-options",
  "/reservations/alerts",
  "/reservations/alerts/count",
  "/map/sites",
  // Published (public) dashboards a wallboard can be pinned to. The read
  // routes only; every write verb is already 405'd app-wide, and with no
  // session the list answers with public rows alone.
  "/saved-dashboards",
]);

/**
 * Prefix-matched additions to the exact-path allowlist above — needed for the
 * parameterized weather-proxy paths (/weather/radar/:frame/:z/:x/:y). Keep
 * this list to read-only, parameter-validated surfaces.
 */
const API_PREFIX_ALLOWLIST = ["/weather/", "/saved-dashboards/"];

/**
 * Whole-path patterns for parameterized reads that a prefix would over-admit.
 * The Device Map widget draws a FortiGate's topology (a single picked gate, or
 * a double-clicked one) from GET /map/sites/:id/topology — exactly that path:
 * the site-scoped endpoint search beside it stays unreachable here, and the
 * layout writes under it are 405'd regardless.
 */
const API_PATTERN_ALLOWLIST = [/^\/map\/sites\/[^/]+\/topology$/];

/**
 * Is this source IP allowed under the current scope? "all" → always; "custom"
 * → matches one of the allow-list CIDRs; "rfc1918" (default) → RFC1918 or
 * loopback. The `enabled` flag is checked separately by the caller.
 *
 * Delegates to the shared resolver in utils/ipScope.ts, which local login
 * access (loginAccessService) gates on too. The subtleties are what must not
 * drift between the two surfaces: allowedCidrs are save-time-normalized IPv4
 * CIDRs, so the general v4+v6 matcher unwraps mapped ::ffff: sources, never
 * matches a real IPv6 source against a v4 entry, and fails closed on an empty
 * or invalid list.
 */
export function isSourceAllowed(ip: string, settings: DashSettings): boolean {
  return ipInScope(ip, settings.ipScope, settings.allowedCidrs);
}

/**
 * Silently drop a request from an unauthorized source: destroy the socket
 * with no HTTP response. `req.socket` may already be gone on an aborted
 * connection, so guard the destroy.
 */
function dropConnection(req: Request): void {
  try {
    req.socket?.destroy();
  } catch {
    /* connection already torn down */
  }
}

export interface BuildDashAppOptions {
  /** Test seam — replaces the readonly-Role DB lookup. */
  identityProvider?: () => Promise<DashRoleIdentity>;
  /** Test seam — replaces the dashConfig Setting-row lookup. */
  settingsProvider?: () => Promise<DashSettings>;
}

export function buildDashApp(opts: BuildDashAppOptions = {}): express.Express {
  const identityProvider = opts.identityProvider ?? getReadonlyRoleIdentity;
  const settingsProvider = opts.settingsProvider ?? getDashSettings;

  const app = express();

  // Same trust-proxy resolution as the main app — req.ip must be the real
  // client behind nginx for the IP gate to mean anything.
  const trustProxy = resolveTrustProxy();
  if (trustProxy !== undefined) {
    app.set("trust proxy", /^\d+$/.test(String(trustProxy)) ? Number(trustProxy) : trustProxy);
  }

  // ── 1+2. Operator kill-switch, then the source-IP gate ────────────────────
  // Scope resolves three ways: "all" (no gate), "rfc1918" (private + loopback
  // only), "custom" (must match one of the operator's allow-list CIDRs).
  //
  // An unauthorized SOURCE IP is DROPPED, not answered: we destroy the socket
  // with no HTTP response, so a scanner from a disallowed network gets a bare
  // connection reset rather than a 403 that would confirm the wallboard exists.
  // (Behind nginx the app only sees nginx's connection, so a drop surfaces to
  // the remote client as a 502 — still no confirmation from Polaris. The
  // operator chose app-level gating over nginx allow/deny; a true edge silent-
  // drop would be a firewall rule.) The disabled state still returns a plain
  // 403 so an admin configuring the toggle gets a clear message.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    settingsProvider()
      .then((settings) => {
        if (!settings.enabled) {
          next(
            new AppError(
              403,
              "The Dash wallboard is disabled — an administrator can enable it under Server Settings → Web Server",
            ),
          );
          return;
        }
        if (isSourceAllowed(req.ip ?? "", settings)) {
          next();
          return;
        }
        dropConnection(req);
      })
      .catch(next);
  });

  // ── Security headers / compression ────────────────────────────────────────
  app.use(helmet(buildHelmetOptions()));
  app.use(compression());

  // ── 3. Read-only enforcement: GET/HEAD only, app-wide ─────────────────────
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next(new AppError(405, "The Dash wallboard is read-only"));
      return;
    }
    next();
  });

  // Weather-proxy requests ride their own generous limiter (a single radar
  // refresh is hundreds of small tile GETs — it would exhaust the general
  // budget in one load); everything else keeps the tight wallboard ceiling.
  const generalLimiter = makeRateLimiter({
    windowMs: 5 * 60 * 1000,
    max: 600,
    message: "Too many requests to the Dash wallboard. Please slow down.",
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    const limiter = req.path.startsWith("/dash/api/v1/weather/") ? dashWeatherLimiter : generalLimiter;
    limiter(req, res, next);
  });

  // ── Page ───────────────────────────────────────────────────────────────────
  // Dev nicety when hitting the listener directly: / lands on the wallboard.
  app.get("/", (_req, res) => res.redirect("/dash"));
  app.get(["/dash", "/dash/"], (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    // root + relative name (not one absolute path): send() rejects dot
    // segments ANYWHERE in a rootless absolute path, which 404s the page when
    // Polaris itself is checked out under a dotted directory. With root set,
    // the dotfile check applies only to the relative part.
    res.sendFile("dash.html", { root: PUBLIC_DIR });
  });

  // ── 4. API: readonly identity + exact-path allowlist + the real routers ──
  const api = express.Router();

  api.use((req: Request, res: Response, next: NextFunction) => {
    // Blanket no-store — the radar-tile handler overrides with an immutable
    // max-age (frame tiles never change; see weather.ts).
    res.setHeader("Cache-Control", "no-store");
    if (
      !API_PATH_ALLOWLIST.has(req.path) &&
      !API_PREFIX_ALLOWLIST.some((prefix) => req.path.startsWith(prefix)) &&
      !API_PATTERN_ALLOWLIST.some((pattern) => pattern.test(req.path))
    ) {
      next(new AppError(404, "Not found"));
      return;
    }
    identityProvider()
      .then((identity) => {
        req.roleSnapshot = identity.snapshot;
        next();
      })
      .catch(next);
  });

  // Synthetic identity — mirrors the GET /api/v1/auth/me response shape
  // (src/api/routes/auth.ts) so dash-boot.js parses it exactly like app.js
  // parses the real endpoint. The "user" is the readonly role itself.
  api.get("/auth/me", (req: Request, res: Response, next: NextFunction) => {
    identityProvider()
      .then(({ snapshot, regionTags }) => {
        res.json({
          authenticated: true,
          username: "dash",
          authProvider: "local",
          role: { ...snapshot, color: null },
          regionTags: { user: [], role: regionTags, group: [], effective: regionTags },
          otherTags: { user: [], role: [], group: [], effective: [] },
        });
      })
      .catch(next);
  });

  // Branding is public on the main app too — same dynamic-import pattern as
  // src/api/router.ts so the serverSettings module graph loads on demand.
  api.get("/server-settings/branding", async (_req, res, next) => {
    try {
      const { getBranding } = await import("../api/routes/serverSettings.js");
      res.json(await getBranding());
    } catch (err) {
      next(err);
    }
  });

  api.use("/dashboard", dashboardRouter);
  api.use("/reservations", reservationsRouter);
  // Same deviceMap=read floor the main router applies, so the two mounts of
  // mapRouter agree. requirePermission reads req.roleSnapshot first, which the
  // identity middleware above already stamped with the built-in readonly Role
  // (deviceMap=read in every seeded matrix), so this passes on a stock install
  // and fails closed if an operator ever edits that role down.
  api.use("/map", requirePermission("deviceMap", "read"), mapRouter);
  api.use("/weather", weatherRouter);
  // Published dashboards. The router carries its own savedDashboards=read
  // floor, satisfied by the built-in readonly role this listener answers as,
  // and hands a session-less caller PUBLIC rows only — a wallboard viewer can
  // load a published screen and, being GET-only here, can never save one.
  api.use("/saved-dashboards", savedDashboardsRouter);

  app.use("/dash/api/v1", api);

  // Static assets for direct (non-nginx) access — dev and single-process
  // installs load /js, /css, vendor bundles, and the logo straight from this
  // listener. Behind nginx these same files are served by the web process via
  // `location /`. index:false keeps / from serving the authenticated SPA's
  // index.html here. /uploads carries the operator's custom branding logo
  // (branding.logoUrl = /uploads/<file>), which dash-boot.js applies as the
  // page favicon — mirror the main app's unauthenticated /uploads mount so
  // the logo also resolves when this listener is hit directly.
  app.use("/uploads", express.static(UPLOADS_DIR));
  app.use(express.static(PUBLIC_DIR, { index: false }));

  app.use(errorHandler);

  return app;
}

export interface DashServer {
  server: http.Server;
  port: number;
}

/**
 * Bind the dash listener. Resolves once listening; rejects on bind failure
 * (the caller decides whether that is fatal — it is for the pure dash role,
 * but only a warning under role "all" where the main listener still works).
 */
export async function startDashServer(): Promise<DashServer> {
  const app = buildDashApp();
  const port = resolveDashPort();
  const bind = resolveDashBind();

  const server = await new Promise<http.Server>((resolve, reject) => {
    const s = app.listen(port, bind, () => {
      s.removeListener("error", reject);
      resolve(s);
    });
    s.once("error", reject);
  });

  server.on("error", (err) => {
    logger.error({ err: (err as Error).message, port, bind }, "Dash wallboard listener errored");
  });

  logger.info({ port, bind, path: "/dash" }, "Dash wallboard listener bound");
  return { server, port };
}
