/**
 * src/services/reservationPushService.ts — Push manual IP reservations to a
 * FortiGate device via a FortiManager integration.
 *
 * Two transports, selected by the integration's `useProxy` flag:
 *   - `useProxy=true`  → wrap the FortiOS REST call in FMG `/sys/proxy/json`
 *                        so it lands on the running config in real time
 *                        (FortiManager forwards to the FortiGate).
 *   - `useProxy=false` → resolve the device's management IP via FMG, then
 *                        call the FortiGate REST API directly.
 *
 * Both paths verify the write by reading the entry back from the FortiGate
 * before returning success. Any failure throws AppError so the caller can
 * roll back the Polaris reservation (the user requested fail-on-failure
 * semantics so a missing/unreachable FortiGate does not produce a
 * Polaris-only ghost reservation).
 */

import { Netmask } from "netmask";
import { AppError } from "../utils/errors.js";
import { fgRequest, type FortiGateConfig } from "./fortigateService.js";
import {
  fmgProxyRest,
  resolveDeviceMgmtIpViaFmg,
  type FortiManagerConfig,
} from "./fortimanagerService.js";
import { isValidIpAddress } from "../utils/cidr.js";
import { normalizeMacLowerColon } from "../utils/mac.js";
import { isFortinetIntegrationType } from "../utils/pollingCompatibility.js";

// ─── FortiOS DHCP CMDB shapes (subset we use) ───────────────────────────────

interface FortiOsDhcpServer {
  id: number;
  interface?: string;
  "default-gateway"?: string;
  netmask?: string;
  "ip-range"?: Array<{ "start-ip"?: string; "end-ip"?: string }>;
}

interface FortiOsReservedAddress {
  id: number;
  ip?: string;
  mac?: string;
  description?: string;
  type?: string; // FortiOS: "mac" or "option82"
}

// FortiOS sometimes returns CMDB writes wrapped as { mkey } and sometimes
// just the new id at the top level — the helper below handles both.
interface FortiOsWriteResponse {
  mkey?: number | string;
  id?: number;
}

// ─── Transport ──────────────────────────────────────────────────────────────

type Transport =
  | { kind: "direct-fortigate"; fgConfig: FortiGateConfig; vdom: string }
  | { kind: "fmg-proxy"; fmgConfig: FortiManagerConfig; deviceName: string; vdom: string; integrationId: string };

/**
 * Build a transport from an Integration row. FMG integrations follow the
 * proxy/direct toggle as before; standalone FortiGate integrations always
 * use direct REST with the integration's own credentials.
 */
export async function buildTransportForIntegration(
  integration: { id: string; type: string; config: unknown },
  deviceName: string,
): Promise<Transport> {
  if (integration.type === "fortimanager") {
    return buildTransport(integration.config as FortiManagerConfig, deviceName, integration.id);
  }
  if (integration.type === "fortigate") {
    const cfg = integration.config as FortiGateConfig;
    if (!cfg?.host || !cfg?.apiToken) {
      throw new AppError(
        400,
        `Standalone FortiGate integration ${integration.id} is missing host or apiToken`,
      );
    }
    return {
      kind: "direct-fortigate",
      fgConfig: { ...cfg, vdom: cfg.vdom || "root" },
      vdom: cfg.vdom || "root",
    };
  }
  // Shared by every FortiOS write pathway (DHCP push, quarantine push,
  // description sync, lease release) — keep the message pathway-neutral.
  throw new AppError(
    400,
    `Fortinet device write is not supported for integration type "${integration.type}"`,
  );
}

