/**
 * src/services/assetSourcePriorityService.ts
 *
 * Operator-settable priority for the Assets table's **Sources** column — which
 * discovery source's "where was this learned?" answer wins when an asset is
 * known to several at once. Single Setting row (`assetSourcePriority`), JSON
 * blob, TTL-cached via createSettingStore.
 *
 * The value feeds `Asset.learnedLocation` through the projection, NOT just the
 * column's rendering. That's deliberate: the Sources column, its text filter,
 * its sort, "behind FortiGate X" tag/maintenance criteria and the Device Map's
 * per-site narrowing all read learnedLocation, so deciding the winner at render
 * time would make the column disagree with everything that filters on it.
 *
 * Because the projection runs inside the DISCOVERY process (a separate process
 * in the split-role layout) the write can't push the new order in-process.
 * Propagation is pull-based: refreshProjectionPriority() runs at boot and at
 * the start of every discovery run, so an edit lands on the next run — which is
 * also the next moment learnedLocation is written, so nothing is ever stale in
 * a way an operator can observe. Existing rows re-project on that run; the
 * order change is not retroactive on its own.
 */

import { createSettingStore } from "./settingsStore.js";
import { logEvent } from "./eventLogService.js";
import { AppError } from "../utils/errors.js";
import {
  LOCATION_CONTRIBUTORS,
  defaultSourceLocationPriority,
  normalizeSourceLocationPriority,
  type SourceLocationPriority,
} from "../utils/assetSourceLocation.js";
import { setLearnedLocationPriority } from "../utils/assetProjection.js";

const ASSET_SOURCE_PRIORITY_KEY = "assetSourcePriority";

// 30s: this is read once per discovery run and once per settings GET, never on
// a hot path, so the TTL only bounds how long a just-saved order can look
// unchanged to another process's next run.
const store = createSettingStore<SourceLocationPriority>({
  key: ASSET_SOURCE_PRIORITY_KEY,
  ttlMs: 30_000,
  parse: normalizeSourceLocationPriority,
});

async function getSourceLocationPriority(): Promise<SourceLocationPriority> {
  return store.get();
}

/**
 * The full settings payload for the UI: the operator's order plus the catalogue
 * entry for each kind, so the drag-and-drop list can render labels + "what this
 * contributes" hints without hardcoding them client-side.
 */
export async function getSourcePrioritySettings(): Promise<{
  order: string[];
  integrationPrefix: boolean;
  contributors: Array<{
    kind: string;
    label: string;
    mode: string;
    describe: string;
    fortinetDevice: boolean;
  }>;
}> {
  const config = await getSourceLocationPriority();
  const byKind = new Map(LOCATION_CONTRIBUTORS.map((c) => [c.kind, c]));
  return {
    order: config.order,
    integrationPrefix: config.integrationPrefix,
    // Emitted in the operator's order so the client renders the list straight
    // through without re-sorting.
    contributors: config.order.flatMap((kind) => {
      const c = byKind.get(kind);
      if (!c) return [];
      return [{
        kind: c.kind,
        label: c.label,
        mode: c.mode,
        describe: c.describe,
        fortinetDevice: c.fortinetDevice === true,
      }];
    }),
  };
}

/**
 * Persist a new order. `order` must name known source kinds; unknown entries
 * are REJECTED here rather than silently dropped (unlike the read path, which
 * self-heals stored rows) — a client posting a typo should hear about it.
 * Kinds the client omits are appended in default order by the normalizer.
 */
export async function saveSourceLocationPriority(
  input: { order?: unknown; integrationPrefix?: unknown },
  actor?: string,
): Promise<SourceLocationPriority> {
  const current = await getSourceLocationPriority();

  let order = current.order;
  if (input.order !== undefined) {
    if (!Array.isArray(input.order)) {
      throw new AppError(400, "order must be an array of source-kind strings");
    }
    const known = new Set(LOCATION_CONTRIBUTORS.map((c) => c.kind));
    const seen = new Set<string>();
    const next: string[] = [];
    for (const raw of input.order) {
      if (typeof raw !== "string" || !raw.trim()) {
        throw new AppError(400, "order entries must be non-empty source-kind strings");
      }
      const kind = raw.trim();
      if (!known.has(kind)) {
        throw new AppError(400, `Unknown asset source kind in order: ${kind}`);
      }
      if (seen.has(kind)) {
        throw new AppError(400, `Duplicate asset source kind in order: ${kind}`);
      }
      seen.add(kind);
      next.push(kind);
    }
    order = next;
  }

  const integrationPrefix = input.integrationPrefix === undefined
    ? current.integrationPrefix
    : input.integrationPrefix === true;

  const saved = await store.save(
    normalizeSourceLocationPriority({ order, integrationPrefix }),
  );
  // Prime this process immediately; other roles pick it up on their next
  // refresh (see the module header).
  setLearnedLocationPriority(saved);

  await logEvent({
    level: "info",
    action: "asset.source_priority.updated",
    resourceType: "setting",
    resourceName: ASSET_SOURCE_PRIORITY_KEY,
    message: "Asset source (learned location) priority updated",
    actor: actor || "system",
    details: {
      order: saved.order,
      integrationPrefix: saved.integrationPrefix,
      previousOrder: current.order,
      previousIntegrationPrefix: current.integrationPrefix,
    },
  });

  return saved;
}

/**
 * Load the stored order and install it into the projection for this process.
 * Never throws — a DB hiccup leaves the default order in force, which is the
 * pre-feature behavior, rather than failing a discovery run.
 */
export async function refreshProjectionPriority(): Promise<void> {
  try {
    setLearnedLocationPriority(await getSourceLocationPriority());
  } catch {
    setLearnedLocationPriority(defaultSourceLocationPriority());
  }
}
