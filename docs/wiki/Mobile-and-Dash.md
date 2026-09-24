# Mobile app and Dash wallboard

Two surfaces that are not the desktop app: an installable phone app, and an
unauthenticated NOC wallboard.

---

# The mobile app

![The Polaris mobile web app: a scoped search screen with a bottom tab bar.](https://raw.githubusercontent.com/rogers-group-inc/polaris/main/docs/img/screenshots/mobile-noon-mobile.png)

An installable **PWA** with push notifications. Phones hitting `/` are
redirected to it; `?desktop=1` escapes. The **Open device** link in an alert
email or push (and the `{asset.link}` token) lands here too when opened on a
phone — the link is one address for everyone, and Polaris picks the phone app
or the desktop page when it is opened. Add `?desktop=1` to that link to force
the desktop page.

The tab bar is **Search · Device Map · Assets · Networks · More**.

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

**Tapping an asset opens its detail sheet.** Under the status pill, a device
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

Networks replaced the old **Reservations** tab: a reservation is now seen and
changed in its network. An old home-screen shortcut or bookmark to Reservations
opens Networks.

## Installing it

Open Polaris on the phone and use the browser's **Add to Home Screen**. The app
identity — name and icons — is generated per install from your
[branding](Server-Settings#customization).

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

Desktop pages deliberately carry **no** manifest link.

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
| **`#more/alerts`** | the fleet-wide list, and the push deep-link destination. Acknowledges in place |

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

The app is **online-only**: there is no offline cache, and a test enforces that.

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
