/**
 * src/api/routes/networkScans.ts — saved network **Discovery** CRUD + runs.
 *
 * Mounted at /api/v1/network-scans behind a `networkScan:read` FLOOR on the
 * whole router, with per-route escalation above it. The floor is the `/map`
 * mount precedent: three of its read routes were auth-only until 2026-08, so
 * any session or token could enumerate every FortiGate's coordinates and
 * topology regardless of role. A Discovery's targets and results are the same
 * kind of recon material.
 *
 *   GET    /                    networkScan:read    (own + public, each one's newest run)
 *   POST   /preview-targets     networkScan:read    (pure IP math, no packets)
 *   GET    /runs/:runId         networkScan:read    (progress + hits)
 *   GET    /:id                 networkScan:read
 *   POST   /                    networkScan:write
 *   PUT    /:id                 networkScan:write   (own; else fullwrite)
 *   DELETE /:id                 networkScan:write   (own; else fullwrite)
 *   POST   /:id/run             networkScan:write   (202 + the run; any VISIBLE one)
 *   POST   /runs/:runId/cancel  networkScan:write
 *   POST   /runs/:runId/adopt   networkScan:write + assets:write  (CHAINED)
 *
 * `/preview-targets` and `/runs/...` are declared BEFORE "/:id" so the literal
 * paths aren't captured as ids (the deliveryChannels `/web-push` precedent).
 *
 * **The chained gate on adopt is the point of the whole permission design**
 * (business rule 34a): running a Discovery creates nothing, so a role may be
 * allowed to find out what is on a range without being allowed to put it into
 * inventory. `integrations:write`-style blanket gates are exactly what that
 * separation would lose.
 *
 * `/preview-targets` is read-level deliberately: it resolves typed targets with
 * the pure `expandScanTargets` plus one indexed read, touches no network, and
 * gating it at write would block the wizard's target preview for a role that is
 * allowed to look at Discoveries.
 *
 * **Visibility (the SavedDashboard / SavedTableFilter model).** A Discovery is
 * `private` (its owner alone) or `public` (every caller holding
 * `networkScan:read`), which is what lets one operator build a sweep another
 * one runs. Three consequences here:
 *
 *   - every route resolves the caller's user id and hands it to the service,
 *     which scopes the read; an invisible row answers **404, not 403** — a
 *     private Discovery's existence is not other operators' business;
 *   - RUNNING is gated on visibility, not ownership. Publishing one exists
 *     precisely so somebody else can run it;
 *   - EDIT and DELETE are the owner's, with `networkScan:fullwrite` as the
 *     housekeeping override for someone else's row (including an orphan left
 *     by a deleted account). That check lives here rather than in the service
 *     because it needs the caller's permission level.
 *
 * PUBLISHING deliberately requires nothing beyond the `write` every mutation
 * here already needs — unlike saved filters and dashboards, whose mounts sit at
 * `read` and use `write` to mark the publish. `networkadmin` and `assetsadmin`
 * hold `write`, not `fullwrite`, and they are exactly the roles that author
 * Discoveries; requiring more would put sharing out of reach of everyone it is
 * for.
 */

import { Router } from "express";
import { z } from "zod";
import type { Request } from "express";
import { AppError } from "../../utils/errors.js";
import { hasPermission, requirePermission, credentialUseActor } from "../middleware/permissions.js";
import { recordCredentialUse, scanCredentialUses } from "../../services/credentialUseAuditService.js";
import { requestActor } from "../middleware/auth.js";
import {
  adoptHits,
  cancelRun,
  createScan,
  deleteScan,
  getRun,
  getScan,
  getScanForWrite,
  listScans,
  ownsScan,
  previewTargets,
  triggerScan,
  updateScan,
  MAX_ADOPT_PER_CALL,
  MAX_CREDENTIALS_PER_METHOD,
  MAX_SCAN_TARGET_ROWS,
  type SaveScanInput,
  type ScanViewer,
} from "../../services/networkScanService.js";
import { SCAN_METHODS } from "../../services/networkScanRunner.js";

const router = Router();

// ─── Schemas ────────────────────────────────────────────────────────────────
//
// Shape only. The SEMANTIC rules (a target that expands to nothing, ICMP with
// credentials, a per-method credential cap) live in
// networkScanService.validateScanInput, because an imported .discovery.json has
// to pass exactly the same checks and they are properties of the feature rather
// than of one HTTP body.

const targetSchema = z.object({
  kind: z.enum(["cidr", "range", "single"]),
  value: z.string().min(1).max(64),
});

const methodSchema = z.object({
  type: z.enum(SCAN_METHODS),
  credentialIds: z.array(z.string().uuid()).max(MAX_CREDENTIALS_PER_METHOD).optional().default([]),
});

/**
 * The auto-monitor selection blob, keyed by polling method.
 *
 * Passed through as `unknown` rather than re-declaring the
 * byNames/byPatterns/byTypes/byLldp union a third time (it already exists as
 * Zod in integrations.ts and as types in autoMonitorInterfacesService): the
 * pure resolvers ignore anything they don't recognize, so a malformed block
 * pins nothing rather than pinning the wrong thing. Duplicating the union here
 * is how the two would drift.
 */
const autoMonitorSchema = z.record(z.string(), z.unknown()).nullable().optional();

const saveSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  // Optional, defaulting to the safe end: an imported `.discovery.json` carries
  // no visibility (it is an ownership fact about ONE install, not portable
  // configuration), and an older API client sending neither must not publish.
  visibility: z.enum(["private", "public"]).optional().default("private"),
  targets: z.array(targetSchema).min(1).max(MAX_SCAN_TARGET_ROWS),
  methods: z.array(methodSchema).min(1).max(SCAN_METHODS.length),
  autoMonitor: autoMonitorSchema,
});

const previewSchema = z.object({
  targets: z.array(targetSchema).max(MAX_SCAN_TARGET_ROWS),
});

const adoptSchema = z.object({
  addresses: z.array(z.string().min(1).max(45)).min(1).max(MAX_ADOPT_PER_CALL),
});

/**
 * Who is asking, for the visibility scope. `id` is null for a bearer token —
 * it has no user identity, so it sees the public set and owns nothing.
 * `username` still comes from `requestActor` so audit rows name the token.
 */
function viewer(req: Request): ScanViewer {
  return { id: req.session?.userId ?? null, username: requestActor(req) ?? "unknown" };
}

/**
 * May this caller EDIT this row? Its owner may; anyone else needs fullwrite,
 * which is the housekeeping level (someone else's Discovery, or an orphan left
 * by a deleted account). Visibility has already been asserted by the load, so
 * the refusal here is a real 403 rather than a disclosure.
 */
function assertMayEditScan(req: Request, row: { ownerId: string | null }, verb: string): void {
  if (ownsScan(row, req.session?.userId ?? null)) return;
  if (hasPermission(req, "networkScan", "fullwrite")) return;
  throw new AppError(403, `Forbidden — ${verb} a Discovery someone else created requires networkScan:fullwrite`);
}

/** Router-wide floor. Every route needs at least this. */
router.use(requirePermission("networkScan", "read"));

// ─── Reads ──────────────────────────────────────────────────────────────────

router.get("/", async (req, res, next) => {
  try {
    res.json({ scans: await listScans(viewer(req).id) });
  } catch (err) { next(err); }
});

router.post("/preview-targets", async (req, res, next) => {
  try {
    const body = previewSchema.parse(req.body ?? {});
    res.json(await previewTargets(body.targets));
  } catch (err) { next(err); }
});

router.get("/runs/:runId", async (req, res, next) => {
  try {
    res.json({ run: await getRun((req.params.runId as string), viewer(req).id) });
  } catch (err) { next(err); }
});

// ─── Writes ─────────────────────────────────────────────────────────────────

router.post("/runs/:runId/cancel", requirePermission("networkScan", "write"), async (req, res, next) => {
  try {
    res.json({ run: await cancelRun((req.params.runId as string), viewer(req)) });
  } catch (err) { next(err); }
});

/**
 * Adoption — the one route here that creates assets, and the only one carrying
 * a second key. Both gates run: `networkScan:write` (this is a Discovery
 * action) AND `assets:write` (it writes inventory).
 */
router.post(
  "/runs/:runId/adopt",
  requirePermission("networkScan", "write"),
  requirePermission("assets", "write"),
  async (req, res, next) => {
    try {
      const body = adoptSchema.parse(req.body ?? {});
      res.json(await adoptHits((req.params.runId as string), body.addresses, viewer(req)));
    } catch (err) { next(err); }
  },
);

router.post("/", requirePermission("networkScan", "write"), async (req, res, next) => {
  try {
    const body = saveSchema.parse(req.body ?? {}) as SaveScanInput;
    const scan = await createScan(body, viewer(req));
    // Rule 112: the Discovery now sends its credentials to the targets it names.
    await recordCredentialUse(credentialUseActor(req), "network-scan.save", scanCredentialUses(null, scan));
    res.status(201).json({ scan });
  } catch (err) { next(err); }
});

// Declared after the literal paths above so "preview-targets" / "runs" are
// never read as ids.
router.get("/:id", async (req, res, next) => {
  try {
    res.json({ scan: await getScan((req.params.id as string), viewer(req).id) });
  } catch (err) { next(err); }
});

router.put("/:id", requirePermission("networkScan", "write"), async (req, res, next) => {
  try {
    const body = saveSchema.parse(req.body ?? {}) as SaveScanInput;
    const row = await getScanForWrite((req.params.id as string), viewer(req).id);
    assertMayEditScan(req, row, "editing");
    const scan = await updateScan(row, body, viewer(req));
    await recordCredentialUse(credentialUseActor(req), "network-scan.save", scanCredentialUses(row, scan));
    res.json({ scan });
  } catch (err) { next(err); }
});

router.delete("/:id", requirePermission("networkScan", "write"), async (req, res, next) => {
  try {
    const row = await getScanForWrite((req.params.id as string), viewer(req).id);
    assertMayEditScan(req, row, "deleting");
    await deleteScan(row.id, requestActor(req));
    res.status(204).end();
  } catch (err) { next(err); }
});

/**
 * Start a run. 202 rather than 200: the sweep takes minutes and the wizard
 * watches the returned run row rather than this response.
 */
router.post("/:id/run", requirePermission("networkScan", "write"), async (req, res, next) => {
  try {
    const run = await triggerScan((req.params.id as string), viewer(req));
    // A run sends every credential the Discovery carries to every target, and
    // the person running it need not be the person who saved it.
    const scan = await getScan((req.params.id as string), viewer(req).id);
    await recordCredentialUse(credentialUseActor(req), "network-scan.run", scanCredentialUses(null, scan, true));
    res.status(202).json({ run });
  } catch (err) { next(err); }
});

export default router;
