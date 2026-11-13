# Business rule 176 — full narrative

> Written 2026-11-12 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 176](#rule-176) — A monitoring-settings change reaches every process within 30 seconds

## Rule 176 — A monitoring-settings change reaches every process within 30 seconds

**How it was found.** The 2026-11-11 orphan audit listed it as a leftover (B.9): a deleted integration's monitoring settings stay cached in the monitor role until it restarts. Reading the code showed the leftover was the small half of it.

The resolver that decides every asset's cadences, polling methods and credentials caches each integration tier, the manual tier and each class override in module-level Maps, with no expiry. The comment said "computed at most once per process lifetime; writes route through `invalidateMonitorSettingsCache`". That was written when Polaris was one process. Production is now split-role on every install: the web role handles the save and calls the invalidation — in the web process. The monitor and discovery roles, which are the processes that actually resolve settings to poll devices, never hear of it. So on a production install:

- changing an integration's or a class's cadence, polling method or credential in the UI saved correctly, showed correctly in the UI (the web role's cache was invalidated), and was **not applied by the monitor** until the monitor processes restarted;
- a deleted integration's cached tier was never forgotten there.

It went unnoticed because every update restarts every role, and updates were frequent.

**The decision.** Make the cache expire. The alternative was a cross-process invalidation message (Postgres NOTIFY, as the agent command wake uses). It was rejected for this cache because an expiry needs no channel, no listener lifecycle and no ordering argument, it covers every writer that will ever exist — including a restore, a migration and a row edited in SQL — and the cost is a handful of small reads per process every 30 seconds. Rule 170 (the server timezone) made the same choice for the same reason.

**What it does.** Each cache key records when it was loaded. A read of a key older than `MONITOR_SETTINGS_CACHE_TTL_MS` (30 s) reloads it. Two details matter:

- **Refresh in place, never drop.** The resolver has sidecar caches (the SD-WAN interval, "FortiOS REST unavailable", "system-info interval derived from the poll interval") that callers read synchronously right after a resolve. Clearing everything on expiry would open a window in which a sidecar is absent, and an absent SD-WAN interval reads as "this gate is not collected" — which rule 174's alert sweep would act on by clearing a real alert. So a stale entry goes on being served until its reload has overwritten it, sidecars included.
- **One reload per key.** A monitor pass resolves hundreds of assets concurrently. `claimReloadIfStale` marks the key as loaded at the moment it answers "stale", so exactly one of those resolves does the read and the rest take the cached value.

The explicit invalidation is kept: in the process that saved the change it is still immediate, which is what makes the UI show the new value on its next request.

**What it does not do.** It is not a general fix for every in-memory cache. The other per-integration in-memory state the audit listed (FMG workers, token caches, Proxmox connection pools, labelled gauges — B.8) is bounded and is not settings; it is left as it is.

**Scale.** Per process, per 30 seconds: one read per (integration, asset class) pair in use, one for the manual tier, one per class-override pair. On a 2000-asset install with ten integrations that is on the order of a hundred indexed single-row reads every 30 seconds per process.

Pinned by `tests/unit/monitorSettingsCacheExpiry.test.ts`.
