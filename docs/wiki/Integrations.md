# Integrations

The page where you connect Polaris to the systems that know things.

Gated by `integrations`. Reads at `read`; creating, editing and running
discovery at `write`.

> **No integration is guaranteed and every one is absent by default** —
> discovery is something you turn on, not something you turn off. An install
> with none still works on hand-entered assets and address space.
>
> But this page is the point of the product: pulling the systems you already run
> into one dashboard, where a device known to four of them is **one record
> carrying four sources** rather than four rows to reconcile by hand.

---

## The eleven types

| Type | Reads | Produces | Page |
|---|---|---|---|
| **FortiManager** | many FortiGates via FMG | assets, networks, reservations, VIPs | [Fortinet](Integration-Fortinet) |
| **FortiGate** (standalone) | one device over REST | same | [Fortinet](Integration-Fortinet) |
| **Entra ID / Intune** | Microsoft Graph | assets | [Directory](Integration-Directory) |
| **Active Directory** | LDAP / LDAPS | assets | [Directory](Integration-Directory) |
| **Windows Server** | WinRM DHCP | networks (from DHCP scopes) | [Windows Server](Integration-Windows-Server) |
| **VMware vCenter** | vSphere REST + SOAP | assets, datastores | [vCenter](Integration-vCenter) |
| **Azure Arc** | Azure Resource Manager | assets | [Azure Arc](Integration-Azure-Arc) |
| **Unraid** | Unraid GraphQL API (7.2+) | host, VMs, containers | [Unraid](Integration-Unraid) |
| **TrueNAS SCALE** | TrueNAS JSON-RPC WebSocket API (25.04+) | host, VMs, Apps | [TrueNAS SCALE](Integration-TrueNAS) |
| **Proxmox VE** | Proxmox VE REST API (9.x), read-only | cluster nodes, VMs, LXC containers | [Proxmox VE](Integration-Proxmox) |
| **Generic API** | any REST API returning JSON, mapped field by field | assets | [Generic API](Integration-Generic-API) |

Plus two integrations that discover nothing:

- **AI Assistant** — the model server behind the [AI assistant](AI-Assistant),
  either one you run or an Azure AI Foundry deployment.
- **ArcGIS** — a sign-in to ArcGIS Online, Location Platform or your own ArcGIS
  Enterprise portal, for map features ([ArcGIS](Integration-ArcGIS)).

The page has a second tab, **Polaris Agents** — the
[Polaris Agent](Polaris-Agent) build, SSH deployment, and service/process
discovery rules — which is not an integration row.

**[Network Discovery](Network-Discovery)** — saved active scans of IP ranges —
lives on the Assets page under **+ Add Asset(s)**.

---

## Adding one

**+ Add Integration** → pick the type → fill in the modal.

The modal is tabbed, and the tab set depends on the type:

| Type | Tabs, in order |
|---|---|
| FortiManager / FortiGate | General → Filters → Monitoring → DHCP Push → Quarantine Push → Description Sync → SD-WAN → Geographic Location |
| Active Directory | General → Monitoring → Directory |
| Entra ID / Intune | General → Monitoring → Directory → Script Publishing |
| Azure Arc | General → Monitoring → Script Publishing |
| Windows Server, vCenter, Unraid, TrueNAS SCALE, Proxmox VE | General → Monitoring |
| Generic API | General → Records & Mapping → Preview (its assets are monitored one by one, like manually added ones) |
| AI Assistant | one untabbed form — Model Server, then Assistant Behaviour ([AI assistant](AI-Assistant)) |
| ArcGIS | one untabbed form — Portal and sign-in ([ArcGIS](Integration-ArcGIS)) |

Outside the Fortinet pair, the connection settings **and** the filters live on
the General tab. **The FortiManager and standalone FortiGate layouts are
deliberately identical**, diverging only where the two integrations genuinely
differ.

### Fields every type has

| Field | |
|---|---|
| `host` | absent on Entra and Arc, whose endpoints are fixed |
| `port` | |
| `verifySsl` / `verifyTls` | **on by default**. Windows Server has **Use SSL** instead, and Entra and Arc talk only to Microsoft's fixed endpoints |
| `verboseLogging` | always the **last** element on the General tab |

Plus, on the integration row itself:

| | |
|---|---|
| `name` | |
| `enabled` | |
| `autoDiscover` | on by default |
| `pollInterval` | hours, 1–24 — 12 for most types, 4 for Windows Server, 1 for Unraid, TrueNAS and Proxmox VE |

### Test Connection

Every modal has one, and it records the result on the row. **Test before you
save**, and again after changing a credential.

