/**
 * src/services/networkScanService.ts — saved network **Discovery** CRUD, run
 * lifecycle, and adoption.
 *
 * The runner (networkScanRunner.ts) does the sweeping; this owns everything
 * around it: the saved configuration, dispatching a run, cancelling one, and
 * turning chosen responders into assets.
 *
 * Two boundaries worth stating up front, because they are what the RBAC design
 * rests on (business rule 34a):
 *
 *   - **Running creates nothing.** `triggerScan` writes a run row and hands it
 *     to a worker. No Asset, no AssetSource, no pin. That is what lets a
 *     `networkScan`-only role sweep a range without being able to add anything
 *     to inventory.
 *   - **Adoption is the only writer of assets here**, and its route chains
 *     `assets:write` on top of `networkScan:write`.
 *
 * A third boundary since the visibility cutover: a Discovery is **private or
 * public**, the SavedDashboard / SavedTableFilter model. Every read and every
 * run resolves through `assertScanVisible`, and an invisible row answers 404
 * rather than 403 (the `GET /alerts/:id` posture — that an id exists is itself
 * something the caller has no business learning). Ownership for EDIT and
 * DELETE is decided by the route, which is where `req.permissionLevel` lives.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import { publishScanJob } from "./queueService.js";
import { expandScanTargets, type ScanTarget, SCAN_MAX_TARGETS } from "../utils/cidr.js";
import { resolveAssetTypeCached } from "../utils/assetTypeMatch.js";
import {
  runScan,
  parseStoredMethods,
  parseStoredTargets,
  loadKnownAddresses,
  type ScanHit,
  type ScanMethod,
} from "./networkScanRunner.js";
import { resolvePinnedInterfaces, splitPinsByProvenance, type AutoMonitorSelection } from "./autoMonitorInterfacesService.js";
import { resolvePinnedStorage, type AutoMonitorStorageSelection } from "./autoMonitorStorageService.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * The auto-monitor selection a Discovery applies to what it adopts, keyed by
 * the polling method that identified the device.
 *
 * Keyed by METHOD rather than stored flat because what can be pinned depends
 * on what answered: an SNMP responder reported real interface names during the
 * scan, an ICMP-only one reported nothing, and an SSH/WinRM host only reports
 * interfaces once an agent runs. One selection for all of them would be a
 * selection that means something different per group.
 */
interface ScanAutoMonitor {
  [method: string]: {
    interfaces?: AutoMonitorSelection;
    storage?: AutoMonitorStorageSelection;
  } | undefined;
}

export type ScanVisibility = "private" | "public";

export interface ScanRecord {
  id: string;
  name: string;
  description: string | null;
  visibility: ScanVisibility;
  targets: ScanTarget[];
  methods: ScanMethod[];
  autoMonitor: ScanAutoMonitor | null;
  ownerId: string | null;
  /** Username snapshot of the author — survives the account (SetNull owner). */
  createdBy: string | null;
  /** True when the CALLER owns it. Drives the UI's edit/delete affordances. */
  isOwner: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastRunAt: Date | null;
}

export interface SaveScanInput {
  name: string;
  description?: string | null;
  visibility?: ScanVisibility;
  targets: ScanTarget[];
  methods: ScanMethod[];
  autoMonitor?: ScanAutoMonitor | null;
}

/**
 * Who is asking. `id` is null for a bearer token (no user identity) and for
 * any caller resolved outside a session — such a caller sees public rows only
 * and owns nothing, which is also why it may not create a PRIVATE Discovery
 * (it would be writing a row it could never read back).
 */
export interface ScanViewer {
  id: string | null;
  username: string;
  /**
   * `networkScan:fullwrite` — the housekeeping level. It already edits and
   * deletes other people's PUBLIC Discoveries; it also sees a private one that
   * has NO owner (business rule 157(d)). Never someone else's private one.
   */
  housekeeping?: boolean;
}

// ─── Caps ───────────────────────────────────────────────────────────────────

