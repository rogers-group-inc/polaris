## cross-cutting/asset-write-time-clamps-and-shadow-writes

**What it is:** Prisma extension in src/db.ts that automatically normalizes manufacturer, clamps acquiredAt, checks monitoring status, derives asset sources, and records IP history on every Asset create/update/upsert (see "Asset write-time clamps" in CLAUDE.md).

**Writers** (files that mutate or emit this state):
- `src/db.ts` — Extended client wraps asset.create/update/updateMany/upsert/delete with seven hooks:
  - normalizeManufacturerInData() runs `Asset.manufacturer` through normalizeManufacturer()
  - normalizeOsInData() corrects `Asset.os` / `Asset.osVersion` for Windows CLIENTS — see cross-cutting/windows-os-name-correction
  - clampMonitoredForStatus() forces monitored=false + resets consecutiveFailures when status ∈ {decommissioned, disabled}
  - recordIpHistory() upserts AssetIpHistory on ipAddress change
  - shadowWriteAssetSources() derives and upserts AssetSource rows when identity fields change
  - fireDnsResolvedReconcile() schedules a fire-and-forget per-asset reconcile of `dns_resolved` reservations (gated on writes that touch ipAddress / status / hostname / dnsName / macAddress)
  - fireDnsResolvedRelease() (delete branch only) releases any owned `dns_resolved` rows before the row is removed
- `src/utils/manufacturerNormalize.ts` — normalizeManufacturer() pure function (cached alias map, no DB access)
- `src/utils/osNormalize.ts` — normalizeOsInData() / normalizeWindowsOs() pure functions (no DB access, no row read — see the entry below for why)
- `src/utils/assetInvariants.ts` — clampAcquiredToLastSeen() logic (not hooked yet; job applies it at startup)
- `src/utils/assetSourceDerivation.ts` — deriveAssetSources() pure function producing AssetSource rows from legacy tags
- `src/jobs/normalizeManufacturers.ts` — One-shot startup: seeds default aliases, loads cache, backfills existing Assets
- `src/jobs/clampAssetAcquiredAt.ts` — One-shot startup: clamps acquiredAt ≤ lastSeen for pre-existing rows

**Readers** (files that consume it):
- Any code path that writes to Asset (discovery, UI routes, jobs) gets the extension hooks applied automatically.
- `src/services/manufacturerAliasService.ts` — Manages the alias cache that normalizeManufacturer consults.
- `src/app.ts` — Warms the OUI / manufacturer alias cache at boot before any Asset writes occur.

**Invariants:**
- Every Asset create/update that touches manufacturer will have the value normalized by the alias map at write time (no raw "Fortinet, Inc." rows survive).
- clampAcquiredToLastSeen is gated by a marker key (job doesn't re-run); startup check will warn if marker is missing.
- IP history is fire-and-forget best-effort; a transient DB error doesn't block the underlying Asset write.
- **Fire-and-forget means UNORDERED, not just error-swallowing — and that is the half that bites.** `recordIpHistory()` is not awaited, so its `INSERT ... ON CONFLICT` is still in flight when the caller's `asset.create` / `update` has already resolved. Anything that reads or deletes `AssetIpHistory` immediately after an Asset write is racing it: `tests/integration/ipUpstreamChain.test.ts` deleted the row to model "no history for this address", WON the race, and the upsert then landed on top with `lastSeen = now`, which made a deliberately month-old claim read as FRESH and failed a test about rule 40 staleness for reasons nothing in the test could explain. The fix pattern is to wait for the row to APPEAR (proving the single in-flight upsert has landed) and only then delete it, which `dropIpHistory()` in that file does. A bare `deleteMany` after an Asset write that carries an IP is never safe, and neither is asserting the row's absence. Same shape as `fireDnsResolvedReconcile()` above — see cross-cutting/dns-resolved-reservations for the reservation-side version of the same race.
- shadowWriteAssetSources uses the same derivation rules as the backfill job; updates only refresh metadata (syncedAt, lastSeen, integrationId), never overwrite observed JSON that came from discovery.
- updateMany doesn't trigger shadowWriteAssetSources (rare on identity fields; backfill catches drift on next startup).
- Extension runs AFTER the query executes; result reflects the DB commit state, not pre-normalization input.

**When changing this:**
- New clamps must be added to BOTH normalizeManufacturerInData() (for manufacturer) AND clampMonitoredForStatus() branches, preserving order (normalize first, clamp second, then shadow-write).
- If bypass paths exist (raw SQL, stored procedures, external scripts), they MUST be audited and manually corrected via startup jobs (extension can't intercept).
- Test the order: create an asset with status=decommissioned, monitored=true, consecutiveFailures=5; verify monitored flips to false and counter resets.
- Verify alias cache is warmed: set a new alias, restart the app, create an asset with the old name; spot-check it got normalized.
- Check IP history on duplicate IP: same asset, new source; verify firstSeen was reset (CASE expression in SQL working) and lastSeen bumped.

---
