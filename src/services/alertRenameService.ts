/**
 * src/services/alertRenameService.ts — an open alert follows its device's rename
 * (business rule 134)
 *
 * A Notification snapshots its device's name at fire time — in
 * `assetHostname`, in the rendered `message` ("SIEBOLDT-61F-1 is down") and in
 * `templateCtx` (the token map reminders and escalations render from). The
 * snapshot is deliberate: a cleared alert is history and must keep naming the
 * device as it was, and an alert outlives a deleted device. But an OPEN alert
 * is a live statement about a device, and a gate renamed in FortiManager while
 * it is down kept paging under the name it no longer has, beside a device page
 * showing the new one.
 *
 * So when an Asset's hostname changes (src/db.ts detects it on every
 * update/upsert that stages `hostname`), the device's UNCLEARED alerts whose
 * subject is still the old name are rewritten to the new one. Cleared alerts
 * are left alone. So are alerts whose subject is something else — a subnet or
 * automation fold names the subnet or the automation (business rule 75), not
 * the leading device, and an exact match on the old name is what tells them
 * apart.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";

// A hostname is letters, digits, '-', '_' and '.'. The old name only counts as
// a whole word: "GATE-1" inside "GATE-10" or "SITE-GATE-1" is a different
// device. A trailing '.' is a sentence ending, not part of the name, unless a
// name character follows it ("GATE-1.corp").
function wholeNamePattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])`, "g");
}

/** `text` with every whole-word occurrence of `oldName` replaced by `newName`. */
export function replaceDeviceName(text: string, oldName: string, newName: string): string {
  if (!oldName || oldName === newName || !text.includes(oldName)) return text;
  return text.replace(wholeNamePattern(oldName), () => newName);
}

/** A `templateCtx` snapshot with the name replaced in every string value; null when nothing changed. */
export function renameInTemplateCtx(ctx: unknown, oldName: string, newName: string): Record<string, unknown> | null {
  if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) return null;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx as Record<string, unknown>)) {
    if (typeof v === "string") {
      const next = replaceDeviceName(v, oldName, newName);
      if (next !== v) changed = true;
      out[k] = next;
    } else {
      out[k] = v;
    }
  }
  return changed ? out : null;
}

/**
 * Rewrite the device's open alerts from `oldName` to `newName`. Returns how
 * many were rewritten. One indexed read (Notification.assetId); a rename is
 * rare, so at any fleet size this is a handful of rows when it runs at all.
 */
export async function followAssetRename(assetId: string, oldName: string, newName: string): Promise<number> {
  if (!assetId || !oldName || !newName || oldName === newName) return 0;
  const rows = await prisma.notification.findMany({
    where: { assetId, cleared: false, assetHostname: oldName },
    select: { id: true, message: true, templateCtx: true },
  });
  if (rows.length === 0) return 0;
  await prisma.$transaction(rows.map((n) => {
    const ctx = renameInTemplateCtx(n.templateCtx, oldName, newName);
    return prisma.notification.updateMany({
      // Still open and still under the old name — an alert cleared or renamed
      // by an overlapping pass since the read is left as that pass left it.
      where: { id: n.id, cleared: false, assetHostname: oldName },
      data: {
        assetHostname: newName,
        message: replaceDeviceName(n.message, oldName, newName),
        ...(ctx ? { templateCtx: ctx as any } : {}),
      },
    });
  }));
  logger.info({ assetId, oldName, newName, alerts: rows.length }, "Open alerts renamed with their device");
  return rows.length;
}
