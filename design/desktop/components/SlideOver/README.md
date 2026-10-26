# SlideOver

A slide-over is the entity detail view (an asset, a network, a block) that stays open while the user works the page underneath: a fixed header with the name, a meta line and the tab strip, over a body that scrolls.

- **Structure** — `.slideover-overlay.open > .slideover.open > .slideover-header (.slideover-header-top: h3 + close; .slideover-meta; .slideover-tabs > .page-tabs > .page-tab)` then `.slideover-body`. The body has zero padding: wrap its content in one div padded `1rem 1.25rem 1rem 2.5rem`.
- **Tabs** — in the header so they never scroll away, in a fixed order, shown only when the entity has that data. Too many for the width scroll sideways rather than wrap.
- **Sections** — each tab is a stack of sections. A heading names the source (a `.badge-readonly`: method · cadence · tier) and the freshness ("updated 38s ago", in `color-warning` once a cadence is missed); a chart section adds right-aligned range buttons; a snapshot section (Wireless, MAC table, ARP table) adds a Poll button for roles that can poll.
- **Stale banner** — inside the section, before its chart or table, on the empty state as well.
- **Stacking** — every slide-over shares one z-index (1050); DOM order stacks them, opening raises one, and Escape closes only the topmost. Not `aria-modal`, no hard focus trap.
