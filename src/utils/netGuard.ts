/**
 * src/utils/netGuard.ts — SSRF guard for operator-supplied outbound hosts.
 *
 * Integrations (FortiManager, FortiGate, Active Directory, Windows Server) take
 * an operator-entered `host`, and Polaris then issues authenticated outbound
 * requests to it — including the FMG proxy path, which relays arbitrary FortiOS
 * API calls. Without a guard, a caller with `integrations:write` can aim Polaris
 * at internal-only targets (the cloud metadata endpoint, the loopback DB, a
 * link-local address) and use the server as a request relay / port scanner.
 *
 * The guard is deliberately a *blocklist of dangerous ranges*, NOT an allowlist
 * of public IPs: every real Polaris deployment talks to devices on RFC1918 LANs
 * (10/8, 172.16/12, 192.168/16) and ULA IPv6 — those MUST stay allowed. What we
 * reject is the set of addresses that only make sense as an SSRF target:
 *
 *   - loopback            127.0.0.0/8, ::1          (reach Polaris's own host)
 *   - link-local          169.254.0.0/16, fe80::/10 (incl. 169.254.169.254 —
 *                                                     AWS/GCP/Azure metadata)
 *   - unspecified         0.0.0.0/8, ::
 *   - multicast           224.0.0.0/4, ff00::/8
 *   - "localhost" literal
 *
 * (Business rule 110.) The judgement is made on the ADDRESS, not on the text the
 * operator typed. The URL parser and getaddrinfo accept far more spellings of an
 * address than the dotted quad — `127.1`, `2130706433`, `0x7f000001`, `0177.0.0.1`,
 * `[::ffff:7f00:1]` (which is what the WHATWG parser rewrites `[::ffff:127.0.0.1]`
 * into), `[0:0:0:0:0:0:0:1]`, `localhost.` — so a literal is first parsed the way
 * the URL parser parses it and the numbers are what is compared. An IPv6 address
 * that embeds an IPv4 one (mapped, compatible, NAT64, 6to4) is judged by the
 * embedded address.
 *
 * A NAME is judged when it is connected to: `guardedLookup` is a `lookup` for
 * `net` / `http` / `https` / undici that resolves every record and refuses the
 * connection if any of them is blocked, and `resolveAllowedHost` does the same
 * ahead of a client we cannot hand a lookup to (it returns the address to pin).
 * That closes the DNS-rebinding hole the 2026-06-03 review (M4) left open.
 */

import dns from "node:dns";
import net from "node:net";

type Kind = "loopback" | "other";

type LookupCb = (err: NodeJS.ErrnoException | null, addrs: dns.LookupAddress[]) => void;
interface Resolver {
  all(host: string, options: dns.LookupOptions, cb: LookupCb): void;
  allAsync(host: string): Promise<dns.LookupAddress[]>;
}
const systemResolver: Resolver = {
  all: (host, options, cb) => dns.lookup(host, { ...options, all: true }, cb as any),
  allAsync: (host) => dns.promises.lookup(host, { all: true }),
};
let resolver: Resolver = systemResolver;

/** Tests only: swap the DNS resolver (pass null to restore the system one). */
export function _setResolverForTests(r: Resolver | null): void {
  resolver = r ?? systemResolver;
}

/**
 * Parse one WHATWG "IPv4 number": 0x… hex, a leading 0 for octal, else decimal.
 * Returns null for anything else (including an empty part).
 */
function parseV4Number(part: string): number | null {
  if (part === "") return null;
  let radix = 10;
  let s = part;
  if (/^0x/i.test(s)) {
    radix = 16;
    s = s.slice(2);
    if (s === "") return 0;
  } else if (s.length > 1 && s.startsWith("0")) {
    radix = 8;
    s = s.slice(1);
  }
  const ok = radix === 16 ? /^[0-9a-f]+$/i : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
  if (!ok.test(s)) return null;
  const n = parseInt(s, radix);
  return Number.isFinite(n) ? n : null;
}

/**
 * The URL parser's IPv4 parser: 1–4 dot-separated numbers in any of the three
 * radixes, the last one filling the remaining bytes. Returns the 32-bit value,
 * or null when the text is not an IPv4 address in any spelling.
 */
