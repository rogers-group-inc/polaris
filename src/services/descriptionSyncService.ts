/**
 * src/services/descriptionSyncService.ts — description sync for the
 * FortiManager / standalone FortiGate integrations, gated per device class by
 * the integration's `syncFortigateDescriptions` / `syncSwitchDescriptions` /
 * `syncApDescriptions` toggles (default off; see utils/descriptionSyncFlags.ts
 * for the legacy `syncDescriptions` fallback).
 *
 * Policy (operator-specified 2026-07): POLARIS-PRIMARY.
 *   - Polaris has a non-empty value → it wins, always: pushed to the device
 *     whenever the device differs. Device-side edits are overwritten on the
 *     next sync (audited with the value they replaced).
 *   - Polaris is empty → adopt (seed from) the device value.
 *   No conflicts by construction — Polaris is the source of truth once a
 *   value exists there. (The earlier newest-edit-wins three-way merge and its
 *   conflict state were retired; legacy rows stamped syncStatus="conflict"
 *   resolve on the next reconcile by pushing the Polaris value.) The
 *   `Asset.descriptionSync.value` / `AssetInterfaceOverride.syncedValue`
 *   fields persist the last synced value — bookkeeping for the FMG mirror's
 *   "device agrees" check and the UI badge, not a merge base.
 *
 * Synced surfaces and their FortiOS CMDB endpoints (all reached through the
 * shared Transport from reservationPushService, so both `useProxy` modes and
 * the standalone FortiGate integration work identically):
 *   - FortiGate interface description:
 *       GET/PUT /api/v2/cmdb/system/interface/<name>            { description }
 *   - FortiGate device description:
 *       GET/PUT /api/v2/cmdb/system/global                      { alias }
 *   - FortiSwitch device description (via parent FortiGate):
 *       GET/PUT /api/v2/cmdb/switch-controller/managed-switch/<switch-id>
 *                                                               { description }
 *   - FortiSwitch port description (via parent FortiGate, child table):
 *       PUT /api/v2/cmdb/switch-controller/managed-switch/<switch-id>/ports/<port>
 *                                                               { description }
 *   - FortiAP device description (via parent FortiGate):
 *       GET/PUT /api/v2/cmdb/wireless-controller/wtp/<wtp-id>   { location }
 *     `location` — NOT `comment` — is the FortiAP surface: it's the field
 *     FortiManager's AP Manager displays/edits, and it exists in FMG's
 *     device-DB copy of the wtp row (confirmed on a live FMG 7.x, where the
 *     rows carry `location` but no `comment` at all — so an FMG install
 *     STRIPS a device-side comment while location round-trips).
 *
 * VERIFY ON A REAL FortiOS 7.x DEVICE before trusting in production (same
 * caveat posture as the SD-WAN collectors): the `system/global.alias` field
 * name + its short length cap, and child-table PUT patch semantics on
 * `ports/<port>`. When the wtp read shows
 * no `location` attribute, the FortiAP surface is skipped (logged once per
 * reconcile). CONFIRMED: the wtp `location` cap is 35 chars (checked against
 * central-management AP Manager). CONFIRMED on FortiOS 7.6.7: the managed-switch
 * mkey (`switch-id`) is NOT reliably the serial — FortiLink setups rename it
 * (e.g. to the hostname) and a serial-keyed PUT 404s ("Invalid url"), so
 * serial-keyed callers resolve the row via `matchManagedSwitchRow` (switch-id
 * OR sn); the 63-char managed-switch/port description cap is also confirmed.
 *
 * Failure posture: best-effort with per-row status, never throws to callers
 * (coord-push posture). Transport/read errors leave sync state untouched
 * (quarantine-verify rule); only an actual failed PUT stamps
 * syncStatus="failed" + syncError. No retry queue — the per-discovery
 * reconcile pass self-heals rows whose push failed transiently, and is also
 * the pass that seeds empty Polaris fields from the device (adopt).
 */
import { chunkArray } from "../utils/chunk.js";
import { EXCLUDED_LIFECYCLE_STATUSES } from "../utils/assetInvariants.js";
import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import {
  buildTransportForIntegration,
  callFortiOs,
  classifyPushError,
  type Transport,
} from "./reservationPushService.js";
import { proxyQuery as fmgQuery } from "./fortimanagerService.js";
import { descriptionSyncFlags, type DescriptionSyncFlags } from "../utils/descriptionSyncFlags.js";

// ─── Value normalization + decision ─────────────────────────────────────────

/** Trim; empty/whitespace-only/non-string → null. */
export function normalizeDescription(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

export type DescSyncAction = "none" | "push" | "adopt";

/**
 * Polaris-primary decision. `polaris` / `device` are the CURRENT values on
 * each side. A non-empty Polaris value always wins (push whenever the device
 * differs — including overwriting device-side edits); an empty Polaris field
 * adopts the device value. All inputs normalized here (trim / empty → null).
 */
export function decideDescriptionSync(
  polaris: unknown,
  device: unknown,
): DescSyncAction {
  const p = normalizeDescription(polaris);
  const d = normalizeDescription(device);
  if (p === d) return "none"; // already agree (incl. both empty)
  if (p !== null) return "push"; // Polaris value exists → Polaris wins
  return "adopt"; // Polaris empty, device has a value → seed from the device
}

// Per-target device-side length caps. FortiOS truncates or rejects
// over-length CMDB strings depending on version; capping client-side keeps
// the read-back verify honest. UNVERIFIED against a real device — see header.
export type DescTargetKind =
  | "fortigate-interface"
  | "fortigate-global"
  | "managed-switch"
  | "switch-port"
  | "wtp";

export const DESCRIPTION_CAPS: Record<DescTargetKind, number> = {
  "fortigate-interface": 255,
  "fortigate-global": 35, // system/global `alias` is a short field
  "managed-switch": 63,   // 63-char cap confirmed on FortiOS 7.6.7
  "switch-port": 63,
  "wtp": 35,              // wtp `location` cap confirmed: 35 chars
};

export function capDescriptionForTarget(value: string, target: DescTargetKind): string {
  const cap = DESCRIPTION_CAPS[target];
  return value.length > cap ? value.slice(0, cap) : value;
}

// ─── FortiOS CMDB shapes (subset we use) ─────────────────────────────────────

interface FortiOsInterfaceRow {
  name?: string;
  description?: string;
  alias?: string;
}

interface FortiOsGlobalRow {
  alias?: string;
}

interface FortiOsManagedSwitchRow {
  "switch-id"?: string;
  sn?: string;
  description?: string;
  ports?: Array<{ "port-name"?: string; description?: string }>;
}

interface FortiOsWtpRow {
  "wtp-id"?: string;
  name?: string;
  location?: string;
}

// FortiOS GETs return `results` as an array (even for mkey reads); some
// global-scope objects come back as a bare object. Handle both.
function firstResult<T>(res: unknown): T | null {
  if (Array.isArray(res)) return (res[0] as T) ?? null;
  if (res && typeof res === "object") return res as T;
  return null;
}

function listResults<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  return [];
}

