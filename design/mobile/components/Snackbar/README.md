# Snackbar

A brief message that rises from the bottom of the screen, with at most one action.

Markup is `.snackbar` holding the message and an optional `button.action`. Add `.error`
for a failure. It is fixed 16px from each side and `navbar-h` + 12px from the bottom, so
it clears the navigation bar, and it sits above every other layer.

- One line of text, one action. Anything longer belongs in a sheet.
- The preview shows each in its own box; in the app only one shows at a time.
