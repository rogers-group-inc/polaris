/**
 * src/services/manufacturerProfilePortabilityService.ts — export a manufacturer
 * profile to a portable JSON file, and import one item by item.
 *
 * The file carries NO install-specific ids and NO secrets:
 *  - an uploaded MIB is named by `{ moduleName, manufacturer, model }`, never by
 *    its row id, and is NOT bundled (a vendor MIB is the vendor's file, often
 *    megabytes, and the importing install may already have its own copy);
 *  - an HTTP check's credential is named by its `name` only;
 *  - the Custom MIB layout names widgets by the file's own `key`, not their id.
 *
 * Import is two calls. `previewProfileImport` validates the file and lists
 * every importable item with what it would do — create, or REPLACE an existing
 * row — and what it is missing: an uploaded MIB that is not on this install
 * (a widget without its MIB cannot be imported, so it is offered disabled), or
 * a credential name with no match (the check imports unauthenticated).
 * `applyProfileImport` then imports only the item ids the operator ticked,
 * through the same service functions the profile page writes with, so an
 * imported row meets exactly the rules a hand-made one does. One failing item
 * does not stop the rest; each reports its own outcome.
 *
 * Per-asset widget switches (business rule 130) are deliberately NOT exported:
 * they name assets, which are this install's.
 */

import { z } from "zod";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { normalizeManufacturer } from "../utils/manufacturerNormalize.js";
import { logEvent } from "./eventLogService.js";
import {
  getProfile,
  getProfileFor,
  createProfile,
  updateProfile,
  updateMetricRow,
  createOverride,
  updateOverride,
  createWidget,
  updateWidget,
  setWidgetLayout,
  refreshProfileCache,
  type ProfileFull,
} from "./manufacturerProfileService.js";

export const PROFILE_FILE_FORMAT = "polaris.manufacturer-profile";
export const PROFILE_FILE_VERSION = 1;

// ─── File shape ───────────────────────────────────────────────────────────

const MibRefSchema = z.object({
  moduleName:   z.string().min(1).max(200),
  manufacturer: z.string().max(200).nullable(),
  model:        z.string().max(200).nullable(),
});
export type MibRef = z.infer<typeof MibRefSchema>;

const RowFieldsSchema = {
  symbol:        z.string().max(200).nullable(),
  symbolB:       z.string().max(200).nullable(),
  mib:           MibRefSchema.nullable(),
  mibStdKey:     z.string().max(64).nullable(),
  type:          z.string().max(32),
  transform:     z.string().max(64).nullable(),
  aggregate:     z.string().max(32).nullable(),
  label:         z.string().max(200).nullable(),
  parsePattern:  z.string().max(1000).nullable(),
  parseTemplate: z.string().max(1000).nullable(),
};

const OverrideSchema = z.object({
  ...RowFieldsSchema,
  symbol:       z.string().min(1).max(200),
  assetType:    z.string().max(100).nullable(),
  modelPattern: z.string().max(1000).nullable(),
  order:        z.number().int(),
});

const MetricSchema = z.object({
  metricKey: z.string().min(1).max(64),
  ...RowFieldsSchema,
  overrides: z.array(OverrideSchema).max(500),
});

const WidgetSchema = z.object({
  key:            z.string().min(1).max(64),
  name:           z.string().min(1).max(200),
  symbol:         z.string().max(200).nullable(),
  mib:            MibRefSchema.nullable(),
  type:           z.string().max(32),
  widgetType:     z.string().max(32),
  transform:      z.string().max(64).nullable(),
  displayOptions: z.record(z.string(), z.unknown()),
  order:          z.number().int(),
  modelPattern:   z.string().max(1000).nullable(),
  stateMap:       z.unknown().nullable(),
  labelSymbol:    z.string().max(200).nullable(),
  httpCheck:      z.record(z.string(), z.unknown()).nullable(),
  credential:     z.object({ name: z.string().min(1).max(200) }).nullable(),
});

