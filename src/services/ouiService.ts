/**
 * src/services/ouiService.ts — MAC OUI (Organizationally Unique Identifier) lookup
 *
 * Downloads the IEEE OUI database (CSV), parses it into a prefix→vendor map,
 * and stores it in the Setting table for persistence across restarts.
 * The in-memory map is loaded lazily on first lookup.
 *
 * Source: https://standards-oui.ieee.org/oui/oui.csv
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { AppError } from "../utils/errors.js";

const OUI_CSV_URL = "https://standards-oui.ieee.org/oui/oui.csv";
const SETTING_KEY = "oui_database";
const OVERRIDES_KEY = "oui_overrides";

// In-memory lookup map: "AABBCC" → "Vendor Name"
let _ouiMap: Map<string, string> | null = null;
let _lastLoaded = 0;

// In-memory overrides map: "AABBCC" → { manufacturer, device? } (takes priority over IEEE DB)
interface OverrideEntry {
  manufacturer: string;
  device?: string;
}
let _overridesMap: Map<string, OverrideEntry> = new Map();
let _overridesLoaded = false;

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Look up the manufacturer for a MAC address using the OUI prefix.
 * Returns null if no match or the database hasn't been loaded yet.
 */
export async function lookupOui(mac: string): Promise<string | null> {
  await ensureLoaded();
  await ensureOverridesLoaded();
  const prefix = normalizeMacPrefix(mac);
  if (!prefix) return null;
  // Overrides take priority
  const ov = _overridesMap.get(prefix);
  if (ov) return ov.manufacturer;
  if (!_ouiMap || _ouiMap.size === 0) return null;
  return _ouiMap.get(prefix) || null;
}

/**
 * Look up a MAC prefix and report both the IEEE-DB hit and any override,
 * so callers (the Server Settings query UI) can see exactly how the value
 * was resolved. Returns null `prefix` for malformed input.
 */
export async function lookupOuiDetailed(input: string): Promise<{
  prefix: string | null;
  normalized: string | null;
  ieee: string | null;
  override: { manufacturer: string; device?: string } | null;
  effective: string | null;
  source: "override" | "ieee" | null;
}> {
  await ensureLoaded();
  await ensureOverridesLoaded();
  // Accept either a full MAC or a bare 3-byte prefix (pad so the normalizer accepts it).
  const cleanInput = String(input || "").replace(/[:\-.\s]/g, "");
  const padded = cleanInput.length >= 6 ? cleanInput : (cleanInput + "000000").slice(0, 12);
  const normalized = normalizeMacPrefix(padded);
  if (!normalized) {
    return { prefix: null, normalized: null, ieee: null, override: null, effective: null, source: null };
  }
  const ieee = _ouiMap?.get(normalized) || null;
  const ov = _overridesMap.get(normalized) || null;
  const override = ov ? { manufacturer: ov.manufacturer, ...(ov.device ? { device: ov.device } : {}) } : null;
  const source: "override" | "ieee" | null = ov ? "override" : ieee ? "ieee" : null;
  const effective = ov ? ov.manufacturer : ieee;
  return { prefix: formatPrefix(normalized), normalized, ieee, override, effective, source };
}

/**
 * Check only the override map for a MAC address. Returns the override entry
 * (manufacturer + optional device) or null if no override exists.
 * Does NOT fall back to the IEEE DB.
 */
export async function lookupOuiOverride(
  mac: string,
): Promise<{ manufacturer: string; device?: string } | null> {
  await ensureOverridesLoaded();
  const prefix = normalizeMacPrefix(mac);
  if (!prefix) return null;
  return _overridesMap.get(prefix) || null;
}

/**
 * Download the IEEE OUI database, parse it, and persist to the Setting table.
 * Returns the number of entries parsed.
 */
export async function refreshOuiDatabase(): Promise<{ entries: number; sizeKb: number }> {
  logger.info("Downloading IEEE OUI database...");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  let csv: string;
  try {
    const res = await fetch(OUI_CSV_URL, { signal: controller.signal });
    if (!res.ok) throw new AppError(502, `HTTP ${res.status}: ${res.statusText}`);
    csv = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const map = parseCsv(csv);
  logger.info({ entries: map.size }, "Parsed OUI database");

  // Convert to a plain object for JSON storage
  const data: Record<string, string> = {};
  for (const [k, v] of map) data[k] = v;

  const payload = {
    entries: map.size,
    refreshedAt: new Date().toISOString(),
    data,
  };

  const jsonStr = JSON.stringify(payload);
  const sizeKb = Math.round(jsonStr.length / 1024);

  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: payload as any },
    create: { key: SETTING_KEY, value: payload as any },
  });

  // Update in-memory cache
  _ouiMap = map;
  _lastLoaded = Date.now();

  logger.info({ entries: map.size, sizeKb }, "OUI database saved");
  return { entries: map.size, sizeKb };
}

/**
 * Get the current OUI database status without loading the full data.
 */
export async function getOuiStatus(): Promise<{
  loaded: boolean;
  entries: number;
  refreshedAt: string | null;
}> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  if (!row?.value) return { loaded: false, entries: 0, refreshedAt: null };
  const val = row.value as any;
  return {
    loaded: true,
    entries: val.entries || 0,
    refreshedAt: val.refreshedAt || null,
  };
}

