# Dashboard

The landing page. It is a **widget canvas** — you choose which widgets are on
it, where they sit and how wide they are, and the layout is yours.

![The Polaris dashboard: status tiles counting monitored assets by state, an active-alert feed, a down-asset list grouped by site, and ranked CPU, memory and response-time widgets.](https://raw.githubusercontent.com/rogers-group-inc/polaris/main/docs/img/screenshots/desktop-noon-dashboard.png)

The Dashboard has **no permission key of its own**. It is gated per widget: a
widget whose data your role cannot read hides itself rather than erroring, so
two people on the same install legitimately see different dashboards.

---

## Working with the canvas

| Action | How |
|---|---|
| Add a widget | **+ Add widget** → the library, with a one-line blurb per widget |
| Move one | drag its header |
| Resize | drag the edge; widgets snap to the column grid |
| Configure one | the **gear** on the widget — most carry options (row count, filters, grouping) |
| Sort one | the **⇅** button on the widget's header, while you are customizing |
| Export one to CSV | the **⤓** button on the widget's header, while you are *not* customizing |
| Remove one | the widget's own menu |
| Change column count | the canvas control |

Your personal layout saves automatically to your account (`/me/dashboard`), so
it follows you to another browser.

## Saved dashboards

A layout can also be **named and saved** as a `SavedDashboard`, private or
public.

| Level | Grants |
|---|---|
| `savedDashboards:read` | list them, and keep your own private ones |
| `savedDashboards:write` | **publish** one — which reaches every operator *and* the unauthenticated Dash wallboard |
| `savedDashboards:fullwrite` | delete anyone's |

Publishing is the escalated level on purpose: a public dashboard is visible on a
NOC wallboard that has no session at all. See
[Mobile and Dash](Mobile-and-Dash#dash-wallboard).

---

## The widget library

### Fleet state

| Widget | Shows |
|---|---|
| **Status Summary** | at-a-glance counts of monitored assets by state, infra uptime %, active alerts |
| **Active Alerts** | alerts your automations have raised and nothing has cleared, most severe first — **with Acknowledge and Clear in place** |
| **Down Assets** | monitored assets currently down, newest outages first, grouped by site or division. Dependency-down assets are excluded unless the gear says otherwise |
| **Sites With Issues** | sites with assets down or in warning, worst first; expand for the nodes |
| **Asset Types** | breakdown of monitored assets by type; click a slice to drill into the matching asset list |

### Performance

| Widget | Shows |
|---|---|
| **Top CPU** | highest average CPU load, averaged over the last N polls (gear-configurable, default 10) |
| **Top Memory** | same for memory |
| **Slowest Response** | highest average response time over the last 10 probes |
| **Temperature** | hottest hardware sensors across monitored assets, per sensor |
| **Packet Loss** | highest recent probe loss. **Fully-down assets (100 %) are excluded** — that is what Down Assets is for |
| **Stale Polls** | monitored assets overdue for their next response-time probe |
| **Active Maintenance** | the maintenance schedules in effect right now — what each one holds, and when its window expires. The one widget about the devices the others deliberately leave out |
| **Recent Reboots** | devices that rebooted recently, detected from SNMP `sysUpTime` drops |
| **Down Interfaces** | pinned interfaces admin-up but operationally down, plus fully-down IPsec tunnels, grouped by the gate they are on |

### Storage

| Widget | Shows |
|---|---|
| **Disk Usage** | monitored filesystems with the highest used percentage, per volume |
| **Storage Forecast** | growing filesystems ranked by projected days until full, from a 30-day trend |

### Address space

| Widget | Shows |
|---|---|
| **Block Utilization** | IP block address-space utilization, busiest first |
| **Recent Reservations** | most recent reservations; filter by source type from the gear |
| **Stale Reservations** | DHCP reservations whose client has not held the IP recently — cleanup candidates |

### Operations

| Widget | Shows |
|---|---|
| **Discovery Activity** | in-flight integration discoveries with per-run progress and slow-run amber telemetry |
| **Conflict Queue** | pending discovery conflicts. **Role-scoped** — you only see the ones your role can resolve |
| **Capacity Health** | overall capacity severity pill + the top reasons driving it. Admin only |

### Maps

| Widget | Shows |
|---|---|
| **Device Map** | geographic map of FortiGates — monitor-health dots, clustering, click through to topology |
| **Site Map** | geographic map of monitored sites — status dots and live weather radar |

---

## Reading the widgets correctly

**"Monitored" means monitored.** Nearly every widget counts only assets with
`monitored = true`. A device you stopped polling drops out of these counts —
that is the same gate that stops automations firing about it
([rule 37](Business-Rules#rule-37)).

**Down Assets and Packet Loss do not overlap.** A fully-dark device reads 100 %
loss by arithmetic, so Packet Loss excludes it and Down Assets owns it. If you
see a device in both, something is inconsistent — check whether its loss window
is still counting an outage that has ended
([rule 29](Business-Rules#rule-29)).

**Dependency-down is not down.** A device behind a dark parent is suppressed:
its failures are rendered grey rather than red, and it is left out of Down
Assets by default ([rule 38](Business-Rules#rule-38)). The gear can include
them.

**Maintenance is its own state, never an outage.** A device inside a
maintenance window shows a purple Maintenance pill and is not counted as down.
That is why **Active Maintenance** exists: since every other widget leaves those
devices out, it is the only one that says what is down on purpose and when it
comes back. Its filter also works the other way round from the rest — a
schedule is listed when **any** of its devices is in scope, and is then shown
whole, so a window covering switches, APs and servers still appears on a board
filtered to switches (with the in-scope share noted beside the device count).
The times it prints are the **Polaris server's** wall clock, the same clock the
schedule itself is evaluated against; the countdown beside each one is computed
against your own, so the two agree wherever you are sitting.

**The sort order also decides what the row limit hides.** Every listing widget
shows its rows in an order you choose (the **⇅** button, while customizing) and
*then* cuts the list to its Row limit. So the order is not only cosmetic: on
"Severity, then newest" a low limit hides the least severe rows, and on "Down
longest first" it hides the most recent ones. Each widget's first option is the
order it has always used, and a widget you never touch keeps it.

Besides the default, the listing widgets offer **Most recent first**, **Down
longest / Longest outstanding first** (the problem nobody has dealt with, which
a severity-first list buries at the bottom), **Hostname A–Z** — worth choosing
for a wall display, because rows then keep their places instead of jumping on
every refresh — and, where the widget has one, its place: **Site**, **Division**
or **Gate**, A–Z then severity. Active Alerts adds **Unacknowledged first**, and
the ranked widgets (CPU, memory, response time, loss, disk, temperature,
storage forecast) offer highest-first and lowest-first on their own value.

A widget that groups its rows follows you: pick an order and the groups
re-order to match it, instead of staying on the biggest-group-first order they
use by default.

**Conflict Queue is role-scoped, not filtered for tidiness.** If it looks empty
and you expected rows, check whether your role can resolve that conflict kind
rather than assuming there are none.

**Capacity Health measures this install.** The reasons behind the pill are
computed against real table sizes and the real retention configuration, not
against defaults. `timescale_recommended` fires at **zero bytes** with no size
gate — TimescaleDB's absence is a broken install from the first byte, not a
problem that begins at a threshold ([rule 52](Business-Rules#rule-52)).

---

## Acting from the dashboard

The **Active Alerts** widget is not read-only. Each unacknowledged row carries:

- **Acknowledge** (`alerts:write`) — puts your name on the alert without
  leaving the dashboard. A note is collected in a proper modal, and is
  *required* when the automation demands one.
- **Clear** (`alerts:fullwrite`) — ends the alert. This stops escalation and
  runs the automation's reset actions, so it is confirmed first.

Both report the **server's** count back, so a no-op says "already cleared"
rather than showing a success toast over nothing.

The **Active Maintenance** widget is the other one you can act from. Clicking a
schedule offers:

- **Open schedule…** — opens the Maintenance modal with that schedule loaded,
  for review or editing. It is the same editor the Assets page opens.
- **Disable schedule** — confirmed first, because it takes effect immediately:
  the window's open sessions end, held devices leave maintenance and resume
  polling, and the schedule stops firing until it is re-enabled.

Both need `maintenanceManagement:fullwrite` — the level the Maintenance modal
itself needs. A role that can only *read* maintenance still sees the widget;
its rows simply do nothing. Neither verb is offered on the Dash wallboard,
which has no session to act with. See
[Maintenance Windows](Maintenance-Windows).

**A widget with more rows than fit scrolls itself** — a slow creep through the
list, then back to the top, the way a NOC wall display reads. It never moves
while you are working in it: pointing at the widget pauses it, and so does
opening a row's menu, which stays put until you pick something or dismiss it.
The list settles for a moment after the menu closes before it starts creeping
again.
