# Business rule 172 — full narrative

> Written 2026-11-12 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 172](#rule-172) — Polaris never creates a manufacturer profile on its own; it lists the manufacturers that lack one, and an empty row names the standard reading instead of copying it

## Rule 172 — Polaris never creates a manufacturer profile on its own; it lists the manufacturers that lack one, and an empty row names the standard reading instead of copying it

**The ask (2026-11-12).** "Whenever Polaris discovers a new manufacturer, or the user types one in,
after the name is aliased to its canonical, create a manufacturer profile automatically with the
default MIB configuration applied; the admin then adjusts it by hand or with polaris-toolbox." The
need under it: an operator had no way to see which vendors in the inventory were running on
standard MIBs alone, or what an untouched row actually reads.

**Why not automatically.**

1. **It would take devices from another profile.** A profile keyed by a manufacturer always wins
   over another profile's "Also applies when" (rule 131). An auto-created empty "Aruba" profile
   would silently pull every Aruba switch out of an HP profile whose pattern is `aruba|procurve`,
   and they would lose its rows.
2. **Discovery's manufacturers are mostly not SNMP devices.** Entra, Intune, DHCP fingerprints and
   OUI lookups name phones, laptops and IoT vendors by the hundred; a profile for each is noise.
3. **Copying the defaults would freeze them.** An empty row already means "the standard MIB
   answers". Writing the default into each new profile pins today's choice; a release that improves
   a standard reading would no longer reach those rows (rule 68: a profile holds only what overrides
   the generic MIBs).
4. **An empty profile changes nothing at poll time.**

**What was built instead.** The card lists the manufacturers of devices that answer SNMP and have
no profile of their own, with device counts and one-click Create; a name another profile's pattern
already covers says so, and the Create button warns that the devices would leave it. A row with no
symbol shows "Standard: <module> <object>" in place of "(built-in seed)", so the operator sees what
is in use and types over only what they mean to change.

**"Answers SNMP" without a settings walk.** Resolving every asset's polling method to decide which
are polled over SNMP is a per-asset settings walk at 2000 assets. The probe already stamps
`lastDescrAt` when an SNMP probe's identity read succeeds, and only an SNMP reading writes the
`snmp-*` sources; one `groupBy` on those is enough.

### Rule 172 — the invariant as stated in full until 2026-11-12

(new rule; the invariant above is its first statement)
