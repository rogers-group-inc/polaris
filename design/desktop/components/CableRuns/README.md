# Cable runs

Physical cable runs drawn on a Device Map site's Topology view (business rule 184), the links
routed through them (184(a)), and the ArcGIS integration's Write-back tab (185).

## The rules

- **Colour is placement, dash is medium.** Trench = accent, electric pole = `--color-sev-serious`,
  telephone pole = `--color-success`; fiber is solid, ethernet dashed. A pole run marks each pole
  with a small ring. The legend sits bottom left whenever a run is shown.
- **Trenches are imported, never drawn**: the Trench button is disabled for a hand-drawn run, and
  a surveyed run's points carry no handles.
- **The run panel** opens top right on a click: name, Medium and Placement as segmented
  `btn-sm` rows (the picked one `btn-primary`), Length (and Poles), Notes, the links that ride the
  run (kept in Polaris — the hint says so), the ArcGIS sync pill and Delete run. Without
  Cable Runs write the controls are read-only.
- **Sync pill** reuses the badge family: Pending `badge-expired`, Synced `badge-active` (with the
  OBJECTID), Failed `badge-conflict` with ArcGIS's message in danger text under it.
- **Routing a link**: in edit mode, drag a link's handle near a run (12 px). The run lights up
  (thicker stroke) and a dashed accent preview shows the route; drop to attach. A routed link
  shows one round handle per run it rides; drag it off (or Delete) to detach.
- **Write-back tab**: the enable checkbox and its one-way hint, the Layer radios (existing +
  field map / Polaris-created), the layer URL with Read layer (geometry, Z and capability pills
  — a missing capability is `badge-conflict`), the field map table (Polaris id required), a value
  map when Medium or Placement lands on a coded-value field, and the status strip (synced /
  pending / failed counts, the last error, Retry failed at Cable Runs full write).

## Source

`public/js/topology-cable-runs.js` (layer, legend, panel), `public/js/topology-physical.js`
(link snap + handles), `public/js/cable-run-geometry.js`, `public/css/map.css` (`.topo-run-*`),
`public/js/integrations-forms.js → arcgisWriteBackHTML()`, `public/js/integrations.js →
_wireArcgisWriteBack()`. The page's `demo-*` helpers stand in for the `map.css` classes, which
the design bundle does not carry.
