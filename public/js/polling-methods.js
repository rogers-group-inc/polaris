/**
 * public/js/polling-methods.js — the polling-method vocabulary, shared.
 *
 * Which polling methods a stream may use on an asset of a given source, what
 * "Inherit" falls back to, how each is labelled, and the per-stream MIB
 * picker. Mirrors src/utils/pollingCompatibility.ts / pollingCapability.ts and
 * defaultPollingForSource() in src/services/monitoringService.ts.
 *
 * Lifted out of integrations.js (2026-10-12) so the phone's asset Monitoring
 * sheet (public/js/mobile/asset-edit.js) offers exactly the methods the
 * desktop does — mobile.html cannot load a 10k-line page script for one
 * table, and a fourth copy of the matrix would drift. Classic script, plain
 * globals: every desktop page that loads integrations.js loads this first
 * (and so does the asset panel bundle in app.js).
 *
 * Needs escapeHtml (api.js, loaded everywhere) and, for the
 * uploaded-MIB group only, api.serverSettings.listMibs.
 */

// ─── Polling-method dropdown helpers ───────────────────────────────────────
// Mirrors src/utils/pollingCompatibility.ts. Frontend can't import TS, so we
// repeat the matrix here. Defined in integrations.js because that file loads
// before assets.js on both integrations.html and assets.html, so the helpers
// are available globally to every page that needs them. Keep in lockstep
// with the matrix comment in pollingCompatibility.ts.

var _POLLING_LABELS = {
  rest_api: "REST API",
  snmp:     "SNMP",
  winrm:    "WinRM",
  ssh:      "SSH",
  icmp:     "ICMP",
  disabled: "Disabled",
  agent:    "Polaris Agent",
  vcenter:  "vCenter",
  fortimanager: "FortiManager",
  unraid:   "Unraid",
  truenas:  "TrueNAS",
  proxmox:  "Proxmox",
  genericapi: "Generic API",
};

// "agent" is intentionally NOT in any of these arrays — the Polaris Agent
// is installed via a dedicated button on the Monitoring tab, not picked
// from the polling dropdown. When an agent is installed Polaris stamps
// the four *Polling fields to "agent" server-side at enrollment time;
// the polling-methods section is hidden in the UI for those assets. The
// _POLLING_LABELS map still includes "agent" so the value renders
// correctly on any surface that displays raw values (audit logs, the
// asset-list status pill, etc.).
// "vcenter" reads the asset's state from the vCenter SERVER rather than from
// the device. It appears on the directory sources too — a VM those integrations
// discovered first can be vCenter-merged; the backend enforces the actual
// requirement (a vCenter source on the asset) at save time. The stream gate
// below limits the method to the four streams that fetch can answer.
// The "http" method was RETIRED (2026-08): the HTTP GET health check it ran is
// now a manufacturer custom widget, keyed by manufacturer + optional model
// rather than by credential. Mirrors src/utils/pollingCompatibility.ts.
var _POLLING_COMPAT = {
  // "fortimanager" (ask FMG's own device roster; response time only) is on this
  // source and nowhere else — nothing else has a FortiManager to ask.
  fortimanager:    ["rest_api", "snmp", "ssh", "icmp", "disabled", "fortimanager"],
  fortigate:       ["rest_api", "snmp", "ssh", "icmp", "disabled"],
  activedirectory: ["icmp", "winrm", "ssh", "disabled", "vcenter", "unraid", "truenas", "proxmox", "genericapi"],
  entraid:         ["icmp", "winrm", "ssh", "disabled", "vcenter", "unraid", "truenas", "proxmox", "genericapi"],
  windowsserver:   ["icmp", "winrm", "ssh", "disabled", "vcenter", "unraid", "truenas", "proxmox", "genericapi"],
  azurearc:        ["icmp", "winrm", "ssh", "disabled", "vcenter", "unraid", "truenas", "proxmox", "genericapi"],
  vcenter:         ["icmp", "snmp", "winrm", "ssh", "disabled", "vcenter"],
  // vCenter's shape with the integration's own method (pollingCompatibility.ts).
  unraid:          ["icmp", "snmp", "winrm", "ssh", "disabled", "unraid"],
  truenas:         ["icmp", "snmp", "winrm", "ssh", "disabled", "truenas"],
  proxmox:         ["icmp", "snmp", "winrm", "ssh", "disabled", "proxmox"],
  // A Generic API record can be any device (pollingCompatibility.ts); its own
  // "genericapi" method reads the integration's monitor queries (rule 100(i)),
  // and rides the directory sources + manual for the merged-asset reason.
  genericapi:      ["icmp", "snmp", "winrm", "ssh", "disabled", "genericapi"],
  manual:          ["rest_api", "snmp", "winrm", "ssh", "icmp", "disabled", "vcenter", "unraid", "truenas", "proxmox", "genericapi"],
};

