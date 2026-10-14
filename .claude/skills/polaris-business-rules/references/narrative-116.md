# Business rule 116 — full narrative

> Written 2026-10-13 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 116](#rule-116) — No regex Polaris runs can be made to take more than linear time

<a id="rule-116"></a>

## Rule 116 — No regex Polaris runs can be made to take more than linear time

### Where it came from

The seventh phase of the follow-up to the 2026-10-11 whole-repository security scan: eleven findings (F171, F190, F201, F205, F215, F222, F225, F243, F249, F252, F253), all one defect. A JavaScript RegExp backtracks and cannot be interrupted, so a pattern that backtracks catastrophically does not slow a request — it parks the whole process (the web role, a monitor worker, discovery) until it finishes. The sources:

- **Regexes an operator types**, run against text Polaris does not control: log-flag rules over every log line on read (F171); Application Map process / service rules, including from a READ-gated preview (F190, F215); HTTP-check and path-check body matches over up to 64 KB of a remote response (F222, F225); manufacturer-profile `matchPattern` / `modelPattern` over device-supplied model strings (F253 — the `findUnsafeRegexConstruct` heuristic missed `.*.*x`, `(a|aa)+b`, `(.|\s)*x`).
- **Wildcards and globs translated to regexes**: `*` → `.*`, so `****…x` explodes — contact / asset `matches` filters, tag criteria (F201), automation event patterns in the event tail (F249).
- **Polaris's own whole-file regexes on an uploaded MIB** (up to 1 MB): an unanchored start plus a lazy `[\s\S]*?` rescanned the rest of the file from every header (F243, F252), and every registry refresh re-parsed every stored MIB.
- **Trailing trims** like `.replace(/\/+$/, "")` — quadratic on a long run of the character followed by anything else (F205), on a credential `baseUrl`, a URL host, and a path-check response body.

### The decision

(a) **Operator regexes run on RE2.** `utils/safeRegex.ts` compiles every operator-supplied pattern with `re2js` — a pure-JavaScript port of RE2, chosen over the native `re2` so no install path (RHEL, containers, Unraid) needs a compiler — whose match time is linear in the subject whatever the pattern. It is also the syntax the Go agent already uses, so a path-check body regex means the same thing on the server and on an agent. `compileSafeRegex` (throws an operator-readable AppError 400), `tryCompileSafeRegex` (null, for stored patterns), `safeRegexProblem` (the save-time message) and the returned `SafeRegex` (`test`, `exec` with groups, `execAll`) are the only API; compiled patterns are memoized. Wired at: log-flag rules, `wildcard.compilePattern` (Application Map, interface / storage auto-monitor), manufacturer profiles and the profile resolver, custom-widget `modelPattern`, asset-type match clauses, model parse rules, HTTP checks (`httpCheck.bodyMatches`, `credentialService`), path checks (`pathCheckServerRunner`, `agentRegexProblem`). `regexSafety.findUnsafeRegexConstruct` is retired; `clampRegexSubject` and `countCaptureGroups` stay.

(b) **Wildcards and globs never become regexes.** `wildcard.globMatches` is the greedy-star matcher with one backtrack point (worst case pattern × subject, never exponential), runs of `*` collapsed; `compileWildcard` and `compileGlob(pattern, { ignoreCase, questionMark })` return a `PatternMatcher` with `.test`. Semantics are unchanged: anchored, `*` any run and `?` one character (`questionMark: false` for the automation event patterns, where `?` has always been literal), neither crossing a line terminator.

(c) **The MIB parser's whole-file scans run on RE2**, which tracks every start position at once, so the hostile inputs are linear; parsed assignments and imports are cached per stored MIB by content hash, so a registry refresh re-parses only what changed.

(d) **Trailing trims are a loop** (`utils/trimTrailing.ts`), at every site that used a `X+$` replace.

(e) **What RE2 cannot run is said, not run.** Lookahead, lookbehind and backreferences are refused at save time with a message naming them. A STORED pattern RE2 cannot compile is skipped by its consumer (it matches nothing) — never run on the old engine — and is reported: the boot job `auditStoredRegexes` writes one warning `regex.pattern_unusable` Event per (source, row, pattern) not already reported, log-flag rules also log `logflagrule.pattern_unusable` and flag the row in their editor, and the capacity card carries a watch `regex_pattern_unusable` reason while any remain.

(f) **The shipped FortiSwitch model-parse seed** used a `(?!v\d)` lookahead and is stamped into every install's Fortinet profile. It is replaced by an exact RE2 equivalent (`^([^v\n].*?|v|v[^\d\n].*?)[-\s]v\d` — the token starts with anything but `v`, is exactly `v`, or is `v` then a non-digit; bare `v` first so the shortest token still wins), pinned against the old pattern on a corpus, and migration `20261014020000_re2_model_parse` rewrites rows still carrying the exact old text.

### What it leaves open, on purpose

- **The Application Map preview stays `applicationMap:read`.** With linear matching there is nothing left to gate.
- **RE2 `\s` and `.` differ at the margins** from JavaScript's (no `\v` or Unicode spaces in `\s`; `.` excludes only `\n`). Operator patterns over device names and log text do not rely on either.
- **Browser-side regexes** (the `public/` previews) are not covered; they run in the operator's own tab.

### WinRM responses (2026-10-14, re-scan F84)

The WinRM SOAP parser was the last place a remote host's text met a backtracking regex: the fault-reason pattern nested two lazy `[\s\S]*?` scans and the Stream pattern ran three adjacent `[^>]*`, and the body had no size limit. A host answering 500 with `<Reason>` and a megabyte of unclosed `<Text>` would hold the event loop that runs every agentless collector. The extraction is now indexOf-based (`xmlElement` moves forward only and a missing close tag ends the search rather than retrying from the next opener), and a body over 4 MiB aborts the request. `tests/unit/winrm.test.ts` parses four hostile bodies of ~1 MB each inside a 2-second budget alongside real Receive / fault responses.
