# Login

The sign-in screen: the product mark, a title, the credential fields and the actions.

Markup is `.login-shell` inside `.app` (with an empty `data-tab`, which hides the
navigation bar). It holds either `.brand-logo` — an `<img>` of the organisation's own
logo, or `.brand-logo.brand-mark` for a wide wordmark — or the `.logo-mark` fallback
tile; then an `h2`, a `.sub` line, `.tf-outlined.full-field` inputs, the buttons, and a
`.divider` between alternative sign-in routes.

- When the keyboard opens the app adds `.kb-open` to `.app` and the shell pins to the
  top, sized by the runtime `--vv-height`.
- No logo came across with the source, so this preview uses the `.logo-mark` tile with a
  stand-in glyph. The field labels and button wording here are illustrative.
