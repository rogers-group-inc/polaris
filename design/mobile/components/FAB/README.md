# FAB

The floating action button: the single most common action on a screen, floating above
the content.

`.fab` is a 56px square-ish button (`shape-lg`) holding one 24px glyph — give it an
`aria-label`. `.fab-ext` is the extended form with a glyph and a short label. Both sit on
`md-primary-container` with `elev-3`. The consumer provides the glyph, the label, and the
positioning — on the map it sits in `.map-fab-pos`, 16px from the bottom-right.

- One FAB per screen at most.
- Use the extended form when the glyph alone would be ambiguous.
