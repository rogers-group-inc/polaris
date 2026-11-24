/**
 * src/services/assetSourcePriorityService.ts
 *
 * The fixed source order behind `Asset.learnedLocation` (the Location column's
 * learned half), served read-only to the asset merge modal so its per-field
 * winner defaults and source labels follow the same order the projection uses.
 *
 * The order is the catalogue's declaration order (utils/assetSourceLocation.ts).
 * It used to be operator-editable through Assets → Settings → Sources and the
 * `assetSourcePriority` Setting; that setting was retired (business rule 22) and
 * any stored row is ignored.
 */

import {
  LOCATION_CONTRIBUTORS,
  DEFAULT_LOCATION_ORDER,
} from "../utils/assetSourceLocation.js";

/**
 * The source order plus the catalogue entry for each kind, so the merge modal
 * can label sources without hardcoding them client-side.
 */
export function getSourcePrioritySettings(): {
  order: string[];
  contributors: Array<{
    kind: string;
    label: string;
    mode: string;
    describe: string;
    fortinetDevice: boolean;
  }>;
} {
  return {
    order: DEFAULT_LOCATION_ORDER.slice(),
    contributors: LOCATION_CONTRIBUTORS.map((c) => ({
      kind: c.kind,
      label: c.label,
      mode: c.mode,
      describe: c.describe,
      fortinetDevice: c.fortinetDevice === true,
    })),
  };
}