The button knows which fields it needs per type, and on the **edit** path it
drops blank secrets — so "leave blank to keep the current secret" works. That
holds only while the host, port, token URL and connection type are unchanged:
change one of them and the secret must be entered again, because a saved secret
is never sent to a new address ([rule 111](Business-Rules#rule-111)).

---

## Running discovery

Either the row's **Discover** button, or the scheduler on `pollInterval`.

**Both wait for a successful Test Connection.** Until the row has one, the
Discover button is disabled and the details panel reads *Disabled until a
successful connection test* — and a row whose last test failed stays skipped by
the scheduler until a manual test passes again.

**The scheduler waits five minutes after a restart.** After a service restart or
an in-app update, no scheduled discovery starts for the first five minutes, so
Polaris can finish starting up first. A discovery that is due in that window runs
when it ends, and the next one is still timed from its last run. The **Discover**
button is not delayed.

The **Discovery Activity** dashboard widget shows in-flight runs with per-run
progress and amber telemetry for slow ones; the sidebar carries a status panel
for the same thing.

Both render `· N offline` and `· N unread` as **separate** parts, and no surface
may sum them ([rule 53](Business-Rules#rule-53)):

| | |
|---|---|
| **offline** | routine — a staged gate awaiting deployment sits offline for weeks, and Polaris reads its cached configuration **on purpose** |
| **unread** | the device was **never reached**, and is **named** in a warning Event |

See [How discovery works](Discovery) for the model underneath all of this — the
multi-source projection, presence rules, post-sync passes, and how each type
decides something has gone away.

---

## Monitoring settings

Every integration carries a **Monitoring** tab: the integration tier of the
[polling-method hierarchy](Polling-Methods#the-hierarchy), split into
**per-class blocks**.

| Type | Classes |
|---|---|
| FortiManager / FortiGate | FortiGate · FortiSwitch · FortiAP |
| Entra / AD / Windows Server / Arc | Workstations · Servers (Arc adds Kubernetes) |
| vCenter | VMs · ESXi hosts |
| Unraid / TrueNAS | Host · Virtual Machines · Containers (Apps on TrueNAS) |
| Proxmox VE | Nodes · Virtual Machines · Containers |

Each block carries `addAsMonitored`, per-stream polling methods and credentials,
and — on the classes that support it — agent auto-deploy and interface/storage
auto-monitor. The AD, Entra, Arc and vCenter VM blocks carry the full set;
Windows Server, ESXi hosts, Kubernetes clusters and the Unraid / TrueNAS /
Proxmox VE classes carry `addAsMonitored` and streams only.

AD, Entra, Arc and vCenter also carry **Verify network presence after
discovery** (on by default) at the top of the tab — see
[Post-sync passes](Discovery#post-sync-passes).

Cadence and retention live on the same tab.

> **Turning on `addAsMonitored` starts polling a class of devices.** At fleet
> scale that is a real load decision, and it is also the gate that decides
> whether [automations may fire](Automations#the-gate-every-automation-passes)
> about them at all.

---

## Push toggles

Only the Fortinet types write to devices, and **every push toggle is off by
default**:

| Toggle | |
|---|---|
| DHCP Push | manual reservations are written to the gate, verified by read-back |
| Quarantine Push | MAC address-group entries |
| Auto-reserve Fortinet infrastructure | requires DHCP Push |
| Adopt discovered MAC | requires DHCP Push |
| Description Sync | writes Polaris descriptions to devices |
| Coordinate write-back | writes geocoded coordinates |

Two Azure-side write capabilities are also off by default and gated separately:
[Intune script publishing](Integration-Directory#publishing-scripts-to-intune)
and [Arc Run Command](Integration-Azure-Arc#publishing-scripts-via-run-command).

Unraid and TrueNAS add one more: **starting, stopping, restarting and updating
a VM or container** from its asset, by a user with Assets Read-Write and only
when the integration's API key is allowed to
([rule 94](Business-Rules#rule-94); see [Unraid](Integration-Unraid#workload-actions)
and [TrueNAS SCALE](Integration-TrueNAS#workload-actions)). Proxmox VE is
monitored read-only ([Proxmox VE](Integration-Proxmox#read-only-by-design)).

Everything else Polaris does is a **read**.

---

## Deleting an integration

**Delete** on an integration's card removes the integration, not the inventory it built
([rule 160](Business-Rules#rule-160)). The dialog tells you what will happen before you
confirm:

| | What happens |
|---|---|
| Assets it discovered | **Kept.** What this integration reported about them is removed, so they stop being updated from it. An asset another integration also reports carries on as before |
| Networks it discovered | **Kept**, as manual networks |
| `azure:` tags (Azure Arc) | Removed from the assets it reported |
| VM / container placement (vCenter, Unraid, TrueNAS, Proxmox) | The links to their hosts are removed, so they no longer suppress alerts |
| DHCP reservations it pushed to a device | **Left on the device.** Polaris can no longer change or remove them; releasing the reservation in Polaris afterwards does not touch the device. Every entry is listed in a warning Event, `integration.dhcp_entries_left` |

If the integration is the only thing reporting some assets, the dialog offers **Also
decommission the N assets that no other source reports**, and says how many of them are
being monitored. It is not ticked for you: left unticked those assets stay active with
nothing updating them. Ticking it needs Full Read-Write on **Assets**. An asset you
created by hand is never decommissioned this way, even if the integration also reported it.

If you are replacing an integration rather than retiring its devices, add the new one and
run it **before** deleting the old one: the assets then have another source and none of
them is offered for decommissioning.

## Diagnosing an integration

Three tools, in order of how much they cost:

1. **Test Connection** — is the credential still good?
2. **The Query API button** — proxies a raw read to the upstream system. It is
   the self-service way to answer *"why didn't device X get discovered?"*.
   Every type has one except Windows Server.
3. **Verbose logging** — the bottom of the General tab. The next discovery cycle
   **and every monitor job for this integration's assets** emit step-by-step
   logs at info level. High volume; turn it off when done.

Then read the run's Events, filtered to `warning` and `error`.

---

## A sensible order for a new install

1. **Server Settings → Credentials** first. Add the SNMP, SSH, WinRM and REST
   credentials before the integrations that reference them.
2. **One integration**, tested, discovered once, and its results reviewed —
   before adding a second. Two integrations discovering the same devices is
   normal and correct, but it is easier to read one source's output first.
3. **Leave `addAsMonitored` off** until you have seen what a class actually
   contains. The one exception is a standalone FortiGate integration's own
   gate, which is always monitored
   ([rule 127](Business-Rules#rule-127)).
4. **Leave every push toggle off** until the read side is right. A push is a
   write to your network.
5. Then [automations](Automations), and give the seeded ones real recipients.
