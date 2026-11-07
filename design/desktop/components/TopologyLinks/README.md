# Topology links

How the Device Map topology draws a link between two devices, and what its hover tooltip and legend say about it. The page, the Device Map dashboard widget and the phone all draw links from one stylesheet (`public/js/topology-render.js`); the tooltip and legend are desktop-only.

## The rule

Every link starts as one neutral line. It changes only when it has something to say:

- **A cable takes the colour and weight of its speed.** The speed is the slower of the two ends' reported interface speeds; anything faster than 10 Gb (an aggregate, 25 / 40 / 100 Gb) reads as 10 Gb. No reading at either end leaves the link neutral.
- **A wireless mesh backhaul is dashed** and turns yellow, orange, then red as its signal weakens. No signal reading (a controller polled over SNMP only) leaves it neutral.

Warm hues belong to signal alone, so a slow cable never reads as a failing radio. How a link was found (controller data, interface naming, LLDP, an AP uplink) is not a colour; it is in the tooltip.

## Palette

Hex, not tokens: Cytoscape paints the canvas from the stylesheet and the export reads the computed colours. Each colour has a dark (nightfall) and a daylight (morning, noon) shade; the daylight set steps each hue to its 600/700 shade for ≥ 3:1 on the pale grounds.

| Class | Dark | Daylight | Weight | Pattern |
|---|---|---|---|---|
| 10 Gb or faster | `#a78bfa` | `#7c3aed` | 4 px | solid |
| 5 Gb | `#60a5fa` | `#2563eb` | 3.4 px | solid |
| 2.5 Gb | `#67e8f9` | `#0891b2` | 3 px | solid |
| 1 Gb | `#14b8a6` | `#0f766e` | 2.4 px | solid |
| 100 Mb | `#94a3b8` | `#64748b` | 1.8 px | solid |
| 10 Mb | `#94a3b8` | `#64748b` | 1.6 px | round dots |
| Speed not known / good signal / no signal reading | `#5b6478` | `#b4bcc8` | 2 px (mesh 2.4 px dashed) | solid / dashed |
| Signal fair, −66 to −72 dBm | `#eab308` | `#ca8a04` | 2.4 px | dashed |
| Signal weak, −73 to −80 dBm | `#f97316` | `#ea580c` | 2.4 px | dashed |
| Signal poor, below −80 dBm | `#ef4444` | `#dc2626` | 2.4 px | dashed |
| Ring halo (link on a physical loop) | `#f8fafc` | `#111827` | 2 px outline | — |

An MCLAG peer link is dashed in its speed's colour. The neutral is the faintest line in both families.

## Tooltip

The `#topology-edge-tooltip` floating tip. Each value is written out in words beside a short swatch in the link's own colour, so colour is never the only carrier.

- **Cable:** the two ends, the port pair (mono), how it was found, the speed ("10 Gbps · link speed"), then each end's port line (speed, status, errors), and under a port holding an SFP that reports diagnostics, its readings ("SFP Rx −3.21 dBm · Tx −2.08 dBm · 41.2 °C · 3.29 V · 8.98 mA"; Rx at or below −20 dBm in `color-danger`, plus a line naming the end receiving too little light). Below 1 Gb it adds "Slower than 1 Gb on an infrastructure link. Usually a cable or speed-negotiation fault." With no speed it says "Speed not known".
- **Mesh:** the two ends, "AP to AP — wireless mesh backhaul", the signal in dBm and words ("Poor signal" in the band's colour; "Good signal" in `color-success`), the channel, band and width, noise and SNR, the SSID (mono), and when it was last seen. With no reading: "Signal not reported" and why.

## Legend

The topology legend's link rows fall in three sections: **Wired link speed** (seven rows), **Wireless mesh signal** (four rows) and **Also** (MCLAG peer link, part of a ring). Hovering a row lights the links it stands for; "Good" also lights mesh links with no reading, since they are drawn alike.
