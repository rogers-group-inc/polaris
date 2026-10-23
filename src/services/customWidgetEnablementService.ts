/**
 * src/services/customWidgetEnablementService.ts — which manufacturer custom
 * widgets poll which assets (business rule 130).
 *
 * A widget APPLIES to every asset its profile GOVERNS — the profile keyed by
 * the asset's canonical manufacturer, else the first whose "also applies when"
 * `matchPattern` matches (business rule 131, the same `findDbProfile` the
 * telemetry collectors use) — and whose model satisfies the widget's optional
 * model pattern. It
 * POLLS only the assets it is switched on for: one AssetCustomWidgetEnable row
 * per (asset, widget). Applying is a matter of definition; polling is the
 * operator's decision, made per asset from the Custom MIB tab or in bulk from
 * the Manufacturer Profiles card.
 *
 * Every write is audited per ASSET (the switch changes what Polaris asks that
 * device), batched into one insert so a 2000-asset bulk enable is one round
 * trip, not 2000.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { tryCompileSafeRegex } from "../utils/safeRegex.js";
import { logEventsBatch, type LogEventInput } from "./eventLogService.js";
import { findDbProfile } from "./profileResolver.js";
import { refreshProfileCacheIfStale, type ProfileFull } from "./manufacturerProfileService.js";

/** What decides which profile's widgets apply to an asset. */
export interface WidgetAssetIdentity {
  manufacturer: string | null;
  os?:          string | null;
  model:        string | null;
  assetType?:   string | null;
}

/**
 * The profile whose custom widgets apply to this asset (business rule 131):
 * the one `findDbProfile` picks for telemetry, so the Custom MIB tab, the
 * enable switch and the collector can never disagree with the System tab
 * about which profile a device is. Reads the warm profile cache — null before
 * it loads, the same "no opinion" every other profile reader reports. No MIB
 * pin: a pin redirects a telemetry STREAM, and widgets are not one.
 */
export function widgetProfileForAsset(asset: WidgetAssetIdentity): ProfileFull | null {
  return findDbProfile({
    manufacturer: asset.manufacturer,
    os:           asset.os ?? null,
    model:        asset.model,
    assetType:    asset.assetType ?? null,
    mibModule:    null,
  });
}

/** True when a widget's optional model pattern admits this model. RE2
 *  (business rule 116); a pattern RE2 cannot compile matches nothing — the
 *  same test the Custom MIB tab and the collector apply. */
export function widgetAppliesToModel(modelPattern: string | null | undefined, model: string | null | undefined): boolean {
  if (!modelPattern) return true;
  return tryCompileSafeRegex(modelPattern, { ignoreCase: true })?.test(model ?? "") ?? false;
}

/** Widget ids switched on for one asset. */
export async function enabledWidgetIdsForAsset(assetId: string): Promise<Set<string>> {
  const rows = await prisma.assetCustomWidgetEnable.findMany({
    where:  { assetId },
    select: { widgetId: true },
  });
  return new Set(rows.map((r) => r.widgetId));
}

/** Every asset with at least one widget switched on — ONE query per scheduler
 *  tick, so the due check never asks per asset. */
export async function assetIdsWithEnabledWidgets(): Promise<Set<string>> {
  const rows = await prisma.assetCustomWidgetEnable.findMany({
    distinct: ["assetId"],
    select:   { assetId: true },
  });
  return new Set(rows.map((r) => r.assetId));
}

interface WidgetScope {
  id: string;
  name: string;
  modelPattern: string | null;
  profileId: string;
  manufacturer: string;
  /** The profile's "also applies when" — set means assets of other names can fall under it. */
  matchPattern: string | null;
}

async function loadWidget(widgetId: string, profileId?: string): Promise<WidgetScope> {
  const w = await prisma.manufacturerCustomWidget.findUnique({
    where:  { id: widgetId },
    select: { id: true, name: true, modelPattern: true, profileId: true, profile: { select: { manufacturer: true, matchPattern: true } } },
  });
  if (!w || (profileId && w.profileId !== profileId)) throw new AppError(404, "Widget not found");
  // The governing-profile test below reads the cache; on the web process it is
  // warm and refreshed by every profile write, so this is one clock compare.
  await refreshProfileCacheIfStale();
  return {
    id: w.id, name: w.name, modelPattern: w.modelPattern, profileId: w.profileId,
    manufacturer: w.profile.manufacturer, matchPattern: w.profile.matchPattern ?? null,
  };
}

/** Is the widget's profile the one governing this asset, and does its model fall under the widget? */
function assetFallsUnder(widget: WidgetScope, asset: WidgetAssetIdentity): boolean {
  if (widgetProfileForAsset(asset)?.id !== widget.profileId) return false;
  return widgetAppliesToModel(widget.modelPattern, asset.model);
}

export interface WidgetCandidate {
  id: string;
  hostname: string | null;
  ipAddress: string | null;
  model: string | null;
  assetType: string | null;
  monitored: boolean;
  monitorStatus: string | null;
  enabled: boolean;
}

/**
 * The assets a widget applies to, each with whether it is switched on — the
 * list the "enable on these devices" picker shows. Asset manufacturers are
 * alias-normalized on write (db.ts), so a case-insensitive match on the
 * profile's canonical name finds the keyed ones in SQL. A profile with a
 * `matchPattern` can also govern assets of other names (rule 131), which SQL
 * cannot pre-filter — then every non-decommissioned asset is read with a
 * narrow select and the governing test decides. This is an on-demand picker,
 * not a ticking loop: one 2000-row read of eight columns per open.
 */
