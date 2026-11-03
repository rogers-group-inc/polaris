# Business rule 140 — full narrative

> Written 2026-11-03 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 140](#rule-140) — A saved folder, filter or dashboard belongs to its owner — a user, a role, a region, or nobody — and only the owner manages it; a disabled or deleted account owns nothing

<a id="rule-140"></a>

## Rule 140 — A saved folder, filter or dashboard belongs to its owner — a user, a role, a region, or nobody — and only the owner manages it; a disabled or deleted account owns nothing

**What prompted it (2026-11-03).** The owner asked, in order: "table filters, i need to be
able to create folders, nested folders to save filters to"; then "i need the same folder
mechanism for dashboards"; then, once folders were drawn, "don't allow someone to delete a
public folder unless they're the owner. if a user created a folder or dashboard or filter and
then their account is disabled or deleted then remove them as the owner and then it becomes
ownerless and then only admins or RBAC roles of full read-write can edit them. Allow the owner
to adjust ownership of a folder, dashboard, filter. change it to a role or region or another
users. need a warning message when making that change." And finally: "an owner or full
read-write can also make something private for them".

**Decisions taken with the owner (2026-11-03), each a question put and answered:**

- *Folders are shared like filters* — a folder is Private or Public, with an owner; a team can
  publish an organised set. (Rejected: personal-only folders; personal folders that file
  anyone's public items, which needs a per-user placement table.)
- *Collapsible tree inside the existing dropdown*, not cascading flyouts (deep nesting runs off
  screen and is poor on touch).
- *Filing by a folder picker on Save and by drag and drop*; no per-row Move verb.
- *Saved dashboards behave exactly like filters*: a row click loads into the current tab, ⊞
  opens a new tab, and the Dashboards ▾ menu shows in view mode too.
- *Polaris had no "disabled account"*: the owner chose to ADD one (Users → Disable account)
  rather than read "disabled" as "deleted".
- *A removed owner's PRIVATE items are deleted* (today's behaviour for a deleted user, kept for
  disable), *public ones become ownerless*. (Rejected: keeping private items ownerless for
  fullwrite to adopt.)
- *A region owner is the users whose scope names the region*; unrestricted users (empty scope,
  i.e. every region) do not count — otherwise a region-owned item is editable by every
  unrestricted operator, which is nearly everyone on a small install.
- *Owner-only delete covers all three*, not only folders: one rule everywhere.
- *"Make private to me" is a take-over*: the owner or a fullwrite holder makes the item their own
  private item. Pointed out to the owner before building: fullwrite can therefore take an owned
  public item and then delete it; the Event is the trace. They accepted it.

**Why fullwrite stopped deleting owned public rows.** Before this, `<key>:fullwrite` deleted
anyone's preset or dashboard as "housekeeping". The owner's ask is that a published item is its
owner's to remove. Housekeeping is still possible — for what has no owner (a departed account's
public items), which is the case housekeeping existed for — and anything else goes through the
logged take-over, so removing a colleague's work is never silent.

**Why "ownerless", not reassigned.** Disabling or deleting an account cannot pick an heir. An
ownerless row keeps working for everyone who used it (a published dashboard may be on a
wallboard right now) and keeps `ownerName`, so the menu reads "was <name>"; a fullwrite holder
decides what becomes of it — Change owner, take it, or delete it.

**Why the disable gate sits in `stampLoginSession`.** It is the one function every sign-in path
reaches its session through (password, the TOTP and password-change steps, both passkey
ceremonies, SAML, OIDC, LDAP, Entra App Proxy) — a deployment-shape rule: Polaris supports five
auth paths and a gate on one is a gate on none. It refuses only after the credential checks
out, so a wrong password does not learn that the account is disabled. The disable route revokes
sessions itself; `sessionRevalidate` is the backstop for anything that slipped past. A disabled
admin-equivalent account no longer counts toward the last-admin guard — it controls nothing.

**Folders.** Each row keeps its own visibility because the alternative (a folder's visibility
governs its contents) would let one private folder hide a colleague's public filter. A viewer
who cannot see an item's folder sees the item at the top level, and the server nulls the folder
id so no invisible folder's id leaks. Deleting a folder moves what it held up a level: the
contents may belong to other people.

**Folders ride in the item lists.** `{ filters, folders }` / `{ dashboards, folders }` rather than
a folder list route, so the Dash wallboard — a GET-only, allowlisted listener — needs no new
path; folder writes are mounted under each item router and never reachable from it. The Change
owner pickers (`/owner-options`) name accounts, so that route refuses a session-less caller even
though the wallboard reaches the dashboards router.
