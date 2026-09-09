/**
 * src/jobs/backfillSecretEncryption.ts
 *
 * Seals secrets that are already stored as plaintext in Credential.config,
 * Integration.config, NotificationChannel.config and Setting.value.
 *
 * The Prisma extension in src/db.ts seals every NEW write, but an existing
 * install has years of plaintext credentials sitting in those columns — which is
 * the whole exposure (any pg_dump contains them). This job converts them in
 * place.
 *
 * Deliberately NOT marker-guarded, unlike the other one-shot startup jobs:
 *
 *   - POLARIS_SECRET_KEY may be set LATER than the upgrade that ships this code.
 *     An install that updates first and configures the key afterwards must get
 *     its backfill on the next boot, not never.
 *   - It is naturally idempotent. Reading a row through the extension yields
 *     plaintext, writing it back re-seals it, and sealValue is a no-op on
 *     already-sealed input. A row that is already sealed produces a write with
 *     identical content.
 *
 * To keep the steady state cheap it exits immediately when no key is configured,
 * and it only writes rows whose sealed form actually differs from what is stored
 * (checked against the BASE client, which bypasses the extension and therefore
 * sees the raw stored value).
 *
 * Import this module from src/app.ts to activate it:
 *   import "./jobs/backfillSecretEncryption.js";
 */

import { prisma, prismaBase } from "../db.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "../services/eventLogService.js";
import { runInstrumentedJob } from "./_metrics.js";
import { secretEncryptionEnabled, isSealed, sealValue } from "../utils/secretBox.js";
import { SECRET_CONFIG_KEYS } from "../utils/configSecretFields.js";

/**
 * Does this raw (un-opened) blob contain at least one secret-keyed string that
 * is NOT already sealed? Mirrors transformSecretFields' walk, but as a predicate
 * so we can skip rows that need no write.
 */
function hasPlaintextSecret(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (Array.isArray(value)) return value.some((v) => hasPlaintextSecret(v, depth + 1));
  if (value === null || typeof value !== "object") return false;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && SECRET_CONFIG_KEYS.has(k)) {
      if (v.length > 0 && !isSealed(v)) return true;
    } else if (hasPlaintextSecret(v, depth + 1)) {
      return true;
    }
  }
  return false;
}

/**
 * Re-save every row whose raw blob still holds plaintext.
 *
 * Reads go through the BASE client (raw stored bytes, so the predicate sees
 * reality) and writes go through the EXTENDED client (which seals). The value
 * written is the raw blob itself: sealValue leaves already-sealed strings alone,
 * so mixed rows converge without double-sealing.
 */
async function sealTable(
  label: string,
  readRows: () => Promise<Array<{ id: string; blob: unknown }>>,
  writeRow: (id: string, blob: unknown) => Promise<unknown>,
): Promise<number> {
  const rows = await readRows();
  let sealed = 0;
  for (const row of rows) {
    if (!hasPlaintextSecret(row.blob)) continue;
    try {
      await writeRow(row.id, row.blob);
      sealed++;
    } catch (err) {
      logger.error({ err, table: label, id: row.id }, "backfillSecretEncryption: could not seal a row");
    }
  }
  return sealed;
}

async function backfillSecretEncryption(): Promise<void> {
  try {
    await runInstrumentedJob("backfillSecretEncryption", async () => {
      if (!secretEncryptionEnabled()) {
        // The boot warning in secretBox already tells the operator secrets are
        // plaintext; no need for a second line every boot.
        return;
      }

      const credentials = await sealTable(
        "credentials",
        async () => (await prismaBase.credential.findMany({ select: { id: true, config: true } }))
          .map((r) => ({ id: r.id, blob: r.config })),
        (id, blob) => prisma.credential.update({ where: { id }, data: { config: blob as never } }),
      );

      const integrations = await sealTable(
        "integrations",
        async () => (await prismaBase.integration.findMany({ select: { id: true, config: true } }))
          .map((r) => ({ id: r.id, blob: r.config })),
        (id, blob) => prisma.integration.update({ where: { id }, data: { config: blob as never } }),
      );

      const channels = await sealTable(
        "notification_channels",
        async () => (await prismaBase.notificationChannel.findMany({ select: { id: true, config: true } }))
          .map((r) => ({ id: r.id, blob: r.config })),
        (id, blob) => prisma.notificationChannel.update({ where: { id }, data: { config: blob as never } }),
      );

      const settings = await sealTable(
        "settings",
        async () => (await prismaBase.setting.findMany({ select: { key: true, value: true } }))
          .map((r) => ({ id: r.key, blob: r.value })),
        (key, blob) => prisma.setting.update({ where: { key }, data: { value: blob as never } }),
      );

      // User.totpSecret is a SCALAR column, not one of the four JSON blobs, so
      // it has no seal-on-write hook in db.ts and no blob to walk — auth.ts
      // seals it explicitly on enrollment and this pass converts the rows
      // enrolled before that. A TOTP secret is a password equivalent: anyone
      // holding it can mint the second factor forever, and it was landing in
      // every pg_dump in the clear.
      const totpRows = await prismaBase.user.findMany({
        where: { totpSecret: { not: null } },
        select: { id: true, totpSecret: true },
      });
      let totpSecrets = 0;
      for (const row of totpRows) {
        if (!row.totpSecret || isSealed(row.totpSecret)) continue;
        try {
          await prisma.user.update({ where: { id: row.id }, data: { totpSecret: sealValue(row.totpSecret) } });
          totpSecrets++;
        } catch (err) {
          logger.error({ err, table: "users", id: row.id }, "backfillSecretEncryption: could not seal a row");
        }
      }

      const total = credentials + integrations + channels + settings + totpSecrets;
      if (total === 0) return;

      logger.info(
        { credentials, integrations, channels, settings, totpSecrets },
        "backfillSecretEncryption: encrypted previously-plaintext secrets at rest",
      );
      await logEvent({
        level: "info",
        action: "server.secrets.encrypted_at_rest",
        resourceType: "setting",
        actor: "system:backfill-secret-encryption",
        message: `Encrypted ${total} previously-plaintext secret-bearing row(s) at rest (credentials: ${credentials}, integrations: ${integrations}, delivery channels: ${channels}, settings: ${settings}, TOTP secrets: ${totpSecrets})`,
        details: { credentials, integrations, channels, settings, totpSecrets },
      });
    });
  } catch (err) {
    logger.error(err, "backfillSecretEncryption failed");
  }
}

void backfillSecretEncryption();
