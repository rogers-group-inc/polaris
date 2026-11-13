# Business rule 183 — full narrative

> Written 2026-11-13 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 183](#rule-183) — An ArcGIS integration's satellite imagery wins over the Customization setting, and only one supplies it

## Rule 183 — An ArcGIS integration's satellite imagery wins over the Customization setting, and only one supplies it

**The request (2026-11-13).** The satellite basemap of the Device Map's Topology views (2026-11-10) was configured on Server Settings → Customization as a free-form tile URL and key. The operator wanted an ArcGIS integration instead — the same sign-in that will write cable runs back to the corporate ArcGIS — to supply the imagery, and asked first to move the card into it. Asked what should happen to installs on Mapbox, MapTiler or an in-house server, they chose to **keep both homes**: the Customization card stays for any provider, and the ArcGIS integration's basemap takes precedence while it is on.

**Decisions.**

- **ArcGIS first, the setting otherwise.** `satelliteTileService.resolveSource` reads the enabled `arcgis` integration whose `basemapEnabled` is on (oldest first, cached 10 s and invalidated on every ArcGIS create / update / delete) and falls back to `Setting("satelliteConfig")` only when there is none. A read failure on either side means "not offered", never a broken map — the rule the setting already had.
- **One browser contract.** Both homes answer through `GET /map/satellite` (status — `source: "arcgis" | "custom"` is added, nothing removed) and `GET /map/satellite/:z/:x/:y`. A view saved with `background.layer = "satellite"` therefore works under either home and across a switch between them. The tile cache's generation is the source's identity compared in memory (never a digest — CodeQL #126), so switching homes or credentials never serves the old provider's tile.
- **One ArcGIS supplier.** Two integrations each offering imagery would leave "which one is on the map" to row order. Create and update answer 409 naming the integration that already supplies it (`arcgisBasemapOwner`).
- **World Imagery by sign-in.** With an API key the keyed Location Platform host (`ibasemaps-api.arcgis.com`) gets the key; any other sign-in uses the public `services.arcgisonline.com` host and sends no token there. A portal imagery service (`basemapSource: "service"`) must be an https cached MapServer / ImageServer outside the blocked ranges, needs an attribution (its terms are the operator's), and is sent the integration's token. ArcGIS tile order is z / y / x.
- **Flat keys, so rule 111 holds.** The basemap fields are top-level config keys (`basemapEnabled`, `basemapSource`, `imageryUrl`, `basemapAttribution`, `basemapMaxZoom`) rather than a nested block, because `restoreStoredSecrets` compares top-level destination keys: `imageryUrl` and `basemapSource` are in `DESTINATION_KEYS`, so pointing the token at a new imagery host needs the secret typed again.
- **Test proves the imagery too.** The integration's Test Connection signs in and, while the basemap is on, fetches one tile (`testArcgisBasemap`). A 404 still passes — a regional imagery cache has no tile at zoom 1 over most of the world. An Enterprise portal with Verify TLS off is fetched through `tlsFetch`, so its certificate is pinned rather than trusted blindly (rule 113(e)).
- **Say who is in charge.** The Customization card shows a note naming the overriding integration (`overriddenBy` on the settings view), and the map's tile-error toast points at whichever home is active.

**Rejected.**

- *Moving the card into the integration (the first ask)* — it would have stranded every non-Esri provider, which an open-source install cannot assume away.
- *A nested `basemap` block* — a moved `imageryUrl` would have slipped past rule 111's top-level comparison and taken the stored token with it.
- *Letting the newest or the first-tested integration win* — implicit; the 409 makes the choice the operator's.

**Where.** `src/services/satelliteTileService.ts` (`resolveSource`, `readArcgisBasemap`, `arcgisBasemapOwner`, `invalidateArcgisBasemap`, `testArcgisBasemap`); `src/services/arcgisService.ts` (`imageryUrlProblem`, `basemapService`, `basemapTileUrl`); `src/services/integrationAdapters.ts` (the arcgis test); `src/api/routes/integrations.ts` (`ArcgisConfigSchema` basemap keys, `assertSingleArcgisBasemap`); `src/utils/secretDestination.ts`; `public/js/integrations-forms.js` (`arcgisBasemapHTML`), `integrations.js` (the Basemap tab), `server-settings-customization.js`, `topology-physical.js`. Tests: `satelliteTileService` ("the ArcGIS home"), `arcgisService` ("imagery"), `tests/integration/arcgisIntegration.test.ts`.