// The managed-switch mkey (`switch-id`) DEFAULTS to the switch serial but is
// frequently renamed (e.g. to the hostname) in FortiLink setups — confirmed on
// FortiOS 7.6.7, where a serial-keyed PUT 404s ("Invalid url"). Polaris assets
// carry the serial, so every serial-keyed entry into this table must match on
// `switch-id` OR `sn` and then address the device by the row's real mkey.
function matchManagedSwitchRow(
  rows: FortiOsManagedSwitchRow[],
  serialOrId: string,
): FortiOsManagedSwitchRow | null {
  const want = serialOrId.trim().toUpperCase();
  if (!want) return null;
  for (const r of rows) {
    const id = String(r?.["switch-id"] || "").trim().toUpperCase();
    const sn = String(r?.sn || "").trim().toUpperCase();
    if (id === want || sn === want) return r;
  }
  return null;
}

// ─── Push results ────────────────────────────────────────────────────────────

export type DescPushResult =
  | { ok: true; previousDeviceValue: string | null }
  | { ok: false; error: string; errorKind: "permanent" | "transient" };

function pushFailure(err: unknown, context: string): DescPushResult {
  const kind = classifyPushError(err);
  const msg = err instanceof Error ? err.message : String(err);
  return { ok: false, error: `[${kind}] ${context}: ${msg}`, errorKind: kind };
}

// One PUT + read-back verify against a CMDB object. `getPath` re-reads the
// object; `extract` pulls the description-like field out of the row.
async function putAndVerify<TRow>(
  t: Transport,
  putPath: string,
  body: Record<string, string>,
  getPath: string,
  extract: (row: TRow | null) => unknown,
  expected: string,
  context: string,
  currentDeviceValue: string | null,
): Promise<DescPushResult> {
  try {
    await callFortiOs(t, "PUT", putPath, body);
  } catch (err) {
    return pushFailure(err, context);
  }
  try {
    const after = await callFortiOs<unknown>(t, "GET", getPath);
    const landed = normalizeDescription(extract(firstResult<TRow>(after)));
    if (landed !== normalizeDescription(expected)) {
      return {
        ok: false,
        error: `[permanent] ${context}: verify mismatch — device kept ${JSON.stringify(landed)}`,
        errorKind: "permanent",
      };
    }
  } catch (err) {
    // The PUT went through but the verify read failed — report transient so
    // the reconcile pass re-checks next cycle rather than flagging a hard
    // failure for what is likely a momentary read error.
    return pushFailure(err, `${context} (verify read)`);
  }
  return { ok: true, previousDeviceValue: currentDeviceValue };
}

export interface DescPushBaseParams {
  integration: { id: string; type: string; config: unknown };
  /** FMG/dvmdb device name of the FortiGate the transport lands on. */
  deviceName: string;
  /** Value to write (pre-normalized, non-empty). */
  value: string;
  /**
   * Current device-side value when the caller already read it (reconcile
   * path). Undefined → pre-read here. Skips the push when equal.
   */
  currentDeviceValue?: string | null;
  /** Reuse an already-built transport (reconcile path). */
  transport?: Transport;
}

async function resolveTransport(p: DescPushBaseParams): Promise<Transport> {
  return p.transport ?? (await buildTransportForIntegration(p.integration, p.deviceName));
}

/** FortiGate interface `description` (system/interface). */
export async function pushInterfaceDescription(
  p: DescPushBaseParams & { ifName: string },
): Promise<DescPushResult> {
  const context = `interface ${p.ifName} on ${p.deviceName}`;
  const path = `/api/v2/cmdb/system/interface/${encodeURIComponent(p.ifName)}`;
  const value = capDescriptionForTarget(p.value, "fortigate-interface");
  try {
    const t = await resolveTransport(p);
    let current = p.currentDeviceValue;
    if (current === undefined) {
      const res = await callFortiOs<unknown>(t, "GET", path);
      current = normalizeDescription(firstResult<FortiOsInterfaceRow>(res)?.description);
    }
    if (normalizeDescription(current) === normalizeDescription(value)) {
      return { ok: true, previousDeviceValue: current ?? null };
    }
    return await putAndVerify<FortiOsInterfaceRow>(
      t, path, { description: value }, path, (r) => r?.description, value, context, current ?? null,
    );
  } catch (err) {
    return pushFailure(err, context);
  }
}

/**
 * FortiSwitch port `description` (managed-switch child table, via parent FG).
 * `switchId` may be the asset's serial OR the real `switch-id` mkey: the
 * save-time path (no currentDeviceValue) lists the managed-switch table and
 * resolves the row by either key, since the mkey is often renamed away from
 * the serial. The reconcile path passes the already-resolved mkey +
 * currentDeviceValue and skips the read.
 */
export async function pushSwitchPortDescription(
  p: DescPushBaseParams & { switchId: string; portName: string },
): Promise<DescPushResult> {
  const context = `switch ${p.switchId} port ${p.portName} via ${p.deviceName}`;
  const value = capDescriptionForTarget(p.value, "switch-port");
  try {
    const t = await resolveTransport(p);
    let switchId = p.switchId;
    let current = p.currentDeviceValue;
    if (current === undefined) {
      const res = await callFortiOs<unknown>(t, "GET", "/api/v2/cmdb/switch-controller/managed-switch");
      const row = matchManagedSwitchRow(listResults<FortiOsManagedSwitchRow>(res), p.switchId);
      const resolvedId = String(row?.["switch-id"] || "").trim();
      if (!row || !resolvedId) {
        return {
          ok: false,
          error: `[permanent] ${context}: switch not found in the controller's managed-switch table`,
          errorKind: "permanent",
        };
      }
      switchId = resolvedId;
      const port = (row.ports ?? []).find((x) => x?.["port-name"] === p.portName);
      current = normalizeDescription(port?.description);
    }
    if (normalizeDescription(current) === normalizeDescription(value)) {
      return { ok: true, previousDeviceValue: current ?? null };
    }
    const portPath = `/api/v2/cmdb/switch-controller/managed-switch/${encodeURIComponent(switchId)}/ports/${encodeURIComponent(p.portName)}`;
    return await putAndVerify<{ description?: string }>(
      t, portPath, { description: value }, portPath, (r) => r?.description, value, context, current ?? null,
    );
  } catch (err) {
    return pushFailure(err, context);
  }
}

export type DeviceDescTarget =
  | { kind: "fortigate-global" }
  | { kind: "managed-switch"; switchId: string }
  | { kind: "wtp"; wtpId: string };