function parseIpv4Any(h: string): number | null {
  const parts = h.split(".");
  if (parts[parts.length - 1] === "" && parts.length > 1) parts.pop();
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const n = parseV4Number(p);
    if (n === null) return null;
    nums.push(n);
  }
  for (let i = 0; i < nums.length - 1; i++) if (nums[i] > 255) return null;
  const last = nums[nums.length - 1];
  if (last >= 256 ** (5 - nums.length)) return null;
  let v = last;
  for (let i = 0; i < nums.length - 1; i++) v += nums[i] * 256 ** (3 - i);
  return v;
}

/** True when the last label is a number in the URL parser's eyes (so the host IS an IPv4 address or invalid). */
function endsInNumber(h: string): boolean {
  const parts = h.split(".");
  if (parts[parts.length - 1] === "" && parts.length > 1) parts.pop();
  const last = parts[parts.length - 1];
  return /^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/i.test(last);
}

/** Expand an IPv6 literal to its eight 16-bit groups; null if it is not one. */
function expandV6(ip: string): number[] | null {
  if (!net.isIPv6(ip)) return null;
  let s = ip;
  const tail = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const v4 = parseIpv4Any(tail[2]);
    if (v4 === null) return null;
    s = `${tail[1]}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  let groups: string[];
  if (s.includes("::")) {
    const [head, rest] = s.split("::");
    const h = head ? head.split(":") : [];
    const t = rest ? rest.split(":") : [];
    groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  } else {
    groups = s.split(":");
  }
  if (groups.length !== 8) return null;
  const out = groups.map((g) => parseInt(g, 16));
  return out.some((n) => !Number.isFinite(n)) ? null : out;
}

function kindOfV4(v: number): Kind | null {
  const a = v >>> 24;
  if (a === 127) return "loopback";
  if (a === 0) return "other"; // 0.0.0.0/8 "this host"
  if (a >= 224 && a <= 239) return "other"; // multicast
  if (a === 169 && ((v >>> 16) & 0xff) === 254) return "other"; // link-local + cloud metadata
  return null;
}

function kindOfV6(g: number[]): Kind | null {
  const zeroTo = (n: number): boolean => g.slice(0, n).every((x) => x === 0);
  if (zeroTo(7) && g[7] === 1) return "loopback"; // ::1
  if (zeroTo(7) && g[7] === 0) return "other"; // ::
  if ((g[0] & 0xffc0) === 0xfe80) return "other"; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return "other"; // fec0::/10 deprecated site-local
  if ((g[0] & 0xff00) === 0xff00) return "other"; // ff00::/8 multicast
  const embedded = (hi: number, lo: number): Kind | null => kindOfV4(((hi << 16) | lo) >>> 0);
  if (zeroTo(5) && g[5] === 0xffff) return embedded(g[6], g[7]); // ::ffff:a.b.c.d (mapped)
  if (zeroTo(6)) return embedded(g[6], g[7]); // ::a.b.c.d (compatible)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(g[6], g[7]); // NAT64
  if (g[0] === 0x2002) return embedded(g[1], g[2]); // 6to4
  return null;
}

/** Strip an optional zone id (e.g. fe80::1%eth0), surrounding brackets and trailing dots. */
function normalizeHost(host: string): string {
  let h = String(host ?? "").trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  const pct = h.indexOf("%");
  if (pct !== -1) h = h.slice(0, pct);
  while (h.length > 1 && h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/** Which blocked class `host` falls in (a literal address in any spelling, or "localhost"), or null. */
function blockedKind(host: string): Kind | null {
  const h = normalizeHost(host);
  if (!h) return null; // empty handled by the caller's own required-field check
  if (h === "localhost" || h.endsWith(".localhost")) return "loopback";
  if (h.includes(":")) {
    const g = expandV6(h);
    return g ? kindOfV6(g) : null;
  }
  if (endsInNumber(h)) {
    const v = parseIpv4Any(h);
    // A host whose last label is numeric but is not an IPv4 address is not a
    // name the URL parser or the resolver would take — refuse rather than guess.
    return v === null ? "other" : kindOfV4(v);
  }
  return null; // a real hostname — judged when it is connected to
}

/**
 * Returns true when `host` is a literal address (in any spelling) or "localhost"
 * in a range that only makes sense as an SSRF target. RFC1918/ULA private LAN
 * ranges and public addresses return false (allowed). A real hostname returns
 * false here — `guardedLookup` / `resolveAllowedHost` judge it when it resolves.
 */
export function isBlockedOutboundHost(host: string): boolean {
  return blockedKind(host) !== null;
}

function blockedError(host: string): Error {
  return Object.assign(
    new Error(
      `Host "${String(host ?? "").trim()}" is in a blocked range (loopback / link-local / ` +
      `metadata / multicast) and cannot be used as an integration target. ` +
      `Use the device's routable LAN address.`
    ),
    { code: "BLOCKED_HOST" },
  );
}

