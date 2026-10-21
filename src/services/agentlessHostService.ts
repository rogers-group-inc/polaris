/**
 * src/services/agentlessHostService.ts
 *
 * CPU/memory, interfaces and storage from a Linux or Windows host over SSH or
 * WinRM — no Polaris Agent installed.
 *
 * These three streams accepted `ssh` / `winrm` at every validator and then fell
 * through to `{supported:false}` in their collectors, which `runTelemetryFor`
 * records as a SUCCESSFUL tick. An operator could point a fleet's CPU/memory at
 * SSH and receive nothing, forever, with every indicator green. This is the
 * missing half.
 *
 * Shape deliberately copied from `agentlessProcessService.ts`, which has been
 * doing exactly this for the processes stream: shipped-and-fixed command
 * constants, pure parsers that are the unit-test surface, and thin transports
 * over `sshExec` / `winrmRunPowershell`.
 *
 * **Commands are constants, not operator-editable.** Arbitrary remote commands
 * are RCE-equivalent and would belong behind the `automationScripts` fullwrite
 * gate with sha256 change auditing. Operators needing something bespoke have the
 * AutomationScript registry, which already has that machinery. Nothing here
 * interpolates caller input into a command line, so there is no shell-injection
 * surface to guard — if that ever changes, copy
 * `isShellSafeProcessName`'s posture from the sibling service.
 *
 * **One connection per host per tick.** `collectHostSsh` opens a single
 * `withSshClient` and runs every command inside it, the way
 * `collectProcessesSsh` does. At 2000 assets the TCP+auth handshake is the
 * dominant cost, not the parsing, so a per-stream connection would be the whole
 * expense. WinRM is stateless per call and has a WinRS command-length ceiling,
 * so it batches into as few scripts as fit instead.
 */

import type { WinRmConnection } from "../utils/winrm.js";
import { withSshClient, sshExec, winrmRunPowershell } from "../utils/remoteExec.js";
import { pickInterfaceAddresses } from "../utils/interfaceAddress.js";

export interface AgentlessTelemetry {
  cpuPct: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  memPct: number | null;
}

export interface AgentlessInterface {
  ifName: string;
  adminStatus: string | null;
  operStatus: string | null;
  speedBps: number | null;
  macAddress: string | null;
  /** First reportable IPv4. */
  ipAddress: string | null;
  /** First reportable IPv6 — never fe80:: (business rule 126). */
  ipv6Address?: string | null;
  inOctets: number | null;
  outOctets: number | null;
  inErrors: number | null;
  outErrors: number | null;
}

export interface AgentlessMount {
  mountPath: string;
  totalBytes: number | null;
  usedBytes: number | null;
}

export interface AgentlessHostResult {
  telemetry?: AgentlessTelemetry;
  interfaces?: AgentlessInterface[];
  storage?: AgentlessMount[];
}

