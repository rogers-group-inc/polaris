# ArcGIS

Connects Polaris to an **ArcGIS** portal: ArcGIS Online, ArcGIS Location
Platform, or your own **ArcGIS Enterprise**.

It discovers no devices and **never writes to ArcGIS**. It is how Polaris
reads from ArcGIS for the [Device Map](Device-Map): satellite imagery (the
**Basemap** tab) and the feature layers — fiber routes, pole lines,
handholes, parcels — drawn on its Topology views (the **Layers** tab). A
sign-in that can only view is enough.

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
| **API key** | the key | ArcGIS Location Platform, or an API key credential in ArcGIS Online. Give it only the privileges Polaris needs: basemaps, and viewing the layers it reads. |
| **Username and password** | a named user | ArcGIS Enterprise without OAuth apps. Polaris signs in through the portal's `generateToken` endpoint. Use a dedicated account. |
| **None** | nothing | Public services and public layers only (such as Esri World Imagery). |

The key, client secret and password are stored encrypted and never shown again;
leave the field blank on Edit to keep the saved one. Changing the **Portal URL**
needs the secret typed again, so a saved secret is never sent to a new address
([rule 111](Business-Rules#rule-111)).

## Test Connection

Signs in and reads the portal's description, then reports the organization's
name and how Polaris signed in, for example *Signed in to Example GIS as an
app*. With **None** it only checks that the portal answers. It then reads
every layer on the **Layers** tab and checks that its fields are still there
and that ArcGIS accepts its filter. A failure shows the
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

## Layers

The feature layers Polaris reads and draws on the Device Map's Topology
views ([rule 188](Business-Rules#rule-188)). Polaris only reads them: nothing
drawn or changed in Polaris is sent to ArcGIS.

**Finding a layer.** Search **My organization** or **My content** (only the
feature layers this sign-in can see are listed), press **Layers** on an item to
see its layers, and **Add** the ones you want. Or choose **Paste a URL** and
give one layer's address, `https://…/FeatureServer/<number>`. Tables, which
have nothing to draw, cannot be added. Up to 20 layers.

**Each layer's settings** (click it in the list):

| Field | |
|---|---|
| **Name on the map** | What the legend and the Map layers card call it. |
| **Colour**, **Width**, **Line** | How it is drawn: one of six theme colours, 1–8 px, solid, dashed or dotted. Points are drawn as dots, areas as a faint fill with an outline. |
| **Label field** | Drawn along each line (or beside each point) when zoomed in close. |
| **Identity field** | How Polaris finds a feature again — **GlobalID** where the layer has one, since it survives edits in ArcGIS; OBJECTID otherwise. A connection routed through a line remembers it by this value. |
| **Shown when a feature is clicked** | Up to 10 fields for the card a click opens. The card also gives a line's length, the connections riding it, and **Open in ArcGIS**. |
| **Only features where** | Optional: an ArcGIS where clause, such as `STATUS = 'In service'`. **Test Connection** checks it. |

**Which views draw it.** A layer is not drawn anywhere until a Topology view
ticks it under **Map layers** ([Device Map](Device-Map#arcgis-layers)).

**Your sign-in stays on the server.** The browser asks Polaris for the features
in view, and Polaris asks ArcGIS — the key or token never reaches anyone's
browser. A layer on a host other than your portal's (or, for ArcGIS Online,
other than Esri's `arcgis.com`) needs the secret typed again when you save it,
so a saved secret is never sent to a new address ([rule 111](Business-Rules#rule-111)).

## Permissions

Adding, editing and testing the integration, and searching for layers, needs
**Read-Write** on `integrations`. Seeing the layers on the map needs only
**Read** on `deviceMap`; routing a connection through a line needs Device Map
**Read-Write** ([Users, roles and permissions](Users-Roles-and-Permissions)).
