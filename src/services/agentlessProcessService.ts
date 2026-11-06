/**
 * src/services/agentlessProcessService.ts — agentless (SSH / WinRM) collection
 * for the `processes` stream: full process inventory, pinned-process CPU/RAM
 * telemetry, and mapped-process connection discovery (Application Map).
 *
 * Until this landed the processes stream was agent-only — the compatibility
 * matrix advertised ssh/winrm but no server-side collector existed. The two
 * orchestrators here are called from monitoringService.runProcessesFor on the
 * "processes" monitor cadence:
 *
 *   collectProcessesSsh(host, credConfig, opts)   — Linux over SSH
 *   collectProcessesWinrm(conn, opts)             — Windows over WinRM
 *
 * Both share one contract (AgentlessProcessResult): `inventory` when the
 * inventory pass is due, `telemetry` rows for the monitored (pinned) names,
 * `connections` rows for the mapped names. Everything below the transport
 * calls is a pure parser, unit-tested against fixture output.
 *
 * Linux commands (locale-pinned, machine-parseable):
 *   inventory/telemetry: LC_ALL=C ps -eo pid=,pcpu=,rss=,etimes=,user:32=,comm=
 *     - pcpu is LIFETIME-average CPU (not the agent's 300ms instantaneous
 *       window) — accepted fidelity tradeoff; a two-sample delta over SSH
 *       isn't worth the extra round-trip.
 *     - comm is kernel-truncated to 15 chars, same as gopsutil's Name() on
 *       Linux — pin names stay consistent across the agent/ssh transports.
 *   connections (mapped names embedded, filtered ON-HOST — never full-host
 *   collect-then-filter):
 *     LC_ALL=C ss -tunapH | grep -F -e '"<name>"' ... | head -n 3000
 *     - `ss` prints owners as users:(("name",pid=N,fd=M)); quoting the name in
 *       the -F pattern keys the match on the process token, not addresses.
 *     - grep exits 1 on no match — treated as an empty scrape, not an error.
 *     - `ss -p` only resolves owners for sockets the SSH user can see in
 *       /proc: full socket→process attribution effectively requires root (or
 *       sudo). Rows without a process token never match the grep and are
 *       dropped on-host.
 *
 * Windows: two compact PowerShell scripts (ConvertTo-Json -Compress) run via
 * winrmRunPowershell. Kept small — WinRS routes through cmd.exe (8191-char
 * ceiling) and -EncodedCommand inflates ~2.7×. Process names use Get-Process
 * ProcessName (no ".exe"), username is skipped (needs elevation), and CPU%
 * comes from Win32_PerfFormattedData_PerfProc_Process (instantaneous-ish in
 * one call; instance names carry #N suffixes, which is why the script joins
 * back through PID → ProcessName).
 */

import type { WinRmConnection } from "../utils/winrm.js";
import { winrmRunPowershell, withSshClient, sshExec } from "../utils/remoteExec.js";
import type { AssetProcessInput, ProcessConnectionInput } from "./monitoringService.js";
import { AppError } from "../utils/errors.js";

// ─── Result contract ──────────────────────────────────────────────────

export interface ProcessTelemetryRow {
  name:          string;
  cpuPct:        number | null;
  memRssBytes:   bigint | null;
  instanceCount: number;
}

export interface AgentlessProcessResult {
  /** Full inventory (present only when opts.inventory was set). */
  inventory?:   AssetProcessInput[];
  /** Per-monitored-name CPU/RAM rows (present when opts.monitored non-empty). */
  telemetry?:   ProcessTelemetryRow[];
  /** Connection facts for the mapped names (present when opts.mapped non-empty). */
  connections?: ProcessConnectionInput[];
}

export interface AgentlessProcessOpts {
  inventory: boolean;
  monitored: string[];
  mapped:    string[];
  timeoutMs: number;
}

