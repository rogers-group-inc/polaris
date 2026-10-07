/**
 * src/services/dnsService.ts — DNS resolver configuration
 *
 * Supports three modes:
 *   - standard: plain DNS (UDP/TCP) via Node's built-in dns.Resolver
 *   - dot:      DNS over TLS (RFC 7858) on port 853
 *   - doh:      DNS over HTTPS (RFC 8484) using the JSON API
 *
 * Uses an isolated resolver so custom servers don't affect the rest of
 * the process's DNS resolution.
 *
 * All resolvers return PtrRecord[] so callers can cache results with TTL.
 * Standard mode cannot retrieve TTL from Node's built-in API and returns
 * ttl: null — callers should apply a sensible default (e.g. 3600s).
 */

import dns from "node:dns/promises";
import https from "node:https";
import tls from "node:tls";
import { prisma } from "../db.js";
import { ipToPtrName, isValidIpAddress } from "../utils/cidr.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface DnsSettings {
  servers: string[];
  mode: "standard" | "dot" | "doh";
  dohUrl: string;
  /**
   * Verify the resolver's TLS certificate on DoH/DoT connections. Defaults to
   * false for stored settings that predate this flag, so existing installs keep
   * their prior behavior; the Server Settings UI defaults a NEW save to true.
   * See the 2026-06-03 security review (M3).
   */
  verifyTls: boolean;
}

/** A single PTR answer. ttl is null when the resolver cannot retrieve it (standard mode). */
export interface PtrRecord {
  name: string;
  ttl: number | null;
}

/** A single A/AAAA answer from a forward lookup. */
export interface ARecord {
  address: string;
  family: 4 | 6;
}

export interface ResolverLike {
  reverse(ip: string): Promise<PtrRecord[]>;
  lookup(hostname: string): Promise<ARecord[]>;
}

// ─── Test target ───────────────────────────────────────────────────────────

export type DnsTestTarget = { kind: "reverse"; ip: string } | { kind: "forward"; name: string };

/**
 * What the Test DNS Lookup card was given: an IP (PTR lookup) or a hostname —
 * bare, host:port, or a full URL as copied from an integration — for an A/AAAA
 * lookup. Null when nothing usable is left after stripping the URL parts.
 */
export function parseDnsTestTarget(input: string): DnsTestTarget | null {
  let v = (input ?? "").trim();
  if (!v) return null;
  if (isValidIpAddress(v)) return { kind: "reverse", ip: v };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    try { v = new URL(v).hostname; } catch { return null; }
  } else {
    v = v.split(/[/?#]/)[0];
    const m = v.match(/^([^:]+):\d+$/);
    if (m) v = m[1];
  }
  v = v.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "").toLowerCase();
  if (!v) return null;
  if (isValidIpAddress(v)) return { kind: "reverse", ip: v };
  if (!/^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/.test(v)) return null;
  return { kind: "forward", name: v };
}

// ─── Settings CRUD ─────────────────────────────────────────────────────────

export async function getDnsSettings(): Promise<DnsSettings> {
  const row = await prisma.setting.findUnique({ where: { key: "dnsSettings" } });
  if (!row?.value) return { servers: [], mode: "standard", dohUrl: "", verifyTls: false };
  const val = row.value as any;
  return {
    servers: val.servers || [],
    mode: val.mode || "standard",
    dohUrl: val.dohUrl || "",
    // Migrate-safe: a stored setting with no verifyTls flag keeps the prior
    // no-verify behavior (=== true). The UI defaults a new save to true.
    verifyTls: val.verifyTls === true,
  };
}

export async function updateDnsSettings(settings: Partial<DnsSettings>): Promise<DnsSettings> {
  const current = await getDnsSettings();
  const value: DnsSettings = {
    servers: (settings.servers ?? current.servers).filter(Boolean),
    mode: settings.mode ?? current.mode,
    dohUrl: settings.dohUrl ?? current.dohUrl,
    verifyTls: settings.verifyTls ?? current.verifyTls,
  };
  await prisma.setting.upsert({
    where: { key: "dnsSettings" },
    update: { value: value as any },
    create: { key: "dnsSettings", value: value as any },
  });
  return value;
}

// ─── Resolver Factory ──────────────────────────────────────────────────────

/**
 * Resolve any hostnames in a server list to IP addresses so they can be
 * passed to dns.Resolver.setServers() (which only accepts IPs).
 * Entries that are already IPs pass through unchanged.
 */
