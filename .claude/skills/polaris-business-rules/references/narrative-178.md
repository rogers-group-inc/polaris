# Business rule 178 — full narrative

> Written 2026-11-13 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 178](#rule-178) — A time window means the span it states

## Rule 178 — A time window means the span it states

**How it was found.** The 2026-11-13 efficiency audit. The alert engine fetches each rule's samples over `fireLookbackMsFor`, which is floored at `DEFAULT_LOOKBACK_MS` — 15 minutes — so a short window still has enough history for holds and resets to count. The aggregate was then taken over EVERYTHING fetched (`aggregateSinceMs` returned no bound unless a reset had widened the fetch further). So "average CPU over the last 5 minutes" — the High CPU, High memory, Slow response and temperature baselines, and any operator rule like them — averaged the last 15 minutes. Alerts fired later and cleared later than their rules said, and the operator had no way to tell.

**The decision (operator, 2026-11-13).** Asked whether to keep the 15 minutes and say so in the UI, or to make rules use the window they state, the operator chose the stated window.

**What it does.** `timeWindowMs` is the stated window for a time aggregate (`avg`, `min`, `max`, `median` with `windowSec` > 0 and no count window); `aggregateSinceMs` bounds the aggregate to it. The FETCH is unchanged — still the 15-minute-floored lookback — because holds, resets and series counting need it.

**The one guard.** A window shorter than a device's polling interval (a 5-minute average on a 10-minute poll) would now often contain no reading at all, and the rule would stop firing — the opposite of what the operator asked for. So when the stated window is empty, the newest reading stands in, provided it is no older than the old span (`fireLookbackMsFor`). That bound means the change never reads older data than before: at worst it reads one reading the old 15-minute average also contained.

**What it does not change.** `latest` rules; windows counted in readings (rule 66), which were never time-bounded; windowed ratios such as packet loss (rule 29), whose window is already used exactly; forecasts.

**Behaviour change to expect.** Averaged rules react faster in both directions: a spike over the threshold fires sooner, and a recovery clears sooner.

Pinned by `tests/unit/timeWindowAggregate.test.ts`.
