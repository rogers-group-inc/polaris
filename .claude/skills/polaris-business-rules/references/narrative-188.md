# Business rule 188 — full narrative

> The terse statement of this rule is in [invariants-30-43.md](invariants-30-43.md#188).
> This file holds the reasoning, the incident and the rejected alternatives.

## Contents

- [Rule 188](#rule-188) — ArcGIS layers are read, never written, and each Topology view picks the ones it draws
- [Rule 188(a)](#rule-188a) — A device link can ride ArcGIS lines, and that stays in Polaris

## Rule 188 — ArcGIS layers are read, never written, and each Topology view picks the ones it draws

**The request (2026-11-16).** Three days after cable runs (rule 184) and their ArcGIS write-back (rule 185) shipped, the operator reversed the direction: "I no longer need to upload things to arcgis. Polaris will be purely read only. Maybe I need some options to choose what polaris reads and displays on the topology map." Decisions taken with the operator the same day: Polaris-drawn runs are removed and ArcGIS lines replace them; layers are picked by browsing the portal; the Carlson survey importer and the `cableRuns` key are dropped; a new view draws no ArcGIS layer until one is ticked; each layer may carry a where clause.

**What it says.**

- **Read only, everywhere.** No route, job or service writes to ArcGIS. The integration's sign-in only needs to view; the API-key hint says so.
- **The integration lists the layers (`config.layers`, ≤ 20).** Each: a uuid `id`, the layer `url` (`…/FeatureServer/<n>` or `/MapServer/<n>`, https, not a blocked host), the portal `itemId` when found by search, a `title`, its `geometry` (`line` / `point` / `area`), the `idField` (GlobalID preferred — it survives edits in ArcGIS; OBJECTID otherwise), an optional `labelField`, up to 10 `popupFields`, an optional `where` (≤ 500 characters, no `;` or control characters — ArcGIS checks the SQL, and Test Connection runs it), and a `style` (`color` name mapped to a theme token in map.css, `width` 1–8, `dash` solid / dashed / dotted). Found through `POST /integrations/arcgis/search` (portal search, `type:"Feature Service"`, the organization or the signed-in user's own content), `…/service-layers` and `…/read-layer` — all `integrations` write.
- **The token stays on the server.** The canvas asks `GET /map/arcgis-layers/:layerId/features?bbox=&zoom=` (Device Map read); the server queries ArcGIS in WGS84, generalised to half a pixel at that zoom, capped at 2000 features (`truncated` says so), cached 60 s on a bbox snapped outward to the zoom's tile grid. `?ids=` (≤ 50) fetches a routed line that is outside the view. `GET /map/arcgis-layers` lists styles and an item link — never a URL, a filter or a token.
- **Rule 111 reaches the layers.** A token sent to a layer host outside the portal is a new destination: the schema derives `layerHosts` (hosts that are not the portal's own, nor Esri's `*.arcgis.com` under an Online portal), a list-valued destination key. Saving a layer on a new host therefore needs the secret typed again, and the Layers tab reads a not-yet-saved foreign host without a token.
- **Each view picks.** `TopologyView.arcgisLayers` (layer ids, ≤ 20; empty for a new view and after a mode reset). In the Map layers card, a tick while editing is staged and saved with the view; outside edit mode it lasts until the map closes — the Device types toggles' contract (rule 147).
- **Floor 0, map or satellite only.** Like the runs before them, features draw on floor 0's ground and never over an uploaded plan, whose coordinates are not latitude / longitude.

**Rejected.**

- *Keeping Polaris-drawn runs as a local overlay* — two sources of truth for the same trench; the GIS team's layer is the record.
- *Sending the layer URL and a token to the browser* — the token would leak to every Device Map reader.
- *A web map instead of layers* — less control in Polaris; the operator chose per-layer styling.
- *Checking the where clause at save* — a network round trip on every save; Test Connection does it.

**What went away.** `arcgisWriteBackService`, the `arcgisWriteBack` job, the Write-back tab and its four routes, `CableRun` and `GET/PUT /map/sites/:id/cable-runs`, the Runs drawing tools, the `cableRuns` key (migration `20261116120000_arcgis_read_only` drops `cable_runs`, empties `cable_run_links`, strips the key from every role and the write-back keys from stored configs). Rules 184 and 185 are retired, see this rule.

**Where.** `src/services/arcgisLayerService.ts`; `src/api/routes/integrations.ts` (`ArcgisLayerSchema`, `stampArcgisLayerHosts`, `arcgisConfigForUrl`, the three `/arcgis/*` routes); `src/api/routes/map.ts` (`/arcgis-layers`); `src/services/topologyViewService.ts` (`sanitizeArcgisLayers`); `src/utils/secretDestination.ts` (`layerHosts`); `public/js/topology-arcgis-layers.js`; `public/js/integrations-forms.js` (`arcgisLayersHTML`) + `integrations.js` (`_wireArcgisLayers`). Tests: `tests/unit/arcgisLayerService.test.ts`, `tests/integration/cableRuns.test.ts`.

## Rule 188(a) — A device link can ride ArcGIS lines, and that stays in Polaris

**What it says.** On floor 0 over the map / satellite, a link dragged within 12 px of a shown ArcGIS line is drawn through it: from each device to the line's nearest point, along it, across to the next line where the two come closest (`public/js/cable-run-geometry.js`); bends and end directions are ignored while it rides anything. `CableRunLink` (site + the link's Topology path key → ordered references `<layerId>/<featureId>`, the feature id being the layer's identity-field value) is Polaris-only layout, saved with the edit session through `PUT /map/sites/:id/cable-run-links` on the VIEW gate (`deviceMap` write + its write scope). A malformed reference is refused (400); a reference to a layer that is not a configured LINE layer is dropped. A routed line outside the view is fetched by id; one that is hidden, filtered out or gone from ArcGIS leaves its link drawn straight there, and the Map layers card counts those connections under a "Route line missing" pill.

**Rejected.** *Storing the routed geometry* — stale the moment a device or a line moves. *Checking each feature exists on save* — a round trip per save; the canvas shows a missing line instead. *Routing through points or areas* — only lines are routes.

**Where.** `src/services/cableRunService.ts` (`FEATURE_REF_RE`, `listRunLinks`, `applyRunLinkEdits`); `src/api/routes/map.ts` (`/sites/:id/cable-run-links`); `public/js/topology-arcgis-layers.js` (`linkRuns`, `setLinkRuns`, `hitRun`, `highlight`); `public/js/topology-physical.js` (`routedRuns`, `attachRun`, `detachRun`, `drawRunHandles`). Tests: `tests/unit/cableRunService.test.ts`, `tests/unit/cableRunGeometry.test.ts`, `tests/integration/cableRuns.test.ts`.