export interface AgentlessHostOpts {
  telemetry: boolean;
  interfaces: boolean;
  storage: boolean;
  timeoutMs: number;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

// ─── Linux: CPU + memory ─────────────────────────────────────────────────────
//
// CPU utilisation is a RATE, so a single read of /proc/stat cannot produce it —
// that file holds cumulative jiffies since boot. Two snapshots a second apart in
// ONE command is the cheapest honest answer; the alternative (persisting the
// previous read per asset) would make the collector stateful for no gain.
// `LC_ALL=C` keeps the numeric formatting predictable.
export const LINUX_CPUMEM_COMMAND =
  "LC_ALL=C sh -c 'grep -w ^cpu /proc/stat; sleep 1; grep -w ^cpu /proc/stat; echo ---; cat /proc/meminfo'";

/** One `cpu  <user> <nice> <system> <idle> <iowait> <irq> <softirq> <steal>` row. */
function parseProcStatLine(line: string): { total: number; idle: number } | null {
  const parts = line.trim().split(/\s+/);
  if (parts[0] !== "cpu") return null;
  const vals = parts.slice(1).map((p) => Number(p)).filter((n) => Number.isFinite(n));
  if (vals.length < 4) return null;
  const total = vals.reduce((a, b) => a + b, 0);
  // idle + iowait — time the CPU had nothing to run.
  const idle = vals[3] + (vals[4] ?? 0);
  return { total, idle };
}

export function parseLinuxCpuMem(stdout: string): AgentlessTelemetry {
  const [cpuPart, memPart] = stdout.split(/^---$/m);
  let cpuPct: number | null = null;
  const cpuLines = (cpuPart || "").split("\n").map(parseProcStatLine).filter(Boolean) as Array<{ total: number; idle: number }>;
  if (cpuLines.length >= 2) {
    const a = cpuLines[0];
    const b = cpuLines[cpuLines.length - 1];
    const dTotal = b.total - a.total;
    const dIdle = b.idle - a.idle;
    // A counter that went backwards (reboot between snapshots) or didn't move
    // is not a reading — better null than a fabricated 0% or 100%.
    if (dTotal > 0 && dIdle >= 0 && dIdle <= dTotal) {
      cpuPct = Math.round(((dTotal - dIdle) / dTotal) * 1000) / 10;
    }
  }

  let totalKb: number | null = null;
  let availKb: number | null = null;
  for (const line of (memPart || "").split("\n")) {
    const m = line.match(/^(MemTotal|MemAvailable):\s+(\d+)\s*kB/);
    if (!m) continue;
    if (m[1] === "MemTotal") totalKb = Number(m[2]);
    else availKb = Number(m[2]);
  }
  // MemAvailable (not MemFree) is the kernel's own estimate of what a new
  // workload could claim — page cache is not "used" in any sense an operator
  // means, and reporting MemFree makes every healthy Linux box look full.
  const memTotalBytes = totalKb != null ? totalKb * 1024 : null;
  const memUsedBytes = totalKb != null && availKb != null ? (totalKb - availKb) * 1024 : null;
  const memPct =
    memTotalBytes && memUsedBytes != null && memTotalBytes > 0
      ? Math.round((memUsedBytes / memTotalBytes) * 1000) / 10
      : null;
  return { cpuPct, memUsedBytes, memTotalBytes, memPct };
}

// ─── Linux: interfaces ───────────────────────────────────────────────────────
//
// Read straight out of sysfs rather than parsing `ip`/`ifconfig` output, whose
// formatting varies by distro and version. Every field here is a file whose
// contents are a single value, so the format is stable across everything that
// has a /sys.
export const LINUX_INTERFACES_COMMAND =
  "LC_ALL=C sh -c 'for d in /sys/class/net/*; do n=$(basename $d); " +
  'echo "IF=$n"; ' +
  'echo "OPER=$(cat $d/operstate 2>/dev/null)"; ' +
  'echo "MAC=$(cat $d/address 2>/dev/null)"; ' +
  'echo "SPEED=$(cat $d/speed 2>/dev/null)"; ' +
  'echo "RXB=$(cat $d/statistics/rx_bytes 2>/dev/null)"; ' +
  'echo "TXB=$(cat $d/statistics/tx_bytes 2>/dev/null)"; ' +
  'echo "RXE=$(cat $d/statistics/rx_errors 2>/dev/null)"; ' +
  'echo "TXE=$(cat $d/statistics/tx_errors 2>/dev/null)"; ' +
  // Addresses aren't in sysfs. `ip -o` prints one address per line whatever
  // the distro, the 4th field being "addr/prefix"; each becomes an ADDR line
  // and the parser keeps one reportable address per family (business rule
  // 126). No iproute2 means no ADDR lines — the row is as it always was.
  'ip -o addr show dev "$n" 2>/dev/null | while read -r _i _n _f a _r; do echo "ADDR=$a"; done; ' +
  "done'";

export function parseLinuxInterfaces(stdout: string): AgentlessInterface[] {
  const out: AgentlessInterface[] = [];
  let cur: AgentlessInterface | null = null;
  let addrs: string[] = [];
  const push = () => {
    if (!cur || !cur.ifName) return;
    const picked = pickInterfaceAddresses(addrs);
    cur.ipAddress = picked.ipAddress;
    cur.ipv6Address = picked.ipv6Address;
    out.push(cur);
  };
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const val = line.slice(eq + 1).trim();
    if (key === "IF") {
      push();
      addrs = [];
      cur = {
        ifName: val, adminStatus: null, operStatus: null, speedBps: null, macAddress: null,
        ipAddress: null, inOctets: null, outOctets: null, inErrors: null, outErrors: null,
      };
      continue;
    }
    if (!cur) continue;
    switch (key) {
      case "OPER":
        cur.operStatus = val || null;
        // sysfs has no separate admin flag that is meaningful here: "down" is
        // administratively down, everything else is administratively up.
        cur.adminStatus = val ? (val === "down" ? "down" : "up") : null;
        break;
      // A virtual or unplugged NIC reports -1 (or nothing at all); only a real
      // negotiated link rate is a reading.
      case "SPEED": { const n = num(val); cur.speedBps = n != null && n > 0 ? n * 1_000_000 : null; break; }
      case "MAC":  cur.macAddress = val || null; break;
      case "RXB":  cur.inOctets  = num(val); break;
      case "TXB":  cur.outOctets = num(val); break;
      case "RXE":  cur.inErrors  = num(val); break;
      case "TXE":  cur.outErrors = num(val); break;
      case "ADDR": if (val) addrs.push(val); break;
    }
  }
  push();
  return out;
}

