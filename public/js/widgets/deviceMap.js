/**
 * widgets/deviceMap.js — the Device Map, as a placeable dashboard widget.
 *
 * What it draws follows the widget's FortiGates pick (gear → FortiGates):
 *   - none picked — the gates of the widget's region scope on a theme-aware
 *     Leaflet basemap, as monitor-health-colored `.fg-marker` dots that roll
 *     up into `.fg-cluster` bubbles (worst child health, not child count);
 *   - several picked — the same map, holding only those gates;
 *   - ONE picked — no map: that gate's topology, read-only, fills the widget.
 * On either map, double-clicking a gate swaps the map for its read-only
 * topology, with a "Map" button back. Hover names the gate + its monitor line;
 * on the /dash wallboard (a kiosk with no hover) a single click also surfaces
 * a details popup.
 *
 * The topology is the Device Map's own graph (topology-render.js — the shared
 * element builder, stylesheet and column solver, as the phone's topology tab
 * uses them) laid over the layout an operator saved on the Device Map page,
 * with nothing grabbable, selectable or editable. Cytoscape and the renderer
 * are loaded on first use, not by index.html / dash.html, so a dashboard that
 * never opens a topology never pays for them. The data is GET
 * /map/sites/:id/topology, allowlisted on the dash listener for this widget;
 * a single gate's id comes from /dashboard/filter-options (the gate may have
 * no coordinates, so /map/sites may not carry it).
 *
 * Per-instance map + layers + the refresh timers + ResizeObservers live in the
 * render closure and are torn down in ctx.onUnmount (Leaflet throws "Map
 * container is already initialized" if a container is reused without
 * map.remove(); a Cytoscape instance left alive keeps its listeners).
 */