async function buildTransport(
  fmgConfig: FortiManagerConfig,
  deviceName: string,
  integrationId: string,
): Promise<Transport> {
  const vdom = "root"; // FMG-managed FortiGates default to root vdom in Polaris

  if (fmgConfig.useProxy === false) {
    if (!fmgConfig.fortigateApiToken) {
      throw new AppError(
        400,
        "Direct mode requires a FortiGate API token on the integration",
      );
    }
    if (!fmgConfig.mgmtInterface?.trim()) {
      throw new AppError(
        400,
        'Direct mode requires "Management Interface" to be set on the integration',
      );
    }
    const mgmtIp = await resolveDeviceMgmtIpViaFmg(fmgConfig, deviceName, undefined, integrationId);
    if (!mgmtIp) {
      throw new AppError(
        502,
        `Could not resolve management IP for "${deviceName}" via FortiManager`,
      );
    }
    const fgConfig: FortiGateConfig = {
      host: mgmtIp,
      port: 443,
      apiUser: fmgConfig.fortigateApiUser || "",
      apiToken: fmgConfig.fortigateApiToken,
      vdom,
      verifySsl: fmgConfig.fortigateVerifySsl === true,
      mgmtInterface: fmgConfig.mgmtInterface,
    };
    return { kind: "direct-fortigate", fgConfig, vdom };
  }

  return { kind: "fmg-proxy", fmgConfig, deviceName, vdom, integrationId };
}

export type { Transport };

