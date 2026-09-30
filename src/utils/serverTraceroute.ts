/**
 * src/utils/serverTraceroute.ts — a traceroute FROM THE POLARIS SERVER, for the
 * server source of a path check (services/pathCheckServerRunner.ts).
 *
 * WHY A SYSTEM TOOL. The agent traces with UDP probes read back through
 * IP_RECVERR (Linux) or IcmpSendEcho2 (Windows). Node exposes neither: dgram
 * can set a TTL but can never see the ICMP time-exceeded that answers it, and
 * a raw socket needs CAP_NET_RAW, which the polaris service does not hold.
 * So this spawns the host's own tracer, in the order it is most likely to be
 * present AND unprivileged:
 *
 *   1. `traceroute -n` (Linux) — UDP by default, which needs no privilege
 *      (it uses IP_RECVERR too). The Docker image installs it; RHEL ships it
 *      in BaseOS and the setup scripts install it.
 *   2. `tracepath -n` (Linux) — part of iputils, so present wherever `ping`
 *      is, but it takes no per-probe count or wait and walks hops one at a
 *      time; the fallback, not the default.
 *   3. `tracert -d` (Windows — dev installs).
 *
 * None present → a trace with no hops and a note naming the package, never an
 * error: a missing tool is the measurement's mechanism breaking, not the
 * target failing (business rule 71).
 *
 * The parsers are pure and exported — they are the part that silently rots
 * when a distro rewords its output, and a wrong parse reads as a path that
 * changed.
 */

import { spawn } from "node:child_process";
import { reverse } from "node:dns/promises";

export interface TraceHop {
  ttl: number;
  /** First responder at this TTL; null = no reply. */
  ip: string | null;
  /** One entry per probe, in probe order; -1 = no reply. */
  rttMs: number[];
  rdns?: string | null;
}

export interface TraceResult {
  hops: TraceHop[];
  complete: boolean;
  note: string | null;
}

export interface TraceOptions {
  maxHops: number;
  probesPerHop: number;
  probeTimeoutMs: number;
  /** Wall-clock ceiling for the whole trace, rDNS included. */
  budgetMs: number;
}

/** Consecutive silent TTLs after which a trace stops (the agent's figure). */
export const SILENT_HOP_LIMIT = 8;

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export type Tracer = "traceroute" | "tracepath" | "tracert";

/**
 * The command line for each tracer. Pure (tested). `traceroute` gets `-N 1`
 * (one probe in flight, as tracert and tracepath already do): its default
 * sends 16 at once, and MPLS core routers rate-limit a burst of Time Exceeded
 * replies — the same loss the agent's tracer had (agent 0.23.1). A tracer
 * without `-N` (inetutils, busybox) is retried without it (`sequential` false).
 */
export function tracerArgs(tracer: Tracer, dst: string, o: TraceOptions, sequential = true): string[] {
  const waitSec = String(Math.max(1, Math.ceil(o.probeTimeoutMs / 1000)));
  switch (tracer) {
    case "traceroute": return ["-n", ...(sequential ? ["-N", "1"] : []), "-q", String(o.probesPerHop), "-w", waitSec, "-m", String(o.maxHops), dst];
    case "tracepath":  return ["-n", "-m", String(o.maxHops), dst];
    case "tracert":    return ["-d", "-h", String(o.maxHops), "-w", String(o.probeTimeoutMs), dst];
  }
}

interface RawHop { ttl: number; ip: string | null; rttMs: number[]; stop: boolean }

/**
 * `traceroute -n` output:
 *   " 1  192.168.1.1  0.512 ms  0.401 ms  0.388 ms"
 *   " 5  10.0.0.1  1.2 ms 10.0.0.2  1.3 ms *"   (per-probe responders)
 *   " 7  * * *"
 *   " 9  10.9.9.9  3.1 ms !H  3.0 ms !H  *"     (!H/!N/!P/!X… = path ends)
 */
export function parseTraceroute(out: string): RawHop[] {
  const hops: RawHop[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const tokens = m[2].trim().split(/\s+/);
    const hop: RawHop = { ttl: Number(m[1]), ip: null, rttMs: [], stop: false };
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "*") { hop.rttMs.push(-1); continue; }
      if (IPV4_RE.test(t)) { if (!hop.ip) hop.ip = t; continue; }
      if (/^!/.test(t)) {
        // "!<num>" is an ICMP code; any !-annotation ends the path at this hop.
        hop.stop = true;
        continue;
      }
      const v = Number(t);
      if (Number.isFinite(v) && tokens[i + 1] === "ms") { hop.rttMs.push(v); i++; }
    }
    hops.push(hop);
  }
  return hops;
}

