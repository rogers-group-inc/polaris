/**
 * tests/unit/graphRequest.test.ts
 *
 * The Graph write transport (entraIdService.graphApiRequest).
 *
 * Reads tolerated a throttle badly enough that the old GET-only path never grew
 * 429 handling. Writes do not: a publish that silently failed because Graph
 * throttled is worse than a slow one, so the retry behaviour is pinned here.
 * Host pinning is pinned here too — this is the one code path in the module
 * that can be handed a caller-built URL.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import { graphApiRequest, GRAPH_HOST } from "../../src/services/entraIdService.js";

/**
 * entraIdService caches tokens in a module-level Map keyed tenantId:clientId,
 * and that cache outlives a test. Reusing one config would leave the token
 * cached from the previous case, so the next test's first mocked response
 * (queued as the token) gets consumed by the API call instead — every
 * assertion then sees the token payload. A unique clientId per test forces a
 * cache miss and keeps each case self-contained.
 */
let CONFIG: any;
let cfgSeq = 0;
const URL_OK = `https://${GRAPH_HOST}/v1.0/deviceManagement/deviceHealthScripts`;

/** Minimal Response double — only what the transport reads. */
function res(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => body,
  };
}

const TOKEN_OK = res(200, { access_token: "tok", expires_in: 3600 });

/**
 * Is this the AAD token fetch rather than a Graph call? Compares the parsed
 * HOST rather than testing the URL for a substring — a substring also matches
 * a URL that merely carries the login host in its path or query, which is what
 * `js/incomplete-url-substring-sanitization` flags. Test-double routing only,
 * but it has to be unambiguous for the call-count assertions to mean anything.
 */