// Per-stream method restriction — mirrors STREAM_METHODS in
// src/utils/pollingCompatibility.ts. Streams not listed here impose no
// restriction (the source matrix above + the icmp-responseTime-only rule
// apply). The cross-transport streams (processes / eventLog) accept only a
// subset; an offered method must be in BOTH the source list AND this set.
var _STREAM_METHODS = {
  processes: ["agent", "snmp", "ssh", "winrm", "disabled"],
  eventLog:  ["agent", "ssh", "winrm", "rest_api", "disabled"],
};

// Streams the "vcenter" method can serve — mirrors VCENTER_STREAMS in
// src/utils/pollingCompatibility.ts. Response time is the VM's power state /
// the host's connection state; interfaces are guest vNICs / host pNICs +
// VMkernel ports; storage is guest filesystems / host-mounted datastores.
var _VCENTER_STREAMS = ["responseTime", "cpuMemory", "interfaces", "storage"];

// Streams the "fortimanager" method can serve — mirrors FORTIMANAGER_STREAMS in
// src/utils/pollingCompatibility.ts. Response time only: FMG's device database
// carries reachability, identity and firmware, and no metrics of any kind.
var _FORTIMANAGER_STREAMS = ["responseTime"];

// Streams the "unraid" / "truenas" methods can serve — mirrors WORKLOAD_STREAMS
// in src/utils/pollingCompatibility.ts: vCenter's four plus temperature (host
// disk temperatures). "telemetry" is the dropdowns' legacy name for cpuMemory.
var _WORKLOAD_STREAMS = ["responseTime", "cpuMemory", "telemetry", "interfaces", "storage", "temperature"];

// "proxmox" serves the same minus temperature — mirrors PROXMOX_STREAMS: the
// Proxmox VE API publishes no sensor readings.
var _PROXMOX_STREAMS = ["responseTime", "cpuMemory", "telemetry", "interfaces", "storage"];

// Streams the "genericapi" method can serve — mirrors GENERICAPI_STREAMS in
// src/utils/pollingCompatibility.ts: every stream a monitor query can map.
var _GENERICAPI_STREAMS = ["responseTime", "cpuMemory", "telemetry", "interfaces", "storage", "temperature", "lldp"];

function _isWorkloadType(t) { return t === "unraid" || t === "truenas" || t === "proxmox"; }