const LayoutSchema = z.object({
  version: z.literal(1),
  columns: z.array(z.object({
    id:      z.string().min(1).max(64),
    width:   z.number(),
    widgets: z.array(z.object({ key: z.string().min(1).max(64), height: z.number() })).max(500),
  })).max(48),
});

export const ProfileFileSchema = z.object({
  format:       z.literal(PROFILE_FILE_FORMAT),
  version:      z.literal(PROFILE_FILE_VERSION),
  exportedAt:   z.string().optional(),
  manufacturer: z.string().min(1).max(200),
  matchPattern: z.string().max(1000).nullable(),
  mibs:         z.array(MibRefSchema).max(500),
  metrics:      z.array(MetricSchema).max(50),
  widgets:      z.array(WidgetSchema).max(500),
  layout:       LayoutSchema.nullable(),
});
export type ProfileFile = z.infer<typeof ProfileFileSchema>;

/** Parse an uploaded file body, with one readable error rather than a zod dump. */
export function parseProfileFile(raw: unknown): ProfileFile {
  const parsed = ProfileFileSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path?.length ? ` (at ${first.path.join(".")})` : "";
    throw new AppError(400, `Not a Polaris manufacturer profile file: ${first?.message ?? "invalid"}${where}`);
  }
  return parsed.data;
}

// ─── Export ───────────────────────────────────────────────────────────────

const mibKey = (r: MibRef) => `${r.moduleName}|${r.manufacturer ?? ""}|${r.model ?? ""}`.toLowerCase();

export async function exportProfile(profileId: string): Promise<ProfileFile> {
  const profile = await getProfile(profileId);
  if (!profile) throw new AppError(404, "Profile not found");

  const mibIds = new Set<string>();
  for (const m of profile.metrics) {
    if (m.defaultMibId) mibIds.add(m.defaultMibId);
    for (const o of m.overrides) if (o.mibId) mibIds.add(o.mibId);
  }
  for (const w of profile.widgets) if (w.mibId) mibIds.add(w.mibId);
  const credIds = profile.widgets.map((w) => w.credentialId).filter((c): c is string => !!c);

  const [mibRows, credRows] = await Promise.all([
    prisma.mibFile.findMany({ where: { id: { in: [...mibIds] } }, select: { id: true, moduleName: true, manufacturer: true, model: true } }),
    prisma.credential.findMany({ where: { id: { in: credIds } }, select: { id: true, name: true } }),
  ]);
  const mibById = new Map(mibRows.map((m) => [m.id, { moduleName: m.moduleName, manufacturer: m.manufacturer, model: m.model }]));
  const credById = new Map(credRows.map((c) => [c.id, c.name]));
  const mibOf = (id: string | null) => (id ? mibById.get(id) ?? null : null);

  const keyById = new Map<string, string>();
  profile.widgets.forEach((w, i) => keyById.set(w.id, `w${i + 1}`));

  const file: ProfileFile = {
    format:       PROFILE_FILE_FORMAT,
    version:      PROFILE_FILE_VERSION,
    exportedAt:   new Date().toISOString(),
    manufacturer: profile.manufacturer,
    matchPattern: profile.matchPattern,
    mibs:         [...new Map(mibRows.map((m) => {
      const ref = { moduleName: m.moduleName, manufacturer: m.manufacturer, model: m.model };
      return [mibKey(ref), ref] as const;
    })).values()],
    // Only rows that say something: an unconfigured row is the built-in seed.
    metrics: profile.metrics
      .filter((m) => m.defaultSymbol || m.defaultSymbolB || m.overrides.length)
      .map((m) => ({
        metricKey:     m.metricKey,
        symbol:        m.defaultSymbol,
        symbolB:       m.defaultSymbolB,
        mib:           mibOf(m.defaultMibId),
        mibStdKey:     m.defaultMibStdKey,
        type:          m.defaultType,
        transform:     m.defaultTransform,
        aggregate:     m.defaultAggregate,
        label:         m.defaultLabel,
        parsePattern:  m.defaultParsePattern,
        parseTemplate: m.defaultParseTemplate,
        overrides: m.overrides.map((o) => ({
          assetType: o.assetType, modelPattern: o.modelPattern,
          symbol: o.symbol, symbolB: o.symbolB, mib: mibOf(o.mibId), mibStdKey: o.mibStdKey,
          type: o.type, transform: o.transform, aggregate: o.aggregate, label: o.label,
          parsePattern: o.parsePattern, parseTemplate: o.parseTemplate, order: o.order,
        })),
      })),
    widgets: profile.widgets.map((w) => ({
      key:            keyById.get(w.id) as string,
      name:           w.name,
      symbol:         w.symbol,
      mib:            mibOf(w.mibId),
      type:           w.type,
      widgetType:     w.widgetType,
      transform:      w.transform,
      displayOptions: w.displayOptions ?? {},
      order:          w.order,
      modelPattern:   w.modelPattern,
      stateMap:       w.stateMap,
      labelSymbol:    w.labelSymbol,
      httpCheck:      w.httpCheck,
      credential:     w.credentialId && credById.has(w.credentialId) ? { name: credById.get(w.credentialId) as string } : null,
    })),
    layout: profile.widgetLayout
      ? {
          version: 1,
          columns: profile.widgetLayout.columns.map((c) => ({
            id: c.id,
            width: c.width,
            widgets: c.widgets
              .filter((x) => keyById.has(x.id))
              .map((x) => ({ key: keyById.get(x.id) as string, height: x.height })),
          })),
        }
      : null,
  };
  return file;
}

