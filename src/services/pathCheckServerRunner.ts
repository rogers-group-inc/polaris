/**
 * src/services/pathCheckServerRunner.ts — the probe half of a path check's
 * POLARIS SERVER source (PathCheck.runOnServer). The scheduler that decides
 * what is due is jobs/runServerPathChecks.ts; results go through the SAME
 * ingest as an agent's push (pathCheckIngestService, subject
 * POLARIS_SERVER_SUBJECT), so the excerpt policy, the latest-result columns,
 * hop resolution and path-change Events are one implementation, not two.
 *
 * WHAT IT MIRRORS. The agent's probe (agent/internal/collectors/path_check*.go)
 * field for field, so a server row and an agent row mean the same thing on the
 * same chart: one timed DNS lookup preferring IPv4; the SSRF ranges refused
 * AFTER resolution; HTTP(S) = one GET (or HEAD), no proxy, redirects only when
 * the check follows them (each hop refused-checked again), an optional Host
 * override, status judged before body (a negated body match for "must not"), the first 64 KB read and fingerprinted, a 4 KB excerpt
 * on a failed run (or always, when the check keeps them); TLS facts reported
 * even when verification FAILED; TCP = one connect; ICMP = one echo. Change a
 * rule there and change it here.
 *
 * WHAT IS DIFFERENT, AND WHY.
 *  - The server additionally refuses its OWN addresses after resolution: a
 *    name that resolves to this host is a loopback probe of Polaris itself
 *    (the save path refuses the literal; this catches the DNS name).
 *  - ICMP goes through the system `ping` (utils/icmpPing), as every other
 *    server-side ICMP probe does — the service holds no CAP_NET_RAW.
 *  - The traceroute is the system tool's (utils/serverTraceroute).
 *  - It may AUTHENTICATE (bearer / basic / digest, from an http Credential).
 *    The agent never does: a check with a credential is server-only, so the
 *    secret never leaves this server. Auth goes only to the target's origin.
 *
 * A result describes the path FROM THIS SERVER to the target. It never moves
 * any asset's monitorStatus (business rule 85): the server is not an asset.
 */

import { createHash } from "node:crypto";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import type { TLSSocket } from "node:tls";
import { isBlockedOutboundHost } from "../utils/netGuard.js";
import { isValidIpAddress } from "../utils/cidr.js";
import { parseStatusSpec, statusInRanges, MAX_BODY_BYTES, MAX_EXCERPT_CHARS, type HttpAuthConfig } from "../utils/httpCheck.js";
import { parseDigestChallenge, buildDigestAuthorization, newCnonce } from "../utils/digestAuth.js";
import { burstPingHost } from "../utils/icmpPing.js";
import { traceFromServer } from "../utils/serverTraceroute.js";
import { getAppVersion } from "../utils/version.js";
import type { AgentCheckDef } from "./pathCheckService.js";
import type { PathCheckSampleInput, PathCheckTracerouteInput } from "./pathCheckIngestService.js";

export type TraceMode = "never" | "always" | "onFail";

/**
 * What a TEST run (POST /path-checks/test — the wizard's Expectations step)
 * hands back beyond the sample, so an operator can write the expectation from
 * what actually came back. Never filled on a scheduled run and never stored.
 */
export interface RunCapture {
  /** Response headers, lower-cased, at most MAX_CAPTURED_HEADERS; Set-Cookie values redacted. */
  headers?: Record<string, string>;
  /** The body the verdict was judged on — the first 64 KB, as text. */
  body?: string;
  /** e.g. "1.1". */
  httpVersion?: string;
  /** The URL the verdict was judged on — differs from the target after followed redirects. */
  finalUrl?: string;
}

/** Mirrors pathCheckService.MAX_REDIRECTS (a type-only import cannot carry a value). */
const MAX_REDIRECTS = 5;

export const MAX_CAPTURED_HEADERS = 60;

/** Pure: the headers a test shows — lower-cased, capped, cookie values redacted. */
export function captureHeaders(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw).slice(0, MAX_CAPTURED_HEADERS)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    // A session cookie the target hands out is not something to paint on an
    // operator's screen: the name is enough to write an expectation.
    const val = key === "set-cookie"
      ? (Array.isArray(v) ? v : [v]).map((c) => c.split("=")[0] + "=(redacted)").join("; ")
      : Array.isArray(v) ? v.join(", ") : v;
    out[key] = val.length > 512 ? val.slice(0, 512) + "…" : val;
  }
  return out;
}

