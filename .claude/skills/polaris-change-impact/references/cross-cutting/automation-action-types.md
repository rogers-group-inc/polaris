## cross-cutting/automation-action-types

**What it is:** The `actions` union on a NotificationRule — `notify` | `api_call` | `script` | `event` | `reboot`. Adding a member touches more than the schema, because several readers branch on "not notify and not api_call, therefore script".

**Everything that must learn about a new member:**
- `src/services/notificationTypes.ts` — the action schema, `actionSchema`, `escalatableActionSchema` (only if it can carry a chain), the `actionTypes` entry in `buildSchemaCatalog` (the builder is catalog-driven, so the dropdown updates itself), and `actionEscalation()` if the member has no `escalation` key. `REPEATABLE_ACTION_TYPES` only if a repeat may re-run it (today only `notify`).
- `src/services/automationActionService.ts` — the execute switch. Its final `else` is the SCRIPT branch; a new member must get its own `else if` or it will be executed as a script.
- `src/services/notificationRuleService.ts` — `assertActionRefs`, which walks `allRuleActionRefs` with an explicit branch per type (`reboot`, `notify`, `script`, …) rather than a final-`else` default; a new member with save-time checks gets its own branch, and one that may not run in some LOCATION refuses there by `RuleActionRef.where`.
- `src/api/routes/notificationRules.ts` — `assertScriptActionPermission`, the save-time permission gate (rule 48): a member that delegates a power the saver must hold gets a check here (`script` → `automationScripts:write`, `reboot` → `assets:write`).
- `src/services/automationTestService.ts` — `selectTestActions`: decide what a Test button does with it (a `reboot` and an `api_call` are skipped with a reason).
- `src/services/notificationEngine.ts` — `templatesOf` in the ruleWantsContext scan.
- `src/services/notificationEscalationService.ts` — the chain walk (`allEscalationsOf` narrows on `"escalation" in a`, so a member without the key is skipped automatically).
- `public/js/automations-wizard.js` — `availableActionTypes` (a catalog `permission` the user lacks hides it), `renderActionFields` / `collectActionCore` / `validateAction` / `actionSummary`, and `addActionRow` if the escalation footer doesn't apply or the member is not offered on a list (`reboot` is not offered in `#aw-reset-actions`).
- `public/js/automations-portability.js` — `recordActionDeps`: export strips every non-event action; name the dependency so an import says what to re-add.
- `public/js/automations.js` — the list's action label.
- `public/js/automations-wizard.js` — `ruleRecipientGroups` (`window.PolarisAutomationRecipients`), the walk behind the Automations list's **Addresses** column and the browser mirror of `allRuleActionRefs`. It is the one consumer that must learn about a new action LOCATION rather than a new action TYPE: a location it doesn't walk renders in the list as "nobody is notified", which is exactly the answer that column exists to give. Its two client-side companions are `testDeliveryTargets` (same walk, for the Test buttons) and `_awDraftFromRule`, which shares its `normalizeEscalationV2` because `withV2` fills reset/actions but never the escalation chain.

**`RuleActionRef.where`:** `allRuleActionRefs` tags every ref `fire` (the rule's or a band's own actions), `tier` (an escalation tier), `resolved` (a band's all-clear list) or `reset` (`resetActions`). Location-dependent validation keys on it — `assertActionRefs` refuses a `reboot` on `resolved` / `reset` (business rule 115(c): a recovery is no reason to reboot). A new action LOCATION must pick a `where` value, or extend the union, in the same change.

**Invariants:**
- **A member that changes behaviour by its ABSENCE needs a migration.** `event` gates the `notification.triggered` audit Event, so every pre-existing rule had to gain it (`20260810120000_event_action`) or it would have silently stopped auditing — and those Events feed the Events tab, the baseline event-trigger automations and the syslog/SFTP archivers. Both normalizers (`normalizeRuleInputCore` via `withEventAction`, and `normalizeRuleToV2`) inject it when folding a legacy shape forward, so an un-migrated row or a restored pre-upgrade backup behaves identically. An EXPLICIT `actions: []` is the opt-out and is never second-guessed.
- **event/change-triggered rules are carved out** of that injection everywhere (migration, both normalizers): the engine's event tail writes no Events by design — one that did would feed its own trigger.
- **The in-app Alert is not an action and can't become one.** `NotificationDelivery`, the escalation sweep, acknowledge/clear and `NotificationRuleState` all key on `Notification.id`.
- **`reboot` BOOKS, never sends** (business rule 115(c)): `executeActions` → `notificationRecipientService.resolveRebootActionRecipients` (its To/Cc/Bcc against `exec.assetRegionTags` and the asset's contacts; an empty To → action error, nothing booked) → lazy `rebootScheduleService.bookRebootFromAutomation` for `exec.assetId` (no asset → action error); `executed++` only when booked (a skip is an info Event, not a failure). No per-action escalation key, not repeatable, skipped by every Test.
- `addActionRow` sets `select.value` in JS rather than relying on the `selected` attribute written via innerHTML — the collector reads `.value`, and attribute reflection for a non-first option is environment-dependent.

**When changing this:** add the member to the catalog first (the builder picks it up for free), then let `npm run typecheck` enumerate the branch sites — every final-`else` narrowing failure is a place that would otherwise mis-handle it.

---
