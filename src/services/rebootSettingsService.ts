/**
 * src/services/rebootSettingsService.ts — install-wide reboot settings
 * (business rule 115(d)): whether a reboot must say WHY.
 *
 * Single Setting row (`rebootConfig`), JSON blob, TTL-cached via settingsStore.
 * Off by default — an install that never opens the card keeps the note
 * optional. On, every operator reboot (now or booked) and every booking change
 * that would leave the note blank is refused with a 400 by `resolveRebootNote`,
 * in the service, so the dialog, the phone and a bearer token all meet the
 * same bar. An automation's booking always carries a note (its rule's name),
 * so the switch never fails an automation.
 *
 * Fallback on a settings read failure is "not required": a settings outage
 * must not be the reason a device cannot be rebooted.
 */

import { createSettingStore } from "./settingsStore.js";
import { logEvent } from "./eventLogService.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export const REBOOT_SETTING_KEY = "rebootConfig";

/** Longest note kept — a sentence or two, not a change ticket. */
export const REBOOT_NOTE_MAX = 500;

export interface RebootSettings {
  /** true = a reboot or a booking without a note is refused. */
  requireNote: boolean;
}

export function defaultRebootSettings(): RebootSettings {
  return { requireNote: false };
}

/** Pure — exported for tests. Anything but a literal `true` reads as off. */
export function parseRebootSettings(raw: unknown): RebootSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { requireNote: r.requireNote === true };
}

const store = createSettingStore<RebootSettings>({
  key: REBOOT_SETTING_KEY,
  ttlMs: 10_000,
  parse: parseRebootSettings,
});

export function invalidateRebootSettingsCache(): void {
  store.invalidate();
}

export async function getRebootSettings(): Promise<RebootSettings> {
  try {
    return await store.get();
  } catch (err) {
    logger.warn({ err }, "reboot settings: read failed — treating the note as optional");
    return defaultRebootSettings();
  }
}

export async function saveRebootSettings(next: RebootSettings, actor: string): Promise<RebootSettings> {
  const before = await getRebootSettings();
  const saved = await store.save(parseRebootSettings(next));
  if (before.requireNote !== saved.requireNote) {
    await logEvent({
      action: "setting.reboot_updated", resourceType: "setting", resourceName: REBOOT_SETTING_KEY, actor, level: "info",
      message: saved.requireNote ? "A reboot note is now required for every reboot" : "A reboot note is now optional",
      details: { before, after: saved },
    });
  }
  return saved;
}

/**
 * Trim and collapse a note: control characters (newlines included) become
 * spaces so it reads on one line in an Event, an email subject line and a
 * tooltip. Blank → null. Pure — exported for tests.
 */
export function normalizeRebootNote(note: unknown): string | null {
  if (note === undefined || note === null) return null;
  if (typeof note !== "string") throw new AppError(400, "note must be text");
  const flat = note.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/ {2,}/g, " ").trim();
  if (!flat) return null;
  if (flat.length > REBOOT_NOTE_MAX) throw new AppError(400, `The reboot note is ${flat.length} characters — keep it to ${REBOOT_NOTE_MAX}`);
  return flat;
}

/**
 * The note a reboot or booking is stored with: normalized, and refused when
 * the install requires one and none was given.
 */
export async function resolveRebootNote(note: unknown): Promise<string | null> {
  const flat = normalizeRebootNote(note);
  if (!flat && (await getRebootSettings()).requireNote) {
    throw new AppError(400, "Say why this device is being rebooted — this install requires a reboot note");
  }
  return flat;
}
