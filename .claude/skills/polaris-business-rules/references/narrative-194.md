## Rule 194 — A group may govern only some path checks

**The ask (2026-11-18).** "For the groups, I want to be able to select which path monitors the grouping is for." A Path Monitor automation usually watches every check; the operator wants one group (one set of recipients, one fold) for some of those checks — the ERP and VPN paths, say — without splitting the automation.

**Decision.** The list is a GOVERNANCE filter, the check-shaped twin of the group's device filter (`scope`), not a detection filter. A check outside the list is not dropped: its automation alerts on it exactly as it would ungrouped — one alert per host under the automation's own key, delivered by the automation's own actions. That keeps the one rule the group editor already states for devices ("on a device outside this filter, a member automation delivers on its own") true for checks too, and an operator who wants an unlisted check silent narrows the automation's own check filter instead.

**How.** A path reading's component key is its check id, so the test is per contribution: `foldPlanFor` puts the list on the plan (`checks`), `placeContribution` ANDs "is the check listed" with the device governance before choosing the target, and `foldBuckets` places fire by fire whenever the list applies (a per-device or subnet fold otherwise placed a device's fires together, and one host can fail a listed and an unlisted check in the same tick). Because `recordFoldReporting` goes through the same placement, a rule-193 percent threshold counts only listed checks.

**Scope of it.** Only a single-condition path-metric trigger reads the list. A composite of path conditions contributes one whole-device reading with no check key, so it cannot be split by check; it stays governed as before. Non-path members ignore the list entirely.

**Saving.** Empty / null = every check. An unknown id is refused (400): a list naming only a deleted check would silently govern nothing. Omitted on update = unchanged — the list's Enabled switch does not resend it. A change retires the group's live alerts with `system:group-rescoped`, for the same reason a scope change does: it moves contributions between owners, and a live alert cannot change recipients in place.

Pinned by `tests/integration/alertGroupPathChecks.test.ts`.
