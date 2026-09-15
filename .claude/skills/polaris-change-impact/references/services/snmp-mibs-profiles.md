# Services — OID registry, MIB database, vendor telemetry and manufacturer profiles

Per-service touches (What it owns / Public API / Cross-service deps / Used by / Invariants / When changing this), verbatim from TOUCHES.md. Code references are `path/file.ts → symbolName()` — grep the symbol.

## services/manufacturerAliasService.ts

**What it owns:** Manufacturer alias CRUD (IEEE legal name → marketing name), in-memory alias map cache synced to Prisma extension, background backfill of normalized strings in Asset and MibFile rows, and idempotent default seed.

**Public API:** `listAliases`, `createAlias`, `updateAlias`, `deleteAlias`, `refreshAliasCache`, `seedDefaultAliases`, `applyAliasesToExistingRows`, `ManufacturerAliasRow`.

**Cross-service deps:** None (consumed by routes and jobs).

**Used by:** `src/api/routes/manufacturerAliases.ts — admin CRUD endpoints`, `src/jobs/normalizeManufacturers.ts — startup seeding and backfill`, `src/db.ts — Prisma extension normalizer hook`.

**Invariants:**
- In-memory map (`setAliasMap()` in `manufacturerNormalize.ts`) must be refreshed after every mutation.
- `seedDefaultAliases()` is idempotent; only inserts missing rows (no overwrites).
- `applyAliasesToExistingRows()` respects (manufacturer, model, moduleName) uniqueness; logs warnings when normalization would create duplicates.
- Prisma extension hooks `normalizeManufacturer()` on all Asset/MibFile create/update/upsert calls.

**When changing this:**
- Update `DEFAULT_ALIASES` constants when IEEE-registered names change or new vendor aliases are discovered.
- Verify `createAlias()` uniqueness check is case-insensitive (alias is lowercased).
- Test `applyAliasesToExistingRows()` backfill with duplicate-collapse edge cases (two rows collapsing to same canonical).
- Confirm `refreshAliasCache()` is called after every CRUD mutation (create/update do this; delete does not since no rows change).
- Inspect `src/db.ts` Prisma extension to ensure normalizer is wired to all manufacturer-write paths.

---

## services/manufacturerProfileService.ts

**What it owns:** CRUD + cached resolver for the editable per-manufacturer telemetry profiles (metric rows, per-metric overrides, custom widgets). A synchronous `getProfileFor` serves the hot probe path after a boot warm-up.

**Public API:** `MetricKey`, `MetricRowType`, `MetricOverrideRow`, `MetricRow`, `RowReadiness`, `CustomWidgetRow`, `StateProbeSummary`, `ProfileSummary`, `ProfileFull`, `ManufacturerSuggestion`, `ManufacturerSuggestionSource`, `refreshProfileCache`, `getProfileFor`, `listProfiles`, `listStateProbes`, `listManufacturerSuggestions`, `mergeManufacturerSuggestions`, `getProfile`, `createProfile`, `updateMetricRow`, `createOverride`, `updateOverride`, `deleteOverride`, `createWidget`, `updateWidget`, `deleteWidget`, `deleteProfile`, `annotateReadiness`, `readinessSummary`, `symbolWarnings`, `symbolWarningsForProfile`, `emitProfileReadinessEvents`, `STD_MIB_KEYS`, `METRIC_KEYS`