// Source-default polling for one stream. Mirrors defaultPollingForSource() in
// src/services/monitoringService.ts. Used to label the "Inherit" option.
function _polarisSourceDefaultPolling(source, stream, opts) {
  // Cross-transport streams are opt-in everywhere — default "disabled".
  if (stream === "processes" || stream === "eventLog") return "disabled";
  // Mirrors the fortiosRestUnavailable branch in defaultPollingForSource: with
  // no way to make a FortiOS call, the REST defaults resolve to "disabled"
  // instead. Without this the Inherit option would advertise "REST API" for a
  // stream the resolver has already decided not to collect.
  if (opts && opts.fortiosRestUnavailable && source === "fortimanager") {
    if (_fortiosRestUsable(stream === "telemetry" ? "cpuMemory" : stream, opts.klass)) return "rest_api";
    if (stream === "responseTime") return "icmp";
    return "disabled";
  }
  if (source === "fortimanager" || source === "fortigate") {
    if (stream === "lldp") return "disabled";
    // FortiOS appliances don't expose meaningful mountable storage; default
    // off so operators opt in by picking SNMP at any tier when they need it.
    if (stream === "storage") return "disabled";
    // Response Time is the cheapest probe — ICMP is the universal default
    // for routable devices. CPU/mem/interfaces/temperature still default to
    // REST API because that's where the data actually is.
    if (stream === "responseTime") return "icmp";
    return "rest_api";
  }
  if (source === "vcenter") {
    // Everything vCenter can answer for, it answers for out of the box —
    // response time (power / connection state), CPU/RAM, interfaces and
    // storage. Temperature and LLDP have no vCenter source.
    if (stream === "responseTime" || stream === "cpuMemory"
        || stream === "interfaces" || stream === "storage") return "vcenter";
    return null;
  }
  if (_isWorkloadType(source)) {
    // Mirrors defaultPollingForSource: response time is ICMP for any asset with
    // an address (the server falls back to the platform's state check for one
    // without — a bridged container, a VM with no published IP — which this
    // per-source label cannot see); everything else but LLDP is the host's API.
    if (stream === "responseTime") return "icmp";
    // A container / App reports CPU/memory and its own network only — no
    // disks or sensors of its own.
    if (opts && (opts.klass === "container" || opts.klass === "containers")) {
      return (stream === "cpuMemory" || stream === "telemetry" || stream === "interfaces") ? source : null;
    }
    if ((source === "proxmox" ? _PROXMOX_STREAMS : _WORKLOAD_STREAMS).indexOf(stream) !== -1) return source;
    return null;
  }
  if (stream === "responseTime") return "icmp";
  return null; // telemetry/interfaces/lldp/storage not delivered on AD/Entra/Win/Manual by default
}

// ─── FortiOS REST reachability (mirrors monitoringService) ──────────────────
//
// A FortiManager on the PROXY transport with NO FortiGate API token cannot make
// a FortiOS REST call at all: every collector goes through buildFortinetConfig(),
// which has no useProxy branch — it dials the asset's own IP and requires that
// token. Picking REST API for a stream under those conditions produces a 409 on
// every tick, forever, so the dropdowns are locked rather than offering it.
//
// Note the condition is NOT simply "proxy mode". Proxy + a token is a valid
// setup (discovery and writes ride FMG, monitoring reaches the gates directly),
// and its REST streams work — so the token is what unlocks the controls.
//
// Mirrors fortiosRestUsable() in src/services/monitoringService.ts. The one
// stream that still works with no token is a managed switch/AP's response time:
// that read goes to the PARENT gate's controller table via
// fetchViaFortinetTransport, the one monitoring path that honours useProxy.
function _fortiosRestUsable(stream, klass) {
  var isManagedChild = klass === "fortiswitch" || klass === "fortiap";
  return stream === "responseTime" && isManagedChild;
}


