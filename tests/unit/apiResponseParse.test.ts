/**
 * tests/unit/apiResponseParse.test.ts
 *
 * Unit tests for the defensive response reader in public/js/api.js —
 * `_readResponseBody()` and `_proxyErrorMessage()`.
 *
 * These exist because `request()` used to call `res.json()` BEFORE checking
 * `res.ok`, so every response that wasn't JSON surfaced to the operator as
 * `Unexpected token '<', "<html> <h"... is not valid JSON`. Only a reverse
 * proxy can produce such a response here — the Express app answers every error
 * as JSON (src/api/middleware/errorHandler.ts) — so that toast was the sole
 * piece of evidence an operator had about a proxy-level failure, and it named
 * neither the status code nor the cause. A 502 from a restarting web role and a
 * 413 from nginx's 1 MB `client_max_body_size` were indistinguishable.
 *
 * api.js is a classic browser script (no module exports — it's loaded via a
 * plain <script src>), so we evaluate it in a Node vm context with stub globals
 * and pull the top-level function declarations off the context — the same
 * approach as tests/unit/appmapFilter.test.ts.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

/** Minimal stand-in for the parts of `Response` the reader touches. */
interface FakeResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

interface ThrownError extends Error {
  status?: number;
  bodyText?: string;
  data?: unknown;
}

let readResponseBody: (res: FakeResponse, fallbackMsg?: string) => Promise<unknown>;
let proxyErrorMessage: (status: number, text: string) => string;

/** A response whose body is `text`, with `ok` derived from the status. */
function resp(status: number, text: string): FakeResponse {
  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(text) };
}

/** Capture the error `_readResponseBody` throws for a given response. */
async function thrownBy(res: FakeResponse, fallbackMsg?: string): Promise<ThrownError> {
  try {
    await readResponseBody(res, fallbackMsg);
  } catch (err) {
    return err as ThrownError;
  }
  throw new Error("expected _readResponseBody to throw, but it resolved");
}

// Real nginx error pages — the exact shape the operator's toast was quoting.
const NGINX_502 = [
  "<html>",
  "<head><title>502 Bad Gateway</title></head>",
  "<body>",
  "<center><h1>502 Bad Gateway</h1></center>",
  "<hr><center>nginx/1.25.3</center>",
  "</body>",
  "</html>",
  "",
].join("\n");

const NGINX_413 = [
  "<html>",
  "<head><title>413 Request Entity Too Large</title></head>",
  "<body>",
  "<center><h1>413 Request Entity Too Large</h1></center>",
  "<hr><center>nginx/1.25.3</center>",
  "</body>",
  "</html>",
  "",
].join("\n");

