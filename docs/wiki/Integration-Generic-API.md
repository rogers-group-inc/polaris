# Generic API

Reads devices from **any REST API that returns JSON** and turns each record into
an asset. Use it for systems that have no integration of their own, such as a
facilities CMDB, a camera or printer management server, a vendor cloud portal,
or an internal inventory service.

You describe the request and then say which field in each record means what.
Polaris keeps no knowledge of the product on the other end. The **Preview** tab
shows what discovery would write before you save anything.

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

**Default manufacturer** fills in a vendor for feeds that only list one
(an Axis camera server, an HP printer portal).

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

## Preview tab

Click **Run preview** to read the first page with the settings on the other
two tabs, saved or not. It shows:

- the first record, exactly as the API sent it;
- the first ten records as discovery would write them, with any skipped record
  and the reason (for example *no usable id at "id"*). A record your filter
  would drop is dimmed.

Nothing is stored. **Test Connection** runs the same read and passes only when
at least one record on the first page maps.

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

### When a read is incomplete

A run that fails on its **first** page writes nothing. A run that stops part way
keeps what it read but counts as **incomplete**. Polaris then removes and
decommissions nothing. A run stops part way when:

- a later page fails;
- it reaches **Max pages** or **Max records**;
- the API returns the same page twice (it may not support the pagination you
  chose);
- a next-page link points at a different host.

The Events page records each run with its record and page counts, plus any
records skipped for a missing identity.

---

## Safety

- Polaris refuses hosts in loopback, link-local and cloud-metadata ranges,
  for the API and the OAuth token URL alike.
- It never follows a redirect, and never follows a next-page link to another
  host.
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
| Assets created but never Last Seen | They have no IP Polaris can ping, and nothing else reports them. Map an IP, or monitor them another way. |