export async function listWidgetCandidates(profileId: string, widgetId: string): Promise<WidgetCandidate[]> {
  const widget = await loadWidget(widgetId, profileId);
  const [assets, enabled] = await Promise.all([
    prisma.asset.findMany({
      where:   widget.matchPattern
        ? { status: { not: "decommissioned" } }
        : { manufacturer: { equals: widget.manufacturer, mode: "insensitive" }, status: { not: "decommissioned" } },
      select:  { id: true, hostname: true, ipAddress: true, manufacturer: true, os: true, model: true, assetType: true, monitored: true, monitorStatus: true },
      orderBy: { hostname: "asc" },
    }),
    prisma.assetCustomWidgetEnable.findMany({ where: { widgetId }, select: { assetId: true } }),
  ]);
  const on = new Set(enabled.map((e) => e.assetId));
  return assets
    .filter((a) => assetFallsUnder(widget, a))
    .map((a) => ({
      id: a.id, hostname: a.hostname, ipAddress: a.ipAddress, model: a.model,
      assetType: a.assetType ?? null, monitored: a.monitored, monitorStatus: a.monitorStatus ?? null,
      enabled: on.has(a.id),
    }));
}

/**
 * Switch a widget on for some assets and off for others in one call. An id in
 * `enable` that the widget does not apply to is refused (400), so the picker
 * can never switch a widget on for a device it cannot read; `disable` takes any
 * id, so a row left behind by a model change can always be cleared.
 * Returns how many rows actually changed.
 */
export async function setWidgetAssets(
  profileId: string,
  widgetId: string,
  change: { enable?: string[]; disable?: string[] },
  actor?: string,
): Promise<{ enabled: number; disabled: number }> {
  const widget = await loadWidget(widgetId, profileId);
  const enableIds  = Array.from(new Set(change.enable ?? []));
  const disableIds = Array.from(new Set(change.disable ?? [])).filter((id) => !enableIds.includes(id));

  let toEnable: Array<{ id: string; hostname: string | null }> = [];
  if (enableIds.length) {
    const assets = await prisma.asset.findMany({
      where:  { id: { in: enableIds } },
      select: { id: true, hostname: true, manufacturer: true, os: true, model: true, assetType: true },
    });
    const outside = enableIds.filter((id) => {
      const a = assets.find((x) => x.id === id);
      return !a || !assetFallsUnder(widget, a);
    });
    if (outside.length) {
      throw new AppError(400, `Widget "${widget.name}" does not apply to ${outside.length} of the selected asset(s)`);
    }
    toEnable = assets;
  }

  const [created, removed] = await prisma.$transaction([
    prisma.assetCustomWidgetEnable.createMany({
      data: toEnable.map((a) => ({ assetId: a.id, widgetId, enabledBy: actor ?? null })),
      skipDuplicates: true,
    }),
    prisma.assetCustomWidgetEnable.deleteMany({ where: { widgetId, assetId: { in: disableIds } } }),
  ]);

  const events: LogEventInput[] = [
    ...toEnable.map((a) => widgetEvent("enabled", widget, a.id, a.hostname, actor)),
    ...(removed.count ? disableIds.map((id) => widgetEvent("disabled", widget, id, null, actor)) : []),
  ];
  await logEventsBatch(events);
  return { enabled: created.count, disabled: removed.count };
}

/** The Custom MIB tab's per-card switch. */
export async function setWidgetEnabledForAsset(
  assetId: string,
  widgetId: string,
  enabled: boolean,
  actor?: string,
): Promise<void> {
  const widget = await loadWidget(widgetId);
  const asset = await prisma.asset.findUnique({
    where:  { id: assetId },
    select: { id: true, hostname: true, manufacturer: true, os: true, model: true, assetType: true },
  });
  if (!asset) throw new AppError(404, "Asset not found");
  if (enabled) {
    if (!assetFallsUnder(widget, asset)) {
      throw new AppError(400, `Widget "${widget.name}" does not apply to this asset`);
    }
    await prisma.assetCustomWidgetEnable.upsert({
      where:  { assetId_widgetId: { assetId, widgetId } },
      create: { assetId, widgetId, enabledBy: actor ?? null },
      update: {},
    });
  } else {
    await prisma.assetCustomWidgetEnable.deleteMany({ where: { assetId, widgetId } });
  }
  await logEventsBatch([widgetEvent(enabled ? "enabled" : "disabled", widget, asset.id, asset.hostname, actor)]);
}

function widgetEvent(
  kind: "enabled" | "disabled",
  widget: WidgetScope,
  assetId: string,
  hostname: string | null,
  actor?: string,
): LogEventInput {
  return {
    action:       `asset.custom_widget.${kind}`,
    resourceType: "asset",
    resourceId:   assetId,
    resourceName: hostname ?? undefined,
    actor,
    level:        "info",
    message:      `Custom widget "${widget.name}" (${widget.manufacturer}) ${kind === "enabled" ? "switched on" : "switched off"} for polling`,
    details:      { widgetId: widget.id, profileId: widget.profileId },
  };
}
