# Map

The site map: asset markers and clusters over a basemap, with a locate button.

`.map-screen` fills its tab and holds
`#map-container`, where the map library draws, plus `.map-fab-pos` for the FAB. Markers
are `.fg-marker` (one asset, 34px) and `.fg-cluster` (a count, 40px), each with a
`.monitor-*` state: `up`, `degraded`, `down`, `maintenance`, `unknown`, `unmonitored`.

- The basemap tiles and the marker positions come from the map library at runtime;
  this preview places the markers by hand over a plain ground.
- The walking user-location pin (`.user-pin`) is an illustration drawn in the app's
  JavaScript — its artwork did not come across, so it is not shown.
- Marker fills are literal status colours. White labels on the maintenance marker read
  at 3.7:1 and on the unknown cluster at 2.7:1. Carried from the source unchanged.
