# Business rule 188 — full narrative

> The terse statement of this rule is in [invariants-30-43.md](invariants-30-43.md#188).
> This file holds the reasoning, the incident and the rejected alternatives.

## Contents

- [Rule 188](#rule-188) — ArcGIS layers are read, never written, and a Topology view draws the ones covering its map
- [Rule 188(a)](#rule-188a) — A device link can ride ArcGIS lines, and that stays in Polaris
- [Rule 188(b)](#rule-188b) — A layer can be drawn by type, and only its ticked types are ever fetched
- [Rule 188(c)](#rule-188c) — A view draws the layers whose area covers its map, and keeps only what it hides

## Rule 188 — ArcGIS layers are read, never written, and a Topology view draws the ones covering its map

**The request (2026-11-16).** Three days after cable runs (rule 184) and their ArcGIS write-back (rule 185) shipped, the operator reversed the direction: "I no longer need to upload things to arcgis. Polaris will be purely read only. Maybe I need some options to choose what polaris reads and displays on the topology map." Decisions taken with the operator the same day: Polaris-drawn runs are removed and ArcGIS lines replace them; layers are picked by browsing the portal; the Carlson survey importer and the `cableRuns` key are dropped; a new view draws no ArcGIS layer until one is ticked; each layer may carry a where clause.

**What it says.**

- **Read only, everywhere.** No route, job or service writes to ArcGIS. The integration's sign-in only needs to view; the API-key hint says so.
- **The integration lists the layers (`config.layers`, ≤ 20).** Each: a uuid `id`, the layer `url` (`…/FeatureServer/<n>` or `/MapServer/<n>`, https, not a blocked host), the portal `itemId` when found by search, a `title`, its `geometry` (`line` / `point` / `area`), the `idField` (GlobalID preferred — it survives edits in ArcGIS; OBJECTID otherwise), an optional `labelField`, up to 10 `popupFields`, an optional `where` (≤ 500 characters, no `;` or control characters — ArcGIS checks the SQL, and Test Connection runs it), and a `style` (`color` name mapped to a theme token in map.css, `width` 1–8, `dash` solid / dashed / dotted). Found through `POST /integrations/arcgis/search` (portal search, `type:"Feature Service"`, the organization or the signed-in user's own content), `…/service-layers` and `…/read-layer` — all `integrations` write.
- **The token stays on the server.** The canvas asks `GET /map/arcgis-layers/:layerId/features?bbox=&zoom=` (Device Map read); the server queries ArcGIS in WGS84, generalised to half a pixel at that zoom, capped at 2000 features (`truncated` says so), cached on a bbox snapped outward to the zoom's tile grid (60 s at first; an hour since 2026-11-17, as features change rarely and every pan was a trip to ArcGIS). `?ids=` (≤ 50) fetches a routed line that is outside the view. `GET /map/arcgis-layers` lists styles and an item link — never a URL, a filter or a token.
- **Rule 111 reaches the layers.** A token sent to a layer host outside the portal is a new destination: the schema derives `layerHosts` (hosts that are not the portal's own, nor Esri's `*.arcgis.com` under an Online portal), a list-valued destination key. Saving a layer on a new host therefore needs the secret typed again, and the Layers tab reads a not-yet-saved foreign host without a token.
- **Each view draws what covers it** (188(c), since 2026-11-17; until then each view ticked its layers in `TopologyView.arcgisLayers`, none by default). The view keeps only what it hides, `TopologyView.arcgisHidden`. In the eye menu (the Map layers card in the details pane until 2026-11-17), a change while editing is staged and saved with the view; outside edit mode it lasts until the map closes — the Device types toggles' contract (rule 147).
- **Floor 0, map or satellite only.** Like the runs before them, features draw on floor 0's ground and never over an uploaded plan, whose coordinates are not latitude / longitude.

**Rejected.**

- *Keeping Polaris-drawn runs as a local overlay* — two sources of truth for the same trench; the GIS team's layer is the record.
- *Sending the layer URL and a token to the browser* — the token would leak to every Device Map reader.
- *A web map instead of layers* — less control in Polaris; the operator chose per-layer styling.
- *Checking the where clause at save* — a network round trip on every save; Test Connection does it.

**What went away.** `arcgisWriteBackService`, the `arcgisWriteBack` job, the Write-back tab and its four routes, `CableRun` and `GET/PUT /map/sites/:id/cable-runs`, the Runs drawing tools, the `cableRuns` key (migration `20261116120000_arcgis_read_only` drops `cable_runs`, empties `cable_run_links`, strips the key from every role and the write-back keys from stored configs). Rules 184 and 185 are retired, see this rule.

**Where.** `src/services/arcgisLayerService.ts`; `src/api/routes/integrations.ts` (`ArcgisLayerSchema`, `stampArcgisLayerHosts`, `arcgisConfigForUrl`, the three `/arcgis/*` routes); `src/api/routes/map.ts` (`/arcgis-layers`); `src/services/topologyViewService.ts` (`sanitizeArcgisHidden`); `src/utils/secretDestination.ts` (`layerHosts`); `public/js/topology-arcgis-layers.js`; `public/js/integrations-forms.js` (`arcgisLayersHTML`) + `integrations.js` (`_wireArcgisLayers`). Tests: `tests/unit/arcgisLayerService.test.ts`, `tests/integration/cableRuns.test.ts`.

## Rule 188(a) — A device link can ride ArcGIS lines, and that stays in Polaris

**What it says.** On floor 0 over the map / satellite, a link dragged within 12 px of a shown ArcGIS line is drawn through it: from each device to the line's nearest point, along it, across to the next line where the two come closest (`public/js/cable-run-geometry.js`); bends and end directions are ignored while it rides anything. `CableRunLink` (site + the link's Topology path key → ordered references `<layerId>/<featureId>`, the feature id being the layer's identity-field value) is Polaris-only layout, saved with the edit session through `PUT /map/sites/:id/cable-run-links` on the VIEW gate (`deviceMap` write + its write scope). A malformed reference is refused (400); a reference to a layer that is not a configured LINE layer is dropped. A routed line outside the view is fetched by id; one that is hidden, filtered out or gone from ArcGIS leaves its link drawn straight there, and the eye menu counts those connections under a "Route line missing" pill.

**Rejected.** *Storing the routed geometry* — stale the moment a device or a line moves. *Checking each feature exists on save* — a round trip per save; the canvas shows a missing line instead. *Routing through points or areas* — only lines are routes.

**Where.** `src/services/cableRunService.ts` (`FEATURE_REF_RE`, `listRunLinks`, `applyRunLinkEdits`); `src/api/routes/map.ts` (`/sites/:id/cable-run-links`); `public/js/topology-arcgis-layers.js` (`linkRuns`, `setLinkRuns`, `hitRun`, `highlight`); `public/js/topology-physical.js` (`routedRuns`, `attachRun`, `detachRun`, `drawRunHandles`). Tests: `tests/unit/cableRunService.test.ts`, `tests/unit/cableRunGeometry.test.ts`, `tests/integration/cableRuns.test.ts`.

## Rule 188(b) — A layer can be drawn by type, and only its ticked types are ever fetched

**The request (2026-11-17).** The operator's utility layer holds gas, overhead and underground electric, sewer, water and miscellaneous lines in ONE feature layer, told apart by a type field and drawn by ArcGIS in a colour each. Polaris drew the whole layer in one style, and the same layer URL cannot be added twice to fake it. "I want to modify the integration so that when it queries the URL it gets the different types, then I can select which types I want to include and the line design for those types."

**What it says.**

- **One style or By type, per layer.** By type stores `types: {field, numeric, values[≤ 50]{value, label, on, style}, other{on, style}}`. The field is text or a whole number (`esriFieldTypeString` / `SmallInteger` / `Integer` / `BigInteger`); a decimal or date field is refused.
- **Read types** (`POST /integrations/arcgis/layer-types`, integrations write, the same draft-config and rule-111 handling as `read-layer`): the values in use with a count each (`groupByFieldsForStatistics` on the field, counting the object-id field; `returnDistinctValues` without counts when the service cannot group), the blank count, the field's coded-value names, and the layer's `uniqueValue` renderer — when it renders by that one field with no `field2` or Arcade expression — whose labels win and whose `esriSLS` symbols become the starting styles (colour, width in points × 4/3 clamped 1–8, dash / dot). ArcGIS's types come first in its order, the rest by count; a type with no ArcGIS symbol gets a fallback colour. More than 50 values: refused, with the count — that field names lines, it does not sort them.
- **Colours are free here.** A type's colour is any `#rrggbb` (`TYPE_COLOR_RE`) — the one exception to the six theme-token colours of a one-style layer — so lines match what the GIS team sees. They paint the element's `--arc` inline.
- **Unticked types are never fetched.** `typeWhere` gives `field IN (ticked)`, plus `(field IS NULL OR field NOT IN (all listed))` when Other is ticked; null when everything is drawn; false when nothing is, and then neither `queryFeatures` nor `featuresByIds` calls ArcGIS. `effectiveWhere` ANDs it with the layer's own `where`; Test Connection runs the combined clause. `listMapLayers` sends only ticked types, so the map can only offer those.
- **Re-reading merges.** On the Layers tab a re-read keeps each known type's tick, name and style, brings new ones in ticked, and keeps known types ArcGIS no longer lists (room permitting); **Reset to ArcGIS styles** re-reads and takes ArcGIS's styles for all.

**Rejected.** *The same layer added once per type with a filter each* — six layers to keep in step by hand, and a new type never appears. *Six theme colours for types* — cannot make cyan, blue and dark red at once; the operator approved free colours for types only. *Filtering types in the browser* — every hidden type would still cost a fetch and the 2000-feature cap.

**Where.** `src/services/arcgisLayerService.ts` (`readTypes`, `symbolStyle`, `typesProblem`, `typeWhere`, `effectiveWhere`); `src/api/routes/integrations.ts` (`ArcgisTypeStyleSchema`, `POST /arcgis/layer-types`); `public/js/integrations-forms.js` (`arcgisTypesTableHTML`, `arcgisTypesDialogHTML` — the table opens in a stacked `buildOverlay` dialog, the Layers tab keeps a summary and Edit types); `public/js/integrations.js` (`mergeTypes`, `readTypes`, `openTypesDialog`, `wireTypes` in `_wireArcgisLayers`); `public/js/topology-arcgis-layers.js` (`typeOf`, `typeStyle`, `paintTyped`, `typeRows`). Tests: `tests/unit/arcgisLayerService.test.ts`, `tests/unit/arcgisLayerTypesForm.test.ts`.

## Rule 188(c) — A view draws the layers whose area covers its map, and keeps only what it hides

**The request (2026-11-17).** "These layers are region specific. Do I have to select the layer I want to see for each location, or based on the location of the firewall can we autoselect the layer?" — and each type must be hideable on the map, not only on the integration.

**What it says.**

- **A layer knows its area.** `extentToWgs84` turns the layer description's `extent` into `[w, s, e, n]` degrees: WGS84 as given, Web Mercator (102100 / 3857 / 102113 / 900913) converted, anything else null. It is stored as `extent` when the layer is added and refreshed whenever the Layers tab opens the layer; a layer without one (added before, or in another coordinate system) counts as covering everywhere.
- **Covering = overlapping the map in view**, not the firewall's coordinates: it works for a site without coordinates, and a site near a border gets both regions. Layers outside the view are not queried at all. As the map moves and the covering set changes, the eye menu repaints (`onCoverChange`).
- **A view keeps only what it hides.** `TopologyView.arcgisHidden` (≤ 500): `<layerId>` hides a layer, `<layerId>:<type value>` one type, `<layerId>#other` the other bucket. Anything unlisted draws, so a new view, a new layer and a new type all show by themselves. Hiding a type only redraws — its features are already in hand; showing a layer fetches. A routed connection on a hidden type's line draws straight and counts under Route line missing (188(a)).
- **The eye menu** lists the covering layers, a by-type layer's types nested under it, and names the others "Not here". It opens while editing too, with the same Devices / Groups / Connections and Labels switches (until 2026-11-24 editing showed everything and the menu held only the ArcGIS section); those stay the browser's own, while which ArcGIS layers and types the view hides is saved with it. (Operator 2026-11-17: the Map layers card left the details pane for the eye menu.)
- **The Legend panel** ends with an "ArcGIS layers" section (`paintLegend` → map.js `setArcgisLegend`): each shown layer, a by-type layer's visible types under its name. The panel is capped at 440 px and its body scrolls.
- **Pointing at a feature** opens one floating tooltip with its type (or the layer, for one style), its label and its layer (`wireHover`), apart from the permanent label a zoomed-in line carries.

**Rejected.** *Tagging layers with regions* — configuration the extent already carries. *The firewall's location* — fails on a site with no coordinates and on a map panned across a border. *Storing what a view shows* — a layer or type added later would never appear. *Keeping the per-view picks from 2026-11-16* — a day old; migration `20261117130000_arcgis_view_hidden` drops `arcgis_layers` and every view starts automatic.

**Where.** `src/services/arcgisLayerService.ts` (`extentToWgs84`, `newLayerConfig`); `src/services/topologyViewService.ts` (`sanitizeArcgisHidden`); `src/api/routes/map.ts` (view schemas); `public/js/topology-arcgis-layers.js` (`covers`, `covering`, `shownIds`, `setHidden`, `sidebarHtml`, `layerList`); `public/js/topology-physical.js` (`hiddenArcgis`, `setHiddenArcgis`). Tests: `tests/unit/topologyArcgisLayers.test.ts`, `tests/unit/arcgisLayerService.test.ts`, `tests/integration/cableRuns.test.ts`.
