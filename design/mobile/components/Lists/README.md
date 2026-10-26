# Lists

Material list items, the workhorse of every phone screen.

Markup is `.list-item` with an optional `.leading` (a 40px round well holding a 24px
glyph), a `.content` of `.headline` and optional `.supporting`, and an optional
`.trailing` (meta text, a status `.dot` or a chevron). Add `.two-line` or `.three-line`
to set the height. Tint the leading well with `.tonal`, `.tertiary`, `.error`,
`.success` or `.warning`. `.avatar` takes the leading slot for a person.

Head a group with `.section-head` (its `.count` stays in sentence case; the head itself
is uppercased by the stylesheet). Separate items with `.list-divider`, which is inset to
line up with the text.

- Headline and supporting text truncate to one line each — a `.three-line` item still
  truncates, it only gains height.
