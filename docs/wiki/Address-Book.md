# Address book

**Automations → Address Book.** Who Polaris can reach, and which devices each
person is responsible for.

Gated by `contacts:read`. The three mutations carry the **ownership
dimension** — at `write` you edit and delete only rows you created; `fullwrite`
reaches anyone's.

The tab shows the same two panes the wizard's recipient picker opens, minus the
selection checkboxes and the Add-to-To/Cc/Bcc footer.

---

## The People pane

A **source tab strip**: **All** / **Polaris users** / one tab per directory /
**Manual**.

Each tab is its **own query**, never a client-side filter over one merged list.
The contacts half is paginated, so filtering 50 mixed rows down to the synced
ones would show a fraction of them and call it the directory. It also keeps each
tab honest about cost — Manual asks the directory nothing, and Polaris users
never fans out to the GAL.

The directory tabs come from the list payload and are named after the
integration. They are withheld from anyone who may not see synced rows.

### Columns

| Column | |
|---|---|
| Name · Email · Description · Source | the shared cells |
| **Responsible for** | the contact's **device filter** |
| **Push devices** | how many browsers a Polaris **account** has enrolled |
| Added by | the creator, or *Directory sync* |

The two device columns are deliberately distinct. "Responsible for" was once
called *Devices*, which read as "this person's devices". **Push devices** is the
same cell the wizard's push picker renders, shown only on tabs where an account
can appear, with **zero called out in the warning colour** — "none" is the most
common reason a push automation delivers nothing.

Search and pagination are **server-side**, so a synced GAL cannot make opening
the page cost the whole table. The "showing N of M" hint reads the unpaged
total rather than inferring truncation from a full-looking array.

---

## A contact

**+ Add contact**, or Edit on a row you own.

| Field | |
|---|---|
| Email | required; one mailbox is one row |
| Name | |
| Description | operator-owned |
| **Device filter** | an **"All devices" checkbox, default checked** |

Unchecking the checkbox reveals the same nested AND/OR condition builder the
automation wizard's Devices step uses, over a wider device vocabulary, with a
seeded starter row and a debounced live "devices covered right now" preview.

> One difference in what an **empty** builder means. For an automation it is a
> validation error — a rule must select something to be worth saving. For a
> contact it is simply *no filter*: only the explicitly pinned devices, which is
> the address-only state most contacts are in. Reach it by removing the seeded
> row. A row left **blank** is still refused.

### What the filter is for

The wizard's **"Asset's Responsible Contacts"** recipient pill. It names no
address but a rule: *whoever is responsible for the device this alert is
about*. That resolves through these filters at fire time.

It is email-only, and To-only.

---

## Directory-synced contacts

Where an Entra ID or Active Directory integration has **directory sync** turned
on, the roster appears here as `Contact` rows.

A synced row:

- **Badges as its backend** and shows *Directory sync* in Added by.
- Falls back to `jobTitle — department` when it has no description — derived at
  **render** time, never stored, because writing it would put it in the
  operator-owned description column where the next sync would look like it had
  overwritten your text.
- Offers **Adopt** in place of Edit / Delete. A delete would be undone on the
  next run, so the honest verb is the one that takes ownership. Adopt needs
  `contacts:fullwrite`, which falls out of the existing gate with no special
  case, since synced rows are unowned.

### What sync guarantees

Five invariants ([rule 35](Business-Rules#rule-35)):

1. **Provenance decides deletion.** Every (integration, directory object) the
   sync created is recorded, and a contact dies only when its **last**
   provenance row goes. A hand-added row has none and is never touched — which
   is also why Adopt drops provenance.
2. **A Polaris user or a manual contact on an address wins.** The sync never
   creates over either, and an account created later retires the synced row on
   the next run.
3. **An empty or catastrophically shrunken read never wipes.** Zero entries, or
   a delete set over the guard, skips the deletion half and warns — a revoked
   grant must not empty your address book.
4. **Synced entries are gated on `automationManagement`**, not `contacts:read`,
   and so is the live GAL fan-out. Gating one and not the other leaves the
   roster reachable a query at a time.
5. **No directory PII reaches Events or the logs.** The run Event carries counts
   only, because Events are readable by anyone with events access and are
   shipped off-host by the archivers.

Switching the toggle off — or disabling or deleting the integration — **purges
what it created**.

> **Before you turn sync on:** it puts employee names, addresses, titles,
> departments and phone numbers in your database **and in every backup**. That
> is why it is off by default, and why it is a deliberately separate toggle
> from directory *search*, which reads the same data and stores none of it.

---

## The Tags pane

Read-only. Every tag an automation can route to, and the users each reaches.

Two sources, deliberately kept apart because they match differently at fire
time:

| Source | Routes through | Matches |
|---|---|---|
| **Map regions** | the region resolver | `User.regionTags` only |
| **Tag registry** | the general recipient resolver | the flattened region ∪ other scope |

Every row reads *"`<name>` Users"*, because what you are picking is the people,
not the label. The **Source** badge is what tells a Region from a Tag.

Regions carry a derived **Level** — L1 is an innermost region, and each level
above contains the one below — so the list says which rows are local teams and
which are the divisions over them. A region the catalogue could not level, and
**every registry tag**, shows an em dash, never "L1": that would be a claim
about how the map is drawn.

---

## The picker

The same two panes open from a notify action's recipient fields.
Differences:

- Checkboxes and an **Add to To / Cc / Bcc** footer.
- Two **dynamic** entries sit **above** the results rather than in them — a
  query matching nobody must still leave the standing option on screen:
  - **Asset's Responsible Contacts** heads **People**.
  - **Asset's Region Users** heads **Tags**, alongside one *Asset's L\<n\>
    Region Users* entry per nesting level (offered only once regions actually
    nest).
- Opened from a **push** box it runs in push mode: a Push devices column, no
  checkbox on rows push cannot reach, no Responsible-Contacts entry, no
  "+ New contact", and a To-only footer.

Selections are keyed so that a People selection survives a look at Tags.
