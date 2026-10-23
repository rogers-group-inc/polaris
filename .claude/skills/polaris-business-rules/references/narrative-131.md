# Business rule 131 — full narrative

> Written 2026-10-23 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 131](#rule-131) — One answer decides which manufacturer profile governs an asset, and the profile's symbols resolve where its MIBs were uploaded

<a id="rule-131"></a>

## Rule 131 — One answer decides which manufacturer profile governs an asset, and the profile's symbols resolve where its MIBs were uploaded

### What was found

2026-10-23, while writing the manufacturer-profile skill for the Polaris toolbox plugin: two
readers of the same profile disagreed about which assets it covered, and the readiness the
profile page reports disagreed with what the collectors could actually resolve.

- **Widgets ignored "also applies when".** Phase 4 of uniform SNMP gave a profile a
  `matchPattern` for spellings no alias folds in ("Aruba Networks" under the HP profile),
  OS-only identity and the MIB-pin redirect, and `pickDbProfile` honoured it for the four
  telemetry streams. The custom-widget collector, the Custom MIB tab and rule 130's
  enablement service each looked the profile up by the manufacturer KEY only
  (`getProfileFor`). So the same Aruba switch read its CPU from the HP profile and showed none
  of the HP profile's widgets, and the "enable on these devices" picker never offered it.
- **Symbols resolved at the asset's name, MIBs live at the profile's.** Vendor MIBs are
  scoped by manufacturer name, and the operator uploads a profile's MIBs under the profile's
  name. That is also the scope `symbolReadiness` checks, so the profile page shows the row
  READY. The collectors resolved at `{ manufacturer: asset.manufacturer, model }`, so an asset
  that reached the profile through `matchPattern` (or a pin to a MIB of another manufacturer)
  looked for the MIB under its own name, found nothing, and collected nothing. The page said
  READY and the chart stayed empty, which is the failure the readiness work existed to end.

### The decision

The operator's instruction was to fix both rather than document them.

- **One governing answer.** `findDbProfile` is the only place that decides which profile
  governs an asset. Widgets reach it through `customWidgetEnablementService →
  widgetProfileForAsset`, which the collector, the Custom MIB tab route and the enable checks
  all call, so the System tab, the Custom MIB tab and the switch can never disagree. The MIB
  pin is left out for widgets: it redirects a telemetry stream, and widgets are not one.
- **Two scopes, asset first.** The asset's own scope stays first, because the comment that
  kept it there was right: a device- or model-scoped upload for the asset's real
  manufacturer must keep winning. The governing profile's manufacturer is tried second, when
  it differs. It is carried as `ResolveScope.profileManufacturer` and handled inside
  `oidRegistry` (`lookupScoped`), so every collector resolves the same way. A new collector
  that forgets to pass it degrades to the old behaviour rather than to a wrong OID.
- **No stealing.** `findDbProfile` already consults `matchPattern` only when no profile is
  keyed by the asset's manufacturer. Nothing here changes that, and the tests pin it for
  widgets too.

### Scale

The collectors do one extra in-memory map lookup only for a symbol the asset's scope misses
and only when the governing profile is a different manufacturer. Scope maps are shared per
manufacturer, so a fleet routed through one `matchPattern` adds one map, not one per asset.
The widget picker is the one place that reads more: with a `matchPattern` it cannot
pre-filter by manufacturer in SQL, so it reads every non-decommissioned asset (eight columns)
and lets `findDbProfile` decide. That runs when an operator opens the picker, never on a
tick. At 2000 assets it is one small query.

### What it leaves alone

- `listStateProbes` and the automation builder name a probe by its profile's manufacturer.
  They never filter assets by it, so nothing there changed.
- Profile import / export (`manufacturerProfilePortabilityService`) keys by the profile's own
  name, which is correct for a file that IS that profile.
