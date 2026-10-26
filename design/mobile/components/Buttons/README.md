# Buttons

Pill-shaped Material buttons in six variants, plus bare icon buttons.

Write `.btn` plus exactly one variant: `.btn-filled` for the screen's primary action,
`.btn-tonal` for a secondary action that still needs weight, `.btn-outlined` for a
neutral alternative such as Cancel, `.btn-text` for a low-emphasis action, `.btn-error`
for a destructive one and `.btn-success` for an approval. Add `.btn-block` for full
width. The consumer provides the label and, optionally, a leading inline SVG (18px, it
takes the label's colour). `[disabled]` dims the button.

`.icon-btn` is a 48px round target for a bare 24px glyph; give it an `aria-label`.

- `.btn-success` is a literal `#2e7d32` with white text — the one button that doesn't
  follow the theme.
- `.btn` here is a pill (`shape-full`, 40px tall). It is not the desktop `.btn`.
