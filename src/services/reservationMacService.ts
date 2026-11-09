/**
 * src/services/reservationMacService.ts
 *
 * The install-wide placeholder-MAC prefix — the OUI every MAC Polaris generates
 * for a not-yet-racked device's DHCP reservation begins with.
 *
 * Why a setting rather than a constant: the prefix is the ONLY thing marking a
 * reservation's MAC as synthetic (there is no boolean column on Reservation),
 * and it is visible on the FortiGate's own reserved-address table. Sites that
 * already use a locally-administered range for something else need to be able
 * to move Polaris out of the way, and installs that predate this feature need
 * to be able to set it back to "02" to have their existing generated MACs
 * recognized. See the placeholder section of src/utils/mac.ts and
 * placeholderMacAdoptionService.ts.
 *
 * Single Setting row, JSON blob, TTL-cached via createSettingStore — the same
 * shape as assetSourcePriorityService. Read once per discovery run and once per
 * IP-panel open, never on a hot path, so the TTL only bounds how long a
 * just-saved prefix can look unchanged to another role's next run.
 */

import { createSettingStore } from "./settingsStore.js";
import { logEvent } from "./eventLogService.js";
import { AppError } from "../utils/errors.js";
import {
  DEFAULT_PLACEHOLDER_MAC_PREFIX,
  normalizePlaceholderPrefix,
} from "../utils/mac.js";

const RESERVATION_MAC_PLACEHOLDER_KEY = "reservationMacPlaceholder";

export interface ReservationMacPlaceholderSettings {
  prefix: string;
}

/**
 * Self-healing read: a stored value that no longer normalizes (hand-edited row,
 * a prefix rule tightened by a later release) falls back to the default rather
 * than propagating an unusable prefix into MAC generation and — far worse — into
 * the adoption predicate, where an unparseable prefix would make
 * `isPlaceholderMac` answer false for everything and quietly disable adoption.
 */
function normalizeReservationMacSettings(raw: unknown): ReservationMacPlaceholderSettings {
  const obj = (raw ?? {}) as Record<string, unknown>;
  return { prefix: normalizePlaceholderPrefix(obj.prefix) ?? DEFAULT_PLACEHOLDER_MAC_PREFIX };
}

const store = createSettingStore<ReservationMacPlaceholderSettings>({
  key: RESERVATION_MAC_PLACEHOLDER_KEY,
  ttlMs: 30_000,
  parse: normalizeReservationMacSettings,
});

export async function getReservationMacSettings(): Promise<ReservationMacPlaceholderSettings> {
  return store.get();
}

/** Convenience for the two callers that only want the string. */
export async function getPlaceholderPrefix(): Promise<string> {
  return (await store.get()).prefix;
}

/**
 * Persist a new prefix. Unlike the read path, an unusable value is REJECTED
 * here rather than silently defaulted — an operator typing a vendor OUI needs
 * to hear why it can't be used, not watch it revert without explanation.
 */
export async function saveReservationMacSettings(
  input: { prefix?: unknown },
  actor?: string,
): Promise<ReservationMacPlaceholderSettings> {
  const current = await getReservationMacSettings();
  if (input.prefix === undefined) return current;

  const prefix = normalizePlaceholderPrefix(input.prefix);
  if (!prefix) {
    throw new AppError(
      400,
      "Placeholder MAC prefix must be 1–5 hex octets whose first octet is locally administered and unicast " +
        "(e.g. 02, 06, 0A, 0E…). A globally administered prefix is rejected because it could match a real " +
        "device's factory MAC, which discovery would then be free to overwrite.",
    );
  }

  if (prefix === current.prefix) return current;

  const saved = await store.save({ prefix });

  await logEvent({
    level: "info",
    action: "reservation.mac_placeholder.updated",
    resourceType: "setting",
    resourceName: RESERVATION_MAC_PLACEHOLDER_KEY,
    message: `Placeholder MAC prefix changed from ${current.prefix} to ${saved.prefix}`,
    actor: actor || "system",
    details: { previousPrefix: current.prefix, prefix: saved.prefix },
  });

  return saved;
}
