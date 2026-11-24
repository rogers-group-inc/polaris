## cross-cutting/server-side-list-tables

**What it is:** The Events and Assets list pages run `TableSF` in **server-side mode** — filter/sort/pagination happen in the API, only one page reaches the browser. The filter/sort *contract* is split across three files per page and they must stay in sync. (See polaris-ui-canon → "Sortable + filterable data table" for the full pattern; the other list pages — subnets/blocks/reservations — are still client-side `sf.apply()` and are NOT covered here.)

**The three-file contract (per page):**
- **`public/<page>.html`** — `<th data-sf-key=… data-sf-type=… data-sf-options=…>` defines which columns are filterable/sortable + the static multi-select option sets. The `data-sf-key` is the wire name.
- **`public/js/<page>.js`** — the `_build*Query()` translator maps live `sf._filters` / `sf._sortKey` / `sf._sortDir` + pagination onto API params (`events.js:_buildEventsQuery`, `assets.js:_buildAssetsQuery`). `onChange` resets offset and re-fetches; **never** `sf.apply()`.
- **`src/api/routes/<page>.ts`** — the list handler parses those params into a Prisma `where`/`orderBy` with a **sort whitelist** (400 on anything off it) and the operator-aware text-filter helpers. `events.ts` (`buildTextFilter`) and `assets.ts` (`buildAssetTextFilter` / `buildServerFilter` / `monitorClause` / `buildAssetListWhere` / `buildAssetOrderBy`) are the references.

**Assets-specific wrinkles:**
- `favoriteIds` (CSV from the `polaris-favs-assets-<user>` localStorage set) → a two-bucket query in `assets.ts` floats starred rows to the top of the *whole* result set. The two `count`s + split-window `findMany`s only run when the set is non-empty.
- `_monitor` is a synthetic column: `monitorClause()` maps each chip (Monitored/Unmonitored/Up/Missed/Down/Recovering/Passive/Pending) onto `monitored` + `monitorStatus`. **`monitorClause` still accepts the pre-rename `"Warning"` chip as an alias for `"Missed"`** — the chip STRING is persisted verbatim inside `SavedTableFilter.state` and `UserTableTabs` rows, so dropping it would silently turn every stored preset naming it into no filter at all; `_server` spans `location`+`learnedLocation`, and a contains / not_contains term also matches ANY of the asset's `AssetSource` rows (`resolveSourceMatches`: each contributor's observed location keys, the catalogue label, the raw `sourceKind`, the integration name) — the cell shows only the priority winner, the filter searches every source.
- The Type column is the one **dynamic** multi-select on the page: the `data-sf-options` in `assets.html` is only a pre-fetch seed of the built-in registry rows, replaced at init by `_loadAssetTypeOptions()` → `sf.setColumnOptions("assetType", …)` from `GET /asset-types`, so operator-added custom types are filterable. It's awaited before `_restoreAssetsPrefs()` / `_applyAssetsHashFilters()` — `setColumnOptions` drops saved filter values that have no matching option, and the `#type=` hash guard tests `ASSET_TYPE_LABELS`.
- Cross-page bulk selection: `_assetsSelected` (id Set) + `_assetsSelectedMeta` (id→{status,assetType}) survive paging because page-nav calls `fetchAssetsPage()` (no clear); only `loadAssets()` (Refresh / post-mutation) clears them.
- Export: `_fetchAssetsForExport` re-pages from the server for filtered/all; "page" uses the in-memory page.

**When changing this:**
- Add a filterable/sortable column → add the `<th data-sf-key>` in HTML, the param mapping in `_build*Query`, the `where`/whitelist handling in the route, **and** an index if it becomes a common sort.
- Adding a sort key → it MUST be in the route's sort whitelist or the request 400s.
- The list payload `select` omits heavy fields (notes, etc.); anything the table/export renders must be in it.
- `assets.js` per-row in-memory lookups (`_setAssetType`, `_flipAssetMonitor`, `viewAssetLease`) only see the current page — that's fine because they're triggered from visible rows. Don't assume `_assetsData` holds the whole fleet.

---
