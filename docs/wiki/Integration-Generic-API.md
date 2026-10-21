# Generic API

Reads devices from **any REST API that returns JSON** and turns each record into
an asset. Use it for systems that have no integration of their own, such as a
facilities CMDB, a camera or printer management server, a vendor cloud portal,
or an internal inventory service.

You describe the request and then say which field in each record means what.
Polaris keeps no knowledge of the product on the other end. The **Preview** tab
shows what discovery would write before you save anything. The **JSON** tab
exports the whole configuration as a file and imports one, so a mapping written
for a product can be shared with anyone else who runs it.

Add it from **Integrations → + Add Integration → Generic API**. You can add as
many as you need, one per feed.

---

## What it does and does not do

| It does | It does not |
|---|---|
| Read a list of records, page by page | Write anything to the source |
| Create and update one asset per record | Monitor the assets for you — you choose which to monitor, as with a manually added asset |
| Merge a record into an asset another integration already found, on MAC or serial | Override a field a first-party source (Active Directory, vCenter, an agent…) reports |
| Optionally decommission an asset whose record leaves the feed | Treat a record as proof the device is on the network |
| Feed monitoring (up / down, CPU, interfaces, storage, temperatures, LLDP) and custom widgets from monitor queries | Decide which assets are monitored — a query only supplies the values |
| Read subnets, DHCP leases, DHCP reservations and external IP assignments into IPAM | Push anything to a device, or take over a network another integration discovered |

