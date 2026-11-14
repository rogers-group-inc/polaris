# Business rule 185 — full narrative

> Written 2026-11-13 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 185](#rule-185) — Cable runs are written one way to one ArcGIS layer, and found again by their Polaris ID

## Rule 185 — Cable runs are written one way to one ArcGIS layer, and found again by their Polaris ID

**The request (2026-11-13).** The trenched and pole runs drawn on the Device Map (rule 184) "will then be written back to our corporate arcgis account". Asked how: one way, Polaris → ArcGIS; the target is configurable either as an existing layer with a field map or as a layer Polaris creates; only the runs are written, never which links ride them; elevation from a survey "will remain preserved to be sent back to arcgis". The integration is written for any organisation, not the operator's.

**Decisions.**

- **The queue is the run table.** Rule 184 already gave every run `syncStatus` / `syncError` / `syncedAt` / `arcgisObjectId` / `version` / `deletedAt`. With write-back on, each push first turns every live `off` run `pending`, so runs drawn before write-back and runs drawn since need no special path; an edit of a sent run is `pending` again (cableRunService), a delete of a sent or queued run is a tombstone. There is no second queue to drift from the first.
- **Idempotent by the Polaris ID.** The field map must name a layer field for the run's id (`fieldMap.polarisId`, refused at save without it). Before adding a run that has no object id, the push queries the layer for that id: a run whose add succeeded but whose answer was lost (a crash, a timeout) is updated, never added twice; the same holds after write-back is stopped and started on the same layer. A tombstone with no object id is looked up the same way and simply dropped when nothing is there.
- **Per-feature truth.** `applyEdits` with `rollbackOnFailure=false`, ≤ 100 operations a call. A per-feature error (a value too long, a code outside a domain) marks THAT run `failed` with ArcGIS's own description, which the run panel and the Write-back tab show; the rest of the batch lands. A transport error, a 5xx, a 429 or an expired token (498 / 499) leaves the batch `pending` with the message in `syncError`, for the next tick. A layer that refuses outright (not polylines, no Create / Update / Delete, a mapped field it lacks) fails every queued run with the reason until it is fixed and **Retry failed** is pressed.
- **A run edited mid-push stays pending.** The success write is `updateMany where version = <sent version>`: a run edited while its push was in flight keeps `pending` and goes again; its object id is recorded either way.
- **One writer.** Only one ArcGIS integration may have write-back on (409, like the basemap's rule 183). Pushes run from the 60-second `arcgisWriteBack` job (scheduler role) and straight after an edit session saves runs (`kickWriteBack` from the web role) — both under one session advisory lock on a side connection, so two processes never send the same run.
- **Stopping starts over.** Write-back turned off, pointed at another layer, or its integration deleted: every run returns to `off` with its object id forgotten, and tombstones are dropped — their features stay in the old layer, and one `cable_run.write_back_stopped` Event lists the orphaned object ids. A disabled integration only pauses: nothing is reset.
- **Geometry is WGS84 with z when the layer has z.** Paths go out with `spatialReference: 4326`; a z-enabled layer gets `[x, y, z]` (0 where a drawn point has none), any other layer 2D. Read layer warns when the layer has no z (survey elevation would be dropped) or another spatial reference (ArcGIS projects it).
- **A Polaris-created layer.** **Create layer** (Full Read-Write on Integrations — it creates content in the external organisation) calls `createService` in the signed-in user's content and `addToDefinition` on its admin endpoint: one z-enabled polyline layer with `POLARIS_ID`, `NAME`, `MEDIUM`, `PLACEMENT`, `SITE`, `NOTES`, `LENGTH_M`, `UPDATED_AT`, stored as the integration's layer and field map. It does not turn write-back on.
- **The URL is a destination.** `featureLayerUrl` joined rule 111's `DESTINATION_KEYS`: moving the layer needs the secret typed again, exactly as moving the portal does.

**Rejected.**

- *Reading ArcGIS edits back* — the operator chose one way; ArcGIS edits are overwritten on the next change in Polaris, and the tab says so.
- *Writing which links ride a run* — runs only (rule 184(a) keeps riders in Polaris).
- *A separate outbox table* — two sources of truth for "what still needs sending".
- *Adding without the lookup* — a lost answer would duplicate a feature in someone else's system.

**Not verified against a live portal yet.** The request shapes follow Esri's REST documentation (`applyEdits`, `query`, `createService`, `addToDefinition`) and are pinned against a fake layer in `tests/integration/arcgisWriteBack.test.ts`; they were not exercised against ArcGIS Online or Enterprise when this rule was written. Before pointing write-back at a production organisation, test it against a scratch layer, and have a person review the field mapping.

**Where.** `src/services/arcgisWriteBackService.ts` (`featureLayerUrlProblem`, `writeBackConfigProblem`, `readLayer`, `layerProblems`, `createPolarisLayer`, `featureFor`, `writeBackIntegration`, `writeBackStopped`, `writeBackStatus`, `retryFailed`, `syncWriteBack`, `kickWriteBack`); `src/jobs/arcgisWriteBack.ts`; `src/api/routes/integrations.ts` (`ArcgisConfigSchema`'s write-back keys, `assertSingleArcgisWriteBack`, the PUT / delete hooks, `GET /:id/arcgis/write-back`, `POST /arcgis/read-layer`, `POST /:id/arcgis/create-layer`, `POST /:id/arcgis/retry-failed`); `src/api/routes/map.ts` (the kick after `PUT /cable-runs`); `src/services/cableRunService.ts` (tombstone when queued); `src/services/integrationAdapters.ts` (Test Connection reads the layer); `src/utils/secretDestination.ts`; `public/js/integrations-forms.js` (`arcgisWriteBackHTML`, `getArcgisWriteBackConfig`), `integrations.js` (`_wireArcgisWriteBack`). Tests: `tests/unit/arcgisWriteBack.test.ts`, `tests/integration/arcgisWriteBack.test.ts`.