/** One traceroute's ceiling — the agent's TracerouteBudget. */
export const TRACEROUTE_BUDGET_MS = 30_000;
const MAX_ERROR_LEN = 512;

// ─── Pure helpers (tested) ──────────────────────────────────────────────────

/**
 * The agent's bodyMatches: contains / exact (after trimming trailing CR/LF,
 * so a health endpoint's "OK\n" equals "OK") / regex. An invalid regex throws.
 */
export function pathBodyMatches(body: string, exp: AgentCheckDef["expectBody"]): boolean {
  if (!exp || !exp.value) return true;
  switch (exp.mode) {
    case "regex":
      return new RegExp(exp.value, exp.caseSensitive ? "" : "i").test(body);
    case "exact": {
      const got = body.replace(/[\r\n]+$/, "");
      return exp.caseSensitive ? got === exp.value : got.toLowerCase() === exp.value.toLowerCase();
    }
    default:
      return exp.caseSensitive ? body.includes(exp.value) : body.toLowerCase().includes(exp.value.toLowerCase());
  }
}

/** The first 4 KB of a body as text, never splitting a UTF-8 sequence. */
export function excerptOf(body: Buffer): string {
  if (body.length <= MAX_EXCERPT_CHARS) return body.toString("utf8");
  // Streaming mode holds back an incomplete trailing sequence instead of
  // emitting U+FFFD for it — exactly "cut on a rune boundary".
  return new TextDecoder("utf-8").decode(body.subarray(0, MAX_EXCERPT_CHARS), { stream: true });
}

export function truncateError(msg: string): string {
  return msg.length > MAX_ERROR_LEN ? msg.slice(0, MAX_ERROR_LEN) : msg;
}

/** This server's own addresses, lower-cased. */
export function ownAddresses(): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) out.add(ni.address.toLowerCase());
  }
  return out;
}

/** Why an address may not be probed from the server, or null. Pure over `own`. */
export function refusedAddress(ip: string, own: ReadonlySet<string>): string | null {
  if (isBlockedOutboundHost(ip)) return `refused: ${ip} is a loopback / link-local / unspecified / multicast address`;
  if (own.has(ip.toLowerCase())) return `refused: ${ip} is this Polaris server`;
  return null;
}

// ─── Target resolution ──────────────────────────────────────────────────────

interface Resolved { ip: string | null; dnsMs: number | null; error: string | null }

function msSince(t: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - t) / 1000) / 1000;
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Test seams: the resolver, this host's addresses, and the refusal (tests
 *  lift it to probe a loopback fixture server — production never does). */
export const _deps = {
  lookup: (host: string) => dns.lookup(host, { all: true }),
  ownAddresses,
  refusedAddress,
};

async function resolveTarget(host: string, timeoutMs: number): Promise<Resolved> {
  const h = host.replace(/^\[|\]$/g, "");
  const own = _deps.ownAddresses();
  if (isValidIpAddress(h)) {
    if (h.includes(":")) return { ip: null, dnsMs: null, error: "ipv6 not supported in v1" };
    const refused = _deps.refusedAddress(h, own);
    return refused ? { ip: null, dnsMs: null, error: refused } : { ip: h, dnsMs: null, error: null };
  }
  const start = process.hrtime.bigint();
  try {
    const addrs = await withTimeout(_deps.lookup(h), timeoutMs, "dns lookup");
    const dnsMs = msSince(start);
    const v4 = addrs.find((a) => a.family === 4);
    if (!v4) return { ip: null, dnsMs, error: "ipv6 not supported in v1" };
    const refused = _deps.refusedAddress(v4.address, own);
    return refused ? { ip: null, dnsMs, error: refused } : { ip: v4.address, dnsMs, error: null };
  } catch (err) {
    return { ip: null, dnsMs: msSince(start), error: truncateError(`dns lookup failed: ${(err as Error).message}`) };
  }
}

// ─── Probes ─────────────────────────────────────────────────────────────────