async function resolveServerNames(servers: string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const s of servers) {
    // Strip optional :port suffix for the hostname check
    const portMatch = s.match(/^(.+):(\d+)$/);
    const host = portMatch ? portMatch[1] : s;
    const port = portMatch ? portMatch[2] : null;

    // If it looks like an IP (v4 or v6) pass through as-is
    if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) {
      resolved.push(s);
      continue;
    }

    // It's a hostname — resolve to IP via system DNS
    try {
      const { address } = await dns.lookup(host);
      resolved.push(port ? `${address}:${port}` : address);
    } catch {
      // If resolution fails, skip this entry rather than breaking all lookups
    }
  }
  return resolved;
}

/**
 * Build a resolver from explicit settings (used by the test endpoint).
 */
export async function createResolver(settings: DnsSettings): Promise<ResolverLike> {
  const verifyTls = settings.verifyTls === true;
  if (settings.mode === "doh" && settings.dohUrl) {
    return {
      reverse: (ip: string) => dohReverse(ip, settings.dohUrl, verifyTls),
      lookup: (hostname: string) => dohLookup(hostname, settings.dohUrl, verifyTls),
    };
  }
  if (settings.mode === "dot" && settings.servers.length > 0) {
    return {
      reverse: (ip: string) => dotReverse(ip, settings.servers, verifyTls),
      lookup: (hostname: string) => dotLookup(hostname, settings.servers, verifyTls),
    };
  }
  // Standard mode — setServers() requires IPs, so resolve any hostnames first.
  // Node's dns.Resolver.reverse() does not expose TTL, so we wrap it and return ttl: null.
  // tries: 1 — c-ares defaults to 4 attempts per name, which turns one unresponsive
  // upstream into ~20s of per-host wall-clock on the AD forward-DNS pre-pass.
  const resolver = new dns.Resolver({ timeout: 5000, tries: 1 });
  if (settings.servers.length > 0) {
    const ips = await resolveServerNames(settings.servers);
    if (ips.length > 0) resolver.setServers(ips);
  }
  return {
    reverse: async (ip: string): Promise<PtrRecord[]> => {
      const names = await resolver.reverse(ip);
      return names.map((name) => ({ name, ttl: null }));
    },
    lookup: async (hostname: string): Promise<ARecord[]> => {
      try {
        const addrs = await resolver.resolve4(hostname);
        return addrs.map((a) => ({ address: a, family: 4 as const }));
      } catch {
        const addrs = await resolver.resolve6(hostname);
        return addrs.map((a) => ({ address: a, family: 6 as const }));
      }
    },
  };
}

/**
 * Build a resolver from the saved database settings.
 */
export async function getConfiguredResolver(): Promise<ResolverLike> {
  return createResolver(await getDnsSettings());
}

// IP → PTR name (in-addr.arpa / ip6.arpa) lives in utils/cidr.ts (ipToPtrName).

// ─── DNS over HTTPS (DoH) ──────────────────────────────────────────────────
//
// Uses the JSON API supported by Google, Cloudflare, Quad9, and others.
// The user supplies a base URL (e.g. https://dns.google/resolve) and we
// append ?name=<ptr>&type=PTR with Accept: application/dns-json.
// ────────────────────────────────────────────────────────────────────────────

async function dohFetchJson(url: string, verifyTls: boolean): Promise<any> {
  const body = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(Object.assign(new Error("DoH request timed out (5s)"), { code: "DOH_TIMEOUT" }));
    }, 5000);

    // Verify only when the operator opted in (2026-06-03 review, M3). Public
    // resolvers (Cloudflare/Google/Quad9 — the documented default) all present
    // valid certs, so verification is free there; the opt-out exists for an
    // internal resolver behind a private CA.
    const req = https.get(url, { headers: { Accept: "application/dns-json" }, rejectUnauthorized: verifyTls === true }, (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        clearTimeout(timer);
        res.resume();
        reject(Object.assign(new Error(`DoH query failed (HTTP ${res.statusCode})`), { code: "DOH_HTTP_ERROR" }));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf-8")); });
    });

    req.on("error", (err: any) => {
      clearTimeout(timer);
      const detail = err.code === "ENOTFOUND" ? "Cannot resolve hostname in DoH URL"
        : err.code === "ECONNREFUSED" ? "Connection refused by DoH server"
        : err.message || String(err);
      reject(Object.assign(new Error(detail), { code: "DOH_CONNECT_ERROR" }));
    });
  });

  try {
    return JSON.parse(body);
  } catch {
    throw Object.assign(new Error("DoH server did not return JSON — check the URL uses the JSON API endpoint"), { code: "DOH_PARSE_ERROR" });
  }
}