**Readiness (2026-09):** a profile row names a SYMBOL; whether it resolves depends on which MIBs are loaded, and until 2026-09 the page could not tell the operator either way. `getProfile()` returns rows stamped with `readiness` (via `oidRegistry.symbolReadiness` at the manufacturer's scope, using the row's pinned `mibId` only to EXPLAIN an unresolved symbol); `listProfiles()` adds `ready / partial / unresolvedCount / unresolvedSymbols` to each summary; the write routes attach `symbolWarningsForProfile()` output as `warnings[]` (warn, never block — "type the symbol, then upload the MIB" is the natural order); and `emitProfileReadinessEvents()` writes one warning-level `manufacturer_profile.unresolved` Event per affected profile after the boot cache warm (called from the seed job's IIFE), which is what makes a seed removal visible in the Events log the moment the process is up. The cached row the probe path reads is NOT annotated — the probe resolves for itself.

**Cross-service deps:** `prisma`, `normalizeManufacturer`, transform/combiner-kind guards, `AppError`, `logger`, `stateProbes` (`normalizeStateMap` / `validateStateMap`), `ouiService.getOuiOverrides` (dynamic import, suggestions only).

**Used by:** `src/api/routes/manufacturerProfiles.ts` (full CRUD), `src/api/routes/assets.ts` (profile read + the Custom MIB tab's state rows), `src/services/monitoringService.ts` (metric resolver + the state-probe collector), `src/services/notificationDimensionService.ts` + `src/api/routes/notificationRules.ts` (`listStateProbes` — probe names/labels for the automation builder), `src/jobs/seedManufacturerProfiles.ts` + `src/jobs/backfillManufacturerProfileMemoryComposition.ts`.

**Invariants:**
- Metric row type gates transform validity (scalar/table take a unary transform; double_scalar takes a combiner); override rows always carry a symbol while metric rows may be unconfigured (null = use built-in seed).
- `defaultMibId` and `defaultMibStdKey` are mutually exclusive; `modelPattern` is operator regex (validated + length-capped).
- The cache `getProfileFor` reads is keyed by normalized-lowercase manufacturer and returns null until the boot warm-up completes.
- **State-probe fields track the EFFECTIVE widgetType, both directions.** `stateFieldsForWrite` requires a valid `stateMap` on a `widgetType="state"` write (a probe with no mapping has no definition of true and would silently record nothing) and forces both columns to NULL on every non-state write — so flipping a probe to a gauge clears the mapping rather than leaving a stale one for a later flip back to resurrect. On a PARTIAL update the type comes from the posted value else the stored one, so an edit that doesn't mention `widgetType` keeps the probe's mapping.
- **`shapeWidget` is the single shaping seam.** The cached read path (`shapeProfile`) and both write paths return through it, so a just-written row and the cache can't disagree. It reads `stateMap` through `normalizeStateMap` (which never throws) rather than trusting it verbatim — a row written before a mode existed, or hand-edited in SQL, must still yield a usable mapping on the telemetry hot path instead of throwing per scrape.
- **FOUR of the seven metric rows are read at probe time; the other three are descriptive.** `pickVendorProfileMerged` in `monitoringService.ts` plucks `cpu` / `memory` / `temperature` / `storage` and layers each over the hardcoded `VENDOR_TELEMETRY_PROFILES` entry. `interfaces` / `lldp` / `wirelessStations` are deliberately absent — those are table walks with no symbol to swap. This is a hand-maintained claim about code elsewhere, exactly like `pollingCapability.ts`: the profile page renders all seven identically and validates all seven on save, so a row the runtime doesn't read is an operator edit that saves cleanly, reports success, and changes nothing. `storage` was in that state until 2026-08 — it seeded from the hardcoded `disk` block, matched it exactly, and was read by nothing, so nobody could tell. **Adding a row to the plucked set means the merge AND a `*QueryFromMetricPick` translator** (`diskQueryFromMetricPick` is the pattern: the row's combiner is interpreted, and a shape it can't express returns null so the hardcoded baseline survives a half-finished edit rather than being cleared).

**When changing this:**
- `touchProfile` (updatedAt bump) is best-effort and must not fail the operation.
- Adding a `StateMapMode` means `src/utils/stateProbes.ts` (evaluate + describe + the needs-values set) AND the two client mirrors: `STATE_MODE_LABELS`/`STATE_MODES_WITH_VALUES`/`_stateMapSummary` in `public/js/server-settings.js`.
- `listManufacturerSuggestions` is the "+ Add Manufacturer" typeahead and must offer only values `createProfile` would actually store — every contributor goes through `normalizeManufacturer` and profiles that already exist are excluded. Adding a contributor means adding it to `mergeManufacturerSuggestions` (the pure half, unit-tested) and to `_MFG_SUGGEST_SOURCE_LABELS` in `public/js/server-settings.js` so the dropdown can say where a value came from. The raw IEEE OUI database is deliberately NOT a contributor (~35k legal names, none of them canonical).
- `listStateProbes` reads the cache only, so it returns `[]` before the boot warm-up. That's deliberate (nothing has produced a sample yet either), but any new caller must degrade rather than assume a probe resolves — the wizard falls back to generic "true/false" wording.

---

## services/mibParserUtils.ts

**What it owns:** Shared ASN.1/SMI text helpers: the comment stripper (collapses comments to whitespace preserving line numbers, string-literal aware) and the IMPORTS-block reader `parseImportMap`, which returns symbol → module pairs (`fortinet FROM FORTINET-CORE-MIB`) — the only place a file states which module defines an anchor it leans on, and therefore what lets the UI name the module to upload. Tolerant: no block → `[]`, never throws.

**Public API:** `stripComments`, `parseImportMap`, `ImportBinding`

**Cross-service deps:** none.

**Used by:** `src/services/mibService.ts` and `src/services/oidRegistry.ts` (SMI text parsing).

**Invariants:**
- Comments become space/newline equivalents (not deleted) so line numbers stay correct for parser errors; both `--…<newline>` and `--…--` styles handled; `--` inside quoted strings is preserved.

**When changing this:**
- Test pathological cases: nested/escaped quotes, comment at EOF.

---

## services/mibService.ts

**What it owns:** Parsing, validation, and CRUD for uploaded SNMP MIB modules. The light validator (`parseMib`) gates uploads (1MB cap, rejects binaries, extracts moduleName + IMPORTS). The heavier peer (`parseMibStructured`) drives the Browse + MIB-aware Walk surface — extracts SYNTAX, INTEGER enum value labels, ACCESS, STATUS, DESCRIPTION, INDEX clauses, and SEQUENCE OF table structure. Per-(manufacturer, model, moduleName) uniqueness is enforced at create.

**Public API:** `parseMib`, `parseMibStructured`, `listMibs`, `getMib`, `createMib`, `deleteMib`, `getMibFacets`, `ParsedMib`, `ParsedMibStructured`, `MibSymbol`, `MibTable`, `MibBaseType`, `MibAccess`, `MibStatus`, `MibSymbolKind`, `MibEnumValue`, `MibSummary`, `MibUploadResult`, `MibFilter`, `CreateMibInput`. (`getProfileStatus` / `ProfileStatus` / `ProfileSymbolStatus` / `exampleManufacturerForProfile` were removed in 2026-09 — an orphaned chain that read the hardcoded constant for a UI pill that no longer existed; readiness lives in `manufacturerProfileService` now.)

**Cross-service deps:** `oidRegistry` (refreshRegistry, resolveSymbolsForMib, missingRootsForMib), `mibParserUtils` (stripComments).

**Used by:** `src/api/routes/mibs.ts — list/get/upload/delete + Browse `/structure` + MIB-aware `/walk``, `src/services/oidRegistry.ts — refreshes the symbol table on create/delete`, `src/services/monitoringService.ts — via oidRegistry for vendor profile matching`.

**Invariants:**
- SMI parser validates UTF-8 text only (rejects NUL and control chars <0x20 except tab/CR/LF).
- Module header required: `<NAME> DEFINITIONS ::= BEGIN`; footer required: `END`. The module-name regex tolerates **mixed-case** identifiers (`[A-Z][A-Za-z0-9-]*`) — RFC-canonical names like `SNMPv2-MIB`, `SNMPv2-SMI`, `SNMPv2-TC` carry a lowercase `v` for version segments, matching the same tolerance the IMPORTS-parser uses below. An uppercase-only regex would capture the trailing `MIB` after `SNMPv2-` as the module name.
- Duplicate check on (manufacturer, model, moduleName) tuple catches generics via explicit query (NULL handling).
- Successful create/delete always refreshes oidRegistry immediately.
- `parseMibStructured` is a peer of `parseMib`, NOT a superset call. A regression in the structured parser must not be reachable from the upload hot path. Per-symbol parse failures degrade fields to null rather than dropping symbols.

**When changing this:**
- Verify `createMib` duplicate-check logic handles NULL fields in your test data.
- Confirm `parseMib` rejects binary/non-text files (test with fixture files).
- `createMib` AWAITS `refreshRegistry()` (it used to fire-and-forget) because the `MibUploadResult` readiness figures — `symbolCount`, `unresolvedCount`, `unresolvedRoots[{symbol, module}]` — are read out of the refreshed table; a refresh failure degrades to zeros rather than failing the upload the row already exists for. Check readiness after a parser change by uploading a leaf module without its core module and confirming the response names the core module.
- Update `DEFAULT_ALIASES` in `manufacturerAliasService.ts` if adding new vendor facets.
- Check `src/api/routes/mibs.ts` (NOT `serverSettings.ts`) for upload/list/delete endpoint compliance — the MIB routes were extracted there to take precedence over `/server-settings`'s blanket `requireAdmin`.
- Re-run `tests/unit/mibParseStructured.test.ts` — covers IF-MIB-style table detection, INTEGER enum extraction, multi-line DESCRIPTION, embedded `""` quote escapes, and comment-tolerant enum bodies.
- `stdMibLibrary.ts` re-uses `parseMibStructured` against bundled standard-MIB text files — any change to the parser must keep the 16 cases in `tests/unit/stdMibLibrary.test.ts` (SNMPv2-MIB / IF-MIB / HOST-RESOURCES-MIB / ENTITY-MIB / ENTITY-SENSOR-MIB / LLDP-MIB spot-checks) green.

---

## services/oidRegistry.ts

**What it owns:** Per-asset scoped OID symbol resolution from MIBs (device → vendor → generic → **standard** → seed), layered SCOPED symbol caching with per-symbol provenance, the process-wide **standard layer** (the IETF/IEEE modules bundled under `src/services/stdMibs/`, read from disk once and resolved together), and lazy cache warmup at app startup. Also exports the low-level building blocks (`BUILT_IN_OIDS`, `parseObjectAssignments`, `tryResolveParts`) and the resolved standard table (`resolveStandardSymbols`) that `stdMibLibrary.ts` stamps `fullOid` from — so Browse/Walk and the probe path read one answer for a standard OID.

**Public API:** `resolveOid`, `resolveOidSync`, `ensureRegistryLoaded`, `refreshRegistry`, `resolveStandardSymbols`, `scopeCacheStats`, `resolveSymbolAtVendorScope`, `symbolReadiness`, `missingRootsForMib`, `definingModulesFor`, `listModelOverrides`, `getMibSymbolCount`, `resolveSymbolsForMib`, `resolveSymbolForMib`, `findUnresolvedRootSymbols`, `parseObjectAssignments`, `tryResolveParts`, `BUILT_IN_OIDS`, `ResolveScope`, `ResolvedSymbol`, `SymbolStatus`, `SymbolReadiness`, `MissingRoot`.

**Dependency naming (2026-09):** every loaded module — uploads and the standard layer — contributes its IMPORTS bindings (`parseImportMap`), so `definingModulesFor(symbol)` answers "which module defines `fortinet`?" from the operator's own files, and `missingRootsForMib(id)` returns each unresolved anchor of an upload paired with the module its own IMPORTS names. `symbolReadiness(manufacturer, symbol, pinnedMibId?)` is the synchronous per-row answer the profile page renders: resolved (module + layer) or unresolved with a hint — `imports` (the pinned MIB is missing `roots`) or `no-module` (nothing loaded defines it). Polaris ships no table of vendor module names; this is read off what the operator uploaded.

**Cross-service deps:** `mibService` (via import in mibService for refreshRegistry calls), `mibParserUtils` (stripComments), `node:fs` for the `stdMibs/` directory (the same files `stdMibLibrary` and `scripts/copy-build-assets.mjs` know about — a build that forgets to copy them leaves the standard layer empty with a warn, and `stdMibLibrary.test.ts` is what catches it).

**Used by:** `src/app.ts — startup warmup`, `src/services/monitoringService.ts — telemetry probe resolution`, `src/services/mibService.ts — profile status introspection`, `src/api/routes/mibs.ts — Browse modal OID resolution + MIB-aware walk symbol → numeric OID lookup`, `src/services/stdMibLibrary.ts — reads the standard table for fullOid stamps`.

**Invariants:**
- Resolution is scoped per (manufacturer, model) tuple; both cached and layer-resolved case-insensitively.
- **Layer order is device → vendor → generic → standard → seed, higher overwrites lower.** An uploaded generic module of the same name as a bundled standard overrides it — an operator can carry a newer IF-MIB than Polaris ships. Every scope map starts from a COPY of the standard layer's resolved table; the standard layer itself is resolved once per process and never cleared by `refreshRegistry()` (the files cannot change at runtime).
- **The bundled standard modules resolve TOGETHER**, so a module anchored on a sibling's symbol (Q-BRIDGE-MIB on BRIDGE-MIB's `dot1dBridge`, RSTP-MIB on `dot1dStp`) sees it with nothing seeded by hand. Those two anchors left `BUILT_IN_OIDS` in 2026-09; `oidRegistry.test.ts` pins that they stay out.
- **A model with no device-scoped upload SHARES its manufacturer's scope map** (`hasDeviceScopedMibs` decides; `scopeCacheStats()` exposes the count). With ~1000 standard symbols in every map, this is what keeps a 2000-asset fleet across a hundred models at a handful of maps rather than a hundred. `oidRegistryStandardLayer.test.ts` pins the sharing and the distinct map a device-scoped upload still earns.
- Cache rebuilt entirely on any `refreshRegistry()` call (no partial updates).
- Built-in seed (BUILT_IN_OIDS) always acts as final fallback; vendor OIDs override generic MIBs.
- Seed currently covers Cisco / Juniper / HP-Aruba / Dell-RADLAN / Fortinet FortiGate / FortiSwitch / FortiAP — each vendor seed includes the vendor-specific telemetry symbols (CPU / memory and, where applicable, disk / temperature) so probes work without uploading the proprietary MIB. **Scheduled to leave in Phase 3 of the uniform-SNMP plan** (see cross-cutting/vendor-snmp-knowledge-boundary.md): the seed keeps only SMI scaffolding, vendor OIDs come from uploads, and the readiness surfaces of Phase 2 say what to upload.
- Seed also covers the **IEEE 802.1 anchor chain** (`std` 1.0, `iso8802` 1.0.8802, `ieee802dot1` 1.0.8802.1, `ieee802dot1mibs` 1.0.8802.1.1). LLDP-MIB does not need it (its anchor spells every arc with an inline number), but the IEEE8021-* family does: IEEE8021-MSTP-MIB anchors at `::= { ieee802dot1mibs 6 }` with that symbol IMPORTed from IEEE8021-TC-MIB. Without the seed the module ROOT is unresolvable and every symbol chained off it fails too — the operator-visible symptom is an uploaded MIB where **nothing** resolves, not a few gaps. Cross-checked against the bundled LLDP-MIB (`1.0.8802.1.1.2` == `ieee802dot1mibs.2`).
- `findUnresolvedRootSymbols(rawText, resolved)` reports the distinct EXTERNAL names a MIB references but nothing defines — the actionable cause behind an unresolved count. Locally-defined-but-unresolved names are skipped (symptoms, not causes). **`resolved` is the `resolveSymbolsForMib` shape, which keys every symbol with `null` for the unresolved ones — so resolution is `get(n) != null`, never `has(n)`.** A `has()` test reports zero root causes on exactly the broken MIBs the helper exists to explain; `tests/unit/oidRegistry.test.ts` pins that case.
- `resolveOidSync()` returns null until `ensureRegistryLoaded()` has completed and the scope has been accessed.
- `tryResolveParts` accepts three token shapes per OID part: pure integers (`"42"`), known symbols (looked up in the seed/scope map), and **ASN.1 named-number syntax** (`name(digit)` → uses the digit). The named-number form is required by LLDP-MIB's root anchor `{ iso std(0) iso8802(8802) ieee802dot1(1) ieee802dot1mibs(1) 2 }` and benefits any uploaded vendor MIB that uses the same idiom. Strict additive change — strings the legacy code resolved still resolve identically.

**When changing this:**
- Add coverage to BUILT_IN_OIDS if new standard SMI roots or vendor enterprise prefixes are needed.
- Test scope layering with overlapping (manufacturer, model) MIBs to verify override order.
- Verify cache key normalization (case-insensitive) handles mixed-case manufacturer input correctly.
- Run `resolveSymbolAtVendorScope()` after updates to confirm vendor-floor symbol availability.
- Profile performance: cache rebuild is O(mibs × entries × resolution-passes); log timings on large uploads.
- Any change to `tryResolveParts` token-handling must keep `tests/unit/stdMibLibrary.test.ts` "resolves LLDP-MIB through ASN.1 named-number syntax" green AND not regress the 102 cases in `tests/unit/mibParseStructured.test.ts`.

---

## services/stdMibLibrary.ts

**What it owns:** Browse-tree + MIB-aware walk for the eleven bundled standard MIB files (SNMPv2-MIB, IF-MIB, HOST-RESOURCES-MIB, ENTITY-MIB, ENTITY-SENSOR-MIB, LLDP-MIB, POWER-ETHERNET-MIB, BRIDGE-MIB, Q-BRIDGE-MIB, RSTP-MIB, IP-MIB; IF-MIB backs both `std:interfaces` and `std:if-ext`, so twelve keys). Read-only — std MIBs are immutable at runtime. Loads each text file from `src/services/stdMibs/<MODULE>.txt` lazily on first request via `parseMibStructured`, stamps every symbol's `fullOid` from `oidRegistry.resolveStandardSymbols()` (the registry's own standard layer — same files, resolved together, the table the probe path reads), and caches the structured result module-level for the process lifetime.