beforeAll(() => {
  const src = readFileSync(resolve(__dirname, "../../public/js/api.js"), "utf8");

  // api.js guards its `window` writes with `typeof window !== "undefined"`, but
  // it reads `document`/`navigator` inside functions we never call. A bare
  // object for each is enough for the file to evaluate.
  const sandbox: Record<string, unknown> = {
    window: {},
    document: { getElementById: () => null, createElement: () => ({ style: {}, addEventListener: () => {} }) },
    navigator: {},
    fetch: () => Promise.reject(new Error("fetch is not used by these tests")),
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    setTimeout,
    clearTimeout,
    console,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(src, context, { filename: "api.js" });

  readResponseBody = sandbox._readResponseBody as typeof readResponseBody;
  proxyErrorMessage = sandbox._proxyErrorMessage as typeof proxyErrorMessage;

  expect(typeof readResponseBody, "api.js no longer declares _readResponseBody").toBe("function");
  expect(typeof proxyErrorMessage, "api.js no longer declares _proxyErrorMessage").toBe("function");
});

describe("_proxyErrorMessage", () => {
  it("lifts nginx's <title> verbatim as the headline", () => {
    expect(proxyErrorMessage(502, NGINX_502)).toContain("502 Bad Gateway");
    expect(proxyErrorMessage(413, NGINX_413)).toContain("413 Request Entity Too Large");
  });

  it("explains a 413 as a proxy body-size rejection", () => {
    expect(proxyErrorMessage(413, NGINX_413)).toMatch(/too large/i);
  });

  it("explains 502/503 as Polaris not answering behind the proxy", () => {
    expect(proxyErrorMessage(502, NGINX_502)).toMatch(/isn't answering/i);
    expect(proxyErrorMessage(503, "<html><head><title>503 Service Temporarily Unavailable</title></head>"))
      .toMatch(/isn't answering/i);
  });

  it("explains a 504 as a proxy timeout", () => {
    expect(proxyErrorMessage(504, "<html><head><title>504 Gateway Time-out</title></head>"))
      .toMatch(/timed out/i);
  });

  it("falls back to the bare status when the page carries no <title>", () => {
    expect(proxyErrorMessage(502, "<html><body>upstream died</body></html>")).toContain("HTTP 502");
  });

  it("never returns an empty string, whatever the body", () => {
    expect(proxyErrorMessage(500, "").length).toBeGreaterThan(0);
    expect(proxyErrorMessage(500, "<title></title>").length).toBeGreaterThan(0);
  });
});

describe("_readResponseBody — proxy error pages", () => {
  it("reports the status and reason for an nginx 502 instead of a JSON parse error", async () => {
    const err = await thrownBy(resp(502, NGINX_502));
    expect(err.status).toBe(502);
    expect(err.message).toContain("502 Bad Gateway");
    // The regression this file exists for: no "Unexpected token" leakage.
    expect(err.message).not.toMatch(/Unexpected token/i);
    expect(err.message).not.toMatch(/valid JSON/i);
  });

  it("reports an nginx 413 as a body-too-large rejection", async () => {
    const err = await thrownBy(resp(413, NGINX_413));
    expect(err.status).toBe(413);
    expect(err.message).toMatch(/too large/i);
  });

  it("keeps the raw page on the error for diagnosis", async () => {
    const err = await thrownBy(resp(502, NGINX_502));
    expect(err.bodyText).toBe(NGINX_502);
  });
});

describe("_readResponseBody — JSON responses (existing behaviour)", () => {
  it("returns the parsed body on success", async () => {
    await expect(readResponseBody(resp(200, '{"rule":{"id":"r1"}}')))
      .resolves.toEqual({ rule: { id: "r1" } });
  });

  it("surfaces the API's own `error` string on a JSON error", async () => {
    const err = await thrownBy(resp(400, '{"error":"trigger.threshold: Required"}'));
    expect(err.message).toBe("trigger.threshold: Required");
    expect(err.status).toBe(400);
    expect(err.data).toEqual({ error: "trigger.threshold: Required" });
  });

  it("uses the caller's fallback message when the JSON error carries none", async () => {
    const err = await thrownBy(resp(500, "{}"), "Upload failed");
    expect(err.message).toBe("Upload failed");
    expect(err.status).toBe(500);
  });

  it("falls back to the status when there is no message and no caller fallback", async () => {
    const err = await thrownBy(resp(500, "{}"));
    expect(err.message).toContain("500");
  });

  it("treats an empty 200 body as null rather than throwing", async () => {
    // res.json() threw on an empty body; a 200 with no content is not an error.
    await expect(readResponseBody(resp(200, ""))).resolves.toBeNull();
  });

  it("names a non-JSON 2xx body plainly instead of leaking a parse error", async () => {
    const err = await thrownBy(resp(200, "<html><body>hi</body></html>"));
    expect(err.status).toBe(200);
    expect(err.message).toMatch(/non-JSON/i);
    expect(err.message).not.toMatch(/Unexpected token/i);
  });
});

describe("api.js — every hand-rolled fetch reads through _readResponseBody", () => {
  // The multipart uploads (MIB, device icon, logo, cert preflight, restore) and
  // the blob downloads build their own fetch, so they bypassed request() and
  // kept blind-parsing: an nginx 413 on a 3 MB PowerNet-MIB upload still read
  // `Unexpected token '<'`. Uploads are exactly the requests a proxy's body
  // limit rejects, so none of them may call res.json() directly.
  it("has no direct res.json() call", () => {
    const src = readFileSync(resolve(__dirname, "../../public/js/api.js"), "utf8");
    const code = src.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
    expect(code).not.toMatch(/\bres\.json\(\)/);
  });
});
