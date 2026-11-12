# InterfaceErrors

The interface page's error charts on the phone (business rule 159a), the
[AssetSheet](../AssetSheet/README.md) page an interface row opens. They mirror the desktop's
**Errors** and **FC errors** charts in the phone palette, drawn by
`public/js/mobile/charts.js → barChart` inside the same `.chart-wrap` the line charts use.

- **Errors per second**: on every monitored port. Stacked bars, in errors in `--md-primary` and
  out errors in `--md-tertiary` (the throughput chart's two colours), in errors per second,
  the unit the in-error and out-error rate automations compare. Red is never a series colour,
  because it means a missed poll, and amber isn't either, because it means a Warning band.
- **Bands**: each band of an automation that reads this port is a dashed line in its
  `--md-sev-*` colour, with a caption at the right ("warning > 0.5 (in)"). The bars of the
  series it reads take the band's colour while they are inside it, and the axis always reaches
  the lowest band. The `.muted` line under the chart names the automations whose bands are
  drawn, since the captions are small at phone width.
- **FC errors per minute**: on a fibre-channel port. CRC errors and invalid transmission
  words are the bars. A diamond above the plot marks each interval with a link failure, loss of
  sync or loss of signal, in its own automation's band colour.
- **FC detail rows**: a **WWN** row and an **FC errors** row join the `.kv-row` list. The FC
  errors row lists the non-zero counters and turns `--md-warning` when a corruption counter is
  above zero.
- **Logged in**: on an FC port, `.card-filled` cards like the LLDP neighbours, one per device
  logged into the port. Each shows the matched asset (a link), the VSAN, the port WWN and how
  it was matched, with **View asset**. It takes the place of an empty Neighbor section.

Captions and diamonds are HTML laid over the plot, not SVG, because the plot stretches to the
phone's width and would squash text and shapes. They use the same overlay as the maintenance
labels.
