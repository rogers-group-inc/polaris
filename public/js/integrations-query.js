/**
 * public/js/integrations-query.js — the Query API consoles —
 * the Fortinet query presets (the <fortinet-query-presets> block
 * tests/unit/fortinetQueryPresets.test.ts evaluates), the saved-query store,
 * the FortiGate picker, and one console per type family (FortiManager,
 * FortiGate, Entra, Azure Arc, AD, vCenter, Unraid / TrueNAS / Proxmox).
 *
 * Split out of integrations.js (CQ-F051) as a byte-for-byte move. A plain
 * browser script: its functions and `var`s are page globals. Loads AFTER
 * integrations.js — tests/unit/integrationsSplit.test.ts holds the order.
 */

// <fortinet-query-presets>
// Self-contained (no DOM, no app.js helpers): tests/unit/fortinetQueryPresets.test.ts
// slices this block out and evaluates it, and fails when a query the
// FortiManager or standalone FortiGate discovery sends has no preset here.
// When discovery gains, drops or reshapes a query, change the matching preset
// in the same commit and bump _FMG_QUERIES_VERSION / _FGT_QUERIES_VERSION so
// existing browsers pick it up.
//
// Preset queries use "<adom>" as a placeholder — substituted with the integration's
// configured ADOM when loaded into the form. "<device-name>" is the FortiManager
// device name and is typed by the operator.
// Each preset carries a `mode` ("fmg" = JSON-RPC against FortiManager, including
// /sys/proxy/json passthroughs; "fortigate" = direct REST against a managed
// FortiGate). The Saved Queries dropdown filters by the currently-selected radio.

function _fmgProxyPreset(name, resource) {
  return {
    name: name,
    mode: "fmg",
    method: "exec",
    params: JSON.stringify([{
      url: "/sys/proxy/json",
      data: { target: ["/adom/<adom>/device/<device-name>"], action: "get", resource: resource },
    }], null, 2),
  };
}

function _fmgNativePreset(name, param) {
  return { name: name, mode: "fmg", method: "get", params: JSON.stringify([param], null, 2) };
}

var _FMG_PROXY_PRESET_QUERIES = [
  // ── FortiManager itself ──
  _fmgNativePreset("System status", { url: "/sys/status" }),
  _fmgNativePreset("List ADOMs", { url: "/dvmdb/adom", fields: ["name", "flags", "state", "os_ver"] }),
  // Discovery's roster read: name, hostname, sn, platform_str, os_ver/mr/patch,
  // conn_status, ha_mode + ha_slave[], and the metavariables ("meta fields").
  _fmgNativePreset("List devices in ADOM", { url: "/dvmdb/adom/<adom>/device", option: ["get meta"] }),
  // The per-device values of the coordinate metavariables (discovery reads
  // the names configured on the integration; Latitude / Longitude by default).
  {
    name: "Coordinate metavariables",
    mode: "fmg",
    method: "get",
    params: JSON.stringify([
      { url: "/pm/config/adom/<adom>/obj/fmg/variable/Latitude" },
      { url: "/pm/config/adom/<adom>/obj/fmg/variable/Longitude" },
    ], null, 2),
  },
  // ── A managed FortiGate's configuration, read natively from FortiManager ──
  _fmgNativePreset("Management interfaces (IP + MAC + access) on device", {
    url: "/pm/config/device/<device-name>/global/system/interface", fields: ["name", "ip", "macaddr", "allowaccess"], loadsub: 0,
  }),
  _fmgNativePreset("Coordinates (system global) on device", {
    url: "/pm/config/device/<device-name>/global/system/global",
    fields: ["gui-device-latitude", "gui-device-longitude", "latitude", "longitude"], loadsub: 0,
  }),
  _fmgNativePreset("Interfaces, VLANs and secondary IPs on device", {
    url: "/pm/config/device/<device-name>/vdom/root/system/interface",
    fields: ["name", "ip", "type", "interface", "vlanid", "switch-controller-mgmt-vlan", "secondaryip", "ipv6"],
  }),
  _fmgNativePreset("DHCP servers on device", { url: "/pm/config/device/<device-name>/vdom/root/system/dhcp/server" }),
  _fmgNativePreset("DHCPv6 servers on device", { url: "/pm/config/device/<device-name>/vdom/root/system/dhcp6/server" }),
  _fmgNativePreset("Firewall VIPs on device", {
    url: "/pm/config/device/<device-name>/vdom/root/firewall/vip",
    fields: ["name", "extip", "mappedip", "extintf", "type", "realservers"],
  }),
  _fmgNativePreset("Configured FortiSwitches on device", {
    url: "/pm/config/device/<device-name>/global/switch-controller/managed-switch", fields: ["switch-id", "sn", "name"], loadsub: 0,
  }),
  _fmgNativePreset("Configured FortiAPs on device", {
    url: "/pm/config/device/<device-name>/vdom/root/wireless-controller/wtp", fields: ["wtp-id", "name", "location", "comment", "wtp-profile"], loadsub: 0,
  }),
  // Management access (Open HTTPS / Open SSH): discovery reads the device DB
  // first and falls back to the second query of each pair.
  _fmgNativePreset("FortiAP profile access on device", {
    url: "/pm/config/device/<device-name>/vdom/root/wireless-controller/wtp-profile", fields: ["name", "allowaccess"], loadsub: 0,
  }),
  _fmgNativePreset("FortiAP profile access (ADOM objects)", {
    url: "/pm/config/adom/<adom>/obj/wireless-controller/wtp-profile", fields: ["name", "allowaccess"], loadsub: 0,
  }),
  _fmgNativePreset("FortiSwitch local-access policy on device", {
    url: "/pm/config/device/<device-name>/global/switch-controller/security-policy/local-access",
    fields: ["name", "mgmt-allowaccess", "internal-allowaccess"], loadsub: 0,
  }),
  _fmgNativePreset("FortiSwitch local-access policy on device (vdom)", {
    url: "/pm/config/device/<device-name>/vdom/root/switch-controller/security-policy/local-access",
    fields: ["name", "mgmt-allowaccess", "internal-allowaccess"], loadsub: 0,
  }),
  // ── A managed FortiGate's live state, through FortiManager's proxy ──
  // Discovery adds "&ipv6=true" when IPv6 is on for the install.
  _fmgProxyPreset("DHCP leases on device", "/api/v2/monitor/system/dhcp?format=ip|mac|hostname|interface|reserved|expire_time|access_point|ssid|vci|type"),
  _fmgProxyPreset("Endpoint devices on device", "/api/v2/monitor/user/device/query?format=mac|ipv4_address|ip|hostname|host|os_name|os|type|os_version|hardware_vendor|hardware_family|detected_interface|interface|switch_fortilink|fortiswitch|fortiswitch_id|switch_port|fortiswitch_port_id|fortiswitch_port_name|ap_name|fortiap|user|detected_user|unauth_user|is_online|last_seen|ipv6_address"),
  _fmgProxyPreset("Authenticated users on device", "/api/v2/monitor/user/firewall"),
  _fmgProxyPreset("ARP table on device", "/api/v2/monitor/network/arp"),
  _fmgProxyPreset("Managed FortiSwitches on device", "/api/v2/monitor/switch-controller/managed-switch/status?format=connecting_from|fgt_peer_intf_name|join_time|os_version|serial|switch-id|state|status"),
  _fmgProxyPreset("FortiSwitch config (descriptions, uplink ports) on device", "/api/v2/cmdb/switch-controller/managed-switch?format=sn|switch-id|name|description|ports"),
  _fmgProxyPreset("FortiSwitch MAC table (detected devices) on device", "/api/v2/monitor/switch-controller/detected-device?format=mac|switch_id|port_name|vlan_id|last_seen|ipv4_address|ipv6_address|device_name|host_src|device_type|os_name|is_fortilink_peer"),
  _fmgProxyPreset("Managed FortiAPs on device", "/api/v2/monitor/wifi/managed_ap?format=name|wtp_id|serial|model|wtp_profile|ip_addr|ip_address|local_ipv4_address|local_ipv4_addr|local_addr|wtp_ip|connecting_ip|connecting_from|base_mac|board_mac|mac|status|state|os_version|version|firmware_version|lldp|mesh_uplink|parent_wtp_id|wan_status|cpu_usage|mem_free|mem_total|sensors_temperatures|radio"),
  // Not read by discovery; kept for troubleshooting.
  _fmgProxyPreset("Interface IPs on device", "/api/v2/cmdb/system/interface"),
];

