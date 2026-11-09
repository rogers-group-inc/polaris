# TelemetryCharts

The asset sheet's **CPU + Memory** section on an asset whose CPU and memory come from a
source that reports detail: the Polaris Agent or vCenter, or an Unraid, TrueNAS or
Proxmox VE host. One section, one `.seg` range control, two charts in one `.card-filled`;
every other source keeps the single combined CPU + memory % chart. Drawn by
`public/js/mobile/telemetry-charts.js` over the `.chart-wrap` renderers in
`public/js/mobile/charts.js`.

- **CPU** — a `.ty-title-s` head with the core count, then the chart: one thin
  translucent line per logical core, coloured from an orange-to-violet arc that never
  reaches red (a missed poll) or grey (dependency down), and the cross-core average on
  top in `--md-primary`, thicker — the line every threshold reads and the only one that
  dives on a missed poll.
- **Memory** — the installed total in the head, then a stack in bytes: processes,
  buffers, cache (or the source's own words — Services / ZFS Cache on TrueNAS, Used /
  ZFS ARC on Proxmox, the hypervisor's bands on vCenter) against a dashed line at the
  total, so the gap above the stack is the remainder. Swap rides as its own dashed line.
- **Legends** — `.series-legend-bar > .series-legend` under each chart: ONE row of
  `.chip`s that scrolls sideways with no scrollbar, each end fading out while there are
  chips past it (`--fade-l` / `--fade-r`, set by the script; the preview shows the
  right-hand fade). A 10px swatch before each label, `aria-pressed` for the state. A chip
  that is off keeps its label at 0.8 with a strikethrough (the chip is the only way back
  to its series) and fades its swatch. A tap toggles a series; a press and hold on a core
  shows only that core, the average staying. `.btn.btn-text` **Show all** appears once a
  core is off, beside the row rather than in it, so it is reachable however long the row
  runs. In the app the chips also
  carry the hook class `series-chip` and the bands `stack-band` / `stack-total` /
  `stack-swap`; those are script hooks with no rule of their own, so this page leaves
  them out.
- **Cache starts off** — reclaimable page cache drawn in the stack makes a healthy host
  look nearly full — and the note under the legend says the hidden band is counted in
  the gap. Memory choices are remembered on the phone; core choices are per asset and
  are not.
- `.ty-body-s.muted` lines close each chart: the figures (average, max, the busiest
  core; in use of installed, peak) and, when they apply, why a series is missing —
  per-core detail not kept at a long range, or a source that reports a total only.
- **Max line on the 30d range** (the second preview) — where the chart reads hourly or
  daily buckets, each drawn series also gets a dashed `2 3` companion through the bucket's
  MAXIMUM: the series' colour, thinner and fainter, under every average, broken where a
  bucket has no max. A `Max` `.chip` with a dashed swatch, beside `Avg` in the CPU legend
  (under the chart on Response Time, interface throughput and SD-WAN), toggles every max
  line; the axis spans the peaks only while they show. The choice is kept per asset for the
  session, not stored. Detail ranges show neither. The rollup-tier per-core note shows only
  when the buckets carry no per-core figures.
