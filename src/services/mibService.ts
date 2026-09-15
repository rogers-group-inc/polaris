/**
 * src/services/mibService.ts — SNMP MIB module storage + validation.
 *
 * Uploaded MIB files are stored inline in the database. Each upload is run
 * through a minimal SMI parser that:
 *   1. Verifies the file is printable text (rejects binaries / executables).
 *   2. Extracts the ASN.1 module name from `<NAME> DEFINITIONS ::= BEGIN`.
 *   3. Extracts every module referenced in the `IMPORTS ... FROM <X>` block,
 *      so the UI can warn when a dependency is missing.
 *   4. Confirms the file ends in `END` (ASN.1 module terminator).
 *
 * Anything that fails these checks is rejected — this is what gates the
 * upload form against arbitrary text or attempts to smuggle code in.
 */
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { refreshRegistry, resolveSymbolAtVendorScope, listModelOverrides } from "./oidRegistry.js";
import { VENDOR_TELEMETRY_PROFILES } from "./vendorTelemetryProfiles.js";
import { stripComments } from "./mibParserUtils.js";

const MAX_BYTES = 1024 * 1024; // 1 MB — MIBs are normally <100 KB

export interface ParsedMib {
  moduleName: string;
  imports: string[];
  cleanText: string; // contents with the BOM stripped, otherwise unchanged
}

/**
 * Parse + validate a MIB. Throws AppError(400) on anything that doesn't
 * look like a real SMI module.
 */
export function parseMib(raw: string): ParsedMib {
  // BOM strip — some Windows-saved MIBs ship with a UTF-8 BOM
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  if (text.length === 0) throw new AppError(400, "MIB file is empty");
  if (text.length > MAX_BYTES) {
    throw new AppError(400, `MIB file exceeds ${MAX_BYTES} bytes`);
  }

  // Reject anything containing NUL bytes or other non-text control chars.
  // ASCII tab/CR/LF are fine; everything else <0x20 (except 0x7F) is suspicious.
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20 || code === 0x7f) {
      throw new AppError(
        400,
        "MIB file contains binary or control characters — only plain ASN.1/SMI text is accepted",
      );
    }
  }

  const stripped = stripComments(text);

  // Module declaration: `<MODULE-NAME> DEFINITIONS ::= BEGIN`
  // SMI requires an uppercase first letter; the rest is alphanumeric +
  // hyphens. RFC-canonical names commonly carry a lowercase `v` for
  // version segments (`SNMPv2-MIB`, `SNMPv2-SMI`, `SNMPv2-TC`), so the
  // body is mixed-case alphanumeric + hyphens — same tolerance the
  // IMPORTS-parser below uses.
  const headMatch = stripped.match(/([A-Z][A-Za-z0-9-]*)\s+DEFINITIONS(?:\s+[A-Z-]+)*\s*::=\s*BEGIN/);
  if (!headMatch) {
    throw new AppError(
      400,
      "MIB file is missing the `<NAME> DEFINITIONS ::= BEGIN` header — not a valid SMI module",
    );
  }
  const moduleName = headMatch[1];

  // Module must end with `END` token
  if (!/\bEND\s*$/.test(stripped.trim())) {
    throw new AppError(400, "MIB file does not end with the `END` token — file may be truncated");
  }

  // Imports — capture every `FROM <MODULE-NAME>` inside the IMPORTS block.
  // The IMPORTS block is optional but if present it terminates with `;`.
  // SMI module names are conventionally all-uppercase but RFC-published
  // canonical names (e.g. `SNMPv2-SMI`, `SNMPv2-TC`) carry a lowercase `v`,
  // so the regex tolerates mixed case and underscores.
  const imports: string[] = [];
  const importsMatch = stripped.match(/\bIMPORTS\b([\s\S]*?);/);
  if (importsMatch) {
    const seen = new Set<string>();
    const re = /\bFROM\s+([A-Za-z][\w-]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(importsMatch[1]))) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        imports.push(m[1]);
      }
    }
  }

  return { moduleName, imports, cleanText: text };
}