// ─── Collector capability (mirrors src/utils/pollingCapability.ts) ──────────
//
// Compatibility answers "is this method meaningful for this source"; capability
// answers "has anyone written the collector". Only the second keeps a stream
// from being configured into silence: a method with no collector validates,
// persists, resolves, and then reports a healthy tick forever while gathering
// nothing, because runTelemetryFor counts {supported:false} as success.
//
// Kept deliberately coarse — this decides what the dropdown OFFERS. The server
// remains the authority and warns on anything that slips through (an API
// caller, or a value stored before this existed).
function _collectorExists(source, stream, klass) {
  return function (method) {
    if (method === "disabled" || method === "vcenter" || method === "fortimanager") return true;
    if (_isWorkloadType(method)) return true;
    if (method === "genericapi") return true;
    if (method === "icmp")  return stream === "responseTime";
    // The agent walks no LLDP neighbours.
    if (method === "agent") return stream !== "lldp";
    if (method === "ssh" || method === "winrm") {
      // agentlessProcessService (processes) + agentlessHostService (cpuMemory /
      // interfaces / storage / eventLog). Temperature has no dependable Windows
      // source and LLDP has none at all over a shell, so both stay
      // agent/SNMP-only.
      return stream === "responseTime" || stream === "processes" ||
             stream === "cpuMemory" || stream === "interfaces" ||
             stream === "storage" || stream === "eventLog";
    }
    if (method === "snmp") {
      // hrSWRunTable is declared-but-unimplemented; there is no event-log MIB.
      return stream !== "processes" && stream !== "eventLog";
    }
    if (method === "rest_api") {
      var isFortinet = source === "fortimanager" || source === "fortigate";
      if (!isFortinet) return stream === "responseTime";
      if (stream === "responseTime") return true;
      // A managed FortiSwitch/FortiAP isn't directly REST-able; only the AP's
      // cpu/mem + temperature ride the parent gate's managed_ap row.
      if (klass === "fortiswitch") return false;
      if (klass === "fortiap")     return stream === "cpuMemory" || stream === "temperature";
      // FortiOS exposes no mountable storage over REST (always empty), and the
      // device-log collector is not implemented.
      return stream !== "storage" && stream !== "eventLog";
    }
    return true;
  };
}

// Methods offered for a stream = source-compatible methods intersected with the
// stream's restriction (if any). Mirrors the resolver's combined gate.
function _streamAllowedMethods(source, stream, klass) {
  var allowed = _POLLING_COMPAT[source] || _POLLING_COMPAT.manual;
  var restrict = _STREAM_METHODS[stream];
  if (restrict) {
    allowed = allowed.filter(function (m) { return restrict.indexOf(m) !== -1; });
  }
  // "vcenter" covers only the streams the vCenter server publishes — mirrors
  // VCENTER_STREAMS / isMethodValidForStream (pollingCompatibility.ts).
  if (_VCENTER_STREAMS.indexOf(stream) === -1) {
    allowed = allowed.filter(function (m) { return m !== "vcenter"; });
  }
  // Same method-first gate for "fortimanager" — mirrors isMethodValidForStream.
  // Note the dropdown labels cpuMemory as "telemetry" for legacy-default
  // reasons, which is fine here: neither name is in the allowed stream list.
  if (_FORTIMANAGER_STREAMS.indexOf(stream) === -1) {
    allowed = allowed.filter(function (m) { return m !== "fortimanager"; });
  }
  if (_WORKLOAD_STREAMS.indexOf(stream) === -1) {
    allowed = allowed.filter(function (m) { return m !== "unraid" && m !== "truenas"; });
  }
  if (_PROXMOX_STREAMS.indexOf(stream) === -1) {
    allowed = allowed.filter(function (m) { return m !== "proxmox"; });
  }
  if (_GENERICAPI_STREAMS.indexOf(stream) === -1) {
    allowed = allowed.filter(function (m) { return m !== "genericapi"; });
  }
  // Finally: drop anything with no collector behind it. Offering a method that
  // silently gathers nothing is how a stream gets configured into permanent
  // silence with every indicator green. The dropdown labels cpuMemory as
  // "telemetry" for legacy-default reasons; normalize before asking.
  allowed = allowed.filter(_collectorExists(source, stream === "telemetry" ? "cpuMemory" : stream, klass));
  return allowed;
}

// Source-label table for the "Inherit" option. ICMP is universal for response-
// time but the rest of the streams need REST API / SNMP / WinRM / etc. — the
// label tells operators which source kind they're inheriting from. FMG depends
// on the Direct Polling toggle's current state because the same `fortimanager`
// source kind talks via two different transports; the relabel helper updates
// every Inherit option in place when the toggle flips.
function _polarisSourceLabel(source, opts) {
  opts = opts || {};
  if (source === "fortigate") return "FortiGate Direct";
  if (source === "fortimanager") {
    return opts.fmgDirectMode ? "FortiGate Direct" : "FortiManager Proxy";
  }
  if (source === "activedirectory") return "Active Directory";
  if (source === "entraid")         return "Entra ID";
  if (source === "windowsserver")   return "Windows Server";
  if (source === "vcenter")         return "vCenter";
  if (source === "azurearc")        return "Azure Arc";
  if (source === "unraid")          return "Unraid";
  if (source === "truenas")         return "TrueNAS SCALE";
  if (source === "proxmox")         return "Proxmox VE";
  if (source === "genericapi")      return "Generic API";
  return "Manual";
}

