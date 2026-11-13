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

## Error-rate bars and severity bands

An interface's **Errors** chart and a fibre-channel port's **FC errors** chart are stacked bars, one per interval, in the unit the matching automation compares: errors per second (in errors in `color-accent`, out errors `#9b5de5`), and FC counters per minute (CRC errors in `color-accent`, invalid transmission words `#2a9d8f`). An FC port's link failures, loss of sync and loss of signal are a row of small diamonds above the plot, one per interval in which any occurred. Amber is not a series colour here, because amber is what Warning looks like.

Every severity band of an automation that reads the port is a dashed line in the band's `color-sev-*` token with a right-aligned caption ("warning > 5 /min (CRC)"), and the series that automation reads turns the band's colour while it is inside it. The diamonds take the colour of the band their own counter's automation puts them in. The axis always reaches the lowest band, so a quiet port still shows how far it is from alerting. This is the convention the CPU, memory, sensor and path-latency charts already follow with a gradient line; bars apply it per interval.

## Custom widget levels and the widget's email chart

A custom widget can set a warning and a critical level (business rule 181). On the card each one is a mark in its severity colour, `color-sev-warning` and `color-sev-critical`: a tick across the gauge's arc, or a dashed line across the line widget. The arc, the value text and the line widget's "latest" take the colour of the level reached. The caption under the card names both levels ("Warning state at or above 16.0 A · Critical at or above 18.0 A"). Once a level is reached, the caption leads with it in that colour ("Critical state — at or above 18.0 A").

In an alert email a custom-widget alert leads with that widget. The widget's chart comes first, then the response-time chart:

- **Value or level alert.** The chart is a line in the widget's own name and unit, in the email orange `#ea580c`.
  - A value alert draws the threshold that fired in its severity colour. The legend calls it "Critical threshold".
  - A level alert draws both of the widget's levels. Warning is amber `#d97706` ("Warning level") and critical is red `#dc2626` ("Critical level").
- **State probe alert.** The chart is one status lane.
  - The OK label is green `#2e7d32` at 22 % opacity. The problem label is red `#dc2626` at 85 %.
  - The caption reads "On battery / bypass 12 min of the last hour · now On battery / bypass".
  - The time axis runs from -60 min to now. A legend names both labels.
  - A table probe's chart names its row.

If the widget reported nothing in the hour, no chart is drawn.

## Many series

Per-core CPU and SD-WAN members draw one line per dimension. Their legend is HTML toggle chips above the plot, never `<text>` inside the SVG; a hidden series' chip stays readable, and "Show all" appears once anything is hidden.