/**
 * Throws `{ code: "BLOCKED_HOST" }` when the host is in a blocked range, with a
 * message naming the category. Callers convert this into a 400 (the route layer
 * already maps thrown validation errors). No-op for allowed hosts and for empty
 * input (the schema's own required check owns emptiness).
 */
export function assertOutboundHostAllowed(host: string): void {
  if (isBlockedOutboundHost(host)) throw blockedError(host);
}

/**
 * True for the loopback subset of the blocklist only: "localhost" (and
 * *.localhost), 127.0.0.0/8, ::1 and the IPv6 spellings of 127.x. Link-local,
 * metadata, unspecified and multicast are NOT loopback and stay blocked.
 */
export function isLoopbackHost(host: string): boolean {
  return blockedKind(host) === "loopback";
}

/**
 * The `llm` integration's variant of the guard. A local model server very
 * often listens on the Polaris host itself (Ollama's default is
 * localhost:11434), so an operator may tick "Allow loopback" — which lifts the
 * block for loopback ONLY. Everything else in the blocklist (link-local and
 * the cloud metadata address, unspecified, multicast) is refused regardless.
 * Business rule 95(g).
 */
export function isBlockedLlmHost(host: string, allowLoopback: boolean): boolean {
  const k = blockedKind(host);
  if (k === null) return false;
  return !(allowLoopback && k === "loopback");
}

export interface GuardOptions {
  /** Lift the block for loopback only (the LLM integration's "Allow loopback"). */
  allowLoopback?: boolean;
}

function addressBlocked(address: string, opts: GuardOptions): boolean {
  const k = blockedKind(address);
  return k !== null && !(opts.allowLoopback && k === "loopback");
}

/**
 * A `lookup` for `net.connect` / `http(s).request` / undici's `connect` option.
 * Resolves every record for the name and refuses the connection with
 * BLOCKED_HOST when ANY of them is in a blocked range, so a name cannot be
 * pointed at loopback or the metadata address — and because the address that
 * passed the check is the one connected to, it cannot be re-pointed between
 * check and connect (DNS rebinding). Node does not call `lookup` for an IP
 * literal; those are judged by `assertOutboundHostAllowed` up front.
 */
export function guardedLookup(opts: GuardOptions = {}): net.LookupFunction {
  return ((hostname: string, options: any, cb?: any) => {
    if (typeof options === "function") {
      cb = options;
      options = {};
    }
    resolver.all(hostname, options ?? {}, (err, list) => {
      if (err) return cb(err);
      if (list.some((a) => addressBlocked(a.address, opts))) return cb(blockedError(hostname));
      if (options?.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  }) as net.LookupFunction;
}

/**
 * For a client that cannot be handed a `lookup` (the global `fetch`, a library
 * that opens its own socket): resolve the host now, refuse if any record is
 * blocked, and return the address that was checked. Returns the host itself for
 * a literal that passed, and `null` when the name does not resolve — the caller's
 * own request then fails with its own error. This is a check, not a pin, unless
 * the caller connects to the returned address.
 */
export async function resolveAllowedHost(host: string, opts: GuardOptions = {}): Promise<string | null> {
  const h = normalizeHost(host);
  if (!h) return null;
  if (addressBlocked(h, opts)) throw blockedError(host);
  if (net.isIP(h) || endsInNumber(h)) return h;
  let addrs: dns.LookupAddress[];
  try {
    addrs = await resolver.allAsync(h);
  } catch {
    return null;
  }
  if (addrs.some((a) => addressBlocked(a.address, opts))) throw blockedError(host);
  return addrs[0]?.address ?? null;
}
