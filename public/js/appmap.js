// appmap.js — the Application Map page: a Cytoscape graph of application
// connectivity built from mapped-process connection facts.
//
// Data comes from GET /api/v1/application-map (see applicationMapService):
// asset nodes are compound parents, their mapped processes are child nodes,
// unresolved endpoints are grey unknown-IP nodes. Layout is a two-pass
// scheme: bundled dagre lays out the COLLAPSED asset-level graph in a
// headless Cytoscape instance (dagre doesn't handle compound graphs well),
// then each asset's process children are stacked at the parent's coordinate
// (compound parents derive their box from the children). Saved positions win
// over the computed layout: server `savedLayout` (shared, applicationMap=write)
// > localStorage (per-browser fallback for readers) > computed.
//
// Filters are client-side over the cached payload; the graph auto-refreshes
// every 60s (paused while the tab is hidden) preserving current node positions.
// Tapping any node only fills the info rail. The canonical asset-details slide-in
// (openViewModal from assets.js) opens ONLY from the rail's "Open asset details"
// button — so selecting a box to read its services and ports never throws a panel
// over the graph.
//
// Filtering is a TOKEN/PILL box: the operator types a fragment, picks from a
// suggestion dropdown built out of the current payload, and Enter turns it into a
// pill. Pills combine OR WITHIN A KIND and AND ACROSS KINDS — [tcp] [udp] [web01]
// means "(tcp or udp) traffic touching web01". Kinds: proto, port, asset (host),
// type (device type), process, service, external, and a free-text fallback. Applied pills render in a
// row BELOW the input, so a long filter set can't squeeze the typing area. The
// "Seen within" range and "Hide external" stay separate controls (a range and a
// boolean aren't tokens).
//
// Three localStorage keys, deliberately separate:
//   polaris.appmap.positions              — node positions, per BROWSER (pairs with
//                                           the shared server-side layout)
//   polaris-prefs-appmap-<user>           — last toolbar state (age / hide-external
//                                           / legend / pills)
//   polaris-prefs-appmap-filters-<user>   — NAMED saved pill sets, recalled from the
//                                           Saved menu. Pills only: silently moving
//                                           the operator's time window on recall
//                                           would be a surprise.

