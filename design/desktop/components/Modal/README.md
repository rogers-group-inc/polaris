# Modal

Modals are for forms and confirmations, in four shapes: a form, a tabbed dialog, a wizard, and a confirmation stacked over another dialog.

- **Form** — `.modal-overlay.open > .modal > .modal-header (h3 + .modal-close) + .modal-body (.form-group …) + .modal-footer`.
- **Tabbed** — `.modal-body > .page-tabs > .page-tab` then one `.page-tab-panel.active`; the strip pins to the top of the body. Every integration dialog: General first, Test Connection at the far left of the footer, Cancel, then Create / Save Changes.
- **Wizard** — `.modal-body > .stepper` of `.stepper-step > .stepper-num` joined by `.stepper-line`, then one `.step-panel.visible`. Steps take `.active`, `.done` and `.clickable` (visited steps). Footer: Back at the far left, Cancel, Next; Enter and → mean Next until the last step.
- **Confirm** — a small `.modal` on its own overlay at z-index 1300 above the dialog that asked; a destructive one uses `.btn-danger`.

Widths: `.modal` 480px, `.modal-wide` 672px, `.modal-large`, `.modal-xl`. Titles read "<Action> <Thing>" in title case. Every dialog restores focus on close, traps Tab, and carries the panel-lock button beside its ×.
