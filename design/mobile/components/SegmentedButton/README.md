# SegmentedButton

A row of mutually exclusive options, one of them on.

Write `.seg` holding `.seg-item` buttons, and put `.on` on the chosen one. The consumer
provides two to four short labels.

- The stylesheet styles only the items — their padding, the `md-outline` rule between
  them and the `md-secondary-container` fill of `.on`. It defines no frame or layout for
  the `.seg` container itself; this preview adds only `display:inline-flex` so the items
  sit in a row. Match whatever wrapper the app gives it before copying.
