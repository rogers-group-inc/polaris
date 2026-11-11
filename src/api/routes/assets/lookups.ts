/**
 * src/api/routes/assets/lookups.ts — Lookups and imports: reverse / forward DNS (one asset or a sweep), OUI vendor
 * lookup, CSV and PDF import. Split out of routes/assets.ts (CQ-B062) and
 * mounted there in order.
 */

import { Router } from "express";
import { prisma } from "../../../db.js";
import { AppError } from "../../../utils/errors.js";
import { mapWithConcurrency } from "../../../utils/concurrency.js";
import { requirePermission } from "../../middleware/permissions.js";
import { scopeAssetParam, requireFleetWide } from "../../middleware/writeScope.js";
import { requestActor } from "../../middleware/auth.js";
import { logEvent } from "../events.js";
import { buildFirmwareChangedEvent, logEventsBatch, type LogEventInput } from "../../../services/eventLogService.js";
import { getConfiguredResolver } from "../../../services/dnsService.js";
import { lookupOui, lookupOuiOverride } from "../../../services/ouiService.js";
import { EXCLUDED_LIFECYCLE_STATUSES } from "../../../utils/assetInvariants.js";
import { isAllZeroMac } from "../../../utils/mac.js";
import { chunkArray } from "../../../utils/chunk.js";
import { assertIpChangeMayRetargetIntegrationToken } from "./shared.js";
import { assertQuarantineStatusUntouched } from "../../../services/assetQuarantineService.js";

const router = Router();

// Fallback TTL (seconds) when the resolver can't return one (standard mode).
// Used for both positive results and negative caching (no PTR record found).
const DEFAULT_PTR_TTL_S = 3600;

function isPtrExpired(fetchedAt: Date | string | null | undefined, ttlSeconds: number | null | undefined, now: number): boolean {
  if (!fetchedAt) return true;
  const fetched = typeof fetchedAt === "string" ? new Date(fetchedAt).getTime() : (fetchedAt as Date).getTime();
  const ttlMs = (ttlSeconds ?? DEFAULT_PTR_TTL_S) * 1000;
  return (now - fetched) > ttlMs;
}

// Fleet-wide DNS sweep tuning.
//
// The sweep used to run one `await resolver.reverse()` followed by one
// `await prisma.*.update()` per row, strictly serially, inside the request
// handler. At the 2000-asset fleet size CLAUDE.md requires every change to be
// reasoned about, that is thousands of serial DNS round trips plus thousands of
// individual UPDATE round trips in one HTTP request: it outlives any nginx
// proxy_read_timeout, and a slow resolver multiplies the whole thing by the
// per-lookup timeout.
//
// Now: lookups run through a bounded pool, and the writes are collected and
// applied in batched transactions (the same shape the per-asset sibling route
// below already used). DNS_SWEEP_LOOKUP_CONCURRENCY is deliberately modest —
// the target is usually a single corporate resolver pair, and a wide fan-out
// there looks like a flood rather than a sweep.
const DNS_SWEEP_LOOKUP_CONCURRENCY = 16;

const DNS_SWEEP_WRITE_CHUNK = 250;

/**
 * Apply collected per-row updates in bounded transactions. One transaction per
 * chunk keeps each statement batch small enough that it cannot hold locks or a
 * pool connection for the length of the whole sweep.
 */
async function applyDnsUpdatesChunked(
  updates: Array<{ table: "asset" | "assetAssociatedIp"; id: string; data: Record<string, unknown> }>,
): Promise<void> {
  for (const chunk of chunkArray(updates, DNS_SWEEP_WRITE_CHUNK)) {
    await prisma.$transaction(
      chunk.map((u) =>
        u.table === "asset"
          ? prisma.asset.update({ where: { id: u.id }, data: u.data as any })
          : prisma.assetAssociatedIp.update({ where: { id: u.id }, data: u.data as any }),
      ),
    );
  }
}

