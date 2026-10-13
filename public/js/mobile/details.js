// public/js/mobile/details.js — Detail-route renderers (asset, subnet,
// block, site).
//
// Same shape as tab specs in tabs.js: each entry is `{ renderTopbar, render }`
// keyed by the leading hash segment (`#asset/<id>` → `asset`).
//
// Phase 2 ships placeholder bodies so search results can navigate somewhere
// useful before the real screens land. Each later phase replaces a
// placeholder with the real renderer:
//   Phase 3 → site
//   Phase 5 → asset
//   Phase 8 → subnet
// `block` has no mobile destination on the roadmap — it stays a "view on
// desktop" placeholder indefinitely.

(function () {
  function backTopbar(title) {
    return ''
      + '<div class="m3-topbar">'
      + '  <div class="leading">'
      + '    <button class="icon-btn" id="back-btn" aria-label="Back"><svg viewBox="0 0 24 24"><use href="#i-back"/></svg></button>'
      + '  </div>'
      + '  <div class="title">' + escapeHtml(title) + '</div>'
      + '  <div class="trailing"></div>'
      + '</div>';
  }

  function placeholderBody(headline, body, viewOnDesktopHash) {
    var dh = viewOnDesktopHash ? viewOnDesktopHash : "";
    var btn = dh
      ? '<a class="btn btn-tonal" href="' + dh + '" style="margin-top:24px;">Open in desktop app</a>'
      : '';
    return ''
      + '<div class="empty-state" style="padding-top:64px;">'
      + '  <div class="icon"><svg viewBox="0 0 24 24"><use href="#i-construction"/></svg></div>'
      + '  <div class="ttl">' + escapeHtml(headline) + '</div>'
      + '  <div class="desc">' + escapeHtml(body) + '</div>'
      + '  ' + btn
      + '</div>';
  }

  // Wire the back button on detail pages. Call from each render().
  function wireBack(fallbackTab) {
    var btn = document.getElementById("back-btn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      // Prefer browser-native back so the user returns to the previous tab
      // (search results, assets list, etc.) with their scroll position
      // intact. Fall back to the named tab when there's nothing to pop —
      // happens when the URL was opened directly.
      if (window.history.length > 1) window.history.back();
      else PolarisRouter.go(fallbackTab || "alerts", { replace: true });
    });
  }

  // escapeHtml is the canonical global from api.js (loaded first on every page).

  // Each detail spec carries an optional `parentTab` so app.js can keep
  // the corresponding nav-bar item visually active while the operator is
  // inside the detail. Specs without a parentTab leave the navbar
  // unhighlighted (e.g. block detail isn't part of any mobile tab).

  // ─── Asset detail ──────────────────────────────────────────────────────
  // Real spec lives in /js/mobile/asset-detail.js. Falls back to a
  // placeholder if the module didn't load (script-order regression check).
  var Asset = (window.PolarisAssetDetail && window.PolarisAssetDetail.spec) || {
    parentTab: "assets",
    renderTopbar: function () { return backTopbar("Asset"); },
    render: function (body, ctx) {
      var id = ctx.route.parts[0] || "";
      body.innerHTML = placeholderBody(
        "Asset detail not loaded",
        "PolarisAssetDetail module is missing — check script order. Asset id: " + id,
        "/assets.html#view=asset:" + id
      );
      wireBack("alerts");
    },
  };

  // ─── Subnet detail ─────────────────────────────────────────────────────
  // Real spec lives in /js/mobile/subnet-detail.js.
  var Subnet = (window.PolarisSubnetDetail && window.PolarisSubnetDetail.spec) || {
    parentTab: null,
    renderTopbar: function () { return backTopbar("Network"); },
    render: function (body, ctx) {
      var id = ctx.route.parts[0] || "";
      body.innerHTML = placeholderBody(
        "Network detail not loaded",
        "PolarisSubnetDetail module is missing — check script order. Subnet id: " + id,
        "/subnets.html"
      );
      wireBack("alerts");
    },
  };

  // ─── Block detail (desktop-only) ───────────────────────────────────────
  var Block = {
    parentTab: null,
    renderTopbar: function () {
      return backTopbar("Block");
    },
    render: function (body, ctx) {
      var id = ctx.route.parts[0] || "";
      body.innerHTML = placeholderBody(
        "Blocks live on desktop",
        "IP block management is a low-frequency operation — open the desktop app to view block details and utilization.",
        "/blocks.html"
      );
      wireBack("alerts");
    },
  };

  // ─── Map site ──────────────────────────────────────────────────────────
  // Delegates to PolarisMapTab.renderForSite — same map UI as the Map tab,
  // but pre-opens the bottom sheet for the named site so deep-links from
  // search land where the operator expected. Same top bar as the Map tab
  // (title + the shell's search magnifier).
  var Site = {
    parentTab: "map",
    renderTopbar: function () {
      return (window.PolarisMapTab && PolarisMapTab.spec && PolarisMapTab.spec.renderTopbar)
        ? PolarisMapTab.spec.renderTopbar() : "";
    },
    render: function (body, ctx) {
      if (!window.PolarisMapTab) {
        body.innerHTML = placeholderBody(
          "Map module not loaded",
          "PolarisMapTab is missing — check script load order in mobile.html.",
          ""
        );
        return;
      }
      window.PolarisMapTab.renderForSite(body, ctx);
    },
  };

  // ─── Topology (per-site Cytoscape graph) ───────────────────────────────
  // Real spec lives in /js/mobile/topology-tab.js. Falls back to a
  // placeholder if the module didn't load.
  var Topology = (window.PolarisTopologyTab && window.PolarisTopologyTab.spec) || {
    parentTab: "map",
    renderTopbar: function () { return backTopbar("Topology"); },
    render: function (body, ctx) {
      var id = ctx.route.parts[0] || "";
      body.innerHTML = placeholderBody(
        "Topology module not loaded",
        "PolarisTopologyTab is missing — check script load order in mobile.html.",
        "/map.html#site=" + encodeURIComponent(id) + "&topology=1"
      );
      wireBack("map");
    },
  };

  window.PolarisDetails = {
    asset: Asset,
    subnet: Subnet,
    block: Block,
    site: Site,
    topology: Topology,
  };
})();