/** Device-level description (FortiGate alias / switch description / wtp location). */
export async function pushDeviceDescription(
  p: DescPushBaseParams & { target: DeviceDescTarget },
): Promise<DescPushResult> {
  try {
    const t = await resolveTransport(p);
    if (p.target.kind === "fortigate-global") {
      const context = `system/global alias on ${p.deviceName}`;
      const path = "/api/v2/cmdb/system/global";
      const value = capDescriptionForTarget(p.value, "fortigate-global");
      let current = p.currentDeviceValue;
      if (current === undefined) {
        const res = await callFortiOs<unknown>(t, "GET", path);
        current = normalizeDescription(firstResult<FortiOsGlobalRow>(res)?.alias);
      }
      if (normalizeDescription(current) === normalizeDescription(value)) {
        return { ok: true, previousDeviceValue: current ?? null };
      }
      return await putAndVerify<FortiOsGlobalRow>(
        t, path, { alias: value }, path, (r) => r?.alias, value, context, current ?? null,
      );
    }
    if (p.target.kind === "managed-switch") {
      // Same serial-vs-mkey rule as pushSwitchPortDescription: the save-time
      // caller passes the asset serial; resolve the row's real switch-id.
      const value = capDescriptionForTarget(p.value, "managed-switch");
      let switchId = p.target.switchId;
      let current = p.currentDeviceValue;
      if (current === undefined) {
        const res = await callFortiOs<unknown>(t, "GET", "/api/v2/cmdb/switch-controller/managed-switch");
        const row = matchManagedSwitchRow(listResults<FortiOsManagedSwitchRow>(res), switchId);
        const resolvedId = String(row?.["switch-id"] || "").trim();
        if (!row || !resolvedId) {
          return {
            ok: false,
            error: `[permanent] managed-switch ${switchId} via ${p.deviceName}: switch not found in the controller's managed-switch table`,
            errorKind: "permanent",
          };
        }
        switchId = resolvedId;
        current = normalizeDescription(row.description);
      }
      if (normalizeDescription(current) === normalizeDescription(value)) {
        return { ok: true, previousDeviceValue: current ?? null };
      }
      const context = `managed-switch ${switchId} via ${p.deviceName}`;
      const path = `/api/v2/cmdb/switch-controller/managed-switch/${encodeURIComponent(switchId)}`;
      return await putAndVerify<FortiOsManagedSwitchRow>(
        t, path, { description: value }, path, (r) => r?.description, value, context, current ?? null,
      );
    }
    // wtp — the description surface is `location` (AP Manager's field), not
    // `comment` (absent from FMG's copy, so installs strip it — see header).
    const context = `wtp ${p.target.wtpId} via ${p.deviceName}`;
    const path = `/api/v2/cmdb/wireless-controller/wtp/${encodeURIComponent(p.target.wtpId)}`;
    const value = capDescriptionForTarget(p.value, "wtp");
    let current = p.currentDeviceValue;
    if (current === undefined) {
      const res = await callFortiOs<unknown>(t, "GET", path);
      current = normalizeDescription(firstResult<FortiOsWtpRow>(res)?.location);
    }
    if (normalizeDescription(current) === normalizeDescription(value)) {
      return { ok: true, previousDeviceValue: current ?? null };
    }
    return await putAndVerify<FortiOsWtpRow>(
      t, path, { location: value }, path, (r) => r?.location, value, context, current ?? null,
    );
  } catch (err) {
    return pushFailure(err, `device description on ${p.deviceName}`);
  }
}

// ─── Eligibility + save-time fast path ──────────────────────────────────────

interface TopologyBlob {
  role?: string;
  haRole?: string;
  controllerFortigate?: string;
  deviceName?: string;
}

interface EligibleContext {
  integration: { id: string; type: string; config: unknown; name: string };
  topology: TopologyBlob;
  role: "fortigate" | "fortiswitch" | "fortiap";
  /** Transport target: the FortiGate itself, or the parent controller. */
  deviceName: string;
}

// ─── FMG central-management mirror ──────────────────────────────────────────
//
// FortiManager ADOMs manage FortiAPs (AP Manager) and FortiSwitches
// (FortiSwitch Manager) in either central or per-device mode. In central mode
// FMG's own database copy is authoritative from FMG's point of view: a
// device-direct description write works at runtime, but the next install
// diffs FMG's copy against the device and REVERTS it. So when discovery has
// stamped `Integration.config.centralManagement.{wtp,fsw}`
// (detectCentralManagement, run at FMG discovery start), a successful
// device-side push is also mirrored into FMG's database — a plain JSON-RPC
// `update` (never `set`, which would CREATE missing objects; and NEVER an
// install, which would push everything an FMG admin has staged). Where FMG
// keeps each copy (confirmed on a live FMG 7.x):
//   - FortiAP `location`: the per-AP rows AP Manager displays live in each
//     controller FortiGate's DEVICE DB —
//     /pm/config/device/<fgt>/vdom/root/wireless-controller/wtp/<wtp-id> —
//     NOT in the ADOM object table (empty on the confirmed box).
//   - FortiSwitch description / port description: the ADOM-level
//     /pm/config/adom/<adom>/obj/fsp/managed-switch table (UNVERIFIED —
//     the confirmed box manages switches per-device, so this path is inert
//     there; failures surface as warning Events).
// The reconcile additionally batch-heals FMG-side drift for values the
// device already agrees on, which covers pushes that predate the mirror and
// mirror updates that failed transiently. Caveat: FMG's copy is treated as a
// projection of the device value, not an edit surface — an AP Manager edit
// that was saved but never installed gets overwritten by the mirror (an
// *installed* edit reaches the device and flows back through the normal
// adopt path). Failures never affect the device-side sync state.

function centralFlags(config: unknown): { wtp: boolean; fsw: boolean } {
  const cm = (config as { centralManagement?: { wtp?: boolean; fsw?: boolean } } | null)?.centralManagement;
  return { wtp: cm?.wtp === true, fsw: cm?.fsw === true };
}

function fmgAdom(config: unknown): string {
  const a = (config as { adom?: string } | null)?.adom;
  return typeof a === "string" && a.trim() ? a.trim() : "root";
}

interface FmgOpResult { ok: boolean; data?: unknown; error?: string }

