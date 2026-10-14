# Business rule 114 — full narrative

> Written 2026-10-13 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 114](#rule-114) — A permission reaches only what it says, and a grant never exceeds the granter

<a id="rule-114"></a>

## Rule 114 — A permission reaches only what it says, and a grant never exceeds the granter

### Where it came from

The sixth phase of the follow-up to the 2026-10-11 whole-repository security scan: ten findings (F184, F186, F199, F218, F224, F233, F247, F251, F254, F255) where a permission check was missing, a response carried more than its gate allowed, or a grant could exceed the person granting it. Each part below is one finding's fix; together they are one invariant — a key reaches exactly what its catalogue entry says, through every route that touches the same data.

### The decision, part by part

(a) **Alert groups and script actions (F184).** An alert group executes its actions exactly like an automation does, but its create / update routes skipped the `automationScripts:write` check automation rules enforce, so `automationManagement:write` alone could attach a script (code execution on the Polaris host). The rule routes' `assertScriptActionPermission` is now shared with the group routes, and groups run the rules' save-time reference checks (`notificationRuleService.assertActionRefs`) on create and update.

(b) **The asset Alerts tab (F224).** `GET /assets/:id/alerts` is `assets:read` but returned full automation rows — actions, recipients, escalation, email composition, api_call URLs and headers. A caller without `automationManagement:read` now gets `summarizeMatchingRule`: name, trigger, severity, scope, and severity bands reduced to their comparison fields. Full rows stay for callers who can read automations (the edit wizard opens from them).

(c) **Contacts created over a synced row (F233).** Creating a contact whose email belongs to a directory-synced row adopted that row and stamped the creator as owner — an act edit, delete and Adopt reserve for `contacts:fullwrite`. The create path now takes the same grant; below it, a 409 tells the caller to ask an administrator to adopt the entry.

(d) **Scoped-token quarantine (F247).** A bearer token scoped to some integrations replaced the asset's whole recorded quarantine target list with its own, erasing other sites' records that release and verify then could not find. `mergeQuarantineTargets` replaces only the in-scope entries; an unscoped push is unchanged.

(e) **Subnet Refresh ownership (F254).** Refresh stamped the clicking user as `createdBy` on the DHCP leases and reservations it imported, handing a `subnets:write` caller ownership of rows only `fullwrite` may edit or release. They are now unowned, as discovery writes them; the refresh's audit Event still names who clicked.

(f) **Utilization and reservations (F255).** `GET /utilization` is `ipBlocks:read` but carried the ten newest reservations. They are stripped unless the caller holds `reservations:read`, the split `/dashboard/summary` already made.

(g) **A grant never exceeds the granter (F199, and the owner's decision to include role assignment).** Rule 48 only refused minting admin-equivalence (users = roles = fullwrite); `roles:write` could still give a role — its holder's own included — Automation Scripts or Server Settings → Data, both code execution on the host. `permissions.assertGrantWithinCaller` refuses any key whose target level the caller's own level does not meet (`grantsBeyond`), at every place authority is handed out: `POST` / `PUT /roles` (an edit counts only the keys it RAISES, so a delegate can still rename a role that holds something they lack), `POST /users` and `PUT /users/:id/role`, API token role binding, the AI Assistant's provisioned role, and Mark reviewed (i). The admin-equivalent caller is unaffected. **Acting on** an account — resetting its password or second factors — keeps rule 48's admin-equivalent-only bar: it grants nothing, and a subset rule there would stop a helpdesk role resetting anyone more privileged than itself.

(h) **api_call headers are secrets (F251).** An api_call action's custom headers are its only way to authenticate, so in real use they hold an API key or bearer token — and they were stored in the clear, returned to every `automationManagement:read` caller and copied into delivery rows. Now:
- **Sealed at rest.** `configSecretFields.SECRET_MAP_KEYS` (`headers`): every string value of a plain-object `headers` map is sealed wherever the walk meets it (an array, like the Generic API integration's `{name, value}` rows, is not touched). `db.ts` adds write-side seal hooks for `NotificationRule`, `AlertGroup` and `NotificationDelivery` over `SECRET_ACTION_COLUMNS`; reads open through the existing all-models pass, so no per-row rebuild on the hot delivery read. The backfill job seals existing rows (deliveries only where `meta ? 'headers'`).
- **Masked in responses.** `utils/actionHeaderMask.maskActionHeaders` masks every api_call header value in the rule list / create / update responses, the group list / get / create / update responses and the asset Alerts tab.
- **Preserve-on-echo, bound to the destination.** `restoreMaskedActionHeaders` (in `createRule` / `updateRule` / `createGroup` / `updateGroup`) puts the stored value back for a masked header only from a stored api_call with the SAME url and header name; a masked header on a changed url is a 400 — the rule-111 shape.

(i) **The September migrations' silent promotions (F186, F218).** `20260922000000_rbac_catalogue_hygiene` and `20260923000000_authentication_function_key` folded stored `fullwrite` down to `write` on five keys but never touched a stored `write`, whose meaning changed underneath it: on `serverSettingsSystem` it went from the twelve IdP routes to the ~54 admin routes; on `automationScripts`, `automationManagement` and `maintenanceManagement` from a dead, read-equivalent rung to the full grant; on `serverSettingsData` from nothing to restore / update / restart. The approved fix — demote only roles unedited since — proved impossible: every later RBAC migration bumped `updatedAt` on every row, and the dead rungs left no trace. The owner chose **report, don't demote**: migration `20261014010000_role_grant_review` adds `Role.grantReviewNeeded`, flags every custom, non-admin-equivalent role holding one of those five keys at `write`, and writes a warning `role.grant_review_needed` Event per role naming the keys. While any role is flagged, the capacity card carries a watch-severity `role_grant_review` reason naming them. The flag clears when an administrator saves the role's permissions (changed or not) or chooses **Mark reviewed** (`POST /roles/:id/grant-review`, audited `role.grant_reviewed`, gated by (g) so only someone who could grant the role's access can vouch for it).

### What it leaves open, on purpose

- **Nothing is demoted.** A role that gained access by accident keeps it until an administrator lowers it; the flag makes it visible, it does not remove it.
- **Account actions keep rule 48's bar**, as (g) explains.
- **The wizard's code view shows the mask.** It used to show headers in full; saving the code view echoes the mask and is restored as any save is.

### 114(j)-(n) and the extensions to (a) and (i) — the 2026-10-13 re-scan, phase 11

The re-scan after phase 8 found the places a grant was still handed out, or a protected act still reached, without the check every other path makes:

- **Group mappings (F5/F65).** A mapping gives its role to every member of an IdP group at their next SSO / OIDC / LDAP / App Proxy login, and only a warning Event was written when that role was admin-equivalent — so a `users:fullwrite` holder could make any group an administrator. A mapping is now a grant like a role assignment. Changing its group or switching it back on counts too, since either changes who receives the role; withdrawing a mapping the caller could not have created needs the same rank.
- **The AI Assistant's token (F9).** Regenerating it handed the caller a raw bearer on the bot role with no check at all. It now takes the creation grants and the role as stored.
- **Alert-group scripts (F56).** The script gate read only the request body, and `actions` is optional on update — so adding your automation to a group that already runs a script, or creating a group whose seeding copies one from a member, attached that script to alerts you control. The gate now reads the delivery the group will run.
- **Editable built-ins (F71).** The September review flag skipped every built-in role; the three editable ones are now flagged where a five-key cell is `write` and differs from what they ship with — owner decision 2026-10-13, keeping "report, don't demote".
- **Tag preview (F78).** Device names and addresses went to Server Settings read alone; owner decision: counts for everyone, the sample only with Assets read.
- **Integration register (F79).** A forced register overwrote any reservation; it now follows the reservations key's ownership rule.
- **Quarantined status (F61).** Import and create could set it, and discovery's auto-quarantine pass then pushed a real quarantine to the FortiGate.