// Builds a polling-method <select>. When `currentValue` is null/empty/missing
// the "Inherit" option is selected and labeled with the resolver's expected
// fallback ("Inherit (Source FortiGate Direct: REST API)", "Inherit (Source
// Manual: ICMP)", or "Inherit (Source <Label>: not delivered)" when the
// stream has no default for this source kind).
//
// ICMP is filtered out of every stream except responseTime — telemetry /
// interfaces / LLDP / storage all need a real protocol; an ICMP pick on those
// would silently fall through at resolution time. The backend
// validateStreamPollingMethod() applies the same filter on writes.
function _polarisPollingDropdownHTML(id, source, stream, currentValue, opts) {
  opts = opts || {};
  var allowed = _streamAllowedMethods(source, stream, opts.klass);
  if (stream !== "responseTime") {
    allowed = allowed.filter(function (m) { return m !== "icmp"; });
  }
  // showInherit defaults to true. Set false at the bottom of the resolver
  // hierarchy (Manual Monitoring) where there's nothing to inherit from —
  // the "Inherit" option there would be misleading.
  var showInherit = opts.showInherit !== false;
  var defaultMethod = _polarisSourceDefaultPolling(source, stream);
  var sourceLabel = _polarisSourceLabel(source, opts);
  var inheritLabel = defaultMethod
    ? "Inherit (Source " + sourceLabel + ": " + _POLLING_LABELS[defaultMethod] + ")"
    : "Inherit (Source " + sourceLabel + ": not delivered)";
  var v = currentValue || "";
  var opts2 = "";
  if (showInherit) {
    opts2 += '<option value=""' + (v === "" ? " selected" : "") + '>' + escapeHtml(inheritLabel) + '</option>';
  }
  for (var i = 0; i < allowed.length; i++) {
    var m = allowed[i];
    opts2 += '<option value="' + m + '"' + (v === m ? " selected" : "") + '>' + escapeHtml(_POLLING_LABELS[m]) + '</option>';
  }
  // data-poll-class carries the asset class this dropdown governs. Needed by
  // _applyFortiosRestLocks, which has to know whether a rest_api pick is a
  // managed switch/AP controller-table read (works through the FMG proxy on
  // FMG's own credential) or a direct FortiOS call (needs the direct token).
  return '<select id="' + id + '" data-poll-source="' + escapeHtml(source) + '"' +
    ' data-poll-stream="' + escapeHtml(stream) + '"' +
    (opts.klass ? ' data-poll-class="' + escapeHtml(opts.klass) + '"' : "") +
    '>' + opts2 + '</select>';
}

function _polarisReadPollingDropdown(id) {
  var el = document.getElementById(id);
  if (!el) return undefined;
  return el.value || null;
}

// Standard MIBs selectable without uploading anything. Kept in lockstep with
// the _SNMP_STANDARD_MIBS array in assets.js (SNMP Walk tab). Named apart from
// it because both files share the page's global scope, and assets.js can now
// be loaded onto the Integrations page on demand (PolarisPanels, app.js) —
// under the same name the later file silently replaced this list, vendor
// entries and all. Same reason for openIntegrationCreateModal /
// openIntegrationEditModal / confirmDeleteIntegration below.
var _INTEGRATION_SNMP_MIBS = [
  { id: "std:system",         label: "System (RFC 1213)",              oid: "1.3.6.1.2.1.1"         },
  { id: "std:interfaces",     label: "Interfaces — ifTable (RFC 2863)", oid: "1.3.6.1.2.1.2"         },
  { id: "std:if-ext",         label: "Interfaces — ifXTable, 64-bit counters (RFC 2863)", oid: "1.3.6.1.2.1.31"        },
  { id: "std:host-resources", label: "HOST-RESOURCES-MIB (RFC 2790)",  oid: "1.3.6.1.2.1.25"        },
  { id: "std:entity",         label: "ENTITY-MIB (RFC 4133)",          oid: "1.3.6.1.2.1.47"        },
  { id: "std:entity-sensor",  label: "ENTITY-SENSOR-MIB (RFC 3433)",   oid: "1.3.6.1.2.1.99"        },
  { id: "std:lldp",           label: "LLDP-MIB (IEEE 802.1AB)",        oid: "1.0.8802.1.1.2"        },
  { id: "std:fortinet-fg",    label: "Fortinet FORTIGATE-MIB",         oid: "1.3.6.1.4.1.12356.101" },
];