// One JSON-RPC call against FMG's database. FMG-level errors come back in the
// envelope (status.code != 0), transport errors throw — both map to ok:false.
// Mirror writes use "update" (modify-existing-only) — "set" would create
// objects FMG never had, which a later install would then push.
async function fmgAdomOp(
  integration: { id: string; config: unknown },
  method: "get" | "update",
  url: string,
  data?: Record<string, unknown>,
): Promise<FmgOpResult> {
  try {
    const res = (await fmgQuery(
      integration.config as never,
      method,
      [{ url, ...(data ? { data } : {}) }],
      integration.id,
    )) as { result?: Array<{ status?: { code?: number; message?: string }; data?: unknown }> };
    const r = res?.result?.[0];
    if (r?.status?.code !== 0) {
      return { ok: false, error: r?.status?.message || `FMG code ${r?.status?.code ?? "unknown"}` };
    }
    return { ok: true, data: r.data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

type FmgMirrorTarget =
  | { kind: "wtp"; wtpId: string; deviceName: string }
  | { kind: "managed-switch"; switchId: string }
  | { kind: "switch-port"; switchId: string; portName: string };

// FMG JSON-RPC urls are plain strings, not URL-encoded — mkeys (serials,
// port names) carry no reserved characters. wtp rows live in the controller
// FortiGate's device DB; switch rows at the ADOM level (see section header).
function fmgMirrorUrl(adom: string, t: FmgMirrorTarget): { url: string; field: "location" | "description" } {
  if (t.kind === "wtp") {
    return { url: `/pm/config/device/${t.deviceName}/vdom/root/wireless-controller/wtp/${t.wtpId}`, field: "location" };
  }
  const base = `/pm/config/adom/${adom}/obj`;
  if (t.kind === "managed-switch") return { url: `${base}/fsp/managed-switch/${t.switchId}`, field: "description" };
  return { url: `${base}/fsp/managed-switch/${t.switchId}/ports/${t.portName}`, field: "description" };
}

/** `update` + read-back verify against FMG's copy. Best-effort, never throws. */
async function mirrorToFmg(
  integration: { id: string; config: unknown },
  target: FmgMirrorTarget,
  value: string,
): Promise<FmgOpResult> {
  const { url, field } = fmgMirrorUrl(fmgAdom(integration.config), target);
  const write = await fmgAdomOp(integration, "update", url, { [field]: value });
  if (!write.ok) return { ok: false, error: `update ${url}: ${write.error}` };
  const back = await fmgAdomOp(integration, "get", url);
  if (!back.ok) return { ok: true }; // update landed; read-back is best-effort
  const row = firstResult<Record<string, unknown>>(back.data);
  const landed = normalizeDescription(row?.[field]);
  if (landed !== normalizeDescription(value)) {
    return {
      ok: false,
      error: `verify mismatch on ${url} — FMG kept ${JSON.stringify(landed)}`,
    };
  }
  return { ok: true };
}

async function logFmgMirrorEvent(
  asset: { id: string; hostname: string | null },
  ctx: { scope: "device" | "interface"; ifName?: string; value: string; result: FmgOpResult },
): Promise<void> {
  const where = ctx.scope === "interface" ? `switch port ${ctx.ifName}` : "device description";
  await logEvent({
    action: ctx.result.ok ? "asset.description.fmg_mirrored" : "asset.description.fmg_mirror_failed",
    resourceType: "asset",
    resourceId: asset.id,
    resourceName: asset.hostname ?? undefined,
    actor: "system:description-sync",
    level: ctx.result.ok ? "info" : "warning",
    message: ctx.result.ok
      ? `Description for ${where} mirrored to FortiManager's central-management database`
      : `FortiManager central-database mirror for ${where} failed: ${ctx.result.error} — AP Manager / FortiSwitch Manager may revert the device value on the next install`,
    details: { scope: ctx.scope, ...(ctx.ifName ? { ifName: ctx.ifName } : {}), value: ctx.value, ...(ctx.result.ok ? {} : { error: ctx.result.error }) },
  });
}

/**
 * Resolve whether description sync applies to this asset and, if so, which
 * FortiGate the transport must land on. Null = not eligible (this device
 * class's toggle off, non-Fortinet asset, HA-secondary member, or missing
 * controller linkage).
 */
function resolveEligibility(asset: {
  fortinetTopology: unknown;
  hostname: string | null;
  discoveredByIntegration: { id: string; type: string; config: unknown; name: string } | null;
}): EligibleContext | null {
  const integration = asset.discoveredByIntegration;
  if (!integration) return null;
  if (integration.type !== "fortimanager" && integration.type !== "fortigate") return null;
  const topology = (asset.fortinetTopology ?? {}) as TopologyBlob;
  const role = topology.role;
  if (role !== "fortigate" && role !== "fortiswitch" && role !== "fortiap") return null;
  if (!descriptionSyncFlags(integration.config)[role]) return null;
  // HA config replicates from the primary; never push at a standby member.
  if (role === "fortigate" && topology.haRole === "secondary") return null;
  const deviceName =
    role === "fortigate"
      ? (topology.deviceName || asset.hostname || "").trim()
      : (topology.controllerFortigate || "").trim();
  if (!deviceName) return null;
  return { integration, topology, role, deviceName };
}

export interface SaveSyncResult {
  attempted: boolean;
  status?: "synced" | "failed";
  error?: string;
}

/**
 * Save-time fast path: called after an operator writes an interface comment
 * (scope="interface") or Asset.description (scope="device"). The Polaris row
 * is already persisted by the caller — this only mirrors the value to the
 * device and stamps sync state. Never throws.
 */
export async function syncDescriptionsOnSave(params: {
  assetId: string;
  scope: "interface" | "device";
  ifName?: string;
  actor?: string;
}): Promise<SaveSyncResult> {
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: params.assetId },
      select: {
        id: true,
        hostname: true,
        serialNumber: true,
        description: true,
        fortinetTopology: true,
        discoveredByIntegration: { select: { id: true, type: true, config: true, name: true } },
      },
    });
    if (!asset) return { attempted: false };
    const ctx = resolveEligibility(asset);
    if (!ctx) return { attempted: false };

    if (params.scope === "interface") {
      if (!params.ifName) return { attempted: false };
      if (ctx.role === "fortiap") return { attempted: false }; // no AP interface descriptions
      const override = await prisma.assetInterfaceOverride.findUnique({
        where: { assetId_ifName: { assetId: asset.id, ifName: params.ifName } },
      });
      const value = normalizeDescription(override?.description);
      // Cleared override (row deleted by the route) or empty value: local-only
      // clear — the device keeps its description and the discovered value
      // shows through again.
      if (!override || value === null) return { attempted: false };

      let result: DescPushResult;
      if (ctx.role === "fortigate") {
        result = await pushInterfaceDescription({
          integration: ctx.integration,
          deviceName: ctx.deviceName,
          ifName: params.ifName,
          value,
        });
      } else {
        const switchId = (asset.serialNumber || "").trim();
        if (!switchId) return { attempted: false };
        result = await pushSwitchPortDescription({
          integration: ctx.integration,
          deviceName: ctx.deviceName,
          switchId,
          portName: params.ifName,
          value,
        });
      }
      await stampOverrideSyncState(override.id, result, value);
      await logInterfacePushEvent(asset, params.ifName, value, result, params.actor);
      // Central FortiSwitch management: mirror the port description into
      // FMG's ADOM DB so an install doesn't revert it. Serial as the ADOM
      // mkey (renamed switch-ids heal via the reconcile batch pass).
      if (result.ok && ctx.role === "fortiswitch" && ctx.integration.type === "fortimanager" && centralFlags(ctx.integration.config).fsw) {
        const serial = (asset.serialNumber || "").trim();
        if (serial) {
          const mirror = await mirrorToFmg(ctx.integration, { kind: "switch-port", switchId: serial, portName: params.ifName }, value);
          await logFmgMirrorEvent(asset, { scope: "interface", ifName: params.ifName, value, result: mirror });
        }
      }
      return result.ok
        ? { attempted: true, status: "synced" }
        : { attempted: true, status: "failed", error: result.error };
    }

    // scope === "device"
    const value = normalizeDescription(asset.description);
    if (value === null) {
      // Operator cleared the Polaris description: local-only, clear stale
      // sync state so the UI doesn't show a "synced" badge for an empty field.
      await prisma.asset.update({
        where: { id: asset.id },
        data: { descriptionSync: Prisma.DbNull },
      });
      return { attempted: false };
    }
    const target = deviceTargetFor(ctx.role, asset.serialNumber);
    if (!target) return { attempted: false };
    const result = await pushDeviceDescription({
      integration: ctx.integration,
      deviceName: ctx.deviceName,
      target,
      value,
    });
    await stampAssetSyncState(asset.id, result, value);
    await logDevicePushEvent(asset, value, result, params.actor);
    // Central AP / FortiSwitch management: mirror the device description
    // (wtp location / managed-switch description) into FMG's database.
    if (result.ok && ctx.integration.type === "fortimanager") {
      const flags = centralFlags(ctx.integration.config);
      const serial = (asset.serialNumber || "").trim();
      if (serial && ((ctx.role === "fortiap" && flags.wtp) || (ctx.role === "fortiswitch" && flags.fsw))) {
        const mirror = await mirrorToFmg(
          ctx.integration,
          ctx.role === "fortiap"
            ? { kind: "wtp", wtpId: serial, deviceName: ctx.deviceName }
            : { kind: "managed-switch", switchId: serial },
          value,
        );
        await logFmgMirrorEvent(asset, { scope: "device", value, result: mirror });
      }
    }
    return result.ok
      ? { attempted: true, status: "synced" }
      : { attempted: true, status: "failed", error: result.error };
  } catch (err) {
    logger.warn(
      { assetId: params.assetId, scope: params.scope, ifName: params.ifName, err: err instanceof Error ? err.message : String(err) },
      "description_sync.on_save_failed",
    );
    return { attempted: false };
  }
}