// ─── Shared name sanitization ─────────────────────────────────────────
//
// Mapped names are embedded into a remote command line (grep pattern / PS
// array literal). NEVER shell-interpolate raw operator input: names outside
// this conservative charset are skipped (they can't be collected agentless).
const SAFE_PROC_NAME = /^[A-Za-z0-9._+@:()\[\]\- ]+$/;

export function isShellSafeProcessName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && SAFE_PROC_NAME.test(name);
}

// ─── Generic per-PID row (both platforms parse into this) ─────────────

export interface PsRow {
  pid:       number;
  name:      string;
  cpuPct:    number | null;
  rssBytes:  number | null;
  user:      string | null;
  /** Process start, ms since epoch; null when unknown. */
  startMsec: number | null;
}

/** Aggregate per-PID rows into one AssetProcessInput per program name —
 * mirrors the agent's aggregateByName (count, summed cpu/rss, earliest start,
 * first non-empty user). serviceUnit resolution is agent-only → null. */
export function aggregatePsRows(rows: PsRow[]): AssetProcessInput[] {
  interface Agg { count: number; cpu: number; hasCpu: boolean; rss: number; hasRss: boolean; user: string | null; startMsec: number | null }
  const byName = new Map<string, Agg>();
  for (const r of rows) {
    if (!r.name) continue;
    let a = byName.get(r.name);
    if (!a) { a = { count: 0, cpu: 0, hasCpu: false, rss: 0, hasRss: false, user: null, startMsec: null }; byName.set(r.name, a); }
    a.count++;
    if (r.cpuPct != null)   { a.cpu += r.cpuPct; a.hasCpu = true; }
    if (r.rssBytes != null) { a.rss += r.rssBytes; a.hasRss = true; }
    if (!a.user && r.user) a.user = r.user;
    if (r.startMsec != null && (a.startMsec == null || r.startMsec < a.startMsec)) a.startMsec = r.startMsec;
  }
  const out: AssetProcessInput[] = [];
  for (const [name, a] of byName) {
    out.push({
      name,
      instanceCount: a.count,
      cpuPct:        a.hasCpu ? a.cpu : null,
      memRssBytes:   a.hasRss ? BigInt(Math.round(a.rss)) : null,
      exePath:       null,
      username:      a.user,
      startedAt:     a.startMsec != null ? new Date(a.startMsec) : null,
      serviceUnit:   null,
      controllable:  false,
    });
  }
  // Busiest first, then name — same presentation order as the agent.
  out.sort((x, y) => (Number(y.cpuPct ?? 0) - Number(x.cpuPct ?? 0)) || x.name.localeCompare(y.name));
  return out;
}

export function telemetryFromPsRows(rows: PsRow[], monitored: string[]): ProcessTelemetryRow[] {
  const want = new Set(monitored);
  const agg = aggregatePsRows(rows.filter((r) => want.has(r.name)));
  return agg.map((a) => ({
    name:          a.name,
    cpuPct:        a.cpuPct,
    memRssBytes:   a.memRssBytes,
    instanceCount: a.instanceCount,
  }));
}

// ─── Linux parsers ────────────────────────────────────────────────────

const LINUX_PS_COMMAND = "LC_ALL=C ps -eo pid=,pcpu=,rss=,etimes=,user:32=,comm=";

/** Parse `ps -eo pid=,pcpu=,rss=,etimes=,user:32=,comm=` output. `nowMs` anchors
 * etimes → startedAt. Malformed lines are skipped. */
export function parseLinuxPs(stdout: string, nowMs: number): PsRow[] {
  const out: PsRow[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    // pid pcpu rss etimes user comm... (comm last — may contain spaces)
    const m = t.match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const etimes = Number(m[4]);
    out.push({
      pid:       Number(m[1]),
      name:      m[6].trim(),
      cpuPct:    Number.isFinite(Number(m[2])) ? Number(m[2]) : null,
      rssBytes:  Number.isFinite(Number(m[3])) ? Number(m[3]) * 1024 : null, // rss is KiB
      user:      m[5],
      startMsec: Number.isFinite(etimes) ? nowMs - etimes * 1000 : null,
    });
  }
  return out;
}

