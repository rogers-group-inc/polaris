/**
 * src/jobs/seedManufacturerProfiles.ts
 *
 * One-shot startup that converts the hardcoded VENDOR_TELEMETRY_PROFILES
 * constant into ManufacturerProfile + ManufacturerProfileMetric +
 * ManufacturerProfileMetricOverride rows. Idempotent (marker-keyed in
 * Setting).
 *
 * Since the Phase 4 resolver swap those rows are the ONLY source of vendor
 * telemetry OIDs, which makes this job's output the fresh-install half of a
 * pair: **whatever the `20260915020000_manufacturer_profile_resolver_swap`
 * migration gives an EXISTING install, this must give a NEW one.** They are
 * not interchangeable — on a fresh install `migrate deploy` runs before this
 * job, so every backfill UPDATE in that migration matches zero rows and only
 * what is written here survives. Anything added to one belongs in the other,
 * and `tests/unit/seedManufacturerProfiles.test.ts` pins the pair.
 *
 * Layout: every entry in VENDOR_TELEMETRY_PROFILES whose regex anchors a
 * SPECIFIC model (FortiSwitch / FortiAP — the two pre-Fortinet entries)
 * becomes a `ManufacturerProfileMetricOverride` row under the umbrella
 * "Fortinet" manufacturer profile. Every other entry becomes its own
 * top-level profile (Cisco / Juniper / Mikrotik / Fortinet / HP / Dell).
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { runInstrumentedJob } from "./_metrics.js";
import { hasRunMarker, stampRunMarker } from "./_runOnce.js";
import { VENDOR_TELEMETRY_PROFILES, type VendorTelemetryProfile, memoryQueryToDoubleScalar, diskQueryToDoubleScalar } from "../services/vendorTelemetryProfiles.js";
import { refreshProfileCache, emitProfileReadinessEvents, METRIC_KEYS } from "../services/manufacturerProfileService.js";
import { normalizeManufacturer } from "../utils/manufacturerNormalize.js";

const MARKER_KEY = "seedManufacturerProfilesSeededAt";

// Hand-mapped (vendor label → canonical manufacturer + optional modelPattern).
// We can't reliably parse the regex back to a manufacturer name programmatically
// (e.g. `/aruba|hpe|hewlett|procurve|^hp\b/i` covers four legal names; the human
// label "HP / Aruba ProCurve" is the operator's notion of the umbrella). The
// model overrides for Fortinet sub-families are tagged here so seeding can route
// them under the right parent.
interface SeedRow {
  vendorLabel: string;
  manufacturer: string;
  modelPattern: string | null; // null = top-level default; non-null = override under that manufacturer
  /**
   * The DEVICE TYPE this sub-family is, for the type-default sibling seeded
   * beside the model-pattern row (Phase 4). A model regex only matches an
   * asset whose model STATES the family; a Fortinet switch discovered with an
   * empty model matched it solely through `fortinetClassHint`. The type
   * default says the same thing as data.
   */
  assetType: string | null;
}

const SEED_MAP: SeedRow[] = [
  { vendorLabel: "Cisco IOS / IOS-XE / NX-OS",        manufacturer: "Cisco",    modelPattern: null,          assetType: null },
  { vendorLabel: "Juniper Junos",                     manufacturer: "Juniper",  modelPattern: null,          assetType: null },
  { vendorLabel: "Mikrotik RouterOS",                 manufacturer: "Mikrotik", modelPattern: null,          assetType: null },
  { vendorLabel: "Fortinet FortiSwitch (SNMP path)",  manufacturer: "Fortinet", modelPattern: "FortiSwitch", assetType: "switch" },
  { vendorLabel: "Fortinet FortiAP (SNMP path)",      manufacturer: "Fortinet", modelPattern: "FortiAP",     assetType: "access_point" },
  { vendorLabel: "Fortinet FortiOS (SNMP path)",      manufacturer: "Fortinet", modelPattern: null,          assetType: null },
  { vendorLabel: "HP / Aruba ProCurve",               manufacturer: "HP",       modelPattern: null,          assetType: null },
  { vendorLabel: "Dell PowerConnect / Networking",    manufacturer: "Dell",     modelPattern: null,          assetType: null },
];

