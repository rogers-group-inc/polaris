# Saved folder tree

The folder tree inside the two named-preset menus — Assets → **Filters ▾** and Dashboard →
**Dashboards ▾** — and the two dialogs that hand an item between owners (business rule 140).
Built by `public/js/saved-tree.js` (`PolarisSavedTree`); the page owns its item rows, the
module owns folders, drag and drop, the folder ⋯ menu, **Change owner** and **Make private
to me**.

- Sections by ownership: *My …*, *Shared …*, *Ownerless* (full read-write holders only). The
  Dash wallboard shows one *Published dashboards* heading, read-only.
- Folders open and close in place and remember it per browser. Children indent 20px a level.
- Drag a row you manage onto a folder to file it, onto a section heading for the top level.
- The owner label is *Role · name*, *Region · name*, a username, or *was name* when
  ownerless — and nothing on what is simply yours.
- Change owner and Make private to me always show the `.sfo-warn` callout before the
  `.btn-warning` confirm.