async function dohReverse(ip: string, dohUrl: string, verifyTls: boolean): Promise<PtrRecord[]> {
  const ptrName = ipToPtrName(ip);
  const sep = dohUrl.includes("?") ? "&" : "?";
  const url = `${dohUrl}${sep}ct=application/dns-json&name=${encodeURIComponent(ptrName)}&type=PTR`;
  const data = await dohFetchJson(url, verifyTls);
  if (!data.Answer || !Array.isArray(data.Answer)) return [];
  return data.Answer
    .filter((a: any) => a.type === 12)
    .map((a: any) => ({
      name: (a.data || "").replace(/\.$/, ""),
      ttl: typeof a.TTL === "number" ? a.TTL : null,
    }));
}

async function dohLookup(hostname: string, dohUrl: string, verifyTls: boolean): Promise<ARecord[]> {
  const sep = dohUrl.includes("?") ? "&" : "?";
  const results: ARecord[] = [];
  for (const [type, typeNum, family] of [["A", 1, 4], ["AAAA", 28, 6]] as [string, number, 4 | 6][]) {
    try {
      const url = `${dohUrl}${sep}ct=application/dns-json&name=${encodeURIComponent(hostname)}&type=${type}`;
      const data = await dohFetchJson(url, verifyTls);
      if (data.Answer && Array.isArray(data.Answer)) {
        for (const a of data.Answer) {
          if (a.type === typeNum && a.data) results.push({ address: a.data, family });
        }
      }
    } catch { /* skip this record type on error */ }
  }
  return results;
}

// ─── DNS over TLS (DoT) ────────────────────────────────────────────────────
//
// Connects to each configured server on port 853 (or custom port) using TLS,
// sends a standard DNS query in TCP wire format, and parses the response.
// Falls through to the next server on failure.
// ────────────────────────────────────────────────────────────────────────────

async function dotReverse(ip: string, servers: string[], verifyTls: boolean): Promise<PtrRecord[]> {
  const ptrName = ipToPtrName(ip);
  const query = buildDnsQuery(ptrName, 12); // QTYPE 12 = PTR

  let lastErr: Error | null = null;
  for (const server of servers) {
    try {
      const { host, port } = parseDotServer(server);
      const response = await sendTlsQuery(host, port, query, verifyTls);
      return parseDnsResponse(response);
    } catch (err: any) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("No DoT servers available");
}

async function dotLookup(hostname: string, servers: string[], verifyTls: boolean): Promise<ARecord[]> {
  // Try A (type 1) first, then AAAA (type 28)
  for (const [qtype, family] of [[1, 4], [28, 6]] as [number, 4 | 6][]) {
    let lastErr: Error | null = null;
    for (const server of servers) {
      try {
        const { host, port } = parseDotServer(server);
        const query = buildDnsQuery(hostname, qtype);
        const response = await sendTlsQuery(host, port, query, verifyTls);
        const addrs = parseDnsAResponse(response, qtype, family);
        if (addrs.length > 0) return addrs;
      } catch (err: any) {
        lastErr = err;
      }
    }
    if (lastErr) continue; // try next record type
  }
  return [];
}

function parseDotServer(server: string): { host: string; port: number } {
  // Handle [ipv6]:port, ipv4:port, or bare host
  if (server.startsWith("[")) {
    const close = server.indexOf("]");
    const host = server.slice(1, close);
    const rest = server.slice(close + 1);
    const port = rest.startsWith(":") ? parseInt(rest.slice(1), 10) : 853;
    return { host, port };
  }
  const parts = server.split(":");
  if (parts.length === 2 && !server.includes("::")) {
    return { host: parts[0], port: parseInt(parts[1], 10) || 853 };
  }
  return { host: server, port: 853 };
}

// ─── DNS Wire Format ────────────────────────────────────────────────────────

function buildDnsQuery(name: string, qtype: number): Buffer {
  const id = Math.floor(Math.random() * 0xffff);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);      // ID
  header.writeUInt16BE(0x0100, 2);  // Flags: RD (recursion desired)
  header.writeUInt16BE(1, 4);       // QDCOUNT = 1

  const qname = encodeDnsName(name);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(qtype, 0);     // QTYPE
  tail.writeUInt16BE(1, 2);         // QCLASS = IN

  return Buffer.concat([header, qname, tail]);
}

function encodeDnsName(name: string): Buffer {
  const labels = name.split(".");
  const parts: Buffer[] = [];
  for (const label of labels) {
    if (label.length === 0) continue;
    parts.push(Buffer.from([label.length]));
    parts.push(Buffer.from(label, "ascii"));
  }
  parts.push(Buffer.from([0])); // root label
  return Buffer.concat(parts);
}