export async function callFortiOs<T>(
  t: Transport,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  if (t.kind === "direct-fortigate") {
    return fgRequest<T>(t.fgConfig, method, path, {
      query: { vdom: t.vdom },
      body,
    });
  }
  const sep = path.includes("?") ? "&" : "?";
  const resource = `${path}${sep}vdom=${encodeURIComponent(t.vdom)}`;
  return fmgProxyRest<T>(t.fmgConfig, t.deviceName, method, resource, { body, integrationId: t.integrationId });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * The push-policy nucleus every "is this push-eligible" check shares: the
 * subnet's discovering integration is one of the two Fortinet transports
 * AND the operator enabled DHCP push on it. Callers AND in their own
 * site-specific dimensions explicitly (ipAddress present, fortigateDevice
 * known, !IPv6) — those deliberately differ per surface; only this
 * nucleus must never drift. Previously re-derived inline at four sites.
 */
export function integrationPushEnabled(
  integration: { type: string; config: unknown } | null | undefined,
): boolean {
  if (!integration || !isFortinetIntegrationType(integration.type)) return false;
  const cfg = (integration.config ?? {}) as Record<string, unknown>;
  return cfg.pushReservations === true;
}

// FortiOS wire form — delegates to the shared util (colon-lowercase,
// pass-through on unrecognizable input). Re-exported here because the
// FortiOS-facing services (descriptionSync, fortigateLocation,
// fortinetManagementAccess, subnetRefresh) import their MAC helper from
// this module's Transport surface.
export const normalizeMac = normalizeMacLowerColon;

/**
 * FortiOS `system.dhcp/server/<id>/reserved-address` holds a `description` of
 * at most **255 characters**. That is the whole budget for the composed string
 * below — origin prefix, operator notes and the bracketed hostname together,
 * not the notes alone.
 *
 * Polaris used to cap the composed value at 64 to stay inside FortiOS 6.2's
 * 35-char field, but 6.2 has been out of support for years and the cap cost
 * more than it bought: a long note silently lost its ` [hostname]` suffix on
 * the device, and `subnetRefreshService.extractHostnameFromDescription` — which
 * anchors the bracket to the END of the string — then fell through to its
 * legacy branch and recovered the truncated NOTES as the hostname.
 *
 * So the cap is the device's own, and over-length input is refused at save
 * time (business rule 74 — `assertReservationDescriptionFits`, called from
 * createReservation / updateReservation on push-eligible subnets) rather than
 * trimmed behind the operator's back. The `slice` here stays as a backstop for the rows no save
 * path gates: discovery-authored notes, an operator-typed note that predates
 * this rule, and the retry tick replaying either.
 */
export const RESERVED_ADDRESS_DESCRIPTION_MAX = 255;

/**
 * The composed FortiOS description, uncapped. Format:
 *   notes present:  "Polaris/<user>: <notes> [<hostname>]"
 *   notes empty:    "Polaris/<user>: <hostname>"
 *
 * Origin first so a FortiGate admin looking at the device immediately sees
 * this entry was written by Polaris and who pushed it. Notes-first when set
 * because the operator typed them as the FortiGate-side reservation comment;
 * hostname is appended in brackets so the discovery side (subnetRefreshService
 * .extractHostnameFromDescription) can still recover it after Polaris-loss
 * recoveries. Falls back to "Polaris: …" when no authenticated user is in
 * scope.
 */
function composeDescription(
  hostname: string | null | undefined,
  createdBy: string | null | undefined,
  fallback: string,
  notes?: string | null,
): string {
  const trimmedNotes = (notes ?? "").trim();
  const trimmedHost = (hostname ?? "").trim();
  const fallbackBody = trimmedHost || fallback || "(unnamed)";
  const body = trimmedNotes
    ? trimmedHost
      ? `${trimmedNotes} [${trimmedHost}]`
      : trimmedNotes
    : fallbackBody;
  const prefix = createdBy && createdBy.trim()
    ? `Polaris/${createdBy.trim()}: `
    : `Polaris: `;
  return prefix + body;
}

function buildDescription(
  hostname: string | null | undefined,
  createdBy: string | null | undefined,
  fallback: string,
  notes?: string | null,
): string {
  const candidate = composeDescription(hostname, createdBy, fallback, notes);
  return candidate.length > RESERVED_ADDRESS_DESCRIPTION_MAX
    ? candidate.slice(0, RESERVED_ADDRESS_DESCRIPTION_MAX)
    : candidate;
}

export interface ReservationDescriptionParams {
  hostname?: string | null;
  createdBy?: string | null;
  /** The IP, used as the description body when there is no hostname. */
  ip: string;
  notes?: string | null;
}

/**
 * How many characters of NOTES fit alongside everything Polaris wraps around
 * them for this reservation. Derived by composing with a one-character note
 * and subtracting it, so the answer tracks the format above instead of
 * restating it — notes appear in the body verbatim, so the overhead is exact.
 *
 * Zero is a legitimate answer: a 240-character hostname leaves no room, and
 * the caller (the IP panel's counter, the 400 below) should say so rather
 * than pretend there is space.
 */
export function reservationNotesBudget(
  params: Omit<ReservationDescriptionParams, "notes">,
): number {
  const overhead =
    composeDescription(params.hostname, params.createdBy, params.ip, "x").length - 1;
  return Math.max(0, RESERVED_ADDRESS_DESCRIPTION_MAX - overhead);
}

/**
 * Refuse a reservation whose composed description would not survive the trip
 * to the device. Called BEFORE the Polaris row is written (create) or updated
 * (edit) on push-eligible subnets, so the operator is told at the keyboard
 * instead of finding a truncated comment on the FortiGate — or, worse, a
 * rediscovered hostname made out of the tail of their own notes.
 *
 * Off push-eligible subnets nothing calls this: `Reservation.notes` is
 * `@db.Text` and a network Polaris never writes to has no device-side field
 * to fit.
 */
export function assertReservationDescriptionFits(
  params: ReservationDescriptionParams,
): void {
  const composed = composeDescription(
    params.hostname,
    params.createdBy,
    params.ip,
    params.notes,
  );
  if (composed.length <= RESERVED_ADDRESS_DESCRIPTION_MAX) return;
  const budget = reservationNotesBudget(params);
  const typed = (params.notes ?? "").trim().length;
  throw new AppError(
    400,
    `Reservation notes are too long for the FortiGate. The device-side ` +
      `description field holds ${RESERVED_ADDRESS_DESCRIPTION_MAX} characters, and Polaris writes it as ` +
      `"Polaris/<user>: <notes> [<hostname>]" so the entry names its origin. ` +
      `That leaves ${budget} character${budget === 1 ? "" : "s"} for notes on this reservation; ` +
      `you typed ${typed}. Shorten the notes by ${typed - budget}.`,
  );
}

export async function findScopeIdForCidr(
  t: Transport,
  cidr: string,
): Promise<{ scopeId: number; serverInterface?: string }> {
  const servers = await callFortiOs<FortiOsDhcpServer[]>(
    t,
    "GET",
    "/api/v2/cmdb/system.dhcp/server",
  );
  const list = Array.isArray(servers) ? servers : [];
  let block: Netmask;
  try {
    block = new Netmask(cidr);
  } catch {
    throw new AppError(400, `Invalid subnet CIDR: ${cidr}`);
  }

  for (const s of list) {
    // Primary match: default-gateway + netmask reconstruct the same network.
    const gateway = s["default-gateway"];
    const netmask = s.netmask;
    if (gateway && netmask) {
      try {
        const blk = new Netmask(`${gateway}/${netmask}`);
        if (blk.base === block.base && blk.bitmask === block.bitmask) {
          return { scopeId: s.id, serverInterface: s.interface };
        }
      } catch {
        /* fall through */
      }
    }
    // Fallback: the configured ip-range start-ip lives inside the subnet.
    const startIp = s["ip-range"]?.[0]?.["start-ip"];
    if (startIp) {
      try {
        if (block.contains(startIp)) {
          return { scopeId: s.id, serverInterface: s.interface };
        }
      } catch {
        /* fall through */
      }
    }
  }
  throw new AppError(
    409,
    `FortiGate has no DHCP scope matching subnet ${cidr}`,
  );
}

export type { FortiOsReservedAddress };

export async function listReservedAddresses(
  t: Transport,
  scopeId: number,
): Promise<FortiOsReservedAddress[]> {
  const data = await callFortiOs<FortiOsReservedAddress[]>(
    t,
    "GET",
    `/api/v2/cmdb/system.dhcp/server/${scopeId}/reserved-address`,
  );
  return Array.isArray(data) ? data : [];
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface PushReservationParams {
  reservationId: string;
  subnetCidr: string;
  ip: string;
  mac: string;
  hostname?: string | null;
  // Operator-typed notes. When non-empty these become the body of the
  // FortiGate-side description (still wrapped in the "Polaris/<user>: " prefix);
  // when empty the description falls back to hostname.
  notes?: string | null;
  // Username of the operator who created the reservation. Stamped into the
  // FortiGate description so the device-side row identifies who pushed it.
  createdBy?: string | null;
  // The integration that owns the originating subnet. Either a FortiManager
  // (proxy or direct) or a standalone FortiGate — buildTransportForIntegration
  // dispatches based on `type`.
  integration: { id: string; type: string; config: unknown };
  deviceName: string;
}

export interface PushReservationResult {
  scopeId: number;
  entryId: number;
  serverInterface?: string;
  description: string;
}

/**
 * Write a DHCP reserved-address entry to the FortiGate and verify it landed.
 * Throws AppError on transport, resolution, write, or verify failure so the
 * upstream reservation create can roll back its Polaris row.
 */
export async function pushReservation(
  params: PushReservationParams,
): Promise<PushReservationResult> {
  if (!params.deviceName) {
    throw new AppError(
      400,
      "Subnet has no fortigateDevice — push requires a discovered FortiGate device name",
    );
  }
  const mac = normalizeMac(params.mac);
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) {
    throw new AppError(
      400,
      `Invalid MAC address: ${params.mac} — push requires a 48-bit MAC`,
    );
  }

  const t = await buildTransportForIntegration(params.integration, params.deviceName);
  const { scopeId, serverInterface } = await findScopeIdForCidr(
    t,
    params.subnetCidr,
  );

  const description = buildDescription(
    params.hostname,
    params.createdBy,
    params.ip,
    params.notes,
  );

  // Pre-check for collision so we can fail with a clearer message than the
  // FortiOS error envelope would give us. FortiOS rejects duplicate MAC and
  // duplicate IP within a scope. Errors include the existing entry's MAC and
  // description so the operator can find/remove it on the FortiGate if
  // Polaris doesn't already know about it (e.g. pushed by a previous tool,
  // added directly on the device, or pending discovery ingest).
  const existing = await listReservedAddresses(t, scopeId);
  const describeEntry = (r: FortiOsReservedAddress): string => {
    const parts: string[] = [`entry id ${r.id}`];
    if (r.mac) parts.push(`MAC ${r.mac}`);
    if (r.description) parts.push(`description "${r.description}"`);
    return parts.join(", ");
  };
  for (const r of existing) {
    if (r.ip && r.ip === params.ip) {
      throw new AppError(
        409,
        `FortiGate already has a reservation for ${params.ip} on this scope (${describeEntry(r)}). ` +
          `If this entry is not in Polaris, run discovery for the FortiManager/FortiGate integration to ingest it, ` +
          `or remove it from the FortiGate to free the IP.`,
      );
    }
    if (r.mac && normalizeMac(r.mac) === mac) {
      throw new AppError(
        409,
        `FortiGate already has a reservation for MAC ${mac} on this scope (${describeEntry(r)}). ` +
          `If this entry is not in Polaris, run discovery for the FortiManager/FortiGate integration to ingest it, ` +
          `or remove it from the FortiGate to free the MAC.`,
      );
    }
  }

  // Write the entry. FortiOS auto-assigns the new id; some versions echo it
  // in the response body's `mkey` field, others omit it.
  const writeRes = await callFortiOs<FortiOsWriteResponse>(
    t,
    "POST",
    `/api/v2/cmdb/system.dhcp/server/${scopeId}/reserved-address`,
    { ip: params.ip, mac, description, type: "mac" },
  );

  let entryId: number | undefined;
  const echoedKey = writeRes?.mkey ?? writeRes?.id;
  if (typeof echoedKey === "number") entryId = echoedKey;
  else if (typeof echoedKey === "string" && /^\d+$/.test(echoedKey))
    entryId = parseInt(echoedKey, 10);

  // Verify by reading the entry back. If we have an echoed id use it; if
  // not, look up by IP + MAC. Either way, we require the entry to be there
  // before considering the push successful.
  const after = await listReservedAddresses(t, scopeId);
  let verified: FortiOsReservedAddress | undefined;
  if (entryId !== undefined) {
    verified = after.find((r) => r.id === entryId);
  }
  if (!verified) {
    verified = after.find(
      (r) => r.ip === params.ip && r.mac && normalizeMac(r.mac) === mac,
    );
    if (verified && entryId === undefined) entryId = verified.id;
  }
  if (!verified || entryId === undefined) {
    throw new AppError(
      502,
      `FortiGate accepted the create but the entry was not visible on read-back for ${params.ip} (${mac})`,
    );
  }
  if (verified.ip !== params.ip || normalizeMac(verified.mac || "") !== mac) {
    throw new AppError(
      502,
      `FortiGate verify mismatch — read back ${verified.ip ?? "?"} / ${verified.mac ?? "?"}, wrote ${params.ip} / ${mac}`,
    );
  }

  return { scopeId, entryId, serverInterface, description };
}

export interface UpdatePushedReservationParams {
  reservationId: string;
  subnetCidr: string;
  ip: string;
  // The new MAC the operator wants on the device-side entry.
  newMac: string;
  // Hostname + notes + createdBy go into the FortiOS `description` field.
  // When hostname or notes are being updated alongside the MAC, callers pass
  // the NEW value so the device description tracks Polaris. Notes-wins-over-
  // hostname semantics match the create path.
  hostname?: string | null;
  notes?: string | null;
  createdBy?: string | null;
  // Pinned device-side identity for Polaris-pushed reservations. When either
  // is null the helper resolves the scope via subnetCidr and looks up the
  // entry by IP — covers the "MAC update on a discovered (never-pushed)
  // dhcp_reservation" path so editing in Polaris can take ownership.
  scopeId?: number | null;
  entryId?: number | null;
  integration: { id: string; type: string; config: unknown };
  deviceName: string;
}

export interface UpdatePushedReservationResult {
  scopeId: number;
  entryId: number;
  serverInterface?: string;
  description: string;
}

/**
 * Update the MAC (and description) of an existing FortiOS reserved-address
 * entry, with read-back verification. Throws AppError on any device-side
 * failure so the caller can keep its Polaris row pristine and surface a
 * single error to the operator instead of producing a Polaris/FortiGate
 * mismatch.
 *
 * Two ownership paths:
 *   - Polaris-pushed: caller supplies pinned scopeId + entryId; we PUT
 *     directly.
 *   - Discovered (never pushed): caller leaves them null; we resolve the
 *     scope by CIDR and find the entry by IP on the device. On success the
 *     caller stamps the resolved scopeId/entryId on the Polaris row so
 *     future operations have a direct handle.
 */
export async function updatePushedReservation(
  params: UpdatePushedReservationParams,
): Promise<UpdatePushedReservationResult> {
  if (!params.deviceName) {
    throw new AppError(
      400,
      "Subnet has no fortigateDevice — update requires a discovered FortiGate device name",
    );
  }
  const mac = normalizeMac(params.newMac);
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) {
    throw new AppError(400, `Invalid MAC address: ${params.newMac} — update requires a 48-bit MAC`);
  }

  const t = await buildTransportForIntegration(params.integration, params.deviceName);

  // Resolve scope: prefer the pinned id from a prior push so we don't pay
  // the full DHCP-server list call on the hot path.
  let scopeId = typeof params.scopeId === "number" ? params.scopeId : null;
  let serverInterface: string | undefined;
  if (scopeId == null) {
    const r = await findScopeIdForCidr(t, params.subnetCidr);
    scopeId = r.scopeId;
    serverInterface = r.serverInterface;
  }

  const existing = await listReservedAddresses(t, scopeId);

  // Locate the entry we're updating: pinned id wins, then fall back to IP.
  let entry: FortiOsReservedAddress | undefined =
    typeof params.entryId === "number"
      ? existing.find((r) => r.id === params.entryId)
      : undefined;
  if (!entry) {
    entry = existing.find((r) => r.ip === params.ip);
  }
  if (!entry) {
    throw new AppError(
      404,
      `FortiGate has no reservation matching ${params.ip} on scope ${scopeId} — was it deleted on the device?`,
    );
  }
  const entryId = entry.id;

  // Reject MAC collisions with a DIFFERENT entry on the same scope. Matches
  // the create-time pre-check shape so the error read-out is consistent.
  const describeEntry = (r: FortiOsReservedAddress): string => {
    const parts: string[] = [`entry id ${r.id}`];
    if (r.mac) parts.push(`MAC ${r.mac}`);
    if (r.description) parts.push(`description "${r.description}"`);
    return parts.join(", ");
  };
  for (const r of existing) {
    if (r.id === entryId) continue;
    if (r.mac && normalizeMac(r.mac) === mac) {
      throw new AppError(
        409,
        `FortiGate already has another reservation for MAC ${mac} on this scope (${describeEntry(r)}). ` +
          `Remove the colliding entry or pick a different MAC.`,
      );
    }
  }

  const description = buildDescription(params.hostname, params.createdBy, params.ip, params.notes);

  // FortiOS accepts partial CMDB updates. We send MAC + refreshed description
  // (and re-assert type="mac" so an entry that drifted to option82 mode comes
  // back to MAC-binding semantics).
  await callFortiOs<unknown>(
    t,
    "PUT",
    `/api/v2/cmdb/system.dhcp/server/${scopeId}/reserved-address/${entryId}`,
    { mac, description, type: "mac" },
  );

  // Verify by read-back.
  const after = await listReservedAddresses(t, scopeId);
  const verified = after.find((r) => r.id === entryId);
  if (!verified) {
    throw new AppError(
      502,
      `FortiGate accepted the update but entry id ${entryId} is no longer visible on read-back`,
    );
  }
  if (normalizeMac(verified.mac || "") !== mac) {
    throw new AppError(
      502,
      `FortiGate verify mismatch — read back MAC ${verified.mac ?? "?"}, wrote ${mac}`,
    );
  }

  return { scopeId, entryId, serverInterface, description };
}

