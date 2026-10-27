# StoragePage

The asset sheet's Storage pages: what a device stores on, opened by the
`.asset-storage-entry` button between the Interfaces and Discovery sources sections. They
are pages of the [AssetSheet](../AssetSheet/README.md), so the sheet's two-row header
carries the page title ("Storage") over the asset's name, and back returns to the asset.

- **Volumes** — every device. A `.section-head.storage-head` then one `.storage-vol`
  button per mount: `.storage-vol-top` (the `.mono.storage-vol-name`, a `Poll 1m`
  `.poe-label.poe-idle` when the volume is polled every minute, and the `.storage-pct`),
  a `.storage-bar` with its `.storage-bar-fill`, and a `.storage-line` (used of total,
  free). The bar and figure take `.warn` at 75 % and `.crit` at 90 %, the desktop's
  thresholds. A volume opens a page with its figures as `.kv-row`s and a usage chart.
- **Arrays** — an Unraid, TrueNAS or Proxmox host. One `.card-filled.pool-card` per pool:
  a `.pool-head` button (`.mono.pool-name`, the health `.poe-label`, `.pool-meta`, a
  chevron; `aria-expanded`), the usage bar, `.storage-line`s for the scrub or parity check
  and (`.warn`) the platform's explanation of a bad state. Open, each group is a
  `.pool-group-head` (role · layout, the group's name) over its `.pool-drive` buttons
  (`.pool-drive-main` with `.pool-drive-name` and `.pool-drive-sub`, the health pill, a
  chevron); `.bad` turns an unhealthy drive's line red. An unhealthy array starts open, a
  healthy one closed. A drive opens a page of `.kv-row`s, an error count in `.v.bad`.
- `.storage-note` closes the page: what the figures are as of, and, on a device with no
  arrays, that only those three platforms report physical drives.
- `.asset-storage-sub` under the entry button summarises the page ("2 arrays · 8 drives ·
  1 degraded"); `.bad` when something is degraded.
