# UI canon — mobile PWA patterns

Verbatim from UI-CANON.md. Each pattern: **What it is** / **Canonical implementation** (`path/file.js → symbol()`, no line numbers) / **Key conventions** / **When adding a new instance**. Read `design/POLARIS-UI-GUIDE.md` first for the portable contract these implement.

## Mobile bottom sheet

**What it is:** A modal slide-up panel anchored to the bottom of the viewport on the mobile SPA. Dismissed by tapping the scrim, tapping the X button, or swiping the sheet down. Used for the Device Map site detail, asset interface drilldown, reservation edit + create-by-IP, subnet reserve, topology node detail, the per-asset alerts sheet, and the full asset detail screen.

**Canonical implementation:** `openSiteSheet()` in [public/js/mobile/map-tab.js](public/js/mobile/map-tab.js) + matching `closeSiteSheet()` — use this for the common two-state (open/dismiss) sheet.

**Three-state minimizable variant:** the asset detail sheet (`PolarisAssetDetail.open(id)` in [public/js/mobile/asset-detail.js](public/js/mobile/asset-detail.js)) extends the pattern with a **peek** state for content-heavy sheets the operator wants to keep open while using the page behind. Scrim tap → minimize (slides the sheet down to its header band, measured into `--asset-peek-y`, and hides the scrim so the searchbar is reachable); peek-bar tap → expand; close button → dismiss. **Two-stage swipe-down:** the first swipe-down from expanded snaps to peek, the second swipe-down from peek dismisses. **Swipe-up from peek re-expands** (in expanded state baseline is 0, so upward gestures fall through to native scroll). Wired through `attachSwipeToDismiss`'s `onSwipeDown` / `onSwipeUp` opts (override the default translate-100% animation and the default release-for-native-scroll respectively) plus `baselineTranslate` opt (so drags from a peeked position continue from the peek offset instead of jumping back to natural). Minimize never tears down the DOM, so charts/scroll/per-feature state survive. Capped at 80vh (vs. the generic `.sheet`'s 90vh) and anchored at `bottom: var(--navbar-h) + safe-area` so both expanded and peek states stop at the navbar's top edge instead of covering it. The bottom nav (`.m3-navbar`, z-index 950) sits above the asset sheet (901) and its scrim (900) — so the navbar stays visible + tappable while the asset is open — but below the generic `.scrim`/`.sheet` (1000/1001), so deep drilldowns still take the full screen. Model new minimizable sheets on this; keep simple sheets on `openSiteSheet`.

**Key conventions:**
- DOM shape: one `.scrim` and one `.sheet` element, both appended to `document.body` with unique IDs (`<feature>-sheet-scrim` + `<feature>-sheet`). Close = `remove()` both.
- The sheet's first child is `<div class="sheet-handle"></div>` — the small grabber bar that both signals draggability and is the always-on swipe-dismiss start zone.
- Next comes a `display:flex` header row with the title block on the left and an icon `<button class="icon-btn" id="<feature>-sheet-close" aria-label="Close">` carrying `<svg><use href="#i-close"/></svg>` on the right.
- Three close paths, all calling the same close function: `scrim.addEventListener("click", closeXxx)`, the close button click, and `PolarisTabs.attachSwipeToDismiss(sheet, closeXxx)`. The swipe helper lives in [public/js/mobile/tabs.js](public/js/mobile/tabs.js).
- CSS comes from [public/css/mobile.css](public/css/mobile.css) — the `.scrim`, `.sheet`, `.sheet-handle`, `.sheet-title` rules. Don't invent new container classes; reuse these so the swipe helper's transform composes correctly with the `sheet-in` open keyframe.
- Forms inside the sheet keep their native gesture handling — the swipe helper opts out of `input`, `textarea`, `select`, and `[contenteditable=true]` so iOS text-cursor drag and selection handles work.
- **A sheet is also how the phone asks a question.** `window.prompt` / `window.confirm` are unstyled and suppressed outright in some installed PWAs, which leaves an operator unable to finish an action with no visible reason why — so `promptAckNote` and `confirmClear` in [public/js/mobile/alerts.js](public/js/mobile/alerts.js) are `.sheet`s stacked at z-index 1010/1011 over whatever opened them, and they follow `showPrompt`'s null-vs-empty contract (dismissed resolves `null`, a blank REQUIRED field is refused with a stated reason rather than a bare red border). Reuse those two rather than reaching for the native dialogs; the More tab's fleet-wide alerts list delegates to the same note prompt, which is what keeps the `requireAckNote` rule in one place.
- **Mobile SD-WAN charts are intentionally simplified.** The asset detail sheet's stacked SD-WAN sheet (`openSdwanSheet` in [public/js/mobile/asset-detail.js](public/js/mobile/asset-detail.js)) renders the per-member **Latency / Jitter / Packet-loss** numeric charts (driven by `loadSdwanPerfSla`), but it deliberately omits the desktop SD-WAN tab's **rule member-selection categorical timeline** — the mobile chart helper is numeric-only, so the sheet shows each rule's *current* selected member instead of its failover history (see the "Out of scope for v1" header comment in `asset-detail.js`). When porting a categorical/timeline chart to mobile, expect to fall back to a current-state list rather than reusing the numeric chart helper.

