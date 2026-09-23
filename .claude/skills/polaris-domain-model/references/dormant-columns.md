# Dormant columns — kept in the schema, deciding nothing

A **dormant** column is one the schema still carries and some writer may still stamp, but which
no reader decides on: setting it through the API changes no behaviour, and no Polaris surface
shows or edits it. Each one was retired from a decision by a business rule that names it; the
list lives here, once, so the rules can cite it instead of re-explaining the precedent every
time (rules 29, 30, 32 and 36 each used to).

**The retirement precedent (the `cooldownSec` shape):** when a control leaves the builder, the
data it wrote must not keep acting — a rule silenced by a number no surface can show is the
failure. So a retirement (1) removes the control, (2) runs a one-shot that AUDITS each row's old
value before nulling or zeroing it (the update destroys the evidence), (3) has the builder write
the neutral value on every save so an API caller cannot re-arm it past the next edit, and
(4) leaves the column and any engine checks in place, dormant, until a later migration drops it.
Dropping one is a schema migration plus its Zod field plus this list.

| Column | Model / location | Retired from | By | Still written by | Notes |
|---|---|---|---|---|---|
| `cooldownSec` | `NotificationRule` | how often a NEW alert may fire | rule 32 (2026-08) | nothing — the wizard writes `null` on every save; the `clearNotificationCooldowns` one-shot nulled the fleet after auditing each value | the engine's two checks survive and see only nulls; "Repeat this notification" answers the question operators reached for it to answer |
| `failureThreshold` | the monitor-settings tiers (JSON in the Setting `resolveMonitorSettings` reads) | the down verdict's N | rules 30, 36 (2026-08) | the settings form still round-trips it | read only by the V3 baseline seed; N is the covering automation's `missedPolls` |
| `awaitingRecoveryConfirm` | `Asset` | the recovery verdict | rule 36 (2026-09-01, with the bucket cap) | nothing — zeroed once by `jobs/clampFailureBucket.ts` | `owesRecoveryConfirmation` is gone; the bucket's own level carries the whole recovery debt |
| `recoveryStartedAt` | `Asset` | the packet-loss window anchor | rule 29 (2026-09-01) | `utils/probeLossAnchor.ts` still stamps it | read by nothing; kept on the `cooldownSec` precedent |
| `consecutiveSuccesses` | `Asset` | the recovery verdict | rule 30 (2026-09-01) | `recordProbeResult`, every answered probe | maintained and CHARTED (the response-time chart's recovering run), but decides nothing — the bucket level is the whole verdict |

Related: the polling-method tiers' other fields are live (`polaris-monitoring-discovery` →
polling-methods-streams.md); the columns above are the only ones a rule has explicitly declared
dormant. A column that is merely unused by the UI but read by a service is not dormant — it is
undocumented, and belongs in the owning entity's Notes instead.
