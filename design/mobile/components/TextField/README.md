# TextField

The Material outlined text field, with its label notched into the border.

Markup is `.tf-outlined > .field + .lbl + .support`. The consumer provides the input
(`.field`), a short label (`.lbl`) and optional supporting text (`.support`). Add
`.error` to the wrapper to turn the border and label `md-error`; put the reason in
`.support`.

- The label always floats on the border and is painted over `md-surface`, so use the
  field on `md-surface` — on another ground the label's backing shows.
- Focus thickens the border to 2px `md-primary`.
