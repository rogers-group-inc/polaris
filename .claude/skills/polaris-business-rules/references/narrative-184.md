# Business rule 184 — full narrative

> Written 2026-11-13 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 184](#rule-184) — A cable run belongs to its site, rides its own key, and a trench is never drawn by hand

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
