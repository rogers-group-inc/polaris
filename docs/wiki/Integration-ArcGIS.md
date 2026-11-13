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

## Permissions

Adding, editing and testing the integration needs **Read-Write** on
`integrations` ([Users, roles and permissions](Users-Roles-and-Permissions)).
