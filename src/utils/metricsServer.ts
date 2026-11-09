/**
 * src/utils/metricsServer.ts — standalone /metrics HTTP listener for the
 * non-HTTP roles (monitor, discovery) in the multi-process split.
 *
 * The web/all role exposes /metrics on its main Express listener (src/app.ts);
 * monitor + discovery don't bind any Express server, so without this tiny
 * helper their in-memory Prometheus registries are invisible to Prometheus.
 * That's the gap behind the "no data" panels for probe / work-duration /
 * sample-write / discovery / FMG-proxy-lane metrics whenever Polaris runs
 * split — every metric stamped from inside a monitor worker or discovery
 * consumer lives in a process Prometheus never scrapes.
 *
 * Boot is opt-in: only starts when POLARIS_METRICS_PORT is set, so single-
 * process and dev installs that scrape via the main HTTP listener are
 * unaffected. Binds 127.0.0.1 by default (override via POLARIS_METRICS_BIND)
 * because the typical deployment runs Prometheus on the same host. Bearer
 * gate is the same METRICS_TOKEN convention as the main /metrics handler so
 * scrape config is uniform across roles.
 */

import http from "node:http";
import { renderMetrics } from "../metrics.js";
import { logger } from "./logger.js";
import { bearerSatisfies, metricsToken } from "./endpointTokens.js";

export interface MetricsServer {
  /** Underlying http.Server — exposed so callers/tests can close it. */
  server: http.Server;
  /** Actual bound port (lookup helpful for tests that pass port=0). */
  port: number;
}

/**
 * Start a minimal HTTP listener that serves only `GET /metrics`. Any other
 * path returns 404. When the METRICS_TOKEN env var is set, requests must
 * carry a matching `Authorization: Bearer ...` header.
 *
 * Returns a promise that resolves once the listener is actually bound so the
 * caller can fail fast on port-in-use. Errors after bind (write errors etc.)
 * are logged but never crash the process — losing /metrics must not take
 * down a monitor worker.
 */
export async function startMetricsOnlyServer(
  port: number,
  bind: string = "127.0.0.1",
): Promise<MetricsServer> {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== "GET" || req.url !== "/metrics") {
        res.statusCode = 404;
        res.end();
        return;
      }
      // Read per request (not captured at bind) and compared in constant
      // time — the same gate as the web role's /metrics (utils/endpointTokens.ts).
      if (!bearerSatisfies(req.headers.authorization, metricsToken())) {
        res.statusCode = 401;
        res.end();
        return;
      }
      const { contentType, body } = await renderMetrics();
      res.setHeader("Content-Type", contentType);
      res.end(body);
    } catch (err) {
      logger.error({ err: (err as Error)?.message }, "metrics-only /metrics render failed");
      try {
        res.statusCode = 500;
        res.end();
      } catch {
        // socket already closed — nothing to do
      }
    }
  });

  server.on("error", (err) => {
    logger.error(
      { err: (err as Error).message, port, bind },
      "metrics-only HTTP listener errored",
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  logger.info({ port: boundPort, bind }, "metrics-only HTTP listener bound");
  return { server, port: boundPort };
}