// ─── Linux: storage ──────────────────────────────────────────────────────────
//
// -P forces POSIX single-line output (a long device name otherwise wraps and
// breaks column parsing), -k fixes the unit at 1K blocks, -T names the FS type
// so pseudo-filesystems can be dropped.
export const LINUX_STORAGE_COMMAND = "LC_ALL=C df -PkT";

// Kernel bookkeeping, not storage. Reporting tmpfs/devtmpfs as mounts fills the
// System tab with rows nobody can act on, and /proc is always 0 bytes.
const LINUX_PSEUDO_FS = new Set([
  "tmpfs", "devtmpfs", "devfs", "overlay", "squashfs", "proc", "sysfs", "cgroup", "cgroup2",
  "debugfs", "tracefs", "securityfs", "pstore", "efivarfs", "configfs", "fusectl", "mqueue",
  "hugetlbfs", "ramfs", "autofs", "binfmt_misc", "nsfs", "iso9660",
]);

export function parseLinuxStorage(stdout: string): AgentlessMount[] {
  const out: AgentlessMount[] = [];
  const lines = stdout.split("\n");
  for (const line of lines.slice(1)) {
    const t = line.trim();
    if (!t) continue;
    // Filesystem Type 1K-blocks Used Available Capacity Mounted-on
    const m = t.match(/^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const fsType = m[2];
    if (LINUX_PSEUDO_FS.has(fsType)) continue;
    const totalKb = Number(m[3]);
    const usedKb = Number(m[4]);
    // A zero-size mount is a mount point with nothing behind it.
    if (!Number.isFinite(totalKb) || totalKb <= 0) continue;
    out.push({
      mountPath: m[7].trim(),
      totalBytes: totalKb * 1024,
      usedBytes: Number.isFinite(usedKb) ? usedKb * 1024 : null,
    });
  }
  return out;
}

// ─── Windows ─────────────────────────────────────────────────────────────────
//
// One script per stream: WinRS caps command length, and a single mega-script
// would also lose per-stream failure isolation. ConvertTo-Json with an explicit
// -Depth because the defaults truncate nested objects silently; `@()` forces an
// array so a single-row result still parses as one.
export const WINDOWS_CPUMEM_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$os=Get-CimInstance Win32_OperatingSystem",
  "$cpu=(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor|?{$_.Name -eq '_Total'}).PercentProcessorTime",
  "[pscustomobject]@{cpu=$cpu;totalKb=$os.TotalVisibleMemorySize;freeKb=$os.FreePhysicalMemory}|ConvertTo-Json -Compress",
].join(";");

export function parseWindowsCpuMem(stdout: string): AgentlessTelemetry {
  const o = safeJson(stdout) as Record<string, unknown> | null;
  if (!o) return { cpuPct: null, memUsedBytes: null, memTotalBytes: null, memPct: null };
  const totalKb = num(o.totalKb);
  const freeKb = num(o.freeKb);
  const memTotalBytes = totalKb != null ? totalKb * 1024 : null;
  const memUsedBytes = totalKb != null && freeKb != null ? (totalKb - freeKb) * 1024 : null;
  return {
    cpuPct: num(o.cpu),
    memUsedBytes,
    memTotalBytes,
    memPct:
      memTotalBytes && memUsedBytes != null && memTotalBytes > 0
        ? Math.round((memUsedBytes / memTotalBytes) * 1000) / 10
        : null,
  };
}