// ─── OUI Overrides ────────────────────────────────────────────────────────

export interface OuiOverride {
  prefix: string;      // "AA:BB:CC" display format
  manufacturer: string;
  device?: string;
}

/**
 * Get all static OUI overrides.
 */
export async function getOuiOverrides(): Promise<OuiOverride[]> {
  await ensureOverridesLoaded();
  const result: OuiOverride[] = [];
  for (const [prefix, entry] of _overridesMap) {
    const row: OuiOverride = { prefix: formatPrefix(prefix), manufacturer: entry.manufacturer };
    if (entry.device) row.device = entry.device;
    result.push(row);
  }
  result.sort((a, b) => a.prefix.localeCompare(b.prefix));
  return result;
}

/**
 * Add or update a static OUI override. Prefix can be in any format (AA:BB:CC, AABBCC, etc).
 */
export async function setOuiOverride(
  prefixInput: string,
  manufacturer: string,
  device?: string,
): Promise<OuiOverride> {
  const normalized = normalizeMacPrefix(prefixInput + ":00:00:00"); // pad so normalizer works
  if (!normalized) throw new AppError(400, "Invalid MAC prefix");
  await ensureOverridesLoaded();
  const entry: OverrideEntry = { manufacturer };
  if (device) entry.device = device;
  _overridesMap.set(normalized, entry);
  await persistOverrides();
  const out: OuiOverride = { prefix: formatPrefix(normalized), manufacturer };
  if (device) out.device = device;
  return out;
}

/**
 * Delete a static OUI override by prefix.
 */
export async function deleteOuiOverride(prefixInput: string): Promise<void> {
  const normalized = normalizeMacPrefix(prefixInput + ":00:00:00");
  if (!normalized) throw new AppError(400, "Invalid MAC prefix");
  await ensureOverridesLoaded();
  _overridesMap.delete(normalized);
  await persistOverrides();
}

/** Format "AABBCC" → "AA:BB:CC" */
function formatPrefix(hex: string): string {
  return hex.match(/.{2}/g)!.join(":");
}

async function persistOverrides(): Promise<void> {
  const data: Record<string, OverrideEntry> = {};
  for (const [k, v] of _overridesMap) data[k] = v;
  await prisma.setting.upsert({
    where: { key: OVERRIDES_KEY },
    update: { value: data as any },
    create: { key: OVERRIDES_KEY, value: data as any },
  });
}

async function ensureOverridesLoaded(): Promise<void> {
  if (_overridesLoaded) return;
  const row = await prisma.setting.findUnique({ where: { key: OVERRIDES_KEY } });
  if (row?.value && typeof row.value === "object") {
    const data = row.value as Record<string, string | OverrideEntry>;
    _overridesMap = new Map();
    for (const [k, v] of Object.entries(data)) {
      // Back-compat: legacy rows stored a bare manufacturer string.
      if (typeof v === "string") {
        _overridesMap.set(k, { manufacturer: v });
      } else if (v && typeof v === "object" && typeof v.manufacturer === "string") {
        const entry: OverrideEntry = { manufacturer: v.manufacturer };
        if (v.device) entry.device = v.device;
        _overridesMap.set(k, entry);
      }
    }
  }
  _overridesLoaded = true;
}

// ─── Internal ──────────────────────────────────────────────────────────────

/**
 * Extract the 3-byte OUI prefix from a MAC address.
 * Handles formats: AA:BB:CC:DD:EE:FF, AA-BB-CC-DD-EE-FF, AABBCCDDEEFF
 * Returns uppercase hex like "AABBCC" or null if invalid.
 */
function normalizeMacPrefix(mac: string): string | null {
  if (!mac) return null;
  const clean = mac.replace(/[:\-.\s]/g, "").toUpperCase();
  if (clean.length < 6) return null;
  return clean.slice(0, 6);
}

/**
 * Parse the IEEE OUI CSV format.
 * The CSV has columns: Registry,Assignment,Organization Name,Organization Address
 * Assignment is the 6-char hex prefix (e.g. "2C549A").
 */
function parseCsv(csv: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = csv.split("\n");

  // Skip header line
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Simple CSV parse — fields may be quoted
    const fields = csvSplitRow(line);
    if (fields.length < 3) continue;

    const prefix = fields[1].trim().toUpperCase();
    const vendor = fields[2].trim();

    // Validate prefix is 6 hex chars
    if (/^[0-9A-F]{6}$/.test(prefix) && vendor) {
      map.set(prefix, vendor);
    }
  }
  return map;
}

/**
 * Split a CSV row respecting quoted fields (handles commas inside quotes).
 */
function csvSplitRow(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Ensure the in-memory map is populated from the database.
 * Only reads from DB once per process (or after a refresh).
 */
async function ensureLoaded(): Promise<void> {
  if (_ouiMap && _lastLoaded > 0) return;

  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  if (!row?.value) {
    _ouiMap = new Map();
    _lastLoaded = Date.now();
    return;
  }

  const val = row.value as any;
  const data: Record<string, string> = val.data || {};
  _ouiMap = new Map(Object.entries(data));
  _lastLoaded = Date.now();
  logger.info({ entries: _ouiMap.size }, "OUI database loaded into memory");
}
