/**
 * src/services/serverSettingsService.ts — NTP and certificate management
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { querySntp, checkNtsKe } from "../utils/sntp.js";

// ─── NTP Settings ───────────────────────────────────────────────────────────

export interface NtpSettings {
  enabled: boolean;
  mode: "ntp" | "sntp" | "nts";
  servers: string[];
  timezoneOverride: string | null;
}

const NTP_KEY = "ntp";

const DEFAULT_NTP: NtpSettings = {
  enabled: false,
  mode: "ntp",
  servers: [],
  timezoneOverride: null,
};

export async function getNtpSettings(): Promise<NtpSettings> {
  const row = await prisma.setting.findUnique({ where: { key: NTP_KEY } });
  if (!row) return { ...DEFAULT_NTP };
  return { ...DEFAULT_NTP, ...(row.value as Record<string, unknown>) } as NtpSettings;
}

export async function updateNtpSettings(
  settings: Partial<NtpSettings>,
): Promise<NtpSettings> {
  const current = await getNtpSettings();
  const merged: NtpSettings = { ...current, ...settings };

  await prisma.setting.upsert({
    where: { key: NTP_KEY },
    create: { key: NTP_KEY, value: merged as any },
    update: { value: merged as any },
  });

  return merged;
}

export interface NtpServerTestResult {
  server: string;
  ok: boolean;
  message: string;
}

/** Above this the server answered, but this host's clock disagrees with it enough to say so. */
const NTP_OFFSET_WARN_MS = 1000;

function formatOffset(ms: number): string {
  const s = ms / 1000;
  return `${s >= 0 ? "+" : "−"}${Math.abs(s).toFixed(3)} s`;
}

async function testOneNtpServer(server: string, mode: string, deps: NtpTestDeps): Promise<NtpServerTestResult> {
  try {
    let nts = "";
    let timeHost = server;
    let timePort = 123;
    if (mode === "nts") {
      const ke = await deps.checkNtsKe(server);
      nts = `NTS key exchange OK (${ke.cookies} cookie${ke.cookies === 1 ? "" : "s"}); `;
      if (ke.server) timeHost = ke.server;
      if (ke.port) timePort = ke.port;
    }
    const r = await deps.querySntp(timeHost, { port: timePort });
    const skew = Math.abs(r.offsetMs) > NTP_OFFSET_WARN_MS
      ? ` — the Polaris server's clock is ${Math.abs(r.offsetMs / 1000).toFixed(1)} s ${r.offsetMs > 0 ? "behind" : "ahead of"} it`
      : "";
    const sample = mode === "nts" ? " (time sample not NTS-authenticated by this test)" : "";
    return {
      server,
      ok: true,
      message: `${server}: ${nts}stratum ${r.stratum}, offset ${formatOffset(r.offsetMs)}, delay ${Math.round(r.delayMs)} ms${sample}${skew}`,
    };
  } catch (err: any) {
    return { server, ok: false, message: `${server}: ${err?.message || "query failed"}` };
  }
}

export interface NtpTestDeps {
  querySntp: typeof querySntp;
  checkNtsKe: typeof checkNtsKe;
}

/**
 * Query every listed server once, in parallel, and report each: stratum,
 * offset of THIS server's clock against it, round-trip delay; NTS runs the
 * key exchange first. `ok` only when every server answered. NTP and SNTP are
 * the same query here — a test is one sample, and both modes speak NTPv4.
 *
 * No outbound-host guard (netGuard): the payload is a fixed 48-byte NTP
 * request to port 123 (or an NTS-KE request to 4460) and nothing of the reply
 * is echoed except the time; the cloud time services operators point at live
 * on link-local (169.254.169.123) and a host's own chronyd on loopback, both
 * of which the guard refuses. Gated serverSettingsSystem:write at the route.
 */
export async function testNtpSync(
  settings: { mode: string; servers: string[] },
  deps: NtpTestDeps = { querySntp, checkNtsKe },
): Promise<{ ok: boolean; message: string; results: NtpServerTestResult[] }> {
  const servers = [...new Set((settings.servers ?? []).map((s) => s.trim()).filter(Boolean))];
  if (servers.length === 0) {
    return { ok: false, message: "No NTP servers configured", results: [] };
  }
  const results = await Promise.all(servers.map((s) => testOneNtpServer(s, settings.mode, deps)));
  return { ok: results.every((r) => r.ok), message: results.map((r) => r.message).join("; "), results };
}

// ─── Certificate Management ─────────────────────────────────────────────────

export interface CertificateRecord {
  id: string;
  category: "ca" | "server";
  type: "cert" | "key";
  name: string;
  subject: string | null;
  issuer: string | null;
  expiresAt: string | null;
  uploadedAt: string;
  pem: string;
}

const CERTS_KEY = "certificates";

export async function listCertificates(): Promise<{
  trustedCAs: CertificateRecord[];
  serverCerts: CertificateRecord[];
}> {
  const row = await prisma.setting.findUnique({ where: { key: CERTS_KEY } });
  const certs: CertificateRecord[] = row
    ? (row.value as any as CertificateRecord[])
    : [];

  return {
    trustedCAs: certs.filter((c) => c.category === "ca"),
    serverCerts: certs.filter((c) => c.category === "server"),
  };
}

export async function addCertificate(
  category: "ca" | "server",
  filename: string,
  pemContent: string,
): Promise<CertificateRecord> {
  const row = await prisma.setting.findUnique({ where: { key: CERTS_KEY } });
  const certs: CertificateRecord[] = row
    ? (row.value as any as CertificateRecord[])
    : [];

  const isKey = filename.endsWith(".key") || pemContent.includes("PRIVATE KEY");
  const subject = extractSubject(pemContent);

  const record: CertificateRecord = {
    id: crypto.randomUUID(),
    category,
    type: isKey ? "key" : "cert",
    name: filename,
    subject,
    issuer: null,
    expiresAt: null,
    uploadedAt: new Date().toISOString(),
    pem: pemContent,
  };

  certs.push(record);
  await prisma.setting.upsert({
    where: { key: CERTS_KEY },
    create: { key: CERTS_KEY, value: certs as any },
    update: { value: certs as any },
  });

  logger.info({ id: record.id, name: filename, category }, "Certificate uploaded");
  return record;
}

export async function deleteCertificate(id: string): Promise<void> {
  const row = await prisma.setting.findUnique({ where: { key: CERTS_KEY } });
  if (!row) return;

  const certs: CertificateRecord[] = (row.value as any as CertificateRecord[]).filter(
    (c) => c.id !== id,
  );

  await prisma.setting.update({
    where: { key: CERTS_KEY },
    data: { value: certs as any },
  });

  logger.info({ id }, "Certificate deleted");
}

function extractSubject(pem: string): string | null {
  // Basic extraction — in production use node:crypto X509Certificate
  const match = pem.match(/subject\s*[:=]\s*(.+)/i);
  if (match) return match[1].trim();
  if (pem.includes("CERTIFICATE")) return "X.509 Certificate";
  if (pem.includes("PRIVATE KEY")) return "Private Key";
  return null;
}

