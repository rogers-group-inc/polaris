/**
 * tests/unit/guardedFetch.test.ts — business rule 110, re-scan F82: the
 * webhook and api_call channels connect through a lookup netGuard judges on
 * the socket, so a name that resolves to loopback / link-local AT CONNECT TIME
 * is refused even if an earlier check saw a public answer (DNS rebinding).
 *
 * Node never calls `lookup` for an IP literal — the channels' own
 * assertOutboundHostAllowed refuses those up front — so this drives a NAME.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { guardedFetch } from "../../src/utils/guardedFetch.js";

let server: Server;
let port = 0;
let hits = 0;

beforeAll(async () => {
  server = createServer((_req, res) => { hits++; res.end("ok"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("guardedFetch", () => {
  it("refuses a name that resolves to loopback when the connection is made", async () => {
    const before = hits;
    let code: string | undefined;
    try {
      await guardedFetch(`http://localhost:${port}/hook`, { method: "POST", body: "{}" });
    } catch (err: any) {
      code = err?.cause?.code ?? err?.code;
    }
    expect(code).toBe("BLOCKED_HOST");
    expect(hits).toBe(before); // nothing reached the listener
  });
});
