# VMware vCenter

Discovers VMs, ESXi hosts and datastores, and — unusually — **monitors them
too**, through the vCenter server rather than through the guest.

---

## Configuration

| Field | Default | |
|---|---|---|
| Host | — | vCenter address |
| Port | 443 | |
| Verify TLS | **on** for new integrations | |
| Username | — | |
| Password | — | secret |
| `vmInclude` / `vmExclude` | — | wildcards against the **VM name**; include wins when both are set |
| **Verify presence** | on | |
| **VM monitor** block | — | the full workstation/server-style block: agent deploy + interface/storage auto-monitor |
| **Host monitor** block | — | the reduced block: `addAsMonitored` + streams only |
| Verbose logging | off | |

The account needs **inventory read**. A post-login 401 on the inventory calls is
the signature of a missing inventory permission rather than a bad password.

Transport: vSphere Automation REST for session auth and most reads, plus **two
narrow SOAP property-collector calls** for what REST cannot provide — batched VM
quick-stats, and datastore backing / host-mount information.

---

## What it discovers

| Object | Becomes |
|---|---|
| **Virtual machine** | an Asset of type **`server`** |
| **ESXi host** | an Asset of type `hypervisor` |
| **Datastore** | a current-state row, delete-replaced per run, with array-vendor identification from the NAA prefix |

> **VMs are typed `server`, not `virtual_machine`.** The dedicated type was
> retired in 2026-07; VM identity lives in the asset's virtualization blob and
> its `vcenter-vm` source row. That matters because the VM-class behaviours —
> the dependency-layer stamp, the monitored sweep — gate on **ownership**
> (`discoveredByIntegrationId`), **not on the type**, so vCenter never fights a
> directory integration over a MAC-matched server it merely enriches.

**Hosts sync first**, so each VM's virtualization blob can link its host asset.

### The VM match cascade

```
vcenter-vm source row by external id (instance UUID, then moref)
  → vNIC MAC — a positive-identity takeover of a directory- or
    Fortinet-discovered asset
    → hostname collision → Conflict
      → create
```

### Guest filesystems are not a discovery fact

Discovery stopped pulling per-VM guest filesystems in 2026-08 — one REST call
per VM per run — because the **`vcenter` storage stream samples them every
system-info pass** instead. They belong in the System tab's Storage table with
history, pinning and alerting, rather than as a static table on the General tab.

---

## Monitoring through vCenter

The **`vcenter` polling method** covers **four** streams — responseTime,
cpuMemory, interfaces **and** storage — and is the **source default for all
four**, on both VMs and ESXi hosts.

That is what lets a vCenter fleet be monitored with **no credential in the
guest, no SNMP enabled on ESXi, and no reachable guest IP.**

Two warm caches back it, each one SOAP round trip per integration per tick:

| Cache | Serves |
|---|---|
| VM quick-stats | CPU, RAM, **the memory breakdown**, power state, uptime, guest disk, guest net |
| Host snapshot | CPU, RAM, connection state, uptime, pNICs, VMkernel ports, virtual switches — **paired with the datastore inventory in one session** |

The host snapshot is the **same fetch** discovery uses, and its two halves report
failure separately, so a host-property gap cannot cost discovery its datastore
detail.

### Per-core CPU and the memory breakdown

A vCenter-monitored VM or ESXi host is charted the way an agent-monitored host
is: **Assets → System splits CPU & Memory into two charts**, a per-core CPU
chart and a byte-scaled memory stack, under one range selector.

| | CPU chart | Memory chart, against |
|---|---|---|
| **VM** | one line per **vCPU** | **configured RAM** — private, shared, ballooned, host-swapped, compressed |
| **ESXi host** | one line per **physical core** | **installed RAM** — consumed, ballooned, host-swapped |

The gap between the stack and the dashed *Installed total* line is memory
nothing has had to touch.

**These bands are the hypervisor's accounting, not the guest's**, and the
legend says so. They answer a question no agent inside the VM can: **ballooned**
is memory the balloon driver has handed back to the host, **host-swapped** is
guest memory ESXi has paged out to disk, and **compressed** is guest memory it
has squeezed rather than paged. All three climbing is a host under memory
pressure taking memory away from this guest — from inside the guest that is
invisible, and its own free-memory figure will not move.

They are also why the agent's bands and these are never mixed in one chart.
Processes / buffers / cache and private / shared / ballooned are two different
measurements of the same RAM, and stacking them together would be arithmetic
about nothing.

#### Two things that make cores go missing

- **Per-core detail is kept for the detail-retention window only** (7 days by
  default — Server Settings → Retention). A longer range is served from
  hourly/daily rollups, which keep the cross-core average alone; the chart says
  so when that is why.