// Translate a VENDOR_TELEMETRY_PROFILES entry's metric queries into a per-
// metric seed shape. Memory may be either `scalar` (single percent OID) or
// `double_scalar` (two byte OIDs combined by `transform`) depending on what
// the hardcoded vendor shape exposes; CPU/temperature/disk are scalar.
interface MetricSeed {
  metricKey: string;
  symbol:    string;
  symbolB:   string | null;
  type:      "scalar" | "double_scalar" | "table";
  transform: string | null;
  /** How a walked subtree collapses; "none" unless the hardcoded shape walks. */
  aggregate: "none" | "avg" | "sum";
  /** The synthesized sample row's label — storage mountPath / sensor name. */
  label:     string | null;
  /** `model` only: the row-shaped identity parse. */
  parsePattern:  string | null;
  parseTemplate: string | null;
}

/** Everything below "none" is derived from the hardcoded shape, never typed twice. */
const NO_EXTRAS = { aggregate: "none", label: null, parsePattern: null, parseTemplate: null } as const;

function profileToMetricSeeds(p: VendorTelemetryProfile): MetricSeed[] {
  const out: MetricSeed[] = [];
  if (p.cpu) {
    out.push({
      ...NO_EXTRAS,
      metricKey: "cpu",
      symbol:    p.cpu.symbol,
      symbolB:   null,
      type:      p.cpu.mode === "walk-avg" ? "table" : "scalar",
      transform: null,
      // "walk-avg" is literally walk + average. It reached the row as
      // `type: "table"` alone before Phase 4, which the resolver could read
      // for CPU but not for anything else — `aggregate` is the general form.
      aggregate: p.cpu.mode === "walk-avg" ? "avg" : "none",
    });
  }
  if (p.model?.rowParse) {
    // The identity query. A `model` row seeded without its parse would stamp
    // raw firmware strings onto Asset.model, so the symbol and the parse seed
    // together or not at all.
    out.push({
      ...NO_EXTRAS,
      metricKey:     "model",
      symbol:        p.model.symbol,
      symbolB:       null,
      type:          "scalar",
      transform:     null,
      parsePattern:  p.model.rowParse.pattern,
      parseTemplate: p.model.rowParse.template,
    });
  }
  if (p.memory) {
    const ds = memoryQueryToDoubleScalar(p.memory);
    if (ds) {
      out.push({
        ...NO_EXTRAS,
        metricKey: "memory",
        symbol:    ds.symbol,
        symbolB:   ds.symbolB,
        // `walkSubtree` means the symbol names a table column, and the two
        // forms collapse it differently: a BYTES pair is summed (Cisco's
        // memory pools are per-pool rows that add up to the device's memory),
        // a single PERCENT is averaged (Juniper's jnxOperatingBuffer is one
        // reading per operating entity). This is the fact `pickVendorProfileMerged`
        // could not express, which is why it hardcoded walkSubtree=false on
        // the pair path and every seeded Cisco fell to HOST-RESOURCES-MIB.
        aggregate: !p.memory.walkSubtree ? "none" : (ds.type === "double_scalar" ? "sum" : "avg"),
        // walkSubtree forms (Cisco / Juniper) walk a table column under the
        // hood — the runtime path averages/sums the result. The editable
        // profile records the type the resolver will use, not the wire
        // shape, so percent → scalar and bytes-form → double_scalar
        // regardless of walkSubtree.
        type:      ds.type,
        transform: ds.transform,
      });
    }
  }
  if (p.disk) {
    // Disk is bytes-form (a pair drawn from used / total / free), so it seeds
    // as double_scalar with the combiner naming which pair it is. The runtime
    // reads this row back through `diskQueryFromMetricPick` in
    // pickVendorProfileMerged, so what is stamped here IS what the
    // disk-fallback collects — an operator edit to the row takes effect.
    const ds = diskQueryToDoubleScalar(p.disk);
    if (ds) {
      out.push({
        ...NO_EXTRAS,
        metricKey: "storage",
        symbol:    ds.symbol,
        symbolB:   ds.symbolB,
        type:      ds.type,
        transform: ds.transform,
        // The StorageSample.mountPath the pins and thresholds attach to —
        // "flash" on a FortiSwitch. Without it the collector labels the row
        // "system" and an operator's existing pin no longer matches.
        label:     p.disk.mountPath ?? null,
      });
    }
  }
  if (p.temperature) {
    out.push({
      ...NO_EXTRAS,
      metricKey: "temperature",
      symbol:    p.temperature.symbol,
      symbolB:   null,
      // "table" makes the collector walk the named sensor table
      // (fgHwSensorTable) instead of doing a scalar GET of it. Hardcoding
      // "scalar" here is what left the Fortinet row unable to say so.
      type:      p.temperature.mode === "table" ? "table" : "scalar",
      transform: null,
      label:     p.temperature.sensorName ?? null,
    });
  }
  return out;
}