// POST /api/v1/assets/dns-lookup — bulk PTR lookup; skips IPs whose cached result is within TTL
router.post("/dns-lookup", requirePermission("assets", "write"), requireFleetWide("assets", "a fleet-wide DNS lookup"), async (req, res, next) => {
  try {
    const now = Date.now();
    const resolver = await getConfiguredResolver();

    // ── Primary IPs ──────────────────────────────────────────────────────────
    const primaryAssets = await prisma.asset.findMany({
      where: { ipAddress: { not: null }, status: { notIn: EXCLUDED_LIFECYCLE_STATUSES } },
      select: { id: true, ipAddress: true, hostname: true, dnsName: true, dnsNameFetchedAt: true, dnsNameTtl: true },
    });

    // Only query IPs whose cached PTR has expired (or was never fetched)
    const needsPrimary = primaryAssets.filter((a) => isPtrExpired(a.dnsNameFetchedAt, a.dnsNameTtl, now));
    const skippedPrimary = primaryAssets.length - needsPrimary.length;

    let resolved = 0;
    let failed = 0;
    const results: Array<{ id: string; ip: string; dnsName: string }> = [];
    // One collected list for BOTH passes, applied in batched transactions after
    // the lookups finish. Nothing here reads a value another row's update wrote,
    // so deferring the writes changes no outcome.
    const updates: Array<{ table: "asset" | "assetAssociatedIp"; id: string; data: Record<string, unknown> }> = [];

    await mapWithConcurrency(needsPrimary, DNS_SWEEP_LOOKUP_CONCURRENCY, async (asset) => {
      if (!asset.ipAddress) return;
      const fetchedAt = new Date();
      try {
        const records = await resolver.reverse(asset.ipAddress);
        if (records.length > 0) {
          const { name: dnsName, ttl } = records[0];
          updates.push({ table: "asset", id: asset.id, data: { dnsName, dnsNameFetchedAt: fetchedAt, dnsNameTtl: ttl } });
          results.push({ id: asset.id, ip: asset.ipAddress, dnsName });
          resolved++;
          return;
        }
        // Negative cache: record the attempt so we don't retry until TTL expires
        updates.push({ table: "asset", id: asset.id, data: { dnsNameFetchedAt: fetchedAt, dnsNameTtl: null } });
        failed++;
      } catch {
        updates.push({ table: "asset", id: asset.id, data: { dnsNameFetchedAt: fetchedAt, dnsNameTtl: null } });
        failed++;
      }
    });

    // ── Associated IPs ───────────────────────────────────────────────────────
    // Iterate every active asset_associated_ips row directly (the side table is
    // smaller than the asset table, so this is cheaper than the per-asset
    // findMany + array merge loop the JSONB version did). Per-row PTR refresh
    // hits an `update` only when something actually changed; ON CONFLICT
    // semantics aren't relevant here because each row already has a stable id.
    const assocRows = await prisma.assetAssociatedIp.findMany({
      where: { asset: { status: { notIn: EXCLUDED_LIFECYCLE_STATUSES } } },
      select: { id: true, ip: true, ptrName: true, ptrTtl: true, ptrFetchedAt: true },
    });

    let assocResolved = 0;
    let assocSkipped = 0;
    const assocNeedsLookup = assocRows.filter((row) => {
      if (!row.ip) return false;
      const fetchedAtIso = row.ptrFetchedAt ? row.ptrFetchedAt.toISOString() : null;
      if (!isPtrExpired(fetchedAtIso, row.ptrTtl, now)) { assocSkipped++; return false; }
      return true;
    });

    await mapWithConcurrency(assocNeedsLookup, DNS_SWEEP_LOOKUP_CONCURRENCY, async (row) => {
      const ptrFetchedAt = new Date();
      try {
        const records = await resolver.reverse(row.ip!);
        if (records.length > 0) {
          assocResolved++;
          updates.push({
            table: "assetAssociatedIp",
            id: row.id,
            data: { ptrName: records[0].name, ptrTtl: records[0].ttl, ptrFetchedAt },
          });
          return;
        }
      } catch { /* fall through to the negative cache below */ }
      // Negative cache — preserve any existing ptrName, clear ttl, stamp fetchedAt
      updates.push({ table: "assetAssociatedIp", id: row.id, data: { ptrTtl: null, ptrFetchedAt } });
    });

    await applyDnsUpdatesChunked(updates);

    logEvent({
      action: "asset.dns.bulk", resourceType: "asset", actor: requestActor(req),
      message: `Bulk DNS lookup: ${resolved} resolved, ${failed} failed, ${skippedPrimary} skipped (TTL); ${assocResolved} associated IP PTR(s) resolved, ${assocSkipped} skipped`,
    });
    res.json({ total: needsPrimary.length, skipped: skippedPrimary, resolved, failed, assocResolved, assocSkipped, results });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/:id/dns-lookup — PTR lookup for a single asset; always queries (user-triggered)
router.post("/:id/dns-lookup", requirePermission("assets", "write"), scopeAssetParam("assets", "edit assets"), async (req, res, next) => {
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: req.params.id as string },
      include: { associatedIpRows: { select: { id: true, ip: true, ptrName: true } } },
    });
    if (!asset) throw new AppError(404, "Asset not found");

    const assocRows = asset.associatedIpRows;
    if (!asset.ipAddress && assocRows.length === 0) throw new AppError(400, "Asset has no IP address");

    const resolver = await getConfiguredResolver();
    let dnsName: string | null = asset.dnsName;
    let dnsNameTtl: number | null = null;
    const fetchedAt = new Date();

    if (asset.ipAddress) {
      try {
        const records = await resolver.reverse(asset.ipAddress);
        if (records.length > 0) { dnsName = records[0].name; dnsNameTtl = records[0].ttl; }
        else dnsName = null;
      } catch {
        dnsName = null;
      }
    }

    // PTR for each associated IP — always re-query on single-asset lookup.
    // One DB write per row (small batches; this is a manual-action endpoint
    // so we're not in a hot path). $transaction packs the per-row updates
    // into a single round-trip so the cost stays low even for assets with
    // dozens of associated IPs.
    let assocResolved = 0;
    const assocUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
    for (const row of assocRows) {
      if (!row.ip) continue;
      const ptrFetchedAt = new Date();
      try {
        const records = await resolver.reverse(row.ip);
        if (records.length > 0) {
          assocResolved++;
          assocUpdates.push({ id: row.id, data: { ptrName: records[0].name, ptrTtl: records[0].ttl, ptrFetchedAt } });
          continue;
        }
      } catch {}
      assocUpdates.push({ id: row.id, data: { ptrTtl: null, ptrFetchedAt } });
    }
    if (assocUpdates.length > 0) {
      await prisma.$transaction(assocUpdates.map((u) =>
        prisma.assetAssociatedIp.update({ where: { id: u.id }, data: u.data }),
      ));
    }

    const updateData: Record<string, unknown> = {
      dnsName,
      dnsNameFetchedAt: fetchedAt,
      dnsNameTtl,
    };
    await prisma.asset.update({ where: { id: asset.id }, data: updateData });

    if (!dnsName && assocResolved === 0) {
      const testedIp = asset.ipAddress || assocRows[0]?.ip;
      return res.json({ ok: false, message: `No PTR records found for ${testedIp}${assocRows.length > 1 ? " or its associated IPs" : ""}` });
    }

    const parts: string[] = [];
    if (dnsName) parts.push(`${asset.ipAddress} → ${dnsName}${dnsNameTtl != null ? ` (TTL ${dnsNameTtl}s)` : ""}`);
    if (assocResolved > 0) parts.push(`${assocResolved} associated IP PTR(s) resolved`);
    const message = parts.join("; ");

    logEvent({ action: "asset.dns.resolved", resourceType: "asset", resourceId: asset.id, resourceName: asset.hostname || asset.ipAddress || undefined, actor: requestActor(req), message: `DNS resolved: ${message}` });
    res.json({ ok: true, dnsName, dnsNameTtl, assocResolved, message });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/:id/forward-lookup — A/AAAA lookup from hostname/dnsName → fills ipAddress
router.post("/:id/forward-lookup", requirePermission("assets", "write"), scopeAssetParam("assets", "edit assets"), async (req, res, next) => {
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: req.params.id as string },
      include: { discoveredByIntegration: { select: { type: true } } },
    });
    if (!asset) throw new AppError(404, "Asset not found");
    if (asset.ipAddress) throw new AppError(400, "Asset already has an IP address");
    const lookupName = asset.dnsName || asset.hostname;
    if (!lookupName) throw new AppError(400, "Asset has no hostname or DNS name to look up");

    const resolver = await getConfiguredResolver();
    const start = Date.now();
    const records = await resolver.lookup(lookupName);
    const elapsed = Date.now() - start;

    if (records.length === 0) {
      return res.json({ ok: false, message: `No A/AAAA records found for ${lookupName}` });
    }

    const ip = records[0].address;
    // A resolved name is a typed address by another route: the name is editable (rule 111).
    assertIpChangeMayRetargetIntegrationToken(req, asset, ip);
    await prisma.asset.update({ where: { id: asset.id }, data: { ipAddress: ip, ipSource: "dns" } });

    logEvent({ action: "asset.dns.forward_resolved", resourceType: "asset", resourceId: asset.id, resourceName: asset.hostname || asset.dnsName || undefined, actor: requestActor(req), message: `Forward DNS: ${lookupName} → ${ip} in ${elapsed}ms` });
    res.json({ ok: true, ipAddress: ip, message: `${lookupName} → ${ip} in ${elapsed}ms` });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/oui-lookup — bulk OUI manufacturer lookup
router.post("/oui-lookup", requirePermission("assets", "write"), requireFleetWide("assets", "a fleet-wide OUI lookup"), async (req, res, next) => {
  try {
    const assets = await prisma.asset.findMany({
      where: { macAddress: { not: null }, manufacturer: null, status: { notIn: EXCLUDED_LIFECYCLE_STATUSES } },
      select: { id: true, macAddress: true, hostname: true, ipAddress: true },
    });

    let resolved = 0;
    let failed = 0;
    const results: Array<{ id: string; mac: string; manufacturer: string }> = [];

    // Resolve first (lookupOui / lookupOuiOverride are in-memory), then write
    // GROUPED: manufacturer+model is low-cardinality by nature — an OUI names
    // a vendor, and a fleet has tens of vendors, not thousands — so the
    // per-asset update this replaces meant ~1000 statements to write ~50
    // distinct values over an unbounded, unpaginated candidate set. The
    // discovery engine already does the batched form of this exact operation
    // (batchSettled over assetsNeedingOui).
    const byVendor = new Map<string, { data: { manufacturer: string; model?: string }; ids: string[] }>();
    for (const asset of assets) {
      if (!asset.macAddress) continue;
      const vendor = await lookupOui(asset.macAddress);
      if (!vendor) { failed++; continue; }
      const override = await lookupOuiOverride(asset.macAddress);
      const data: { manufacturer: string; model?: string } = { manufacturer: vendor };
      if (override?.device) data.model = override.device;
      const key = JSON.stringify([vendor, data.model ?? ""]);
      const slot = byVendor.get(key);
      if (slot) slot.ids.push(asset.id);
      else byVendor.set(key, { data, ids: [asset.id] });
      results.push({ id: asset.id, mac: asset.macAddress, manufacturer: vendor });
      resolved++;
    }

    for (const { data, ids } of byVendor.values()) {
      await prisma.asset.updateMany({ where: { id: { in: ids } }, data });
    }

    logEvent({ action: "asset.oui.bulk", resourceType: "asset", message: `Bulk OUI lookup: ${resolved} resolved, ${failed} unmatched out of ${assets.length} assets`, actor: requestActor(req) });
    res.json({ total: assets.length, resolved, failed, results });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/:id/oui-lookup — OUI manufacturer lookup for a single asset
router.post("/:id/oui-lookup", requirePermission("assets", "write"), scopeAssetParam("assets", "edit assets"), async (req, res, next) => {
  try {
    const asset = await prisma.asset.findUnique({ where: { id: req.params.id as string } });
    if (!asset) throw new AppError(404, "Asset not found");
    if (!asset.macAddress) throw new AppError(400, "Asset has no MAC address");

    const vendor = await lookupOui(asset.macAddress);
    if (!vendor) {
      return res.json({ ok: false, message: `No OUI match for ${asset.macAddress}` });
    }

    const override = await lookupOuiOverride(asset.macAddress);
    const data: { manufacturer: string; model?: string } = { manufacturer: vendor };
    if (override?.device) data.model = override.device;
    await prisma.asset.update({ where: { id: asset.id }, data });
    const msg = data.model
      ? `OUI resolved: ${asset.macAddress} → ${vendor} / ${data.model}`
      : `OUI resolved: ${asset.macAddress} → ${vendor}`;
    logEvent({ action: "asset.oui.resolved", resourceType: "asset", resourceId: asset.id, resourceName: asset.hostname || asset.ipAddress || undefined, actor: requestActor(req), message: msg });
    res.json({ ok: true, manufacturer: vendor, model: data.model, message: msg });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/import — CSV import: backdate createdAt from serial+date rows (assets admin)
router.post("/import", requirePermission("assets", "write"), requireFleetWide("assets", "an import that edits devices by serial"), async (req, res, next) => {
  try {
    const { rows, dryRun } = req.body as { rows?: unknown; dryRun?: boolean };
    if (!Array.isArray(rows) || rows.length === 0) throw new AppError(400, "rows must be a non-empty array");

    const preview: Array<{ serialNumber: string; hostname: string | null; currentFirstSeen: string; importDate: string; willUpdate: boolean }> = [];
    let updated = 0;
    let notFound = 0;

    // Parse first, then resolve every serial in ONE read. The loop used to do
    // a findFirst per row and an update per match — serialNumber is indexed,
    // so the cost was pure round-trip latency, but a 2000-row import still
    // meant ~4000 serialized queries and this is the request most likely to
    // hit a proxy timeout. (The /import-pdf handler below already batches its
    // audit events for the same reason; its DB writes just weren't given the
    // same treatment.)
    const parsed: Array<{ serial: string; importDate: Date }> = [];
    for (const row of rows as any[]) {
      const serial = String(row.serialNumber || "").trim();
      const rawDate = String(row.date || "").trim();
      if (!serial || !rawDate) continue;
      const importDate = new Date(rawDate);
      if (isNaN(importDate.getTime())) continue;
      parsed.push({ serial, importDate });
    }

    // First row wins per serial, matching findFirst's behavior on a duplicate.
    const bySerial = new Map<string, { id: string; hostname: string | null; createdAt: Date }>();
    if (parsed.length > 0) {
      const found = await prisma.asset.findMany({
        where: { serialNumber: { in: [...new Set(parsed.map((p) => p.serial))] } },
        select: { id: true, serialNumber: true, hostname: true, createdAt: true },
      });
      for (const a of found) {
        if (a.serialNumber && !bySerial.has(a.serialNumber)) {
          bySerial.set(a.serialNumber, { id: a.id, hostname: a.hostname, createdAt: a.createdAt });
        }
      }
    }

    const backdates: Array<{ id: string; createdAt: Date }> = [];
    for (const { serial, importDate } of parsed) {
      const asset = bySerial.get(serial);
      if (!asset) { notFound++; continue; }

      const willUpdate = importDate < asset.createdAt;
      preview.push({
        serialNumber: serial,
        hostname: asset.hostname,
        currentFirstSeen: asset.createdAt.toISOString(),
        importDate: importDate.toISOString(),
        willUpdate,
      });

      if (willUpdate && !dryRun) {
        backdates.push({ id: asset.id, createdAt: importDate });
        updated++;
      }
    }

    // Chunked so one transaction never spans a whole spreadsheet.
    const IMPORT_CHUNK = 200;
    for (const chunk of chunkArray(backdates, IMPORT_CHUNK)) {
      await prisma.$transaction(
        chunk.map((b) =>
          prisma.asset.update({ where: { id: b.id }, data: { createdAt: b.createdAt } }),
        ),
      );
    }

    if (!dryRun && updated > 0) {
      logEvent({ action: "asset.import", resourceType: "asset", actor: requestActor(req), message: `CSV import: updated first-seen date for ${updated} asset(s)` });
    }

    res.json({ preview, updated, notFound, dryRun: !!dryRun });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/import-pdf — create/update assets from extracted PDF invoice data (assets admin)
router.post("/import-pdf", requirePermission("assets", "write"), requireFleetWide("assets", "an import that edits devices by serial"), async (req, res, next) => {
  try {
    const { assets: rows, dryRun } = req.body as { assets?: unknown; dryRun?: boolean };
    if (!Array.isArray(rows) || rows.length === 0) throw new AppError(400, "assets must be a non-empty array");

    type PreviewRow = {
      action: "create" | "update";
      serialNumber: string | null;
      hostname: string | null;
      fields: Record<string, string>;
      existingHostname?: string | null;
    };
    const preview: PreviewRow[] = [];
    let created = 0;
    let updated = 0;
    // Accumulated so the loop makes one batched audit write rather than an
    // awaited logEvent per imported row.
    const firmwareEvents: LogEventInput[] = [];

    for (const row of rows as any[]) {
      const serial = row.serialNumber ? String(row.serialNumber).trim() : null;
      const existing = serial
        ? await prisma.asset.findFirst({ where: { serialNumber: serial }, include: { discoveredByIntegration: { select: { type: true } } } })
        : null;

      const updateData: Record<string, unknown> = {};
      const allowedFields = ["hostname", "ipAddress", "macAddress", "assetType", "status", "manufacturer", "model", "serialNumber", "location", "department", "assignedTo", "os", "notes", "assetTag"] as const;
      for (const f of allowedFields) {
        if (row[f] !== undefined && row[f] !== "") updateData[f] = String(row[f]).trim();
      }
      // An all-zero MAC cell imports as no MAC (the cell is skipped, like an
      // empty one) rather than as an address every such row would share.
      if (updateData.macAddress) {
        if (isAllZeroMac(updateData.macAddress)) delete updateData.macAddress;
        else updateData.macAddress = String(updateData.macAddress).toUpperCase().replace(/-/g, ":");
      }

      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(updateData)) fields[k] = String(v);

      if (existing) {
        // An invoice row that matches a managed firewall's serial may not move its address (rule 111).
        assertIpChangeMayRetargetIntegrationToken(req, existing, updateData.ipAddress as string | undefined);
        assertQuarantineStatusUntouched(updateData.status, existing.status);
        preview.push({ action: "update", serialNumber: serial, hostname: row.hostname || null, existingHostname: existing.hostname, fields });
        if (!dryRun) {
          const importUpdateData: Record<string, unknown> = { ...updateData };
          if (importUpdateData.status !== undefined) {
            importUpdateData.statusChangedAt = new Date();
            importUpdateData.statusChangedBy = requestActor(req) ?? "manual";
          }
          await prisma.asset.update({ where: { id: existing.id }, data: importUpdateData as any });
          updated++;
          const firmwareEvent = buildFirmwareChangedEvent(
            {
              assetId: existing.id,
              assetName: existing.hostname || existing.ipAddress || null,
              actor: requestActor(req) ?? "manual",
              source: "pdf-import",
            },
            { os: existing.os },
            updateData,
          );
          if (firmwareEvent) firmwareEvents.push(firmwareEvent);
        }
      } else {
        assertQuarantineStatusUntouched(updateData.status, null);
        preview.push({ action: "create", serialNumber: serial, hostname: row.hostname || null, fields });
        if (!dryRun) {
          // A row the import CREATES is the importer's (business rule 141 (e)), like a hand-added device.
          await prisma.asset.create({ data: { assetType: "other", status: "storage", statusChangedAt: new Date(), statusChangedBy: requestActor(req) ?? "manual", createdBy: requestActor(req) ?? null, ...updateData } as any });
          created++;
        }
      }
    }

    if (!dryRun && (created + updated) > 0) {
      logEvent({ action: "asset.import_pdf", resourceType: "asset", actor: requestActor(req), message: `PDF import: created ${created}, updated ${updated} asset(s)` });
    }
    if (firmwareEvents.length > 0) void logEventsBatch(firmwareEvents);

    res.json({ preview, created, updated, dryRun: !!dryRun });
  } catch (err) {
    next(err);
  }
});

export default router;
