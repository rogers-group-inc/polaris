/**
 * src/utils/fortiosRequestGate.ts — per-FortiGate request pacing for the
 * direct FortiOS REST transport (`fortigateService.fgRequest`). Business rule 96.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * FortiOS 7.6 moved REST API-key authorization into a dedicated daemon,
 * `http_authd`, with an API-key lockout keyed on the SOURCE IP. Per Fortinet
 * TAC it counts EVERY non-OK authorization as a failed attempt, including
 * transient ones (an HA transition, a config reload, an upgrade window). After
 * `admin-lockout-threshold` failures (default 3) it locks the source IP out of
 * API-key access for `admin-lockout-duration`, and the duration DOUBLES on
 * every repeat, so it can grow to hours.
 *
 * A Polaris server is one source IP for everything it does to a gate, so a
 * lockout silences discovery, monitoring, pushes and the Query API tool at
 * once. Two things Polaris did made that easy to reach and hard to leave:
 *
 *  1. Concurrency. Discovery fans out ~7 parallel chains per gate and the
 *     monitor passes overlap them, so ONE bad moment produced 3+ failures in the
 *     same instant — enough to lock out on the first blip. Capping in-flight
 *     requests per gate below the default threshold means a single blip costs
 *     at most that many failures before step 2 stops the rest.
 *  2. Persistence. Polaris kept polling on schedule through the lockout, and
 *     every rejected request risked another doubling. After a 401 the gate is
 *     left alone for a pause that itself doubles (60 s → 30 min) until a
 *     request is answered with anything other than 401.
 *
 * The incident that forced this: a stale per-stream REST credential on one
 * gate sent a burst of bad keys every monitor pass and kept the production
 * server locked out of that gate's API for hours.
 *
 * ── Scope ────────────────────────────────────────────────────────────────────
 * State is in-memory and per PROCESS. A split-role install (web / monitor /
 * discovery) paces each role separately, so the effective per-gate ceiling is
 * the cap times the number of roles that talk to that gate. Keyed by
 * `host:port`, not by token: the lockout is per source IP, so a pause must
 * cover every token Polaris holds for that address.
 */

/** Default in-flight requests per gate. Below FortiOS's default lockout threshold of 3. */
export const DEFAULT_FORTIOS_PER_GATE_CONCURRENCY = 2;
const MAX_FORTIOS_PER_GATE_CONCURRENCY = 16;

/** First pause after a 401, and the ceiling the doubling stops at. */
export const FORTIOS_AUTH_PAUSE_BASE_MS = 60_000;
export const FORTIOS_AUTH_PAUSE_MAX_MS = 30 * 60_000;

/**
 * In-flight cap per gate from `POLARIS_FORTIOS_PER_GATE_CONCURRENCY`
 * (1..16, default 2). Garbage falls back to the default rather than to
 * "unlimited" — the cap is what keeps one blip from becoming a lockout.
 */
export function resolvePerGateConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.POLARIS_FORTIOS_PER_GATE_CONCURRENCY);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_FORTIOS_PER_GATE_CONCURRENCY;
  return Math.min(MAX_FORTIOS_PER_GATE_CONCURRENCY, Math.floor(raw));
}

/** Pause after the Nth consecutive 401 (N ≥ 1): 60 s, 120 s, 240 s … capped at 30 min. */
export function authPauseMs(consecutive401s: number): number {
  const n = Math.max(1, Math.floor(consecutive401s));
  // 2^20 already dwarfs the cap; clamp the exponent so it never overflows.
  return Math.min(FORTIOS_AUTH_PAUSE_MAX_MS, FORTIOS_AUTH_PAUSE_BASE_MS * 2 ** Math.min(n - 1, 20));
}

interface GateState {
  active: number;
  waiters: Array<() => void>;
  consecutive401s: number;
  pausedUntil: number;
}

const gates = new Map<string, GateState>();

function stateFor(key: string): GateState {
  let s = gates.get(key);
  if (!s) {
    s = { active: 0, waiters: [], consecutive401s: 0, pausedUntil: 0 };
    gates.set(key, s);
  }
  return s;
}

/** The key a gate is paced under. */
export function fortiosGateKey(host: string, port: number): string {
  return `${host.trim().toLowerCase()}:${port}`;
}

/** Milliseconds left on a 401 pause for this gate; 0 when requests may go. */
export function authPauseRemainingMs(key: string, now: number = Date.now()): number {
  const s = gates.get(key);
  if (!s) return 0;
  return Math.max(0, s.pausedUntil - now);
}

/**
 * Record how the gate answered. `401` starts (or lengthens) the pause and
 * returns its length; any other HTTP answer ends the run of 401s and returns 0.
 * Transport failures (timeouts, refused connections) are NOT recorded: they say
 * nothing about authorization, and http_authd never saw them.
 */
export function recordFortiosAuthResult(key: string, status: number, now: number = Date.now()): number {
  const s = stateFor(key);
  if (status === 401) {
    s.consecutive401s += 1;
    const pause = authPauseMs(s.consecutive401s);
    s.pausedUntil = Math.max(s.pausedUntil, now + pause);
    return pause;
  }
  s.consecutive401s = 0;
  s.pausedUntil = 0;
  return 0;
}

/** Consecutive 401s recorded for this gate (for log lines). */
export function consecutive401sFor(key: string): number {
  return gates.get(key)?.consecutive401s ?? 0;
}

/** Thrown when a request waited longer than its budget for a slot. */
export class FortiosGateBusyError extends Error {
  constructor(key: string, waitedMs: number) {
    super(`FortiGate ${key} is busy — waited ${waitedMs} ms for one of its ${resolvePerGateConcurrency()} request slots`);
    this.name = "FortiosGateBusyError";
  }
}

/**
 * Run `fn` holding one of this gate's request slots. Waits FIFO when the gate
 * is at its cap. Gives up — without ever sending — when `signal` aborts or
 * `maxWaitMs` elapses, so a wedged gate cannot pile up an unbounded queue of
 * monitor ticks behind it.
 */
export async function withFortiosGateSlot<T>(
  key: string,
  fn: () => Promise<T>,
  opts: { signal?: AbortSignal; maxWaitMs?: number; limit?: number } = {},
): Promise<T> {
  const limit = opts.limit ?? resolvePerGateConcurrency();
  const s = stateFor(key);

  if (s.active >= limit) {
    const started = Date.now();
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => { cleanup(); reject(opts.signal?.reason ?? new DOMException("Aborted", "AbortError")); };
      const grant = () => { cleanup(); resolve(); };
      function cleanup() {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        const i = s.waiters.indexOf(grant);
        if (i >= 0) s.waiters.splice(i, 1);
      }
      if (opts.signal?.aborted) { onAbort(); return; }
      s.waiters.push(grant);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts.maxWaitMs !== undefined) {
        timer = setTimeout(() => { cleanup(); reject(new FortiosGateBusyError(key, Date.now() - started)); }, opts.maxWaitMs);
      }
    });
    // The releasing caller handed its slot straight to us (active unchanged).
  } else {
    s.active += 1;
  }

  try {
    return await fn();
  } finally {
    const next = s.waiters.shift();
    if (next) next();          // hand the slot over; active stays the same
    else s.active -= 1;
  }
}

/** Test hook: forget every gate's pacing state. */
export function _resetFortiosGateState(): void {
  gates.clear();
}