export interface UnpushReservationParams {
  reservationId: string;
  // Pinned device-side identity for Polaris-pushed reservations. When either
  // is null the helper resolves the scope via `subnetCidr` and finds the entry
  // by `ip` on the device — covers releasing a DISCOVERED (never-pushed)
  // dhcp_reservation so the device-side entry is removed too. Mirrors the
  // pinned-vs-discovered ownership split in `updatePushedReservation`.
  scopeId?: number | null;
  entryId?: number | null;
  subnetCidr?: string;
  ip?: string;
  // The integration that owns the device-side entry — `reservation.pushedTo`
  // for pinned rows, the subnet's integration for discovered rows. FMG or
  // standalone FortiGate — buildTransportForIntegration handles both.
  integration: { id: string; type: string; config: unknown };
  deviceName: string;
}

export interface UnpushReservationResult {
  removed: boolean;
  alreadyAbsent: boolean;
}

/**
 * Remove a reserved-address entry from the FortiGate's DHCP scope.
 *
 * Two ownership paths:
 *   - Polaris-pushed: caller supplies pinned scopeId + entryId; we confirm
 *     presence then DELETE by id.
 *   - Discovered (never pushed): caller leaves the ids null + supplies
 *     subnetCidr + ip; we resolve the scope by CIDR and the entry by IP, then
 *     DELETE. This is the release counterpart to `pushReservation` so freeing
 *     a discovered dhcp_reservation in Polaris also clears it on the device.
 *
 * Treats "not found on device" as success-with-warning (the operator may
 * have already deleted it locally). Other failures throw AppError; callers
 * decide whether to surface this as a hard failure or as a warning toast.
 */