export function buildLinuxSsCommand(mappedNames: string[]): string | null {
  const safe = mappedNames.filter(isShellSafeProcessName);
  if (safe.length === 0) return null;
  // -F fixed-string patterns keyed on ss's quoted process token. grep exits 1
  // on no match; the caller treats exit 0/1 both as success.
  const patterns = safe.map((n) => `-e '"${n}"'`).join(" ");
  return `LC_ALL=C ss -tunapH 2>/dev/null | grep -F ${patterns} | head -n 3000`;
}

/** One parsed socket line, pre-heuristic. */
export interface RawSocketRow {
  name:       string;
  proto:      "tcp" | "udp";
  /** "LISTEN" | "ESTAB" | "UNCONN" | ... (ss) or "Listen"/"Established" (Windows); "" for UDP endpoints. */
  state:      string;
  localAddr:  string;
  localPort:  number;
  remoteAddr: string;
  remotePort: number;
}

const SS_OWNER_RE = /\("([^"]*)",pid=\d+/g;

/** Split an ss addr:port token ("0.0.0.0:80", "[::]:443", "*:*", "[fe80::1%eth0]:22"). */
function splitAddrPort(tok: string): { addr: string; port: number } | null {
  const i = tok.lastIndexOf(":");
  if (i < 0) return null;
  let addr = tok.slice(0, i);
  const portStr = tok.slice(i + 1);
  const port = portStr === "*" ? 0 : Number(portStr);
  if (!Number.isFinite(port) || port < 0 || port > 65535) return null;
  if (addr.startsWith("[") && addr.endsWith("]")) addr = addr.slice(1, -1);
  if (addr === "*") addr = "";
  return { addr: normalizeIp(addr), port };
}

/** Parse `ss -tunapH` output lines (already grep-filtered to mapped names). */
export function parseLinuxSs(stdout: string): RawSocketRow[] {
  const out: RawSocketRow[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    // netid state recvq sendq local peer [process]
    const cols = t.split(/\s+/);
    if (cols.length < 6) continue;
    const netid = cols[0].toLowerCase();
    const proto: "tcp" | "udp" | null = netid.startsWith("tcp") ? "tcp" : netid.startsWith("udp") ? "udp" : null;
    if (!proto) continue;
    const local = splitAddrPort(cols[4]);
    const peer  = splitAddrPort(cols[5]);
    if (!local) continue;
    // Owner process names from the trailing users:(…) — one row per name (a
    // socket shared by N pids of the same program dedups later anyway).
    const owners = new Set<string>();
    for (const m of t.matchAll(SS_OWNER_RE)) {
      if (m[1]) owners.add(m[1]);
    }
    for (const name of owners) {
      // A `*` peer port means unconnected (ss prints 0.0.0.0:* / [::]:*) —
      // blank the peer address too so "no peer" is representable one way.
      const remotePort = peer?.port ?? 0;
      out.push({
        name,
        proto,
        state:      cols[1].toUpperCase(),
        localAddr:  local.addr,
        localPort:  local.port,
        remoteAddr: remotePort === 0 ? "" : (peer?.addr ?? ""),
        remotePort,
      });
    }
  }
  return out;
}

// ─── Windows PowerShell scripts + parsers ─────────────────────────────