A record is an **inventory entry**, not evidence the device is online. Polaris
never sets **Last Seen** from the feed. After each discovery a presence check
asks the [Polaris Agent](Polaris-Agent), the monitor probe, or a ping, and sets
Last Seen only when the device answers. See [rule 100](Business-Rules#rule-100).

---

## General tab

### Request

| Field | |
|---|---|
| **Host / IP** | The API server's name or address only. The path goes in **Request path**. |
| **Port** | Blank uses 443 for HTTPS and 80 for HTTP. |
| **Method** | `GET`, or `POST` with a **Request body** in JSON for APIs that take their query in the body. |
| **Request path** | The path and query string, e.g. `/api/v2/devices?status=active`. It must start with a single `/` and cannot name another host. Paging parameters are added for you. |
| **Use HTTPS** / **Verify TLS certificate** | Both on by default. Turn verification off only for a self-signed certificate you cannot replace. |
| **Extra headers** | One per line, `Name: value`. Stored **as typed, not encrypted**, so put secrets in Authentication instead. |

### Authentication

| Type | What Polaris sends |
|---|---|
| None | nothing |
| Bearer token | `Authorization: Bearer <token>` |
| API key in a header | `<header name>: <key>` (default header `X-API-Key`) |
| API key in the query string | `?<parameter>=<key>` (default `api_key`). A key in the URL can end up in the source's access logs, so prefer a header when the API allows one. |
| Username and password | HTTP Basic |
| OAuth 2.0 client credentials | Fetches a token from the **Token URL** with the client ID, secret and optional scope at the start of each run, then sends it as a bearer |

The token, password and client secret are stored encrypted. On **Edit** they
show blank. Leave them blank to keep the stored value.

---

## Records & Mapping tab

### Paths

Every field is a **path into one record**:

| Path | Reads |
|---|---|
| `name` | the `name` field |
| `os.version` | `version` inside `os` |
| `nics[0].mac` | the first NIC's MAC |
| `nics[*].mac` | every NIC's MAC |
| `['serial number']` | a key with a space in it |

Run **Preview** first. It shows the first record exactly as the API sent it,
so you can copy paths straight from it. A path that does not parse is refused
when you save.

### Records

**Records path** is where the list of devices sits in each response, e.g.
`data.devices`. Leave it blank when the response *is* the list.

**Pagination:**

| Mode | For an API that… |
|---|---|
| None | returns everything in one response |
| Page number | takes `?page=1`, `2`, `3`… Set the parameter name, whether pages start at 0 or 1, and optionally a page-size parameter |
| Offset | takes `?offset=0`, `100`, `200`… |
| Cursor | returns a token (or a next-page URL) in each response. Give its path, and the parameter to send the token back in |
| Link header | sends `Link: <…>; rel="next"` |

Without a page-size parameter Polaris keeps asking until a page comes back
empty. **Max pages** and **Max records** cap a run.

### Field mapping

| Field | Notes |
|---|---|
| **Identity** | Which field keeps one record on one asset: Record ID, Serial number, MAC address or Hostname. It must be mapped and stable between runs. Hostname is the weakest choice because it changes and repeats ([rule 91](Business-Rules#rule-91)). |
| Record ID, Hostname, Manufacturer, Model, OS, OS version | Taken as written. |
| IP address | A list is fine. The first valid address is used, and `10.0.0.5/24` is read as `10.0.0.5`. |
| MAC address(es) | Every MAC the path reaches is kept. `00:00:00:00:00:00` is ignored ([rule 97](Business-Rules#rule-97)). |
| Serial number | Placeholders such as "Default string" are ignored ([rule 84](Business-Rules#rule-84)). |
| Asset type | The source's own word. Translate it under **Translate asset types** (`Network Camera = other`). A word Polaris already knows (`server`, `printer`…) is used as-is. Anything else gets the **Default asset type**. |
| Location | Shown in the Location column when nothing closer to a place has a value ([rule 22](Business-Rules#rule-22)). |
| Latitude, Longitude | Used only as a valid pair. A FortiGate's own coordinates win, and coordinates you typed on the asset are never moved. |
| Asset tag | Unique across assets: a tag another asset already carries is left off, and the run log says so. |
| Department, Assigned to, Purchase order, Description | Taken as written. A description is not written on a device another integration owns. |
| Acquired, Warranty expiry | An ISO date (`2027-03-01`) or epoch seconds or milliseconds. |
| Tags | Every value the path reaches becomes a tag (`labels[*]`). |

**Default manufacturer** fills in a vendor for feeds that only list one
(an Axis camera server, an HP printer portal).

### Detail queries

Some APIs list devices briefly (an id and a name) and keep the rest behind a
per-device URL. A **detail query** is a second request made **once for each
record**, to fill fields the list does not carry.

| Field | |
|---|---|
| **Name** | A label for the run log and Preview, e.g. *Hardware*. |
| **Method** | `GET`, or `POST` with a JSON body. |
| **Path** | The request path, with `{{path}}` where a value from the record goes: `/api/devices/{{id}}/hardware`. The path inside the braces is read from the **list** record, using the same path syntax as the mapping. |
| **Request body** | `POST` only. Placeholders work here too: `{"deviceId": "{{id}}"}`. |
| **Fields from this response** | One per line, `field = path`, with the path written against the **detail response**: `serialNumber = hardware.serial`. Any field except Record ID. A line Polaris cannot read is named under the box. |

You can add up to five. Each runs on the same host with the same
authentication as the main request.

- A field a detail query maps **wins** over the same field from the list, and a
  later query wins over an earlier one, whenever it has a value. An empty value
  falls through to the list.
- **Identity always comes from the list.** A record keeps its asset even when
  its detail request fails. It simply keeps the fields the list gave it, and the
  run log counts the failures.
- The device filter runs after the detail queries, so you can filter on a
  hostname only a detail query supplies.
- Each detail query costs one request per record per discovery run (2,000
  records and two queries is 4,000 requests). **Requests at once** (default 4,
  at most 16) sets how many are in flight. A run makes at most 20,000 detail
  requests. Records past that keep their list fields.

### Filters

Include or exclude records by their mapped hostname, one pattern per line
(`cam-*`, `*-lab`). An include list wins over an exclude list.

### Lifecycle & limits

- **Decommission an asset when its record leaves the feed.** Off by default.
  When on, it acts only after a complete read. It refuses to act when most
  records vanish at once, never touches a record that was merely filtered out,
  and never decommissions an asset another integration still owns. Off, the
  asset stays and simply stops updating.
- **Verify network presence after each discovery.** On by default (see above).
- **Request timeout** per request.

---

## Monitoring tab

Monitor queries feed Polaris's monitoring from the same API, through the
[`genericapi` polling method](Polling-Methods#the-genericapi-method). Each
query feeds **one** of:

| Feeds | Fields you map |
|---|---|
| Response time (up / down) | `up` (required), `latencyMs`, `uptimeSec`; **Values that mean up** (blank: true, up, online, ok, running, 1, yes, active, healthy, connected, available) |
| CPU / memory | `cpuPct`, `memPct`, `memUsed`, `memTotal`, `memFree` (at least one of the first three); **Sizes are in** bytes, KB, MB, GB or TB |
| Interfaces | per row: `name` (required), `operStatus`, `adminStatus`, `speedBps` or `speedMbps`, `inOctets`, `outOctets`, `inErrors`, `outErrors`, `macAddress`, `ipAddress` (IPv4), `ipv6Address`, `description`, `alias` |
| Storage | per row: `mountPath` and `total` (required), `used` or `free` |
| Temperature | per row: `name` and `celsius` |
| LLDP neighbors | per row: `localIfName`, plus one of `chassisId`, `portId`, `systemName`; also `portDescription`, `systemDescription`, `managementIp` |
| Custom widgets | widgets instead of fields (below) |

Fields are written one per line, `field = path`, using the same path syntax as
the mapping. For the list streams, **Rows path** says where the rows are and
each field is read from every row. A line Polaris cannot read is named under
the box.

### One request for every asset, or one per asset

| Request | How it works | Cost |
|---|---|---|
| **One for every asset** | One request returns every device. **Identity path** is the value in each record that matches the identity the Records & Mapping tab maps. Tick **Page through it like the inventory request** to use the same pagination. | One request per poll for the whole fleet, cached for 30 seconds and shared by every asset and stream that reads it |
| **One per asset** | The path is a template filled from each asset's record: `/api/devices/{{identity}}/metrics`. The placeholders are `{{identity}}`, `{{hostname}}`, `{{ip}}`, `{{serial}}` and `{{mac}}`, as discovery last mapped them. | One request per asset per poll. At most the Records & Mapping tab's **Requests at once** run together, and one query's streams share a request |

Use **one for every asset** whenever the API can list everything at once. At
2,000 devices it is the difference between one request and 2,000.

### Use for this feed's assets

Ticked (the default), the query's stream uses the Generic API method for every
asset this integration discovered, unless you pick another method on the asset.
Removing the query puts the stream back to what it was. A query never turns
monitoring on: you still choose which assets are monitored.

### Custom widgets

A **Custom widgets** query defines widgets, one per line:

| Type | Line | Shows |
|---|---|---|
| `gauge` | `Battery \| gauge \| battery.pct \| % \| 0 \| 100 \| 20` (unit, min, max and warn-at optional) | the latest value on a dial |
| `line` | `Pages \| line \| counters.pages` | its last 60 readings as a line |
| `state` | `Door \| state \| door.status \| closed, locked` | OK while the value is one of those listed, otherwise Alarm |

The widgets appear on the asset page's **Widgets** tab, beside any widgets the
asset's [manufacturer profile](Server-Settings) defines. They need no polling
method of their own. They are read on the CPU / memory schedule, so the asset
needs a CPU / memory method.

### When the API does not answer

A response-time probe is **skipped**, not failed, when Polaris cannot reach the
API, the credentials are refused, the integration is disabled, or a read stops
part way. One API outage never marks every device down. An asset the API
answers for without listing it (or a per-asset request that answers 404) is
**down**.

---

## Network tab

Network queries read **address space** from the API into [IPAM](IPAM). Each
query is one request (tick **Page through it like the inventory request** to
page it) and reads one kind of record:

| Reads | Fields you map | Written as |
|---|---|---|
| Subnets | `cidr`, or `network` with `prefixLength` or `netmask`; `name`, `vlan`, `purpose` | a network |
| DHCP leases | `ipAddress` (required), `macAddress`, `hostname`, `expiresAt` | `dhcp_lease` |
| DHCP reservations | `ipAddress` (required), `macAddress`, `hostname` | `dhcp_reservation` |
| IP assignments | `ipAddress` (required), `hostname`, `macAddress`, `owner`, `notes` | `external` — an address allocated in another IPAM |

Fields are written one per line, `field = path`. Addresses and networks are
**IPv4**; an IPv6 record is skipped and named in Preview.

### What it writes, and what it leaves alone

- **Networks** are created only inside an existing [block](IPAM#ip-blocks),
  and never over an overlapping, [excluded](IPAM#exclusions) or retired
  network. A network you created by hand is claimed: its name and purpose stay
  yours. A network another integration discovered is never taken over, and
  nothing is written into it.
- **Addresses** are written only into networks this integration owns. If the
  integration reads no networks of its own, the network an address falls in is
  claimed for it. If it does read networks, addresses outside them are skipped.
- A **manual reservation** is never overwritten. When the feed disagrees about
  its hostname, owner or notes, a [conflict](Conflict-Resolution) is raised for
  you to accept or reject. A VIP, an interface address or a managed switch or
  AP's row is left alone.
- A lease the feed gives no expiry for expires a day after the run that saw it
  (two discovery intervals if that is longer). Leases are never released
  early — they expire.
- Nothing is ever pushed to a device.

### When something leaves the feed

| Setting | Default | Does |
|---|---|---|
| Release a DHCP reservation or IP assignment the feed stops listing | on | Releases it after a complete read, never when most of them vanish at once |
| Deprecate a subnet the feed stops listing | off | Deprecates a network this integration owns, after a complete read, never when most vanish at once |

### An API that only holds address space

Untick **Read devices (assets) from this API** on Records & Mapping for an
external IPAM such as phpIPAM or NetBox. The device request and mapping are
then not used, and the integration needs at least one network query.
**Test Connection** and **Preview** read each network query's first page.

---

## Preview tab

Click **Run preview** to read the first page with the settings on the other
tabs, saved or not. It shows:

- the first record, exactly as the API sent it;
- each detail query's request and response for that record, so you can copy
  detail paths from it;
- the first ten records as discovery would write them, with any skipped record
  and the reason (for example *no usable id at "id"*). A record your filter
  would drop is dimmed, and a record whose detail query failed is marked.

Nothing is stored. **Test Connection** runs the same read and passes only when
at least one record on the first page maps and every detail query answers for
the first one.

---

## JSON tab

The configuration on the other tabs, as JSON. Use it to read the whole setup
at a glance, keep a backup, or share a mapping for a product.

| Button | |
|---|---|
| **Refresh from form** | Rebuilds the JSON from the other tabs. Opening the tab does this too, unless you are editing the JSON. |
| **Copy** | Copies the JSON. |
| **Export file** | Downloads it as `<name>.genericapi.json`. |
| **Import file…** | Reads a `.genericapi.json` file and fills the form from it. |
| **Apply to form** | Fills the form from the JSON in the box, for a file you pasted or edited. |

The file **never contains the token, password or client secret**, nor the value
of an extra header whose name suggests a credential (`Authorization`, anything
with *key*, *token*, *secret*, *cookie* or *session*). The header's name stays,
with an empty value.

**Include host, port, username, client ID and token URL** is off by default.
Off, the file says nothing about where your systems are or which account
Polaris uses, so it is safe to post publicly. Turn it on to move a
configuration between your own installs.

Importing only fills the form. Nothing is saved until you click Save, and the
same checks as typing the values in apply. A file without connection details
keeps the host already in the form. The status line lists what is still to fill
in, typically the secret and any blanked header. Secrets in a file are never
imported, even when someone has added them by hand.

---

## How a record becomes an asset

Each run, for each record:

1. Polaris looks for the asset this integration already created for that
   identity.
2. Failing that, it looks for an asset with one of the record's **MAC
   addresses**, then one with the same **serial number** (only when exactly one
   asset carries that serial). A match is merged, and the record becomes another
   [source](Assets) on it.
3. Failing that, an existing asset with the **same hostname** raises a pending
   [conflict](Conflict-Resolution) for you to accept or reject. It is never
   merged automatically.
4. Otherwise a new asset is created, tagged `genericapi`.

On an asset that another source also reports, the feed **fills gaps only**. It
never changes an asset type someone already set (it only retypes `other`), and
it never takes an asset away from the integration that owns it.

Department, assigned to, purchase order, description, asset tag and the two
dates follow one rule. The feed fills them when the asset has none, and keeps
them current only while the asset still holds the value the feed itself wrote.
Once you, or another integration, change one, the feed leaves it alone. A value
that disappears from the feed is never cleared from the asset. Tags the feed
stops listing are removed. Tags you added are kept, unless the feed once
listed the same tag and has since dropped it.

### When a read is incomplete

A run that fails on its **first** page writes nothing. A run that stops part way
keeps what it read but counts as **incomplete**. Polaris then removes and
decommissions nothing. A run stops part way when:

- a later page fails;
- it reaches **Max pages** or **Max records**;
- the API returns the same page twice (it may not support the pagination you
  chose);
- a next-page link points at a different host.

A failed detail query does not make a read incomplete. Completeness is decided
by the list alone.

The Events page records each run with its record and page counts, plus any
records skipped for a missing identity.

---

## Safety

- Polaris refuses hosts in loopback, link-local and cloud-metadata ranges,
  for the API and the OAuth token URL alike.
- It never follows a redirect, and never follows a next-page link to another
  host.
- A value placed into a detail query's path is URL-encoded, so a record cannot
  add path segments, query parameters or a host. A value of `.` or `..` is
  refused.
- A single response over 25 MB is refused.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| *found no records on the first page* | The **Records path** is wrong. Run Preview and look at the first record's structure. |
| *none mapped: no usable id at …* | The identity path does not match the records. Check it against the sample in Preview. |
| *answered with a redirect* | Point the integration at the final URL. HTTP to HTTPS redirects are common. |
| *refused the credentials (HTTP 401/403)* | Wrong token or key, wrong header name, or the account lacks read access. |
| *returned the same page twice* | The API ignores the page parameter you chose. Try another pagination mode, or None. |
| *the record has no usable value at {{…}}* | A detail query's placeholder path finds nothing in the list record. Check it against the first record in Preview. |
| *Detail queries failed for N record(s)* | Those records kept their list fields. The message names the first few. A 404 usually means the placeholder fills in the wrong id. |
| A field a detail query maps stays blank | Check the path against the detail response in Preview. It is written against that response, not the list record. |
| *This asset's Generic API integration has no … monitor query* | The asset's stream is on the Generic API method but no query feeds it. Add one on the Monitoring tab, or pick another method. |
| A temperature or widget query never reports | Both are read on the CPU / memory schedule. Give the asset a CPU / memory method. |
| Probes show *skipped* | Polaris could not read the API. Check Test Connection, and that a fleet query's paging reaches the last page. |
| Assets created but never Last Seen | They have no IP Polaris can ping, and nothing else reports them. Map an IP, or monitor them another way. |