// Standalone FortiGate presets — the discovery queries the FortiGate
// integration sends, with the same `format=` strings. The FortiManager
// console's direct-to-FortiGate mode offers the same list (below).
var _FGT_PRESET_QUERIES = [
  { name: "System status", method: "GET", path: "/api/v2/monitor/system/status", query: "vdom=root" },
  { name: "HA peers", method: "GET", path: "/api/v2/monitor/system/ha-peer", query: "vdom=root" },
  { name: "Coordinates (system global)", method: "GET", path: "/api/v2/cmdb/system/global", query: "vdom=root\nformat=gui-device-latitude|gui-device-longitude|latitude|longitude" },
  // The attributes discovery and monitoring read (IP, MAC, VLAN, parent, the
  // `secondaryip` table + its `secondary-IP` flag, ipv6, members, status).
  { name: "Interfaces, VLANs and secondary IPs", method: "GET", path: "/api/v2/cmdb/system/interface", query: "vdom=root\nformat=name|ip|macaddr|type|interface|vlanid|switch-controller-mgmt-vlan|secondary-IP|secondaryip|ipv6|member|alias|description|mode|status|fortilink|allowaccess" },
  { name: "Interface IPs", method: "GET", path: "/api/v2/cmdb/system/interface", query: "vdom=root\nformat=name|ip|type|status|vdom" },
  { name: "DHCP servers", method: "GET", path: "/api/v2/cmdb/system.dhcp/server", query: "vdom=root\nformat=id|interface|netmask|ip-range|reserved-address" },
  { name: "DHCPv6 servers", method: "GET", path: "/api/v2/cmdb/system.dhcp6/server", query: "vdom=root" },
  // Discovery adds ipv6=true when IPv6 is on for the install.
  { name: "DHCP leases", method: "GET", path: "/api/v2/monitor/system/dhcp", query: "vdom=root\nformat=ip|mac|hostname|interface|reserved|expire_time|access_point|ssid|vci|type" },
  { name: "Firewall VIPs", method: "GET", path: "/api/v2/cmdb/firewall/vip", query: "vdom=root\nformat=name|extip|mappedip|extintf|type|realservers" },
  { name: "Endpoint devices", method: "GET", path: "/api/v2/monitor/user/device/query", query: "vdom=root\nformat=mac|ipv4_address|ip|hostname|host|os_name|os|type|os_version|hardware_vendor|hardware_family|detected_interface|interface|switch_fortilink|fortiswitch|fortiswitch_id|switch_port|fortiswitch_port_id|fortiswitch_port_name|ap_name|fortiap|user|detected_user|unauth_user|is_online|last_seen|ipv6_address" },
  { name: "Authenticated users", method: "GET", path: "/api/v2/monitor/user/firewall", query: "vdom=root" },
  { name: "ARP table", method: "GET", path: "/api/v2/monitor/network/arp", query: "vdom=root" },
  { name: "Managed FortiSwitches", method: "GET", path: "/api/v2/monitor/switch-controller/managed-switch/status", query: "vdom=root\nformat=connecting_from|fgt_peer_intf_name|join_time|os_version|serial|switch-id|state|status" },
  { name: "FortiSwitch config (descriptions, uplink ports)", method: "GET", path: "/api/v2/cmdb/switch-controller/managed-switch", query: "vdom=root\nformat=sn|switch-id|name|description|ports" },
  { name: "FortiSwitch MAC table (detected devices)", method: "GET", path: "/api/v2/monitor/switch-controller/detected-device", query: "vdom=root\nformat=mac|switch_id|port_name|vlan_id|last_seen|ipv4_address|ipv6_address|device_name|host_src|device_type|os_name|is_fortilink_peer" },
  { name: "Managed FortiAPs", method: "GET", path: "/api/v2/monitor/wifi/managed_ap", query: "vdom=root\nformat=name|wtp_id|serial|model|wtp_profile|ip_addr|ip_address|local_ipv4_address|local_ipv4_addr|local_addr|wtp_ip|connecting_ip|connecting_from|base_mac|board_mac|mac|status|state|os_version|version|firmware_version|lldp|mesh_uplink|parent_wtp_id|wan_status|cpu_usage|mem_free|mem_total|sensors_temperatures|radio" },
  { name: "FortiAP config (locations, profiles)", method: "GET", path: "/api/v2/cmdb/wireless-controller/wtp", query: "vdom=root\nformat=wtp-id|location|comment|wtp-profile" },
  { name: "FortiAP profile access", method: "GET", path: "/api/v2/cmdb/wireless-controller/wtp-profile", query: "vdom=root\nformat=name|allowaccess" },
  { name: "FortiSwitch local-access policy", method: "GET", path: "/api/v2/cmdb/switch-controller.security-policy/local-access", query: "vdom=root\nformat=name|mgmt-allowaccess|internal-allowaccess" },
  // Not read by discovery; kept for troubleshooting.
  { name: "Routing table (IPv4)", method: "GET", path: "/api/v2/monitor/router/ipv4", query: "vdom=root" },
];

// Direct-mode (REST-to-FortiGate) presets for the FortiManager console.
// Available when the integration has `useProxy=false` AND the operator picks
// the "Directly to FortiGate (REST)" radio. The same queries as the standalone
// list, named "… on device" (the names earlier versions shipped, so a version
// bump replaces them rather than leaving the old copies behind). `deviceName`
// is left blank so the operator types the target FortiGate.
var _FMG_DIRECT_PRESET_QUERIES = _FGT_PRESET_QUERIES.map(function (q) {
  return {
    name: q.name === "System status" ? q.name : q.name + " on device",
    mode: "fortigate",
    method: q.method,
    path: q.path,
    deviceName: "",
    query: q.query,
  };
});

// Back-compat alias — kept so anything that still imports this name keeps working.
var _FMG_PRESET_QUERIES = _FMG_PROXY_PRESET_QUERIES.concat(_FMG_DIRECT_PRESET_QUERIES);

// Bumping a version replaces the shipped presets in every browser with the
// current list. The operator's own saved queries are kept (see
// _makeSavedQueryStore), except one saved under a preset's exact name and
// mode, which the new preset replaces.
// 5: every FortiManager discovery query, with discovery's exact parameters.
// 6: the interface read names the `secondaryip` table; the proxied switch read
//    carries discovery's format= and no datasource=1.
// 7: management access moved into discovery — allowaccess on the interface
//    read, wtp-profile on the AP read, the AP profile + switch local-access reads.
// 8: the authenticated-user table discovery reads for the last logged-on user
//    (business rule 180).
var _FMG_QUERIES_VERSION = 8;
// 2: every standalone FortiGate discovery query; ARP moved to network/arp.
// 3: interface, DHCP server, VIP, switch and AP config reads carry discovery's
//    format= lists (datasource=1 dropped).
// 4: management access moved into discovery (allowaccess, wtp-profile, the AP
//    profile and switch local-access reads).
// 5: the authenticated-user table (business rule 180).
var _FGT_QUERIES_VERSION = 5;

function _substituteFmgAdom(paramsStr, adom) {
  return String(paramsStr).replace(/<adom>/g, adom || "root");
}

// ─── Saved-query store + console wiring (shared by every Query API console;
// tests/unit/integrationTabDesignTokens.test.ts slices the file at this
// heading). Each console owns its presets, storage key, and form fields; the
// localStorage versioned store lives here, the console wiring below the block.
//
// On a version change the store reseeds the presets and KEEPS every saved
// query that is not a preset: an entry is a preset when it carries
// `preset: true` (stamped here) or shares a current preset's name and mode.
// Entries saved before the flag existed are matched by name and mode alone.
function _makeSavedQueryStore(storageKey, version, presets) {
  function presetKey(q) { return (q && q.mode ? q.mode : "") + "\u0000" + (q ? q.name : ""); }
  function seeded() {
    return presets.map(function (p) { return Object.assign({}, p, { preset: true }); });
  }
  return {
    load: function () {
      try {
        var stored = JSON.parse(localStorage.getItem(storageKey) || "null");
        if (!stored || stored.v !== version) {
          var presetKeys = {};
          presets.forEach(function (p) { presetKeys[presetKey(p)] = true; });
          var kept = stored && Array.isArray(stored.queries)
            ? stored.queries.filter(function (q) {
                return q && typeof q.name === "string" && !q.preset && !presetKeys[presetKey(q)];
              })
            : [];
          var next = seeded().concat(kept);
          localStorage.setItem(storageKey, JSON.stringify({ v: version, queries: next }));
          return next;
        }
        return stored.queries;
      } catch (_) { return seeded(); }
    },
    persist: function (queries) {
      try {
        localStorage.setItem(storageKey, JSON.stringify({ v: version, queries: queries }));
      } catch (_) { /* private mode / storage full — the list still works this session */ }
    },
  };
}
// The FortiGate picker's suggestions (FortiManager Query API window): the
// discovered gates whose FortiManager name, hostname or address contains the
// typed text, prefix matches first, capped. An empty query lists every gate.
// Pure — the wiring is _wireFmgGatePicker.
var FMG_GATE_SUGGEST_CAP = 50;
function _fmgGateSuggestions(gates, query) {
  var q = String(query || "").trim().toLowerCase();
  var list = Array.isArray(gates) ? gates : [];
  if (!q) return list.slice(0, FMG_GATE_SUGGEST_CAP);
  var prefix = [];
  var inner = [];
  list.forEach(function (g) {
    var fields = [g.deviceName, g.hostname, g.ipAddress].map(function (v) { return String(v || "").toLowerCase(); });
    if (fields.some(function (f) { return f.indexOf(q) === 0; })) prefix.push(g);
    else if (fields.some(function (f) { return f.indexOf(q) > 0; })) inner.push(g);
  });
  return prefix.concat(inner).slice(0, FMG_GATE_SUGGEST_CAP);
}
// </fortinet-query-presets>

function _renderSavedQuerySelect(selectId, queries, selectValue) {
  var sel = document.getElementById(selectId);
  if (!sel) return;
  sel.innerHTML = '<option value="">— load a saved query —</option>' +
    queries.map(function (q, i) {
      return '<option value="' + i + '"' + (String(i) === String(selectValue) ? " selected" : "") + '>' + escapeHtml(q.name) + '</option>';
    }).join("");
}

// Wire one console's Load/Delete/Save buttons against its
// `<prefix>-saved-select` / `<prefix>-save-name` elements. `readForm()`
// returns the console's query fields (everything but name); `writeForm(q)`
// populates them on Load. Returns the live savedQueries array the handlers
// close over.
function _wireSavedQueryConsole(store, prefix, readForm, writeForm) {
  var savedQueries = store.load();
  var selectId = prefix + "-saved-select";
  _renderSavedQuerySelect(selectId, savedQueries);

  document.getElementById(prefix + "-load-btn").addEventListener("click", function () {
    var idx = parseInt(document.getElementById(selectId).value, 10);
    if (isNaN(idx) || !savedQueries[idx]) return;
    var q = savedQueries[idx];
    writeForm(q);
    document.getElementById(prefix + "-save-name").value = q.name;
  });

  document.getElementById(prefix + "-delete-btn").addEventListener("click", async function () {
    var idx = parseInt(document.getElementById(selectId).value, 10);
    if (isNaN(idx) || !savedQueries[idx]) return;
    var ok = await showConfirm("Delete saved query \"" + savedQueries[idx].name + "\"?");
    if (!ok) return;
    savedQueries.splice(idx, 1);
    store.persist(savedQueries);
    _renderSavedQuerySelect(selectId, savedQueries);
  });

  document.getElementById(prefix + "-save-btn").addEventListener("click", function () {
    var name = document.getElementById(prefix + "-save-name").value.trim();
    if (!name) { showToast("Enter a name for this query", "error"); return; }
    var existIdx = -1;
    savedQueries.forEach(function (q, i) { if (q.name === name) existIdx = i; });
    var entry = Object.assign({ name: name }, readForm());
    if (existIdx >= 0) {
      savedQueries[existIdx] = entry;
    } else {
      savedQueries.push(entry);
      existIdx = savedQueries.length - 1;
    }
    store.persist(savedQueries);
    _renderSavedQuerySelect(selectId, savedQueries, existIdx);
    showToast("Query saved");
  });

  return savedQueries;
}

var _fmgQueryStore = _makeSavedQueryStore(
  "polaris-fmg-queries",
  _FMG_QUERIES_VERSION,
  _FMG_PROXY_PRESET_QUERIES.concat(_FMG_DIRECT_PRESET_QUERIES),
);

function _fmgLoadQueries() { return _fmgQueryStore.load(); }
function _fmgPersistQueries(queries) { _fmgQueryStore.persist(queries); }

// Filters `queries` to the entries matching `mode` ("fmg" | "fortigate"). Entries
// saved before the mode field existed are treated as "fmg" (the legacy default).
// `selectValue` is the *original* queries-array index of the entry to preselect;
// the option's value stays the original index so load/delete can look the entry
// up by `savedQueries[idx]` without remapping.
function _fmgRenderSavedSelect(queries, mode, selectValue) {
  var sel = document.getElementById("fmg-saved-select");
  if (!sel) return;
  var filteredIdx = [];
  queries.forEach(function (q, i) {
    var qMode = q && q.mode === "fortigate" ? "fortigate" : "fmg";
    if (qMode === mode) filteredIdx.push(i);
  });
  sel.innerHTML = '<option value="">— load a saved query —</option>' +
    filteredIdx.map(function (i) {
      var q = queries[i];
      return '<option value="' + i + '"' + (String(i) === String(selectValue) ? " selected" : "") + '>' + escapeHtml(q.name) + '</option>';
    }).join("");
}

