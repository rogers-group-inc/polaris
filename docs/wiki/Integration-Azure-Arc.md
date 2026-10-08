# Azure Arc

Discovers **Arc-enabled servers** through Azure Resource Manager. Unlike a
directory integration, the Connected Machine agent runs **in the guest** — so
hostname, OS and serial come from the host itself rather than from a directory
record.

That is why Arc ranks so high in the projection: for **OS, OS version, serial,
manufacturer and model** it sits **directly below the Polaris Agent**, above
vCenter and above every directory source. It reads the *running* OS and live
SMBIOS on every check-in.

---

## Configuration

Arc has **no host, port or TLS field** — the endpoint is fixed to
`management.azure.com`.

| Field | Default | |
|---|---|---|
| Tenant ID | — | |
| Client ID | — | |
| Client secret | — | secret |
| **Use Resource Graph** | **on** | one query across every readable subscription; falls back to a per-subscription list automatically when unavailable |
| `subscriptionInclude` | — | empty = every subscription the app can see |
| `resourceGroupInclude` / `Exclude` | — | |
| `deviceInclude` / `deviceExclude` | — | machine-name wildcards |
| `tagInclude` / `tagExclude` | — | `key=value` or `key=*` lines matched against Azure resource tags |
| **Include disconnected** | **on** | |
| **Fetch network profile** | off | **one extra GET per machine** |
| **Enable VM instances** | off | |
| **Enable SQL Server** | off | |
| **Enable Kubernetes** | off | |
| **Add Azure tags to devices** (`importAzureTags`) | off | see [below](#azure-tags-on-devices) |
| Tag keys to add (`azureTagKeys`) | — | key wildcards; empty = every key |
| **Read installed software from Change Tracking** (`pullSoftware`) | off | see [below](#installed-software) |
| Log Analytics workspace IDs (`logAnalyticsWorkspaceIds`) | — | up to 20; needed for the above |
| **Allow Run Command** | off | see [below](#publishing-scripts-via-run-command) |
| Verify presence | on | |
| Workstation / Server / Kubernetes monitor blocks | — | |
| Verbose logging | off | |

Resource group and tags are **two independent axes**, so they get their own
field pairs rather than sharing the device include/exclude pair.

**Include disconnected is on by default** because a *Disconnected* agent is a
**reachability** statement, not a lifecycle one — those machines are still
assets.

### Azure side

Discovery needs only the **Reader** role. The optional enrichments are
additional Resource Graph queries under the same role. Two features need more:
installed software (**Log Analytics Reader** on each workspace) and Run Command
— see below.

---

## The optional enrichments

| Toggle | Cost | Creates assets? |
|---|---|---|
| **VM instances** | one Resource Graph query for the whole tenant | **no** |
| **SQL Server** | one Resource Graph query for the whole tenant | **no** |
| **Kubernetes** | one query | **yes** — `kubernetes_cluster` assets |
| **Network profile** | **one GET per machine** — concurrency-capped and deadline-bounded | no |

The first two fold into the owning machine's observed blob. They are off by
default so an existing integration keeps its current blob shape until you opt
in.

**VM instances** is the one with a second purpose: Arc-enabled VMware and SCVMM
placement also supplies the **instance UUID**, which is what **deduplicates an
Arc machine against a [vCenter](Integration-vCenter) integration**. If you run
both, turn it on.

**Kubernetes** is the exception that **changes the fleet** — connected clusters
become real assets. They take the reduced monitor block (add-as-monitored and
streams only), because a cluster runs no Polaris Agent and reports no interfaces
or mounts.

---

## Azure tags on devices

Every machine's and cluster's Azure resource tags are always recorded on its
Arc source (the **Azure Tags** row of the asset's sources). Turn on **Add Azure
tags to devices** and they also become ordinary Polaris tags, named
`azure:Key=Value`. For example, `DefenderPlan = P1` in Azure becomes
`azure:DefenderPlan=P1`. A tag with no value becomes `azure:Key`.

**These tags are hidden everywhere in the UI.** No tag picker, filter, list,
pill or the Server Settings → Tags tab shows them, so nobody can put an Azure
tag on a device whose Arc resource does not carry it. Editing an asset keeps
the ones it has, and Polaris ignores an `azure:` tag sent by any asset edit,
bulk **Tags** change or API call. The **Azure Tags** row of the asset's Arc
source is where you see them; change them in Azure.

- **Polaris keeps them in step with Azure on every discovery run.** A tag you
  change or remove in Azure is changed or removed here. Turn the toggle off and
  the next run removes them all.
- **Tags you add by hand are never touched.** Only `azure:` tags are managed.
  For the same reason, Polaris refuses a hand-made tag whose name starts with
  `azure:`, a rename of one of the mirrored tags, and an auto-assign filter on
  one. Change the tag in Azure instead.
- **Tag keys to add** limits which keys are imported (one per line, case
  ignored, wildcards like `Cost*` allowed). Leave it empty to import every key.
  Use the list when your tenant has tags whose value is different on every
  machine, such as a creation date or an owner email. Otherwise each machine
  adds its own entry to the tag list.

This is separate from the **Tag filter**. The filter decides which machines are
discovered at all; this setting decides whether their tags are copied onto them.

---

## Installed software

Turn on **Read installed software from Change Tracking** (the *Installed
Software* section of the General tab) and each discovery run fills the
**Software** tab ([Assets](Assets)) of every Arc machine with its installed
programs and versions.

Polaris does not inventory the machines itself here. It reads what **Azure
Change Tracking & Inventory** has already collected into a Log Analytics
workspace (the `ConfigurationData` table). Before turning this on:

1. **Change Tracking & Inventory must be enabled** for the machines, with its
   data going to a Log Analytics workspace. A machine Change Tracking does not
   cover has no list.
2. **List the workspaces** in **Log Analytics workspace IDs**, one per line, up
   to 20. Use the **Workspace ID** GUID from each workspace's *Overview* page,
   not its Azure resource ID.
3. **Grant the app registration Log Analytics Reader** on each of those
   workspaces, in addition to the Reader role discovery already uses. Without
   it the read fails with a message naming the missing role, and the machines
   keep whatever list they had.

What to expect:

- **Up to three days of lag.** Change Tracking reports software periodically,
  and Polaris reads the last three days of it, so a program you uninstalled can
  stay on the list for up to three days. Windows updates are left out.
- **Runs on full discovery only.** It is one query per workspace (plus one per
  100 machines), so **Discover Now** on a single machine does not refresh it.
- **A machine that drops out of Change Tracking loses its list**, but only
  when every workspace was read successfully. If any workspace read failed,
  every machine keeps its list until the next good run. Failures appear in the
  run's log under *discover.arc.software*.
- **A machine with a Polaris Agent shows the agent's list first.** The Arc list
  is still kept and can be chosen from the tab's source picker.
- Turning the option off, or clearing the workspace list, removes the Arc lists
  on the next run.

---

## Per-class blocks

Arc deliberately reuses the **`workstationMonitor`** and **`serverMonitor`**
blocks verbatim, so every downstream registry that keys on the block name works
unchanged. Plus `k8sMonitor` for connected clusters.

The workstation and server blocks carry the full set: add-as-monitored,
per-stream polling and credentials, **agent auto-deploy**, and **interface
auto-monitor**. (Storage auto-monitor is AD/Entra only.)

---

## Publishing scripts via Run Command

**`allowRunCommand`**, off by default, with its own **Script Publishing** tab.

It dispatches the generated [SSH onboarding scripts](Polaris-Agent#ssh-deployment)
to Arc machines via Azure **Run Command**. It is the **only vehicle that reaches
Linux, or Windows Server** — Intune manages neither.

> **Arc has no inert state.** Unlike an Intune Remediation, which can sit
> unassigned, **a run command executes on creation.** So the review gate is the
> operator's own target selection:
>
> - **no "all machines" affordance** — you pick targets explicitly;
> - ids are **re-resolved against the live roster** before dispatch;
> - a **200-target cap**;
> - a machine whose OS cannot be determined is **skipped, never guessed**.

Its grant is an **Azure RBAC role assignment** carrying
`Microsoft.HybridCompute/machines/runCommands/write`, assigned at a subscription
or resource-group scope — **not** a Graph API permission like the Intune side.

The route carries a **chained** gate: `fullwrite` on **both**
`serverSettingsSystem` **and** `integrations`. The blanket `integrations:write`
on that router must not confer tenant writes.

---

## Decommissioning

**Azure Arc never writes `status` at all.** There is no absence pass, and no
disabled flag is consulted.

A machine that leaves Azure simply stops having its Arc source row refreshed. If
nothing else claims the asset and a **vCenter** integration also covers it,
vCenter's own [disappearance sweep](Integration-vCenter#the-disappearance-sweep)
may then decommission it — but Arc itself will not.

---

## Troubleshooting

| Symptom | Look at |
|---|---|
| The same host appears as an Arc asset **and** a vCenter VM | turn on **VM instances** — the instance UUID is what deduplicates them |
| Arc's OS overrode what AD said, and you expected the reverse | that is correct. Arc reads the running OS in-guest; AD's `operatingSystem` lags until the computer object re-registers |
| Discovery is slow on a large tenant | **Fetch network profile** is one GET per machine. Turn it off unless you need it |
| Resource Graph returns nothing | it falls back to a per-subscription list automatically — check `subscriptionInclude` and the app's readable scope |
| Run Command is refused | the RBAC role assignment is missing, or the route's chained `serverSettingsSystem:write` is |
| A machine's **Software** tab is empty | Change Tracking must cover the machine and send to one of the listed workspaces, and the app needs **Log Analytics Reader** on that workspace — the discovery log's *discover.arc.software* line says which |
| A machine shows as an asset despite being disconnected | that is the default. **Include disconnected** is a reachability statement, not a lifecycle one |