// ─── Preview ──────────────────────────────────────────────────────────────

export type ImportItemKind = "settings" | "metric" | "override" | "widget" | "layout";

export interface ImportItem {
  id:       string;
  kind:     ImportItemKind;
  label:    string;
  /** create = new on this install; replace = overwrites an existing row. */
  action:   "create" | "replace";
  /** Uploaded MIBs this item names that this install does not have. */
  missingMibs: MibRef[];
  /** A credential name with no match here (the check imports unauthenticated). */
  missingCredential: string | null;
  /** Cannot be imported as is — the reason. A blocked item is offered disabled. */
  blocked:  string | null;
}

export interface ImportPreview {
  manufacturer: string;
  /** The profile items would land in; null = a new profile is created. */
  targetProfileId: string | null;
  items: ImportItem[];
  /** Every uploaded MIB the file names, and whether this install has it. */
  mibs: Array<MibRef & { present: boolean }>;
}

/**
 * Find this install's copy of a MIB the file names. A vendor MIB's
 * manufacturer is alias-normalized on write, and two installs may spell a
 * vendor differently, so the target profile's own manufacturer counts as a
 * match too; then the file's manufacturer; then a generic upload.
 */
async function mibResolver(targetManufacturer: string) {
  const rows = await prisma.mibFile.findMany({ select: { id: true, moduleName: true, manufacturer: true, model: true } });
  return (ref: MibRef | null): string | null => {
    if (!ref) return null;
    const same = rows.filter((r) => r.moduleName.toLowerCase() === ref.moduleName.toLowerCase());
    const mfrs = [targetManufacturer, ref.manufacturer].filter((m): m is string => !!m).map((m) => m.toLowerCase());
    const pick =
      same.find((r) => r.manufacturer && mfrs.includes(r.manufacturer.toLowerCase()) && (r.model ?? null) === (ref.model ?? null)) ??
      same.find((r) => r.manufacturer && mfrs.includes(r.manufacturer.toLowerCase()) && !r.model) ??
      same.find((r) => !r.manufacturer);
    return pick?.id ?? null;
  };
}

const overrideScopeKey = (o: { assetType: string | null; modelPattern: string | null }) =>
  `${(o.assetType ?? "").toLowerCase()}|${o.modelPattern ?? ""}`;

function overrideLabel(metricKey: string, o: { assetType: string | null; modelPattern: string | null }): string {
  const scope = o.assetType && o.modelPattern ? `${o.assetType} / ${o.modelPattern}` : o.assetType ? `${o.assetType} default` : String(o.modelPattern);
  return `${metricKey} — ${scope}`;
}

function rowMissing(resolve: (r: MibRef | null) => string | null, refs: Array<MibRef | null>): MibRef[] {
  return refs.filter((r): r is MibRef => !!r && !resolve(r));
}