// Cache of uploaded MIBs for per-stream MIB pickers. null = not yet loaded.
var _uploadedMibsCache = null;

// Build <option> HTML for a MIB <select>. selectedId: null/"" = Automatic,
// "std:..." = standard built-in, UUID = uploaded MIB from the MIB database.
// Derive per-stream auto MIB names from the source kind (integration / class override tiers).
// CPU/memory + temperature both vary by vendor; the other three streams always use standard MIBs.
var _SOURCE_TELEMETRY_MIB = {
  fortimanager: "FORTINET-FORTIGATE-MIB",
  fortigate:    "FORTINET-FORTIGATE-MIB",
};
// Temperature: ENTITY-SENSOR-MIB is the standard fallback; Fortinet exposes its
// own sensor table under FORTINET-FORTIGATE-MIB (fgHwSensorTable) which the
// collector tries before falling back to ENTITY-SENSOR-MIB.
var _SOURCE_TEMPERATURE_MIB = {
  fortimanager: "FORTINET-FORTIGATE-MIB",
  fortigate:    "FORTINET-FORTIGATE-MIB",
};
function _autoMibNamesForSource(sourceKind) {
  return {
    responseTime: "SNMPv2-MIB",
    telemetry:    _SOURCE_TELEMETRY_MIB[sourceKind]   || "HOST-RESOURCES-MIB",
    temperature:  _SOURCE_TEMPERATURE_MIB[sourceKind] || "ENTITY-SENSOR-MIB",
    interfaces:   "IF-MIB",
    lldp:         "LLDP-MIB",
  };
}

// autoName is optional — when provided, replaces "let Polaris choose" with the resolved name.
function _mibOptionsHTML(selectedId, autoName) {
  var sel = selectedId || "";
  var autoLabel = "Automatic" + (autoName ? " (" + autoName + ")" : " (let Polaris choose)");
  var html = '<option value=""' + (sel === "" ? " selected" : "") + ">" + escapeHtml(autoLabel) + "</option>";
  html += '<optgroup label="Standard MIBs">';
  _INTEGRATION_SNMP_MIBS.forEach(function (m) {
    html += '<option value="' + escapeHtml(m.id) + '"' + (sel === m.id ? " selected" : "") + '>' + escapeHtml(m.label) + '</option>';
  });
  html += '</optgroup>';
  if (_uploadedMibsCache && _uploadedMibsCache.length > 0) {
    html += '<optgroup label="Uploaded MIBs">';
    _uploadedMibsCache.forEach(function (m) {
      var lbl = m.moduleName + (m.manufacturer ? " (" + m.manufacturer + (m.model ? "/" + m.model : "") + ")" : " (generic)");
      html += '<option value="' + escapeHtml(m.id) + '"' + (sel === m.id ? " selected" : "") + '>' + escapeHtml(lbl) + '</option>';
    });
    html += '</optgroup>';
  }
  return html;
}

