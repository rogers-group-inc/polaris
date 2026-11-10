# Business rule 149 — full narrative

> Written 2026-11-10 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 149](#rule-149) — Changing a view's mode resets the view, and the operator is told what it costs first

<a id="rule-149"></a>

## Rule 149 — Changing a view's mode resets the view, and the operator is told what it costs first

**The request (2026-11-10).** With one mode per view (rule 147), the operator asked: "if a user
changes modes on a view, there is a modal warning that the view will be reset upon mode change.
then if they accept, change modes for the view and reset back to default. in layer 2 mode,
polaris already auto generates asset placement, so that isn't a big deal, but in topology mode or
rack mode, that could lose their changes."

**What a reset removes.** Everything mode-specific: the view's stored layouts (live blob and
restore point), its uploaded background images, polygons, racks and rack placements. The shown
types return to the defaults and a Rack view starts with one 42U rack. The name stays. Location
codes already written to descriptions (rule 148) are not reverted — they are asset data, and
other views read them.

**Applied on accept, not staged.** A mode change replaces the whole canvas, so it cannot sit in
an edit session beside staged placements for the old mode. The client refuses it while the same
view has unsaved edits and shows the counts from `GET …/mode-change`; the server applies it in
one transaction. A Layer 2 view gets the same confirmation although it loses only hand-tuned
positions.

**Racks.** Rack mode was added in the same review: racks side by side, U numbers on the rail, a
dropped device lands as 1U and resizes by its top / bottom edge, Rotate flips a rack front /
rear, racks reorder by dragging. A device occupies both faces unless marked half depth; the
cable-management placeholder (no asset) defaults to half depth. The server re-checks bounds and
overlap on every save, and refuses a rack shrink that would strand a placement rather than
silently dropping it.

Later the same day (2026-11-10) the operator asked for a **Third party** rack item, a named
box for equipment Polaris does not monitor (`kind:"thirdParty"` with a `label`, full depth by
default like a device), and reworked the rack header: Rotate became a Front / Back button that
names the face on show, the name and the "42U" are each double-clicked to edit, and every rack
after the first carries an × to delete it. The operator then asked that a device racked on the
front leave the same U free on the back, so every placement became half depth unless marked full
(it had been full depth for a device and a third-party box, half for cable management);
placements already saved keep the depth they were saved with.