async function planImport(file: ProfileFile) {
  const canonical = normalizeManufacturer(file.manufacturer) ?? file.manufacturer;
  await refreshProfileCache();
  const existing: ProfileFull | null = getProfileFor(canonical);
  const resolve = await mibResolver(canonical);
  const credNames = new Set(
    (await prisma.credential.findMany({ select: { name: true } })).map((c) => c.name.toLowerCase()),
  );
  return { canonical, existing, resolve, credNames };
}

export async function previewProfileImport(raw: unknown): Promise<ImportPreview> {
  const file = parseProfileFile(raw);
  const { canonical, existing, resolve, credNames } = await planImport(file);
  const items: ImportItem[] = [];
  const base = { missingMibs: [] as MibRef[], missingCredential: null, blocked: null };

  items.push({
    ...base, id: "settings", kind: "settings",
    label: file.matchPattern ? `Profile settings ("also applies when" ${file.matchPattern})` : "Profile settings",
    action: existing ? "replace" : "create",
  });

  for (const m of file.metrics) {
    const row = existing?.metrics.find((x) => x.metricKey === m.metricKey);
    if (m.symbol || m.symbolB) {
      items.push({
        ...base, id: `metric:${m.metricKey}`, kind: "metric",
        label: `${m.metricKey} — ${[m.symbol, m.symbolB].filter(Boolean).join(" + ")}`,
        action: row && (row.defaultSymbol || row.defaultSymbolB) ? "replace" : "create",
        missingMibs: rowMissing(resolve, [m.mib]),
      });
    }
    m.overrides.forEach((o, i) => {
      const clash = row?.overrides.find((x) => overrideScopeKey(x) === overrideScopeKey(o));
      items.push({
        ...base, id: `override:${m.metricKey}:${i}`, kind: "override",
        label: overrideLabel(m.metricKey, o),
        action: clash ? "replace" : "create",
        missingMibs: rowMissing(resolve, [o.mib]),
      });
    });
  }

  for (const w of file.widgets) {
    const clash = existing?.widgets.find((x) => x.name.toLowerCase() === w.name.toLowerCase());
    const missingMibs = w.widgetType === "http" ? [] : rowMissing(resolve, [w.mib]);
    const missingCredential = w.credential && !credNames.has(w.credential.name.toLowerCase()) ? w.credential.name : null;
    items.push({
      id: `widget:${w.key}`, kind: "widget",
      label: `${w.name} (${w.widgetType})`,
      action: clash ? "replace" : "create",
      missingMibs, missingCredential,
      // A widget's MIB is required (manufacturerProfileService.createWidget),
      // so it cannot land until the MIB is uploaded here.
      blocked: missingMibs.length ? `Upload ${missingMibs.map((r) => r.moduleName).join(", ")} first` : null,
    });
  }

  if (file.layout && file.layout.columns.length) {
    items.push({
      ...base, id: "layout", kind: "layout", label: "Custom MIB tab layout",
      action: existing?.widgetLayout ? "replace" : "create",
    });
  }

  return {
    manufacturer: canonical,
    targetProfileId: existing?.id ?? null,
    items,
    mibs: file.mibs.map((r) => ({ ...r, present: !!resolve(r) })),
  };
}

// ─── Apply ────────────────────────────────────────────────────────────────

export interface ImportResult {
  profileId: string;
  results: Array<{ id: string; ok: boolean; error?: string }>;
}