function splitHostPort(target: string): { host: string; port: number | null } {
  const t = target.trim();
  if (t.startsWith("[")) {
    const end = t.indexOf("]");
    const port = t.slice(end + 1).replace(/^:/, "");
    return { host: t.slice(1, end), port: port ? Number(port) : null };
  }
  const idx = t.lastIndexOf(":");
  if (idx < 0 || t.indexOf(":") !== idx) return { host: t, port: null };
  return { host: t.slice(0, idx), port: Number(t.slice(idx + 1)) };
}

/** One HTTP exchange as runHttp sees it. */
interface Exchange {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  httpVersion: string;
  body: Buffer;
  readErr: string | null;
}

/** Pure: same scheme + host + port (the default port made explicit). */
export function sameOrigin(a: URL, b: URL): boolean {
  const port = (u: URL) => u.port || (u.protocol === "https:" ? "443" : "80");
  return a.protocol === b.protocol && a.hostname.toLowerCase() === b.hostname.toLowerCase() && port(a) === port(b);
}

/** The Authorization value for Basic / Bearer (Digest is a handshake — see runHttp). */
function staticAuthorization(auth: HttpAuthConfig | null | undefined): string | null {
  if (!auth) return null;
  if (auth.authMode === "bearer" && auth.apiToken) return `Bearer ${auth.apiToken}`;
  if (auth.authMode === "basic" && auth.username) {
    return "Basic " + Buffer.from(`${auth.username}:${auth.password ?? ""}`, "utf8").toString("base64");
  }
  return null;
}

/**
 * Issue ONE request to `u` dialing `ip`, filling the timing and TLS fields of
 * `s` (the last hop's win when redirects are followed). Resolves with the
 * exchange, or null with `s.error` set.
 */
function requestOnce(
  def: AgentCheckDef, u: URL, ip: string, s: PathCheckSampleInput, deadlineMs: number,
  opts: { method: string; hostHeader: string | null; authorization: string | null },
): Promise<Exchange | null> {
  return new Promise((resolve) => {
    const isHttps = u.protocol === "https:";
    const hostname = u.hostname.replace(/^\[|\]$/g, "");
    const lib = isHttps ? https : http;
    // The name the server is asked for: a Host header override wins, for the
    // Host line AND the TLS SNI / certificate check alike.
    const sniName = (opts.hostHeader ?? hostname).replace(/:\d+$/, "");
    let connectStart = process.hrtime.bigint();
    let tcpDone: bigint | null = null;
    let wrote: bigint | null = null;
    let settled = false;
    const finish = (x: Exchange | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve(x); } };
    const headers: Record<string, string> = { "User-Agent": `polaris-server/${getAppVersion()}`, Accept: "*/*" };
    if (opts.hostHeader) headers.Host = opts.hostHeader;
    if (opts.authorization) headers.Authorization = opts.authorization;

    const req = lib.request({
      method: opts.method,
      protocol: u.protocol,
      hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers,
      // Dial the address already resolved (and refused-checked): DNS is timed
      // once, and resolvedIp is the address actually used.
      lookup: ((_h: string, lo: { all?: boolean }, cb: (...a: unknown[]) => void) => {
        if (lo && lo.all) cb(null, [{ address: ip, family: 4 }]);
        else cb(null, ip, 4);
      }) as unknown as net.LookupFunction,
      // A fresh socket per run, no proxy, no pooling.
      agent: false,
      // Verified by hand on secureConnect, so the certificate facts survive a
      // FAILED verification — the case an operator needs them for.
      rejectUnauthorized: false,
      ...(isHttps && !isValidIpAddress(sniName) ? { servername: sniName } : {}),
      minVersion: "TLSv1.2",
    });

    const timer = setTimeout(() => {
      s.error = `timed out after ${def.timeoutMs} ms`;
      req.destroy();
      finish(null);
    }, Math.max(1, deadlineMs));

    req.on("socket", (sock) => {
      connectStart = process.hrtime.bigint();
      sock.once("connect", () => {
        tcpDone = process.hrtime.bigint();
        s.connectMs = Number((Number(tcpDone - connectStart) / 1e6).toFixed(3));
      });
      if (isHttps) {
        (sock as TLSSocket).once("secureConnect", () => {
          const tls = sock as TLSSocket;
          if (tcpDone) s.tlsMs = Number((Number(process.hrtime.bigint() - tcpDone) / 1e6).toFixed(3));
          const cert = tls.getPeerCertificate();
          if (cert && cert.valid_to) {
            const na = new Date(cert.valid_to);
            if (!Number.isNaN(na.getTime())) s.tlsNotAfter = na.toISOString();
            const issuer = cert.issuer as Record<string, string | string[]> | undefined;
            const cn = issuer?.CN;
            s.tlsIssuer = (Array.isArray(cn) ? cn[0] : cn) || (issuer ? Object.entries(issuer).map(([k, v]) => `${k}=${v}`).join(", ") : null);
          }
          if (def.verifyTls && !tls.authorized) {
            s.error = truncateError(`tls: certificate verification failed: ${String(tls.authorizationError ?? "untrusted")}`);
            req.destroy();
            finish(null);
          }
        });
      }
    });
    req.on("finish", () => { wrote = process.hrtime.bigint(); });
    req.on("error", (err) => {
      if (!s.error) s.error = truncateError(err.message);
      finish(null);
    });
    req.on("response", (res) => {
      if (wrote) s.ttfbMs = Number((Number(process.hrtime.bigint() - wrote) / 1e6).toFixed(3));
      const chunks: Buffer[] = [];
      let size = 0;
      let readErr: string | null = null;
      const done = () => finish({
        status: res.statusCode ?? 0,
        headers: res.headers,
        httpVersion: res.httpVersion,
        body: Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES),
        readErr,
      });
      res.on("data", (c: Buffer) => {
        if (size >= MAX_BODY_BYTES) return;
        chunks.push(c);
        size += c.length;
        // Enough read: stop the transfer rather than draining a large body.
        if (size >= MAX_BODY_BYTES) { done(); res.destroy(); }
      });
      res.on("end", done);
      res.on("error", (err) => { readErr = err.message; done(); });
      res.on("close", done);
    });
    req.end();
  });
}

