# ArcGIS layers

Feature layers read from ArcGIS and drawn on a Device Map site's Topology views (business rule
188), connections routed through ArcGIS lines (188(a)), and the ArcGIS integration's Layers tab.
Polaris never writes to ArcGIS. Approved canvas: https://claude.ai/artifact/VUonHygAhBAcWXgAfxD3Tu

## The rules

- **Each layer has its own style**, set on the integration: one of six colour names mapped to
  theme tokens (`.topo-arc-c-*` in map.css — accent, `--color-sev-serious`, `--color-success`,
  `--color-warning`, `--color-sev-notice`, `--color-danger`), a width and solid / dashed / dotted.
  Points are dots, areas a faint fill with an outline. The legend (bottom left) and the Map
  layers card name every shown layer, so colour is never the only cue.
- **Map layers** heads the details pane on a Topology view: a checkbox and a style sample per
  configured layer. A new view ticks none. While editing, a tick is staged and saved with the
  view; otherwise it lasts until the map closes. A **Route line missing** pill
  (`badge-expired`) counts connections riding a line that is hidden, filtered out or gone.
- **The click card** is a Leaflet popup over the floating glass: the label, "from ArcGIS, read
  only", the layer's chosen fields, a line's length, the connections riding it, and **Open in
  ArcGIS** when the layer came from a portal item.
- **Routing**: in edit mode, drag a link near a shown line (12 px); the line thickens and a
  dashed accent preview shows the route; drop to attach. A routed link shows a round handle per
  line it rides; drag it off (or Delete) to detach.
- **Layers tab**: search scopes as `btn-sm` (picked = `btn-primary`), a results table whose items
  expand to their layers (Add / Added), the list Polaris reads (row selected = the layer being
  edited, × removes) and the editor below it — colour swatches, width, line, label field,
  identity field (GlobalID preferred), popup-field chips with an Add field picker, and the
  optional where clause.

## Source

`public/js/topology-arcgis-layers.js` (features, legend, card, Map layers card),
`public/js/topology-physical.js` (link snap + handles), `public/js/cable-run-geometry.js`,
`public/css/map.css` (`.topo-arc-*`, `.topology-arc-layers`),
`public/js/integrations-forms.js → arcgisLayersHTML()`, `public/js/integrations.js →
_wireArcgisLayers()`. The page's `demo-*` helpers stand in for the `map.css` classes, which the
design bundle does not carry.