export async function applyProfileImport(raw: unknown, selected: string[], actor?: string): Promise<ImportResult> {
  const file = parseProfileFile(raw);
  const want = new Set(selected);
  const { canonical, existing, resolve, credNames } = await planImport(file);
  const results: ImportResult["results"] = [];
  const attempt = async (id: string, fn: () => Promise<unknown>) => {
    if (!want.has(id)) return;
    try {
      await fn();
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  // The profile itself: reuse the one keyed by this manufacturer, else create.
  const profile = existing ?? await createProfile({ manufacturer: canonical, createdBy: actor ?? null });
  const profileId = profile.id;

  await attempt("settings", () => updateProfile(profileId, { matchPattern: file.matchPattern }));

  const current = await getProfile(profileId);
  for (const m of file.metrics) {
    await attempt(`metric:${m.metricKey}`, () => updateMetricRow(profileId, m.metricKey, {
      defaultSymbol: m.symbol, defaultSymbolB: m.symbolB,
      defaultMibId: resolve(m.mib), defaultMibStdKey: m.mibStdKey,
      defaultType: m.type, defaultTransform: m.transform, defaultAggregate: m.aggregate,
      defaultLabel: m.label, defaultParsePattern: m.parsePattern, defaultParseTemplate: m.parseTemplate,
    }));
    const row = current?.metrics.find((x) => x.metricKey === m.metricKey);
    for (let i = 0; i < m.overrides.length; i++) {
      const o = m.overrides[i];
      const input = {
        assetType: o.assetType, modelPattern: o.modelPattern, symbol: o.symbol, symbolB: o.symbolB,
        mibId: resolve(o.mib), mibStdKey: o.mibStdKey, type: o.type, transform: o.transform,
        aggregate: o.aggregate, label: o.label, parsePattern: o.parsePattern, parseTemplate: o.parseTemplate,
        order: o.order,
      };
      const clash = row?.overrides.find((x) => overrideScopeKey(x) === overrideScopeKey(o));
      await attempt(`override:${m.metricKey}:${i}`, () =>
        clash ? updateOverride(clash.id, input) : createOverride(profileId, m.metricKey, input));
    }
  }

  const credRows = await prisma.credential.findMany({ select: { id: true, name: true } });
  const idByKey = new Map<string, string>();
  for (const w of current?.widgets ?? []) {
    const fromFile = file.widgets.find((x) => x.name.toLowerCase() === w.name.toLowerCase());
    if (fromFile) idByKey.set(fromFile.key, w.id);
  }
  for (const w of file.widgets) {
    const mibId = w.widgetType === "http" ? null : resolve(w.mib);
    const credentialId = w.credential && credNames.has(w.credential.name.toLowerCase())
      ? credRows.find((c) => c.name.toLowerCase() === w.credential!.name.toLowerCase())?.id ?? null
      : null;
    const input = {
      name: w.name, symbol: w.symbol as string, mibId: mibId as string, type: w.type, widgetType: w.widgetType,
      transform: w.transform, displayOptions: w.displayOptions, order: w.order, modelPattern: w.modelPattern,
      stateMap: w.stateMap, labelSymbol: w.labelSymbol, httpCheck: w.httpCheck, credentialId,
    };
    const clash = current?.widgets.find((x) => x.name.toLowerCase() === w.name.toLowerCase());
    await attempt(`widget:${w.key}`, async () => {
      if (w.widgetType !== "http" && !mibId) {
        throw new AppError(400, `MIB ${w.mib?.moduleName ?? "(none)"} is not uploaded on this install`);
      }
      const saved = clash ? await updateWidget(clash.id, input) : await createWidget(profileId, { ...input, createdBy: actor ?? null });
      idByKey.set(w.key, saved.id);
    });
  }

  if (file.layout) {
    await attempt("layout", () => setWidgetLayout(profileId, {
      version: 1,
      columns: file.layout!.columns.map((c) => ({
        id: c.id,
        width: c.width,
        widgets: c.widgets.filter((x) => idByKey.has(x.key)).map((x) => ({ id: idByKey.get(x.key), height: x.height })),
      })),
    }));
  }

  await refreshProfileCache();
  const ok = results.filter((r) => r.ok).length;
  await logEvent({
    action:       "manufacturer_profile.imported",
    resourceType: "manufacturer_profile",
    resourceId:   profileId,
    resourceName: canonical,
    actor,
    level:        results.some((r) => !r.ok) ? "warning" : "info",
    message:      `Imported ${ok} of ${results.length} selected item(s) into the ${canonical} manufacturer profile${existing ? "" : " (new profile)"}`,
    details:      { results },
  });
  return { profileId, results };
}