/**
 * One HTTP(S) check run: the request (GET or HEAD), a Digest handshake when
 * the credential is Digest (unauthenticated first, then EXACTLY one answer —
 * never a retry loop, the digestAuth.ts rule), redirects when the check follows
 * them (≤ MAX_REDIRECTS, every hop resolved and refused-checked again), then
 * the verdict on the LAST response: status before body, body match (negated
 * for "must not"), the 64 KB fingerprint and the excerpt policy.
 *
 * Credentials and the Host override go only to the TARGET'S OWN ORIGIN: a
 * redirect that leaves it gets neither, or following one would hand the
 * secret to whatever host the target (or someone who controls it) names.
 */
async function runHttp(
  def: AgentCheckDef, u0: URL, ip0: string, s: PathCheckSampleInput, started: bigint,
  auth: HttpAuthConfig | null | undefined, capture?: RunCapture,
): Promise<void> {
  const method = def.method === "HEAD" ? "HEAD" : "GET";
  const remaining = () => def.timeoutMs - msSince(started);
  let u = u0;
  let ip = ip0;
  let x: Exchange | null = null;
  for (let hop = 0; ; hop++) {
    const home = sameOrigin(u, u0);
    const hostHeader = home ? def.hostHeader ?? null : null;
    let authorization = home ? staticAuthorization(auth) : null;
    x = await requestOnce(def, u, ip, s, remaining(), { method, hostHeader, authorization });
    if (!x) return;
    if (home && x.status === 401 && auth?.authMode === "digest" && auth.username) {
      const challenge = parseDigestChallenge(headerValue(x.headers["www-authenticate"]));
      if (challenge) {
        try {
          authorization = buildDigestAuthorization({
            challenge, username: auth.username, password: auth.password ?? "",
            method, uri: u.pathname + u.search, cnonce: newCnonce(),
          });
        } catch (err) {
          s.error = truncateError(`digest: ${(err as Error).message}`);
          return;
        }
        x = await requestOnce(def, u, ip, s, remaining(), { method, hostHeader, authorization });
        if (!x) return;
      }
    }
    const loc = headerValue(x.headers.location);
    if (!def.followRedirects || x.status < 300 || x.status > 399 || !loc) break;
    if (hop >= MAX_REDIRECTS) { s.error = `more than ${MAX_REDIRECTS} redirects`; s.httpStatus = x.status; return; }
    let next: URL;
    try { next = new URL(loc, u); } catch { s.error = truncateError(`redirect to an invalid URL: ${loc}`); return; }
    if (next.protocol !== "http:" && next.protocol !== "https:") { s.error = `refused: redirect to ${next.protocol} URL`; return; }
    if (next.username || next.password) { s.error = "refused: redirect to a URL with credentials in it"; return; }
    const r = await resolveTarget(next.hostname, Math.max(1, remaining()));
    if (r.error || !r.ip) { s.error = truncateError(`redirect to ${next.host}: ${r.error ?? "no address"}`); return; }
    u = next;
    ip = r.ip;
    s.resolvedIp = r.ip;
  }

  const body = method === "HEAD" ? Buffer.alloc(0) : x.body;
  s.bodySha256 = createHash("sha256").update(body).digest("hex");
  s.bodyBytes = body.length;
  s.httpStatus = x.status;
  s.latencyMs = msSince(started);
  const spec = def.expectStatus;
  const { ranges } = parseStatusSpec(spec); // validated at save
  if (!statusInRanges(x.status, ranges)) {
    s.error = `HTTP ${x.status} (expected ${spec || "2xx"})`;
  } else if (x.readErr) {
    s.error = truncateError(`reading the response body: ${x.readErr}`);
  } else {
    try {
      const found = pathBodyMatches(body.toString("utf8"), def.expectBody);
      // bodyMatched = "the body expectation HELD" — for a negated one, that the
      // text was absent. The agent reports it the same way.
      const held = def.expectBody?.negate ? !found : found;
      if (def.expectBody) s.bodyMatched = held;
      if (held) s.ok = true;
      else if (def.expectBody?.negate) s.error = `Forbidden text found in the first 64 KB of the response body (HTTP ${x.status})`;
      else s.error = `Expected text not found in the first 64 KB of the response body (HTTP ${x.status})`;
    } catch (err) {
      s.error = truncateError(`invalid regex pattern: ${(err as Error).message}`);
    }
  }
  if (!s.ok || def.keepBodyExcerpt) s.bodyExcerpt = excerptOf(body);
  if (capture) {
    capture.headers = captureHeaders(x.headers);
    capture.body = new TextDecoder("utf-8").decode(body, { stream: true });
    capture.httpVersion = x.httpVersion;
    capture.finalUrl = u.toString();
  }
}

