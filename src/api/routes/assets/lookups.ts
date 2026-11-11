/**
 * src/api/routes/assets/lookups.ts — Lookups and imports: reverse / forward DNS (one asset or a sweep), OUI vendor
 * lookup, CSV and PDF import. Split out of routes/assets.ts (CQ-B062) and
 * mounted there in order.
 */

import { Router } from "express";
import { AppError } from "../../../utils/errors.js";
import { requirePermission } from "../../middleware/permissions.js";
import { scopeAssetParam, requireFleetWide } from "../../middleware/writeScope.js";
import { requestActor } from "../../middleware/auth.js";
import { assertIpChangeMayRetargetIntegrationToken } from "./shared.js";
import { bulkDnsLookup, assetDnsLookup, assetForwardLookup, bulkOuiLookup, assetOuiLookup, importFirstSeenDates, importPdfAssets } from "../../../services/assetLookupService.js";

const router = Router();

// POST /api/v1/assets/dns-lookup — bulk PTR lookup; skips IPs whose cached result is within TTL
router.post("/dns-lookup", requirePermission("assets", "write"), requireFleetWide("assets", "a fleet-wide DNS lookup"), async (req, res, next) => {
  try {
    res.json(await bulkDnsLookup(requestActor(req)));
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/:id/dns-lookup — PTR lookup for a single asset; always queries (user-triggered)
router.post("/:id/dns-lookup", requirePermission("assets", "write"), scopeAssetParam("assets", "edit assets"), async (req, res, next) => {
  try {
    res.json(await assetDnsLookup(req.params.id as string, requestActor(req)));
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/:id/forward-lookup — A/AAAA lookup from hostname/dnsName → fills ipAddress
router.post("/:id/forward-lookup", requirePermission("assets", "write"), scopeAssetParam("assets", "edit assets"), async (req, res, next) => {
  try {
    res.json(await assetForwardLookup(req.params.id as string, requestActor(req), (existing, ip) => assertIpChangeMayRetargetIntegrationToken(req, existing, ip)));
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/oui-lookup — bulk OUI manufacturer lookup
router.post("/oui-lookup", requirePermission("assets", "write"), requireFleetWide("assets", "a fleet-wide OUI lookup"), async (req, res, next) => {
  try {
    res.json(await bulkOuiLookup(requestActor(req)));
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/:id/oui-lookup — OUI manufacturer lookup for a single asset
router.post("/:id/oui-lookup", requirePermission("assets", "write"), scopeAssetParam("assets", "edit assets"), async (req, res, next) => {
  try {
    res.json(await assetOuiLookup(req.params.id as string, requestActor(req)));
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/import — CSV import: backdate createdAt from serial+date rows (assets admin)
router.post("/import", requirePermission("assets", "write"), requireFleetWide("assets", "an import that edits devices by serial"), async (req, res, next) => {
  try {
    const { rows, dryRun } = req.body as { rows?: unknown; dryRun?: boolean };
    if (!Array.isArray(rows) || rows.length === 0) throw new AppError(400, "rows must be a non-empty array");
    res.json(await importFirstSeenDates(rows, dryRun, requestActor(req)));
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/import-pdf — create/update assets from extracted PDF invoice data (assets admin)
router.post("/import-pdf", requirePermission("assets", "write"), requireFleetWide("assets", "an import that edits devices by serial"), async (req, res, next) => {
  try {
    const { assets: rows, dryRun } = req.body as { assets?: unknown; dryRun?: boolean };
    if (!Array.isArray(rows) || rows.length === 0) throw new AppError(400, "assets must be a non-empty array");
    res.json(await importPdfAssets(rows, dryRun, requestActor(req), (existing, ip) => assertIpChangeMayRetargetIntegrationToken(req, existing, ip)));
  } catch (err) {
    next(err);
  }
});

export default router;