/** Target ROWS an operator may type. Addresses are capped separately. */
export const MAX_SCAN_TARGET_ROWS = 50;
/** Credentials to try per method. A community list, not a dictionary attack. */
export const MAX_CREDENTIALS_PER_METHOD = 10;
/** Addresses adoptable in one call — the assets-route bulk-cap precedent. */
export const MAX_ADOPT_PER_CALL = 500;
/** How stale a run's heartbeat may be before it's presumed dead. */
const SCAN_RUN_STALE_MS = 3 * 60_000;

/**
 * `requestActor(req)` returns undefined for a caller with neither a session
 * username nor a token name. `NetworkScanRun.actor` is NOT NULL and an audit
 * row with a blank actor is worse than one naming the gap, so normalize once
 * here rather than in six call sites.
 */
function normalizeActor(actor?: string): string {
  return (actor ?? "").trim() || "unknown";
}

// ─── Shaping ────────────────────────────────────────────────────────────────

type ScanRow = {
  id: string; name: string; description: string | null; visibility: string;
  targets: unknown; methods: unknown; autoMonitor: unknown;
  ownerId: string | null; createdBy: string | null;
  createdAt: Date; updatedAt: Date; lastRunAt: Date | null;
};

function toRecord(row: ScanRow, viewerId: string | null): ScanRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: normalizeVisibility(row.visibility),
    targets: parseStoredTargets(row.targets),
    methods: parseStoredMethods(row.methods),
    autoMonitor: (row.autoMonitor as ScanAutoMonitor | null) ?? null,
    ownerId: row.ownerId,
    createdBy: row.createdBy,
    isOwner: ownsScan(row, viewerId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastRunAt: row.lastRunAt,
  };
}

// ─── Visibility ─────────────────────────────────────────────────────────────
//
// Pure and exported: the three predicates below are the whole access model,
// and they are the part worth unit-testing without a database.

/** Anything not literally "public" is private — an unknown value never opens up. */
export function normalizeVisibility(raw: unknown): ScanVisibility {
  return raw === "public" ? "public" : "private";
}

/**
 * Does `viewerId` own this row? A NULL owner (orphan, or a token-created row)
 * is owned by NOBODY — never by the caller who also happens to have no id.
 */
export function ownsScan(row: { ownerId: string | null }, viewerId: string | null): boolean {
  return row.ownerId != null && viewerId != null && row.ownerId === viewerId;
}

/**
 * Own it, or it is published — or it is an ORPHAN and the viewer does the
 * housekeeping (business rule 157(d)).
 *
 * `NetworkScan.owner` is `onDelete: SetNull`, so deleting a user used to leave
 * their private Discoveries with no owner and still private: visible to nobody,
 * the administrator included, with their targets, credential ids and every
 * run's hits still in the database and no way to list, open or delete them. A
 * private row with no owner is nobody's secret any more; `networkScan:fullwrite`
 * — which already manages rows that are not its own — can see it, so it can be
 * republished or deleted. A private row that still HAS an owner stays private
 * to that owner, whatever the viewer's level.
 */
export function scanVisibleTo(
  row: { ownerId: string | null; visibility: string },
  viewerId: string | null,
  housekeeping = false,
): boolean {
  if (normalizeVisibility(row.visibility) === "public" || ownsScan(row, viewerId)) return true;
  return housekeeping && row.ownerId == null;
}

/**
 * 404, not 403, for a row the caller cannot see (the `GET /alerts/:id`
 * posture): a private Discovery's existence is itself something another
 * operator has no business learning, and the message must not differ from the
 * one a genuinely absent id gets.
 */
function assertScanVisible(
  row: { ownerId: string | null; visibility: string },
  viewerId: string | null,
  housekeeping = false,
): void {
  if (!scanVisibleTo(row, viewerId, housekeeping)) throw new AppError(404, "Discovery not found");
}

/**
 * Validate a saved configuration.
 *
 * Deliberately NOT a Zod schema in the route: the same checks have to hold for
 * an imported `.discovery.json`, and the target/credential caps are properties
 * of the feature rather than of one HTTP body.
 */