export async function seedManufacturerProfiles(): Promise<{ profiles: number; overrides: number; skipped: boolean }> {
  if (await hasRunMarker(MARKER_KEY)) {
    return { profiles: 0, overrides: 0, skipped: true };
  }

  const profilesByMfr = new Map<string, { id: string; metricRowIds: Map<string, string> }>();
  let createdProfiles = 0;
  let createdOverrides = 0;

  // Pass 1: create one ManufacturerProfile + 7 metric rows per distinct
  // canonical manufacturer. Pre-populate metric defaults from the hardcoded
  // entry that DOESN'T have a modelPattern (the "umbrella" entry — e.g.
  // FortiOS for Fortinet; the only entry for Cisco/Juniper/etc.).
  const distinctMfrs = Array.from(new Set(SEED_MAP.map((s) => s.manufacturer)));
  for (const mfrRaw of distinctMfrs) {
    const mfr = normalizeManufacturer(mfrRaw) ?? mfrRaw;
    const profileId = (await import("crypto")).randomUUID();
    const umbrella = SEED_MAP.find((s) => s.manufacturer === mfrRaw && s.modelPattern === null);
    const umbrellaProfile = umbrella ? VENDOR_TELEMETRY_PROFILES.find((p) => p.vendor === umbrella.vendorLabel) : null;
    const umbrellaSeeds = umbrellaProfile ? profileToMetricSeeds(umbrellaProfile) : [];

    const metricRowIds = new Map<string, string>();

    const txOps: any[] = [
      (prisma as any).manufacturerProfile.create({
        data: {
          id:           profileId,
          manufacturer: mfr,
          createdBy:    "system:seed",
          // "Also applies when": the umbrella entry's own regex, which is
          // exactly the set of spellings that entry was written to catch —
          // an alias the seed did not key ("Aruba" canonicalizes away from
          // "HP"), and OS-only identity ("Cisco IOS" with no manufacturer).
          // Deriving it from `match` rather than retyping it is the whole
          // point: the constant is the one place that list lives.
          matchPattern: umbrellaProfile?.match.source ?? null,
        },
      }),
    ];
    // METRIC_KEYS comes from the service, never a copy. The copy that used to
    // live here silently omitted `model` when Phase 4 added it, so a fresh
    // install got no identity query at all while an upgraded one did.
    for (const mk of METRIC_KEYS) {
      const seed = umbrellaSeeds.find((s) => s.metricKey === mk);
      const id = (await import("crypto")).randomUUID();
      metricRowIds.set(mk, id);
      txOps.push(
        (prisma as any).manufacturerProfileMetric.create({
          data: {
            id,
            profileId,
            metricKey:        mk,
            defaultSymbol:    seed?.symbol  ?? null,
            defaultSymbolB:   seed?.symbolB ?? null,
            defaultType:      seed?.type    ?? "scalar",
            defaultTransform: seed?.transform ?? null,
            defaultAggregate:     seed?.aggregate ?? "none",
            defaultLabel:         seed?.label ?? null,
            defaultParsePattern:  seed?.parsePattern ?? null,
            defaultParseTemplate: seed?.parseTemplate ?? null,
          },
        }),
      );
    }
    try {
      await prisma.$transaction(txOps);
      profilesByMfr.set(mfrRaw, { id: profileId, metricRowIds });
      createdProfiles += 1;
    } catch (err: any) {
      // Conflict (manufacturer already exists from a previous partial run) —
      // fetch the existing row + metric ids and reuse.
      if (err?.code === "P2002") {
        const existing = await (prisma as any).manufacturerProfile.findUnique({
          where: { manufacturer: mfr },
          include: { metrics: true },
        });
        if (existing) {
          const ids = new Map<string, string>();
          for (const m of existing.metrics) ids.set(m.metricKey, m.id);
          profilesByMfr.set(mfrRaw, { id: existing.id, metricRowIds: ids });
          continue;
        }
      }
      throw err;
    }
  }

  // Pass 2: every SEED_MAP entry with a non-null modelPattern becomes an
  // override under the parent profile's matching metric row.
  for (const seedRow of SEED_MAP) {
    if (!seedRow.modelPattern) continue;
    const parent = profilesByMfr.get(seedRow.manufacturer);
    if (!parent) {
      logger.warn({ vendorLabel: seedRow.vendorLabel }, "No parent profile for override seed; skipping");
      continue;
    }
    const profile = VENDOR_TELEMETRY_PROFILES.find((p) => p.vendor === seedRow.vendorLabel);
    if (!profile) continue;
    const seeds = profileToMetricSeeds(profile);
    for (const s of seeds) {
      const metricRowId = parent.metricRowIds.get(s.metricKey);
      if (!metricRowId) continue;
      const shared = {
        metricRowId,
        symbol:        s.symbol,
        symbolB:       s.symbolB ?? null,
        type:          s.type,
        transform:     s.transform ?? null,
        aggregate:     s.aggregate,
        label:         s.label,
        parsePattern:  s.parsePattern,
        parseTemplate: s.parseTemplate,
        order:         0,
      };
      // TWO rows per sub-family metric, the same pair the Phase 4 migration
      // inserts. The model-pattern row catches an asset whose model STATES
      // the family — including one discovery mis-typed, since a stated model
      // outranks an inferred type. The device-type row catches the one whose
      // model is empty, which is the common case on a FortiSwitch (the
      // managed-switch CMDB has no model field) and which used to be reachable
      // only through the Fortinet-specific `fortinetClassHint`.
      const rows: Array<Record<string, unknown>> = [
        { ...shared, assetType: null, modelPattern: seedRow.modelPattern },
      ];
      if (seedRow.assetType) {
        rows.push({ ...shared, assetType: seedRow.assetType, modelPattern: null });
      }
      for (const data of rows) {
        try {
          await (prisma as any).manufacturerProfileMetricOverride.create({ data });
          createdOverrides += 1;
        } catch (err) {
          logger.warn(
            { err, vendorLabel: seedRow.vendorLabel, metricKey: s.metricKey, assetType: data.assetType },
            "Failed to seed override",
          );
        }
      }
    }
  }

  await stampRunMarker(MARKER_KEY, { profiles: createdProfiles, overrides: createdOverrides });
  return { profiles: createdProfiles, overrides: createdOverrides, skipped: false };
}

(async () => {
  try {
    await runInstrumentedJob("seedManufacturerProfiles", async () => {
      const result = await seedManufacturerProfiles();
      if (!result.skipped) {
        logger.info(result, "Seeded manufacturer profiles from VENDOR_TELEMETRY_PROFILES");
      }
      await refreshProfileCache();
      // With the cache warm, say which profiles name symbols nothing resolves
      // — one warning Event per profile, in the log the moment the process
      // is up rather than as a chart that quietly stopped.
      const emitted = await emitProfileReadinessEvents();
      if (emitted > 0) logger.warn({ profiles: emitted }, "manufacturer profiles with unresolved symbols — see Events");
    });
  } catch (err) {
    logger.error({ err }, "seedManufacturerProfiles startup task failed");
  }
})();
