# Topology

The network topology screen: a search bar over a full-screen graph, with detail sections
for a selected node.

`.topo-screen` is fixed full-screen. Its `.topo-bar` holds a back `.icon-btn` and a
`.topo-search-wrap` (`input.topo-search` with a `.topo-search-results` list of `li`s,
each a name and `.meta`, or `li.empty`). Under it, on a site whose devices carry location
codes, `.topo-views` drills down as the desktop's view switcher does: one `.topo-view-row`
per level (Base and the areas or buildings, then `.topo-view-row-depth-1` for the selected
area's buildings or building's floors, `-depth-2` for floors under an area), each chip a
`.chip.topo-view-chip`, `.selected` along the chosen path. Above the chips, a site with more
than one saved view shows `.topo-viewbar` holding a native `select.topo-viewsel` (its
options grouped Layer 2 / Topology / Room). The `.topo-stage` fills the rest: the
`.topo-graph` (the graph, or a Topology / Room view's canvas) under `.topo-tools`, a column
of round `.topo-tool` buttons at the top right (Legend, the eye, a canvas's own view
buttons; `.is-active` while its panel is open), and the open legend at the bottom left
(`.topology-legend.topo-legend` with a `.topo-legend-close`). `.topo-status` floats a
one-line message at the bottom. Node detail uses `.topo-section`
(`.topo-section-title`, a `.topo-endpoints` list of `.topo-endpoint-row` buttons).

- It draws the desktop's left-to-right map and works held either way; nothing asks the
  operator to turn the phone. `.topo-screen` pads all four safe-area insets itself; its
  `.topo-bar` must not add them again.
- A row too long for the screen scrolls sideways with no scrollbar, and a chip its edge
  cuts fades as a whole, its opacity the share of it still showing (the preview's last
  chip). Never a gradient fade at the row's ends.
- The graph itself is drawn by the app's topology script; this preview shows its empty
  ground. The status wording is illustrative, and the legend shows two of its rows.
- A Topology or Room view is the desktop's own canvas, styled by the desktop's map
  stylesheet, which the screen switches on only while it shows. `mobile.css` maps the
  desktop token names that sheet reads onto the phone palette.
- The topology stylesheet carries fallback colours after every token (`#0f172a` and
  the like), so it still paints if the tokens fail to load.