export function validateScanInput(input: SaveScanInput): string | null {
  const name = (input.name ?? "").trim();
  if (!name) return "Name is required.";
  if (name.length > 200) return "Name is too long.";

  const targets = input.targets ?? [];
  if (!targets.length) return "Add at least one IP range, subnet or address to scan.";
  if (targets.length > MAX_SCAN_TARGET_ROWS) return `At most ${MAX_SCAN_TARGET_ROWS} target rows.`;

  // Expanding here is what turns "10.0.0.0/8" into an error at SAVE time
  // rather than a run that fails minutes later.
  const expanded = expandScanTargets(targets);
  const badRow = expanded.perTarget.find((t) => t.error);
  if (badRow) return badRow.error!;
  if (!expanded.total) {
    return expanded.dropped
      ? "Every address in those targets is excluded (loopback, link-local, multicast or reserved)."
      : "Those targets expand to no addresses.";
  }

  const methods = input.methods ?? [];
  if (!methods.length) return "Select at least one probe method.";
  for (const m of methods) {
    const ids = m.credentialIds ?? [];
    if (m.type === "icmp") {
      // Not a formality: an ICMP "credential" would be a stored secret nothing
      // reads, and the credential store has no icmp type to hold it.
      if (ids.length) return "ICMP takes no credentials.";
      continue;
    }
    if (!ids.length) return `Select at least one credential for ${m.type}.`;
    if (ids.length > MAX_CREDENTIALS_PER_METHOD) {
      return `At most ${MAX_CREDENTIALS_PER_METHOD} credentials per method.`;
    }
    if (new Set(ids).size !== ids.length) return `Duplicate credential selected for ${m.type}.`;
  }
  return null;
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

/**
 * Discoveries one caller may see: everything they own (private and public)
 * plus every OTHER operator's public one. A viewer with no id (bearer token)
 * gets the public set, and nothing reads as owned.
 */
export async function listScans(
  viewerId: string | null,
  housekeeping = false,
): Promise<(ScanRecord & { latestRun: RunSummary | null })[]> {
  // The same three arms as scanVisibleTo: published, mine, or an orphan the
  // housekeeper may see (rule 157(d)).
  const or: Record<string, unknown>[] = [{ visibility: "public" }];
  if (viewerId) or.push({ ownerId: viewerId });
  if (housekeeping) or.push({ ownerId: null });
  const rows = await prisma.networkScan.findMany({
    where: { OR: or },
    orderBy: { name: "asc" },
  });
  // One query for every Discovery's newest run rather than N+1 — the list is
  // small but this is also the reattach path, which runs on every list open.
  const runs = await prisma.networkScanRun.findMany({
    where: { scanId: { in: rows.map((r) => r.id) } },
    orderBy: { createdAt: "desc" },
  });
  const newest = new Map<string, (typeof runs)[number]>();
  for (const run of runs) if (!newest.has(run.scanId)) newest.set(run.scanId, run);
  return rows.map((row) => ({
    ...toRecord(row, viewerId),
    latestRun: newest.has(row.id) ? summarizeRun(newest.get(row.id)!) : null,
  }));
}

/** One Discovery, scoped to what the caller may see. */
export async function getScan(id: string, viewerId: string | null, housekeeping = false): Promise<ScanRecord> {
  return toRecord(await loadVisible(id, viewerId, housekeeping), viewerId);
}

/** Load a row the caller may see, or 404. The read every other verb starts from. */
async function loadVisible(id: string, viewerId: string | null, housekeeping = false): Promise<ScanRow> {
  const row = await prisma.networkScan.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Discovery not found");
  assertScanVisible(row, viewerId, housekeeping);
  return row;
}

/**
 * Load a row for a MUTATION the route has already gated. Returns the raw row so
 * the route can apply its own ownership rule (`ownsScan` or fullwrite) — that
 * decision needs `req.permissionLevel`, which only the route has.
 */
export async function getScanForWrite(id: string, viewerId: string | null, housekeeping = false): Promise<ScanRow> {
  return loadVisible(id, viewerId, housekeeping);
}

/**
 * A name is unique within ONE owner's set. Checked against the caller's own
 * rows only, so a private Discovery someone else keeps can neither block a
 * name nor be inferred from a 409.
 */
async function assertNameFree(name: string, ownerId: string | null, exceptId?: string): Promise<void> {
  const clash = await prisma.networkScan.findFirst({
    where: { name, ownerId, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (clash) throw new AppError(409, `You already have a Discovery named "${name}".`);
}

/**
 * A caller with no user identity (a bearer token) has no private bucket: a
 * row it created as `private` would be one it could never read back, and no
 * other caller could see it either. Refuse rather than silently publish.
 */
function assertVisibilityStorable(visibility: ScanVisibility, viewer: ScanViewer): void {
  if (visibility === "private" && viewer.id === null) {
    throw new AppError(400, "A private Discovery needs a signed-in owner — save it as shared instead.");
  }
}

export async function createScan(input: SaveScanInput, viewer: ScanViewer): Promise<ScanRecord> {
  const who = normalizeActor(viewer.username);
  const problem = validateScanInput(input);
  if (problem) throw new AppError(400, problem);
  const visibility = normalizeVisibility(input.visibility ?? "private");
  assertVisibilityStorable(visibility, viewer);
  const name = input.name.trim();
  await assertNameFree(name, viewer.id);
  const row = await prisma.networkScan.create({
    data: {
      name,
      description: input.description?.trim() || null,
      visibility,
      targets: input.targets as unknown as object,
      methods: input.methods as unknown as object,
      autoMonitor: (input.autoMonitor ?? null) as unknown as object,
      ownerId: viewer.id,
      createdBy: who,
    },
  });
  await logEvent({
    action: "network_scan.created",
    resourceType: "network_scan",
    resourceId: row.id,
    resourceName: row.name,
    actor: who,
    message: `Discovery "${row.name}" created (${visibility})`,
    details: { targets: input.targets.length, methods: input.methods.map((m) => m.type), visibility },
  });
  return toRecord(row, viewer.id);
}

/**
 * Update. The route has already established that the caller may write THIS row
 * (owner, or fullwrite housekeeping); `existing` is passed in so it isn't read
 * twice. The name check runs against the ROW'S owner, not the caller's — an
 * admin editing someone else's Discovery must not collide it with their own.
 */
export async function updateScan(
  existing: ScanRow,
  input: SaveScanInput,
  viewer: ScanViewer,
): Promise<ScanRecord> {
  const who = normalizeActor(viewer.username);
  const problem = validateScanInput(input);
  if (problem) throw new AppError(400, problem);
  const visibility = normalizeVisibility(input.visibility ?? existing.visibility);
  // Un-sharing an ORPHAN would strand it: nobody owns it, so nobody could see
  // it again. Only a row with a real owner can go private.
  if (visibility === "private" && existing.ownerId === null) {
    throw new AppError(400, "This Discovery has no owner, so it cannot be made private.");
  }
  const name = input.name.trim();
  if (name !== existing.name) await assertNameFree(name, existing.ownerId, existing.id);
  const row = await prisma.networkScan.update({
    where: { id: existing.id },
    data: {
      name,
      description: input.description?.trim() || null,
      visibility,
      targets: input.targets as unknown as object,
      methods: input.methods as unknown as object,
      autoMonitor: (input.autoMonitor ?? null) as unknown as object,
    },
  });
  await logEvent({
    action: "network_scan.updated",
    resourceType: "network_scan",
    resourceId: row.id,
    resourceName: row.name,
    actor: who,
    message: `Discovery "${row.name}" updated`,
    details: {
      visibility,
      previousVisibility: existing.visibility !== visibility ? existing.visibility : undefined,
      previousName: existing.name !== name ? existing.name : undefined,
      owner: existing.createdBy ?? undefined,
    },
  });
  return toRecord(row, viewer.id);
}

export async function deleteScan(id: string, actor?: string): Promise<void> {
  const who = normalizeActor(actor);
  const existing = await prisma.networkScan.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "Discovery not found");
  if (await isScanRunning(id)) {
    throw new AppError(409, "That Discovery is running. Cancel it before deleting.");
  }
  // The run rows cascade (they are history OF this Discovery, not independent).
  await prisma.networkScan.delete({ where: { id } });
  await logEvent({
    action: "network_scan.deleted",
    resourceType: "network_scan",
    resourceId: id,
    resourceName: existing.name,
    actor: who,
    level: "warning",
    message: `Discovery "${existing.name}" deleted`,
  });
}

// ─── Runs ───────────────────────────────────────────────────────────────────

export interface RunSummary {
  id: string;
  scanId: string;
  status: string;
  actor: string;
  error: string | null;
  totalTargets: number;
  droppedTargetCount: number;
  scannedCount: number;
  hitCount: number;
  skippedKnownCount: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  /** True while the row says running/queued AND its heartbeat is fresh. */
  active: boolean;
  /** Running, but the worker stopped writing — the run is presumed dead. */
  stalled: boolean;
}

function summarizeRun(row: {
  id: string; scanId: string; status: string; actor: string; error: string | null;
  totalTargets: number; droppedTargetCount: number; scannedCount: number; hitCount: number;
  skippedKnownCount: number; startedAt: Date | null; finishedAt: Date | null;
  createdAt: Date; workerHeartbeatAt: Date | null;
}): RunSummary {
  const inFlight = row.status === "running" || row.status === "queued";
  const beat = row.workerHeartbeatAt?.getTime() ?? row.createdAt.getTime();
  const stale = Date.now() - beat > SCAN_RUN_STALE_MS;
  return {
    id: row.id,
    scanId: row.scanId,
    status: row.status,
    actor: row.actor,
    error: row.error,
    totalTargets: row.totalTargets,
    droppedTargetCount: row.droppedTargetCount,
    scannedCount: row.scannedCount,
    hitCount: row.hitCount,
    skippedKnownCount: row.skippedKnownCount,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
    active: inFlight && !stale,
    stalled: inFlight && stale,
  };
}

/** Is a run in flight for this Discovery? A stalled row does not count. */
async function isScanRunning(scanId: string): Promise<boolean> {
  const row = await prisma.networkScanRun.findFirst({
    where: { scanId, status: { in: ["queued", "running"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return false;
  return summarizeRun(row).active;
}

/**
 * Start a run.
 *
 * Copies `triggerDiscovery`'s dispatch exactly: publish to the worker, and when
 * pg-boss isn't live run it in-process detached. That fallback is mandatory —
 * `Setting.monitor.queueMode` defaults to cursor, so on a default install
 * nothing would ever execute without it.
 */
export async function triggerScan(
  scanId: string,
  viewer: ScanViewer,
): Promise<RunSummary> {
  const who = normalizeActor(viewer.username);
  // Visibility, NOT ownership: running someone else's SHARED Discovery is the
  // whole point of publishing one. Ownership only governs editing it.
  const scan = await loadVisible(scanId, viewer.id, viewer.housekeeping);

  const problem = validateScanInput({
    name: scan.name,
    targets: parseStoredTargets(scan.targets),
    methods: parseStoredMethods(scan.methods),
  });
  if (problem) throw new AppError(400, problem);

  if (await isScanRunning(scanId)) {
    throw new AppError(409, "That Discovery is already running.");
  }

  const run = await prisma.networkScanRun.create({
    data: { scanId, status: "queued", actor: who, workerHeartbeatAt: new Date() },
  });

  const enqueued = await publishScanJob(run.id, scanId, who).catch(() => false);
  if (!enqueued) {
    // Detached on purpose: the route answers 202 and the wizard watches the
    // run row. An await here would hold the request open for the whole sweep.
    void runScan(run.id, who).catch((err) => {
      logger.error({ err, runId: run.id }, "in-process network scan failed");
    });
  }
  return summarizeRun(run);
}

/** Ask a run to stop. The worker notices on its next throttle tick. */
export async function cancelRun(runId: string, viewer: ScanViewer): Promise<RunSummary> {
  const who = normalizeActor(viewer.username);
  const run = await loadVisibleRun(runId, viewer.id, viewer.housekeeping);
  if (run.status !== "queued" && run.status !== "running") {
    // Not an error: the operator clicked Cancel as it finished.
    return summarizeRun(run);
  }
  const updated = await prisma.networkScanRun.update({
    where: { id: runId },
    data: { cancelRequested: true },
  });
  await logEvent({
    action: "network_scan.cancel_requested",
    resourceType: "network_scan",
    resourceId: run.scanId,
    resourceName: run.scan.name,
    actor: who,
    level: "warning",
    message: `Cancel requested for Discovery "${run.scan.name}"`,
  });
  return summarizeRun(updated);
}

export interface RunDetail extends RunSummary {
  hits: ScanHit[];
  scanName: string;
}

/**
 * A run inherits its Discovery's visibility — the hits ARE the recon material,
 * so a run row must never be a way around a private Discovery. 404 like its
 * parent, and for the same reason.
 */
async function loadVisibleRun(runId: string, viewerId: string | null, housekeeping = false) {
  const run = await prisma.networkScanRun.findUnique({ where: { id: runId }, include: { scan: true } });
  if (!run) throw new AppError(404, "Run not found");
  if (!scanVisibleTo(run.scan, viewerId, housekeeping)) throw new AppError(404, "Run not found");
  return run;
}

export async function getRun(runId: string, viewerId: string | null, housekeeping = false): Promise<RunDetail> {
  const run = await loadVisibleRun(runId, viewerId, housekeeping);
  return {
    ...summarizeRun(run),
    hits: Array.isArray(run.hits) ? (run.hits as unknown as ScanHit[]) : [],
    scanName: run.scan.name,
  };
}

// ─── Target preview ─────────────────────────────────────────────────────────

export interface TargetPreview {
  total: number;
  dropped: number;
  droppedBy: { invalid: number; excluded: number; cap: number };
  perTarget: { count: number; error?: string }[];
  /**
   * Deliberately NO address list. The preview answers "did I type what I
   * meant?", and the COUNT plus the per-target verdicts answer that; shipping
   * a sample (or a range summary of one) was noise on every keystroke.
   */
  /** How many of those addresses inventory already carries. */
  alreadyKnown: number;
  cap: number;
}

/**
 * Resolve operator-typed targets without touching the network.
 *
 * Read-level on purpose: it is pure IP math plus one indexed read, and a role
 * allowed to look at a Discovery must be able to see what its targets mean.
 */
export async function previewTargets(targets: ScanTarget[]): Promise<TargetPreview> {
  const expanded = expandScanTargets(targets ?? []);
  let alreadyKnown = 0;
  if (expanded.total) {
    const known = await loadKnownAddresses();
    for (const a of expanded.addresses) if (known.has(a)) alreadyKnown += 1;
  }
  return {
    total: expanded.total,
    dropped: expanded.dropped,
    droppedBy: expanded.droppedBy,
    perTarget: expanded.perTarget.map((t) => ({ count: t.count, ...(t.error ? { error: t.error } : {}) })),
    alreadyKnown,
    cap: SCAN_MAX_TARGETS,
  };
}

// ─── Adoption ───────────────────────────────────────────────────────────────

export interface AdoptResult {
  created: number;
  skipped: { address: string; reason: string }[];
  assetIds: string[];
}

/**
 * Map a hit's identity onto an asset type.
 *
 * Still deliberately shallow, and still `other` unless the device's own
 * description says otherwise in as many words — guessing "switch" from a
 * vendor name is exactly the kind of inference that is right often enough to
 * look correct and wrong the rest of the time. What changed is WHERE the
 * words live: the keyword ladder moved onto the AssetTypeDef registry as
 * operator-editable rules in the `scan` context (`utils/assetTypeMatch.ts`),
 * seeded to reproduce this function exactly. A site that scans a floor full of
 * badge readers can now name them once instead of retyping each adoption.
 *
 * The context split matters here: these patterns match a scanned device's own
 * self-description, so they stay off the directory path, where the same words
 * appearing in an AD computer's OS string would mean nothing.
 */
export function assetTypeForHit(hit: ScanHit): string {
  return (
    resolveAssetTypeCached(
      {
        os: hit.identity?.os ?? null,
        hostname: hit.identity?.hostname ?? null,
        // Manufacturer and model are passed as their own facts, not folded
        // into the description, because a rule wants to say "Axis
        // Communications" without also matching a device that merely
        // mentions Axis in its sysDescr. `MATCH_FIELDS` has carried both
        // since the registry cutover; a scan only recently had values to put
        // in them (`utils/snmpDescrIdentity.ts`), which is why they were
        // omitted here. The seeded `any` clauses widen with them — none of
        // the words they look for (fortigate / switch / router / printer)
        // appear in a vendor name or an AXIS model, so no existing hit
        // re-types.
        manufacturer: hit.identity?.manufacturer ?? null,
        model: hit.identity?.model ?? null,
        // The vendor's own words for what it is. The precise fact for typing
        // equipment no directory has heard of — one `productType contains
        // camera` rule instead of a regex over `any`, which also reads
        // hostname and typed an NVR called CAMERA-NVR-01 as a camera.
        productType: hit.identity?.productType ?? null,
      },
      "scan",
    ) ?? "other"
  );
}

/** Which polling method a hit's monitoring selection should be read from. */
export function methodKeyForHit(hit: ScanHit): string {
  return hit.identifiedBy ?? (hit.respondedTo.includes("icmp") ? "icmp" : "unknown");
}

/**
 * Turn chosen responders into assets.
 *
 * Assets are created exactly like the manual `POST /assets` path — fields
 * inline, `ipSource="manual"`, and the `db.ts` extension minting the `manual`
 * AssetSource row. There is deliberately **no `network-scan` sourceKind**:
 * `projectAssetFromSources` has zero rules for a kind outside its union, so
 * such a row would contribute nothing to the projection. Provenance goes
 * where discovery already puts it, the
 * one-time notes boilerplate plus an audit Event.
 *
 * Pins are resolved by the SAME pure resolvers the integration auto-monitor
 * pass uses, against the inventory the scan collected, so a selection means the
 * same thing here as it does there.
 */
export async function adoptHits(
  runId: string,
  addresses: string[],
  viewer: ScanViewer,
): Promise<AdoptResult> {
  const who = normalizeActor(viewer.username);
  const run = await loadVisibleRun(runId, viewer.id, viewer.housekeeping);
  const wanted = Array.from(new Set((addresses ?? []).map((a) => a.trim()).filter(Boolean)));
  if (!wanted.length) throw new AppError(400, "Select at least one address to add.");
  if (wanted.length > MAX_ADOPT_PER_CALL) {
    throw new AppError(400, `At most ${MAX_ADOPT_PER_CALL} addresses at a time (you selected ${wanted.length}).`);
  }

  const hits = (Array.isArray(run.hits) ? (run.hits as unknown as ScanHit[]) : []);
  const byAddress = new Map(hits.map((h) => [h.address, h]));
  const autoMonitor = (run.scan.autoMonitor as ScanAutoMonitor | null) ?? null;

  // Re-check inventory at adopt time, not scan time: minutes or hours may have
  // passed and another operator (or a discovery run) may have created the
  // device in between. This is the check that keeps the duplicate out.
  const known = await loadKnownAddresses();

  const skipped: { address: string; reason: string }[] = [];
  const assetIds: string[] = [];

  for (const address of wanted) {
    const hit = byAddress.get(address);
    if (!hit) { skipped.push({ address, reason: "Not a responder in this run" }); continue; }
    if (known.has(address)) { skipped.push({ address, reason: "An asset already carries this address" }); continue; }

    const selection = autoMonitor?.[methodKeyForHit(hit)] ?? undefined;
    let monitoredInterfaces: string[] = [];
    let monitoredIpsecTunnels: string[] = [];
    let monitoredStorage: string[] = [];
    if (selection?.interfaces && hit.interfaces?.length) {
      const picked = resolvePinnedInterfaces(
        selection.interfaces,
        hit.interfaces.map((i) => ({ ifName: i.ifName, ifType: i.ifType, operStatus: i.operStatus })),
      );
      const split = splitPinsByProvenance(
        picked,
        hit.interfaces.map((i) => ({ ifName: i.ifName, ifType: i.ifType, operStatus: i.operStatus })),
      );
      monitoredInterfaces = split.interfaces;
      monitoredIpsecTunnels = split.ipsecTunnels;
    }
    if (selection?.storage && hit.storage?.length) {
      monitoredStorage = resolvePinnedStorage(
        selection.storage,
        hit.storage.map((s) => ({ mountPath: s.mountPath })),
      );
    }

    try {
      const asset = await prisma.asset.create({
        data: {
          hostname: hit.identity?.hostname || address,
          ipAddress: address,
          ipSource: "manual",
          assetType: assetTypeForHit(hit),
          status: "active",
          manufacturer: hit.identity?.manufacturer ?? null,
          // Only set where the vendor's own sysDescr format stated them, so a
          // device that published no readable layout keeps these empty rather
          // than carrying a slice of its description as a model number.
          model: hit.identity?.model ?? null,
          osVersion: hit.identity?.osVersion ?? null,
          // What the device calls itself — the fact a device-type rule can
          // match precisely (utils/assetTypeMatch.ts), rather than a regex
          // over the whole self-description.
          productType: hit.identity?.productType ?? null,
          // The RAW sysDescr, but only for a device whose layout we could NOT
          // read. Where we parsed it, the pieces are in model / osVersion /
          // productType and the whole string would just print over the top of
          // them in the asset page's "OS / Firmware" row. It is not lost: the
          // monitor's first identity read records it verbatim on the
          // `snmp-sysdescr` AssetSource, which is where what a source SAID
          // belongs. Note `assetTypeForHit` is still handed the full string
          // below, so typing keeps matching exactly what it matched before.
          os: hit.identity?.model || hit.identity?.productType
            ? null
            : hit.identity?.os ?? null,
          snmpLocation: hit.identity?.snmpLocation ?? null,
          notes: `Found by Polaris Discovery "${run.scan.name}" at ${address}` +
            (hit.identifiedBy ? ` (answered ${hit.identifiedBy})` : ""),
          createdBy: who,
          statusChangedAt: new Date(),
          statusChangedBy: who,
          ...(monitoredInterfaces.length ? { monitoredInterfaces } : {}),
          ...(monitoredIpsecTunnels.length ? { monitoredIpsecTunnels } : {}),
          ...(monitoredStorage.length ? { monitoredStorage } : {}),
        },
        select: { id: true },
      });
      assetIds.push(asset.id);
      // Guard the rest of THIS call against a duplicate selection.
      known.add(address);
    } catch (err) {
      skipped.push({ address, reason: err instanceof Error ? err.message : "Create failed" });
    }
  }

  await logEvent({
    action: "network_scan.adopted",
    resourceType: "network_scan",
    resourceId: run.scanId,
    resourceName: run.scan.name,
    actor: who,
    message:
      `Added ${assetIds.length} asset(s) from Discovery "${run.scan.name}"` +
      (skipped.length ? `, ${skipped.length} skipped` : ""),
    details: { created: assetIds.length, skipped },
  });

  return { created: assetIds.length, skipped, assetIds };
}
