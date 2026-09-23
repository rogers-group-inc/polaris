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
additional Resource Graph queries under the same role. Run Command is the one
that needs more — see below.

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
| A machine shows as an asset despite being disconnected | that is the default. **Include disconnected** is a reachability statement, not a lifecycle one |