function sendTlsQuery(host: string, port: number, query: Buffer, verifyTls: boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const lenPrefix = Buffer.alloc(2);
    lenPrefix.writeUInt16BE(query.length, 0);

    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("DoT query timed out (5s)"));
    }, 5000);

    // Verify only when the operator opted in (2026-06-03 review, M3).
    const socket = tls.connect({ host, port, rejectUnauthorized: verifyTls === true }, () => {
      socket.write(Buffer.concat([lenPrefix, query]));
    });

    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      // TCP DNS: first 2 bytes are the message length
      if (buf.length >= 2) {
        const msgLen = buf.readUInt16BE(0);
        if (buf.length >= 2 + msgLen) {
          clearTimeout(timeout);
          socket.destroy();
          resolve(buf.subarray(2, 2 + msgLen));
        }
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    socket.on("close", () => {
      clearTimeout(timeout);
      const buf = Buffer.concat(chunks);
      if (buf.length >= 2) {
        const msgLen = buf.readUInt16BE(0);
        if (buf.length >= 2 + msgLen) {
          resolve(buf.subarray(2, 2 + msgLen));
          return;
        }
      }
      reject(new Error("DoT connection closed before complete response"));
    });
  });
}

// ─── DNS Response Parser ────────────────────────────────────────────────────

function parseDnsResponse(buf: Buffer): PtrRecord[] {
  if (buf.length < 12) return [];

  const ancount = buf.readUInt16BE(6);
  if (ancount === 0) return [];

  // Skip header (12 bytes) and question section
  let offset = 12;
  const qdcount = buf.readUInt16BE(4);
  for (let i = 0; i < qdcount; i++) {
    offset = skipDnsName(buf, offset);
    offset += 4; // QTYPE + QCLASS
  }

  // Parse answer records
  // RR layout after name: TYPE(2) CLASS(2) TTL(4) RDLENGTH(2) RDATA(rdlength)
  const results: PtrRecord[] = [];
  for (let i = 0; i < ancount; i++) {
    if (offset >= buf.length) break;
    offset = skipDnsName(buf, offset);
    if (offset + 10 > buf.length) break;
    const rtype = buf.readUInt16BE(offset);
    const ttl = buf.readUInt32BE(offset + 4);
    const rdlength = buf.readUInt16BE(offset + 8);
    offset += 10;

    if (rtype === 12) { // PTR record
      const name = readDnsName(buf, offset);
      if (name) results.push({ name, ttl });
    }
    offset += rdlength;
  }
  return results;
}

function parseDnsAResponse(buf: Buffer, qtype: number, family: 4 | 6): ARecord[] {
  if (buf.length < 12) return [];
  const ancount = buf.readUInt16BE(6);
  if (ancount === 0) return [];

  let offset = 12;
  const qdcount = buf.readUInt16BE(4);
  for (let i = 0; i < qdcount; i++) {
    offset = skipDnsName(buf, offset);
    offset += 4;
  }

  const results: ARecord[] = [];
  for (let i = 0; i < ancount; i++) {
    if (offset >= buf.length) break;
    offset = skipDnsName(buf, offset);
    if (offset + 10 > buf.length) break;
    const rtype = buf.readUInt16BE(offset);
    const rdlength = buf.readUInt16BE(offset + 8);
    offset += 10;
    if (rtype === qtype) {
      if (family === 4 && rdlength === 4) {
        const address = `${buf[offset]}.${buf[offset+1]}.${buf[offset+2]}.${buf[offset+3]}`;
        results.push({ address, family: 4 });
      } else if (family === 6 && rdlength === 16) {
        const groups: string[] = [];
        for (let g = 0; g < 8; g++) groups.push(buf.readUInt16BE(offset + g * 2).toString(16));
        results.push({ address: groups.join(":"), family: 6 });
      }
    }
    offset += rdlength;
  }
  return results;
}

function skipDnsName(buf: Buffer, offset: number): number {
  while (offset < buf.length) {
    const len = buf[offset];
    if (len === 0) return offset + 1;
    if ((len & 0xc0) === 0xc0) return offset + 2; // compression pointer
    offset += 1 + len;
  }
  return offset;
}

function readDnsName(buf: Buffer, offset: number): string {
  const labels: string[] = [];
  const seen = new Set<number>(); // prevent infinite loops
  let pos = offset;
  while (pos < buf.length) {
    if (seen.has(pos)) break;
    seen.add(pos);
    const len = buf[pos];
    if (len === 0) break;
    if ((len & 0xc0) === 0xc0) {
      // Compression pointer — follow it
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      continue;
    }
    labels.push(buf.subarray(pos + 1, pos + 1 + len).toString("ascii"));
    pos += 1 + len;
  }
  return labels.join(".");
}
