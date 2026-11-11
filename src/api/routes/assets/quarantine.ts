/**
 * src/api/routes/assets/quarantine.ts — MAC quarantine on an asset: status, quarantine / release, verify, and the bulk
 * quarantine + release verbs (assetsQuarantine). Split out of routes/assets.ts
 * (CQ-B062) and mounted there in order.
 */

import { Router } from "express";
import { z } from "zod";
import { mapWithConcurrency } from "../../../utils/concurrency.js";
import { requirePermission } from "../../middleware/permissions.js";
import { scopeAssetParam, scopeAssetIds, idsFromBody } from "../../middleware/writeScope.js";
import { requestActor } from "../../middleware/auth.js";
import { machineApiLimiter } from "../../middleware/rateLimits.js";
import { quarantineAsset, releaseQuarantine, verifyAssetQuarantine, getQuarantineStatus, recordQuarantineDrift } from "../../../services/assetQuarantineService.js";

const router = Router();

// GET /api/v1/assets/:id/quarantine-status — current quarantine state + recorded targets
router.get("/:id/quarantine-status", requirePermission("assetsQuarantine", "read"), async (req, res, next) => {
  try {
    res.json(await getQuarantineStatus(req.params.id as string));
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/:id/quarantine — admin, assets admin, or token with assets:quarantine scope
router.post("/:id/quarantine", requirePermission("assetsQuarantine", "write"), scopeAssetParam("assetsQuarantine", "quarantine devices"), async (req, res, next) => {
  try {
    const Schema = z.object({ reason: z.string().max(500).optional() });
    const input = Schema.parse(req.body ?? {});
    const id = req.params.id as string;
    const actor = requestActor(req) || "unknown";
    const result = await quarantineAsset({
      assetId: id,
      actor,
      reason: input.reason,
      tokenIntegrationIds: req.apiToken?.integrationIds,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/assets/:id/quarantine — admin, assets admin, or token with assets:quarantine scope
router.delete("/:id/quarantine", requirePermission("assetsQuarantine", "write"), scopeAssetParam("assetsQuarantine", "release devices"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const actor = requestActor(req) || "unknown";
    const result = await releaseQuarantine({
      assetId: id,
      actor,
      tokenIntegrationIds: req.apiToken?.integrationIds,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Business rule 164: the FortiGates that still hold the block after a release.
// POST …/stranded/retry  — try again now (one gate with `fortigateDevice`, else all)
// DELETE …/stranded      — stop tracking without touching the device (`?device=` for one)
// Same gate as release: assetsQuarantine write + the asset in the caller's write
// scope; a token scoped to some integrations may only touch their gates.
router.post("/:id/quarantine/stranded/retry", requirePermission("assetsQuarantine", "write"), scopeAssetParam("assetsQuarantine", "release devices"), async (req, res, next) => {
  try {
    const input = z.object({ fortigateDevice: z.string().min(1).max(200).optional() }).parse(req.body ?? {});
    const { retryStrandedQuarantine } = await import("../../../services/quarantineStrandedService.js");
    res.json(await retryStrandedQuarantine(req.params.id as string, {
      actor: requestActor(req) || "unknown",
      fortigateDevice: input.fortigateDevice,
      tokenIntegrationIds: req.apiToken?.integrationIds,
    }));
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/quarantine/stranded", requirePermission("assetsQuarantine", "write"), scopeAssetParam("assetsQuarantine", "release devices"), async (req, res, next) => {
  try {
    const device = typeof req.query.device === "string" && req.query.device.trim() ? req.query.device.trim().slice(0, 200) : undefined;
    const { dismissStrandedQuarantine } = await import("../../../services/quarantineStrandedService.js");
    res.json(await dismissStrandedQuarantine(req.params.id as string, {
      actor: requestActor(req) || "unknown",
      fortigateDevice: device,
      tokenIntegrationIds: req.apiToken?.integrationIds,
    }));
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/:id/quarantine/verify — read-back drift check (admin, assets admin, or token)
router.post("/:id/quarantine/verify", machineApiLimiter, requirePermission("assetsQuarantine", "write"), scopeAssetParam("assetsQuarantine", "quarantine devices"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const verifyResult = await verifyAssetQuarantine(id, req.apiToken?.integrationIds);
    if (verifyResult.driftDetected) {
      // Persist the drift flip + log the event so the operator has an audit trail.
      await recordQuarantineDrift(id, verifyResult.targets, requestActor(req));
    }
    res.json(verifyResult);
  } catch (err) {
    next(err);
  }
});

// Bulk-quarantine batching.
//
// Every id in the batch drives live FortiGate device I/O (push a MAC into the
// quarantine table, or release it). These routes used to take an UNBOUNDED id
// array and walk it strictly serially, so a 2000-asset selection meant 2000
// serial device writes held inside one HTTP request — past any proxy timeout,
// with the operator left unsure what actually landed. Sibling precedent:
// bulk-monitor collapsed its per-asset loop into one updateMany, and
// bulk-agent-install caps at 200 ids and drains through a bounded pool.
//
// The cap makes an oversized request a clean 400 instead of a hung one; the
// pool keeps the fan-out at the gates modest (each push is a REST call plus a
// read-back, and a wide fan-out at one FortiGate is how you get rate-limited).
const BULK_QUARANTINE_MAX_IDS = 500;

const BULK_QUARANTINE_POOL = 8;

// POST /api/v1/assets/bulk-quarantine — admin, assets admin, or token with assets:quarantine scope
router.post("/bulk-quarantine", requirePermission("assetsQuarantine", "write"), scopeAssetIds("assetsQuarantine", "quarantine devices", idsFromBody), async (req, res, next) => {
  try {
    const Schema = z.object({
      ids: z.array(z.string()).min(1).max(BULK_QUARANTINE_MAX_IDS),
      reason: z.string().max(500).optional(),
    });
    const input = Schema.parse(req.body);
    const actor = requestActor(req) || "unknown";
    // Per-item ok/message shape preserved — a single bad asset must not fail the
    // batch. mapWithConcurrency keeps results in input order.
    const results = await mapWithConcurrency(input.ids, BULK_QUARANTINE_POOL, async (id) => {
      try {
        const r = await quarantineAsset({ assetId: id, actor, reason: input.reason, tokenIntegrationIds: req.apiToken?.integrationIds });
        return { id, ok: true, message: r.message, succeededCount: r.succeededCount, failedCount: r.failedCount };
      } catch (err: any) {
        return { id, ok: false, message: err?.message || "Quarantine failed" };
      }
    });
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/bulk-quarantine/release — admin, assets admin, or token with assets:quarantine scope
router.post("/bulk-quarantine/release", requirePermission("assetsQuarantine", "write"), scopeAssetIds("assetsQuarantine", "release devices", idsFromBody), async (req, res, next) => {
  try {
    const Schema = z.object({ ids: z.array(z.string()).min(1).max(BULK_QUARANTINE_MAX_IDS) });
    const input = Schema.parse(req.body);
    const actor = requestActor(req) || "unknown";
    const results = await mapWithConcurrency(input.ids, BULK_QUARANTINE_POOL, async (id) => {
      try {
        const r = await releaseQuarantine({ assetId: id, actor, tokenIntegrationIds: req.apiToken?.integrationIds });
        return { id, ok: true, message: r.message };
      } catch (err: any) {
        return { id, ok: false, message: err?.message || "Release failed" };
      }
    });
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

export default router;
