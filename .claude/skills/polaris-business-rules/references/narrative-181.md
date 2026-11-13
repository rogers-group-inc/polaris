# Business rule 181 — full narrative

> Written 2026-11-13 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 181](#rule-181) — A custom widget's levels are its own, and one automation alerts on them for every widget

## Rule 181 — A custom widget's levels are its own, and one automation alerts on them for every widget

**The request (2026-11-13).** The operator was bringing APC PDUs and UPSes under alerting. Each widget on the APC manufacturer profile already carried a "Warning at" value — 16 A on an AP8830's bank current, a battery capacity floor — that only coloured the card. To alert, they had written one `customWidgetValue` automation per widget and per threshold ("Bank 1 current high", "Bank 2 …", "Bank 3 …"), each repeating a number the profile already held, and a second model with a different rating (an AP8870 banks at 19 A) would have needed a second set. They asked: "instead of the automations I created using values, couldn't they just use whether they're in warning or not, based on the manufacturer profile" — and then "add warning and critical".

**Decisions.**

- **Two levels on the widget, one direction.** `criticalAt` joins `warningAt`; `warningWhen` already said which side is the problem and now says it for both. A widget may set either or both. The editor refuses a critical level short of the warning one, and so does the server (`widgetLevelsProblem`), because a card that reads critical before warning is nonsense either way round.
- **One reading of a level, in one place.** `utils/widgetLevel.ts` turns `displayOptions` into levels and a reading into 0 / 1 / 2 (critical checked first; a level itself counts as reached, as the card always did with "warn at 90"). The card's browser copy (`_customWidgetWarning`) follows the same contract and is pinned by the same cases.
- **A new metric, not a new operator.** `customWidgetLevel` reads 0 / 1 / 2 per widget, so it rides everything a metric already has: dimensions (`widgetId`, to narrow to one widget), scope, `>= 1` for warning, a severity band at 2 for critical, reset, escalation. An automation with no widget dimension covers every widget that defines a level, each at its own thresholds — the request's "one automation" — and a profile edit moves the alert's threshold with the card's.
- **A widget with no level is never read.** It has no level to be at; reading it as 0 would let it CLEAR a live alert's dimension by accident and would fill every rule with dimensions that can never fire. Only widgets whose catalogue entry has levels are queried.
- **The sentence names the state, not the number.** "Bank 2 Current is in critical state" / "… is back to normal"; the `{value}` / `{threshold}` tokens read as words ("critical", "warning or worse"). The number is on the chart.
- **The card speaks the same levels.** Amber at warning, red at critical: a red tick on the gauge and a second dashed line on the line widget at the critical level, a coloured Value widget (which now takes levels too), and a caption naming both ("Warning state at or above 16.0 A · Critical at or above 18.0 A"). The tooltip names the Custom widget level automation as what alerts; the 2026-11-13 wording fix ("Warning state", never "Warns") stands.
- **The email leads with the widget (approved canvas, 2026-11-13).** `{chart.widget}` is what `{chart.trigger}` resolves to on the three custom-widget metrics: the widget's last hour in its own name and unit, in the email's orange; a value alert draws the threshold that fired (the severity band the alert is at, else the trigger's) in that severity's colour; a level alert draws both of the widget's levels, amber and red, each in the legend; a state probe draws one lane — its OK label faint green, its problem label solid red — captioned "On battery / bypass 12 min of the last hour · now …", naming a table probe's row. Response time stays as the second chart (is the device answering at all); CPU and memory go (a PDU or UPS reports neither) and so does packet loss (it repeats response time). No reading in the hour draws no chart, never an empty box. Before this, a widget alert's `{chart.trigger}` rendered away and the email led with four device charts that said nothing about the bank that tripped.

**Rejected.**

- *An "in warning" operator on `customWidgetValue`* — it would have made one metric compare against two different things depending on the operator, and the band / reset / severity machinery is built on a number against a threshold. A metric whose value IS the level gets all of that unchanged.
- *Reading the level from the card's last rendering* — the card is a browser artefact; the engine must read samples.
- *Levels on state and table widgets* — a state probe already has its own problem side (`trueIsProblem`), and a table has no single reading.

**Where.** `src/utils/widgetLevel.ts`; `notificationDimensionService.listCustomWidgetCatalog` (`levels`, `unit`); `notifications/readings.ts` (`customWidgetLevel`); `utils/triggerSummary.ts`; `manufacturerProfileService.assertWidgetLevels`; `api/routes/integrations.ts` (Generic API widget schema); `services/alertWidgetChartService.ts` + `alertChartService` (`chart.widget`) + `utils/sparklineSvg.ts` (`levels`, `statusStripSvg`); `public/js/assets-snmp.js` (card), `server-settings-profiles.js` (editor), `integrations-generic-api.js` (a ninth "critical at" column after the side, so an older line parses the same). Tests: `widgetLevel`, `customWidgetLevelReadings`, `customWidgetWarningDom`, `alertWidgetChart`, `genericApiIntegrationDom`.
