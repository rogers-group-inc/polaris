# Topology

The network topology screen: a search bar over a full-screen graph, with detail sections
for a selected node.

`.topo-screen` is fixed full-screen. Its `.topo-bar` holds a back `.icon-btn` and a
`.topo-search-wrap` (`input.topo-search` with a `.topo-search-results` list of `li`s,
each a name and `.meta`, or `li.empty`). The `.topo-graph` fills the rest, and
`.topo-status` floats a one-line message at the bottom. Node detail uses `.topo-section`
(`.topo-section-title`, a `.topo-endpoints` list of `.topo-endpoint-row` buttons).

- On a phone the screen is used sideways: it draws the desktop's left-to-right map, and
  held upright it shows `.topo-rotate` (an icon, "Turn your phone sideways to view the
  topology." and a Back to map button) over everything. A tablet or an unfolded foldable
  is never asked to turn. `.topo-screen` pads all four safe-area insets itself; its
  `.topo-bar` must not add them again.
- The graph itself is drawn by the app's topology script; this preview shows its empty
  ground. The status wording is illustrative.
- The topology stylesheet carries fallback colours after every token (`#0f172a` and
  the like), so it still paints if the tokens fail to load.