**When adding a new instance:**
- Mirror the DOM shape — `.sheet-handle` first, header row with `icon-btn` close button second.
- Wire all three close paths: scrim click, close-button click, and `PolarisTabs.attachSwipeToDismiss(sheet, closeXxx)`.
- The close function `remove()`s both the scrim and the sheet by ID; idempotent so double-fire from a swipe finishing while the user also taps scrim is safe.
- If the sheet is scrollable, the swipe-dismiss helper handles "scroll first, dismiss only when at top" automatically — no extra wiring needed.

---

## Mobile pull-to-refresh

**What it is:** Touch-pull-down on a mobile tab or detail page to re-fetch its data. MD3-style: only a small circular puck moves, body content stays put. The puck rotates with pull progress, flips primary-tinted past the trigger threshold, spins while the caller's onRefresh promise is in flight.

**Canonical implementation:** `PolarisTabs.installPullRefresh(scrollEl, onRefresh)` in [public/js/mobile/tabs.js](public/js/mobile/tabs.js). Wired into the route lifecycle by `installPtrForSpec(spec, ctx)` in [public/js/mobile/app.js](public/js/mobile/app.js) — every route change releases the prior handle + installs a fresh one if the new spec has `onPullToRefresh`.

**Key conventions:**
- Tab specs and detail specs opt in by exposing `onPullToRefresh(ctx)` that returns a Promise. The PTR puck spins until the promise settles; sync returns / non-promises get a 600 ms held-puck fallback.
- Optional `enablesPullToRefresh(ctx)` predicate disables install entirely for one route within a multi-page spec (the More tab uses this to skip its static root menu while still PTR-ing the blocks / subnets / events sub-pages).
- Only tracks a gesture that starts with `scrollEl.scrollTop === 0` — pulling from mid-scroll is left to the browser as normal scroll behavior.
- Form controls (`input`, `textarea`, `select`, `[contenteditable=true]`) opt out so iOS text-cursor drag still works inside any forms on the page.
- Click suppression is left to the browser: a touchmove past ~10 px already cancels the underlying button's `click`, so no `preventDefault` is needed — listeners stay `passive: true`.
- `.app-body` carries `overscroll-behavior-y: contain` so iOS rubber-band doesn't compete with the pull gesture.
- CSS (`.ptr-indicator`, `.ptr-circle`, `.ptr-svg`, `.ptr-indicator.ready`, `.ptr-indicator.refreshing`) lives in [public/css/mobile.css](public/css/mobile.css).
- Skipped on routes where it makes no sense or where touch is owned by another library: Map tab (Leaflet captures touch), Topology tab (Cytoscape captures touch), Site detail (delegates to Map), Search tab (results are query-driven), More root menu (static), Block detail (placeholder), Login.