// ─── Structured parse (browse + walk) ─────────────────────────────────────
//
// Used by the MIB Database "Browse" modal: pull SYNTAX, ACCESS, STATUS,
// DESCRIPTION, INDEX clauses, and table structure (SEQUENCE OF) out of
// each OBJECT-TYPE so the UI can render objects with human-readable detail
// AND so the walk endpoint can decode INTEGER enums into "up(1)"-style
// labels at result time.
//
// Kept as a peer of `parseMib` rather than an extension so a regression in
// the heavier parser cannot break uploads (the upload hot path stays on
// the lighter validator).

export type MibBaseType =
  | "INTEGER"
  | "OCTET STRING"
  | "Counter32"
  | "Counter64"
  | "Gauge32"
  | "TimeTicks"
  | "OBJECT IDENTIFIER"
  | "IpAddress"
  | "BITS"
  | "SEQUENCE"
  | "SEQUENCE OF"
  | "OTHER";

export type MibAccess =
  | "read-only"
  | "read-write"
  | "read-create"
  | "not-accessible"
  | "accessible-for-notify";

export type MibStatus = "current" | "deprecated" | "obsolete";

export type MibSymbolKind =
  | "object-type"
  | "object-identity"
  | "notification-type"
  | "module-identity";

export interface MibEnumValue {
  label: string;
  value: number;
}

export interface MibSymbol {
  name: string;
  parentName: string | null;
  oidIndex: number | null;        // the integer arc under parentName, e.g. ::= { ifEntry 8 } → 8
  fullOid: string | null;         // populated by oidRegistry.resolveSymbolsForMib at request time
  kind: MibSymbolKind;
  syntax: string | null;          // verbatim text after SYNTAX
  baseType: MibBaseType;
  enumValues: MibEnumValue[] | null;
  access: MibAccess | null;
  status: MibStatus | null;
  description: string | null;     // first 4 KB, normalized whitespace
  isTableRow: boolean;
  indexNames: string[] | null;    // INDEX { ifIndex, ... } on row entries
}

export interface MibTable {
  name: string;
  rowSymbol: string;
  columns: string[];              // children of the row entry, in OID arc order
  indexNames: string[];
  description: string | null;
}

export interface ParsedMibStructured {
  moduleName: string;
  imports: string[];
  symbols: MibSymbol[];
  tables: MibTable[];
}

const ACCESS_VALUES: MibAccess[] = [
  "read-only",
  "read-write",
  "read-create",
  "not-accessible",
  "accessible-for-notify",
];
const STATUS_VALUES: MibStatus[] = ["current", "deprecated", "obsolete"];

const DESC_MAX = 4096;

// ASN.1 tokens that terminate a SYNTAX / ACCESS / STATUS / INDEX clause —
// once we hit one of these we know the previous clause's body has ended.
const CLAUSE_END_RE = /\b(MAX-ACCESS|ACCESS|STATUS|DESCRIPTION|REFERENCE|INDEX|AUGMENTS|UNITS|DEFVAL)\b|::=/;

