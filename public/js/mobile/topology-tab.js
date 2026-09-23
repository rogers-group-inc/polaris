// public/js/mobile/topology-tab.js — Mobile topology surface.
//
// Reached via the `topology/<siteId>` detail route from the Map tab's
// site bottom sheet. Lazy-loads Cytoscape + dagre + cytoscape-dagre on
// first open (~670KB combined, kept off the initial bundle so users
// who never open topology don't pay for it).
//
// Differences vs. the desktop topology modal in /js/map.js:
//   - Top-to-bottom dagre layout (rankDir: "TB") instead of left-to-right.
//     A phone's tall viewport is happier with vertical flow.
//   - Initial viewport zooms to the FortiGate (or to a focus node when the
//     URL carries ?q=<term>) instead of cy.fit() on the whole graph. A
//     20-switch site is otherwise unreadable on a 375px screen.
//   - No drag-to-reposition / layout persistence. Mobile users don't
//     manually arrange node layouts. The shared server layouts the desktop
//     modal saves (the /topology payload's `savedLayouts`) are deliberately
//     NOT applied here either: they're pixel coords in the desktop's
//     left-to-right orientation, and this surface renders transposed
//     (lane → x, depth → y), so applying them would draw the site sideways.
//   - No screenshot, no fullscreen toggle (the surface IS fullscreen).
//   - Node tap opens a bottom sheet instead of a right-rail info panel,
//     with a "View asset" action that pivots to the asset detail page.
//   - Search input is in the top app bar; result tap pulses + zooms.
//
// Element + stylesheet construction is shared with desktop via
// public/js/topology-render.js so a new node/edge type only needs to be
// added in one place.