export async function unpushReservation(
  params: UnpushReservationParams,
): Promise<UnpushReservationResult> {
  const t = await buildTransportForIntegration(params.integration, params.deviceName);

  // Resolve the scope: a pinned id from a prior push wins; otherwise resolve
  // by the subnet CIDR (discovered rows carry no device-side pointers).
  let scopeId = typeof params.scopeId === "number" ? params.scopeId : null;
  if (scopeId == null) {
    if (!params.subnetCidr) {
      throw new AppError(
        400,
        "unpush requires a pinned scopeId or a subnetCidr to resolve the DHCP scope",
      );
    }
    scopeId = (await findScopeIdForCidr(t, params.subnetCidr)).scopeId;
  }

  // Read the scope's reserved-address list once — used to confirm the entry
  // still exists (pinned path) and to resolve its id by IP (discovered path).
  let list: FortiOsReservedAddress[] | null = null;
  try {
    list = await listReservedAddresses(t, scopeId);
  } catch {
    // Read failed — handled per-path below.
  }

  let entryId = typeof params.entryId === "number" ? params.entryId : null;
  if (entryId == null) {
    // Discovered path: we must positively identify the entry by IP before
    // deleting — a failed/empty read means we can't, so treat as already gone
    // rather than blind-deleting an unknown id.
    const match = list?.find((r) => r.ip === params.ip);
    if (!match) {
      return { removed: false, alreadyAbsent: true };
    }
    entryId = match.id;
  } else {
    // Pinned path: only DELETE when the read confirmed the entry is still
    // there; otherwise treat as already absent (covers both
    // operator-deleted-on-device and a read we couldn't complete).
    const stillThere = list?.some((r) => r.id === entryId) ?? false;
    if (!stillThere) {
      return { removed: false, alreadyAbsent: true };
    }
  }

  await callFortiOs<unknown>(
    t,
    "DELETE",
    `/api/v2/cmdb/system.dhcp/server/${scopeId}/reserved-address/${entryId}`,
  );

  return { removed: true, alreadyAbsent: false };
}