function trimWhitespace(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

// Pull the body of the named clause (verbatim text up to the next clause
// keyword or `::=`). Spans newlines because SYNTAX (`INTEGER { a(1), b(2) }`)
// and DESCRIPTION can both run multi-line; ACCESS / STATUS / INDEX values
// just happen to fit on one line and ride the same machinery.
function extractClause(body: string, keyword: string): string | null {
  const startRe = new RegExp(`\\b${keyword}\\b`);
  const startM = body.match(startRe);
  if (!startM || startM.index == null) return null;
  const after = body.slice(startM.index + startM[0].length);
  const endM = after.match(CLAUSE_END_RE);
  const raw = endM && endM.index != null ? after.slice(0, endM.index) : after;
  return raw.trim() || null;
}

function clauseValue(body: string, keyword: string): string | null {
  const v = extractClause(body, keyword);
  return v ? trimWhitespace(v) : null;
}

function classifyBaseType(syntax: string | null, isTableEntry: boolean): MibBaseType {
  if (!syntax) return "OTHER";
  const s = syntax.replace(/\s+/g, " ").trim();
  if (/^SEQUENCE\s+OF\b/i.test(s)) return "SEQUENCE OF";
  if (isTableEntry) return "SEQUENCE";
  if (/^INTEGER(\b|\s|\(|\{)/i.test(s)) return "INTEGER";
  if (/^Integer32(\b|\s|\()/i.test(s)) return "INTEGER";
  if (/^Counter32\b/i.test(s)) return "Counter32";
  if (/^Counter64\b/i.test(s)) return "Counter64";
  if (/^Gauge32\b/i.test(s)) return "Gauge32";
  if (/^Unsigned32\b/i.test(s)) return "Gauge32";
  if (/^TimeTicks\b/i.test(s)) return "TimeTicks";
  if (/^IpAddress\b/i.test(s)) return "IpAddress";
  if (/^OCTET\s+STRING\b/i.test(s)) return "OCTET STRING";
  if (/^DisplayString\b/i.test(s)) return "OCTET STRING";
  if (/^MacAddress\b/i.test(s)) return "OCTET STRING";
  if (/^PhysAddress\b/i.test(s)) return "OCTET STRING";
  if (/^OBJECT\s+IDENTIFIER\b/i.test(s)) return "OBJECT IDENTIFIER";
  if (/^BITS\b/i.test(s)) return "BITS";
  return "OTHER";
}

function parseEnumValues(syntax: string | null): MibEnumValue[] | null {
  if (!syntax) return null;
  // Match `... { label(1), other-label(2) }` — also tolerate trailing commas
  // and labels containing hyphens.
  const m = syntax.match(/\{([^{}]+)\}/);
  if (!m) return null;
  const out: MibEnumValue[] = [];
  const re = /([A-Za-z][A-Za-z0-9-]*)\s*\(\s*(-?\d+)\s*\)/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(m[1]))) {
    out.push({ label: mm[1], value: parseInt(mm[2], 10) });
  }
  return out.length > 0 ? out : null;
}

function parseAccess(value: string | null): MibAccess | null {
  if (!value) return null;
  const lc = value.trim().toLowerCase();
  return (ACCESS_VALUES as string[]).includes(lc) ? (lc as MibAccess) : null;
}

function parseStatus(value: string | null): MibStatus | null {
  if (!value) return null;
  const lc = value.trim().toLowerCase();
  return (STATUS_VALUES as string[]).includes(lc) ? (lc as MibStatus) : null;
}

// DESCRIPTION is a quoted string — `DESCRIPTION "..."` — but the body can
// contain newlines, embedded double-quote-escapes (`""`), and gnarly
// indentation. We pull from the next `"` to the matching `"`.
function parseDescription(body: string): string | null {
  const idx = body.search(/\bDESCRIPTION\b/);
  if (idx < 0) return null;
  // Find first quote after DESCRIPTION
  const start = body.indexOf('"', idx);
  if (start < 0) return null;
  // Walk to the closing quote, treating "" as an embedded quote
  let i = start + 1;
  let out = "";
  while (i < body.length) {
    const ch = body[i];
    if (ch === '"') {
      if (body[i + 1] === '"') { out += '"'; i += 2; continue; }
      break;
    }
    out += ch;
    i++;
  }
  // Normalize whitespace and cap size
  const normalized = out.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > DESC_MAX ? normalized.slice(0, DESC_MAX) : normalized;
}

function parseIndexNames(body: string): string[] | null {
  const m = body.match(/\bINDEX\s*\{([^{}]+)\}/);
  if (!m) return null;
  const out: string[] = [];
  for (const part of m[1].split(",")) {
    const t = part.trim().replace(/^IMPLIED\s+/i, "").replace(/[^A-Za-z0-9-]/g, "");
    if (t) out.push(t);
  }
  return out.length > 0 ? out : null;
}

interface RawObjectDecl {
  name: string;
  kind: MibSymbolKind;
  body: string;       // text between the keyword and `::=`
  oidParts: string[]; // raw `::= { ... }` body split into tokens
}

// Master regex for OBJECT-TYPE / OBJECT-IDENTITY / NOTIFICATION-TYPE /
// MODULE-IDENTITY declarations. Matches lowercase-leading symbols only —
// matches the same convention used by oidRegistry's parseObjectAssignments.
//
// Note: this deliberately does NOT match `OBJECT IDENTIFIER` shorthand
// declarations like `cisco OBJECT IDENTIFIER ::= { enterprises 9 }` —
// those are caught separately because they have no body clauses.
const OBJECT_DECL_RE =
  /\b([a-z][\w-]*)\s+(OBJECT-TYPE|OBJECT-IDENTITY|NOTIFICATION-TYPE|MODULE-IDENTITY)\b([\s\S]*?)::=\s*\{\s*([^{}]+?)\s*\}/g;

// Plain `name OBJECT IDENTIFIER ::= { parent N }` shorthand
const OID_SHORTHAND_RE =
  /\b([a-z][\w-]*)\s+OBJECT\s+IDENTIFIER\s*::=\s*\{\s*([^{}]+?)\s*\}/g;

function tokenizeOidParts(raw: string): string[] {
  return raw.trim().split(/\s+/).filter(Boolean);
}

/**
 * Structured parse. Returns whatever the parser could extract; per-symbol
 * failures degrade the symbol's metadata fields to null rather than dropping
 * the symbol — operators can still walk it, they just don't get decoding.
 *
 * Throws AppError only when the file is structurally invalid (same checks
 * as `parseMib`). On a healthy MIB this always returns a populated structure.
 */
export function parseMibStructured(raw: string): ParsedMibStructured {
  const head = parseMib(raw); // throws on structural problems; reuses validation
  const stripped = stripComments(head.cleanText);

  const symbolsByName = new Map<string, MibSymbol>();

  // Pass 1 — full OBJECT-TYPE / OBJECT-IDENTITY / NOTIFICATION-TYPE /
  // MODULE-IDENTITY declarations.
  OBJECT_DECL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OBJECT_DECL_RE.exec(stripped))) {
    const name = m[1];
    const macro = m[2];
    const body = m[3];
    const oidParts = tokenizeOidParts(m[4]);

    let kind: MibSymbolKind;
    switch (macro) {
      case "OBJECT-TYPE":         kind = "object-type"; break;
      case "OBJECT-IDENTITY":     kind = "object-identity"; break;
      case "NOTIFICATION-TYPE":   kind = "notification-type"; break;
      case "MODULE-IDENTITY":     kind = "module-identity"; break;
      default:                    kind = "object-type";
    }

    const parentName = oidParts.length >= 1 && /^[a-z]/.test(oidParts[0]) ? oidParts[0] : null;
    const oidIndex =
      oidParts.length >= 2 && /^\d+$/.test(oidParts[1])
        ? parseInt(oidParts[1], 10)
        : oidParts.length === 1 && /^\d+$/.test(oidParts[0])
        ? parseInt(oidParts[0], 10)
        : null;

    const syntaxRaw = extractClause(body, "SYNTAX");
    const enumValues = parseEnumValues(syntaxRaw);
    const access = parseAccess(clauseValue(body, "MAX-ACCESS") || clauseValue(body, "ACCESS"));
    const status = parseStatus(clauseValue(body, "STATUS"));
    const description = parseDescription(body);
    const indexNames = parseIndexNames(body);

    // INDEX clause is the only definitive "this is a row" signal here —
    // matching by SYNTAX-is-CapitalizedName is unreliable (Counter32,
    // Gauge32, DisplayString, IpAddress all match the shape). Pass 3 below
    // (table detection) sets `isTableRow` for any row whose parent table
    // surfaces it via SEQUENCE OF, which catches the legitimate cases.
    const isTableRow = indexNames !== null;

    const baseType = classifyBaseType(syntaxRaw, isTableRow);

    symbolsByName.set(name, {
      name,
      parentName,
      oidIndex,
      fullOid: null,
      kind,
      syntax: syntaxRaw,
      baseType,
      enumValues,
      access,
      status,
      description,
      isTableRow,
      indexNames,
    });
  }

  // Pass 2 — `name OBJECT IDENTIFIER ::= { parent N }` shorthand. These
  // never carry SYNTAX/ACCESS/DESCRIPTION clauses but they're real OIDs we
  // want surfaced (they appear as group nodes in the browse tree).
  OID_SHORTHAND_RE.lastIndex = 0;
  while ((m = OID_SHORTHAND_RE.exec(stripped))) {
    const name = m[1];
    if (symbolsByName.has(name)) continue; // already captured by pass 1
    const oidParts = tokenizeOidParts(m[2]);
    const parentName = oidParts.length >= 1 && /^[a-z]/.test(oidParts[0]) ? oidParts[0] : null;
    const oidIndex =
      oidParts.length >= 2 && /^\d+$/.test(oidParts[1])
        ? parseInt(oidParts[1], 10)
        : null;
    symbolsByName.set(name, {
      name,
      parentName,
      oidIndex,
      fullOid: null,
      kind: "object-identity",
      syntax: null,
      baseType: "OBJECT IDENTIFIER",
      enumValues: null,
      access: null,
      status: null,
      description: null,
      isTableRow: false,
      indexNames: null,
    });
  }

  // Pass 3 — table detection. Any symbol whose SYNTAX is `SEQUENCE OF X` is
  // a table; the row is the symbol whose parent equals the table's name AND
  // whose SYNTAX/text matches X (or has an INDEX clause).
  const tables: MibTable[] = [];
  for (const sym of symbolsByName.values()) {
    if (sym.baseType !== "SEQUENCE OF") continue;
    const seqOfMatch = sym.syntax?.match(/^SEQUENCE\s+OF\s+([A-Za-z][\w]*)/i);
    const rowTypeName = seqOfMatch ? seqOfMatch[1] : null;

    // Prefer a child whose SYNTAX matches the row type name; fall back to any
    // child with an INDEX clause; final fallback any single child.
    const children = Array.from(symbolsByName.values()).filter(
      (s) => s.parentName === sym.name,
    );
    let row: MibSymbol | undefined;
    if (rowTypeName) {
      row = children.find((c) => c.syntax?.trim() === rowTypeName);
    }
    if (!row) row = children.find((c) => c.indexNames !== null);
    if (!row && children.length === 1) row = children[0];
    if (!row) continue;

    // Mark the row entry as a row even if heuristics didn't already.
    row.isTableRow = true;
    if (row.baseType === "OTHER") row.baseType = "SEQUENCE";

    const columns = Array.from(symbolsByName.values())
      .filter((s) => s.parentName === row!.name)
      .sort((a, b) => (a.oidIndex ?? 0) - (b.oidIndex ?? 0))
      .map((s) => s.name);

    tables.push({
      name: sym.name,
      rowSymbol: row.name,
      columns,
      indexNames: row.indexNames || [],
      description: sym.description,
    });
  }

  // Sort symbols stably by name for deterministic API responses.
  const symbols = Array.from(symbolsByName.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return {
    moduleName: head.moduleName,
    imports: head.imports,
    symbols,
    tables: tables.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ─── CRUD ──────────────────────────────────────────────────────────────────

export interface MibSummary {
  id: string;
  filename: string;
  moduleName: string;
  manufacturer: string | null;
  model: string | null;
  imports: string[];
  size: number;
  notes: string | null;
  uploadedBy: string | null;
  uploadedAt: Date;
}

export interface MibFilter {
  manufacturer?: string | null; // null = generic only; undefined = no filter
  model?: string | null;
  scope?: "all" | "device" | "generic";
}

export async function listMibs(filter: MibFilter = {}): Promise<MibSummary[]> {
  const where: Record<string, unknown> = {};
  if (filter.scope === "generic") where.manufacturer = null;
  if (filter.scope === "device") where.manufacturer = { not: null };
  if (filter.manufacturer !== undefined && filter.scope !== "generic") {
    where.manufacturer = filter.manufacturer === null ? null : { equals: filter.manufacturer, mode: "insensitive" };
  }
  if (filter.model !== undefined) {
    where.model = filter.model === null ? null : { equals: filter.model, mode: "insensitive" };
  }

  const rows = await prisma.mibFile.findMany({
    where,
    orderBy: [{ manufacturer: "asc" }, { model: "asc" }, { moduleName: "asc" }],
    select: {
      id: true,
      filename: true,
      moduleName: true,
      manufacturer: true,
      model: true,
      imports: true,
      size: true,
      notes: true,
      uploadedBy: true,
      uploadedAt: true,
    },
  });
  return rows;
}

export async function getMib(id: string): Promise<{
  id: string;
  filename: string;
  moduleName: string;
  manufacturer: string | null;
  model: string | null;
  contents: string;
  imports: string[];
  size: number;
  notes: string | null;
  uploadedBy: string | null;
  uploadedAt: Date;
}> {
  const row = await prisma.mibFile.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "MIB not found");
  return row;
}

export interface CreateMibInput {
  filename: string;
  contents: string;
  manufacturer?: string | null;
  model?: string | null;
  notes?: string | null;
  uploadedBy?: string | null;
}

export async function createMib(input: CreateMibInput): Promise<MibSummary> {
  const filename = (input.filename || "").trim();
  if (!filename) throw new AppError(400, "filename is required");

  const manufacturer = input.manufacturer?.trim() || null;
  const model = input.model?.trim() || null;
  if (!manufacturer && model) {
    throw new AppError(400, "model cannot be set without a manufacturer (generic MIBs apply to all devices)");
  }

  const parsed = parseMib(input.contents);

  // Reject duplicate (manufacturer, model, moduleName) — Postgres uniqueness
  // treats NULLs as distinct so we still need to check generic MIBs by hand.
  const existing = await prisma.mibFile.findFirst({
    where: {
      manufacturer,
      model,
      moduleName: parsed.moduleName,
    },
    select: { id: true },
  });
  if (existing) {
    throw new AppError(
      409,
      `A MIB module named "${parsed.moduleName}" is already uploaded for this manufacturer/model — delete the existing one first`,
    );
  }

  const created = await prisma.mibFile.create({
    data: {
      filename,
      moduleName: parsed.moduleName,
      manufacturer,
      model,
      contents: parsed.cleanText,
      imports: parsed.imports,
      size: parsed.cleanText.length,
      notes: input.notes?.trim() || null,
      uploadedBy: input.uploadedBy || null,
    },
    select: {
      id: true,
      filename: true,
      moduleName: true,
      manufacturer: true,
      model: true,
      imports: true,
      size: true,
      notes: true,
      uploadedBy: true,
      uploadedAt: true,
    },
  });
  // Reload the OID symbol table so the new MIB's symbols are immediately
  // resolvable by the monitoring probe (next tick onward).
  refreshRegistry().catch(() => {});
  return created;
}

export async function deleteMib(id: string): Promise<void> {
  try {
    await prisma.mibFile.delete({ where: { id } });
  } catch {
    throw new AppError(404, "MIB not found");
  }
  refreshRegistry().catch(() => {});
}

/**
 * Manufacturer + per-manufacturer model facets, used to seed the upload form
 * dropdowns. Combines distinct values from already-uploaded MIBs with distinct
 * values from the asset inventory so the picker isn't empty before the first
 * MIB is uploaded.
 */
export async function getMibFacets(): Promise<{
  manufacturers: string[];
  modelsByManufacturer: Record<string, string[]>;
}> {
  const [mibRows, assetRows] = await Promise.all([
    prisma.mibFile.findMany({
      where: { manufacturer: { not: null } },
      select: { manufacturer: true, model: true },
      distinct: ["manufacturer", "model"],
    }),
    prisma.asset.findMany({
      where: { manufacturer: { not: null } },
      select: { manufacturer: true, model: true },
      distinct: ["manufacturer", "model"],
    }),
  ]);

  const manufacturers = new Set<string>();
  const models: Record<string, Set<string>> = {};

  for (const r of [...mibRows, ...assetRows]) {
    const m = r.manufacturer?.trim();
    if (!m) continue;
    manufacturers.add(m);
    if (!models[m]) models[m] = new Set();
    if (r.model && r.model.trim()) models[m].add(r.model.trim());
  }

  const modelsByManufacturer: Record<string, string[]> = {};
  for (const m of Object.keys(models)) {
    modelsByManufacturer[m] = Array.from(models[m]).sort();
  }

  return {
    manufacturers: Array.from(manufacturers).sort(),
    modelsByManufacturer,
  };
}

// ─── Vendor profile status ────────────────────────────────────────────────
//
// Used by the MIB Database card to show, per built-in vendor profile, whether
// the symbols it queries can be resolved at the **universal** scope (i.e. by
// generic + manufacturer-wide MIBs alone, without any model-specific upload).
// Each profile also reports any model-specific MIBs that were layered on top
// for the same manufacturer — those are device overrides, not part of the
// universal floor.

export interface ProfileSymbolStatus {
  metric:
    | "cpu"
    | "memory.used"
    | "memory.free"
    | "memory.total"
    | "memory.pct"
    | "disk.used"
    | "disk.total"
    | "disk.free"
    | "temperature";
  symbol: string;
  resolved: boolean;
  fromModuleName: string | null;
  fromScope: "device" | "vendor" | "generic" | "standard" | "seed" | null;
}

export interface ProfileStatus {
  vendor: string;
  matchPattern: string;
  example: string;            // first manufacturer string that matches the regex (or "" if none)
  symbols: ProfileSymbolStatus[];
  ready: boolean;             // true if every symbol declared by the profile resolves
  partial: boolean;           // true if at least one (but not all) resolve
  modelOverrides: { model: string; mibCount: number }[];
}

/**
 * Pick a representative manufacturer string for a profile. The match regex
 * is what determines applicability at probe time; for the UI we want a real
 * manufacturer string we've seen on assets or in MIB rows so the resolver can
 * compute against the same scope key the probe will use. Falls back to the
 * profile's first regex alternative when nothing matches yet.
 */
async function exampleManufacturerForProfile(match: RegExp): Promise<string> {
  const [mibRows, assetRows] = await Promise.all([
    prisma.mibFile.findMany({
      where: { manufacturer: { not: null } },
      select: { manufacturer: true },
      distinct: ["manufacturer"],
    }),
    prisma.asset.findMany({
      where: { manufacturer: { not: null } },
      select: { manufacturer: true },
      distinct: ["manufacturer"],
    }),
  ]);
  const candidates = new Set<string>();
  for (const r of [...mibRows, ...assetRows]) {
    if (r.manufacturer) candidates.add(r.manufacturer.trim());
  }
  for (const c of candidates) {
    if (match.test(c)) return c;
  }
  // Fallback: first alternative in the regex source. Crude but readable —
  // strips flags, anchors, and alternation pipes.
  const src = match.source.replace(/^[\\^?(]+|[\\$?)]+$/g, "");
  const first = src.split("|")[0].replace(/[^A-Za-z0-9-]/g, "");
  return first || "(any)";
}

export async function getProfileStatus(): Promise<ProfileStatus[]> {
  const out: ProfileStatus[] = [];

  for (const profile of VENDOR_TELEMETRY_PROFILES) {
    const example = await exampleManufacturerForProfile(profile.match);
    const symbols: ProfileSymbolStatus[] = [];

    if (profile.cpu) {
      const r = await resolveSymbolAtVendorScope(example, profile.cpu.symbol);
      symbols.push({
        metric: "cpu",
        symbol: profile.cpu.symbol,
        resolved: r.resolved,
        fromModuleName: r.fromModuleName,
        fromScope: r.fromScope,
      });
    }
    if (profile.memory?.usedBytesSymbol) {
      const r = await resolveSymbolAtVendorScope(example, profile.memory.usedBytesSymbol);
      symbols.push({ metric: "memory.used", symbol: profile.memory.usedBytesSymbol, resolved: r.resolved, fromModuleName: r.fromModuleName, fromScope: r.fromScope });
    }
    if (profile.memory?.freeBytesSymbol) {
      const r = await resolveSymbolAtVendorScope(example, profile.memory.freeBytesSymbol);
      symbols.push({ metric: "memory.free", symbol: profile.memory.freeBytesSymbol, resolved: r.resolved, fromModuleName: r.fromModuleName, fromScope: r.fromScope });
    }
    if (profile.memory?.totalBytesSymbol) {
      const r = await resolveSymbolAtVendorScope(example, profile.memory.totalBytesSymbol);
      symbols.push({ metric: "memory.total", symbol: profile.memory.totalBytesSymbol, resolved: r.resolved, fromModuleName: r.fromModuleName, fromScope: r.fromScope });
    }
    if (profile.memory?.pctSymbol) {
      const r = await resolveSymbolAtVendorScope(example, profile.memory.pctSymbol);
      symbols.push({ metric: "memory.pct", symbol: profile.memory.pctSymbol, resolved: r.resolved, fromModuleName: r.fromModuleName, fromScope: r.fromScope });
    }
    if (profile.disk?.usedBytesSymbol) {
      const r = await resolveSymbolAtVendorScope(example, profile.disk.usedBytesSymbol);
      symbols.push({ metric: "disk.used", symbol: profile.disk.usedBytesSymbol, resolved: r.resolved, fromModuleName: r.fromModuleName, fromScope: r.fromScope });
    }
    if (profile.disk?.totalBytesSymbol) {
      const r = await resolveSymbolAtVendorScope(example, profile.disk.totalBytesSymbol);
      symbols.push({ metric: "disk.total", symbol: profile.disk.totalBytesSymbol, resolved: r.resolved, fromModuleName: r.fromModuleName, fromScope: r.fromScope });
    }
    if (profile.disk?.freeBytesSymbol) {
      const r = await resolveSymbolAtVendorScope(example, profile.disk.freeBytesSymbol);
      symbols.push({ metric: "disk.free", symbol: profile.disk.freeBytesSymbol, resolved: r.resolved, fromModuleName: r.fromModuleName, fromScope: r.fromScope });
    }
    if (profile.temperature?.symbol) {
      const r = await resolveSymbolAtVendorScope(example, profile.temperature.symbol);
      symbols.push({ metric: "temperature", symbol: profile.temperature.symbol, resolved: r.resolved, fromModuleName: r.fromModuleName, fromScope: r.fromScope });
    }

    const resolvedCount = symbols.filter((s) => s.resolved).length;
    const ready = symbols.length > 0 && resolvedCount === symbols.length;
    const partial = resolvedCount > 0 && !ready;

    const modelOverrides = example !== "(any)" ? await listModelOverrides(example) : [];

    out.push({
      vendor: profile.vendor,
      matchPattern: profile.match.source,
      example,
      symbols,
      ready,
      partial,
      modelOverrides,
    });
  }

  return out;
}