function deviceTargetFor(
  role: "fortigate" | "fortiswitch" | "fortiap",
  serialNumber: string | null,
): DeviceDescTarget | null {
  if (role === "fortigate") return { kind: "fortigate-global" };
  const serial = (serialNumber || "").trim();
  if (!serial) return null;
  return role === "fortiswitch" ? { kind: "managed-switch", switchId: serial } : { kind: "wtp", wtpId: serial };
}

// A successful push/adopt makes `agreedValue` the new merge baseline (both
// sides now hold it). A failed push preserves the prior baseline so the next
// reconcile still knows the last-agreed value.
async function stampOverrideSyncState(
  overrideId: string,
  result: DescPushResult,
  agreedValue: string,
): Promise<void> {
  await prisma.assetInterfaceOverride.update({
    where: { id: overrideId },
    data: result.ok
      ? { syncStatus: "synced", lastSyncAt: new Date(), syncError: null, syncedValue: agreedValue }
      : { syncStatus: "failed", lastSyncAt: new Date(), syncError: result.error },
  }).catch(() => { /* row may have been cleared concurrently — best-effort */ });
}

async function stampAssetSyncState(
  assetId: string,
  result: DescPushResult,
  agreedValue: string | null,
): Promise<void> {
  const blob = result.ok
    ? { status: "synced", at: new Date().toISOString(), value: agreedValue }
    : { status: "failed", at: new Date().toISOString(), error: result.error };
  await prisma.asset.update({
    where: { id: assetId },
    data: { descriptionSync: blob },
  }).catch(() => { /* asset may have been deleted concurrently — best-effort */ });
}

/**
 * Last synced value from an Asset.descriptionSync blob (bookkeeping — see
 * header). Undefined = no `value` key (never synced / failed / legacy
 * conflict blob).
 */
function storedSyncedValue(descriptionSync: unknown): string | null | undefined {
  if (descriptionSync && typeof descriptionSync === "object" &&
      Object.prototype.hasOwnProperty.call(descriptionSync, "value")) {
    return normalizeDescription((descriptionSync as { value?: unknown }).value);
  }
  return undefined;
}

async function logInterfacePushEvent(
  asset: { id: string; hostname: string | null },
  ifName: string,
  value: string,
  result: DescPushResult,
  actor?: string,
): Promise<void> {
  await logEvent({
    action: result.ok ? "asset.interface.description.pushed" : "asset.interface.description.push_failed",
    resourceType: "asset",
    resourceId: asset.id,
    resourceName: asset.hostname ?? undefined,
    actor,
    level: result.ok ? "info" : "warning",
    message: result.ok
      ? `Interface comment for ${ifName} pushed to device`
      : `Interface comment push for ${ifName} failed: ${result.error}`,
    details: {
      ifName,
      value,
      ...(result.ok
        ? result.previousDeviceValue !== null && result.previousDeviceValue !== value
          ? { overwroteDeviceValue: result.previousDeviceValue }
          : {}
        : { error: result.error }),
    },
  });
}

async function logDevicePushEvent(
  asset: { id: string; hostname: string | null },
  value: string,
  result: DescPushResult,
  actor?: string,
): Promise<void> {
  await logEvent({
    action: result.ok ? "asset.description.pushed" : "asset.description.push_failed",
    resourceType: "asset",
    resourceId: asset.id,
    resourceName: asset.hostname ?? undefined,
    actor,
    level: result.ok ? "info" : "warning",
    message: result.ok
      ? "Device description pushed to device"
      : `Device description push failed: ${result.error}`,
    details: {
      value,
      ...(result.ok
        ? result.previousDeviceValue !== null && result.previousDeviceValue !== value
          ? { overwroteDeviceValue: result.previousDeviceValue }
          : {}
        : { error: result.error }),
    },
  });
}

// ─── Discovery reconcile pass ────────────────────────────────────────────────

export interface DescriptionSyncSummary {
  devices: number;
  pushed: number;
  adopted: number;
  failed: number;
  skippedDevices: number;
  /** FMG central-management ADOM-DB mirror writes (see mirrorToFmg). */
  fmgMirrored: number;
  fmgMirrorFailed: number;
}

// Values successfully pushed to devices during THIS reconcile run — the batch
// mirror pass consults it because the `assets` snapshot's sync-state blobs
// were loaded before the pushes and are stale for just-pushed rows.
interface PushedThisRun {
  device: Map<string, string>; // assetId → pushed value
  port: Map<string, string>;   // portKey(assetId, ifName) → pushed value
}

// Asset ids are UUIDs (no spaces), so a space separator is collision-safe.
function portKey(assetId: string, ifName: string): string {
  return `${assetId} ${ifName}`;
}

interface ReconcileAsset {
  id: string;
  hostname: string | null;
  serialNumber: string | null;
  description: string | null;
  descriptionSync: unknown;
  fortinetTopology: unknown;
}

interface ReconcileOverride {
  id: string;
  assetId: string;
  ifName: string;
  description: string | null;
  syncStatus: string | null;
  syncError: string | null;
  syncedValue: string | null;
}

/**
 * Per-discovery reconcile: for every FortiGate this integration owns, read
 * the current device-side descriptions (one CMDB GET per surface) and apply
 * the Polaris-primary rule over the device-level values + every interface
 * override: push wherever a non-empty Polaris value differs from the device
 * (also the retry path for pushes that failed transiently at save time),
 * adopt device values into empty Polaris description fields. DB writes
 * happen only on change. Never throws.
 */
