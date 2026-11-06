/**
 * tests/unit/metricsServer.test.ts
 *
 * Covers the standalone /metrics HTTP listener used by the monitor and
 * discovery roles in the multi-process split.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { startMetricsOnlyServer } from "../../src/utils/metricsServer.js";

async function fetchPath(port: number, path: string, token?: string): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  const body = await res.text();
  return { status: res.status, body };
}

describe("metricsServer", () => {
  let server: Server | null = null;
  const savedToken = process.env.METRICS_TOKEN;

  beforeEach(() => {
    delete process.env.METRICS_TOKEN;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    if (savedToken === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = savedToken;
  });

  it("serves Prometheus body on GET /metrics", async () => {
    const handle = await startMetricsOnlyServer(0);
    server = handle.server;
    const r = await fetchPath(handle.port, "/metrics");
    expect(r.status).toBe(200);
    // Default Node.js process metrics are always registered by collectDefaultMetrics().
    expect(r.body).toMatch(/process_cpu_seconds_total/);
  });

  it("returns 404 for any path other than /metrics", async () => {
    const handle = await startMetricsOnlyServer(0);
    server = handle.server;
    const r = await fetchPath(handle.port, "/health");
    expect(r.status).toBe(404);
  });

  it("enforces METRICS_TOKEN bearer when set", async () => {
    process.env.METRICS_TOKEN = "secret-abc";
    const handle = await startMetricsOnlyServer(0);
    server = handle.server;

    const noAuth = await fetchPath(handle.port, "/metrics");
    expect(noAuth.status).toBe(401);

    const wrong = await fetchPath(handle.port, "/metrics", "nope");
    expect(wrong.status).toBe(401);

    const ok = await fetchPath(handle.port, "/metrics", "secret-abc");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatch(/process_cpu_seconds_total/);
  });

  // CQ-B042: the token is read per request, not captured when the listener
  // binds — a token set (or rotated) afterwards takes effect on the next scrape.
  it("reads METRICS_TOKEN per request, not at bind", async () => {
    const handle = await startMetricsOnlyServer(0);
    server = handle.server;
    expect((await fetchPath(handle.port, "/metrics")).status).toBe(200);

    process.env.METRICS_TOKEN = "rotated-xyz";
    expect((await fetchPath(handle.port, "/metrics")).status).toBe(401);
    expect((await fetchPath(handle.port, "/metrics", "rotated-xyz")).status).toBe(200);
  });
});
