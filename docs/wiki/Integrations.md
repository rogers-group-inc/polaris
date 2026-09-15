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

## The seven types

| Type | Reads | Produces | Page |
|---|---|---|---|
| **FortiManager** | many FortiGates via FMG | assets, networks, reservations, VIPs | [Fortinet](Integration-Fortinet) |
| **FortiGate** (standalone) | one device over REST | same | [Fortinet](Integration-Fortinet) |
| **Entra ID / Intune** | Microsoft Graph | assets | [Directory](Integration-Directory) |
| **Active Directory** | LDAP / LDAPS | assets | [Directory](Integration-Directory) |
| **Windows Server** | WinRM DHCP | networks, reservations | [Windows Server](Integration-Windows-Server) |
| **VMware vCenter** | vSphere REST + SOAP | assets, datastores | [vCenter](Integration-vCenter) |
| **Azure Arc** | Azure Resource Manager | assets | [Azure Arc](Integration-Azure-Arc) |

Plus two things managed from this page that are not integration rows:

- the **[Polaris Agent](Polaris-Agent)** tab — builds, SSH deployment, and
  service/process discovery rules;
- **[Network Discovery](Network-Discovery)** — saved active scans, which is
  deliberately **not** an eighth integration type.

---

## Adding one

**+ Add Integration** → pick the type → fill in the modal.

Every type's modal follows the same shape, in a fixed tab order:

```
General → Filters → Monitoring → DHCP Push → Quarantine Push
        → Description Sync → SD-WAN → Geographic Location → Directory
```

Tabs a type does not support are hidden. **The FortiManager and standalone
FortiGate layouts are deliberately identical**, diverging only where the two
integrations genuinely differ.

### Four fields every type has

| Field | |
|---|---|
| `host` | absent on Entra and Arc, whose endpoints are fixed |
| `port` | |
| `verifySsl` / `verifyTls` | **on by default for new integrations**. An existing row keeps its stored value, so this never changes a configured integration's behaviour |
| `verboseLogging` | always the **last** element on the General tab |

Plus, on the integration row itself:

| | |
|---|---|
| `name` | |
| `enabled` | |
| `autoDiscover` | on by default |
| `pollInterval` | hours — 12 for the Fortinet types, 4 for Windows Server |

### Test Connection

Every modal has one, and it records the result on the row. **Test before you
save**, and again after changing a credential.

The button knows which fields it needs per type, and on the **edit** path it
drops blank secrets — so "leave blank to keep the current secret" works.

---

## Running discovery

Either the row's **Discover** button, or the scheduler on `pollInterval`.

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

Each block carries `addAsMonitored`, per-stream polling methods and credentials,
and — on the classes that support it — agent auto-deploy and interface/storage
auto-monitor.

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

Everything else Polaris does is a **read**.

---

## Diagnosing an integration

Three tools, in order of how much they cost:

1. **Test Connection** — is the credential still good?
2. **The Query API button** — proxies a raw read to the upstream system. It is
   the self-service way to answer *"why didn't device X get discovered?"*.
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
   contains.
4. **Leave every push toggle off** until the read side is right. A push is a
   write to your network.
5. Then [automations](Automations), and give the seeded ones real recipients.