export async function runDescriptionSyncForIntegration(
  integration: { id: string; type: string; config: unknown; name: string },
): Promise<DescriptionSyncSummary> {
  const summary: DescriptionSyncSummary = { devices: 0, pushed: 0, adopted: 0, failed: 0, skippedDevices: 0, fmgMirrored: 0, fmgMirrorFailed: 0 };
  const flags = descriptionSyncFlags(integration.config);
  if (!flags.fortigate && !flags.fortiswitch && !flags.fortiap) return summary;
  const pushedThisRun: PushedThisRun = { device: new Map(), port: new Map() };

  const assets: ReconcileAsset[] = await prisma.asset.findMany({
    where: {
      discoveredByIntegrationId: integration.id,
      status: { notIn: EXCLUDED_LIFECYCLE_STATUSES },
    },
    select: {
      id: true,
      hostname: true,
      serialNumber: true,
      description: true,
      descriptionSync: true,
      fortinetTopology: true,
    },
  });

  // Group assets under the FortiGate whose transport reaches them. A device
  // class whose toggle is off is left out entirely — no read, no push, no
  // adopt, no FMG mirror.
  const groups = new Map<string, { firewall?: ReconcileAsset; switches: ReconcileAsset[]; aps: ReconcileAsset[] }>();
  const groupFor = (deviceName: string) => {
    let g = groups.get(deviceName);
    if (!g) {
      g = { switches: [], aps: [] };
      groups.set(deviceName, g);
    }
    return g;
  };
  for (const a of assets) {
    const topo = (a.fortinetTopology ?? {}) as TopologyBlob;
    if (topo.role === "fortigate") {
      if (!flags.fortigate) continue;
      if (topo.haRole === "secondary") continue;
      const name = (topo.deviceName || a.hostname || "").trim();
      if (name) groupFor(name).firewall = a;
    } else if (topo.role === "fortiswitch") {
      if (!flags.fortiswitch) continue;
      const ctrl = (topo.controllerFortigate || "").trim();
      if (ctrl) groupFor(ctrl).switches.push(a);
    } else if (topo.role === "fortiap") {
      if (!flags.fortiap) continue;
      const ctrl = (topo.controllerFortigate || "").trim();
      if (ctrl) groupFor(ctrl).aps.push(a);
    }
  }
  if (groups.size === 0) return summary;

  const allAssetIds = assets.map((a) => a.id);
  const overrides: ReconcileOverride[] = await prisma.assetInterfaceOverride.findMany({
    where: { assetId: { in: allAssetIds } },
    select: {
      id: true, assetId: true, ifName: true, description: true,
      syncStatus: true, syncError: true, syncedValue: true,
    },
  });
  const overridesByAsset = new Map<string, ReconcileOverride[]>();
  for (const o of overrides) {
    const list = overridesByAsset.get(o.assetId) ?? [];
    list.push(o);
    overridesByAsset.set(o.assetId, list);
  }

  // Small device-level parallelism: pushes are rare (only on drift), so the
  // per-device work is read-dominated. 5 concurrent devices matches the
  // discovery parallelism floor without hammering FMG's proxy lane.
  const deviceNames = [...groups.keys()];
  const CHUNK = 5;
  for (const nameChunk of chunkArray(deviceNames, CHUNK)) {
    await Promise.all(
      nameChunk.map(async (deviceName) => {
        const group = groups.get(deviceName)!;
        try {
          await reconcileDevice(integration, deviceName, group, overridesByAsset, summary, pushedThisRun);
          summary.devices++;
        } catch (err) {
          // Transport preconditions (missing direct-mode token, unresolvable
          // mgmt IP) or a wholesale read failure: skip the device, touch no
          // state (quarantine-verify rule).
          summary.skippedDevices++;
          logger.warn(
            { integrationId: integration.id, deviceName, err: err instanceof Error ? err.message : String(err) },
            "description_sync.device_skipped",
          );
        }
      }),
    );
  }

  // Central-management batch heal: for centrally-managed classes, align FMG's
  // ADOM DB with every Polaris value the device already agrees on. Covers
  // pushes that predate the mirror feature, mirror sets that failed
  // transiently, and this run's own pushes (via pushedThisRun — the assets
  // snapshot's sync-state blobs predate them).
  if (integration.type === "fortimanager") {
    await mirrorCentralDbDrift(integration, flags, assets, overridesByAsset, pushedThisRun, summary);
  }
  return summary;
}

