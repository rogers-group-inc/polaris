/**
 * src/services/serverSettingsService.ts — the server timezone (business rule
 * 168) and certificate management.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { isValidTimeZone } from "./userTimezoneService.js";

// ─── Server timezone (business rule 168) ───────────────────────────────────
//
// Polaris's "server-local wall clock" — the clock maintenance windows,
// quiet-time windows, scheduled reboots and firmware upgrades are written in,
// and the zone an alert email falls back to — is the PROCESS timezone of each
// role (Intl's resolved zone, read by userTimezoneService.serverTimeZone()).
// The override replaces it inside Polaris only, by setting process.env.TZ in
// every role; the host's own clock and time service are never touched.

const TIMEZONE_KEY = "timezone";

/**
 * The zone the process started in — the host's zone, or an operator's TZ
 * in .env / the unit / the container. Captured at module load, before any
 * override can be applied: Node does not fall back to it when TZ is deleted
 * (the zone stays whatever was last assigned), so clearing the override
 * must assign it back explicitly.
 */
const HOST_TIME_ZONE: string = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

export interface ServerTimezone {
  /** The operator's override, or null for "use the host's zone". */
  override: string | null;
  /** The zone this process is running in now. */
  effective: string;
  /** The zone the process started in (the host's, unless TZ was set in its environment). */
  host: string;
}

function parseOverride(raw: unknown): string | null {
  const v = (raw as { override?: unknown } | null | undefined)?.override;
  if (typeof v !== "string") return null;
  const t = v.trim();
  // A stored zone this build cannot format in (a small-ICU image, a zone
  // later removed from tzdata) degrades to the host's zone rather than
  // to Node's silent "Etc/Unknown" = UTC.
  return t && isValidTimeZone(t) ? t : null;
}

function currentZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Point this process's clock at `override`, or back at the host's zone. Returns the zone now in force. */
export function applyProcessTimezone(override: string | null): string {
  const zone = override && isValidTimeZone(override) ? override : HOST_TIME_ZONE;
  if (process.env.TZ !== zone) process.env.TZ = zone;
  return currentZone();
}

async function readOverride(): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: TIMEZONE_KEY } });
  return parseOverride(row?.value);
}

export async function getServerTimezone(): Promise<ServerTimezone> {
  const override = await readOverride();
  return { override, effective: currentZone(), host: HOST_TIME_ZONE };
}

/**
 * Save the override (null clears it), apply it to THIS process at once, and
 * audit the change. The other roles pick it up on their next refresh tick
 * (refreshProcessTimezone, every TIMEZONE_REFRESH_MS).
 */
export async function setServerTimezone(override: string | null, actor?: string): Promise<ServerTimezone> {
  const next = override?.trim() || null;
  if (next !== null && !isValidTimeZone(next)) {
    throw new AppError(400, `"${next}" is not a timezone this server can use`);
  }
  const before = await readOverride();
  await prisma.setting.upsert({
    where:  { key: TIMEZONE_KEY },
    create: { key: TIMEZONE_KEY, value: { override: next } },
    update: { value: { override: next } },
  });
  const effective = applyProcessTimezone(next);
  if (before !== next) {
    await logEvent({
      action: "server.timezone.changed",
      resourceType: "setting",
      resourceId: TIMEZONE_KEY,
      resourceName: "Server timezone",
      actor,
      message: next
        ? `Server timezone set to ${next} (was ${before ?? `the host's ${HOST_TIME_ZONE}`})`
        : `Server timezone override cleared — back to the host's ${HOST_TIME_ZONE} (was ${before})`,
      details: { before, after: next, effective },
    });
  }
  return { override: next, effective, host: HOST_TIME_ZONE };
}

/** How often every role re-reads the override, so a change made on the web role reaches monitor / discovery / dash. */
export const TIMEZONE_REFRESH_MS = 30_000;

/** Read the stored override and apply it to this process. Never throws: a settings outage keeps the zone in force. */
export async function refreshProcessTimezone(): Promise<void> {
  try {
    applyProcessTimezone(await readOverride());
  } catch (err: any) {
    logger.warn({ err: err?.message }, "server timezone refresh failed; keeping the zone in force");
  }
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

