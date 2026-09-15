# Network Discovery (active scan)

A **Discovery** is a saved sweep of IP ranges you name. It is the only Polaris
feature that touches hosts it has **no prior relationship with**, so the posture
matters more than the mechanism ([rule 34](Business-Rules#rule-34)).

| Gate | Grants |
|---|---|
| `networkScan:read` | browse the Discoveries you can see, and watch a run |
| `networkScan:write` | create, run, import, and edit/delete **your own** |
| `networkScan:fullwrite` | edit and delete anyone's |
| **plus `assets:write`** | **required, chained, to adopt** what a scan found |

Seeded `admin:fullwrite`, `readonly:read`, `networkadmin`/`assetsadmin`:`write`,
and **`user:none`** — that role exists for IP-space self-service.

---

## Scanning and adopting are separate grants

This is the whole permission design. **Running a Discovery creates nothing.** So
a role may be allowed to find out what is on a range without being allowed to
put it in inventory.

The wizard **renders** the missing grant rather than discovering it at the POST,
so you find out before you have filled in the form.

---

## What it is not

- **Not an eighth integration type.** It creates no `Integration` row and no
  discovery run row.
- **No `network-scan` source kind.** An adopted asset carries the source of
  whatever answered it, not "a scan found it".
- **No scheduler.** There is no recurring sweep, and no shipped default range.
  You run it when you mean to.

It is **opt-in and IDS-visible**, and that is stated where you use it.

---

## The wizard

Name → targets → credentials → run → results → adopt.

### Targets

Typed as ranges, CIDRs or single addresses. **Preview targets** resolves what
you typed with no packets sent, and reports how many of those addresses
inventory already carries.

### Credentials

You supply an ordered list. **Credential order is the try order**, and the first
method that answers wins. That is what lets one sweep cover a mixed estate
without you classifying it first.

### Running

A run is started with a 202 and its own row — the sweep takes minutes, and the
wizard watches that row. You can leave and come back: the Discoveries list shows
each one's newest run, which is also the reattach path. A run can be cancelled.

### Adopting

**New addresses only.** A re-run **enriches nothing** — which is deliberate, so
that *"nothing new"* stays distinguishable from *"nothing there"*.

---

## Private or shared

Every Discovery is **private by default**. Visibility decides who may **see and
run** one; ownership decides who may **edit** it.

| | |
|---|---|
| See / run | anyone the visibility admits — running a shared Discovery is what publishing one is *for* |
| Edit / delete | the owner, with `networkScan:fullwrite` reaching anyone's |
| An invisible row | answers **404, not 403** |
| Name | unique per owner |
| Existing rows at migration | made public; new ones default private |
| Export | carries **no visibility at all** |

Note that publishing deliberately costs nothing above `write` — unlike saved
filters and dashboards. Sharing is the feature, and the roles that author
Discoveries hold `write`, not `fullwrite`.

---

## Import and export

A Discovery travels as a `.discovery.json` file. Route schemas are **shape
only**; the semantic rules live in one validator, because an imported file has to
pass exactly the same checks a form does.

---

## Before you run one

Three things worth settling first:

1. **Tell whoever runs your IDS.** An unannounced sweep of a range is exactly
   what they are watching for, and this is the feature most likely to generate a
   ticket about Polaris rather than from it.
2. **Scope it narrowly.** There is no default range on purpose.
3. **Decide who may adopt.** Scanning is reversible; putting two hundred rows in
   inventory is a cleanup job.