**Public API:** `STD_MIBS`, `StdMibDef`, `listStdMibs`, `getStdMibDef`, `getStdMibStructure`. (`resolveStdSymbol` was a dead export — no caller in `src/` — and was removed in 2026-09; the walk route resolves through `structured.symbols.find()` inside `runMibWalk()`.)

**Cross-service deps:** `mibService` (parseMibStructured, types), `oidRegistry` (resolveStandardSymbols).

**Used by:** `src/api/routes/mibs.ts — GET /std, GET /std/:key/structure, POST /std/:key/walk routes`.

**Invariants:**
- The 12 dropdown keys (`std:system`, `std:interfaces`, `std:if-ext`, `std:host-resources`, `std:entity`, `std:entity-sensor`, `std:lldp`, `std:poe`, `std:bridge`, `std:q-bridge`, `std:rstp`, `std:ip`) are owned in BOTH the backend `STD_MIBS` constant AND the frontend `_SNMP_STANDARD_MIBS` constant in `public/js/assets.js`. The frontend hardcodes the dropdown today; `GET /std` is for tooling parity. Adding/removing/renaming a std key requires updating both lists in lockstep + the bundled text file in `stdMibs/` + `STD_MIB_KEYS` in `manufacturerProfileService.ts` + `STD_MIB_LABELS`/`STD_MIB_ORDER` in `public/js/server-settings.js` + the `MIBS` table in `scripts/fetch-std-mibs.mjs` + the `EXPECTED` table in `scripts/smoke-std-mibs.ts` + `tests/unit/stdMibLibrary.test.ts` (which asserts the module COUNT, so it fails loudly on a half-done addition).
- **A new module's IMPORTS resolve if the imported module is bundled too.** Since 2026-09 the registry's standard layer resolves every file in `stdMibs/` TOGETHER, so Q-BRIDGE-MIB finds BRIDGE-MIB's `dot1dBridge` and RSTP-MIB its `dot1dStp` with nothing seeded (before that each module resolved alone against `BUILT_IN_OIDS` and came out 0 of 129 / 9 of 19). A module that imports from a module Polaris does NOT bundle still resolves to nothing, silently and totally — `smoke-std-mibs.ts` catches it only if the new module carries `EXPECTED` entries, and `stdMibLibrary.test.ts`'s `unresolvedCount === 0` cases are the regression floor.
- `dist/` copy is by extension glob in `scripts/copy-build-assets.mjs` (`services/stdMibs`, `.txt`), so a new bundled file needs no change there — but a new file with a different extension would.
- `parseObjectAssignments` (re-imported from `oidRegistry`) is the canonical extractor — the structured parser drops some `OBJECT IDENTIFIER` shorthand assignments that the regex resolver picks up. The std resolver calls both extractors and intersects: structured parse for the displayed symbol tree; raw assignments for OID resolution.
- Cache is permanent (process lifetime). No invalidation API — files change only via redeploy.
- The `.txt` files are read at runtime relative to the COMPILED module location (`STD_MIBS_DIR` = `dirname(import.meta.url)/stdMibs`), i.e. `dist/services/stdMibs/` in a built install. `tsc` does NOT copy them — `scripts/copy-build-assets.mjs` (the second half of `npm run build`) mirrors them into `dist/`. A new `.txt` dropped in `stdMibs/` is auto-covered (the copy globs `*.txt`), but if you ever read a non-`.txt` asset from here, add its extension to that script. Dev (`npm run dev` via tsx) reads from `src/`, so a missing-from-`dist/` regression is invisible until you ship — see `cross-cutting/deployment`.
- Bundle refresh is operator-initiated via `node scripts/fetch-std-mibs.mjs` which writes SHA-256 + source URL into `stdMibs/SOURCES.md`. Commit the regenerated text files + SOURCES.md together so the audit trail stays in sync.