(function () {
  // Module state. Reset on every render() so navigating in/out of the
  // topology surface doesn't leak the previous instance.
  var _cy = null;
  var _topoData = null;
  var _siteId = null;
  var _siteName = null;
  var _focusTerm = null;
  var _resizeHandler = null;
  var _themeObserver = null;
  var _searchDebounce = null;
  var _suggestState = { open: false, items: [], index: -1 };
  var _cyPromise = null;

  // ─── Lazy loaders ──────────────────────────────────────────────────────
  // Inline-duplicated from map-tab.js to keep each tab module
  // self-contained. The two helpers are 7 lines combined; extracting them
  // would just create a coordination dependency for no real reuse benefit.
  function _loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      var s = document.createElement("script");
      s.src = src;
      s.async = false;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("Failed to load " + src)); };
      document.head.appendChild(s);
    });
  }

  function loadCytoscape() {
    if (window.cytoscape && window.cytoscapeDagre && window._cytoscapeDagreRegistered) {
      return Promise.resolve(window.cytoscape);
    }
    if (_cyPromise) return _cyPromise;
    _cyPromise = (async function () {
      await _loadScript("/js/vendor/cytoscape.min.js");
      await _loadScript("/js/vendor/dagre.min.js");
      await _loadScript("/js/vendor/cytoscape-dagre.js");
      if (window.cytoscape && window.cytoscape.use && window.cytoscapeDagre && !window._cytoscapeDagreRegistered) {
        window.cytoscape.use(window.cytoscapeDagre);
        window._cytoscapeDagreRegistered = true;
      }
      return window.cytoscape;
    })();
    return _cyPromise;
  }

  // ─── Detail spec ───────────────────────────────────────────────────────
  // Registered into window.PolarisDetails by details.js. parentTab "map"
  // keeps the Map nav-item highlighted while the operator is inside the
  // topology view.
  var Topology = {
    parentTab: "map",
    renderTopbar: function () {
      // Empty — the topology surface renders its own floating chrome
      // (close FAB + search bar) over the graph.
      return "";
    },
    render: function (body, ctx) {
      // Parse "topology/<siteId>?q=<focusTerm>". The router splits on "/"
      // but doesn't carve query strings off the trailing part, so
      // parts[0] arrives as "<siteId>?q=<focusTerm>" — strip it here.
      var rawId = (ctx.route && ctx.route.parts && ctx.route.parts[0]) || "";
      var qIdx  = rawId.indexOf("?");
      _siteId   = qIdx >= 0 ? rawId.slice(0, qIdx) : rawId;
      _siteName = null;
      _focusTerm = parseFocusTermFromHash();

      if (!_siteId) {
        body.innerHTML = '<div class="empty-state" style="padding-top:64px;"><div class="ttl">Missing site id</div></div>';
        return;
      }

      // Fullbleed mode hides the topbar slot AND the bottom navbar so the
      // topology owns the whole viewport. app.js's setActiveTab on the
      // next route change restores the navbar; we reset on close ourselves
      // for the fast path (close FAB → router.go("site/<id>")).
      var appEl = document.getElementById("app");
      if (appEl) appEl.dataset.tab = "__fullbleed";

      body.innerHTML = ''
        + '<div class="topo-screen" id="topo-screen">'
        + '  <div class="topo-bar">'
        + '    <button class="icon-btn" id="topo-close" aria-label="Back to map"><svg viewBox="0 0 24 24"><use href="#i-back"/></svg></button>'
        + '    <div class="topo-search-wrap">'
        + '      <input type="search" class="topo-search" id="topo-search-input" placeholder="Search this site…" autocomplete="off" spellcheck="false">'
        + '      <ul class="topo-search-results" id="topo-search-results" role="listbox" hidden></ul>'
        + '    </div>'
        + '    <button class="icon-btn" id="topo-refresh" aria-label="Refresh topology"><svg viewBox="0 0 24 24"><use href="#i-refresh"/></svg></button>'
        + '  </div>'
        + '  <div class="topo-graph" id="topo-graph"></div>'
        + '  <div class="topo-status" id="topo-status">Loading topology…</div>'
        + '</div>';

      document.getElementById("topo-close").addEventListener("click", function () {
        closeTopology();
      });

      document.getElementById("topo-refresh").addEventListener("click", function () {
        refreshTopology();
      });

      wireSearchInput(document.getElementById("topo-search-input"));

      // Resize handler — when the operator opens a virtual keyboard or
      // rotates back to portrait after the lockout, Cytoscape needs a
      // resize+fit to reflow.
      _resizeHandler = function () {
        if (_cy) {
          try { _cy.resize(); } catch (e) {}
        }
      };
      window.addEventListener("resize", _resizeHandler);

      // Re-render the graph when the operator toggles theme via More
      // tab → Appearance while topology is open. The Cytoscape
      // stylesheet captures theme at render time, so a flip needs a
      // rebuild to swap text/edge colors. Mobile doesn't persist node
      // positions so the dagre re-layout is the right behavior here.
      if (_themeObserver) { try { _themeObserver.disconnect(); } catch (e) {} }
      _themeObserver = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          if (muts[i].attributeName === "data-theme" && _topoData) {
            renderGraph(_topoData);
            break;
          }
        }
      });
      _themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

      loadCytoscape().then(function () {
        return api.map.topology(_siteId);
      }).then(function (data) {
        _topoData = data;
        _siteName = (data && data.fortigate && data.fortigate.hostname) || _siteName;
        renderGraph(data);
        setStatus("");
      }).catch(function (err) {
        setStatus("Failed to load topology: " + ((err && err.message) || err));
      });
    },
  };

  // ─── Hash parsing ─────────────────────────────────────────────────────
  // PolarisRouter's parse() splits on "/" but doesn't carve query strings
  // off the trailing part. Read the raw hash for the focus term so deep
  // links from global search can pre-aim the graph.
  function parseFocusTermFromHash() {
    var raw = window.location.hash || "";
    var qIdx = raw.indexOf("?");
    if (qIdx < 0) return null;
    var qs = raw.slice(qIdx + 1);
    var parts = qs.split("&");
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split("=");
      if (kv[0] === "q" && kv[1]) {
        try { return decodeURIComponent(kv[1]); } catch (e) { return kv[1]; }
      }
    }
    return null;
  }

  function setStatus(msg) {
    var el = document.getElementById("topo-status");
    if (el) {
      el.textContent = msg || "";
      el.style.display = msg ? "" : "none";
    }
  }

  function closeTopology() {
    closeTopologySheet();
    closeTopologySearchResults();
    if (_themeObserver) {
      try { _themeObserver.disconnect(); } catch (e) {}
      _themeObserver = null;
    }
    if (_resizeHandler) {
      window.removeEventListener("resize", _resizeHandler);
      _resizeHandler = null;
    }
    if (_cy) {
      try { _cy.destroy(); } catch (e) {}
      _cy = null;
    }
    _topoData = null;
    var siteId = _siteId;
    _siteId = null;
    _focusTerm = null;
    // Hand off to the site sheet on the map. router.go restores app
    // dataset.tab, navbar visibility, and renders the map underneath.
    if (siteId) PolarisRouter.go("site/" + siteId);
    else PolarisRouter.go("map");
  }

  // Re-fetch the topology payload and rebuild the graph in place. Mirrors
  // the desktop modal's refresh button (map.js refreshTopology): there are no
  // manual node positions to snapshot here (autoungrabify + no savedLayouts),
  // so it's a straight re-fetch → renderGraph. Guards against a double-tap by
  // disabling the button for the duration.
  function refreshTopology() {
    if (!_siteId) return;
    var btn = document.getElementById("topo-refresh");
    if (btn) btn.disabled = true;
    setStatus("Refreshing…");
    api.map.topology(_siteId).then(function (data) {
      _topoData = data;
      _siteName = (data && data.fortigate && data.fortigate.hostname) || _siteName;
      renderGraph(data);
      setStatus("");
    }).catch(function (err) {
      setStatus("Failed to refresh topology: " + ((err && err.message) || err));
    }).then(function () {
      if (btn) btn.disabled = false;
    });
  }

  // ─── Graph render ─────────────────────────────────────────────────────
  function renderGraph(data) {
    var elements = window.PolarisTopologyRender.buildTopologyElements(data);

    // Inherit the page-wide theme — its FAMILY, since topologyStylesheet
    // branches on `theme === "dark"` and there is one palette per family.
    var theme = window.PolarisTheme ? PolarisTheme.get() : "dark";

    if (_cy) {
      try { _cy.destroy(); } catch (e) {}
      _cy = null;
    }

    // Deterministic column layout (shared solver with desktop). Phone
    // viewport is tall, so map depth → vertical (firewall on top) and
    // lane → horizontal — the transpose of desktop's left-to-right. Falls
    // back to dagre TB when there's no firewall root to anchor the solver.
    var DEPTH_SPACING = 110;
    var LANE_SPACING = 70;
    // Location-coded sites use the quotient (grouped-box) layout, matching
    // desktop; untagged sites fall through to the flat column solver.
    var columns = window.PolarisTopologyRender.computeGroupedLayout(elements) ||
      window.PolarisTopologyRender.computeTopologyColumns(elements);
    var layoutConfig;
    if (columns) {
      var positions = {};
      Object.keys(columns).forEach(function (id) {
        positions[id] = { x: columns[id].lane * LANE_SPACING, y: columns[id].depth * DEPTH_SPACING };
      });
      layoutConfig = { name: "preset", positions: positions, fit: false, padding: 30 };
    } else {
      layoutConfig = {
        name: "dagre",
        rankDir: "TB", // top-to-bottom — phone viewport is tall
        nodeSep: 50,
        rankSep: 110,
        fit: false, // we'll center on the focus node ourselves
        padding: 30,
      };
    }

    _cy = window.cytoscape({
      container: document.getElementById("topo-graph"),
      elements: elements,
      // Mobile users don't shift+drag — disable box-select to keep tap
      // targets crisp. Pinch-zoom + two-finger pan come for free.
      boxSelectionEnabled: false,
      autoungrabify: true, // nodes stay where the layout placed them; no manual drag
      // Match desktop's damped wheel zoom (mostly trackpads here).
      wheelSensitivity: 0.2,
      // NOTE: the layout is NOT passed here — it's run explicitly below via
      // .layout().run() so the layoutstop listener is registered first. A
      // `preset` layout (location-coded sites) runs SYNCHRONOUSLY, so if it
      // rode the constructor it would emit layoutstop during construction —
      // before the handler on the next lines attaches — silently dropping the
      // grouping-hull render + initial focus. Same hazard the desktop modal
      // documents in map.js (register listener before running the layout).
      // includeEndpointOverlay registers the .dimmed (display:none) and
      // synthetic-endpoint round-rectangle styles used by the connection-path
      // overlay when the operator deep-links here via global search on a
      // workstation. Without it, dimming has no visual effect on mobile and
      // the synthetic endpoint node renders with the default fortinetNode
      // styling (wrong shape + color).
      style: window.PolarisTopologyRender.topologyStylesheet(theme, { includeEndpointOverlay: true }),
    });

    // Registered BEFORE .layout().run() below (see the constructor note).
    //  - Location grouping hulls (building / floor / room / jb shapes from
    //    a:/b:/f:/r:/jb: codes) — always on for mobile (no toggle; flat view
    //    only in v1). Nodes are ungrabbable here so no drag-follow refresh is
    //    needed; the layout is final once it stops.
    //  - Initial focus: zoom to the FortiGate (or the searched node) instead
    //    of fitting the whole graph. A site with 30 switches would otherwise
    //    be unreadable at the default zoom-to-fit on a 375px screen.
    _cy.one("layoutstop", function () {
      window.PolarisTopologyRender.renderLocationGroups(_cy);
      applyInitialFocus();
    });

    // Tap a node → bottom sheet with details. Skip ghost LLDP nodes for
    // the no-action case (they render but have no Polaris asset linkage).
    _cy.on("tap", "node", function (evt) {
      var node = evt.target;
      if (node.data("isLocGroup")) return; // location hull — not a device
      var role = node.data("role");
      if (role === "lldp") {
        // Still show a sheet with what we know — chassisId / mgmt IP /
        // system name — just no "View asset" button.
        openNodeSheet(node, { kind: "lldp" });
        return;
      }
      openNodeSheet(node, { kind: role || "unknown" });
    });

    // Run the layout now that the layoutstop listener is attached. preset
    // (location-coded / firewall-rooted sites) is synchronous; dagre (no
    // firewall root) is async — either way the handler above catches it.
    // Fan-out links route orthogonally (see map.js) — the phone maps depth
    // to y, so the taxi runs vertically and turns 1.5 depth steps along.
    if (columns) {
      window.PolarisTopologyRender.markFanOutEdges(_cy, columns, {
        colSpacing: DEPTH_SPACING,
        orientation: "vertical",
      });
    }
    _cy.layout(layoutConfig).run();
  }

  function applyInitialFocus() {
    if (!_cy) return;
    var node = pickFocusNode(_focusTerm);
    if (!node || node.length === 0) {
      try { _cy.fit(undefined, 30); } catch (e) {}
      return;
    }
    try {
      _cy.animate({
        center: { eles: node },
        zoom: 1.3,
        duration: 400,
      });
    } catch (e) { /* fall through — single-node graph or animation error */ }
    node.addClass("topology-pulse");
    setTimeout(function () {
      try { node.removeClass("topology-pulse"); } catch (e) {}
    }, 1800);

    // Deep-link case: when ?q= came in via URL, also fire the authoritative
    // topology search so endpoints (which aren't graph nodes — they nest
    // under switches) resolve to their parent switch via the backend's
    // `switchId` field, and then overlay the asset's connection path so
    // the operator sees endpoint→switch→firewall instead of the whole
    // site graph. Mirrors the desktop search → handleTopologySearchPick
    // flow.
    if (_focusTerm) {
      api.map.topologySearch(_siteId, _focusTerm).then(function (resp) {
        var hits = (resp && resp.results) || [];
        if (hits.length === 0) return;
        var first = hits[0];
        if (first.switchId) {
          var switchNode = _cy.getElementById(first.switchId);
          if (switchNode && switchNode.length > 0) {
            try { _cy.animate({ center: { eles: switchNode }, zoom: 1.3, duration: 350 }); } catch (e) {}
            switchNode.addClass("topology-pulse");
            setTimeout(function () { try { switchNode.removeClass("topology-pulse"); } catch (e) {} }, 1500);
          }
        }
        if (first.id) {
          api.assets.connectionPath(first.id).then(function (path) {
            if (path) applyConnectionPathOverlay(path);
          }).catch(function () { /* best-effort */ });
        }
      }).catch(function () { /* best-effort — silent on failure */ });
    }
  }

  // Overlay a focused endpoint→firewall connection path on top of the live
  // Cytoscape graph: dim everything off-path, add the endpoint as a synthetic
  // node when it's not already in the graph (endpoints don't ride along in
  // the standard topology response), and collapse the path into a tight
  // vertical chain so it reads at a glance on a phone viewport. Mobile
  // doesn't persist node positions (autoungrabify + no localStorage save),
  // so there's no "restore" path needed — closing the topology tears down
  // the cyInstance, and the operator re-opens fresh.
  function applyConnectionPathOverlay(path) {
    if (!_cy || !path || !path.asset || !Array.isArray(path.hops) || path.hops.length === 0) return;
    var ep = path.asset;
    var leaf = path.hops[0];
    var nextHop = path.hops[1];
    var syntheticEdgeId = null;

    var alreadyOnGraph = _cy.getElementById(ep.id).length > 0;
    if (!alreadyOnGraph && leaf.kind === "endpoint") {
      _cy.add({
        group: "nodes",
        data: {
          id: ep.id,
          label: ep.hostname || ep.ipAddress || "endpoint",
          role: "endpoint",
          nodeColor: endpointNodeColor(leaf),
          synthetic: 1,
        },
      });
      if (nextHop && _cy.getElementById(nextHop.id).length > 0) {
        syntheticEdgeId = "ep-edge-" + ep.id;
        _cy.add({
          group: "edges",
          data: {
            id: syntheticEdgeId,
            source: ep.id,
            target: nextHop.id,
            label: nextHop.endpointPort ? "port " + nextHop.endpointPort : "",
            synthetic: 1,
          },
        });
      }
    }

    var pathNodeIds = path.hops.map(function (h) { return h.id; });
    var pathElements = _cy.collection();
    pathNodeIds.forEach(function (id) {
      var n = _cy.getElementById(id);
      if (n.length > 0) pathElements = pathElements.union(n);
    });
    if (syntheticEdgeId) {
      var syn = _cy.getElementById(syntheticEdgeId);
      if (syn.length > 0) pathElements = pathElements.union(syn);
    }
    _cy.edges().forEach(function (e) {
      var s = e.data("source");
      var t = e.data("target");
      if (pathNodeIds.indexOf(s) !== -1 && pathNodeIds.indexOf(t) !== -1) {
        pathElements = pathElements.union(e);
      }
    });

    _cy.elements().not(pathElements).addClass("dimmed");

    // Pack the path into a tight vertical chain — firewall on top, endpoint
    // on bottom — anchored at the firewall's existing X so the column stays
    // roughly where dagre put it. Spacing tuned for phone viewport.
    var orderedTopDown = pathNodeIds.slice().reverse();
    var anchorX = 0;
    if (orderedTopDown.length > 0) {
      var topNode = _cy.getElementById(orderedTopDown[0]);
      if (topNode.length > 0) anchorX = topNode.position().x;
    }
    var chainSpacing = 140;
    orderedTopDown.forEach(function (id, idx) {
      var n = _cy.getElementById(id);
      if (n.length > 0) n.position({ x: anchorX, y: idx * chainSpacing });
    });

    try {
      _cy.animate({ fit: { eles: pathElements, padding: 40 }, duration: 350 });
    } catch (e) { /* fit may fail on single-node paths */ }
  }

  // Color the synthetic endpoint node by its monitor state — same five-state
  // palette the firewall / switch / AP nodes use so the path reads as a
  // single visual scheme. Mirrors desktop's endpointNodeColor.
  function endpointNodeColor(hop) {
    // Shared node-health palette (api.js POLARIS_HEALTH_COLORS, re-exposed by
    // topology-render.js which mobile.html loads).
    var P = window.POLARIS_HEALTH_COLORS;
    if (!hop || !hop.monitored) return P.unmonitored;
    switch (hop.monitorStatus) {
      case "up":         return P.up;
      case "warning":    return P.degraded;
      case "down":       return P.down;
      case "recovering": return P.recovering;
      // No verdict rendered — distinct from the grey "no samples" unknown.
      case "passive":    return P.passive;
      default:           return P.unknown;
    }
  }

  // Pick the node to focus on initial render. No focusTerm → FortiGate.
  // Otherwise case-insensitive substring match across hostname / IP / MAC,
  // first hit wins. Returns Cytoscape collection (possibly empty).
  function pickFocusNode(focusTerm) {
    if (!_cy || !_topoData) return null;
    var fgNode = _cy.getElementById((_topoData.fortigate && _topoData.fortigate.id) || "");
    if (!focusTerm) return fgNode;

    var term = focusTerm.toLowerCase();
    var match = null;
    _cy.nodes().forEach(function (n) {
      if (match) return;
      var label = (n.data("label") || "").toLowerCase();
      if (label.indexOf(term) !== -1) match = n;
    });
    if (match) return match;

    // No node-level hit — see if it matches an endpoint nested under a
    // switch. Endpoints aren't graph nodes; their parent switch is.
    var sw = (_topoData.switches || []).find(function (s) {
      return (s.endpoints || []).some(function (ep) {
        var ip   = (ep.ipAddress || "").toLowerCase();
        var mac  = (ep.macAddress || "").toLowerCase();
        var host = (ep.hostname || "").toLowerCase();
        var who  = (ep.assignedTo || "").toLowerCase();
        return ip.indexOf(term) !== -1 || mac.indexOf(term) !== -1 || host.indexOf(term) !== -1 || who.indexOf(term) !== -1;
      });
    });
    if (sw) return _cy.getElementById(sw.id);

    return fgNode;
  }

  // ─── Search input ─────────────────────────────────────────────────────
  function wireSearchInput(input) {
    if (!input) return;
    input.addEventListener("input", function () {
      if (_searchDebounce) { clearTimeout(_searchDebounce); _searchDebounce = null; }
      var q = input.value.trim();
      if (!q) { closeTopologySearchResults(); return; }
      _searchDebounce = setTimeout(function () { runTopologySearch(q); }, 200);
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeTopologySearchResults(); input.blur(); }
    });
    document.addEventListener("click", function (e) {
      var box = document.getElementById("topo-search-results");
      if (!box) return;
      if (e.target === input || (box.contains && box.contains(e.target))) return;
      closeTopologySearchResults();
    });
  }

  async function runTopologySearch(q) {
    if (!_siteId) return;
    try {
      var resp = await api.map.topologySearch(_siteId, q);
      _suggestState.items = (resp && resp.results) || [];
      _suggestState.open = true;
      paintSearchResults();
    } catch (err) {
      _suggestState.items = [];
      _suggestState.open = true;
      paintSearchResults();
    }
  }

  function paintSearchResults() {
    var box = document.getElementById("topo-search-results");
    if (!box) return;
    box.innerHTML = "";
    box.hidden = !_suggestState.open;
    if (!_suggestState.open) return;
    if (_suggestState.items.length === 0) {
      var li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No matches in this site.";
      box.appendChild(li);
      return;
    }
    _suggestState.items.forEach(function (item) {
      var li = document.createElement("li");
      var primary = item.hostname || item.ipAddress || item.macAddress || "(unnamed)";
      var bits = [];
      if (item.ipAddress)  bits.push(item.ipAddress);
      if (item.macAddress) bits.push(item.macAddress);
      if (item.assignedTo) bits.push(item.assignedTo);
      bits.push((item.switchHostname || "?") + (item.port ? "/" + item.port : ""));
      li.innerHTML =
        '<div>' + escapeHtml(primary) + '</div>' +
        '<span class="meta">' + escapeHtml(bits.join(" · ")) + '</span>';
      li.addEventListener("mousedown", function (e) {
        e.preventDefault();
        handleSearchPick(item);
      });
      box.appendChild(li);
    });
  }

  function handleSearchPick(item) {
    closeTopologySearchResults();
    var input = document.getElementById("topo-search-input");
    if (input) input.value = "";
    if (!_cy || !item.switchId) return;
    var node = _cy.getElementById(item.switchId);
    if (node && node.length > 0) {
      try { _cy.animate({ center: { eles: node }, zoom: 1.5, duration: 350 }); } catch (e) {}
      node.addClass("topology-pulse");
      setTimeout(function () { try { node.removeClass("topology-pulse"); } catch (e) {} }, 1500);
    }
  }

  function closeTopologySearchResults() {
    _suggestState.open = false;
    _suggestState.items = [];
    var box = document.getElementById("topo-search-results");
    if (box) { box.hidden = true; box.innerHTML = ""; }
  }

  // ─── Node-tap bottom sheet ────────────────────────────────────────────
  function openNodeSheet(node, meta) {
    closeTopologySheet();

    var role = node.data("role") || "";
    var label = node.data("label") || "(unnamed)";
    var resolved = resolveNodeAsset(node.id(), role);

    var roleLabel = ({
      fortigate:      "FortiGate",
      fortiswitch:    "FortiSwitch",
      fortiap:        "FortiAP",
      "remote-asset": "Remote asset",
      lldp:           "LLDP neighbor",
    })[role] || "Node";

    var monitorPill = renderMonitorPill(resolved);
    var endpointBlock = "";
    if (role === "fortiswitch" && resolved && resolved.endpoints && resolved.endpoints.length > 0) {
      var sample = resolved.endpoints.slice(0, 12);
      var rows = sample.map(function (ep) {
        var primary = ep.hostname || ep.ipAddress || ep.macAddress || "(unnamed)";
        var bits = [];
        if (ep.port)        bits.push(ep.port);
        if (ep.ipAddress)   bits.push(ep.ipAddress);
        if (ep.assignedTo)  bits.push(ep.assignedTo);
        return ''
          + '<li>'
          + '<button class="topo-endpoint-row" data-asset-id="' + escapeHtml(ep.id) + '">'
          + '<span>' + escapeHtml(primary) + '</span>'
          + '<span class="meta">' + escapeHtml(bits.join(" · ")) + '</span>'
          + '</button></li>';
      }).join("");
      var heading = "Endpoints (" + (resolved.endpointCount || resolved.endpoints.length) + ")";
      var moreHint = (resolved.endpointCount || 0) > sample.length
        ? '<div class="muted" style="font-size:12px;margin-top:6px;">Showing ' + sample.length + ' of ' + resolved.endpointCount + ' — use search to find a specific endpoint.</div>'
        : "";
      endpointBlock = ''
        + '<div class="topo-section">'
        + '  <div class="topo-section-title">' + escapeHtml(heading) + '</div>'
        + '  <ul class="topo-endpoints">' + rows + '</ul>'
        + moreHint
        + '</div>';
    }

    var canPivotToAsset = (role === "fortigate" || role === "fortiswitch" || role === "fortiap" || role === "remote-asset");

    var meta1 = [];
    if (resolved && resolved.ipAddress)    meta1.push('<span class="mono">' + escapeHtml(resolved.ipAddress) + '</span>');
    if (resolved && resolved.serial)       meta1.push('<span class="mono">' + escapeHtml(resolved.serial) + '</span>');
    if (resolved && resolved.model)        meta1.push(escapeHtml(resolved.model));
    if (meta && meta.kind === "lldp")      meta1.push('<span class="muted" style="font-size:12px;">LLDP neighbor</span>');

    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.id = "topo-sheet-scrim";

    var sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.id = "topo-sheet";
    sheet.innerHTML = ''
      + '<div class="sheet-handle"></div>'
      + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:8px;">'
      + '  <div style="min-width:0;">'
      + '    <h3 class="sheet-title" style="margin:0 0 4px;">' + escapeHtml(label) + '</h3>'
      + '    <div class="muted" style="font-size:13px;letter-spacing:.25px;">' + escapeHtml(roleLabel) + (meta1.length ? ' · ' + meta1.join(" · ") : '') + '</div>'
      + '  </div>'
      + '  <button class="icon-btn" id="topo-sheet-close" aria-label="Close"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>'
      + '</div>'
      + '<div style="display:flex;gap:8px;margin:12px 0 16px;flex-wrap:wrap;align-items:center;">'
      +    monitorPill
      + '</div>'
      +  endpointBlock
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
      + (canPivotToAsset
          ? '  <button class="btn btn-tonal" id="topo-sheet-asset"><svg viewBox="0 0 24 24"><use href="#i-server"/></svg>View asset</button>'
          : '')
      + '</div>';

    document.body.appendChild(scrim);
    document.body.appendChild(sheet);

    scrim.addEventListener("click", closeTopologySheet);
    document.getElementById("topo-sheet-close").addEventListener("click", closeTopologySheet);
    PolarisTabs.attachSwipeToDismiss(sheet, closeTopologySheet);

    if (canPivotToAsset) {
      document.getElementById("topo-sheet-asset").addEventListener("click", function () {
        var assetId = node.data("assetId") || node.id();
        closeTopologySheet();
        if (window.PolarisAssetDetail && PolarisAssetDetail.open) PolarisAssetDetail.open(assetId);
        else PolarisRouter.go("asset/" + assetId);
      });
    }

    // Endpoint rows pivot to the asset detail page directly.
    sheet.querySelectorAll(".topo-endpoint-row").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.dataset.assetId;
        if (id) {
          closeTopologySheet();
          if (window.PolarisAssetDetail && PolarisAssetDetail.open) PolarisAssetDetail.open(id);
          else PolarisRouter.go("asset/" + id);
        }
      });
    });
  }

  function closeTopologySheet() {
    var s = document.getElementById("topo-sheet");
    var sc = document.getElementById("topo-sheet-scrim");
    if (s) s.remove();
    if (sc) sc.remove();
  }

  // Walk _topoData to find the asset entry that backs the given node id.
  // Mirrors how desktop's right-rail panel resolves nodes to source data.
  function resolveNodeAsset(id, role) {
    if (!_topoData) return null;
    if (role === "fortigate") return _topoData.fortigate || null;
    if (role === "fortiswitch") {
      return (_topoData.switches || []).find(function (s) { return s.id === id; }) || null;
    }
    if (role === "fortiap") {
      return (_topoData.aps || []).find(function (a) { return a.id === id; }) || null;
    }
    if (role === "remote-asset") {
      return (_topoData.remoteAssetNodes || []).find(function (r) { return r.id === id; }) || null;
    }
    if (role === "lldp") {
      return (_topoData.lldpNodes || []).find(function (n) { return n.id === id; }) || null;
    }
    return null;
  }

  // Same shape as renderMonitorPill in map-tab.js — kept local so the
  // mobile topology surface doesn't depend on map-tab's internals.
  function renderMonitorPill(asset) {
    if (!asset) return '<span class="status-pill unk">—</span>';
    if (asset.status === "maintenance") return '<span class="status-pill maint"><span class="dot maint"></span>Maintenance</span>';
    if (!asset.monitored && asset.monitored !== undefined) return '<span class="status-pill unk">Unmonitored</span>';
    if (asset.monitored === undefined) return ""; // ghost LLDP / remote node
    var samples  = asset.monitorRecentSamples  || 0;
    var failures = asset.monitorRecentFailures || 0;
    switch (asset.monitorHealth) {
      case "up":       return '<span class="status-pill up"><span class="dot up"></span>Up</span>';
      case "degraded": return '<span class="status-pill warn"><span class="dot warn"></span>Packet loss — ' + failures + '/' + samples + '</span>';
      case "down":     return '<span class="status-pill down"><span class="dot down"></span>Down</span>';
      default:         return '<span class="status-pill unk"><span class="dot unk"></span>No samples</span>';
    }
  }

  // escapeHtml is the canonical global from api.js (loaded first on every page).

  // ─── Public surface ────────────────────────────────────────────────────
  window.PolarisTopologyTab = {
    spec: Topology,
  };
})();
