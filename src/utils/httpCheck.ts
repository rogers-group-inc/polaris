/**
 * src/utils/httpCheck.ts
 *
 * Pure evaluation core for the HTTP CHECK — an HTTP GET against a device whose
 * result is decided by the STATUS CODE and, optionally, by a string the response
 * body must contain. It ran as a polling method until 2026-08 and is now a
 * manufacturer custom widget (business rule 33). Everything here is side-effect free so the
 * decision can be unit-tested without a socket; `probeHttp` in
 * monitoringService.ts owns the transport and calls `evaluateHttpCheck` with
 * what came back.
 *
 * ── Why a content check at all ────────────────────────────────────────────────
 * ICMP proves a NIC answers and SNMP/SSH prove a management plane answers.
 * Neither proves the thing the device exists to do still works: a web server
 * that has lost its backend still completes the TCP handshake and still
 * returns 200 — with an error page in the body. So the body match is the
 * load-bearing half of this check: a 200 whose body doesn't match FAILS, with
 * the reason naming the content that was missing rather than a generic failure.
 *
 * There was a `failOnMismatch` toggle that let a mismatch pass anyway. It made
 * sense while this drove `monitorStatus` and an operator might want
 * reachability-only semantics — but the check is a manufacturer widget now: it
 * records an outcome and an automation decides what "down" means. A mismatch
 * recorded as a PASS would make "expected content" decorative, since nothing
 * downstream could tell the two apart. So a mismatch always fails, and an
 * operator who wants a laxer rule simply leaves `expectBody` empty and judges
 * on the status code.
 *
 * ── Deliberate non-features ──────────────────────────────────────────────────
 * REDIRECTS ARE NOT FOLLOWED. A 302 to a login page is the single most common
 * way an HTTP health check reports "up" about a device that is not serving
 * anything — following it would fetch the login page, match nothing, and blame
 * the body. An operator who genuinely wants the redirect target points the path
 * at it, or sets `expectStatus` to the 3xx code they expect to see.
 *
 * NO POST / no request body / no custom method. This is a health check, not a
 * synthetic transaction: a probe that runs every 60s per asset must not be able
 * to mutate the device it is watching.
 *
 * BODY READING IS CAPPED at MAX_BODY_BYTES. A device that streams a log file at
 * the check path would otherwise buffer without bound on the monitor hot path,
 * once per asset per interval. The cap also bounds how much text an
 * operator-authored `regex` runs against — that regex is not analyzed for
 * backtracking behaviour (no static analysis can be), so the cap is what keeps
 * a pathological pattern from wedging a monitor worker rather than merely
 * slowing one probe. `contains` is the default for the same reason.
 */

/** Hard ceiling on how much of the response body is read and matched against. */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * How much of the body the operator-driven Test Connection flow shows back.
 * Much smaller than the read cap: 64 KB of minified HTML in a modal is not
 * readable, and the point of the preview is to let someone pick a distinctive
 * string out of the response, not to mirror the whole document.
 */
export const MAX_EXCERPT_CHARS = 4 * 1024;

/** How `expectBody` is compared against the response body. */
export type HttpMatchMode = "contains" | "regex";

/**
 * The AUTHENTICATION half — what an `http`-typed Credential stores, and all it
 * stores.
 *
 * Split out from the check definition in 2026-08, when the HTTP check moved
 * from a polling method to a manufacturer custom widget. The two halves vary on
 * different axes and belong to different owners: a login is per-vendor (or
 * per-site), while "which path, expecting what" is per-vendor-and-model. Keeping
 * them on one row meant a second path needed a second copy of the same
 * password, and changing the password meant editing every path.
 */
export interface HttpAuthConfig {
  /**
   * Which auth scheme to present. ABSENT is not "none" — it means the row
   * predates this field, and `resolveHttpAuthMode` infers the pre-existing
   * behaviour from whichever carrier is populated. See that function.
   */
  authMode?: HttpAuthMode;
  /** Sent as `Authorization: Bearer <token>`. Sealed at rest. */
  apiToken?: string;
  /** With `password`, sent as HTTP Basic or Digest per `authMode`. */
  username?: string;
  /** Sealed at rest. */
  password?: string;
}

