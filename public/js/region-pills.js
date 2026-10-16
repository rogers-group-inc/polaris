/**
 * public/js/region-pills.js
 *
 * One place that turns a region NAME into a colored pill.
 *
 * Region tags are read on more than one surface now — the Users page renders a
 * user's / role's scope, and the Device Map renders the viewer's own — and a
 * pill that comes out one color on one page and another color on the next
 * reads as a different region. So the catalogue fetch, the name→hex lookup and
 * the hex→rgba math live here instead of being re-derived per page.
 *
 * `GET /map/regions` is gated `mapRegions:read`, which a viewer holding only
 * `deviceMap:read` need not have. A failed (or never-run) load is therefore not
 * an error state: every pill falls back to the neutral hue, which is already
 * what a hand-typed tag outside the catalogue renders as.
 */
(function () {
  var NEUTRAL = "#9e9e9e";
  var byName = {};      // region name → stored hex color ("" when the region has none)
  var loaded = false;

  async function load() {
    try {
      if (!window.api || !window.api.mapRegions || typeof window.api.mapRegions.list !== "function") {
        return byName;
      }
      var regions = await window.api.mapRegions.list();
      var next = {};
      (regions || []).forEach(function (r) {
        if (r && r.name) next[r.name] = r.color || "";
      });
      byName = next;
      loaded = true;
    } catch (_) {
      byName = {};
    }
    return byName;
  }

  // The stored hex for a region, or the neutral fallback so a tag that isn't
  // in the catalogue (hand-typed, or the catalogue was unreadable) still
  // renders as a recognizable pill rather than disappearing.
  function colorFor(name) {
    var c = byName[name];
    if (c && /^#[0-9a-fA-F]{6}$/.test(c)) return c;
    return NEUTRAL;
  }

  // "#rrggbb" → "r, g, b" so it can drop into rgba(...) for the translucent
  // fill while the border + text stay full-strength.
  function rgbTriplet(hex) {
    var m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex || "");
    if (!m) return "158, 158, 158";
    return parseInt(m[1], 16) + ", " + parseInt(m[2], 16) + ", " + parseInt(m[3], 16);
  }

  // The inline half of a `.hue-pill` (styles.css): only `--hue`. The class
  // draws fill, label and border, clamping the label's lightness per theme so
  // a pale region colour (a yellow) reads on daylight and a deep one on dark.
  function hueStyle(name) {
    return "--hue:" + colorFor(name);
  }

  // One badge, optionally carrying a title (callers use it to say WHERE the
  // region came from — the account, the role, or an IdP group).
  function pill(name, title) {
    return '<span class="badge hue-pill"' +
      (title ? ' title="' + window.escapeHtml(title) + '"' : "") +
      ' style="' + hueStyle(name) + '">' +
      window.escapeHtml(name) +
    '</span>';
  }

  // `titleFor` is optional: (name) → tooltip string.
  function html(names, titleFor) {
    if (!Array.isArray(names) || names.length === 0) return "";
    return names.map(function (n) {
      return pill(n, typeof titleFor === "function" ? titleFor(n) : "");
    }).join("");
  }

  window.PolarisRegionPills = {
    load: load,
    isLoaded: function () { return loaded; },
    catalog: function () { return byName; },
    names: function () { return Object.keys(byName).sort(); },
    colorFor: colorFor,
    rgbTriplet: rgbTriplet,
    hueStyle: hueStyle,
    pill: pill,
    html: html,
  };
})();
