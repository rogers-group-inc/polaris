# SearchBar

The pill-shaped search field that sits under the top app bar.

Markup is `.m3-searchbar` holding a leading `.icon-btn`, an `input.input`, and optionally
a trailing clear button. The consumer provides the placeholder and the glyphs. The bar
carries its own margins (6px 16px 12px) and `elev-1`.

- While empty, show the search glyph and pair the bar with the `SearchHints` panel.
- Once the user types, swap the leading glyph for back and add a clear button.