// ─── DHCP Lease Release ─────────────────────────────────────────────────────

export interface ReleaseDhcpLeaseParams {
  integration: { id: string; type: string; config: unknown };
  deviceName: string;
  ip: string;
}

export interface ReleaseDhcpLeaseResult {
  released: boolean;
}

/**
 * Tell the FortiGate's DHCP server to drop the current lease for `ip`. Used
 * when an operator frees a discovered `dhcp_lease` reservation in Polaris —
 * we want the device-side state to match the operator's intent.
 *
 * Note: FortiOS only forgets the *current* lease; the same client can DHCP
 * back the same IP on its next request. This is "expire now," not a block.
 *
 * Endpoint: POST /api/v2/monitor/system/dhcp/release-lease  body: {ip}
 *
 * Throws AppError on transport / auth / device-side failure. Callers should
 * treat this as best-effort and not block the Polaris release on failure.
 */
export async function releaseDhcpLease(
  params: ReleaseDhcpLeaseParams,
): Promise<ReleaseDhcpLeaseResult> {
  if (!params.deviceName) {
    throw new AppError(
      400,
      "Lease release requires a discovered FortiGate device name",
    );
  }
  if (!isValidIpAddress(params.ip)) {
    throw new AppError(400, `Invalid IP for lease release: ${params.ip}`);
  }

  const t = await buildTransportForIntegration(params.integration, params.deviceName);
  await callFortiOs<unknown>(
    t,
    "POST",
    "/api/v2/monitor/system/dhcp/release-lease",
    { ip: params.ip },
  );
  return { released: true };
}

