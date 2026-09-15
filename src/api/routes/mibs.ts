/**
 * src/api/routes/mibs.ts — MIB Database CRUD + Browse + MIB-aware Walk.
 *
 * Mounted at `/api/v1/server-settings/mibs` ahead of the rest of the
 * /server-settings router so this guard chain (admin-OR-assets-admin on
 * reads, admin-only on writes) takes precedence over the blanket
 * `requirePermission("mibDatabase", "write")` on /server-settings.
 *
 * The MIB-aware walk endpoint lets operators pick a MIB object by name
 * (resolved via oidRegistry's scope lookup) and walk an asset, returning
 * results decoded into symbolic names plus INTEGER enum labels (e.g.
 * `up(1)`) and 2D table grouping when the walk lands on a SMI table.
 */

import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { requirePermission } from "../middleware/permissions.js";
import {
  listMibs,
  getMib,
  createMib,
  deleteMib,
  getMibFacets,
  parseMibStructured,
  type MibSymbol,
  type MibTable,
  type ParsedMibStructured,
} from "../../services/mibService.js";
import { resolveSymbolsForMib, findUnresolvedRootSymbols, missingRootsForMib, type MissingRoot } from "../../services/oidRegistry.js";
import { snmpWalkRaw } from "../../services/monitoringService.js";
import { getCredential } from "../../services/credentialService.js";
import {
  listStdMibs,
  getStdMibDef,
  getStdMibStructure,
} from "../../services/stdMibLibrary.js";
import { logEvent } from "./events.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });

// ─── List + facets + profile status ───────────────────────────────────────

router.get("/facets", requirePermission("mibDatabase", "read"), async (_req, res, next) => {
  try {
    res.json(await getMibFacets());
  } catch (err) {
    next(err);
  }
});

// ─── Standard MIB browse + walk ───────────────────────────────────────────
// Static segment "/std" — declared before `/:id` so the uploaded-MIB
// catchall doesn't eat the std list. The deeper `/std/:key/*` routes have
// three segments and are already unambiguous against `/:id/*`.

router.get("/std", requirePermission("mibDatabase", "read"), (_req, res) => {
  res.json(
    listStdMibs().map((m) => ({
      key: m.key,
      label: m.label,
      moduleName: m.moduleName,
      rootOid: m.rootOid,
    })),
  );
});

