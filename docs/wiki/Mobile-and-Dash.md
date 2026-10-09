# Mobile app and Dash wallboard

Two surfaces that are not the desktop app: an installable phone app, and an
unauthenticated NOC wallboard.

---

# The mobile app

![The Polaris mobile web app's Alerts tab: severity count tiles, filter and sort controls, and an alert list with Ack and Clear buttons, above the bottom tab bar.](https://raw.githubusercontent.com/rogers-group-inc/polaris/main/docs/img/screenshots/mobile-noon-mobile.png)

An installable **PWA** with push notifications. Phones hitting `/` are
redirected to it; `?desktop=1` escapes. The **Open device** link in an alert
email or push (and the `{asset.link}` token) lands here too when opened on a
phone — the link is one address for everyone, and Polaris picks the phone app
or the desktop page when it is opened. Add `?desktop=1` to that link to force
the desktop page.

The tab bar is **Search · Alerts · Assets · Networks · More** — or, when your
role includes the [AI Assistant](AI-Assistant) and an AI Assistant integration
is enabled, **Search · Alerts · Assets · Chat · More**, with **Networks** moved
to the top of More. **Chat** is the same assistant as the desktop's chat
button: the same saved conversations, lookups made with your own permissions,
reports to download as CSV or Markdown, **History** and **New** in its top bar,
and the same fresh chat after the integration's idle time (`/resume` goes back).
Opening Chat continues the conversation you were just having on the desktop,
if you used it within that idle time (30 minutes unless the integration says otherwise).
The text box grows to three lines as you
type, then scrolls inside. While the keyboard is open the navigation bar steps
aside and the conversation scrolls in the space above the text box, so you can
scroll up to read earlier answers while you write; if you were at the newest
answer, it stays in view as the box grows.
The More tab holds the rest, top to bottom: the **Device Map** (sites and topology) and
**Blocks**; **Events** (the audit log, last 7 days); the **Notification
preference**; **Add to Home Screen** when the app is not installed yet; the
**theme strip** (tap to move through the day, as the desktop's theme band
does); your **Account**; **Desktop view**; and **Sign out**. Its **Account** row shows your name, your
role and, under them, the regions and tags your account is scoped to — the ones
from your role, your user and your sign-in groups together, regions first. An
account with no tag scope shows no tags there.

## Alerts

Every active alert you can see, newest first. Across the top, a **severity
breakdown** counts them (**Critical**, **Serious**, **Warning**, **Info**,
**Notice**; a severity with nothing in it is left out). Tap a count to show only
that severity, and tap more than one to combine them. The counts follow the
other filters but not the severity one, so they don't move while you tap
through them. **It opens on Critical, Serious and Warning**, so Info and Notice
alerts are counted but not listed until you tap their tile, or pick **Any** under
*Sort & filter*. A selected severity with no alerts still shows, at 0, so you
can unselect it. The same **filter field** and
**sort chip** as the lists below: the field matches device and message, the
chips above the list show **All**, **Unacknowledged** or **Acknowledged**, and
the *Sort & filter* sheet orders by **Time**, **Severity** or **Device** and
narrows to one or more **severities** (Critical also catches alerts recorded as
"error"). If your account carries [region tags](Users-Roles-and-Permissions#tags-and-region-scope),
the sheet also offers **My regions** (the default) or **All regions**. My
regions shows alerts on devices in your regions plus system alerts that aren't
about any one device; alerts on devices with no region tag only appear under
All regions. If
your role limits you to your regions, All regions adds only those untagged
devices; for an administrator it is the whole fleet. Whatever the sheet is narrowing by is
named on the sort chip, so the list is never filtered by something you can't
see. Your choices are remembered on that phone.

Tap a row to open its device; tap **Ack** to acknowledge (`alerts:write`) or
**Clear** to clear it (`alerts:fullwrite`). Clear asks first: it stops
escalation and runs the automation's reset actions. The tab loads the newest
500 active alerts; when more are active, the count under the list says so.

## Assets and Networks

Both lists carry a **filter field** and a **sort chip** above their chips. The
chip opens a *Sort & filter* sheet; a choice applies as soon as you tap it, and
tapping the selected column again flips its direction. Your sort (and on Assets,
the status filter) is remembered on that phone; the filter text is not.

On Assets you can pick **several statuses at once** — Down and Missed together,
say — and the list shows assets in any of them. The statuses you pick move to the
front of the row, right after **Any**, in the order you picked them. Tap one
again to drop it, or tap **Any** to clear them all.

| | Filter | Sort by | Extra filter |
|---|---|---|---|
| **Assets** | hostname, DNS name, IP, MAC, asset tag, assigned-to | Recently added, Name, IP address, Status, Type, Last seen | monitor **Status** (Down, Missed, Dep. Down, …), one or several — named on the sort chip while it applies |
| **Networks** | name, network, purpose, VLAN, FortiGate, block, tags — every word must match | Name, Network (address order), Utilization, Reservations, VLAN | the **All / Available / Reserved / Deprecated** chips |

**Tapping a network opens its addresses in a sheet over the list**, so your
filter and scroll position are still there when you close it. A reserved address
expands to its details and verbs — **Reserve** (a DHCP lease), **Edit**,
**Release / Revoke**, **Open asset**; a free one opens the Reserve form. A
FortiGate **VIP** or **interface address** belongs to the device's own config
and offers no Edit or Release. The **+ Reserve** button on the Networks tab
takes any address and finds its network for you.

**Tapping an asset opens its detail sheet.** The refresh button in its header
(or pulling the sheet down) re-reads what Polaris has for the device and
repaints the sheet, keeping the sections you opened; it does not poll the device.
The sheet does not refresh on its own, so tap it to catch up with the latest
poll. **Response Time**, **CPU + Memory**, **Hardware Sensors** and
**Interfaces** each name the polling method that collects them beside the
title (**Not collected** when nothing does), and CPU + Memory has its own
**1h · 24h · 7d** range. On a switch with PoE ports, Interfaces opens with a
count of ports delivering, searching and faulted, naming the faulted ones, and
each port shows its PoE state. Tapping a monitored interface shows its usage and
error graphs (**1h · 24h · 7d**) along with its PoE state and class. Under the status pill, a device
with a table to read carries a button for it, below **View SD-WAN** on a
firewall that reports SD-WAN:

| Device | Button | What it shows |
|---|---|---|
| Firewall | **View ARP Table** | the neighbour cache by interface, with the same **Current / Last hour … Last 30 days** range as the desktop tab (ranges past retention are greyed) and a filter over IP, MAC, interface and hostname |
| Switch | **View MAC Table** | the forwarding database by port, each port marked access port or uplink / trunk; entries on trunk / LAG pseudo-ports are hidden until you tap **Show** |
| Monitored access point | **View Wireless** | each radio (band, channel, width), the SSIDs it broadcasts, and the clients on each. Clients that match no broadcast SSID are listed under their own heading, not dropped |

A client or neighbour Polaris matched to a known device links to it, and tapping
it opens that asset. The sheets are read-only; the reload button re-reads what
Polaris has stored, not the device itself.

**A switch, access point or FortiGate can be upgraded from its sheet.** When the
[Repository](Server-Settings#repository) holds newer firmware for the device,
its **OS** row under *General* carries **Upgrade to &lt;version&gt;**. Tapping it
opens a confirm sheet naming the device, its serial, what it runs now, the
image it will get and the login it will use. **Upgrade** starts it; the phone
says *Upgrade started*, and the row then follows the run — signing in,
uploading, erasing / writing / verifying with a percent on a switch,
rebooting, verifying, waiting for monitoring to answer — and ends on the
result. The same sheet has a **Schedule for later** box: tick it, pick a
date and time (your phone's time zone) and who gets the results email, and
**Schedule** books it instead of starting it. When the device cannot be
upgraded right now, the button still shows and the sheet opens with the box
ticked and locked. A pending booking shows in the row — when, to what
version, who hears about it — with **Change** and **Cancel**. The button
needs **Read-Write on Assets**; below that the row says the version is
available. The phone offers the model's **primary** image only: picking its
backup, and the run history and its log, are on the desktop's Firmware card,
and the Repository itself is desktop-only. See
[Assets → Firmware](Assets#firmware).

A reservation is seen and changed in its network.

## Installing it

Open Polaris on the phone and use the browser's **Add to Home Screen**. The app
identity — name and icons — is generated per install from your
[branding](Server-Settings#customization).

Long-press the installed icon (Android) for shortcuts straight to **Alerts**,
**Assets**, **Networks** and the **Device Map**.

The manifest and icon routes are deliberately **unauthenticated**: a
`<link rel="manifest">` is fetched with credentials omitted, so a gated manifest
would 401 for everyone.

> **On iOS, Web Push only works from a home-screen-installed app.** Apple grants
> it to installed PWAs only — but the browser reports push support in plain
> Safari from 16.4, so the app would otherwise prompt for something that always
> throws. Polaris says *"Add to Home Screen to receive push here"* and choosing a
> push-bearing preference routes you to the install instructions **and saves
> nothing**. A preference this phone cannot honour, chosen on this phone, is a
> promise Polaris would break.

## Notifications

The **More** tab's Notifications row is a **preference, not a switch**. It names
your account's current choice — Email / Push / both — and its supporting line is
about **this phone**: *"tap to allow push on this phone"*, *"blocked in your
browser settings"*.

That split matters: the preference can be perfectly saved and still reach
nothing here.

Push enrollment is reconciled **at boot**, not only when the More tab is opened
— the point of storing the preference on the account is that a device you never
touch again still honours a choice made somewhere else.

It **never prompts** on boot (a page load has no user activation), so it can only
enroll a phone that has already granted notification permission. A phone that has
never been asked is instead **asked once**, on the first sign-in while your
account prefers push: a sheet offering **Enable** or **Not now**. Dismissing it —
either button, or a tap outside — is final on that phone, and the More tab's
Notifications row is the way back.

On **iPhone and iPad outside the installed app** you are not asked at all, for
the reason above: add Polaris to your Home Screen first and the offer follows.

## Alerts reach the phone in four places

| Surface | |
|---|---|
| **The Assets tab** | a device with live alerts carries a strobing **Alerts** control beside its hostname, coloured by the worst one. **It goes steady once everything on it is acknowledged** |
| **The per-asset alerts sheet** | one card per active alert, with **Acknowledge** (`alerts:write`) per row plus one batched control, and **Clear** (`alerts:fullwrite`) |
| **The asset detail sheet** | the same flag on its hero, beside the monitor pill |
| **The Alerts tab** | the fleet-wide list, filterable and sortable, and where a push notification opens. Acknowledges in place |

Search results carry the same statement reduced to a **dot** — deliberately not
a tap target, since the row opens the device.

Acknowledge notes and clear confirmations use **sheets, never `window.prompt` or
`confirm`**, which are suppressed in some installed PWAs.

## Push notifications

A push carries **at most two** tray action buttons — the platform limit — sliced
from the end of this priority order:

1. **Acknowledge** — the only one that changes state. It **opens the page**
   rather than acting from the tray, because that is where the note is typed and
   the session is what records who did it.
2. **Open device** — deliberately *not* the body tap's destination, which is the
   alerts list.
3. **Ignore** — only on an alert that requires interaction. It closes the toast
   and **sends nothing**: a tray button carries no session, so it cannot mean
   "handled". The alert keeps repeating and escalating.

**iOS and Safari render no action buttons at all**, so the body tap is the path
there.

**An all-clear carries no Acknowledge action** — there is nothing to
acknowledge.

## Signing out

An explicit **Sign out** draws the login form once, even where a silent SSO
provider would otherwise sign you straight back in. The desktop counterpart is a
form-less signed-out page.

The app is **online-only**.

---

# Dash wallboard

An **unauthenticated, read-only** duplicate of the Dashboard at `/dash`, for NOC
wallboards and kiosks. Served by its own process.

**Off by default.** Enable it at
[Server Settings → Web Server → Dash Wallboard](Server-Settings#dash-wallboard),
with a source-IP scope: `rfc1918` (the default), `all`, or custom CIDRs.

> **Unauthorised source IPs are silently dropped** — socket destroyed, no HTTP
> response — rather than 403'd, so a scanner cannot confirm the surface exists.
> Behind nginx that manifests to the remote client as a 502.

## What it can show

The wallboard answers as the built-in **`readonly`** role. Widgets that role
cannot read **hide themselves**.

**Acknowledgement notes are never shown on the wallboard.** They are typed by
operators about live incidents, and the wallboard has no login, so its **ack**
pills name the owner but hovering them shows no note.

Its **Dashboards ▾** menu offers:

- **"My layout — this browser"**, kept in that browser's storage;
- every **public** [saved dashboard](Dashboard#saved-dashboards).

A session-less caller gets **public rows only**, and **every write verb 405s
app-wide** — so a wallboard viewer can build a local layout or show a published
one, and can never save either to the server.

The choice is pinned per browser and restored at boot. A 5-minute poll re-reads
it and re-renders only when it has actually changed. A dashboard deleted or
unpublished under a live wallboard falls back to the local layout with a notice.

## Publishing a dashboard for it

Build the layout on the normal Dashboard, save it, and set its visibility to
**public** — which needs `savedDashboards:write`.

That level is the escalated one on purpose: publishing reaches every operator
**and** an unauthenticated wallboard.