**When changing this:**
- Run `npx tsx scripts/smoke-std-mibs.ts` to verify all 27 spot-checks still pass.
- Run `npx vitest run tests/unit/stdMibLibrary.test.ts` for the formal 17 cases (includes a guard that every declared std MIB `.txt` exists on disk).
- If adding a new std MIB: extend `STD_MIBS`, drop the text file in `stdMibs/`, add it to `MIBS` in `scripts/fetch-std-mibs.mjs`, add 2-4 spot-checks to `EXPECTED` in the smoke script, add at least one resolved-OID assertion to the unit test, and add the matching `{ id, label, oid }` entry to `_SNMP_STANDARD_MIBS` in `public/js/assets.js`.
- The IEEE LLDP-MIB carries an IEEE copyright header (preserved verbatim in the file). Re-read the header text on every refresh per the operator's "legal/compliance language requires human review" policy.

---

## services/vendorTelemetryProfiles.ts

**What it owns:** Built-in vendor telemetry profiles (Cisco, Juniper, Mikrotik, Fortinet FortiSwitch, Fortinet FortiAP, Fortinet FortiGate, HP-Aruba, Dell) matching assets by manufacturer + OS + model regex and exposing symbolic OID queries for CPU / memory / disk / temperature — plus, on FortiSwitch, a `model` identity query — via oidRegistry resolution.