function headerValue(v: string | string[] | undefined): string | null {
  if (v === undefined) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}

function runTcp(ip: string, port: number, timeoutMs: number, s: PathCheckSampleInput): Promise<void> {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const sock = net.connect({ host: ip, port, family: 4 });
    const finish = (err: string | null) => {
      clearTimeout(timer);
      sock.destroy();
      if (err) s.error = truncateError(`connect failed: ${err}`);
      else {
        const ms = msSince(start);
        s.connectMs = ms;
        s.latencyMs = ms;
        s.ok = true;
      }
      resolve();
    };
    const timer = setTimeout(() => finish(`timed out after ${timeoutMs} ms`), timeoutMs);
    sock.once("connect", () => finish(null));
    sock.once("error", (err: NodeJS.ErrnoException) => finish(err.code || err.message));
  });
}

async function runIcmp(ip: string, timeoutMs: number, s: PathCheckSampleInput): Promise<void> {
  const start = process.hrtime.bigint();
  const r = await burstPingHost(ip, { count: 1, intervalMs: 1000, timeoutMs });
  if (r.sent === 0) {
    // ping never ran (absent, or not executable by the service) — the
    // mechanism broke, not the target (rule 71); say so distinctly.
    s.error = "icmp unsupported on this server (the system ping could not run)";
    return;
  }
  if (r.received < 1) {
    s.error = "no echo reply before the timeout";
    return;
  }
  s.latencyMs = r.avgRttMs ?? msSince(start);
  s.ok = true;
}

// ─── Scheduling (the agent's rules; used by jobs/runServerPathChecks) ───────

/** Due-ness slack, so a 60 s check on a 15 s tick does not slip to 75 s. */
export const DUE_SLACK_MS = 5 * 1000;

export interface ServerCheckState {
  revision: string;
  lastRunAt: number;
  runCount: number;
  lastOk: boolean;
}