- **The account needs the Performance privilege.** Per-core CPU and a host's
  balloon/swap come from vCenter's PerformanceManager, not from the quick-stats
  properties everything else here uses. A read-only service account that lacks
  it still yields full CPU, memory, power state and interfaces — the charts
  simply fall back to the aggregate line, exactly as they do for SNMP. Nothing
  fails, and nothing says so louder than a missing legend; check the privilege
  if an ESXi host charts one CPU line where you expect its cores.

### Absent is not unreachable

**vCenter answering *without this asset in it* is a real finding** and fails the
probe. Polaris being unable to **ask** returns a *skip* — no sample, no counter,
cadence anchor only.

So a vCenter outage can never declare an entire virtual fleet down at once.

### Nested host interfaces

An ESXi host's interfaces arrive **nested**. Each vSwitch — standard, or the
host's end of a distributed switch — is written as an **aggregate** row, with
its uplink pNICs and the VMkernel ports riding its port groups stamped as its
children. That is the FortiSwitch-trunk shape, so the System tab nests it
unchanged. Each VMkernel port picks up its port group's VLAN id.

A vSwitch's operational status is **derived** — up while any uplink is up, and
**null with no uplinks at all**, because an internal-only vSwitch is not an
outage. It carries no speed, vCenter publishing no aggregate rate.

Teaming policy, port counts and the port-group VLAN table are *inventory* and
render on the host's General tab instead. A distributed switch's own
configuration is a per-vCenter object and is deliberately not read.

**Temperature and LLDP are unavailable** on this method. The dedicated
storage-only cadence stays SNMP-only, because vCenter storage already rides the
system-info pass.

---

## Dependency edges

VM→host placement writes dependency edges, and they are **vMotion-safe**: a VM
on a **clustered** host gets one edge **per cluster-member host**, so all-down
suppression fires only when the **entire cluster** is dark.

See [Dependency suppression](Dependency-Suppression).

---

## The disappearance sweep

vCenter was the first integration with a fleet-absence pass, and its rule is
worth knowing precisely — the AD and Entra sweep is opt-in and judged
differently (by which integration *manages* the asset rather than by whether
anything still claims it), so do not read one as the other. See
[Integration-Directory](Integration-Directory).

**A VM or ESXi host that leaves the inventory is decommissioned only if nothing
else claims it.**

The last pass deletes the stale `vcenter-vm` / `vcenter-host` source rows. An
asset thereby left with **no `AssetSource` row at all** is flipped to
`decommissioned` (with any open maintenance window force-closed first). **Any**
surviving source — a directory record, an Arc row, a reporting agent, the
`manual` row of an operator-created asset — leaves the asset untouched.

### Absence only counts when the read was whole

The pass is **skipped entirely**, deletes included, when the inventory is:

- **incomplete** — a per-host VM list failed (those are logged rather than
  failing the run), or
- **empty**.

And VMs still present in the **raw pre-filter listing** are retained — so
changing `vmInclude` or `vmExclude` **decommissions nothing**.

A **[scoped run](Discovery#scoped-single-device-discovery)** suppresses the
sweep with a second, independent guard, along with the dependency-edge and
datastore delete-replaces.

---

## Merged assets keep their own identity

When vCenter matches a VM to an asset a directory already discovered, the merge
is an **enrichment**, not a takeover:

- the asset keeps its **directory asset type** — it flips only from the `other`
  catch-all;
- it keeps its `discoveredByIntegrationId`;
- the `vcenter-vm` source row is how the monitor collectors find the vCenter
  integration for it.

Resolution for monitoring goes through the **`vcenter-vm` or `vcenter-host`
source row**, not through `discoveredByIntegration` — which is also why the
`vcenter` polling method is allowed on the directory source kinds.

---

## Troubleshooting

| Symptom | Look at |
|---|---|
| 401 after a successful login | the account is missing **inventory** permission, not the wrong password |
| Every VM went `down` at once | that should be a *skip*, not a miss — check whether Polaris can reach vCenter at all, and which build you are on |
| A VM was decommissioned that still exists | it left the inventory **and** had no other source. Check for a filter change (which should retain it) and for an incomplete read |
| VMs vanished after editing `vmInclude` | they should not — the pre-filter retention exists for exactly this. Check the run's Events |
| No storage history on VMs | the `vcenter` storage stream is the source; the old per-VM guest-filesystem pull was removed |
| Datastore capacity looks stale | it is a **delete-replace per run** — check whether the host-snapshot half of the paired fetch failed |
