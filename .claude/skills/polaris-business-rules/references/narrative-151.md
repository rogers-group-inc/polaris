# Business rule 151 — full narrative

> Written 2026-11-10 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 151](#rule-151) — What is mounted on a wall is a polygon on a 1-inch grid, and no two share a cell

## Rule 151 — What is mounted on a wall is a polygon on a 1-inch grid, and no two share a cell

Wall mode (2026-11-10, operator request) is a flat board, a closet backboard, a pegboard or a junction box's backplate, where gear is mounted side by side. Each item is a polygon the operator reshapes like a map region, and items cannot overlap because they are mounted flat.

Overlap is decided on the 1-inch pegboard grid every corner snaps to: an item claims a cell when the cell's centre is inside it, and two items overlap when they claim a common cell. That is exact for the shapes the editor makes, lets neighbours share an edge, handles concave shapes (an L-shaped patch panel), and is a few lines that run identically in the browser and on the server.

Racks can be mounted too, with their size in U and optionally the Rack view they open, so a wall rack is a doorway into that view. The rack's footprint is fixed at 24 in wide and 1.75 in per U plus a 3 in frame (operator default, 2026-11-10).
