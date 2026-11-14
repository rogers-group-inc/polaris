# Business rule 184 — full narrative

> Written 2026-11-13 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 184](#rule-184) — A cable run belongs to its site, rides its own key, and a trench is never drawn by hand
- [Rule 184(a)](#rule-184a) — A device link can ride runs, and that stays in Polaris

## Rule 184 — A cable run belongs to its site, rides its own key, and a trench is never drawn by hand

**The request (2026-11-13).** The operator wanted to mark fiber and ethernet runs on the Device Map's Topology view, over the ArcGIS satellite imagery (rule 183): trenched runs, and runs that follow electric or telephone poles. These runs are written back to the corporate ArcGIS (a later batch: one way, Polaris → ArcGIS). They said poles and trenches "are essentially the same thing", told apart by colour; that a run is "essentially dark fiber", drawn freely, and that a connection between two devices can later be dragged onto it; that drawing them "should be behind RBAC since it writes back to another system"; and then that **a trench is added from a survey file** (a Carlson `.crd` or its text export, with elevation) rather than drawn.

**Decisions.**

- **The site owns a run, not a view.** A run is a physical thing at the site; every Topology view of the site shows it, and rule 149's mode reset — which wipes everything mode-specific on a view — cannot take it. So it is a table (`CableRun`, `site_id` → the FortiGate asset, cascade) rather than another JSON key on `TopologyView`, which also gives each run the stable id and sync columns the ArcGIS write-back needs.
- **Real coordinates only.** `points` is WGS84 `[[lng, lat, z?], ...]` — floor 0's order over the map / satellite ground and GeoJSON's. Runs never draw over an uploaded plan image, whose coordinates are not latitude / longitude; the server refuses a point outside latitude / longitude range, which is also what stops a state-plane grid survey (northing ~196 000, easting ~1 230 000 ft) being saved as a run. Elevation (z) is kept for ArcGIS; Polaris draws and measures in 2D (`lengthM`, great-circle).
- **One shape, two kinds.** Placement is `trench` | `electric_pole` | `telephone_pole` and is the colour (accent / serious-orange / success-green, from CSS classes because an SVG presentation attribute cannot read a CSS variable); medium `fiber` | `ethernet` is the dash. The legend always names both, so colour is never the only cue. A pole run's bends are its poles, marked on the line.
- **A trench is surveyed, never drawn.** `applyRunEdits` refuses a hand-drawn trench and any change to a surveyed run's points or placement (`source: "crd"`); the map offers no vertex handles on one. A revised survey is re-imported instead. Until the importer lands, no trench can exist, which is the point: a hand-drawn trench would carry none of the survey's accuracy.
- **Its own key.** `cableRuns` (full ladder, tag-scoped like `deviceMap`, rule 141(e)): Read shows the runs and their sync state, Read-Write edits them at sites the caller owns or that carry their tags, Full Read-Write at any site. Never a rung of `deviceMap`: a Device Map layout stays inside Polaris, a run leaves it. The migration seeds admin fullwrite, readonly read, every other role none — an administrator grants it on purpose. The AI assistant's bot role is read-only by construction (rule 95), so it may read runs and can never write one.
- **The edit session, not live writes.** The run layer stages its working copy's difference (`upserts` new or changed, `deletes`) through `ctx.stageCableRuns`; map.js sends it as one `PUT /map/sites/:id/cable-runs` when the session commits and drops it when the session closes. The server applies it in one transaction with an Event per create / update / delete (a point list is recorded as its count, not every vertex). Undo / redo carry the runs with the rest of the canvas.
- **Sync columns from day one.** `syncStatus` is "off" until a write-back is configured. A run that has been sent (pending / synced / failed) becomes `pending` on an edit; deleting it leaves a tombstone (`deletedAt`, `pending`) so the write-back can delete the ArcGIS feature before the row goes. A run never sent is deleted outright.

**Rejected.**

- *A `cableRoutes`-style JSON key on the view* (rule 179's Room-view cables) — per view, wiped by a mode reset, and no stable id for ArcGIS.
- *Gating on `deviceMap` write* — the operator's explicit RBAC decision: writing to another system is its own grant.
- *Drawing trenches by hand "for now"* — the survey is the source of truth for a trench.

**Where.** `prisma/schema.prisma` (`CableRun`), migration `20261113210000_cable_runs` (table + key seed); `src/services/cableRunService.ts`; `src/api/routes/map.ts` (`GET` / `PUT /sites/:id/cable-runs`); `src/api/middleware/permissions.ts` (`cableRuns`); `public/js/topology-cable-runs.js` (the layer, panel, legend), `topology-physical.js` (host: draw tool, undo, Delete, Escape), `map.js` (`fetchCableRuns` / `stageCableRuns` / `canDrawRuns`, the commit), `api.js`, `css/map.css` (`.topo-run-*`). Tests: `cableRunService`, `topologyCableRuns`, `permissionLevelLadders`, `tests/integration/cableRuns.test.ts`.

## Rule 184(a) — A device link can ride runs, and that stays in Polaris

**The request (2026-11-13).** "When two assets that connect together are added to the map then that connection is a straight line between them. Allow the user to drag the connection, like editing a point, to the freely drawn run and connect it to that. When that happens the connection then goes through the freely drawn run." And, asked whether ArcGIS should learn which links ride a run: runs only.

**Decisions.**

- **The drag that makes a bend makes a route.** Pressing a link and dragging is already how a bend is made; within 12 px of a run the run lights up, the bend is withdrawn and a dashed preview shows the routed line, and the drop attaches the run. A routed link takes no bends and shows one handle per run it rides, at the middle of its stretch: dragged onto another run it swaps runs, dragged off every run (or Delete) it leaves that run, and with none left the link is straight again — its old bends come back, untouched.
- **The route is computed, not stored.** Stored is only which runs (`runIds`); the line is worked out at draw time in Web Mercator metres: each device joins its run at the run's nearest point, consecutive runs are joined where they come closest (vertex-to-segment both ways), and the runs are put in order along S → T at draw time, so moving a device or editing a run's points re-routes every link on it.
- **Site-owned, like the run.** `CableRunLink` is keyed by the site and the link's Topology path key (`<kind>|<source>|<target>[#n]`, the key its bends use), so every view of the site draws the same route, and rule 149's mode reset never wipes it. It is a table rather than a placement-blob key because the blob holds `{x, y}` points only.
- **The view's gate, not the run's.** Which links ride a run is never sent to ArcGIS (the operator's choice), so it is ordinary Device Map layout: `deviceMap` write plus its write scope. Someone who may route links but not draw runs can still route along existing runs.
- **Forgiving on ids, strict on keys.** A run id that is not a live run at the site is dropped (another session may have just deleted it) rather than failing the whole save; a malformed path key is a 400. Only a saved run has an id, so a run drawn this session must be saved before a link can ride it (the map says so).
- **A deleted run leaves its links in the same transaction** as the delete (`applyRunEdits`), and a link left riding nothing is deleted. The edit session sends the runs PUT first and the links PUT after it.

**Rejected.** *Storing the routed geometry* — it would go stale the moment a device or a run moved. *Writing riders to ArcGIS* — the operator chose runs only. *Gating on `cableRuns`* — nothing leaves Polaris.

**Where.** `prisma/schema.prisma` (`CableRunLink`), migration `20261113220000_cable_run_links`; `cableRunService` (`listRunLinks`, `applyRunLinkEdits`, the delete hook in `applyRunEdits`); `src/api/routes/map.ts` (`PUT /sites/:id/cable-run-links`, `links` on the GET); `public/js/cable-run-geometry.js`; `topology-cable-runs.js` (`links`, `hitRun`, `highlight`, `setLinkRuns`, the panel's "Links on this run"); `topology-physical.js` (`routedRuns`, `previewRoute`, `attachRun`, `drawRunHandles`, `refreshRoutedLinks`); `map.js` (`stageCableRunLinks`, the commit). Tests: `cableRunGeometry`, `topologyCableRuns` (`diffLinks`), `tests/integration/cableRuns.test.ts`.