/**
 * `tracepath -n` output — each TTL may print more than once, "no reply" is a
 * silent probe, "reached" is the destination:
 *   " 1?: [LOCALHOST]                      pmtu 1500"
 *   " 1:  192.168.1.1                      0.512ms"
 *   " 2:  no reply"
 *   " 3:  8.8.8.8                          10.1ms reached"
 *   "     Resume: pmtu 1500 hops 3 back 3"
 */
export function parseTracepath(out: string): RawHop[] {
  const byTtl = new Map<number, RawHop>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\??:\s+(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[2].trim();
    if (rest.startsWith("[LOCALHOST]")) continue;
    const ttl = Number(m[1]);
    const hop = byTtl.get(ttl) ?? { ttl, ip: null, rttMs: [], stop: false };
    if (/^no reply/i.test(rest)) {
      hop.rttMs.push(-1);
    } else {
      const ip = rest.split(/\s+/)[0];
      if (IPV4_RE.test(ip) && !hop.ip) hop.ip = ip;
      const rtt = /([\d.]+)ms/.exec(rest);
      hop.rttMs.push(rtt ? Number(rtt[1]) : -1);
    }
    byTtl.set(ttl, hop);
  }
  return [...byTtl.values()].sort((a, b) => a.ttl - b.ttl);
}

/**
 * `tracert -d` (Windows) output:
 *   "  1    <1 ms    <1 ms    <1 ms  192.168.1.1"
 *   "  2     *        *        *     Request timed out."
 *   "  3    12 ms    11 ms    12 ms  8.8.8.8"
 *   "  4  10.0.0.1  reports: Destination host unreachable."
 */
export function parseTracert(out: string): RawHop[] {
  const hops: RawHop[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[2];
    const hop: RawHop = { ttl: Number(m[1]), ip: null, rttMs: [], stop: /reports:/i.test(rest) };
    const re = /(<1|\d+)\s*ms|\*/g;
    let r: RegExpExecArray | null;
    while ((r = re.exec(rest)) !== null) {
      if (r[0] === "*") hop.rttMs.push(-1);
      else hop.rttMs.push(r[1] === "<1" ? 0.5 : Number(r[1]));
    }
    const ips = rest.split(/\s+/).filter((t) => IPV4_RE.test(t));
    hop.ip = ips.length ? ips[ips.length - 1] : null;
    hops.push(hop);
  }
  return hops;
}

/**
 * The wire's hop list from a tracer's raw hops — the agent's assembleHops
 * rules: every TTL from 1 up to the destination (or where the path stopped),
 * gaps filled as silent hops, one RTT slot per probe (-1 = no reply), stop
 * after SILENT_HOP_LIMIT consecutive silent TTLs, trailing silent hops of an
 * incomplete trace dropped. Pure (tested).
 */
export function assembleTrace(raw: RawHop[], dst: string, o: Pick<TraceOptions, "maxHops" | "probesPerHop">): { hops: TraceHop[]; complete: boolean } {
  const byTtl = new Map(raw.map((h) => [h.ttl, h]));
  const last = raw.reduce((n, h) => Math.max(n, h.ttl), 0);
  const hops: TraceHop[] = [];
  let complete = false;
  let silent = 0;
  for (let ttl = 1; ttl <= last && ttl <= o.maxHops; ttl++) {
    const h = byTtl.get(ttl);
    const rttMs = Array.from({ length: o.probesPerHop }, (_, i) => {
      const v = h?.rttMs[i];
      return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : -1;
    });
    const ip = h?.ip ?? null;
    hops.push({ ttl, ip, rttMs });
    if (ip && ip === dst) { complete = true; break; }
    if (h?.stop) break;
    if (!ip) {
      if (++silent >= SILENT_HOP_LIMIT) break;
    } else {
      silent = 0;
    }
  }
  while (!complete && hops.length && hops[hops.length - 1].ip === null) hops.pop();
  return { hops, complete };
}

const PARSERS: Record<Tracer, (out: string) => RawHop[]> = {
  traceroute: parseTraceroute,
  tracepath: parseTracepath,
  tracert: parseTracert,
};

function candidates(): Tracer[] {
  return process.platform === "win32" ? ["tracert"] : ["traceroute", "tracepath"];
}