// Per-PID process table: [{p: pid, n: name, c: cpuPct|null, w: workingSetBytes,
// s: startISO|null}]. PerfFormattedData gives an instantaneous-ish CPU%
// normalized by core count server-side? No — PercentProcessorTime can exceed
// 100 on multi-core (per-core sum), same semantics as the agent's summed
// gopsutil percent, so it lands as-is.
const WINDOWS_PS_PROCESS_SCRIPT = [
  `$ErrorActionPreference='SilentlyContinue'`,
  `$c=@{};Get-CimInstance Win32_PerfFormattedData_PerfProc_Process|%{$c[[int]$_.IDProcess]=$_.PercentProcessorTime}`,
  `Get-Process|%{[pscustomobject]@{p=$_.Id;n=$_.ProcessName;c=$c[[int]$_.Id];w=$_.WorkingSet64;s=$(try{$_.StartTime.ToUniversalTime().ToString('o')}catch{$null})}}|ConvertTo-Json -Compress`,
].join(";");

export function parseWindowsProcessJson(stdout: string): PsRow[] {
  const parsed = safeJson(stdout);
  const arr = Array.isArray(parsed) ? parsed : parsed != null ? [parsed] : [];
  const out: PsRow[] = [];
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const pid = Number(o.p);
    const name = typeof o.n === "string" ? o.n : "";
    if (!Number.isFinite(pid) || !name) continue;
    const start = typeof o.s === "string" ? Date.parse(o.s) : NaN;
    out.push({
      pid,
      name,
      cpuPct:    o.c != null && Number.isFinite(Number(o.c)) ? Number(o.c) : null,
      rssBytes:  o.w != null && Number.isFinite(Number(o.w)) ? Number(o.w) : null,
      user:      null, // needs elevation (-IncludeUserName) — skipped agentless
      startMsec: Number.isFinite(start) ? start : null,
    });
  }
  return out;
}

export function buildWindowsConnectionsScript(mappedNames: string[]): string | null {
  const safe = mappedNames.filter(isShellSafeProcessName).filter((n) => !n.includes("'"));
  if (safe.length === 0) return null;
  const arr = safe.map((n) => `'${n}'`).join(",");
  return [
    `$ErrorActionPreference='SilentlyContinue'`,
    `$m=@(${arr})`,
    `$p=@{};Get-Process|?{$m -contains $_.ProcessName}|%{$p[[string]$_.Id]=$_.ProcessName}`,
    `if($p.Count -eq 0){'{"t":[],"u":[],"p":{}}'}else{`,
    `$t=@(Get-NetTCPConnection|?{$p.ContainsKey([string]$_.OwningProcess)}|Select State,LocalAddress,LocalPort,RemoteAddress,RemotePort,OwningProcess)`,
    `$u=@(Get-NetUDPEndpoint|?{$p.ContainsKey([string]$_.OwningProcess)}|Select LocalAddress,LocalPort,OwningProcess)`,
    `@{t=$t;u=$u;p=$p}|ConvertTo-Json -Compress -Depth 4}`,
  ].join(";");
}

/** Parse the {t, u, p} JSON from the Windows connections script into raw rows. */
export function parseWindowsConnectionsJson(stdout: string): RawSocketRow[] {
  const parsed = safeJson(stdout);
  if (!parsed || typeof parsed !== "object") return [];
  const o = parsed as Record<string, unknown>;
  const pidNames = (o.p && typeof o.p === "object" ? o.p : {}) as Record<string, unknown>;
  const nameOf = (pid: unknown): string => {
    const v = pidNames[String(pid)];
    return typeof v === "string" ? v : "";
  };
  const out: RawSocketRow[] = [];
  const tcp = Array.isArray(o.t) ? o.t : o.t ? [o.t] : [];
  for (const it of tcp) {
    if (!it || typeof it !== "object") continue;
    const r = it as Record<string, unknown>;
    const name = nameOf(r.OwningProcess);
    if (!name) continue;
    // Get-NetTCPConnection State serializes as a number under ConvertTo-Json
    // (enum) or a string depending on PS version — accept both.
    const state = tcpStateName(r.State);
    out.push({
      name,
      proto:      "tcp",
      state,
      localAddr:  normalizeIp(String(r.LocalAddress ?? "")),
      localPort:  portOf(r.LocalPort),
      remoteAddr: normalizeIp(String(r.RemoteAddress ?? "")),
      remotePort: portOf(r.RemotePort),
    });
  }
  const udp = Array.isArray(o.u) ? o.u : o.u ? [o.u] : [];
  for (const it of udp) {
    if (!it || typeof it !== "object") continue;
    const r = it as Record<string, unknown>;
    const name = nameOf(r.OwningProcess);
    if (!name) continue;
    out.push({
      name,
      proto:      "udp",
      state:      "",
      localAddr:  normalizeIp(String(r.LocalAddress ?? "")),
      localPort:  portOf(r.LocalPort),
      remoteAddr: "",
      remotePort: 0,
    });
  }
  return out;
}

