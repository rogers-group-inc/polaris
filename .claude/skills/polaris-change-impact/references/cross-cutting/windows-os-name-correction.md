## cross-cutting/windows-os-name-correction

**What it is:** `Asset.os` / `Asset.osVersion` are corrected at write time for Windows CLIENTS, because Microsoft never updated the registry key `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProductName` when Windows 11 shipped — it still reads "Windows 10 Pro" on every Windows 11 machine. That key is what WMI's `Win32_OperatingSystem.Caption` and `systeminfo` read, so this is not one broken integration but *every* source at once, which is why the projection priority order can't fix it: whichever source wins is equally wrong. The build number is always right (it comes from `CurrentBuild`, not the frozen display string), so the build is the authority and the name is derived from it. The pair also gains the marketing release operators actually speak in: `"Windows 10 Pro" + "10.0.22631.7219"` → `"Windows 11 Pro" + "23H2 (10.0.22631.7219)"`.

**Writers** (files that mutate or emit this state):
- `src/utils/osNormalize.ts` — `normalizeWindowsOs(pair)` (pure), `normalizeOsInData(data)` (Prisma-args mutator, mirrors `normalizeManufacturerInData`'s contract), `windowsBuildFrom(...candidates)` (build extractor). Unit-tested in tests/unit/osNormalize.test.ts.
- `src/utils/assetProjection.ts` — `projectAssetFromSources()` runs the pair through `normalizeWindowsOs` as a post-pass, AFTER `OS_RULES` / `OS_VERSION_RULES` resolve. `provenance` still names the source the RAW value came from.
- `src/db.ts` — `normalizeOsInData()` on the asset create / update / updateMany / upsert(create+update) hooks; the catch-all for writers that don't go through the projection.

**Readers** (files that consume it):
- `public/js/assets.js` — the Assets table's OS/Firmware column (`[a.os, a.osVersion].join(" ")`), the asset-details General tab row (same join), and the CSV/PDF export column all read the stored pair.
- `public/js/mobile/asset-detail.js` — the mobile sheet's OS row (same join).
- `src/services/tagAssignmentService.ts` / `src/services/maintenanceScheduleService.ts` / `src/services/notificationTypes.ts` — `os` / `osVersion` are criteria + scope-condition fields, so an "os contains Windows 11" rule is only true if the stored column says so. This is the whole reason the correction is at write time rather than at render.

**Invariants:**
- **FAMILY comes from a threshold, RELEASE from a table** — deliberately separate mechanisms. `build >= WINDOWS_11_MIN_BUILD` (22000) ⇒ Windows 11 never goes stale, so a build released after this code was written still gets the right family. `CLIENT_RELEASES` does go stale, so an unlisted build keeps its RAW `osVersion` rather than being guessed at (the family fix still lands).
- **Windows Server is excluded entirely** (any os string containing "server"). Its ProductName is already correct, and build 26100 is BOTH Windows 11 24H2 and Windows Server 2025 — the threshold would relabel a 2025 server as "Windows 11".
- **Idempotent.** Every discovery cycle re-writes the pair and db.ts re-runs the hook, so the transform must be a no-op on its own output: `RELEASE_PREFIX` skips an already-labeled `osVersion` (else `"23H2 (23H2 (10.0.22631.7219)))"`), and the family swap rewrites a correct string to itself.
- **The `os` name is the gate.** A bare version string with no `os` is left alone — treating "10.0.22631.7219" as Windows without a name to corroborate it would be a guess. `windowsBuildFrom` likewise returns null rather than acting on a weak signal (a 5-digit run inside longer text).
- **No row read in the db.ts hook.** It reads the build from whatever `osVersion` the SAME write stages. That's sound because every real writer stages the pair together (the projection, the agents system-info route, each discovery create), and a point read there would land on the monitor hot path — 2000 extra queries per heavy cycle to fix a case no writer produces.
- **Normalizing must happen on BOTH sides.** Correcting only on the way to the DB would leave `projectAssetFromSources` returning "Windows 10 Pro" while the stored row says "Windows 11 Pro", so every comparison of projection against the row (conflict proposals, the merge paths) would see a difference that is not there. This is why the projection normalizes its own output rather than relying on the db.ts hook.
- Not retroactive: existing rows correct themselves when their integration next re-projects them (the pull-based precedent from business rule 22). There is no backfill job.

**When changing this:**
- Microsoft shipped a new Windows client release → add the build to `CLIENT_RELEASES`. Nothing breaks if you forget (family still corrects, raw version preserved).
- Adding a source kind that reports OS in a NEW shape → add a pattern to `windowsBuildFrom` + a case to tests/unit/osNormalize.test.ts. The shapes covered today: `"10.0.22631.7219"` (Intune/Entra/Arc), `"10.0.22631"` (Arc), `"10.0 (22631)"` (AD `operatingSystemVersion`), `"10.0.22631 Build 22631"` (gopsutil, i.e. the agent), bare `"22631"`.
- Changing the `osVersion` OUTPUT format is a breaking change for operators — saved table-filter presets (`SavedTableFilter`), tag criteria and automation scope conditions may match on the string. Keep the raw value inside the parens.
- Run `npm test` — tests/unit/assetProjection.test.ts asserts the labeled `osVersion` in two places, so a format change fails loudly there too.

---