async function reconcileDevice(
  integration: { id: string; type: string; config: unknown; name: string },
  deviceName: string,
  group: { firewall?: ReconcileAsset; switches: ReconcileAsset[]; aps: ReconcileAsset[] },
  overridesByAsset: Map<string, ReconcileOverride[]>,
  summary: DescriptionSyncSummary,
  pushedThisRun: PushedThisRun,
): Promise<void> {
  const transport = await buildTransportForIntegration(integration, deviceName);

  // Reads are per-surface best-effort: a failed read skips that surface's
  // decisions this cycle without touching state.
  let interfaceByName: Map<string, string | null> | null = null;
  let globalAlias: string | null | undefined; // undefined = read failed
  let switchRows: Map<string, FortiOsManagedSwitchRow> | null = null;
  let wtpRows: Map<string, FortiOsWtpRow> | null = null;
  let wtpSupportsLocation = false;

  if (group.firewall) {
    try {
      const res = await callFortiOs<unknown>(transport, "GET", "/api/v2/cmdb/system/interface");
      interfaceByName = new Map(
        listResults<FortiOsInterfaceRow>(res)
          .filter((r) => typeof r?.name === "string" && r.name)
          .map((r) => [r.name as string, normalizeDescription(r.description)]),
      );
    } catch { /* surface skipped this cycle */ }
    try {
      const res = await callFortiOs<unknown>(transport, "GET", "/api/v2/cmdb/system/global");
      globalAlias = normalizeDescription(firstResult<FortiOsGlobalRow>(res)?.alias);
    } catch { globalAlias = undefined; }
  }
  if (group.switches.length > 0) {
    try {
      const res = await callFortiOs<unknown>(transport, "GET", "/api/v2/cmdb/switch-controller/managed-switch");
      // Key each row by BOTH switch-id and sn: assets look up by serial, but
      // the mkey is often renamed (e.g. to the hostname) — a switch-id-only
      // key silently skips those switches. switch-id wins on collision.
      switchRows = new Map();
      for (const r of listResults<FortiOsManagedSwitchRow>(res)) {
        for (const key of [r?.["switch-id"], r?.sn]) {
          const k = String(key || "").trim().toUpperCase();
          if (k && !switchRows.has(k)) switchRows.set(k, r);
        }
      }
    } catch { /* surface skipped */ }
  }
  if (group.aps.length > 0) {
    try {
      const res = await callFortiOs<unknown>(transport, "GET", "/api/v2/cmdb/wireless-controller/wtp");
      const rows = listResults<FortiOsWtpRow>(res);
      // Location support gate: only trust the surface when at least one row
      // carries the attribute (see header — `location` is the AP surface).
      wtpSupportsLocation = rows.some((r) => r && Object.prototype.hasOwnProperty.call(r, "location"));
      wtpRows = new Map(
        rows
          .map((r) => [String(r?.["wtp-id"] || "").trim().toUpperCase(), r] as const)
          .filter(([k]) => k.length > 0),
      );
      if (!wtpSupportsLocation && rows.length > 0) {
        logger.info(
          { integrationId: integration.id, deviceName },
          "description_sync.wtp_location_unsupported",
        );
      }
    } catch { /* surface skipped */ }
  }

  // ── Device-level: firewall alias ──
  if (group.firewall && globalAlias !== undefined) {
    await reconcileDeviceLevel(
      integration, deviceName, transport, group.firewall,
      { kind: "fortigate-global" }, globalAlias, summary, pushedThisRun,
    );
  }
  // ── Device-level: switches ──
  for (const sw of group.switches) {
    const serial = (sw.serialNumber || "").trim().toUpperCase();
    const row = serial && switchRows ? switchRows.get(serial) : undefined;
    if (!row) continue; // switch missing from CMDB (or read failed) — skip
    await reconcileDeviceLevel(
      integration, deviceName, transport, sw,
      { kind: "managed-switch", switchId: String(row["switch-id"] || sw.serialNumber || "").trim() },
      normalizeDescription(row.description), summary, pushedThisRun,
    );
  }
  // ── Device-level: APs ──
  if (wtpSupportsLocation && wtpRows) {
    for (const ap of group.aps) {
      const serial = (ap.serialNumber || "").trim().toUpperCase();
      const row = serial ? wtpRows.get(serial) : undefined;
      if (!row) continue;
      await reconcileDeviceLevel(
        integration, deviceName, transport, ap,
        { kind: "wtp", wtpId: String(row["wtp-id"] || ap.serialNumber || "").trim() },
        normalizeDescription(row.location), summary, pushedThisRun,
      );
    }
  }

  // ── Interface-level: firewall interface overrides ──
  if (group.firewall && interfaceByName) {
    const fwHostname = group.firewall.hostname;
    for (const o of overridesByAsset.get(group.firewall.id) ?? []) {
      if (!interfaceByName.has(o.ifName)) continue; // renamed/unknown interface
      const device = interfaceByName.get(o.ifName) ?? null;
      await reconcileInterfaceOverride(
        o, device, fwHostname, deviceName,
        (value, currentDeviceValue) => pushInterfaceDescription({
          integration, deviceName, ifName: o.ifName, value, currentDeviceValue, transport,
        }),
        summary, pushedThisRun,
      );
    }
  }
  // ── Interface-level: switch port overrides ──
  if (switchRows) {
    for (const sw of group.switches) {
      const serial = (sw.serialNumber || "").trim().toUpperCase();
      const row = serial ? switchRows.get(serial) : undefined;
      if (!row) continue;
      const portDesc = new Map(
        (row.ports ?? [])
          .filter((x) => typeof x?.["port-name"] === "string" && x["port-name"])
          .map((x) => [x["port-name"] as string, normalizeDescription(x.description)]),
      );
      const switchId = String(row["switch-id"] || sw.serialNumber || "").trim();
      for (const o of overridesByAsset.get(sw.id) ?? []) {
        if (!portDesc.has(o.ifName)) continue;
        const device = portDesc.get(o.ifName) ?? null;
        await reconcileInterfaceOverride(
          o, device, sw.hostname, deviceName,
          (value, currentDeviceValue) => pushSwitchPortDescription({
            integration, deviceName, switchId, portName: o.ifName, value, currentDeviceValue, transport,
          }),
          summary, pushedThisRun,
        );
      }
    }
  }
}

async function reconcileDeviceLevel(
  integration: { id: string; type: string; config: unknown; name: string },
  deviceName: string,
  transport: Transport,
  asset: ReconcileAsset,
  target: DeviceDescTarget,
  deviceValue: string | null,
  summary: DescriptionSyncSummary,
  pushedThisRun: PushedThisRun,
): Promise<void> {
  const polaris = normalizeDescription(asset.description);
  const device = normalizeDescription(deviceValue);
  const action = decideDescriptionSync(polaris, deviceValue);

  if (action === "none") {
    // Values agree — stamp "synced" + record the value. Write-on-change:
    // skip when already synced at this exact value.
    const blob = asset.descriptionSync as { status?: string } | null;
    const valueCurrent = storedSyncedValue(asset.descriptionSync) === polaris;
    if (polaris !== null && !(blob?.status === "synced" && valueCurrent)) {
      await prisma.asset.update({
        where: { id: asset.id },
        data: { descriptionSync: { status: "synced", at: new Date().toISOString(), value: polaris } },
      }).catch(() => {});
    }
    // Confirmed-agreed this run — lets the batch mirror pass align FMG's
    // central copy even when the stored sync-state snapshot was stale.
    if (polaris !== null) pushedThisRun.device.set(asset.id, polaris);
    return;
  }
  if (action === "adopt") {
    // Polaris is empty — seed it from the device.
    await prisma.asset.update({
      where: { id: asset.id },
      data: {
        description: device,
        descriptionSync: { status: "synced", at: new Date().toISOString(), value: device },
      },
    }).catch(() => {});
    summary.adopted++;
    await logEvent({
      action: "asset.description.adopted",
      resourceType: "asset",
      resourceId: asset.id,
      resourceName: asset.hostname ?? undefined,
      actor: "system:description-sync",
      message: `Device description adopted from ${deviceName}`,
      details: { value: device },
    });
    return;
  }
  // push — Polaris has a value and the device differs (including device-side
  // edits, which Polaris-primary deliberately overwrites; audited).
  const value = polaris!;
  const result = await pushDeviceDescription({
    integration, deviceName, target, value,
    currentDeviceValue: deviceValue, transport,
  });
  await stampAssetSyncState(asset.id, result, value);
  await logDevicePushEvent({ id: asset.id, hostname: asset.hostname }, value, result, "system:description-sync");
  if (result.ok) {
    summary.pushed++;
    pushedThisRun.device.set(asset.id, value); // batch mirror pass consults this
  } else {
    summary.failed++;
  }
}

// Converged (Polaris === device): stamp "synced" + record the baseline.
// Write-on-change — skip when already synced at this exact value.
async function markOverrideSyncedIfNeeded(
  o: { id: string; syncStatus: string | null; syncedValue: string | null },
  agreedValue: string,
): Promise<void> {
  if (o.syncStatus === "synced" && o.syncedValue === agreedValue) return;
  await prisma.assetInterfaceOverride.update({
    where: { id: o.id },
    data: { syncStatus: "synced", lastSyncAt: new Date(), syncError: null, syncedValue: agreedValue },
  }).catch(() => {});
}

/**
 * Polaris-primary reconcile for one interface/switch-port override. `push`
 * closes over the surface-specific PUT (interface vs switch port). An empty
 * override is a local clear (device keeps its value) — skipped; overrides
 * only exist once an operator typed a value, so they never adopt (a device
 * comment with no override shows through as the discovered description).
 * Never throws.
 */