/** Tracers found missing — skipped for the life of the process (installing
 *  one takes effect on the next restart, which an updater run is). */
let _missing = new Set<Tracer>();

/** Set once this host's `traceroute` refused `-N` (printed no hops with it and
 *  some without it) — skipped from then on, for the life of the process. */
let _noSequentialFlag = false;

/** Test seam. */
export function _resetTracerCache(): void {
  _missing = new Set();
  _noSequentialFlag = false;
}

function runTool(tracer: Tracer, args: string[], budgetMs: number): Promise<{ out: string; missing: boolean; cut: boolean }> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    let cut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(tracer, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch {
      resolve({ out: "", missing: true, cut: false });
      return;
    }
    const finish = (missing: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ out, missing, cut });
    };
    const timer = setTimeout(() => {
      cut = true;
      try { child.kill("SIGKILL"); } catch { /* exited */ }
      finish(false);
    }, budgetMs);
    child.stdout?.on("data", (d) => { out += String(d); });
    child.stderr?.on("data", () => { /* banners and warnings — not hops */ });
    child.on("error", (err: NodeJS.ErrnoException) => finish(err.code === "ENOENT" || err.code === "EACCES" || err.code === "EPERM"));
    child.on("close", () => finish(false));
  });
}

/** rDNS for each distinct hop IP: 1 s a lookup, 8 at once, `budgetMs` overall. */
async function enrichRdns(hops: TraceHop[], budgetMs: number): Promise<void> {
  const ips = [...new Set(hops.map((h) => h.ip).filter((ip): ip is string => !!ip))];
  const names = new Map<string, string>();
  const deadline = Date.now() + budgetMs;
  const withTimeout = <T>(p: Promise<T>, ms: number) =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
  for (let i = 0; i < ips.length && Date.now() < deadline; i += 8) {
    await Promise.all(ips.slice(i, i + 8).map(async (ip) => {
      try {
        const res = await withTimeout(reverse(ip), Math.min(1000, Math.max(1, deadline - Date.now())));
        if (res[0]) names.set(ip, res[0].replace(/\.$/, ""));
      } catch { /* no PTR, or out of time — blank */ }
    }));
  }
  for (const h of hops) h.rdns = h.ip ? names.get(h.ip) ?? null : null;
}

/** Trace to an IPv4 `dst`. Always resolves; problems land in `note`. */
export async function traceFromServer(dst: string, o: TraceOptions): Promise<TraceResult> {
  const started = Date.now();
  const rdnsBudget = Math.min(3000, Math.floor(o.budgetMs / 5));
  for (const tracer of candidates()) {
    if (_missing.has(tracer)) continue;
    const toolBudget = o.budgetMs - rdnsBudget;
    const sequential = tracer === "traceroute" && !_noSequentialFlag;
    let r = await runTool(tracer, tracerArgs(tracer, dst, o, sequential), toolBudget);
    if (r.missing) { _missing.add(tracer); continue; }
    let raw = PARSERS[tracer](r.out);
    if (sequential && !r.cut && raw.length === 0) {
      // No hops at all with -N: this traceroute may not know the flag (it
      // printed a usage message). Retry once without it, and keep it off if
      // that is what produced hops.
      const plain = await runTool(tracer, tracerArgs(tracer, dst, o, false), Math.max(1000, toolBudget - (Date.now() - started)));
      const plainRaw = plain.missing ? [] : PARSERS[tracer](plain.out);
      if (plainRaw.length) { _noSequentialFlag = true; r = plain; raw = plainRaw; }
    }
    const { hops, complete } = assembleTrace(raw, dst, o);
    let note: string | null = null;
    if (r.cut) note = `traceroute cut off at the ${Math.round((o.budgetMs - rdnsBudget) / 1000)} s budget`;
    else if (!complete && hops.length >= o.maxHops) note = `hop limit (${o.maxHops}) reached before the destination`;
    else if (!complete && hops.length && hops[hops.length - 1].ip && hops[hops.length - 1].ip !== dst) {
      note = "path ended before the destination (unreachable or filtered)";
    } else if (!hops.length) note = `${tracer} returned no hops`;
    await enrichRdns(hops, Math.max(0, Math.min(rdnsBudget, o.budgetMs - (Date.now() - started))));
    return { hops, complete, note };
  }
  return {
    hops: [],
    complete: false,
    note: process.platform === "win32"
      ? "no traceroute tool on this server (tracert not found)"
      : "no traceroute tool on this server — install the traceroute package (or iputils' tracepath)",
  };
}
