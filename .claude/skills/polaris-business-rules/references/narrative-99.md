# Business rule 99 — full narrative

> Written 2026-10-09 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 99](#rule-99) — A feed an operator describes is an inventory claim: it never vouches for presence or decides monitoring, never outranks a first-party source, and never reaches past its own host

<a id="rule-99"></a>

## Rule 99 — A feed an operator describes is an inventory claim: it never vouches for presence or decides monitoring, never outranks a first-party source, and never reaches past its own host

### Why there is a Generic API integration at all

Every integration before this one was written for one product. Each knew what its records meant: vCenter says a VM is powered on, Entra says a device is enabled, Unraid says a container is running. Many systems that hold an operator's devices will never get an integration of their own: a facilities CMDB, a camera management server, a printer fleet portal, a spreadsheet behind an internal API. The Generic API type lets an operator point Polaris at any of them and SAY what each field means. It is asked for, and it is the cheapest way to cover the long tail. Requested 2026-10-07; built inventory-only as v1.

The cost of "say what each field means" is that Polaris no longer knows what the source is. The rule is the set of things that follow from that.

### (a) A record is not presence

A CMDB lists a device that was scrapped two years ago with the same confidence as one plugged in this morning. Its `lastUpdated` field, if it has one, records when someone edited the row, not when the device last spoke. Rule 12 already says `Asset.lastSeen` means *verified network presence*, and directory timestamps stopped writing it for exactly this reason. A generic feed is a directory with even less known about it. So `syncGenericApiDevices` never calls `bumpLastSeen`, and the post-sync presence pass (`presenceVerificationService`, `generic-api` in its candidate kinds) establishes presence the way it does for AD: an agent heartbeat, a monitor probe, a ping.

Rejected: an operator-mapped "last seen" field. It would have to be trusted blindly, and the first feed that stamps "now" on every row on every export would make every asset look present forever.

### (b) A feed decides nothing about monitoring

Every other asset-only type monitors by CLASS: a `workstationMonitor` / `serverMonitor` / `vmMonitor` block whose `addAsMonitored` the sweeps enforce. A generic record can be any class; its type is whatever the mapping says, defaulted to `other`. Giving the integration class blocks would mean a block for every type in the registry, most of which a given feed never produces.

There is a second, subtler problem. `monitorOverrideService`'s recompute measures an operator's choice against the integration's default (`monitored IS DISTINCT FROM COALESCE(<block flag>, false)`). With no block, the default reads as `false`, so the moment an operator monitored a generic asset it was flagged as an override — protected from sweeps that do not apply to it and labelled as a divergence that does not exist. The recompute and the sweep therefore exclude `genericapi` integrations. A generic asset is monitored the way a manually added one is: because an operator chose to. ICMP response time is the only default.

### (c) A feed never outranks a first-party source

When a CMDB and Active Directory disagree about a server's hostname, AD is reading the computer object the machine itself maintains, and the CMDB is reading what someone typed. In `utils/assetProjection.ts` the `generic-api` rules therefore sit below every directory, hypervisor, controller and agent source. The single exception is just above `fortigate-endpoint` for name / manufacturer / model / OS, because a name someone wrote into an inventory is more deliberate than a DHCP client identifier, which can be a random string. For the IP the order flips: the gate's live DHCP/ARP binding is fresher than a CMDB that is often a step behind the network. The sync follows the same principle on its own writes. It claims only an UNOWNED asset, retypes only from `other`, and fills a serial only when the asset has none.

Matching follows rule 91 (a hostname is not an identity) and rule 84 (a placeholder serial is not a serial). The cascade is own source row → MAC → a serial that exactly one asset carries (`indexUniqueBy`) → a hostname match, which raises a pending Conflict and never merges. A cross-link onto an asset that already carries a DIFFERENT record of the same integration is refused. Two feed records that claim one device are the feed's inconsistency to explain, not Polaris's to fuse.

### (d) A feed never reaches past its own host

The operator types a host, a path, headers, maybe an OAuth token URL, and Polaris then makes authenticated requests on a schedule. That is exactly the shape netGuard exists for (the 2026-06-03 security review, M4). The integration adds three constraints the older types did not need, because the older types never followed a URL the REMOTE side handed back:

- **The request path is origin-relative.** `//evil.example/x` resolves to another host under the URL rules, so `isSafeRequestPath` refuses anything that does not start with a single `/`. The route schema refuses it at save time, and `buildRequestUrl` refuses it again at request time.
- **Next-page URLs stay on the endpoint's origin.** A Link header or a cursor that is a URL is resolved and accepted only when its origin matches the configured one (`resolveSameOriginUrl`). A feed must not be able to steer Polaris at a second host, least of all the cloud metadata address, which netGuard also refuses on every request through `send()`.
- **Redirects are not followed.** A 3xx is reported with the advice to point the integration at the final URL. Following it would be a second way to leave the origin.

The OAuth token URL is a second operator-chosen host and gets the same netGuard check, at save time and at request time. Secrets live only under the keys the at-rest encryption already seals (`apiToken`, `password`, `clientSecret` — `utils/configSecretFields.ts`). Custom headers are stored as typed, and the form says so beside the field instead of letting an operator put a key there believing it is sealed.

### (e) A partial read is never read as deletions

The opt-in disappearance sweep (`decommissionMissing`) is rule 70's: off by default; refused on an incomplete or an empty read and past `absenceExceedsGuard`; fed the identity set taken BEFORE the device filter; and limited by ownership. A generic feed has more ways to be incomplete than any directory, and each one is reported as `complete: false` rather than as a shorter feed:

- a later page fails;
- the page or record cap is hit;
- a next URL leaves the origin;
- the source ignores the page parameter and answers page 1 twice, caught by fingerprinting each page's first record;
- the run is cancelled.

A FIRST page that fails throws instead, so the run errors and nothing is written. Page and offset paging without a page-size parameter keeps asking until an empty page, because a short page only means "last" when Polaris knows the page size.

### Pinning

`tests/unit/genericApiService.test.ts` (every pagination mode, the origin and SSRF guards, redirects, OAuth — against a fake transport, because the guard refuses loopback and no local server can be reached), `tests/unit/genericApiSync.test.ts` (projection placement, sweep guards, location order), `tests/unit/jsonPath.test.ts`, `tests/unit/genericApiIntegrationDom.test.ts`, `tests/integration/genericApiSync.test.ts` (no lastSeen, no monitored, the cascade, the sweep guards, ownership), `tests/integration/genericApiRoutes.test.ts` (save-time refusals, the PUT re-validation, Preview).
