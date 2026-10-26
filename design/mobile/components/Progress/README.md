# Progress

Indeterminate progress: the spinner, the full-screen loading state, and pull-to-refresh.

`.spinner` is a 36px ring in `md-primary` over an `md-outline-variant` track.
`.loading-screen` centres one in whatever flex space it is given. `.ptr-indicator` is the
pull-to-refresh circle at the top of `.app-body`: `.ready` once the pull passes the
threshold, `.refreshing` while the refresh runs (its `.ptr-svg` glyph spins).

- The pull-to-refresh indicator is hidden by default; the app's script sets its opacity
  and offset as the user pulls. This preview pins those inline to show each state.