function portOf(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 65535 ? n : 0;
}

// MIB-II / MS TcpState enum → ss-style token. ConvertTo-Json emits the numeric
// value for the enum on Windows PowerShell 5.1.
const TCP_STATE_BY_NUM: Record<number, string> = {
  1: "CLOSED", 2: "LISTEN", 3: "SYN-SENT", 4: "SYN-RECEIVED", 5: "ESTABLISHED",
  6: "FIN-WAIT-1", 7: "FIN-WAIT-2", 8: "CLOSE-WAIT", 9: "CLOSING", 10: "LAST-ACK",
  11: "TIME-WAIT", 12: "DELETE-TCB",
};

function tcpStateName(v: unknown): string {
  if (typeof v === "number") return TCP_STATE_BY_NUM[v] ?? String(v);
  return String(v ?? "").toUpperCase();
}

// ─── Shared direction heuristic (server-side mirror of the agent's) ──────────

const LOOPBACK_RE = /^(127\.|::1$)/;

function normalizeIp(s: string): string {
  let v = s.trim();
  if (!v || v === "*") return "";
  const zone = v.indexOf("%");
  if (zone >= 0) v = v.slice(0, zone);
  if (v.toLowerCase().startsWith("::ffff:") && v.includes(".")) v = v.slice(7);
  return v.toLowerCase();
}

/**
 * Apply the direction heuristic to raw socket rows, restricted to the mapped
 * names: LISTEN/unconnected-UDP → listen (feeding the per-(name, proto)
 * listen-port set); established rows land inbound when their LOCAL port is in
 * that set (peer's ephemeral port dropped), else outbound (our ephemeral
 * source port dropped). Loopback peers are noise and skipped; listen rows keep
 * loopback binds. Dedup falls out of the dropped ephemeral ports; hard caps
 * live in persistProcessConnections.
 */
export function buildConnectionRows(raws: RawSocketRow[], mapped: string[]): ProcessConnectionInput[] {
  const want = new Set(mapped);
  const rows = raws.filter((r) => want.has(r.name));
  const isListen = (r: RawSocketRow): boolean =>
    r.proto === "tcp" ? r.state === "LISTEN" : (!r.remoteAddr || r.remotePort === 0);

  const listenPorts = new Map<string, Set<number>>(); // "name/proto" → ports
  const out: ProcessConnectionInput[] = [];
  const seen = new Set<string>();
  const add = (row: ProcessConnectionInput) => {
    const k = JSON.stringify([row.processName, row.kind, row.proto, row.localAddr, row.localPort, row.remoteIp, row.remotePort]);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(row);
  };

  for (const r of rows) {
    if (!isListen(r)) continue;
    const lk = `${r.name}/${r.proto}`;
    let set = listenPorts.get(lk);
    if (!set) { set = new Set(); listenPorts.set(lk, set); }
    set.add(r.localPort);
    add({ processName: r.name, kind: "listen", proto: r.proto, localAddr: r.localAddr, localPort: r.localPort, remoteIp: "", remotePort: 0 });
  }
  for (const r of rows) {
    if (isListen(r) || !r.remoteAddr || r.remotePort === 0) continue;
    // Only genuinely-connected rows carry direction information; transient
    // teardown states (TIME-WAIT etc.) on tcp are skipped.
    if (r.proto === "tcp" && r.state !== "ESTAB" && r.state !== "ESTABLISHED") continue;
    if (LOOPBACK_RE.test(r.remoteAddr)) continue;
    if (listenPorts.get(`${r.name}/${r.proto}`)?.has(r.localPort)) {
      add({ processName: r.name, kind: "inbound", proto: r.proto, localAddr: "", localPort: r.localPort, remoteIp: r.remoteAddr, remotePort: 0 });
    } else {
      add({ processName: r.name, kind: "outbound", proto: r.proto, localAddr: "", localPort: 0, remoteIp: r.remoteAddr, remotePort: r.remotePort });
    }
  }
  return out;
}