**When adding a new instance:**
- Define `onPullToRefresh(ctx)` on the tab or detail spec. Return the Promise from the same data-load function the topbar Refresh button uses (or equivalent) — don't fork a separate refresh path.
- The spec's render-time DOM must still be present when the promise resolves; loaders that target `getElementById` should be safe because the user can't navigate away during the PTR gesture without releasing first.
- Whenever the refresh action has variant behavior depending on user role / route parts (e.g. subnet detail's gate-side refresh vs. plain re-pull, or More's per-sub-page dispatch), branch inside `onPullToRefresh` rather than inside the install wiring. Use `enablesPullToRefresh` only for "no PTR at all on this route."

---

## On-screen keyboard fit (login/form screens)

**What it is:** Keeping the focused field and its submit button above the on-screen keyboard on a viewport-height-locked screen. iOS Safari (and the installed PWA) do **not** shrink the layout viewport when the keyboard opens, so `100vh` / `height:100%` still measure the whole screen and a vertically-centered card doesn't move — the password field and Sign in button end up behind the keyboard. Android Chrome shrinks the layout viewport itself and needs no help.

**Canonical implementations:** the IIFE at the `visualViewport` block in [public/js/login.js](public/js/login.js) (desktop login page, pins `.login-wrapper`) and the `installKeyboardFit` block in [public/js/mobile/auth.js](public/js/mobile/auth.js) (mobile SPA login + TOTP, pins `.app`). CSS lives beside each: the `.kb-open` rules inline in [public/login.html](public/login.html) and in [public/css/mobile.css](public/css/mobile.css). Behavior is unit-tested in [tests/unit/mobileLoginKeyboardFit.test.ts](tests/unit/mobileLoginKeyboardFit.test.ts).