// Populate every MIB <select> on the page (identified by data-mib-picker="1")
// with the current uploaded-MIB list. Lazy-loads from the API on first call.
function _populateUploadedMibsInDropdowns() {
  function repopulate() {
    var sels = document.querySelectorAll("[data-mib-picker='1']");
    for (var i = 0; i < sels.length; i++) {
      var el = sels[i];
      var current = el.getAttribute("data-current-id") || "";
      var autoName = el.getAttribute("data-auto-mib-name") || "";
      el.innerHTML = _mibOptionsHTML(current, autoName);
    }
  }
  if (_uploadedMibsCache !== null) {
    repopulate();
  } else {
    repopulate(); // render standard MIBs immediately; uploaded group appears once loaded
    api.serverSettings.listMibs({}).then(function (mibs) {
      _uploadedMibsCache = Array.isArray(mibs) ? mibs : [];
      repopulate();
    }).catch(function () {
      _uploadedMibsCache = [];
    });
  }
}

// Per-ASSET auto MIB names for the "Automatic" option label: the per-source
// table above, refined by the asset's manufacturer — CPU/memory and the
// temperature table are vendor MIBs. The asset edit surfaces (desktop modal,
// phone Monitoring sheet) both label their MIB pickers through this.
function _autoMibNamesForAsset(asset) {
  var mfr = ((asset && asset.manufacturer) || "").toLowerCase();
  var tel = "HOST-RESOURCES-MIB";
  if (/fortinet/.test(mfr))               tel = "FORTINET-FORTIGATE-MIB";
  else if (/cisco/.test(mfr))             tel = "CISCO-PROCESS-MIB";
  else if (/juniper/.test(mfr))           tel = "JUNIPER-MIB";
  else if (/mikrotik/.test(mfr))          tel = "MIKROTIK-MIB";
  else if (/hp|aruba|hewlett/.test(mfr))  tel = "HP-ICF-OID-MIB";
  else if (/dell/.test(mfr))              tel = "DELL-MIB";
  return {
    responseTime: "SNMPv2-MIB",
    telemetry:    tel,
    // ENTITY-SENSOR-MIB across the board; Fortinet's fgHwSensorTable lives in
    // FORTINET-FORTIGATE-MIB (the collector tries it before falling back).
    temperature:  /fortinet/.test(mfr) ? "FORTINET-FORTIGATE-MIB" : "ENTITY-SENSOR-MIB",
    interfaces:   "IF-MIB",
    lldp:         "LLDP-MIB",
  };
}

// Map polling method → which credential type it needs (null = no credential).
function _credTypeForPolling(method) {
  if (method === "snmp")     return "snmp";
  if (method === "winrm")    return "winrm";
  if (method === "ssh")      return "ssh";
  if (method === "rest_api") return "restapi";
  return null;
}

// Options for a per-stream credential picker: "Source default" first (value=""),
// then the credentials in `list` matching credType. When credType is null, just
// the default.
//
// A STORED credential is always an option, whatever credType is. The picker
// must show what the asset row holds: a stored id with no matching option made
// the select fall back to "Source default", so the operator read "nothing set"
// while the dispatchers kept sending that credential (a stale per-asset REST
// token behind an "Inherit" stream locked the server out of a FortiGate's API
// for hours). The extra option names the credential and says when its type
// doesn't fit the method, so the mismatch is visible instead of silent.
function _credentialOptionsHTML(list, selectedId, credType) {
  list = list || [];
  var opts = '<option value="">— Source default —</option>';
  var listed = false;
  if (credType) {
    list.forEach(function (c) {
      if (c.type !== credType) return;
      if (selectedId === c.id) listed = true;
      opts += '<option value="' + escapeHtml(c.id) + '"' +
        (selectedId === c.id ? " selected" : "") + '>' +
        escapeHtml(c.name) +
        '</option>';
    });
  }
  if (selectedId && !listed) {
    var stored = null;
    list.forEach(function (c) { if (c.id === selectedId) stored = c; });
    var label = stored
      ? stored.name + " (" + stored.type + (credType ? ", not used by this method" : "") + ")"
      : "Stored credential (not visible to you)";
    opts += '<option value="' + escapeHtml(selectedId) + '" selected>' + escapeHtml(label) + '</option>';
  }
  return opts;
}