/**
 * The CHECK definition — which request to make and what answer counts as
 * healthy. Owned by a `ManufacturerCustomWidget` with `widgetType: "http"`
 * (keyed by manufacturer + optional model), and accepted ad hoc by the
 * credential Test Connection flow so a check can be dialled in before it is
 * saved anywhere. `Asset.httpCheckPath` overrides just the path, for the one
 * device whose endpoint sits somewhere else.
 */
export interface HttpCheckConfig {
  /** https when true, http otherwise. Default false (plain HTTP). */
  useHttps?: boolean;
  /** Defaults to 443 when `useHttps`, else 80. */
  port?: number;
  /** Request path, leading slash optional on input. Default "/". */
  path?: string;
  /**
   * Exact status code that counts as up. Absent/null = any 2xx, which is the
   * useful default — a health endpoint answering 204 is as healthy as one
   * answering 200, and enumerating that per credential is busywork.
   */
  expectStatus?: number | null;
  /** Text the body must carry. Absent/empty = status code alone decides. */
  expectBody?: string;
  /** Default "contains". */
  matchMode?: HttpMatchMode;
  /** Default false — `contains` and `regex` both fold case unless this is on. */
  caseSensitive?: boolean;
  /** Default false, matching the restapi credential (self-signed device certs). */
  verifyTls?: boolean;
}

/**
 * How the check authenticates.
 *
 * "digest" is the reason this is an explicit field rather than an inference:
 * Basic and Digest are carried by the same username/password pair, so once
 * Digest exists there is nothing in the stored config that could distinguish
 * them. Guessing — try Basic, fall back on a 401 — would send the password in
 * cleartext to any device that answers a Digest challenge, which is precisely
 * the exposure Digest exists to avoid.
 */
export type HttpAuthMode = "none" | "bearer" | "basic" | "digest";

/**
 * Modes an `http` CREDENTIAL may be saved with. "none" is deliberately absent:
 * a credential exists to authenticate, and a credential that authenticates
 * nothing is an empty row that reads as configuration. Unauthenticated checks
 * are expressed by a widget selecting NO credential at all, which is the same
 * outcome without the misleading artefact.
 */
export const HTTP_CREDENTIAL_AUTH_MODES: readonly HttpAuthMode[] = ["bearer", "basic", "digest"];

/**
 * Every mode the PROBE can execute. "none" stays here because it is the state
 * of a widget with no credential attached — the probe must be able to express
 * "send no Authorization header".
 */
export const HTTP_AUTH_MODES: readonly HttpAuthMode[] = ["none", "bearer", "basic", "digest"];

/**
 * Resolve the effective auth mode, defaulting a credential saved before the
 * field existed to exactly what it used to do: `apiToken` won over a
 * username/password pair, and neither meant unauthenticated. Every consumer
 * (validation, the probe, the Test Connection diagnostics) reads the mode
 * through here so a stored row cannot mean one thing to the validator and
 * another to the socket.
 */
export function resolveHttpAuthMode(config: HttpAuthConfig): HttpAuthMode {
  const declared = config.authMode;
  if (declared && (HTTP_AUTH_MODES as readonly string[]).includes(declared)) return declared;
  if (typeof config.apiToken === "string" && config.apiToken) return "bearer";
  if (typeof config.username === "string" && config.username &&
      typeof config.password === "string" && config.password) return "basic";
  return "none";
}

/**
 * Normalize a request path: default "/", force a leading slash, reject nothing
 * (a query string is legitimate on a health endpoint). Whitespace is trimmed
 * because an operator pasting a path out of a browser bar picks up a newline
 * often enough to matter, and a stray one would produce an invalid request
 * line rather than a readable error.
 */
export function normalizeHttpPath(path: string | null | undefined): string {
  const raw = typeof path === "string" ? path.trim() : "";
  if (!raw) return "/";
  return raw.startsWith("/") ? raw : "/" + raw;
}

/** Default port for the scheme. */
export function defaultHttpPort(useHttps: boolean | undefined): number {
  return useHttps ? 443 : 80;
}

export interface ResolvedHttpTarget {
  useHttps: boolean;
  port: number;
  path: string;
}

/**
 * Resolve the request line from the credential plus an optional per-asset path
 * override. The override wins ONLY when it is a non-empty string: a null or
 * blank `Asset.httpCheckPath` means "no override", so clearing the field on the
 * asset returns the device to the credential's path rather than to "/".
 */
