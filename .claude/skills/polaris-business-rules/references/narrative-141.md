# Business rule 141 — full narrative

> Written 2026-11-04 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 141](#rule-141) — A dangerous act is its own key, a tag is an administrator's grant, a role carries no tags, and Read-Write reaches what you own or what carries your tags

<a id="rule-141"></a>

## Rule 141 — A dangerous act is its own key, a tag is an administrator's grant, a role carries no tags, and Read-Write reaches what you own or what carries your tags

**What prompted it (2026-11-03).** The owner asked whether resolving a DHCP
duplicate-reservation conflict had RBAC, and whether it could be regional: "could we say
that asset write permissions means that user's region allows them to resolve the conflicts
that exist for their region?" The review that followed found that region and other tags were
used only to route alerts — never as access control — and that Read-Write on every asset-side
key meant "any record". The owner then redefined Read-Write for those keys: with no tags it
reaches only what you own (added by hand, or adopted from your own Network Discovery); with
tags it reaches what you own plus every record carrying one of your tags; Full Read-Write
reaches everything, everywhere. That is **release 2** of the change and is not shipped yet.

This rule is **release 1**: what had to land first so release 2 can lift stored `write` to
`fullwrite` without handing anyone a dangerous act, and what the tag model demanded once a tag
became write reach.

**(a) A dangerous act is its own key.** Merging any two assets (`assetMerge`), deploying the
Polaris Agent (`agentDeploy` — install / retry / reinstall / upgrade / uninstall, bulk
install, an integration's auto-deploy toggle, the agent host's reboot opt-in, the process
log-path glob) and clearing an alert (`alertClear`) were the Full Read-Write rung of `assets`
and `alerts`. Release 2 turns that rung into *reach* and lifts every stored `write` to it, so
the acts left the rung first, each as a `none | write` key, seeded by migration
`20261103170000_dangerous_act_keys` onto exactly the roles that held the rung. Nobody gained
or lost an act on update day, and old code — which drops unknown keys — reads a migrated
matrix as it always did, which is what makes the updater's old-process-on-a-failed-install
window safe (rule 43's reasoning, applied to a split rather than a fold).

**(b) A tag is an administrator's grant.** The owner, asked who may put a tag on a record
once a tag is write reach, answered: "editing and assigning tags will end up being a full
read-write thing that admins do since anyone below that could give themselves permissions to
assets they shouldn't have." So the registry (create, rename, recolour, delete, auto-assign
filters, the enforce setting — moved out of `serverSettingsSystem` into `routes/tags.ts`) AND
putting a tag on, or taking one off, ANY record ride one key, `tags` (`none | read | write`).
`assertTagChangeAllowed` (`api/middleware/permissions.ts`) is chained at every route that
accepts a tags array — assets create / update, bulk tags, port tags, networks (create,
next-available, bulk-allocate, update), blocks, `PUT /users/:id/regions`, group mappings — and
judges a CHANGE (sets compared case-insensitively, `azure:` left out), never a round-trip, so a
form that may not tag posts the record's tags back unchanged: the shared `tagFieldHTML`
renders static chips with hidden checked inputs below `canManageTags()`. Read is the floor on
every built-in (the pickers draw colours from the registry); only `admin` holds write. This is
the one deliberate narrowing of release 1: `assetsadmin` and `networkadmin` could tag devices
at `assets=write` and cannot until granted Tags.

**(c) A role carries no tags.** Reviewing the role slide-over, the owner saw a Region Scope
picker beside a Tags picker that listed the same regions again and said: "i don't think i
want to apply tags for the roles, perhaps tags should only live on assets and on users and
groups." A role says what a person may DO; a tag says WHICH records. `Role.regionTags` /
`otherTags` are dropped (`20261103180000_role_tags_dropped`) and — the owner's choice over a
migration unioning them onto holders — NOT carried anywhere: a user whose scope came only
through a role is unrestricted for routing until an administrator assigns tags on the account
or its group mapping. Effective scope is `union(user, group-derived)`; `/auth/me`'s scope
objects have no `role` key; the Group Mappings editor uses the Users dialog's single picker
(regions as their registry tags, split back on save); the Dash wallboard — whose scope came
from the protected `readonly` role's tags, which nothing in the UI could set — is unrestricted
by construction.

**(d) A posted matrix never revokes by omission.** `roleService.updateRole` keeps a key ABSENT
from the posted matrix at its stored level, and `roles.ts` judges admin-equivalence on the
merged matrix: a browser holding a `users.js` cached from before a migration added a key
would otherwise post the old 35 keys and zero the new ones on any unrelated edit. Revoking is
still a statement — post the key at `none`.

**Rejected alternatives.** Posture A (no migration; let write roles narrow on update day and
tell admins to raise them) — breaks every existing install until someone acts. Carrying a
role's tags onto its users at drop time — rejected by the owner. "Only tags you hold" as the
assignment guard — the owner chose the simpler and stricter rule above. Per-record keys for
the acts stayed as few as three because each names one act and nothing else.

**(e) Read-Write reaches what you own or what carries your tags (release 2, 2026-11-04).**
The owner's three tiers, stated in the first session and corrected once: "a user in a role
with write permission should have less privileges than one with tags. so they should only
have access to things they own and that's going to severely limit them. if they run a
network discovery then new assets they discover that way or through adding an individual
asset will give them write access to those things." Tags only widen; an unowned, untagged
record is Full Read-Write only; a scan that hits a device Polaris already has never changes
that device's owner (adoption skips known addresses). `services/writeScopeService.ts` is
the one judge, consumed by `middleware/writeScope.ts` on the asset routers and inline on
alerts, maintenance, conflicts, reservations, subnets and the map; every list and detail
payload carries the verdict per row so the pages offer only the verbs that will succeed.
The two tag dimensions are compared separately — the recipient index's own comment admits
the "Atlanta" collision a pooled set invites. Posture B for existing installs: migration
`20261104100000_write_scope_lift` raised every stored `write` on the seven newly scoped
keys to `fullwrite`, so the day the update lands nobody can do less than the day before;
an administrator opts a role into the model by lowering it to Read-Write and assigning
tags on the account or its group mapping. That lift is only safe because release 1 moved
merge, deploy and clear off that rung first — the updater runs the migration before
restarting and keeps the OLD process on a failed install, and old code reading a lifted
`fullwrite` would otherwise have handed every write role those acts.

Reviewer findings folded in before implementation: the automation `reboot` action and
a maintenance window with a device FILTER act on whatever matches later, so there is no
record to be "in" — both Full Read-Write; the conflict verbs that NAME an asset in their
body (`reassign-ip`, `clear-ip`, reactivating a decommissioned agent) judge that asset,
not "any member"; a bulk verb checks every row before writing any; a grouped alert is
reachable through any member device (the owner's call); an alert with no device is Full
Read-Write only (`Notification` has no path-check column); `POST /subnets/:id/refresh`
had no row check at all and now takes the same one as an edit.

**(f) The DHCP duplicate-reservation conflict is a reservations task.** Where the whole
session began: "a user can see the conflict and resolve the conflicts as long as at
least 1 entry is in their region ... they can still see the entries for the other region
and push dhcp revoke or release to other gates that aren't necessarily part of their
region." The card is visible at `discoveryConflicts:read` (the built-in `user` role holds
that, and `reservations:write`, so it can finally act); Keep / Release / Revoke lease take
`reservations:write` with at least one binding in scope, and the per-row ownership
callback the services accept is a no-op once that holds — every binding may go, on any
gate. The owner chose `reservations:write` over `assets:write` for the act because
releasing a reservation is what `DELETE /reservations/:id` does and that rides the
reservations key everywhere else.

**Known limitations, by design:** email / push Acknowledge buttons are rendered on the
ROLE's level (`notificationRecipientService.canAcknowledge`), so a recipient outside the
device's scope sees the button and gets a 403 — a per-recipient render is a follow-up;
alert READS stay regions-only with the admin bypass (reads untouched by this rule, other
tags do not filter the list); a token owns rows under its NAME (`api:<name>`), so renaming
a token orphans them; the stale-reservation Snooze / Free buttons stay at role level
(their click 403s on an out-of-scope record rather than hiding); lifted roles gained
ownerless saved-filter housekeeping (rule 140).

**The phone matches the desktop (2026-11-04).** The phone's asset sheet and edit menu
(`public/js/mobile/asset-detail.js`, `asset-edit.js`) read the same per-device verdicts
through a local `scopedVerb` mirroring app.js `_scopedVerb`: General / Monitoring /
Discover Now / Reboot / firmware on `canEdit`, Release Quarantine on `canQuarantine`,
Enter maintenance on `canMaintain`; the alert lists (`alerts-tab.js`, `alerts.js`) on each
row's `canAcknowledge` / `canClear` (the asset sheet's "Acknowledge all" batches only the
reachable ones, since the route refuses a batch with one out-of-reach id); reservation
Edit / Free on the row's `canEdit` (`reservation-actions.js → canModify`). Two payloads
gained verdicts for both screens: `GET /assets/:id/maintenance-info` carries
`canMaintain` and each covering schedule's `canEdit` (`writeScopeService →
scheduleCanEditByIds`, the same rule `GET /maintenance-schedules` uses through
`scheduleCanEditMap`), and `GET /subnets/:id/ips` carries the network's `canEdit` and each
reservation's. The network's Discover (`POST /subnets/:id/refresh`, `requireOwnership("subnets")`)
was offered on `reservations:write` on both screens — a button that only 403'd for a
reservations-only role; it now reads the network's verdict (`canEditSubnet` on the desktop
panel, `canRefresh` on the phone).

Pinned by `tests/unit/dangerousActKeysRbacLockstep.test.ts`,
`tests/unit/roleUpdateAbsentKeys.test.ts`, `tests/unit/tagPickerNonAdminRole.test.ts`,
`tests/unit/dashRoleSnapshotService.test.ts`, `tests/unit/regionScopeRename.test.ts`,
`tests/unit/writeScopeService.test.ts`, `tests/unit/writeScopeLiftRbacLockstep.test.ts`,
`tests/integration/agentDeployGrant.test.ts`, `tests/integration/integrationTokenTarget.test.ts`,
`tests/integration/operatorInputInjection.test.ts` and `tests/integration/writeScope.test.ts`.
