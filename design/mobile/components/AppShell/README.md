# AppShell

The phone app's frame: a top app bar, a scrolling body and a five-item navigation bar.

Markup is `.app > .m3-topbar + .app-body + .m3-navbar`. The consumer provides the top bar's
`.title` and optional `.leading` / `.trailing` icon buttons, the body content, and exactly
five `.nav-item`s — each an `.nav-icon-pill` glyph and a one-word `.nav-label`, with
`.active` on the current tab and an optional `.nav-badge` count.

- Scrolling happens in `.app-body` only; `html` and `body` are locked to the viewport.
- `data-tab` on `.app` is required: an empty value hides the navigation bar, and
  `__fullbleed` hides both bars and the body padding for a full-screen view (the map).
- The bar heights are `topbar-h` and `navbar-h`; don't set heights by hand.
- The shell is portrait only — the sheet hides it in a short landscape viewport.