async function reconcileInterfaceOverride(
  o: ReconcileOverride,
  device: string | null,
  hostname: string | null,
  deviceName: string,
  push: (value: string, currentDeviceValue: string | null) => Promise<DescPushResult>,
  summary: DescriptionSyncSummary,
  pushedThisRun: PushedThisRun,
): Promise<void> {
  const polaris = normalizeDescription(o.description);
  if (polaris === null) return; // empty override — local clear semantics
  const action = decideDescriptionSync(polaris, device);

  if (action === "none") {
    await markOverrideSyncedIfNeeded(o, polaris);
    // Confirmed-agreed this run — consulted by the batch mirror pass.
    pushedThisRun.port.set(portKey(o.assetId, o.ifName), polaris);
    return;
  }
  // push — polaris is non-null here, so "adopt" is unreachable.
  const result = await push(polaris, device);
  await stampOverrideSyncState(o.id, result, polaris);
  await logInterfacePushEvent({ id: o.assetId, hostname }, o.ifName, polaris, result, "system:description-sync");
  if (result.ok) {
    summary.pushed++;
    pushedThisRun.port.set(portKey(o.assetId, o.ifName), polaris); // batch mirror pass consults this
  } else {
    summary.failed++;
  }
}

/**
 * Central-management batch heal (see the FMG mirror section header): one GET
 * of the ADOM-level table per centrally-managed class, then a `set` per row
 * whose FMG-side value differs from a Polaris value the device already agrees
 * on. "Device agrees" = pushed successfully this run (pushedThisRun), or the
 * stored sync state says synced at the current Polaris value. Never throws.
 */
async function mirrorCentralDbDrift(
  integration: { id: string; type: string; config: unknown; name: string },
  syncFlags: DescriptionSyncFlags,
  assets: ReconcileAsset[],
  overridesByAsset: Map<string, ReconcileOverride[]>,
  pushedThisRun: PushedThisRun,
  summary: DescriptionSyncSummary,
): Promise<void> {
  try {
    // A class is mirrored only when it is centrally managed AND its own
    // description-sync toggle is on.
    const central = centralFlags(integration.config);
    const flags = { wtp: central.wtp && syncFlags.fortiap, fsw: central.fsw && syncFlags.fortiswitch };
    if (!flags.wtp && !flags.fsw) return;
    const adom = fmgAdom(integration.config);

    // The Polaris value the device is known to hold, or null when the device
    // hasn't (yet) agreed — a diverged/failed row must not be mirrored, or
    // FMG would install a value the device never accepted.
    const agreedDeviceValue = (a: ReconcileAsset): string | null => {
      const fromRun = pushedThisRun.device.get(a.id);
      if (fromRun !== undefined) return fromRun;
      const polaris = normalizeDescription(a.description);
      if (polaris === null) return null;
      const blob = a.descriptionSync as { status?: string } | null;
      if (blob?.status !== "synced") return null;
      return storedSyncedValue(a.descriptionSync) === polaris ? polaris : null;
    };

    if (flags.wtp) {
      // The per-AP rows AP Manager displays live in each controller
      // FortiGate's device DB (see section header) — group APs by controller
      // and read one table per controller.
      const apsByController = new Map<string, ReconcileAsset[]>();
      for (const a of assets) {
        const topo = (a.fortinetTopology ?? {}) as TopologyBlob;
        if (topo.role !== "fortiap") continue;
        const ctrl = (topo.controllerFortigate || "").trim();
        if (!ctrl) continue;
        const list = apsByController.get(ctrl) ?? [];
        list.push(a);
        apsByController.set(ctrl, list);
      }
      for (const [deviceName, aps] of apsByController) {
        const res = await fmgAdomOp(integration, "get", `/pm/config/device/${deviceName}/vdom/root/wireless-controller/wtp`);
        if (!res.ok || !Array.isArray(res.data)) continue;
        const byKey = new Map<string, Record<string, unknown>>();
        for (const r of res.data as Array<Record<string, unknown>>) {
          // Key by wtp-id AND name — same defensive dual-keying as the
          // device-side switch map.
          for (const k of [r?.["wtp-id"], r?.name]) {
            const key = String(k || "").trim().toUpperCase();
            if (key && !byKey.has(key)) byKey.set(key, r);
          }
        }
        for (const a of aps) {
          const agreed = agreedDeviceValue(a);
          if (agreed === null) continue;
          const row = byKey.get(String(a.serialNumber || "").trim().toUpperCase());
          if (!row) continue; // AP not in FMG's device DB — nothing to align
          if (normalizeDescription(row.location) === agreed) continue;
          const mkey = String(row["wtp-id"] || a.serialNumber || "").trim();
          const result = await mirrorToFmg(integration, { kind: "wtp", wtpId: mkey, deviceName }, agreed);
          if (result.ok) summary.fmgMirrored++; else summary.fmgMirrorFailed++;
          await logFmgMirrorEvent({ id: a.id, hostname: a.hostname }, { scope: "device", value: agreed, result });
        }
      }
    }

    if (flags.fsw) {
      const res = await fmgAdomOp(integration, "get", `/pm/config/adom/${adom}/obj/fsp/managed-switch`);
      if (res.ok && Array.isArray(res.data)) {
        const rows = res.data as FortiOsManagedSwitchRow[];
        for (const a of assets) {
          if (((a.fortinetTopology ?? {}) as TopologyBlob).role !== "fortiswitch") continue;
          const serial = String(a.serialNumber || "").trim();
          if (!serial) continue;
          const row = matchManagedSwitchRow(rows, serial);
          if (!row) continue;
          const mkey = String(row["switch-id"] || serial).trim();

          // Device-level switch description.
          const agreed = agreedDeviceValue(a);
          if (agreed !== null && normalizeDescription(row.description) !== agreed) {
            const result = await mirrorToFmg(integration, { kind: "managed-switch", switchId: mkey }, agreed);
            if (result.ok) summary.fmgMirrored++; else summary.fmgMirrorFailed++;
            await logFmgMirrorEvent({ id: a.id, hostname: a.hostname }, { scope: "device", value: agreed, result });
          }

          // Port descriptions (interface overrides on the switch asset).
          const fmgPortDesc = new Map(
            (row.ports ?? [])
              .filter((x) => typeof x?.["port-name"] === "string" && x["port-name"])
              .map((x) => [x["port-name"] as string, normalizeDescription(x.description)]),
          );
          for (const o of overridesByAsset.get(a.id) ?? []) {
            const fromRun = pushedThisRun.port.get(portKey(o.assetId, o.ifName));
            const polaris = normalizeDescription(o.description);
            const agreedPort = fromRun !== undefined
              ? fromRun
              : (polaris !== null && o.syncStatus === "synced" && normalizeDescription(o.syncedValue) === polaris ? polaris : null);
            if (agreedPort === null) continue;
            if (!fmgPortDesc.has(o.ifName)) continue; // port absent from the central row
            if (fmgPortDesc.get(o.ifName) === agreedPort) continue;
            const result = await mirrorToFmg(integration, { kind: "switch-port", switchId: mkey, portName: o.ifName }, agreedPort);
            if (result.ok) summary.fmgMirrored++; else summary.fmgMirrorFailed++;
            await logFmgMirrorEvent({ id: o.assetId, hostname: a.hostname }, { scope: "interface", ifName: o.ifName, value: agreedPort, result });
          }
        }
      }
    }
  } catch (err) {
    logger.warn(
      { integrationId: integration.id, err: err instanceof Error ? err.message : String(err) },
      "description_sync.fmg_mirror_pass_failed",
    );
  }
}