**Public API:** `VENDOR_TELEMETRY_PROFILES`, `pickVendorProfile`, `memoryQueryToDoubleScalar`, `VendorTelemetryProfile`, `CpuQuery`, `MemoryQuery`, `DiskQuery`, `TemperatureQuery`, `ModelQuery` (symbol + parse fn; FortiSwitch `fsSysVersion` → `utils/fortiswitchModel.ts` — consumed by `collectSystemInfoSnmp`, adopted onto `Asset.model` by `recordSystemInfoResult` only while the stored model is empty/generic; NOT part of the editable ManufacturerProfile surface — `pickVendorProfileMerged` only overrides cpu/memory/temperature, so the hardcoded profile is the model query's only source). `memoryQueryToDoubleScalar(mem)` translates a hardcoded `MemoryQuery` into the editable Manufacturer Profile's double-scalar shape (`{type, symbol, symbolB, transform}` with the matching `CombinerKind`) — consumed by `seedManufacturerProfiles` and `backfillManufacturerProfileMemoryComposition`. Returns null for empty memory blocks.

**Cross-service deps:** None (vendorTelemetryProfiles is leaf; consumed by monitoringService + mibService).

**Used by:** `src/services/monitoringService.ts — probe strategy selection for telemetry`, `src/services/mibService.ts — profile status reporting in MIB database UI`.

**Invariants:**
- `match` regex is tested against `"${manufacturer ?? ''} ${os ?? ''} ${model ?? ''}".trim()` (all three fields optional).
- Entries ordered in priority; first match wins (no fallback after). Both FortiSwitch and FortiAP must precede the generic Fortinet entry because all three match `manufacturer="Fortinet"`; the model-specific regexes (`/fortiswitch/i`, `/fortiap/i`) sit before the broad `/fortinet|fortigate|fortios/i` so FortiSwitches/FortiAPs don't fall into the FortiGate OID tree.
- CPU/memory/temperature symbols resolve from one of three layers (in priority order): an uploaded MIB at the asset's scope, an entry in `oidRegistry`'s `BUILT_IN_OIDS` seed (currently covers Cisco / Juniper / HP-Aruba / Dell-RADLAN / Fortinet FortiGate + FortiSwitch + FortiAP — these vendors show "READY" out of the box), or — when neither resolves — the HOST-RESOURCES-MIB fallback inside the probe.
- `TemperatureQuery.mode` is `"scalar" | "table"`. `pickVendorProfileMerged` maps the manufacturer-profile `temperature` metric's `type`: `table` → `mode: "table"` (the SNMP collector runs the full `fgHwSensorTable` hardware-sensor walk via `collectHardwareSensorsFortinetSnmp`), `scalar` → `mode: "scalar"` (single `.0` reading, used by FortiAP `fapTemperature` after the fgHwSensorTable + ENTITY-SENSOR walks both come back empty). This is what makes the operator's `table` / `fgHwSensorTable` profile override actually populate (it was silently coerced to a broken scalar GET before the Hardware Sensors work).
- Profile selection is read-only; no runtime mutations. (The `model` identity query's DOWNSTREAM write — `recordSystemInfoResult` stamping `Asset.model` — is guarded: only while the stored model is empty or matches /^fortiswitch\b/i, so operator-typed models survive and a hardware swap self-heals.)
- The parsed model value must keep matching /fortiswitch/i (the `"FortiSwitch <token>"` prefix from `fortiswitchModelFromFsSysVersion`) — the profile `match` haystack includes the model and FortiSwitch assets carry no `os`, so a bare token would drop the asset into the generic Fortinet/FortiGate profile whose 12356.101 OIDs a FortiSwitch doesn't expose. The persisted ManufacturerProfile override's `modelPattern: "FortiSwitch"` regex relies on the same prefix.

**When changing this:**
- Verify new `match` regex pattern against real asset manufacturer/OS values (case-insensitive).
- Confirm CPU/memory/temperature symbol names match the MIB files referenced in CLAUDE.md SNMP stack section.
- Test `pickVendorProfile()` with mixed-case inputs and edge cases (null manufacturer with os set).
- Add model-specific profile entries (e.g. FortiSwitch, FortiAP) BEFORE the generic vendor entry — order is the precedence mechanism.
- Update CLAUDE.md narrative if renaming or reordering built-in profiles.
- If adding a new temperature query, ensure the matching OID is seeded into `oidRegistry.BUILT_IN_OIDS` or upload coverage is required from the operator.

---
