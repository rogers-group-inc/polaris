/**
 * tests/unit/tlsDispatcher.test.ts — per-connection TLS relaxation
 *
 * These tests DISPATCH against a real local HTTP server rather than a stubbed
 * `fetch`, and that is the whole point of the file.
 *
 * The previous version asserted only that `insecureTlsDispatcher()` returns an
 * undici `Agent` with a `dispatch` method. Both were true on 2026-09-09 when
 * `chore(deps): undici 8` moved the userland range 6 -> 8 while Node kept
 * bundling undici 7 for its global `fetch` — and every FortiManager and
 * standalone-FortiGate request with `verifySsl: false` still broke at the
 * transport with `UND_ERR_INVALID_ARG — invalid onRequestStart method`,
 * because undici 8's Agent rejects the v7 handler that Node's fetch hands it.
 * A dispatcher is only valid to the undici copy that created it; an
 * `instanceof` check cannot see that, and neither can typecheck or npm audit.
 * Only actually dispatching can.
 *
 * So: exercise `tlsFetch` end to end over loopback. A future major skew — or
 * anyone re-pairing this Agent with `globalThis.fetch` — fails here instead of
 * failing silently against a device.
 *
 * Plain HTTP is deliberate. The dispatcher is validated at DISPATCH time,
 * before any TLS handshake, so `http://` reproduces the skew exactly while
 * staying hermetic. Node has no API for generating a self-signed certificate,
 * so `rejectUnauthorized: false` actually relaxing verification is not
 * asserted here — that is covered by the FMG/FortiGate connection test
 * against real hardware.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Agent } from "undici";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { insecureTlsDispatcher, tlsFetch } from "../../src/utils/tlsDispatcher.js";

interface SeenRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: string;
}

let server: Server;
let base = "";
const seen: SeenRequest[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("insecureTlsDispatcher", () => {
  it("returns an undici Agent (usable as a fetch dispatcher)", () => {
    const d = insecureTlsDispatcher();
    expect(d).toBeInstanceOf(Agent);
    expect(typeof (d as Agent).dispatch).toBe("function");
  });

  it("is a singleton — repeated calls share one pooled agent", () => {
    expect(insecureTlsDispatcher()).toBe(insecureTlsDispatcher());
  });

  it("never mutates NODE_TLS_REJECT_UNAUTHORIZED (the global flip it replaces)", () => {
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    insecureTlsDispatcher();
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(before);
  });
});

describe("tlsFetch", () => {
  it("DISPATCHES with the insecure dispatcher — the undici-major skew regression", async () => {
    // verifySsl=false is the only branch that attaches the dispatcher, and the
    // only one that broke. Under a fetch/Agent major mismatch this rejects
    // with UND_ERR_INVALID_ARG before the request is ever sent.
    const res = await tlsFetch(`${base}/insecure`, { method: "GET" }, false);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("names the failure explicitly when the dispatcher is rejected", async () => {
    // Guards the diagnosis, not just the outcome: if this ever regresses, the
    // cause code says which class of bug it is.
    let cause: string | undefined;
    try {
      const res = await tlsFetch(`${base}/insecure-again`, { method: "GET" }, false);
      await res.text();
    } catch (err) {
      cause = (err as { cause?: { code?: string } })?.cause?.code;
    }
    expect(cause).not.toBe("UND_ERR_INVALID_ARG");
    expect(cause).toBeUndefined();
  });

  it("verifies normally when verifySsl is true or undefined (no dispatcher attached)", async () => {
    const onTrue = await tlsFetch(`${base}/verified`, { method: "GET" }, true);
    expect(onTrue.status).toBe(200);
    await onTrue.text();

    const onUndefined = await tlsFetch(`${base}/verified`, { method: "GET" }, undefined);
    expect(onUndefined.status).toBe(200);
    await onUndefined.text();
  });

  it("passes method, headers and body through untouched", async () => {
    seen.length = 0;
    const res = await tlsFetch(
      `${base}/jsonrpc`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
        body: JSON.stringify({ id: 1, method: "get" }),
      },
      false,
    );
    await res.text();
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe("/jsonrpc");
    expect(seen[0].authorization).toBe("Bearer tok");
    expect(JSON.parse(seen[0].body)).toEqual({ id: 1, method: "get" });
  });

  it("honours an AbortSignal on the insecure path", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      tlsFetch(`${base}/aborted`, { method: "GET", signal: controller.signal }, false),
    ).rejects.toThrow();
  });
});