export const WINDOWS_INTERFACES_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$s=@{};Get-NetAdapterStatistics|%{$s[$_.Name]=$_}",
  // Every address per adapter, both families (business rule 126), privacy
  // (SuffixOrigin Random) addresses last so a stable one is picked first. Two
  // filtered passes over one read rather than Sort-Object, which is not stable
  // on Windows PowerShell 5.1 and could reorder an adapter's IPv4 addresses.
  // The server picks one reportable address per family — fe80:: never.
  "$ip=@{};$a=@(Get-NetIPAddress)",
  "$a|?{$_.SuffixOrigin -ne 'Random'}|%{$ip[$_.InterfaceAlias]+=@([string]$_.IPAddress)}",
  "$a|?{$_.SuffixOrigin -eq 'Random'}|%{$ip[$_.InterfaceAlias]+=@([string]$_.IPAddress)}",
  "@(Get-NetAdapter|%{[pscustomobject]@{n=$_.Name;admin=$_.AdminStatus;oper=$_.Status;speed=$_.LinkSpeed;" +
    "mac=$_.MacAddress;ips=@($ip[$_.Name]);rxb=$s[$_.Name].ReceivedBytes;txb=$s[$_.Name].SentBytes;" +
    "rxe=$s[$_.Name].ReceivedPacketsDiscarded;txe=$s[$_.Name].OutboundPacketsDiscarded}})|ConvertTo-Json -Depth 3 -Compress",
].join(";");

/** `Get-NetAdapter.LinkSpeed` is a display string — "1 Gbps", "100 Mbps". */
export function parseWindowsLinkSpeed(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^([\d.]+)\s*([GMK]?)bps$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = m[2].toUpperCase() === "G" ? 1e9 : m[2].toUpperCase() === "M" ? 1e6 : m[2].toUpperCase() === "K" ? 1e3 : 1;
  return Math.round(n * mult);
}

export function parseWindowsInterfaces(stdout: string): AgentlessInterface[] {
  const parsed = safeJson(stdout);
  const arr = Array.isArray(parsed) ? parsed : parsed != null ? [parsed] : [];
  const out: AgentlessInterface[] = [];
  for (const row of arr) {
    const r = row as Record<string, unknown>;
    const ifName = typeof r.n === "string" ? r.n : "";
    if (!ifName) continue;
    // `ips` is every address on the adapter; `ip` the single IPv4 an older
    // script sent. One per family, reportable only (business rule 126).
    const listed = Array.isArray(r.ips) ? r.ips.map((v) => (typeof v === "string" ? v : null)) : typeof r.ips === "string" ? [r.ips] : [];
    const addr = pickInterfaceAddresses(listed.length ? listed : [typeof r.ip === "string" ? r.ip : null]);
    out.push({
      ifName,
      adminStatus: r.admin != null ? String(r.admin).toLowerCase() : null,
      operStatus: r.oper != null ? String(r.oper).toLowerCase() : null,
      speedBps: parseWindowsLinkSpeed(r.speed),
      // Windows renders a MAC with dashes; every other source in Polaris uses
      // colons, and the identity joins downstream assume it.
      macAddress: typeof r.mac === "string" && r.mac ? r.mac.replace(/-/g, ":").toLowerCase() : null,
      ipAddress: addr.ipAddress,
      ipv6Address: addr.ipv6Address,
      inOctets: num(r.rxb),
      outOctets: num(r.txb),
      inErrors: num(r.rxe),
      outErrors: num(r.txe),
    });
  }
  return out;
}

export const WINDOWS_STORAGE_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "@(Get-Volume|?{$_.DriveType -eq 'Fixed' -and $_.Size -gt 0}|%{[pscustomobject]@{" +
    "path=$(if($_.DriveLetter){\"$($_.DriveLetter):\"}else{$_.Path});size=$_.Size;free=$_.SizeRemaining}})" +
    "|ConvertTo-Json -Depth 3 -Compress",
].join(";");

export function parseWindowsStorage(stdout: string): AgentlessMount[] {
  const parsed = safeJson(stdout);
  const arr = Array.isArray(parsed) ? parsed : parsed != null ? [parsed] : [];
  const out: AgentlessMount[] = [];
  for (const row of arr) {
    const r = row as Record<string, unknown>;
    const mountPath = typeof r.path === "string" ? r.path : "";
    const size = num(r.size);
    if (!mountPath || size == null || size <= 0) continue;
    const free = num(r.free);
    out.push({ mountPath, totalBytes: size, usedBytes: free != null ? size - free : null });
  }
  return out;
}

// ─── Event log ───────────────────────────────────────────────────────────────
//
// Feeds the SAME sink the agent's eventLog stream uses — `ingestOsEventLog`,
// which curates entries into the audit Event table and already applies the
// min-level filter, dedupe, per-push cap and per-asset hourly rate cap. So the
// only job here is to produce entries in that shape.
//
// `sinceMinutes` bounds the window rather than the row count: an hourly poll
// that asked for "the last 500 entries" would either miss a burst or re-ingest
// the same quiet hour repeatedly. `maxEntries` is the safety cap on top.

