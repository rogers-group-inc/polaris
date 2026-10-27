# AssetSheet

The asset detail sheet: a bottom sheet that peeks above the navigation bar and expands to
the full record.

Markup is a `.scrim.asset-scrim` and a `.sheet.asset-sheet`. The sheet holds a handle, an
`.asset-sheet-header` in two rows — an `.asset-sheet-toolbar` (the page history's back and
forward `.icon-btn`s, an `.asset-sheet-toolbar-gap`, then refresh with id
`asset-sheet-refresh` and close) and an `.asset-sheet-title-row` (status `.dot` and the
`.asset-sheet-name-btn` holding `.asset-sheet-name`, the full width; on any other page an
`.asset-sheet-page` with `.asset-sheet-page-title` over `.asset-sheet-page-sub`) — an `.asset-hero` (`.hero-name` with its dot, `.hero-sub`), then
sections — each an `.asset-sect-header` button (`.sect-title`, `.sect-sub`) over a
`.sect-body`, hidden with the `hidden` attribute when collapsed. Detail rows are
`.kv-row`; charts sit in `.chart-wrap`.

- The sheet shows one PAGE at a time — the asset, or a page opened from it (SD-WAN, a
  table, an interface, the alerts list, Storage, a volume, a drive, another asset). Opening
  one goes forward; back and forward walk the list, a disabled one at `.38` opacity. See
  [StoragePage](../StoragePage/README.md) for the Storage pages and the `.asset-storage-entry`
  button that opens them, between the Interfaces and Discovery sources sections.
- Add `.peek` to collapse it to its header; the app's script sets `--asset-peek-y` to say
  how far. The refresh button hides while peeking.
- Unlike an ordinary sheet it stops at `navbar-h` and tucks *under* the navigation bar
  (901 against 950), so the tabs stay usable.
- Charts are drawn by the app's script; this preview shows `.chart-empty`, the
  no-data state.
