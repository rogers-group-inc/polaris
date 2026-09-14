## cross-cutting/fmg-fortigate-parity-surfaces

**What it is:** FMG and standalone FortiGate integrations share feature surfaces that must move together: integration modal tabs (General / Filters / Monitoring / DHCP Push / Quarantine Push / Description Sync / SD-WAN / Geographic Location), transport dispatch via buildTransportForIntegration(), and filter helpers. This entry is narrower than [cross-cutting/integration-type-onboarding](#cross-cuttingintegration-type-onboarding) — that one covers adding any new type; this one covers the FMG↔FortiGate paired-feature parity that must move together once both types exist.

**Writers** (files that mutate or emit this state):
- `src/api/routes/integrations.ts` — POST / PUT integration handlers parse both fortimanager and fortigate integration types, store config.pushReservations / pushQuarantine / monitorSettings / deviceInclude/Exclude in the same JSON shape
- `src/services/reservationPushService.ts` — buildTransportForIntegration() dispatches to FMG proxy/direct or FortiGate direct transport based on integration.type
- `src/services/assetQuarantineService.ts` — quarantineAsset() / releaseQuarantine() use buildTransportForIntegration() for both FMG and FortiGate
- `src/services/fortigateLocationService.ts` — fetchFortigateSysLocation() uses buildTransportForIntegration() + callFortiOs() for both FMG and FortiGate
- `src/services/fortigateCoordPushService.ts` — FMG-mode pushes to metavars + CMDB natively (no proxy); standalone pushes CMDB via direct REST. Same source-of-truth dispatch pattern as the other push services.
- `src/services/descriptionSyncService.ts` — description push/adopt (interface comments + device descriptions, Polaris-primary) uses buildTransportForIntegration() + callFortiOs() for both FMG (proxy AND bypass/direct) and standalone FortiGate; gated by config.syncDescriptions on both types.
- `src/services/fortinetLinkStateService.ts` — the controller-link sweep (business rule 59) covers both integration types from one code path, and gets its parity for free by going through `monitoringService.fetchFortinetControllerInventory`, which already dispatches FMG-proxy / FMG-direct / standalone-FortiGate through `fetchViaFortinetTransport`. The one type-specific line is controller-name resolution: FMG devices carry the name on `fortinetTopology.controllerFortigate`, while a standalone gate IS the single controller and falls back to the integration's own `config.host`. That is the same fallback `probeFortinetController` makes, and copying it rather than inventing a second rule is what keeps the sweep and the probe bucketed on the same inventory-cache key.
- `public/js/integrations.js` — Integration modal tab bodies for General (useProxy, Filters), Monitoring, DHCP Push, Quarantine Push, Description Sync. FortiGates Monitoring subtab now also carries the `pullSnmpLocation` / `pushGeocodedCoords` toggles.

**Readers** (files that consume it):
- `src/services/discovery/discoveryEngine.ts` — Discovery sync paths read pushReservations toggle to decide whether to push DHCP changes
- `src/services/discovery/discoveryEngine.ts` — Discovery sync paths read pushQuarantine to decide whether to push quarantine entries
- `src/services/reservationService.ts` — Reserve/release flows call buildTransportForIntegration() to dispatch push/unpush calls
- `src/services/assetQuarantineService.ts` — Quarantine push consults buildTransportForIntegration() and pushQuarantine toggle
- `public/js/assets.js` — Asset details modal wires up quarantine/release buttons that call the quarantine endpoints
- `src/utils/integrationFilter.ts` — assetMatchesIntegrationFilter() checks deviceInclude/Exclude for FMG/FortiGate and ouInclude/Exclude for AD (not shared)

**Invariants:**
- FMG and FortiGate must have identical modal tab layouts and toggle names (pushReservations, pushQuarantine, syncDescriptions, pullSdwan, monitorSettings JSON, deviceInclude/Exclude).
- buildTransportForIntegration() is the single source of truth for routing push/quarantine calls; all callers must use it, never inline a new transport builder.
- Standalone FortiGate always routes through direct REST transport (no proxy option); FMG respects the useProxy toggle on the General tab.
- DHCP Push and Quarantine Push are independent toggles; enabling one doesn't force the other (operators mix-and-match per deployment model).
- FMG-only features intentionally excluded from standalone FortiGate: multi-device device filter (ADOM scoping), FMG-proxy concurrency settings.
- Filter matching (deviceInclude/Exclude wildcards) is the same for both FMG and FortiGate; tested in integrationFilter.ts.
- **Permission copy for a device surface comes from the device, never from inference.** The FortiOS access-profile group in the Quarantine Push tab was first written as "User & Device" by reasoning from the `user.quarantine` tree name; the table's own `access_group` is `wifi`. Any CMDB tree answers this: `?action=schema` returns `access_group` alongside every field and its size. The tab copy says so, so an operator on a build that differs can check rather than trust the page.
- **A toggle the shared modal renders must exist in BOTH types' CREATE schemas.** `_integrationTabs` gates the DHCP Push / Quarantine Push tabs on `isFmg || isFgt`, but `pushReservations` + `pushQuarantine` lived only on `FortiManagerConfigSchema` until 2026-08-31. `z.object` STRIPS unknown keys, so ticking either box while ADDING a standalone FortiGate dropped it in silence: the integration saved clean, the tab came back unticked, and `quarantineAsset` skipped every sighting from it — surfacing as "0/N FortiGate(s) accepted the push", a device-shaped error for a setting that was never stored. Only the EDIT flow persisted them, and only incidentally: `UpdateIntegrationSchema` validates `config` as `z.record(z.unknown())` and merges. The parity invariant above named both toggles and was still violated on the server side, so `tests/unit/fortigatePushTabCopy.test.ts` asserts it mechanically — every FMG schema key that is not structurally FMG-only must exist on `FortiGateConfigSchema`.
- **There are THREE push transports, not two, and tab copy must branch on all three.** FMG proxy, FMG bypass/direct, and a standalone FortiGate — which has no FortiManager in front of it at all. The three shared tabs took only `useProxy`, and the tab set passed `true` for the standalone case, so an install with no FMG was told its writes went "through FortiManager's /sys/proxy/json" and that it needed Device Manager Read-Write on the FortiManager admin profile; the permission section had no transport branch whatsoever. Each form builder now also takes `type`, and the FortiOS-side guidance is shared in `_fortigateAccessProfileHTML` (public/js/integrations.js) so a fourth tab cannot reintroduce a two-transport assumption. Known gap left in place deliberately: FMG bypass/direct mode still renders the FMG admin-profile section, where the write actually authenticates with the per-device token.

**When changing this:**
- Any modal tab change on FMG must be duplicated on standalone FortiGate (and vice versa); test both integration types.
- Adding a config toggle: put it on BOTH `FortiManagerConfigSchema` and `FortiGateConfigSchema`, then create a standalone FortiGate integration through the ADD flow with the box ticked, save, and reopen the tab. A box that comes back unticked is the create schema stripping it, not the UI.
- Adding or rewording push-tab copy: render it for all three transports (`fortigate`, plus `fortimanager` with `useProxy` true and false) and confirm the standalone copy names no FortiManager. `tests/unit/fortigatePushTabCopy.test.ts` evaluates the three form builders against stubs and asserts exactly that, plus that the FMG copy is unchanged.
- If adding a new transport capability, update buildTransportForIntegration() signature and all callers (reservationPushService, assetQuarantineService, future features).
- Check that toggle propagation works: set pushReservations=true on FMG and verify next discovery sync writes reservations; disable it and verify unpush/lease-release are skipped.
- Verify filter behavior: add a deviceInclude pattern to FMG and confirm the next sync only touches matching devices.
- Test cross-device push: one asset discovered by FMG with multiple device filters; confirm each push lands on the intended device via the transport.

---
