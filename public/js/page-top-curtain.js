/* Measures the sticky top bar for its curtain (styles.css, "The curtain").
 *
 * The curtain is html::after: a copy of the page's ground drawn over content
 * that scrolls under .page-top-sticky. The bar is pinned from the first pixel
 * (it never moves on screen), so the curtain is a plain position:fixed box
 * that only needs the bar's height and the content column's left edge. This
 * script measures those two and sets them on <html> as --page-top-h /
 * --page-top-l (both registered `inherits: false`, so a change restyles <html>
 * and its pseudo-elements, not the page), then sets data-page-top-curtain,
 * which is what turns the curtain on and the fallback blur off.
 *
 * It replaced CSS anchor positioning (2026-10-06). Firefox scrolls on its
 * compositor and moved the anchored curtain WITH the scroll until the main
 * thread re-ran layout, so content showed through the bar for a moment on
 * every scroll and then vanished. A fixed box with measured insets has no
 * scroll-linked position for any browser to get wrong.
 *
 * Re-measured only when the bar or the column changes size (a header that
 * wraps, a tab strip that grows, a window resize) — never on scroll. Without
 * this script the bar keeps its blur.
 */
(function () {
  "use strict";
  var bar = document.querySelector(".page-top-sticky");
  if (!bar || typeof ResizeObserver !== "function") return;
  var root = document.documentElement;
  var column = bar.parentElement;

  function measure() {
    var b = bar.getBoundingClientRect();
    var c = column.getBoundingClientRect();
    root.style.setProperty("--page-top-h", Math.round(b.height) + "px");
    root.style.setProperty("--page-top-l", Math.max(0, Math.round(c.left)) + "px");
    root.setAttribute("data-page-top-curtain", "");
  }

  var ro = new ResizeObserver(measure);
  ro.observe(bar);
  ro.observe(column);
  window.addEventListener("resize", measure);
  measure();
})();
