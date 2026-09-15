# Dashboard

The landing page. It is a **widget canvas** — you choose which widgets are on
it, where they sit and how wide they are, and the layout is yours.

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
