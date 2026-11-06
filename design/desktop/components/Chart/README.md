# Chart

A time-series chart is hand-drawn inline SVG in a `.chart-box`, under a section heading carrying the polling-source badge, a freshness stamp and `.btn-sm` range buttons, with a stats line between heading and plot.

## Anatomy

- **Heading** — the section title, a `.badge-readonly` naming method, cadence and tier ("ICMP · every 1m · Class"), "updated … ago", and the range buttons 1h / 12h / 24h / 7d / 30d / Custom… pushed right; the active one is `.btn-primary`.
- **Stats line** — "**720** samples", then **Label:** value pairs. Current readings belong in the section's status block, not here.
- **Plot** — grid lines and axis labels outside the clipped data group; the x axis spans the whole requested window so empty time stays visible; ticks on local clock boundaries. A second scale (packet loss) gets a right-hand axis.
- **Stale banner** — the amber "⚠ Last successful update 34m ago" box, inside the section before the chart, once the last success is older than 3× the polling interval. Shown on the empty state too.

## Colour

The chart palette is fixed hex, not tokens, because the phone charts and the alert emails draw the same marks and a mail client has no theme:

| Mark | Value |
|---|---|
| missed poll; Down at critical | `#d32f2f` |
| dependency down (upstream explains it) | `#9aa0a6` |
| missed, not yet the verdict (response time only) | `#ffc107` |
| recovering (response time only) | `#0288d1` |
| maintenance band, labelled | `#9575cd` at low opacity |
| packet loss, dashed, right axis | `#ab47bc` |
| bucket max on hourly / daily ranges, dashed `2 3` | the series' own colour |

Up on the response-time chart is `color-success`; any other series uses a token (`color-accent`, or an HSL arc for many series that skips red and grey). **No data series may be red or grey.** A missed poll dives to the baseline and stays connected to its neighbours. Colour the SVG inline; the screenshot button rasterizes it without the stylesheet.

## Max line (hourly / daily ranges)

Past the detail tier a point is a bucket and the solid line is its average, so each chart whose rollup keeps a per-bucket max also draws that max as a fine dashed line (`stroke-dasharray="2 3"`, finer than the packet-loss dash) in the series' own colour, thinner and fainter, UNDER the average; a bucket with no max breaks it. A **Max (hourly peak)** / **Max (daily peak)** chip — a dashed swatch, struck through when off — toggles it and is remembered per user per chart; it sits in the chart's own key or legend (the response-time key, the CPU core legend, the SD-WAN member legend), or in a chip-only row above the plot. While shown, the y axis includes the peaks. The tooltip names avg and max either way. Drawn on response time, CPU (average and each drawn core), the combined CPU & Memory chart's CPU, interface throughput, hardware sensors and SD-WAN latency / jitter. Detail ranges have neither line nor chip.

## The response-time key

The key naming the colours the response-time chart drew (Up, Missed poll, Down, Recovering, Parent down, Packet loss, Maintenance, Polling change) sits ABOVE the plot, between the stats line and the chart box, where every other chart's legend sits, and carries the Max chip on a rollup range.

## Many series

Per-core CPU and SD-WAN members draw one line per dimension. Their legend is HTML toggle chips above the plot, never `<text>` inside the SVG; a hidden series' chip stays readable, and "Show all" appears once anything is hidden.
