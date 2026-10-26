# AssetSheet

The asset detail sheet: a bottom sheet that peeks above the navigation bar and expands to
the full record.

Markup is a `.scrim.asset-scrim` and a `.sheet.asset-sheet`. The sheet holds a handle, an
`.asset-sheet-header` (status `.dot`, `.asset-sheet-name`, and a refresh button with id
`asset-sheet-refresh`), an `.asset-hero` (`.hero-name` with its dot, `.hero-sub`), then
sections — each an `.asset-sect-header` button (`.sect-title`, `.sect-sub`) over a
`.sect-body`, hidden with the `hidden` attribute when collapsed. Detail rows are
`.kv-row`; charts sit in `.chart-wrap`.

- Add `.peek` to collapse it to its header; the app's script sets `--asset-peek-y` to say
  how far. The refresh button hides while peeking.
- Unlike an ordinary sheet it stops at `navbar-h` and tucks *under* the navigation bar
  (901 against 950), so the tabs stay usable.
- Charts are drawn by the app's script; this preview shows `.chart-empty`, the
  no-data state.
