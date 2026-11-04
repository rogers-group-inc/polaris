# Business rule 141 — full narrative

> Written 2026-11-04 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 141](#rule-141) — A dangerous act is its own key, a tag is an administrator's grant, and a role carries no tags

<a id="rule-141"></a>

## Rule 141 — A dangerous act is its own key, a tag is an administrator's grant, and a role carries no tags

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

**What release 2 adds (planned, `~/.claude/plans/i-feel-like-we-imperative-lemon.md`):** the
`tagScoped` dimension on the asset-side keys, `writeScopeService`, the lift migration,
per-row `canEdit` flags, the UI's out-of-scope states, and the DHCP conflict rule (visible at
`discoveryConflicts:read`, resolvable at `reservations:write` when at least one binding is
in scope). Those land as further lettered clauses of this rule.

Pinned by `tests/unit/dangerousActKeysRbacLockstep.test.ts`,
`tests/unit/roleUpdateAbsentKeys.test.ts`, `tests/unit/tagPickerNonAdminRole.test.ts`,
`tests/unit/dashRoleSnapshotService.test.ts`, `tests/unit/regionScopeRename.test.ts`,
`tests/integration/agentDeployGrant.test.ts`, `tests/integration/integrationTokenTarget.test.ts`
and `tests/integration/operatorInputInjection.test.ts`.