export interface AgentlessEventLogEntry {
  timestamp: string | null;
  channel: string;
  provider: string | null;
  eventId: number | null;
  /** Normalized to the sink's vocabulary: critical | error | warning | info. */
  level: string;
  message: string;
}

/** journalctl priorities: 0 emerg … 7 debug. Collapsed to the sink's four. */
export function journalPriorityToLevel(p: unknown): string {
  const n = typeof p === "number" ? p : Number(p);
  if (!Number.isFinite(n)) return "info";
  if (n <= 2) return "critical";  // emerg / alert / crit
  if (n === 3) return "error";
  if (n === 4) return "warning";
  return "info";
}

/**
 * `journalctl -o json` emits ONE JSON OBJECT PER LINE, not a JSON array — so
 * this parses line-by-line. A malformed line is skipped rather than failing the
 * batch; journald can emit binary-ish fields for some units.
 */
export function parseJournalctl(stdout: string, maxEntries: number): AgentlessEventLogEntry[] {
  const out: AgentlessEventLogEntry[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(t) as Record<string, unknown>; } catch { continue; }
    const message = typeof o.MESSAGE === "string" ? o.MESSAGE : "";
    if (!message) continue;
    // __REALTIME_TIMESTAMP is microseconds since epoch, as a STRING.
    let timestamp: string | null = null;
    const us = Number(o.__REALTIME_TIMESTAMP);
    if (Number.isFinite(us) && us > 0) timestamp = new Date(us / 1000).toISOString();
    out.push({
      timestamp,
      channel: typeof o.SYSLOG_IDENTIFIER === "string" && o.SYSLOG_IDENTIFIER ? o.SYSLOG_IDENTIFIER : "journal",
      provider: typeof o._SYSTEMD_UNIT === "string" ? o._SYSTEMD_UNIT : null,
      eventId: null,
      level: journalPriorityToLevel(o.PRIORITY),
      message,
    });
    if (out.length >= maxEntries) break;
  }
  return out;
}

/** Get-WinEvent Level: 1 critical, 2 error, 3 warning, 4 info, 5 verbose. */
export function winEventLevelToLevel(l: unknown): string {
  const n = typeof l === "number" ? l : Number(l);
  if (!Number.isFinite(n)) return "info";
  if (n === 1) return "critical";
  if (n === 2) return "error";
  if (n === 3) return "warning";
  return "info";
}

export function parseWindowsEventLog(stdout: string, maxEntries: number): AgentlessEventLogEntry[] {
  const parsed = safeJson(stdout);
  const arr = Array.isArray(parsed) ? parsed : parsed != null ? [parsed] : [];
  const out: AgentlessEventLogEntry[] = [];
  for (const row of arr) {
    const r = row as Record<string, unknown>;
    const message = typeof r.msg === "string" ? r.msg : "";
    if (!message) continue;
    out.push({
      timestamp: typeof r.t === "string" ? r.t : null,
      channel: typeof r.ch === "string" && r.ch ? r.ch : "Application",
      provider: typeof r.prov === "string" ? r.prov : null,
      eventId: num(r.id),
      level: winEventLevelToLevel(r.lvl),
      message,
    });
    if (out.length >= maxEntries) break;
  }
  return out;
}

/**
 * Only warning-and-above, and only within the window. Everything below that is
 * volume without signal, and the sink writes into the audit table that the
 * syslog / SFTP archivers ship off-host — so over-collecting here is not merely
 * noisy, it is someone else's disk.
 */
export function buildJournalctlCommand(sinceMinutes: number, maxEntries: number): string {
  const mins = Math.max(1, Math.floor(sinceMinutes));
  const n = Math.max(1, Math.floor(maxEntries));
  return `LC_ALL=C journalctl --no-pager -o json -p warning --since "-${mins}min" -n ${n} 2>/dev/null`;
}