const AAD_LOGIN_HOST = "login.microsoftonline.com";
function isTokenUrl(u: unknown): boolean {
  try {
    return new URL(String(u)).host === AAD_LOGIN_HOST;
  } catch {
    return false;
  }
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  CONFIG = { tenantId: "t", clientId: `c${++cfgSeq}`, clientSecret: "s" };
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * REAL timers on purpose. graphRequest arms a 30s abort timer per call, and
 * vi.runAllTimersAsync() fires that alongside the backoff sleep — aborting
 * every request under test. Instead the throttle cases use a fractional
 * Retry-After (throttleDelayMs multiplies by 1000, so 0.05 => a 50ms sleep),
 * which keeps the suite fast without faking the clock.
 */
const RETRY_AFTER_FAST = "0.05";
const runAll = <T,>(p: Promise<T>): Promise<T> => p;

describe("host pinning", () => {
  it("refuses a URL on another host before doing anything", async () => {
    // Literal substring, not `new RegExp(...GRAPH_HOST...)` — the host's dots
    // would be regex wildcards, so the assertion would also pass against a
    // message naming some other host.
    await expect(graphApiRequest(CONFIG, "https://evil.example/v1.0/x")).rejects.toThrow(
      `Graph host must be ${GRAPH_HOST}`,
    );
    // Rejected before a token was even requested.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an authority smuggled past new URL()", async () => {
    // `new URL()` alone would happily accept this; the explicit host equality
    // assertion after construction is what catches it.
    await expect(
      graphApiRequest(CONFIG, "https://graph.microsoft.com.evil.example/v1.0/x"),
    ).rejects.toThrow(/Graph host must be/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("write verbs", () => {
  it("sends the method, JSON body and Content-Type", async () => {
    fetchMock.mockResolvedValueOnce(TOKEN_OK).mockResolvedValueOnce(res(201, { id: "p1" }));
    const out = await runAll(graphApiRequest(CONFIG, URL_OK, { method: "POST", body: { a: 1 } }));

    expect(out).toEqual({ id: "p1" });
    const [, init] = fetchMock.mock.calls[1];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("omits Content-Type and body on a GET", async () => {
    fetchMock.mockResolvedValueOnce(TOKEN_OK).mockResolvedValueOnce(res(200, { value: [] }));
    await runAll(graphApiRequest(CONFIG, URL_OK));
    const [, init] = fetchMock.mock.calls[1];
    expect(init.body).toBeUndefined();
    expect(init.headers["Content-Type"]).toBeUndefined();
  });

  it("returns null on 204 rather than exploding on an empty body", async () => {
    fetchMock.mockResolvedValueOnce(TOKEN_OK).mockResolvedValueOnce(res(204, ""));
    await expect(runAll(graphApiRequest(CONFIG, URL_OK, { method: "PATCH", body: {} })))
      .resolves.toBeNull();
  });
});

describe("429 throttling", () => {
  it("honours Retry-After and retries", async () => {
    fetchMock
      .mockResolvedValueOnce(TOKEN_OK)
      // No second TOKEN_OK: the cached token is still valid across a 429
      // retry. Only a 401 invalidates it (see the 401 case below).
      .mockResolvedValueOnce(res(429, "slow down", { "retry-after": RETRY_AFTER_FAST }))
      .mockResolvedValueOnce(res(200, { ok: true }));

    await expect(runAll(graphApiRequest(CONFIG, URL_OK, { method: "POST", body: {} })))
      .resolves.toEqual({ ok: true });
  });

  it("gives up with an actionable message after the retry cap", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      isTokenUrl(url) ? TOKEN_OK : res(429, "nope", { "retry-after": RETRY_AFTER_FAST }),
    );
    await expect(runAll(graphApiRequest(CONFIG, URL_OK, { method: "POST", body: {} })))
      .rejects.toThrow(/throttled the request \(429\)/);
  });
});

describe("401 handling", () => {
  it("invalidates the cached token and retries exactly once", async () => {
    fetchMock
      .mockResolvedValueOnce(TOKEN_OK)
      .mockResolvedValueOnce(res(401, "expired"))
      .mockResolvedValueOnce(TOKEN_OK)          // token re-fetched, i.e. cache was cleared
      .mockResolvedValueOnce(res(200, { ok: true }));

    await expect(runAll(graphApiRequest(CONFIG, URL_OK))).resolves.toEqual({ ok: true });
    const tokenFetches = fetchMock.mock.calls.filter(([u]) => isTokenUrl(u)).length;
    expect(tokenFetches).toBe(2);
  });

  it("does not loop forever on a persistent 401", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      isTokenUrl(url) ? TOKEN_OK : res(401, "still bad"),
    );
    await expect(runAll(graphApiRequest(CONFIG, URL_OK))).rejects.toThrow(/HTTP 401/);
  });
});

describe("403 on a stale token", () => {
  // An app-only token's `roles` claim is fixed when the token is minted, and
  // this module caches one for up to an hour. Without the re-mint an operator
  // who grants the missing Graph permission gets a byte-identical 403 on the
  // next click and reasonably concludes the grant did not work.

  it("re-mints once and succeeds when the 403 arrived on a CACHED token", async () => {
    // First call warms the cache (token fetch + 200).
    fetchMock.mockResolvedValueOnce(TOKEN_OK).mockResolvedValueOnce(res(200, { warm: true }));
    await runAll(graphApiRequest(CONFIG, URL_OK));

    // Second call: no token fetch queued — it starts from the cached token,
    // which is the state an operator is in right after fixing the grant.
    fetchMock
      .mockResolvedValueOnce(res(403, { error: { message: "insufficient privileges" } }))
      .mockResolvedValueOnce(TOKEN_OK)        // cache cleared, token re-minted
      .mockResolvedValueOnce(res(200, { ok: true }));

    await expect(runAll(graphApiRequest(CONFIG, URL_OK))).resolves.toEqual({ ok: true });
    const tokenFetches = fetchMock.mock.calls.filter(([u]) => isTokenUrl(u)).length;
    expect(tokenFetches).toBe(2);
  });

  it("does NOT re-mint when the 403 arrived on a freshly minted token", async () => {
    // The token was issued moments ago, so it already carries whatever the app
    // has been granted — re-asking AAD would return the same claims and burn a
    // round trip per operator click for an app that is simply unauthorized.
    fetchMock
      .mockResolvedValueOnce(TOKEN_OK)
      .mockResolvedValueOnce(res(403, { error: { message: "insufficient privileges" } }));

    await expect(runAll(graphApiRequest(CONFIG, URL_OK)))
      .rejects.toThrow(/permission denied \(403\)/);
    const tokenFetches = fetchMock.mock.calls.filter(([u]) => isTokenUrl(u)).length;
    expect(tokenFetches).toBe(1);
  });

  it("surfaces the 403 rather than looping when the fresh token is refused too", async () => {
    fetchMock.mockResolvedValueOnce(TOKEN_OK).mockResolvedValueOnce(res(200, { warm: true }));
    await runAll(graphApiRequest(CONFIG, URL_OK));

    fetchMock.mockImplementation(async (url: string) =>
      isTokenUrl(url) ? TOKEN_OK : res(403, { error: { message: "still forbidden" } }),
    );
    await expect(runAll(graphApiRequest(CONFIG, URL_OK)))
      .rejects.toThrow(/permission denied \(403\): still forbidden/);
  });
});

describe("error surfaces", () => {
  it("names a 403 as a permission problem — the probe depends on this wording", async () => {
    fetchMock
      .mockResolvedValueOnce(TOKEN_OK)
      .mockResolvedValueOnce(res(403, { error: { message: "insufficient privileges" } }));
    await expect(runAll(graphApiRequest(CONFIG, URL_OK)))
      .rejects.toThrow(/permission denied \(403\): insufficient privileges/);
  });

  it("returns null for a 404 when allow404 is set, and throws otherwise", async () => {
    fetchMock.mockResolvedValueOnce(TOKEN_OK).mockResolvedValueOnce(res(404, "nope"));
    await expect(runAll(graphApiRequest(CONFIG, URL_OK, { allow404: true }))).resolves.toBeNull();

    // Second call in the same test reuses the cached token — queue only the response.
    fetchMock.mockResolvedValueOnce(res(404, "nope"));
    await expect(runAll(graphApiRequest(CONFIG, URL_OK))).rejects.toThrow(/HTTP 404/);
  });
});
