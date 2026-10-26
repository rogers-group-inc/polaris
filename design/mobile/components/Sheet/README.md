# Sheet

The modal bottom sheet: a panel that rises over a scrim for a short task.

Place a `.scrim` and a `.sheet` at the end of the app; both are fixed to the viewport.
The sheet holds a `.sheet-handle`, an optional `.sheet-title`, and the consumer's
content — often `.kv-row` pairs (`.k` label, `.v` value) and a full-width action. It
rounds its top corners with `shape-xl`, scrolls when taller than 90% of the viewport, and
slides up on open.

- Dismiss on a tap on the scrim.
- A sheet covers the navigation bar; the asset detail sheet is the exception — see
  `AssetSheet`.