// The FortiGate picker of the FortiManager Query API window — the .aw-suggest
// combobox recipe (polaris-ui-canon: never <datalist>). Click or focus lists
// every discovered gate; typing filters; ArrowUp/Down + Enter pick; Escape
// closes the list without closing the modal. Any typed name is still sent.
function _wireFmgGatePicker(integrationId) {
  var input = document.getElementById("fmg-fgt-device");
  var sug = document.getElementById("fmg-fgt-device-suggest");
  if (!input || !sug) return;
  var gates = [];
  var state = "loading";   // loading | ready | error
  var lastQuery = "";

  function render(query) {
    lastQuery = query;
    var html;
    if (state === "loading") {
      html = '<div class="aw-suggest-empty">Loading the discovered FortiGates…</div>';
    } else if (state === "error") {
      html = '<div class="aw-suggest-empty">Couldn’t load the discovered FortiGates. Typing a name still works.</div>';
    } else if (!gates.length) {
      html = '<div class="aw-suggest-empty">No FortiGates discovered yet. Type a FortiManager device name.</div>';
    } else {
      var hits = _fmgGateSuggestions(gates, query);
      html = hits.length
        ? hits.map(function (g) {
            var detail = [g.hostname, g.ipAddress, g.status && g.status !== "active" ? g.status : ""].filter(Boolean).join(" · ");
            return '<div class="aw-suggest-item" role="option" data-val="' + escapeHtml(g.deviceName) + '" title="' + escapeHtml(g.deviceName + (detail ? " — " + detail : "")) + '">' +
              escapeHtml(g.deviceName) +
              (detail ? ' <span style="color:var(--color-text-tertiary)">' + escapeHtml(detail) + '</span>' : "") +
            '</div>';
          }).join("")
        : '<div class="aw-suggest-empty">No discovered FortiGate matches. It will be sent as typed.</div>';
    }
    sug.innerHTML = html;
    sug.classList.add("open");
  }
  function close() { sug.classList.remove("open"); }
  function pick(value) {
    input.value = value;
    close();
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Focus / click show the whole roster (a remembered name in the box must
  // not hide the others); typing narrows it.
  input.addEventListener("focus", function () { render(""); });
  input.addEventListener("click", function () { if (!sug.classList.contains("open")) render(""); });
  input.addEventListener("input", function () { render(input.value); });
  input.addEventListener("blur", function () {
    // Delay so a mousedown on a suggestion (which fires before blur completes) still lands.
    setTimeout(function () { if (!sug.contains(document.activeElement)) close(); }, 150);
  });
  sug.addEventListener("mousedown", function (e) {
    var item = e.target.closest && e.target.closest(".aw-suggest-item");
    if (!item) return;
    e.preventDefault(); // keep focus on the input
    pick(item.getAttribute("data-val"));
  });
  input.addEventListener("keydown", function (e) {
    var isOpen = sug.classList.contains("open");
    if (e.key === "Escape") {
      if (isOpen) { close(); e.stopPropagation(); } // keep the modal open
      return;
    }
    if (e.key === "ArrowDown" && !isOpen) { e.preventDefault(); render(input.value); return; }
    if (!isOpen) return;
    var items = Array.prototype.slice.call(sug.querySelectorAll(".aw-suggest-item"));
    if (!items.length) return;
    var idx = items.findIndex(function (i) { return i.classList.contains("active"); });
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      var next = e.key === "ArrowDown" ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
      items.forEach(function (i) { i.classList.remove("active"); });
      items[next].classList.add("active");
      if (items[next].scrollIntoView) items[next].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && idx >= 0) {
      e.preventDefault();
      pick(items[idx].getAttribute("data-val"));
    }
  });

  api.integrations.fortigates(integrationId).then(function (r) {
    gates = (r && r.fortigates) || [];
    state = "ready";
  }).catch(function () {
    state = "error";
  }).then(function () {
    if (sug.classList.contains("open")) render(lastQuery);
  });
}

function openApiQueryModal(id, adom, useProxy) {
  adom = adom || "root";
  if (useProxy === undefined) useProxy = true;
  var defaultParams = JSON.stringify([{
    url: "/sys/proxy/json",
    data: {
      target: ["adom/" + adom + "/device/<device-name>"],
      action: "get",
      resource: "/api/v2/monitor/system/dhcp"
    }
  }], null, 2);

  var body =
    '<div style="margin-bottom:0.75rem">' +
      '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.4rem">Query Mode</p>' +
      '<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">' +
        '<label style="display:flex;align-items:center;gap:6px;margin:0;font-weight:normal">' +
          '<input type="radio" name="fmg-mode" value="fmg" id="fmg-mode-fmg" checked style="width:auto"> FortiManager (JSON-RPC / proxy)' +
        '</label>' +
        '<label style="display:flex;align-items:center;gap:6px;margin:0;font-weight:normal">' +
          '<input type="radio" name="fmg-mode" value="fortigate" id="fmg-mode-fgt" style="width:auto"> Directly to FortiGate (REST)' +
        '</label>' +
      '</div>' +
      '<p class="hint" id="fmg-mode-hint" style="margin-top:0.4rem">FMG-side proxy is enabled — Direct-to-FortiGate is disabled. Switch off proxy to query a managed FortiGate directly.</p>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:0 0 0.75rem">' +
    '<div style="margin-bottom:0.75rem">' +
      '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.4rem">Saved Queries</p>' +
      '<div style="display:flex;gap:6px;align-items:center">' +
        '<select id="fmg-saved-select" style="flex:1"></select>' +
        '<button class="btn btn-sm btn-secondary" id="fmg-load-btn">Load</button>' +
        '<button class="btn btn-sm btn-danger" id="fmg-delete-btn">Delete</button>' +
      '</div>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:0 0 0.75rem">' +
    // ─── FortiGate (both modes) ──────────────────────────────────────────
    // A text box with a suggestion list (the .aw-suggest combobox recipe —
    // never <datalist>, which most browsers won't open on click): pick one of
    // the integration's discovered gates (GET /integrations/:id/fortigates) or
    // type any FortiManager device name.
    '<div class="form-group">' +
      '<label for="fmg-fgt-device">FortiGate</label>' +
      '<span class="aw-combo aw-combo-dim" id="fmg-fgt-device-combo">' +
        '<input type="text" id="fmg-fgt-device" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-controls="fmg-fgt-device-suggest" placeholder="Choose a discovered FortiGate or type its FortiManager name">' +
        '<div class="aw-suggest" id="fmg-fgt-device-suggest" role="listbox"></div>' +
      '</span>' +
      '<p class="hint" id="fmg-fgt-device-hint"></p>' +
    '</div>' +
    // ─── FMG (JSON-RPC) form ─────────────────────────────────────────────
    '<div id="fmg-form-fmg">' +
      '<div class="form-group">' +
        '<label>Method</label>' +
        '<select id="fmg-method" style="width:auto">' +
          '<option value="exec">exec</option>' +
          '<option value="get">get</option>' +
          '<option value="add">add</option>' +
          '<option value="set">set</option>' +
          '<option value="update">update</option>' +
          '<option value="delete">delete</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Params <span style="font-size:0.8rem;color:var(--color-text-tertiary)">(JSON array)</span></label>' +
        '<textarea id="fmg-params" rows="9" style="font-family:monospace;font-size:0.82rem">' + escapeHtml(defaultParams) + '</textarea>' +
      '</div>' +
    '</div>' +
    // ─── Direct-to-FortiGate (REST) form ─────────────────────────────────
    '<div id="fmg-form-fgt" style="display:none">' +
      '<div style="display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:end">' +
        '<div class="form-group" style="margin:0">' +
          '<label>Method</label>' +
          '<select id="fmg-fgt-method" style="width:auto">' +
            '<option value="GET">GET</option>' +
            '<option value="POST">POST</option>' +
            '<option value="PUT">PUT</option>' +
            '<option value="DELETE">DELETE</option>' +
          '</select>' +
        '</div>' +
        '<div class="form-group" style="margin:0">' +
          '<label>Path</label>' +
          '<input type="text" id="fmg-fgt-path" value="/api/v2/monitor/system/status" placeholder="/api/v2/monitor/system/status" style="font-family:monospace;font-size:0.85rem">' +
        '</div>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>API Token Override <span style="font-size:0.8rem;color:var(--color-text-tertiary)">(optional)</span></label>' +
        '<input type="password" id="fmg-fgt-token" autocomplete="off" spellcheck="false" placeholder="Leave blank to use the integration\'s stored FortiGate token">' +
        '<p class="hint">Used for this one request only — never stored on the integration, never written to Events, never kept in saved queries. Use it to test a per-gate token without repointing discovery and polling at it.</p>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Query Parameters <span style="font-size:0.8rem;color:var(--color-text-tertiary)">(one per line — <code>key=value</code>)</span></label>' +
        '<textarea id="fmg-fgt-query" rows="4" style="font-family:monospace;font-size:0.82rem" placeholder="vdom=root&#10;format=mac|ip|hostname">vdom=root</textarea>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Body <span style="font-size:0.8rem;color:var(--color-text-tertiary)">(JSON — sent for POST/PUT only)</span></label>' +
        '<textarea id="fmg-fgt-body" rows="4" style="font-family:monospace;font-size:0.82rem" placeholder=\'{"description": "IDF closet switch"}\'></textarea>' +
        '<p class="hint">Writes hit the live device config and are logged to Events. Leave empty for reads.</p>' +
      '</div>' +
    '</div>' +
    '<div style="display:flex;justify-content:flex-end;margin-bottom:0.75rem"><button class="btn btn-primary" id="fmg-send">Send</button></div>' +
    '<div style="display:flex;gap:6px;align-items:center;margin-bottom:0.25rem">' +
      '<input type="text" id="fmg-save-name" placeholder="Name this query to save it…" style="flex:1;font-size:0.85rem">' +
      '<button class="btn btn-sm btn-secondary" id="fmg-save-btn">Save</button>' +
    '</div>' +
    '<div id="fmg-response-wrap" style="display:none;margin-top:1rem">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem">' +
        '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin:0">Response</p>' +
        '<button class="btn btn-sm btn-secondary" id="fmg-copy-btn" style="padding:2px 10px;font-size:0.75rem">Copy</button>' +
      '</div>' +
      '<pre id="fmg-response" style="background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:0.75rem;font-size:0.78rem;overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-all;margin:0"></pre>' +
    '</div>';

  var footer =
    '<button class="btn btn-secondary" onclick="closeModal()">Close</button>';

  openModal("FortiManager API Query", body, footer, { wide: true });

  var savedQueries = _fmgLoadQueries();
  _fmgRenderSavedSelect(savedQueries, "fmg");

  // Prefill the Target FortiGate with the last device this integration's
  // query modal sent to (stored on Send). The field starts empty on a fresh
  // browser; loading a preset never wipes it (see the Load handler).
  try {
    var lastDevice = localStorage.getItem("polaris-fmg-query-device-" + id);
    var deviceInput = document.getElementById("fmg-fgt-device");
    if (lastDevice && deviceInput && !deviceInput.value) deviceInput.value = lastDevice;
  } catch (_) { /* private mode */ }

  // Mode toggle: when FMG proxy mode is enabled, the "Directly to FortiGate"
  // option is disabled. Lock state is driven by the integration's `useProxy`
  // flag (passed in from the caller; default true). The user can still browse
  // the radio if proxy is off.
  var fgtRadio = document.getElementById("fmg-mode-fgt");
  var fmgRadio = document.getElementById("fmg-mode-fmg");
  var modeHint = document.getElementById("fmg-mode-hint");
  if (useProxy) {
    fgtRadio.disabled = true;
    fgtRadio.parentElement.style.opacity = "0.5";
    fgtRadio.parentElement.title = "Disabled while FortiManager proxy mode is enabled on this integration";
  } else {
    if (modeHint) modeHint.textContent = "FMG-side proxy is disabled — choose either transport.";
  }
  function _fmgApplyMode(mode) {
    document.getElementById("fmg-form-fmg").style.display = mode === "fmg" ? "" : "none";
    document.getElementById("fmg-form-fgt").style.display = mode === "fortigate" ? "" : "none";
    var deviceHint = document.getElementById("fmg-fgt-device-hint");
    if (deviceHint) {
      deviceHint.innerHTML = mode === "fortigate"
        ? "The FortiGate to send to, by its name in FortiManager. Polaris looks up its management IP in FortiManager, then sends the REST call directly with the integration's FortiGate API token."
        : "Replaces <code>&lt;device-name&gt;</code> in the params when you send. Not needed for a query that names no FortiGate.";
    }
    // Repopulate the Saved Queries dropdown with the presets/saves that match
    // the newly selected transport. The dropdown's option value is the original
    // index into savedQueries, so load/delete still resolve by that index.
    // Preserve the current selection across the re-render so loading a query
    // and then clicking Send doesn't reset the dropdown to "— load a saved
    // query —". When the mode actually changes the prior selection's option
    // will be filtered out and the dropdown collapses to its placeholder.
    var sel = document.getElementById("fmg-saved-select");
    var prior = sel ? sel.value : "";
    _fmgRenderSavedSelect(savedQueries, mode, prior);
  }
  _fmgApplyMode("fmg");

  _wireFmgGatePicker(id);

  fmgRadio.addEventListener("change", function () { if (this.checked) _fmgApplyMode("fmg"); });
  fgtRadio.addEventListener("change", function () { if (this.checked) _fmgApplyMode("fortigate"); });

  document.getElementById("fmg-load-btn").addEventListener("click", function () {
    var idx = parseInt(document.getElementById("fmg-saved-select").value, 10);
    if (isNaN(idx) || !savedQueries[idx]) return;
    var q = savedQueries[idx];
    if (q.mode === "fortigate") {
      if (!fgtRadio.disabled) {
        fgtRadio.checked = true; _fmgApplyMode("fortigate");
        document.getElementById("fmg-fgt-method").value = q.method || "GET";
        document.getElementById("fmg-fgt-path").value = q.path || "";
        // Only overwrite the Target FortiGate when the saved query actually
        // carries one — the presets store deviceName:"" (operator fills the
        // target per query), so loading them must not wipe the device the
        // operator already typed.
        if (q.deviceName) document.getElementById("fmg-fgt-device").value = q.deviceName;
        document.getElementById("fmg-fgt-query").value = q.query || "";
        document.getElementById("fmg-fgt-body").value = q.body || "";
      } else {
        showToast("This saved query targets a FortiGate directly — disable FMG proxy on the integration to load it", "error");
        return;
      }
    } else {
      fmgRadio.checked = true; _fmgApplyMode("fmg");
      document.getElementById("fmg-method").value = q.method;
      document.getElementById("fmg-params").value = _substituteFmgAdom(q.params, adom);
    }
    document.getElementById("fmg-save-name").value = q.name;
  });

  document.getElementById("fmg-delete-btn").addEventListener("click", async function () {
    var idx = parseInt(document.getElementById("fmg-saved-select").value, 10);
    if (isNaN(idx) || !savedQueries[idx]) return;
    var ok = await showConfirm("Delete saved query \"" + savedQueries[idx].name + "\"?");
    if (!ok) return;
    savedQueries.splice(idx, 1);
    _fmgPersistQueries(savedQueries);
    _fmgRenderSavedSelect(savedQueries, _fmgCurrentMode());
  });

  function _fmgCurrentMode() {
    return fgtRadio.checked ? "fortigate" : "fmg";
  }

  document.getElementById("fmg-save-btn").addEventListener("click", function () {
    var name = document.getElementById("fmg-save-name").value.trim();
    if (!name) { showToast("Enter a name for this query", "error"); return; }
    var mode = _fmgCurrentMode();
    var entry;
    if (mode === "fortigate") {
      // NOTE: the API token override is deliberately absent. Saved queries go
      // to localStorage in the clear — a token must never land there. Keep this
      // an explicit field list rather than a spread of the form, so a new field
      // can't be swept in by accident.
      entry = {
        name: name,
        mode: "fortigate",
        method: document.getElementById("fmg-fgt-method").value,
        path: document.getElementById("fmg-fgt-path").value.trim(),
        deviceName: document.getElementById("fmg-fgt-device").value.trim(),
        query: document.getElementById("fmg-fgt-query").value,
        body: document.getElementById("fmg-fgt-body").value,
      };
    } else {
      entry = {
        name: name,
        mode: "fmg",
        method: document.getElementById("fmg-method").value,
        params: document.getElementById("fmg-params").value.trim(),
      };
    }
    var existIdx = -1;
    savedQueries.forEach(function (q, i) { if (q.name === name) existIdx = i; });
    if (existIdx >= 0) {
      savedQueries[existIdx] = entry;
    } else {
      savedQueries.push(entry);
      existIdx = savedQueries.length - 1;
    }
    _fmgPersistQueries(savedQueries);
    _fmgRenderSavedSelect(savedQueries, mode, existIdx);
    showToast("Query saved");
  });

  document.getElementById("fmg-send").addEventListener("click", async function () {
    var btn = this;
    var mode = _fmgCurrentMode();
    var payload;
    if (mode === "fortigate") {
      var deviceName = document.getElementById("fmg-fgt-device").value.trim();
      var path = document.getElementById("fmg-fgt-path").value.trim();
      if (!deviceName) { showToast("Choose or type a FortiGate", "error"); return; }
      if (!path) { showToast("Enter a path (e.g. /api/v2/monitor/system/status)", "error"); return; }
      var fgtMethod = document.getElementById("fmg-fgt-method").value;
      var bodyRaw = document.getElementById("fmg-fgt-body").value.trim();
      var bodyJson;
      if (bodyRaw) {
        if (fgtMethod !== "POST" && fgtMethod !== "PUT") {
          showToast("A body is only sent for POST/PUT — switch the method or clear the body", "error");
          return;
        }
        try { bodyJson = JSON.parse(bodyRaw); } catch (e) {
          showToast("Invalid body JSON: " + e.message, "error");
          return;
        }
      }
      var query = {};
      document.getElementById("fmg-fgt-query").value.split("\n").forEach(function (line) {
        var trimmed = line.trim();
        if (!trimmed) return;
        var eq = trimmed.indexOf("=");
        if (eq < 0) { query[trimmed] = ""; return; }
        var key = trimmed.slice(0, eq).trim();
        var value = trimmed.slice(eq + 1).trim();
        if (key) query[key] = value;
      });
      payload = {
        mode: "fortigate",
        deviceName: deviceName,
        method: fgtMethod,
        path: path,
        query: query,
      };
      if (bodyJson !== undefined) payload.body = bodyJson;
      // Per-request credential override. Sent only when typed; deliberately not
      // persisted anywhere on this side either — it is read straight off the
      // field at Send time and is absent from the saved-query entry below.
      var tokenOverride = document.getElementById("fmg-fgt-token").value.trim();
      if (tokenOverride) payload.apiToken = tokenOverride;
      // Remember the target per integration so reopening the modal doesn't
      // force retyping it. Prefilled on modal open below.
      try { localStorage.setItem("polaris-fmg-query-device-" + id, deviceName); } catch (_) { /* private mode */ }
    } else {
      var method = document.getElementById("fmg-method").value;
      var paramsRaw = document.getElementById("fmg-params").value.trim();
      // <device-name> is filled from the FortiGate field at Send time, so the
      // params box (and a query saved from it) keeps the placeholder and
      // works for whichever gate is picked next. JSON-escaped: a name is
      // operator text and lands inside a JSON string.
      if (paramsRaw.indexOf("<device-name>") >= 0) {
        var fmgDevice = document.getElementById("fmg-fgt-device").value.trim();
        if (!fmgDevice) { showToast("Choose or type a FortiGate — the params name <device-name>", "error"); return; }
        paramsRaw = paramsRaw.split("<device-name>").join(JSON.stringify(fmgDevice).slice(1, -1));
        try { localStorage.setItem("polaris-fmg-query-device-" + id, fmgDevice); } catch (_) { /* private mode */ }
      }
      var params;
      try {
        params = JSON.parse(paramsRaw);
        if (!Array.isArray(params)) throw new Error("Params must be a JSON array");
      } catch (e) {
        showToast("Invalid JSON: " + e.message, "error");
        return;
      }
      payload = { mode: "fmg", method: method, params: params };
    }
    btn.disabled = true;
    btn.textContent = "Sending…";
    var responseWrap = document.getElementById("fmg-response-wrap");
    var responsePre = document.getElementById("fmg-response");
    try {
      var result = await api.integrations.query(id, payload);
      responseWrap.style.display = "";
      responsePre.textContent = JSON.stringify(result, null, 2);
    } catch (err) {
      responseWrap.style.display = "";
      responsePre.textContent = "Error: " + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "Send";
    }
  });

  document.getElementById("fmg-copy-btn").addEventListener("click", function () {
    var text = document.getElementById("fmg-response").textContent;
    var btn = this;
    copyTextToClipboard(text).then(function (ok) {
      if (!ok) { showToast("Copy failed", "error"); return; }
      btn.textContent = "Copied!";
      setTimeout(function () { btn.textContent = "Copy"; }, 1500);
    });
  });
}

// ─── FortiGate API Query modal ──────────────────────────────────────────────

var _fgtQueryStore = _makeSavedQueryStore("polaris-fgt-queries", _FGT_QUERIES_VERSION, _FGT_PRESET_QUERIES);

function openFgtApiQueryModal(id, vdom) {
  vdom = vdom || "root";

  var body =
    '<div style="margin-bottom:0.75rem">' +
      '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.4rem">Saved Queries</p>' +
      '<div style="display:flex;gap:6px;align-items:center">' +
        '<select id="fgt-saved-select" style="flex:1"></select>' +
        '<button class="btn btn-sm btn-secondary" id="fgt-load-btn">Load</button>' +
        '<button class="btn btn-sm btn-danger" id="fgt-delete-btn">Delete</button>' +
      '</div>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:0 0 0.75rem">' +
    '<div style="display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:end">' +
      '<div class="form-group" style="margin:0">' +
        '<label>Method</label>' +
        '<select id="fgt-method" style="width:auto">' +
          '<option value="GET">GET</option>' +
          '<option value="POST">POST</option>' +
          '<option value="PUT">PUT</option>' +
          '<option value="DELETE">DELETE</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group" style="margin:0">' +
        '<label>Path</label>' +
        '<input type="text" id="fgt-path" value="/api/v2/monitor/system/status" placeholder="/api/v2/monitor/system/status" style="font-family:monospace;font-size:0.85rem">' +
      '</div>' +
    '</div>' +
    '<div class="form-group" style="margin-top:0.75rem">' +
      '<label>Query Parameters <span style="font-size:0.8rem;color:var(--color-text-tertiary)">(one per line — <code>key=value</code>)</span></label>' +
      '<textarea id="fgt-query" rows="4" style="font-family:monospace;font-size:0.82rem" placeholder="vdom=' + escapeHtml(vdom) + '&#10;format=mac|ip|hostname">vdom=' + escapeHtml(vdom) + '</textarea>' +
      '<p class="hint">VDOM is set here; add other parameters like <code>format=…</code> or <code>filter=…</code> as needed.</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Body <span style="font-size:0.8rem;color:var(--color-text-tertiary)">(JSON — sent for POST/PUT only)</span></label>' +
      '<textarea id="fgt-body" rows="4" style="font-family:monospace;font-size:0.82rem" placeholder=\'{"description": "IDF closet switch"}\'></textarea>' +
      '<p class="hint">Writes hit the live device config and are logged to Events. Leave empty for reads.</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>API Token Override <span style="font-size:0.8rem;color:var(--color-text-tertiary)">(optional)</span></label>' +
      '<input type="password" id="fgt-token" autocomplete="off" spellcheck="false" placeholder="Leave blank to use the integration\'s stored API token">' +
      '<p class="hint">Used for this one request only — never stored on the integration, never written to Events, never kept in saved queries.</p>' +
    '</div>' +
    '<div style="display:flex;justify-content:flex-end;margin-bottom:0.75rem"><button class="btn btn-primary" id="fgt-send">Send</button></div>' +
    '<div style="display:flex;gap:6px;align-items:center;margin-bottom:0.25rem">' +
      '<input type="text" id="fgt-save-name" placeholder="Name this query to save it…" style="flex:1;font-size:0.85rem">' +
      '<button class="btn btn-sm btn-secondary" id="fgt-save-btn">Save</button>' +
    '</div>' +
    '<div id="fgt-response-wrap" style="display:none;margin-top:1rem">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem">' +
        '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin:0">Response</p>' +
        '<button class="btn btn-sm btn-secondary" id="fgt-copy-btn" style="padding:2px 10px;font-size:0.75rem">Copy</button>' +
      '</div>' +
      '<pre id="fgt-response" style="background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:0.75rem;font-size:0.78rem;overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-all;margin:0"></pre>' +
    '</div>';

  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Close</button>';

  openModal("FortiGate API Query", body, footer, { wide: true });

  _wireSavedQueryConsole(_fgtQueryStore, "fgt",
    function () {
      return {
        method: document.getElementById("fgt-method").value,
        path: document.getElementById("fgt-path").value.trim(),
        query: document.getElementById("fgt-query").value,
        body: document.getElementById("fgt-body").value,
      };
    },
    function (q) {
      document.getElementById("fgt-method").value = q.method || "GET";
      document.getElementById("fgt-path").value = q.path || "";
      document.getElementById("fgt-query").value = q.query || "";
      document.getElementById("fgt-body").value = q.body || "";
    });

  document.getElementById("fgt-send").addEventListener("click", async function () {
    var btn = this;
    var method = document.getElementById("fgt-method").value;
    var path = document.getElementById("fgt-path").value.trim();
    if (!path) { showToast("Enter a path (e.g. /api/v2/monitor/system/status)", "error"); return; }
    var bodyRaw = document.getElementById("fgt-body").value.trim();
    var bodyJson;
    if (bodyRaw) {
      if (method !== "POST" && method !== "PUT") {
        showToast("A body is only sent for POST/PUT — switch the method or clear the body", "error");
        return;
      }
      try { bodyJson = JSON.parse(bodyRaw); } catch (e) {
        showToast("Invalid body JSON: " + e.message, "error");
        return;
      }
    }
    var queryRaw = document.getElementById("fgt-query").value;
    var query = {};
    queryRaw.split("\n").forEach(function (line) {
      var trimmed = line.trim();
      if (!trimmed) return;
      var eq = trimmed.indexOf("=");
      if (eq < 0) { query[trimmed] = ""; return; }
      var key = trimmed.slice(0, eq).trim();
      var value = trimmed.slice(eq + 1).trim();
      if (key) query[key] = value;
    });
    btn.disabled = true;
    btn.textContent = "Sending…";
    var responseWrap = document.getElementById("fgt-response-wrap");
    var responsePre = document.getElementById("fgt-response");
    try {
      var fgtPayload = { method: method, path: path, query: query };
      if (bodyJson !== undefined) fgtPayload.body = bodyJson;
      // Per-request credential override — read at Send time, never persisted.
      // The saved-query getter above deliberately omits it (localStorage).
      var fgtTokenOverride = document.getElementById("fgt-token").value.trim();
      if (fgtTokenOverride) fgtPayload.apiToken = fgtTokenOverride;
      var result = await api.integrations.query(id, fgtPayload);
      responseWrap.style.display = "";
      responsePre.textContent = JSON.stringify(result, null, 2);
    } catch (err) {
      responseWrap.style.display = "";
      responsePre.textContent = "Error: " + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "Send";
    }
  });

  document.getElementById("fgt-copy-btn").addEventListener("click", function () {
    var text = document.getElementById("fgt-response").textContent;
    var btn = this;
    copyTextToClipboard(text).then(function (ok) {
      if (!ok) { showToast("Copy failed", "error"); return; }
      btn.textContent = "Copied!";
      setTimeout(function () { btn.textContent = "Copy"; }, 1500);
    });
  });
}

// ─── Entra ID API Query modal ───────────────────────────────────────────────

var _ENTRA_PRESET_QUERIES = [
  {
    name: "All registered devices",
    path: "/v1.0/devices",
    query: "$top=25\n$select=id,deviceId,displayName,operatingSystem,operatingSystemVersion,trustType,approximateLastSignInDateTime",
  },
  {
    name: "All managed devices (Intune)",
    path: "/v1.0/deviceManagement/managedDevices",
    query: "$top=25\n$select=id,azureADDeviceId,deviceName,operatingSystem,osVersion,complianceState,lastSyncDateTime,userPrincipalName,chassisType",
  },
  {
    name: "Windows devices only",
    path: "/v1.0/devices",
    query: "$top=25\n$filter=operatingSystem eq 'Windows'\n$select=id,deviceId,displayName,operatingSystem,operatingSystemVersion,trustType,approximateLastSignInDateTime",
  },
  {
    name: "Device by display name prefix (edit startswith value)",
    path: "/v1.0/devices",
    query: "$filter=startswith(displayName,'LAPTOP')\n$select=id,deviceId,displayName,operatingSystem,operatingSystemVersion,trustType",
  },
  {
    name: "Non-compliant devices (Intune)",
    path: "/v1.0/deviceManagement/managedDevices",
    query: "$filter=complianceState eq 'noncompliant'\n$select=id,deviceName,operatingSystem,complianceState,lastSyncDateTime,userPrincipalName\n$top=25",
  },
  {
    name: "Hybrid-joined devices",
    path: "/v1.0/devices",
    query: "$filter=trustType eq 'ServerAd'\n$top=25\n$select=id,deviceId,displayName,operatingSystem,operatingSystemVersion,onPremisesSecurityIdentifier,approximateLastSignInDateTime",
  },
  {
    name: "Logged-on users of one device (Intune, beta — paste its managed device id)",
    path: "/beta/deviceManagement/managedDevices/<managed-device-id>",
    query: "$select=id,deviceName,userId,userPrincipalName,usersLoggedOn",
  },
  {
    name: "Users (summary)",
    path: "/v1.0/users",
    query: "$top=25\n$select=id,displayName,userPrincipalName,accountEnabled,jobTitle,department",
  },
  {
    name: "Groups",
    path: "/v1.0/groups",
    query: "$top=25\n$select=id,displayName,groupTypes,membershipRule,mail",
  },
];

// 2: the logged-on-users read (business rule 180).
var _ENTRA_QUERIES_VERSION = 2;

var _entraQueryStore = _makeSavedQueryStore("polaris-entra-queries", _ENTRA_QUERIES_VERSION, _ENTRA_PRESET_QUERIES);

function openEntraApiQueryModal(id) {
  var body =
    '<div style="margin-bottom:0.75rem">' +
      '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.4rem">Saved Queries</p>' +
      '<div style="display:flex;gap:6px;align-items:center">' +
        '<select id="entra-saved-select" style="flex:1"></select>' +
        '<button class="btn btn-sm btn-secondary" id="entra-load-btn">Load</button>' +
        '<button class="btn btn-sm btn-danger" id="entra-delete-btn">Delete</button>' +
      '</div>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:0 0 0.75rem">' +
    '<div class="form-group">' +
      '<label>Path <span style="font-size:0.8rem;color:var(--color-text-tertiary)">(GET only — must begin with <code>/v1.0/</code> or <code>/beta/</code>)</span></label>' +
      '<input type="text" id="entra-path" value="/v1.0/devices" placeholder="/v1.0/deviceManagement/managedDevices" style="font-family:monospace;font-size:0.85rem">' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Query Parameters <span style="font-size:0.8rem;color:var(--color-text-tertiary)">(one per line — <code>key=value</code>)</span></label>' +
      '<textarea id="entra-query" rows="5" style="font-family:monospace;font-size:0.82rem" placeholder="$top=10&#10;$select=id,deviceId,displayName&#10;$filter=startswith(displayName,&apos;LAPTOP&apos;)"></textarea>' +
      '<p class="hint">Common: <code>$select=…</code> to limit fields, <code>$filter=…</code> to narrow results, <code>$top=…</code> to cap rows. Host is fixed to <code>graph.microsoft.com</code>.</p>' +
    '</div>' +
    '<div style="display:flex;justify-content:flex-end;margin-bottom:0.75rem"><button class="btn btn-primary" id="entra-send">Send</button></div>' +
    '<div style="display:flex;gap:6px;align-items:center;margin-bottom:0.25rem">' +
      '<input type="text" id="entra-save-name" placeholder="Name this query to save it…" style="flex:1;font-size:0.85rem">' +
      '<button class="btn btn-sm btn-secondary" id="entra-save-btn">Save</button>' +
    '</div>' +
    '<div id="entra-response-wrap" style="display:none;margin-top:1rem">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem">' +
        '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin:0">Response</p>' +
        '<button class="btn btn-sm btn-secondary" id="entra-copy-btn" style="padding:2px 10px;font-size:0.75rem">Copy</button>' +
      '</div>' +
      '<pre id="entra-response" style="background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:0.75rem;font-size:0.78rem;overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-all;margin:0"></pre>' +
    '</div>';

  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Close</button>';

  openModal("Entra ID / Graph API Query", body, footer, { wide: true });

  _wireSavedQueryConsole(_entraQueryStore, "entra",
    function () {
      return {
        path: document.getElementById("entra-path").value.trim(),
        query: document.getElementById("entra-query").value,
      };
    },
    function (q) {
      document.getElementById("entra-path").value = q.path || "";
      document.getElementById("entra-query").value = q.query || "";
    });

  document.getElementById("entra-send").addEventListener("click", async function () {
    var btn = this;
    var path = document.getElementById("entra-path").value.trim();
    if (!path) { showToast("Enter a path (e.g. /v1.0/devices)", "error"); return; }
    var queryRaw = document.getElementById("entra-query").value;
    var query = {};
    queryRaw.split("\n").forEach(function (line) {
      var trimmed = line.trim();
      if (!trimmed) return;
      var eq = trimmed.indexOf("=");
      if (eq < 0) { query[trimmed] = ""; return; }
      var key = trimmed.slice(0, eq).trim();
      var value = trimmed.slice(eq + 1).trim();
      if (key) query[key] = value;
    });
    btn.disabled = true;
    btn.textContent = "Sending…";
    var responseWrap = document.getElementById("entra-response-wrap");
    var responsePre = document.getElementById("entra-response");
    try {
      var result = await api.integrations.query(id, { path: path, query: query });
      responseWrap.style.display = "";
      responsePre.textContent = JSON.stringify(result, null, 2);
    } catch (err) {
      responseWrap.style.display = "";
      responsePre.textContent = "Error: " + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "Send";
    }
  });

  document.getElementById("entra-copy-btn").addEventListener("click", function () {
    var text = document.getElementById("entra-response").textContent;
    var btn = this;
    copyTextToClipboard(text).then(function (ok) {
      if (!ok) { showToast("Copy failed", "error"); return; }
      btn.textContent = "Copied!";
      setTimeout(function () { btn.textContent = "Copy"; }, 1500);
    });
  });
}

// ─── Azure Arc / ARM Query modal ────────────────────────────────────────────
// The operator's only self-service way to answer "why didn't machine X get
// discovered?" — the backend pins the host to management.azure.com, requires
// an api-version, and permits POST only to the Resource Graph endpoint.

var _ARC_QUERIES_VERSION = 1;
var _ARC_PRESET_QUERIES = [
  {
    name: "All Arc machines in a subscription",
    path: "/subscriptions/<subscription-id>/providers/Microsoft.HybridCompute/machines",
    query: "api-version=2024-07-10",
  },
  {
    name: "Arc machines in one resource group",
    path: "/subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.HybridCompute/machines",
    query: "api-version=2024-07-10",
  },
  {
    name: "Single machine (full detail)",
    path: "/subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.HybridCompute/machines/<machine-name>",
    query: "api-version=2024-07-10",
  },
  {
    name: "Subscriptions this app can see",
    path: "/subscriptions",
    query: "api-version=2022-12-01",
  },
];
var _arcQueryStore = _makeSavedQueryStore("polaris-arc-queries", _ARC_QUERIES_VERSION, _ARC_PRESET_QUERIES);

function openArcApiQueryModal(id) {
  var body =
    '<div style="margin-bottom:0.75rem">' +
      '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.4rem">Saved Queries</p>' +
      '<div style="display:flex;gap:6px;align-items:center">' +
        '<select id="arc-saved-select" style="flex:1"></select>' +
        '<button class="btn btn-sm btn-secondary" id="arc-load-btn">Load</button>' +
        '<button class="btn btn-sm btn-danger" id="arc-delete-btn">Delete</button>' +
      '</div>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:0 0 0.75rem">' +
    '<div class="form-group">' +
      '<label>Path <span style="font-size:0.8rem;color:var(--color-text-tertiary)">(GET only — must begin with <code>/subscriptions/</code> or <code>/providers/</code>)</span></label>' +
      '<input type="text" id="arc-path" value="/subscriptions" placeholder="/subscriptions/&lt;id&gt;/providers/Microsoft.HybridCompute/machines" style="font-family:monospace;font-size:0.85rem">' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Query Parameters <span style="font-size:0.8rem;color:var(--color-text-tertiary)">(one per line — <code>key=value</code>)</span></label>' +
      '<textarea id="arc-query" rows="4" style="font-family:monospace;font-size:0.82rem" placeholder="api-version=2024-07-10&#10;$top=25">api-version=2022-12-01</textarea>' +
      '<p class="hint"><code>api-version</code> is <strong>required</strong> on every ARM call — a missing one is rejected before the request leaves Polaris. Host is fixed to <code>management.azure.com</code>.</p>' +
    '</div>' +
    '<div style="display:flex;justify-content:flex-end;margin-bottom:0.75rem"><button class="btn btn-primary" id="arc-send">Send</button></div>' +
    '<div style="display:flex;gap:6px;align-items:center;margin-bottom:0.25rem">' +
      '<input type="text" id="arc-save-name" placeholder="Name this query to save it…" style="flex:1;font-size:0.85rem">' +
      '<button class="btn btn-sm btn-secondary" id="arc-save-btn">Save</button>' +
    '</div>' +
    '<div id="arc-response-wrap" style="display:none;margin-top:1rem">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem">' +
        '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin:0">Response</p>' +
        '<button class="btn btn-sm btn-secondary" id="arc-copy-btn" style="padding:2px 10px;font-size:0.75rem">Copy</button>' +
      '</div>' +
      '<pre id="arc-response" style="background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:0.75rem;font-size:0.78rem;overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-all;margin:0"></pre>' +
    '</div>';

  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Close</button>';

  openModal("Azure Arc / Resource Manager Query", body, footer, { wide: true });

  _wireSavedQueryConsole(_arcQueryStore, "arc",
    function () {
      return {
        path: document.getElementById("arc-path").value.trim(),
        query: document.getElementById("arc-query").value,
      };
    },
    function (q) {
      document.getElementById("arc-path").value = q.path || "";
      document.getElementById("arc-query").value = q.query || "";
    });

  document.getElementById("arc-send").addEventListener("click", async function () {
    var btn = this;
    var path = document.getElementById("arc-path").value.trim();
    if (!path) { showToast("Enter a path (e.g. /subscriptions)", "error"); return; }
    var queryRaw = document.getElementById("arc-query").value;
    var query = {};
    queryRaw.split("\n").forEach(function (line) {
      var trimmed = line.trim();
      if (!trimmed) return;
      var eq = trimmed.indexOf("=");
      if (eq < 0) { query[trimmed] = ""; return; }
      var key = trimmed.slice(0, eq).trim();
      var value = trimmed.slice(eq + 1).trim();
      if (key) query[key] = value;
    });
    btn.disabled = true;
    btn.textContent = "Sending…";
    var responseWrap = document.getElementById("arc-response-wrap");
    var responsePre = document.getElementById("arc-response");
    try {
      var result = await api.integrations.query(id, { method: "GET", path: path, query: query });
      responseWrap.style.display = "";
      responsePre.textContent = JSON.stringify(result, null, 2);
    } catch (err) {
      responseWrap.style.display = "";
      responsePre.textContent = "Error: " + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "Send";
    }
  });

  document.getElementById("arc-copy-btn").addEventListener("click", function () {
    var text = document.getElementById("arc-response").textContent;
    var btn = this;
    copyTextToClipboard(text).then(function (ok) {
      if (!ok) { showToast("Copy failed", "error"); return; }
      btn.textContent = "Copied!";
      setTimeout(function () { btn.textContent = "Copy"; }, 1500);
    });
  });
}

// ─── Active Directory LDAP Query modal ──────────────────────────────────────

var _AD_PRESET_QUERIES = [
  {
    name: "All computers (summary)",
    filter: "(&(objectCategory=computer)(objectClass=computer))",
    attributes: "cn, dNSHostName, operatingSystem, operatingSystemVersion, userAccountControl, lastLogonTimestamp",
    sizeLimit: "50",
  },
  {
    name: "Servers (by OS)",
    filter: "(&(objectCategory=computer)(objectClass=computer)(operatingSystem=*Server*))",
    attributes: "cn, dNSHostName, operatingSystem, operatingSystemVersion, lastLogonTimestamp, whenCreated",
    sizeLimit: "50",
  },
  {
    name: "Workstations (non-server OS)",
    filter: "(&(objectCategory=computer)(objectClass=computer)(!(operatingSystem=*Server*)))",
    attributes: "cn, dNSHostName, operatingSystem, operatingSystemVersion, lastLogonTimestamp",
    sizeLimit: "50",
  },
  {
    name: "Disabled computer accounts",
    filter: "(&(objectCategory=computer)(objectClass=computer)(userAccountControl:1.2.840.113556.1.4.803:=2))",
    attributes: "cn, dNSHostName, operatingSystem, userAccountControl, whenCreated, distinguishedName",
    sizeLimit: "50",
  },
  {
    name: "Never logged on computers",
    filter: "(&(objectCategory=computer)(objectClass=computer)(!(lastLogonTimestamp=*)))",
    attributes: "cn, dNSHostName, operatingSystem, whenCreated, distinguishedName",
    sizeLimit: "50",
  },
  {
    name: "Computer by hostname (edit CN=)",
    filter: "(&(objectCategory=computer)(cn=HOSTNAME*))",
    attributes: "cn, dNSHostName, distinguishedName, operatingSystem, operatingSystemVersion, objectGUID, objectSid, userAccountControl, lastLogonTimestamp, whenCreated, description",
    sizeLimit: "10",
  },
  {
    name: "All OUs (directory structure)",
    filter: "(objectClass=organizationalUnit)",
    attributes: "ou, distinguishedName, description",
    sizeLimit: "200",
  },
  {
    name: "User accounts (summary)",
    filter: "(&(objectCategory=person)(objectClass=user))",
    attributes: "sAMAccountName, displayName, mail, userAccountControl, lastLogon, distinguishedName",
    sizeLimit: "50",
  },
];

var _AD_QUERIES_VERSION = 1;

var _adQueryStore = _makeSavedQueryStore("polaris-ad-queries", _AD_QUERIES_VERSION, _AD_PRESET_QUERIES);

function openAdApiQueryModal(id) {
  var body =
    '<div style="margin-bottom:0.75rem">' +
      '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.4rem">Saved Queries</p>' +
      '<div style="display:flex;gap:6px;align-items:center">' +
        '<select id="ad-saved-select" style="flex:1"></select>' +
        '<button class="btn btn-sm btn-secondary" id="ad-load-btn">Load</button>' +
        '<button class="btn btn-sm btn-danger" id="ad-delete-btn">Delete</button>' +
      '</div>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:0 0 0.75rem">' +
    '<div class="form-group">' +
      '<label>Filter <span style="font-size:0.8rem;color:var(--color-text-tertiary)">(LDAP search filter)</span></label>' +
      '<input type="text" id="ad-filter" value="(&(objectCategory=computer)(objectClass=computer))" style="font-family:monospace;font-size:0.85rem">' +
      '<p class="hint">Examples: <code>(&(objectCategory=computer)(operatingSystem=*Server*))</code> &nbsp;·&nbsp; <code>(&(objectCategory=person)(objectClass=user))</code></p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Attributes <span style="font-size:0.8rem;color:var(--color-text-tertiary)">(comma-separated; leave empty for all)</span></label>' +
      '<input type="text" id="ad-attributes" value="cn, dNSHostName, operatingSystem, operatingSystemVersion, userAccountControl, lastLogonTimestamp" style="font-family:monospace;font-size:0.85rem">' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:end">' +
      '<div class="form-group" style="margin-bottom:0">' +
        '<label>Base DN override <span style="font-size:0.8rem;color:var(--color-text-tertiary)">(optional)</span></label>' +
        '<input type="text" id="ad-basedn" placeholder="Defaults to integration base DN" style="font-family:monospace;font-size:0.85rem">' +
      '</div>' +
      '<div class="form-group" style="margin-bottom:0">' +
        '<label>Scope</label>' +
        '<select id="ad-scope" style="width:auto">' +
          '<option value="sub" selected>Subtree (recursive)</option>' +
          '<option value="one">One level</option>' +
          '<option value="base">Base only</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group" style="margin-bottom:0">' +
        '<label>Limit</label>' +
        '<input type="number" id="ad-sizelimit" value="50" min="1" max="500" style="width:70px">' +
      '</div>' +
    '</div>' +
    '<div style="display:flex;justify-content:flex-end;margin:0.75rem 0"><button class="btn btn-primary" id="ad-send">Send</button></div>' +
    '<div style="display:flex;gap:6px;align-items:center;margin-bottom:0.25rem">' +
      '<input type="text" id="ad-save-name" placeholder="Name this query to save it…" style="flex:1;font-size:0.85rem">' +
      '<button class="btn btn-sm btn-secondary" id="ad-save-btn">Save</button>' +
    '</div>' +
    '<div id="ad-response-wrap" style="display:none;margin-top:1rem">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem">' +
        '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin:0">Response</p>' +
        '<button class="btn btn-sm btn-secondary" id="ad-copy-btn" style="padding:2px 10px;font-size:0.75rem">Copy</button>' +
      '</div>' +
      '<pre id="ad-response" style="background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:0.75rem;font-size:0.78rem;overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-all;margin:0"></pre>' +
    '</div>';

  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Close</button>';

  openModal("Active Directory LDAP Query", body, footer, { wide: true });

  _wireSavedQueryConsole(_adQueryStore, "ad",
    function () {
      return {
        filter: document.getElementById("ad-filter").value.trim(),
        attributes: document.getElementById("ad-attributes").value,
        sizeLimit: document.getElementById("ad-sizelimit").value,
      };
    },
    function (q) {
      document.getElementById("ad-filter").value = q.filter || "";
      document.getElementById("ad-attributes").value = q.attributes || "";
      if (q.sizeLimit) document.getElementById("ad-sizelimit").value = q.sizeLimit;
    });

  document.getElementById("ad-send").addEventListener("click", async function () {
    var btn = this;
    var filter = document.getElementById("ad-filter").value.trim();
    if (!filter) { showToast("Enter a filter (e.g. (&(objectCategory=computer)(objectClass=computer)))", "error"); return; }
    var attrsRaw = document.getElementById("ad-attributes").value;
    var attrs = attrsRaw.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    var baseDn = document.getElementById("ad-basedn").value.trim() || undefined;
    var scope = document.getElementById("ad-scope").value;
    var sizeLimit = parseInt(document.getElementById("ad-sizelimit").value, 10) || 50;

    btn.disabled = true;
    btn.textContent = "Sending…";
    var responseWrap = document.getElementById("ad-response-wrap");
    var responsePre = document.getElementById("ad-response");
    try {
      var body = { filter: filter, scope: scope, sizeLimit: sizeLimit };
      if (attrs.length > 0) body.attributes = attrs;
      if (baseDn) body.baseDn = baseDn;
      var result = await api.integrations.query(id, body);
      responseWrap.style.display = "";
      responsePre.textContent = JSON.stringify(result, null, 2);
    } catch (err) {
      responseWrap.style.display = "";
      responsePre.textContent = "Error: " + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "Send";
    }
  });

  document.getElementById("ad-copy-btn").addEventListener("click", function () {
    var text = document.getElementById("ad-response").textContent;
    var btn = this;
    copyTextToClipboard(text).then(function (ok) {
      if (!ok) { showToast("Copy failed", "error"); return; }
      btn.textContent = "Copied!";
      setTimeout(function () { btn.textContent = "Copy"; }, 1500);
    });
  });
}

// ─── vCenter API Query modal ────────────────────────────────────────────────
// vSphere Automation REST surface only — the backend proxy rejects paths
// outside "/api/". Same saved-query pattern as the FortiGate modal.

var _VC_PRESET_QUERIES = [
  {
    name: "All virtual machines",
    method: "GET",
    path: "/api/vcenter/vm",
    query: "",
  },
  {
    name: "All ESXi hosts",
    method: "GET",
    path: "/api/vcenter/host",
    query: "",
  },
  {
    name: "All datastores",
    method: "GET",
    path: "/api/vcenter/datastore",
    query: "",
  },
  {
    name: "All clusters",
    method: "GET",
    path: "/api/vcenter/cluster",
    query: "",
  },
  {
    name: "Powered-on VMs",
    method: "GET",
    path: "/api/vcenter/vm",
    query: "power_states=POWERED_ON",
  },
  {
    name: "VM detail (edit the id)",
    method: "GET",
    path: "/api/vcenter/vm/vm-1",
    query: "",
  },
];

var _VC_QUERIES_VERSION = 1;

var _vcQueryStore = _makeSavedQueryStore("polaris-vcenter-queries", _VC_QUERIES_VERSION, _VC_PRESET_QUERIES);

function openVcenterApiQueryModal(id) {
  var body =
    '<div style="margin-bottom:0.75rem">' +
      '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.4rem">Saved Queries</p>' +
      '<div style="display:flex;gap:6px;align-items:center">' +
        '<select id="vc-saved-select" style="flex:1"></select>' +
        '<button class="btn btn-sm btn-secondary" id="vc-load-btn">Load</button>' +
        '<button class="btn btn-sm btn-danger" id="vc-delete-btn">Delete</button>' +
      '</div>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:0 0 0.75rem">' +
    '<div style="display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:end">' +
      '<div class="form-group" style="margin:0">' +
        '<label>Method</label>' +
        '<select id="vc-method" style="width:auto">' +
          '<option value="GET">GET</option>' +
          '<option value="POST">POST</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group" style="margin:0">' +
        '<label>Path</label>' +
        '<input type="text" id="vc-path" value="/api/vcenter/vm" placeholder="/api/vcenter/vm" style="font-family:monospace;font-size:0.85rem">' +
      '</div>' +
    '</div>' +
    '<div class="form-group" style="margin-top:0.75rem">' +
      '<label>Query Parameters <span style="font-size:0.8rem;color:var(--color-text-tertiary)">(one per line — <code>key=value</code>)</span></label>' +
      '<textarea id="vc-query" rows="4" style="font-family:monospace;font-size:0.82rem" placeholder="power_states=POWERED_ON&#10;hosts=host-10"></textarea>' +
      '<p class="hint">vSphere Automation REST surface only (paths must start with <code>/api/</code>). List filters like <code>hosts=…</code>, <code>clusters=…</code>, <code>power_states=…</code> go here.</p>' +
    '</div>' +
    '<div style="display:flex;justify-content:flex-end;margin-bottom:0.75rem"><button class="btn btn-primary" id="vc-send">Send</button></div>' +
    '<div style="display:flex;gap:6px;align-items:center;margin-bottom:0.25rem">' +
      '<input type="text" id="vc-save-name" placeholder="Name this query to save it…" style="flex:1;font-size:0.85rem">' +
      '<button class="btn btn-sm btn-secondary" id="vc-save-btn">Save</button>' +
    '</div>' +
    '<div id="vc-response-wrap" style="display:none;margin-top:1rem">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem">' +
        '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin:0">Response</p>' +
        '<button class="btn btn-sm btn-secondary" id="vc-copy-btn" style="padding:2px 10px;font-size:0.75rem">Copy</button>' +
      '</div>' +
      '<pre id="vc-response" style="background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:0.75rem;font-size:0.78rem;overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-all;margin:0"></pre>' +
    '</div>';

  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Close</button>';

  openModal("vCenter API Query", body, footer, { wide: true });

  _wireSavedQueryConsole(_vcQueryStore, "vc",
    function () {
      return {
        method: document.getElementById("vc-method").value,
        path: document.getElementById("vc-path").value.trim(),
        query: document.getElementById("vc-query").value,
      };
    },
    function (q) {
      document.getElementById("vc-method").value = q.method || "GET";
      document.getElementById("vc-path").value = q.path || "";
      document.getElementById("vc-query").value = q.query || "";
    });

  document.getElementById("vc-send").addEventListener("click", async function () {
    var btn = this;
    var method = document.getElementById("vc-method").value;
    var path = document.getElementById("vc-path").value.trim();
    if (!path) { showToast("Enter a path (e.g. /api/vcenter/vm)", "error"); return; }
    var queryRaw = document.getElementById("vc-query").value;
    var query = {};
    queryRaw.split("\n").forEach(function (line) {
      var trimmed = line.trim();
      if (!trimmed) return;
      var eq = trimmed.indexOf("=");
      if (eq < 0) { query[trimmed] = ""; return; }
      var key = trimmed.slice(0, eq).trim();
      var value = trimmed.slice(eq + 1).trim();
      if (key) query[key] = value;
    });
    btn.disabled = true;
    btn.textContent = "Sending…";
    var responseWrap = document.getElementById("vc-response-wrap");
    var responsePre = document.getElementById("vc-response");
    try {
      var result = await api.integrations.query(id, { method: method, path: path, query: query });
      responseWrap.style.display = "";
      responsePre.textContent = JSON.stringify(result, null, 2);
    } catch (err) {
      responseWrap.style.display = "";
      responsePre.textContent = "Error: " + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "Send";
    }
  });

  document.getElementById("vc-copy-btn").addEventListener("click", function () {
    var text = document.getElementById("vc-response").textContent;
    var btn = this;
    copyTextToClipboard(text).then(function (ok) {
      if (!ok) { showToast("Copy failed", "error"); return; }
      btn.textContent = "Copied!";
      setTimeout(function () { btn.textContent = "Copy"; }, 1500);
    });
  });
}

// ─── Unraid / TrueNAS / Proxmox API Query modal ────────────────────────────
// Read-only by construction on the server: Unraid takes GraphQL QUERIES only
// (mutations / subscriptions refused), TrueNAS takes read methods only
// (`.query`, `.get_instance`, `.config`, … — truenasService.isProxyReadMethod),
// Proxmox takes GET paths on proxmoxService.isProxyReadPath's allow-list.
// Same saved-query console as the vCenter modal, one store per platform.

var _UNRAID_PRESET_QUERIES = [
  { name: "Containers", query: "query {\n  docker { containers { id names image state status isUpdateAvailable autoStart } }\n}", variables: "" },
  { name: "VMs", query: "query {\n  vms { domains { id name state } }\n}", variables: "" },
  { name: "Array + disks", query: "query {\n  array { state capacity { kilobytes { total used free } } disks { name device temp status fsSize fsUsed } caches { name temp fsSize fsUsed } }\n}", variables: "" },
  { name: "Host usage", query: "query {\n  metrics { cpu { percentTotal } memory { total used available } }\n  info { os { hostname release uptime } versions { core { unraid } } }\n}", variables: "" },
];
var _TRUENAS_PRESET_QUERIES = [
  { name: "Apps", method: "app.query", params: "[]" },
  { name: "VMs", method: "vm.query", params: "[]" },
  { name: "Pools", method: "pool.query", params: "[]" },
  { name: "System info", method: "system.info", params: "[]" },
  { name: "Disk temperatures", method: "disk.temperatures", params: "[[]]" },
  { name: "Update summary for an App (edit the name)", method: "app.upgrade_summary", params: "[\"plex\"]" },
];
// Proxmox: a GET path, limited server-side to proxmoxService.isProxyReadPath.
var _PROXMOX_PRESET_QUERIES = [
  { name: "Cluster resources (every node + guest)", path: "/cluster/resources" },
  { name: "Cluster status (nodes, quorum)", path: "/cluster/status" },
  { name: "Ceph health", path: "/cluster/ceph/status" },
  { name: "Node status (edit the node)", path: "/nodes/pve1/status" },
  { name: "Node storage (edit the node)", path: "/nodes/pve1/storage" },
  { name: "Node ZFS pools (edit the node)", path: "/nodes/pve1/disks/zfs" },
  { name: "VM config (edit node + VMID)", path: "/nodes/pve1/qemu/100/config" },
  { name: "VM guest-agent addresses (edit node + VMID)", path: "/nodes/pve1/qemu/100/agent/network-get-interfaces" },
  { name: "Container addresses (edit node + VMID)", path: "/nodes/pve1/lxc/100/interfaces" },
];
var _WL_QUERIES_VERSION = 1;
var _unraidQueryStore = _makeSavedQueryStore("polaris-unraid-queries", _WL_QUERIES_VERSION, _UNRAID_PRESET_QUERIES);
var _truenasQueryStore = _makeSavedQueryStore("polaris-truenas-queries", _WL_QUERIES_VERSION, _TRUENAS_PRESET_QUERIES);
var _proxmoxQueryStore = _makeSavedQueryStore("polaris-proxmox-queries", _WL_QUERIES_VERSION, _PROXMOX_PRESET_QUERIES);

function openWorkloadApiQueryModal(id, type) {
  var isTn = type === "truenas";
  var isPve = type === "proxmox";
  var inputs = isPve
    ? '<div class="form-group" style="margin:0">' +
        '<label>Path <span style="font-size:0.8rem;color:var(--color-text-tertiary)">(under /api2/json)</span></label>' +
        '<input type="text" id="wl-path" value="/cluster/resources" placeholder="/cluster/resources" style="font-family:monospace;font-size:0.85rem">' +
        '<p class="hint">GET only, and only the reads discovery itself makes — cluster status and resources, Ceph health, a node&rsquo;s status, storage, ZFS and disks, a guest&rsquo;s config and addresses. Nothing that changes the cluster, and nothing under <code>/access</code>.</p>' +
      '</div>'
    : isTn
    ? '<div class="form-group" style="margin:0">' +
        '<label>Method</label>' +
        '<input type="text" id="wl-method" value="app.query" placeholder="app.query" style="font-family:monospace;font-size:0.85rem">' +
      '</div>' +
      '<div class="form-group" style="margin-top:0.75rem">' +
        '<label>Params <span style="font-size:0.8rem;color:var(--color-text-tertiary)">(a JSON array)</span></label>' +
        '<textarea id="wl-params" rows="4" style="font-family:monospace;font-size:0.82rem">[]</textarea>' +
        '<p class="hint">Read methods only — <code>*.query</code>, <code>*.get_instance</code>, <code>*.config</code>, <code>system.info</code>, <code>disk.temperatures</code> and the like. Anything that changes the host is refused.</p>' +
      '</div>'
    : '<div class="form-group" style="margin:0">' +
        '<label>GraphQL query</label>' +
        '<textarea id="wl-query" rows="8" style="font-family:monospace;font-size:0.82rem">query {\n  docker { containers { id names state } }\n}</textarea>' +
      '</div>' +
      '<div class="form-group" style="margin-top:0.75rem">' +
        '<label>Variables <span style="font-size:0.8rem;color:var(--color-text-tertiary)">(optional JSON object)</span></label>' +
        '<textarea id="wl-vars" rows="2" style="font-family:monospace;font-size:0.82rem" placeholder="{}"></textarea>' +
        '<p class="hint">Queries only — mutations and subscriptions are refused. The schema is browsable in Unraid under Settings → Management Access → API.</p>' +
      '</div>';
  var body =
    '<div style="margin-bottom:0.75rem">' +
      '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.4rem">Saved Queries</p>' +
      '<div style="display:flex;gap:6px;align-items:center">' +
        '<select id="wl-saved-select" style="flex:1"></select>' +
        '<button class="btn btn-sm btn-secondary" id="wl-load-btn">Load</button>' +
        '<button class="btn btn-sm btn-danger" id="wl-delete-btn">Delete</button>' +
      '</div>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:0 0 0.75rem">' +
    inputs +
    '<div style="display:flex;justify-content:flex-end;margin-bottom:0.75rem"><button class="btn btn-primary" id="wl-send">Send</button></div>' +
    '<div style="display:flex;gap:6px;align-items:center;margin-bottom:0.25rem">' +
      '<input type="text" id="wl-save-name" placeholder="Name this query to save it…" style="flex:1;font-size:0.85rem">' +
      '<button class="btn btn-sm btn-secondary" id="wl-save-btn">Save</button>' +
    '</div>' +
    '<div id="wl-response-wrap" style="display:none;margin-top:1rem">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem">' +
        '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin:0">Response</p>' +
        '<button class="btn btn-sm btn-secondary" id="wl-copy-btn" style="padding:2px 10px;font-size:0.75rem">Copy</button>' +
      '</div>' +
      '<pre id="wl-response" style="background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:0.75rem;font-size:0.78rem;overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-all;margin:0"></pre>' +
    '</div>';
  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Close</button>';
  openModal((isPve ? "Proxmox VE" : isTn ? "TrueNAS SCALE" : "Unraid") + " API Query", body, footer, { wide: true });

  _wireSavedQueryConsole(isPve ? _proxmoxQueryStore : isTn ? _truenasQueryStore : _unraidQueryStore, "wl",
    function () {
      return isPve
        ? { path: document.getElementById("wl-path").value.trim() }
        : isTn
        ? { method: document.getElementById("wl-method").value.trim(), params: document.getElementById("wl-params").value }
        : { query: document.getElementById("wl-query").value, variables: document.getElementById("wl-vars").value };
    },
    function (q) {
      if (isPve) {
        document.getElementById("wl-path").value = q.path || "";
      } else if (isTn) {
        document.getElementById("wl-method").value = q.method || "";
        document.getElementById("wl-params").value = q.params || "[]";
      } else {
        document.getElementById("wl-query").value = q.query || "";
        document.getElementById("wl-vars").value = q.variables || "";
      }
    });

  document.getElementById("wl-send").addEventListener("click", async function () {
    var btn = this;
    var payload;
    try {
      if (isPve) {
        var path = document.getElementById("wl-path").value.trim();
        if (!path) { showToast("Enter a path (e.g. /cluster/resources)", "error"); return; }
        payload = { path: path };
      } else if (isTn) {
        var method = document.getElementById("wl-method").value.trim();
        if (!method) { showToast("Enter a method (e.g. app.query)", "error"); return; }
        var params = JSON.parse(document.getElementById("wl-params").value.trim() || "[]");
        if (!Array.isArray(params)) throw new Error("Params must be a JSON array");
        payload = { method: method, params: params };
      } else {
        var q = document.getElementById("wl-query").value.trim();
        if (!q) { showToast("Enter a GraphQL query", "error"); return; }
        var rawVars = document.getElementById("wl-vars").value.trim();
        payload = { query: q };
        if (rawVars) payload.variables = JSON.parse(rawVars);
      }
    } catch (e) {
      showToast("Invalid JSON: " + e.message, "error");
      return;
    }
    btn.disabled = true;
    btn.textContent = "Sending…";
    var responseWrap = document.getElementById("wl-response-wrap");
    var responsePre = document.getElementById("wl-response");
    try {
      var result = await api.integrations.query(id, payload);
      responseWrap.style.display = "";
      responsePre.textContent = JSON.stringify(result, null, 2);
    } catch (err) {
      responseWrap.style.display = "";
      responsePre.textContent = "Error: " + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "Send";
    }
  });

  document.getElementById("wl-copy-btn").addEventListener("click", function () {
    var text = document.getElementById("wl-response").textContent;
    var btn = this;
    copyTextToClipboard(text).then(function (ok) {
      if (!ok) { showToast("Copy failed", "error"); return; }
      btn.textContent = "Copied!";
      setTimeout(function () { btn.textContent = "Copy"; }, 1500);
    });
  });
}
