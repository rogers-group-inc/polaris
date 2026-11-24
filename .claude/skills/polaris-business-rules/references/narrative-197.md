# Business rule 197 — full narrative

<a id="rule-197"></a>

## Rule 197 — The Assets table's Sources column names the sources the asset's Sources tab shows

**The ask (2026-11-24, owner).** "On the assets table, the sources column, instead of listing a source based on the settings hierarchy, I want it to say # Sources and the user can mouse over and see each source an asset has." Refined the same day: "I just want it to display the sources (from the sources tab) for each asset, but if there are more than 1 source then it will say # sources … and the user can mouse over to see a hover tooltip of all the sources", and "there should be a location column and then a sources column."

**Why the old column read like a source.** The column titled "Sources" was `location || learnedLocation` (rule 22). For Entra, Intune and Arc devices the projection stores the source's NAME in `learnedLocation` (rule 22's label contributors), and the source-priority setting decides which one wins, so the cell looked like "one source, picked by a hierarchy". It was a location all along. It keeps its `_server` key (saved presets and column prefs are keyed by it) and is now titled **Location**; a new **Sources** column takes the name.

**One set, two surfaces.** The column lists exactly what the Sources tab shows. The tab's presentation order and its collapse to one entry per (sourceKind, integration) — written for `fortigate-endpoint`, whose MAC-keyed rows multiply when a MAC churns — moved out of `listAssetSourcesForDisplay` into `utils/assetSourceOrder.ts`, and both call it. Without that the column would count the duplicate endpoint rows the tab hides.

**What the wire carries.** Only `sourceKind` and the integration's name per entry; the client labels the kind from `_assetSourceLabels` (app.js), the same map the tab uses. Observed blobs and timestamps stay on `GET /assets/:id/sources`.

**The hover.** The table's existing pill tooltip (`.mac-hover-trigger` / `.mac-tooltip`, delegated from the tbody) — the one the MAC and IP cells use — so it positions, lifts out of overflow and hides the same way. One source shows its name with no pill; the integration goes in the title.

**The filter (asked the same day: "a drop down menu with the different sources or null source").** The header is a multi-select of every kind `_assetSourceLabels` names (generic-api and the Unraid / TrueNAS / Proxmox workload kinds were added to that map for it, which also gave the Sources tab their names), plus **(No source)**. Server-side, `sources=<csv>` → `buildSourcesFilter`: a relation `some` on `sourceKind` for the ticked kinds, any-of, and `sources: { none: {} }` for `none`. Filtering on raw rows is safe because the column's collapse only merges rows of the SAME kind, so a row matches exactly when its cell names the kind. A scan-adopted or hand-added asset with no source row is what **(No source)** finds.

**Scale.** One extra relation select per list query (Prisma batches it as a single `IN` over the page's ids); a page is 50 rows by default. At the 10 000-row export ceiling it is one more query of narrow rows; the endpoint-heavy kinds are collapsed in memory.

**Rejected.**
- *Sort on the column.* A count sort would need the collapse in SQL or a denormalised count kept current by every source writer. The filter needed neither.
- *Counting "Manual" and Network-Discovery adoption as sources.* Discussed first, then dropped by the owner in favour of "what the Sources tab shows". A scan-adopted asset has no source row, so it reads "-" until something reports it.
- *Inheriting a location from the dependency parent.* Raised, then scratched by the owner.
