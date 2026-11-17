# ArcGIS layers

Feature layers read from ArcGIS and drawn on a Device Map site's Topology views (business rule
188), connections routed through ArcGIS lines (188(a)), and the ArcGIS integration's Layers tab.
Polaris never writes to ArcGIS. Approved canvases: https://claude.ai/artifact/VUonHygAhBAcWXgAfxD3Tu,
and for line types and layers by area (188(b), 188(c)) https://claude.ai/artifact/NkYpLby5WVhFxcgAKC2B9f

## The rules

- **Each layer has its own style**, set on the integration: one of six colour names mapped to
  theme tokens (`.topo-arc-c-*` in map.css — accent, `--color-sev-serious`, `--color-success`,
  `--color-warning`, `--color-sev-notice`, `--color-danger`), a width and solid / dashed / dotted.
  Points are dots, areas a faint fill with an outline. The legend (bottom left) and the Map
  layers card name every shown layer, so colour is never the only cue.
- **By type (188(b))**: a layer can be drawn by a type field instead. Each type takes ANY colour
  (`#rrggbb`, ArcGIS's own, painted through the element's `--arc`) — the one exception to the
  token colours — plus a width and a line style. The legend puts the types under the layer's
  name; the card names a feature's type with its sample.
- **The eye menu's ArcGIS layers section** (since 2026-11-17; it was a Map layers card in
  the details pane): a checkbox per layer that COVERS the map (188(c), found from each
  layer's area), a by-type layer's types nested under it with their own checkbox and sample,
  and "Not here: …" naming the rest. Everything draws until unticked. The eye opens while
  editing too, holding only this section; there what is hidden is staged and saved with the
  view, otherwise it lasts until the map closes.
- **The Legend panel** ends with an ArcGIS layers section in the shared `.topology-legend-*`
  rows; the panel is capped at 440 px and its body scrolls.
- **Hover**: pointing at a feature opens one tooltip — the type's sample and name, the
  feature's label, the layer.
- **The types table opens in a stacked dialog** (`buildOverlay` at 1300, wide) over the
  integration dialog — Read types or Edit types opens it, Done keeps, Cancel drops; the
  Layers tab shows only a summary, the drawn types and Edit types. A **Route line missing** pill
  (`badge-expired`) counts connections riding a line that is hidden, filtered out or gone.
- **The click card** is a Leaflet popup over the floating glass: the label, "from ArcGIS, read
  only", the layer's chosen fields, a line's length, the connections riding it, and **Open in
  ArcGIS** when the layer came from a portal item.
- **Routing**: in edit mode, drag a link near a shown line (12 px); the line thickens and a
  dashed accent preview shows the route; drop to attach. A routed link shows a round handle per
  line it rides; drag it off (or Delete) to detach.
- **Layers tab**: search scopes as `btn-sm` (picked = `btn-primary`), a results table whose items
  expand to their layers (Add / Added), the list Polaris reads (row selected = the layer being
  edited, × removes) and the editor below it — **Style** (One style | By type, the picked one
  in the accent fill), then either colour swatches, width and line, or the type field with
  **Read types** and the types table (a tick-box column with NO header word, type with sample,
  value, line count, colour picker, width, line, and an Other types row), then label field,
  identity field (GlobalID preferred), popup-field chips with an Add field picker, and the
  optional where clause.

## Source

`public/js/topology-arcgis-layers.js` (features, legend section, card, hover, eye-menu data),
`public/js/topology-physical.js` (link snap + handles), `public/js/cable-run-geometry.js`,
`public/css/map.css` (`.topo-arc-*`, `.topology-arc-layers`),
`public/js/integrations-forms.js → arcgisLayersHTML()`, `public/js/integrations.js →
_wireArcgisLayers()`. The page's `demo-*` helpers stand in for the `map.css` classes, which the
design bundle does not carry.