export function resolveHttpTarget(
  config: HttpCheckConfig,
  pathOverride?: string | null,
): ResolvedHttpTarget {
  const useHttps = config.useHttps === true;
  const port = Number.isInteger(config.port) && (config.port as number) > 0
    ? (config.port as number)
    : defaultHttpPort(useHttps);
  const override = typeof pathOverride === "string" && pathOverride.trim() ? pathOverride : null;
  return { useHttps, port, path: normalizeHttpPath(override ?? config.path) };
}

/** True when the status code satisfies `expectStatus` (absent = any 2xx). */
export function statusAccepted(statusCode: number, expectStatus: number | null | undefined): boolean {
  if (expectStatus === null || expectStatus === undefined) {
    return statusCode >= 200 && statusCode < 300;
  }
  return statusCode === expectStatus;
}

/**
 * A path check's accepted-status spec: comma-separated codes and
 * inclusive ranges, e.g. "200,204,300-399". Empty means "any 2xx" — the same
 * default `statusAccepted` applies to a vendor HTTP check with no expectation.
 *
 * MIRRORED twice: the Go agent (`parseStatusSpec` in
 * agent/internal/collectors/path_check_http.go) judges the response with it,
 * and the check modal (`parseStatusSpec` in public/js/path-checks.js)
 * validates it as the operator types. tests/unit/pathCheckStatusSpecParity
 * pins the client copy to this one; the Go copy has its own table test with the
 * same cases. Change all three together.
 */
export interface StatusRange { lo: number; hi: number }

export function parseStatusSpec(spec: string | null | undefined): { ranges: StatusRange[]; error: string | null } {
  const s = (spec ?? "").trim();
  if (!s) return { ranges: [{ lo: 200, hi: 299 }], error: null };
  const ranges: StatusRange[] = [];
  for (const raw of s.split(",")) {
    const part = raw.trim();
    if (!part) return { ranges: [], error: "Empty entry in the status list" };
    const m = /^(\d{3})(?:\s*-\s*(\d{3}))?$/.exec(part);
    if (!m) return { ranges: [], error: `"${part}" is not a status code or range (use 200 or 200-299)` };
    const lo = Number(m[1]);
    const hi = m[2] !== undefined ? Number(m[2]) : lo;
    if (lo < 100 || hi > 599) return { ranges: [], error: `"${part}" is outside 100–599` };
    if (lo > hi) return { ranges: [], error: `"${part}" runs backwards` };
    ranges.push({ lo, hi });
  }
  if (ranges.length > 20) return { ranges: [], error: "At most 20 codes or ranges" };
  return { ranges, error: null };
}

export function statusInRanges(code: number, ranges: readonly StatusRange[]): boolean {
  return ranges.some((r) => code >= r.lo && code <= r.hi);
}

/**
 * A body-match regex the AGENT can run. The agent is Go, whose regexp package
 * is RE2: no lookaround and no backreferences. A pattern that compiles in
 * JavaScript but not in RE2 would save, ship to every agent, and fail every run
 * with "invalid regex" — so it is refused here, where the operator can fix it.
 * Returns an error message, or null when the pattern is usable.
 */
