# Topology

The network topology screen: a search bar over a full-screen graph, with detail sections
for a selected node.

`.topo-screen` is fixed full-screen. Its `.topo-bar` holds a back `.icon-btn` and a
`.topo-search-wrap` (`input.topo-search` with a `.topo-search-results` list of `li`s,
each a name and `.meta`, or `li.empty`). Under it, on a site whose devices carry location
codes, `.topo-views` drills down as the desktop's view switcher does: one `.topo-view-row`
per level (Base and the areas or buildings, then `.topo-view-row-depth-1` for the selected
area's buildings or building's floors, `-depth-2` for floors under an area), each chip a
`.chip.topo-view-chip`, `.selected` along the chosen path. The `.topo-graph` fills the rest, and
`.topo-status` floats a one-line message at the bottom. Node detail uses `.topo-section`
(`.topo-section-title`, a `.topo-endpoints` list of `.topo-endpoint-row` buttons).

- It draws the desktop's left-to-right map and works held either way; nothing asks the
  operator to turn the phone. `.topo-screen` pads all four safe-area insets itself; its
  `.topo-bar` must not add them again.
- A row too long for the screen scrolls sideways with no scrollbar, and a chip its edge
  cuts fades as a whole, its opacity the share of it still showing (the preview's last
  chip). Never a gradient fade at the row's ends.
- The graph itself is drawn by the app's topology script; this preview shows its empty
  ground. The status wording is illustrative.
- The topology stylesheet carries fallback colours after every token (`#0f172a` and
  the like), so it still paints if the tokens fail to load.