router.get("/std/:key/structure", requirePermission("mibDatabase", "read"), (req, res, next) => {
  try {
    const key = req.params.key as string;
    const def = getStdMibDef(`std:${key}`);
    if (!def) throw new AppError(404, `Unknown standard MIB "${key}"`);
    const structured = getStdMibStructure(def.key);
    res.json({
      ...structured,
      mibId: def.key,            // wire-shape parity with the uploaded variant
      moduleName: def.moduleName,
      manufacturer: null,
      model: null,
      isStandard: true,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/std/:key/walk", requirePermission("mibDatabase", "read"), async (req, res, next) => {
  try {
    const parsed = WalkSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues.map((e) => e.message).join("; "));
    }

    const key = req.params.key as string;
    const def = getStdMibDef(`std:${key}`);
    if (!def) throw new AppError(404, `Unknown standard MIB "${key}"`);

    const structured = getStdMibStructure(def.key);
    res.json(
      await runMibWalk({
        structured,
        moduleName: def.moduleName,
        mibId: def.key,
        unresolvedOidSuffix: " at the standard scope",
        body: parsed.data,
        actor: req.session?.username,
      }),
    );
  } catch (err) {
    next(err);
  }
});

router.get("/", requirePermission("mibDatabase", "read"), async (req, res, next) => {
  try {
    const scopeRaw = typeof req.query.scope === "string" ? req.query.scope : "all";
    const scope: "all" | "device" | "generic" =
      scopeRaw === "device" || scopeRaw === "generic" ? scopeRaw : "all";
    const manufacturer = typeof req.query.manufacturer === "string" && req.query.manufacturer.trim()
      ? req.query.manufacturer.trim()
      : undefined;
    const model = typeof req.query.model === "string" && req.query.model.trim()
      ? req.query.model.trim()
      : undefined;
    res.json(await listMibs({ manufacturer, model, scope }));
  } catch (err) {
    next(err);
  }
});

router.get("/:id/download", requirePermission("mibDatabase", "read"), async (req, res, next) => {
  try {
    const row = await getMib(req.params.id as string);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${row.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
    res.send(row.contents);
  } catch (err) {
    next(err);
  }
});

router.get("/:id/structure", requirePermission("mibDatabase", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const row = await getMib(id);
    const structured = parseMibStructured(row.contents);
    const oidMap = await resolveSymbolsForMib(id);
    if (oidMap) {
      // Stamp each symbol with its resolved numeric OID at the MIB's natural
      // scope. Symbols whose dependencies are missing stay null and the UI
      // renders them with a "(unresolved)" hint.
      for (const sym of structured.symbols) {
        sym.fullOid = oidMap.get(sym.name) ?? null;
      }
    }
    const unresolvedCount = structured.symbols.filter((s) => s.fullOid === null).length;
    // Which EXTERNAL symbols the file leans on but nothing defines. The count
    // above says how much broke; this says what to upload to fix it — see
    // findUnresolvedRootSymbols on why an unresolved MIB is usually one root
    // cause rather than N independent ones.
    const unresolvedRoots =
      unresolvedCount > 0 && oidMap ? findUnresolvedRootSymbols(row.contents, oidMap) : [];
    // The same roots, each paired with the module the file's own IMPORTS says
    // defines it — so the banner can read "upload FORTINET-CORE-MIB", not
    // "something called `fortinet` is missing".
    const unresolvedRootDetails = unresolvedCount > 0 ? missingRootsForMib(row.id) : [];
    const payload: ParsedMibStructured & {
      mibId: string;
      manufacturer: string | null;
      model: string | null;
      unresolvedCount: number;
      unresolvedRoots: string[];
      unresolvedRootDetails: MissingRoot[];
    } = {
      ...structured,
      mibId: row.id,
      manufacturer: row.manufacturer,
      model: row.model,
      unresolvedCount,
      unresolvedRoots,
      unresolvedRootDetails,
    };
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

router.get("/:id", requirePermission("mibDatabase", "read"), async (req, res, next) => {
  try {
    res.json(await getMib(req.params.id as string));
  } catch (err) {
    next(err);
  }
});

// ─── Upload + delete (admin only) ─────────────────────────────────────────

router.post("/", requirePermission("mibDatabase", "write"), upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw new AppError(400, "No MIB file uploaded");
    const text = req.file.buffer.toString("utf-8");
    const created = await createMib({
      filename: req.file.originalname,
      contents: text,
      manufacturer: typeof req.body?.manufacturer === "string" ? req.body.manufacturer : null,
      model: typeof req.body?.model === "string" ? req.body.model : null,
      notes: typeof req.body?.notes === "string" ? req.body.notes : null,
      uploadedBy: req.session?.username ?? null,
    });
    logEvent({
      action: "mib.uploaded",
      actor: req.session?.username,
      resourceType: "mib",
      resourceId: created.id,
      resourceName: created.moduleName,
      message:
        `Uploaded MIB ${created.moduleName}` +
        (created.manufacturer ? ` for ${created.manufacturer}${created.model ? ` ${created.model}` : ""}` : " (generic)"),
    });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requirePermission("mibDatabase", "write"), async (req, res, next) => {
  try {
    const row = await getMib(req.params.id as string);
    await deleteMib(req.params.id as string);
    logEvent({
      action: "mib.deleted",
      actor: req.session?.username,
      resourceType: "mib",
      resourceId: row.id,
      resourceName: row.moduleName,
      message: `Deleted MIB ${row.moduleName}`,
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ─── MIB-aware walk ──────────────────────────────────────────────────────

const WalkSchema = z.object({
  assetId:      z.string().uuid("assetId must be a UUID"),
  credentialId: z.string().uuid("credentialId must be a UUID"),
  objectName:   z.string().min(1, "objectName is required").max(128),
  maxRows:      z.number().int().min(1).max(5000).optional().default(500),
});

interface WalkScalarEntry {
  oid: string;
  symbol: string | null;
  suffix: string | null;     // arc(s) past the matched symbol's OID
  syntax: string | null;
  baseType: string | null;
  raw: string;               // value as printed by snmpWalkRaw
  decoded: string;           // human-readable form
}

interface WalkTablePayload {
  name: string;
  rowSymbol: string;
  columns: string[];
  indexNames: string[];
  rows: { index: string; cells: Record<string, { raw: string; decoded: string } | null> }[];
}

// Match a result OID against the MIB's symbol map. Picks the LONGEST symbol
// OID that is a prefix of the result OID — for table cells, that's the
// column symbol's OID rather than the row's or table's.
function findSymbolForOid(
  oid: string,
  symbols: MibSymbol[],
): { symbol: MibSymbol; suffix: string } | null {
  let best: { symbol: MibSymbol; suffix: string; len: number } | null = null;
  for (const sym of symbols) {
    if (!sym.fullOid) continue;
    if (oid === sym.fullOid) {
      if (!best || sym.fullOid.length > best.len) {
        best = { symbol: sym, suffix: "", len: sym.fullOid.length };
      }
      continue;
    }
    const prefix = sym.fullOid + ".";
    if (oid.startsWith(prefix)) {
      if (!best || sym.fullOid.length > best.len) {
        best = { symbol: sym, suffix: oid.slice(prefix.length), len: sym.fullOid.length };
      }
    }
  }
  if (!best) return null;
  return { symbol: best.symbol, suffix: best.suffix };
}

function decodeValue(
  rawStr: string,
  symbol: MibSymbol | null,
  type: string,
): string {
  // INTEGER with named values → "up(1)" instead of "1"
  if (symbol?.enumValues && /^-?\d+$/.test(rawStr)) {
    const v = parseInt(rawStr, 10);
    const hit = symbol.enumValues.find((e) => e.value === v);
    if (hit) return `${hit.label}(${v})`;
  }
  // TimeTicks render as human duration (snmpWalkRaw returns the raw centi-second integer)
  if ((symbol?.baseType === "TimeTicks" || type === "TimeTicks") && /^\d+$/.test(rawStr)) {
    return formatTimeTicks(parseInt(rawStr, 10));
  }
  return rawStr;
}

function formatTimeTicks(ticks: number): string {
  // TimeTicks are hundredths of a second
  const totalSeconds = Math.floor(ticks / 100);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  if (mins || hours || days) parts.push(`${mins}m`);
  parts.push(`${secs}s`);
  return parts.join(" ");
}

/**
 * Shared walk pipeline behind both walk routes (`POST /std/:key/walk` and
 * `POST /:id/walk`). The caller has already Zod-parsed the body and loaded
 * the MIB structure (bundled std lookup vs the uploaded MibFile row + OID
 * resolution); everything downstream — object-name → OID resolution, asset +
 * SNMP-credential load, the raw walk, the decode/group pipeline, the
 * `asset.snmp_walk` Event, and the response payload — is identical.
 * Returns the JSON payload for the route to send.
 */
async function runMibWalk(opts: {
  structured: ParsedMibStructured;
  moduleName: string;
  /**
   * Value stamped into the Event's `details.mibId` — the `"std:<key>"` key
   * for bundled MIBs ("std:lldp" etc. — Events page treats this as opaque),
   * the MibFile row id for uploads.
   */
  mibId: string;
  /** Route-specific tail of the unresolved-OID 400 message. */
  unresolvedOidSuffix: string;
  body: z.infer<typeof WalkSchema>;
  actor: string | undefined;
}) {
  const { structured, moduleName, mibId, unresolvedOidSuffix, actor } = opts;
  const { assetId, credentialId, objectName, maxRows } = opts.body;

  const targetSymbol = structured.symbols.find((s) => s.name === objectName);
  if (!targetSymbol) {
    throw new AppError(400, `MIB ${moduleName} does not define an object named "${objectName}"`);
  }
  if (!targetSymbol.fullOid) {
    throw new AppError(400, `Object "${objectName}" cannot be resolved to a numeric OID${unresolvedOidSuffix}`);
  }

  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: { id: true, hostname: true, ipAddress: true },
  });
  if (!asset) throw new AppError(404, "Asset not found");
  if (!asset.ipAddress) throw new AppError(400, "Asset has no IP address to walk");

  const cred = await getCredential(credentialId, { revealSecrets: true });
  if (cred.type !== "snmp") {
    throw new AppError(400, `Credential "${cred.name}" is type "${cred.type}", expected "snmp"`);
  }

  const baseOid = targetSymbol.fullOid;
  const label = asset.hostname || asset.ipAddress;

  let walk;
  try {
    walk = await snmpWalkRaw(asset.ipAddress, cred.config as Record<string, unknown>, baseOid, maxRows);
  } catch (err: any) {
    const message = err?.message || "SNMP walk failed";
    logEvent({
      action: "asset.snmp_walk",
      resourceType: "asset",
      resourceId: assetId,
      resourceName: asset.hostname || asset.ipAddress || undefined,
      actor,
      level: "warning",
      message: `MIB walk failed: ${label} — ${moduleName}::${objectName} — ${message}`,
      details: {
        mibId,
        mibModuleName: moduleName,
        objectName,
        oid: baseOid,
        credentialName: cred.name,
        error: message,
      },
    });
    throw new AppError(502, message);
  }

  // Match each result row against the MIB's symbol map.
  type Entry = WalkScalarEntry & { symbolRef: MibSymbol | null };
  const entries: Entry[] = walk.rows.map((row) => {
    const hit = findSymbolForOid(row.oid, structured.symbols);
    const symbolRef = hit?.symbol ?? null;
    return {
      oid: row.oid,
      symbol: symbolRef?.name ?? null,
      suffix: hit?.suffix ?? null,
      syntax: symbolRef?.syntax ?? null,
      baseType: symbolRef?.baseType ?? null,
      raw: row.value,
      decoded: decodeValue(row.value, symbolRef, row.type),
      symbolRef,
    };
  });

  // Decide table vs scalar shape: every entry's parent must point at the
  // same row symbol AND that row must be a known MibTable's rowSymbol.
  let kind: "table" | "scalars" = "scalars";
  let tablePayload: WalkTablePayload | null = null;

  const rowParents = new Set<string>();
  for (const e of entries) {
    if (!e.symbolRef?.parentName) {
      rowParents.clear();
      break;
    }
    rowParents.add(e.symbolRef.parentName);
  }
  if (entries.length > 0 && rowParents.size === 1) {
    const onlyParent = rowParents.values().next().value as string;
    const tableMatch = structured.tables.find((t) => t.rowSymbol === onlyParent);
    if (tableMatch) {
      kind = "table";
      tablePayload = renderTablePayload(tableMatch, entries);
    }
  }

  const decodedCount = entries.filter((e) => e.symbol !== null).length;

  logEvent({
    action: "asset.snmp_walk",
    resourceType: "asset",
    resourceId: assetId,
    resourceName: asset.hostname || asset.ipAddress || undefined,
    actor,
    level: "info",
    message: `MIB walk: ${label} — ${moduleName}::${objectName} → ${entries.length} row(s)${walk.truncated ? " (truncated)" : ""}`,
    details: {
      mibId,
      mibModuleName: moduleName,
      objectName,
      oid: baseOid,
      credentialName: cred.name,
      kind,
      rowCount: entries.length,
      decodedCount,
      truncated: walk.truncated,
      durationMs: walk.durationMs,
    },
  });

  if (kind === "table" && tablePayload) {
    return {
      kind,
      table: tablePayload,
      truncated: walk.truncated,
      durationMs: walk.durationMs,
      rowCount: entries.length,
      decodedCount,
      host: asset.ipAddress,
      oid: baseOid,
      objectName,
    };
  }

  return {
    kind: "scalars",
    entries: entries.map(({ symbolRef: _ignored, ...rest }) => rest),
    truncated: walk.truncated,
    durationMs: walk.durationMs,
    rowCount: entries.length,
    decodedCount,
    host: asset.ipAddress,
    oid: baseOid,
    objectName,
  };
}

router.post("/:id/walk", requirePermission("mibDatabase", "read"), async (req, res, next) => {
  try {
    const parsed = WalkSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues.map((e) => e.message).join("; "));
    }

    // Load MIB + its parsed structure first so a bad object name fails before
    // we touch the asset or credential.
    const id = req.params.id as string;
    const mibRow = await getMib(id);
    const structured = parseMibStructured(mibRow.contents);
    const oidMap = await resolveSymbolsForMib(id);
    if (oidMap) {
      for (const sym of structured.symbols) {
        sym.fullOid = oidMap.get(sym.name) ?? null;
      }
    }

    res.json(
      await runMibWalk({
        structured,
        moduleName: mibRow.moduleName,
        mibId: mibRow.id,
        unresolvedOidSuffix: " — likely a missing IMPORTS dependency",
        body: parsed.data,
        actor: req.session?.username,
      }),
    );
  } catch (err) {
    next(err);
  }
});

// Group every result entry under a known MIB table by index suffix. Each
// entry's `suffix` is the arc(s) past the matched COLUMN symbol's OID — i.e.
// the row's INDEX value. Cells are keyed by column name; columns that didn't
// appear in the walk for a given row stay null.
function renderTablePayload(
  table: MibTable,
  entries: { oid: string; symbol: string | null; suffix: string | null; raw: string; decoded: string }[],
): WalkTablePayload {
  const rowMap = new Map<string, Record<string, { raw: string; decoded: string }>>();
  for (const e of entries) {
    if (!e.symbol || e.suffix === null) continue;
    if (!table.columns.includes(e.symbol)) continue;
    let cells = rowMap.get(e.suffix);
    if (!cells) {
      cells = {};
      rowMap.set(e.suffix, cells);
    }
    cells[e.symbol] = { raw: e.raw, decoded: e.decoded };
  }
  const rows = Array.from(rowMap.entries())
    .sort((a, b) => compareIndexSuffix(a[0], b[0]))
    .map(([index, cells]) => {
      const fullCells: Record<string, { raw: string; decoded: string } | null> = {};
      for (const col of table.columns) fullCells[col] = cells[col] ?? null;
      return { index, cells: fullCells };
    });
  return {
    name: table.name,
    rowSymbol: table.rowSymbol,
    columns: table.columns,
    indexNames: table.indexNames,
    rows,
  };
}

// Numeric-aware comparator for OID-suffix strings ("1" < "2" < "10").
function compareIndexSuffix(a: string, b: string): number {
  const ap = a.split(".");
  const bp = b.split(".");
  const len = Math.min(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const an = parseInt(ap[i], 10);
    const bn = parseInt(bp[i], 10);
    if (Number.isFinite(an) && Number.isFinite(bn)) {
      if (an !== bn) return an - bn;
    } else {
      const cmp = ap[i].localeCompare(bp[i]);
      if (cmp !== 0) return cmp;
    }
  }
  return ap.length - bp.length;
}

export default router;
