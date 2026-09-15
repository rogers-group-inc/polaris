/**
 * src/utils/assetTypes.ts
 *
 * Pure (no DB imports) registry cache + synchronous lookups for the
 * operator-extensible asset type catalogue. Lives in utils/ so the Prisma
 * extension in db.ts can validate Asset.assetType writes without cycling
 * through the asset-type service.
 *
 * Loaded by assetTypeService.refreshCache() at startup and after every CRUD
 * mutation. Until the cache is loaded, isKnownAssetType() falls back to
 * accepting the eight built-in names — keeps early boot writes legal even
 * before the cache warms.
 *
 * Code that special-cases the eight built-ins (dependencyTreeService,
 * fortinetTopology, polling source defaults, topology rendering,
 * inferAssetTypeFromOs, etc.) should import BUILT_IN_ASSET_TYPES directly
 * rather than reading the live registry — the special-case behaviors are
 * keyed on these literal names and don't extend to custom types.
 */

/**
 * The eight historical AssetType enum values plus the vCenter `hypervisor`
 * built-in (migration 20260709000000; its sibling `virtual_machine` was
 * retired 2026-07 — vCenter VMs are typed plain `server`, with the
 * Virtualization blob + vcenter-vm AssetSource row carrying VM identity).
 * Stable identifiers — code that branches on assetType uses these literals.
 * Custom types added via the registry are NOT in this list and fall through
 * to "other"-like generic behavior in every code path that uses this
 * constant. Note the Fortinet special-cases (dependency tree, topology
 * rendering, polling source defaults) key on firewall/switch/access_point
 * only — hypervisor gets its special behavior from the vCenter surfaces
 * (syncVcenterDevices, virtualization endpoint, vcenter polling method).
 */
export const BUILT_IN_ASSET_TYPES = [
  "server",
  "switch",
  "router",
  "firewall",
  "workstation",
  "printer",
  "access_point",
  "other",
  "hypervisor",
  // Azure Arc phase 4 (migration 20260807020000). A connected cluster is the
  // only Arc entity that isn't just detail on a machine, so it gets a type.
  "kubernetes_cluster",
] as const;

export type BuiltInAssetType = (typeof BUILT_IN_ASSET_TYPES)[number];

/**
 * True when `name` carries no classification: empty, or the `other`
 * catch-all. "other" means "not yet classified", not "classified as other",
 * so every merge path (operator merge, conflict accept, duplicate-hostname
 * ghost merge) treats it like an empty field — a specific type on the other
 * side wins, and "other" never overwrites a specific type.
 */
export function isGenericAssetType(name: string | null | undefined): boolean {
  if (!name) return true;
  return name.trim().toLowerCase() === "other";
}

/** Live registry cache. null = service hasn't loaded yet; fall through to the built-in set. */
let _registry: Map<string, { name: string; label: string; isBuiltIn: boolean }> | null = null;

/**
 * Replace the cache atomically. Called by assetTypeService.refreshCache().
 * Keys are stored as-is (the column is `name` which is already lowercase
 * machine value).
 */
export function setAssetTypeRegistry(entries: Iterable<{ name: string; label: string; isBuiltIn: boolean }>): void {
  const next = new Map<string, { name: string; label: string; isBuiltIn: boolean }>();
  for (const e of entries) {
    if (!e.name) continue;
    next.set(e.name, { name: e.name, label: e.label, isBuiltIn: e.isBuiltIn });
  }
  _registry = next;
}

/**
 * Returns true when `name` is a valid asset type — either a built-in or a
 * custom registry row. Until the cache loads, accepts the eight built-ins
 * only.
 */
export function isKnownAssetType(name: string | null | undefined): boolean {
  if (!name) return false;
  if (_registry !== null) return _registry.has(name);
  return (BUILT_IN_ASSET_TYPES as readonly string[]).includes(name);
}

/** Returns true when `name` matches one of the eight historical built-ins. */
export function isBuiltInAssetType(name: string | null | undefined): name is BuiltInAssetType {
  if (!name) return false;
  return (BUILT_IN_ASSET_TYPES as readonly string[]).includes(name);
}

/** Normalize a candidate type name: trim + lowercase. */
export function normalizeAssetTypeName(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Validate a candidate `name` for a CUSTOM (non-built-in) registry row at
 * write time. Returns an error message string on failure, or null on success.
 * Built-in row names are seeded by the migration and never go through this.
 */
export function validateAssetTypeName(raw: string): string | null {
  const name = normalizeAssetTypeName(raw);
  if (name.length < 2 || name.length > 32) return "Name must be 2-32 characters.";
  if (!/^[a-z0-9_-]+$/.test(name)) return "Name must contain only lowercase letters, digits, dash, and underscore.";
  if ((BUILT_IN_ASSET_TYPES as readonly string[]).includes(name)) return "Name collides with a built-in asset type.";
  return null;
}

/**
 * Validate a candidate `label` for a registry row. Returns an error message
 * string on failure, or null on success.
 */
export function validateAssetTypeLabel(raw: string): string | null {
  const label = raw.trim();
  if (label.length < 1 || label.length > 64) return "Label must be 1-64 characters.";
  return null;
}
