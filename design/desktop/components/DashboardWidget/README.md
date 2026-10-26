# DashboardWidget

A dashboard widget is one `article.dashboard-widget`: a one-line header with severity count pills at the head of its title, then a scrolling body in one of two shapes, a ranking or a grouped list.

## Anatomy

- **Header** — `.dashboard-widget-header > .dashboard-widget-title` plus `.dashboard-widget-action` buttons. The title never wraps; the full text rides its `title` attribute. Count pills (`.widget-pill` + a severity variant) sit at the HEAD of the title, one per active-alert severity among the rows on screen, so a narrow column cuts the name before the numbers. View mode shows the export button; edit mode shows sort, height, gear and remove, all in the same 28px box.
- **Ranking body** — `.recent-item` rows on a `1fr 90px 48px` grid: the name (muted detail such as a port or mount path beside it), a `.util-bar-track > .util-bar-fill` bar, the value. The bar runs accent → `color-warning` → `color-danger` on the widget's thresholds. A row whose device carries an active alert takes that alert's severity colour instead, so the bar never disagrees with its pill. A figure where less is worse (SLA compliance) is ranked on its inverse and relabelled, so a longer bar always means worse.
- **List body** — `.dash-alert-item > .dash-alert-row > .dash-alert-body > .dash-alert-title + .dash-alert-sub`, with `.dash-alert-time` on the right holding the age ("47m") or, where there is no age, the row's state as a pill. Group with `.dash-alert-group-header` (the gate or site name plus a count pill coloured to the group's worst row). `.dash-alert-body` and `.dash-alert-group-header` are markup hooks with no rule of their own, in the application too; the group header is styled inline exactly as the preview shows.
- **Empty state** — `.empty-state` text that says what empty MEANS ("No packet loss", "Every SD-WAN site has a backup path"), never "No data". Emptied by the severity filter, it says so.

## Behaviour the design must leave room for

- Row click opens the device's slide-over in place, on the tab the row is about.
- An acknowledged row stays listed, dims its own parts to 0.6 and gains an "ack <owner>" `widget-pill-neutral` pill at full strength.
- Settings live in a gear popover: the widget's own controls, then Minimum severity, then the Regions / FortiGates / Asset types filter fields. A change applies at once; there is no Save.
- Size: 3, 4, 6 or 12 of 12 columns; 1×, 2× or 3× tall (280 / 576 / 872px).