(function () {
  "use strict";

  var LS_KEY = "polaris.appmap.positions";
  // Per-user toolbar prefs (age / hide-external / legend / pills). Separate from
  // LS_KEY, which is per-browser and pairs with the SHARED server-side layout.
  function prefsKey() {
    var u = (typeof currentUsername !== "undefined" && currentUsername) ? currentUsername : "";
    return u ? "polaris-prefs-appmap-" + u : "";
  }
  var STALE_MS = 15 * 60 * 1000;
  var REFRESH_MS = 60 * 1000;
  // Vertical slot per child node inside an asset box. Sized for the tallest
  // child (40px — a name plus its listen-ports line) with breathing room.
  var PROC_ROW_GAP = 58;
  // Wider slot for a parent whose children connect to EACH OTHER: the edge
  // runs vertically between stacked siblings, and its autorotated two-line
  // label ("tcp/1521" + "via <ip>") needs real free space between the boxes
  // to be readable — at the default gap the edge is ~18px and unreadable.
  var INTRA_EDGE_ROW_GAP = 140;

  // Edge colours by protocol/port. Eight hues and no more: past that, two
  // ports start reading as the same colour, so the long tail draws in the
  // neutral edge colour as "Other". No red (failure vocabulary) and no grey
  // (that IS "Other"); none collides with the node fills (lilac process, teal
  // service, light-blue asset) or the amber selection ring.
  var PORT_PALETTE = ["#2f7fe0", "#f07c1e", "#2fa84f", "#a05ad8", "#e2539b", "#d4a514", "#1fb3c8", "#a87a4c"];
  // proto/port key → palette colour. Survives re-renders (the 60s refresh, a
  // filter change) so a port keeps its colour while it stays in the top set.
  var portColorByKey = {};
  var PORT_NAMES = {
    20: "ftp-data", 21: "ftp", 22: "ssh", 23: "telnet", 25: "smtp", 53: "dns", 67: "dhcp", 69: "tftp",
    80: "http", 88: "kerberos", 110: "pop3", 123: "ntp", 135: "msrpc", 137: "netbios", 139: "netbios",
    143: "imap", 161: "snmp", 162: "snmp-trap", 389: "ldap", 443: "https", 445: "smb", 464: "kpasswd",
    514: "syslog", 587: "smtp", 636: "ldaps", 993: "imaps", 1433: "mssql", 1521: "oracle",
    2049: "nfs", 3268: "gc", 3269: "gc-tls", 3306: "mysql", 3389: "rdp", 5432: "postgres",
    5671: "amqps", 5672: "amqp", 5985: "winrm", 5986: "winrm-tls", 6379: "redis", 8080: "http-alt",
    8443: "https-alt", 9200: "elastic", 27017: "mongodb",
  };

  var cy = null;
  var payload = null;         // last server payload
  var refreshTimer = null;
  var saveTimer = null;
  var selectedId = null;
  // Active filter pills: [{ kind, value }]. kind ∈ proto | port | asset | type |
  // process | service | external | text. `value` is the match target — for
  // node-scope kinds it's the label the catalog offered.
  var filterPills = [];
  var suggestItems = [];      // current dropdown contents
  var suggestIndex = -1;      // highlighted row, -1 = none

  document.addEventListener("DOMContentLoaded", async function () {
    if (!document.getElementById("appmap-graph")) return; // not this page
    // Permissions must be loaded before gated UI (reset-layout button, layout
    // persistence target) is wired — same sequencing as map.js.
    if (typeof fetchCurrentUser === "function") await fetchCurrentUser();
    wireToolbar();
    loadGraph(false);
    refreshTimer = setInterval(function () {
      if (!document.hidden) loadGraph(true);
    }, REFRESH_MS);
    window.addEventListener("beforeunload", function () {
      if (refreshTimer) clearInterval(refreshTimer);
    });
  });

  // The FAMILY, not the theme id: appmapStylesheet branches on
  // `theme === "dark"`, and there are three themes but two palettes.
  function pageTheme() {
    return (typeof isLightTheme === "function" && isLightTheme()) ? "light" : "dark";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fadeStaleEnabled() {
    var el = document.getElementById("appmap-fade-stale");
    return el ? el.checked : true; // default on = the historical behaviour
  }

  function canWriteLayout() {
    return typeof permAtLeast === "function" && permAtLeast("applicationMap", "write");
  }

  // Process and service nodes are both compound children of an asset box and
  // are handled uniformly by the layout / filter passes.
  function isChildNode(kind) {
    return kind === "process" || kind === "service";
  }

  // ─── Per-user toolbar prefs ────────────────────────────────────────
  //
  // Convention: polaris-prefs-<scope>-<username>, one JSON blob, absent entry =
  // defaults (never store defaults). Restore runs from wireToolbar(), which is
  // called after fetchCurrentUser() so currentUsername is populated.

  function savePrefs() {
    var key = prefsKey();
    if (!key) return;
    try {
      var ageEl = document.getElementById("appmap-age");
      var legend = document.getElementById("appmap-legend");
      var prev = readPrefs() || {};
      // The select is empty until the first payload builds its options, so
      // reading it before then would persist Number("") = 0 ("all retained") and
      // clobber the operator's saved range. Keep the previous value until real
      // options exist.
      var age = (ageEl && ageEl.options.length) ? Number(ageEl.value)
        : (typeof prev.age === "number" ? prev.age : null);
      localStorage.setItem(key, JSON.stringify({
        age: age,
        hideExternal: !!(document.getElementById("appmap-hide-external") || {}).checked,
        hideWorkstations: !!(document.getElementById("appmap-hide-workstations") || {}).checked,
        fadeStale: fadeStaleEnabled(),
        legend: !!(legend && !legend.hidden),
        portLegendCollapsed: portLegendCollapsed(),
        pills: filterPills,
      }));
    } catch (e) { /* quota / private mode — prefs are best-effort */ }
  }

  function readPrefs() {
    var key = prefsKey();
    if (!key) return null;
    try {
      var raw = JSON.parse(localStorage.getItem(key) || "null");
      return (raw && typeof raw === "object") ? raw : null;
    } catch (e) { return null; }
  }

  // Restore the pills + booleans immediately; `age` is deferred to
  // applyAgeOptions() because the option list depends on the server's retention
  // window, which isn't known until the first payload lands.
  function restorePrefs() {
    var p = readPrefs();
    if (!p) return;
    if (Array.isArray(p.pills)) {
      // Validate the kind against the known list: an unrecognized kind (stale
      // blob, hand-edited storage) would render as a pill that silently filters
      // nothing, which reads as a broken filter box.
      filterPills = p.pills.filter(function (x) {
        return x && typeof x.value === "string" &&
          (x.kind === "proto" || x.kind === "port" || SCOPE_KINDS.indexOf(x.kind) >= 0);
      });
      renderPills();
    }
    var he = document.getElementById("appmap-hide-external");
    if (he && typeof p.hideExternal === "boolean") he.checked = p.hideExternal;
    var hw = document.getElementById("appmap-hide-workstations");
    if (hw && typeof p.hideWorkstations === "boolean") hw.checked = p.hideWorkstations;
    var fs = document.getElementById("appmap-fade-stale");
    if (fs && typeof p.fadeStale === "boolean") fs.checked = p.fadeStale;
    var legend = document.getElementById("appmap-legend");
    if (legend && p.legend === true) legend.hidden = false;
    if (p.portLegendCollapsed === true) setPortLegendCollapsed(true);
  }

  function portLegendCollapsed() {
    var el = document.getElementById("appmap-port-legend");
    return !!(el && el.classList.contains("collapsed"));
  }

  function setPortLegendCollapsed(collapsed) {
    var el = document.getElementById("appmap-port-legend");
    if (!el) return;
    el.classList.toggle("collapsed", collapsed);
    var btn = document.getElementById("appmap-port-legend-toggle");
    if (btn) {
      btn.innerHTML = collapsed ? "+" : "&minus;";
      btn.title = collapsed ? "Expand" : "Collapse";
      btn.setAttribute("aria-label", collapsed ? "Expand ports key" : "Collapse ports key");
      btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    }
  }

  // ─── "Seen within" options (bounded by the server's retention window) ──

  var AGE_STEPS = [
    { sec: 600,     label: "Live (10 min)" },
    { sec: 3600,    label: "1 hour" },
    { sec: 86400,   label: "24 hours" },
    { sec: 604800,  label: "7 days" },
    { sec: 2592000, label: "30 days" },
  ];
  var DEFAULT_AGE_SEC = 86400;

  // Rebuild the select from `retentionDays` so the widest option states the real
  // window instead of an unqualified "All retained" that used to mean 7 days
  // regardless of what was kept. A saved age beyond the window is clamped rather
  // than silently selecting an option that shows nothing.
  function applyAgeOptions(retentionDays) {
    var sel = document.getElementById("appmap-age");
    if (!sel) return;
    var forever = retentionDays === -1;
    var windowSec = forever ? Infinity : Math.max(0, Number(retentionDays) || 0) * 86400;
    var html = "";
    AGE_STEPS.forEach(function (s) {
      // Keep a step only if the retained window can actually satisfy it.
      if (s.sec <= windowSec) html += '<option value="' + s.sec + '">' + esc(s.label) + "</option>";
    });
    var allLabel = forever ? "All retained (no limit)"
      : "All retained (" + retentionDays + (retentionDays === 1 ? " day" : " days") + ")";
    html += '<option value="0">' + esc(allLabel) + "</option>";
    sel.innerHTML = html;

    var want = null;
    var p = readPrefs();
    if (p && typeof p.age === "number") want = p.age;
    if (want == null) want = DEFAULT_AGE_SEC;
    // 0 ("all") is always present; otherwise fall back to the widest step that
    // still fits, else "all".
    var have = Array.prototype.map.call(sel.options, function (o) { return Number(o.value); });
    if (have.indexOf(want) < 0) {
      var fits = have.filter(function (v) { return v > 0 && v <= want; });
      want = fits.length ? Math.max.apply(null, fits) : 0;
    }
    sel.value = String(want);
  }

  // ─── Filters ───────────────────────────────────────────────────────

  function currentFilters() {
    var age = Number((document.getElementById("appmap-age") || {}).value || 86400);
    return {
      ageMs: age > 0 ? age * 1000 : 0,
      hideExternal: !!(document.getElementById("appmap-hide-external") || {}).checked,
      hideWorkstations: !!(document.getElementById("appmap-hide-workstations") || {}).checked,
      pills: filterPills,
    };
  }

  var SCOPE_KINDS = ["asset", "type", "process", "service", "external", "text"];

  // The searchable text of a node, per pill kind. `text` pills deliberately look
  // at everything so a half-remembered fragment still lands somewhere.
  function nodeHaystack(n, kind) {
    var out = [];
    function add(v) { if (v) out.push(String(v).toLowerCase()); }
    if (kind === "asset" || kind === "text") {
      if (n.kind === "asset") { add(n.hostname); add(n.ipAddress); add(n.assetId); }
    }
    // Device type is asset-level, so a `type` pill matches asset nodes and the
    // group-builder expands it to their children (an asset's traffic flows through
    // its process/service boxes). Deliberately NOT folded into `text`: a bare
    // "server" would then match most of the fleet and read as a broken filter.
    if (kind === "type") {
      if (n.kind === "asset") add(n.assetType);
    }
    if (kind === "process" || kind === "text") {
      if (n.kind === "process") add(n.processName);
    }
    if (kind === "service" || kind === "text") {
      if (n.kind === "service") add(n.serviceUnit);
    }
    if (kind === "external" || kind === "text") {
      if (String(n.kind).indexOf("unknown-") === 0) {
        add(n.ip); add(n.cidr); add(n.ipHostname);
        (n.ips || []).forEach(add);
      }
    }
    return out;
  }

  // Substring, not equality: catalog-sourced values are full labels (so it
  // behaves as equality for them) while a hand-typed fragment still matches.
  function nodeMatchesPill(n, pill) {
    var v = String(pill.value || "").toLowerCase();
    if (!v) return false;
    return nodeHaystack(n, pill.kind).some(function (h) { return h.indexOf(v) >= 0; });
  }

  /**
   * PURE filter core — exposed on window.PolarisAppMap for unit tests.
   *
   * Pills combine OR within a kind and AND across kinds:
   *   - proto / port pills filter an edge's PORT LIST; when either kind is
   *     present the edge must retain at least one port (a genuinely port-less
   *     edge is exempt, as before).
   *   - Each node-scope kind (asset / process / service / external / text) with
   *     pills becomes a group: a Set of matching node ids, with asset pills
   *     expanded to that asset's children because an asset's traffic flows
   *     through its process/service boxes. An edge survives only if EVERY group
   *     has a matching endpoint.
   *   - A node is visible if a surviving edge references it, or if it satisfies
   *     every group itself (counting its parent and its children as proxies) —
   *     that second clause is what keeps a pinned-but-edgeless process/service
   *     on screen when it's exactly what the operator filtered to.
   */
  function applyGraphFilter(allNodes, allEdges, f, now) {
    var pills = f.pills || [];
    var childrenOf = {};
    allNodes.forEach(function (n) {
      if (isChildNode(n.kind) && n.parent) (childrenOf[n.parent] = childrenOf[n.parent] || []).push(n.id);
    });

    // Hide-workstations: workstation asset boxes, their children, and every
    // edge touching either. Unlike a `type` pill (which narrows TO a type),
    // this excludes one — the two compose.
    var wsHidden = {};
    if (f.hideWorkstations) {
      allNodes.forEach(function (n) {
        if (n.kind === "asset" && String(n.assetType || "").toLowerCase() === "workstation") {
          wsHidden[n.id] = true;
          (childrenOf[n.id] || []).forEach(function (cid) { wsHidden[cid] = true; });
        }
      });
    }

    var protoVals = {}, protoAny = false;
    var portVals = {}, portAny = false;
    pills.forEach(function (p) {
      if (p.kind === "proto") { protoVals[String(p.value).toLowerCase()] = true; protoAny = true; }
      if (p.kind === "port")  { portVals[String(p.value)] = true; portAny = true; }
    });

    // Node-scope groups, in a stable order so behaviour doesn't depend on the
    // order the operator happened to add pills in.
    var groups = [];
    SCOPE_KINDS.forEach(function (kind) {
      var mine = pills.filter(function (p) { return p.kind === kind; });
      if (!mine.length) return;
      var set = {};
      allNodes.forEach(function (n) {
        if (!mine.some(function (p) { return nodeMatchesPill(n, p); })) return;
        set[n.id] = true;
        if (n.kind === "asset") (childrenOf[n.id] || []).forEach(function (cid) { set[cid] = true; });
      });
      groups.push(set);
    });

    var edges = [];
    for (var i = 0; i < allEdges.length; i++) {
      var e = allEdges[i];
      if (f.ageMs > 0 && now - Date.parse(e.lastSeen) > f.ageMs) continue;
      var ports = e.ports.filter(function (p) {
        if (protoAny && !protoVals[String(p.proto).toLowerCase()]) return false;
        if (portAny && !portVals[String(p.port)]) return false;
        return true;
      });
      if ((protoAny || portAny) && ports.length === 0 && e.ports.length > 0) continue;
      if (f.hideExternal && (isUnknownId(e.source) || isUnknownId(e.target))) continue;
      if (f.hideWorkstations && (wsHidden[e.source] || wsHidden[e.target])) continue;
      var scoped = groups.every(function (g) { return g[e.source] || g[e.target]; });
      if (!scoped) continue;
      edges.push({ edge: e, ports: ports });
    }

    var referenced = {};
    edges.forEach(function (r) { referenced[r.edge.source] = true; referenced[r.edge.target] = true; });

    // Parent and children act as proxies so an asset box and its children agree
    // about whether they satisfy a group (see the doc comment).
    function satisfiesAllGroups(n) {
      if (!groups.length) return false;
      var related = [n.id];
      if (n.parent) related.push(n.parent);
      (childrenOf[n.id] || []).forEach(function (cid) { related.push(cid); });
      return groups.every(function (g) {
        return related.some(function (id) { return g[id]; });
      });
    }

    var nodes = allNodes.filter(function (n) {
      if (f.hideWorkstations && wsHidden[n.id]) return false;
      var isExternal = !(n.kind === "asset" || isChildNode(n.kind));
      if (isExternal && f.hideExternal) return false;
      if (groups.length) {
        // Under an active scope nothing is kept unconditionally — otherwise every
        // unrelated asset box would still render and the filter wouldn't narrow.
        return !!referenced[n.id] || satisfiesAllGroups(n);
      }
      if (!isExternal) {
        // Resolved-target assets with no mapped processes/services only matter
        // while an edge points at them.
        if (n.kind === "asset" && n.hasMappedProcesses === false) return !!referenced["" + n.id];
        return true;
      }
      return !!referenced[n.id];
    });

    // Compound boxes must render for any visible child.
    var visible = {};
    nodes.forEach(function (n) { visible[n.id] = true; });
    var addedParents = [];
    nodes.forEach(function (n) {
      if (isChildNode(n.kind) && n.parent && !visible[n.parent]) {
        visible[n.parent] = true;
        addedParents.push(n.parent);
      }
    });
    if (addedParents.length) {
      allNodes.forEach(function (n) { if (addedParents.indexOf(n.id) >= 0) nodes.push(n); });
    }

    // Guard against DANGLING references before they reach cytoscape/dagre: a
    // process node whose parent asset isn't in the set, or an edge whose
    // source/target has no node, makes the layout throw ("Cannot set properties
    // of null (setting 'hidden')") and fails the whole render. This happens when
    // connection rows (or mapped-process pins) outlive the process/asset that
    // owned them — e.g. a mapped process that no longer exists in inventory.
    // Drop the orphans; the rest of the graph still renders.
    var nodeIds = {};
    nodes.forEach(function (n) { nodeIds[n.id] = true; });
    nodes = nodes.filter(function (n) {
      return !(isChildNode(n.kind) && n.parent && !nodeIds[n.parent]);
    });
    nodeIds = {};
    nodes.forEach(function (n) { nodeIds[n.id] = true; });
    var cleanEdges = edges.filter(function (r) {
      return nodeIds[r.edge.source] && nodeIds[r.edge.target];
    });
    return { nodes: nodes, edges: cleanEdges };
  }

  function filterGraph(f) {
    return applyGraphFilter(payload.nodes, payload.edges, f, Date.now());
  }

  function isUnknownId(id) {
    return id.indexOf("ip:") === 0 || id.indexOf("ipgroup:") === 0;
  }

  // ─── Elements + stylesheet ─────────────────────────────────────────

  // Listening ports as a compact second label line for child nodes. A process or
  // service that listens but has no observed peers has NO edges, so without this
  // its box shows only a name and looks like nothing was collected — the listen
  // ports are the whole signal in that case.
  function listenSuffix(n) {
    var groups = consolidatePorts(n.listenPorts);
    if (!groups.length) return "";
    var parts = groups.slice(0, 3).map(function (g) { return g.label; });
    var extra = groups.length - 3;
    return "\n" + parts.join(", ") + (extra > 0 ? " +" + extra : "");
  }

  // ─── Listening-port consolidation ──────────────────────────────────
  //
  // A service bound to a contiguous block (Oracle GoldenGate takes tcp/9000-9004,
  // tcp/9011-9014, …) otherwise renders one row per port and buries the shape of
  // the allocation in a wall of near-identical lines. Collapse runs of THREE OR
  // MORE consecutive ports within the same protocol into "9000-9004"; a pair stays
  // listed separately, since "9000, 9001" is clearer than "9000-9001". Protocols
  // never merge — tcp/9000 and udp/9000 are unrelated facts.
  //
  // PURE (exposed for tests): [{proto, port}] → [{proto, label, from, to, count}]
  // ordered by protocol then first port.
  function consolidatePorts(listenPorts) {
    var byProto = {};
    (listenPorts || []).forEach(function (p) {
      if (!p || p.port == null) return;
      var port = Number(p.port);
      if (!isFinite(port)) return;
      var proto = String(p.proto || "").toLowerCase();
      (byProto[proto] = byProto[proto] || []).push(port);
    });
    var out = [];
    Object.keys(byProto).sort().forEach(function (proto) {
      // Numeric sort + dedup — the same port arrives twice when a service binds it
      // on several addresses.
      var ports = byProto[proto].sort(function (a, b) { return a - b; })
        .filter(function (v, i, arr) { return i === 0 || v !== arr[i - 1]; });
      var i = 0;
      while (i < ports.length) {
        var start = ports[i];
        var end = start;
        while (i + 1 < ports.length && ports[i + 1] === end + 1) { i++; end = ports[i]; }
        if (end - start >= 2) {
          out.push({ proto: proto, from: start, to: end, count: end - start + 1,
                     label: proto + "/" + start + "-" + end });
        } else {
          // Run of 1 or 2 — emit each port on its own.
          for (var v = start; v <= end; v++) {
            out.push({ proto: proto, from: v, to: v, count: 1, label: proto + "/" + v });
          }
        }
        i++;
      }
    });
    return out;
  }

  function nodeLabel(n) {
    if (n.kind === "asset") return n.hostname || n.ipAddress || n.assetId || "asset";
    if (n.kind === "process") return (n.processName || "process") + listenSuffix(n);
    if (n.kind === "service") return (n.serviceUnit || "service") + listenSuffix(n);
    if (n.kind === "unknown-ip") {
      // Registry-named IPs read as the name with the address beneath, so the
      // operator still sees which address it was.
      return n.ipHostname ? n.ipHostname + "\n" + (n.ip || "") : (n.ip || "?");
    }
    if (n.kind === "unknown-ip-group") return (n.cidr || "?") + "\n" + ((n.ips || []).length) + " hosts";
    if (n.kind === "unknown-overflow") return "+" + (n.overflowCount || 0) + " external";
    return n.id;
  }

  // Longest line of a (possibly multi-line) label — child nodes carry a second
  // listen-ports line that can be WIDER than the name, so sizing off the whole
  // string or off line 1 alone both get it wrong.
  function labelWidthChars(label) {
    var max = 0;
    String(label).split("\n").forEach(function (line) { if (line.length > max) max = line.length; });
    return max;
  }

  function edgeLabel(ports, overflow) {
    var parts = ports.slice(0, 3).map(function (p) { return p.proto + "/" + p.port; });
    var extra = ports.length - 3 + (overflow || 0);
    return parts.join(", ") + (extra > 0 ? " +" + extra : "");
  }

  // ─── Port colours ──────────────────────────────────────────────────
  //
  // An edge can carry several ports; it is drawn in the colour of its DOMINANT
  // one — the most-seen, ties to the lower port number. That is the order
  // applicationMapService sorts an edge's ports in, so the colour always
  // names the FIRST port in the edge's label.
  //
  // PURE (exposed for tests): [{proto, port, count}] → "tcp/443" | null.
  function edgePortKey(ports) {
    var best = null;
    (ports || []).forEach(function (p) {
      if (!p || p.port == null) return;
      var c = Number(p.count) || 0;
      if (!best || c > best.c || (c === best.c && Number(p.port) < best.port)) {
        best = { c: c, port: Number(p.port), key: String(p.proto || "tcp").toLowerCase() + "/" + p.port };
      }
    });
    return best ? best.key : null;
  }

  // PURE (exposed for tests): which keys get a colour, and which colour.
  // `keys` is one dominant key per visible edge (nulls ignored). The most
  // common keys — up to the palette size — are coloured; a key already in
  // `prev` keeps its colour so a refresh or a filter change never repaints a
  // port the operator has learned, and newcomers take the free colours in rank
  // order. Returns { colors: {key → colour}, legend: [{key, color, count}],
  // otherCount } with the legend in rank order.
  function assignPortColors(keys, prev, palette) {
    palette = palette || PORT_PALETTE;
    prev = prev || {};
    var counts = {};
    (keys || []).forEach(function (k) { if (k) counts[k] = (counts[k] || 0) + 1; });
    var ranked = Object.keys(counts).sort(function (a, b) {
      if (counts[b] !== counts[a]) return counts[b] - counts[a];
      var pa = Number(a.split("/")[1]), pb = Number(b.split("/")[1]);
      return pa !== pb ? pa - pb : (a < b ? -1 : a > b ? 1 : 0);
    });
    var top = ranked.slice(0, palette.length);
    var colors = {}, used = {};
    top.forEach(function (k) {
      var c = prev[k];
      if (c && palette.indexOf(c) >= 0 && !used[c]) { colors[k] = c; used[c] = true; }
    });
    var free = palette.filter(function (c) { return !used[c]; });
    top.forEach(function (k) { if (!colors[k]) colors[k] = free.shift(); });
    var otherCount = 0;
    ranked.slice(palette.length).forEach(function (k) { otherCount += counts[k]; });
    return {
      colors: colors,
      legend: top.map(function (k) { return { key: k, color: colors[k], count: counts[k] }; }),
      otherCount: otherCount,
    };
  }

  function portServiceName(key) {
    var n = Number(String(key).split("/")[1]);
    return PORT_NAMES[n] || "";
  }

  // Bottom-left legend for the edge colours. Built from what is DRAWN, so a
  // filter that drops a port drops its row too.
  function renderPortLegend(assign) {
    var el = document.getElementById("appmap-port-legend");
    if (!el) return;
    if (!assign || (!assign.legend.length && !assign.otherCount)) { el.hidden = true; return; }
    var rows = assign.legend.map(function (r) {
      var svc = portServiceName(r.key);
      return '<div class="appmap-port-legend-row">' +
        '<span class="appmap-port-legend-line" style="border-color:' + r.color + '"></span>' +
        '<span class="appmap-port-legend-key">' + esc(r.key) + "</span>" +
        (svc ? '<span class="appmap-port-legend-svc">' + esc(svc) + "</span>" : "") +
        '<span class="appmap-port-legend-count" title="Connections drawn in this colour">' + r.count + "</span>" +
        "</div>";
    }).join("");
    if (assign.otherCount) {
      rows += '<div class="appmap-port-legend-row">' +
        '<span class="appmap-port-legend-line" style="border-color:' + neutralEdgeColor(pageTheme()) + '"></span>' +
        '<span class="appmap-port-legend-key">Other</span>' +
        '<span class="appmap-port-legend-count" title="Connections drawn in this colour">' + assign.otherCount + "</span>" +
        "</div>";
    }
    var body = el.querySelector(".appmap-port-legend-body");
    if (body) body.innerHTML = rows;
    el.hidden = false;
  }

  // Distinct observed addresses across an edge's ports (server caps each
  // port's list; this is display-side dedup only).
  function edgeIps(ports) {
    var out = [];
    (ports || []).forEach(function (p) {
      (p.ips || []).forEach(function (ip) {
        if (out.indexOf(ip) < 0) out.push(ip);
      });
    });
    return out;
  }

  // Second label line for SAME-ASSET edges: which of the host's addresses the
  // service actually dialed. Only intra-asset edges get it — everywhere else
  // the target node already names the destination, and the full per-port IP
  // list lives in the edge info rail. (No loopback ever shows here: the agent
  // drops loopback peers at collection, so a drawn edge is real-IP-stack by
  // definition.)
  function edgeViaSuffix(ports) {
    var ips = edgeIps(ports);
    if (!ips.length) return "";
    return "\nvia " + ips[0] + (ips.length > 1 ? " +" + (ips.length - 1) : "");
  }

  function buildElements(g, portColors) {
    portColors = portColors || {};
    var now = Date.now();
    var els = [];
    var parentById = {};
    g.nodes.forEach(function (n) {
      if (isChildNode(n.kind) && n.parent) parentById[n.id] = n.parent;
    });
    g.nodes.forEach(function (n) {
      var data = {
        id: n.id,
        label: nodeLabel(n),
        kind: n.kind,
        hasIcon: n.iconUrl ? 1 : 0,
      };
      if (n.iconUrl) data.iconUrl = n.iconUrl;
      if (isChildNode(n.kind) && n.parent) data.parent = n.parent;
      // Data-driven width/height for child (process/service) nodes: size the box
      // to the label so long unit names (e.g. "truckscale-central.service")
      // aren't clipped. cytoscape's width:"label" mis-measures when the monospace
      // webfont isn't loaded yet; ~7.6px/char at 11px mono + padding is safe.
      // Height grows for the second (listen-ports) line when there is one.
      if (isChildNode(n.kind)) {
        data.w = Math.max(46, Math.round(labelWidthChars(data.label) * 7.6) + 20);
        data.h = String(data.label).indexOf("\n") >= 0 ? 40 : 26;
      }
      els.push({ group: "nodes", data: data });
    });
    g.edges.forEach(function (r) {
      var e = r.edge;
      // Staleness is a RENDER option, not a filter: the edge is always present,
      // it's only dimmed. With the toggle off, nothing is marked stale so every
      // edge draws at full opacity.
      var stale = fadeStaleEnabled() && now - Date.parse(e.lastSeen) > STALE_MS;
      var ports = r.ports.length ? r.ports : e.ports;
      var intra = parentById[e.source] && parentById[e.source] === parentById[e.target];
      var data = {
        id: e.id,
        source: e.source,
        target: e.target,
        kind: e.kind,
        label: edgeLabel(ports, e.portOverflow) + (intra ? edgeViaSuffix(ports) : ""),
        stale: stale ? 1 : 0,
      };
      // Only coloured ports carry `pcolor`; the rest fall through to the
      // neutral edge colour, which the legend calls "Other".
      var pkey = edgePortKey(ports);
      if (pkey && portColors[pkey]) data.pcolor = portColors[pkey];
      els.push({ group: "edges", data: data });
    });
    return els;
  }

  // The uncoloured edge — also the Ports key's "Other" swatch.
  function neutralEdgeColor(theme) {
    return theme === "dark" ? "#6a7388" : "#9aa2b1";
  }

  function appmapStylesheet(theme) {
    var isDark = theme === "dark";
    var textColor = isDark ? "#eef0f4" : "#1a1a1a";
    var edgeColor = neutralEdgeColor(theme);
    return [
      // Compound asset parent — translucent rounded box, label top-left.
      {
        selector: 'node[kind="asset"]',
        style: {
          shape: "round-rectangle",
          "background-color": "#4fc3f7",
          "background-opacity": isDark ? 0.08 : 0.10,
          "border-width": 1.5,
          "border-color": "#4fc3f7",
          label: "data(label)",
          color: textColor,
          "font-size": "12px",
          "font-weight": 600,
          "font-family": "Inter, system-ui, sans-serif",
          "text-valign": "top",
          "text-halign": "center",
          "text-margin-y": -6,
          padding: 14,
        },
      },
      // Process child node.
      {
        selector: 'node[kind="process"]',
        style: {
          shape: "round-rectangle",
          width: "data(w)",
          height: "data(h)",
          "text-wrap": "wrap",
          padding: 6,
          "background-color": "#7e57c2",
          "border-width": 1.5,
          "border-color": isDark ? "#b39ddb" : "#5e35b1",
          label: "data(label)",
          color: "#ffffff",
          "font-size": "11px",
          "font-family": "Roboto Mono, monospace",
          "text-valign": "center",
          "text-halign": "center",
        },
      },
      // Service child node — teal, to distinguish from process purple.
      {
        selector: 'node[kind="service"]',
        style: {
          shape: "round-rectangle",
          width: "data(w)",
          height: "data(h)",
          "text-wrap": "wrap",
          padding: 6,
          "background-color": "#00897b",
          "border-width": 1.5,
          "border-color": isDark ? "#4db6ac" : "#00695c",
          label: "data(label)",
          color: "#ffffff",
          "font-size": "11px",
          "font-family": "Roboto Mono, monospace",
          "text-valign": "center",
          "text-halign": "center",
        },
      },
      // Unknown externals — grey, dashed.
      {
        selector: 'node[kind="unknown-ip"], node[kind="unknown-ip-group"], node[kind="unknown-overflow"]',
        style: {
          shape: "ellipse",
          width: 34,
          height: 34,
          "background-color": isDark ? "#4a4f5a" : "#bdbdbd",
          "border-width": 1.5,
          "border-style": "dashed",
          "border-color": isDark ? "#8a8f9a" : "#757575",
          label: "data(label)",
          color: textColor,
          "text-wrap": "wrap",
          "font-size": "10px",
          "font-family": "Roboto Mono, monospace",
          "text-valign": "bottom",
          "text-margin-y": 5,
        },
      },
      // Vendor icon overlay on asset boxes (recipe from topology-render.js —
      // background-fit: contain alone is the predictable combination).
      {
        selector: 'node[kind="asset"][hasIcon = 1]',
        style: {
          "background-image": "data(iconUrl)",
          "background-fit": "contain",
          "background-clip": "node",
          "background-image-containment": "inside",
          "background-image-opacity": 0.18,
          "background-position-x": "50%",
          "background-position-y": "50%",
        },
      },
      {
        selector: "edge",
        style: {
          width: 1.8,
          "curve-style": "bezier",
          "line-color": edgeColor,
          "target-arrow-shape": "triangle",
          "target-arrow-color": edgeColor,
          "arrow-scale": 0.9,
          label: "data(label)",
          color: textColor,
          "font-size": "9px",
          "font-family": "Roboto Mono, monospace",
          // Intra-asset edges carry a second "via <ip>" line; without wrap
          // cytoscape renders the \n as a literal glyph.
          "text-wrap": "wrap",
          "text-background-color": isDark ? "#1c2029" : "#ffffff",
          "text-background-opacity": 0.85,
          "text-background-padding": 2,
          "text-rotation": "autorotate",
        },
      },
      // Colour says WHICH protocol/port (the bottom-left legend); the edge kind
      // is carried by stroke instead — heavier for process → process, dashed
      // for external — so the two readings never fight over one channel.
      { selector: "edge[pcolor]", style: { "line-color": "data(pcolor)", "target-arrow-color": "data(pcolor)" } },
      { selector: 'edge[kind="process"]', style: { width: 2.6 } },
      { selector: 'edge[kind="external"], edge[kind="external-inbound"]', style: { "line-style": "dashed" } },
      { selector: "edge[stale = 1]", style: { opacity: 0.35 } },
      { selector: "node:selected", style: { "border-width": 3, "border-color": "#ffb300" } },
      { selector: "edge:selected", style: { width: 3 } },
      // Hover highlight — a stale edge renders at 0.35 opacity, which makes its
      // port label hard to read; under the pointer it goes fully opaque and
      // rises above its neighbours. Cytoscape has no :hover selector, so
      // wireGraphEvents toggles this class on mouseover/mouseout. Declared LAST
      // so it wins over the stale-opacity and :selected rules above.
      {
        selector: "edge.appmap-hover",
        style: {
          opacity: 1,
          width: 3,
          "text-background-opacity": 1,
          "z-index": 999,
        },
      },
    ];
  }

  // ─── Two-pass layout ───────────────────────────────────────────────

  // Pass 1: dagre over the COLLAPSED asset-level graph (process/service
  // endpoints fold into their parent asset). Each collapsed asset node is sized
  // to the box its stacked children will actually occupy, so dagre reserves
  // room and neighbouring boxes don't overlap. Pass 2: stack each asset's
  // children vertically at the parent's dagre coordinate. Returns positions for
  // child + plain nodes only (compound parents derive their box).
  function computeLayout(g) {
    var nodeById = {};
    g.nodes.forEach(function (n) { nodeById[n.id] = n; });

    var parentOf = {};
    g.nodes.forEach(function (n) {
      if (isChildNode(n.kind) && n.parent) parentOf[n.id] = n.parent;
    });
    var collapsedNodes = {};
    g.nodes.forEach(function (n) {
      if (!isChildNode(n.kind)) collapsedNodes[n.id] = true;
    });
    // Children per parent — drives both the reserved box size (below) and the
    // stacked child positions (pass 2).
    var childrenByParent = {};
    g.nodes.forEach(function (n) {
      if (!isChildNode(n.kind) || !n.parent) return;
      (childrenByParent[n.parent] = childrenByParent[n.parent] || []).push(n.id);
    });

    // Intra-asset child↔child edges (a service dialing a sibling on the same
    // host). Their parents stack children on the WIDER gap so the edge and its
    // label have room, and connected siblings are ordered adjacent so the edge
    // doesn't lance through unrelated children between them.
    var intraAdj = {};     // parentId → { childId: [connected sibling ids] }
    g.edges.forEach(function (r) {
      var ps = parentOf[r.edge.source];
      var pt = parentOf[r.edge.target];
      if (!ps || ps !== pt || r.edge.source === r.edge.target) return;
      var adj = (intraAdj[ps] = intraAdj[ps] || {});
      (adj[r.edge.source] = adj[r.edge.source] || []).push(r.edge.target);
      (adj[r.edge.target] = adj[r.edge.target] || []).push(r.edge.source);
    });
    function rowGapFor(pid) {
      return intraAdj[pid] ? INTRA_EDGE_ROW_GAP : PROC_ROW_GAP;
    }
    // Deterministic child order: alphabetical, except parents with intra-asset
    // edges cluster connected siblings together (DFS over the sibling
    // adjacency, seeded and visited in sorted order).
    function orderedKids(pid) {
      var kids = (childrenByParent[pid] || []).slice().sort();
      var adj = intraAdj[pid];
      if (!adj) return kids;
      var out = [];
      var seen = {};
      function visit(id) {
        if (seen[id]) return;
        seen[id] = true;
        out.push(id);
        (adj[id] || []).slice().sort().forEach(function (nb) {
          if (kids.indexOf(nb) >= 0) visit(nb);
        });
      }
      kids.forEach(visit);
      return out;
    }

    // Reserved bounding box for a collapsed node: children stack rowGapFor()
    // apart (height) and the box is as wide as its widest child label
    // (~7.3px/char in the 11px monospace child font) + padding. Childless
    // collapsed nodes (unknown IPs, resolved-target assets) get a small box.
    function boxSize(id) {
      var kids = childrenByParent[id];
      if (!kids || kids.length === 0) return { w: 70, h: 70 };
      var maxChars = 6;
      kids.forEach(function (kid) {
        var chars = nodeById[kid] ? labelWidthChars(nodeLabel(nodeById[kid])) : 0;
        if (chars > maxChars) maxChars = chars;
      });
      return {
        w: Math.max(150, Math.round(maxChars * 7.3) + 48),
        h: kids.length * rowGapFor(id) + 48,
      };
    }

    var collapsedEdges = {};
    g.edges.forEach(function (r) {
      var s = parentOf[r.edge.source] || r.edge.source;
      var t = parentOf[r.edge.target] || r.edge.target;
      if (s === t) return;
      // Both collapsed endpoints must be real nodes — an edge to a phantom node
      // makes cytoscape-dagre throw. (filterGraph already drops dangling edges;
      // this is defense in depth for the collapsed projection.)
      if (!collapsedNodes[s] || !collapsedNodes[t]) return;
      collapsedEdges[s + "|" + t] = { source: s, target: t };
    });
    var els = [];
    Object.keys(collapsedNodes).forEach(function (id) {
      var sz = boxSize(id);
      els.push({ group: "nodes", data: { id: id, w: sz.w, h: sz.h } });
    });
    Object.keys(collapsedEdges).forEach(function (k) {
      var e = collapsedEdges[k];
      els.push({ group: "edges", data: { id: "ce:" + k, source: e.source, target: e.target } });
    });
    // styleEnabled + a data-driven width/height mapper so dagre reads each
    // node's real bounding box (cytoscape-dagre spaces nodes by width()/height()
    // + nodeSep/rankSep — the gaps are box-edge to box-edge).
    var head = cytoscape({
      headless: true,
      elements: els,
      styleEnabled: true,
      style: [{ selector: "node", style: { width: "data(w)", height: "data(h)" } }],
    });
    head.layout({ name: "dagre", rankDir: "LR", nodeSep: 45, rankSep: 130 }).run();
    var anchor = {};
    head.nodes().forEach(function (n) {
      anchor[n.id()] = { x: n.position("x"), y: n.position("y") };
    });
    head.destroy();

    var positions = {};
    // Plain nodes take the dagre coordinate directly.
    g.nodes.forEach(function (n) {
      if (!isChildNode(n.kind) && anchor[n.id]) positions[n.id] = anchor[n.id];
    });
    // Children stack centered on the parent's coordinate — adjacency-ordered,
    // on the wider gap when siblings connect to each other.
    Object.keys(childrenByParent).forEach(function (pid) {
      var kids = orderedKids(pid);
      var base = anchor[pid] || { x: 0, y: 0 };
      var gap = rowGapFor(pid);
      kids.forEach(function (kid, i) {
        positions[kid] = { x: base.x, y: base.y + (i - (kids.length - 1) / 2) * gap };
      });
    });
    return positions;
  }

  function loadLocalPositions() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) || "null") || null;
    } catch (e) { return null; }
  }

  function resolvePositions(g, preserved) {
    var computed = computeLayout(g);
    var saved = (payload.savedLayout && payload.savedLayout.positions) || loadLocalPositions() || {};
    var out = {};
    Object.keys(computed).forEach(function (id) {
      out[id] = (preserved && preserved[id]) || saved[id] || computed[id];
    });
    return out;
  }

  function capturePositions() {
    if (!cy) return null;
    var out = {};
    cy.nodes().forEach(function (n) {
      if (n.isParent()) return; // parents derive from children
      out[n.id()] = { x: n.position("x"), y: n.position("y") };
    });
    return out;
  }

  // ─── Rendering ─────────────────────────────────────────────────────

  function loadGraph(preserve) {
    var preserved = preserve ? capturePositions() : null;
    api.applicationMap.get().then(function (p) {
      payload = p;
      // The "Seen within" list is derived from the server's retention window, so
      // it can only be built once a payload has landed.
      applyAgeOptions(typeof p.retentionDays === "number" ? p.retentionDays : 7);
      render(preserved);
    }).catch(function (err) {
      // Log the full error (with stack) so a render failure is diagnosable in
      // the console, not just a one-line status message.
      try { console.error("Application Map load/render failed:", err); } catch (e) { /* ignore */ }
      setStatus("Load failed: " + (err && err.message ? err.message : err));
    });
  }

  function render(preserved) {
    var mappedAssets = payload.nodes.filter(function (n) { return n.kind === "asset" && n.hasMappedProcesses; });
    var emptyEl = document.getElementById("appmap-empty");
    var f = currentFilters();
    var g = filterGraph(f);

    if (mappedAssets.length === 0) {
      showEmpty("No mapped processes or services yet", null);
      renderPortLegend(null);
      if (cy) { cy.destroy(); cy = null; }
      setStatus("");
      return;
    }
    if (g.edges.length === 0 && payload.edges.length > 0) {
      showEmpty(
        filterPills.length ? "No connections match these filters" : "No connections in this window",
        filterPills.length
          ? "Remove a filter pill — connection data exists but nothing matches all of them at once."
          : "Widen the “Seen within” filter — connection data exists but nothing was seen recently enough.",
      );
    } else if (emptyEl) {
      emptyEl.hidden = true;
    }

    var positions = resolvePositions(g, preserved);
    var portAssign = assignPortColors(g.edges.map(function (r) {
      return edgePortKey(r.ports.length ? r.ports : r.edge.ports);
    }), portColorByKey);
    portColorByKey = portAssign.colors;
    renderPortLegend(portAssign);
    if (cy) { cy.destroy(); cy = null; }
    cy = cytoscape({
      container: document.getElementById("appmap-graph"),
      elements: buildElements(g, portAssign.colors),
      wheelSensitivity: 0.2,
      // maxZoom bounds the preset layout's fit too — without it a 3-node
      // graph fit-zooms to fill the whole canvas with giant nodes.
      minZoom: 0.1,
      maxZoom: 1.5,
      style: appmapStylesheet(pageTheme()),
      layout: { name: "preset", positions: function (n) { return positions[n.id()] || undefined; }, fit: true, padding: 40 },
    });
    wireGraphEvents();
    if (filterPills.length) {
      // The pills themselves show WHAT is filtered — repeating them here just
      // duplicated a long row of text. "Filtered" + the surviving counts is
      // enough to read the effect.
      setStatus(
        "Filtered · " +
        g.nodes.filter(function (n) { return n.kind === "asset"; }).length + " assets · " +
        g.edges.length + " connection(s)"
      );
    } else {
      setStatus(
        g.nodes.filter(function (n) { return n.kind === "asset"; }).length + " assets · " +
        payload.stats.processCount + " processes · " +
        (payload.stats.serviceCount || 0) + " services · " +
        g.edges.length + " connections" +
        (payload.stats.truncated && payload.stats.truncated.unknownIps ? " · " + payload.stats.truncated.unknownIps + " external IPs collapsed" : "")
      );
    }
    if (selectedId) {
      var sel = cy.getElementById(selectedId);
      if (sel && sel.length) sel.select();
    }
    applyFocusHash();
  }

  var _emptyDefaultHtml = null; // the onboarding <p>'s original markup

  function showEmpty(title, text) {
    var emptyEl = document.getElementById("appmap-empty");
    var textEl = document.getElementById("appmap-empty-text");
    var titleEl = document.getElementById("appmap-empty-title");
    // Never let a missing overlay element take down the whole render.
    if (textEl) {
      if (_emptyDefaultHtml === null) _emptyDefaultHtml = textEl.innerHTML;
      // null text = restore the onboarding copy (it carries markup, so a
      // one-way textContent overwrite would lose it for the session).
      if (text === null || text === undefined) textEl.innerHTML = _emptyDefaultHtml;
      else textEl.textContent = text;
    }
    if (titleEl) titleEl.textContent = title;
    if (emptyEl) emptyEl.hidden = false;
  }

  function setStatus(text) {
    var el = document.getElementById("appmap-status");
    if (el) el.textContent = text;
  }

  function wireGraphEvents() {
    cy.on("tap", "node", function (evt) {
      // EVERY node kind — asset boxes included — is rail-only on tap. Tapping an
      // asset used to also pop the asset-details slide-in, which made ordinary
      // map navigation (select a box to read its services and ports) throw a panel
      // over the graph you were reading. Opening the slide-in is now an explicit
      // act: the rail's "Open asset details" button, and nothing else.
      selectedId = evt.target.id();
      renderInfoNode(evt.target.id());
    });
    cy.on("tap", "edge", function (evt) {
      selectedId = evt.target.id();
      renderInfoEdge(evt.target.id());
    });
    // Full opacity for the edge under the pointer (see the .appmap-hover rule).
    // Touch devices never fire these; tapping an edge still opens the rail.
    cy.on("mouseover", "edge", function (evt) { evt.target.addClass("appmap-hover"); });
    cy.on("mouseout", "edge", function (evt) { evt.target.removeClass("appmap-hover"); });
    cy.on("tap", function (evt) {
      if (evt.target === cy) {
        selectedId = null;
        var info = document.getElementById("appmap-info");
        if (info) { info.hidden = true; info.innerHTML = ""; }
      }
    });
    cy.on("dragfree", "node", function () {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(persistLayout, 800);
    });
  }

  function persistLayout() {
    var positions = capturePositions();
    if (!positions) return;
    if (canWriteLayout()) {
      api.applicationMap.saveLayout("global", positions).then(function (dto) {
        if (payload) payload.savedLayout = dto;
      }).catch(function () {
        try { localStorage.setItem(LS_KEY, JSON.stringify(positions)); } catch (e) { /* full */ }
      });
    } else {
      try { localStorage.setItem(LS_KEY, JSON.stringify(positions)); } catch (e) { /* full */ }
    }
  }

  // ─── Info rail ─────────────────────────────────────────────────────

  function findNode(id) {
    for (var i = 0; i < payload.nodes.length; i++) {
      if (payload.nodes[i].id === id) return payload.nodes[i];
    }
    return null;
  }

  function edgesTouching(id) {
    return payload.edges.filter(function (e) { return e.source === id || e.target === id; });
  }

  function renderInfoNode(id) {
    var n = findNode(id);
    var info = document.getElementById("appmap-info");
    if (!n || !info) return;
    var html = "";
    if (n.kind === "asset") {
      html += "<h3>" + esc(n.hostname || n.ipAddress || "asset") + "</h3>";
      html += '<div class="appmap-info-sub">' + esc(n.assetType || "") + (n.ipAddress ? " · " + esc(n.ipAddress) : "") + (n.monitorStatus ? " · " + esc(n.monitorStatus) : "") + "</div>";
      var procs = payload.nodes.filter(function (p) { return p.kind === "process" && p.assetId === n.assetId; });
      if (procs.length) {
        html += "<table><tr><th>Mapped process</th><th>Listening</th></tr>";
        procs.forEach(function (p) {
          var lp = consolidatePorts(p.listenPorts).map(function (g) { return g.label; }).join(", ");
          html += "<tr><td>" + esc(p.processName) + "</td><td>" + esc(lp || "—") + "</td></tr>";
        });
        html += "</table>";
      }
      var svcs = payload.nodes.filter(function (p) { return p.kind === "service" && p.assetId === n.assetId; });
      if (svcs.length) {
        html += "<table><tr><th>Mapped service</th><th>Listening</th></tr>";
        svcs.forEach(function (p) {
          var lp = consolidatePorts(p.listenPorts).map(function (g) { return g.label; }).join(", ");
          html += "<tr><td>" + esc(p.serviceUnit) + "</td><td>" + esc(lp || "—") + "</td></tr>";
        });
        html += "</table>";
      }
      html += '<div class="appmap-info-actions"><button type="button" class="btn btn-secondary" data-open-asset="' + esc(n.assetId) + '">Open asset details</button></div>';
    } else if (isChildNode(n.kind)) {
      html += "<h3>" + esc(n.processName || n.serviceUnit) + "</h3>";
      var owner = findNode("asset:" + n.assetId);
      html += '<div class="appmap-info-sub">' + (n.kind === "service" ? "service" : "process") + " on " + esc(owner && (owner.hostname || owner.ipAddress) || n.assetId) + "</div>";
      // Contiguous blocks collapse to a range, so a service holding tcp/9000-9004
      // is one row instead of five near-identical ones. The Ports column states
      // how many addresses a range covers.
      var lp2 = consolidatePorts(n.listenPorts);
      if (lp2.length) {
        html += "<table><tr><th>Listening port</th><th>Ports</th></tr>";
        lp2.forEach(function (g) {
          html += "<tr><td>" + esc(g.label) + "</td><td>" + (g.count > 1 ? g.count : "") + "</td></tr>";
        });
        html += "</table>";
      }
      var touching = edgesTouching(n.id);
      if (touching.length) {
        html += "<table><tr><th>Connection</th><th>Ports</th></tr>";
        touching.forEach(function (e) {
          var otherId = e.source === n.id ? e.target : e.source;
          var other = findNode(otherId);
          var dir = e.source === n.id ? "→ " : "← ";
          html += "<tr><td>" + esc(dir + (other ? nodeLabel(other).split("\n")[0] : otherId)) + "</td><td>" +
            esc(e.ports.slice(0, 4).map(function (p) { return p.proto + "/" + p.port; }).join(", ") + (e.ports.length > 4 ? " +" + (e.ports.length - 4) : "")) + "</td></tr>";
        });
        html += "</table>";
      }
      html += '<div class="appmap-info-actions"><button type="button" class="btn btn-secondary" data-open-asset="' + esc(n.assetId) + '">Open asset details</button></div>';
    } else {
      html += "<h3>" + esc(nodeLabel(n).split("\n")[0]) + "</h3>";
      html += '<div class="appmap-info-sub">' + (n.kind === "unknown-ip-group" ? "External subnet (not matched to any asset)" : n.kind === "unknown-overflow" ? "Collapsed external endpoints" : "External IP (not matched to any asset)") + "</div>";
      if (n.ipHostname) {
        html += '<div class="appmap-info-sub">Named <strong>' + esc(n.ipHostname) + "</strong> " +
          (n.ipNameSource === "dns" ? "by reverse DNS (PTR)" : "by an IP " + esc(n.ipNameSource || "registry")) +
          " — no asset record exists for this address.</div>";
      }
      if (n.ips && n.ips.length) {
        html += "<table><tr><th>Member IPs</th></tr>";
        n.ips.slice(0, 50).forEach(function (ip) { html += "<tr><td>" + esc(ip) + "</td></tr>"; });
        if (n.ips.length > 50) html += "<tr><td>… " + (n.ips.length - 50) + " more</td></tr>";
        html += "</table>";
      }
      if (typeof n.connCount === "number") {
        html += '<div class="appmap-info-sub">' + n.connCount + " observed connection(s)</div>";
      }
    }
    info.innerHTML = html;
    info.hidden = false;
    var btn = info.querySelector("[data-open-asset]");
    if (btn) {
      btn.addEventListener("click", function () {
        if (typeof openViewModal === "function") openViewModal(btn.getAttribute("data-open-asset"));
      });
    }
  }

  function renderInfoEdge(id) {
    var info = document.getElementById("appmap-info");
    var e = null;
    for (var i = 0; i < payload.edges.length; i++) {
      if (payload.edges[i].id === id) { e = payload.edges[i]; break; }
    }
    if (!e || !info) return;
    var src = findNode(e.source);
    var tgt = findNode(e.target);
    var html = "<h3>" + esc((src ? nodeLabel(src).split("\n")[0] : e.source) + " → " + (tgt ? nodeLabel(tgt).split("\n")[0] : e.target)) + "</h3>";
    html += '<div class="appmap-info-sub">' + esc(e.kind) + " connection</div>";
    // "Via IP" = the address(es) the connection was actually observed against
    // (outbound: dialed remote IP; inbound: local address it landed on) — the
    // disambiguator for multi-IP hosts and same-asset service→service edges.
    html += "<table><tr><th>Port</th><th>Via IP</th><th>Seen</th><th>Last seen</th></tr>";
    e.ports.forEach(function (p) {
      html += "<tr><td>" + esc(p.proto + "/" + p.port) + "</td><td>" + esc((p.ips || []).join(", ") || "—") + "</td><td>" + p.count + "×</td><td>" + esc(new Date(p.lastSeen).toLocaleString()) + "</td></tr>";
    });
    html += "</table>";
    if (e.portOverflow > 0) html += '<div class="appmap-info-sub">+ ' + e.portOverflow + " more port(s)</div>";
    info.innerHTML = html;
    info.hidden = false;
  }

  // ─── Toolbar / pill filter / hash focus ────────────────────────────

  function wireToolbar() {
    ["appmap-age", "appmap-hide-external", "appmap-hide-workstations", "appmap-fade-stale"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("change", function () {
        savePrefs();
        if (payload) render(capturePositions());
      });
    });
    var refresh = document.getElementById("appmap-refresh");
    if (refresh) refresh.addEventListener("click", function () { loadGraph(true); });

    var shot = document.getElementById("appmap-screenshot");
    if (shot) shot.addEventListener("click", function () { screenshotMap(); });

    // The discovery-rules list (formerly a Discovery button + modal here) lives
    // on Integrations → Polaris Agent now; the empty-state copy points there.

    var legendBtn = document.getElementById("appmap-legend-btn");
    var legend = document.getElementById("appmap-legend");
    if (legendBtn && legend) {
      legendBtn.addEventListener("click", function () { legend.hidden = !legend.hidden; savePrefs(); });
      var legendClose = document.getElementById("appmap-legend-close");
      if (legendClose) legendClose.addEventListener("click", function () { legend.hidden = true; savePrefs(); });
    }
    var portLegendBtn = document.getElementById("appmap-port-legend-toggle");
    if (portLegendBtn) {
      portLegendBtn.addEventListener("click", function () {
        setPortLegendCollapsed(!portLegendCollapsed());
        savePrefs();
      });
    }

    var reset = document.getElementById("appmap-reset-layout");
    if (reset) {
      // Permissions are loaded before wireToolbar runs (init awaits
      // fetchCurrentUser), so this is a plain synchronous check.
      if (canWriteLayout()) reset.hidden = false;
      reset.addEventListener("click", function () {
        api.applicationMap.deleteLayout("global").catch(function () { /* best-effort */ });
        try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
        if (payload) { payload.savedLayout = null; render(null); }
      });
    }

    wireFilterBox();
    wireSavedFilters();
    // Pills / booleans restore now; the age select waits for the first payload
    // (its options depend on the server's retention window).
    restorePrefs();
  }

  // ─── Pill filter box ───────────────────────────────────────────────

  var PILL_KIND_LABEL = {
    proto: "proto", port: "port", asset: "host", type: "type",
    process: "process", service: "service", external: "external", text: "text",
  };

  function renderPills() {
    var wrap = document.getElementById("appmap-filter-pills");
    if (!wrap) return;
    wrap.innerHTML = filterPills.map(function (p, i) {
      return '<span class="tag-chip">' +
        '<span class="appmap-pill-kind">' + esc(PILL_KIND_LABEL[p.kind] || p.kind) + ':</span>' +
        esc(p.value) +
        '<button type="button" class="tag-chip-delete" data-pill-index="' + i +
        '" aria-label="Remove filter" title="Remove filter">×</button>' +
      '</span>';
    }).join("");
    // Placeholder stays the short "Add filter..." (the suggestion dropdown is
    // what teaches the vocabulary); the full hint rides the tooltip.
  }

  function addPill(kind, value) {
    var v = String(value == null ? "" : value).trim();
    if (!v) return;
    var dup = filterPills.some(function (p) {
      return p.kind === kind && p.value.toLowerCase() === v.toLowerCase();
    });
    if (!dup) filterPills.push({ kind: kind, value: v });
    renderPills();
    savePrefs();
    if (payload) render(capturePositions());
  }

  function removePillAt(i) {
    if (i < 0 || i >= filterPills.length) return;
    filterPills.splice(i, 1);
    renderPills();
    savePrefs();
    if (payload) render(capturePositions());
  }

  // Everything the current payload makes filterable. Rebuilt on every render so
  // it always reflects the FULL graph, not the narrowed view — otherwise adding
  // one pill would hide the suggestions needed to add the next.
  function buildFilterCatalog(nodes, edges) {
    var out = [];
    var seen = {};
    function push(kind, value) {
      var v = String(value == null ? "" : value).trim();
      if (!v) return;
      var k = kind + "|" + v.toLowerCase();
      if (seen[k]) return;
      seen[k] = true;
      out.push({ kind: kind, value: v });
    }
    var protos = {}, ports = {};
    (edges || []).forEach(function (e) {
      (e.ports || []).forEach(function (p) { protos[p.proto] = true; ports[p.port] = true; });
    });
    (nodes || []).forEach(function (n) {
      (n.listenPorts || []).forEach(function (p) { protos[p.proto] = true; ports[p.port] = true; });
      if (n.kind === "asset") { push("asset", n.hostname || n.ipAddress); push("type", n.assetType); }
      else if (n.kind === "process") push("process", n.processName);
      else if (n.kind === "service") push("service", n.serviceUnit);
      else if (n.kind === "unknown-ip") { push("external", n.ip); push("external", n.ipHostname); }
      else if (n.kind === "unknown-ip-group") push("external", n.cidr);
    });
    Object.keys(protos).sort().forEach(function (p) { push("proto", p); });
    Object.keys(ports).map(Number).sort(function (a, b) { return a - b; })
      .forEach(function (p) { push("port", String(p)); });
    return out;
  }

  var SUGGEST_CAP = 50;

  // Prefix matches rank above interior matches (typing "tc" should offer "tcp"
  // first, not some host whose name merely contains "tc").
  function rankSuggestions(catalog, q) {
    var query = String(q || "").trim().toLowerCase();
    if (!query) return catalog.slice(0, SUGGEST_CAP);
    var pre = [], mid = [];
    catalog.forEach(function (c) {
      var v = c.value.toLowerCase();
      var at = v.indexOf(query);
      if (at === 0) pre.push(c);
      else if (at > 0) mid.push(c);
      else if ((PILL_KIND_LABEL[c.kind] || c.kind).indexOf(query) === 0) mid.push(c);
    });
    return pre.concat(mid).slice(0, SUGGEST_CAP);
  }

  function closeSuggest() {
    var box = document.getElementById("appmap-suggest");
    var input = document.getElementById("appmap-filter-input");
    if (box) { box.classList.remove("open"); box.innerHTML = ""; }
    if (input) input.setAttribute("aria-expanded", "false");
    suggestItems = [];
    suggestIndex = -1;
  }

  function openSuggest() {
    var box = document.getElementById("appmap-suggest");
    var input = document.getElementById("appmap-filter-input");
    if (!box || !input) return;
    var catalog = payload ? buildFilterCatalog(payload.nodes, payload.edges) : [];
    suggestItems = rankSuggestions(catalog, input.value);
    suggestIndex = suggestItems.length ? 0 : -1;
    if (!suggestItems.length) {
      box.innerHTML = '<div class="appmap-suggest-empty">' +
        (input.value.trim()
          ? 'No match — press Enter for a free-text filter'
          : 'Nothing to filter yet') +
        '</div>';
    } else {
      box.innerHTML = suggestItems.map(function (c, i) {
        return '<div class="appmap-suggest-item' + (i === suggestIndex ? " active" : "") + '"' +
          ' role="option" data-suggest-index="' + i + '">' +
          '<span>' + esc(c.value) + '</span>' +
          '<span class="appmap-suggest-kind">' + esc(PILL_KIND_LABEL[c.kind] || c.kind) + '</span>' +
        '</div>';
      }).join("");
    }
    box.classList.add("open");
    input.setAttribute("aria-expanded", "true");
  }

  function moveSuggest(delta) {
    var box = document.getElementById("appmap-suggest");
    if (!box || !suggestItems.length) return;
    suggestIndex = (suggestIndex + delta + suggestItems.length) % suggestItems.length;
    var rows = box.querySelectorAll(".appmap-suggest-item");
    for (var i = 0; i < rows.length; i++) {
      if (i === suggestIndex) {
        rows[i].classList.add("active");
        rows[i].scrollIntoView({ block: "nearest" });
      } else {
        rows[i].classList.remove("active");
      }
    }
  }

  function commitInput() {
    var input = document.getElementById("appmap-filter-input");
    if (!input) return;
    var pick = suggestIndex >= 0 ? suggestItems[suggestIndex] : null;
    if (pick) addPill(pick.kind, pick.value);
    else if (input.value.trim()) addPill("text", input.value);
    input.value = "";
    closeSuggest();
  }

  function wireFilterBox() {
    var wrap = document.getElementById("appmap-filter");
    var input = document.getElementById("appmap-filter-input");
    var box = document.getElementById("appmap-suggest");
    if (!wrap || !input || !box) return;

    // Clicking the padding of the box should focus the text field — it reads as
    // one input, so it should behave like one. (Pills live OUTSIDE this box now,
    // in the row below, so they're deliberately not part of this target check.)
    wrap.addEventListener("mousedown", function (ev) {
      if (ev.target === wrap) {
        ev.preventDefault();
        input.focus();
      }
    });

    var reopen = (typeof debounce === "function") ? debounce(openSuggest, 200) : openSuggest;
    input.addEventListener("input", reopen);
    input.addEventListener("focus", openSuggest);
    input.addEventListener("click", openSuggest);
    // Delay so a suggestion mousedown still lands before the box empties.
    input.addEventListener("blur", function () { setTimeout(closeSuggest, 150); });

    input.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowDown") { ev.preventDefault(); if (!suggestItems.length) openSuggest(); else moveSuggest(1); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); moveSuggest(-1); }
      else if (ev.key === "Enter") { ev.preventDefault(); commitInput(); }
      else if (ev.key === "Escape") {
        // Stop propagation so a surrounding modal/panel doesn't also close.
        ev.stopPropagation();
        closeSuggest();
      } else if (ev.key === "Backspace" && input.value === "" && filterPills.length) {
        ev.preventDefault();
        removePillAt(filterPills.length - 1);
      }
    });

    // preventDefault keeps focus in the input so blur-close doesn't race the tap.
    box.addEventListener("mousedown", function (ev) {
      var row = ev.target.closest ? ev.target.closest(".appmap-suggest-item") : null;
      if (!row) return;
      ev.preventDefault();
      suggestIndex = Number(row.getAttribute("data-suggest-index"));
      commitInput();
    });

    var pills = document.getElementById("appmap-filter-pills");
    if (pills) {
      pills.addEventListener("click", function (ev) {
        var btn = ev.target.closest ? ev.target.closest("[data-pill-index]") : null;
        if (!btn) return;
        removePillAt(Number(btn.getAttribute("data-pill-index")));
      });
    }
  }

  // ─── Screenshot (graph + info rail) ────────────────────────────────
  //
  // Composited from two sources rather than one html-to-image pass over the whole
  // layout: the graph is a cytoscape <canvas>, and cy.png() renders it
  // independently of the live canvas (same call the Device Map screenshot uses),
  // which is far more reliable than DOM-serializing a canvas. The info rail is
  // ordinary DOM, so html-to-image handles it. Drawing both onto one canvas is what
  // gets the port list INTO the picture — the whole point of the request.
  //
  // Delivery mirrors map.js: clipboard first, then a download fallback, because
  // clipboard image writes need HTTPS + permission and silently fail otherwise.
  async function screenshotMap() {
    if (!cy) {
      showToast("Map not loaded", "error");
      return;
    }
    var rootCs = getComputedStyle(document.documentElement);
    var bg = rootCs.getPropertyValue("--color-bg-primary").trim() ||
             rootCs.getPropertyValue("--color-surface").trim() || "#ffffff";
    var SCALE = 2;
    var GAP = 16 * SCALE;

    try {
      var graphUri = cy.png({ output: "base64uri", scale: SCALE, full: true, bg: bg });
      var graphImg = await new Promise(function (resolve, reject) {
        var im = new Image();
        im.onload = function () { resolve(im); };
        im.onerror = function () { reject(new Error("graph render failed")); };
        im.src = graphUri;
      });

      // Only composite the rail when it's actually open with content.
      var rail = document.getElementById("appmap-info");
      var railCanvas = null;
      if (rail && !rail.hidden && rail.innerHTML.trim() &&
          typeof htmlToImage !== "undefined" && htmlToImage.toCanvas) {
        try {
          railCanvas = await htmlToImage.toCanvas(rail, { pixelRatio: SCALE, backgroundColor: bg });
        } catch (e) {
          // A rail that won't serialize shouldn't cost the operator the graph.
          railCanvas = null;
        }
      }

      // The Ports key, so the colours still mean something once the picture
      // leaves the page. Always expanded in the capture, whatever its state on
      // screen; skipped when there are no edges to explain.
      var portLegend = document.getElementById("appmap-port-legend");
      var keyCanvas = null;
      if (portLegend && !portLegend.hidden &&
          typeof htmlToImage !== "undefined" && htmlToImage.toCanvas) {
        var wasCollapsed = portLegendCollapsed();
        if (wasCollapsed) setPortLegendCollapsed(false);
        try {
          keyCanvas = await htmlToImage.toCanvas(portLegend, { pixelRatio: SCALE, backgroundColor: bg });
        } catch (e) {
          keyCanvas = null;
        } finally {
          if (wasCollapsed) setPortLegendCollapsed(true);
        }
      }

      var railW = railCanvas ? railCanvas.width : 0;
      var out = document.createElement("canvas");
      // A tiny graph can be narrower than the key under it.
      var leftW = Math.max(graphImg.width, keyCanvas ? keyCanvas.width : 0);
      out.width = leftW + (railW ? GAP + railW : 0);
      // The key sits BELOW the graph (bottom-left, as on screen) rather than
      // over it: cy.png({full:true}) is cropped to the elements, so an overlay
      // would land on top of nodes.
      var keyH = keyCanvas ? GAP + keyCanvas.height : 0;
      out.height = Math.max(graphImg.height + keyH, railCanvas ? railCanvas.height : 0);
      var ctx = out.getContext("2d");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(graphImg, 0, 0);
      if (keyCanvas) ctx.drawImage(keyCanvas, 0, graphImg.height + GAP);
      if (railCanvas) ctx.drawImage(railCanvas, leftW + GAP, 0);

      var blob = await new Promise(function (resolve) { out.toBlob(resolve, "image/png"); });
      if (!blob) { showToast("Screenshot failed", "error"); return; }

      if (await copyPngToClipboard(blob)) {
        showToast(railCanvas ? "Map + info panel copied to clipboard" : "Map copied to clipboard");
        return;
      }
      // Clipboard unavailable/refused — fall through to download.
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "application-map-" + new Date().toISOString().replace(/[:.]/g, "-") + ".png";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
      showToast("Screenshot downloaded");
    } catch (err) {
      showToast("Screenshot failed: " + (err && err.message ? err.message : String(err)), "error");
    }
  }

  // ─── Saved filters ─────────────────────────────────────────────────
  //
  // A named pill set, per user, in its own localStorage key (the toolbar prefs
  // blob is last-state; these are deliberate, named recalls — same split as the
  // integrations page's saved queries). Stores ONLY the pills: "Seen within" and
  // Hide external are separate controls, and silently moving the operator's time
  // window on recall would be a surprise.

  function savedFiltersKey() {
    var u = (typeof currentUsername !== "undefined" && currentUsername) ? currentUsername : "";
    return u ? "polaris-prefs-appmap-filters-" + u : "";
  }

  function readSavedFilters() {
    var key = savedFiltersKey();
    if (!key) return [];
    try {
      var raw = JSON.parse(localStorage.getItem(key) || "[]");
      if (!Array.isArray(raw)) return [];
      return raw.filter(function (f) { return f && typeof f.name === "string" && Array.isArray(f.pills); });
    } catch (e) { return []; }
  }

  function writeSavedFilters(list) {
    var key = savedFiltersKey();
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) { /* quota */ }
  }

  function renderSavedMenu() {
    var menu = document.getElementById("appmap-saved-menu");
    if (!menu) return;
    var list = readSavedFilters();
    var canSave = filterPills.length > 0;
    var html =
      '<div class="appmap-saved-new">' +
        '<input type="text" id="appmap-saved-name" class="input" maxlength="48" ' +
               'placeholder="' + (canSave ? "Name this filter…" : "Add a pill first") + '"' +
               (canSave ? "" : " disabled") + '>' +
        '<button type="button" class="btn btn-primary btn-sm" id="appmap-saved-add"' +
          (canSave ? "" : " disabled") + ">Save</button>" +
      "</div>";
    html += list.length
      ? list.map(function (f, i) {
          return '<div class="appmap-saved-item" data-saved-index="' + i + '" role="menuitem" ' +
            'title="Apply “' + esc(f.name) + '” (' + f.pills.length + ' pill(s))">' +
            '<span class="appmap-saved-name">' + esc(f.name) + "</span>" +
            '<button type="button" class="tag-chip-delete" data-saved-delete="' + i +
              '" aria-label="Delete saved filter" title="Delete">&times;</button>' +
          "</div>";
        }).join("")
      : '<div class="appmap-saved-empty">No saved filters yet.</div>';
    menu.innerHTML = html;
  }

  function closeSavedMenu() {
    var menu = document.getElementById("appmap-saved-menu");
    var btn = document.getElementById("appmap-saved-btn");
    if (menu) menu.classList.remove("open");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }

  function wireSavedFilters() {
    var btn = document.getElementById("appmap-saved-btn");
    var menu = document.getElementById("appmap-saved-menu");
    if (!btn || !menu) return;

    btn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      var open = menu.classList.contains("open");
      if (open) { closeSavedMenu(); return; }
      renderSavedMenu();
      menu.classList.add("open");
      btn.setAttribute("aria-expanded", "true");
      var nameEl = document.getElementById("appmap-saved-name");
      if (nameEl && !nameEl.disabled) nameEl.focus();
    });

    // Keep clicks inside the menu from reaching the document close handler.
    menu.addEventListener("click", function (ev) { ev.stopPropagation(); });

    function commitSave() {
      var nameEl = document.getElementById("appmap-saved-name");
      if (!nameEl) return;
      var name = nameEl.value.trim();
      if (!name || !filterPills.length) return;
      var list = readSavedFilters();
      var idx = -1;
      for (var i = 0; i < list.length; i++) {
        if (list[i].name.toLowerCase() === name.toLowerCase()) { idx = i; break; }
      }
      // Same name overwrites rather than accumulating near-duplicates.
      var entry = { name: name, pills: filterPills.slice() };
      if (idx >= 0) list[idx] = entry; else list.push(entry);
      writeSavedFilters(list);
      renderSavedMenu();
      if (typeof showToast === "function") {
        showToast(idx >= 0 ? "Updated saved filter “" + name + "”" : "Saved filter “" + name + "”", "success");
      }
    }

    menu.addEventListener("keydown", function (ev) {
      if (ev.target.id !== "appmap-saved-name") return;
      if (ev.key === "Enter") { ev.preventDefault(); commitSave(); }
      else if (ev.key === "Escape") { ev.stopPropagation(); closeSavedMenu(); }
    });

    menu.addEventListener("mousedown", function (ev) {
      var del = ev.target.closest ? ev.target.closest("[data-saved-delete]") : null;
      if (del) {
        ev.preventDefault();
        var di = Number(del.getAttribute("data-saved-delete"));
        var list = readSavedFilters();
        if (di >= 0 && di < list.length) {
          list.splice(di, 1);
          writeSavedFilters(list);
          renderSavedMenu();
        }
        return;
      }
      if (ev.target.id === "appmap-saved-add") { ev.preventDefault(); commitSave(); return; }
      var row = ev.target.closest ? ev.target.closest("[data-saved-index]") : null;
      if (!row) return;
      ev.preventDefault();
      var hit = readSavedFilters()[Number(row.getAttribute("data-saved-index"))];
      if (!hit) return;
      // REPLACES the current pills rather than merging — a saved filter is a
      // whole view, and merging would quietly AND it with whatever was there.
      filterPills = hit.pills.slice();
      renderPills();
      savePrefs();
      closeSavedMenu();
      if (payload) render(capturePositions());
    });

    document.addEventListener("click", function () { closeSavedMenu(); });
  }

  function focusNode(id) {
    var el = cy.getElementById(id);
    if (!el || el.length === 0) return;
    cy.elements().unselect();
    el.select();
    cy.animate({ center: { eles: el }, zoom: Math.max(cy.zoom(), 1) }, { duration: 250 });
    selectedId = id;
    renderInfoNode(id);
  }

  // Deep link: /appmap.html#focus=asset:<id> (used by the process detail
  // panel's "View on Application Map" link). Narrowing is pills now, so a deep
  // link ADDS an asset pill — the operator can then see why the view is narrowed
  // and clear it the same way as any other filter.
  function applyFocusHash() {
    var m = /[#&]focus=([^&]+)/.exec(window.location.hash || "");
    if (!m || !cy) return;
    var id = decodeURIComponent(m[1]);
    if (!cy.getElementById(id).length) return;
    // One-shot: clear first so the re-render this triggers can't loop.
    window.location.hash = "";
    var n = findNode(id);
    if (n && n.kind === "asset") {
      var label = n.hostname || n.ipAddress;
      if (label && !filterPills.some(function (p) { return p.kind === "asset" && p.value === label; })) {
        addPill("asset", label); // re-renders
        return;
      }
    }
    focusNode(id);
  }

  // Lets pin-changing surfaces (the Services-tab checkboxes in the asset
  // slide-in opened over this page) pull a fresh graph instead of leaving the
  // operator looking at a stale map until the 60s refresh.
  window.appMapReload = function () { if (payload) loadGraph(true); };

  // Pure helpers exposed for unit tests (the page itself is an IIFE with no
  // module surface) — same pattern as window.PolarisTopologyRender.
  window.PolarisAppMap = {
    applyGraphFilter: applyGraphFilter,
    buildFilterCatalog: buildFilterCatalog,
    rankSuggestions: rankSuggestions,
    consolidatePorts: consolidatePorts,
    edgePortKey: edgePortKey,
    assignPortColors: assignPortColors,
    PORT_PALETTE: PORT_PALETTE,
  };
})();