(function () {
  var _iconPathSet = false;

  function isDash() { return typeof window !== "undefined" && window.POLARIS_DASH_LOCAL === true; }

  // The gates the widget's FortiGates field picked ([] = no pick). The
  // "(No FortiGate)" sentinel the noc-summary widgets use is not a gate.
  function pickedGates(config) {
    if (!config || config.fortigateScope !== "custom" || !Array.isArray(config.fortigates)) return [];
    return config.fortigates.filter(function (g) { return g && g !== "__none__"; });
  }

  // The device types a topology draws, as the gear's "Device types" offers
  // them: `role` is the node's role in topology-render.js, `legend` the label
  // of its row in topologyLegendSpec().nodes. The gear stores the UNticked
  // ones (config.topologyHide), so a type added later shows by default.
  var TOPO_TYPES = [
    { role: "fortigate",    label: "FortiGates",             legend: "FortiGate" },
    { role: "fortiswitch",  label: "FortiSwitches",          legend: "FortiSwitch" },
    { role: "fortiap",      label: "FortiAPs",               legend: "FortiAP" },
    { role: "remote-asset", label: "Devices at other sites", legend: "Remote asset" },
  ];

  // config.topologyHide → { role: true } for the roles not to draw.
  function hiddenRoles(config) {
    var hidden = {};
    var list = config && Array.isArray(config.topologyHide) ? config.topologyHide : [];
    TOPO_TYPES.forEach(function (t) { if (list.indexOf(t.role) !== -1) hidden[t.role] = true; });
    return hidden;
  }

  // ── Location lock ────────────────────────────────────────────────────────
  // The gear's Locations pick (config.topologyLock) is a list of location
  // view keys — computeFloorViews' "a|<area>", "b|<area>|<building>",
  // "f|<area>|<building>|<floor>". Empty = no lock: the whole site ("Base")
  // and every view. Locked, the widget shows only those views and what lies
  // inside them (a locked area's buildings and floors, a locked building's
  // floors) — never Base, never another area. config.topologyRotateSec > 0
  // cycles through the locked views (two or more) on that period.
  var ROTATE_CHOICES = [0, 15, 30, 60, 120, 300];

  function lockKeys(config) {
    var list = config && Array.isArray(config.topologyLock) ? config.topologyLock : [];
    return list.filter(function (k) { return typeof k === "string" && k; });
  }

  // Is view `v` the locked view `k`, or inside it?
  function viewWithin(v, k) {
    if (v.key === k) return true;
    var p = k.split("|");
    if (p[0] === "a") return v.areaKey === p[1];
    if (p[0] === "b") return v.kind === "floor" && v.areaKey === p[1] && v.buildingKey === p[2];
    return false;
  }

  // The views a viewer may reach: every view, or only the lock's.
  function allowedViews(views, lock) {
    if (!lock.length) return views;
    return views.filter(function (v) {
      return lock.some(function (k) { return viewWithin(v, k); });
    });
  }

  // The locked views that still exist, in the site's display order — what
  // the rotation steps through.
  function rotationKeys(views, lock) {
    return views.filter(function (v) { return lock.indexOf(v.key) !== -1; }).map(function (v) { return v.key; });
  }

  // The chip rows: the page's switcher (topology-render.js viewSwitcherRows)
  // over the reachable views. Locked, its "Base" row goes — the whole site is
  // outside every lock.
  function viewChipRows(views, lock, activeKey) {
    var R = window.PolarisTopologyRender;
    if (!views.length) return [];
    var rows = R.viewSwitcherRows(allowedViews(views, lock), activeKey);
    return lock.length ? rows.slice(1) : rows;
  }

  // The gear's Locations section: the picked gate's areas, buildings and
  // floors as a tick list (ticked = locked), and the rotation period. A lock
  // is one site's view keys, so it needs exactly one gate picked; the list
  // comes from that gate's /topology, read once when the gear opens.
  function renderLocationsConfig(wrap, config, onChange) {
    var gates = pickedGates(config);
    var head = '<label>Locations</label>';
    if (gates.length !== 1) {
      wrap.innerHTML = head + '<p class="widget-config-hint">Tick exactly one FortiGate below to lock its topology to some of its locations.</p>';
      return;
    }
    wrap.innerHTML = head + '<p class="widget-config-hint">Loading locations…</p>';
    var lock = lockKeys(config);
    PolarisWidgets.getFortigateOptions()
      .then(function (opts) {
        var hit = (opts || []).filter(function (g) { return g.name === gates[0]; })[0];
        if (!hit || !hit.id) throw new Error("FortiGate " + gates[0] + " is no longer in the fleet");
        return loadTopologyLibs().then(function () { return api.map.topology(hit.id); });
      })
      .then(function (data) {
        if (!wrap.isConnected) return;
        var R = window.PolarisTopologyRender;
        var views = R.computeFloorViews(R.buildTopologyElements(data));
        if (!views.length) {
          wrap.innerHTML = head + '<p class="widget-config-hint">None of this gate\'s devices carry location codes (a:, b:, f: in their descriptions), so there is nothing to lock to.</p>';
          return;
        }
        var rot = ROTATE_CHOICES.indexOf(config.topologyRotateSec) > 0 ? config.topologyRotateSec : 0;
        wrap.innerHTML = head +
          '<div class="devmap-cfg-loclist">' +
            views.map(function (v) {
              // Indent by depth: an area, a building (under its area when it
              // has one), a floor.
              var depth = v.kind === "area" ? 0 : v.kind === "building" ? (v.areaKey ? 1 : 0) : (v.buildingKey ? (v.areaKey ? 2 : 1) : 1);
              var label = v.kind === "floor" ? v.floorName : v.kind === "building" ? (v.buildingName || v.label) : v.label;
              return '<label class="widget-config-typeopt devmap-cfg-loc devmap-cfg-loc-' + depth + '" title="' + escapeHtml(v.label) + '">' +
                '<input type="checkbox" data-loc="' + escapeHtml(v.key) + '"' + (lock.indexOf(v.key) !== -1 ? " checked" : "") + "> " +
                escapeHtml(label) + "</label>";
            }).join("") +
          "</div>" +
          '<label>Rotate</label>' +
          '<select data-k="topologyRotateSec">' +
            ROTATE_CHOICES.map(function (s) {
              var text = !s ? "Off" : s < 60 ? "Every " + s + " seconds" : s === 60 ? "Every minute" : "Every " + (s / 60) + " minutes";
              return '<option value="' + s + '"' + (s === rot ? " selected" : "") + ">" + text + "</option>";
            }).join("") +
          "</select>" +
          '<p class="widget-config-hint">Ticked locations are all the widget shows; viewers can open their buildings and floors but never leave them. Nothing ticked = the whole site. With two or more ticked, Rotate steps through them (⏸ in the widget pauses it).</p>';
        var sel = wrap.querySelector('[data-k="topologyRotateSec"]');
        function syncRotate(n) { sel.disabled = n < 2; }
        syncRotate(lock.length);
        wrap.querySelectorAll("[data-loc]").forEach(function (cb) {
          cb.addEventListener("change", function () {
            var keys = [];
            wrap.querySelectorAll("[data-loc]").forEach(function (x) { if (x.checked) keys.push(x.getAttribute("data-loc")); });
            syncRotate(keys.length);
            onChange("topologyLock", keys);
          });
        });
        sel.addEventListener("change", function () { onChange("topologyRotateSec", parseInt(sel.value, 10) || 0); });
      })
      .catch(function (err) {
        if (!wrap.isConnected) return;
        wrap.innerHTML = head + '<p class="widget-config-hint">Locations unavailable — ' + escapeHtml(err && err.message ? err.message : String(err)) + "</p>";
      });
  }

  // ── Topology (read-only) ─────────────────────────────────────────────────
  // Same spacing as the Device Map modal and the phone (map.js,
  // mobile/topology-tab.js), so a saved layout lands where it was saved.
  var TOPO_COL_SPACING = 130;
  var TOPO_ROW_SPACING = 95;
  // In load order: dagre before its Cytoscape adapter (which registers itself
  // on window.cytoscape), the renderer before the line editor it is read by.
  var TOPO_SCRIPTS = [
    "/js/vendor/cytoscape.min.js",
    "/js/vendor/dagre.min.js",
    "/js/vendor/cytoscape-dagre.js",
    "/js/topology-render.js",
    "/js/topology-edge-editor.js",
  ];
  var _topoLibs = null;

  function loadScript(src) {
    if (document.querySelector('script[src="' + src + '"]')) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { s.remove(); reject(new Error("Failed to load " + src)); };
      document.head.appendChild(s);
    });
  }

  function loadTopologyLibs() {
    if (_topoLibs) return _topoLibs;
    _topoLibs = TOPO_SCRIPTS.reduce(function (p, src) {
      return p.then(function () { return loadScript(src); });
    }, Promise.resolve()).catch(function (err) {
      _topoLibs = null; // retry on the next open
      throw err;
    });
    return _topoLibs;
  }

  // The graph follows the APP theme's family, as the Device Map modal's does —
  // its pane paints an app token, not a basemap.
  function topoTheme() {
    return typeof isLightTheme === "function" ? (isLightTheme() ? "light" : "dark") : undefined;
  }

  // The link hover tooltip — the Device Map page's: one #topology-edge-tooltip
  // on <body> (styled in styles.css, above a full-screen widget), shared by
  // every widget instance, its text from topology-render.js → edgeTooltipHtml.
  function edgeTip() {
    var el = document.getElementById("topology-edge-tooltip");
    if (!el) {
      el = document.createElement("div");
      el.id = "topology-edge-tooltip";
      el.setAttribute("role", "tooltip");
      document.body.appendChild(el);
    }
    return el;
  }
  // Below-right of the cursor, flipped above-left near the viewport edge.
  function moveEdgeTip(clientX, clientY) {
    var el = document.getElementById("topology-edge-tooltip");
    if (!el || !el.classList.contains("visible")) return;
    var pad = 14;
    var rect = el.getBoundingClientRect();
    var maxX = window.innerWidth - rect.width - 6;
    var maxY = window.innerHeight - rect.height - 6;
    var x = clientX + pad; if (x > maxX) x = clientX - rect.width - pad;
    var y = clientY + pad; if (y > maxY) y = clientY - rect.height - pad;
    if (x < 6) x = 6;
    if (y < 6) y = 6;
    el.style.left = x + "px";
    el.style.top = y + "px";
  }
  function hideEdgeTip() {
    var el = document.getElementById("topology-edge-tooltip");
    if (el) el.classList.remove("visible");
  }

  // Build a read-only Cytoscape graph of one site's /topology payload into
  // `container`. The shape of mobile/topology-tab.js → renderGraph, flat view
  // only: the column solver's baseline, the operator's saved flat layout over
  // it, location hulls, gutter routing, the operator-drawn lines (not
  // editable). `view` ({zoom, pan}) restores where a refresh left the viewer.
  // `hidden` ({role: true}) drops those device types before anything is laid
  // out; their links go with them (the dangling-edge filter below).
  // `viewKey` ("flat" or a location view's key — computeFloorViews) cuts the
  // graph down to that area / building / floor exactly as the Device Map
  // page does (partitionElementsForFloor), over the layout saved for THAT
  // view; `onPortal(viewKey)` is called when a portal stub ("→ elsewhere")
  // is tapped.
  function drawTopology(container, data, view, hidden, viewKey, onPortal) {
    var R = window.PolarisTopologyRender;
    var elements = R.buildTopologyElements(data);
    if (hidden) {
      elements = elements.filter(function (e) {
        var d = e && e.data;
        return !(d && !d.source && d.role && hidden[d.role]);
      });
    }
    // Edges need both ends present — a dangling reference throws in Cytoscape
    // and kills the whole render.
    var nodeIds = {};
    elements.forEach(function (e) {
      var d = e && e.data;
      if (d && d.id && !d.source) nodeIds[d.id] = true;
    });
    elements = elements.filter(function (e) {
      var d = e && e.data;
      if (!d) return false;
      if (d.source && d.target) return !!(nodeIds[d.source] && nodeIds[d.target]);
      return true;
    });
    var key = viewKey && viewKey !== "flat" ? viewKey : "flat";
    if (key !== "flat") elements = R.partitionElementsForFloor(elements, key);

    // The page files each view's hand-tuned layout under its own key.
    var layouts = data && data.savedLayouts;
    var saved = layouts && layouts[key] && layouts[key].positions;
    var savedPositions = saved && typeof saved === "object" ? saved : null;

    var columns = R.computeGroupedLayout(elements) || R.computeTopologyColumns(elements);
    var layoutConfig;
    if (columns) {
      var positions = {};
      Object.keys(columns).forEach(function (id) {
        positions[id] = { x: columns[id].depth * TOPO_COL_SPACING, y: columns[id].lane * TOPO_ROW_SPACING };
      });
      layoutConfig = { name: "preset", positions: positions, fit: false, padding: 30 };
    } else {
      layoutConfig = { name: "dagre", rankDir: "LR", nodeSep: 30, rankSep: 160, fit: false, padding: 30 };
    }

    var cy = window.cytoscape({
      container: container,
      elements: elements,
      boxSelectionEnabled: false,
      autoungrabify: true,   // read-only: nothing moves
      autounselectify: true, // ...and nothing is picked
      wheelSensitivity: 0.2,
      style: R.topologyStylesheet(topoTheme()),
    });

    // Registered BEFORE the layout runs: a preset layout is synchronous and
    // would emit layoutstop before a later listener attached.
    cy.one("layoutstop", function () {
      if (savedPositions) {
        cy.batch(function () {
          cy.nodes().forEach(function (n) {
            var p = savedPositions[n.id()];
            if (p && typeof p.x === "number" && typeof p.y === "number") n.position({ x: p.x, y: p.y });
          });
        });
      }
      R.renderLocationGroups(cy);
      if (cy.nodes("[isLocGroup]").length > 0) R.routeInterGroupEdges(cy);
      if (window.PolarisTopologyEdgeEditor) {
        window.PolarisTopologyEdgeEditor.attach(cy, {
          positions: savedPositions,
          isEditable: function () { return false; },
        });
      }
      if (view) {
        cy.zoom(view.zoom);
        cy.pan(view.pan);
      } else {
        try { cy.fit(undefined, 30); } catch (_) {}
      }
    });

    // Nothing is draggable, so a drag anywhere — a hull fills most of a
    // grouped site — pans the graph.
    cy.nodes().panify();
    cy.on("add", "node", function (evt) { evt.target.panify(); });

    // Hovering a link names its two ends, their ports and the kind of link.
    cy.on("mouseover", "edge", function (evt) {
      var html = R.edgeTooltipHtml(cy, evt.target);
      if (!html) return;
      var tip = edgeTip();
      tip.innerHTML = html; // escaped by edgeTooltipHtml
      tip.classList.add("visible");
      var o = evt.originalEvent;
      if (o) moveEdgeTip(o.clientX, o.clientY);
    });
    cy.on("mousemove", "edge", function (evt) {
      var o = evt.originalEvent;
      if (o) moveEdgeTip(o.clientX, o.clientY);
    });
    cy.on("mouseout", "edge", hideEdgeTip);
    // A portal stub stands for a device in another view; tapping it goes
    // there (when the caller allows that view).
    if (onPortal) {
      cy.on("tap", "node[isPortal]", function (evt) {
        var target = evt.target.data("targetView");
        if (target) onPortal(target);
      });
    }

    if (columns) {
      R.markFanOutEdges(cy, columns, { colSpacing: TOPO_COL_SPACING, orientation: "horizontal" });
    }
    R.wireBentEdgeLabels(cy);
    cy.layout(layoutConfig).run();
    return cy;
  }

  // The legend's body: the Device Map page's key (topology-render.js) less the
  // node rows for device types this widget hides, and less "Endpoint" — that
  // node comes only from the page's endpoint search, which the widget lacks.
  function legendHtml(hidden) {
    var R = window.PolarisTopologyRender;
    var spec = R.topologyLegendSpec ? R.topologyLegendSpec(topoTheme()) : null;
    if (!spec || !R.topologyLegendHtml) return "";
    var hiddenLabels = { Endpoint: true };
    TOPO_TYPES.forEach(function (t) { if (hidden && hidden[t.role]) hiddenLabels[t.legend] = true; });
    spec = Object.assign({}, spec, {
      nodes: (spec.nodes || []).filter(function (n) { return !hiddenLabels[n.label]; }),
    });
    return R.topologyLegendHtml(spec);
  }

  // One gate's read-only topology as a pane over the widget body. gate =
  // {id, name}; opts.onBack (map modes only) draws the "Map" button,
  // opts.fullscreen binds the widget's full-screen toggle, opts.hidden
  // ({role: true}) is the gear's Device types, opts.lock (view keys) and
  // opts.rotateSec the gear's Locations. Returns {close, resize}.
  function openTopologyPane(el, gate, opts) {
    opts = opts || {};
    var lock = opts.lock || [];
    var pane = document.createElement("div");
    pane.className = "devmap-topo";
    var graph = document.createElement("div");
    graph.className = "devmap-topo-graph";
    pane.appendChild(graph);
    var msg = document.createElement("p");
    msg.className = "empty-state devmap-topo-msg";
    msg.textContent = "Loading topology…";
    pane.appendChild(msg);

    var bar = document.createElement("div");
    bar.className = "devmap-topo-bar";
    var left = document.createElement("div");
    var right = document.createElement("div");
    bar.appendChild(left);
    bar.appendChild(right);
    if (opts.onBack) {
      var back = document.createElement("button");
      back.type = "button";
      back.textContent = "← Map";
      back.title = "Back to the map";
      back.addEventListener("click", function () { opts.onBack(); });
      left.appendChild(back);
    }
    var title = document.createElement("span");
    title.className = "devmap-topo-title";
    title.textContent = gate.name || "FortiGate";
    title.title = (gate.name || "FortiGate") + " — read-only topology";
    left.appendChild(title);
    // Rotation through the locked views, when the gear set one: ⏸ pauses it
    // (so does picking a chip), ▶ resumes. Drawn once the views are known.
    var rotateBtn = document.createElement("button");
    rotateBtn.type = "button";
    rotateBtn.className = "devmap-topo-rotate";
    rotateBtn.hidden = true;
    rotateBtn.addEventListener("click", function () { setPaused(!paused); });
    right.appendChild(rotateBtn);
    var fit = document.createElement("button");
    fit.type = "button";
    fit.textContent = "Fit";
    fit.title = "Fit the whole site";
    fit.addEventListener("click", function () { if (cy) try { cy.fit(undefined, 30); } catch (_) {} });
    right.appendChild(fit);
    // The full Device Map page, where the topology can be edited. Not on the
    // /dash kiosk, which has no navigation.
    if (!isDash()) {
      var open = document.createElement("button");
      open.type = "button";
      open.textContent = "Open ↗";
      open.title = "Open this topology on the Device Map page";
      open.addEventListener("click", function () {
        window.location.href = "/map.html#site=" + encodeURIComponent(gate.id) + "&topology=1";
      });
      right.appendChild(open);
    }
    if (opts.fullscreen) {
      var full = document.createElement("button");
      full.type = "button";
      full.title = "Fullscreen (Esc to exit)";
      right.appendChild(full);
      opts.fullscreen.bind(full);
    }
    pane.appendChild(bar);

    // Location chips under the bar — the Device Map page's switcher, limited
    // to the lock when there is one.
    var chips = document.createElement("div");
    chips.className = "devmap-topo-views";
    chips.hidden = true;
    pane.appendChild(chips);

    // The legend: bottom-left, collapsed into its button until opened (the
    // graph is small in a widget), open/closed remembered per viewer.
    var legend = document.createElement("div");
    legend.className = "topology-legend devmap-topo-legend";
    legend.hidden = true; // until the renderer has loaded and filled it
    var legendBody = document.createElement("div");
    legendBody.className = "topology-legend-body";
    legend.appendChild(legendBody);
    pane.appendChild(legend);
    if (window.PolarisLegendToggle) {
      window.PolarisLegendToggle.attach(legend, { storageKey: "polaris.legend.deviceMapTopology", defaultExpanded: false });
    }
    function fillLegend() {
      var html = legendHtml(opts.hidden);
      legendBody.innerHTML = html;
      legend.hidden = !html;
    }
    el.appendChild(pane);

    var cy = null, data = null, closed = false;
    var views = [];          // the site's location views (computeFloorViews)
    var activeKey = null;    // the view on screen; null until the first load
    var renderedKey = null;  // the view the current graph was drawn for
    var paused = false;
    var rotateTimer = null;

    // A view a viewer may be on: inside the lock, or anything when unlocked.
    function reachable(key) {
      if (!lock.length) return key === "flat" || views.some(function (v) { return v.key === key; });
      return allowedViews(views, lock).some(function (v) { return v.key === key; });
    }
    function setView(key, byViewer) {
      if (!reachable(key)) return;
      if (byViewer) setPaused(true);
      if (key === activeKey) return;
      activeKey = key;
      render();
      renderChips();
    }
    function setPaused(p) {
      paused = !!p;
      rotateBtn.textContent = paused ? "▶" : "⏸";
      rotateBtn.title = paused ? "Resume rotating through the locked locations" : "Pause the rotation";
      rotateBtn.setAttribute("aria-pressed", paused ? "true" : "false");
    }
    // Step to the locked view after the one on screen (or after the one the
    // viewer drilled into, counted from the locked view holding it).
    function rotate() {
      if (paused || closed || document.hidden || !data) return;
      var keys = rotationKeys(views, lock);
      if (keys.length < 2) return;
      var cur = views.filter(function (v) { return v.key === activeKey; })[0];
      var at = -1;
      keys.forEach(function (k, i) { if (at === -1 && cur && viewWithin(cur, k)) at = i; });
      setView(keys[(at + 1) % keys.length], false);
    }

    function renderChips() {
      var rows = viewChipRows(views, lock, activeKey);
      chips.innerHTML = "";
      chips.hidden = !rows.length;
      rows.forEach(function (row, depth) {
        var r = document.createElement("div");
        r.className = "topology-floor-row" + (depth ? " topology-floor-row-depth-" + depth : "");
        row.forEach(function (c) {
          var b = document.createElement("button");
          b.type = "button";
          b.className = "topology-type-chip topology-floor-chip" + (c.active ? " is-active" : "");
          b.setAttribute("aria-pressed", c.active ? "true" : "false");
          b.title = c.title;
          b.textContent = c.label;
          b.addEventListener("click", function () { setView(c.key, true); });
          r.appendChild(b);
        });
        chips.appendChild(r);
      });
      fitLegend();
    }
    // The open legend stops short of the chips (one to three rows) rather
    // than running up under them; with no chips the CSS cap applies.
    function fitLegend() {
      if (chips.hidden) { legend.style.maxHeight = ""; return; }
      var room = pane.clientHeight - (chips.offsetTop + chips.offsetHeight) - 24;
      legend.style.maxHeight = Math.max(room, 60) + "px";
    }

    function render() {
      if (closed || !data) return;
      // A refresh keeps the viewer's zoom and pan; a new view fits itself.
      var view = cy && renderedKey === activeKey ? { zoom: cy.zoom(), pan: cy.pan() } : null;
      // A refresh replaces the graph under the cursor, and the old graph
      // never sends the mouseout that would close its tooltip.
      hideEdgeTip();
      if (cy) { try { cy.destroy(); } catch (_) {} }
      renderedKey = activeKey;
      cy = drawTopology(graph, data, view, opts.hidden, activeKey, function (k) { setView(k, true); });
    }
    // Every load: the site's views again (a device may have been re-coded),
    // and the view on screen kept when it is still reachable — else the first
    // locked view, or the whole site when nothing is locked (or nothing
    // locked exists any more).
    function settleViews() {
      views = window.PolarisTopologyRender.computeFloorViews(window.PolarisTopologyRender.buildTopologyElements(data));
      var keys = rotationKeys(views, lock);
      if (lock.length && !keys.length) lock = []; // every locked location is gone: show the site
      if (activeKey === null || !reachable(activeKey)) activeKey = lock.length ? keys[0] : "flat";
      var rotating = (opts.rotateSec || 0) > 0 && keys.length > 1;
      rotateBtn.hidden = !rotating;
      if (rotating && !rotateTimer) {
        setPaused(false);
        rotateTimer = setInterval(rotate, opts.rotateSec * 1000);
      }
    }
    function load() {
      return loadTopologyLibs()
        .then(function () {
          if (!legendBody.innerHTML) fillLegend();
          return api.map.topology(gate.id);
        })
        .then(function (d) {
          if (closed) return;
          data = d;
          msg.hidden = true;
          settleViews();
          render();
          renderChips();
        })
        .catch(function (err) {
          if (closed || data) return; // a failed refresh keeps the last graph
          msg.textContent = "Topology unavailable — " + (err && err.message ? err.message : String(err));
        });
    }
    load();

    // Device health colours move: refresh on the slow widget cadence, keeping
    // the viewer's zoom and pan.
    var timer = setInterval(function () { if (!document.hidden) load(); }, PolarisWidgets.REFRESH.slow);
    // The legend's swatches are per theme family, like the graph's colours.
    function onTheme() { if (window.PolarisTopologyRender) fillLegend(); render(); }
    document.addEventListener("themechange", onTheme);
    var ro = new ResizeObserver(function () {
      if (cy) try { cy.resize(); } catch (_) {}
      fitLegend();
    });
    ro.observe(pane);

    return {
      resize: function () { if (cy) try { cy.resize(); cy.fit(undefined, 30); } catch (_) {} },
      close: function () {
        closed = true;
        clearInterval(timer);
        if (rotateTimer) clearInterval(rotateTimer);
        document.removeEventListener("themechange", onTheme);
        try { ro.disconnect(); } catch (_) {}
        hideEdgeTip();
        if (cy) { try { cy.destroy(); } catch (_) {} cy = null; }
        if (pane.parentNode) pane.parentNode.removeChild(pane);
      },
    };
  }

  // The widget body's full-screen state, shared by the map's ⛶ button and an
  // open topology pane's. onChange(on) runs after the layout settles.
  function fullscreenToggle(el, onChange) {
    var buttons = [];
    function isOn() { return el.classList.contains("sitemap-fullscreen"); }
    function paint(b) {
      b.innerHTML = isOn() ? "✖" : "⛶";
      b.classList.toggle("active", isOn());
    }
    function set(on) {
      el.classList.toggle("sitemap-fullscreen", on);
      buttons = buttons.filter(function (b) { return b.isConnected; });
      buttons.forEach(paint);
      setTimeout(function () { onChange(on); }, 60);
    }
    function onKeydown(e) { if (e.key === "Escape" && isOn()) set(false); }
    document.addEventListener("keydown", onKeydown);
    return {
      bind: function (b) {
        buttons.push(b);
        paint(b);
        b.addEventListener("click", function () { set(!isOn()); });
      },
      dispose: function () { document.removeEventListener("keydown", onKeydown); },
    };
  }

  // Monitor-health → CSS class, mirroring monitorClass() in map.js. Dependency
  // suppression takes precedence only while the probe itself isn't down (the
  // device is reachable via a redundant path); a real down probe still paints red.
  function monitorClass(site) {
    if (!site.monitored) return "monitor-unmonitored";
    if (site.dependencySuppressed && site.monitorHealth !== "down") return "monitor-dep-down";
    switch (site.monitorHealth) {
      case "up":       return "monitor-up";
      case "degraded": return "monitor-degraded";
      case "down":     return "monitor-down" + (site.alertAcknowledged === true ? " acked" : "");
      // No down-detection automation covers it, so there is no verdict to
      // paint. NOT "unknown", which claims we have no samples.
      case "passive":  return "monitor-passive";
      default:         return "monitor-unknown";
    }
  }

  function monitorLine(site) {
    if (!site.monitored) return "Unmonitored";
    var samples = site.monitorRecentSamples || 0, failures = site.monitorRecentFailures || 0;
    if (site.dependencySuppressed && site.monitorHealth !== "down") {
      var layer = (site.dependencyLayer != null) ? " (Layer " + site.dependencyLayer + ")" : "";
      return "Dependency down — upstream parent offline" + layer;
    }
    switch (site.monitorHealth) {
      case "up":       return "Up — last " + samples + " samples ok";
      case "degraded": return "Packet loss — " + failures + "/" + samples + " recent samples failed";
      case "down":     return "Down — " + failures + "/" + samples + " samples failed" + (site.alertAcknowledged === true ? " · acknowledged" : "");
      default:         return "Monitored — no samples yet";
    }
  }

  // Cluster bubble color = worst monitor health among children (not the count),
  // mirroring clusterIcon() in map.js.
  function clusterIcon(cluster) {
    var children = cluster.getAllChildMarkers();
    // A down cluster fades (`acked`) only when EVERY down child's alert is
    // acknowledged — one unowned outage inside keeps the bubble at full red.
    var sawMonitored = false, sawDepDown = false, sawUnackedDown = false, worst = "up";
    for (var i = 0; i < children.length; i++) {
      var s = children[i]._site;
      if (!s || !s.monitored) continue;
      sawMonitored = true;
      if (s.monitorHealth === "down") {
        worst = "down";
        if (s.alertAcknowledged !== true) { sawUnackedDown = true; break; }
        continue;
      }
      if (s.monitorHealth === "degraded" && worst !== "down") worst = "degraded";
      if (s.dependencySuppressed && s.monitorHealth !== "down") sawDepDown = true;
    }
    var cls;
    if (!sawMonitored)       cls = "monitor-unmonitored";
    else if (worst !== "up") cls = "monitor-" + worst + (worst === "down" && !sawUnackedDown ? " acked" : "");
    else if (sawDepDown)     cls = "monitor-dep-down";
    else                     cls = "monitor-up";
    return L.divIcon({
      html: '<div class="fg-cluster ' + cls + '"><span>' + cluster.getChildCount() + "</span></div>",
      className: "",
      iconSize: [40, 40],
    });
  }

  // Per-user map theme, independent of the app theme (matches the map page's
  // toolbar toggle idiom): "light" | "dark", defaulting to the app theme.
  function themePref() {
    try {
      var v = localStorage.getItem("polaris-devicemap-theme");
      if (v === "light" || v === "dark") return v;
    } catch (_) {}
    // The app theme's FAMILY: this picks one of two basemaps, and an id
    // comparison misses every daylight theme but the retired `light`.
    return (typeof isLightTheme === "function" && isLightTheme()) ? "light" : "dark";
  }

  PolarisWidgets.register({
    type: "deviceMap",
    category: "NOC",
    label: "Device Map",
    description: "FortiGates on a map with monitor-health dots — or, with one gate picked, that gate's topology. Double-click a gate for its topology.",
    defaultSize: { width: 6, height: 2 },
    minSize: { width: 4, height: 1 },
    defaultConfig: { regionScope: "mine" },
    requiredPermission: { key: "deviceMap", level: "read" },

    // One gate picked → { gate: {id, name} } (null id = no longer in the
    // fleet); otherwise the region scope's /map/sites rows.
    fetchData: function (config) {
      var gates = pickedGates(config);
      if (gates.length === 1) {
        return PolarisWidgets.getFortigateOptions().then(function (opts) {
          var hit = (opts || []).filter(function (g) { return g.name === gates[0]; })[0];
          return { gate: { id: hit && hit.id ? hit.id : null, name: gates[0] } };
        }).catch(function () { return { gate: { id: null, name: gates[0] } }; });
      }
      return PolarisWidgets.getMapSites(PolarisWidgets.regionNamesForConfig(config)).catch(function () { return []; });
    },

    renderInstance: function (el, config, data, ctx) {
      el.classList.add("sitemap-body");
      el.style.position = "relative";
      var gates = pickedGates(config);
      var pane = null;

      // ── One gate: its topology, no map ──────────────────────────────────
      if (gates.length === 1) {
        var gate = data && data.gate;
        if (!gate || !gate.id) {
          el.insertAdjacentHTML("beforeend", '<p class="empty-state">FortiGate ' + escapeHtml(gates[0]) + " is no longer in the fleet</p>");
          ctx.onUnmount(function () { el.classList.remove("sitemap-body"); });
          return;
        }
        var soloFull = fullscreenToggle(el, function () { if (pane) pane.resize(); });
        // The Locations lock belongs to this one gate (its view keys are this
        // site's), so only the one-gate view takes it; a gate double-clicked
        // on a map drills freely.
        pane = openTopologyPane(el, gate, {
          fullscreen: soloFull,
          hidden: hiddenRoles(config),
          lock: lockKeys(config),
          rotateSec: ROTATE_CHOICES.indexOf(config.topologyRotateSec) > 0 ? config.topologyRotateSec : 0,
        });
        ctx.onUnmount(function () {
          pane.close();
          soloFull.dispose();
          el.classList.remove("sitemap-body", "sitemap-fullscreen");
        });
        return;
      }

      if (typeof L === "undefined") { el.innerHTML = '<p class="empty-state">Map library unavailable</p>'; return; }
      if (!_iconPathSet) { L.Icon.Default.imagePath = "/css/vendor/leaflet/images/"; _iconPathSet = true; }

      var mapDiv = document.createElement("div");
      mapDiv.style.cssText = "position:absolute;inset:0";
      el.appendChild(mapDiv);

      // zoomSnap 0.25 lets fitBounds land on fractional zoom levels (integer
      // snap rounds DOWN a whole level and strands the fleet in a corner);
      // wheelPxPerZoomLevel doubled from Leaflet's 60 default = gentler scroll.
      var map = L.map(mapDiv, {
        worldCopyJump: true, center: [39.5, -95], zoom: 4,
        zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 120,
        attributionControl: true, zoomControl: true,
      });

      // Home/reset control under the +/− buttons: refit all sites.
      var homeBounds = null;
      function goHome() { if (homeBounds) map.fitBounds(homeBounds, { maxZoom: 12 }); }
      var HomeControl = L.Control.extend({
        options: { position: "topleft" },
        onAdd: function () {
          var div = L.DomUtil.create("div", "leaflet-bar");
          var a = L.DomUtil.create("a", "sitemap-home", div);
          a.href = "#"; a.title = "Reset view"; a.setAttribute("role", "button"); a.innerHTML = "⌂";
          L.DomEvent.on(a, "click", function (e) { L.DomEvent.stop(e); goHome(); });
          return div;
        },
      });
      map.addControl(new HomeControl());

      // Theme-aware basemap: OpenStreetMap in both themes, matching the Device
      // Map page (CARTO's Dark Matter served the dark half until CARTO began
      // requiring an API key). The .sitemap-dark class darkens the tile pane so
      // the health dots stay legible on dark.
      var mapTheme = themePref();
      var basemap = null;
      function applyBasemap() {
        if (basemap) { map.removeLayer(basemap); basemap = null; }
        var dark = mapTheme === "dark";
        // Single-host tile URL. The OSM tile usage policy permits only
        // https://tile.openstreetmap.org/{z}/{x}/{y}.png — the older {s} a/b/c
        // subdomain form spreads one viewport over three hosts instead of one
        // multiplexed HTTP/2 connection, and reads to their operators as a
        // policy violation: tiles come back as the "Access blocked" image.
        basemap = L.tileLayer(
          "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
          { maxZoom: 19, attribution: "© OpenStreetMap contributors" }
        ).addTo(map);
        el.classList.toggle("sitemap-dark", dark);
      }
      applyBasemap();

      var markerCluster = L.markerClusterGroup({
        showCoverageOnHover: false,
        maxClusterRadius: 40,
        disableClusteringAtZoom: 11,
        spiderfyOnMaxZoom: true,
        iconCreateFunction: clusterIcon,
      });
      map.addLayer(markerCluster);

      function makeMarker(site) {
        var label = escapeHtml((site.hostname || "FG").slice(0, 3).toUpperCase());
        var marker = L.marker([site.latitude, site.longitude], {
          icon: L.divIcon({
            className: "",
            html: '<div class="fg-marker ' + monitorClass(site) + '" aria-hidden="true">' + label + "</div>",
            iconSize: [34, 34], iconAnchor: [17, 17],
          }),
          title: site.hostname || "",
        });
        marker._site = site;   // clusterIcon() rolls up health across children
        var HP = window.POLARIS_HEALTH_COLORS;
        var color = { "monitor-up": HP.up, "monitor-degraded": HP.degraded, "monitor-down": HP.down, "monitor-dep-down": HP.depDown, "monitor-unmonitored": HP.unmonitored, "monitor-passive": HP.passive, "monitor-unknown": HP.unknown }[monitorClass(site).split(" ")[0]] || HP.unknown;
        var name = escapeHtml(site.hostname || "(unnamed)");
        marker.bindTooltip(
          "<strong>" + name + "</strong>" +
          (site.model ? '<br><span style="opacity:.8">' + escapeHtml(site.model) + "</span>" : "") +
          '<br><span style="opacity:.8">' + escapeHtml(monitorLine(site)) + "</span>" +
          (site.subnetCount ? "<br>" + site.subnetCount + " subnet" + (site.subnetCount === 1 ? "" : "s") : "") +
          '<br><span style="opacity:.6">Double-click for topology</span>',
          { direction: "top", offset: [0, -14] }
        );
        // Double-click swaps the map for the gate's read-only topology (a
        // marker's events don't bubble to the map, so its double-click zoom
        // stays out of it). The /dash kiosk has no hover, so a single click
        // there also surfaces a details popup.
        marker.on("dblclick", function (e) {
          if (e && e.originalEvent) L.DomEvent.stop(e.originalEvent);
          openGate(site);
        });
        if (isDash()) {
          marker.bindPopup(
            '<div class="sitemap-popup-title" style="color:' + color + '">' + name + "</div>" +
            (site.model ? '<div class="sitemap-popup-row">' + escapeHtml(site.model) + "</div>" : "") +
            (site.ipAddress ? '<div class="sitemap-popup-row"><span>IP</span><code>' + escapeHtml(site.ipAddress) + "</code></div>" : "") +
            '<div class="sitemap-popup-row">' + escapeHtml(monitorLine(site)) + "</div>" +
            (site.subnetCount ? '<div class="sitemap-popup-row">' + site.subnetCount + " subnet" + (site.subnetCount === 1 ? "" : "s") + "</div>" : ""),
            { maxWidth: 280 }
          );
        }
        return marker;
      }

      function openGate(site) {
        if (pane) pane.close();
        pane = openTopologyPane(el, { id: site.id, name: site.learnedLocation || site.hostname }, {
          fullscreen: full,
          hidden: hiddenRoles(config),
          onBack: function () {
            if (pane) { pane.close(); pane = null; }
          },
        });
      }

      function buildMarkers(sites) {
        markerCluster.clearLayers();
        var rows = (sites || []).filter(function (s) { return s.latitude != null && s.longitude != null; });
        // Several gates picked: only those (matched on the name the FortiGates
        // picker offers — the gate's learnedLocation).
        if (gates.length) rows = rows.filter(function (s) { return gates.indexOf(s.learnedLocation) !== -1; });
        var latlngs = [];
        rows.forEach(function (s) {
          markerCluster.addLayer(makeMarker(s));
          latlngs.push([s.latitude, s.longitude]);
        });
        if (latlngs.length) homeBounds = L.latLngBounds(latlngs).pad(0.05);
      }
      buildMarkers(data);
      goHome();

      // ── Overlay controls: legend (bottom-left) + theme/fullscreen (top-right) ──
      var controls = document.createElement("div");
      controls.className = "sitemap-controls";
      controls.innerHTML =
        '<div class="sitemap-legend">' +
          '<span><i style="background:#2e7d32"></i>Up</span>' +
          '<span><i style="background:#f9a825"></i>Warn</span>' +
          '<span><i style="background:#c62828"></i>Down</span>' +
          '<span><i style="background:#607d8b"></i>Dep down</span>' +
          '<span><i style="background:#757575"></i>Unmonitored</span>' +
        '</div>' +
        '<div class="sitemap-wx">' +
          '<button type="button" data-k="theme" title="Toggle map theme"></button>' +
          '<button type="button" data-k="full" title="Fullscreen (Esc to exit)">⛶</button>' +
        '</div>';
      el.appendChild(controls);
      var btnTheme = controls.querySelector('[data-k="theme"]');
      var btnFull = controls.querySelector('[data-k="full"]');
      var THEME_SUN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
      var THEME_MOON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';
      // The theme toggle sits on the map's top-left corner, above the zoom
      // bar, as on the Device Map page (map.js addMapThemeControl).
      var themeCtl = L.control({ position: "topleft" });
      themeCtl.onAdd = function () {
        var d = L.DomUtil.create("div", "sitemap-theme-control");
        d.appendChild(btnTheme);
        L.DomEvent.disableClickPropagation(d);
        return d;
      };
      themeCtl.addTo(map);
      var themeCtlEl = themeCtl.getContainer();
      if (themeCtlEl && themeCtlEl.parentNode) themeCtlEl.parentNode.insertBefore(themeCtlEl, themeCtlEl.parentNode.firstChild);
      L.DomEvent.disableClickPropagation(controls);
      function paintTheme() { btnTheme.innerHTML = mapTheme === "dark" ? THEME_SUN : THEME_MOON; }
      btnTheme.addEventListener("click", function () {
        mapTheme = mapTheme === "dark" ? "light" : "dark";
        try { localStorage.setItem("polaris-devicemap-theme", mapTheme); } catch (_) {}
        applyBasemap();
        paintTheme();
      });
      // Re-home after the layout change (and invalidateSize) so the fleet
      // refits to the new viewport instead of keeping the old framing; an
      // open topology refits too.
      var full = fullscreenToggle(el, function () {
        try { map.invalidateSize(); } catch (_) {}
        goHome();
        if (pane) pane.resize();
      });
      full.bind(btnFull);
      paintTheme();

      // ── Resize + 60s refresh + teardown ──────────────────────────────────
      var raf = null;
      var ro = new ResizeObserver(function () {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(function () { try { map.invalidateSize(); } catch (_) {} });
      });
      ro.observe(el);

      var siteTimer = setInterval(function () {
        // A backgrounded window has nobody watching the map; the shared memo
        // already collapses concurrent instances into one request.
        if (document.hidden) return;
        PolarisWidgets.getMapSites(PolarisWidgets.regionNamesForConfig(config)).then(function (sites) { buildMarkers(sites); }).catch(function () {});
      }, PolarisWidgets.REFRESH.slow);

      ctx.onUnmount(function () {
        clearInterval(siteTimer);
        if (pane) { pane.close(); pane = null; }
        full.dispose();
        try { ro.disconnect(); } catch (_) {}
        if (raf) cancelAnimationFrame(raf);
        try { if (controls.parentNode) controls.parentNode.removeChild(controls); } catch (_) {}
        try { map.remove(); } catch (_) {}
        el.classList.remove("sitemap-body", "sitemap-dark", "sitemap-fullscreen");
      });
    },

    renderPreview: function (el) {
      el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:120px;flex-direction:column;gap:6px;color:var(--color-text-secondary)">' +
        '<div style="font-size:2rem">🛰️</div><div style="font-size:0.82rem">Device map · FortiGate health dots + clustering</div></div>';
    },

    renderConfig: function (el, config, onChange) {
      // Device types: which kinds of device a topology draws (the one-gate
      // view, and a gate double-clicked on the map). Stored as the unticked
      // roles, so a type added later shows by default.
      var hidden = hiddenRoles(config);
      el.innerHTML =
        '<label>Device types</label>' +
        '<div class="widget-config-typegrid">' +
          TOPO_TYPES.map(function (t) {
            return '<label class="widget-config-typeopt"><input type="checkbox" data-topo-role="' + t.role + '"' +
              (hidden[t.role] ? "" : " checked") + "> " + escapeHtml(t.label) + "</label>";
          }).join("") +
        "</div>" +
        '<p class="widget-config-hint">Which devices a gate\'s topology shows. Their links are hidden with them.</p>';
      el.querySelectorAll("[data-topo-role]").forEach(function (cb) {
        cb.addEventListener("change", function () {
          var off = [];
          el.querySelectorAll("[data-topo-role]").forEach(function (x) {
            if (!x.checked) off.push(x.getAttribute("data-topo-role"));
          });
          onChange("topologyHide", off);
        });
      });
      var locWrap = document.createElement("div");
      locWrap.className = "devmap-cfg-locations";
      el.appendChild(locWrap);
      renderLocationsConfig(locWrap, config, onChange);
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, false, {
        fortigates: true,
        fortigateNote: "One gate ticked = its topology instead of the map. Several = a map of just those. Nothing ticked = every gate in the regions above.",
      });
    },
  });
})();