**Key conventions:**
- Measure with `window.visualViewport` — the only API that reports the actually-visible rect on both engines. Treat the keyboard as open when `max(window.innerHeight, documentElement.clientHeight) - vv.height > 120`. The threshold is what tells a keyboard from a collapsing URL bar, and it is also what keeps Android out: there the layout viewport shrinks too, the delta stays ~0, and the native behavior is left alone.
- Pin the container to the visible rect through CSS custom properties (`--vv-height` / `--vv-offset-top`), never by writing layout properties from JS. Include `offsetTop` — iOS scrolls the layout viewport under the keyboard even when the page can't scroll.
- **Top-align in `.kb-open`.** This is required, not cosmetic: overflow above a `justify-content:center` flex item is unreachable because `scrollTop` can't go negative. Shortening the container without flipping the alignment trades one hidden control for another.
- Coalesce every handler through one `requestAnimationFrame` (`if (!pending) pending = rAF(apply)`), bound to `resize` + `scroll` on the viewport, `orientationchange`, and `focusin`. `focusin` is what re-measures when a step swaps the form in place (password → TOTP) with the keyboard already up.
- `scrollIntoView({block:"end"})` the focused element's **form**, and only when that target differs from the last one scrolled — re-running it on every viewport event fights the user's own scrolling.
- Where the screen is replaced wholesale with no teardown hook (the mobile SPA's auth screens), re-check on every measurement that the form is still mounted and unpin when it isn't, rather than trusting a lifecycle callback. Clear the class explicitly on the success path too: the next viewport event may be a long way off, and a stale pin sizes the authenticated shell to a dead height.

**When adding a new instance:** reuse the threshold, the rAF coalescing, and the top-align flip verbatim — the failure modes above are all silent. Anything inside a scroll container that already has room to scroll doesn't need this at all; the browser's own scroll-into-view handles it.

---

## Theme strip (the phone's theme control)

**What it is:** The 24-hour clockface unrolled into a flat strip that travels LEFT under a fixed centre marker — since 2026-09-21 the desktop's sidebar band is the same control, so this is no longer the phone's own geometry, on the More tab under “Appearance”. One tap steps to the next selectable theme; there is no menu and no on/off state. It replaced a two-line Dark/Light row.

**Canonical implementation:** `window.PolarisTheme` in [public/js/mobile/app.js](public/js/mobile/app.js) — `set()` / `advance()` / `seatStrips()` / `get()`, with `_paintThemeStrips()` and `_advanceThemeStrips()` doing the travel; markup in `renderMenu()` in [public/js/mobile/more-tab.js](public/js/mobile/more-tab.js); `.theme-strip*` rules in [public/css/mobile.css](public/css/mobile.css). The desktop counterpart is `advanceTheme()` + `_paintThemeBands()` + `.theme-band` in [public/js/app.js](public/js/app.js) — same clock, same palettes, same one-way rule and now the same geometry, implemented twice because neither document loads the other's JavaScript. `tests/unit/themeBandParity.test.ts` reads both files and fails when the two halves drift: the position tables, the artwork, the 800ms, the one-strip anchor, the seam and the forward-only loop.

**Key conventions:**
- **The art is repeated THREE times in the track.** `_paintThemeStrips` anchors the track one strip width left of the marker, so copy two sits under it and copies one and three cover the window on either side. With two copies the right-hand half of the window falls off the end of the art as the position approaches the seam, and bare surface shows beside the engraving. (The kit's own CSS comment and apply-prompt say “twice”; its JS says three and its arithmetic requires three. Three is right.)
- **The seam is what makes a finite strip endless.** The art loops, so travelling past the end of one copy lands on identical pixels in the next; once a leg lands past it the JS subtracts exactly ONE strip width with the transition switched off. It has to be a whole strip (anything else lands on different pixels and the jump is visible) and it must never run mid-transition — `_advanceThemeStrips` settles an owed normalisation before measuring the next leg, or that leg starts a full strip width from where it looks.
- **Positions are quarter-spaced** (`THEME_STRIP_POS`): the engraving is a 24-hour clock, so six hours is a quarter of it and the two faces land half a strip apart. Editing one position alone puts the marker beside a face instead of on it — keep the spacing and move the anchor.
- **Forward only.** A target “behind” the current position is reached by continuing off the end of the strip, never by running backwards; that is the whole reason the day reads as moving forward.
- **Widths are MEASURED, not assumed** — the art is a 2x asset sized by height, so its rendered width depends on the row height and the device pixel ratio. Before the image loads there is nothing to measure, so the painter re-seats on its `load` event rather than giving up; otherwise the first tap travels from the strip's left edge instead of from the theme showing.
- **The tap is delegated** from `document`. Never add a listener to a `.theme-strip` as well — one tap would advance two themes.
- **A strip rendered after boot must be seated.** The More tab is built on demand, so `renderMenu` calls `PolarisTheme.seatStrips()`; without it the track has no position until something else paints it.
- **The caption span carries BOTH classes** — `.name` is what the CSS styles, `.theme-strip-name` is what `PolarisTheme.set` repaints by class so every strip on the page updates. An id there matches only one and the caption silently stops following the theme.
- **`PolarisTheme.get()` answers a FAMILY and resolves it through the theme list**, never by naming ids. map-tab's basemap pair and topology-tab's node palette both read it, and the `afternoon` waypoint has to answer “light” or both flip to dark halfway through the sweep.
- **A transit palette is applied but never persisted**, so a reload mid-sweep lands on a real theme rather than on a waypoint nothing can name.
- **`data-theme` now changes once PER LEG, not once per tap.** Anything watching it with a MutationObserver — map-tab's basemap swap and topology-tab's graph re-render both do — runs twice across a noon → nightfall sweep. Both are safe today (the strip lives on the More tab, so neither surface is open when it is tapped, and morning/noon/afternoon are all one basemap family so the tiles swap once), but a new observer that does expensive work per change has to expect a waypoint, and a new TRANSIT theme in a different family would make the basemap flip mid-sweep. Prefer the `themechange` event or a family comparison over reacting to every attribute write.

**When adding a new instance:** there should only be one, but a second surface rendering a `.theme-strip` needs no wiring — the delegated listener and the class-wide repaint already cover it; just call `PolarisTheme.seatStrips()` once it is in the DOM. Adding a THEME means a `MOBILE_THEMES` (or `MOBILE_TRANSIT_THEMES`) entry, a `THEME_STRIP_POS` position, a `--md-*` block in mobile.css, and the desktop's matching `THEMES` / `THEME_BAND_POS` / token block — the two surfaces' theme lists move together, and the two position tables are now the same numbers, so the parity test fails until both are edited. Keep the quarter spacing: a fifth theme means re-anchoring all of them, on both screens, against the same engraving.

---
