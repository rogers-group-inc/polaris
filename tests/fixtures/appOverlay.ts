/**
 * Load the REAL `buildOverlay` out of public/js/app.js into a test's globals.
 *
 * `buildOverlay` is the shared stacked-modal builder (app.js loads on every
 * page). A DOM test that needs it cannot eval the whole of app.js — that file
 * boots the app shell — and stubbing it would make the assertions about overlay
 * structure and z-index rungs vacuous, since the stub would be the thing under
 * test. So slice the one function out and eval that.
 *
 * The slice is brace-balanced rather than line-counted, so it survives edits to
 * the function body; it throws loudly if the function is renamed or moved, which
 * is the signal a caller wants rather than a silently absent global.
 */
import { appSource } from "../unit/_appSource.js";

function appOverlaySource(): string {
  const src = appSource();
  const start = src.indexOf("function buildOverlay(");
  if (start === -1) {
    throw new Error("buildOverlay not found in public/js/app.js — was it renamed or moved?");
  }
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("buildOverlay in public/js/app.js has unbalanced braces");
}

/**
 * Eval the real buildOverlay into the current global scope. The caller must
 * already have stubbed the globals it reads: `escapeHtml`, `_trapFocus`,
 * `_focusFirstIn`, and optionally `_ensureLockButton` / `isPanelLocked` /
 * `flashModalCloseBtn` (those three are typeof-guarded inside the function).
 */
export function installAppOverlay(): void {
  (0, eval)(appOverlaySource());
}
