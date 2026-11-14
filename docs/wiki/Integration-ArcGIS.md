# ArcGIS

Connects Polaris to an **ArcGIS** portal: ArcGIS Online, ArcGIS Location
Platform, or your own **ArcGIS Enterprise**.

It discovers no devices. It is how Polaris signs in to ArcGIS for map features:
satellite imagery on the [Device Map](Device-Map) (the **Basemap** tab, below),
and — still being built — writing the cable runs drawn on the map to a layer in
your ArcGIS organization.

Add it from **Integrations → + Add Integration → ArcGIS**. Like the
[AI Assistant](AI-Assistant) integration it has no Discover button and no
auto-discovery.

---

## Portal

| Field | |
|---|---|
| **Portal URL** | Leave blank for ArcGIS Online and Location Platform (`https://www.arcgis.com`). For ArcGIS Enterprise, give your portal's address, for example `https://gis.example.com/portal`. It must be `https://`. |
| **Verify TLS certificate** | On by default. Turn it off only for an Enterprise portal with a private certificate; Polaris then pins the certificate it first sees and refuses a different one. |

## Signing in

Pick one method under **Sign in with**. Only that method's fields are shown.

| Method | What you enter | Use it for |
|---|---|---|
| **OAuth app credentials** | client ID + client secret | Recommended for an organization. Create an app in ArcGIS (Content → New item → Developer credentials → OAuth 2.0 credentials). Polaris exchanges them for a two-hour token and renews it as needed. |
| **API key** | the key | ArcGIS Location Platform, or an API key credential in ArcGIS Online. Give it only the privileges Polaris needs. |
| **Username and password** | a named user | ArcGIS Enterprise without OAuth apps. Polaris signs in through the portal's `generateToken` endpoint. Use a dedicated account. |
| **None** | nothing | Public services only (such as Esri World Imagery). Nothing can be written to ArcGIS without a sign-in. |

The key, client secret and password are stored encrypted and never shown again;
leave the field blank on Edit to keep the saved one. Changing the **Portal URL**
needs the secret typed again, so a saved secret is never sent to a new address
([rule 111](Business-Rules#rule-111)).

## Test Connection

Signs in and reads the portal's description, then reports the organization's
name and how Polaris signed in, for example *Signed in to Example GIS as an
app*. With **None** it only checks that the portal answers. A failure shows the
message ArcGIS returned, such as *Invalid token.* or *Invalid username or
password.*

The Polaris server makes these requests, not the browser, so the server needs
to reach the portal. Check with your IT team that the portal is reachable from
the Polaris host and that the provider is approved.

## Basemap

Adds a **Map | Satellite** switch to the Device Map's Topology views, with
imagery from ArcGIS.

| Field | |
|---|---|
| **Offer satellite imagery on the Device Map** | Off by default. |
| **Imagery** | **Esri World Imagery**, or **An imagery service in your portal** (a cached `MapServer` or `ImageServer`, for example your own orthophotos). |
| **Imagery service URL** | Only for a portal service: its `https://…/MapServer` or `…/ImageServer` address. Polaris sends this integration's sign-in with each request. |
| **Attribution** | The credit shown on the map. Blank uses Esri's for World Imagery; required for a portal service. |
| **Deepest zoom** | The most detailed level the imagery has (default 19). Past it the map enlarges the last real tiles instead of showing "Map data not yet available". |

World Imagery is fetched from Esri's keyed host when you sign in with an
**API key**, and from its public host otherwise (no credential is sent there).

**This imagery wins over Server Settings → Customization → Satellite imagery**
while it is on ([rule 183](Business-Rules#rule-183)); turn it off and those
settings apply again. Only one ArcGIS integration can supply imagery at a time.
Views saved on the satellite layer keep working whichever one is in use.

While the basemap is on, **Test Connection** also fetches one imagery tile. A
portal service with no tile at that spot still passes — a regional service
covers only its area. Moving a portal service to a new address needs the
integration's secret typed again.

## Write-back

Writes the [cable runs](Device-Map#cable-runs) drawn on the Device Map to a
line layer in your ArcGIS organization. It is **one way**: runs drawn,
edited or deleted in Polaris are pushed to the layer; edits made in ArcGIS
are not read back, and are overwritten on the next change in Polaris.
Which connections ride a run is not sent.

| Field | |
|---|---|
| **Write cable runs to ArcGIS** | Off by default. Only one ArcGIS integration can write runs. Needs a sign-in. |
| **Layer** | **An existing layer, with a field map**, or **A layer Polaris creates with its own fields**. |
| **New service name** / **Create layer** | Only for a Polaris layer, on a saved integration: creates a hosted feature layer in the signed-in user's content, with elevation (z) values, and fills in the URL and field map. Needs **Full Read-Write** on Integrations and a sign-in allowed to create content. It does not turn write-back on. |
| **Feature layer URL** | One layer of a feature service: `https://…/FeatureServer/<number>`. **Read layer** shows its geometry, whether it allows create, update and delete, and anything that would stop or limit write-back. Changing it needs the secret typed again. |
| **Field map** | Which layer field receives each Polaris value: Polaris ID (required), name, medium, placement, site, notes, length in metres, last updated. Leave a row on *not written* to skip it. |
| **Values for …** | When Medium or Placement goes to a field with a list of codes (a coded-value domain), pick the code for each Polaris value. |

Polaris writes the run's id to the **Polaris ID** field and uses it to find
its features again, so a run is never added twice. Runs are sent as soon as
the view is saved, and again every minute until they land. Each run's panel
on the map shows **Pending**, **Synced** or **Failed** with the message
ArcGIS gave; this tab counts them, and **Retry failed** (Full Read-Write on
Cable Runs) sends the failed ones again once you have fixed the cause.
Elevation from surveyed trenches is written when the layer has z values.

Turning write-back off, or pointing it at another layer, starts over: every
run is sent again when it is next on, and runs deleted meanwhile stay in the
old layer (an Event lists them). See [rule 185](Business-Rules#rule-185).

**Before you point this at your organization's production GIS, test it
against a scratch layer, and have your GIS team review the field map.**

## Permissions

Adding, editing and testing the integration needs **Read-Write** on
`integrations` ([Users, roles and permissions](Users-Roles-and-Permissions)).