/** Pure: is the check due? The first run under a definition always is. */
export function serverCheckDue(st: ServerCheckState | undefined, def: AgentCheckDef, now: number): boolean {
  if (!st || st.runCount === 0) return true;
  return now - st.lastRunAt >= def.intervalSec * 1000 - DUE_SLACK_MS;
}

/** Pure: the agent's tracerouteModeFor. */
export function serverTraceMode(st: ServerCheckState | undefined, def: AgentCheckDef): TraceMode {
  if (!def.traceroute.enabled) return "never";
  const every = def.traceroute.everyNRuns > 0 ? def.traceroute.everyNRuns : 5;
  if (!st || st.runCount % every === 0) return "always";
  return st.lastOk ? "onFail" : "never";
}

/**
 * Pure: drop state for checks no longer shipped, and reset a check whose
 * definition changed (a re-aimed check re-baselines). Returns the pruned map.
 */
export function pruneServerStates(states: Map<string, ServerCheckState>, defs: readonly AgentCheckDef[]): Map<string, ServerCheckState> {
  const out = new Map<string, ServerCheckState>();
  for (const d of defs) {
    const st = states.get(d.id);
    out.set(d.id, st && st.revision === d.revision ? st : { revision: d.revision, lastRunAt: 0, runCount: 0, lastOk: false });
  }
  return out;
}

// ─── Run ────────────────────────────────────────────────────────────────────

/**
 * Run one check (and, per `trace`, one traceroute) from this server. Always
 * returns a sample; `trace` is null when none ran. Never throws.
 */
export async function runServerCheck(
  def: AgentCheckDef,
  trace: TraceMode,
  now: () => Date = () => new Date(),
  capture?: RunCapture,
  auth?: HttpAuthConfig | null,
): Promise<{ sample: PathCheckSampleInput; trace: PathCheckTracerouteInput | null }> {
  const startedAt = now();
  const started = process.hrtime.bigint();
  const s: PathCheckSampleInput = { checkId: def.id, timestamp: startedAt.toISOString(), ok: false };
  let dst: string | null = null;
  const remaining = () => def.timeoutMs - msSince(started);

  try {
    if (def.kind === "http" || def.kind === "https") {
      const u = new URL(def.target.trim());
      if (u.protocol !== `${def.kind}:`) throw new Error(`a ${def.kind} check needs a ${def.kind}:// URL`);
      if (u.username || u.password) throw new Error("refused: credentials in the target URL are not supported");
      const r = await resolveTarget(u.hostname, def.timeoutMs);
      s.dnsMs = r.dnsMs;
      if (r.error || !r.ip) s.error = r.error ?? "no address";
      else {
        dst = r.ip;
        s.resolvedIp = r.ip;
        await runHttp(def, u, r.ip, s, started, auth, capture);
      }
    } else {
      const { host, port } = splitHostPort(def.target);
      const r = await resolveTarget(host, def.timeoutMs);
      s.dnsMs = r.dnsMs;
      if (r.error || !r.ip) s.error = r.error ?? "no address";
      else {
        dst = r.ip;
        s.resolvedIp = r.ip;
        const left = Math.max(1, Math.round(remaining()));
        if (def.kind === "tcp") await runTcp(r.ip, port ?? 0, left, s);
        else await runIcmp(r.ip, left, s);
      }
    }
  } catch (err) {
    s.error = truncateError((err as Error).message);
  }
  if (s.latencyMs == null && s.ok) s.latencyMs = msSince(started);

  const want = trace === "always" || (trace === "onFail" && !s.ok);
  if (!want || !def.traceroute.enabled || !dst) return { sample: s, trace: null };
  const tr = await traceFromServer(dst, {
    maxHops: def.traceroute.maxHops,
    probesPerHop: def.traceroute.probesPerHop,
    probeTimeoutMs: def.traceroute.probeTimeoutMs,
    budgetMs: TRACEROUTE_BUDGET_MS,
  });
  s.tracerouteRan = true;
  return {
    sample: s,
    trace: {
      checkId: def.id,
      timestamp: now().toISOString(),
      destinationIp: dst,
      complete: tr.complete,
      reason: trace === "onFail" ? "transition" : "scheduled",
      note: tr.note,
      hops: tr.hops.map((h) => ({ ttl: h.ttl, ip: h.ip, rdns: h.rdns ?? null, rttMs: h.rttMs })),
    },
  };
}
