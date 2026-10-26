# Status

Monitoring status as a labelled pill or a bare dot, in seven states.

Both `.status-pill` and `.dot` take one of `.up`, `.warn`, `.down`, `.unk`, `.dep-down`,
`.maint` or `.passive`. A pill holds the matching dot and the status word; a bare dot
goes where space is tight — a list item's trailing slot, an asset card, a sheet header.

- Always pair a bare dot with the status in text somewhere nearby; the dots differ by hue.
- **Light-theme contrast:** the dependency-down, maintenance and passive colours are
  literals tuned for the dark palette. In `morning` and `noon` their pills read at
  1.5:1, 1.9:1 and 2.2:1, and the degraded pill at 3.6:1. Carried from the source
  unchanged.