export function buildWindowsEventLogScript(sinceMinutes: number, maxEntries: number): string {
  const mins = Math.max(1, Math.floor(sinceMinutes));
  const n = Math.max(1, Math.floor(maxEntries));
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `$since=(Get-Date).AddMinutes(-${mins})`,
    // Level 1-3 = critical/error/warning. -ErrorAction keeps an empty channel
    // (no matching events) from writing to stderr and looking like a failure.
    "$f=@{LogName=@('System','Application');Level=@(1,2,3);StartTime=$since}",
    `@(Get-WinEvent -FilterHashtable $f -MaxEvents ${n} -ErrorAction SilentlyContinue|%{[pscustomobject]@{` +
      "t=$_.TimeCreated.ToUniversalTime().ToString('o');ch=$_.LogName;prov=$_.ProviderName;" +
      "id=$_.Id;lvl=$_.Level;msg=$_.Message}})|ConvertTo-Json -Depth 3 -Compress",
  ].join(";");
}

export interface AgentlessEventLogOpts {
  sinceMinutes: number;
  maxEntries: number;
  timeoutMs: number;
}

export async function collectEventLogSsh(
  host: string,
  credConfig: Record<string, unknown>,
  opts: AgentlessEventLogOpts,
): Promise<AgentlessEventLogEntry[] | undefined> {
  return withSshClient(host, credConfig, async (client) => {
    const r = await sshExec(client, buildJournalctlCommand(opts.sinceMinutes, opts.maxEntries), opts.timeoutMs);
    // journalctl exits 1 when the window matched nothing — a successful empty
    // scrape, not a failure.
    if (r.exitCode !== 0 && r.exitCode !== 1 && !r.stdout.trim()) return undefined;
    return parseJournalctl(r.stdout, opts.maxEntries);
  });
}

export async function collectEventLogWinrm(
  conn: WinRmConnection,
  opts: AgentlessEventLogOpts,
): Promise<AgentlessEventLogEntry[] | undefined> {
  const r = await winrmRunPowershell(conn, buildWindowsEventLogScript(opts.sinceMinutes, opts.maxEntries));
  if (r.exitCode !== 0 && !r.stdout.trim()) return undefined;
  return parseWindowsEventLog(r.stdout, opts.maxEntries);
}

// ─── Transports ──────────────────────────────────────────────────────────────

/**
 * Every requested stream over ONE SSH connection. A per-stream connection would
 * make the handshake the dominant cost at fleet scale — see the header.
 *
 * A stream whose command fails is left undefined rather than throwing, so one
 * unreadable path (a hardened box with no /sys, say) doesn't cost the others.
 * `undefined` is meaningful downstream: the persist layer leaves stored rows
 * alone rather than wiping them.
 */
export async function collectHostSsh(
  host: string,
  credConfig: Record<string, unknown>,
  opts: AgentlessHostOpts,
): Promise<AgentlessHostResult> {
  if (!opts.telemetry && !opts.interfaces && !opts.storage) return {};
  return withSshClient(host, credConfig, async (client) => {
    const result: AgentlessHostResult = {};
    const run = async (cmd: string): Promise<string | null> => {
      const r = await sshExec(client, cmd, opts.timeoutMs);
      // df exits non-zero when ANY filesystem is unreadable while still
      // printing the rest, so a usable stdout beats the exit code.
      if (r.exitCode !== 0 && !r.stdout.trim()) return null;
      return r.stdout;
    };
    if (opts.telemetry) {
      const out = await run(LINUX_CPUMEM_COMMAND);
      if (out) result.telemetry = parseLinuxCpuMem(out);
    }
    if (opts.interfaces) {
      const out = await run(LINUX_INTERFACES_COMMAND);
      if (out) result.interfaces = parseLinuxInterfaces(out);
    }
    if (opts.storage) {
      const out = await run(LINUX_STORAGE_COMMAND);
      if (out) result.storage = parseLinuxStorage(out);
    }
    return result;
  });
}

/** Same over WinRM. Stateless per call, so one script per stream. */
export async function collectHostWinrm(
  conn: WinRmConnection,
  opts: AgentlessHostOpts,
): Promise<AgentlessHostResult> {
  const result: AgentlessHostResult = {};
  const run = async (script: string): Promise<string | null> => {
    const r = await winrmRunPowershell(conn, script);
    if (r.exitCode !== 0 && !r.stdout.trim()) return null;
    return r.stdout;
  };
  if (opts.telemetry) {
    const out = await run(WINDOWS_CPUMEM_SCRIPT);
    if (out) result.telemetry = parseWindowsCpuMem(out);
  }
  if (opts.interfaces) {
    const out = await run(WINDOWS_INTERFACES_SCRIPT);
    if (out) result.interfaces = parseWindowsInterfaces(out);
  }
  if (opts.storage) {
    const out = await run(WINDOWS_STORAGE_SCRIPT);
    if (out) result.storage = parseWindowsStorage(out);
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
