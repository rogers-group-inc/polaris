// public/js/topology-render.js — shared topology graph builders.
//
// Both the desktop Device Map (public/js/map.js) and the mobile topology
// surface (public/js/mobile/topology-tab.js) consume the /map/sites/:id/topology
// payload and render it via Cytoscape. Element construction + the visual
// stylesheet are identical between the two — node colors per monitor health,
// edge styles for controller / interface-inferred / LLDP edges, ghost LLDP
// nodes, cross-site remote assets, operator-uploaded icons. Diverging those
// rules across desktop and mobile would just be drift bait, so they live
// here.
//
// Mobile-only knobs (top-to-bottom dagre, no drag-to-reposition) stay in the
// mobile module — this file only exposes shared building blocks.

(function () {
  // Topology node-health palette. Shared by fortinetNodeColor() and the legend
  // here, AND by map.js's endpointNodeColor() (which loads after this file and
  // reads it off window.PolarisTopologyRender). These hues are deliberately
  // distinct from the CSS --color-* theme variables and from the assets-page
  // monitor-state palette — do NOT remap them. Extracting them here only
  // deduplicates the literals across the two files; the rendered values are
  // unchanged.
  // Canonical hexes live in api.js (POLARIS_HEALTH_COLORS — loaded first on
  // every page); re-exposed here for the topology consumers.
  var HEALTH_NODE_COLORS = window.POLARIS_HEALTH_COLORS;

  // Color a Fortinet-infrastructure node (FortiGate, FortiSwitch, FortiAP)
  // from its monitor health. Same priority as the asset list Status pill:
  // the dependency-suppression flag wins over the probe-derived health, so a
  // suppressed node renders gray ("Dep. Down") even when its own probe is
  // also failing — on the topology graph the down parent is the red node.
  function fortinetNodeColor(asset) {
    if (!asset) return HEALTH_NODE_COLORS.unmonitored;
    // Maintenance wins over probe health and dependency suppression: the
    // monitorStatus is frozen (polling is paused) so it isn't live state, and
    // the node is intentionally offline. Paint it the maintenance purple.
    if (asset.status === "maintenance") return HEALTH_NODE_COLORS.maintenance;
    if (!asset.monitored) return HEALTH_NODE_COLORS.unmonitored;
    if (asset.dependencySuppressed) return HEALTH_NODE_COLORS.unknown; // Dep. Down (upstream parent offline)
    switch (asset.monitorHealth) {
      case "up":       return HEALTH_NODE_COLORS.up;
      case "degraded": return HEALTH_NODE_COLORS.degraded;
      case "down":     return HEALTH_NODE_COLORS.down;
      // No down-detection automation covers it, so there is no verdict to
      // paint. Distinct from the grey "unknown", which means no samples.
      case "passive":  return HEALTH_NODE_COLORS.passive;
      default:         return HEALTH_NODE_COLORS.unknown;
    }
  }

  // Canonical grouping key for a location-code value: trim, collapse internal
  // whitespace, lowercase. Mirrors locationGroupKey in the server's
  // utils/locationCodes.ts (the grammar itself is server-only — nodes arrive
  // with resolved display values; only membership comparison happens here).
  function locKey(value) {
    return String(value).replace(/\s+/g, " ").replace(/^ | $/g, "").toLowerCase();
  }

  // Location-code node-data stamps from a payload node's `location` object
  // ({ area, building, floor, room, junctionBox } | null). locA/locB/locF/
  // locR/locJb are normalized grouping keys (drive the row-clustering pass +
  // grouping hulls); loc*Name keep the operator's original casing for labels.
  function locationData(loc) {
    var d = {};
    if (!loc) return d;
    if (loc.area) { d.locA = locKey(loc.area); d.locAName = String(loc.area); }
    if (loc.building) { d.locB = locKey(loc.building); d.locBName = String(loc.building); }
    if (loc.floor) { d.locF = locKey(loc.floor); d.locFName = String(loc.floor); }
    if (loc.room) { d.locR = locKey(loc.room); d.locRName = String(loc.room); }
    if (loc.junctionBox) { d.locJb = locKey(loc.junctionBox); d.locJbName = String(loc.junctionBox); }
    return d;
  }

  // Build the elements array Cytoscape consumes from a /topology payload.
  // The shape mirrors what desktop map.js used to construct inline; mobile
  // and desktop now both call this so a new node/edge type only needs to
  // be added in one place.
  function buildTopologyElements(data) {
    if (!data) return [];
    var elements = [];

    if (data.fortigate) {
      elements.push({
        data: Object.assign({
          id: data.fortigate.id,
          label: data.fortigate.hostname || "FortiGate",
          role: "fortigate",
          nodeColor: fortinetNodeColor(data.fortigate),
          iconUrl: data.fortigate.iconUrl || null,
          hasIcon: data.fortigate.iconUrl ? 1 : 0,
        }, locationData(data.fortigate.location)),
      });
    }
    (data.switches || []).forEach(function (s) {
      elements.push({
        data: Object.assign({
          id: s.id,
          label: s.hostname || "FortiSwitch",
          role: "fortiswitch",
          nodeColor: fortinetNodeColor(s),
          iconUrl: s.iconUrl || null,
          hasIcon: s.iconUrl ? 1 : 0,
        }, locationData(s.location)),
      });
    });
    // AP id set — used to detect wireless MESH: a leaf AP shows up in the
    // station table of its ROOT AP (the root sees its mesh child as an
    // associated client; the leaf does not list the root). Only APs ever
    // appear in another AP's station list — a switch never does — so the mesh
    // match is AP-only. When a station resolves to another AP in this site we
    // draw a mesh edge root→leaf instead of a client diamond.
    var apIdSet = {};
    (data.aps || []).forEach(function (a) { if (a && a.id) apIdSet[a.id] = true; });
    // Mesh leaves (filled in the AP loop below). Their wired fallback edge from
    // the FortiGate is bogus — superseded by the mesh edge — so it's skipped
    // when emitting controller edges so the graph doesn't show a stray gray
    // line crossing to the leaf.
    var meshLeafIds = {};

    (data.aps || []).forEach(function (a) {
      elements.push({
        data: Object.assign({
          id: a.id,
          label: a.hostname || "FortiAP",
          role: "fortiap",
          nodeColor: fortinetNodeColor(a),
          iconUrl: a.iconUrl || null,
          hasIcon: a.iconUrl ? 1 : 0,
        }, locationData(a.location)),
      });
      // Wireless stations connected to this AP. Each station becomes a
      // small diamond node hanging off the AP via a dashed-cyan "wireless"
      // edge. Stations matched to a Polaris asset get the asset's
      // hostname as the label and the asset id as a tap target; unmatched
      // stations show their MAC (the only identity available).
      (a.stations || []).forEach(function (s) {
        // Mesh child: this "station" is actually another FortiAP (mesh leaf).
        // Draw a mesh edge root(a) → leaf(s.id) and skip the client diamond —
        // the leaf already has its own fortiap node.
        if (s.id && apIdSet[s.id] && s.id !== a.id) {
          meshLeafIds[s.id] = true;
          elements.push({
            data: {
              id: "mesh-" + a.id + "-" + s.id,
              source: a.id, target: s.id,
              label: s.ssid || "mesh",
              isMesh: 1,
            },
          });
        }
        // Wireless CLIENT stations (workstations / servers / phones / etc.) are
        // intentionally NOT rendered — the topology shows the FG / switch / AP
        // backbone only. The endpoint search reveals a specific host on demand.
      });
    });
    // Wireless-bridge edges (server-detected via LLDP): a FortiLink switch
    // behind a FortiAP. A real wired ethernet link (the switch's uplink cable
    // lands on the AP's LAN port) — styled like the other AP↔switch links
    // (solid, isApLink) rather than the dashed wireless mesh. isBridge keeps
    // the mesh-leaf layout semantics: the switch is marked a bridge leaf so
    // its FortiLink controller edge is skipped below and the solver routes it
    // behind the AP.
    (data.bridgeEdges || []).forEach(function (e, i) {
      meshLeafIds[e.target] = true;
      elements.push({
        data: {
          id: "br" + i, source: e.source, target: e.target,
          label: e.label || "", reason: e.reason || "",
          isBridge: 1,
          isApLink: 1,
        },
      });
    });
    // FortiGate id + switch id set so we can label/style the FortiGate→switch
    // FortiLink uplinks. FortiOS reports `fortilink` (a logical meta-interface,
    // not a physical port) on those, so the raw label is often
    // "unknown ↔ unknown" — relabel those to "fortilink", and dash-gray the
    // UNVERIFIED ones (no interface/LLDP-backed cable) to read as a
    // virtual/management link. When the server resolved interface details on
    // BOTH ends (srcIf/tgtIf — FG side LLDP-confirmed, switch side resolved
    // through the trunk→physical-member swap), the link is a known physical
    // cable: keep a real port-pair label like any normal connection.
    var fgId = data.fortigate ? data.fortigate.id : null;
    var switchIdSet = {};
    (data.switches || []).forEach(function (s) { if (s && s.id) switchIdSet[s.id] = true; });
    (data.edges || []).forEach(function (e, i) {
      // Skip the bogus wired uplink to a mesh/bridge leaf — the mesh edge
      // already connects it (and from the correct parent AP).
      if (meshLeafIds[e.target]) return;
      var isFgSwitch = fgId && e.source === fgId && switchIdSet[e.target];
      var label = e.label || "";
      var fortilinkFallback = 0;
      if (isFgSwitch) {
        var srcPort = e.srcIf && e.srcIf.name;
        var tgtPort = e.tgtIf && e.tgtIf.name;
        if (e.verifiedUplink && srcPort && tgtPort) {
          // srcIf/tgtIf carry the post-swap names (trunk → single physical
          // member), so this label matches the tooltip's per-side lines.
          label = srcPort + " ↔ " + tgtPort;
        } else {
          label = "fortilink"; // logical FortiLink uplink, not a physical port pair
          if (!e.verifiedUplink) fortilinkFallback = 1; // unverified → virtual (dashed gray)
        }
      }
      // Wired AP↔switch link (a managed AP's switch uplink) — styled solid +
      // colored like the bridge edges so every AP-to-switch cable reads the
      // same regardless of which side is the parent.
      var isApSwitchLink =
        (switchIdSet[e.source] && apIdSet[e.target]) ||
        (apIdSet[e.source] && switchIdSet[e.target]);
      elements.push({
        data: {
          id: "e" + i, source: e.source, target: e.target,
          label: label,
          reason: e.reason || "",
          // FG→switch controller edge with a physically-confirmed (interface/
          // LLDP-backed) link — treated as a verified uplink by the column
          // solver so the switch isn't mistaken for a FortiLink fallback.
          isVerifiedUplink: e.verifiedUplink ? 1 : 0,
          isFortilinkFallback: fortilinkFallback,
          isApLink: isApSwitchLink ? 1 : 0,
          srcIf: e.srcIf || null,
          tgtIf: e.tgtIf || null,
        },
      });
    });
    // LLDP ghost neighbors (non-Polaris devices — IP phones, third-party gear,
    // etc.) are NOT rendered: the topology is a managed FG/switch/AP backbone.
    // (lldpNodes intentionally skipped.)
    //
    // Cross-site remote assets render ONLY when they're infra (firewall /
    // switch / access_point); workstations / servers / "other" / phones / etc.
    // are dropped, along with any edge to them, so the backbone stays clean.
    var INFRA_REMOTE = { firewall: true, switch: true, access_point: true };
    var droppedRemoteIds = {};
    (data.remoteAssetNodes || []).forEach(function (n) {
      var rt = (n.assetType || "").toLowerCase();
      if (!INFRA_REMOTE[rt]) { droppedRemoteIds[n.id] = true; return; }
      var label = n.hostname || n.ipAddress || n.id;
      elements.push({
        data: {
          id: n.id, label: label, role: "remote-asset",
          assetId: n.id, assetType: n.assetType || null,
          iconUrl: n.iconUrl || null, hasIcon: n.iconUrl ? 1 : 0,
        },
      });
    });
    (data.lldpEdges || []).forEach(function (e, i) {
      // Skip edges to a ghost (non-asset neighbor) or to a dropped non-infra
      // remote — those nodes aren't rendered.
      if (!e.targetIsAsset) return;
      if (droppedRemoteIds[e.source] || droppedRemoteIds[e.target]) return;
      elements.push({
        data: {
          id: "le" + i, source: e.source, target: e.target,
          label: e.label || "", isLldp: 1,
          reason: e.reason || "",
          srcIf: e.srcIf || null,
          tgtIf: e.tgtIf || null,
        },
      });
    });
    (data.interfaceEdges || []).forEach(function (e, i) {
      if (droppedRemoteIds[e.source] || droppedRemoteIds[e.target]) return;
      elements.push({
        data: {
          id: "ie" + i, source: e.source, target: e.target,
          label: e.label || "", isIface: 1,
          reason: e.reason || "",
          srcIf: e.srcIf || null,
          tgtIf: e.tgtIf || null,
        },
      });
    });
    // MCLAG ICL edges: a peer/sibling link between two FortiSwitches in an
    // MCLAG pair (not a parent/child uplink). Rendered as a distinct fuchsia
    // edge; flagged isMclag so the column solver treats it as visual-only
    // (excluded from depth adjacency) and never makes one peer the other's
    // parent.
    (data.mclagEdges || []).forEach(function (e, i) {
      if (droppedRemoteIds[e.source] || droppedRemoteIds[e.target]) return;
      elements.push({
        data: {
          id: "me" + i, source: e.source, target: e.target,
          label: e.label ? "MCLAG " + e.label : "MCLAG", isMclag: 1,
          reason: e.reason || "",
        },
      });
    });

    markPhysicalLoops(elements);
    markInterGroupEdges(elements);
    return elements;
  }

  // Stamp `isInterGroup: 1` + a staggered `taxiTurn` (px) on every edge whose
  // endpoints live in DIFFERENT top-level location groups (area, else
  // building; uncoded = its own bucket, so coded↔uncoded also counts). The
  // stylesheet routes these orthogonally (curve-style: taxi) so long
  // cross-box links travel the gutters between group boxes instead of
  // slicing diagonally through them, and the per-source turn stagger keeps
  // parallel links off each other — deterministic: outgoing edges from one
  // node turn at 40px, 70px, 100px, … in element order.
  function markInterGroupEdges(elements) {
    var topKey = {};
    elements.forEach(function (el) {
      var d = el && el.data;
      if (!d || !d.id || d.source) return;
      topKey[d.id] = d.locA ? "a|" + d.locA : (d.locB ? "b|" + (d.locA || "") + "|" + d.locB : "");
    });
    var turnCount = {};
    elements.forEach(function (el) {
      var d = el && el.data;
      if (!d || !d.source || !d.target) return;
      if (!(d.source in topKey) || !(d.target in topKey)) return;
      if (topKey[d.source] === topKey[d.target]) return;
      d.isInterGroup = 1;
      var k = turnCount[d.source] || 0;
      turnCount[d.source] = k + 1;
      d.taxiTurn = 40 + k * 30;
    });
  }

  // Physical-loop detection. Stamps `inLoop: 1` on every WIRED edge that lies
  // on a cycle so the stylesheet can halo it yellow — a ring of switches (or
  // any redundant cabling) is a deliberate operator design worth surfacing at
  // a glance, and it's also the first thing to check when STP is misbehaving.
  //
  // Graph-theory rule: an edge lies on some cycle iff it is NOT a bridge
  // (cut-edge), found via Tarjan's bridge algorithm. The graph is the SIMPLE
  // graph over wired physical edges only:
  //   - included: interface-inferred, LLDP, AP↔switch links (uplink + bridged),
  //     verified FG↔switch uplinks, AND MCLAG ICLs — the ICL is a real cabled
  //     link, so when it closes a cycle (the usual MCLAG shape: both peers
  //     uplink to a common parent, ICL between them) it's genuinely part of a
  //     physical loop and gets haloed. An ICL with no other path between its
  //     peers is a bridge (cut-edge) and is NOT flagged, so it only lights up
  //     when it actually rings.
  //   - excluded: wireless (mesh backhaul, client), unverified FortiLink
  //     controller edges (no cable proven)
  //   - parallel cables between the SAME two devices collapse to one
  //     adjacency, so an LACP/trunk pair alone doesn't read as an L2 loop
  function markPhysicalLoops(elements) {
    function isWired(d) {
      if (d.isMesh || d.isWireless) return false;
      if (d.isIface || d.isLldp || d.isApLink || d.isBridge || d.isVerifiedUplink || d.isMclag) return true;
      return false;
    }
    var adj = {}; // simple undirected adjacency: id -> { neighborId: true }
    var wiredEdges = [];
    elements.forEach(function (el) {
      var d = el && el.data;
      if (!d || !d.source || !d.target || d.source === d.target) return;
      if (!isWired(d)) return;
      wiredEdges.push(d);
      (adj[d.source] = adj[d.source] || {})[d.target] = true;
      (adj[d.target] = adj[d.target] || {})[d.source] = true;
    });
    if (wiredEdges.length < 3) return; // a simple-graph cycle needs ≥3 nodes

    // Iterative Tarjan bridge-finding (no recursion — rings can be long).
    var disc = {};
    var low = {};
    var time = 1;
    var bridges = {}; // sorted "a|b" pair keys that are cut-edges
    Object.keys(adj).forEach(function (start) {
      if (disc[start]) return;
      disc[start] = low[start] = time++;
      var stack = [{ node: start, parent: null, neighbors: Object.keys(adj[start]), idx: 0 }];
      while (stack.length) {
        var top = stack[stack.length - 1];
        if (top.idx < top.neighbors.length) {
          var v = top.neighbors[top.idx++];
          if (v === top.parent) continue; // simple graph — one parent edge to skip
          if (!disc[v]) {
            disc[v] = low[v] = time++;
            stack.push({ node: v, parent: top.node, neighbors: Object.keys(adj[v] || {}), idx: 0 });
          } else if (disc[v] < low[top.node]) {
            low[top.node] = disc[v]; // back edge
          }
        } else {
          stack.pop();
          var p = stack.length ? stack[stack.length - 1] : null;
          if (p) {
            if (low[top.node] < low[p.node]) low[p.node] = low[top.node];
            if (low[top.node] > disc[p.node]) {
              bridges[[p.node, top.node].sort().join("|")] = true;
            }
          }
        }
      }
    });
    wiredEdges.forEach(function (d) {
      if (!bridges[[d.source, d.target].sort().join("|")]) d.inLoop = 1;
    });
  }

  // Cytoscape stylesheet — node colors per role, edge styles per source
  // (controller / interface-inferred / LLDP), selected/dimmed/pulse states,
  // and the operator-uploaded icon overlay. `theme` is a FAMILY, "dark" or
  // "light" — never a theme id, since there are three themes and one palette
  // per family. Text + edge color swap accordingly so the graph reads well on
  // whichever ground the graph pane paints. `opts.includeEndpointOverlay` adds
  // the synthetic endpoint and dim styles used by desktop's connection-path
  // overlay — mobile doesn't carry that feature so it leaves it off.
  function topologyStylesheet(theme, opts) {
    opts = opts || {};
    // Anything that isn't a family is resolved from the document rather than
    // silently taking the else-branch: `theme === "dark"` on its own turns a
    // theme id ("nightfall") — or a stale per-user basemap preference that has
    // nothing to do with this canvas — into the LIGHT palette, which is how
    // #1a1a1a node labels ended up on nightfall's #0d0d1a graph pane.
    if (theme !== "dark" && theme !== "light") {
      var themeId = document.documentElement.getAttribute("data-theme");
      theme = (themeId === "morning" || themeId === "noon") ? "light" : "dark";
    }
    var isDark = theme === "dark";
    var textColor = isDark ? "#eef0f4" : "#1a1a1a";
    var edgeColor = isDark ? "#6a7388" : "#9aa2b1";
    var textBg    = isDark ? "#1c2029" : "#ffffff";

    var style = [
      {
        selector: "node",
        style: {
          label: "data(label)",
          "text-wrap": "wrap",
          "text-max-width": 160,
          color: textColor,
          "font-size": "11px",
          "font-family": "Inter, system-ui, sans-serif",
          "text-valign": "bottom",
          "text-margin-y": 6,
          "background-color": "#546e7a",
          width: 44,
          height: 44,
          "border-width": 2,
          "border-color": "#ffffff",
          "border-opacity": 0.85,
        },
      },
      { selector: 'node[role="fortigate"]',   style: { "background-color": "data(nodeColor)", width: 64, height: 64, "font-weight": 700 } },
      { selector: 'node[role="fortiswitch"]', style: { "background-color": "data(nodeColor)" } },
      { selector: 'node[role="fortiap"]',     style: { "background-color": "data(nodeColor)", width: 36, height: 36 } },
      {
        selector: 'node[role="lldp"]',
        style: {
          "background-color": "#7a4f1a",
          "border-color": "#f59e0b",
          "border-style": "dashed",
          width: 36,
          height: 36,
        },
      },
      {
        selector: 'node[role="remote-asset"]',
        style: {
          "background-color": "#1e3a5f",
          "border-color": "#4fc3f7",
          "border-style": "solid",
          "border-width": 2,
          width: 44,
          height: 44,
        },
      },
      // Wireless station — diamond shape so it's visually distinct from
      // wired endpoints + LLDP ghosts. Smaller than an AP since one AP
      // can carry dozens of stations and we don't want them dominating
      // the layout. Cyan border-bg matches the "wireless" edge style so
      // the eye groups the AP + its stations as one cluster.
      {
        selector: 'node[role="wireless-station"]',
        style: {
          "background-color": "#0e2a3a",
          "border-color":     "#22d3ee",
          "border-style":     "solid",
          "border-width":     2,
          shape:              "diamond",
          width:              24,
          height:             24,
          "font-size":        "9px",
        },
      },
      // Vendor logo overlay. Both signals stay visible: the colored
      // border carries the monitor health (green/amber/red/grey —
      // the same role/nodeColor used on plain nodes), the logo
      // identifies the vendor + model. White interior fill so the
      // logo's colors pop against any basemap (dark or light), and
      // the image is sized to fit the node via `background-fit:
      // contain` with no explicit width/height — pixel-valued
      // `background-width` was tried and gets treated as render
      // pixels (icon stops scaling with zoom AND ends up anchored
      // upper-left because `background-position` interacts oddly
      // with explicit-pixel `background-width`); percentage-valued
      // `background-width` plus contain has its own zoom-dependent
      // overflow quirk. Letting contain do the work alone is the
      // most predictable recipe in Cytoscape 3.30. To create the
      // ~70% inscribed-square inset operators wanted, the border
      // is thickened proportionally per role (see role selectors
      // for `node[hasIcon = 1]`) so the colored ring eats the
      // outer ~15% on each side and the visible image lands at
      // ~70% of the overall node diameter.
      {
        selector: 'node[hasIcon = 1]',
        style: {
          "background-image": "data(iconUrl)",
          "background-fit": "contain",
          "background-clip": "node",
          "background-image-containment": "inside",
          "background-position-x": "50%",
          "background-position-y": "50%",
          "background-color": "#ffffff",
          "background-opacity": 1,
          "border-color": "data(nodeColor)",
          "border-opacity": 1,
        },
      },
      // Per-role border widths for icon-bearing nodes. The width
      // numbers match ~15% of the role's node diameter so the ring
      // takes up the outer 30% of the visible diameter and the
      // image (which `background-fit: contain` scales to fill the
      // node) appears inset at ~70% of the visual circle. Borders
      // draw outward in Cytoscape so node coordinate space (used
      // by edges + labels) is unchanged.
      { selector: 'node[hasIcon = 1][role="fortigate"]',    style: { "border-width": 10 } },
      { selector: 'node[hasIcon = 1][role="fortiswitch"]',  style: { "border-width": 7 } },
      { selector: 'node[hasIcon = 1][role="fortiap"]',      style: { "border-width": 6 } },
      { selector: 'node[hasIcon = 1][role="remote-asset"]', style: { "border-width": 7 } },
      {
        selector: "edge",
        style: {
          width: 1.8,
          "line-color": edgeColor,
          "target-arrow-color": edgeColor,
          "target-arrow-shape": "none",
          "curve-style": "bezier",
          label: "data(label)",
          "font-size": "9px",
          color: textColor,
          "text-background-color": textBg,
          "text-background-opacity": 0.85,
          "text-background-padding": 2,
          "text-rotation": "autorotate",
        },
      },
      {
        selector: 'edge[isLldp = 1]',
        style: {
          "line-style": "dashed",
          "line-color": "#f59e0b",
          "target-arrow-color": "#f59e0b",
        },
      },
      {
        selector: 'edge[isIface = 1]',
        style: {
          "line-style": "solid",
          "line-color": "#14b8a6",
          "target-arrow-color": "#14b8a6",
          width: 2.4,
        },
      },
      // MCLAG ICL edge: a sibling/peer link between two FortiSwitches. Fuchsia,
      // dashed, no arrowhead (no hierarchy — they're peers), heavier than the
      // observed edges so it reads as an authoritative interconnect distinct
      // from the amber LLDP / teal interface / violet mesh edges.
      {
        selector: 'edge[isMclag = 1]',
        style: {
          "line-style": "dashed",
          "line-color": "#d946ef",
          "target-arrow-color": "#d946ef",
          "target-arrow-shape": "none",
          width: 2.4,
        },
      },
      // Wireless edge: AP → connected station. Dashed cyan, lighter than
      // the wired controller / interface edges so the eye doesn't read
      // station-cluster fanout as critical topology.
      {
        selector: 'edge[isWireless = 1]',
        style: {
          "line-style": "dashed",
          "line-color": "#22d3ee",
          "target-arrow-color": "#22d3ee",
          width: 1.4,
          opacity: 0.7,
        },
      },
      // Wireless mesh backhaul: root AP → leaf AP. Heavier dashed violet with a
      // directional arrow so it reads as an authoritative uplink (the leaf
      // depends on the root), distinct from the lighter cyan client wireless.
      {
        selector: 'edge[isMesh = 1]',
        style: {
          "line-style": "dashed",
          "line-color": "#a78bfa",
          "target-arrow-color": "#a78bfa",
          "target-arrow-shape": "triangle",
          width: 2.2,
        },
      },
      // Wired AP↔switch link: a managed AP's switch uplink (switch → AP) or a
      // FortiLink switch bridged behind an AP (AP → switch, isBridge). Solid
      // blue with a directional arrow — a real ethernet cable, distinct from
      // the dashed violet wireless mesh and the gray controller edges.
      {
        selector: 'edge[isApLink = 1]',
        style: {
          "line-style": "solid",
          "line-color": "#3b82f6",
          "target-arrow-color": "#3b82f6",
          "target-arrow-shape": "triangle",
          width: 2.2,
        },
      },
      // Unverified FortiLink uplink (FortiGate→switch with no interface/LLDP-
      // confirmed cable): a logical/management link, drawn dashed + dimmed gray
      // so it reads as virtual versus the solid controller/physical edges.
      {
        selector: 'edge[isFortilinkFallback = 1]',
        style: {
          "line-style": "dashed",
          "line-color": "#6a7388",
          "target-arrow-color": "#6a7388",
          opacity: 0.7,
        },
      },
      // Physical loop membership (stamped by markPhysicalLoops): a wired edge
      // lying on a cycle gets a yellow halo AROUND its own line color, so a
      // switch ring reads at a glance without hiding which signal drew the
      // edge. Composes with the type styles above — only outline props here.
      {
        selector: 'edge[inLoop = 1]',
        style: {
          "line-outline-color": "#eab308",
          "line-outline-width": 2,
        },
      },
      // Cross-group links (stamped by markInterGroupEdges) route ORTHOGONALLY
      // so they travel the gutters between location-group boxes instead of
      // slicing diagonally through them. taxiTurn staggers each source's
      // outgoing links (40/70/100…px) so parallel runs never lie on top of
      // one another. Geometry only — color/dash still come from the edge's
      // type rules above.
      {
        selector: 'edge[isInterGroup = 1]',
        style: {
          "curve-style": "taxi",
          "taxi-direction": "horizontal",
          "taxi-turn": "data(taxiTurn)",
          "taxi-turn-min-distance": 12,
        },
      },
      // Location grouping hulls (building / floor / room / jb). Drawn beneath
      // every ordinary node AND edge via z-compound-depth: bottom (verified on
      // the bundled Cytoscape 3.30 — the z sorter compares compound depth
      // before the node-over-edge rule); z-index within the bottom layer
      // stacks building < floor < room < jb. Shape / border-style / color /
      // size are per-node bypass styles set by renderLocationGroups. events:
      // "no" lets clicks and background-drag panning pass straight through.
      // Events are ON (no `events: "no"`): hulls are the hover target for
      // the nesting tooltip. They stay ungrabbable/unselectable, so drag
      // gestures over them still pan the viewport, and devices/edges render
      // above them so their own hovers/taps win — a hull only receives
      // events on its empty interior. Tap handlers must guard [isLocGroup]
      // (see map.js _openAssetForNode + the mobile node sheet).
      {
        selector: "node[isLocGroup]",
        style: {
          "z-compound-depth": "bottom",
          "background-opacity": isDark ? 0.06 : 0.08,
          "border-width": 2,
          "border-opacity": 0.55,
          label: "data(label)",
          "font-size": "16px",
          "font-weight": 700,
          "text-valign": "top",
          "text-halign": "center",
          "text-margin-y": -5,
          "text-wrap": "none",
        },
      },
      // Floor-view portal stub: where an edge leaves the current floor it
      // terminates at this small dashed node naming the remote device + its
      // floor. The ONLY interactive synthetic node — tapping it switches to
      // the remote floor's view (wired in map.js).
      {
        selector: "node[isPortal]",
        style: {
          shape: "round-rectangle",
          width: 52,
          height: 30,
          "background-color": isDark ? "#252a35" : "#eef1f6",
          "background-opacity": 0.9,
          "border-width": 2,
          "border-style": "dashed",
          "border-color": edgeColor,
          "font-size": "10px",
          "font-style": "italic",
          "text-max-width": 130,
          "text-wrap": "ellipsis",
          color: textColor,
          "text-opacity": 0.85,
        },
      },
      {
        selector: 'node.topology-pulse',
        style: {
          "border-color": "#22d3ee",
          "border-width": 4,
          "border-opacity": 1,
        },
      },
      {
        selector: 'node:selected',
        style: {
          "border-color": "#22d3ee",
          "border-width": 5,
          "border-opacity": 1,
          "overlay-color": "#22d3ee",
          "overlay-opacity": 0.18,
          "overlay-padding": 6,
        },
      },
      {
        selector: 'edge:selected',
        style: {
          "line-color": "#22d3ee",
          "target-arrow-color": "#22d3ee",
          width: 3,
          "overlay-color": "#22d3ee",
          "overlay-opacity": 0.15,
          "overlay-padding": 3,
        },
      },
      {
        selector: 'core',
        style: {
          "selection-box-color":        "#22d3ee",
          "selection-box-border-color": "#22d3ee",
          "selection-box-border-width": 1.5,
          "selection-box-opacity":      0.22,
          "active-bg-color":            "#22d3ee",
          "active-bg-opacity":          0.14,
        },
      },
    ];

    if (opts.includeEndpointOverlay) {
      style.push({
        selector: 'node[role="endpoint"]',
        style: {
          "background-color": "data(nodeColor)",
          shape: "round-rectangle",
          width: 44,
          height: 36,
        },
      });
      style.push({
        selector: 'node.dimmed',
        style: { display: 'none' },
      });
      style.push({
        selector: 'edge.dimmed',
        style: { display: 'none' },
      });
    }

    return style;
  }

  // Legend rows for the topology overlay. Colors here mirror the constants
  // used by `fortinetNodeColor()` (status hues) and `topologyStylesheet()`
  // (node fills + edge styles) so a stylesheet change has exactly one place
  // the legend has to follow.
  function topologyLegendSpec() {
    return {
      nodes: [
        { label: "FortiGate",         kind: "circle",          size: "lg", fill: "data(nodeColor)", desc: "Color = monitor health" },
        { label: "FortiSwitch",       kind: "circle",          size: "md", fill: "data(nodeColor)" },
        { label: "FortiAP",           kind: "circle",          size: "sm", fill: "data(nodeColor)" },
        { label: "Endpoint",          kind: "round-rectangle", size: "md", fill: "data(nodeColor)", desc: "Only via endpoint search" },
        { label: "Remote asset",      kind: "circle",          size: "md", fill: "#1e3a5f", border: "#4fc3f7", desc: "Infra (FW/switch/AP) at another site" },
      ],
      health: [
        { label: "Up",                color: HEALTH_NODE_COLORS.up },
        { label: "Degraded",          color: HEALTH_NODE_COLORS.degraded },
        { label: "Down",              color: HEALTH_NODE_COLORS.down },
        { label: "Maintenance",       color: HEALTH_NODE_COLORS.maintenance },
        { label: "Passive",           color: HEALTH_NODE_COLORS.passive, desc: "No down-detection automation covers it — still polled, no verdict" },
        { label: "Dep. Down",         color: HEALTH_NODE_COLORS.unknown },
        { label: "Unmonitored",       color: HEALTH_NODE_COLORS.unmonitored },
      ],
      edges: [
        { label: "Controller",        color: "#6a7388", style: "solid",  desc: "FortiLink / managed-AP authoritative" },
        { label: "FortiLink (virtual)",color: "#6a7388", style: "dashed", desc: "Unverified FortiLink uplink — no physical cable confirmed" },
        { label: "Interface-inferred",color: "#14b8a6", style: "solid",  desc: "Naming-convention peer link" },
        { label: "LLDP",              color: "#f59e0b", style: "dashed" },
        { label: "MCLAG ICL",         color: "#d946ef", style: "dashed", desc: "Inter-Chassis Link between MCLAG-peer switches" },
        { label: "Mesh",              color: "#a78bfa", style: "dashed", desc: "Wireless backhaul: root AP → mesh leaf AP" },
        { label: "AP ↔ switch",       color: "#3b82f6", style: "solid",  desc: "Wired: AP's switch uplink / switch bridged behind an AP" },
        { label: "In physical loop",  color: "#eab308", style: "solid",  desc: "Yellow halo: wired edge on a redundant/ring path" },
      ],
      // Location grouping hulls — colors + border styles must mirror
      // LOC_GROUP_KINDS (all levels are rounded rectangles, identified by a
      // fixed per-level color).
      locations: [
        { label: "Area",         shape: "rect", style: "solid",  color: "#f472b6", desc: "From a:/b:/f:/r:/jb: codes in the asset description (or the device-side description)" },
        { label: "Building",     shape: "rect", style: "solid",  color: "#4fc3f7" },
        { label: "Floor",        shape: "rect", style: "dashed", color: "#a78bfa" },
        { label: "Room",         shape: "rect", style: "solid",  color: "#4ade80" },
        { label: "Junction box", shape: "rect", style: "dashed", color: "#f59e0b" },
      ],
    };
  }

  // ── Location grouping hulls ─────────────────────────────────────────────
  // Synthetic Cytoscape nodes drawn UNDER the graph (z-compound-depth:
  // bottom) that enclose devices sharing a location code — nested rounded
  // rectangles color-coded per level: building > floor > room > jb (see
  // LOC_GROUP_KINDS for the fixed colors). Plain nodes (not compound
  // parents), sized to the members' model-coord bounding box, so cy.png()
  // screenshots and pan/zoom capture them for free. Non-interactive: events
  // pass through to the background (pan) and they're excluded from drag
  // persistence, the solver, and search — see the [isLocGroup] guards in
  // map.js.
  //
  // Nesting is STRUCTURAL: shapes are fitted inside-out (jb → room → floor →
  // building), and each outer shape's content box is the union of its own
  // members' bounds AND its descendant groups' FINAL rendered boxes. Outer
  // shapes therefore grow dynamically to enclose whatever nests inside them:
  // building ⊇ floor ⊇ room ⊇ jb, boundaries never crossing.
  //
  // Every level renders as a rounded rectangle, identified by a FIXED
  // per-level color (+ alternating solid/dashed borders): area rose solid,
  // building sky-blue solid, floor violet dashed, room green solid, jb amber
  // dashed. The colors mirror the legend's "Location groups" section —
  // change them in lockstep. pad = gap between a shape and its content
  // (members + nested shapes); tiers stay visually stepped, but containment
  // no longer depends on them — the hierarchical fit guarantees it.
  // scaleW/scaleH remain for any future non-rectangular shape (a rect
  // inscribed in an ellipse needs axes ×√2); all 1 while everything is
  // rectangular.
  var LOC_GROUP_KINDS = {
    area:     { rank: 0, pad: 42, color: "#f472b6", shape: "round-rectangle", dash: "solid",  z: 1, scaleW: 1, scaleH: 1 },
    building: { rank: 1, pad: 34, color: "#4fc3f7", shape: "round-rectangle", dash: "solid",  z: 2, scaleW: 1, scaleH: 1 },
    floor:    { rank: 2, pad: 26, color: "#a78bfa", shape: "round-rectangle", dash: "dashed", z: 3, scaleW: 1, scaleH: 1 },
    room:     { rank: 3, pad: 18, color: "#4ade80", shape: "round-rectangle", dash: "solid",  z: 4, scaleW: 1, scaleH: 1 },
    jb:       { rank: 4, pad: 12, color: "#f59e0b", shape: "round-rectangle", dash: "dashed", z: 5, scaleW: 1, scaleH: 1 },
  };

  function locGroupColor(kind) {
    return (LOC_GROUP_KINDS[kind] || LOC_GROUP_KINDS.building).color;
  }

  // Enumerate the location groups present among the VISIBLE device nodes of a
  // mounted Cytoscape instance (hidden-role chips already applied). Scoped
  // keys — floor = building+floor, room = building+floor+room, jb = all four
  // — so "Floor 2" in two buildings forms two groups; missing intermediate
  // levels use an empty segment (an r:-only room is a top-level room group).
  // `scope` is the key's segment array — the hierarchical fit uses prefix
  // matching over it to find each shape's descendants. Returns
  // [{ key, kind, name, memberIds, scope }] ordered building → floor →
  // room → jb.
  function computeLocationGroups(cy) {
    var groups = {};
    var order = [];
    function addTo(key, kind, name, scope, nodeId) {
      var g = groups[key];
      if (!g) {
        g = { key: key, kind: kind, name: name, scope: scope, memberIds: [] };
        groups[key] = g;
        order.push(g);
      }
      g.memberIds.push(nodeId);
    }
    cy.nodes().forEach(function (n) {
      if (n.data("isLocGroup") || n.data("isPortal")) return;
      if (!n.visible()) return;
      var a = n.data("locA") || "";
      var b = n.data("locB") || "";
      var f = n.data("locF") || "";
      var r = n.data("locR") || "";
      var jb = n.data("locJb") || "";
      var id = n.id();
      if (a) addTo("a|" + a, "area", n.data("locAName"), [a], id);
      if (b) addTo("b|" + a + "|" + b, "building", n.data("locBName"), [a, b], id);
      if (f) addTo("f|" + a + "|" + b + "|" + f, "floor", n.data("locFName"), [a, b, f], id);
      if (r) addTo("r|" + a + "|" + b + "|" + f + "|" + r, "room", n.data("locRName"), [a, b, f, r], id);
      if (jb) addTo("jb|" + a + "|" + b + "|" + f + "|" + r + "|" + jb, "jb", n.data("locJbName"), [a, b, f, r, jb], id);
    });
    var kindRank = { area: 0, building: 1, floor: 2, room: 3, jb: 4 };
    order.sort(function (a2, b2) { return kindRank[a2.kind] - kindRank[b2.kind]; });
    return order;
  }

  // True when `inner`'s scope nests inside `outer`'s (strict prefix match —
  // a room in building "shop" nests inside building "shop"; a room whose
  // building segment is "" nests inside no building).
  function _isDescendantScope(outer, inner) {
    if (!outer || !inner || inner.length <= outer.length) return false;
    for (var i = 0; i < outer.length; i++) {
      if (inner[i] !== outer[i]) return false;
    }
    return true;
  }

  // Hierarchical fit: size + place every hull node, INNERMOST KIND FIRST
  // (jb → room → floor → building). Each shape's content box is the union of
  // its visible members' bounds and the FINAL boxes of already-fitted
  // descendant shapes, then padded and inflated for the shape outline — so
  // an outer shape always fully encloses everything nested in it, growing as
  // large as that requires. A hull whose members are all hidden and that has
  // no fitted descendants is removed.
  function _layoutLocationGroups(cy) {
    var hulls = cy.nodes("[isLocGroup]").toArray();
    hulls.sort(function (a, b) {
      var ra = (LOC_GROUP_KINDS[a.data("locKind")] || LOC_GROUP_KINDS.building).rank;
      var rb = (LOC_GROUP_KINDS[b.data("locKind")] || LOC_GROUP_KINDS.building).rank;
      return rb - ra; // deepest kind first
    });
    var fitted = []; // { scope, rank, box } — final rendered boxes, deepest kinds first
    hulls.forEach(function (n) {
      var cfg = LOC_GROUP_KINDS[n.data("locKind")] || LOC_GROUP_KINDS.building;
      var scope = n.data("locScope") || [];
      var coll = cy.collection();
      (n.data("memberIds") || []).forEach(function (id) { coll = coll.union(cy.getElementById(id)); });
      coll = coll.filter(function (m) { return m.length !== 0 && m.visible(); });
      var box = null;
      if (coll.length > 0) {
        var bb = coll.boundingBox({ includeLabels: false, includeOverlays: false });
        box = { x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2 };
      }
      for (var i = 0; i < fitted.length; i++) {
        var f = fitted[i];
        if (f.rank <= cfg.rank) continue; // only deeper kinds nest inside this one
        if (!_isDescendantScope(scope, f.scope)) continue;
        box = box === null
          ? { x1: f.box.x1, y1: f.box.y1, x2: f.box.x2, y2: f.box.y2 }
          : { x1: Math.min(box.x1, f.box.x1), y1: Math.min(box.y1, f.box.y1),
              x2: Math.max(box.x2, f.box.x2), y2: Math.max(box.y2, f.box.y2) };
      }
      if (box === null) { cy.remove(n); return; }
      var w = (box.x2 - box.x1 + cfg.pad * 2) * cfg.scaleW;
      var h = (box.y2 - box.y1 + cfg.pad * 2) * cfg.scaleH;
      var cx = (box.x1 + box.x2) / 2;
      var cyy = (box.y1 + box.y2) / 2;
      n.position({ x: cx, y: cyy });
      n.style({ width: w, height: h });
      fitted.push({
        scope: scope,
        rank: cfg.rank,
        box: { x1: cx - w / 2, y1: cyy - h / 2, x2: cx + w / 2, y2: cyy + h / 2 },
      });
    });
  }

  // Minimum clear space between two shapes at the same nesting level. Covers
  // the group-name label rendered above each shape's top edge.
  var LOC_GROUP_SIBLING_GAP = 36;

  // Resolve overlaps between DISTINCT groups (shapes that don't nest inside
  // one another): two buildings, two rooms in one building, a floor and a
  // floorless room sharing a building, etc. Groups are bucketed by their
  // nearest ancestor hull ("root" when none); within each bucket, boxes are
  // swept top-to-bottom and a shape intruding on the one above it is pushed
  // DOWN — by translating its member DEVICES (its own + every descendant
  // group's), so containment and the column structure both survive — then
  // everything re-fits and the sweep repeats until stable. Vertical pushes
  // only: columns encode network depth and must not change.
  function _resolveLocGroupOverlaps(cy) {
    for (var pass = 0; pass < 8; pass++) {
      var hulls = cy.nodes("[isLocGroup]").toArray();
      if (hulls.length < 2) return;
      var infos = hulls.map(function (n) {
        var cfg = LOC_GROUP_KINDS[n.data("locKind")] || LOC_GROUP_KINDS.building;
        var w = n.width();
        var h = n.height();
        var p = n.position();
        return {
          node: n,
          rank: cfg.rank,
          scope: n.data("locScope") || [],
          box: { x1: p.x - w / 2, y1: p.y - h / 2, x2: p.x + w / 2, y2: p.y + h / 2 },
        };
      });
      // Nearest ancestor (deepest-rank hull whose scope prefixes this one).
      infos.forEach(function (it) {
        var parent = null;
        infos.forEach(function (cand) {
          if (cand === it || cand.rank >= it.rank) return;
          if (!_isDescendantScope(cand.scope, it.scope)) return;
          if (!parent || cand.rank > parent.rank) parent = cand;
        });
        it.parentId = parent ? parent.node.id() : "root";
      });
      var buckets = {};
      infos.forEach(function (it) {
        (buckets[it.parentId] = buckets[it.parentId] || []).push(it);
      });
      var moved = false;
      Object.keys(buckets).sort().forEach(function (bk) {
        var sibs = buckets[bk];
        if (sibs.length < 2) return;
        sibs.sort(function (a, b) {
          if (a.box.y1 !== b.box.y1) return a.box.y1 - b.box.y1;
          if (a.box.x1 !== b.box.x1) return a.box.x1 - b.box.x1;
          return a.node.id() < b.node.id() ? -1 : 1;
        });
        for (var i = 1; i < sibs.length; i++) {
          var below = sibs[i];
          var dy = 0;
          for (var j = 0; j < i; j++) {
            var above = sibs[j];
            var xOverlap = below.box.x1 < above.box.x2 && below.box.x2 > above.box.x1;
            if (!xOverlap) continue;
            var need = (above.box.y2 + LOC_GROUP_SIBLING_GAP) - below.box.y1;
            if (need > dy) dy = need;
          }
          if (dy <= 0.5) continue;
          // Translate the group's member devices (its own + every descendant
          // group's) — hulls themselves re-fit afterwards.
          var memberIds = {};
          (below.node.data("memberIds") || []).forEach(function (id) { memberIds[id] = true; });
          infos.forEach(function (other) {
            if (other.rank <= below.rank) return;
            if (!_isDescendantScope(below.scope, other.scope)) return;
            (other.node.data("memberIds") || []).forEach(function (id) { memberIds[id] = true; });
          });
          cy.batch(function () {
            Object.keys(memberIds).forEach(function (id) {
              var m = cy.getElementById(id);
              if (m.length === 0) return;
              var mp = m.position();
              m.position({ x: mp.x, y: mp.y + dy });
            });
          });
          // Update this sweep's local view of the moved box so later siblings
          // in the same pass push against its new spot.
          below.box.y1 += dy;
          below.box.y2 += dy;
          moved = true;
        }
      });
      if (!moved) return;
      _layoutLocationGroups(cy); // re-fit every shape around the moved members
    }
  }

  // Draw (or redraw) the hull nodes for the current graph. opts.suppressKinds
  // hides whole tiers — floor views pass ["building","floor"] since the view
  // itself IS the building+floor. Idempotent: removes previous hulls first.
  function renderLocationGroups(cy, opts) {
    opts = opts || {};
    removeLocationGroups(cy);
    var suppress = {};
    (opts.suppressKinds || []).forEach(function (k) { suppress[k] = true; });
    computeLocationGroups(cy).forEach(function (g) {
      if (suppress[g.kind]) return;
      var cfg = LOC_GROUP_KINDS[g.kind];
      var color = locGroupColor(g.kind);
      var n = cy.add({
        group: "nodes",
        data: {
          id: "locgroup:" + g.key,
          isLocGroup: 1,
          locKind: g.kind,
          locScope: g.scope,
          label: g.name || "",
          memberIds: g.memberIds,
        },
        selectable: false,
        // Grabbable: dragging a hull moves the box AND its members (the
        // desktop drag handlers in map.js translate memberIds by the drag
        // delta; nested boxes follow because they re-fit around members).
        // Mobile's autoungrabify keeps them fixed there.
        grabbable: true,
      });
      n.style({
        shape: cfg.shape,
        "border-style": cfg.dash,
        "background-color": color,
        "border-color": color,
        color: color,
        "z-index": cfg.z,
      });
    });
    _layoutLocationGroups(cy);
    // Push apart shapes that don't nest inside each other. Runs at render
    // time only — the drag-follow refresh (refreshLocationGroups) must never
    // move devices out from under the operator's pointer mid-drag.
    _resolveLocGroupOverlaps(cy);
  }

  function removeLocationGroups(cy) {
    cy.remove(cy.nodes("[isLocGroup]"));
  }

  // Re-fit existing hulls to their members' current positions (drag-follow).
  // Membership changes require a full renderLocationGroups() instead.
  function refreshLocationGroups(cy) {
    _layoutLocationGroups(cy);
  }

  // ── Obstacle-aware routing for cross-group links ────────────────────────
  // A deterministic channel router that exploits the quotient layout's
  // structure instead of a general-purpose router (libavoid would add a
  // WASM vendor dep for marginal gain on this geometry): every cross-group
  // edge is routed as an orthogonal polyline S → (cx, Sy) → (cx, cy) →
  // (Tx, cy) → T, where cx is a vertical corridor just outside the source
  // group's box (toward the target) and cy a horizontal corridor. Candidate
  // corridors (direct at the target's row, above/below the target box,
  // canvas top/bottom) are scored by how many OTHER top-level boxes the
  // three runs would cross plus path length — the cheapest clear channel
  // wins. Corridor usage is counted so edges sharing a channel fan out in
  // 9px steps instead of stacking. The polyline is rendered with Cytoscape's
  // `segments` curve style (weights/distances projected onto the S→T line);
  // edges the router can't place (missing boxes) keep the taxi fallback.
  var _ROUTE_MARGIN = 26;   // corridor distance outside a box edge
  var _ROUTE_LABEL_PAD = 22; // extra clearance above a box (its floating label)

  function _rectsFor(cy) {
    // Top-level hull rects (no ancestor hull present), keyed like topKey.
    var hulls = cy.nodes("[isLocGroup]").toArray();
    var infos = hulls.map(function (n) {
      var cfg = LOC_GROUP_KINDS[n.data("locKind")] || LOC_GROUP_KINDS.building;
      var p = n.position();
      var w = n.width();
      var h = n.height();
      return {
        id: n.id(),
        rank: cfg.rank,
        scope: n.data("locScope") || [],
        box: { x1: p.x - w / 2, y1: p.y - h / 2, x2: p.x + w / 2, y2: p.y + h / 2 },
      };
    });
    var top = [];
    infos.forEach(function (it) {
      var hasAncestor = infos.some(function (o) {
        return o !== it && o.rank < it.rank && _isDescendantScope(o.scope, it.scope);
      });
      if (!hasAncestor) top.push(it);
    });
    return top;
  }

  function _segIntersectsRect(x1, y1, x2, y2, r) {
    // Axis-aligned segment vs rect (segments here are always H or V).
    var lox = Math.min(x1, x2), hix = Math.max(x1, x2);
    var loy = Math.min(y1, y2), hiy = Math.max(y1, y2);
    return lox < r.x2 && hix > r.x1 && loy < r.y2 && hiy > r.y1;
  }

  function routeInterGroupEdges(cy) {
    var tops = _rectsFor(cy);
    if (tops.length === 0) return;
    var rectById = {};
    tops.forEach(function (t) { rectById[t.id] = t.box; });
    function hullIdForNode(n) {
      var a = n.data("locA");
      var b = n.data("locB");
      if (a) return "locgroup:a|" + a;
      if (b) return "locgroup:b|" + (a || "") + "|" + b;
      return null;
    }
    var corridorUse = {}; // rounded corridor coordinate -> count (fan-out stagger)
    function stagger(kind, coord) {
      var key = kind + ":" + Math.round(coord / 10) * 10;
      var k = corridorUse[key] || 0;
      corridorUse[key] = k + 1;
      return coord + k * 9;
    }
    cy.edges("[isInterGroup]").forEach(function (e) {
      var sN = e.source();
      var tN = e.target();
      var sHull = hullIdForNode(sN);
      var tHull = hullIdForNode(tN);
      var bs = sHull ? rectById[sHull] : null;
      var bt = tHull ? rectById[tHull] : null;
      var S = sN.position();
      var T = tN.position();
      if (!bs && !bt) { e.removeStyle("curve-style segment-weights segment-distances edge-distances"); return; }
      // Obstacles: every top-level box except the two endpoints' own,
      // inflated for margin + the floating label above.
      var obstacles = tops
        .filter(function (x) { return x.id !== sHull && x.id !== tHull; })
        .map(function (x) {
          return { x1: x.box.x1 - 8, y1: x.box.y1 - _ROUTE_LABEL_PAD, x2: x.box.x2 + 8, y2: x.box.y2 + 8 };
        });
      var goingRight = T.x >= S.x;
      var srcBox = bs || { x1: S.x, y1: S.y, x2: S.x, y2: S.y };
      var tgtBox = bt || { x1: T.x, y1: T.y, x2: T.x, y2: T.y };
      var cx = goingRight ? srcBox.x2 + _ROUTE_MARGIN : srcBox.x1 - _ROUTE_MARGIN;
      // Candidate horizontal corridors, best-first preference order.
      var canvasTop = Math.min.apply(null, tops.map(function (x) { return x.box.y1; })) - _ROUTE_MARGIN - _ROUTE_LABEL_PAD;
      var canvasBottom = Math.max.apply(null, tops.map(function (x) { return x.box.y2; })) + _ROUTE_MARGIN;
      var candidates = [
        T.y,                                          // straight into the target row
        tgtBox.y1 - _ROUTE_MARGIN - _ROUTE_LABEL_PAD, // just above the target box
        tgtBox.y2 + _ROUTE_MARGIN,                    // just below the target box
        canvasTop,
        canvasBottom,
      ];
      var best = null;
      candidates.forEach(function (cy0, idx) {
        var crossings = 0;
        obstacles.forEach(function (r) {
          if (_segIntersectsRect(cx, S.y, cx, cy0, r)) crossings++;   // vertical out of source
          if (_segIntersectsRect(cx, cy0, T.x, cy0, r)) crossings++;  // horizontal corridor
          if (_segIntersectsRect(T.x, cy0, T.x, T.y, r)) crossings++; // vertical into target
        });
        var len = Math.abs(S.y - cy0) + Math.abs(T.x - cx) + Math.abs(T.y - cy0);
        var score = crossings * 100000 + len + idx; // idx = stable tie-break by preference
        if (!best || score < best.score) best = { cy: cy0, score: score };
      });
      var cyPick = best.cy;
      // Fan out edges sharing a corridor — BOTH axes. The horizontal stagger
      // deliberately includes the "straight into the target row" corridor:
      // without it, every edge whose corridor is a target row it shares with
      // other edges collapses onto one combined horizontal line (the first
      // edge in a 10px bucket keeps the exact coordinate; later ones step
      // down 9px and take a short vertical jog into their target).
      var cxS = stagger("v", cx);
      var cyS = stagger("h", cyPick);
      // Polyline: drop degenerate bends (e.g. corridor == target row).
      var pts = [];
      pts.push({ x: cxS, y: S.y });
      if (Math.abs(cyS - S.y) > 0.5) pts.push({ x: cxS, y: cyS });
      if (Math.abs(cyS - T.y) > 0.5) {
        pts.push({ x: T.x, y: cyS });
      }
      // Project bends onto the S→T line for Cytoscape `segments` rendering.
      var dx = T.x - S.x;
      var dy = T.y - S.y;
      var len2 = dx * dx + dy * dy;
      if (len2 < 1) { e.removeStyle("curve-style segment-weights segment-distances edge-distances"); return; }
      var norm = Math.sqrt(len2);
      var weights = [];
      var dists = [];
      pts.forEach(function (p) {
        var px = p.x - S.x;
        var py = p.y - S.y;
        weights.push(((px * dx + py * dy) / len2).toFixed(4));
        // Signed perpendicular distance (positive = right of S→T direction).
        dists.push((((py * dx - px * dy)) / norm).toFixed(1));
      });
      e.style({
        "curve-style": "segments",
        "segment-weights": weights.join(" "),
        "segment-distances": dists.join(" "),
        "edge-distances": "node-position",
      });
    });
  }

  // Tooltip content for a hovered hull: the hull's own label plus every
  // ANCESTOR hull it nests inside (Cytoscape hit-testing hands the hover to
  // the innermost shape — highest z-index — so hovering a jb inside a room
  // inside a building yields all three). Returns [{ kind, name, color }]
  // ordered outermost → innermost.
  function locationGroupTooltipParts(cy, hull) {
    var scope = hull.data("locScope") || [];
    var kind = hull.data("locKind");
    var rank = (LOC_GROUP_KINDS[kind] || LOC_GROUP_KINDS.building).rank;
    var parts = [];
    cy.nodes("[isLocGroup]").forEach(function (g) {
      if (g.id() === hull.id()) return;
      var gKind = g.data("locKind");
      var gRank = (LOC_GROUP_KINDS[gKind] || LOC_GROUP_KINDS.building).rank;
      if (gRank >= rank) return;
      if (!_isDescendantScope(g.data("locScope") || [], scope)) return;
      parts.push({ kind: gKind, name: g.data("label") || "", color: locGroupColor(gKind), rank: gRank });
    });
    parts.sort(function (a, b) { return a.rank - b.rank; });
    parts.push({ kind: kind, name: hull.data("label") || "", color: locGroupColor(kind), rank: rank });
    return parts;
  }

  // ── Floor views ─────────────────────────────────────────────────────────
  // A floor view shows one (building, floor) pair's tagged devices plus the
  // FortiGate root and "portal" stubs where an edge crosses to another floor.
  // Pure element-set transforms (no Cytoscape instance) so both surfaces and
  // the unit tests share them.

  // Sort value for an f: floor label, underground-aware: signed numbers sort
  // numerically ("-2" < "-1" < "1"), B# basement notation sorts as its
  // negative ("B1" → -1), and non-numeric values ("Mezzanine", "Roof")
  // return null and sort after numbered floors alphabetically.
  function floorSortValue(name) {
    var s = String(name == null ? "" : name).trim();
    if (/^-?\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    var bm = /^b(\d+)$/i.exec(s);
    if (bm) return -parseInt(bm[1], 10);
    return null;
  }
  function compareFloors(a, b) {
    var va = floorSortValue(a);
    var vb = floorSortValue(b);
    if (va != null && vb != null) return va - vb;
    if (va != null) return -1; // numbered floors before named ones
    if (vb != null) return 1;
    return String(a).localeCompare(String(b));
  }

  // Building label: "Mine — Shop" when an area names it, else "Shop".
  function buildingViewLabel(areaName, buildingName) {
    return areaName ? areaName + " — " + buildingName : buildingName;
  }
  // Floor label: "<building label> — 2" (the building context implies the
  // second part is a floor), or "Floor 2" for f:-without-b: (the
  // unnamed-building bucket, where a bare "2" would be cryptic).
  function floorViewLabel(buildingLabel, floorName) {
    return buildingLabel ? buildingLabel + " — " + floorName : "Floor " + floorName;
  }

  // Enumerate the location views present in a built element set: one
  // BUILDING view per b: value (even without floors) and one FLOOR view per
  // (area, building, floor). Keys are area-scoped so "Office" in two areas
  // stays distinct: building "b|<aKey>|<bKey>", floor "f|<aKey>|<bKey>|<fKey>".
  // Returns a flat array of
  //   { key, kind: "building"|"floor", areaName, buildingName, floorName?, label }
  // sorted area → building (unnamed bucket last) → building-view-first →
  // underground-aware floor order. Empty array when no node carries a b: or
  // f: code → callers render no switcher.
  function computeFloorViews(elements) {
    var byKey = {};
    var out = [];
    (elements || []).forEach(function (el) {
      var d = el && el.data;
      if (!d || !d.id || d.source) return;
      var a = d.locA || "";
      var b = d.locB || "";
      var aName = d.locAName || "";
      var bName = d.locBName || "";
      if (b) {
        var bKey = "b|" + a + "|" + b;
        if (!byKey[bKey]) {
          byKey[bKey] = true;
          out.push({
            key: bKey,
            kind: "building",
            areaName: aName,
            buildingName: bName,
            label: buildingViewLabel(aName, bName),
          });
        }
      }
      if (d.locF) {
        var fKey = "f|" + a + "|" + b + "|" + d.locF;
        if (!byKey[fKey]) {
          byKey[fKey] = true;
          out.push({
            key: fKey,
            kind: "floor",
            areaName: aName,
            buildingName: bName,
            floorName: d.locFName || d.locF,
            label: floorViewLabel(buildingViewLabel(aName, bName), d.locFName || d.locF),
          });
        }
      }
    });
    out.sort(function (x, y) {
      if (x.areaName !== y.areaName) return String(x.areaName).localeCompare(String(y.areaName));
      if (x.buildingName !== y.buildingName) {
        if (!x.buildingName) return 1; // unnamed-building bucket last
        if (!y.buildingName) return -1;
        return x.buildingName.localeCompare(y.buildingName);
      }
      if (x.kind !== y.kind) return x.kind === "building" ? -1 : 1; // building view tops its column
      return compareFloors(x.floorName || "", y.floorName || "");
    });
    return out;
  }

  // The (kind-appropriate) view key + label a node belongs to, or null when
  // it carries no code at that level. kind "building" needs locB; "floor"
  // needs locF.
  function _nodeViewRef(d, kind) {
    var a = d.locA || "";
    var b = d.locB || "";
    if (kind === "building") {
      if (!b) return null;
      return {
        key: "b|" + a + "|" + b,
        label: buildingViewLabel(d.locAName || "", d.locBName || ""),
      };
    }
    if (!d.locF) return null;
    return {
      key: "f|" + a + "|" + b + "|" + d.locF,
      label: floorViewLabel(buildingViewLabel(d.locAName || "", d.locBName || ""), d.locFName || d.locF),
    };
  }

  // Partition a built element set down to one view — a floor view
  // ("f|a|b|f": that floor's tagged devices) or a building view ("b|a|b":
  // ALL of that building's tagged devices, any floor) — plus the FortiGate
  // root ALWAYS (keeps the subgraph rooted for the column solver even when
  // the FG is tagged elsewhere). Untagged devices appear only in the Flat
  // view. Edges with both ends in view are kept as-is (loop flags preserved
  // — a physical ring is still a ring even when the view splits it); an edge
  // whose far end carries the same-level code for ANOTHER view is rewired to
  // a dashed "portal" stub named for the remote device + its view (one
  // portal per remote device — parallel links converge), carrying targetView
  // for tap-to-jump; an edge to an untagged device is dropped (no dead-end
  // stubs).
  function partitionElementsForFloor(elements, viewKey) {
    var key = String(viewKey || "");
    var kind = key.charAt(0) === "b" ? "building" : "floor";
    var nodeById = {};
    var inView = {};
    // True members (as opposed to the always-included FG root). Only a
    // member's cross-view edge earns a portal — the FG appears in every
    // view, so stubbing its controller links to every other view would just
    // spray "→ elsewhere" noise.
    var trueMember = {};
    (elements || []).forEach(function (el) {
      var d = el && el.data;
      if (!d || !d.id || d.source) return;
      nodeById[d.id] = d;
      var ref = _nodeViewRef(d, kind);
      if (ref && ref.key === key) {
        inView[d.id] = true;
        trueMember[d.id] = true;
      } else if (d.role === "fortigate") {
        inView[d.id] = true;
      }
    });
    var out = [];
    (elements || []).forEach(function (el) {
      var d = el && el.data;
      if (!d || !d.id || d.source) return;
      if (inView[d.id]) out.push({ data: Object.assign({}, d) });
    });
    var portalAdded = {};
    (elements || []).forEach(function (el) {
      var d = el && el.data;
      if (!d || !d.source || !d.target) return;
      var srcIn = !!inView[d.source];
      var tgtIn = !!inView[d.target];
      if (!srcIn && !tgtIn) return;
      if (srcIn && tgtIn) { out.push({ data: Object.assign({}, d) }); return; }
      var localId = srcIn ? d.source : d.target;
      if (!trueMember[localId]) return; // root-included FG — no portal spray
      var remoteId = srcIn ? d.target : d.source;
      var remote = nodeById[remoteId];
      var remoteRef = remote ? _nodeViewRef(remote, kind) : null;
      if (!remoteRef) return; // far end untagged at this level — drop, no stub
      var portalId = "portal:" + remoteId;
      if (!portalAdded[portalId]) {
        portalAdded[portalId] = true;
        out.push({
          data: {
            id: portalId,
            isPortal: 1,
            label: "→ " + remoteRef.label + ": " + (remote.label || remoteId),
            targetView: remoteRef.key,
            remoteAssetId: remoteId,
          },
        });
      }
      var e = Object.assign({}, d);
      e.id = "portal-" + e.id;
      if (srcIn) e.target = portalId;
      else e.source = portalId;
      out.push({ data: e });
    });
    return out;
  }

  // Per-device-type weights for the Dijkstra column solver. Infrastructure
  // (firewall / switch / AP) carries the operator's intended hierarchy weight;
  // every leaf kind (wired endpoint, wireless station, LLDP ghost, cross-site
  // remote asset) is treated as an endpoint (4) so it lands in an odd "leaf"
  // column to the right of the infra node it hangs off.
  var TOPOLOGY_NODE_WEIGHT = {
    fortigate: 1,
    fortiswitch: 2,
    fortiap: 3,
    endpoint: 4,
    "wireless-station": 4,
    lldp: 4,
    "remote-asset": 4,
  };
  // Roles eligible to occupy EVEN columns by weighted depth. A FortiAP only
  // claims its own column when it's a *branch* AP — a wireless-mesh root or the
  // uplink for a bridged switch (see isLeafAp() in the solver). A terminal
  // managed AP hanging off a switch port is a LEAF and lands in the odd column
  // immediately right of that switch, stacked directly beneath it — otherwise
  // each AP's weighted depth would interleave its own column between the
  // switches and fan a FortiGate's switch chain across the whole canvas.
  var TOPOLOGY_INFRA_ROLES = { fortigate: true, fortiswitch: true, fortiap: true };

  function topologyNodeWeight(role) {
    return TOPOLOGY_NODE_WEIGHT[role] != null ? TOPOLOGY_NODE_WEIGHT[role] : 4;
  }

  // Compute a column ("depth") + within-column ordinal ("lane") for every node
  // in a /topology element set, used by both the desktop and mobile surfaces to
  // position nodes deterministically instead of letting dagre auto-rank them.
  //
  // Algorithm:
  //   1. Node-weighted Dijkstra from the FortiGate root (firewall=1, switch=2,
  //      AP=3, leaf=4). Each node's cumulative path value is the sum of the
  //      weights of every node on its shortest path, both endpoints included
  //      (firewall=1; switch-on-fw=3; switch-on-switch=5; AP-on-switch=6; …).
  //   2. The DISTINCT cumulative values among COLUMN-ANCHOR nodes (infra that
  //      isn't a terminal leaf AP — see isLeafAp), sorted ascending, map to
  //      contiguous ranks; an anchor's column = rank * 2 (so anchors land on
  //      even columns 0,2,4,… with empty weighted-depth gaps squeezed out —
  //      "nothing in column 2 → move it left").
  //   3. Leaf nodes — wired endpoints, wireless stations, AND terminal managed
  //      APs — take the ODD column one right of their nearest anchor ancestor
  //      (parent even column + 1). This is what keeps the switch chain tight:
  //      a switch's APs hang one column to its right rather than each pushing
  //      the next switch further across the canvas.
  //   4. Disconnected nodes (no path to the firewall) drop into a rightmost
  //      orphan column so they stay visible.
  //   5. Lanes (rows) in two passes:
  //      (a) Nearest-free-slot packing over ANCHORS only: a node's first
  //          anchor child in a different column continues the node's row (the
  //          spine stays flat); every other anchor scans DOWNWARD from just
  //          below its parent's row for the first lane where its whole
  //          footprint fits — its own cell, the spine chain that will inherit
  //          its lane into later columns, and each chain member's planned
  //          leaf block one column right. Rows pack tight near the spine and
  //          drift further down only where subtrees congest, so vertical
  //          spread grows with chain depth instead of every subtree claiming
  //          a globally disjoint row band. Non-spine siblings sharing a
  //          location code are regrouped through the FULL tier chain — a:
  //          area, then b: building, then f: floor, then r: room, then jb:
  //          junction box — so each tier's co-members scan consecutively and
  //          land in adjacent lanes. Stable, first-appearance bucket order,
  //          keyless anchors at the tail, and a no-op on untagged sites. NOT
  //          guaranteed: cross-subtree adjacency (same location under
  //          different parents/columns) and the spine child's location
  //          (flat-chain wins). Fallback exiles scan from row 0 in their own
  //          negative columns.
  //      (b) Leaf pass: each leaf stacks downward from its parent's row using a
  //          PER-COLUMN cursor, pushed down only to dodge an occupied lane or a
  //          drawn edge passing through the column. Per-column (not global)
  //          cursors line up each switch's AP stack just below it instead of
  //          staircasing the stacks across the canvas. Within a parent's
  //          block, leaves are ordered through the same location-tier chain
  //          so same-room/jb leaves take contiguous lanes instead of raw
  //          payload order. Orphans stack below all.
  //
  // Returns { [nodeId]: { depth, lane } }, or null when there is no FortiGate
  // root (caller should fall back to its previous layout).
  function computeTopologyColumns(elements) {
    if (!Array.isArray(elements) || elements.length === 0) return null;

    var roleById = {};
    var nodeIds = [];
    var adj = {}; // undirected adjacency: id -> [neighborId, ...]
    var rootId = null;
    // Location-code grouping keys (stamped by buildTopologyElements from the
    // payload's a:/b:/f:/r:/jb: codes) — drive the sibling-row clustering in
    // pass 5a and the leaf-block ordering in pass 5b. All five tiers are read
    // so room / junction-box co-members land on adjacent lanes and their
    // hulls come out as tight bands instead of bounding boxes spanning
    // whatever rows their members happened to get.
    var locAById = {};
    var locBById = {};
    var locFById = {};
    var locRById = {};
    var locJbById = {};

    elements.forEach(function (el) {
      var d = el && el.data;
      if (!d || !d.id) return;
      if (d.source && d.target) return; // edge — handled below
      roleById[d.id] = d.role || null;
      nodeIds.push(d.id);
      adj[d.id] = adj[d.id] || [];
      if (d.locA) locAById[d.id] = d.locA;
      if (d.locB) locBById[d.id] = d.locB;
      if (d.locF) locFById[d.id] = d.locF;
      if (d.locR) locRById[d.id] = d.locR;
      if (d.locJb) locJbById[d.id] = d.locJb;
      if (d.role === "fortigate" && !rootId) rootId = d.id;
    });
    if (!rootId) return null; // no firewall — let the caller keep dagre

    // Mesh pre-pass: a mesh edge (root AP → leaf AP) makes the leaf a mesh
    // child. Its real uplink is wireless to the root AP, so any controller/
    // fallback edge that wired it to a FortiGate/FortiSwitch is bogus and must
    // be suppressed — otherwise Dijkstra would route the leaf off that switch
    // (or the FG fallback) instead of through its mesh parent.
    var meshLeaf = {};
    var meshSource = {}; // AP that is the ROOT/source of a mesh or bridge edge
    elements.forEach(function (el) {
      var d = el && el.data;
      // isMesh = wireless backhaul (root AP → leaf AP); isBridge = wired
      // switch behind an AP. Both make the target a mesh/bridge leaf whose
      // controller/fallback uplink is bogus and must route through the AP.
      if (d && d.source && d.target && (d.isMesh || d.isBridge)) {
        meshLeaf[d.target] = true;
        meshSource[d.source] = true;
      }
    });

    // A "leaf AP" is a terminal managed FortiAP: a Fortiap whose uplink is a
    // wired switch/FortiGate port (NOT a mesh leaf hanging off another AP) and
    // which has no wireless-mesh/bridge children of its own. It's placed like
    // any other leaf — odd column right of its parent switch, stacked beneath
    // it — instead of claiming its own even column. Mesh-root APs (meshSource)
    // and mesh-leaf APs (meshLeaf) stay column anchors so the wireless backhaul
    // hierarchy keeps its real columns.
    function isLeafAp(id) {
      return roleById[id] === "fortiap" && !meshSource[id] && !meshLeaf[id];
    }

    // Full adjacency (every edge) drives depth; physical adjacency (interface-
    // inferred + LLDP edges only) drives "is this switch's uplink to the
    // firewall actually verified?" A controller/FortiLink edge is NOT physical
    // proof — FortiOS reports `fortilink` on every managed switch whether or
    // not we can see the real cable, so a switch reachable ONLY through
    // controller edges is a fallback (placed in the negative columns below).
    var physicalAdj = {};
    var edgeList = []; // every DRAWN edge (id pairs) — used to keep endpoint
                       // nodes off connection lines that pass through them.
    elements.forEach(function (el) {
      var d = el && el.data;
      if (!d || !d.source || !d.target) return; // node — already handled
      if (!(d.source in adj) || !(d.target in adj)) return; // dangling edge
      edgeList.push([d.source, d.target]);
      // MCLAG ICL edges are sibling links, not uplinks: keep them in edgeList
      // (so connection-path overlays route around them) but exclude from the
      // depth/physical adjacency so neither peer becomes the other's parent and
      // the pair lands on the same column.
      if (d.isMclag) return;
      // Suppress a mesh/bridge leaf's bogus wired uplink: a non-mesh/bridge
      // edge joining the leaf to an infra node (FG/switch). Keep the mesh and
      // bridge edges themselves and the leaf's downstream client edges
      // (target is a wireless-station node).
      if (!d.isMesh && !d.isBridge) {
        var srcLeaf = meshLeaf[d.source] && TOPOLOGY_INFRA_ROLES[roleById[d.target]];
        var tgtLeaf = meshLeaf[d.target] && TOPOLOGY_INFRA_ROLES[roleById[d.source]];
        if (srcLeaf || tgtLeaf) return;
      }
      adj[d.source].push(d.target);
      adj[d.target].push(d.source);
      // Physical proof of a real link: interface-inferred, LLDP, OR a
      // controller edge flagged verifiedUplink (the FG↔switch interface edge
      // deduped into it). Mesh is wireless backhaul, deliberately NOT physical
      // proof of a switch's wired uplink.
      if (d.isIface || d.isLldp || d.isVerifiedUplink) {
        (physicalAdj[d.source] = physicalAdj[d.source] || []).push(d.target);
        (physicalAdj[d.target] = physicalAdj[d.target] || []).push(d.source);
      }
    });

    // --- 1. Node-weighted Dijkstra from the firewall -----------------------
    var INF = Infinity;
    var dist = {};
    var pred = {};
    nodeIds.forEach(function (id) { dist[id] = INF; pred[id] = null; });
    dist[rootId] = topologyNodeWeight(roleById[rootId]);
    var visited = {};
    // Small per-site graphs — a linear-scan extract-min is plenty.
    for (var iter = 0; iter < nodeIds.length; iter++) {
      var u = null;
      var best = INF;
      for (var i = 0; i < nodeIds.length; i++) {
        var cand = nodeIds[i];
        if (!visited[cand] && dist[cand] < best) { best = dist[cand]; u = cand; }
      }
      if (u === null) break; // remaining nodes unreachable
      visited[u] = true;
      (adj[u] || []).forEach(function (v) {
        var nd = dist[u] + topologyNodeWeight(roleById[v]);
        if (nd < dist[v]) { dist[v] = nd; pred[v] = u; }
      });
    }

    // --- 2. Physical-verification: which switches reach the firewall over
    //        interface/LLDP edges? BFS from the root over physicalAdj only. ---
    var physicallyVerified = {};
    physicallyVerified[rootId] = true;
    var pq = [rootId];
    while (pq.length) {
      var pcur = pq.shift();
      (physicalAdj[pcur] || []).forEach(function (n) {
        if (!physicallyVerified[n]) { physicallyVerified[n] = true; pq.push(n); }
      });
    }
    // A FortiSwitch that is reachable in the full graph (so not an orphan) but
    // NOT physically verified to the firewall is a FortiLink fallback — its
    // real cable can't be proven, so it's exiled to the negative columns.
    var FALLBACK_SWITCH_COL = -2; // even, mirrors verified switch parity
    var FALLBACK_ENDPOINT_COL = -3; // odd, mirrors verified endpoint parity
    function isFallbackSwitch(id) {
      // A bridge-leaf switch (FortiLink switch behind a FortiAP, reached via a
      // mesh/bridge edge) is a legitimate node placed via its AP, NOT a
      // FortiLink fallback.
      return roleById[id] === "fortiswitch" && dist[id] !== INF && !physicallyVerified[id] && !meshLeaf[id];
    }
    // A column anchor owns an even (or fallback) column and is positioned by the
    // tidy-tree lane pass. Terminal leaf APs are NOT anchors — they hang off
    // their parent switch in the leaf pass like endpoints and stations do.
    function isAnchor(id) {
      return TOPOLOGY_INFRA_ROLES[roleById[id]] && dist[id] !== INF && !isLeafAp(id);
    }

    // --- 3. Verified infra cumulative values -> even columns ---------------
    // Fallback switches are excluded so they don't consume a positive rank.
    var infraValues = {};
    nodeIds.forEach(function (id) {
      if (isAnchor(id) && !isFallbackSwitch(id)) {
        infraValues[dist[id]] = true;
      }
    });
    var sortedVals = Object.keys(infraValues)
      .map(Number)
      .sort(function (a, b) { return a - b; });
    var evenColByValue = {};
    sortedVals.forEach(function (val, idx) { evenColByValue[val] = idx * 2; });

    // Nearest column-anchor ancestor for a leaf, walking the Dijkstra
    // predecessor chain. Returns the ancestor's id (so the caller can tell
    // verified vs fallback). Leaf APs are skipped — a station hanging off a
    // leaf AP resolves up to the AP's parent switch.
    function nearestInfraAncestor(id) {
      var cur = pred[id];
      var guard = 0;
      while (cur && guard++ < nodeIds.length) {
        if (isAnchor(cur)) return cur;
        cur = pred[cur];
      }
      return null;
    }

    // --- 4. Assign a depth to every node -----------------------------------
    var depth = {};
    var maxInfraCol = sortedVals.length > 0 ? (sortedVals.length - 1) * 2 : 0;
    var orphanCol = maxInfraCol + 1;
    nodeIds.forEach(function (id) {
      if (isFallbackSwitch(id)) {
        depth[id] = FALLBACK_SWITCH_COL;
      } else if (isAnchor(id)) {
        depth[id] = evenColByValue[dist[id]];
      } else if (dist[id] !== INF) {
        var anc = nearestInfraAncestor(id);
        if (anc == null) depth[id] = orphanCol;
        else if (isFallbackSwitch(anc)) depth[id] = FALLBACK_ENDPOINT_COL; // leaf on a fallback switch
        else depth[id] = evenColByValue[dist[anc]] + 1; // verified leaf → odd col right of parent
      } else {
        depth[id] = orphanCol; // disconnected — keep visible at the right edge
      }
    });

    // --- 5a. Tidy-tree lane assignment over COLUMN ANCHORS -----------------
    // An anchor's FIRST anchor child in a different column continues the
    // anchor's own row (the spine stays flat); every other anchor claims a
    // fresh row. Each fresh-row anchor reserves as many rows as it has leaf
    // children (its APs), so same-column sibling switches are spaced far enough
    // apart that each one's AP block fits directly beneath it without colliding
    // with the next switch's block. Leaves (endpoints, stations, terminal APs)
    // are NOT placed here — they hang off their parent in pass 5b.
    var children = {};
    nodeIds.forEach(function (id) {
      if (pred[id] != null && dist[id] !== INF) {
        (children[pred[id]] = children[pred[id]] || []).push(id);
      }
    });
    var orderIdx = {};
    nodeIds.forEach(function (id, k) { orderIdx[id] = k; });
    var inFallbackRegion = {};
    nodeIds.forEach(function (id) { if (depth[id] < 0) inFallbackRegion[id] = true; });
    // Direct leaf children (APs / endpoints / stations) of each node — the
    // row-span an anchor needs reserved for its own leaf stack.
    var leafChildCount = {};
    nodeIds.forEach(function (id) {
      var c = children[id] || [];
      var n = 0;
      for (var i = 0; i < c.length; i++) if (!isAnchor(c[i])) n++;
      leafChildCount[id] = n;
    });

    // Longest pred-chain below a node, self included (memoized).
    var heightMemo = {};
    function subtreeHeight(id) {
      if (heightMemo[id] != null) return heightMemo[id];
      heightMemo[id] = 1; // guard — pred tree is acyclic, but cheap insurance
      var h = 1;
      (children[id] || []).forEach(function (c) {
        var ch = 1 + subtreeHeight(c);
        if (ch > h) h = ch;
      });
      heightMemo[id] = h;
      return h;
    }

    // Anchor children within one region (verified tree vs fallback exile),
    // tallest subtree first (the longest chain holds the spine row), then
    // element order for determinism. The region filter is load-bearing: a
    // fallback switch is an anchor and would otherwise sort among the
    // FortiGate's children and drag the spine into the negative columns.
    function orderedAnchorChildren(id, fallbackRegion) {
      var kids = (children[id] || []).filter(function (c) {
        return isAnchor(c) && (!!inFallbackRegion[c] === fallbackRegion);
      });
      kids.sort(function (a, b) {
        var ha = subtreeHeight(a);
        var hb = subtreeHeight(b);
        if (ha !== hb) return hb - ha;
        return orderIdx[a] - orderIdx[b];
      });
      return kids;
    }

    // The full location-tier chain, outermost first — one array so pass 5a
    // (anchor regrouping) and pass 5b (leaf-block ordering) can't drift apart.
    var LOC_TIERS = [locAById, locBById, locFById, locRById, locJbById];
    // Recursive stable bucketing over a tier chain: bucket by the first
    // tier's key (buckets keep the order in which their first member
    // appeared; members keep relative order), then recurse into each bucket
    // with the remaining tiers. A member with no key at THIS tier but a key
    // at a deeper one joins a synthetic "\tnone" bucket (placed like a real
    // bucket at first appearance) so e.g. floorless-but-room-coded siblings
    // still cluster by room — the tab prefix can't collide with a real key
    // because locKey() collapses whitespace. Members keyless at this tier
    // AND every deeper tier sink to the tail in their original relative
    // order, so an all-keyless input comes back bit-for-bit unchanged.
    function stableBucketByTiers(items, keyMaps) {
      if (!keyMaps || keyMaps.length === 0 || items.length < 2) return items;
      var keyMap = keyMaps[0];
      var rest = keyMaps.slice(1);
      function hasDeeperKey(it) {
        for (var i = 0; i < rest.length; i++) { if (rest[i][it]) return true; }
        return false;
      }
      var order = [];
      var buckets = {};
      var tail = [];
      items.forEach(function (it) {
        var key = keyMap[it] || (hasDeeperKey(it) ? "\tnone" : null);
        if (!key) { tail.push(it); return; }
        if (!buckets[key]) { buckets[key] = []; order.push(key); }
        buckets[key].push(it);
      });
      var out = [];
      order.forEach(function (k) { out.push.apply(out, stableBucketByTiers(buckets[k], rest)); });
      return out.concat(tail);
    }
    // Regroup sibling anchors so those sharing a location code claim
    // ADJACENT fresh rows, through every tier — area, then building, then
    // floor, then room, then junction box — so each tier's hull comes out as
    // a clean contiguous band instead of an interleaved one. The spine child
    // is excluded by the caller — flat-chain placement wins over grouping.
    // Cross-subtree adjacency is deliberately NOT attempted: same-location
    // anchors under different parents (or different columns) stay wherever
    // their own parent's band puts them.
    function regroupAnchorsByLocation(kids) {
      if (kids.length < 2) return kids;
      return stableBucketByTiers(kids, LOC_TIERS);
    }

    // Nearest-free-slot packing. The previous pass gave every fresh-row
    // anchor a globally disjoint row band from one monotonic cursor, so a
    // left-column switch's later children were pushed below EVERYTHING placed
    // before them — first-column siblings ended up enormous row distances
    // apart on big sites. Instead, lanes are allocated per column: a
    // fresh-row anchor scans DOWNWARD from just below its parent's row for
    // the first lane where its whole FOOTPRINT fits — its own cell, every
    // spine-chain descendant that will inherit its lane into later columns,
    // and each chain member's planned leaf block (the rows its APs/endpoints
    // stack into, one column right). Rows stay tight near the spine and only
    // drift further down where subtrees actually congest, so vertical spread
    // grows with how far the chains extend instead of being pre-allocated.
    var lane = {};
    var maxReservedLane = 0;
    var reserved = {}; // col -> { lane: true } — anchor cells + planned leaf blocks
    function cellTaken(c, L) { return !!(reserved[c] && reserved[c][L]); }
    function reserveCell(c, L) {
      (reserved[c] = reserved[c] || {})[L] = true;
      if (L > maxReservedLane) maxReservedLane = L;
    }
    // The spine chain: this anchor plus every descendant that inherits its
    // row — each node's FIRST anchor child in a DIFFERENT column (the chain
    // stays flat). A same-column anchor child (switch chained off a fallback
    // switch) can't continue the row; it places like any other child below.
    // Spine selection reads the ORIGINAL height-sorted order — location
    // grouping never changes which child holds the spine, only how the
    // remaining siblings pack together.
    function spineChainOf(id, fallbackRegion) {
      var chain = [id];
      var cur = id;
      var guard = 0;
      while (guard++ < nodeIds.length) {
        var kids = orderedAnchorChildren(cur, fallbackRegion);
        var spine = null;
        for (var i = 0; i < kids.length; i++) {
          if (depth[kids[i]] !== depth[cur]) { spine = kids[i]; break; }
        }
        if (spine == null || lane[spine] != null) break;
        chain.push(spine);
        cur = spine;
      }
      return chain;
    }
    // A chain member's leaf block really starts one row BELOW the member when
    // the chain continues past it — the continuing spine edge crosses the
    // leaf column at the member's own row, so the leaf pass can't use it.
    // Reserving the offset rows keeps the plan honest and sibling scans tight.
    function leafBlockStart(chain, i, L) {
      return i + 1 < chain.length ? L + 1 : L;
    }
    function footprintFits(chain, L) {
      for (var i = 0; i < chain.length; i++) {
        var m = chain[i];
        var c = depth[m];
        if (cellTaken(c, L)) return false;
        var n = leafChildCount[m] || 0;
        var b = leafBlockStart(chain, i, L);
        for (var k = 0; k < n; k++) {
          if (cellTaken(c + 1, b + k)) return false;
        }
      }
      return true;
    }
    function placeAnchorSubtree(id, fallbackRegion, startLane) {
      if (lane[id] != null) return; // safety — pred tree visits each anchor once
      var chain = spineChainOf(id, fallbackRegion);
      var L = startLane;
      while (!footprintFits(chain, L)) L++;
      for (var ci = 0; ci < chain.length; ci++) {
        var m = chain[ci];
        lane[m] = L;
        reserveCell(depth[m], L);
        var n = leafChildCount[m] || 0;
        var b = leafBlockStart(chain, ci, L);
        for (var k = 0; k < n; k++) reserveCell(depth[m] + 1, b + k);
      }
      // Non-spine children of every chain member, left-to-right so the
      // earliest columns' children get the rows closest to the chain. Each
      // scans downward from just below its parent's row.
      for (var mi = 0; mi < chain.length; mi++) {
        var member = chain[mi];
        var kids = orderedAnchorChildren(member, fallbackRegion);
        var next = mi + 1 < chain.length ? chain[mi + 1] : null;
        var rest = kids.filter(function (k) { return k !== next && lane[k] == null; });
        rest = regroupAnchorsByLocation(rest);
        for (var ki = 0; ki < rest.length; ki++) placeAnchorSubtree(rest[ki], fallbackRegion, L + 1);
      }
    }
    placeAnchorSubtree(rootId, false, 0);

    // Fallback exiles (negative columns): same placement scanning from row 0
    // so the exile cluster top-aligns with the root. Row numbers repeat but x
    // is negative (column -1 is always empty), so nothing overlaps spatially.
    // The exile ROOTS are location-regrouped like any sibling set — they're
    // effectively siblings of one virtual fallback parent, and without the
    // regroup same-room exiles would interleave in element order.
    var exileRoots = [];
    nodeIds.forEach(function (id) {
      if (isAnchor(id) && inFallbackRegion[id] &&
          !(pred[id] != null && isAnchor(pred[id]) && inFallbackRegion[pred[id]])) {
        exileRoots.push(id);
      }
    });
    regroupAnchorsByLocation(exileRoots).forEach(function (id) {
      placeAnchorSubtree(id, true, 0);
    });

    // --- 5b. Leaf pass: stack each parent's leaves as a contiguous block ----
    // Seed occupancy from the anchors already laid out, then place every leaf
    // (endpoint / station / terminal AP) in the odd column right of its parent.
    // Leaves are grouped BY PARENT and placed one whole parent at a time, so a
    // switch's APs always form one contiguous block and never get split apart
    // by another switch's APs sharing the column. Each block starts at its
    // parent's own row (so the AP stack lines up beneath the switch), pushed
    // down only to dodge a lane already taken in that column OR a drawn edge
    // (spine uplink, mesh backhaul, LLDP cross-link) passing through it. Blocks
    // are placed in parent-row order, so a higher switch's block sits above a
    // lower switch's — no staircasing, no interleaving.
    var occupied = {};
    nodeIds.forEach(function (id) {
      if (lane[id] != null) (occupied[depth[id]] = occupied[depth[id]] || {})[lane[id]] = true;
    });
    // Interpolated lane of an edge where it crosses integer column `col`, or
    // null when the edge doesn't strictly pass through that column (or an
    // endpoint isn't positioned yet).
    function edgeLaneAt(s, t, col) {
      var ds = depth[s], dt = depth[t];
      if (lane[s] == null || lane[t] == null || ds == null || dt == null) return null;
      if (ds === dt) return null;
      if (col <= Math.min(ds, dt) || col >= Math.max(ds, dt)) return null;
      return lane[s] + ((col - ds) / (dt - ds)) * (lane[t] - lane[s]);
    }
    // `insideBuilding`: when the leaf being placed belongs to a b: building
    // group, edges whose BOTH endpoints live OUTSIDE that building are
    // ignored — they're foreign pass-throughs, and now that the grouping
    // hulls separate buildings visually there's no point stretching a
    // building's interior to dodge them. Edges touching any same-building
    // node (the parent's own spine exit, in-building cross-links) are still
    // dodged so leaves don't sit on lines that belong to the group.
    function laneBlocked(id, col, L, insideBuilding) {
      if (occupied[col] && occupied[col][L]) return true;
      for (var e = 0; e < edgeList.length; e++) {
        var s = edgeList[e][0], t = edgeList[e][1];
        if (s === id || t === id) continue; // edges that terminate here are fine
        if (insideBuilding && locBById[s] !== insideBuilding && locBById[t] !== insideBuilding) continue;
        var el = edgeLaneAt(s, t, col);
        if (el != null && Math.abs(el - L) < 0.45) return true;
      }
      return false;
    }
    // Leaves grouped by parent. Placed parent-before-child via waves (a leaf
    // can chain off another leaf), each parent's leaves laid down as one block.
    var leavesByParent = {};
    nodeIds.forEach(function (id) {
      if (lane[id] == null && dist[id] !== INF && pred[id] != null) {
        (leavesByParent[pred[id]] = leavesByParent[pred[id]] || []).push(id);
      }
    });
    var progressed = true;
    while (progressed) {
      progressed = false;
      // Parents whose row is known and that still have unplaced leaves, in
      // row order so blocks stack top-to-bottom by parent position.
      var readyParents = Object.keys(leavesByParent).filter(function (p) {
        return lane[p] != null && leavesByParent[p].some(function (l) { return lane[l] == null; });
      });
      readyParents.sort(function (a, b) {
        if (lane[a] !== lane[b]) return lane[a] - lane[b];
        return orderIdx[a] - orderIdx[b];
      });
      readyParents.forEach(function (p) {
        var pending = leavesByParent[p].filter(function (l) { return lane[l] == null; });
        if (pending.length === 0) return;
        // One column per placement round (a parent's leaves share a column
        // except leaf-chain oddities — stragglers get the next wave).
        var col = depth[pending[0]];
        var block = pending.filter(function (l) { return depth[l] === col; });
        // Order the block's leaves through the location-tier chain so
        // same-room / same-jb leaves sit on CONTIGUOUS lanes inside the
        // window instead of interleaving in raw payload order — a room hull
        // over a switch's leaf stack collapses to a tight band rather than
        // spanning the whole block (and dragging the overlap sweep with it).
        // The window's start/length are unaffected; only which leaf gets
        // which lane inside it. Keyless leaves keep their relative order at
        // the tail, so untagged sites reproduce today's layout exactly.
        block = stableBucketByTiers(block, LOC_TIERS);
        // The whole block claims one CONTIGUOUS window, starting at the
        // parent's own row and slid down past taken lanes / crossing edges.
        // Sliding the window (rather than dodging per leaf) matters under
        // nearest-slot packing: another chain's spine can run through this
        // column, and per-leaf dodging would fragment the block around it.
        // When the parent belongs to a building group, foreign pass-through
        // edges don't block — the first leaf lands on the parent's own row
        // (or one below when the parent's spine continues), keeping each
        // building's interior compact.
        var pBuilding = locBById[p] || null;
        var L = lane[p];
        function windowFits(start) {
          for (var j = 0; j < block.length; j++) {
            if (laneBlocked(block[j], col, start + j, pBuilding)) return false;
          }
          return true;
        }
        while (!windowFits(L)) L++;
        block.forEach(function (leaf, j) {
          lane[leaf] = L + j;
          (occupied[col] = occupied[col] || {})[L + j] = true;
          progressed = true;
        });
      });
    }

    // Orphans (no path to the firewall → no pred) and any straggler the waves
    // couldn't reach: stack strictly below everything already placed so they
    // can't share a row with a positioned node in the same column.
    var maxLane = -1;
    nodeIds.forEach(function (id) { if (lane[id] != null && lane[id] > maxLane) maxLane = lane[id]; });
    var strayRow = Math.max(maxReservedLane, maxLane) + 1;
    nodeIds.forEach(function (id) {
      if (lane[id] == null) lane[id] = strayRow++;
    });

    var out = {};
    nodeIds.forEach(function (id) { out[id] = { depth: depth[id], lane: lane[id] }; });
    return out;
  }

  // ── Quotient (two-level) layout for location-coded sites ─────────────────
  // The flat solver's x is GLOBAL network depth, so a group's width is
  // dictated by where its members happen to sit in the site-wide column
  // sequence — a building whose chains start deep in the site renders as a
  // huge sparse box. This layout fixes that with the classic compound-graph
  // recipe:
  //
  //   1. Run the flat solver once (it encodes every ordering/clustering rule).
  //   2. Partition nodes into TOP-LEVEL groups — the outermost location tier
  //      each node carries (its a: area, else its b: building). Uncoded
  //      nodes (orphans, FortiLink fallbacks, untagged infra) share one
  //      pseudo-group so they stay clustered.
  //   3. Compact each group's interior: rank-compress the DISTINCT global
  //      depth/lane values its members use, so the group is exactly as wide
  //      and tall as its own subtree — internal shape, ordering, and the
  //      full-tier (area→building→floor→room→jb) row clustering from the
  //      flat solver are preserved, the dead space between them is not.
  //      Because the flat solver now clusters through room/jb (anchors AND
  //      each parent's leaf block), the inner-tier hulls inside a box are
  //      contiguous bands wherever their members share a parent or sibling
  //      set — the "two members at opposite corners" bounding-box blowup
  //      only remains possible across different subtrees.
  //   4. Lay out the QUOTIENT graph of group boxes: boxes are ordered into
  //      quotient columns by each group's minimum global depth (so inter-
  //      group flow still reads left-to-right), stacked within a column by
  //      minimum global lane, with fixed grid gaps that clear the hull
  //      padding. This is deterministic shelf packing — no iteration.
  //
  // Returns the SAME { id: { depth, lane } } contract as
  // computeTopologyColumns (units are grid columns/lanes; the caller
  // multiplies by its px spacing), or null when the flat solver has no
  // FortiGate root OR no node carries a location code (caller falls back to
  // the flat solver / dagre).
  function computeGroupedLayout(elements) {
    var global = computeTopologyColumns(elements);
    if (!global) return null;
    var GAP_X = 2; // grid columns between quotient columns (~260px)
    var GAP_Y = 2; // grid lanes between stacked boxes (~190px)
    var order = [];
    var groups = {};
    var anyCoded = false;
    (elements || []).forEach(function (el) {
      var d = el && el.data;
      if (!d || !d.id || d.source) return;
      if (!(d.id in global)) return;
      var key = d.locA
        ? "a|" + d.locA
        : (d.locB ? "b|" + (d.locA || "") + "|" + d.locB : "");
      if (key) anyCoded = true;
      var g = groups[key];
      if (!g) {
        g = { key: key, members: [] };
        groups[key] = g;
        order.push(g);
      }
      g.members.push(d.id);
    });
    if (!anyCoded) return null; // untagged site — flat solver is the layout
    function rankMap(values) {
      var uniq = Object.keys(values).map(Number).sort(function (a, b) { return a - b; });
      var m = {};
      uniq.forEach(function (v, i) { m[v] = i; });
      return { map: m, count: uniq.length };
    }
    order.forEach(function (g) {
      var dVals = {};
      var lVals = {};
      var qDepth = Infinity;
      var qLane = Infinity;
      g.members.forEach(function (id) {
        var p = global[id];
        dVals[p.depth] = true;
        lVals[p.lane] = true;
        if (p.depth < qDepth) qDepth = p.depth;
        if (p.lane < qLane) qLane = p.lane;
      });
      var dr = rankMap(dVals);
      var lr = rankMap(lVals);
      g.w = dr.count;
      g.h = lr.count;
      g.qDepth = qDepth;
      g.qLane = qLane;
      g.local = {};
      g.members.forEach(function (id) {
        var p = global[id];
        g.local[id] = { x: dr.map[p.depth], y: lr.map[p.lane] };
      });
    });
    // Height-budgeted shelf packing. Groups are placed in ascending
    // entry-depth order (the uncoded pseudo-group's fallback exiles carry
    // negative depths so it lands leftmost; ties break by entry lane then
    // key), stacking down the current quotient column and wrapping to a new
    // column when the stack would exceed the budget — the tallest group's
    // height, so the canvas is never taller than its biggest box and small
    // groups (single-AP buildings) tuck under each other instead of each
    // claiming a whole column.
    order.sort(function (a, b) {
      if (a.qDepth !== b.qDepth) return a.qDepth - b.qDepth;
      if (a.qLane !== b.qLane) return a.qLane - b.qLane;
      return a.key < b.key ? -1 : 1;
    });
    var budget = 0;
    order.forEach(function (g) { if (g.h > budget) budget = g.h; });
    var positions = {};
    var xOffset = 0;
    var colWidth = 0;
    var yCursor = 0;
    order.forEach(function (g) {
      if (yCursor > 0 && yCursor + g.h > budget) {
        xOffset += colWidth + GAP_X;
        colWidth = 0;
        yCursor = 0;
      }
      g.members.forEach(function (id) {
        positions[id] = {
          depth: xOffset + g.local[id].x,
          lane: yCursor + g.local[id].y,
        };
      });
      yCursor += g.h + GAP_Y;
      if (g.w > colWidth) colWidth = g.w;
    });
    return positions;
  }

  window.PolarisTopologyRender = {
    HEALTH_NODE_COLORS: HEALTH_NODE_COLORS,
    fortinetNodeColor: fortinetNodeColor,
    buildTopologyElements: buildTopologyElements,
    markPhysicalLoops: markPhysicalLoops,
    topologyStylesheet: topologyStylesheet,
    topologyLegendSpec: topologyLegendSpec,
    computeTopologyColumns: computeTopologyColumns,
    computeGroupedLayout: computeGroupedLayout,
    topologyNodeWeight: topologyNodeWeight,
    computeLocationGroups: computeLocationGroups,
    renderLocationGroups: renderLocationGroups,
    removeLocationGroups: removeLocationGroups,
    refreshLocationGroups: refreshLocationGroups,
    routeInterGroupEdges: routeInterGroupEdges,
    locationGroupTooltipParts: locationGroupTooltipParts,
    compareFloors: compareFloors,
    computeFloorViews: computeFloorViews,
    partitionElementsForFloor: partitionElementsForFloor,
  };
})();
