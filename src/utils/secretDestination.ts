/**
 * src/utils/secretDestination.ts — a stored secret follows its destination.
 *
 * Every edit form that holds a write-only secret (an API token, a bind password,
 * an SMTP password) lets the operator leave it blank, or echo back the masked
 * placeholder, to mean "keep the stored one". That is a convenience on the SAME
 * server. If the same request also changes WHERE the secret is sent — a new
 * host, port, token URL or transport — then "keep the stored one" hands a secret
 * the caller can never read to an address the caller chose (scan findings F164,
 * F208, F209, F211, F212, F191; business rule 111).
 *
 * So a blank or masked secret is restored from the stored row only while the
 * destination is unchanged. When it has moved, the caller must type the secret
 * again: whoever points the integration at a new place must already hold it.
 *
 * Pure apart from the AppError it throws.
 */

import { trimTrailing } from "./trimTrailing.js";
import { AppError } from "./errors.js";
import { isMaskedSecret } from "./secretMask.js";

/**
 * Config keys that decide where a secret is sent or how it is protected on the
 * way. Compared only when the stored row has a value for the key.
 */
export const DESTINATION_KEYS = [
  "host",
  "port",
  "protocol",
  "useHttps",
  "useTls",
  "useSsl",
  "ssl",
  "tls",
  "useLdaps",
  "ldaps",
  "security",
  "tokenUrl",
  "baseUrl",
  "basePath",
  "url",
  "endpoint",
  "fallbackHosts",
  "verifySsl",
  "verifyTls",
  // FortiManager's direct-to-FortiGate leg (business rule 111(a), re-scan
  // F74/F80): whether fortigateApiToken is sent to the gates directly at all,
  // to which of each gate's addresses, and whether that TLS is verified.
  "fortigateVerifySsl",
  "useProxy",
  "mgmtInterface",
] as const;

/**
 * List-valued destination keys (Proxmox's extra node addresses). A row stored
 * before the key existed has no list, which means "no extra destinations" — so
 * a list added later still counts as a move rather than as a key never stored.
 */
const LIST_KEYS: ReadonlySet<string> = new Set(["fallbackHosts"]);

function normOne(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return trimTrailing(trimTrailing(v.trim().toLowerCase(), "."), "/");
  return String(v);
}

function norm(v: unknown): string {
  // Order is not a destination: only adding or removing an entry moves one.
  if (Array.isArray(v)) return v.map(normOne).filter(Boolean).sort().join(",");
  return normOne(v);
}

/** The first destination key whose submitted value differs from the stored one, or null. */
export function movedDestinationKey(
  stored: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown> | null | undefined,
): string | null {
  const s = stored ?? {};
  const i = incoming ?? {};
  for (const k of DESTINATION_KEYS) {
    const sv = s[k] === undefined && LIST_KEYS.has(k) ? [] : s[k];
    if (sv === undefined || i[k] === undefined) continue;
    if (norm(sv) !== norm(i[k])) return k;
  }
  return null;
}

/** True when a submitted secret value means "keep the stored one". */
export function isBlankSecret(v: unknown): boolean {
  return v === undefined || v === null || typeof v !== "string" || v.trim() === "" || isMaskedSecret(v);
}

/**
 * Fill each blank / masked secret in `cfg` from `stored` — but only while the
 * destination is unchanged. A blank secret with a moved destination throws a 400
 * naming the field that moved and the secret to re-enter. Keys with nothing
 * stored are left as submitted.
 *
 * `cfg` is the submitted config (mutated); `incoming` is what the caller sent
 * (usually `cfg` itself; for an update it is the request body before the merge
 * with the stored row, so an omitted destination key counts as unchanged).
 */
export function restoreStoredSecrets(
  cfg: Record<string, unknown>,
  stored: Record<string, unknown> | null | undefined,
  secretKeys: readonly string[],
  incoming: Record<string, unknown> = cfg,
): void {
  const s = stored ?? {};
  const needed = secretKeys.filter((k) => isBlankSecret(incoming[k]) && s[k]);
  if (needed.length === 0) return;
  const moved = movedDestinationKey(s, incoming);
  if (moved) {
    throw new AppError(
      400,
      `"${moved}" was changed, so the stored ${needed.join(" / ")} is not reused: a saved secret is never sent to a new destination. Enter the ${needed.join(" / ")} again to save this change.`,
    );
  }
  for (const k of needed) cfg[k] = s[k];
}