// ─── Orchestrators ────────────────────────────────────────────────────

/** Linux over SSH. One session for both sub-passes. */
export async function collectProcessesSsh(
  host: string,
  credConfig: Record<string, unknown>,
  opts: AgentlessProcessOpts,
): Promise<AgentlessProcessResult> {
  const needPs = opts.inventory || opts.monitored.length > 0;
  const ssCmd = opts.mapped.length > 0 ? buildLinuxSsCommand(opts.mapped) : null;
  if (!needPs && !ssCmd) return {};

  return withSshClient(host, credConfig, async (client) => {
    const result: AgentlessProcessResult = {};
    if (needPs) {
      const ps = await sshExec(client, LINUX_PS_COMMAND, opts.timeoutMs);
      if (ps.exitCode !== 0) {
        throw new AppError(502, `ps exited ${ps.exitCode}: ${(ps.stderr || ps.stdout).slice(0, 200)}`);
      }
      const rows = parseLinuxPs(ps.stdout, Date.now());
      if (opts.inventory) result.inventory = aggregatePsRows(rows);
      if (opts.monitored.length > 0) result.telemetry = telemetryFromPsRows(rows, opts.monitored);
    }
    if (ssCmd) {
      const ss = await sshExec(client, ssCmd, opts.timeoutMs);
      // grep exits 1 when nothing matched — a valid empty scrape.
      if (ss.exitCode !== 0 && ss.exitCode !== 1) {
        throw new AppError(502, `ss exited ${ss.exitCode}: ${(ss.stderr || ss.stdout).slice(0, 200)}`);
      }
      result.connections = buildConnectionRows(parseLinuxSs(ss.stdout), opts.mapped);
    }
    return result;
  });
}

/** Windows over WinRM. One script per sub-pass (WinRS command-length ceiling). */
export async function collectProcessesWinrm(
  conn: WinRmConnection,
  opts: AgentlessProcessOpts,
): Promise<AgentlessProcessResult> {
  const result: AgentlessProcessResult = {};
  if (opts.inventory || opts.monitored.length > 0) {
    const out = await winrmRunPowershell(conn, WINDOWS_PS_PROCESS_SCRIPT);
    if (out.exitCode !== 0) {
      throw new AppError(502, `process script exited ${out.exitCode}: ${(out.stderr || out.stdout).slice(0, 200)}`);
    }
    const rows = parseWindowsProcessJson(out.stdout);
    if (opts.inventory) result.inventory = aggregatePsRows(rows);
    if (opts.monitored.length > 0) result.telemetry = telemetryFromPsRows(rows, opts.monitored);
  }
  if (opts.mapped.length > 0) {
    const script = buildWindowsConnectionsScript(opts.mapped);
    if (script) {
      const out = await winrmRunPowershell(conn, script);
      if (out.exitCode !== 0) {
        throw new AppError(502, `connections script exited ${out.exitCode}: ${(out.stderr || out.stdout).slice(0, 200)}`);
      }
      result.connections = buildConnectionRows(parseWindowsConnectionsJson(out.stdout), opts.mapped);
    }
  }
  return result;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
