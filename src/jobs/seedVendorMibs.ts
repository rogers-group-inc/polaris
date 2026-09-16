/**
 * src/jobs/seedVendorMibs.ts
 *
 * One-shot startup that loads the manufacturer MIBs Polaris ships
 * (`services/vendorMibs/`) into the MIB Database as ordinary entries.
 * Idempotent (marker-keyed in Setting).
 *
 * **These are seeded, not bundled, and the distinction is the point.** Polaris
 * ships two kinds of MIB and an operator's relationship to them differs:
 *
 *   - `services/stdMibs/` — the generic IETF/IEEE modules. Read off disk by
 *     `oidRegistry.loadStandardLayer`, present in every install, not rows in
 *     any table. Nobody can delete or edit them; they change when the product
 *     is updated. That is correct for standards every device speaks.
 *   - `services/vendorMibs/` — a manufacturer's own public MIB. Seeded here as
 *     a `MibFile` row at manufacturer scope, which means it appears in the MIB
 *     Database exactly like something the operator uploaded, and **they can
 *     delete it**. That is correct for a vendor's file: an operator may have a
 *     newer one, may object to shipping it, or may simply not run that gear.
 *
 * A module added to `vendorMibs/` therefore MUST NOT be added to `stdMibs/` —
 * `loadStandardLayer` globs that directory, so anything landing there becomes
 * part of the layer no operator can remove, which is the opposite of the
 * intent.
 *
 * Seeding goes through `mibService.createMib`, the same function the upload
 * route calls, so a seeded MIB is parsed, dup-checked and registry-refreshed
 * identically to an uploaded one — there is no second code path that could
 * drift. It runs BEFORE `seedManufacturerProfiles` in `app.ts`, so the
 * profiles it seeds resolve on their first readiness check rather than
 * emitting an `unresolved` Event that corrects itself on the next boot.
 *
 * Deleting a seeded MIB is a supported operator action with a visible
 * consequence: its manufacturer profile's rows report `unresolved` and name
 * the module to re-upload, and vendor telemetry for that manufacturer falls
 * back to HOST-RESOURCES-MIB. Nothing is silently broken, and re-uploading the
 * vendor's file restores it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../utils/logger.js";
import { runInstrumentedJob } from "./_metrics.js";
import { hasRunMarker, stampRunMarker } from "./_runOnce.js";
import { createMib } from "../services/mibService.js";

const MARKER_KEY = "seedVendorMibsSeededAt";

const VENDOR_MIBS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "services", "vendorMibs");

/**
 * Which manufacturer each shipped module is scoped to, and why it is here.
 * The manufacturer string must be the canonical form the alias map produces,
 * because that is what `MibFile.manufacturer` is matched on at resolution time
 * and what `ManufacturerProfile.manufacturer` is keyed by.
 *
 * A module whose only job is to anchor another (an SMI root) is listed too —
 * a vendor's leaf module resolves nothing without it.
 */
interface VendorMibDef {
  filename:     string;
  manufacturer: string;
  notes:        string;
}

export const VENDOR_MIBS: readonly VendorMibDef[] = [
  {
    filename:     "CISCO-SMI.txt",
    manufacturer: "Cisco",
    notes:        "Shipped with Polaris. The Cisco SMI root — defines the `cisco` and `ciscoMgmt` anchors every other Cisco module hangs off. Deleting it unresolves the other Cisco modules too.",
  },
  {
    filename:     "CISCO-PROCESS-MIB.txt",
    manufacturer: "Cisco",
    notes:        "Shipped with Polaris. cpmCPUTotal5secRev — per-CPU load, walked and averaged. Anchors on CISCO-SMI.",
  },
  {
    filename:     "CISCO-MEMORY-POOL-MIB.txt",
    manufacturer: "Cisco",
    notes:        "Shipped with Polaris. ciscoMemoryPoolUsed / ciscoMemoryPoolFree — per-pool bytes, walked and summed. Anchors on CISCO-SMI.",
  },
  {
    filename:     "MIKROTIK-MIB.txt",
    manufacturer: "MikroTik",
    notes:        "Shipped with Polaris. The mtxrHealth sensors (temperature, voltage, fan) — RouterOS reports CPU, memory and storage through HOST-RESOURCES-MIB, which Polaris already reads, so the health sensors are the only thing this module adds.",
  },
];

export async function seedVendorMibs(): Promise<{ seeded: number; skipped: boolean }> {
  if (await hasRunMarker(MARKER_KEY)) return { seeded: 0, skipped: true };

  let seeded = 0;
  for (const def of VENDOR_MIBS) {
    let contents: string;
    try {
      contents = readFileSync(join(VENDOR_MIBS_DIR, def.filename), "utf8");
    } catch (err: any) {
      // A build that forgot to copy vendorMibs/ into dist/ lands here. Say so
      // loudly — the symptom downstream is a manufacturer profile that reads
      // UNRESOLVED for no visible reason.
      logger.error(
        { filename: def.filename, dir: VENDOR_MIBS_DIR, err: err?.message },
        "shipped vendor MIB missing — is the copy-build-assets step running?",
      );
      continue;
    }
    try {
      await createMib({
        filename:     def.filename,
        contents,
        manufacturer: def.manufacturer,
        notes:        def.notes,
        uploadedBy:   "system:seed",
      });
      seeded += 1;
    } catch (err: any) {
      // 409 = the operator already has this module at this scope, which is a
      // perfectly good reason not to seed it. Anything else is worth a line.
      if (err?.httpStatus === 409) continue;
      logger.warn({ filename: def.filename, err: err?.message }, "failed to seed vendor MIB");
    }
  }

  await stampRunMarker(MARKER_KEY, { seeded });
  return { seeded, skipped: false };
}

/** Every file in vendorMibs/ that no VENDOR_MIBS entry claims. */
export function unclaimedVendorMibFiles(): string[] {
  let files: string[] = [];
  try {
    files = readdirSync(VENDOR_MIBS_DIR).filter((f) => f.endsWith(".txt"));
  } catch {
    return [];
  }
  const claimed = new Set(VENDOR_MIBS.map((m) => m.filename));
  return files.filter((f) => !claimed.has(f));
}

(async () => {
  try {
    await runInstrumentedJob("seedVendorMibs", async () => {
      const result = await seedVendorMibs();
      if (!result.skipped) {
        logger.info(result, "Seeded shipped manufacturer MIBs into the MIB Database");
      }
    });
  } catch (err) {
    logger.error({ err }, "seedVendorMibs startup task failed");
  }
})();
