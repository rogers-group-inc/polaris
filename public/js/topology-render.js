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
  // here and by endpointNodeColor() below, AND read off
  // window.PolarisTopologyRender by map.js. These hues are deliberately
  // distinct from the CSS --color-* theme variables and from the assets-page
  // monitor-state palette — do NOT remap them. Extracting them here only
  // deduplicates the literals across the two files; the rendered values are
  // unchanged.
  // Canonical hexes live in api.js (POLARIS_HEALTH_COLORS — loaded first on
  // every page); re-exposed here for the topology consumers.
  var HEALTH_NODE_COLORS = window.POLARIS_HEALTH_COLORS;

  // Color the synthetic endpoint node of a path / where-is search by its
  // monitor state — the same five-state palette the firewall / switch / AP
  // nodes use, so the path reads as one visual scheme. Shared by the desktop
  // Device Map (map.js) and the phone's topology tab (mobile/topology-tab.js).
  function endpointNodeColor(hop) {
    var P = HEALTH_NODE_COLORS;
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
              // Radio-link detail the server attaches to a mesh leaf's
              // station row (markLinkClasses colours by signalDbm; the
              // tooltip prints all of it).
              signalDbm: s.signalDbm != null ? s.signalDbm : null,
              noiseDbm: s.noiseDbm != null ? s.noiseDbm : null,
              band: s.band || null,
              channel: s.channel != null ? s.channel : null,
              channelWidthMhz: s.channelWidthMhz != null ? s.channelWidthMhz : null,
              ssid: s.ssid || null,
              seenAt: s.lastSeen || null,
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
          srcIf: e.srcIf || null,
          tgtIf: e.tgtIf || null,
        },
      });
    });
    // FortiGate id + switch id set so we can label the FortiGate→switch
    // FortiLink uplinks. Only VERIFIED ones (an interface/LLDP-backed cable)
    // are drawn — see the layer-2 rule below. The server has already rewritten
    // each half of a verified uplink's label to a physical port (an aggregate
    // never reaches a label — physicalLabelHalf), so its port pair is kept,
    // with "unknown" on a side it could not resolve; one with neither side
    // resolved reads "fortilink".
    var fgId = data.fortigate ? data.fortigate.id : null;
    var switchIdSet = {};
    (data.switches || []).forEach(function (s) { if (s && s.id) switchIdSet[s.id] = true; });
    (data.edges || []).forEach(function (e, i) {
      // Skip the bogus wired uplink to a mesh/bridge leaf — the mesh edge
      // already connects it (and from the correct parent AP).
      if (meshLeafIds[e.target]) return;
      var isFgSwitch = fgId && e.source === fgId && switchIdSet[e.target];
      // A layer-2 map draws cables only (operator decision 2026-11-02). Two
      // kinds of controller edge are not one: a FortiGate→switch FortiLink
      // uplink with no physical cable confirmed (no interface / LLDP proof),
      // and a FortiGate→FortiAP edge — the server draws that only as a
      // fallback when the AP's switch port is unknown ("real attachment
      // unknown"); a known port arrives as the switch→AP edge instead. Such a
      // device stands unconnected rather than on an invented link.
      if (isFgSwitch && !e.verifiedUplink) return;
      if (fgId && e.source === fgId && apIdSet[e.target]) return;
      var label = e.label || "";
      // A confirmed uplink whose ports could not be resolved still reads as
      // the FortiLink it is rather than "unknown ↔ unknown".
      if (isFgSwitch && (!label || label === "unknown ↔ unknown")) label = "fortilink";
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
          // Kept only because an end is not being fully polled (dependency-
          // down, down, recovering): the server's last-known rule. Dashed.
          isLastKnown: e.lastKnownAt ? 1 : undefined,
          lastKnownAt: e.lastKnownAt || undefined,
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
          srcIf: e.srcIf || null,
          tgtIf: e.tgtIf || null,
        },
      });
    });

    markLinkClasses(elements);
    markPhysicalLoops(elements);
    markInterGroupEdges(elements);
    return elements;
  }

  // ── Link colour classes ───────────────────────────────────────────────────
  // Every device-to-device link is one neutral colour until it has something
  // to say (operator design, 2026-11-06): a WIRED link takes the colour and
  // weight of its speed, a MESH link turns yellow → orange → red as its
  // signal weakens. Stamped as data so the stylesheet, the legend's hover
  // match and the tooltip all read one decision.
  //
  // A wired link's speed is the slower of its two ends' interface speeds
  // (srcIf / tgtIf, from the server's current-state interface table); an end
  // with no reading or a non-positive one does not count. Both unknown →
  // "unknown". Faster than 10 Gb (an aggregate, 25/40/100 Gb) reads as 10 Gb.
  var LINK_SPEED_CLASSES = ["10g", "5g", "2g5", "1g", "100m", "10m"];
  function linkSpeedClass(bps) {
    if (!(bps > 0)) return "unknown";
    if (bps >= 1e10) return "10g";
    if (bps >= 5e9) return "5g";
    if (bps >= 2.5e9) return "2g5";
    if (bps >= 1e9) return "1g";
    if (bps >= 1e8) return "100m";
    return "10m";
  }
  function linkSpeedBps(d) {
    var best = null;
    [d && d.srcIf, d && d.tgtIf].forEach(function (i) {
      var v = i && i.speedBps != null ? Number(i.speedBps) : NaN;
      if (v > 0 && (best == null || v < best)) best = v;
    });
    return best;
  }
  // Mesh signal bands in dBm: good ≥ −65, fair −66…−72, weak −73…−80, poor
  // below −80. No reading (an SNMP-only controller) → "unknown", drawn like
  // good — the neutral dashed line — and named in the tooltip.
  var MESH_SIGNAL_CLASSES = ["good", "fair", "weak", "poor"];
  function meshSignalClass(dbm) {
    if (dbm == null || dbm === "" || !isFinite(Number(dbm))) return "unknown";
    var v = Number(dbm);
    if (v >= -65) return "good";
    if (v >= -72) return "fair";
    if (v >= -80) return "weak";
    return "poor";
  }
  function markLinkClasses(elements) {
    elements.forEach(function (el) {
      var d = el && el.data;
      if (!d || !d.source) return;
      if (d.isMesh) { d.meshSignal = meshSignalClass(d.signalDbm); return; }
      if (d.isWireless) return;
      var bps = linkSpeedBps(d);
      d.speedBps = bps;
      d.linkSpeed = linkSpeedClass(bps);
    });
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
  // Anything that isn't a family is resolved from the document rather than
  // silently taking the else-branch: `theme === "dark"` on its own turns a
  // theme id ("nightfall") — or a stale per-user basemap preference that has
  // nothing to do with this canvas — into the LIGHT palette, which is how
  // #1a1a1a node labels ended up on nightfall's #0d0d1a graph pane.
  function paletteFamily(theme) {
    if (theme === "dark" || theme === "light") return theme;
    var themeId = typeof document !== "undefined" && document.documentElement
      ? document.documentElement.getAttribute("data-theme") : null;
    return (themeId === "morning" || themeId === "noon") ? "light" : "dark";
  }

  // Link colours per palette family (operator design 2026-11-06, approved
  // on the "Device Map link colors" canvas). Every device-to-device link is
  // `neutral` until it has something to say: a wired link takes its SPEED's
  // colour — a cool ramp, violet 10 Gb → blue → cyan → teal 1 Gb → slate
  // 100 / 10 Mb — and a mesh link turns `fair` yellow → `weak` orange →
  // `poor` red as its signal weakens. Warm hues are kept for signal alone, so
  // a slow cable never reads as a failing radio; weight carries speed too
  // (LINK_SPEED_STYLE), so the ramp still reads in grayscale. The daylight
  // set steps each hue to its 600/700 shade (≥ 3:1 on noon / morning); the
  // neutral is the FAINTEST line in both families. `halo` rings a link on a
  // physical loop (white on dark, near-black on daylight — yellow was taken
  // by signal). `portal` is the floor-view portal border; `wireless` the
  // (unrendered) client-station link. The legend (topologyLegendSpec) reads
  // this table — change them together.
  var EDGE_COLORS = {
    dark: {
      neutral: "#5b6478", "10g": "#a78bfa", "5g": "#60a5fa", "2g5": "#67e8f9", "1g": "#14b8a6",
      "100m": "#94a3b8", "10m": "#94a3b8", fair: "#eab308", weak: "#f97316", poor: "#ef4444",
      halo: "#f8fafc", portal: "#6a7388", wireless: "#22d3ee",
    },
    light: {
      neutral: "#b4bcc8", "10g": "#7c3aed", "5g": "#2563eb", "2g5": "#0891b2", "1g": "#0f766e",
      "100m": "#64748b", "10m": "#64748b", fair: "#ca8a04", weak: "#ea580c", poor: "#dc2626",
      halo: "#111827", portal: "#64748b", wireless: "#0e7490",
    },
  };
  // Line weight and pattern per speed class: faster is heavier; 10 Mb is
  // dotted; an unknown speed is the neutral 2 px line.
  var LINK_SPEED_STYLE = {
    "10g": { width: 4 }, "5g": { width: 3.4 }, "2g5": { width: 3 }, "1g": { width: 2.4 },
    "100m": { width: 1.8 }, "10m": { width: 1.6, dotted: true }, unknown: { width: 2 },
  };
  var MESH_LINK_WIDTH = 2.4;

  function topologyStylesheet(theme, opts) {
    opts = opts || {};
    theme = paletteFamily(theme);
    var isDark = theme === "dark";
    var ec = EDGE_COLORS[theme];
    var textColor = isDark ? "#eef0f4" : "#1a1a1a";
    var edgeColor = ec.neutral;
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
      // Wired links: one neutral line whatever drew them (controller data,
      // interface naming, LLDP, an AP uplink, a bridge), then coloured and
      // weighted by SPEED below. HOW a link was found is in its tooltip.
      // No arrowheads: the map reads hierarchy from its columns.
      {
        selector: 'edge[linkSpeed]',
        style: { "line-style": "solid", "target-arrow-shape": "none" },
      },
      {
        selector: 'edge[linkSpeed = "10g"]',
        style: { "line-color": ec["10g"], "target-arrow-color": ec["10g"], width: LINK_SPEED_STYLE["10g"].width, },
      },
      {
        selector: 'edge[linkSpeed = "5g"]',
        style: { "line-color": ec["5g"], "target-arrow-color": ec["5g"], width: LINK_SPEED_STYLE["5g"].width, },
      },
      {
        selector: 'edge[linkSpeed = "2g5"]',
        style: { "line-color": ec["2g5"], "target-arrow-color": ec["2g5"], width: LINK_SPEED_STYLE["2g5"].width, },
      },
      {
        selector: 'edge[linkSpeed = "1g"]',
        style: { "line-color": ec["1g"], "target-arrow-color": ec["1g"], width: LINK_SPEED_STYLE["1g"].width, },
      },
      {
        selector: 'edge[linkSpeed = "100m"]',
        style: { "line-color": ec["100m"], "target-arrow-color": ec["100m"], width: LINK_SPEED_STYLE["100m"].width, },
      },
      {
        selector: 'edge[linkSpeed = "10m"]',
        style: { "line-color": ec["10m"], "target-arrow-color": ec["10m"], width: LINK_SPEED_STYLE["10m"].width, "line-style": "dashed", "line-dash-pattern": [0.5, 4], "line-cap": "round", },
      },
      {
        selector: 'edge[linkSpeed = "unknown"]',
        style: { "line-color": ec.neutral, "target-arrow-color": ec.neutral, width: LINK_SPEED_STYLE["unknown"].width, },
      },
      // MCLAG ICL: a peer link between two FortiSwitches — its speed's colour
      // and weight, kept DASHED so the pair reads as peers, not parent/child.
      {
        selector: 'edge[isMclag = 1]',
        style: { "line-style": "dashed", "target-arrow-shape": "none" },
      },
      // LAST KNOWN: a switch link kept on the map while an end is not being
      // fully polled (dependency-down, down, recovering), drawn from evidence
      // nothing has refreshed since. Long dashes, faded: still where the cable
      // was, not a reading of it now. The tooltip says when it was last seen.
      {
        selector: 'edge[isLastKnown = 1]',
        style: { "line-style": "dashed", "line-dash-pattern": [10, 6], opacity: 0.6 },
      },
      // Wireless edge: AP → connected station (not rendered today — the map
      // is the FG / switch / AP backbone). Dashed, faint.
      {
        selector: 'edge[isWireless = 1]',
        style: {
          "line-style": "dashed",
          "line-color": ec.wireless,
          "target-arrow-color": ec.wireless,
          width: 1.4,
          opacity: 0.7,
        },
      },
      // Wireless mesh backhaul (root AP → leaf AP): dashed, the neutral
      // colour at a good signal or none reported, then by signal band.
      {
        selector: 'edge[isMesh = 1]',
        style: {
          "line-style": "dashed",
          "line-color": ec.neutral,
          "target-arrow-color": ec.neutral,
          "target-arrow-shape": "none",
          width: MESH_LINK_WIDTH,
        },
      },
      {
        selector: 'edge[meshSignal = "fair"]',
        style: { "line-color": ec.fair, "target-arrow-color": ec.fair },
      },
      {
        selector: 'edge[meshSignal = "weak"]',
        style: { "line-color": ec.weak, "target-arrow-color": ec.weak },
      },
      {
        selector: 'edge[meshSignal = "poor"]',
        style: { "line-color": ec.poor, "target-arrow-color": ec.poor },
      },
      // Physical loop membership (stamped by markPhysicalLoops): a wired edge
      // lying on a cycle gets a halo AROUND its own speed colour, so a switch
      // ring reads at a glance. Only outline props here.
      {
        selector: 'edge[inLoop = 1]',
        style: {
          "line-outline-color": ec.halo,
          "line-outline-width": 2,
        },
      },
      // Fan-out links (stamped by markFanOutEdges from the column solver's
      // grid): a link between two nodes two-plus columns apart on different
      // rows routes orthogonally — along the shallow end's row, a turn in
      // the gutter half a column along (data(fanOutTurn), signed so
      // it is measured from the shallow end), then along the deep end's
      // row. One rule per screen axis because the phone transposes the grid
      // (depth → y). Geometry only — color/dash still come from the type
      // rules above. The inter-group rule below wins where both apply.
      {
        selector: 'edge[isFanOut = 1][fanOutDir = "horizontal"]',
        style: {
          "curve-style": "taxi",
          "taxi-direction": "horizontal",
          "taxi-turn": "data(fanOutTurn)",
          "taxi-turn-min-distance": 12,
        },
      },
      {
        selector: 'edge[isFanOut = 1][fanOutDir = "vertical"]',
        style: {
          "curve-style": "taxi",
          "taxi-direction": "vertical",
          "taxi-turn": "data(fanOutTurn)",
          "taxi-turn-min-distance": 12,
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
          "background-opacity": isDark ? 0.06 : 0.07,
          "border-width": 2,
          "border-opacity": isDark ? 0.55 : 0.8,
          label: "data(label)",
          "font-size": "16px",
          "font-weight": 700,
          // The name sits INSIDE the box, just under its top wall: anchored
          // above the box (valign top) and pushed down past the wall. The box
          // reserves LOC_LABEL_BAND px for it above its contents
          // (_layoutLocationGroups), so the name never sits on a device.
          "text-valign": "top",
          "text-halign": "center",
          "text-margin-y": LOC_LABEL_MARGIN_Y,
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
          "border-color": ec.portal,
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
      // Connection-path handles (topology-edge-editor.js): a filled dot per
      // bend point, a ring per end point riding the device outline — every
      // handle the same size, selected or not, so only fill and border
      // colour tell them apart. Drawn above everything so a handle on top of
      // a device stays grabbable.
      {
        selector: "node[isEdgeHandle]",
        style: {
          shape: "ellipse",
          width: 12,
          height: 12,
          label: "",
          "background-color": "#22d3ee",
          "background-opacity": 1,
          "background-image": "none",
          "border-width": 3,
          "border-color": isDark ? "#0d0d1a" : "#ffffff",
          "border-opacity": 1,
          "overlay-padding": 4,
          // Default (auto) compare: nodes already sit above edges, and among
          // nodes this z wins. "manual" sorted the handles UNDER the devices,
          // so pressing an end point grabbed its device instead.
          "z-index": 9999,
        },
      },
      {
        selector: 'node[isEdgeHandle][handleKind != "bend"]',
        style: {
          "background-color": isDark ? "#0d0d1a" : "#ffffff",
          "border-color": "#22d3ee",
        },
      },
      {
        selector: "node[isEdgeHandle]:selected",
        style: {
          // Same size as an unselected handle; border-width restated so
          // the generic node:selected rule's 5px border can't fatten it.
          "border-width": 3,
          "border-color": "#f59e0b",
          "overlay-opacity": 0,
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

    // Link hover (highlightLinkHover): the hovered link and the devices on
    // its ends — or a whole physical loop — glow. Devices glow bright in the
    // theme's accent; links glow in the HOVERED link's own colour
    // (data(hoverGlow), stamped by highlightLinkHover). An UNDERLAY, behind
    // the element, so a link keeps its dash and a device its health fill.
    var hoverGlow = isDark ? "#4fc3f7" : "#0369a1";
    style.push({
      selector: "node.link-hover",
      style: {
        "underlay-color": hoverGlow,
        "underlay-opacity": 0.8,
        // Graph units, so it shrinks with the zoom: a thin bright ring, not
        // a blob (operator feedback 2026-11-02).
        "underlay-padding": 5,
        "underlay-shape": "ellipse",
      },
    });
    // Underlay padding is measured from the node's edge, but a border draws
    // CENTRED on that edge, so half of an icon ring sits outside it. Pad past
    // the ring, or the firewall's 10px ring covers the 5px glow entirely.
    // Mirrors the hasIcon border widths above: 5 + border / 2.
    [["fortigate", 10], ["fortiswitch", 8.5], ["fortiap", 8], ["remote-asset", 8.5]].forEach(function (r) {
      style.push({
        selector: 'node.link-hover[hasIcon = 1][role="' + r[0] + '"]',
        style: { "underlay-padding": r[1] },
      });
    });
    style.push({
      selector: "edge.link-hover",
      style: {
        "underlay-color": hoverGlow,
        "underlay-opacity": 0.6,
        "underlay-padding": 4,
        "z-index": 998,
      },
    });
    // A location box lit from the legend: its own border drawn heavier and
    // its fill tinted a little more. No underlay — a box's fill is nearly
    // transparent, so one would flood the whole box.
    style.push({
      selector: "node.link-hover[isLocGroup]",
      style: { "underlay-opacity": 0, "border-width": 5, "background-opacity": isDark ? 0.16 : 0.14 },
    });
    style.push({
      selector: "edge.link-hover[hoverGlow]",
      style: { "underlay-color": "data(hoverGlow)" },
    });

    return style;
  }

  // What a link hover lights up: the link and the devices on its two ends; a
  // link on a physical loop (inLoop, markPhysicalLoops) lights the WHOLE loop —
  // every loop link reachable from it through the devices they share, and
  // those devices. Location boxes are never part of it.
  function linkHoverSet(cy, edge) {
    if (!edge || !edge.isEdge || !edge.isEdge()) return cy.collection();
    if (!edge.data("inLoop")) return edge.union(edge.connectedNodes());
    var edges = cy.collection().union(edge);
    var nodes = cy.collection();
    var queue = edge.connectedNodes().toArray();
    var seen = {};
    while (queue.length) {
      var n = queue.shift();
      if (seen[n.id()]) continue;
      seen[n.id()] = true;
      nodes = nodes.union(n);
      n.connectedEdges("[inLoop = 1]").forEach(function (e) {
        if (edges.contains(e)) return;
        edges = edges.union(e);
        e.connectedNodes().forEach(function (m) { if (!seen[m.id()]) queue.push(m); });
      });
    }
    return edges.union(nodes.filter(function (n) { return !n.data("isLocGroup"); }));
  }
  function highlightLinkHover(cy, edge) {
    clearLinkHover(cy);
    var lit = linkHoverSet(cy, edge);
    // Every lit link — a whole loop included — glows in the colour the link
    // under the mouse is SEEN in: a loop link's yellow outline (markPhysicalLoops
    // halo) when it has one, otherwise its line colour.
    var glow = edge && edge.isEdge && edge.isEdge() ? _seenEdgeColor(edge) : null;
    if (glow) lit.edges().data("hoverGlow", glow);
    lit.addClass("link-hover");
  }
  function _seenEdgeColor(edge) {
    return parseFloat(edge.style("line-outline-width")) > 0
      ? edge.style("line-outline-color") : edge.style("line-color");
  }
  function clearLinkHover(cy) {
    if (!cy || cy.destroyed()) return;
    var lit = cy.elements(".link-hover");
    lit.removeClass("link-hover");
    lit.edges().removeData("hoverGlow");
  }

  // Legend rows for the topology overlay. Colors here mirror the constants
  // used by `fortinetNodeColor()` (status hues) and `topologyStylesheet()`
  // (node fills + edge styles) so a stylesheet change has exactly one place
  // the legend has to follow. `theme` is a family like topologyStylesheet's
  // (omitted → the document's), since links and boxes take a darker shade on
  // the daylight themes.
  function topologyLegendSpec(theme) {
    var fam = paletteFamily(theme);
    var ec = EDGE_COLORS[fam];
    function loc(kind) { return locGroupColor(kind, fam); }
    // `key` names what a row stands for on the map (legendMatch): hovering
    // the row lights those elements.
    return {
      nodes: [
        { key: "role:fortigate",    label: "Firewall",          kind: "circle",          size: "lg", fill: "data(nodeColor)" },
        { key: "role:fortiswitch",  label: "Switch",            kind: "circle",          size: "md", fill: "data(nodeColor)" },
        { key: "role:fortiap",      label: "Access Point",      kind: "circle",          size: "sm", fill: "data(nodeColor)" },
        { key: "role:endpoint",     label: "Endpoint",          kind: "round-rectangle", size: "md", fill: "data(nodeColor)" },
        { key: "role:remote-asset", label: "Remote asset",      kind: "circle",          size: "md", fill: "#1e3a5f", border: "#4fc3f7" },
      ],
      health: [
        { key: "health:up",          label: "Up",                color: HEALTH_NODE_COLORS.up },
        { key: "health:degraded",    label: "Degraded",          color: HEALTH_NODE_COLORS.degraded },
        { key: "health:down",        label: "Down",              color: HEALTH_NODE_COLORS.down },
        { key: "health:maintenance", label: "Maintenance",       color: HEALTH_NODE_COLORS.maintenance },
        { key: "health:passive",     label: "Passive",           color: HEALTH_NODE_COLORS.passive },
        { key: "health:unknown",     label: "Dep. Down",         color: HEALTH_NODE_COLORS.unknown },
        { key: "health:unmonitored", label: "Unmonitored",       color: HEALTH_NODE_COLORS.unmonitored },
      ],
      // Links, in three sections (`section`): wired speed, mesh signal, and
      // the two marks that sit on top of either. `width` is the line's weight
      // on the map; `style` solid | dashed | dotted.
      edges: [
        { key: "speed:10g",     section: "speed",  label: "10 Gb",           color: ec["10g"],  style: "solid",  width: LINK_SPEED_STYLE["10g"].width },
        { key: "speed:5g",      section: "speed",  label: "5 Gb",            color: ec["5g"],   style: "solid",  width: LINK_SPEED_STYLE["5g"].width },
        { key: "speed:2g5",     section: "speed",  label: "2.5 Gb",          color: ec["2g5"],  style: "solid",  width: LINK_SPEED_STYLE["2g5"].width },
        { key: "speed:1g",      section: "speed",  label: "1 Gb",            color: ec["1g"],   style: "solid",  width: LINK_SPEED_STYLE["1g"].width },
        { key: "speed:100m",    section: "speed",  label: "100 Mb",          color: ec["100m"], style: "solid",  width: LINK_SPEED_STYLE["100m"].width },
        { key: "speed:10m",     section: "speed",  label: "10 Mb",           color: ec["10m"],  style: "dotted", width: LINK_SPEED_STYLE["10m"].width },
        { key: "speed:unknown", section: "speed",  label: "Speed not known", color: ec.neutral, style: "solid",  width: LINK_SPEED_STYLE.unknown.width },
        { key: "signal:good",   section: "signal", label: "Good, −65 dBm or better", color: ec.neutral, style: "dashed", width: MESH_LINK_WIDTH },
        { key: "signal:fair",   section: "signal", label: "Fair, −66 to −72",        color: ec.fair,    style: "dashed", width: MESH_LINK_WIDTH },
        { key: "signal:weak",   section: "signal", label: "Weak, −73 to −80",        color: ec.weak,    style: "dashed", width: MESH_LINK_WIDTH },
        { key: "signal:poor",   section: "signal", label: "Poor, below −80",         color: ec.poor,    style: "dashed", width: MESH_LINK_WIDTH },
        { key: "edge:mclag",    section: "also",   label: "MCLAG peer link, its speed's color", color: ec["10g"], style: "dashed", width: LINK_SPEED_STYLE["10g"].width },
        { key: "edge:loop",     section: "also",   label: "Part of a ring",  color: ec["1g"], halo: ec.halo, style: "solid", width: LINK_SPEED_STYLE["1g"].width },
        { key: "edge:lastKnown", section: "also",  label: "Last known, an end not being polled", color: ec.neutral, style: "dashed", width: LINK_SPEED_STYLE.unknown.width },
      ],
      // Location grouping hulls — colors + border styles must mirror
      // LOC_GROUP_KINDS (all levels are rounded rectangles, identified by a
      // fixed per-level color).
      locations: [
        { key: "loc:area",     label: "Area",         shape: "rect", style: "solid",  color: loc("area") },
        { key: "loc:building", label: "Building",     shape: "rect", style: "solid",  color: loc("building") },
        { key: "loc:floor",    label: "Floor",        shape: "rect", style: "dashed", color: loc("floor") },
        { key: "loc:room",     label: "Room",         shape: "rect", style: "solid",  color: loc("room") },
        { key: "loc:jb",       label: "Junction box", shape: "rect", style: "dashed", color: loc("jb") },
      ],
    };
  }

  // Which legend Edges row a link belongs to — the same precedence as its
  // tooltip's kind line (edgeTooltipHtml) and the stylesheet's colours: a
  // switch bridged behind an AP is drawn as an AP link; a wireless client
  // has no row (null).
  function edgeLegendKind(edge) {
    var d = function (k) { return edge.data(k) === 1 || edge.data(k) === true; };
    if (d("isMesh")) return "mesh";
    if (d("isBridge")) return "apLink";
    if (d("isWireless")) return null;
    if (d("isMclag")) return "mclag";
    if (d("isApLink")) return "apLink";
    if (d("isIface") || d("isLldp")) return "switch";
    return "controller";
  }

  // The map elements a legend row (its spec `key`) stands for. Health
  // matches on the colour a device is painted, so it follows exactly what
  // fortinetNodeColor decided (maintenance over Dep. Down over probe health).
  function legendMatch(cy, key) {
    if (!cy || cy.destroyed() || !key) return cy ? cy.collection() : null;
    var i = key.indexOf(":");
    var kind = key.slice(0, i), val = key.slice(i + 1);
    var devices = cy.nodes().filter(function (n) {
      return !n.data("isLocGroup") && !n.data("isEdgeHandle") && !n.data("isPortal");
    });
    if (kind === "role") return devices.filter(function (n) { return n.data("role") === val; });
    if (kind === "health") {
      var color = HEALTH_NODE_COLORS[val];
      return devices.filter(function (n) { return !!color && n.data("nodeColor") === color; });
    }
    if (kind === "edge") {
      return cy.edges().filter(function (e) {
        if (val === "loop") return e.data("inLoop") === 1;
        if (val === "lastKnown") return e.data("isLastKnown") === 1;
        return edgeLegendKind(e) === val;
      });
    }
    if (kind === "speed") return cy.edges().filter(function (e) { return e.data("linkSpeed") === val; });
    // "Good" lights the links drawn like it: a good signal and none reported.
    if (kind === "signal") {
      return cy.edges().filter(function (e) {
        var c = e.data("meshSignal");
        return c === val || (val === "good" && c === "unknown");
      });
    }
    if (kind === "loc") return cy.nodes().filter(function (n) { return !!n.data("isLocGroup") && n.data("locKind") === val; });
    return cy.collection();
  }

  // Light what a legend row stands for, in the link-hover style: devices and
  // boxes get the accent ring, each link a glow in its OWN seen colour.
  function highlightLegendHover(cy, key) {
    clearLinkHover(cy);
    var lit = legendMatch(cy, key);
    if (!lit || !lit.length) return;
    lit.edges().forEach(function (e) { e.data("hoverGlow", _seenEdgeColor(e)); });
    lit.addClass("link-hover");
  }

  // Hovering a row in a legend body lights its elements on the graph
  // getCy() returns (the Device Map page's modal and the widget). Bound once
  // per body element; the rows inside may be re-rendered freely.
  function wireLegendHover(bodyEl, getCy) {
    if (!bodyEl || bodyEl.dataset.legendHoverBound) return;
    bodyEl.dataset.legendHoverBound = "1";
    var current = null;
    function apply(key) {
      if (key === current) return;
      current = key;
      var cy = getCy();
      if (!cy || cy.destroyed()) return;
      if (key) highlightLegendHover(cy, key);
      else clearLinkHover(cy);
    }
    bodyEl.addEventListener("mouseover", function (e) {
      var row = e.target && e.target.closest ? e.target.closest("[data-legend-key]") : null;
      apply(row ? row.getAttribute("data-legend-key") : null);
    });
    bodyEl.addEventListener("mouseleave", function () { apply(null); });
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
  // `colorLight` is the daylight-family shade of the same hue (see
  // EDGE_COLORS — the pastel set measured 1.3–2.3:1 on noon / morning, which
  // left the box labels unreadable).
  var LOC_GROUP_KINDS = {
    area:     { rank: 0, pad: 42, color: "#f472b6", colorLight: "#be185d", shape: "round-rectangle", dash: "solid",  z: 1, scaleW: 1, scaleH: 1 },
    building: { rank: 1, pad: 34, color: "#4fc3f7", colorLight: "#0369a1", shape: "round-rectangle", dash: "solid",  z: 2, scaleW: 1, scaleH: 1 },
    floor:    { rank: 2, pad: 26, color: "#a78bfa", colorLight: "#6d28d9", shape: "round-rectangle", dash: "dashed", z: 3, scaleW: 1, scaleH: 1 },
    room:     { rank: 3, pad: 18, color: "#4ade80", colorLight: "#15803d", shape: "round-rectangle", dash: "solid",  z: 4, scaleW: 1, scaleH: 1 },
    jb:       { rank: 4, pad: 12, color: "#f59e0b", colorLight: "#b45309", shape: "round-rectangle", dash: "dashed", z: 5, scaleW: 1, scaleH: 1 },
  };

  // The box name lives inside the box, under its top wall (stylesheet
  // [isLocGroup]). LOC_LABEL_BAND is the strip each box adds above its
  // contents to hold it (in place of the level's top padding — see
  // _layoutLocationGroups); LOC_LABEL_MARGIN_Y drops the label (anchored above
  // the wall by valign top) down into that strip — its bottom edge 26 px
  // below the wall, so a 16 px name has ~6 px clear of the wall. A box is
  // also kept at least as wide as its name (estimated: no renderer in the
  // headless/mobile paths to measure with), so the name never crosses a side
  // wall.
  var LOC_LABEL_BAND = 28;
  // Clear space between the name strip and what sits under it (an inner
  // box's wall or a device icon) — the name is ~8 px off it.
  var LOC_LABEL_GAP = 6;
  var LOC_LABEL_MARGIN_Y = 26;
  var LOC_LABEL_CHAR_PX = 10; // 16 px bold Inter, generous
  // Side/bottom padding of a box with no box nested in it (see
  // _layoutLocationGroups) — enough to keep the wall off the icon and label.
  var LOC_LEAF_PAD = 10;
  function _locLabelMinWidth(label, pad) {
    var t = String(label || "");
    return t ? t.length * LOC_LABEL_CHAR_PX + pad * 2 : 0;
  }

  function locGroupColor(kind, theme) {
    var cfg = LOC_GROUP_KINDS[kind] || LOC_GROUP_KINDS.building;
    return paletteFamily(theme) === "light" ? cfg.colorLight : cfg.color;
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

  // Merge single-child chains. A group whose members are exactly those of a
  // group nested inside it (no device of its own and one child box, at every
  // level down) adds only walls and padding: building › floor › room around
  // one switch drew three boxes ~21× the icon's area. Every such outer group
  // is dropped; the deepest group of the chain stays, named as before, and
  // carries the dropped levels as `absorbed` ([{ kind, name }], outermost
  // first) so its hover can still name the whole path. Nesting that means
  // something — two rooms on one floor, a device straight on the floor — has
  // no identical descendant and is kept. Pure; order kept.
  function collapseLocationChains(groups) {
    var sig = groups.map(function (g) { return g.memberIds.slice().sort().join("\n"); });
    var keepFor = {}; // dropped index → index of the deepest identical descendant
    groups.forEach(function (g, i) {
      var best = -1;
      groups.forEach(function (d, j) {
        if (j === i || sig[j] !== sig[i] || !_isDescendantScope(g.scope, d.scope)) return;
        if (best < 0 || d.scope.length > groups[best].scope.length) best = j;
      });
      if (best >= 0) keepFor[i] = best;
    });
    var rank = function (g) { return (LOC_GROUP_KINDS[g.kind] || LOC_GROUP_KINDS.building).rank; };
    var out = [];
    groups.forEach(function (g, i) {
      if (keepFor[i] !== undefined) return;
      var absorbed = [];
      groups.forEach(function (d, j) { if (keepFor[j] === i) absorbed.push(d); });
      absorbed.sort(function (a, b) { return rank(a) - rank(b); });
      var copy = {};
      Object.keys(g).forEach(function (k) { copy[k] = g[k]; });
      copy.absorbed = absorbed.map(function (d) { return { kind: d.kind, name: d.name }; });
      out.push(copy);
    });
    return out;
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
        // A device's name hangs under its icon; count it DOWNWARD so it
        // never crosses the bottom wall (a room's 18 px padding was shorter
        // than the ~20 px label). Sideways a long name still overflows —
        // counting it would widen every box. 0 headless (no text metrics).
        var lb = coll.boundingBox({ includeLabels: true, includeOverlays: false });
        if (isFinite(lb.y2) && lb.y2 > box.y2) box.y2 = lb.y2;
      }
      var nested = false;
      for (var i = 0; i < fitted.length; i++) {
        var f = fitted[i];
        if (f.rank <= cfg.rank) continue; // only deeper kinds nest inside this one
        if (!_isDescendantScope(scope, f.scope)) continue;
        nested = true;
        box = box === null
          ? { x1: f.box.x1, y1: f.box.y1, x2: f.box.x2, y2: f.box.y2 }
          : { x1: Math.min(box.x1, f.box.x1), y1: Math.min(box.y1, f.box.y1),
              x2: Math.max(box.x2, f.box.x2), y2: Math.max(box.y2, f.box.y2) };
      }
      if (box === null) { cy.remove(n); return; }
      // The name's strip goes on top of the contents (asymmetric: only the
      // top wall moves), and a box narrower than its name widens evenly.
      // A named box's top is its name strip plus LOC_LABEL_GAP — NOT the
      // level's padding too: that stacked a second empty band under every
      // name (42 px under an area's, 26 under a floor's) before the next
      // wall or device. Sides and bottom keep the level's padding.
      // A box with no box inside it hugs its devices (LOC_LEAF_PAD): the
      // per-level padding exists to step nested walls apart, and on a leaf
      // it only inflates the box:asset ratio (a one-switch room was ~4×
      // its icon). Boxes holding boxes keep the level's padding.
      var pad = nested ? cfg.pad : Math.min(cfg.pad, LOC_LEAF_PAD);
      var named = !!n.data("label");
      var topPad = named ? LOC_LABEL_BAND + LOC_LABEL_GAP : pad;
      var w = Math.max((box.x2 - box.x1 + pad * 2) * cfg.scaleW, _locLabelMinWidth(n.data("label"), pad));
      var h = (box.y2 - box.y1 + topPad + pad) * cfg.scaleH;
      var cx = (box.x1 + box.x2) / 2;
      var cyy = ((box.y1 - topPad) + (box.y2 + pad)) / 2;
      n.position({ x: cx, y: cyy });
      n.style({ width: w, height: h });
      fitted.push({
        scope: scope,
        rank: cfg.rank,
        box: { x1: cx - w / 2, y1: cyy - h / 2, x2: cx + w / 2, y2: cyy + h / 2 },
      });
    });
  }

  // Minimum clear space between two shapes at the same nesting level. Sized
  // when the group name rendered ABOVE each shape's top edge; the name now
  // sits inside (LOC_LABEL_BAND), so this is plain spacing.
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
  function _resolveLocGroupOverlaps(cy, fixedIds) {
    fixedIds = fixedIds || {};
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
          // A box holding any device from a saved layout stays where it is:
          // the operator placed those devices, and an overlap is theirs to
          // fix — never shove them (applySavedPositions → fixedIds).
          if (Object.keys(memberIds).some(function (id) { return fixedIds[id]; })) continue;
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
    var groups = computeLocationGroups(cy).filter(function (g) { return !suppress[g.kind]; });
    collapseLocationChains(groups).forEach(function (g) {
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
          locAbsorbed: g.absorbed || [],
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
    // move devices out from under the operator's pointer mid-drag — and
    // never moves a box holding a saved device (opts.fixedIds, from
    // applySavedPositions).
    _resolveLocGroupOverlaps(cy, opts.fixedIds);
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
  // wins. Then, over ALL routed edges at once: the links leaving one box by
  // one exit in one direction (a BUNDLE) share one trunk line; each peels
  // off on its own lane near its target; a different bundle never comes
  // within BUNDLE_GAP of it; and every line touches a device on its own
  // (END_FAN) so it can be hovered there — operator sketch, 2026-11-07. The polyline is rendered with Cytoscape's
  // `segments` curve style (weights/distances projected onto the S→T line);
  // edges the router can't place (missing boxes) keep the taxi fallback.
  var _ROUTE_MARGIN = 26;   // corridor distance outside a box edge
  var _ROUTE_LABEL_PAD = 22; // extra clearance above a box (its floating label)
  var _ROUTE_NODE_PAD = 6;   // clearance a bend keeps from an end device's outline

  // Radius around a device's centre that no routed bend may enter.
  function _nodeClearance(n) {
    return Math.max(n.outerWidth(), n.outerHeight()) / 2 + _ROUTE_NODE_PAD;
  }

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

  // A STRAIGHT link (one no router shaped) whose line passes through another
  // device — two APs meshed across a switch stacked between them in one
  // column — gets two bends that step it sideways around every device on
  // the line, on whichever side is clear (fewer devices hit, then the
  // smaller step). Skipped: operator-drawn paths, cross-box links the
  // router already shaped, fan-out (taxi) links, parallel bundles (their
  // bezier spacing is what separates them) and self-loops. Re-run after
  // every routing pass, so a moved device re-plans it; a link it bent
  // before (data detoured) is straightened first.
  var _DETOUR_GAP = 8;
  function detourStraightEdges(cy) {
    var devices = cy.nodes().filter(function (n) {
      return !n.data("isLocGroup") && !n.data("isEdgeHandle") && !n.isParent();
    }).map(function (n) {
      return { id: n.id(), p: n.position(), r: _nodeClearance(n) };
    });
    cy.edges().forEach(function (e) {
      if (e.data("detoured")) {
        e.removeStyle("curve-style segment-weights segment-distances edge-distances");
        e.removeData("detoured");
      }
      if (e.data("customPath") || e.data("isFanOut") || e.isLoop()) return;
      if (e.data("isInterGroup") && e.style("curve-style") === "segments") return;
      if (e.parallelEdges().length > 1) return;
      var S = e.source().position();
      var T = e.target().position();
      var dx = T.x - S.x, dy = T.y - S.y;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1) return;
      var rS = _nodeClearance(e.source()), rT = _nodeClearance(e.target());
      // Devices the straight line runs through: t along S→T, signed
      // perpendicular offset (positive = right of S→T).
      var hits = [];
      devices.forEach(function (d) {
        if (d.id === e.source().id() || d.id === e.target().id()) return;
        var px = d.p.x - S.x, py = d.p.y - S.y;
        var t = (px * dx + py * dy) / (len * len);
        if (t <= 0 || t >= 1) return;
        var perp = (py * dx - px * dy) / len;
        if (Math.abs(perp) < d.r) hits.push({ t: t, perp: perp, r: d.r });
      });
      if (!hits.length) return;
      // The span to step around, kept clear of both end devices.
      var tLo = 1, tHi = 0;
      hits.forEach(function (h) {
        tLo = Math.min(tLo, h.t - (h.r + _DETOUR_GAP) / len);
        tHi = Math.max(tHi, h.t + (h.r + _DETOUR_GAP) / len);
      });
      tLo = Math.max(tLo, (rS + 2) / len);
      tHi = Math.min(tHi, 1 - (rT + 2) / len);
      if (tHi <= tLo) return; // ends too close together to bend between
      // The step each side needs to clear every device on the line.
      function stepFor(side) {
        var need = 0;
        hits.forEach(function (h) { need = Math.max(need, side * h.perp + h.r + _DETOUR_GAP); });
        return need;
      }
      // Devices the bent path itself would touch, for a side and step.
      function crossingsFor(side, step) {
        var nx = -dy / len * side, ny = dx / len * side; // unit normal, toward `side`
        var a = { x: S.x + dx * tLo + nx * step, y: S.y + dy * tLo + ny * step };
        var b = { x: S.x + dx * tHi + nx * step, y: S.y + dy * tHi + ny * step };
        var segs = [[S, a], [a, b], [b, T]];
        var n = 0;
        devices.forEach(function (d) {
          if (d.id === e.source().id() || d.id === e.target().id()) return;
          segs.forEach(function (s) { if (_segDist(d.p, s[0], s[1]) < d.r) n++; });
        });
        return n;
      }
      var options = [1, -1].map(function (side) {
        var step = stepFor(side);
        return { side: side, step: step, hits: crossingsFor(side, step) };
      });
      options.sort(function (a, b) { return a.hits - b.hits || a.step - b.step; });
      var pick = options[0];
      // Cytoscape's segment-distances are + to the right of S→T, which is
      // the side +1 here (normal (-dy, dx) · screen y-down).
      var dist = (pick.side * pick.step).toFixed(1);
      e.style({
        "curve-style": "segments",
        "segment-weights": tLo.toFixed(4) + " " + tHi.toFixed(4),
        "segment-distances": dist + " " + dist,
        "edge-distances": "node-position",
      });
      e.data("detoured", 1);
    });
  }
  // Distance from point p to segment a–b.
  function _segDist(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var l2 = dx * dx + dy * dy;
    var t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
  }

  function routeInterGroupEdges(cy) {
    var tops = _rectsFor(cy);
    if (tops.length === 0) return;
    var rectById = {};
    // Each device's outermost box, from the box's own member list: after
    // collapseLocationChains it can be any level (a lone room, not its
    // building), so it is never derived from the device's area/building.
    var topOfNode = {};
    tops.forEach(function (t) {
      rectById[t.id] = t.box;
      (cy.getElementById(t.id).data("memberIds") || []).forEach(function (id) { topOfNode[id] = t.id; });
    });
    function hullIdForNode(n) {
      return topOfNode[n.id()] || null;
    }
    // Each device's clearance square (hulls are not devices), measured once.
    var deviceRects = cy.nodes().filter(function (n) {
      return !n.data("isLocGroup") && !n.data("isEdgeHandle") && !n.isParent();
    }).map(function (n) {
      var p = n.position();
      var r = _nodeClearance(n);
      return { id: n.id(), x1: p.x - r, y1: p.y - r, x2: p.x + r, y2: p.y + r };
    });
    var plans = [];
    cy.edges("[isInterGroup]").forEach(function (e) {
      // An operator-drawn path (topology-edge-editor.js) owns its geometry.
      if (e.data("customPath")) return;
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
      // Every OTHER device is an obstacle too — the boxes alone let a run
      // into the target pass straight through a neighbour inside the
      // target's own box (a switch stacked above it in the same column).
      var devices = deviceRects.filter(function (d) { return d.id !== sN.id() && d.id !== tN.id(); });
      var goingRight = T.x >= S.x;
      var srcBox = bs || { x1: S.x, y1: S.y, x2: S.x, y2: S.y };
      var tgtBox = bt || { x1: T.x, y1: T.y, x2: T.x, y2: T.y };
      // No bend may sit inside either end device: Cytoscape cannot find where
      // a segment from inside a node leaves it, marks the edge badLine and
      // silently draws nothing. rS / rT are each device's outer radius + pad.
      var rS = _nodeClearance(sN);
      var rT = _nodeClearance(tN);
      var cx = goingRight
        ? Math.max(srcBox.x2 + _ROUTE_MARGIN, S.x + rS)
        : Math.min(srcBox.x1 - _ROUTE_MARGIN, S.x - rS);
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
      // The run into the target: straight down/up its own column (ax = T.x),
      // or — when a device sits in that column — down a lane just beside it,
      // entering from the side. ±rT + a gap keeps the lane's bend outside
      // the target, and clear of a same-size neighbour above or below it.
      var sideGap = rT + 18;
      var approaches = [T.x, T.x - sideGap, T.x + sideGap];
      var best = null;
      function scoreRoute(segs, len, pref) {
        var boxHits = 0, deviceHits = 0;
        segs.forEach(function (s) {
          obstacles.forEach(function (r) { if (_segIntersectsRect(s[0], s[1], s[2], s[3], r)) boxHits++; });
          devices.forEach(function (r) { if (_segIntersectsRect(s[0], s[1], s[2], s[3], r)) deviceHits++; });
        });
        // A box crossing costs most, a device crossing next; then length,
        // then the stable preference order (corridor, then straight-in).
        return boxHits * 100000 + deviceHits * 50000 + len + pref;
      }
      // Family A — out the source box's SIDE facing the target (cx), along a
      // horizontal corridor, into the target down an approach lane.
      candidates.forEach(function (cy0, idx) {
        approaches.forEach(function (ax, aIdx) {
          var segs = [[cx, S.y, cx, cy0], [cx, cy0, ax, cy0], [ax, cy0, ax, T.y]];
          if (ax !== T.x) segs.push([ax, T.y, T.x, T.y]);
          var len = Math.abs(S.y - cy0) + Math.abs(ax - cx) + Math.abs(T.y - cy0) + Math.abs(T.x - ax);
          var score = scoreRoute(segs, len, idx + aIdx * 0.5);
          if (!best || score < best.score) best = { kind: "side", cy: cy0, ax: ax, score: score };
        });
      });
      // Family B — out the source box's TOP or BOTTOM: straight up / down
      // from the device (or a lane just beside it, when a device sits in its
      // column), then across and in. A target just below a wide box no
      // longer pays a trip out the box's far side and back.
      if (bs) {
        var exLanes = [S.x, S.x - rS - 18, S.x + rS + 18];
        var vCorridors = [
          bs.y2 + _ROUTE_MARGIN,                       // just below the source box
          bs.y1 - _ROUTE_MARGIN - _ROUTE_LABEL_PAD,    // just above it
          T.y,                                         // the target's own row
        ];
        vCorridors.forEach(function (cy0, idx) {
          exLanes.forEach(function (ex, eIdx) {
            approaches.forEach(function (ax, aIdx) {
              var segs = [];
              if (ex !== S.x) segs.push([S.x, S.y, ex, S.y]);
              segs.push([ex, S.y, ex, cy0], [ex, cy0, ax, cy0], [ax, cy0, ax, T.y]);
              if (ax !== T.x) segs.push([ax, T.y, T.x, T.y]);
              var len = Math.abs(ex - S.x) + Math.abs(cy0 - S.y) + Math.abs(ax - ex) + Math.abs(T.y - cy0) + Math.abs(T.x - ax);
              var score = scoreRoute(segs, len, 0.25 + idx + eIdx * 0.5 + aIdx * 0.5);
              if (score < best.score) best = { kind: "vertical", ex: ex, cy: cy0, ax: ax, score: score };
            });
          });
        });
      }
      plans.push({
        e: e, S: S, T: T, rS: rS, rT: rT, best: best,
        trunk: best.kind === "vertical" ? best.ex : cx,
        srcId: sN.id(), tgtId: tN.id(),
        // One bundle = the links leaving one source box by the same exit,
        // heading the same way (up or down): they share one trunk and peel
        // off near their targets (operator sketch). A link from any other
        // box is another bundle and never shares that trunk.
        // A top / bottom exit leaves from the device's own column, so it
        // bundles per device; a side exit leaves by the box's wall.
        bundle: (sHull || sN.id()) + "|" + (best.kind === "vertical" ? "v:" + sN.id() : "side") + "|" + (T.x >= S.x ? "R" : "L") + "|" + (best.cy < S.y ? "U" : "D"),
      });
    });

    // ── Trunks, lanes and separate ends (operator sketch, 2026-11-07) ──
    // Links SHARE a line only in the middle and only when they belong
    // together: one bundle = the links leaving one source box by one exit
    // in one direction. A bundle's links ride one TRUNK (the vertical out of the source
    // box) drawn as a single line; a different bundle that would use the
    // same trunk gets its own, BUNDLE_GAP away — an unrelated line is never
    // stacked onto another. Where a bundle's links turn toward their targets
    // each takes its own LANE: the target nearest the trunk the lane nearest
    // the targets, so branches peel off without crossing. And every line
    // touches a device on its own: links leaving one device fan out of it,
    // links entering one device come in side by side — so each can be
    // hovered right at the icon.
    var BUNDLE_GAP = 22;
    var LANE = 16;
    var END_FAN = 12;
    function spansOverlap(a1, a2, b1, b2) { return Math.min(a1, a2) < Math.max(b1, b2) && Math.min(b1, b2) < Math.max(a1, a2); }
    // Bundles in first-seen order, each with its members.
    var bundleOrder = [];
    var membersOf = {};
    plans.forEach(function (pl) {
      if (!membersOf[pl.bundle]) { membersOf[pl.bundle] = []; bundleOrder.push(pl.bundle); }
      membersOf[pl.bundle].push(pl);
    });
    // Trunks: a bundle's members share its first member's trunk exactly; a
    // bundle whose trunk would come within BUNDLE_GAP of another bundle's
    // (over a shared stretch of height) steps away until it is clear.
    var placedTrunks = [];
    bundleOrder.forEach(function (bundle) {
      var ms = membersOf[bundle];
      var first = ms[0];
      var dir = first.best.kind === "vertical" || first.T.x >= first.S.x ? 1 : -1;
      var y1 = Infinity, y2 = -Infinity;
      ms.forEach(function (pl) {
        y1 = Math.min(y1, pl.S.y, pl.best.cy);
        y2 = Math.max(y2, pl.S.y, pl.best.cy);
      });
      var x = first.trunk;
      for (var guard = 0; guard < 60; guard++) {
        var hit = placedTrunks.some(function (t) { return Math.abs(t.x - x) < BUNDLE_GAP && spansOverlap(y1, y2, t.y1, t.y2); });
        if (!hit) break;
        x += BUNDLE_GAP * dir;
      }
      placedTrunks.push({ x: x, y1: y1, y2: y2 });
      ms.forEach(function (pl) { pl.trunkS = x; });
    });
    // Lanes: inside a bundle, members whose corridors coincide (within 20 px)
    // take their own LANE each — the target nearest the trunk the lane
    // nearest the targets, so branches peel off without crossing. A lane
    // block that would come within BUNDLE_GAP of another bundle's lane (over
    // a shared stretch of width) steps away, block and all.
    var placedLanes = [];
    bundleOrder.forEach(function (bundle) {
      var ms = membersOf[bundle].slice();
      var groups = [];
      ms.forEach(function (pl) {
        var g = groups.filter(function (gg) { return Math.abs(gg.cy - pl.best.cy) < 20; })[0];
        if (!g) { g = { cy: pl.best.cy, members: [] }; groups.push(g); }
        g.members.push(pl);
      });
      groups.forEach(function (g) {
        g.members.sort(function (p1, p2) {
          return Math.abs(p1.T.x - p1.trunkS) - Math.abs(p2.T.x - p2.trunkS) || (p1.tgtId < p2.tgtId ? -1 : p1.tgtId > p2.tgtId ? 1 : 0);
        });
        // Lanes step AWAY from the targets.
        var away = g.members[0].T.y < g.cy ? 1 : -1;
        var shift = 0;
        function lanesAt(sh) {
          return g.members.map(function (pl, k) {
            var ax = pl.best.ax;
            return { y: g.cy + (sh + k * LANE) * away, x1: Math.min(pl.trunkS, ax), x2: Math.max(pl.trunkS, ax) };
          });
        }
        for (var guard = 0; guard < 60; guard++) {
          var mine = lanesAt(shift);
          var hit = mine.some(function (l) {
            return placedLanes.some(function (o) { return Math.abs(o.y - l.y) < BUNDLE_GAP && spansOverlap(l.x1, l.x2, o.x1, o.x2); });
          });
          if (!hit) break;
          shift += BUNDLE_GAP;
        }
        lanesAt(shift).forEach(function (l, k) { g.members[k].cyS = l.y; placedLanes.push(l); });
      });
    });
    // Ends: the k-th link out of / into one device is fanned END_FAN apart.
    function fanOffset(k) { return k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * END_FAN; }
    var outCount = {}, inCount = {};
    plans.forEach(function (pl) {
      var ko = outCount[pl.srcId] || 0; outCount[pl.srcId] = ko + 1;
      var ki = inCount[pl.tgtId] || 0; inCount[pl.tgtId] = ki + 1;
      pl.srcFan = fanOffset(ko);
      pl.tgtFan = fanOffset(ki);
    });

    plans.forEach(function (pl) {
      var e = pl.e, S = pl.S, T = pl.T, rS = pl.rS, rT = pl.rT, best = pl.best;
      var cyPick = best.cy;
      var axPick = best.ax;
      var cxS = pl.trunkS;
      var cyS = pl.cyS;
      // Polyline: drop degenerate bends (e.g. corridor == target row).
      var pts = [];
      if (best.kind !== "vertical" || Math.abs(cxS - S.x) > 0.5) {
        // Out of the source on its own row: a second link from this device
        // leaves END_FAN off it (a short stub out of the icon, then level).
        var sy = S.y + pl.srcFan;
        if (pl.srcFan) pts.push({ x: S.x + (cxS >= S.x ? 1 : -1) * (rS + 10), y: sy });
        pts.push({ x: cxS, y: sy });
      } else if (pl.srcFan) {
        // Straight up / down out of the device: fan sideways instead.
        var dirY = cyS >= S.y ? 1 : -1;
        cxS = S.x + pl.srcFan;
        pts.push({ x: cxS, y: S.y + dirY * (rS + 10) });
      }
      if (Math.abs(cyS - S.y) > 0.5) pts.push({ x: cxS, y: cyS });
      var jog = cyS - T.y;
      if (axPick !== T.x) {
        // Side lane: along the corridor to the lane, down it to the target's
        // row, then straight in from the side.
        pts.push({ x: axPick, y: cyS });
        pts.push({ x: axPick, y: T.y });
      } else if (Math.abs(jog) > 0.5) {
        if (Math.abs(jog) < rT) {
          // A fanned-out run only a few px off the target's row would jog
          // into it INSIDE the device; step back to the target's row just
          // before its outline instead, then run straight in.
          var jx = T.x + (cxS <= T.x ? -rT : rT);
          pts.push({ x: jx, y: cyS });
          pts.push({ x: jx, y: T.y });
        } else if (pl.tgtFan) {
          // A second link into this device comes down beside the first and
          // turns in just outside the icon.
          var ax2 = T.x + pl.tgtFan;
          pts.push({ x: ax2, y: cyS });
          pts.push({ x: ax2, y: T.y + (cyS < T.y ? -1 : 1) * (rT + 10) });
        } else {
          pts.push({ x: T.x, y: cyS });
        }
      }
      // Last resort (a corridor that happens to cross an end device): drop the
      // bend rather than lose the whole line.
      pts = pts.filter(function (p) {
        return Math.hypot(p.x - S.x, p.y - S.y) >= rS && Math.hypot(p.x - T.x, p.y - T.y) >= rT;
      });
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
    // Levels merged into a box (collapseLocationChains) are named too.
    function addAbsorbed(g) {
      (g.data("locAbsorbed") || []).forEach(function (a) {
        var aRank = (LOC_GROUP_KINDS[a.kind] || LOC_GROUP_KINDS.building).rank;
        parts.push({ kind: a.kind, name: a.name || "", color: locGroupColor(a.kind), rank: aRank });
      });
    }
    cy.nodes("[isLocGroup]").forEach(function (g) {
      if (g.id() === hull.id()) return;
      var gKind = g.data("locKind");
      var gRank = (LOC_GROUP_KINDS[gKind] || LOC_GROUP_KINDS.building).rank;
      if (gRank >= rank) return;
      if (!_isDescendantScope(g.data("locScope") || [], scope)) return;
      parts.push({ kind: gKind, name: g.data("label") || "", color: locGroupColor(gKind), rank: gRank });
      addAbsorbed(g);
    });
    addAbsorbed(hull);
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

  // The drill-down levels, outermost first. A view key is the level's prefix
  // plus the device's segments down to that level, a missing level an empty
  // segment — the same keys computeLocationGroups gives its boxes:
  // area "a|<a>", building "b|<a>|<b>", floor "f|<a>|<b>|<f>",
  // room "r|<a>|<b>|<f>|<r>", junction box "jb|<a>|<b>|<f>|<r>|<jb>".
  var VIEW_LEVELS = [
    { kind: "area", prefix: "a", field: "locA" },
    { kind: "building", prefix: "b", field: "locB" },
    { kind: "floor", prefix: "f", field: "locF" },
    { kind: "room", prefix: "r", field: "locR" },
    { kind: "jb", prefix: "jb", field: "locJb" },
  ];
  var VIEW_LEVEL_BY_PREFIX = {};
  var VIEW_LEVEL_BY_KIND = {};
  VIEW_LEVELS.forEach(function (lv, i) { VIEW_LEVEL_BY_PREFIX[lv.prefix] = i; VIEW_LEVEL_BY_KIND[lv.kind] = i; });

  // The level index a view key belongs to ("flat" / unknown → -1).
  function _viewLevelOf(key) {
    var s = String(key || "");
    var p = s.slice(0, s.indexOf("|"));
    return VIEW_LEVEL_BY_PREFIX[p] != null ? VIEW_LEVEL_BY_PREFIX[p] : -1;
  }

  // A node's view key at level i, or "" when it carries no code there.
  function _viewKeyAt(d, i) {
    if (!d[VIEW_LEVELS[i].field]) return "";
    var segs = [];
    for (var j = 0; j <= i; j++) segs.push(d[VIEW_LEVELS[j].field] || "");
    return VIEW_LEVELS[i].prefix + "|" + segs.join("|");
  }
  // The name a level shows on its chip. A floor with no building says so
  // ("Floor 2"): a bare "2" next to building names would be cryptic.
  function _viewSegName(d, i) {
    var lv = VIEW_LEVELS[i];
    var name = d[lv.field + "Name"] || d[lv.field];
    return lv.kind === "floor" && !d.locB ? "Floor " + name : name;
  }
  // Full label: every level the node HAS, down to i — "Mine — Shop — 2",
  // "Shop — 1", "Floor 2", "Mine — North Closet" (a room straight in an area).
  function _viewLabelAt(d, i) {
    var parts = [];
    for (var j = 0; j <= i; j++) if (d[VIEW_LEVELS[j].field]) parts.push(_viewSegName(d, j));
    return parts.join(" — ");
  }

  // Enumerate the location views present in a built element set: one view
  // per BUILDING, FLOOR, ROOM and JUNCTION BOX any device names, and one per
  // AREA that holds a deeper code (an a: code on its own never earns one:
  // the area box already says it on Base). A device that skips a level hangs
  // its next level straight under the one above it — a room tagged a:Mine
  // r:North is a child of the Mine view, not of a building. Returns a flat
  // array of
  //   { key, kind, depth (level index), parentKey, ancestors (keys, outer
  //     first), name (chip text), label (full path), areaKey, buildingKey,
  //     areaName, buildingName, floorName? }
  // in display order: a view ahead of what is inside it; at the area level
  // the area-less ones first, below it the un-coded bucket last; floors
  // underground-aware, everything else by name. Empty array when no node
  // carries a code below area → callers render no switcher.
  function computeFloorViews(elements) {
    var byKey = {};
    var out = [];
    (elements || []).forEach(function (el) {
      var d = el && el.data;
      if (!d || !d.id || d.source) return;
      var deepest = -1;
      VIEW_LEVELS.forEach(function (lv, i) { if (d[lv.field]) deepest = i; });
      if (deepest < 1) return; // nothing, or an area alone
      var ancestors = [];
      for (var i = 0; i <= deepest; i++) {
        var key = _viewKeyAt(d, i);
        if (!key) continue;
        if (!byKey[key]) {
          var v = {
            key: key,
            kind: VIEW_LEVELS[i].kind,
            depth: i,
            parentKey: ancestors.length ? ancestors[ancestors.length - 1] : null,
            ancestors: ancestors.slice(),
            name: _viewSegName(d, i),
            label: _viewLabelAt(d, i),
            areaKey: d.locA || "",
            buildingKey: i >= 1 ? d.locB || "" : "",
            areaName: d.locAName || "",
            buildingName: i >= 1 ? d.locBName || "" : "",
            // sort keys: each level's display name ("" = level skipped)
            _segs: VIEW_LEVELS.slice(0, i + 1).map(function (lv) { return d[lv.field] ? d[lv.field + "Name"] || d[lv.field] : ""; }),
          };
          if (i === 2) v.floorName = d.locFName || d.locF;
          byKey[key] = v;
          out.push(v);
        }
        ancestors.push(key);
      }
    });
    out.sort(function (x, y) {
      for (var i = 0; i < VIEW_LEVELS.length; i++) {
        var xEnd = i >= x._segs.length, yEnd = i >= y._segs.length;
        if (xEnd && yEnd) return 0;
        if (xEnd) return -1; // a view ahead of what is inside it
        if (yEnd) return 1;
        var a = x._segs[i], b = y._segs[i];
        if (a === b) continue;
        // area-less first at the area level; a skipped level last below it
        if (!a) return i === 0 ? -1 : 1;
        if (!b) return i === 0 ? 1 : -1;
        var c = VIEW_LEVELS[i].kind === "floor" ? compareFloors(a, b) : String(a).localeCompare(String(b));
        if (c) return c;
      }
      return 0;
    });
    out.forEach(function (v) { delete v._segs; });
    return out;
  }

  // The location-view switcher's rows, as data: an array of rows (index =
  // depth), each an array of { key, label, title, active } chips.
  //   row 0  "Base" alone (view key "flat" — saved layouts are filed under it)
  //   row 1  the top level: every view with no parent among `views` (areas,
  //          plus any building, floor, room or junction box with no area)
  //   then   for each view on the selected path, the views directly inside
  //          it — the NEXT level each device has, whatever it is: an area's
  //          buildings AND any room tagged in the area with no building
  // Every chip on the selected path is active. `views` is computeFloorViews'
  // output (already in display order), or a subset of it — a parent missing
  // from the subset makes its children top-level (the widget's pinned views).
  function viewSwitcherRows(views, activeKey) {
    var list = views || [];
    var byKey = {};
    list.forEach(function (v) { byKey[v.key] = v; });
    function parentOf(v) {
      var anc = v.ancestors || [];
      for (var i = anc.length - 1; i >= 0; i--) if (byKey[anc[i]]) return anc[i];
      return null;
    }
    var children = {};
    var roots = [];
    list.forEach(function (v) {
      var p = parentOf(v);
      if (p) (children[p] = children[p] || []).push(v);
      else roots.push(v);
    });
    var path = [];
    var cur = byKey[activeKey] || null;
    while (cur) { path.unshift(cur); var pk = parentOf(cur); cur = pk ? byKey[pk] : null; }
    var onPath = {};
    path.forEach(function (v) { onPath[v.key] = true; });
    function chip(v) {
      return { key: v.key, label: v.name || v.label, title: "Show " + v.label, active: !!onPath[v.key] };
    }
    var rows = [[{ key: "flat", label: "Base", title: "Whole site", active: activeKey === "flat" || !path.length }]];
    // Top row: areas first, then whatever has no area (each in list order).
    roots = roots.filter(function (v) { return v.depth === 0; })
      .concat(roots.filter(function (v) { return v.depth !== 0; }));
    if (roots.length) rows.push(roots.map(chip));
    path.forEach(function (v) {
      if (children[v.key]) rows.push(children[v.key].map(chip));
    });
    return rows;
  }

  // Which box levels a view hides: the view itself IS its level and every
  // level above it, so only the deeper boxes stay useful. Null for Base.
  function viewSuppressKinds(key) {
    var lvl = _viewLevelOf(key);
    if (lvl < 0) return null;
    return VIEW_LEVELS.slice(0, lvl + 1).map(function (lv) { return lv.kind; });
  }

  // The view key + label a node belongs to at `kind`'s level, or null when it
  // carries no code at that level.
  function _nodeViewRef(d, kind) {
    var i = VIEW_LEVEL_BY_KIND[kind];
    var key = i == null ? "" : _viewKeyAt(d, i);
    return key ? { key: key, label: _viewLabelAt(d, i) } : null;
  }

  // The group a device outside the view is shown as: its group at the
  // view's own level, else its nearest coded group above it (closest first),
  // else below it (shallowest first), else the untagged rest of the site —
  // Base.
  function _groupRefFor(d, kind) {
    var lvl = VIEW_LEVEL_BY_KIND[kind];
    var order = [lvl];
    for (var up = lvl - 1; up >= 0; up--) order.push(up);
    for (var down = lvl + 1; down < VIEW_LEVELS.length; down++) order.push(down);
    for (var i = 0; i < order.length; i++) {
      var ref = _nodeViewRef(d, VIEW_LEVELS[order[i]].kind);
      if (ref) return ref;
    }
    return { key: "flat", label: "Base" };
  }

  // Partition a built element set down to one view — a floor view
  // ("f|a|b|f": that floor's tagged devices), a building view ("b|a|b":
  // ALL of that building's tagged devices, any floor) or an area view
  // ("a|a": every device tagged with that area, any building). The FortiGate
  // is drawn only in Base and in the views its own codes put it in; in
  // another view it appears as a dashed ROOT portal ("→ Base: FG",
  // isRootPortal) ONLY when a device in that view links to it directly — a
  // stub with no such link read as if the view's switches hung straight off
  // the firewall (operator report, 2026-11-07). Members with any link out of
  // the view are marked `viewEntry`; a view with no FortiGate is rooted on
  // them by the column solver. Untagged devices appear only in the Flat
  // view. Edges with both ends in view are kept as-is (loop flags preserved
  // — a physical ring is still a ring even when the view splits it); an edge
  // whose far end carries the same-level code for ANOTHER view is rewired to
  // a dashed "portal" stub named for the remote device + its view (one
  // portal per remote device — parallel links converge), carrying targetView
  // for tap-to-jump; an edge to an untagged device is dropped (no dead-end
  // stubs).
  function partitionElementsForFloor(elements, viewKey) {
    var key = String(viewKey || "");
    var kind = (VIEW_LEVELS[_viewLevelOf(key)] || VIEW_LEVELS[2]).kind;
    var nodeById = {};
    var inView = {};
    // True members (as opposed to a FortiGate standing in as a root portal).
    var trueMember = {};
    // FortiGates tagged outside this view → their root portal id.
    var rootPortalFor = {};
    var outsideFg = {};
    (elements || []).forEach(function (el) {
      var d = el && el.data;
      if (!d || !d.id || d.source) return;
      nodeById[d.id] = d;
      var ref = _nodeViewRef(d, kind);
      if (ref && ref.key === key) {
        inView[d.id] = true;
        trueMember[d.id] = true;
      } else if (d.role === "fortigate") {
        outsideFg[d.id] = true;
      }
    });
    // Which out-of-view FortiGates a member links to (they get a root
    // portal), and which members link out of the view at all (entries).
    var viewEntry = {};
    (elements || []).forEach(function (el) {
      var d = el && el.data;
      if (!d || !d.source || !d.target) return;
      var sm = !!trueMember[d.source], tm = !!trueMember[d.target];
      if (sm === tm) return;
      var member = sm ? d.source : d.target;
      var other = sm ? d.target : d.source;
      viewEntry[member] = true;
      if (outsideFg[other] && !rootPortalFor[other]) {
        inView[other] = true;
        rootPortalFor[other] = "portal:" + other;
      }
    });
    var out = [];
    (elements || []).forEach(function (el) {
      var d = el && el.data;
      if (!d || !d.id || d.source) return;
      if (!inView[d.id]) return;
      if (rootPortalFor[d.id]) {
        var home = _nodeViewRef(d, kind);
        out.push({
          data: {
            id: rootPortalFor[d.id],
            isPortal: 1,
            isRootPortal: 1,
            label: "→ " + (home ? home.label : "Base") + ": " + (d.label || d.id),
            targetView: home ? home.key : "flat",
            remoteAssetId: d.id,
          },
        });
        return;
      }
      var copy = Object.assign({}, d);
      if (viewEntry[d.id]) copy.viewEntry = 1;
      out.push({ data: copy });
    });
    var groupPortals = {};
    var portalOrder = [];
    // Network depth on the WHOLE site decides which neighbouring groups are
    // upstream (shallower than the member they link to) and which downstream.
    var siteCols = computeTopologyColumns(elements) || {};
    function depthOf(id) { return siteCols[id] ? Math.abs(siteCols[id].depth) : Infinity; }
    (elements || []).forEach(function (el) {
      var d = el && el.data;
      if (!d || !d.source || !d.target) return;
      var srcIn = !!inView[d.source];
      var tgtIn = !!inView[d.target];
      if (!srcIn && !tgtIn) return;
      if (srcIn && tgtIn) {
        var srcRoot = rootPortalFor[d.source];
        var tgtRoot = rootPortalFor[d.target];
        // A member's link to an out-of-view FortiGate lands on its root
        // portal; FortiGate-to-FortiGate links have no member end — dropped.
        if (srcRoot && tgtRoot) return;
        var kept = Object.assign({}, d);
        if (srcRoot || tgtRoot) {
          kept.id = "portal-" + kept.id;
          if (srcRoot) kept.source = srcRoot;
          else kept.target = tgtRoot;
        }
        out.push({ data: kept });
        return;
      }
      var localId = srcIn ? d.source : d.target;
      if (!trueMember[localId]) return; // root portal — links only to members
      // The FortiGate's controller links reach every view, so stubbing them
      // from the FortiGate's own view would just spray "→ elsewhere" noise.
      if (nodeById[localId].role === "fortigate") return;
      var remoteId = srcIn ? d.target : d.source;
      var remote = nodeById[remoteId];
      if (!remote) return;
      // One stub per neighbouring GROUP (operator, 2026-11-07: "each group
      // should connect back to the group of the previous level and next
      // level"): the far end's group at this view's level, else its nearest
      // coded group at any level (an area view reaches a building with no
      // area — Scale House), else the untagged rest of the site ("Base").
      var g = _groupRefFor(remote, kind);
      var portalId = "portal:group:" + g.key;
      var up = depthOf(remoteId) < depthOf(localId);
      var portal = groupPortals[portalId];
      if (!portal) {
        portal = groupPortals[portalId] = { id: portalId, label: g.label, key: g.key, up: false };
        portalOrder.push(portal);
      }
      // A group the view's uplinks come from is the PREVIOUS level, even when
      // it also hangs something off this one.
      if (up) portal.up = true;
      var e = Object.assign({}, d);
      e.id = "portal-" + e.id;
      if (srcIn) e.target = portalId;
      else e.source = portalId;
      out.push({ data: e });
    });
    portalOrder.forEach(function (p) {
      out.push({
        data: {
          id: p.id,
          isPortal: 1,
          // ← the group this view is fed from; → a group it feeds.
          isUpstreamPortal: p.up ? 1 : undefined,
          label: (p.up ? "← " : "→ ") + p.label,
          targetView: p.key,
        },
      });
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

  // ── Labels on bent links ───────────────────────────────────────────────
  // Cytoscape centres an edge label on the path's midpoint, which on a taxi
  // or routed (segments) link lands on a middle leg far from both devices.
  // Operator rules (2026-10-16):
  //   • ONE bend → the port label sits halfway along the second leg (the leg
  //     into the target);
  //   • two or more bends → halfway along the FIRST leg and again halfway
  //     along the LAST leg, so each end's ports read next to that end;
  //   • never on a stretch where several links run together — a label there
  //     can't say which line it belongs to. The label moves to the middle of
  //     the longest part of its leg no other link shares; a leg shared end
  //     to end hands the label to the next leg inward; a link with nothing
  //     unshared shows no label.
  // Straight links keep the midpoint unless the midpoint is on a shared
  // stretch. Curved (bezier with control points — parallel links between one
  // pair) are left alone: they bow apart, so they never run together.
  // Done with per-edge bypasses: text-margin-x/y shift the main label from
  // the midpoint (Cytoscape adds the margin BEFORE rotating, about the shifted
  // point) and text-rotation lays it along its leg (autorotate would follow
  // the midpoint's leg); the second copy is a target-label offset along the
  // path back from the target, given its own leg's angle the same way (an
  // end label's autorotate ALSO follows the midpoint's leg, not its own). A
  // hidden label is `label: ""`.
  // The PDF / Visio export reads the shifted main label (it applies
  // text-margin) and prints it horizontally; it does not draw target-label
  // copies.
  var BENT_LABEL_PROPS = "label text-margin-x text-margin-y text-rotation target-label target-text-offset target-text-rotation";
  var SHARED_TOL = 3;       // px: lines this close and parallel read as one
  var MIN_LABEL_RUN = 24;   // px: shortest unshared stretch a label is put on

  // The drawn path of an edge as merged points: repeated points dropped and
  // collinear runs merged (a taxi edge whose turn lands on an endpoint
  // reports a zero-length leg, which is no bend). Null for a path we can't
  // read or don't place (curved beziers).
  function _edgePolyline(e) {
    var src = e.sourceEndpoint(), tgt = e.targetEndpoint();
    if (!src || !tgt || !isFinite(src.x) || !isFinite(tgt.x)) return null;
    var cs = e.style("curve-style");
    var seg = [];
    if (cs === "taxi" || cs === "segments") {
      seg = e.segmentPoints ? (e.segmentPoints() || []) : [];
    } else if (cs === "bezier" || cs === "unbundled-bezier") {
      var ctrl = e.controlPoints ? e.controlPoints() : null;
      if (ctrl && ctrl.length) return null;
    } else if (cs !== "straight") {
      return null;
    }
    var pts = [];
    [src].concat(seg, [tgt]).forEach(function (p) {
      if (!p || !isFinite(p.x) || !isFinite(p.y)) return;
      var last = pts[pts.length - 1];
      if (last && Math.abs(last.x - p.x) < 0.5 && Math.abs(last.y - p.y) < 0.5) return;
      if (pts.length >= 2) {
        var a = pts[pts.length - 2];
        var cross = (last.x - a.x) * (p.y - a.y) - (last.y - a.y) * (p.x - a.x);
        if (Math.abs(cross) < 0.5) { pts[pts.length - 1] = p; return; }
      }
      pts.push(p);
    });
    return pts.length >= 2 ? pts : null;
  }
  function _legsOf(pts) {
    var legs = [];
    for (var i = 0; i + 1 < pts.length; i++) {
      var dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y;
      var len = Math.sqrt(dx * dx + dy * dy);
      var axis = Math.abs(dy) < 0.5 ? "h" : (Math.abs(dx) < 0.5 ? "v" : null);
      legs.push({ a: pts[i], b: pts[i + 1], len: len, dx: dx, dy: dy, axis: axis });
    }
    return legs;
  }
  // Leg angle normalised to (-90°, 90°] so text never reads upside down.
  function _readableAngle(dx, dy) {
    var ang = Math.atan2(dy, dx);
    if (ang > Math.PI / 2) ang -= Math.PI;
    else if (ang <= -Math.PI / 2) ang += Math.PI;
    return ang;
  }
  // Index every axis-aligned leg by its line (y for horizontal, x for
  // vertical) in SHARED_TOL buckets, so finding the legs that run along one
  // is a few bucket reads instead of a pass over every edge — this runs once
  // per animation frame while a node is dragged. Diagonal legs are not
  // indexed: two diagonals almost never coincide in this layout.
  function _legIndex(paths) {
    var idx = { h: {}, v: {} };
    paths.forEach(function (p) {
      p.legs.forEach(function (l) {
        if (!l.axis) return;
        var line = l.axis === "h" ? l.a.y : l.a.x;
        var lo = l.axis === "h" ? Math.min(l.a.x, l.b.x) : Math.min(l.a.y, l.b.y);
        var hi = l.axis === "h" ? Math.max(l.a.x, l.b.x) : Math.max(l.a.y, l.b.y);
        var k = Math.round(line / SHARED_TOL);
        (idx[l.axis][k] = idx[l.axis][k] || []).push({ id: p.id, line: line, lo: lo, hi: hi });
      });
    });
    return idx;
  }
  // The longest stretch of `leg` no OTHER edge runs along, as [t0, t1]
  // distances from leg.a, or null when none is MIN_LABEL_RUN long.
  function _freeRun(leg, id, idx) {
    if (leg.len < MIN_LABEL_RUN) return null;
    if (!leg.axis) return [0, leg.len];
    var line = leg.axis === "h" ? leg.a.y : leg.a.x;
    var start = leg.axis === "h" ? leg.a.x : leg.a.y;
    var dir = (leg.axis === "h" ? leg.dx : leg.dy) >= 0 ? 1 : -1;
    var k = Math.round(line / SHARED_TOL);
    var cover = [];
    for (var b = k - 1; b <= k + 1; b++) {
      (idx[leg.axis][b] || []).forEach(function (o) {
        if (o.id === id || Math.abs(o.line - line) > SHARED_TOL) return;
        // Into this leg's own distance coordinates.
        var t0 = (o.lo - start) * dir, t1 = (o.hi - start) * dir;
        var lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(leg.len, Math.max(t0, t1));
        if (hi > lo) cover.push([lo, hi]);
      });
    }
    cover.sort(function (x, y) { return x[0] - y[0]; });
    var best = null, at = 0;
    function consider(lo, hi) {
      if (hi - lo >= MIN_LABEL_RUN && (!best || hi - lo > best[1] - best[0])) best = [lo, hi];
    }
    cover.forEach(function (c) {
      if (c[0] > at) consider(at, c[0]);
      if (c[1] > at) at = c[1];
    });
    consider(at, leg.len);
    return best;
  }
  // First leg, in `order`, with a free run → { leg index, point, distance
  // along the leg }; null when every candidate is shared.
  function _placeOn(legs, order, id, idx, skip) {
    for (var i = 0; i < order.length; i++) {
      var li = order[i];
      if (li === skip) continue;
      var run = _freeRun(legs[li], id, idx);
      if (!run) continue;
      var t = (run[0] + run[1]) / 2;
      var l = legs[li];
      var f = l.len ? t / l.len : 0;
      return { li: li, t: t, x: l.a.x + l.dx * f, y: l.a.y + l.dy * f };
    }
    return null;
  }
  function refreshBentEdgeLabels(cy) {
    if (!cy || typeof cy.edges !== "function") return;
    var paths = [];
    cy.edges().forEach(function (e) {
      if (e.visible && !e.visible()) return;
      var pts = _edgePolyline(e);
      paths.push({ e: e, id: e.id ? e.id() : e, pts: pts, legs: pts ? _legsOf(pts) : [] });
    });
    var idx = _legIndex(paths);
    cy.batch(function () {
      paths.forEach(function (p) {
        var e = p.e;
        var text = e.data("label");
        var legs = p.legs;
        var place = null;
        var copy = null;
        var n = legs.length;
        if (text && n === 1) {
          // Straight: Cytoscape's own midpoint (no bypass), unless it is shared.
          var run = _freeRun(legs[0], p.id, idx);
          var mid = legs[0].len / 2;
          if (!run) place = { hidden: true };
          else if (mid < run[0] || mid > run[1]) place = _placeOn(legs, [0], p.id, idx);
        } else if (text && n > 1) {
          var inward = [], outward = [];
          for (var i = 0; i < n; i++) { inward.push(i); outward.push(n - 1 - i); }
          if (n === 2) {
            place = _placeOn(legs, [1, 0], p.id, idx);
          } else {
            place = _placeOn(legs, inward, p.id, idx);
            copy = _placeOn(legs, outward, p.id, idx, place ? place.li : -1);
            // Never two labels on one leg, nor the copy before the main one.
            if (copy && place && copy.li <= place.li) copy = null;
            if (!place && copy) { place = copy; copy = null; }
          }
          if (!place) place = { hidden: true };
        }
        if (!place) {
          if (e.data("_bentLabel")) { e.removeStyle(BENT_LABEL_PROPS); e.data("_bentLabel", 0); }
          return;
        }
        // `_bentLabel` holds a signature of what was last applied, so an
        // unchanged edge is not re-styled — during a drag only the moved
        // node's links change, and re-styling every edge every frame would
        // re-render the whole graph.
        if (place.hidden) {
          if (e.data("_bentLabel") === "hidden") return;
          e.style({ label: "", "target-label": "" });
          e.data("_bentLabel", "hidden");
          return;
        }
        var mp = e.midpoint();
        var L = legs[place.li];
        var style = {
          label: text,
          "text-margin-x": place.x - mp.x,
          "text-margin-y": place.y - mp.y,
          "text-rotation": _readableAngle(L.dx, L.dy),
          "target-label": "",
        };
        if (copy) {
          // target-text-offset is measured along the path from the target.
          var back = legs[copy.li].len - copy.t;
          for (var j = copy.li + 1; j < legs.length; j++) back += legs[j].len;
          style["target-label"] = text;
          style["target-text-offset"] = back;
          // An explicit angle, never "autorotate": Cytoscape resolves an end
          // label's autorotate to the MAIN label's auto angle (the leg at the
          // path midpoint — calculateLabelAngle returns labelAutoAngle for
          // any prefix), so on a bent line the copy was drawn turned to some
          // other leg instead of lying along its own.
          style["target-text-rotation"] = _readableAngle(legs[copy.li].dx, legs[copy.li].dy);
        }
        var sig = [text, style["text-margin-x"], style["text-margin-y"], style["text-rotation"],
          style["target-label"], style["target-text-offset"], style["target-text-rotation"]]
          .map(function (v) { return typeof v === "number" ? v.toFixed(1) : String(v); }).join("|");
        if (e.data("_bentLabel") === sig) return;
        e.style(style);
        e.data("_bentLabel", sig);
      });
    });
  }
  // Keeps the labels on their legs as the graph moves: after any layout
  // (dagre is async) and on node position changes, coalesced to one pass per
  // frame — a drag fires position events per pointer move, and a preset
  // layout's position events land after markFanOutEdges has stamped the
  // taxi geometry. Callers that change edge GEOMETRY by style alone
  // (curve-style bypasses, no node moving) call refreshBentEdgeLabels
  // themselves; the exported routeInterGroupEdges already does.
  function wireBentEdgeLabels(cy) {
    if (!cy || cy.__bentLabelsWired) return;
    cy.__bentLabelsWired = true;
    var pending = false;
    var raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : function (f) { return setTimeout(f, 16); };
    function schedule() {
      if (pending) return;
      pending = true;
      raf(function () {
        pending = false;
        if (cy.destroyed && cy.destroyed()) return;
        refreshBentEdgeLabels(cy);
      });
    }
    cy.on("layoutstop", schedule);
    cy.on("position", "node", schedule);
    schedule();
  }

  // ── Fan-out edge model ─────────────────────────────────────────────────
  // An edge between two positioned nodes in DIFFERENT columns (two or more
  // apart) AND different rows is drawn orthogonally, not as a diagonal: it
  // leaves the SHALLOWER endpoint (nearer the firewall — smaller |depth|)
  // along that endpoint's own row, turns in the gutter HALF a column toward
  // the deeper endpoint (nothing ever sits on a half column), and runs along
  // the DEEPER endpoint's row the rest of the way — an L hugging the shallow
  // end. The turn is that close so the edge never shares the shallow row
  // with the switch's straight spine link: at 1.5 columns both links ran
  // together out of the same side of the switch and read as one cable. The
  // spine's port label now sits clear to the right of the L, and this
  // edge's own label lands on its vertical leg (Cytoscape centres a taxi
  // label on the middle segment). The deep-row run crosses the leaf column
  // at the deep row; the leaf pass dodges it (edgeLaneAt), and the anchor
  // footprint reserves the corridor cells past the leaf column when the
  // endpoints are four or more columns apart. markFanOutEdges stamps the
  // matching taxi geometry onto the rendered edges, so a switch's links to
  // its child switches never slice diagonally through the AP column. Same-
  // row edges are straight lines either way and adjacent-column edges cross
  // no column, so neither is a fan-out edge.
  var FAN_OUT_TURN_COLS = 0.5;
  function isFanOutGeometry(aDepth, aLane, bDepth, bLane) {
    return Math.abs(aDepth - bDepth) >= 2 && aLane !== bLane;
  }
  // True when endpoint A is the shallow end (ties → A, so an edge stored
  // parent → child keeps the parent as the shallow end).
  function fanOutShallowFirst(aDepth, bDepth) {
    return Math.abs(aDepth) <= Math.abs(bDepth);
  }
  // The row a fan-out edge occupies where it crosses integer column `col`,
  // or null when it doesn't strictly pass through that column. The turn is
  // before the first integer column, so every column crossed is on the deep
  // row.
  function fanOutLaneAt(shallowDepth, shallowLane, deepDepth, deepLane, col) {
    var lo = Math.min(shallowDepth, deepDepth);
    var hi = Math.max(shallowDepth, deepDepth);
    if (col <= lo || col >= hi) return null;
    return deepLane;
  }
  // Integer columns the deep-row run crosses past the shallow end's leaf
  // column (the leaf pass dodges that one instead) — empty when the
  // endpoints are two apart.
  function fanOutCorridorCols(shallowDepth, deepDepth) {
    var step = deepDepth > shallowDepth ? 1 : -1;
    var cols = [];
    for (var c = shallowDepth + 2 * step; c !== deepDepth; c += step) cols.push(c);
    return cols;
  }
  // Stamp the fan-out taxi geometry onto a Cytoscape instance's edges from
  // the solver's { id: { depth, lane } } grid. `colSpacing` is the caller's
  // px per column and `orientation` which screen axis depth maps to —
  // "horizontal" (desktop: depth → x) or "vertical" (phone: depth → y). The
  // turn is signed so it is always measured from the SHALLOW end: positive
  // px from the source when the source is shallow, negative (Cytoscape's
  // "from the target" form) otherwise. Cross-group edges keep their own
  // routing (markInterGroupEdges / routeInterGroupEdges) and are skipped;
  // every other edge is re-stamped so a re-layout can clear a stale flag.
  function markFanOutEdges(cy, columns, opts) {
    if (!cy || !columns) return;
    var spacing = (opts && opts.colSpacing) || 0;
    var orientation = (opts && opts.orientation) === "vertical" ? "vertical" : "horizontal";
    cy.edges().forEach(function (e) {
      if (e.data("isInterGroup")) return;
      var s = columns[e.data("source")];
      var t = columns[e.data("target")];
      if (!s || !t || !isFanOutGeometry(s.depth, s.lane, t.depth, t.lane)) {
        if (e.data("isFanOut")) e.data({ isFanOut: 0 });
        return;
      }
      var sourceShallow = fanOutShallowFirst(s.depth, t.depth);
      var turn = FAN_OUT_TURN_COLS * spacing * (sourceShallow ? 1 : -1);
      e.data({ isFanOut: 1, fanOutDir: orientation, fanOutTurn: turn });
    });
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
    var rootPortalId = null;
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
      // A root portal stands in for the FortiGate, so it is placed as one.
      roleById[d.id] = d.isRootPortal ? "fortigate" : d.role || null;
      nodeIds.push(d.id);
      adj[d.id] = adj[d.id] || [];
      if (d.locA) locAById[d.id] = d.locA;
      if (d.locB) locBById[d.id] = d.locB;
      if (d.locF) locFById[d.id] = d.locF;
      if (d.locR) locRById[d.id] = d.locR;
      if (d.locJb) locJbById[d.id] = d.locJb;
      if (d.role === "fortigate" && !rootId) rootId = d.id;
      // A location view whose FortiGate lives elsewhere roots on its stub.
      if (d.isRootPortal && !rootPortalId) rootPortalId = d.id;
    });
    if (!rootId) rootId = rootPortalId;
    // A location view whose members never link to the FortiGate has no root
    // portal (a stub there implied a direct link that does not exist): it is
    // rooted on an invisible anchor joined to the members that link out of
    // the view (viewEntry), and the anchor is left out of the result.
    var VIEW_ANCHOR = "__view_anchor__";
    var viewEntries = [];
    var hasRealFg = elements.some(function (el) { return el && el.data && !el.data.source && el.data.role === "fortigate"; });
    if (!hasRealFg) {
      // A location view: every stub for a group it is FED from (and a direct
      // FortiGate stub) goes in the first column, rooted together; with no
      // such stub, the members that link out of the view are the roots.
      var stubs = [];
      elements.forEach(function (el) {
        var d = el && el.data;
        if (d && d.id && !d.source && (d.isUpstreamPortal || d.isRootPortal)) stubs.push(d.id);
      });
      if (stubs.length > 1 || (stubs.length === 1 && !rootPortalId)) {
        viewEntries = stubs;
      } else if (!stubs.length) {
        elements.forEach(function (el) {
          var d = el && el.data;
          if (d && d.id && !d.source && d.viewEntry) viewEntries.push(d.id);
        });
      }
      if (viewEntries.length) {
        rootId = VIEW_ANCHOR;
        roleById[rootId] = "fortigate";
        nodeIds.push(rootId);
        adj[rootId] = [];
      }
    }
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
      // edge from an infra node (FG/switch) INTO the leaf. Only the
      // leaf-as-TARGET direction is bogus — the payload draws uplinks
      // parent → child, and buildTopologyElements drops the same edge by
      // the same test. An edge the leaf is the SOURCE of is its own
      // downstream link (a bridged switch's wired FortiAP, a switch chained
      // behind it) and must stay: dropping those too left every AP behind a
      // bridged switch with no path to the firewall, so they fell into the
      // orphan column and the stray rows at the bottom of the canvas, a
      // dozen rows away from the switch they hang off.
      if (!d.isMesh && !d.isBridge) {
        if (meshLeaf[d.target] && TOPOLOGY_INFRA_ROLES[roleById[d.source]]) return;
      }
      adj[d.source].push(d.target);
      adj[d.target].push(d.source);
      // Physical proof of a real link: interface-inferred, LLDP, a
      // controller edge flagged verifiedUplink (the FG↔switch interface edge
      // deduped into it), AND the mesh / bridge edges — a mesh backhaul is
      // the controller naming the leaf's parent AP outright and a bridge is
      // an LLDP-detected cable on the AP's LAN port, so both are confirmed
      // links whose downstream side is placed via the AP. Letting
      // verification flow through them keeps a switch chained behind a
      // bridged switch in the verified tree; before, its only path ran
      // through unverified nodes and it was exiled as a FortiLink fallback.
      // (A plain controller edge is still the one thing that proves nothing.)
      if (d.isIface || d.isLldp || d.isVerifiedUplink || d.isMesh || d.isBridge) {
        (physicalAdj[d.source] = physicalAdj[d.source] || []).push(d.target);
        (physicalAdj[d.target] = physicalAdj[d.target] || []).push(d.source);
      }
    });

    // The view anchor's links: real, verified uplinks for placement purposes.
    viewEntries.forEach(function (id) {
      adj[VIEW_ANCHOR].push(id);
      adj[id].push(VIEW_ANCHOR);
      (physicalAdj[VIEW_ANCHOR] = physicalAdj[VIEW_ANCHOR] || []).push(id);
      (physicalAdj[id] = physicalAdj[id] || []).push(VIEW_ANCHOR);
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
    // A planned leaf cell is stamped "leaf:<member id>" rather than true, so
    // a fan-out child's leaf-column edge cell can pass over its OWN parent's
    // planned APs (they dodge the edge in the leaf pass) but no one else's.
    function cellTaken(c, L) { return !!(reserved[c] && reserved[c][L]); }
    function reserveCell(c, L, owner) {
      (reserved[c] = reserved[c] || {})[L] = owner || true;
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
    // Every cell a chain claims at row L, as [col, lane, owner?, passOwner?]:
    // each member's own cell; its planned leaf block one column right (owner
    // "leaf:<member>"); the SPINE-EDGE cell — (member's column + 1, L) — for
    // every member whose chain continues, because the spine leaves along row
    // L through the leaf column; and, for the chain's root, every cell its
    // own fan-out edge from `parent` crosses along row L after its turn half
    // a column out (see the fan-out edge model) — the leaf-column cell next
    // to the parent, plus the corridor beyond it when the root sits four or
    // more columns away. The leaf-column cell may sit on the PARENT's own
    // planned APs (passOwner): the leaf pass slides them past the edge, so a
    // switch's child switches stay beside its AP stack instead of being
    // pushed below all of it. Anyone else's cell there blocks the row —
    // otherwise the run cut straight through a neighbouring switch's APs.
    // Without the spine-edge cell a sibling placed one row below an earlier
    // sibling's last planned AP ran its spine straight through that AP's
    // cell, and the leaf pass then slid the whole AP block down past the
    // conflict — the switch's APs ended up rows away from it.
    function footprintCells(chain, L, parent, parentCol) {
      var cells = [];
      for (var i = 0; i < chain.length; i++) {
        var m = chain[i];
        var c = depth[m];
        cells.push([c, L]);
        var n = leafChildCount[m] || 0;
        var b = leafBlockStart(chain, i, L);
        for (var k = 0; k < n; k++) cells.push([c + 1, b + k, "leaf:" + m]);
        if (i + 1 < chain.length) cells.push([c + 1, L]);
      }
      var rootCol = depth[chain[0]];
      if (parentCol != null && Math.abs(rootCol - parentCol) >= 2) {
        var step = rootCol > parentCol ? 1 : -1;
        cells.push([parentCol + step, L, null, "leaf:" + parent]);
        fanOutCorridorCols(parentCol, rootCol).forEach(function (cc) { cells.push([cc, L]); });
      }
      return cells;
    }
    function footprintFits(chain, L, parent, parentCol) {
      var cells = footprintCells(chain, L, parent, parentCol);
      for (var i = 0; i < cells.length; i++) {
        var cl = cells[i];
        if (!cellTaken(cl[0], cl[1])) continue;
        if (cl[3] && reserved[cl[0]][cl[1]] === cl[3]) continue;
        return false;
      }
      return true;
    }
    function placeAnchorSubtree(id, fallbackRegion, startLane) {
      if (lane[id] != null) return; // safety — pred tree visits each anchor once
      var chain = spineChainOf(id, fallbackRegion);
      // The corridor is only modelled inside one region: an exile root's
      // "parent" is a verified node across the always-empty column -1.
      var parent = pred[id];
      var parentCol = parent != null && lane[parent] != null &&
        !!inFallbackRegion[parent] === fallbackRegion ? depth[parent] : null;
      var L = startLane;
      while (!footprintFits(chain, L, parent, parentCol)) L++;
      footprintCells(chain, L, parent, parentCol).forEach(function (cell) {
        // An edge cell over the parent's planned AP keeps the AP's stamp, so
        // the next sibling can pass over it too.
        if (cell[3] && cellTaken(cell[0], cell[1])) return;
        reserveCell(cell[0], cell[1], cell[2]);
      });
      for (var ci = 0; ci < chain.length; ci++) lane[chain[ci]] = L;
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
    // Lane of an edge where it crosses integer column `col`, or null when
    // the edge doesn't strictly pass through that column (or an endpoint
    // isn't positioned yet). A fan-out edge (two-plus columns apart, rows
    // differ) is drawn orthogonally and occupies the deep row in every
    // column it crosses (the turn is half a column out) — the same model
    // markFanOutEdges renders and the anchor footprint reserved. Anything
    // else is a straight line, interpolated.
    function edgeLaneAt(s, t, col) {
      var ds = depth[s], dt = depth[t];
      if (lane[s] == null || lane[t] == null || ds == null || dt == null) return null;
      if (ds === dt) return null;
      if (col <= Math.min(ds, dt) || col >= Math.max(ds, dt)) return null;
      if (isFanOutGeometry(ds, lane[s], dt, lane[t])) {
        return fanOutShallowFirst(ds, dt)
          ? fanOutLaneAt(ds, lane[s], dt, lane[t], col)
          : fanOutLaneAt(dt, lane[t], ds, lane[s], col);
      }
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
    nodeIds.forEach(function (id) {
      if (id === VIEW_ANCHOR) return;
      out[id] = { depth: depth[id], lane: lane[id] };
    });
    return out;
  }

  // ── Level layout (every site, coded or not) ──────────────────────────────
  // Places devices AND location boxes by the same network-depth rule, so a
  // description edit only moves what it touches (2026-11-06; replaced the
  // quotient layout, whose box order came from flat-solver ROWS — which the
  // tier clustering reshuffles on every code change — and whose shelf
  // packing wrapped columns at the tallest box's height).
  //
  //   LEVEL   A device's level is its column from the weighted-Dijkstra flat
  //           solver (computeTopologyColumns → depth: firewall 0, anchors on
  //           even columns, leaves one right of their anchor). A box's level
  //           is the level of its SHALLOWEST device, nested boxes' devices
  //           included — an area holding a level-1 device is a level-1 area;
  //           an area whose shallowest device is level 2 is level 2.
  //   TREE    Boxes nest area > building > floor > room > junction box by
  //           their scoped keys (the same keys renderLocationGroups draws, so
  //           every laid-out box is a drawn box); a device belongs to its
  //           deepest box, or to the site itself when it carries no code.
  //   PLACE   Inside each box — and the site — the items are its child boxes
  //           and the devices directly in it, placed branch by branch from
  //           the shallowest (a BFS over the upstream tree). An item's x
  //           starts one cell per network level (distinct levels rank-
  //           compressed) right of its UPSTREAM device and it prefers that
  //           device's ROW; when the spot is taken it takes the cheapest
  //           free spot — cells moved right + cells moved off the row —
  //           past, below or above what blocks it. There are NO site-wide
  //           columns (2026-11-07: a wide area used to push every deeper
  //           item on the map past its right edge, far from its uplink), so
  //           a branch sits beside its uplink and depth still reads left to
  //           right along every branch. Among one upstream's children, one
  //           with children of its own, else one that skips a level (the
  //           next switch of a chain), claims the row first, so a switch
  //           chain stays one flat row; a straight same-row link is a
  //           corridor nothing may sit across, and a device linking OUT of
  //           its box keeps its row clear to the right. Devices with no link
  //           at all go in a strip under the site.
  //   SIZE    Boxes are sized innermost first and placed as one block,
  //           spaced from their siblings by what each one DRAWS (its wall's
  //           reach beyond its devices, _levelSep) rounded up to half cells,
  //           so sibling boxes never overlap, the overlap push in
  //           renderLocationGroups has nothing to do, and every device stays
  //           on the 65 px snap grid.
  //
  // Nothing reads the flat solver's lanes, so adding a code to one device
  // re-places only the boxes it joins or leaves and what stacks after them.
  // Returns the computeTopologyColumns contract — { id: { depth, lane } } in
  // grid units, device centres — or null when the flat solver has no
  // FortiGate root (callers fall back to dagre).
  // Spacing is computed in px against the 130 px cell and rounded UP to
  // half cells: LEVEL_DEVICE_EXT is how far a device reaches from its centre
  // (the firewall's 64 px body + border); siblings clear each other's walls
  // by LOC_GROUP_SIBLING_GAP (so the overlap push in renderLocationGroups
  // has nothing to do); a link crossing a column clears what is there by
  // LEVEL_LINK_GAP. Devices never sit closer than one cell.
  var LEVEL_CELL_PX = 130;
  var LEVEL_DEVICE_EXT = 32;
  var LEVEL_LINK_GAP = 20;
  var _LEVEL_KIND = { a: "area", b: "building", f: "floor", r: "room", jb: "jb" };
  function _ceilHalf(v) { return Math.ceil(v * 2 - 1e-9) / 2; }
  function _levelSep(extA, extB) {
    return Math.max(1, _ceilHalf((extA + extB + LOC_GROUP_SIBLING_GAP) / LEVEL_CELL_PX));
  }
  function _levelLinkSep(ext) {
    return Math.max(0.5, _ceilHalf((ext + LEVEL_LINK_GAP) / LEVEL_CELL_PX));
  }
  var _levelMemo = { elements: null, upstream: null };
  var _levelRankMemo = {};

  function _locPath(d) {
    var a = d.locA || "", b = d.locB || "", f = d.locF || "", r = d.locR || "", jb = d.locJb || "";
    var path = [];
    if (a) path.push({ key: "a|" + a, name: d.locAName || a });
    if (b) path.push({ key: "b|" + a + "|" + b, name: d.locBName || b });
    if (f) path.push({ key: "f|" + a + "|" + b + "|" + f, name: d.locFName || f });
    if (r) path.push({ key: "r|" + a + "|" + b + "|" + f + "|" + r, name: d.locRName || r });
    if (jb) path.push({ key: "jb|" + a + "|" + b + "|" + f + "|" + r + "|" + jb, name: d.locJbName || jb });
    return path;
  }

  // Each device's upstream: the linked device nearest it that is strictly
  // closer to the firewall (smaller |depth|) — its parent in the drawn tree.
  // MCLAG peer links are sideways, never parent links. Ties → smaller id.
  function _upstreamMap(elements, global) {
    var best = {};
    function consider(child, cand) {
      if (!(child in global) || !(cand in global) || child === cand) return;
      var dc = Math.abs(global[child].depth);
      var dp = Math.abs(global[cand].depth);
      if (!(dp < dc)) return;
      var cur = best[child];
      if (cur !== undefined) {
        var dcur = Math.abs(global[cur].depth);
        if (dp < dcur || (dp === dcur && cand > cur)) return;
      }
      best[child] = cand;
    }
    (elements || []).forEach(function (el) {
      var d = el && el.data;
      if (!d || !d.source || !d.target || d.isMclag) return;
      consider(d.target, d.source);
      consider(d.source, d.target);
    });
    return best;
  }

  // ROW WEIGHT: what one cell moved off the upstream's row costs against one
  // cell moved right. At 1 a deep site stacked downward into a tall column
  // (operator screenshot 2026-11-07); the layout is therefore run at several
  // weights and the one whose overall shape is closest to the target aspect
  // (the map's container, width / height; 16:9 when not given) is kept —
  // ties to the lighter weight, which keeps links shorter.
  // A fine ladder: a box moving right vs down is all-or-nothing, so the
  // in-between shapes (two floors side by side, twice) appear only at
  // weights between the coarse steps — with [1, 1.5, 2, 3, 4, 6, 9] an
  // operator's building came out 1.34 or 2.85 for a 1.69 window, never 1.74.
  // ~85 ms for 78 devices, once per open / reset.
  var LEVEL_ROW_WEIGHTS = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 9, 11, 13];
  var LEVEL_DEFAULT_ASPECT = 16 / 9;
  function computeGroupedLayout(elements, opts) {
    var aspect = opts && opts.aspect > 0 && isFinite(opts.aspect) ? opts.aspect : LEVEL_DEFAULT_ASPECT;
    var rowWeight = 1;
    var global = computeTopologyColumns(elements);
    if (!global) return null;
    var upstream = _upstreamMap(elements, global);
    _levelMemo = { elements: elements, upstream: upstream };
    var childrenOf = {};
    Object.keys(upstream).forEach(function (c) {
      (childrenOf[upstream[c]] = childrenOf[upstream[c]] || []).push(c);
    });

    // ── Tree of boxes ──
    var root = { key: "", name: "", children: [], childByKey: {}, devices: [] };
    var labelOf = {};
    (elements || []).forEach(function (el) {
      var d = el && el.data;
      if (!d || !d.id || d.source || !(d.id in global)) return;
      labelOf[d.id] = String(d.label || d.id).toLowerCase();
      var box = root;
      _locPath(d).forEach(function (seg) {
        var next = box.childByKey[seg.key];
        if (!next) {
          next = { key: seg.key, name: String(seg.name).toLowerCase(), children: [], childByKey: {}, devices: [] };
          box.childByKey[seg.key] = next;
          box.children.push(next);
        }
        box = next;
      });
      box.devices.push(d.id);
    });

    function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

    // Compressed network levels (one cell per distinct depth) and the
    // devices that have any link at all.
    var _depths = [];
    Object.keys(global).forEach(function (id) { if (_depths.indexOf(global[id].depth) < 0) _depths.push(global[id].depth); });
    _depths.sort(function (a, b) { return a - b; });
    _levelRankMemo = {};
    _depths.forEach(function (d, i) { _levelRankMemo[d] = i; });
    var linkedIds = {};
    // Every device's linked neighbours (MCLAG peer links included: they are
    // drawn as straight lines too).
    var neighborsOf = {};
    (elements || []).forEach(function (el) {
      var d = el && el.data;
      if (d && d.source && d.target) {
        linkedIds[d.source] = true; linkedIds[d.target] = true;
        if (d.source !== d.target) {
          (neighborsOf[d.source] = neighborsOf[d.source] || []).push(d.target);
          (neighborsOf[d.target] = neighborsOf[d.target] || []).push(d.source);
        }
      }
    });

    // Level + entry device of every box, innermost first.
    function measure(box) {
      var level = Infinity;
      var entry = null;
      function offer(id) {
        var lv = global[id].depth;
        if (lv < level || (lv === level && (entry === null || cmpStr(labelOf[id], labelOf[entry]) < 0 ||
            (labelOf[id] === labelOf[entry] && id < entry)))) {
          level = lv;
          entry = id;
        }
      }
      box.devices.forEach(offer);
      box.children.forEach(function (c) { measure(c); offer(c.entry); });
      box.level = level;
      box.entry = entry;
    }
    measure(root);

    // Lay a box out. Returns { w, h, ext, rel }: rel = device CENTRES
    // relative to the box's first (top-left) centre, w × h the span of those
    // centres, ext the px its drawn wall reaches beyond them (the device
    // radius plus each nested level's padding / name strip). Siblings are
    // spaced by what they DRAW — the two exts plus the sibling gap, rounded
    // up to half cells so every device stays on the 65 px snap grid — so
    // nested boxes cost only their own walls, not a fixed margin per level.
    function layout(box) {
      var items = [];
      var itemOfDevice = {}; // every device in this box's subtree → its item here
      box.children.forEach(function (c) {
        var inner = layout(c);
        Object.keys(inner.rel).forEach(function (id) { itemOfDevice[id] = items.length; });
        items.push({ level: c.level, name: c.name, key: "b:" + c.key, entry: c.entry,
                     w: inner.w, h: inner.h, ext: inner.ext, rel: inner.rel });
      });
      box.devices.forEach(function (id) {
        var rel = {};
        rel[id] = { x: 0, y: 0 };
        itemOfDevice[id] = items.length;
        items.push({ level: global[id].depth, name: labelOf[id], key: "d:" + id, entry: id,
                     w: 0, h: 0, ext: LEVEL_DEVICE_EXT, rel: rel });
      });

      // ── Placement: nearest free spot to the uplink ──
      // Each item's x starts one cell per network level right of its
      // upstream device (never closer than its wall allows) and it prefers
      // the upstream's ROW. When that spot is taken it takes the cheapest
      // free spot — cost = cells moved right + cells moved off the row —
      // among: further right past what blocks it, or below / above what
      // blocks it. There are no site-wide columns: a wide box pushes only
      // what shares its rows, so a branch sits beside its uplink instead of
      // past the widest box on the map.
      var levelRank = _levelRankMemo;
      function rankOf(lv) { return levelRank[lv] !== undefined ? levelRank[lv] : 0; }
      var placedItems = [];
      // Straight same-row links (and a device's outbound row) are corridors:
      // { row, x1, x2 } in cell units; nothing may sit across one.
      var corridors = [];
      function devPos(u) {
        var idx = itemOfDevice[u];
        if (idx === undefined) return null;
        var host = items[idx];
        if (host.x === undefined) return null;
        return { x: host.x + host.rel[u].x, y: host.y + host.rel[u].y, host: host };
      }
      function itemClear(it, x, y, ignoreHost) {
        var e = it.ext / LEVEL_CELL_PX;
        for (var i = 0; i < placedItems.length; i++) {
          var q = placedItems[i];
          var sp = _levelSep(q.ext, it.ext);
          if (x < q.x + q.w + sp && q.x < x + it.w + sp && y < q.y + q.h + sp && q.y < y + it.h + sp) return false;
        }
        var sl = _levelLinkSep(it.ext);
        for (var j = 0; j < corridors.length; j++) {
          var c = corridors[j];
          if (c.row > y - sl && c.row < y + it.h + sl && x - e < c.x2 - 0.01 && x + it.w + e > c.x1 + 0.01) return false;
        }
        return true;
      }
      // The item's own link, when it lands on its upstream's row, runs
      // straight from the upstream: it must not cross a placed item or ride
      // another corridor.
      function ownLinkClear(ux, row, xe, hostOfU, uId) {
        if (xe <= ux) return true;
        for (var i = 0; i < placedItems.length; i++) {
          var q = placedItems[i];
          if (q === hostOfU) {
            // The line starts INSIDE this item (a box): it must still clear
            // every other device in it on that row — a stub's link from a
            // switch deep in a building ran through its neighbours.
            var hostClash = Object.keys(q.rel).some(function (dId) {
              if (dId === uId) return false;
              var px = q.x + q.rel[dId].x, py = q.y + q.rel[dId].y;
              return Math.abs(py - row) < 0.5 && px > ux + 0.01 && px < xe - 0.01;
            });
            if (hostClash) return false;
            continue;
          }
          var sl = _levelLinkSep(q.ext);
          var e = q.ext / LEVEL_CELL_PX;
          if (row > q.y - sl && row < q.y + q.h + sl && ux < q.x + q.w + e - 0.01 && xe > q.x - e + 0.01) return false;
        }
        for (var j = 0; j < corridors.length; j++) {
          var c = corridors[j];
          if (Math.abs(c.row - row) < 0.5 && ux < c.x2 - 0.01 && xe > c.x1 + 0.01) return false;
        }
        return true;
      }
      // Every link between two devices of this box (each in its own item),
      // once both ends are placed: when they share a row it is a straight
      // line, so it is a corridor too — not only the upstream link. A switch
      // linked sideways to another switch keeps that row clear, and an AP
      // never sits on it (operator report: PUG57 → its AP → PUG8 read as one
      // chain on one row).
      function linkedPlaced(it) {
        var out = [];
        Object.keys(it.rel).forEach(function (d) {
          (neighborsOf[d] || []).forEach(function (n) {
            if (it.rel[n]) return;
            var np = devPos(n);
            if (np) out.push({ d: d, n: n, np: np });
          });
        });
        return out;
      }
      function addOutbound(it) {
        Object.keys(it.rel).forEach(function (u) {
          if (outboundSet[u]) corridors.push({ row: it.y + it.rel[u].y, x1: it.x + it.rel[u].x, x2: Infinity });
        });
      }
      // A device here whose child lies OUTSIDE this box links out through
      // the box's right side on its own row: that row stays clear right of it.
      var outboundSet = {};
      Object.keys(itemOfDevice).forEach(function (u) {
        var du = Math.abs(global[u].depth);
        if ((neighborsOf[u] || []).some(function (k) {
          return itemOfDevice[k] === undefined && k in global && Math.abs(global[k].depth) >= du;
        })) outboundSet[u] = true;
      });

      function place(it) {
        var entryRel = it.rel[it.entry];
        var u = upstream[it.entry];
        var up = u === undefined ? null : devPos(u);
        var minX, prefY;
        if (up) {
          var lvGap = Math.max(1, rankOf(it.level) - rankOf(global[u].depth));
          minX = up.x + Math.max(_levelSep(LEVEL_DEVICE_EXT, it.ext), lvGap) - entryRel.x;
          prefY = up.y - entryRel.y;
        } else {
          // Unanchored here (the firewall, or a device whose uplink is
          // outside this box): one cell per level from this box's shallowest.
          minX = rankOf(it.level) - rankOf(box.level);
          prefY = 0;
        }
        var links = linkedPlaced(it);
        var inbound = u !== undefined && !up && itemOfDevice[u] === undefined;
        var sideRows = [];
        Object.keys(it.rel).forEach(function (d) {
          if (!(d in global)) return;
          var dd = Math.abs(global[d].depth);
          var fromOutside = (neighborsOf[d] || []).some(function (k) {
            return itemOfDevice[k] === undefined && k in global && Math.abs(global[k].depth) < dd;
          });
          if (fromOutside) sideRows.push({ d: d, dir: -1 });
          if (outboundSet[d]) sideRows.push({ d: d, dir: 1 });
        });
        var xs = [minX];
        placedItems.forEach(function (q) {
          var xr = q.x + q.w + _levelSep(q.ext, it.ext);
          if (xr > minX) xs.push(xr);
        });
        xs.sort(function (a, b) { return a - b; });
        var best = null;
        for (var xi = 0; xi < xs.length; xi++) {
          var x = xs[xi];
          if (xi > 0 && x === xs[xi - 1]) continue;
          var dx = x - minX;
          if (best && dx >= best.cost) break;
          var ys = [prefY];
          placedItems.forEach(function (q) {
            var sp = _levelSep(q.ext, it.ext);
            ys.push(q.y + q.h + sp, q.y - sp - it.h);
          });
          corridors.forEach(function (c) {
            var sl = _levelLinkSep(it.ext);
            ys.push(c.row + sl, c.row - sl - it.h);
          });
          ys = ys.map(function (v) { return _ceilHalf(v); });
          ys.sort(function (a, b) {
            var da = Math.abs(a - prefY) + (a < prefY ? 0.01 : 0);
            var db = Math.abs(b - prefY) + (b < prefY ? 0.01 : 0);
            return da - db;
          });
          for (var yi = 0; yi < ys.length; yi++) {
            var y = ys[yi];
            var cost = dx + rowWeight * Math.abs(y - prefY) + (y < prefY ? 0.01 : 0);
            if (best && cost >= best.cost) break;
            if (!itemClear(it, x, y)) continue;
            if (up && Math.abs(y + entryRel.y - up.y) < 0.01 && !ownLinkClear(up.x, up.y, x + entryRel.x, up.host, u)) continue;
            // INBOUND: an uplink OUTSIDE this box comes in from the left on the
            // entry's row, so nothing placed may sit on that row to its left
            // (a sibling switch fed from the same outside switch landed on the
            // first one's row, and its link ran straight through the first).
            if (inbound && !ownLinkClear(-1e9, y + entryRel.y, x + entryRel.x, null)) continue;
            // Every device in the item with a link leaving this box keeps
            // that link's row clear: to the left for one coming from a
            // shallower device outside, to the right for one going out.
            var sideClash = false;
            for (var si = 0; si < sideRows.length && !sideClash; si++) {
              var sr = sideRows[si];
              var rr = it.rel[sr.d];
              var xd = x + rr.x, rowd = y + rr.y;
              if (sr.dir < 0 ? !ownLinkClear(-1e9, rowd, xd, null) : !ownLinkClear(xd, rowd, 1e9, null)) sideClash = true;
            }
            if (sideClash) continue;
            var sideBlocked = false;
            for (var li = 0; li < links.length && !sideBlocked; li++) {
              var lk = links[li];
              var dr = it.rel[lk.d];
              if (Math.abs(y + dr.y - lk.np.y) >= 0.01) continue;
              var ax1 = Math.min(x + dr.x, lk.np.x), ax2 = Math.max(x + dr.x, lk.np.x);
              if (!ownLinkClear(ax1, lk.np.y, ax2, lk.np.host, lk.n)) sideBlocked = true;
            }
            if (sideBlocked) continue;
            best = { x: x, y: y, cost: cost };
            break;
          }
        }
        if (!best) best = { x: minX, y: prefY, cost: 0 };
        it.x = best.x;
        it.y = best.y;
        placedItems.push(it);
        links.forEach(function (lk) {
          var dr = it.rel[lk.d];
          var row = it.y + dr.y;
          if (Math.abs(row - lk.np.y) < 0.01) {
            corridors.push({ row: row, x1: Math.min(it.x + dr.x, lk.np.x), x2: Math.max(it.x + dr.x, lk.np.x) });
          }
        });
        if (inbound) corridors.push({ row: it.y + entryRel.y, x1: -Infinity, x2: it.x + entryRel.x });
        sideRows.forEach(function (sr) {
          if (sr.dir > 0) return; // outbound rows: addOutbound below
          var rr = it.rel[sr.d];
          corridors.push({ row: it.y + rr.y, x1: -Infinity, x2: it.x + rr.x });
        });
        addOutbound(it);
      }

      // Order: branch by branch from the shallowest items (BFS over the
      // upstream tree); among one upstream's children, those with children
      // of their own first — the switch chain claims the upstream's row
      // before its leaf APs, so it stays one flat row — then by level, name.
      var kidsOfItem = items.map(function () { return []; });
      var roots = [];
      items.forEach(function (it, i) {
        var u = upstream[it.entry];
        var hi = u === undefined ? undefined : itemOfDevice[u];
        if (hi === undefined || hi === i) roots.push(it); else kidsOfItem[hi].push(it);
      });
      items.forEach(function (it, i) {
        it.idx = i;
        // The SPINE claim on the upstream's row: a child with children of its
        // own, else one that skips a level (the next switch of a chain, two
        // levels on, past its upstream's leaf APs), goes before leaves.
        var u = upstream[it.entry];
        var gap = u === undefined ? 0 : rankOf(it.level) - rankOf(global[u].depth);
        it.spine = kidsOfItem[i].length > 0 ? 2 : (gap >= 2 ? 1 : 0);
      });
      function byPriority(a, b) {
        return (b.spine - a.spine) || (a.level - b.level) || cmpStr(a.name, b.name) || cmpStr(a.key, b.key);
      }
      // Unconnected devices (no link at all) are not placed here: the site
      // root puts them in a strip of their own along the bottom.
      var loose = [];
      roots = roots.filter(function (it) {
        if (box === root && it.key.indexOf("d:") === 0 && !linkedIds[it.entry]) { loose.push(it); return false; }
        return true;
      });
      roots.sort(function (a, b) { return (a.level - b.level) || cmpStr(a.name, b.name) || cmpStr(a.key, b.key); });
      var queue = roots.slice();
      for (var qi = 0; qi < queue.length; qi++) {
        var cur = queue[qi];
        place(cur);
        kidsOfItem[cur.idx].slice().sort(byPriority).forEach(function (k) { queue.push(k); });
      }

      // Normalize: the box's frame starts at its top-left device centre.
      var minXc = Infinity, minYc = Infinity;
      placedItems.forEach(function (it) {
        if (it.x < minXc) minXc = it.x;
        if (it.y < minYc) minYc = it.y;
      });
      if (!isFinite(minXc)) { minXc = 0; minYc = 0; }
      var width = 0, height = 0;
      placedItems.forEach(function (it) {
        it.x -= minXc;
        it.y -= minYc;
        if (it.x + it.w > width) width = it.x + it.w;
        if (it.y + it.h > height) height = it.y + it.h;
      });
      // The no-links strip: one row under everything, a cell apart.
      if (loose.length) {
        loose.sort(function (a, b) { return cmpStr(a.name, b.name) || cmpStr(a.key, b.key); });
        var stripY = placedItems.length ? height + 1.5 : 0;
        loose.forEach(function (it, i) {
          it.x = i;
          it.y = stripY;
          placedItems.push(it);
          if (it.x > width) width = it.x;
        });
        height = stripY;
      }

      var out = {};
      var maxExt = 0;
      items.forEach(function (it) {
        if (it.ext > maxExt) maxExt = it.ext;
        Object.keys(it.rel).forEach(function (id) {
          out[id] = { x: it.x + it.rel[id].x, y: it.y + it.rel[id].y };
        });
      });
      // This box's own wall: the larger of its level's side padding and the
      // name strip on top, beyond the furthest-reaching thing inside it.
      var cfg = LOC_GROUP_KINDS[_LEVEL_KIND[box.key.slice(0, box.key.indexOf("|"))]];
      var own = cfg ? Math.max(cfg.pad, LOC_LABEL_BAND + LOC_LABEL_GAP) : 0;
      return { w: width, h: height, ext: maxExt + own, rel: out };
    }

    // One run per row weight; keep the shape nearest the target aspect
    // (compared as log ratios, so 2× too wide and 2× too tall weigh alike).
    var bestRun = null;
    LEVEL_ROW_WEIGHTS.forEach(function (w) {
      rowWeight = w;
      var rel = layout(root).rel;
      var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      Object.keys(rel).forEach(function (id) {
        var p = rel[id];
        if (p.x < x1) x1 = p.x;
        if (p.x > x2) x2 = p.x;
        if (p.y < y1) y1 = p.y;
        if (p.y > y2) y2 = p.y;
      });
      // Device centres span plus one cell, so a single row is not "infinitely wide".
      var shape = isFinite(x1) ? (x2 - x1 + 1) / (y2 - y1 + 1) : aspect;
      var miss = Math.abs(Math.log(shape / aspect));
      if (!bestRun || miss < bestRun.miss - 1e-9) bestRun = { rel: rel, miss: miss };
    });
    var placed = bestRun.rel;
    var positions = {};
    Object.keys(placed).forEach(function (id) {
      positions[id] = { depth: placed[id].x, lane: placed[id].y };
    });
    return positions;
  }

  // ── Anonymised layout data (Export › Layout data) ───────────────────────
  // The topology as drawn, for review outside the app with nothing that
  // identifies the site: every device, location box and link with its
  // on-screen geometry, but device names, box names, IPs, MACs, serials,
  // asset ids and SSIDs replaced or left out. Devices are aliased by role
  // (SW-3f9a2, AP-07c1e, …) and boxes by level (AREA-…, BLDG-…, FLOOR-…,
  // ROOM-…, JB-…), the suffix a hash of the asset id / box key SALTED with
  // the site's firewall id (meta.salt): the same device or box carries the
  // same alias in every view and every export of that site, so files can be
  // compared, and nobody without the database can reverse one. (Numbering in
  // screen order, the first build, named every drill-down "BLDG-1".) Port names (port49, lan1) are kept: they identify nothing
  // and say which cable is which. Pure over the cy instance; `meta` carries
  // what the page knows (the active view key, the pane size).
  var _ANON_ROLE = { fortigate: "FW", fortiswitch: "SW", fortiap: "AP", endpoint: "EP", "remote-asset": "REM", "wireless-station": "STA" };
  var _ANON_KIND = { a: "AREA", b: "BLDG", f: "FLOOR", r: "ROOM", jb: "JB" };
  function anonymisedLayout(cy, meta) {
    meta = meta || {};
    function r1(v) { return typeof v === "number" && isFinite(v) ? Math.round(v * 10) / 10 : null; }
    function byScreen(a, b) { return (a.y - b.y) || (a.x - b.x) || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0); }
    var salt = String(meta.salt || "");
    // FNV-1a over salt|text → 5 hex chars; a clash inside one export takes a
    // -2, -3 … suffix.
    function hash5(text) {
      var h = 0x811c9dc5;
      var str = salt + "|" + text;
      for (var i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return ("00000" + (h >>> 0).toString(16)).slice(-5);
    }
    var usedAlias = {};
    function uniqueAlias(prefix, text) {
      var base = prefix + "-" + hash5(text);
      var a = base, n = 1;
      while (usedAlias[a] && usedAlias[a] !== text) a = base + "-" + (++n);
      usedAlias[a] = text;
      return a;
    }
    function keyAlias(key) {
      if (!key || key === "flat") return "base";
      return uniqueAlias(_ANON_KIND[key.slice(0, key.indexOf("|"))] || "VIEW", "box:" + key);
    }
    var healthOf = {};
    Object.keys(HEALTH_NODE_COLORS || {}).forEach(function (k) { healthOf[String(HEALTH_NODE_COLORS[k]).toLowerCase()] = k; });

    var all = cy.nodes().filter(function (n) { return !n.data("isEdgeHandle"); });
    var devices = all.filter(function (n) { return !n.data("isLocGroup") && !n.data("isPortal"); });
    var portals = all.filter(function (n) { return !!n.data("isPortal"); });
    var hulls = all.filter(function (n) { return !!n.data("isLocGroup"); });

    // Boxes: every location path any device carries, drawn or not.
    var boxInfo = {}; // key → { kind, parent, k }
    devices.forEach(function (n) {
      var parent = null;
      _locPath(n.data()).forEach(function (seg) {
        if (!boxInfo[seg.key]) boxInfo[seg.key] = { kind: seg.key.slice(0, seg.key.indexOf("|")), parent: parent, key: seg.key };
        parent = seg.key;
      });
    });
    var hullByKey = {};
    hulls.forEach(function (h) {
      var id = String(h.id());
      var key = id.indexOf("locgroup:") === 0 ? id.slice("locgroup:".length) : id;
      hullByKey[key] = h;
    });
    var boxOrder = Object.keys(boxInfo).map(function (key) {
      var h = hullByKey[key];
      var bb = h ? h.boundingBox({ includeLabels: false }) : null;
      return { key: key, x: bb ? bb.x1 : Infinity, y: bb ? bb.y1 : Infinity, k: key };
    }).sort(byScreen);
    var boxAlias = {};
    boxOrder.forEach(function (b) { boxAlias[b.key] = keyAlias(b.key); });

    // Devices and portals, aliased in screen order.
    var alias = {};
    devices.forEach(function (n) {
      alias[n.id()] = uniqueAlias(_ANON_ROLE[n.data("role")] || "DEV", "dev:" + n.id());
    });
    // A stub is named for what it stands for: a FortiGate stub as that
    // device, a group stub as that group's box alias.
    portals.forEach(function (n) {
      var d = n.data();
      alias[n.id()] = d.remoteAssetId
        ? "STUB:" + uniqueAlias("FW", "dev:" + d.remoteAssetId)
        : "STUB:" + keyAlias(d.targetView);
    });

    var out = {
      format: "polaris-topology-layout/1",
      exportedAt: new Date().toISOString(),
      anonymised: "device, box and site names, IPs, MACs, serials, asset ids and SSIDs are replaced or left out",
      view: meta.view ? keyAlias(meta.view) : null,
      pane: meta.pane ? { w: Math.round(meta.pane.w), h: Math.round(meta.pane.h) } : null,
      zoom: r1(cy.zoom()),
      devices: [],
      boxes: [],
      portals: [],
      links: [],
    };
    devices.forEach(function (n) {
      var d = n.data();
      out.devices.push({
        id: alias[n.id()],
        role: d.role || null,
        health: healthOf[String(d.nodeColor || "").toLowerCase()] || null,
        x: r1(n.position("x")), y: r1(n.position("y")),
        w: r1(n.width()), h: r1(n.height()),
        boxes: _locPath(d).map(function (seg) { return boxAlias[seg.key]; }),
        viewEntry: d.viewEntry ? true : undefined,
        hidden: n.visible() ? undefined : true,
      });
    });
    Object.keys(boxInfo).forEach(function (key) {
      var info = boxInfo[key];
      var h = hullByKey[key];
      var bb = h ? h.boundingBox({ includeLabels: false }) : null;
      out.boxes.push({
        id: boxAlias[key],
        kind: _LEVEL_KIND[info.kind] || info.kind,
        parent: info.parent ? boxAlias[info.parent] : null,
        drawn: !!h,
        x1: bb ? r1(bb.x1) : null, y1: bb ? r1(bb.y1) : null, x2: bb ? r1(bb.x2) : null, y2: bb ? r1(bb.y2) : null,
      });
    });
    out.boxes.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    portals.forEach(function (n) {
      out.portals.push({
        id: alias[n.id()],
        root: n.data("isRootPortal") ? true : undefined,
        upstream: n.data("isUpstreamPortal") ? true : undefined,
        toView: keyAlias(n.data("targetView")),
        x: r1(n.position("x")), y: r1(n.position("y")),
      });
    });
    var linkN = 0;
    cy.edges().forEach(function (e) {
      var s = alias[e.source().id()], t = alias[e.target().id()];
      if (!s || !t) return;
      var d = e.data();
      var flags = [];
      ["isIface", "isLldp", "isVerifiedUplink", "isApLink", "isBridge", "isMesh", "isMclag", "isWireless", "isInterGroup", "isFanOut", "inLoop", "customPath", "detoured"].forEach(function (f) {
        if (d[f] && d[f] !== 0) flags.push(f.replace(/^is/, "").replace(/^./, function (c) { return c.toLowerCase(); }));
      });
      var pts = null;
      try {
        var seq = [e.sourceEndpoint()];
        var curve = e.style("curve-style");
        var mids = curve === "segments" || curve === "taxi" ? e.segmentPoints() : (curve === "bezier" || curve === "unbundled-bezier" ? e.controlPoints() : null);
        (mids || []).forEach(function (p) { seq.push(p); });
        seq.push(e.targetEndpoint());
        pts = seq.map(function (p) { return { x: r1(p.x), y: r1(p.y) }; });
      } catch (err) { pts = null; }
      out.links.push({
        id: "L-" + (++linkN),
        a: s, b: t,
        flags: flags,
        // A mesh link's label is its SSID — left out; every other label is a port pair.
        ports: d.isMesh ? undefined : (d.label || undefined),
        speed: d.linkSpeed || undefined,
        speedBps: d.speedBps || undefined,
        signal: d.meshSignal || undefined,
        signalDbm: d.signalDbm != null ? d.signalDbm : undefined,
        curve: (function () { try { return e.style("curve-style"); } catch (err) { return null; } })(),
        points: pts,
      });
    });
    return out;
  }

  // The aspect (width / height) a topology should be laid out for: the
  // container it is drawn in. Undefined when the element is missing or has no
  // size yet (hidden), so computeGroupedLayout falls back to 16:9.
  function layoutAspect(el) {
    var w = el && el.clientWidth, h = el && el.clientHeight;
    return w > 0 && h > 0 ? w / h : undefined;
  }

  // Upstream (parent) device of every device, from the same pass the level
  // layout ran — for placing a device a saved layout has no spot for next to
  // its saved parent (applySavedPositions).
  function layoutUpstream(elements) {
    if (_levelMemo.elements === elements && _levelMemo.upstream) return _levelMemo.upstream;
    var global = computeTopologyColumns(elements);
    return global ? _upstreamMap(elements, global) : {};
  }

  // Lay a view's SAVED layout over the level layout just run (call from the
  // layoutstop handler, before renderLocationGroups). Saved devices go to
  // their saved spots and are PINNED: renderLocationGroups({ fixedIds }) never
  // pushes them. A device the save has no spot for keeps its level-layout
  // offset from its nearest saved upstream ancestor — a new switch lands
  // beside its saved parent, not where the parent would be on an empty map.
  // Returns { pinned: { id: true }, restored: [node], placed: [node] }.
  function applySavedPositions(cy, saved, elements) {
    var res = { pinned: {}, restored: [], placed: [] };
    if (!cy || !saved || typeof saved !== "object") return res;
    var auto = {};
    cy.nodes().forEach(function (n) {
      var p = n.position();
      auto[n.id()] = { x: p.x, y: p.y };
    });
    function ok(p) { return p && typeof p.x === "number" && typeof p.y === "number"; }
    var up = layoutUpstream(elements);
    cy.batch(function () {
      cy.nodes().forEach(function (n) {
        var p = saved[n.id()];
        if (ok(p)) {
          n.position({ x: p.x, y: p.y });
          res.pinned[n.id()] = true;
          res.restored.push(n);
        }
      });
      // Which saved devices each node links to (for an unsaved stub).
      var linked = {};
      cy.edges().forEach(function (e) {
        var s = e.source().id(), t = e.target().id();
        (linked[s] = linked[s] || []).push(t);
        (linked[t] = linked[t] || []).push(s);
      });
      cy.nodes().forEach(function (n) {
        var id = n.id();
        if (res.pinned[id]) return;
        res.placed.push(n);
        if (n.data("isPortal")) {
          // A stub the save has no spot for goes beside the saved devices it
          // links to — a "←" stub (fed from) two columns left of the
          // leftmost, a "→" stub two columns right of the rightmost — on
          // that device's row. Its spot on an empty map means nothing in the
          // saved frame and had put it on top of a device.
          var mates = (linked[id] || []).filter(function (m) { return res.pinned[m] && ok(saved[m]); }).map(function (m) { return saved[m]; });
          if (mates.length) {
            var left = n.data("isUpstreamPortal") || n.data("isRootPortal");
            var pick = mates.reduce(function (b, p) { return left ? (p.x < b.x ? p : b) : (p.x > b.x ? p : b); });
            n.position({ x: pick.x + (left ? -260 : 260), y: pick.y });
            return;
          }
        }
        var a = up[id];
        for (var guard = 0; a !== undefined && !res.pinned[a] && guard < 256; guard++) a = up[a];
        if (a === undefined || !res.pinned[a] || !auto[a] || !auto[id]) return;
        var s = saved[a];
        n.position({ x: auto[id].x + (s.x - auto[a].x), y: auto[id].y + (s.y - auto[a].y) });
      });
    });
    return res;
  }

  // ── Edge hover tooltip text ───────────────────────────────────────────────
  // Shared by the Device Map page's topology modal (map.js) and the Device Map
  // dashboard widget's read-only topology, so a link reads the same on both.
  // Each surface owns its own tooltip element and positioning.
  function _escTip(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Humanize an interface speed in bits/sec → "1 Gbps" / "100 Mbps" etc.
  function _humanizeSpeedBps(bps) {
    if (bps == null || bps <= 0) return "";
    if (bps >= 1e9) return (bps % 1e9 === 0 ? (bps / 1e9).toFixed(0) : (bps / 1e9).toFixed(1)) + " Gbps";
    if (bps >= 1e6) return (bps % 1e6 === 0 ? (bps / 1e6).toFixed(0) : (bps / 1e6).toFixed(1)) + " Mbps";
    if (bps >= 1e3) return (bps / 1e3).toFixed(0) + " Kbps";
    return bps + " bps";
  }
  // One-line interface detail: "lan1 · 1 Gbps · up · errors ↓3 ↑1" (speed/
  // status omitted when unknown; errors shown only when nonzero).
  function _formatIfDetail(d) {
    if (!d || !d.name) return "";
    var bits = [d.name];
    var sp = _humanizeSpeedBps(d.speedBps);
    if (sp) bits.push(sp);
    if (d.operStatus) bits.push(d.operStatus);
    var ie = d.inErrors || 0, oe = d.outErrors || 0;
    if (ie > 0 || oe > 0) bits.push("errors ↓" + ie + " ↑" + oe);
    return bits.join(" · ");
  }

  // The concise edge tooltip: "DeviceA  ⇄  DeviceB" on top, the per-side
  // interface ports next, a one-line connection kind, then per-side interface
  // details (speed / status / errors) when available. Reads device names from
  // the endpoint nodes and the port pair from the edge label
  // ("<srcPort> ↔ <tgtPort>"). Returns null when there's nothing useful.
  // The tooltip's colour key for a link: a short line drawn in the link's own
  // map colour and pattern, then the value in words — the colour is never
  // the only carrier (the speed / signal is always written out).
  function _tipSwatch(color, dashed) {
    return '<span style="display:inline-block;width:22px;height:0;border-top:3px ' +
      (dashed ? "dashed" : "solid") + ' ' + color + '"></span>';
  }
  function _tipAgo(ts) {
    var t = ts ? new Date(ts).getTime() : NaN;
    if (!isFinite(t)) return "";
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 90) return s + " s ago";
    if (s < 5400) return Math.round(s / 60) + " min ago";
    if (s < 129600) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " d ago";
  }
  function _speedTipRows(edge) {
    var ec = EDGE_COLORS[paletteFamily()];
    var cls = edge.data("linkSpeed") || "unknown";
    var color = cls === "unknown" ? ec.neutral : ec[cls];
    var row = '<div style="display:flex;align-items:center;gap:8px;margin-top:6px">' + _tipSwatch(color, false);
    if (cls === "unknown") {
      return row + '<b>Speed not known</b></div>' +
        '<div style="font-size:0.82em;opacity:0.85;margin-top:4px">Neither end reports a port speed, so the link’s speed can’t be read.</div>';
    }
    row += '<b>' + _escTip(_humanizeSpeedBps(edge.data("speedBps"))) + '</b>' +
      '<span style="opacity:0.7;font-size:0.82em">link speed</span></div>';
    if (cls === "100m" || cls === "10m") {
      row += '<div style="font-size:0.82em;opacity:0.85;margin-top:4px">Slower than 1 Gb on an infrastructure link. Usually a cable or speed-negotiation fault.</div>';
    }
    return row;
  }
  // A port's transceiver readings (SFP DDM, business rule 143), one indented
  // line under its port line: "SFP Rx −3.20 dBm · Tx −2.10 dBm · 41.0 °C ·
  // 3.30 V · 8.98 mA", each part only when read. Rx at or below
  // OPTICS_RX_LOW_DBM is red, matching the asset's Interfaces table
  // (assets.js RX_LOW_DBM). A copper SFP or an empty cage reads nothing and
  // gets no line.
  var OPTICS_RX_LOW_DBM = -20;
  function _fmtDbm(v) { return String(v).replace("-", "−"); }
  function _opticsTipRow(ifd) {
    var o = ifd && ifd.optics;
    if (!o) return "";
    function num(v) { return typeof v === "number" && isFinite(v); }
    var parts = [];
    if (num(o.rxDbm)) {
      var rx = "Rx " + _fmtDbm(o.rxDbm.toFixed(2)) + " dBm";
      parts.push(o.rxDbm <= OPTICS_RX_LOW_DBM
        ? '<span style="color:var(--color-danger,#dc2626);font-weight:600">' + _escTip(rx) + '</span>'
        : _escTip(rx));
    }
    if (num(o.txDbm)) parts.push(_escTip("Tx " + _fmtDbm(o.txDbm.toFixed(2)) + " dBm"));
    if (num(o.temperatureC)) {
      var TU = typeof window !== "undefined" ? window.PolarisTempUnit : null;
      var tv = TU && TU.convertCelsius ? TU.convertCelsius(o.temperatureC) : o.temperatureC;
      parts.push(_escTip(tv.toFixed(1) + " " + (TU && TU.celsiusLabel ? TU.celsiusLabel() : "°C")));
    }
    if (num(o.voltage)) parts.push(_escTip(o.voltage.toFixed(2) + " V"));
    if (num(o.biasA)) parts.push(_escTip((o.biasA * 1000).toFixed(2) + " mA"));
    if (!parts.length) return "";
    return '<div style="font-size:0.78em;opacity:0.85;padding-left:12px">' +
      '<span style="opacity:0.7">SFP</span> ' + parts.join(" · ") + '</div>';
  }
  var _SIGNAL_WORD = { good: "Good signal", fair: "Fair signal", weak: "Weak signal", poor: "Poor signal" };
  function _meshTipRows(edge) {
    var ec = EDGE_COLORS[paletteFamily()];
    var cls = edge.data("meshSignal") || "unknown";
    var dbm = edge.data("signalDbm");
    var html = '<div style="display:flex;align-items:center;gap:8px;margin-top:6px">';
    if (cls === "unknown") {
      html += _tipSwatch(ec.neutral, true) + '<b>Signal not reported</b></div>';
    } else {
      var wordColor = cls === "good" ? "var(--color-success)" : ec[cls];
      html += _tipSwatch(cls === "good" ? ec.neutral : ec[cls], true) +
        '<b>' + _escTip(String(dbm).replace("-", "−")) + ' dBm</b>' +
        '<span style="font-weight:600;color:' + wordColor + '">' + _SIGNAL_WORD[cls] + '</span></div>';
    }
    var ch = edge.data("channel"), band = edge.data("band"), width = edge.data("channelWidthMhz");
    var radio = [];
    if (ch != null) radio.push("Channel " + ch);
    if (band) radio.push(String(band).replace(/GHz$/i, " GHz").replace(/\s+GHz/, " GHz"));
    if (width) radio.push(width + " MHz wide");
    if (radio.length) html += '<div style="margin-top:4px">' + _escTip(radio.join(" · ")) + '</div>';
    var noise = edge.data("noiseDbm");
    if (cls !== "unknown" && noise != null) {
      html += '<div style="font-size:0.82em;opacity:0.85">' +
        _escTip("Noise " + String(noise).replace("-", "−") + " dBm · SNR " + (Number(dbm) - Number(noise)) + " dB") + '</div>';
    }
    if (edge.data("ssid")) {
      html += '<div style="font-size:0.82em;opacity:0.85">SSID <span style="font-family:var(--font-mono,monospace)">' +
        _escTip(edge.data("ssid")) + '</span></div>';
    }
    if (cls === "unknown") {
      html += '<div style="font-size:0.82em;opacity:0.85;margin-top:4px">Signal strength comes from the firewall’s REST API; SNMP polling carries none.</div>';
    }
    var ago = _tipAgo(edge.data("seenAt"));
    if (ago) html += '<div style="font-size:0.78em;opacity:0.7;margin-top:4px">Seen ' + ago + '</div>';
    return html;
  }

  function edgeTooltipHtml(cy, edge) {
    if (!cy || !edge) return null;
    var srcId = edge.data("source");
    var tgtId = edge.data("target");
    var srcLabel = (cy.getElementById(srcId).data("label")) || srcId || "?";
    var tgtLabel = (cy.getElementById(tgtId).data("label")) || tgtId || "?";
    var ports = String(edge.data("label") || "").trim();
    // The legend shows one "Switch ↔ switch"; HOW a link was found (interface
    // naming or an LLDP report) is told here.
    var kind = edge.data("isMesh")     ? "AP to AP — wireless mesh backhaul"
             : edge.data("isBridge")   ? "Switch bridged behind AP (wired)"
             : edge.data("isWireless") ? "Wireless client"
             : edge.data("isMclag")    ? "MCLAG inter-chassis link"
             : edge.data("isApLink")   ? "AP switch uplink"
             : edge.data("isIface")    ? "Switch ↔ switch — found by interface naming"
             : edge.data("isLldp")     ? "Switch ↔ switch — found by LLDP"
             :                            "Firewall to switch — cable confirmed";
    var html =
      '<div style="font-weight:600">' + _escTip(srcLabel) +
      ' <span style="opacity:0.7">⇄</span> ' + _escTip(tgtLabel) + '</div>';
    var isMesh = !!edge.data("isMesh");
    // A mesh link's label is its SSID, which gets its own row below.
    if (!isMesh && ports && ports !== "unknown ↔ unknown") {
      html += '<div style="font-family:var(--font-mono,monospace);font-size:0.82em;margin-top:2px">' +
        _escTip(ports) + '</div>';
    }
    html += '<div style="opacity:0.7;font-size:0.82em;margin-top:2px">' + _escTip(kind) + '</div>';
    html += isMesh ? _meshTipRows(edge) : (edge.data("isWireless") ? "" : _speedTipRows(edge));
    // Per-side interface detail, each prefixed with its device so the operator
    // can tell which end "port14" / "port52" lives on (srcIf belongs to the
    // source node, tgtIf to the target).
    var sd = _formatIfDetail(edge.data("srcIf"));
    var td = _formatIfDetail(edge.data("tgtIf"));
    if (sd) html += '<div style="font-size:0.78em;opacity:0.85;margin-top:3px">' +
      '<span style="opacity:0.7">' + _escTip(srcLabel) + ':</span> ' + _escTip(sd) + '</div>';
    html += _opticsTipRow(edge.data("srcIf"));
    if (td) html += '<div style="font-size:0.78em;opacity:0.85">' +
      '<span style="opacity:0.7">' + _escTip(tgtLabel) + ':</span> ' + _escTip(td) + '</div>';
    html += _opticsTipRow(edge.data("tgtIf"));
    // A port receiving below most optics' sensitivity is named once, under
    // both ends — the same −20 dBm line the asset's Interfaces table tints.
    var lowRx = [[srcLabel, edge.data("srcIf")], [tgtLabel, edge.data("tgtIf")]].filter(function (p) {
      var o = p[1] && p[1].optics;
      return o && typeof o.rxDbm === "number" && o.rxDbm <= OPTICS_RX_LOW_DBM;
    });
    if (lowRx.length) {
      html += '<div style="font-size:0.82em;margin-top:4px;color:var(--color-danger,#dc2626)">' +
        _escTip(lowRx.map(function (p) { return p[0]; }).join(" and ")) +
        ' receive' + (lowRx.length === 1 ? "s" : "") + ' below ' + _escTip(_fmtDbm(OPTICS_RX_LOW_DBM)) +
        ' dBm, past most optics’ sensitivity. Check the fibre, connectors and the far-end transmitter.</div>';
    }
    // A link kept as last known: say so, and when it was last seen.
    if (edge.data("isLastKnown") === 1) {
      var lk = new Date(edge.data("lastKnownAt"));
      html += '<div style="font-size:0.82em;margin-top:4px;opacity:0.9">Last known' +
        (isFinite(lk.getTime()) ? ', seen ' + _escTip(lk.toLocaleString()) : '') +
        '. An end is not being polled (dependency-down, down or recovering), so this is where the link was.</div>';
    }
    return html;
  }

  // The legend's body from topologyLegendSpec(): Nodes, Monitor health, Edges
  // and (when the spec has them) Location groups, as .topology-legend-* rows
  // (styles.css). Shared by the Device Map page — which appends its own Mouse
  // controls section — and the Device Map widget's read-only topology, so the
  // two keys cannot drift apart.
  function topologyLegendHtml(spec) {
    function nodeSwatch(row) {
      var size = row.size === "lg" ? 22 : (row.size === "sm" ? 14 : 18);
      var border = row.border ? row.border : "rgba(255,255,255,0.85)";
      var borderStyle = row.borderStyle === "dashed" ? "dashed" : "solid";
      var fill = row.fill === "data(nodeColor)" ? HEALTH_NODE_COLORS.up : row.fill;
      var shape = "";
      if (row.kind === "diamond") {
        shape = '<div style="width:' + size + 'px;height:' + size + 'px;background:' + fill +
                ';border:2px ' + borderStyle + ' ' + border + ';transform:rotate(45deg)"></div>';
      } else if (row.kind === "round-rectangle") {
        shape = '<div style="width:' + (size + 8) + 'px;height:' + size + 'px;background:' + fill +
                ';border:2px ' + borderStyle + ' ' + border + ';border-radius:4px"></div>';
      } else {
        shape = '<div style="width:' + size + 'px;height:' + size + 'px;background:' + fill +
                ';border:2px ' + borderStyle + ' ' + border + ';border-radius:50%"></div>';
      }
      return '<span class="topology-legend-swatch">' + shape + '</span>';
    }
    function edgeSwatch(row) {
      var w = row.width || 2.4;
      var dash = row.style === "dashed" ? "5 3" : (row.style === "dotted" ? "0.5 4" : "0");
      var cap = row.style === "dashed" ? "butt" : "round";
      var halo = row.halo
        ? '<line x1="3" y1="6" x2="25" y2="6" stroke="' + row.halo + '" stroke-width="' + (w + 4) + '" stroke-linecap="round"/>'
        : "";
      return '<span class="topology-legend-swatch">' +
        '<svg width="28" height="12" viewBox="0 0 28 12" aria-hidden="true">' + halo +
          '<line x1="3" y1="6" x2="25" y2="6" stroke="' + row.color +
          '" stroke-width="' + w + '" stroke-dasharray="' + dash + '" stroke-linecap="' + cap + '"/>' +
        '</svg></span>';
    }
    function healthSwatch(row) {
      return '<span class="topology-legend-swatch">' +
        '<div style="width:14px;height:14px;background:' + row.color +
        ';border-radius:50%;border:2px solid rgba(255,255,255,0.85)"></div></span>';
    }
    // Location grouping hull swatches — every level is a rounded rectangle
    // with a FIXED per-level color + solid/dashed border, mirroring
    // LOC_GROUP_KINDS.
    function locationSwatch(rowSpec) {
      var color = rowSpec.color || "#4fc3f7";
      var borderStyle = rowSpec.style === "dashed" ? "dashed" : "solid";
      var shape = '<div style="width:22px;height:16px;background:' + color + '22;border:2px ' +
        borderStyle + ' ' + color + ';border-radius:4px"></div>';
      return '<span class="topology-legend-swatch">' + shape + '</span>';
    }
    function section(title, rows, swatch) {
      if (!rows || !rows.length) return "";
      return '<div class="topology-legend-section"><div class="topology-legend-section-title">' + _escTip(title) + '</div>' +
        rows.map(function (r) { return topologyLegendRow(swatch(r), r.label, r.desc, r.key); }).join("") +
        '</div>';
    }
    if (!spec) return "";
    return section("Nodes", spec.nodes, nodeSwatch) +
      section("Monitor health", spec.health, healthSwatch) +
      section("Wired link speed", (spec.edges || []).filter(function (r) { return r.section === "speed"; }), edgeSwatch) +
      section("Wireless mesh signal", (spec.edges || []).filter(function (r) { return r.section === "signal"; }), edgeSwatch) +
      section("Also", (spec.edges || []).filter(function (r) { return r.section !== "speed" && r.section !== "signal"; }), edgeSwatch) +
      section("Location groups", spec.locations, locationSwatch);
  }

  // One legend row: a swatch (HTML, may be ""), a label and an optional
  // description line under it, and the optional legendMatch key hovering it
  // lights (wireLegendHover). Exported so a caller can add rows of its own.
  function topologyLegendRow(swatchHtml, label, desc, key) {
    var keyAttr = key ? ' data-legend-key="' + _escTip(key) + '"' : "";
    var html = '<div class="topology-legend-row"' + keyAttr + '>' + swatchHtml +
               '<span class="topology-legend-label">' + _escTip(label) + '</span></div>';
    if (desc) html += '<div class="topology-legend-desc">' + _escTip(desc) + '</div>';
    return html;
  }

  // ── Device overlap guard ─────────────────────────────────────────────────
  // No two devices may sit on the same spot on the Device Map. "The same
  // spot" is the device bodies (width × height, border excluded: a
  // selected device draws a thicker border, and its footprint must not
  // change with selection) overlapping — no
  // clearance: the snap cells are 65 px squares, so two switches (44 px
  // bodies) on neighbouring cells are 21 px apart and must count as free — two exactly equal x/y is the extreme case, and the one
  // snapping produces when two devices round to one grid cell.
  //
  // separatePositions places `items` IN ORDER (earlier items keep their spot;
  // a later one that lands on an occupied spot moves) around the `fixed`
  // boxes, which never move. A displaced item goes to the nearest free spot
  // on its own lattice — offsets of whole stepX / stepY from where it was
  // dropped — so a device snapped to the grid stays on the grid. Occupancy is
  // a bucket hash, so a whole-site pass stays linear at a few hundred nodes.
  // Pure: shared by the live map (separateNodes) and by the arithmetic snap
  // of view blobs that are not rendered.
  var _OVERLAP_GAP = 0;
  var _OVERLAP_BUCKET = 128;
  var _OVERLAP_MAX_RING = 12;
  function _boxesOverlap(a, b, gap) {
    return Math.abs(a.x - b.x) < (a.w + b.w) / 2 + gap &&
           Math.abs(a.y - b.y) < (a.h + b.h) / 2 + gap;
  }
  function separatePositions(items, opts) {
    opts = opts || {};
    var stepX = opts.stepX > 0 ? opts.stepX : 130;
    var stepY = opts.stepY > 0 ? opts.stepY : 130;
    var gap = typeof opts.gap === "number" ? opts.gap : _OVERLAP_GAP;
    var buckets = {};
    var maxW = 0, maxH = 0;
    function bucketRange(box) {
      return {
        x1: Math.floor((box.x - box.w / 2 - gap) / _OVERLAP_BUCKET),
        x2: Math.floor((box.x + box.w / 2 + gap) / _OVERLAP_BUCKET),
        y1: Math.floor((box.y - box.h / 2 - gap) / _OVERLAP_BUCKET),
        y2: Math.floor((box.y + box.h / 2 + gap) / _OVERLAP_BUCKET),
      };
    }
    function add(box) {
      if (box.w > maxW) maxW = box.w;
      if (box.h > maxH) maxH = box.h;
      var r = bucketRange(box);
      for (var bx = r.x1; bx <= r.x2; bx++) {
        for (var by = r.y1; by <= r.y2; by++) {
          var k = bx + "," + by;
          (buckets[k] || (buckets[k] = [])).push(box);
        }
      }
    }
    function collides(box) {
      // Widen the probe by the largest box seen, so a big neighbour whose
      // centre is buckets away but whose body reaches here is still found.
      var probe = { x: box.x, y: box.y, w: box.w + maxW, h: box.h + maxH };
      var r = bucketRange(probe);
      for (var bx = r.x1; bx <= r.x2; bx++) {
        for (var by = r.y1; by <= r.y2; by++) {
          var list = buckets[bx + "," + by];
          if (!list) continue;
          for (var i = 0; i < list.length; i++) {
            if (_boxesOverlap(box, list[i], gap)) return true;
          }
        }
      }
      return false;
    }
    (opts.fixed || []).forEach(function (f) {
      add({ x: f.x, y: f.y, w: f.w || 0, h: f.h || 0 });
    });
    // Candidate offsets nearest-first (ties: down before up, right before
    // left), computed once per call.
    var offsets = [];
    for (var i = -_OVERLAP_MAX_RING; i <= _OVERLAP_MAX_RING; i++) {
      for (var j = -_OVERLAP_MAX_RING; j <= _OVERLAP_MAX_RING; j++) {
        if (i === 0 && j === 0) continue;
        offsets.push({ dx: i * stepX, dy: j * stepY, d: (i * stepX) * (i * stepX) + (j * stepY) * (j * stepY) });
      }
    }
    offsets.sort(function (a, b) { return a.d - b.d || b.dy - a.dy || b.dx - a.dx; });

    var out = {};
    var farRight = null;
    items.forEach(function (it) {
      var box = { x: it.x, y: it.y, w: it.w || 0, h: it.h || 0 };
      if (collides(box)) {
        var found = null;
        for (var k = 0; k < offsets.length; k++) {
          var c = { x: it.x + offsets[k].dx, y: it.y + offsets[k].dy, w: box.w, h: box.h };
          if (!collides(c)) { found = c; break; }
        }
        if (!found) {
          // Everything within the search radius is taken (a pathological
          // pile-up): park it past the right edge of whatever is placed.
          if (farRight === null) {
            farRight = it.x;
            Object.keys(buckets).forEach(function (key) {
              buckets[key].forEach(function (b) { if (b.x > farRight) farRight = b.x; });
            });
          }
          farRight += stepX;
          found = { x: farRight, y: it.y, w: box.w, h: box.h };
        }
        box = found;
      }
      add(box);
      out[it.id] = { x: box.x, y: box.y };
    });
    return out;
  }

  // Stubs (portals) take up space like devices: a new group stub dropped
  // into a saved layout landed exactly on a device (operator exports,
  // 2026-11-07) because the guard skipped them.
  function _isLayoutDevice(n) {
    return !n.data("isLocGroup") && !n.data("isEdgeHandle");
  }
  // Live-map wrapper. `moved` (a collection or array of nodes, in priority
  // order) are the devices allowed to move; every other device holds its
  // spot. Without `moved`, every device is re-checked in graph order (the
  // first device on a spot keeps it). Returns the number of devices moved.
  function separateNodes(cy, moved, opts) {
    if (!cy) return 0;
    var list = [];
    var seen = {};
    var source = moved ? (moved.toArray ? moved.toArray() : moved) : cy.nodes().toArray();
    source.forEach(function (n) {
      if (!n || seen[n.id()] || !_isLayoutDevice(n) || n.removed()) return;
      seen[n.id()] = true;
      list.push(n);
    });
    if (list.length === 0) return 0;
    var fixed = [];
    cy.nodes().forEach(function (n) {
      if (seen[n.id()] || !_isLayoutDevice(n)) return;
      var p = n.position();
      fixed.push({ x: p.x, y: p.y, w: n.width(), h: n.height() });
    });
    var items = list.map(function (n) {
      var p = n.position();
      return { id: n.id(), x: p.x, y: p.y, w: n.width(), h: n.height() };
    });
    var placed = separatePositions(items, {
      stepX: opts && opts.stepX, stepY: opts && opts.stepY, gap: opts && opts.gap, fixed: fixed,
    });
    var count = 0;
    cy.batch(function () {
      list.forEach(function (n) {
        var p = n.position();
        var q = placed[n.id()];
        if (q && (q.x !== p.x || q.y !== p.y)) {
          n.position({ x: q.x, y: q.y });
          count++;
        }
      });
    });
    return count;
  }

  window.PolarisTopologyRender = {
    separatePositions: separatePositions,
    separateNodes: separateNodes,
    edgeTooltipHtml: edgeTooltipHtml,
    linkSpeedClass: linkSpeedClass,
    layoutAspect: layoutAspect,
    anonymisedLayout: anonymisedLayout,
    meshSignalClass: meshSignalClass,
    topologyLegendHtml: topologyLegendHtml,
    linkHoverSet: linkHoverSet,
    highlightLinkHover: highlightLinkHover,
    legendMatch: legendMatch,
    highlightLegendHover: highlightLegendHover,
    wireLegendHover: wireLegendHover,
    clearLinkHover: clearLinkHover,
    topologyLegendRow: topologyLegendRow,
    HEALTH_NODE_COLORS: HEALTH_NODE_COLORS,
    fortinetNodeColor: fortinetNodeColor,
    endpointNodeColor: endpointNodeColor,
    buildTopologyElements: buildTopologyElements,
    markPhysicalLoops: markPhysicalLoops,
    topologyStylesheet: topologyStylesheet,
    topologyLegendSpec: topologyLegendSpec,
    computeTopologyColumns: computeTopologyColumns,
    computeGroupedLayout: computeGroupedLayout,
    layoutUpstream: layoutUpstream,
    applySavedPositions: applySavedPositions,
    markFanOutEdges: markFanOutEdges,
    topologyNodeWeight: topologyNodeWeight,
    computeLocationGroups: computeLocationGroups,
    collapseLocationChains: collapseLocationChains,
    renderLocationGroups: renderLocationGroups,
    removeLocationGroups: removeLocationGroups,
    refreshLocationGroups: refreshLocationGroups,
    // Routing changes edge geometry by style bypass (no position event), so
    // the bent-link labels are re-placed after every route pass.
    // Straight links that would pass through a device are bent around it in
    // the same pass (detourStraightEdges), on a site with or without boxes.
    routeInterGroupEdges: function (cy) {
      routeInterGroupEdges(cy);
      detourStraightEdges(cy);
      refreshBentEdgeLabels(cy);
    },
    detourStraightEdges: detourStraightEdges,
    refreshBentEdgeLabels: refreshBentEdgeLabels,
    wireBentEdgeLabels: wireBentEdgeLabels,
    locationGroupTooltipParts: locationGroupTooltipParts,
    compareFloors: compareFloors,
    computeFloorViews: computeFloorViews,
    viewSwitcherRows: viewSwitcherRows,
    viewSuppressKinds: viewSuppressKinds,
    partitionElementsForFloor: partitionElementsForFloor,
  };
})();
