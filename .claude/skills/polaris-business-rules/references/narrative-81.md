# Business rule 81 — full narrative

> New file rather than an append to `narrative-80.md`: the 60–64 file hit the 1500-line
> reference ceiling on 2026-09-21 and the split-per-rule pattern started there. Rule numbers
> are a stable citation key — never renumber.

Verbatim from BUSINESS-RULES.md: each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 81](#rule-81) — A discovery run that read a device is authoritative about that device's address, including when the answer is "it has none"

<a id="rule-81"></a>

## Rule 81 — A discovery run that read a device is authoritative about that device's address, including when the answer is "it has none"

Every projection-driven discovery update path was written the same way:

```ts
if (projected.hostname !== null) updateData.hostname = projected.hostname;
if (projected.model !== null)    updateData.model    = projected.model;
if (projected.ipAddress !== null) updateData.ipAddress = projected.ipAddress;
```

Blank-fill. A field is written when discovery has something to say and skipped when it does
not. For `hostname` and `model` that is obviously right — a run that could not read the model
should not erase the model. The same line applied to `ipAddress` says something quite
different, and nobody noticed the difference because the line looks identical: **an address can
be added or changed, and never removed.**

So a stale address is permanent. The three ways it happens are all ordinary:

- a FortiSwitch is moved into a new management VLAN and re-addressed;
- a VM's NIC is removed, or the guest stops answering on the address it used to hold;
- a FortiGate's management interface is renumbered during a site refresh.

In each case discovery reads the device on the very next cycle, gets no address for it, skips
the write — and the asset goes on displaying the old one indefinitely.

### Why a stale address is worse than no address

`Asset.ipAddress` is not a display field. It is treated as fact by everything downstream:

- the response-time probe **dials it** every cadence;
- the charts and the asset list **label the device by it**;
- the IP panel **lists it** against the address;
- `findSubnetForIp` **files the asset into a subnet** by it.

Once the address has been handed to another device — and in a DHCP range or a re-used
management VLAN it will be — all four of those are now describing somebody else's box under
this asset's name. Polaris draws a healthy response-time line for a device that is gone, and
an operator reading the IP panel is told an address is held by a device that no longer has it.
Showing nothing would have been strictly more truthful than showing the old value.

### The fix is one helper, and the danger is the argument it takes

All six sites now call `utils/assetProjection.ts:applyProjectedIp`, which writes the address
when there is one and stages `ipAddress: null` **and `ipSource: null`** together when there is
not. The provenance goes with the value deliberately: a row reading `ipAddress: null,
ipSource: "fortimanager"` claims FortiManager told us this device has no address, which is not
what happened, and the Sources tab renders that claim.

The whole risk in the change is that **a null projection means two different things**:

- the run READ the device and neither it nor any other source of this asset supplies an
  address — the device genuinely has none;
- the run did NOT read the device — an offline gate served from cache, a disconnected host, a
  guest that never answered.

Treating the second as the first is a fleet-wide outage, not a cosmetic bug. One FortiManager
hiccup, two hundred gates reported offline with no address, and a single discovery pass empties
the address off all two hundred — after which every probe fails with `Asset has no IP address`
and stays failing, because the thing that would restore the address is the discovery run that
just removed it. The asymmetry is worth stating plainly: **a wrongly-kept address is a stale row
someone can correct; a wrongly-stripped one takes monitoring down.**

That is why `readThisRun` is a required argument with no default. The function will not guess,
and a new call site cannot quietly inherit the dangerous answer.

### Each caller already held the signal, and each one is a different fact

None of this needed new plumbing except in the two places where the obvious signal is wrong.

| Path | `readThisRun` | Why that one |
|---|---|---|
| FortiGate firewall | `!memberDevice.offline` | An offline gate's payload came out of **FortiManager's cached CMDB**, not the device. The same flag already gates `bumpLastSeen` here for the identical reason (business rule 12) — a cached read is not presence, and it is not an address statement either. |
| FortiSwitch | `sw.connected` | A disconnected managed switch is a row in the parent gate's roster, not a device that answered. |
| FortiAP | `apOnline` | As above; already the flag gating `bumpLastSeen`. |
| ESXi host | `connected` | A disconnected host is reported from vCenter's own records, and its `resolvedIp` comes from resolving the host's vCenter name in DNS — a failure there is ours. |
| vCenter VM | `guestIdentityRead` | **New flag.** See below. |
| Azure Arc | `fetchNetworkProfile === true` | See below. |

**The vCenter VM trap.** `guestIp` comes from VMware Tools, and gating on `poweredOn` would
have stripped the address off every powered-on VM whose Tools are stopped, outdated, or still
booting — a large fraction of a real estate, all at once, on the first run after the upgrade.
`toolsRunState === "RUNNING"` is closer but still wrong, because that state comes from a
*separate* API call which can succeed while the guest-identity call fails; the identity call's
error is swallowed by design (`catch { /* null */ }`, each guest surface degrading alone). So
`DiscoveredVcenterVm` gained `guestIdentityRead`, set immediately after the identity request
returns and before its fields are read — what it records is that the guest **answered**, which
is true whatever it answered with. A running guest reporting no address is precisely the case
this rule needs to tell apart from a call that never came back.

**The Arc trap.** `ipAddresses` is populated only when the integration's `fetchNetworkProfile`
toggle is on, and it is **off by default** because it costs one extra GET per machine. With it
off, every Arc machine projects a null address on every run — not because the machine has none,
but because Polaris never asked. Stripping there would have emptied the address off every
Arc-discovered asset on every sync, on the default configuration.

### What the rule deliberately does not touch

**Endpoints.** The DHCP/ARP paths (Phase 6/7) write an address only when they have a winning
lease or inventory entry, and never ran a projection blank-fill at all, so they are untouched:
a laptop that was powered off and missed the lease table keeps its address. This falls out of
the existing design rather than needing a carve-out, which is the right reason for it — "no
sighting this cycle" is the normal state for an endpoint and could never have been an address
statement.

**Operator pins.** `Asset.ipOverride` gets no special case here, because it already has one
that is stronger: the Prisma extension in `src/db.ts` re-asserts a pin over any write staging
`ipAddress`, and a staged null is re-asserted silently with no conflict raised. A human who
typed an address into the edit form has already overruled discovery about this exact field, and
a strip must not be the one write that gets past that.

**The HA standby.** The FortiGate path's unconditional `ipAddress: null` for a non-primary
cluster member predates this rule and is left exactly as it was. That address is absent **by
role** — only the active member holds the cluster IP — which is a statement about the cluster,
not evidence about a device, and it must keep firing whether or not the run reached anything.

### The multi-source property that makes this safe

One thing makes the whole change far less dangerous than it first reads: the projection runs
over **all** of an asset's `AssetSource` rows, not just the one the current run refreshed. A
null projection therefore already means "no source of any kind has an address for this device",
not "this integration did not report one". A server carrying `vcenter-vm` + `ad` +
`fortigate-endpoint` rows does not lose its address because vCenter went quiet — the endpoint
sighting still answers, and the write is an ordinary update. The strip only reaches an asset
whose every source has gone silent on the question, which is the population the rule is aimed
at.