export function agentRegexProblem(pattern: string): string | null {
  try {
    new RegExp(pattern);
  } catch (err) {
    return `Invalid regular expression: ${(err as Error).message}`;
  }
  if (/\(\?<?[=!]/.test(pattern)) return "Lookahead / lookbehind is not supported (the agent uses RE2)";
  if (/\\[1-9]/.test(pattern) || /\\k</.test(pattern)) return "Backreferences are not supported (the agent uses RE2)";
  return null;
}

/**
 * Compile the body expectation. Returns null when there is nothing to match,
 * so callers can distinguish "no expectation" from "expectation not met".
 * An invalid regex throws — credential validation rejects one at save time, so
 * reaching this with a bad pattern means the row predates validation, and a
 * thrown message naming the failure beats silently treating it as a miss.
 */
export function bodyMatches(body: string, config: HttpCheckConfig): boolean | null {
  const expect = typeof config.expectBody === "string" ? config.expectBody : "";
  if (!expect) return null;
  const caseSensitive = config.caseSensitive === true;
  if (config.matchMode === "regex") {
    const re = new RegExp(expect, caseSensitive ? "" : "i");
    return re.test(body);
  }
  return caseSensitive
    ? body.includes(expect)
    : body.toLowerCase().includes(expect.toLowerCase());
}

/**
 * What the operator-driven test reports back so the check can be TAILORED: the
 * request that actually went out, what came back, and whether the current
 * expectation hit. Produced ONLY on the Test Connection path — `probeHttp`
 * fills it when handed an out-param, so the monitor hot path allocates none of
 * this per probe per interval.
 *
 * Deliberately NOT the response headers. `content-type` is the one an operator
 * needs (it explains a body that reads as gibberish), whereas a full header dump
 * would put `Set-Cookie` — a live session token for whatever the check just
 * authenticated against — into a modal and into anything that later screenshots
 * or copies it.
 */
export interface HttpProbeDiagnostics {
  /** The request line as dialed, so "why did it 404" is answerable. */
  url: string;
  statusCode: number;
  contentType: string | null;
  /** Bytes actually read — capped at MAX_BODY_BYTES. */
  bytesRead: number;
  /** True when the device had more to send than the read cap allowed. */
  bodyTruncatedAtCap: boolean;
  excerpt: string;
  /** True when `excerpt` is shorter than what was read. */
  excerptTruncated: boolean;
  /** The current expectation's verdict; null when none is configured yet. */
  matched: boolean | null;
  /**
   * Auth schemes the device offered in `WWW-Authenticate`, when it challenged.
   * Null when it never did. This is the single most useful thing a failing
   * probe can report: "you configured Basic and it asked for Digest" is
   * otherwise indistinguishable from a wrong password, since both arrive as a
   * bare 401. Scheme names only — no realm, no nonce, nothing carrying a
   * credential.
   */
  authRequested: string[] | null;
  /** True when a Digest challenge was answered and the request re-sent. */
  digestNegotiated: boolean;
}

/** Trim a body down to what the test modal will show. Pure. */
export function bodyExcerpt(body: string): { text: string; truncated: boolean } {
  if (body.length <= MAX_EXCERPT_CHARS) return { text: body, truncated: false };
  return { text: body.slice(0, MAX_EXCERPT_CHARS), truncated: true };
}

/**
 * The request line as a display string. Built from the RESOLVED target, so what
 * the operator reads is what the socket dialed — including a path override and
 * a defaulted port, the two things a hand-written guess gets wrong.
 */
export function describeHttpTarget(host: string, target: ResolvedHttpTarget): string {
  const scheme = target.useHttps ? "https" : "http";
  // Print the port only when it isn't the scheme's default — a URL reading
  // "https://host:443/x" invites the reader to wonder what's special about it.
  const port = target.port === defaultHttpPort(target.useHttps) ? "" : ":" + target.port;
  return `${scheme}://${host}${port}${target.path}`;
}

export interface HttpCheckOutcome {
  /** Whether the probe counts as a success. */
  ok: boolean;
  /** Populated whenever something was off. */
  error?: string;
  /** true/false when a body expectation existed, null when none did. */
  matched: boolean | null;
}

/**
 * Decide the probe outcome from what came back. Status is judged first: a 401
 * is a misconfigured credential, not missing content, and blaming the body
 * there sends the operator to the wrong field.
 */
export function evaluateHttpCheck(args: {
  statusCode: number;
  body: string;
  config: HttpCheckConfig;
  truncated?: boolean;
}): HttpCheckOutcome {
  const { statusCode, body, config } = args;
  if (!statusAccepted(statusCode, config.expectStatus)) {
    const wanted = config.expectStatus === null || config.expectStatus === undefined
      ? "any 2xx"
      : String(config.expectStatus);
    return { ok: false, error: `HTTP ${statusCode} (expected ${wanted})`, matched: null };
  }

  let matched: boolean | null;
  try {
    matched = bodyMatches(body, config);
  } catch (err: any) {
    return {
      ok: false,
      error: `Invalid ${config.matchMode === "regex" ? "regex" : "match"} pattern: ${err?.message || "unparseable"}`,
      matched: null,
    };
  }
  if (matched !== false) return { ok: true, matched };

  // Name the truncation when it happened — "not found in the first 64 KB" is a
  // materially different finding from "not found", and an operator whose match
  // string sits past the cap needs to know that rather than re-checking a
  // string that is genuinely present.
  const where = args.truncated
    ? `the first ${Math.floor(MAX_BODY_BYTES / 1024)} KB of the response body`
    : "the response body";
  const kind = config.matchMode === "regex" ? "pattern" : "text";
  return {
    ok: false,
    error: `Expected ${kind} not found in ${where} (HTTP ${statusCode})`,
    matched: false,
  };
}
