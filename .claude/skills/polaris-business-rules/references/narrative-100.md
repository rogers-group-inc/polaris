# Business rule 100 — full narrative

> Written 2026-10-09 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 100](#rule-100) — A feed an operator describes is an inventory claim: it never vouches for presence or decides monitoring, never outranks a first-party source, and never reaches past its own host

<a id="rule-100"></a>

## Rule 100 — A feed an operator describes is an inventory claim: it never vouches for presence or decides monitoring, never outranks a first-party source, and never reaches past its own host

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

> Detail queries (f) do not change what "complete" means: completeness is the LIST's alone.

The opt-in disappearance sweep (`decommissionMissing`) is rule 70's: off by default; refused on an incomplete or an empty read and past `absenceExceedsGuard`; fed the identity set taken BEFORE the device filter; and limited by ownership. A generic feed has more ways to be incomplete than any directory, and each one is reported as `complete: false` rather than as a shorter feed:

- a later page fails;
- the page or record cap is hit;
- a next URL leaves the origin;
- the source ignores the page parameter and answers page 1 twice, caught by fingerprinting each page's first record;
- the run is cancelled.

A FIRST page that fails throws instead, so the run errors and nothing is written. Page and offset paging without a page-size parameter keeps asking until an empty page, because a short page only means "last" when Polaris knows the page size.

### (f) Detail queries are made after the record is settled

Asked for 2026-10-11. Many inventories list devices briefly and keep the substance behind a per-device URL: `/devices` gives an id and a name, `/devices/{id}/hardware` the serial, `/devices/{id}/warranty` the dates. A detail query is a second request made once per record, its path a template whose `{{json.path}}` placeholders are read from that record. Double braces, because a POST body is JSON and its own braces must never be read as a placeholder.

Three things follow from it being the FEED that supplies the values that build the URL:

- **A value is URL-encoded into the path**, so a record whose id is `a/b?x=1` or `//evil.example` can only ever be one path segment. A value of `.` or `..` is refused outright: encoding leaves it as it is and the URL parser would resolve it into a different path on the host. In a body the value is JSON-string-escaped.
- **The request goes through the same `buildRequestUrl` and `send()`**, so the host guard, the origin check, the no-redirect rule and the query-string credential apply unchanged. There is no second host to configure.
- **Identity, duplicates and presence come from the list alone, before any detail request is made.** The record id may not be mapped in a detail query, and the identity field is read from the main record even when a detail query maps the same field. A detail request that fails (a 404 for one device, a timeout, a missing placeholder value) costs that record the fields it would have filled. It never costs the record, its identity, or the read's completeness. Otherwise one flaky detail endpoint would feed the disappearance sweep a shorter feed than the list actually returned.

Cost is the operator's to see: at most five queries, `detailConcurrency` in flight (4 by default, 16 at most), and at most 20 000 detail requests a run, split across the queries. Records past the cap keep their list fields and the run log says so. At 2000 records and two queries that is 4000 requests per discovery run, at the discovery cadence (hours), never the monitor cadence. A field a detail query maps wins over the same field from the list, and a later query wins over an earlier one, whenever it yields a value. An empty value falls through.

### (g) The columns nobody projects: the feed changes only what it wrote

The feed can now fill department, assigned-to, purchase order, description, asset tag, acquired and warranty dates, tags and coordinates. Coordinates already have a projection, so `generic-api` became its lowest rule there, below every FortiGate tier, and the sync never moves coordinates an operator typed (`coordSource: "manual"`).

The rest have no projection to rank sources in, so (c)'s "never outrank" needed another form. The rule is that **the feed fills a blank, and changes a value only while it is still the value the feed itself wrote last run**. The previous run's observed blob on the feed's own source row is what "wrote last run" means. Once an operator or another integration (Entra writes `assignedTo` unconditionally) changes the column, the stored value no longer equals the feed's last value, and the feed leaves it alone for good. The alternative, "the feed always wins", would flip-flop with Entra every cycle and overwrite operator edits. "Fill blanks only" would freeze the first warranty date a CMDB ever reported. The feed never clears a column: a value that disappears from the feed is a gap in the feed, not an instruction.

Three columns carry an extra condition:

- **Description** is not written on an asset another integration owns. A FortiSwitch's or FortiAP's description can be pushed back to the device by description sync (rule 14), and a CMDB is not the authority on what a switch should be told.
- **Asset tag** is unique across assets. A tag another asset already carries is left off, and the run log says which.
- **Tags** carry no author. The feed adds its tags and removes the ones it listed last run and no longer lists. An operator's tag that happens to match one the feed dropped goes with it.

### (h) A configuration is shareable, so its file carries no secret

A mapping written for a product is useful to everyone who runs that product, so the dialog's JSON tab shows the form as a file, exports it and imports one. The file is built to be posted publicly:

- the sealed keys (`apiToken`, `password`, `clientSecret`) are never written;
- an extra header whose name says it carries a credential (auth, token, key, secret, cookie, session…) keeps its name and loses its value, because extra headers are stored unsealed and an operator may have put a key there despite the warning;
- host, port, username, OAuth client id and token URL say where an install's systems are and who it logs in as, so they are left out unless the operator ticks the box (moving a configuration between their own installs);
- verbose logging is this install's troubleshooting and is never exported.

The file lists what the importer must fill in (`needs`). An import only fills the form. Saving goes through the ordinary create / update route and `GenericApiConfigSchema`. The importer re-strips every secret on the way in, so a hand-edited file with a token in it cannot plant one in a field the operator never looked at. That is a property of the code, the same as the Discovery file's "never a foreign id".

### Pinning

`tests/unit/genericApiService.test.ts` (every pagination mode, the origin and SSRF guards, redirects, OAuth — against a fake transport, because the guard refuses loopback and no local server can be reached; detail templates, encoding and dot segments, layer precedence, identity from the list only, a failed detail never dropping a record, one OAuth token per run), `tests/unit/genericApiSync.test.ts` (projection placement including coordinates, sweep guards, location order, `genericApiFeedFieldUpdates`, `mergeGenericFeedTags`), `tests/unit/jsonPath.test.ts`, `tests/unit/genericApiIntegrationDom.test.ts` (detail-query editor, JSON tab apply / export / dirty-edit guard, no secret into the form), `tests/unit/genericApiPortability.test.ts` (no secret out or in, connection opt-in, every export a valid import), `tests/integration/genericApiSync.test.ts` (no lastSeen, no monitored, the cascade, the sweep guards, ownership, the direct-write columns against a real database), `tests/integration/genericApiRoutes.test.ts` (save-time refusals including detail queries, the PUT re-validation, Preview).