// ─── Error classification ───────────────────────────────────────────────────

export type PushErrorKind = "permanent" | "transient";

const PERMANENT_502_MESSAGE_FRAGMENTS = [
  "verify mismatch",
  "not visible on read-back",
  "Authentication failed",
  // HTTP 403 from either transport. An access-profile or trusthost problem
  // needs an operator on the device; retrying the push until the queue gives
  // up only buries the reason. Matches both fortigateService's "FortiGate
  // permission denied (HTTP 403)" and fortimanagerService's "FortiManager
  // permission denied (HTTP 403)".
  "permission denied",
];

/**
 * Classify a push/update/unpush error as either permanent (operator action
 * required — collisions, bad inputs, auth failures, device-wedged verify
 * mismatches) or transient (retry-eligible — FortiGate offline, FMG
 * unreachable, network timeouts, generic 5xx). Drives both create-time
 * queue-on-failure semantics in reservationService.createReservation AND the
 * retry-tick decisions in retryPendingReservations.
 *
 * Default for unknown shapes: transient. Erring toward retry keeps the
 * operator's claim on the IP alive across unexpected error envelopes; the
 * worst case is a few extra retry ticks that surface a clear permanent
 * failure the next time the gate is reachable.
 */
export function classifyPushError(err: unknown): PushErrorKind {
  if (err instanceof AppError) {
    if (err.httpStatus === 400 || err.httpStatus === 404 || err.httpStatus === 409) {
      return "permanent";
    }
    if (err.httpStatus === 502) {
      for (const frag of PERMANENT_502_MESSAGE_FRAGMENTS) {
        if (err.message.includes(frag)) return "permanent";
      }
      return "transient";
    }
    // Any other status (5xx generic, unmapped) — retry.
    return "transient";
  }
  // Native fetch/abort errors, DNS failures, ECONNREFUSED/ETIMEDOUT/etc all
  // bubble as plain Error or DOMException with the abort-style name. All
  // transient.
  return "transient";
}
